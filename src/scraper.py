"""Fetch grading criteria and task list from toshin-correction.com."""

from dataclasses import dataclass, field
from typing import Optional
from playwright.async_api import Page

TASKS_URL    = "https://www.toshin-correction.com/correction"
SEL_TASK_ROW = ".task-item, tr.task, [class*='task-row']"
SEL_TASK_LINK = "a"
SEL_CRITERIA_SECTION = ".criteria, .grading-criteria, [class*='criteria']"
SEL_CRITERIA_ITEM    = "li, .criteria-item"
SEL_ANSWER_AREA = ".answer, .student-answer, [class*='answer']"


@dataclass
class Task:
    title: str
    url: str
    criteria: list[str] = field(default_factory=list)
    answer_text: Optional[str] = None


async def fetch_task_list(page: Page) -> list[Task]:
    await page.goto(TASKS_URL, wait_until="networkidle")
    tasks: list[Task] = []
    rows = await page.query_selector_all(SEL_TASK_ROW)
    if not rows:
        print("[scraper] No task rows found — check SEL_TASK_ROW selector")
        return tasks
    for row in rows:
        link_el = await row.query_selector(SEL_TASK_LINK)
        if not link_el:
            continue
        title = (await link_el.inner_text()).strip()
        href  = await link_el.get_attribute("href") or ""
        tasks.append(Task(title=title, url=_abs_url(href)))
    print(f"[scraper] Found {len(tasks)} task(s)")
    return tasks


async def fetch_task_detail(page: Page, task: Task) -> Task:
    await page.goto(task.url, wait_until="networkidle")
    criteria_section = await page.query_selector(SEL_CRITERIA_SECTION)
    if criteria_section:
        items = await criteria_section.query_selector_all(SEL_CRITERIA_ITEM)
        task.criteria = [
            (await el.inner_text()).strip()
            for el in items
            if (await el.inner_text()).strip()
        ]
    answer_el = await page.query_selector(SEL_ANSWER_AREA)
    if answer_el:
        task.answer_text = (await answer_el.inner_text()).strip()
    return task


def _abs_url(href: str) -> str:
    base = "https://www.toshin-correction.com"
    if href.startswith("http"):
        return href
    return base + href if href.startswith("/") else base + "/" + href
