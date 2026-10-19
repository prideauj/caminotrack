FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# The app, its prebuilt route data and town descriptions, and the web pages (see .dockerignore for what is left out)
COPY . .

# Cloud Run sets PORT; the app keeps nothing on disk
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
