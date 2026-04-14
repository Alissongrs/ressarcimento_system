"""
analisar_batch.py
-----------------
Análise IA (F01-F05) em lote com visão real da fatura.
Para cada fatura:
  1. Baixa o PDF do Link
  2. Converte páginas em imagens (visão da fatura como analista)
  3. Monta contexto: histórico banco + OCR + markitdown (quando disponível)
  4. Envia tudo para OpenAI (texto + imagens)
  5. Exibe resultado na tela

Uso:
    python analisar_batch.py --empresa 14 --limite 5
    python analisar_batch.py --empresa 14
    python analisar_batch.py --empresa 14 --force
    python analisar_batch.py --empresa 14 --direto --limite 20
        (modo direto: lê de Faturas_Registradas_Cache sem depender do motor_regras
         — a IA detecta e confirma as anomalias F01-F05 autonomamente pelos textos)
"""

import argparse
import base64
import io
import json
import logging
import re
import sys
import tempfile
import time
from pathlib import Path

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
OPENAI_MODEL_MINI = "gpt-5.4-mini" # modelo para batch ($0.375/M input, $2.25/M output)
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
    # Remove explicitamente surrogates U+D800–U+DFFF via re antes de encode
    import re as _re
    text = _re.sub(r'[\ud800-\udfff]', '', text)
    return text.encode("utf-8", errors="ignore").decode("utf-8")

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
            ctx.append("⚠️ Valores registrados no sistema — podem divergir do PDF.")
            for k, v in preenchidos.items():
                ctx.append(f"  {k}: {v}")
            ctx.append("=== FIM BANCO CAMPOS ===")
        else:
            ctx.append("=== BANCO — CAMPOS DESTA FATURA: nenhum campo preenchido ===")

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
        # ── Modo padrão: textos após dados ─────────────────────────────────────
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

# ─── Conferência Motor de Regras ─────────────────────────────────────────────

# Limiares idênticos ao motor_regras_f01_f05.sql — atualizar aqui se o SQL mudar
_MR = dict(
    desvio_pico    = 2.0,    # 200% → PICO_OUTLIER
    desvio_alto    = 1.0,    # 100% → DESVIO_ALTO  (mínimo para F02 alto)
    desvio_baixo   = -1.0,   # -100% → MUITO_BAIXO (mínimo para F02 baixo)
    media_minima   = 50,     # kWh — excluído do histórico se abaixo disso
    min_historico  = 9,      # mínimo de meses válidos na janela de 12m
    tolerancia_f01 = 0.01,   # kWh — diferença mínima para acusar F01
    prev_fixos_f03 = 4,      # meses fixos anteriores para acusar F03
)


