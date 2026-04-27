#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json
import os
import requests
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

API_KEY = os.getenv("OPENAI_API_KEY", "")
headers = {"Authorization": f"Bearer {API_KEY}"}

batch_dir = Path(__file__).parent
state_files = sorted(batch_dir.glob("batch_state_*.json"))

print("\n" + "="*80)
print("VERIFICACAO DE BATCHES (via REST API)")
print("="*80 + "\n")

for state_file in state_files:
    with open(state_file) as f:
        state = json.load(f)

    batch_id = state['batch_id']
    print(f"\n[{state_file.name}]")
    print(f"  Batch ID: {batch_id}")

    try:
        url = f"https://api.openai.com/v1/batches/{batch_id}"
        resp = requests.get(url, headers=headers)
        if resp.status_code == 200:
            batch_data = resp.json()
            status = batch_data.get('status')
            counts = batch_data.get('request_counts', {})
            completed = counts.get('completed', 0)
            total = counts.get('total', 0)
            
            print(f"  Status: {status}")
            print(f"  Requisicoes: {completed}/{total}")
            
            if status == 'failed':
                print(f"  [ERRO] Batch falhou!")
            elif status == 'expired':
                print(f"  [EXPIRADO] Batch expirou!")
            elif status == 'completed':
                print(f"  [OK] Batch completado!")
        else:
            print(f"  [ERRO HTTP {resp.status_code}] {resp.text}")

    except Exception as e:
        print(f"  [ERRO] {e}")

print("\n" + "="*80)
