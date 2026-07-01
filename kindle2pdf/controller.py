"""The capture controller: the loop that reads a whole book.

Responsibilities:

1. For each page, wait until the reader has *finished* rendering it, then
   grab a full-resolution frame (accuracy — never a mid-flip frame).
2. Detect when a page turn stops changing anything and stop (end of book).
3. Save every unique page as a lossless PNG.
4. Hand the PNGs to the PDF builder.

Screen capture and page turning are injected as ``Capturer`` / ``PageTurner``
objects, so the entire loop can be exercised in tests with fakes — no display
required.
"""

from __future__ import annotations

import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Optional

from .capture import Capturer
from .config import CaptureConfig
from .image_ops import to_thumb
from .page_turn import PageTurner
from .pdf_builder import add_ocr_layer, build_pdf, ocr_available, preprocess_images
from .stability import EndDetector, StableFrameWaiter


@dataclass
class CaptureResult:
    pages_captured: int
    output_pdf: Optional[Path]
    image_paths: List[Path] = field(default_factory=list)
    stopped_early: bool = False
    reached_end: bool = False
    ocr_applied: bool = False
    message: str = ""


# progress(page_index, note) -> None
ProgressCallback = Callable[[int, str], None]


class CaptureController:
    def __init__(
        self,
        config: CaptureConfig,
        capturer: Capturer,
        turner: PageTurner,
        *,
        progress: Optional[ProgressCallback] = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        config.validate()
        self.cfg = config
        self.capturer = capturer
        self.turner = turner
        self._progress = progress or (lambda i, note: None)
        self._clock = clock
        self._sleep = sleep
        self._stop = threading.Event()

    # -- external control -------------------------------------------------
    def request_stop(self) -> None:
        """Ask the loop to finish after the current page (thread-safe)."""
        self._stop.set()

    # -- core steps -------------------------------------------------------
    def _grab_stable_frame(self):
        """Poll the region until two probes agree, or the timeout elapses.

        Returns ``(frame, thumb)`` for the settled page. The adaptive poll is
        what keeps things both fast and accurate: it returns the instant the
        page stops repainting rather than sleeping a fixed, pessimistic delay.
        """
        waiter = StableFrameWaiter(self.cfg.stable_threshold)
        deadline = self._clock() + self.cfg.stabilize_timeout
        frame = self.capturer.grab()
        thumb = to_thumb(frame, self.cfg.compare_size)
        waiter.update(thumb)
        while self._clock() < deadline:
            self._sleep(self.cfg.stabilize_interval)
            frame = self.capturer.grab()
            thumb = to_thumb(frame, self.cfg.compare_size)
            if waiter.update(thumb):
                break
        return frame, thumb

    # -- run --------------------------------------------------------------
    def run(self) -> CaptureResult:
        self._stop.clear()
        end = EndDetector(self.cfg.duplicate_threshold, self.cfg.end_after_duplicates)

        image_dir = Path(self.cfg.image_dir) if self.cfg.image_dir \
            else Path(tempfile.mkdtemp(prefix="kindle2pdf_"))
        image_dir.mkdir(parents=True, exist_ok=True)

        raw_paths: List[Path] = []
        stopped_early = False
        reached_end = False

        # Let the user click into the Kindle window before we start driving it.
        if self.cfg.start_delay > 0:
            self._progress(0, f"starting in {self.cfg.start_delay:.0f}s…")
            self._sleep(self.cfg.start_delay)

        for i in range(self.cfg.max_pages):
            if self._stop.is_set():
                stopped_early = True
                break

            frame, thumb = self._grab_stable_frame()

            if end.is_duplicate(thumb):
                # Page didn't change after the turn: probably the last page.
                self._progress(len(raw_paths),
                               f"duplicate ({end.duplicate_streak}/"
                               f"{self.cfg.end_after_duplicates})")
                if end.reached_end:
                    reached_end = True
                    break
            else:
                path = image_dir / f"page_{len(raw_paths):05d}.png"
                frame.save(path)  # PNG => lossless
                raw_paths.append(path)
                self._progress(len(raw_paths), "captured")

            self.turner.turn()
            if self.cfg.page_settle > 0:
                self._sleep(self.cfg.page_settle)

        if not raw_paths:
            return CaptureResult(0, None, [], stopped_early, reached_end,
                                 message="no pages were captured")

        # -- assemble the PDF ---------------------------------------------
        self._progress(len(raw_paths), "building PDF…")
        proc_dir = image_dir / "_processed"
        proc_paths = preprocess_images(
            raw_paths, proc_dir,
            autocrop_enabled=self.cfg.autocrop,
            tolerance=self.cfg.autocrop_tolerance,
            pad=self.cfg.autocrop_pad,
        )
        output = build_pdf(proc_paths, self.cfg.output_pdf)

        ocr_applied = False
        message = ""
        if self.cfg.ocr:
            if ocr_available():
                self._progress(len(raw_paths), "running OCR…")
                add_ocr_layer(output, self.cfg.ocr_language)
                ocr_applied = True
            else:
                message = "OCR requested but ocrmypdf is not installed; " \
                          "saved image-only PDF."

        return CaptureResult(
            pages_captured=len(raw_paths),
            output_pdf=output,
            image_paths=raw_paths if self.cfg.keep_images else [],
            stopped_early=stopped_early,
            reached_end=reached_end,
            ocr_applied=ocr_applied,
            message=message,
        )
