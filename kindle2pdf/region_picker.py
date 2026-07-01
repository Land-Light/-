"""Interactive selection of the capture rectangle.

Opens a translucent full-screen overlay; the user drags a box over the page
area of the Kindle window and the pixel rectangle is returned. Pure Tk, so no
extra dependencies, but it obviously requires a display and is therefore
imported only when actually used.

When a ``parent`` window is supplied the overlay is created as a modal
``Toplevel`` of that window. This matters: creating a *second* ``tk.Tk()``
instance while another one is already running spins up a second Tcl
interpreter, and on Windows that combination can crash the process when one
of them is destroyed. A single interpreter with a Toplevel is stable.
"""

from __future__ import annotations

from typing import Optional

from .config import Region


def pick_region(parent=None) -> Optional[Region]:
    """Show the overlay and return the chosen :class:`Region` (or None).

    If ``parent`` is given, run as a modal child window and block on
    ``wait_window``; otherwise create a standalone root and run its own loop.
    """
    import tkinter as tk

    owns_root = parent is None
    win = tk.Tk() if owns_root else tk.Toplevel(parent)

    win.attributes("-fullscreen", True)
    try:
        win.attributes("-alpha", 0.25)  # see the desktop through the overlay
    except tk.TclError:
        pass
    win.configure(cursor="crosshair", bg="black")
    win.attributes("-topmost", True)

    canvas = tk.Canvas(win, highlightthickness=0, bg="black")
    canvas.pack(fill="both", expand=True)
    canvas.create_text(
        win.winfo_screenwidth() // 2, 30,
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
            x0 = state["x0"] - win.winfo_rootx()
            y0 = state["y0"] - win.winfo_rooty()
            canvas.coords(state["rect"], x0, y0, e.x, e.y)

    def finish():
        # Tear the overlay down safely; destroy() during event handling is
        # what previously took the process out, so guard it.
        try:
            if owns_root:
                win.quit()
            win.destroy()
        except tk.TclError:
            pass

    def on_release(e):
        left = min(state["x0"], e.x_root)
        top = min(state["y0"], e.y_root)
        width = abs(e.x_root - state["x0"])
        height = abs(e.y_root - state["y0"])
        if width > 5 and height > 5:
            state["result"] = Region(int(left), int(top), int(width), int(height))
        finish()

    def on_cancel(_e=None):
        state["result"] = None
        finish()

    canvas.bind("<ButtonPress-1>", on_press)
    canvas.bind("<B1-Motion>", on_drag)
    canvas.bind("<ButtonRelease-1>", on_release)
    win.bind("<Escape>", on_cancel)

    if owns_root:
        win.mainloop()
    else:
        win.transient(parent)
        win.grab_set()          # make it modal so clicks go to the overlay
        parent.wait_window(win)  # block here without a nested Tk() interpreter

    return state["result"]
