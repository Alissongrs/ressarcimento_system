"""
analisar_batch.py
-----------------
Análise IA (F01-F14) em lote com visão real da fatura.
Para cada fatura:
  1. Monta contexto: histórico banco + textos extraídos (plumber/markitdown/ocr)
  2. No modo padrão: baixa PDF e envia imagens + texto para OpenAI
  3. No modo --batch: usa OpenAI Batch API (50% mais barato, texto-only)
  4. Salva resultado em Faturas_Registradas_Cache e fichas_anomalias_cache

Uso:
    python analisar_batch.py --empresa 14 --direto --batch
    python analisar_batch.py --empresa 4 14 32 --direto --batch
    python analisar_batch.py --all-empresas --direto --batch
    python analisar_batch.py --empresa 14 --direto --limite 20
    python analisar_batch.py --empresa 14 --direto --force    # re-processa CONFIRMADO/FALSO_POSITIVO
"""

import argparse
import base64
import io
import json
import logging
import os
import re
import sys
import tempfile
import time
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")


import mysql.connector
import requests

try:
    import pypdfium2 as pdfium
    HAS_PDFIUM = True
except ImportError:
    HAS_PDFIUM = False

# ─── Configuração ─────────────────────────────────────────────────────────────
OPENAI_API_KEY   = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL     = "gpt-4.1-mini"       # modelo com visão (padrão)
OPENAI_MODEL_MINI = "gpt-4.1-mini"  # modelo para batch
OPENAI_BASE_URL  = "https://api.openai.com"
OPENAI_TIMEOUT   = 300

MAX_PAGINAS_PDF = 4    # máximo de páginas da fatura a enviar como imagem
ESCALA_PDF      = 2.0  # resolução da imagem (2x = boa qualidade)
PAUSA_ENTRE     = 1.5  # segundos entre faturas

PROMPT_PATHS = [
    Path(__file__).parent.parent / "backend" / "data" / "prompt_confirmar.txt",
    Path("data") / "prompt_confirmar.txt",
]

# ─── Banco ────────────────────────────────────────────────────────────────────

