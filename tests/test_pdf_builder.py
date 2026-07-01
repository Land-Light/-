from pathlib import Path

from PIL import Image

from kindle2pdf.pdf_builder import build_pdf, preprocess_images


def _make_pngs(tmp_path, n):
    paths = []
    for i in range(n):
        p = tmp_path / f"page_{i}.png"
        img = Image.new("RGB", (100, 140), "white")
        for y in range(30, 110):          # some black content to crop to
            for x in range(30, 70):
                img.putpixel((x, y), (0, 0, 0))
        img.save(p)
        paths.append(p)
    return paths


def test_preprocess_autocrop_shrinks_pages(tmp_path):
    src = _make_pngs(tmp_path, 2)
    out = preprocess_images(src, tmp_path / "proc", autocrop_enabled=True,
                            tolerance=12, pad=2)
    assert len(out) == 2
    for p in out:
        with Image.open(p) as im:
            assert im.width < 100 and im.height < 140


def test_preprocess_passthrough_keeps_size(tmp_path):
    src = _make_pngs(tmp_path, 1)
    out = preprocess_images(src, tmp_path / "proc2", autocrop_enabled=False)
    with Image.open(out[0]) as im:
        assert im.size == (100, 140)


def test_build_pdf_creates_valid_file(tmp_path):
    src = _make_pngs(tmp_path, 3)
    out = build_pdf(src, tmp_path / "book.pdf")
    assert out.exists()
    data = out.read_bytes()
    assert data.startswith(b"%PDF")
    assert data.rstrip().endswith(b"%%EOF")


def test_build_pdf_rejects_empty(tmp_path):
    try:
        build_pdf([], tmp_path / "x.pdf")
    except ValueError:
        return
    raise AssertionError("expected ValueError for empty image list")
