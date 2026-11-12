#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
titular_conversas.py — refina os TÍTULOS das conversas do chat usando a IA (claude -p).

O backend já cria um título heurístico (1ª mensagem) marcado auto=1. Este script, rodado
pelo cron, pega as conversas auto=1, pede UM título curto pra cada (em lote, 1 chamada
`claude -p`) e grava auto=2 (refinado). Títulos renomeados à mão (auto=0) nunca são tocados.

Somente escreve na tabela FT_CHAT_CONVERSA_TITULO (coluna titulo). Não imprime credenciais.
Uso (cron a cada poucos min):  python3 worker/titular_conversas.py
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from has_work import ler_dsn  # noqa: E402

CLAUDE = os.environ.get("SURE_CLAUDE_BIN", "claude")
MAX_CONV = int(os.environ.get("SURE_TITULO_LOTE", "20"))


def conectar():
    import pymysql
    u, p, h, port, db = ler_dsn()
    return pymysql.connect(host=h, port=port, user=u, password=p, database=db, charset="utf8mb4",
                           connect_timeout=15, read_timeout=60, write_timeout=60, autocommit=False)


def pegar_pendentes(con):
    """Conversas com título automático (auto=1) + as primeiras mensagens de cada uma."""
    with con.cursor() as cur:
        cur.execute("""SELECT t.id_usuario, t.sessao
                         FROM FT_CHAT_CONVERSA_TITULO t
                        WHERE t.auto = 1
                        ORDER BY t.atualizado_em DESC
                        LIMIT %s""", (MAX_CONV,))
        alvos = cur.fetchall()
        out = []
        for idu, sessao in alvos:
            cur.execute("""SELECT role, LEFT(conteudo, 300) FROM FT_CHAT_CONVERSAS
                            WHERE id_usuario=%s AND sessao=%s ORDER BY id LIMIT 6""", (idu, sessao))
            msgs = cur.fetchall()
            if msgs:
                out.append({"id_usuario": idu, "sessao": sessao, "msgs": msgs})
    return out


def montar_prompt(convs):
    linhas = [
        "Você gera TÍTULOS curtos para conversas de um sistema de ressarcimento de energia (pt-BR).",
        "Para cada conversa abaixo, devolva um título de NO MÁXIMO 6 palavras, claro e específico,",
        "sem aspas, sem ponto final, sem jargão técnico. Responda SOMENTE um JSON no formato",
        '{"<sessao>": "<titulo>", ...} — nada além do JSON.', "",
    ]
    for cv in convs:
        linhas.append("### sessao %s" % cv["sessao"])
        for role, texto in cv["msgs"]:
            quem = "Usuário" if role == "user" else "SURE"
            linhas.append("%s: %s" % (quem, (texto or "").replace("\n", " ").strip()))
        linhas.append("")
    return "\n".join(linhas)


def chamar_claude(prompt):
    flags = os.environ.get("SURE_CLAUDE_TITULO_FLAGS", "-p --permission-mode bypassPermissions --allowedTools ").strip()
    args = [CLAUDE] + [a for a in flags.split(" ") if a]
    try:
        p = subprocess.run(args, input=prompt, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=180)
    except Exception as e:  # noqa: BLE001
        print("falha ao chamar claude:", e, file=sys.stderr)
        return {}
    saida = p.stdout or ""
    m = re.search(r"\{.*\}", saida, re.S)
    if not m:
        return {}
    try:
        return json.loads(m.group(0))
    except ValueError:
        return {}


def limpar_titulo(t):
    t = re.sub(r"\s+", " ", str(t or "").strip().strip('"').strip("'")).strip(" .")
    return t[:160]


def main():
    con = conectar()
    try:
        convs = pegar_pendentes(con)
        if not convs:
            print("[titular] nada pendente.")
            return
        titulos = chamar_claude(montar_prompt(convs))
        n = 0
        with con.cursor() as cur:
            for cv in convs:
                t = limpar_titulo(titulos.get(cv["sessao"], ""))
                if not t:
                    continue
                # só atualiza se continua auto (não sobrescreve renomeação manual que entrou nesse meio)
                cur.execute("""UPDATE FT_CHAT_CONVERSA_TITULO
                                  SET titulo=%s, auto=2, atualizado_em=NOW()
                                WHERE id_usuario=%s AND sessao=%s AND auto=1""",
                            (t, cv["id_usuario"], cv["sessao"]))
                n += cur.rowcount
        con.commit()
        print("[titular] %d título(s) refinado(s) pela IA." % n)
    finally:
        con.close()


if __name__ == "__main__":
    main()
