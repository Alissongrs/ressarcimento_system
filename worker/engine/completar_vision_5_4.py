"""Completa campos NULL via gpt-5.4 vision em batches.

Estrategia:
1. Identifica IDs com campos APLICAVEIS ainda NULL apos extracao GPT + regex
2. Acumula ate N candidatos
3. Para cada candidato: baixa imagem do PDF + monta prompt FOCADO so nos NULLs
4. Chama gpt-5.4 vision flex
5. Atualiza banco so nos campos que voltaram preenchidos

Campos APLICAVEIS = NULLs reais (nao "Grupo B sem demanda" que e legitimo).

USO:
  python completar_vision_5_4.py --ids-file ids_teste_2k.txt --max 50
  python completar_vision_5_4.py --ids-file ids_teste_2k.txt --max 50 --workers 5
"""
import argparse
import base64
import io
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import re

import mysql.connector
import requests

from db_env import conexao as _conexao_env  # lê backend/.env (sem senha no código)
DB = _conexao_env("DB_APP_URL")

import os as _os
MODELO = _os.environ.get("MODELO_VISION", "gpt-4.1-mini")
BASE_URL = "https://api.openai.com"

_env = Path(__file__).resolve().parent.parent / "backend" / ".env"
if _env.exists():
    for ln in _env.read_text(encoding="utf-8").splitlines():
        ln = ln.strip()
        if ln and not ln.startswith("#") and "=" in ln:
            k, _, v = ln.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

OPENAI_KEY = os.environ.get("OPENAI_API_KEY")
# Sem chave: este módulo ainda pode ser importado (extrator_v2/complementar só usam o DB);
# a verificação fica em _exigir_chave(), chamada antes de qualquer pedido à OpenAI.
def _exigir_chave():
    if not OPENAI_KEY:
        print("[ERRO] OPENAI_API_KEY nao definido")
        sys.exit(1)

# Campos que vision deve tentar preencher (so quando aplicavel)
CAMPOS_VISION = {
    # Leituras
    "leit_ant_ativa_ponta": "Leitura ANTERIOR do medidor — POSTO PONTA (HP)",
    "leit_atu_ativa_ponta": "Leitura ATUAL do medidor — POSTO PONTA (HP)",
    "leit_ant_ativa_fponta": "Leitura ANTERIOR — FORA PONTA (HFP)",
    "leit_atu_ativa_fponta": "Leitura ATUAL — FORA PONTA (HFP)",
    "leit_ant_reativa": "Leitura anterior REATIVA (kVArh)",
    "leit_atu_reativa": "Leitura atual REATIVA (kVArh)",
    "leit_demanda_ponta": "Leitura/demanda registrada PONTA (kW)",
    "leit_demanda_fponta": "Leitura/demanda registrada FORA PONTA (kW)",
    # Consumo
    "consumo_ativo_ponta_kwh": "Consumo ativo PONTA em kWh",
    "consumo_ativo_fponta_kwh": "Consumo ativo FORA PONTA em kWh",
    "consumo_reativo_kvarh": "Consumo reativo total em kVArh",
    "consumo_reativo_excedente_kvarh": "Consumo reativo excedente UFER em kVArh",
    # Demanda
    "demanda_faturada_ponta_kw": "Demanda faturada PONTA (kW)",
    "demanda_faturada_fponta_kw": "Demanda faturada FORA PONTA (kW)",
    "demanda_contratada_ponta_kw": "Demanda CONTRATADA PONTA (kW)",
    "demanda_contratada_fponta_kw": "Demanda CONTRATADA FORA PONTA (kW)",
    "demanda_reativa_excedente_kvar": "Demanda reativa excedente DMCR (kVAr)",
    # Tarifas
    "tarifa_te": "Tarifa TE (energia) R$/kWh — última coluna sem tributos",
    "tarifa_tusd": "Tarifa TUSD (distribuição) R$/kWh — sem tributos",
    "tarifa_demanda": "Tarifa demanda R$/kW",
    # Fatores
    "fator_carga": "Fator de carga (decimal 0-1)",
    "fator_potencia": "Fator de potencia (decimal 0-1)",
    # Valores
    "valor_energia_ativa": "Valor R$ energia ativa total",
    "valor_demanda": "Valor R$ demanda",
    "valor_encargos": "Valor R$ encargos setoriais (CDE+PROINFA+ESS)",
    "valor_outros_itens": "Valor R$ outros itens",
    "valor_bandeira_rs": "Valor R$ adicional bandeira",
    "valor_cde": "Valor R$ CDE", "valor_proinfa": "Valor R$ PROINFA", "valor_ess": "Valor R$ ESS",
    "valor_energia_reativa": "Valor R$ energia reativa",
    "valor_energia_reativa_excedente": "Valor R$ reativo excedente",
    "valor_demanda_reativa_excedente": "Valor R$ demanda reativa excedente",
    "reativo_excedente_rs": "Valor R$ TOTAL reativo excedente (UFER+DMCR)",
    # GD
    "energia_injetada_kwh": "Energia injetada GD (kWh)",
    "energia_compensada_kwh": "Energia compensada GD (kWh)",
    "saldo_credito_energia": "Saldo credito GD (kWh)",
    # Diversos
    "perda_transformacao_percentual": "Perda transformacao (%)",
    "periodo_bandeira": "Periodo da bandeira (ex: '01/03/2026 a 31/03/2026')",
    "tipo_bandeira": "Cor bandeira (VERDE/AMARELA/VERMELHA P1/P2)",
    "tarifa_te": "Tarifa TE R$/kWh",
}


