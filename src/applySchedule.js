import { selectors, fillSelector } from './selectors.js';
import { pause, screenshot } from './browser.js';

/**
 * 画面に表示されている各日付（プルダウン）の並び順を読み取り、
 * "20260710" -> 0 のような「日付→行インデックス」を作る。
 * 申請メッセージ欄(remark_list)は日付idを持たないため、この順序で対応づける。
 */
export async function buildDateIndex(page) {
  const ids = await page.locator(selectors.patternSelectAll).evaluateAll((els) =>
    els.map((el) => el.id.replace('requestedSchedulePatternList_', ''))
  );
  const map = new Map();
  ids.forEach((ymd, i) => map.set(ymd, i));
  return map;
}

/**
 * 1日分のスケジュールを「入力」する（まだ送信はしない）。
 * @returns {Promise<{date:string, status:string, detail?:string}>}
 */
export async function setOneDay(page, item, dateIndex) {
  const patternSel = fillSelector(selectors.patternSelect, { ymd: item.ymd });
  const select = page.locator(patternSel);

  // 対象日のプルダウンが画面に無い → 表示期間外 or 申請不可日
  if ((await select.count()) === 0) {
    return {
      date: item.date,
      status: 'skip',
      detail: '申請欄が見つかりません（表示期間外、または申請できない日）',
    };
  }

  // シフトパターンを選択（表示テキスト→ダメなら value で一致を試す）
  const chosen = await selectPatternByText(select, item.pattern);
  if (!chosen) {
    const names = await select.locator('option').allTextContents();
    return {
      date: item.date,
      status: 'error',
      detail:
        `シフト「${item.pattern}」が選択肢に見つかりません。\n` +
        `      選べる候補: ${names.map((n) => n.trim()).filter(Boolean).join(' / ')}`,
    };
  }

  // 勤務日種別（任意）
  if (item.workingDayType) {
    const wdt = page.locator(fillSelector(selectors.workingDayTypeSelect, { ymd: item.ymd }));
    if (await wdt.count()) {
      await wdt.selectOption({ label: item.workingDayType }).catch(() => {});
    }
  }

  // 申請メッセージ（任意）。日付の並び順に対応する remark 欄へ入力
  if (item.note) {
    const idx = dateIndex.get(item.ymd);
    if (idx != null) {
      const remark = page.locator(selectors.remarkInputAll).nth(idx);
      if (await remark.count()) {
        await remark.fill(item.note).catch(() => {});
      }
    }
  }

  await pause(page);
  return { date: item.date, status: 'set', detail: item.pattern };
}

/** option を 表示テキスト / value のどちらでも一致できるように選ぶ */
async function selectPatternByText(select, pattern) {
  // 1) 表示テキスト完全一致
  try {
    await select.selectOption({ label: pattern });
    return true;
  } catch {
    /* fallthrough */
  }
  // 2) value 一致 or トリム後テキスト一致を自前で探す
  const value = await select.evaluate((el, target) => {
    const opts = Array.from(el.options);
    const hit =
      opts.find((o) => o.value === target) ||
      opts.find((o) => o.textContent.trim() === target.trim());
    return hit ? hit.value : null;
  }, pattern);
  if (value == null) return false;
  await select.selectOption(value);
  return true;
}

/**
 * 「申請する」ボタンを押して、入力済みの全日付をまとめて送信する。
 */
export async function submitAll(page) {
  // 確認ダイアログが出たら自動で承認
  page.on('dialog', (d) => d.accept().catch(() => {}));

  const btn = page.locator(selectors.submitButton).first();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await btn.click();

  // 送信後の遷移/反映を待つ
  await page.waitForLoadState('networkidle').catch(() => {});
  await pause(page);
  const shot = await screenshot(page, 'after-submit');
  console.log(`  送信後の画面を保存しました: ${shot}`);
}
