"""Helper to dump page structure — run this first to find correct selectors."""

from playwright.sync_api import Page
import json


def dump_page(page: Page, output_path: str = "page_dump.json") -> None:
    """Save all interactive elements and their attributes to a JSON file."""
    elements = []

    for tag in ["input", "textarea", "button", "a", "select", "form"]:
        els = page.query_selector_all(tag)
        for el in els:
            try:
                info = {
                    "tag": tag,
                    "id":    el.get_attribute("id"),
                    "name":  el.get_attribute("name"),
                    "type":  el.get_attribute("type"),
                    "class": el.get_attribute("class"),
                    "href":  el.get_attribute("href"),
                    "text":  el.inner_text()[:80].strip() if tag in ("button", "a") else None,
                }
                elements.append({k: v for k, v in info.items() if v is not None})
            except Exception:
                pass

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(elements, f, ensure_ascii=False, indent=2)

    print(f"[inspector] Saved {len(elements)} elements to {output_path}")
    print(json.dumps(elements, ensure_ascii=False, indent=2))
