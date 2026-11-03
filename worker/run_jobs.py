#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
run_jobs.py — roda no HOST da VPS as TAREFAS CONHECIDAS pedidas pelo chat (#sistema/@sistema).

O chat transforma "rode o agua_sync … empresas 4 14 32 …" em FT_SOLICITACOES com
acao_json {"op":"rodar_job","params":{"job":"agua_sync","empresas":"4,14,32"}}. Pedidos do
próprio aprovador (Alisson) já entram 'aprovado'; dos demais, depois da aprovação. O executor
do container deixa passar; aqui o job roda e o RESULTADO volta para o chat de quem pediu.

Também recebe os pedidos da tela "Tarefas do sistema" do SURE (/tarefas-sistema, só admin): o botão cria o
mesmo pedido rodar_job já aprovado.

Whitelist de jobs (só estes rodam):
  agua_sync    — worker/jobs/agua_sync.py apply [--empresas …]: insere só as faturas de água novas
                 (backup das chaves inseridas no próprio script) + regras de água (pico e sem medição).
  pdf_pipeline — worker/job_pdf_pipeline.sh (backup do banco + extração; o mesmo do cron seg/qui 02:00).
                 Pode levar horas: roda SOLTO em segundo plano (não trava esta fila) e, a cada minuto,
                 o andamento (fim do log) é gravado no pedido; ao terminar, o resumo vira o resultado.

Uso (cron a cada minuto, via run_jobs.sh):  python3 worker/run_jobs.py
Não imprime credenciais.
"""
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from has_work import ler_dsn  # noqa: E402

PY = os.environ.get("SURE_PYTHON", sys.executable or "python3")
JOBS = {
    "agua_sync": os.path.join(HERE, "jobs", "agua_sync.py"),
    "pdf_pipeline": os.path.join(HERE, "job_pdf_pipeline.sh"),
}
# tarefas longas: rodam soltas em segundo plano, acompanhadas a cada minuto por acompanhar()
FUNDO = {"pdf_pipeline": os.environ.get("SURE_PIPELINE_LOG", os.path.join(HERE, "pdf_pipeline.log"))}
ESTADO = os.path.join(HERE, ".jobs_em_andamento")


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


# ---------------------------------------------------------------- tarefas longas (segundo plano)

def _hhmm():
    return time.strftime("%d/%m %H:%M")


def iniciar_fundo(sid, job, script, params):
    """Solta a tarefa em segundo plano (sessão própria, sem herdar o lock do run_jobs) e guarda o estado."""
    log = FUNDO[job]
    try:
        offset = os.path.getsize(log)
    except OSError:
        offset = 0
    env = dict(os.environ, PYTHONUTF8="1")
    emp = params.get("empresas", "")
    if emp:
        env["SURE_PIPELINE_EMPRESAS"] = emp.replace(",", " ")
    p = subprocess.Popen(["bash", script], cwd=HERE, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
    os.makedirs(ESTADO, exist_ok=True)
    with open(os.path.join(ESTADO, f"{sid}.json"), "w", encoding="utf-8") as f:
        json.dump({"sid": sid, "job": job, "pid": p.pid, "log": log, "offset": offset, "inicio": _hhmm()}, f)
    quais = f" — empresas {emp}" if emp else ""
    return f"⏳ **{job} iniciado em {_hhmm()}**{quais}. O andamento aparece aqui a cada minuto."


def _vivo(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:  # o pid pode ter sido reaproveitado por outro processo
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return b"job_" in f.read()
    except OSError:
        return True


def _trecho_log(st):
    try:
        with open(st["log"], "r", encoding="utf-8", errors="replace") as f:
            f.seek(st["offset"])
            return f.read()
    except OSError:
        return ""


def resumo_pipeline(txt, terminou):
    linhas = [l for l in txt.splitlines() if l.strip()]
    ok = sum(int(m.group(1)) for m in re.finditer(r"Concluído:\s*(\d+) ok", txt))
    erros = sum(int(m.group(1)) for m in re.finditer(r"(\d+) erros \|", txt))
    total = sum(int(m.group(1)) for m in re.finditer(r"\|\s*(\d+) total", txt))
    prog = re.findall(r"^\[(\d+)/(\d+)\]", txt, re.M)
    rc = re.search(r"pdf_pipeline terminou \(rc=(\d+)\)", txt)
    out = []
    if "já em execução — pulando" in txt:
        out.append("⚠️ O pdf_pipeline já estava rodando (provavelmente o agendamento automático) — este pedido não iniciou outro.")
    elif terminou:
        out.append(f"✅ **pdf_pipeline concluído** — {ok} fatura(s) extraída(s), {erros} com erro, {total} no total"
                   + (f" (código {rc.group(1)})" if rc else "") + ".")
        out.append("Os itens de baixa confiança estão nas filas de conferência da Auditoria de Faturas.")
    else:
        andamento = f"fatura {prog[-1][0]} de {prog[-1][1]} da empresa atual" if prog else "preparando (backup do banco)"
        out.append(f"⏳ **pdf_pipeline em andamento** — {andamento}; até agora {ok} ok / {erros} com erro.")
    out.append("\n```\n" + "\n".join(l[:200] for l in linhas[-25:]) + "\n```")
    return "\n".join(out)


def acompanhar(con):
    """A cada minuto: grava o andamento das tarefas em segundo plano; as que terminaram viram resultado."""
    if not os.path.isdir(ESTADO):
        return
    for nome in sorted(os.listdir(ESTADO)):
        caminho = os.path.join(ESTADO, nome)
        try:
            with open(caminho, encoding="utf-8") as f:
                st = json.load(f)
        except (OSError, ValueError):
            continue
        vivo = _vivo(st["pid"])
        txt = _trecho_log(st)
        texto = resumo_pipeline(txt, not vivo) + f"\n\n(iniciado em {st.get('inicio', '?')})"
        with con.cursor() as cur:
            if vivo:
                cur.execute("UPDATE FT_SOLICITACOES SET resultado=%s WHERE id=%s AND status='executando'",
                            (texto[:60000], st["sid"]))
            else:
                falhou = "pdf_pipeline terminou" not in txt and "já em execução" not in txt
                status = "erro" if falhou else "executado"
                if falhou:
                    texto = "❌ O pdf_pipeline parou sem a linha de término no log (interrompido ou erro no script).\n" + texto
                cur.execute("UPDATE FT_SOLICITACOES SET status=%s, resultado=%s, executado_em=NOW() WHERE id=%s",
                            (status, texto[:60000], st["sid"]))
        con.commit()
        if not vivo:
            os.remove(caminho)
            print(f"[run_jobs] #{st['sid']} ({st['job']}) terminou", flush=True)


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
    if job in FUNDO:
        return "executando", iniciar_fundo(sid, job, script, params)
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
        texto = (texto or "") + motor_agua(empresas, env) + sem_medicao_agua(empresas, env)
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
    linhas = [f"\n\n🔎 **Regra de pico de consumo (consumo por dia ≥ 1,8× (80% acima) da média das últimas 12 faturas) aplicada: "
              f"{qtd} apontamento(s)** na aba 💧 Água da Análise de Desvio."]
    rs = re.search(r"ressarcimento estimado total: R\$ ([\d,.]+)", out)
    por = re.search(r"apontamentos por empresa:\s*(\{[^}]*\})", out)
    if qtd != "0" and rs:
        valor = rs.group(1).replace(",", "X").replace(".", ",").replace("X", ".")
        linhas.append(f"- Ressarcimento estimado: R$ {valor}")
    if qtd != "0" and por:
        linhas.append(f"- Por empresa: {por.group(1)}")
    return "\n".join(linhas)


def sem_medicao_agua(empresas, env):
    """Regra de COBRANÇA SEM MEDIÇÃO (FA05) — a mesma do agendamento automático (job_agua.sh)."""
    args = [PY, os.path.join(HERE, "jobs", "agua_sem_medicao.py"), "apply"]
    if empresas:
        args += ["--empresas", empresas]
    try:
        p = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=1800, env=env, cwd=os.path.join(HERE, "jobs"))
    except subprocess.TimeoutExpired:
        return "\n\n⚠️ Regra de cobrança sem medição: passou de 30 min e foi interrompida."
    out = (p.stdout or "") + "\n" + (p.stderr or "")
    if p.returncode != 0:
        return f"\n\n⚠️ Regra de cobrança sem medição falhou (código {p.returncode}).\n```\n{out[-800:]}\n```"
    m = re.search(r"OK\.\s*(\d+) inseridos, (\d+) atualizados", out)
    if m:
        return f"\n- Cobrança sem medição (mesmo m³ ≥ 3 meses): {m.group(1)} apontamento(s) novo(s), {m.group(2)} atualizado(s)."
    return "\n- Cobrança sem medição: nada novo."


def main():
    con = conectar()
    try:
        acompanhar(con)
        while True:
            r = pegar(con)
            if not r:
                break
            sid, usuario, acao_json = r
            print(f"[run_jobs] #{sid} ({usuario}) iniciando…", flush=True)
            status, resultado = rodar(sid, usuario, acao_json)
            if status == "executando":  # tarefa longa: segue em segundo plano (acompanhar() fecha depois)
                with con.cursor() as cur:
                    cur.execute("UPDATE FT_SOLICITACOES SET resultado=%s WHERE id=%s", (resultado, sid))
                con.commit()
                print(f"[run_jobs] #{sid} em segundo plano", flush=True)
                continue
            finalizar(con, sid, status, resultado)
            print(f"[run_jobs] #{sid} → {status}", flush=True)
    finally:
        con.close()


if __name__ == "__main__":
    main()
