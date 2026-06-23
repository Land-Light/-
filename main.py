#!/usr/bin/env python3
"""
toshin-correction.com 自動採点ツール

使い方:
  1. .env ファイルを作成して認証情報を設定
  2. python main.py --mode inspect   # セレクタ確認用 (最初に実行)
  3. python main.py --mode list      # タスク一覧の取得
  4. python main.py --mode grade     # 採点の実行
"""

import argparse
import os
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

from src.auth import login
from src.scraper import fetch_task_list, fetch_task_detail
from src.grader import grade_task
from src.inspector import dump_page

load_dotenv()


def _make_browser(playwright):
    browser = playwright.chromium.launch(headless=False)  # headless=True で非表示
    context = browser.new_context(ignore_https_errors=True)
    return browser, context


def cmd_inspect(page) -> None:
    """ログイン後のページ構造を JSON に書き出す。"""
    login(page)
    print("[main] ログインページ後の構造を保存します...")
    dump_page(page, "login_page_dump.json")

    # タスク一覧ページも調査
    from src.scraper import TASKS_URL
    page.goto(TASKS_URL, wait_until="networkidle")
    dump_page(page, "tasks_page_dump.json")
    print("[main] tasks_page_dump.json を確認してセレクタを更新してください")


def cmd_list(page) -> None:
    """タスク一覧と採点基準を表示する。"""
    login(page)
    tasks = fetch_task_list(page)

    for i, task in enumerate(tasks, 1):
        task = fetch_task_detail(page, task)
        print(f"\n--- タスク {i}: {task.title} ---")
        print(f"  URL: {task.url}")
        if task.criteria:
            print("  採点基準:")
            for c in task.criteria:
                print(f"    - {c}")
        if task.answer_text:
            print(f"  回答 (先頭 200文字): {task.answer_text[:200]}")


def cmd_grade(page) -> None:
    """全タスクを採点する (採点基準を表示して確認を求める)。"""
    login(page)
    tasks = fetch_task_list(page)

    for task in tasks:
        task = fetch_task_detail(page, task)

        print(f"\n=== {task.title} ===")
        print("採点基準:")
        for c in task.criteria:
            print(f"  - {c}")
        if task.answer_text:
            print(f"回答:\n{task.answer_text[:500]}\n")

        score_str = input("スコアを入力 (スキップ: Enter): ").strip()
        if not score_str:
            print("スキップ")
            continue

        comment = input("コメントを入力: ").strip()

        try:
            success = grade_task(page, task, int(score_str), comment)
            print("採点完了" if success else "採点失敗 (手動で確認してください)")
        except Exception as e:
            print(f"エラー: {e}")


def main():
    parser = argparse.ArgumentParser(description="toshin-correction 自動採点ツール")
    parser.add_argument(
        "--mode",
        choices=["inspect", "list", "grade"],
        default="inspect",
        help="実行モード (default: inspect)",
    )
    args = parser.parse_args()

    if not os.environ.get("TOSHIN_USERNAME") or not os.environ.get("TOSHIN_PASSWORD"):
        print("エラー: .env ファイルに TOSHIN_USERNAME と TOSHIN_PASSWORD を設定してください")
        raise SystemExit(1)

    with sync_playwright() as p:
        browser, context = _make_browser(p)
        page = context.new_page()
        try:
            if args.mode == "inspect":
                cmd_inspect(page)
            elif args.mode == "list":
                cmd_list(page)
            elif args.mode == "grade":
                cmd_grade(page)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
