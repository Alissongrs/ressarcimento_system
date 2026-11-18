# -*- coding: utf-8 -*-
"""Confiança por campo (17/11/2026): quantas fontes independentes confirmam cada valor extraído.

O extrator grava o que está impresso; este módulo só anota, campo a campo, quem mais diz o mesmo número:
  extrator    — o valor lido (toda coluna preenchida começa com esta fonte)
  fisica      — a conta da própria fatura fechou: (atual − anterior) × K = consumo; base × alíquota = valor
  itens       — o consumo bate com um item kWh da fatura
  historico   — o consumo do mês bate com a linha do mês no histórico de 13 meses
  dv          — dígito verificador confere (chave da NF3e, CNPJ)
  origem      — o sistema de origem (sgeeasy, Faturas_Registradas_Cache) tem o mesmo valor para a mesma fatura
  anterior    — a fatura anterior da mesma UC na base: leitura anterior de hoje = leitura atual de lá; medidor,
                constante, demanda contratada, modalidade e UC iguais
Fonte que diz OUTRO valor fica registrada em "divergente" — não sobrescreve nada: é matéria da regra do motor.

Resultado em v2_out["_confianca"] = {campo: {"n": nº de fontes, "fontes": [...], "divergente": {fonte: valor}}}
e, compactado, na coluna confianca_json (atualizar_colunas_db). As regras do motor (F01, F39…) apontam forte
em campo com n ≥ 2 e só alertam com n = 1.

Uso avulso:  python confirmacao.py --uid 1894173020260801 fatura.pdf   (lê origem e anterior, só leitura)
"""
from __future__ import annotations

import datetime as dt
import json
import re
import sys
from pathlib import Path

AQUI = Path(__file__).resolve().parent
if str(AQUI) not in sys.path:
    sys.path.insert(0, str(AQUI))

from identificacao import normalizar  # noqa: E402

# coluna da FDE → (coluna da origem, tipo)
CAMPOS_ORIGEM = {
    "leit_ant_ativa_fponta": ("Leitura_Anterior_KWH_FP", "num"), "leit_atu_ativa_fponta": ("Leitura_Atual_KWH_FP", "num"),
    "leit_ant_ativa_ponta": ("Leitura_Anterior_KWH_P", "num"), "leit_atu_ativa_ponta": ("Leitura_Atual_KWH_P", "num"),
    "constante_k": ("Constante_KWH_FP", "num"), "numero_medidor": ("NroMedidor", "ident"),
    "consumo_ativo_ponta_kwh": ("KWH_Ponta", "num"), "consumo_ativo_fponta_kwh": ("KWH_FPonta", "num"),
    "kwh_total": ("KWH_Total", "num"),
    "demanda_contratada_fponta_kw": ("KW_Contratada_FPonta", "num"), "demanda_contratada_ponta_kw": ("KW_Contratada_Ponta", "num"),
    "icms_base_calculo": ("Base_de_Calculo_ICMS", "num"), "icms_aliquota": ("Aliquota_ICMS", "num"), "icms_valor": ("ICMS_RS", "num"),
    "pis_valor": ("PIS_RS", "num"), "cofins_valor": ("COFINS_RS", "num"), "valor_total_fatura": ("RS_Total_Fatura", "num"),
    "data_emissao_nf": ("Dt_Emissao_NF", "data"), "data_vencimento": ("Dt_Venc_NF", "data"), "dias_faturados": ("Qtd_Dias", "num"),
    "codigo_uc": ("UC", "ident"), "chave_nfe": ("Chave_Acesso", "ident"), "modalidade_tarifaria": ("Modalidade_Tarifaria", "modalidade"),
    "mes_referencia": ("Mes_Ref", "data"),
}
COLUNAS_ORIGEM = sorted({c for c, _ in CAMPOS_ORIGEM.values()} | {"UID", "Cod_UC"})

# coluna de hoje → coluna da fatura anterior da mesma UC
CAMPOS_ANTERIOR = {
    "leit_ant_ativa_fponta": "leit_atu_ativa_fponta", "leit_ant_ativa_ponta": "leit_atu_ativa_ponta",
    "numero_medidor": "numero_medidor", "constante_k": "constante_k",
    "demanda_contratada_fponta_kw": "demanda_contratada_fponta_kw", "demanda_contratada_ponta_kw": "demanda_contratada_ponta_kw",
    "modalidade_tarifaria": "modalidade_tarifaria", "codigo_uc": "codigo_uc", "subgrupo_tarifario": "subgrupo_tarifario",
}
TIPO_COL = {"numero_medidor": "ident", "codigo_uc": "ident", "modalidade_tarifaria": "modalidade", "subgrupo_tarifario": "ident"}


