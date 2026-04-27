"""
sync_faturas.py
---------------
Sincroniza Faturas_Registradas_Cache da origem (sgeeasy_clientes_novo)
para o destino (db_ressarcimento).

Estrategia:
  - Cursor: (Dt_Alteracao, id_origem) — avanca conforme linhas sao processadas
  - UPSERT por chave de negocio (UID, Mes_Ref, Cod_Empresa)
    via INSERT ... ON DUPLICATE KEY UPDATE
  - Preserva colunas locais (texto_ocr, analise_IA, etc.) — nao sobrescreve
  - Ignora linhas com UID lixo (NULL, '', '0')
  - Reconecta automaticamente se conexao cair

Pre-requisito: tabela destino tem UNIQUE INDEX uk_uid_mes_empresa
(UID, Mes_Ref, Cod_Empresa).

Uso:
    python sync_faturas.py            # sincronizacao incremental
    python sync_faturas.py --reset    # reseta cursor e re-processa tudo
                                       (mantem o que ja esta no destino,
                                        apenas atualiza colunas vindas da origem)
"""

import argparse
import logging
import sys
from datetime import datetime, date

import mysql.connector


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

# Colunas que SO existem no destino — nunca devem ser tocadas pelo sync
COLUNAS_LOCAIS = {
    "sync_inserido_em", "sync_atualizado_em",
    "texto_ocr",        "ocr_gerado_em",
    "texto_markitdown", "markitdown_gerado_em",
    "texto_plumber",    "plumber_gerado_em",
    "analise_IA",       "anomalia_encontrada",       "ia_analisado_em",
    "resultado_regras", "resultado_regras_em",
    "resultado_analises", "resultado_final_em",
    "fichas_apontadas",
}


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


# ─── Conexao ────────────────────────────────────────────────────────────────

def conectar(config, nome):
    conn = mysql.connector.connect(**config)
    cur  = conn.cursor(dictionary=True)
    cur.execute("SELECT DATABASE() AS db")
    banco = cur.fetchone()["db"]
    log.info(f"[{nome}] Conectado em: {config['host']} -> banco: {banco}")
    return conn, cur


def garantir_conexao(conn, cur, config, nome):
    """Faz ping/reconnect se a conexao caiu (timeout durante OCR/lote longo)."""
    try:
        conn.ping(reconnect=True, attempts=3, delay=2)
        return conn, cur
    except Exception:
        log.warning(f"[{nome}] Reabrindo conexao...")
        try: cur.close()
        except: pass
        try: conn.close()
        except: pass
        return conectar(config, nome)


def contar_destino(cur):
    cur.execute(f"SELECT COUNT(*) AS total FROM {TABELA_DESTINO}")
    return cur.fetchone()["total"]


# ─── Watermark ────────────────────────────────────────────────────────────────

def garantir_coluna_cursor(conn, cur):
    """Adiciona coluna cursor_alteracao na sync_controle se ainda nao existir."""
    cur.execute("""
        SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = %s
          AND COLUMN_NAME  = 'cursor_alteracao'
    """, (TABELA_CONTROLE,))
    if cur.fetchone()["n"] == 0:
        log.info("Adicionando coluna cursor_alteracao na sync_controle...")
        cur.execute(f"ALTER TABLE {TABELA_CONTROLE} ADD COLUMN cursor_alteracao DATE NULL")
        conn.commit()


def get_watermark(cur_dest):
    cur_dest.execute(
        f"SELECT cursor_alteracao, ultimo_id FROM {TABELA_CONTROLE} WHERE tabela = %s",
        (CHAVE_CONTROLE,)
    )
    row = cur_dest.fetchone()
    if row and row["cursor_alteracao"]:
        return row["cursor_alteracao"], row["ultimo_id"] or 0

    # Primeira execucao do novo sync: usa max(Dt_Alteracao) ja presente no destino
    log.info("Cursor nao definido. Calculando MAX(Dt_Alteracao) do destino...")
    cur_dest.execute(f"SELECT MAX(Dt_Alteracao) AS m FROM {TABELA_DESTINO}")
    m = cur_dest.fetchone()["m"]
    if m is None:
        return date(1900, 1, 1), 0
    return m, 0


def save_watermark(cur_dest, conn_dest, cursor_alteracao, ultimo_id, qtd_proc):
    cur_dest.execute(f"""
        INSERT INTO {TABELA_CONTROLE} (tabela, cursor_alteracao, ultimo_id, ultima_exec, qtd_linhas)
        VALUES (%s, %s, %s, NOW(), %s)
        ON DUPLICATE KEY UPDATE
            cursor_alteracao = VALUES(cursor_alteracao),
            ultimo_id        = VALUES(ultimo_id),
            ultima_exec      = VALUES(ultima_exec),
            qtd_linhas       = qtd_linhas + VALUES(qtd_linhas)
    """, (CHAVE_CONTROLE, cursor_alteracao, ultimo_id, qtd_proc))
    conn_dest.commit()


