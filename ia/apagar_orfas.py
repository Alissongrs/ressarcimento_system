"""
apagar_orfas.py
---------------
Le orfas_no_destino.csv (gerado por verificar_orfas.py) e apaga as linhas
correspondentes no DESTINO (db_ressarcimento.Faturas_Registradas_Cache).

Modos:
    python apagar_orfas.py                # apaga TODAS as orfas (default)
    python apagar_orfas.py --apenas-sem-ia # apaga so as com score_ia=0
    python apagar_orfas.py --dry-run       # nao apaga, so mostra o que faria

Antes de rodar: garanta que o backup
'Faturas_Registradas_Cache_Backup_20260426' existe.
"""

import argparse
import csv
import logging
import sys

import mysql.connector

DESTINO = dict(
    host               = "db-acesso-ressarcimento.cvicxzrqb58o.us-east-2.rds.amazonaws.com",
    port               = 3306,
    user               = "super_user_ressarcimento",
    password           = "qZ8YbD3GxK9uN4RmV2sAeT7LwBjCp5X0",
    database           = "db_ressarcimento",
    charset            = "utf8mb4",
    connection_timeout = 30,
    use_pure           = True,
    ssl_disabled       = True,
)

TABELA     = "Faturas_Registradas_Cache"
CSV_INPUT  = "orfas_no_destino.csv"
BATCH_SIZE = 500

logging.basicConfig(
    level   = logging.INFO,
    format  = "%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt = "%Y-%m-%d %H:%M:%S",
    handlers = [logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)


def ler_csv(apenas_sem_ia):
    ids = []
    contagem = {0: 0, 1: 0, 2: 0, 3: 0, 4: 0}
    with open(CSV_INPUT, "r", encoding="utf-8", newline="") as f:
        r = csv.DictReader(f, delimiter=";")
        for row in r:
            score = int(row["score_ia"])
            contagem[score] = contagem.get(score, 0) + 1
            if apenas_sem_ia and score != 0:
                continue
            ids.append(int(row["id"]))
    return ids, contagem


def apagar_em_lotes(cur, conn, ids, dry_run):
    total      = len(ids)
    apagadas   = 0
    for i in range(0, total, BATCH_SIZE):
        lote = ids[i:i + BATCH_SIZE]
        placeholders = ", ".join(["%s"] * len(lote))
        sql = f"DELETE FROM {TABELA} WHERE id IN ({placeholders})"

        if dry_run:
            log.info(f"  [DRYRUN] Apagaria {len(lote)} (de {i+1} a {i+len(lote)})")
            apagadas += len(lote)
            continue

        cur.execute(sql, lote)
        conn.commit()
        apagadas += cur.rowcount
        log.info(f"  Lote {i // BATCH_SIZE + 1}: {cur.rowcount} apagadas (total {apagadas}/{total})")

    return apagadas


def main():
    p = argparse.ArgumentParser(description="Apaga orfas listadas em orfas_no_destino.csv")
    p.add_argument("--apenas-sem-ia", action="store_true",
                   help="Apaga somente linhas com score_ia=0 (sem trabalho de IA)")
    p.add_argument("--dry-run",       action="store_true",
                   help="Nao apaga, apenas mostra quantas seriam afetadas")
    args = p.parse_args()

    log.info("=" * 60)
    modo = "APENAS SEM IA" if args.apenas_sem_ia else "TODAS AS ORFAS"
    if args.dry_run:
        modo += " (DRY-RUN — nada sera apagado)"
    log.info(f"Modo: {modo}")
    log.info(f"CSV: {CSV_INPUT}")

    ids, contagem = ler_csv(args.apenas_sem_ia)

    log.info("Distribuicao no CSV:")
    for s in sorted(contagem):
        log.info(f"  score_ia={s}: {contagem[s]}")
    log.info(f"Selecionadas para apagar: {len(ids)}")

    if not ids:
        log.info("Nada para apagar.")
        return

    if not args.dry_run:
        resp = input(f"\nConfirmar apagar {len(ids)} linhas? (digite SIM): ")
        if resp.strip() != "SIM":
            log.info("Cancelado.")
            return

    conn = mysql.connector.connect(**DESTINO)
    cur  = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM " + TABELA)
    antes = cur.fetchone()[0]
    log.info(f"Linhas antes: {antes}")

    try:
        apagadas = apagar_em_lotes(cur, conn, ids, args.dry_run)
        cur.execute("SELECT COUNT(*) FROM " + TABELA)
        depois = cur.fetchone()[0]
        log.info("-" * 60)
        log.info(f"Linhas apagadas: {apagadas}")
        log.info(f"Linhas antes  : {antes}")
        log.info(f"Linhas depois : {depois}")
        log.info(f"Diferenca     : {antes - depois}")
        log.info("=" * 60)
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