# ─── comparação ───────────────────────────────────────────────────────────────
def _num(v):
    if v is None or v == "" or v == "__SET_NULL__":
        return None
    try:
        if isinstance(v, str):
            t = v.strip().lstrip("`'\" ")
            if "," in t:
                t = t.replace(".", "").replace(",", ".")
            return float(t)
        return float(v)
    except (TypeError, ValueError):
        return None


def _ident(v) -> str:
    return re.sub(r"[^0-9A-Z]", "", str(v or "").upper().split(" - ")[0]).lstrip("0")


def _data(v) -> str:
    if v is None or v == "":
        return ""
    if isinstance(v, (dt.date, dt.datetime)):
        return v.strftime("%Y-%m-%d")
    s = str(v)[:10]
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", s)
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else s


def _modalidade(v) -> str:
    n = normalizar(str(v or ""))
    for k in ("azul", "verde", "branca", "convencional"):
        if k in n:
            return k
    return n.strip()


def iguais(campo: str, tipo: str, a, b) -> bool | None:
    """True = mesmo valor, False = valores diferentes, None = um dos lados não tem o dado."""
    if tipo == "num":
        x, y = _num(a), _num(b)
        if x is None or y is None:
            return None
        if campo.startswith(("demanda_contratada", "leit_", "consumo_", "kwh_", "constante")) and (x == 0 or y == 0) and x != y:
            return None  # zero na origem = não informado, não "diferente"
        tol = 0.011 if campo.startswith(("icms", "pis", "cofins", "valor_", "leit_", "dias", "constante")) else max(0.011, 0.002 * abs(y))
        if campo.startswith("constante"):
            tol = 0.0005 * max(abs(y), 1)
        if campo.startswith("leit_") and abs(x - y) > tol and (abs(x - y * 1000) <= 0.6 or abs(x * 1000 - y) <= 0.6):
            return True  # Equatorial imprime 51.358,884 e a origem guarda 51358884
        return abs(x - y) <= tol
    if tipo == "data":
        x, y = _data(a), _data(b)
        if not x or not y:
            return None
        return x[:7] == y[:7] if campo == "mes_referencia" else x == y
    if tipo == "modalidade":
        x, y = _modalidade(a), _modalidade(b)
        return None if not x or not y else x == y
    x, y = _ident(a), _ident(b)
    if not x or not y:
        return None
    return x == y or x.endswith(y) or y.endswith(x)


# ─── dígitos verificadores ────────────────────────────────────────────────────
def dv_chave_nfe(chave) -> bool | None:
    d = re.sub(r"\D", "", str(chave or ""))
    if len(d) != 44:
        return None
    pesos = [2, 3, 4, 5, 6, 7, 8, 9]
    soma = sum(int(c) * pesos[i % 8] for i, c in enumerate(reversed(d[:43])))
    r = soma % 11
    return str(0 if r < 2 else 11 - r) == d[43]


def dv_cnpj(cnpj) -> bool | None:
    d = re.sub(r"\D", "", str(cnpj or ""))
    if len(d) != 14:
        return None
    def dig(base: str, pesos: list[int]) -> str:
        r = sum(int(c) * p for c, p in zip(base, pesos)) % 11
        return str(0 if r < 2 else 11 - r)
    p1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    return dig(d[:12], p1) == d[12] and dig(d[:13], [6] + p1) == d[13]


# ─── fontes externas (só leitura) ─────────────────────────────────────────────
def anterior_por_uid(cur, uid: str) -> dict | None:
    """Fatura anterior da mesma UC na FDE. uid = empresa + código da UC na origem + AAAAMMDD: mesmo prefixo, mesmo
    tamanho, data menor — a mais recente."""
    uid = str(uid or "").strip()
    if len(uid) < 10 or not uid[-8:].isdigit():
        return None
    pref = uid[:-8]
    cols = sorted(set(CAMPOS_ANTERIOR.values()) | {"id", "uid", "mes_referencia"})
    try:
        cur.execute(f"SELECT {', '.join(cols)} FROM FATURA_DADOS_EXTRAIDOS WHERE uid LIKE %s AND LENGTH(uid) = %s AND uid < %s "
                    f"ORDER BY uid DESC LIMIT 1", (pref + "________", len(uid), uid))
        r = cur.fetchone()
    except Exception:
        return None
    if not r:
        return None
    return dict(zip(cols, r)) if not isinstance(r, dict) else r


