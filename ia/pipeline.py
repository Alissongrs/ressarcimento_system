#!/usr/bin/env python3
"""
pipeline.py
───────────────────────────────────────────────────────────────────────────────
Pipeline completo de auditoria de faturas em 3 passos sequenciais:

  Passo 1 — Motores SQL (F01-F14)
    Executa motor_regras_f01_f05.sql e motor_regras_f06_f14.sql.
    Grava resultado combinado em Faturas_Registradas_Cache.resultado_regras.

  Passo 2 — Triagem com gpt-4.1-mini (Batch API)
    Lê texto da fatura + análise prévia + resultado_regras.
    Aplica prompt_confirmar.txt para identificar fichas confirmadas.
    Barato e assíncrono (50% de desconto via OpenAI Batch API).

  Passo 3 — Decisão final com gpt-5.4 + imagens
    Só para as faturas confirmadas no Passo 2.
    Baixa o PDF original e envia as páginas como imagem para o gpt-5.4.
    Grava decisão final em Faturas_Registradas_Cache.resultado_analises.

Uso:
  python pipeline.py --empresa 14
  python pipeline.py --empresa 4 14 32
  python pipeline.py --empresa 14 --apenas-motores
  python pipeline.py --empresa 14 --apenas-ia
  python pipeline.py --empresa 14 --dry-run
  python pipeline.py --empresa 14 --top 50
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
from dotenv import load_dotenv
from openai import OpenAI
import os

try:
    import pypdfium2 as pdfium
    HAS_PDFIUM = True
except ImportError:
    HAS_PDFIUM = False

# ─── Configuração ─────────────────────────────────────────────────────────────

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

API_KEY          = os.getenv("OPENAI_API_KEY", "")
MODELO_TRIAGEM   = "gpt-4.1-mini"
MODELO_DECISAO   = "gpt-5.4"
BASE_URL         = "https://api.openai.com"
MAX_BATCH_BYTES  = 190 * 1024 * 1024
MAX_PAGINAS_PDF  = 4
BATCH_SIZE_SQL   = 500

_DIR        = Path(__file__).parent
_SQL_BASE   = _DIR.parent.parent   # Docker/  (onde ficam os .sql)
_PROMPT_PATH = _DIR.parent / "backend" / "data" / "prompt_confirmar.txt"

SQL_JOBS = {
    "f01_f05": _SQL_BASE / "motor_regras_f01_f05.sql",
    "f06_f14": _SQL_BASE / "motor_regras_f06_f14.sql",
}

# ─── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level    = logging.INFO,
    format   = "%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt  = "%Y-%m-%d %H:%M:%S",
    handlers = [
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("pipeline.log", encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)

# ─── DB helpers ───────────────────────────────────────────────────────────────

def _reconectar() -> tuple:
    conn = mysql.connector.connect(**DB)
    cur  = conn.cursor(dictionary=True)
    return conn, cur


# ═══════════════════════════════════════════════════════════════════════════════
# PASSO 1 — Motores SQL (F01-F14)
# ═══════════════════════════════════════════════════════════════════════════════

def _split_statements(sql_text: str) -> list[str]:
    sql_text = re.sub(r"/\*.*?\*/", "", sql_text, flags=re.DOTALL)
    sql_text = re.sub(r"--[^\n]*", "", sql_text)
    return [s.strip() for s in sql_text.split(";") if s.strip()]


def _serialize(v):
    if isinstance(v, (bytes, bytearray)):
        return v.decode("utf-8", errors="replace")
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return v


def _executar_sql(cur, sql_path: Path, empresas: list[int] | None) -> dict[int, dict]:
    if not sql_path.exists():
        log.error(f"  SQL nao encontrado: {sql_path}")
        return {}

    sql_text = sql_path.read_text(encoding="utf-8")

    if empresas:
        lista    = ", ".join(str(e) for e in empresas)
        sql_text = re.sub(
            r'f\.Cod_Empresa\s+IN\s*\([^)]+\)',
            f'f.Cod_Empresa IN ({lista})',
            sql_text,
        )
        log.info(f"  Filtro empresa(s): {lista}")

    stmts      = _split_statements(sql_text)
    set_stmts  = [s for s in stmts if re.match(r"^\s*SET\b", s, re.IGNORECASE)]
    main_stmts = [s for s in stmts if not re.match(r"^\s*SET\b", s, re.IGNORECASE)]

    for s in set_stmts:
        cur.execute(s)

    if not main_stmts:
        log.error("  Nenhum SELECT/WITH encontrado no SQL.")
        return {}

    log.info("  Executando query principal...")
    cur.execute(main_stmts[-1])
    rows = cur.fetchall()
    log.info(f"  Linhas retornadas: {len(rows)}")
    return {int(r["id"]): r for r in rows if r.get("id") is not None}


def _montar_resultado_regras(row_f01: dict | None, row_f06: dict | None) -> dict:
    resultado = {}

    if row_f01:
        fichas = [
            f.replace("flag_", "").upper()
            for f in ["flag_f01","flag_f02","flag_f03","flag_f04","flag_f05","flag_f13"]
            if row_f01.get(f) and int(row_f01[f]) == 1
        ]
        resultado["f01_f05"] = {
            "fichas"         : fichas,
            "fichas_aplicadas": row_f01.get("fichas_aplicadas") or ", ".join(fichas),
            "qtd_regras"     : int(row_f01.get("qtd_regras") or len(fichas)),
            "flag_f01"       : int(row_f01.get("flag_f01") or 0),
            "flag_f02"       : int(row_f01.get("flag_f02") or 0),
            "flag_f03"       : int(row_f01.get("flag_f03") or 0),
            "flag_f04"       : int(row_f01.get("flag_f04") or 0),
            "flag_f05"       : int(row_f01.get("flag_f05") or 0),
            "flag_f13"       : int(row_f01.get("flag_f13") or 0),
            "desvio_pct_max" : _serialize(row_f01.get("desvio_pct_max")),
            "troca_medidor"  : _serialize(row_f01.get("troca_medidor")),
            "detalhamento"   : _serialize(row_f01.get("detalhamento")),
        }

    if row_f06:
        fichas = [
            f.replace("flag_", "").upper()
            for f in ["flag_f06","flag_f07","flag_f08","flag_f09","flag_f10",
                      "flag_f11","flag_f12","flag_f13","flag_f14"]
            if row_f06.get(f) and int(row_f06[f]) == 1
        ]
        resultado["f06_f14"] = {
            "fichas"          : fichas,
            "fichas_acionadas": row_f06.get("fichas_acionadas") or ", ".join(fichas),
            "qtd_flags"       : int(row_f06.get("qtd_flags") or len(fichas)),
            "flag_f06"        : int(row_f06.get("flag_f06") or 0),
            "flag_f07"        : int(row_f06.get("flag_f07") or 0),
            "flag_f08"        : int(row_f06.get("flag_f08") or 0),
            "flag_f09"        : int(row_f06.get("flag_f09") or 0),
            "flag_f10"        : int(row_f06.get("flag_f10") or 0),
            "flag_f11"        : int(row_f06.get("flag_f11") or 0),
            "flag_f12"        : int(row_f06.get("flag_f12") or 0),
            "flag_f13"        : int(row_f06.get("flag_f13") or 0),
            "flag_f14"        : int(row_f06.get("flag_f14") or 0),
        }

    todas: list[str] = []
    if row_f01:
        todas += resultado["f01_f05"]["fichas"]
    if row_f06:
        todas += [f for f in resultado["f06_f14"]["fichas"] if f not in todas]
    resultado["fichas_todas"]   = todas
    resultado["processado_em"]  = datetime.now().isoformat()
    return resultado


def rodar_motores_sql(empresas: list[int] | None, dry_run: bool) -> int:
    """Passo 1: executa os dois motores SQL e grava resultado_regras."""
    log.info("=" * 60)
    log.info("PASSO 1 — Motores SQL (F01-F14)")
    log.info(f"  Empresas: {empresas or 'todas'}")

    conn, cur = _reconectar()
    total_gravado = 0

    try:
        log.info("\nJob: F01_F05")
        res_f01 = _executar_sql(cur, SQL_JOBS["f01_f05"], empresas)
        log.info(f"  F01_F05: {len(res_f01)} faturas")

        log.info("\nJob: F06_F14")
        res_f06 = _executar_sql(cur, SQL_JOBS["f06_f14"], empresas)
        log.info(f"  F06_F14: {len(res_f06)} faturas")

        todos_ids = set(res_f01) | set(res_f06)
        log.info(f"\nTotal faturas com apontamentos: {len(todos_ids)}")

        if not todos_ids or dry_run:
            if dry_run:
                log.info("[DRY-RUN] Sem gravação.")
            return len(todos_ids)

        ids_lista = list(todos_ids)
        agora     = datetime.now()

        for i in range(0, len(ids_lista), BATCH_SIZE_SQL):
            lote    = ids_lista[i : i + BATCH_SIZE_SQL]
            updates = []
            for fid in lote:
                resultado  = _montar_resultado_regras(res_f01.get(fid), res_f06.get(fid))
                fichas_csv = ",".join(resultado.get("fichas_todas") or [])
                updates.append((
                    json.dumps(resultado, ensure_ascii=False),
                    fichas_csv or None,
                    agora,
                    fid,
                ))

            cur.executemany(
                "UPDATE Faturas_Registradas_Cache "
                "SET resultado_regras = %s, fichas_apontadas = %s, resultado_regras_em = %s "
                "WHERE id = %s",
                updates,
            )
            conn.commit()
            total_gravado += len(lote)
            log.info(f"  Lote {i // BATCH_SIZE_SQL + 1}: {len(lote)} faturas gravadas (total: {total_gravado})")

        log.info(f"\n[OK] Passo 1 concluido: {total_gravado} faturas atualizadas.")

    except Exception as e:
        conn.rollback()
        log.error(f"Erro no Passo 1: {e}", exc_info=True)
        raise
    finally:
        cur.close()
        conn.close()

    return total_gravado


# ═══════════════════════════════════════════════════════════════════════════════
# PASSO 2 + 3 — IA (triagem + decisão final com imagens)
# ═══════════════════════════════════════════════════════════════════════════════

# ─── Busca faturas ─────────────────────────────────────────────────────────────

def buscar_faturas(cur, empresas: list[int] | None, top_n: int | None, force: bool = False) -> list[dict]:
    """
    Busca faturas apontadas pelos motores SQL (coluna fichas_apontadas preenchida)
    que ainda não foram processadas pelo pipeline (resultado_analises NULL),
    a menos que --force.
    """
    sql_emp   = f"AND f.Cod_Empresa IN ({', '.join(str(e) for e in empresas)})" if empresas else ""
    sql_skip  = "" if force else "AND (f.resultado_analises IS NULL OR f.resultado_analises = '')"
    sql_limit = f"LIMIT {top_n}" if top_n else ""

    cur.execute(f"""
        SELECT
            f.id,
            f.UC,
            f.RS_Total_Fatura                                                  AS valor,
            f.Concessionaria,
            f.Mes_Ref,
            f.Cod_Empresa,
            f.fichas_apontadas,
            JSON_EXTRACT(f.analise_IA, '$.resultado.analise_texto')            AS ia_analise_texto,
            f.resultado_regras,
            COALESCE(f.texto_plumber, f.texto_markitdown, f.texto_ocr, '')     AS texto_fatura,
            COALESCE(f.Link, '')                                                AS link
        FROM Faturas_Registradas_Cache f
        WHERE f.fichas_apontadas IS NOT NULL
          AND f.fichas_apontadas != ''
          {sql_emp}
          {sql_skip}
        ORDER BY f.RS_Total_Fatura DESC
        {sql_limit}
    """)

    faturas = []
    for row in cur.fetchall():
        try:
            # Fichas vêm direto da coluna unificada (CSV: "F01,F02,F10")
            fichas_csv = (row.get("fichas_apontadas") or "").strip()
            fichas = [f.strip().upper() for f in fichas_csv.split(",") if f.strip()]

            resultado_regras = row["resultado_regras"]
            if isinstance(resultado_regras, str):
                try:
                    resultado_regras = json.loads(resultado_regras)
                except Exception:
                    resultado_regras = {}

            ia_analise = row["ia_analise_texto"] or ""
            if isinstance(ia_analise, bytes):
                ia_analise = ia_analise.decode("utf-8", errors="replace")

            faturas.append({
                "id"              : row["id"],
                "UC"              : row["UC"],
                "valor"           : float(row["valor"] or 0),
                "concessionaria"  : row["Concessionaria"],
                "mes_ref"         : str(row["Mes_Ref"] or ""),
                "ia_fichas"       : fichas,
                "ia_analise_texto": ia_analise,
                "resultado_regras": resultado_regras or {},
                "texto_fatura"    : row["texto_fatura"] or "",
                "link"            : str(row.get("link") or "").strip(),
            })
        except Exception as e:
            log.warning(f"  Erro ao parsear fatura {row.get('id')}: {e}")

    return faturas


# ─── PDF helpers ───────────────────────────────────────────────────────────────

def baixar_pdf(url: str) -> bytes | None:
    try:
        r = requests.get(url, timeout=60, stream=True)
        r.raise_for_status()
        return r.content
    except Exception as e:
        log.warning(f"  [PDF] Falha no download: {e}")
        return None


def pdf_para_imagens(pdf_bytes: bytes) -> list[dict]:
    if not HAS_PDFIUM:
        log.warning("  [PDF] pypdfium2 nao instalado. pip install pypdfium2")
        return []
    try:
        pdf     = pdfium.PdfDocument(pdf_bytes)
        imagens = []
        for i in range(min(len(pdf), MAX_PAGINAS_PDF)):
            bitmap = pdf[i].render(scale=2.0)
            buf    = io.BytesIO()
            bitmap.to_pil().save(buf, format="PNG")
            imagens.append({
                "base64": base64.b64encode(buf.getvalue()).decode(),
                "mime"  : "image/png",
            })
        log.info(f"  [PDF] {len(imagens)} imagem(ns) gerada(s)")
        return imagens
    except Exception as e:
        log.warning(f"  [PDF] Erro ao converter: {e}")
        return []


# ─── Triagem (Rodada 1) ────────────────────────────────────────────────────────

def _montar_contexto_triagem(fatura: dict, prompt_confirmar: str) -> str:
    regras = fatura["resultado_regras"]
    fichas_motores: list[str] = []
    if regras:
        fichas_motores  = regras.get("f01_f05", {}).get("fichas", [])
        fichas_motores += regras.get("f06_f14", {}).get("fichas", [])

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


def _parse_triagem(texto: str) -> dict:
    campos_json = {}
    m = re.search(r"---CAMPOS_JSON---\s*(\{[\s\S]*?\})\s*---FIM_CAMPOS_JSON---", texto)
    if m:
        try:
            campos_json = json.loads(m.group(1))
        except Exception:
            pass

    fichas = list(dict.fromkeys(re.findall(r'\bF\d{2}\b', texto.upper())))
    confirmadas = [
        f for f in fichas
        if re.search(rf'\b{f}\b[^.]*?confirmad|confirmad[^.]*?\b{f}\b', texto, re.IGNORECASE)
    ]
    return {
        "fichas_confirmadas": confirmadas or fichas[:3],
        "campos_json"       : campos_json,
        "texto_analise"     : texto[:5000],
    }


# ─── Decisão final (Rodada 2) ─────────────────────────────────────────────────

def _fichas_convergentes(triagem: dict, resultado_regras: dict) -> list[str]:
    confirmadas = set(triagem.get("fichas_confirmadas", []))
    fichas_sql: set[str] = set()
    if resultado_regras:
        fichas_sql |= set(resultado_regras.get("fichas_todas", []))
        fichas_sql |= set(resultado_regras.get("f01_f05", {}).get("fichas", []))
        fichas_sql |= set(resultado_regras.get("f06_f14", {}).get("fichas", []))
    return list(confirmadas & fichas_sql)


_ALIAS_DECISAO = {
    "NEGADO"      : "REFUTADO",
    "DENIED"      : "REFUTADO",
    "REJECTED"    : "REFUTADO",
    "CONFIRMED"   : "CONFIRMADO",
    "INCONCLUSIVE": "INCONCLUSIVO",
}

def _parse_decisao(texto: str, triagem: dict) -> dict:
    m = re.search(r'\{[\s\S]*\}', texto)
    if m:
        try:
            d = json.loads(m.group())
            # Normaliza decisao_final para os 3 valores válidos
            df = str(d.get("decisao_final", "")).upper().strip()
            d["decisao_final"] = _ALIAS_DECISAO.get(df, df) or "INCONCLUSIVO"
            return d
        except Exception:
            pass
    return {
        "decisao_final"           : "INCONCLUSIVO",
        "ficha_principal"         : triagem["fichas_confirmadas"][0] if triagem["fichas_confirmadas"] else "N/A",
        "fichas_confirmadas"      : triagem["fichas_confirmadas"],
        "confianca_final"         : 50,
        "percentual_ressarcimento": 0,
        "justificativa"           : texto[:500],
        "recomendacao"            : "Analise manual necessaria",
    }


def _prompt_decisao(fatura: dict, triagem: dict, prompt_confirmar: str, com_imagem: bool) -> str:
    """
    Monta o prompt do PASSO 3 reusando prompt_confirmar.txt como base de conhecimento
    (catalogo de fichas, regras anti-alucinacao, criterios de validacao).
    Acrescenta apenas a camada especifica de DECISAO FINAL com saida JSON.
    """
    regras = fatura["resultado_regras"]
    f01    = regras.get("f01_f05", {}).get("fichas", []) if regras else []
    f06    = regras.get("f06_f14", {}).get("fichas", []) if regras else []

    fonte = ("As imagens da fatura estao anexadas. Extraia diretamente dos dados impressos: "
             "leituras (anterior e atual), constante/multiplicador, kWh faturado por posto "
             "(ponta/fora ponta/reservado), demanda, fator de potencia, tarifa, medidor.") \
            if com_imagem else \
            "Analise com base no texto extraido abaixo (pode estar incompleto)."

    return f"""{prompt_confirmar}

