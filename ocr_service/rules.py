import re
from typing import Dict, Any, Optional, List, Tuple

# número em formato brasileiro, com ou sem milhar, com ou sem decimal
_NUM = r"(?:\d{1,3}(?:[\.\s]\d{3})*|\d+)(?:[\.,]\d+)?"
_DEC_COMMA_NUM = r"\d{1,3}(?:\.\d{3})*,\d{2}"

TAX_ORDER = ["PIS", "COFINS", "ICMS"]


def _to_float(s: str) -> Optional[float]:
    try:
        s = (s or "").strip().replace(" ", "")
        if not s:
            return None
        # Normalize Brazilian format: 1.234,56 -> 1234.56
        if "," in s and s.count(",") == 1 and s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        return float(s)
    except Exception:
        return None


def _find_snippet(text: str, pat: str, window: int = 50) -> Optional[str]:
    m = re.search(pat, text, flags=re.IGNORECASE)
    if not m:
        return None
    start = max(m.start() - window, 0)
    end = min(m.end() + window, len(text))
    snippet = text[start:end].replace("\n", " ")
    snippet = re.sub(r"\s+", " ", snippet).strip()
    return snippet


def _find_first_group(patterns: List[str], text: str) -> Optional[str]:
    for pat in patterns:
        m = re.search(pat, text, flags=re.IGNORECASE)
        if m:
            try:
                return m.group("num")
            except Exception:
                return m.group(1)
    return None


def _extract_block_from_anchor(text: str, anchors: List[str], max_chars: int = 1200) -> str:
    lower = text.lower()
    best_idx = -1
    for a in anchors:
        idx = lower.find(a.lower())
        if idx != -1 and (best_idx == -1 or idx < best_idx):
            best_idx = idx
    if best_idx == -1:
        return ""
    return text[best_idx : best_idx + max_chars]


# ---------------------------------------------------------------------
# META: identificação (Código do cliente / Instalação / UC / etc)
# ---------------------------------------------------------------------
def extract_identificacao(raw_text: str) -> Dict[str, Any]:
    text_raw = raw_text or ""
    lower = text_raw.lower()

    cliente_pats = [
        r"c[oó]digo\s+do\s+cliente\s*[:\-]?\s*(?P<num>\d{4,})",
        r"n[ºo]\s*do\s*cliente\s*[:\-]?\s*(?P<num>\d{4,})",
        r"numero\s+do\s+cliente\s*[:\-]?\s*(?P<num>\d{4,})",
    ]
    instal_pats = [
        r"c[oó]digo\s+da\s+instala[cç][aã]o\s*[:\-]?\s*(?P<num>\d{4,})",
        r"n[ºo]\s*da\s+instala[cç][aã]o\s*[:\-]?\s*(?P<num>\d{4,})",
        r"\buc\s*[:\-]?\s*(?P<num>\d{4,})",
        r"unidade\s+consumidora\s*[:\-]?\s*(?P<num>\d{4,})",
    ]

    numero_cliente = _find_first_group(cliente_pats, text_raw)
    unidade_consumidora = _find_first_group(instal_pats, text_raw)

    cliente_ctx = _find_snippet(text_raw, re.escape(numero_cliente), window=80) if numero_cliente else None
    uc_ctx = _find_snippet(text_raw, re.escape(unidade_consumidora), window=80) if unidade_consumidora else None

    palavras_chave = [
        "código do cliente",
        "codigo do cliente",
        "cliente",
        "instalação",
        "instalacao",
        "unidade consumidora",
        "uc",
        "medidor",
        "conta contrato",
    ]
    encontrados = [p for p in palavras_chave if p in lower]

    return {
        "numero_cliente": numero_cliente,
        "numero_cliente_contexto": cliente_ctx,
        "unidade_consumidora": unidade_consumidora,
        "uc_contexto": uc_ctx,
        "palavras_relacionadas_encontradas": encontrados,
    }


# ---------------------------------------------------------------------
# BANDEIRA (genérica)
# ---------------------------------------------------------------------
def apply_bandeira_generic(raw_text: str) -> Dict[str, Any]:
    text = raw_text or ""
    lower = text.lower()

    m = re.search(
        r"bandeira\s+(?:em\s+vigor|vigente|tarif[aá]ria)?\s*(?:é|:)?\s*(?:a\s+)?"
        r"(verde|amarela|vermelha(?:\s*patamar\s*(?:1|i|2|ii))?|escassez\s+h[ií]drica)",
        lower,
        flags=re.IGNORECASE,
    )
    if m:
        b = re.sub(r"\s+", " ", m.group(1).strip()).title().replace("Hidrica", "Hídrica")
        return {"bandeira": b, "fonte": "match_bandeira_em_vigor"}

    if "bandeira" in lower:
        for k in ["verde", "amarela", "vermelha", "escassez hídrica", "escassez hidrica"]:
            if k in lower:
                b = k.title().replace("Hidrica", "Hídrica")
                return {"bandeira": b, "fonte": "fallback_keyword"}

    return {"bandeira": None, "fonte": "not_found"}


