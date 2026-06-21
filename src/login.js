import { config } from './config.js';
import { selectors } from './selectors.js';
import { pause, screenshot } from './browser.js';

/**
 * スケジュール申請画面を開き、ログイン状態を確認する。
 *
 * セッションは永続プロファイル（.pw-profile）に保存されるため、
 * 一度 `npm run dump` でログインしていれば、ここでは再ログイン不要で開けるはず。
 *
 * @param {import('playwright').Page} page
 */
export async function openSchedulePage(page) {
  const url = config.scheduleUrl || config.adminUrl;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await pause(page);

  // 申請画面の目印（「申請する」ボタン）が見えればOK
  const ready = await page
    .locator(selectors.loggedInMarker)
    .first()
    .isVisible()
    .catch(() => false);
  if (ready) {
    console.log('✓ スケジュール申請画面を開きました');
    return;
  }

  // ログイン画面に飛ばされていないか確認
  const onLogin = await page
    .locator(selectors.loginPasswordField)
    .first()
    .isVisible()
    .catch(() => false);

  const shot = await screenshot(page, 'open-failed');
  if (onLogin) {
    throw new Error(
      'ログインが必要です（セッション切れ）。\n' +
      '一度 `npm run dump` を実行してブラウザで手動ログインし、申請画面まで開いてから\n' +
      'もう一度 `npm run apply` を実行してください。セッションは保存され次回から自動で開けます。\n' +
      `スクショ: ${shot}`
    );
  }
  throw new Error(
    'スケジュール申請画面を開けませんでした。\n' +
    '.env の OFS_SCHEDULE_URL に、申請画面のアドレスバーURLを設定してください。\n' +
    `スクショ: ${shot}`
  );
}
