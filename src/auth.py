"""Login and session management for toshin-correction.com."""

import os
from playwright.sync_api import Page, BrowserContext

LOGIN_URL = "https://www.toshin-correction.com/login"

# Selectors confirmed from DevTools inspection
SEL_USERNAME = '#uid'
SEL_PASSWORD = 'input[type="password"]'
SEL_SUBMIT   = 'button:has-text("ログイン")'
SEL_ERROR    = '[class*="error"], [class*="Error"]'


def login(page: Page) -> None:
    """Navigate to login page and authenticate. Raises on failure."""
    username = os.environ["TOSHIN_USERNAME"]
    password = os.environ["TOSHIN_PASSWORD"]

    page.goto(LOGIN_URL, wait_until="networkidle")

    # Click first to focus MUI inputs, then fill
    page.click(SEL_USERNAME)
    page.fill(SEL_USERNAME, username)

    page.click(SEL_PASSWORD)
    page.fill(SEL_PASSWORD, password)

    page.click(SEL_SUBMIT)
    page.wait_for_load_state("networkidle")

    if page.url == LOGIN_URL:
        error_text = ""
        el = page.query_selector(SEL_ERROR)
        if el:
            error_text = el.inner_text()
        raise RuntimeError(f"Login failed: {error_text or 'still on login page'}")

    print(f"[auth] Logged in. Current URL: {page.url}")
