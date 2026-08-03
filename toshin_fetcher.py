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
import time
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


# 省メモリ用の Chromium 起動フラグ。無料プラン(512MB)では Chromium が
# メモリ上限を超えて再起動されやすいため、GPU・共有メモリ・拡張などを無効化し、
# 単一プロセスで動かして常駐メモリを抑える。
_CHROMIUM_ARGS = [
    "--no-sandbox",
    "--disable-dev-shm-usage",      # /dev/shm 不足による肥大を回避
    "--disable-gpu",
    "--single-process",             # プロセス分割をやめて常駐メモリを削減
    "--no-zygote",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-features=site-per-process,TranslateUI",
    "--js-flags=--max-old-space-size=256",
    "--window-size=1280,1600",
]


def _launch_browser(p, headless: bool = True):
    """省メモリ設定で Chromium を起動する(全経路で共通)。"""
    exe = os.environ.get("PLAYWRIGHT_CHROMIUM_PATH")
    return p.chromium.launch(
        headless=headless,
        executable_path=exe if exe else None,
        args=_CHROMIUM_ARGS,
    )


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

    答案DLは URL に .pdf を含まない(APIや署名付きURL)ことがあるため、
    URL 文字列ではなく Content-Type(application/pdf 等)でPDF応答を判定する。
    直接ダウンロード / 新規タブ表示 / 埋め込み のいずれにも対応する。
    """
    pdf_responses: list = []
    all_urls: list = []
    download_holder: dict = {}

    def _on_response(r):
        try:
            u = r.url or ""
            if len(all_urls) < 300:
                all_urls.append(u)
            lu = u.lower()
            ct = ""
            try:
                ct = (r.headers or {}).get("content-type", "").lower()
            except Exception:
                ct = ""
            if (lu.endswith(".pdf") or ".pdf?" in lu
                    or "application/pdf" in ct or "octet-stream" in ct):
                pdf_responses.append(r)
        except Exception:
            pass

    def _on_download(d):
        download_holder["d"] = d

    page.on("response", _on_response)
    page.on("download", _on_download)
    tried: set = set()
    tried_resp: set = set()

    def _accept(u: str, body) -> bool:
        return bool(body) and body[:5] == b"%PDF-" and "reference" not in (u or "").lower()

    try:
        btn.click()
        deadline = time.time() + 30
        while time.time() < deadline:
            # 1) 直接ダウンロード
            d = download_holder.get("d")
            if d is not None:
                try:
                    return (d.suggested_filename or f"answer_{idx}.pdf"), open(d.path(), "rb").read()
                except Exception:
                    download_holder.pop("d", None)
            # 2) Content-Type で捕捉したPDF応答から本体を取得(referenceは除外)
            for r in list(pdf_responses):
                if id(r) in tried_resp:
                    continue
                tried_resp.add(id(r))
                u = r.url or ""
                if "reference" in u.lower():
                    continue
                body = None
                try:
                    body = r.body()
                except Exception:
                    body = None
                if not body:  # 応答本体が取れなければURLから取り直す
                    try:
                        rr = context.request.get(u)
                        body = rr.body() if rr.ok else None
                    except Exception:
                        body = None
                if _accept(u, body):
                    return f"answer_{idx}.pdf", body
            # 3) 新規タブ / DOM 埋め込みの URL を取得
            candidates = []
            for pg in list(context.pages):
                if pg != page and pg.url:
                    candidates.append(pg.url)
            try:
                els = page.locator("object[data], embed[src], iframe[src], a[href]")
                for j in range(min(els.count(), 10)):
                    for attr in ("data", "src", "href"):
                        v = els.nth(j).get_attribute(attr)
                        if v:
                            candidates.append(v)
            except Exception:
                pass
            for u in candidates:
                if u in tried or "reference" in u.lower():
                    continue
                tried.add(u)
                try:
                    rr = context.request.get(u)
                    if rr.ok:
                        body = rr.body()
                        if _accept(u, body):
                            return f"answer_{idx}.pdf", body
                except Exception:
                    continue
            page.wait_for_timeout(500)
    finally:
        try:
            page.remove_listener("response", _on_response)
            page.remove_listener("download", _on_download)
        except Exception:
            pass
    # 診断用に、クリック後に流れた通信URLの一部をエラーに載せる
    sample = [u for u in all_urls if "toshin" in u.lower() or "amazon" in u.lower()
              or "download" in u.lower() or ".pdf" in u.lower()]
    hint = " , ".join(sample[-6:])[:400] if sample else "該当なし(/toshin-debug で画面を確認)"
    raise RuntimeError(f"答案PDFを取得できませんでした(通信: {hint})")


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
    # Tensakit(オンライン採点サイト)へのリンク
    try:
        link = row.locator('a[href*="tensakit"]')
        if link.count() > 0:
            href = link.first.get_attribute("href")
            if href:
                meta["tensakit_url"] = href
    except Exception:
        pass
    return meta


def _close_dialogs(page) -> None:
    """直前の操作で開いたモーダル/ダイアログを閉じる。

    MUI の Dialog(data-test="dialog")が開いたまま残っていると、次の行の
    ダウンロードボタンを覆ってしまい、クリックが妨げられる
    (pointer events intercepted)。複数採点の2件目以降で失敗する原因なので、
    各行の処理前にこれを呼んで前のダイアログを確実に閉じる。
    """
    for _ in range(3):
        dlg = page.locator('[data-test="dialog"], .MuiDialog-root')
        try:
            visible = dlg.count() > 0 and dlg.first.is_visible()
        except Exception:
            visible = False
        if not visible:
            return
        closed = False
        for sel in [
            '[data-test="dialog"] button[aria-label*="close" i]',
            '.MuiDialog-root button[aria-label*="close" i]',
            '[aria-label*="閉じる"]', 'button:has-text("閉じる")',
            'button:has-text("キャンセル")', 'button:has-text("戻る")',
        ]:
            loc = page.locator(sel)
            try:
                if loc.count() > 0 and loc.first.is_visible():
                    loc.first.click()
                    closed = True
                    break
            except Exception:
                continue
        if not closed:
            try:
                page.keyboard.press("Escape")
            except Exception:
                pass
        page.wait_for_timeout(400)


_GRADED_TEXT = re.compile(r"採点済|添削済|返却済|提出済|完了")


def _is_graded(row) -> bool:
    """行が採点済み(東進の一覧で緑色に表示される答案)かどうかを判定する。

    採点/提出が済んだ答案は緑色で表示されるため、
    (1) 「採点済」等のステータス文言、または
    (2) success 系の緑色の配色(文字色・背景色・枠色)
    のいずれかを持つ行を採点済みとみなす。
    """
    # (1) ステータス文言
    try:
        if _GRADED_TEXT.search(row.inner_text() or ""):
            return True
    except Exception:
        pass
    # (2) 緑色(success系)の配色を持つ要素があるか(計算スタイルを走査)
    try:
        green = row.evaluate(
            """(el) => {
                const isGreen = (c) => {
                    if (!c) return false;
                    const m = c.match(/rgba?\\(([^)]+)\\)/);
                    if (!m) return false;
                    const p = m[1].split(',').map(s => parseFloat(s));
                    const r = p[0], g = p[1], b = p[2];
                    const a = p.length > 3 ? p[3] : 1;
                    if (a < 0.1) return false;
                    // 緑が突出している配色(MUI success #2e7d32 / #4caf50 など)
                    return g > 90 && g > r + 25 && g > b + 25;
                };
                const nodes = [el, ...el.querySelectorAll('*')];
                for (const n of nodes) {
                    const s = getComputedStyle(n);
                    if (isGreen(s.color) || isGreen(s.backgroundColor)
                        || isGreen(s.borderColor)) return true;
                }
                return false;
            }"""
        )
        if green:
            return True
    except Exception:
        pass
    return False


def _try_tensakit_login(tpage, user: str, password: str) -> None:
    """Tensakit(AWS Amplify製)のサインイン画面が出ていればログインする。

    フォーム: input[name="username"] / input[name="password"] / button[type="submit"](サインイン)
    認証情報は TENSAKIT_USER/TENSAKIT_PASSWORD があればそれを、無ければ東進と同じものを使う。
    """
    u = os.environ.get("TENSAKIT_USER", user)
    pw = os.environ.get("TENSAKIT_PASSWORD", password)
    try:
        tpage.wait_for_selector('input[name="username"], canvas, [class*="Board"]', timeout=20000)
    except Exception:
        pass
    uname = tpage.locator('input[name="username"]')
    if uname.count() == 0:
        return  # サインイン画面ではない(ログイン済み等)

    # React(Amplify)の制御フォームに確実に反映させるため、クリック→1文字ずつ入力
    uname.first.click()
    uname.first.press_sequentially(u, delay=40)
    pwd = tpage.locator('input[name="password"]').first
    pwd.click()
    pwd.press_sequentially(pw, delay=40)
    tpage.wait_for_timeout(500)
    tpage.locator('form[data-amplify-authenticator-signin] button[type="submit"], button[type="submit"]').first.click()

    # 最大30秒待ち、ログイン成功(フォーム消滅)かエラー表示かを判定する
    site_msg = ""
    for _ in range(30):
        tpage.wait_for_timeout(1000)
        if tpage.locator('input[name="username"]').count() == 0:
            return  # サインイン成功
        for sel in ['[data-variation="error"]', '.amplify-alert', '[role="alert"]']:
            loc = tpage.locator(sel)
            if loc.count() > 0:
                try:
                    t = loc.first.inner_text().strip()
                except Exception:
                    t = ""
                if t:
                    site_msg = t
                    break
        if site_msg:
            break

    # 失敗時の画面を保存(/tensakit-page で確認できる)
    try:
        tpage.screenshot(path=os.path.join(_DEBUG_DIR, "tensakit_page.png"), full_page=True)
        with open(os.path.join(_DEBUG_DIR, "tensakit_page.html"), "w", encoding="utf-8") as fh:
            fh.write(tpage.content())
    except Exception:
        pass
    detail = f"(サイトの表示: {site_msg})" if site_msg else "(サイトのエラー表示は検出できず。/tensakit-page で画面を確認)"
    raise ToshinFetchError(
        "Tensakit へのサインインに失敗しました。" + detail +
        " 東進と同じ ID/パスワードで入れない場合は、環境変数 TENSAKIT_USER / TENSAKIT_PASSWORD を設定してください。"
    )


def inspect_tensakit(headless: bool = True) -> dict:
    """ログインして一覧の最初の行の Tensakit リンクを開き、
    採点画面の HTML とスクリーンショットを保存する(採点入力自動化の設計用・偵察)。"""
    from playwright.sync_api import sync_playwright

    user, password = _creds()
    url = os.environ.get("TOSHIN_URL", DEFAULT_URL)
    with sync_playwright() as p:
        browser = _launch_browser(p, headless)
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            try:
                page.wait_for_selector('input[type="password"], table tbody tr', timeout=30000)
            except Exception:
                pass
            _try_login(page, user, password)
            if not _has_answer_table(page):
                if "/correction" not in page.url:
                    try:
                        page.goto(url, wait_until="networkidle", timeout=60000)
                    except Exception:
                        pass
                if not _has_answer_table(page):
                    _follow_grading_app_link(page)
            page.wait_for_selector("table tbody tr", timeout=30000)
            rows = page.locator("table tbody tr")
            if rows.count() == 0:
                raise ToshinFetchError("答案一覧に行がありません。")
            link = rows.first.locator('a[href*="tensakit"]')
            if link.count() == 0:
                raise ToshinFetchError("Tensakit リンクが見つかりません。")
            href = link.first.get_attribute("href")
            # target=_blank のため新規タブで開く。ポップアップを待つ。
            tpage = None
            try:
                with context.expect_page(timeout=30000) as pg_info:
                    link.first.click()
                tpage = pg_info.value
            except Exception:
                tpage = context.new_page()
                tpage.goto(href, wait_until="domcontentloaded", timeout=60000)
            try:
                tpage.wait_for_load_state("networkidle", timeout=30000)
            except Exception:
                pass
            # Tensakit は独自のサインイン画面(AWS Amplify)を持つため、必要ならログインする
            _try_tensakit_login(tpage, user, password)
            try:
                tpage.wait_for_load_state("networkidle", timeout=30000)
            except Exception:
                pass
            tpage.wait_for_timeout(3000)
            tpage.screenshot(path=os.path.join(_DEBUG_DIR, "tensakit_page.png"), full_page=True)
            with open(os.path.join(_DEBUG_DIR, "tensakit_page.html"), "w", encoding="utf-8") as fh:
                fh.write(tpage.content())
            return {"ok": True, "url": tpage.url, "title": tpage.title(), "tensakit_url": href}
        except ToshinFetchError:
            _save_debug(page)
            raise
        except Exception as e:
            _save_debug(page)
            raise ToshinFetchError(f"Tensakit 画面の取得に失敗しました: {e}") from e
        finally:
            context.close()
            browser.close()


def _open_tensakit_grading(context, page, href: str, user: str, password: str):
    """一覧の Tensakit リンクから採点画面(別タブ)を開き、必要ならサインインする。"""
    tpage = None
    try:
        with context.expect_page(timeout=30000) as pg_info:
            page.locator(f'a[href="{href}"]').first.click()
        tpage = pg_info.value
    except Exception:
        tpage = context.new_page()
        tpage.goto(href, wait_until="domcontentloaded", timeout=60000)
    try:
        tpage.wait_for_load_state("networkidle", timeout=30000)
    except Exception:
        pass
    _try_tensakit_login(tpage, user, password)
    try:
        tpage.wait_for_load_state("networkidle", timeout=30000)
    except Exception:
        pass
    tpage.wait_for_timeout(2500)
    return tpage


def _scrape_grading_panel(tpage) -> List[dict]:
    """採点パネル(右側)を読み取り、設問セクションごとの加点/減点選択肢を返す。

    Tensakit のパネルは「◯◯完了(添削完了)」のチェックが各セクションの見出しに
    付き、その下に「加点項目」「減点項目」の選択肢が並ぶ。画面のテキスト構造から
    ベストエフォートで抽出する(DOM変更時は tensakit_page.html を見て調整)。
    """
    sections = tpage.evaluate(
        r"""() => {
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
            // 「添削完了」を含む見出し要素を各セクションの起点にする
            const all = Array.from(document.querySelectorAll('body *'));
            const heads = all.filter(el =>
                el.children.length <= 4 && /添削完了/.test(el.textContent || '') &&
                !Array.from(el.children).some(c => /添削完了/.test(c.textContent || '')));
            const secs = [];
            heads.forEach((head, hi) => {
                // セクション見出しの文言(「添削完了」を除く)
                let label = norm((head.textContent || '').replace('添削完了', ''));
                // このセクションの範囲 = head から次の head の直前まで、共通の親配下で走査
                let container = head;
                for (let k = 0; k < 5 && container.parentElement; k++) container = container.parentElement;
                const add = [], ded = [];
                // container 配下のチェックボックス行を「加点項目/減点項目」の見出しで振り分け
                const nodes = Array.from(container.querySelectorAll('*'));
                let mode = '';
                let idxA = 0, idxD = 0;
                for (const n of nodes) {
                    const t = norm(n.textContent || '');
                    if (n.children.length === 0 && /加点項目/.test(t)) mode = 'add';
                    else if (n.children.length === 0 && /減点項目/.test(t)) mode = 'ded';
                    const cb = n.matches && n.matches('input[type=checkbox], [role=checkbox]');
                    if (cb) {
                        // 行のラベル = チェックボックスの近傍テキスト
                        let row = n.closest('li,label,tr,div') || n.parentElement;
                        let lab = norm(row ? row.textContent : '');
                        if (mode === 'add') add.push({index: idxA++, label: lab});
                        else if (mode === 'ded') ded.push({index: idxD++, label: lab});
                    }
                }
                if (label || add.length || ded.length)
                    secs.push({section_label: label || ('セクション' + (hi+1)),
                               add_options: add, deduct_options: ded});
            });
            return secs;
        }"""
    )
    return sections or []


def _tensakit_check_option(tpage, section_label: str, kind: str, index: int) -> None:
    """指定セクションの加点/減点の index 番目のチェックボックスをオンにする。"""
    tpage.evaluate(
        r"""({label, kind, index}) => {
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const all = Array.from(document.querySelectorAll('body *'));
            const heads = all.filter(el =>
                el.children.length <= 4 && /添削完了/.test(el.textContent || '') &&
                !Array.from(el.children).some(c => /添削完了/.test(c.textContent || '')));
            const head = heads.find(h => norm((h.textContent||'').replace('添削完了','')) === label) || heads[0];
            if (!head) return;
            let container = head;
            for (let k = 0; k < 5 && container.parentElement; k++) container = container.parentElement;
            const wantHead = kind === 'add' ? '加点項目' : '減点項目';
            const nodes = Array.from(container.querySelectorAll('*'));
            let mode = '', i = 0;
            for (const n of nodes) {
                const t = norm(n.textContent || '');
                if (n.children.length === 0 && /加点項目/.test(t)) mode = 'add';
                else if (n.children.length === 0 && /減点項目/.test(t)) mode = 'ded';
                if (n.matches && n.matches('input[type=checkbox], [role=checkbox]')) {
                    const cur = (mode === 'add') ? 'add' : (mode === 'ded' ? 'ded' : '');
                    if (cur === kind) {
                        if (i === index) {
                            const checked = n.getAttribute('aria-checked') === 'true' || n.checked;
                            if (!checked) (n.closest('label,li,div') || n).click();
                            return;
                        }
                        i++;
                    }
                }
            }
        }""",
        {"label": section_label, "kind": kind, "index": index},
    )


def _tensakit_mark_done(tpage, section_label: str) -> None:
    """指定セクションの「添削完了」チェックをオンにする。"""
    tpage.evaluate(
        r"""(label) => {
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const all = Array.from(document.querySelectorAll('body *'));
            const heads = all.filter(el =>
                el.children.length <= 4 && /添削完了/.test(el.textContent || '') &&
                !Array.from(el.children).some(c => /添削完了/.test(c.textContent || '')));
            const head = heads.find(h => norm((h.textContent||'').replace('添削完了','')) === label) || heads[0];
            if (!head) return;
            const cb = head.querySelector('input[type=checkbox], [role=checkbox]')
                    || (head.parentElement && head.parentElement.querySelector('input[type=checkbox], [role=checkbox]'));
            if (cb) {
                const checked = cb.getAttribute('aria-checked') === 'true' || cb.checked;
                if (!checked) (cb.closest('label,li,div') || cb).click();
            }
        }""",
        section_label,
    )


def _tensakit_toolbar_click(tpage, which: str) -> bool:
    """上部ツールバーの保存(save)/提出(send)アイコンをクリックする。"""
    aliases = {
        "save": ['button[aria-label*="保存"]', 'button[title*="保存"]',
                 '[aria-label*="save" i]', '[data-testid*="Save" i]',
                 'svg[data-testid="SaveIcon"]', 'button:has(svg[data-testid="SaveIcon"])'],
        "send": ['button[aria-label*="提出"]', 'button[title*="提出"]',
                 'button[aria-label*="送信"]', '[aria-label*="send" i]',
                 'svg[data-testid="SendIcon"]', 'button:has(svg[data-testid="SendIcon"])'],
    }[which]
    for sel in aliases:
        loc = tpage.locator(sel)
        try:
            if loc.count() > 0 and loc.first.is_visible():
                loc.first.click()
                return True
        except Exception:
            continue
    return False


def grade_and_submit_on_tensakit(
    href: str,
    decide_fn,
    submit: bool = False,
    headless: bool = True,
) -> dict:
    """Tensakit 採点画面を開き、AIの判断で加点/減点を選択・コメント入力・添削完了、
    保存し、submit=True なら提出まで行う。

    decide_fn(sections) -> [TensakitSectionDecision 互換の dict/obj] を受け取り、
    どの項目にチェックしコメントを書くかを決める(採点ロジックは呼び出し側=AI)。
    実際の提出(submit=True)は取り消しにくい操作のため、既定では下書き保存のみ。
    """
    from playwright.sync_api import sync_playwright

    user, password = _creds()
    url = os.environ.get("TOSHIN_URL", DEFAULT_URL)
    report = {"sections": 0, "checked": 0, "commented": 0, "saved": False, "submitted": False}
    with sync_playwright() as p:
        browser = _launch_browser(p, headless)
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            try:
                page.wait_for_selector('input[type="password"], table tbody tr', timeout=30000)
            except Exception:
                pass
            _try_login(page, user, password)
            tpage = _open_tensakit_grading(context, page, href, user, password)

            def _shot(name):
                try:
                    tpage.screenshot(path=os.path.join(_DEBUG_DIR, name), full_page=True)
                except Exception:
                    pass

            _shot("tensakit_before.png")
            sections = _scrape_grading_panel(tpage)
            report["sections"] = len(sections)
            # パネル構造を保存(セレクタ調整用)
            try:
                with open(os.path.join(_DEBUG_DIR, "tensakit_page.html"), "w", encoding="utf-8") as fh:
                    fh.write(tpage.content())
            except Exception:
                pass
            if not sections:
                raise ToshinFetchError(
                    "Tensakit の採点パネルを読み取れませんでした。/tensakit-page と /tensakit-html で"
                    "画面構造を確認してください(セレクタ調整が必要な可能性があります)。"
                )

            decisions = decide_fn(sections) or []
            rep2 = _apply_tensakit_decisions(tpage, context, sections, decisions, submit, shot=_shot)
            report.update(rep2)
            return report
        except ToshinFetchError:
            _save_debug(page)
            raise
        except Exception as e:
            _save_debug(page)
            raise ToshinFetchError(f"Tensakit への自動採点・提出に失敗しました: {e}") from e
        finally:
            context.close()
            browser.close()


def _apply_tensakit_decisions(tpage, context, sections, decisions, submit, shot=None) -> dict:
    """AIの判断(decisions)を採点パネルに反映し、保存(・提出)する。共通処理。"""
    report = {"sections": len(sections), "checked": 0, "commented": 0,
              "saved": False, "submitted": False}
    dmap = {}
    for d in decisions or []:
        lab = d["section_label"] if isinstance(d, dict) else d.section_label
        dmap[lab] = d

    for s in sections:
        d = dmap.get(s["section_label"])
        if d is None:
            continue
        add_i = d["add_indices"] if isinstance(d, dict) else d.add_indices
        ded_i = d["deduct_indices"] if isinstance(d, dict) else d.deduct_indices
        # コメントは扱わない方針(使い回し・手動)。互換のため残っていれば使う。
        comment = (d.get("comment") if isinstance(d, dict) else getattr(d, "comment", "")) or ""
        for idx in add_i:
            _tensakit_check_option(tpage, s["section_label"], "add", idx)
            report["checked"] += 1
        for idx in ded_i:
            _tensakit_check_option(tpage, s["section_label"], "ded", idx)
            report["checked"] += 1
        if comment.strip():
            _tensakit_add_comment(tpage, s["section_label"], comment)
            report["commented"] += 1
        _tensakit_mark_done(tpage, s["section_label"])
        tpage.wait_for_timeout(200)

    if shot:
        shot("tensakit_filled.png")
    report["saved"] = _tensakit_toolbar_click(tpage, "save")
    tpage.wait_for_timeout(1500)

    if submit:
        before = set(context.pages)
        if _tensakit_toolbar_click(tpage, "send"):
            tpage.wait_for_timeout(2000)
            for sel in ['button:has-text("提出")', 'button:has-text("送信")',
                        'button:has-text("OK")', 'button:has-text("はい")']:
                loc = tpage.locator(sel)
                try:
                    if loc.count() > 0 and loc.first.is_visible():
                        loc.first.click()
                        break
                except Exception:
                    continue
            tpage.wait_for_timeout(1500)
            report["submitted"] = True
        for pg in list(context.pages):
            if pg not in before and pg != tpage:
                try:
                    pg.close()
                except Exception:
                    pass
    if shot:
        shot("tensakit_after.png")
    return report


def _row_download_button(row, dl_col):
    """行内の答案ダウンロードボタンを特定する(fetch_answers と同じ規則)。"""
    ib = row.locator('button.MuiIconButton-root:not(.Mui-disabled):not([disabled])')
    if ib.count() > 0:
        return ib.first
    if dl_col is not None:
        cell = row.locator("td").nth(dl_col)
        c = cell.locator("button:not([disabled]), a[href]")
        if c.count() > 0:
            return c.first
    return _find_download_control(row)


def batch_grade_on_tensakit(
    max_count: int,
    decide_fn,
    submit: bool = False,
    headless: bool = True,
    progress=None,
) -> List[dict]:
    """東進にログインし、未採点(緑でない)の各答案について、そのまま Tensakit で
    採点(加点/減点チェック・コメント・添削完了・保存、submit=Trueなら提出)する。

    PDF添削は作らず、直接オンライン採点へ入力する。
    decide_fn(pdf_bytes, sections) -> decisions を受け取る(採点判断はAI=呼び出し側)。
    progress(index, total_done, item) はUI更新用の任意コールバック。
    """
    from playwright.sync_api import sync_playwright

    user, password = _creds()
    url = os.environ.get("TOSHIN_URL", DEFAULT_URL)
    results: List[dict] = []
    with sync_playwright() as p:
        browser = _launch_browser(p, headless)
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            try:
                page.wait_for_selector('input[type="password"], table tbody tr', timeout=30000)
            except Exception:
                pass
            _try_login(page, user, password)
            if not _has_answer_table(page):
                if "/correction" not in page.url:
                    try:
                        page.goto(url, wait_until="networkidle", timeout=60000)
                    except Exception:
                        pass
                if not _has_answer_table(page):
                    _follow_grading_app_link(page)
            page.wait_for_selector("table tbody tr", timeout=30000)
            rows = page.locator("table tbody tr")
            total_rows = rows.count()
            if total_rows == 0:
                raise ToshinFetchError("答案一覧に行がありません(未割当の可能性)。")

            dl_col = _download_col_index(page)
            picked = 0
            skipped = 0
            for i in range(total_rows):
                if picked >= max_count:
                    break
                row = rows.nth(i)
                if _is_graded(row):  # 採点済み(緑表示)は対象外
                    skipped += 1
                    continue
                picked += 1
                _close_dialogs(page)
                meta = _row_meta(row)
                item = {"filename": meta.get("exam") or f"answer_{i + 1}",
                        "meta": meta, "status": "grading"}
                if progress:
                    progress(picked - 1, picked, item)
                href = meta.get("tensakit_url")
                try:
                    if not href:
                        raise RuntimeError("この答案には Tensakit リンクがありません")
                    # AI判読用に答案PDFを取得
                    btn = _row_download_button(row, dl_col)
                    if btn is None:
                        raise RuntimeError("答案ダウンロードボタンが見つかりません")
                    _, pdf_bytes = _click_and_get_pdf(page, context, btn, i + 1)
                    _close_dialogs(page)
                    # Tensakit 採点画面を開く
                    tpage = _open_tensakit_grading(context, page, href, user, password)

                    def _shot(name, _i=i):
                        try:
                            tpage.screenshot(
                                path=os.path.join(_DEBUG_DIR, f"tensakit_{_i + 1}_{name}"),
                                full_page=True)
                        except Exception:
                            pass

                    _shot("before.png")
                    # 実際のDOMを保存(採点パネルのセレクタ調整用。/tensakit-html で確認)
                    try:
                        with open(os.path.join(_DEBUG_DIR, "tensakit_page.html"),
                                  "w", encoding="utf-8") as fh:
                            fh.write(tpage.content())
                        tpage.screenshot(path=os.path.join(_DEBUG_DIR, "tensakit_page.png"),
                                         full_page=True)
                    except Exception:
                        pass
                    sections = _scrape_grading_panel(tpage)
                    if not sections:
                        raise RuntimeError(
                            "採点パネルを読み取れませんでした(/tensakit-html で画面構造を確認できます)")
                    decisions = decide_fn(pdf_bytes, sections)
                    rep = _apply_tensakit_decisions(
                        tpage, context, sections, decisions, submit, shot=_shot)
                    item.update(status="done", report=rep, tensakit_url=href)
                    try:
                        tpage.close()
                    except Exception:
                        pass
                except Exception as e:
                    item.update(status="error", error=str(e))
                results.append(item)
                if progress:
                    progress(picked - 1, picked, item)

            if picked == 0 and skipped > 0:
                raise ToshinFetchError(
                    f"未採点の答案がありませんでした(採点済み {skipped} 件は緑表示のため対象外)。"
                )
            return results
        except ToshinFetchError:
            _save_debug(page)
            raise
        except Exception as e:
            _save_debug(page)
            raise ToshinFetchError(f"Tensakit 一括採点に失敗しました: {e}") from e
        finally:
            context.close()
            browser.close()


def _tensakit_add_comment(tpage, section_label: str, comment: str) -> None:
    """指定セクションの「T」(テキスト)ボタンからコメントを入力する。

    Tensakit は各セクションに「T」ボタンがあり、押すとコメント入力欄が出る。
    入力後、可能なら保存/確定ボタンを押す(無ければ入力のみ)。
    """
    # セクション見出し近傍の「T」ボタンを押す
    pressed = tpage.evaluate(
        r"""(label) => {
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const all = Array.from(document.querySelectorAll('body *'));
            const heads = all.filter(el =>
                el.children.length <= 4 && /添削完了/.test(el.textContent || '') &&
                !Array.from(el.children).some(c => /添削完了/.test(c.textContent || '')));
            const head = heads.find(h => norm((h.textContent||'').replace('添削完了','')) === label) || heads[0];
            if (!head) return false;
            let container = head;
            for (let k = 0; k < 5 && container.parentElement; k++) container = container.parentElement;
            // 「T」だけのボタン/要素を探す
            const cand = Array.from(container.querySelectorAll('button, [role=button]'))
                .find(b => norm(b.textContent) === 'T'
                    || (b.getAttribute('aria-label')||'').match(/text|コメント|テキスト/i));
            if (cand) { cand.click(); return true; }
            return false;
        }""",
        section_label,
    )
    if not pressed:
        return
    tpage.wait_for_timeout(400)
    # 出てきた入力欄にコメントを入れる
    for sel in ['textarea:visible', 'input[type="text"]:visible',
                '[contenteditable="true"]:visible']:
        loc = tpage.locator(sel)
        try:
            if loc.count() > 0 and loc.last.is_visible():
                loc.last.click()
                loc.last.fill(comment)
                break
        except Exception:
            continue
    # 確定ボタン(保存/OK/追加)があれば押す
    for sel in ['button:has-text("保存")', 'button:has-text("追加")',
                'button:has-text("OK")', 'button:has-text("確定")']:
        loc = tpage.locator(sel)
        try:
            if loc.count() > 0 and loc.last.is_visible():
                loc.last.click()
                break
        except Exception:
            continue


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


def fetch_answers(max_count: int = 100, headless: bool = True) -> List[FetchedAnswer]:
    """東進添削システムにログインし、一覧の各行から答案PDFをダウンロードする。"""
    from playwright.sync_api import sync_playwright

    user, password = _creds()
    url = os.environ.get("TOSHIN_URL", DEFAULT_URL)
    fetched: List[FetchedAnswer] = []

    with sync_playwright() as p:
        browser = _launch_browser(p, headless)
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
            total_rows = rows.count()
            if total_rows == 0:
                raise ToshinFetchError("答案一覧に行がありません(未割当の可能性)。")

            dl_col = _download_col_index(page)
            list_dumped = False
            picked = 0       # 実際に採点対象とした(未採点の)件数
            skipped = 0      # 採点済み(緑表示)でスキップした件数
            for i in range(total_rows):
                if picked >= max_count:
                    break
                row = rows.nth(i)
                # 採点済み(緑で表示されている)答案は対象から除外する
                if _is_graded(row):
                    skipped += 1
                    continue
                picked += 1
                # 直前の行のダウンロードで開いたダイアログが残っていると
                # 次のボタンを覆ってクリックできないので、先に閉じる
                _close_dialogs(page)
                meta = _row_meta(row)
                # 答案DLは行内の「有効なアイコンボタン」で特定する。
                # (採点基準=テキストボタン、点数入力=無効アイコンボタン、と区別できる)
                btn = None
                ib = row.locator(
                    'button.MuiIconButton-root:not(.Mui-disabled):not([disabled])'
                )
                if ib.count() > 0:
                    btn = ib.first
                if btn is None and dl_col is not None:  # フォールバック: 答案列セル
                    cell = row.locator("td").nth(dl_col)
                    c = cell.locator("button:not([disabled]), a[href]")
                    if c.count() > 0:
                        btn = c.first
                if btn is None:
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
            if picked == 0 and skipped > 0:
                raise ToshinFetchError(
                    f"未採点の答案がありませんでした(採点済み {skipped} 件は"
                    "緑表示のため対象外にしました)。"
                )
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
