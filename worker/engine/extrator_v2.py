"""extrator_v2.py — Pipeline determinístico SEM IA (versão melhorada).

Camadas:
  1. TEXTO     — pdfplumber > markdown > ocr (cascata, melhor disponível)
  2. REGEX     — aplica ia/map/*.json (com chain de fallbacks)
  3. TABELAS   — pdfplumber.extract_tables() para itens + histórico
  4. QUADRO GD — anchor + regex BR-aware para Saldo Ac, mUC, classificação
  5. AUDITORIA — Python puro (fator ajuste, validações, conservação)

Custo: R$ 0 por fatura.
Tempo: ~100-300ms por fatura.

Uso:
    from extrator_v2 import FaturaExtractorV2
    out = FaturaExtractorV2(fatura_id=52391).extrair_tudo()
"""
import os, json, re, glob, sys
from typing import Optional, Tuple
import mysql.connector

# Aho-Corasick fallback (opcional — degrada para regex se ausente)
try:
    from aho_scoring import detectar_subgrupo as _ac_subgrupo
    from aho_scoring import detectar_modalidade as _ac_modalidade
    from aho_scoring import detectar_distribuidora as _ac_distribuidora
    _AC_DISPONIVEL = True
except ImportError:
    _AC_DISPONIVEL = False

# Templates bbox por distribuidora (opcional — só se PDF disponível)
try:
    from template_extractor import aplicar_template as _template_aplicar
    _TEMPLATE_DISPONIVEL = True
except ImportError:
    _TEMPLATE_DISPONIVEL = False

# Seleção de template: mapa+grupo+modalidade → template_nome
# Estrutura: { (mapa, grupo, modalidade_lower): template_nome }
# Fallback: (mapa, None, None) é o template default da dist
_TEMPLATE_INDEX = {
    # CEMIG
    ("cemig", "B", "convencional"): "cemig_b_convencional",
    ("cemig", "A", "verde"):        "cemig_a_verde",
    ("cemig", None, None):          "cemig_b_convencional",
    # LIGHT
    ("light", "B", "convencional"): "light_b_convencional",
    ("light", "A", "verde"):        "light_a_verde",
    ("light", None, None):          "light_b_convencional",
    # ELEKTRO
    ("elektro_ms", "B", "convencional"): "elektro_sp_b_convencional",
    ("elektro_ms", None, None):          "elektro_sp_b_convencional",
    # COPEL / CELESC
    ("celesc", "B", "convencional"): "copel_b_convencional",
    ("celesc", "A", "verde"):        "copel_a_verde",
    ("celesc", None, None):          "copel_b_convencional",
    # CPFL
    ("cpfl_santacruz", "B", "convencional"): "cpfl_paulista_b_convencional",
    ("cpfl_santacruz", "A", "verde"):        "cpfl_paulista_a_verde",
    ("cpfl_santacruz", None, None):          "cpfl_paulista_b_convencional",
    # EDP
    ("edp", "B", "convencional"): "edp_sp_b_convencional",
    ("edp", "A", "verde"):        "edp_sp_a_verde",
    ("edp", None, None):          "edp_sp_a_verde",
    # ENEL SP / Rio
    ("enel_sp", "A", "verde"):        "enel_sp_a_verde",
    ("enel_sp", "B", "convencional"): "enel_sp_b_convencional",
    ("enel_sp", "A", "azul"):         "enel_sp_a_azul",
    ("enel_sp", None, None):          "enel_sp_a_verde",
    # ENERGISA MT/MS
    ("energisa_mt", "B", "convencional"): "energisa_mt_b_convencional",
    ("energisa_mt", None, None):          "energisa_mt_b_convencional",
    ("energisa_ms", "B", "convencional"): "energisa_ms_b_convencional",
    # NEOENERGIA
    ("neoenergia_cosern", "B", "convencional"): "neoenergia_pe_b_convencional",
    ("neoenergia_cosern", "A", "verde"):        "neoenergia_ba_a_verde",
    ("neoenergia_cosern", None, None):          "neoenergia_pe_b_convencional",
    # Equatorial
    ("equatorial_norte", "B", "convencional"): "equatorial_pa_b_conv",
    ("equatorial_goias", "B", "convencional"): "equatorial_go_b_conv",
    ("equatorial_goias", "A", "verde"):        "equatorial_go_a_verde",
    # #118: removidas 2 chaves duplicadas (cpfl_santacruz/celesc B convencional) que
    # repetiam — com mesmo valor — entradas já definidas acima (linhas ~53/57). Eram
    # inofensivas (Python mantinha a última = mesmo valor), só poluíam o dict.
    # RGE B Conv (mapa cpfl_santacruz)
    ("rge", "B", "convencional"): "rge_b_convencional",
}


def _resolver_template(mapa: str, dados: dict) -> str:
    """Escolhe template baseado em mapa + subgrupo + modalidade extraídos."""
    if not mapa: return None
    mapa_l = mapa.lower()
    lig = dados.get("ligacao_tecnica") or {}
    sub = (lig.get("subgrupo") or "").upper()
    mod = (lig.get("modalidade_tarifaria") or "").lower()
    grupo = "A" if sub.startswith("A") else ("B" if sub.startswith("B") else None)
    # 1) Match exato (mapa, grupo, modalidade)
    key = (mapa_l, grupo, mod)
    if key in _TEMPLATE_INDEX:
        return _TEMPLATE_INDEX[key]
    # 2) Match parcial só (mapa, grupo, *)
    for k, v in _TEMPLATE_INDEX.items():
        if k[0] == mapa_l and k[1] == grupo and k[2] is None:
            return v
    # 3) Default da dist (mapa, None, None)
    return _TEMPLATE_INDEX.get((mapa_l, None, None))


# Retrocompat (algumas chamadas antigas usam _MAPA_TO_TEMPLATE direto)
_MAPA_TO_TEMPLATE = {k[0]: v for k, v in _TEMPLATE_INDEX.items() if k[1] is None}


_MAP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "map")


# ============================================================
# CNPJ raiz → arquivo do mapa (whitelist de DISTRIBUIDORAS)
# ============================================================
CNPJ_RAIZ_TO_MAPA = {
    # Energisa
    "03.467.321": "energisa_mt",
    "15.413.826": "energisa_ms",
    "09.095.183": "energisa_pb",
    "13.017.462": "energisa_se",
    "07.222.521": "energisa_ss",
    "07.282.379": "energisa_ss",       # variante (SS)
    "25.086.034": "energisa_tocantins",
    "19.527.639": "energisa_mr_mg",
    "06.981.176": "energisa_mr_mg",
    # Cemig
    "06.981.180": "cemig",
    # CPFL — usa mesmo mapa cpfl_santacruz como fallback (estrutura similar)
    "33.884.529": "cpfl_santacruz",
    "33.050.196": "cpfl_santacruz",    # CPFL Paulista
    "04.172.213": "cpfl_santacruz",    # CPFL Piratininga
    # Celesc
    "08.336.783": "celesc",
    # ENEL
    "61.695.227": "enel_sp",
    "33.050.071": "enel_rio",          # ENEL RJ (Ampla) — mapa próprio (família ENEL moderno)
    "07.047.251": "enel_ce",           # ENEL CE (Coelce) — mapa próprio (família ENEL moderno)
    # EDP
    "28.152.650": "edp",               # EDP ES
    "02.302.100": "edp",               # EDP SP (Bandeirantes)
    # Equatorial
    "01.543.032": "equatorial_goias",
    "04.895.728": "equatorial_norte",  # CELPA (PA)
    "06.272.793": "equatorial_norte",  # CEMAR (MA)
    "06.840.748": "equatorial_norte",  # CEPISA (PI)
    "12.157.084": "equatorial_norte",  # CEAL (AL)
    "92.715.812": "equatorial_norte",  # CEEE (RS)
    # LIGHT
    "60.444.437": "light",
    # 33.041.260 REMOVIDO — esse é o CNPJ raiz do CLIENTE (VIA VAREJO), não da Light!
    # Levava várias dists (Equatorial, Celesc) a serem detectadas erroneamente como light
    # NEOENERGIA
    "08.324.196": "neoenergia_cosern",
    "15.139.629": "neoenergia_cosern", # Coelba (BA) — usa fallback
    "10.835.932": "neoenergia_cosern", # Celpe (PE)
    "07.522.669": "neoenergia_cosern", # CEB Brasília
    "02.328.280": "elektro_ms",        # Elektro Redes SP (Neoenergia) — mapa elektro_ms cobre o layout
    # COPEL
    "04.368.898": "celesc",            # COPEL — usa celesc como fallback; hidratação hardcoded detecta COPEL no texto
    # Outros
    "02.341.467": "amazonas",
    "23.664.303": "dmed",
    "88.567.751": "demei",
    "02.016.439": "cpfl_santacruz",    # RGE
    "02.016.440": "cpfl_santacruz",    # RGE Sul
    # CNPJs adicionais identificados em produção (task #187)
    # REMOVIDO: "60.765.823" — era CNPJ do CLIENTE (Hospital Albert Einstein), não ENEL SP. Causava falso-positivo em faturas CPFL.
    "61.695.277": "enel_sp",           # ENEL SP typo (227 vs 277)
    "08.467.115": "equatorial_norte",  # CEEE (RS) — Equatorial
    "12.272.084": "equatorial_norte",  # CEAL (AL) — Equatorial
    "07.282.377": "energisa_ss",       # Energisa Sul-Sudeste variante
    "53.859.112": "cpfl_santacruz",    # CPFL Santa Cruz variante
    "08.826.596": "energisa_pb",       # Energisa PB variante
    "33.249.046": "energisa_mr_mg",    # Energisa MR variante
    "95.289.500": "demei",             # DEMEI
    # SULGIPE não tem mapa específico, usa demei como fallback (ambos micro-distribuidoras)
    "13.255.658": "demei",             # SULGIPE
}

# Marcadores textuais que indicam contexto de DISTRIBUIDORA (não cliente)
_MARCADORES_DISTRIBUIDORA = [
    "DISTRIBUIDORA",
    "ENERGIA S.A",
    "ENERGIA S/A",
    "DANF3E",
    "ENERGIA ELÉTRICA",
    "DOCUMENTO AUXILIAR DA NOTA FISCAL",
    "Insc. Est.",
]


# ============================================================
# Normalização BR
# ============================================================
def to_float_br(s):
    """Converte string BR ('1.234,56' / '347.057' / '5,25') para float.

    Heurística: se tem '.' seguido de exatamente 3 dígitos sem ',' depois → milhar BR.
    """
    if s is None or s == "": return None
    if isinstance(s, (int, float)): return float(s)
    s = str(s).strip().replace("R$", "").replace("kWh", "").strip()
    if not s or s == "-": return None

    # Casos:
    # "1.234,56"   → 1234.56 (milhar + decimal)
    # "347.057"    → 347057  (milhar, sem decimal — heurística 3 dígitos)
    # "5,25"       → 5.25    (decimal puro)
    # "347,057"    → 347.057 (decimal raro mas possível)
    # "1234"       → 1234

    if "," in s and "." in s:
        # Misto: vírgula é decimal, ponto é milhar
        if s.rfind(",") > s.rfind("."):
            return float(s.replace(".", "").replace(",", "."))
        # ',' antes de '.' é absurdo, manter
        return None

    if "." in s and "," not in s:
        # Só ponto: pode ser milhar OU decimal
        partes = s.split(".")
        # Heurística: se TODAS as partes após a primeira têm exatamente 3 dígitos → milhar
        if len(partes) >= 2 and all(len(p) == 3 and p.isdigit() for p in partes[1:]):
            try: return float(s.replace(".", ""))
            except: return None
        # Senão tratar como decimal
        try: return float(s)
        except: return None

    if "," in s and "." not in s:
        # Só vírgula: decimal BR
        try: return float(s.replace(",", "."))
        except: return None

    try: return float(s)
    except: return None


def to_int_br(s):
    f = to_float_br(s)
    return int(f) if f is not None else None


# ============================================================
# Regex helpers
# ============================================================
def aplicar_spec(spec: dict, texto: str):
    """Aplica regex spec (anchor + regex + group + flags + chain)."""
    if not isinstance(spec, dict): return None

    # Chain: tenta cada spec até achar match
    if "chain" in spec:
        for s in spec["chain"]:
            val = aplicar_spec(s, texto)
            if val: return val
        return None

    regex = spec.get("regex")
    if not regex: return None
    flags = re.IGNORECASE | re.MULTILINE
    if "flags" in spec:
        flags_str = str(spec["flags"]).upper()
        if "DOTALL" in flags_str: flags |= re.DOTALL
    try:
        m = re.search(regex, texto, flags)
    except re.error:
        return None
    if not m: return None

    group = spec.get("group", 1)
    if isinstance(group, str):
        if "+" in group:
            partes = group.split("+")
            try:
                return " ".join(m.group(int(p)) for p in partes if p.isdigit())
            except: return None
        if "-" in group:
            return m.group(0)
        if group == "linha-1":
            return m.group(0)
        try: return m.group(int(group))
        except: return m.group(0)
    try: return m.group(group)
    except: return None


# ============================================================
# PyMuPDF — extrai blocos do PDF para encontrar quadros pequenos
# ============================================================
def extrair_blocos_pdf(pdf_path: str) -> list:
    """Retorna lista de (texto, x0, y0, x1, y1, pag_num) de cada bloco do PDF."""
    try:
        import fitz
    except ImportError:
        return []
    blocos = []
    try:
        doc = fitz.open(pdf_path)
        for pag_num, page in enumerate(doc):
            for b in page.get_text("blocks") or []:
                if len(b) >= 5 and isinstance(b[4], str):
                    blocos.append((b[4].strip(), b[0], b[1], b[2], b[3], pag_num))
        doc.close()
    except Exception:
        pass
    return blocos


def extrair_saldo_blocos(blocos: list) -> dict:
    """Procura saldo GD em blocos pequenos do PDF (quadro Atenção etc)."""
    out = {}
    for txt, x0, y0, x1, y1, pag in blocos:
        if not txt: continue
        # Bloco pequeno (típico de quadro lateral/atenção)
        if (x1-x0) > 500 or (y1-y0) > 300: continue
        if not re.search(r'saldo|atencao|atenção|cr[ée]dito|injetad', txt, re.I): continue
        # Tenta padrões de saldo
        for pat in [
            r'Saldo\s*Ac\.?\s*:?\s*([\d.,]+)\s*\(\s*P\s*\)\s*([\d.,]+)\s*\(\s*FP\s*\)',
            r'Saldo[^\n]*?([\d.,]+)\s*\(P\)\s*([\d.,]+)\s*\(FP\)',
            r'(?:Saldo\s*de\s*)?cr[ée]ditos[^\n]*?Ponta\s*[:=]?\s*([\d.,]+)[^\n]*?Fora\s*Ponta\s*[:=]?\s*([\d.,]+)',
        ]:
            m = re.search(pat, txt, re.I)
            if m:
                out["saldo_ponta_kwh"] = to_float_br(m.group(1))
                out["saldo_fora_ponta_kwh"] = to_float_br(m.group(2))
                out["fonte"] = "pymupdf_block"
                out["bloco_pag"] = pag
                return out
        # Padrão expirar
        m = re.search(r'A\s+expirar\s+em\s+(\d{2}/\d{4})\s*:?\s*([\d.,]+)\s*\(?P\)?\s*([\d.,]+)\s*\(?FP', txt, re.I)
        if m:
            out["expirar"] = {"data": m.group(1), "p": to_float_br(m.group(2)), "fp": to_float_br(m.group(3))}
    return out


