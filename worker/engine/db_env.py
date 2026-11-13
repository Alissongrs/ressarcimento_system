# -*- coding: utf-8 -*-
"""Conexões do motor de extração lidas do backend/.env — nenhuma senha no código.

As DSNs usam o formato do Go (o mesmo do backend e do worker/has_work.py):
    usuario:senha@tcp(host:porta)/banco?parseTime=true
Chaves usadas:
    DB_APP_URL      destino (db_ressarcimento) — onde o pipeline grava
    DB_FATURAS      origem sgeeasy (Faturas_Registradas_Cache); fallback DB_FATURAS_URL
    DB_VTAL         origem alternativa VTAL (quivere_vtal), ligada por --vtal

Importar este módulo nunca falha: se a chave não existir, o dict volta com host vazio e
um aviso no log — a conexão é que falha, com mensagem clara, na hora de usar.
"""
import logging
import os
import re
from pathlib import Path

_log = logging.getLogger("db_env")
_ENV_CARREGADO = False

# Mesmo formato aceito pelo worker/has_work.py (ler_dsn): usuario:senha@tcp(host:porta)/banco[?qs]
_RE_DSN = re.compile(r"^([^:]*):(.*)@tcp\(([^:)]+):(\d+)\)/([^?]+)(?:\?.*)?$")


def carregar_env() -> None:
    """Carrega backend/.env no os.environ (sem sobrescrever o que já existe).

    Procura, nesta ordem: SURE_ENV; backend/.env subindo a árvore a partir desta pasta
    (funciona em worker/engine/, ia/Copia/essencial/ e /opt/ressarcimento/...); e o
    caminho fixo da VPS.
    """
    global _ENV_CARREGADO
    if _ENV_CARREGADO:
        return
    _ENV_CARREGADO = True
    candidatos = []
    if os.environ.get("SURE_ENV"):
        candidatos.append(Path(os.environ["SURE_ENV"]))
    for p in Path(__file__).resolve().parents:
        candidatos.append(p / "backend" / ".env")
    candidatos.append(Path("/opt/ressarcimento/ressarcimento_system/backend/.env"))
    for c in candidatos:
        try:
            if not c.is_file():
                continue
            for ln in c.read_text(encoding="utf-8", errors="ignore").splitlines():
                ln = ln.strip()
                if ln and not ln.startswith("#") and "=" in ln:
                    k, _, v = ln.partition("=")
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
            return
        except Exception:
            continue


def dsn_para_dict(dsn: str, **extras) -> dict | None:
    """'u:s@tcp(h:p)/db?x' → kwargs do mysql.connector.connect. None se não casar."""
    m = _RE_DSN.match((dsn or "").strip().strip('"').strip("'"))
    if not m:
        return None
    user, pwd, host, port, db = m.groups()
    d = dict(host=host, port=int(port), user=user, password=pwd, database=db,
             charset="utf8mb4", use_pure=True, ssl_disabled=True)
    d.update(extras)
    return d


def conexao(*chaves: str, database: str | None = None, **extras) -> dict:
    """Dict de conexão a partir da primeira chave do .env que tiver uma DSN válida."""
    carregar_env()
    for k in chaves:
        d = dsn_para_dict(os.environ.get(k, ""), **extras)
        if d:
            if database:
                d["database"] = database
            return d
    _log.error("nenhuma DSN válida em %s no backend/.env — a conexão vai falhar quando for usada",
               "/".join(chaves))
    d = dict(host="", port=3306, user="", password="", database=database or "",
             charset="utf8mb4", use_pure=True, ssl_disabled=True)
    d.update(extras)
    return d
