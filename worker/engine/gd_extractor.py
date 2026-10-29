#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gd_extractor — extração de GD/SCEE (injeção, compensada, saldo) por distribuidora.

Cada distribuidora escreve GD de um jeito distinto; este módulo roteia pelo nome
da distribuidora (já conhecido) e aplica o parser do layout. Devolve dict com:
  energia_injetada_kwh, energia_compensada_kwh, saldo_gd_ponta_kwh, saldo_gd_fponta_kwh
Só retorna o que conseguiu extrair (campos ausentes = não no texto).
Plugável no pdf_pipeline após a extração; valida/flag vs origem lá.
"""
import re

def _br(s):
    """'27.960,6929' -> 27960.69 ; '3571,00' -> 3571.0 ; '169.759,54' -> 169759.54"""
    if s is None:
        return None
    s = str(s).strip().replace(" ", "")
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    # sem vírgula: pontos podem ser milhar (3.571) — remove se grupos de 3
    elif re.match(r"^\d{1,3}(\.\d{3})+$", s):
        s = s.replace(".", "")
    try:
        return round(float(s), 2)
    except ValueError:
        return None

def _todos(pat, txt, g=1):
    return [_br(m.group(g)) for m in re.finditer(pat, txt, re.I) if _br(m.group(g)) is not None]

def _um(pat, txt, g=1):
    m = re.search(pat, txt, re.I)
    return _br(m.group(g)) if m else None

# ── parsers por layout ──────────────────────────────────────────────────────
def _cpfl_rge(t):
    # CPFL/RGE: injeção em "Energ Atv Inj. oUC ... - TUSD ... kWh N" (soma TUSD p/ não dobrar c/ TE)
    inj = _todos(r"Energ?\.?\s*At[ivo]*\s*Inj[\w.]*[^\n]*?TUSD[^\n]*?kWh\s+([\d.]+,\d+)", t)
    out = {}
    if inj:
        out["energia_injetada_kwh"] = round(sum(inj), 2)
    s = _um(r"Saldo em Energia da Instala[çc][ãa]o:\s*\w+\s+([\d.]+,\d+)", t)
    if s is not None:
        out["saldo_gd_fponta_kwh"] = s
    return out

def _copel(t):
    out = {}
    inj = _um(r"ENERGIA\s+INJ\.[^\n]*?TE[^\n]*?kWh\s+-?([\d.]+)", t)   # TE (não dobra c/ TUSD)
    if inj is not None:
        out["energia_injetada_kwh"] = abs(inj)
    return out

def _equatorial_go(t):
    out = {}
    comp = _um(r"CONSUMO\s+SCEE\s+kWh\s+([\d.]+,?\d*)", t)
    if comp is not None:
        out["energia_compensada_kwh"] = comp
    inj = _um(r"INJE[ÇC][ÃA]O\s+SCEE[^\n]*?kWh\s+([\d.]+,?\d*)", t)
    if inj is not None:
        out["energia_injetada_kwh"] = inj
    return out

def _equatorial_al(t):
    out = {}
    comp = _um(r"Consumo\s+Compensado\s*\(kWh\)\s+([\d.]+)", t)
    if comp is not None:
        out["energia_compensada_kwh"] = comp
    inj = _um(r"Energia\s+Inj\.?\s*oUC[^\n]*?\(kWh\)\s+([\d.]+)", t)
    if inj is not None:
        out["energia_injetada_kwh"] = inj
    sp = _um(r"Saldo\s+Acumulado\s+Geral\s+Ponta:\s*([\d.]+,?\d*)", t)
    sf = _um(r"Saldo\s+Acumulado\s+Geral\s+Fora\s+Ponta:\s*([\d.]+,?\d*)", t)
    if sp is not None: out["saldo_gd_ponta_kwh"] = sp
    if sf is not None: out["saldo_gd_fponta_kwh"] = sf
    return out

def _cemig(t):
    out = {}
    comp = _um(r"Energia\s+compensada\s+GD[^\n]*?kWh\s+([\d.]+)", t)
    if comp is not None:
        out["energia_compensada_kwh"] = comp
    m = re.search(r"SALDO\s+ATUAL\s+DE\s+GERA[ÇC][ÃA]O:\s*([\d.]+,?\d*)\s*kWh\s*FP[^\d]*([\d.]+,?\d*)\s*kWh\s*ponta", t, re.I)
    if m:
        out["saldo_gd_fponta_kwh"] = _br(m.group(1))
        out["saldo_gd_ponta_kwh"] = _br(m.group(2))
    return out

def _light(t):
    out = {}
    inj = _um(r"Energia\s+Injetada\s+GD[^\n]*?kWh\s+([\d.]+)", t)
    if inj is not None:
        out["energia_injetada_kwh"] = inj
    s = _um(r"Saldo\s+de\s+Cr[ée]ditos:\s*([\d.]+,?\d*)", t)
    if s is not None:
        out["saldo_gd_fponta_kwh"] = s
    return out

def _edp(t):
    # só linhas TUSD (não dobrar com TE): "0699 TUSD - En. At. Inj. ... kWh 1067,0352-"
    inj = _todos(r"TUSD\s*-\s*En\.?\s*At\.?\s*Inj[^\n]*?kWh\s+([\d.]+,\d+)\s*-", t)
    return {"energia_injetada_kwh": round(sum(inj), 2)} if inj else {}

def _coelba(t):
    out = {}
    comp = _um(r"cr[ée]ditos\s+utilizados\s+([\d.]+)", t)
    if comp is not None:
        out["energia_compensada_kwh"] = comp
    s = _um(r"Sal\s*do\s+para\s+o\s+pr[óo]ximo\s+ciclo\s+([\d.]+,?\d*)", t)
    if s is not None:
        out["saldo_gd_fponta_kwh"] = s
    return out

def _elektro(t):
    out = {}
    sf = _um(r"Saldo\s+Mes\s+F\s*Ponta\s+([\d.]+)", t)
    sp = _um(r"Saldo\s+Mes\s+Ponta\s+([\d.]+)", t)
    if sf is not None: out["saldo_gd_fponta_kwh"] = sf
    if sp is not None: out["saldo_gd_ponta_kwh"] = sp
    return out

def _generico_scee(t):
    """Fallback universal: patterns SCEE que aparecem em várias distribuidoras
    (DANF3E/Neoenergia/VIA VAREJO multi-dist). Usado quando o parser da dist não
    achou nada — captura literal, sem inventar."""
    out = {}
    # injeção: "Energia Injetada GD kWh -TUSD kWh 2.060" / "INJEÇÃO SCEE ... kWh N"
    inj = (_um(r"Energia\s+Injetada\s+GD[^\n]*?TUSD[^\n]*?kWh\s+([\d.]+,?\d*)", t)
           or _um(r"INJE[ÇC][ÃA]O\s+SCEE[^\n]*?kWh\s+([\d.]+,?\d*)", t))
    if inj is not None:
        out["energia_injetada_kwh"] = inj
    # compensada: "CONSUMO SCEE kWh N" / "creditos utilizados N"
    comp = (_um(r"CONSUMO\s+SCEE\s+kWh\s+([\d.]+,?\d*)", t)
            or _um(r"cr[ée]ditos\s+utilizados\s+([\d.]+,?\d*)", t))
    if comp is not None:
        out["energia_compensada_kwh"] = comp
    # saldo: "Sal do para o proximo ciclo N" / "Saldo de Créditos: N"
    s = (_um(r"Sal\s*do\s+para\s+o\s+pr[óo]ximo\s+ciclo\s+([\d.]+,?\d*)", t)
         or _um(r"Saldo\s+de\s+Cr[ée]ditos:\s*([\d.]+,?\d*)", t))
    if s is not None:
        out["saldo_gd_fponta_kwh"] = s
    return out

# ── roteador por distribuidora ───────────────────────────────────────────────
_ROTAS = [
    (("cpfl", "santa cruz", "rge", "paulista", "piratininga"), _cpfl_rge),
    (("copel",), _copel),
    (("equatorial goi", "enel goi", "equatorial go"), _equatorial_go),
    (("equatorial alagoas", "equatorial al"), _equatorial_al),
    (("cemig",), _cemig),
    (("light",), _light),
    (("edp",), _edp),
    (("coelba", "neoenergia"), _coelba),
    (("elektro",), _elektro),
]

# ── map-driven: lê a nomenclatura GD do mapa da distribuidora ─────────────────
_MAPA_NOME = [
    ("cemig", "cemig"), ("copel", "copel"),
    # Equatorial: GO próprio; AL/PA/MA/PI compartilham equatorial_norte
    ("equatorial goi", "equatorial_goias"),
    ("equatorial alag", "equatorial_norte"), ("equatorial piau", "equatorial_norte"),
    ("equatorial maranh", "equatorial_norte"), ("equatorial par", "equatorial_norte"),
    ("equatorial", "equatorial_norte"),
    ("edp", "edp"), ("light", "light"), ("elektro", "elektro_ms"),
    # Neoenergia: Coelba/PE/CELPE → família; Cosern próprio
    ("cosern", "neoenergia_cosern"),
    ("coelba", "neoenergia"), ("celpe", "neoenergia"), ("pernambuco", "neoenergia"),
    ("neoenergia", "neoenergia"),
    # Energisa por UF (mais específico primeiro)
    ("energisa mato grosso do sul", "energisa_ms"), ("energisa mato grosso", "energisa_mt"),
    ("energisa tocantins", "energisa_tocantins"),
    ("energisa sul-sudeste", "energisa_ss"), ("energisa sul sudeste", "energisa_ss"),
    ("energisa sergipe", "energisa_se"), ("energisa paraiba", "energisa_pb"),
    ("energisa minas rio", "energisa_mr_nf"), ("energisa minas", "energisa_mr_mg"),
    ("energisa", "energisa_mt"),
    ("santa cruz", "cpfl_santacruz"), ("cpfl", "cpfl_santacruz"), ("rge", "cpfl_santacruz"),
]
def _mapa_nome(dist):
    d = (dist or "").lower()
    for chave, nome in _MAPA_NOME:
        if chave in d:
            return nome
    return ""

# template_id do detector_layout (corpo+CNPJ) → mapa_nome
_TID_PARA_MAPA = [
    ("elektro", "elektro_ms"), ("cpfl", "cpfl_santacruz"), ("santacruz", "cpfl_santacruz"),
    ("copel", "copel"), ("celesc", "celesc"),
    ("energisa_ms", "energisa_ms"), ("energisa_mt", "energisa_mt"),
    ("energisa_tocantins", "energisa_tocantins"), ("energisa_ss", "energisa_ss"),
    ("energisa_se", "energisa_se"), ("energisa_mr", "energisa_mr_nf"), ("energisa", "energisa_mt"),
    ("cemig", "cemig"), ("edp_es", "edp_es"), ("edp", "edp"),
    ("neoenergia", "neoenergia"), ("coelba", "neoenergia"), ("celpe", "neoenergia"),
    ("equatorial_goias", "equatorial_goias"), ("equatorial_pa", "equatorial_norte"),
    ("equatorial", "equatorial_norte"), ("light", "light"),
]
def _mapa_nome_corpo(texto):
    """Detecta a dist pelo CORPO da fatura (detector_layout, ancora+CNPJ) →
    mapa_nome. Mais confiável que a coluna distribuidora (rótulo vem trocado)."""
    if not texto:
        return ""
    try:
        from detector_layout import detectar_layout
        tid = (detectar_layout(texto) or "").lower()
    except Exception:
        return ""
    if not tid or tid == "layout_desconhecido":
        return ""
    for sub, nome in _TID_PARA_MAPA:
        if sub in tid:
            return nome
    return ""

def _resolver_mapa_nome(texto, distribuidora):
    """Corpo primeiro (detector_layout), coluna distribuidora como fallback."""
    return _mapa_nome_corpo(texto) or _mapa_nome(distribuidora)

def _carregar_mapa(nome):
    """Carrega o mapa da dist DIRETO pelo nome (sem o alias de medição do
    aplicar_mapa, que redireciona copel→celesc etc.) — o gd_scee é por dist."""
    if not nome:
        return {}
    try:
        import os, json as _j
        from aplicar_mapa_distribuidora import MAPA_DIR
        for arq in (f"{nome}_extraction_map.json", f"{nome}_FAMILY_REGISTRY.json"):
            p = os.path.join(MAPA_DIR, arq)
            if os.path.exists(p):
                with open(p, encoding="utf-8") as f:
                    return _j.load(f)
    except Exception:
        pass
    return {}

def _aplicar_gd_scee(t, sec):
    """Aplica a seção 'gd_scee' do mapa (nomenclatura GD da dist) → agregados.
    Cada campo: {regex, group, multi(soma), abs}."""
    def val(f):
        d = sec.get(f)
        if not isinstance(d, dict) or not d.get("regex"):
            return None
        g = d.get("group", 1)
        if d.get("multi"):
            vs = [_br(m.group(g)) for m in re.finditer(d["regex"], t, re.I)
                  if _br(m.group(g)) is not None]
            return round(sum(abs(x) for x in vs), 2) if vs else None
        m = re.search(d["regex"], t, re.I)
        if not m:
            return None
        v = _br(m.group(g))
        return abs(v) if (v is not None and d.get("abs")) else v
    out = {}
    for campo, chave in (("injecao", "energia_injetada_kwh"),
                         ("compensada", "energia_compensada_kwh"),
                         ("saldo_ponta", "saldo_gd_ponta_kwh"),
                         ("saldo_fponta", "saldo_gd_fponta_kwh")):
        v = val(campo)
        if v is not None:
            out[chave] = v
    return out

def extrair_gd(texto, distribuidora=""):
    """Agregados GD. Prioridade: seção 'gd_scee' do mapa da dist (nomenclatura
    versionável) → parser embutido (_ROTAS) → fallback universal SCEE."""
    if not texto:
        return {}
    # 1. map-driven (gd_scee do mapa da dist) — dist resolvida pelo CORPO
    mapa = _carregar_mapa(_resolver_mapa_nome(texto, distribuidora))
    if isinstance(mapa.get("gd_scee"), dict):
        try:
            r = {k: v for k, v in _aplicar_gd_scee(texto, mapa["gd_scee"]).items()
                 if v is not None and v > 0}
            if r:
                return r
        except Exception:
            pass
    # 2. parser embutido por dist
    d = (distribuidora or "").lower()
    r = {}
    for chaves, fn in _ROTAS:
        if any(k in d for k in chaves):
            try:
                r = fn(texto)
            except Exception:
                r = {}
            break
    r = {k: v for k, v in (r or {}).items() if v is not None and v > 0}
    if not r:   # 3. fallback universal SCEE
        try:
            r = {k: v for k, v in _generico_scee(texto).items() if v is not None and v > 0}
        except Exception:
            r = {}
    return r

# ── linhas de injeção (detalhe 1-para-N: tipo mUC/oUC, mês, posto, kWh) ───────
_POSTO = {"opt": "ponta", "ppt": "ponta", "mpt": "fponta", "fpt": "fponta",
          "oup": "ponta", "fp": "fponta", "p1": "ponta"}
def _injecoes(t):
    out = []
    # padrão genérico: "...Inj[.] (oUC|mUC) <posto> ... <mes MM/AAAA>? ... kWh <N>[-]"
    pat = re.compile(
        r"Inj[\w.]*\s*(oUC|mUC|OUC|MUC)\s*(\w{2,4})?[^\n]*?"
        r"(?:(\d{2}/\d{4}))?[^\n]*?kWh\s+(-?[\d.]+,\d+)\s*-?", re.I)
    for m in pat.finditer(t):
        kwh = _br(m.group(4))
        if kwh is None or abs(kwh) < 0.01:
            continue
        tipo = "mUC" if m.group(1).lower().startswith("m") else "oUC"
        posto = _POSTO.get((m.group(2) or "").lower(), None)
        out.append({"tipo": tipo, "mes_origem": m.group(3), "posto": posto, "kwh": abs(kwh)})
    # dedupe par TUSD/TE (mesma injeção aparece nas 2 tarifas com kWh idêntico)
    visto, uniq = set(), []
    for x in out:
        k = (x["tipo"], x["mes_origem"], x["posto"], x["kwh"])
        if k in visto:
            continue
        visto.add(k); uniq.append(x)
    return uniq

_KW_ITEM = re.compile(r"SCEE|compensad|inje[çc]|injetad|gera[çc]|\bGD\b", re.I)
_UN_ITEM = re.compile(r"\b(kWh|MWh|kW|kVArh|kvar)\b", re.I)
_NUM_ITEM = re.compile(r"-?\d[\d.]*,\d+|-?\d[\d.]*")
def _itens_gd(t):
    """Cada linha de item relacionada a GD/SCEE, capturada LITERAL: descrição,
    unidade, quantidade, todos os números crus da linha (valores_raw, sem
    arredondar tarifa) e a linha original. Nada é descartado."""
    out = []
    for line in t.splitlines():
        line = line.strip()
        if len(line) < 6 or not _KW_ITEM.search(line):
            continue
        um = _UN_ITEM.search(line)
        unidade = um.group(1) if um else None
        desc = line[:um.start()].strip() if um else None
        tail = line[um.end():] if um else line
        nums = _NUM_ITEM.findall(tail)
        item = {
            "descricao": desc or None,
            "unidade": unidade,
            "quantidade": _br(nums[0]) if nums else None,
            "valores_raw": nums or None,   # strings exatas da fatura (tarifa full)
            "linha": line,
        }
        out.append({k: v for k, v in item.items() if v is not None})
    return out

_MES_ORD = {"JAN":1,"FEV":2,"MAR":3,"ABR":4,"MAI":5,"JUN":6,"JUL":7,"AGO":8,"SET":9,"OUT":10,"NOV":11,"DEZ":12}
_C = r"(\d{1,3}(?:\.\d{3})+|\d{4,6})"      # consumo: c/ milhar (13.680) OU 4-6 dígitos (3816)
_PAT_HIST = re.compile(
    r"\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/(\d{2,4})"
    r"\s+" + _C +                          # consumo
    r"\s+(\d{1,3}(?:\.\d{3})*,\d{2})"      # média kWh/dia (decimal BR)
    r"\s+(\d{1,2})\b", re.I)               # dias
# sem barra: 'JUN25 3816 29' (Coelba/Copel/Enel/Elektro)
_PAT_HIST_SL = re.compile(
    r"\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)(\d{2})"
    r"\s+" + _C + r"\s+(\d{1,2})\b", re.I)
# só consumo: 'JAN/25 5460' (Equatorial AL)
_PAT_HIST_C = re.compile(
    r"\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/(\d{2,4})"
    r"\s+" + _C + r"\b(?!\s*,)", re.I)
# Light Via Varejo: 'MAI/25 ------ 100 29' (separador de traços entre mês e consumo)
_PAT_HIST_DASH = re.compile(
    r"\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/(\d{2,4})"
    r"\s+-{2,}\s+(\d{2,6})\s+(\d{1,2})\b", re.I)
def _historico(t):
    """Histórico de consumo (até 13 meses), chave/valor: mes_ano, consumo_kwh,
    media_kwh_dia (quando há), dias (quando há). Cobre 3 layouts:
      A 'MMM/AA cons média dias' (CEMIG)  B 'MMM<AA> cons dias' (Coelba/Copel)
      C 'MMM/AA cons' (Equatorial AL, só consumo — fallback)."""
    out, seen = [], set()
    def add(mes, ano_raw, consumo, media=None, dias=None):
        ano = int(ano_raw) if len(ano_raw) == 4 else 2000 + int(ano_raw)
        if (mes, ano) in seen or consumo is None or consumo < 1 or consumo > 1_000_000:
            return
        seen.add((mes, ano))
        item = {"mes_ano": f"{mes}/{ano_raw}", "mes": mes, "ano": ano, "consumo_kwh": consumo}
        if media is not None: item["media_kwh_dia"] = media
        if dias is not None: item["dias"] = dias
        out.append(item)
    # A — completo (média + dias)
    for m in _PAT_HIST.finditer(t):
        d = int(m.group(5))
        if 25 <= d <= 35:
            add(m.group(1).upper(), m.group(2), _br(m.group(3)), _br(m.group(4)), d)
    # B — sem barra, com dias
    for m in _PAT_HIST_SL.finditer(t):
        d = int(m.group(4))
        if 25 <= d <= 35:
            add(m.group(1).upper(), m.group(2), _br(m.group(3)), None, d)
    # D — Light Via Varejo: 'MAI/25 ------ 100 29' (separador de traços)
    for m in _PAT_HIST_DASH.finditer(t):
        d = int(m.group(4))
        if 25 <= d <= 35:
            add(m.group(1).upper(), m.group(2), _br(m.group(3)), None, d)
    # E — horizontal 2 linhas (Elektro): linha de meses + linha de consumos acima
    if not out:
        linhas = t.split("\n")
        for i, ln in enumerate(linhas):
            meses = re.findall(r"\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/(\d{2,4})\b", ln, re.I)
            if len(meses) < 8 or i == 0:
                continue
            nums = re.findall(r"\b(\d{2,6})\b", linhas[i - 1])   # consumos na linha de cima
            if len(nums) < len(meses):
                continue
            for (mes, ano_raw), cons in zip(meses, nums[:len(meses)]):
                add(mes.upper(), ano_raw, _br(cons))
            if out:
                break
    # C — só consumo (fallback, só se nada acima pegou)
    if not out:
        for m in _PAT_HIST_C.finditer(t):
            add(m.group(1).upper(), m.group(2), _br(m.group(3)))
    out.sort(key=lambda h: (h["ano"], _MES_ORD.get(h["mes"], 0)), reverse=True)
    return out[:13]

_PAT_MED = re.compile(
    r"(Energia|Demanda|Reativ\w*)\s+(kWh|kW|kvarh|kVArh)\s+"
    r"([A-Z]{2,5}\d{5,})\s+"               # nº medidor
    r"([\d.]+)\s+([\d.]+)\s+"              # leit anterior / atual
    r"(\d{1,4})\s+"                        # constante de multiplicação
    r"(\d{1,3}(?:\.\d{3})*)\b", re.I)      # consumo
def _medicao(t):
    """Medição com constante, chave/valor: tipo, numero_medidor, leitura_anterior,
    leitura_atual, constante, consumo_kwh. Layout 'Energia kWh <medidor> <ant> <atu> <K> <cons>'."""
    m = _PAT_MED.search(t)
    if not m:
        return None
    return {"tipo": m.group(1), "unidade": m.group(2), "numero_medidor": m.group(3),
            "leitura_anterior": _br(m.group(4)), "leitura_atual": _br(m.group(5)),
            "constante": _br(m.group(6)), "consumo_kwh": _br(m.group(7))}

def _flags_do_mapa(sec):
    f = re.I
    if "MULTI" in str(sec.get("flags", "")).upper():
        f |= re.M
    return f

def _medicao_do_mapa(t, mapa):
    """Lê medicao_consumo do mapa (campos {regex, group}) → chave/valor."""
    sec = mapa.get("medicao_consumo")
    if not isinstance(sec, dict):
        return None
    out = {}
    campos = [("medidor", "numero_medidor", False), ("leitura_anterior", "leitura_anterior", True),
              ("leitura_atual", "leitura_atual", True), ("constante", "constante", True),
              ("consumo", "consumo_kwh", True)]
    for campo, chave, num in campos:
        d = sec.get(campo)
        if not isinstance(d, dict) or not d.get("regex"):
            continue
        m = re.search(d["regex"], t, re.I)
        if m:
            v = m.group(d.get("group", 1))
            out[chave] = _br(v) if num else (v.strip() if v else None)
    return {k: v for k, v in out.items() if v is not None} or None

def _itens_do_mapa(t, mapa):
    """Lê tabela_itens_fatura do mapa: aplica regex_linha + rotula por
    colunas_em_ordem. Valores RAW (strings exatas, tarifa sem arredondar)."""
    sec = mapa.get("tabela_itens_fatura")
    if not isinstance(sec, dict) or not sec.get("regex_linha"):
        return []
    cols = sec.get("colunas_em_ordem") or []
    out = []
    for m in re.finditer(sec["regex_linha"], t, _flags_do_mapa(sec)):
        g = list(m.groups())
        item = {"linha": (m.group(0) or "").strip()}
        if cols:
            for col, val in zip(cols, g):
                if val is not None and str(val).strip():
                    item[col] = val.strip() if isinstance(val, str) else val
        else:
            item["valores_raw"] = [x for x in g if x]
        out.append(item)
    return out

_MESES_SEQ = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"]
# tabela de histórico em markdown sem rótulo de mês: 'NNNN,00 DD LIDA' (Equatorial GO/EDP markitdown)
_PAT_MD_LIDA = re.compile(r"(\d[\d.]*),\d{2}\s+(\d{1,2})\s*\|?\s*(LIDA|ESTIMAD\w*|MEDID\w*)", re.I)
def _mes_menos(ano, mes, k):
    """k meses antes de (ano, mes) → (MES3, ano)."""
    idx = (mes - 1) - k
    return _MESES_SEQ[idx % 12], ano + (idx // 12)
def _historico_md_tabela(md, mes_ref):
    """Histórico em tabela markdown sem mês ('NNNN,00 DD LIDA'), em ordem
    recente→antigo. Infere o mês contando pra trás a partir de mes_referencia
    (1ª linha = mês de referência)."""
    if not md or not mes_ref:
        return []
    mm = re.match(r"(\d{4})-(\d{2})", str(mes_ref))
    if not mm:
        return []
    ano0, mes0 = int(mm.group(1)), int(mm.group(2))
    out = []
    for i, m in enumerate(_PAT_MD_LIDA.finditer(md)):
        cons = _br(m.group(1))
        if cons is None or cons < 1 or i >= 13:
            continue
        mes, ano = _mes_menos(ano0, mes0, i)
        out.append({"mes_ano": f"{mes}/{str(ano)[2:]}", "mes": mes, "ano": ano,
                    "consumo_kwh": cons, "dias": int(m.group(2)),
                    "status": m.group(3).upper(), "_fonte": "markdown_lida"})
    return out

_MES3 = re.compile(r"^(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)$", re.I)
def _historico_do_mapa(t, mapa):
    """Lê historico_consumo do mapa (regex_linha) e normaliza pra chave/valor:
    junta mês+ano em mes_ano, e rotula consumo_kwh / dias por heurística (ou
    pelas 'colunas' do mapa quando existirem). Mantém valores_raw + linha."""
    sec = mapa.get("historico_consumo")
    if not isinstance(sec, dict) or not sec.get("regex_linha"):
        return []
    cols = sec.get("colunas")
    out = []
    for m in re.finditer(sec["regex_linha"], t, _flags_do_mapa(sec)):
        g = [x for x in m.groups() if x is not None]
        if not g:
            continue
        item = {"linha": (m.group(0) or "").strip()}
        if cols:                                  # mapa rotula os grupos
            for col, val in zip(cols, m.groups()):
                if val is not None:
                    item[col] = val
            out.append(item); continue
        # mês/ano: 'JUN'+'25' → 'JUN/25', ou já 'JUN/25'
        mes_ano, resto = g[0], g[1:]
        if _MES3.match(g[0]) and resto and re.fullmatch(r"\d{2,4}", resto[0]):
            mes_ano = f"{g[0].upper()}/{resto[0]}"; resto = resto[1:]
        item["mes_ano"] = mes_ano
        # consumo = maior inteiro plausível; dias = inteiro 25-35
        nums = [(_br(x), x) for x in resto if _br(x) is not None]
        dias = next((int(v) for v, _ in nums if 25 <= v <= 35 and float(v).is_integer()), None)
        cons = max((v for v, _ in nums if v >= 1 and (dias is None or v != dias)), default=None)
        if cons is not None: item["consumo_kwh"] = cons
        if dias is not None: item["dias"] = dias
        item["valores_raw"] = [x for x in resto]
        out.append(item)
    return out[:13]

def _merge_itens(map_itens, gd_itens):
    """União dedup por linha (normalizada): itens gerais do mapa + linhas GD."""
    def norm(x):
        return re.sub(r"\s+", " ", (x.get("linha") or "")).strip().lower()
    vistos = {norm(i) for i in map_itens}
    out = list(map_itens)
    for it in gd_itens:
        if norm(it) not in vistos:
            out.append(it)
            vistos.add(norm(it))
    return out

def _f(v):
    """num BR/str/num -> float ou None."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return _br(v)

