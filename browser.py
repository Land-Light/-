#!/usr/bin/env python3
"""
toshin-correction 専用ブラウザ

実行:
  python browser.py

起動すると Chromium が開き、画面右下に操作パネルが表示されます。
"""

import os
import json
import threading
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright, Page

from src.auth import login, LOGIN_URL
from src.scraper import fetch_task_list, fetch_task_detail, TASKS_URL
from src.grader import grade_task

load_dotenv()

# ページに注入するフローティング操作パネル (HTML + CSS + JS)
OVERLAY_JS = """
(function() {
  if (document.getElementById('__toshin_panel__')) return;

  const panel = document.createElement('div');
  panel.id = '__toshin_panel__';
  panel.innerHTML = `
    <div id="__tp_header__">採点ツール</div>
    <button id="__tp_login__">🔐 ログイン</button>
    <button id="__tp_list__">📋 タスク一覧</button>
    <button id="__tp_grade__">✅ 採点開始</button>
    <div id="__tp_status__">準備完了</div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    #__toshin_panel__ {
      position: fixed; bottom: 20px; right: 20px; z-index: 999999;
      background: #1a1a2e; color: #eee; border-radius: 12px;
      padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5); min-width: 150px;
      font-family: sans-serif; font-size: 13px;
    }
    #__tp_header__ {
      font-weight: bold; font-size: 14px; text-align: center;
      color: #a8d8ea; padding-bottom: 4px;
      border-bottom: 1px solid #333;
    }
    #__toshin_panel__ button {
      background: #16213e; color: #eee; border: 1px solid #0f3460;
      border-radius: 8px; padding: 7px 10px; cursor: pointer;
      text-align: left; transition: background 0.2s;
    }
    #__toshin_panel__ button:hover { background: #0f3460; }
    #__toshin_panel__ button:disabled { opacity: 0.4; cursor: not-allowed; }
    #__tp_status__ {
      font-size: 11px; color: #aaa; text-align: center;
      min-height: 16px; word-break: break-all;
    }
  `;

  document.head.appendChild(style);
  document.body.appendChild(panel);

  document.getElementById('__tp_login__').onclick  = () => window.__tp_action__('login');
  document.getElementById('__tp_list__').onclick   = () => window.__tp_action__('list');
  document.getElementById('__tp_grade__').onclick  = () => window.__tp_action__('grade');
})();
"""


def set_status(page: Page, msg: str) -> None:
    try:
        page.evaluate(f"document.getElementById('__tp_status__') && (document.getElementById('__tp_status__').textContent = {json.dumps(msg)})")
    except Exception:
        pass


def set_buttons_enabled(page: Page, enabled: bool) -> None:
    val = "false" if not enabled else "true"
    try:
        page.evaluate(f"""
            ['__tp_login__','__tp_list__','__tp_grade__'].forEach(id => {{
                const el = document.getElementById(id);
                if (el) el.disabled = !{val};
            }});
        """)
    except Exception:
        pass


def handle_action(page: Page, action: str) -> None:
    """各ボタンのアクションを別スレッドで実行する。"""
    set_buttons_enabled(page, False)

    try:
        if action == "login":
            set_status(page, "ログイン中...")
            login(page)
            set_status(page, "ログイン完了")

        elif action == "list":
            set_status(page, "タスク取得中...")
            tasks = fetch_task_list(page)
            if not tasks:
                set_status(page, "タスクなし")
                return
            for i, task in enumerate(tasks, 1):
                task = fetch_task_detail(page, task)
                print(f"\n--- タスク {i}: {task.title} ---")
                print(f"  URL: {task.url}")
                for c in task.criteria:
                    print(f"  基準: {c}")
            set_status(page, f"{len(tasks)} 件取得済み")

        elif action == "grade":
            set_status(page, "採点中...")
            tasks = fetch_task_list(page)
            done = 0
            for task in tasks:
                task = fetch_task_detail(page, task)
                set_status(page, f"採点: {task.title[:20]}...")

                # コンソールにスコア入力を促す (GUI拡張は後で対応)
                print(f"\n=== {task.title} ===")
                for c in task.criteria:
                    print(f"  基準: {c}")
                if task.answer_text:
                    print(f"  回答: {task.answer_text[:300]}")

                score_str = input("スコア入力 (スキップ: Enter): ").strip()
                if not score_str:
                    continue
                comment = input("コメント: ").strip()
                grade_task(page, task, int(score_str), comment)
                done += 1

            set_status(page, f"{done} 件採点完了")

    except Exception as e:
        set_status(page, f"エラー: {str(e)[:40]}")
        print(f"[エラー] {e}")
    finally:
        set_buttons_enabled(page, True)


def main() -> None:
    username = os.environ.get("TOSHIN_USERNAME")
    password = os.environ.get("TOSHIN_PASSWORD")
    if not username or not password:
        print("エラー: .env に TOSHIN_USERNAME / TOSHIN_PASSWORD を設定してください")
        raise SystemExit(1)

    with sync_playwright() as p:
        # 永続コンテキスト: セッションをローカルに保存して再利用
        context = p.chromium.launch_persistent_context(
            user_data_dir="./browser_profile",
            headless=False,
            ignore_https_errors=True,
            viewport={"width": 1280, "height": 800},
            args=["--window-size=1280,800"],
        )

        page = context.pages[0] if context.pages else context.new_page()

        # 全ページ遷移後にパネルを再注入
        def inject_panel(p):
            try:
                p.evaluate(OVERLAY_JS)
            except Exception:
                pass

        page.on("load", lambda: inject_panel(page))

        # Python 関数をページから呼び出せるようにブリッジ登録
        def on_action(action: str) -> None:
            threading.Thread(target=handle_action, args=(page, action), daemon=True).start()

        page.expose_function("__tp_action__", on_action)

        # 最初にログインページへ
        page.goto(LOGIN_URL, wait_until="domcontentloaded")
        inject_panel(page)

        print("ブラウザを起動しました。右下のパネルから操作してください。")
        print("ウィンドウを閉じると終了します。")

        # ウィンドウが閉じられるまで待機
        context.wait_for_event("close", timeout=0)


if __name__ == "__main__":
    main()
