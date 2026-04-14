"""
sync_faturas.py
---------------
Sincroniza Faturas_Registradas_Cache da origem (sgeeasy_clientes_novo)
para o destino (db_ressarcimento) usando dois passes:

  Passe 1 — Linhas novas:     WHERE id > ultimo_id
  Passe 2 — Linhas alteradas: WHERE Dt_Alteracao >= data_ultimo_sync AND id <= ultimo_id

Uso:
    python sync_faturas.py            # roda os dois passes
    python sync_faturas.py --passe 1  # só passe 1 (novas)
    python sync_faturas.py --passe 2  # só passe 2 (alteradas)
"""

import argparse
import logging
import sys
from datetime import datetime

import mysql.connector
import mysql.connector.cursor

# ─── Conexões ────────────────────────────────────────────────────────────────

ORIGEM = dict(
    host               = "179.127.27.122",
    port               = 3306,
    user               = "alisson_rodrigues",
    password           = "LpQKeDKud3!0giERA0Ig2NSvZ",
    database           = "sgeeasy_clientes_novo",
    charset            = "utf8mb4",
    connection_timeout = 30,
    use_pure           = True,
    ssl_disabled       = True,
)

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

TABELA_ORIGEM   = "Faturas_Registradas_Cache"
TABELA_DESTINO  = "Faturas_Registradas_Cache"
TABELA_CONTROLE = "sync_controle"
CHAVE_CONTROLE  = "faturas_cache"

BATCH_SIZE = 500

# ─── Logging ─────────────────────────────────────────────────────────────────