# ============================================================
# Quadro GD — anchor + regex BR-aware
# ============================================================
def extrair_quadro_gd(texto: str) -> dict:
    """Extrai Saldo Ac, Saldo a Expirar, classificação GD, mUC.

    Padrões esperados (variantes BR):
      'UC com Minigeracao classificada como GD_I para faturamento, conforme Lei 14.300/22'
      'Saldo Ac.: 0(P) 347.057(FP) A expirar em 05/2026: 0(P) 0(FP)'
      'Saldo de creditos de energia injetada acumulado: 0(P) 347.057(FP)'
    """
    out = {
        "classificacao": None,
        "lei_referencia": None,
        "saldo_acumulado_ponta_kwh": None,
        "saldo_acumulado_fora_ponta_kwh": None,
        "saldo_acumulado_intermediario_kwh": None,
        "saldo_a_expirar": [],
        "tem_gd": False,
    }

    # Classificação
    m = re.search(r"(?:GD[\s_-]?I{1,3}|MICROGERA|MINIGERA)", texto, re.I)
    if m:
        s = m.group(0).upper().replace("-", "_").replace(" ", "_")
        if "GD_III" in s or "GDIII" in s: out["classificacao"] = "GD_III"
        elif "GD_II" in s or "GDII" in s: out["classificacao"] = "GD_II"
        elif "GD_I" in s or "GDI" in s: out["classificacao"] = "GD_I"
        elif "MICRO" in s: out["classificacao"] = "MICRO"
        elif "MINI" in s: out["classificacao"] = "MINI"
        out["tem_gd"] = True

    # Fallback: detecta GD sem classificação explícita (LIGHT: "Energia Injetada GD kWh")
    # Sinaliza tem_gd=True e classificação=GD (genérico)
    if not out["tem_gd"]:
        if re.search(r"Energia\s+(?:Injetada|Fornecida|Compensada)\s+GD\b", texto, re.I):
            out["tem_gd"] = True
            out["classificacao"] = "GD"
        elif re.search(r"\bSCEE\b", texto, re.I):
            out["tem_gd"] = True
            out["classificacao"] = "GD"

    # Lei
    m = re.search(r"Lei\s+(?:n[º°.]?\s*)?(14\.?300/(?:20)?22)", texto, re.I)
    if m: out["lei_referencia"] = "Lei 14.300/22"

    # Saldo Acumulado — variantes por distribuidora
    padroes_saldo = [
        # Energisa MT / família Energisa
        r"Saldo\s+Ac\.?\s*:?\s*([\d.,]+)\s*\(\s*P\s*\)\s*([\d.,]+)\s*\(\s*FP\s*\)",
        # CEMIG modern: "SALDO ATUAL DE GERAÇÃO: 25.038,05 kWh FP/Único, 1.230,60 kWh ponta"
        # ATENÇÃO ordem: FP vem antes de ponta → grupo 1=FP, grupo 2=P → inverter!
        r"SALDO\s+ATUAL\s+DE\s+GERA[ÇC][ÃA]O\s*:?\s*([\d.,]+)\s*kWh\s+(?:FP|F\.?Ponta|Fora\s*Ponta)[^,\n]*,\s*([\d.,]+)\s*kWh\s+(?:P|Ponta)\b",
        # CEMIG: "Saldo de Geração Distribuída em kWh — P: XXX FP: XXX"
        r"Saldo\s+de\s+Gera[çc][ãa]o\s+Distribu[íi]da[^:]*[:\-]\s*P\s*[:=]\s*([\d.,]+)[^\n]*?FP\s*[:=]\s*([\d.,]+)",
        # CPFL/ENEL: "Saldo créditos ponta XXX / fora ponta XXX"
        r"Saldo[^:\n]*?cr[ée]ditos[^:\n]*?Ponta\s*[:=]?\s*([\d.,]+)[^\n]*?Fora\s*Ponta\s*[:=]?\s*([\d.,]+)",
        # EDP: "Saldo de Energia: Ponta XXX kWh / Fora Ponta XXX kWh"
        r"Saldo\s+de\s+Energia[^:]*[:\-]\s*Ponta\s+([\d.,]+)\s*kWh[^\n]*?Fora\s*Ponta\s+([\d.,]+)\s*kWh",
        # Equatorial: "Créditos disponíveis P: XXX FP: XXX"
        r"Cr[ée]ditos\s+(?:dispon[íi]veis|acumulados)[^:]*?P\s*[:=]\s*([\d.,]+)[^\n]*?FP\s*[:=]\s*([\d.,]+)",
        # Light: "Banco créditos energia kWh ponta XXX fora ponta XXX"
        r"Banco\s+de?\s*cr[ée]ditos[^\n]*?ponta\s+([\d.,]+)[^\n]*?fora\s*ponta\s+([\d.,]+)",
        # LIGHT: 'SALDO ATUAL GERAÇÃO DISTRIBUÍDA 0 PONTA Kwh, 214.445 FORA PONTA Kwh'
        r"SALDO\s+ATUAL\s+GERA[ÇC][ÃA]O\s+DISTRIBU[ÍI]DA\s*([\d.,]+)\s*PONTA[^\d]*([\d.,]+)\s*FORA\s+PONTA",
        # COPEL/ELEKTRO SP/Neoenergia: 'Saldo Acumulado Ponta X ... Saldo Acumulado F Ponta Y'
        r"Saldo\s+Acumulado\s+Ponta\s+([\d.,]+)[^\n]{0,100}?Saldo\s+Acumulado\s+F\s*Ponta\s+([\d.,]+)",
        # Genérico
        r"Saldo[^:]*?:\s*([\d.,]+)\s*\(?\s*P[\s)]?\s*([\d.,]+)\s*\(?\s*FP[\s)]?",
        # P=X FP=Y
        r"P\s*[=:]\s*([\d.,]+)\s*(?:kWh)?\s*[/|]?\s*FP\s*[=:]\s*([\d.,]+)",
        # Posto único (Grupo B)
        r"Saldo[^:]*?(?:de\s*)?cr[ée]ditos[^:]*?(?:disponível|atual|acumulado)\s*[:=]?\s*([\d.,]+)\s*kWh",
    ]
    for i, pat in enumerate(padroes_saldo):
        m = re.search(pat, texto, re.I)
        if m:
            # CEMIG pattern (idx 1) tem ordem invertida: FP, P
            if i == 1:
                out["saldo_acumulado_fora_ponta_kwh"] = to_float_br(m.group(1))
                out["saldo_acumulado_ponta_kwh"] = to_float_br(m.group(2))
            else:
                out["saldo_acumulado_ponta_kwh"] = to_float_br(m.group(1))
                out["saldo_acumulado_fora_ponta_kwh"] = to_float_br(m.group(2))
            out["tem_gd"] = True
            break

    # Saldo posto único (Grupo B Convencional / LIGHT B / etc)
    if not out.get("saldo_acumulado_fora_ponta_kwh") and not out.get("saldo_acumulado_ponta_kwh"):
        for pat_uno in [
            # ENERGISA moderno: 'Saldo Acumulado: 18.628 A expirar'
            r"Saldo\s+Acumulado\s*:\s*([\d.,]+)(?=\s+A\s+expirar|\s*$|\s+\n)",
            # LIGHT B: 'SALDO ATUAL GERAÇÃO DISTRIBUÍDA 151.080 kwH'
            r"SALDO\s+ATUAL\s+GERA[ÇC][ÃA]O\s+DISTRIBU[ÍI]DA\s*([\d.,]+)\s*[Kk][Ww][Hh]?",
            # Genérico 'Saldo de Créditos: X' (qualquer dist) — LIGHT, etc
            r"Saldo\s+de\s+Cr[ée]dit[oa]s?\s*:?\s*([\d.,]+)",
            # CPFL Paulista B Convencional: 'Saldo em Energia da Instalação: Convencional 3.543,9672 kWh'
            r"Saldo\s+em\s+Energia\s+da\s+Instala[çc][ãa]o\s*:\s*(?:Convencional\s+)?([\d.,]+)\s*kWh",
            # 'Saldo de energia: X kWh'
            r"Saldo\s+de\s+energia\s*:?\s*([\d.,]+)\s*kWh",
            # Energisa B: 'Saldo de créditos GD: X kWh'
            r"Saldo\s+de\s+cr[ée]ditos?\s+GD\s*:?\s*([\d.,]+)\s*kWh",
        ]:
            m = re.search(pat_uno, texto, re.I)
            if m:
                v = to_float_br(m.group(1))
                if v is not None and v >= 0:
                    out["saldo_acumulado_unico_kwh"] = v
                    out["tem_gd"] = True
                    break

    # Saldo a expirar com data
    # "A expirar em 05/2026: 0(P) 0(FP)"
    m = re.search(r"A\s+expirar\s+em\s+(\d{2}/\d{4})\s*:?\s*([\d.,]+)\s*\(?\s*P\s*\)?\s*([\d.,]+)\s*\(?\s*FP",
                  texto, re.I)
    if m:
        out["saldo_a_expirar"].append({
            "data": m.group(1),
            "ponta_kwh": to_float_br(m.group(2)),
            "fora_ponta_kwh": to_float_br(m.group(3)),
        })

    # mUC — Créditos de outras UCs (vários layouts)
    mUCs = []
    seen_muc = set()

    # Layout 1 — ENERGISA: "GDI mUC 12/2022 oPT" ou "GDI mUC 4/2025 mPT" (mês 1 ou 2 dígitos)
    for m in re.finditer(r"\bmUC\s+(\d{1,2}/\d{4})\s+(oPT|mPT)\b", texto, re.I):
        key = (m.group(1), m.group(2).lower())
        if key not in seen_muc:
            seen_muc.add(key)
            mUCs.append({"data_origem": m.group(1), "tipo": m.group(2).lower()})

    # Layout 2 — ELEKTRO/COPEL/CPFL: "ENERGIA INJ. OUC MPT TE 02/2026" / "OUC OPT TUSD 09/2025"
    for m in re.finditer(
        r"\bo?UC\s+(mPT|oPT|MPT|OPT)\s+(?:TE|TUSD|TUSDG)?\s*(\d{1,2}/\d{4})\b",
        texto, re.I
    ):
        tipo = m.group(1).lower()
        if tipo == "opt": tipo = "oPT"
        elif tipo == "mpt": tipo = "mPT"
        key = (m.group(2), tipo.lower())
        if key not in seen_muc:
            seen_muc.add(key)
            mUCs.append({"data_origem": m.group(2), "tipo": tipo.lower()})

    # Layout 3 — Variantes com OUTRA UC explícita: "OUTRA UC 10/2025"
    for m in re.finditer(r"OUTRA[S]?\s+UC[S]?\s+(\d{1,2}/\d{4})", texto, re.I):
        key = (m.group(1), "outra_uc")
        if key not in seen_muc:
            seen_muc.add(key)
            mUCs.append({"data_origem": m.group(1), "tipo": "outra_uc"})

    if mUCs:
        out["creditos_de_outras_ucs_mUC"] = mUCs

    return out


# ============================================================
# Camada GMFT — extração de tabelas (histórico 13m + outras)
# ============================================================
_GMFT_DETECTOR = None
_GMFT_FORMATTER = None
_GMFT_DISPONIVEL = None

def _init_gmft():
    """Inicializa GMFT (lazy, uma vez). Retorna True se disponivel."""
    global _GMFT_DETECTOR, _GMFT_FORMATTER, _GMFT_DISPONIVEL
    if _GMFT_DISPONIVEL is not None:
        return _GMFT_DISPONIVEL
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    try:
        from gmft.auto import AutoTableDetector, AutoTableFormatter
        _GMFT_DETECTOR = AutoTableDetector()
        _GMFT_FORMATTER = AutoTableFormatter()
        _GMFT_DISPONIVEL = True
    except Exception as e:
        _GMFT_DISPONIVEL = False
    return _GMFT_DISPONIVEL


def extrair_tabelas_gmft(pdf_path: str) -> list:
    """Usa GMFT para extrair tabelas do PDF.

    Retorna lista de dicts: [{"pag": N, "shape": [linhas, cols],
                              "headers": [...], "rows": [[...], ...]}]
    """
    if not _init_gmft(): return []
    try:
        from gmft.pdf_bindings import PyPDFium2Document
        pdf_doc = PyPDFium2Document(pdf_path)
        tabelas = []
        for pag_num, page in enumerate(pdf_doc):
            try:
                detected = _GMFT_DETECTOR.extract(page)
            except Exception:
                continue
            for tab in detected:
                try:
                    formatted = _GMFT_FORMATTER.extract(tab)
                    df = formatted.df()
                    if df is None or df.empty: continue
                    tabelas.append({
                        "pag": pag_num,
                        "shape": list(df.shape),
                        "headers": [str(c) for c in df.columns],
                        "rows": [
                            [None if (v is None or (hasattr(v, '__str__') and str(v) == 'nan')) else str(v)
                             for v in row]
                            for row in df.values.tolist()
                        ],
                    })
                except Exception:
                    pass
        pdf_doc.close()
        return tabelas
    except Exception:
        return []


def identificar_tipo_tabela(headers: list) -> str:
    """Classifica tabela pelos headers."""
    if not headers: return "desconhecida"
    h_str = " ".join(str(h).upper() for h in headers)
    # Histórico 13 meses
    if any(k in h_str for k in ("MÊS/ANO", "MES/ANO", "MES/AÑO", "HISTÓRICO", "HISTORICO")) and any(k in h_str for k in ("CONSUMO", "DEMANDA", "KWH")):
        return "historico_13m"
    if "DIC" in h_str and "FIC" in h_str:
        return "indicadores_qualidade"
    if "MEDIDOR" in h_str or "LEITURA" in h_str:
        return "leituras_medidor"
    if "ITEM" in h_str or "DESCRIÇÃO" in h_str or "VALOR" in h_str:
        return "itens_fatura"
    if "SERVIÇO" in h_str or "ENCARGOS" in h_str:
        return "composicao_consumo"
    if "BANDEIRA" in h_str:
        return "bandeira_tarifaria"
    return "outra"


# ============================================================
# Tabela de itens via REGEX LINHA-A-LINHA (sem dependência externa)
# ============================================================

# ============================================================
# Histórico 13 meses — regex por distribuidora (substitui GMFT)
# ============================================================
_MESES_ABREV = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ']
_MES_REGEX = r'(?:JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/?\s*(?:\d{2,4})'