================================================================================
PASSO 3 — DECISAO FINAL DE RESSARCIMENTO ({MODELO_DECISAO})
================================================================================

A base de conhecimento acima (PAPEL, REGRA ANTI-ALUCINACAO, fichas F01-F14, criterios
de validacao, regras financeiras) e VALIDA para esta etapa. Aplique-as integralmente.

Sua tarefa nesta etapa: para CADA ficha apontada pela triagem ou pelos motores SQL,
aplicar a validacao tecnica especifica da ficha e decidir se ha ANOMALIA REAL ou
falso positivo. Diferente do PASSO 2, sua saida e JSON estruturado (nao texto livre).

REGRA DE OURO (reforco): se a evidencia matematica/tecnica nao suporta a ficha,
REJEITE-A, mesmo que triagem ou motores SQL tenham apontado. NAO invente teses
regulatorias (TUSD, ICMS, ACL, CCEE) — essas NAO sao fichas (ver REGRA ANTI-ALUCINACAO).

================================================================================
DADOS DESTA FATURA
================================================================================
ID: {fatura['id']} | UC: {fatura['UC']} | {fatura['concessionaria']} | {fatura['mes_ref']} | R$ {fatura['valor']:,.2f}

TRIAGEM (gpt-4.1-mini, sobre texto):
  Fichas confirmadas pela triagem: {', '.join(triagem['fichas_confirmadas']) or 'nenhuma'}
  Resumo: {triagem['texto_analise'][:1500]}

