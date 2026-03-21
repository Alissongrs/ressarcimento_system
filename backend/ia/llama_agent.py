#!/usr/bin/env python3
"""
Servidor wrapper que chama Ollama para gerar resumos de processos.
Expõe: POST /query (compatível com o formato do agente IA existente)

Usado pelo backend Go para gerar resumos de IA via Llama local.
"""

from flask import Flask, request, jsonify
import requests
import json
import os
import sys

app = Flask(__name__)

# Configuração
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
MODEL = os.getenv("LLAMA_MODEL", "mistral")
TIMEOUT = int(os.getenv("LLAMA_TIMEOUT", "300"))

print(f"[LLAMA-AGENT] Configuração:")
print(f"  - OLLAMA_URL: {OLLAMA_URL}")
print(f"  - MODEL: {MODEL}")
print(f"  - TIMEOUT: {TIMEOUT}s")


@app.route("/ping", methods=["GET"])
def ping():
    """Health check endpoint"""
    return jsonify({"status": "ok"}), 200


@app.route("/query", methods=["POST"])
def query():
    """
    Endpoint principal para gerar resumos.

    Request:
        {
            "question": "string com a pergunta/prompt"
        }

    Response:
        {
            "final_answer": "resposta gerada",
            "resposta": "resposta gerada"
        }
    """
    try:
        data = request.get_json() or {}
        question = data.get("question", "").strip()

        if not question:
            return jsonify({"error": "question é obrigatório"}), 400

        print(f"[LLAMA-AGENT] Processando pergunta ({len(question)} chars)...")

        # Chama Ollama
        response = requests.post(
            f"{OLLAMA_URL}/api/generate",
            json={
                "model": MODEL,
                "prompt": question,
                "stream": False,
                "temperature": 0.2,
            },
            timeout=TIMEOUT
        )
        response.raise_for_status()
        result = response.json()

        answer = result.get("response", "").strip()

        if not answer:
            print(f"[LLAMA-AGENT] Resposta vazia do Ollama")
            return jsonify({"error": "Ollama retornou resposta vazia"}), 500

        print(f"[LLAMA-AGENT] OK - {len(answer)} chars")

        # Retorna no formato esperado
        return jsonify({
            "final_answer": answer,
            "resposta": answer,
            "answer": answer
        }), 200

    except requests.exceptions.Timeout:
        msg = f"Timeout ao chamar Ollama (>{TIMEOUT}s)"
        print(f"[LLAMA-AGENT] ERROR: {msg}")
        return jsonify({"error": msg}), 504

    except requests.exceptions.ConnectionError as e:
        msg = f"Não conseguiu conectar a {OLLAMA_URL}: {e}"
        print(f"[LLAMA-AGENT] ERROR: {msg}")
        return jsonify({"error": msg}), 503

    except Exception as e:
        msg = f"Erro ao gerar resumo: {str(e)}"
        print(f"[LLAMA-AGENT] ERROR: {msg}")
        return jsonify({"error": msg}), 500


@app.route("/health", methods=["GET"])
def health():
    """Verifica se Ollama está disponível"""
    try:
        response = requests.get(
            f"{OLLAMA_URL}/api/tags",
            timeout=5
        )
        response.raise_for_status()
        return jsonify({
            "status": "ok",
            "ollama": "online",
            "model": MODEL
        }), 200
    except Exception as e:
        return jsonify({
            "status": "error",
            "ollama": "offline",
            "error": str(e)
        }), 503


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    host = os.getenv("HOST", "0.0.0.0")
    debug = os.getenv("DEBUG", "false").lower() == "true"

    print(f"[LLAMA-AGENT] Iniciando em {host}:{port}")
    print(f"[LLAMA-AGENT] Esperando requisições em http://{host}:{port}/query")
    print(f"[LLAMA-AGENT] Health check em http://{host}:{port}/health")

    app.run(host=host, port=port, debug=debug, threaded=True)