def extrair_historico_13m(texto: str, mapa_nome: str = "") -> list:
    """Extrai histórico 13 meses de consumo (por regex linha-a-linha).

    Suporta vários layouts:
    - CEMIG/CPFL/EDP: linha por mes com valores tabulares
    - Energisa: linha tabular
    """
    historico = []
    # Padrão genérico: linha começando com mês abreviado + ano + valores numéricos
    pat = re.compile(
        r'^[ \t]*(?P<mes>JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/?\s*(?P<ano>\d{2,4})'
        r'\s+(?P<resto>[\d.,\s\-]+?)(?:\s+LID\b[^\n]*)?\s*$',
        re.MULTILINE | re.IGNORECASE
    )
    for m in pat.finditer(texto):
        mes = m.group('mes').upper()
        ano_raw = m.group('ano')
        ano = "20" + ano_raw if len(ano_raw) == 2 else ano_raw
        resto = m.group('resto').strip()
        # Quebra valores numéricos
        valores = re.findall(r'-?[\d.]+,\d+|-?\d+', resto)
        if len(valores) < 1: continue
        nums = [to_float_br(v) for v in valores]
        item = {"mes": mes, "ano": int(ano), "valores_brutos": valores, "valores_num": nums}
        # Heurística: 1 valor = consumo único; 2+ valores = posto P + FP, etc
        if len(nums) == 1:
            item["consumo_kwh"] = nums[0]
        elif len(nums) == 2:
            item["consumo_ponta_kwh"] = nums[0]
            item["consumo_fponta_kwh"] = nums[1]
        elif len(nums) >= 3:
            item["consumo_ponta_kwh"] = nums[0]
            item["demanda_ponta_kw"] = nums[1] if len(nums) > 3 else None
            item["consumo_fponta_kwh"] = nums[2] if len(nums) > 2 else None
        historico.append(item)
    return historico[:13]  # máximo 13 meses


# ============================================================
# Padrões de itens por distribuidora (incluindo GD específicos)
# ============================================================

# EDP — CCI numérico no início (4 dígitos): 0601 TE, 0605 TUSD, 0698 Bandeira, 0807 CIP, 0999 GD
_ITEM_EDP_CCI = re.compile(
    r'^(\d{4})\s+'                                  # CCI
    r'([A-Za-zÀ-ÿ][\wÀ-ÿ\s\.\-/]+?)\s+'             # descricao
    r'(KWH|kWh|kW|KW|UN|un)\s+'                     # unidade
    r'(-?[\d.,]+)\s+'                               # quantidade
    r'(-?[\d.,]+)\s+'                               # tarifa c/ trib
    r'(-?[\d.,]+)'                                  # valor
    r'(?:\s+(-?[\d.,]+))?'                          # pis_cofins
    r'(?:\s+(-?[\d.,]+))?'                          # base icms
    r'(?:\s+(\d{1,2}(?:,\d+)?))?'                   # %icms
    r'(?:\s+(-?[\d.,]+))?'                          # icms
    r'(?:\s+(-?[\d.,]+))?'                          # tarifa s/trib
    r'\s*$',
    re.MULTILINE
)

# CELESC — CCI codificado entre parênteses: (0D), (0E), (0R), (0S), (C0), (1Z), (20)...
_ITEM_CELESC_CCI = re.compile(
    r'^\(([0-9A-Z]{2})\)\s+'                        # CCI tipo (0D), (0R)
    r'([A-Za-zÀ-ÿ][\wÀ-ÿ\s\.\-/]+?)\s+'
    r'(KWH|kWh|kW|KW|UN|un|kVarh)?\s*'
    r'(-?[\d.,]+)\s+'
    r'(-?[\d.,]+)\s+'
    r'(-?[\d.,]+)\s*$',
    re.MULTILINE
)

# CPFL — Energ Atv Inj. oUC mPT MM/AAAA
_ITEM_CPFL_GD = re.compile(
    r'^(Energ?\s+Atv\s+Inj\.\s+(?:oUC|mUC)\s+(?:mPT|oPT)\s+\d{2}/\d{4})\s+'
    r'(KWH|kWh)\s+'
    r'(-?[\d.,]+)\s+'
    r'(-?[\d.,]+)\s+'
    r'(-?[\d.,]+)',
    re.MULTILINE
)

# ────────────────────────────────────────────────────────────────────────
# Filtro robusto: linha pode ser item de fatura?
# ────────────────────────────────────────────────────────────────────────
# DENY — palavras/sequências que indicam NÃO ser item de fatura
_HEADER_DENY = re.compile(
    r"\b(?:"
    r"DESCRI[ÇC][ÃA]O|UNID(?:ADE)?|QUANT(?:IDADE)?|TARIFA\s+(?:SEM|COM|UNIT)|"
    r"ALÍQ|ALIQ|BASE\s+CALC|VALOR\s+(?:TOTAL|R\$)|TRIBUTO|"
    r"VENCIMENTO|TOTAL\s+A\s+PAGAR|DATA\s+DE|PER[ÍI]ODO\s+DE|"
    r"REFER[ÊE]NCIA|M[ÊE]S/ANO|PR[ÓO]XIMA\s+LEITURA|"
    r"DEMANDA\s+CONTRATADA|TENS[ÃA]O|CONJUNTO|ROTEIRO|"
    r"NOTA\s+FISCAL|CHAVE|PROTOCOLO|CNPJ|INSC|CPF"
    r")\b",
    re.IGNORECASE,
)
# Início proibido: palavra tributária no início (linha de header descarregado)
_DENY_PREFIX = re.compile(
    r"^(?:PIS|COFINS|ICMS|TRIBUTO|ALIQ|BASE\s*CALC|TARIFA\s+(?:SEM|COM)|TOTAL\s*:)\b",
    re.IGNORECASE,
)
# Fim proibido: termina com palavra tributária (resíduo de coluna grudado)
_DENY_SUFFIX = re.compile(r"\b(?:PIS|COFINS|ICMS)\s*$", re.IGNORECASE)
# Só unidade + dígitos (linha de tabela perdida)
_DENY_UNIDADE_NUMERO = re.compile(
    r"^(?:KW|KWH|UN|UNI|kW|kWh|un|uni)\s+\d+(?:[,.]?\d*)?\s*$",
    re.IGNORECASE,
)

# ALLOW — palavras que indicam que É item legítimo (whitelist semântica)
_DESC_ALLOW = re.compile(
    r"\b(?:"
    r"CONSUMO|DEMANDA|ENERGIA|ADIC|BANDEIRA|"
    r"COMPENSACAO|COMPENSAÇÃO|DEVOLU[ÇC][ÃA]O|"
    r"CUSTO|ENCARGO|SUBS[ÍI]DIO|"
    r"JUROS|RECEBIMENTO|MULTA|REVERS[ÃA]O|EST(?:\.|ORNO)|"
    r"RESSARCIMENTO|DIF[\.\s]+CR[EÉ]DITO|"
    r"REATIVA|TUSD|TUSDG|"
    r"USO\s+SIST|"      # ENEL SP
    r"CONTRIB|ILUM"     # B1 Conv: 'Contrib de Ilum Pub'
    r")\b",
    re.IGNORECASE,
)


def linha_pode_ser_item(linha: str) -> bool:
    """Filtra linhas candidatas a item de fatura antes de aplicar patterns.

    Aceita só linhas que:
      - tenham ≥12 chars
      - contenham pelo menos 1 valor monetário (X,XX)
      - tenham palavra ALLOW (descrição com semântica de item)
      - NÃO comecem/terminem com header tributário
      - NÃO sejam só unidade+dígito
      - NÃO sejam header descritivo (DESCRIÇÃO/UNID/QUANT/etc.)
    """
    linha = linha.strip()
    if len(linha) < 12:
        return False
    # Deny prefixos
    if _DENY_PREFIX.search(linha):
        return False
    # Deny só-unidade-numero
    if _DENY_UNIDADE_NUMERO.match(linha):
        return False
    # Deny sufixos (termina com PIS/COFINS/ICMS) — mas só se for cabeçalho (poucos números).
    # Linhas Light ACL terminam com "PIS/PASEP" ou "COFINS" (coluna ao lado) e são itens válidos
    # se já trouxeram desc + qty + tarifa + valor (≥3 valores monetários).
    if _DENY_SUFFIX.search(linha):
        nums_mon = re.findall(r"-?[\d.]+,\d{2}\b", linha)
        if len(nums_mon) < 3:
            return False
    # Precisa de pelo menos um valor monetário X,XX
    if not re.search(r"-?[\d.]+,\d{2}\b", linha):
        return False
    # Precisa de palavra de item legítimo
    if not _DESC_ALLOW.search(linha):
        return False
    # Header descritivo (linha de cabeçalho da tabela)
    if _HEADER_DENY.search(linha):
        # OK se contém palavra ALLOW NÃO-cabeçalho — exemplo: "Energia Reativa Exced" ok mas "Tarifa Unit" não
        # Heurística: linhas com ≥3 números são item; cabeçalhos têm 0-1 número
        nums = re.findall(r"-?[\d.]+,\d+", linha)
        if len(nums) < 2:
            return False
    return True


# Padrões característicos de itens em DANF3E brasileiro
# Pattern 1: "Descricao - Posto UNID qty tarifa valor [pis] [base] [%icms] [icms] [tarifa_s_trib]"
_ITEM_LINHA_PATTERNS = [
    # Energisa MT, CEMIG, EDP, ENEL — formato completo (linha pode ter até 10 colunas)
    re.compile(
        r'^([A-Za-zÀ-ÿ][\wÀ-ÿ \t\.\-/]+?)[ \t]+'
        r'(KWH|KW|UN|kWh|kW|un|UNI|MW|MWh|mWh)[ \t]+'   # +MW pra Light ACL (mercado livre)
        r'(-?[\d.,]+)[ \t]+'                   # quantidade
        r'(-?[\d.,]+)[ \t]+'                   # tarifa com tributos
        r'(-?[\d.,]+)'                         # valor (R$)
        r'(?:[ \t]+(-?[\d.,]+))?'              # pis/cofins (opcional)
        r'(?:[ \t]+(-?[\d.,]+))?'              # base icms (opcional)
        r'(?:[ \t]+(\d{1,2}(?:,\d+)?%?))?'     # %icms (opcional, pode ter % no fim — Enel RJ)
        r'(?:[ \t]+(-?[\d.,]+))?'              # icms (opcional)
        r'(?:[ \t]+(-?[\d.,]+))?'              # tarifa s/trib (opcional)
        r'(?:[ \t]+.*?)?$',                    # tolera lixo no final (PIS/ICMS desalinhado, dígitos espalhados)
        re.MULTILINE
    ),
    # Variante simples: "Descricao  qty  tarifa  valor"
    re.compile(
        r'^([A-Za-zÀ-ÿ][\wÀ-ÿ \t\.\-/]+?)[ \t]+'
        r'(-?[\d.]+,\d+)[ \t]+'                # quantidade BR
        r'(-?[\d.]+,\d+)[ \t]+'                # tarifa BR
        r'(-?[\d.]+,\d+)[ \t]*$',              # valor BR
        re.MULTILINE
    ),
    # ENEL SP B Convencional: '0605 USO SIST. DISTR. (TUSD) 20.160,000 0,32077 6.466,72 18% 1.164,01 6.466,72'
    # Formato: CODIGO + DESCRIÇÃO + QTY + TARIFA + VALOR + ALIQ% + ICMS + BASE
    re.compile(
        r'^[ \t]*0\d{3}\s+'                     # código tipo 0605
        r'([A-Za-zÀ-ÿ][\wÀ-ÿ \t\.\-/\(\)]+?)[ \t]+'  # descrição
        r'(-?[\d.]+,\d{3})[ \t]+'              # qty (3 decimais)
        r'(-?[\d.]+,\d+)[ \t]+'                # tarifa
        r'(-?[\d.]+,\d{2})[ \t]+'              # valor R$
        r'(\d{1,2}%?)[ \t]+'                   # aliq icms
        r'(-?[\d.]+,\d{2})'                    # icms R$
        r'(?:[ \t]+(-?[\d.]+,\d{2}))?'         # base (opcional)
        r'[ \t]*$',
        re.MULTILINE
    ),
    # Energisa B Convencional (B1/B2/B3 residencial/comercial sem unidade KWH):
    # 'Custo de Disponibilidade 28,01 1,90 0,00 0 0,00'
    # 'Adic. B. Amarela 0,10 0,00 0,00 0 0,00'
    # 'COMPENSACAO POR INDICADOR- FIC 12/2025 -2.953,38 0,00 0,00 0 0,00'
    # Formato: DESCRIÇÃO + VALOR + PIS/COFINS + BASE_ICMS + ALIQ + ICMS_VALOR
    re.compile(
        r'^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 \t\.\-/]+?)[ \t]+'  # descrição (números permitidos no meio)
        r'(-?[\d.]+,\d{2})[ \t]+'                       # valor R$
        r'(-?[\d.]+,\d{2})[ \t]+'                       # pis/cofins R$
        r'(-?[\d.]+,\d{2})[ \t]+'                       # base ICMS R$
        r'(\d{1,2}(?:,\d+)?)[ \t]+'                     # alíq ICMS %
        r'(-?[\d.]+,\d{2})'                             # ICMS R$
        r'(?:[ \t]+.*?)?$',                              # tolera lixo no fim
        re.MULTILINE
    ),
    # Energisa B Convencional COM GD (qty + tarifa, mas sem unidade KWH):
    # 'Consumo em kWh 1.910,00 1,054180 2.013,51 43,64 2.013,51 17 342,29 0,852130'
    # 'Energia Atv Injetada GDI mUC 1/2026 mPT 341,00 1,054180 -359,48 -7,79 -359,48 17 -61,11 0,852130'
    # Formato: DESC + QTY + TARIFA + VALOR + PIS/COF + BASE_ICMS + ALIQ + ICMS + TARIFA_ANEEL
    re.compile(
        r'^([A-Za-zÀ-ÿ][\wÀ-ÿ \t\.\-/]+?)[ \t]+'      # descrição
        r'(-?[\d.]+,\d{2})[ \t]+'                       # qty (2 decimais)
        r'(-?[\d.]+,\d+)[ \t]+'                         # tarifa com tributos
        r'(-?[\d.]+,\d{2})[ \t]+'                       # valor R$
        r'(-?[\d.]+,\d{2})[ \t]+'                       # pis/cofins R$
        r'(-?[\d.]+,\d{2})[ \t]+'                       # base ICMS R$
        r'(\d{1,2}(?:,\d+)?)[ \t]+'                     # alíq ICMS %
        r'(-?[\d.]+,\d{2})'                             # ICMS R$
        r'(?:[ \t]+(-?[\d.]+,\d+))?'                    # tarifa ANEEL (opcional)
        r'(?:[ \t]+.*?)?$',
        re.MULTILINE
    ),
    # Energisa B Conv 4-valores (alíq embutida em base 0): 'Custo de Disponibilidade 27,42 1,86 0,00 0,00'
    # Formato: DESC + VALOR + PIS/COFINS + BASE_ICMS + ICMS_VALOR (sem alíq separada)
    # Descrição aceita números (ex: "COMPENSACAO POR INDICADOR-DMIC 09/2025")
    re.compile(
        r'^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 \t\.\-/]+?)[ \t]+'  # descrição (números permitidos no meio)
        r'(-?[\d.]+,\d{2})[ \t]+'                          # valor R$
        r'(-?[\d.]+,\d{2})[ \t]+'                          # pis/cofins R$
        r'(-?[\d.]+,\d{2})[ \t]+'                          # base ICMS R$
        r'(-?[\d.]+,\d{2})'                                # ICMS R$
        r'(?:[ \t]+.*?)?$',
        re.MULTILINE
    ),
    # Energisa pré-ANEEL SEM quantidade (fatura antiga 2025/11 etc):
    # 'Consumo em kWh 1,101380 11.233,03 632,54 11.233,03 1.909,61 0,852130'
    # Formato: DESC + TARIFA(6dec) + VALOR + PIS/COFINS + BASE_ICMS + ICMS_VALOR + TARIFA_ANEEL
    # Sem unidade explícita, sem qty. A 1ª col numérica é a tarifa (sempre 6 decimais).
    re.compile(
        r'^([A-Za-zÀ-ÿ][\wÀ-ÿ \t\.\-/]+?)[ \t]+'          # descrição
        r'(-?[\d.]+,\d{6})[ \t]+'                           # tarifa com tributos (6 decimais — assinatura)
        r'(-?[\d.]+,\d{2})[ \t]+'                           # valor R$
        r'(-?[\d.]+,\d{2})[ \t]+'                           # pis/cofins R$
        r'(-?[\d.]+,\d{2})[ \t]+'                           # base ICMS R$
        r'(-?[\d.]+,\d{2})'                                 # ICMS R$
        r'(?:[ \t]+(-?[\d.]+,\d+))?'                        # tarifa ANEEL (opcional)
        r'(?:[ \t]+.*?)?$',
        re.MULTILINE
    ),
    # Layout CCI antigo (Energisa MT pré-2022) com prefixo de código CCI:
    # '0601 Consumo em kWh 7.760,00 0,521750 0,690130 5.355,45 5.355,45 20 1.071,09 5.355,45 42,03 193,55'
    # '0601 Adic. B. Amarela 137,85 137,85 20 27,57 137,85 1,08 4,98'
    # Captura: CCI + DESC + LISTA DE NÚMEROS (parseada por heurística no handler)
    re.compile(
        r'^(\d{4})[ \t]+'                                   # CCI (4 dígitos)
        r'([A-Za-zÀ-ÿ][\wÀ-ÿ \t\.\-/]+?)[ \t]+'           # descrição
        r'((?:-?[\d.]+,\d+(?:[ \t]+\d{1,2}(?:,\d+)?[ \t]+|[ \t]+))+-?[\d.]+,\d+)'  # lista de números separados por espaço
        r'[ \t]*$',
        re.MULTILINE
    ),
    # Pattern[8] Lançamento simples com 1 valor (whitelist de prefixos):
    # 'COMPENSACAO POR INDICADOR -DIC 01/2026 -1.067,85'
    # 'DIF.CREDITO A DEVOLVER 04/2026 110.606,77'
    # 'Subsídio 143,10' / 'Devolução Subsídio -116,16'
    # 'Adic. B. Amarela 0,10' / 'Adic. B. Vermelha 1,43'
    # 'Encargo de Uso 50,00'
    # Whitelist baseada nos itens que Haiku mais adicionou nas reprovadas (305 faturas)
    re.compile(
        r'^((?:COMPENSACAO|COMPENSAÇÃO|DEVOLU[ÇC][ÃA]O|DEV(?:\s|\.)|JUROS|RECEBIMENTO|DIF[\s\.]+CR[EÉ]DITO|REVERS[ÃA]O|EST(?:\.|ORNO)|RESSARCIMENTO|MULTA|SUBS[ÍI]DIO|ADIC[\.\s]+B[\.\s]*|ENCARGO\s+DE\s+USO|CONTRIB[\.\s]+ILUM|CONTRIB(?:UI[ÇC][ÃA]O)?\s+ILUM|ILUM[\.\s]+P[UÚ]B|TAXA\s+ILUM)[A-Za-zÀ-ÿ0-9 \t\.\-/]*?)[ \t]+'
        r'(-?[\d.]+,\d{2})'                                 # único valor R$
        r'[ \t]*$',                                          # fim de linha
        re.MULTILINE | re.I
    ),
]