# ---------------------------------------------------------------------
# TRIBUTOS - tabela "TRIBUTO BASE DE CÁLCULO ... ALÍQUOTA ... VALOR"
# (CORRIGIDO: começa no anchor certo pra não pegar números da tabela de itens)
# ---------------------------------------------------------------------
def _parse_tributos_table(raw_text: str) -> Tuple[Dict[str, Any], Optional[str]]:
    text = raw_text or ""

    # âncora mais confiável (começa exatamente na tabelinha de tributos)
    block = _extract_block_from_anchor(
        text,
        anchors=[
            "TRIBUTO  BASE DE",
            "TRIBUTO BASE DE",
            "TRIBUTO  BASE",
            "TRIBUTO BASE",
        ],
        max_chars=1400,
    )
    if not block:
        return {}, None

    # precisa ter os 3 tributos na área
    if not re.search(r"\b(pis|cofins|icms)\b", block, flags=re.IGNORECASE):
        return {}, block

    # pega ordem de labels (normalmente PIS, COFINS, ICMS)
    label_matches = list(re.finditer(r"\b(PIS|COFINS|ICMS)\b", block, flags=re.IGNORECASE))
    order: List[str] = []
    for m in label_matches:
        t = m.group(1).upper()
        if t not in order:
            order.append(t)
    if not order:
        return {}, block

    # IMPORTANTE: começar a ler números APÓS o último label da lista (ex.: "... PIS COFINS ICMS <números>")
    last_label_pos = 0
    for m in label_matches:
        if m.group(1).upper() in order:
            last_label_pos = max(last_label_pos, m.end())

    numbers_part = block[last_label_pos:]

    nums: List[float] = []
    for mn in re.finditer(_NUM, numbers_part):
        v = _to_float(mn.group(0))
        if v is not None:
            nums.append(v)

    n = len(order)
    # layout típico: bases(n) + aliquotas(n) + valores(n)
    if len(nums) >= 3 * n:
        bases = nums[0:n]
        aliqs = nums[n : 2 * n]
        vals = nums[2 * n : 3 * n]

        out: Dict[str, Any] = {}
        for i, tax in enumerate(order):
            out[tax] = {
                "base_calculo": bases[i] if i < len(bases) else None,
                "aliquota_percent": aliqs[i] if i < len(aliqs) else None,
                "valor": vals[i] if i < len(vals) else None,
            }
        return out, block

    return {}, block


def apply_tributos_table(raw_text: str) -> Dict[str, Any]:
    tribs, block = _parse_tributos_table(raw_text)
    return {
        "tributos": tribs,
        "fonte_extracao": "TRIBUTO_TABLE" if tribs else "NOT_FOUND",
        "raw_block_hint": (block[:350] + "…") if block and len(block) > 350 else block,
    }


# ---------------------------------------------------------------------
# ICMS (genérico) - tabela primeiro, depois regex
# ---------------------------------------------------------------------
def apply_icms(raw_text: str) -> Dict[str, Any]:
    text = raw_text or ""
    lower = text.lower()

    tribs, _block = _parse_tributos_table(text)
    if tribs.get("ICMS"):
        ic = tribs["ICMS"]
        issues: List[str] = []
        if ic.get("base_calculo") is None:
            issues.append("base_calculo_ausente")
        if ic.get("aliquota_percent") is None:
            issues.append("aliquota_ausente")
        if ic.get("valor") is None:
            issues.append("valor_icms_ausente")

        return {
            "icms_aplicado": "icms" in lower,
            "base_calculo": ic.get("base_calculo"),
            "aliquota_percent": ic.get("aliquota_percent"),
            "valor_icms": ic.get("valor"),
            "issues": issues,
            "fonte_extracao": "TRIBUTO_TABLE",
        }

    # fallback regex
    icms_present = "icms" in lower

    base_pat = re.compile(
        rf"base\s*(?:de)?\s*c[áa]lculo\s*[:\-]?\s*(?P<v>R?\$?\s*{_NUM})",
        re.IGNORECASE,
    )
    aliq_pat = re.compile(
        rf"aliq(?:u?ota)?\s*(?:icms)?\s*[:\-]?\s*(?P<v>{_NUM})\s*%?",
        re.IGNORECASE,
    )
    valor_pat = re.compile(
        rf"valor\s*(?:do)?\s*icms\s*[:\-]?\s*(?P<v>R?\$?\s*{_NUM})",
        re.IGNORECASE,
    )

    def find_first(pat: re.Pattern) -> Optional[str]:
        m = pat.search(text)
        if not m:
            return None
        v = m.group("v").strip()
        v = re.sub(r"(?i)r\$", "", v).strip()
        return v

    base = _to_float(find_first(base_pat) or "")
    aliquota = _to_float(find_first(aliq_pat) or "")
    valor = _to_float(find_first(valor_pat) or "")

    issues: List[str] = []
    if not icms_present:
        issues.append("mencao_ICMS_ausente")
    if base is None:
        issues.append("base_calculo_ausente")
    if aliquota is None:
        issues.append("aliquota_ausente")
    if valor is None:
        issues.append("valor_icms_ausente")

    return {
        "icms_aplicado": bool(icms_present),
        "base_calculo": base,
        "aliquota_percent": aliquota,
        "valor_icms": valor,
        "issues": issues,
        "fonte_extracao": "REGEX_FALLBACK",
    }


