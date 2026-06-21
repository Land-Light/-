import { config, loadSchedules } from './config.js';
import { launchBrowser, screenshot } from './browser.js';
import { ensureLoggedIn } from './login.js';
import { gotoScheduleApply, applyOneDay } from './applySchedule.js';

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
    await ensureLoggedIn(page);
    await gotoScheduleApply(page);

    for (const item of schedules) {
      try {
        const r = await applyOneDay(page, item, { dryRun: args.dryRun });
        results.push(r);
      } catch (err) {
        console.error(`  ✗ ${item.date} 失敗: ${err.message}`);
        results.push({ date: item.date, status: 'error', error: err.message });
      }
    }
  } catch (err) {
    const shot = await screenshot(page, 'fatal');
    console.error(`致命的エラー: ${err.message}\nスクショ: ${shot}`);
    process.exitCode = 1;
  } finally {
    // headful のときは確認のため少し残す
    if (config.headful) await page.waitForTimeout(1500);
    await context.close();
  }

  // サマリ
  const ok = results.filter((r) => r.status === 'ok').length;
  const dry = results.filter((r) => r.status === 'dry-run').length;
  const ng = results.filter((r) => r.status === 'error').length;
  console.log(`\n── 結果 ──  成功:${ok}  dry-run:${dry}  失敗:${ng}`);
  if (ng > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
