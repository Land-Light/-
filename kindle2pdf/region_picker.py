"""Interactive selection of the capture rectangle.

Opens a translucent full-screen overlay; the user drags a box over the page
area of the Kindle window and the pixel rectangle is returned. Pure Tk, so no
extra dependencies, but it obviously requires a display and is therefore
imported only when actually used.
"""

from __future__ import annotations

from typing import Optional

from .config import Region


def pick_region() -> Optional[Region]:
    """Show the overlay and return the chosen :class:`Region` (or None)."""
    import tkinter as tk

    root = tk.Tk()
    root.attributes("-fullscreen", True)
    try:
        root.attributes("-alpha", 0.25)  # see the desktop through the overlay
    except tk.TclError:
        pass
    root.configure(cursor="crosshair", bg="black")
    root.attributes("-topmost", True)

    canvas = tk.Canvas(root, highlightthickness=0, bg="black")
    canvas.pack(fill="both", expand=True)
    canvas.create_text(
        root.winfo_screenwidth() // 2, 30,
        text="Drag a box over the Kindle page area — Esc to cancel",
        fill="white", font=("Helvetica", 18),
    )

    state = {"x0": 0, "y0": 0, "rect": None, "result": None}

    def on_press(e):
        state["x0"], state["y0"] = e.x_root, e.y_root
        if state["rect"] is not None:
            canvas.delete(state["rect"])
        state["rect"] = canvas.create_rectangle(
            e.x, e.y, e.x, e.y, outline="#00e5ff", width=2)

    def on_drag(e):
        if state["rect"] is not None:
            x0 = state["x0"] - root.winfo_rootx()
            y0 = state["y0"] - root.winfo_rooty()
            canvas.coords(state["rect"], x0, y0, e.x, e.y)

    def on_release(e):
        left = min(state["x0"], e.x_root)
        top = min(state["y0"], e.y_root)
        width = abs(e.x_root - state["x0"])
        height = abs(e.y_root - state["y0"])
        if width > 5 and height > 5:
            state["result"] = Region(left, top, width, height)
        root.destroy()

    def on_cancel(_e=None):
        state["result"] = None
        root.destroy()

    canvas.bind("<ButtonPress-1>", on_press)
    canvas.bind("<B1-Motion>", on_drag)
    canvas.bind("<ButtonRelease-1>", on_release)
    root.bind("<Escape>", on_cancel)
    root.mainloop()
    return state["result"]
