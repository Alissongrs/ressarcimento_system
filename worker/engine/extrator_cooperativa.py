"""Extrator para faturas de COOPERATIVAS rurais de energia.

Diferente das DANF3E (Energisa, CEMIG, ENEL, etc):
  - Layout boleto bancário (Sicredi/Sicoob/etc) + linhas de consumo
  - Sem chave NF3e 44 dígitos
  - Sem campo subgrupo/modalidade ANEEL
  - Consumo posto único (rural típico)
  - Histórico inline 'MES/AAAA NNNN'

Cooperativas detectadas:
  - SULMATOGROSSENSE (Sicredi)
  - COCEL (Coopere Castro)
  - COOPERSULCA
  - COOPERFOZ (RS)
  - COPREL (RS)
  - CEPRAG, CERPALO, CERIM, etc

Detecção: texto contém 'Cooperativa de Energização' ou 'Cooperativa de Eletrificação'
"""
import re
from typing import Optional


# ────────────────────────────────────────────────────────────────────────
# Detector — identifica se é fatura de cooperativa
# ────────────────────────────────────────────────────────────────────────
def eh_fatura_cooperativa(texto: str) -> bool:
    """Detecta se o texto é fatura de cooperativa rural (não DANF3E)."""
    if not texto: return False
    PATTERNS = [
        r"Cooperativa\s+de\s+(?:Energiza[çc][ãa]o|Eletrifica[çc][ãa]o)",
        r"COOPER[A-Z]+(?:\s+RURAL)?",
        r"COCEL\b",
        r"CERPALO|CEPRAG|CERIM|COOPERSULCA|COPREL|COOPERFOZ",
        r"COPERSUL",
        # Marca SEM DANF3E (negativo)
    ]
    has_pos = any(re.search(p, texto, re.I) for p in PATTERNS)
    has_danf3e = bool(re.search(r"DANF3E|NF3e|Nota Fiscal de Energia El[ée]trica Eletr[ôo]nica", texto, re.I))
    # É cooperativa SE tem pattern positivo E não tem DANF3E proeminente
    return has_pos and not has_danf3e


# ────────────────────────────────────────────────────────────────────────
# Extrator principal
# ────────────────────────────────────────────────────────────────────────
def _to_float_br(s):
    if not s: return None
    try: return float(str(s).replace(".", "").replace(",", "."))
    except: return None


