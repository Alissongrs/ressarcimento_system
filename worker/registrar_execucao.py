#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
registrar_execucao.py — registra no banco que uma rotina do cron está viva e o que ela fez.
O painel "Rotinas" da tela Tarefas do sistema lê essas tabelas; uma rotina do backend confere
a cada 15 min e avisa quem foi configurado quando algo atrasa ou falha. (melhoria 5, 13/11/2026)

Tabelas (criadas pelo backend, migração aditiva):
  FT_ROTINAS_HEARTBEAT (rotina, ultimo_ping, host)   — "a rotina rodou agora" (barato, a cada disparo)
  FT_ROTINAS_EXECUCOES (id, rotina, inicio, fim, status, rc, resumo, host) — uma linha por trabalho feito

Uso pela linha de comando (os .sh do worker usam via rotina_lib.sh):
  registrar_execucao.py ping NOME                  → só marca que rodou
  registrar_execucao.py inicio NOME [RESUMO]       → cria a execução (status rodando) e imprime o id
  registrar_execucao.py fim ID RC [RESUMO]         → fecha a execução: rc 0 = ok, outro = erro
  registrar_execucao.py registrar NOME RC [RESUMO] → inicio+fim de uma vez (quando já terminou)

Uso de dentro de outro script Python:
  import registrar_execucao as reg
  reg.ping("titular_conversas"); eid = reg.inicio("titular_conversas"); reg.fim(eid, 0, "3 títulos")

Nunca derruba a rotina que chamou: qualquer erro de banco vira uma linha no stderr e sai com 0.
Não imprime credenciais.
"""
import os
import socket
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from has_work import ler_dsn  # noqa: E402

HOST = socket.gethostname()[:60]


def _con():
    import pymysql
    u, p, h, port, db = ler_dsn()
    return pymysql.connect(host=h, port=port, user=u, password=p, database=db, charset="utf8mb4",
                           connect_timeout=5, read_timeout=10, write_timeout=10, autocommit=True)


def _resumo(s):
    s = (s or "").strip()
    return s[:500] if s else None


def ping(rotina):
    try:
        con = _con()
        try:
            with con.cursor() as cur:
                cur.execute("""INSERT INTO FT_ROTINAS_HEARTBEAT (rotina, ultimo_ping, host) VALUES (%s, NOW(), %s)
                               ON DUPLICATE KEY UPDATE ultimo_ping = NOW(), host = VALUES(host)""", (rotina, HOST))
        finally:
            con.close()
    except Exception as e:  # noqa: BLE001
        print("[registrar_execucao] ping %s: %s" % (rotina, e), file=sys.stderr)


def inicio(rotina, resumo=""):
    """Abre uma execução e devolve o id (0 se o banco falhou)."""
    try:
        con = _con()
        try:
            with con.cursor() as cur:
                cur.execute("""INSERT INTO FT_ROTINAS_EXECUCOES (rotina, inicio, status, resumo, host)
                               VALUES (%s, NOW(), 'rodando', %s, %s)""", (rotina, _resumo(resumo), HOST))
                cur.execute("""INSERT INTO FT_ROTINAS_HEARTBEAT (rotina, ultimo_ping, host) VALUES (%s, NOW(), %s)
                               ON DUPLICATE KEY UPDATE ultimo_ping = NOW(), host = VALUES(host)""", (rotina, HOST))
                return int(con.insert_id() or cur.lastrowid or 0)
        finally:
            con.close()
    except Exception as e:  # noqa: BLE001
        print("[registrar_execucao] inicio %s: %s" % (rotina, e), file=sys.stderr)
        return 0


def fim(eid, rc=0, resumo=""):
    try:
        eid = int(eid or 0)
    except ValueError:
        eid = 0
    if eid <= 0:
        return
    status = "ok" if int(rc) == 0 else "erro"
    try:
        con = _con()
        try:
            with con.cursor() as cur:
                cur.execute("""UPDATE FT_ROTINAS_EXECUCOES
                                  SET fim = NOW(), status = %s, rc = %s, resumo = COALESCE(%s, resumo)
                                WHERE id = %s""", (status, int(rc), _resumo(resumo), eid))
        finally:
            con.close()
    except Exception as e:  # noqa: BLE001
        print("[registrar_execucao] fim %s: %s" % (eid, e), file=sys.stderr)


def registrar(rotina, rc=0, resumo=""):
    """Execução que já terminou: grava inicio=fim=agora."""
    status = "ok" if int(rc) == 0 else "erro"
    try:
        con = _con()
        try:
            with con.cursor() as cur:
                cur.execute("""INSERT INTO FT_ROTINAS_EXECUCOES (rotina, inicio, fim, status, rc, resumo, host)
                               VALUES (%s, NOW(), NOW(), %s, %s, %s, %s)""", (rotina, status, int(rc), _resumo(resumo), HOST))
                cur.execute("""INSERT INTO FT_ROTINAS_HEARTBEAT (rotina, ultimo_ping, host) VALUES (%s, NOW(), %s)
                               ON DUPLICATE KEY UPDATE ultimo_ping = NOW(), host = VALUES(host)""", (rotina, HOST))
        finally:
            con.close()
    except Exception as e:  # noqa: BLE001
        print("[registrar_execucao] registrar %s: %s" % (rotina, e), file=sys.stderr)


def main(argv):
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 0
    cmd, args = argv[0], argv[1:]
    if cmd == "ping":
        ping(args[0])
    elif cmd == "inicio":
        print(inicio(args[0], " ".join(args[1:])))
    elif cmd == "fim" and len(args) >= 2:
        fim(args[0], args[1], " ".join(args[2:]))
    elif cmd == "registrar" and len(args) >= 2:
        registrar(args[0], args[1], " ".join(args[2:]))
    else:
        print("[registrar_execucao] comando desconhecido: %s" % " ".join(argv), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
