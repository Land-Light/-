"""Login and session management for toshin-correction.com."""

import os
from playwright.async_api import Page

LOGIN_URL = "https://www.toshin-correction.com/login"

SEL_USERNAME = '#uid'
SEL_PASSWORD = 'input[type="password"]'
SEL_SUBMIT   = 'button:has-text("ログイン")'
SEL_ERROR    = '[class*="error"], [class*="Error"]'


async def login(page: Page) -> None:
    username = os.environ["TOSHIN_USERNAME"]
    password = os.environ["TOSHIN_PASSWORD"]

    await page.goto(LOGIN_URL, wait_until="networkidle")

    await page.click(SEL_USERNAME)
    await page.fill(SEL_USERNAME, username)
    await page.click(SEL_PASSWORD)
    await page.fill(SEL_PASSWORD, password)
    await page.click(SEL_SUBMIT)
    await page.wait_for_load_state("networkidle")

    if page.url == LOGIN_URL:
        error_text = ""
        el = await page.query_selector(SEL_ERROR)
        if el:
            error_text = await el.inner_text()
        raise RuntimeError(f"Login failed: {error_text or 'still on login page'}")

    print(f"[auth] Logged in. Current URL: {page.url}")