MOTORES SQL (regras deterministicas):
  F01-F05 detectadas: {f01}
  F06-F14 detectadas: {f06}
  Detalhes: {json.dumps(regras, ensure_ascii=False)[:1200] if regras else '(nao disponivel)'}

CAMPOS EXTRAIDOS PELA TRIAGEM:
{json.dumps(triagem['campos_json'], ensure_ascii=False, indent=2)}

{fonte}

================================================================================
INSTRUCOES DE SAIDA (CRITICO)
================================================================================

1. Para CADA ficha apontada (triagem ∪ motores), aplique o criterio de validacao
   do catalogo F01-F14 acima.
2. Liste em "fichas_confirmadas" SOMENTE as que passaram na validacao tecnica.
3. Se nenhuma ficha passar → decisao_final="REFUTADO", fichas_confirmadas=[], ressarcimento=0.
4. Se uma ou mais passarem → decisao_final="CONFIRMADO", escolha a de maior peso
   como ficha_principal (ordem de prioridade: F01 > F03 > F11 > F02 > demais).
5. Se faltarem dados para validar (campos ausentes, imagem ilegivel) → "INCONCLUSIVO".
6. Na "justificativa" SHOW THE MATH: cite os numeros usados (leituras, calc, faturado,
   diferenca em kWh, %). Nao escreva prosa generica.
