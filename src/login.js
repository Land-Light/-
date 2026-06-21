import { config } from './config.js';
import { selectors } from './selectors.js';
import { pause, screenshot } from './browser.js';

/**
 * 管理画面へログインする。
 * 永続プロファイルにより既ログインの場合は、フォームをスキップして即 true を返す。
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>} ログイン状態かどうか
 */
export async function ensureLoggedIn(page) {
  await page.goto(config.adminUrl, { waitUntil: 'domcontentloaded' });
  await pause(page);

  // 既にログイン済みなら目印が見えるはず
  if (selectors.login.loggedInMarker) {
    const already = await page.locator(selectors.login.loggedInMarker).first().isVisible().catch(() => false);
    if (already) {
      console.log('✓ 既存セッションでログイン済み');
      return true;
    }
  }

  const { idInput, passwordInput, submitButton } = selectors.login;
  if (!idInput || !passwordInput || !submitButton) {
    throw new Error(
      'ログイン用セレクタが未設定です。src/selectors.js の login.* を、実画面のHTMLに合わせて埋めてください。\n' +
      '（`npm run dump` でログイン画面のHTMLを保存できます）'
    );
  }

  console.log('… ログインフォームに入力中');
  await page.fill(idInput, config.loginId);
  await page.fill(passwordInput, config.password);
  await pause(page);
  await page.click(submitButton);

  // 成功判定
  if (selectors.login.loggedInMarker) {
    try {
      await page.locator(selectors.login.loggedInMarker).first().waitFor({ state: 'visible', timeout: 20000 });
    } catch {
      const shot = await screenshot(page, 'login-failed');
      throw new Error(`ログインに失敗した可能性があります。スクショ: ${shot}`);
    }
  } else {
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  console.log('✓ ログイン成功');
  return true;
}
