"""A small Tkinter control panel for the capture pipeline.

Lets the user pick the region, tweak the important knobs, run the capture on
a background thread (so the UI stays responsive and Stop works), and see live
progress. Everything display-related is imported lazily inside ``launch``.
"""

from __future__ import annotations

import threading
from pathlib import Path

from .config import CaptureConfig, Region
from .capture import ScreenCapturer
from .controller import CaptureController
from .page_turn import make_turner
from .region_picker import pick_region


def _enable_dpi_awareness() -> None:
    """On Windows, make the process DPI-aware before any Tk window exists.

    Without this, on a scaled display (e.g. 150%) Tk reports logical pixels
    while ``mss`` grabs physical pixels, so the selected region would be
    offset and the wrong size. Making the process DPI-aware puts both on the
    same physical-pixel coordinate system. No-op on other platforms.
    """
    import sys
    if not sys.platform.startswith("win"):
        return
    try:
        import ctypes
        # PROCESS_PER_MONITOR_DPI_AWARE = 2
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def launch(config: CaptureConfig | None = None) -> None:
    _enable_dpi_awareness()
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    cfg = config or CaptureConfig()

    root = tk.Tk()
    root.title("Kindle → PDF  (auto-scroll capture)")
    root.resizable(False, False)
    pad = {"padx": 8, "pady": 4}

    region_var = tk.StringVar(value="(not set)")
    key_var = tk.StringVar(value=cfg.turn_key)
    pages_var = tk.IntVar(value=cfg.max_pages)
    settle_var = tk.DoubleVar(value=cfg.page_settle)
    delay_var = tk.DoubleVar(value=cfg.start_delay)
    autocrop_var = tk.BooleanVar(value=cfg.autocrop)
    ocr_var = tk.BooleanVar(value=cfg.ocr)
    out_var = tk.StringVar(value=cfg.output_pdf)
    status_var = tk.StringVar(value="Pick a region to begin.")

    controller_box: dict = {"ctrl": None, "thread": None}

    def set_region_label():
        r = cfg.region
        region_var.set(f"{r.width}×{r.height} @ ({r.left},{r.top})"
                       if r.is_valid else "(not set)")

    def on_pick():
        # Hide the panel so it isn't captured, but keep the same Tk
        # interpreter: the overlay is a modal child of ``root`` (a second
        # tk.Tk() here crashes on Windows). Any failure is reported instead
        # of taking the whole app down.
        root.withdraw()
        root.update_idletasks()
        try:
            r = pick_region(parent=root)
        except Exception as e:
            r = None
            messagebox.showerror("Region selection failed", str(e))
        finally:
            root.deiconify()
            root.lift()
        if r is not None:
            cfg.region = r
            set_region_label()
            status_var.set("Region set. Focus your Kindle window, then Start.")

    def on_fullscreen():
        # No region selection needed: capture the whole primary monitor.
        from .capture import primary_monitor_region
        try:
            cfg.region = primary_monitor_region()
        except Exception as e:
            messagebox.showerror("Full-screen setup failed", str(e))
            return
        set_region_label()
        status_var.set("Full screen set. Put Kindle in full screen, then Start.")

    def on_browse():
        p = filedialog.asksaveasfilename(
            defaultextension=".pdf", filetypes=[("PDF", "*.pdf")],
            initialfile=out_var.get())
        if p:
            out_var.set(p)

    def progress(page_index, note):
        status_var.set(f"Page {page_index}: {note}")

    def worker():
        cfg.turn_key = key_var.get()
        cfg.max_pages = int(pages_var.get())
        cfg.page_settle = float(settle_var.get())
        cfg.start_delay = float(delay_var.get())
        cfg.autocrop = bool(autocrop_var.get())
        cfg.ocr = bool(ocr_var.get())
        cfg.output_pdf = out_var.get()
        try:
            cfg.validate()
        except ValueError as e:
            root.after(0, lambda: messagebox.showerror("Invalid settings", str(e)))
            root.after(0, lambda: _set_running(False))
            return
        ctrl = CaptureController(
            cfg, ScreenCapturer(cfg.region), make_turner(cfg), progress=progress)
        controller_box["ctrl"] = ctrl
        try:
            result = ctrl.run()
        except Exception as e:  # surface any runtime failure to the user
            root.after(0, lambda: messagebox.showerror("Capture failed", str(e)))
            root.after(0, lambda: _set_running(False))
            return
        msg = f"Done: {result.pages_captured} pages → {result.output_pdf}"
        if result.reached_end:
            msg += " (end of book detected)"
        if result.stopped_early:
            msg += " (stopped)"
        if result.message:
            msg += f"\n{result.message}"
        root.after(0, lambda: status_var.set(msg))
        root.after(0, lambda: messagebox.showinfo("Finished", msg))
        root.after(0, lambda: _set_running(False))

    def _set_running(running: bool):
        start_btn.config(state="disabled" if running else "normal")
        stop_btn.config(state="normal" if running else "disabled")

    def on_start():
        if not cfg.region.is_valid:
            # Nothing selected: default to capturing the whole primary monitor,
            # which is exactly right when the reader runs full-screen.
            on_fullscreen()
            if not cfg.region.is_valid:
                return
        _set_running(True)
        status_var.set("Starting…")
        t = threading.Thread(target=worker, daemon=True)
        controller_box["thread"] = t
        t.start()

    def on_stop():
        ctrl = controller_box.get("ctrl")
        if ctrl is not None:
            ctrl.request_stop()
            status_var.set("Stopping after current page…")

    # -- layout -----------------------------------------------------------
    frm = ttk.Frame(root, padding=12)
    frm.grid()
    row = 0
    ttk.Button(frm, text="■ Use full screen", command=on_fullscreen).grid(
        row=row, column=0, sticky="w", **pad)
    ttk.Label(frm, textvariable=region_var).grid(row=row, column=1, columnspan=2,
                                                 sticky="w", **pad)
    row += 1
    ttk.Button(frm, text="① Pick region (optional)", command=on_pick).grid(
        row=row, column=0, sticky="w", **pad)
    ttk.Label(frm, text="※全画面ならこの操作は不要").grid(
        row=row, column=1, columnspan=2, sticky="w", **pad)
    row += 1
    ttk.Label(frm, text="Page-turn key").grid(row=row, column=0, sticky="w", **pad)
    ttk.Combobox(frm, textvariable=key_var, width=12,
                 values=["right", "left", "pagedown", "pageup", "space"]).grid(
        row=row, column=1, sticky="w", **pad)
    row += 1
    ttk.Label(frm, text="Max pages").grid(row=row, column=0, sticky="w", **pad)
    ttk.Entry(frm, textvariable=pages_var, width=10).grid(
        row=row, column=1, sticky="w", **pad)
    row += 1
    ttk.Label(frm, text="Settle delay (s)").grid(row=row, column=0, sticky="w", **pad)
    ttk.Entry(frm, textvariable=settle_var, width=10).grid(
        row=row, column=1, sticky="w", **pad)
    row += 1
    ttk.Label(frm, text="Start delay (s)").grid(row=row, column=0, sticky="w", **pad)
    ttk.Entry(frm, textvariable=delay_var, width=10).grid(
        row=row, column=1, sticky="w", **pad)
    row += 1
    ttk.Checkbutton(frm, text="Auto-crop margins", variable=autocrop_var).grid(
        row=row, column=0, columnspan=2, sticky="w", **pad)
    row += 1
    ttk.Checkbutton(frm, text="Searchable OCR layer (needs ocrmypdf)",
                    variable=ocr_var).grid(row=row, column=0, columnspan=2,
                                           sticky="w", **pad)
    row += 1
    ttk.Label(frm, text="Output PDF").grid(row=row, column=0, sticky="w", **pad)
    ttk.Entry(frm, textvariable=out_var, width=28).grid(
        row=row, column=1, sticky="w", **pad)
    ttk.Button(frm, text="…", width=3, command=on_browse).grid(
        row=row, column=2, sticky="w")
    row += 1
    start_btn = ttk.Button(frm, text="▶ Start", command=on_start)
    start_btn.grid(row=row, column=0, sticky="we", **pad)
    stop_btn = ttk.Button(frm, text="■ Stop", command=on_stop, state="disabled")
    stop_btn.grid(row=row, column=1, sticky="we", **pad)
    row += 1
    ttk.Label(frm, textvariable=status_var, wraplength=360,
              foreground="#0066aa").grid(row=row, column=0, columnspan=3,
                                         sticky="w", **pad)

    set_region_label()
    root.mainloop()
