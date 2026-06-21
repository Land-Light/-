import { selectors, fillSelector } from './selectors.js';
import { config } from './config.js';
import { pause, screenshot } from './browser.js';

/**
 * 申請画面まで遷移する（ログイン後に1回呼ぶ想定）。
 * @param {import('playwright').Page} page
 */
export async function gotoScheduleApply(page) {
  const steps = selectors.nav.toScheduleApply;
  if (!steps || steps.length === 0) {
    console.warn('⚠ nav.toScheduleApply が未設定です。申請画面への遷移はスキップします（selectors.js を埋めてください）。');
    return;
  }
  for (const sel of steps) {
    await page.locator(sel).first().click();
    await pause(page);
  }
  console.log('✓ スケジュール申請画面へ遷移');
}

/**
 * 1日分のスケジュールを申請する。
 * @param {import('playwright').Page} page
 * @param {{date:string,start:string,end:string,breakStart:string,breakEnd:string,note:string}} item
 * @param {{dryRun:boolean}} opts
 */
export async function applyOneDay(page, item, opts = {}) {
  const { dryRun = false } = opts;
  const f = selectors.form;
  const vars = { date: item.date, start: item.start, end: item.end };

  // 必須セレクタの確認
  const missing = ['startInput', 'endInput', 'submitButton'].filter((k) => !f[k]);
  if (missing.length) {
    throw new Error(
      `フォーム用セレクタが未設定です: form.${missing.join(', form.')}\n` +
      'src/selectors.js を実画面のHTMLに合わせて埋めてください。'
    );
  }

  // 対象日のセルを開く（設定があれば）
  if (f.openDayFor) {
    await page.locator(fillSelector(f.openDayFor, vars)).first().click();
    await pause(page);
  }

  await fillIfPresent(page, f.startInput, item.start);
  await fillIfPresent(page, f.endInput, item.end);
  if (item.breakStart) await fillIfPresent(page, f.breakStartInput, item.breakStart);
  if (item.breakEnd) await fillIfPresent(page, f.breakEndInput, item.breakEnd);
  if (item.note) await fillIfPresent(page, f.noteInput, item.note);
  await pause(page);

  if (dryRun) {
    console.log(`  [dry-run] ${item.date} ${item.start}-${item.end} は送信せずスキップ`);
    return { date: item.date, status: 'dry-run' };
  }

  await page.locator(f.submitButton).first().click();

  if (f.successMarker) {
    try {
      await page.locator(f.successMarker).first().waitFor({ state: 'visible', timeout: 15000 });
    } catch {
      const shot = await screenshot(page, `apply-failed-${item.date}`);
      throw new Error(`${item.date} の申請成功を確認できませんでした。スクショ: ${shot}`);
    }
  } else {
    await pause(page);
  }

  console.log(`  ✓ ${item.date} ${item.start}-${item.end} 申請完了`);
  return { date: item.date, status: 'ok' };
}

async function fillIfPresent(page, selector, value) {
  if (!selector || value == null || value === '') return;
  const loc = page.locator(selector).first();
  await loc.fill(value);
}
