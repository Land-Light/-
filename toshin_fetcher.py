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


def _find_id_input(page):
    """ログインID入力欄(パスワード以外の最初の可視テキスト入力)を返す。

    東進サイトは Vuetify 系のUIで、ラベル「ID」が placeholder 属性でない
    ことがあるため、属性名に頼らず「可視のテキスト系 input のうち
    パスワードでない最初のもの」を ID 欄とみなす。
    """
    inputs = page.locator("input")
    for i in range(inputs.count()):
        el = inputs.nth(i)
        try:
            if not el.is_visible():
                continue
            t = (el.get_attribute("type") or "text").lower()
            if t in ("password", "hidden", "checkbox", "radio", "submit", "button", "file"):
                continue
            return el
        except Exception:
            continue
    return None


def _try_login(page, user: str, password: str) -> None:
    """ログインフォームが表示されていれば入力して送信する。"""
    pw = page.locator('input[type="password"]')
    if pw.count() == 0:
        return  # ログイン済み(またはログイン画面ではない)

    id_el = _find_id_input(page)
    if id_el is None:
        raise ToshinFetchError("ログインID入力欄が見つかりませんでした。")
    id_el.click()
    id_el.fill(user)
    pw.first.click()
    pw.first.fill(password)

    # 「ログイン」ボタンを押す(候補を順に試す)
    clicked = False
    for sel in [
        'button:has-text("ログイン")', 'button:has-text("サインイン")',
        'button:has-text("ログオン")', 'button[type="submit"]', 'input[type="submit"]',
        'button:has-text("Login")', 'button:has-text("Sign in")',
    ]:
        loc = page.locator(sel)
        if loc.count() > 0 and loc.first.is_visible():
            loc.first.click()
            clicked = True
            break
    if not clicked:
        pw.first.press("Enter")

    # ログイン処理の完了を待つ:ログイン画面(パスワード欄)から離れれば成功。
    # 認証に時間がかかる場合があるので最大45秒待つ。
    try:
        page.wait_for_selector('input[type="password"]', state="detached", timeout=45000)
    except Exception:
        pass

    if page.locator('input[type="password"]').count() > 0:
        # まだログイン画面 → 認証失敗の可能性。サイト側のエラーメッセージを拾う
        site_msg = ""
        for sel in [
            '.v-messages__message', '.v-alert', '[role="alert"]',
            '.error', '.error-message', 'text=/違い|正しく|失敗|エラー/',
        ]:
            try:
                loc = page.locator(sel)
                if loc.count() > 0 and loc.first.is_visible():
                    t = loc.first.inner_text().strip()
                    if t:
                        site_msg = t
                        break
            except Exception:
                continue
        detail = f"(サイトの表示: {site_msg})" if site_msg else ""
        raise ToshinFetchError(
            "ログインに失敗しました。環境変数 TOSHIN_USER / TOSHIN_PASSWORD が"
            "正しいか(パスワード変更後の最新の値か)確認してください。" + detail
        )


def _has_answer_table(page) -> bool:
    """答案一覧の表(行あり)が存在するか。"""
    try:
        return page.locator("table tbody tr").count() > 0
    except Exception:
        return False


def _follow_grading_app_link(page) -> None:
    """「添削者Webアプリ」など、答案一覧へ進むリンクがあればクリックする。"""
    for sel in [
        'a:has-text("添削者Webアプリ")', 'a:has-text("添削")',
        'a:has-text("答案")', 'a:has-text("一覧")', 'a:has-text("こちら")',
        'button:has-text("添削者Webアプリ")', 'button:has-text("添削")',
    ]:
        loc = page.locator(sel)
        if loc.count() > 0 and loc.first.is_visible():
            try:
                loc.first.click()
                page.wait_for_load_state("networkidle", timeout=30000)
            except Exception:
                pass
            if _has_answer_table(page):
                return


def _find_download_control(row):
    """行の中からダウンロード用の操作要素を探す。

    MUI のテーブルは行内に複数のアイコンボタン(閲覧・DL・削除など)が並び、
    最後の要素が無効化(disabled)されていることがある。そこで
    (1) ダウンロードを示す属性、(2) 無効でない有効なボタン/リンク、の順で探す。
    """
    # (1) ダウンロードを示す明示的な手掛かり
    for sel in [
        'a[href$=".pdf"]', 'a[download]',
        'button[aria-label*="ダウンロード"]', 'a[aria-label*="ダウンロード"]',
        'button[title*="ダウンロード"]', 'a[title*="ダウンロード"]',
        '[aria-label*="download" i]', '[title*="download" i]',
        '[data-test*="download" i]',
    ]:
        loc = row.locator(sel)
        for j in range(loc.count()):
            el = loc.nth(j)
            try:
                if el.is_visible() and el.is_enabled():
                    return el
            except Exception:
                continue
    # (2) 有効な(disabledでない)ボタン/リンクのうち最後のもの
    cand = row.locator("button:not([disabled]), a[href]")
    enabled = []
    for j in range(cand.count()):
        el = cand.nth(j)
        try:
            if el.is_visible() and el.is_enabled():
                enabled.append(el)
        except Exception:
            continue
    if enabled:
        return enabled[-1]
    return None