def baixar_pdf(url: str) -> bytes | None:
    try:
        r = requests.get(url, timeout=120, stream=True)
        r.raise_for_status()
        return r.content
    except Exception as e:
        print(f"  [ERRO download] {e}")
        return None


def pdf_para_imagens(pdf_bytes: bytes, max_paginas: int = 2) -> list[dict]:
    # Validacao basica de PDF (rejeita HTML de erro ou arquivo muito pequeno)
    if not pdf_bytes or len(pdf_bytes) < 5000:
        return []
    if not pdf_bytes.startswith(b"%PDF"):
        return []
    try:
        import pypdfium2 as pdfium
    except ImportError:
        return []
    try:
        pdf = pdfium.PdfDocument(pdf_bytes)
        n = min(len(pdf), max_paginas)
        imagens = []
        for i in range(n):
            bitmap = pdf[i].render(scale=2.0)
            buf = io.BytesIO()
            bitmap.to_pil().save(buf, format="PNG")
            imagens.append({"base64": base64.b64encode(buf.getvalue()).decode(),
                            "mime": "image/png"})
        return imagens
    except Exception as e:
        print(f"  [render erro] {type(e).__name__}: {e}", flush=True)
        return []


def montar_prompt(campos_null: list[str], dist: str) -> str:
    """Prompt focado nos campos NULL — pede VALOR + ORIGEM por campo.

    A origem (label PDF + secao + valor bruto) permite auditar onde o modelo
    encontrou o dado e detectar quando ele inventa valor plausivel.
    """
    linhas = [f"  - {c}: {CAMPOS_VISION.get(c, c)}" for c in campos_null]
    return f"""Voce eh um extrator de faturas de energia eletrica brasileiras.
Distribuidora: {dist}.

Recebera UMA fatura (1-2 paginas como imagens). Sua tarefa: extrair os
seguintes campos do banco de dados:

{chr(10).join(linhas)}

FORMATO DE RESPOSTA — JSON estrito com 2 sub-objetos:

{{
  "campos": {{
    "fator_potencia": 0.92,
    "consumo_ativo_ponta_kwh": 388,
    ...
  }},
  "origens": {{
    "fator_potencia": {{
      "label": "<texto exato do rotulo na fatura, ex: 'Fator de Potencia'>",
      "secao": "<nome do quadro onde estah, ex: 'Quadro de Medicao'>",
      "valor_bruto": "<valor como impresso, ex: '0,92'>",
      "confianca": <0.0-1.0>
    }},
    ...
  }}
}}

REGRAS CRITICAS:
1. Numeros: float com ponto decimal. NADA de "R$" no valor.
2. Use null se o campo NAO aparece na fatura. NAO CHUTE.
3. Se voce nao consegue ver o rotulo claramente, use confianca <= 0.5.
4. Em "origens.label" coloque o TEXTO EXATO visivel ao lado do valor.
   NUNCA invente um label que nao esta visivel.
5. Em "origens.valor_bruto" coloque o valor EXATAMENTE como aparece
   (com virgula, espaco, etc).
6. Se um campo nao foi encontrado, NAO inclua entrada para ele em "origens".

Retorne SO o JSON, sem texto extra, sem markdown wrapper."""


# JSONL append thread-safe — usado pra registrar origem de cada campo extraido
import threading
_ORIGENS_LOCK = threading.Lock()
ORIGENS_JSONL = Path(__file__).parent / "vision_origens.jsonl"


