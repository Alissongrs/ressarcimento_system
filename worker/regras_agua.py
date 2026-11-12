#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
regras_agua.py — pede ao BACKEND para aplicar as regras de água (pico FA02 e cobrança sem medição FA05)
depois do agua_sync. Desde 03/11/2026 os apontamentos de água NÃO nascem mais no worker
(jobs/agua_motor.py e jobs/agua_sem_medicao.py ficaram só como referência): o motor é o do backend,
POST /api/v1/agua/regras/aplicar (header X-Cron-Token = CRON_TOKEN do backend/.env).

O backend grava numa transação e devolve o backup (ids inseridos + linhas antes da atualização);
este script salva em backups/backup_agua_regras_<data>.json (reversível).

Uso: python3 worker/regras_agua.py <dry|apply> [--desde AAAA-MM-DD] [--empresas 4,14]
Não imprime credenciais.
"""
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.environ.get("SURE_REPO") or os.path.dirname(HERE)
ENV = os.environ.get("SURE_ENV") or os.path.join(REPO, "backend", ".env")
API = os.environ.get("SURE_API_BASE", "http://127.0.0.1:8080/api/v1").rstrip("/")


def _token():
    tok = os.environ.get("CRON_TOKEN", "").strip()
    if tok:
        return tok
    try:
        with open(ENV, encoding="utf-8", errors="ignore") as f:
            for ln in f:
                if ln.startswith("CRON_TOKEN"):
                    return ln.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def aplicar(desde="", empresas="", modo="apply"):
    """Chama o backend. Devolve o dict da resposta ou {'erro': '...'}."""
    tok = _token()
    if not tok:
        return {"erro": "CRON_TOKEN ausente no backend/.env — as regras de água não rodaram."}
    corpo = json.dumps({"desde": desde, "empresas": empresas, "modo": modo}).encode("utf-8")
    req = urllib.request.Request(API + "/agua/regras/aplicar", data=corpo, method="POST",
                                 headers={"Content-Type": "application/json", "X-Cron-Token": tok})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            res = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode("utf-8")).get("error", "")
        except Exception:  # noqa: BLE001
            msg = ""
        return {"erro": f"backend respondeu {e.code}: {msg or e.reason}"}
    except Exception as e:  # noqa: BLE001
        return {"erro": f"não consegui falar com o backend ({API}): {e}"}
    bk = res.get("backup") or {}
    if modo == "apply" and (bk.get("ids_inseridos") or bk.get("atualizados_antes")):
        pasta = os.path.join(REPO, "backups")
        os.makedirs(pasta, exist_ok=True)
        nome = os.path.join(pasta, "backup_agua_regras_%s.json" % datetime.datetime.now().strftime("%Y%m%d_%H%M%S"))
        with open(nome, "w", encoding="utf-8") as f:
            json.dump(bk, f, ensure_ascii=False)
        res["arquivo_backup"] = nome
    return res


def _brl(v):
    return "R$ " + f"{v or 0:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def texto_resumo(res):
    """Resumo em markdown para o pedido (tela Tarefas / chat)."""
    if res.get("erro"):
        return f"\n\n⚠️ **Regras de água não rodaram:** {res['erro']}"
    novos = (res.get("pico_novos") or 0) + (res.get("sem_medicao_novos") or 0)
    lin = [f"\n\n🔎 **Regras de água (motor do backend): {novos} apontamento(s) novo(s)** na aba 💧 Água da Análise de Desvio."]
    lin.append(f"- Pico de consumo (por dia ≥ 1,8× a média das últimas 12 faturas): {res.get('pico_novos', 0)}")
    lin.append(f"- Cobrança sem medição (mesmo m³ ≥ 3 meses): {res.get('sem_medicao_novos', 0)} novo(s), "
               f"{res.get('sem_medicao_atualizados', 0)} atualizado(s)")
    if novos:
        lin.append(f"- Ressarcimento estimado dos novos: {_brl(res.get('ressarcimento_novos') or 0)}")
        por = res.get("por_empresa") or {}
        if por:
            lin.append("- Por empresa: " + ", ".join(f"{k}: {v}" for k, v in sorted(por.items(), key=lambda x: -x[1])))
    if res.get("ignorados_rejeitados"):
        lin.append(f"- {res['ignorados_rejeitados']} não voltaram porque já tinham sido rejeitados.")
    if res.get("arquivo_backup"):
        lin.append("- Backup dos apontamentos gravados: " + os.path.basename(res["arquivo_backup"]))
    return "\n".join(lin)


def _arg(nome):
    if nome in sys.argv:
        i = sys.argv.index(nome)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return ""


if __name__ == "__main__":
    modo = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] in ("dry", "apply") else "dry"
    desde = _arg("--desde") or datetime.date.today().isoformat()
    emp = ",".join(re.findall(r"\d+", _arg("--empresas") or ""))
    r = aplicar(desde, emp, modo)
    print(texto_resumo(r).strip())
    sys.exit(1 if r.get("erro") else 0)