DB_APP = dict(
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

# ─── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level    = logging.INFO,
    format   = "%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt  = "%Y-%m-%d %H:%M:%S",
    handlers = [
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("analisar_batch.log", encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)

# ─── Utilitários ──────────────────────────────────────────────────────────────

def _sanitize(text: str) -> str:
    """Remove surrogate characters e outros caracteres inválidos para UTF-8."""
    if not isinstance(text, str):
        text = str(text) if text is not None else ""
    # surrogatepass codifica surrogates como CESU-8 inválido → ignore remove na decodificação
    return text.encode("utf-8", errors="surrogatepass").decode("utf-8", errors="ignore")

def _reconectar():
    """Cria nova conexão ao banco quando a existente caiu."""
    conn = mysql.connector.connect(**DB_APP)
    cur  = conn.cursor(dictionary=True)
    return cur, conn

# ─── Prompt ───────────────────────────────────────────────────────────────────

def carregar_prompt() -> str:
    for p in PROMPT_PATHS:
        if p.exists():
            log.info(f"Prompt carregado: {p}")
            return p.read_text(encoding="utf-8")
    raise FileNotFoundError(f"prompt_confirmar.txt não encontrado em: {PROMPT_PATHS}")

# ─── PDF → imagens ────────────────────────────────────────────────────────────

def pdf_bytes_para_imagens(pdf_bytes: bytes) -> list[dict]:
    """Converte PDF em lista de imagens base64 PNG."""
    if not HAS_PDFIUM:
        log.warning("pypdfium2 não instalado — sem visão de imagem. pip install pypdfium2")
        return []
    try:
        pdf = pdfium.PdfDocument(pdf_bytes)
        imagens = []
        for i in range(min(len(pdf), MAX_PAGINAS_PDF)):
            page = pdf[i]
            bitmap = page.render(scale=ESCALA_PDF)
            pil_img = bitmap.to_pil()
            buf = io.BytesIO()
            pil_img.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode()
            imagens.append({"base64": b64, "mime": "image/png", "pagina": i + 1})
        log.info(f"    PDF → {len(imagens)} imagem(ns)")
        return imagens
    except Exception as e:
        log.warning(f"    Erro ao converter PDF: {e}")
        return []

def baixar_pdf(url: str) -> bytes | None:
    try:
        r = requests.get(url, timeout=30, stream=True)
        r.raise_for_status()
        return r.content
    except Exception as e:
        log.warning(f"    Falha no download: {e}")
        return None

# ─── Histórico do banco ────────────────────────────────────────────────────────

def buscar_historico(cur, uc: str, mes_ref_prefix: str):
    cur.execute("""
        SELECT Mes_Ref,
               COALESCE(KWH_Ponta, 0)    AS kwh_ponta,
               COALESCE(KWH_FPonta, 0)   AS kwh_fp,
               COALESCE(KWH_Reservado,0) AS kwh_reservado,
               COALESCE(KWH_Total, 0)    AS kwh_total,
               COALESCE(RS_Total_Fatura,0) AS rs_total,
               COALESCE(Tarifa_Cheia_KWH_Ponta_SImpostos, 0)    AS tarifa_ponta,
               COALESCE(Tarifa_Cheia_KWH_FPonta_SImpostos, 0)   AS tarifa_fp,
               COALESCE(Tarifa_Cheia_KWH_Reservado_SImpostos,0) AS tarifa_reservado
        FROM Faturas_Registradas_Cache
        WHERE UC = %s
          AND KWH_Total > 0
        ORDER BY Mes_Ref DESC
        LIMIT 48
    """, (uc,))
    all_rows = cur.fetchall()

    historico, post_all = [], []
    for r in all_rows:
        mes = str(r["Mes_Ref"])[:7]
        r["_mes"] = mes
        if mes_ref_prefix and mes > mes_ref_prefix:
            post_all.append(r)
        elif not mes_ref_prefix or mes < mes_ref_prefix:
            if len(historico) < 24:   # até 24 meses anteriores
                historico.append(r)

    post_all.reverse()           # ASC → imediatamente seguintes primeiro
    # Se não há histórico anterior, passa até 12 meses posteriores para contexto
    n_post = 12 if not historico else 3
    posteriores = post_all[:n_post]
    return historico, posteriores

def buscar_anomalias_historicas(cur, uc: str, mes_ref_prefix: str) -> list:
    """
    Retorna anomalias confirmadas/inconclusivas anteriores para esta UC,
    a partir de fichas_anomalias_cache. Usado para consultar o banco
    antes de encerrar o diagnóstico da IA.
    """
    try:
        cur.execute("""
            SELECT
                DATE_FORMAT(fac.Mes_Ref, '%%Y-%%m') AS mes,
                fac.fichas_aplicadas,
                fac.ia_status,
                COALESCE(fac.ia_fichas_confirmadas, '') AS ia_fichas,
                COALESCE(fac.desvio_pct_max, 0)         AS desvio_pct,
                COALESCE(fac.valor_ressarcimento_estimado, 0) AS ressarc
            FROM fichas_anomalias_cache fac
            WHERE fac.UC = %s
              AND fac.deletado = 0
              AND (fac.ia_status IN ('CONFIRMADO', 'INCONCLUSIVO') OR fac.fichas_aplicadas IS NOT NULL)
            ORDER BY fac.Mes_Ref DESC
            LIMIT 12
        """, (uc,))
        rows = cur.fetchall()
        # filtra apenas meses anteriores ao mês analisado
        return [r for r in rows if not mes_ref_prefix or str(r["mes"]) < mes_ref_prefix]
    except Exception as e:
        log.warning(f"    buscar_anomalias_historicas: {e}")
        return []

def fmt_hist(rows) -> str:
    lines = ["{"]
    for r in rows:
        lines.append(
            f'  {{"mes":"{r["_mes"]}",'
            f'"kwh_ponta":{r["kwh_ponta"]:.1f},'
            f'"kwh_fp":{r["kwh_fp"]:.1f},'
            f'"kwh_reservado":{r["kwh_reservado"]:.1f},'
            f'"kwh_total":{r["kwh_total"]:.1f},'
            f'"rs_total":{r["rs_total"]:.2f},'
            f'"tarifa_ponta":{r["tarifa_ponta"]:.6f},'
            f'"tarifa_fp":{r["tarifa_fp"]:.6f},'
            f'"tarifa_reservado":{r["tarifa_reservado"]:.6f}}},'
        )
    lines.append("}")
    return "\n".join(lines)

def fmt_post(rows) -> str:
    lines = ["{"]
    for r in rows:
        lines.append(
            f'  {{"mes":"{r["_mes"]}",'
            f'"kwh_ponta":{r["kwh_ponta"]:.1f},'
            f'"kwh_fp":{r["kwh_fp"]:.1f},'
            f'"kwh_reservado":{r["kwh_reservado"]:.1f},'
            f'"kwh_total":{r["kwh_total"]:.1f}}},'
        )
    lines.append("}")
    return "\n".join(lines)

# ─── Monta contexto texto ─────────────────────────────────────────────────────

def _campos_banco_dict(fatura: dict) -> dict:
    return {
        "KWH_Ponta":               fatura.get("KWH_Ponta"),
        "KWH_FPonta":              fatura.get("KWH_FPonta"),
        "KWH_Reservado":           fatura.get("KWH_Reservado"),
        "KWH_Total":               fatura.get("KWH_Total"),
        "Leitura_Anterior_KWH_P":  fatura.get("Leitura_Anterior_KWH_P"),
        "Leitura_Atual_KWH_P":     fatura.get("Leitura_Atual_KWH_P"),
        "Leitura_Anterior_KWH_FP": fatura.get("Leitura_Anterior_KWH_FP"),
        "Leitura_Atual_KWH_FP":    fatura.get("Leitura_Atual_KWH_FP"),
        "Constante_KWH_P":         fatura.get("Constante_KWH_P"),
        "Constante_KWH_FP":        fatura.get("Constante_KWH_FP"),
        "Base_de_Calculo_ICMS":    fatura.get("Base_de_Calculo_ICMS"),
        "Aliquota_ICMS":           fatura.get("Aliquota_ICMS"),
        "ICMS_RS":                 fatura.get("ICMS_RS"),
        "CIP":                     fatura.get("CIP"),
        "Vencimento":              str(fatura.get("Dt_Venc_NF") or ""),
    }


def montar_contexto(ficha: dict, fatura: dict, historico: list, posteriores: list,
                    direto: bool = False, anomalias_historicas: list = None) -> str:
    ctx = []

    # ── Cabeçalho de identificação ─────────────────────────────────────────────
    ctx.append("=== DADOS DA FATURA ===")
    ctx.append(f'UC: {ficha["UC"]}')
    ctx.append(f'Mês de Referência: {ficha["Mes_Ref"]}')
    ctx.append(f'Concessionária: {ficha["Concessionaria"]}')
    ctx.append(f'Tensão: {ficha.get("Tp_Tensao") or "não informado"}')
    ctx.append(f'Medidor: {ficha.get("NroMedidor") or "não informado"}')
    ctx.append(f'Cliente: {ficha.get("RAZAO_SOCIAL") or "não informado"}')
    ctx.append(f'Valor Total Fatura: R$ {float(ficha.get("RS_Total_Fatura") or 0):.2f}')

    fichas_motor = ficha.get("fichas_aplicadas") or ""
    if fichas_motor:
        ctx.append(f'Fichas detectadas pelo motor de regras: {fichas_motor}')
        ctx.append(f'Detalhamento do motor: {ficha.get("detalhamento") or ""}')

    if direto:
        # ── INSTRUÇÕES DUAS FASES ──────────────────────────────────────────────
        ctx.append("\n" + "=" * 60)
        ctx.append("ANÁLISE EM DUAS FASES — SIGA ESTA ORDEM OBRIGATORIAMENTE")
        ctx.append("=" * 60)
        ctx.append(
            "\nFASE 1 — ANÁLISE EXCLUSIVA DO PDF\n"
            "  • Leia os textos e imagens da fatura abaixo.\n"
            "  • Extraia todos os campos: leituras, constante, kWh, histórico, preços, tributos.\n"
            "  • Aplique F01 a F05 considerando APENAS o que está no PDF/imagens.\n"
            "  • Registre no bloco ---FASE 1--- os valores extraídos e fichas suspeitas.\n"
            "\nFASE 2 — CONFRONTO COM O BANCO DE DADOS\n"
            "  • Compare os valores extraídos na FASE 1 com os dados do banco (seção BANCO abaixo).\n"
            "  • Identifique CONVERGÊNCIAS (PDF = banco) e DIVERGÊNCIAS (PDF ≠ banco).\n"
            "  • Uma divergência pode indicar dado incorreto no banco, erro na fatura ou anomalia real.\n"
            "  • Atualize o diagnóstico se a comparação mudar ou confirmar alguma ficha.\n"
            "  • Registre no bloco ---FASE 2--- as divergências e o impacto no diagnóstico.\n"
            "\nSAÍDA FINAL — use o formato padrão da SAÍDA após os dois blocos acima.\n"
        )
        ctx.append("=" * 60)

        # ── FASE 1: PDF textos ─────────────────────────────────────────────────
        ctx.append("\n>>> FASE 1 — FONTES DO PDF <<<\n")
        plumber = str(fatura.get("texto_plumber") or "").strip()
        if plumber and not plumber.startswith("[ERRO_"):
            ctx.append("=== TEXTO PLUMBER (extração direta do PDF — maior precisão) ===")
            ctx.append(plumber)
            ctx.append("=== FIM DO PLUMBER ===")

        ocr = str(fatura.get("texto_ocr") or "").strip()
        if ocr and not ocr.startswith("[ERRO_"):
            ctx.append("\n=== TEXTO OCR (leitura visual) ===")
            ctx.append(ocr)
            ctx.append("=== FIM DO OCR ===")

        md = str(fatura.get("texto_markitdown") or "").strip()
        if md and not md.startswith("[ERRO_"):
            ctx.append("\n=== TEXTO MARKITDOWN (estrutura da fatura — gerado pelo markitdown) ===")
            ctx.append(md)
            ctx.append("=== FIM DO MARKITDOWN ===")

        # ── FASE 2: banco depois dos textos ────────────────────────────────────
        ctx.append("\n>>> FASE 2 — DADOS DO BANCO (comparar com o que extraiu acima) <<<\n")
        preenchidos = {k: v for k, v in _campos_banco_dict(fatura).items()
                       if v not in (None, 0, "", "None")}
        if preenchidos:
            ctx.append("=== BANCO — CAMPOS DESTA FATURA ===")
            ctx.append("⚠️ Apenas campos com valor registrado são listados abaixo.")
            ctx.append("⚠️ Campos AUSENTES desta lista = não extraídos pelo sistema, NÃO tratá-los como divergência.")
            for k, v in preenchidos.items():
                ctx.append(f"  {k}: {v}")
            ctx.append("=== FIM BANCO CAMPOS ===")
        else:
            ctx.append("=== BANCO — CAMPOS DESTA FATURA: nenhum campo preenchido — use somente os textos do PDF ===")

        ctx.append(
            "\n=== FORMATO DA RESPOSTA — OBRIGATÓRIO ===\n"
            "Responda nesta ordem:\n"
            "\n---FASE 1 — DIAGNÓSTICO PRELIMINAR (PDF)---\n"
            "Valores extraídos do PDF:\n"
            "  KWH_Ponta: | KWH_FPonta: | KWH_Total:\n"
            "  Leit_Ant_P: | Leit_Atu_P: | Constante_P:\n"
            "  Leit_Ant_FP: | Leit_Atu_FP: | Constante_FP:\n"
            "  Preço_kWh: | CIP: | ICMS%:\n"
            "Fichas suspeitas: [F01/F02/F03/F04/F05 com justificativa breve ou 'nenhuma']\n"
            "Diagnóstico provisório: [1 frase]\n"
            "\n---FASE 2 — CONFRONTO COM BANCO---\n"
            "  [✓ campo: PDF=X, Banco=X — convergência]\n"
            "  [✗ campo: PDF=X, Banco=Y — DIVERGÊNCIA — impacto: ...]\n"
            "Impacto no diagnóstico: [mantido | atualizado | nova ficha detectada]\n"
            "\n[Seguir com o formato padrão da SAÍDA a partir daqui]\n"
        )

    else:
        # ── Modo padrão: textos + campos numéricos do banco ────────────────────
        if not fichas_motor:
            ctx.append("MODO AUTÔNOMO: aplique F01 a F05 com base nos textos e imagens abaixo.")

        plumber = str(fatura.get("texto_plumber") or "").strip()
        if plumber and not plumber.startswith("[ERRO_"):
            ctx.append("\n=== TEXTO PLUMBER (campos extraídos diretamente do PDF — maior precisão) ===")
            ctx.append(plumber)
            ctx.append("=== FIM DO PLUMBER ===")

        ocr = str(fatura.get("texto_ocr") or "").strip()
        if ocr and not ocr.startswith("[ERRO_"):
            ctx.append("\n=== TEXTO OCR (leitura visual — útil para PDFs escaneados) ===")
            ctx.append(ocr)
            ctx.append("=== FIM DO OCR ===")

        md = str(fatura.get("texto_markitdown") or "").strip()
        if md and not md.startswith("[ERRO_"):
            ctx.append("\n=== TEXTO MARKITDOWN (estrutura e layout da fatura — gerado pelo markitdown) ===")
            ctx.append(md)
            ctx.append("=== FIM DO MARKITDOWN ===")

        preenchidos = {k: v for k, v in _campos_banco_dict(fatura).items()
                       if v not in (None, 0, "", "None")}
        if preenchidos:
            ctx.append("\n=== BANCO — CAMPOS NUMÉRICOS DESTA FATURA ===")
            ctx.append("⚠️ Valores registrados no sistema — compare com o PDF/textos acima.")
            for k, v in preenchidos.items():
                ctx.append(f"  {k}: {v}")
            ctx.append("=== FIM BANCO CAMPOS ===")

    # ── Histórico do banco (sempre, independente do modo) ──────────────────────
    mes_ref_str = str(ficha["Mes_Ref"])[:7]
    ctx.append(f"\n=== HISTÓRICO_BANCO — UC {ficha['UC']} ===")
    ctx.append(f"Mês da fatura analisada: {mes_ref_str}")
    if historico:
        ctx.append(f"Meses ANTERIORES disponíveis no banco: {len(historico)}")
        ctx.append("REGRA: use para calcular médias e desvios (F02/F03).")
        ctx.append("historico_anterior_json=\n" + fmt_hist(historico))
    else:
        ctx.append("⚠️ Nenhum mês anterior com consumo > 0 encontrado no banco para esta UC.")
        ctx.append("Use o histórico impresso na própria fatura como referência.")

    if posteriores:
        ctx.append(f"\nMeses POSTERIORES ao mês analisado (banco): {len(posteriores)}")
        if not historico:
            ctx.append("⚠️ Como não há histórico anterior, estes meses representam o padrão REAL da UC.")
            ctx.append("   Use-os como referência para F02/F03.")
        else:
            ctx.append("⚠️ NÃO incluir na média histórica — apenas como contexto de tendência.")
        ctx.append("meses_posteriores_json=\n" + fmt_post(posteriores))
    else:
        ctx.append("\n⚠️ Nenhum mês posterior disponível no banco.")

    # ── CONSULTA BANCO — anomalias anteriores desta UC ────────────────────────
    if anomalias_historicas:
        ctx.append("\n" + "=" * 70)
        ctx.append("VERIFICAÇÃO BANCO — ANOMALIAS ANTERIORES DESTA UC")
        ctx.append("=" * 70)
        ctx.append(
            "Os registros abaixo mostram anomalias detectadas pelo motor de regras\n"
            "e confirmadas/analisadas pela IA em meses anteriores para esta mesma UC.\n"
            "Use isso para:\n"
            "  • Verificar padrões recorrentes (mesma ficha repetida = evidência mais forte)\n"
            "  • Confrontar com o que você extraiu do PDF atual\n"
            "  • Confirmar ou refutar a anomalia com mais segurança\n"
        )
        for r in anomalias_historicas:
            linha = f"  {r['mes']}: fichas={r['fichas_aplicadas'] or '—'}"
            if r["ia_status"]:
                linha += f" | IA={r['ia_status']}"
            if r["ia_fichas"]:
                linha += f" | confirmadas={r['ia_fichas']}"
            if r["desvio_pct"]:
                linha += f" | desvio={r['desvio_pct']:.1f}%"
            if r["ressarc"] and r["ressarc"] > 0:
                linha += f" | ressarc=R${r['ressarc']:.2f}"
            ctx.append(linha)
        ctx.append(
            "\n⚠️ INSTRUÇÃO FINAL: Antes de concluir seu diagnóstico, verifique se os dados\n"
            "do banco acima são consistentes com o que você leu no PDF. Se houver\n"
            "divergência entre banco e PDF, cite-a explicitamente no diagnóstico."
        )
    else:
        ctx.append("\n=== VERIFICAÇÃO BANCO: nenhuma anomalia anterior registrada para esta UC ===")

    return "\n".join(ctx)

# ─── Chamada IA com visão ─────────────────────────────────────────────────────

def chamar_ia(system_prompt: str, contexto: str, imagens: list[dict]) -> str:
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type":  "application/json",
    }

    # Monta conteúdo da mensagem: texto + imagens
    content = [{"type": "text", "text": _sanitize(contexto)}]
    for img in imagens:
        content.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:{img['mime']};base64,{img['base64']}",
                "detail": "high",
            }
        })

    body = {
        "model": OPENAI_MODEL,
        "max_tokens": 4096,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": content},
        ],
    }

    r = requests.post(
        f"{OPENAI_BASE_URL}/v1/chat/completions",
        headers=headers,
        json=body,
        timeout=OPENAI_TIMEOUT,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]

