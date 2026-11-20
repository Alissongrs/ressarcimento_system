# -*- coding: utf-8 -*-
"""Gravação SELETIVA do reprocessamento (pdf_pipeline --seletivo), 20/11/2026.

O pipeline tem vários pontos que gravam na mesma fatura (regex v1, motor v3, parsers por layout, espelho da origem)
e o --force regrava tudo — inclusive vazio por cima de valor real que o motor não conseguiu ler (simulação do lote de
500: 146 apagamentos de valor real). Em vez de mexer em cada ponto, a trava fica nas duas pontas da fatura:

    antes = snapshot(cur, uid)          # foto dos campos ANTES de qualquer gravação desta fatura
    ... todas as gravações do pipeline ...
    aplicar(cur, conn, uid, antes)      # compara com a foto e desfaz o que não pode mudar

Regras (decisão do usuário: banco o mais fiel possível; SEFAZ é o valor de confiança; só grava o confirmado):
- vazio → preenchido:  fica se confirmado (n ≥ 2 fontes no confianca_json, ou valor da SEFAZ); senão volta a vazio;
- valor → outro valor: fica se confirmado sem divergência, ou SEFAZ; senão volta o valor antigo;
- valor → vazio:       volta o valor antigo — exceto zero de ponta em fatura sem ponta (0 → vazio é a correção).
Campo sem medição de confiança (fora do confianca_json) conta como não confirmado.

Cada fatura com campo restaurado ou mudado vira uma linha em _backups/seletivo_AAAAMMDD.jsonl
({uid, id, antes, depois, ficou, voltou}) — é o backup para desfazer (desfazer(): grava de volta o "antes").
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path

TBL = lambda: os.environ.get("FDE_TABLE", "FATURA_DADOS_EXTRAIDOS")  # noqa: E731

CAMPOS = ["mes_referencia", "valor_total_fatura", "numero_medidor", "dias_faturados", "leit_ant_ativa_fponta",
          "leit_atu_ativa_fponta", "leit_ant_ativa_ponta", "leit_atu_ativa_ponta", "constante_k",
          "consumo_ativo_fponta_kwh", "consumo_ativo_ponta_kwh", "kwh_total", "icms_valor", "icms_base_calculo",
          "icms_aliquota", "pis_valor", "cofins_valor", "demanda_faturada_fponta_kw", "demanda_faturada_ponta_kw",
          "demanda_contratada_fponta_kw", "demanda_contratada_ponta_kw", "data_vencimento", "data_emissao_nf",
          "numero_nf", "chave_nfe"]  # codigo_uc/numero_instalacao: quem manda é o espelho da origem
PONTA = {"consumo_ativo_ponta_kwh", "leit_ant_ativa_ponta", "leit_atu_ativa_ponta", "demanda_faturada_ponta_kw"}
DIR = Path(__file__).resolve().parent / "_backups"


def _vazio(v) -> bool:
    return v is None or (isinstance(v, str) and v.strip() == "")


def _igual(a, b) -> bool:
    if _vazio(a) and _vazio(b):
        return True
    if _vazio(a) or _vazio(b):
        return False
    try:
        x, y = float(a), float(b)
        return abs(x - y) <= max(0.0011, 1e-6 * abs(y))
    except (TypeError, ValueError):
        return str(a).strip() == str(b).strip()


def _zero(v) -> bool:
    try:
        return float(v) == 0
    except (TypeError, ValueError):
        return False


def _cols(cur) -> list[str]:
    cur.execute(f"SHOW COLUMNS FROM {TBL()}")
    existentes = {(r["Field"] if isinstance(r, dict) else r[0]) for r in cur.fetchall()}
    return [c for c in CAMPOS if c in existentes]


_COLS_CACHE: list[str] | None = None


def snapshot(cur, uid: str | None) -> dict | None:
    """Foto dos campos da fatura antes das gravações. None = fatura nova (nada a proteger)."""
    global _COLS_CACHE
    if not uid:
        return None
    if _COLS_CACHE is None:
        _COLS_CACHE = _cols(cur)
    cur.execute(f"SELECT id, {', '.join('`' + c + '`' for c in _COLS_CACHE)} FROM {TBL()} WHERE uid=%s LIMIT 1", (uid,))
    r = cur.fetchone()
    if not r:
        return None
    if not isinstance(r, dict):
        r = dict(zip(["id"] + _COLS_CACHE, r))
    return dict(r)


def decidir(antes: dict, depois: dict, conf: dict) -> tuple[dict, dict]:
    """(ficou, voltou): campos cuja mudança vale e campos que voltam ao valor antigo {campo: valor_antigo}."""
    n, div, sefaz = conf.get("n") or {}, conf.get("div") or {}, set(conf.get("sefaz") or [])
    ficou, voltou = {}, {}
    for c in antes:
        if c == "id" or c not in depois:
            continue
        a, d = antes[c], depois[c]
        if _igual(a, d):
            continue
        confirmado = c in sefaz or (int(n.get(c) or 0) >= 2 and not div.get(c))
        if _vazio(d):
            ok = c in PONTA and _zero(a)  # 0 de ponta em fatura sem ponta → vazio
        else:
            ok = confirmado
        (ficou if ok else voltou)[c] = d if ok else a
    return ficou, voltou


def aplicar(cur, conn, uid: str | None, antes: dict | None, log=None) -> dict:
    """Compara com a foto e restaura o que não pode mudar. Nunca levanta exceção (a fatura já foi gravada)."""
    if not antes or not uid:
        return {}
    try:
        cols = [c for c in antes if c != "id"]
        cur.execute(f"SELECT {', '.join('`' + c + '`' for c in cols)}, confianca_json FROM {TBL()} WHERE uid=%s LIMIT 1",
                    (uid,))
        r = cur.fetchone()
        if not r:
            return {}
        if not isinstance(r, dict):
            r = dict(zip(cols + ["confianca_json"], r))
        try:
            conf = json.loads(r.get("confianca_json") or "{}")
        except ValueError:
            conf = {}
        depois = {c: r.get(c) for c in cols}
        ficou, voltou = decidir(antes, depois, conf)
        if voltou:
            sets = ", ".join(f"`{c}`=%s" for c in voltou)
            cur.execute(f"UPDATE {TBL()} SET {sets} WHERE uid=%s", (*voltou.values(), uid))
            conn.commit()
        if ficou or voltou:
            DIR.mkdir(exist_ok=True)
            linha = {"uid": uid, "id": antes.get("id"), "em": datetime.now().isoformat(timespec="seconds"),
                     "antes": {c: antes[c] for c in set(ficou) | set(voltou)},
                     "depois": {c: depois[c] for c in set(ficou) | set(voltou)},
                     "ficou": sorted(ficou), "voltou": sorted(voltou)}
            with open(DIR / f"seletivo_{datetime.now():%Y%m%d}.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps(linha, ensure_ascii=False, default=str) + "\n")
        if log:
            log.info(f"  [seletivo] mudou {len(ficou)} campo(s) {sorted(ficou)} | protegeu {len(voltou)} {sorted(voltou)}")
        return {"ficou": ficou, "voltou": voltou}
    except Exception as e:  # noqa: BLE001
        if log:
            log.warning(f"  [seletivo] erro: {e}")
        return {"erro": str(e)[:200]}


def desfazer(cur, conn, arquivo: str) -> int:
    """Desfaz uma rodada: grava de volta o "antes" de cada linha do jsonl (só os campos que ficaram mudados)."""
    n = 0
    for ln in open(arquivo, encoding="utf-8"):
        x = json.loads(ln)
        cols = {c: x["antes"][c] for c in x.get("ficou") or []}
        if cols:
            sets = ", ".join(f"`{c}`=%s" for c in cols)
            cur.execute(f"UPDATE {TBL()} SET {sets} WHERE uid=%s", (*cols.values(), x["uid"]))
            n += 1
    conn.commit()
    return n
