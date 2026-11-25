"""Combinação de duas leituras OCR da mesma fatura escaneada (v4 = principal, v6 = reserva).

Regra: o valor do v4 nunca é trocado. Um campo que o v4 deixou VAZIO só recebe o valor do v6
quando uma prova independente confirma esse valor (física da medição, conta dos tributos,
datas coerentes). Campo sem prova possível (medidor, demanda, vencimento...) fica vazio.

    combinar(col_v4, col_v6) -> (colunas, aceitos: {campo: motivo}, recusados: {campo: motivo})
"""
from __future__ import annotations

import datetime as _dt

_VAZIO = (None, "", "__SET_NULL__")


def _vazio(v) -> bool:
    return v in _VAZIO


def _num(v):
    if _vazio(v):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _data(v):
    if _vazio(v):
        return None
    try:
        return _dt.date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def _perto(a, b, rel=0.01, abs_=0.05) -> bool:
    return a is not None and b is not None and abs(a - b) <= max(abs_, rel * max(abs(a), abs(b)))


def _aliq(v):
    a = _num(v)
    if a is None or a <= 0:
        return None
    return a / 100 if a > 1 else a


# ---------- provas por campo (recebem a visão combinada m) ----------

def _medicao(m, ant, atu, cons):
    a, b, k, c = _num(m.get(ant)), _num(m.get(atu)), _num(m.get("constante_k")), _num(m.get(cons))
    if None in (a, b, k, c) or b < a or k <= 0 or c <= 0:
        return False
    return _perto((b - a) * k, c, rel=0.01, abs_=1)


def _prova_fp(m):
    return _medicao(m, "leit_ant_ativa_fponta", "leit_atu_ativa_fponta", "consumo_ativo_fponta_kwh")


def _prova_ponta(m):
    return _medicao(m, "leit_ant_ativa_ponta", "leit_atu_ativa_ponta", "consumo_ativo_ponta_kwh")


def _prova_kwh_total(m):
    t, fp, p = _num(m.get("kwh_total")), _num(m.get("consumo_ativo_fponta_kwh")), _num(m.get("consumo_ativo_ponta_kwh"))
    if t is None or fp is None:
        return False
    grupo_a = str(m.get("grupo_tarifario") or "").strip().upper().startswith("A") or \
        str(m.get("modalidade_tarifaria") or "").strip().upper().startswith(_A)
    if p is None and grupo_a:  # grupo A sem ponta lida: total = FP seria só metade da conta
        return False
    return _perto(t, fp + (p or 0), rel=0.005, abs_=1)


def _prova_pis_cofins(m):
    p, c = _num(m.get("pis_valor")), _num(m.get("cofins_valor"))
    if p is None or c is None or p <= 0 or c <= 0:
        return False
    ap, ac = _aliq(m.get("pis_aliquota")), _aliq(m.get("cofins_aliquota"))
    if ap and ac:  # mesma base: PIS/COFINS = alíq PIS / alíq COFINS
        return _perto(p / c, ap / ac, rel=0.02, abs_=0.002)
    return 0.17 <= p / c <= 0.24


def _prova_icms(m):
    v, base, a = _num(m.get("icms_valor")), _num(m.get("icms_base_calculo")), _aliq(m.get("icms_aliquota"))
    if v is None or base is None or a is None or v <= 0:
        return False
    return _perto(base * a, v, rel=0.01, abs_=0.05)


def _prova_dias(m):
    d, a, b = _num(m.get("dias_faturados")), _data(m.get("data_leitura_anterior")), _data(m.get("data_leitura_atual"))
    return d is not None and a and b and int(d) == (b - a).days


def _prova_emissao(m):
    e, la, ve = _data(m.get("data_emissao_nf")), _data(m.get("data_leitura_atual")), _data(m.get("data_vencimento"))
    if not (e and la and ve):
        return False
    return la <= e <= ve and (e - la).days <= 15


_A = ("AZUL", "VERDE")
_B = ("CONVENCIONAL", "BRANCA")