def extrair_gd_raw_do_json(raw_json):
    """PROJETA o extracao_gd_raw a partir do extracao_raw_json que o pipeline
    (extrator_v3 + complementar) JÁ extraiu — sem regex novo. Lê geracao_distribuida,
    gd_scee, itens_fatura[eh_credito_gd] e historico_13m_consumo.
    raw_json: dict OU string JSON. Retorna dict ou None."""
    if not raw_json:
        return None
    if isinstance(raw_json, str):
        try:
            import json as _j
            raw_json = _j.loads(raw_json)
        except Exception:
            return None
    v = (raw_json.get("regex_v3", {}) or {}).get("v2", {}) or raw_json.get("v2", {}) or raw_json
    if not isinstance(v, dict):
        return None
    gd = v.get("geracao_distribuida") or {}
    sc = v.get("gd_scee") or {}
    itens = v.get("itens_fatura") or []

    # créditos GD (itens marcados eh_credito_gd) — são COMPENSAÇÃO/injeção aplicada,
    # com posto e qtd já parseados. tipo mUC (própria) vs oUC (outra UC/geradora).
    creditos = []
    for it in itens:
        if not it.get("eh_credito_gd"):
            continue
        desc = (it.get("descricao") or "")
        dl = desc.lower()
        tipo = "mUC" if "muc" in dl else ("oUC" if "ouc" in dl else None)
        kwh = abs(it["quantidade_numerica"]) if it.get("quantidade_numerica") is not None else None
        creditos.append({
            "tipo": tipo, "posto": it.get("posto"), "kwh": kwh,
            "valor_rs": it.get("valor_brl_numerico"),
            "tarifa": it.get("tarifa_unit_aneel_numerica"),
            "descricao": desc,
        })

    raw = {
        "tem_gd": gd.get("tem_gd"),
        # INJETADA = energia que uma geradora (oUC) injetou no ciclo. NÃO usar gd_scee.injecao
        # (que é compensação mUC na ponta). 0 quando só há saldo próprio.
        "energia_injetada_kwh": _f(gd.get("energia_injetada_kwh")),
        # COMPENSADA = energia abatida por crédito. Total confiável vem do bloco GD;
        # muc = parcela de compensação própria. Detalhe por linha em creditos_gd
        # (posto dos itens vem mal rotulado, por isso não derivo ponta/fponta aqui).
        "energia_compensada_total_kwh": _f(gd.get("energia_compensada_kwh")),
        "energia_compensada_muc_kwh": _f(gd.get("energia_compensada_muc_kwh")),
        "saldo_acumulado_ponta_kwh": _f(gd.get("saldo_acumulado_ponta_kwh")) or _f(sc.get("saldo_ponta")),
        "saldo_acumulado_fora_ponta_kwh": _f(gd.get("saldo_acumulado_fora_ponta_kwh")) or _f(sc.get("saldo_fponta")),
        "alerta_sem_ouc": gd.get("alerta_sem_oUC"),
        "compensacao_propria_muc": gd.get("compensacao_propria_mUC"),
        "saldo_a_expirar": gd.get("saldo_a_expirar"),
        "creditos_gd": creditos,
        "historico": v.get("historico_13m_consumo") or v.get("historico_13m_regex"),
        "distribuidora": (v.get("distribuidora") or {}).get("razao_social") if isinstance(v.get("distribuidora"), dict) else None,
        "_fonte": "extracao_raw_json",
    }
    raw = {k: x for k, x in raw.items() if x is not None and x != [] and x != {}}
    # só retorna se houver sinal de GD real
    if not (raw.get("tem_gd") or raw.get("energia_injetada_kwh") or raw.get("energia_compensada_total_kwh")
            or raw.get("saldo_acumulado_fora_ponta_kwh") or raw.get("creditos_gd")):
        return None
    return raw

