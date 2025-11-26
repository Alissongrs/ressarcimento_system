import re
from typing import Dict, Any, Optional

# número em formato brasileiro, com ou sem milhar, com ou sem decimal
_NUM = r"(?:\d{1,3}(?:[\.\s]\d{3})*|\d+)(?:[\.,]\d+)?"


def _to_float(s: str) -> Optional[float]:
    try:
        # Normalize Brazilian format: 1.234,56 -> 1234.56
        s = s.strip()
        s = s.replace(" ", "")
        if "," in s and s.count(",") == 1 and s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        return float(s)
    except Exception:
        return None


# ---------------------------------------------------------------------
# META: identificação (Nº do cliente / UC / palavras relacionadas)
# ---------------------------------------------------------------------


def _find_first_group(patterns: list[str], text: str) -> Optional[str]:
    """Tenta uma lista de regex e devolve o primeiro grupo capturado."""
    for pat in patterns:
        m = re.search(pat, text, flags=re.IGNORECASE)
        if m:
            try:
                return m.group("num")
            except Exception:
                return m.group(1)
    return None


def _find_snippet(text: str, pat: str, window: int = 40) -> Optional[str]:
    """Trechinho do texto ao redor do match pra contexto."""
    m = re.search(pat, text, flags=re.IGNORECASE)
    if not m:
        return None
    start = max(m.start() - window, 0)
    end = min(m.end() + window, len(text))
    snippet = text[start:end].replace("\n", " ")
    snippet = re.sub(r"\s+", " ", snippet).strip()
    return snippet


def extract_identificacao(raw_text: str) -> Dict[str, Any]:
    """
    Extrai:
      - numero_cliente (ENEL SP)
      - unidade_consumidora (UC), se aparecer
      - palavras-chave relacionadas encontradas no texto
    """
    text_raw = raw_text or ""
    text = text_raw.lower()

    # Padrões para N° do cliente (ex.: "Nº do cliente: 10093089")
    cliente_pats = [
        r"n[ºo]\s*do\s*cliente\s*[:\-]?\s*(?P<num>\d{4,})",
        r"n[ºo]\s*cliente\s*[:\-]?\s*(?P<num>\d{4,})",
        r"numero\s+do\s+cliente\s*[:\-]?\s*(?P<num>\d{4,})",
    ]

    numero_cliente = _find_first_group(cliente_pats, text_raw)
    cliente_snippet = None
    if numero_cliente:
        cliente_snippet = _find_snippet(
            text_raw,
            r"n[ºo]\s*do\s*cliente.*?" + re.escape(numero_cliente),
        )

    # Padrões para UC / Unidade Consumidora
    uc_pats = [
        r"\buc\s*[:\-]?\s*(?P<num>\d{4,})",
        r"unidade\s+consumidora\s*[:\-]?\s*(?P<num>\d{4,})",
        r"n[ºo]\s*da\s*unidade\s*consumidora\s*[:\-]?\s*(?P<num>\d{4,})",
    ]
    unidade_consumidora = _find_first_group(uc_pats, text_raw)
    uc_snippet = None
    if unidade_consumidora:
        uc_snippet = _find_snippet(
            text_raw,
            r"(uc|unidade\s+consumidora).*?" + re.escape(unidade_consumidora),
        )

    # Palavras relacionadas (só pra você enxergar se o OCR “viu” elas)
    palavras_chave = [
        "uc",
        "unidade consumidora",
        "nº do cliente",
        "numero do cliente",
        "cliente",
        "instalação",
        "nº da instalação",
        "medidor",
    ]
    palavras_encontradas = [p for p in palavras_chave if p in text]

    return {
        "numero_cliente": numero_cliente,
        "numero_cliente_contexto": cliente_snippet,
        "unidade_consumidora": unidade_consumidora,
        "uc_contexto": uc_snippet,
        "palavras_relacionadas_encontradas": palavras_encontradas,
    }


# ---------------------------------------------------------------------
# Regra ICMS (genérica)
# ---------------------------------------------------------------------


def apply_icms(raw_text: str) -> Dict[str, Any]:
    text = raw_text or ""
    lower = text.lower()

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
    tarifa_pat = re.compile(
        r"tarifa\s*[:\-]?\s*(?P<v>[\w\-\s\/\(\)]+)",
        re.IGNORECASE,
    )

    def find_first(pat: re.Pattern[str]) -> Optional[str]:
        m = pat.search(text)
        if not m:
            return None
        v = m.group("v").strip()
        v = re.sub(r"(?i)r\$", "", v).strip()
        return v

    base = _to_float(find_first(base_pat) or "")
    aliquota = _to_float(find_first(aliq_pat) or "")
    valor = _to_float(find_first(valor_pat) or "")
    tarifa = None
    tm = tarifa_pat.search(text)
    if tm:
        tarifa = tm.group("v").strip()
        tarifa = re.sub(r"\s+", " ", tarifa)
        if len(tarifa) > 80:
            tarifa = tarifa[:80] + "…"

    issues = []
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
        "tarifa": tarifa,
        "issues": issues,
    }


