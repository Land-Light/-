"""Fetch grading criteria and task list from toshin-correction.com."""

from dataclasses import dataclass, field
from typing import Optional
from playwright.sync_api import Page

# --- Selectors (update after inspecting the actual page) ---
# Task list page
TASKS_URL    = "https://www.toshin-correction.com/tasks"   # adjust to real URL
SEL_TASK_ROW = ".task-item, tr.task, [class*='task-row']"  # each task entry
SEL_TASK_LINK = "a"                                         # link inside task row

# Grading criteria section inside a task page
SEL_CRITERIA_SECTION = ".criteria, .grading-criteria, [class*='criteria']"
SEL_CRITERIA_ITEM    = "li, .criteria-item"

# Answer / submission area
SEL_ANSWER_AREA = ".answer, .student-answer, [class*='answer']"
# -----------------------------------------------------------


@dataclass
class Task:
    title: str
    url: str
    criteria: list[str] = field(default_factory=list)
    answer_text: Optional[str] = None


def fetch_task_list(page: Page) -> list[Task]:
    """Return all pending tasks from the task list page."""
    page.goto(TASKS_URL, wait_until="networkidle")

    tasks: list[Task] = []
    rows = page.query_selector_all(SEL_TASK_ROW)

    if not rows:
        print("[scraper] No task rows found — check SEL_TASK_ROW selector")
        return tasks

    for row in rows:
        link_el = row.query_selector(SEL_TASK_LINK)
        if not link_el:
            continue
        title = link_el.inner_text().strip()
        href  = link_el.get_attribute("href") or ""
        url   = _abs_url(href)
        tasks.append(Task(title=title, url=url))

    print(f"[scraper] Found {len(tasks)} task(s)")
    return tasks


def fetch_task_detail(page: Page, task: Task) -> Task:
    """Navigate to task page and populate criteria + answer."""
    page.goto(task.url, wait_until="networkidle")

    # Grading criteria
    criteria_section = page.query_selector(SEL_CRITERIA_SECTION)
    if criteria_section:
        items = criteria_section.query_selector_all(SEL_CRITERIA_ITEM)
        task.criteria = [el.inner_text().strip() for el in items if el.inner_text().strip()]
    else:
        print(f"[scraper] No criteria section found for: {task.title}")

    # Student answer
    answer_el = page.query_selector(SEL_ANSWER_AREA)
    if answer_el:
        task.answer_text = answer_el.inner_text().strip()

    return task


def _abs_url(href: str) -> str:
    base = "https://www.toshin-correction.com"
    if href.startswith("http"):
        return href
    return base + href if href.startswith("/") else base + "/" + href