def extrair_cooperativa(texto: str) -> dict:
    """Extrai todos os campos possíveis de uma fatura de cooperativa rural.

    Retorna dict com mesma estrutura do FaturaExtractorV2 para integração transparente.
    """
    out = {
        "_mapa_usado": "cooperativa",
        "_deteccao": "cooperativa_detector",
        "_tipo_fatura": "cooperativa_rural",
        "distribuidora": {},
        "cliente": {},
        "ligacao_tecnica": {},
        "nota_fiscal": {},
        "vencimento_valor": {},
        "periodo_leitura": {},
        "itens_fatura": [],
        "geracao_distribuida": {"tem_gd": False},
        "indicadores_qualidade": {},
        "identificadores_instalacao": {},
        "tributos_por_dist": {},
        "historico_13m_consumo": [],
    }

    # ── DISTRIBUIDORA/EMISSORA ────────────────────────────────────────
    dist = out["distribuidora"]
    m = re.search(r"(Cooperativa\s+de\s+(?:Energiza[çc][ãa]o|Eletrifica[çc][ãa]o)[^\n]{5,150}?)(?:\s+\d{4}\.|\s*\n)", texto, re.I)
    if m:
        dist["razao_social"] = m.group(1).strip()
    else:
        m = re.search(r"(COOPER[A-Z]+[^\n]{0,80})", texto)
        if m: dist["razao_social"] = m.group(1).strip()

    # CNPJ emissora (pode estar próximo ao nome)
    m = re.search(r"Cooperativa[^\n]{0,200}?(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2})", texto, re.I | re.S)
    if m: dist["cnpj_emissor"] = m.group(1)

    # Banco do boleto
    m = re.search(r"(SICREDI|SICOOB|BANCO\s+DO\s+BRASIL|BANCO\s+ITAU|BRADESCO|CAIXA)", texto, re.I)
    if m: dist["banco_recebimento"] = m.group(1).upper()

    # Agência/código do cedente
    m = re.search(r"Ag[êe]ncia/C[óo]digo\s+do\s+cedente[\s\n]+(\d+\.\d+\.\d+|\d+/[\d.-]+)", texto, re.I)
    if m: dist["agencia_cedente"] = m.group(1)

    # ── CLIENTE/SACADO ──────────────────────────────────────────────
    cli = out["cliente"]
    # Padrão Sicredi: '02526/01 - TIM S.A -CNPJ 02.421.421/0029-12'
    m = re.search(
        r"(\d{4,6}/\d+)\s*[-–]\s*([A-Z][A-Z0-9 .&\-]+?)\s*[-–]?\s*CNPJ\s+(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2})",
        texto
    )
    if m:
        cli["codigo_cliente"] = m.group(1).strip()
        cli["razao_social"] = m.group(2).strip()
        cli["cnpj_cliente"] = m.group(3)
    else:
        # Fallback: procura CNPJ + razão na seção SACADO
        m_sec = re.search(r"Sacado\s*\n([^\n]+)\n", texto, re.I)
        if m_sec:
            sec = m_sec.group(1).strip()
            m_cnpj = re.search(r"(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2})", sec)
            if m_cnpj: cli["cnpj_cliente"] = m_cnpj.group(1)
            # razão entre código e CNPJ
            m_raz = re.search(r"\d{4,6}/\d+\s*[-–]\s*([^-]+)", sec)
            if m_raz: cli["razao_social"] = m_raz.group(1).strip()

    # Endereço UC (linhas após razão)
    m = re.search(
        r"CNPJ\s+\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}\s*\n([A-Z][^\n]+)\n([A-Z][^\n]+)\n",
        texto
    )
    if m:
        cli["endereco_uc"] = m.group(1).strip()
        cli["cidade_uf_uc"] = m.group(2).strip()
    # CEP
    m = re.search(r"-\s*(\d{5}-\d{3})\b", texto)
    if m: cli["cep_uc"] = m.group(1)

    # Tipo de via (2ª via)
    if re.search(r"\b2[ªa]\s*Via|SEGUNDA\s+VIA", texto, re.I):
        cli["tipo_via"] = "SEGUNDA_VIA"

    # ── VENCIMENTO E VALOR ──────────────────────────────────────────
    vv = out["vencimento_valor"]
    # 'Vencimento ... DD/MM/AAAA Agência/Conta ... valor total pagar ... NNN,NN' OU linha boleto
    m = re.search(r"valor\s+total\s+pagar[\s\S]{0,150}?(\d{2}/\d{2}/\d{4})\s+\d+\.\d+\.\d+\s+([\d.,]+)",
                  texto, re.I)
    if m:
        vv["data_vencimento"] = m.group(1)
        vv["valor_total"] = m.group(2)

    # Vencimento original (se 2ª via)
    m = re.search(r"VENCT\s+(\d{2}/\d{2}/\d{4})", texto, re.I)
    if m: vv["data_vencimento_original"] = m.group(1)

    # Valor do documento (boleto)
    if not vv.get("valor_total"):
        m = re.search(r"(?:Valor\s+do\s+Documento|VALOR\s+DO\s+DOCUMENTO)[\s:]*R?\$?\s*([\d.,]+)", texto, re.I)
        if m: vv["valor_total"] = m.group(1)

    # ── PERÍODO DE LEITURA ──────────────────────────────────────────
    per = out["periodo_leitura"]
    m = re.search(
        r"Data\s+Leitura\.+:\s*(\d{2}/\d{2}/\d{4})\s*[-–]\s*Dias:\s*(\d+)\s+Anterior\.+:\s*(\d{2}/\d{2}/\d{4})",
        texto, re.I
    )
    if m:
        per["leitura_atual"] = m.group(1)
        per["dias_consumo"] = int(m.group(2))
        per["leitura_anterior"] = m.group(3)

    # Leituras do medidor
    m = re.search(r"Leitura\s+Atual:\s*(\d+)\s+Anterior\.+:\s*(\d+)", texto, re.I)
    if m:
        per["leitura_medidor_atual"] = int(m.group(1))
        per["leitura_medidor_anterior"] = int(m.group(2))

    # ── ITENS / CONSUMO ──────────────────────────────────────────────
    # Consumo principal
    m = re.search(r"Consumo\s+kWh\.+:\s*(\d+)\s+Valor\s+Consumo:\s*([\d.,]+)", texto, re.I)
    consumo_kwh = None
    if m:
        consumo_kwh = int(m.group(1))
        out["itens_fatura"].append({
            "descricao": "Consumo de Energia Elétrica",
            "unidade": "KWH",
            "quantidade_numerica": float(consumo_kwh),
            "valor_brl_numerico": _to_float_br(m.group(2)),
            "valor_brl_string": m.group(2),
            "eh_credito_gd": False,
        })

    # Tarifa unitária
    m = re.search(r"Valor\s+kWh:\s*([\d.,]+)", texto, re.I)
    if m and out["itens_fatura"]:
        tarifa = _to_float_br(m.group(1))
        out["itens_fatura"][0]["tarifa_unit_numerica"] = tarifa
        out["itens_fatura"][0]["tarifa_unit_string"] = m.group(1)
        out["itens_fatura"][0]["tarifa_unit_aneel_numerica"] = tarifa

    # Taxas
    m = re.search(r"Valor\s+Taxas\.+:\s*([\d.,]+)", texto, re.I)
    if m:
        out["itens_fatura"].append({
            "descricao": "Taxas",
            "valor_brl_numerico": _to_float_br(m.group(1)),
            "valor_brl_string": m.group(1),
            "eh_credito_gd": False,
        })

    # Rateio manutenção
    m = re.search(r"Rateio\s+Manut\.?:?\s*([\d.,]+)", texto, re.I)
    if m:
        out["itens_fatura"].append({
            "descricao": "Rateio de Manutenção",
            "valor_brl_numerico": _to_float_br(m.group(1)),
            "valor_brl_string": m.group(1),
            "eh_credito_gd": False,
        })

    # ── BANDEIRA TARIFÁRIA ──────────────────────────────────────────
    m = re.search(r"BANDEIRA\s+(VERDE|AMARELA|VERMELHA|AZUL)", texto, re.I)
    if m:
        out["bandeira_tarifaria"] = m.group(1).upper()

    # ── GERAÇÃO DISTRIBUÍDA ─────────────────────────────────────────
    gd = out["geracao_distribuida"]
    m = re.search(r"Saldo\s+Acumulado\s*\(KWH\):\s*(\-?\d+)", texto, re.I)
    if m:
        saldo = int(m.group(1))
        gd["saldo_acumulado_unico_kwh"] = saldo
        if saldo != 0:
            gd["tem_gd"] = True
            gd["classificacao"] = "GD"

    # ── IDENTIFICADORES ─────────────────────────────────────────────
    ident = out["identificadores_instalacao"]
    m = re.search(r"Medidor:\s*(\d+)", texto, re.I)
    if m: ident["medidor"] = m.group(1)
    # Código cliente
    m = re.search(r"^(\d{4,6}/\d+)\s+", texto, re.M)
    if m: ident["codigo_cliente"] = m.group(1)

    # ── ÚLTIMOS CONSUMOS (inline 'MES/AAAA NNNN') ───────────────────
    # PDF original: "ÚLTIMOS CONSUMOS\nJUL/2025 00399\nJUN/2025 00416\n..."
    hist = []
    MES_ORD = {"JAN":1,"FEV":2,"MAR":3,"ABR":4,"MAI":5,"JUN":6,"JUL":7,"AGO":8,"SET":9,"OUT":10,"NOV":11,"DEZ":12}
    MES_NOME = {1:"JAN",2:"FEV",3:"MAR",4:"ABR",5:"MAI",6:"JUN",7:"JUL",8:"AGO",9:"SET",10:"OUT",11:"NOV",12:"DEZ"}

    for m in re.finditer(r"(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/(\d{4})\s+(\d+)", texto, re.I):
        hist.append({
            "mes": m.group(1).upper(),
            "ano": int(m.group(2)),
            "consumo_kwh": int(m.group(3)),
            "fonte": "historico_pdf",
        })

    # Adiciona o CICLO ATUAL da fatura (não está no histórico do PDF — é o consumo recém-faturado)
    if consumo_kwh is not None and per.get("leitura_atual"):
        try:
            from datetime import datetime
            dt = datetime.strptime(per["leitura_atual"], "%d/%m/%Y")
            # Mês do ciclo atual = mês da leitura ATUAL (típico da cooperativa)
            hist.append({
                "mes": MES_NOME[dt.month],
                "ano": dt.year,
                "consumo_kwh": consumo_kwh,
                "fonte": "ciclo_atual_fatura",
            })
        except Exception: pass

    # Dedup (mantém ciclo_atual se houver conflito) + ordena cronologicamente decrescente
    seen = {}
    for h in hist:
        k = (h["mes"], h["ano"])
        # Se já existe, ciclo_atual vence (é o mais recente/correto)
        if k in seen and h["fonte"] == "ciclo_atual_fatura":
            seen[k] = h
        elif k not in seen:
            seen[k] = h
    hist_uniq = list(seen.values())
    hist_uniq.sort(key=lambda h: (h["ano"], MES_ORD.get(h["mes"], 0)), reverse=True)

    # Grava em duas chaves (alias pra cobrir nomenclaturas diferentes)
    out["ultimos_consumos"] = hist_uniq             # nome do PDF cooperativa
    out["historico_13m_consumo"] = hist_uniq        # retrocompat com DANF3E

    # ── BOLETO / CÓDIGO DE BARRAS ──────────────────────────────────
    boleto = {}
    m = re.search(r"(\d{5}\.\d{5}\s\d{5}\.\d{6}\s\d{5}\.\d{6}\s\d\s\d{14})", texto)
    if m: boleto["linha_digitavel"] = m.group(1)
    m = re.search(r"Nosso\s+N[úu]mero[\s\n]+(\d+/\d+-\d|\d{2}/\d{7}-\d)", texto, re.I)
    if m: boleto["nosso_numero"] = m.group(1)
    if boleto: out["boleto"] = boleto

    # ── COBERTURA ─────────────────────────────────────────────────
    campos_totais = 0; campos_preench = 0
    for k, v in out.items():
        if k.startswith("_") or k == "itens_fatura": continue
        if isinstance(v, dict):
            for vv2 in v.values():
                campos_totais += 1
                if vv2 not in (None, "", [], {}, False): campos_preench += 1
    out["_cobertura"] = {
        "campos_totais": campos_totais,
        "campos_preenchidos": campos_preench,
        "pct": round(campos_preench/max(1,campos_totais)*100, 1),
        "n_itens_extraidos": len(out["itens_fatura"]),
    }

    return out


if __name__ == "__main__":
    import sys, pdfplumber
    pdf = sys.argv[1] if len(sys.argv) > 1 else "_fatura_teste2.pdf"
    with pdfplumber.open(pdf) as p:
        texto = "\n".join((pg.extract_text() or "") for pg in p.pages)
    print(f"É fatura cooperativa? {eh_fatura_cooperativa(texto)}")
    if eh_fatura_cooperativa(texto):
        import json
        out = extrair_cooperativa(texto)
        print(json.dumps(out, ensure_ascii=False, indent=2, default=str))
