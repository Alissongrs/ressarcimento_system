"""Validações específicas de DANF3E:
- Chave NF3e 44 dígitos com dígito verificador mod 11
- CNPJ duplo (mascarado no corpo + completo no boleto)
- Demanda contratada / medida / faturada (3 conceitos)
- CNPJ válido (mod 11 dos 14 dígitos)
"""
import re


# ============================================================
# Chave NF3e — 44 dígitos com DV módulo 11
# ============================================================
def calcular_dv_chave_nfe(chave_44_sem_dv: str) -> int:
    """DV modulo 11 da chave de acesso NF-e/NF3e.
    Pesos 2-9 em loop reverso.
    """
    if len(chave_44_sem_dv) != 43:
        raise ValueError(f"esperava 43 dígitos para calcular DV, recebi {len(chave_44_sem_dv)}")
    pesos = [2, 3, 4, 5, 6, 7, 8, 9]
    soma = 0
    for i, d in enumerate(reversed(chave_44_sem_dv)):
        peso = pesos[i % 8]
        soma += int(d) * peso
    resto = soma % 11
    dv = 11 - resto
    if dv >= 10: dv = 0
    return dv


def validar_chave_nfe(chave: str) -> dict:
    """Valida chave de 44 dígitos. Retorna {valida, motivo, partes}."""
    # Remove espaços/separadores
    chave_limpa = re.sub(r"\D", "", chave or "")
    if not chave_limpa:
        return {"valida": False, "motivo": "vazia"}
    if len(chave_limpa) != 44:
        return {"valida": False, "motivo": f"esperava 44 dígitos, recebi {len(chave_limpa)}"}
    dv_calculado = calcular_dv_chave_nfe(chave_limpa[:43])
    dv_recebido = int(chave_limpa[43])
    if dv_calculado != dv_recebido:
        return {"valida": False, "motivo": f"DV inválido (calc={dv_calculado}, recv={dv_recebido})"}
    # Parsing das 8 partes (4-2-14-2-3-9-1-9)
    return {
        "valida": True,
        "chave_limpa": chave_limpa,
        "partes": {
            "uf": chave_limpa[:2],
            "aamm": chave_limpa[2:6],
            "cnpj_emitente": chave_limpa[6:20],
            "modelo": chave_limpa[20:22],
            "serie": chave_limpa[22:25],
            "numero_nf": chave_limpa[25:34],
            "tpemis": chave_limpa[34:35],
            "codigo_numerico": chave_limpa[35:43],
            "dv": chave_limpa[43:44],
        },
    }


# ============================================================
# CNPJ — validação mod 11
# ============================================================
def validar_cnpj(cnpj: str) -> bool:
    """Valida CNPJ via 2 DVs módulo 11."""
    nums = re.sub(r"\D", "", cnpj or "")
    if len(nums) != 14: return False
    if len(set(nums)) == 1: return False
    pesos1 = [5,4,3,2,9,8,7,6,5,4,3,2]
    pesos2 = [6,5,4,3,2,9,8,7,6,5,4,3,2]
    for pesos, idx in [(pesos1, 12), (pesos2, 13)]:
        soma = sum(int(nums[i]) * pesos[i] for i in range(len(pesos)))
        dv = 11 - (soma % 11)
        if dv >= 10: dv = 0
        if dv != int(nums[idx]): return False
    return True


