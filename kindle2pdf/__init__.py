"""kindle2pdf — auto-scroll a Kindle book and assemble the pages into a PDF.

Public API re-exports the pieces most callers need. Modules that require a
display (capture, page_turn, gui, region_picker) are imported lazily so that
``import kindle2pdf`` works in a headless environment.
"""

from .config import CaptureConfig, Region
from .controller import CaptureController, CaptureResult

__all__ = [
    "CaptureConfig",
    "Region",
    "CaptureController",
    "CaptureResult",
    "__version__",
]

__version__ = "0.1.0"