def _inferir_posto_por_tarifa(itens: list):
    """Mapeia tarifas conhecidas (Ponta vs Fora Ponta) e infere posto em itens sem ele."""
    tarifa_para_posto = {}
    for it in itens:
        if it.get("posto") and it.get("tarifa_unit_numerica"):
            tarifa_para_posto[round(it["tarifa_unit_numerica"], 4)] = it["posto"]
    for it in itens:
        if not it.get("posto") and it.get("tarifa_unit_numerica"):
            t = round(it["tarifa_unit_numerica"], 4)
            if t in tarifa_para_posto:
                it["posto"] = tarifa_para_posto[t]
                it["_posto_origem"] = "tarifa_match"


def _inferir_posto_mUC_proximidade(itens: list):
    """Em itens com 'mUC ... oPT/mPT', deduz posto:
    - mPT: mesmo posto do item anterior com posto definido
    - oPT: posto oposto
    """
    ultimo_posto = None
    for it in itens:
        desc_up = (it.get("descricao") or "").upper()
        if it.get("posto"):
            ultimo_posto = it["posto"]
        elif "MUC" in desc_up.replace(" ", ""):
            if ultimo_posto:
                if "OPT" in desc_up.replace(" ", ""):
                    # outro posto
                    if ultimo_posto == "Ponta": it["posto"] = "Fora Ponta"
                    elif ultimo_posto == "Fora Ponta": it["posto"] = "Ponta"
                    elif ultimo_posto == "Intermediário": it["posto"] = "Ponta"
                    it["_posto_origem"] = "muc_opt_relativo"
                elif "MPT" in desc_up.replace(" ", ""):
                    it["posto"] = ultimo_posto
                    it["_posto_origem"] = "muc_mpt_relativo"


def extrair_itens_edp_cci(texto: str) -> list:
    """Itens EDP com CCI numérico (0601, 0605, 0698, 0807, 0999...)."""
    CCI_MAP = {
        "0601": ("ENERGIA", False),   # TE Consumo
        "0605": ("TUSD", False),       # TUSD Consumo
        "0698": ("BANDEIRA", False),
        "0807": ("COSIP", False),
        "0901": ("COMPENSACAO_GD", True),  # GD compensação
        "0902": ("COMPENSACAO_GD", True),
        "0904": ("COMPENSACAO_GD", True),
        "0999": ("COMPENSACAO_GD", True),  # Outros créditos GD
    }
    itens = []
    for m in _ITEM_EDP_CCI.finditer(texto):
        cci = m.group(1)
        desc = m.group(2).strip()
        tipo_info = CCI_MAP.get(cci, (None, False))
        tipo, eh_gd = tipo_info
        valor = to_float_br(m.group(6))
        if valor is None: continue
        # Detecta posto
        desc_up = desc.upper()
        posto = None
        if "PONTA" in desc_up and "FORA" not in desc_up: posto = "Ponta"
        elif "FORA" in desc_up or "FPONTA" in desc_up: posto = "Fora Ponta"
        elif "INTERMED" in desc_up: posto = "Intermediário"

        itens.append({
            "descricao": f"{cci} {desc}",
            "cci": cci,
            "unidade": m.group(3),
            "posto": posto,
            "tipo": tipo,
            "eh_credito_gd": eh_gd,
            "quantidade_numerica": to_float_br(m.group(4)),
            "tarifa_unit_numerica": to_float_br(m.group(5)),
            "valor_brl_numerico": valor,
            "_extrator": "edp_cci",
        })
    return itens


def extrair_itens_celesc_cci(texto: str) -> list:
    """Itens CELESC com CCI entre parênteses: (0D), (0E), (0R), (0S), (C0)."""
    CCI_MAP = {
        "0D": ("TE", False),
        "0E": ("TUSD", False),
        "0R": ("COMPENSACAO_GD", True),
        "0S": ("COMPENSACAO_GD", True),
        "C0": ("COSIP", False),
        "1Z": ("OUTROS", False),
        "20": ("OUTROS", False),
        "0T": ("DEMANDA", False),
        "1O": ("REATIVO", False),
        "0H": ("OUTROS", False),
        "0I": ("OUTROS", False),
    }
    itens = []
    for m in _ITEM_CELESC_CCI.finditer(texto):
        cci = m.group(1)
        desc = m.group(2).strip()
        tipo, eh_gd = CCI_MAP.get(cci, (None, False))
        valor = to_float_br(m.group(6))
        if valor is None: continue
        itens.append({
            "descricao": f"({cci}) {desc}",
            "cci": cci,
            "unidade": m.group(3),
            "posto": None,  # CELESC NF3E SC tem posto único
            "tipo": tipo,
            "eh_credito_gd": eh_gd,
            "quantidade_numerica": to_float_br(m.group(4)),
            "tarifa_unit_numerica": to_float_br(m.group(5)),
            "valor_brl_numerico": valor,
            "_extrator": "celesc_cci",
        })
    return itens


def extrair_itens_cpfl_gd(texto: str) -> list:
    """Itens CPFL GD: 'Energ Atv Inj. oUC mPT MM/AAAA KWH qty tar val'."""
    itens = []
    for m in _ITEM_CPFL_GD.finditer(texto):
        desc = m.group(1).strip()
        valor = to_float_br(m.group(5))
        if valor is None: continue
        desc_up = desc.upper()
        posto = "Ponta" if "MPT" in desc_up.replace(" ","") and not "OPT" in desc_up.replace(" ","") else None
        itens.append({
            "descricao": desc,
            "unidade": m.group(2),
            "posto": posto,  # heurística mPT/oPT depois
            "tipo": "COMPENSACAO_GD",
            "eh_credito_gd": True,
            "quantidade_numerica": to_float_br(m.group(3)),
            "tarifa_unit_numerica": to_float_br(m.group(4)),
            "valor_brl_numerico": valor,
            "_extrator": "cpfl_gd",
        })
    return itens