# ─── Parser da resposta ────────────────────────────────────────────────────────

def parsear_resposta(texto: str) -> dict:
    _FICHA_PAT = r"F(?:0[1-9]|1[0-4])"

    # ── Status + fichas a partir de "Fichas Confirmadas: N (FXX)" ─────────────
    # Handles: "1 (F03)", "[F09]", "nenhuma", "0 []", "0 ()", "3 (F02)", "9", etc.
    ia_status = "PENDENTE"
    ia_fichas = ""

    line_m = re.search(r"Fichas\s+Confirmadas\s*:([^\n]{0,100})", texto, re.IGNORECASE)
    if line_m:
        line = line_m.group(1).strip()
        fichas_found = re.findall(_FICHA_PAT, line, re.IGNORECASE)
        ia_fichas = ",".join(sorted(set(c.upper() for c in fichas_found)))
        count_m = re.match(r"(\d+)", line)
        count = int(count_m.group(1)) if count_m else None
        is_nenhuma = bool(re.search(r"nenhuma|none", line, re.IGNORECASE))

        if ia_fichas:
            ia_status = "CONFIRMADO"
        elif count is not None and count > 0:
            ia_status = "CONFIRMADO"   # confia na contagem mesmo sem listar fichas
        elif is_nenhuma or count == 0 or not line:
            ia_status = "FALSO_POSITIVO"
        else:
            ia_status = "FALSO_POSITIVO"
    else:
        # Fallback: busca apenas na seção SAÍDA/DIAGNÓSTICO para não confundir
        # com "✗" dos marcadores de divergência da FASE 2
        saida_idx = max(texto.find("---DIAGNÓSTICO---"), texto.find("SAÍDA FINAL"), 0)
        saida = texto[saida_idx:] if saida_idx else texto
        if re.search(r"Anomalia\s+Confirmada|✓\s*Anomalia", saida, re.IGNORECASE):
            ia_status = "CONFIRMADO"
        elif re.search(r"Anomalia\s+Não\s+Confirmada|Não\s+Confirmada", saida, re.IGNORECASE):
            ia_status = "FALSO_POSITIVO"
        codes = re.findall(
            _FICHA_PAT + r"(?=\s*(?:confirmad|✓|constat|detectad))", texto, re.IGNORECASE
        )
        ia_fichas = ",".join(sorted(set(c.upper() for c in codes)))

    valor = None
    for pat in [
        r"Valor\s+Total\s+Ressarcimento\s*[:\-=]\s*R\$\s*([\d.,]+)",
        r"valor_ressarcimento_total\s*[=:]\s*R?\$?\s*([\d.,]+)",
        r"Total\s+estimado\s*[:\-=]\s*R\$\s*([\d.,]+)",
        r"valor_ressarcimento_estimado\s*[=:]\s*R?\$?\s*([\d.,]+)",
        r"Ressarcimento\s+estimado\s*[:\-=]\s*R\$\s*([\d.,]+)",
        r"Valor\s+a\s+ressarcir\s*[:\-=]\s*R\$\s*([\d.,]+)",
        r"Valor\s+do\s+ressarcimento\s*[:\-=]\s*R\$\s*([\d.,]+)",
        r"Estimativa\s+de\s+ressarcimento\s*[:\-=]\s*R\$\s*([\d.,]+)",
        r"Valor\s+Ressarcimento\s*[:\-=]\s*R\$\s*([\d.,]+)",
        r"ressarcimento\s*[:\-=]\s*R\$\s*([\d.,]+)",
    ]:
        m = re.search(pat, texto, re.IGNORECASE)
        if m:
            try:
                raw_val = m.group(1).replace(".", "").replace(",", ".")
                # Garante que é um número válido e positivo
                v = float(raw_val)
                if v > 0:
                    valor = v
            except ValueError:
                pass
            if valor:
                break

    # ── Anti-falso-positivo F02/F13 ───────────────────────────────────────────
    # Fichas de consumo estatístico (F02, F13) sem valor monetário extraído
    # são muito propensas a falso positivo — rebaixa para PENDENTE.
    FICHAS_SEM_VALOR = {"F02", "F13"}
    if ia_status == "CONFIRMADO" and (valor is None or valor == 0):
        fichas_set = {c.upper() for c in re.findall(r"F(?:0[1-9]|1[0-4])", ia_fichas)}
        if not fichas_set or fichas_set.issubset(FICHAS_SEM_VALOR):
            ia_status = "PENDENTE"

    return {
        "ia_status":                    ia_status,
        "ia_fichas_confirmadas":        ia_fichas,
        "resultado_ia":                 texto,
        "valor_ressarcimento_estimado": valor,
    }

# ─── Score de Confiança ───────────────────────────────────────────────────────

def _extrair_campos_json(resposta_ia: str) -> dict | None:
    """Parseia o bloco ---CAMPOS_JSON--- ... ---FIM_CAMPOS_JSON--- da resposta."""
    match = re.search(
        r"---CAMPOS_JSON---\s*(\{.*?\})\s*---FIM_CAMPOS_JSON---",
        resposta_ia,
        re.DOTALL,
    )
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError as e:
        log.warning(f"confianca: JSON inválido no bloco CAMPOS_JSON — {e}")
        return None


