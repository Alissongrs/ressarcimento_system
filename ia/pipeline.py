#!/usr/bin/env python3
"""
pipeline.py
───────────────────────────────────────────────────────────────────────────────
Pipeline de auditoria de faturas em 2 passos sequenciais:

  Passo 1 — Triagem com gpt-4.1-mini
    Lê as três extrações de texto (plumber, markitdown, ocr) + analise_IA prévia.
    Aplica prompt_confirmar.txt para identificar fichas confirmadas.
    Modos: síncrono (padrão) ou Batch API (--batch, 50% desc, até 24h).

  Passo 2 — Decisão final com gpt-4.1-mini + imagens (padrão; --modelo 5.4 troca)
    Só para as faturas confirmadas no Passo 1.
    Baixa o PDF original e envia as páginas como imagem para o modelo configurado.
    Grava decisão final em Faturas_Registradas_Cache.resultado_analises.

Uso:
  python pipeline.py --empresa 14
  python pipeline.py --empresa 4 14 32
  python pipeline.py --empresa 14 --dry-run
  python pipeline.py --empresa 14 --top 50
  python pipeline.py --empresa 14 --force
  python pipeline.py --empresa 14 --batch           # triagem via Batch API
  python pipeline.py --empresa 14 --batch --retomar # aproveita batch já submetido
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
MODELO_DECISAO   = "gpt-5"
SERVICE_TIER     = "flex"   # "flex" para menor custo (maior latência) | "default" para standard

# ─── Acumulador de tokens ──────────────────────────────────────────────────────
_USO = {"input": 0, "cached": 0, "output": 0, "chamadas": 0}

def _registrar_uso(usage) -> None:
    """Acumula tokens da resposta OpenAI e loga por chamada."""
    if usage is None:
        return
    inp    = getattr(usage, "prompt_tokens", 0) or 0
    out    = getattr(usage, "completion_tokens", 0) or 0
    cached = getattr(getattr(usage, "prompt_tokens_details", None), "cached_tokens", 0) or 0
    _USO["input"]    += inp
    _USO["cached"]   += cached
    _USO["output"]   += out
    _USO["chamadas"] += 1
    log.debug(f"    [tokens] input={inp} cached={cached} output={out}")

def _log_uso_total(label: str = "") -> None:
    """Imprime resumo de tokens e custo estimado acumulado."""
    inp     = _USO["input"]
    cached  = _USO["cached"]
    out     = _USO["output"]
    n       = _USO["chamadas"]
    nao_cac = inp - cached

    # Tabela de preços por modelo + tier ($/1M tokens)
    _PRECOS = {
        # modelo              : (inp_std, cac_std, out_std, inp_flex, cac_flex, out_flex)
        "gpt-5.5"             : (5.00,  0.50, 30.00,  2.50,  0.25, 15.00),
        "gpt-5.4"             : (2.50,  0.25, 15.00,  1.25,  0.13,  7.50),
        "gpt-5"               : (2.50,  0.25, 15.00,  1.25,  0.13,  7.50),
        "gpt-4.1"             : (2.00,  0.50, 8.00,   2.00,  0.50,  8.00),
        "gpt-4.1-mini"        : (0.40,  0.10, 1.60,   0.40,  0.10,  1.60),
        "gpt-4o"              : (2.50,  1.25, 10.00,  2.50,  1.25, 10.00),
    }
    modelo_key = next((k for k in _PRECOS if MODELO_DECISAO.startswith(k)), None)
    if modelo_key:
        precos = _PRECOS[modelo_key]
        if SERVICE_TIER == "flex":
            pi, pc, po = precos[3], precos[4], precos[5]
        else:
            pi, pc, po = precos[0], precos[1], precos[2]
    else:
        pi, pc, po = 2.50, 0.25, 15.00  # fallback

    custo = (nao_cac * pi + cached * pc + out * po) / 1_000_000
    tag = f" [{label}]" if label else ""
    log.info(
        f"[USO TOKENS{tag}] modelo={MODELO_DECISAO} tier={SERVICE_TIER} chamadas={n} | "
        f"input={inp:,} (cached={cached:,} / nao-cached={nao_cac:,}) | "
        f"output={out:,} | custo_estimado=US${custo:.4f}"
    )
MAX_PAGINAS_PDF  = 4
BASE_URL         = "https://api.openai.com"
MAX_BATCH_BYTES  = 50 * 1024 * 1024
UPLOAD_TIMEOUT   = 600

_DIR        = Path(__file__).parent
_PROMPT_PATH = _DIR.parent / "backend" / "data" / "prompt_confirmar.txt"
_STATE_DIR  = _DIR / ".pipeline_state"
_STATE_FILE = _STATE_DIR / "triagem_state.json"


def _load_batch_state() -> dict:
    if not _STATE_FILE.exists():
        return {"batches": []}
    try:
        return json.loads(_STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"batches": []}


def _save_batch_state(batch_id: str, custom_ids: list[str]):
    _STATE_DIR.mkdir(exist_ok=True)
    state = _load_batch_state()
    state["batches"].append({
        "batch_id"    : batch_id,
        "custom_ids"  : custom_ids,
        "submitted_at": datetime.now().isoformat(),
    })
    _STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def _clear_batch_state():
    if _STATE_FILE.exists():
        _STATE_FILE.unlink()

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
# PASSO 1 + 2 — IA (triagem + decisão final com imagens)
# ═══════════════════════════════════════════════════════════════════════════════

# ─── Busca faturas ─────────────────────────────────────────────────────────────

def buscar_faturas(cur, empresas: list[int] | None, top_n: int | None, force: bool = False,
                   uid_lista: list[str] | None = None,
                   id_lista: list[int] | None = None) -> list[dict]:
    """Busca faturas de FATURA_DADOS_EXTRAIDOS prontas para análise IA."""
    sql_emp   = f"AND fde.cod_empresa IN ({', '.join(str(e) for e in empresas)})" if empresas else ""
    sql_skip  = "" if force else "AND (fde.analise_ia IS NULL OR fde.analise_ia = '')"
    sql_limit = f"LIMIT {top_n}" if top_n else ""

    if id_lista:
        phs    = ", ".join(str(i) for i in id_lista)
        sql_id = f"AND fde.id IN ({phs})"
        sql_skip  = ""   # id_lista implica reprocessamento forçado
        sql_limit = ""
    else:
        sql_id = ""

    if uid_lista:
        placeholders = ", ".join(f"'{u}'" for u in uid_lista)
        sql_uid = f"AND fde.uid IN ({placeholders})"
        sql_skip  = ""   # uid_lista implica reprocessamento forçado
        sql_limit = ""
    else:
        sql_uid = ""

    cur.execute(f"""
        SELECT
            fde.id,
            fde.uid,
            fde.codigo_uc                            AS UC,
            COALESCE(fde.valor_total_fatura, 0)      AS valor,
            fde.distribuidora                         AS Concessionaria,
            fde.mes_referencia                        AS Mes_Ref,
            fde.cod_empresa,
            COALESCE(fde.analise_ia, '')              AS ia_analise_texto,
            COALESCE(fde.texto_plumber, '')           AS texto_plumber,
            COALESCE(fde.texto_markdown, '')          AS texto_markitdown,
            COALESCE(fde.texto_ocr, '')               AS texto_ocr,
            COALESCE(fde.link_fatura, '')             AS link
        FROM FATURA_DADOS_EXTRAIDOS fde
        WHERE (
            (CASE WHEN fde.texto_plumber  IS NOT NULL AND fde.texto_plumber  != '' THEN 1 ELSE 0 END) +
            (CASE WHEN fde.texto_markdown IS NOT NULL AND fde.texto_markdown != '' THEN 1 ELSE 0 END) +
            (CASE WHEN fde.texto_ocr      IS NOT NULL AND fde.texto_ocr      != '' THEN 1 ELSE 0 END)
          ) >= 1
          {sql_emp}
          {sql_id}
          {sql_uid}
          {sql_skip}
        ORDER BY fde.valor_total_fatura DESC
        {sql_limit}
    """)

    faturas = []
    for row in cur.fetchall():
        try:
            faturas.append({
                "id"              : row["id"],
                "uid"             : str(row.get("uid") or "").strip(),
                "UC"              : str(row["UC"] or ""),
                "valor"           : float(row["valor"] or 0),
                "concessionaria"  : str(row["Concessionaria"] or ""),
                "mes_ref"         : str(row["Mes_Ref"] or ""),
                "cod_empresa"     : row.get("cod_empresa"),
                "ia_analise_texto": str(row["ia_analise_texto"] or ""),
                "texto_plumber"   : str(row["texto_plumber"] or ""),
                "texto_markitdown": str(row["texto_markitdown"] or ""),
                "texto_ocr"       : str(row["texto_ocr"] or ""),
                "link"            : str(row["link"] or "").strip(),
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
    return f"""================================================================================
