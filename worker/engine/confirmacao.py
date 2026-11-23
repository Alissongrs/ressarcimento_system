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
  sefaz       — consulta pública da NF3e pela chave (19/11/2026): número e emissão da nota, total, kWh dos itens.
                Só confirma (nunca sobrescreve); nota cancelada/substituída vira "situacao_nota" divergente
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
TIPO_COL = {"numero_medidor": "ident", "codigo_uc": "ident", "modalidade_tarifaria": "modalidade", "subgrupo_tarifario": "ident",
            "numero_nf": "ident", "data_emissao_nf": "data"}


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


def sefaz_por_chave(chave) -> dict | None:
    """Consulta pública da NF3e (QR code) pela chave com DV válido. Com SKIP_SEFAZ só usa o cache local.
    Devolve None sem chave válida ou se a SEFAZ não respondeu."""
    import os
    if os.environ.get("SURE_SEFAZ_CONFIRMA") == "0":  # testes/gabarito: resultado não pode depender do cache local
        return None
    ch = re.sub(r"\D", "", str(chave or ""))
    if len(ch) != 44 or dv_chave_nfe(ch) is not True:
        return None
    try:
        from consultar_nf3e_sefaz import consultar_nf3e
        d = consultar_nf3e(ch)
    except Exception:
        return None
    return None if (not d or d.get("_erro")) else d


def _liquido_deducoes(s: dict) -> float | None:
    """Total da NF3e tratando TODO item do grupo 5 do cClass como dedução (5904 desconto/devolução, 5905 crédito de
    subvenção…). O líquido do consultar_nf3e só subtrai a compensação GD (5603/5604): na CPFL 553359 ele dá 53.997,40 e
    este, 21.561,10 = total a pagar impresso. Não serve para todas as distribuidoras (em 22 de 368 notas o líquido
    antigo é que bate) — por isso é só mais um candidato na conferência, nunca o total gravado."""
    itens = s.get("itens") or []
    if not itens:
        return None
    return round(sum((it.get("valor_total_numerico") or 0) * (-1 if str(it.get("codigo_cci") or "").startswith("5") else 1)
                     for it in itens), 2)


def _confirmar_sefaz(add, conf: dict, cols: dict, s: dict) -> None:
    """SEFAZ só CONFIRMA: valor igual soma uma fonte; diferente não vira divergência (o total da NF3e é o da operação
    e os itens podem vir agrupados de outro jeito), exceto número da nota e data de emissão, que são da própria NF."""
    if "chave_nfe" in conf:
        add("chave_nfe", "sefaz", True)
    num = re.sub(r"\D", "", str(cols.get("numero_nf") or "")).lstrip("0")
    if num and s.get("numero") and "numero_nf" in conf:
        add("numero_nf", "sefaz", num == str(s["numero"]).lstrip("0"), s["numero"])
    if s.get("data_emissao") and "data_emissao_nf" in conf and _data(cols.get("data_emissao_nf")) == _data(s["data_emissao"]):
        add("data_emissao_nf", "sefaz", True)  # diferente não vira divergência: a impressa pode ser a do dia seguinte
    vt = _num(cols.get("valor_total_fatura"))
    for ref in (s.get("valor_total_liquido_numerico"), s.get("valor_total_bruto_numerico"), _liquido_deducoes(s)):
        if vt is not None and ref is not None and abs(vt - ref) <= 0.011 and "valor_total_fatura" in conf:
            add("valor_total_fatura", "sefaz", True)
            break
    qtds = [it.get("quantidade_numerica") for it in s.get("itens") or []
            if (it.get("unidade_nome") or "").lower().startswith("kwh") and it.get("quantidade_numerica")]
    for c in ("consumo_ativo_fponta_kwh", "consumo_ativo_ponta_kwh", "kwh_total"):
        v = _num(cols.get(c))
        if v and c in conf and any(abs(abs(q) - v) <= max(0.6, 0.002 * v) for q in qtds):
            add(c, "sefaz", True)
    # situação da nota: cancelada/substituída vira divergência visível (a fatura pode não valer)
    sit = s.get("situacao")
    if sit:
        conf["situacao_nota"] = {"n": 1, "fontes": ["sefaz"], "divergente": {} if sit == "autorizada" else {"sefaz": sit}}


