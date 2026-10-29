"""ビンゴカードを1枚のPNG画像に描く。"""

from __future__ import annotations

import io
import os
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .bingo import FREE_LABEL, Card
from .fighters import BY_NAME

ASSETS = Path(__file__).resolve().parent.parent / "assets"
ICON_DIR = ASSETS / "icons"

# 日本語が出るフォントを順に探す（環境変数 BINGO_FONT で上書きできる）
FONT_CANDIDATES = [
    os.environ.get("BINGO_FONT", ""),
    str(ASSETS / "font.ttf"),
    "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
    "/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf",
    "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
    "C:/Windows/Fonts/meiryob.ttc",
    "C:/Windows/Fonts/msgothic.ttc",
]

# 配色
BG = (18, 19, 24)
PANEL = (28, 30, 38)
CELL_BG = (0, 0, 0)
CELL_EDGE = (58, 62, 74)
CELL_EDGE_MARK = (226, 62, 72)
TEXT = (238, 240, 245)
TEXT_DIM = (142, 148, 162)
MARK = (226, 62, 72)
FREE_GOLD = (247, 199, 74)

CELL = 190           # 1マスの大きさ
GAP = 10             # マスの間隔
PAD = 26             # 外周の余白
HEADER = 96
FOOTER = 54
NAME_AREA = 46       # マス下部の名前スペース


class FontNotFound(RuntimeError):
    pass


@lru_cache(maxsize=64)
def _font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if path and Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    raise FontNotFound(
        "日本語フォントが見つかりません。環境変数 BINGO_FONT に .ttf/.otf の"
        "パスを指定するか、assets/font.ttf にフォントを置いてください。"
    )


@lru_cache(maxsize=128)
def _icon(icon_id: str, size: int) -> Image.Image:
    return Image.open(ICON_DIR / f"{icon_id}.png").convert("RGB").resize(
        (size, size), Image.LANCZOS)


def _text_width(draw: ImageDraw.ImageDraw, text: str, font) -> int:
    return int(draw.textlength(text, font=font))


def _wrap(draw: ImageDraw.ImageDraw, text: str, font, max_width: int) -> list[str]:
    """区切り文字を優先して2行までに折り返す。"""
    if _text_width(draw, text, font) <= max_width:
        return [text]
    for sep in ("/", "&", "・", "(", " "):
        pos = text.find(sep)
        if 0 < pos < len(text) - 1:
            head = text[:pos + 1] if sep in "/&・" else text[:pos]
            tail = text[pos + 1:] if sep in "/&・ " else text[pos:]
            if max(_text_width(draw, head, font),
                   _text_width(draw, tail, font)) <= max_width:
                return [head.strip(), tail.strip()]
    mid = len(text) // 2
    return [text[:mid], text[mid:]]