# ---------------------------------------------------------------------
# ILTTIO (CORRIGIDO): leituras Energia Ativa e tarifa do item Consumo-TUSD
# ---------------------------------------------------------------------
def _extract_dias(text: str) -> Optional[int]:
    m = re.search(r"n[°ºo]?\s*de\s*dias\s*([0-9]{1,3})", text, flags=re.IGNORECASE)
    v = _to_float(m.group(1)) if m else None
    return int(v) if v is not None else None


def _extract_consumo_faturado(text: str) -> Optional[float]:
    # pega o primeiro consumo do bloco CONSUMO FATURADO (JAN23 245 29 ...)
    m = re.search(
        r"CONSUMO\s*/\s*kWh.*?CONSUMO\s+FATURADO.*?\b[A-Z]{3}\d{2}\b\s*([0-9]{1,6})\b",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if m:
        return _to_float(m.group(1))
    # fallback: qualquer "CONSUMO FATURADO ... JAN23 ... 245"
    m2 = re.search(
        r"CONSUMO\s+FATURADO.*?\b[A-Z]{3}\d{2}\b\s*([0-9]{1,6})\b",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    return _to_float(m2.group(1)) if m2 else None


def _extract_leituras_energia_ativa(text: str) -> Tuple[Optional[float], Optional[float]]:
    m = re.search(r"Energia\s+Ativa", text, flags=re.IGNORECASE)
    if not m:
        return None, None

    snippet = text[m.start() : m.start() + 350]

    # corta antes de Energia Reativa (pra não misturar)
    m2 = re.search(r"Energia\s+Reativa", snippet, flags=re.IGNORECASE)
    if m2:
        snippet = snippet[: m2.start()]

    # pega dois números com vírgula (leituras)
    nums = re.findall(_DEC_COMMA_NUM, snippet)
    if len(nums) >= 2:
        return _to_float(nums[0]), _to_float(nums[1])

    # fallback: números gerais
    allnums = [ _to_float(x.group(0)) for x in re.finditer(_NUM, snippet) ]
    allnums = [v for v in allnums if v is not None]
    if len(allnums) >= 2:
        return allnums[0], allnums[1]

    return None, None


def _extract_tusd_item(text: str) -> Dict[str, Optional[float]]:
    lower = text.lower()
    start = lower.find("consumo-tusd")
    if start == -1:
        start = lower.find("consumo tusd")
    if start == -1:
        return {"quant_kwh": None, "preco_unit": None, "valor_rs": None}

    # termina no próximo item “Consumo-TE” ou antes de “Multa/Juros/IPCA”
    end_candidates = []
    for term in ["consumo-te", "consumo te", "multa", "juros", "ipca"]:
        idx = lower.find(term, start + 5)
        if idx != -1:
            end_candidates.append(idx)
    end = min(end_candidates) if end_candidates else min(len(text), start + 450)

    snippet = text[start:end]
    vals: List[float] = []
    for mn in re.finditer(_NUM, snippet):
        v = _to_float(mn.group(0))
        if v is not None:
            vals.append(v)

    # heurística típica do item:
    # 245,00 (quant) ; 0,68078367 (preço) ; 166,79 (valor)
    quant = None
    preco = None
    total = None

    for i, v in enumerate(vals):
        if quant is None and 0 < v < 200000:
            quant = v
            # preço unit geralmente pequeno (0 < x < 50)
            for j in range(i + 1, min(i + 8, len(vals))):
                v2 = vals[j]
                if 0 < v2 < 50:
                    preco = v2
                    break
            # valor geralmente maior que preço e menor que 1e6
            for j in range(i + 1, min(i + 12, len(vals))):
                v3 = vals[j]
                if 0 < v3 < 1_000_000 and (preco is None or v3 > preco):
                    total = v3
                    break
            break

    return {"quant_kwh": quant, "preco_unit": preco, "valor_rs": total}


def apply_ilttio(raw_text: str) -> Dict[str, Any]:
    text = raw_text or ""
    lower = text.lower()

    leitura_anterior, leitura_atual = _extract_leituras_energia_ativa(text)
    dias = _extract_dias(text)
    consumo_faturado = _extract_consumo_faturado(text)

    tusd = _extract_tusd_item(text)
    tarifa_unitaria = tusd.get("preco_unit")

    consumo_calculado = None
    if leitura_anterior is not None and leitura_atual is not None:
        diff = leitura_atual - leitura_anterior
        if diff >= 0:
            consumo_calculado = diff

    grupo = "Desconhecido"
    if "grupo a" in lower:
        grupo = "Grupo A"
    elif "grupo b" in lower or "classificação: b" in lower or "classificacao: b" in lower:
        grupo = "Grupo B"

    issues: List[str] = []
    msgs: List[str] = []

    if tarifa_unitaria is None:
        issues.append("Tarifa unitária ausente")
        msgs.append("Tarifa unitária do item Consumo-TUSD não localizada com segurança.")

    if leitura_anterior is None or leitura_atual is None:
        issues.append("Leituras do medidor não identificadas")
        msgs.append("Não foi possível extrair leituras (Energia Ativa) para checar o consumo.")

    if consumo_calculado is not None and consumo_faturado is not None:
        if abs(consumo_calculado - consumo_faturado) > 0.05 * max(consumo_calculado, 1):
            issues.append("Consumo divergente")
            msgs.append("Consumo calculado diverge do faturado (>5%).")

    erro_identificado = bool(issues)
    resultado_final = "Fatura correta" if not erro_identificado else "Erro identificado"
    recomendacao = "Fatura correta" if not erro_identificado else "Solicitar revisão da fatura à distribuidora"

    return {
        "leitura_anterior": leitura_anterior,
        "leitura_atual": leitura_atual,
        "dias": dias,
        "consumo_calculado": consumo_calculado,
        "consumo_faturado": consumo_faturado,
        "tusd_quant_kwh": tusd.get("quant_kwh"),
        "tusd_preco_unit": tusd.get("preco_unit"),
        "tusd_valor_rs": tusd.get("valor_rs"),
        "tarifa_unitaria": tarifa_unitaria,
        "grupo_tarifario": grupo,
        "erro_identificado": erro_identificado,
        "tipo_erro": ", ".join(issues) if issues else "Nenhum",
        "diagnostico_final": " ".join(msgs) if msgs else "Checks básicos OK.",
        "recomendacao": recomendacao,
        "resultado_final": resultado_final,
    }


# ---------------------------------------------------------------------
# BANDEIRA ENEL SP Grupo B – 09/2024
# (deixe sua implementação real aqui, se você usa essa regra)
# ---------------------------------------------------------------------
def apply_bandeira_enel_sp_gb(raw_text: str) -> Dict[str, Any]:
    return {
        "elegivel": False,
        "motivo_nao_elegivel": "regra_especifica_nao_incluida_neste_arquivo",
        "bandeira_lida": None,
        "dias_total": None,
    }


# ---------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------
def apply_rules(raw_text: str, rules: List[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    out["META"] = extract_identificacao(raw_text)

    for r in (rules or []):
        key = (r or "").strip().upper()
        if not key:
            continue

        if key == "ICMS":
            out["ICMS"] = apply_icms(raw_text)
        elif key in ("TRIBUTOS", "TRIBUTOS_TABLE"):
            out["TRIBUTOS_TABLE"] = apply_tributos_table(raw_text)
        elif key in ("BANDEIRA", "BANDEIRA_GENERIC"):
            out["BANDEIRA_GENERIC"] = apply_bandeira_generic(raw_text)
        elif key == "BANDEIRA_ENEL_SP_GB":
            out["BANDEIRA_ENEL_SP_GB"] = apply_bandeira_enel_sp_gb(raw_text)
        elif key == "ILTTIO":
            out["ILTTIO"] = apply_ilttio(raw_text)
        else:
            pass

    return out
