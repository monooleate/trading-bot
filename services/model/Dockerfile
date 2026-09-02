# services/model/Dockerfile — Python FastAPI ML service (hetzner-docker §6).
# torch/chronos stay commented in requirements until the 16 GB tier (Phase 7);
# the base service boots + /health answers without them.
FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends build-essential curl \
    && rm -rf /var/lib/apt/lists/*
COPY services/model/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY services/model/app ./app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://localhost:8000/health || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
