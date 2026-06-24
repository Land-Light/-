"""Perform grading actions on a task page."""

from playwright.async_api import Page
from .scraper import Task

SEL_SCORE_INPUT   = 'input[name="score"], input[id="score"]'
SEL_COMMENT_AREA  = 'textarea[name="comment"], textarea[id="comment"]'
SEL_SUBMIT_BUTTON = 'button[type="submit"], button:has-text("採点"), button:has-text("送信")'
SEL_SUCCESS_MSG   = '.success, .alert-success, [class*="success"]'


async def grade_task(page: Page, task: Task, score: int, comment: str) -> bool:
    await page.goto(task.url, wait_until="networkidle")

    score_el = await page.query_selector(SEL_SCORE_INPUT)
    if score_el:
        await score_el.fill(str(score))
    else:
        print(f"[grader] Score input not found for: {task.title}")

    comment_el = await page.query_selector(SEL_COMMENT_AREA)
    if comment_el:
        await comment_el.fill(comment)
    else:
        print(f"[grader] Comment area not found for: {task.title}")

    submit_el = await page.query_selector(SEL_SUBMIT_BUTTON)
    if not submit_el:
        print(f"[grader] Submit button not found for: {task.title}")
        return False

    await submit_el.click()
    await page.wait_for_load_state("networkidle")

    success = await page.query_selector(SEL_SUCCESS_MSG) is not None
    print(f"[grader] {'OK' if success else 'FAILED'}: {task.title}")
    return success