def extrair_itens_linha_a_linha(texto: str) -> list:
    """Extrai itens da fatura via regex linha-a-linha (sem dependência de tabela).

    Mais robusto que pdfplumber.extract_tables() para DANF3E brasileiros
    (que usam layout posicional sem bordas).
    """
    # Limpa quebras de linha múltiplas e linhas curtas que confundem o regex
    texto_limpo = re.sub(r'\n{2,}', '\n', texto)
    # Normaliza hífen no final de valores negativos (ENEL RIO Ampla layout):
    #   '1.855,75-' → '-1.855,75'   '0,46217-' → '-0,46217'   '24,00%' fica inalterado
    # Aceita 1+ dígitos após vírgula (tarifas 6dec, valores 2dec)
    texto_limpo = re.sub(r'(\b[\d.]+,\d+)-(?=\s|$|[a-zA-Z])', r'-\1', texto_limpo)
    # Remove headers tributários intercalados (PIS/COFINS, Base Calc, etc)
    texto_limpo = re.sub(r'^\s*(PIS/COFINS|Base\s*Calc|Aliq\.|ICMS\s+ICMS|%Aliq).*$', '', texto_limpo, flags=re.M | re.I)

    # Para pattern[3] (Energisa B Conv sem unidade): aplica APENAS no bloco "Itens da Fatura ... TOTAL:"
    # — evita falsos positivos em tabelas de medidor/grandezas
    texto_pat3 = texto_limpo
    # Tenta header novo "Itens da Fatura" OU header antigo "CCI DESCRIÇÃO"
    m_bloco = re.search(r"Itens da Fatura.*?TOTAL\s*:", texto_limpo, re.DOTALL | re.I)
    if not m_bloco:
        m_bloco = re.search(r"CCI\s+DESCRI[ÇC][ÃA]O.*?TOTAL\s*:", texto_limpo, re.DOTALL | re.I)
    if m_bloco:
        texto_pat3 = m_bloco.group(0)
        # Pré-processamento: remove sequências "PIS X,XX Y,YY Z,ZZ" e "COFINS X,XX Y,YY Z,ZZ"
        # (são headers tributários intercalados que poluem o regex de itens)
        texto_pat3 = re.sub(
            r"\s+(?:PIS|COFINS|ICMS)\s+[\d.,]+\s+[\d.,]+\s+[\d.,]+",
            "\n", texto_pat3
        )
        # Quebra também quando aparece nova descrição capitalizada após valor monetário
        # Ex: '...0,00 0,00 Adic. B. Vermelha 1,43...' → quebra antes de Adic
        texto_pat3 = re.sub(
            r"([\d.]+,\d{2})\s+([A-ZÀ-Ÿ][a-zà-ÿ][\wà-ÿ \t\.\-]{3,}?)\s+(-?[\d.]+,\d{2})",
            r"\1\n\2 \3", texto_pat3
        )
        # Remove espaços iniciais de cada linha (pré-processamento gera "\n " que quebra ^[A-Z])
        texto_pat3 = re.sub(r"(?m)^[ \t]+", "", texto_pat3)
        # Layout CCI antigo: insere espaço entre código (4 dígitos) e descrição grudada
        # Ex: '0601Consumo em kWh ...' → '0601 Consumo em kWh ...'
        texto_pat3 = re.sub(r"(?m)^(\d{4})([A-ZÀ-Ÿ][a-zà-ÿ])", r"\1 \2", texto_pat3)

    itens = []
    seen = set()
    for idx_pat, pat in enumerate(_ITEM_LINHA_PATTERNS):
        # Pattern[3-6]: usam texto limitado ao bloco "Itens da Fatura...TOTAL:"
        fonte = texto_pat3 if idx_pat in (3, 4, 5, 6, 7, 8) else texto_limpo
        for m in pat.finditer(fonte):
            # Filtro DENY/ALLOW: testa LINHA INTEIRA antes de processar match
            linha_inteira = m.group(0)
            if not linha_pode_ser_item(linha_inteira):
                continue
            # Pattern[7] CCI: grupo 1 é CCI (\d{4}), grupo 2 é descrição
            if idx_pat == 7:
                desc = m.group(2).strip() if m.lastindex and m.lastindex >= 2 else ""
            else:
                desc = m.group(1).strip()
            # Filtros adicionais sobre a DESCRIÇÃO (redundantes mas mantidos por segurança)
            desc_up = desc.upper()
            if any(skip in desc_up for skip in (
                "VENCIMENTO", "TOTAL A PAGAR", "VALOR TOTAL", "DATA DE",
                "PERÍODO DE", "PERIODO DE", "DEMANDA CONTRATADA",
                "REFERÊNCIA", "REFERENCIA", "MÊS/ANO", "MES/ANO",
                "PRÓXIMA LEITURA", "PROXIMA LEITURA",
            )):
                continue
            if len(desc) < 5 or len(desc) > 80: continue
            # Descarta linhas que começam com código de medidor (Ennnnn, Wnnnnn, etc) seguido de "Energia"
            if re.match(r'^[A-Z]\d{6,}\s+Energia', desc):
                continue
            # Detecta posto pela descrição
            posto = None
            if re.search(r'\bPONTA\b', desc_up) and 'FORA' not in desc_up and 'F.PONT' not in desc_up:
                posto = "Ponta"
            elif re.search(r'\bFORA\s*PONTA\b|FPONTA|F\.\s*PONT', desc_up):
                posto = "Fora Ponta"
            elif 'INTERMED' in desc_up:
                posto = "Intermediário"
            # Detecta GD
            eh_gd = bool(re.search(r'GDI|INJETAD|COMPENS|SCEE', desc_up))
            # Unidade
            unidade = None
            qty_s = None; tarifa_s = None; valor_s = None
            pis_cofins_s = None; base_icms_s = None; aliq_icms_s = None
            icms_valor_s = None; tarifa_aneel_s = None
            _skip_defaults = False
            grupos = m.groups()
            # Pattern[0] (Energisa/CEMIG): 10 grupos com unidade KWH/KW/UN
            if len(grupos) >= 5 and grupos[1] in ("KWH", "KW", "UN", "kWh", "kW", "un", "UNI", "MW", "MWh", "mWh"):
                unidade = grupos[1]
                qty_s = grupos[2]
                tarifa_s = grupos[3]
                valor_s = grupos[4]
                # Sanity check: qty deve ter 0-2 decimais; se tem >=3 decimais é tarifa colocada na
                # posição da qty (layout sem quantidade — fatura pré-ANEEL ou pré-2026)
                if qty_s and re.match(r"^-?[\d.]+,\d{3,}$", qty_s):
                    continue
                # Sanity check 2: tarifa absurda (>100) em KWH/KW indica "demanda complementar sem tarifa"
                # Ex: 'Demanda Complementar - F. Ponta KW 323,62 11.486,79 891,35 0,00 0 0,00'
                # Aqui 11.486,79 é VALOR (não tarifa). Tarifas reais Energisa MT: ~0,5-3 kWh, ~32 kW.
                # Re-interpretar: shift dos campos (tarifa→valor, valor→pis_cof, etc.)
                try:
                    tarifa_n = float(str(tarifa_s).replace(".","").replace(",",".")) if tarifa_s else 0
                except Exception:
                    tarifa_n = 0
                if tarifa_n > 100 and unidade in ("KW", "KWH", "kW", "kWh"):
                    # Layout sem tarifa: qty + valor + pis_cof + (resto zeros)
                    # grupos[2]=qty, grupos[3]=valor (era tarifa), grupos[4]=pis_cof (era valor), ...
                    valor_s = grupos[3]
                    pis_cofins_s = grupos[4] if len(grupos) > 4 else None
                    base_icms_s = grupos[5] if len(grupos) > 5 else None
                    aliq_icms_s = grupos[6] if len(grupos) > 6 else None
                    icms_valor_s = grupos[7] if len(grupos) > 7 else None
                    tarifa_aneel_s = None
                    tarifa_s = None  # não há tarifa nesse item
                    _skip_defaults = True  # pula bloco defaults pattern[0]
            # Pattern[1] simples (4 grupos)
            elif len(grupos) == 4:
                qty_s = grupos[1]
                tarifa_s = grupos[2]
                valor_s = grupos[3]
            # Pattern[2] ENEL SP B Conv (7 grupos) OU Pattern[3] Energisa B Conv (6 grupos) OU Pattern[6] Energisa sem qty (7 grupos com tarifa 6dec)
            elif len(grupos) in (6, 7) and grupos[1] and ',' in str(grupos[1]):
                # Pattern[6] Energisa sem qty: 1º valor é TARIFA com 6 decimais
                if re.match(r"^-?[\d.]+,\d{6}$", grupos[1] or ""):
                    tarifa_s = grupos[1]; valor_s = grupos[2]
                    qty_s = None
                # ENEL SP: qty com 3 decimais
                elif re.match(r"^-?[\d.]+,\d{3}$", grupos[1] or ""):
                    qty_s = grupos[1]; tarifa_s = grupos[2]; valor_s = grupos[3]
                else:
                    # Energisa B Conv: desc valor pis_cofins base_icms aliq icms (sem qty/tarifa)
                    valor_s = grupos[1]
                    qty_s = None; tarifa_s = None
            # Pattern[7] CCI antigo (3 grupos: CCI, desc, lista de números)
            elif idx_pat == 7:
                # Tokeniza: inclui números BR com vírgula E inteiros sem vírgula (alíq "20")
                tokens = re.findall(r"-?[\d.]+(?:,\d+)?", grupos[2] or "")
                # Filtra: descartar tokens que sejam só zeros sem contexto
                nums = [t for t in tokens if t]
                if len(nums) < 2: continue
                def _f(s):
                    try: return float(str(s).replace(".","").replace(",","."))
                    except Exception: return 0.0
                v1n = _f(nums[0]); v2n = _f(nums[1])
                # Caso A: item simples (1 valor, resto zeros): "Devolução Subsídio -888,75 0 0,00 0,00 ..."
                if abs(v2n) < 0.01:
                    valor_s = nums[0]; qty_s = None; tarifa_s = None
                # Caso B: item fixo (v1 == v2): "Adic. B. Amarela 137,85 137,85 20 27,57 ..."
                elif abs(v1n - v2n) < 0.02 and v1n >= 0.10:
                    valor_s = nums[0]; qty_s = None; tarifa_s = None
                    if len(nums) >= 7:
                        aliq_icms_s = nums[2]; icms_valor_s = nums[3]
                        base_icms_s = nums[0]
                        try:
                            pis_v = _f(nums[5]); cof_v = _f(nums[6])
                            pis_cofins_s = f"{pis_v + cof_v:.2f}".replace(".", ",")
                        except Exception: pass
                # Caso C: com qty + tarifa: "Consumo em kWh 7.760,00 0,521750 0,690130 5.355,45 ..."
                else:
                    qty_s = nums[0]
                    # tarifa_c_tributos é a 3ª posição (após qty + tarifa_s_trib)
                    tarifa_s = nums[2] if len(nums) >= 4 else nums[1]
                    valor_s = nums[3] if len(nums) >= 4 else None
                    # Após valor: base_icms, aliq, icms, base_pc, pis, cofins
                    if len(nums) >= 9:
                        base_icms_s = nums[4]
                        aliq_icms_s = nums[5]
                        icms_valor_s = nums[6]
                        # pis + cofins nas últimas 2 posições
                        pis_v = _f(nums[-2]); cof_v = _f(nums[-1])
                        pis_cofins_s = f"{pis_v + cof_v:.2f}".replace(".", ",")
                    tarifa_aneel_s = nums[1] if len(nums) >= 2 else None
            # Pattern[4] Energisa B Conv COM GD (9 grupos: qty + tarifa + valor + tributos + tarifa_aneel)
            elif len(grupos) in (8, 9):
                # Se descrição termina com unidade E pattern[0] já casou esta linha (com unidade
                # como grupo separado), descarta para evitar duplicação. Caso contrário, aceita —
                # B1 Conv tem "Consumo em kWh 221 1,127960 ..." onde kWh é parte da descrição
                # e qty/tarifa vêm normalmente.
                if re.search(r"\b(KWH|KW|UN|UNI|kWh|kW)\s*$", desc, re.I):
                    # Aceita se qty é número plausível (inteiro ou X,XX) e tarifa tem 6 decimais
                    qty_check = grupos[1] or ""
                    tarifa_check = grupos[2] or ""
                    eh_qty_plausivel = bool(re.match(r"^-?[\d.]+(?:,\d{1,2})?$", qty_check))
                    eh_tarifa_plausivel = bool(re.match(r"^-?[\d.]+,\d{4,}$", tarifa_check))
                    if not (eh_qty_plausivel and eh_tarifa_plausivel):
                        continue
                qty_s = grupos[1]; tarifa_s = grupos[2]; valor_s = grupos[3]
            # Pattern[5] Energisa B Conv 4-valores (desc + valor + pis_cof + base_icms + icms — sem alíq separada)
            elif len(grupos) == 5:
                # Filtro: descrição não pode terminar com unidade nem ser linha de tabela
                if re.search(r"\b(KWH|KW|UN|UNI|kWh|kW|Ponta|FPonta)\s*$", desc, re.I):
                    continue
                valor_s = grupos[1]; qty_s = None; tarifa_s = None
            # Pattern[8] Lançamento simples: desc + valor (2 grupos)
            elif idx_pat == 8 and len(grupos) == 2:
                valor_s = grupos[1]; qty_s = None; tarifa_s = None
            else:
                continue

            valor_num = to_float_br(valor_s)
            if valor_num is None: continue
            # Chave única (desc+valor) pra evitar duplicatas entre patterns
            # Normaliza descrição para dedup: remove unidade no final (kWh/KW/UN) e
            # collapsa espaços. Evita duplicação quando Pattern[0] (com unidade) e
            # Pattern[6] (sem qty) casam a mesma linha com descrições ligeiramente
            # diferentes ("Consumo em" vs "Consumo em kWh" vs "Consumo em kWh KWH").
            # O `+` no fim do não-grupo permite remover múltiplas unidades em cascata.
            desc_norm = re.sub(r"(?:\s+(?:kWh|KWH|kW|KW|UN|UNI))+\s*$", "", desc, flags=re.I)
            desc_norm = re.sub(r"\s+", " ", desc_norm).strip().upper()
            key = (desc_norm, round(valor_num, 2))
            if key in seen: continue
            seen.add(key)

            # Colunas tributos (grupos 6-9 do pattern[0] — quando disponíveis)
            # PULA pra pattern[7] (já populou os tributos no branch acima) e pra demanda-sem-tarifa
            if idx_pat != 7 and not _skip_defaults:
                pis_cofins_s = grupos[5] if len(grupos) > 5 else None
                base_icms_s = grupos[6] if len(grupos) > 6 else None
                aliq_icms_s = grupos[7] if len(grupos) > 7 else None
                icms_valor_s = grupos[8] if len(grupos) > 8 else None
                # Grupo 10 do pattern[0]: tarifa ANEEL (sem tributos) — coluna "Tarifa Unit (R$)"
                tarifa_aneel_s = grupos[9] if len(grupos) > 9 else None
            # Pattern[6] Energisa sem qty (7 grupos com tarifa 6dec): desc=0, tarifa=1, valor=2, pis_cof=3, base=4, icms=5, [tarifa_aneel=6]
            if len(grupos) == 7 and grupos[1] and re.match(r"^-?[\d.]+,\d{6}$", grupos[1] or ""):
                pis_cofins_s = grupos[3]
                base_icms_s = grupos[4]
                aliq_icms_s = None  # alíq não vem nesse layout
                icms_valor_s = grupos[5]
                tarifa_aneel_s = grupos[6] if len(grupos) > 6 else None
            # Pattern ENEL SP (7 grupos) OU Energisa B Conv (6 grupos)
            elif len(grupos) in (6, 7) and grupos[1] and ',' in str(grupos[1]):
                if re.match(r"^-?[\d.]+,\d{3}$", grupos[1] or ""):
                    # ENEL SP: aliq=4, icms=5, base=6
                    aliq_icms_s = grupos[4] if len(grupos) > 4 else None
                    icms_valor_s = grupos[5] if len(grupos) > 5 else None
                    base_icms_s = grupos[6] if len(grupos) > 6 else None
                    pis_cofins_s = None
                else:
                    # Energisa B Conv: desc=0, valor=1, pis_cofins=2, base_icms=3, aliq=4, icms=5
                    pis_cofins_s = grupos[2]
                    base_icms_s = grupos[3]
                    aliq_icms_s = grupos[4]
                    icms_valor_s = grupos[5]
                tarifa_aneel_s = None
            # Pattern[4] Energisa B Conv COM GD (8/9 grupos): qty=1, tarifa=2, valor=3, pis_cof=4, base=5, aliq=6, icms=7, [tarifa_aneel=8]
            elif len(grupos) in (8, 9):
                pis_cofins_s = grupos[4]
                base_icms_s = grupos[5]
                aliq_icms_s = grupos[6]
                icms_valor_s = grupos[7]
                tarifa_aneel_s = grupos[8] if len(grupos) > 8 else None
            # Pattern[5] Energisa B Conv 4-valores: desc=0, valor=1, pis_cof=2, base=3, icms=4 (sem alíq)
            elif len(grupos) == 5:
                pis_cofins_s = grupos[2]
                base_icms_s = grupos[3]
                aliq_icms_s = None
                icms_valor_s = grupos[4]
                tarifa_aneel_s = None
            # Pattern[7] CCI: tributos JÁ populados no branch de qty/tarifa/valor acima — pula handler

            itens.append({
                "descricao": desc,
                "unidade": unidade,
                "posto": posto,
                "eh_credito_gd": eh_gd,
                "quantidade_string": qty_s,
                "quantidade_numerica": to_float_br(qty_s),
                "tarifa_unit_string": tarifa_s,
                "tarifa_unit_numerica": to_float_br(tarifa_s),
                "valor_brl_string": valor_s,
                "valor_brl_numerico": valor_num,
                "pis_cofins_brl_string": pis_cofins_s,
                "pis_cofins_brl_numerico": to_float_br(pis_cofins_s) if pis_cofins_s else None,
                "icms_base_string": base_icms_s,
                "icms_base_numerico": to_float_br(base_icms_s) if base_icms_s else None,
                "icms_aliquota_pct": aliq_icms_s,
                "icms_valor_string": icms_valor_s,
                "icms_valor_numerico": to_float_br(icms_valor_s) if icms_valor_s else None,
                "tarifa_unit_aneel_string": tarifa_aneel_s,
                "tarifa_unit_aneel_numerica": to_float_br(tarifa_aneel_s) if tarifa_aneel_s else None,
            })
    return itens


# Mantém função antiga para PDFs que tenham tabelas bem-formadas
def extrair_tabela_itens(pdf_path: str) -> list:
    """Extrai a tabela 'Itens da Fatura' usando pdfplumber.extract_tables().

    Heurística: procura tabela cujo cabeçalho menciona 'Item' ou 'Valor' ou 'Quantidade'.
    """
    try:
        import pdfplumber
    except ImportError:
        return []
    itens = []
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                for table in (page.extract_tables() or []):
                    if not table or len(table) < 2: continue
                    headers = [str(c or "").strip().lower() for c in table[0]]
                    header_str = " ".join(headers)
                    if not any(k in header_str for k in ("item", "descri", "valor", "quant")):
                        continue
                    # Mapeia colunas (best effort)
                    col_desc = next((i for i, h in enumerate(headers) if "descri" in h or "item" in h), 0)
                    col_qty = next((i for i, h in enumerate(headers) if "quant" in h or "kwh" in h), None)
                    col_val = next((i for i, h in enumerate(headers) if "valor" in h and "icms" not in h and "pis" not in h), None)
                    col_tar = next((i for i, h in enumerate(headers) if "tarifa" in h or "pre" in h), None)
                    col_unid = next((i for i, h in enumerate(headers) if "unid" in h), None)
                    for row in table[1:]:
                        if not row or len(row) < 2: continue
                        desc = str(row[col_desc] or "").strip()
                        if not desc or desc.lower() in ("item", "total"): continue
                        item = {
                            "descricao": desc,
                            "unidade": (str(row[col_unid]).strip() if col_unid is not None and col_unid < len(row) else None),
                            "quantidade_string": (str(row[col_qty]).strip() if col_qty is not None and col_qty < len(row) else None),
                            "quantidade_numerica": to_float_br(row[col_qty]) if col_qty is not None and col_qty < len(row) else None,
                            "valor_brl_string": (str(row[col_val]).strip() if col_val is not None and col_val < len(row) else None),
                            "valor_brl_numerico": to_float_br(row[col_val]) if col_val is not None and col_val < len(row) else None,
                            "tarifa_unit_string": (str(row[col_tar]).strip() if col_tar is not None and col_tar < len(row) else None),
                            "tarifa_unit_numerica": to_float_br(row[col_tar]) if col_tar is not None and col_tar < len(row) else None,
                        }
                        # Detecta posto
                        desc_up = desc.upper()
                        if "PONTA" in desc_up and "FORA" not in desc_up and "F.PONT" not in desc_up:
                            item["posto"] = "Ponta"
                        elif "FORA PONTA" in desc_up or "FPONTA" in desc_up or "F.PONT" in desc_up:
                            item["posto"] = "Fora Ponta"
                        elif "INTERMED" in desc_up:
                            item["posto"] = "Intermediário"
                        else:
                            item["posto"] = None
                        # Detecta GD
                        item["eh_credito_gd"] = bool(re.search(r"GDI|INJETAD|COMPENS", desc_up))
                        itens.append(item)
        return itens
    except Exception as e:
        return []