CONTEXTO COMPLEMENTAR — DADOS DO SISTEMA
================================================================================

=== IDENTIFICAÇÃO DA FATURA ===
ID: {fatura['id']}
UC: {fatura['UC']}
Concessionária: {fatura['concessionaria']}
Período: {fatura['mes_ref']}
Valor Total: R$ {fatura['valor']:,.2f}

=== ANÁLISE PRÉVIA ===
{fatura['ia_analise_texto'][:2000] if fatura['ia_analise_texto'] else '(não disponível)'}

=== EXTRAÇÕES DE TEXTO DA FATURA ===
As três extrações abaixo são geradas por métodos diferentes (Plumber, Markitdown, OCR).
Cada extrator pode capturar partes distintas — fragmentação é comum em layouts de duas colunas.

--- Plumber (extração estruturada de tabelas/PDF) ---
{fatura['texto_plumber'][:3000] or '(não disponível)'}

--- Markitdown (conversão Markdown do PDF) ---
{fatura['texto_markitdown'][:3000] or '(não disponível)'}

--- OCR (reconhecimento óptico de caracteres) ---
{fatura['texto_ocr'][:3000] or '(não disponível)'}

================================================================================
SUA TAREFA NESTA ETAPA: EXTRAÇÃO DE CAMPOS (não decisão de fichas)
================================================================================

Você NÃO deve confirmar nem refutar fichas nesta etapa.
Sua única tarefa é extrair e cruzar os campos numéricos dos três extratores acima.
A decisão sobre fichas será feita na próxima etapa, com as imagens da fatura.

PROCEDIMENTO:

1. Para cada campo abaixo, localize o valor em cada extrator (Plumber / Markitdown / OCR):
   - leitura_anterior (ponta e fora ponta)
   - leitura_atual (ponta e fora ponta)
   - constante / multiplicador
   - consumo_kwh faturado (ponta, fora ponta, total)
   - demanda faturada e contratada (ponta e fora ponta)
   - tarifa_te, tarifa_tusd
   - numero_medidor
   - historico de consumo (meses anteriores com kWh)
   - valor_total_fatura
   - tipo_bandeira, valor_bandeira
   - icms_aliq, pis_aliq, cofins_aliq

2. Para cada campo, registre:
   - O valor encontrado e em qual(is) extrator(es) aparece
   - Se há divergência entre extratores, registre ambos os valores
   - Se ausente em todos, registre como null

3. Classifique cada campo como:
   CONFIÁVEL — mesmo valor em 2+ extratores, ou único mas inequívoco
   DUVIDOSO  — valores diferentes entre extratores
   AUSENTE   — não encontrado em nenhum extrator

4. Monte o bloco ---CAMPOS_JSON--- com os campos CONFIÁVEIS extraídos.
   Para campos DUVIDOSOS, use o valor do OCR como fallback.
   Para AUSENTES, use null.

Formato obrigatório de saída:
---CAMPOS_JSON---
{{
  "leitura_anterior_p": <valor ou null>,
  "leitura_atual_p": <valor ou null>,
  "leitura_anterior_fp": <valor ou null>,
  "leitura_atual_fp": <valor ou null>,
  "constante_p": <valor ou null>,
  "consumo_kwh_ponta": <valor ou null>,
  "consumo_kwh_fponta": <valor ou null>,
  "demanda_faturada_ponta": <valor ou null>,
  "demanda_faturada_fponta": <valor ou null>,
  "demanda_contratada_ponta": <valor ou null>,
  "demanda_contratada_fponta": <valor ou null>,
  "tarifa_te": <valor ou null>,
  "tarifa_tusd": <valor ou null>,
  "numero_medidor": <valor ou null>,
  "valor_total_fatura": <valor ou null>,
  "tipo_bandeira": <valor ou null>,
  "icms_aliq": <valor ou null>,
  "historico_consumo": [{{"mes": "MM/YYYY", "kwh": <valor>}}]
}}
---FIM_CAMPOS_JSON---