def _calcular_confianca(campos: dict, ficha: dict) -> list[dict]:
    """
    Aplica regras determinísticas sobre os campos extraídos pela IA.
    Retorna lista de flags para campos com baixa confiança.
    confianca: 0.0–0.3 = provável erro | 0.4–0.6 = suspeito | 0.7–0.8 = divergência leve
    """
    flags = []

    def flag(campo, valor, confianca, motivo):
        flags.append({
            "campo":          campo,
            "valor_extraido": str(valor) if valor is not None else "null",
            "confianca":      confianca,
            "motivo":         motivo,
        })

    # UC: formato numérico 6–12 dígitos
    uc = campos.get("uc")
    if not uc:
        flag("uc", uc, 0.0, "UC não extraída")
    elif not re.fullmatch(r"\d{6,12}", str(uc).strip()):
        flag("uc", uc, 0.2, f"UC fora do formato numérico esperado (6–12 dígitos): '{uc}'")

    # total_rs: confrontar com banco
    total_rs = campos.get("total_rs")
    rs_banco = ficha.get("RS_Total_Fatura")
    if total_rs is None:
        flag("total_rs", total_rs, 0.0, "total_rs não extraído")
    elif rs_banco is not None:
        try:
            diff = abs(float(total_rs) - float(rs_banco))
            if diff > 1.00:
                flag("total_rs", total_rs, 0.1,
                     f"Diverge do banco em R${diff:.2f} (extraído={total_rs}, banco={rs_banco})")
            elif diff > 0.10:
                flag("total_rs", total_rs, 0.6,
                     f"Pequena divergência com banco: R${diff:.2f}")
        except (TypeError, ValueError):
            pass

    # total_itens_rs: não pode ser 0 se total_rs > 0
    total_itens = campos.get("total_itens_rs")
    if total_rs is not None and total_itens is not None:
        try:
            if float(total_itens) == 0 and float(total_rs) > 0:
                flag("total_itens_rs", total_itens, 0.3,
                     "total_itens_rs = 0 mas total_rs > 0 — possível erro de extração")
        except (TypeError, ValueError):
            pass

    # ICMS: recalcular
    base_icms = campos.get("base_icms_rs")
    icms_aliq = campos.get("icms_aliq")
    icms_rs   = campos.get("icms_rs")
    if all(v is not None for v in (base_icms, icms_aliq, icms_rs)):
        try:
            icms_calc = round(float(base_icms) * float(icms_aliq) / 100, 2)
            diff = abs(icms_calc - float(icms_rs))
            if diff > 0.10:
                flag("icms_rs", icms_rs, 0.2,
                     f"ICMS recalculado={icms_calc} vs extraído={icms_rs} "
                     f"(diff=R${diff:.2f}, base={base_icms}, aliq={icms_aliq}%)")
        except (TypeError, ValueError):
            pass

    # PIS: recalcular
    base_pis = campos.get("base_pis_cofins_rs")
    pis_aliq = campos.get("pis_aliq")
    pis_rs   = campos.get("pis_rs")
    if all(v is not None for v in (base_pis, pis_aliq, pis_rs)):
        try:
            pis_calc = round(float(base_pis) * float(pis_aliq) / 100, 2)
            diff = abs(pis_calc - float(pis_rs))
            if diff > 0.10:
                flag("pis_rs", pis_rs, 0.2,
                     f"PIS recalculado={pis_calc} vs extraído={pis_rs} (diff=R${diff:.2f})")
        except (TypeError, ValueError):
            pass

    # COFINS: recalcular
    cofins_aliq = campos.get("cofins_aliq")
    cofins_rs   = campos.get("cofins_rs")
    if all(v is not None for v in (base_pis, cofins_aliq, cofins_rs)):
        try:
            cofins_calc = round(float(base_pis) * float(cofins_aliq) / 100, 2)
            diff = abs(cofins_calc - float(cofins_rs))
            if diff > 0.10:
                flag("cofins_rs", cofins_rs, 0.2,
                     f"COFINS recalculado={cofins_calc} vs extraído={cofins_rs} (diff=R${diff:.2f})")
        except (TypeError, ValueError):
            pass

    # Base PIS/COFINS: deve ser base_icms − icms_rs
    if all(v is not None for v in (base_icms, icms_rs, base_pis)):
        try:
            esperado = round(float(base_icms) - float(icms_rs), 2)
            diff = abs(esperado - float(base_pis))
            if diff > 1.00:
                flag("base_pis_cofins_rs", base_pis, 0.5,
                     f"base_pis_cofins esperado={esperado} (base_icms − icms_rs), "
                     f"extraído={base_pis} (diff=R${diff:.2f})")
        except (TypeError, ValueError):
            pass

    # Leituras iguais com kWh > 0
    kwh_t = campos.get("kwh_total")
    la_p  = campos.get("leitura_anterior_p")
    lc_p  = campos.get("leitura_atual_p")
    la_fp = campos.get("leitura_anterior_fp")
    lc_fp = campos.get("leitura_atual_fp")
    if la_p is not None and lc_p is not None:
        try:
            if float(la_p) == float(lc_p) and float(kwh_t or 0) > 0:
                flag("leitura_atual_p", lc_p, 0.3,
                     f"Leitura ponta igual (ant={la_p} = atu={lc_p}) mas kwh_total={kwh_t}")
        except (TypeError, ValueError):
            pass
    if la_fp is not None and lc_fp is not None:
        try:
            if float(la_fp) == float(lc_fp) and float(kwh_t or 0) > 0:
                flag("leitura_atual_fp", lc_fp, 0.3,
                     f"Leitura fora ponta igual (ant={la_fp} = atu={lc_fp}) mas kwh_total={kwh_t}")
        except (TypeError, ValueError):
            pass

    # Fatura MT sem perda de transformação
    tensao = str(ficha.get("Tp_Tensao") or "").upper()
    perda  = campos.get("perda_transformacao_pct")
    if tensao and not tensao.startswith("B") and perda is None:
        flag("perda_transformacao_pct", perda, 0.6,
             "Fatura MT/AT sem perda de transformação declarada — verificar layout")

    # Fatura BT sem CIP
    cip = campos.get("cip_rs")
    if tensao.startswith("B") and cip is None:
        flag("cip_rs", cip, 0.5,
             "CIP/COSIP não extraída em fatura BT — verificar se está na fatura")

    # Demanda faturada > contratada
    demanda_fat  = campos.get("demanda_kw")
    demanda_cont = campos.get("demanda_contratada_kw")
    if demanda_fat is not None and demanda_cont is not None:
        try:
            excesso_pct = (float(demanda_fat) - float(demanda_cont)) / float(demanda_cont) * 100
            if excesso_pct > 5:
                flag("demanda_kw", demanda_fat,
                     0.7,
                     f"Demanda faturada {demanda_fat} kW excede contratada "
                     f"{demanda_cont} kW em {excesso_pct:.1f}%")
        except (TypeError, ValueError, ZeroDivisionError):
            pass

    return flags


def _salvar_anotacoes(cur, conn, id_fatura: int, concessionaria: str,
                      flags: list[dict]) -> int:
    """Insere flags de baixa confiança em Anotacoes_Campo_IA."""
    sql = """
        INSERT INTO Anotacoes_Campo_IA
            (id_fatura, concessionaria, campo, valor_extraido, confianca, motivo)
        VALUES (%s, %s, %s, %s, %s, %s)
    """
    inseridos = 0
    for f in flags:
        if f["confianca"] >= 0.9:
            continue
        try:
            cur.execute(sql, (
                id_fatura,
                concessionaria or "",
                f["campo"],
                f["valor_extraido"],
                f["confianca"],
                f["motivo"],
            ))
            inseridos += 1
        except Exception as e:
            log.warning(f"confianca: erro ao salvar [{f['campo']}]: {e}")
    if inseridos:
        try:
            conn.commit()
        except Exception as e:
            log.warning(f"confianca: erro ao commitar: {e}")
    return inseridos


# ─── Persistência ────────────────────────────────────────────────────────────

def _flags_fichas(fichas_str: str) -> dict:
    """Deriva flags binárias a partir da string de fichas confirmadas."""
    s = (fichas_str or "").upper()
    return {
        "flag_f01": 1 if "F01" in s else 0,
        "flag_f02": 1 if "F02" in s else 0,
        "flag_f03": 1 if "F03" in s else 0,
        "flag_f04": 1 if "F04" in s else 0,
        "flag_f05": 1 if "F05" in s else 0,
    }


def _garantir_coluna_modelo_ia(conn):
    """Cria coluna modelo_ia em fichas_anomalias_cache se não existir."""
    cur = conn.cursor()
    try:
        cur.execute("ALTER TABLE fichas_anomalias_cache ADD COLUMN modelo_ia VARCHAR(30) NULL")
        conn.commit()
        log.info("Coluna modelo_ia criada em fichas_anomalias_cache.")
    except mysql.connector.errors.ProgrammingError as e:
        if "Duplicate column" not in str(e):
            raise
    finally:
        cur.close()