def _check_motor_regras(fichas_ia: str, historico: list, ficha: dict) -> dict:
    """
    Replica os limiares do motor_regras_f01_f05.sql sobre os dados do banco.
    Retorna:
        {
          "passou": bool,
          "checks": [{"ficha": "F02", "status": "PASS"|"WARN"|"FAIL", "motivo": "..."}],
          "override_status": None | "INCONCLUSIVO"
        }
    PASS  = motor_regras concordaria com a IA
    WARN  = dados insuficientes no banco para validar (não bloqueia)
    FAIL  = motor_regras NÃO detectaria esta anomalia → override para INCONCLUSIVO
    """
    fichas_set = {c.upper() for c in re.findall(r"F0[1-5]", fichas_ia or "", re.IGNORECASE)}
    checks = []
    override = None

    # ── F02 ──────────────────────────────────────────────────────────────────
    if "F02" in fichas_set:
        validos = [r for r in historico
                   if float(r.get("kwh_total") or 0) > _MR["media_minima"]]
        n_val = len(validos)

        # kwh_total da fatura auditada
        kwh_atual = float(ficha.get("KWH_Total") or 0)
        if kwh_atual == 0:
            kwh_atual = (float(ficha.get("KWH_Ponta")     or 0) +
                         float(ficha.get("KWH_FPonta")    or 0) +
                         float(ficha.get("KWH_Reservado") or 0))

        if n_val >= _MR["min_historico"] and kwh_atual > 0:
            media   = sum(float(r["kwh_total"]) for r in validos) / n_val
            dif_pct = (kwh_atual - media) / media if media > 0 else 0

            if dif_pct >= _MR["desvio_pico"]:
                status_mr, label = "PASS", "PICO_OUTLIER"
            elif dif_pct >= _MR["desvio_alto"]:
                status_mr, label = "PASS", "DESVIO_ALTO"
            elif dif_pct <= _MR["desvio_baixo"]:
                status_mr, label = "PASS", "MUITO_BAIXO"
            elif dif_pct < _MR["desvio_baixo"] / 2.0:
                status_mr, label = "WARN", "DESVIO_BAIXO (limítrofe)"
                override = override or "INCONCLUSIVO"
            else:
                status_mr, label = "FAIL", "NORMAL"
                override = "INCONCLUSIVO"

            checks.append({
                "ficha": "F02", "status": status_mr,
                "motivo": (
                    f"motor_regras→{label} | "
                    f"dif_pct={dif_pct*100:+.1f}% | "
                    f"media={media:.0f} kWh ({n_val}m) | "
                    f"atual={kwh_atual:.0f} kWh | "
                    f"limiar_alto=+{_MR['desvio_alto']*100:.0f}% "
                    f"limiar_baixo={_MR['desvio_baixo']*100:.0f}%"
                ),
            })

        elif n_val > 0:
            checks.append({
                "ficha": "F02", "status": "WARN",
                "motivo": (f"Base pequena: {n_val} meses válidos "
                           f"(mínimo {_MR['min_historico']}) → "
                           "motor_regras marcaria AMOSTRA_PEQUENA"),
            })
        else:
            checks.append({
                "ficha": "F02", "status": "WARN",
                "motivo": "Sem histórico no banco (KWH_Total ausente) — não foi possível validar F02",
            })

    # ── F01 ──────────────────────────────────────────────────────────────────
    if "F01" in fichas_set:
        la_p   = float(ficha.get("Leitura_Anterior_KWH_P")  or 0)
        lc_p   = float(ficha.get("Leitura_Atual_KWH_P")     or 0)
        la_fp  = float(ficha.get("Leitura_Anterior_KWH_FP") or 0)
        lc_fp  = float(ficha.get("Leitura_Atual_KWH_FP")    or 0)
        kwh_p  = float(ficha.get("KWH_Ponta")               or 0)
        kwh_fp = float(ficha.get("KWH_FPonta")              or 0)
        cp     = float(ficha.get("Constante_KWH_P")         or 0) or 1.0
        cfp    = float(ficha.get("Constante_KWH_FP")        or 0) or 1.0

        sem_dados = (la_p == 0 and lc_p == 0 and la_fp == 0 and lc_fp == 0)
        if sem_dados:
            checks.append({
                "ficha": "F01", "status": "WARN",
                "motivo": "Leituras não disponíveis no banco — F01 só pode ser validado via PDF",
            })
        else:
            flag_p = flag_fp = False
            if (la_p > 0 or lc_p > 0) and kwh_p > 0 and kwh_p not in (30, 50, 100):
                calc = (lc_p - la_p) * cp
                if (abs(kwh_p - round(calc,      6)) > _MR["tolerancia_f01"] and
                    abs(kwh_p - round(calc*1.025, 6)) > _MR["tolerancia_f01"]):
                    flag_p = True
            if (la_fp > 0 or lc_fp > 0) and kwh_fp > 0 and kwh_fp not in (30, 50, 100):
                calc = (lc_fp - la_fp) * cfp
                if (abs(kwh_fp - round(calc,      6)) > _MR["tolerancia_f01"] and
                    abs(kwh_fp - round(calc*1.025, 6)) > _MR["tolerancia_f01"]):
                    flag_fp = True

            if flag_p or flag_fp:
                segs = " | ".join(filter(None, ["P" if flag_p else None, "FP" if flag_fp else None]))
                checks.append({"ficha": "F01", "status": "PASS",
                               "motivo": f"Divergência confirmada pelo motor_regras: posto(s) {segs}"})
            else:
                checks.append({
                    "ficha": "F01", "status": "FAIL",
                    "motivo": (f"Motor_regras NÃO detectaria F01: "
                               f"|calc − kwh_faturado| ≤ {_MR['tolerancia_f01']} kWh"),
                })
                override = "INCONCLUSIVO"

    # ── F03 ──────────────────────────────────────────────────────────────────
    if "F03" in fichas_set:
        grupo   = "B" if "BT" in (ficha.get("Tp_Tensao") or "").upper() else "A"
        recentes = historico[:5]
        fixos = sum(
            1 for r in recentes
            if (grupo == "B" and float(r.get("kwh_total") or 0) in (30, 50, 100))
            or (grupo == "A" and float(r.get("kwh_total") or 0) == 0)
        )
        if fixos >= _MR["prev_fixos_f03"]:
            checks.append({"ficha": "F03", "status": "PASS",
                           "motivo": f"{fixos} meses fixos detectados no banco — padrão F03 confirma"})
        elif fixos > 0:
            checks.append({
                "ficha": "F03", "status": "WARN",
                "motivo": (f"Apenas {fixos} meses fixos no banco "
                           f"(motor_regras exige {_MR['prev_fixos_f03']}) — "
                           "F03 pode ser identificado somente pela fatura"),
            })
        else:
            checks.append({
                "ficha": "F03", "status": "WARN",
                "motivo": ("Nenhum mês fixo detectado no banco — "
                           "F03 baseado exclusivamente na fatura; verificar manualmente"),
            })

    # ── F04 / F05 — validação manual ─────────────────────────────────────────
    for fx in ("F04", "F05"):
        if fx in fichas_set:
            checks.append({"ficha": fx, "status": "WARN",
                           "motivo": (f"{fx}: requer comparação de medidor/leitura "
                                      "com mês anterior — validação automática não disponível")})

    passou = all(c["status"] != "FAIL" for c in checks)
    return {
        "passou": passou,
        "checks": checks,
        "override_status": override if not passou else None,
    }