def _gravar_origens(fid: int, modelo: str, dist: str, campos: dict, origens: dict):
    """Grava 1 linha JSONL por fatura processada com campos + origens."""
    if not origens and not campos:
        return
    line = {
        "id": fid,
        "modelo": modelo,
        "distribuidora": dist,
        "ts": int(time.time()),
        "campos": {k: v for k, v in campos.items() if v not in (None, "")},
        "origens": origens or {},
    }
    with _ORIGENS_LOCK:
        with open(ORIGENS_JSONL, "a", encoding="utf-8") as f:
            f.write(json.dumps(line, ensure_ascii=False) + "\n")


def chamar_vision(content: list, max_retries: int = 3) -> dict:
    _exigir_chave()
    body = {
        "model": MODELO,
        "messages": [{"role": "user", "content": content}],
        "response_format": {"type": "json_object"},
        "max_completion_tokens": 4000,
    }
    # flex tier so eh suportado pelos modelos gpt-5.x / o-series
    if MODELO.startswith("gpt-5") or MODELO.startswith("o"):
        body["service_tier"] = "flex"
    headers = {"Authorization": f"Bearer {OPENAI_KEY}",
               "Content-Type": "application/json"}
    last = None
    for t in range(max_retries):
        try:
            r = requests.post(f"{BASE_URL}/v1/chat/completions",
                              headers=headers, json=body, timeout=600)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (429, 503):
                last = f"HTTP {r.status_code}"
                time.sleep(min(60, 10 * (2 ** t)))
                continue
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:300]}")
        except requests.exceptions.RequestException as e:
            last = f"{type(e).__name__}: {e}"
            time.sleep(min(60, 10 * (2 ** t)))
    raise RuntimeError(f"Falha apos {max_retries}: {last}")


def processar(row: dict, _ignored=None) -> dict:
    fid = row["id"]; dist = row["distribuidora"] or "?"
    campos_null = row["_campos_null"]
    if not campos_null or not row["link_fatura"]:
        return {"id": fid, "skip": True}

    print(f"\n  [{fid}/{dist}] {len(campos_null)} campos NULL...", flush=True)

    # Marca timestamp ANTES de processar — evita re-tentar se travar
    try:
        c0 = mysql.connector.connect(**DB)
        cu0 = c0.cursor()
        cu0.execute("UPDATE FATURA_DADOS_EXTRAIDOS SET extracao_revisao_em=NOW(), extracao_modelo_revisor=%s WHERE id=%s",
                    (MODELO + "-vision", fid))
        c0.commit(); cu0.close(); c0.close()
    except Exception:
        pass
    pdf = baixar_pdf(row["link_fatura"])
    if not pdf:
        return {"id": fid, "erro": "download"}
    imagens = pdf_para_imagens(pdf, max_paginas=2)
    if not imagens:
        return {"id": fid, "erro": "render"}

    prompt = montar_prompt(campos_null, dist)
    content = [{"type": "text", "text": prompt}]
    for img in imagens:
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:{img['mime']};base64,{img['base64']}"}
        })

    t0 = time.time()
    try:
        resp = chamar_vision(content)
        raw = resp["choices"][0]["message"]["content"]
        data = json.loads(raw)
    except Exception as e:
        return {"id": fid, "erro": str(e)[:200]}

    # Novo formato: {"campos": {...}, "origens": {...}}
    # Backward-compat: aceita formato flat antigo tambem
    campos_resp = data.get("campos") if isinstance(data.get("campos"), dict) else data
    origens_resp = data.get("origens") if isinstance(data.get("origens"), dict) else {}

    # Filtra so campos que voltaram com valor nao-null
    atualizado = {}
    for c in campos_null:
        v = campos_resp.get(c)
        if v is None or v == "":
            continue
        atualizado[c] = v

    # Grava origens (mesmo se "atualizado" estiver vazio — auditoria de delirio)
    try:
        _gravar_origens(fid, MODELO, dist, campos_resp, origens_resp)
    except Exception as e:
        print(f"  [{fid}] WARN: nao gravou origens: {e}", flush=True)

    if not atualizado:
        print(f"  [{fid}] sem ganhos em {time.time()-t0:.0f}s")
        return {"id": fid, "preenchidos": 0}

    # UPDATE — conexao propria por thread (evita corrupcao)
    conn2 = mysql.connector.connect(**DB)
    cur = conn2.cursor()
    sets, vals = [], []
    for c, v in atualizado.items():
        if isinstance(v, (int, float)):
            sets.append(f"`{c}` = %s"); vals.append(float(v))
        else:
            s = str(v)[:200]
            sets.append(f"`{c}` = %s"); vals.append(s)
    vals.append(fid)
    cur.execute(f"UPDATE FATURA_DADOS_EXTRAIDOS SET {', '.join(sets)} WHERE id=%s", vals)
    conn2.commit(); cur.close(); conn2.close()
    print(f"  [{fid}] +{len(atualizado)} em {time.time()-t0:.0f}s | tokens={resp.get('usage',{}).get('total_tokens')}")
    return {"id": fid, "preenchidos": len(atualizado), "campos": list(atualizado.keys())}


