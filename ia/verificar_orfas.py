"""
verificar_orfas.py
------------------
Compara Faturas_Registradas_Cache entre ORIGEM (sgeeasy_clientes_novo)
e DESTINO (db_ressarcimento) usando a chave de negocio:

    (UID, Mes_Ref, Cod_Empresa)

Gera dois arquivos CSV (nao apaga nada):

  orfas_no_destino.csv  - linhas que estao SO no destino (candidatas a delete).
                          Inclui score_ia (0-4) para indicar quanto trabalho de
                          IA seria perdido se a linha fosse apagada.
  orfas_na_origem.csv   - linhas que estao SO na origem (faltando no destino).

Linhas com UID lixo (NULL, '', '0') sao ignoradas dos dois lados.

Uso:
    python verificar_orfas.py
"""

import csv
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

TABELA = "Faturas_Registradas_Cache"

logging.basicConfig(
    level   = logging.INFO,
    format  = "%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt = "%Y-%m-%d %H:%M:%S",
    handlers = [logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)


def _conectar(cfg, nome):
    conn = mysql.connector.connect(**cfg)
    cur  = conn.cursor(dictionary=True)
    log.info(f"[{nome}] Conectado em {cfg['host']} -> {cfg['database']}")
    return conn, cur


def _norm_mes(v):
    """Normaliza Mes_Ref para string YYYY-MM-DD ou '' (NULL/empty)."""
    if v is None:
        return ""
    if isinstance(v, (datetime, date)):
        return v.strftime("%Y-%m-%d")
    return str(v).strip()


def _chave(row):
    return (
        (row["UID"] or "").strip(),
        _norm_mes(row["Mes_Ref"]),
        row["Cod_Empresa"] if row["Cod_Empresa"] is not None else -1,
    )


def coletar_chaves_origem(cur):
    log.info("[ORIGEM] Lendo chaves...")
    cur.execute(f"""
        SELECT UID, Mes_Ref, Cod_Empresa
        FROM {TABELA}
        WHERE UID IS NOT NULL AND UID <> '' AND UID <> '0'
    """)
    chaves = set()
    for row in cur:
        chaves.add(_chave(row))
    log.info(f"[ORIGEM] {len(chaves)} chaves distintas")
    return chaves


def coletar_linhas_destino(cur):
    log.info("[DESTINO] Lendo linhas com score IA...")
    cur.execute(f"""
        SELECT id, UID, Mes_Ref, Cod_Empresa, UC,
               (CASE WHEN texto_ocr        IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN analise_IA       IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN fichas_apontadas IS NOT NULL THEN 1 ELSE 0 END +
                CASE WHEN resultado_regras IS NOT NULL THEN 1 ELSE 0 END) AS score_ia
        FROM {TABELA}
        WHERE UID IS NOT NULL AND UID <> '' AND UID <> '0'
    """)
    linhas = cur.fetchall()
    log.info(f"[DESTINO] {len(linhas)} linhas")
    return linhas


def main():
    log.info("=" * 60)
    log.info("Verificando orfas — comparando origem x destino")

    conn_o, cur_o = _conectar(ORIGEM,  "ORIGEM")
    conn_d, cur_d = _conectar(DESTINO, "DESTINO")

    try:
        chaves_origem  = coletar_chaves_origem(cur_o)
        linhas_destino = coletar_linhas_destino(cur_d)

        chaves_destino = {_chave(l) for l in linhas_destino}

        orfas_no_destino = [
            l for l in linhas_destino if _chave(l) not in chaves_origem
        ]
        orfas_na_origem = chaves_origem - chaves_destino

        log.info("-" * 60)
        log.info(f"Total origem  : {len(chaves_origem)}")
        log.info(f"Total destino : {len(linhas_destino)}")
        log.info(f"Orfas no DESTINO (existem aqui, nao na origem): {len(orfas_no_destino)}")
        log.info(f"Orfas na ORIGEM (existem la, nao no destino) : {len(orfas_na_origem)}")
        log.info("-" * 60)

        # ── orfas_no_destino.csv ──
        with open("orfas_no_destino.csv", "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f, delimiter=";")
            w.writerow(["id", "UID", "Mes_Ref", "Cod_Empresa", "UC", "score_ia"])
            for l in orfas_no_destino:
                w.writerow([
                    l["id"], l["UID"], _norm_mes(l["Mes_Ref"]),
                    l["Cod_Empresa"], l.get("UC") or "", l["score_ia"],
                ])
        log.info(f"orfas_no_destino.csv -> {len(orfas_no_destino)} linhas")

        # Resumo por score IA das orfas no destino
        contagem_score = {}
        for l in orfas_no_destino:
            contagem_score[l["score_ia"]] = contagem_score.get(l["score_ia"], 0) + 1
        log.info("Distribuicao do score_ia das orfas no destino:")
        for score in sorted(contagem_score):
            log.info(f"  score_ia={score}: {contagem_score[score]}")

        # ── orfas_na_origem.csv ──
        with open("orfas_na_origem.csv", "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f, delimiter=";")
            w.writerow(["UID", "Mes_Ref", "Cod_Empresa"])
            for k in sorted(orfas_na_origem):
                w.writerow([k[0], k[1], k[2]])
        log.info(f"orfas_na_origem.csv  -> {len(orfas_na_origem)} chaves")

        log.info("=" * 60)
        log.info("CSV gerados. Nada foi apagado.")

    finally:
        cur_o.close(); conn_o.close()
        cur_d.close(); conn_d.close()


if __name__ == "__main__":
    main()