def sefaz_valores(s: dict | None) -> dict:
    """Valores da NF3e que SOBRESCREVEM a coluna (usuário, 20/11/2026: a SEFAZ é o valor de confiança — opção 2:
    dados fiscais e medição faturada sim, total a pagar não). Só o que não deixa dúvida: data de emissão e número
    da nota; consumo por posto pelo CCI (0601 TE / 0621 TUSD em kWh; 5º dígito 1 = ponta,
    3 = fora ponta, 0 = único) quando TODAS as quantidades daquele posto são iguais e não há outro posto não-ponta
    (sem somar nada); demanda faturada fora ponta (0621 em kW, posto 3 ou 0) com uma quantidade só. Nunca
    o total a pagar: continua o impresso; diferença vira divergência e manda a fatura para o modelo (fila de confiança)."""
    out: dict = {}
    if not s:
        return out
    # dados fiscais da própria nota: valem os da NF3e (20/11/2026; a impressa diferiu 1 dia em 3 de 24 escaneadas)
    d = _data(s.get("data_emissao"))
    if re.match(r"\d{4}-\d{2}-\d{2}$", d or ""):
        out["data_emissao_nf"] = d
    if s.get("numero"):
        out["numero_nf"] = str(s["numero"]).lstrip("0") or "0"
    energia: dict[str, set] = {}
    demanda: dict[str, set] = {}
    itens = s.get("itens") or []
    # fatura com geração distribuída (CCI 56xx: injetada/compensada): o consumo impresso é a soma de linhas que a
    # NF3e separa (Enel CE: 30 faturado + 234 compensado = 264) — não preenche consumo
    gd = any(str(it.get("codigo_cci") or "")[:2] == "56" for it in itens)
    for it in itens:
        cci = str(it.get("codigo_cci") or "")
        q = it.get("quantidade_numerica")
        if len(cci) < 5 or not q or q <= 0:
            continue
        un0 = (it.get("unidade_nome") or "").strip().lower()
        if cci[:4] in ("0601", "0621") and not (un0.startswith("kwh") or un0 == "kw"
                                                 or str(it.get("unidade_codigo") or "").strip() == "1"):
            # unidade não reconhecida num item de energia/demanda: não dá para saber de que posto/grandeza é
            energia.setdefault(cci[4], set()).add(-1.0)
            continue
        un = (it.get("unidade_nome") or "").strip().lower()
        eh_kw = str(it.get("unidade_codigo") or "").strip() == "1" or un == "kw"
        if cci[:4] in ("0601", "0621") and not eh_kw and un.startswith("kwh"):
            energia.setdefault(cci[4], set()).add(round(float(q), 2))
        elif cci[:4] == "0621" and eh_kw:
            demanda.setdefault(cci[4], set()).add(round(float(q), 2))
    um = {k: next(iter(v)) for k, v in energia.items() if len(v) == 1 and next(iter(v)) > 0}
    if gd:
        um = {}
    nao_ponta = [k for k in energia if k != "1"]
    if "1" in um:
        out["consumo_ativo_ponta_kwh"] = um["1"]
    if nao_ponta == ["3"] and "3" in um:
        out["consumo_ativo_fponta_kwh"] = um["3"]
    elif nao_ponta == ["0"] and "0" in um and "1" not in energia:  # posto único (grupo B): é o consumo e o total
        out["consumo_ativo_fponta_kwh"] = um["0"]
        out["kwh_total"] = um["0"]
    dem = [k for k in demanda if k in ("3", "0")]
    # 22/11/2026: posto único com OUTRO item 0621 em kW é a demanda faturada partida em linhas (Enel SP Verde:
    # 0621000 9,94 "c/ desconto" + 0621100 60,06 "Lei Estadual" = 70 contratada) — não dá para escolher, não grava
    if dem == ["0"] and len(demanda) > 1:
        dem = []
    if len(dem) == 1 and len(demanda[dem[0]]) == 1:
        out["demanda_faturada_fponta_kw"] = next(iter(demanda[dem[0]]))
    return out


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


def confirmar(v2: dict, cols: dict, origem: dict | None = None, anterior: dict | None = None,
              sefaz: dict | None = None) -> dict:
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
    if sefaz:
        _confirmar_sefaz(add, conf, cols, sefaz)
    return conf


def compactar(conf: dict) -> str:
    """Para a coluna confianca_json: {campo: n} + divergências (só onde há)."""
    out = {"n": {c: e["n"] for c, e in conf.items()},
           "div": {c: e["divergente"] for c, e in conf.items() if e["divergente"]}}
    sef = sorted(c for c, e in conf.items() if "sefaz" in (e.get("fontes") or []))
    if sef:
        out["sefaz"] = sef  # campos com o valor da NF3e (fonte oficial): não entram na fila do modelo
    corr = {c: e["corrigido"] for c, e in conf.items() if e.get("corrigido")}
    if corr:
        out["corr"] = corr
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
        sefaz = sefaz_por_chave(cols.get("chave_nfe"))
        conf = confirmar(v2_out, cols, origem, anterior, sefaz)
        # SEFAZ sobrescreve o que traz sem dúvida (atualizar_colunas_db); se o extrator leu OUTRO valor, fica a
        # divergência — campo-chave divergente manda a fatura para o modelo (leitura_visual --fila confianca)
        vazio = (None, "", "__SET_NULL__")
        sv = sefaz_valores(sefaz)
        if sv:
            v2_out["_sefaz_sobrescreve"] = sv
            for k, val in sv.items():
                antes = cols.get(k)
                e = conf.setdefault(k, {"n": 0, "fontes": [], "divergente": {}})
                if "sefaz" not in e["fontes"]:
                    e["fontes"].append("sefaz")
                if antes in vazio or iguais(k, TIPO_COL.get(k, "num"), antes, val):
                    e["n"] = len(e["fontes"])
                else:  # o extrator leu outro valor: vale a SEFAZ (usuário 20/11: "o correto é sefaz, sempre");
                    # a leitura do PDF fica registrada como corrigida, não como divergência (não vai para o modelo)
                    e["fontes"] = ["sefaz"]
                    e["n"] = 1
                    e["corrigido"] = {"extrator": antes}
        # total a pagar impresso × total da NF3e (líquido ou bruto): diferente → divergência (vai para o modelo)
        if sefaz and cols.get("valor_total_fatura") not in vazio and "valor_total_fatura" in conf:
            vt = _num(cols.get("valor_total_fatura"))
            refs = [r for r in (sefaz.get("valor_total_liquido_numerico"), sefaz.get("valor_total_bruto_numerico"),
                                _liquido_deducoes(sefaz)) if r is not None]
            if vt is not None and refs and not any(abs(vt - r) <= 0.011 for r in refs):
                conf["valor_total_fatura"]["divergente"]["sefaz"] = refs[0]
        v2_out["_confianca"] = conf
        v2_out["_confianca_fontes"] = {"origem": bool(origem), "anterior": (anterior or {}).get("uid"),
                                       "sefaz": (sefaz or {}).get("situacao") or bool(sefaz)}
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
