"""東進 添削システム(toshin-correction.com)から答案PDFを自動取得するモジュール。

Playwright(Chromium)でログイン→答案一覧(/correction)→各行のダウンロード
ボタンから答案PDFを取得する。

認証情報は環境変数で渡す(コードやリポジトリに書かないこと):
    TOSHIN_USER      ログインID
    TOSHIN_PASSWORD  パスワード
    TOSHIN_URL       一覧ページURL(省略時 https://www.toshin-correction.com/correction)

デプロイ先で Chromium が必要:
    pip install playwright && playwright install --with-deps chromium
(同梱の Dockerfile はインストール済み)

サイトのUI変更でセレクタが合わなくなった場合は、失敗時に保存される
スクリーンショット(debug_toshin_*.png)を確認して調整すること。
"""

import os
import re
from dataclasses import dataclass, field
from typing import List

DEFAULT_URL = "https://www.toshin-correction.com/correction"

_DEBUG_DIR = os.environ.get("TOSHIN_DEBUG_DIR", "/tmp")


@dataclass
class FetchedAnswer:
    """取得した答案1件。"""

    filename: str
    pdf_bytes: bytes
    meta: dict = field(default_factory=dict)  # 概要・ASID・生徒コードなど


class ToshinFetchError(RuntimeError):
    pass


def _creds():
    user = os.environ.get("TOSHIN_USER", "")
    password = os.environ.get("TOSHIN_PASSWORD", "")
    if not user or not password:
        raise ToshinFetchError(
            "環境変数 TOSHIN_USER / TOSHIN_PASSWORD を設定してください。"
        )
    return user, password


def _try_login(page, user: str, password: str) -> None:
    """ログインフォームが表示されていれば入力して送信する(ベストエフォート)。"""
    # ID入力欄の候補
    id_selectors = [
        'input[name*="user" i]', 'input[name*="login" i]', 'input[name*="id" i]',
        'input[type="email"]', 'input[type="text"]',
    ]
    pw_selector = 'input[type="password"]'
    if page.locator(pw_selector).count() == 0:
        return  # ログイン済み(またはログイン画面ではない)

    for sel in id_selectors:
        loc = page.locator(sel)
        if loc.count() > 0 and loc.first.is_visible():
            loc.first.fill(user)
            break
    else:
        raise ToshinFetchError("ログインID入力欄が見つかりませんでした。")

    page.locator(pw_selector).first.fill(password)

    # 送信ボタンの候補
    for sel in [
        'button[type="submit"]', 'input[type="submit"]',
        'button:has-text("ログイン")', 'button:has-text("サインイン")',
        'button:has-text("Login")', 'button:has-text("Sign in")',
    ]:
        loc = page.locator(sel)
        if loc.count() > 0 and loc.first.is_visible():
            loc.first.click()
            break
    else:
        page.locator(pw_selector).first.press("Enter")

    page.wait_for_load_state("networkidle", timeout=30000)


def _row_meta(row) -> dict:
    """一覧テーブルの行からメタ情報を取り出す(ベストエフォート)。"""
    cells = [c.strip() for c in row.inner_text().split("\n") if c.strip()]
    meta = {"row_text": " / ".join(cells)}
    joined = " ".join(cells)
    m = re.search(r"\b(\d{9})\b", joined)  # ASID(9桁)
    if m:
        meta["asid"] = m.group(1)
    m = re.search(r"\b(\d{8})\b", joined)  # 生徒コード(8桁)
    if m:
        meta["student_code"] = m.group(1)
    m = re.search(r"(\S*大学\S*)", joined)
    if m:
        meta["exam"] = m.group(1)
    return meta


def fetch_answers(max_count: int = 20, headless: bool = True) -> List[FetchedAnswer]:
    """東進添削システムにログインし、一覧の各行から答案PDFをダウンロードする。"""
    from playwright.sync_api import sync_playwright

    user, password = _creds()
    url = os.environ.get("TOSHIN_URL", DEFAULT_URL)
    fetched: List[FetchedAnswer] = []

    with sync_playwright() as p:
        exe = os.environ.get("PLAYWRIGHT_CHROMIUM_PATH")
        browser = p.chromium.launch(
            headless=headless, executable_path=exe if exe else None
        )
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()
        try:
            page.goto(url, wait_until="networkidle", timeout=60000)
            _try_login(page, user, password)

            # ログイン後、一覧ページに居ることを確認(必要なら再遷移)
            if "/correction" not in page.url:
                page.goto(url, wait_until="networkidle", timeout=60000)

            page.wait_for_selector("table tbody tr", timeout=30000)
            rows = page.locator("table tbody tr")
            n = min(rows.count(), max_count)
            if n == 0:
                raise ToshinFetchError("答案一覧に行がありません(未割当の可能性)。")

            for i in range(n):
                row = rows.nth(i)
                meta = _row_meta(row)
                # 行の最終セル(答案列)にあるダウンロードボタン/アイコンをクリック
                btn = row.locator("td").last.locator("button, a, [role='button']")
                if btn.count() == 0:
                    btn = row.locator("button, a").last
                try:
                    with page.expect_download(timeout=60000) as dl_info:
                        btn.first.click()
                    download = dl_info.value
                    path = download.path()
                    pdf_bytes = open(path, "rb").read()
                    name = download.suggested_filename or f"answer_{i + 1}.pdf"
                    fetched.append(FetchedAnswer(filename=name, pdf_bytes=pdf_bytes, meta=meta))
                except Exception as e:  # 1行の失敗で全体を止めない
                    fetched.append(FetchedAnswer(
                        filename=f"row{i + 1}_error", pdf_bytes=b"",
                        meta={**meta, "error": str(e)},
                    ))
            return fetched
        except ToshinFetchError:
            raise
        except Exception as e:
            shot = os.path.join(_DEBUG_DIR, "debug_toshin_error.png")
            try:
                page.screenshot(path=shot, full_page=True)
                hint = f"(スクリーンショット: {shot})"
            except Exception:
                hint = ""
            raise ToshinFetchError(f"東進サイトの操作に失敗しました: {e} {hint}") from e
        finally:
            context.close()
            browser.close()
