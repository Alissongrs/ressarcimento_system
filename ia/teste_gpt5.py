#!/usr/bin/env python3
"""Testa se gpt-5.4 está funcionando e que erros retorna."""

import requests
import json
from pathlib import Path
from dotenv import load_dotenv
import os

load_dotenv(Path(__file__).parent / ".env")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL = "https://api.openai.com"

print("=" * 80)
print("TESTE 1: Requisição texto simples para gpt-5.4")
print("=" * 80)

headers = {
    "Authorization": f"Bearer {OPENAI_API_KEY}",
    "Content-Type": "application/json",
}

body = {
    "model": "gpt-5.4",
    "max_tokens": 100,
    "messages": [
        {"role": "system", "content": "Você é um assistente útil."},
        {"role": "user", "content": "Olá, tudo bem?"},
    ],
}

print("\nRequisição:")
print(json.dumps({k: v if k != "Authorization" else "***" for k, v in headers.items()}, indent=2))
print(json.dumps(body, indent=2))

try:
    r = requests.post(
        f"{OPENAI_BASE_URL}/v1/chat/completions",
        headers=headers,
        json=body,
        timeout=30,
    )
    print(f"\nStatus: {r.status_code}")
    print(f"Headers: {dict(r.headers)}")

    if r.status_code == 200:
        print(f"\n✓ SUCESSO")
        print(f"Resposta: {r.json()['choices'][0]['message']['content']}")
    else:
        print(f"\n✗ ERRO: {r.status_code}")
        try:
            error = r.json()
            print(json.dumps(error, indent=2))
        except:
            print(f"Response: {r.text[:500]}")

except Exception as e:
    print(f"\n✗ Exceção: {type(e).__name__}: {e}")

print("\n" + "=" * 80)
print("TESTE 2: Requisição com imagem base64 para gpt-5.4")
print("=" * 80)

# Imagem de teste: 1x1 PNG transparente
test_image_base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

body_with_image = {
    "model": "gpt-5.4",
    "max_tokens": 100,
    "messages": [
        {"role": "system", "content": "Você é um assistente que analisa imagens."},
        {"role": "user", "content": [
            {"type": "text", "text": "O que você vê nesta imagem?"},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{test_image_base64}", "detail": "high"}},
        ]},
    ],
}

print("\nRequisição com imagem:")
print(json.dumps(body_with_image, indent=2)[:500] + "...")

try:
    r = requests.post(
        f"{OPENAI_BASE_URL}/v1/chat/completions",
        headers=headers,
        json=body_with_image,
        timeout=30,
    )
    print(f"\nStatus: {r.status_code}")

    if r.status_code == 200:
        print(f"\n✓ SUCESSO")
        print(f"Resposta: {r.json()['choices'][0]['message']['content']}")
    else:
        print(f"\n✗ ERRO: {r.status_code}")
        try:
            error = r.json()
            print(json.dumps(error, indent=2))
        except:
            print(f"Response: {r.text[:500]}")

except Exception as e:
    print(f"\n✗ Exceção: {type(e).__name__}: {e}")

print("\n" + "=" * 80)
print("TESTE 3: Verificar modelos disponíveis")
print("=" * 80)

try:
    r = requests.get(
        f"{OPENAI_BASE_URL}/v1/models",
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
        timeout=30,
    )
    if r.status_code == 200:
        models = r.json()["data"]
        print(f"\nTotal de modelos: {len(models)}")
        print("Modelos contendo '5' ou 'gpt':")
        for m in models:
            mid = m["id"]
            if "5" in mid or "gpt" in mid:
                print(f"  {mid}")
    else:
        print(f"Erro: {r.status_code}")
except Exception as e:
    print(f"Exceção: {e}")
