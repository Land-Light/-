"""Command-line entry point.

    python -m kindle2pdf                 # launch the GUI
    python -m kindle2pdf --gui
    python -m kindle2pdf --region L T W H --out book.pdf   # headless run
    python -m kindle2pdf --config profile.json

Headless mode is handy once you have a saved region/profile and just want to
re-run without the window.
"""

from __future__ import annotations

import argparse
import sys

from .config import CaptureConfig, Region


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="kindle2pdf",
        description="Auto-scroll a Kindle book and save it as a PDF.",
    )
    p.add_argument("--gui", action="store_true", help="launch the control panel")
    p.add_argument("--config", help="load settings from a JSON profile")
    p.add_argument("--save-config", help="write the resolved settings to JSON and exit")
    p.add_argument("--region", nargs=4, type=int, metavar=("L", "T", "W", "H"),
                   help="capture rectangle: left top width height")
    p.add_argument("--fullscreen", action="store_true",
                   help="capture the whole primary monitor (no region needed)")
    p.add_argument("--key", help="page-turn key (default: right)")
    p.add_argument("--max-pages", type=int, help="safety cap on pages")
    p.add_argument("--settle", type=float, help="pause after each page turn (s)")
    p.add_argument("--start-delay", type=float, help="countdown before starting (s)")
    p.add_argument("--out", help="output PDF path")
    p.add_argument("--no-autocrop", action="store_true", help="keep full frames")
    p.add_argument("--ocr", action="store_true", help="add a searchable text layer")
    p.add_argument("--keep-images", action="store_true", help="keep the page PNGs")
    return p


def config_from_args(args) -> CaptureConfig:
    cfg = CaptureConfig.load(args.config) if args.config else CaptureConfig()
    if args.region:
        cfg.region = Region(*args.region)
    if getattr(args, "fullscreen", False):
        from .capture import primary_monitor_region
        cfg.region = primary_monitor_region()
    if args.key:
        cfg.turn_key = args.key
    if args.max_pages is not None:
        cfg.max_pages = args.max_pages
    if args.settle is not None:
        cfg.page_settle = args.settle
    if args.start_delay is not None:
        cfg.start_delay = args.start_delay
    if args.out:
        cfg.output_pdf = args.out
    if args.no_autocrop:
        cfg.autocrop = False
    if args.ocr:
        cfg.ocr = True
    if args.keep_images:
        cfg.keep_images = True
    return cfg


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    cfg = config_from_args(args)

    if args.save_config:
        cfg.save(args.save_config)
        print(f"wrote {args.save_config}")
        return 0

    # No region and no explicit headless intent -> GUI is the friendly default.
    if args.gui or not cfg.region.is_valid:
        from .gui import launch
        launch(cfg)
        return 0

    # Headless run.
    from .capture import ScreenCapturer
    from .controller import CaptureController
    from .page_turn import make_turner

    try:
        cfg.validate()
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    ctrl = CaptureController(
        cfg, ScreenCapturer(cfg.region), make_turner(cfg),
        progress=lambda i, note: print(f"[{i:>4}] {note}"),
    )
    result = ctrl.run()
    print(f"\nCaptured {result.pages_captured} pages -> {result.output_pdf}")
    if result.reached_end:
        print("End of book detected.")
    if result.message:
        print(result.message)
    return 0 if result.pages_captured else 1


if __name__ == "__main__":
    raise SystemExit(main())