def _draw_name(draw: ImageDraw.ImageDraw, text: str, box: tuple[int, int, int, int],
               color=TEXT) -> None:
    """マス下部に名前を収める。入らなければ縮める。"""
    x0, y0, x1, y1 = box
    max_width = x1 - x0
    for size in range(22, 10, -1):
        font = _font(size)
        lines = _wrap(draw, text, font, max_width)
        line_h = size + 3
        if len(lines) * line_h <= (y1 - y0) and all(
                _text_width(draw, ln, font) <= max_width for ln in lines):
            break
    else:  # どうしても入らないときは最小サイズで
        font, lines, line_h = _font(11), _wrap(draw, text, _font(11), max_width), 14

    total = len(lines) * line_h
    y = y0 + ((y1 - y0) - total) // 2
    for line in lines:
        w = _text_width(draw, line, font)
        draw.text((x0 + (max_width - w) // 2, y), line, font=font, fill=color)
        y += line_h


def _has_icon(name: str) -> bool:
    fighter = BY_NAME.get(name)
    return bool(fighter and fighter.icon_id
                and (ICON_DIR / f"{fighter.icon_id}.png").exists())


def _draw_cell(base: Image.Image, draw: ImageDraw.ImageDraw, card: Card,
               index: int, x: int, y: int) -> None:
    name = card.cells[index]
    marked = index in card.marked
    is_free = index == card.free_index
    icon_area = CELL - NAME_AREA

    draw.rounded_rectangle((x, y, x + CELL, y + CELL), radius=14, fill=CELL_BG,
                           outline=CELL_EDGE_MARK if marked else CELL_EDGE,
                           width=3 if marked else 2)

    # 絵の部分
    if is_free:
        font = _font(40)
        w = _text_width(draw, "FREE", font)
        draw.text((x + (CELL - w) // 2, y + icon_area // 2 - 30), "FREE",
                  font=font, fill=FREE_GOLD)
    else:
        if _has_icon(name):
            size = icon_area - 12
            base.paste(_icon(BY_NAME[name].icon_id, size),
                       (x + (CELL - size) // 2, y + 8))
        else:
            # 画像が無いファイターは、マスの中央に名前を大きく出す
            _draw_name(draw, name, (x + 12, y + 16, x + CELL - 12, y + CELL - 16))

    # マークの丸（名前の帯にはかからないように、絵の部分だけに描く）
    if marked and not is_free:
        overlay = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        od.rounded_rectangle((0, 0, CELL - 1, CELL - 1), radius=14,
                             fill=(226, 62, 72, 55))
        m = 14
        od.ellipse((m, m, CELL - m, icon_area - m + 10),
                   outline=(255, 96, 106, 240), width=9)
        base.paste(Image.alpha_composite(
            base.crop((x, y, x + CELL, y + CELL)).convert("RGBA"), overlay
        ).convert("RGB"), (x, y))

    # 名前は最後に描く（丸に重ならず読めるように）
    label_box = (x + 8, y + icon_area - 2, x + CELL - 8, y + CELL - 6)
    if is_free:
        _draw_name(draw, "まんなか", label_box, color=TEXT_DIM)
    elif _has_icon(name):
        _draw_name(draw, name, label_box,
                   color=(255, 196, 200) if marked else TEXT)


def render_card(card: Card) -> bytes:
    """カードをPNGのバイト列にして返す。"""
    n = card.size
    grid = n * CELL + (n - 1) * GAP
    width = grid + PAD * 2
    height = HEADER + grid + FOOTER + PAD

    base = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(base)
    draw.rounded_rectangle((PAD - 12, HEADER - 14, width - PAD + 12,
                            HEADER + grid + 14), radius=20, fill=PANEL)

    # ヘッダー
    title = "スマブラ キャラビンゴ"
    done = len(card.completed_lines())
    status = f"ビンゴ {done}" if done else f"リーチ {card.reach_count()}"
    sf = _font(26)
    sw = _text_width(draw, status, sf)
    for title_size in range(44, 21, -2):
        tf = _font(title_size)
        if _text_width(draw, title, tf) + sw + 40 <= width - PAD * 2:
            break
    draw.text((PAD, 24 + (44 - title_size) // 2), title, font=tf, fill=TEXT)
    draw.text((width - PAD - sw, 40), status, font=sf,
              fill=FREE_GOLD if done else TEXT_DIM)

    # マス目
    for index in range(n * n):
        r, c = divmod(index, n)
        _draw_cell(base, draw, card,
                   index, PAD + c * (CELL + GAP), HEADER + r * (CELL + GAP))

    # そろった列に線を引く
    if done:
        line_layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(line_layer)
        for line in card.completed_lines():
            def center(i: int) -> tuple[int, int]:
                r, c = divmod(i, n)
                return (PAD + c * (CELL + GAP) + CELL // 2,
                        HEADER + r * (CELL + GAP) + CELL // 2)
            ld.line([center(line[0]), center(line[-1])],
                    fill=(255, 92, 102, 150), width=10)
        base.paste(Image.alpha_composite(base.convert("RGBA"), line_layer
                                         ).convert("RGB"), (0, 0))
        draw = ImageDraw.Draw(base)

    # フッター
    foot = f"{card.owner_name} / 候補 {card.settings.get('pool_size', '?')}体"
    if card.settings.get("exclude"):
        foot += f" / 除外 {len(card.settings['exclude'])}件"
    if card.seed:
        foot += f" / seed: {card.seed}"
    draw.text((PAD, height - FOOTER + 8), foot, font=_font(22), fill=TEXT_DIM)

    # 256色に減色してから保存する。見た目はほぼ変わらないのにファイルは
    # 1/3ほどになり、無料枠の通信量やアップロードの待ち時間に効く。
    buf = io.BytesIO()
    base.quantize(colors=256, method=Image.MEDIANCUT, dither=Image.NONE).save(
        buf, format="PNG", optimize=True)
    return buf.getvalue()
