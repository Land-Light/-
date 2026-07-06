FROM python:3.12-slim

# PDF の日本語フォント(書き込み・レポート両方で使用)
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-ipafont fonts-ipaexfont \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && playwright install --with-deps chromium

COPY . .

ENV PYTHONUNBUFFERED=1
EXPOSE 8000

# 採点は1リクエスト数分かかるため timeout を長めに設定。
# 無料プラン(メモリ512MB)ではワーカー2つで OOM 再起動ループに陥り
# サービスが Live にならないため、ワーカーは 1 に固定(同時処理はスレッドで確保)。
CMD ["sh", "-c", "gunicorn app:app --bind 0.0.0.0:${PORT:-8000} --workers 1 --threads 4 --timeout 900"]