def anterior_por_uc(cur, cod_empresa, codigo_uc, mes_ref) -> dict | None:
    """Fatura anterior pela UC (dígitos) + empresa, quando o prefixo do uid muda entre meses (Coelba: '1894173…' em
    2024 e '18941730…' em 2026). Usa o índice de cod_empresa; um índice (cod_empresa, codigo_uc, mes_referencia)
    deixa isto instantâneo."""
    dig = re.sub(r"\D", "", str(codigo_uc or "").split(" - ")[0])
    mes = _data(mes_ref)
    if not dig or not mes or not cod_empresa:
        return None
    cols = sorted(set(CAMPOS_ANTERIOR.values()) | {"id", "uid", "mes_referencia"})
    try:
        cur.execute(f"SELECT {', '.join(cols)} FROM FATURA_DADOS_EXTRAIDOS WHERE cod_empresa = %s AND mes_referencia < %s "
                    f"AND REGEXP_REPLACE(SUBSTRING_INDEX(COALESCE(codigo_uc, ''), ' - ', 1), '[^0-9]', '') = %s "
                    f"ORDER BY mes_referencia DESC LIMIT 1", (int(cod_empresa), mes, dig))
        r = cur.fetchone()
    except Exception:
        return None
    if not r:
        return None
    return dict(zip(cols, r)) if not isinstance(r, dict) else r


_ORIGEM_CON = None


def origem_por_uid(uid: str) -> dict | None:
    """Linha da origem (Faturas_Registradas_Cache) pelo UID, só as colunas usadas. Conexão própria, reaproveitada."""
    global _ORIGEM_CON
    uid = str(uid or "").strip()
    if not uid:
        return None
    try:
        import mysql.connector
        from db_env import conexao
        if _ORIGEM_CON is None or not _ORIGEM_CON.is_connected():
            _ORIGEM_CON = mysql.connector.connect(**conexao("DB_FATURAS", "DB_FATURAS_URL"))
        cur = _ORIGEM_CON.cursor(dictionary=True)
        cur.execute(f"SELECT {', '.join(COLUNAS_ORIGEM)} FROM Faturas_Registradas_Cache WHERE UID = %s LIMIT 1", (uid,))
        r = cur.fetchone()
        cur.close()
        return r
    except Exception:
        return None


# ─── confirmação ──────────────────────────────────────────────────────────────
def _hist_mes(v2: dict, mes: str) -> float | None:
    """Consumo do mês de referência na tabela de histórico (13 meses) que o extrator já leu."""
    meses = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"]
    for ln in v2.get("historico_13m_consumo") or []:  # [{"mes": "JAN"|"01", "ano": "2026"|"26", "consumo_kwh": n}]
        if not isinstance(ln, dict):
            continue
        c = _num(ln.get("consumo_kwh"))
        m, a = normalizar(str(ln.get("mes") or "")), re.sub(r"\D", "", str(ln.get("ano") or ""))
        if c is None or not m or not a:
            continue
        mnum = f"{meses.index(m[:3]) + 1:02d}" if m[:3] in meses else (m.zfill(2) if m.isdigit() else "")
        ano = a if len(a) == 4 else "20" + a[-2:]
        if mnum and f"{ano}-{mnum}" == mes[:7]:
            return c
    return None


