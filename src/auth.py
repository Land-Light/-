"""Login and session management for toshin-correction.com."""

import os
from playwright.sync_api import Page, BrowserContext

LOGIN_URL = "https://www.toshin-correction.com/login"

# --- Selectors (update after inspecting the actual page) ---
SEL_USERNAME = 'input[name="username"], input[name="login_id"], input[id="username"]'
SEL_PASSWORD = 'input[type="password"]'
SEL_SUBMIT   = 'button[type="submit"], input[type="submit"]'
SEL_ERROR    = '.error, .alert-danger, [class*="error"]'
# -----------------------------------------------------------


def login(page: Page) -> None:
    """Navigate to login page and authenticate. Raises on failure."""
    username = os.environ["TOSHIN_USERNAME"]
    password = os.environ["TOSHIN_PASSWORD"]

    page.goto(LOGIN_URL, wait_until="networkidle")

    page.fill(SEL_USERNAME, username)
    page.fill(SEL_PASSWORD, password)
    page.click(SEL_SUBMIT)

    page.wait_for_load_state("networkidle")

    if page.url == LOGIN_URL or page.query_selector(SEL_ERROR):
        error_text = ""
        el = page.query_selector(SEL_ERROR)
        if el:
            error_text = el.inner_text()
        raise RuntimeError(f"Login failed: {error_text or 'still on login page'}")

    print(f"[auth] Logged in. Current URL: {page.url}")
