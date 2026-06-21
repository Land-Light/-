import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { config, ROOT } from './config.js';
import { launchBrowser } from './browser.js';

/**
 * セレクタ調査用ヘルパー。
 * ブラウザを開いて管理画面URLに移動し、あなたが手動でログイン＆申請画面まで
 * 操作したあと、ターミナルで Enter を押すと「今見えている画面のHTML」を保存します。
 * 保存したHTMLを貼ってもらえれば、src/selectors.js を正確に埋められます。
 *
 * 使い方:  npm run dump
 */
async function main() {
  if (!config.headful) {
    console.log('※ HEADFUL=true を推奨します（手動操作するため）。');
  }
  const { context, page } = await launchBrowser();
  await page.goto(config.adminUrl, { waitUntil: 'domcontentloaded' });

  console.log('\n────────────────────────────────────────');
  console.log('ブラウザで「スケジュール申請」画面まで手動で進めてください。');
  console.log('準備ができたら、このターミナルで Enter を押すとHTMLを保存します。');
  console.log('────────────────────────────────────────\n');

  await waitForEnter();

  const dir = path.join(ROOT, 'captures');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const html = await page.content();
  const htmlPath = path.join(dir, `page-${stamp}.html`);
  fs.writeFileSync(htmlPath, html, 'utf8');

  const shotPath = path.join(dir, `page-${stamp}.png`);
  await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});

  console.log(`\n✓ 保存しました:\n  HTML: ${htmlPath}\n  画像: ${shotPath}`);
  console.log('このHTMLの中身（特に入力欄・ボタン周辺）を貼ってください。');

  await context.close();
}

function waitForEnter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question('', () => { rl.close(); resolve(); }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
