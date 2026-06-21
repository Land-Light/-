import { config, loadSchedules } from './config.js';
import { launchBrowser, screenshot } from './browser.js';
import { openSchedulePage } from './login.js';
import { setOneDay, submitAll, buildDateIndex } from './applySchedule.js';

function parseArgs(argv) {
  const args = { dryRun: false, csv: 'data/schedules.csv' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--csv') args.csv = argv[++i];
    else if (a.startsWith('--csv=')) args.csv = a.slice('--csv='.length);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`▶ スケジュール申請を開始 (csv=${args.csv}${args.dryRun ? ', dry-run' : ''})`);

  const schedules = loadSchedules(args.csv);
  console.log(`  ${schedules.length} 件の申請対象を読み込みました`);

  const { context, page } = await launchBrowser();
  const results = [];
  try {
    await openSchedulePage(page);

    // 日付→行の並び順を把握（申請メッセージ欄の対応づけ用）
    const dateIndex = await buildDateIndex(page);

    // 各日付を入力（ここではまだ送信しない）
    for (const item of schedules) {
      const r = await setOneDay(page, item, dateIndex);
      const mark = { set: '✓', skip: '−', error: '✗' }[r.status] ?? '?';
      console.log(`  ${mark} ${item.date} ${r.detail ?? ''}`.trimEnd());
      results.push(r);
    }

    const settable = results.filter((r) => r.status === 'set');
    const errors = results.filter((r) => r.status === 'error');

    if (errors.length > 0) {
      console.error(`\n入力できない行が ${errors.length} 件あります。中止します（送信しません）。`);
      errors.forEach((e) => console.error(`  - ${e.date}: ${e.detail}`));
      process.exitCode = 1;
      return;
    }
    if (settable.length === 0) {
      console.log('\n送信対象がありません（全てスキップ）。表示期間や日付を確認してください。');
      return;
    }

    if (args.dryRun) {
      console.log(`\n[dry-run] ${settable.length} 件を入力しました（「申請する」は押していません）。`);
      console.log('  画面で内容を確認できます。問題なければ dry-run を外して実行してください。');
      return;
    }

    console.log(`\n${settable.length} 件を申請します…`);
    await submitAll(page);
    console.log('✓ 申請を送信しました');
  } catch (err) {
    const shot = await screenshot(page, 'fatal');
    console.error(`エラー: ${err.message}\nスクショ: ${shot}`);
    process.exitCode = 1;
  } finally {
    if (config.headful) await page.waitForTimeout(2000);
    await context.close();
  }

  const set = results.filter((r) => r.status === 'set').length;
  const skip = results.filter((r) => r.status === 'skip').length;
  const err = results.filter((r) => r.status === 'error').length;
  console.log(`\n── 結果 ──  入力:${set}  スキップ:${skip}  エラー:${err}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
