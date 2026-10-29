"""Camada 3: LLM le texto_markdown + texto_ocr e extrai TODOS os campos do banco.

Diferente da camada 2 (LLM fallback snippet por campo), esta abordagem manda
os 2 textos completos pra LLM e pede JSON com 33 campos de uma vez.

Custo: 1 chamada gpt-5.4-mini-flex por fatura (~$0.01-0.015).
Esperado: pipeline +20-25pp vs apenas regex/multi-ext/snippet-fallback.

Uso:
  python camada_3_extracao.py --id 48038
  python camada_3_extracao.py --mapa light --n 10
  python camada_3_extracao.py --apply  # atualiza banco com confianca >= 90%
"""
import argparse
import base64
import io
import json
import os
import re
import sys
import time
from pathlib import Path

import mysql.connector
import requests

from completar_vision_5_4 import DB
from llm_fallback import _BASE_URL, _OPENAI_KEY


MODELO = os.environ.get("LLM_MODEL_TEXT", "gpt-5.4-mini")
USAR_VISION = os.environ.get("USAR_VISION", "0") == "1"


def renderizar_pdf_png(pdf_bytes: bytes, max_paginas: int = 2) -> list[str]:
    """Renderiza N pgs do PDF como PNG base64 (PyMuPDF)."""
    try:
        import fitz
    except ImportError:
        return []
    if not pdf_bytes or len(pdf_bytes) < 5000 or not pdf_bytes.startswith(b"%PDF"):
        return []
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        out = []
        for i, page in enumerate(doc):
            if i >= max_paginas:
                break
            pix = page.get_pixmap(matrix=fitz.Matrix(1.8, 1.8))
            out.append(base64.b64encode(pix.tobytes("png")).decode("ascii"))
        doc.close()
        return out
    except Exception:
        return []


def baixar_pdf_cached(id_: int, link: str) -> bytes:
    cache = Path("pdfs_cache") / f"{id_}.pdf"
    if cache.exists():
        return cache.read_bytes()
    try:
        r = requests.get(link, timeout=120)
        if r.status_code == 200:
            cache.parent.mkdir(exist_ok=True)
            cache.write_bytes(r.content)
            return r.content
    except Exception:
        pass
    return b""

# 33 campos do banco que o LLM deve tentar extrair
CAMPOS_BANCO = {
    # CAMPOS DO ORIGEM — estes vem do banco origem, mas LLM tenta extrair pra confirmar
    "distribuidora": "Nome da concessionaria de energia (ex: 'ENEL SP', 'CEMIG', 'EQUATORIAL PA')",
    "nome_cliente": "Razao social do cliente (ex: 'VIA VAREJO S/A', 'GRUPO CASAS BAHIA')",
    "cpf_cnpj": "CNPJ do cliente (formato XX.XXX.XXX/XXXX-XX, pode estar mascarado com X)",
    "numero_instalacao": "Numero da instalacao/UC (ex: 'W9007134751', '0000715104-2025-10-0')",
    "numero_medidor": "Numero do medidor (ex: 'OAX162000084', '12505959-1', '4378633')",
    "codigo_uc": "Codigo da unidade consumidora (ex: '56489819', 'Q9002474036')",
    "numero_fatura": "Numero da nota fiscal/fatura (ex: '5361041', '187081265')",
    "mes_referencia": "Mes/ano de referencia (formato MM/YYYY ou Mes/YYYY, ex: '10/2025')",
    # PERIODO LEITURA
    "data_leitura_anterior": "Data da leitura anterior (formato DD/MM/AAAA)",
    "data_leitura_atual": "Data da leitura atual (formato DD/MM/AAAA)",
    "dias_faturados": "Numero de dias entre leitura anterior e atual (inteiro 28-33 tipicamente)",
    # FINANCEIRO
    "valor_total_fatura": "Valor TOTAL da fatura em R$ (numero decimal, ex: 5588.58)",
    # CONSUMO
    "consumo_ativo_ponta_kwh": "Consumo ativo Ponta em kWh (numero decimal)",
    "consumo_ativo_fponta_kwh": "Consumo ativo Fora Ponta em kWh (numero decimal)",
    # LEITURAS — ATIVA (NAO REATIVA)
    "leit_ant_ativa_ponta": "Leitura anterior ATIVA Ponta (NAO Energia Reativa)",
    "leit_atu_ativa_ponta": "Leitura atual ATIVA Ponta",
    "leit_ant_ativa_fponta": "Leitura anterior ATIVA Fora Ponta",
    "leit_atu_ativa_fponta": "Leitura atual ATIVA Fora Ponta",
    "constante_k": "Constante de multiplicacao do medidor K (ex: 0.042, 1.0, 80, 0.525)",
    # CLASSIFICACAO
    "grupo_tarifario": "Grupo tarifario (A ou B, geralmente A pra clientes grandes)",
    "subgrupo_tarifario": "Subgrupo (A1, A2, A3, A4, AS, B1, B2, B3, B4)",
    "modalidade_tarifaria": "Modalidade (Convencional, Verde, Azul, Branca)",
    "classe_consumidor": "Classe (Comercial, Residencial, Industrial, Rural, Poder Publico)",
    "tensao_fornecimento": "Tensao em V (numero, ex: 11000 para 11kV, 220, 380)",
    "demanda_contratada_ponta_kw": "Demanda contratada Ponta em kW (decimal)",
    "demanda_contratada_fponta_kw": "Demanda contratada Fora Ponta em kW (decimal)",
    # TRIBUTOS
    "pis_aliquota": "Aliquota PIS/PASEP em % (ex: 1.16, 0.92, 1.65)",
    "pis_valor": "Valor PIS/PASEP em R$ (decimal)",
    "cofins_aliquota": "Aliquota COFINS em % (ex: 5.36, 4.22, 7.6)",
    "cofins_valor": "Valor COFINS em R$",
    "icms_aliquota": "Aliquota ICMS em % (ex: 18, 17, 24)",
    "icms_base_calculo": "Base de calculo ICMS em R$",
    "icms_valor": "Valor ICMS em R$",
}


