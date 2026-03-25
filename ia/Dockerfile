FROM python:3.11-slim

WORKDIR /app

# Instala dependências para api_servidor.py (Score Model)
RUN pip install --no-cache-dir \
    fastapi \
    uvicorn \
    flask \
    requests \
    mysql-connector-python \
    pandas \
    numpy \
    scikit-learn

# Copia os scripts
COPY api_servidor.py .
COPY train_score_async.py .

# Cria diretórios para dados e modelos
RUN mkdir -p models data

# Health check
HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/ping', timeout=2).read()" || exit 1

RUN useradd -r -u 1001 appuser && chown -R appuser /app
USER appuser

# Expõe porta
EXPOSE 8000

# Inicia o serviço
CMD ["python", "api_servidor.py"]