logging.basicConfig(
    level   = logging.INFO,
    format  = "%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt = "%Y-%m-%d %H:%M:%S",
    handlers = [
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("sync_faturas.log", encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def conectar(config, nome):
    conn = mysql.connector.connect(**config)
    cur  = conn.cursor(dictionary=True)
    cur.execute("SELECT DATABASE() AS db")
    banco = cur.fetchone()["db"]
    log.info(f"[{nome}] Conectado em: {config['host']} → banco: {banco}")
    return conn, cur


def contar_destino(cur):
    cur.execute(f"SELECT COUNT(*) AS total FROM {TABELA_DESTINO}")
    return cur.fetchone()["total"]


# ─── Controle de watermark ───────────────────────────────────────────────────

def get_watermark(cur):
    cur.execute(
        f"SELECT ultimo_id, ultima_exec FROM {TABELA_CONTROLE} WHERE tabela = %s",
        (CHAVE_CONTROLE,)
    )
    row = cur.fetchone()
    if row:
        return row["ultimo_id"], row["ultima_exec"]
    return 0, datetime(2000, 1, 1)


def save_watermark(cur, novo_id, qtd_novas, qtd_alteradas):
    cur.execute(f"""
        INSERT INTO {TABELA_CONTROLE} (tabela, ultimo_id, ultima_exec, qtd_linhas)
        VALUES (%s, %s, NOW(), %s)
        ON DUPLICATE KEY UPDATE
            ultimo_id   = VALUES(ultimo_id),
            ultima_exec = VALUES(ultima_exec),
            qtd_linhas  = qtd_linhas + VALUES(qtd_linhas)
    """, (CHAVE_CONTROLE, novo_id, qtd_novas + qtd_alteradas))
    log.info(f"Watermark salvo → ultimo_id={novo_id}")


# ─── Passe 1: linhas novas ───────────────────────────────────────────────────

def passe1_novas(cur_orig, cur_dest, conn_dest, watermark_id):
    log.info(f"[Passe 1] Buscando linhas novas (id > {watermark_id})...")

    total_lidas    = 0
    total_gravadas = 0
    novo_max       = watermark_id
    offset_id      = watermark_id

    while True:
        cur_orig.execute(f"""
            SELECT * FROM {TABELA_ORIGEM}
            WHERE id > %s
            ORDER BY id ASC
            LIMIT %s
        """, (offset_id, BATCH_SIZE))

        rows = cur_orig.fetchall()
        if not rows:
            break

        colunas    = [col for col in rows[0].keys() if col not in ("sync_inserido_em", "sync_atualizado_em")]
        cols_str   = ", ".join(f"`{c}`" for c in colunas)
        placeh_str = ", ".join(["%s"] * len(colunas))
        values     = [tuple(r[c] for c in colunas) for r in rows]

        cur_dest.executemany(f"""
            INSERT IGNORE INTO {TABELA_DESTINO} ({cols_str})
            VALUES ({placeh_str})
        """, values)

        gravadas = cur_dest.rowcount  # número real de linhas gravadas
        conn_dest.commit()

        novo_max   = rows[-1]["id"]
        offset_id  = novo_max
        total_lidas    += len(rows)
        total_gravadas += gravadas

        log.info(f"  → Lidas: {len(rows)} | Gravadas: {gravadas} | Último id: {novo_max}")

        if len(rows) < BATCH_SIZE:
            break

    log.info(f"[Passe 1] Concluído. Lidas: {total_lidas} | Gravadas: {total_gravadas}")
    return total_gravadas, novo_max


# ─── Passe 2: linhas alteradas ───────────────────────────────────────────────

def passe2_alteradas(cur_orig, cur_dest, conn_dest, ultima_exec, max_id_atual):
    data_ref = ultima_exec.date() if isinstance(ultima_exec, datetime) else ultima_exec
    log.info(f"[Passe 2] Buscando alterações (Dt_Alteracao >= {data_ref} AND id <= {max_id_atual})...")

    cur_orig.execute(f"""
        SELECT * FROM {TABELA_ORIGEM}
        WHERE Dt_Alteracao >= %s
          AND id <= %s
        ORDER BY id ASC
    """, (data_ref, max_id_atual))

    rows = cur_orig.fetchall()
    if not rows:
        log.info("[Passe 2] Nenhuma alteração encontrada.")
        return 0

    colunas    = [col for col in rows[0].keys() if col not in ("sync_inserido_em", "sync_atualizado_em")]
    cols_str   = ", ".join(f"`{c}`" for c in colunas)
    placeh_str = ", ".join(["%s"] * len(colunas))
    update_str = ", ".join(f"`{c}` = VALUES(`{c}`)" for c in colunas if c != "id")
    update_str += ", `sync_atualizado_em` = NOW()"
    values     = [tuple(r[c] for c in colunas) for r in rows]

    total_gravadas = 0
    for i in range(0, len(values), BATCH_SIZE):
        lote = values[i:i + BATCH_SIZE]
        cur_dest.executemany(f"""
            INSERT INTO {TABELA_DESTINO} ({cols_str})
            VALUES ({placeh_str})
            ON DUPLICATE KEY UPDATE {update_str}
        """, lote)
        conn_dest.commit()
        total_gravadas += cur_dest.rowcount
        log.info(f"  → Lote {i // BATCH_SIZE + 1}: {cur_dest.rowcount} linhas atualizadas.")

    log.info(f"[Passe 2] Concluído. {total_gravadas} linhas atualizadas.")
    return total_gravadas


# ─── Main ─────────────────────────────────────────────────────────────────────

def sync(apenas_passe=None):
    log.info("=" * 60)
    log.info(f"Iniciando sync — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    conn_orig, cur_orig = conectar(ORIGEM, "ORIGEM")
    conn_dest, cur_dest = conectar(DESTINO, "DESTINO")

    try:
        watermark_id, ultima_exec = get_watermark(cur_dest)
        log.info(f"Watermark atual → id={watermark_id} | ultima_exec={ultima_exec}")

        total_antes = contar_destino(cur_dest)
        log.info(f"Linhas no destino antes do sync: {total_antes}")

        qtd_novas     = 0
        qtd_alteradas = 0
        novo_max_id   = watermark_id

        if apenas_passe in (None, 1):
            qtd_novas, novo_max_id = passe1_novas(cur_orig, cur_dest, conn_dest, watermark_id)

        if apenas_passe in (None, 2):
            max_ref = novo_max_id if novo_max_id > watermark_id else watermark_id
            qtd_alteradas = passe2_alteradas(cur_orig, cur_dest, conn_dest, ultima_exec, max_ref)

        save_watermark(cur_dest, novo_max_id, qtd_novas, qtd_alteradas)
        conn_dest.commit()

        total_depois = contar_destino(cur_dest)
        log.info(f"Linhas no destino após o sync: {total_depois} (+{total_depois - total_antes})")
        log.info(f"Sync finalizado. Novas: {qtd_novas} | Atualizadas: {qtd_alteradas}")
        log.info("=" * 60)

    except Exception as e:
        conn_dest.rollback()
        log.error(f"Erro durante o sync: {e}", exc_info=True)
        raise

    finally:
        cur_orig.close()
        cur_dest.close()
        conn_orig.close()
        conn_dest.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Sync Faturas_Registradas_Cache")
    parser.add_argument("--passe", type=int, choices=[1, 2], help="Rodar apenas o passe 1 ou 2")
    args = parser.parse_args()

    sync(apenas_passe=args.passe)