def extrair_gd_raw(texto, distribuidora="", texto_md="", mes_ref=""):
    """JSON do GD com TODOS os dados raw capturados na fatura (sem cálculo que
    esconda dado). Cada injeção vira uma linha com sua identificação mUC/oUC,
    posto e kWh exatamente como saiu do texto. Os agregados/saldos guardados são
    só os que a própria fatura imprime (capturados literalmente). A view soma as
    linhas para exibir totais — o JSON preserva o detalhe.
    texto_md/mes_ref: markdown + mês de referência, p/ histórico que só aparece
    na tabela markitdown sem rótulo de mês (Equatorial GO etc.).
    Gravado em FDE.extracao_gd_raw (chave/valor)."""
    if not texto and not texto_md:
        return None
    mapa = _carregar_mapa(_resolver_mapa_nome(texto, distribuidora))
    agg = extrair_gd(texto, distribuidora)   # valores literais impressos na fatura
    inj = _injecoes(texto)                   # 1 linha por injeção (raw, dedup TUSD/TE)
    # itens: do mapa (gerais, rotulados) ∪ linhas GD/SCEE; fallback embutido
    itens = _merge_itens(_itens_do_mapa(texto, mapa), _itens_gd(texto))
    # histórico: plumber embutido (limpo) → mapa (regex dist) → tabela markdown
    historico = (_historico(texto) or _historico_do_mapa(texto, mapa)
                 or _historico_md_tabela(texto_md, mes_ref))
    # medição: do mapa (campos da dist) → fallback embutido
    medicao = _medicao_do_mapa(texto, mapa) or _medicao(texto)
    if not agg and not inj and not itens and not historico and not medicao:
        return None
    raw = {
        # ── histórico de consumo (13 meses) e medição com constante ──
        "historico": historico,
        "medicao": medicao,
        # ── linhas de item GD/SCEE da fatura, literais (descrição + nºs crus) ──
        "itens": itens,
        # ── linhas raw de injeção (cada uma já marcada mUC/oUC) ──
        "injecoes": inj,
        # ── valores literais impressos na fatura (não derivados) ──
        "injetada_total_kwh": agg.get("energia_injetada_kwh"),
        "compensada_total_kwh": agg.get("energia_compensada_kwh"),
        "saldo_ponta_kwh": agg.get("saldo_gd_ponta_kwh"),
        "saldo_fponta_kwh": agg.get("saldo_gd_fponta_kwh"),
        "distribuidora": distribuidora or None,
    }
    return {k: v for k, v in raw.items() if v is not None and v != []}