def extrair_cnpj_duplo(texto: str) -> dict:
    """Captura todos CNPJs do texto e classifica por contexto + mod11.

    Categorias:
      cnpj_distribuidora — primeiro CNPJ válido próximo a marcadores de emissor
      cnpj_cliente_corpo — CNPJ mascarado (com X) no corpo da fatura
      cnpj_cliente_completo — CNPJ válido próximo a "Pagador", "Sacado", "Cliente"
    """
    out = {
        "cnpj_corpo_mascarado": None,
        "cnpj_cliente_completo": None,
        "cnpj_boleto_completo": None,   # alias retrocompat
        "cnpj_distribuidora": None,
        "todos_cnpjs_validos": [],
    }
    if not texto: return out

    # 1) Capturar TODOS os CNPJs válidos do texto
    pat_cnpj = re.compile(r"(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2})")
    cnpjs_encontrados = []
    for m in pat_cnpj.finditer(texto):
        cnpj = m.group(1)
        pos = m.start()
        valido = validar_cnpj(cnpj)
        cnpjs_encontrados.append({"cnpj": cnpj, "pos": pos, "valido": valido,
                                    "contexto": texto[max(0, pos-100):pos+50]})

    out["todos_cnpjs_validos"] = list({c["cnpj"] for c in cnpjs_encontrados if c["valido"]})

    # 2) CNPJ mascarado (qualquer X/* no meio)
    pat_masc = re.compile(r"([\dX*]{2}\.[\dX*]{3}\.[\dX*]{3}/[\dX*]{4}-[\dX*]{2})")
    for m in pat_masc.finditer(texto):
        v = m.group(1)
        if any(c in v for c in "X*x"):
            out["cnpj_corpo_mascarado"] = v
            break

    # 3) Classifica os CNPJs válidos
    # Marcadores de distribuidora (emissor)
    MK_DIST = ("DISTRIBUIDORA", "DANF3E", "DANFE", "ENERGIA S.A", "ENERGIA S/A",
                "ENERGIA SA", "BENEFICIÁRIO", "BENEFICIARIO", "EMITENTE")
    # Marcadores de cliente/pagador
    MK_CLI = ("PAGADOR", "SACADO", "CLIENTE", "CONSUMIDOR", "RESPONSAVEL",
               "RESPONSÁVEL", "TITULAR", "DESTINATÁRIO", "DESTINATARIO")

    for c in cnpjs_encontrados:
        if not c["valido"]: continue
        ctx_up = c["contexto"].upper()
        if not out["cnpj_distribuidora"] and any(mk in ctx_up for mk in MK_DIST):
            out["cnpj_distribuidora"] = c["cnpj"]; continue
        if not out["cnpj_cliente_completo"] and any(mk in ctx_up for mk in MK_CLI):
            out["cnpj_cliente_completo"] = c["cnpj"]; continue

    # 4) Fallback: se ainda não achou distribuidora, pega o primeiro CNPJ válido
    if not out["cnpj_distribuidora"]:
        for c in cnpjs_encontrados:
            if c["valido"]:
                out["cnpj_distribuidora"] = c["cnpj"]; break

    # 5) Fallback: cliente completo = qualquer CNPJ diferente da distribuidora
    if not out["cnpj_cliente_completo"]:
        for c in cnpjs_encontrados:
            if c["valido"] and c["cnpj"] != out["cnpj_distribuidora"]:
                out["cnpj_cliente_completo"] = c["cnpj"]; break

    # 6) Se ainda não temos cliente CNPJ, busca CPF do cliente (pessoa física)
    # Nota: DANF3E frequentemente anonimiza o CPF (mod11 falha) — aceita formato 999.999.999-99
    if not out["cnpj_cliente_completo"]:
        for m in re.finditer(r"\b(\d{3}\.\d{3}\.\d{3}-\d{2})\b", texto):
            cpf = m.group(1)
            digits = re.sub(r"\D", "", cpf)
            # Rejeita placeholders óbvios (todos zeros/nove iguais)
            if digits == digits[0] * 11: continue
            out["cpf_cliente"] = cpf
            out["cpf_cliente_mod11_valido"] = _validar_cpf(cpf)
            break

    # Alias retrocompat
    out["cnpj_boleto_completo"] = out["cnpj_cliente_completo"]

    return out


def _validar_cpf(cpf: str) -> bool:
    """Valida CPF via algoritmo módulo 11."""
    digits = re.sub(r"\D", "", cpf)
    if len(digits) != 11 or digits == digits[0] * 11:
        return False
    for i in (9, 10):
        soma = sum(int(digits[j]) * ((i + 1) - j) for j in range(i))
        dv = (soma * 10) % 11
        if dv == 10: dv = 0
        if dv != int(digits[i]): return False
    return True