def _gravar_ficha(cur, conn, ficha: dict, dados: dict, modelo: str = ""):
    """Insere/atualiza fichas_anomalias_cache. Retorna (cur, conn) possivelmente reconectados."""
    fid          = ficha["id"]
    fichas_ia    = dados.get("ia_fichas_confirmadas") or ""
    flags        = _flags_fichas(fichas_ia)
    qtd          = sum(flags.values())
    valor        = dados.get("valor_ressarcimento_estimado")
    resultado_ia = (dados.get("resultado_ia") or "")[:65000]
    ia_status    = dados.get("ia_status") or "PENDENTE"

    sql = """
        INSERT INTO fichas_anomalias_cache
            (id, UC, Cod_Empresa, Concessionaria, Mes_Ref, Tp_Tensao, NroMedidor,
             RAZAO_SOCIAL, Link, RS_Total_Fatura,
             flag_f01, flag_f02, flag_f03, flag_f04, flag_f05,
             qtd_regras, fichas_aplicadas, ia_fichas_confirmadas,
             ia_status, resultado_ia, valor_ressarcimento_estimado,
             modelo_ia, resultado_salvo_em)
        VALUES
            (%s, %s, %s, %s, %s, %s, %s,
             %s, %s, %s,
             %s, %s, %s, %s, %s,
             %s, %s, %s,
             %s, %s, %s,
             %s, NOW())
        ON DUPLICATE KEY UPDATE
            ia_status                    = VALUES(ia_status),
            resultado_ia                 = VALUES(resultado_ia),
            ia_fichas_confirmadas        = VALUES(ia_fichas_confirmadas),
            fichas_aplicadas             = VALUES(fichas_aplicadas),
            flag_f01 = VALUES(flag_f01), flag_f02 = VALUES(flag_f02),
            flag_f03 = VALUES(flag_f03), flag_f04 = VALUES(flag_f04),
            flag_f05 = VALUES(flag_f05), qtd_regras = VALUES(qtd_regras),
            valor_ressarcimento_estimado = VALUES(valor_ressarcimento_estimado),
            modelo_ia                    = VALUES(modelo_ia),
            resultado_salvo_em           = NOW()
    """
    params = (
        fid,
        ficha.get("UC"), ficha.get("Cod_Empresa"), ficha.get("Concessionaria"),
        ficha.get("Mes_Ref"), ficha.get("Tp_Tensao"), ficha.get("NroMedidor"),
        ficha.get("RAZAO_SOCIAL"), ficha.get("Link"), ficha.get("RS_Total_Fatura"),
        flags["flag_f01"], flags["flag_f02"], flags["flag_f03"],
        flags["flag_f04"], flags["flag_f05"],
        qtd, fichas_ia, fichas_ia,
        ia_status, resultado_ia, valor,
        modelo or "",
    )
    for tentativa in range(3):
        try:
            cur.execute(sql, params)
            conn.commit()
            log.info(f"    → fichas_anomalias_cache: {ia_status} | fichas={fichas_ia or '—'} | valor={valor}")
            return cur, conn
        except mysql.connector.errors.OperationalError as e:
            if tentativa < 2:
                log.warning(f"    → Reconectando fichas_anomalias_cache (tentativa {tentativa+1}): {e}")
                try:
                    conn.reconnect(attempts=3, delay=2)
                    cur = conn.cursor(dictionary=True)
                except Exception:
                    pass
            else:
                log.warning(f"    → Erro ao gravar fichas_anomalias_cache: {e}")
        except Exception as e:
            log.warning(f"    → Erro ao gravar fichas_anomalias_cache: {e}")
            return cur, conn
    return cur, conn


def _atualizar_ficha(cur, conn, fid: int, dados: dict):
    """Modo padrão: atualiza ia_status/resultado na ficha já existente."""
    try:
        cur.execute("""
            UPDATE fichas_anomalias_cache
               SET ia_status                    = %s,
                   ia_fichas_confirmadas        = %s,
                   resultado_ia                 = %s,
                   valor_ressarcimento_estimado = %s,
                   resultado_salvo_em           = NOW()
             WHERE id = %s
        """, (
            dados.get("ia_status"),
            dados.get("ia_fichas_confirmadas") or "",
            (dados.get("resultado_ia") or "")[:65000],
            dados.get("valor_ressarcimento_estimado"),
            fid,
        ))
        conn.commit()
    except Exception as e:
        log.warning(f"    → Erro ao atualizar fichas_anomalias_cache: {e}")


def _salvar_cache_fatura(cur, conn, fid: int, dados: dict):
    """Grava analise_IA (JSON estruturado) e anomalia_encontrada em Faturas_Registradas_Cache.
    Retorna (cur, conn) — pode ser nova conexão se a original caiu.
    """
    anomalia = 1 if dados.get("ia_status") == "CONFIRMADO" else 0

    analise_json = {
        "modelo": "gpt-4.1-mini",
        "observacao": "Analisado com OpenAI 4.1-mini",
        "resultado": {
            "ia_status": dados.get("ia_status", "PENDENTE"),
            "ia_fichas_confirmadas": [f for f in dados.get("ia_fichas_confirmadas", "").split(",") if f],
            "valor_ressarcimento_estimado": dados.get("valor_ressarcimento_estimado", 0),
        }
    }

    json_safe = json.dumps(analise_json, ensure_ascii=False)[:65000]

    sql = """
        UPDATE Faturas_Registradas_Cache
           SET analise_IA          = %s,
               anomalia_encontrada = %s,
               ia_analisado_em     = NOW()
         WHERE id = %s
    """
    for tentativa in range(2):
        try:
            cur.execute(sql, (json_safe, anomalia, fid))
            conn.commit()
            return cur, conn
        except Exception as e:
            if tentativa == 0:
                log.warning(f"    → Conexão perdida ao salvar fatura {fid}, reconectando... ({e})")
                try:
                    cur, conn = _reconectar()
                except Exception as re_err:
                    log.warning(f"    → Falha ao reconectar: {re_err}")
                    return cur, conn
            else:
                log.warning(f"    → Erro ao salvar analise_IA em Faturas_Registradas_Cache: {e}")
    return cur, conn


# ─── Auto-confirmação com gpt-5.4 + imagens ──────────────────────────────────

MODELO_CONFIRMACAO = "gpt-5.4"

def _confirmar_confirmados(fichas: list[dict], prompt: str, cur, conn):
    """
    Re-analisa com gpt-4.1 + imagens PDF os casos CONFIRMADO pelo mini.
    Substitui resultado em fichas_anomalias_cache com modelo_ia='gpt-4.1'.
    """
    log.info(f"\n{'═'*60}")
    log.info(f"AUTO-CONFIRMAÇÃO: {len(fichas)} caso(s) re-analisando com {MODELO_CONFIRMACAO} + imagem")
    log.info('═' * 60)

    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type":  "application/json",
    }
    ok = erro = 0
    cnt: dict[str, int] = {"CONFIRMADO": 0, "FALSO_POSITIVO": 0, "INCONCLUSIVO": 0}

    for i, ficha in enumerate(fichas, 1):
        fid  = ficha["id"]
        uc   = ficha["UC"]
        mes  = str(ficha["Mes_Ref"])[:7]
        link = str(ficha.get("Link") or "").strip()

        log.info(f"  [{i}/{len(fichas)}] id={fid} UC={uc} Mes={mes}")

        if not link:
            log.warning(f"    Sem Link — mantendo resultado do mini")
            continue

        pdf_bytes = baixar_pdf(link)
        imagens   = pdf_bytes_para_imagens(pdf_bytes) if pdf_bytes else []
        log.info(f"    {len(imagens)} imagem(ns)")

        historico, posteriores = buscar_historico(cur, uc, mes)
        anomalias_hist = buscar_anomalias_historicas(cur, uc, mes)
        contexto = montar_contexto(ficha, ficha, historico, posteriores, direto=True,
                                   anomalias_historicas=anomalias_hist)

        # Monta content com texto + imagens (sempre em array format para gpt-5.4)
        user_content = [{"type": "text", "text": _sanitize(contexto)}]
        for img in imagens:
            user_content.append({
                "type": "image_url",
                "image_url": {"url": f"data:{img['mime']};base64,{img['base64']}", "detail": "high"},
            })

        body = {
            "model":      MODELO_CONFIRMACAO,
            "max_tokens": 4096,
            "messages": [
                {"role": "system", "content": _sanitize(prompt)},
                {"role": "user",   "content": user_content},
            ],
        }

        try:
            # Debug: log request structure (without full base64)
            content_types = [c.get("type") for c in user_content]
            request_debug = {
                "model": body["model"],
                "max_tokens": body["max_tokens"],
                "system_len": len(body["messages"][0]["content"]),
                "user_parts": len(user_content),
                "content_types": content_types,
            }
            log.info(f"    Request prep: {request_debug}")

            r = requests.post(
                f"{OPENAI_BASE_URL}/v1/chat/completions",
                headers=headers, json=body, timeout=OPENAI_TIMEOUT,
            )
            r.raise_for_status()
            resposta = r.json()["choices"][0]["message"]["content"]
        except requests.exceptions.HTTPError as e:
            # Detailed error logging for HTTP errors
            log.error(f"    Erro {MODELO_CONFIRMACAO}: {e.response.status_code} {e.response.reason}")
            try:
                error_detail = r.json()
                log.error(f"    API Error: {error_detail.get('error', {}).get('message', 'sem mensagem')}")
            except:
                log.error(f"    Response: {r.text[:500]}")
            erro += 1
            time.sleep(PAUSA_ENTRE)
            continue
        except Exception as e:
            log.error(f"    Erro {MODELO_CONFIRMACAO}: {type(e).__name__}: {e} — mantendo resultado do mini")
            erro += 1
            time.sleep(PAUSA_ENTRE)
            continue

        dados = parsear_resposta(resposta)
        log.info(f"    {MODELO_CONFIRMACAO}: {dados['ia_status']} | fichas={dados['ia_fichas_confirmadas'] or '—'} | valor={dados.get('valor_ressarcimento_estimado')}")

        cur, conn = _salvar_cache_fatura(cur, conn, fid, dados)

        status = dados["ia_status"]
        cnt[status if status in cnt else "INCONCLUSIVO"] += 1

        if status in ("CONFIRMADO", "INCONCLUSIVO"):
            cur, conn = _gravar_ficha(cur, conn, ficha, dados, modelo=MODELO_CONFIRMACAO)
        else:
            # FALSO_POSITIVO: apaga o registro que a mini tinha gravado
            try:
                cur.execute(
                    "UPDATE fichas_anomalias_cache SET deletado=1, modelo_ia=%s, resultado_ia=%s, resultado_salvo_em=NOW() WHERE id=%s AND deletado=0",
                    (MODELO_CONFIRMACAO, _sanitize(resposta)[:65000], fid),
                )
                conn.commit()
                log.info(f"    {MODELO_CONFIRMACAO}: {status} — registro da mini removido (deletado=1)")
            except Exception as e:
                log.warning(f"    Erro ao marcar deletado id={fid}: {e}")

        ok += 1
        time.sleep(PAUSA_ENTRE)

    log.info(f"Auto-confirmação: {ok} ok | {erro} erros")
    return cur, conn, cnt


