#!/usr/bin/env python3
"""Teste Mistral/Llama Agent"""

import requests
import sys
import time
from datetime import datetime

LLAMA_AGENT_URL = "http://localhost:8000"
OLLAMA_URL = "http://localhost:11434"
TIMEOUT = 120

print("=" * 80)
print("[>>] TESTE MISTRAL/LLAMA AGENT")
print(f"   Data/Hora: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
print("=" * 80)

# VERIFICACAO 1: OLLAMA
print("\n[1] Verificando Ollama...")
print("-" * 80)

try:
    response = requests.get(f"{OLLAMA_URL}/api/tags", timeout=5)
    if response.status_code == 200:
        models = response.json().get("models", [])
        print(f"[OK] Ollama respondendo em {OLLAMA_URL}")
        print(f"[OK] Modelos instalados: {len(models)}")
        model_names = [m.get("name", "unknown") for m in models]
        for name in model_names:
            print(f"     - {name}")
        if not any("mistral" in m.lower() for m in model_names):
            print("\n[!] AVISO: Mistral nao encontrado!")
            print("    Execute: ollama pull mistral")
    else:
        print(f"[!] Ollama retornou erro: {response.status_code}")
        sys.exit(1)
except requests.exceptions.ConnectionError:
    print("[!] Erro: Ollama nao esta respondendo")
    print("   Instale Ollama: https://ollama.ai/download")
    print("   Depois execute: ollama serve")
    sys.exit(1)
except Exception as e:
    print(f"[!] Erro: {e}")
    sys.exit(1)

# VERIFICACAO 2: LLAMA AGENT
print("\n[2] Verificando Llama Agent...")
print("-" * 80)

try:
    response = requests.get(f"{LLAMA_AGENT_URL}/health", timeout=5)
    if response.status_code == 200:
        health = response.json()
        print(f"[OK] Llama Agent respondendo em {LLAMA_AGENT_URL}")
        print(f"     Status: {health.get('status')}")
        print(f"     Ollama: {health.get('ollama')}")
        print(f"     Modelo: {health.get('model')}")
    else:
        print(f"[!] Llama Agent retornou: {response.status_code}")
except requests.exceptions.ConnectionError:
    print("[!] Erro: Llama Agent nao esta respondendo")
    print("   Execute em outro terminal:")
    print("   cd backend/ia/")
    print("   python llama_agent.py")
    sys.exit(1)
except Exception as e:
    print(f"[!] Erro: {e}")
    sys.exit(1)

# TESTE 1: PING
print("\n[3] Teste de Ping...")
print("-" * 80)

try:
    response = requests.get(f"{LLAMA_AGENT_URL}/ping", timeout=5)
    if response.status_code == 200:
        print(f"[OK] Ping respondendo: {response.json()}")
    else:
        print(f"[!] Ping falhou: {response.status_code}")
except Exception as e:
    print(f"[!] Erro: {e}")

# TESTE 2: GERACAO DE RESUMO
print("\n[4] Teste de Geracao de Resumo...")
print("-" * 80)

test_prompts = [
    {
        "nome": "Resumo simples",
        "prompt": "Resuma em 2 linhas: O processo de ressarcimento eh devolucao de valores pagos indevidamente."
    },
    {
        "nome": "Analise de processo",
        "prompt": "Analise: Valor R$ 5000, dias: 30, movimentacoes: 4. Resultado esperado?"
    }
]

for idx, test in enumerate(test_prompts, 1):
    print(f"\n[Teste {idx}] {test['nome']}")
    try:
        start = time.time()
        response = requests.post(
            f"{LLAMA_AGENT_URL}/query",
            json={"question": test["prompt"]},
            timeout=TIMEOUT
        )
        latency = time.time() - start

        if response.status_code == 200:
            result = response.json()
            answer = result.get("final_answer") or result.get("resposta") or ""
            print(f"[OK] Latencia: {latency:.1f}s, Tamanho: {len(answer)} chars")
            print(f"     {answer[:80]}...")
        else:
            print(f"[!] Erro: {response.status_code}")
    except requests.exceptions.Timeout:
        print(f"[!] Timeout (>{TIMEOUT}s)")
    except Exception as e:
        print(f"[!] Erro: {e}")

print("\n" + "=" * 80)
print("[OK] TESTES CONCLUIDOS")
print("=" * 80)
