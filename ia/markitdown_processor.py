"""
markitdown_processor.py
-----------------------
Baixa o PDF de cada fatura (via coluna Link) e converte para Markdown
usando markitdown. Grava o resultado em texto_markitdown na tabela
Faturas_Registradas_Cache do db_ressarcimento.

Uso:
    python markitdown_processor.py                        # processa todas com texto_markitdown IS NULL
    python markitdown_processor.py --empresa 123          # filtra por Cod_Empresa
    python markitdown_processor.py --empresa 123 --force  # reprocessa mesmo já tendo markdown
    python markitdown_processor.py --limite 50            # processa no máximo N faturas
"""

import argparse
import logging
import sys
import tempfile
import time
from pathlib import Path

import requests
import mysql.connector
from markitdown import MarkItDown

# ─── Conexão ─────────────────────────────────────────────────────────────────

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

# ─── Configuração ─────────────────────────────────────────────────────────────

TABELA          = "Faturas_Registradas_Cache"
TIMEOUT_HTTP    = 30        # segundos para download do PDF
PAUSA_ENTRE     = 0.3       # segundos entre faturas (não sobrecarregar S3/CDN)
MAX_MARKDOWN_MB = 10        # descartar se markdown > 10 MB (PDF corrompido/gigante)

# ─── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level    = logging.INFO,
    format   = "%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt  = "%Y-%m-%d %H:%M:%S",
    handlers = [
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("markitdown_processor.log", encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)

# ─── Helpers ──────────────────────────────────────────────────────────────────

def baixar_pdf(url: str) -> bytes | None:
    """Faz download do PDF e retorna os bytes, ou None em caso de erro."""
    try:
        r = requests.get(url, timeout=TIMEOUT_HTTP, stream=True)
        r.raise_for_status()
        content = r.content
        if not content:
            log.warning(f"    Download vazio: {url}")
            return None
        return content
    except Exception as e:
        log.warning(f"    Falha no download ({url}): {e}")
        return None


def pdf_para_markdown(pdf_bytes: bytes) -> str | None:
    """Converte bytes de PDF em Markdown usando markitdown."""
    try:
        md = MarkItDown()
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_bytes)
            tmp_path = tmp.name

        result = md.convert(tmp_path)
        Path(tmp_path).unlink(missing_ok=True)

        texto = result.text_content or ""
        if len(texto.encode("utf-8")) > MAX_MARKDOWN_MB * 1024 * 1024:
            log.warning(f"    Markdown muito grande (>{MAX_MARKDOWN_MB}MB) — descartado")
            return None

        return texto.strip() or None
    except Exception as e:
        log.warning(f"    Erro no markitdown: {e}")
        return None


# ─── Main ─────────────────────────────────────────────────────────────────────

def main(cod_empresa: int | None, force: bool, limite: int | None):
    log.info("=" * 60)
    log.info("Iniciando markitdown_processor.py")

    conn = mysql.connector.connect(**DB)
    cur  = conn.cursor(dictionary=True)

    # ── Monta query de seleção ────────────────────────────────────────────────
    filtros = ["Link IS NOT NULL", "TRIM(Link) != ''"]
    params  = []

    if not force:
        filtros.append("texto_markitdown IS NULL")

    if cod_empresa is not None:
        filtros.append("Cod_Empresa = %s")
        params.append(cod_empresa)

    where   = " AND ".join(filtros)
    limit_c = f"LIMIT {limite}" if limite else ""

    query = f"""
        SELECT id, UC, Cod_Empresa, Concessionaria, Mes_Ref, Link
        FROM `{TABELA}`
        WHERE {where}
        ORDER BY id DESC
        {limit_c}
    """

    log.info(f"Buscando faturas: empresa={cod_empresa or 'todas'}, force={force}, limite={limite or 'sem limite'}")
    cur.execute(query, params)
    faturas = cur.fetchall()
    log.info(f"Faturas encontradas: {len(faturas)}")

    if not faturas:
        log.info("Nada a processar.")
        cur.close()
        conn.close()
        return

    # ── Inicializa markitdown uma vez ─────────────────────────────────────────
    ok = erro = 0

    for i, row in enumerate(faturas, 1):
        fid   = row["id"]
        uc    = row["UC"]
        link  = str(row["Link"]).strip()
        mes   = row["Mes_Ref"]
        conc  = row["Concessionaria"]

        log.info(f"[{i}/{len(faturas)}] id={fid} UC={uc} {conc} {mes}")
        log.info(f"    Link: {link}")

        # 1. Download
        pdf_bytes = baixar_pdf(link)
        if pdf_bytes is None:
            erro += 1
            _gravar_erro(cur, conn, fid, "ERRO_DOWNLOAD")
            continue

        log.info(f"    PDF baixado: {len(pdf_bytes) / 1024:.1f} KB")

        # 2. Markitdown
        markdown = pdf_para_markdown(pdf_bytes)
        if markdown is None:
            erro += 1
            _gravar_erro(cur, conn, fid, "ERRO_MARKDOWN")
            continue

        log.info(f"    Markdown gerado: {len(markdown)} chars")

        # 3. Grava no banco
        cur.execute(
            f"""UPDATE `{TABELA}`
                SET texto_markitdown      = %s,
                    markitdown_gerado_em  = NOW()
                WHERE id = %s""",
            (markdown, fid),
        )
        conn.commit()
        ok += 1
        log.info(f"    Gravado com sucesso.")

        time.sleep(PAUSA_ENTRE)

    log.info(f"\nConcluído: {ok} ok | {erro} erros | {len(faturas)} total")
    log.info("=" * 60)

    cur.close()
    conn.close()


def _gravar_erro(cur, conn, fatura_id: int, motivo: str):
    """Marca a fatura com texto indicando o erro, para não retentar infinitamente."""
    cur.execute(
        f"""UPDATE `{TABELA}`
            SET texto_markitdown     = %s,
                markitdown_gerado_em = NOW()
            WHERE id = %s""",
        (f"[{motivo}]", fatura_id),
    )
    conn.commit()
    log.warning(f"    Marcado como {motivo}")


# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Markitdown Processor — converte PDFs de faturas em Markdown")
    parser.add_argument("--empresa", type=int, default=None,
                        help="Filtrar por Cod_Empresa (ex: --empresa 123)")
    parser.add_argument("--force", action="store_true",
                        help="Reprocessar faturas que já têm texto_markitdown")
    parser.add_argument("--limite", type=int, default=None,
                        help="Processar no máximo N faturas (ex: --limite 50)")
    args = parser.parse_args()

    main(cod_empresa=args.empresa, force=args.force, limite=args.limite)