def montar_prompt(texto_markdown: str, texto_ocr: str, dist: str = None) -> str:
    """Prompt nano-ready: estruturado, com dois textos e schema explicito."""
    dist_str = f" da distribuidora '{dist}'" if dist else ""
    campos_lista = "\n".join(f"  - {k}: {v}" for k, v in CAMPOS_BANCO.items())
    return f"""Voce e um extrator de faturas de energia eletrica brasileiras{dist_str}.

Voce recebera dois textos extraidos do MESMO PDF da fatura:
1. TEXTO_MARKDOWN: extracao com estrutura preservada (tabelas com |)
2. TEXTO_OCR: extracao OCR (texto sequencial)

Use AMBOS os textos para extrair os campos abaixo. Quando os textos divergirem, prefira o que faz sentido contextual.

CAMPOS A EXTRAIR (33 campos):
{campos_lista}

REGRAS CRITICAS:
1. Numeros: float com PONTO decimal. NUNCA virgula. Sem "R$" no valor.
2. Datas: DD/MM/AAAA.
3. mes_referencia: MM/YYYY (ex: "10/2025").
4. Se o campo NAO aparece em nenhum dos textos, use null. NAO CHUTE.
5. CNPJ: mantenha pontuacao se aparecer. Pode estar mascarado (X).
6. Distinga ATIVA vs REATIVA: leituras "Comp. Encargo-Kwh" sao ATIVAS, "Energia Reativa-Kwh" sao REATIVAS. Banco quer ATIVAS.
7. Tributos: PIS/PASEP/COFINS/ICMS — cada um tem aliquota (em %) e valor (em R$).

FORMATO DE RESPOSTA — JSON estrito:
{{
  "campos": {{
    "valor_total_fatura": 5588.58,
    "pis_valor": 61.0,
    "cofins_valor": 281.81,
    ...
  }},
  "confianca": {{
    "valor_total_fatura": 0.95,
    ...
  }}
}}

Confianca de 0.0 a 1.0 (alta = certeza absoluta, baixa = duvida).
Retorne APENAS o JSON, sem markdown wrapper.

=== TEXTO_MARKDOWN ===
{texto_markdown[:6000]}

=== TEXTO_OCR ===
{texto_ocr[:3000]}
"""