# ─── Modo Batch (OpenAI Batch API) ────────────────────────────────────────────

def analisar_em_batch(fichas: list, prompt: str, cur, conn,
                      direto: bool, modelo: str):
    """
    Submete todas as faturas para a OpenAI Batch API (texto-only, sem imagens).
    50% mais barato que chamadas individuais. Aguarda conclusão e salva resultados.
    """
    log.info(f"Preparando batch com {len(fichas)} faturas | modelo={modelo}")
    headers = {"Authorization": f"Bearer {OPENAI_API_KEY}"}

    # ── 1. Monta JSONL ─────────────────────────────────────────────────────────
    requests_jsonl = []
    ficha_map: dict = {}   # custom_id → ficha

    for ficha in fichas:
        fid  = ficha["id"]
        uc   = ficha["UC"]
        mes  = str(ficha["Mes_Ref"])[:7]
        historico, posteriores = buscar_historico(cur, uc, mes)
        anomalias_hist = buscar_anomalias_historicas(cur, uc, mes)
        contexto = montar_contexto(ficha, ficha, historico, posteriores, direto=direto,
                                   anomalias_historicas=anomalias_hist)

        custom_id = f"fatura-{fid}"
        ficha["_historico"] = historico   # guardado para o check motor_regras no pós-processamento
        ficha_map[custom_id] = ficha

        req = {
            "custom_id": custom_id,
            "method":    "POST",
            "url":       "/v1/chat/completions",
            "body": {
                "model":                  modelo,
                "max_completion_tokens":  4096,
                "messages": [
                    {"role": "system", "content": _sanitize(prompt)},
                    {"role": "user",   "content": _sanitize(contexto)},
                ],
            },
        }
        requests_jsonl.append(json.dumps(req, ensure_ascii=True))

    total_bytes = sum(len(l.encode("utf-8")) + 1 for l in requests_jsonl)
    log.info(f"JSONL total: {total_bytes // 1024} KB | {len(requests_jsonl)} requisicoes")

    # ── 2. Divide em chunks de <= 190 MB ────────────────────────────────────────
    MAX_BATCH_BYTES = 190 * 1024 * 1024
    chunks: list[list[str]] = []
    current: list[str] = []
    current_size = 0
    for line in requests_jsonl:
        line_size = len(line.encode("utf-8")) + 1
        if current and current_size + line_size > MAX_BATCH_BYTES:
            chunks.append(current)
            current = []
            current_size = 0
        current.append(line)
        current_size += line_size
    if current:
        chunks.append(current)
    log.info(f"Dividido em {len(chunks)} batch(es) de ate 190 MB")

    # ── 3. Submete cada chunk, aguarda e coleta resultados ───────────────────────
    all_result_lines: list[str] = []

    for chunk_idx, chunk_lines in enumerate(chunks, 1):
        chunk_bytes = "\n".join(chunk_lines).encode("utf-8", errors="ignore")
        log.info(f"[Batch {chunk_idx}/{len(chunks)}] {len(chunk_lines)} reqs | {len(chunk_bytes)//1024} KB")

        # Upload
        upload_resp = requests.post(
            f"{OPENAI_BASE_URL}/v1/files",
            headers=headers,
            files={
                "file":    (f"batch_{chunk_idx}.jsonl", chunk_bytes, "application/jsonl"),
                "purpose": (None, "batch"),
            },
            timeout=180,
        )
        upload_resp.raise_for_status()
        file_id = upload_resp.json()["id"]
        log.info(f"  Arquivo enviado: {file_id}")

        # Cria batch
        batch_resp = requests.post(
            f"{OPENAI_BASE_URL}/v1/batches",
            headers={**headers, "Content-Type": "application/json"},
            json={
                "input_file_id":     file_id,
                "endpoint":          "/v1/chat/completions",
                "completion_window": "24h",
            },
            timeout=60,
        )
        batch_resp.raise_for_status()
        batch_id = batch_resp.json()["id"]
        log.info(f"  Batch criado: {batch_id}")

        # Persiste estado para retomada em caso de crash
        state_file = Path(f"batch_state_{batch_id}.json")
        state_file.write_text(json.dumps({
            "batch_id":   batch_id,
            "chunk":      chunk_idx,
            "total_reqs": len(chunk_lines),
            "modelo":     modelo,
            "direto":     direto,
            "ids":        [ficha_map[f"fatura-{json.loads(l)['custom_id'].split('-')[1]}"]["id"]
                           for l in chunk_lines if "fatura-" in l],
        }, indent=2), encoding="utf-8")
        log.info(f"  Estado salvo: {state_file}")

        # Poll
        output_file_id = None
        while True:
            status_resp = requests.get(
                f"{OPENAI_BASE_URL}/v1/batches/{batch_id}",
                headers=headers, timeout=30,
            )
            status_resp.raise_for_status()
            bdata  = status_resp.json()
            status = bdata["status"]
            counts = bdata.get("request_counts", {})
            log.info(f"  [{chunk_idx}/{len(chunks)}] status={status} | "
                     f"{counts.get('completed',0)}/{counts.get('total', len(chunk_lines))}")

            if status == "completed":
                output_file_id = bdata.get("output_file_id")
                error_file_id  = bdata.get("error_file_id")
                if not output_file_id and error_file_id:
                    log.error(f"  Batch {chunk_idx} completou com 0 sucessos. Baixando error_file...")
                    try:
                        err_resp = requests.get(
                            f"{OPENAI_BASE_URL}/v1/files/{error_file_id}/content",
                            headers=headers, timeout=60,
                        )
                        for i, eline in enumerate(err_resp.text.strip().split("\n")[:5]):
                            if eline.strip():
                                try:
                                    obj = json.loads(eline)
                                    log.error(f"    Erro #{i+1}: {json.dumps(obj.get('error') or obj, ensure_ascii=False)[:300]}")
                                except Exception:
                                    log.error(f"    Linha #{i+1}: {eline[:300]}")
                    except Exception as de:
                        log.error(f"    Falha ao baixar error_file: {de}")
                    raise RuntimeError(f"Batch {chunk_idx} concluido mas 0 requisicoes com sucesso")
                break

            elif status in ("failed", "expired", "cancelled"):
                log.error(f"  Batch {chunk_idx} encerrado ({status}). JSON: {json.dumps(bdata, ensure_ascii=False)[:1500]}")
                error_file_id = bdata.get("error_file_id")
                if error_file_id:
                    try:
                        err_resp = requests.get(
                            f"{OPENAI_BASE_URL}/v1/files/{error_file_id}/content",
                            headers=headers, timeout=60,
                        )
                        for i, eline in enumerate(err_resp.text.strip().split("\n")[:10]):
                            if eline.strip():
                                try:
                                    obj = json.loads(eline)
                                    log.error(f"    Erro #{i+1}: {json.dumps(obj.get('error') or obj, ensure_ascii=False)[:500]}")
                                except Exception:
                                    log.error(f"    Linha #{i+1}: {eline[:500]}")
                    except Exception as de:
                        log.error(f"    Falha ao baixar error_file: {de}")
                raise RuntimeError(f"Batch {chunk_idx} encerrado com status: {status}")

            time.sleep(30)

        if not output_file_id:
            raise RuntimeError(f"Batch {chunk_idx} concluido mas sem output_file_id")

        # Download resultados do chunk
        log.info(f"  Baixando resultados: {output_file_id}")
        out_resp = requests.get(
            f"{OPENAI_BASE_URL}/v1/files/{output_file_id}/content",
            headers=headers, timeout=180,
        )
        out_resp.raise_for_status()
        chunk_lines_result = [l for l in out_resp.text.strip().split("\n") if l.strip()]
        all_result_lines.extend(chunk_lines_result)
        log.info(f"  Batch {chunk_idx} concluido: {len(chunk_lines_result)} resultados.")

    # ── 4. Processa e salva todos os resultados ─────────────────────────────────
    ok = erro = 0
    cnt_mini: dict[str, int] = {"CONFIRMADO": 0, "FALSO_POSITIVO": 0, "OUTROS": 0}
    fichas_confirmadas_lista: list[dict] = []
    for line in all_result_lines:
        if not line.strip():
            continue
        try:
            result = json.loads(line)
        except json.JSONDecodeError:
            continue

        custom_id = result.get("custom_id", "")
        ficha     = ficha_map.get(custom_id)
        if not ficha:
            continue

        fid = ficha["id"]
        uc  = ficha["UC"]
        mes = str(ficha["Mes_Ref"])[:7]

        if result.get("error"):
            log.warning(f"  {custom_id}: erro API — {result['error']}")
            erro += 1
            continue

        try:
            content = result["response"]["body"]["choices"][0]["message"]["content"]
            content = _sanitize(content)
        except (KeyError, IndexError) as e:
            log.warning(f"  {custom_id}: resposta malformada — {e}")
            erro += 1
            continue

        dados = parsear_resposta(content)

        # Score de confiança
        campos_json = _extrair_campos_json(content)
        if campos_json:
            flags = _calcular_confianca(campos_json, ficha)
            if flags:
                _salvar_anotacoes(cur, conn, fid, ficha.get("Concessionaria"), flags)

        mr = {"passou": True, "checks": []}  # motor_regras desativado — IA é fonte de verdade

        log.info(f"  {custom_id} | UC={uc} | {dados['ia_status']} | fichas={dados['ia_fichas_confirmadas'] or '—'}")

        print(f"\n{'═'*60}")
        print(f"ID: {fid} | UC: {uc} | Mês: {mes}")
        print(f"IA Status: {dados['ia_status']} | Fichas: {dados['ia_fichas_confirmadas'] or '—'}")
        if mr["checks"]:
            print(f"[motor_regras] {'✅ OK' if mr['passou'] else '⚠️  DIVERGÊNCIA'}: " +
                  " | ".join(f"{c['ficha']}={c['status']}" for c in mr["checks"]))
        print(content[:800] + ("..." if len(content) > 800 else ""))
        print("═" * 60)

        cur, conn = _salvar_cache_fatura(cur, conn, fid, dados)

        # Mini não grava em fichas_anomalias_cache — só coleta CONFIRMADO para fase 2
        if dados["ia_status"] == "CONFIRMADO":
            cnt_mini["CONFIRMADO"] += 1
            fichas_confirmadas_lista.append(ficha)
        elif dados["ia_status"] == "FALSO_POSITIVO":
            cnt_mini["FALSO_POSITIVO"] += 1
        else:
            cnt_mini["OUTROS"] += 1

        ok += 1

    log.info(f"Batch processado: {ok} ok | {erro} erros | {len(all_result_lines)} linhas | {len(fichas)} faturas")

    # ── 5. Auto-confirmação com gpt-5.4 + imagens ──────────────────────────────
    cnt_conf = {"CONFIRMADO": 0, "FALSO_POSITIVO": 0, "INCONCLUSIVO": 0}
    if fichas_confirmadas_lista:
        cur, conn, cnt_conf = _confirmar_confirmados(fichas_confirmadas_lista, prompt, cur, conn)

    # ── 6. Resumo final ────────────────────────────────────────────────────────
    sep = "═" * 54
    print(f"\n{sep}")
    print("RESUMO FINAL")
    print(sep)
    print(f"Faturas processadas pelo mini ({OPENAI_MODEL_MINI}): {ok}")
    print(f"  ├─ CONFIRMADO (fase 1)              : {cnt_mini['CONFIRMADO']}")
    print(f"  ├─ FALSO_POSITIVO                   : {cnt_mini['FALSO_POSITIVO']}")
    print(f"  └─ PENDENTE/INCONCLUSIVO             : {cnt_mini['OUTROS']}")
    if fichas_confirmadas_lista:
        print(f"\nConfirmados re-analisados ({MODELO_CONFIRMACAO}): {len(fichas_confirmadas_lista)}")
        print(f"  ├─ CONFIRMADO (final → fichas_cache): {cnt_conf['CONFIRMADO']}")
        print(f"  ├─ FALSO_POSITIVO                   : {cnt_conf['FALSO_POSITIVO']}")
        print(f"  └─ INCONCLUSIVO                     : {cnt_conf['INCONCLUSIVO']}")
    if erro:
        print(f"\nErros de API                        : {erro}")
    print(sep)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main(cod_empresas: list[int], force: bool, limite: int | None,
         direto: bool = False, batch: bool = False, modelo: str | None = None):
    modelo = modelo or (OPENAI_MODEL_MINI if batch else OPENAI_MODEL)
    log.info("=" * 60)
    empresas_str = ", ".join(str(e) for e in cod_empresas)
    log.info(f"analisar_batch.py — empresa(s)={empresas_str} force={force} direto={direto} batch={batch} modelo={modelo} limite={limite or 'sem limite'}")

    if not HAS_PDFIUM:
        log.warning("pypdfium2 não instalado — análise sem imagem. Execute: pip install pypdfium2")

    prompt = carregar_prompt()
    conn   = mysql.connector.connect(**DB_APP)
    cur    = conn.cursor(dictionary=True)
    _garantir_coluna_modelo_ia(conn)

    limit_sql = f"LIMIT {limite}" if limite else ""

    if len(cod_empresas) == 1:
        filtro_empresa = "= %s"
        param_empresa  = (cod_empresas[0],)
    else:
        placeholders   = ", ".join(["%s"] * len(cod_empresas))
        filtro_empresa = f"IN ({placeholders})"
        param_empresa  = tuple(cod_empresas)

    if direto:
        # Modo direto: elegível se ao menos 2 dos 3 extratores têm texto gravado.
        # LEFT JOIN em fichas_anomalias_cache para incluir detalhamento do motor quando disponível.
        filtro_ia = "" if force else "AND (fac.ia_status IS NULL OR fac.ia_status = 'PENDENTE')"
        cur.execute(f"""
            SELECT frc.id, frc.UC, frc.Cod_Empresa, frc.Concessionaria, frc.Mes_Ref,
                   frc.Tp_Tensao, frc.NroMedidor, frc.RAZAO_SOCIAL, frc.RS_Total_Fatura,
                   COALESCE(fac.fichas_aplicadas, '') AS fichas_aplicadas,
                   COALESCE(fac.detalhamento,    '') AS detalhamento,
                   COALESCE(fac.ia_status, 'PENDENTE') AS ia_status,
                   frc.Link, frc.texto_plumber, frc.texto_markitdown, frc.texto_ocr,
                   frc.KWH_Ponta, frc.KWH_FPonta, frc.KWH_Reservado, frc.KWH_Total,
                   frc.Leitura_Anterior_KWH_P, frc.Leitura_Atual_KWH_P,
                   frc.Leitura_Anterior_KWH_FP, frc.Leitura_Atual_KWH_FP,
                   frc.Constante_KWH_P, frc.Constante_KWH_FP,
                   frc.Base_de_Calculo_ICMS, frc.Aliquota_ICMS, frc.ICMS_RS,
                   frc.CIP, frc.Dt_Venc_NF
            FROM Faturas_Registradas_Cache frc
            LEFT JOIN fichas_anomalias_cache fac ON fac.id = frc.id AND fac.deletado = 0
            WHERE frc.Cod_Empresa {filtro_empresa}
              AND (
                (CASE WHEN frc.texto_plumber    IS NOT NULL AND frc.texto_plumber    != '' THEN 1 ELSE 0 END +
                 CASE WHEN frc.texto_markitdown IS NOT NULL AND frc.texto_markitdown != '' THEN 1 ELSE 0 END +
                 CASE WHEN frc.texto_ocr        IS NOT NULL AND frc.texto_ocr        != '' THEN 1 ELSE 0 END)
              ) >= 2
              {filtro_ia}
            ORDER BY frc.Mes_Ref DESC
            {limit_sql}
        """, param_empresa)
    else:
        # Modo padrão: lê de fichas_anomalias_cache (gerada pelo motor_regras)
        filtro_ia = "" if force else "AND f.ia_status = 'PENDENTE'"
        cur.execute(f"""
            SELECT f.id, f.UC, f.Cod_Empresa, f.Concessionaria, f.Mes_Ref,
                   f.Tp_Tensao, f.NroMedidor, f.RAZAO_SOCIAL, f.RS_Total_Fatura,
                   f.fichas_aplicadas, f.detalhamento, f.ia_status,
                   frc.Link, frc.texto_plumber, frc.texto_markitdown, frc.texto_ocr,
                   frc.KWH_Ponta, frc.KWH_FPonta, frc.KWH_Reservado, frc.KWH_Total,
                   frc.Leitura_Anterior_KWH_P, frc.Leitura_Atual_KWH_P,
                   frc.Leitura_Anterior_KWH_FP, frc.Leitura_Atual_KWH_FP,
                   frc.Constante_KWH_P, frc.Constante_KWH_FP,
                   frc.Base_de_Calculo_ICMS, frc.Aliquota_ICMS, frc.ICMS_RS,
                   frc.CIP, frc.Dt_Venc_NF
            FROM fichas_anomalias_cache f
            LEFT JOIN Faturas_Registradas_Cache frc ON frc.id = f.id
            WHERE f.Cod_Empresa {filtro_empresa}
              {filtro_ia}
            ORDER BY f.Mes_Ref DESC
            {limit_sql}
        """, param_empresa)

    fichas = cur.fetchall()
    log.info(f"Faturas para análise: {len(fichas)}")

    if not fichas:
        log.info("Nada a processar.")
        cur.close(); conn.close()
        return

    # ── Modo Batch: submete tudo de uma vez via Batch API ──────────────────────
    if batch:
        try:
            analisar_em_batch(fichas, prompt, cur, conn, direto=direto, modelo=modelo)
        except Exception as e:
            log.error(f"Erro no batch: {e}")
        cur.close(); conn.close()
        return

    ok = erro = sem_link = 0

    for i, ficha in enumerate(fichas, 1):
        fid  = ficha["id"]
        uc   = ficha["UC"]
        mes  = str(ficha["Mes_Ref"])[:7]
        link = str(ficha.get("Link") or "").strip()
        log.info(f"[{i}/{len(fichas)}] id={fid} UC={uc} Mes={mes} fichas={ficha.get('fichas_aplicadas') or '(autônomo)'}")

        if not link:
            log.warning("    Sem Link — pulando")
            sem_link += 1
            continue

        # 1. Baixa PDF
        log.info(f"    Baixando PDF...")
        pdf_bytes = baixar_pdf(link)

        # 2. Converte em imagens
        imagens = pdf_bytes_para_imagens(pdf_bytes) if pdf_bytes else []
        if not imagens:
            log.warning("    Sem imagens — analisando só com texto")

        # 3. Histórico do banco + anomalias anteriores (consulta banco antes de fechar o diagnóstico)
        historico, posteriores = buscar_historico(cur, uc, mes)
        anomalias_hist = buscar_anomalias_historicas(cur, uc, mes)
        log.info(f"    Histórico: {len(historico)} meses | Posteriores: {len(posteriores)} meses | Anomalias anteriores: {len(anomalias_hist)}")

        # 4. Monta contexto texto (inclui seção de verificação do banco)
        contexto = montar_contexto(ficha, ficha, historico, posteriores, direto=direto,
                                   anomalias_historicas=anomalias_hist)

        # 5. Chama IA
        try:
            log.info(f"    Enviando para IA ({len(imagens)} imagem(ns))...")
            resposta = chamar_ia(prompt, contexto, imagens)
        except Exception as e:
            log.error(f"    Erro na chamada IA: {e}")
            erro += 1
            time.sleep(PAUSA_ENTRE)
            continue

        # 6. Parseia resultado + conferência motor de regras + score de confiança
        dados = parsear_resposta(resposta)

        campos_json = _extrair_campos_json(resposta)
        if campos_json:
            flags = _calcular_confianca(campos_json, ficha)
            if flags:
                n = _salvar_anotacoes(cur, conn, fid, ficha.get("Concessionaria"), flags)
                log.info(f"    confianca: {n} flag(s) salvo(s) em Anotacoes_Campo_IA")
                for f in flags:
                    log.info(f"      [{f['confianca']:.1f}] {f['campo']}: {f['motivo']}")
        else:
            log.debug(f"    confianca: bloco CAMPOS_JSON ausente na resposta id={fid}")

        mr = {"passou": True, "checks": []}  # motor_regras desativado — IA é fonte de verdade

        print("\n" + "═" * 60)
        print(f"ID: {fid} | UC: {uc} | Mês: {mes}")
        print(f"Fichas detectadas : {ficha.get('fichas_aplicadas') or '(detecção autônoma pela IA)'}")
        print(f"IA Status         : {dados['ia_status']}")
        print(f"Fichas confirmadas: {dados['ia_fichas_confirmadas'] or '—'}")
        if dados["valor_ressarcimento_estimado"]:
            print(f"Valor ressarc.    : R$ {dados['valor_ressarcimento_estimado']:.2f}")
        else:
            print(f"Valor ressarc.    : —")
        # Exibe resumo do check do motor de regras
        if mr["checks"]:
            print(f"\n[motor_regras check] {'✅ OK' if mr['passou'] else '⚠️  DIVERGÊNCIA'}")
            for c in mr["checks"]:
                ico = {"PASS": "✓", "WARN": "~", "FAIL": "✗"}.get(c["status"], "?")
                print(f"  {ico} {c['ficha']} [{c['status']}]: {c['motivo']}")
        print("\n--- RESPOSTA COMPLETA ---")
        print(resposta)
        print("═" * 60)

        # 7. Grava analise_IA em Faturas_Registradas_Cache (sempre)
        cur, conn = _salvar_cache_fatura(cur, conn, fid, dados)

        # 8. Grava em fichas_anomalias_cache se CONFIRMADO ou INCONCLUSIVO
        if dados["ia_status"] in ("CONFIRMADO", "INCONCLUSIVO"):
            if direto:
                cur, conn = _gravar_ficha(cur, conn, ficha, dados, modelo=OPENAI_MODEL)
            else:
                _atualizar_ficha(cur, conn, fid, dados)

        ok += 1
        time.sleep(PAUSA_ENTRE)

    log.info(f"\nConcluído: {ok} ok | {erro} erros | {sem_link} sem link | {len(fichas)} total")
    log.info("=" * 60)
    cur.close()
    conn.close()