# ============================================================
# Tributos — PIS/COFINS/ICMS/FECP/FECOEP em layouts variados
# ============================================================
def extrair_tributos(texto: str) -> dict:
    """Extrai tributos em vários layouts.

    Padrões suportados:
    1) Linha isolada (COPEL, CEMIG): 'ICMS 85,25 19% 16,20' (base aliq% valor)
    2) Inline em item (ELEKTRO SP): '... PIS 83,68 0,87% 0,72'
    3) Quadro tributos (ENERGISA): 'PIS  29.698,86  0,1017  30,20'
    4) Variantes: 'ICMS R$ X', 'PIS/PASEP X'
    """
    tributos = {}

    # Padrão 0 (PRIORITÁRIO) — Totalizador EDP em markdown: "PIS 1.794,92 | 1.02 18,31"
    # Formato: NOME BASE | ALIQ VALOR (base ≥ 100, evita confusão com linhas de item)
    pat0 = re.compile(
        r'\|\s*(PIS|COFINS|ICMS)\s+(\d{1,3}(?:\.\d{3})+,\d{2}|\d{2,},\d{2})'  # base alta
        r'\s*\|\s*([\d.,]+)\s+([\d.,]+)\s*\|',
        re.IGNORECASE
    )
    for m in pat0.finditer(texto):
        key = m.group(1).upper().lower()
        if key not in tributos:
            tributos[key] = {
                "base_string": m.group(2),
                "aliquota_pct": m.group(3),
                "valor_string": m.group(4),
            }

    # Padrão 1+2 — TRIBUTO base alíquota% valor (3 valores numéricos)
    pat1 = re.compile(
        r'(PIS(?:/PASEP)?|COFINS|ICMS(?:\s*ST)?|FECP|FECOEP|FECOM)'
        r'\s+([\d.,]+)'                        # base
        r'\s+(\d{1,2}(?:[,.]?\d+)?)\s*%?'      # alíquota
        r'\s+(-?[\d.,]+)',                     # valor
        re.IGNORECASE
    )
    for m in pat1.finditer(texto):
        nome = m.group(1).upper().replace("/PASEP", "").replace(" ST", "_ST")
        key = nome.lower()
        # Só adiciona se ainda não existe (primeira ocorrência ganha)
        if key not in tributos:
            tributos[key] = {
                "base_string": m.group(2),
                "aliquota_pct": m.group(3),
                "valor_string": m.group(4),
            }

    # Padrão 3 — TRIBUTO valor (sem base/alíquota explícitas)
    pat2 = re.compile(
        r'(PIS(?:/PASEP)?|COFINS|ICMS|FECP|FECOEP)\s*[:=]?\s*R?\$?\s*(-?[\d.,]+)\s*$',
        re.IGNORECASE | re.MULTILINE
    )
    for m in pat2.finditer(texto):
        nome = m.group(1).upper().replace("/PASEP", "")
        key = nome.lower()
        if key not in tributos:
            tributos[key] = {"valor_string": m.group(2)}

    # Padrão CPFL: 'PIS/COFINS 0,83% 3,81%' (só aliquotas; valores totais ficam nas linhas dos itens)
    m_cpfl = re.search(r"PIS/COFINS\s+([\d.,]+)\s*%\s+([\d.,]+)\s*%", texto, re.I)
    if m_cpfl:
        if "pis" not in tributos:
            tributos["pis"] = {"aliquota_pct": m_cpfl.group(1)}
        if "cofins" not in tributos:
            tributos["cofins"] = {"aliquota_pct": m_cpfl.group(2)}
        # Procura ICMS no mesmo trecho ou pattern padrão
        m_icms = re.search(r"\bICMS\s+([\d.,]+)\s*%", texto, re.I)
        if m_icms and "icms" not in tributos:
            tributos["icms"] = {"aliquota_pct": m_icms.group(1)}

    # Padrão 4 — ENERGISA: 'PIS 0,1017 30,20' (apenas aliq% + valor, sem base separada)
    # 'ICMS 17 1.153,39' (aliq%-inteira + valor)
    pat4 = re.compile(
        r'\b(PIS(?:/PASEP)?|COFINS|ICMS)\b'
        r'[ \t]+(\d{1,2}(?:[,.]\d{1,4})?)'                # aliq (0,1017 ou 17)
        r'[ \t]+(-?\d{1,3}(?:\.\d{3})*(?:,\d{1,2}))\b',   # valor BR (29.698,86 ou 30,20)
        re.IGNORECASE
    )
    for m in pat4.finditer(texto):
        nome = m.group(1).upper().replace("/PASEP", "")
        key = nome.lower()
        if key not in tributos:
            tributos[key] = {
                "aliquota_pct": m.group(2),
                "valor_string": m.group(3),
            }

    # Padrão 5 — Layout TRANSPOSTO ENERGISA (markdown pymupdf4llm):
    # '...0,1017<br>0,4683<br>17,00<br>ICMS<br>COFINS<br>PIS<br>29.698,86<br>35.781,77<br>29.698,86||30,20<br>139,07<br>6.082,92|'
    # Sequência: 3 aliquotas | 3 nomes | 3 bases | 3 valores (com separadores variados)
    SEP = r'[\s<br>|]+'  # qualquer combinação de whitespace, <br>, |
    pat5 = re.compile(
        r'([\d.,]+)' + SEP + r'([\d.,]+)' + SEP + r'([\d.,]+)' + SEP +
        r'(ICMS|COFINS|PIS)' + SEP + r'(ICMS|COFINS|PIS)' + SEP + r'(ICMS|COFINS|PIS)' + SEP +
        r'([\d.,]+)' + SEP + r'([\d.,]+)' + SEP + r'([\d.,]+)' + SEP +
        r'([\d.,]+)' + SEP + r'([\d.,]+)' + SEP + r'([\d.,]+)',
        re.IGNORECASE | re.DOTALL
    )
    m5 = pat5.search(texto)
    if m5:
        aliqs = [m5.group(i) for i in (1, 2, 3)]
        bases = [m5.group(i) for i in (7, 8, 9)]
        valores = [m5.group(i) for i in (10, 11, 12)]
        def _to_f(s):
            try: return float(str(s).replace('.', '').replace(',', '.'))
            except: return 0.0
        aliqs_f = [_to_f(a) for a in aliqs]
        bases_f = [_to_f(b) for b in bases]
        valores_f = [_to_f(v) for v in valores]
        # Aliquotas em ordem crescente → PIS, COFINS, ICMS
        idx_ord_aliq = sorted(range(3), key=lambda i: aliqs_f[i])
        # Valores em ordem crescente (mesmo padrão: PIS < COFINS < ICMS)
        idx_ord_val = sorted(range(3), key=lambda i: valores_f[i])
        mapping_pos = {"pis": (idx_ord_aliq[0], idx_ord_val[0]),
                       "cofins": (idx_ord_aliq[1], idx_ord_val[1]),
                       "icms": (idx_ord_aliq[2], idx_ord_val[2])}
        for trib_name, (pos_aliq, pos_val) in mapping_pos.items():
            aliq_f = aliqs_f[pos_aliq]
            val_f = valores_f[pos_val]
            # Base correta = valor / (aliq/100); escolhe a base mais próxima na lista
            base_str = None
            if aliq_f > 0:
                base_calc = val_f / (aliq_f / 100.0)
                best_idx = min(range(3), key=lambda i: abs(bases_f[i] - base_calc))
                base_str = bases[best_idx]
            # Sobrescreve se já houver (pat4 só capturou aliq+valor, pat5 completa com base)
            existing = tributos.get(trib_name, {})
            tributos[trib_name] = {
                "aliquota_pct": existing.get("aliquota_pct") or aliqs[pos_aliq],
                "base_string": base_str,
                "valor_string": existing.get("valor_string") or valores[pos_val],
            }

    return tributos