# ---------------------------------------------------------------------
# Dispatcher de regras
# ---------------------------------------------------------------------


def apply_rules(raw_text: str, rules: list[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}

    # Sempre traz identificação básica (Nº cliente / UC / palavras)
    out["META"] = extract_identificacao(raw_text)

    for r in rules or []:
        key = r.strip().upper()
        if key == "ICMS":
            out["ICMS"] = apply_icms(raw_text)
        elif key == "BANDEIRA_ENEL_SP_GB":
            out["BANDEIRA_ENEL_SP_GB"] = apply_bandeira_enel_sp_gb(raw_text)

    return out


# ---------------------------------------------------------------------
# Regra de BANDEIRA ENEL SP Grupo B – 09/2024
# ---------------------------------------------------------------------


def apply_bandeira_enel_sp_gb(raw_text: str) -> Dict[str, Any]:
    text_raw = raw_text or ""
    text = text_raw.lower()

    # captura palavras-chave de bandeira
    bandeira = None
    for k in [
        "bandeira verde",
        "bandeira amarela",
        "bandeira vermelha",
        "bandeira escassez",
        "bandeira",
    ]:
        if k in text:
            bandeira = k.replace("bandeira ", "").strip()
            break

    # consumo estimado (kwh) se mencionar "kwh" (ainda não usado no cálculo)
    consumo = None
    m = re.search(r"(\d+[\.,]?\d*)\s*kwh", text)
    if m:
        consumo = _to_float(m.group(1))

    # --- elegibilidade (ENEL SP, 09/2024, Grupo B) ---
    issues: list[str] = []
    elegivel = True

    # distribuidora
    if not (
        "enel" in text
        and ("sp" in text or "sao paulo" in text or "são paulo" in text)
    ):
        elegivel = False
        issues.append("distribuidora_nao_enel_sp")

    # mês/ano referência
    mesref = None
    mref = re.search(
        r"\b(0?9\s*[/\\.-]?\s*2024|09\s*[/\\.-]?\s*2024|092024)\b",
        text,
    )
    if mref:
        mesref = "092024"
    else:
        elegivel = False
        issues.append("mes_ref_diferente_092024")

    # classificação grupo B
    if not (
        "grupo b" in text
        or " b3 " in text
        or " b - b3" in text
        or "classificação uc" in text
    ):
        elegivel = False
        issues.append("classificacao_uc_nao_grupo_b")

    # leitura atual entre 01/09/2024 e 06/09/2024
    leitura_data = None
    md = re.search(
        r"\b(0?[1-6])\s*[-/\\.]?\s*0?9\s*[-/\\.]?\s*20?24\b",
        text,
    )
    if md:
        try:
            dia = int(md.group(1))
            leitura_data = f"{dia:02d}092024"
        except Exception:
            pass
    if leitura_data is None:
        elegivel = False
        issues.append("leitura_atual_fora_0109-0609")

    # Dias total
    dias_total: Optional[int] = None

    # 1) perto de 'LID' ou "N de dias"
    mdt = re.search(
        r"\b(lid\b[^\d]{0,6}|n[ºo]?\s*de\s*dias\b[^\d]{0,6})(\d{1,3})",
        text,
    )
    if mdt:
        try:
            dias_total = int(mdt.group(2))
        except Exception:
            pass

    # 2) fallback: número 28-31 depois de 'dias'
    if dias_total is None:
        mdt2 = re.search(r"dias\D{0,12}(2[89]|3[01])", text)
        if mdt2:
            try:
                dias_total = int(mdt2.group(1))
            except Exception:
                pass

    # 3) fallback: [data_inicial] [data_final] [n_dias]
    if dias_total is None:
        flat = text_raw.replace("\n", " ")
        mdt3 = re.search(
            r"\b\d{2}/\d{2}/\d{4}\b\s+\d{2}/\d{2}/\d{4}\b\s+(\d{1,2})\b",
            flat,
        )
        if mdt3:
            try:
                dias_total = int(mdt3.group(1))
            except Exception:
                pass

    if dias_total is None:
        elegivel = False
        issues.append("dias_total_nao_identificado")

    # --- extrações principais ---

    def find_after(label: str, window: int = 300) -> Optional[str]:
        idx = text.find(label.lower())
        if idx < 0:
            return None
        snippet = text_raw[idx : idx + window]
        m2 = re.search(_NUM, snippet.replace("\n", " "))
        return m2.group(0) if m2 else None

    # TUSD kWh quantidade
    tusd_quant_kwh: Optional[float] = None

    # 1) bloco "USO SIST. DISTR. (TUSD) ... KWH <num>"
    m_tusd_kwh = re.search(
        rf"USO\s+SIST\.\s*DISTR\.\s*\(TUSD\).*?KWH\s+({_NUM})",
        text_raw,
        re.IGNORECASE | re.DOTALL,
    )
    if m_tusd_kwh:
        tusd_quant_kwh = _to_float(m_tusd_kwh.group(1))

    # 2) fallback
    if tusd_quant_kwh is None:
        tusd_quant_kwh = (
            _to_float(find_after("uso sist. distr. (tusd)") or "")
            or tusd_quant_kwh
        )

    # 3) fallback adicional
    if tusd_quant_kwh is None:
        m3 = re.search(
            r"tusd[^\n]{0,60}?([\d\.,]+)\s*kwh",
            text,
            re.IGNORECASE,
        )
        if m3:
            tusd_quant_kwh = _to_float(m3.group(1))

    # --- Valor R$ do ADIC. BANDEIRA VERMELHA PT. I ---
    bandeira_valor_rs: Optional[float] = None

    # pegamos o bloco a partir de "Quant. (kWh)" e contamos números
    m_q = re.search(
        r"Quant\.\s*\(kWh\)(.*)",
        text_raw,
        re.IGNORECASE | re.DOTALL,
    )
    if m_q:
        snippet_val = m_q.group(1)[:400]
        vals: list[float] = []
        for mnum in re.finditer(_NUM, snippet_val):
            v = _to_float(mnum.group(0))
            if v is not None:
                vals.append(v)
        # 0: 11764.8 (TUSD kWh)
        # 1: 11764.8 (TE kWh)
        # 2: 0.0     (BANDEIRA kWh)
        # 3: 0.47658 (TUSD preço)
        # 4: 0.33597 (TE preço)
        # 5: 0.0     (BANDEIRA preço)
        # 6: 5606.85 (TUSD Valor R$)
        # 7: 3952.59 (TE Valor R$)
        # 8: 236.69  (BANDEIRA Valor R$)  ← queremos esse
        if len(vals) >= 9:
            bandeira_valor_rs = vals[8]

    # PIS/COFINS e ICMS da bandeira – por enquanto nulos (não separados no OCR)
    bandeira_pis_cofins: Optional[float] = None
    bandeira_icms: Optional[float] = None

    # GD compensada
    compensada_quant_kwh = None
    mgd = re.search(
        r"energia\s+ativa\s+compensada\s+tusd[^\n]{0,60}?([\d\.,]+)\s*kwh",
        text,
    )
    if mgd:
        compensada_quant_kwh = _to_float(mgd.group(1))

    # Se não elegível, retorna dados básicos
    if not elegivel:
        return {
            "elegivel": False,
            "motivo_nao_elegivel": ",".join(issues),
            "bandeira_lida": bandeira,
            "dias_total": dias_total,
        }

    # Cálculos
    try:
        dias_mes = int(leitura_data[:2]) if leitura_data else None
    except Exception:
        dias_mes = None

    if (
        not dias_mes
        or not dias_total
        or not tusd_quant_kwh
        or bandeira_valor_rs is None
    ):
        issues.append("campos_insuficientes_para_calculo")
        return {
            "elegivel": True,
            "motivo_nao_elegivel": None,
            "bandeira_lida": bandeira,
            "dias_total": dias_total,
            "dias_mes": dias_mes,
            "tusd_quant_kwh": tusd_quant_kwh,
            "bandeira_valor_rs": bandeira_valor_rs,
            "issues": issues,
        }

    fracao_dias = (dias_mes / dias_total) if dias_total else 0.0

    if compensada_quant_kwh is not None:
        consumo_base = max(tusd_quant_kwh - compensada_quant_kwh, 0.0) / 100.0
    else:
        consumo_base = tusd_quant_kwh / 100.0

    vb_icms = bandeira_icms or 0.0
    vb_pis = bandeira_pis_cofins or 0.0

    def calc(valor_bandeira: float) -> float:
        return fracao_dias * consumo_base * valor_bandeira + vb_icms + vb_pis

    v_4_463 = calc(4.463)
    v_7_877 = calc(7.877)
    dif_7 = abs((bandeira_valor_rs or 0.0) - v_7_877)
    bandeira_incorreta = dif_7 < 0.05
    dif_para_4 = (bandeira_valor_rs or 0.0) - v_4_463

    if not bandeira:
        issues.append("bandeira_nao_identificada")

    return {
        "elegivel": True,
        "motivo_nao_elegivel": None,
        "bandeira_lida": bandeira,
        "dias_mes": dias_mes,
        "dias_total": dias_total,
        "tusd_quant_kwh": tusd_quant_kwh,
        "compensada_quant_kwh": compensada_quant_kwh,
        "bandeira_valor_rs": bandeira_valor_rs,
        "bandeira_pis_cofins": bandeira_pis_cofins,
        "bandeira_icms": bandeira_icms,
        "fracao_dias": fracao_dias,
        "consumo_base": consumo_base,
        "valor_calc_4_463": round(v_4_463, 3),
        "valor_calc_7_877": round(v_7_877, 3),
        "bandeira_incorreta": bandeira_incorreta,
        "diferenca_para_4_463": round(dif_para_4, 3),
        "status": "ok",
        "issues": issues,
    }
