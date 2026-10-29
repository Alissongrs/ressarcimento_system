#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
has_work.py — gate do worker autônomo (SURE).

Checa se há pedidos na fila de REVISÃO que o executor determinístico não resolveu
(os que o worker/IA precisa responder). Exit 0 = há trabalho; exit 1 = fila vazia.
O run_worker.sh usa isto para só acionar o Claude quando necessário (economiza tokens).

Conexão: lê DB_APP_URL do backend/.env (formato user:senha@tcp(host:porta)/db).
Somente LEITURA (um SELECT COUNT).
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = os.path.join(HERE, "..", "backend", ".env")

FILTRO = (
    "status='revisao' AND "
    "(executado_em IS NULL OR resultado LIKE 'Pedido não reconhecido%%') AND "
    "LOWER(COALESCE(resultado,'')) NOT LIKE 'requer decis%%'"
)


def ler_dsn():
    url = os.environ.get("DB_APP_URL", "")
    if not url and os.path.exists(ENV):
        with open(ENV, "r", encoding="utf-8", errors="ignore") as f:
            for ln in f:
                ln = ln.strip()
                if ln.startswith("DB_APP_URL"):
                    url = ln.split("=", 1)[1].strip().strip('"').strip("'")
                    break
    m = re.match(r"^([^:]+):(.*)@tcp\(([^:]+):(\d+)\)/(.+)$", url)
    if not m:
        print("DB_APP_URL ausente/ inválida", file=sys.stderr)
        sys.exit(2)
    user, pwd, host, port, db = m.groups()
    # remove querystring (?parseTime=...)
    db = db.split("?", 1)[0]
    return user, pwd, host, int(port), db


def main():
    try:
        import pymysql
    except ImportError:
        print("pymysql não instalado (pip install pymysql)", file=sys.stderr)
        sys.exit(2)
    user, pwd, host, port, db = ler_dsn()
    try:
        con = pymysql.connect(host=host, port=port, user=user, password=pwd,
                              database=db, connect_timeout=10, read_timeout=15)
        with con.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM FT_SOLICITACOES WHERE " + FILTRO)
            n = cur.fetchone()[0]
        con.close()
    except Exception as e:  # noqa: BLE001
        print("erro de conexão: %s" % e, file=sys.stderr)
        sys.exit(2)
    print(int(n))
    sys.exit(0 if n > 0 else 1)


if __name__ == "__main__":
    main()