# ─── Sync principal ──────────────────────────────────────────────────────────

def sync(reset=False):
    log.info("=" * 60)
    log.info(f"Iniciando sync — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    conn_orig, cur_orig = conectar(ORIGEM,  "ORIGEM")
    conn_dest, cur_dest = conectar(DESTINO, "DESTINO")

    try:
        garantir_coluna_cursor(conn_dest, cur_dest)

        if reset:
            log.warning("--reset: cursor sera zerado, re-processa tudo da origem")
            cursor_alteracao = date(1900, 1, 1)
            ultimo_id        = 0
        else:
            cursor_alteracao, ultimo_id = get_watermark(cur_dest)

        log.info(f"Cursor inicial -> Dt_Alteracao>{cursor_alteracao} OR (=, id>{ultimo_id})")

        total_antes = contar_destino(cur_dest)
        log.info(f"Linhas no destino antes do sync: {total_antes}")

        total_lidas    = 0
        total_gravadas = 0

        while True:
            # Pega proximo lote da origem (incremental por (Dt_Alteracao, id))
            cur_orig.execute(f"""
                SELECT * FROM {TABELA_ORIGEM}
                WHERE Dt_Alteracao IS NOT NULL
                  AND UID IS NOT NULL AND UID <> '' AND UID <> '0'
                  AND (
                       Dt_Alteracao > %s
                    OR (Dt_Alteracao = %s AND id > %s)
                  )
                ORDER BY Dt_Alteracao ASC, id ASC
                LIMIT %s
            """, (cursor_alteracao, cursor_alteracao, ultimo_id, BATCH_SIZE))

            rows = cur_orig.fetchall()
            if not rows:
                break

            # Filtra colunas: nao toca em campos locais nem na PK 'id' do destino
            colunas_origem = [c for c in rows[0].keys() if c not in COLUNAS_LOCAIS]
            colunas_update = [c for c in colunas_origem if c != "id"]

            cols_str   = ", ".join(f"`{c}`" for c in colunas_origem)
            placeh_str = ", ".join(["%s"] * len(colunas_origem))
            update_str = ", ".join(f"`{c}` = VALUES(`{c}`)" for c in colunas_update)
            update_str += ", `sync_atualizado_em` = NOW()"
            values     = [tuple(r[c] for c in colunas_origem) for r in rows]

            conn_dest, cur_dest = garantir_conexao(conn_dest, cur_dest, DESTINO, "DESTINO")

            cur_dest.executemany(f"""
                INSERT INTO {TABELA_DESTINO} ({cols_str})
                VALUES ({placeh_str})
                ON DUPLICATE KEY UPDATE {update_str}
            """, values)
            conn_dest.commit()

            # rowcount com ON DUPLICATE KEY:
            #   1 por linha inserida nova
            #   2 por linha atualizada
            #   0 se nao mudou nada
            afetadas = cur_dest.rowcount

            ultima = rows[-1]
            cursor_alteracao = ultima["Dt_Alteracao"]
            ultimo_id        = ultima["id"]

            total_lidas    += len(rows)
            total_gravadas += afetadas

            save_watermark(cur_dest, conn_dest, cursor_alteracao, ultimo_id, len(rows))

            log.info(
                f"  -> Lidas: {len(rows)} | Afetadas: {afetadas} | "
                f"Cursor: {cursor_alteracao} / id={ultimo_id}"
            )

            if len(rows) < BATCH_SIZE:
                break

        total_depois = contar_destino(cur_dest)
        log.info("-" * 60)
        log.info(f"Lidas no total      : {total_lidas}")
        log.info(f"Linhas afetadas total: {total_gravadas}  (1=insert, 2=update por linha)")
        log.info(f"Linhas destino antes : {total_antes}")
        log.info(f"Linhas destino depois: {total_depois}  (delta {total_depois - total_antes:+d})")
        log.info(f"Cursor final         : {cursor_alteracao} / id={ultimo_id}")
        log.info("=" * 60)

    except Exception as e:
        try: conn_dest.rollback()
        except: pass
        log.error(f"Erro durante o sync: {e}", exc_info=True)
        raise

    finally:
        try: cur_orig.close()
        except: pass
        try: cur_dest.close()
        except: pass
        try: conn_orig.close()
        except: pass
        try: conn_dest.close()
        except: pass


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Sync Faturas_Registradas_Cache (UPSERT por UID,Mes_Ref,Cod_Empresa)")
    p.add_argument("--reset", action="store_true",
                   help="Zera o cursor e re-processa todas as linhas da origem (UPSERT — preserva colunas IA do destino)")
    args = p.parse_args()
    sync(reset=args.reset)
