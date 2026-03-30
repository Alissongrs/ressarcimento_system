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
import html
import re

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


def _strip_html(html_str):
    """Remove tags HTML e normaliza espaços para reduzir tokens enviados ao LLM."""
    text = re.sub(r'<[^>]+>', ' ', html_str or '')
    text = html.unescape(text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text[:4000]


def _extract_json(raw):
    """Extrai o primeiro objeto JSON válido de uma string de resposta do LLM."""
    match = re.search(r'\{[^{}]*\}', raw, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass
    # Tentativa com objetos aninhados
    match2 = re.search(r'\{.*\}', raw, re.DOTALL)
    if match2:
        try:
            return json.loads(match2.group(0))
        except json.JSONDecodeError:
            pass
    return None


@app.route("/extract/email-data", methods=["POST"])
def extract_email_data():
    """
    Extrai dados estruturados de um email de concessionária usando o LLM.

    Request:
        { "email_html": "<string com o corpo HTML do email>" }

    Response:
        {
          "tipo_resposta": "deferido|indeferido|em_analise|solicita_documentos|outros",
          "valor": 1234.56 | null,
          "prazo": "YYYY-MM-DD" | null,
          "numero_protocolo": "string" | null,
          "resumo": "1-2 frases sobre a decisão"
        }
    """
    try:
        data = request.get_json() or {}
        email_html = data.get("email_html", "").strip()

        if not email_html:
            return jsonify({"error": "email_html é obrigatório"}), 400

        email_texto = _strip_html(email_html)
        if not email_texto:
            return jsonify({
                "tipo_resposta": "outros",
                "valor": None,
                "prazo": None,
                "numero_protocolo": None,
                "resumo": "Email sem conteúdo identificável."
            }), 200

        prompt = f"""Você é um especialista em análise de correspondências de concessionárias de energia elétrica no Brasil.
Analise o email abaixo e extraia as informações solicitadas.
Responda APENAS com um objeto JSON válido, sem texto antes ou depois, sem markdown, sem blocos de código.

Email da concessionária:
---
{email_texto}
---

Retorne exatamente este JSON (sem nenhum texto fora do JSON):
{{
  "tipo_resposta": "<um de: deferido | indeferido | em_analise | solicita_documentos | outros>",
  "valor": <float com o valor em reais mencionado, ou null se não houver>,
  "prazo": "<data no formato YYYY-MM-DD se mencionada, ou null>",
  "numero_protocolo": "<número de protocolo ou processo se mencionado, ou null>",
  "resumo": "<1 a 2 frases objetivas descrevendo a decisão ou solicitação principal>"
}}

Regras de classificação:
- "deferido": aprovado, deferido, aceito, procedente, aprovação concedida
- "indeferido": negado, indeferido, rejeitado, improcedente, não procede
- "em_analise": em análise, aguardando avaliação, em avaliação, prazo de análise, sendo analisado
- "solicita_documentos": solicita, pendente de documentos, aguardamos, complementação necessária, enviar documentos
- "outros": qualquer outra situação não coberta acima"""

        print(f"[LLAMA-AGENT] /extract/email-data - processando {len(email_texto)} chars...")

        response = requests.post(
            f"{OLLAMA_URL}/api/generate",
            json={
                "model": MODEL,
                "prompt": prompt,
                "stream": False,
                "temperature": 0.1,
            },
            timeout=TIMEOUT
        )
        response.raise_for_status()
        raw = response.json().get("response", "").strip()

        parsed = _extract_json(raw)
        if parsed:
            result = {
                "tipo_resposta": str(parsed.get("tipo_resposta", "outros")).lower().strip(),
                "valor": parsed.get("valor"),
                "prazo": parsed.get("prazo"),
                "numero_protocolo": parsed.get("numero_protocolo"),
                "resumo": str(parsed.get("resumo", raw[:300])).strip(),
            }
            valid_tipos = {"deferido", "indeferido", "em_analise", "solicita_documentos", "outros"}
            if result["tipo_resposta"] not in valid_tipos:
                result["tipo_resposta"] = "outros"
            print(f"[LLAMA-AGENT] /extract/email-data - tipo={result['tipo_resposta']}")
            return jsonify(result), 200

        # Fallback: LLM não retornou JSON válido
        print(f"[LLAMA-AGENT] /extract/email-data - JSON parsing falhou, usando fallback")
        return jsonify({
            "tipo_resposta": "outros",
            "valor": None,
            "prazo": None,
            "numero_protocolo": None,
            "resumo": raw[:300] if raw else "Não foi possível interpretar a resposta do modelo.",
        }), 200

    except requests.exceptions.Timeout:
        return jsonify({"error": f"Timeout ao chamar Ollama (>{TIMEOUT}s)"}), 504
    except requests.exceptions.ConnectionError as e:
        return jsonify({"error": f"Não conseguiu conectar a {OLLAMA_URL}: {e}"}), 503
    except Exception as e:
        print(f"[LLAMA-AGENT] /extract/email-data ERROR: {e}")
        return jsonify({"error": str(e)}), 500


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