def selecionar_candidatos(ids: list[int], min_nulls: int, ignore_revisao: bool = False) -> list[dict]:
    """Seleciona IDs com >= min_nulls campos APLICAVEIS ainda NULL.

    Se ignore_revisao=True, ignora o filtro "extracao_revisao_em <7d" —
    util pra rodar 2o pass (modelo melhor) sobre IDs ja processados que
    ainda tem NULLs aplicaveis.
    """
    placeholders = ",".join(["%s"] * len(ids))
    campos_sql = ", ".join([f"`{c}`" for c in CAMPOS_VISION])
    filtro_revisao = "" if ignore_revisao else \
        "AND (extracao_revisao_em IS NULL OR extracao_revisao_em < NOW() - INTERVAL 7 DAY)"
    conn = mysql.connector.connect(**DB)
    cur = conn.cursor(dictionary=True)
    cur.execute(f"""
        SELECT id, distribuidora, link_fatura, grupo_tarifario, modalidade_tarifaria,
               indicacao_impedimento_leitura,
               {campos_sql}
        FROM FATURA_DADOS_EXTRAIDOS
        WHERE id IN ({placeholders})
          AND (link_fatura LIKE 'https://storage.googleapis.com/%'
               OR link_fatura LIKE 'https://sgevia.com.br/%')
          AND (indicacao_impedimento_leitura IS NULL OR indicacao_impedimento_leitura=0)
          {filtro_revisao}
    """, ids)
    rows = cur.fetchall()
    cur.close(); conn.close()

    candidatos = []
    for r in rows:
        nulls = []
        grupo = r.get("grupo_tarifario") or ""
        modal = (r.get("modalidade_tarifaria") or "").upper()
        for c in CAMPOS_VISION:
            if r.get(c) is not None:
                continue
            # Filtro de aplicabilidade — pula campos certamente nao-aplicaveis
            if grupo == "B":
                # B convencional: pula demanda/leit_demanda/reativo/fponta
                if any(k in c for k in ["demanda", "reativa", "reativo",
                                         "ess", "proinfa", "cde",
                                         "perda", "fponta", "fator_potencia",
                                         "fator_carga"]):
                    continue
            if "AZUL" not in modal:
                # Modalidade Verde NAO tem demanda PONTA separada
                if "demanda" in c and "ponta" in c and "fponta" not in c:
                    continue
            nulls.append(c)
        if len(nulls) >= min_nulls:
            r["_campos_null"] = nulls
            candidatos.append(r)
    return candidatos


def main():
    _exigir_chave()
    p = argparse.ArgumentParser()
    p.add_argument("--ids-file", required=True)
    p.add_argument("--max", type=int, default=50, help="N candidatos a processar")
    p.add_argument("--min-nulls", type=int, default=5, help="Min NULLs aplicaveis pra acumular")
    p.add_argument("--workers", type=int, default=5)
    p.add_argument("--ignore-revisao", action="store_true",
                   help="Reprocessa IDs ja revisados <7d (uso: 2o pass tiered)")
    args = p.parse_args()

    ids = [int(x) for x in Path(args.ids_file).read_text().split() if x.strip().isdigit()]
    print(f"Total IDs: {len(ids)}")
    print(f"Modelo: {MODELO} | ignore_revisao={args.ignore_revisao}")

    print(f"Selecionando candidatos com >={args.min_nulls} NULLs aplicaveis...")
    cands = selecionar_candidatos(ids, args.min_nulls, args.ignore_revisao)
    print(f"  {len(cands)} candidatos elegiveis")
    cands = cands[:args.max]
    print(f"  Processando {len(cands)} (limite --max)")

    # Custo estimado: ~$0.05/fatura com vision flex
    custo = len(cands) * 0.05
    print(f"  Custo estimado: ~${custo:.2f}")

    inicio = time.time()
    total_preenchidos = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(processar, c): c for c in cands}
        for f in as_completed(futs):
            try:
                res = f.result()
                if "preenchidos" in res:
                    total_preenchidos += res["preenchidos"]
            except Exception as e:
                print(f"  [ERRO] {e}")

    print(f"\n[OK] Total preenchimentos: {total_preenchidos}")
    print(f"     Tempo: {(time.time()-inicio)/60:.1f}min")


if __name__ == "__main__":
    main()
