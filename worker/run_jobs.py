#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
run_jobs.py — roda no HOST da VPS as TAREFAS CONHECIDAS pedidas pelo chat (#sistema/@sistema).

O chat transforma "rode o agua_sync … empresas 4 14 32 …" em FT_SOLICITACOES com
acao_json {"op":"rodar_job","params":{"job":"agua_sync","empresas":"4,14,32"}}. Pedidos do
próprio aprovador (Alisson) já entram 'aprovado'; dos demais, depois da aprovação. O executor
do container deixa passar; aqui o job roda e o RESULTADO volta para o chat de quem pediu.

Whitelist de jobs (só estes rodam):
  agua_sync — worker/jobs/agua_sync.py apply [--empresas …]: insere só as faturas de água novas
              (backup das chaves inseridas no próprio script).

Uso (cron a cada minuto, via run_jobs.sh):  python3 worker/run_jobs.py
Não imprime credenciais.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from has_work import ler_dsn  # noqa: E402

PY = os.environ.get("SURE_PYTHON", sys.executable or "python3")
JOBS = {
    "agua_sync": os.path.join(HERE, "jobs", "agua_sync.py"),
}


def conectar():
    import pymysql
    user, pwd, host, port, db = ler_dsn()
    return pymysql.connect(host=host, port=port, user=user, password=pwd, database=db, charset="utf8mb4",
                           connect_timeout=15, read_timeout=120, write_timeout=120, autocommit=False)


def pegar(con):
    """Reserva a próxima tarefa aprovada (status → 'executando')."""
    with con.cursor() as cur:
        cur.execute("""SELECT id, usuario_nome, acao_json FROM FT_SOLICITACOES
            WHERE status='aprovado' AND executado_em IS NULL AND acao_json LIKE %s
            ORDER BY id LIMIT 1 FOR UPDATE""", ('%"op":"rodar_job"%',))
        r = cur.fetchone()
        if not r:
            con.commit()
            return None
        cur.execute("UPDATE FT_SOLICITACOES SET status='executando' WHERE id=%s", (r[0],))
    con.commit()
    return r


def finalizar(con, sid, status, resultado):
    with con.cursor() as cur:
        cur.execute("UPDATE FT_SOLICITACOES SET status=%s, resultado=%s, executado_em=NOW() WHERE id=%s",
                    (status, resultado[:60000], sid))
    con.commit()


def resumo_agua(saida, empresas):
    novas = re.search(r"NOVAS=(\d+)", saida)
    inseridas = re.search(r"OK\.\s*(\d+) faturas", saida)
    ja = re.search(r"JA no dest=(\d+)", saida)
    orig = re.search(r"origem faturas registradas=(\d+)", saida)
    por = re.search(r"novas por empresa:\s*(\{[^}]*\})", saida)
    n = int(inseridas.group(1)) if inseridas else (0 if (novas and novas.group(1) == "0") else None)
    linhas = []
    if n is None:
        return None
    linhas.append(f"✅ **Sincronização de faturas de ÁGUA concluída — {n} fatura(s) nova(s) inserida(s).**\n")
    if empresas:
        linhas.append(f"Empresas: {empresas}\n")
    if orig and ja:
        linhas.append(f"- Origem: {orig.group(1)} faturas registradas · já estavam no SURE: {ja.group(1)} · novas: {n}")
    if por:
        d = {k: int(v) for k, v in re.findall(r"(\d+)\s*:\s*(\d+)", por.group(1))}  # "{4: 696, 183: 63}"
        if d:
            linhas.append("\n| Empresa | Faturas novas |\n|---|---|")
            for emp, q in sorted(d.items(), key=lambda kv: -int(kv[1])):
                linhas.append(f"| {emp} | {q} |")
            linhas.append(f"| **Total** | **{n}** |")
    linhas.append("\n- O script gravou o backup das chaves inseridas (reversível).")
    return "\n".join(linhas)


def rodar(sid, usuario, acao_json):
    try:
        acao = json.loads(acao_json or "{}")
    except ValueError:
        return "erro", "Tarefa ilegível (acao_json inválido)."
    params = acao.get("params") or {}
    job = params.get("job", "")
    script = JOBS.get(job)
    if not script:
        return "revisao", f"Tarefa '{job}' não está na lista de tarefas automáticas — requer execução manual."
    if not os.path.exists(script):
        return "erro", f"Script da tarefa não encontrado na VPS: {script}"
    env = dict(os.environ, PYTHONUTF8="1")
    args = [PY, script, "apply"]
    empresas = params.get("empresas", "")
    if empresas:
        args += ["--empresas", empresas]
    try:
        p = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=1800, env=env, cwd=os.path.dirname(script))
    except subprocess.TimeoutExpired:
        return "erro", f"A tarefa {job} passou de 30 minutos e foi interrompida."
    saida = (p.stdout or "") + "\n" + (p.stderr or "")
    if p.returncode != 0:
        return "erro", f"A tarefa {job} falhou (código {p.returncode}).\n\n```\n{saida[-1500:]}\n```"
    texto = resumo_agua(saida, empresas) if job == "agua_sync" else None
    if job == "agua_sync":
        texto = (texto or "") + motor_agua(empresas, env)
    return "executado", texto or f"✅ Tarefa {job} concluída.\n\n```\n{saida[-1500:]}\n```"


def motor_agua(empresas, env):
    """Depois do sync: aplica a regra de PICO de consumo (FA02) nas faturas inseridas hoje
    → apontamentos na aba 💧 Água (/analise-desvio)."""
    args = [PY, os.path.join(HERE, "jobs", "agua_motor.py"), "apply"]
    if empresas:
        args += ["--empresas", empresas]
    try:
        p = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=1800, env=env, cwd=os.path.join(HERE, "jobs"))
    except subprocess.TimeoutExpired:
        return "\n\n⚠️ Regra de pico de consumo: passou de 30 min e foi interrompida."
    out = (p.stdout or "") + "\n" + (p.stderr or "")
    if p.returncode != 0:
        return f"\n\n⚠️ Regra de pico de consumo falhou (código {p.returncode}).\n```\n{out[-800:]}\n```"
    n = re.search(r"OK\.\s*(\d+) apontamentos", out)
    qtd = n.group(1) if n else "0"
    linhas = [f"\n\n🔎 **Regra de pico de consumo (consumo ≥ 2× a média dos últimos 12 meses) aplicada: "
              f"{qtd} apontamento(s)** na aba 💧 Água da Análise de Desvio."]
    rs = re.search(r"ressarcimento estimado total: R\$ ([\d,.]+)", out)
    por = re.search(r"apontamentos por empresa:\s*(\{[^}]*\})", out)
    if qtd != "0" and rs:
        valor = rs.group(1).replace(",", "X").replace(".", ",").replace("X", ".")
        linhas.append(f"- Ressarcimento estimado: R$ {valor}")
    if qtd != "0" and por:
        linhas.append(f"- Por empresa: {por.group(1)}")
    return "\n".join(linhas)


def main():
    con = conectar()
    try:
        while True:
            r = pegar(con)
            if not r:
                break
            sid, usuario, acao_json = r
            print(f"[run_jobs] #{sid} ({usuario}) iniciando…", flush=True)
            status, resultado = rodar(sid, usuario, acao_json)
            finalizar(con, sid, status, resultado)
            print(f"[run_jobs] #{sid} → {status}", flush=True)
    finally:
        con.close()


if __name__ == "__main__":
    main()