# ============================================================
# Auditoria Python pura (sem IA)
# ============================================================
def detectar_grupo_tarifario(subgrupo: str, modalidade: str) -> str:
    """Retorna 'A' / 'B Branca' / 'B Convencional' / None."""
    if not subgrupo: return None
    sub = subgrupo.upper().strip()
    if sub.startswith("A"): return "A"
    if sub.startswith("B"):
        mod = (modalidade or "").upper()
        if "BRANCA" in mod: return "B Branca"
        return "B Convencional"
    return None


def auditar_gd(dados: dict) -> dict:
    """Aplica fórmulas SCEE/Lei 14.300 sem IA.

    Espera dados estruturados (vindo de regex + tabelas + quadro GD).
    Retorna validações + memória de cálculo + divergências.
    """
    out = {
        "grupo_identificado": None,
        "tem_compensacao_cruzada_aplicavel": None,
        "tem_fator_ajuste_aplicavel": None,
        "tarifas_te": {},
        "fator_ajuste_calculado": {},
        "memoria_calculo": {},
        "validacoes": {},
        "divergencias": [],
    }

    uc = dados.get("ligacao_tecnica") or dados.get("unidade_consumidora") or {}
    subgrupo = uc.get("subgrupo")
    modalidade = uc.get("modalidade_tarifaria") or dados.get("modalidade_tarifaria")
    grupo = detectar_grupo_tarifario(subgrupo, modalidade)
    out["grupo_identificado"] = grupo

    if not grupo:
        return out

    # Aplicabilidade por grupo (Lei 14.300 / REN 1.059)
    if grupo == "A" or grupo == "B Branca":
        out["tem_compensacao_cruzada_aplicavel"] = True
        out["tem_fator_ajuste_aplicavel"] = True
    elif grupo == "B Convencional":
        out["tem_compensacao_cruzada_aplicavel"] = False
        out["tem_fator_ajuste_aplicavel"] = False

    # Tarifas TE (derivadas dos itens)
    itens = dados.get("itens_fatura") or []
    te_ponta = None
    te_fp = None
    te_int = None
    for it in itens:
        desc_up = (it.get("descricao") or "").upper()
        if it.get("eh_credito_gd"): continue
        if "PONTA" in desc_up and "FORA" not in desc_up and "TE" in desc_up:
            tar = it.get("tarifa_unit_numerica")
            if tar: te_ponta = tar
        elif ("FORA PONTA" in desc_up or "FPONTA" in desc_up) and "TE" in desc_up:
            tar = it.get("tarifa_unit_numerica")
            if tar: te_fp = tar
        elif "INTERMED" in desc_up and "TE" in desc_up:
            tar = it.get("tarifa_unit_numerica")
            if tar: te_int = tar
    out["tarifas_te"] = {
        "te_ponta_rs_kwh": te_ponta,
        "te_fora_ponta_rs_kwh": te_fp,
        "te_intermediario_rs_kwh": te_int,
    }

    # Fator de ajuste
    if grupo == "A" and te_ponta and te_fp:
        out["fator_ajuste_calculado"]["fp_para_p"] = round(te_fp / te_ponta, 6)
        out["fator_ajuste_calculado"]["p_para_fp"] = round(te_ponta / te_fp, 6)
    if grupo == "B Branca" and te_ponta and te_int:
        out["fator_ajuste_calculado"]["i_para_p"] = round(te_int / te_ponta, 6)
        out["fator_ajuste_calculado"]["p_para_i"] = round(te_ponta / te_int, 6)

    # Memória de cálculo por posto
    consumido = {"ponta": 0, "fora_ponta": 0, "intermediario": 0}
    injetado = {"ponta": 0, "fora_ponta": 0, "intermediario": 0}
    # Dedup ACL (mercado livre): a MESMA qtd de kWh aparece em 2 rubricas do mesmo
    # posto — 'Tusd Enc Cons' (fio) + 'Energia ACL' (energia) — representando a
    # mesma energia entregue. Somar as duas dobrava o consumo (ex.: id 128663 FP
    # 4.708 → 9.417). Conta cada quantidade UMA vez por posto; não afeta cativo
    # (1 linha) nem itens com quantidades distintas.
    _cons_qtd_vista = {}  # posto_key -> {qtd já contada}
    for it in itens:
        posto = it.get("posto")
        if not posto: continue
        posto_key = posto.lower().replace(" ", "_").replace("fora_ponta", "fora_ponta").replace("intermediário", "intermediario")
        qty = it.get("quantidade_numerica") or 0
        if it.get("eh_credito_gd"):
            injetado[posto_key] = injetado.get(posto_key, 0) + qty
        else:
            vistos = _cons_qtd_vista.setdefault(posto_key, set())
            qkey = round(qty, 2)
            if qty and qkey in vistos:
                continue  # duplicata ACL (mesmo kWh, mesmo posto) — não soma de novo
            vistos.add(qkey)
            consumido[posto_key] = consumido.get(posto_key, 0) + qty

    out["memoria_calculo"] = {
        "ponta": {
            "energia_consumida_kwh": consumido.get("ponta"),
            "energia_injetada_kwh": injetado.get("ponta"),
        },
        "fora_ponta": {
            "energia_consumida_kwh": consumido.get("fora_ponta"),
            "energia_injetada_kwh": injetado.get("fora_ponta"),
        },
    }

    # Validações
    soma_itens = sum((it.get("valor_brl_numerico") or 0) for it in itens)
    vrft = to_float_br(dados.get("vencimento_valor", {}).get("valor_total")) or dados.get("valor_total_fatura")
    if vrft:
        diff = abs(soma_itens - vrft)
        out["validacoes"]["soma_itens_bate_total"] = diff < 0.05
        if not out["validacoes"]["soma_itens_bate_total"]:
            out["divergencias"].append({
                "tipo": "soma_difere_total",
                "soma_itens": round(soma_itens, 2),
                "total_fatura": round(vrft, 2),
                "diferenca": round(diff, 2),
            })

    # Compensação não excede consumo
    for posto in ("ponta", "fora_ponta", "intermediario"):
        c = consumido.get(posto, 0)
        i = injetado.get(posto, 0)
        if i > c and c > 0:
            out["divergencias"].append({
                "tipo": "compensacao_excede_consumo",
                "posto": posto,
                "consumido_kwh": c,
                "compensado_kwh": i,
            })

    # Verifica restrição absoluta
    if grupo == "B Convencional":
        for it in itens:
            desc = (it.get("descricao") or "").upper()
            if "AJUSTE" in desc and "RES" in desc:
                out["divergencias"].append({
                    "tipo": "fator_ajuste_em_b_convencional",
                    "norma_violada": "Lei 14.300 / REN 1.000 — B Convencional NÃO tem fator de ajuste",
                    "item": it.get("descricao"),
                })

    out["validacoes"]["compensada_nao_excede_consumida"] = len([d for d in out["divergencias"] if d.get("tipo") == "compensacao_excede_consumo"]) == 0
    out["validacoes"]["fator_ajuste_correto"] = len([d for d in out["divergencias"] if d.get("tipo") == "fator_ajuste_em_b_convencional"]) == 0

    return out


