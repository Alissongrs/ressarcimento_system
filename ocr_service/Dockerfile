FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# System deps
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      tesseract-ocr \
      tesseract-ocr-por \
      tesseract-ocr-eng \
      poppler-utils \
      ghostscript \
      libjpeg62-turbo \
      zlib1g \
      libgl1 \
      libglib2.0-0 \
      libgomp1 \
      swig \
      build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Always update pip/wheel to ensure manylinux wheels
RUN pip install --no-cache-dir -U pip setuptools wheel

# ---- deps base (always) ----
COPY requirements.txt /app/requirements.txt
COPY requirements-base.txt /app/requirements-base.txt
# Base deps (leve)
RUN pip install --no-cache-dir -r /app/requirements-base.txt

# ---- deps extras (optional) ----
ARG INSTALL_OCR_EXTRAS=0
COPY requirements-ocr-extras.txt /app/requirements-ocr-extras.txt
RUN if [ "$INSTALL_OCR_EXTRAS" = "1" ]; then \
      pip install --no-cache-dir --only-binary=:all: PyMuPDF==1.26.7 ; \
      pip install --no-cache-dir -r /app/requirements-ocr-extras.txt ; \
    fi

# Copy project (not only app.py) to include utils/modules
COPY . /app

RUN useradd -r -u 1001 appuser && chown -R appuser /app
USER appuser

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