def _logar_check(mr: dict, fid: int):
    """Imprime o resultado da conferência do motor de regras."""
    status_geral = "✅ OK" if mr["passou"] else "⚠️  DIVERGÊNCIA"
    log.info(f"    [motor_regras check] {status_geral} | id={fid}")
    for c in mr["checks"]:
        ico = {"PASS": "✓", "WARN": "~", "FAIL": "✗"}.get(c["status"], "?")
        log.info(f"      {ico} {c['ficha']} [{c['status']}]: {c['motivo']}")
    if mr.get("override_status"):
        log.warning(f"    → ia_status rebaixado para {mr['override_status']} "
                    f"(motor_regras não confirma anomalia)")


# ─── Parser da resposta ────────────────────────────────────────────────────────

def parsear_resposta(texto: str) -> dict:
    ia_status = "INCONCLUSIVO"
    if re.search(r"Anomalia\s+Confirmada|✓\s*Anomalia", texto, re.IGNORECASE):
        ia_status = "CONFIRMADO"
    elif re.search(r"Anomalia\s+Não\s+Confirmada|Não\s+Confirmada|✗", texto, re.IGNORECASE):
        ia_status = "FALSO_POSITIVO"

    m = re.search(r"Fichas\s+Confirmadas\s*:\s*\d+\s*\(([^)]*)\)", texto, re.IGNORECASE)
    if m:
        codes = re.findall(r"F0[1-5]", m.group(1), re.IGNORECASE)
        ia_fichas = " | ".join(sorted(set(c.upper() for c in codes)))
    else:
        # Fallback: F0x seguido de confirmação explícita
        codes = re.findall(r"F0[1-5](?=\s*(?:confirmad|✓|constat|detectad))", texto, re.IGNORECASE)
        ia_fichas = " | ".join(sorted(set(c.upper() for c in codes)))

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

    # ── Anti-falso-positivo F02 ────────────────────────────────────────────
    # F02 "consumo abaixo da média" produz valor_f02 = R$0,00.
    # Se a IA confirmou SOMENTE F02 mas não extraiu nenhum valor monetário,
    # o caso não representa cobrança indevida real: rebaixar para INCONCLUSIVO
    # para revisão manual em vez de aparecer como anomalia confirmada.
    if ia_status == "CONFIRMADO" and (valor is None or valor == 0):
        fichas_set = set(re.findall(r"F0[1-5]", ia_fichas, re.IGNORECASE))
        fichas_set = {c.upper() for c in fichas_set}
        if fichas_set == {"F02"} or not fichas_set:
            ia_status = "INCONCLUSIVO"

    return {
        "ia_status":                    ia_status,
        "ia_fichas_confirmadas":        ia_fichas,
        "resultado_ia":                 texto,
        "valor_ressarcimento_estimado": valor,
    }

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