7. JAMAIS mencione TUSD/ICMS/ACL/CCEE/bandeira como fundamentacao — isso nao e ficha.

Responda APENAS com JSON valido (sem markdown, sem comentario, sem texto antes ou depois):
{{"decisao_final":"CONFIRMADO","ficha_principal":"F01","fichas_confirmadas":["F01"],"confianca_final":88,"percentual_ressarcimento":35,"justificativa":"...","recomendacao":"..."}}

Campos:
  decisao_final: "CONFIRMADO" | "REFUTADO" | "INCONCLUSIVO"
  ficha_principal: "F01"-"F14" ou ""
  fichas_confirmadas: array de strings "F01"-"F14"
  confianca_final: 0-100 (calibrada com a evidencia matematica)
  percentual_ressarcimento: 0-100 (0 se REFUTADO/INCONCLUSIVO)
  justificativa: string com os numeros do calculo
  recomendacao: string com proxima acao
"""


def chamar_decisao(client: OpenAI, fatura: dict, triagem: dict, imagens: list[dict],
                    prompt_confirmar: str) -> dict:
    """Chama gpt-5.4 com ou sem imagens conforme disponibilidade."""
    com_imagem = len(imagens) > 0
    prompt     = _prompt_decisao(fatura, triagem, prompt_confirmar, com_imagem)

    content: list = [{"type": "text", "text": prompt}]
    for img in imagens:
        content.append({
            "type"     : "image_url",
            "image_url": {
                "url"   : f"data:{img['mime']};base64,{img['base64']}",
                "detail": "high",
            },
        })

    try:
        resp  = client.chat.completions.create(
            model                = MODELO_DECISAO,
            max_completion_tokens= 2048,
            messages             = [{"role": "user", "content": content}],
        )
        texto = resp.choices[0].message.content.strip()
        modo  = "imagem" if com_imagem else "texto"
        log.info(f"  [Decisao/{modo}] ID {fatura['id']}: OK")
        return _parse_decisao(texto, triagem)
    except Exception as e:
        log.error(f"  [Decisao] Erro ID {fatura['id']}: {e}")
        return {
            "decisao_final"           : "ERRO",
            "ficha_principal"         : triagem["fichas_confirmadas"][0] if triagem["fichas_confirmadas"] else "N/A",
            "fichas_confirmadas"      : triagem["fichas_confirmadas"],
            "confianca_final"         : 0,
            "percentual_ressarcimento": 0,
            "justificativa"           : f"Erro ao chamar {MODELO_DECISAO}: {str(e)[:200]}",
            "recomendacao"            : "Analise manual necessaria",
        }


# ─── Gravação ─────────────────────────────────────────────────────────────────

def gravar_resultado(cur, conn, fatura: dict, triagem: dict, decisao: dict, dry_run: bool):
    """Grava resultado_analises no banco. Retorna (conn, cur) atualizado."""
    resultado = {
        "ia_4_1_apontamentos": {
            "fichas" : fatura["ia_fichas"],
            "status" : "CONFIRMADO",
            "analise": fatura["ia_analise_texto"][:1000] if fatura["ia_analise_texto"] else "",
        },
        "triagem_confirmar": {
            "fichas_confirmadas": triagem["fichas_confirmadas"],
            "campos_json"       : triagem["campos_json"],
        },
        "motores_sql"        : fatura["resultado_regras"],
        "ia_opus_5_4_decisao": decisao,
        "processado_em"      : datetime.now().isoformat(),
        "modelo"             : MODELO_DECISAO,
    }

    if dry_run:
        log.info(f"  [DRY-RUN] ID {fatura['id']}: {decisao.get('decisao_final')} "
                 f"confianca={decisao.get('confianca_final')}%")
        return conn, cur

    for tentativa in range(3):
        try:
            cur.execute(
                "UPDATE Faturas_Registradas_Cache "
                "SET resultado_analises = %s, resultado_final_em = NOW() "
                "WHERE id = %s",
                (json.dumps(resultado, ensure_ascii=False), fatura["id"]),
            )
            conn.commit()
            log.info(
                f"  [OK] ID {fatura['id']}: {decisao.get('decisao_final')} | "
                f"confianca={decisao.get('confianca_final')}% | "
                f"ressarcimento={decisao.get('percentual_ressarcimento')}%"
            )
            return conn, cur
        except Exception as e:
            log.warning(f"  [RETRY {tentativa+1}] ID {fatura['id']}: {e}")
            try:
                conn.rollback()
            except Exception:
                pass
            try:
                conn, cur = _reconectar()
            except Exception as re_err:
                log.error(f"  Falha ao reconectar: {re_err}")

    log.error(f"  [ERRO] ID {fatura['id']}: falhou apos 3 tentativas")
    return conn, cur


# ─── Batch API helpers ─────────────────────────────────────────────────────────

def _submit_batch(jsonl_lines: list[str], label: str) -> str:
    headers     = {"Authorization": f"Bearer {API_KEY}"}
    chunk_bytes = "\n".join(jsonl_lines).encode("utf-8", errors="ignore")
    log.info(f"  [{label}] Upload: {len(jsonl_lines)} reqs | {len(chunk_bytes)//1024} KB")

    up = requests.post(
        f"{BASE_URL}/v1/files",
        headers = headers,
        files   = {
            "file"   : (f"{label}.jsonl", chunk_bytes, "application/jsonl"),
            "purpose": (None, "batch"),
        },
        timeout = 180,
    )
    up.raise_for_status()
    file_id = up.json()["id"]

    br = requests.post(
        f"{BASE_URL}/v1/batches",
        headers = {**headers, "Content-Type": "application/json"},
        json    = {
            "input_file_id"    : file_id,
            "endpoint"         : "/v1/chat/completions",
            "completion_window": "24h",
        },
        timeout = 60,
    )
    br.raise_for_status()
    batch_id = br.json()["id"]
    log.info(f"  [{label}] Batch criado: {batch_id}")
    return batch_id


def _wait_batch(batch_id: str, label: str) -> list[str]:
    headers = {"Authorization": f"Bearer {API_KEY}"}
    while True:
        r      = requests.get(f"{BASE_URL}/v1/batches/{batch_id}", headers=headers, timeout=30)
        r.raise_for_status()
        data   = r.json()
        status = data["status"]
        counts = data.get("request_counts", {})
        log.info(f"  [{label}] status={status} | {counts.get('completed',0)}/{counts.get('total','?')}")

        if status == "completed":
            out_id = data.get("output_file_id")
            if not out_id:
                raise RuntimeError(f"Batch {batch_id} sem output_file_id")
            resp = requests.get(f"{BASE_URL}/v1/files/{out_id}/content", headers=headers, timeout=180)
            resp.raise_for_status()
            return [l for l in resp.text.strip().split("\n") if l.strip()]

        if status in ("failed", "expired", "cancelled"):
            raise RuntimeError(f"Batch {batch_id} encerrado com status: {status}")

        time.sleep(30)


def _chunks(lines: list[str]) -> list[list[str]]:
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


# ─── Retry erros ──────────────────────────────────────────────────────────────

def rodar_retry_erros(empresas: list[int] | None, dry_run: bool):
    """
    Reprocessa somente faturas com decisao_final = 'ERRO'.
    Recupera triagem já salva em resultado_analises e manda direto para
    gpt-5.4 com imagens — sem refazer o batch da Rodada 1.
    """
    log.info("=" * 60)
    log.info("RETRY ERROS/INVALIDOS — gpt-5.4 com imagens")
    log.info("  Reprocessa: ERRO, NEGADO e qualquer valor invalido")

    if not API_KEY:
        log.error("[ERRO] OPENAI_API_KEY nao configurada.")
        return

    if not _PROMPT_PATH.exists():
        log.error(f"[ERRO] prompt_confirmar.txt nao encontrado: {_PROMPT_PATH}")
        return
    prompt_confirmar = _PROMPT_PATH.read_text(encoding="utf-8")

    client    = OpenAI(api_key=API_KEY)
    conn, cur = _reconectar()

    try:
        sql_emp = f"AND f.Cod_Empresa IN ({', '.join(str(e) for e in empresas)})" if empresas else ""
        cur.execute(f"""
            SELECT
                f.id,
                f.UC,
                f.RS_Total_Fatura                                                AS valor,
                f.Concessionaria,
                f.Mes_Ref,
                f.Cod_Empresa,
                JSON_EXTRACT(f.analise_IA, '$.resultado.ia_fichas_confirmadas')  AS ia_fichas,
                JSON_EXTRACT(f.analise_IA, '$.resultado.analise_texto')          AS ia_analise_texto,
                f.resultado_regras,
                COALESCE(f.texto_plumber, f.texto_markitdown, f.texto_ocr, '')   AS texto_fatura,
                COALESCE(f.Link, '')                                              AS link,
                f.resultado_analises
            FROM Faturas_Registradas_Cache f
            WHERE JSON_EXTRACT(f.resultado_analises, '$.ia_opus_5_4_decisao.decisao_final')
                  NOT IN ('CONFIRMADO', 'REFUTADO', 'INCONCLUSIVO')
              AND f.resultado_analises IS NOT NULL
              AND f.resultado_analises != ''
              {sql_emp}
            ORDER BY f.RS_Total_Fatura DESC
        """)
        rows = cur.fetchall()
        log.info(f"  Faturas com ERRO: {len(rows)}")

        if not rows:
            log.info("  Nenhuma fatura com ERRO encontrada.")
            return

        for idx, row in enumerate(rows, 1):
            fid = row["id"]
            log.info(f"  [{idx}/{len(rows)}] ID {fid} | UC {row['UC']} | R$ {float(row['valor'] or 0):,.2f}")

            # Reconstrói fatura
            ia_fichas = row["ia_fichas"]
            if ia_fichas:
                fichas = json.loads(ia_fichas) if isinstance(ia_fichas, str) else ia_fichas
                fichas = fichas if isinstance(fichas, list) else [fichas]
            else:
                fichas = []

            resultado_regras = row["resultado_regras"]
            if isinstance(resultado_regras, str):
                try:
                    resultado_regras = json.loads(resultado_regras)
                except Exception:
                    resultado_regras = {}

            ia_analise = row["ia_analise_texto"] or ""
            if isinstance(ia_analise, bytes):
                ia_analise = ia_analise.decode("utf-8", errors="replace")

            fatura = {
                "id"              : fid,
                "UC"              : row["UC"],
                "valor"           : float(row["valor"] or 0),
                "concessionaria"  : row["Concessionaria"],
                "mes_ref"         : str(row["Mes_Ref"] or ""),
                "ia_fichas"       : fichas,
                "ia_analise_texto": ia_analise,
                "resultado_regras": resultado_regras or {},
                "texto_fatura"    : row["texto_fatura"] or "",
                "link"            : str(row.get("link") or "").strip(),
            }

            # Recupera triagem já salva (evita refazer o batch)
            resultado_anterior = row.get("resultado_analises") or {}
            if isinstance(resultado_anterior, str):
                try:
                    resultado_anterior = json.loads(resultado_anterior)
                except Exception:
                    resultado_anterior = {}

            triagem_salva = resultado_anterior.get("triagem_confirmar", {})
            triagem = {
                "fichas_confirmadas": triagem_salva.get("fichas_confirmadas") or fichas,
                "campos_json"       : triagem_salva.get("campos_json") or {},
                "texto_analise"     : resultado_anterior.get("ia_4_1_apontamentos", {}).get("analise") or ia_analise,
            }

            log.info(f"    triagem recuperada: fichas={triagem['fichas_confirmadas']}")

            # Baixa PDF e converte em imagens
            imagens = []
            link    = fatura.get("link", "")
            if link:
                pdf_bytes = baixar_pdf(link)
                if pdf_bytes:
                    imagens = pdf_para_imagens(pdf_bytes)

            if not imagens:
                log.warning(f"    Sem imagens — gpt-5.4 texto")

            decisao = chamar_decisao(client, fatura, triagem, imagens, prompt_confirmar)
            log.info(f"    Decisao: {decisao.get('decisao_final')} | confianca={decisao.get('confianca_final')}%")

            conn, cur = gravar_resultado(cur, conn, fatura, triagem, decisao, dry_run)

        log.info(f"\n[OK] Retry concluido: {len(rows)} faturas reprocessadas.")

    except Exception as e:
        log.error(f"Erro no retry: {e}", exc_info=True)
        raise
    finally:
        cur.close()
        conn.close()


# ─── Pipeline IA ──────────────────────────────────────────────────────────────

def rodar_ia(empresas: list[int] | None, top_n: int | None, dry_run: bool, force: bool = False):
    """Passo 2+3: triagem batch + decisão final com imagens."""
    log.info("=" * 60)
    log.info("PASSO 2+3 — IA (triagem + decisão final com imagens)")
    log.info(f"  Modelo triagem : {MODELO_TRIAGEM}")
    log.info(f"  Modelo decisao : {MODELO_DECISAO}")
    log.info(f"  Force          : {force}")

    if not API_KEY:
        log.error("[ERRO] OPENAI_API_KEY nao configurada.")
        return

    if not _PROMPT_PATH.exists():
        log.error(f"[ERRO] prompt_confirmar.txt nao encontrado: {_PROMPT_PATH}")
        return

    prompt_confirmar = _PROMPT_PATH.read_text(encoding="utf-8")
    log.info(f"  prompt_confirmar.txt: {len(prompt_confirmar)} chars")

    client    = OpenAI(api_key=API_KEY)
    conn, cur = _reconectar()

    try:
        modo_busca = "todas (--force)" if force else "apenas sem resultado_analises"
        log.info(f"\nBuscando faturas CONFIRMADO ({modo_busca})...")
        faturas = buscar_faturas(cur, empresas, top_n, force=force)
        log.info(f"  Encontradas: {len(faturas)} faturas")

        if not faturas:
            log.warning("  Nenhuma fatura encontrada.")
            return

        # ── Rodada 1: triagem via Batch API ───────────────────────────────────
        log.info(f"\nRodada 1: triagem com {MODELO_TRIAGEM} (Batch API)...")
        jsonl_r1   = []
        fatura_map = {}

        for fatura in faturas:
            cid = f"triagem-{fatura['id']}"
            jsonl_r1.append(json.dumps({
                "custom_id": cid,
                "method"   : "POST",
                "url"      : "/v1/chat/completions",
                "body"     : {
                    "model"               : MODELO_TRIAGEM,
                    "max_completion_tokens": 4096,
                    "messages"            : [{"role": "user", "content": _montar_contexto_triagem(fatura, prompt_confirmar)}],
                },
            }, ensure_ascii=True))
            fatura_map[cid] = fatura

        triagem_resultados: dict[int, dict] = {}
        for i, chunk in enumerate(_chunks(jsonl_r1), 1):
            bid    = _submit_batch(chunk, f"triagem-chunk{i}")
            linhas = _wait_batch(bid, f"triagem-chunk{i}")
            for linha in linhas:
                obj    = json.loads(linha)
                cid    = obj.get("custom_id", "")
                fatura = fatura_map.get(cid)
                if not fatura:
                    continue
                texto_resp = (
                    obj.get("response", {})
                       .get("body", {})
                       .get("choices", [{}])[0]
                       .get("message", {})
                       .get("content", "")
                )
                triagem = _parse_triagem(texto_resp)
                triagem_resultados[fatura["id"]] = {"fatura": fatura, "triagem": triagem}

        confirmados = [v for v in triagem_resultados.values() if v["triagem"].get("fichas_confirmadas")]
        refutados   = [v for v in triagem_resultados.values() if not v["triagem"].get("fichas_confirmadas")]
        log.info(f"Rodada 1 concluída: {len(confirmados)} confirmados | {len(refutados)} refutados")

        # Reconecta — pode ter caído durante o batch (minutos a horas)
        conn, cur = _reconectar()

        # Grava REFUTADO direto para os sem fichas
        for item in refutados:
            decisao_refutada = {
                "decisao_final"           : "REFUTADO",
                "ficha_principal"         : "N/A",
                "fichas_confirmadas"      : [],
                "confianca_final"         : 90,
                "percentual_ressarcimento": 0,
                "justificativa"           : "Triagem nao identificou anomalias confirmadas.",
                "recomendacao"            : "Nenhuma acao necessaria.",
            }
            conn, cur = gravar_resultado(cur, conn, item["fatura"], item["triagem"], decisao_refutada, dry_run)

        if not confirmados:
            log.info("Nenhuma fatura confirmada — encerrando Passo 2+3.")
            return

        # ── Rodada 2: decisão final gpt-5.4 + imagens ─────────────────────────
        log.info(f"\nRodada 2: decisao final com {MODELO_DECISAO} + imagens ({len(confirmados)} faturas)...")

        # Reconecta antes de começar as gravações — o batch pode ter durado horas
        log.info("Reconectando ao banco para Rodada 2...")
        conn, cur = _reconectar()

        n_img = n_txt = n_sem_conv = n_skip_f12 = 0

        # Fichas com alta taxa de falso positivo no motor SQL — pular 5.4
        # quando aparecem SOZINHAS (sem outra ficha mais critica)
        FICHAS_BAIXA_PRECISAO = {"F12"}

        for idx, item in enumerate(confirmados, 1):
            fatura  = item["fatura"]
            triagem = item["triagem"]

            conv = _fichas_convergentes(triagem, fatura.get("resultado_regras", {}))
            log.info(
                f"  [{idx}/{len(confirmados)}] ID {fatura['id']} | "
                f"triagem={triagem['fichas_confirmadas']} | "
                f"SQL={fatura.get('resultado_regras', {}).get('fichas_todas', [])} | "
                f"conv={conv}"
            )

            # Skip rapido: se a unica ficha convergente for de baixa precisao,
            # marca como REFUTADO sem chamar 5.4 (alta taxa historica de FP)
            if conv and set(conv).issubset(FICHAS_BAIXA_PRECISAO):
                decisao = {
                    "decisao_final"           : "REFUTADO",
                    "ficha_principal"         : conv[0],
                    "fichas_confirmadas"      : [],
                    "confianca_final"         : 70,
                    "percentual_ressarcimento": 0,
                    "justificativa"           : (
                        f"Apenas {','.join(conv)} apontada (baixa precisao do motor SQL) "
                        f"sem outras fichas convergentes. Refutado automaticamente "
                        f"sem chamar gpt-5.4. Para auditar: verificar manualmente "
                        f"se ha cobranca real de irregularidade."
                    ),
                    "recomendacao"            : "Sem acao automatica. Auditar manualmente se relevante.",
                }
                n_skip_f12 += 1
                log.info(f"    [SKIP] {conv} apenas — REFUTADO sem 5.4")
                conn, cur = gravar_resultado(cur, conn, fatura, triagem, decisao, dry_run)
                continue

            # Baixa PDF e converte em imagens
            imagens = []
            link    = fatura.get("link", "")
            if link:
                pdf_bytes = baixar_pdf(link)
                if pdf_bytes:
                    imagens = pdf_para_imagens(pdf_bytes)

            decisao = chamar_decisao(client, fatura, triagem, imagens, prompt_confirmar)

            if imagens:
                n_img += 1
            else:
                n_txt += 1
            if not conv:
                n_sem_conv += 1

            conn, cur = gravar_resultado(cur, conn, fatura, triagem, decisao, dry_run)

        log.info(
            f"\n[OK] Rodada 2 concluída: "
            f"{n_img} com imagem | {n_txt} texto | {n_sem_conv} sem convergencia | "
            f"{n_skip_f12} skip baixa precisao (sem 5.4)"
        )

    except Exception as e:
        log.error(f"Erro no Passo 2+3: {e}", exc_info=True)
        raise
    finally:
        cur.close()
        conn.close()


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="Pipeline completo: motores SQL + triagem 4.1-mini + decisao gpt-5.4 com imagens"
    )
    parser.add_argument("--empresa",        type=int, nargs="+", default=None,
                        help="Filtrar por Cod_Empresa (ex: 14  ou  4 14 32)")
    parser.add_argument("--top",            type=int, default=None,
                        help="Limitar N faturas na etapa IA (padrão: todas)")
    parser.add_argument("--dry-run",        action="store_true",
                        help="Executa sem gravar no banco")
    parser.add_argument("--apenas-motores", action="store_true",
                        help="Executa somente o Passo 1 (SQL)")
    parser.add_argument("--apenas-ia",      action="store_true",
                        help="Executa somente o Passo 2+3 (IA), motores ja rodaram")
    parser.add_argument("--force",          action="store_true",
                        help="Reprocessa mesmo quem ja tem resultado_analises preenchido")
    parser.add_argument("--retry-erros",    action="store_true",
                        help="Reprocessa faturas com decisao_final invalido (ERRO, NEGADO, etc) via gpt-5.4 com imagens")
    args = parser.parse_args()

    log.info("=" * 70)
    log.info("PIPELINE DE AUDITORIA DE FATURAS")
    log.info(f"  Empresas     : {args.empresa or 'todas'}")
    log.info(f"  Top N        : {args.top or 'todas'}")
    log.info(f"  Dry-run      : {args.dry_run}")
    log.info(f"  Force        : {args.force}")
    log.info(f"  Retry erros  : {args.retry_erros}")
    log.info(f"  Modo         : {'apenas-motores' if args.apenas_motores else 'apenas-ia' if args.apenas_ia else 'completo'}")
    log.info("=" * 70)

    # Modo retry: só reprocessa os com ERRO, ignora os outros flags
    if args.retry_erros:
        rodar_retry_erros(empresas=args.empresa, dry_run=args.dry_run)
        return

    if not args.apenas_ia:
        rodar_motores_sql(empresas=args.empresa, dry_run=args.dry_run)

    if not args.apenas_motores:
        rodar_ia(empresas=args.empresa, top_n=args.top, dry_run=args.dry_run, force=args.force)

    log.info("\nPipeline concluido.")


if __name__ == "__main__":
    main()
