import { config } from './config.js';
import { launchBrowser, screenshot } from './browser.js';
import { openSchedulePage } from './login.js';
import { setOneDay, submitAll, buildDateIndex } from './applySchedule.js';

/**
 * スケジュール申請を実行する（CLIとWeb画面の共通ロジック）。
 *
 * @param {Array} schedules - config.js が作る申請アイテム配列
 * @param {{dryRun?:boolean, onLog?:(line:string)=>void}} opts
 * @returns {Promise<{ok:boolean, submitted:boolean, results:Array, summary:object, message?:string}>}
 */
export async function runApply(schedules, opts = {}) {
  const { dryRun = false, onLog = () => {} } = opts;
  const log = (line) => {
    console.log(line);
    onLog(line);
  };

  log(`▶ スケジュール申請を開始（${schedules.length}件${dryRun ? ' / 確認のみ' : ''}）`);

  const { context, page } = await launchBrowser();
  const results = [];
  let submitted = false;
  let ok = true;
  let message;

  try {
    await openSchedulePage(page);
    const dateIndex = await buildDateIndex(page);

    for (const item of schedules) {
      const r = await setOneDay(page, item, dateIndex);
      const mark = { set: '✓', skip: '−', error: '✗' }[r.status] ?? '?';
      log(`  ${mark} ${item.date} ${r.detail ?? ''}`.trimEnd());
      results.push(r);
    }

    const settable = results.filter((r) => r.status === 'set');
    const errors = results.filter((r) => r.status === 'error');

    if (errors.length > 0) {
      ok = false;
      message = `入力できない行が ${errors.length} 件あるため、送信せず中止しました。`;
      log(`\n${message}`);
      errors.forEach((e) => log(`  - ${e.date}: ${e.detail}`));
    } else if (settable.length === 0) {
      message = '送信対象がありません（全てスキップ）。表示期間や日付を確認してください。';
      log(`\n${message}`);
    } else if (dryRun) {
      message = `${settable.length} 件を入力しました（確認のみ・申請は未送信）。`;
      log(`\n[確認のみ] ${message}`);
    } else {
      log(`\n${settable.length} 件を申請します…`);
      await submitAll(page);
      submitted = true;
      message = `${settable.length} 件を申請しました。`;
      log('✓ 申請を送信しました');
    }
  } catch (err) {
    ok = false;
    const shot = await screenshot(page, 'fatal').catch(() => null);
    message = err.message;
    log(`エラー: ${err.message}${shot ? `\nスクショ: ${shot}` : ''}`);
  } finally {
    if (config.headful) await page.waitForTimeout(dryRun ? 2000 : 1000);
    await context.close();
  }

  const summary = {
    set: results.filter((r) => r.status === 'set').length,
    skip: results.filter((r) => r.status === 'skip').length,
    error: results.filter((r) => r.status === 'error').length,
  };
  log(`\n── 結果 ──  入力:${summary.set}  スキップ:${summary.skip}  エラー:${summary.error}`);

  return { ok, submitted, results, summary, message };
}