# ============================================================
# Demandas — contratada / medida / faturada
# ============================================================
def extrair_demandas(texto: str) -> dict:
    """Captura demandas em vários layouts.

    Padrões reais identificados em produção:
      'Demanda fora ponta - kW 138'                  (Energisa)
      'Demanda Contratada Única (kW): 160,00'        (Equatorial)
      'Demanda Contratada Ponta (kW): 100'           (Equatorial)
      'DEMANDA KW 947,520'                            (Enel SP)
      'Demanda - KW 900,000'                          (Enel SP)
      'Demanda Distrib. Isenta ICMS (kW) 110,86'     (Equatorial AL)
      'Demanda Distribuição F. Ponta ... 49,14 kW'   (Equatorial AL tabular)

    Estratégia: regex amplo que aceita variações de rótulo + unidade kW + valor.
    """
    out = {
        "contratada_ponta_kw": None, "contratada_fponta_kw": None,
        "contratada_unica_kw": None,
        "medida_ponta_kw": None, "medida_fponta_kw": None,
        "faturada_ponta_kw": None, "faturada_fponta_kw": None,
        "ultrapassagem_kw": None, "demanda_geracao_kw": None,
        "reativa_excedente_ponta_kvarh": None, "reativa_excedente_fponta_kvarh": None,
    }

    # Helper — atribui se ainda vazio
    def _set(k, v):
        if out.get(k) is None and v:
            out[k] = v.strip()

    # Variações de "Demanda contratada"
    for pat in [
        # 'Demanda Contratada Ponta (kW): 100' / 'Demanda Contratada Ponta: 100 kW'
        r"Demanda\s+Contratada\s+(?:Ativa\s+)?Ponta\s*(?:\(\s*kW\s*\))?\s*:?\s*([\d.,]+)\s*(?:kW)?",
        # 'Dem(\.|anda)? cont(ratada)? P( |\.|onta)?'
        r"Dem(?:anda)?\.?\s*Cont(?:ratada)?\.?\s*(?:Ativa\s+)?P(?:onta)?\s*:?\s*([\d.,]+)\s*kW",
    ]:
        m = re.search(pat, texto, re.I)
        if m: _set("contratada_ponta_kw", m.group(1))

    for pat in [
        r"Demanda\s+Contratada\s+(?:Ativa\s+)?(?:Fora\s*Ponta|F\.?\s*Ponta|HFP)\s*(?:\(\s*kW\s*\))?\s*:?\s*([\d.,]+)\s*(?:kW)?",
        r"Dem(?:anda)?\.?\s*Cont(?:ratada)?\.?\s*(?:Ativa\s+)?(?:F\.?P|FP|F\.?\s*Ponta)\s*:?\s*([\d.,]+)\s*kW",
    ]:
        m = re.search(pat, texto, re.I)
        if m: _set("contratada_fponta_kw", m.group(1))

    # Única (Equatorial)
    m = re.search(r"Demanda\s+Contratada\s+[ÚU]nica\s*(?:\(\s*kW\s*\))?\s*:?\s*([\d.,]+)\s*(?:kW)?", texto, re.I)
    if m: _set("contratada_unica_kw", m.group(1))

    # Padrão 'Demanda fora ponta - kW 138' (Energisa) — sufixo
    m = re.search(r"Demanda\s+(?:fora\s*ponta|f\.?\s*ponta|FP|HFP)\s*[-—]?\s*kW\s+(\d+(?:[.,]\d+)?)", texto, re.I)
    if m: _set("contratada_fponta_kw", m.group(1))
    m = re.search(r"Demanda\s+(?:ponta|P|HP)\s*[-—]?\s*kW\s+(\d+(?:[.,]\d+)?)", texto, re.I)
    if m: _set("contratada_ponta_kw", m.group(1))

    # Medida
    for pat in [
        r"Demanda\s+(?:Ativa\s+)?Medida\s+(?:Ponta|HP|P)\s*:?\s*([\d.,]+)\s*kW",
        r"Demanda\s+Medida\s+\(P\)\s*[:=]?\s*([\d.,]+)\s*kW",
        # ENERGISA: 'Demanda de Potência Medida - Ponta KW 889,00'
        r"Demanda\s+de\s+Pot[êe]ncia\s+Medida\s*[-—]?\s*Ponta\s+KW\s+([\d.,]+)",
    ]:
        m = re.search(pat, texto, re.I)
        if m: _set("medida_ponta_kw", m.group(1))

    for pat in [
        r"Demanda\s+(?:Ativa\s+)?Medida\s+(?:Fora\s*Ponta|HFP|FP)\s*:?\s*([\d.,]+)\s*kW",
        r"Demanda\s+Medida\s+\(FP\)\s*[:=]?\s*([\d.,]+)\s*kW",
        # ENERGISA: 'Demanda de Potência Medida - Fora Ponta KW 889,00'
        r"Demanda\s+de\s+Pot[êe]ncia\s+Medida\s*[-—]?\s*(?:Fora\s*Ponta|F\.?\s*Ponta)\s+KW\s+([\d.,]+)",
    ]:
        m = re.search(pat, texto, re.I)
        if m: _set("medida_fponta_kw", m.group(1))

    # Faturada
    m = re.search(r"Demanda\s+Faturada\s+(?:Ponta|HP)\s*:?\s*([\d.,]+)\s*kW", texto, re.I)
    if m: _set("faturada_ponta_kw", m.group(1))
    m = re.search(r"Demanda\s+Faturada\s+(?:Fora\s*Ponta|HFP|F\.?\s*Ponta)\s*:?\s*([\d.,]+)\s*kW", texto, re.I)
    if m: _set("faturada_fponta_kw", m.group(1))

    # Ultrapassagem
    for pat in [
        r"(?:Ultrapassagem|Demanda\s+de\s+Ultrapassagem|ULTRAPASSAGEM\s+DEMANDA)\s*(?:KW)?\s*[:=]?\s*([\d.,]+)\s*kW",
        r"ULTRAPASSAGEM\s+(?:DEMANDA\s+)?KW\s+([\d.,]+)",
    ]:
        m = re.search(pat, texto, re.I)
        if m: _set("ultrapassagem_kw", m.group(1))

    # Demanda geração
    m = re.search(r"Demanda\s+Gera[çc][ãa]o\s*[:=]?\s*([\d.,]+)\s*kW", texto, re.I)
    if m: _set("demanda_geracao_kw", m.group(1))

    # EDP: "Demanda Contratual-KW 150" (única, sem posto)
    m = re.search(r"Demanda\s+Contratual\s*[-—]?\s*KW\s+(\d+(?:[.,]\d+)?)", texto, re.I)
    if m: _set("contratada_unica_kw", m.group(1))

    # EDP: "TUS - Demanda kW 33,46 7,802 261,05" (medida + tarifa + valor — coluna 1 = qty medida)
    m = re.search(r"TUS\s*-\s*Demanda\s+kW\s+([\d.,]+)", texto, re.I)
    if m: _set("medida_fponta_kw", m.group(1))  # EDP B/A Verde tipicamente F.Ponta

    # CEMIG A: "Grandezas Contratadas\nDemanda Fora Ponta 70" / "Demanda Ponta 50"
    m = re.search(r"Grandezas\s+Contratadas[\s\S]{0,40}?Demanda\s+Fora\s*Ponta\s+(\d+(?:[.,]\d+)?)", texto, re.I)
    if m: _set("contratada_fponta_kw", m.group(1))
    m = re.search(r"Grandezas\s+Contratadas[\s\S]{0,80}?Demanda\s+Ponta\s+(\d+(?:[.,]\d+)?)\b", texto, re.I)
    if m: _set("contratada_ponta_kw", m.group(1))

    # CEMIG A: "Componente Fio HFP kW 42" (faturada FP) / "Componente Fio HP kW 5" (faturada P)
    m = re.search(r"Componente\s+Fio\s+HFP\s+kW\s+(\d+(?:[.,]\d+)?)", texto, re.I)
    if m: _set("faturada_fponta_kw", m.group(1))
    m = re.search(r"Componente\s+Fio\s+HP\s+kW\s+(\d+(?:[.,]\d+)?)", texto, re.I)
    if m: _set("faturada_ponta_kw", m.group(1))

    # Padrão Enel SP: 'DEMANDA KW 947,520' ou 'Demanda - KW 900,000' (sem posto explícito)
    if not out["contratada_unica_kw"] and not out["contratada_ponta_kw"]:
        m = re.search(r"(?:^|\s)Demanda\s*[-—]?\s*KW\s+(\d+(?:[.,]\d+)?)", texto, re.I | re.M)
        if m: _set("contratada_unica_kw", m.group(1))

    # Padrão tabular Equatorial AL: 'Demanda Distribuição F. Ponta ... 49,14 kW'
    m = re.search(r"Demanda\s+Distrib(?:ui[çc][ãa]o)?[\.\s]+F\.?\s*Ponta[^\n]{0,80}?([\d.,]+)\s*kW", texto, re.I)
    if m: _set("medida_fponta_kw", m.group(1))
    m = re.search(r"Demanda\s+Distrib(?:ui[çc][ãa]o)?[\.\s]+Ponta[^\n]{0,80}?([\d.,]+)\s*kW", texto, re.I)
    if m: _set("medida_ponta_kw", m.group(1))

    # === FALLBACK amplo: qualquer 'Demanda ... kW <num>' ou 'Demanda <num> kW' ===
    # Só aplica se NENHUM campo de demanda foi capturado ainda
    tem_qualquer = any(v for k, v in out.items() if k.endswith("_kw") and v)
    if not tem_qualquer:
        # Padrão A: 'Demanda ... kW <num>' (aceita %, dígitos, etc no meio)
        for m in re.finditer(
            r"Demanda[A-Za-zÀ-ÿ\s/.\-\(\)\d%,]{0,80}?kW\s*[:=]?\s*(\d+(?:[.,]\d+)?)",
            texto, re.I
        ):
            ctx_inicio = max(0, m.start() - 80)
            ctx = texto[ctx_inicio:m.end()].upper()
            val = m.group(1).strip()
            if val == "0" or val == "0,00": continue
            # Classifica por posto no contexto
            if "FORA PONTA" in ctx or "F.PONT" in ctx or "FPONTA" in ctx or " HFP" in ctx:
                _set("contratada_fponta_kw", val)
            elif " PONTA" in ctx or " HP" in ctx:
                _set("contratada_ponta_kw", val)
            elif "ÚNICA" in ctx or "UNICA" in ctx or "DESCONTO" in ctx:
                _set("contratada_unica_kw", val)
            elif "INJET" in ctx:
                _set("demanda_geracao_kw", val)
            else:
                _set("contratada_unica_kw", val)  # fallback genérico

        # Padrão B: 'Demanda <num> kW' (ordem invertida)
        for m in re.finditer(
            r"Demanda[A-Za-zÀ-ÿ\s/.\-\(\)]{0,30}?(\d+(?:[.,]\d+)?)\s*kW",
            texto, re.I
        ):
            ctx_inicio = max(0, m.start() - 80)
            ctx = texto[ctx_inicio:m.end()].upper()
            val = m.group(1).strip()
            if val == "0" or val == "0,00": continue
            if "FORA PONTA" in ctx or "F.PONT" in ctx or "FPONTA" in ctx:
                _set("contratada_fponta_kw", val)
            elif " PONTA" in ctx or " HP" in ctx:
                _set("contratada_ponta_kw", val)
            elif not out["contratada_unica_kw"]:
                _set("contratada_unica_kw", val)

    # Reativa excedente
    m = re.search(r"(?:Demanda\s+)?Reativ[ao]\s+(?:Exced(?:ente)?|DMCR)\s+(?:Ponta|P|NP)\s*[^\d]*([\d.,]+)\s*kV[Aa]?r?", texto, re.I)
    if m: _set("reativa_excedente_ponta_kvarh", m.group(1))
    m = re.search(r"(?:Demanda\s+)?Reativ[ao]\s+(?:Exced(?:ente)?|DMCR)\s+(?:F\.?\s*Ponta|FP|HFP)\s*[^\d]*([\d.,]+)\s*kV[Aa]?r?", texto, re.I)
    if m: _set("reativa_excedente_fponta_kvarh", m.group(1))

    return out


