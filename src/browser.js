import path from 'node:path';
import { chromium } from 'playwright';
import { config, ROOT } from './config.js';

// セッション(Cookie等)を再利用するための永続プロファイル置き場
const USER_DATA_DIR = path.join(ROOT, '.pw-profile');

/**
 * 永続コンテキストでブラウザを起動する。
 * 一度ログインすればセッションが残るので、毎回ログインせずに済む（多要素認証対策にも有効）。
 */
export async function launchBrowser() {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: !config.headful,
    viewport: { width: 1280, height: 900 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(20000);
  return { context, page };
}

/** 軽い待機（取りこぼし防止） */
export async function pause(page) {
  if (config.actionDelayMs > 0) {
    await page.waitForTimeout(config.actionDelayMs);
  }
}

/** エラー時にスクリーンショットを残す */
export async function screenshot(page, name) {
  const dir = path.join(ROOT, 'screenshots');
  const fs = await import('node:fs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}