def _buscar_todas_empresas() -> list[int]:
    conn = mysql.connector.connect(**DB_APP)
    cur  = conn.cursor()
    cur.execute("""
        SELECT DISTINCT Cod_Empresa FROM Faturas_Registradas_Cache
        WHERE (
            (CASE WHEN texto_plumber    IS NOT NULL AND texto_plumber    != '' THEN 1 ELSE 0 END +
             CASE WHEN texto_markitdown IS NOT NULL AND texto_markitdown != '' THEN 1 ELSE 0 END +
             CASE WHEN texto_ocr        IS NOT NULL AND texto_ocr        != '' THEN 1 ELSE 0 END)
        ) >= 2
        ORDER BY Cod_Empresa
    """)
    empresas = [r[0] for r in cur.fetchall()]
    cur.close(); conn.close()
    return empresas


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Análise IA em lote com visão da fatura")
    grp = parser.add_mutually_exclusive_group(required=True)
    grp.add_argument("--empresa", type=int, nargs="+",
                     help="Cod_Empresa(s) a processar (ex: 14  ou  4 14 32)")
    grp.add_argument("--all-empresas", action="store_true",
                     help="Processa todas as empresas com faturas aptas (≥2 extratores)")
    parser.add_argument("--force",   action="store_true")
    parser.add_argument("--limite",  type=int, default=None)
    parser.add_argument("--direto",  action="store_true",
                        help="Lê de Faturas_Registradas_Cache (texto_plumber preenchido) "
                             "sem depender do motor_regras. IA detecta F01-F14 autonomamente.")
    parser.add_argument("--batch",   action="store_true",
                        help="Usa OpenAI Batch API (50%% mais barato, sem imagens). "
                             "Submete tudo de uma vez e aguarda o resultado.")
    parser.add_argument("--modelo",  type=str, default=None,
                        help=f"Modelo OpenAI a usar. Padrão: {OPENAI_MODEL} (normal) "
                             f"ou {OPENAI_MODEL_MINI} (batch). Ex: --modelo gpt-4.5-mini")
    args = parser.parse_args()

    if args.all_empresas:
        empresas = _buscar_todas_empresas()
        log.info(f"--all-empresas: {len(empresas)} empresas encontradas → {empresas}")
    else:
        empresas = args.empresa

    main(cod_empresas=empresas, force=args.force, limite=args.limite,
         direto=args.direto, batch=args.batch, modelo=args.modelo)
