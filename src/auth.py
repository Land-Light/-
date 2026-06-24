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

    # Use triple-click + type for MUI/React inputs to ensure events fire
    uid = page.locator('#uid')
    await uid.click()
    await uid.triple_click()
    await uid.type(username, delay=50)

    pwd = page.locator('input[type="password"]')
    await pwd.click()
    await pwd.triple_click()
    await pwd.type(password, delay=50)

    await page.locator(SEL_SUBMIT).click()
    await page.wait_for_load_state("networkidle")

    if page.url == LOGIN_URL:
        error_text = ""
        el = await page.query_selector(SEL_ERROR)
        if el:
            error_text = await el.inner_text()
        raise RuntimeError(f"Login failed: {error_text or 'still on login page'}")

    print(f"[auth] Logged in. Current URL: {page.url}")
