"""Assemble captured page images into a single PDF.

Uses ``img2pdf`` so the source pixels are embedded losslessly — no
re-encoding, no quality loss, and the page geometry matches the capture
exactly (精度). Optionally runs ``ocrmypdf`` afterwards to add an invisible
searchable text layer.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Iterable, List, Optional

from PIL import Image

from .image_ops import autocrop


def preprocess_images(
    image_paths: Iterable[str | Path],
    out_dir: str | Path,
    *,
    autocrop_enabled: bool = True,
    tolerance: int = 12,
    pad: int = 4,
) -> List[Path]:
    """Optionally auto-crop each page and write the result to ``out_dir``.

    Returns the list of processed image paths in the same order. When
    ``autocrop_enabled`` is False the originals are copied through unchanged,
    so the caller always gets a clean, self-contained set to hand to img2pdf.
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    processed: List[Path] = []
    for idx, src in enumerate(image_paths):
        src = Path(src)
        dst = out_dir / f"proc_{idx:05d}.png"
        if autocrop_enabled:
            with Image.open(src) as im:
                cropped = autocrop(im, tolerance=tolerance, pad=pad)
                cropped.save(dst)
        else:
            shutil.copyfile(src, dst)
        processed.append(dst)
    return processed


def build_pdf(image_paths: List[str | Path], output_pdf: str | Path) -> Path:
    """Losslessly combine ``image_paths`` (in order) into ``output_pdf``."""
    import img2pdf  # imported lazily so pure imports stay dependency-light

    paths = [str(p) for p in image_paths]
    if not paths:
        raise ValueError("no images to build a PDF from")
    output_pdf = Path(output_pdf)
    output_pdf.parent.mkdir(parents=True, exist_ok=True)
    with open(output_pdf, "wb") as fh:
        fh.write(img2pdf.convert(paths))
    return output_pdf


def ocr_available() -> bool:
    return shutil.which("ocrmypdf") is not None


def add_ocr_layer(pdf_path: str | Path, language: str = "jpn+eng") -> Path:
    """Add a searchable text layer in place using ocrmypdf, if installed.

    Returns the PDF path. If ocrmypdf is unavailable the file is left as-is
    (a valid image-only PDF) and a RuntimeError is raised so the caller can
    warn the user without losing their capture.
    """
    pdf_path = Path(pdf_path)
    if not ocr_available():
        raise RuntimeError(
            "ocrmypdf is not installed; the PDF was created without a text layer"
        )
    subprocess.run(
        ["ocrmypdf", "--language", language, "--optimize", "1",
         "--skip-text", str(pdf_path), str(pdf_path)],
        check=True,
    )
    return pdf_path