def _gravar_ficha(cur, conn, ficha: dict, dados: dict):
    """
    Modo --direto: insere ou atualiza em fichas_anomalias_cache.
    Idempotente via INSERT ... ON DUPLICATE KEY UPDATE.
    """
    fid          = ficha["id"]
    fichas_ia    = dados.get("ia_fichas_confirmadas") or ""
    flags        = _flags_fichas(fichas_ia)
    qtd          = sum(flags.values())
    valor        = dados.get("valor_ressarcimento_estimado")
    resultado_ia = (dados.get("resultado_ia") or "")[:65000]
    ia_status    = dados.get("ia_status") or "INCONCLUSIVO"

    try:
        cur.execute("""
            INSERT INTO fichas_anomalias_cache
                (id, UC, Cod_Empresa, Concessionaria, Mes_Ref, Tp_Tensao, NroMedidor,
                 RAZAO_SOCIAL, Link, RS_Total_Fatura,
                 flag_f01, flag_f02, flag_f03, flag_f04, flag_f05,
                 qtd_regras, fichas_aplicadas, ia_fichas_confirmadas,
                 ia_status, resultado_ia, valor_ressarcimento_estimado,
                 resultado_salvo_em)
            VALUES
                (%s, %s, %s, %s, %s, %s, %s,
                 %s, %s, %s,
                 %s, %s, %s, %s, %s,
                 %s, %s, %s,
                 %s, %s, %s,
                 NOW())
            ON DUPLICATE KEY UPDATE
                ia_status                    = VALUES(ia_status),
                resultado_ia                 = VALUES(resultado_ia),
                ia_fichas_confirmadas        = VALUES(ia_fichas_confirmadas),
                fichas_aplicadas             = VALUES(fichas_aplicadas),
                flag_f01 = VALUES(flag_f01), flag_f02 = VALUES(flag_f02),
                flag_f03 = VALUES(flag_f03), flag_f04 = VALUES(flag_f04),
                flag_f05 = VALUES(flag_f05), qtd_regras = VALUES(qtd_regras),
                valor_ressarcimento_estimado = VALUES(valor_ressarcimento_estimado),
                resultado_salvo_em           = NOW()
        """, (
            fid,
            ficha.get("UC"), ficha.get("Cod_Empresa"), ficha.get("Concessionaria"),
            ficha.get("Mes_Ref"), ficha.get("Tp_Tensao"), ficha.get("NroMedidor"),
            ficha.get("RAZAO_SOCIAL"), ficha.get("Link"), ficha.get("RS_Total_Fatura"),
            flags["flag_f01"], flags["flag_f02"], flags["flag_f03"],
            flags["flag_f04"], flags["flag_f05"],
            qtd, fichas_ia, fichas_ia,
            ia_status, resultado_ia, valor,
        ))
        conn.commit()
        log.info(f"    → fichas_anomalias_cache: {ia_status} | fichas={fichas_ia or '—'} | valor={valor}")
    except Exception as e:
        log.warning(f"    → Erro ao gravar fichas_anomalias_cache: {e}")


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


