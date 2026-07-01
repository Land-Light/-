"""Configuration for the Kindle auto-scroll -> PDF capture pipeline.

All tunable parameters live here so behaviour can be adjusted from the GUI,
the CLI, or a saved JSON profile without touching the capture logic.

The defaults are chosen to balance the two priorities of this project:

* accuracy (精度):  only fully-rendered pages are captured, images are stored
  losslessly, and the end of the book is detected automatically;
* speed (作業速度): captures use short adaptive settle delays and cheap
  down-scaled comparisons so the run finishes as fast as the reader allows.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional, Tuple


@dataclass
class Region:
    """A screen rectangle to capture, in pixels (absolute desktop coords)."""

    left: int = 0
    top: int = 0
    width: int = 0
    height: int = 0

    @property
    def is_valid(self) -> bool:
        return self.width > 0 and self.height > 0

    def as_tuple(self) -> Tuple[int, int, int, int]:
        return (self.left, self.top, self.width, self.height)

    def as_mss_dict(self) -> dict:
        return {"left": self.left, "top": self.top,
                "width": self.width, "height": self.height}


@dataclass
class CaptureConfig:
    """Everything that controls a capture session."""

    # --- What to capture -------------------------------------------------
    region: Region = field(default_factory=Region)

    # --- How to turn the page -------------------------------------------
    # method: "key" (send a keystroke) or "click" (click a fixed point).
    turn_method: str = "key"
    turn_key: str = "right"            # right / left / pagedown / space ...
    click_point: Optional[Tuple[int, int]] = None  # for turn_method == "click"

    # --- Timing (speed) --------------------------------------------------
    max_pages: int = 2000              # hard safety cap
    page_settle: float = 0.12          # min pause after a page turn (s)
    stabilize_interval: float = 0.03   # gap between stability probes (s)
    stabilize_timeout: float = 1.50    # give up waiting for a stable frame (s)

    # --- Accuracy thresholds --------------------------------------------
    # Frames are compared on a small grayscale thumbnail; values are the
    # mean absolute difference (0..255) of that thumbnail.
    compare_size: int = 64             # thumbnail edge length for diffing
    stable_threshold: float = 1.0      # <= this => page finished rendering
    duplicate_threshold: float = 0.8   # <= this => same page as before
    end_after_duplicates: int = 2      # consecutive dups => end of book

    # --- Output ----------------------------------------------------------
    output_pdf: str = "kindle_book.pdf"
    keep_images: bool = False          # keep the intermediate PNGs
    image_dir: Optional[str] = None    # where PNGs go (temp dir if None)
    autocrop: bool = True              # trim uniform margins for a clean scan
    autocrop_tolerance: int = 12       # 0..255, how "uniform" a margin must be
    autocrop_pad: int = 4              # pixels of margin to leave after cropping
    ocr: bool = False                  # add a searchable text layer (ocrmypdf)
    ocr_language: str = "jpn+eng"      # tesseract language spec

    # --- Countdown before the run starts so the user can focus Kindle ----
    start_delay: float = 4.0

    def validate(self) -> None:
        if not self.region.is_valid:
            raise ValueError("capture region is not set (width/height must be > 0)")
        if self.turn_method not in ("key", "click"):
            raise ValueError(f"unknown turn_method: {self.turn_method!r}")
        if self.turn_method == "click" and not self.click_point:
            raise ValueError("turn_method 'click' requires click_point")
        if self.max_pages <= 0:
            raise ValueError("max_pages must be positive")

    # --- Persistence -----------------------------------------------------
    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, ensure_ascii=False)

    def save(self, path: str | Path) -> None:
        Path(path).write_text(self.to_json(), encoding="utf-8")

    @classmethod
    def from_dict(cls, data: dict) -> "CaptureConfig":
        data = dict(data)
        region = data.pop("region", {}) or {}
        cfg = cls(**data)
        cfg.region = Region(**region)
        if cfg.click_point is not None:
            cfg.click_point = tuple(cfg.click_point)  # JSON gives a list
        return cfg

    @classmethod
    def load(cls, path: str | Path) -> "CaptureConfig":
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))
