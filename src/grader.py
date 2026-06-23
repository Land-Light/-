"""Perform grading actions on a task page."""

from playwright.sync_api import Page
from .scraper import Task

# --- Selectors (update after inspecting the actual page) ---
SEL_SCORE_INPUT   = 'input[name="score"], input[id="score"]'
SEL_COMMENT_AREA  = 'textarea[name="comment"], textarea[id="comment"]'
SEL_SUBMIT_BUTTON = 'button[type="submit"], input[type="submit"], button:has-text("採点"), button:has-text("送信")'
SEL_SUCCESS_MSG   = '.success, .alert-success, [class*="success"]'
# -----------------------------------------------------------


def grade_task(page: Page, task: Task, score: int, comment: str) -> bool:
    """
    Submit a score and comment for the given task.

    Returns True if submission succeeded, False otherwise.
    """
    page.goto(task.url, wait_until="networkidle")

    score_el = page.query_selector(SEL_SCORE_INPUT)
    if score_el:
        score_el.fill(str(score))
    else:
        print(f"[grader] Score input not found for: {task.title}")

    comment_el = page.query_selector(SEL_COMMENT_AREA)
    if comment_el:
        comment_el.fill(comment)
    else:
        print(f"[grader] Comment area not found for: {task.title}")

    submit_el = page.query_selector(SEL_SUBMIT_BUTTON)
    if not submit_el:
        print(f"[grader] Submit button not found for: {task.title}")
        return False

    submit_el.click()
    page.wait_for_load_state("networkidle")

    success = page.query_selector(SEL_SUCCESS_MSG) is not None
    if success:
        print(f"[grader] Graded OK: {task.title}")
    else:
        print(f"[grader] Submit may have failed for: {task.title}")

    return success