# ============================================================
# Classe principal
# ============================================================
class FaturaExtractorV2:
    _mapas_cache = {}

    def __init__(self, fatura_id: int = None, pdf_path: str = None,
                 texto: str = None, conn=None, usar_gmft: bool = False,
                 texto_md_fallback: str = None):
        self.fatura_id = fatura_id
        self.pdf_path = pdf_path
        self.texto = texto
        self.texto_md_fallback = texto_md_fallback  # pymupdf4llm output
        self.conn = conn
        self._owns_conn = False
        self.usar_gmft = usar_gmft
        self.dados = {}

    @classmethod
    def carregar_mapas(cls):
        if cls._mapas_cache: return
        # Aliases pra mapas que vivem em FAMILY_REGISTRY (família compartilhada)
        _FAMILY_ALIAS = {
            "enel_rio": "enel_distribuicao_modern_FAMILY_REGISTRY",
            "enel_ce":  "enel_distribuicao_modern_FAMILY_REGISTRY",
        }
        for raiz, nome in CNPJ_RAIZ_TO_MAPA.items():
            candidatos = [
                f"{nome}_extraction_map.json",
                f"{nome}_FAMILY_REGISTRY.json",
            ]
            if nome in _FAMILY_ALIAS:
                candidatos.insert(0, f"{_FAMILY_ALIAS[nome]}.json")
            for arq in candidatos:
                path = os.path.join(_MAP_DIR, arq)
                if os.path.exists(path):
                    try:
                        with open(path, "r", encoding="utf-8") as f:
                            cls._mapas_cache[raiz] = (nome, json.load(f))
                        break
                    except Exception:
                        continue

    def _conectar(self):
        if self.conn is not None: return
        from completar_vision_5_4 import DB
        self.conn = mysql.connector.connect(**DB, connection_timeout=15)
        self._owns_conn = True

    def _carregar_da_fatura(self):
        """Carrega texto e link da fatura do banco."""
        if not self.fatura_id: return
        self._conectar()
        cur = self.conn.cursor(dictionary=True)
        cur.execute("""SELECT id, distribuidora, valor_total_fatura, link_fatura,
                              texto_plumber, texto_markdown, texto_ocr
                       FROM FATURA_DADOS_EXTRAIDOS WHERE id=%s""", (self.fatura_id,))
        row = cur.fetchone()
        cur.close()
        if not row: raise ValueError(f"Fatura {self.fatura_id} não encontrada")
        partes = []
        for fonte in ("texto_plumber", "texto_markdown", "texto_ocr"):
            t = row.get(fonte)
            if t and len(str(t).strip()) > 100:
                partes.append(str(t))
        self.texto = "\n\n".join(partes)[:40000]
        self.dados["distribuidora_banco"] = row["distribuidora"]
        self.dados["valor_total_fatura"] = float(row["valor_total_fatura"] or 0)
        self.dados["link_fatura"] = row["link_fatura"]

    def _detectar_mapa(self):
        """Detecta CNPJ da DISTRIBUIDORA (não do cliente).

        Estratégia (priorizada):
        1. CNPJ válido na whitelist (próximo a marcadores DISTRIBUIDORA/DANF3E/ENERGIA S.A.)
        2. CNPJ na whitelist em qualquer posição
        3. CNPJ próximo a marcadores de emissor (sem mapa — guarda raiz)
        4. Primeiro CNPJ encontrado
        """
        FaturaExtractorV2.carregar_mapas()
        cnpjs_encontrados = []
        for m in re.finditer(r"(\d{2}\.\d{3}\.\d{3})/\d{4}-\d{2}", self.texto):
            cnpjs_encontrados.append((m.group(1), m.start(), m.group(0)))

        # 1. CNPJ próximo a marcadores de DISTRIBUIDORA E na whitelist
        for raiz, pos, full in cnpjs_encontrados:
            contexto = self.texto[max(0, pos-200):pos+50]
            if any(mk in contexto.upper() for mk in _MARCADORES_DISTRIBUIDORA):
                if raiz in FaturaExtractorV2._mapas_cache:
                    nome, mapa = FaturaExtractorV2._mapas_cache[raiz]
                    self.dados["_mapa_usado"] = nome
                    self.dados["_cnpj_raiz"] = raiz
                    self.dados["_deteccao"] = "whitelist+marcador"
                    return mapa

        # 2. CNPJ na whitelist em qualquer posição (próx a CLIENTE descarta)
        MARCADORES_CLIENTE = ("PAGADOR", "SACADO", "CLIENTE", "CONSUMIDOR",
                              "TITULAR", "DESTINAT", "RESPONS")
        for raiz, pos, full in cnpjs_encontrados:
            contexto = self.texto[max(0, pos-100):pos+50]
            # Descarta se claramente é cliente
            if any(mk in contexto.upper() for mk in MARCADORES_CLIENTE):
                continue
            if raiz in FaturaExtractorV2._mapas_cache:
                nome, mapa = FaturaExtractorV2._mapas_cache[raiz]
                self.dados["_mapa_usado"] = nome
                self.dados["_cnpj_raiz"] = raiz
                self.dados["_deteccao"] = "whitelist"
                return mapa

        # 3. CNPJ próximo a marcador de distribuidora (sem whitelist) — só anota, continua
        for raiz, pos, full in cnpjs_encontrados:
            contexto = self.texto[max(0, pos-200):pos+50]
            if any(mk in contexto.upper() for mk in _MARCADORES_DISTRIBUIDORA):
                self.dados["_cnpj_raiz_distribuidora"] = raiz
                self.dados["_deteccao"] = "marcador_sem_mapa"
                break

        # 4. Anota primeiro CNPJ (sem return) — continua pra fallbacks 5 e 6
        if cnpjs_encontrados:
            self.dados["_cnpj_raiz_primeiro"] = cnpjs_encontrados[0][0]
            self.dados["_deteccao"] = "primeiro_cnpj_sem_whitelist"

        # 5. Fallback: tenta CNPJ do texto_md_fallback (pymupdf4llm)
        if self.texto_md_fallback:
            for m in re.finditer(r"(\d{2}\.\d{3}\.\d{3})/\d{4}-\d{2}", self.texto_md_fallback):
                raiz = m.group(1)
                if raiz in FaturaExtractorV2._mapas_cache:
                    nome, mapa = FaturaExtractorV2._mapas_cache[raiz]
                    self.dados["_mapa_usado"] = nome
                    self.dados["_cnpj_raiz"] = raiz
                    self.dados["_deteccao"] = "pymupdf4llm_fallback"
                    return mapa
            # Pelo menos guarda o primeiro
            first = re.search(r"(\d{2}\.\d{3}\.\d{3})/\d{4}-\d{2}", self.texto_md_fallback)
            if first:
                self.dados["_cnpj_raiz_md_fallback"] = first.group(1)
                self.dados["_deteccao"] = "md_fallback_sem_mapa"
                # NÃO retorna — deixa fluir pra etapa 6 (fallback por nome)

        # 5b. Fallback: extrai CNPJ da chave NFe (dígitos 7-20)
        # Útil quando CNPJ visível está mascarado (ex: EQUATORIAL PA)
        texto_busca = (self.texto or "") + " " + (self.texto_md_fallback or "")
        m_chave = re.search(
            r'\b(\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4})\b|'
            r'\b(\d{44})\b',
            texto_busca
        )
        if m_chave:
            chave_raw = (m_chave.group(1) or m_chave.group(2)).replace(" ", "")
            if len(chave_raw) == 44:
                # CNPJ emissor: digitos 7-20 (index 6-19)
                cnpj_chave_raw = chave_raw[6:20]  # 14 digitos
                # Formata pra '99.999.999/9999-99'
                cnpj_chave_formatted = f"{cnpj_chave_raw[:2]}.{cnpj_chave_raw[2:5]}.{cnpj_chave_raw[5:8]}/{cnpj_chave_raw[8:12]}-{cnpj_chave_raw[12:14]}"
                raiz_chave = f"{cnpj_chave_raw[:2]}.{cnpj_chave_raw[2:5]}.{cnpj_chave_raw[5:8]}"
                if raiz_chave in FaturaExtractorV2._mapas_cache:
                    nome, mapa = FaturaExtractorV2._mapas_cache[raiz_chave]
                    self.dados["_mapa_usado"] = nome
                    self.dados["_cnpj_raiz"] = raiz_chave
                    self.dados["_cnpj_chave_nfe"] = cnpj_chave_formatted
                    self.dados["_deteccao"] = "chave_nfe"
                    return mapa
                # Senão, guarda para investigação
                self.dados["_cnpj_chave_nfe"] = cnpj_chave_formatted

        # 6. Fallback FINAL: detecta por NOME da distribuidora no texto
        # Útil quando texto_plumber não captura CNPJ legível (problema OCR/font)
        texto_combo = (self.texto or "") + " " + (self.texto_md_fallback or "")
        texto_upper = texto_combo.upper()
        NOME_TO_MAPA = [
            (r"ENEL\s+DISTRIBUI[ÇC][ÃA]O\s+S[ÃA]O\s+PAULO", "enel_sp"),
            (r"ENEL\s+(?:DISTRIBUI[ÇC][ÃA]O\s+)?RIO", "enel_rio"),
            (r"AMPLA\s+ENERGIA", "enel_rio"),  # razão social legada
            (r"ENEL\s+(?:DISTRIBUI[ÇC][ÃA]O\s+)?CEAR[ÁA]", "enel_ce"),
            (r"COMPANHIA\s+ENERG[ÉE]TICA\s+DO\s+CEAR[ÁA]", "enel_ce"),
            (r"ELETROPAULO", "enel_sp"),
            # CEMIG: DANF3E moderno ("CEMIG DISTRIBUIÇÃO") + layout clássico "Cemig Atende"
            # (VIA VAREJO/comercial, sem "CEMIG Distribuição" nem CNPJ no corpo)
            (r"CEMIG\s+DISTRIBUI[ÇC][ÃA]O|CEMIGATENDE|CEMIG\s+ATENDE|OUVIDORIA\s+CEMIG", "cemig"),
            # Light: razão social + comunicado moderno ("consumidores da Light") + CNPJ Light
            # na chave (60.444.437) + estrutura legacy 2022 (sem nome no corpo).
            # NOTE: casado contra texto_upper → padrões em MAIÚSCULO.
            (r"LIGHT\s+SERVI[ÇC]OS|CONSUMIDORES\s+DA\s+LIGHT|604444370001|"
             r"ENERGIA\s+ATIVA\s+KWH\s+HFP/", "light"),
            (r"COPEL\s+DISTRIBUI[ÇC][ÃA]O", "celesc"),  # mantém mapa celesc; hidratação detecta COPEL
            (r"CPFL\s+(?:PAULISTA|PIRATININGA|SANTA\s+CRUZ)", "cpfl_santacruz"),
            (r"NEOENERGIA\s+(?:PE|PERNAMBUCO|CELPE)", "neoenergia_cosern"),
            (r"NEOENERGIA\s+(?:BA|BAHIA|COELBA)", "neoenergia_cosern"),
            (r"NEOENERGIA\s+(?:RN|COSERN)", "neoenergia_cosern"),
            (r"ELEKTRO", "elektro_ms"),
            (r"EDP\s+(?:S[ÃA]O\s+PAULO|SP|ESPIRITO\s+SANTO|ES)", "edp"),
            (r"ENERGISA\s+MATO\s+GROSSO", "energisa_mt"),
            (r"ENERGISA\s+SUL", "energisa_ss"),
            (r"EQUATORIAL", "equatorial_norte"),
        ]
        for pat_nome, mapa_nome in NOME_TO_MAPA:
            if re.search(pat_nome, texto_upper):
                if mapa_nome in [v[0] if isinstance(v, tuple) else v for v in FaturaExtractorV2._mapas_cache.values()] or \
                   any(mapa_nome == nome for nome, _ in FaturaExtractorV2._mapas_cache.values()):
                    # achou mapa via nome
                    for raiz, (nome, mp) in FaturaExtractorV2._mapas_cache.items():
                        if nome == mapa_nome:
                            self.dados["_mapa_usado"] = mapa_nome
                            self.dados["_deteccao"] = f"nome_distribuidora:{pat_nome[:40]}"
                            return mp

        # 7. Fallback ÚLTIMO: Aho-Corasick (scoring de keywords de distribuidora)
        if _AC_DISPONIVEL:
            mapa_ac = _ac_distribuidora(texto_combo)
            if mapa_ac:
                for raiz, (nome, mp) in FaturaExtractorV2._mapas_cache.items():
                    if nome == mapa_ac:
                        self.dados["_mapa_usado"] = mapa_ac
                        self.dados["_deteccao"] = "aho_corasick"
                        return mp

        self.dados["_mapa_usado"] = None
        self.dados["_deteccao"] = "sem_cnpj"
        return None

    def _extrair_subgrupo_generico(self):
        """Regex genérica para subgrupo+modalidade quando o mapa não detectar."""
        if not self.dados.get("ligacao_tecnica"): self.dados["ligacao_tecnica"] = {}
        lig = self.dados["ligacao_tecnica"]
        texto_combo = (self.texto or "") + " " + (self.texto_md_fallback or "")
        # Subgrupo
        if not lig.get("subgrupo"):
            for pat in [
                # LIGHT: 'Grupo B / Subgrupo B3 Comercial'
                r'Grupo\s+[AB]\s*/\s*Subgrupo\s+(A[1-4][Aa]?|AS|B[1-4])\b',
                # CPFL: 'CLASSIFICAÇÃO: Convencional B3 Comercial'
                r'CLASSIFICA[ÇC][ÃA]O:\s*(?:Convencional|Verde|Azul|Branca)\s+(A[1-4][Aa]?|B[1-4])',
                # CEMIG B: '... Comercial Comercial Convencional B3' (subgrupo após modalidade)
                r'(?:Convencional|Verde|Azul|Branca)\s+(A[1-4][Aa]?|B[1-4])\b',
                # EDP A: 'A A4 VERDE 13.200 V' (grupo subgrupo modalidade)
                r'\b[AB]\s+(A[1-4][Aa]?|B[1-4])\s+(?:VERDE|AZUL|CONVENCIONAL|BRANCA)\b',
                # COPEL: 'B3 Comercial, Servicos' (no início da linha após cabeçalho)
                r'\b(A[1-4][Aa]?|B[1-4])\s+(?:Comercial|Residencial|Industrial|Rural|Poder)',
                # CEMIG A: 'Classe Subclasse Modalidade Tarifária ... A4 Verde'
                r'Modalidade\s+Tarif[áa]ria[^\n]{0,80}?\b(A[1-4][Aa]?|B[1-4])\s+(?:Verde|Azul|Convencional|Branca)',
                # ENERGISA: 'MTC-CONVENCIONAL BAIXA TENSÃO / B3 COMERCIAL'
                r'MT[VACB][-—]?(?:CONVENCIONAL|VERDE|AZUL|BRANCA)[^/]*/\s*(A[1-4][Aa]?|B[1-4])\b',
                # Padrões originais
                r'\b(A[1-4][Aa]?|AS)\b\s*(?:RURAL|RESIDENCIAL|COMERCIAL|INDUSTRIAL|PODER|GERA)',
                r'\b(B[1-4])\b\s*(?:RURAL|RESIDENCIAL|COMERCIAL|INDUSTRIAL|PODER)',
                r'(?:Subgrupo|SUBGRUPO|SUBGR)\s*:?\s*(A[1-4][Aa]?|AS|B[1-4])',
                r'(?:Classe|CLASSE)\s*:?\s*(?:.*?\s+)?(A[1-4][Aa]?|AS|B[1-4])\b',
                r'\b(A[1-4][Aa]?|B[1-4])\b\s+(?:MOD\.|MODALIDADE)',
            ]:
                m = re.search(pat, texto_combo, re.I | re.M)
                if m:
                    sub = m.group(1).upper()
                    if sub == "A3A": sub = "A3a"
                    lig["subgrupo"] = sub
                    break
        # Modalidade
        if not lig.get("modalidade_tarifaria"):
            modalidade = None
            for pat in [
                # CEMIG A: 'Tarifária ... A4 Verde'
                r'Modalidade\s+Tarif[áa]ria[^\n]{0,80}?(?:A[1-4][Aa]?|B[1-4])\s+(Verde|Azul|Convencional|Branca)',
                # CEMIG B: 'Comercial Comercial Convencional B3'
                r'(?:Comercial|Residencial|Industrial|Rural|Poder)\s+(?:Comercial|Residencial|Industrial|Rural|Poder)?\s*(Verde|Azul|Convencional|Branca)\s+(?:A[1-4][Aa]?|B[1-4])',
                # EDP A: 'A A4 VERDE 13.200 V'
                r'\b[AB]\s+(?:A[1-4][Aa]?|B[1-4])\s+(VERDE|AZUL|CONVENCIONAL|BRANCA)\b',
                # ENEL SP: 'Trifásico Verde'
                r'(?:Trif[áa]sico|Bif[áa]sico|Monof[áa]sico)\s+(Verde|Azul|Convencional|Branca)\b',
                # CPFL: 'CLASSIFICAÇÃO: Convencional B3'
                r'CLASSIFICA[ÇC][ÃA]O:\s*(Convencional|Verde|Azul|Branca)\s+(?:A[1-4][Aa]?|B[1-4])',
                # ELEKTRO: '... CONVENCIONAL / TRIFASICO'
                r'\b(VERDE|AZUL|CONVENCIONAL|BRANCA)\s*/\s*(?:TRIF[ÁA]SICO|BIF[ÁA]SICO|MONO)',
                # COPEL: 'B3 Comercial ... convencional ...' (modalidade adiante)
                r'(?:A[1-4][Aa]?|B[1-4])\s+(?:Comercial|Residencial|Industrial|Rural|Poder)[^\n]{0,200}?\b(Verde|Azul|Convencional|Branca)\b',
                # Originais
                r'\b(?:TARIFA|MODALIDADE)\s+(VERDE|AZUL|CONVENCIONAL|BRANCA)\b',
                r'\b(VERDE|AZUL|CONVENCIONAL|BRANCA)\s+(?:[/-]\s*A[1-4][Aa]?|B[1-4])\b',
                # MTV/MTA shorthand (Energisa)
                r'\bMT(V|A|C|B)\b[-—]?\s*(?:MOD|CONVENCIONAL|VERDE|AZUL)?',
            ]:
                m = re.search(pat, texto_combo, re.I)
                if m:
                    upper = m.group(0).upper()
                    if 'MTV' in upper: modalidade = "Verde"
                    elif 'MTA' in upper: modalidade = "Azul"
                    elif 'MTC' in upper: modalidade = "Convencional"
                    elif 'MTB' in upper: modalidade = "Branca"
                    elif m.groups(): modalidade = m.group(1).title()
                    if modalidade:
                        lig["modalidade_tarifaria"] = modalidade
                        break

        # Fallback Aho-Corasick (scoring por contexto)
        if _AC_DISPONIVEL:
            if not lig.get("subgrupo"):
                ac_sub = _ac_subgrupo(texto_combo)
                if ac_sub: lig["subgrupo"] = ac_sub
            if not lig.get("modalidade_tarifaria"):
                ac_mod = _ac_modalidade(texto_combo)
                if ac_mod: lig["modalidade_tarifaria"] = ac_mod

    def _extrair_regex_extra_energisa(self):
        """Regex específicos para campos secundários da família Energisa."""
        texto = (self.texto or "") + " " + (self.texto_md_fallback or "")
        ident = self.dados.setdefault("identificadores_instalacao", {})
        nf = self.dados.setdefault("nota_fiscal", {})
        cli = self.dados.setdefault("cliente", {})
        per = self.dados.setdefault("periodo_leitura", {})

        # protocolo autorização: número de 15-16 dígitos, com data opcional
        # Pode estar logo após "Protocolo de Autorização:" OU em linhas seguintes
        if not nf.get("protocolo_autorizacao"):
            m = re.search(
                r"Protocolo\s+de\s+(?:Autoriza[çc][ãa]o|autoriza[çc][ãa]o)\s*:?[\s\S]{0,300}?"
                r"(\d{15,16})(?:\s*[-–]\s*(\d{2}/\d{2}/\d{4}(?:\s+\d{2}:\d{2}:\d{2})?))?",
                texto, re.I
            )
            if m:
                if m.group(2):
                    nf["protocolo_autorizacao"] = f"{m.group(1)} - {m.group(2)}"
                else:
                    nf["protocolo_autorizacao"] = m.group(1)

        # Próxima leitura
        if not per.get("proxima_leitura"):
            for pat in [
                r"Pr[óo]xima\s*Leitura\s*:?\s*(\d{2}/\d{2}/\d{4})",
                # Energisa: leituras inline "16/03 13/04 28 12/05"
                r"\b\d{2}/\d{2}/\d{4}\s+\d{2}/\d{2}/\d{4}\s+\d{1,3}\s+(\d{2}/\d{2}/\d{4})\b",
            ]:
                m = re.search(pat, texto, re.I)
                if m: per["proxima_leitura"] = m.group(1); break

        # Matrícula
        if not ident.get("matricula"):
            for pat in [
                r"MATR[ÍI]CULA\s*:?\s*([\d\-\.]{8,20})",
                r"Matr[íi]cula\s*:?\s*([\d\-\.]{8,20})",
            ]:
                m = re.search(pat, texto, re.I)
                if m: ident["matricula"] = m.group(1); break

        # Dom. Banc.
        if not ident.get("dom_bancario"):
            m = re.search(r"DOM\.?\s*BANC\.?\s*:?\s*([\d\s\-\.]+)", texto, re.I)
            if m:
                v = re.sub(r"\s+", " ", m.group(1)).strip()[:50]
                if any(c.isdigit() for c in v):
                    ident["dom_bancario"] = v

        # Código cliente
        if not ident.get("codigo_cliente"):
            for pat in [
                r"(?:C[óo]d\.?\s*(?:do\s*)?Cliente|N[ºo°]\s*do\s*Cliente|Conta\s+Contrato)\s*:?\s*(\d{8,16}[-\d]*)",
                # Energisa MT: 'INDEFINIDO 1.522.364.017-95 NOTA FISCAL' (código UC formato X.XXX.XXX.XXX-XX)
                r"\b(\d\.\d{3}\.\d{3}\.\d{3}-\d{2})\b",
            ]:
                m = re.search(pat, texto, re.I)
                if m: ident["codigo_cliente"] = m.group(1); break

        # Tipo Via (SEGUNDA VIA / PRIMEIRA VIA explícito)
        # Refinado: só aceita quando seguido de fim de linha ou separador (evita "NA PRIMEIRA FATURA")
        if not cli.get("tipo_via"):
            m = re.search(r"\b(SEGUNDA\s+VIA|2[ªa]\s+VIA)\b", texto, re.I)
            if m: cli["tipo_via"] = "SEGUNDA_VIA"
            else:
                # PRIMEIRA VIA só se for explicito (Linha, label) — não a parcial "NA PRIMEIRA FATURA"
                m = re.search(r"(?:^|\n|\|)\s*(PRIMEIRA\s+VIA|1[ªa]\s+VIA)\b", texto, re.I)
                if m: cli["tipo_via"] = "PRIMEIRA_VIA"

        # Código instalação
        if not ident.get("codigo_instalacao"):
            for pat in [
                r"(?:C[óo]d\.?\s*(?:da\s*)?Instala[çc][ãa]o|N[ºo°]\s*da\s*Instala[çc][ãa]o|Instala[çc][ãa]o\s+N[ºo°])\s*:?\s*(\d{8,14})",
                r"\b(W\d{10})\b",  # Energisa
            ]:
                m = re.search(pat, texto, re.I)
                if m: ident["codigo_instalacao"] = m.group(1); break

    def _hidratar_campos(self):
        """Hidratação cross-section: copia dados de seções ricas para campos null."""
        dados = self.dados

        # 1) Info hardcoded da distribuidora (do mapa info_distribuidora_hardcoded)
        mapa_nome = (dados.get("_mapa_usado") or "").lower()
        mapa_full = None
        if mapa_nome:
            # _mapas_cache é keyed por CNPJ raiz — busca pelo nome do mapa
            for _raiz, (_nome, _m) in FaturaExtractorV2._mapas_cache.items():
                if _nome == mapa_nome:
                    mapa_full = _m; break
        if mapa_full:
            hard = (mapa_full or {}).get("info_distribuidora_hardcoded") or {}
            dist = dados.setdefault("distribuidora", {})
            for campo in ("ie_emissor", "endereco_emissor", "cep_emissor", "cidade_uf_emissor"):
                if not dist.get(campo) and hard.get(campo):
                    dist[campo] = hard[campo]
            nf = dados.setdefault("nota_fiscal", {})
            if not nf.get("url_consulta_chave_acesso") and hard.get("url_chave_acesso"):
                nf["url_consulta_chave_acesso"] = hard["url_chave_acesso"]

        # 2) CNPJ cliente: cliente.cnpj_cliente ← validacoes/cnpj_duplo (se já rodou em outro escopo)
        cli = dados.setdefault("cliente", {})
        # validacoes.cnpj_duplo é populado por pdf_pipeline._rodar_pipeline_v3, não pelo extrator.
        # Mas podemos rodar aqui também se ainda não tiver
        if not cli.get("cnpj_cliente"):
            try:
                from validacoes_fatura import extrair_cnpj_duplo
                cd = extrair_cnpj_duplo((self.texto or "") + " " + (self.texto_md_fallback or ""))
                if cd.get("cnpj_cliente_completo"):
                    cli["cnpj_cliente"] = cd["cnpj_cliente_completo"]
                if cd.get("cpf_cliente"):
                    cli["cpf_cliente"] = cd["cpf_cliente"]
                if not cli.get("cnpj_cliente_mascarado") and cd.get("cnpj_corpo_mascarado"):
                    cli["cnpj_cliente_mascarado"] = cd["cnpj_corpo_mascarado"]
            except Exception:
                pass

        # 3) ICMS em tributos_por_dist ← validacoes.tributos (se faltou)
        tpd = dados.setdefault("tributos_por_dist", {})
        if "icms" not in tpd:
            # tenta validacoes.tributos (não temos aqui, mas se _aplicar_mapa preencheu tributos_resumo, usa)
            tr_resumo = dados.get("tributos_resumo") or {}
            if tr_resumo.get("icms") and tr_resumo["icms"].get("valor"):
                tpd["icms"] = {
                    "base_string": tr_resumo["icms"].get("base_calculo"),
                    "aliquota_pct": tr_resumo["icms"].get("aliquota_pct"),
                    "valor_string": tr_resumo["icms"].get("valor"),
                }
            # Tenta também totais_tabela_itens
            tt = dados.get("totais_tabela_itens") or {}
            if "icms" not in tpd and tt.get("icms_total"):
                tpd["icms"] = {
                    "base_string": tt.get("base_icms_total"),
                    "aliquota_pct": None,
                    "valor_string": tt.get("icms_total"),
                }

    def _aplicar_mapa(self, mapa: dict):
        if not mapa: return
        for secao_nome, secao_specs in mapa.items():
            if secao_nome.startswith("_") or secao_nome in ("documento", "observacoes_gerais"):
                continue
            if not isinstance(secao_specs, dict): continue
            secao_out = {}
            for campo, spec in secao_specs.items():
                if isinstance(spec, dict):
                    secao_out[campo] = aplicar_spec(spec, self.texto)
            if any(v for v in secao_out.values()):
                self.dados[secao_nome] = secao_out

    def extrair_tudo(self):
        if self.fatura_id and not self.texto:
            self._carregar_da_fatura()
        if not self.texto:
            raise ValueError("Sem texto para processar")

        # ROUTER: detecta tipo de fatura e roteia para extrator específico
        try:
            from extrator_cooperativa import eh_fatura_cooperativa, extrair_cooperativa
            if eh_fatura_cooperativa(self.texto):
                self.dados = extrair_cooperativa(self.texto)
                # Auditoria GD ainda roda (mesmo que vazia)
                self.dados["auditoria_gd"] = auditar_gd(self.dados)
                return self.dados
        except Exception as e:
            self.dados["_router_cooperativa_erro"] = str(e)[:200]

        mapa = self._detectar_mapa()
        self._aplicar_mapa(mapa)

        # Fallback genérico de subgrupo/modalidade quando o mapa não detectou
        self._extrair_subgrupo_generico()

        # Quadro GD
        self.dados["geracao_distribuida"] = extrair_quadro_gd(self.texto)

        # Tabela de itens — estratégia em cascata:
        # 1) Padrões específicos por distribuidora (EDP CCI, CELESC CCI, CPFL GD)
        # 2) Regex linha-a-linha genérico
        # 3) Fallback pdfplumber (raro)
        itens_acum = []
        mapa_nome = (self.dados.get("_mapa_usado") or "").lower()
        if "edp" in mapa_nome:
            itens_acum.extend(extrair_itens_edp_cci(self.texto))
        if "celesc" in mapa_nome:
            itens_acum.extend(extrair_itens_celesc_cci(self.texto))
        if "cpfl" in mapa_nome or "rge" in mapa_nome:
            itens_acum.extend(extrair_itens_cpfl_gd(self.texto))

        # Aplica regex genérico SEMPRE (complementa)
        itens_gen = extrair_itens_linha_a_linha(self.texto)
        # Mescla evitando duplicatas (chave: desc+valor)
        seen = {(it["descricao"], round(it.get("valor_brl_numerico") or 0, 2)) for it in itens_acum}
        for it in itens_gen:
            key = (it["descricao"], round(it.get("valor_brl_numerico") or 0, 2))
            if key not in seen:
                seen.add(key); itens_acum.append(it)

        if itens_acum:
            self.dados["itens_fatura"] = itens_acum
        elif self.pdf_path and os.path.exists(self.pdf_path):
            itens_pdf = extrair_tabela_itens(self.pdf_path)
            if itens_pdf:
                self.dados["itens_fatura"] = itens_pdf

        # Heurísticas de POSTO em itens GD (mUC oPT/mPT)
        if self.dados.get("itens_fatura"):
            _inferir_posto_mUC_proximidade(self.dados["itens_fatura"])
            _inferir_posto_por_tarifa(self.dados["itens_fatura"])

        # Histórico 13 meses via regex (substitui GMFT)
        historico = extrair_historico_13m(self.texto, self.dados.get("_mapa_usado") or "")
        if historico:
            self.dados["historico_13m_regex"] = historico

        # CAMADA GMFT — DESABILITADO POR PADRÃO (15x mais lento, +1.9pp ganho real em 20 amostras)
        # Habilitar com FaturaExtractorV2(..., usar_gmft=True) quando precisar do histórico 13m
        if self.usar_gmft and self.pdf_path and os.path.exists(self.pdf_path):
            tabelas_gmft = extrair_tabelas_gmft(self.pdf_path)
            if tabelas_gmft:
                tabelas_por_tipo = {}
                for tab in tabelas_gmft:
                    tipo = identificar_tipo_tabela(tab.get("headers") or [])
                    tab["_tipo_inferido"] = tipo
                    tabelas_por_tipo.setdefault(tipo, []).append(tab)
                self.dados["tabelas_gmft"] = tabelas_por_tipo
                hist = tabelas_por_tipo.get("historico_13m")
                if hist:
                    self.dados["historico_13m_gmft"] = hist[0]

        # PyMuPDF blocks — fallback para quadro Saldo Ac em PDFs disponíveis
        if self.pdf_path and os.path.exists(self.pdf_path):
            gd_atual = self.dados.get("geracao_distribuida") or {}
            if not gd_atual.get("saldo_acumulado_fora_ponta_kwh"):
                blocos = extrair_blocos_pdf(self.pdf_path)
                if blocos:
                    saldo_blocos = extrair_saldo_blocos(blocos)
                    if saldo_blocos.get("saldo_ponta_kwh") is not None or saldo_blocos.get("saldo_fora_ponta_kwh") is not None:
                        gd_atual["saldo_acumulado_ponta_kwh"] = saldo_blocos.get("saldo_ponta_kwh")
                        gd_atual["saldo_acumulado_fora_ponta_kwh"] = saldo_blocos.get("saldo_fora_ponta_kwh")
                        gd_atual["_fonte_saldo"] = saldo_blocos.get("fonte")
                        gd_atual["tem_gd"] = True
                        self.dados["geracao_distribuida"] = gd_atual

        # Template bbox por distribuidora (camada de precisão final)
        # Roda só se PDF disponível e template existir para o mapa detectado
        if _TEMPLATE_DISPONIVEL and self.pdf_path and os.path.exists(self.pdf_path):
            mapa_nome = (self.dados.get("_mapa_usado") or "").lower()
            # Usa resolver inteligente que considera grupo+modalidade
            tmpl_nome = _resolver_template(mapa_nome, self.dados)
            if tmpl_nome:
                try:
                    tmpl_out = _template_aplicar(self.pdf_path, tmpl_nome)
                    self.dados["_template_aplicado"] = tmpl_nome
                    lig = self.dados.get("ligacao_tecnica") or {}
                    # Template é "ground truth" — sobrescreve regex/AC
                    if tmpl_out.get("subgrupo"):
                        lig["subgrupo"] = tmpl_out["subgrupo"]
                    if tmpl_out.get("modalidade_tarifaria"):
                        lig["modalidade_tarifaria"] = tmpl_out["modalidade_tarifaria"]
                    # Override forte pela info do nome do template (mais confiável que bbox amplo)
                    tmpl_lower = tmpl_nome.lower()
                    if "_convencional" in tmpl_lower or "_conv" in tmpl_lower:
                        lig["modalidade_tarifaria"] = "Convencional"
                    elif "_verde" in tmpl_lower:
                        lig["modalidade_tarifaria"] = "Verde"
                    elif "_azul" in tmpl_lower:
                        lig["modalidade_tarifaria"] = "Azul"
                    elif "_branca" in tmpl_lower:
                        lig["modalidade_tarifaria"] = "Branca"
                    if any(lig.values()):
                        self.dados["ligacao_tecnica"] = lig
                    # Tributos do template
                    trib_tmpl = {}
                    if tmpl_out.get("pis_cofins_combinado"):
                        trib_tmpl["pis_cofins"] = {"valor_string": tmpl_out["pis_cofins_combinado"]}
                    if tmpl_out.get("icms_base") and tmpl_out.get("icms_valor"):
                        trib_tmpl["icms"] = {
                            "base_string": tmpl_out["icms_base"],
                            "valor_string": tmpl_out["icms_valor"],
                        }
                    if trib_tmpl:
                        self.dados["tributos_template"] = trib_tmpl
                    if tmpl_out.get("valor_total_fatura"):
                        self.dados["valor_total_fatura_template"] = tmpl_out["valor_total_fatura"]
                except Exception as e:
                    self.dados["_template_erro"] = str(e)[:200]

        # Tributos por distribuidora (regex específico)
        mapa_atual = (self.dados.get("_mapa_usado") or "").lower()
        if mapa_atual:
            try:
                from tributos_por_dist import extrair_tributos_por_dist
                trib_dist = extrair_tributos_por_dist(self.texto, mapa_atual)
                if trib_dist:
                    self.dados["tributos_por_dist"] = trib_dist
            except Exception as e:
                self.dados["_trib_dist_erro"] = str(e)[:200]

        # Tributos agregados dos itens (fallback robusto)
        try:
            from tributos_por_dist import somar_tributos_dos_itens, extrair_total_linha
            trib_soma = somar_tributos_dos_itens(self.dados.get("itens_fatura") or [])
            if trib_soma:
                self.dados["tributos_agregados_itens"] = trib_soma
            # Linha TOTAL (CEMIG/Energisa style)
            trib_total = extrair_total_linha(self.texto)
            if trib_total:
                self.dados["tributos_total_linha"] = trib_total
        except Exception as e:
            pass

        # Regex extras (campos secundários — tipo_via, protocolo, próx leitura, matrícula, etc)
        try: self._extrair_regex_extra_energisa()
        except Exception as e: self.dados["_regex_extra_erro"] = str(e)[:200]

        # Hidratação cross-section (info hardcoded da dist + CNPJ cliente + ICMS faltante)
        try: self._hidratar_campos()
        except Exception as e: self.dados["_hidratar_erro"] = str(e)[:200]

        # Extrator complementar (cliente UC, vencimento correto, mUC vs oUC, histórico, DICRI, etc)
        try:
            from extrator_complementar import aplicar_complementos
            aplicar_complementos(self.dados, self.texto or "", texto_md=self.texto_md_fallback)
        except Exception as e:
            self.dados["_complementar_erro"] = str(e)[:200]

        # Auditoria Python pura
        self.dados["auditoria_gd"] = auditar_gd(self.dados)

        # Contagem cobertura — inclui itens e validações
        n_total = 0; n_preench = 0
        for k, v in self.dados.items():
            if k.startswith("_"): continue
            if isinstance(v, dict):
                for vv in v.values():
                    if isinstance(vv, (dict, list)):
                        n_total += 1
                        if vv: n_preench += 1
                    else:
                        n_total += 1
                        if vv not in (None, "", []): n_preench += 1
            elif isinstance(v, list):
                # Itens fatura: cada item conta como campo
                if k == "itens_fatura":
                    for it in v:
                        n_total += 1
                        if it: n_preench += 1
                else:
                    n_total += 1
                    if v: n_preench += 1

        n_itens = len(self.dados.get("itens_fatura") or [])
        self.dados["_cobertura"] = {
            "campos_totais": n_total,
            "campos_preenchidos": n_preench,
            "pct": round(n_preench/n_total*100, 1) if n_total else 0,
            "n_itens_extraidos": n_itens,
        }

        if self._owns_conn and self.conn:
            self.conn.close()

        return self.dados


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding='utf-8') if sys.platform == 'win32' else None
    fid = int(sys.argv[1]) if len(sys.argv) > 1 else 52391
    import time
    start = time.time()
    out = FaturaExtractorV2(fatura_id=fid).extrair_tudo()
    elapsed = time.time() - start
    print(f"Tempo: {elapsed*1000:.0f}ms")
    print(json.dumps(out, ensure_ascii=False, indent=2, default=str)[:6000])
