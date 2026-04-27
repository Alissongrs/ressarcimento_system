#!/usr/bin/env python3
"""
analisar_com_motores_ia.py
──────────────────────────────────────────────────────────────────────────────
Pipeline de Análise Inteligente em 2 etapas:

  Etapa 1 — Triagem com prompt_confirmar.txt:
    Lê as 3 fontes (analise_IA do 4.1-mini, resultado_regras dos motores SQL,
    texto OCR da fatura) e aplica o prompt_confirmar.txt para identificar
    fichas confirmadas e extrair CAMPOS_JSON da fatura.

  Etapa 2 — Decisão final com gpt-5.4 (só se etapa 1 confirmou algo):
    Envia tudo (análise da etapa 1 + resultado_regras + fichas confirmadas)
    para o gpt-5.4 decidir: CONFIRMADO / REFUTADO / INCONCLUSIVO +
    percentual de ressarcimento, confiança, justificativa e recomendação.

Resultado gravado em Faturas_Registradas_Cache.resultado_analises (JSON)
e resultado_final_em.

Uso:
  python analisar_com_motores_ia.py --empresa 14
  python analisar_com_motores_ia.py --empresa 4 14 32
  python analisar_com_motores_ia.py --apenas-top-20
  python analisar_com_motores_ia.py --dry-run
"""

import argparse
import base64
import io
import json
import logging
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import mysql.connector
import requests
from openai import OpenAI
from dotenv import load_dotenv
import os

try:
    import pypdfium2 as pdfium
    HAS_PDFIUM = True
except ImportError:
    HAS_PDFIUM = False

# ─── Config ──────────────────────────────────────────────────────────────────

load_dotenv(Path(__file__).parent / ".env")

DB = dict(
    host               = "db-acesso-ressarcimento.cvicxzrqb58o.us-east-2.rds.amazonaws.com",
    port               = 3306,
    user               = "super_user_ressarcimento",
    password           = "qZ8YbD3GxK9uN4RmV2sAeT7LwBjCp5X0",
    database           = "db_ressarcimento",
    charset            = "utf8mb4",
    connection_timeout = 60,
    use_pure           = True,
    ssl_disabled       = True,
)

MODELO_TRIAGEM  = "gpt-4.1-mini"   # etapa 1 — mais barato
MODELO_DECISAO  = "gpt-5.4"        # etapa 2 — decisão final

API_KEY         = os.getenv("OPENAI_API_KEY", "")
BASE_URL        = "https://api.openai.com"
MAX_BATCH_BYTES = 190 * 1024 * 1024
MAX_PAGINAS_PDF = 4   # páginas máximas enviadas como imagem para o gpt-5.4

_BASE_DIR   = Path(__file__).parent
_PROMPT_CONFIRMAR = (
    Path(__file__).parent.parent / "backend" / "data" / "prompt_confirmar.txt"
)

# ─── Logging ─────────────────────────────────────────────────────────────────

