FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY archiver.py youtube_auth.py ./

ENV DATA_DIR=/data PYTHONUNBUFFERED=1
VOLUME ["/data"]
CMD ["python", "archiver.py"]