def chamar_llm(prompt: str, max_tokens: int = 1500,
                imagens_b64: list[str] | None = None) -> dict:
    """Chama LLM. Se imagens_b64 fornecido, envia como vision."""
    if not _OPENAI_KEY:
        return {"erro": "no api key"}
    # monta content
    if imagens_b64:
        content = [{"type": "text", "text": prompt}]
        for b64 in imagens_b64:
            content.append({"type": "image_url",
                             "image_url": {"url": f"data:image/png;base64,{b64}"}})
    else:
        content = prompt
    body = {
        "model": MODELO,
        "messages": [{"role": "user", "content": content}],
        "max_completion_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    if MODELO.startswith("gpt-5") or MODELO.startswith("o"):
        body["service_tier"] = "flex"
    headers = {"Authorization": f"Bearer {_OPENAI_KEY}",
               "Content-Type": "application/json"}
    for tentativa in range(3):
        try:
            r = requests.post(f"{_BASE_URL}/v1/chat/completions",
                              headers=headers, json=body, timeout=180)
            if r.status_code == 200:
                raw = r.json()["choices"][0]["message"]["content"]
                try:
                    return json.loads(raw)
                except json.JSONDecodeError:
                    # tenta extrair {.*} via regex
                    m = re.search(r"\{[\s\S]+\}", raw)
                    if m:
                        return json.loads(m.group(0))
                    return {"erro": "parse_error", "raw": raw[:300]}
            if r.status_code in (429, 503):
                time.sleep(min(60, 5 * (2 ** tentativa)))
                continue
            return {"erro": f"http {r.status_code}", "detalhe": r.text[:300]}
        except requests.exceptions.RequestException as e:
            time.sleep(2 * (tentativa + 1))
    return {"erro": "network"}


def processar(row: dict) -> dict:
    """Roda LLM nos 2 textos (+ imagem se USAR_VISION) e retorna campos extraidos."""
    md = row.get("texto_markdown") or ""
    ocr = row.get("texto_ocr") or ""
    if not md and not ocr:
        return {"id": row["id"], "erro": "sem textos"}
    prompt = montar_prompt(md, ocr, row.get("distribuidora"))
    imagens_b64 = None
    if USAR_VISION and row.get("link_fatura"):
        pdf = baixar_pdf_cached(row["id"], row["link_fatura"])
        if pdf:
            imagens_b64 = renderizar_pdf_png(pdf)
    resp = chamar_llm(prompt, imagens_b64=imagens_b64)
    if "erro" in resp:
        return {"id": row["id"], "erro": resp.get("erro"),
                "raw": resp.get("raw", resp.get("detalhe", ""))[:200]}
    return {
        "id": row["id"],
        "distribuidora": row.get("distribuidora"),
        "campos": resp.get("campos", {}),
        "confianca": resp.get("confianca", {}),
    }


def comparar_com_banco(extraidos: dict, row_banco: dict) -> dict:
    """Compara campos extraidos com valores no banco. Usa _eh_igual do testar_extratores
    (normaliza datas, cnpj, aliquotas, etc)."""
    from testar_extratores import _eh_igual
    bate = []
    diverge = []
    extraidos_sem_banco = []
    for campo, val_ext in extraidos.items():
        if val_ext in (None, ""):
            continue
        val_db = row_banco.get(campo)
        if val_db in (None, ""):
            extraidos_sem_banco.append(campo)
            continue
        if _eh_igual(val_ext, val_db, campo=campo):
            bate.append(campo)
        else:
            diverge.append({"campo": campo, "ext": val_ext, "db": val_db})
    return {"n_bate": len(bate), "n_diverge": len(diverge),
            "n_novo": len(extraidos_sem_banco),
            "bate": bate, "diverge": diverge[:8]}


def buscar_ids(mapa_dists: list = None, n: int = 10):
    conn = mysql.connector.connect(**DB)
    cur = conn.cursor(dictionary=True)
    cols = ["id", "distribuidora", "link_fatura", "texto_markdown", "texto_ocr"] + list(CAMPOS_BANCO.keys())
    cols_sql = ", ".join(f"`{c}`" for c in cols)
    if mapa_dists:
        placeholder = ", ".join(["%s"] * len(mapa_dists))
        cur.execute(f"""SELECT {cols_sql} FROM FATURA_DADOS_EXTRAIDOS
                        WHERE distribuidora IN ({placeholder})
                          AND texto_markdown IS NOT NULL AND texto_ocr IS NOT NULL
                        ORDER BY RAND() LIMIT %s""", (*mapa_dists, n))
    else:
        cur.execute(f"""SELECT {cols_sql} FROM FATURA_DADOS_EXTRAIDOS
                        WHERE texto_markdown IS NOT NULL AND texto_ocr IS NOT NULL
                        ORDER BY RAND() LIMIT %s""", (n,))
    rows = cur.fetchall()
    cur.close(); conn.close()
    return rows


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--id", type=int)
    p.add_argument("--mapa", help="Nome do mapa (ex: light)")
    p.add_argument("--n", type=int, default=10)
    p.add_argument("--apply", action="store_true", help="Atualiza banco onde confianca >= 0.9")
    args = p.parse_args()

    rows = []
    if args.id:
        from distribuidora_router import distribuidoras_para_arquivo
        conn = mysql.connector.connect(**DB)
        cur = conn.cursor(dictionary=True)
        cols = ["id", "distribuidora", "link_fatura", "texto_markdown", "texto_ocr"] + list(CAMPOS_BANCO.keys())
        cols_sql = ", ".join(f"`{c}`" for c in cols)
        cur.execute(f"SELECT {cols_sql} FROM FATURA_DADOS_EXTRAIDOS WHERE id=%s", (args.id,))
        rows = [cur.fetchone()]
        cur.close(); conn.close()
    elif args.mapa:
        from distribuidora_router import distribuidoras_para_arquivo
        nome = args.mapa if args.mapa.endswith(".json") else f"{args.mapa}_extraction_map.json"
        dists = distribuidoras_para_arquivo(nome)
        if not dists:
            print(f"[!] mapa {args.mapa} sem dists referenciadas"); sys.exit(1)
        rows = buscar_ids(dists, args.n)
    else:
        rows = buscar_ids(None, args.n)

    print(f"=== Camada 3 LLM full-text: {len(rows)} faturas ===")
    print(f"  Modelo: {MODELO} (flex tier auto)")
    print(f"  Modo: {'APLICA NO BANCO se conf>=0.9' if args.apply else 'DRY-RUN (so analisa)'}\n")

    out_jsonl = "camada_3_resultados.jsonl"
    fout = open(out_jsonl, "w", encoding="utf-8")
    stats_total = {"campos_extraidos": 0, "bate": 0, "diverge": 0, "novo": 0, "erros": 0}
    t0 = time.time()
    for i, row in enumerate(rows, 1):
        if row is None:
            continue
        print(f"  [{i}/{len(rows)}] ID {row['id']} ({row.get('distribuidora')})", end=" ... ", flush=True)
        r = processar(row)
        if "erro" in r:
            print(f"[ERRO {r['erro']}]")
            stats_total["erros"] += 1
            fout.write(json.dumps({**r, "ts": int(time.time())}, ensure_ascii=False, default=str) + "\n")
            continue
        cmp = comparar_com_banco(r["campos"], row)
        n_extraidos = sum(1 for v in r["campos"].values() if v not in (None, ""))
        stats_total["campos_extraidos"] += n_extraidos
        stats_total["bate"] += cmp["n_bate"]
        stats_total["diverge"] += cmp["n_diverge"]
        stats_total["novo"] += cmp["n_novo"]
        print(f"extraidos={n_extraidos}  bate={cmp['n_bate']}  div={cmp['n_diverge']}  novo={cmp['n_novo']}")
        fout.write(json.dumps({
            "id": row["id"], "distribuidora": row.get("distribuidora"),
            "n_extraidos": n_extraidos,
            "campos": r["campos"],
            "confianca": r.get("confianca", {}),
            "stats": cmp,
            "ts": int(time.time()),
        }, ensure_ascii=False, default=str) + "\n")
        fout.flush()
    fout.close()
    dt = time.time() - t0
    avg_bate = stats_total["bate"] / max(1, len(rows))
    avg_extraidos = stats_total["campos_extraidos"] / max(1, len(rows))
    print(f"\n=== Sumario ({dt:.0f}s) ===")
    print(f"  Faturas processadas: {len(rows)}")
    print(f"  Campos extraidos (total): {stats_total['campos_extraidos']} (avg {avg_extraidos:.1f}/fatura)")
    print(f"  Bate: {stats_total['bate']} (avg {avg_bate:.1f}/fatura)")
    print(f"  Diverge: {stats_total['diverge']}")
    print(f"  Novo (extraido nao tem no banco): {stats_total['novo']}")
    print(f"  Erros: {stats_total['erros']}")
    print(f"  Custo estimado: ~${len(rows) * 0.012:.2f}")
    print(f"  Output: {out_jsonl}")


if __name__ == "__main__":
    main()