Após o bloco JSON, escreva um parágrafo curto resumindo quais campos foram encontrados
com confiança e quais estavam ausentes ou duvidosos nos textos.
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
        "texto_analise"     : texto[:20000],
    }


# ─── Decisão final (Rodada 2) ─────────────────────────────────────────────────

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
    fonte = ("As imagens da fatura estao anexadas. Extraia diretamente dos dados impressos: "
             "leituras (anterior e atual), constante/multiplicador, kWh faturado por posto "
             "(ponta/fora ponta/reservado), demanda, fator de potencia, tarifa, medidor.") \
            if com_imagem else \
            "Analise com base nas extracoes de texto abaixo (podem estar incompletas)."

    return f"""================================================================================
PASSO 2 — DECISAO FINAL DE RESSARCIMENTO ({MODELO_DECISAO})
================================================================================

A base de conhecimento acima (PAPEL, REGRA ANTI-ALUCINACAO, fichas F01-F14, criterios
de validacao, regras financeiras) e VALIDA para esta etapa. Aplique-as integralmente.

Sua tarefa: analisar esta fatura de forma independente e decidir quais fichas
(F01-F14) se aplicam, com base nas imagens e nos campos pre-extraidos abaixo.
A etapa anterior apenas extraiu campos do texto — NAO confirmou fichas.
Sua saida e JSON estruturado (nao texto livre).

REGRA DE OURO: a evidencia matematica/tecnica deve suportar cada ficha.
NAO invente teses regulatorias (TUSD, ICMS, ACL, CCEE) — ver REGRA ANTI-ALUCINACAO.

================================================================================
DADOS DESTA FATURA
================================================================================
ID: {fatura['id']} | UC: {fatura['UC']} | {fatura['concessionaria']} | {fatura['mes_ref']} | R$ {fatura['valor']:,.2f}

CAMPOS PRE-EXTRAIDOS DO TEXTO (use como ponto de partida; valide contra as imagens):
{json.dumps(triagem['campos_json'], ensure_ascii=False, indent=2)}

RESUMO DA EXTRACAO DE TEXTO:
{triagem['texto_analise'][:4000]}

{fonte}

EXTRACOES DE TEXTO (use para validacao matematica quando imagem nao disponivel ou para cruzar dados):
--- Plumber ---
{fatura['texto_plumber'][:5000] or '(nao disponivel)'}
--- Markitdown ---
{fatura['texto_markitdown'][:5000] or '(nao disponivel)'}
--- OCR ---
{fatura['texto_ocr'][:5000] or '(nao disponivel)'}

================================================================================
INSTRUCOES DE SAIDA (CRITICO)
================================================================================

1. Para CADA ficha apontada pela triagem, aplique o criterio de validacao
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
    """Chama MODELO_DECISAO com ou sem imagens conforme disponibilidade.
    prompt_confirmar.txt vai no system para ativar cache automático da OpenAI.
    """
    com_imagem = len(imagens) > 0
    user_text  = _prompt_decisao(fatura, triagem, prompt_confirmar, com_imagem)

    user_content: list = [{"type": "text", "text": user_text}]
    for img in imagens:
        user_content.append({
            "type"     : "image_url",
            "image_url": {
                "url"   : f"data:{img['mime']};base64,{img['base64']}",
                "detail": "high",
            },
        })

    try:
        resp  = client.chat.completions.create(
            model                = MODELO_DECISAO,
            max_completion_tokens= 6144,
            service_tier         = SERVICE_TIER,
            messages             = [
                {"role": "system", "content": prompt_confirmar},
                {"role": "user",   "content": user_content},
            ],
        )
        _registrar_uso(resp.usage)
        texto = resp.choices[0].message.content.strip()
        modo  = "imagem" if com_imagem else "texto"
        log.info(f"  [Decisao/{modo}] ID {fatura['id']}: OK")
        return _parse_decisao(texto, triagem), texto
    except Exception as e:
        log.error(f"  [Decisao] Erro ID {fatura['id']}: {e}")
        err = {
            "decisao_final"           : "ERRO",
            "ficha_principal"         : triagem["fichas_confirmadas"][0] if triagem["fichas_confirmadas"] else "N/A",
            "fichas_confirmadas"      : triagem["fichas_confirmadas"],
            "confianca_final"         : 0,
            "percentual_ressarcimento": 0,
            "justificativa"           : f"Erro ao chamar {MODELO_DECISAO}: {str(e)[:200]}",
            "recomendacao"            : "Analise manual necessaria",
        }
        return err, ""


# ─── Gravação ─────────────────────────────────────────────────────────────────

def _gravar_fde_analise(cur, conn, uid: str,
                         analise_ia: str = None,
                         resultado_final: str = None,
                         fichas_apontadas: str = None):
    """Salva analise_ia (Passo 1) e/ou resultado final (Passo 2) em FATURA_DADOS_EXTRAIDOS."""
    if not uid:
        return
    sets = []
    vals = []
    if analise_ia:
        sets.append("`analise_ia` = %s, `ia_analisado_em` = NOW()")
        vals.append(analise_ia)
    if resultado_final:
        sets.append("`resultado_analises_final` = %s, `resultado_em` = NOW()")
        vals.append(resultado_final)
    if fichas_apontadas:
        sets.append("`fichas_apontadas` = %s")
        vals.append(fichas_apontadas)
    if not sets:
        return
    cur.execute(
        f"UPDATE FATURA_DADOS_EXTRAIDOS SET {', '.join(sets)} WHERE uid = %s",
        vals + [uid],
    )
    conn.commit()


def _gravar_ia_dados_extraidos(cur, conn, fatura_id: int, campos_json: dict,
                                distribuidora: str | None, uc: str | None,
                                uid: str | None = None, link: str | None = None,
                                cod_empresa: int | None = None):
    """Persiste campos extraídos pela IA na tabela FATURA_DADOS_EXTRAIDOS."""
    mapa = {
        "uc"                          : "codigo_uc",
        "concessionaria"              : "distribuidora",
        "mes_ref"                     : "mes_referencia",
        "numero_fatura"               : "numero_fatura",
        "nome_cliente"                : "nome_cliente",
        "dias_faturados"              : "dias_faturados",
        "modalidade_tarifaria"        : "modalidade_tarifaria",
        "tensao_fornecimento"         : "tensao_fornecimento",
        "numero_medidor"              : "numero_medidor",
        "kwh_total"                   : "consumo_ativo_fponta_kwh",
        "kwh_ponta"                   : "consumo_ativo_ponta_kwh",
        "kwh_fponta"                  : "consumo_ativo_fponta_kwh",
        "leitura_anterior_p"          : "leit_ant_ativa_ponta",
        "leitura_atual_p"             : "leit_atu_ativa_ponta",
        "leitura_anterior_fp"         : "leit_ant_ativa_fponta",
        "leitura_atual_fp"            : "leit_atu_ativa_fponta",
        "constante_p"                 : "constante_k",
        "constante_fp"                : "constante_k",
        "demanda_faturada_ponta_kw"   : "demanda_faturada_ponta_kw",
        "demanda_faturada_fponta_kw"  : "demanda_faturada_fponta_kw",
        "demanda_contratada_ponta_kw" : "demanda_contratada_ponta_kw",
        "demanda_contratada_fponta_kw": "demanda_contratada_fponta_kw",
        "tarifa_te"                   : "tarifa_te",
        "tarifa_tusd"                 : "tarifa_tusd",
        "subgrupo_tarifario"          : "subgrupo_tarifario",
        "tarifa_demanda"              : "tarifa_demanda",
        "valor_demanda"               : "valor_demanda",
        "tipo_bandeira"               : "tipo_bandeira_tarifaria",
        "valor_bandeira"              : "valor_bandeira",
        "total_rs"                    : "valor_total_fatura",
        "total_itens_rs"              : "valor_total_itens",
        "icms_aliq"                   : "icms_aliquota",
        "icms_rs"                     : "icms_valor",
        "base_icms_rs"                : "icms_base_calculo",
        "pis_aliq"                    : "pis_aliquota",
        "pis_rs"                      : "pis_valor",
        "cofins_aliq"                 : "cofins_aliquota",
        "cofins_rs"                   : "cofins_valor",
        "cip_rs"                      : "valor_cip_cosip",
        "reativo_excedente_rs"        : "valor_energia_reativa_excedente",
        "perda_transformacao_pct"     : "perda_transformacao_percentual",
        "consumo_medidor_ponta"       : "consumo_ativo_ponta_kwh",
        "consumo_medidor_fponta"      : "consumo_ativo_fponta_kwh",
    }

    # uid é obrigatório — é a chave única da tabela
    if not uid:
        log.warning(f"  [dados_extraidos/ia] fatura sem uid, ignorando gravação")
        return

    cols = ["uid", "fonte_extracao"]
    vals = [uid, "ia"]
    upd  = ["fonte_extracao = VALUES(fonte_extracao)",
            "atualizado_em = CURRENT_TIMESTAMP"]

    seen_cols: set[str] = {"uid"}

    for campo, col_db in mapa.items():
        if col_db in seen_cols:
            continue
        v = campos_json.get(campo)
        if v is None:
            continue
        # Rejeita valores inválidos conhecidos para numero_medidor
        if col_db == "numero_medidor" and str(v).strip().lower() in _MEDIDOR_BLOCKLIST:
            log.warning(f"  [dados_extraidos/ia] numero_medidor rejeitado: '{v}'")
            continue
        cols.append(col_db)
        vals.append(v)
        upd.append(f"`{col_db}` = VALUES(`{col_db}`)")
        seen_cols.add(col_db)

    # Distribuidora e UC como fallback
    if distribuidora and "distribuidora" not in seen_cols:
        cols.append("distribuidora"); vals.append(distribuidora)
        upd.append("`distribuidora` = VALUES(`distribuidora`)")
    if uc and "codigo_uc" not in seen_cols:
        cols.append("codigo_uc"); vals.append(uc)
        upd.append("`codigo_uc` = VALUES(`codigo_uc`)")

    # mercado_livre
    ml = campos_json.get("mercado_livre_acl")
    if ml:
        cols.append("indicador_mercado_livre"); vals.append(1)
        upd.append("`indicador_mercado_livre` = VALUES(`indicador_mercado_livre`)")

    # link_fatura e cod_empresa da fonte
    if link:
        cols.append("link_fatura"); vals.append(link)
        upd.append("`link_fatura` = VALUES(`link_fatura`)")
    if cod_empresa is not None:
        cols.append("cod_empresa"); vals.append(cod_empresa)
        upd.append("`cod_empresa` = VALUES(`cod_empresa`)")

    if len(cols) <= 2:
        return

    placeholders = ", ".join(["%s"] * len(cols))
    col_names    = ", ".join(f"`{c}`" for c in cols)
    upd_clause   = ", ".join(upd)

    cur.execute(
        f"INSERT INTO FATURA_DADOS_EXTRAIDOS ({col_names}) "
        f"VALUES ({placeholders}) "
        f"ON DUPLICATE KEY UPDATE {upd_clause}",
        vals,
    )
    conn.commit()


def gravar_resultado(cur, conn, fatura: dict, triagem: dict, decisao: dict, dry_run: bool,
                     texto_decisao_raw: str = ""):
    """Grava resultado_analises, Analise_IA e fichas_apontadas no banco."""
    fichas_triagem = triagem.get("fichas_confirmadas") or []

    if dry_run:
        log.info(f"  [DRY-RUN] ID {fatura['id']}: {decisao.get('decisao_final')} "
                 f"confianca={decisao.get('confianca_final')}%")
        return conn, cur

    uid = fatura.get("uid")

    for tentativa in range(3):
        try:
            # Garante conexão viva antes de gravar (pode ter caído durante chamada OpenAI)
            try:
                conn.ping(reconnect=True, attempts=3, delay=2)
            except Exception:
                conn, cur = _reconectar()

            # Grava campos extraídos pela IA em FATURA_DADOS_EXTRAIDOS
            cj = triagem.get("campos_json") or {}
            if cj:
                _gravar_ia_dados_extraidos(cur, conn, fatura["id"], cj,
                                           fatura.get("concessionaria"), fatura.get("UC"),
                                           uid=uid, link=fatura.get("link"),
                                           cod_empresa=fatura.get("cod_empresa"))

            # Grava analise_ia (Passo 1) e resultado final (Passo 2) em FATURA_DADOS_EXTRAIDOS
            if uid:
                _gravar_fde_analise(cur, conn, uid,
                    analise_ia=triagem.get("texto_analise"),
                    resultado_final=texto_decisao_raw or None,
                    fichas_apontadas=json.dumps(decisao, ensure_ascii=False) if decisao else None,
                )

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


# ─── Batch API helpers ────────────────────────────────────────────────────────

def _submit_batch(jsonl_lines: list[str], label: str, max_retries: int = 3) -> str:
    headers     = {"Authorization": f"Bearer {API_KEY}"}
    chunk_bytes = "\n".join(jsonl_lines).encode("utf-8", errors="ignore")
    log.info(f"  [{label}] Upload: {len(jsonl_lines)} reqs | {len(chunk_bytes)//1024} KB")

    file_id = None
    for attempt in range(1, max_retries + 1):
        try:
            up = requests.post(
                f"{BASE_URL}/v1/files",
                headers = headers,
                files   = {
                    "file"   : (f"{label}.jsonl", chunk_bytes, "application/jsonl"),
                    "purpose": (None, "batch"),
                },
                timeout = UPLOAD_TIMEOUT,
            )
            up.raise_for_status()
            file_id = up.json()["id"]
            break
        except (requests.ConnectionError, requests.Timeout) as e:
            if attempt < max_retries:
                wait = 30 * (2 ** (attempt - 1))
                log.warning(f"  [{label}] Upload falhou ({attempt}/{max_retries}): {e}. Aguardando {wait}s...")
                time.sleep(wait)
            else:
                raise

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


# ─── Triagem síncrona ─────────────────────────────────────────────────────────

def chamar_triagem(client: OpenAI, fatura: dict, prompt_confirmar: str) -> dict:
    """Chamada síncrona ao MODELO_TRIAGEM para extração de campos.
    prompt_confirmar.txt vai no system para ativar cache automático da OpenAI.
    """
    try:
        resp = client.chat.completions.create(
            model                = MODELO_TRIAGEM,
            max_completion_tokens= 4096,
            service_tier         = SERVICE_TIER,
            messages             = [
                {"role": "system", "content": prompt_confirmar},
                {"role": "user",   "content": _montar_contexto_triagem(fatura, prompt_confirmar)},
            ],
        )
        _registrar_uso(resp.usage)
        texto = resp.choices[0].message.content.strip()
        log.info(f"  [Triagem] ID {fatura['id']}: OK")
        return _parse_triagem(texto)
    except Exception as e:
        log.error(f"  [Triagem] Erro ID {fatura['id']}: {e}")
        return {"fichas_confirmadas": [], "campos_json": {}, "texto_analise": f"Erro: {e}"}


# ─── Retry erros ──────────────────────────────────────────────────────────────

def rodar_retry_erros(empresas: list[int] | None, dry_run: bool):
    """
    Reprocessa somente faturas com decisao_final = 'ERRO'.
    Recupera triagem já salva em resultado_analises e manda direto para
    MODELO_DECISAO com imagens — sem refazer o batch da Rodada 1.
    """
    log.info("=" * 60)
    log.info(f"RETRY ERROS/INVALIDOS — {MODELO_DECISAO} com imagens")
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
        sql_emp = f"AND fde.cod_empresa IN ({', '.join(str(e) for e in empresas)})" if empresas else ""
        cur.execute(f"""
            SELECT
                fde.id,
                fde.uid,
                fde.codigo_uc                           AS UC,
                COALESCE(fde.valor_total_fatura, 0)     AS valor,
                fde.distribuidora                        AS Concessionaria,
                fde.mes_referencia                       AS Mes_Ref,
                fde.cod_empresa,
                COALESCE(fde.texto_plumber, '')          AS texto_plumber,
                COALESCE(fde.texto_markdown, '')         AS texto_markitdown,
                COALESCE(fde.texto_ocr, '')              AS texto_ocr,
                COALESCE(fde.link_fatura, '')            AS link,
                COALESCE(fde.analise_ia, '')             AS analise_ia
            FROM FATURA_DADOS_EXTRAIDOS fde
            WHERE fde.fichas_apontadas IS NOT NULL
              AND fde.fichas_apontadas != ''
              AND JSON_EXTRACT(fde.fichas_apontadas, '$.decisao_final')
                  NOT IN ('CONFIRMADO', 'REFUTADO', 'INCONCLUSIVO')
              {sql_emp}
            ORDER BY fde.valor_total_fatura DESC
        """)
        rows = cur.fetchall()
        log.info(f"  Faturas com ERRO: {len(rows)}")

        if not rows:
            log.info("  Nenhuma fatura com ERRO encontrada.")
            return

        for idx, row in enumerate(rows, 1):
            fid = row["id"]
            log.info(f"  [{idx}/{len(rows)}] ID {fid} | UC {row['UC']} | R$ {float(row['valor'] or 0):,.2f}")

            fatura = {
                "id"              : fid,
                "uid"             : str(row.get("uid") or "").strip(),
                "UC"              : str(row["UC"] or ""),
                "valor"           : float(row["valor"] or 0),
                "concessionaria"  : str(row["Concessionaria"] or ""),
                "mes_ref"         : str(row["Mes_Ref"] or ""),
                "cod_empresa"     : row.get("cod_empresa"),
                "ia_analise_texto": "",
                "texto_plumber"   : str(row["texto_plumber"] or ""),
                "texto_markitdown": str(row["texto_markitdown"] or ""),
                "texto_ocr"       : str(row["texto_ocr"] or ""),
                "link"            : str(row["link"] or "").strip(),
            }

            # Recupera triagem do analise_ia salvo em FDE
            triagem = _parse_triagem(str(row["analise_ia"] or ""))

            log.info(f"    triagem (de analise_ia): fichas={triagem['fichas_confirmadas']}")

            # Baixa PDF e converte em imagens
            imagens = []
            link    = fatura.get("link", "")
            if link:
                pdf_bytes = baixar_pdf(link)
                if pdf_bytes:
                    imagens = pdf_para_imagens(pdf_bytes)

            if not imagens:
                log.warning(f"    Sem imagens — {MODELO_DECISAO} texto")

            decisao, texto_decisao_raw = chamar_decisao(client, fatura, triagem, imagens, prompt_confirmar)
            log.info(f"    Decisao: {decisao.get('decisao_final')} | confianca={decisao.get('confianca_final')}%")

            conn, cur = gravar_resultado(cur, conn, fatura, triagem, decisao, dry_run,
                                         texto_decisao_raw=texto_decisao_raw)

        log.info(f"\n[OK] Retry concluido: {len(rows)} faturas reprocessadas.")

    except Exception as e:
        log.error(f"Erro no retry: {e}", exc_info=True)
        raise
    finally:
        cur.close()
        conn.close()


# ─── Pipeline IA ──────────────────────────────────────────────────────────────

def rodar_ia(empresas: list[int] | None, top_n: int | None, dry_run: bool,
             force: bool = False, batch: bool = False, retomar: bool = False,
             uid_lista: list[str] | None = None,
             id_lista: list[int] | None = None,
             sem_triagem: bool = False):
    """Passo 1+2: triagem (sync ou batch) + decisão final com imagens.
    Com --sem-triagem pula o Passo 1 e vai direto para Passo 2 com imagens.
    """
    log.info("=" * 60)
    if sem_triagem:
        log.info("PASSO 2 DIRETO — decisão final com imagens (triagem desativada)")
    else:
        log.info("PASSO 1+2 — extração de campos (texto) + decisão final com imagens")
    log.info(f"  Modelo triagem : {MODELO_TRIAGEM if not sem_triagem else '(desativado)'}")
    log.info(f"  Modelo decisao : {MODELO_DECISAO}")
    log.info(f"  Force          : {force}")
    log.info(f"  Triagem        : {'DESATIVADA (--sem-triagem)' if sem_triagem else 'BATCH (50% desc, até 24h)' if batch else 'SYNC'}")

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
        if id_lista:
            modo_busca = f"{len(id_lista)} IDs especificados (--id)"
        elif uid_lista:
            modo_busca = f"{len(uid_lista)} UIDs especificados (--uid-arquivo)"
        elif force:
            modo_busca = "todas (--force)"
        else:
            modo_busca = "apenas sem analise_ia"
        log.info(f"\nBuscando faturas ({modo_busca})...")
        faturas = buscar_faturas(cur, empresas, top_n, force=force,
                                 uid_lista=uid_lista, id_lista=id_lista)
        log.info(f"  Encontradas: {len(faturas)} faturas")

        if not faturas:
            log.warning("  Nenhuma fatura encontrada.")
            return

        triagem_resultados: dict[int, dict] = {}

        if sem_triagem:
            # ── Sem triagem: popula com triagem vazia e vai direto para Passo 2 ──
            log.info(f"\nTriagem desativada — {len(faturas)} faturas vão direto para Passo 2...")
            for fatura in faturas:
                triagem_resultados[fatura["id"]] = {
                    "fatura" : fatura,
                    "triagem": {"fichas_confirmadas": [], "campos_json": {}, "texto_analise": ""},
                }
        else:
            # ── Rodada 1: extração de campos (texto) ─────────────────────────────
            log.info(f"\nRodada 1: extração de campos com {MODELO_TRIAGEM} ({len(faturas)} faturas)...")
            fatura_map = {f"triagem-{f['id']}": f for f in faturas}

            def _consumir_linhas(linhas: list[str]) -> int:
                n = 0
                for linha in linhas:
                    try:
                        obj = json.loads(linha)
                    except Exception:
                        continue
                    cid = obj.get("custom_id", "")
                    fat = fatura_map.get(cid)
                    if not fat:
                        continue
                    texto = (obj.get("response", {})
                                .get("body", {})
                                .get("choices", [{}])[0]
                                .get("message", {})
                                .get("content", ""))
                    triagem_resultados[fat["id"]] = {"fatura": fat, "triagem": _parse_triagem(texto)}
                    n += 1
                return n

            if batch:
                # ── Batch API ────────────────────────────────────────────────
                state = _load_batch_state()
                if retomar and state["batches"]:
                    log.info(f"  [RETOMAR] {len(state['batches'])} batch(es) anteriores")
                    for entry in state["batches"]:
                        bid = entry["batch_id"]
                        try:
                            linhas = _wait_batch(bid, f"retomar-{bid[:18]}")
                            n = _consumir_linhas(linhas)
                            log.info(f"  [retomar] {bid}: {n} resultados aproveitados")
                        except Exception as e:
                            log.warning(f"  [retomar] falha em {bid}: {e}")
                elif state["batches"] and not retomar:
                    log.warning(
                        f"  [AVISO] {len(state['batches'])} batch(es) ignorados. "
                        f"Use --retomar para aproveitar."
                    )

                pendentes = [f for f in faturas if f["id"] not in triagem_resultados]
                log.info(f"  Pendentes para batch: {len(pendentes)}")

                if pendentes:
                    jsonl = []
                    for fat in pendentes:
                        jsonl.append(json.dumps({
                            "custom_id": f"triagem-{fat['id']}",
                            "method"   : "POST",
                            "url"      : "/v1/chat/completions",
                            "body"     : {
                                "model"               : MODELO_TRIAGEM,
                                "max_completion_tokens": 4096,
                                "messages"            : [{"role": "user", "content": _montar_contexto_triagem(fat, prompt_confirmar)}],
                            },
                        }, ensure_ascii=True))

                    for i, chunk in enumerate(_chunks(jsonl), 1):
                        cids = [json.loads(l)["custom_id"] for l in chunk]
                        bid  = _submit_batch(chunk, f"triagem-chunk{i}")
                        _save_batch_state(bid, cids)
                        linhas = _wait_batch(bid, f"triagem-chunk{i}")
                        n = _consumir_linhas(linhas)
                        log.info(f"  [chunk{i}] {n} resultados | acumulado: {len(triagem_resultados)}")

                # Reconecta — batch pode ter durado horas
                conn, cur = _reconectar()
            else:
                # ── Síncrono ─────────────────────────────────────────────────
                for idx, fatura in enumerate(faturas, 1):
                    log.info(f"  [{idx}/{len(faturas)}] Extração ID {fatura['id']} | UC {fatura['UC']}")
                    triagem = chamar_triagem(client, fatura, prompt_confirmar)
                    triagem_resultados[fatura["id"]] = {"fatura": fatura, "triagem": triagem}

                    uid_fat = fatura.get("uid")
                    if uid_fat:
                        try:
                            conn.ping(reconnect=True, attempts=3, delay=2)
                        except Exception:
                            conn, cur = _reconectar()
                        _gravar_fde_analise(cur, conn, uid_fat,
                                            analise_ia=triagem.get("texto_analise", ""))

            log.info(f"Rodada 1 concluída: {len(triagem_resultados)} faturas — campos extraídos")

        todas = list(triagem_resultados.values())

        # ── Rodada 2: decisão final com MODELO_DECISAO + imagens ─────────────
        log.info(f"\nRodada 2: decisao final com {MODELO_DECISAO} + imagens ({len(todas)} faturas)...")

        n_img = n_txt = 0

        for idx, item in enumerate(todas, 1):
            fatura  = item["fatura"]
            triagem = item["triagem"]

            log.info(
                f"  [{idx}/{len(todas)}] ID {fatura['id']} | UC {fatura['UC']} | R$ {fatura['valor']:,.2f}"
            )

            imagens = []
            link    = fatura.get("link", "")
            if link:
                pdf_bytes = baixar_pdf(link)
                if pdf_bytes:
                    imagens = pdf_para_imagens(pdf_bytes)

            decisao, texto_decisao_raw = chamar_decisao(client, fatura, triagem, imagens, prompt_confirmar)

            if imagens:
                n_img += 1
            else:
                n_txt += 1

            conn, cur = gravar_resultado(cur, conn, fatura, triagem, decisao, dry_run,
                                         texto_decisao_raw=texto_decisao_raw)

        log.info(f"\n[OK] Rodada 2 concluída: {n_img} com imagem | {n_txt} texto")

        if batch and not dry_run:
            _clear_batch_state()

    except Exception as e:
        log.error(f"Erro no Passo 2+3: {e}", exc_info=True)
        raise
    finally:
        cur.close()
        conn.close()
        _log_uso_total("rodar_ia")


# ═══════════════════════════════════════════════════════════════════════════════
# COMPLETAR CAMPOS — gpt-5 lê textos extraídos e preenche/corrige campos
# ═══════════════════════════════════════════════════════════════════════════════

MODELO_CAMPOS = "gpt-5"

# Palavras que NUNCA são um número de medidor válido
_MEDIDOR_BLOCKLIST = frozenset({
    "grandezas", "único", "unico", "postos", "tarifários", "tarifarios",
    "enrg", "atv", "kwh", "medidor", "leitura", "anterior", "atual",
    "consumo", "constante", "ponta", "conjunto", "grandeza", "n/a",
})

_CAMPOS_TEMPLATE_CAMPOS = """{
  "numero_medidor":      null,
  "leitura_anterior_p":  null,
  "leitura_atual_p":     null,
  "constante_p":         null,
  "kwh_total":           null,
  "tarifa_te":           null,
  "tarifa_tusd":         null,
  "tipo_bandeira":       null,
  "valor_bandeira":      null,
  "cip_rs":              null,
  "base_icms_rs":        null,
  "icms_aliq":           null,
  "icms_rs":             null,
  "pis_aliq":            null,
  "pis_rs":              null,
  "cofins_aliq":         null,
  "cofins_rs":           null,
  "tensao_fornecimento": null,
  "subgrupo_tarifario":  null,
  "total_rs":            null,
  "total_itens_rs":      null
}"""


def _chamar_completar_campos(client: OpenAI, uid: str,
                              texto_plumber: str, texto_markdown: str,
                              texto_ocr: str, analise_ia: str) -> dict:
    """Chama MODELO_CAMPOS para extrair/corrigir campos estruturados da fatura.
    Usa prompt_confirmar.txt como base de conhecimento (mesma fonte de verdade do pipeline).
    """
    system_msg = (
        _PROMPT_PATH.read_text(encoding="utf-8")
        if _PROMPT_PATH.exists()
        else "Você é um extrator preciso de campos de faturas de energia elétrica brasileiras."
    )

    partes = []
    melhor = texto_plumber or texto_markdown or texto_ocr
    if melhor:
        partes.append(f"=== TEXTO DA FATURA ===\n{melhor[:9000]}")
    if analise_ia:
        partes.append(f"=== ANÁLISE PRÉVIA (IA) ===\n{analise_ia[:2000]}")

    if not partes:
        return {}

    user_msg = (
        "\n\n".join(partes)
        + f"\n\nExtraia os campos abaixo. Retorne APENAS o JSON preenchido (sem texto extra):\n{_CAMPOS_TEMPLATE_CAMPOS}"
    )

    try:
        resp = client.chat.completions.create(
            model=MODELO_CAMPOS,
            temperature=0,
            max_tokens=800,
            messages=[
                {"role": "system", "content": system_msg},
                {"role": "user",   "content": user_msg},
            ],
        )
        raw = resp.choices[0].message.content or ""
        m = re.search(r"\{[\s\S]+\}", raw)
        if not m:
            log.warning(f"  [completar-campos] uid={uid}: sem JSON na resposta")
            return {}
        campos = json.loads(m.group(0))

        # Valida numero_medidor: rejeita palavras genéricas do cabeçalho da tabela
        med = campos.get("numero_medidor")
        if med and str(med).strip().lower() in _MEDIDOR_BLOCKLIST:
            log.warning(f"  [completar-campos] uid={uid}: numero_medidor rejeitado ('{med}') — blocklist")
            campos["numero_medidor"] = None

        return campos
    except Exception as e:
        log.warning(f"  [completar-campos] uid={uid}: erro GPT — {e}")
        return {}


def rodar_completar_campos(empresas=None, top_n=None, dry_run=False, force=False):
    """
    Passo adicional: gpt-4.1-mini analisa textos extraídos + analise_ia e
    preenche/corrige campos estruturados em FATURA_DADOS_EXTRAIDOS.

    Uso:
        python pipeline.py --completar-campos --empresa 189
        python pipeline.py --completar-campos --empresa 189 --force   # reprocessa todos
        python pipeline.py --completar-campos --empresa 189 --top 20  # limitar
        python pipeline.py --completar-campos --empresa 189 --dry-run
    """
    conn, cur = _conectar()
    client    = OpenAI(api_key=API_KEY)

    filtros = ["fde.texto_plumber IS NOT NULL"]
    params  = []

    if empresas:
        filtros.append(f"fde.cod_empresa IN ({','.join(['%s']*len(empresas))})")
        params += list(empresas)

    if not force:
        # Sem --force: só processa quem tem ao menos um campo crítico em NULL
        filtros.append(
            "(fde.tarifa_te IS NULL OR fde.tarifa_tusd IS NULL "
            "OR fde.leit_ant_ativa_ponta IS NULL OR fde.valor_bandeira IS NULL "
            "OR fde.numero_medidor IS NULL)"
        )

    where   = " AND ".join(filtros)
    lim_sql = f"LIMIT {top_n}" if top_n else ""

    cur.execute(f"""
        SELECT fde.id, fde.uid, fde.cod_empresa, fde.link_fatura,
               fde.texto_plumber, fde.texto_markdown, fde.texto_ocr, fde.analise_ia
        FROM FATURA_DADOS_EXTRAIDOS fde
        WHERE {where}
        ORDER BY fde.id DESC
        {lim_sql}
    """, params)
    faturas = cur.fetchall()

    log.info(f"[completar-campos] {len(faturas)} faturas para processar | modelo: {MODELO_CAMPOS}")

    ok = erro = 0
    for i, fat in enumerate(faturas, 1):
        uid = fat["uid"]
        log.info(f"  [{i}/{len(faturas)}] uid={uid} id={fat['id']}")

        campos_gpt = _chamar_completar_campos(
            client, uid,
            fat.get("texto_plumber") or "",
            fat.get("texto_markdown") or "",
            fat.get("texto_ocr") or "",
            fat.get("analise_ia") or "",
        )

        if not campos_gpt:
            log.warning(f"    sem campos extraídos")
            erro += 1
            continue

        preenchidos = [k for k, v in campos_gpt.items() if v is not None]
        log.info(f"    {len(preenchidos)} campos: {preenchidos}")

        if not dry_run:
            try:
                conn.ping(reconnect=True, attempts=3, delay=2)
            except Exception:
                conn, cur = _reconectar()

            _gravar_ia_dados_extraidos(
                cur, conn, fat["id"], campos_gpt,
                distribuidora=None, uc=None,
                uid=uid,
                link=fat.get("link_fatura"),
                cod_empresa=fat.get("cod_empresa"),
            )
        ok += 1

    log.info(f"\n[completar-campos] concluído: {ok} ok | {erro} erro | {len(faturas)} total")
    cur.close()
    conn.close()


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="Pipeline de auditoria: triagem 4o-mini (texto) + decisao 4.1-mini (imagem)"
    )
    parser.add_argument("--empresa",     type=int, nargs="+", default=None,
                        help="Filtrar por Cod_Empresa (ex: 14  ou  4 14 32)")
    parser.add_argument("--top",         type=int, default=None,
                        help="Limitar N faturas (padrão: todas)")
    parser.add_argument("--dry-run",     action="store_true",
                        help="Executa sem gravar no banco")
    parser.add_argument("--force",       action="store_true",
                        help="Reprocessa mesmo quem ja tem resultado_analises preenchido")
    parser.add_argument("--batch",       action="store_true",
                        help="Triagem via Batch API (50%% desc, até 24h)")
    parser.add_argument("--retomar",     action="store_true",
                        help="Aproveita batches ja submetidos (usa .pipeline_state/triagem_state.json)")
    parser.add_argument("--retry-erros", action="store_true",
                        help="Reprocessa faturas com decisao_final invalido (ERRO, NEGADO, etc) com imagens")
    parser.add_argument("--modelo", type=str, default=None, metavar="MODELO",
                        help="Modelo para análise com imagens (default: gpt-4.1-mini). Ex: --modelo 5.4")
    parser.add_argument("--completar-campos", action="store_true",
                        help="gpt-4.1-mini analisa textos extraídos e preenche/corrige campos da tabela")
    parser.add_argument("--uid-arquivo", type=str, default=None, metavar="ARQUIVO",
                        help="Arquivo .txt com uma UID por linha — reprocessa somente esses registros")
    parser.add_argument("--id", type=int, nargs="+", default=None, metavar="ID",
                        help="IDs específicos de FATURA_DADOS_EXTRAIDOS (ex: --id 274 ou --id 274 310)")
    parser.add_argument("--com-triagem", action="store_true",
                        help="Ativa Passo 1 de extração de campos via texto (desativado por padrão)")
    parser.add_argument("--flex", action="store_true",
                        help="Usa service_tier=flex (menor custo, maior latência)")
    args = parser.parse_args()

    global MODELO_DECISAO, SERVICE_TIER
    if args.modelo:
        MODELO_DECISAO = args.modelo if args.modelo.startswith("gpt-") else f"gpt-{args.modelo}"
    if args.flex:
        SERVICE_TIER = "flex"

    # Carrega lista de UIDs se --uid-arquivo foi passado
    uid_lista: list[str] | None = None
    if args.uid_arquivo:
        uid_path = Path(args.uid_arquivo)
        if not uid_path.exists():
            log.error(f"[ERRO] Arquivo de UIDs nao encontrado: {uid_path}")
            return
        uid_lista = [u.strip() for u in uid_path.read_text(encoding="utf-8").splitlines() if u.strip()]
        log.info(f"  UID-arquivo : {uid_path} ({len(uid_lista)} UIDs)")

    # --id: IDs diretos de FATURA_DADOS_EXTRAIDOS
    id_lista: list[int] | None = args.id if args.id else None

    log.info("=" * 70)
    log.info("PIPELINE DE AUDITORIA DE FATURAS")
    log.info(f"  Empresas    : {args.empresa or 'todas'}")
    log.info(f"  Top N       : {args.top or 'todas'}")
    log.info(f"  Dry-run     : {args.dry_run}")
    log.info(f"  Force       : {args.force}")
    log.info(f"  Triagem     : {'BATCH' if args.batch else 'SYNC'}")
    log.info(f"  Retry erros : {args.retry_erros}")
    log.info(f"  Modelo imagem: {MODELO_DECISAO}")
    log.info(f"  UID-lista   : {len(uid_lista) if uid_lista else 'N/A'}")
    log.info(f"  ID-lista    : {id_lista or 'N/A'}")
    log.info(f"  Com triagem : {args.com_triagem}")
    log.info(f"  Service tier: {SERVICE_TIER}")
    log.info("=" * 70)

    if args.retry_erros:
        rodar_retry_erros(empresas=args.empresa, dry_run=args.dry_run)
        return

    if args.completar_campos:
        rodar_completar_campos(empresas=args.empresa, top_n=args.top,
                               dry_run=args.dry_run, force=args.force)
        return

    rodar_ia(empresas=args.empresa, top_n=args.top, dry_run=args.dry_run,
             force=args.force, batch=args.batch, retomar=args.retomar,
             uid_lista=uid_lista, id_lista=id_lista,
             sem_triagem=not args.com_triagem)

    log.info("\nPipeline concluido.")


if __name__ == "__main__":
    main()