logging.basicConfig(
    level    = logging.INFO,
    format   = "%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt  = "%Y-%m-%d %H:%M:%S",
    handlers = [
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("analisar_com_motores_ia.log", encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)

# ─── Busca faturas ────────────────────────────────────────────────────────────

def buscar_faturas(cur, empresas: list[int] | None, top_n: int | None) -> list[dict]:
    """
    Retorna faturas com analise_IA = CONFIRMADO.
    resultado_regras pode ser nulo — o motor SQL pode ainda nao ter rodado.
    """
    sql_empresas = ""
    if empresas:
        sql_empresas = f"AND f.Cod_Empresa IN ({', '.join(str(e) for e in empresas)})"

    sql_limit = f"LIMIT {top_n}" if top_n else ""

    query = f"""
    SELECT
        f.id,
        f.UC,
        f.RS_Total_Fatura       AS valor,
        f.Concessionaria,
        f.Mes_Ref,
        f.Cod_Empresa,
        JSON_EXTRACT(f.analise_IA, '$.resultado.ia_status')               AS ia_status,
        JSON_EXTRACT(f.analise_IA, '$.resultado.ia_fichas_confirmadas')   AS ia_fichas,
        JSON_EXTRACT(f.analise_IA, '$.resultado.analise_texto')           AS ia_analise_texto,
        f.resultado_regras,
        COALESCE(f.texto_plumber, f.texto_markitdown, f.texto_ocr, '')    AS texto_fatura,
        COALESCE(f.Link, '')                                               AS link
    FROM Faturas_Registradas_Cache f
    WHERE JSON_EXTRACT(f.analise_IA, '$.resultado.ia_status') = 'CONFIRMADO'
      {sql_empresas}
    ORDER BY f.RS_Total_Fatura DESC
    {sql_limit}
    """
    cur.execute(query)
    rows = cur.fetchall()

    faturas = []
    for row in rows:
        try:
            ia_fichas = row["ia_fichas"]
            if ia_fichas:
                fichas = json.loads(ia_fichas) if isinstance(ia_fichas, str) else ia_fichas
                if not isinstance(fichas, list):
                    fichas = [fichas]
            else:
                fichas = []

            resultado_regras = row["resultado_regras"]
            if resultado_regras and isinstance(resultado_regras, str):
                try:
                    resultado_regras = json.loads(resultado_regras)
                except json.JSONDecodeError:
                    resultado_regras = {}

            ia_analise_texto = row["ia_analise_texto"] or ""
            if isinstance(ia_analise_texto, bytes):
                ia_analise_texto = ia_analise_texto.decode("utf-8", errors="replace")

            faturas.append({
                "id"              : row["id"],
                "UC"              : row["UC"],
                "valor"           : float(row["valor"] or 0),
                "concessionaria"  : row["Concessionaria"],
                "mes_ref"         : str(row["Mes_Ref"] or ""),
                "ia_fichas"       : fichas,
                "ia_analise_texto": ia_analise_texto,
                "resultado_regras": resultado_regras or {},
                "texto_fatura"    : row["texto_fatura"] or "",
                "link"            : str(row.get("link") or "").strip(),
            })
        except Exception as e:
            log.warning(f"Erro ao parsear fatura {row.get('id')}: {e}")
            continue

    return faturas


# ─── Etapa 1: Triagem com prompt_confirmar ────────────────────────────────────

def montar_contexto_triagem(fatura: dict, prompt_confirmar: str) -> str:
    """
    Monta o prompt completo para a etapa de triagem.
    """
    regras = fatura["resultado_regras"]
    fichas_motores = []
    if regras:
        f01 = regras.get("f01_f05", {})
        f06 = regras.get("f06_f14", {})
        fichas_motores = f01.get("fichas", []) + f06.get("fichas", [])

    return f"""{prompt_confirmar}

================================================================================
CONTEXTO COMPLEMENTAR — DADOS DO SISTEMA
================================================================================

=== IDENTIFICAÇÃO DA FATURA ===
ID: {fatura['id']}
UC: {fatura['UC']}
Concessionária: {fatura['concessionaria']}
Período: {fatura['mes_ref']}
Valor Total: R$ {fatura['valor']:,.2f}

=== ANÁLISE PRÉVIA (modelo 4.1-mini) ===
Fichas identificadas: {', '.join(fatura['ia_fichas']) if fatura['ia_fichas'] else 'nenhuma'}
Análise: {fatura['ia_analise_texto'][:2000] if fatura['ia_analise_texto'] else '(não disponível)'}

=== RESULTADO DOS MOTORES DE REGRAS SQL (F01-F14) ===
Fichas apontadas pelos motores: {', '.join(fichas_motores) if fichas_motores else 'nenhuma'}
Detalhes: {json.dumps(regras, ensure_ascii=False, indent=2)[:3000] if regras else '(motor não executado)'}

=== TEXTO DA FATURA (OCR) ===
{fatura['texto_fatura'][:5000]}
"""


def chamar_triagem(client: OpenAI, fatura: dict, prompt_confirmar: str) -> dict:
    """
    Etapa 1: usa MODELO_TRIAGEM + prompt_confirmar para identificar fichas confirmadas.
    Retorna dict com fichas_confirmadas, campos_json e texto_analise.
    """
    prompt = montar_contexto_triagem(fatura, prompt_confirmar)

    try:
        response = client.chat.completions.create(
            model=MODELO_TRIAGEM,
            max_completion_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        texto = response.choices[0].message.content.strip()
    except Exception as e:
        log.error(f"  [Triagem] Erro na chamada IA para ID {fatura['id']}: {e}")
        return {"fichas_confirmadas": [], "campos_json": {}, "texto_analise": "", "erro": str(e)}

    # Extrai CAMPOS_JSON do bloco ---CAMPOS_JSON--- ... ---FIM_CAMPOS_JSON---
    campos_json = {}
    match = re.search(r"---CAMPOS_JSON---\s*(\{[\s\S]*?\})\s*---FIM_CAMPOS_JSON---", texto)
    if match:
        try:
            campos_json = json.loads(match.group(1))
        except json.JSONDecodeError:
            pass

    # Extrai fichas confirmadas do texto (busca padrões como "F01", "F02" etc.)
    fichas_confirmadas = list(dict.fromkeys(re.findall(r'\bF\d{2}\b', texto.upper())))
    # Filtra só fichas que aparecem como CONFIRMADAS (evita mencionar fichas rejeitadas)
    # Heurística: busca fichas perto de "confirmad" no texto
    fichas_confirmadas_reais = []
    for ficha in fichas_confirmadas:
        padrao = rf'\b{ficha}\b[^.]*?confirmad|confirmad[^.]*?\b{ficha}\b'
        if re.search(padrao, texto, re.IGNORECASE):
            fichas_confirmadas_reais.append(ficha)

    return {
        "fichas_confirmadas": fichas_confirmadas_reais or fichas_confirmadas[:3],
        "campos_json"        : campos_json,
        "texto_analise"      : texto[:5000],
    }


# ─── Etapa 2: Decisão final com gpt-5.4 ──────────────────────────────────────

def chamar_decisao_final(client: OpenAI, fatura: dict, triagem: dict) -> dict:
    """
    Etapa 2: usa gpt-5.4 para decisão final combinando triagem + motores SQL.
    """
    regras = fatura["resultado_regras"]
    fichas_motores_f01 = regras.get("f01_f05", {}).get("fichas", []) if regras else []
    fichas_motores_f06 = regras.get("f06_f14", {}).get("fichas", []) if regras else []
    todas_fichas_motores = fichas_motores_f01 + fichas_motores_f06

    prompt = f"""
# DECISÃO FINAL DE RESSARCIMENTO — AUDITOR gpt-5.4

## Fatura
- ID: {fatura['id']}
- UC: {fatura['UC']}
- Concessionária: {fatura['concessionaria']}
- Período: {fatura['mes_ref']}
- Valor Total: R$ {fatura['valor']:,.2f}

## Etapa 1 — Análise do auditor (prompt_confirmar)
Fichas confirmadas na triagem: {', '.join(triagem['fichas_confirmadas']) or 'nenhuma'}
Resumo da análise:
{triagem['texto_analise'][:3000]}

## Etapa 2 — Motores de Regras SQL (F01-F14)
Fichas apontadas pelos motores SQL: {', '.join(todas_fichas_motores) or 'nenhuma'}
Detalhes F01-F05: {json.dumps(regras.get('f01_f05', {}), ensure_ascii=False) if regras else '(não disponível)'}
Detalhes F06-F14: {json.dumps(regras.get('f06_f14', {}), ensure_ascii=False) if regras else '(não disponível)'}

## Campos extraídos da fatura
{json.dumps(triagem['campos_json'], ensure_ascii=False, indent=2)}

---

## Sua tarefa
Compare a análise do auditor com os apontamentos dos motores SQL.
Considere: convergência entre as fontes aumenta a confiança; divergência exige critério.

Responda APENAS com JSON válido:
{{
  "decisao_final": "CONFIRMADO",
  "ficha_principal": "F01",
  "fichas_confirmadas": ["F01"],
  "confianca_final": 88,
  "percentual_ressarcimento": 35,
  "justificativa": "Texto explicativo claro baseado nas evidências",
  "recomendacao": "Ação recomendada"
}}

decisao_final: CONFIRMADO | REFUTADO | INCONCLUSIVO
confianca_final: 0-100
percentual_ressarcimento: 0-100 (percentual do valor da fatura a ressarcir)
"""

    try:
        response = client.chat.completions.create(
            model=MODELO_DECISAO,
            max_completion_tokens=2048,
            messages=[{"role": "user", "content": prompt}],
        )
        texto = response.choices[0].message.content.strip()
    except Exception as e:
        log.error(f"  [Decisao] Erro na chamada IA para ID {fatura['id']}: {e}")
        return {
            "decisao_final"          : "ERRO",
            "ficha_principal"        : "DESCONHECIDA",
            "fichas_confirmadas"     : triagem["fichas_confirmadas"],
            "confianca_final"        : 0,
            "percentual_ressarcimento": 0,
            "justificativa"          : f"Erro ao chamar gpt-5.4: {str(e)[:200]}",
            "recomendacao"           : "Análise manual necessária",
        }

    match = re.search(r'\{[\s\S]*\}', texto)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass

    return {
        "decisao_final"          : "INCONCLUSIVO",
        "ficha_principal"        : triagem["fichas_confirmadas"][0] if triagem["fichas_confirmadas"] else "N/A",
        "fichas_confirmadas"     : triagem["fichas_confirmadas"],
        "confianca_final"        : 50,
        "percentual_ressarcimento": 0,
        "justificativa"          : texto[:500],
        "recomendacao"           : "Análise manual necessária",
    }


# ─── Gravação no banco ────────────────────────────────────────────────────────

def _reconectar() -> tuple:
    """Abre nova conexão MySQL e retorna (conn, cur)."""
    conn = mysql.connector.connect(**DB)
    cur  = conn.cursor(dictionary=True)
    return conn, cur


def gravar_resultado(cur, conn, fatura: dict, triagem: dict, decisao: dict, dry_run: bool):
    resultado_final = {
        "ia_4_1_apontamentos": {
            "fichas" : fatura["ia_fichas"],
            "status" : "CONFIRMADO",
            "analise": fatura["ia_analise_texto"][:1000] if fatura["ia_analise_texto"] else "",
        },
        "triagem_confirmar": {
            "fichas_confirmadas": triagem["fichas_confirmadas"],
            "campos_json"       : triagem["campos_json"],
        },
        "motores_sql": fatura["resultado_regras"],
        "ia_opus_5_4_decisao": decisao,
        "processado_em": datetime.now().isoformat(),
        "modelo": MODELO_DECISAO,
    }

    if dry_run:
        log.info(f"  [DRY-RUN] ID {fatura['id']}: {decisao.get('decisao_final')} | confianca={decisao.get('confianca_final')}%")
        return

    for tentativa in range(3):
        try:
            cur.execute(
                "UPDATE Faturas_Registradas_Cache SET resultado_analises = %s, resultado_final_em = NOW() WHERE id = %s",
                (json.dumps(resultado_final, ensure_ascii=False), fatura["id"]),
            )
            conn.commit()
            log.info(f"  [OK] ID {fatura['id']}: {decisao.get('decisao_final')} | confianca={decisao.get('confianca_final')}% | ressarcimento={decisao.get('percentual_ressarcimento')}%")
            return
        except Exception as e:
            log.warning(f"  [RETRY {tentativa+1}] ID {fatura['id']}: {e}")
            try:
                conn.rollback()
            except Exception:
                pass
            try:
                conn, cur = _reconectar()
            except Exception as re:
                log.error(f"  Falha ao reconectar: {re}")
    log.error(f"  [ERRO] ID {fatura['id']}: falhou após 3 tentativas")


# ─── PDF → imagens ────────────────────────────────────────────────────────────

def baixar_pdf(url: str) -> bytes | None:
    try:
        r = requests.get(url, timeout=60, stream=True)
        r.raise_for_status()
        return r.content
    except Exception as e:
        log.warning(f"  [PDF] Falha no download: {e}")
        return None


def pdf_para_imagens(pdf_bytes: bytes) -> list[dict]:
    """Converte PDF em lista de imagens base64 PNG (até MAX_PAGINAS_PDF páginas)."""
    if not HAS_PDFIUM:
        log.warning("  [PDF] pypdfium2 nao instalado — sem visao. pip install pypdfium2")
        return []
    try:
        pdf = pdfium.PdfDocument(pdf_bytes)
        imagens = []
        for i in range(min(len(pdf), MAX_PAGINAS_PDF)):
            page   = pdf[i]
            bitmap = page.render(scale=2.0)
            pil    = bitmap.to_pil()
            buf    = io.BytesIO()
            pil.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode()
            imagens.append({"base64": b64, "mime": "image/png", "pagina": i + 1})
        log.info(f"  [PDF] {len(imagens)} imagem(ns) gerada(s)")
        return imagens
    except Exception as e:
        log.warning(f"  [PDF] Erro ao converter: {e}")
        return []


def _fichas_convergentes(triagem: dict, resultado_regras: dict) -> list[str]:
    """Retorna fichas presentes na triagem E nos motores SQL."""
    confirmadas = set(triagem.get("fichas_confirmadas", []))
    fichas_sql: set[str] = set()
    if resultado_regras:
        fichas_sql |= set(resultado_regras.get("fichas_todas", []))
        fichas_sql |= set(resultado_regras.get("f01_f05", {}).get("fichas", []))
        fichas_sql |= set(resultado_regras.get("f06_f14", {}).get("fichas", []))
    return list(confirmadas & fichas_sql)


def chamar_decisao_com_imagem(client: OpenAI, fatura: dict, triagem: dict, imagens: list[dict]) -> dict:
    """gpt-5.4 com imagens da fatura para decisão final de alta precisão."""
    regras = fatura["resultado_regras"]
    f01 = regras.get("f01_f05", {}).get("fichas", []) if regras else []
    f06 = regras.get("f06_f14", {}).get("fichas", []) if regras else []

    prompt_texto = f"""
# DECISAO FINAL DE RESSARCIMENTO — gpt-5.4 com visao

## Fatura
- ID: {fatura['id']} | UC: {fatura['UC']} | {fatura['concessionaria']} | {fatura['mes_ref']} | R$ {fatura['valor']:,.2f}

## Triagem (gpt-4.1-mini + prompt_confirmar)
Fichas confirmadas: {', '.join(triagem['fichas_confirmadas']) or 'nenhuma'}
Analise resumida: {triagem['texto_analise'][:2000]}

## Motores SQL (F01-F14)
F01-F05: {f01}
F06-F14: {f06}
{json.dumps(regras, ensure_ascii=False)[:1000] if regras else '(nao disponivel)'}

## Campos extraidos da fatura
{json.dumps(triagem['campos_json'], ensure_ascii=False, indent=2)}

As imagens da fatura estao anexadas. Analise os dados impressos diretamente.

Responda APENAS com JSON valido:
{{"decisao_final":"CONFIRMADO","ficha_principal":"F01","fichas_confirmadas":["F01"],"confianca_final":88,"percentual_ressarcimento":35,"justificativa":"...","recomendacao":"..."}}

decisao_final: CONFIRMADO | REFUTADO | INCONCLUSIVO
confianca_final: 0-100
percentual_ressarcimento: 0-100
"""

    content: list = [{"type": "text", "text": prompt_texto}]
    for img in imagens:
        content.append({
            "type": "image_url",
            "image_url": {
                "url"   : f"data:{img['mime']};base64,{img['base64']}",
                "detail": "high",
            },
        })

    try:
        response = client.chat.completions.create(
            model=MODELO_DECISAO,
            max_completion_tokens=2048,
            messages=[{"role": "user", "content": content}],
        )
        texto = response.choices[0].message.content.strip()
        log.info(f"  [Decisao-img] ID {fatura['id']}: resposta recebida")
        return _parse_decisao(texto, triagem)
    except Exception as e:
        log.error(f"  [Decisao-img] Erro ID {fatura['id']}: {e}")
        return {
            "decisao_final"           : "ERRO",
            "ficha_principal"         : triagem["fichas_confirmadas"][0] if triagem["fichas_confirmadas"] else "N/A",
            "fichas_confirmadas"      : triagem["fichas_confirmadas"],
            "confianca_final"         : 0,
            "percentual_ressarcimento": 0,
            "justificativa"           : f"Erro ao chamar gpt-5.4 com imagem: {str(e)[:200]}",
            "recomendacao"            : "Analise manual necessaria",
        }


# ─── Batch helpers ────────────────────────────────────────────────────────────

def _submit_batch(jsonl_lines: list[str], label: str) -> str:
    """Faz upload do JSONL e cria o batch. Retorna batch_id."""
    headers = {"Authorization": f"Bearer {API_KEY}"}
    chunk_bytes = "\n".join(jsonl_lines).encode("utf-8", errors="ignore")
    log.info(f"  [{label}] Upload: {len(jsonl_lines)} reqs | {len(chunk_bytes)//1024} KB")

    up = requests.post(
        f"{BASE_URL}/v1/files",
        headers=headers,
        files={"file": (f"{label}.jsonl", chunk_bytes, "application/jsonl"), "purpose": (None, "batch")},
        timeout=180,
    )
    up.raise_for_status()
    file_id = up.json()["id"]

    br = requests.post(
        f"{BASE_URL}/v1/batches",
        headers={**headers, "Content-Type": "application/json"},
        json={"input_file_id": file_id, "endpoint": "/v1/chat/completions", "completion_window": "24h"},
        timeout=60,
    )
    br.raise_for_status()
    batch_id = br.json()["id"]
    log.info(f"  [{label}] Batch criado: {batch_id}")
    return batch_id


def _wait_batch(batch_id: str, label: str) -> list[str]:
    """Aguarda conclusão do batch e retorna linhas do resultado."""
    headers = {"Authorization": f"Bearer {API_KEY}"}
    while True:
        r = requests.get(f"{BASE_URL}/v1/batches/{batch_id}", headers=headers, timeout=30)
        r.raise_for_status()
        data   = r.json()
        status = data["status"]
        counts = data.get("request_counts", {})
        log.info(f"  [{label}] status={status} | {counts.get('completed',0)}/{counts.get('total','?')}")

        if status == "completed":
            out_id = data.get("output_file_id")
            if not out_id:
                raise RuntimeError(f"Batch {batch_id} completado mas sem output_file_id")
            resp = requests.get(f"{BASE_URL}/v1/files/{out_id}/content", headers=headers, timeout=180)
            resp.raise_for_status()
            return [l for l in resp.text.strip().split("\n") if l.strip()]

        if status in ("failed", "expired", "cancelled"):
            raise RuntimeError(f"Batch {batch_id} encerrado com status: {status}")

        time.sleep(30)


def _chunks(lines: list[str]) -> list[list[str]]:
    """Divide JSONL em chunks de <= 190 MB."""
    result, current, size = [], [], 0
    for line in lines:
        ls = len(line.encode("utf-8")) + 1
        if current and size + ls > MAX_BATCH_BYTES:
            result.append(current)
            current, size = [], 0
        current.append(line)
        size += ls
    if current:
        result.append(current)
    return result


# ─── Modo Batch ───────────────────────────────────────────────────────────────

def main_batch(faturas: list, prompt_confirmar: str, client: OpenAI, cur, conn, dry_run: bool):
    """
    Processa todas as faturas via OpenAI Batch API em 2 rodadas:
      Rodada 1: triagem (gpt-4.1-mini) para todas
      Rodada 2: decisão final (gpt-5.4) só para confirmadas
    """
    log.info(f"\nModo BATCH: {len(faturas)} faturas")

    # ── Rodada 1: triagem ──────────────────────────────────────────────────────
    log.info("Rodada 1: gerando prompts de triagem...")
    jsonl_r1 = []
    fatura_map: dict[str, dict] = {}

    for fatura in faturas:
        cid   = f"triagem-{fatura['id']}"
        texto = montar_contexto_triagem(fatura, prompt_confirmar)
        jsonl_r1.append(json.dumps({
            "custom_id": cid,
            "method": "POST",
            "url": "/v1/chat/completions",
            "body": {
                "model": MODELO_TRIAGEM,
                "max_completion_tokens": 4096,
                "messages": [{"role": "user", "content": texto}],
            },
        }, ensure_ascii=True))
        fatura_map[cid] = fatura

    # Submete em chunks se necessário
    triagem_resultados: dict[int, dict] = {}
    for i, chunk in enumerate(_chunks(jsonl_r1), 1):
        bid = _submit_batch(chunk, f"triagem-chunk{i}")
        linhas = _wait_batch(bid, f"triagem-chunk{i}")
        for linha in linhas:
            obj = json.loads(linha)
            cid = obj.get("custom_id", "")
            fatura = fatura_map.get(cid)
            if not fatura:
                continue
            texto_resp = obj.get("response", {}).get("body", {}).get("choices", [{}])[0].get("message", {}).get("content", "")
            triagem = _parse_triagem(texto_resp)
            triagem_resultados[fatura["id"]] = {"fatura": fatura, "triagem": triagem}

    confirmados = [v for v in triagem_resultados.values() if v["triagem"].get("fichas_confirmadas")]
    refutados   = [v for v in triagem_resultados.values() if not v["triagem"].get("fichas_confirmadas")]

    log.info(f"Rodada 1 concluída: {len(confirmados)} confirmados | {len(refutados)} sem fichas")

    # Reconecta ao banco (conexão pode ter caído durante o batch)
    log.info("Reconectando ao banco após batch...")
    conn, cur = _reconectar()

    # Grava REFUTADO direto para os sem fichas
    if not dry_run:
        for item in refutados:
            decisao = {
                "decisao_final": "REFUTADO",
                "ficha_principal": "N/A",
                "fichas_confirmadas": [],
                "confianca_final": 90,
                "percentual_ressarcimento": 0,
                "justificativa": "Triagem nao identificou anomalias confirmadas.",
                "recomendacao": "Nenhuma acao necessaria.",
            }
            gravar_resultado(cur, conn, item["fatura"], item["triagem"], decisao, dry_run=False)

    if not confirmados:
        log.info("Nenhuma fatura confirmada — encerrando.")
        return

    # ── Rodada 2: decisão final gpt-5.4 com imagens (individual, não batch) ───
    log.info(f"\nRodada 2: decisao final (gpt-5.4 + imagens) para {len(confirmados)} confirmados...")

    n_com_img = n_sem_img = n_sem_convergencia = 0

    for idx, item in enumerate(confirmados, 1):
        fatura  = item["fatura"]
        triagem = item["triagem"]
        fid     = fatura["id"]

        fichas_conv = _fichas_convergentes(triagem, fatura.get("resultado_regras", {}))
        log.info(
            f"  [{idx}/{len(confirmados)}] ID {fid} | "
            f"triagem={triagem['fichas_confirmadas']} | "
            f"SQL={fatura.get('resultado_regras', {}).get('fichas_todas', [])} | "
            f"convergencia={fichas_conv}"
        )

        # Tenta baixar PDF e converter em imagens (independente da convergência)
        link    = fatura.get("link", "")
        imagens = []
        if link:
            pdf_bytes = baixar_pdf(link)
            if pdf_bytes:
                imagens = pdf_para_imagens(pdf_bytes)

        if imagens:
            decisao = chamar_decisao_com_imagem(client, fatura, triagem, imagens)
            n_com_img += 1
        else:
            # Sem PDF disponível — usa texto puro
            log.info(f"    Sem imagens — usando gpt-5.4 texto")
            decisao = chamar_decisao_final(client, fatura, triagem)
            n_sem_img += 1

        if not fichas_conv:
            n_sem_convergencia += 1
            log.info(f"    Sem convergencia triagem x SQL — mantendo decisão da IA")

        gravar_resultado(cur, conn, fatura, triagem, decisao, dry_run)

    log.info(
        f"Rodada 2 concluída: {n_com_img} com imagem | "
        f"{n_sem_img} texto | {n_sem_convergencia} sem convergencia"
    )


def _parse_triagem(texto: str) -> dict:
    campos_json = {}
    match = re.search(r"---CAMPOS_JSON---\s*(\{[\s\S]*?\})\s*---FIM_CAMPOS_JSON---", texto)
    if match:
        try:
            campos_json = json.loads(match.group(1))
        except Exception:
            pass

    fichas = list(dict.fromkeys(re.findall(r'\bF\d{2}\b', texto.upper())))
    fichas_confirmadas = []
    for f in fichas:
        if re.search(rf'\b{f}\b[^.]*?confirmad|confirmad[^.]*?\b{f}\b', texto, re.IGNORECASE):
            fichas_confirmadas.append(f)

    return {
        "fichas_confirmadas": fichas_confirmadas or fichas[:3],
        "campos_json": campos_json,
        "texto_analise": texto[:5000],
    }


def _montar_prompt_decisao(fatura: dict, triagem: dict) -> str:
    regras = fatura["resultado_regras"]
    f01 = regras.get("f01_f05", {}).get("fichas", []) if regras else []
    f06 = regras.get("f06_f14", {}).get("fichas", []) if regras else []

    return f"""
# DECISAO FINAL DE RESSARCIMENTO

## Fatura
- ID: {fatura['id']} | UC: {fatura['UC']} | {fatura['concessionaria']} | {fatura['mes_ref']} | R$ {fatura['valor']:,.2f}

## Triagem (prompt_confirmar)
Fichas confirmadas: {', '.join(triagem['fichas_confirmadas']) or 'nenhuma'}
Analise: {triagem['texto_analise'][:2000]}

## Motores SQL
F01-F05: {f01} | F06-F14: {f06}
{json.dumps(regras, ensure_ascii=False)[:1000] if regras else '(nao disponivel)'}

## Campos extraidos
{json.dumps(triagem['campos_json'], ensure_ascii=False, indent=2)}

Responda APENAS com JSON valido:
{{"decisao_final":"CONFIRMADO","ficha_principal":"F01","fichas_confirmadas":["F01"],"confianca_final":88,"percentual_ressarcimento":35,"justificativa":"...","recomendacao":"..."}}
"""


def _parse_decisao(texto: str, triagem: dict) -> dict:
    match = re.search(r'\{[\s\S]*\}', texto)
    if match:
        try:
            return json.loads(match.group())
        except Exception:
            pass
    return {
        "decisao_final": "INCONCLUSIVO",
        "ficha_principal": triagem["fichas_confirmadas"][0] if triagem["fichas_confirmadas"] else "N/A",
        "fichas_confirmadas": triagem["fichas_confirmadas"],
        "confianca_final": 50,
        "percentual_ressarcimento": 0,
        "justificativa": texto[:500],
        "recomendacao": "Analise manual necessaria",
    }


# ─── Main ─────────────────────────────────────────────────────────────────────

def main(empresas: list[int] | None = None, top_n: int | None = None, dry_run: bool = False, batch: bool = False):
    log.info("=" * 70)
    log.info("Iniciando analisar_com_motores_ia.py")
    log.info(f"  Modelo triagem : {MODELO_TRIAGEM}")
    log.info(f"  Modelo decisao : {MODELO_DECISAO}")
    log.info(f"  Empresas       : {empresas or 'todas'}")
    log.info(f"  Top N          : {top_n or 'todos'}")
    log.info(f"  Dry-run        : {dry_run}")
    log.info(f"  Modo batch     : {batch}")

    if not API_KEY:
        log.error("[ERRO] OPENAI_API_KEY nao configurada. Abortando.")
        return

    if not _PROMPT_CONFIRMAR.exists():
        log.error(f"[ERRO] Arquivo nao encontrado: {_PROMPT_CONFIRMAR}")
        return

    prompt_confirmar = _PROMPT_CONFIRMAR.read_text(encoding="utf-8")
    log.info(f"  prompt_confirmar.txt carregado: {len(prompt_confirmar)} chars")

    client = OpenAI(api_key=API_KEY)
    conn   = mysql.connector.connect(**DB)
    cur    = conn.cursor(dictionary=True)

    try:
        log.info("\nBuscando faturas CONFIRMADO com analise_IA...")
        faturas = buscar_faturas(cur, empresas, top_n)
        log.info(f"  Encontradas: {len(faturas)} faturas")

        if not faturas:
            log.warning("  Nenhuma fatura encontrada.")
            return

        # ── Modo batch ──────────────────────────────────────────────────────
        if batch:
            main_batch(faturas, prompt_confirmar, client, cur, conn, dry_run)
            return

        # ── Modo individual ─────────────────────────────────────────────────
        total = len(faturas)
        confirmadas = refutadas = inconclusivas = erros = 0

        for i, fatura in enumerate(faturas, 1):
            log.info(f"\n[{i}/{total}] ID {fatura['id']} | UC {fatura['UC']} | R$ {fatura['valor']:,.2f}")

            # Etapa 1: triagem com prompt_confirmar
            log.info("  Etapa 1: triagem com prompt_confirmar...")
            triagem = chamar_triagem(client, fatura, prompt_confirmar)

            fichas_confirmadas = triagem.get("fichas_confirmadas", [])
            log.info(f"  Triagem: fichas confirmadas = {fichas_confirmadas or 'nenhuma'}")

            # Etapa 2: decisão final com gpt-5.4 (só se triagem confirmou algo)
            if fichas_confirmadas or triagem.get("erro"):
                log.info("  Etapa 2: decisao final com gpt-5.4...")
                decisao = chamar_decisao_final(client, fatura, triagem)
            else:
                log.info("  Triagem nao confirmou fichas — gravando REFUTADO sem chamar gpt-5.4")
                decisao = {
                    "decisao_final"          : "REFUTADO",
                    "ficha_principal"        : "N/A",
                    "fichas_confirmadas"     : [],
                    "confianca_final"        : 90,
                    "percentual_ressarcimento": 0,
                    "justificativa"          : "Triagem nao identificou anomalias confirmadas.",
                    "recomendacao"           : "Nenhuma acao necessaria.",
                }

            gravar_resultado(cur, conn, fatura, triagem, decisao, dry_run)

            d = decisao.get("decisao_final", "")
            if d == "CONFIRMADO":
                confirmadas += 1
            elif d == "REFUTADO":
                refutadas += 1
            elif d == "ERRO":
                erros += 1
            else:
                inconclusivas += 1

            if i % 10 == 0:
                log.info(f"  Progresso: {i}/{total} | CONF={confirmadas} REF={refutadas} INC={inconclusivas} ERR={erros}")

        log.info(f"\n[OK] {total} faturas processadas:")
        log.info(f"  CONFIRMADO   : {confirmadas}")
        log.info(f"  REFUTADO     : {refutadas}")
        log.info(f"  INCONCLUSIVO : {inconclusivas}")
        log.info(f"  ERRO         : {erros}")

    except Exception as e:
        log.error(f"Erro geral: {e}", exc_info=True)
        raise
    finally:
        cur.close()
        conn.close()

    log.info("=" * 70)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Pipeline IA: triagem + decisao final")
    parser.add_argument("--empresa", type=int, nargs="+", default=None)
    parser.add_argument("--apenas-top-20", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--batch", action="store_true", help="Usar OpenAI Batch API (50% mais barato, assíncrono)")
    args = parser.parse_args()
    main(
        empresas = args.empresa,
        top_n    = 20 if args.apenas_top_20 else None,
        dry_run  = args.dry_run,
        batch    = args.batch,
    )