def confirmar(v2: dict, cols: dict, origem: dict | None = None, anterior: dict | None = None) -> dict:
    conf: dict[str, dict] = {}

    def add(campo: str, fonte: str, ok: bool | None, valor_outro=None):
        if ok is None:
            return
        e = conf.setdefault(campo, {"n": 0, "fontes": [], "divergente": {}})
        if ok:
            if fonte not in e["fontes"]:
                e["fontes"].append(fonte)
                e["n"] = len(e["fontes"])
        else:
            e["divergente"][fonte] = valor_outro if not isinstance(valor_outro, (dt.date, dt.datetime)) else _data(valor_outro)

    for campo, v in cols.items():
        if v not in (None, "", "__SET_NULL__", [], {}) and not campo.startswith("_") and not campo.endswith("_json"):
            add(campo, "extrator", True)

    med = v2.get("_medicao") or {}
    if med.get("validado"):
        for c in ("leit_ant_ativa_fponta", "leit_atu_ativa_fponta", "leit_ant_ativa_ponta", "leit_atu_ativa_ponta",
                  "constante_k", "consumo_ativo_ponta_kwh", "consumo_ativo_fponta_kwh", "kwh_total"):
            if c in conf:
                add(c, "fisica", True)
    for posto, c in (("p", "consumo_ativo_ponta_kwh"), ("fp", "consumo_ativo_fponta_kwh")):
        if (med.get("itens_confirmam") or {}).get(posto) and c in conf:
            add(c, "itens", True)
    tr = v2.get("_tributos") or {}
    for trib, cs in (("icms", ("icms_valor", "icms_base_calculo", "icms_aliquota")), ("pis", ("pis_valor", "pis_aliquota")),
                     ("cofins", ("cofins_valor", "cofins_aliquota"))):
        if (tr.get(trib) or {}).get("fecha"):
            for c in cs:
                if c in conf:
                    add(c, "fisica", True)
        elif tr.get(trib) and tr[trib].get("fecha") is False:
            add(trib + "_valor", "fisica", False, round(tr[trib]["base"] * tr[trib]["aliquota"] / 100, 2))

    mes = _data(cols.get("mes_referencia"))
    if mes and cols.get("consumo_ativo_fponta_kwh") not in (None, ""):
        h = _hist_mes(v2, mes)
        tot = _num(cols.get("kwh_total"))
        fp = _num(cols.get("consumo_ativo_fponta_kwh"))
        if h is not None:
            if tot is not None and abs(h - tot) <= max(0.6, 0.002 * tot):
                add("kwh_total", "historico", True)
            elif fp is not None and abs(h - fp) <= max(0.6, 0.002 * fp):
                add("consumo_ativo_fponta_kwh", "historico", True)
            else:
                add("kwh_total" if tot is not None else "consumo_ativo_fponta_kwh", "historico", False, h)

    ok = dv_chave_nfe(cols.get("chave_nfe"))
    if ok is not None:
        add("chave_nfe", "dv", ok)
    ok = dv_cnpj(cols.get("cnpj_distribuidora_filial"))
    if ok is not None:
        add("cnpj_distribuidora_filial", "dv", ok)

    if origem:
        for campo, (col_o, tipo) in CAMPOS_ORIGEM.items():
            if campo in conf:
                r = iguais(campo, tipo, cols.get(campo), origem.get(col_o))
                add(campo, "origem", r, origem.get(col_o))
    if anterior:
        for campo, col_a in CAMPOS_ANTERIOR.items():
            if campo in conf:
                tipo = TIPO_COL.get(campo, "num")
                r = iguais(campo, tipo, cols.get(campo), anterior.get(col_a))
                add(campo, "anterior", r, anterior.get(col_a))
    return conf


def compactar(conf: dict) -> str:
    """Para a coluna confianca_json: {campo: n} + divergências (só onde há)."""
    out = {"n": {c: e["n"] for c, e in conf.items()},
           "div": {c: e["divergente"] for c, e in conf.items() if e["divergente"]}}
    return json.dumps(out, ensure_ascii=False, default=str)


def aplicar(v2_out: dict, cur=None, uid: str | None = None, origem: dict | None = None) -> dict:
    """Passo 2.68 do pipeline. Nunca levanta exceção; sem banco (goldens) só as fontes internas."""
    try:
        from atualizar_colunas_db import _coleta_campos
        cols = _coleta_campos(v2_out) or {}
        if uid and (not origem or not all(k in origem for k in COLUNAS_ORIGEM)):
            origem = origem_por_uid(uid) or origem
        anterior = anterior_por_uid(cur, uid) if (cur is not None and uid) else None
        if anterior is None and cur is not None:
            emp = cols.get("cod_empresa") or (origem or {}).get("Cod_Empresa") or (uid[:3] if uid and len(uid) >= 14 else None)
            anterior = anterior_por_uc(cur, emp, cols.get("codigo_uc") or (origem or {}).get("UC"), cols.get("mes_referencia"))
        conf = confirmar(v2_out, cols, origem, anterior)
        v2_out["_confianca"] = conf
        v2_out["_confianca_fontes"] = {"origem": bool(origem), "anterior": (anterior or {}).get("uid")}
    except Exception as e:  # pragma: no cover
        v2_out["_confianca"] = {"erro": str(e)[:200]}
    return v2_out


def resumo(conf: dict) -> str:
    n2 = sum(1 for e in conf.values() if isinstance(e, dict) and e.get("n", 0) >= 2)
    n1 = sum(1 for e in conf.values() if isinstance(e, dict) and e.get("n", 0) == 1)
    div = [f"{c}≠{list(e['divergente'].keys())}" for c, e in conf.items() if isinstance(e, dict) and e.get("divergente")]
    return f"confirmados={n2} só_extrator={n1} divergentes={div}"


if __name__ == "__main__":
    print(__doc__)