def _click_and_get_pdf(page, context, btn, idx: int):
    """ダウンロードボタンを押し、PDFの (ファイル名, バイト列) を返す。

    直接ダウンロード / 新規タブでのPDF表示 の双方に対応する。
    """
    # まず直接ダウンロード(download イベント)を待つ。
    try:
        with page.expect_download(timeout=30000) as dl_info:
            btn.click()
        download = dl_info.value
        data = open(download.path(), "rb").read()
        return (download.suggested_filename or f"answer_{idx}.pdf"), data
    except Exception:
        pass

    # ダウンロードが来なければ、新規タブで開いたPDFのURLを取得して取りに行く
    for pg in list(context.pages):
        if pg == page:
            continue
        try:
            pg.wait_for_load_state("domcontentloaded", timeout=5000)
        except Exception:
            pass
        u = pg.url or ""
        if u and (".pdf" in u.lower() or "amazonaws" in u.lower() or "s3" in u.lower()):
            try:
                resp = context.request.get(u)
                if resp.ok:
                    body = resp.body()
                    if body:
                        return f"answer_{idx}.pdf", body
            finally:
                try:
                    pg.close()
                except Exception:
                    pass
    raise RuntimeError("ダウンロードもPDFタブも検出できませんでした")


def _download_col_index(page):
    """ヘッダーから「答案」列(data-test-id="download")の列番号を返す。"""
    headers = page.locator("thead th")
    n = headers.count()
    for i in range(n):
        try:
            if (headers.nth(i).get_attribute("data-test-id") or "") == "download":
                return i
        except Exception:
            continue
    for i in range(n):  # フォールバック: ヘッダー文字が「答案」
        try:
            if headers.nth(i).inner_text().strip() == "答案":
                return i
        except Exception:
            continue
    return None


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


def _save_debug(page) -> str:
    """失敗時の画面(PNG)とHTMLを保存し、現在地のヒント文字列を返す。"""
    try:
        page.screenshot(path=os.path.join(_DEBUG_DIR, "debug_toshin_error.png"),
                        full_page=True)
        with open(os.path.join(_DEBUG_DIR, "debug_toshin_error.html"),
                  "w", encoding="utf-8") as fh:
            fh.write(page.content())
        return f"(現在地: {page.url} 「{page.title()}」/ 失敗画面は /toshin-debug で確認)"
    except Exception:
        return ""


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
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            # SPA(Vuetify)なのでフォームや一覧の描画を待ってからログインする
            try:
                page.wait_for_selector(
                    'input[type="password"], table tbody tr', timeout=30000
                )
            except Exception:
                pass
            _try_login(page, user, password)

            # ログイン後、答案一覧(table)を探す。すぐ見つからなければ
            # 「添削者Webアプリ」等のリンクをたどってから再探索する。
            if not _has_answer_table(page):
                # 一覧URLへ再遷移してみる
                if "/correction" not in page.url:
                    try:
                        page.goto(url, wait_until="networkidle", timeout=60000)
                    except Exception:
                        pass
                if not _has_answer_table(page):
                    _follow_grading_app_link(page)

            page.wait_for_selector("table tbody tr", timeout=30000)
            rows = page.locator("table tbody tr")
            n = min(rows.count(), max_count)
            if n == 0:
                raise ToshinFetchError("答案一覧に行がありません(未割当の可能性)。")

            dl_col = _download_col_index(page)
            list_dumped = False
            for i in range(n):
                row = rows.nth(i)
                meta = _row_meta(row)
                # 「答案」列のセルにある有効なダウンロードボタンを狙う
                btn = None
                if dl_col is not None:
                    cell = row.locator("td").nth(dl_col)
                    c = cell.locator("button:not([disabled]), a[href]")
                    if c.count() > 0:
                        btn = c.first
                if btn is None:  # フォールバック
                    btn = _find_download_control(row)
                try:
                    if btn is None:
                        raise RuntimeError("ダウンロードボタンが見つかりません")
                    name, pdf_bytes = _click_and_get_pdf(page, context, btn, i + 1)
                    fetched.append(FetchedAnswer(filename=name, pdf_bytes=pdf_bytes, meta=meta))
                except Exception as e:  # 1行の失敗で全体を止めない
                    # 最初の失敗時に一覧ページのHTML/スクショを保存(構造調整用)
                    if not list_dumped:
                        _save_debug(page)
                        list_dumped = True
                    try:
                        others = [pg.url for pg in context.pages if pg != page and pg.url]
                    except Exception:
                        others = []
                    extra = (" / 新規タブ: " + ", ".join(others)) if others else ""
                    fetched.append(FetchedAnswer(
                        filename=f"row{i + 1}_error", pdf_bytes=b"",
                        meta={**meta, "error": str(e) + extra},
                    ))
            return fetched
        except Exception as e:
            # 失敗時は必ず最新の画面を保存する(ログイン失敗も含む)
            hint = _save_debug(page)
            if isinstance(e, ToshinFetchError):
                # 既に分かりやすいメッセージがある場合はヒントだけ添える
                raise ToshinFetchError(f"{e} {hint}") from e
            raise ToshinFetchError(f"東進サイトの操作に失敗しました: {e} {hint}") from e
        finally:
            context.close()
            browser.close()
