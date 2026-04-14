"""
motor_regras.py
---------------
Executa os motores de regras SQL contra db_ressarcimento e grava os resultados:
  • motor_regras_f01_f05.sql  →  fichas_anomalias_cache        (ATIVO)
  • motor_regras_f06_f14.sql  →  fichas_f06_f14_cache          (comentado — pendente DDL)

Uso:
    python motor_regras.py            # roda todos os jobs ativos
    python motor_regras.py --job f01  # só F01-F05
"""

import argparse
import logging
import sys
import re
from pathlib import Path

import mysql.connector

# ─── Conexão destino ────────────────────────────────────────────────────────────

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

# ─── Jobs ───────────────────────────────────────────────────────────────────────

# SQL files ficam dois níveis acima: Docker/motor_regras_*.sql
_BASE = Path(__file__).parent.parent.parent

JOBS = {
    "f01": {
        "sql_file": _BASE / "motor_regras_f01_f05.sql",
        "table"   : "fichas_anomalias_cache",
    },
    # "f06": {
    #     "sql_file": _BASE / "motor_regras_f06_f14.sql",
    #     "table"   : "fichas_f06_f14_cache",
    # },
}

# Colunas a renomear: alias da query → coluna da tabela
COL_RENAME = {
    "desvio_pct_max_f02": "desvio_pct_max",  # F01-F05: alias diferente do nome na tabela
}

# Colunas a excluir do INSERT
# fichas_anomalias_cache usa o id da fatura como PK — não pular
# fichas_f06_f14_cache tem PK auto-increment própria — pular id
COL_SKIP_PER_JOB = {
    "f01": set(),       # id da fatura é PK da tabela destino → incluir
    "f06": {"id"},      # tabela destino tem auto-increment próprio → pular
}

BATCH_SIZE    = 500
TRUNCATE_BEFORE = True   # True = limpa a tabela antes; False = append incremental

# ─── Logging ─────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level   = logging.INFO,
    format  = "%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt = "%Y-%m-%d %H:%M:%S",
    handlers = [
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("motor_regras.log", encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)


# ─── Helpers ────────────────────────────────────────────────────────────────────

def split_statements(sql_text: str) -> list[str]:
    """
    Divide o arquivo SQL em statements individuais (por ';').
    Remove comentários -- e /* */ antes de dividir para evitar que
    semicolons dentro de comentários partam o statement errado.
    """
    # Remove blocos /* ... */
    sql_text = re.sub(r"/\*.*?\*/", "", sql_text, flags=re.DOTALL)
    # Remove comentários de linha -- ... (incluindo semicolons dentro deles)
    sql_text = re.sub(r"--[^\n]*", "", sql_text)
    parts = []
    for raw in sql_text.split(";"):
        stmt = raw.strip()
        if stmt:
            parts.append(stmt)
    return parts


def execute_job(conn, cur, job: dict) -> int:
    sql_path = job["sql_file"]
    table    = job["table"]

    log.info(f"Lendo: {sql_path.name}")
    if not sql_path.exists():
        log.error(f"Arquivo não encontrado: {sql_path}")
        return 0

    sql_text   = sql_path.read_text(encoding="utf-8")
    statements = split_statements(sql_text)

    if not statements:
        log.error("Arquivo SQL vazio ou sem statements válidos.")
        return 0

    # Executa todos os SET @var = valor; antes do SELECT principal
    set_stmts  = [s for s in statements if re.match(r"^\s*SET\b", s, re.IGNORECASE)]
    main_stmts = [s for s in statements if not re.match(r"^\s*SET\b", s, re.IGNORECASE)]

    log.info(f"  SET statements: {len(set_stmts)} | Query principal: {len(main_stmts)}")

    for stmt in set_stmts:
        cur.execute(stmt)

    if not main_stmts:
        log.error("Nenhum SELECT/WITH encontrado no arquivo.")
        return 0

    # Executa a query principal (WITH ... SELECT)
    log.info("  Executando query principal...")
    cur.execute(main_stmts[-1])
    rows = cur.fetchall()   # lista de dicts (cursor dictionary=True)
    log.info(f"  Linhas retornadas: {len(rows)}")

    if not rows:
        log.info("  Nenhuma anomalia detectada. Tabela não será alterada.")
        return 0

    # Monta lista de colunas (aplicando renomes e excluindo colunas do job)
    job_name = [k for k, v in JOBS.items() if v == job][0]
    skip = COL_SKIP_PER_JOB.get(job_name, set())
    raw_cols = list(rows[0].keys())
    cols = []
    col_map = {}   # col_dest -> col_source
    for c in raw_cols:
        if c in skip:
            continue
        dest = COL_RENAME.get(c, c)
        cols.append(dest)
        col_map[dest] = c

    cols_str  = ", ".join(f"`{c}`" for c in cols)
    placeh    = ", ".join(["%s"] * len(cols))
    insert_sql = f"INSERT INTO `{table}` ({cols_str}) VALUES ({placeh})"

    # Trunca se configurado
    if TRUNCATE_BEFORE:
        log.info(f"  Truncando `{table}`...")
        cur.execute(f"TRUNCATE TABLE `{table}`")
        conn.commit()

    # Insere em lotes
    total = 0
    for i in range(0, len(rows), BATCH_SIZE):
        lote = rows[i : i + BATCH_SIZE]
        valores = [tuple(r[col_map[c]] for c in cols) for r in lote]
        cur.executemany(insert_sql, valores)
        conn.commit()
        total += len(lote)
        log.info(f"  Lote {i // BATCH_SIZE + 1}: {len(lote)} linhas inseridas (total: {total})")

    log.info(f"  Job concluído: {total} linhas em `{table}`.")
    return total


# ─── Main ────────────────────────────────────────────────────────────────────────

def main(apenas_job: str | None = None):
    log.info("=" * 60)
    log.info("Iniciando motor_regras.py")

    conn = mysql.connector.connect(**DB)
    cur  = conn.cursor(dictionary=True)

    jobs_para_rodar = {apenas_job: JOBS[apenas_job]} if apenas_job else JOBS

    try:
        for nome, job in jobs_para_rodar.items():
            log.info(f"\n{'─'*40}\nJob: {nome.upper()} → {job['table']}")
            qtd = execute_job(conn, cur, job)
            log.info(f"Job {nome.upper()} finalizado: {qtd} linhas gravadas.")

    except Exception as e:
        conn.rollback()
        log.error(f"Erro: {e}", exc_info=True)
        raise
    finally:
        cur.close()
        conn.close()

    log.info("=" * 60)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Motor de Regras — F01-F14")
    parser.add_argument(
        "--job",
        choices=list(JOBS.keys()),
        help="Rodar apenas um job: f01 (F01-F05) ou f06 (F06-F14)",
    )
    args = parser.parse_args()
    main(apenas_job=args.job)
