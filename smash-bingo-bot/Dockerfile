FROM python:3.13-slim

# 日本語フォント（カード画像の文字に必要）
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-ipafont-gothic \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080 \
    BINGO_FONT=/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY smashbingo/ ./smashbingo/
COPY linebingo/ ./linebingo/
COPY assets/icons/ ./assets/icons/

RUN mkdir -p /app/data && useradd --create-home --uid 1000 bingo \
    && chown -R bingo:bingo /app
USER bingo

EXPOSE 8080

# LINE版のサーバー。Discord版を動かすなら CMD を
# ["python", "-m", "smashbingo"] に変える
CMD ["python", "-m", "linebingo"]