def extrair_demandas_dos_itens(itens: list) -> dict:
    """Deriva demanda FATURADA a partir dos itens (tipo DEMANDA).
    Útil quando regex de rótulo não casa mas a tabela de itens já está extraída.
    """
    out = {"faturada_ponta_kw": None, "faturada_fponta_kw": None,
           "ultrapassagem_kw": None}
    if not itens: return out
    for it in itens:
        tipo = (it.get("tipo") or "").upper()
        if tipo != "DEMANDA": continue
        desc_up = (it.get("descricao") or "").upper()
        qty = it.get("quantidade_numerica") or it.get("quantidade_string")
        if qty is None: continue
        if "ULTRAPASS" in desc_up:
            out["ultrapassagem_kw"] = str(qty)
        elif "FORA" in desc_up or "F.PONT" in desc_up or "FPONTA" in desc_up or "HFP" in desc_up:
            if out["faturada_fponta_kw"] is None:
                out["faturada_fponta_kw"] = str(qty)
        elif "PONTA" in desc_up or " HP" in desc_up:
            if out["faturada_ponta_kw"] is None:
                out["faturada_ponta_kw"] = str(qty)
    return out


def merge_demandas(de_texto: dict, de_itens: dict) -> dict:
    """Mescla demandas — texto tem prioridade, itens preenchem lacunas."""
    out = dict(de_texto)
    for k, v in (de_itens or {}).items():
        if not out.get(k) and v:
            out[k] = v
    return out


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding='utf-8') if sys.platform == 'win32' else None

    # Smoke tests
    print("=== TEST chave NF3e ===")
    # Chave conhecida da fatura 52391
    chave = "5126 0403 4673 2100 0199 6600 2027 6118 0710 9260 8011"
    print(validar_chave_nfe(chave))

    print("\n=== TEST CNPJ ===")
    print("03.467.321/0001-99 (Energisa MT):", validar_cnpj("03.467.321/0001-99"))
    print("06.981.180/0001-16 (CEMIG):", validar_cnpj("06.981.180/0001-16"))
    print("99.999.999/0001-99 (fake):", validar_cnpj("99.999.999/0001-99"))

    print("\n=== TEST CNPJ duplo ===")
    sample = """DANF3E - ENERGISA MATO GROSSO - DISTRIBUIDORA DE ENERGIA S.A.
    CNPJ 03.467.321/0001-99 Insc. Est. 13.020.425-0
    Cliente: GGF AGRO LTDA
    CNPJ/CPF: 3X.XXX.XXX/XXX1-28
    ...
    Pagador: GGF AGRO LTDA
    CPF/CNPJ Pagador: 38.850.314/0011-28"""
    print(extrair_cnpj_duplo(sample))

    print("\n=== TEST demandas ===")
    sample_dem = """Demanda Contratada Ponta: 100 kW
    Demanda Medida HP: 95 kW
    Demanda Faturada Fora Ponta: 200 kW
    Demanda de Ultrapassagem: 5 kW"""
    print(extrair_demandas(sample_dem))
