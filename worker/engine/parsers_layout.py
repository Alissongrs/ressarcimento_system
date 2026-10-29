#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
parsers_layout.py — parsers de fatura POR LAYOUT, plugáveis no pdf_pipeline.

Filosofia:
  - rotear_layout(texto): identifica o layout/distribuidora pelas âncoras
    (tabela de roteamento dos mapeamento_parsers_faturas(*).md).
  - extrair_medicao_validada(texto): extrai leitura ant/atu, constante K e
    consumo do BLOCO TÉCNICO da fatura (DANF3E e variantes), tentando vários
    padrões e ACEITANDO só onde a fórmula fecha: (atu-ant)*K == consumo.
    Isso conserta o erro recorrente de gravar a linha "Energia Elétrica"
    (líquido após GD) como consumo, em vez do consumo medido.
  - aplicar_parsers(texto): orquestra — devolve {campos canônicos, _layout,
    _validado} pra o pipeline gravar SÓ o que auto-validou.

Tudo determinístico, sem rede. Cruzamento com SEFAZ é feito à parte.
"""
import re

# ── Roteamento por âncoras (quem é o layout) ────────────────────────────────
# (substring no texto -> nome do parser). Ordem importa: mais específico antes.
_ROTAS = [
    ("parser_cemig_mg",            ["CEMIG DISTRIBUIÇÃO", "CEMIG DISTRIBUICAO"]),
    ("parser_light_rj",            ["Light Serviços", "Light Servicos", "LIGHT SERVI"]),
    ("parser_enel_sp",            ["ENEL DISTRIBUIÇÃO SÃO PAULO", "Eletropaulo Metropolitana"]),
    ("parser_enel_rj_ampla",       ["Ampla Energia", "ENEL DISTRIBUIÇÃO RIO"]),
    ("parser_enel_ce",             ["Companhia Energética do Ceará", "Enel Distribuição Ceará"]),
    ("parser_coelba",              ["Neoenergia Coelba", "COELBA"]),
    ("parser_celpe_pe",            ["Neoenergia Pernambuco", "CELPE"]),
    ("parser_elektro_sp",          ["ELEKTRO", "GBELEKTRO", "Elektro Redes"]),
    ("parser_cosern_rn",           ["COSERN", "Neoenergia Cosern"]),
    ("parser_equatorial_pa",       ["Equatorial Pará", "Equatorial Para"]),
    ("parser_equatorial_go",       ["Equatorial Goiás", "Equatorial Goias", "ENEL GOIAS"]),
    ("parser_equatorial_pi",       ["EQUATORIAL PIAUI", "Equatorial Piauí"]),
    ("parser_copel_pr",            ["COPEL", "Copel Distribui"]),
    ("parser_elektro_sp",          ["ELEKTRO", "GBELEKTRO"]),
    ("parser_edp_sp",              ["EDP SÃO PAULO", "EDP SP DISTRIB", "02.302.100/0001"]),
    ("parser_edp_es",              ["EDP ES DISTRIB", "EDP ESPÍRITO", "EDP ESPIRITO", "28.152.650/0001"]),
    ("parser_cpfl",                ["CPFL"]),
    ("parser_energisa_ms",         ["ENERGISA MATO GROSSO DO SUL"]),
    ("parser_energisa",            ["ENERGISA"]),
    ("parser_ceb_df",              ["CEB DISTRIBUIÇÃO", "CEB DISTRIBUICAO"]),
    ("parser_cemig_santa_cruz",    ["Companhia Luz e Força Santa Cruz", "CPFL Santa Cruz"]),
    ("parser_celesc",              ["Celesc", "CELESC"]),
]

def rotear_layout(texto: str) -> str:
    up = (texto or "").upper()
    for nome, ancoras in _ROTAS:
        for a in ancoras:
            if a.upper() in up:
                return nome
    return "desconhecido"


# ── Util números BR ─────────────────────────────────────────────────────────
def _br(s):
    s = (s or "").strip().replace(".", "").replace(",", ".")
    try: return float(s)
    except: return None

def _parse_k(s):
    """Constante do medidor. Trata os 3 formatos: '0,015' (BR), '.024' (ponto
    decimal, Copel), '40'/'80' (inteiro). _br normal quebraria '.024' -> 24."""
    s = (s or "").strip()
    if not s: return 1.0
    if "," in s: return _br(s)                       # 0,015 / 40,00000
    if s.startswith("."):
        try: return float("0" + s)                   # .024 -> 0.024
        except: return 1.0
    try: return float(s)                             # 40, 80, .  (ponto decimal US)
    except: return _br(s) or 1.0


# ── Extrator de medição AUTO-VALIDADO (genérico DANF3E + variantes) ─────────
# Cada padrão captura: (posto?, medidor?, leit_ant, leit_atu, K, consumo) em
# alguma ordem. Após o match, só aceita se (atu-ant)*K bate com o consumo.
_PADROES_MEDICAO = [
    # CEMIG NF3e: 'Energia [Ponta|Fora Ponta] kWh <MED> <ant> <atu> <K> <cons>'
    dict(rx=re.compile(r"Energia(?:\s+(Ponta|Fora\s+Ponta|Reservado))?\s+kWh\s+([A-Z]{1,5}\d{5,})\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+([\d.]+)", re.I),
         g=dict(posto=1, med=2, ant=3, atu=4, k=5, cons=6)),
    # Variante sem medidor na linha: '... <ant> <atu> <K> <cons>'
    dict(rx=re.compile(r"(?:Energia|Consumo)(?:\s+(Ponta|Fora\s+Ponta|Reservado))?\s+kWh\s+([\d.]+)\s+([\d.]+)\s+(\d{1,4})\s+([\d.]+)", re.I),
         g=dict(posto=1, ant=2, atu=3, k=4, cons=5)),
    # Equatorial: '<MED> CONSUMO NA <posto> <POSTO> <ant> <atu> <const decimal> <consumo>'
    # consumo = (atu-ant)*const*1,025 (perda) — validado por _aceita
    dict(rx=re.compile(r"([\w.\-]+)\s+CONSUMO NA (?:PONTA|FORA\s+PONTA|RESERVAD\w*)\s+(PONTA|FORA\s+PONTA|FP|RESERVAD\w*)?\s*(\d+)\s+(\d+)\s+([\d,]+)\s+([\d.,]+)", re.I),
         g=dict(med=1, posto=2, ant=3, atu=4, k=5, cons=6)),
    # Copel: 'CONSUMO kWh (PT|FP|TP) <ant> <atu> <K> <cons>' (K tipo '.024'); perda 2,5%
    dict(rx=re.compile(r"CONSUMO\s+kWh\s+(PT|FP|TP)\s+(\d+)\s+(\d+)\s+(\.?\d+)\s+(\d+)\b", re.I),
         g=dict(posto=1, ant=2, atu=3, k=4, cons=5)),
    # DMED / EDP-ES estilo: '<MED> Energia Ativa-kWh (Ponta|Fora Ponta) <ant> <atu> <K> <cons>'
    dict(rx=re.compile(r"Energia\s+Ativa-?\s*kWh\s+(Ponta|Fora\s+Ponta|Reservad\w*)\s+([\d.,]+)\s+([\d.,]+)\s+([\d,]+)\s+(\d+)\b", re.I),
         g=dict(posto=1, ant=2, atu=3, k=4, cons=5)),
    # NOTA: Equatorial PA/PI ('Consumo <MED> <atu> <ant> <const> <NPL> <medido> <fat>')
    # NÃO entra aqui: o PDF traz 2 faturas (2 meses) → precisa parser MÊS-AWARE
    # (casar o bloco com a mes_referencia da fatura). Pendente.
]

def _aceita(ant, atu, k, cons):
    if None in (ant, atu, cons): return False
    kk = k if (k and k > 0) else 1.0
    calc = abs(atu - ant) * kk
    tol = max(1.0, cons * 0.002)
    # aceita sem perda OU com perda de transformação 2,5% (Equatorial etc.)
    return abs(calc - cons) <= tol or abs(calc * 1.025 - cons) <= tol

def extrair_medicao_validada(texto: str) -> dict:
    """Retorna {postos:[{posto,medidor,ant,atu,k,consumo}], _validado:bool, _padrao:int}.
    Só popula se ALGUM padrão casar E a fórmula fechar em todos os postos."""
    texto = texto or ""
    for idx, p in enumerate(_PADROES_MEDICAO):
        postos = {}
        for m in p["rx"].finditer(texto):
            g = p["g"]
            ant = _br(m.group(g["ant"])); atu = _br(m.group(g["atu"]))
            k = _parse_k(m.group(g["k"])) if g.get("k") and m.group(g["k"]) else 1
            cons = _br(m.group(g["cons"]))
            if not _aceita(ant, atu, k, cons):
                continue  # mantém só postos cuja fórmula fecha (cada um é prova matemática)
            pr = ((m.group(g["posto"]) or "") if g.get("posto") else "").lower().strip()
            if "reserv" in pr:        seg = "reservado"
            elif "fora" in pr or pr == "fp": seg = "fponta"
            elif pr in ("ponta", "pt"): seg = "ponta"
            else:                      seg = "fponta"
            postos[seg] = dict(posto=seg, medidor=(m.group(g["med"]) if g.get("med") else None),
                               ant=ant, atu=atu, k=k, consumo=cons)
        if postos:
            return {"postos": list(postos.values()), "_validado": True, "_padrao": idx}
    return {"postos": [], "_validado": False, "_padrao": None}


# ── Coelba (Grupo B): consumo direto, validado por TE==TUSD ─────────────────
_RX_COELBA_TE   = re.compile(r"Consumo Ativo\(kWh\)\s*-\s*TE\s+([\d.]+)", re.I)
_RX_COELBA_TUSD = re.compile(r"Consumo Ativo\(kWh\)\s*-\s*TUSD\s+([\d.]+)", re.I)

# Coelba layout leitura-based: 'Leitu atual <atu> ... Medidor kWh/Constante <med> <k>'
# / 'Leitura anterior <ant>' / 'Consumo medido em kWh <c>'. (atu-ant)*k == c.
_RX_COE_ATU   = re.compile(r"Leit\w*\s+atual\s+(\d+)", re.I)
_RX_COE_ANT   = re.compile(r"Leitura\s+anterior\s+(\d+)", re.I)
_RX_COE_CONSM = re.compile(r"Consumo medido em kWh\s+(\d+)", re.I)
_RX_COE_K     = re.compile(r"Medidor kWh/Constante\s+(\d+)\s+(\d+)", re.I)
# Neoenergia Coelba/PE B3 (NF3e): 'Consumo-TUSD kWh <q>' == 'Consumo-TE kWh <q>'
_RX_COE_TUSD2 = re.compile(r"Consumo\s*-\s*TUSD\s+kWh\s+([\d.,]+)", re.I)
_RX_COE_TE2   = re.compile(r"Consumo\s*-\s*TE\s+kWh\s+([\d.,]+)", re.I)
# Coelba A4 ponta/fponta: 'Consumo-TUSD NPonta/F.Ponta kWh <q>' == 'Consumo-TE Na Ponta/F.Ponta kWh <q>'
_RX_COE_POSTO = re.compile(
    r"Consumo\s*-\s*(TUSD|TE)\s+(N\.?\s*Ponta|Na\s+Ponta|F\.?\s*Ponta|Fora\s+Ponta)\s+kWh\s+([\d.,]+)", re.I)
# Coelba B3 'Energia Ativa Único <leit_ant> <leit_atu> <const> <consumo>' (leitura×K)
_RX_COE_UNICO = re.compile(r"Energia Ativa [ÚU]nico\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)", re.I)
# Coelba legado: 'CONSUMO (PONTA|FORA PONTA|RESERVADO) <palavra>? <q> KWH X <tarifa> <valor>'
# validado por q × tarifa == valor (sem leitura nesse layout antigo).
_RX_COE_LEG = re.compile(
    r"CONSUMO\s+(FORA\s+PONTA|PONTA|RESERVAD\w*)\s+(?:[A-ZÁÉÍÓÚ]+\s+)?(\d[\d.]*)\s+KWH\s+X\s+([\d.,]+)\s+([\d.,]+)", re.I)

def parse_coelba_legado(texto: str) -> dict:
    postos = {}
    for m in _RX_COE_LEG.finditer(texto or ""):
        p = m.group(1).lower(); q = _br(m.group(2)); tar = _br(m.group(3)); val = _br(m.group(4))
        if None in (q, tar, val) or q <= 0 or abs(q * tar - val) > max(1.0, val * 0.01):
            continue
        seg = "reservado" if "reserv" in p else ("fponta" if "fora" in p else "ponta")
        postos[seg] = dict(posto=seg, medidor=None, ant=None, atu=None, k=None, consumo=q)
    if not postos:
        return {"postos": [], "_validado": False}
    if set(postos) == {"ponta"}:               # B legado single-posto → trata como consumo único
        p = postos.pop("ponta"); p["posto"] = "fponta"; postos["fponta"] = p
    return {"postos": list(postos.values()), "_validado": True}
# Coelba A4 horo: 'Consumo Ativo (Na Ponta|Fora [de ]Ponta)(kWh)-(TUSD|TE) <q>'
_RX_COE_A4    = re.compile(r"Consumo Ativo (Na Ponta|Fora (?:de )?Ponta)\(kWh\)\s*-\s*(TUSD|TE)\s+([\d.,]+)", re.I)
# Coelba A4 Livre (mercado livre): consumo medido em '<med> Energia Ativa (Ponta|Fora Ponta)
# <leit> <leit> <const> <CONSUMO>'; validado por 'Uso Sistema Encar.NP/FP = consumo × 1,025'.
_RX_COE_EA       = re.compile(r"Energia Ativa (Fora Ponta|Ponta)\s+[\d.,]+\s+[\d.,]+\s+[\d.,]+\s+([\d.,]+)", re.I)
_RX_COE_ENCAR_NP = re.compile(r"Uso Sistema Encar\.?\s*NP\s+kWh\s+([\d.,]+)", re.I)
_RX_COE_ENCAR_FP = re.compile(r"Uso Sistema Encar\.?\s*FP\s+kWh\s+([\d.,]+)", re.I)

def parse_coelba_a4_livre(texto: str) -> dict:
    t = texto or ""
    if "Uso Sistema Encar" not in t:
        return {"postos": [], "_validado": False}
    ea = {}
    for mm in _RX_COE_EA.finditer(t):
        seg = "ponta" if mm.group(1).strip().lower() == "ponta" else "fponta"
        if seg not in ea:                       # 1ª ocorrência = consumo medido
            ea[seg] = _br(mm.group(2))
    postos = []
    for seg, rx in (("ponta", _RX_COE_ENCAR_NP), ("fponta", _RX_COE_ENCAR_FP)):
        cons = ea.get(seg); mu = rx.search(t)
        if cons and cons > 0 and mu:
            q = _br(mu.group(1))                # uso sistema encargo = consumo × 1,025 (perda) ou × 1,0
            if q and (abs(cons * 1.025 - q) <= max(1.0, q * 0.01) or abs(cons - q) <= max(1.0, q * 0.01)):
                postos.append(dict(posto=seg, medidor=None, ant=None, atu=None, k=None, consumo=cons))
    return {"postos": postos, "_validado": bool(postos)}

def parse_coelba(texto: str) -> dict:
    t = texto or ""
    # 0) A4 horo-sazonal: ponta + fora ponta, validados por TUSD==TE em cada posto
    a4 = {}
    for mm in _RX_COE_A4.finditer(t):
        seg = "ponta" if "na ponta" in mm.group(1).lower() else "fponta"
        d = a4.setdefault(seg, {}); key = mm.group(2).upper()
        if key not in d:                       # 1ª ocorrência = consumo (a 2ª é a tarifa)
            d[key] = _br(mm.group(3))
    postos_a4 = []
    for seg, d in a4.items():
        q = d.get("TUSD")
        if q and q > 0 and "TE" in d and abs(q - (d["TE"] or 0)) <= max(1.0, q * 0.01):
            postos_a4.append(dict(posto=seg, medidor=None, ant=None, atu=None, k=None, consumo=q))
    if postos_a4:
        return {"postos": postos_a4, "_validado": True}
    # 0b) A4 Livre (Uso Sistema Fio/Encargo) — consumo medido validado por Encar = cons×1,025
    liv = parse_coelba_a4_livre(t)
    if liv["_validado"]:
        return liv
    # 0c) A4 ponta/fponta: 'Consumo-TUSD NPonta/F.Ponta' == 'Consumo-TE Na Ponta/F.Ponta'
    ps = {}
    for mm in _RX_COE_POSTO.finditer(t):
        g2 = mm.group(2).lower()
        seg = "fponta" if g2.startswith("f") or "fora" in g2 else "ponta"
        d = ps.setdefault(seg, {}); key = mm.group(1).upper()
        if key not in d:
            d[key] = _br(mm.group(3))
    postos_ps = []
    for seg, d in ps.items():
        q = d.get("TUSD")
        if q and q > 0 and "TE" in d and abs(q - (d["TE"] or 0)) <= max(1.0, q * 0.01):
            postos_ps.append(dict(posto=seg, medidor=None, ant=None, atu=None, k=None, consumo=q))
    if postos_ps:
        return {"postos": postos_ps, "_validado": True}
    # 0d) 'Energia Ativa Único <ant> <atu> <const> <cons>' (leitura×K, ×1 ou ×1,025)
    mu = _RX_COE_UNICO.search(t)
    if mu:
        ant, atu, k, cons = _br(mu.group(1)), _br(mu.group(2)), _parse_k(mu.group(3)), _br(mu.group(4))
        if None not in (ant, atu, cons) and cons > 0 and atu >= ant and k and \
           (abs((atu - ant) * k - cons) <= max(1.0, cons * 0.01) or abs((atu - ant) * k * 1.025 - cons) <= max(1.0, cons * 0.01)):
            return {"postos": [dict(posto="fponta", medidor=None, ant=ant, atu=atu, k=k, consumo=cons)],
                    "_validado": True}
    # 0e) legado 'CONSUMO PONTA <q> KWH X <tarifa> <valor>' (q×tarifa==valor)
    leg = parse_coelba_legado(t)
    if leg["_validado"]:
        return leg
    # 1) TE==TUSD direto (2 formatos: 'Consumo Ativo(kWh)-TE/TUSD' e 'Consumo-TE/TUSD kWh')
    for rx_te, rx_tu in ((_RX_COELBA_TE, _RX_COELBA_TUSD), (_RX_COE_TE2, _RX_COE_TUSD2)):
        te = rx_te.search(t); tu = rx_tu.search(t)
        if te and tu:
            q_te, q_tu = _br(te.group(1)), _br(tu.group(1))
            if q_te is not None and q_te > 0 and abs(q_te - (q_tu or 0)) <= max(0.5, q_te * 0.005):
                return {"postos": [dict(posto="fponta", medidor=None, ant=None, atu=None, k=None, consumo=q_te)],
                        "_validado": True}
    # 2) leitura: Leitu atual/anterior + Consumo medido em kWh
    ma, mb, mc = _RX_COE_ATU.search(t), _RX_COE_ANT.search(t), _RX_COE_CONSM.search(t)
    if ma and mb and mc:
        atu, ant, cons = _br(ma.group(1)), _br(mb.group(1)), _br(mc.group(1))
        mk = _RX_COE_K.search(t); k = _parse_k(mk.group(2)) if mk else 1.0
        if None not in (atu, ant, cons) and cons > 0 and atu >= ant and \
           abs((atu - ant) * k - cons) <= max(1.0, cons * 0.01):
            med = mk.group(1) if mk else None
            return {"postos": [dict(posto="fponta", medidor=med, ant=ant, atu=atu,
                                    k=(k if k != 1 else None), consumo=cons)], "_validado": True}
    return {"postos": [], "_validado": False}


# Equatorial (NF3e moderna PA/PI/MA/AL/TO/MinasRio): bloco
# 'Consumo <medidor> <leit_atu> <leit_ant> <const> <npl> <cons_medido> <cons_fat>'.
# O PDF traz 2 faturas (mês atual + anterior) → escolhe o bloco de MAIOR leit_atual
# (= mês corrente). Cada bloco é provado por (atu-ant)*const == cons_medido.
_RX_EQ_CONS = re.compile(
    r"Consumo\s+([A-Z]?\d[\w.\-]*)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+\d+\s+(\d+)\s+(\d+)", re.I)
def parse_equatorial_consumo(texto: str) -> dict:
    melhor = None
    for m in _RX_EQ_CONS.finditer(texto or ""):
        atu, ant, cons = _br(m.group(2)), _br(m.group(3)), _br(m.group(5))
        k = _parse_k(m.group(4))
        if None in (atu, ant, cons) or cons <= 0 or atu < ant:
            continue
        calc = (atu - ant) * k
        if abs(calc - cons) > max(1.0, cons * 0.01) and abs(calc * 1.025 - cons) > max(1.0, cons * 0.01):
            continue
        if melhor is None or atu > melhor["atu"]:        # mês corrente = maior leitura atual
            melhor = dict(posto="fponta", medidor=m.group(1), ant=ant, atu=atu,
                          k=(k if k != 1 else None), consumo=cons)
    return {"postos": [melhor], "_validado": True} if melhor else {"postos": [], "_validado": False}


# ── Enel SP (DANF3E CCI): consumo direto 0601 ENERGIA (TE), validado por TUSD ─
_RX_ENELSP_TE   = re.compile(r"0601\s+ENERGIA\s*\(TE\)\s+([\d.,]+)", re.I)
_RX_ENELSP_TUSD = re.compile(r"0605\s+USO\s+SIST[^\n]*?\(TUSD\)\s+([\d.,]+)", re.I)
# Variante SEM código CCI: 'ENERGIA (TE) KWH <q>' / 'USO SIST. DISTR. (TUSD) KWH <q>'
# (maior sub-layout Enel SP não-coberto, ~4.5k). consumo = q, validado por TE==TUSD.
_RX_ENELSP_TE2   = re.compile(r"ENERGIA\s*\(TE\)\s+KWH\s+([\d.,]+)", re.I)
_RX_ENELSP_TUSD2 = re.compile(r"USO\s+SIST[^\n(]*\(TUSD\)\s+KWH\s+([\d.,]+)", re.I)

# Enel SP A4 (Grupo A): 'CONSUMO PONTA AM <ant> <atu> <cons>',
# 'CONSUMO FORA PONTA INDUTIVO AM ...' E 'CONSUMO FORA PONTA CAPACIT. AM ...'.
# Sem K na linha; valida por K consistente entre os postos. FORA PONTA = INDUTIVO +
# CAPACIT (ambos são energia ATIVA fora-ponta; soma bate com 'CONSUMO ATIVO F.PONTA TUSD').
_RX_ENELSP_A4 = re.compile(
    r"CONSUMO\s+(PONTA|FORA\s+PONTA\s+(?:INDUTIVO|CAPACIT\.?))\s+AM\s+([\d.]+)\s+([\d.]+)\s+([\d.,]+)", re.I)

def parse_enel_sp_a4(texto: str) -> dict:
    cand = []
    for mm in _RX_ENELSP_A4.finditer(texto or ""):
        seg = "ponta" if mm.group(1).upper().startswith("PONTA") else "fponta"
        ant, atu, cons = _br(mm.group(2)), _br(mm.group(3)), _br(mm.group(4))
        if ant is None or atu is None or cons is None or atu <= ant or cons <= 0:
            continue
        cand.append((seg, ant, atu, cons, cons / (atu - ant)))   # K derivado
    if not cand:
        return {"postos": [], "_validado": False}
    ks = [k for *_, k in cand]
    kbase = ks[0]
    if not all(abs(k - kbase) <= max(1e-4, kbase * 0.02) for k in ks):  # K consistente entre postos
        return {"postos": [], "_validado": False}
    agg = {}; leit = {}
    for seg, ant, atu, cons, k in cand:
        agg[seg] = agg.get(seg, 0.0) + cons                       # soma postos do mesmo seg (FP = indutivo+capacit)
        if seg not in leit or atu > leit[seg][1]:                 # guarda a maior leitura do seg
            leit[seg] = (ant, atu)
    postos = []
    for seg, cons in agg.items():
        ant, atu = leit[seg]
        postos.append(dict(posto=seg, medidor=None, ant=ant, atu=atu, k=round(kbase, 5), consumo=round(cons, 2)))
    return {"postos": postos, "_validado": True}

# Enel SP / Eletropaulo Grupo A (ACL e cativo): linhas de medição
# '<med> ENRG ATV [F ]PONTA[ INDUTIV] <ant> <atu> <K> <consumo>'. Cada linha é
# provada por (atu-ant)*K==consumo; soma dos postos é validada contra os totais
# impressos 'CONSUMO ATIVO PONTA/F. PONTA TUSD KWH <q>' quando presentes.
_RX_ENRG_ATV = re.compile(
    r"ENRG\s+ATV\s+(F\s+PONTA\s+INDUTIV\w*|F\s+PONTA|PONTA)\s+([\d.]+)\s+([\d.]+)\s+([\d,]+)\s+([\d.,]+)", re.I)
_RX_CA_P  = re.compile(r"CONSUMO ATIVO PONTA TUSD\s+(?:KWH\s+)?([\d.,]+)", re.I)
_RX_CA_FP = re.compile(r"CONSUMO ATIVO F\.?\s*PONTA TUSD\s+(?:KWH\s+)?([\d.,]+)", re.I)
# Formato B (Eletropaulo legado): 'CONSUMO [FORA ]PONTA[ CAPACIT/INDUTIVO] VD <ant> <atu> <registrado>'
# sem K impresso (registrado já = (atu-ant)*K). fponta = CAPACIT + INDUTIVO.
_RX_CONS_VD = re.compile(
    r"CONSUMO\s+(FORA\s+PONTA\s+CAPACIT\.?|FORA\s+PONTA\s+INDUTIVO|PONTA)\s+VD\s+([\d.]+)\s+([\d.]+)\s+([\d.,]+)", re.I)

def parse_enel_sp_grupo_a(texto: str) -> dict:
    t = texto or ""
    # formato A: 'ENRG ATV ... <K> <consumo>' — cada linha provada por leitura×K
    grpA = {"ponta": [], "fponta": []}
    for m in _RX_ENRG_ATV.finditer(t):
        ant, atu, k, cons = _br(m.group(2)), _br(m.group(3)), _parse_k(m.group(4)), _br(m.group(5))
        if None in (ant, atu, cons) or not k or atu < ant or cons <= 0:
            continue
        if abs((atu - ant) * k - cons) > max(1.0, cons * 0.01):
            continue
        seg = "ponta" if m.group(1).upper().strip() == "PONTA" else "fponta"
        grpA[seg].append((ant, atu, k, cons))
    # formato B: 'CONSUMO ... VD <ant> <atu> <registrado>' — sem K impresso
    grpB = {"ponta": [], "fponta": []}
    for m in _RX_CONS_VD.finditer(t):
        ant, atu, reg = _br(m.group(2)), _br(m.group(3)), _br(m.group(4))
        if None in (ant, atu, reg) or atu <= ant or reg <= 0:
            continue
        seg = "ponta" if m.group(1).upper().strip() == "PONTA" else "fponta"
        grpB[seg].append((ant, atu, round(reg / (atu - ant), 5), reg))
    grp = grpA if (grpA["ponta"] or grpA["fponta"]) else grpB
    formato_b = grp is grpB
    if not grp["ponta"] and not grp["fponta"]:
        return {"postos": [], "_validado": False}
    postos = []
    for seg, rx in (("ponta", _RX_CA_P), ("fponta", _RX_CA_FP)):
        if not grp[seg]:
            continue
        soma = sum(c for *_, c in grp[seg])
        mt = rx.search(t)
        tot = _br(mt.group(1)) if mt else None
        if formato_b:
            # sem K impresso → EXIGE o total impresso pra provar a soma
            if tot is None or abs(soma - tot) > max(1.0, tot * 0.01):
                continue
        elif tot is not None and abs(soma - tot) > max(1.0, tot * 0.01):
            continue                            # formato A: total é cross-check
        a0 = grp[seg][0]
        postos.append(dict(posto=seg, medidor=None, ant=a0[0], atu=a0[1], k=a0[2], consumo=round(soma, 3)))
    return {"postos": postos, "_validado": bool(postos)}

def parse_enel_sp(texto: str) -> dict:
    # tenta A4 (leitura+K consistente) primeiro — é a prova mais forte
    a4 = parse_enel_sp_a4(texto)
    if a4["_validado"]:
        return a4
    ga = parse_enel_sp_grupo_a(texto)           # Grupo A ACL/cativo (ENRG ATV leitura×K)
    if ga["_validado"]:
        return ga
    # tenta CCI numérico (0601/0605); se não, a variante '(TE/TUSD) KWH <q>'
    for rx_te, rx_tu in ((_RX_ENELSP_TE, _RX_ENELSP_TUSD), (_RX_ENELSP_TE2, _RX_ENELSP_TUSD2)):
        te = rx_te.search(texto or ""); tu = rx_tu.search(texto or "")
        if not te or not tu:
            continue
        q_te, q_tu = _br(te.group(1)), _br(tu.group(1))
        if q_te is None or q_te <= 0 or abs(q_te - (q_tu or 0)) > 0.5:
            continue
        return {"postos": [dict(posto="fponta", medidor=None, ant=None, atu=None, k=None, consumo=q_te)],
                "_validado": True}
    # TE limpo ('0601 ENERGIA (TE) <q>') + TUSD com OCR garble: valida q contra o
    # header 'Consumo do mês (kWh) <q>' (mesma quantidade).
    te = _RX_ENELSP_TE.search(texto or "")
    if te:
        q_te = _br(te.group(1))
        hh = re.search(r"Consumo\s+do[^\(]*\(kWh\)\s*([\d.,]+)", texto or "", re.I)
        q_h = _us(hh.group(1)) if hh else None
        if q_te and q_te > 0 and q_h and abs(q_te - q_h) <= max(1.0, q_te * 0.01):
            return {"postos": [dict(posto="fponta", medidor=None, ant=None, atu=None, k=None, consumo=q_te)],
                    "_validado": True}
    return {"postos": [], "_validado": False}


# ── Elektro (Grupo B): consumo de 'CONSUMO TE/TUSD', CRUZADO com a leitura ───
# 'CONSUMO <ant> <atu>'. Valida que consumo/(atu-ant) é uma constante limpa
# (inteira, ou com perda 2,5%). Não depende só de TE==TUSD.
def parse_elektro(texto: str) -> dict:
    texto = texto or ""
    te = re.search(r"CONSUMO\s+TE\s+(?:kWh\s+)?([\d.,]+)", texto, re.I)
    tu = re.search(r"CONSUMO\s+TUSD\s+(?:kWh\s+)?([\d.,]+)", texto, re.I)
    if not te or not tu: return {"postos": [], "_validado": False}
    q1, q2 = _br(te.group(1)), _br(tu.group(1))
    if q1 is None or q1 <= 0 or abs(q1 - (q2 or 0)) > 0.5:   # TE deve bater com TUSD
        return {"postos": [], "_validado": False}
    ant = atu = kk = None
    ml = re.search(r"CONSUMO\s+(\d{2,7})\s+(\d{2,7})\b", texto)   # 'CONSUMO 4037 4107'
    if ml:
        a, b = _br(ml.group(1)), _br(ml.group(2))
        if a is not None and b is not None and b > a:
            k = q1 / (b - a)
            # K precisa ser ~inteiro limpo (ou consumo = (atu-ant)*K*1,025)
            if abs(k - round(k)) <= 0.02 or abs(q1 - (b - a) * round(k) * 1.025) <= max(1.0, q1 * 0.01):
                ant, atu, kk = a, b, round(k)
    return {"postos": [dict(posto="fponta", medidor=None, ant=ant, atu=atu, k=kk, consumo=q1)], "_validado": True}

# ── EDP SP: 'Consumo Ativo (Ponta|FPonta) <q>' (TE) vs '... Cons Ativo ... <q>' (TUSD) ─
def parse_edp_sp(texto: str) -> dict:
    texto = texto or ""
    # B3 convencional: 'TE - Consumo <q>' == 'TUSD - Consumo <q>'  → fora ponta única
    b3 = {}
    for mm in re.finditer(r"(TUSD|TE)\s*-\s*Consumo\s+([\d.,]+)", texto, re.I):
        b3.setdefault(mm.group(1).upper(), _br(mm.group(2)))
    if "TE" in b3 and "TUSD" in b3:
        q1, q2 = b3["TE"], b3["TUSD"]
        if q1 and q1 > 0 and abs(q1 - (q2 or 0)) <= max(1.0, q1 * 0.01):
            return {"postos": [dict(posto="fponta", medidor=None, ant=None, atu=None, k=None, consumo=q1)], "_validado": True}
    # Grupo A: 'Consumo Ativo Ponta/FPonta <q>' (TE) == 'Cons Ativo ... <q>' (TUSD)
    te = {}; tu = {}
    for mm in re.finditer(r"Consumo Ativo\s+(Ponta|FPonta|Fora\s+Ponta)\s+([\d.,]+)", texto, re.I):
        seg = "ponta" if mm.group(1).lower() == "ponta" else "fponta"; te[seg] = _br(mm.group(2))
    for mm in re.finditer(r"Cons Ativo\s+(Ponta|FPonta|Fora\s+Ponta)[^\n]*?([\d.,]+)", texto, re.I):
        seg = "ponta" if mm.group(1).lower() == "ponta" else "fponta"; tu.setdefault(seg, _br(mm.group(2)))
    postos = []
    for seg, q in te.items():
        if q and q > 0 and seg in tu and abs(q - (tu[seg] or 0)) <= max(1.0, q * 0.01):
            postos.append(dict(posto=seg, medidor=None, ant=None, atu=None, k=None, consumo=q))
    return {"postos": postos, "_validado": bool(postos)}


# Light/DANF3E RJ (B3, sem nome da dist no OCR): consumo na linha 'Energia Elétrica
# kWh kWh <q>', validado por bater com o 1º mês do histórico 'MES/AA ---- <q> <dias>'.
# Fallback (só quando nenhuma dist específica reconheceu), pois 'DANF3E' é genérico.
_RX_LIGHT_EE  = re.compile(r"Energia\s+El[ée]trica\s+kWh\s+kWh\s+([\d.]+)", re.I)
_RX_LIGHT_HIST = re.compile(r"[A-Z]{3}/\d{2}\s+-+\s+([\d.]+)\s+\d+")

def parse_light_danf3e(texto: str) -> dict:
    if "DANF3E" not in (texto or "").upper():
        return {"postos": [], "_validado": False}
    m = _RX_LIGHT_EE.search(texto)
    if not m:
        return {"postos": [], "_validado": False}
    cons = _br(m.group(1))
    if not cons or cons <= 0:
        return {"postos": [], "_validado": False}
    h = _RX_LIGHT_HIST.search(texto)
    hist = _br(h.group(1)) if h else None
    if hist is None or abs(hist - cons) > max(1.0, cons * 0.01):   # item == histórico[0]
        return {"postos": [], "_validado": False}
    return {"postos": [dict(posto="fponta", medidor=None, ant=None, atu=None, k=None, consumo=cons)],
            "_validado": True}


# ── Número decimal US (ponto = decimal): Enel CE '31043.00', '1.00' ─────────
def _us(s):
    s = (s or "").strip().replace(",", "")
    try: return float(s)
    except: return None

_NOVALID = {"postos": [], "_validado": False}

# ── Enel CE (DADOS DA MEDIÇÃO): 'ENERGIA ATIVA - KWH <posto> <ant> <atu> <K> <cons>'
# Números em decimal-US (ponto). consumo = (atu-ant)*K. Só grava consumo>0
# (consumo medido 0 = disponibilidade/estimada → deixa descoberto).
_RX_ENELCE = re.compile(
    r"ENERGIA\s+ATIVA\s*-\s*KWH\s+(HFP|HP|HR|FP|P|PONTA|FORA\s*PONTA)\s+"
    r"([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)", re.I)
def parse_enel_ce(texto):
    if "ENERGIA ATIVA" not in (texto or "").upper(): return dict(_NOVALID)
    postos = {}
    for m in _RX_ENELCE.finditer(texto):
        ant, atu, k, cons = _us(m.group(2)), _us(m.group(3)), _us(m.group(4)), _us(m.group(5))
        if None in (ant, atu, cons) or cons <= 0: continue
        kk = k if (k and k > 0) else 1.0
        if abs((atu - ant) * kk - cons) > max(1.0, cons * 0.01): continue
        p = m.group(1).upper().replace(" ", "")
        seg = "ponta" if p in ("HP", "P", "PONTA") else "fponta"
        postos[seg] = dict(posto=seg, medidor=None, ant=ant, atu=atu,
                           k=(kk if kk != 1.0 else None), consumo=cons)
    return {"postos": list(postos.values()), "_validado": bool(postos)}

# ── CEEE RS: 'Leitura DD/MM/AAAA <n>' (x2) + 'Fator de Multiplicação <fm>' + 'Consumo* <c>'
_RX_CEEE_LEIT = re.compile(r"Leitura\s+\d{2}/\d{2}/\d{4}\s+(\d+)", re.I)
_RX_CEEE_FM   = re.compile(r"Fator de Multiplica[cç][aã]o\s+([\d.,]+)", re.I)
_RX_CEEE_CONS = re.compile(r"Consumo\*\s+(\d+)", re.I)
def parse_ceee_rs(texto):
    t = texto or ""
    cm = _RX_CEEE_CONS.search(t)
    vals = sorted(v for v in (_br(x) for x in _RX_CEEE_LEIT.findall(t)) if v is not None)
    if not cm or len(vals) < 2: return dict(_NOVALID)
    ant, atu = vals[0], vals[-1]
    fmm = _RX_CEEE_FM.search(t)
    fm = _parse_k(fmm.group(1)) if fmm else 1.0
    cons = _br(cm.group(1))
    if cons is None or cons <= 0 or abs((atu - ant) * fm - cons) > max(1.0, cons * 0.01):
        return dict(_NOVALID)
    return {"postos": [dict(posto="fponta", medidor=None, ant=ant, atu=atu,
                            k=(fm if fm != 1 else None), consumo=cons)], "_validado": True}

# ── Equatorial MA/PA (B3): linha 'ATIVO TOTAL ...'. Dois formatos:
#   4 números: 'Consumo ATIVO TOTAL <ant> <atu> <const> <cons> kWh' (PA/MA NF3e)
#   3 números: 'ATIVO TOTAL <ant> <atu> <cons> kWh' (MA optante, perda 2,5%)
_RX_EQMA4 = re.compile(r"ATIVO\s+TOTAL\s+([\d.]+)\s+([\d.]+)\s+([\d.,]+)\s+([\d.]+)\s+kWh", re.I)
_RX_EQMA  = re.compile(r"ATIVO\s+TOTAL\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+kWh", re.I)
def parse_equatorial_ma(texto):
    t = texto or ""
    m4 = _RX_EQMA4.search(t)
    if m4:
        ant, atu, k, cons = _br(m4.group(1)), _br(m4.group(2)), _parse_k(m4.group(3)), _br(m4.group(4))
        if None not in (ant, atu, cons) and cons > 0 and atu >= ant and \
           (abs((atu - ant) * k - cons) <= max(1.0, cons * 0.01) or abs((atu - ant) * k * 1.025 - cons) <= max(1.0, cons * 0.01)):
            return {"postos": [dict(posto="fponta", medidor=None, ant=ant, atu=atu,
                                    k=(k if k != 1 else None), consumo=cons)], "_validado": True}
    m = _RX_EQMA.search(t)   # 3-num 'ATIVO TOTAL <ant> <atu> <cons> kWh' (k=1, ou ×1,025 c/ perda)
    if not m: return dict(_NOVALID)
    ant, atu, cons = _br(m.group(1)), _br(m.group(2)), _br(m.group(3))
    if not _aceita(ant, atu, 1.0, cons): return dict(_NOVALID)  # _aceita cobre ×1 e ×1,025
    return {"postos": [dict(posto="fponta", medidor=None, ant=ant, atu=atu, k=None, consumo=cons)],
            "_validado": True}

# ── Energisa NF3e (MS/TO/SS/MinasRio/Sergipe, A4 e B3): bloco de medição
# '<med> Energia ativa em kWh (Ponta|Fora Ponta) <ant> <atu> <const> <cons>'.
# consumo = (atu-ant)*const, com perda 2,5% (×1,025) — cada posto provado.
_RX_ENERGISA_NF3E = re.compile(
    r"Energia ativa em kWh\s+(Fora\s+Ponta|Ponta)\s+([\d.,]+)\s+([\d.,]+)\s+(\d+)\s+([\d.,]+)", re.I)
def parse_energisa_nf3e(texto):
    postos = {}
    for m in _RX_ENERGISA_NF3E.finditer(texto or ""):
        ant, atu, k, cons = _br(m.group(2)), _br(m.group(3)), _parse_k(m.group(4)), _br(m.group(5))
        if None in (ant, atu, cons) or not k or atu < ant or cons <= 0:
            continue
        calc = (atu - ant) * k
        if abs(calc - cons) > max(1.0, cons * 0.01) and abs(calc * 1.025 - cons) > max(1.0, cons * 0.01):
            continue
        seg = "fponta" if "fora" in m.group(1).lower() else "ponta"
        postos[seg] = dict(posto=seg, medidor=None, ant=ant, atu=atu, k=k, consumo=cons)
    return {"postos": list(postos.values()), "_validado": bool(postos)}

# ── CPFL / Santa Cruz (Série C): 'Consumo - TE … <c>' == 'Consumo Uso Sistema [KWh]-TUSD … <c>'
_RX_CPFL_TUSD = re.compile(r"Consumo Uso Sistema\s*\[KWh\]\s*-\s*TUSD\s+\S+\s+([\d.]+)", re.I)
_RX_CPFL_TE   = re.compile(r"Consumo\s*-\s*TE\s+\S+\s+([\d.]+)", re.I)
def parse_cpfl_te_tusd(texto):
    t = texto or ""
    mt = _RX_CPFL_TE.search(t); mu = _RX_CPFL_TUSD.search(t)
    if not mt or not mu: return dict(_NOVALID)
    q_te, q_tu = _br(mt.group(1)), _br(mu.group(1))
    if q_te is None or q_te <= 0 or abs(q_te - (q_tu or 0)) > 0.5: return dict(_NOVALID)
    return {"postos": [dict(posto="fponta", medidor=None, ant=None, atu=None, k=None, consumo=q_te)],
            "_validado": True}

# ── Enel GO legado / agrupamento: bloco vertical 'LEITURA ATUAL/ANTERIOR' + 'TOTAL CONSUMO'
_RX_GO_ATU = re.compile(r"LEITURA\s+ATUAL\s+(\d+)", re.I)
_RX_GO_ANT = re.compile(r"LEITURA\s+ANTERIOR\s+(\d+)", re.I)
_RX_GO_TOT = re.compile(r"TOTAL\s+CONSUMO\s+(\d+)", re.I)
def parse_enel_go_legado(texto):
    t = texto or ""
    a, b, c = _RX_GO_ATU.search(t), _RX_GO_ANT.search(t), _RX_GO_TOT.search(t)
    if not (a and b and c): return dict(_NOVALID)
    atu, ant, cons = _br(a.group(1)), _br(b.group(1)), _br(c.group(1))
    if None in (atu, ant, cons) or cons <= 0 or atu < ant: return dict(_NOVALID)
    diff = atu - ant
    if abs(diff - cons) <= max(1.0, cons * 0.01):
        k = None
    elif diff > 0 and abs(diff * round(cons / diff) - cons) <= max(1.0, cons * 0.01):
        k = round(cons / diff)                       # FM inteiro (consumo = Δ*FM)
    else:
        return dict(_NOVALID)
    return {"postos": [dict(posto="fponta", medidor=None, ant=ant, atu=atu, k=k, consumo=cons)],
            "_validado": True}


# Light A4 ACL (mercado livre): medição '<med> Comp. Encargo-Kwh (Ponta|Fora Ponta)
# <ant> <atu> <const> <consumo>' (HP=ponta, HFP=fora ponta). Cada linha por leitura×K.
_RX_LIGHT_COMP = re.compile(
    r"Comp\.?\s*Encargo-?\s*Kwh\s+(Fora Ponta|Ponta)\s+([\d.]+)\s+([\d.]+)\s+([\d.,]+)\s+([\d.,]+)", re.I)
def parse_light_componente(texto: str) -> dict:
    postos = {}
    for mm in _RX_LIGHT_COMP.finditer(texto or ""):
        seg = "fponta" if "fora" in mm.group(1).lower() else "ponta"
        ant, atu, k, cons = _br(mm.group(2)), _br(mm.group(3)), _parse_k(mm.group(4)), _br(mm.group(5))
        if None in (ant, atu, cons) or not k or atu < ant or cons <= 0:
            continue
        if abs((atu - ant) * k - cons) > max(1.0, cons * 0.01):
            continue
        postos[seg] = dict(posto=seg, medidor=None, ant=ant, atu=atu, k=k, consumo=cons)
    return {"postos": list(postos.values()), "_validado": bool(postos)}

# Light A4 Verde energia de terceiro (ICMS-ST): 'Consumo Energia Elétrica (HFP|HP) [MW] <q>'
# == abs('Energia Terc Comercializad (HFP|HP) [MW] -<q>'). Se vier 'MW' → ×1000 kWh, senão kWh.
_RX_LIGHT_CEE  = re.compile(r"Consumo Energia El[eé]trica\s+(HFP|HP)\s+(MW\s+)?([\d.,]+)", re.I)
_RX_LIGHT_TERC = re.compile(r"Energia Terc Comercializad\s+(HFP|HP)\s+(?:MW\s+)?-?([\d.,]+)", re.I)
def parse_light_energia_terc(texto: str) -> dict:
    t = texto or ""
    cee = {}; terc = {}
    for mm in _RX_LIGHT_CEE.finditer(t):
        cee[mm.group(1).upper()] = (_br(mm.group(3)), 1000.0 if mm.group(2) else 1.0)
    for mm in _RX_LIGHT_TERC.finditer(t):
        terc[mm.group(1).upper()] = _br(mm.group(2))
    postos = {}
    for pos, seg in (("HP", "ponta"), ("HFP", "fponta")):
        if pos in cee and pos in terc:
            q, mult = cee[pos]
            if q and q > 0 and abs(q - terc[pos]) <= max(0.01, q * 0.005):
                postos[seg] = dict(posto=seg, medidor=None, ant=None, atu=None, k=None, consumo=round(q * mult, 2))
    return {"postos": list(postos.values()), "_validado": bool(postos)}

# Light GD/SCEE e B com 'Energia Ativa-Kwh Único <ant> <atu> <const> <consumo>' (leitura×K)
# — consumo MEDIDO bruto (antes da compensação GD). Mais confiável que o líquido pós-GD.
_RX_LIGHT_UNICO = re.compile(r"Energia Ativa-?\s*Kwh\s+[ÚU]nico\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)", re.I)
def parse_light_unico(texto: str) -> dict:
    mu = _RX_LIGHT_UNICO.search(texto or "")
    if not mu:
        return {"postos": [], "_validado": False}
    ant, atu, k, cons = _br(mu.group(1)), _br(mu.group(2)), _parse_k(mu.group(3)), _br(mu.group(4))
    if None in (ant, atu, cons) or not k or atu < ant or cons <= 0:
        return {"postos": [], "_validado": False}
    if abs((atu - ant) * k - cons) > max(1.0, cons * 0.01) and abs((atu - ant) * k * 1.025 - cons) > max(1.0, cons * 0.01):
        return {"postos": [], "_validado": False}
    return {"postos": [dict(posto="fponta", medidor=None, ant=ant, atu=atu, k=k, consumo=cons)], "_validado": True}

def parse_light(texto: str) -> dict:
    for fn in (parse_light_componente, parse_light_energia_terc, parse_light_unico, parse_light_ee, parse_light_danf3e):
        r = fn(texto)
        if r["_validado"]:
            return r
    return {"postos": [], "_validado": False}


# Ampla/Enel RJ legado (Modelo 6): linha de faturamento
# '<tipo> Medidor <leit_atu> <leit_ant> <consumo> <tarifa> <valor>' — validado por consumo×tarifa==valor.
_RX_AMPLA_LEG = re.compile(r"Medidor\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.,]+)\s+([\d.,]+)", re.I)
def parse_ampla_legado(texto: str) -> dict:
    t = texto or ""
    up = t.upper()
    if not ("DIVISÃO DE CONSUMO DO MÊS" in up or "DIVISAO DE CONSUMO DO MES" in up
            or "ACOMPANHAMENTO DE CONSUMO" in up or "FATURAMENTO CONSTANTE" in up):
        return {"postos": [], "_validado": False}   # âncora-guarda do layout legado Ampla
    for m in _RX_AMPLA_LEG.finditer(t):
        atu, ant, cons, tar, val = (_br(m.group(1)), _br(m.group(2)), _br(m.group(3)),
                                    _br(m.group(4)), _br(m.group(5)))
        if None in (cons, tar, val) or cons <= 0 or tar <= 0:
            continue
        if abs(cons * tar - val) > max(1.0, val * 0.02):     # consumo × tarifa == valor
            continue
        k = None
        if atu and ant and atu > ant:
            kk = cons / (atu - ant)
            if abs(kk - round(kk)) <= 0.02:
                k = round(kk)
        return {"postos": [dict(posto="fponta", medidor=None, ant=ant, atu=atu, k=k, consumo=cons)],
                "_validado": True}
    return {"postos": [], "_validado": False}

# Ampla/Enel RJ GD/SCEE (DANF3E): 'Energia Ativa Fornecida TE/TUSD kWh <q>' (bruto), TE==TUSD.
_RX_AMPLA_FORN = re.compile(r"Energia Ativa Fornecida\s+(TUSD|TE)\s+kWh\s+([\d.,]+)", re.I)
def parse_ampla_gd(texto: str) -> dict:
    d = {}
    for m in _RX_AMPLA_FORN.finditer(texto or ""):
        d.setdefault(m.group(1).upper(), _br(m.group(2)))
    te, tu = d.get("TE"), d.get("TUSD")
    if te and te > 0 and tu and abs(te - tu) <= max(1.0, te * 0.01):
        return {"postos": [dict(posto="fponta", medidor=None, ant=None, atu=None, k=None, consumo=te)],
                "_validado": True}
    return {"postos": [], "_validado": False}

def parse_ampla(texto: str) -> dict:
    for fn in (parse_ampla_gd, parse_ampla_legado):
        r = fn(texto)
        if r["_validado"]:
            return r
    return {"postos": [], "_validado": False}


# Equatorial GO / Enel GO NF3e: 'ENERGIA ATIVA - KWH (PONTA|FORA PONTA|RESERVADO)
# <ant> <atu> <const> <consumo>' (BR). leitura×K (×1 ou ×1,025). reservado ignorado.
_RX_EQGO = re.compile(
    r"ENERGIA ATIVA\s*-\s*KWH\s+(FORA PONTA|PONTA|RESERVAD\w*)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+([\d.,]+)", re.I)
def parse_equatorial_go(texto: str) -> dict:
    postos = {}
    for m in _RX_EQGO.finditer(texto or ""):
        p = m.group(1).lower()
        if "reserv" in p:
            continue
        seg = "fponta" if "fora" in p else "ponta"
        ant, atu, k, cons = _br(m.group(2)), _br(m.group(3)), _parse_k(m.group(4)), _br(m.group(5))
        if None in (ant, atu, cons) or not k or cons <= 0:
            continue
        d = abs(atu - ant)
        if abs(d * k - cons) > max(1.0, cons * 0.01) and abs(d * k * 1.025 - cons) > max(1.0, cons * 0.01):
            continue
        postos[seg] = dict(posto=seg, medidor=None, ant=min(ant, atu), atu=max(ant, atu), k=k, consumo=cons)
    return {"postos": list(postos.values()), "_validado": bool(postos)}

# Celesc A4 horária: 'CNP <l1> <l2> kWh PT <const> <consumo>' (ponta) e 'CNF ... FP ...' (fora ponta).
# consumo = |l1-l2| × const × 1,025 (perda de transformação 2,5%).
_RX_CELESC = re.compile(r"\b(CNP|CNF)\s+(\d+)\s+(\d+)\s+kWh\s+(?:PT|FP)\s+([\d.,]+)\s+([\d.,]+)", re.I)
# Celesc B3: 'Leitura atual: <atu>' / 'Leitura anterior: <ant>' / 'Constante de faturamento: <k>'
# / 'Consumo medido no mês: <cons>'. leitura×K.
_RX_CELESC_ATU  = re.compile(r"(?<!da )Leitura atual:\s*(\d+)", re.I)   # exclui 'Data da leitura atual: <data>'
_RX_CELESC_ANT  = re.compile(r"(?<!da )Leitura anterior:\s*(\d+)", re.I)
_RX_CELESC_K    = re.compile(r"Constante de faturamento:\s*([\d.,]+)", re.I)
_RX_CELESC_CONS = re.compile(r"Consumo medido no m[êe]s:\s*(\d+)", re.I)
def parse_celesc(texto: str) -> dict:
    t = texto or ""
    d = parse_celesc_danf3e(t)                             # DANF3E ('<med> Energia Único <ant> <atu> ...')
    if d["_validado"]:
        return d
    postos = {}
    for m in _RX_CELESC.finditer(t):                       # A4 horária (CNP/CNF)
        seg = "ponta" if m.group(1).upper() == "CNP" else "fponta"
        l1, l2, k, cons = _br(m.group(2)), _br(m.group(3)), _parse_k(m.group(4)), _br(m.group(5))
        if None in (l1, l2, cons) or not k or cons <= 0:
            continue
        d = abs(l1 - l2)
        if abs(d * k - cons) > max(1.0, cons * 0.01) and abs(d * k * 1.025 - cons) > max(1.0, cons * 0.01):
            continue
        postos[seg] = dict(posto=seg, medidor=None, ant=min(l1, l2), atu=max(l1, l2), k=k, consumo=cons)
    if postos:
        return {"postos": list(postos.values()), "_validado": True}
    ma, mb, mc = _RX_CELESC_ATU.search(t), _RX_CELESC_ANT.search(t), _RX_CELESC_CONS.search(t)   # B3
    if ma and mb and mc:
        atu, ant, cons = _br(ma.group(1)), _br(mb.group(1)), _br(mc.group(1))
        mk = _RX_CELESC_K.search(t); k = _parse_k(mk.group(1)) if mk else 1.0
        if None not in (atu, ant, cons) and cons > 0 and k and abs(abs(atu - ant) * k - cons) <= max(1.0, cons * 0.01):
            return {"postos": [dict(posto="fponta", medidor=None, ant=min(ant, atu), atu=max(ant, atu),
                                    k=k, consumo=cons)], "_validado": True}
    # B conv legado: item 'Consumo <q> <tarifa> <valor>' (q×tarifa==valor) — cobre
    # casos de rollover de leitura, onde (atu-ant)*K não fecha mas o consumo é o impresso.
    mi = re.search(r"\bConsumo\s+([\d.]+)\s+([\d.,]+)\s+([\d.,]+)", t)
    if mi:
        q, tar, val = _br(mi.group(1)), _br(mi.group(2)), _br(mi.group(3))
        if None not in (q, tar, val) and q > 0 and tar > 0 and abs(q * tar - val) <= max(1.0, val * 0.01):
            return {"postos": [dict(posto="fponta", medidor=None, ant=None, atu=None, k=None, consumo=q)],
                    "_validado": True}
    return {"postos": [], "_validado": False}


# ── Número auto BR/US: vírgula no grupo → BR (.=milhar ,=decimal); senão US (.=decimal)
def _numauto(*raws):
    f = _br if any("," in (r or "") for r in raws) else _us
    return [f(r) for r in raws]

# ── CELESC DANF3E: '<med> Energia <posto> <ant> <atu> <const> <perdas%> <total>' (BR)
#    total = (atu-ant)*const*(1+perdas/100). posto: Único/Ponta/Fora Ponta/HFP/HP.
_RX_CELESC_DANF = re.compile(
    r"([A-Z]{1,3}\d{5,})\s+Energia\s+(Único|Unico|Ponta|Fora\s+Ponta|HFP|HP)\s+"
    r"([\d.]+)\s+([\d.]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)", re.I)
def parse_celesc_danf3e(texto: str) -> dict:
    postos = {}
    for m in _RX_CELESC_DANF.finditer(texto or ""):
        ant, atu, k, perdas, tot = (_br(m.group(3)), _br(m.group(4)), _parse_k(m.group(5)),
                                    _br(m.group(6)), _br(m.group(7)))
        if None in (ant, atu, tot) or not k or atu < ant or tot <= 0:
            continue
        calc = (atu - ant) * k * (1 + (perdas or 0) / 100.0)
        if abs(calc - tot) > max(1.0, tot * 0.01):
            continue
        p = m.group(2).lower()
        seg = "ponta" if p in ("ponta", "hp") else "fponta"
        postos[seg] = dict(posto=seg, medidor=m.group(1), ant=ant, atu=atu, k=k, consumo=tot)
    return {"postos": list(postos.values()), "_validado": bool(postos)}

# ── Medição horária NF3e (Enel RJ B3 / Coelce CE B3): '<med> <posto> <data> <ant>
#    <data> <atu> <fator> <cons> <dias>'. data DD/MM/AAAA ou DD.MMM. cons=(atu-ant)*fator.
_RX_MED_HORARIO = re.compile(
    r"([0-9]{5,}-?[\w-]*)\s+(HFP|HP|FP|P|PONTA|FORA\s+PONTA|[ÚU]NICO)\s+"
    r"(?:\d{1,2}/\d{2}/\d{4}|\d{1,2}\.[A-Z]{3})\s+([\d.,]+)\s+"
    r"(?:\d{1,2}/\d{2}/\d{4}|\d{1,2}\.[A-Z]{3})\s+([\d.,]+)\s+"
    r"([\d.,]+)\s+([\d.,]+)\s+\d+", re.I)
def parse_medicao_horario(texto: str) -> dict:
    postos = {}
    for m in _RX_MED_HORARIO.finditer(texto or ""):
        ant, atu, fator, cons = _numauto(m.group(3), m.group(4), m.group(5), m.group(6))
        if None in (ant, atu, cons) or atu < ant or cons <= 0:
            continue
        kk = fator if (fator and fator > 0) else 1.0
        if abs((atu - ant) * kk - cons) > max(1.0, cons * 0.01):
            continue
        p = m.group(2).upper()
        seg = "ponta" if p in ("HP", "P", "PONTA") else "fponta"
        postos[seg] = dict(posto=seg, medidor=m.group(1), ant=ant, atu=atu,
                           k=(kk if kk != 1.0 else None), consumo=cons)
    return {"postos": list(postos.values()), "_validado": bool(postos)}

# ── A4 por grandeza: '(Energia Ativa-kWh|ENERGIA ATIVA-KWH) <posto> <ant> <atu>
#    <const> <cons>'. Cobre Enel CE/RJ A4 (BR) e Coelce A4 (US). cons=(atu-ant)*K (±1,025).
_RX_GRANDEZA_A4 = re.compile(
    r"(?:Energia\s+Ativa\s*-?\s*kWh|ENERGIA\s+ATIVA\s*-\s*KWH)\s+"
    r"(FORA\s+PONTA|PONTA|HFP|HP)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)", re.I)
def parse_grandeza_a4(texto: str) -> dict:
    postos = {}
    for m in _RX_GRANDEZA_A4.finditer(texto or ""):
        ant, atu, cons = _numauto(m.group(2), m.group(3), m.group(5))
        k = _br(m.group(4)) if "," in m.group(4) else (_us(m.group(4)) or 1.0)
        if None in (ant, atu, cons) or atu < ant or cons <= 0:
            continue
        kk = k if (k and k > 0) else 1.0
        d = atu - ant
        if abs(d * kk - cons) > max(1.0, cons * 0.01) and abs(d * kk * 1.025 - cons) > max(1.0, cons * 0.01):
            continue
        p = m.group(1).upper().replace(" ", "")
        seg = "ponta" if p in ("PONTA", "HP") else "fponta"
        postos[seg] = dict(posto=seg, medidor=None, ant=ant, atu=atu,
                           k=(kk if kk != 1.0 else None), consumo=cons)
    return {"postos": list(postos.values()), "_validado": bool(postos)}

# ── Enel GO NF3e B3: '<med> CONSUMO ÚNICO <ant> <atu> <const> <cons>' (cons=(atu-ant)*K)
_RX_ENELGO_NF = re.compile(r"CONSUMO\s+[ÚU]NICO\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\b", re.I)
def parse_enel_go_nf3e(texto: str) -> dict:
    for m in _RX_ENELGO_NF.finditer(texto or ""):
        ant, atu, k, cons = _br(m.group(1)), _br(m.group(2)), _parse_k(m.group(3)), _br(m.group(4))
        if None in (ant, atu, cons) or cons <= 0:
            continue
        kk = k if (k and k > 0) else 1.0
        if abs(abs(atu - ant) * kk - cons) > max(1.0, cons * 0.01):
            continue
        return {"postos": [dict(posto="fponta", medidor=None, ant=min(ant, atu), atu=max(ant, atu),
                                k=(kk if kk != 1.0 else None), consumo=cons)], "_validado": True}
    return {"postos": [], "_validado": False}

# ── Energisa MS B2 (LEITURAS): 'Anterior <data> <ant> kWh' / 'Atual <data> <atu> kWh'
#    / 'Consumo <cons> kWh'. B2 → const=1; cons=atu-ant.
_RX_EMS_ANT  = re.compile(r"Anterior\s+\d{2}/\d{2}/\d{2,4}\s+(\d+)\s*kWh", re.I)
_RX_EMS_ATU  = re.compile(r"Atual\s+\d{2}/\d{2}/\d{2,4}\s+(\d+)\s*kWh", re.I)
_RX_EMS_CONS = re.compile(r"Consumo\s+(\d+)\s*kWh", re.I)
def parse_energisa_ms(texto: str) -> dict:
    t = texto or ""
    ma, mb, mc = _RX_EMS_ATU.search(t), _RX_EMS_ANT.search(t), _RX_EMS_CONS.search(t)
    if not (ma and mb and mc):
        return {"postos": [], "_validado": False}
    atu, ant, cons = _br(ma.group(1)), _br(mb.group(1)), _br(mc.group(1))
    if None in (atu, ant, cons) or cons <= 0 or atu < ant or (atu - ant) <= 0:
        return {"postos": [], "_validado": False}
    if abs((atu - ant) - cons) > max(1.0, cons * 0.01):
        return {"postos": [], "_validado": False}
    return {"postos": [dict(posto="fponta", medidor=None, ant=ant, atu=atu, k=None, consumo=cons)],
            "_validado": True}

# ── Enel RJ/Ampla legado A4 (itens multi-linha): 'TUSD fora ponta\n<qtd>\n<preco>\n<valor>'
#    consumo do posto = qtd, validado por qtd×preco==|valor|. fponta/ponta.
_RX_AMPLA_TUSD = re.compile(
    r"TUSD\s+(fora\s+ponta|ponta)\s*\n\s*([\d.,]+)\s*\n\s*([\d.,]+)\s*\n\s*(-?[\d.,]+-?)", re.I)
def parse_ampla_legado_itens(texto: str) -> dict:
    postos = {}
    for m in _RX_AMPLA_TUSD.finditer(texto or ""):
        qtd, preco, valor = _br(m.group(2)), _br(m.group(3)), _br((m.group(4) or "").rstrip("-"))
        if None in (qtd, preco, valor) or qtd <= 0 or preco <= 0:
            continue
        if abs(qtd * preco - abs(valor)) > max(1.0, abs(valor) * 0.02):
            continue
        seg = "fponta" if "fora" in m.group(1).lower() else "ponta"
        postos[seg] = dict(posto=seg, medidor=None, ant=None, atu=None, k=None, consumo=qtd)
    return {"postos": list(postos.values()), "_validado": bool(postos)}

# ── CEMIG (itens, qtd×tarifa==valor): 'Energia Ativa[ kWh] HFP/HP <qtd> <tarifa> <valor>'
#    e TUSD Livre 'Componente Encargo HFP/HP <qtd> <tarifa> <valor>'. qtd = consumo do
#    posto (HFP→fora ponta, HP→ponta). SÓ medição — não mexe em demanda/injeção/GD. (BR)
_RX_CEMIG_ITEM = re.compile(
    r"(?:Energia\s+Ativa(?:\s+kWh)?|Componente\s+Encargo)\s+(HFP|HP)\b\s+(?:kWh\s+)?"
    r"([\d.,]+)\s+([\d.,]+)\s+(-?[\d.,]+)", re.I)
def parse_cemig_itens(texto: str) -> dict:
    postos = {}
    for m in _RX_CEMIG_ITEM.finditer(texto or ""):
        qtd, tarifa, valor = _br(m.group(2)), _br(m.group(3)), _br(m.group(4))
        if None in (qtd, tarifa, valor) or qtd <= 0 or tarifa <= 0:
            continue
        if abs(qtd * tarifa - abs(valor)) > max(1.0, abs(valor) * 0.01):
            continue
        seg = "ponta" if m.group(1).upper() == "HP" else "fponta"
        if seg not in postos:                     # 1ª ocorrência (evita linha s/ ICMS duplicada)
            postos[seg] = dict(posto=seg, medidor=None, ant=None, atu=None, k=None, consumo=qtd)
    return {"postos": list(postos.values()), "_validado": bool(postos)}

# ── Energisa CCI (SS/MT/MS, qtd×tarifa==valor): 'Consumo em kWh[ - Ponta|Fora Ponta|
#    Reservado] <qtd> <tarifa s/trib> <tarifa c/trib> <valor>'. qtd = consumo. (BR)
_RX_ENERGISA_CCI = re.compile(
    r"Consumo\s+em\s+kWh(?:\s*-?\s*(Ponta|Fora\s+Ponta|Reservad\w*))?\s+"
    r"([\d.,]+)\s+[—\-]?\s*([\d.,]+)\s+[—\-]?\s*([\d.,]+)\s+(-?[\d.,]+)", re.I)
def parse_energisa_cci(texto: str) -> dict:
    postos = {}
    for m in _RX_ENERGISA_CCI.finditer(texto or ""):
        p = (m.group(1) or "").lower()
        if "reserv" in p:
            continue
        qtd, t1, t2, valor = _br(m.group(2)), _br(m.group(3)), _br(m.group(4)), _br(m.group(5))
        if None in (qtd, valor) or qtd <= 0 or valor <= 0:
            continue
        ok = ((t2 and abs(qtd * t2 - valor) <= max(1.0, valor * 0.01)) or
              (t1 and abs(qtd * t1 - valor) <= max(1.0, valor * 0.01)))
        if not ok:
            continue
        seg = "ponta" if p == "ponta" else "fponta"
        if seg not in postos:
            postos[seg] = dict(posto=seg, medidor=None, ant=None, atu=None, k=None, consumo=qtd)
    return {"postos": list(postos.values()), "_validado": bool(postos)}


# ── Light B3 antigo (NF-e): 'Energia Elétrica kWh <CFOP> kWh <q> <tarifa> <valor>'
#    consumo = q, validado por q×tarifa==valor (sem exigir DANF3E). (BR)
_RX_LIGHT_EE_CFOP = re.compile(
    r"Energia\s+El[ée]trica\s+kWh\s+[\d.]+\s+kWh\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)", re.I)
def parse_light_ee(texto: str) -> dict:
    for m in _RX_LIGHT_EE_CFOP.finditer(texto or ""):
        q, tar, val = _br(m.group(1)), _br(m.group(2)), _br(m.group(3))
        if None in (q, tar, val) or q <= 0 or tar <= 0:
            continue
        if abs(q * tar - val) > max(1.0, val * 0.01):
            continue
        return {"postos": [dict(posto="fponta", medidor=None, ant=None, atu=None, k=None, consumo=q)],
                "_validado": True}
    return {"postos": [], "_validado": False}

# ── Copel (itens): 'ENERGIA ELET CONSUMO [F ]PTA kWh <q> <tarifa> <valor>'
#    horária (PTA/F PTA) e B3 (sem posto). consumo = q, q×tarifa==valor. (BR)
_RX_COPEL_CONS = re.compile(
    r"ENERGIA\s+ELET\s+CONSUMO\s+(F\s+PTA|PTA)?\s*kWh\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)", re.I)
def parse_copel_consumo(texto: str) -> dict:
    postos = {}
    for m in _RX_COPEL_CONS.finditer(texto or ""):
        q, tar, val = _br(m.group(2)), _br(m.group(3)), _br(m.group(4))
        if None in (q, tar, val) or q <= 0 or tar <= 0:
            continue
        if abs(q * tar - val) > max(1.0, val * 0.01):
            continue
        p = (m.group(1) or "").upper()
        seg = "ponta" if p == "PTA" else "fponta"
        postos.setdefault(seg, dict(posto=seg, medidor=None, ant=None, atu=None, k=None, consumo=q))
    return {"postos": list(postos.values()), "_validado": bool(postos)}

# ── EDP ES (B3): 'Ativo <medidor> <ant> <atu> <const> <cons>' (cons=(atu-ant)*const).
#    Fallback item 'Consumo <q> KWH <tarifa> <valor>' (q×tarifa==valor). (BR)
_RX_EDPES_ATIVO = re.compile(r"Ativo\s+\S+\s+([\d.]+)\s+([\d.]+)\s+([\d.,]+)\s+([\d.,]+)", re.I)
_RX_EDPES_ITEM  = re.compile(r"Consumo\s+([\d.,]+)\s+KWH\s+([\d.,]+)\s+([\d.,]+)", re.I)
def parse_edp_es(texto: str) -> dict:
    t = texto or ""
    m = _RX_EDPES_ATIVO.search(t)
    if m:
        ant, atu, k, cons = _br(m.group(1)), _br(m.group(2)), _parse_k(m.group(3)), _br(m.group(4))
        if None not in (ant, atu, cons) and cons > 0 and atu >= ant and k and \
           abs((atu - ant) * k - cons) <= max(1.0, cons * 0.01):
            return {"postos": [dict(posto="fponta", medidor=None, ant=ant, atu=atu, k=k, consumo=cons)],
                    "_validado": True}
    mi = _RX_EDPES_ITEM.search(t)
    if mi:
        q, tar, val = _br(mi.group(1)), _br(mi.group(2)), _br(mi.group(3))
        if None not in (q, tar, val) and q > 0 and tar > 0 and abs(q * tar - val) <= max(1.0, val * 0.01):
            return {"postos": [dict(posto="fponta", medidor=None, ant=None, atu=None, k=None, consumo=q)],
                    "_validado": True}
    return {"postos": [], "_validado": False}

# ── EDP SP A4: '0605TUSD - Cons[umo] Ativo Ponta|FPonta Ind.|FPonta Cap. <q>' e
#    '0601TE - ...'. fponta = Ind+Cap somados; validado por TUSD(seg)==TE(seg). (BR)
_RX_EDPSP_A4 = re.compile(
    r"(0605TUSD|0601TE)\s*-\s*Cons(?:umo)?\s+Ativo\s+(Ponta|FPonta\s+Ind\.?|FPonta\s+Cap\.?|FPonta)\s+([\d.,]+)", re.I)
def parse_edp_sp_a4(texto: str) -> dict:
    tu = {"ponta": 0.0, "fponta": 0.0}; te = {"ponta": 0.0, "fponta": 0.0}
    n_tu = {"ponta": 0, "fponta": 0}; n_te = {"ponta": 0, "fponta": 0}
    for m in _RX_EDPSP_A4.finditer(texto or ""):
        q = _br(m.group(3))
        if q is None or q <= 0:
            continue
        seg = "ponta" if m.group(2).lower().strip() == "ponta" else "fponta"
        if m.group(1).upper() == "0605TUSD":
            tu[seg] += q; n_tu[seg] += 1
        else:
            te[seg] += q; n_te[seg] += 1
    postos = []
    for seg in ("ponta", "fponta"):
        if n_tu[seg] and n_te[seg] and abs(tu[seg] - te[seg]) <= max(1.0, tu[seg] * 0.01):
            postos.append(dict(posto=seg, medidor=None, ant=None, atu=None, k=None, consumo=round(tu[seg], 4)))
    return {"postos": postos, "_validado": bool(postos)}


# ── Enel GO legado/NF3e (item): 'CONSUMO [KWH + ICMS/PIS/COFINS|kWh] <q> <tarifa>
#    R$<valor>'. consumo = q, validado por q×tarifa==valor. (BR, posto único)
_RX_ENELGO_ITEM = re.compile(
    r"CONSUMO\s+kWh(?:\s*\+\s*ICMS/PIS/COFINS)?\s+([\d.,]+)\s+([\d.,]+)\s+R?\$?\*?([\d.,]+)", re.I)
def parse_enel_go_item(texto: str) -> dict:
    for m in _RX_ENELGO_ITEM.finditer(texto or ""):
        q, tar, val = _br(m.group(1)), _br(m.group(2)), _br(m.group(3))
        if None in (q, tar, val) or q <= 0 or tar <= 0:
            continue
        if abs(q * tar - val) > max(1.0, val * 0.01):
            continue
        return {"postos": [dict(posto="fponta", medidor=None, ant=None, atu=None, k=None, consumo=q)],
                "_validado": True}
    return {"postos": [], "_validado": False}

# ── EDP ES/SP GD (fornecida bruta): '(TUSD|TE) - Energia Ativa Fornecida kWh <q>'.
#    TE==TUSD fornecida → consumo bruto medido (antes da compensação GD). (BR)
_RX_EDP_FORN = re.compile(r"(TUSD|TE)\s*-\s*Energia Ativa Fornecida\s+kWh\s+([\d.,]+)", re.I)
def parse_edp_fornecida(texto: str) -> dict:
    d = {}
    for m in _RX_EDP_FORN.finditer(texto or ""):
        d.setdefault(m.group(1).upper(), _br(m.group(2)))
    te, tu = d.get("TE"), d.get("TUSD")
    if te and te > 0 and tu and abs(te - tu) <= max(1.0, te * 0.01):
        return {"postos": [dict(posto="fponta", medidor=None, ant=None, atu=None, k=None, consumo=te)],
                "_validado": True}
    return {"postos": [], "_validado": False}

# ── Equatorial AL/PA item: 'Consumo <q> kWh a <tarifa1> <tarifa2> <valor>'.
#    consumo = q, validado por q×tarifa1==valor (ou ×tarifa2). (BR)
_RX_EQ_ITEM = re.compile(r"Consumo\s+([\d.]+)\s+kWh\s+a\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)", re.I)
def parse_equatorial_item(texto: str) -> dict:
    for m in _RX_EQ_ITEM.finditer(texto or ""):
        q, t1, t2, val = _br(m.group(1)), _br(m.group(2)), _br(m.group(3)), _br(m.group(4))
        if None in (q, val) or q <= 0 or val <= 0:
            continue
        if not ((t1 and abs(q * t1 - val) <= max(1.0, val * 0.01)) or
                (t2 and abs(q * t2 - val) <= max(1.0, val * 0.01))):
            continue
        return {"postos": [dict(posto="fponta", medidor=None, ant=None, atu=None, k=None, consumo=q)],
                "_validado": True}
    return {"postos": [], "_validado": False}


# ── Dispatchers compostos ───────────────────────────────────────────────────
def parse_equatorial_full(texto: str) -> dict:
    for fn in (parse_equatorial_ma, parse_equatorial_item):
        r = fn(texto)
        if r["_validado"]:
            return r
    return {"postos": [], "_validado": False}

def parse_edp_es_full(texto: str) -> dict:
    for fn in (parse_edp_es, parse_edp_fornecida):
        r = fn(texto)
        if r["_validado"]:
            return r
    return {"postos": [], "_validado": False}

def parse_edp_sp_full(texto: str) -> dict:
    a4 = parse_edp_sp_a4(texto)
    if a4["_validado"]:
        return a4
    b3 = parse_edp_sp(texto)
    if b3["_validado"]:
        return b3
    return parse_edp_fornecida(texto)

def parse_copel_full(texto: str) -> dict:
    r = parse_copel_consumo(texto)
    if r["_validado"]:
        return r
    return extrair_medicao_validada(texto)   # Copel B3 'CONSUMO kWh PT/FP' (pattern 4)

def parse_cemig_full(texto: str) -> dict:
    r = parse_cemig_itens(texto)
    if r["_validado"]:
        return r
    return extrair_medicao_validada(texto)        # NF3e CEMIG 'Energia <posto> kWh <med> ...'

def parse_energisa_full(texto: str) -> dict:
    for fn in (parse_energisa_nf3e, parse_energisa_cci):
        r = fn(texto)
        if r["_validado"]:
            return r
    return {"postos": [], "_validado": False}

def parse_ampla_full(texto: str) -> dict:
    for fn in (parse_ampla_gd, parse_grandeza_a4, parse_medicao_horario,
               parse_ampla_legado, parse_ampla_legado_itens):
        r = fn(texto)
        if r["_validado"]:
            return r
    return {"postos": [], "_validado": False}

def parse_energisa_ms_full(texto: str) -> dict:
    for fn in (parse_energisa_nf3e, parse_energisa_ms, parse_energisa_cci):
        r = fn(texto)
        if r["_validado"]:
            return r
    return {"postos": [], "_validado": False}

def parse_equatorial_go_full(texto: str) -> dict:
    for fn in (parse_equatorial_go, parse_enel_go_nf3e, parse_enel_go_item, parse_equatorial_item):
        r = fn(texto)
        if r["_validado"]:
            return r
    return {"postos": [], "_validado": False}

def parse_enel_ce_full(texto: str) -> dict:
    for fn in (parse_enel_ce, parse_grandeza_a4, parse_medicao_horario):
        r = fn(texto)
        if r["_validado"]:
            return r
    return {"postos": [], "_validado": False}


_PARSERS_DIRIGIDOS = {
    "parser_coelba": parse_coelba,
    "parser_celpe_pe": parse_coelba,        # Neoenergia PE = mesmo 'Consumo Ativo(kWh)-TE/TUSD'
    "parser_cosern_rn": parse_coelba,
    "parser_enel_sp": parse_enel_sp,
    "parser_enel_ce": parse_enel_ce_full,
    "parser_elektro_sp": parse_elektro,
    "parser_edp_sp": parse_edp_sp_full,
    "parser_edp_es": parse_edp_es_full,
    "parser_copel_pr": parse_copel_full,
    "parser_equatorial_ma": parse_equatorial_full,
    "parser_equatorial_pa": parse_equatorial_full,
    "parser_cpfl": parse_cpfl_te_tusd,
    "parser_cemig_mg": parse_cemig_full,
    "parser_cemig_santa_cruz": parse_cpfl_te_tusd,
    "parser_energisa_ms": parse_energisa_ms_full,
    "parser_energisa": parse_energisa_full,
    "parser_light_rj": parse_light,
    "parser_enel_rj_ampla": parse_ampla_full,
    "parser_equatorial_go": parse_equatorial_go_full,
    "parser_celesc": parse_celesc,
}

# Parsers por ASSINATURA de texto (independente do rótulo de distribuidora,
# que vem trocado no banco). Cada um é auto-validado por fórmula → baixo risco
# de falso positivo. Tentados em ordem quando router+genérico não validaram.
_SIGNATURE = [
    ("parser_equatorial_consumo", parse_equatorial_consumo),
    ("parser_energisa_nf3e",  parse_energisa_nf3e),
    ("parser_coelba",         parse_coelba),
    ("parser_enel_go_legado", parse_enel_go_legado),
    ("parser_equatorial_ma",  parse_equatorial_ma),
    ("parser_ceee_rs",        parse_ceee_rs),
    ("parser_cpfl_te_tusd",   parse_cpfl_te_tusd),
    ("parser_enel_ce",        parse_enel_ce),
    ("parser_enel_sp",        parse_enel_sp),
    ("parser_celesc_danf3e",  parse_celesc_danf3e),
    ("parser_medicao_horario", parse_medicao_horario),
    ("parser_grandeza_a4",    parse_grandeza_a4),
    ("parser_enel_go_nf3e",   parse_enel_go_nf3e),
    ("parser_enel_go_item",   parse_enel_go_item),
    ("parser_equatorial_item", parse_equatorial_item),
    ("parser_cemig_itens",    parse_cemig_itens),
    ("parser_energisa_cci",   parse_energisa_cci),
    ("parser_energisa_ms",    parse_energisa_ms),
    ("parser_light_componente", parse_light_componente),
    ("parser_light_energia_terc", parse_light_energia_terc),
    ("parser_light_unico",    parse_light_unico),
    ("parser_ampla_gd",       parse_ampla_gd),
    ("parser_ampla_legado",   parse_ampla_legado),
    ("parser_ampla_legado_itens", parse_ampla_legado_itens),
    ("parser_equatorial_go",  parse_equatorial_go),
    ("parser_copel_consumo",  parse_copel_consumo),
    ("parser_edp_sp_a4",      parse_edp_sp_a4),
    ("parser_elektro",        parse_elektro),
    ("parser_celesc",         parse_celesc),
    ("parser_light_ee",       parse_light_ee),
    ("parser_light_danf3e",   parse_light_danf3e),
]

def aplicar_parsers(texto: str) -> dict:
    """Orquestra: router (nomenclatura) → parser ESPECÍFICO da dist; se o específico
    não validar, tenta o extrator de leitura (bloco técnico). Grava só _validado=True."""
    layout = rotear_layout(texto)
    fn = _PARSERS_DIRIGIDOS.get(layout)
    if fn:
        med = fn(texto)
        if not med["_validado"]:
            med = extrair_medicao_validada(texto)   # fallback leitura (Grupo A etc.)
    else:
        med = extrair_medicao_validada(texto)
    # fallback por ASSINATURA (rótulo de dist vem trocado no banco): cada parser
    # é auto-validado por fórmula; o 1º que provar a medição define o layout real.
    if not med["_validado"]:
        for nome, fn in _SIGNATURE:
            m2 = fn(texto)
            if m2["_validado"]:
                med = m2
                layout = nome
                break
    out = {"_layout": layout, "_medicao_validada": med["_validado"]}
    if med["_validado"]:
        for p in med["postos"]:
            seg = p["posto"]
            out[f"consumo_ativo_{seg}_kwh"] = p["consumo"]
            if seg == "fponta":
                out["leit_ant_ativa_fponta"] = p["ant"]
                out["leit_atu_ativa_fponta"] = p["atu"]
            elif seg == "ponta":
                out["leit_ant_ativa_ponta"] = p["ant"]
                out["leit_atu_ativa_ponta"] = p["atu"]
            if p["k"]: out["constante_k"] = p["k"]
            if p["medidor"]:
                # limpa artefato OCR/layout (` ou espaços) no início do nº do medidor
                out["numero_medidor"] = str(p["medidor"]).lstrip("`'\" ").strip()
    return out