def _prova_grupo(m, fixo):
    """grupo/modalidade só entram se baterem com o subgrupo ou o outro campo vindo do v4 (fixo)."""
    g = str(m.get("grupo_tarifario") or "").strip().upper()[:1]
    sub = str(fixo.get("subgrupo_tarifario") or "").strip().upper()[:1]
    mod = str(fixo.get("modalidade_tarifaria") or "").strip().upper()
    if g not in ("A", "B"):
        return False
    if sub in ("A", "B"):
        return sub == g
    if mod:
        return (g == "A" and mod.startswith(_A)) or (g == "B" and mod.startswith(_B))
    return False


def _prova_modalidade(m, fixo):
    mod = str(m.get("modalidade_tarifaria") or "").strip().upper()
    g = str(fixo.get("grupo_tarifario") or "").strip().upper()[:1] or str(fixo.get("subgrupo_tarifario") or "").strip().upper()[:1]
    return (g == "A" and mod.startswith(_A)) or (g == "B" and mod.startswith(_B))


# campo -> prova; campos fora daqui nunca vêm do v6
PROVAS = {
    "leit_ant_ativa_fponta": _prova_fp, "leit_atu_ativa_fponta": _prova_fp,
    "consumo_ativo_fponta_kwh": _prova_fp, "constante_k": None,  # K: fp ou ponta (abaixo)
    "leit_ant_ativa_ponta": _prova_ponta, "leit_atu_ativa_ponta": _prova_ponta, "consumo_ativo_ponta_kwh": _prova_ponta,
    "kwh_total": _prova_kwh_total,
    "pis_valor": _prova_pis_cofins, "cofins_valor": _prova_pis_cofins,
    "icms_valor": _prova_icms, "icms_base_calculo": _prova_icms, "icms_aliquota": _prova_icms,
    "dias_faturados": _prova_dias,
    "data_emissao_nf": _prova_emissao,
    "grupo_tarifario": "grupo", "modalidade_tarifaria": "modalidade",
}


_FP = {"leit_ant_ativa_fponta", "leit_atu_ativa_fponta", "consumo_ativo_fponta_kwh", "constante_k"}
_PT = {"leit_ant_ativa_ponta", "leit_atu_ativa_ponta", "consumo_ativo_ponta_kwh", "constante_k"}
# campos que se provam juntos (a conta só fecha com todos); fora do grupo, só entra o que já foi aceito
GRUPOS = {c: _FP | (_PT if c == "constante_k" else set()) for c in _FP}
GRUPOS.update({c: _PT | (_FP if c == "constante_k" else set()) for c in _PT if c != "constante_k"})
GRUPOS.update({c: {"pis_valor", "cofins_valor"} for c in ("pis_valor", "cofins_valor")})
GRUPOS.update({c: {"icms_valor", "icms_base_calculo", "icms_aliquota"} for c in ("icms_valor", "icms_base_calculo", "icms_aliquota")})


def _prova(campo, m, fixo):
    p = PROVAS[campo]
    if campo == "constante_k":
        return _prova_fp(m) or _prova_ponta(m)
    if p == "grupo":
        return _prova_grupo(m, fixo)
    if p == "modalidade":
        return _prova_modalidade(m, fixo)
    return p(m)


def combinar(v4: dict, v6: dict):
    v4, v6 = v4 or {}, v6 or {}
    cand = {c for c in PROVAS if _vazio(v4.get(c)) and not _vazio(v6.get(c))}
    aceitos, recusados = {}, {}
    # repete até estabilizar: um campo aceito pode servir de prova a outro (ex.: consumo -> kwh_total)
    while True:
        novo = False
        for c in sorted(cand - set(aceitos)):
            m = dict(v4)
            m.update({k: v6[k] for k in aceitos})
            m[c] = v6[c]
            # campos irmãos ainda vazios no v4 entram na prova junto (leituras + K + consumo se provam em grupo)
            for irmao in (GRUPOS.get(c, set()) & cand) - set(aceitos) - {c}:
                if _vazio(m.get(irmao)):
                    m[irmao] = v6[irmao]
            if _prova(c, m, v4):
                aceitos[c] = "prova"
                novo = True
        if not novo:
            break
    for c in cand - set(aceitos):
        recusados[c] = "sem prova"
    col = dict(v4)
    col.update({c: v6[c] for c in aceitos})
    return col, aceitos, recusados
