#!/usr/bin/env python3
"""
toshin-correction.com dedicated browser

Usage:
  python browser.py
"""

import asyncio
import os
import json
from dotenv import load_dotenv
from playwright.async_api import async_playwright, Page

from src.auth import login, LOGIN_URL
from src.scraper import fetch_task_list, fetch_task_detail, TASKS_URL
from src.grader import grade_task

load_dotenv()

OVERLAY_JS = """
(function() {
  if (document.getElementById('__toshin_panel__')) return;

  const panel = document.createElement('div');
  panel.id = '__toshin_panel__';
  panel.innerHTML = `
    <div id="__tp_header__">Grading Tool</div>
    <button id="__tp_login__">Login</button>
    <button id="__tp_list__">Task List</button>
    <button id="__tp_grade__">Start Grading</button>
    <div id="__tp_status__">Ready</div>
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


async def set_status(page: Page, msg: str) -> None:
    try:
        await page.evaluate(
            "m => { const el = document.getElementById('__tp_status__'); if(el) el.textContent = m; }",
            msg
        )
    except Exception:
        pass


async def set_buttons_enabled(page: Page, enabled: bool) -> None:
    try:
        await page.evaluate(
            "e => ['__tp_login__','__tp_list__','__tp_grade__'].forEach(id => { const el = document.getElementById(id); if(el) el.disabled = !e; })",
            enabled
        )
    except Exception:
        pass


async def inject_panel(page: Page) -> None:
    try:
        await page.evaluate(OVERLAY_JS)
    except Exception:
        pass


async def handle_action(page: Page, action: str) -> None:
    await set_buttons_enabled(page, False)
    try:
        if action == "login":
            await set_status(page, "Logging in...")
            await login(page)
            await inject_panel(page)
            await set_status(page, "Login OK")

        elif action == "list":
            await set_status(page, "Fetching tasks...")
            tasks = await fetch_task_list(page)
            if not tasks:
                await set_status(page, "No tasks found")
                return
            for i, task in enumerate(tasks, 1):
                task = await fetch_task_detail(page, task)
                print(f"\n--- Task {i}: {task.title} ---")
                print(f"  URL: {task.url}")
                for c in task.criteria:
                    print(f"  Criteria: {c}")
            await inject_panel(page)
            await set_status(page, f"{len(tasks)} tasks loaded")

        elif action == "grade":
            await set_status(page, "Loading tasks...")
            tasks = await fetch_task_list(page)
            done = 0
            for task in tasks:
                task = await fetch_task_detail(page, task)
                await set_status(page, f"Grading: {task.title[:20]}...")
                print(f"\n=== {task.title} ===")
                for c in task.criteria:
                    print(f"  Criteria: {c}")
                if task.answer_text:
                    print(f"  Answer: {task.answer_text[:300]}")
                score_str = input("Score (Enter to skip): ").strip()
                if not score_str:
                    continue
                comment = input("Comment: ").strip()
                await grade_task(page, task, int(score_str), comment)
                done += 1
            await inject_panel(page)
            await set_status(page, f"{done} graded")

    except Exception as e:
        await set_status(page, f"Error: {str(e)[:40]}")
        print(f"[ERROR] {e}")
    finally:
        await set_buttons_enabled(page, True)


async def main() -> None:
    username = os.environ.get("TOSHIN_USERNAME")
    password = os.environ.get("TOSHIN_PASSWORD")
    if not username or not password:
        print("Error: set TOSHIN_USERNAME / TOSHIN_PASSWORD in .env")
        raise SystemExit(1)

    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(
            user_data_dir="./browser_profile",
            headless=False,
            ignore_https_errors=True,
            viewport={"width": 1280, "height": 800},
            args=["--window-size=1280,800"],
        )

        page = context.pages[0] if context.pages else await context.new_page()

        async def on_load(p):
            await inject_panel(p)

        page.on("load", lambda: asyncio.create_task(on_load(page)))

        async def on_action(action: str) -> None:
            await handle_action(page, action)

        await page.expose_function("__tp_action__", on_action)

        await page.goto(LOGIN_URL, wait_until="domcontentloaded")
        await inject_panel(page)

        print("Browser started. Use the panel at bottom-right.")
        print("Close the window to exit.")

        await context.wait_for_event("close", timeout=0)


if __name__ == "__main__":
    asyncio.run(main())