def _salvar_cache_fatura(cur, conn, fid: int, resultado_ia: str, ia_status: str):
    """Grava analise_IA e anomalia_encontrada em Faturas_Registradas_Cache.
    Retorna (cur, conn) — pode ser nova conexão se a original caiu.
    """
    anomalia   = 1 if ia_status in ("CONFIRMADO", "INCONCLUSIVO") else 0
    texto_safe = _sanitize(resultado_ia or "")[:65000]
    sql = """
        UPDATE Faturas_Registradas_Cache
           SET analise_IA          = %s,
               anomalia_encontrada = %s,
               ia_analisado_em     = NOW()
         WHERE id = %s
    """
    for tentativa in range(2):
        try:
            cur.execute(sql, (texto_safe, anomalia, fid))
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
                "max_completion_tokens":  2048,
                "messages": [
                    {"role": "system", "content": _sanitize(prompt)},
                    {"role": "user",   "content": _sanitize(contexto)},
                ],
            },
        }
        requests_jsonl.append(json.dumps(req, ensure_ascii=True))

    jsonl_bytes = "\n".join(requests_jsonl).encode("utf-8", errors="ignore")
    log.info(f"JSONL gerado: {len(jsonl_bytes) // 1024} KB")

    # ── 2. Upload do arquivo ────────────────────────────────────────────────────
    log.info("Enviando arquivo para OpenAI Files API...")
    upload_resp = requests.post(
        f"{OPENAI_BASE_URL}/v1/files",
        headers=headers,
        files={
            "file":    ("batch_requests.jsonl", jsonl_bytes, "application/jsonl"),
            "purpose": (None, "batch"),
        },
        timeout=120,
    )
    upload_resp.raise_for_status()
    file_id = upload_resp.json()["id"]
    log.info(f"Arquivo enviado: file_id={file_id}")

    # ── 3. Cria o batch ─────────────────────────────────────────────────────────
    batch_resp = requests.post(
        f"{OPENAI_BASE_URL}/v1/batches",
        headers={**headers, "Content-Type": "application/json"},
        json={
            "input_file_id":      file_id,
            "endpoint":           "/v1/chat/completions",
            "completion_window":  "24h",
        },
        timeout=60,
    )
    batch_resp.raise_for_status()
    batch_id = batch_resp.json()["id"]
    log.info(f"Batch criado: batch_id={batch_id}")

    # ── 4. Poll até concluir ────────────────────────────────────────────────────
    log.info("Aguardando conclusão do batch (poll a cada 30s)...")
    output_file_id = None
    while True:
        status_resp = requests.get(
            f"{OPENAI_BASE_URL}/v1/batches/{batch_id}",
            headers=headers,
            timeout=30,
        )
        status_resp.raise_for_status()
        bdata    = status_resp.json()
        status   = bdata["status"]
        counts   = bdata.get("request_counts", {})
        log.info(f"  status={status} | {counts.get('completed',0)}/{counts.get('total', len(fichas))}")

        if status == "completed":
            output_file_id = bdata.get("output_file_id")
            error_file_id  = bdata.get("error_file_id")
            # Se todas falharam, baixa o arquivo de erros para diagnóstico
            if not output_file_id and error_file_id:
                log.error("Batch completou com 0 sucessos. Baixando error_file para diagnóstico...")
                try:
                    err_resp = requests.get(
                        f"{OPENAI_BASE_URL}/v1/files/{error_file_id}/content",
                        headers=headers, timeout=60,
                    )
                    for i, line in enumerate(err_resp.text.strip().split("\n")[:5]):
                        if line.strip():
                            try:
                                obj = json.loads(line)
                                log.error(f"  Erro #{i+1}: {json.dumps(obj.get('error') or obj, ensure_ascii=False)[:300]}")
                            except Exception:
                                log.error(f"  Linha #{i+1}: {line[:300]}")
                except Exception as de:
                    log.error(f"  Falha ao baixar error_file: {de}")
                raise RuntimeError("Batch concluído mas 0 requisições com sucesso — verifique os erros acima")
            break
        elif status in ("failed", "expired", "cancelled"):
            error_file_id = bdata.get("error_file_id")
            if error_file_id:
                log.error(f"Batch encerrado ({status}). Baixando error_file...")
                try:
                    err_resp = requests.get(
                        f"{OPENAI_BASE_URL}/v1/files/{error_file_id}/content",
                        headers=headers, timeout=60,
                    )
                    for i, line in enumerate(err_resp.text.strip().split("\n")[:5]):
                        if line.strip():
                            try:
                                obj = json.loads(line)
                                log.error(f"  Erro #{i+1}: {json.dumps(obj.get('error') or obj, ensure_ascii=False)[:300]}")
                            except Exception:
                                log.error(f"  Linha #{i+1}: {line[:300]}")
                except Exception as de:
                    log.error(f"  Falha ao baixar error_file: {de}")
            raise RuntimeError(f"Batch encerrado com status: {status}")

        time.sleep(30)

    if not output_file_id:
        raise RuntimeError("Batch concluído mas sem output_file_id")

    # ── 5. Baixa resultados ─────────────────────────────────────────────────────
    log.info(f"Baixando resultados: {output_file_id}")
    out_resp = requests.get(
        f"{OPENAI_BASE_URL}/v1/files/{output_file_id}/content",
        headers=headers,
        timeout=120,
    )
    out_resp.raise_for_status()

    # ── 6. Processa e salva ─────────────────────────────────────────────────────
    ok = erro = 0
    for line in out_resp.text.strip().split("\n"):
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
        except (KeyError, IndexError) as e:
            log.warning(f"  {custom_id}: resposta malformada — {e}")
            erro += 1
            continue

        dados = parsear_resposta(content)

        # Conferência motor de regras (usa historico salvo na ficha_map)
        if dados["ia_fichas_confirmadas"]:
            hist_ficha = ficha.get("_historico") or []
            mr = _check_motor_regras(dados["ia_fichas_confirmadas"], hist_ficha, ficha)
            _logar_check(mr, fid)
            if mr.get("override_status") and dados["ia_status"] == "CONFIRMADO":
                dados["ia_status"] = mr["override_status"]
        else:
            mr = {"passou": True, "checks": []}

        log.info(f"  {custom_id} | UC={uc} | {dados['ia_status']} | fichas={dados['ia_fichas_confirmadas'] or '—'}")

        print(f"\n{'═'*60}")
        print(f"ID: {fid} | UC: {uc} | Mês: {mes}")
        print(f"IA Status: {dados['ia_status']} | Fichas: {dados['ia_fichas_confirmadas'] or '—'}")
        if mr["checks"]:
            print(f"[motor_regras] {'✅ OK' if mr['passou'] else '⚠️  DIVERGÊNCIA'}: " +
                  " | ".join(f"{c['ficha']}={c['status']}" for c in mr["checks"]))
        print(content[:800] + ("..." if len(content) > 800 else ""))
        print("═" * 60)

        cur, conn = _salvar_cache_fatura(cur, conn, fid, content, dados["ia_status"])

        if direto and dados["ia_status"] in ("CONFIRMADO", "INCONCLUSIVO"):
            _gravar_ficha(cur, conn, ficha, dados)
        elif not direto:
            _atualizar_ficha(cur, conn, fid, dados)

        ok += 1

    log.info(f"Batch processado: {ok} ok | {erro} erros | {len(fichas)} total")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main(cod_empresa: int, force: bool, limite: int | None,
         direto: bool = False, batch: bool = False, modelo: str | None = None):
    modelo = modelo or (OPENAI_MODEL_MINI if batch else OPENAI_MODEL)
    log.info("=" * 60)
    log.info(f"analisar_batch.py — empresa={cod_empresa} force={force} direto={direto} batch={batch} modelo={modelo} limite={limite or 'sem limite'}")

    if not HAS_PDFIUM:
        log.warning("pypdfium2 não instalado — análise sem imagem. Execute: pip install pypdfium2")

    prompt = carregar_prompt()
    conn   = mysql.connector.connect(**DB_APP)
    cur    = conn.cursor(dictionary=True)

    limit_sql = f"LIMIT {limite}" if limite else ""

    if direto:
        # Modo direto: lê de Faturas_Registradas_Cache onde texto_plumber foi extraído
        # Não depende do motor_regras — IA detecta F01-F05 autonomamente pelos textos
        cur.execute(f"""
            SELECT frc.id, frc.UC, frc.Cod_Empresa, frc.Concessionaria, frc.Mes_Ref,
                   frc.Tp_Tensao, frc.NroMedidor, frc.RAZAO_SOCIAL, frc.RS_Total_Fatura,
                   NULL AS fichas_aplicadas, NULL AS detalhamento, NULL AS ia_status,
                   frc.Link, frc.texto_plumber, frc.texto_markitdown, frc.texto_ocr,
                   -- Campos numéricos do banco (podem divergir do PDF)
                   frc.KWH_Ponta, frc.KWH_FPonta, frc.KWH_Reservado, frc.KWH_Total,
                   frc.Leitura_Anterior_KWH_P, frc.Leitura_Atual_KWH_P,
                   frc.Leitura_Anterior_KWH_FP, frc.Leitura_Atual_KWH_FP,
                   frc.Constante_KWH_P, frc.Constante_KWH_FP,
                   frc.Base_de_Calculo_ICMS, frc.Aliquota_ICMS, frc.ICMS_RS,
                   frc.CIP, frc.Dt_Venc_NF
            FROM Faturas_Registradas_Cache frc
            WHERE frc.Cod_Empresa = %s
              AND frc.texto_plumber IS NOT NULL
            ORDER BY frc.Mes_Ref DESC
            {limit_sql}
        """, (cod_empresa,))
    else:
        # Modo padrão: lê de fichas_anomalias_cache (gerada pelo motor_regras)
        filtro_ia = "" if force else "AND f.ia_status = 'PENDENTE'"
        cur.execute(f"""
            SELECT f.id, f.UC, f.Cod_Empresa, f.Concessionaria, f.Mes_Ref,
                   f.Tp_Tensao, f.NroMedidor, f.RAZAO_SOCIAL, f.RS_Total_Fatura,
                   f.fichas_aplicadas, f.detalhamento, f.ia_status,
                   frc.Link, frc.texto_plumber, frc.texto_markitdown, frc.texto_ocr
            FROM fichas_anomalias_cache f
            LEFT JOIN Faturas_Registradas_Cache frc ON frc.id = f.id
            WHERE f.Cod_Empresa = %s
              {filtro_ia}
            ORDER BY f.Mes_Ref DESC
            {limit_sql}
        """, (cod_empresa,))

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

        # 6. Parseia resultado + conferência motor de regras
        dados = parsear_resposta(resposta)

        if dados["ia_fichas_confirmadas"]:
            mr = _check_motor_regras(dados["ia_fichas_confirmadas"], historico, ficha)
            _logar_check(mr, fid)
            if mr.get("override_status") and dados["ia_status"] == "CONFIRMADO":
                dados["ia_status"] = mr["override_status"]
        else:
            mr = {"passou": True, "checks": []}

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
        cur, conn = _salvar_cache_fatura(cur, conn, fid, resposta, dados["ia_status"])

        # 8. Grava em fichas_anomalias_cache se anomalia confirmada (modo direto)
        if direto and dados["ia_status"] in ("CONFIRMADO", "INCONCLUSIVO"):
            _gravar_ficha(cur, conn, ficha, dados)

        # 9. Atualiza ia_status em fichas_anomalias_cache (modo padrão)
        if not direto:
            _atualizar_ficha(cur, conn, fid, dados)

        ok += 1
        time.sleep(PAUSA_ENTRE)

    log.info(f"\nConcluído: {ok} ok | {erro} erros | {sem_link} sem link | {len(fichas)} total")
    log.info("=" * 60)
    cur.close()
    conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Análise IA em lote com visão da fatura")
    parser.add_argument("--empresa", type=int, required=True)
    parser.add_argument("--force",   action="store_true")
    parser.add_argument("--limite",  type=int, default=None)
    parser.add_argument("--direto",  action="store_true",
                        help="Lê de Faturas_Registradas_Cache (texto_plumber preenchido) "
                             "sem depender do motor_regras. IA detecta F01-F05 autonomamente.")
    parser.add_argument("--batch",   action="store_true",
                        help="Usa OpenAI Batch API (50%% mais barato, sem imagens). "
                             "Submete tudo de uma vez e aguarda o resultado.")
    parser.add_argument("--modelo",  type=str, default=None,
                        help=f"Modelo OpenAI a usar. Padrão: {OPENAI_MODEL} (normal) "
                             f"ou {OPENAI_MODEL_MINI} (batch). Ex: --modelo gpt-4.5-mini")
    args = parser.parse_args()
    main(cod_empresa=args.empresa, force=args.force, limite=args.limite,
         direto=args.direto, batch=args.batch, modelo=args.modelo)
