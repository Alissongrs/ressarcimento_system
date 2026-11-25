# -*- coding: utf-8 -*-
"""Gravação SELETIVA do reprocessamento (pdf_pipeline --seletivo), 20/11/2026.

O pipeline tem vários pontos que gravam na mesma fatura (regex v1, motor v3, parsers por layout, espelho da origem)
e o --force regrava tudo — inclusive vazio por cima de valor real que o motor não conseguiu ler (simulação do lote de
500: 146 apagamentos de valor real). Em vez de mexer em cada ponto, a trava fica nas duas pontas da fatura:

    antes = snapshot(cur, uid)          # foto dos campos ANTES de qualquer gravação desta fatura
    ... todas as gravações do pipeline ...
    aplicar(cur, conn, uid, antes)      # compara com a foto e desfaz o que não pode mudar

Regras (decisão do usuário: banco o mais fiel possível; SEFAZ é o valor de confiança):
- vazio → preenchido e valor → outro valor: fica, a menos que o motor DIVIRJA de fonte CONFIÁVEL — a SEFAZ (fora o
  total, cujo parser da SEFAZ ainda erra). Divergência com origem sgeeasy, fatura anterior e histórico fica só
  registrada no confianca_json: na cópia (21/11) foram 14 casos e o motor estava certo nos 14 (origem com leitura
  ×100, kWh em R$/kWh, total 67,72 onde o impresso é 0,00). Valor da SEFAZ fica sempre;
- valor → 0: volta o valor antigo (é apagar), salvo SEFAZ; vazio → 0 é preencher (leitura impressa 0,00) e segue a
  regra geral;
- valor → vazio: o campo fica vazio (decisão do usuário 23/11/2026: o motor novo não leu = não grava valor antigo,
  que pode estar errado — Light 1072 × 10.721 impresso). Só quando o motor rodou (confianca_json preenchido), a
  fatura terminou sem exceção E o PDF tem texto digital (texto_plumber). Fatura escaneada/foto (só OCR): vazio é o
  OCR que não leu, não ausência — Enel SP foto com PIS 895,14 impresso virava vazio; aí o valor antigo volta.
20/11/2026: a 1ª versão exigia 2 fontes concordando para qualquer mudança. Na cópia (68 faturas, conferência visual
dos 29 campos segurados) ela segurou 22 valores certos do motor e salvou 5 errados — os 5 eram erros do motor que
foram corrigidos (demanda em parcelas, leitura de ponta copiada no fora ponta, "4,27 %" lido como total).

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
          "numero_nf", "chave_nfe", "numero_instalacao"]  # codigo_uc: quem manda é o espelho da origem
# 24/11/2026: nº de instalação já preenchido NUNCA muda no reprocessamento — é a chave que agrupa a UC (motor, mês vizinho).
# Na Energisa MT escaneada o OCR leu o telefone "65 9 9999-7974" e o código do cliente "6/3137563-7" como instalação.
NUNCA_TROCA = {"numero_instalacao"}
PONTA = {"consumo_ativo_ponta_kwh", "leit_ant_ativa_ponta", "leit_atu_ativa_ponta", "demanda_faturada_ponta_kw"}
# 0 de contratada veio da origem (sgeeasy grava 0 quando não tem): na cópia (21/11) 8 faturas sem contratada impressa
# tinham 0 e o motor limpava — 0 → vazio é a correção
ZERO_NAO_E_DADO = PONTA | {"demanda_contratada_fponta_kw", "demanda_contratada_ponta_kw"}
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


FONTES_CONFIAVEIS = {"sefaz"}  # origem/anterior/historico: só registro (ver docstring)
SEM_SEFAZ = {"valor_total_fatura"}  # o parser do total da SEFAZ ainda erra (553359, 563246, 609872)


def _diverge(campo: str, d) -> bool:
    """Diverge de fonte confiável? d = {fonte: valor} do confianca_json (formato antigo: qualquer verdade = diverge)."""
    if not d:
        return False
    if not isinstance(d, dict):
        return True
    fontes = {f for f in d if f in FONTES_CONFIAVEIS and not (campo in SEM_SEFAZ and f == "sefaz")}
    return bool(fontes)


def decidir(antes: dict, depois: dict, conf: dict, limpar: bool = True, origem_nv: set | None = None) -> tuple[dict, dict]:
    """(ficou, voltou): campos cuja mudança vale e campos que voltam ao valor antigo {campo: valor_antigo}."""
    n, div, sefaz = conf.get("n") or {}, conf.get("div") or {}, set(conf.get("sefaz") or [])
    ficou, voltou = {}, {}
    for c in antes:
        if c == "id" or c not in depois:
            continue
        a, d = antes[c], depois[c]
        if _igual(a, d):
            continue
        confirmado = c in sefaz or not _diverge(c, div.get(c))
        if c in NUNCA_TROCA and not _vazio(a):
            voltou[c] = a
            continue
        # 24/11/2026: escaneada (limpar=False) — campo que o OCR não leu e o espelho da origem preencheu SEM validar
        # (ORIGEM_NAO_VALIDADO) é "não leu": volta o antigo. Energisa MT 14466811920221201: origem 11.023,44 (medido)
        # por cima do faturado impresso 11.299,026
        if not limpar and origem_nv and c in origem_nv and not _vazio(a):
            voltou[c] = a
            continue
        if _vazio(d):
            # 23/11/2026: vazio vence quando o motor rodou (conf) e a fatura terminou; antes só 0 de ponta/contratada
            ok = (limpar and bool(conf)) or (c in ZERO_NAO_E_DADO and _zero(a))
        elif _zero(d) and not _vazio(a) and not _zero(a) and c not in ("valor_total_fatura",):
            ok = c in sefaz  # valor real → 0 é apagar (Copel A4: 4.898 → 0, 21/11/2026); total 0,00 impresso vale
        else:
            ok = confirmado
        (ficou if ok else voltou)[c] = d if ok else a
    # 24/11/2026: leituras que FECHAVAM a conta da fatura ((atual − anterior) × K ≈ consumo) não trocam por um par
    # que não fecha (Energisa MT A3A 14466623120210201: regex v1 copiou a ponta 33→34 no fora ponta 3.441→3.533,
    # K 1.750, consumo 161.000). Só desfaz troca de valor por valor; vazio segue a regra acima.
    final = {c: (ficou.get(c, voltou.get(c, depois.get(c)))) for c in depois}
    for ca, ct, cc in (("leit_ant_ativa_fponta", "leit_atu_ativa_fponta", "consumo_ativo_fponta_kwh"),
                       ("leit_ant_ativa_ponta", "leit_atu_ativa_ponta", "consumo_ativo_ponta_kwh")):
        if not ({ca, ct} & set(ficou)) or c_vazio_algum(antes, ca, ct) or c_vazio_algum(final, ca, ct):
            continue
        k, cons = _num(final.get("constante_k")) or 1.0, _num(final.get(cc))
        if _fecha(antes[ca], antes[ct], k, cons) and not _fecha(final[ca], final[ct], k, cons):
            for c in (ca, ct):
                if c in ficou:
                    voltou[c] = antes[c]
                    ficou.pop(c)
    # kWh total é a soma dos postos feita ANTES desta decisão: posto que voltou ao antigo leva o total junto
    if {"consumo_ativo_ponta_kwh", "consumo_ativo_fponta_kwh"} & set(voltou) and "kwh_total" in ficou:
        voltou["kwh_total"] = antes["kwh_total"]
        ficou.pop("kwh_total")
    return ficou, voltou


def _num(v):
    try:
        return float(v) if not _vazio(v) else None
    except (TypeError, ValueError):
        return None


def c_vazio_algum(d: dict, *cs) -> bool:
    return any(_vazio(d.get(c)) for c in cs)


def _fecha(ant, atu, k: float, cons) -> bool:
    """(atual − anterior) × K fecha o consumo (até 6% de perda de transformação), sem consumo: só atual ≥ anterior."""
    a, t = _num(ant), _num(atu)
    if a is None or t is None or t < a:
        return False
    if not cons:
        return False
    calc = (t - a) * k
    return calc > 0 and 0.94 <= cons / calc <= 1.07


def aplicar(cur, conn, uid: str | None, antes: dict | None, log=None, limpar: bool = True) -> dict:
    """Compara com a foto e restaura o que não pode mudar. Nunca levanta exceção (a fatura já foi gravada)."""
    if not antes or not uid:
        return {}
    try:
        cols = [c for c in antes if c != "id"]
        cur.execute(f"SELECT {', '.join('`' + c + '`' for c in cols)}, confianca_json, revisar_campos, "
                    f"CHAR_LENGTH(TRIM(COALESCE(texto_plumber, ''))) AS _txt FROM {TBL()} WHERE uid=%s LIMIT 1", (uid,))
        r = cur.fetchone()
        if not r:
            return {}
        if not isinstance(r, dict):
            r = dict(zip(cols + ["confianca_json", "revisar_campos", "_txt"], r))
        try:
            conf = json.loads(r.get("confianca_json") or "{}")
        except ValueError:
            conf = {}
        depois = {c: r.get(c) for c in cols}
        try:
            _flags = (json.loads(r.get("revisar_campos") or "{}") or {}).get("flags") or []
        except (ValueError, AttributeError):
            _flags = []
        origem_nv = {f.get("campo") for f in _flags if isinstance(f, dict) and "NAO_VALIDADO" in str(f.get("status"))}
        ficou, voltou = decidir(antes, depois, conf, limpar and int(r.get("_txt") or 0) > 0, origem_nv)
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
