"""Extrator complementar — campos secundários e correções da fatura Energisa MT.

Resolve pontos identificados após análise da fatura 144_6662_61B.pdf:
  2. Cliente: razão social UC, endereço UC, CEP UC
  5. Mês de referência (Abril/2026 → 04/2026) + data vencimento
  8. Itens: tarifa unitária ANEEL (col última, sem tributos)
  9. COFINS estimado/extraído
 10. **mUC vs oUC** (semântica crítica):
       mUC = mesma UC (compensação próprio saldo histórico)
       oUC = outra UC (recebe injetada de geradora/outra UC)
 11. Histórico 13 meses: consumo (não dias)
 12. DICRI, tensão contratada, limite adequado
 13. Código instalação correto (nova UC ANEEL)
"""
import os
import re
from typing import Optional


# ────────────────────────────────────────────────────────────────────────
# 2. Cliente (razão social UC + endereço + CEP)
# ────────────────────────────────────────────────────────────────────────
# Hardcoded distribuidoras quando DANF3E não imprime CNPJ no texto plumber
# (ex: Enel SP usa nota fiscal modelo diferente; CNPJ não vem visível).
_DIST_HARDCODED = {
    "enel_sp": {
        "razao_social": "ENEL DISTRIBUIÇÃO SÃO PAULO S.A.",
        "cnpj_emissor": "61.695.227/0001-93",
        "ie_emissor": "115.473.038.119",
        "uf_emissor": "SP",
    },
    "enel_rio": {
        "razao_social": "Ampla Energia e Serviços S.A.",
        "cnpj_emissor": "33.050.071/0001-58",
        "ie_emissor": "80.046.561",
        "uf_emissor": "RJ",
    },
    "enel_ce": {
        "razao_social": "Enel Distribuição Ceará S.A.",
        "cnpj_emissor": "07.047.251/0001-70",
        "ie_emissor": "06.022.373-2",
        "uf_emissor": "CE",
    },
    "energisa_mt": {
        "razao_social": "Energisa Mato Grosso - Distribuidora de Energia S.A.",
        "cnpj_emissor": "03.467.321/0001-99",
        "ie_emissor": "130.204.250",
        "uf_emissor": "MT",
    },
    "cemig": {
        "razao_social": "CEMIG Distribuição S.A.",
        "cnpj_emissor": "06.981.180/0001-16",
        "ie_emissor": "062.322324.0087",
        "uf_emissor": "MG",
    },
    "light": {
        "razao_social": "Light Serviços de Eletricidade S.A.",
        "cnpj_emissor": "60.444.437/0001-46",
        "ie_emissor": "85.116.91-5",
        "uf_emissor": "RJ",
    },
    "cpfl_piratininga": {
        "razao_social": "Companhia Piratininga de Força e Luz",
        "cnpj_emissor": "04.172.213/0001-51",
        "ie_emissor": "244.946.329.113",
        "uf_emissor": "SP",
    },
    "cpfl_paulista": {
        "razao_social": "Companhia Paulista de Força e Luz",
        "cnpj_emissor": "33.050.196/0001-88",
        "ie_emissor": "245.155.798.119",
        "uf_emissor": "SP",
    },
    "cpfl_santacruz": {
        "razao_social": "Companhia Luz e Força Santa Cruz",
        "cnpj_emissor": "33.884.529/0001-08",
        "ie_emissor": "266.077.094.119",
        "uf_emissor": "SP",
    },
    "elektro_sp": {
        "razao_social": "Elektro Redes S.A.",
        "cnpj_emissor": "02.328.280/0001-97",
        "ie_emissor": "562.052.929.114",
        "uf_emissor": "SP",
    },
    "elektro_ms": {  # mapa interno, mas dados de Elektro Redes SP (CNPJ raiz 02.328.280)
        "razao_social": "Elektro Redes S.A.",
        "cnpj_emissor": "02.328.280/0001-97",
        "ie_emissor": "244868522118",
        "uf_emissor": "SP",
    },
    "edp": {
        "razao_social": "EDP São Paulo Distribuição de Energia S.A.",
        "cnpj_emissor": "02.302.100/0001-06",
        "ie_emissor": "542.171.940.117",
        "uf_emissor": "SP",
    },
    "edp_es": {
        "razao_social": "EDP Espírito Santo Distribuição de Energia S.A.",
        "cnpj_emissor": "28.152.650/0001-71",
        "ie_emissor": "081.234.789",
        "uf_emissor": "ES",
    },
    "copel": {
        "razao_social": "Copel Distribuição S.A.",
        "cnpj_emissor": "04.368.898/0001-06",
        "ie_emissor": "10.156.193-94",
        "uf_emissor": "PR",
    },
    "equatorial_goias": {
        "razao_social": "Equatorial Goiás Distribuidora de Energia S.A.",
        "cnpj_emissor": "01.543.032/0001-04",
        "ie_emissor": "10.187.838-2",
        "uf_emissor": "GO",
    },
    "equatorial_norte": {
        "razao_social": "Equatorial Pará Distribuidora de Energia S.A.",
        "cnpj_emissor": "04.895.728/0001-80",
        "ie_emissor": "15.097.075-3",
        "uf_emissor": "PA",
    },
    "neoenergia_ba": {
        "razao_social": "Neoenergia Coelba",
        "cnpj_emissor": "15.139.629/0001-94",
        "ie_emissor": "058.617.230",
        "uf_emissor": "BA",
    },
    "neoenergia_pe": {
        "razao_social": "Neoenergia Celpe",
        "cnpj_emissor": "10.835.932/0001-08",
        "ie_emissor": "182000038",
        "uf_emissor": "PE",
    },
    "celesc": {
        "razao_social": "Celesc Distribuição S.A.",
        "cnpj_emissor": "08.336.783/0001-90",
        "ie_emissor": "255.622.910",
        "uf_emissor": "SC",
    },
    "copel": {
        "razao_social": "Copel Distribuição S.A.",
        "cnpj_emissor": "04.368.898/0001-06",
        "ie_emissor": "9023307399",
        "uf_emissor": "PR",
    },
    "energisa_ms": {
        "razao_social": "Energisa Mato Grosso do Sul S.A.",
        "cnpj_emissor": "15.413.826/0001-50",
        "ie_emissor": "28.106.668-8",
        "uf_emissor": "MS",
    },
    "neoenergia_cosern": {  # alias usado quando CNPJ é BA (Coelba) — Cosern era nome antigo
        "razao_social": "Neoenergia Coelba",
        "cnpj_emissor": "15.139.629/0001-94",
        "ie_emissor": "058.617.230",
        "uf_emissor": "BA",
    },
    "equatorial_norte": {
        "razao_social": "Equatorial Pará Distribuidora de Energia S.A.",
        "cnpj_emissor": "04.895.728/0001-80",
        "ie_emissor": "15.097.075-3",
        "uf_emissor": "PA",
    },
}


def extrair_cliente_uc(texto: str) -> dict:
    """Padrão Energisa: razão social vem após 'Lim. Max.: XXXX' e antes das datas de leitura."""
    out = {"razao_social_uc": None, "endereco_uc": None, "cep_uc": None, "cnpj_cliente": None,
           "ie_cliente": None}

    # CNPJ/CPF: 1ª tentativa — formato normal
    m_doc = re.search(r"CPF/CNPJ\s*:?\s*(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2})", texto, re.I)
    if not m_doc:
        # Layout Enel char-a-char: 'C P F / C N P J :   3 3 .0 4 1 . 2 6 0 /0 0 9 6 -2 5'
        # Estratégia: localiza âncora 'CPF/CNPJ' (qualquer espaço entre letras), depois pega
        # próximos ~80 chars e remove whitespace antes do match
        m_anchor = re.search(r"C\s*P\s*F\s*/\s*C\s*N\s*P\s*J\s*:?", texto)
        if m_anchor:
            trecho = texto[m_anchor.end():m_anchor.end() + 80]
            sem_ws = re.sub(r"\s+", "", trecho)
            m_doc = re.match(r"(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2})", sem_ws)
            if not m_doc:
                m_doc = re.match(r"(\d{3}\.\d{3}\.\d{3}-\d{2})", sem_ws)  # CPF
    if m_doc:
        doc = m_doc.group(1)
        if "/" in doc:
            out["cnpj_cliente"] = doc

    # IE cliente: vem após 'INSC EST:' no Enel/Ampla (mesmo bloco do CPF/CNPJ)
    # Layout plumber espaçado: 'IN S C EST:  83216166', 'INS C EST', 'I N S C EST'
    m_ie = re.search(r"\bI\s*N\s*S\s*C?\s*E\s*S?\s*T\.?\s*:?\s*(\d{6,15}|ISENTO)", texto, re.I)
    if not m_ie:
        # Fallback: ancora qualquer 'EST' precedido por espaço/I/N + busca número limpo após
        for m_anchor in re.finditer(r"\bEST\.?\s*:?\s*([\dA-Z\s]{6,30})", texto):
            trecho = m_anchor.group(1)
            sem_ws = re.sub(r"\s+", "", trecho)
            mm = re.match(r"^(\d{6,15})", sem_ws)
            if mm:
                m_ie = mm
                break
    if m_ie:
        ie_val = m_ie.group(1)
        # Descarta IE igual à do emitente (80046561 = Enel/Ampla)
        if ie_val not in ("80046561", "80.046.561"):
            out["ie_cliente"] = ie_val

    # Razão Social: linha entre 'Lim. Max.: ...' e datas DD/MM/AAAA DD/MM/AAAA
    m = re.search(
        # Linha do Lim. Max. (pode ter número OU lixo como 'a 1' em layouts com OCR corrompido)
        r"Lim\.\s*Max\.?\s*:?\s*[^\n]*\n([A-ZÀ-Ÿ][^\n]{2,80})\n\d{2}/\d{2}/\d{4}\s+\d{2}/\d{2}/\d{4}",
        texto
    )
    if m:
        razao = m.group(1).strip()
        # Filtra prefixos comuns que não são razão social
        if not any(p in razao.upper() for p in ("DOMIC", "BENEFI", "CLASSIFIC", "TENSÃO")):
            out["razao_social_uc"] = razao

    # Pattern Enel SP / layouts modernos: razão é a linha ANTES de endereço (AV/RUA/etc)
    # Ex: 'VIA VAREJO S/A\nAV TABOAO DO 3990 - TABOAO'
    if not out.get("razao_social_uc"):
        m = re.search(
            r"(?:^|\n)([A-ZÀ-Ÿ][A-ZÀ-Ÿ0-9 /&.\-]{3,80})\n\s*(?:AV|RUA|ALAMEDA|PRAÇA|PR\.|R\.|TRAVESSA|ROD\.?|RODOVIA|ESTRADA|EST\.?|LARGO|ALAMEDA|AL\.)\s+",
            texto, re.M
        )
        if m:
            razao = m.group(1).strip()
            # Filtra cabeçalhos, footers, distribuidoras
            UPPER = razao.upper()
            BLACKLIST = ("ENEL", "AMPLA", "CEMIG", "ENERGISA", "LIGHT", "CPFL", "EDP", "COPEL", "EQUATORIAL",
                         "NEOENERGIA", "ELEKTRO", "AES", "DISTRIBUI", "CONTA DE ENERGIA", "NOTA FISCAL",
                         "DEMONSTRATIVO", "FATURA", "DOCUMENTO", "PAGADOR", "CPF/CNPJ", "REFERÊNCIA")
            if not any(b in UPPER for b in BLACKLIST):
                out["razao_social_uc"] = razao

    # Pattern Neoenergia: razão é linha após 'NOME DO CLIENTE:' (BA/PE)
    # Plumber Coelba tem 2 ocorrências — a 2ª é mais limpa (após '\nENDEREÇO:')
    if not out.get("razao_social_uc"):
        matches = list(re.finditer(
            r"NOME\s+DO\s+CLIENTE\s*:\s*\n([A-ZÀ-Ÿ][A-ZÀ-Ÿ0-9 /&.\-]{2,50}?)\s*\n(?:ENDERE[ÇC]O|C[ÓO]DIGO|RUA|AV|R\s)",
            texto, re.I
        ))
        # Pega o ÚLTIMO match (geralmente o bloco limpo no fim)
        if matches:
            m = matches[-1]
            razao = m.group(1).strip()
            UPPER = razao.upper()
            if not any(b in UPPER for b in ("ENEL", "AMPLA", "CEMIG", "ENERGISA", "LIGHT", "CPFL", "EDP",
                                              "COPEL", "EQUATORIAL", "NEOENERGIA", "ELEKTRO", "CELESC",
                                              "DISTRIBUI", "COMPANHIA", "PIRATININGA", "CÓDIGO", "INSTALA")):
                out["razao_social_uc"] = razao

    # Pattern Enel SP: razão é linha ANTES de 'CNPJ: 33.***.***/****-XX INSC. EST'
    # Ex: 'VIA VAREJO S/A\nAV TABOAO ...\nCEP: 09657-000...\nCNPJ: 33.***...'
    if not out.get("razao_social_uc"):
        m = re.search(
            r"(?:^|\n)([A-ZÀ-Ÿ][A-ZÀ-Ÿ0-9 /&.\-]{3,60})\s*\n[^\n]*\n[^\n]*\n?\s*CNPJ:\s*\d{2}\.[*\d]+",
            texto, re.M
        )
        if m:
            razao = m.group(1).strip()
            UPPER = razao.upper()
            BLACKLIST = ("ENEL", "AMPLA", "CEMIG", "ENERGISA", "LIGHT", "CPFL", "EDP", "COPEL", "EQUATORIAL",
                         "NEOENERGIA", "ELEKTRO", "AES", "DISTRIBUI", "CONTA DE ENERGIA", "NOTA FISCAL",
                         "DEMONSTRATIVO", "FATURA", "DOCUMENTO", "PAGADOR", "CPF/CNPJ", "REFERÊNCIA",
                         "COMPANHIA", "PIRATININGA", "PAULISTA", "SANTA CRUZ", "REDES",
                         "CÓDIGO", "CODIGO", "INSTALA", "CONSUMIDORA", "MEDIDOR", "DEMANDA")
            if not any(b in UPPER for b in BLACKLIST) and len(razao) >= 3:
                out["razao_social_uc"] = razao

    # Pattern Light: razão é a linha ANTES do UC numérico (8-12 dígitos puros)
    # Ex: 'VIA S A\n430338212\nR MATRIZ 33 NN 43'
    if not out.get("razao_social_uc"):
        m = re.search(
            r"(?:^|\n)([A-ZÀ-Ÿ][A-ZÀ-Ÿ0-9 /&.\-]{2,80})\n\s*(\d{8,12})\s*\n",
            texto, re.M
        )
        if m:
            razao = m.group(1).strip()
            UPPER = razao.upper()
            BLACKLIST = ("ENEL", "AMPLA", "CEMIG", "ENERGISA", "LIGHT", "CPFL", "EDP", "COPEL", "EQUATORIAL",
                         "NEOENERGIA", "ELEKTRO", "AES", "DISTRIBUI", "GRUPO", "CONSULTE", "CHAVE", "PROTOCOLO")
            if not any(b in UPPER for b in BLACKLIST) and len(razao) >= 3:
                out["razao_social_uc"] = razao

    # Endereço UC: linha após as 4 datas de leitura — termina com CEP 8 dígitos
    m = re.search(
        r"\d{2}/\d{2}/\d{4}\s+\d{2}/\d{2}/\d{4}\s+\d{1,3}\s+\d{2}/\d{2}/\d{4}\s*\n"
        r"([A-Z][^\n]+?)\s*[-–]\s*(\d{8})\s*\n",
        texto
    )
    if m:
        out["endereco_uc"] = m.group(1).strip()
        out["cep_uc"] = m.group(2).strip()

    # Fallback universal: linha logo após "ENDEREÇO DA UNIDADE CONSUMIDORA"
    # (layouts pré-DANF3E — Energisa MT antigo etc.)
    if not out.get("endereco_uc"):
        m = re.search(
            r"ENDERE[ÇC]O\s+DA\s+UNIDADE\s+CONSUMIDORA\s*\n([A-ZÀ-Ÿ][^\n]{5,150})",
            texto, re.I
        )
        if m:
            linha = m.group(1).strip()
            if not any(k in linha.upper() for k in ("DISTRIBUIDORA", "ENERGIA S.A.", "BANCO", "CNPJ")):
                out["endereco_uc"] = linha

    # Padrão Enel/Ampla (página 2 redundância): endereço + cidade + bairro + CEP formatado
    #   'LARGO SANTO ANTONIO 00017\n17 CABO FRIO VILA NOVA 28900-001'
    # CEP SEMPRE formatado XXXXX-XXX (com hífen). Pega o ÚLTIMO CEP (UC),
    # descartando o primeiro (header da distribuidora).
    if not out["cep_uc"]:
        ceps = list(re.finditer(r"\b(\d{5}-\d{3})\b", texto))
        # Lista de CEPs conhecidos de distribuidoras (descartar)
        CEP_DISTRIBUIDORAS = {"20220-297", "30190-131", "01310-100", "60160-280"}
        ceps_validos = [m.group(1) for m in ceps if m.group(1) not in CEP_DISTRIBUIDORAS]
        if ceps_validos:
            out["cep_uc"] = ceps_validos[-1]  # último (geralmente o da UC no rodapé)
        elif ceps:
            out["cep_uc"] = ceps[-1].group(1)

    # Cidade e bairro UC (Enel): linha terminada em CEP XXXXX-XXX
    # Plumber: '17 CABO FRIO VILA NOVA 28900-001'
    if out["cep_uc"]:
        m = re.search(
            r"(?:^|\n)([A-ZÀ-Ÿ\d][^\n]{3,80}?)\s+(" + re.escape(out["cep_uc"]) + r")\b",
            texto
        )
        if m:
            linha = m.group(1).strip()
            # Tenta separar bairro / cidade do nome de logradouro
            # Heurística simples: últimas 1-2 palavras de uma sequência maiúscula tendem a ser bairro
            out["_endereco_cidade_uc_raw"] = linha

    return out


# ────────────────────────────────────────────────────────────────────────
# 5. Mês de referência + data vencimento
# ────────────────────────────────────────────────────────────────────────
_MESES_PT = {
    "janeiro": "01", "fevereiro": "02", "março": "03", "marco": "03",
    "abril": "04", "maio": "05", "junho": "06", "julho": "07",
    "agosto": "08", "setembro": "09", "outubro": "10", "novembro": "11", "dezembro": "12",
    "jan": "01", "fev": "02", "mar": "03", "abr": "04", "mai": "05", "jun": "06",
    "jul": "07", "ago": "08", "set": "09", "out": "10", "nov": "11", "dez": "12",
}


def extrair_vencimento_valor(texto: str) -> dict:
    """Padrão Energisa: 'Abril / 2026 21/05/2026 R$ 35.781,77 ...'"""
    out = {"mes_referencia": None, "data_vencimento": None, "valor_total": None}

    # 1) Linha com mês escrito + vencimento + valor (logo após 'Protocolo de Autorização:')
    m = re.search(
        r"(Janeiro|Fevereiro|Mar[çc]o|Abril|Maio|Junho|Julho|Agosto|Setembro|Outubro|Novembro|Dezembro)"
        r"\s*/\s*(\d{4})\s+(\d{2}/\d{2}/\d{4})\s+R?\$?\s*([\d.]+,\d{2})",
        texto, re.I
    )
    if m:
        mes_nome = m.group(1).lower().replace("ç", "c")
        ano = m.group(2)
        out["mes_referencia"] = f"{_MESES_PT.get(mes_nome, '??')}/{ano}"
        out["data_vencimento"] = m.group(3)
        out["valor_total"] = m.group(4)
        return out

    # 1.5) Layout Elektro SP: 'Outubro/2025 R$1.824,97 21/10/2025' (mês/ano + R$ + venc)
    m = re.search(
        r"(Janeiro|Fevereiro|Mar[çc]o|Abril|Maio|Junho|Julho|Agosto|Setembro|Outubro|Novembro|Dezembro)"
        r"\s*/\s*(\d{4})\s+R\$\s*([\d.]+,\d{2})\s+(\d{2}/\d{2}/\d{4})",
        texto, re.I
    )
    if m:
        mes_nome = m.group(1).lower().replace("ç", "c")
        ano = m.group(2)
        out["mes_referencia"] = f"{_MESES_PT.get(mes_nome, '??')}/{ano}"
        out["valor_total"] = m.group(3)
        out["data_vencimento"] = m.group(4)
        return out

    # 2) Fallback: formato curto 'ABR/2024 17/04/2024 R$ 272,87' (B1 Conv Boleto+PIX)
    if not out["valor_total"]:
        m = re.search(
            r"\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/(\d{4})\s+(\d{2}/\d{2}/\d{4})\s+R?\$?\s*([\d.]+,\d{2})",
            texto, re.I
        )
        if m:
            _MES_ABREV = {"JAN":"01","FEV":"02","MAR":"03","ABR":"04","MAI":"05","JUN":"06",
                          "JUL":"07","AGO":"08","SET":"09","OUT":"10","NOV":"11","DEZ":"12"}
            mes_abr = m.group(1).upper()
            out["mes_referencia"] = f"{_MES_ABREV.get(mes_abr,'??')}/{m.group(2)}"
            out["data_vencimento"] = m.group(3)
            out["valor_total"] = m.group(4)
            return out

    # 3) Fallback: 'VENCIMENTO\nDD/MM/AAAA'
    if not out["data_vencimento"]:
        m = re.search(r"VENCIMENTO\s*\n?\s*(\d{2}/\d{2}/\d{4})", texto, re.I)
        if m: out["data_vencimento"] = m.group(1)

    # 3.5) Fallback layouts antigos: 'PAGAR PREFERENCIALMENTE NO BANCO ... DD/MM/AAAA'
    # (Energisa MT pré-2022 — boleto sem linha 'VENCIMENTO' direta)
    if not out["data_vencimento"]:
        m = re.search(r"PAGAR\s+PREFERENCIALMENTE[^\n]*?(\d{2}/\d{2}/\d{4})", texto, re.I)
        if m: out["data_vencimento"] = m.group(1)

    # 3.6) Layout Enel SP antigo (2018-2019): 'VENCIMENTO ... DD MES_PT AAAA' (espaçado)
    # Texto OCR tem ruído entre VENCIMENTO e a data ('VENCIMENTO i TOTAlA PAGAR | 04 FEV 2019')
    # OCR confunde DEZ→OEZ, então aceito 'OEZ' como sinônimo.
    _MES_PT_FULL = {"JAN":"01","FEV":"02","MAR":"03","ABR":"04","MAI":"05","JUN":"06",
                    "JUL":"07","AGO":"08","SET":"09","OUT":"10","NOV":"11","DEZ":"12","OEZ":"12"}
    if not out["data_vencimento"]:
        m = re.search(
            r"VENCIMENTO[\s\S]{0,400}?(\d{1,2})\s+(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ|OEZ)\s+(\d{4})",
            texto, re.I
        )
        if m:
            dia = m.group(1).zfill(2)
            mes = _MES_PT_FULL.get(m.group(2).upper(), "01")
            ano = m.group(3)
            out["data_vencimento"] = f"{dia}/{mes}/{ano}"

    # 3.7) Layout Enel SP 2019 SEGUNDA VIA: cabeçalho '<inst> <cli> DD MES YYYY <valor>'
    # Linha após 'SEGUNDA VIA.' e '1' contém: '74099264 10013724 22 JAN 2019 841,50'
    if not out["data_vencimento"]:
        m = re.search(
            r"\b\d{6,10}\s+\d{6,10}\s+(\d{1,2})\s+(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\s+(\d{4})\s+[\d.]+,\d{2}",
            texto, re.I
        )
        if m:
            dia = m.group(1).zfill(2)
            mes = _MES_PT_FULL.get(m.group(2).upper(), "01")
            ano = m.group(3)
            # Sanidade: ano entre 2010 e 2030
            if 2010 <= int(ano) <= 2030 and 1 <= int(dia) <= 31:
                out["data_vencimento"] = f"{dia}/{mes}/{ano}"

    # 3) Mês ref pelo ciclo de leitura (mês predominante de consumo)
    if not out["mes_referencia"]:
        m = re.search(r"Leitura\s*Anterior\s*:?\s*(\d{2})/(\d{2})/(\d{4})\s+Leitura\s*Atual\s*:?\s*\d{2}/(\d{2})/\d{4}",
                      texto, re.I)
        if m:
            dia_ant = int(m.group(1))
            mes_ant = m.group(2)
            ano_ant = m.group(3)
            mes_atu = m.group(4)
            # Se leit_anterior > dia 15, mês ref = mês atual; senão = mês anterior
            ref_mes = mes_atu if dia_ant > 15 else mes_ant
            ref_ano = ano_ant
            out["mes_referencia"] = f"{ref_mes}/{ref_ano}"

    # 3.8) Layout Enel CE antigo (2019-2021, B3 OUTROS-CONV / Grupo A): o total fica
    # grudado logo após MONO/BI/TRIFÁSICO e antes do medidor (NNN-XXX-NNN). Ex.:
    # 'MONOFÁSICO\n128,31 2165708-FAE-170 - ...'. O Á sai mangled no texto cacheado,
    # por isso 'F.{0,2}SICO'. fill-if-empty (não interfere nos layouts que já acharam o total).
    if not out["valor_total"]:
        m = re.search(
            r"(?:MONO|BI|TRI)F.{0,2}SICO\s+([\d.]+,\d{2})\s+\d+-[A-Z]{3}-\d+",
            texto, re.I
        )
        if m:
            out["valor_total"] = m.group(1)

    return out


# ────────────────────────────────────────────────────────────────────────
# 8. Itens: extrai Tarifa Unit ANEEL (última coluna numérica)
# ────────────────────────────────────────────────────────────────────────
def extrair_cnpj_cliente_universal(texto: str) -> str | None:
    """Captura CNPJ cliente em layouts variados — fallback universal.

    Identificado pelo LLM crítico como gap em 19/42 reprovadas (45%).
    """
    # 1. CNPJ ao lado de palavras de cliente/pagador
    for pat in [
        r"(?:CNPJ\s*PAGADOR|PAGADOR[\s/]*CNPJ|CPF/CNPJ\s+PAGADOR|CLIENTE[\s/]*CNPJ)\s*:?\s*(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2})",
        r"PAGADOR[^\n]{0,80}?(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2})",
        r"(?:Nome|Cliente|Razão Social)[^\n]{5,80}?CNPJ\s*:?\s*(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2})",
    ]:
        m = re.search(pat, texto, re.I)
        if m: return m.group(1)
    # 2. Normalização char-a-char espaçado (Enel SP/Light)
    m = re.search(r"C\s*P\s*F\s*/\s*C\s*N\s*P\s*J\s*:?", texto)
    if m:
        trecho = texto[m.end():m.end()+80]
        sem_ws = re.sub(r"\s+", "", trecho)
        mm = re.match(r"(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2})", sem_ws)
        if mm: return mm.group(1)
    # 3. CNPJ qualquer no texto, excluindo conhecidos de distribuidoras
    CNPJ_DIST = {"33.050.071", "61.695.227", "07.047.251", "06.981.180", "60.444.437",
                  "03.467.321", "04.172.213", "33.050.196", "33.884.529", "08.336.783",
                  "04.368.898", "02.328.280", "02.302.100", "28.152.650", "01.543.032",
                  "04.895.728", "15.139.629", "10.835.932", "15.413.826"}
    for m in re.finditer(r"\b(\d{2}\.\d{3}\.\d{3})/\d{4}-\d{2}\b", texto):
        if m.group(1) not in CNPJ_DIST:
            # Pega o match completo
            full_m = re.search(rf"\b({re.escape(m.group(1))}/\d{{4}}-\d{{2}})\b", texto)
            if full_m: return full_m.group(1)
    return None


def extrair_ie_cliente_universal(texto: str) -> str | None:
    """Captura IE cliente — gap em 14/42 reprovadas."""
    for pat in [
        r"Insc[r\.]+\s*Estadual\s*:?\s*(\d{6,15}|ISENTO)",
        r"INSC\.?\s*EST\.?\s*:?\s*(\d{6,15}|ISENTO)",
        r"\bIE\s*:?\s*(\d{6,15}|ISENTO)",
        r"INSCRIÇÃO\s+ESTADUAL\s*:?\s*(\d{6,15}|ISENTO)",
    ]:
        m = re.search(pat, texto, re.I)
        if m:
            v = m.group(1)
            # Descarta IEs conhecidas de distribuidoras
            if v not in ("80046561", "80.046.561", "130204250", "244946329113"):
                return v
    return None


def extrair_valor_total_universal(texto: str) -> str | None:
    """Captura valor total — gap em 7/42 reprovadas."""
    for pat in [
        r"TOTAL\s+A\s+PAGAR\s*R?\$?\s*([\d.]+,\d{2})",
        r"Total\s+a\s+pagar\s*R?\$?\s*([\d.]+,\d{2})",
        r"VALOR\s+(?:DO\s+)?DOCUMENTO\s*R?\$?\s*([\d.]+,\d{2})",
        r"TOTAL\s+DA\s+FATURA\s*R?\$?\s*([\d.]+,\d{2})",
        r"VALOR\s+COBRADO\s*\(?R?\$?\)?\s*:?\s*([\d.]+,\d{2})",   # Equatorial
        # (?<!no\s): CEMIG "Bandeira Amarela - Já Incluído no valor a pagar 2,38" NÃO é o total
        r"(?<!no\s)VALOR\s+A\s+PAGAR\s*\(?R?\$?\)?\s*:?\s*([\d.]+,\d{2})",
        # Linha "MES/AA DD/MM/AAAA R$ X,XX"
        r"[A-Z]{3}/\d{4}\s+\d{2}/\d{2}/\d{4}\s+R\$\s*([\d.]+,\d{2})",
    ]:
        m = re.search(pat, texto, re.I)
        if m: return m.group(1)
    return None


def extrair_historico_universal(texto: str) -> list:
    """Pattern universal de histórico 13 meses — cobre todos os layouts conhecidos.

    Formatos suportados:
      - 'MMM/AA NNNN.NN N LID' (Enel SP)
      - 'MMM<AA> NNNN.NN N LID' (Enel Rio Ampla)
      - 'OCT25 6080 29' (Elektro inglês)
      - 'MAI/2024 6.923 33' (Neoenergia/CEMIG/CELPE)
      - 'JAN/26 10.844' (Light vertical — sem dias)
      - 'OUT/25 100,08 104,83 1.526,78 31.321,64' (Equatorial horizontal)
    """
    out = []
    meses_capturados = set()

    MES_EN_TO_PT = {"JAN":"JAN","FEB":"FEV","MAR":"MAR","APR":"ABR","MAY":"MAI","JUN":"JUN",
                    "JUL":"JUL","AUG":"AGO","SEP":"SET","OCT":"OUT","NOV":"NOV","DEC":"DEZ"}

    # Pattern 1: Equatorial/Light horizontal — 'MMM/AA NNNN,NN ...'
    # EXIGE primeiro valor com vírgula decimal BR (formato NNN,NN ou N.NNN,NN).
    # Filtra falsos positivos onde MES/AA é seguido por dias (29), DIC/FIC (20,00 mas
    # confundível), ou outros números inteiros.
    _NUM_BR_HIST = r"\d{1,3}(?:\.\d{3})*,\d{2}"
    pat_horiz = re.compile(
        r"\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/(\d{2,4})"
        rf"\s+({_NUM_BR_HIST})(?:\s+([\d.,]+))?(?:\s+([\d.,]+))?(?:\s+([\d.,]+))?",
        re.I
    )
    for m in pat_horiz.finditer(texto):
        mes = m.group(1).upper()
        ano_raw = m.group(2)
        ano = int(ano_raw) if len(ano_raw) == 4 else 2000 + int(ano_raw)
        chave = (mes, ano)
        if chave in meses_capturados: continue
        valores = [g for g in (m.group(3), m.group(4), m.group(5), m.group(6)) if g]
        # filtra falsos positivos (mês sem valor coerente)
        try:
            v1 = float(valores[0].replace(".", "").replace(",", "."))
            if v1 < 1 or v1 > 1000000: continue
        except: continue
        meses_capturados.add(chave)
        item = {
            "mes": mes, "ano": ano,
            "consumo_kwh": v1,
            "valores_brutos": valores,
            "_fonte": "hist_universal_horiz",
        }
        if len(valores) >= 2:
            try: item["dias_ciclo"] = int(float(valores[1].replace(".","").replace(",",".")))
            except: pass
        out.append(item)

    # Pattern 2: Enel SP/RJ Ampla — sem barra: 'MMM<AA> N.NNN.NN N LID'
    pat_enel = re.compile(
        r"\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)(\d{2})"
        r"\s+([\d.,]+)\s+(\d+)\s+(?:LID|EST|MED|NIM|MIN)\b",
        re.I
    )
    for m in pat_enel.finditer(texto):
        mes = m.group(1).upper()
        ano = 2000 + int(m.group(2))
        chave = (mes, ano)
        if chave in meses_capturados: continue
        try: consumo = float(m.group(3).replace(".","").replace(",","."))
        except: continue
        meses_capturados.add(chave)
        out.append({
            "mes": mes, "ano": ano,
            "consumo_kwh": consumo,
            "dias_ciclo": int(m.group(4)),
            "_fonte": "hist_universal_enel",
        })

    # Pattern 3b: Enel SP moderno — 'jul/22 790 31' (MES/AA inteiro+dias, minúsculo)
    pat_enel_moderno = re.compile(
        r"\b(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)/(\d{2})"
        r"\s+(\d{1,6})\s+(\d{1,3})\b",
        re.I,
    )
    for m in pat_enel_moderno.finditer(texto):
        mes = m.group(1).upper()
        ano = 2000 + int(m.group(2))
        chave = (mes, ano)
        if chave in meses_capturados: continue
        try: consumo = float(m.group(3))
        except: continue
        try: dias = int(m.group(4))
        except: continue
        # Sanity: consumo positivo, dias 25-35 (ciclo mensal)
        if consumo <= 0 or dias < 25 or dias > 35:
            continue
        meses_capturados.add(chave)
        out.append({
            "mes": mes, "ano": ano,
            "consumo_kwh": consumo, "dias_ciclo": dias,
            "_fonte": "hist_universal_enel_moderno",
        })

    # Pattern 3c: Light Via Varejo — 'ABR/19 ------ 0 30' OU 'ABR/20 ------ 1.450 32'
    # Consumo pode ter separador BR de milhar: '1.450', '12.580', etc.
    pat_light_vv = re.compile(
        r"\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/(\d{2})"
        r"\s+[\-\s]+\s+(\d{1,3}(?:\.\d{3})*|\d{1,6})\s+(\d{1,3})\b",
        re.I,
    )
    for m in pat_light_vv.finditer(texto):
        mes = m.group(1).upper()
        ano = 2000 + int(m.group(2))
        chave = (mes, ano)
        if chave in meses_capturados: continue
        try: consumo = float(m.group(3).replace(".", ""))  # remove sep milhar BR
        except: continue
        try: dias = int(m.group(4))
        except: continue
        if dias < 25 or dias > 35:
            continue
        meses_capturados.add(chave)
        out.append({
            "mes": mes, "ano": ano,
            "consumo_kwh": consumo, "dias_ciclo": dias,
            "_fonte": "hist_universal_light_vv",
        })

    # Pattern 3d: Via Varejo histórico horizontal INVERTIDO
    # Linha 1 (acima): consumos '6150 7913 8979 8200 7831 ...'
    # Linha 2 (abaixo): meses 'MAR/20 FEV/20 JAN/20 ...'
    # Match posicional 1-a-1, em ordem inversa (último mês = mais recente)
    linhas = texto.split("\n")
    for i, ln in enumerate(linhas):
        # Linha com 8+ meses MMM/AA contínuos = bingo
        meses_match = re.findall(r"\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/(\d{2})\b", ln, re.I)
        if len(meses_match) < 8:
            continue
        # Procura linha ACIMA com mesma quantidade de números inteiros
        if i == 0: continue
        ln_acima = linhas[i-1]
        nums_acima = re.findall(r"\b(\d{1,6})\b", ln_acima)
        if len(nums_acima) < len(meses_match):
            continue
        # Match posicional: primeiros N números = primeiros N meses
        for (mes_str, ano_str), cons_str in zip(meses_match, nums_acima[:len(meses_match)]):
            mes = mes_str.upper(); ano = 2000 + int(ano_str)
            chave = (mes, ano)
            if chave in meses_capturados: continue
            try: consumo = float(cons_str)
            except: continue
            if consumo <= 0 or consumo > 1_000_000: continue
            meses_capturados.add(chave)
            out.append({
                "mes": mes, "ano": ano, "consumo_kwh": consumo,
                "dias_ciclo": None,
                "_fonte": "hist_universal_horizontal_invertido",
            })
        if out:
            break  # já encontrou — sai do scan

    # Pattern 3: Elektro inglês — 'OCT25 6080 29'
    pat_en = re.compile(
        r"\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})\s+(\d+)\s+(\d+)\b"
    )
    for m in pat_en.finditer(texto):
        mes = MES_EN_TO_PT.get(m.group(1).upper())
        if not mes: continue
        ano = 2000 + int(m.group(2))
        chave = (mes, ano)
        if chave in meses_capturados: continue
        try: consumo = float(m.group(3))
        except: continue
        if consumo < 1: continue
        meses_capturados.add(chave)
        out.append({
            "mes": mes, "ano": ano,
            "consumo_kwh": consumo,
            "dias_ciclo": int(m.group(4)),
            "_fonte": "hist_universal_elektro",
        })

    # Ordena cronologicamente
    MES_ORD = {"JAN":1,"FEV":2,"MAR":3,"ABR":4,"MAI":5,"JUN":6,"JUL":7,"AGO":8,"SET":9,"OUT":10,"NOV":11,"DEZ":12}
    out.sort(key=lambda h: (h["ano"], MES_ORD.get(h["mes"], 0)), reverse=True)
    return out[:13]


def extrair_itens_equatorial(texto: str) -> list:
    """Pattern Equatorial GO/PA: itens com Benefício Tarifário, PARCELA TUSD, ENCARGO COVID etc.

    Layouts visados Equatorial GO (gold 47330):
      'DEMANDA LIVRE PCH50 C/ DESC. 50% kW 200 14,863512 2.972,70 263,71 2.972,70 0 0,00 13,545000'
      'PARCELA TUSD FP LIVRE kWh 15480 0,107418 1.662,83 ...'
      'BENEFÍCIO TARIFÁRIO BRUTO 3.632,74 322,26 3.632,74 0 0,00'
      'BENEFÍCIO TARIFÁRIO LÍQUIDO -3.310,49'
      'CONTRIB. ILUM. PÚBLICA - MUNICIPAL 7,57'
      'DIF DESC TUSD CCEE(+) KW FP 07/2025 2,74'

    Equatorial PA: layout similar mas com perda de transformação no consumo.
    """
    out = []
    # Pattern principal: ITEM + UN + QTD + TARIFA + VALOR + tributos
    # Equatorial GO mistura tabela de medição + itens na MESMA LINHA. Não ancorar com `^`.
    # Aceita itens em qualquer posição da linha, contanto que precedido por whitespace ou início.
    # Whitelist: itens REALMENTE cobrados no DANF3E Equatorial GO.
    # UFER/DMCR são tabela de medição (não item cobrado) — excluir do pattern.
    # Itens devem ter unidade kWh/kW + qtd + tarifa + valor (3+ números).
    pat = re.compile(
        r"(?:^|\s)("
        r"CONSUMO\s+(?:FP|HR|P|FORA\s+PONTA|PONTA|RESERVADO)"
        r"|PARCELA\s+TE\s+(?:FP|HR|P)"
        r"|DEMANDA(?:\s+(?:FP|HR|P|FORA\s+PONTA|PONTA|RESERVADO))?"
        r"|ULTRAPASSAGEM(?:\s+\w+){0,3}"
        r")\s+"
        r"(kW|KW|kWh|KWH|MWh|MW)\s+"                   # unidade OBRIGATÓRIA (kW ou kWh)
        r"([\d.,]+)\s+"                                # qtd
        r"([\d,]+)\s+"                                 # tarifa c/trib
        r"(-?[\d.]+,\d{2})"                            # valor
        r"(?:\s+(-?[\d.]+,\d{2}))?"                    # pis_cofins
        r"(?:\s+(-?[\d.]+,\d{2}))?"                    # base ICMS
        r"(?:\s+(\d{1,2}(?:,\d+)?))?"                  # aliq ICMS
        r"%?\s*"
        r"(?:(-?[\d.]+,\d{2}))?"                       # ICMS valor
        r"(?:\s+([\d,]+))?",                            # tarifa aneel
        re.M | re.I,
    )
    # Pattern auxiliar pra encargos sem unidade: 'MULTA - 06/2022. 5.375,72'
    pat_encargo = re.compile(
        r"(?:^|\s)("
        r"MULTA\s*-?\s*\d+/\d+"
        r"|JUROS\s+DE\s+MORA\s*-?\s*\d+/\d+"
        r"|ATUALIZA(?:Ç|C)AO\s+MONET[ÁA]RIA\s*-?\s*\d+/\d+"
        r"|PARCELAMENTO\s+DE\s+D[ÉE]BITO\s*\d+/\d+"
        r")[\.\s]+(-?[\d.]+,\d{2})\b",
        re.M | re.I,
    )
    for m in pat.finditer(texto):
        desc = m.group(1).strip()
        if any(desc.upper().startswith(s) for s in ("CHAVE", "PROTOCOLO", "CONSULTE", "TENSAO",
                                                      "CFOP", "DATA DE", "GRANDEZAS")):
            continue
        try:
            qtd_str = m.group(3)
            qtd_num = float(qtd_str.replace(".", "").replace(",", "."))
            tar_num = float(m.group(4).replace(",", "."))
            val_num = float(m.group(5).replace(".", "").replace(",", "."))
        except: continue
        # Captura tributos (icms_base, aliq, icms_valor)
        item = {
            "descricao": desc,
            "unidade": m.group(2),
            "posto": None,
            "eh_credito_gd": val_num < 0,
            "quantidade_string": qtd_str,
            "quantidade_numerica": qtd_num,
            "tarifa_unit_string": m.group(4),
            "tarifa_unit_numerica": tar_num,
            "valor_brl_string": m.group(5),
            "valor_brl_numerico": val_num,
            "_fonte": "regex_equatorial",
        }
        if m.group(6):
            item["pis_cofins_string"] = m.group(6)
        if m.group(7):
            item["icms_base_string"] = m.group(7)
            try: item["icms_base_numerico"] = float(m.group(7).replace(".","").replace(",","."))
            except: pass
        if m.group(8): item["icms_aliquota_pct"] = m.group(8)
        if m.group(9):
            item["icms_valor_string"] = m.group(9)
            try: item["icms_valor_numerico"] = float(m.group(9).replace(".","").replace(",","."))
            except: pass
        # Classifica TE/TUSD pela descrição
        desc_up = desc.upper()
        if "PARCELA TE" in desc_up:
            item["eh_componente_te"] = True
        elif any(k in desc_up for k in ("CONSUMO", "DEMANDA", "UFER", "PARCELA TUSD", "TUSD")):
            item["eh_componente_tusd"] = True
        out.append(item)

    # Encargos sem unidade (MULTA / JUROS / ATUALIZAÇÃO / PARCELAMENTO)
    for m in pat_encargo.finditer(texto):
        desc = m.group(1).strip()
        try: val_num = float(m.group(2).replace(".","").replace(",","."))
        except: continue
        # Dedup: pula se já capturado (desc similar)
        if any(it.get("descricao","").upper().startswith(desc[:10].upper()) for it in out): continue
        out.append({
            "descricao": desc, "unidade": None, "posto": None,
            "eh_credito_gd": False,
            "quantidade_string": None, "quantidade_numerica": None,
            "tarifa_unit_string": None, "tarifa_unit_numerica": None,
            "valor_brl_string": m.group(2), "valor_brl_numerico": val_num,
            "_fonte": "regex_equatorial_encargo",
        })

    # Descontos/encargos sem qtd: BENEFÍCIO, CONTRIB.ILUM, DIF DESC, CIP, Adicional Bandeira
    pat_desc = re.compile(
        r"^((?:BENEF[ÍI]CIO|CONTRIB|DIF[\s\.]+DESC|CIP|ADICIONAL\s+BANDEIRA|Cob\.\s+ICMS|ICMS\s+CDE|"
        r"CIP\s+-\s+ILUM\s+PUB|ILUM\s+P[UÚ]B|ENCARGO\s+CONTA|DEDUCAO|SUBSIDIO|COBRANCA)"
        r"[A-ZÀ-Ÿa-zà-ÿ0-9\(\)\+\-\s\./]+?)\s+(-?[\d.]+,\d{2})\s*$",
        re.M | re.I
    )
    for m in pat_desc.finditer(texto):
        desc = m.group(1).strip()
        if any(desc.upper()[:20] == it["descricao"][:20].upper() for it in out): continue
        try: val_num = float(m.group(2).replace(".", "").replace(",", "."))
        except: continue
        out.append({
            "descricao": desc, "unidade": None, "posto": None,
            "eh_credito_gd": val_num < 0,
            "quantidade_string": None, "quantidade_numerica": None,
            "tarifa_unit_string": None, "tarifa_unit_numerica": None,
            "valor_brl_string": m.group(2), "valor_brl_numerico": val_num,
            "_fonte": "regex_equatorial_desconto",
        })
    return out


def extrair_itens_celesc(texto: str) -> list:
    """Pattern Celesc DANF3E: itens prefixados por código (0D), (0E), (0R), (0S), (2U), (2V), (C0).

    Layout:
      '(0D) Consumo TE     KWH 8.240,000  0,373709  3.079,36  ...'
      '(0R) Energia Injet. TE   KWH 6.888,536  -0,304780  -2.099,49  0,00 0,00 0,00 0,00 0,304781'
      '(C0) COSIP Municipal  16,45'  (sem qtd)
    """
    out = []
    # Ancoragem de casas decimais (NÃO contar espaços): qtd=3 dec, preço=6 dec, valor=2 dec.
    # O '\s*' entre qtd e preço resolve a colagem do OCR ('11.738,0000,409877' = qtd 11.738,000
    # + preço 0,409877) — causa nº1 de reprovado do balde GD Celesc.
    pat = re.compile(
        r"\(([0-9A-Z]{2})\)\s+"                       # código
        r"(.+?)\s+"                                    # desc (lazy)
        r"(?:(KWH|kWh|kW|KW|kVArh|kVAr|MWh|UN)\s+)?"   # un opcional
        r"(-?\d{1,3}(?:\.\d{3})*,\d{3})\s*"            # qtd (3 dec)
        r"(-?\d+,\d{6})\s+"                            # tarifa/preço (6 dec)
        r"(-?[\d.]+,\d{2})"                            # valor
        r"(?:\s+([\d.]+,\d{2}))?"                      # pis_cofins
        r"(?:\s+([\d.]+,\d{2}))?"                      # base ICMS
        r"(?:\s+(\d{1,2}(?:,\d+)?))?"                  # aliq ICMS
        r"(?:\s+([\d.]+,\d{2}))?"                      # ICMS valor
        r"(?:\s+([\d,]+))?",                           # tarifa aneel
        re.M
    )
    for m in pat.finditer(texto):
        codigo = m.group(1)
        desc = m.group(2).strip()
        try:
            qtd_str = m.group(4)
            qtd_num = float(qtd_str.replace(".", "").replace(",", "."))
            tar_num = float(m.group(5).replace(",", "."))
            val_num = float(m.group(6).replace(".", "").replace(",", "."))
        except: continue
        out.append({
            "descricao": desc,
            "codigo_cci": codigo,
            "unidade": m.group(3) or None,
            "posto": None,
            "eh_credito_gd": val_num < 0,
            "quantidade_string": qtd_str,
            "quantidade_numerica": qtd_num,
            "tarifa_unit_string": m.group(5),
            "tarifa_unit_numerica": tar_num,
            "valor_brl_string": m.group(6),
            "valor_brl_numerico": val_num,
            "_fonte": "regex_celesc",
        })
    return out


def extrair_itens_neoenergia(texto: str) -> list:
    """Pattern Neoenergia BA/PE (Coelba/Celpe): ITEM + UN + QTD + TARIFA + VALOR + tributos.

    Layouts visados:
      'Uso Sistema Fio kW 12,25 26,20483289 321,00 18,47 321,00 20,50 65,80 19,32454438'
      'Uso Sistema Encar.NP kWh 148,27 1,88493908 279,47 ...'
      'Cons.Reat.Exc.NPonta kVARh 199,21 0,37594821 74,89 ...'
      'Demanda Reativa Exc. kVAr 0,00 52,35665991 0,00 0,00 0,00 20,50 0,00 38,61000000'
      'Ilum. Púb. Municipal 119,49' (sem qtd)
      'Dif. Desc. Ft.Alter. 16,38- 0,93- 16,38- 20,50 3,35-' (negativo hífen final)
      'Cob. ICMS Subven-CDE 118,67'
    """
    out = []
    # Normaliza hífen final
    texto_n = re.sub(r"(\b[\d.]+,\d+)-(?=\s|$|[a-zA-Z])", r"-\1", texto)

    # Pattern principal: ITEM + UN + QTD + TARIFA + VALOR + (extras opcionais)
    pat = re.compile(
        r"^([A-ZÀ-Ÿ][A-Za-zÀ-ÿ\.\s\-/]+?)\s+"
        r"(kW|KW|kWh|KWH|kVAr|kVARh|MWh|MW|UN)\s+"
        r"(-?[\d.,]+)\s+"             # qtd
        r"([\d,]+)\s+"                 # tarifa unit c/trib
        r"(-?[\d.]+,\d{2})"            # valor
        r"(?:\s+(-?[\d.]+,\d{2}))?"    # pis_cofins
        r"(?:\s+(-?[\d.]+,\d{2}))?"    # base ICMS
        r"(?:\s+([\d,]+))?"            # aliq ICMS
        r"(?:\s+(-?[\d.]+,\d{2}))?"    # ICMS valor
        r"(?:\s+([\d,]+))?",           # tarifa aneel
        re.M
    )
    for m in pat.finditer(texto_n):
        desc = m.group(1).strip()
        if any(desc.upper().startswith(s) for s in ("CHAVE", "PROTOCOLO", "CONSULTE", "TENSAO", "GRANDEZAS")):
            continue
        try:
            qtd_str = m.group(3)
            qtd_num = float(qtd_str.replace(".", "").replace(",", "."))
            tar_num = float(m.group(4).replace(",", "."))
            val_num = float(m.group(5).replace(".", "").replace(",", "."))
        except: continue
        out.append({
            "descricao": desc,
            "unidade": m.group(2),
            "posto": None,
            "eh_credito_gd": val_num < 0,
            "quantidade_string": qtd_str,
            "quantidade_numerica": qtd_num,
            "tarifa_unit_string": m.group(4),
            "tarifa_unit_numerica": tar_num,
            "valor_brl_string": m.group(5),
            "valor_brl_numerico": val_num,
            "_fonte": "regex_neoenergia",
        })

    # Descontos/encargos sem qtd (Cob., Cb., Dif., Ilum., Imp., Cons., ICMS-CDE NF, Consumo-TUSD/TE compacto)
    # Pattern Coelba/Celpe: 'Cob. ICMS Subven-CDE 118,67', 'Ilum. Púb. Municipal 119,49', 'ICMS-CDE NF300726925 35,07'
    pat_desc = re.compile(
        r"^((?:Cob\.|Cb\.|Dif\.|Ilum\.|Imp\.|Cont|ICMS-CDE|Cons\.|Cred\.|Compl\.|Adic)[A-Za-zÀ-ÿ0-9\s\.\-/]+?)\s+(-?[\d.]+,\d{2})\s*$",
        re.M
    )
    for m in pat_desc.finditer(texto_n):
        desc = m.group(1).strip()
        if any(desc.upper()[:15] == it["descricao"][:15].upper() for it in out): continue
        try: val_num = float(m.group(2).replace(".", "").replace(",", "."))
        except: continue
        out.append({
            "descricao": desc, "unidade": None, "posto": None,
            "eh_credito_gd": val_num < 0,
            "quantidade_string": None, "quantidade_numerica": None,
            "tarifa_unit_string": None, "tarifa_unit_numerica": None,
            "valor_brl_string": m.group(2), "valor_brl_numerico": val_num,
            "_fonte": "regex_neoenergia_desconto",
        })
    return out


def extrair_itens_copel(texto: str) -> list:
    """Pattern COPEL (e Celesc): itens com UN variado + valores BR.

    Layouts:
      'DEMANDA DE DISTRIBUICAO TUSD kW 17,41 13,973578 243,28 13,89 46,22 10,614310'
      'ENERGIA ELETRICA ACL-COM ICMS ST P TMEWh 1,072 182,938433 196,11 ...'
      'SUBSIDIO TARIFARIO TUSD UN 748,96 1,316586 986,07 49,76 187,35 1,000000'
    Descontos:
      'SUBSIDIO TARIFARIO LIQUIDO -748,96'
      'CONT ILUMIN PUBLICA MUNICIPIO 122,80'
      'COBRANCA AJUSTE DE FATURAMENTO 22,29'
      'DEDUCAO ENERGIA ELETRICA ACL-SEM ICMS -952,40'
    """
    out = []
    # Pattern principal: DESC + UN + QTD + TAR + VAL + (extras)
    pat = re.compile(
        r"^([A-ZÀ-Ÿ][A-ZÀ-Ÿ0-9\s\.\-]{4,80}?)\s+"
        r"(kW|KW|kWh|KWH|MWh|MW|UN|kVAr|TMEWh)\s+"
        r"([\d.,]+)\s+"                  # qtd
        r"([\d,]+)\s+"                   # tarifa
        r"(-?[\d.]+,\d{2})"              # valor
        r"(?:\s+(-?[\d.]+,\d{2}))?"      # pis_cofins/base
        r"(?:\s+(-?[\d.]+,\d{2}))?"      # base ICMS / icms valor
        r"(?:\s+([\d.,]+))?",             # tarifa aneel
        re.M
    )
    for m in pat.finditer(texto):
        desc = m.group(1).strip()
        if any(desc.upper().startswith(s) for s in ("CHAVE", "PROTOCOLO", "CONSULTE", "TENSAO")):
            continue
        try:
            qtd_str = m.group(3)
            qtd_num = float(qtd_str.replace(".", "").replace(",", "."))
            tar_num = float(m.group(4).replace(",", "."))
            val_num = float(m.group(5).replace(".", "").replace(",", "."))
        except: continue
        out.append({
            "descricao": desc,
            "unidade": m.group(2),
            "posto": None,
            "eh_credito_gd": val_num < 0,
            "quantidade_string": qtd_str,
            "quantidade_numerica": qtd_num,
            "tarifa_unit_string": m.group(4),
            "tarifa_unit_numerica": tar_num,
            "valor_brl_string": m.group(5),
            "valor_brl_numerico": val_num,
            "_fonte": "regex_copel",
        })
    # Descontos sem qtd (COPEL)
    # Inclui também: SUBSIDIO TARIFARIO LIQUIDO/LIQDO, DEDUCAO ENERGIA, CONT ILUMIN PUBLICA, COBRANCA AJUSTE
    pat_desc = re.compile(
        r"^((?:SUBSIDIO|DEDUCAO|COBRANCA|CONT[A-Z\s]*ILUMIN|CIP|AJUSTE|ESCASSEZ\s+HIDRICA)\s+[A-ZÀ-Ÿ\s\.\-]+?)\s+(-?[\d.]+,\d{2})\s*$",
        re.M
    )
    for m in pat_desc.finditer(texto):
        desc = m.group(1).strip()
        if any(desc.upper()[:15] == it["descricao"][:15].upper() for it in out): continue
        try: val_num = float(m.group(2).replace(".", "").replace(",", "."))
        except: continue
        out.append({
            "descricao": desc, "unidade": None, "posto": None,
            "eh_credito_gd": val_num < 0,
            "quantidade_string": None, "quantidade_numerica": None,
            "tarifa_unit_string": None, "tarifa_unit_numerica": None,
            "valor_brl_string": m.group(2), "valor_brl_numerico": val_num,
            "_fonte": "regex_copel_desconto",
        })
    return out


def extrair_itens_elektro_sp(texto: str) -> list:
    """Pattern Elektro SP — 3 layouts distintos detectados por marcador final do PDF:

    L1 (DANFELEKB): DANF3E B3 BT moderno, com GD via ENERGIA INJ. OUC. Ex:
       'CONSUMO TE kWh 6.080 0,411809 2.503,80 118,47 2.503,80 18% 450,68 0,318200 ICMS 4285,17 18% 771,33'
       'ENERGIA INJ. OUC MPT TE 10/2025 GDI-I kWh -4.994 0,411808 -2.056,57 ...'
       'AD.B.VERM2 kWh 758,172414 0,101929 77,28 ...'

    L2 (DANFELEKA): DANF3E A4 Horária Verde, com demanda + subsídio. Ex:
       'TUSD ENERGIA PONTA TUSD kWh 1.358 1,325272 1.799,72 71,58 1.799,71 18% 323,94 1,034023'
       'DEMANDA DE DISTRIBUICAO TUSD kW 44,93 18,399955 826,71 ...'
       'SUBSIDIO TARIFARIO LIQUIDO -1.847,76 0%'

    L3 (GBELEKTRO1): Layout antigo 2021, CCI 0601/0699. Ex:
       '0601 CONSUMO TE 3.227,00 0,282798 912,59 1.161,09 18,00% 208,99 1.121,58'
       '0699 COFINS 2.534,65 3,42% 86,68'
       '0699 COBRANCA ILUM PUBLICA PARA A PREFEITURA 0,00 0,00% 0,00 48,58'

    Guardrails:
    - L2: ignorar 'DESCONTO SOBRE TARIFA: R$ X' (informativo, já está nas linhas negativas SUBSIDIO).
    - L3: bandeiras Vermelha + Escassez compartilham qtd (3.227 kWh), NÃO duplicar consumo.
    """
    out = []
    upper = texto.upper()
    eh_l3 = "GBELEKTRO" in upper or ("CCI" in texto and re.search(r"\b0601\s+CONSUMO\s+TE\b", texto))
    eh_l2 = ("DANFELEKA" in upper) or ("HORÁRIA VERDE" in upper) or ("HORARIA VERDE" in upper)
    eh_l1 = ("DANFELEKB" in upper) or (not eh_l3 and not eh_l2 and "ENERGIA INJ. OUC" in upper)

    # ── L3: Antigo 2021 (CCI 0601 energia + CCI 0699 tributos/IP) ──
    if eh_l3:
        # CCI 0601: '0601 DESC qtd tarifa val_forn base_icms aliq% icms_val val_total'
        pat_06 = re.compile(
            r"\b0601\s+([A-ZÀ-Ÿ][A-ZÀ-Ÿ\d\.\s\-/]+?)\s+"
            r"([\d.]+,\d{2})\s+"                # qtd (3.227,00)
            r"([\d,]+)\s+"                       # tarifa fornec (0,282798)
            r"([\d.]+,\d{2})\s+"                # valor fornec
            r"([\d.]+,\d{2})\s+"                # base ICMS
            r"(\d{1,2}(?:,\d+)?)%?\s+"          # alíq ICMS
            r"([\d.]+,\d{2})\s+"                # ICMS valor
            r"([\d.]+,\d{2})\b"                  # valor total (última col)
        )
        for m in pat_06.finditer(texto):
            desc = m.group(1).strip()
            try:
                qtd_str = m.group(2)
                qtd_num = float(qtd_str.replace(".", "").replace(",", "."))
                tar_num = float(m.group(3).replace(",", "."))
                val_num = float(m.group(8).replace(".", "").replace(",", "."))
            except: continue
            out.append({
                "descricao": desc, "unidade": "kWh", "posto": None,
                "eh_credito_gd": val_num < 0,
                "quantidade_string": qtd_str, "quantidade_numerica": qtd_num,
                "tarifa_unit_string": m.group(3), "tarifa_unit_numerica": tar_num,
                "valor_brl_string": m.group(8), "valor_brl_numerico": val_num,
                "icms_base_string": m.group(5),
                "icms_aliquota_pct": m.group(6),
                "icms_valor_string": m.group(7),
                "_fonte": "regex_elektro_l3_cci0601",
            })
        # CCI 0699 tributos: '0699 COFINS 2.534,65 3,42% 86,68' / '0699 PIS 2.534,65 0,73 18,50'
        pat_99 = re.compile(
            r"\b0699\s+(COFINS|PIS)\s+"
            r"([\d.]+,\d{2})\s+"                # base
            r"([\d,]+)%?\s+"                     # aliq
            r"([\d.]+,\d{2})\b"                  # valor
        )
        for m in pat_99.finditer(texto):
            try: val_num = float(m.group(4).replace(".", "").replace(",", "."))
            except: continue
            out.append({
                "descricao": m.group(1).strip(), "unidade": None, "posto": None,
                "eh_credito_gd": False,
                "quantidade_string": None, "quantidade_numerica": None,
                "tarifa_unit_string": None, "tarifa_unit_numerica": None,
                "valor_brl_string": m.group(4), "valor_brl_numerico": val_num,
                "icms_base_string": m.group(2),
                "icms_aliquota_pct": m.group(3),
                "_fonte": "regex_elektro_l3_cci0699_tributo",
            })
        # CCI 0699 IP: '0699 COBRANCA ILUM PUBLICA PARA A PREFEITURA 0,00 0,00% 0,00 48,58'
        pat_ip = re.compile(
            r"\b0699\s+(COBRANCA\s+ILUM\s+PUBLICA[A-ZÀ-Ÿ\s]+?)\s+"
            r"[\d.]+,\d{2}\s+[\d,]+%?\s+[\d.]+,\d{2}\s+"
            r"([\d.]+,\d{2})\b",
            re.I
        )
        for m in pat_ip.finditer(texto):
            desc = m.group(1).strip()
            if any(desc[:15].upper() == it["descricao"][:15].upper() for it in out): continue
            try: val_num = float(m.group(2).replace(".", "").replace(",", "."))
            except: continue
            out.append({
                "descricao": desc, "unidade": None, "posto": None,
                "eh_credito_gd": False,
                "quantidade_string": None, "quantidade_numerica": None,
                "tarifa_unit_string": None, "tarifa_unit_numerica": None,
                "valor_brl_string": m.group(2), "valor_brl_numerico": val_num,
                "_fonte": "regex_elektro_l3_cci0699_ip",
            })
        return out

    # ── L1/L2: DANF3E moderno (linhas com qtd/tarifa/valor) ──
    if eh_l1 or eh_l2:
        # Pattern principal: DESC + UN + QTD + TAR + VAL + PIS/COFINS + BASE_ICMS + ALIQ% + ICMS_VAL + TAR_ANEEL
        pat = re.compile(
            r"^([A-Z][A-Z\d\.\s\-/]+?)\s+"        # desc (somente maiúsculas/pontos/dígitos)
            r"(kWh|KWh|kW|KW|kVArh|kVAr|MWh|MW|UN)\s+"
            r"(-?[\d.,]+)\s+"                      # qtd
            r"([\d,]+)\s+"                          # tarifa c/trib
            r"(-?[\d.]+,\d{2})\s+"                 # valor
            r"(-?[\d.]+,\d{2})\s+"                 # pis_cofins (linha)
            r"(-?[\d.]+,\d{2})\s+"                 # base ICMS (linha)
            r"(\d{1,2}(?:,\d+)?)%\s+"              # aliq ICMS
            r"(-?[\d.]+,\d{2})\s+"                 # ICMS valor
            r"([\d,]+)",                            # tarifa aneel
            re.M
        )
        for m in pat.finditer(texto):
            desc = m.group(1).strip()
            if any(desc.upper().startswith(s) for s in ("CHAVE", "PROTOCOLO", "CONSULTE", "TENSAO",
                                                          "GRANDEZAS", "MEDIDOR", "AR0", "RM0", "DEMANDA PONTA",
                                                          "DEMANDA FORA")):
                continue
            try:
                qtd_str = m.group(3)
                qtd_num = float(qtd_str.replace(".", "").replace(",", "."))
                tar_num = float(m.group(4).replace(",", "."))
                val_num = float(m.group(5).replace(".", "").replace(",", "."))
            except: continue
            out.append({
                "descricao": desc, "unidade": m.group(2), "posto": None,
                "eh_credito_gd": val_num < 0,
                "quantidade_string": qtd_str, "quantidade_numerica": qtd_num,
                "tarifa_unit_string": m.group(4), "tarifa_unit_numerica": tar_num,
                "valor_brl_string": m.group(5), "valor_brl_numerico": val_num,
                "icms_base_string": m.group(7),
                "icms_aliquota_pct": m.group(8),
                "icms_valor_string": m.group(9),
                "tarifa_unit_aneel_string": m.group(10),
                "_fonte": "regex_elektro_l1l2",
            })
        # Descontos/encargos sem qtd:
        # L1: 'COBRANCA ILUM PUBLICA PARA A PREFEITURA 92,07 0%'
        # L2: 'SUBSIDIO TARIFARIO LIQUIDO -1.847,76 0%', 'COBRANCA DE AJUSTE DE FATURAMENTO 2,50 0%'
        pat_desc = re.compile(
            r"^((?:COBRANCA|SUBSIDIO|CONTRIB|ADICIONAL\s+BAND)"
            r"[A-Z\s\.\-/]+?)\s+"
            r"(-?[\d.]+,\d{2})\s*(?:\d+%)?\s*$",
            re.M
        )
        for m in pat_desc.finditer(texto):
            desc = m.group(1).strip()
            # Guardrail L2: 'DESCONTO SOBRE TARIFA' é informativo (não item) — já está em SUBSIDIO LIQUIDO
            if "DESCONTO SOBRE TARIFA" in desc.upper(): continue
            try: val_num = float(m.group(2).replace(".", "").replace(",", "."))
            except: continue
            # Dedup por (prefix 25 chars, valor abs) — permite SUBSIDIO LIQUIDO -X e SUBSIDIO TUSD +Y
            if any(desc[:25].upper() == (it.get("descricao") or "")[:25].upper()
                   and abs((it.get("valor_brl_numerico") or 0) - val_num) < 0.01
                   for it in out):
                continue
            out.append({
                "descricao": desc, "unidade": None, "posto": None,
                "eh_credito_gd": val_num < 0,
                "quantidade_string": None, "quantidade_numerica": None,
                "tarifa_unit_string": None, "tarifa_unit_numerica": None,
                "valor_brl_string": m.group(2), "valor_brl_numerico": val_num,
                "_fonte": "regex_elektro_l1l2_desconto",
            })
        return out

    return out


def extrair_itens_cpfl(texto: str) -> list:
    """Pattern CPFL Piratininga/Paulista: '<DESC> <MES/AA> <UN> <QTD> <TAR_BASE> <TAR_TRIB> <VAL> ...'

    Ex: 'USD Consumo Reativo Ponta SET/25 kWh 34,9289 0,32865000 0,42944382 15,00 15,00 18,00 2,70 ...'
         'Energia ACL - Ponta SET/25 kWh 500,6346 0,50197000 0,58072295 290,73'
         'Desc Energia ACL Ponta 290,73-'  (crédito com hífen final)
    """
    out = []
    # Normaliza hífen final em valor (igual fix Enel Ampla)
    texto_n = re.sub(r"(\b[\d.]+,\d+)-(?=\s|$|[a-zA-Z])", r"-\1", texto)

    # Pattern principal: [COD] ITEM + MES/AA + UN + QTD + TAR_BASE + TAR_C/TRIB + VALOR
    # Aceita código 4 dígitos opcional no início (CPFL Pira Via Varejo: '0605 Custo Disp...')
    pat = re.compile(
        r"^(?:\d{4}\s+)?"                                  # código opcional (0601, 0605, etc)
        r"([A-ZÀ-Ÿ][A-Za-zÀ-ÿ0-9,\s\.\-\[\]/]+?)\s+"   # desc lazy (aceita vírgula: 49,84)
        r"([A-Z]{3}/\d{2})\s+"                            # MES/AA
        r"(kWh|KWH|kW|KW|kVArh|kVAr|MWh|MW|UN)\s+"
        r"(-?[\d.,]+)\s+"                                  # qtd
        r"([\d,]+)\s+"                                     # tarifa base
        r"([\d,]+)\s+"                                     # tarifa c/trib
        r"(-?[\d.]+,\d{2})"                                # valor
        r"(?:\s+([\d.]+,\d{2}))?"                          # base_icms
        r"(?:\s+(\d{1,2}(?:,\d+)?))?"                      # aliq_icms
        r"(?:\s+([\d.]+,\d{2}))?"                          # icms_val
        r"(?:\s+([\d.,]+))?"                               # pis_aliq
        r"(?:\s+([\d.,]+))?",                              # cofins_aliq
        re.M
    )
    for m in pat.finditer(texto_n):
        desc = m.group(1).strip()
        # Skip cabeçalhos
        if any(desc.upper().startswith(s) for s in ("UTI ", "CLASSIFIC", "TENSÃO", "CHAVE", "PROTOCOLO")): continue
        try:
            qtd_str = m.group(4)
            qtd_num = float(qtd_str.replace(".", "").replace(",", "."))
            tar_num = float(m.group(6).replace(",", "."))
            val_num = float(m.group(7).replace(".", "").replace(",", "."))
        except: continue
        out.append({
            "descricao": f"{desc} {m.group(2)}",
            "unidade": m.group(3),
            "posto": m.group(2),
            "eh_credito_gd": False,
            "quantidade_string": qtd_str,
            "quantidade_numerica": qtd_num,
            "tarifa_unit_string": m.group(6),
            "tarifa_unit_numerica": tar_num,
            "valor_brl_string": m.group(7),
            "valor_brl_numerico": val_num,
            "tarifa_unit_aneel_string": m.group(5),
            "_fonte": "regex_cpfl",
        })

    # Pattern alternativo CPFL Via Varejo: ordem QTD antes UNID
    # '0605 Custo Disp Uso Sistema TUSD ABR/20 50,000 kWh 0,31140000 15,57 15,57 18,00 2,80 15,57 0,17 0,79 Verde'
    # Layout: COD desc MES/AA qty unid tarifa valor base_icms aliq icms base_pc pis_aliq cof_aliq bandeira
    pat_via_varejo = re.compile(
        r"^(\d{4})\s+"                                     # código (obrigatório nesse layout)
        r"([A-ZÀ-Ÿ][A-Za-zÀ-ÿ0-9,\s\.\-/]+?)\s+"        # desc lazy
        r"([A-Z]{3}/\d{2})\s+"                            # MES/AA
        r"([\d.,]+)\s+"                                    # qty
        r"(kWh|KWH|kW|KW|kVArh|kVAr|MWh|MW|UN)\s+"        # unidade
        r"([\d.,]+)\s+"                                    # tarifa
        r"(-?[\d.]+,\d{2})\s+"                             # valor
        r"([\d.]+,\d{2})\s+"                               # base_icms
        r"(\d{1,2}(?:,\d+)?)\s+"                           # aliq_icms
        r"([\d.]+,\d{2})",                                 # icms_valor
        re.M
    )
    for m in pat_via_varejo.finditer(texto_n):
        # Skip se já capturado pelo pattern principal (dedup por descrição + valor)
        desc = m.group(2).strip()
        cod = m.group(1)
        try:
            qty_num = float(m.group(4).replace(".","").replace(",","."))
            tar_num = float(m.group(6).replace(".","").replace(",","."))
            val_num = float(m.group(7).replace(".","").replace(",","."))
            base_icms = float(m.group(8).replace(".","").replace(",","."))
            icms_val = float(m.group(10).replace(".","").replace(",","."))
        except: continue
        if any(it.get("descricao","").startswith(desc[:15]) and
               abs((it.get("valor_brl_numerico") or 0) - val_num) < 0.01 for it in out):
            continue
        # Classifica TE/TUSD pela presença na descrição (CPFL Via Varejo já marca explicitamente)
        desc_up = desc.upper()
        eh_tusd = "TUSD" in desc_up or "DIST" in desc_up
        eh_te = " TE" in desc_up or desc_up.endswith("TE") or "ENERGIA" in desc_up and not eh_tusd
        out.append({
            "descricao": f"{cod} {desc}",
            "unidade": m.group(5),
            "posto": None,
            "eh_credito_gd": False,
            "quantidade_string": m.group(4), "quantidade_numerica": qty_num,
            "tarifa_unit_string": m.group(6), "tarifa_unit_numerica": tar_num,
            "valor_brl_string": m.group(7), "valor_brl_numerico": val_num,
            "icms_base_string": m.group(8), "icms_base_numerico": base_icms,
            "icms_aliquota_pct": m.group(9),
            "icms_valor_string": m.group(10), "icms_valor_numerico": icms_val,
            "eh_componente_te": eh_te,
            "eh_componente_tusd": eh_tusd,
            "_fonte": "regex_cpfl_via_varejo",
        })

    # Pattern CPFL CIP/encargos simples: '0807 Contrib. Custeio IP-CIP Municipal ABR/20 23,39'
    # Layout: COD desc MES/AA valor (sem qty/unid/tarifa)
    pat_cpfl_cip = re.compile(
        r"^(\d{4})\s+"                                     # código (0807, 0808 — encargos)
        r"((?:Contrib|Cobranca|Multa|Juros|Diferen|Custeio)[A-Za-zÀ-ÿ\.\s\-/]+?)\s+"
        r"[A-Z]{3}/\d{2}\s+"                              # MES/AA (ignorado)
        r"(-?[\d.]+,\d{2})\s*$",                           # valor único
        re.M
    )
    for m in pat_cpfl_cip.finditer(texto_n):
        desc = f"{m.group(1)} {m.group(2).strip()}"
        if any(it["descricao"][:20] == desc[:20] for it in out): continue
        try: val_num = float(m.group(3).replace(".","").replace(",","."))
        except: continue
        out.append({
            "descricao": desc, "unidade": None, "posto": None,
            "eh_credito_gd": False,
            "quantidade_string": None, "quantidade_numerica": None,
            "tarifa_unit_string": None, "tarifa_unit_numerica": None,
            "valor_brl_string": m.group(3), "valor_brl_numerico": val_num,
            "_fonte": "regex_cpfl_cip",
        })

    # Pattern descontos (créditos) sem qtd: 'Desc Energia ACL Ponta -290,73'
    # OU 'Compl.TUSD Mês JUN/25 0,02' (com mes/ano no meio)
    pat_desc = re.compile(
        r"^((?:Desc|Cr[eé]dito|Compl)[A-Za-zÀ-ÿ0-9\s\.\-/]+?)\s+(-?[\d.]+,\d{2})\s*$",
        re.M | re.I
    )
    for m in pat_desc.finditer(texto_n):
        desc = m.group(1).strip()
        val_str = m.group(2).replace("-", "")
        try:
            val_num = -float(val_str.replace(".", "").replace(",", "."))
        except: continue
        out.append({
            "descricao": desc, "unidade": None, "posto": None,
            "eh_credito_gd": True,
            "quantidade_string": None, "quantidade_numerica": None,
            "tarifa_unit_string": None, "tarifa_unit_numerica": None,
            "valor_brl_string": f"-{val_str}", "valor_brl_numerico": val_num,
            "_fonte": "regex_cpfl_desconto",
        })
    return out


def extrair_itens_enel_sp(texto: str) -> list:
    """Pattern Enel SP DANF3E: tabela embaralhada com tributos+histórico laterais.

    Ex: 'USO SIST. DISTR. (TUSD) KWH 4.800,000 0,47224 2.266,74 97,95 2.266,74 18% 408,01 0,36683 ...'
         'ENERGIA (TE) KWH 4.800,000 0,36338 1.744,21 ...'
         'CIP-S.B.DO CAMPO - MUNICIPAL 37,24 0,00 0,00 0% 0,00 ...'
    Tarifa Enel SP tem 5 decimais (vs 8 Ampla/Light).
    """
    out = []
    # Pattern principal: ITEM + UN + QTD + TARIFA + VAL + PIS_COFINS + BASE + ALIQ% + ICMS + TARIFA_ANEEL
    pat = re.compile(
        r"((?:USO\s+SIST|ENERGIA|DEMANDA|TUSD|TE|CONSUMO)[A-Za-zÀ-ÿ0-9\s/\.\-\(\)]+?)\s+"  # desc com parênteses
        r"(KWH|kWh|kW|KW|UN|MWh|MW|kVArh)\s+"
        r"([\d\.]+,\d{3})\s+"        # qtd formato BR 4.800,000
        r"([\d,]+)\s+"               # tarifa 5+ decimais
        r"(-?[\d\.]+,\d{2})\s+"      # valor
        r"(-?[\d\.]+,\d{2})\s+"      # pis_cofins
        r"(-?[\d\.]+,\d{2})\s+"      # base_icms
        r"(\d{1,2}%?)\s+"            # aliq_icms
        r"(-?[\d\.]+,\d{2})\s+"      # icms_valor
        r"([\d,]+)",                 # tarifa_aneel
    )
    for m in pat.finditer(texto):
        desc = m.group(1).strip()
        try:
            qtd_str = m.group(3)
            qtd_num = float(qtd_str.replace(".", "").replace(",", "."))
            tar_num = float(m.group(4).replace(",", "."))
            val_num = float(m.group(5).replace(".", "").replace(",", "."))
        except: continue
        out.append({
            "descricao": desc,
            "unidade": m.group(2),
            "posto": "UNICO",
            "eh_credito_gd": False,
            "quantidade_string": qtd_str,
            "quantidade_numerica": qtd_num,
            "tarifa_unit_string": m.group(4),
            "tarifa_unit_numerica": tar_num,
            "valor_brl_string": m.group(5),
            "valor_brl_numerico": val_num,
            "pis_cofins_brl_string": m.group(6),
            "icms_base_string": m.group(7),
            "icms_aliquota_pct": m.group(8),
            "icms_valor_string": m.group(9),
            "tarifa_unit_aneel_string": m.group(10),
            "_fonte": "regex_enel_sp",
        })

    # Pattern CIP/Iluminação Pública (sem qtd/unidade)
    pat_cip = re.compile(
        r"((?:CIP|COSIP|ILUM[\.\s]+P[UÚ]B|CONTRIB\s+ILUM)[A-ZÀ-Ÿ0-9\s\.\-,]+?)\s+"
        r"([\d\.]+,\d{2})\s+"        # valor
        r"([\d\.]+,\d{2})\s+"        # pis_cofins
        r"([\d\.]+,\d{2})\s+"        # base_icms
        r"(\d{1,2}%?)\s+"            # aliq_icms
        r"([\d\.]+,\d{2})",          # icms_valor
        re.I
    )
    for m in pat_cip.finditer(texto):
        desc = m.group(1).strip()
        # Evita duplicar se já capturado
        if any(it["descricao"][:10].upper() == desc[:10].upper() for it in out): continue
        try:
            val_num = float(m.group(2).replace(".", "").replace(",", "."))
        except: continue
        out.append({
            "descricao": desc,
            "unidade": None, "posto": None, "eh_credito_gd": False,
            "quantidade_string": None, "quantidade_numerica": None,
            "tarifa_unit_string": None, "tarifa_unit_numerica": None,
            "valor_brl_string": m.group(2), "valor_brl_numerico": val_num,
            "pis_cofins_brl_string": m.group(3),
            "icms_base_string": m.group(4),
            "icms_aliquota_pct": m.group(5),
            "icms_valor_string": m.group(6),
            "_fonte": "regex_enel_sp_cip",
        })
    return out


def extrair_itens_light(texto: str) -> list:
    """Pattern Light DANF3E: itens em MW/kW com tarifa 8-decimais.

    Ex: 'Consumo Energia Elétrica HFP MW 13,184 162,81579000 2.146,55 ...'
         'Componente Fio kW HFP kW 76 39,48212959 3.000,63 ...'  (ACL)
         'Demanda Reativa kW HFP/Único kW 9 39,48212959 355,34 ...'
    Item negativo (crédito) tem quantidade negativa explícita.
    """
    out = []
    pat = re.compile(
        r"^([A-ZÀ-Ÿ][A-Za-zÀ-ÿ0-9\s/\.\-]{4,60}?)\s+"
        r"(HFP/[ÚU]nico|HP/[ÚU]nico|HFP|HP|FP|P|FORA\s+PONTA|PONTA|UNICO|ÚNICO|UN)\s+"
        r"(MW|MWh|kWh|KWH|kW|KW|kVArh|kVAr)\s+"
        r"(-?[\d.,]+)\s+"            # qtd
        r"([\d.,]+)\s+"              # tarifa
        r"(-?[\d.]+,\d{2})"          # valor BR
        r"(?:\s+([\d.,]+))?"         # base_icms opcional
        r"(?:\s+(\d{1,2}(?:,\d+)?))?" # aliq_icms opcional
        r"(?:\s+(-?[\d.]+,\d{2}))?"   # icms_valor opcional
        r"(?:\s+([\d.,]+))?",         # tarifa_aneel opcional
        re.M
    )
    for m in pat.finditer(texto):
        desc = m.group(1).strip()
        # Skip cabeçalhos
        if desc.upper().startswith(("MEDIDOR", "GRANDEZA", "ENERGIA TERC", "DEMANDA RE")):
            pass  # ainda inclui ENERGIA TERC COMERCIALIZAD (válido como crédito GD)
        if desc.upper() in ("CONSUMO FORA PONTA", "CONSUMO PONTA", "DEMANDA FORA PONTA", "DEMANDA PONTA",
                            "CONSUMO REATIVO FORA PONTA", "CONSUMO REATIVO PONTA",
                            "DEMANDA REATIVA FORA PONTA", "DEMANDA REATIVA PONTA"):
            continue  # linha de leitura zerada (não é item)
        try:
            qtd_str = m.group(4)
            qtd_num = float(qtd_str.replace(".", "").replace(",", "."))
            tar_num = float(m.group(5).replace(".", "").replace(",", "."))
            val_num = float(m.group(6).replace(".", "").replace(",", "."))
        except: continue
        # Skip linhas zeradas (provavelmente são leitura zerada)
        if val_num == 0 and qtd_num == 0: continue
        # Energia Terc Comercializad = mercado livre ACL (compra de comercializadora),
        # NÃO é GD/SCEE. Mesmo com qtd negativa, não marcar como crédito GD.
        desc_up = desc.upper()
        eh_gd = qtd_num < 0 and "TERC COMERCIAL" not in desc_up and "COMERCIALIZAD" not in desc_up
        item = {
            "descricao": f"{desc} {m.group(2)}",
            "unidade": m.group(3),
            "posto": m.group(2),
            "eh_credito_gd": eh_gd,
            "quantidade_string": qtd_str,
            "quantidade_numerica": qtd_num,
            "tarifa_unit_string": m.group(5),
            "tarifa_unit_numerica": tar_num,
            "valor_brl_string": m.group(6),
            "valor_brl_numerico": val_num,
            "_fonte": "regex_light",
        }
        if m.group(7):
            item["icms_base_string"] = m.group(7)
            try: item["icms_base_numerico"] = float(m.group(7).replace(".","").replace(",","."))
            except: pass
        if m.group(8): item["icms_aliquota_pct"] = m.group(8)
        if m.group(9):
            item["icms_valor_string"] = m.group(9)
            try: item["icms_valor_numerico"] = float(m.group(9).replace(".","").replace(",","."))
            except: pass
        if m.group(10): item["tarifa_unit_aneel_string"] = m.group(10)
        out.append(item)

    # Descontos sem qtd/tarifa: 'Desconto Comp. Fio HFP -1.498,80 -74,27 -1498,80 24,000 -359,71'
    # OU 'Ajuste de Desconto C. Fio HFP -13,47 -0,67 ...'
    # OU 'PIS/COFINS da subvenção/descon 165,18 165,18'
    # OU 'Contrib Ilum Pública Municipal 1.130,29'
    # OU 'Ultrapassagem C. Fio kW HFP kW 46 78,96425917 3.632,36 ...' (PEGO pelo pattern principal — não cair aqui)
    pat_desc = re.compile(
        r"^((?:Desconto|Ajuste(?:\s+de\s+Desconto)?|PIS/COFINS\s+da\s+subven\S+|ICMS\s+da\s+subven\S+|Contrib\s+Ilum|Cobranca\s+Ilum)"
        r"[A-Za-zÀ-ÿ\s\.\-/]+?)\s+"
        r"(-?[\d.]+,\d{2})",
        re.M | re.I
    )
    for m in pat_desc.finditer(texto):
        desc = m.group(1).strip()
        # Skip se descrição é redundante (já capturado)
        if any(desc.upper()[:15] == it["descricao"][:15].upper() for it in out): continue
        try:
            val_num = float(m.group(2).replace(".", "").replace(",", "."))
        except: continue
        out.append({
            "descricao": desc, "unidade": None, "posto": None,
            "eh_credito_gd": val_num < 0,
            "quantidade_string": None, "quantidade_numerica": None,
            "tarifa_unit_string": None, "tarifa_unit_numerica": None,
            "valor_brl_string": m.group(2), "valor_brl_numerico": val_num,
            "_fonte": "regex_light_desconto",
        })

    # Pattern Grupo B Light Convencional (cativo, sem posto HFP/HP).
    # Ex 1: 'Energia Elétrica kWh kWh 13.040 0.98484 12.842,38 848,88 12842,38 30,000 3852,71 0,62429 PIS/PASEP ...'
    # Ex 2: 'Custo de Disponibilidade kWh 100 0.76460 76,42 3,65 76,42 20,000 15,28 0,57498 PIS/PASEP ...'
    # Layout: desc unid qty tarifa valor pis_cof base_icms aliq icms tarifa_aneel
    pat_b = re.compile(
        r"^([A-ZÀ-Ÿ][A-Za-zÀ-ÿ\s/\.\-]{4,50}?)\s+"
        r"(kWh|KWH|kW|KW)\s+"                  # unidade (sem posto)
        r"(?:(?:kWh|KWH|kW|KW)\s+)?"           # tolera unidade duplicada "kWh kWh"
        r"([\d.]+(?:,\d+)?)\s+"                # qty (inteiro ou BR)
        r"([\d.]+(?:,\d+)?)\s+"                # tarifa (decimais varia)
        r"(-?[\d.]+,\d{2})\s+"                 # valor R$
        r"(-?[\d.]+,\d{2})\s+"                 # pis_cofins
        r"([\d.]+(?:,\d+)?)\s+"                # base_icms (sem vírgula é OK)
        r"(\d{1,2}(?:,\d+)?)\s+"               # aliq_icms
        r"(-?[\d.]+,\d{2})"                    # icms_valor
        r"(?:\s+([\d.]+(?:,\d+)?))?",          # tarifa_aneel opcional
        re.M
    )
    for m in pat_b.finditer(texto):
        desc = m.group(1).strip()
        # Skip se já capturado pelo pattern principal
        if any(desc.upper()[:15] == it["descricao"][:15].upper() for it in out): continue
        # Skip cabeçalhos
        if desc.upper().startswith(("ITENS DE FATURA", "UNID")): continue
        try:
            qtd_num = float(m.group(3).replace(".", "").replace(",", "."))
            tar_num = float(m.group(4).replace(".", "").replace(",", "."))
            val_num = float(m.group(5).replace(".", "").replace(",", "."))
        except: continue
        if val_num == 0: continue
        item = {
            "descricao": desc, "unidade": m.group(2), "posto": None,
            "eh_credito_gd": False,
            "quantidade_string": m.group(3), "quantidade_numerica": qtd_num,
            "tarifa_unit_string": m.group(4), "tarifa_unit_numerica": tar_num,
            "valor_brl_string": m.group(5), "valor_brl_numerico": val_num,
            "pis_cofins_string": m.group(6),
            "icms_base_string": m.group(7), "icms_base_numerico": float(m.group(7).replace(".","").replace(",",".")),
            "icms_aliquota_pct": m.group(8),
            "icms_valor_string": m.group(9), "icms_valor_numerico": float(m.group(9).replace(".","").replace(",",".")),
            "_fonte": "regex_light_grupo_b",
        }
        if m.group(10): item["tarifa_unit_aneel_string"] = m.group(10)
        out.append(item)
    return out


def extrair_nf_layout_antigo(texto: str) -> str:
    """Captura número da Nota Fiscal em layouts pré-DANF3E.

    Padrões:
      Energisa MT antigo: 'NF: 012.297.500' / 'Nota Fiscal/Conta - Série: B NF: 128.179.205'
      CPFL antigo:        'N° da Nota Fiscal/Conta de Energia Elétrica 108579763'
      Text-layer ruim:    'NF: 012,311,945' / 'NF 012.208' (sem dois-pontos)
    """
    if not texto:
        return ""
    # Energisa: 'NF: NNN.NNN.NNN' / 'NF NNN.NNN.NNN' / 'BNF: NNN,NNN,NNN' (text-layer ruim)
    # Aceita letra grudada antes (B/D/etc.), separador opcional, vírgulas no número
    m = re.search(r"(?:^|[\s:])[A-Z]?NF\s*[:.]?\s*(\d{3}[.,]\d{3}[.,]\d{3})\b", texto)
    if m:
        # Normaliza vírgulas em pontos
        return m.group(1).replace(",", ".")
    # CPFL: 'N° da Nota Fiscal/Conta de Energia Elétrica NNNNNNNNN'
    m = re.search(r"N[º°]\s+da\s+Nota\s+Fiscal/Conta\s+de\s+Energia\s+El[ée]trica\s*(\d{6,12})", texto, re.I)
    if m: return m.group(1)
    return ""


def extrair_subgrupo_universal(texto: str) -> str:
    """Captura subgrupo (A1/A2/A3/A3A/A4/B1/B2/B3/B4) em layouts variados.

    Padrões:
      Energisa antigo: 'GRUPO/SUBGRP.:MTC-CONVENCIONAL BAIXA TENSÃO / B2'
                       'B2 Cuiabá/MT' (depois de barra)
      Energisa novo:   'CONVENCIONAL/B2'
      Equatorial:      'A A3-A COMERCIAL' → A3-A
    """
    if not texto:
        return ""
    # Pattern 1: '/ B2 ' ou '/B2\n' (após barra, isolado)
    m = re.search(r"/\s*(A[1-4][A-Z]?|B[1-4])\b", texto)
    if m: return m.group(1)
    # Pattern 2: 'GRUPO/SUBGRP.:...B2 ' (depois de SUBGRP)
    m = re.search(r"SUBGRP[\.\:\;]*[^\n]*?\b(A[1-4][A-Z]?|B[1-4])\b", texto)
    if m: return m.group(1)
    # Pattern 3: 'A3-A' / 'A4-VERDE' (com hífen)
    m = re.search(r"\b(A[1-4])-[A-Z]", texto)
    if m: return m.group(1) + "A" if m.group(0).endswith("-A") else m.group(1)
    return ""


def extrair_classe_consumo_universal(texto: str) -> str:
    """Captura classe de consumo em layouts variados.

    Padrões:
      Energisa antigo:  'CLASSE/SUBCLS.:RURAL/AGROPECUÁRIA RURAL'
      Equatorial:       'CLASSE: COMERCIAL OU SERVIÇOS'
      DANF3E moderno:   geralmente já capturado pelo extrator base
    """
    if not texto:
        return ""
    # Energisa: 'CLASSE/SUBCLS.:RURAL/AGROPECUÁRIA RURAL CNPJ ...'
    # Aceita ':' / ';' / ',,;' (text-layer ruim) e OCR aglutinado (RURAL/AGROPECUARRUIRAAL)
    m = re.search(
        r"CLASSE/SUBCLS[\.\,\:\;]+\s*([A-ZÁÉÍÓÚÇÃÔ/]+(?:\s+[A-ZÁÉÍÓÚÇÃÔ/]+)*?)\s+"
        r"(?:RURAL|CNPJ|Insc|CLIENTE|TENS[ÃA]O|LIGAÇ|LIGAC|Nota|\n)",
        texto
    )
    if m:
        v = m.group(1).strip()
        if v and len(v) >= 3:
            return v
    # Fallback: 'CLASSE:' isolado
    m = re.search(r"\bCLASSE\s*:\s*([A-ZÁÉÍÓÚÇÃÔ ]+?)(?:\s{2,}|\n|/)", texto)
    if m:
        v = m.group(1).strip()
        if v and len(v) >= 3:
            return v
    return ""


_RAZAO_LIXO_PALAVRAS = {
    "ENDERECO", "ENDEREÇO", "ENDEREGO", "ENDERESO",  # variações OCR
    "UNIDADE", "CONSUMIDORA", "CONSUMIDOR",
    "DOMICILIO", "DOMICÍLIO",
    "INSTALACAO", "INSTALAÇÃO",
    "CODIGO", "CÓDIGO",
    "RUA", "AVENIDA", "AV.", "ESTRADA", "RODOVIA", "TRAVESSA",
    "CEP", "BAIRRO", "QUADRA", "LOTE", "FAZENDA", "SITIO", "KM",
    "REFERENCIA", "REFERÊNCIA",
}


def _eh_nome_valido(nome: str) -> bool:
    """Valida se string parece nome de cliente (razão social ou pessoa física)."""
    if not nome or len(nome.strip()) < 4:
        return False
    up = nome.upper().strip()
    # Tem dígito? Não é nome
    if re.search(r"\d", up):
        return False
    # Contém palavra-lixo? Não é nome
    for lx in _RAZAO_LIXO_PALAVRAS:
        if lx in up:
            return False
    return True


def extrair_nome_cliente_pagador(texto: str) -> str:
    """Captura nome do cliente do bloco PAGADOR (boleto) ou da 1ª linha do PDF.

    Validação SEMÂNTICA: rejeita strings que contenham palavras de label do PDF
    (ENDEREÇO/RUA/UNIDADE/CEP/etc.) — em vez de enumerar variações de blacklist.
    """
    if not texto:
        return ""

    # Pattern 1: bloco PAGADOR do boleto
    # 'PAGADOR CPF/CNPJ\n{NOME} {CNPJ}\n{endereço}'
    m = re.search(
        r"PAGADOR\s+CPF/CNPJ\s*\n([A-ZÁÉÍÓÚÇ&][A-ZÁÉÍÓÚÇ& /\.\-]{4,80}?)\s+"
        r"\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}",
        texto
    )
    if m:
        nome = m.group(1).strip().rstrip(".,-")
        if _eh_nome_valido(nome):
            return nome

    # Pattern 2: primeira linha do PDF antes de "ENDEREÇO DA UNIDADE CONSUMIDORA"
    # Aceita variações OCR (ENDEREGO/ENDERESO/ENDERECO sem cedilha)
    m = re.match(
        r"\s*([A-ZÁÉÍÓÚÇ&][A-ZÁÉÍÓÚÇ& /\.\-]{4,80}?)\s*\n\s*ENDERE[ÇCGS]O",
        texto
    )
    if m:
        nome = m.group(1).strip().rstrip(".,-")
        if _eh_nome_valido(nome):
            return nome

    # Pattern 3: termina em LTDA/S.A./EIRELI/etc. — alta confiança
    m = re.search(
        r"\b([A-ZÁÉÍÓÚÇ&][A-ZÁÉÍÓÚÇ& /\.\-]{4,80}?\s+"
        r"(?:LTDA|S\.?A\.?|EIRELI|ME|EPP|S/A|S\.A\.|COOPERATIVA|ASSOCIACAO|ASSOCIAÇÃO))\b",
        texto, re.IGNORECASE
    )
    if m:
        nome = m.group(1).strip().rstrip(".,-").upper()
        if _eh_nome_valido(nome):
            return nome

    return ""


def extrair_demanda_contratada_universal(texto: str) -> dict:
    """Captura demanda contratada (kW) ponta e fora ponta — Grupo A.

    Layouts conhecidos:
      Energisa MT/MS:   'Demanda fora ponta - kW 1100' / 'Demanda ponta - kW 350' / 'Ponta:1100 TUSDG:'
      Equatorial GO:    'DEMANDA - kW 100' (THS Verde - 1 valor único)
      Enel SP/Light:    'Demanda contratada: X kW' (ainda não calibrado)

    Retorna {ponta: float|None, fponta: float|None}.
    """
    out = {"ponta": None, "fponta": None}
    if not texto:
        return out

    # Pattern Energisa: 'Demanda fora ponta - kW 1100' (FP) e 'Demanda ponta - kW 350' (P)
    m = re.search(r"Demanda\s+fora\s+ponta\s*-\s*kW\s+(\d{1,5}(?:[\.,]\d{1,2})?)", texto, re.I)
    if m:
        try: out["fponta"] = float(m.group(1).replace(".", "").replace(",", "."))
        except: pass
    m = re.search(r"Demanda\s+ponta\s*-\s*kW\s+(\d{1,5}(?:[\.,]\d{1,2})?)(?:\s|\n|$)", texto, re.I)
    if m:
        try: out["ponta"] = float(m.group(1).replace(".", "").replace(",", "."))
        except: pass

    # Pattern Energisa alternativo (rodapé invertido): 'Ponta:1100 TUSDG:' ou 'onta:N' (texto truncado)
    if out["fponta"] is None:
        m = re.search(r"(?:[Pp]|^|\s)onta\s*:\s*(\d{1,5})\s+TUSDG", texto)
        if m:
            try: out["fponta"] = float(m.group(1))
            except: pass

    # Pattern Equatorial Goiás THS Verde: 'DEMANDA - kW 100' (modalidade Verde tem 1 demanda)
    if out["fponta"] is None and out["ponta"] is None:
        m = re.search(r"DEMANDA\s*-\s*kW\s+(\d{1,5}(?:[\.,]\d{1,2})?)\b", texto)
        if m:
            try:
                v = float(m.group(1).replace(".", "").replace(",", "."))
                # Modalidade Verde: 1 demanda só → pra fora ponta (convenção)
                out["fponta"] = v
            except: pass

    return out


def extrair_bandeira_tarifaria(texto: str) -> dict:
    """Captura bandeira tarifária universal + valor R$ quando disponível.

    Layouts vistos:
      - Enel SP: 'Bandeira(s) tarifária(s) aplicada(s) no mês: VERDE'
      - Enel RJ: 'Periodos: Band. Tarif.: Verde : 13/03 - 11/04'
      - Light:   'BandeiraTarifaria Vermelha P2:10/09-30/09'
      - CPFL:    'Bandeira Verde'
      - Elektro: 'BandeiraTarifaria Vermelha P2:10/09-30/09 Vermelha P1:01/10-08/10'
      - Energisa MT antigo: 'Adic. B. Amarela 148,30 ...' / 'AD.B.VERM2'
      - CCI Energisa: '0698 ADICIONAL BAND. AMARELA 158,40'

    Retorna {bandeira, bandeira_periodo_inicio?, bandeira_periodo_fim?, valor_bandeira?}.
    """
    out = {}
    # Pattern principal — "Bandeira ... VERDE/AMARELA/VERMELHA"
    m = re.search(
        r"Bandeira[^\n]*?(?::|tarif[aá]ri[ao]?\s*[:.]?)?\s+(VERDE|AZUL|AMAR[EÉ]LA|VERMELHA|BRANCA)\b",
        texto, re.I
    )
    if m:
        out["bandeira"] = m.group(1).upper().replace("É", "E")

    # Pattern Energisa MT antigo: 'Adic. B. Amarela 148,30' / 'AD.B.VERM2 216,33'
    # Captura nome da bandeira + valor R$
    if not out.get("bandeira"):
        m = re.search(
            r"(?:Adic\.?\s*B\.?|AD\.B\.|ADICIONAL\s+BAND[A-Z\.]*)\s*(Amarela|Verde|Vermelha|VERM(?:\d|ELHA)?|AMARELA|VERDE|ESCASS[A-Z]*)",
            texto, re.I
        )
        if m:
            cor = m.group(1).upper()
            # Normaliza VERM/VERM1/VERM2 → VERMELHA
            if cor.startswith("VERM"): cor = "VERMELHA"
            elif "ESCASS" in cor:      cor = "ESCASSEZ_HIDRICA"
            out["bandeira"] = cor

    # Pattern CCI 0698 (Energisa antigo): '0698 ADICIONAL BAND. AMARELA ... 148,30 ... 158,40'
    if not out.get("bandeira"):
        m = re.search(
            r"\b0698\s+ADIC[A-Z\.]+\s+BAND[A-Z\.]+\s*(AMARELA|VERDE|VERMELHA|ESCASS[A-Z]*)",
            texto, re.I
        )
        if m:
            cor = m.group(1).upper()
            if "ESCASS" in cor: cor = "ESCASSEZ_HIDRICA"
            out["bandeira"] = cor

    # Captura valor R$ da bandeira (várias linhas possíveis)
    # Soma valores de TODAS as linhas 'Adic. B. *' / 'AD.B.VERM*' / 'ADICIONAL BAND'
    valores_bandeira = []
    for m in re.finditer(
        r"(?:Adic\.?\s*B\.?|AD\.B\.|ADICIONAL\s+BAND)[A-Z\d\.\s]*?\s+(\d{1,3}(?:\.\d{3})*,\d{2})",
        texto, re.I
    ):
        try:
            v = float(m.group(1).replace(".", "").replace(",", "."))
            valores_bandeira.append(v)
        except: pass
    if valores_bandeira:
        out["valor_bandeira"] = sum(valores_bandeira)

    # Período da bandeira (Enel RJ)
    m = re.search(
        r"Band[\.\s]+Tarif[\.\s]+[A-Za-zÀ-ÿ]+\s*:\s*(\d{2}/\d{2})\s*-\s*(\d{2}/\d{2})",
        texto, re.I
    )
    if m:
        out["bandeira_periodo_inicio"] = m.group(1)
        out["bandeira_periodo_fim"] = m.group(2)
    return out


def extrair_periodo_leitura_universal(texto: str) -> dict:
    """Captura período de leitura universal: 'leit_ant leit_atual dias prox_leit'.

    Aceita DD/MM/AAAA (Enel/Light/Energisa) e DD/MM (CEMIG).
    """
    out = {}
    # 4 datas seguidas: anterior + atual + dias + próxima
    m = re.search(
        r"(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+(\d{1,3})\s+(\d{2}/\d{2}/\d{4})",
        texto
    )
    if m:
        out["leitura_anterior"] = m.group(1)
        out["leitura_atual"] = m.group(2)
        out["dias_consumo"] = m.group(3)
        out["proxima_leitura"] = m.group(4)
        return out
    # CEMIG format: 'Anterior Atual Nº de dias Próxima\n31/07 31/08 31 30/09'
    m = re.search(
        r"(\d{2}/\d{2})\s+(\d{2}/\d{2})\s+(\d{1,3})\s+(\d{2}/\d{2})\b",
        texto
    )
    if m:
        out["leitura_anterior"] = m.group(1)
        out["leitura_atual"] = m.group(2)
        out["dias_consumo"] = m.group(3)
        out["proxima_leitura"] = m.group(4)
        out["_formato"] = "DD/MM_sem_ano"
        return out
    return out


def extrair_chave_nf3e_do_qrcode(pdf_path: str) -> str:
    """Lê QR Code do PDF e extrai chave NF3e. Usado quando plumber tem (cid:xxx)."""
    if not pdf_path: return ""
    try:
        import fitz, cv2, numpy as np
    except ImportError:
        return ""
    try:
        doc = fitz.open(pdf_path)
    except Exception:
        return ""
    detector = cv2.QRCodeDetector()
    for page in doc:
        try:
            pix = page.get_pixmap(dpi=300)
            img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            if pix.n == 4: img = cv2.cvtColor(img, cv2.COLOR_RGBA2BGR)
            elif pix.n == 3: img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
            ok, dados, _, _ = detector.detectAndDecodeMulti(img)
            candidatos = list(dados) if ok else []
            d_single, _, _ = detector.detectAndDecode(img)
            if d_single: candidatos.append(d_single)
            for conteudo in candidatos:
                if not conteudo: continue
                m = re.search(r"chNF3e=(\d{44})", conteudo)
                if m: return m.group(1)
                m = re.search(r"(?<!\d)(\d{44})(?!\d)", conteudo)
                if m: return m.group(1)
        except Exception:
            continue
    return ""


def extrair_chave_nf3e_do_texto(texto: str) -> str:
    """Detecta chave NF3e de 44 dígitos no texto.

    Tenta 3 formatos:
      1. URL: 'chNF3e=NNNNNNNNNN...'
      2. Formato impresso: '3326 0433 0500 ... 0115' (4-em-4, 11 grupos)
      3. 44 dígitos puros adjacentes
    Retorna string vazia se não achar.
    """
    if not texto: return ""
    # 1. URL SEFAZ
    m = re.search(r"chNF3e=(\d{44})", texto, re.I)
    if m: return m.group(1)
    # 2. Formato impresso 4-em-4 (11 grupos de 4 dígitos)
    # Usa lookahead pra capturar overlapping (lidar com lixo concatenado antes da chave).
    # Valida UF (11-53) + ano+mês (YYMM 2001-9912) pra rejeitar matches inválidos.
    for raw in re.findall(r"(?=(\d{4}\s+\d{4}\s+\d{4}\s+\d{4}\s+\d{4}\s+\d{4}\s+\d{4}\s+\d{4}\s+\d{4}\s+\d{4}\s+\d{4}))", texto):
        chave = re.sub(r"\s+", "", raw)
        if len(chave) == 44 and chave.isdigit():
            try:
                uf = int(chave[:2])
                ano_mes = int(chave[2:6])
                if 11 <= uf <= 53 and 2001 <= ano_mes <= 9912:
                    return chave
            except ValueError:
                continue
    # 3. Pattern Energisa: 'chave acesso: NNNNN...NNNN' (em qualquer formato)
    m = re.search(r"chave\s+de\s+acesso\s*:?\s*\n?\s*((?:\d{4}\s*){10}\d{4})", texto, re.I)
    if m:
        chave = re.sub(r"\s+", "", m.group(1))
        if len(chave) == 44:
            return chave
    # 4. 44 dígitos puros (com lookbehind/lookahead pra não pegar mais que 44)
    m = re.search(r"(?<!\d)(\d{44})(?!\d)", texto)
    if m: return m.group(1)
    return ""


def extrair_itens_encargos_sem_qtd(texto: str) -> list:
    """Pattern pra encargos sem quantidade/tarifa (CIP, COSIP, Iluminação Pública).

    Layout Enel: 'CIP - ILUM PUB PREF MUNICIPAL 145,90 0,00 0,00 0,00% 0,00 I CMS ...'
    Layout CEMIG: 'Contrib Ilum Publica Municipal 56,66'
    """
    out = []
    # Padrão completo Enel: DESC valor pis_cofins base_icms aliq_icms% icms_valor
    pat = re.compile(
        r"(CIP\s*[-–]?\s*[A-ZÀ-Ÿ\s\.]+?|COSIP\s+[A-ZÀ-Ÿ\s\.]+?|CONTRIB\s+ILUM[A-ZÀ-Ÿ\s\.]+?|ILUM[\.\s]+P[UÚ]B[A-ZÀ-Ÿ\s\.]+?)"
        r"\s+([\d\.]+,\d{2})\s+([\d\.]+,\d{2})\s+([\d\.]+,\d{2})\s+([\d,]+%?)\s+([\d\.]+,\d{2})",
        re.I
    )
    for m in pat.finditer(texto):
        desc = m.group(1).strip()
        # Limpa lixo no final tipo "I CMS" ou repetição
        desc = re.sub(r"\s+I\s*CMS\s*$", "", desc).strip()
        valor_str = m.group(2)
        try: valor_num = float(valor_str.replace(".", "").replace(",", "."))
        except: valor_num = None
        out.append({
            "descricao": desc,
            "unidade": None,
            "posto": None,
            "eh_credito_gd": False,
            "quantidade_string": None, "quantidade_numerica": None,
            "tarifa_unit_string": None, "tarifa_unit_numerica": None,
            "valor_brl_string": valor_str,
            "valor_brl_numerico": valor_num,
            "pis_cofins_brl_string": m.group(3),
            "icms_base_string": m.group(4),
            "icms_aliquota_pct": m.group(5),
            "icms_valor_string": m.group(6),
            "_fonte": "encargo_sem_qtd",
        })
    # Pattern simples (CEMIG): só DESC + valor
    pat_simple = re.compile(
        r"^(Contrib\s+Ilum[a-záàâãéè\s]+|CIP\s+[A-ZÀ-Ÿ\s]+?)\s+([\d\.]+,\d{2})\s*$",
        re.M | re.I
    )
    for m in pat_simple.finditer(texto):
        desc = m.group(1).strip()
        if any(d["descricao"].upper().startswith(desc.upper()[:10]) for d in out): continue
        valor_str = m.group(2)
        try: valor_num = float(valor_str.replace(".", "").replace(",", "."))
        except: valor_num = None
        out.append({
            "descricao": desc,
            "unidade": None, "posto": None, "eh_credito_gd": False,
            "quantidade_string": None, "quantidade_numerica": None,
            "tarifa_unit_string": None, "tarifa_unit_numerica": None,
            "valor_brl_string": valor_str, "valor_brl_numerico": valor_num,
            "_fonte": "encargo_sem_qtd_simples",
        })
    return out


def extrair_itens_debitos_cemig(texto: str) -> list:
    """CEMIG: linhas de DÉBITO/encargo no bloco 'Itens da Fatura' que são só TEXTO + VALOR
    (sem qtd/tarifa) e o regex base de item ignora → soma_itens fica < total.

    Ex (todas terminam em valor BR de 2 casas no fim da linha):
      'Cobrança da Conta de Energia de 12 / 2023 43,06'
      'Multa 2% sobre conta de 11/2023 14,46'
      'Juros 1%am sobre conta 11/23 pg 05/01/24 0,72'
      'Correção IPCA/IGPM s/ conta 11/23 pg 05/01/24 0,20'
    NÃO casa itens colunares (terminam em tarifa 0,00000000) nem a linha TOTAL.
    """
    out = []
    pat = re.compile(
        r"^((?:Cobran[çc]a\s+da\s+Conta|Multa\b|Juros\b|Corre[çc][ãa]o\b|"
        r"Parcela(?:mento)?\b|Devolu[çc][ãa]o\b|Compensa[çc][ãa]o\b|Ressarcimento\b)[^\n]*?)"
        r"\s+(-?\d{1,3}(?:\.\d{3})*,\d{2})\s*$",
        re.M | re.I,
    )
    for m in pat.finditer(texto):
        desc = m.group(1).strip()
        if "TOTAL" in desc.upper() or len(desc) < 5:
            continue
        vs = m.group(2)
        try:
            vn = float(vs.replace(".", "").replace(",", "."))
        except ValueError:
            continue
        out.append({
            "descricao": desc, "unidade": None, "posto": None, "eh_credito_gd": False,
            "quantidade_string": None, "quantidade_numerica": None,
            "tarifa_unit_string": None, "tarifa_unit_numerica": None,
            "valor_brl_string": vs, "valor_brl_numerico": vn,
            "_fonte": "debito_cemig",
        })
    return out


def extrair_tributos_light(texto: str) -> dict:
    """Extrai PIS+COFINS, ICMS-ST de fatura Light.

    Layouts típicos:
      - 'TOTAL 0,00 2.146,55 515,17' (PIS+COFINS total, base ICMS, ICMS valor)
      - 'Art. 3º-A do Dec. nº 46.196/17: BC: R$ 2146.55 Alíquota 24% ICMS ST: R$ 515.17'
    """
    out = {}
    # ICMS ST via Art. 3º-A (RJ)
    m = re.search(
        r"Art\.\s*3º?-?A[^\n]*?BC:\s*R\$\s*([\d.,]+)\s*Al[íi]quota\s+(\d+)%?\s+ICMS\s+ST:\s*R\$\s*([\d.,]+)",
        texto, re.I
    )
    if m:
        out["icms"] = {
            "base_string": m.group(1).replace(".", ",") if "," not in m.group(1) else m.group(1),
            "aliquota_pct": f"{m.group(2)},00",
            "valor_string": m.group(3).replace(".", ",") if "," not in m.group(3) else m.group(3),
            "tipo": "ICMS_ST",
            "_fonte": "regex_light_art3A",
        }
    # Fallback: linha TOTAL <pis_cofins> <icms_base> <icms_valor>
    if "icms" not in out:
        m = re.search(r"\bTOTAL\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})", texto)
        if m:
            out["pis_cofins"] = {"valor_string": m.group(1), "_fonte": "regex_light_total"}
            out["icms"] = {
                "base_string": m.group(2),
                "valor_string": m.group(3),
                "_fonte": "regex_light_total",
            }
    return out


def extrair_tributos_enel(texto: str) -> dict:
    """Extrai PIS/PASEP e COFINS separados no Enel/Ampla.

    Layout: 'PIS/PASEP 1.027,95 1,23 12,66' e 'COFINS 1.027,95 5,68 58,41'
    (em linhas separadas ou na mesma linha, em qualquer ordem)
    """
    out = {}
    # PIS/PASEP: base alíq% valor
    m = re.search(
        r"PIS[/\\]?\s*PASEP\s+([\d\.]+,\d{2})\s+([\d,]+)\s+([\d\.]+,\d{2})",
        texto, re.I
    )
    if m:
        out["pis"] = {
            "base_string": m.group(1),
            "aliquota_pct": m.group(2),
            "valor_string": m.group(3),
            "_fonte": "regex_enel_separado",
        }
    # COFINS: base alíq% valor
    m = re.search(
        r"\bCOFINS\s+([\d\.]+,\d{2})\s+([\d,]+)\s+([\d\.]+,\d{2})",
        texto, re.I
    )
    if m:
        out["cofins"] = {
            "base_string": m.group(1),
            "aliquota_pct": m.group(2),
            "valor_string": m.group(3),
            "_fonte": "regex_enel_separado",
        }
    return out


def extrair_tributos_edp_es(texto: str) -> dict:
    """Extrai PIS/COFINS/ICMS de fatura EDP Espírito Santo (layout NF simples).

    Formato exclusivo ES: 'LABEL BASE X ALIQ% = VALOR'
      PIS    8.899,13 X 0,28%  = 24,92
      COFINS 8.899,13 X 1,29%  = 114,80
      ICMS   11.865,50 X 25,00% = 2.966,37
    (distinto do EDP SP, que usa colunas com CCI). Só casa neste formato — seguro.
    """
    out = {}
    for label, key in (("PIS", "pis"), ("COFINS", "cofins"), ("ICMS", "icms")):
        m = re.search(
            rf"\b{label}\s+([\d.]+,\d{{2}})\s*X\s*([\d,]+)\s*%\s*=\s*([\d.]+,\d{{2}})",
            texto, re.I,
        )
        if m:
            out[key] = {
                "base_string": m.group(1),
                "aliquota_pct": m.group(2),
                "valor_string": m.group(3),
                "_fonte": "regex_edp_es",
            }
    return out


_MESES_EDP = {"janeiro":"01","fevereiro":"02","marco":"03","março":"03","abril":"04",
              "maio":"05","junho":"06","julho":"07","agosto":"08","setembro":"09",
              "outubro":"10","novembro":"11","dezembro":"12"}

def eh_edp_es(texto: str) -> bool:
    return bool(re.search(r"EDP\s+ESP[IÍ]RITO\s+SANTO", texto or "", re.I))

def extrair_edp_es_campos(texto: str) -> dict:
    """Extrai todos os campos do layout EDP Espírito Santo (NF/Conta simples).

    Layout distinto do EDP SP: sem CCI codes, sem chave 44d, tributos 'BASE X ALIQ% = VALOR'.
    Retorna dict achatado consumido por aplicar_complementos.
    """
    out = {}
    t = texto or ""

    # Distribuidora (corrige o hardcode que marca como EDP SP)
    out["dist_razao"] = "EDP ESPIRITO SANTO DISTRIBUIÇÃO DE ENERGIA S.A"
    out["dist_uf"] = "ES"
    m = re.search(r"CNPJ\s+(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2})", t)
    if m: out["dist_cnpj"] = m.group(1)

    # Cliente: linha após "Número da Instalação" — "RAZAO ... <num_instalacao>"
    m = re.search(r"N[úu]mero da Instala[çc][ãa]o\s*\n([A-Z][^\n]+?)\s+(\d{5,})\s*\n", t, re.I)
    if m:
        razao = m.group(1).strip()
        # nome vem repetido ("VIA VAREJO S A VAREJO S A VAREJO S/A") — normaliza
        if "VIA VAREJO" in razao.upper():
            razao = "VIA VAREJO S/A"
        out["cli_razao"] = razao
        out["num_instalacao"] = m.group(2)

    # CNPJ cliente sem máscara: "CNPJ/CPF/CI: 33041260183498"
    m = re.search(r"CNPJ/CPF/CI:\s*(\d{14})", t, re.I)
    if m:
        d = m.group(1)
        out["cli_cnpj"] = f"{d[:2]}.{d[2:5]}.{d[5:8]}/{d[8:12]}-{d[12:]}"

    # Classificação: "GRUPO/SUBGRUPO: B - B3 CLASSE/SUBCLASSE: COMERCIAL"
    m = re.search(r"GRUPO/SUBGRUPO:\s*([AB])\s*-\s*([AB]\d)\s+CLASSE/SUBCLASSE:\s*([A-ZÀ-Ú]+)", t, re.I)
    if m:
        out["grupo"] = m.group(1).upper()
        out["subgrupo"] = m.group(2).upper()
        out["classe"] = m.group(3).strip()
    m = re.search(r"MODALIDADE TARIF[ÁA]RIA:\s*([A-ZÀ-Ú]+)", t, re.I)
    if m: out["modalidade"] = m.group(1).strip()
    m = re.search(r"TP FORNECIMENTO:\s*([A-ZÀ-Ú]+)", t, re.I)
    if m: out["tipo_forn"] = m.group(1).strip()
    m = re.search(r"TENS[ÃA]O NOMINAL:\s*([\d/\s]+V)", t, re.I)
    if m: out["tensao"] = re.sub(r"\s+", " ", m.group(1).strip())

    # Mês ref: "Conta do Mês ... Janeiro/2020"
    m = re.search(r"(Janeiro|Fevereiro|Mar[çc]o|Abril|Maio|Junho|Julho|Agosto|Setembro|Outubro|Novembro|Dezembro)/(\d{4})", t, re.I)
    if m:
        out["mes_ref"] = f"{_MESES_EDP.get(m.group(1).lower(),'??')}/{m.group(2)}"

    # Vencimento: "...SEGUNDA-VIA 28/01/2020" ou "Data de Vencimento ... DD/MM/AAAA"
    m = re.search(r"SEGUNDA-VIA\s+(\d{2}/\d{2}/\d{4})", t, re.I) or \
        re.search(r"Data de Vencimento[\s\S]{0,80}?(\d{2}/\d{2}/\d{4})", t, re.I)
    if m: out["vencimento"] = m.group(1)

    # Datas de leitura + dias
    m = re.search(r"Emiss[ãa]o\s+(\d{2}/\d{2}/\d{4})", t, re.I)
    if m: out["data_emissao"] = m.group(1)
    m = re.search(r"Leitura anterior\s+(\d{2}/\d{2}/\d{4})", t, re.I)
    if m: out["leit_ant_data"] = m.group(1)
    m = re.search(r"Leitura atual\s+(\d{2}/\d{2}/\d{4})", t, re.I)
    if m: out["leit_atu_data"] = m.group(1)
    m = re.search(r"N[°º] dias Fat\.\s+(\d{1,3})", t, re.I)
    if m: out["dias"] = int(m.group(1))

    # Medição: "Ativo ECY09296 40.032 56.276 1,00000 16.244,00"
    m = re.search(r"Ativo\s+([A-Z0-9]+)\s+([\d.]+)\s+([\d.]+)\s+([\d,]+)\s+([\d.]+,\d{2})", t, re.I)
    if m:
        out["medidor"] = m.group(1)
        out["leit_ant"] = m.group(2)
        out["leit_atu"] = m.group(3)
        out["constante"] = m.group(4)
        out["kwh_mes"] = m.group(5)

    # Valor total: "Valor Total a Pagar" seguido de "R$ 11.909,48"
    m = re.search(r"Valor Total a Pagar[\s\S]{0,80}?R\$\s*([\d.]+,\d{2})", t, re.I)
    if m: out["valor_total"] = m.group(1)

    # Consumo/tarifa: "Consumo 16.244,00 KWH 0,52581000 8.541,25"
    m = re.search(r"\bConsumo\s+([\d.]+,\d{2})\s+KWH\s+([\d,]+)\s+([\d.]+,\d{2})", t, re.I)
    if m:
        out["consumo_kwh"] = m.group(1)
        out["tarifa_kwh"] = m.group(2)
        out["consumo_rs"] = m.group(3)

    # CIP
    m = re.search(r"Ilum\.\s*P[úu]blica[^\n]*?([\d.]+,\d{2})", t, re.I)
    if m: out["cip"] = m.group(1)

    return out


def enriquecer_itens_com_tarifa_aneel(itens: list) -> list:
    """Pra itens já extraídos, garante que 'tarifa_unit_aneel' existe.

    Pattern padrão Energisa: tarifa SEM TRIBUTOS é a última col antes do 'PIS X,XX X,XX'.
    Já capturada em 'tarifa_unit_string' por extrair_itens_linha_a_linha (grupo 9 do pattern[0]),
    mas pode estar None se não houver. Esta função renomeia/adiciona alias.
    """
    for it in itens:
        # Se já veio do regex (pattern[0] grupo 10), priorizar
        if it.get("tarifa_unit_aneel_string"):
            it["tarifa_unit_aneel"] = it["tarifa_unit_aneel_string"]
            continue
        # Fallback: copia da tarifa com tributos (quando layout não tem col separada)
        if "tarifa_unit_aneel" not in it:
            it["tarifa_unit_aneel"] = it.get("tarifa_unit_string")
            it["tarifa_unit_aneel_numerica"] = it.get("tarifa_unit_numerica")
            it["_tarifa_aneel_fonte"] = "fallback_tarifa_com_tributos"
    return itens


# ────────────────────────────────────────────────────────────────────────
# 9. COFINS — estimado por proporção quando só PIS é detectado
# ────────────────────────────────────────────────────────────────────────
# Alíquotas regulamentadas:
#   PIS:    0,65% (cumulativo) ou 1,65% (não-cumulativo)
#   COFINS: 3,00% (cumulativo) ou 7,60% (não-cumulativo)
# Em distribuidoras de energia (REGIME NÃO-CUMULATIVO geralmente):
#   PIS aliq efetiva (após créditos) ~ 0,8-1,3%
#   COFINS aliq efetiva ~ 3,8-5,7%
#   Razão típica: COFINS / PIS ~ 4,6x

def estimar_cofins_do_pis(pis_aliq: float, pis_valor: float) -> dict:
    """Quando regex pegou só PIS, estima COFINS por proporção típica.

    Returns {aliquota_pct, valor, _estimado: True}
    """
    if not pis_aliq or not pis_valor: return None
    # Razão padrão Energisa: COFINS = PIS × 4,604 (0,4683 / 0,1017)
    aliq_cof = pis_aliq * 4.604
    val_cof = pis_valor * 4.604
    return {
        "aliquota_pct": f"{aliq_cof:.4f}".replace(".", ","),
        "valor": f"{val_cof:.2f}".replace(".", ","),
        "_fonte": "estimado_proporcao_pis",
    }


# ────────────────────────────────────────────────────────────────────────
# 10. ⚡ CRÍTICO: distinguir mUC (mesma UC) vs oUC (outra UC/geradora)
# ────────────────────────────────────────────────────────────────────────
# Definição (ANEEL/REN 1.000/2021):
#   mUC = "minha UC" — compensação do próprio saldo histórico (carry-over)
#         Significa que o saldo de energia injetada de períodos anteriores
#         pela própria UC está sendo usado para compensar o consumo atual.
#   oUC = "outra UC" — créditos recebidos de geradora ou outra unidade do grupo
#         Sinaliza ENTRADA de crédito de geradora externa para a UC consumidora.
#
# Importância de auditoria:
#   - Se UC é beneficiária de geradora MAS fatura só tem mUC (sem oUC),
#     significa que a geradora NÃO ESTÁ INJETANDO/REPASSANDO créditos no ciclo
#     → ALERTA de irregularidade.

def classificar_mUC_oUC(texto: str, itens: list) -> dict:
    """Identifica e categoriza créditos GD por origem (própria vs outra UC).

    Retorna:
      {
        "compensacao_propria_mUC": [{tipo, data_origem, posto, ...}, ...],
        "creditos_de_outras_ucs_oUC": [{tipo, data_origem, posto, ...}, ...],
        "tem_oUC": bool,  # se há entrada de geradora
        "tem_mUC": bool,  # se está usando saldo próprio
        "alerta_sem_oUC": bool,  # ALERTA: nenhuma entrada de geradora
      }
    """
    propria = []
    outras = []

    # Patterns:
    # 1) "GDI mUC MM/AAAA oPT/mPT" → mUC (mesma UC)
    # 2) "GDI oUC MM/AAAA oPT/mPT" → oUC (outra UC)
    # 3) Layouts variantes: "OUC MPT TE MM/AAAA" → oUC (Elektro/COPEL)
    #    "MUC MPT MM/AAAA" → mUC
    for m in re.finditer(r"\b(m|o)UC\s+(\d{1,2}/\d{4})\s+(oPT|mPT|OPT|MPT)\b", texto, re.I):
        origem = m.group(1).lower()  # 'm' ou 'o'
        data = m.group(2)
        posto_raw = m.group(3).upper()
        posto = "Ponta" if posto_raw in ("OPT",) else "Fora Ponta" if posto_raw in ("MPT",) else None
        # Distingue oPT/OPT (Posto Original = posto base) vs mPT/MPT (Posto Modificado/Fora Ponta)
        # ANEEL: oPT = original posto (Ponta), mPT = modificado posto (Fora Ponta) na convencional
        entry = {"tipo": "oPT" if posto_raw.lower() == "opt" else "mPT",
                 "data_origem": data, "posto": posto}
        if origem == "m":
            propria.append(entry)
        else:
            outras.append(entry)

    # Layout Elektro/COPEL: 'oUC MPT TE 02/2026'
    for m in re.finditer(
        r"\b(m|o)UC\s+(mPT|oPT|MPT|OPT)\s+(?:TE|TUSD|TUSDG)?\s*(\d{1,2}/\d{4})\b",
        texto, re.I
    ):
        origem = m.group(1).lower()
        posto_raw = m.group(2).upper()
        data = m.group(3)
        posto = "Ponta" if posto_raw == "OPT" else "Fora Ponta" if posto_raw == "MPT" else None
        entry = {"tipo": "oPT" if posto_raw.lower() == "opt" else "mPT",
                 "data_origem": data, "posto": posto, "_layout": "elektro_copel"}
        # Evita duplicar se já está em propria/outras
        key = (entry["tipo"], entry["data_origem"], entry["posto"])
        existing = propria if origem == "m" else outras
        if not any((e["tipo"], e["data_origem"], e["posto"]) == key for e in existing):
            existing.append(entry)

    # Deduplica
    def _uniq(lst):
        seen = set(); out = []
        for e in lst:
            k = (e["tipo"], e["data_origem"], e.get("posto"))
            if k not in seen:
                seen.add(k); out.append(e)
        return out

    propria = _uniq(propria)
    outras = _uniq(outras)

    tem_mUC = len(propria) > 0
    tem_oUC = len(outras) > 0

    # Tem GD ativa? (texto OU itens)
    tem_gd_ativa = bool(
        re.search(r"GD_?I{1,3}|SCEE|Energia\s+(?:Injetada|Compensada|Atv\s+Injet)|Lei\s+14\.300|Minigera|Microgera", texto, re.I)
    ) or any(
        it.get("eh_credito_gd") or
        re.search(r"GDI|INJETAD|COMPENS|SCEE", str(it.get("descricao", "")), re.I)
        for it in (itens or [])
    )

    # ALERTA: GD ativa, tem mUC, mas SEM oUC → geradora não está injetando
    alerta_sem_oUC = bool(tem_gd_ativa and tem_mUC and not tem_oUC)

    return {
        "compensacao_propria_mUC": propria,
        "creditos_de_outras_ucs_oUC": outras,
        "tem_mUC": tem_mUC,
        "tem_oUC": tem_oUC,
        "alerta_sem_oUC": alerta_sem_oUC,
        "_obs_alerta_sem_oUC": (
            "GD ativa com compensação de saldo próprio (mUC) mas SEM entrada "
            "de geradora (oUC) — verificar se geradora está injetando créditos"
            if alerta_sem_oUC else None
        ),
    }


# ────────────────────────────────────────────────────────────────────────
# 11. Histórico 13 meses — CONSUMO correto (não dias)
# ────────────────────────────────────────────────────────────────────────
def extrair_historico_consumo_energisa(texto: str) -> list:
    """Padrão Energisa (rodapé esquerdo da fatura):
       'ABR/26 2.553,25 280,00 178.017,00 889,00 ...'
       Colunas (variável por dist): MES/AA cons_p dem_p cons_fp dem_fp ere dre tusdg

    Retorna lista [{mes, ano, consumo_ponta_kwh, consumo_fponta_kwh, demanda_ponta_kw, demanda_fponta_kw}].
    """
    out = []
    def _to_float(s):
        try: return float(s.replace(".", "").replace(",", "."))
        except: return None

    # Pattern principal (4 colunas: cons_p dem_p cons_fp dem_fp) — usa [ \t]+ pra não pular linha
    pat = re.compile(
        r"(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/(\d{2})"
        r"[ \t]+([\d.,]+)[ \t]+([\d.,]+)[ \t]+([\d.,]+)[ \t]+([\d.,]+)",
        re.I
    )
    meses_capturados = set()
    for m in pat.finditer(texto):
        mes = m.group(1).upper()
        ano = int(m.group(2))
        chave = (mes, ano)
        if chave in meses_capturados: continue
        meses_capturados.add(chave)
        out.append({
            "mes": mes,
            "ano": 2000 + ano,
            "consumo_ponta_kwh": _to_float(m.group(3)),
            "demanda_ponta_kw": _to_float(m.group(4)),
            "consumo_fponta_kwh": _to_float(m.group(5)),
            "demanda_fponta_kw": _to_float(m.group(6)),
        })

    # Pattern fallback: linhas com menos colunas (FEV/26 0,00 0,00 / ABR/25 1.680,00 75.673,50)
    # EXIGE vírgula decimal BR (formato NNN,NN ou N.NNN,NN) pra evitar capturar números soltos
    # como dias de leitura ou DIC/FIC (ex: '29', '30') que aparecem misturados no text-layer.
    _NUM_BR = r"\d{1,3}(?:\.\d{3})*,\d{2}"
    pat_short = re.compile(
        r"(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/(\d{2})"
        rf"[ \t]+({_NUM_BR})(?:[ \t]+({_NUM_BR}))?[ \t]*(?:\n|$|\*)",
        re.I | re.M
    )
    for m in pat_short.finditer(texto):
        mes = m.group(1).upper()
        ano = int(m.group(2))
        chave = (mes, ano)
        if chave in meses_capturados: continue
        meses_capturados.add(chave)
        v1 = _to_float(m.group(3))
        v2 = _to_float(m.group(4)) if m.group(4) else None
        out.append({
            "mes": mes,
            "ano": 2000 + ano,
            "consumo_ponta_kwh": v1,
            "consumo_fponta_kwh": v2,
            "demanda_ponta_kw": None,
            "demanda_fponta_kw": None,
        })

    # Pattern Enel DANF3E (Ampla/RJ): 'ABR26 14526.00 30 LID' (sem barra, ponto US)
    # Pattern Enel SP:               'MAI/24 4.800,000 30 LID' (com barra, vírgula BR)
    # Ambos: aparecem no MEIO de linhas, sem âncora ^
    pat_enel = re.compile(
        r"\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/?(\d{2})"
        r"\s+([\d\.]+(?:,\d+)?)\s+(\d+)\s+(?:LID|EST|MED|NIM|MIN|EST\.)\b",
        re.I
    )

    # Pattern Elektro SP (formato inglês): 'OCT25 6080 29' sem unidade no fim
    pat_elektro = re.compile(
        r"\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})\s+(\d+)\s+(\d+)\b"
    )
    MES_EN = {"JAN":"JAN","FEB":"FEV","MAR":"MAR","APR":"ABR","MAY":"MAI","JUN":"JUN",
              "JUL":"JUL","AUG":"AGO","SEP":"SET","OCT":"OUT","NOV":"NOV","DEC":"DEZ"}
    for m in pat_elektro.finditer(texto):
        mes_en = m.group(1).upper()
        mes_pt = MES_EN.get(mes_en, mes_en)
        ano = int(m.group(2))
        chave = (mes_pt, ano)
        if chave in meses_capturados: continue
        meses_capturados.add(chave)
        try: consumo = float(m.group(3))
        except: consumo = None
        dias = int(m.group(4))
        out.append({
            "mes": mes_pt, "ano": 2000 + ano,
            "consumo_kwh": consumo, "dias_ciclo": dias,
            "consumo_ponta_kwh": None, "consumo_fponta_kwh": None,
            "demanda_ponta_kw": None, "demanda_fponta_kw": None,
            "_fonte": "elektro_inglês",
        })
    for m in pat_enel.finditer(texto):
        mes = m.group(1).upper()
        ano = int(m.group(2))
        chave = (mes, ano)
        if chave in meses_capturados: continue
        meses_capturados.add(chave)
        # Ampla: '14526.00' (US); SP: '4.800,000' (BR)
        consumo_str = m.group(3)
        try:
            if "," in consumo_str:
                consumo = float(consumo_str.replace(".", "").replace(",", "."))
            else:
                consumo = float(consumo_str)
        except: consumo = None
        dias = int(m.group(4))
        out.append({
            "mes": mes,
            "ano": 2000 + ano,
            "consumo_kwh": consumo,
            "dias_ciclo": dias,
            "consumo_ponta_kwh": None,
            "consumo_fponta_kwh": None,
            "demanda_ponta_kw": None,
            "demanda_fponta_kw": None,
            "_fonte": "enel_LID",
        })

    # Ordena cronologicamente decrescente (mais recente primeiro)
    MES_ORD = {"JAN":1,"FEV":2,"MAR":3,"ABR":4,"MAI":5,"JUN":6,"JUL":7,"AGO":8,"SET":9,"OUT":10,"NOV":11,"DEZ":12}
    out.sort(key=lambda h: (h["ano"], MES_ORD.get(h["mes"], 0)), reverse=True)
    return out


# ────────────────────────────────────────────────────────────────────────
# 12. Indicadores: DICRI, tensão contratada, limite adequado
# ────────────────────────────────────────────────────────────────────────
def extrair_indicadores_extra(texto: str) -> dict:
    """Indicadores que faltam: DICRI, DMIC, conjunto, tensão contratada, limite adequado."""
    out = {}

    # DICRI: 'DICRI 21,00' (pode ter só 1 valor, sem apurado/trim/anual)
    m = re.search(r"\bDICRI\s+([\d,]+(?:\.\d+)?)", texto, re.I)
    if m: out["dicri"] = m.group(1)

    # DMIC: 'DMIC 24,00 5,83' (fallback universal — antes só vinha via mapa Energisa)
    m = re.search(r"\bDMIC\s+([\d,]+(?:\.\d+)?)", texto, re.I)
    if m: out["dmic"] = m.group(1)

    # Conjunto elétrico: 'Conjunto: BOA ESPERANCA' — para em coluna de mês (DEZ/21), nº, ou newline
    m = re.search(
        r"\bConjunto\s*:?\s*([A-ZÀ-Ÿ][A-ZÀ-Ÿ\s\-]+?)"
        r"(?:\s+(?:\d|JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)|\s*\n|\s*Refer)",
        texto, re.I
    )
    if m:
        nome = m.group(1).strip()
        # Filtra cabeçalhos do plumber que casariam ("CONJUNTO ELÉTRICO" etc.)
        if (nome and len(nome) >= 3
            and not any(k in nome.upper() for k in ("ELÉTRICO", "ELETRICO", "ATUAL", "ANTERIOR"))):
            out["conjunto"] = nome

    # Tensão Contratada (V)
    m = re.search(r"Tens[ãa]o\s+Contratada\s*:?\s*(\d+)", texto, re.I)
    if m: out["tensao_contratada_v"] = m.group(1)

    # Limite Adequado: 'Limite Adequado: 32085 a 36225'
    m = re.search(r"Limite\s+Adequado\s*:?\s*(\d+)\s*a\s*(\d+)", texto, re.I)
    if m:
        out["limite_adequado_min_v"] = m.group(1)
        out["limite_adequado_max_v"] = m.group(2)

    return out


def _num_indicador(s: str):
    """Converte número de indicador BR/US p/ float. '4,00'→4.0, '1.35'→1.35, '999,00'→999.0."""
    s = (s or "").strip()
    if "," in s:
        s = s.replace(".", "").replace(",", ".")  # BR: vírgula decimal
    try:
        return float(s)
    except ValueError:
        return None


def extrair_indicadores_continuidade(texto: str) -> dict | None:
    """DIC/FIC/DMIC/DICRI ESTRUTURADO {indicador, apurado, limite, unidade} — pro Art. 300.

    Cristalizado do colab v2 (parse_indicadores, 2026-06-05). Varre linhas, captura as que
    têm sigla + número; EXCLUI cabeçalho/classificação tarifária (CLASSIFICA/TARIFA/
    CONSUMIDORA/CONTRATADO). apurado=1º nº após a sigla, limite=2º. unidade: FIC=vezes, resto=horas.
    Vai em _extras_dist.indicadores_continuidade. Substitui o antigo extrair_indicadores_extra
    (que só pegava DICRI/DMIC como string solta).
    """
    if not texto:
        return None
    out = {}
    for ln in texto.splitlines():
        line = ln.strip()
        up = line.upper()
        if not any(s in up for s in ("DIC", "FIC", "DMIC", "DICRI")):
            continue
        if "CLASSIFICA" in up or "TARIFA" in up or "CONSUMIDORA" in up or "CONTRATADO" in up:
            continue
        for sigla in ("DICRI", "DMIC", "DIC", "FIC"):
            m = re.search(rf"\b{sigla}\b[^\d-]{{0,30}}(-?\d+(?:[.,]\d+)?)", line, re.I)
            if not m:
                continue
            nums = re.findall(r"-?\d+(?:[.,]\d+)?", line[m.start():])
            apurado = _num_indicador(nums[0]) if nums else None
            if apurado is None:
                continue
            limite = _num_indicador(nums[1]) if len(nums) > 1 else None
            out.setdefault(sigla.lower(), []).append({
                "indicador": sigla, "apurado": apurado, "limite": limite,
                "unidade": "vezes" if sigla == "FIC" else "horas", "texto": line[:200],
            })
    return out or None


def extrair_bandeiras_periodo(texto: str) -> list | None:
    """Lista de bandeiras por período {cor, patamar, periodo, texto} — múltiplos meses na fatura.

    Cristalizado do colab v2 (parse_bandeiras). SÓ entra linha com COR (Verde/Amarela/Vermelha)
    E período/data (DD/MM ou MES/AA). Linha genérica de 'encargos setoriais...' NÃO vira bandeira.
    Complementa extrair_bandeira_tarifaria (que pega a bandeira principal p/ ligacao_tecnica).
    Vai em _extras_dist.bandeiras_periodo.
    """
    if not texto:
        return None
    patamar_re = re.compile(r"\b(Verde|Amarela|Vermelha)(?:\s*(?:P|Patamar)?\s*([12]))?\b", re.I)
    periodo_re = re.compile(
        r"\b\d{1,2}/\d{1,2}(?:\s*(?:a|-|até)\s*\d{1,2}/\d{1,2})?\b|"
        r"\b(?:JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)[A-Z]*/?\d{2,4}\b",
        re.I,
    )
    out, vistos = [], set()
    for ln in texto.splitlines():
        line = ln.strip()
        up = line.upper()
        # DESAMBIGUAÇÃO: exige rótulo BANDEIRA/BAND.TARIF — corta "Tarifa Verde"/"Horosazonal
        # Verde"/"Trifásico Verde FEV/22" (modalidade tarifária, não bandeira) que infla o bloco.
        if "BAND" not in up:
            continue
        mp = patamar_re.search(line)
        mt = periodo_re.search(line)
        if not (mp and mt):
            continue
        cor = mp.group(1).title()
        patamar = int(mp.group(2)) if mp.group(2) else None
        chave = (cor, patamar, mt.group(0))
        if chave in vistos:
            continue
        vistos.add(chave)
        out.append({"cor": cor, "patamar": patamar, "periodo": mt.group(0), "texto": line[:200]})
    return out or None


def extrair_enel_ampla_legacy(texto: str) -> dict:
    """Enel Rio / Ampla layout ANTIGO (2021, pré-NF3e, header 'NOTA FISCAL - CONTA
    ENERGIA ELÉTRICA'). PIS/COFINS vêm com %; o ICMS NÃO tem rótulo — está numa linha
    posicional '<data> <nota_fiscal> <série> <base> <alíq>% <valor>'. PIS+COFINS+ICMS
    → PROPAGAÇÃO #5.
    """
    out = {}
    flat = re.sub(r"[ \t]+", " ", texto)
    trib = {}
    for t in re.finditer(r"\b(PIS|COFINS)\s+([\d.]+,\d{2})\s+([\d.,]+)%\s+([\d.]+,\d{2})", flat):
        nome = t.group(1).upper()
        key = "pis" if nome == "PIS" else "cofins"
        if key not in trib:
            trib[key] = {"base_string": t.group(2), "aliquota_pct": t.group(3), "valor_string": t.group(4)}
    # ICMS posicional (sem rótulo): 'dd/mm/aaaa <nf 6+díg> <série> <base> <aliq>% <valor>'
    mi = re.search(r"\d{2}/\d{2}/\d{4}\s+\d{6,}\s+\d+\s+([\d.]+,\d{2})\s+(\d{1,2},\d{2})%\s+([\d.]+,\d{2})", flat)
    if mi:
        trib["icms"] = {"base_string": mi.group(1), "aliquota_pct": mi.group(2), "valor_string": mi.group(3)}
    out["tributos"] = trib
    cls = {}
    mg = re.search(r"\b(B3|B2|B1|A4|A3|A2|AS)\b", texto)
    if mg: cls["subgrupo"] = mg.group(1).upper()
    if re.search(r"CONVENCIONAL", texto, re.I): cls["modalidade"] = "Convencional"
    if re.search(r"\bCOMERCIAL\b", texto, re.I): cls["classe"] = "Comercial"
    elif re.search(r"\bRESIDENCIAL\b", texto, re.I): cls["classe"] = "Residencial"
    elif re.search(r"\bRURAL\b", texto, re.I): cls["classe"] = "Rural"
    out["classificacao"] = cls
    out["cnpj_emissor"] = "33.050.071/0001-58"
    # Header legado (linha 1): '<uc> <uc> <venc> <total>' seguido de '<MES>/<ANO> <consumo>'.
    # O total fica null no mapa enel_rio → núcleo antiga falha → reprovado. Recupera aqui.
    _MES3 = {"JAN": "01", "FEV": "02", "MAR": "03", "ABR": "04", "MAI": "05", "JUN": "06",
             "JUL": "07", "AGO": "08", "SET": "09", "OUT": "10", "NOV": "11", "DEZ": "12"}
    mh = re.search(r"^\s*(\d{6,9})-\d\s+\d{6,9}-\d\s+(\d{2}/\d{2}/\d{4})\s+([\d.]+,\d{2})", texto, re.M)
    if mh:
        out["uc"] = mh.group(1); out["data_vencimento"] = mh.group(2); out["valor_total"] = mh.group(3)
    mm = re.search(r"\b([A-Z]{3})/(\d{4})\b", texto)
    if mm and mm.group(1) in _MES3:
        out["mes_ref"] = f"{_MES3[mm.group(1)]}/{mm.group(2)}"
    return out


def extrair_ceb_serie_u(texto: str):
    """CEB / Neoenergia Brasília layout ANTIGO 'Série U/A' (2021-2023, pré-NF3e). Header
    'NOTA FISCAL/FATURA ... SÉRIE U/A' + 'REGIME ESPECIAL - ATO DECLARATORIO N° 005/2006' +
    CNPJ distribuidora 07.522.669. Vem rotulado 'Neoenergia Coelba' na coluna (família
    Neoenergia agrega), mas o conteúdo é Brasília. mapa não cobre → total/classe/mês ausentes
    → reprovado. Núcleo (total+mês+classe+CNPJ cliente) + _fatura_antiga → SKIP-cheio.
    Tributos limpos (Grupo B rótulos 'Valor total do ICMS:'; Grupo A linha posicional após
    'ICMS Incluído:'). Itens Grupo B (CONSUMO ENERGIA ATIVA + CONTRIB I.PUBLICA somam total).
    NÃO captura DANF3E moderno Brasília (sem 'ATO DECLARATORIO 005/2006')."""
    if not texto:
        return None
    if not re.search(r"ATO\s+DECLARAT[ÓO]RIO\s*N?[°ºo]?\s*005/2006", texto, re.I):
        return None
    if not re.search(r"07\.522\.669", texto):
        return None
    t = texto
    flat = re.sub(r"[ \t]+", " ", t)
    out = {"_dist": "ceb_brasilia"}
    _MES3 = {"JAN": "01", "FEV": "02", "MAR": "03", "ABR": "04", "MAI": "05", "JUN": "06",
             "JUL": "07", "AGO": "08", "SET": "09", "OUT": "10", "NOV": "11", "DEZ": "12"}
    # --- mês de referência: Grupo B 'Mês faturado Jan/2022' | Grupo A tabela 'ABR/2023 ...' ---
    mm = re.search(r"M[êe]s\s+faturado\s+([A-Za-z]{3})[./\s]*(\d{4})", flat, re.I)
    if not mm:
        mm = re.search(r"\b([A-Z]{3})/(\d{4})\b", t)
    if mm:
        k = mm.group(1)[:3].upper()
        if k in _MES3:
            out["mes_ref"] = f"{_MES3[k]}/{mm.group(2)}"
    # --- classe / modalidade / subgrupo ---
    if re.search(r"\bCOMERCIAL\b", t, re.I): out["classe"] = "Comercial"
    elif re.search(r"\bRESIDENCIAL\b", t, re.I): out["classe"] = "Residencial"
    elif re.search(r"\bRURAL\b", t, re.I): out["classe"] = "Rural"
    elif re.search(r"\bINDUSTRIAL\b", t, re.I): out["classe"] = "Industrial"
    elif re.search(r"PODER\s+P[ÚU]BLICO", t, re.I): out["classe"] = "Poder Público"
    mg = re.search(r"THS[- ]?(A4|A3|A2|AS)|\b(A4|A3|A2|B1|B2|B3)\b", t)
    if mg: out["subgrupo"] = (mg.group(1) or mg.group(2)).upper()
    if re.search(r"\bVERDE\b", t): out["modalidade"] = "Verde"
    elif re.search(r"\bAZUL\b", t): out["modalidade"] = "Azul"
    # --- CNPJ cliente (VIA VAREJO 33.041.260/...) ---
    mc = re.search(r"(33\.041\.260/\d{4}-\d{2})", t)
    if mc: out["cnpj_cliente"] = mc.group(1)
    # --- total: última ocorrência 'R$ <valor>' (rodapé/boleto); ignora canhoto 0,00 e
    #     valores com asterisco do bloco de tributos Grupo A ('R$ ******3.951,37 ...') ---
    tots = re.findall(r"R\$\s*([\d.]+,\d{2})(?!\s*[\d*])", t)
    cand = [x for x in tots if x not in ("0,00",)]
    if cand:
        out["valor_total"] = cand[-1]
    # --- vencimento: no rodapé do boleto '<MES>/<ANO> <DD/MM/AAAA>' ---
    mv = re.search(r"[A-Za-z]{3}/\d{4}\s+(\d{2}/\d{2}/\d{4})", flat)
    if mv: out["data_vencimento"] = mv.group(1)
    # --- itens Grupo B (somam o total) ---
    itens = []
    mca = re.search(r"CONSUMO\s+ENERGIA\s+ATIVA\s+([\d.]+,\d{2})", flat, re.I)
    if mca: itens.append({"descricao": "Consumo Energia Ativa", "valor_string": mca.group(1)})
    mcip = re.search(r"CONTRIBUI[CÇ][ÃA]O\s+DE\s+I\.?\s*P[ÚU]BLICA\s+([\d.]+,\d{2})", flat, re.I)
    if mcip: itens.append({"descricao": "Contribuição Ilum. Pública", "valor_string": mcip.group(1)})
    if itens: out["itens"] = itens
    # --- tributos ---
    trib = {}
    mb = re.search(r"Valor\s+total\s+do\s+ICMS:\s*([\d.]+,\d{2})", flat, re.I)
    if mb:  # Grupo B (rotulado)
        trib["icms"] = {"valor_string": mb.group(1)}
        mbase = re.search(r"Base\s+de\s+C[áa]lculo:\s*([\d.]+,\d{2})", flat, re.I)
        maliq = re.search(r"Aliquota:\s*([\d.,]+)\s*%", flat, re.I)
        if mbase: trib["icms"]["base_string"] = mbase.group(1)
        if maliq: trib["icms"]["aliquota_pct"] = maliq.group(1)
        mpis = re.search(r"Valor\s+PIS/PASEP:\s*([\d.]+,\d{2})", flat, re.I)
        mcof = re.search(r"Valor\s+COFINS:\s*([\d.]+,\d{2})", flat, re.I)
        if mpis: trib["pis"] = {"valor_string": mpis.group(1)}
        if mcof: trib["cofins"] = {"valor_string": mcof.group(1)}
    else:  # Grupo A — linha posicional 'R$ ******<encargo> <base> <aliq>% <icms> <pis> <cofins>'
        ma = re.search(r"R\$\s*\*+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.,]+)\s*%\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})", flat)
        if ma:
            trib["icms"] = {"base_string": ma.group(2), "aliquota_pct": ma.group(3), "valor_string": ma.group(4)}
            trib["pis"] = {"valor_string": ma.group(5)}
            trib["cofins"] = {"valor_string": ma.group(6)}
    if trib: out["tributos"] = trib
    return out


def extrair_celesc_2col(texto: str):
    """Celesc layout ANTIGO 2-coluna ('Conta de Energia Elétrica' / 'Dados do Faturamento',
    SEM códigos (0D)(0E) — distinto do NF3e código-prefixado). Vem rotulado tanto 'Celesc%'
    quanto cooperativas (COOPERATIVA COTESA/etc. = nome do GERADOR GD vazado p/ distribuidora).
    Total 'VALOR ATÉ O VENCIMENTO R$'; itens (Consumo Tusd/Te, Energia Inj. Ouc Mpt NEG, Cosip,
    Valor do Icms-Juizo NEG, Demanda, Subst.Trib) que SOMAM o total; classe/mês/venc/UC/leitura/
    histórico. valor do item = ÚLTIMA coluna monetária da linha. Retorna dict."""
    if not texto or "08.336.783" not in texto and not re.search(r"Celesc", texto, re.I):
        return None
    if not re.search(r"Dados\s+do\s+Faturamento", texto, re.I) or re.search(r"\((?:0D|0E|2U)\)", texto):
        return None  # código-prefixado é o NF3e (bloco 9.0.4e3b), não este
    t = texto
    out = {}
    mt = re.search(r"VALOR\s+AT[ÉE]\s+O\s+VENCIMENTO[\s\S]{0,120}?R\$\s*([\d.]+,\d{2})", t, re.I) or \
         re.search(r"VALOR\s+A\s+PAGAR[\s\S]{0,120}?R\$\s*([\d.]+,\d{2})", t, re.I)
    if mt: out["valor_total"] = mt.group(1)
    mr = re.search(r"REF\.?:?\s*(\d{2}/\d{4})", t, re.I)
    if mr: out["mes_ref"] = mr.group(1)
    # venc: 'VENCIMENTO' + 1ª data em até ~70 chars (layout 2-coluna intercala cliente entre eles)
    mv = re.search(r"VENCIMENTO[\s\S]{0,70}?(\d{2}/\d{2}/\d{4})", t, re.I)
    if mv: out["data_vencimento"] = mv.group(1)
    # UC: '<uc> CONSUMO TOTAL FATURADO' (nº da unidade consumidora)
    mu = re.search(r"(\d{5,8})\s+CONSUMO\s+TOTAL\s+FATURADO", t, re.I) or re.search(r"UNIDADE\s+CONSUMIDORA[\s\S]{0,40}?(\d{5,8})", t, re.I)
    if mu: out["instalacao"] = mu.group(1)
    # razão social do cliente (telecom/varejo)
    mrz = re.search(r"\b(OI\s+S\.?\s?A\.?[^\n]*|V\.?TAL[^\n]*?S\.?\s?A\.?|VIA\s+VAREJO\s+S\.?\s?A\.?|CLARO\s+S\.?\s?A\.?|TELEF[ÔO]NICA[^\n]*)", t, re.I)
    if mrz: out["razao_social"] = re.sub(r"\s+", " ", mrz.group(1)).strip()[:80]
    # classe / modalidade / subgrupo
    if re.search(r"\bCOMERCIAL\b", t, re.I): out["classe"] = "Comercial"
    elif re.search(r"\bRESIDENCIAL\b", t, re.I): out["classe"] = "Residencial"
    elif re.search(r"\bRURAL\b", t, re.I): out["classe"] = "Rural"
    elif re.search(r"\bINDUSTRIAL\b", t, re.I): out["classe"] = "Industrial"
    if re.search(r"\bCONVENCIONAL\b", t, re.I): out["modalidade"] = "Convencional"
    elif re.search(r"\bVERDE\b", t): out["modalidade"] = "Verde"
    elif re.search(r"\bAZUL\b", t): out["modalidade"] = "Azul"
    mg = re.search(r"Grupo\s+de\s+Tens[ãa]o:\s*([AB])", t, re.I)
    out["subgrupo"] = ((mg.group(1).upper() + "3") if mg and mg.group(1).upper() == "B" else (mg.group(1).upper() + "4")) if mg else None
    mcj = re.search(r"CP?J\s+(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2})", t)  # 'CPJ' (typo OCR) ou CNPJ
    if mcj: out["cnpj_cliente"] = mcj.group(1)
    ml = re.search(r"leitura\s+anterior:\s*(\d{2}/\d{2}/\d{4})", t, re.I)
    ml2 = re.search(r"leitura\s+atual:\s*(\d{2}/\d{2}/\d{4})", t, re.I)
    if ml: out["leit_ant_data"] = ml.group(1)
    if ml2: out["leit_atu_data"] = ml2.group(1)
    mdd = re.search(r"dias\s+faturados?:\s*(\d{1,3})", t, re.I)
    if mdd: out["dias"] = mdd.group(1)
    # itens: região 'Dados do Faturamento' → 'HISTÓRICO'/'Mensagens'. valor = última coluna ,2dec.
    a = re.search(r"Dados\s+do\s+Faturamento", t, re.I)
    reg = t[a.end(): a.end() + 1800] if a else t
    fim = re.search(r"HIST[ÓO]RICO|Mensagens|Demonstrativ", reg, re.I)
    if fim: reg = reg[:fim.start()]
    _D2 = (r"Consumo\s+Tusd", r"Consumo\s+Te", r"Tusd-?Energia\s+F?\.?\s*Ponta", r"Te-?Energia\s+F?\.?\s*Ponta",
           r"Energia\s+Inj\.?\s+Ouc\s+Mpt\s+Tusd", r"Energia\s+Inj\.?\s+Ouc\s+Mpt\s+Te", r"Energia\s+Inj\w*",
           r"Demanda\s+F?\.?\s*Pta", r"Demanda\s+F?\.?\s*Ponta", r"Demanda",
           r"Subst\.?\s+Trib\.?\s+\w+", r"Substitui\w+\s+Tribut\w+", r"Subsidio\s+Tarifario\w*",
           r"Cosip\s+Municipal", r"Cosip", r"Valor\s+do\s+Icms-?Juizo", r"Adic\.?\s+Bandeira", r"Bandeira\s+\w+")
    itens, _seen = [], set()
    for _ln in reg.splitlines():
        for _pat in _D2:
            _dm = re.search(r"(" + _pat + r")", _ln, re.I)   # mid-line (2-coluna intercala colunas)
            if _dm:
                _vals = re.findall(r"-?[\d.]+,\d{2}(?!\d)", _ln)   # valor = última col ,2dec
                if _vals:
                    _last = _vals[-1]
                    _v = _amz_brl(_last.lstrip("-"))
                    if _v is not None and _last.startswith("-"): _v = -_v
                    _desc = re.sub(r"\s+", " ", _dm.group(1)).strip()
                    _k = (_desc.lower(), _v)
                    if _v is not None and _k not in _seen:
                        _seen.add(_k); itens.append({"descricao": _desc, "valor_brl_numerico": _v, "_fonte": "esp_celesc_2col"})
                break
    out["itens"] = itens
    out["soma"] = round(sum(i["valor_brl_numerico"] or 0 for i in itens), 2)
    # histórico mensal 'Abr/2023 ... \n 7638 6443 ...'
    mh = re.search(r"((?:Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez)/\d{4}(?:\s+(?:Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez)/\d{4}){5,})\s*\n\s*((?:\d+\s+){5,}\d+)", t, re.I)
    if mh:
        _cons = mh.group(2).split()
        out["historico"] = [{"consumo_kwh": float(v)} for v in _cons[:13]]
    return out


def extrair_roraima(texto: str):
    """Roraima Energia S.A (CNPJ 02.341.470). DANF3E limpo. Total 'Total a pagar R$', itens
    ('Consumo <qtd> kWh a <t1> <t2> <valor>' + COSIP + Demanda Grupo A) que SOMAM o total,
    tributos 'Detalhamento de Tributos' (ICMS/PIS/Cofins base aliq valor), classe/subgrupo/
    modalidade ('GRUPO B B3 COMERCIAL ... CONVENCIONAL'), leitura (3 datas), histórico 13m,
    mês/venc ('<cod> <venc> <mes/ano>'). Cliente V.TAL. Retorna dict."""
    if not texto:
        return None
    if not re.search(r"RORAIMA\s+ENERGIA|02\.?341\.?470/0001", texto, re.I):
        return None
    t = texto
    out = {}
    mt = re.search(r"Total\s+a\s+pagar\s+R\$\s*([\d.]+,\d{2})", t, re.I)
    if mt:
        out["valor_total"] = mt.group(1)
    # 'Vencimento Mês Faturado\n<cod> <DD/MM/AAAA> <MM/AAAA>'
    mv = re.search(r"(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{4})\b", t)
    if mv:
        out["data_vencimento"] = mv.group(1); out["mes_ref"] = mv.group(2)
    # classe / subgrupo / modalidade
    mg = re.search(r"GRUPO\s+[AB]\s+(A\d|B\d|AS)\b", t)
    if mg: out["subgrupo"] = mg.group(1).upper()
    if re.search(r"\bCOMERCIAL\b", t, re.I): out["classe"] = "Comercial"
    elif re.search(r"\bRESIDENCIAL\b", t, re.I): out["classe"] = "Residencial"
    elif re.search(r"\bRURAL\b", t, re.I): out["classe"] = "Rural"
    elif re.search(r"\bINDUSTRIAL\b", t, re.I): out["classe"] = "Industrial"
    elif re.search(r"PODER\s+P[ÚU]BLICO", t, re.I): out["classe"] = "Poder Público"
    if re.search(r"\bCONVENCIONAL\b", t, re.I): out["modalidade"] = "Convencional"
    elif re.search(r"\bVERDE\b", t): out["modalidade"] = "Verde"
    elif re.search(r"\bAZUL\b", t): out["modalidade"] = "Azul"
    mc = re.search(r"(02\.041\.460/\d{4}-\d{2})", t)   # V.TAL cliente
    if mc: out["cnpj_cliente"] = mc.group(1)
    mrz = re.search(r"(V\.?TAL\s*-\s*REDE\s+NEUTRA[^\n]*?S\.?A\.?)", t, re.I)
    if mrz: out["razao_social"] = re.sub(r"\s+", " ", mrz.group(1)).strip()
    mi = re.search(r"C[óo]digo\s+[ÚU]nico[^\n]*\n\s*([\d-]{5,})", t, re.I)
    if mi: out["instalacao"] = mi.group(1)
    # leitura: 'Leitura Anterior Leitura Atual Próxima Leitura\n<ant> <atu> <prox>'
    ml = re.search(r"(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})", t)
    if ml:
        out["leit_ant_data"] = ml.group(1); out["leit_atu_data"] = ml.group(2)
    md = re.search(r"\b(\d{1,3})\s+\d{2}/\d{2}/\d{4}\s+\d{2}/\d{2}/\d{4}\s*\n\s*Dados", t)  # dias antes de Emissão/Apresentação
    if not md:
        md = re.search(r"Dias\s+de\s+consumo[^\n]*\n\s*(\d{1,3})\b", t, re.I)
    if md: out["dias"] = md.group(1)
    # tributos (Detalhamento de Tributos)
    trib = {}
    for nome, key in (("ICMS", "icms"), ("PIS", "pis"), ("Cofins", "cofins")):
        mtr = re.search(nome + r"\s+([\d.]+,\d{2})\s+([\d.,]+)\s+([\d.]+,\d{2})", t)
        if mtr:
            trib[key] = {"base_string": mtr.group(1), "aliquota_pct": mtr.group(2), "valor_string": mtr.group(3)}
    out["tributos"] = trib
    # itens: 'Consumo <qtd> kWh a <t1> <t2> <valor>' + COSIP + Demanda (Grupo A)
    itens = []
    _rseen = set()   # dedup (desc,valor): concat de plumber+md+bbox repete cada item 3×
    for m in re.finditer(r"(Consumo|Demanda(?:\s+Ultrapassagem)?)\s+([\d.]+)\s+(?:kWh|kW)\s+a\s+[\d.,]+\s+[\d.,]+\s+([\d.]+,\d{2})", t, re.I):
        _v = _amz_brl(m.group(3)); _k = (m.group(1).strip().lower(), _v)
        if _k in _rseen: continue
        _rseen.add(_k)
        itens.append({"descricao": m.group(1).strip(), "valor_brl_numerico": _v, "_fonte": "esp_roraima"})
    mcip = re.search(r"Contribui[çc][ãa]o\s+de\s+Ilumina[çc][ãa]o\s+P[úu]blica\s*\(COSIP\)\s+([\d.]+,\d{2})", t, re.I)
    if mcip: itens.append({"descricao": "COSIP", "valor_brl_numerico": _amz_brl(mcip.group(1)), "_fonte": "esp_roraima"})
    out["itens"] = itens
    out["soma"] = round(sum(i["valor_brl_numerico"] or 0 for i in itens), 2)
    # histórico: 'Histórico de Medição (kWh)\n<n> <n> ... <n>' (13) + meses 'MAR ABR ... 2025/2026'
    _MES3R = {"JAN": "01", "FEV": "02", "MAR": "03", "ABR": "04", "MAI": "05", "JUN": "06",
              "JUL": "07", "AGO": "08", "SET": "09", "OUT": "10", "NOV": "11", "DEZ": "12"}
    mh = re.search(r"Hist[óo]rico\s+de\s+Medi[çc][ãa]o\s*\(kWh\)[^\n]*\n\s*((?:-?\d+\s+){8,}-?\d+)", t, re.I)
    if mh:
        vals = mh.group(1).split()
        hist = [{"consumo_kwh": float(v)} for v in vals[-13:]]
        if hist:
            out["historico"] = hist
    return out


def extrair_neoenergia_nordeste(texto: str):
    """Neoenergia Coelba (BA, CNPJ 15.139.629) e Celpe (PE, 10.835.932) — MESMO template.
    Vêm rotuladas 'Neoenergia Coelba%' na coluna (família agrega). 2 sub-layouts:
    ANTIGO 2021 ('DESCRIÇÃO DA NOTA FISCAL', 'Consumo Ativo(kWh)-TUSD 100 0,575 57,53',
    'TOTAL DA FATURA', tributos numa linha posicional de 9 números) e NOVO 2026 ('ITENS DA
    FATURA', 'Consumo-TUSD kWh 13.136 0,805 10.574,97 ...PIS...', 'REF:MÊS/ANO TOTAL A PAGAR
    R$ VENCIMENTO' + linha de valores, tributos rotulados 'PIS <base> <aliq> <valor>').
    valor do item = 1º ,2dec após o preço (5+ dec), senão 1º da linha; hífen final = negativo.
    Itens (Consumo TUSD/TE + Bandeira + Ilum + Imp.Som/Dim negativo) somam o TOTAL DA FATURA."""
    if not texto:
        return None
    if not re.search(r"15\.139\.629|10\.835\.932|ELETRICIDADE DO ESTADO DA BAHIA|ENERG[ÉE]TICA\s+DE\s+PERNAMBUCO", texto, re.I):
        return None
    if not re.search(r"DESCRI[ÇC][ÃA]O DA NOTA FISCAL|ITENS DA FATURA|TOTAL DA FATURA", texto, re.I):
        return None
    t = texto
    out = {}
    _MES3 = {"JAN": "01", "FEV": "02", "MAR": "03", "ABR": "04", "MAI": "05", "JUN": "06",
             "JUL": "07", "AGO": "08", "SET": "09", "OUT": "10", "NOV": "11", "DEZ": "12"}
    # total: NOVO 'REF:MÊS/ANO TOTAL A PAGAR R$ VENCIMENTO\n<mes/ano> <total> <venc>'
    mn = re.search(r"REF:M[ÊE]S/ANO[^\n]*\n\s*(\d{2}/\d{4})\s+([\d.]+,\d{2})\s+(\d{2}/\d{2}/\d{4})", t, re.I)
    if mn:
        out["mes_ref"] = mn.group(1); out["valor_total"] = mn.group(2); out["data_vencimento"] = mn.group(3)
    # ANTIGO/fallback: 'TOTAL DA FATURA <total>' (≠ 'TOTAL A PAGAR' que pode vir 0,00 débito)
    if not out.get("valor_total"):
        mtf = re.search(r"TOTAL\s+DA\s+FATURA\s+([\d.]+,\d{2})", t, re.I)
        if mtf and mtf.group(1) != "0,00":
            out["valor_total"] = mtf.group(1)
    # vencimento + emissão (ANTIGO) p/ mes_ref se ainda faltar
    if not out.get("data_vencimento"):
        mv = re.search(r"VENCIMENTO[^\n]*\n?[^\d]*(\d{2}/\d{2}/\d{4})", t, re.I)
        if mv: out["data_vencimento"] = mv.group(1)
    if not out.get("mes_ref"):
        me = re.search(r"EMISS[ÃA]O[^\n]*?(\d{2})/(\d{2})/(\d{4})", t, re.I)
        if me: out["mes_ref"] = f"{me.group(2)}/{me.group(3)}"
    # classe / subgrupo
    mg = re.search(r"\b(B1|B2|B3|A1|A2|A3|A4|AS)\b", t)
    if mg: out["subgrupo"] = mg.group(1).upper()
    if re.search(r"\bCOMERCIAL\b", t, re.I): out["classe"] = "Comercial"
    elif re.search(r"\bRESIDENCIAL\b", t, re.I): out["classe"] = "Residencial"
    elif re.search(r"\bRURAL\b", t, re.I): out["classe"] = "Rural"
    elif re.search(r"\bINDUSTRIAL\b", t, re.I): out["classe"] = "Industrial"
    if re.search(r"\bVERDE\b", t): out["modalidade"] = "Verde"
    elif re.search(r"\bAZUL\b", t): out["modalidade"] = "Azul"
    elif re.search(r"Mon[ôo]mia|Conven", t, re.I): out["modalidade"] = "Convencional"
    # instalação + CNPJ cliente
    mi = re.search(r"INSTALA[ÇC][ÃA]O[:\s]*\n?\s*(\d{6,12})", t, re.I) or re.search(r"N[ºo°]\s*DA\s*INSTALA[ÇC][ÃA]O\s+(\d{6,12})", t, re.I)
    if mi: out["instalacao"] = mi.group(1)
    mc = re.search(r"(33\.041\.260/\d{4}-\d{2})", t)
    if mc: out["cnpj_cliente"] = mc.group(1)
    # leitura (NOVO): 'LEITURA ANTERIOR <data> LEITURA ATUAL <data> N° DE DIAS <n>'
    ml = re.search(r"LEITURA\s+ANTERIOR\s+(\d{2}/\d{2}/\d{4})\s+LEITURA\s+ATUAL\s+(\d{2}/\d{2}/\d{4})\s+N[º°o]\s*DE\s*DIAS\s+(\d{1,3})", t, re.I)
    if ml:
        out["leit_ant_data"] = ml.group(1); out["leit_atu_data"] = ml.group(2); out["dias"] = ml.group(3)
    # tributos: NOVO rotulado 'PIS <base> <aliq> <valor>'; ANTIGO posicional 9 números
    trib = {}
    for m in re.finditer(r"\b(PIS|COFINS|ICMS)\s+([\d.]+,\d{2})\s+(\d{1,2},\d{1,4})\s+([\d.]+,\d{2})", t):
        k = m.group(1).lower()
        if k not in trib:
            trib[k] = {"base_string": m.group(2), "aliquota_pct": m.group(3), "valor_string": m.group(4)}
    if not trib:  # ANTIGO: linha 'ICMS_base ICMS_aliq ICMS_val PIS_base PIS_aliq PIS_val COFINS_base COFINS_aliq COFINS_val'
        mp = re.search(r"([\d.]+,\d{2})\s+(\d{1,2},\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+(\d{1,2},\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+(\d{1,2},\d{2})\s+([\d.]+,\d{2})", t)
        if mp:
            trib["icms"] = {"base_string": mp.group(1), "aliquota_pct": mp.group(2), "valor_string": mp.group(3)}
            trib["pis"] = {"base_string": mp.group(4), "aliquota_pct": mp.group(5), "valor_string": mp.group(6)}
            trib["cofins"] = {"base_string": mp.group(7), "aliquota_pct": mp.group(8), "valor_string": mp.group(9)}
    out["tributos"] = trib
    # itens
    _ITPATS = [
        (r"Consumo[ -]?Ativo?\s*\(kWh\)\s*-\s*TUSD|Consumo\s*-\s*TUSD|Consumo-TUSD", "Consumo TUSD"),
        (r"Consumo[ -]?Ativo?\s*\(kWh\)\s*-\s*TE|Consumo\s*-\s*TE|Consumo-TE", "Consumo TE"),
        (r"Acr[ée]s\w*\.?\s+(?:Band|Bandeira)", "Acréscimo Bandeira"),
        (r"Ilum\.?\s*P[úu]b|Contrib\.?\s*Ilum", "Iluminação Pública"),
        (r"Imp\.?\s*Som/Dim", "Imp. Sobre Diminuição"),
        # itens financeiros (podem repetir por NF → dedup por (label,valor))
        (r"Multa\s+por\s+atraso", "Multa"),
        (r"Juros\s+por\s+atraso", "Juros"),
        (r"Atualiza[çc][ãa]o\s+IPCA", "Atualização IPCA"),
        (r"ICMS\s+Subven[çc]", "ICMS Subvenção CDE"),
        (r"Visita\s+T[ée]cnica", "Visita Técnica"),
    ]
    itens = []
    _seen = set()
    for _ln in t.splitlines():
        for _pat, _lab in _ITPATS:
            _m = re.search(_pat, _ln, re.I)
            if not _m:
                continue
            _tail = _ln[_m.end():]
            _tc = re.search(r"\s(?:PIS|COFINS|ICMS|CONSUMO|Tributo|Grandezas)\b", _tail)
            if _tc:
                _tail = _tail[:_tc.start()]
            _pm = re.search(r"\d,\d{5,}", _tail)   # preço unitário (5+ decimais)
            _vm = re.search(r"([\d.]+,\d{2})(?!\d)(-)?", _tail[_pm.end():] if _pm else _tail)
            if _vm:
                _v = _amz_brl(_vm.group(1))
                if _v is not None:
                    if _vm.group(2):
                        _v = -_v
                    _k = (_lab, _v)
                    if _k not in _seen:
                        itens.append({"descricao": _lab, "valor_brl_numerico": _v, "_fonte": "esp_neo_nordeste"})
                        _seen.add(_k)
            break
    out["itens"] = itens
    out["soma"] = round(sum(i["valor_brl_numerico"] or 0 for i in itens), 2)
    # histórico: NOVO 'MAI26 13136 29' / ANTIGO 'SET 21 100'. dedup por (mes,ano) — a tabela
    # aparece 2-3× no concat (plumber+md+bbox) → senão duplica meses (audit 105575).
    hist, _hvis = [], set()
    for m in re.finditer(r"\b([A-Z]{3})\s?/?\s?(\d{2})\s+(\d{2,6})(?:\s+(\d{1,3}))?\b", t):
        if m.group(1).upper() not in _MES3:
            continue
        _hk = (m.group(1).upper(), 2000 + int(m.group(2)))
        if _hk in _hvis:
            continue
        _hvis.add(_hk)
        hist.append({"mes": _hk[0], "ano": _hk[1], "consumo_kwh": _amz_brl(m.group(3))})
        if len(hist) >= 13:
            break
    if hist:
        out["historico"] = hist
        # mes_ref: layout ANTIGO não imprime ref explícita → mês mais recente do histórico
        if not out.get("mes_ref"):
            out["mes_ref"] = f"{_MES3[hist[0]['mes']]}/{hist[0]['ano']}"
    return out


def extrair_ampla_nf3e(texto: str):
    """Ampla/Enel RJ NF3e 2022-2025 (header 'Ampla...Avenida Oscar Niemeyer' + chave hex). Grupo A
    LIVRE (A4 HORO VERDE LIVRE) e B. O mapa enel_rio deixa total=null. Extrai total (linha
    '<venc> <total>'), mês ref, leitura (3 datas), classe/modalidade/subgrupo/UC, tributos LIMPOS
    ('<TRIB> base aliq valor', sem %) e histórico 12m. Mercado livre → soma_itens SKIP (flag
    _enel_rj_acl). Retorna {valor_total, mes_ref, data_vencimento, leit_*, dias, classe,
    modalidade, subgrupo, uc, acl, tributos, historico}."""
    if not texto:
        return None
    if not re.search(r"Ampla\s+Energia\s+e\s+Servi[çc]os.*Oscar\s+Niemeyer", texto, re.I | re.S):
        return None
    t = texto
    out = {"_dist": "enel_rj_ampla"}
    # total: 1ª linha 'DD/MM/AAAA <total>' (a leitura é 3 datas SEM valor → não casa)
    mt = re.search(r"(\d{2}/\d{2}/\d{4})\s+([\d.]+,\d{2})(?!\s*\d)", t)
    if mt:
        out["data_vencimento"] = mt.group(1); out["valor_total"] = mt.group(2)
    # mês ref: '\n05/2022\n' antes da linha de 3 datas de leitura
    mr = re.search(r"\n(\d{2}/\d{4})\s*\n\s*\d{2}/\d{2}/\d{4}\s+\d{2}/\d{2}/\d{4}", t)
    if mr:
        out["mes_ref"] = mr.group(1)
    # leitura: 3 datas (ant atual prox) + 'NN Dias'
    ml = re.search(r"\n(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s*\n", t)
    if ml:
        out["leit_ant_data"] = ml.group(1); out["leit_atu_data"] = ml.group(2)
    md = re.search(r"\b(\d{1,2})\s+Dias\b", t, re.I)
    if md:
        out["dias"] = md.group(1)
    # classificação + UC: 'A4 HORO VERDE LIVRE 5263569'
    mc = re.search(r"\b(A[1-4]|B[1-4]|AS)\s+(HORO\s+VERDE|HORO\s+AZUL|HOROSAZONAL\s+VERDE|HOROSAZONAL\s+AZUL|CONVENCIONAL)\s*(LIVRE)?\s*(\d{6,9})?", t, re.I)
    if mc:
        out["subgrupo"] = mc.group(1).upper()
        out["modalidade"] = "Verde" if "VERDE" in mc.group(2).upper() else ("Azul" if "AZUL" in mc.group(2).upper() else "Convencional")
        out["acl"] = bool(mc.group(3))
        if mc.group(4):
            out["uc"] = mc.group(4)
    if re.search(r"\bComercial\b", t, re.I): out["classe"] = "Comercial"
    elif re.search(r"\bResidencial\b", t, re.I): out["classe"] = "Residencial"
    elif re.search(r"\bRural\b", t, re.I): out["classe"] = "Rural"
    # tributos limpos '<TRIB> base aliq valor' (aliq sem %, 2 dec)
    trib = {}
    for m in re.finditer(r"\b(PIS/PASEP|PIS|COFINS|ICMS)\s+([\d.]+,\d{2})\s+(\d{1,2},\d{2})\s+([\d.]+,\d{2})", t):
        k = "pis" if m.group(1).upper().startswith("PIS") else ("cofins" if m.group(1).upper() == "COFINS" else "icms")
        trib.setdefault(k, {"base_string": m.group(2), "aliquota_pct": m.group(3), "valor_string": m.group(4)})
    out["tributos"] = trib
    # histórico 12m: 'MAI 2022 3,59 6,44 155,00 1494,00' → consumo = último número (kWh)
    hist = []
    for m in re.finditer(r"\b([A-Z]{3})\s+(\d{4})\s+[\d.,]+\s+[\d.,]+\s+[\d.,]+\s+([\d.]+),\d{2}\b", t):
        hist.append({"mes": m.group(1), "ano": int(m.group(2)), "consumo_kwh": _amz_brl(m.group(3))})
    if hist:
        out["historico"] = hist[:13]
    return out


def extrair_cpfl_danf3e(texto: str) -> dict:
    """CPFL (Paulista/Santa Cruz/Piratininga, SP). DANF3E com tributos LIMPOS:
    '<PIS/PASEP|COFINS|ICMS> <base> <aliq> <valor>' (alíq sem %). Itens 'Uso Sist. Distr.',
    'Tusd Enc Cons', 'Energia ACL', GD 'Energ Atv Inj. oUC'. As faturas bucketadas como
    'Santa Cruz' no lote 4 são CPFL Paulista (CNPJ 33.050.196). PIS+COFINS+ICMS separados
    → PROPAGAÇÃO #5.
    """
    out = {}
    flat = re.sub(r"[ \t]+", " ", texto)
    trib = {}
    for t in re.finditer(r"\b(PIS/PASEP|PIS|COFINS|ICMS)\s+([\d.]+,\d{2})\s+(\d{1,2},\d{2})\s+([\d.]+,\d{2})", flat):
        nome = t.group(1).upper()
        key = "pis" if nome.startswith("PIS") else ("cofins" if nome == "COFINS" else "icms")
        if key not in trib:
            trib[key] = {"base_string": t.group(2), "aliquota_pct": t.group(3), "valor_string": t.group(4)}
    # Fallback layout antigo (Santa Cruz 2019/2021): linha 'Total Consolidado <total>
    # <base_icms> <icms> <base_pc> <pis> <cofins>' (valores conferidos = soma das colunas/item).
    if not (trib.get("icms") and trib.get("pis") and trib.get("cofins")):
        mtc = re.search(r"Total\s+Consolidado\s+[\d.]+,\d{2}\s+[\d.]+,\d{2}\s+([\d.]+,\d{2})\s+[\d.]+,\d{2}\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})", flat)
        if mtc:
            trib.setdefault("icms", {"valor_string": mtc.group(1), "aliquota_pct": "18"})
            trib.setdefault("pis", {"valor_string": mtc.group(2)})
            trib.setdefault("cofins", {"valor_string": mtc.group(3)})
    out["tributos"] = trib
    cls = {}
    if re.search(r"Tarifa\s+Verde|Verde\s+Livre", texto, re.I): cls["modalidade"] = "Verde"
    elif re.search(r"Tarifa\s+Azul|Azul\s+Livre", texto, re.I): cls["modalidade"] = "Azul"
    elif re.search(r"Convencional", texto, re.I): cls["modalidade"] = "Convencional"
    if re.search(r"\bComercial\b", texto, re.I): cls["classe"] = "Comercial"
    elif re.search(r"\bResidencial\b", texto, re.I): cls["classe"] = "Residencial"
    elif re.search(r"\bRural\b", texto, re.I): cls["classe"] = "Rural"
    elif re.search(r"\bIndustrial\b", texto, re.I): cls["classe"] = "Industrial"
    out["classificacao"] = cls
    # Total: 'MES/AAAA dd/mm/aaaa R$ valor'
    mt = re.search(r"\b([A-Z]{3}/\d{4}|\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+R\$\s*([\d.]+,\d{2})", flat)
    if mt:
        out["mes_ref"] = mt.group(1); out["data_vencimento"] = mt.group(2); out["valor_total"] = mt.group(3)
    if "33.050.196" in flat: out["cnpj_emissor"] = "33.050.196/0001-88"   # CPFL Paulista
    elif "04.172.213" in flat: out["cnpj_emissor"] = "04.172.213/0001-51"  # CPFL Piratininga
    elif "02.016.440" in flat: out["cnpj_emissor"] = "02.016.440/0001-62"  # RGE Sul
    return out


def extrair_cpfl_nf_legado(texto: str) -> dict:
    """CPFL (Paulista/Sta Cruz/Piratininga) layout NF/Conta de Energia LEGADO ~2020/2022.
    Cabeçalho 'Nota Fiscal / Conta de Energia Elétrica', tabela com header
    'Cod. Descrição da Operação ... Base Cálculo Aliq. ICMS Base Cálculo PIS COFINS' e
    códigos de operação 0605/0601/0602/0807. Dois sub-formatos da linha de fecho:

      Grupo A (paul/sc): 'Total Consolidado <total> <base_icms> <icms>'  (3 nums)
        → ICMS = 3º; base_icms = 2º; alíq do cabeçalho (geralmente 18%).
          PIS+COFINS: cada item tem 1 coluna final 'PIS/COFINS' (valor combinado) →
          soma das colunas dos itens; split pela alíq do cabeçalho 'PIS/COFINS % %'.
      B1 (pira): 'Total Consolidado <total> <base> <pis> <cofins>'  (4 nums) →
          PIS = 3º, COFINS = 4º; ICMS isento (B1 pequeno) = 0,00.

    Retorna {'tributos': {icms,pis,cofins}}. fill-if-empty no caller. Detecção do
    sub-formato é pela CONTAGEM de números do 'Total Consolidado', não pelo nome do arquivo.
    """
    def _f(s):
        try: return float(str(s).replace(".", "").replace(",", "."))
        except Exception: return None
    def _br(v):
        return ("%.2f" % v).replace(".", ",")
    flat = re.sub(r"[ \t]+", " ", texto)
    trib = {}

    # Alíquotas PIS/COFINS do cabeçalho: 'PIS/COFINS 0,97% 4,47%' ou '... % %' (Grupo A
    # sem números no header → usa default 1,65/7,60). Captura os 2 percentuais quando houver.
    pis_pct = cof_pct = None
    mhp = re.search(r"PIS/COFINS\s+(\d{1,2},\d{2})%\s+(\d{1,2},\d{2})%", flat)
    if mhp:
        pis_pct, cof_pct = mhp.group(1), mhp.group(2)

    # B1: 'Total Consolidado <total> <base> <pis> <cofins>' (4 valores)
    m_b1 = re.search(r"Total\s+Consolidado\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})(?!\s*[\d.]+,\d{2})", flat, re.I)
    # Grupo A: 'Total Consolidado <total> <base_icms> <icms>' (3 valores)
    m_a = re.search(r"Total\s+Consolidado\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})(?!\s*[\d.]+,\d{2})", flat, re.I)

    if m_b1:
        # 4 números → B1 (pis/cofins explícitos), ICMS isento
        trib["pis"] = {"valor_string": m_b1.group(3),
                       "base_string": m_b1.group(2),
                       "aliquota_pct": pis_pct}
        trib["cofins"] = {"valor_string": m_b1.group(4),
                          "base_string": m_b1.group(2),
                          "aliquota_pct": cof_pct}
        # ICMS: 3ª coluna da linha de item (Aliq ICMS) é >0 só se tributado; B1 pequeno = isento
        if not re.search(r"Aliq\.?\s*ICMS[\s\S]{0,400}?\b1[78],00\b", flat):
            trib["icms"] = {"valor_string": "0,00", "aliquota_pct": "0", "_fonte": "b1_isento"}
    elif m_a:
        # 3 números → Grupo A: ICMS confiável (Total Consolidado, valida base×18%).
        base_icms = m_a.group(2)
        trib["icms"] = {"valor_string": m_a.group(3), "base_string": base_icms, "aliquota_pct": "18"}
        # PIS/COFINS: NÃO há valor em R$ na fatura CPFL Grupo A (confirmado pelo usuário — a
        # fatura não traz PIS/COFINS itemizado; só o ICMS no Total Consolidado). Tratamos como
        # ISENTO/0,00 (não fabricar a partir da coluna de ICMS, que foi o bug anterior).
        trib["pis"] = {"valor_string": "0,00", "aliquota_pct": "0", "_fonte": "cpfl_a_sem_pis_cofins"}
        trib["cofins"] = {"valor_string": "0,00", "aliquota_pct": "0", "_fonte": "cpfl_a_sem_pis_cofins"}

    out = {"tributos": trib}
    return out


def extrair_cemig_tributos_fisco(texto: str, valor_total=None) -> dict:
    """Tributos do bloco 'Reservado ao Fisco' / 'Informações complementares de ICMS' da
    CEMIG (legado A4 'NOTA FISCAL - CONTA DE ENERGIA' e moderno DANF3E NF3e/B3).

    Layout legado A4: bloco com header (OCR embaralhado)
        'Base de cálculo (R$) ICMS Alíquota (%) Valor (R$) PIS Valor (R$) COFINS Valor (R$)'
      seguido de linhas de valores '<base> <aliq> <icms> [<pis> <cofins>]'. Também há
      'BC = R$<base> Alíq. = <aliq>% Valor = R$<icms>' que dá o ICMS consolidado.

    Layout NF3e/B3: bloco 'Reservado ao Fisco / SEM VALOR FISCAL /
        Base de cálculo (R$) Alíquota (%) Valor (R$)' — quando VAZIO (sem linhas de valor)
      e a UC está totalmente compensada por GD ('En comp. ISENTA' = injetada, SALDO de
      geração alto), os tributos são genuinamente ZERO/isentos → retorna i+p+c = 0,00.

    Retorna {'tributos': {icms,pis,cofins}}. fill-if-empty no caller.
    """
    def _f(s):
        try: return float(str(s).replace(".", "").replace(",", "."))
        except Exception: return None
    trib = {}
    flat = re.sub(r"[ \t]+", " ", texto)

    # (1) ICMS consolidado via 'BC = R$<base> Alíq. = <aliq>% Valor = R$<valor>'
    m_bc = re.search(r"BC\s*=\s*R\$?\s*([\d.]+,\d{2})\s+Al[íi]q\.?\s*=\s*(\d{1,2})%?\s+Valor\s*=\s*R\$?\s*([\d.]+,\d{2})", flat, re.I)
    if m_bc:
        trib["icms"] = {"base_string": m_bc.group(1), "aliquota_pct": m_bc.group(2),
                        "valor_string": m_bc.group(3), "_fonte": "cemig_bc_icms"}

    # (2) Linha de valores do bloco Fisco com 5 números '<base> <aliq=18|17|12|7> <icms> <pis> <cofins>'.
    #     A alíq de ICMS é o discriminante (inteiro 2 dígitos sem vírgula entre dois valores R$).
    m5 = re.search(r"([\d.]+,\d{2})\s+(\d{1,2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\b", flat)
    if m5:
        # valida que a alíq é plausível de ICMS (4..35) p/ não casar histórico
        aliq = int(m5.group(2))
        if 4 <= aliq <= 35:
            if not trib.get("icms"):
                trib["icms"] = {"base_string": m5.group(1), "aliquota_pct": m5.group(2),
                                "valor_string": m5.group(3), "_fonte": "cemig_fisco_row"}
            trib.setdefault("pis", {"valor_string": m5.group(4), "_fonte": "cemig_fisco_row"})
            trib.setdefault("cofins", {"valor_string": m5.group(5), "_fonte": "cemig_fisco_row"})

    # (3) Caso GD totalmente compensada (NF3e/B3): bloco Fisco presente mas SEM linha de valores,
    #     e há 'En comp.'/'Energia injetada'/'SCEE ISENTA' que zera a base tributável → i+p+c = 0,00.
    # CEMIG GD: quando o bloco Fisco está presente mas SEM linha de valores legível (nenhum
    # ICMS casado acima) E há compensação GD ('En comp.'/'Energia injetada'/'SCEE ISENTA'),
    # os tributos são genuinamente ISENTOS/ZERO — confirmado pelo usuário em faturas de até 16k
    # (energia toda compensada; o total restante é demanda/TUSD/encargo sem ICMS). → i+p+c = 0,00.
    # Não zera fatura NÃO-GD (sem 'tem_comp') — aí ICMS ausente é coluna cortada, não isenção.
    tem_fisco = bool(re.search(r"Reservado\s+ao\s+Fisco|Base\s+de\s+c[áa]lculo\s*\(R\$\)\s*Al[íi]quota", flat, re.I))
    tem_comp = bool(re.search(r"En\s+comp\.|Energia\s+injetada|SCEE\s+ISENTA|compensa[çc][ãa]o\s+de\s+energia|Energia\s+compensada", flat, re.I))
    if tem_fisco and tem_comp and not (trib.get("icms") and trib.get("pis") and trib.get("cofins")):
        for k in ("icms", "pis", "cofins"):
            if not trib.get(k):
                trib[k] = {"valor_string": "0,00", "aliquota_pct": "0", "_fonte": "cemig_gd_compensada_isento"}

    return {"tributos": trib}


def extrair_elektro_danf3e(texto: str) -> dict:
    """Elektro/Neoenergia Elektro (SP, CNPJ 02.328.280). DANF3E ACL similar ao Equatorial
    GO (itens TUSD ENERGIA PONTA/FORA, DEMANDA DE DISTRIBUICAO, SUBSIDIO TARIFARIO).
    Tributos LIMPOS no fim das linhas de item: '<PIS|COFINS|ICMS> <base> <aliq>% <valor>'.
    PIS+COFINS+ICMS separados → PROPAGAÇÃO #5.
    """
    out = {}
    flat = re.sub(r"[ \t]+", " ", texto)
    trib = {}
    for t in re.finditer(r"\b(PIS/PASEP|PIS|COFINS|ICMS)\s+([\d.]+,\d{2})\s+([\d.,]+)%\s+([\d.]+,\d{2})", flat):
        nome = t.group(1).upper()
        key = "pis" if nome.startswith("PIS") else ("cofins" if nome == "COFINS" else "icms")
        if key not in trib:
            trib[key] = {"base_string": t.group(2), "aliquota_pct": t.group(3), "valor_string": t.group(4)}
    out["tributos"] = trib
    cls = {}
    if re.search(r"HOR[ÁA]RIA\s+VERDE|\bVERDE\b", texto, re.I): cls["modalidade"] = "Verde"
    elif re.search(r"HOR[ÁA]RIA\s+AZUL|\bAZUL\b", texto, re.I): cls["modalidade"] = "Azul"
    elif re.search(r"CONVENCIONAL", texto, re.I): cls["modalidade"] = "Convencional"
    if re.search(r"\bCOMERCIAL\b", texto, re.I): cls["classe"] = "Comercial"
    elif re.search(r"\bRESIDENCIAL\b", texto, re.I): cls["classe"] = "Residencial"
    elif re.search(r"\bRURAL\b", texto, re.I): cls["classe"] = "Rural"
    elif re.search(r"\bINDUSTRIAL\b", texto, re.I): cls["classe"] = "Industrial"
    out["classificacao"] = cls
    # Total: 'Mês/AAAA R$valor venc' (mês por extenso)
    mt = re.search(r"(Janeiro|Fevereiro|Mar[çc]o|Abril|Maio|Junho|Julho|Agosto|Setembro|Outubro|Novembro|Dezembro)/(\d{4})\s+R\$\s*([\d.]+,\d{2})\s+(\d{2}/\d{2}/\d{4})", flat, re.I)
    if mt:
        out["mes_ref"] = mt.group(1) + "/" + mt.group(2); out["valor_total"] = mt.group(3); out["data_vencimento"] = mt.group(4)
    ml = re.search(r"(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+(\d{1,3})\s+(\d{2}/\d{2}/\d{4})", texto)
    if ml:
        out["leit_ant_data"] = ml.group(1); out["leit_atu_data"] = ml.group(2); out["dias"] = ml.group(3)
    return out


def extrair_neoenergia_danfe(texto: str) -> dict:
    """Neoenergia (Coelba BA / Celpe PE / família). DANFE com tabela de tributos LIMPA
    à direita: '<PIS|COFINS|ICMS> <base> <aliq> <valor>' (alíq sem %), mesmo quando o
    cabeçalho sai vertical-intercalado no pdfplumber. 2 layouts: B3 moderno
    (Consumo-TUSD/Consumo-TE + 'Imp.Som/Dim' GD) e A4 'RESERVADO AO FISCO' (Demanda
    Ativa, Consumo Ativo Ponta/FP). PIS+COFINS+ICMS separados → PROPAGAÇÃO #5.
    """
    out = {}
    flat = re.sub(r"[ \t]+", " ", texto)
    # Tributos: '<TRIB> <base> <aliq> <valor>' (alíq como 1,34 / 20,50 / 27,00 — sem %)
    trib = {}
    for t in re.finditer(r"\b(PIS|COFINS|ICMS)\s+([\d.]+,\d{2})\s+(\d{1,2},\d{2})\s+([\d.]+,\d{2})", flat):
        nome = t.group(1).upper()
        key = "pis" if nome == "PIS" else ("cofins" if nome == "COFINS" else "icms")
        if key not in trib:
            trib[key] = {"base_string": t.group(2), "aliquota_pct": t.group(3), "valor_string": t.group(4)}
    # Fallback layout antigo (2021/2022): bloco 'INFORMAÇÕES DE TRIBUTOS' / 'ICMS PIS COFINS'
    # com os valores em 3 triplets numa linha (ordem ICMS, PIS, COFINS; COFINS às vezes sem base).
    if not (trib.get("icms") and trib.get("pis") and trib.get("cofins")):
        mh = re.search(r"INFORMA[ÇC][ÕO]ES\s+DE\s+TRIBUTOS|ICMS\s+PIS\s+COFINS", flat, re.I)
        if mh:
            sub = flat[mh.end(): mh.end() + 700]
            mv = re.search(
                r"([\d.]+,\d{2})\s+(\d{1,2},\d{2})\s+([\d.]+,\d{2})\s+"      # ICMS base aliq val
                r"([\d.]+,\d{2})\s+(\d{1,2},\d{2})\s+([\d.]+,\d{2})\s+"      # PIS base aliq val
                r"(?:[\d.]+,\d{2}\s+)?(\d{1,2},\d{2})\s+([\d.]+,\d{2})",     # COFINS [base] aliq val
                sub)
            if mv:
                trib.setdefault("icms", {"base_string": mv.group(1), "aliquota_pct": mv.group(2), "valor_string": mv.group(3)})
                trib.setdefault("pis", {"base_string": mv.group(4), "aliquota_pct": mv.group(5), "valor_string": mv.group(6)})
                trib.setdefault("cofins", {"aliquota_pct": mv.group(7), "valor_string": mv.group(8)})
    out["tributos"] = trib
    # Classificação
    cls = {}
    mg = re.search(r"\b(A4|A3|A2|AS|B3|B2|B1)\b\s*(?:Horo|Comercial|Livre|Convencional|Conv|Residencial|Rural|Industrial|–|-)", texto, re.I)
    if not mg:
        mg = re.search(r"CLASSIFICA[ÇC][ÃA]O[\s\S]{0,40}?\b(A4|A3|A2|AS|B3|B2|B1)\b", texto, re.I)
    if mg: cls["subgrupo"] = mg.group(1).upper()
    if re.search(r"Horo-?sazonal\s+Verde|A4\s+Livre", texto, re.I): cls["modalidade"] = "Verde"
    elif re.search(r"Horo-?sazonal\s+Azul", texto, re.I): cls["modalidade"] = "Azul"
    elif re.search(r"Conv\.?\s*Mon[óo]mia|Convencional", texto, re.I): cls["modalidade"] = "Convencional"
    if re.search(r"\bComercial\b", texto, re.I): cls.setdefault("classe", "Comercial")
    elif re.search(r"\bResidencial\b", texto, re.I): cls.setdefault("classe", "Residencial")
    elif re.search(r"\bRural\b", texto, re.I): cls.setdefault("classe", "Rural")
    elif re.search(r"\bIndustrial\b", texto, re.I): cls.setdefault("classe", "Industrial")
    if cls.get("subgrupo", "").startswith("B") and not cls.get("modalidade"):
        cls["modalidade"] = "Convencional"
    out["classificacao"] = cls
    # Total: 'TOTAL DA FATURA <v>' (A4) ou 'TOTAL <v>' (B3)
    mtf = re.search(r"TOTAL\s+DA\s+FATURA[^\d]{0,20}([\d.]+,\d{2})", flat, re.I)
    if mtf:
        out["valor_total"] = mtf.group(1)
    else:
        mt = re.search(r"\bTOTAL\s+([\d.]+,\d{2})(?!\d)", flat)
        if mt: out["valor_total"] = mt.group(1)
    # CNPJ emissor da família
    if "15.139.629" in flat:
        out["cnpj_emissor"] = "15.139.629/0001-94"
    elif "10.835.932" in flat:
        out["cnpj_emissor"] = "10.835.932/0001-08"
    return out


def extrair_copel_danf3e(texto: str) -> dict:
    """Copel Distribuição (PR). 2 famílias: Grupo A (A4 Verde/Azul, ACL/livre) e
    Grupo B (Convencional, SCEE/GD com 'ENERGIA INJ OUC ... GDI-I'). O pdfplumber
    intercala as colunas PIS/COFINS caractere-a-caractere → só o ICMS sai limpo.
    Estratégia: ICMS da linha limpa (ou última coluna do TOTAL) + PIS/COFINS
    COMBINADO da linha TOTAL (col 2 de 3). O split 17.9/82.1 é feito depois em
    atualizar_colunas_db (mecanismo pis_cofins_agregado).
    """
    out = {}
    flat = re.sub(r"[ \t]+", " ", texto)
    # Classificação: 'A4 Comercial...' / 'B3 Comercial...' / 'B - Convencional'
    cls = {}
    mg = re.search(r"\b(A4|A3|A2|AS|B3|B2|B1|B)\s+(?:Comercial|Residencial|Rural|Industrial|Convencional|Tarifa|-)", texto, re.I)
    if mg: cls["subgrupo"] = mg.group(1).upper()
    if re.search(r"Tarifa\s+Hor[áa]ria\s+Verde|TH\s*Verde|THS[_ ]?VERDE", texto, re.I): cls["modalidade"] = "Verde"
    elif re.search(r"Tarifa\s+Hor[áa]ria\s+Azul|THS[_ ]?AZUL", texto, re.I): cls["modalidade"] = "Azul"
    elif re.search(r"\bConvencional\b", texto, re.I): cls["modalidade"] = "Convencional"
    if re.search(r"\bComercial\b", texto, re.I): cls.setdefault("classe", "Comercial")
    elif re.search(r"\bResidencial\b", texto, re.I): cls.setdefault("classe", "Residencial")
    elif re.search(r"\bRural\b", texto, re.I): cls.setdefault("classe", "Rural")
    elif re.search(r"\bIndustrial\b", texto, re.I): cls.setdefault("classe", "Industrial")
    if cls.get("subgrupo", "").startswith("B") and not cls.get("modalidade"):
        cls["modalidade"] = "Convencional"
    mf = re.search(r"Tipo de Fornecimento[:\s]*([A-Za-zÁ-Úá-ú]+)", texto, re.I)
    if mf: cls["ligacao"] = mf.group(1).title()
    out["classificacao"] = cls
    # Linha TOTAL: 'TOTAL <valor> <pis_cofins> <icms>' (pega a última ocorrência)
    tot3 = re.findall(r"\bTOTAL\b\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})", flat)
    if tot3:
        v, pc, ic = tot3[-1]
        out["valor_total"] = v; out["pis_cofins_combo"] = pc; out["icms_valor"] = ic
    else:
        tot2 = re.findall(r"\bTOTAL\b\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})", flat)
        if tot2:
            out["valor_total"] = tot2[-1][0]; out["icms_valor"] = tot2[-1][1]
    # ICMS linha limpa (preferencial p/ base/alíq)
    mi = re.search(r"\bICMS\s+([\d.]+,\d{2})\s+(\d{1,2})%\s+([\d.]+,\d{2})", flat)
    if mi:
        out["icms_base"] = mi.group(1); out["icms_aliq"] = mi.group(2); out["icms_valor"] = mi.group(3)
    # Cabeçalho: 'MM/AAAA dd/mm/aaaa R$valor'
    mh = re.search(r"\b(\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+R\$\s*([\d.]+,\d{2})", flat)
    if mh:
        out["mes_ref"] = mh.group(1); out["data_vencimento"] = mh.group(2)
        out.setdefault("valor_total", mh.group(3))
    # Período de leitura: 'dd/mm/aaaa dd/mm/aaaa <dias> dd/mm/aaaa'
    ml = re.search(r"(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+(\d{1,3})\s+(\d{2}/\d{2}/\d{4})", texto)
    if ml:
        out["leit_ant_data"] = ml.group(1); out["leit_atu_data"] = ml.group(2); out["dias"] = ml.group(3)
    return out


_CPL_LEG_MES = {"JANEIRO": "01", "FEVEREIRO": "02", "MARCO": "03", "MARÇO": "03", "ABRIL": "04",
                "MAIO": "05", "JUNHO": "06", "JULHO": "07", "AGOSTO": "08", "SETEMBRO": "09",
                "OUTUBRO": "10", "NOVEMBRO": "11", "DEZEMBRO": "12"}
# Descrições de item do legado 2022 ('Valores Faturados') — filtram as linhas válidas
_CPL_LEG_DESC = re.compile(
    r"^(ENERGIA\s+ELET[A-Z]*(?:\s+USD)?(?:\s+CONSUMO)?(?:\s+PT|\s+FP|\s+PTA|\s+F\s+PTA|\s+PONTA|\s+F\s+PONTA)?"
    r"|ENERGIA\s+ELETRICA\s+TE\s+(?:F\s+)?PONTA|ENERGIA\s+ELETRICA\s+USD\s+(?:F\s+)?PONTA"
    r"|TUSD\s+ENERGIA\s+(?:FORA\s+DE\s+)?PONTA\s+TE|ENERGIA\s+REAT\s+EXC[A-Z]*(?:\s+TE)?\s+(?:F\s+)?PONTA"
    r"|DEMANDA(?:\s+DE\s+DISTRIBUICAO)?(?:\s+DISTR)?(?:\s+USD)?(?:\s+TUSD)?(?:\s+F)?(?:\s+PONTA)?(?:\s+ISENTA\s+ICMS)?"
    r"|SUBSTITUICAO\s+TRIBUTARIA\s+CONSUM|SUBSIDIO\s+TARIFARIO[A-Z\s]*?"
    r"|CUSTO\s+DISP\s+SISTEMA|ENERGIA\s+CONS\s+B[\s.]*(?:ESCASSEZ\s+HID|AMARELA|VERMELHA)"
    r"|CONT\s+ILUMIN\s+PUBLICA\s+MUNICIPIO|COBRANCA\s+AJUSTE\s+DE\s+FATURAMEN|DEVOLUCAO\s+AJUSTE\s+DE\s+FATURAMEN"
    r"|DEDUCAO\s+ENERGIA\s+ELETRICA\s+ACL|AJUSTE\s+ICMS|SDO\s+AJUSTE\s+ICMS|RESCIS[AÃ]O\s+CONTRATUAL)",
    re.I)
_CPL_LEG_FULL = re.compile(r"[\d.]+,\d{5,6}\s+(-?[\d.]+,\d{2})")   # valor = 1º ,dd após o preço unitário (5-6 dec)
_CPL_LEG_VALONLY = re.compile(r"(-?[\d.]+,\d{2})\s*$")


def extrair_copel_legado_2022(texto: str):
    """Copel legado 2022 ('NOTA FISCAL/CONTA DE ENERGIA ELÉTRICA', tabela 'Valores Faturados').
    Layout NÃO contém 'COPEL' no corpo (cliente VIA VAREJO + FAT-01-...). O mapa=celesc deixa
    total=null. Extrai header (total/mês/venc/UC) + ICMS/base + PIS/COFINS + itens (linha com
    preço unitário 5-6 dec → valor é o 1º ,dd seguinte; linhas value-only p/ COSIP/dedução/
    subsídio líquido, inclusive NEGATIVOS). Os itens somam o total (validado gold 129157).
    Retorna {valor_total, mes_ref, data_vencimento, uc, icms_valor/base, pis, cofins, itens, soma}."""
    # router: layout 'Valores Faturados' (Grupo A) OU Grupo B antigo (header 'Descrição Un.
    # Consumo' sem 'Valores Faturados', mas com 'Valor Total da Nota Fiscal' + 'FAT-0').
    if not texto:
        return None
    _tem_vf = bool(re.search(r"Valores\s+Faturados", texto, re.I))
    if not _tem_vf and not (re.search(r"Valor\s+Total\s+da\s+Nota\s+Fiscal", texto, re.I)
                            and re.search(r"FAT-0", texto)):
        return None
    t = texto
    out = {}
    mh = re.search(r"\b(" + "|".join(_CPL_LEG_MES) + r")/(\d{4})\s+(\d{6,12})\b", t, re.I)
    if mh:
        out["mes_ref"] = f"{_CPL_LEG_MES[mh.group(1).upper()]}/{mh.group(2)}"
        out["uc"] = mh.group(3)
    mv = re.search(r"(\d{2}/\d{2}/\d{4})\s+R\$\s*([\d.]+,\d{2})", t)
    if mv:
        out["data_vencimento"] = mv.group(1); out["valor_total"] = mv.group(2)
    # bloco fiscal final: 'Valor Total da Nota Fiscal\n<base> <icms> <total>'
    mi = re.search(r"Valor\s+Total\s+da\s+Nota\s+Fiscal\s*\n?\s*([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})", t, re.I)
    if mi:
        out["icms_base"] = mi.group(1); out["icms_valor"] = mi.group(2)
        out.setdefault("valor_total", mi.group(3))
    mp = re.search(r"PIS\s+R\$\s*([\d.]+,\d{2})\s+E\s+COFINS\s+R\$\s*([\d.]+,\d{2})", t, re.I)
    if mp:
        out["pis"] = mp.group(1); out["cofins"] = mp.group(2)
    # itens: bloco 'Valores Faturados'/'Descrição Un.' → 'Base de Cá(c)lculo do ICMS'
    a = re.search(r"Valores\s+Faturados|Descri[çc][ãa]o\s+Un", t, re.I)
    reg = t
    if a:
        fim = re.search(r"Base\s+de\s+C[áa][a-z]*lculo\s+do\s+ICMS|Reservado\s+ao\s+Fisco|EXTRATO\s+DE\s+FATURAMENTO|Tarifas\s*\n",
                        t[a.end():], re.I)
        reg = t[a.end(): a.end() + (fim.start() if fim else 2500)]
    itens = []
    for ln in reg.splitlines():
        ln = ln.strip()
        md = _CPL_LEG_DESC.match(ln)
        if not md:
            continue
        mf2 = _CPL_LEG_FULL.search(ln)
        if mf2:
            valor = mf2.group(1)
        else:
            mvo = _CPL_LEG_VALONLY.search(ln)
            if mvo:
                valor = mvo.group(1)
            else:
                # Grupo B sem preço: valor = 1º ,dd após a unidade ('B.VERMELHA P2 kWh 10,60 10,60 29,00%')
                muf = re.search(r"(?:kWh|kW)\s+(-?[\d.]+,\d{2})(?!\d)", ln)
                valor = muf.group(1) if muf else None
        v = _amz_brl(valor) if valor else None
        if v is None:
            continue
        itens.append({"descricao": re.sub(r"\s+", " ", md.group(1)).strip(),
                      "valor_brl_numerico": v, "_fonte": "esp_copel_legado"})
    out["itens"] = itens
    out["soma"] = round(sum(it["valor_brl_numerico"] or 0 for it in itens), 2)
    # classe/subgrupo (p/ núcleo cadastral antiga): Grupo A se houver USD/DEMANDA/PONTA, senão B
    mcl = re.search(r"\b(COMERCIAL|RESIDENCIAL|RURAL|INDUSTRIAL|PODER\s+P[ÚU]BLICO|SERVI[ÇC]O\s+P[ÚU]BLICO)\b", t, re.I)
    if mcl:
        out["classe"] = mcl.group(1).title()
    elif re.search(r"\bVIA\s+(?:VAREJO\s+)?S[\s./]*A\b|GRUPO\s+CASAS\s+BAHIA", t, re.I):
        out["classe"] = "Comercial"   # VIA VAREJO / Casas Bahia são sempre comerciais
    if re.search(r"\bUSD\b|\bDEMANDA\b|CONSUMO\s+PTA|CONSUMO\s+F\s+PTA|HOR[ÁA]RIA\s+VERDE", t, re.I):
        out["subgrupo"] = "A4"
        out.setdefault("modalidade", "Verde")
    else:
        out["subgrupo"] = "B3"
        out.setdefault("modalidade", "Convencional")
    return out


def extrair_equatorial_norte_danfe(texto: str) -> dict:
    """Equatorial Norte (Pará/Maranhão). DANFE com tributos limpos SEM %, alíquota de
    até 4 decimais: '<PIS|COFINS|ICMS> <base> <aliq> <valor>' (ex: 'ICMS 2.547,53 23,0000
    585,93'). Cabeçalho 'GRUPO DE TENSÃO / SUBGRUPO / MODALIDADE TARIFÁRIA: A4_LVVD'.
    PIS+COFINS+ICMS separados → PROPAGAÇÃO #5.
    """
    out = {}
    flat = re.sub(r"[ \t]+", " ", texto)
    trib = {}
    for t in re.finditer(r"\b(PIS/PASEP|PIS|COFINS|ICMS)\s+([\d.]+,\d{2})\s+(\d{1,2},\d{2,4})\s+([\d.]+,\d{2})", flat):
        nome = t.group(1).upper()
        key = "pis" if nome.startswith("PIS") else ("cofins" if nome == "COFINS" else "icms")
        if key not in trib:
            trib[key] = {"base_string": t.group(2), "aliquota_pct": t.group(3), "valor_string": t.group(4)}
    out["tributos"] = trib
    cls = {}
    mg = re.search(r"SUBGRUPO:\s*(A4|A3|A2|AS|B3|B2|B1)", texto, re.I)
    if mg: cls["subgrupo"] = mg.group(1).upper()
    mm = re.search(r"MODALIDADE\s+TARIF[ÁA]RIA:\s*(\S+)", texto, re.I)
    if mm:
        mo = mm.group(1).upper()
        if "VVD" in mo or "VERDE" in mo: cls["modalidade"] = "Verde"
        elif "AZ" in mo or "AZUL" in mo: cls["modalidade"] = "Azul"
        elif "CONV" in mo: cls["modalidade"] = "Convencional"
    if re.search(r"CLASSIFICA[ÇC][ÃA]O:\s*COMERCIAL|\bCOMERCIAL\b", texto, re.I): cls.setdefault("classe", "Comercial")
    elif re.search(r"\bRESIDENCIAL\b", texto, re.I): cls.setdefault("classe", "Residencial")
    elif re.search(r"\bRURAL\b", texto, re.I): cls.setdefault("classe", "Rural")
    elif re.search(r"\bINDUSTRIAL\b", texto, re.I): cls.setdefault("classe", "Industrial")
    out["classificacao"] = cls
    return out


_CEEE_MES = ("JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ")


def extrair_ceee(texto: str):
    """CEEE / Equatorial RS — frequentemente ROTULADA como 'Equatorial Pará' no banco (coluna
    distribuidora não confiável). Layout próprio (gold doc 1): itens 'Consumo <qtd> <tar> <valor>'
    (1-2 faixas) + 'Custo Disp Sistema' + 'Adic Band. <cor> P<n> <valor>' + 'Contrib.Ilum.Pub.
    Prefeitura <valor>' que SOMAM o total. Tributos: ICMS 'Base de Cálculo ... aliquota 25/30% R$
    <valor>' e PIS/COFINS COMBINADO 'aliquota ..% R$ <valor>' (split 17.9/82.1 depois). Histórico
    12m no bloco '<ano> <MES> <dias> <consumo>,d'. Roteado por marcador de conteúdo, não pela coluna.
    Retorna {valor_total, itens, soma, icms_valor, pis_cofins_combo, classe, leit_*, historico}."""
    if not texto:
        return None
    if not re.search(r"COMPANHIA\s+ESTADUAL\s+DE\s+DISTRIBUI|DANFECEEE|Contrib\.?Ilum\.?Pub\.?Prefeitura", texto, re.I):
        return None
    t = texto
    out = {}
    mt = re.search(r"Valor\s+a\s+pagar\s+R\$\s*([\d.]+,\d{2})", t, re.I)
    if mt:
        out["valor_total"] = mt.group(1)
    # mês ref + vencimento: linha-resumo '<cons> kWh MM/AAAA DD/MM/AAAA <total>' OU 'MM/AAAA DD/MM/AAAA'
    mmv = re.search(r"(\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\b", t)
    if mmv:
        out["mes_ref"] = mmv.group(1); out["data_vencimento"] = mmv.group(2)
    mcj = re.search(r"\b(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2})\b", t)   # 1º CNPJ (topo) = emissor CEEE
    if mcj:
        out["cnpj_emissor"] = mcj.group(1)
    # razão social do cliente: linha em CAIXA seguida da UC numérica (ex.: 'JOAO ... \n1004980806')
    mrz = re.search(r"\n([A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-ZÁÉÍÓÚÂÊÔÃÕÇ0-9 ./&'\-]{5,55})\s*\n\d{8,12}\b", t)
    if mrz:
        out["razao_social"] = re.sub(r"\s+", " ", mrz.group(1)).strip()
    mdoc = re.search(r"\bCP[FJ]:\s*(\d{11,14})\b", t)   # CEEE costuma trazer 'CPF: NNNN' do cliente
    if mdoc:
        out["cpf_cliente" if len(mdoc.group(1)) == 11 else "cnpj_cliente"] = mdoc.group(1)
    itens, _vis = [], set()

    def _add(desc, val):
        # dedup por (desc,valor): texto_v2 = plumber+md+ocr+bbox (3 cópias) → itens repetidos.
        # No CEEE não há 2 itens legítimos com mesmo desc E mesmo valor → dedup é seguro.
        if val is None:
            return
        k = (desc, val)
        if k in _vis:
            return
        _vis.add(k)
        itens.append({"descricao": desc, "valor_brl_numerico": val, "_fonte": "esp_ceee"})

    # NÃO ancorado: a 1ª faixa vem mid-line ('*Consumo Lido Consumo 590 0,964339 568,96')
    for mm in re.finditer(r"\bConsumo\s+(\d[\d.]*)\s+(\d,\d{5,6})\s+(-?[\d.]+,\d{2})", t):
        _add("Consumo", _amz_brl(mm.group(3)))
    for mm in re.finditer(r"Custo\s+Disp\s+Sistema\s+\d[\d.]*\s+\d,\d{5,6}\s+(-?[\d.]+,\d{2})", t, re.I):
        _add("Custo Disp Sistema", _amz_brl(mm.group(1)))
    for mm in re.finditer(r"Adic\.?\s+Band\.?\s+\w+\.?\s*P?\d?\s+(-?[\d.]+,\d{2})", t, re.I):
        _add("Adic Bandeira", _amz_brl(mm.group(1)))
    for mm in re.finditer(r"Contrib\.?\s*Ilum\.?\s*Pub\.?\s*Prefeitura\s+(-?[\d.]+,\d{2})", t, re.I):
        _add("CIP", _amz_brl(mm.group(1)))
    out["itens"] = itens
    out["soma"] = round(sum(i["valor_brl_numerico"] or 0 for i in itens), 2)
    mi = re.search(r"ICMS\s*Base de C[áa]lculo[^\n]*?R\$\s*([\d.]+,\d{2})", t, re.I)
    if mi:
        out["icms_valor"] = mi.group(1)
    mpc = re.search(r"PIS/COFINS[^\n]*?R\$\s*([\d.]+,\d{2})", t, re.I)
    if mpc:
        out["pis_cofins_combo"] = mpc.group(1)
    if re.search(r"COMERCIAL", t, re.I):
        out["classe"] = "Comercial"
    elif re.search(r"RESIDENCIAL", t, re.I):
        out["classe"] = "Residencial"
    elif re.search(r"\bRURAL\b", t, re.I):
        out["classe"] = "Rural"
    ml = re.findall(r"Leitura\s+(\d{2}/\d{2}/\d{4})\s+\d+", t)
    if len(ml) >= 2:
        out["leit_atu_data"] = ml[0]; out["leit_ant_data"] = ml[1]
        try:
            from datetime import datetime as _dt
            dd = (_dt.strptime(ml[0], "%d/%m/%Y") - _dt.strptime(ml[1], "%d/%m/%Y")).days
            if 20 <= dd <= 40:
                out["dias"] = str(dd)
        except Exception:
            pass
    # UC / instalação: 'UC: 1004980806' OU 'Número da UC <n>'
    muc = re.search(r"\bUC:\s*(\d{6,12})\b", t) or re.search(r"N[úu]mero da UC\s*([\d.\-]+)", t, re.I)
    if muc:
        out["uc"] = re.sub(r"\D", "", muc.group(1))
    # histórico 12m: '<ano?> <MES> <dias> <consumo>,d'
    hist = []
    for mm in re.finditer(r"\b(" + "|".join(_CEEE_MES) + r")\s+\d{1,3}\s+([\d.]+),\d\b", t):
        hist.append({"mes": mm.group(1), "consumo_kwh": _amz_brl(mm.group(2))})
    if hist:
        out["historico"] = hist[:13]
    return out


def extrair_equatorial_para_danfe(texto: str):
    """Equatorial Pará REAL (CNPJ 04.895.728/0001-80, 'Conta de Energia Elétrica Série B', Belém)
    — DISTINTO do CEEE mislabeled. Layout 2020-2022 pré-NF3e: histórico só ~4 meses, itens incluem
    tributos como linha (soma não fecha trivial). Extrai total/mês/venc/instalação/classe/subgrupo/
    modalidade + tributos limpos (ICMS/PIS/COFINS base aliq% valor). Marca _fatura_antiga → núcleo
    (total+mês+classe+CNPJ) libera SKIP de histórico/soma/leitura/classif. Era a causa de ~729
    'aprovado' STALE virarem reprovado no --force (layout nunca calibrado)."""
    if not texto or not re.search(r"04\.?895\.?728/0001|Equatorial\s+Par[áa]\s+Distribuidora", texto, re.I):
        return None
    if not re.search(r"Conta\s+de\s+Energia\s+El[ée]trica|FORNECIMENTO\s+QUANTIDADE\s+TARIFA", texto, re.I):
        return None
    t = texto
    out = {}
    mt = re.search(r"Total\s+a\s+pagar:?\s*R\$\s*([\d.]+,\d{2})", t, re.I)
    if mt:
        out["valor_total"] = mt.group(1)
    mv = re.search(r"(\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+\d{6,}", t)   # 'mes venc conta_contrato'
    if mv:
        out["mes_ref"] = mv.group(1); out["data_vencimento"] = mv.group(2)
    mi = re.search(r"Instala[çc][ãa]o\s+(\d{6,12})", t, re.I)
    if mi:
        out["instalacao"] = mi.group(1)
    if re.search(r"Comerc", t, re.I): out["classe"] = "Comercial"
    elif re.search(r"Residencial", t, re.I): out["classe"] = "Residencial"
    elif re.search(r"\bRural\b", t, re.I): out["classe"] = "Rural"
    elif re.search(r"Industrial", t, re.I): out["classe"] = "Industrial"
    msg = re.search(r"Subgrupo\s+de\s+Tens[ãa]o:\s*[AB]\s*/\s*(A[1-4]|B[1-4]|AS)", t, re.I)
    if msg:
        out["subgrupo"] = msg.group(1).upper()
    if re.search(r"CONVENCIONAL", t, re.I): out["modalidade"] = "Convencional"
    elif re.search(r"HOR[ÁA]RIA?\s+VERDE|HORO\s+VERDE", t, re.I): out["modalidade"] = "Verde"
    elif re.search(r"HOR[ÁA]RIA?\s+AZUL|HORO\s+AZUL", t, re.I): out["modalidade"] = "Azul"
    trib = {}
    for m in re.finditer(r"\b(PIS|COFINS|ICMS)\s+([\d.]+,\d{2})\s+(\d{1,2},\d{1,4})%\s+([\d.]+,\d{2})", t):
        k = "pis" if m.group(1) == "PIS" else ("cofins" if m.group(1) == "COFINS" else "icms")
        trib.setdefault(k, {"base_string": m.group(2), "aliquota_pct": m.group(3), "valor_string": m.group(4)})
    out["tributos"] = trib
    return out


def extrair_equatorial_para_nf3e(texto: str):
    """Equatorial Pará NF3e MODERNO ('DANF3E DOCUMENTO AUXILIAR', CNPJ 04.895.728, 'Itens de Fatura').
    DISTINTO do Série B (pré-NF3e) e do CEEE. Grupo B/A. total 'Total a Pagar R$', itens (Consumo
    valor=última coluna + CIP + Multa + Juros, que SOMAM o total), tributos LIMPOS (ICMS/PIS/COFINS
    base aliq valor) + icms/pis_cofins líquido = valor (consistente → tributos PASS), histórico 12m,
    classe/subgrupo, leitura. NÃO antiga (NF3e 2022+). Recupera o maior chunk dos reprovado Pará."""
    if not texto or not re.search(r"04\.?895\.?728/0001|Equatorial\s+Par[áa]\s+Distribuidora", texto, re.I):
        return None
    if not re.search(r"DANF3E|Itens\s+de\s+Fatura", texto, re.I):
        return None
    t = texto
    out = {}
    mt = re.search(r"Total\s+a\s+Pagar[\s\S]{0,80}?R\$\s*([\d.]+,\d{2})", t, re.I)
    if mt:
        out["valor_total"] = mt.group(1)
    mmv = re.search(r"\n(\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+R\$", t)
    if mmv:
        out["mes_ref"] = mmv.group(1); out["data_vencimento"] = mmv.group(2)
    mi = re.search(r"INSTALA[ÇC][ÃA]O:\s*(\d{6,12})", t, re.I)
    if mi:
        out["instalacao"] = mi.group(1)
    ml = re.search(r"(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+(\d{1,3})\s+(\d{2}/\d{2}/\d{4})", t)
    if ml:
        out["leit_ant_data"] = ml.group(1); out["leit_atu_data"] = ml.group(2); out["dias"] = ml.group(3)
    if re.search(r"Comerc", t, re.I): out["classe"] = "Comercial"
    elif re.search(r"Residencial", t, re.I): out["classe"] = "Residencial"
    elif re.search(r"\bRural\b", t, re.I): out["classe"] = "Rural"
    elif re.search(r"Industrial", t, re.I): out["classe"] = "Industrial"
    msg = re.search(r"Subgrupo\s+de\s+Tens[ãa]o:?\s*[AB]\s*/\s*(A[1-4]|B[1-4]|AS)", t, re.I)
    out["subgrupo"] = msg.group(1).upper() if msg else ("B3" if not re.search(r"\bDemanda\b", t, re.I) else "A4")
    # modalidade: 'Tipo de Tarifa: A4_VD' (VD=Verde, AZ=Azul, CV=Convencional, BR=Branca)
    mtt = re.search(r"Tipo\s+de\s+Tarifa:\s*[AB]\d?_?(VD|AZ|CV|BR|VERDE|AZUL)", t, re.I)
    if mtt:
        _md = mtt.group(1).upper()
        out["modalidade"] = {"VD": "Verde", "VERDE": "Verde", "AZ": "Azul", "AZUL": "Azul",
                             "CV": "Convencional", "BR": "Branca"}.get(_md, _md)
    trib = {}
    for m in re.finditer(r"\b(PIS|COFINS|ICMS)\s+([\d.]+,\d{2})\s+(\d{1,2},\d{1,4})\s+([\d.]+,\d{2})", t):
        k = "pis" if m.group(1) == "PIS" else ("cofins" if m.group(1) == "COFINS" else "icms")
        trib.setdefault(k, {"base_string": m.group(2), "aliquota_pct": m.group(3), "valor_string": m.group(4)})
    out["tributos"] = trib
    # itens: tabela 'Itens de Fatura' — Grupo B (Consumo) E Grupo A (Consumo FP/P, Demanda
    # Ativa/Isenta, Reativo Exced., Adic. Bandeira). valor = ÚLTIMA coluna monetária da linha.
    # + financeiros (CIP/Multa/Juros). Os itens SOMAM o total (validado 117720 = 19.170,18).
    itens = []
    _reg = t
    _ms = re.search(r"Itens\s+de\s+Fatura", t, re.I)
    _me = re.search(r"ITENS\s+FINANCEIROS|Medidor\s+Grandeza|Reservado\s+ao\s+Fisco", t, re.I)
    if _ms:
        _reg = t[_ms.end(): (_me.start() if _me else _ms.end() + 1500)]
    # genérico: cada linha da região de itens com unidade '(kWh)/(kW)/(kVAr)' é um item.
    # desc = texto antes da unidade; valor = ÚLTIMA coluna monetária após a unidade (truncada
    # onde começam tributos/Grandezas). Pula 'Demanda Contratada/Reserva/Geração/Dist./Máx'
    # (grandezas contratadas, não itens) e o cabeçalho '(R$)'. Cobre Verde (Demanda Ativa) e
    # Azul (Demanda Ponta/Fora Ponta/NP/FP Isenta de ICMS) num só caminho.
    _seen = set()
    _grupo_a = False
    for _ln in _reg.splitlines():
        _um = re.search(r"\((?:kWh|kVArh|kVAr|kW)\)", _ln, re.I)
        if _um:
            _desc = re.sub(r"\s+", " ", _ln[:_um.start()]).strip()
            _tail = _ln[_um.end():]
        elif re.search(r"Adicional\s+Bandeira", _ln, re.I):
            # item SEM unidade ('Adicional Bandeira 90,49 966,33 3.865,30')
            _bm = re.search(r"Adicional\s+Bandeira", _ln, re.I)
            _desc = "Adicional Bandeira"
            _tail = _ln[_bm.end():]
        else:
            continue
        if not _desc or re.search(r"Contratad|Reserva|Gera[çc][ãa]o|\bDist\.|M[áa]x\.|^Itens\s+de\s+Fatura", _desc, re.I):
            continue
        _tcut = re.search(r"\s(?:PIS|COFINS|ICMS|Grandezas|Tributo|Base|Demanda\s+Contratad|Dem\.)\b", _tail)
        if _tcut:
            _tail = _tail[:_tcut.start()]
        _vals = re.findall(r"[\d.]+,\d{2}", _tail)
        if not _vals:
            continue
        _v = _amz_brl(_vals[-1])
        _key = _desc.lower()
        if _v is not None and _v > 0 and _key not in _seen:
            itens.append({"descricao": _desc, "valor_brl_numerico": _v, "_fonte": "esp_eqpa_nf3e"})
            _seen.add(_key)
            if re.search(r"Demanda", _desc, re.I):
                _grupo_a = True
    out["grupo_a"] = _grupo_a
    for pat, desc in [(r"Cip-?Ilum\s+Pub\s+Pref\s+Munic\s+([\d.]+,\d{2})", "CIP"),
                      (r"(?<![A-Za-z])Multa\s+([\d.]+,\d{2})", "Multa"),
                      (r"(?<![A-Za-z])Juros\s+([\d.]+,\d{2})", "Juros")]:
        m2 = re.search(pat, t, re.I)
        if m2 and desc not in _seen:
            itens.append({"descricao": desc, "valor_brl_numerico": _amz_brl(m2.group(1)), "_fonte": "esp_eqpa_nf3e"})
            _seen.add(desc)
    out["itens"] = itens
    out["soma"] = round(sum(i["valor_brl_numerico"] or 0 for i in itens), 2)
    # histórico mensal só no Grupo B; Grupo A NF3e imprime só 'Média dos 12 meses' (sem tabela)
    # → não emite histórico espúrio (evita capturar 'EscassezHídrica MAR/22' como mês).
    if not _grupo_a:
        hist = []
        for m in re.finditer(r"\b([A-Z]{3}/\d{2})\s+(\d{1,6})\b", t):
            hist.append({"mes": m.group(1)[:3], "consumo_kwh": _amz_brl(m.group(2))})
        if hist:
            out["historico"] = hist[:13]
    return out


def extrair_equatorial_go_acl(texto: str) -> dict:
    """Equatorial GO A4 THS_VERDE Livre (PCH50/ACL, mercado livre). O mapa equatorial não
    extrai este layout (modalidade null → reprovado). Pega classificação, tributos
    (PIS/PASEP/ICMS/COFINS no texto achatado — vêm colados com itens), total do cabeçalho
    (2 ordens: valor-antes-venc OU venc-antes-valor) e leitura.
    """
    out = {}
    flat = re.sub(r"\s+", " ", texto)
    # Classificação: 'Classificação: A A4 ... THS_VERDE ... Tipo de Fornecimento: TRIFÁSICO'
    cls = {}
    mg = re.search(r"Classifica[çc][ãa]o:\s*A\s+(A\d|AS|B\d)\b", texto, re.I)
    if mg: cls["subgrupo"] = mg.group(1).upper()
    mm = re.search(r"(THS_VERDE|THS_AZUL|CONVENCIONAL|BRANCA|VERDE|AZUL)", texto, re.I)
    if mm:
        mo = mm.group(1).upper()
        cls["modalidade"] = "Verde" if "VERDE" in mo else ("Azul" if "AZUL" in mo else mo.replace("THS_", "").title())
    if re.search(r"\bCOMERCIAL\b", texto, re.I): cls.setdefault("classe", "Comercial")
    elif re.search(r"\bRESIDENCIAL\b", texto, re.I): cls.setdefault("classe", "Residencial")
    elif re.search(r"\bRURAL\b", texto, re.I): cls.setdefault("classe", "Rural")
    mf = re.search(r"Tipo de Fornecimento:\s*([A-ZÁ-Ú]+)", texto, re.I)
    if mf: cls["ligacao"] = mf.group(1).title()
    out["classificacao"] = cls
    # Tributos (texto achatado — COFINS às vezes cola no fim do 1º item)
    trib = {}
    for t in re.finditer(r"\b(PIS/PASEP|ICMS|COFINS)\s+([\d.,]+)\s+([\d.,]+)%\s+([\d.,]+)", flat):
        nome = t.group(1).upper()
        key = "pis" if "PIS" in nome else ("cofins" if "COFINS" in nome else "icms")
        if key not in trib:
            trib[key] = {"base_string": t.group(2), "aliquota_pct": t.group(3), "valor_string": t.group(4)}
    out["tributos"] = trib
    # Resumo: 2 ordens — 'MES/AAAA R$***valor venc' OU 'MES/AAAA venc R$***valor'
    mtot = re.search(r"((?:JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/\d{4})\s+R\$\*+([\d.,]+)\s+(\d{2}/\d{2}/\d{4})", flat)
    if mtot:
        out["mes_ref"] = mtot.group(1); out["valor_total"] = mtot.group(2); out["data_vencimento"] = mtot.group(3)
    else:
        m2 = re.search(r"((?:JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+R\$\*+([\d.,]+)", flat)
        if m2: out["mes_ref"] = m2.group(1); out["data_vencimento"] = m2.group(2); out["valor_total"] = m2.group(3)
    # Período de leitura: 'dd/mm/aaaa dd/mm/aaaa dias dd/mm/aaaa'
    ml = re.search(r"(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+(\d{1,3})\s+(\d{2}/\d{2}/\d{4})", texto)
    if ml: out["leit_ant_data"] = ml.group(1); out["leit_atu_data"] = ml.group(2); out["dias"] = ml.group(3)
    return out


def extrair_light_acl(texto: str) -> dict:
    """Light RJ A4/AS Verde ACL/CCEE (mercado livre, cod_empresa 4). Layout de componentes
    Fio/Encargo + descontos CCEE; o mapa light não extrai classificação/tributos deste layout.
    Pega: classificação (grupo A4/AS, modalidade, classe, ligação), tributos (PIS/PASEP,
    COFINS, ICMS da linha TOTAL), componentes Fio/Encargo HFP/HP, descontos, reativo, e o
    total do CABEÇALHO (não o do manifesto/pipeline, que vem inflado).
    """
    def _f(s):
        try: return float(str(s).replace(".", "").replace(",", "."))
        except Exception: return None
    out = {}

    # Classificação: 'Grupo A4 / A4 - Verde / Comercial / <classe2> TRIFÁSICO'
    cls = {}
    m = re.search(r"Grupo\s+(A4|AS|A3|A2|A1|B\d)\s*/\s*[A-Z0-9]+\s*-\s*(Verde|Azul|Branca|Convencional)\s*/\s*([^/\n]+?)\s*/", texto, re.I)
    if m:
        cls["subgrupo"] = m.group(1).upper(); cls["modalidade"] = m.group(2).title()
        cls["classe"] = m.group(3).strip()[:40]
    else:
        m2 = re.search(r"Grupo\s+(A4|AS|A3|A2|A1|B\d)\s*/\s*[A-Z0-9]+\s*-\s*(Verde|Azul|Branca|Convencional)", texto, re.I)
        if m2: cls["subgrupo"] = m2.group(1).upper(); cls["modalidade"] = m2.group(2).title()
        else:
            # legacy 2022: 'Comercial Outros Serviços e Outras Ativ A4 01 THS Verde A4'
            m3 = re.search(r"THS\s+(Verde|Azul)\s+(A\d|AS)", texto, re.I)
            if m3: cls["modalidade"] = m3.group(1).title(); cls["subgrupo"] = m3.group(2).upper()
        if re.search(r"\bComercial\b", texto): cls.setdefault("classe", "Comercial")
    if re.search(r"TRIF[ÁA]SICO", texto, re.I): cls["ligacao"] = "Trifásico"
    elif re.search(r"BIF[ÁA]SICO", texto, re.I): cls["ligacao"] = "Bifásico"
    elif re.search(r"MONOF[ÁA]SICO", texto, re.I): cls["ligacao"] = "Monofásico"
    out["classificacao"] = cls

    # Tributos: linha 'TOTAL <pis_cofins> <base_icms> <icms>' + PIS/PASEP e COFINS.
    # Em valores altos os números COLAM (ex.: 'TOTAL 7.563,13144.224,45 34.613,87',
    # 'PIS/PASEP109.610,581,23% 1.348,21') → pega o ÚLTIMO número da linha (= valor).
    trib = {}
    mt = re.search(r"\bTOTAL\b.*?([\d.]+,\d{2})\s*$", texto, re.M)
    if mt:
        # tenta base ICMS (penúltimo) só na versão espaçada
        mb = re.search(r"\bTOTAL\s+[\d.]+,\d{2}\s+([\d.]+,\d{2})\s+[\d.]+,\d{2}\s*$", texto, re.M)
        trib["icms"] = {"base_string": (mb.group(1) if mb else None), "valor_string": mt.group(1), "_fonte": "light_total_linha"}
    mp = re.search(r"PIS/PASEP.*?([\d.]+,\d{2})\s*$", texto, re.I | re.M)
    if mp: trib["pis"] = {"valor_string": mp.group(1)}
    mc = re.search(r"\bCOFINS\b.*?([\d.]+,\d{2})\s*$", texto, re.I | re.M)
    if mc: trib["cofins"] = {"valor_string": mc.group(1)}
    # legacy 2022: ICMS na linha 'base ALIQ% icms' (ex.: '164.101,51 32% 52.512,48'); sem PIS/COFINS
    if "icms" not in trib:
        mi = re.search(r"([\d.]+,\d{2})\s+(\d{1,2})%\s+([\d.]+,\d{2})", texto)
        if mi: trib["icms"] = {"base_string": mi.group(1), "aliquota_pct": mi.group(2), "valor_string": mi.group(3), "_fonte": "light_legacy_icms"}
    out["tributos"] = trib

    # Total do cabeçalho: 'MAR/2026 10/04/2026 R$15.435,95' (NÃO usar o do manifesto)
    mh = re.search(r"(?:JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/\d{4}\s+\d{2}/\d{2}/\d{4}\s+R\$\s*([\d.]+,\d{2})", texto)
    if mh: out["valor_total"] = mh.group(1)

    # Cabeçalho LEGACY 2022 (header embaralhado, sem 'R$' limpo): mes_ref, vencimento, total, leitura
    mr = re.search(r"\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/(\d{4})\b", texto)
    if mr and not out.get("mes_ref"): out["mes_ref"] = f"{mr.group(1)}/{mr.group(2)}"
    # linha de total legacy: '****164.101,51 0,00 11/03/2022 **********0,00'
    mv = re.search(r"\*{2,}[\d.]+,\d{2}\s+[\d.,]+\s+(\d{2}/\d{2}/\d{4})\s+\*+([\d.]+,\d{2})", texto)
    if mv:
        out["data_vencimento"] = mv.group(1)
        if not out.get("valor_total"): out["valor_total"] = mv.group(2)
    # leitura legacy: '... 02/03/2022 31/01/2022 31/12/2021 31 90 ...' → atu, ant, dias
    ml = re.search(r"(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+(\d{1,3})\s+\d", texto)
    if ml:
        out["leit_atu_data"] = ml.group(1); out["leit_ant_data"] = ml.group(2); out["dias"] = ml.group(3)

    # Componentes (Fio/Encargo HFP/HP) + reativo — qtd e valor (pra view/itens)
    comp = {}
    for rgx, key in [
        (r"Componente\s+Fio\s+kW\s+HFP\s+kW\s+([\d.]+)\s+[\d.,]+\s+([\d.]+,\d{2})", "componente_fio_hfp_kw"),
        (r"Componente\s+Encargo\s+kWh\s+HFP\s+kWh\s+([\d.]+)\s+[\d.,]+\s+([\d.]+,\d{2})", "componente_encargo_hfp_kwh"),
        (r"Componente\s+Encargo\s+kWh\s+HP\s+kWh\s+([\d.]+)\s+[\d.,]+\s+([\d.]+,\d{2})", "componente_encargo_hp_kwh"),
        (r"Ultrapassagem\s+C\.\s*Fio\s+kW\s+HFP\s+kW\s+([\d.]+)\s+[\d.,]+\s+([\d.]+,\d{2})", "ultrapassagem_fio_hfp_kw"),
    ]:
        mm = re.search(rgx, texto, re.I)
        if mm:
            comp[key] = _f(mm.group(1)); comp[key.replace("_kw", "_rs").replace("_kwh", "_rs")] = _f(mm.group(2))
    out["componentes"] = comp
    return out


def extrair_cemig_atende_classico(texto: str) -> dict:
    """CEMIG layout clássico 'Cemig Atende' (B3 GD/SCEE, VIA VAREJO/comercial, ~2021).
    O mapa CEMIG (DANF3E moderno) não extrai este layout — aqui pegamos classe/modalidade,
    medição, tributos (ICMS/PASEP/COFINS), histórico 13m e GD (saldo/compensada/injetada).
    Marcadores: 'Cemig Atende'/'cemigatende.com.br'/'Ouvidoria CEMIG'.
    """
    def _f(s):
        try: return float(str(s).replace(".", "").replace(",", "."))
        except Exception: return None
    def _i(s):
        try: return int(str(s).replace(".", ""))
        except Exception: return None
    out = {}

    # Medição: 'Energia kWh <MEDIDOR> <ant> <atu> <const> <consumo>'
    m = re.search(r"Energia\s+kWh\s+([A-Z]{2,4}\d{6,})\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+([\d.]+)", texto)
    if m:
        out["medidor"] = m.group(1); out["leit_ant"] = _i(m.group(2)); out["leit_atu"] = _i(m.group(3))
        out["constante"] = _i(m.group(4)); out["consumo_kwh"] = _i(m.group(5))

    # Classificação (classe pode vir letter-spaced no scramble → tolerante)
    cls = {}
    if re.search(r"C\s?o\s?m\s?e\s?r\s?c\s?i\s?a\s?l", texto, re.I): cls["classe"] = "Comercial"
    elif re.search(r"R\s?e\s?s\s?i\s?d\s?e\s?n\s?c\s?i\s?a\s?l", texto, re.I): cls["classe"] = "Residencial"
    mm = re.search(r"(Convencional|Horo[\- ]?sazonal|Verde|Azul)\s+(B\d|A\d[A-Z]?)", texto, re.I)
    if mm: cls["modalidade"] = mm.group(1).title(); cls["subgrupo"] = mm.group(2).upper()
    if re.search(r"Trif[áa]sico", texto, re.I): cls["ligacao"] = "Trifásico"
    elif re.search(r"Bif[áa]sico", texto, re.I): cls["ligacao"] = "Bifásico"
    elif re.search(r"Monof[áa]sico", texto, re.I): cls["ligacao"] = "Monofásico"
    out["classificacao"] = cls

    # Datas de leitura: 'Anterior Atual Próxima\n dd/mm dd/mm dd/mm' (3 datas dd/mm)
    dts = re.findall(r"\b(\d{2}/\d{2})\b", texto)
    if len(dts) >= 2:
        out["leit_ant_data"] = dts[0]; out["leit_atu_data"] = dts[1]

    # Tributos: 'ICMS base aliq valor' / 'PASEP ...' / 'COFINS ...'
    trib = {}
    for nome, key in [("ICMS", "icms"), ("PASEP", "pis"), ("PIS", "pis"), ("COFINS", "cofins")]:
        t = re.search(nome + r"\s+([\d.]+,\d+)\s+([\d.,]+)\s+([\d.]+,\d+)", texto)
        if t and key not in trib:
            trib[key] = {"base_string": t.group(1), "aliquota_pct": t.group(2), "valor_string": t.group(3)}
    out["tributos"] = trib

    # Histórico: 'MES/AA consumo media dias'
    hist = []
    for h in re.finditer(r"\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)/(\d{2})\s+([\d.]+)\s+([\d.]+,\d+)\s+(\d+)\b", texto):
        hist.append({"mes": h.group(1), "ano": 2000 + int(h.group(2)),
                     "consumo_kwh": _i(h.group(3)), "dias_ciclo": _i(h.group(5))})
    out["historico"] = hist

    # GD: saldo / energia compensada / energia injetada (negativa)
    gd = {}
    sg = re.search(r"SALDO\s+ATUAL\s+DE\s+GERA[ÇC][ÃA]O\s*:?\s*([\d.,]+)\s*kWh\s+FP[^\d]*?([\d.,]+)\s*kWh\s+ponta", texto, re.I | re.S)
    if sg: gd["saldo_fp_kwh"] = _f(sg.group(1)); gd["saldo_ponta_kwh"] = _f(sg.group(2))
    # legacy 2021: 'En comp. kWh ISENTA <qtd> <tarifa> <valor>' / 'Energia injetada kWh HFP <qtd> <tarifa> -<valor>'
    ec = re.search(r"En\s+comp\.\s+kWh\s+ISENTA\s+([\d.]+)\s+[\d.,]+\s+([\d.]+,\d+)", texto, re.I)
    if ec: gd["energia_compensada_kwh"] = _i(ec.group(1)); gd["valor_compensado_rs"] = _f(ec.group(2))
    ej = re.search(r"Energia\s+injetada\s+kWh\s+HFP\s+([\d.]+)\s+[\d.,]+\s+-?([\d.]+,\d+)", texto, re.I)
    if ej: gd["energia_injetada_kwh"] = _i(ej.group(1))
    # moderno NF3e: 'Energia SCEE ISENTA kWh <qtd> <tarifa> <valor>' / 'Energia compensada GD I kWh <qtd> <tarifa> -<valor>'
    if "energia_compensada_kwh" not in gd:
        ec2 = re.search(r"Energia\s+SCEE\s+ISENTA\s+kWh\s+([\d.]+)\s+[\d.,]+\s+([\d.]+,\d+)", texto, re.I)
        if ec2: gd["energia_compensada_kwh"] = _i(ec2.group(1)); gd["valor_compensado_rs"] = _f(ec2.group(2))
    if "energia_injetada_kwh" not in gd:
        ej2 = re.search(r"Energia\s+compensada\s+GD\s*I+\s+kWh\s+([\d.]+)\s+[\d.,]+\s+-?([\d.]+,\d+)", texto, re.I)
        if ej2: gd["energia_injetada_kwh"] = _i(ej2.group(1))
    out["gd"] = gd
    return out


def extrair_energisa_mt_extras(texto: str) -> dict:
    """Extrai campos específicos Energisa MT (rural/agropecuária):
      - perda_ramal_kwh:   'Perda do Ramal: 78 kWh'
      - subvencao_rs:      'Subvenção DEC.2290/14 R$ 261,56' (subsídio rural)
      - data_pagamento:    'CONTA PAGA - Data de Pagamento: 15/06/2022'
      - status_pagamento:  'CONTA PAGA' → 'PAGA'  (ausente → None)
    """
    out = {}

    m = re.search(r"Perda\s+do\s+Ramal\s*:?\s*(\d+(?:[.,]\d+)?)\s*kWh", texto, re.I)
    if m:
        try:
            out["perda_ramal_kwh"] = float(m.group(1).replace(".", "").replace(",", "."))
        except ValueError:
            pass

    m = re.search(r"Subven[çc][ãa]o\s+DEC[.\d/\-\s]*\s+R\$\s*([\d.,]+)", texto, re.I)
    if m:
        try:
            out["subvencao_rs"] = float(m.group(1).replace(".", "").replace(",", "."))
        except ValueError:
            pass

    m = re.search(r"CONTA\s+PAGA\s*[-–]\s*Data\s+de\s+Pagamento\s*:?\s*(\d{2}/\d{2}/\d{4})", texto, re.I)
    if m:
        out["data_pagamento"] = m.group(1)
        out["status_pagamento"] = "PAGA"
    elif re.search(r"\bCONTA\s+PAGA\b", texto, re.I):
        out["status_pagamento"] = "PAGA"

    return out


def extrair_demandas_medida_complementar(texto: str) -> dict:
    """Extrai 'Demanda de Potência Medida' e 'Demanda Complementar' por posto (Grupo A).
    Estrutura típica Energisa:
       'Demanda de Potência Medida - Fora Ponta KW 480,90 36,621010 17.611,04 ...'
       'Demanda Complementar - F. Ponta KW 2.971,00 90.304,86 ...'  (qtd_kw + valor_total_rs)
    Retorna {medida_p_kw, medida_fp_kw, complementar_p_kw, complementar_fp_kw, complementar_valor_rs}.
    """
    out = {}
    def _f(s):
        try: return float(s.replace(".","").replace(",",".")) if s else None
        except: return None

    # Demanda Medida — só qtd kW (2ª col é tarifa, 3ª valor; pegamos só qtd)
    for pat, key in [
        (r"Demanda\s+de\s+Pot[êe]ncia\s+Medida\s*-\s*Fora\s+Ponta\s+(?:KW\s+)?([\d.,]+)", "demanda_medida_fp_kw"),
        (r"Demanda\s+de\s+Pot[êe]ncia\s+Medida\s*-\s*Ponta\s+(?:KW\s+)?([\d.,]+)", "demanda_medida_p_kw"),
        # variante sem hífen "Demanda Medida"
        (r"Demanda\s+Medida\s*-?\s*Fora\s+Ponta\s+(?:KW\s+)?([\d.,]+)", "demanda_medida_fp_kw"),
        (r"Demanda\s+Medida\s*-?\s*Ponta\s+(?:KW\s+)?([\d.,]+)", "demanda_medida_p_kw"),
    ]:
        if key not in out:
            m = re.search(pat, texto, re.I)
            if m:
                v = _f(m.group(1))
                if v is not None: out[key] = v

    # Demanda Complementar — qtd kW + valor_brl (2ª coluna numérica significativa)
    for pat, k_qtd, k_val in [
        (r"Demanda\s+Complementar\s*-\s*F\.?\s*Ponta\s+(?:KW\s+)?([\d.,]+)\s+([\d.,]+)",
         "demanda_complementar_fp_kw", "demanda_complementar_fp_rs"),
        (r"Demanda\s+Complementar\s*-\s*Fora\s+Ponta\s+(?:KW\s+)?([\d.,]+)\s+([\d.,]+)",
         "demanda_complementar_fp_kw", "demanda_complementar_fp_rs"),
        (r"Demanda\s+Complementar\s*-\s*Ponta\s+(?:KW\s+)?([\d.,]+)\s+([\d.,]+)",
         "demanda_complementar_p_kw", "demanda_complementar_p_rs"),
    ]:
        if k_qtd not in out:
            m = re.search(pat, texto, re.I)
            if m:
                v_q = _f(m.group(1))
                v_r = _f(m.group(2))
                if v_q is not None: out[k_qtd] = v_q
                if v_r is not None: out[k_val] = v_r

    # Demanda (de Potência) Não Consumida — só qtd kW (separador hífen opcional,
    # posto "F Ponta"/"Fora Ponta"/"Fponta"). GD_I rural: pode ter ICMS 0; explica
    # total alto sem consumo ativo faturado (sublayouts GGF Agro 17B/19B).
    for pat, key in [
        (r"Demanda\s+(?:(?:de\s+)?Pot[êe]ncia\s+)?N[ãa]o\s+Consumida\s*-?\s*F(?:\.|ora)?\s*Ponta\s+(?:KW\s+)?([\d.,]+)", "demanda_nao_consumida_fp_kw"),
        (r"Demanda\s+(?:(?:de\s+)?Pot[êe]ncia\s+)?N[ãa]o\s+Consumida\s*-?\s*Fponta\s+(?:KW\s+)?([\d.,]+)", "demanda_nao_consumida_fp_kw"),
        (r"Demanda\s+(?:(?:de\s+)?Pot[êe]ncia\s+)?N[ãa]o\s+Consumida\s*-?\s*Ponta\s+(?:KW\s+)?([\d.,]+)", "demanda_nao_consumida_p_kw"),
    ]:
        if key not in out:
            m = re.search(pat, texto, re.I)
            if m:
                v = _f(m.group(1))
                if v is not None: out[key] = v

    return out


def extrair_energisa_mt_rural_gd_extras(texto: str) -> dict:
    """Campos rurais Energisa MT GD_I / irrigante (sublayouts GGF Agro 2023–2025).

      - credito_anterior_referencia / credito_anterior_rs:  'CREDITO ANTERIOR 03/2025 ... 1.234,56'
      - bonus_itaipu_rs:       'BONUS ITAIPU - LEI 10438/2002 ... -123,45' (irrigante)
      - devolucao_subsidio_rs: 'Devolução Subsídio ... 62,93'
      - consumo_reservado_kwh: 'Consumo em kWh Reservado ... 415,74' (irrigante, posto reservado)

    Best-effort: só seta quando casa. Crédito anterior é FINANCEIRO (separado da
    energia compensada GD). Valores podem vir negativos no fechamento.
    """
    out = {}
    def _f(s):
        try: return float(s.replace(".", "").replace(",", ".")) if s else None
        except Exception: return None

    # CRÉDITO ANTERIOR MM/AAAA — referência + 1º valor monetário na linha
    m = re.search(r"CR[ÉE]DITO\s+ANTERIOR\s+(\d{2}/\d{4})\D{0,40}?(-?[\d.]+,\d{2})", texto, re.I)
    if m:
        out["credito_anterior_referencia"] = m.group(1)
        v = _f(m.group(2))
        if v is not None: out["credito_anterior_rs"] = v
    else:
        m = re.search(r"CR[ÉE]DITO\s+ANTERIOR\s+(\d{2}/\d{4})", texto, re.I)
        if m: out["credito_anterior_referencia"] = m.group(1)

    # BÔNUS ITAIPU — valor R$ é o ÚLTIMO monetário da linha ([^\n]* greedy pula qtd kWh)
    m = re.search(r"B[ÔO]NUS\s+ITAIPU[^\n]*\s(-?[\d.]+,\d{2})(?!\S)", texto, re.I)
    if m:
        v = _f(m.group(1))
        if v is not None: out["bonus_itaipu_rs"] = v

    # Devolução Subsídio — último monetário da linha (distinto de 'Subvenção DEC.2290/14')
    m = re.search(r"Devolu[çc][ãa]o\s+Subs[íi]dio[^\n]*\s(-?[\d.]+,\d{2})(?!\S)", texto, re.I)
    if m:
        v = _f(m.group(1))
        if v is not None: out["devolucao_subsidio_rs"] = v

    # Consumo em kWh Reservado — qtd kWh (1ª número após o rótulo)
    m = re.search(r"Consumo\s+em\s+kWh\s+Reservado\D{0,30}?([\d.]+(?:,\d+)?)", texto, re.I)
    if m:
        v = _f(m.group(1))
        if v is not None: out["consumo_reservado_kwh"] = v

    return out


def extrair_flag_telemetria(texto: str) -> dict:
    """Detecta 'TELEMETRIA C/...' no bloco Atenção (Energisa MT — indicador de demanda complementar).

    Variantes observadas:
      - TELEMETRIA C/PERDA DE PARÂMETRO
      - TELEMETRIA C/POSSIVEL PERDA DE PARÂMETRO
      - TELEMETRIA C/MEDIDOR C/POSSIVEL DEFEITO
    """
    out = {}
    # Pega enquanto for maiúsculo/espaço/separadores (a observação vem em CAIXA ALTA;
    # texto seguinte da mesma linha é minúsculo descritivo — corta nele).
    m = re.search(r"TELEMETRIA[ \t]+C[/\\][A-ZÀ-Ÿ0-9 \t/\\.,\-]{3,80}", texto)
    if m:
        out["flag_telemetria_perda"] = True
        # Limpa trailing whitespace / pontuação solta
        out["motivo_atencao_telemetria"] = re.sub(r"[\s\-,.]+$", "", m.group(0).strip())[:200]
    return out


def extrair_taxa_perda(texto: str) -> dict:
    """Captura taxa/fator de perda de transformação (%) quando há VALOR.

    Formatos observados:
      - Enel SP: 'PERDA DE TRANSFORMAÇÃO - 2,5%'
      - genéricos: 'Fator de Perda X%', 'Taxa de Perda de Transformação X%'
    NÃO casa o cabeçalho 'Taxa de Perda' (coluna de histórico CPFL, sem %) — evita falso positivo.

    Retorna {perda_transformacao_pct: float, _menciona_perda_transformacao: bool}.
    """
    out = {}
    for pat in (
        r"PERDA[S]?\s+DE\s+TRANSFORMA[ÇC][ÃA]O\s*[-:]?\s*(\d+(?:,\d+)?)\s*%",
        r"FATOR\s+DE\s+PERDA[S]?\s*[-:]?\s*(\d+(?:,\d+)?)\s*%",
        r"TAXA\s+DE\s+PERDA[S]?\s+DE\s+TRANSFORMA[ÇC][ÃA]O\s*[-:]?\s*(\d+(?:,\d+)?)\s*%",
    ):
        m = re.search(pat, texto, re.I)
        if m:
            try:
                v = float(m.group(1).replace(",", "."))
                if v > 0:
                    out["perda_transformacao_pct"] = v
                    break
            except ValueError:
                pass
    # Apontamento: termo forte presente (mesmo sem valor) → revisão
    if re.search(r"PERDA[S]?\s+DE\s+TRANSFORMA|FATOR\s+DE\s+PERDA", texto, re.I):
        out["_menciona_perda_transformacao"] = True
    return out


def extrair_gd_correto(itens: list, texto: str) -> dict:
    """FG04 — corrige extração GD usando itens_fatura + texto.

    Documento DADOS_PARA_DETECCAO assumia auditoria_gd.memoria_calculo, mas está vazio
    nas faturas reais. Fonte real: itens_fatura[].descricao + eh_credito_gd.

    Retorna:
      energia_injetada_kwh: soma |qtd| dos itens "INJETADA"
      energia_compensada_kwh: soma |qtd| dos itens com eh_credito_gd=True OU "COMPENSAD"
      saldo_credito_energia: via regex "Saldo Acumulado: X" no texto (descarta > 1M = leitura medidor)
      _eh_gd_validado: True se há item GD real (impede falso positivo de indicador_geracao_distribuida)
    """
    out = {}
    if not isinstance(itens, list):
        itens = []
    injet = 0.0
    compen = 0.0
    compen_muc = 0.0   # mesma UC — saldo próprio compensado
    compen_ouc = 0.0   # outra UC — rateio recebido de geradora
    tem_item_gd = False
    for it in itens:
        desc = (it.get("descricao") or "")
        desc_up = desc.upper()
        qtd_raw = it.get("quantidade_numerica") or it.get("qtd") or it.get("quantidade")
        try:
            qtd = abs(float(qtd_raw)) if qtd_raw is not None else 0.0
        except (ValueError, TypeError):
            qtd = 0.0
        # Sinal estruturado eh_credito_gd VENCE o nome do desc — em fatura beneficiária,
        # itens com nome "Energia Atv Injetada" + eh_credito_gd=True são na verdade COMPENSAÇÃO
        # (crédito abatido do consumo). "INJETADA" só conta como injeção se eh_credito_gd != True.
        if it.get("eh_credito_gd") is True or "COMPENSAD" in desc_up or "CRÉDITO DE ENERGIA" in desc_up:
            compen += qtd; tem_item_gd = True
            # Separação mUC vs oUC (Energisa MT layout: 'mUC X/YYYY' / 'oUC X/YYYY')
            if re.search(r"\bmUC\b", desc):    # mesma UC (saldo próprio)
                compen_muc += qtd
            elif re.search(r"\boUC\b", desc):  # outra UC (rateio geradora)
                compen_ouc += qtd
        elif "INJET" in desc_up:
            injet += qtd; tem_item_gd = True

    if tem_item_gd:
        # Quando GD validado, sempre seta (mesmo 0) — sobrescreve copy-bug do extrator antigo
        out["_eh_gd_validado"] = True
        out["energia_injetada_kwh"]   = round(injet, 2)
        out["energia_compensada_kwh"] = round(compen, 2)
        if compen_muc > 0:
            out["energia_compensada_muc_kwh"] = round(compen_muc, 2)
        if compen_ouc > 0:
            out["energia_compensada_ouc_kwh"] = round(compen_ouc, 2)

    # Saldo acumulado via texto (limite < 100k pra evitar leitura de medidor)
    if texto:
        m = re.search(r"Saldo\s+Acumulado\s*:?\s*([\d.]+,\d+|[\d.]+)", texto, re.I)
        if m:
            s = m.group(1).replace(".", "").replace(",", ".")
            try:
                v = float(s)
                if 0 < v < 100_000:  # saldo GD comum < 100k kWh; acima = leitura medidor
                    out["saldo_credito_energia"] = v
            except ValueError:
                pass
        # Créditos a expirar (SCEE) — saldo que vence; relevante p/ ressarcimento. Cristalizado v2.
        mc = re.search(r"Cr[ée]ditos?\s+a\s+Expirar[^\n]{0,60}?([\d.]+,\d{2}|\d+)\s*kWh", texto, re.I)
        if mc:
            cv = _num_indicador(mc.group(1))
            if cv is not None and 0 < cv < 10_000_000:
                out["creditos_a_expirar_kwh"] = cv
    return out


def extrair_reativos_a3(texto: str) -> dict:
    """A-3 — Fator de Potência + Reativos Excedentes (Grupo A).

    Linhas Energisa MT (validado): 'Energia Reativa Exced em KWh - Ponta UN 10,50 0,37 3,90 ...'
    'Demanda Reativa Exced em KW - Fponta UN 291,90 0,37 108,47 ...'

    Retorna: fator_potencia, consumo_reativo_excedente_kvarh, valor_energia_reativa_excedente,
             valor_demanda_reativa_excedente, reativo_excedente_rs (alias).
    """
    out = {}
    if not texto:
        return out

    # 1) Fator de Potência: "Fator de Potência: 0,93" / "FP: 0,93" / "Fator de Pot. 0,93"
    m = re.search(r"Fator\s+de\s+Pot[eê]ncia[^\d\-]{0,40}([01](?:[.,]\d{2,4}))", texto, re.I)
    if not m:
        m = re.search(r"\bFP\s*[:=]\s*([01](?:[.,]\d{2,4}))", texto, re.I)
    if m:
        try:
            fp = float(m.group(1).replace(",", "."))
            if 0 < fp <= 1.05:
                out["fator_potencia"] = round(fp, 4)
        except ValueError:
            pass

    # 2) Reativo Excedente (linhas Energia/Demanda Reativa Exced)
    kvarh_total = 0.0           # Energia reativa excedente (kvarh)
    kvar_demanda_total = 0.0    # Demanda reativa excedente (kVAr)
    rs_e = 0.0
    rs_d = 0.0
    for m in re.finditer(
        # Tolera ruído do plumber/OCR dentro de "Exced": "Exc.ed", "Exc ed", "Excd".
        r"(Energia|Demanda)\s+Reativa\s+Exc[\s.]{0,2}e?d[^\n\r]{1,250}", texto, re.I
    ):
        linha = m.group(0)
        tipo = m.group(1).lower()
        # Quantidade: 1º número da linha. Trata OCR Energisa que perde vírgula:
        # '5.79250' deveria ser '5.792,50' (BR). Heurística: 4+ dígitos após ponto E sem vírgula → reinterpreta.
        m_qtd = re.search(r"-?\d{1,3}(?:\.\d{3})*,\d+|-?\d+(?:\.\d+)?", linha)
        if not m_qtd:
            continue
        qtd_str = m_qtd.group(0)
        if "," not in qtd_str and "." in qtd_str:
            parts = qtd_str.split(".")
            if len(parts) == 2 and len(parts[1]) >= 4:
                # 5.79250 → 5792,50
                qtd_str = parts[0] + parts[1][:-2] + "," + parts[1][-2:]
        try:
            qtd = float(qtd_str.replace(".", "").replace(",", "."))
        except ValueError:
            continue
        # Sanity check: reativo excedente > 100k kvarh/mês é implausível
        if abs(qtd) > 100_000:
            continue
        # Valor R$: APENAS formato BR com EXATAMENTE 2 decimais (evita tarifa 0,268550 virar R$ 268.550)
        valores_rs = re.findall(r"-?\d{1,3}(?:\.\d{3})*,\d{2}(?!\d)", linha)
        cands = []
        for n in valores_rs:
            try: cands.append(float(n.replace(".", "").replace(",", ".")))
            except ValueError: pass
        # max positivo, excluindo: alíquotas (17/20/25) E a própria QUANTIDADE
        # (a qtd vem em formato BR e era erroneamente capturada como valor — ex:
        # '... Fponta 1.750,00 ... 616,56 ...' onde 1.750,00=qtd e 616,56=valor R$)
        rs = max(
            (v for v in cands
             if v not in (17.0, 20.0, 25.0) and v > 0 and abs(v - qtd) > 0.01),
            default=0.0,
        )
        if tipo == "energia":
            kvarh_total += qtd
            rs_e += rs
        else:
            # 'Demanda Reativa Exced em KW' → qtd está em kVAr (não kvarh)
            kvar_demanda_total += qtd
            rs_d += rs

    if kvarh_total > 0:
        out["consumo_reativo_excedente_kvarh"] = round(kvarh_total, 2)
    if kvar_demanda_total > 0:
        # Demanda reativa excedente em kVAr (não R$ — esse é valor_demanda_reativa_excedente)
        out["demanda_reativa_excedente_kvar"] = round(kvar_demanda_total, 2)
    # 2b) Layout EDP SP: reativo excedente em linhas próprias (sem a palavra "Exced"):
    #   "Energia Reativa Ponta  <medidor> <leit_ant> <leit_atu> <tarifa> <valor> KVH"  → UFER (energia reat. exc.)
    #   "DMCR Ponta             <medidor> <leit_ant> <leit_atu> <tarifa> <valor> KW"   → demanda reat. exc.
    # Só somamos linhas COM número de medidor (6+ díg) — as linhas zeradas sem
    # medidor são complementares e dupla-contariam. Valor = último número BR antes da unidade.
    if rs_e == 0 and rs_d == 0:
        def _ultimo_valor_br(linha, sufixo):
            # pega o último número formato BR (vírgula) imediatamente antes de KVH/KW
            m2 = re.search(r"(\d{1,3}(?:\.\d{3})*,\d{2,4})\s*" + sufixo + r"\b", linha, re.I)
            if not m2:
                return None
            try:
                return float(m2.group(1).replace(".", "").replace(",", "."))
            except ValueError:
                return None
        for m in re.finditer(r"Energia\s+Reativa\s+[A-Za-zÀ-ÿ.\s]*?\d{6,}[^\n\r]{0,80}?KVH", texto, re.I):
            v = _ultimo_valor_br(m.group(0), "KVH")
            if v and v > 0:
                rs_e += v
        for m in re.finditer(r"DMCR\s+[A-Za-zÀ-ÿ.\s]*?\d{6,}[^\n\r]{0,80}?KW", texto, re.I):
            v = _ultimo_valor_br(m.group(0), "KW")
            if v and v > 0:
                rs_d += v
        # Layout Enel SP: reativo excedente cobrado como UFER em linhas CCI:
        #   "0601 UFER PONTA TE 1.433,6 0,33520 480,53 18% 86,50 480,53 0,27087"
        #   "0605 UFER FORA PONTA TUSD ..."  → valor = 3º número (após qtd e tarifa)
        for m in re.finditer(
            r"UFER\s+(?:FORA\s+)?PONTA(?:\s+(?:CAPACITIVA|INDUTIVA))?\s+(?:TE|TUSD)\s+"
            r"[\d.]+,\d+\s+\d,\d{4,6}\s+([\d.]*,\d{2})\b", texto, re.I):
            try:
                rs_e += float(m.group(1).replace(".", "").replace(",", "."))
            except ValueError:
                pass

    if rs_e > 0:
        out["valor_energia_reativa_excedente"] = round(rs_e, 2)
        out["reativo_excedente_rs"] = round(rs_e, 2)
    if rs_d > 0:
        out["valor_demanda_reativa_excedente"] = round(rs_d, 2)

    # 3) Leituras dos medidores reativos (tabela ERE Ponta/FPonta no rodapé)
    # Formato Energisa MT: 'ERE Ponta 1,80 1,79 120,00 2,50 0,00 0,00 0,25 0,25'
    # Cols: SIGLA POSTO leit_atu leit_ant K aliq pad pad cons_calc cons_fat
    leit_ant = 0.0
    leit_atu = 0.0
    for m in re.finditer(
        r"^\s*ERE\s+(?:Ponta|FPonta|F\.\s*Ponta)\s+"
        r"(-?\d+(?:[.,]\d+)?)\s+"   # leit_atu
        r"(-?\d+(?:[.,]\d+)?)",      # leit_ant
        texto, re.M | re.I,
    ):
        try:
            la = float(m.group(1).replace(".","").replace(",","."))
            lp = float(m.group(2).replace(".","").replace(",","."))
            leit_atu += la
            leit_ant += lp
        except ValueError:
            continue
    if leit_ant > 0:
        out["leit_ant_reativa"] = round(leit_ant, 2)
    if leit_atu > 0:
        out["leit_atu_reativa"] = round(leit_atu, 2)
    return out


# ─────────────────────────────────────────────────────────────────────────
# Parsing canônico de valores BRL (29/05/2026)
# Contrato: TODAS funções de valor monetário neste módulo emitem float em R$.
# Centralizamos aqui a interpretação BR vs US e detecção de plausibilidade pra
# evitar que "347.057" (milhar BR) seja confundido com "347,05" (decimal).
# ─────────────────────────────────────────────────────────────────────────
_BRL_LIMITE_PLAUSIVEL = 9_999_999.99   # R$ 10M — fatura única realisticamente abaixo


def parse_brl(valor, *, contexto: str = "", permitir_acima_limite: bool = False):
    """Converte string/número para float em R$.

    Regras:
    - Aceita: float, int, "1.234,56", "1234.56", "1234,56", "1.234.567,89"
    - REJEITA formato ambíguo: "1.234" sem decimal explícito (pode ser milhar ou dois mil + algo)
    - Detecta gross-up: se valor > 9.999.999,99 e não declarado, devolve None + log
    - String com 3+ dígitos antes do ponto E sem vírgula = formato US (1234.56)
    - String com vírgula = formato BR (vírgula é decimal)

    Args:
        valor: valor a converter
        contexto: descrição do campo pra log (ex.: "icms_base_te", "valor_total")
        permitir_acima_limite: True quando gross-up declarado (subsidiariedade legal)

    Returns:
        float em R$ ou None se inválido/ambíguo
    """
    if valor is None: return None
    if isinstance(valor, (int, float)):
        v = float(valor)
        if not permitir_acima_limite and abs(v) > _BRL_LIMITE_PLAUSIVEL:
            return None
        return round(v, 2)
    s = str(valor).strip()
    if not s: return None
    # Remove R$, espaços
    s = re.sub(r"R\$\s*", "", s, flags=re.I).strip()
    s = s.replace(" ", "")
    if not re.search(r"\d", s): return None
    # Detecta formato
    tem_virgula = "," in s
    tem_ponto = "." in s
    try:
        if tem_virgula and tem_ponto:
            # Formato BR: 1.234.567,89 — vírgula é a ÚLTIMA, pontos são milhar
            if s.rfind(",") > s.rfind("."):
                v = float(s.replace(".", "").replace(",", "."))
            else:
                # Formato US: 1,234,567.89 — ponto é a ÚLTIMA, vírgulas são milhar
                v = float(s.replace(",", ""))
        elif tem_virgula:
            # Só vírgula = BR decimal
            v = float(s.replace(",", "."))
        elif tem_ponto:
            # Só ponto: ambíguo. Se >= 4 dígitos pós-ponto = OCR perdeu vírgula BR.
            # Se 1-3 dígitos pós-ponto E número total >= 4 dígitos = milhar BR sem decimal.
            # Senão = US decimal.
            parts = s.split(".")
            if len(parts) == 2:
                if len(parts[1]) >= 4:
                    # "5.79250" → "5.792,50" (BR sem vírgula) — heurística OCR
                    s = parts[0] + parts[1][:-2] + "." + parts[1][-2:]
                    v = float(s)
                elif len(parts[1]) <= 2 and (len(parts[0]) >= 4 or "," in parts[0]):
                    # "1234.5" ou "1234.56" → US decimal direto
                    v = float(s)
                elif len(parts[1]) == 3 and len(parts[0]) >= 1:
                    # "1.234" — AMBÍGUO! Pode ser milhar BR (R$1234) ou decimal US incorreto (R$1.234)
                    # Sem decimal explícito ".XX", tratamos como milhar BR pra ser conservador
                    v = float(s.replace(".", ""))
                else:
                    v = float(s)
            else:
                # Múltiplos pontos = milhar BR sem decimal "1.234.567"
                v = float(s.replace(".", ""))
        else:
            # Só dígitos: inteiro
            v = float(s)
    except (ValueError, TypeError):
        return None
    if not permitir_acima_limite and abs(v) > _BRL_LIMITE_PLAUSIVEL:
        return None
    return round(v, 2)


def derivar_tarifas_dos_itens(itens: list) -> dict:
    """Extrai tarifas unitárias por componente (TE, TUSD, demanda, Fio B, COSIP).

    Lê itens_cobrados[] e classifica por descrição. Para distribuidoras que
    NÃO separam TE/TUSD em itens (Energisa MT), preenche tarifa_tusd com o
    valor cheio (a TE fica NULL e pode ser derivada por subtração depois).

    Returns dict com chaves opcionais:
        tarifa_te_ponta, tarifa_te (fponta)
        tarifa_tusd_ponta, tarifa_tusd (fponta)
        tarifa_demanda_ponta, tarifa_demanda_fponta, tarifa_demanda (compat — fponta)
        tarifa_fio_b, tarifa_cosip
    """
    if not isinstance(itens, list): return {}
    out = {}
    for it in itens:
        if not isinstance(it, dict): continue
        d = str(it.get("descricao") or "").upper()
        posto = str(it.get("posto") or "").upper()
        tar_str = (
            it.get("tarifa_unit_aneel")
            or it.get("tarifa_unit_numerica")
            or it.get("tarifa_unit_string")
        )
        tar = parse_brl(tar_str)
        if tar is None or tar <= 0: continue
        # Detecta ponta/fora-ponta — campo "posto" pode ser None; descrição pode ter
        # sufixo curto "P"/"FP"/"HR" (Enel SP) ou "Ponta"/"Fora Ponta" (Energisa MT).
        d_clean = d.replace(" FORA PONTA", " FP").replace(" F PONTA", " FP").replace("FPONTA", " FP")
        eh_fp = ("FORA" in posto) or " FP" in d_clean or re.search(r"\b(FP|F\s*PONTA|HR)\b", d_clean) is not None
        eh_p  = (("PONTA" in posto and "FORA" not in posto)
                 or (not eh_fp and (re.search(r"\b(P|PONTA)\s*$", d_clean) or " PONTA" in d_clean)))
        # PARCELA TE (Enel SP) — separação explícita TE
        if "PARCELA TE" in d or re.search(r"\bENERGIA\s+TE\b", d):
            if eh_p:   out.setdefault("tarifa_te_ponta", tar)
            elif eh_fp: out.setdefault("tarifa_te", tar)
            continue
        # CONSUMO sem PARCELA TE (TUSD pura — Enel SP) OU tarifa cheia (Energisa MT)
        if ("CONSUMO" in d and "ENERGIA ATV INJETADA" not in d
                and "REATIVA" not in d and "RESERVADO" not in d):
            if eh_p:    out.setdefault("tarifa_tusd_ponta", tar)
            elif eh_fp: out.setdefault("tarifa_tusd", tar)
            continue
        # Demanda
        if "DEMANDA" in d and "REATIVA" not in d and "ULTRAP" not in d and "NÃO CONSUMIDA" not in d.upper():
            if eh_p:    out.setdefault("tarifa_demanda_ponta", tar)
            elif eh_fp: out.setdefault("tarifa_demanda_fponta", tar)
            continue
        # USO SIST. DISTR. FIO B (explícito Enel SP)
        if re.search(r"FIO\s*B\b", d) or "USO SISTEMA DISTR" in d or "USO SIST.DISTR.(TUSD)" in d:
            out.setdefault("tarifa_fio_b", tar)
            continue
        # COSIP / CIP — tarifa por kWh (raro; geralmente valor fixo)
        if "COSIP" in d or "CIP" in d or "ILUMIN" in d:
            out.setdefault("tarifa_cosip", tar)
            continue
    # Compat: 'tarifa_demanda' antiga aponta pra fponta (default)
    if "tarifa_demanda_fponta" in out and "tarifa_demanda" not in out:
        out["tarifa_demanda"] = out["tarifa_demanda_fponta"]
    return out


def assert_brl_plausivel(valor, campo: str = "") -> bool:
    """Devolve True se valor está dentro da faixa de R$ plausível (0 a 10M).

    Use após operações de soma ou casting pra detectar regressão de unidade.
    """
    if valor is None: return True
    try:
        v = float(valor)
    except (ValueError, TypeError):
        return False
    return 0 <= abs(v) <= _BRL_LIMITE_PLAUSIVEL


_DESC_TUSD_RE = re.compile(
    r"servi[cç]o\s+de\s+distribui[cç][aã]o|servi[cç]o\s+de\s+transmiss[aã]o"
    r"|\bTUSD\b|fio\s*b|encargos\s+setoriais|\bDemanda\b"
    r"|custo\s+de\s+disponibilidade",   # B convencional cativo (encargo fixo TUSD)
    re.I,
)
_DESC_TE_RE = re.compile(
    r"consumo\s+em\s+kwh|energia\s+ativa|compra\s+de\s+energia|\bTE\b"
    r"|consumo\s+energia\s+el[ée]trica|energia\s+el[ée]trica"   # Light A4 ACL / B Conv
    r"|energia\s+terc\s+comercializ",                            # Light ACL mercado livre
    re.I,
)


# Patterns CIP/COSIP — Contribuição de Iluminação Pública (isenta de ICMS)
# Variações conhecidas:
#   - "COBRANCA ILUM PUBLICA PARA A PREFEITURA" (Elektro SP)
#   - "Contrib Ilum Pública Municipal" / "Contrib Ilum P�blica Municipal" (Light)
#   - "Contrib. Custeio IP-CIP Municipal" (CPFL Piratininga)
#   - "Cobranca Ilum Publ Municipal" (CPFL Paulista)
#   - "Contribuicao Iluminacao Publica-Prefeitura" (Enel RJ Ampla antigo)
#   - "CIP" / "COSIP" isolados
_DESC_CIP_RE = re.compile(
    r"(?:^|\s|/)("
    r"cobranca\s+ilum|"
    r"contrib[\.\s]+(?:de\s+)?ilum|"                   # 'Contrib de Ilum Pub' (Energisa MT)
    r"contribui[çc][ãa]o\s+(?:de\s+)?ilum[\.\s]*|"     # 'Contribuição de Ilum. Pública' (Light)
    r"contrib[\.\s]+custeio\s+ip|"                      # CPFL
    r"contribui[çc][ãa]o\s+(?:de\s+)?ilumina[çc][ãa]o|"
    r"ilumina[çc][ãa]o\s+p[úu]blica|"
    r"ip-cip|"                                          # CPFL: 'IP-CIP'
    r"\bCIP\b|\bCOSIP\b"
    r")",
    re.I,
)


def extrair_leituras_grupo_a_medicao(texto: str) -> dict | None:
    """Extrai leituras Ponta/FPonta da tabela de medição (Grupo A Energisa MT/Enel SP).

    Formato típico:
      KWH Ponta  34,00  33,00  1750 0 0 0 1.750,00 1.750,00
      KWH FPonta 3.533,00  3.441,00  1750 0 0 0 161.000,00 161.000,00

    Conserta bug onde extrator copia leituras de Ponta em FPonta.
    Devolve dict com leit_ant/atu_ativa_ponta/fponta ou None.
    """
    if not texto:
        return None
    out = {}
    # Pattern: KWH POSTO leit_atu leit_ant K ...
    pat = re.compile(
        r"\bKWH\s+(Ponta|FPonta|F\.\s*Ponta)\s+"
        r"([\d.]+,\d+)\s+"  # leit_atu
        r"([\d.]+,\d+)\s+"  # leit_ant
        r"(\d{1,5}(?:[,.]\d+)?)",  # K
        re.I,
    )
    for m in pat.finditer(texto):
        posto = m.group(1).upper().replace(".", "").replace(" ", "")
        try:
            la = float(m.group(2).replace(".","").replace(",","."))
            lp = float(m.group(3).replace(".","").replace(",","."))
        except ValueError:
            continue
        if posto == "PONTA":
            out["leit_atu_ativa_ponta"] = la
            out["leit_ant_ativa_ponta"] = lp
        elif posto in ("FPONTA",):
            out["leit_atu_ativa_fponta"] = la
            out["leit_ant_ativa_fponta"] = lp
    return out if out else None


def extrair_medicao_grandezas(texto: str) -> list | None:
    """Tabela de medição — 6 grandezas × postos (Energisa/Equatorial/etc).

    Formato:
        11555915-9 ENERGIA ATIVA - KWH PONTA 589431 631875 0,630000 26739,72
        11555915-9 DEMANDA - KW PONTA 007591 007780 2,520000 476,28
        11555915-9 UFER PONTA 050195 050195 0,630000 0
        11555915-9 DMCR PONTA 029553 030260 0,630000 445,41
        40129026 Energia Ativa - kWh Fora Ponta 035058 037412 2,00000 4.708  (CPFL/Ampla DANF3E)

    Devolve lista de {medidor, grandeza, posto, leit_ant, leit_atu, constante, consumo}.
    """
    if not texto:
        return None
    out = []
    # medidor: aceita com hífen (11555915-9) OU prefixo de instalação sem hífen (40129026).
    # consumo: aceita vírgula decimal (26739,72) E ponto de milhar puro (4.708) dos layouts DANF3E.
    pat = re.compile(
        r"(?:^|\s)"
        r"(?P<medidor>\d{6,12}(?:-\d)?)\s+"
        r"(?P<grandeza>ENERGIA\s+ATIVA\s+-\s+KWH|ENERGIA\s+REATIVA\s+-\s+KWH|DEMANDA\s+-\s+KW|UFER|DMCR)\s+"
        r"(?P<posto>PONTA|FORA\s+PONTA|RESERVADO)\s+"
        r"(?P<ant>\d{3,9})\s+(?P<atu>\d{3,9})\s+"
        r"(?P<const>\d+(?:[.,]\d+)?)\s+"
        r"(?P<cons>-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?)",
        re.I | re.M,
    )
    for m in pat.finditer(texto):
        try:
            cons_raw = m.group("cons").replace(".", "").replace(",", ".")
            cons = float(cons_raw)
        except ValueError:
            continue
        try:
            const = float(m.group("const").replace(",", "."))
        except ValueError:
            const = None
        out.append({
            "medidor": m.group("medidor"),
            "grandeza": re.sub(r"\s+", " ", m.group("grandeza").upper()),
            "posto": re.sub(r"\s+", " ", m.group("posto").upper()),
            "leitura_anterior": int(m.group("ant")),
            "leitura_atual": int(m.group("atu")),
            "constante": const,
            "consumo": cons,
        })
    return out if out else None


def extrair_pagamento_canhoto(texto: str) -> dict | None:
    """Captura registro de pagamento da página 3 / canhoto.

    Formato:
        28/07/2022 PAGAMENTO PAGAMENTO 27/07/2022 R$ 220.240,00
        DD/MM/AAAA PAGAMENTO ... R$ X
    """
    if not texto:
        return None
    m = re.search(
        r"(\d{2}/\d{2}/\d{4})\s+PAGAMENTO\s+[^\n]*?(\d{2}/\d{2}/\d{4})?\s*R?\$?\s*([\d.]+,\d{2})",
        texto, re.I,
    )
    if not m:
        return None
    from datetime import datetime
    out = {}
    try:
        dt = datetime.strptime(m.group(1), "%d/%m/%Y")
        out["data_pagamento_canhoto"] = dt.strftime("%Y-%m-%d")
    except ValueError:
        pass
    try:
        out["valor_pago_canhoto"] = float(m.group(3).replace(".","").replace(",","."))
    except (ValueError, TypeError):
        pass
    return out if out else None


def validar_deterministico(out_v2: dict) -> dict:
    """Validação determinística objetiva: checks que detectam bugs comuns.

    Checks:
      - soma_itens_vs_total: |Σ valor_brl - total| <= 0.05
      - itens_minimos_grupo_a: len(itens) >= 6 para Grupo A
      - icms_global_nao_e_primeiro_item: base_icms_total != base_icms[0]
      - tributos_totais_presentes: PIS + COFINS + ICMS encontrados
    """
    checks = []
    itens = (out_v2 or {}).get("itens_fatura") or []
    edist = (out_v2 or {}).get("_extras_dist") or {}
    grupo = ((out_v2 or {}).get("ligacao_tecnica") or {}).get("grupo") or ""

    total = ((out_v2 or {}).get("referencia_vencimento_valor") or {}).get("valor_total_a_pagar") \
            or ((out_v2 or {}).get("totais") or {}).get("valor_total_a_pagar")
    soma_itens = round(sum((it.get("valor_brl_numerico") or 0) for it in itens), 2) if itens else None
    if total is not None and soma_itens is not None:
        checks.append({
            "nome": "soma_itens_vs_total",
            "status": "PASS" if abs(soma_itens - float(total)) <= 0.05 else "FAIL",
            "esperado": float(total),
            "obtido": soma_itens,
        })

    if str(grupo).upper().startswith("A"):
        checks.append({
            "nome": "itens_minimos_grupo_a",
            "status": "PASS" if len(itens) >= 6 else "FAIL",
            "obtido": len(itens),
        })

    # ICMS global != primeiro item (detecta bug "tributo do item virou total")
    # Só checa quando há 2+ itens com icms_base — caso contrário, item_0=global é legítimo
    icms_global = edist.get("icms_base_calculo_totais") or out_v2.get("icms_base_calculo")
    itens_com_icms = [it for it in itens if (it or {}).get("icms_base_numerico") is not None]
    icms_item_0 = itens_com_icms[0].get("icms_base_numerico") if itens_com_icms else None
    if len(itens_com_icms) >= 2 and icms_global and icms_item_0:
        # Soma dos icms_base dos itens deve ser ≈ icms_global. Se item_0 == global, faltam itens.
        soma_icms_itens = sum(float(it.get("icms_base_numerico") or 0) for it in itens_com_icms)
        if abs(float(icms_global) - float(icms_item_0)) < 0.05 and soma_icms_itens > float(icms_item_0) * 1.5:
            checks.append({
                "nome": "icms_global_nao_e_primeiro_item",
                "status": "FAIL",
                "global": float(icms_global), "item_0": float(icms_item_0),
                "soma_itens": round(soma_icms_itens, 2),
            })
        else:
            checks.append({"nome": "icms_global_nao_e_primeiro_item", "status": "PASS"})

    # Tributos totais presentes (aceita 0 como valor legítimo — subvenção/isenção)
    pis_t = edist.get("pis_valor_totais")
    cof_t = edist.get("cofins_valor_totais")
    icms_t = edist.get("icms_valor_totais")
    if icms_t is None: icms_t = out_v2.get("icms_valor")
    todos_nao_null = all(v is not None for v in (pis_t, cof_t, icms_t))
    checks.append({
        "nome": "tributos_totais_presentes",
        "status": "PASS" if todos_nao_null else "WARN",
        "pis": pis_t, "cofins": cof_t, "icms": icms_t,
    })

    falhas = [c for c in checks if c["status"] == "FAIL"]
    warns = [c for c in checks if c["status"] == "WARN"]
    gate = "reprovado" if falhas else ("revisao" if warns else "aprovado")
    return {"gate": gate, "checks": checks, "qtd_falhas": len(falhas), "qtd_warns": len(warns)}


def extrair_tributos_totais(texto: str) -> dict | None:
    """Captura tributos TOTAIS da fatura (multi-layout).

    Layout 1 — Equatorial GO / Enel SP moderno (NOME base aliq% valor):
        PIS/PASEP 178339,5 0,6539% 1166,16
        COFINS 178339,5 3,0118% 5371,22
        ICMS 214864,28 17% 36526,92

    Layout 2 — Energisa MT (NOME base valor — sem alíquota):
        PIS 6.303,48 68,36
        COFINS 6.303,48 314,89
        TOTAL: 7.731,85 383,25 7.594,56 1.291,07
        (TOTAL: valor_total | pis+cof | base_icms | icms_valor)

    Devolve dict com pis/cofins/icms (base/aliq/valor).
    """
    if not texto:
        return None
    out = {}

    # Layout 1: NOME base aliq% valor
    pat1 = re.compile(
        r"\b(PIS/PASEP|COFINS|ICMS)\s+"
        r"([\d.]+(?:,\d+)?)\s+"
        r"([\d.]+(?:,\d+)?)%?\s+"
        r"(-?[\d.]+,\d{2})\b",
        re.I,
    )
    for m in pat1.finditer(texto):
        nome = m.group(1).upper()
        try:
            base = float(m.group(2).replace(".","").replace(",","."))
            aliq = float(m.group(3).replace(".","").replace(",","."))
            valor = float(m.group(4).replace(".","").replace(",","."))
        except ValueError:
            continue
        if "PIS" in nome and "pis_valor" not in out:
            out.update({"pis_base_calculo": base, "pis_aliquota": aliq, "pis_valor": valor})
        elif "COFINS" in nome and "cofins_valor" not in out:
            out.update({"cofins_base_calculo": base, "cofins_aliquota": aliq, "cofins_valor": valor})
        elif "ICMS" in nome and "icms_valor" not in out:
            out.update({"icms_base_calculo": base, "icms_aliquota": aliq, "icms_valor": valor})

    # Layout 2 (Energisa MT): linhas PIS / COFINS sem aliq, depois TOTAL com 4 colunas
    # PIS 6.303,48 68,36
    # COFINS 6.303,48 314,89
    # TOTAL: 7.731,85 383,25 7.594,56 1.291,07
    if "pis_valor" not in out:
        m = re.search(r"\bPIS\b\s+([\d.]+,\d+)\s+(-?[\d.]+,\d{2})(?!\d)", texto, re.I)
        if m:
            try:
                out["pis_base_calculo"] = float(m.group(1).replace(".","").replace(",","."))
                out["pis_valor"] = float(m.group(2).replace(".","").replace(",","."))
            except ValueError: pass
    if "cofins_valor" not in out:
        m = re.search(r"\bCOFINS\b\s+([\d.]+,\d+)\s+(-?[\d.]+,\d{2})(?!\d)", texto, re.I)
        if m:
            try:
                out["cofins_base_calculo"] = float(m.group(1).replace(".","").replace(",","."))
                out["cofins_valor"] = float(m.group(2).replace(".","").replace(",","."))
            except ValueError: pass

    # Linha TOTAL: (Energisa MT) → captura base_icms + icms_valor mesmo sem ICMS isolado
    if "icms_valor" not in out:
        m = re.search(
            r"\bTOTAL\s*:?\s+"
            r"(-?[\d.]+,\d{2})\s+"  # valor_total
            r"(-?[\d.]+,\d{2})\s+"  # pis+cof
            r"(-?[\d.]+,\d{2})\s+"  # base_icms
            r"(-?[\d.]+,\d{2})\b",  # icms_valor
            texto, re.I,
        )
        if m:
            try:
                out["icms_base_calculo"] = float(m.group(3).replace(".","").replace(",","."))
                out["icms_valor"] = float(m.group(4).replace(".","").replace(",","."))
            except ValueError: pass

    # Layout 3 — Energisa MT GD: 'COFINS ICMS B_c_icms B_s_icms A_cof A_icms V_icms V_cof'
    # Ex: 'COFINS ICMS 106,13 88,08 3,1185 17,00 18,04 2,75'
    # 106,13 = base com ICMS por dentro | 88,08 = base s/ICMS (mesma PIS)
    # 3,1185 = aliq COFINS% | 17,00 = aliq ICMS% | 18,04 = ICMS valor | 2,75 = COFINS valor
    if "cofins_valor" not in out or "icms_valor" not in out:
        m = re.search(
            r"\bCOFINS\s+ICMS\s+"
            r"([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+"        # base_c_icms | base_s_icms
            r"([\d.]+,\d{4})\s+([\d.]+,\d{2})\s+"        # aliq_cof | aliq_icms
            r"([\d.]+,\d{2})\s+([\d.]+,\d{2})\b",        # icms_valor | cofins_valor
            texto, re.I,
        )
        if m:
            try:
                base = float(m.group(2).replace(".","").replace(",","."))
                if "cofins_valor" not in out:
                    out["cofins_base_calculo"] = base
                    out["cofins_aliquota"] = float(m.group(3).replace(".","").replace(",","."))
                    out["cofins_valor"] = float(m.group(6).replace(".","").replace(",","."))
                if "icms_valor" not in out:
                    out["icms_base_calculo"] = float(m.group(1).replace(".","").replace(",","."))
                    out["icms_aliquota"] = float(m.group(4).replace(".","").replace(",","."))
                    out["icms_valor"] = float(m.group(5).replace(".","").replace(",","."))
            except ValueError: pass

    # Layout 3b — PIS isolado mesmo formato MT GD: 'PIS 88,08 0,6770 0,60'
    if "pis_valor" not in out:
        m = re.search(
            r"\bPIS\s+([\d.]+,\d{2})\s+([\d.]+,\d{4})\s+([\d.]+,\d{2})(?!\s*[\d.,])",
            texto, re.I,
        )
        if m:
            try:
                out["pis_base_calculo"] = float(m.group(1).replace(".","").replace(",","."))
                out["pis_aliquota"] = float(m.group(2).replace(".","").replace(",","."))
                out["pis_valor"] = float(m.group(3).replace(".","").replace(",","."))
            except ValueError: pass

    # Layout 4 — ICMS-subvenção Enel SP (Decreto SP nº 64.255/2019): zero declarado
    # Quando aparece 'ICMS-subvenção por determinação da Sefaz-SP' e tributos não foram extraídos,
    # ICMS/PIS/COFINS são LEGALMENTE ZERO (subvenção integral). Setamos 0 para evitar gate=revisão.
    if re.search(r"ICMS[-\s]+subven[çc][ãa]o", texto, re.I) or \
       re.search(r"subven[çc][ãa]o\s+(?:integral|por\s+determina)", texto, re.I):
        for k in ("icms_valor", "pis_valor", "cofins_valor"):
            if k not in out:
                out[k] = 0.00
        out["_icms_subvencao_detectada"] = True

    return out if out else None


def detectar_subvencao_tributos(texto: str) -> bool:
    """True se a fatura declara subvenção/isenção legal de ICMS+PIS+COFINS."""
    if not texto: return False
    return bool(
        re.search(r"ICMS[-\s]+subven[çc][ãa]o", texto, re.I) or
        re.search(r"subven[çc][ãa]o\s+(?:integral|por\s+determina)", texto, re.I)
    )


def derivar_fator_potencia_status(consumo_reativo_excedente_kvarh, subgrupo: str | None) -> str | None:
    """Retorna 'abaixo_092' | 'acima_092' | 'desconhecido' baseado em ERE e subgrupo.

    Regra:
    - Grupo A com ERE > 0 → FP < 0,92 (cobrança de excedente reativo dispara)
    - Grupo A com ERE = 0 ou NULL → FP ≥ 0,92
    - Outros → desconhecido (Grupo B não tem cobrança de reativo)
    """
    sg = (subgrupo or "").upper()
    if not sg.startswith("A"):
        return "desconhecido"
    try:
        v = float(consumo_reativo_excedente_kvarh or 0)
    except (TypeError, ValueError):
        v = 0.0
    return "abaixo_092" if v > 0 else "acima_092"


# ─────────────────────────────────────────────────────────────────────────
# Enriquecimento via origem sgeeasy_clientes_novo (Faturas_Registradas_Cache)
# ─────────────────────────────────────────────────────────────────────────
from db_env import conexao as _conexao_env  # lê backend/.env (sem senha no código)
_DB_ORIGEM = _conexao_env("DB_FATURAS", "DB_FATURAS_URL", connection_timeout=15)
_CACHE_ORIGEM: dict[str, dict] = {}


def enriquecer_via_origem_sgeeasy(uid) -> dict:
    """Consulta Faturas_Registradas_Cache pela UID e retorna metadados.

    Retorna {} silenciosamente em qualquer erro de rede/SQL pra nunca quebrar
    o pipeline. Cache local em memória do processo.

    Campos retornados (quando disponíveis): data_vencimento, data_emissao_nf,
    mes_referencia (MM/YYYY), valor_total_fatura, cod_empresa, distribuidora.
    """
    if uid is None: return {}
    uid_str = str(uid).strip()
    if not uid_str: return {}
    if uid_str in _CACHE_ORIGEM:
        return _CACHE_ORIGEM[uid_str]
    try:
        import mysql.connector
        cn = mysql.connector.connect(**_DB_ORIGEM)
        cur = cn.cursor(dictionary=True)
        cur.execute(
            "SELECT UID, Cod_Empresa, Concessionaria, Dt_Venc_NF, Dt_Emissao_NF, Mes_Ref, "
            "RS_Total_Fatura, UC, Cod_UC, Conta_Contrato, RAZAO_SOCIAL, CNPJ_Fatura, CPF, "
            "Classe_Tarifaria, Modalidade_Tarifaria, NroMedidor "
            "FROM Faturas_Registradas_Cache WHERE UID=%s LIMIT 1",
            (uid_str,)
        )
        r = cur.fetchone()
        cur.close(); cn.close()
        if not r:
            _CACHE_ORIGEM[uid_str] = {}
            return {}
        out = {}
        venc = r.get("Dt_Venc_NF")
        if venc and str(venc) not in ("0000-00-00", "None"):
            out["data_vencimento"] = venc
        emiss = r.get("Dt_Emissao_NF")
        if emiss and str(emiss) not in ("0000-00-00", "None"):
            out["data_emissao_nf"] = emiss
        mes = r.get("Mes_Ref")
        if mes and str(mes) not in ("0000-00-00", "None"):
            out["mes_referencia"] = (
                mes.strftime("%m/%Y") if hasattr(mes, "strftime") else str(mes)[:7]
            )
        if r.get("RS_Total_Fatura"):
            out["valor_total_fatura"] = float(r["RS_Total_Fatura"])
        if r.get("Cod_Empresa"):
            out["cod_empresa"] = int(r["Cod_Empresa"])
        if r.get("Concessionaria"):
            out["distribuidora"] = r["Concessionaria"]
        # cadastrais AUTORITATIVOS (override no pipeline — parse é não-confiável p/ esses)
        def _clean(v):
            v = ("" if v is None else str(v)).strip().lstrip("`'\" ").strip()
            return v or None
        if _clean(r.get("UC")):              out["codigo_instalacao"] = _clean(r["UC"])
        if r.get("Cod_UC"):                  out["cod_uc"] = str(r["Cod_UC"]).strip()
        if _clean(r.get("Conta_Contrato")):  out["conta_contrato"] = _clean(r["Conta_Contrato"])
        if _clean(r.get("RAZAO_SOCIAL")):    out["razao_social"] = _clean(r["RAZAO_SOCIAL"])
        _doc = _clean(r.get("CNPJ_Fatura")) or _clean(r.get("CPF"))
        if _doc:                             out["cnpj_cliente"] = _doc
        if _clean(r.get("Modalidade_Tarifaria")): out["modalidade_tarifaria"] = _clean(r["Modalidade_Tarifaria"])
        if _clean(r.get("Classe_Tarifaria")):     out["classe_consumo"] = _clean(r["Classe_Tarifaria"])
        if _clean(r.get("NroMedidor")):      out["medidor"] = _clean(r["NroMedidor"])
        _CACHE_ORIGEM[uid_str] = out
        return out
    except Exception:
        _CACHE_ORIGEM[uid_str] = {}
        return {}


def extrair_ids_light_rj(texto: str) -> dict:
    """Extrai os 3 identificadores Light RJ: codigo_instalacao, codigo_cliente, conta_contrato.

    Padrão Light RJ (Via Varejo / Comercial / Residencial):
        VIA VAREJO S/A                          ← razão social
        430032863                               ← codigo_instalacao (9 dígitos)
        AV MIN EDGARD ROMERO 37                 ← endereço
        ...
        CEP 21350-301 0020001556                ← codigo_cliente (10 dígitos pós CEP)
        CNPJ 33.041.260/0854-88
        Contra/Conta Contrato: 20005809023      ← conta_contrato (11 dígitos; typo 'Contra' frequente)

    Returns:
        dict {codigo_instalacao, codigo_cliente, conta_contrato}
    """
    if not texto: return {}
    out = {}

    # 1) conta_contrato — "Conta Contrato:" ou "Contra Contrato:" (typo Light) seguido de 11 dígitos
    m = re.search(r"Cont(?:r)?a\s+Contrato\s*:?\s*(\d{10,12})", texto, re.I)
    if m:
        out["conta_contrato"] = m.group(1)

    # 2) codigo_cliente — 10 dígitos colados após CEP (formato CEP XXXXX-XXX <10dig>)
    m = re.search(r"CEP\s+\d{5}-\d{3}\s+(\d{10})\b", texto)
    if m:
        out["codigo_cliente"] = m.group(1)

    # 3) codigo_instalacao — múltiplos padrões por subgrupo/layout Light
    # 3a) Grupo A4 moderno: '430032863 AV MIN EDGARD...' (9 dig + endereço)
    m = re.search(r"\b(\d{9})\s+(?:AV|R|RUA|TV|ESTRADA|AL|ROD|PRAÇA|PRACA)\s", texto, re.I)
    if m and not m.group(1).startswith("000"):
        out["codigo_instalacao"] = m.group(1)

    # 3b) Grupo B (B1/B3): 10 dígitos entre 'RJ' (UF do endereço) e data de leitura.
    # Padrão: 'MEIER / RIO DE JANEIRO, RJ 0414266700 21/05/2019 22/06/2019 32 22/07/2019'
    if "codigo_instalacao" not in out:
        m = re.search(r"\bRJ\s+(\d{10})\s+\d{2}/\d{2}/\d{4}", texto)
        if m:
            out["codigo_instalacao"] = m.group(1)

    # 3c) Padrão genérico Light: 10 dígitos antes da data atual quando há "Leitura anterior" perto
    if "codigo_instalacao" not in out:
        m = re.search(
            r"Leitura\s+anterior[\s\S]{0,500}?\b(\d{9,10})\s+\d{2}/\d{2}/\d{4}\s+\d{2}/\d{2}/\d{4}",
            texto, re.I
        )
        if m:
            out["codigo_instalacao"] = m.group(1)

    # 3d) Fallback: '430032863 DEVEC' / '430032863 NOTA' — 9 dig antes de ruído fiscal
    if "codigo_instalacao" not in out:
        m = re.search(r"\b(4\d{8})\s+(?:DEVEC|NOTA|FATURA|REF|DEMANDA)\b", texto, re.I)
        if m:
            out["codigo_instalacao"] = m.group(1)

    # 4) codigo_cliente — padrão alternativo Grupo B Light
    # '20001556 NOTA FISCAL Nº 1395795' (8-10 dig antes de 'NOTA FISCAL')
    if "codigo_cliente" not in out:
        m = re.search(r"\b(\d{8,10})\s+NOTA\s+FISCAL\b", texto, re.I)
        if m:
            cand = m.group(1)
            # Sanity: não pode ser igual ao conta_contrato (mesmo número repetido)
            if cand != out.get("conta_contrato"):
                out["codigo_cliente"] = cand

    return out


def detectar_acumulo_pos_media(historico_consumo: list, consumo_atual_kwh: float | None = None,
                                limite_ratio: float = 1.80) -> dict:
    """Detecta consumo atual ANÔMALO vs histórico (acúmulo após faturamento pela média).

    Padrão Art. 86 REN 1.000: UC fica meses sob média/mínimo (medidor com defeito,
    acesso impedido, telemetria perdida), então a leitura real bate e libera o
    acúmulo num único mês.

    Critério: consumo_atual ≥ limite_ratio × média_12m_anterior E media_12m > 0.
    Default 1.80 = 80% acima da média (calibrado em produção 29/05/2026).

    Args:
        historico_consumo: lista [{ano,mes,consumo_ponta_kwh,consumo_fponta_kwh}]
        consumo_atual_kwh: consumo do mês corrente (se None, usa o 1º do histórico)
        limite_ratio: razão pico/média que dispara flag (default 3,0 = 300%)

    Returns:
        dict {flag_acumulo, ratio_pico_media, media_12m_kwh, consumo_atual_kwh}
    """
    if not isinstance(historico_consumo, list) or len(historico_consumo) < 2:
        return {"flag_acumulo": 0}
    # Soma ponta + fponta por mês
    consumos = []
    for h in historico_consumo:
        if not isinstance(h, dict): continue
        p  = float(h.get("consumo_ponta_kwh")  or 0)
        fp = float(h.get("consumo_fponta_kwh") or 0)
        consumos.append(p + fp)
    if len(consumos) < 2:
        return {"flag_acumulo": 0}
    # Atual = primeiro do histórico (mais recente) OU explícito
    atual = consumos[0] if consumo_atual_kwh is None else float(consumo_atual_kwh)
    anteriores = [c for c in consumos[1:] if c > 0]
    if len(anteriores) < 3 or atual <= 0:
        return {"flag_acumulo": 0}
    media = sum(anteriores) / len(anteriores)
    if media <= 0:
        return {"flag_acumulo": 0}
    ratio = atual / media
    return {
        "flag_acumulo": 1 if ratio >= limite_ratio else 0,
        "ratio_pico_media": round(ratio, 2),
        "media_12m_kwh": round(media, 2),
        "consumo_atual_kwh": round(atual, 2),
    }


def validar_acumulo_com_futuras(codigo_uc: str, mes_referencia, consumo_pico_kwh: float,
                                  db_config: dict | None = None) -> dict:
    """Valida classificação de acúmulo olhando 3 faturas futuras da mesma UC.

    Lógica de reclassificação:
    - Sem 3 faturas futuras → 'sem_dados_futuros' (deixa flag_acumulo como está)
    - Média futura ≥ 50% do pico → 'reclassificado_novo_padrao' (cliente novo / mudança real)
    - Média futura ≤ 30% do pico → 'confirmado' (acúmulo real, padrão clássico)
    - Faixa intermediária → 'inconclusivo' (precisa revisão humana)

    Args:
        codigo_uc: código da UC pra match
        mes_referencia: DATE/str da fatura com pico (busca > esse)
        consumo_pico_kwh: consumo total do mês do pico
        db_config: dict de conexão (default DB do completar_vision_5_4)

    Returns dict {classificacao, n_futuras, media_futura_kwh, pct_media_pico}
    """
    if not codigo_uc or not mes_referencia or not consumo_pico_kwh or consumo_pico_kwh <= 0:
        return {"classificacao": "nao_aplicavel"}
    try:
        import mysql.connector
        if db_config is None:
            from completar_vision_5_4 import DB as db_config
        cn = mysql.connector.connect(**db_config)
        cur = cn.cursor(dictionary=True)
        cur.execute("""
            SELECT consumo_ativo_ponta_kwh, consumo_ativo_fponta_kwh
            FROM FATURA_DADOS_EXTRAIDOS
            WHERE codigo_uc = %s
              AND mes_referencia > %s
              AND COALESCE(flag_arquivo_invalido,0) = 0
            ORDER BY mes_referencia ASC LIMIT 3
        """, (codigo_uc, mes_referencia))
        futuras = cur.fetchall()
        cur.close(); cn.close()
    except Exception:
        return {"classificacao": "sem_dados_futuros"}
    if len(futuras) < 3:
        return {"classificacao": "sem_dados_futuros", "n_futuras": len(futuras)}
    consumos = []
    for f in futuras:
        p  = float(f.get("consumo_ativo_ponta_kwh")  or 0)
        fp = float(f.get("consumo_ativo_fponta_kwh") or 0)
        if (p + fp) > 0: consumos.append(p + fp)
    if len(consumos) < 3:
        return {"classificacao": "sem_dados_futuros", "n_futuras": len(consumos)}
    media_fut = sum(consumos) / len(consumos)
    pct = media_fut / float(consumo_pico_kwh)
    if pct >= 0.50:
        classif = "reclassificado_novo_padrao"   # cliente novo / mudança real
    elif pct <= 0.30:
        classif = "confirmado"                   # acúmulo clássico
    else:
        classif = "inconclusivo"
    return {
        "classificacao": classif,
        "n_futuras": len(consumos),
        "media_futura_kwh": round(media_fut, 2),
        "pct_media_pico": round(pct * 100, 1),
    }


def derivar_flag_legado_pre_2023(mes_referencia, data_emissao_nf, validador_gate) -> int:
    """Marca como 1 (legado) quando fatura em revisão E referência pré-2023.

    Faturas pré-2023 APROVADAS ficam = 0 (são histórico válido).
    Faturas pré-2023 em REVISÃO viram = 1 (não vamos mais investir nelas).
    """
    if validador_gate != "revisao":
        return 0
    mes = str(mes_referencia or "")
    if re.match(r"^(0[1-9]|1[0-2])/(2019|2020|2021|2022)$", mes):
        return 1
    if re.match(r"^(2019|2020|2021|2022)-", mes):
        return 1
    try:
        if data_emissao_nf is not None:
            ano = int(str(data_emissao_nf)[:4])
            if 2019 <= ano <= 2022:
                return 1
    except (ValueError, TypeError):
        pass
    return 0


def extrair_historico_equatorial(texto: str) -> list | None:
    """Histórico Equatorial GO — colunas paralelas (demanda + consumos + dias).

    Formato (após bbox-ordenado):
        JUL / 22 850,0000 0,0000 0,0000 26739,72 198513,00 66717,00 30
        Colunas: MES/AA dem_kw pX fpX cons_ponta cons_fp cons_hr dias

    Diferente de Pattern[0] (universal_horiz) que pega só 1º consumo.
    """
    if not texto:
        return None
    out = []
    pat = re.compile(
        r"\b(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\s*/\s*(\d{2})\s+"
        r"([\d.,]+)\s+"        # dem_kw
        r"[\d.,]+\s+[\d.,]+\s+"  # 2 cols extras (postos)
        r"([\d.,]+)\s+"        # cons_ponta
        r"([\d.,]+)\s+"        # cons_fp
        r"([\d.,]+)\s+"        # cons_hr
        r"(\d{1,3})\b",        # dias
        re.I,
    )
    seen = set()
    for m in pat.finditer(texto):
        mes = m.group(1).upper(); ano = 2000 + int(m.group(2))
        chave = (mes, ano)
        if chave in seen: continue
        try:
            dem = float(m.group(3).replace(".","").replace(",","."))
            cp  = float(m.group(4).replace(".","").replace(",","."))
            cf  = float(m.group(5).replace(".","").replace(",","."))
            ch  = float(m.group(6).replace(".","").replace(",","."))
            dias = int(m.group(7))
        except ValueError:
            continue
        if dias < 25 or dias > 35: continue
        seen.add(chave)
        out.append({
            "mes": mes, "ano": ano,
            "demanda_kw": dem,
            "consumo_ponta_kwh": cp,
            "consumo_fora_ponta_kwh": cf,
            "consumo_reservado_kwh": ch,
            "consumo_kwh": cp + cf + ch,   # total p/ compat com outras dists
            "dias_ciclo": dias,
            "_fonte": "hist_equatorial_go",
        })
    return out if out else None


def extrair_notificacoes_debitos(texto: str) -> dict | None:
    """Captura bloco de notificação de faturas vencidas (Equatorial GO/outras)."""
    if not texto: return None
    out = {}
    # 'NOTIFICAÇÃO: 10 FATURAS VENCIDAS: 9/2021 A 6/2022  VALOR TOTAL: R$ 3.896.677,67'
    m = re.search(
        r"NOTIFICA[CÇ][AÃ]O\s*:?\s*(\d{1,3})\s+FATURAS\s+VENCIDAS\s*:?\s*"
        r"(\d{1,2}/\d{4})\s+A\s+(\d{1,2}/\d{4})"
        r"[^R\n]*VALOR\s+TOTAL\s*:?\s*R\$\s*([\d.]+,\d{2})",
        texto, re.I,
    )
    if m:
        try:
            out["debitos_vencidos_qtd"] = int(m.group(1))
            out["debitos_vencidos_periodo"] = f"{m.group(2)} a {m.group(3)}"
            out["debitos_vencidos_valor_rs"] = float(m.group(4).replace(".","").replace(",","."))
        except (ValueError, TypeError): pass
    # Suspensão: 'SUSPENSÃO DO FORNECIMENTO OCORRERÁ APÓS O DIA 03/08/2022'
    m = re.search(
        r"SUSPENS[AÃ]O\s+DO\s+FORNECIMENTO\s+OCORRER[ÁA]\s+AP[ÓO]S\s+O\s+DIA\s+(\d{2}/\d{2}/\d{4})",
        texto, re.I,
    )
    if m:
        from datetime import datetime
        try:
            dt = datetime.strptime(m.group(1), "%d/%m/%Y")
            out["data_prevista_suspensao"] = dt.strftime("%Y-%m-%d")
        except ValueError: pass
    return out if out else None


def extrair_parcelamentos(texto: str) -> list | None:
    """Parcelamentos de débito (REN 1.000 Art. 323/324 e acordos genéricos).

    Cristalizado do colab Codex⇄Claude (2026-06-05): linha real tem rótulo
    'Parcelamento'/'Acordo' + (Artigo NNN | N/M parcela) + valor R$. Conservador:
    só captura linha COM valor monetário (descarta cabeçalho/explicativo sem valor).
    Estrutura: [{artigo, parcela, tipo, valor, texto}]. Vai em _extras_dist.parcelamentos.
    """
    if not texto:
        return None
    MON = r"\d{1,3}(?:\.\d{3})*,\d{2}"
    out, vistos = [], set()
    for ln in texto.splitlines():
        l = ln.strip()
        up = l.upper()
        if "PARCELAMENTO" not in up and "ACORDO DE PARCELA" not in up:
            continue
        m_val = re.search(MON + r"(-)?", l)
        if not m_val:
            continue  # cabeçalho/explicativo sem valor → ignora
        item = {"texto": l[:300]}
        m_art = re.search(r"ARTIGO\s+(\d{2,4})", up) or re.search(r"ART\.?\s*(\d{2,4})", up)
        if m_art:
            item["artigo"] = m_art.group(1)
        m_par = re.search(r"\b(\d{1,2})\s*/\s*(\d{1,2})\b", l)
        if m_par:
            item["parcela"] = f"{m_par.group(1)}/{m_par.group(2)}"
        m_tipo = re.search(r"\b(ABATIMENTO|MULTA|JUROS|CORRE[ÇC][ÃA]O|ICMS|ATUALIZA[ÇC][ÃA]O\s+MONET[ÁA]RIA)\b", up)
        if m_tipo:
            item["tipo"] = m_tipo.group(1).title()
        try:
            v = float(m_val.group(0).rstrip("-").replace(".", "").replace(",", "."))
            if m_val.group(0).endswith("-"):  # trailing minus = abatimento/crédito
                v = -v
            item["valor"] = v
        except ValueError:
            pass
        chave = (item.get("artigo"), item.get("parcela"), item.get("valor"), l[:30])
        if chave in vistos:
            continue
        vistos.add(chave)
        out.append(item)
    return out or None


def extrair_devolucoes_subvencoes(texto: str) -> list | None:
    """Devoluções/restituições/subvenções COM valor (itens negativos reais, R4).

    Cristalizado do colab (2026-06-05). Critério rígido: linha com valor monetário
    E palavra-chave de devolução real (Devolução/Restituição/Ressarcimento/Subvenção).
    EXCLUI texto de GD/SCEE (Energia Injetada/Saldo/Créditos a Expirar/aneel.gov.br) —
    isso é tratado por extrair_gd_correto, não é devolução.
    Estrutura: [{tipo, descricao, valor}]. Vai em _extras_dist.devolucoes.
    """
    if not texto:
        return None
    MON = r"-?\s*\d{1,3}(?:\.\d{3})*,\d{2}-?"
    KW_INCLUI = ("DEVOLU", "RESTITUI", "RESSARCIMENTO", "SUBVEN")
    KW_GD = ("ENERGIA INJET", "INJETAD", "SALDO", "CRÉDITOS A EXPIRAR", "CREDITOS A EXPIRAR",
             "ANEEL.GOV", "COMPENSAD", "SCEE")
    out, vistos = [], set()
    for ln in texto.splitlines():
        l = ln.strip()
        up = l.upper()
        if not any(k in up for k in KW_INCLUI):
            continue
        if any(k in up for k in KW_GD):
            continue  # é GD, não devolução
        if up.startswith(("PIS", "COFINS", "ICMS")) or "PIS/COFINS DA SUBVEN" in up:
            continue  # é o TRIBUTO sobre a subvenção, não a subvenção em si
        m = re.search(MON, l)
        if not m:
            continue
        raw = m.group(0).replace(" ", "")
        neg = raw.startswith("-") or raw.endswith("-")
        try:
            v = float(raw.strip("-").replace(".", "").replace(",", "."))
        except ValueError:
            continue
        if neg:
            v = -v
        if "SUBVEN" in up:      tipo = "subvencao"
        elif "RESTITUI" in up:  tipo = "restituicao"
        elif "RESSARC" in up:   tipo = "ressarcimento"
        else:                   tipo = "devolucao"
        chave = (tipo, round(v, 2), l[:40])
        if chave in vistos:
            continue
        vistos.add(chave)
        out.append({"tipo": tipo, "descricao": l[:200], "valor": round(v, 2)})
    return out or None


def avaliar_consenso_core(texto_plumber: str, texto_md: str = None) -> dict | None:
    """Consenso multi-fonte (Tier 3-G) em campos CORE — detecta divergência plumber↔markdown.

    NÃO-DESTRUTIVO: não altera nenhum valor extraído. Só extrai o mesmo campo de cada fonte
    independentemente, compara o valor normalizado e registra as variantes + flag de
    concordância em _extras_dist._consenso_core. Divergência → fatura candidata a revisão
    humana (sinal de baixa confiança no valor core). Cristalizado do método do Codex no raw.
    """
    if not texto_plumber or not texto_md:
        return None
    pares = {
        "valor_total": extrair_valor_total_universal,
        "cnpj_cliente": extrair_cnpj_cliente_universal,
    }
    out, divergencias = {}, 0
    for campo, fn in pares.items():
        vp, vm = fn(texto_plumber), fn(texto_md)
        if vp is None and vm is None:
            continue

        def _norm(v):
            if v is None:
                return None
            s = str(v)
            return re.sub(r"\D", "", s) if campo == "cnpj_cliente" else s.replace(".", "").replace(",", ".")

        np_, nm_ = _norm(vp), _norm(vm)
        concordam = (np_ == nm_) if (np_ and nm_) else None
        if concordam is False:
            divergencias += 1
        out[campo] = {"plumber": vp, "markdown": vm, "concordam": concordam}
    if not out:
        return None
    out["_divergencias"] = divergencias
    return out


def extrair_vrc_cfop(texto: str) -> dict:
    """Captura VRC (indicador continuidade) + CFOP."""
    if not texto: return {}
    out = {}
    m = re.search(r"VRC\s*=\s*R\$?\s*([\d.]+,\d+)", texto, re.I)
    if m: out["vrc_indicador_continuidade"] = m.group(1)
    m = re.search(r"\bCFOP\s+(\d{4})\s*:\s*([^\n]{5,80})", texto, re.I)
    if m:
        out["cfop"] = m.group(1)
        out["cfop_descricao"] = m.group(2).strip()[:120]
    return out


def extrair_composicao_consumo(texto: str) -> dict | None:
    """Extrai a 'COMPOSIÇÃO DO CONSUMO' (Enel SP/Light/etc) — decomposição da fatura.

    Formato típico:
      Geração de Energia R$ 236,53 34,48%
      Transmissão R$ 25,01 3,65%
      Distribuição R$ 122,59 17,87%
      Perdas de Energia R$ 38,39 5,60%
      Encargos Setoriais R$ 45,02 6,56%
      Tributos R$ 218,39 31,84%

    Devolve dict com cada componente {valor, pct} ou None se não achar.
    """
    if not texto or "COMPOSI" not in texto.upper():
        return None
    out = {}
    # Cada componente: NOME R$ VALOR PCT%
    componentes = {
        "geracao_energia":  r"Ger[aã][cç][aã]o\s+de\s+Energia",
        "transmissao":      r"Transmiss[aã]o",
        "distribuicao":     r"Distribui[cç][aã]o(?:\s*\([^)]+\))?",
        "perdas":           r"Perdas\s+de\s+Energia",
        "encargos_setoriais": r"Encargos\s+Setoriais",
        "tributos":         r"Tributos",
    }
    for chave, padrao in componentes.items():
        m = re.search(
            padrao + r"\s+R\$\s*(-?\d[\d.]*,\d{2})\s+(\d{1,3}(?:,\d+)?)\s*%",
            texto, re.I,
        )
        if m:
            try:
                v = float(m.group(1).replace(".","").replace(",","."))
                p = float(m.group(2).replace(",","."))
                out[chave] = {"valor_rs": v, "percentual": p}
            except ValueError:
                continue
    # Total (opcional — pode validar soma)
    m = re.search(r"Total\s+R\$\s*(-?\d[\d.]*,\d{2})", texto, re.I)
    if m:
        try:
            out["total_rs"] = float(m.group(1).replace(".","").replace(",","."))
        except ValueError:
            pass
    return out if out else None


# CIP por LINHA (conferência visual 11/10/2026: 339 faturas sem CIP + ~40 com valor errado).
# Rótulo no INÍCIO da linha (aceita código '0807 ' / '(GY) ' / 'DEV ' antes) e valor = 1º número
# com EXATAMENTE 2 decimais depois dele — pula quantidade '1,0000' (EDP), tarifa '177,190000'
# (Copel), '0,000 0,000000' (Celesc). Multa/juros de CIP (Eletropaulo 'J&AM CIP', 'MULTA CIP') e
# textos informativos ('Responsável pela Iluminação Pública') não casam porque não começam a linha.
# Várias linhas de CIP SOMAM (Light 'Contrib Ilum Pública' + 'Complemento COSIP RJ'; devolução
# 'DEV CONTR ILUM' entra negativa). Dedup por valor (o mesmo item aparece repetido no texto).
#   Santa Cruz/Jaguari 'Contribuição Custeio IP-CIP SET/26 3,85' | Coelba/Cosern 'Ilum. Púb. Municipal'
#   Equatorial 'Cip-Ilum Pub Pref Munic' / 'CONTRIB. ILUM. PÚBLICA - MUNICIPAL' | Copel 'CONT ILUMIN
#   PUBLICA MUNICIPIO UN 177,190000 177,19' | Energisa 'CONTRIB SERV.ILUM.PÚBLICA' / 'CONTR ILUM E MONIT'
_CIP_LINHA_RE = re.compile(
    r"^\s*(?:\d{4}\s+|\([A-Z0-9]{2}\)\s+)?(?:DEV(?:OL[A-ZÇÃ]*)?\.?\s+)?"
    r"(?:CIP\b|COSIP\b|Cip-Ilum|C\s?I\s?P\s+-|Complemento\s+COSIP|"
    r"CONT(?:R|RIB)?[\.\s]+(?:SERV[\.\s]*)?ILUM|"
    r"Contribui[çc][ãa]o\s+(?:de\s+|para\s+)?(?:Custeio\s+)?(?:IP\b|Ilum)|"
    r"Contrib[\.\s]+Custeio|Cobran[çc]a\s+Ilum|Ilum[\.\s]+P[úu]b)",
    re.I)
_CIP_VAL_RE = re.compile(r"(?<![\d,.])(-?\d{1,3}(?:\.\d{3})*,\d{2})(?![\d,])")




# Demanda FATURADA fora ponta (kW) — conferência visual 15/10/2026: coluna demanda_faturada_fponta_kw
# vinha vazia em quase todo Grupo A. Definição: total de demanda FP/única que a fatura COBRA (parcela
# com + sem ICMS + ultrapassagem) = contratada, ou a medida quando passa dela. Validado em 884 faturas
# lidas na imagem (550 exatas; ~120 diferem só por o agente ter lido a medida em vez da cobrada).
_DFP_N = r"(\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:[.,]\d+)?)"
_DFP_KW = r"[\s(]*k[wW]\)?[\s:]*"
# (rótulo de cobrança de demanda FORA PONTA / ÚNICA, com a quantidade logo depois)
_DFP_LINHAS = [
    rf"^(?:\(\w\w\)\s*)?Demanda{_DFP_KW}{_DFP_N}\b",                                   # Celesc (4U) Demanda KW 37,790
    rf"^(?:\(\w\w\)\s*)?Diferen[çc]a\s+d[ae]\s+Demanda\s+Contratada{_DFP_KW}{_DFP_N}",   # Celesc (5N)/(5S)
    rf"^Uso\s+Sist\.\s*Distr\..*?\bkW\s+{_DFP_N}",                                   # CPFL: Uso Sist. Distr. ... kW 14,6160
    rf"^Componente\s+Fio(?:\s+HFP)?(?:\s+s/\s*ICMS)?{_DFP_KW}(?:HFP{_DFP_KW})?{_DFP_N}",      # Light / CEMIG
    rf"^Uso\s+(?:Sistema\s+)?Fio(?:-Lim|_Sem\s+ICMS)?{_DFP_KW}{_DFP_N}",                   # Neoenergia
    rf"^Demanda\s+Distrib(?:ui[çc][ãa]o|\.)(?:\s+Isenta\s+ICMS|\s+sem\s+ICMS|\s+Ult\.?)?{_DFP_KW}{_DFP_N}",  # Enel CE / Equatorial
    rf"^DEMANDA\s+(?:[ÚU]NICA|FORA\s+PONTA)\s+C/\s*DESCONTO{_DFP_KW}{_DFP_N}",           # Enel SP
    rf"^DEMANDA\s+DE\s+DISTRIBUICAO\s+TUSD{_DFP_KW}{_DFP_N}",                            # Copel / Elektro
    rf"^DEMANDA\s+DE\s+DISTRIBUICAO\s+TUSD\s+ISENTA\s*k?\s*W?\s*ICMS(?:[\s(]*k[wW]\)?)?\s+{_DFP_N}",  # (texto quebrado 'ISENTAk WICMS')
    rf"^DEMANDA\s+FP(?:\s+ISENTO\s+DE\s+ICMS)?{_DFP_KW}{_DFP_N}",                        # Equatorial GO
    rf"^DEMANDA\s+HFP{_DFP_KW}{_DFP_N}",
    rf"^DEMANDA\s+TUSD(?:\s+ISENTA\s+ICMS)?{_DFP_KW}{_DFP_N}",                          # Elektro (horária verde)
    rf"^Demanda\s+Distrib(?:ui[çc][ãa]o|\.)\s+(?:F\.?\s*Ponta|FP)(?:\s+Isenta\s+ICMS)?{_DFP_KW}{_DFP_N}",  # Enel CE / Equatorial A4 Azul                                                 # DME
]
# quadro com a demanda faturável (contratada) — Ampla/Enel CE 'DEMANDA FORA PONTA - KW 95,00',
# Enel SP 'Demanda fora ponta - KW 600,000' / 'Demanda - KW 880,000' (única). Quando existe, vale
# quadro + ultrapassagem (a linha de cobrança separa só a parcela com/sem ICMS da mesma demanda).
_DFP_RESUMO = re.compile(r"\bDEMANDA\s+(?:FORA\s+PONTA\s*)?-\s*KW\s+(\d{1,3}(?:\.\d{3})*,\d{2,3})\b", re.I)
_DFP_RESUMO2 = re.compile(r"Demanda\s+fora\s+ponta\s*-\s*kW\s*\n\s*(\d{1,3}(?:\.\d{3})*(?:,\d+)?)\s*\n\s*Demanda\s+TUSDG", re.I)  # Energisa (grandezas contratadas)
# Enel SP/Eletropaulo: coluna de itens colada na linha do medidor ('... ENRG ATV PONTA ... DEMANDA ÚNICA C/ DESCONTO KW 119,113')
_DFP_MEIO = re.compile(r"DEMANDA\s+(?:[ÚU]NICA|FORA\s+PONTA)\s+C/\s*DESCONTO\s+KW\s+(\d{1,3}(?:\.\d{3})*,\d{3})", re.I)
_DFP_ULT = re.compile(rf"^Demanda\s+Distrib(?:ui[çc][ãa]o|\.)\s+Ult\w*\.?(?:\s+F\.?\s*P\w*)?{_DFP_KW}{_DFP_N}|ULTRAPASS\w*.*?{_DFP_KW}{_DFP_N}", re.I)
_DFP_CODIGO = re.compile(r"^\s*(?:[A-Z]\s+)?(?:\d{3,4}\s+)?")


def _dfp_f(s):
    s = s.strip()
    if "," in s:
        return float(s.replace(".", "").replace(",", "."))
    if re.fullmatch(r"\d{1,3}(?:\.\d{3})+", s):
        return float(s.replace(".", ""))
    return float(s)


def extrair_demanda_faturada_fp(texto: str) -> float | None:
    """Demanda faturada fora ponta (kW) = soma das linhas de cobrança de demanda FP/única
    (com e sem ICMS). Fallback: quadro 'DEMANDA FORA PONTA - KW X'. None se não achar."""
    if not texto:
        return None
    vals = []
    pats = [re.compile(p, re.I) for p in _DFP_LINHAS]
    for ln in texto.splitlines():
        ln2 = _DFP_CODIGO.sub("", ln.strip(), count=1)
        if re.search(r"PONTA\b", ln2, re.I) and not re.search(r"FORA\s+(?:DE\s+)?PONTA|F\.\s*PONTA|HFP", ln2, re.I):
            if not re.match(r"^DEMANDA\s+[ÚU]NICA", ln2, re.I):
                continue
        for p in pats:
            m = p.search(ln2)
            if m:
                try:
                    v = _dfp_f(m.group(1))
                except ValueError:
                    break
                chave = re.sub(r"\s+", " ", ln2)[:60]          # mesma linha repetida no texto = 1 só
                if v > 0 and chave not in [c for _, c in vals]:
                    vals.append((round(v, 3), chave))
                break
    for m in _DFP_MEIO.finditer(texto):
        v = _dfp_f(m.group(1))
        if v > 0 and (round(v, 3), "meio") not in vals:
            vals.append((round(v, 3), "meio"))
    m = _DFP_RESUMO.search(texto) or _DFP_RESUMO2.search(texto)
    if m:
        try:
            base = _dfp_f(m.group(1))
        except ValueError:
            base = None
        if base:
            ult = 0.0
            for ln in texto.splitlines():
                l2 = _DFP_CODIGO.sub("", ln.strip(), count=1)
                u = _DFP_ULT.search(l2)
                if u and not (re.search(r"PONTA", l2, re.I) and not re.search(r"F\.?\s*P|FORA", l2, re.I)):
                    try: ult += _dfp_f(u.group(1) or u.group(2))
                    except (ValueError, TypeError): pass
            soma = sum(v for v, _ in vals)
            return round(max(base + ult, soma), 3)   # medida acima da contratada: vale a cobrada
    if vals:
        return round(sum(v for v, _ in vals), 3)
    return None


def extrair_cip_linhas(texto: str) -> float | None:
    """CIP/COSIP somando as linhas de CIP do texto (ver _CIP_LINHA_RE). None se não achar."""
    if not texto:
        return None
    vals = []
    for ln in texto.splitlines():
        if not _CIP_LINHA_RE.search(ln):
            continue
        m = _CIP_VAL_RE.search(ln)
        if not m:
            continue
        v = round(float(m.group(1).replace(".", "").replace(",", ".")), 2)
        if v and v not in vals:
            vals.append(v)
    return round(sum(vals), 2) if vals else None


def extrair_cip_do_texto(texto: str) -> float | None:
    """Fallback: busca CIP/COSIP diretamente no texto quando não está nos itens.

    Cobre layouts onde a CIP não vira item estruturado:
      - Enel SP: '0807 COSIP - SÃO PAULO - MUNICIPAL 103,79'
      - Enel RJ Ampla antigo: 'Contribuicao Iluminacao Publica-Prefeitura 39,83'
      - Padrão genérico: 'COSIP ... X,YY' / 'CIP ... X,YY'

    Devolve o MAIOR valor encontrado (CIP única por fatura).
    """
    if not texto:
        return None
    candidatos = []
    # Pattern 1: linha CCI com COSIP/CIP (Enel SP/Light)
    for m in re.finditer(
        r"\b0\d{3}\s+(?:COSIP|CIP)\b[A-ZÀ-Ÿ\s\-/]*?(-?\d{1,3}(?:\.\d{3})*,\d{2})(?:\s|$)",
        texto, re.I,
    ):
        try: candidatos.append(float(m.group(1).replace(".","").replace(",",".")))
        except: pass
    # Pattern 2: 'Contribuicao Iluminacao Publica' (Enel RJ antigo) + 'Contrib de Ilum Pub' (Energisa)
    # Inclui: 'Contribuição de Ilum. Pública - Lei Municipal' (Light Via Varejo)
    # Inclui: 'Contrib. Custeio IP-CIP Municipal' (CPFL)
    for m in re.finditer(
        r"(?:Contribui[çc][ãa]o\s+(?:de\s+)?Ilumina[çc][ãa]o\s+P[úu]blic|"
        r"Contribui[çc][ãa]o\s+(?:de\s+)?Ilum[\.\s]+P[úu]blic|"      # Light
        r"Contrib[\.\s]+(?:de\s+)?Ilum[\.\s]+Pub|"
        r"Contrib[\.\s]+Custeio\s+IP[\-\s]?CIP|"                     # CPFL
        r"Cobranca\s+Ilum\s+Publ)"
        r"[A-Za-zÀ-ÿ0-9\s\.\-/]*?(-?\d{1,3}(?:\.\d{3})*,\d{2})",      # aceita dígitos no meio (MES/AA)
        texto, re.I,
    ):
        try: candidatos.append(float(m.group(1).replace(".","").replace(",",".")))
        except: pass
    if not candidatos:
        return None
    # CIP única por fatura — devolve o maior absoluto (alguns casos têm 0,00 antes)
    return round(max(candidatos, key=abs), 2)


def extrair_cip_iluminacao_publica(itens: list) -> float | None:
    """Soma os valores de itens classificados como CIP/COSIP (Iluminação Pública).

    CIP é isenta de ICMS, por isso não entra em icms_base_te/tusd. Retorna o
    valor somado em float ou None se não houver item CIP nos itens.
    """
    if not isinstance(itens, list):
        return None
    total = 0.0
    achou = False
    _seen = set()
    for it in itens:
        d = str(it.get("descricao") or "")
        if not _DESC_CIP_RE.search(d):
            continue
        # Valor: prefere valor_brl_numerico, fallback string
        v = it.get("valor_brl_numerico")
        if v is None and it.get("valor_brl_string"):
            try: v = float(str(it["valor_brl_string"]).replace(".","").replace(",","."))
            except (ValueError, TypeError): v = None
        try: v = float(v or 0)
        except (ValueError, TypeError): v = 0.0
        if v == 0:
            continue
        # Dedup on-the-fly (itens antigos podem ter duplicata)
        chave = (re.sub(r"\s+", " ", d).strip().upper(), round(v, 2))
        if chave in _seen:
            continue
        _seen.add(chave)
        total += v
        achou = True
    return round(total, 2) if achou else None


def extrair_icms_te_tusd(itens: list) -> dict:
    """TR-1 — separa ICMS base por componente TE vs TUSD.

    Lê itens_fatura[].descricao + icms_base_numerico; classifica por keyword.
    Útil pra detectar ICMS indevido sobre TUSD (LC 194/2022).

    Reclassificação Light ACL: quando há item 'Terc Comercializ' (mercado livre
    Light RJ), o item 'Consumo Energia Elétrica' representa apenas a parcela fio
    (TUSD da Light); o cliente paga TE separadamente à comercializadora. Logo,
    a base ICMS no consumo vira TUSD.
    """
    if not isinstance(itens, list):
        return {}
    # Detecta layout ACL Light (presença de 'Terc Comercializ' nos itens)
    eh_acl_light = any(
        "TERC COMERCIAL" in str(it.get("descricao") or "").upper()
        or "COMERCIALIZAD" in str(it.get("descricao") or "").upper()
        for it in itens
    )
    base_te = 0.0
    base_tusd = 0.0
    # Dedup on-the-fly: itens do JSON gravados antes do fix dedup do extrator_v2
    # podiam vir como 'Consumo em kWh' + 'Consumo em kWh KWH'. Normaliza chave.
    _seen = set()
    for it in itens:
        d = str(it.get("descricao") or "")
        # icms_base — preferir numérico, fallback string→float, último recurso valor do item
        b = it.get("icms_base_numerico")
        if b is None and it.get("icms_base_string"):
            try: b = float(str(it["icms_base_string"]).replace(".","").replace(",","."))
            except (ValueError, TypeError): b = None
        try: b = float(b or 0)
        except (ValueError, TypeError): b = 0.0
        if b <= 0:
            continue
        # Dedup: remove sufixo de unidade em cascata + valor arredondado como chave
        d_norm = re.sub(r"(?:\s+(?:kWh|KWH|kW|KW|UN|UNI))+\s*$", "", d, flags=re.I)
        d_norm = re.sub(r"\s+", " ", d_norm).strip().upper()
        chave = (d_norm, round(b, 2))
        if chave in _seen:
            continue
        _seen.add(chave)
        # Atalho: se o extrator específico já marcou explicitamente
        if it.get("eh_componente_tusd"):
            base_tusd += b
            continue
        if it.get("eh_componente_te"):
            base_te += b
            continue
        # ACL Light: Consumo Energia Elétrica = TUSD (fio); TE vai pra Terc (mas base é null)
        if eh_acl_light and re.search(r"consumo\s+energia\s+el[ée]trica", d, re.I):
            base_tusd += b
            continue
        if _DESC_TUSD_RE.search(d):
            base_tusd += b
        elif _DESC_TE_RE.search(d):
            base_te += b
    out = {}
    # Em ACL Light: força limpeza de TE (toda a base vai pra TUSD).
    # Sem ACL: deixa só o lado que tem valor (não interfere no outro).
    if eh_acl_light:
        out["icms_base_te"] = round(base_te, 2) if base_te > 0 else None
        out["icms_base_tusd"] = round(base_tusd, 2) if base_tusd > 0 else None
    else:
        if base_te > 0:   out["icms_base_te"] = round(base_te, 2)
        if base_tusd > 0: out["icms_base_tusd"] = round(base_tusd, 2)
    return out


def extrair_flag_faturamento_media(texto: str) -> bool:
    """Detecta legenda 'FATURAMENTO PELA MÉDIA/MÍNIMO' (Art. 86 REN 1.000) ou 'Faturado pela média'."""
    return bool(re.search(
        r"FATURAMENTO\s+PELA\s+M[ÉE]DIA(?:[/\s]+M[IÍ]NIMO)?|Faturado\s+pela\s+m[ée]dia",
        texto, re.I
    ))


def extrair_motivo_faturamento_media(texto: str) -> dict:
    """Identifica a CAUSA do faturamento pela média (Energisa MT — campo Atenção).

    Categorias retornadas em ordem de prioridade:
      - 'telemetria_defeito_medidor'  -> TELEMETRIA C/MEDIDOR... DEFEITO
      - 'telemetria_perda_parametro'  -> TELEMETRIA C/PERDA DE PARÂMETRO
      - 'acesso_impedido'             -> Acesso impedido por X
      - 'leitura_plurimensal'         -> Rota rural / UC plurimensal (Art. 86)
      - 'faturado_pela_media_generico'-> sem motivo identificável mas há flag

    Retorna {motivo_faturamento_categoria, motivo_faturamento_texto} ou {} se nada.
    """
    out = {}
    txt = texto or ""

    # 1) Telemetria com defeito de medidor — só caixa-alta inline (sem ruído da linha seguinte)
    m = re.search(r"TELEMETRIA[ \t]+C[/\\][A-ZÀ-Ÿ0-9 \t/\\.,\-]+DEFEITO[A-ZÀ-Ÿ0-9 \t/\\.,\-]*", txt)
    if m:
        out["motivo_faturamento_categoria"] = "telemetria_defeito_medidor"
        out["motivo_faturamento_texto"] = re.sub(r"[\s\-,.]+$", "", m.group(0).strip())[:200]
        return out

    # 2) Telemetria com perda de parametro — idem
    m = re.search(r"TELEMETRIA[ \t]+C[/\\][A-ZÀ-Ÿ0-9 \t/\\.,\-]+PAR[ÂA]METRO[A-ZÀ-Ÿ0-9 \t/\\.,\-]*", txt)
    if m:
        out["motivo_faturamento_categoria"] = "telemetria_perda_parametro"
        out["motivo_faturamento_texto"] = re.sub(r"[\s\-,.]+$", "", m.group(0).strip())[:200]
        return out

    # 3) Acesso impedido (chuva, animal, ausente, portão, etc.)
    m = re.search(r"Acesso\s+impedido(?:\s+por\s+[^\n.]{2,60})?", txt, re.I)
    if m:
        out["motivo_faturamento_categoria"] = "acesso_impedido"
        out["motivo_faturamento_texto"] = m.group(0).strip()[:200]
        return out

    # 4) Leitura plurimensal (rota rural — Art. 86 Res. 414 ANEEL — LEGAL)
    m = re.search(
        r"(Rota\s+rural[^\n]{0,80}plurimensal[^\n]{0,80}|"
        r"Sua\s+UC\s+(?:é|e)\s+plurimensal[^\n]{0,80}|"
        r"Leitura\s+plurimensal[^\n]{0,80})",
        txt, re.I
    )
    if m:
        out["motivo_faturamento_categoria"] = "leitura_plurimensal"
        out["motivo_faturamento_texto"] = re.sub(r"\s+", " ", m.group(0).strip())[:200]
        return out

    # 5) Fallback: tem flag de média mas sem motivo identificável no texto
    if extrair_flag_faturamento_media(txt):
        out["motivo_faturamento_categoria"] = "faturado_pela_media_generico"

    return out


# ────────────────────────────────────────────────────────────────────────
# 13. Código de instalação ANEEL (NOVO) + medidor
# ────────────────────────────────────────────────────────────────────────
# ────────────────────────────────────────────────────────────────────────
# Candidate scorer: classifica candidatos a UC/medidor/matrícula/cód.pagador
# ────────────────────────────────────────────────────────────────────────
def _score_identificador(valor: str, contexto: str, linha: str) -> dict:
    """Pontua um candidato (string numérica) como UC/medidor/matrícula/pagador.

    Retorna dict {valor, tipo (max score), score, scores_por_tipo}.
    Quanto maior o score, maior a confiança.
    """
    ctx = (contexto or "").upper()
    lin = (linha or "").upper()
    scores = {"uc": 0, "medidor": 0, "matricula": 0, "codigo_pagador": 0}

    # UC ANEEL NOVA: formato X.XXX.XXX.XXX-XX (10 dígitos + DV)
    if re.fullmatch(r"\d\.\d{3}\.\d{3}\.\d{3}-\d{2}", valor):
        scores["uc"] += 70
    # UC dígitos puros 12-13 chars
    if re.fullmatch(r"0?\d{12,13}", valor):
        scores["uc"] += 40
    if any(k in ctx for k in ["UNIDADE CONSUMIDORA", "N° UC", "NRO UC", "INSTALAÇÃO", "INSTALACAO"]):
        scores["uc"] += 45  # contexto forte de UC/instalação clareia o limiar (40) sozinho — cobre install 10 dígitos (CEMIG)
    # Contexto pré-classificação (RURAL/COMERCIAL/etc seguido do valor)
    if re.search(r"\b(?:RURAL|URBANA|COMERCIAL|RESIDENCIAL|INDUSTRIAL|AGROPECU[AÁ]RIA)\s+" + re.escape(valor), contexto, re.I):
        scores["uc"] += 30

    # MEDIDOR: prefixo letra + dígitos (W9012463502, D7086414011, N5242008749)
    if re.fullmatch(r"[A-Z]\d{8,12}", valor):
        scores["medidor"] += 70
        # na linha de medição, o medidor COM letra vence o dígito-puro (que é o mesmo
        # nº sem o prefixo) — senão o 'W9012463502' perde pro '9012463502'
        if re.search(r"\bENERGIA\s+ATIVA\s+EM\s+KWH\b", lin, re.I):
            scores["medidor"] += 40
    # MEDIDOR dígitos puros 10-12 chars, mas precisa de contexto fortíssimo
    if re.fullmatch(r"\d{10,12}", valor) and re.search(r"\bENERGIA\s+ATIVA\s+EM\s+KWH\b", lin, re.I):
        scores["medidor"] += 80  # forte: aparece antes de "Energia ativa em kWh"
    if any(k in ctx for k in ["MEDIDOR", "LEITURA ANTERIOR", "LEITURA ATUAL", "CONSTANTE", "CONST MED"]):
        scores["medidor"] += 40

    # MATRÍCULA: formato NNNNNNN-AAAA-N-N
    if re.fullmatch(r"\d{7}-\d{4}-\d-\d", valor):
        scores["matricula"] += 80
    if any(k in ctx for k in ["MATRÍCULA", "MATRICULA"]):
        scores["matricula"] += 50

    # CÓDIGO PAGADOR/CLIENTE: formato N/NNNNNNN-N (ex: 6/3138627-9)
    if re.fullmatch(r"\d+/\d+-\d", valor):
        scores["codigo_pagador"] += 70
    if any(k in ctx for k in ["PAGADOR", "CLIENTE", "RANI"]):
        scores["codigo_pagador"] += 30

    tipo = max(scores, key=scores.get)
    return {"valor": valor, "tipo": tipo, "score": scores[tipo], "scores": scores}


def extrair_identificadores_scoring(texto: str) -> dict:
    """Coleta todos os candidatos de identificadores e atribui ao melhor scorer.

    Retorna: {codigo_instalacao, medidor, matricula, codigo_pagador, _scoring}
    com o melhor candidato pra cada tipo (score ≥ threshold).
    """
    if not texto: return {}

    # Coleta candidatos por padrão estrutural
    # Remove a chave de acesso NF3e (44 dígitos) ANTES de coletar candidatos —
    # senão seus 13 primeiros dígitos (UF+AAMM+início do CNPJ) viram um falso
    # candidato a UC, idêntico em todas as faturas do mesmo cliente/período
    # (bug que colava dezenas de faturas numa "UC" só).
    # Substitui a chave por espaços do MESMO tamanho (preserva posições/linhas
    # usadas no scoring de contexto abaixo).
    texto_sem_chave = re.sub(r"(?<!\d)\d{44}(?!\d)", lambda m: " " * 44, texto)

    candidatos_set = set()
    for pat in (
        r"\d\.\d{3}\.\d{3}\.\d{3}-\d{2}",      # UC ANEEL novo
        r"(?<!\d)0?\d{12,13}(?!\d)",             # UC dígitos puros (com fronteira: não casa fragmento de chave)
        r"[A-Z]\d{8,12}",                        # medidor com prefixo
        r"(?<!\d)\d{10,12}(?!\d)",               # dígitos puros 10-12
        r"\d{7}-\d{4}-\d-\d",                    # matrícula
        r"\d+/\d+-\d",                           # código pagador
    ):
        for m in re.finditer(pat, texto_sem_chave):
            candidatos_set.add((m.group(0), m.start()))

    # Pontua cada candidato com contexto local (±100 chars)
    scored = []
    # Ordem fixa (posição no texto): um set itera em ordem de hash, que muda a cada processo
    # (PYTHONHASHSEED) — em empate de score a UC escolhida variava entre execuções (ex.: Copel,
    # 3 números de 12 dígitos na mesma linha). Agora, em empate, vence o que aparece primeiro.
    for valor, pos in sorted(candidatos_set, key=lambda c: (c[1], c[0])):
        start = max(0, pos - 100)
        end = min(len(texto), pos + len(valor) + 100)
        contexto = texto[start:end]
        # Linha do candidato (do último \n até próximo \n)
        line_start = texto.rfind("\n", 0, pos) + 1
        line_end = texto.find("\n", pos)
        if line_end == -1: line_end = len(texto)
        linha = texto[line_start:line_end]
        scored.append(_score_identificador(valor, contexto, linha))

    # Seleciona melhor por tipo (mínimo score 40 pra ter confiança)
    out = {"codigo_instalacao": None, "medidor": None, "matricula": None, "codigo_pagador": None}
    melhor_por_tipo = {}
    for s in scored:
        tipo = s["tipo"]
        if s["score"] < 40: continue
        if tipo not in melhor_por_tipo or s["score"] > melhor_por_tipo[tipo]["score"]:
            melhor_por_tipo[tipo] = s

    if "uc" in melhor_por_tipo:
        out["codigo_instalacao"] = melhor_por_tipo["uc"]["valor"]
        out["_codigo_instalacao_fonte"] = "scoring_uc"
    if "medidor" in melhor_por_tipo:
        out["medidor"] = melhor_por_tipo["medidor"]["valor"]
    if "matricula" in melhor_por_tipo:
        out["matricula"] = melhor_por_tipo["matricula"]["valor"]
    if "codigo_pagador" in melhor_por_tipo:
        out["codigo_pagador"] = melhor_por_tipo["codigo_pagador"]["valor"]

    # Fallback pré-ANEEL: se sem UC mas tem medidor + frase pré-ANEEL → usa medidor
    if not out["codigo_instalacao"] and out["medidor"]:
        eh_pre_aneel = bool(
            re.search(r"n[uú]mero de identifica[çc][ãa]o ser[áa] atualizado", texto, re.I)
            or re.search(r"DATA\s+DE?\s+EMISS[ÃA]O\s*:?\s*\d{2}/\d{2}/(?:201\d|2020|2021|2022|2023|2024|2025)", texto, re.I)
        )
        if eh_pre_aneel:
            out["codigo_instalacao"] = out["medidor"]
            out["_codigo_instalacao_fonte"] = "medidor_pre_aneel"

    out["_scoring"] = {"candidatos_avaliados": len(scored)}
    return out


def extrair_codigo_instalacao(texto: str) -> dict:
    """Distingue UC ANEEL (NOVA) do número do medidor.

    Padrão Energisa MT (e Energisa em geral):
      - UC ANEEL NOVA: formato X.XXX.XXX.XXX-XX (10 dígitos com pontos + DV)
        aparece após a classificação ('RURAL') e antes da NF
      - Medidor físico: prefixos W/D/N/E/00 + dígitos (ex: W9012463502, D7086414011)
        aparece em 'Medidor: ...' OU como linha solo no cabeçalho

    Fatura PRÉ-ANEEL (antes de 01/04/2026): UC ANEEL nova ainda não existe — usa
    o número do MEDIDOR como `codigo_instalacao` (decisão semântica: é o melhor
    identificador disponível). Marca `_codigo_instalacao_fonte=medidor_pre_aneel`.

    Refatorado para usar candidate_scorer (extrair_identificadores_scoring).
    """
    # PRIORIDADE CEMIG/NF3e: label "Nº DA INSTALAÇÃO" seguido (após a linha de
    # timestamp de autorização) do número real de 10-13 dígitos. Tem precedência
    # sobre o scoring fuzzy, que na CEMIG confunde a Instalação com o "Código de
    # Débito Automático" (12 díg.) impresso ao lado do mesmo cabeçalho de tabela.
    if texto:
        # 1º número de 10 dígitos isolado dentro dos ~90 chars após o label
        # (pula a linha de timestamp de autorização que vem entre o label e o nº).
        m = re.search(
            r"N[ºo°]\s+DA\s+INSTALA[ÇC][ÃA]O[\s\S]{0,90}?(?<!\d)(\d{10})(?!\d)",
            texto, re.I,
        )
        if m:
            return {"codigo_instalacao": m.group(1), "codigo_instalacao_antigo": None,
                    "medidor": None, "_codigo_instalacao_fonte": "anchor_n_instalacao"}
        # 2ª âncora — tabela "Código de Débito Automático | Instalação | Vencimento":
        # o débito é 12 díg. e a Instalação é o 1º nº de 10 díg. logo após.
        m = re.search(
            r"D[ée]bito\s+Autom[áa]tico[\s\S]{0,250}?(?<!\d)(\d{10})(?!\d)",
            texto, re.I,
        )
        if m:
            return {"codigo_instalacao": m.group(1), "codigo_instalacao_antigo": None,
                    "medidor": None, "_codigo_instalacao_fonte": "anchor_debito_tabela"}

    # NOVA estratégia: scoring de candidatos
    out_scoring = extrair_identificadores_scoring(texto)
    if out_scoring.get("codigo_instalacao") or out_scoring.get("medidor"):
        # Mantém formato de retorno compatível com o caller
        return {
            "codigo_instalacao": out_scoring.get("codigo_instalacao"),
            "codigo_instalacao_antigo": None,
            "medidor": out_scoring.get("medidor"),
            "_codigo_instalacao_fonte": out_scoring.get("_codigo_instalacao_fonte"),
        }
    # Fallback: lógica regex antiga (não deve cair aqui em caso normal)
    out = {"codigo_instalacao": None, "codigo_instalacao_antigo": None, "medidor": None,
           "_codigo_instalacao_fonte": None}

    # UC NOVA ANEEL: padrão X.XXX.XXX.XXX-XX após classificação RURAL/COMERCIAL/etc.
    m = re.search(
        r"(?:RURAL|URBANA|COMERCIAL|RESIDENCIAL|INDUSTRIAL|AGROPECU[AÁ]RIA|RIBEIRINHO|PODER\s+P[UÚ]BLICO)\s+(\d\.\d{3}\.\d{3}\.\d{3}-\d{2})",
        texto, re.I
    )
    if m:
        out["codigo_instalacao"] = m.group(1)
        out["_codigo_instalacao_fonte"] = "aneel_novo"
    else:
        # Fallback: qualquer ocorrência do formato (menos confiável)
        m = re.search(r"\b(\d\.\d{3}\.\d{3}\.\d{3}-\d{2})\b", texto)
        if m:
            out["codigo_instalacao"] = m.group(1)
            out["_codigo_instalacao_fonte"] = "aneel_novo"

    # Medidor: prefixos W/D/N/E + 10 dígitos (ex: W9012463502, D7086414011, N5242008749)
    # OU dígitos puros com 11 chars (ex: 00002167569)
    m = re.search(r"\bMedidor\s*:?\s*([WDNEwdne]\d{8,12})\b", texto, re.I)
    if not m:
        m = re.search(r"\b([WDNE]\d{10})\b", texto)
    if not m:
        # Padrão dígitos puros (Energisa MT pré-ANEEL alguns medidores)
        m = re.search(r"\bMedidor\s*:?\s*(\d{11})\b", texto, re.I)
    if not m:
        # Padrão Energisa MT pré-2025: medidor 11 dígitos APENAS antes de "Energia ativa em kWh"
        # Ex: '00001671455 Energia ativa em kWh Ponta 113684 114510 1 826'
        m = re.search(r"\b(\d{11})\s+Energia\s+ativa\s+em\s+kWh\b", texto, re.I)
    if m: out["medidor"] = m.group(1)

    # Padrões alternativos pra UC NOVA por label explícito
    if not out["codigo_instalacao"]:
        for pat in (
            r"N[úu]mero\s+da\s+UC\s*:?\s*(\d{8,12})",
            r"(?:N[ºo°]|Nro|Numero)\s+UC\s*:?\s*(\d{8,12})",
            r"\bUnidade\s+Consumidora\s*:?\s*(\d{8,12})",
        ):
            m = re.search(pat, texto, re.I)
            if m:
                out["codigo_instalacao"] = m.group(1)
                out["_codigo_instalacao_fonte"] = "label_explicito"
                break

    # FALLBACK pré-ANEEL: se ainda sem codigo_instalacao MAS texto indica fatura
    # anterior a 01/04/2026 (rótulo "seu número de identificação será atualizado"
    # OU data emissão antes de 04/2026), usa medidor como codigo_instalacao
    if not out["codigo_instalacao"]:
        eh_pre_aneel = bool(
            re.search(r"n[uú]mero de identifica[çc][ãa]o ser[áa] atualizado", texto, re.I)
            or re.search(r"DATA\s+DE?\s+EMISS[ÃA]O\s*:?\s*\d{2}/\d{2}/(?:201\d|2020|2021|2022|2023|2024|2025|2026[0-3])", texto, re.I)
        )
        if eh_pre_aneel and out["medidor"]:
            out["codigo_instalacao"] = out["medidor"]
            out["_codigo_instalacao_fonte"] = "medidor_pre_aneel"

    return out


# ────────────────────────────────────────────────────────────────────────
# Dedupe de letras duplicadas (artefato de PDF com sobreposição/bold)
# ────────────────────────────────────────────────────────────────────────
def dedupe_letras_duplicadas(s: str) -> str:
    """Se a string tem TODAS as letras duplicadas (GGUUEERRIINNOO → GUERINO), dedupa.

    Heurística: ≥80% das letras alfabéticas vêm em pares consecutivos iguais.
    Preserva strings normais (GGF AGRO LTDA não tem padrão duplicado).
    """
    if not s or len(s) < 4: return s
    letras = [c for c in s if c.isalpha()]
    if len(letras) < 4: return s
    pares = sum(1 for i in range(0, len(letras) - 1, 2)
                if letras[i].upper() == letras[i + 1].upper())
    razao = pares / max(1, len(letras) // 2)
    if razao < 0.8: return s
    # Dedupa pares consecutivos (preserva espaços/pontuação)
    out = []
    i = 0
    while i < len(s):
        if i + 1 < len(s) and s[i].isalpha() and s[i + 1].isalpha() and s[i].upper() == s[i + 1].upper():
            out.append(s[i]); i += 2
        else:
            out.append(s[i]); i += 1
    return "".join(out)


# ────────────────────────────────────────────────────────────────────────
# Classificação: modalidade tarifária + subgrupo + classe + ligação
# ────────────────────────────────────────────────────────────────────────
def extrair_classificacao(texto: str) -> dict:
    """Extrai a linha 'Classificação:' do DANF3E.

    Exemplo Energisa MT:
      'Classificação: MTV-MOD.TARIFÁRIA VERDE / A3A RURAL / AGROPECUÁRIA RURAL LIGAÇÃO:TRIFASICO'

    Retorna: modalidade_tarifaria, subgrupo, classe_consumo, ligacao_tipo.
    """
    out = {}
    # Captura a linha inteira (pode quebrar em 2 linhas no PDF)
    m = re.search(r"Classifica[çc][ãa]o\s*:\s*([^\n]+(?:\n[^\n]+)?)", texto, re.I)
    if m:
        linha = m.group(1).replace("\n", " ").strip()
        out["classificacao_raw"] = linha
    else:
        # CEMIG layout tabular: 'Classe Subclasse Modalidade Tarifária Datas de Leitura\n
        #                       Comercial Comercial Convencional B3 Anterior Atual Nº de dias Próxima'
        # OU: 'Comercial Comercial TUSD Livre A4 Verde Anterior...' (Modalidade pode ser 'TUSD Livre' 2 palavras)
        m = re.search(
            r"Classe\s+Subclasse\s+Modalidade\s+Tarifária[^\n]*\n"
            r"([A-Za-zÀ-ÿ]+)\s+([A-Za-zÀ-ÿ]+)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s]{2,20}?)\s+(A[1-4][Aa]?|AS|B[1-4])(?:\s+(Verde|Azul|Branca|Convencional))?",
            texto, re.I
        )
        if m:
            classe = m.group(1)
            subclasse = m.group(2)
            modalidade = m.group(3)
            subgrupo = m.group(4)
            out["classificacao_raw"] = f"{classe} / {subclasse} / {modalidade} / {subgrupo}"
            out["modalidade_tarifaria"] = modalidade.title()
            out["subgrupo"] = subgrupo.upper()
            out["classe_consumo"] = classe.upper()
            return out
        # Enel Rio DANF3E moderno (sub-layout): 'A4 HORO VERDE LIVRE Comercial TRIFÁSICO LEITURA'
        # Diferente do Ampla (que era 'B3 OUTROS-CONV. Comercial')
        m = re.search(
            r"\b(A[1-4][Aa]?|AS|B[1-4])\s+(HORO|HOROS?A?ZONAL|CONVENCIONAL)\s+(VERDE|AZUL|BRANCA)\s+(LIVRE|CATIVO|CATIV[A-Z]+)?\s*([A-Za-zÀ-ÿ]+)\s+(TRIF[ÁA]SICO|BIF[ÁA]SICO|MONOF[ÁA]SICO)",
            texto, re.I
        )
        if m:
            subgrupo = m.group(1).upper()
            mod_curta = m.group(2).upper()
            modalidade_cor = m.group(3).title()
            mercado = (m.group(4) or "").upper()  # LIVRE / CATIVO
            classe = m.group(5).strip().title()
            ligacao = m.group(6).upper().replace("Á", "A")
            out["classificacao_raw"] = f"{subgrupo} {mod_curta} {modalidade_cor.upper()}{' ' + mercado if mercado else ''} {classe} {ligacao}"
            out["subgrupo"] = subgrupo
            out["modalidade_tarifaria"] = modalidade_cor
            out["classe_consumo"] = classe.upper()
            out["ligacao_tipo"] = ligacao
            if mercado in ("LIVRE", "CATIVO"):
                out["mercado"] = mercado.title()
            return out

        # Neoenergia BA/PE/Cosern (embaralhado char-a-char): 'COMERCIAL - A4 Livre - Verde Trifásico'
        # OU CELPE: 'B3 COMERCIAL -COMERCIAL Conv. Monômia - Trifásico'
        # OU CELESC: 'COMERCIAL - COMERCIAL - B3 Outros demais classes - TRIFÁSICO'
        # Estratégia: ancorar em palavras-chave que aparecem intactas (A4/B3, Verde/Conv., Trifásico)
        # 1) Pattern Coelba: A4 Livre - Verde ou A4...Verde (chars embaralhados entre)
        # Plumber Coelba: 'M A4 E R L C iv I r A e L - Verde TIPO DE FORNECIMENTO: Trifásico'
        # Estratégia: A4 + qualquer chars até "- Verde" + TIPO DE FORNECIMENTO + Trifásico
        m = re.search(
            r"(A[1-4][Aa]?|AS|B[1-4])\s*(?:[A-Za-z\s]{0,30}?)[-]?\s*(Verde|Azul|Branca|Convencional)\s+TIPO\s+DE\s+FORNECIMENTO\s*:\s*(Trif[áa]sico|Bif[áa]sico|Monof[áa]sico)",
            texto, re.I
        )
        if m:
            subgrupo = m.group(1).upper()
            modalidade = m.group(2).title()
            ligacao = m.group(3).upper().replace("Á", "A").upper()
            out["subgrupo"] = subgrupo
            out["modalidade_tarifaria"] = modalidade
            out["ligacao_tipo"] = ligacao
            # Detecta classe próxima
            for c in ("COMERCIAL", "RESIDENCIAL", "INDUSTRIAL", "RURAL"):
                if c in texto.upper():
                    out["classe_consumo"] = c; break
            out["classificacao_raw"] = f"{subgrupo} Livre - {modalidade} {ligacao}"
            return out

        m = re.search(r"(A[1-4][Aa]?|AS|B[1-4])\s+(Livre|Cativo|LIVRE|CATIVO)\s*-\s*(Verde|Azul|Branca|Convencional)", texto, re.I)
        if m:
            subgrupo = m.group(1).upper()
            mercado = m.group(2).title()
            modalidade = m.group(3).title()
            # Tenta detectar classe próxima
            classe = None
            for c in ("COMERCIAL", "RESIDENCIAL", "INDUSTRIAL", "RURAL", "SERVIÇO P"):
                if c in texto.upper():
                    classe = c; break
            # Tenta tipo fornecimento
            ligacao = None
            m_lig = re.search(r"(TRIF[ÁA]SICO|BIF[ÁA]SICO|MONOF[ÁA]SICO)", texto, re.I)
            if m_lig: ligacao = m_lig.group(1).upper().replace("Á", "A")
            out["subgrupo"] = subgrupo
            out["modalidade_tarifaria"] = modalidade
            if classe: out["classe_consumo"] = classe
            if ligacao: out["ligacao_tipo"] = ligacao
            out["mercado"] = mercado
            out["classificacao_raw"] = f"{subgrupo} {mercado} {modalidade}{' ' + classe if classe else ''}{' ' + ligacao if ligacao else ''}"
            return out

        # CELPE: 'B3 COMERCIAL - COMERCIAL Conv. Monômia - Trifásico'
        m = re.search(
            r"(A[1-4][Aa]?|AS|B[1-4])\s+COMERCIAL\s*-\s*COMERCIAL\s+(Conv\.?\s*Mon[oô]mia|Conv\.?\s*Bin[oô]mia|Convencional)\s*-?\s*(TRIF[ÁA]SICO|BIF[ÁA]SICO|MONOF[ÁA]SICO)",
            texto, re.I
        )
        if m:
            subgrupo = m.group(1).upper()
            modalidade = m.group(2).strip().title()
            ligacao = m.group(3).upper().replace("Á", "A")
            out["subgrupo"] = subgrupo
            out["modalidade_tarifaria"] = modalidade
            out["classe_consumo"] = "COMERCIAL"
            out["ligacao_tipo"] = ligacao
            out["classificacao_raw"] = f"{subgrupo} COMERCIAL {modalidade} {ligacao}"
            return out

        # Equatorial GO: 'A A4 COMERCIAL OU SERVIÇOS E OUTRAS ATIVIDADES - COMERCIAL NORMAL THS_VERDE'
        m = re.search(
            r"\b([AB])\s+(A[1-4][Aa]?|AS|B[1-4])\s+(COMERCIAL|RESIDENCIAL|INDUSTRIAL|RURAL|PODER\s+P[UÚ]BLICO)[^\n]*?-\s*\3\s+NORMAL\s+THS[_\s]+(VERDE|AZUL|BRANCA)",
            texto, re.I
        )
        if m:
            grupo = m.group(1).upper()
            subgrupo = m.group(2).upper()
            classe = m.group(3).upper()
            cor = m.group(4).title()
            out["grupo"] = grupo
            out["subgrupo"] = subgrupo
            out["modalidade_tarifaria"] = f"THS {cor}"
            out["classe_consumo"] = classe
            out["classificacao_raw"] = f"{subgrupo} {classe} THS {cor}"
            return out

        # Light DANF3E: 'Grupo A4 / A4 - Verde / Comercial / Comercial' (cabeçalho 1ª linha)
        m = re.search(
            r"Grupo\s+(A[1-4][Aa]?|AS|B[1-4])\s*/\s*\1\s*-\s*"
            r"(Verde|Azul|Branca|Convencional)\s*/\s*"
            r"([A-Za-zÀ-ÿ]+)\s*/\s*\3",
            texto, re.I
        )
        if m:
            subgrupo = m.group(1).upper()
            modalidade = m.group(2).title()
            classe = m.group(3).strip().title()
            out["classificacao_raw"] = f"Grupo {subgrupo} / {modalidade} / {classe}"
            out["subgrupo"] = subgrupo
            out["modalidade_tarifaria"] = modalidade
            out["classe_consumo"] = classe.upper()
            return out

        # Enel SP DANF3E: 'B - B3 - CONVENCIONAL - Comercial - Comercial Trifásico DD/MM/AAAA'
        # Grupo - Subgrupo - Modalidade - Subclasse - Subclasse Ligação
        m = re.search(
            r"\b([AB])\s*-\s*(A[1-4][Aa]?|AS|B[1-4])\s*-\s*"
            r"(CONVENCIONAL|HOROS?A?ZONAL|VERDE|AZUL|BRANCA)\s*-\s*"
            r"([A-Za-zÀ-ÿ ]+?)\s*-\s*"
            r"\4\s+(TRIF[ÁA]SICO|BIF[ÁA]SICO|MONOF[ÁA]SICO)",
            texto, re.I
        )
        if m:
            grupo = m.group(1).upper()
            subgrupo = m.group(2).upper()
            modalidade = m.group(3).title()
            classe = m.group(4).strip().title()
            ligacao = m.group(5).upper().replace("Á", "A")
            if modalidade.upper() == "CONVENCIONAL": modalidade = "Convencional"
            out["classificacao_raw"] = f"{grupo} - {subgrupo} - {modalidade.upper()} - {classe} - {ligacao}"
            out["grupo"] = grupo
            out["subgrupo"] = subgrupo
            out["modalidade_tarifaria"] = modalidade
            out["classe_consumo"] = classe.upper()
            out["ligacao_tipo"] = ligacao
            return out

        # Enel DANF3E moderno: cabeçalho 'CLASSIFICACAO DA UNIDADE CONSUMIDORA' + linha
        # com colunas adjacentes embaralhadas char-a-char no plumber.
        # Ex plumber: 'C B o 3 m O e U rc T ia R l OS-CONV. Comercial TRIFASICO LEITURA'
        # Ex markdown: '        B 3  O U T R OS-CONV. Comercial TRIFASICO LEITURA'
        # Estratégia: ancorar em 'OS-CONV. <classe>' (sempre intacto), buscar B[1-4] antes.
        m_classe = re.search(
            r"OS\s*[-‐]?\s*CONV\.?\s+(Comercial|Residencial|Industrial|Rural|Servi[çc]o\s+P[uú]blico|Poder\s+P[uú]blico|Ilumina[çc][ãa]o\s+P[uú]blica)\s+(TRIF[ÁA]SICO|BIF[ÁA]SICO|MONOF[ÁA]SICO)",
            texto, re.I
        )
        if m_classe:
            subclasse = m_classe.group(1).strip().title()
            ligacao = m_classe.group(2).upper().replace("Á", "A")
            # Procura B[1-4] nos 150 chars anteriores (intercalado com chars da col esquerda)
            # Layout plumber: 'C B o 3 m O e U rc T ia R l OS-CONV.' — B e 3 não são adjacentes
            inicio = max(0, m_classe.start() - 150)
            trecho_antes = texto[inicio:m_classe.start()]
            m_sub = re.search(r"\bB\s+([1-4])\b", trecho_antes)
            if not m_sub:
                m_sub = re.search(r"\bB\s+[a-z]?\s+([1-4])\b", trecho_antes, re.I)
            if not m_sub:
                m_sub = re.search(r"\bB[\s\w]{0,4}?([1-4])\b", trecho_antes, re.I)
            subgrupo_num = m_sub.group(1) if m_sub else None
            out["classificacao_raw"] = f"{'B' + subgrupo_num + ' ' if subgrupo_num else ''}OUTROS-CONV. {subclasse}"
            if subgrupo_num: out["subgrupo"] = f"B{subgrupo_num}"
            out["modalidade_tarifaria"] = "Convencional"
            out["classe_consumo"] = subclasse.upper()
            out["ligacao_tipo"] = ligacao
            return out
        # Enel DANF3E Grupo A: 'A4 HOROSAZONAL VERDE Comercial' (sem OUTROS-CONV)
        m = re.search(
            r"\b(A[1-4][Aa]?)\s+(HOROS?A?ZONAL|HORO|CONVENCIONAL)\s+(VERDE|AZUL|BRANCA)\s+(Comercial|Residencial|Industrial|Rural|Servi[çc]o\s+P[uú]blico|Poder\s+P[uú]blico)",
            texto, re.I
        )
        if m:
            out["subgrupo"] = m.group(1).upper()
            out["modalidade_tarifaria"] = m.group(3).title()
            out["classe_consumo"] = m.group(4).upper()
            out["classificacao_raw"] = f"{m.group(1)} {m.group(2)} {m.group(3)} {m.group(4)}"
            return out
        return out
    # Continua processando linha do "Classificação:" (formato Energisa MT)

    # Modalidade tarifária: MTV/MTA/MTB/Verde/Azul/Branca/Convencional
    mod = re.search(
        r"\b(MTV|MTA|MTB|VERDE|AZUL|BRANCA|CONVENCIONAL)\b[-\s]*(?:MOD\.?\s*TARIF[AÁ]RIA\s+(\w+))?",
        linha, re.I
    )
    if mod:
        # Prefere nome legível (segundo grupo se MTV/MTA/MTB)
        nome = (mod.group(2) or mod.group(1)).strip().title()
        if nome.upper() == "VERDE": nome = "Verde"
        elif nome.upper() == "AZUL": nome = "Azul"
        elif nome.upper() == "BRANCA": nome = "Branca"
        elif nome.upper() == "CONVENCIONAL": nome = "Convencional"
        out["modalidade_tarifaria"] = nome

    # Subgrupo: A1, A2, A3, A3A, A4, AS, B1, B2, B3, B4
    sg = re.search(r"\b(A[12-4]A?|AS|B[1-4])\b", linha)
    if sg: out["subgrupo"] = sg.group(1).upper()

    # Classe de consumo: RURAL, COMERCIAL, RESIDENCIAL, INDUSTRIAL, AGROPECUÁRIA, etc.
    classes = re.findall(
        r"\b(RURAL|URBANA|COMERCIAL|RESIDENCIAL|INDUSTRIAL|AGROPECU[AÁ]RIA|RIBEIRINHO|PODER\s+P[UÚ]BLICO|ILUM\.?\s*P[UÚ]BLICA|SERVI[ÇC]O\s+P[UÚ]BLICO)\b",
        linha, re.I
    )
    if classes:
        # Dedup preservando ordem
        seen = set(); ordenadas = []
        for c in classes:
            cn = c.upper()
            if cn not in seen:
                seen.add(cn); ordenadas.append(cn)
        out["classe_consumo"] = " / ".join(ordenadas)

    # Tipo de ligação: MONOFASICO, BIFASICO, TRIFASICO
    lig = re.search(r"LIGA[ÇC][ÃA]O\s*:?\s*(MONOF[AÁ]SICO|BIF[AÁ]SICO|TRIF[AÁ]SICO)", linha, re.I)
    if lig:
        t = lig.group(1).upper()
        t = t.replace("Á", "A")
        out["ligacao_tipo"] = t

    return out


# ────────────────────────────────────────────────────────────────────────
# Hidratação razão social via BOLETO (cascata.tabelas_drawings)
# ────────────────────────────────────────────────────────────────────────
def extrair_razao_do_boleto(cascata: dict) -> dict:
    """Lê PAGADOR no boleto (tabela detectada por drawings). Retorna {razao_social, cnpj_cliente, endereco_uc}."""
    out = {}
    if not cascata or not isinstance(cascata, dict): return out
    tabs = cascata.get("tabelas_drawings") or []
    for t in tabs:
        for linha in (t.get("conteudo") or []):
            for celula in linha:
                if not isinstance(celula, list): continue
                for txt in celula:
                    if not txt or not isinstance(txt, str): continue
                    # Procura padrão: 'PAGADOR CPF/CNPJ\nNOME RAZAO 99.999.999/9999-99'
                    m = re.search(
                        r"PAGADOR\s+(?:CPF/CNPJ\s*)?\n?\s*([A-ZÀ-Ÿ][A-ZÀ-Ÿ0-9 \-&.]+?)\s+(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2})",
                        txt, re.I | re.S
                    )
                    if m:
                        out["razao_social"] = m.group(1).strip()
                        doc = m.group(2)
                        if "/" in doc:
                            out["cnpj_cliente"] = doc
                        else:
                            out["cpf_cliente"] = doc
                    # Endereço do PAGADOR (linha seguinte ao boleto)
                    m = re.search(
                        r"PAGADOR[^\n]*\n[^\n]+\n([A-Z][^\n]+(?:KM|SN|RUA|EST|ROD|FAZ|AV)[^\n]+)",
                        txt, re.I
                    )
                    if m and not out.get("endereco_uc"):
                        out["endereco_uc"] = m.group(1).strip()
    return out


# ────────────────────────────────────────────────────────────────────────
# Heurística: marcar histórico como "dias" quando valores 25-35
# ────────────────────────────────────────────────────────────────────────
def marcar_historico_dias(hist: list) -> list:
    """Detecta quando histórico só tem DIAS (valores 25-35) em vez de kWh.

    Padrão Energisa MT B Conv simples: cada linha só tem o nº de dias do ciclo,
    não o consumo histórico. Marca todos os itens com `_provavel_dias_nao_kwh: True`
    e remove o campo `consumo_ponta_kwh` (que estava errado).
    """
    if not hist: return hist
    valores = []
    for h in hist:
        v = h.get("consumo_ponta_kwh") or h.get("consumo_kwh")
        if v is not None: valores.append(v)
    if not valores: return hist
    # Se TODOS os valores estão entre 25 e 35 (range típico de dias do mês), é dias
    if all(25 <= v <= 35 for v in valores):
        for h in hist:
            v = h.get("consumo_ponta_kwh") or h.get("consumo_kwh")
            h["_provavel_dias_nao_kwh"] = True
            h["dias_ciclo"] = int(v) if v is not None else None
            # Limpa campos errados
            h["consumo_ponta_kwh"] = None
            h["consumo_kwh"] = None
            h["_obs"] = "Esta fatura não imprime consumo histórico — só DIAS do ciclo"
    return hist


# ────────────────────────────────────────────────────────────────────────
# Histórico Energisa MT via bbox X-band (recupera meses com layout parcial)
# ────────────────────────────────────────────────────────────────────────
def extrair_historico_energisa_bbox(pdf_path: str) -> list:
    """Lê histórico 13m do Energisa MT por coluna X (PyMuPDF bbox).

    Colunas calibradas (Energisa MT B Conv/Conv Hor):
        X≈195-200 → consumo_ponta_kwh
        X≈235-238 → demanda_ponta_kw
        X≈285-291 → consumo_fponta_kwh
        X≈327-331 → demanda_fponta_kw

    Quando a coluna não tem valor em determinado mês, marca
    `_demanda_nao_impressa=True` em vez de retornar None — a fatura
    Energisa MT omite demanda em meses zerados ou no mês mais antigo.
    """
    try:
        import fitz
    except ImportError:
        return []
    try:
        doc = fitz.open(pdf_path)
    except Exception:
        return []

    MESES = {"JAN":1,"FEV":2,"MAR":3,"ABR":4,"MAI":5,"JUN":6,
             "JUL":7,"AGO":8,"SET":9,"OUT":10,"NOV":11,"DEZ":12}
    # Colunas-âncora (centro). Tolerância ±8pt
    COLS = {
        "consumo_ponta_kwh":  197,
        "demanda_ponta_kw":   237,
        "consumo_fponta_kwh": 288,
        "demanda_fponta_kw":  330,
    }
    TOL = 9

    def _num(s: str) -> Optional[float]:
        s = (s or "").replace(".", "").replace(",", ".")
        try: return float(s)
        except: return None

    historico = []
    for p in doc:
        words = p.get_text("words")
        # 1) Acha âncoras de mês (formato MES/AA)
        anchors = []
        for w in words:
            x0, y0, x1, y1, txt = w[:5]
            m = re.match(r"^([A-Z]{3})/(\d{2})$", txt.strip(), re.I)
            if m and m.group(1).upper() in MESES:
                anchors.append((y0, x0, x1, m.group(1).upper(), int(m.group(2))))
        if not anchors:
            continue
        anchors.sort()

        # 2) Pra cada âncora, coleta valores numéricos na mesma Y-band, em colunas X conhecidas
        for y_mes, x_mes_s, x_mes_e, mes_lbl, ano_2d in anchors:
            ano = 2000 + ano_2d
            valores = {k: None for k in COLS}
            impressa = {k: False for k in COLS}
            for w in words:
                wx0, wy0, wx1, wy1, wtxt = w[:5]
                if abs(wy0 - y_mes) > 3: continue
                if wx0 <= x_mes_e + 2: continue
                # Aceita formato BR: 1.234,56 ou 0,00
                if not re.match(r"^[\d.]+,\d{2}$", wtxt): continue
                # Encaixa em uma das colunas-alvo
                for k, cx in COLS.items():
                    if abs(wx0 - cx) <= TOL:
                        if valores[k] is None:
                            valores[k] = _num(wtxt)
                            impressa[k] = True
                        break

            item = {
                "mes": mes_lbl,
                "ano": ano,
                "consumo_ponta_kwh":  valores["consumo_ponta_kwh"],
                "demanda_ponta_kw":   valores["demanda_ponta_kw"],
                "consumo_fponta_kwh": valores["consumo_fponta_kwh"],
                "demanda_fponta_kw":  valores["demanda_fponta_kw"],
            }
            # Marca campos não impressos pela distribuidora (evita confusão com erro de parse)
            nao_imp = [k for k, v in impressa.items() if not v]
            if nao_imp:
                item["_campos_nao_impressos"] = nao_imp
            historico.append(item)

    # Dedup mantendo primeira ocorrência (Y mais alta na página)
    vistos = set()
    final = []
    for h in historico:
        chave = (h["mes"], h["ano"])
        if chave in vistos: continue
        vistos.add(chave)
        final.append(h)
    return final[:13]


# ────────────────────────────────────────────────────────────────────────
# Extração POSICIONAL de itens via PyMuPDF bbox (X-band fixo Energisa MT)
# ────────────────────────────────────────────────────────────────────────
def extrair_itens_fatura_bbox(pdf_path: str) -> list:
    """Lê tabela 'Itens da Fatura' Energisa MT por colunas X (PyMuPDF bbox).

    Colunas calibradas em fatura 61B Tapurah (Grupo A Verde):
        X≈27  → descrição (faixa)
        X≈154 → unidade (KWH/KW/UN)
        X≈190 → quantidade
        X≈220 → tarifa com tributos
        X≈260 → valor R$
        X≈296 → PIS/COFINS
        X≈330 → base ICMS
        X≈356 → alíq ICMS%
        X≈378 → ICMS R$
        X≈411 → tarifa ANEEL
    """
    try:
        import fitz
    except ImportError:
        return []
    try:
        doc = fitz.open(pdf_path)
    except Exception:
        return []

    COLS = {
        "quantidade":    (185, 18),   # X centro, tolerância
        "tarifa_unit":   (220, 12),
        "valor":         (260, 15),
        "pis_cofins":    (296, 15),
        "icms_base":     (330, 15),
        "icms_aliq":     (356, 8),
        "icms_valor":    (378, 15),
        "tarifa_aneel":  (411, 10),
    }

    def _num(s):
        s = (s or "").replace(".", "").replace(",", ".")
        try: return float(s)
        except: return None

    itens = []
    for p in doc:
        words = p.get_text("words")
        # Acha Y do header e do TOTAL
        y_header = y_total = None
        for w in words:
            x0, y0, x1, y1, txt = w[:5]
            if txt.strip() == "Itens" and y_header is None and x0 < 50:
                y_header = y0
            if txt.strip() == "TOTAL:" and y_header and y0 > y_header and y_total is None:
                y_total = y0
        if not y_header:
            continue
        if not y_total:
            y_total = y_header + 250  # fallback

        # Coleta palavras no bloco e agrupa por Y-band (3pt)
        by_y = {}
        for w in words:
            x0, y0, x1, y1, txt = w[:5]
            if y0 < y_header + 5 or y0 > y_total - 2: continue
            y_key = round(y0 / 3) * 3
            by_y.setdefault(y_key, []).append((x0, txt))

        for y_key in sorted(by_y.keys()):
            line = sorted(by_y[y_key])
            # Filtra linhas tributárias (PIS/COFINS/ICMS na lateral direita)
            txts = [t for x, t in line if x < 154]
            if not txts: continue
            primeiro = txts[0].upper()
            if primeiro in ("PIS", "COFINS", "ICMS"): continue
            # Descarta linhas que NÃO começam com letra (ex: número solto)
            if not re.match(r"^[A-Za-zÀ-ÿ]", txts[0]): continue
            # Constrói descrição
            desc = " ".join(txts).strip()
            if len(desc) < 5: continue
            # Procura unidade
            unidade = None
            for x, t in line:
                if 145 <= x <= 165 and t.upper() in ("KWH", "KW", "UN", "UNI"):
                    unidade = t.upper(); break

            # Mapeia colunas numéricas
            valores = {}
            for x, t in line:
                if not re.match(r"^-?[\d.]+,\d+$|^\d{1,2}$|^\d{1,2},\d+$", t): continue
                for col, (cx, tol) in COLS.items():
                    if abs(x - cx) <= tol:
                        if col not in valores:
                            valores[col] = t
                        break
            if not valores.get("valor"):
                continue  # sem valor → não é item

            item = {
                "descricao": desc,
                "unidade": unidade,
                "quantidade_string": valores.get("quantidade"),
                "quantidade_numerica": _num(valores.get("quantidade")),
                "tarifa_unit_string": valores.get("tarifa_unit"),
                "tarifa_unit_numerica": _num(valores.get("tarifa_unit")),
                "valor_brl_string": valores.get("valor"),
                "valor_brl_numerico": _num(valores.get("valor")),
                "pis_cofins_brl_string": valores.get("pis_cofins"),
                "pis_cofins_brl_numerico": _num(valores.get("pis_cofins")),
                "icms_base_string": valores.get("icms_base"),
                "icms_base_numerico": _num(valores.get("icms_base")),
                "icms_aliquota_pct": valores.get("icms_aliq"),
                "icms_valor_string": valores.get("icms_valor"),
                "icms_valor_numerico": _num(valores.get("icms_valor")),
                "tarifa_unit_aneel_string": valores.get("tarifa_aneel"),
                "tarifa_unit_aneel_numerica": _num(valores.get("tarifa_aneel")),
                "_fonte_bbox": True,
                "eh_credito_gd": bool(re.search(r"GDI|INJETAD|COMPENS|SCEE", desc.upper())),
            }
            itens.append(item)
    return itens


# ────────────────────────────────────────────────────────────────────────
# Cruzamento Regex ↔ Cascata BBox (resgata valores quando soma diverge)
# ────────────────────────────────────────────────────────────────────────
def _cruzar_itens_bbox(out_v2: dict, pdf_path: str) -> None:
    """Quando soma_itens diverge do total, completa itens via bbox PyMuPDF.

    Estratégia:
    1. Compara soma(regex_itens) vs total da fatura.
    2. Se divergência > 1% do total, roda extração bbox no bloco "Itens da Fatura".
    3. Adiciona itens do bbox que não estão no regex (matching por descrição+valor).
    4. Marca itens novos com `_fonte_bbox=True`.
    """
    if not pdf_path: return
    itens = out_v2.get("itens_fatura") or []
    total_str = (out_v2.get("vencimento_valor") or {}).get("valor_total")
    if not total_str: return
    try:
        total_n = float(str(total_str).replace(".", "").replace(",", "."))
    except Exception:
        return
    if total_n <= 0: return  # zerada — não cruzar

    soma_regex = sum(it.get("valor_brl_numerico") or 0 for it in itens)
    diff = abs(soma_regex - total_n)
    if diff <= 0.50: return  # já bate
    # Só roda bbox quando divergência ≥ 1% do total
    if diff < total_n * 0.01: return

    bbox_itens = extrair_itens_fatura_bbox(pdf_path)
    if not bbox_itens: return

    # Normalização robusta — remove hífens, espaços múltiplos e pontuação leve
    def _norm(s):
        s = re.sub(r"[\s\-]+", " ", (s or "").strip().upper())
        return re.sub(r"\s+", " ", s).strip()
    # Indexa descrições NORMALIZADAS (sem valor — descrição já basta pra matching)
    descs_regex = {_norm(it.get("descricao")) for it in itens}
    # Também indexa valores BRL (com tolerância R$ 0,02)
    vals_regex = {round(it.get("valor_brl_numerico") or 0, 2) for it in itens}

    # Sandbox: tenta adicionar todos os candidatos e medir impacto
    candidatos = []
    for bi in bbox_itens:
        desc_norm = _norm(bi.get("descricao"))
        val = bi.get("valor_brl_numerico") or 0
        if abs(val) < 0.01: continue
        if len(bi.get("descricao") or "") < 5: continue
        # Pula se descrição OU valor já estão no regex (qualquer match basta — evita duplicação)
        if desc_norm in descs_regex: continue
        if round(val, 2) in vals_regex: continue
        candidatos.append(bi)

    if not candidatos: return

    # Só aceita conjunto se reduzir a divergência total
    soma_com_candidatos = soma_regex + sum(c.get("valor_brl_numerico") or 0 for c in candidatos)
    diff_novo = abs(soma_com_candidatos - total_n)
    if diff_novo >= diff:
        # Não melhorou — descarta tudo
        out_v2["_cruzamento_bbox_descartado"] = {
            "candidatos": len(candidatos),
            "diff_atual": round(diff, 2),
            "diff_se_aplicado": round(diff_novo, 2),
            "razao": "bbox aumentaria divergência",
        }
        return

    # Aplica candidatos
    adicionados = []
    for c in candidatos:
        itens.append(c)
        adicionados.append(c["descricao"])

    out_v2["_cruzamento_bbox"] = {
        "adicionados": len(adicionados),
        "itens": adicionados[:5],
        "soma_antes": round(soma_regex, 2),
        "soma_depois": round(sum(it.get("valor_brl_numerico") or 0 for it in itens), 2),
        "total_fatura": round(total_n, 2),
        "diff_antes": round(diff, 2),
        "diff_depois": round(diff_novo, 2),
    }


def extrair_icms_light_soma(texto: str):
    """ICMS total Light GD: soma o ICMS por linha de item, embutido como
    '<base,2dec> <alíq,3dec> <icms,2dec>' (ex.: '5100,46 24,000 1224,11'). O ICMS
    não tem rótulo nem linha-total nesse layout; está distribuído nos itens reais
    ('Energia Elétrica' + 'Energia Fornecida GD') — as linhas 'Injetada' (negativas)
    não têm o triplo. Dedup por (base,icms) porque o texto_combo repete a mesma linha
    em plumber/markdown/ocr. NÃO fabrica: soma só valores lidos do próprio texto.
    Validado no gold 95415: 30,44 + 1.224,11 = 1.254,55."""
    if not texto:
        return None
    pat = re.compile(r"([\d.]+,\d{2})\s+(\d{1,2},\d{3})\s+(-?[\d.]+,\d{2})")
    seen = set(); total = 0.0; n = 0
    for ln in texto.split("\n"):
        if not re.search(r"kWh|kW", ln):
            continue
        for mt in pat.finditer(ln):
            base, icms = mt.group(1), mt.group(3)
            key = (base, icms)
            if key in seen:
                continue
            val = float(icms.replace(".", "").replace(",", "."))
            if val <= 0:
                continue
            seen.add(key); total += val; n += 1
    if n == 0:
        return None
    total = round(total, 2)
    br = f"{total:,.2f}".replace(",", "@").replace(".", ",").replace("@", ".")
    return {"valor_string": br, "_fonte": "soma_itens_icms_light", "_n_linhas": n}


def extrair_saldo_creditos_scee(texto: str):
    """SCEE: linha 'Unidade consumidora no sistema de compensação (kWh):
    Energia injetada - 0/Saldo de Créditos: 83250,61' (Light e outras GD).
    O saldo de créditos acumulado (kWh) já está no plumber — só não era capturado.
    Retorna {'saldo_credito_energia': float, 'energia_injetada_scee_kwh': float}."""
    if not texto:
        return None
    out = {}
    # linha completa (injetada + saldo) — âncora no '/Saldo' pra não pegar itens 'Energia Injetada GD'
    m = re.search(r"Energia\s+injetada\s*-\s*([\d.]+,\d{2}|\d+)\s*/\s*"
                  r"Saldo\s+de\s+Cr[eé]ditos?\s*:?\s*([\d.]+,\d{2}|\d+)", texto, re.I)
    if m:
        try: out["energia_injetada_scee_kwh"] = float(m.group(1).replace(".", "").replace(",", "."))
        except Exception: pass
        try: out["saldo_credito_energia"] = float(m.group(2).replace(".", "").replace(",", "."))
        except Exception: pass
        return out or None
    # fallback: só o saldo
    ms = re.search(r"Saldo\s+de\s+Cr[eé]ditos?\s*:?\s*([\d.]+,\d{2}|\d+)", texto, re.I)
    if ms:
        try:
            out["saldo_credito_energia"] = float(ms.group(1).replace(".", "").replace(",", "."))
        except Exception:
            pass
    return out or None


def extrair_cemig_a4_verde_icms(texto: str):
    """CEMIG NF3e A4 Verde — ICMS total = SOMA do ICMS por item (valor após cada '18,00' na
    tabela Valores Faturados). Texto MUITO garbado (OCR duplica tokens → de-dup; Reservado ao
    Fisco e PASEP ilegíveis). O ICMS por item soma EXATO — validado 3/3: 234170=4.601,00,
    234100=1.118,36, 245108=630,68. Retorna só o ICMS (PIS/COFINS dessa layout = coordenadas)."""
    if not texto:
        return None
    idx = texto.find("Reservado ao Fisco")
    itens = texto[:idx] if idx > 0 else texto
    ded = []
    for t in itens.split():
        if not ded or ded[-1] != t:
            ded.append(t)
    s = " ".join(ded)
    tot = 0.0
    achou = False
    for v in re.findall(r"\b18,00\s+(-?[\d.]+,\d{2})", s):
        try:
            tot += float(v.replace(".", "").replace(",", ".")); achou = True
        except Exception:
            pass
    if not achou or tot <= 0:
        return None
    return f"{round(tot,2):,.2f}".replace(",", "@").replace(".", ",").replace("@", ".")


def extrair_ampla_modelo6(texto: str):
    """Ampla/Enel RJ — NF Modelo 6 (layout ANTIGO, não-NF3e). Tributos vêm char-a-char no bbox
    (e com espaço antes do % no plumber). De-espaça tudo e captura '<TRIB><base><aliq>%<valor>'.
    Gold 107418: ICMS 662,32/31%/205,31, PIS 662,32/0,66%/4,37, COFINS 662,32/3,04%/20,13, total 138,56."""
    if not texto:
        return None
    des = re.sub(r"\s+", "", texto)  # remove TODOS os espaços (bbox char-a-char)
    out = {}
    for m in re.finditer(r"(PIS/PASEP|PIS|COFINS|ICMS)([\d.]+,\d{2})(\d{1,2},\d{2})%([\d.]+,\d{2})", des):
        k = "pis" if m.group(1).startswith("PIS") else ("cofins" if m.group(1) == "COFINS" else "icms")
        out.setdefault(k, {"base_string": m.group(2), "aliquota_pct": m.group(3),
                           "valor_string": m.group(4), "_fonte": "ampla_modelo6"})
    mt = re.search(r"\d{2}/\d{2}/\d{4}R\$?([\d.]+,\d{2})", des)
    if mt:
        out["valor_total"] = mt.group(1)
    return out or None


def extrair_light_a4_tusd(texto: str):
    """Light RJ A4 TUSD Livre — tributos em tabela vertical:
      ICMS '<base> <aliq>% <valor>' (aliq INTEIRO, ex.: '14.160,33 22% 3.115,24');
      PIS/COFINS '<aliq,3dec>% <valor>' SEM base/rótulo (PIS aliq<2%, COFINS aliq>=2%;
      ex.: '0,460% 83,11', '2,160% 390,40').
    2 totais mascarados ('*****14.160,33' NF, '*****15.181,78' a pagar) → pega o maior.
    Gold 107416: ICMS 3.115,24 / PIS 83,11 / COFINS 390,40 / total 15.181,78."""
    if not texto:
        return None
    out = {}
    mi = re.search(r"([\d.]+,\d{2})\s+(\d{1,2})%\s+([\d.]+,\d{2})", texto)
    if mi:
        out["icms"] = {"base_string": mi.group(1), "aliquota_pct": mi.group(2),
                       "valor_string": mi.group(3), "_fonte": "light_a4_tusd"}
    for aliq, valor in re.findall(r"\b(\d,\d{3})%\s+([\d.]+,\d{2})", texto):
        k = "pis" if float(aliq.replace(",", ".")) < 2 else "cofins"
        out.setdefault(k, {"aliquota_pct": aliq, "valor_string": valor, "_fonte": "light_a4_tusd"})
    tots = re.findall(r"\*{4,}([\d.]+,\d{2})", texto)
    if tots:
        out["valor_total"] = max(tots, key=lambda s: float(s.replace(".", "").replace(",", ".")))
    return out or None


def extrair_cosern_tributos(texto: str):
    """Cosern/CERN (Neoenergia RN): tributos numa linha POSICIONAL sem rótulo por tributo —
    os rótulos 'ICMS PIS COFINS' ficam numa linha de cabeçalho separada, e os 9 números vêm
    juntos sob 'INFORMAÇÕES DE TRIBUTOS'. Formato:
      <icms_base> <icms_aliq> <icms_valor> <pis_base> <pis_aliq> <pis_valor> <cof_base> <cof_aliq> <cof_valor>
    Ex: '7.528,93 18,00 1.355,20 6.173,72 0,90 55,56 6.173,72 4,13 254,97'. Gold 108508."""
    if not texto:
        return None
    up = texto.upper()
    idx = up.find("INFORMA")
    while idx != -1 and "TRIBUTO" not in up[idx:idx + 30]:
        idx = up.find("INFORMA", idx + 1)
    regiao = texto[idx:idx + 900] if idx != -1 else texto
    pat = re.compile(
        r"([\d.]+,\d{2})\s+(\d{1,2},\d{2})\s+([\d.]+,\d{2})\s+"
        r"([\d.]+,\d{2})\s+(\d{1,2},\d{2})\s+([\d.]+,\d{2})\s+"
        r"([\d.]+,\d{2})\s+(\d{1,2},\d{2})\s+([\d.]+,\d{2})")
    m = pat.search(regiao)
    if not m:
        return None
    g = m.groups()
    return {
        "icms":   {"base_string": g[0], "aliquota_pct": g[1], "valor_string": g[2], "_fonte": "cosern_posicional"},
        "pis":    {"base_string": g[3], "aliquota_pct": g[4], "valor_string": g[5], "_fonte": "cosern_posicional"},
        "cofins": {"base_string": g[6], "aliquota_pct": g[7], "valor_string": g[8], "_fonte": "cosern_posicional"},
    }


def extrair_celesc_tributos(texto: str):
    """Celesc (Centrais Elétricas de Santa Catarina, SC): tributos em linhas
    '<TRIB> R$ <base> <aliq>%R$ <valor>' no bloco 'DISTRIBUICAO ENC. SETORIAIS
    ENERGIA TRANSMISSAO TRIBUTOS Soma Demonstr.'. O '%' às vezes vem triplicado
    ('%%%') e colado no 'R$' do valor. Pega a 1ª ocorrência de cada tributo (= linha
    de total do demonstrativo). Nenhum mapa cobre esse layout. Validado vs coluna gold
    16/17 (94%); cobre ~59% das Celesc. Ex 155233: ICMS 444,03 / PIS 21,03 / COFINS 97,34."""
    if not texto:
        return None
    pat = re.compile(
        r"(ICMS|COFINS|PIS/PASEP|PASEP|PIS)\s*R\$\s*([\d.]+,\d{2})\s+([\d.,]+)%+\s*R\$\s*([\d.]+,\d{2})",
        re.I)
    o = {}
    for mt, base, aliq, val in pat.findall(texto):
        mt = mt.upper()
        k = "icms" if mt == "ICMS" else ("cofins" if mt == "COFINS" else "pis")
        o.setdefault(k, {"base_string": base, "aliquota_pct": aliq, "valor_string": val, "_fonte": "celesc_rs_pct"})
    # Formato 2 — A4 Verde "SÉRIE ÚNICA" (layout 2020-2021): tributos numa linha
    # POSICIONAL no bloco RESERVADO AO FISCO, sem rótulo por tributo (os rótulos
    # 'ICMS PIS COFINS' ficam num cabeçalho separado). 4 marcadores R$:
    #   'R$ <base_icms> <aliq>% R$ <icms> R$ <pis> R$ <cofins>'. Vem do texto_bbox
    # (no plumber só aparece o cabeçalho). Validado 19/19 no lote tail; gold 78794:
    # base 14.650,48 / 25% / ICMS 3.662,59 / PIS 41,02 / COFINS 188,99.
    if not (o.get("icms") and o.get("pis") and o.get("cofins")):
        m2 = re.search(
            r"R\$\s*([\d.]+,\d{2})\s+(\d{1,2},\d{2})\s*%\s*R\$\s*([\d.]+,\d{2})"
            r"\s+R\$\s*([\d.]+,\d{2})\s+R\$\s*([\d.]+,\d{2})", texto)
        if m2:
            o.setdefault("icms",   {"base_string": m2.group(1), "aliquota_pct": m2.group(2),
                                    "valor_string": m2.group(3), "_fonte": "celesc_a4verde_pos"})
            o.setdefault("pis",    {"valor_string": m2.group(4), "_fonte": "celesc_a4verde_pos"})
            o.setdefault("cofins", {"valor_string": m2.group(5), "_fonte": "celesc_a4verde_pos"})
    return o or None


def extrair_enel_ce_tributos(texto: str):
    """Enel CE (Cia Energética do Ceará) Grupo A ACL. 2 formatos (gold P10):
    ANTIGO (rótulo por tributo): '(COFINS|ICMS|PIS/PASEP) <base> <aliq> <valor>'
      (ex. 20569256: ICMS 5.122,51 / PIS 66,71 / COFINS 303,96).
    NF3e: linha 'TOTAL <pis_cofins_combo> <base_icms> <valor_icms>'
      (ex. 20568024: combo 658,32 / base 23.923,62 / ICMS 6.459,34) — PIS/COFINS vêm
      COMBINADOS (como Copel) → vão pro tributos_agregados_itens p/ split posterior.
    Retorna (tributos_dict, combo_pis_cofins_string|None)."""
    if not texto:
        return None, None
    o = {}
    for mt, base, aliq, val in re.findall(
            r"(COFINS|ICMS|PIS/PASEP)\s+([\d.]+,\d{2})\s+([\d.]+,\d{2,4})\s+([\d.]+,\d{2})", texto):
        k = "icms" if mt == "ICMS" else ("cofins" if mt == "COFINS" else "pis")
        o.setdefault(k, {"base_string": base, "aliquota_pct": aliq, "valor_string": val, "_fonte": "enel_ce_label"})
    combo = None
    if not (o.get("pis") and o.get("cofins")):
        mt = re.search(r"\bTOTAL\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})", texto)
        if mt:
            o.setdefault("icms", {"base_string": mt.group(2), "valor_string": mt.group(3), "_fonte": "enel_ce_nf3e_total"})
            combo = mt.group(1)  # PIS+COFINS combinado da linha TOTAL do NF3e
    return (o or None), combo


_CE_NUM = r"-?\d{1,3}(?:\.\d{3})*,\d{2}-?"
_CE_D3 = r"\d{1,3}(?:\.\d{3})*,\d{3}"
_CE_D5 = r"\d+,\d{5}"
_CE_DESCS = ["Energia Atv Forn F Ponta TUSD", "Energia Atv Forn F Ponta TE",
    "Energia Atv Forn Ponta TUSD", "Energia Atv Forn Ponta TE", "Consumo Reativo Excedente Fp",
    "Consumo Reativo Excedente Np", "Adicional Band. Vermelha", "Demanda Ativa sem ICMS",
    "Demanda Ultrapassagem", "Demanda Ativa", "CIP - ILUM PUB PREF MUNICIPAL",
    "CIP ILUM PUB PREF MUNICIPAL", "Liminar Isen ICMS Dif Demanda", "Juros Moratórios", "Multa"]
_CE_ALT = "|".join(re.escape(d) for d in sorted(_CE_DESCS, key=len, reverse=True))
_RE_CE_COMP = re.compile(rf"^(?P<d>{_CE_ALT})\s+(?P<q>{_CE_D3})\s+(?P<ts>{_CE_D5})\s+(?P<pu>{_CE_D5})\s+(?P<v>{_CE_NUM})(?:\s+.*)?$", re.I)
_RE_CE_TV = re.compile(rf"^(?P<d>Adicional Band\. Vermelha)\s+(?P<ts>{_CE_D5})\s+(?P<v>{_CE_NUM})(?:\s+.*)?$", re.I)
_RE_CE_VAL = re.compile(rf"^(?P<d>CIP[\w\.\- ]+MUNICIPAL|Liminar Isen ICMS Dif Demanda|Juros Morat[óo]rios|Multa|Demanda Ativa sem ICMS)\s+(?P<v>{_CE_NUM})(?:\s+.*)?$", re.I)
_RE_CE_SUB = re.compile(rf"Subtotal\((?P<g>[AB])\)\s+(?P<v>{_CE_NUM})", re.I)


def _ce_br(v):
    if v is None:
        return None
    s = str(v).strip(); neg = s.endswith("-") or s.startswith("-")
    s = s.strip("-").replace(".", "").replace(",", ".")
    try:
        f = float(s)
    except Exception:
        return None
    return -f if neg else f


def extrair_enel_ce_grupo_a(texto: str):
    """Enel CE Grupo A ACLML legado (A4 Horosazonal Verde / mercado livre). Itens em linha:
    'Energia Atv Forn (F )?Ponta (TE|TUSD) <qtd> <tarifa> <preco> <valor> [TRAIL]', + Demanda
    Ativa/Ultrapassagem, Consumo Reativo, Adicional Band. (tarifa+valor), CIP/Liminar (só valor,
    '-' final = negativo). TOTAL = Subtotal(A)+Subtotal(B) (faturamento+outros) — âncora robusta
    mesmo quando algum item escapa do texto (que sai com sobra/garbled). Validado: Σitens==total
    em 4/6 e Subtotal A+B==total em 6/6 (golds 47051720211101=40609,22, 42579720211101=25788,51...).
    Retorna {itens, soma, total, subtotais}."""
    if not texto:
        return None
    itens = []
    for ln in texto.splitlines():
        ln = re.sub(r"\s+", " ", ln).strip()
        u = ln.upper()
        cand = None
        for d in sorted(_CE_DESCS, key=len, reverse=True):
            i = u.find(d.upper())
            if i >= 0:
                cand = ln[i:].strip(); break
        if not cand:
            continue
        for rx in (_RE_CE_COMP, _RE_CE_TV, _RE_CE_VAL):
            m = rx.match(cand)
            if m:
                itens.append({"descricao": m.group("d"), "valor_brl_numerico": _ce_br(m.group("v")),
                              "_extrator": "enel_ce_grupo_a"})
                break
    # dedup (descricao,valor) — texto_combo = plumber+markdown duplica os itens exatamente;
    # itens legítimos distintos têm valores diferentes, então dedup exato é seguro.
    _seen, _uniq = set(), []
    for it in itens:
        ch = (it["descricao"], it["valor_brl_numerico"])
        if ch not in _seen:
            _seen.add(ch); _uniq.append(it)
    itens = _uniq
    soma = round(sum(it["valor_brl_numerico"] or 0 for it in itens), 2)
    subs = {g: _ce_br(v) for g, v in _RE_CE_SUB.findall(texto)}
    total = round(sum(x for x in subs.values() if x), 2) if subs else None
    return {"itens": itens, "soma": soma, "total": total, "subtotais": subs}


_CE_MESES = ("JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ")
_CE_RE_MES = re.compile(r"^(?:" + "|".join(_CE_MESES) + r")\d{2}$", re.I)


def _ce_md_num(s):
    """Número da coluna do markdown ('971.00', '11755.00', '12.016,00')."""
    s = (s or "").strip()
    if re.fullmatch(r"\d+(?:\.\d+)?", s):
        return float(s)
    return _ce_br(s)


def _enel_ce_historico(src):
    """Histórico 13m do Enel CE — markdown é COLUNAR: bloco MÊS/ANO, depois CONSUMO,
    depois DIAS, alinhados por ordem. Reconstrói por índice (plumber intercala char-a-char
    e perde meses; o markdown traz os 13 limpos)."""
    if not src:
        return None
    lines = [l.strip() for l in src.splitlines()]
    try:
        i0 = next(i for i, l in enumerate(lines) if re.match(r"M[ÊE]S\s*/\s*ANO", l, re.I))
    except StopIteration:
        return None
    meses = []
    for l in lines[i0 + 1:]:
        if _CE_RE_MES.match(l):
            meses.append(l.upper())
        elif meses:
            break
    if not meses:
        return None
    # bloco de consumos (após 'CONSUMO', pulando 'FATURADO (kWh)')
    consumos = []
    ic = next((i for i, l in enumerate(lines) if i > i0 and re.match(r"CONSUMO", l, re.I)), None)
    if ic is not None:
        for l in lines[ic + 1:]:
            if re.fullmatch(r"\d+\.\d{2}", l) or re.fullmatch(r"\d{1,3}(?:\.\d{3})+,\d{2}", l):
                consumos.append(_ce_md_num(l))
            elif (not l) or re.match(r"(FATURADO|\(kWh\)|FATUR)", l, re.I):
                continue
            elif consumos:
                break
    # bloco de dias (após 'DIAS')
    dias = []
    idd = next((i for i, l in enumerate(lines) if i > i0 and re.fullmatch(r"DIAS", l, re.I)), None)
    if idd is not None:
        for l in lines[idd + 1:]:
            if re.fullmatch(r"\d{1,3}", l):
                dias.append(int(l))
            elif (not l):
                continue
            elif dias:
                break
    hist = []
    for idx, mtok in enumerate(meses):
        hist.append({"ano": 2000 + int(mtok[3:5]), "mes": mtok[:3], "_fonte": "enel_ce_md",
                     "dias_ciclo": dias[idx] if idx < len(dias) else None,
                     "consumo_kwh": consumos[idx] if idx < len(consumos) else None,
                     "demanda_ponta_kw": None, "consumo_ponta_kwh": None,
                     "demanda_fponta_kw": None, "consumo_fponta_kwh": None})
    return hist or None


def enriquecer_enel_ce_cadastral(texto: str, texto_md: str = None):
    """Especialista CADASTRAL Enel CE/Coelce (todas as famílias B e A). Preenche os campos
    que o pipeline genérico deixa vazios/errados neste layout:
      • classificação: subgrupo (B3/A4...), modalidade (Convencional/Branca/Verde/Azul), classe;
      • instalação (≠ código do cliente) e código do cliente (débito automático);
      • mês de referência (o genérico pega o mês do PERÍODO de leitura, 1 mês defasado);
      • endereço da UC; CIP/COSIP; leituras single-register (registro único do Grupo B);
      • histórico 13m (colunar via markdown).
    Não inventa: só retorna o que ancorou no texto. Validado no gold 47941120230201."""
    if not texto:
        return None
    t = texto
    md = texto_md or ""
    out = {}
    # ── Classificação: 'B3 OUTROS-CONV. - Comercial TRIFÁSICO ...' / 'A4 HOROSAZONAL VERDE - ...'
    m = re.search(r"\b([AB]\d)\s+([^\n]{2,45}?)\s+(?:MONO|BI|TRI)\s*F[IÍÁA]", t)
    if m:
        out["subgrupo"] = m.group(1).upper()
        meio = m.group(2).strip()
        up = meio.upper()
        if "AZUL" in up:
            out["modalidade"] = "Azul"
        elif "VERDE" in up:
            out["modalidade"] = "Verde"
        elif "BRANCA" in up:
            out["modalidade"] = "Branca"
        elif "CONV" in up:
            out["modalidade"] = "Convencional"
        if " - " in meio:
            out["classe"] = meio.rsplit(" - ", 1)[-1].strip().title()
    if not out.get("classe"):
        mc = re.search(r"\b(Residencial|Comercial|Industrial|Rural|Poder P[úu]blico|"
                       r"Ilumina[çc][ãa]o P[úu]blica|Servi[çc]o P[úu]blico)\b", t, re.I)
        if mc:
            out["classe"] = mc.group(1).title()
    # ── Instalação (junto da chave de acesso) × código do cliente (débito automático)
    mi = re.search(r"CEP:\s*\d{5}-?\d{3}\s+(\d{6,10})\s+Consulte", t)
    if mi:
        out["instalacao"] = mi.group(1)
    mcli = re.search(r"utilizando\s+o\s+c[óo]digo\s+(\d{6,10})", t, re.I)
    if mcli:
        out["cliente"] = mcli.group(1)
    # ── Mês de referência (boleto 'Referência:' ou linha 'MM/AAAA DD/MM/AAAA R$ <total>')
    mr = re.search(r"Refer[êe]ncia:\s*\n?\s*(\d{2}/\d{4})", md) or \
         re.search(r"Refer[êe]ncia:\s*\n?\s*(\d{2}/\d{4})", t) or \
         re.search(r"\b(\d{2}/\d{4})\s+\d{2}/\d{2}/\d{4}\s+R\$", t)
    if mr:
        out["mes_ref"] = mr.group(1)
    # ── Endereço da UC (depois do cabeçalho da NF; antes vem o endereço da distribuidora)
    _anc = re.search(r"DOCUMENTO\s+AUXILIAR\s+DA\s+NOTA\s+FISCAL", t, re.I)
    _reg = t[_anc.end():] if _anc else t
    for _m in re.finditer(r"(?im)^((?:AV|AVENIDA|RUA|R|TRAV|TRAVESSA|ROD|RODOVIA|AL|ALAMEDA|"
                          r"PRA[ÇC]A|EST|ESTRADA)[\.\s][^\n]{3,55})$", _reg):
        cand = re.sub(r"\s+", " ", _m.group(1)).strip()
        if "PADRE VALDEVINO" in cand.upper():   # endereço da Coelce (Fortaleza) — pular
            continue
        out["endereco"] = cand
        break
    # ── CIP/COSIP
    mp = re.search(r"CIP[\w\.\-/ ]*?MUNICIPAL\s+(\d{1,3}(?:\.\d{3})*,\d{2})", t)
    if mp:
        out["cip"] = _ce_br(mp.group(1))
    # ── Leituras single-register (markdown colunar)
    src = md or t
    ma = re.search(r"Leitura\s*\n?\s*Anterior\s*\n?\s*(\d[\d.]*)", src)
    mb = re.search(r"Leitura\s*\n?\s*Atual\s*\n?\s*(\d[\d.]*)", src)
    if ma:
        out["leit_ant"] = _ce_md_num(ma.group(1))
    if mb:
        out["leit_atu"] = _ce_md_num(mb.group(1))
    # ── Histórico 13m
    hist = _enel_ce_historico(md or t)
    if hist:
        out["historico"] = hist
    return out or None


def extrair_neoenergia_elektro(texto: str):
    """Neoenergia Elektro (SP, CNPJ 02.328.280/0001) layout 'Seu Código / Detalhamento da
    Conta' (cci 0601/0899/0807) — DISTINTO do extrair_elektro_danf3e (DANF3E antigo, família
    Eq.GO). 2 subtipos: B convencional GD (tem 'Histórico de Consumo (kWh)' horizontal) e A4
    Horária Verde (sem histórico). Cobre o gap de ICMS (82% nulo) + histórico nessa família.

    Padrões (validados 8/8 nos golds do user 4_3396_68 ... 4_3099_68):
      • COFINS/PIS: '0899 <TRIB> <base> <aliq>% <valor>'  (ex. '0899 COFINS 321,55 3,65% 11,74')
      • ICMS: 2º de 3 números da linha 'Total' → 'Total <fornecimento> <icms> <valor_total>'
        (ex. 'Total 307,26 413,41 742,08' → ICMS 413,41 / total 742,08)
      • Histórico (subtipo B): linha de 13 consumos seguida da linha de 13 'MMM/AA' (após '*CCI').
    Retorna {tributos:{icms,pis,cofins}|None, valor_total:str|None, historico:list}."""
    if not texto:
        return None
    o = {}
    mc = re.search(r"0899\s+COFINS\s+([\d.]+,\d{2})\s+(\d{1,2},\d{2})\s*%\s+([\d.]+,\d{2})", texto)
    if mc:
        o["cofins"] = {"base_string": mc.group(1), "aliquota_pct": mc.group(2),
                       "valor_string": mc.group(3), "_fonte": "neo_elektro"}
    mp = re.search(r"0899\s+PIS\s+([\d.]+,\d{2})\s+(\d{1,2},\d{2})\s*%\s+([\d.]+,\d{2})", texto)
    if mp:
        o["pis"] = {"base_string": mp.group(1), "aliquota_pct": mp.group(2),
                    "valor_string": mp.group(3), "_fonte": "neo_elektro"}
    total = None
    mt = re.search(r"\bTotal\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\b", texto)
    if mt:
        o["icms"] = {"valor_string": mt.group(2), "_fonte": "neo_elektro_total"}
        total = mt.group(3)
    hist = []
    mh = re.search(r"((?:[\d.]+\s+){12}[\d.]+)\s+((?:[A-ZÇ]{3}/\d{2}\s+){12}[A-ZÇ]{3}/\d{2})", texto)
    if mh:
        cons, mes = mh.group(1).split(), mh.group(2).split()
        if len(cons) == 13 and len(mes) == 13:
            for ma, cc in zip(mes, cons):
                try:
                    mm, aa = ma.split("/")
                    hist.append({"mes": mm.upper(), "ano": 2000 + int(aa),
                                 "consumo_kwh": float(cc.replace(".", "")), "_fonte": "neo_elektro_hist"})
                except Exception:
                    pass
    return {"tributos": (o or None), "valor_total": total, "historico": hist}


# ── Amazonas Energia / Âmbar Energia (AM) — CNPJ único 02.341.467/0001-20 (3 brandings:
#    'AMAZONAS ENERGIA S.A.' boleto, 'AMAZONAS ENERGIA' e 'ÂMBAR ENERGIA - AM' compacto).
#    Manaus/ZFM: ICMS recolhido por ST (Lei 217/2021) + PIS/COFINS isentos → tributos não
#    destacados. 'Adicional Bandeira' é informativa (já no Valor a Pagar) — não soma 2x.
_AMZ_ITEM_QTD = re.compile(
    r"\b(Consumo(?:\s+F?[/\.]?\s?Ponta|\s+Ponta|\s+Interm)?|Demanda(?:\s+F?[/\.]?\s?Ponta|\s+Ponta)?|"
    r"Dem\s+Ultr(?:\s+F?[/\.]?\s?Ponta|\s+Ponta)?|Dem\s+R\s+Exc(?:\s+F?[/\.]?\s?Ponta|\s+Ponta)?|"
    r"En\s+R\s+Exc(?:\s+F?[/\.]?\s?Ponta|\s+Ponta)?|En\s+Reat\s+Exc)"
    r"\s+([\d.]+)\s+(kWh|kW)\s+a\s+[\d.]+,\d+\s+[\d.]+,\d+\s+(-?[\d.]+,\d{1,2})", re.I)
# SVC NÃO ancorado em início de linha: no boleto de 2 colunas o pdfplumber prepende o texto
# da coluna esquerda ('Datas da Leitura', 'Leitura Anterior ...') na mesma linha do item.
# NÃO inclui 'Desconto' — 'Percentual De Desconto Para Demanda - 50,00' é % (não soma).
_AMZ_ITEM_SVC = re.compile(
    r"(Corre[çc][ãa]o\s+Monet[áa]ria[^\n]*?|Multa\s+Por\s+Atraso[^\n]*?|Juros\s+De\s+Mora[^\n]*?|"
    r"Pagamento\s+(?:Em\s+Duplicidade|Diferen[çc]a)[^\n]*?|Ressarc[^\n]*?Dic[^\n]*?)\s+(-?\s?[\d.]+,\d{1,2})", re.I)
_AMZ_BAND = re.compile(
    r"^[ \t]*(Adicional\s+Bandeira[^\n]*?)\s+-?\s?([\d.]+,\d{2})[ \t]*$", re.I | re.M)


def _amz_desofuscar(texto: str):
    """Alguns PDFs Amazonas/Âmbar usam fonte subsetada com encoding DESLOCADO de +29 (0x1D):
    cada caractere sai como (original-29) e o espaço como \\u0003. No plumber isso vira
    '(cid:NN)' (ilegível); no bbox sai deslocado (ex.: '$0$=21$6'='AMAZONAS', '(1(5*,$'='ENERGIA').
    Decodifica somando 29 aos chars na faixa deslocada (0x03..0x61); preserva \\n e acentos.
    Retorna o texto decodificado, ou None se não houver a assinatura deslocada."""
    if not texto or ("$0$=21$6" not in texto and "(1(5*,$" not in texto):
        return None
    out = []
    for ch in texto:
        o = ord(ch)
        # \n e 0x20 são separadores ESTRUTURAIS do bbox (PyMuPDF) — NÃO deslocar. O espaço da
        # fonte vem como  (→ 0x20 ao somar 29). Sem isso, 0x20 vira '=' e quebra as linhas.
        if ch == "\n" or o == 0x20:
            out.append(ch)
        elif 0x03 <= o <= 0x61:
            out.append(chr(o + 29))
        else:
            out.append(ch)
    return "".join(out)


def _amz_brl(s):
    if s is None:
        return None
    s = s.replace(" ", "")
    neg = s.startswith("-") or s.endswith("-")
    s = s.strip("-")
    try:
        v = float(s.replace(".", "").replace(",", "."))
        return -v if neg else v
    except Exception:
        return None


def extrair_amazonas_energia(texto: str):
    """Amazonas Energia / Âmbar Energia (AM) — CNPJ 02.341.467/0001-20. Dois layouts:
      • boleto 'Documento Auxiliar' (Grupo B): tem GRUPO/histórico/PIS-COFINS; total 'Total a pagar R$'
      • compacto 'VIA PARA PAGAMENTO' (THS Azul A / Âmbar B): SEM classificação/histórico/PIS-COFINS;
        total 'Valor a Pagar ... R$' (o mapa só pegava 'Total a pagar' → total null → reprovado).
    Manaus/ZFM: ICMS por ST (Lei 217/2021) + PIS/COFINS isentos → tributos não destacados.
    Reconstrói os itens (que SOMAM o total → soma_itens fecha). Bandeira 'Adicional Bandeira' é
    informativa (não soma 2x): só entra se a soma COM ela bate o total e SEM ela não bate.
    Marca compact (layout sem classificação/histórico) e icms_st. Retorna
    {itens, soma, valor_total, compact, icms_st, pis, cofins, subgrupo} ou None."""
    if not texto:
        return None
    t = texto.replace("\xa0", " ")
    if not re.search(r"02\.?341\.?467/0001|AMAZONAS\s+ENERGIA|[ÂA]MBAR\s+ENERGIA", t, re.I):
        return None
    out = {"_dist": "amazonas"}
    out["compact"] = not bool(re.search(r"Detalhamento de Tributos|Hist[óo]rico de Medi[çc][ãa]o", t, re.I))
    out["icms_st"] = bool(re.search(r"recolhido por ST", t, re.I)
                          or re.search(r"Valor do ICMS[\s\S]{0,30}?\(\*\)", t, re.I))
    # total: boleto 'Total a pagar R$ X'; compacto 'Valor a Pagar ... R$ X'
    # ,\d{1,2}: no bbox deslocado o '0' decimal final às vezes some ('1.279,8' = 1.279,80)
    m = (re.search(r"Total a pagar\s+R\$\s*([\d.]+,\d{1,2})", t, re.I)
         or re.search(r"Valor a Pagar[\s\S]{0,80}?R\$\s*([\d.]+,\d{1,2})", t, re.I))
    total = m.group(1) if m else None
    out["valor_total"] = total
    totaln = _amz_brl(total) if total else None
    # região de itens: entre 'Itens Faturados/Financeiros' e o próximo bloco
    a = re.search(r"Itens\s+(?:Faturados|Financeiros)", t, re.I)
    reg = t
    if a:
        # fim = bloco de MEDIÇÃO ('Dados da Leitura' / 'Desc. da Grandeza'), que vem DEPOIS dos itens.
        # NÃO usar 'Datas da Leitura' (datas) — ela é intercalada NA MESMA linha de um item (COSIP).
        fim = re.search(r"Dados da Leitura|Desc(?:ri[çc][ãa]o)?\.?\s+da Grandeza|Base de C[áa]lculo|"
                        r"Total a pagar|Reservado ao Fisco|Hist[óo]rico de Medi|recorte aqui", t[a.end():], re.I)
        reg = t[a.end(): a.end() + (fim.start() if fim else 3000)]
    # SEM dedup: a região já está limitada a UM bloco de itens (1ª ocorrência no concat) →
    # itens repetidos legítimos (ex.: 2 linhas 'Demanda 90 kW ... 3.052,80') devem ser mantidos.
    itens, band = [], []

    def _add(dst, desc, val):
        if val is not None:
            dst.append({"descricao": re.sub(r"\s+", " ", desc).strip(),
                        "valor_brl_numerico": val, "_fonte": "esp_amazonas"})

    for mm in _AMZ_ITEM_QTD.finditer(reg):
        _add(itens, mm.group(1), _amz_brl(mm.group(4)))
    # COSIP vem grudada após 'Ligação Número do Medidor Faturamento Modalidade' no boleto →
    # não fica no início da linha. Ancora em '(COSIP' (ASCII, à prova dos acentos garbados do
    # texto deslocado, ex.: 'Contribuiomo de Iluminaomo P~blica (COSIP'); tolera 1-2 decimais.
    for mm in re.finditer(r"\(COSIP\)?\s+([\d.]+,\d{1,2})", reg, re.I):
        _add(itens, "Contribuição de Iluminação Pública (COSIP)", _amz_brl(mm.group(1)))
    # Religação — taxa avulsa (só valor): 'Religacao 38,08' ou 'Religacao Normal 46,37'
    for mm in re.finditer(r"\b(Religa[çc][ãa]o(?:\s+Normal)?)\s+([\d.]+,\d{2})", reg, re.I):
        _add(itens, mm.group(1), _amz_brl(mm.group(2)))
    for mm in _AMZ_ITEM_SVC.finditer(reg):
        _add(itens, mm.group(1), _amz_brl(mm.group(2)))
    for mm in _AMZ_BAND.finditer(reg):
        v = _amz_brl(mm.group(2))
        if v is not None:
            band.append({"descricao": re.sub(r"\s+", " ", mm.group(1)).strip(),
                         "valor_brl_numerico": v, "_fonte": "esp_amazonas_band"})
    soma_sem = round(sum(it["valor_brl_numerico"] or 0 for it in itens), 2)
    chosen = itens
    if totaln is not None and band:
        soma_com = round(soma_sem + sum(b["valor_brl_numerico"] or 0 for b in band), 2)
        tol = max(0.50, totaln * 0.005)
        if abs(soma_sem - totaln) > tol and abs(soma_com - totaln) <= tol:
            chosen = itens + band
    out["itens"] = chosen
    out["soma"] = round(sum(it["valor_brl_numerico"] or 0 for it in chosen), 2)
    # PIS/COFINS: boleto declara '0,0000 0,00' (isento); compacto não imprime
    out["pis"] = 0.0 if re.search(r"\bPIS\s+0,0000\s+0,00", t) else None
    out["cofins"] = 0.0 if re.search(r"\bCofins\s+0,0000\s+0,00", t, re.I) else None
    # Detalhamento de Tributos com ICMS REAL destacado (NF3e Grupo A não-ST):
    # 'ICMS <base> <aliq>,00 <valor>' (ex.: 'ICMS 4.454,50 20,00 890,90'). PIS/COFINS '<aliq> 0,00'.
    # Valida base×alíq/100 == valor → marca tributos_ok (validador dá PASS sem ICMS por-item).
    if not out["icms_st"]:
        mi = re.search(r"\bICMS\s+([\d.]+,\d{2})\s+(\d{1,2},\d{2})\s+([\d.]+,\d{2})", t)
        if mi:
            base, aliq, val = _amz_brl(mi.group(1)), _amz_brl(mi.group(2)), _amz_brl(mi.group(3))
            if base and aliq and val is not None and abs(base * aliq / 100 - val) <= max(0.50, val * 0.02):
                out["icms_real"] = {"base": mi.group(1), "aliq": mi.group(2), "valor": mi.group(3)}
                out["tributos_ok"] = True
                mp = re.search(r"\bPIS\s+[\d.,]+\s+([\d.]+,\d{2})", t)
                mcf = re.search(r"\bCofins\s+[\d.,]+\s+([\d.]+,\d{2})", t, re.I)
                if mp:
                    out["pis"] = _amz_brl(mp.group(1))
                if mcf:
                    out["cofins"] = _amz_brl(mcf.group(1))
    # subgrupo: explícito no boleto ('GRUPO B B3'), senão inferido (Demanda/Ponta → A4)
    msg = re.search(r"\bGRUPO\s+[AB]\s+(A[1-4]|B[1-4]|AS)\b", t)
    if msg:
        out["subgrupo"] = msg.group(1).upper()
    elif any(("DEMANDA" in (it["descricao"] or "").upper() or "PONTA" in (it["descricao"] or "").upper())
             for it in chosen):
        out["subgrupo"] = "A4"
    elif chosen:
        out["subgrupo"] = "B3"
    # classe: 'GRUPO B B3 COMERCIAL ...' (boleto). Compacto não imprime (classificacao SKIP)
    mcl = re.search(r"GRUPO\s+[AB]\s+(?:A[1-4]|B[1-4]|AS)\s+(COMERCIAL|RESIDENCIAL|INDUSTRIAL|RURAL)", t, re.I)
    if mcl:
        out["classe"] = mcl.group(1).title()

    # ── Cadastral: os dois layouts quebram regexes do mapa → razao/mes_ref/vencimento/instalação
    #    ausentes (obrigatorios FAIL). Recupera por âncoras estáveis de cada layout.
    # razao_social: compacto ('<RAZAO> Código Único Mês Faturado') OU boleto (linha após INSC.ESTADUAL)
    mrz = re.search(r"\n([A-ZÀ-Ÿ0-9][^\n]{2,}?)\s+C[óo]digo\s+[ÚU]nico\s+M[êe]s\s+Faturado", t)
    if not mrz:
        mrz = re.search(r"INSC\.?\s*ESTADUAL:\s*\d+\s*\n\s*"
                        r"([A-Z0-9][A-ZÀ-Ÿ0-9 ./&'\-]+?(?:S[/.]?\s?A\.?|LTDA\.?|EIRELI|EPP|\bME\b))", t)
    if mrz:
        out["razao_social"] = re.sub(r"\s+", " ", mrz.group(1)).strip()
    if out["compact"]:
        # header data line: '<end> <uc> <mes_ref> <nf> <data_emissao>' (mês ANTES da NF)
        mh = re.search(r"(\d{6,8}-\d)\s+(\d{2}/\d{4})\s+(\d{6,9})\s+\d{2}/\d{2}/\d{4}", t)
        if mh:
            out["codigo_instalacao"] = mh.group(1)
            out["mes_ref"] = mh.group(2)
        # vencimento: '(*) (*) (*) DD/MM/AAAA R$ <total>' OU rodapé '<uc> <mes> <fd> DD/MM/AAAA R$'
        mv = (re.search(r"\(\*\)\s+\(\*\)\s+\(\*\)\s+(\d{2}/\d{2}/\d{4})\s+R\$", t)
              or re.search(r"\d{6,8}-\d\s+\d{2}/\d{4}\s+\d+\s+(\d{2}/\d{2}/\d{4})\s+R\$", t))
        if mv:
            out["data_vencimento"] = mv.group(1)
        # leitura: 'Período de Consumo: DD/MM/AAAA a DD/MM/AAAA' (dias = diferença)
        ml = re.search(r"Per[íi]odo de Consumo:\s*(\d{2}/\d{2}/\d{4})\s+a\s+(\d{2}/\d{2}/\d{4})", t, re.I)
        if ml:
            out["leitura_anterior"] = ml.group(1)
            out["leitura_atual"] = ml.group(2)
            try:
                from datetime import datetime as _dt
                dd = (_dt.strptime(ml.group(2), "%d/%m/%Y") - _dt.strptime(ml.group(1), "%d/%m/%Y")).days
                if 20 <= dd <= 40:
                    out["dias"] = str(dd)
            except Exception:
                pass
    else:
        # boleto 'Documento Auxiliar': linha '<uc> <vencimento> <mes_ref>'. No texto deslocado o
        # dígito verificador da UC pode sumir ('2588146- 20/08/2025 08/2025') → dígito opcional.
        mh = re.search(r"(\d{6,8}-?\d?)\s+(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{4})\b", t)
        if mh:
            out["codigo_instalacao"] = mh.group(1)
            out["data_vencimento"] = mh.group(2)
            out["mes_ref"] = mh.group(3)
        # leitura: 3 datas após 'Leitura Anterior Leitura Atual Próxima' (pode intercalar item)
        ml = re.search(r"Leitura\s+Anterior[\s\S]{0,90}?(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})", t, re.I)
        if ml:
            out["leitura_anterior"] = ml.group(1)
            out["leitura_atual"] = ml.group(2)
            try:
                from datetime import datetime as _dt
                dd = (_dt.strptime(ml.group(2), "%d/%m/%Y") - _dt.strptime(ml.group(1), "%d/%m/%Y")).days
                if 20 <= dd <= 40:
                    out["dias"] = str(dd)
            except Exception:
                pass
    # modalidade (ambos os layouts) — fecha classificacao no boleto (subgrupo+classe já vêm do mapa)
    if re.search(r"HOROSAZONAL\s+VERDE|HOR[ÁA]RIA\s+VERDE|THS\s+VERDE", t, re.I):
        out["modalidade"] = "Verde"
    elif re.search(r"HOROSAZONAL\s+AZUL|HOR[ÁA]RIA\s+AZUL|THS\s+AZUL", t, re.I):
        out["modalidade"] = "Azul"
    elif re.search(r"\bCONVENCIONAL\b", t, re.I):
        out["modalidade"] = "Convencional"
    return out


_ENEL_NUM = r"-?\d{1,3}(?:\.\d{3})*,\d{2}"
_ENEL_QTD = r"-?\d{1,3}(?:\.\d{3})*,\d{3}"
_ENEL_TAR = r"-?\d+,\d{5}"
_ENEL_ALI = r"\d{1,2}(?:,\d{2})?%"
_RE_ENEL_TUSD = re.compile(rf"(0605)\s+(USO\s+SIST\.\s+DISTR\.\s+\(TUSD\))\s+({_ENEL_QTD})\s+({_ENEL_TAR})\s+({_ENEL_NUM})\s+({_ENEL_ALI})\s+({_ENEL_NUM})\s+({_ENEL_NUM})", re.I)
_RE_ENEL_TE   = re.compile(rf"(0601)\s+(ENERGIA\s+\(TE\))\s+({_ENEL_QTD})\s+({_ENEL_TAR})\s+({_ENEL_NUM})\s+({_ENEL_ALI})\s+({_ENEL_NUM})\s+({_ENEL_NUM})", re.I)
_RE_ENEL_BAND = re.compile(rf"(0698)\s+(ADIC(?:IONAL)?\.?\s+BANDEIRA\s+(?:TARIF[ÁA]RIA|AMARELA|VERMELHA))\s+({_ENEL_QTD})\s+({_ENEL_TAR})\s+({_ENEL_NUM})\s+({_ENEL_ALI})\s+({_ENEL_NUM})\s+({_ENEL_NUM})", re.I)
_RE_ENEL_PIS  = re.compile(rf"(0699)\s+(PIS/PASEP)\s*\(([\d,]+%)\)\s+({_ENEL_NUM})\s+({_ENEL_ALI})\s+({_ENEL_NUM})\s+({_ENEL_NUM})", re.I)
_RE_ENEL_COF  = re.compile(rf"(0699)\s+(COFINS)\s*\(([\d,]+%)\)\s+({_ENEL_NUM})\s+({_ENEL_ALI})\s+({_ENEL_NUM})\s+({_ENEL_NUM})", re.I)
_RE_ENEL_CIP  = re.compile(rf"(0807)\s+(CIP[\w\.\-\s]+?MUNICIPAL)\s+({_ENEL_NUM})", re.I)
_RE_ENEL_HIST = re.compile(
    rf"[A-ZÇ]{{3}}\s+\d{{4}}\s+\d{{2}}\s+[A-ZÇ]{{3}}\s+\d{{4}}\s+"
    rf"((?:\d{{1,6}}\s+){{12}}\d{{1,6}})\s+((?:\d{{1,2}}\s+){{12}}\d{{1,2}})", re.I)
_RE_ENEL_MESES = re.compile(r"((?:[a-zç]{3}/\d{2}\s+){12}[a-zç]{3}/\d{2})", re.I)


def _enel_br(v):
    if v is None:
        return None
    try:
        return float(v.replace("%", "").strip().replace(".", "").replace(",", "."))
    except Exception:
        return None


def extrair_enel_sp_b3(texto: str):
    """Enel SP (ex-Eletropaulo) B3 Convencional 'Conta de Energia' (CCI 0605/0601/0698/0699/0807).
    Itens em linha única: '<cci> <desc> [qtd tarifa] base aliq% icms_valor valor_total'.
      • TUSD(0605)/TE(0601)/Bandeira(0698): qtd+tarifa+base+aliq+icms+total
      • PIS/PASEP e COFINS(0699): base+aliq+icms+total (sem qtd/tarifa) — federal, mas no layout
        têm coluna ICMS; o valor do tributo é o valor_total da linha
      • CIP(0807): só valor_total
    ICMS total = Σ(valor_icms dos itens) — confere com o resumo fiscal. PIS/COFINS = valor_total
    da respectiva linha 0699. Histórico horizontal (consumos+dias após referência+data; meses
    'mmm/aa' em bloco anterior). Validado 20/20 (Σitens == total EXATO).
    Retorna {itens, soma, icms, pis, cofins, historico}."""
    if not texto:
        return None
    t = re.sub(r"[ \t]+", " ", texto.replace("\xa0", " "))
    itens, icms_sum, pis_v, cof_v = [], 0.0, None, None
    for rgx, tipo in [(_RE_ENEL_TUSD, "tusd"), (_RE_ENEL_TE, "te"), (_RE_ENEL_BAND, "bandeira")]:
        for m in rgx.finditer(t):
            g = m.groups()
            itens.append({"descricao": g[1].strip(), "valor_brl_numerico": _enel_br(g[7]), "_tipo": tipo})
            icms_sum += _enel_br(g[6]) or 0
    for m in _RE_ENEL_PIS.finditer(t):
        g = m.groups(); pis_v = _enel_br(g[6])
        itens.append({"descricao": "PIS/PASEP", "valor_brl_numerico": _enel_br(g[6]), "_tipo": "pis"})
        icms_sum += _enel_br(g[5]) or 0
    for m in _RE_ENEL_COF.finditer(t):
        g = m.groups(); cof_v = _enel_br(g[6])
        itens.append({"descricao": "COFINS", "valor_brl_numerico": _enel_br(g[6]), "_tipo": "cofins"})
        icms_sum += _enel_br(g[5]) or 0
    for m in _RE_ENEL_CIP.finditer(t):
        g = m.groups()
        itens.append({"descricao": g[1].strip(), "valor_brl_numerico": _enel_br(g[2]), "_tipo": "cip"})
    soma = round(sum(it["valor_brl_numerico"] or 0 for it in itens), 2)
    # histórico horizontal (best-effort): consumos+dias + meses
    hist = []
    mh = _RE_ENEL_HIST.search(t)
    mm = _RE_ENEL_MESES.search(t)
    if mh and mm:
        cons = mh.group(1).split(); dias = mh.group(2).split(); mes = mm.group(1).split()
        if len(cons) == 13 and len(mes) == 13:
            for i in range(13):
                try:
                    pm, pa = mes[i].split("/")
                    hist.append({"mes": pm.upper(), "ano": 2000 + int(pa),
                                 "consumo_kwh": float(cons[i]),
                                 "dias_ciclo": int(dias[i]) if i < len(dias) else None,
                                 "_fonte": "esp_enel_sp_hist"})
                except Exception:
                    pass
    return {"itens": itens, "soma": soma, "icms": round(icms_sum, 2),
            "pis": pis_v, "cofins": cof_v, "historico": hist}


_SP_MES = "JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ"
_SP_MES_NUM = {"JAN": 1, "FEV": 2, "MAR": 3, "ABR": 4, "MAI": 5, "JUN": 6,
               "JUL": 7, "AGO": 8, "SET": 9, "OUT": 10, "NOV": 11, "DEZ": 12}
_RE_SP_REF_INSC = re.compile(rf"INSC\.?\s*EST\.?:?\s*(?:ISENTO\s*)?((?:{_SP_MES})\s+\d{{4}})", re.I)
_RE_SP_REF_CONTA = re.compile(rf"CONTA\s+REFERENTE\s+A\s*((?:{_SP_MES})\s+\d{{4}})", re.I)


def _sp_ref_do_uid(uid):
    """uid Enel SP embute YYYYMMDD (ex.: 4903320211201 → ...20211201 → '12/2021')."""
    ms = re.findall(r"20\d{6}", str(uid or ""))
    if not ms:
        return None
    raw = ms[-1]
    mm = raw[4:6]
    return f"{int(mm)}/{raw[:4]}" if mm.isdigit() and 1 <= int(mm) <= 12 else None


def enriquecer_enel_sp_cadastral(texto_combo: str, uid=None):
    """Especialista CADASTRAL Enel SP/Eletropaulo (layouts BT_VERTICAL / VERTICAL / SEMREF).
    Foco no maior gap da dist: a REFERÊNCIA (milhares de faturas 2019-2022 vêm zero-date
    porque o genérico confunde com o mês do vencimento). Âncora estável: o mês de referência
    aparece logo após 'INSC. EST:' no layout vertical; fallback robusto pelo YYYYMMDD do uid
    (coerência texto×uid medida em 169/169). Também classe/modalidade/bandeira (fill).
    Retorna {mes_ref ('MM/YYYY'), ref_fonte, classe, modalidade, subgrupo, bandeira}.
    Validado: 298/300 referência recuperada na pilha zero-date."""
    if not texto_combo:
        return None
    t = texto_combo
    out = {}
    # ── Referência: CONTA REFERENTE A → INSC. EST: → fallback uid
    m = _RE_SP_REF_CONTA.search(t) or _RE_SP_REF_INSC.search(t)
    if m:
        tok = m.group(1).upper().split()
        out["mes_ref"] = f"{_SP_MES_NUM[tok[0]]}/{tok[1]}"
        out["ref_fonte"] = "texto"
    else:
        ru = _sp_ref_do_uid(uid)
        if ru:
            out["mes_ref"] = ru
            out["ref_fonte"] = "uid"
    # ── Valor total: no grid vertical o total vem logo após o VENCIMENTO
    #    ('DD MES AAAA | | 5.055,96'). Pega a 1ª money após uma data de vencimento.
    mt = re.search(rf"\d{{2}}\s+(?:{_SP_MES})\s+\d{{4}}\s*\|?\s*\|?\s*(\d{{1,3}}(?:\.\d{{3}})*,\d{{2}})", t, re.I)
    if mt:
        out["valor_total"] = mt.group(1)
    # ── Classe / modalidade / subgrupo (fill) — estáveis neste layout
    if re.search(r"COM[ÉE]RCIO,\s*SERV", t, re.I):
        out["classe"] = "Comercial"
    elif re.search(r"\bRESIDENCIAL\b", t, re.I):
        out["classe"] = "Residencial"
    if re.search(r"\bConvencional\b", t):
        out["modalidade"] = "Convencional"
    elif re.search(r"\bBranca\b", t):
        out["modalidade"] = "Branca"
    elif re.search(r"\bVerde\b", t) and re.search(r"\bA4\b", t):
        out["modalidade"] = "Verde"
    msub = re.search(r"\b(B[1-4]|A[1-4]|AS)\b", t)
    if msub:
        out["subgrupo"] = msub.group(1).upper()
    # ── Bandeira (preserva composta) — fill
    mb = re.search(r"(VERMELHA\s+PATAMAR\s+II\s+ESCASSEZ\s+H[ÍI]DRICA|ESCASSEZ\s+H[ÍI]DRICA\s+VERDE|"
                   r"VERMELHA\s+PATAMAR\s+II\s+AMARELA|VERMELHA\s+PATAMAR\s+II|VERMELHA\s+PATAMAR\s+I|"
                   r"ESCASSEZ\s+H[ÍI]DRICA|AMARELA|VERDE)", t, re.I)
    if mb:
        out["bandeira"] = re.sub(r"\s+", " ", mb.group(1).upper()).strip()
    return out or None


_ELK_MES_NOME = {"janeiro": 1, "fevereiro": 2, "março": 3, "marco": 3, "abril": 4, "maio": 5,
                 "junho": 6, "julho": 7, "agosto": 8, "setembro": 9, "outubro": 10,
                 "novembro": 11, "dezembro": 12}
_ELK_MESES_RE = "Janeiro|Fevereiro|Mar[çc]o|Abril|Maio|Junho|Julho|Agosto|Setembro|Outubro|Novembro|Dezembro"


def enriquecer_elektro_cadastral(texto_combo: str):
    """Especialista CADASTRAL Elektro/Neoenergia Elektro (Grupo A Horária Verde). Layouts:
    'Segunda Via' vertical (2020-2023) e grid (2024-2025). Preenche o que falta nas reprovadas:
    instalação (linha isolada / 1ª linha), CNPJ (cheio ou mascarado), classe/modalidade/subgrupo
    (COMERCIAL,SERVICOS / HORÁRIA VERDE / TRIFASICO → Comercial/Verde/A4), total e mês de ref
    (linha FAT-01). Marca _elektro_grupo_a (itens verticalizados → soma_itens vira SKIP, não
    penaliza — conforme spec do usuário §14). Validado contra gold VIA VAREJO Jales/Bertioga."""
    if not texto_combo:
        return None
    t = texto_combo
    out = {}
    # ── Detector: precisa parecer Elektro Grupo A
    if not re.search(r"ELEKTRO|02\.?328\.?280/0001|HOR[ÁA]RIA\s+VERDE", t, re.I):
        return None
    out["_elektro_grupo_a"] = True
    # ── CNPJ/CPF (cheio formatado / 11-14 díg / mascarado — validador aceita máscara).
    #    Rótulo 'CNPJ', 'CNPJ/CPF', com - ou : e possível quebra de linha.
    mc = re.search(r"CNPJ(?:/CPF)?\s*[-:]?\s*\n?\s*"
                   r"(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}|\d{11,14}|\*{2,}\d{4,})", t, re.I)
    if mc:
        d = mc.group(1)
        if d.startswith("*"):
            out["cnpj_mascarado"] = d
        elif "." in d:
            out["cnpj"] = d
        elif len(d) == 14:
            out["cnpj"] = f"{d[:2]}.{d[2:5]}.{d[5:8]}/{d[8:12]}-{d[12:]}"
        else:
            out["cnpj"] = d
    # ── Classificação: 'COMERCIAL,SERVICOS,OUTRAS ATIVIDADES / HORÁRIA VERDE / TRIFASICO'.
    #    Aceita com rótulo 'Classificação:' OU solto; e formato legado '...-TRIFASICO'.
    mcl = re.search(r"(COM[ÉE]RCIO|COMERCIAL|RESIDENCIAL|IND[ÚU]STRIA|INDUSTRIAL|RURAL|SERVI[ÇC]O\s+P[ÚU]BLICO|PODER\s+P[ÚU]BLICO)[A-ZÇ,\.\s]*?"
                    r"[/\-]\s*(HOR[ÁA]RIA\s+VERDE|HOR[ÁA]RIA\s+AZUL|CONVENCIONAL)\s*[/\-]\s*"
                    r"(TRIFASICO|TRIF[ÁA]SICO|BIFASICO|BIF[ÁA]SICO|MONOFASICO|MONOF[ÁA]SICO)", t, re.I)
    if not mcl:
        # legado pode vir '...ATIVIDADES-TRIFASICO' sem modalidade na mesma linha
        mcl2 = re.search(r"(COMERCIAL|RESIDENCIAL|INDUSTRIAL|RURAL)[A-ZÇ,\.\s]*?-\s*"
                         r"(TRIFASICO|BIFASICO|MONOFASICO)", t, re.I)
        if mcl2:
            cl = mcl2.group(1).upper()
            out["classe"] = "Comercial" if "COMERCIAL" in cl else cl.title()
            out["subgrupo"] = "A4"  # Elektro Grupo A Horária (modalidade detectada adiante via bandeira/itens)
            if re.search(r"HOR[ÁA]RIA\s+VERDE", t, re.I): out["modalidade"] = "Verde"
            elif re.search(r"HOR[ÁA]RIA\s+AZUL", t, re.I): out["modalidade"] = "Azul"
    if mcl:
        cl = mcl.group(1).upper()
        out["classe"] = "Comercial" if ("COMERCIAL" in cl or "COMÉRCIO" in cl or "COMERCIO" in cl) else (
            "Residencial" if "RESIDENCIAL" in cl else cl.title())
        md = mcl.group(2).upper()
        out["modalidade"] = "Verde" if "VERDE" in md else ("Azul" if "AZUL" in md else "Convencional")
        out["subgrupo"] = "A4" if "HOR" in md else None
    # ── Bandeira (legado: 'Band.Tarif. Escas.Hidri:01/03-01/04' / 'Band.Tarif. Verde:...')
    mb = re.search(r"Band\.?\s*Tarif\.?\s*(Verde|Escas\.?\s*H[íi]dri\w*|Vermelha\s*P?\s*\d?|Amarela)", t, re.I)
    if mb:
        b = mb.group(1).upper()
        out["bandeira"] = ("ESCASSEZ HÍDRICA" if "ESCAS" in b else
                           "VERMELHA PATAMAR II" if "VERMELHA" in b and "2" in b.replace("P", "") else
                           "VERMELHA" if "VERMELHA" in b else b)
    # ── Instalação: linha isolada após 'Dias do Período:' (vertical) OU 1ª linha (grid) OU
    #    'Seu Código' (legado) OU 1º número 7-9 díg no topo.
    mi = (re.search(r"Dias\s+do\s+Per[íi]odo:\s*\n+\s*(\d{7,9})\b", t)
          or re.search(r"^\s*(\d{7,9})\s*\n\s*VIA\s+VAREJO", t)
          or re.search(r"Seu\s+C[óo]digo\s*[:\n]\s*(\d{6,9})\b", t, re.I)
          or re.search(r"VIA\s+VAREJO\s+S/A\s+.*?\b(\d{7,9})\b\s*\n", t)
          or re.search(r"^\s*(\d{7,9})\b", t))
    if mi:
        out["instalacao"] = mi.group(1)
    # ── Leitura (datas ant/atual + dias): inline (grid) OU bloco vertical (após instalação)
    mla = re.search(r"Leitura\s+Anterior:\s*(\d{2}/\d{2}/\d{4})", t, re.I)
    mlb = re.search(r"Leitura\s+Atual:\s*(\d{2}/\d{2}/\d{4})", t, re.I)
    mdd = re.search(r"Dias\s+do\s+Per[íi]odo:\s*(\d{1,2})\b", t, re.I)
    if mla: out["leitura_anterior"] = mla.group(1)
    if mlb: out["leitura_atual"] = mlb.group(1)
    if mdd: out["dias"] = mdd.group(1)
    if not (mla and mlb):
        # layout vertical: rótulos agrupados; valores logo após a instalação
        # (ex.: '31117040\n\n28/02/2022\n31/03/2022\n31\n')
        mv = re.search(r"\b\d{7,9}\s*\n+\s*(\d{2}/\d{2}/\d{4})\s*\n\s*(\d{2}/\d{2}/\d{4})\s*\n\s*(\d{1,2})\b", t)
        if mv:
            out.setdefault("leitura_anterior", mv.group(1))
            out.setdefault("leitura_atual", mv.group(2))
            out.setdefault("dias", mv.group(3))
    # ── Total + mês de referência (linha FAT-01)
    mt = re.search(r"FAT-01-[\d.]+[\s\S]{0,90}?R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})", t)
    if mt:
        out["valor_total"] = mt.group(1)
    mr = re.search(rf"FAT-01-[\d.]+[\s\S]{{0,50}}?\b({_ELK_MESES_RE})\s*/\s*(\d{{4}})", t, re.I)
    if mr:
        out["mes_ref"] = f"{_ELK_MES_NOME[mr.group(1).lower().replace('ç','c')]}/{mr.group(2)}"
    return out


def enriquecer_light_cadastral(texto_combo: str):
    """Especialista CADASTRAL Light RJ (NF3e Grupo A4/AS Verde ACL — VIA VAREJO RJ). O cabeçalho
    traz na 1ª linha 'Grupo A4 / A4 - Verde / Comercial / Comercial' e as datas de leitura no
    grid logo abaixo. Captura classe/modalidade/subgrupo + leitura (ant/atual/dias) — o que o
    genérico não pega (55 classificacao FAIL + 13 leitura FAIL no diag). Marca _light_grupo_a:
    histórico 12m NÃO sai no texto NF3e da Light → SKIP (não penaliza). instalação/CNPJ já vêm
    de extrair_ids_light_rj + blocos 9.0.4."""
    if not texto_combo:
        return None
    t = texto_combo
    out = {}
    # ── Classificação: 'Grupo A4 / A4 - Verde / Comercial / Comercial' (ou B / Convencional)
    m = re.search(r"Grupo\s+(A\d|B\d)\s*/\s*(?:A\d|B\d)?\s*-?\s*"
                  r"(Verde|Azul|Branca|Convencional)\s*/\s*"
                  r"(Comercial|Residencial|Industrial|Rural|Poder\s+P[úu]blico|Servi[çc]o\s+P[úu]blico)", t, re.I)
    if not m:
        return None  # não é o layout NF3e Light com cabeçalho de classificação
    out["subgrupo"] = m.group(1).upper()
    md = m.group(2).upper()
    out["modalidade"] = ("Verde" if "VERDE" in md else "Azul" if "AZUL" in md
                         else "Branca" if "BRANCA" in md else "Convencional")
    out["classe"] = m.group(3).strip().title()
    if out["subgrupo"].startswith("A"):
        out["_light_grupo_a"] = True
    # ── Leitura: linha do grid logo após a classificação tem ant/atual/dias/próx
    #    '... | 31/08/2022 | | 30/09/2022 | | 30 | 31/10/2022 |'
    seg = t[m.end():m.end() + 400]
    ml = re.search(r"(\d{2}/\d{2}/\d{4})[^\d]{1,12}(\d{2}/\d{2}/\d{4})[^\d]{1,8}(\d{1,3})[^\d]{1,12}(\d{2}/\d{2}/\d{4})", seg)
    if ml:
        out["leitura_anterior"] = ml.group(1)
        out["leitura_atual"] = ml.group(2)
        d = int(ml.group(3))
        if 20 <= d <= 40:
            out["dias"] = ml.group(3)
        out["proxima_leitura"] = ml.group(4)
    return out


# ────────────────────────────────────────────────────────────────────────
# Orquestrador: roda tudo de uma vez
# ────────────────────────────────────────────────────────────────────────
def aplicar_complementos(out_v2: dict, texto: str, cascata: dict = None, pdf_path: str = None, texto_md: str = None, uid=None) -> dict:
    """Aplica todas as correções complementares ao dict do FaturaExtractorV2.

    Args:
        out_v2: dict do FaturaExtractorV2
        texto: texto plumber (primário)
        cascata: dict opcional do extrator_v3 (para hidratação via boleto)
        pdf_path: caminho do PDF (para extração posicional via PyMuPDF)
        texto_md: texto markdown opcional (pymupdf4llm) — usado quando plumber falha
    """
    if not texto: return out_v2
    # Texto combinado (plumber + markdown) para campos que falham em só um deles
    texto_combo = texto if not texto_md else (texto + "\n\n" + texto_md)
    # Amazonas/Âmbar com fonte deslocada (+29): plumber=(cid:NN), bbox deslocado → decodifica e
    # anexa o texto legível p/ o roteamento e o especialista lerem (não toca o resto do fluxo).
    _amz_dec = _amz_desofuscar(texto_combo)
    if _amz_dec:
        texto_combo = texto_combo + "\n\n" + _amz_dec

    # 1. Detecta fatura ANTIGA (layout pré-2022) — checks específicos serão SKIP
    # Sinais: cabeçalho 'GRUPO/SUBGRP.:' (em vez de 'Classificação:'),
    #        ou 'CCI DESCRIÇÃO' (header antigo de itens),
    #        ou data de emissão pré-2022.
    eh_antiga = bool(
        re.search(r"GRUPO/SUBGRP\.:", texto)
        or re.search(r"CCI\s+DESCRI[ÇC][ÃA]O", texto, re.I)
        or re.search(r"DATA DE EMISS[ÃA]O\s*:?\s*\d{2}/\d{2}/(?:201\d|2020|2021)", texto, re.I)
    )
    if eh_antiga:
        out_v2["_fatura_antiga"] = True
        out_v2.setdefault("_obs_layout", "Layout pré-2022 (REN 414/REN 482) — alguns campos extraídos com formato distinto")

    # 1.5 EDP ESPÍRITO SANTO — layout NF/Conta simples (distinto do EDP SP DANF3E).
    # Roda CEDO pra preencher campos antes dos fallbacks universais e do hardcode de dist.
    if eh_edp_es(texto_combo):
        es = extrair_edp_es_campos(texto_combo)
        # Mantém _mapa_usado='edp' (casa em _DISTS_SEM_INDICADORES). Flag marca o sub-layout ES.
        out_v2["_edp_es"] = True
        out_v2["_edp_es_sem_historico"] = True  # layout NF/Conta simples não imprime histórico 12m
        # Distribuidora (sobrescreve o hardcode SP)
        dist_es = out_v2.setdefault("distribuidora", {})
        dist_es["razao_social"] = es.get("dist_razao")
        if es.get("dist_cnpj"): dist_es["cnpj_emissor"] = es["dist_cnpj"]
        dist_es["uf_emissor"] = "ES"
        dist_es["_fonte_edp_es"] = True
        # Cliente
        cli_es = out_v2.setdefault("cliente", {})
        if es.get("cli_razao"): cli_es["razao_social"] = es["cli_razao"]
        if es.get("cli_cnpj"):  cli_es["cnpj"] = es["cli_cnpj"]
        # Identificadores
        ident_es = out_v2.setdefault("identificadores_instalacao", {})
        if es.get("num_instalacao"): ident_es["codigo_instalacao"] = es["num_instalacao"]
        if es.get("medidor"):        ident_es["medidor"] = es["medidor"]
        # Classificação + ligação técnica
        clf_es = out_v2.setdefault("classificacao", {})
        lt_es  = out_v2.setdefault("ligacao_tecnica", {})
        if es.get("subgrupo"):
            clf_es["subgrupo"] = es["subgrupo"]; lt_es["subgrupo"] = es["subgrupo"]
        if es.get("classe"):
            clf_es["classe_consumo"] = es["classe"]; lt_es["classe"] = es["classe"]
        if es.get("modalidade"):
            clf_es["modalidade_tarifaria"] = es["modalidade"]; lt_es["modalidade_tarifaria"] = es["modalidade"]
        if es.get("tensao"):    lt_es["tensao_nominal_v"] = es["tensao"]
        if es.get("tipo_forn"): lt_es["tipo_ligacao"] = es["tipo_forn"]
        # Vencimento / valor / mês ref
        vv_es = out_v2.setdefault("vencimento_valor", {})
        if es.get("valor_total"): vv_es["valor_total"] = es["valor_total"]
        if es.get("vencimento"):  vv_es["data_vencimento"] = es["vencimento"]
        if es.get("mes_ref"):     vv_es["mes_ref"] = es["mes_ref"]
        # Período de leitura
        pl_es = out_v2.setdefault("periodo_leitura", {})
        if es.get("leit_ant_data"): pl_es["leitura_anterior"] = es["leit_ant_data"]
        if es.get("leit_atu_data"): pl_es["leitura_atual"] = es["leit_atu_data"]
        if es.get("dias"):          pl_es["dias_consumo"] = es["dias"]
        # Tributos ES (pis/cofins/icms formato 'BASE X ALIQ% = VALOR')
        trib_es_full = extrair_tributos_edp_es(texto_combo)
        if trib_es_full:
            tpd_es = out_v2.setdefault("tributos_por_dist", {})
            for k in ("pis", "cofins", "icms"):
                if trib_es_full.get(k): tpd_es[k] = trib_es_full[k]

    # 2. Cliente — tenta plumber primeiro, depois combo (plumber+md) pra CNPJ Enel
    cli_uc = extrair_cliente_uc(texto)
    if not cli_uc.get("cnpj_cliente") and texto_md:
        cli_uc_md = extrair_cliente_uc(texto_combo)
        if cli_uc_md.get("cnpj_cliente"):
            cli_uc["cnpj_cliente"] = cli_uc_md["cnpj_cliente"]
    cli = out_v2.setdefault("cliente", {})
    if cli_uc.get("razao_social_uc") and not cli.get("razao_social"):
        cli["razao_social"] = cli_uc["razao_social_uc"]
    if cli_uc.get("endereco_uc") and not cli.get("endereco_uc"):
        cli["endereco_uc"] = cli_uc["endereco_uc"]
    if cli_uc.get("cep_uc") and not cli.get("cep_uc"):
        cli["cep_uc"] = cli_uc["cep_uc"]
    if cli_uc.get("cnpj_cliente") and not cli.get("cnpj"):
        cli["cnpj"] = cli_uc["cnpj_cliente"]
    if cli_uc.get("ie_cliente") and not cli.get("ie"):
        cli["ie"] = cli_uc["ie_cliente"]

    # 2.1 Fallbacks universais (descobertos pelo LLM crítico em 33/42 reprovadas)
    if not cli.get("cnpj"):
        cnpj_uni = extrair_cnpj_cliente_universal(texto_combo)
        if cnpj_uni:
            cli["cnpj"] = cnpj_uni
            cli["_cnpj_fonte"] = "universal_fallback"
    if not cli.get("ie"):
        ie_uni = extrair_ie_cliente_universal(texto_combo)
        if ie_uni:
            cli["ie"] = ie_uni
            cli["_ie_fonte"] = "universal_fallback"

    # 5. Vencimento e Valor
    vv = extrair_vencimento_valor(texto)
    vv_d = out_v2.setdefault("vencimento_valor", {})
    if vv.get("mes_referencia") and not out_v2.get("_edp_es"):
        # Sobrescreve se atual é da Referência (indicador qualidade) — diferente de mês ref do ciclo.
        # EDP ES já setou mes_ref correto ("Conta do Mês") — não deixar o cálculo por ciclo sobrescrever.
        vv_d["mes_ref"] = vv["mes_referencia"]
    if vv.get("data_vencimento") and not vv_d.get("data_vencimento"):
        vv_d["data_vencimento"] = vv["data_vencimento"]
    if vv.get("valor_total") and not vv_d.get("valor_total"):
        vv_d["valor_total"] = vv["valor_total"]

    # 5.0.5 Período de leitura universal (4 datas em sequência)
    pl = out_v2.setdefault("periodo_leitura", {})
    pl_uni = extrair_periodo_leitura_universal(texto_combo)
    for k, v in pl_uni.items():
        if v and not pl.get(k):
            pl[k] = v

    # 5.0.6 Bandeira tarifária universal + valor (Fix I+J)
    band = extrair_bandeira_tarifaria(texto_combo)
    if band:
        lt = out_v2.setdefault("ligacao_tecnica", {})
        if band.get("bandeira") and not lt.get("bandeira_tarifaria"):
            lt["bandeira_tarifaria"] = band["bandeira"].title()
        if band.get("bandeira_periodo_inicio"):
            lt["bandeira_periodo_inicio"] = band["bandeira_periodo_inicio"]
            lt["bandeira_periodo_fim"] = band["bandeira_periodo_fim"]
        if band.get("valor_bandeira") is not None:
            lt["valor_bandeira"] = band["valor_bandeira"]

    # 5.0.6b Demanda contratada (Grupo A) — Fix 5
    dem = extrair_demanda_contratada_universal(texto_combo)
    if dem.get("ponta") or dem.get("fponta"):
        lt = out_v2.setdefault("ligacao_tecnica", {})
        if dem.get("ponta") is not None and not lt.get("demanda_contratada_ponta_kw"):
            lt["demanda_contratada_ponta_kw"] = dem["ponta"]
        if dem.get("fponta") is not None and not lt.get("demanda_contratada_fponta_kw"):
            lt["demanda_contratada_fponta_kw"] = dem["fponta"]

    # 5.0.7 / 5.1 — VALOR TOTAL (regra R1, validada no lote colab 2026-06-05):
    # O "TOTAL A PAGAR" do CABEÇALHO/BOLETO é a VERDADE e tem PRIORIDADE sobre a
    # linha "TOTAL" da tabela de tributos. Motivo: o layout da linha TOTAL varia por
    # distribuidora — ex. EDP 'TOTAL 659,44 163,34 ...' (valor 1º) vs Light
    # 'TOTAL 5,55 1.092,89' (PIS/COFINS 1º). Confiar cegamente na linha TOTAL fazia a
    # Light gravar 5,55 em vez de 1.622,97. O "TOTAL A PAGAR" do cabeçalho não tem essa
    # ambiguidade. Em faturas GD/SCEE isso é ainda mais crítico (compensação).
    vt_cabecalho = extrair_valor_total_universal(texto_combo)
    ttl_val = (out_v2.get("tributos_total_linha") or {}).get("valor_total")
    if vt_cabecalho:
        # cabeçalho manda; preserva os outros candidatos pra auditoria
        if vv_d.get("valor_total") and vv_d["valor_total"] != vt_cabecalho:
            vv_d["_valor_total_extrator"] = vv_d["valor_total"]
        if ttl_val and ttl_val != vt_cabecalho:
            vv_d["_valor_total_tributos_linha"] = ttl_val
        vv_d["valor_total"] = vt_cabecalho
        vv_d["_valor_total_fonte"] = "total_a_pagar_cabecalho"
    elif ttl_val:
        # sem "TOTAL A PAGAR" no cabeçalho: cai no comportamento anterior (linha TOTAL
        # da tabela inclui CIP, melhor que o Subtotal Faturamento que exclui).
        atual = vv_d.get("valor_total")
        if atual != ttl_val:
            if atual:
                vv_d["_valor_total_subtotal"] = atual  # preserva o subtotal pra audit
            vv_d["valor_total"] = ttl_val
            vv_d["_valor_total_fonte"] = "tributos_total_linha"


    # 7.4 Patterns dist-específicos para itens (quando extrator base não casa)
    itens = out_v2.get("itens_fatura") or []
    _mapa_pre = (out_v2.get("_mapa_usado") or "").lower()
    if _mapa_pre == "light":
        # Light SEMPRE roda pattern dedicado (complementa o extrator base)
        itens_light = extrair_itens_light(texto)
        if itens_light:
            # Merge: adiciona itens novos (chave por desc[:25] + valor)
            existentes = {((it.get("descricao") or "").upper()[:25], round(it.get("valor_brl_numerico") or 0, 2)) for it in itens}
            for it_l in itens_light:
                k = ((it_l.get("descricao") or "").upper()[:25], round(it_l.get("valor_brl_numerico") or 0, 2))
                if k not in existentes:
                    itens.append(it_l)
                    existentes.add(k)
            out_v2["itens_fatura"] = itens
    elif _mapa_pre == "enel_sp":
        # SEMPRE roda pattern dedicado (complementa base) — merge
        itens_sp = extrair_itens_enel_sp(texto)
        if itens_sp:
            existentes = {((it.get("descricao") or "").upper()[:25], round(it.get("valor_brl_numerico") or 0, 2)) for it in itens}
            for it_n in itens_sp:
                k = ((it_n.get("descricao") or "").upper()[:25], round(it_n.get("valor_brl_numerico") or 0, 2))
                if k not in existentes:
                    itens.append(it_n)
                    existentes.add(k)
            out_v2["itens_fatura"] = itens
        # Dedup item-fantasma ENEL SP: pdfplumber gruda a linha de CABEÇALHO da tabela
        # ('CONSUMO DIAS FATURAMENTO TIPO DE\nUSO SIST. DISTR. (TUSD)') re-capturando o
        # MESMO valor de um item limpo → soma_itens > total. Remove o ruidoso SÓ quando
        # existe um item limpo com idêntico valor (seguro: não derruba item legítimo).
        _itx = out_v2.get("itens_fatura") or []
        _HDR_NOISE = ("CONSUMO DIAS", "DIAS FATURAMENTO", "MÊS/ANO", "TIPO DE MEDI", "FATURAMENTO TIPO")
        def _it_ruidoso(d):
            d = d or ""
            return ("\n" in d) or any(h in d.upper() for h in _HDR_NOISE)
        _vals_limpos = {round(it.get("valor_brl_numerico") or 0, 2)
                        for it in _itx if not _it_ruidoso(it.get("descricao"))}
        _itx2 = [it for it in _itx
                 if not (_it_ruidoso(it.get("descricao"))
                         and round(it.get("valor_brl_numerico") or 0, 2) in _vals_limpos)]
        if len(_itx2) != len(_itx):
            out_v2["itens_fatura"] = _itx2
            itens = _itx2   # atualiza o local — senão 7.5/7.6 reescrevem com a lista furada
    elif _mapa_pre == "copel":
        itens_copel = extrair_itens_copel(texto)
        if itens_copel:
            existentes = {((it.get("descricao") or "").upper()[:25], round(it.get("valor_brl_numerico") or 0, 2)) for it in itens}
            for it_n in itens_copel:
                k = ((it_n.get("descricao") or "").upper()[:25], round(it_n.get("valor_brl_numerico") or 0, 2))
                if k not in existentes:
                    itens.append(it_n)
                    existentes.add(k)
            out_v2["itens_fatura"] = itens
    elif _mapa_pre in ("cpfl_santacruz", "cpfl_piratininga", "cpfl_paulista"):
        # SEMPRE roda pattern dedicado (complementa base) — merge
        if "COPEL" in (texto or "").upper():
            itens_novos = extrair_itens_copel(texto)
        else:
            itens_novos = extrair_itens_cpfl(texto)
        if itens_novos:
            existentes = {((it.get("descricao") or "").upper()[:25], round(it.get("valor_brl_numerico") or 0, 2)) for it in itens}
            for it_n in itens_novos:
                k = ((it_n.get("descricao") or "").upper()[:25], round(it_n.get("valor_brl_numerico") or 0, 2))
                if k not in existentes:
                    itens.append(it_n)
                    existentes.add(k)
            out_v2["itens_fatura"] = itens
    elif _mapa_pre == "celesc" and "COPEL" not in (texto or "").upper():
        # CELESC verdadeiro (não COPEL): pattern com códigos (0D), (0E), etc
        itens_cls = extrair_itens_celesc(texto)
        if itens_cls:
            existentes = {((it.get("descricao") or "").upper()[:25], round(it.get("valor_brl_numerico") or 0, 2)) for it in itens}
            for it_n in itens_cls:
                k = ((it_n.get("descricao") or "").upper()[:25], round(it_n.get("valor_brl_numerico") or 0, 2))
                if k not in existentes:
                    itens.append(it_n)
                    existentes.add(k)
            out_v2["itens_fatura"] = itens
    elif _mapa_pre == "celesc" and "COPEL" in (texto or "").upper():
        itens_copel = extrair_itens_copel(texto)
        if itens_copel:
            existentes = {((it.get("descricao") or "").upper()[:25], round(it.get("valor_brl_numerico") or 0, 2)) for it in itens}
            for it_n in itens_copel:
                k = ((it_n.get("descricao") or "").upper()[:25], round(it_n.get("valor_brl_numerico") or 0, 2))
                if k not in existentes:
                    itens.append(it_n)
                    existentes.add(k)
            out_v2["itens_fatura"] = itens
    elif _mapa_pre in ("neoenergia_cosern", "neoenergia_ba", "neoenergia_pe"):
        itens_ne = extrair_itens_neoenergia(texto)
        if itens_ne:
            existentes = {((it.get("descricao") or "").upper()[:25], round(it.get("valor_brl_numerico") or 0, 2)) for it in itens}
            for it_n in itens_ne:
                k = ((it_n.get("descricao") or "").upper()[:25], round(it_n.get("valor_brl_numerico") or 0, 2))
                if k not in existentes:
                    itens.append(it_n)
                    existentes.add(k)
            out_v2["itens_fatura"] = itens
    elif _mapa_pre in ("equatorial_goias", "equatorial_norte"):
        itens_eq = extrair_itens_equatorial(texto)
        if itens_eq:
            existentes = {((it.get("descricao") or "").upper()[:25], round(it.get("valor_brl_numerico") or 0, 2)) for it in itens}
            for it_n in itens_eq:
                k = ((it_n.get("descricao") or "").upper()[:25], round(it_n.get("valor_brl_numerico") or 0, 2))
                if k not in existentes:
                    itens.append(it_n)
                    existentes.add(k)
            out_v2["itens_fatura"] = itens
    elif _mapa_pre in ("elektro_sp", "elektro_ms"):
        # Elektro SP — 3 layouts: DANFELEKB (B3 BT GD), DANFELEKA (A4 Horária Verde), GBELEKTRO1 (antigo 2021)
        itens_elk = extrair_itens_elektro_sp(texto)
        if itens_elk:
            existentes = {((it.get("descricao") or "").upper()[:25], round(it.get("valor_brl_numerico") or 0, 2)) for it in itens}
            for it_n in itens_elk:
                k = ((it_n.get("descricao") or "").upper()[:25], round(it_n.get("valor_brl_numerico") or 0, 2))
                if k not in existentes:
                    itens.append(it_n)
                    existentes.add(k)
            out_v2["itens_fatura"] = itens
    elif _mapa_pre == "cemig":
        # CEMIG: itens de DÉBITO texto+valor (Cobrança/Multa/Juros/Correção/Parcela) que o
        # regex base ignora → soma_itens < total. Merge fecha a soma (flipa revisão).
        itens_dbc = extrair_itens_debitos_cemig(texto)
        if itens_dbc:
            existentes = {((it.get("descricao") or "").upper()[:25], round(it.get("valor_brl_numerico") or 0, 2)) for it in itens}
            for it_n in itens_dbc:
                k = ((it_n.get("descricao") or "").upper()[:25], round(it_n.get("valor_brl_numerico") or 0, 2))
                if k not in existentes:
                    itens.append(it_n)
                    existentes.add(k)
            out_v2["itens_fatura"] = itens

    # 7.5 Captura encargos sem qtd (CIP/Iluminação Pública) — Enel/CEMIG
    encargos = extrair_itens_encargos_sem_qtd(texto)
    if encargos:
        # Dedup: chave = (categoria, valor) — pega CIP/COSIP/ILUM = mesma categoria
        def _categoria(d):
            up = (d or "").upper()
            if "CIP" in up or "COSIP" in up or "ILUM" in up or "CONTRIB" in up: return "ILUM_PUB"
            return up[:15]
        descs_existentes = {(_categoria(it.get("descricao")), round(it.get("valor_brl_numerico") or 0, 2)) for it in itens}
        for enc in encargos:
            chave = (_categoria(enc["descricao"]), round(enc.get("valor_brl_numerico") or 0, 2))
            if chave not in descs_existentes:
                itens.append(enc)
                descs_existentes.add(chave)
        out_v2["itens_fatura"] = itens

    # 7.6 Dedup pós-encargos: remove itens com mesma categoria+valor (CIP/COSIP/ILUM)
    if itens:
        vistos = set(); itens_dedup = []
        def _cat(d):
            up = (d or "").upper()
            if "CIP" in up or "COSIP" in up or "ILUM" in up: return "ILUM_PUB"
            return up[:25]
        for it in itens:
            k = (_cat(it.get("descricao")), round(it.get("valor_brl_numerico") or 0, 2))
            if k not in vistos:
                vistos.add(k); itens_dedup.append(it)
        if len(itens_dedup) < len(itens):
            out_v2["itens_fatura"] = itens_dedup
            itens = itens_dedup

    # 8. Itens — tarifa Unit ANEEL alias
    enriquecer_itens_com_tarifa_aneel(itens)

    # 9. COFINS estimado
    tpd = out_v2.setdefault("tributos_por_dist", {})
    # 9.0 Replica tributos_total_linha em tributos_por_dist quando vazio (CEMIG layout)
    ttl = out_v2.get("tributos_total_linha") or {}
    if ttl and not tpd:
        # CEMIG combina PIS+COFINS num único campo na linha TOTAL
        if ttl.get("pis_cofins_combinado") and "pis_cofins" not in tpd:
            tpd["pis_cofins"] = {
                "valor_string": ttl["pis_cofins_combinado"],
                "_fonte": "tributos_total_linha",
            }
        if ttl.get("icms_valor") and "icms" not in tpd:
            tpd["icms"] = {
                "base_string": ttl.get("icms_base"),
                "valor_string": ttl["icms_valor"],
                "_fonte": "tributos_total_linha",
            }

    _mapa_atual = (out_v2.get("_mapa_usado") or "").lower()

    # 9.0.1 Energisa — linha TOTAL é AUTORITATIVA para ICMS líquido.
    # Nas faturas NF3e Energisa o OCR embaralha as colunas dos itens (PIS/COFINS/ICMS
    # interleaved com a linha de injeção GD), então o regex de item pode capturar
    # alíquota/valor errados (ex.: B2 bifásico lê ICMS=3,1185 sendo o real 9,02).
    # A linha 'TOTAL: valor pis_cofins base_icms icms' não embaralha → override.
    if _mapa_atual.startswith("energisa") and ttl.get("icms_valor"):
        icms_old = tpd.get("icms") or {}
        if (icms_old.get("valor_string") != ttl["icms_valor"]):
            tpd["icms"] = {
                "base_string": ttl.get("icms_base") or icms_old.get("base_string"),
                "valor_string": ttl["icms_valor"],
                "_fonte": "tributos_total_linha_override",
                "_valor_regex_descartado": icms_old.get("valor_string"),
            }
        # PIS+COFINS combinado da linha TOTAL quando itens não trouxeram os dois
        if ttl.get("pis_cofins_combinado") and not (tpd.get("pis") and tpd.get("cofins")) \
           and "pis_cofins" not in tpd:
            tpd["pis_cofins"] = {
                "valor_string": ttl["pis_cofins_combinado"],
                "_fonte": "tributos_total_linha",
            }

    # 9.0.3 CEMIG (clássico "Cemig Atende" + moderno NF3e GD/SCEE): o mapa CEMIG não
    # extrai esses layouts. Preenche classificação/medição/tributos/histórico/GD que
    # estavam falhando (historico FAIL, tributos/classif/leitura). fill-if-empty.
    if _mapa_atual == "cemig":
        cm = extrair_cemig_atende_classico(texto_combo)
        if cm:
            # classificação
            clf = cm.get("classificacao") or {}
            cd = out_v2.setdefault("classificacao", {})
            if clf.get("modalidade") and not cd.get("modalidade_tarifaria"): cd["modalidade_tarifaria"] = clf["modalidade"]
            if clf.get("subgrupo") and not cd.get("subgrupo"): cd["subgrupo"] = clf["subgrupo"]
            if clf.get("classe") and not cd.get("classe_consumo"): cd["classe_consumo"] = clf["classe"]
            # período de leitura (datas dd/mm + dias do 1º mês do histórico)
            pl = out_v2.setdefault("periodo_leitura", {})
            if cm.get("leit_ant_data") and not pl.get("leitura_anterior"): pl["leitura_anterior"] = cm["leit_ant_data"]
            if cm.get("leit_atu_data") and not pl.get("leitura_atual"): pl["leitura_atual"] = cm["leit_atu_data"]
            if (cm.get("historico") and not pl.get("dias_consumo")
                    and cm["historico"][0].get("dias_ciclo")):
                pl["dias_consumo"] = cm["historico"][0]["dias_ciclo"]
            # medição → ligacao_tecnica
            lt = out_v2.setdefault("ligacao_tecnica", {})
            for k_src, k_dst in [("medidor", "numero_medidor"), ("constante", "constante_multiplicacao"),
                                  ("consumo_kwh", "consumo_total_kwh")]:
                if cm.get(k_src) is not None and not lt.get(k_dst): lt[k_dst] = cm[k_src]
            # tributos (ICMS/PIS/COFINS do bloco 'Reservado ao Fisco')
            for k, v in (cm.get("tributos") or {}).items():
                if v and not tpd.get(k): tpd[k] = v
            # histórico 13m
            if cm.get("historico") and not out_v2.get("historico_13m_consumo"):
                out_v2["historico_13m_consumo"] = [
                    {"mes": h["mes"], "ano": h["ano"], "consumo_kwh": h["consumo_kwh"],
                     "dias_ciclo": h.get("dias_ciclo")} for h in cm["historico"]]
            # CNPJ emissor: CEMIG não imprime '06.981.180' no layout legado → seta (é da CEMIG)
            dst = out_v2.setdefault("distribuidora", {})
            if not dst.get("cnpj_emissor"):
                dst["cnpj_emissor"] = "06.981.180/0001-16"
            # GD/SCEE → geracao_distribuida
            gdc = cm.get("gd") or {}
            if gdc:
                gd_d = out_v2.setdefault("geracao_distribuida", {})
                if gdc.get("energia_compensada_kwh") and not gd_d.get("energia_compensada_kwh"):
                    gd_d["energia_compensada_kwh"] = gdc["energia_compensada_kwh"]
                    gd_d["tem_gd"] = True
                    # 'Energia compensada GD I' = autogeração da PRÓPRIA UC (mUC), não crédito de oUC.
                    # Registra como compensação própria → gd_consistente PASS (sem oUC é o esperado).
                    if not gd_d.get("compensacao_propria_mUC"):
                        gd_d["compensacao_propria_mUC"] = [{
                            "kwh": gdc["energia_compensada_kwh"],
                            "valor_rs": gdc.get("valor_compensado_rs"),
                            "_fonte": "cemig_scee_gd_i",
                        }]
                if gdc.get("energia_injetada_kwh") is not None and gd_d.get("energia_injetada_kwh") is None:
                    gd_d["energia_injetada_kwh"] = gdc["energia_injetada_kwh"]
                for sk in ("saldo_fp_kwh", "saldo_ponta_kwh", "valor_compensado_rs"):
                    if gdc.get(sk) is not None and gd_d.get(sk) is None: gd_d[sk] = gdc[sk]

    # 9.0.4 Light — extrai ICMS-ST via Art. 3º-A + PIS/COFINS via linha TOTAL
    if _mapa_atual == "light":
        trib_light = extrair_tributos_light(texto_combo)
        for k in ("icms", "pis_cofins"):
            if trib_light.get(k) and k not in tpd:
                tpd[k] = trib_light[k]

    # 9.0.4b Light A4/AS Verde ACL/CCEE (mercado livre, cod_empresa 4) — componentes
    # Fio/Encargo. O mapa light não extrai classificação/tributos deste layout. fill-if-empty.
    if _mapa_atual == "light" and re.search(r"Componente\s+(?:Fio|Encargo)|Rel\.\s*de\s*Contabiliza|Energia\s+Ativa\s+kWh\s+HFP|THS\s+Verde\s+A", texto_combo, re.I):
        la = extrair_light_acl(texto_combo)
        if la:
            lcl = la.get("classificacao") or {}
            cd = out_v2.setdefault("classificacao", {})
            if lcl.get("modalidade") and not cd.get("modalidade_tarifaria"): cd["modalidade_tarifaria"] = lcl["modalidade"]
            if lcl.get("subgrupo") and not cd.get("subgrupo"): cd["subgrupo"] = lcl["subgrupo"]
            if lcl.get("classe") and not cd.get("classe_consumo"): cd["classe_consumo"] = lcl["classe"]
            for k, v in (la.get("tributos") or {}).items():
                if v and not tpd.get(k): tpd[k] = v
            # vencimento/total/mes_ref (cabeçalho legacy embaralhado) — fill-if-empty
            vv = out_v2.setdefault("vencimento_valor", {})
            if la.get("valor_total") and not vv.get("valor_total"): vv["valor_total"] = la["valor_total"]
            if la.get("mes_ref") and not (vv.get("mes_ref") or vv.get("mes_referencia")): vv["mes_ref"] = la["mes_ref"]
            if la.get("data_vencimento") and not vv.get("data_vencimento"): vv["data_vencimento"] = la["data_vencimento"]
            # período de leitura legacy
            pl = out_v2.setdefault("periodo_leitura", {})
            if la.get("leit_ant_data") and not pl.get("leitura_anterior"): pl["leitura_anterior"] = la["leit_ant_data"]
            if la.get("leit_atu_data") and not pl.get("leitura_atual"): pl["leitura_atual"] = la["leit_atu_data"]
            if la.get("dias") and not pl.get("dias_consumo"): pl["dias_consumo"] = la["dias"]
            edl = out_v2.setdefault("_extras_dist", {})
            if la.get("componentes"): edl["light_componentes_acl"] = la["componentes"]
            edl["ind_mercado_livre_acl"] = True
            # CNPJ emissor Light (não aparece no corpo de alguns layouts → seta)
            dstl = out_v2.setdefault("distribuidora", {})
            if not dstl.get("cnpj_emissor"):
                dstl["cnpj_emissor"] = "60.444.437/0001-46"

    # 9.0.4b1.5 Light — ESPECIALISTA CADASTRAL (NF3e Grupo A4/AS Verde). Cabeçalho
    # 'Grupo A4 / A4 - Verde / Comercial' + leituras no grid. Fixa classificacao (55 FAIL) +
    # leitura (13 FAIL). Marca _light_grupo_a → histórico 12m (não impresso no texto NF3e) vira
    # SKIP. fill-if-empty. Detector amplo Light (mapa/CNPJ/nome).
    if (_mapa_atual == "light" or re.search(r"60\.?444\.?437/0001|\bLIGHT\b|Light\s+Servi", texto_combo, re.I)):
        _lk = enriquecer_light_cadastral(texto_combo)
        if _lk:
            _lcd = out_v2.setdefault("classificacao", {})
            if _lk.get("subgrupo") and not _lcd.get("subgrupo"): _lcd["subgrupo"] = _lk["subgrupo"]
            if _lk.get("modalidade") and not _lcd.get("modalidade_tarifaria"): _lcd["modalidade_tarifaria"] = _lk["modalidade"]
            if _lk.get("classe") and not _lcd.get("classe_consumo"): _lcd["classe_consumo"] = _lk["classe"]
            if _lk.get("_light_grupo_a"): out_v2["_light_grupo_a"] = True
            _lpl = out_v2.setdefault("periodo_leitura", {})
            if _lk.get("leitura_anterior") and not _lpl.get("leitura_anterior"): _lpl["leitura_anterior"] = _lk["leitura_anterior"]
            if _lk.get("leitura_atual") and not _lpl.get("leitura_atual"): _lpl["leitura_atual"] = _lk["leitura_atual"]
            if _lk.get("dias") and not _lpl.get("dias_consumo"): _lpl["dias_consumo"] = _lk["dias"]

    # 9.0.4b2 Light A4 TUSD Livre — tributos em tabela vertical (ICMS '<base> <aliq>% <valor>';
    # PIS/COFINS '<aliq,3dec>% <valor>' sem rótulo, distinguidos por alíquota). extrair_light_acl
    # não pega esse formato e o layout roteia mapa=None. fill-if-empty, scoped por Componente Fio/Encargo.
    if re.search(r"Componente\s+(?:Fio|Encargo)", texto_combo, re.I) and \
       not ((tpd.get("icms") or {}).get("valor_string") and (tpd.get("pis") or {}).get("valor_string")
            and (tpd.get("cofins") or {}).get("valor_string")):
        lt = extrair_light_a4_tusd(texto_combo)
        if lt:
            for k in ("icms", "pis", "cofins"):
                if lt.get(k) and not (tpd.get(k) or {}).get("valor_string"):
                    tpd[k] = lt[k]
            vv = out_v2.setdefault("vencimento_valor", {})
            if lt.get("valor_total") and not vv.get("valor_total"):
                vv["valor_total"] = lt["valor_total"]
            dstl = out_v2.setdefault("distribuidora", {})
            if not dstl.get("cnpj_emissor"):
                dstl["cnpj_emissor"] = "60.444.437/0001-46"

    # 9.0.4c Equatorial GO A4 THS_VERDE Livre (PCH50/ACL) — o mapa equatorial não extrai
    # este layout (modalidade null → reprovado). fill-if-empty.
    if _mapa_atual.startswith("equatorial") and re.search(r"THS_VERDE|DEMANDA\s+LIVRE|PARCELA\s+TUSD", texto_combo, re.I):
        eg = extrair_equatorial_go_acl(texto_combo)
        if eg:
            ecl = eg.get("classificacao") or {}
            cd = out_v2.setdefault("classificacao", {})
            if ecl.get("modalidade") and not cd.get("modalidade_tarifaria"): cd["modalidade_tarifaria"] = ecl["modalidade"]
            if ecl.get("subgrupo") and not cd.get("subgrupo"): cd["subgrupo"] = ecl["subgrupo"]
            if ecl.get("classe") and not cd.get("classe_consumo"): cd["classe_consumo"] = ecl["classe"]
            for k, v in (eg.get("tributos") or {}).items():
                if v and not tpd.get(k): tpd[k] = v
            vv = out_v2.setdefault("vencimento_valor", {})
            if eg.get("valor_total") and not vv.get("valor_total"): vv["valor_total"] = eg["valor_total"]
            if eg.get("mes_ref") and not (vv.get("mes_ref") or vv.get("mes_referencia")): vv["mes_ref"] = eg["mes_ref"]
            if eg.get("data_vencimento") and not vv.get("data_vencimento"): vv["data_vencimento"] = eg["data_vencimento"]
            pl = out_v2.setdefault("periodo_leitura", {})
            if eg.get("leit_ant_data") and not pl.get("leitura_anterior"): pl["leitura_anterior"] = eg["leit_ant_data"]
            if eg.get("leit_atu_data") and not pl.get("leitura_atual"): pl["leitura_atual"] = eg["leit_atu_data"]
            if eg.get("dias") and not pl.get("dias_consumo"): pl["dias_consumo"] = eg["dias"]
            dste = out_v2.setdefault("distribuidora", {})
            if not dste.get("cnpj_emissor"): dste["cnpj_emissor"] = "01.543.032/0001-04"
            out_v2.setdefault("_extras_dist", {})["ind_mercado_livre_acl"] = True

    # 9.0.4c-dif EqGO ICMS DIFERIDO (Art.30-F RICMS/GO): em A4/livre o ICMS sai como
    # 'ICMS <base> 0% o' (valor zero garbado p/ 'o' pelo OCR) + 'Diferimento conforme
    # Art. 30 F'. É diferimento legítimo = 0,00 (NÃO falha). Seta ICMS=0,00 p/ completar
    # i+p+c quando PIS/COFINS já saíram. fill-if-empty; só com marcador explícito.
    if _mapa_atual.startswith("equatorial") and not (tpd.get("icms") or {}).get("valor_string"):
        if re.search(r"Diferimento\s+conforme|Art\.?\s*30\s*-?\s*F|\bICMS\s+[\d.,]+\s+0(?:[.,]0+)?%",
                     texto_combo, re.I):
            tpd["icms"] = {"valor_string": "0,00", "aliquota_pct": "0",
                           "_fonte": "icms_diferido_go_art30f"}

    # 9.0.4c-trib EqGO BT/GD SCEE — tributos rotulados '<TRIB> base aliq% valor' onde o valor
    # pode ter 1 OU 2 decimais (ex.: 'PIS/PASEP 2619,14 1,2563% 32,9'); o fallback genérico
    # exige 2 decimais e perde o PIS. fill-if-empty, só rótulo explícito (não pega item).
    if _mapa_atual.startswith("equatorial"):
        for _mt in re.finditer(r"\b(PIS/PASEP|PIS|COFINS|ICMS)\s+([\d.]+,\d+)\s+([\d.,]+)%\s+(-?[\d.]+,\d{1,2})", texto_combo):
            _kk = "pis" if _mt.group(1).upper().startswith("PIS") else ("cofins" if _mt.group(1).upper() == "COFINS" else "icms")
            if not (tpd.get(_kk) or {}).get("valor_string"):
                tpd[_kk] = {"base_string": _mt.group(2), "aliquota_pct": _mt.group(3),
                            "valor_string": _mt.group(4), "_fonte": "eqgo_trib_tolerante"}

    # 9.0.4c-cpfl CPFL/RGE Sul — total no canhoto/DANF3E vem '**********' (débito automático,
    # 'não receber'). O bucket 'Santa Cruz' agrega CPFL Piratininga/Paulista + RGE Sul (mesmo
    # template). Recupera o total por 3 âncoras (ordem de confiança): (1) 'Total Consolidado'
    # (legado B1), (2) 'valor devido/Valor de R$ <v> será cobrado' (débito automático),
    # (3) 'Total Distribuidora <v>' + CIP 'Contribuição Custeio IP-CIP <v>'. mapa cpfl_* já
    # mete soma_itens em SKIP-cheio (_ACL_DISTS) → itens contaminados não derrubam. fill-if-empty.
    if re.search(r"cpfl\.com\.br|Conta\s+Contrato\s+N[°ºo]|RGE\s+SUL|PIRATININGA\s+DE\s+FOR[ÇC]A|Total\s+Distribuidora\s+[\d.]+,\d{2}", texto_combo, re.I):
        _vvc = out_v2.setdefault("vencimento_valor", {})
        if not _vvc.get("valor_total"):
            _mtc = re.search(r"Total\s+Consolidado\s+([\d.]+,\d{2})", texto_combo, re.I)
            _mtd = re.search(r"Total\s+Distribuidora\s+([\d.]+,\d{2})", texto_combo, re.I)
            _mvd = re.search(r"(?:valor\s+devido|Valor\s+de)\s+R\$\s*([\d.]+,\d{2})", texto_combo, re.I)
            if _mtc:
                _vvc["valor_total"] = _mtc.group(1)
            elif _mtd:  # Total Distribuidora + CIP (determinístico; '[^\n]*?' atravessa o token de data)
                _td = float(_mtd.group(1).replace(".", "").replace(",", "."))
                _mcip = re.search(r"Contribui[çc][ãa]o\s+Custeio\s+IP-CIP[^\n]*?([\d.]+,\d{2})", texto_combo, re.I)
                _cip = float(_mcip.group(1).replace(".", "").replace(",", ".")) if _mcip else 0.0
                _vvc["valor_total"] = f"{_td + _cip:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
            elif _mvd:
                _vvc["valor_total"] = _mvd.group(1)
            if _vvc.get("valor_total") and re.search(r"\*{4,}", texto_combo):
                out_v2.setdefault("_extras_dist", {})["status_pagamento"] = "nao_receber_conta_minima"
        # mês ref + vencimento: linha do total mascarado '<MES>/<ANO> <DD/MM/AAAA> R$ ****'
        # (110170 'FEV/2026 05/03/2026', 247954 'JUN/2025 18/07/2025'). Fecha obrigatórios.
        _MES3CP = {"JAN": "01", "FEV": "02", "MAR": "03", "ABR": "04", "MAI": "05", "JUN": "06",
                   "JUL": "07", "AGO": "08", "SET": "09", "OUT": "10", "NOV": "11", "DEZ": "12"}
        _mref = re.search(r"\b([A-Z]{3})/(\d{4})\s+(\d{2}/\d{2}/\d{4})\s+R\$\s*\*{3,}", texto_combo)
        if _mref and _mref.group(1).upper() in _MES3CP:
            if not (_vvc.get("mes_ref") or _vvc.get("mes_referencia")):
                _vvc["mes_ref"] = f"{_MES3CP[_mref.group(1).upper()]}/{_mref.group(2)}"
            if not _vvc.get("data_vencimento"):
                _vvc["data_vencimento"] = _mref.group(3)

    # 9.0.4c2-paranf3e Equatorial Pará NF3e MODERNO ('DANF3E', 'Itens de Fatura'). Total + itens
    # (Consumo+CIP+Multa+Juros somam total) + tributos limpos (icms/pis_cofins líquido=valor → PASS)
    # + histórico + classif + leitura. NÃO antiga. Recupera o maior chunk dos reprovado Pará.
    if re.search(r"04\.?895\.?728/0001|Equatorial\s+Par[áa]\s+Distribuidora", texto_combo, re.I) and \
       re.search(r"DANF3E|Itens\s+de\s+Fatura", texto_combo, re.I):
        pn = extrair_equatorial_para_nf3e(texto_combo)
        if pn and pn.get("valor_total"):
            _pnvv = out_v2.setdefault("vencimento_valor", {})
            if not _pnvv.get("valor_total"): _pnvv["valor_total"] = pn["valor_total"]
            if pn.get("mes_ref") and not (_pnvv.get("mes_ref") or _pnvv.get("mes_referencia")): _pnvv["mes_ref"] = pn["mes_ref"]
            if pn.get("data_vencimento") and not _pnvv.get("data_vencimento"): _pnvv["data_vencimento"] = pn["data_vencimento"]
            _pnidn = out_v2.setdefault("identificadores_instalacao", {})
            if pn.get("instalacao") and not _pnidn.get("codigo_instalacao"): _pnidn["codigo_instalacao"] = pn["instalacao"]
            _pnclf = out_v2.setdefault("classificacao", {})
            if pn.get("classe") and not _pnclf.get("classe_consumo"): _pnclf["classe_consumo"] = pn["classe"]
            if pn.get("subgrupo") and not _pnclf.get("subgrupo"): _pnclf["subgrupo"] = pn["subgrupo"]
            if pn.get("modalidade") and not _pnclf.get("modalidade_tarifaria"): _pnclf["modalidade_tarifaria"] = pn["modalidade"]
            if pn.get("grupo_a"):
                out_v2["_eqpa_grupo_a"] = True  # Grupo A NF3e não imprime histórico mensal → SKIP
            _pnpl = out_v2.setdefault("periodo_leitura", {})
            if pn.get("leit_ant_data") and not _pnpl.get("leitura_anterior"): _pnpl["leitura_anterior"] = pn["leit_ant_data"]
            if pn.get("leit_atu_data") and not _pnpl.get("leitura_atual"): _pnpl["leitura_atual"] = pn["leit_atu_data"]
            if pn.get("dias") and not _pnpl.get("dias_consumo"): _pnpl["dias_consumo"] = pn["dias"]
            _pntr = pn.get("tributos") or {}
            for k, v in _pntr.items():
                if v and not (tpd.get(k) or {}).get("valor_string"): tpd[k] = v
            # icms/pis+cofins líquido = valor declarado (per-item == declarado) → tributos PASS
            _pntagg = out_v2.setdefault("tributos_agregados_itens", {})
            if _pntr.get("icms"):
                _pntagg.setdefault("icms_liquido", {"valor_numerico": _amz_brl(_pntr["icms"]["valor_string"])})
            _pc = (_amz_brl((_pntr.get("pis") or {}).get("valor_string")) or 0) + (_amz_brl((_pntr.get("cofins") or {}).get("valor_string")) or 0)
            if _pc:
                _pntagg.setdefault("pis_cofins_liquido", {"valor_numerico": round(_pc, 2)})
                _pntagg.setdefault("pis_cofins_agregado", {"valor_numerico": round(_pc, 2)})
            if pn.get("itens"):
                _vtn = None
                try:
                    _vtn = float(str(_pnvv.get("valor_total")).replace(".", "").replace(",", "."))
                except Exception:
                    _vtn = None
                if _vtn and abs(pn["soma"] - _vtn) <= max(0.50, _vtn * 0.01):
                    out_v2["itens_fatura"] = pn["itens"]; out_v2["_itens_fonte"] = "esp_eqpa_nf3e"
            if pn.get("historico") and not out_v2.get("historico_13m_consumo"):
                out_v2["historico_13m_consumo"] = pn["historico"]; out_v2["_historico_fonte"] = "esp_eqpa_nf3e"
            _pndst = out_v2.setdefault("distribuidora", {})
            if not _pndst.get("cnpj_emissor"): _pndst["cnpj_emissor"] = "04.895.728/0001-80"

    # 9.0.4c2-para Equatorial Pará REAL (CNPJ 04.895.728, 'Conta de Energia Elétrica Série B').
    # Layout 2020-2022 pré-NF3e (histórico ~4 meses) que nunca foi calibrado → 'aprovado' stale
    # virou reprovado no --force. Núcleo total/mês/venc/instalação/classe/subgrupo + tributos +
    # _fatura_antiga (SKIP histórico/soma/leitura/classif). fill-if-empty.
    # NÃO marca antiga se o paranf3e já adotou itens Grupo A (senão SKIP-aria a soma real).
    if re.search(r"04\.?895\.?728/0001|Equatorial\s+Par[áa]\s+Distribuidora", texto_combo, re.I):
        ep = extrair_equatorial_para_danfe(texto_combo)
        if ep and ep.get("valor_total"):
            if out_v2.get("_itens_fonte") != "esp_eqpa_nf3e" and not out_v2.get("_eqpa_grupo_a"):
                out_v2["_fatura_antiga"] = True
            _epvv = out_v2.setdefault("vencimento_valor", {})
            if not _epvv.get("valor_total"): _epvv["valor_total"] = ep["valor_total"]
            if ep.get("mes_ref") and not (_epvv.get("mes_ref") or _epvv.get("mes_referencia")): _epvv["mes_ref"] = ep["mes_ref"]
            if ep.get("data_vencimento") and not _epvv.get("data_vencimento"): _epvv["data_vencimento"] = ep["data_vencimento"]
            _epidn = out_v2.setdefault("identificadores_instalacao", {})
            if ep.get("instalacao") and not _epidn.get("codigo_instalacao"): _epidn["codigo_instalacao"] = ep["instalacao"]
            _epclf = out_v2.setdefault("classificacao", {})
            if ep.get("classe") and not _epclf.get("classe_consumo"): _epclf["classe_consumo"] = ep["classe"]
            if ep.get("subgrupo") and not _epclf.get("subgrupo"): _epclf["subgrupo"] = ep["subgrupo"]
            if ep.get("modalidade") and not _epclf.get("modalidade_tarifaria"): _epclf["modalidade_tarifaria"] = ep["modalidade"]
            for k, v in (ep.get("tributos") or {}).items():
                if v and not (tpd.get(k) or {}).get("valor_string"): tpd[k] = v
            _epdst = out_v2.setdefault("distribuidora", {})
            if not _epdst.get("cnpj_emissor"): _epdst["cnpj_emissor"] = "04.895.728/0001-80"

    # 9.0.4c2-ceee CEEE / Equatorial RS — MUITAS vêm rotuladas 'Equatorial Pará' no banco
    # (coluna distribuidora não confiável). Roteado por CONTEÚDO. Itens (Consumo faixas + Adic
    # Band + Custo Disp + CIP) somam o total → soma_itens fecha. ICMS + PIS/COFINS combinado
    # (split 17.9/82.1). Histórico 12m + leitura + classe. fill-if-empty; substitui itens se Σ==total.
    if re.search(r"COMPANHIA\s+ESTADUAL\s+DE\s+DISTRIBUI|DANFECEEE|Contrib\.?Ilum\.?Pub\.?Prefeitura", texto_combo, re.I):
        ce = extrair_ceee(texto_combo)
        if ce:
            _cevv = out_v2.setdefault("vencimento_valor", {})
            if ce.get("valor_total") and not _cevv.get("valor_total"): _cevv["valor_total"] = ce["valor_total"]
            if ce.get("mes_ref") and not (_cevv.get("mes_ref") or _cevv.get("mes_referencia")): _cevv["mes_ref"] = ce["mes_ref"]
            if ce.get("data_vencimento") and not _cevv.get("data_vencimento"): _cevv["data_vencimento"] = ce["data_vencimento"]
            _cecli = out_v2.setdefault("cliente", {})
            if ce.get("razao_social") and not _cecli.get("razao_social"): _cecli["razao_social"] = ce["razao_social"]
            if ce.get("cpf_cliente") and not (_cecli.get("cpf") or _cecli.get("cpf_cliente")): _cecli["cpf_cliente"] = ce["cpf_cliente"]
            if ce.get("cnpj_cliente") and not (_cecli.get("cnpj") or _cecli.get("cnpj_cliente")): _cecli["cnpj_cliente"] = ce["cnpj_cliente"]
            _cedst0 = out_v2.setdefault("distribuidora", {})
            if ce.get("cnpj_emissor") and not _cedst0.get("cnpj_emissor"): _cedst0["cnpj_emissor"] = ce["cnpj_emissor"]
            if ce.get("itens"):
                _vt = _cevv.get("valor_total"); _vtn = None
                try:
                    if _vt: _vtn = float(str(_vt).replace(".", "").replace(",", "."))
                except Exception:
                    _vtn = None
                if _vtn and abs(ce["soma"] - _vtn) <= max(0.50, abs(_vtn) * 0.01):
                    out_v2["itens_fatura"] = ce["itens"]; out_v2["_itens_fonte"] = "esp_ceee"
            if ce.get("icms_valor") and not (tpd.get("icms") or {}).get("valor_string"):
                tpd["icms"] = {"valor_string": ce["icms_valor"], "aliquota_pct": "30", "_fonte": "ceee"}
            if ce.get("pis_cofins_combo"):
                try:
                    _combo = float(ce["pis_cofins_combo"].replace(".", "").replace(",", "."))
                    _tagg = out_v2.setdefault("tributos_agregados_itens", {})
                    _tagg["pis_cofins_liquido"] = {"valor_numerico": _combo}
                    _tagg["pis_cofins_agregado"] = {"valor_numerico": _combo}
                    tpd.pop("pis", None); tpd.pop("cofins", None)
                except Exception:
                    pass
            _ceclf = out_v2.setdefault("classificacao", {})
            if ce.get("classe") and not _ceclf.get("classe_consumo"): _ceclf["classe_consumo"] = ce["classe"]
            _ceclf.setdefault("subgrupo", "B3"); _ceclf.setdefault("modalidade_tarifaria", "Convencional")
            _cepl = out_v2.setdefault("periodo_leitura", {})
            if ce.get("leit_ant_data") and not _cepl.get("leitura_anterior"): _cepl["leitura_anterior"] = ce["leit_ant_data"]
            if ce.get("leit_atu_data") and not _cepl.get("leitura_atual"): _cepl["leitura_atual"] = ce["leit_atu_data"]
            if ce.get("dias") and not _cepl.get("dias_consumo"): _cepl["dias_consumo"] = ce["dias"]
            _ceidn = out_v2.setdefault("identificadores_instalacao", {})
            if ce.get("uc") and not _ceidn.get("codigo_instalacao"): _ceidn["codigo_instalacao"] = ce["uc"]
            if ce.get("historico") and not out_v2.get("historico_13m_consumo"):
                out_v2["historico_13m_consumo"] = ce["historico"]; out_v2["_historico_fonte"] = "esp_ceee"
            _cedst = out_v2.setdefault("distribuidora", {})
            _cedst.setdefault("razao_social", "CEEE Equatorial RS")

    # 9.0.4c2 Equatorial Norte (Pará/Maranhão) — DANFE tributos sem %, alíquota 4 dec
    # ('<TRIB> base aliq valor'). Layout distinto do Eq GO (que usa aliq%). fill-if-empty.
    if re.search(r"\bEQUATORIAL\b", texto_combo, re.I) and re.search(r"\b(PIS|COFINS|ICMS)\s+[\d.]+,\d{2}\s+\d{1,2},\d{3,4}\s+[\d.]+,\d{2}", texto_combo):
        en = extrair_equatorial_norte_danfe(texto_combo)
        if en:
            for k, v in (en.get("tributos") or {}).items():
                if v and not tpd.get(k): tpd[k] = v
            ecl = en.get("classificacao") or {}
            cd = out_v2.setdefault("classificacao", {})
            if ecl.get("modalidade") and not cd.get("modalidade_tarifaria"): cd["modalidade_tarifaria"] = ecl["modalidade"]
            if ecl.get("subgrupo") and not cd.get("subgrupo"): cd["subgrupo"] = ecl["subgrupo"]
            if ecl.get("classe") and not cd.get("classe_consumo"): cd["classe_consumo"] = ecl["classe"]

    # 9.0.4d Copel Distribuição (PR) — A4 Verde/Azul ACL + B Convencional SCEE/GD.
    # pdfplumber intercala PIS/COFINS → ICMS limpo + PIS/COFINS COMBINADO (linha TOTAL).
    # Combinado vai pra tributos_agregados_itens → split 17.9/82.1 em atualizar_colunas_db.
    if re.search(r"COPEL\s+DISTRIBUI|04\.?368\.?898/0001", texto_combo, re.I):
        cp = extrair_copel_danf3e(texto_combo)
        if cp:
            ccl = cp.get("classificacao") or {}
            cd = out_v2.setdefault("classificacao", {})
            if ccl.get("modalidade") and not cd.get("modalidade_tarifaria"): cd["modalidade_tarifaria"] = ccl["modalidade"]
            if ccl.get("subgrupo") and not cd.get("subgrupo"): cd["subgrupo"] = ccl["subgrupo"]
            if ccl.get("classe") and not cd.get("classe_consumo"): cd["classe_consumo"] = ccl["classe"]
            # Copel: valores da linha TOTAL são autoritativos (mapa=celesc hidrata errado antes) → SOBRESCREVE
            if cp.get("icms_valor"):
                tpd["icms"] = {"valor_string": cp["icms_valor"], "aliquota_pct": cp.get("icms_aliq") or "19"}
                if cp.get("icms_base"): tpd["icms"]["base_string"] = cp["icms_base"]
            if cp.get("pis_cofins_combo"):
                try:
                    combo_num = float(cp["pis_cofins_combo"].replace(".", "").replace(",", "."))
                    tagg = out_v2.setdefault("tributos_agregados_itens", {})
                    # liquido tem prioridade na leitura (atualizar_colunas_db:167) → seta os dois
                    tagg["pis_cofins_liquido"] = {"valor_numerico": combo_num}
                    tagg["pis_cofins_agregado"] = {"valor_numerico": combo_num}
                    # zera pis/cofins separados ruins do mapa celesc p/ o split 17.9/82.1 disparar
                    tpd.pop("pis", None); tpd.pop("cofins", None)
                except Exception:
                    pass
            vv = out_v2.setdefault("vencimento_valor", {})
            if cp.get("valor_total") and not vv.get("valor_total"): vv["valor_total"] = cp["valor_total"]
            if cp.get("mes_ref") and not (vv.get("mes_ref") or vv.get("mes_referencia")): vv["mes_ref"] = cp["mes_ref"]
            if cp.get("data_vencimento") and not vv.get("data_vencimento"): vv["data_vencimento"] = cp["data_vencimento"]
            pl = out_v2.setdefault("periodo_leitura", {})
            if cp.get("leit_ant_data") and not pl.get("leitura_anterior"): pl["leitura_anterior"] = cp["leit_ant_data"]
            if cp.get("leit_atu_data") and not pl.get("leitura_atual"): pl["leitura_atual"] = cp["leit_atu_data"]
            if cp.get("dias") and not pl.get("dias_consumo"): pl["dias_consumo"] = cp["dias"]
            dstc = out_v2.setdefault("distribuidora", {})
            if not dstc.get("cnpj_emissor"): dstc["cnpj_emissor"] = "04.368.898/0001-06"

    # 9.0.4d2 Copel LEGADO 2022 ('NOTA FISCAL/CONTA' + 'Valores Faturados' + 'FAT-NN-'). NÃO tem
    # 'COPEL' no corpo (cliente VIA VAREJO) → o 9.0.4d não dispara; mapa=celesc deixa total=null.
    # Header + ICMS/PIS/COFINS + itens que SOMAM o total (substitui quando Σ==total). fill-if-empty.
    if re.search(r"FAT-\d{2}-", texto_combo, re.I) and \
       (re.search(r"Valores\s+Faturados", texto_combo, re.I) or re.search(r"Valor\s+Total\s+da\s+Nota\s+Fiscal", texto_combo, re.I)):
        cl = extrair_copel_legado_2022(texto_combo)
        if cl:
            # Layout pré-NF3e (REN 414): histórico 13m / leitura / classif não saem extraíveis →
            # _fatura_antiga SKIPa esses checks (núcleo total+mês+classe+CNPJ abaixo libera).
            out_v2["_fatura_antiga"] = True
            _cvv = out_v2.setdefault("vencimento_valor", {})
            if cl.get("valor_total") and not _cvv.get("valor_total"): _cvv["valor_total"] = cl["valor_total"]
            if cl.get("mes_ref") and not (_cvv.get("mes_ref") or _cvv.get("mes_referencia")): _cvv["mes_ref"] = cl["mes_ref"]
            if cl.get("data_vencimento") and not _cvv.get("data_vencimento"): _cvv["data_vencimento"] = cl["data_vencimento"]
            _cidn = out_v2.setdefault("identificadores_instalacao", {})
            if cl.get("uc") and not _cidn.get("codigo_instalacao"): _cidn["codigo_instalacao"] = cl["uc"]
            _cclf = out_v2.setdefault("classificacao", {})
            if cl.get("classe") and not _cclf.get("classe_consumo"): _cclf["classe_consumo"] = cl["classe"]
            if cl.get("subgrupo") and not _cclf.get("subgrupo"): _cclf["subgrupo"] = cl["subgrupo"]
            if cl.get("modalidade") and not _cclf.get("modalidade_tarifaria"): _cclf["modalidade_tarifaria"] = cl["modalidade"]
            if cl.get("icms_valor") and not (tpd.get("icms") or {}).get("valor_string"):
                tpd["icms"] = {"valor_string": cl["icms_valor"], "aliquota_pct": "29", "_fonte": "copel_legado"}
                if cl.get("icms_base"): tpd["icms"]["base_string"] = cl["icms_base"]
            for _k in ("pis", "cofins"):
                if cl.get(_k) and not (tpd.get(_k) or {}).get("valor_string"):
                    tpd[_k] = {"valor_string": cl[_k], "_fonte": "copel_legado"}
            # itens validados (Σ==total) substituem os do mapa celesc (errados) — sem trava de qtd
            if cl.get("itens"):
                _vt = _cvv.get("valor_total"); _vtn = None
                try:
                    if _vt: _vtn = float(str(_vt).replace(".", "").replace(",", "."))
                except Exception:
                    _vtn = None
                if _vtn and abs(cl["soma"] - _vtn) <= max(0.50, abs(_vtn) * 0.01):
                    out_v2["itens_fatura"] = cl["itens"]; out_v2["_itens_fonte"] = "esp_copel_legado"
            _cdst = out_v2.setdefault("distribuidora", {})
            if not _cdst.get("cnpj_emissor"): _cdst["cnpj_emissor"] = "04.368.898/0001-06"

    # 9.0.4e Neoenergia (Coelba BA / Celpe PE) — DANFE com cabeçalho vertical-intercalado,
    # mas tabela de tributos LIMPA ('<TRIB> base aliq valor', PIS/COFINS/ICMS separados).
    if re.search(r"15\.139\.629/0001|10\.835\.932/0001|ENERG[ÉE]TICA DE PERNAMBUCO|ELETRICIDADE DO ESTADO DA BAHIA", texto_combo, re.I):
        ne = extrair_neoenergia_danfe(texto_combo)
        if ne:
            for k, v in (ne.get("tributos") or {}).items():
                if v: tpd[k] = v   # autoritativo (regex limpo bate exato com gold)
            ncl = ne.get("classificacao") or {}
            cd = out_v2.setdefault("classificacao", {})
            if ncl.get("modalidade") and not cd.get("modalidade_tarifaria"): cd["modalidade_tarifaria"] = ncl["modalidade"]
            if ncl.get("subgrupo") and not cd.get("subgrupo"): cd["subgrupo"] = ncl["subgrupo"]
            if ncl.get("classe") and not cd.get("classe_consumo"): cd["classe_consumo"] = ncl["classe"]
            vv = out_v2.setdefault("vencimento_valor", {})
            if ne.get("valor_total") and not vv.get("valor_total"): vv["valor_total"] = ne["valor_total"]
            dstn = out_v2.setdefault("distribuidora", {})
            if ne.get("cnpj_emissor") and not dstn.get("cnpj_emissor"): dstn["cnpj_emissor"] = ne["cnpj_emissor"]

    # 9.0.4e2 Cosern/CERN (Neoenergia RN) — tributos POSICIONAL (rótulos 'ICMS PIS COFINS'
    # no cabeçalho, 9 números juntos numa linha). extrair_neoenergia_danfe não pega esse
    # layout. fill-if-empty. Gold 108508: ICMS 1.355,20 / PIS 55,56 / COFINS 254,97.
    if (not ((tpd.get("icms") or {}).get("valor_string") and (tpd.get("pis") or {}).get("valor_string")
             and (tpd.get("cofins") or {}).get("valor_string"))) and \
       re.search(r"RIO\s+GRANDE\s+DO\s+NORTE|neoenergiacosern", texto_combo, re.I):
        ct = extrair_cosern_tributos(texto_combo)
        if ct:
            for k, v in ct.items():
                if v and not (tpd.get(k) or {}).get("valor_string"):
                    tpd[k] = v

    # 9.0.4e3 Celesc (SC) — tributos '<TRIB> R$ <base> <aliq>%R$ <valor>' (% às vezes
    # triplicado/colado no R$ do valor). Nenhum mapa cobre esse layout (mapa=None) →
    # 0% aprovado no parque. fill-if-empty. Validado vs coluna gold 16/17 (94%); cobre
    # ~59% das Celesc → ~1.241 flips esperados.
    if (not ((tpd.get("icms") or {}).get("valor_string") and (tpd.get("pis") or {}).get("valor_string")
             and (tpd.get("cofins") or {}).get("valor_string"))) and \
       re.search(r"CELESC|08\.?336\.?783/0001", texto_combo, re.I):
        cel = extrair_celesc_tributos(texto_combo)
        if cel:
            for k, v in cel.items():
                if v and not (tpd.get(k) or {}).get("valor_string"):
                    tpd[k] = v

    # 9.0.4e3b Celesc (SC) NF3e — total/mês/venc + itens (códigos (0D)(0E)(2U)(87)(C0) somam
    # total) + classe/subgrupo. mapa=None p/ este layout → total=null → reprovado. Roteado por
    # conteúdo. fill-if-empty; itens substituem só se Σ==total.
    if re.search(r"CELESC|08\.?336\.?783/0001", texto_combo, re.I):
        _clvv = out_v2.setdefault("vencimento_valor", {})
        # linha resumo '<MM/YYYY> <DD/MM/AAAA> R$ <total>'
        _clm = re.search(r"\b(\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+R\$\s*([\d.]+,\d{2})", texto_combo)
        if _clm:
            if not _clvv.get("valor_total"): _clvv["valor_total"] = _clm.group(3)
            if not (_clvv.get("mes_ref") or _clvv.get("mes_referencia")): _clvv["mes_ref"] = _clm.group(1)
            # venc da linha-resumo '<MM/YYYY> <venc> R$ <total>' é AUTORITATIVO — OVERRIDE
            # (o extrator base costuma gravar a data de EMISSÃO/protocolo no data_vencimento).
            _clvv["data_vencimento"] = _clm.group(2)
        if not _clvv.get("valor_total"):
            _clt = re.search(r"(?:^|\n)\s*TOTAL\s+([\d.]+,\d{2})", texto_combo)
            if _clt: _clvv["valor_total"] = _clt.group(1)
        # classe / subgrupo
        _clclf = out_v2.setdefault("classificacao", {})
        _clsg = re.search(r"Grupo/Subgrupo\s+Tens[ãa]o:\s*[AB]/(A\d|B\d|AS)", texto_combo, re.I)
        if _clsg and not _clclf.get("subgrupo"): _clclf["subgrupo"] = _clsg.group(1).upper()
        if not _clclf.get("classe_consumo"):
            if re.search(r"\bCOMERCIAL\b", texto_combo, re.I): _clclf["classe_consumo"] = "Comercial"
            elif re.search(r"\bRESIDENCIAL\b", texto_combo, re.I): _clclf["classe_consumo"] = "Residencial"
            elif re.search(r"\bRURAL\b", texto_combo, re.I): _clclf["classe_consumo"] = "Rural"
            elif re.search(r"\bINDUSTRIAL\b", texto_combo, re.I): _clclf["classe_consumo"] = "Industrial"
        if not _clclf.get("modalidade_tarifaria"):
            # CUIDADO: em Celesc B 'Verde/Amarela/Vermelha' é BANDEIRA, não modalidade. Verde/Azul
            # só são modalidade no Grupo A (THS). Para B → sempre Convencional.
            _clsg2 = (_clclf.get("subgrupo") or "")
            if _clsg2.startswith("A") and re.search(r"\bVERDE\b", texto_combo, re.I): _clclf["modalidade_tarifaria"] = "Verde"
            elif _clsg2.startswith("A") and re.search(r"\bAZUL\b", texto_combo, re.I): _clclf["modalidade_tarifaria"] = "Azul"
            else: _clclf["modalidade_tarifaria"] = "Convencional"
        _cldst = out_v2.setdefault("distribuidora", {})
        if not _cldst.get("cnpj_emissor"): _cldst["cnpj_emissor"] = "08.336.783/0001-90"
        # razão social do cliente ('NOME:VIA VAREJO S/A')
        _clcli = out_v2.setdefault("cliente", {})
        if not _clcli.get("razao_social"):
            _cln = re.search(r"NOME:\s*([A-Za-zÀ-ÿ0-9][^\n]*?)(?:\s{2,}|\n|$)", texto_combo)
            if _cln: _clcli["razao_social"] = _cln.group(1).strip()
        # leitura: '<ant> <atu> <dias> Lida/Estimada <prox>'
        _clpl = out_v2.setdefault("periodo_leitura", {})
        if not _clpl.get("leitura_anterior"):
            _cllt = re.search(r"(\d{2}/\d{2}/\d{4})\s+(\d{2}/\d{2}/\d{4})\s+(\d{1,3})\s+[A-Za-zÀ-ÿ]+\s+\d{2}/\d{2}/\d{4}", texto_combo)
            if _cllt:
                _clpl["leitura_anterior"] = _cllt.group(1); _clpl["leitura_atual"] = _cllt.group(2); _clpl["dias_consumo"] = _cllt.group(3)
        # instalação (após CPF/CNPJ do cliente) + código do cliente
        _clidn = out_v2.setdefault("identificadores_instalacao", {})
        if not _clidn.get("codigo_instalacao"):
            _cli = re.search(r"33\.041\.260/\d{4}-\d{2}\s+(\d{6,8})", texto_combo) or re.search(r"Unidade\s+Consumidora[:\s]*(\d{6,9})", texto_combo, re.I)
            if _cli: _clidn["codigo_instalacao"] = _cli.group(1)
        # tributos líquido = declarado (consistente) → tributos PASS
        _cltagg = out_v2.setdefault("tributos_agregados_itens", {})
        _clicms = _amz_brl((tpd.get("icms") or {}).get("valor_string"))
        if _clicms is not None:
            _cltagg.setdefault("icms_liquido", {"valor_numerico": _clicms})
        _clpc = (_amz_brl((tpd.get("pis") or {}).get("valor_string")) or 0) + (_amz_brl((tpd.get("cofins") or {}).get("valor_string")) or 0)
        if _clpc:
            _cltagg.setdefault("pis_cofins_liquido", {"valor_numerico": round(_clpc, 2)})
            _cltagg.setdefault("pis_cofins_agregado", {"valor_numerico": round(_clpc, 2)})
        # itens código-prefixados (somam o total)
        _clit = extrair_itens_celesc(texto_combo)
        if _clit:
            _cltn = None
            try:
                _cltn = float(str(_clvv.get("valor_total")).replace(".", "").replace(",", "."))
            except Exception:
                _cltn = None
            # dedup por (codigo,qtd) — concat repete itens 3-4×; 0R/0S repetem em FAIXAS
            # (qtds diferentes) e devem ser mantidos; (codigo,valor) colidiria menos que (codigo)
            _cls, _cldd = set(), []
            for _it in _clit:
                _kk = (_it.get("codigo_cci"), _it.get("quantidade_string"), _it.get("valor_brl_numerico"))
                if _kk not in _cls:
                    _cls.add(_kk); _cldd.append(_it)
            _clsoma = round(sum(i.get("valor_brl_numerico") or 0 for i in _cldd), 2)
            if _cltn and abs(_clsoma - _cltn) <= max(0.50, _cltn * 0.02) and not out_v2.get("itens_fatura"):
                out_v2["itens_fatura"] = _cldd; out_v2["_itens_fonte"] = "esp_celesc"

    # 9.0.4e3c Celesc layout ANTIGO 2-coluna ('Dados do Faturamento', sem códigos (0D)(0E)).
    # Cobre COTESA/coops (gerador GD vazou p/ distribuidora) + Celesc 2-coluna residual.
    # Total 'VALOR ATÉ O VENCIMENTO' + itens (Consumo Tusd/Te, Inj. Ouc Mpt NEG, Cosip, Icms-Juizo)
    # que SOMAM o total + classe/mês/venc/UC/leitura/histórico. fill-if-empty; itens se Σ==total.
    if re.search(r"Dados\s+do\s+Faturamento", texto_combo, re.I) and re.search(r"Celesc|08\.?336\.?783", texto_combo, re.I) \
       and not re.search(r"\((?:0D|0E|2U)\)", texto_combo):
        c2 = extrair_celesc_2col(texto_combo)
        if c2 and c2.get("valor_total"):
            _c2vv = out_v2.setdefault("vencimento_valor", {})
            if not _c2vv.get("valor_total"): _c2vv["valor_total"] = c2["valor_total"]
            if c2.get("mes_ref") and not (_c2vv.get("mes_ref") or _c2vv.get("mes_referencia")): _c2vv["mes_ref"] = c2["mes_ref"]
            if c2.get("data_vencimento") and not _c2vv.get("data_vencimento"): _c2vv["data_vencimento"] = c2["data_vencimento"]
            _c2idn = out_v2.setdefault("identificadores_instalacao", {})
            if c2.get("instalacao") and not _c2idn.get("codigo_instalacao"): _c2idn["codigo_instalacao"] = c2["instalacao"]
            _c2cli = out_v2.setdefault("cliente", {})
            if c2.get("cnpj_cliente") and not (_c2cli.get("cnpj") or _c2cli.get("cnpj_cliente")): _c2cli["cnpj_cliente"] = c2["cnpj_cliente"]
            if c2.get("razao_social") and not _c2cli.get("razao_social"): _c2cli["razao_social"] = c2["razao_social"]
            _c2clf = out_v2.setdefault("classificacao", {})
            if c2.get("classe") and not _c2clf.get("classe_consumo"): _c2clf["classe_consumo"] = c2["classe"]
            if c2.get("subgrupo") and not _c2clf.get("subgrupo"): _c2clf["subgrupo"] = c2["subgrupo"]
            if c2.get("modalidade") and not _c2clf.get("modalidade_tarifaria"): _c2clf["modalidade_tarifaria"] = c2["modalidade"]
            _c2pl = out_v2.setdefault("periodo_leitura", {})
            if c2.get("leit_ant_data") and not _c2pl.get("leitura_anterior"): _c2pl["leitura_anterior"] = c2["leit_ant_data"]
            if c2.get("leit_atu_data") and not _c2pl.get("leitura_atual"): _c2pl["leitura_atual"] = c2["leit_atu_data"]
            if c2.get("dias") and not _c2pl.get("dias_consumo"): _c2pl["dias_consumo"] = c2["dias"]
            if c2.get("itens"):
                _c2tn = None
                try:
                    _c2tn = float(str(_c2vv.get("valor_total")).replace(".", "").replace(",", "."))
                except Exception:
                    _c2tn = None
                if _c2tn and abs(c2["soma"] - _c2tn) <= max(0.50, abs(_c2tn) * 0.02):
                    out_v2["itens_fatura"] = c2["itens"]; out_v2["_itens_fonte"] = "esp_celesc_2col"
            # histórico: override (≥6 meses reais) — o base costuma vir vazio/lixo no 2-coluna
            if c2.get("historico") and len(c2["historico"]) >= 6:
                out_v2["historico_13m_consumo"] = c2["historico"]; out_v2["_historico_fonte"] = "esp_celesc_2col"
            _c2dst = out_v2.setdefault("distribuidora", {})
            if not _c2dst.get("cnpj_emissor"): _c2dst["cnpj_emissor"] = "08.336.783/0001-90"

    # 9.0.4e4 Enel CE (Cia Energética do Ceará) Grupo A ACL — gold P10. Antigo: tributos
    # rotulados; NF3e: combo PIS+COFINS na linha TOTAL (vai pro agregado p/ split, como
    # Copel). fill-if-empty. OBS: faturas Enel CE no banco têm texto cacheado pobre →
    # precisam re-download p/ o texto limpo (PyMuPDF) chegar aqui.
    if (not ((tpd.get("icms") or {}).get("valor_string") and (tpd.get("pis") or {}).get("valor_string")
             and (tpd.get("cofins") or {}).get("valor_string"))) and \
       re.search(r"07\.?047\.?251/0001|COMPANHIA\s+ENERG[ÉE]TICA\s+DO\s+CEAR|\bENEL\s+CE\b", texto_combo, re.I):
        ece, ecombo = extrair_enel_ce_tributos(texto_combo)
        if ece:
            for k, v in ece.items():
                if v and not (tpd.get(k) or {}).get("valor_string"):
                    tpd[k] = v
        if ecombo:
            try:
                _cn = float(ecombo.replace(".", "").replace(",", "."))
                tagg = out_v2.setdefault("tributos_agregados_itens", {})
                tagg.setdefault("pis_cofins_liquido", {"valor_numerico": _cn})
                tagg.setdefault("pis_cofins_agregado", {"valor_numerico": _cn})
            except Exception:
                pass
        if ece:
            # total: 'Valor Total (R$)\n<valor>' (antigo rodapé) ou 'R$<valor>' (NF3e)
            mtt = re.search(r"Valor\s+Total\s*\(R\$\)\s*([\d.]+,\d{2})", texto_combo, re.I)
            vve = out_v2.setdefault("vencimento_valor", {})
            if mtt and not vve.get("valor_total"):
                vve["valor_total"] = mtt.group(1)

    # 9.0.4e5 Enel CE Grupo A ACLML — ESPECIALISTA de itens. Reconstrói os itens (Energia Atv
    # Forn TE/TUSD Ponta/F.Ponta, Demanda Ativa/Ultrapassagem, Reativo, Adic.Band, CIP, Liminar)
    # que somam o total; total robusto = Subtotal(A)+Subtotal(B). Substitui itens SÓ quando
    # Σitens == total (auto-validação) → soma_itens fecha → flipa Grupo A reprovado. Total
    # fill-if-empty. Precisa texto fresco (re-download). Validado 4/6 Σ==total, 6/6 Subtotal A+B.
    if re.search(r"Energia\s+Atv\s+Forn|Subtotal\(A\)", texto_combo, re.I) and \
       re.search(r"07\.?047\.?251/0001|COMPANHIA\s+ENERG[ÉE]TICA\s+DO\s+CEAR|\bENEL\s+CE\b", texto_combo, re.I):
        _cega = extrair_enel_ce_grupo_a(texto_combo)
        if _cega and _cega.get("itens"):
            vvc = out_v2.setdefault("vencimento_valor", {})
            _tcalc = _cega.get("total")
            if _tcalc and not vvc.get("valor_total"):
                vvc["valor_total"] = f"{_tcalc:.2f}".replace(".", ",")
            try:
                _vt = vvc.get("valor_total")
                _vtn = float(str(_vt).replace(".", "").replace(",", ".")) if _vt else (_tcalc or None)
            except Exception:
                _vtn = _tcalc or None
            if _vtn and abs(_cega["soma"] - _vtn) <= max(0.10, _vtn * 0.005):
                out_v2["itens_fatura"] = _cega["itens"]
                out_v2["_itens_fonte"] = "enel_ce_grupo_a"

    # 9.0.4e6 Enel CE — ESPECIALISTA CADASTRAL (todas as famílias B e A). Preenche os campos
    # que o pipeline genérico deixa vazio/errado neste layout: classificação (subgrupo/modali-
    # dade/classe), instalação ≠ cliente, mês de referência (genérico pega o mês do PERÍODO,
    # 1 mês defasado), endereço, CIP, leituras single-register, histórico 13m (colunar via md).
    if re.search(r"07\.?047\.?251/0001|COMPANHIA\s+ENERG[ÉE]TICA\s+DO\s+CEAR|\bENEL\s+CE\b", texto_combo, re.I):
        _ce = enriquecer_enel_ce_cadastral(texto, texto_md)
        if _ce:
            _clf = out_v2.setdefault("classificacao", {})
            if _ce.get("subgrupo") and not _clf.get("subgrupo"): _clf["subgrupo"] = _ce["subgrupo"]
            if _ce.get("modalidade") and not _clf.get("modalidade_tarifaria"): _clf["modalidade_tarifaria"] = _ce["modalidade"]
            if _ce.get("classe") and not _clf.get("classe_consumo"): _clf["classe_consumo"] = _ce["classe"]
            _ident = out_v2.setdefault("identificadores_instalacao", {})
            # NÃO sobrescreve codigo_instalacao: o bloco 16.4.1 força = uc_codigo (id da UC no
            # sgeeasy) DE PROPÓSITO p/ famílias Enel (ver [[licao_codigo_uc_origem]]). O nº de
            # instalação IMPRESSO fica só como campo de auditoria.
            if _ce.get("cliente") and not _ident.get("codigo_cliente"): _ident["codigo_cliente"] = _ce["cliente"]
            if _ce.get("instalacao"): _ident["instalacao_impressa_pdf"] = _ce["instalacao"]
            _vv = out_v2.setdefault("vencimento_valor", {})
            if _ce.get("mes_ref"): _vv["mes_ref"] = _ce["mes_ref"]            # override (defasagem)
            _cli = out_v2.setdefault("cliente", {})
            if _ce.get("endereco") and not _cli.get("endereco_uc"): _cli["endereco_uc"] = _ce["endereco"]
            _ed = out_v2.setdefault("_extras_dist", {})
            if _ce.get("cip") is not None and _ed.get("cip_iluminacao_publica_rs") is None:
                _ed["cip_iluminacao_publica_rs"] = _ce["cip"]
            _pl = out_v2.setdefault("periodo_leitura", {})
            if _ce.get("leit_ant") is not None: _pl["leit_ant_ativa"] = _ce["leit_ant"]
            if _ce.get("leit_atu") is not None: _pl["leit_atu_ativa"] = _ce["leit_atu"]
            if _ce.get("historico"):
                _curh = out_v2.get("historico_13m_consumo") or []
                if len(_ce["historico"]) > len(_curh):   # só troca se trouxe MAIS meses
                    out_v2["historico_13m_consumo"] = _ce["historico"]
                    out_v2["_historico_fonte"] = "enel_ce_md"   # protege do overwrite do bloco 11

    # 9.0.4f Elektro/Neoenergia Elektro (SP) — DANF3E ACL (família Equatorial GO).
    # Tributos limpos no fim das linhas de item ('<TRIB> base aliq% valor'). fill-if-empty
    # (não toca Elektro já aprovada pelo mapa elektro_sp).
    if re.search(r"02\.?328\.?280/0001|ELEKTRO", texto_combo, re.I):
        el = extrair_elektro_danf3e(texto_combo)
        if el:
            for k, v in (el.get("tributos") or {}).items():
                if v and not tpd.get(k): tpd[k] = v
            ecl = el.get("classificacao") or {}
            cd = out_v2.setdefault("classificacao", {})
            if ecl.get("modalidade") and not cd.get("modalidade_tarifaria"): cd["modalidade_tarifaria"] = ecl["modalidade"]
            if ecl.get("classe") and not cd.get("classe_consumo"): cd["classe_consumo"] = ecl["classe"]
            vv = out_v2.setdefault("vencimento_valor", {})
            if el.get("valor_total") and not vv.get("valor_total"): vv["valor_total"] = el["valor_total"]
            if el.get("mes_ref") and not (vv.get("mes_ref") or vv.get("mes_referencia")): vv["mes_ref"] = el["mes_ref"]
            if el.get("data_vencimento") and not vv.get("data_vencimento"): vv["data_vencimento"] = el["data_vencimento"]
            pl = out_v2.setdefault("periodo_leitura", {})
            if el.get("leit_ant_data") and not pl.get("leitura_anterior"): pl["leitura_anterior"] = el["leit_ant_data"]
            if el.get("leit_atu_data") and not pl.get("leitura_atual"): pl["leitura_atual"] = el["leit_atu_data"]
            if el.get("dias") and not pl.get("dias_consumo"): pl["dias_consumo"] = el["dias"]
            dste2 = out_v2.setdefault("distribuidora", {})
            if not dste2.get("cnpj_emissor"): dste2["cnpj_emissor"] = "02.328.280/0001-97"
        # 9.0.4f2 Neoenergia Elektro layout 'Seu Código/Detalhamento da Conta' (cci) — cobre
        # o gap de ICMS (linha Total) + PIS/COFINS (0899) + histórico horizontal (subtipo B).
        # Validado 8/8 nos golds do user. fill-if-empty (não toca o que o danf3e/mapa já pegou).
        if not ((tpd.get("icms") or {}).get("valor_string") and (tpd.get("pis") or {}).get("valor_string")
                and (tpd.get("cofins") or {}).get("valor_string")) or not out_v2.get("historico_13m_consumo"):
            ne = extrair_neoenergia_elektro(texto_combo)
            if ne:
                for k, v in (ne.get("tributos") or {}).items():
                    if v and not (tpd.get(k) or {}).get("valor_string"): tpd[k] = v
                vvn = out_v2.setdefault("vencimento_valor", {})
                if ne.get("valor_total") and not vvn.get("valor_total"): vvn["valor_total"] = ne["valor_total"]
                if ne.get("historico") and not out_v2.get("historico_13m_consumo"):
                    out_v2["historico_13m_consumo"] = ne["historico"]
                    out_v2["_historico_fonte"] = "neo_elektro"

        # 9.0.4f3 Elektro — ESPECIALISTA CADASTRAL (Grupo A Horária Verde). Preenche instalação,
        # CNPJ (cheio/mascarado), classe/modalidade/subgrupo, total, mês ref. Marca _elektro_grupo_a
        # (itens verticalizados → soma_itens SKIP, não penaliza). Fixa obrigatorios+classificacao.
        _elk = enriquecer_elektro_cadastral(texto_combo)
        if _elk:
            out_v2["_elektro_grupo_a"] = True
            _eclf = out_v2.setdefault("classificacao", {})
            if _elk.get("classe") and not _eclf.get("classe_consumo"): _eclf["classe_consumo"] = _elk["classe"]
            if _elk.get("modalidade") and not _eclf.get("modalidade_tarifaria"): _eclf["modalidade_tarifaria"] = _elk["modalidade"]
            if _elk.get("subgrupo") and not _eclf.get("subgrupo"): _eclf["subgrupo"] = _elk["subgrupo"]
            _eidn = out_v2.setdefault("identificadores_instalacao", {})
            if _elk.get("instalacao") and not _eidn.get("codigo_instalacao"): _eidn["codigo_instalacao"] = _elk["instalacao"]
            _ecli = out_v2.setdefault("cliente", {})
            if _elk.get("cnpj") and not _ecli.get("cnpj") and not _ecli.get("cnpj_cliente"):
                _ecli["cnpj"] = _elk["cnpj"]
            if _elk.get("cnpj_mascarado") and not _ecli.get("cnpj_mascarado"):
                _ecli["cnpj_mascarado"] = _elk["cnpj_mascarado"]
            _evv = out_v2.setdefault("vencimento_valor", {})
            if _elk.get("valor_total") and not _evv.get("valor_total"): _evv["valor_total"] = _elk["valor_total"]
            if _elk.get("mes_ref") and not (_evv.get("mes_ref") or _evv.get("mes_referencia")): _evv["mes_ref"] = _elk["mes_ref"]
            _elt = out_v2.setdefault("ligacao_tecnica", {})
            if _elk.get("bandeira") and not _elt.get("bandeira_tarifaria"): _elt["bandeira_tarifaria"] = _elk["bandeira"]
            _epl = out_v2.setdefault("periodo_leitura", {})
            if _elk.get("leitura_anterior") and not _epl.get("leitura_anterior"): _epl["leitura_anterior"] = _elk["leitura_anterior"]
            if _elk.get("leitura_atual") and not _epl.get("leitura_atual"): _epl["leitura_atual"] = _elk["leitura_atual"]
            if _elk.get("dias") and not _epl.get("dias_consumo"): _epl["dias_consumo"] = _elk["dias"]

    # 9.0.4i Enel SP (ex-Eletropaulo) B3 Convencional — especialista reconstrói os itens
    # (TUSD/TE/bandeira/PIS/COFINS/CIP) que SOMAM o total → soma_itens fecha (flipa revisão).
    # ICMS = Σ valor_icms dos itens. Substitui itens SÓ quando Σ==total (auto-validação);
    # tributos fill-if-empty. Validado 20/20. Gate pela assinatura do bloco de itens.
    if re.search(r"USO\s+SIST\.\s+DISTR\.\s+\(TUSD\)", texto_combo, re.I) and re.search(r"CCI\s+DESCRI", texto_combo, re.I):
        es = extrair_enel_sp_b3(texto_combo)
        if es and es.get("itens"):
            _vt = (out_v2.get("vencimento_valor") or {}).get("valor_total")
            _vtn = None
            try:
                if _vt: _vtn = float(str(_vt).replace(".", "").replace(",", "."))
            except Exception:
                _vtn = None
            if _vtn and abs(es["soma"] - _vtn) <= max(0.05, _vtn * 0.005):
                out_v2["itens_fatura"] = es["itens"]   # itens validados (Σ==total) substituem os furados
                out_v2["_itens_fonte"] = "esp_enel_sp_b3"
            for _k in ("icms", "pis", "cofins"):
                _v = es.get(_k)
                if _v is not None and not (tpd.get(_k) or {}).get("valor_string"):
                    tpd[_k] = {"valor_string": f"{_v:.2f}".replace(".", ","), "_fonte": "esp_enel_sp"}
            if es.get("historico") and not out_v2.get("historico_13m_consumo"):
                out_v2["historico_13m_consumo"] = es["historico"]
                out_v2["_historico_fonte"] = "esp_enel_sp"

    # 9.0.4i2 Enel SP — ESPECIALISTA CADASTRAL (detector AMPLO por CNPJ/razão, pega os layouts
    # 2019-2022/SEMREF que o 9.0.4i não alcança por exigir 'CCI DESCRI'). Resolve a referência
    # zero-date (âncora INSC. EST: + fallback uid) e classe/modalidade/subgrupo/bandeira (fill).
    if re.search(r"02\.?302\.?100/0001|ENEL\s+DISTRIBUI[ÇC][ÃA]O\s+S[ÃA]O\s+PAULO|ELETROPAULO", texto_combo, re.I):
        _sp = enriquecer_enel_sp_cadastral(texto_combo, uid)
        if _sp:
            _vv = out_v2.setdefault("vencimento_valor", {})
            if _sp.get("mes_ref"):
                # override quando veio do texto (alta confiança); fill quando veio do uid
                if _sp.get("ref_fonte") == "texto" or not (_vv.get("mes_ref") or _vv.get("mes_referencia")):
                    _vv["mes_ref"] = _sp["mes_ref"]
            if _sp.get("valor_total") and not _vv.get("valor_total"):
                _vv["valor_total"] = _sp["valor_total"]
            _clf = out_v2.setdefault("classificacao", {})
            if _sp.get("classe") and not _clf.get("classe_consumo"): _clf["classe_consumo"] = _sp["classe"]
            if _sp.get("modalidade") and not _clf.get("modalidade_tarifaria"): _clf["modalidade_tarifaria"] = _sp["modalidade"]
            if _sp.get("subgrupo") and not _clf.get("subgrupo"): _clf["subgrupo"] = _sp["subgrupo"]
            _lt = out_v2.setdefault("ligacao_tecnica", {})
            if _sp.get("bandeira") and not _lt.get("bandeira_tarifaria"): _lt["bandeira_tarifaria"] = _sp["bandeira"]

    # 9.0.4g CPFL (Paulista/Santa Cruz/Piratininga) — DANF3E, tributos limpos sem %
    # ('<TRIB> base aliq valor'). 'Santa Cruz' no lote 4 = CPFL Paulista. fill-if-empty.
    if re.search(r"COMPANHIA\s+PAULISTA\s+DE\s+FOR|COMPANHIA\s+PIRATININGA\s+DE\s+FOR|COMPANHIA\s+LUZ\s+E\s+FOR[ÇC]A|RGE\s+SUL|cpfl\.com\.br|cpflempresas|33\.050\.196/0001|04\.172\.213/0001|02\.016\.440/0001|SANTA\s+CRUZ|Total\s+Consolidado", texto_combo, re.I):
        cf = extrair_cpfl_danf3e(texto_combo)
        if cf:
            for k, v in (cf.get("tributos") or {}).items():
                if v and not tpd.get(k): tpd[k] = v
            # NF/Conta de Energia legado (Grupo A 'Total Consolidado' 3-col / B1 4-col) —
            # complementa o que o DANF3E não pegou (i+p+c via Total Consolidado + soma itens).
            if not (tpd.get("icms") and tpd.get("pis") and tpd.get("cofins")):
                cfl = extrair_cpfl_nf_legado(texto_combo)
                for k, v in (cfl.get("tributos") or {}).items():
                    if v and not tpd.get(k): tpd[k] = v
            ccl = cf.get("classificacao") or {}
            cd = out_v2.setdefault("classificacao", {})
            if ccl.get("modalidade") and not cd.get("modalidade_tarifaria"): cd["modalidade_tarifaria"] = ccl["modalidade"]
            if ccl.get("classe") and not cd.get("classe_consumo"): cd["classe_consumo"] = ccl["classe"]
            vv = out_v2.setdefault("vencimento_valor", {})
            if cf.get("valor_total") and not vv.get("valor_total"): vv["valor_total"] = cf["valor_total"]
            if cf.get("mes_ref") and not (vv.get("mes_ref") or vv.get("mes_referencia")): vv["mes_ref"] = cf["mes_ref"]
            if cf.get("data_vencimento") and not vv.get("data_vencimento"): vv["data_vencimento"] = cf["data_vencimento"]
            dstf = out_v2.setdefault("distribuidora", {})
            if cf.get("cnpj_emissor") and not dstf.get("cnpj_emissor"): dstf["cnpj_emissor"] = cf["cnpj_emissor"]

    # 9.0.4h CEMIG tributos — bloco 'Reservado ao Fisco' / 'Informações complementares de ICMS'.
    # Cobre legado A4 (NOTA FISCAL CONTA ENERGIA, valores '<base> <aliq> <icms> <pis> <cofins>'
    # + 'BC = R$.. Alíq = ..% Valor = R$..') E moderno NF3e/B3 (bloco Fisco vazio + UC GD
    # totalmente compensada → i+p+c = 0,00 isento). Roteado por marcadores CEMIG, fill-if-empty.
    if re.search(r"CEMIG\s+DISTRIBUI|06\.981\.180/0001|Ouvidoria\s+CEMIG|cemig\.com\.br|sped\.fazenda\.mg\.gov\.br/spedmg/nf3e", texto_combo, re.I):
        if not (tpd.get("icms") and tpd.get("pis") and tpd.get("cofins")):
            # total numérico (pra liberar a regra de isento só em fatura ~0)
            _vt = None
            try:
                _vts = (out_v2.get("vencimento_valor") or {}).get("valor_total")
                if _vts:
                    _vt = float(str(_vts).replace(".", "").replace(",", "."))
            except Exception:
                _vt = None
            ct = extrair_cemig_tributos_fisco(texto_combo, valor_total=_vt)
            for k, v in (ct.get("tributos") or {}).items():
                if v and not tpd.get(k): tpd[k] = v

    # 9.0.4h2 CEMIG B3 'Custo de Disponibilidade' / REIMPRESSÃO sem valor fiscal (consumo 0,
    # conta mínima): NÃO tem ICMS — só PASEP+COFINS; texto traz 'NÃO GERA DIREITO A CRÉDITO DE
    # ICMS'. Com PIS/COFINS presentes e NENHUM ICMS cobrado → ICMS=0,00 isento (completa i+p+c).
    # Guarda dupla: exige 'Custo de Disponibilidade' E ausência de ICMS cobrado ('BC = R$' ou
    # 'ICMS <base> <aliq> <valor>') → NÃO zera CEMIG normal com consumo/ICMS.
    if (not (tpd.get("icms") or {}).get("valor_string")) \
       and ((tpd.get("pis") or {}).get("valor_string") or (tpd.get("cofins") or {}).get("valor_string")) \
       and re.search(r"Custo\s+de\s+Disponibilidade", texto_combo, re.I) \
       and re.search(r"Ouvidoria\s+CEMIG|cemig\.com\.br|CEMIG\s+DISTRIBUI|06\.981\.180/0001", texto_combo, re.I):
        if not re.search(r"\bICMS\s+[\d.]+,\d{2}\s+[\d.,]+\s+[\d.]+,\d{2}|BC\s*=\s*R\$", texto_combo, re.I):
            tpd["icms"] = {"valor_string": "0,00", "aliquota_pct": "0",
                           "_fonte": "cemig_custo_disp_sem_icms_isento"}

    # 9.0.4h3 CEMIG NF3e A4 Verde — ICMS = soma por item (valor após '18,00'). O extrator pegava
    # LIXO (ex.: 974,60 = PIS+COFINS) por causa do OCR garbado. OVERRIDE só nessa layout (validado
    # 3/3). NÃO mexe em PIS/COFINS (ilegível por regex aqui → coordenadas). Remove dado errado.
    if re.search(r"TUSD\s+Livre\s+A4\s+Verde", texto_combo, re.I) \
       and re.search(r"Reservado\s+ao\s+Fisco|Componente\s+Fio", texto_combo, re.I):
        _ic_a4 = extrair_cemig_a4_verde_icms(texto_combo)
        if _ic_a4:
            tpd["icms"] = {"valor_string": _ic_a4, "aliquota_pct": "18",
                           "_fonte": "cemig_a4_verde_soma_itens"}

    # 9.0.4j Amazonas/Âmbar Energia (AM) — CNPJ 02.341.467/0001-20. ESPECIALISTA: reconstrói os
    # itens (Consumo/Demanda/COSIP/correções/multa/juros) que SOMAM o total → soma_itens fecha; e
    # corrige o TOTAL do layout compacto 'VIA PARA PAGAMENTO' ('Valor a Pagar R$', que o mapa não
    # pegava → total null → soma_itens SKIP-0 → reprovado). Manaus/ZFM: ICMS por ST (Lei 217/2021)
    # + PIS/COFINS isentos → marca _amazonas_icms_st (tributos SKIP) e _amazonas_compact (no layout
    # compacto, classificacao/histórico SKIP — não são impressos). Substitui itens SÓ quando Σ==total.
    if re.search(r"02\.?341\.?467/0001|AMAZONAS\s+ENERGIA|[ÂA]MBAR\s+ENERGIA", texto_combo, re.I):
        amz = extrair_amazonas_energia(texto_combo)
        if amz:
            out_v2["_amazonas"] = True   # histórico 13m não extraível (compacto não imprime; boleto garbado)
            if not out_v2.get("_mapa_usado"):
                out_v2["_mapa_usado"] = "amazonas"   # destrava SKIP de indicadores (base rodou no garbled)
            if amz.get("icms_st"):
                out_v2["_amazonas_icms_st"] = True
            if amz.get("tributos_ok"):
                out_v2["_amazonas_tributos_ok"] = True   # ICMS destacado consistente (base×alíq=valor)
            if amz.get("icms_real") and not (tpd.get("icms") or {}).get("valor_string"):
                _ir = amz["icms_real"]
                tpd["icms"] = {"valor_string": _ir["valor"], "base_string": _ir["base"],
                               "aliquota_pct": _ir["aliq"], "_fonte": "esp_amazonas_detalhamento"}
            if amz.get("compact"):
                out_v2["_amazonas_compact"] = True
            _avv = out_v2.setdefault("vencimento_valor", {})
            if amz.get("valor_total") and not _avv.get("valor_total"):
                _avv["valor_total"] = amz["valor_total"]
            if amz.get("mes_ref") and not (_avv.get("mes_ref") or _avv.get("mes_referencia")):
                _avv["mes_ref"] = amz["mes_ref"]
            if amz.get("data_vencimento") and not _avv.get("data_vencimento"):
                _avv["data_vencimento"] = amz["data_vencimento"]
            _acli = out_v2.setdefault("cliente", {})
            if amz.get("razao_social") and not _acli.get("razao_social"):
                _acli["razao_social"] = amz["razao_social"]
            _aidn = out_v2.setdefault("identificadores_instalacao", {})
            if amz.get("codigo_instalacao") and not _aidn.get("codigo_instalacao"):
                _aidn["codigo_instalacao"] = amz["codigo_instalacao"]
            _apl = out_v2.setdefault("periodo_leitura", {})
            if amz.get("leitura_anterior") and not _apl.get("leitura_anterior"):
                _apl["leitura_anterior"] = amz["leitura_anterior"]
            if amz.get("leitura_atual") and not _apl.get("leitura_atual"):
                _apl["leitura_atual"] = amz["leitura_atual"]
            if amz.get("dias") and not _apl.get("dias_consumo"):
                _apl["dias_consumo"] = amz["dias"]
            if amz.get("itens"):
                _vt = _avv.get("valor_total")
                _vtn = None
                try:
                    if _vt: _vtn = float(str(_vt).replace(".", "").replace(",", "."))
                except Exception:
                    _vtn = None
                _na = len(out_v2.get("itens_fatura") or [])
                if _vtn and abs(amz["soma"] - _vtn) <= max(0.50, _vtn * 0.005) and len(amz["itens"]) >= _na:
                    out_v2["itens_fatura"] = amz["itens"]   # itens validados (Σ==total) substituem os furados
                    out_v2["_itens_fonte"] = "esp_amazonas"
            for _k in ("pis", "cofins"):
                if amz.get(_k) is not None and not (tpd.get(_k) or {}).get("valor_string"):
                    tpd[_k] = {"valor_string": "0,00", "aliquota_pct": "0", "_fonte": "esp_amazonas_isento"}
            _aclf = out_v2.setdefault("classificacao", {})
            if amz.get("subgrupo") and not _aclf.get("subgrupo"):
                _aclf["subgrupo"] = amz["subgrupo"]
            if amz.get("modalidade") and not _aclf.get("modalidade_tarifaria"):
                _aclf["modalidade_tarifaria"] = amz["modalidade"]
            if amz.get("classe") and not _aclf.get("classe_consumo"):
                _aclf["classe_consumo"] = amz["classe"]
            _adst = out_v2.setdefault("distribuidora", {})
            if not _adst.get("cnpj_emissor"):
                _adst["cnpj_emissor"] = "02.341.467/0001-20"

    # 9.0.5 Enel/Ampla — captura PIS/PASEP e COFINS separados (cada um com base/alíq/valor próprios)
    if _mapa_atual.startswith("enel"):
        trib_enel = extrair_tributos_enel(texto_combo)
        if trib_enel.get("pis") and "pis" not in tpd:
            tpd["pis"] = trib_enel["pis"]
        if trib_enel.get("cofins") and "cofins" not in tpd:
            tpd["cofins"] = trib_enel["cofins"]

    # 9.0.5d Ampla/Enel RJ NF3e 2022-2025 (header 'Ampla...Oscar Niemeyer' + chave hex). Grupo A
    # LIVRE/B. mapa enel_rio deixa total=null. Total + tributos limpos + classif + leitura + hist 12m.
    # Mercado livre (A4 Horo Verde Livre) → soma_itens SKIP (flag _enel_rj_acl). fill-if-empty.
    if re.search(r"Ampla\s+Energia\s+e\s+Servi[çc]os", texto_combo, re.I) and re.search(r"Oscar\s+Niemeyer", texto_combo, re.I):
        an = extrair_ampla_nf3e(texto_combo)
        if an:
            _anvv = out_v2.setdefault("vencimento_valor", {})
            if an.get("valor_total") and not _anvv.get("valor_total"): _anvv["valor_total"] = an["valor_total"]
            if an.get("mes_ref") and not (_anvv.get("mes_ref") or _anvv.get("mes_referencia")): _anvv["mes_ref"] = an["mes_ref"]
            if an.get("data_vencimento") and not _anvv.get("data_vencimento"): _anvv["data_vencimento"] = an["data_vencimento"]
            _anidn = out_v2.setdefault("identificadores_instalacao", {})
            if an.get("uc") and not _anidn.get("codigo_instalacao"): _anidn["codigo_instalacao"] = an["uc"]
            _anclf = out_v2.setdefault("classificacao", {})
            if an.get("classe") and not _anclf.get("classe_consumo"): _anclf["classe_consumo"] = an["classe"]
            if an.get("modalidade") and not _anclf.get("modalidade_tarifaria"): _anclf["modalidade_tarifaria"] = an["modalidade"]
            if an.get("subgrupo") and not _anclf.get("subgrupo"): _anclf["subgrupo"] = an["subgrupo"]
            _anpl = out_v2.setdefault("periodo_leitura", {})
            if an.get("leit_ant_data") and not _anpl.get("leitura_anterior"): _anpl["leitura_anterior"] = an["leit_ant_data"]
            if an.get("leit_atu_data") and not _anpl.get("leitura_atual"): _anpl["leitura_atual"] = an["leit_atu_data"]
            if an.get("dias") and not _anpl.get("dias_consumo"): _anpl["dias_consumo"] = an["dias"]
            for k, v in (an.get("tributos") or {}).items():
                if v and not (tpd.get(k) or {}).get("valor_string"): tpd[k] = v
            if an.get("historico") and not out_v2.get("historico_13m_consumo"):
                out_v2["historico_13m_consumo"] = an["historico"]; out_v2["_historico_fonte"] = "esp_ampla_nf3e"
            if an.get("acl"):
                out_v2["_enel_rj_acl"] = True   # mercado livre → soma_itens SKIP (itens parciais)
            _andst = out_v2.setdefault("distribuidora", {})
            if not _andst.get("cnpj_emissor"): _andst["cnpj_emissor"] = "33.050.071/0001-58"

    # 9.0.5b Enel Rio / Ampla layout ANTIGO 2021 (pré-NF3e, header 'NOTA FISCAL - CONTA
    # ENERGIA ELÉTRICA'). Roteiam mapa=None → bloco dispara por marcadores estruturais.
    # ICMS sem rótulo (linha posicional). fill-if-empty.
    if re.search(r"33\.050\.071/0001|NOTA FISCAL\s*-\s*CONTA ENERGIA EL[ÉE]TRICA|CLIENTE PARTICIPANTE AO SISTEMA DE COMPENSA", texto_combo, re.I):
        ea = extrair_enel_ampla_legacy(texto_combo)
        if ea:
            for k, v in (ea.get("tributos") or {}).items():
                if v and not tpd.get(k): tpd[k] = v
            eacl = ea.get("classificacao") or {}
            cd = out_v2.setdefault("classificacao", {})
            if eacl.get("modalidade") and not cd.get("modalidade_tarifaria"): cd["modalidade_tarifaria"] = eacl["modalidade"]
            if eacl.get("subgrupo") and not cd.get("subgrupo"): cd["subgrupo"] = eacl["subgrupo"]
            if eacl.get("classe") and not cd.get("classe_consumo"): cd["classe_consumo"] = eacl["classe"]
            dstea = out_v2.setdefault("distribuidora", {})
            if not dstea.get("cnpj_emissor"): dstea["cnpj_emissor"] = ea["cnpj_emissor"]
            # header total/mês/venc/uc (linha 1) — destrava o núcleo antiga (total=null era a causa)
            _eavv = out_v2.setdefault("vencimento_valor", {})
            if ea.get("valor_total") and not _eavv.get("valor_total"): _eavv["valor_total"] = ea["valor_total"]
            if ea.get("mes_ref") and not (_eavv.get("mes_ref") or _eavv.get("mes_referencia")): _eavv["mes_ref"] = ea["mes_ref"]
            if ea.get("data_vencimento") and not _eavv.get("data_vencimento"): _eavv["data_vencimento"] = ea["data_vencimento"]
            _eaidn = out_v2.setdefault("identificadores_instalacao", {})
            if ea.get("uc") and not _eaidn.get("codigo_instalacao"): _eaidn["codigo_instalacao"] = ea["uc"]
            # layout pré-NF3e 2020-2021 → SKIP histórico/leitura/classif (núcleo total+mês+classe+CNPJ ok)
            if ea.get("valor_total"):
                out_v2["_fatura_antiga"] = True

    # 9.0.5e CEB / Neoenergia Brasília Série U/A (pré-NF3e, 'ATO DECLARATORIO 005/2006' + CNPJ
    # 07.522.669). Rotulado 'Neoenergia Coelba' na coluna mas o conteúdo é Brasília. mapa não
    # cobre → total/classe/mês null → reprovado. Núcleo + _fatura_antiga → SKIP-cheio. fill-if-empty.
    if re.search(r"ATO\s+DECLARAT[ÓO]RIO\s*N?[°ºo]?\s*005/2006", texto_combo, re.I) and re.search(r"07\.522\.669", texto_combo):
        cb = extrair_ceb_serie_u(texto_combo)
        if cb:
            _cbvv = out_v2.setdefault("vencimento_valor", {})
            if cb.get("valor_total") and not _cbvv.get("valor_total"): _cbvv["valor_total"] = cb["valor_total"]
            if cb.get("mes_ref") and not (_cbvv.get("mes_ref") or _cbvv.get("mes_referencia")): _cbvv["mes_ref"] = cb["mes_ref"]
            if cb.get("data_vencimento") and not _cbvv.get("data_vencimento"): _cbvv["data_vencimento"] = cb["data_vencimento"]
            _cbcl = out_v2.setdefault("classificacao", {})
            if cb.get("classe") and not _cbcl.get("classe_consumo"): _cbcl["classe_consumo"] = cb["classe"]
            if cb.get("modalidade") and not _cbcl.get("modalidade_tarifaria"): _cbcl["modalidade_tarifaria"] = cb["modalidade"]
            if cb.get("subgrupo") and not _cbcl.get("subgrupo"): _cbcl["subgrupo"] = cb["subgrupo"]
            _cbcli = out_v2.setdefault("cliente", {})
            if cb.get("cnpj_cliente") and not (_cbcli.get("cnpj") or _cbcli.get("cnpj_cliente")):
                _cbcli["cnpj_cliente"] = cb["cnpj_cliente"]
            _cbdst = out_v2.setdefault("distribuidora", {})
            if not _cbdst.get("cnpj_emissor"): _cbdst["cnpj_emissor"] = "07.522.669/0001-92"
            for k, v in (cb.get("tributos") or {}).items():
                if v and not (tpd.get(k) or {}).get("valor_string"): tpd[k] = v
            if cb.get("itens") and not (out_v2.get("itens_fatura")):
                out_v2["itens_fatura"] = [{"descricao": it["descricao"],
                                           "valor_brl_numerico": float(it["valor_string"].replace(".", "").replace(",", ".")),
                                           "valor_brl_string": it["valor_string"]} for it in cb["itens"]]
                out_v2["_itens_fonte"] = "esp_ceb_serie_u"
            if cb.get("valor_total"):
                out_v2["_fatura_antiga"] = True

    # 9.0.5f Neoenergia Coelba (BA, 15.139.629) + Celpe (PE, 10.835.932) — MESMO template,
    # ambos rotulados 'Neoenergia Coelba%'. Total 'TOTAL DA FATURA'/'REF:MÊS/ANO ...' (≠ 'TOTAL
    # A PAGAR 0,00' débito), itens (Consumo TUSD/TE + Bandeira + Ilum + Imp.Som/Dim) somam total,
    # tributos limpos (rotulado novo / posicional antigo), histórico, leitura, classe. fill-if-empty.
    if re.search(r"15\.139\.629|10\.835\.932", texto_combo) and \
       re.search(r"DESCRI[ÇC][ÃA]O DA NOTA FISCAL|ITENS DA FATURA|TOTAL DA FATURA", texto_combo, re.I):
        nn = extrair_neoenergia_nordeste(texto_combo)
        if nn and nn.get("valor_total"):
            _nnvv = out_v2.setdefault("vencimento_valor", {})
            if not _nnvv.get("valor_total"): _nnvv["valor_total"] = nn["valor_total"]
            if nn.get("mes_ref") and not (_nnvv.get("mes_ref") or _nnvv.get("mes_referencia")): _nnvv["mes_ref"] = nn["mes_ref"]
            if nn.get("data_vencimento") and not _nnvv.get("data_vencimento"): _nnvv["data_vencimento"] = nn["data_vencimento"]
            _nnidn = out_v2.setdefault("identificadores_instalacao", {})
            if nn.get("instalacao") and not _nnidn.get("codigo_instalacao"): _nnidn["codigo_instalacao"] = nn["instalacao"]
            _nncli = out_v2.setdefault("cliente", {})
            if nn.get("cnpj_cliente") and not (_nncli.get("cnpj") or _nncli.get("cnpj_cliente")):
                _nncli["cnpj_cliente"] = nn["cnpj_cliente"]
            _nnclf = out_v2.setdefault("classificacao", {})
            if nn.get("classe") and not _nnclf.get("classe_consumo"): _nnclf["classe_consumo"] = nn["classe"]
            if nn.get("subgrupo") and not _nnclf.get("subgrupo"): _nnclf["subgrupo"] = nn["subgrupo"]
            if nn.get("modalidade") and not _nnclf.get("modalidade_tarifaria"): _nnclf["modalidade_tarifaria"] = nn["modalidade"]
            _nnpl = out_v2.setdefault("periodo_leitura", {})
            if nn.get("leit_ant_data") and not _nnpl.get("leitura_anterior"): _nnpl["leitura_anterior"] = nn["leit_ant_data"]
            if nn.get("leit_atu_data") and not _nnpl.get("leitura_atual"): _nnpl["leitura_atual"] = nn["leit_atu_data"]
            if nn.get("dias") and not _nnpl.get("dias_consumo"): _nnpl["dias_consumo"] = nn["dias"]
            _nntr = nn.get("tributos") or {}
            for k, v in _nntr.items():
                if v and not (tpd.get(k) or {}).get("valor_string"): tpd[k] = v
            _nntagg = out_v2.setdefault("tributos_agregados_itens", {})
            if _nntr.get("icms"):
                _nntagg.setdefault("icms_liquido", {"valor_numerico": _amz_brl(_nntr["icms"]["valor_string"])})
            _npc = (_amz_brl((_nntr.get("pis") or {}).get("valor_string")) or 0) + (_amz_brl((_nntr.get("cofins") or {}).get("valor_string")) or 0)
            if _npc:
                _nntagg.setdefault("pis_cofins_liquido", {"valor_numerico": round(_npc, 2)})
                _nntagg.setdefault("pis_cofins_agregado", {"valor_numerico": round(_npc, 2)})
            if nn.get("itens"):
                _nvtn = None
                try:
                    _nvtn = float(str(_nnvv.get("valor_total")).replace(".", "").replace(",", "."))
                except Exception:
                    _nvtn = None
                if _nvtn and abs(nn["soma"] - _nvtn) <= max(0.50, _nvtn * 0.02):
                    out_v2["itens_fatura"] = nn["itens"]; out_v2["_itens_fonte"] = "esp_neo_nordeste"
            if nn.get("historico") and not out_v2.get("historico_13m_consumo"):
                out_v2["historico_13m_consumo"] = nn["historico"]; out_v2["_historico_fonte"] = "esp_neo_nordeste"
            _nndst = out_v2.setdefault("distribuidora", {})
            if not _nndst.get("cnpj_emissor"):
                _nndst["cnpj_emissor"] = "10.835.932/0001-08" if re.search(r"10\.835\.932", texto_combo) else "15.139.629/0001-94"

    # 9.0.5g Roraima Energia (CNPJ 02.341.470). DANF3E limpo; mapa não cobre → itens não somam.
    # Total 'Total a pagar' + itens (Consumo+COSIP+Demanda somam) + tributos Detalhamento +
    # classe/subgrupo/modalidade + leitura + histórico 13m. fill-if-empty.
    if re.search(r"RORAIMA\s+ENERGIA|02\.?341\.?470/0001", texto_combo, re.I):
        rr = extrair_roraima(texto_combo)
        if rr and rr.get("valor_total"):
            _rrvv = out_v2.setdefault("vencimento_valor", {})
            if not _rrvv.get("valor_total"): _rrvv["valor_total"] = rr["valor_total"]
            if rr.get("mes_ref") and not (_rrvv.get("mes_ref") or _rrvv.get("mes_referencia")): _rrvv["mes_ref"] = rr["mes_ref"]
            if rr.get("data_vencimento") and not _rrvv.get("data_vencimento"): _rrvv["data_vencimento"] = rr["data_vencimento"]
            _rridn = out_v2.setdefault("identificadores_instalacao", {})
            if rr.get("instalacao") and not _rridn.get("codigo_instalacao"): _rridn["codigo_instalacao"] = rr["instalacao"]
            _rrcli = out_v2.setdefault("cliente", {})
            if rr.get("cnpj_cliente") and not (_rrcli.get("cnpj") or _rrcli.get("cnpj_cliente")): _rrcli["cnpj_cliente"] = rr["cnpj_cliente"]
            if rr.get("razao_social") and not _rrcli.get("razao_social"): _rrcli["razao_social"] = rr["razao_social"]
            _rrclf = out_v2.setdefault("classificacao", {})
            if rr.get("classe") and not _rrclf.get("classe_consumo"): _rrclf["classe_consumo"] = rr["classe"]
            if rr.get("subgrupo") and not _rrclf.get("subgrupo"): _rrclf["subgrupo"] = rr["subgrupo"]
            if rr.get("modalidade") and not _rrclf.get("modalidade_tarifaria"): _rrclf["modalidade_tarifaria"] = rr["modalidade"]
            _rrpl = out_v2.setdefault("periodo_leitura", {})
            if rr.get("leit_ant_data") and not _rrpl.get("leitura_anterior"): _rrpl["leitura_anterior"] = rr["leit_ant_data"]
            if rr.get("leit_atu_data") and not _rrpl.get("leitura_atual"): _rrpl["leitura_atual"] = rr["leit_atu_data"]
            if rr.get("dias") and not _rrpl.get("dias_consumo"): _rrpl["dias_consumo"] = rr["dias"]
            _rrtr = rr.get("tributos") or {}
            for k, v in _rrtr.items():
                if v and not (tpd.get(k) or {}).get("valor_string"): tpd[k] = v
            _rrtagg = out_v2.setdefault("tributos_agregados_itens", {})
            if _rrtr.get("icms"):
                _rrtagg.setdefault("icms_liquido", {"valor_numerico": _amz_brl(_rrtr["icms"]["valor_string"])})
            _rrpc = (_amz_brl((_rrtr.get("pis") or {}).get("valor_string")) or 0) + (_amz_brl((_rrtr.get("cofins") or {}).get("valor_string")) or 0)
            if _rrpc:
                _rrtagg.setdefault("pis_cofins_liquido", {"valor_numerico": round(_rrpc, 2)})
                _rrtagg.setdefault("pis_cofins_agregado", {"valor_numerico": round(_rrpc, 2)})
            if rr.get("itens"):
                _rvtn = None
                try:
                    _rvtn = float(str(_rrvv.get("valor_total")).replace(".", "").replace(",", "."))
                except Exception:
                    _rvtn = None
                if _rvtn and abs(rr["soma"] - _rvtn) <= max(0.50, _rvtn * 0.02):
                    # itens validados (Σ==total) substituem os do extrator base (errados)
                    out_v2["itens_fatura"] = rr["itens"]; out_v2["_itens_fonte"] = "esp_roraima"
            if rr.get("historico") and not out_v2.get("historico_13m_consumo"):
                out_v2["historico_13m_consumo"] = rr["historico"]; out_v2["_historico_fonte"] = "esp_roraima"
            _rrdst = out_v2.setdefault("distribuidora", {})
            if not _rrdst.get("cnpj_emissor"): _rrdst["cnpj_emissor"] = "02.341.470/0001-44"
            out_v2["_sem_indicadores"] = True   # Roraima não imprime DIC/FIC na fatura

    # 9.0.5c Ampla/Enel RJ NF Modelo 6 (antigo, não-NF3e) — tributos char-a-char no bbox / com
    # espaço antes do % no plumber. De-espaça tudo e captura '<TRIB><base><aliq>%<valor>'. fill-if-empty.
    if re.search(r"Modelo\s*6|Ampla\s+Energia\s+e\s+Servi", texto_combo, re.I) and \
       not ((tpd.get("icms") or {}).get("valor_string") and (tpd.get("pis") or {}).get("valor_string")
            and (tpd.get("cofins") or {}).get("valor_string")):
        am = extrair_ampla_modelo6(texto_combo)
        if am:
            for k in ("icms", "pis", "cofins"):
                if am.get(k) and not (tpd.get(k) or {}).get("valor_string"):
                    tpd[k] = am[k]
            vv = out_v2.setdefault("vencimento_valor", {})
            if am.get("valor_total") and not vv.get("valor_total"):
                vv["valor_total"] = am["valor_total"]

    # 9.0.7 Energisa TO/MG-RJ/SS — mapa já extrai ICMS mas falta PIS/COFINS. 2 formatos na
    # linha de total: (a) 'Total: <total> <n> <n> <icms> <pis> <cofins>' (6 nums, SS 2022 —
    # PIS/COFINS separados no fim); (b) 'TOTAL: <total> <pis+cofins> <base_icms> <icms>' (4
    # nums, TO/MG 2026 — combinado → split). NÃO toca Energisa MT (GGF já tem pis/cofins).
    if _mapa_atual.startswith("energisa") and not (tpd.get("pis") and tpd.get("cofins")):
        m6 = re.search(r"(?:TOTAL|Total):[ \t]+([\d.]+,\d{2})[ \t]+([\d.]+,\d{2})[ \t]+([\d.]+,\d{2})[ \t]+([\d.]+,\d{2})[ \t]+([\d.]+,\d{2})[ \t]+([\d.]+,\d{2})", texto_combo)
        if m6:
            if not tpd.get("pis"): tpd["pis"] = {"valor_string": m6.group(5)}
            if not tpd.get("cofins"): tpd["cofins"] = {"valor_string": m6.group(6)}
        else:
            m4 = re.search(r"(?:TOTAL|Total):[ \t]+([\d.]+,\d{2})[ \t]+([\d.]+,\d{2})[ \t]+([\d.]+,\d{2})[ \t]+([\d.]+,\d{2})", texto_combo)
            if m4 and not (tpd.get("pis") or tpd.get("cofins")):
                try:
                    combo = float(m4.group(2).replace(".", "").replace(",", "."))
                    tagg = out_v2.setdefault("tributos_agregados_itens", {})
                    if not (tagg.get("pis_cofins_liquido") or tagg.get("pis_cofins_agregado")):
                        tagg["pis_cofins_agregado"] = {"valor_numerico": combo}
                except Exception:
                    pass

    # 9.0.6 EDP ES — layout NF simples com tributos 'BASE X ALIQ% = VALOR'.
    # Detecta pelo próprio formato (exclusivo ES); só preenche o que casar.
    if _mapa_atual.startswith("edp") or re.search(r"ESP[IÍ]RITO\s+SANTO", texto_combo, re.I):
        trib_es = extrair_tributos_edp_es(texto_combo)
        for k in ("pis", "cofins", "icms"):
            if trib_es.get(k) and k not in tpd:
                tpd[k] = trib_es[k]

    # 9.0.6b EDP (ES/SP) — ICMS líquido na linha TOTAL: 'TOTAL <total> <pis+cofins> <base_icms> <icms>'
    # (o ICMS por item é bruto pré-GD; o do TOTAL é o net, fiscalmente correto). COFINS do EDP SP
    # às vezes vem com ponto decimal (fica None) → completa via (pis+cofins) - pis.
    if _mapa_atual.startswith("edp") or re.search(r"ESP[IÍ]RITO\s+SANTO|EDP\s+(SP|ES|S[ÃA]O\s+PAULO)\b|EDP\s+DISTRIB", texto_combo, re.I):
        def _brf(s):
            try: return float(str(s).replace(".", "").replace(",", ".")) if "," in str(s) else float(s)
            except Exception: return None
        mt = re.search(r"\bTOTAL\s+([\d.]+,\d{2})-?\s+([\d.]+,\d{2})-?\s+([\d.]+,\d{2})-?\s+([\d.]+,\d{2})-?", texto_combo)
        if mt:
            aliq = "17" if re.search(r"ESP[IÍ]RITO\s+SANTO", texto_combo, re.I) else "18"
            if not tpd.get("icms"):
                tpd["icms"] = {"valor_string": mt.group(4), "base_string": mt.group(3), "aliquota_pct": aliq}
            pc_num = _brf(mt.group(2)); pis_v = _brf((tpd.get("pis") or {}).get("valor_string")); cof_v = _brf((tpd.get("cofins") or {}).get("valor_string"))
            if pc_num is not None and pis_v is not None and cof_v is None:
                cof_calc = round(pc_num - pis_v, 2)
                if cof_calc > 0:
                    tpd["cofins"] = {"valor_string": ("%.2f" % cof_calc).replace(".", ",")}

    if "pis" in tpd and "cofins" not in tpd:
        pis = tpd["pis"]
        try:
            pa = float(str(pis.get("aliquota_pct", "0")).replace(",", "."))
            pv = float(str(pis.get("valor_string", "0")).replace(",", "."))
            cof = estimar_cofins_do_pis(pa, pv)
            if cof: tpd["cofins"] = cof
        except: pass

    # 9.0.99 FALLBACK GENÉRICO DE TRIBUTOS — quando nenhum bloco da dist preencheu i+p+c.
    # Cobre sub-layouts não calibrados (ex.: LIGHT 'layout_desconhecido') onde os tributos
    # vêm no formato padrão '<TRIB> base aliq[%] valor' — que já sabemos ler. fill-if-empty,
    # qualquer mapa. Não toca o que já foi extraído pelos blocos específicos.
    if not (tpd.get("icms") and tpd.get("pis") and tpd.get("cofins")):
        _flatc = re.sub(r"[ \t]+", " ", texto_combo)
        for _pat in (r"\b(PIS/PASEP|PIS|COFINS|ICMS)\s+([\d.]+,\d{2})\s+([\d.,]+)%\s+([\d.]+,\d{2})",
                     r"\b(PIS/PASEP|PIS|COFINS|ICMS)\s+([\d.]+,\d{2})\s+(\d{1,2},\d{2,4})\s+([\d.]+,\d{2})"):
            for _t in re.finditer(_pat, _flatc):
                _nm = _t.group(1).upper()
                _k = "pis" if _nm.startswith("PIS") else ("cofins" if _nm == "COFINS" else "icms")
                if not tpd.get(_k):
                    tpd[_k] = {"base_string": _t.group(2), "aliquota_pct": _t.group(3),
                               "valor_string": _t.group(4), "_fonte": "fallback_generico"}
        # ISENTO: tributo explicitamente marcado com traços ('ICMS - - -') = 0,00 (não é erro).
        for _ti in re.finditer(r"\b(PIS/PASEP|PIS|COFINS|ICMS)\s+-\s+-\s+-", _flatc):
            _nm = _ti.group(1).upper()
            _k = "pis" if _nm.startswith("PIS") else ("cofins" if _nm == "COFINS" else "icms")
            if not tpd.get(_k):
                tpd[_k] = {"valor_string": "0,00", "aliquota_pct": "0", "_fonte": "isento_dash"}

    # 9.0.99c ICMS Light GD — ICMS embutido por item ('<base> <alíq,3dec> <icms>'), sem
    # rótulo nem linha-total; soma as linhas reais (dedup por base,icms). Gold 95415:
    # 30,44 + 1.224,11 = 1.254,55. Só quando ICMS ausente e mapa=light → não toca isento
    # nem as Light que já trouxeram ICMS por outro caminho.
    if _mapa_atual == "light" and not (tpd.get("icms") or {}).get("valor_string"):
        _icms_lt = extrair_icms_light_soma(texto_combo)
        if _icms_lt:
            tpd["icms"] = _icms_lt


    # 10. mUC vs oUC (CRÍTICO)
    gd_class = classificar_mUC_oUC(texto, itens)
    gd = out_v2.setdefault("geracao_distribuida", {})
    if gd_class["compensacao_propria_mUC"]:
        gd["compensacao_propria_mUC"] = gd_class["compensacao_propria_mUC"]
    if gd_class["creditos_de_outras_ucs_oUC"]:
        gd["creditos_de_outras_ucs_oUC"] = gd_class["creditos_de_outras_ucs_oUC"]
    # Remove o campo antigo se ele continha mUC erroneamente rotulados
    if "creditos_de_outras_ucs_mUC" in gd:
        # Mantém retrocompat mas adiciona _obs
        gd["_obs_creditos_de_outras_ucs_mUC"] = "DEPRECATED: usar compensacao_propria_mUC (própria) ou creditos_de_outras_ucs_oUC (outras)"
    gd["alerta_sem_oUC"] = gd_class["alerta_sem_oUC"]
    gd["_obs_alerta_sem_oUC"] = gd_class["_obs_alerta_sem_oUC"]

    # 10.1 Saldo de Créditos SCEE — linha 'Energia injetada - X/Saldo de Créditos: Y'
    # (Light e outras GD). Já está no plumber; não era capturado → coluna saldo_credito_energia
    # vinha null (0/3.649 Light). Preenche fill-if-empty. Alimenta os 2 caminhos do
    # atualizar_colunas_db: saldo_acumulado_fora_ponta_kwh (→ saldo_total) e saldo_credito_energia.
    _scee = extrair_saldo_creditos_scee(texto_combo)
    if _scee and _scee.get("saldo_credito_energia") is not None:
        _sld = _scee["saldo_credito_energia"]
        if not (gd.get("saldo_acumulado_ponta_kwh") or gd.get("saldo_acumulado_fora_ponta_kwh")):
            gd["saldo_acumulado_fora_ponta_kwh"] = _sld
        if gd.get("saldo_credito_energia") is None:
            gd["saldo_credito_energia"] = _sld
        if _scee.get("energia_injetada_scee_kwh") is not None:
            gd["energia_injetada_scee_kwh"] = _scee["energia_injetada_scee_kwh"]
        gd["_fonte_saldo_credito"] = "scee_plumber"

    # Atualiza auditoria GD com novo alerta
    aud = out_v2.setdefault("auditoria_gd", {})
    if gd_class["alerta_sem_oUC"]:
        divs = aud.setdefault("divergencias", [])
        divs.append({
            "tipo": "sem_entrada_geradora",
            "descricao": "GD com mUC mas sem oUC — geradora não injetou créditos no ciclo",
            "tem_mUC": True,
            "tem_oUC": False,
        })

    # 11. Histórico de consumo correto
    # NÃO sobrescreve quando um especialista já trouxe um histórico melhor (ex.: Enel CE
    # markdown colunar, 13m) — só substitui se for >= em nº de meses.
    hist = extrair_historico_consumo_energisa(texto)
    if hist and out_v2.get("_historico_fonte") != "enel_ce_md" and \
       len(hist) >= len(out_v2.get("historico_13m_consumo") or []):
        out_v2["historico_13m_consumo"] = hist
        # Sobrescreve o antigo que estava errado
        out_v2["historico_13m_regex"] = hist

    # 11.5 Histórico UNIVERSAL — fallback quando pattern principal não pegou
    if not out_v2.get("historico_13m_consumo"):
        hist_uni = extrair_historico_universal(texto_combo)
        if hist_uni:
            out_v2["historico_13m_consumo"] = hist_uni
            out_v2["_historico_fonte"] = "universal"

    # 12. Indicadores
    ind = out_v2.setdefault("indicadores_qualidade", {})
    ind_extra = extrair_indicadores_extra(texto)
    for k, v in ind_extra.items():
        if v and not ind.get(k):
            ind[k] = v

    # 12.1 Campos extras Energisa MT (perda ramal, subvenção rural, status pagto)
    mapa_pre_l = (out_v2.get("_mapa_usado") or "").lower()
    eh_energisa = "energisa" in mapa_pre_l or "ENERGISA" in (texto or "")[:1500].upper()
    if eh_energisa:
        extras_mt = extrair_energisa_mt_extras(texto_combo)
        if extras_mt:
            edist = out_v2.setdefault("_extras_dist", {})
            for k, v in extras_mt.items():
                if v is not None and edist.get(k) is None:
                    edist[k] = v
            # data_pagamento + status_pagamento também em vencimento_valor pra acesso fácil
            vv_d2 = out_v2.setdefault("vencimento_valor", {})
            if extras_mt.get("data_pagamento") and not vv_d2.get("data_pagamento"):
                vv_d2["data_pagamento"] = extras_mt["data_pagamento"]
            if extras_mt.get("status_pagamento") and not vv_d2.get("status_pagamento"):
                vv_d2["status_pagamento"] = extras_mt["status_pagamento"]
        # 12.1b Rural GD_I / irrigante (crédito anterior, bônus Itaipu, devolução
        # subsídio, consumo reservado) — sublayouts GGF Agro Energisa MT
        rural_gd = extrair_energisa_mt_rural_gd_extras(texto_combo)
        if rural_gd:
            edist = out_v2.setdefault("_extras_dist", {})
            for k, v in rural_gd.items():
                if v is not None and edist.get(k) is None:
                    edist[k] = v

    # 12.2 Demanda Medida + Demanda Complementar por posto (Grupo A — Art. 300 REN 1.000)
    dem_mc = extrair_demandas_medida_complementar(texto_combo)
    if dem_mc:
        edist = out_v2.setdefault("_extras_dist", {})
        for k, v in dem_mc.items():
            if v is not None and edist.get(k) is None:
                edist[k] = v

    # 12.3 Flag faturamento pela média (Art. 86) + flag telemetria (Energisa, indicador de dem.compl.)
    if extrair_flag_faturamento_media(texto_combo):
        out_v2.setdefault("_extras_dist", {})["flag_faturamento_pela_media"] = True
    tel = extrair_flag_telemetria(texto_combo)
    if tel:
        edist = out_v2.setdefault("_extras_dist", {})
        for k, v in tel.items():
            if v is not None and edist.get(k) is None:
                edist[k] = v

    # 12.4 Motivo do faturamento pela média (categorizado — Energisa MT)
    motivo = extrair_motivo_faturamento_media(texto_combo)
    if motivo:
        edist = out_v2.setdefault("_extras_dist", {})
        for k, v in motivo.items():
            if v and edist.get(k) is None:
                edist[k] = v

    # 12.5 Taxa de perda de transformação (% — ex Enel SP 'PERDA DE TRANSFORMAÇÃO - 2,5%')
    perda = extrair_taxa_perda(texto_combo)
    if perda:
        edist = out_v2.setdefault("_extras_dist", {})
        for k, v in perda.items():
            if v is not None and edist.get(k) is None:
                edist[k] = v

    # 12.6 FG04 — GD correto (itens_fatura + saldo via texto) corrige copy-bug injetada↔compensada
    gd_fix = extrair_gd_correto(out_v2.get("itens_fatura"), texto_combo)
    if gd_fix:
        gd_d = out_v2.setdefault("geracao_distribuida", {})
        for k, v in gd_fix.items():
            if v is not None:
                gd_d[k] = v  # sobrescreve — fix tem prioridade

    # 12.7 A-3 — Fator de Potência + Reativos Excedentes (Grupo A)
    reat = extrair_reativos_a3(texto_combo)
    if reat:
        edist = out_v2.setdefault("_extras_dist", {})
        for k, v in reat.items():
            if v is not None and edist.get(k) is None:
                edist[k] = v

    # 12.8 TR-1 — ICMS TE vs TUSD via itens_fatura (detecção ICMS indevido sobre TUSD)
    icms_sep = extrair_icms_te_tusd(out_v2.get("itens_fatura"))
    if icms_sep:
        edist = out_v2.setdefault("_extras_dist", {})
        for k, v in icms_sep.items():
            # icms_sep pode trazer None explícito (sinal de ACL→limpar TE) — propaga
            if k in ("icms_base_te", "icms_base_tusd"):
                edist[k] = v
            elif v is not None and edist.get(k) is None:
                edist[k] = v

    # 12.9 CIP/COSIP — Contribuição de Iluminação Pública (isenta de ICMS)
    # Linha do texto primeiro (validado na conferência visual 11/10: 950→1.27x de 1.309 certas);
    # itens/fallback antigo só quando a leitura por linha não acha nada.
    cip_rs = extrair_cip_linhas(texto)
    if cip_rs is None:
        cip_rs = extrair_cip_linhas(texto_md)
    if cip_rs is None:
        cip_rs = extrair_cip_iluminacao_publica(out_v2.get("itens_fatura"))
    # Fallback: busca no texto quando não está como item (Enel SP '0807 COSIP', etc)
    if cip_rs is None:
        cip_rs = extrair_cip_do_texto(texto)
    if cip_rs is not None:
        edist = out_v2.setdefault("_extras_dist", {})
        edist["cip_iluminacao_publica_rs"] = cip_rs

    # 12.9.1 Composição do consumo (Enel SP/Light) — detalhamento Geração/Transmissão/Dist/Tributos
    composicao = extrair_composicao_consumo(texto)
    if composicao:
        out_v2.setdefault("_extras_dist", {})["composicao_base_icms"] = composicao

    # 12.9.1.1 Tributos totais (Equatorial GO + outras) — sobrescreve quando captura PIS+COFINS+ICMS
    tributos_totais = extrair_tributos_totais(texto)
    if tributos_totais:
        edist = out_v2.setdefault("_extras_dist", {})
        for k, v in tributos_totais.items():
            edist[k + "_totais"] = v  # marca como totais (não confunde com valor por item)

    # 12.9.1.2 Histórico Equatorial GO (paralelo com colunas demanda + cons_ponta/fp/hr + dias)
    hist_eq = extrair_historico_equatorial(texto)
    if hist_eq:
        out_v2.setdefault("_extras_dist", {})["historico_equatorial_go"] = hist_eq

    # 12.9.1.3 Notificações de débitos vencidos + data suspensão
    notif = extrair_notificacoes_debitos(texto)
    if notif:
        out_v2.setdefault("_extras_dist", {}).update(notif)

    # 12.9.1.3b Parcelamentos de débito (REN 1.000 Art. 323/324) — cristalizado do colab
    parc = extrair_parcelamentos(texto_combo)
    if parc:
        out_v2.setdefault("_extras_dist", {})["parcelamentos"] = parc

    # 12.9.1.3c Devoluções/restituições/subvenções com valor (R4 — itens negativos)
    devs = extrair_devolucoes_subvencoes(texto_combo)
    if devs:
        out_v2.setdefault("_extras_dist", {})["devolucoes"] = devs

    # 12.9.1.3d Indicadores continuidade DIC/FIC/DMIC/DICRI estruturados (→ validador Art. 300)
    ind_cont = extrair_indicadores_continuidade(texto_combo)
    if ind_cont:
        out_v2.setdefault("_extras_dist", {})["indicadores_continuidade"] = ind_cont

    # 12.9.1.3e Bandeiras por período (lista cor+patamar+período; complementa a bandeira principal)
    band_per = extrair_bandeiras_periodo(texto_combo)
    if band_per:
        out_v2.setdefault("_extras_dist", {})["bandeiras_periodo"] = band_per

    # 12.9.1.3f Consenso multi-fonte (G) — divergência plumber↔markdown em campos core (não-destrutivo)
    if texto_md:
        cons = avaliar_consenso_core(texto, texto_md)
        if cons:
            out_v2.setdefault("_extras_dist", {})["_consenso_core"] = cons
            if cons.get("_divergencias"):
                out_v2["_extras_dist"]["_consenso_divergente"] = True

    # 12.9.1.4 VRC + CFOP
    vrc = extrair_vrc_cfop(texto)
    if vrc:
        out_v2.setdefault("_extras_dist", {}).update(vrc)

    # 12.9.1.5 Medição (6 grandezas × postos — Energisa MT/Equatorial GO/etc)
    medicao = extrair_medicao_grandezas(texto)
    if medicao:
        out_v2.setdefault("_extras_dist", {})["medicao_grandezas"] = medicao
        # Hidrata colunas SQL específicas a partir do array
        for r in medicao:
            grd = r.get("grandeza", "")
            posto = r.get("posto", "")
            if grd == "ENERGIA ATIVA - KWH":
                if posto == "PONTA":
                    out_v2.setdefault("medicao", {})["leit_ant_ativa_ponta"] = r["leitura_anterior"]
                    out_v2["medicao"]["leit_atu_ativa_ponta"] = r["leitura_atual"]
                    if r.get("constante"): out_v2["medicao"]["constante_k"] = r["constante"]
                elif posto == "FORA PONTA":
                    out_v2.setdefault("medicao", {})["leit_ant_ativa_fponta"] = r["leitura_anterior"]
                    out_v2["medicao"]["leit_atu_ativa_fponta"] = r["leitura_atual"]
                    if r.get("constante") and not out_v2.get("medicao", {}).get("constante_k"):
                        out_v2.setdefault("medicao", {})["constante_k"] = r["constante"]
            elif grd == "ENERGIA REATIVA - KWH" and posto == "PONTA":
                out_v2.setdefault("medicao", {})["leit_ant_reativa"] = r["leitura_anterior"]
                out_v2["medicao"]["leit_atu_reativa"] = r["leitura_atual"]

    # 12.9.1.6 Pagamento canhoto (página 3)
    pag = extrair_pagamento_canhoto(texto)
    if pag:
        out_v2.setdefault("_extras_dist", {}).update(pag)

    # 12.9.1.7 Validação determinística (após todas as extrações acima)
    val = validar_deterministico(out_v2)
    if val:
        out_v2["_validacao_deterministica"] = val

    # 12.9.2 Fix leituras Grupo A — pega da tabela de medição "KWH Ponta/FPonta"
    # Conserta bug onde leit_*_fponta vinha = leit_*_ponta (duplicação extrator)
    grupo = (out_v2.get("ligacao_tecnica") or {}).get("grupo") or ""
    if str(grupo).upper().startswith("A"):
        leits = extrair_leituras_grupo_a_medicao(texto)
        if leits:
            edist = out_v2.setdefault("_extras_dist", {})
            for k, v in leits.items():
                if v is not None:
                    edist[k] = v

    # 12.10 SEFAZ NF3e — cross-check + enriquecimento + SOBRESCRITA quando disponível
    # Quando SEFAZ traz valor/qtd válidos, ele PREVALECE (NF3e é XML assinado pela dist).
    chave_nfe = (
        (out_v2.get("nota_fiscal") or {}).get("chave_acesso")
        or out_v2.get("chave_nfe")
        or out_v2.get("chave_acesso")
    )
    if chave_nfe and len(str(chave_nfe).strip()) == 44 and not os.environ.get("SKIP_SEFAZ"):
        try:
            from complementos_sefaz import extrair_complementos_sefaz
            valor_extr = (out_v2.get("totais") or {}).get("valor_total_a_pagar") \
                         or (out_v2.get("referencia_vencimento_valor") or {}).get("valor_total_a_pagar")
            qtd_extr = len(out_v2.get("itens_fatura") or [])
            sefaz = extrair_complementos_sefaz(chave_nfe, valor_extr, qtd_extr)
            if sefaz:
                out_v2["_extras_sefaz"] = sefaz
                # Sobrescrita: SEFAZ é fonte fiscal autoritativa
                vt_sefaz = sefaz.get("valor_total_sefaz")
                if vt_sefaz is not None:
                    rvv = out_v2.setdefault("referencia_vencimento_valor", {})
                    rvv["_valor_total_extrator"] = valor_extr   # preserva pra auditoria
                    # Art.323 (REN 1000/21): quando há CRÉDITO DE COMPENSAÇÃO/DEVOLUÇÃO
                    # (CCI 5906), o SEFAZ traz o BRUTO (o crédito entra como item positivo
                    # no vNF). O valor A PAGAR = bruto − crédito de compensação.
                    # Ex. Equatorial GO id 478069: 2.936,48 − 1.468,24 = 1.468,24.
                    _classif_cci = (sefaz.get("classificacao_cci_sefaz") or {})
                    _cred_comp = float((_classif_cci.get("credito_compensacao") or {}).get("valor_total") or 0)
                    _vt_liquido = float(vt_sefaz)
                    if _cred_comp > 0 and _cred_comp < float(vt_sefaz):
                        _vt_liquido = round(float(vt_sefaz) - _cred_comp, 2)
                        rvv["_valor_total_bruto_sefaz"] = float(vt_sefaz)
                        rvv["_credito_compensacao_sefaz"] = _cred_comp
                        # fatura de revisão/devolução → não deve gerar apontamento F02
                        out_v2["_flag_fatura_revisao"] = True
                    rvv["valor_total_a_pagar"] = _vt_liquido
                    rvv["_valor_total_origem"] = "sefaz"
                qi_sefaz = sefaz.get("qtd_itens_sefaz")
                if qi_sefaz is not None:
                    out_v2["_qtd_itens_sefaz"] = int(qi_sefaz)
                    out_v2["_qtd_itens_origem"] = "sefaz"
        except Exception:
            pass  # SEFAZ falhou — não bloqueia o pipeline

    # 12.5 Limpeza de medidor inválido (curto/lixo) — antes da hidratação
    # Layout Enel: 'Medidor P.Horário/Segmento' faz regex MEDIDOR[A-Z0-9]+ casar 'P'
    ident_pre = out_v2.get("identificadores_instalacao") or {}
    med_atual = ident_pre.get("medidor")
    if med_atual and len(str(med_atual).strip().replace("-", "")) < 4:
        ident_pre["_medidor_descartado"] = med_atual
        ident_pre["medidor"] = None

    # 13. Código instalação ANEEL (NOVO) + medidor — SOBRESCREVE valores errados
    ident = out_v2.setdefault("identificadores_instalacao", {})
    cod = extrair_codigo_instalacao(texto)
    if cod.get("codigo_instalacao"):
        # Se o atual é Wnnnn (medidor), sobrescreve com o ANEEL real
        atual = ident.get("codigo_instalacao") or ""
        if not atual or re.match(r"^W\d{8,12}$", atual):
            ident["codigo_instalacao"] = cod["codigo_instalacao"]
    if cod.get("medidor"):
        ident["medidor"] = cod["medidor"]
    # Limpa codigo_instalacao_antigo se for igual ao novo (artefato de extrator anterior)
    if ident.get("codigo_instalacao_antigo") and ident["codigo_instalacao_antigo"] == ident.get("codigo_instalacao"):
        ident["codigo_instalacao_antigo"] = None
    # Limpa codigo_cliente se for o mesmo número do codigo_instalacao (estava errado no parser antigo)
    if ident.get("codigo_cliente") and ident["codigo_cliente"] == ident.get("codigo_instalacao"):
        ident["codigo_cliente"] = None

    # 13.5 Classificação (modalidade + subgrupo + classe + ligação)
    clf = extrair_classificacao(texto)
    if clf:
        out_v2.setdefault("classificacao", {})
        for k, v in clf.items():
            if v: out_v2["classificacao"][k] = v

    # 13.6 Dedupe domicílio de entrega (letras duplicadas em PDF bold)
    dom = out_v2.get("domicilio_entrega") or {}
    if dom.get("razao_social"):
        original = dom["razao_social"]
        deduped = dedupe_letras_duplicadas(original)
        if deduped != original:
            dom["razao_social"] = deduped
            dom["_razao_social_dedupe_aplicado"] = True

    # 14. Hidratação razão social via BOLETO (quando cascata disponível)
    if cascata:
        boleto = extrair_razao_do_boleto(cascata)
        cli = out_v2.setdefault("cliente", {})
        if boleto.get("razao_social") and not cli.get("razao_social"):
            cli["razao_social"] = boleto["razao_social"]
            cli["_razao_social_fonte"] = "boleto_cascata"
        if boleto.get("cnpj_cliente") and not cli.get("cnpj_cliente"):
            cli["cnpj_cliente"] = boleto["cnpj_cliente"]
        if boleto.get("cpf_cliente") and not cli.get("cpf_cliente"):
            cli["cpf_cliente"] = boleto["cpf_cliente"]
        if boleto.get("endereco_uc") and not cli.get("endereco_uc"):
            cli["endereco_uc"] = boleto["endereco_uc"]

    # 15. Marca histórico se for só DIAS (não kWh)
    hist = out_v2.get("historico_13m_consumo")
    if hist:
        marcar_historico_dias(hist)

    # 16. Histórico Energisa via bbox X-band (recupera meses com colunas parciais)
    mapa = (out_v2.get("_mapa_usado") or "").lower()
    if pdf_path and ("energisa" in mapa):
        try:
            hist_bbox = extrair_historico_energisa_bbox(pdf_path)
            if hist_bbox:
                # Mescla por (mes, ano): bbox completa lacunas; nunca sobrescreve valor com None
                idx = {(h.get("mes"), h.get("ano")): h for h in (out_v2.get("historico_13m_consumo") or [])}
                for hb in hist_bbox:
                    k = (hb["mes"], hb["ano"])
                    if k in idx:
                        cur = idx[k]
                        for fld in ("consumo_ponta_kwh","demanda_ponta_kw",
                                    "consumo_fponta_kwh","demanda_fponta_kw"):
                            # SÓ completa quando cur é None (0 é valor explícito da fatura)
                            if cur.get(fld) is None and hb.get(fld) is not None:
                                cur[fld] = hb[fld]
                        # _campos_nao_impressos: só marca os que continuaram None pós-merge
                        nao_imp_final = [f for f in ("consumo_ponta_kwh","demanda_ponta_kw",
                                                     "consumo_fponta_kwh","demanda_fponta_kw")
                                         if cur.get(f) is None]
                        if nao_imp_final:
                            cur["_campos_nao_impressos"] = nao_imp_final
                    else:
                        idx[k] = hb
                out_v2["historico_13m_consumo"] = list(idx.values())[:13]
        except Exception as e:
            out_v2["_historico_bbox_erro"] = str(e)[:200]

    # 16.4 Aplica mapa específico da distribuidora (regex calibrados em map/{dist}_extraction_map.json)
    mapa_nome = (out_v2.get("_mapa_usado") or "").lower()
    if mapa_nome and texto:
        try:
            from aplicar_mapa_distribuidora import aplicar_mapa
            stats = aplicar_mapa(out_v2, texto, mapa_nome)
            if stats and stats.get("campos_preenchidos"):
                out_v2["_mapa_dist_aplicado"] = {
                    "mapa": mapa_nome,
                    "campos_preenchidos": stats["campos_preenchidos"],
                    "qtd": len(stats["campos_preenchidos"]),
                }
        except Exception as e:
            out_v2["_mapa_dist_erro"] = str(e)[:200]

    # 16.4.05 Hidrata distribuidora a partir do mapa detectado (quando DANF3E
    # não imprime CNPJ no plumber, ex: Enel SP, Light, ou bug detectou CNPJ cliente)
    # Caso especial: mapa 'celesc' pode estar sendo usado pra COPEL (estrutura similar).
    # Detecta no texto qual é a real e escolhe hardcoded certo.
    mapa_efetivo = mapa_nome
    if mapa_nome == "celesc" and texto and re.search(r"COPEL\s+DISTRIBUI[ÇC][ÃA]O", texto, re.I):
        mapa_efetivo = "copel"
    if mapa_efetivo in _DIST_HARDCODED:
        dist_d = out_v2.setdefault("distribuidora", {})
        hc = _DIST_HARDCODED[mapa_efetivo]
        # Se a razão social está vazia OU o CNPJ atual = CNPJ cliente (bug de detecção),
        # substitui pelos valores hardcoded
        cnpj_atual = dist_d.get("cnpj_emissor") or ""
        cnpj_cliente = (out_v2.get("cliente") or {}).get("cnpj") or ""
        cnpj_errado = bool(cnpj_atual and cnpj_atual == cnpj_cliente)
        if not dist_d.get("razao_social"):
            dist_d["razao_social"] = hc["razao_social"]
        if not dist_d.get("cnpj_emissor") or cnpj_errado:
            if cnpj_errado:
                dist_d["_cnpj_anterior_descartado"] = cnpj_atual
            dist_d["cnpj_emissor"] = hc["cnpj_emissor"]
        if not dist_d.get("ie_emissor"):
            dist_d["ie_emissor"] = hc.get("ie_emissor")
        if not dist_d.get("uf_emissor"):
            dist_d["uf_emissor"] = hc.get("uf_emissor")
        dist_d["_fonte_hardcoded"] = mapa_nome

    # 16.4.1 Em famílias Enel: uc_codigo (do mapa) sempre vence codigo_instalacao
    # (scoring tende a pegar nº de controle Enel 12 dígitos OU código pagador 14+ dígitos)
    if mapa_nome.startswith("enel"):
        ident = out_v2.setdefault("identificadores_instalacao", {})
        uc_cod = ident.get("uc_codigo")
        cod_inst = ident.get("codigo_instalacao") or ""
        if uc_cod and str(uc_cod) != str(cod_inst):
            if cod_inst and not ident.get("codigo_pagador"):
                # Heurística: 13+ dígitos = código pagador; 12 = nº controle
                if re.match(r"^\d{13,}$", str(cod_inst)):
                    ident["codigo_pagador"] = cod_inst
                else:
                    ident["_codigo_instalacao_anterior"] = cod_inst
            ident["codigo_instalacao"] = str(uc_cod)
            ident["_codigo_instalacao_fonte"] = "mapa_enel_uc"
        dist_d["_fonte_hardcoded"] = mapa_efetivo

    # 16.5 Cruzamento Regex ↔ BBox — quando soma_itens não bate com TOTAL,
    # roda extração posicional via PyMuPDF e completa itens faltantes
    if pdf_path and isinstance(out_v2.get("itens_fatura"), list):
        try:
            _cruzar_itens_bbox(out_v2, pdf_path)
        except Exception as e:
            out_v2["_cruzamento_erro"] = str(e)[:200]

    # 16.6 Cross-check SEFAZ NF3e (Modo C: batch-once + cache permanente)
    # Detecta chave 44 dígitos no texto → consulta SEFAZ (cache local SQLite) →
    # adiciona seção _sefaz_validacao. Não-bloqueante: falha silenciosa.
    try:
        chave_nf3e = extrair_chave_nf3e_do_texto(texto_combo)
        # Fallback: PDF com fonte corrompida (cid:xxx) — ler QR Code do PDF
        if not chave_nf3e and pdf_path:
            chave_nf3e = extrair_chave_nf3e_do_qrcode(pdf_path)
            if chave_nf3e:
                out_v2["_chave_nf3e_fonte"] = "qr_code"
        if chave_nf3e:
            out_v2["_chave_nf3e_detectada"] = chave_nf3e
            from consultar_nf3e_sefaz import consultar_nf3e, chave_valida
            if chave_valida(chave_nf3e):
                dados_sefaz = consultar_nf3e(chave_nf3e)
                if not dados_sefaz.get("_erro"):
                    # Cross-check valor total
                    vt_sefaz = dados_sefaz.get("valor_total_liquido_numerico")
                    vt_ext_str = (out_v2.get("vencimento_valor") or {}).get("valor_total") or ""
                    try:
                        vt_ext = float(str(vt_ext_str).replace(".", "").replace(",", "."))
                    except: vt_ext = None
                    diff_valor = None
                    if vt_sefaz is not None and vt_ext is not None:
                        diff_valor = round(vt_ext - vt_sefaz, 2)

                    # Cross-check qtd itens
                    qtd_sefaz = dados_sefaz.get("qtd_itens", 0)
                    qtd_ext = len(out_v2.get("itens_fatura") or [])

                    # Divergências detectadas
                    divs = []
                    if diff_valor is not None and abs(diff_valor) > 0.05:
                        divs.append({
                            "tipo": "valor_total_divergente",
                            "sefaz": vt_sefaz,
                            "extracao": vt_ext,
                            "diff": diff_valor,
                        })
                    if qtd_sefaz and qtd_ext and qtd_sefaz != qtd_ext:
                        divs.append({
                            "tipo": "qtd_itens_divergente",
                            "sefaz": qtd_sefaz,
                            "extracao": qtd_ext,
                        })

                    out_v2["_sefaz_validacao"] = {
                        "chave_acesso": chave_nf3e,
                        "consultado": True,
                        "fonte": dados_sefaz.get("_fonte"),
                        "from_cache": dados_sefaz.get("_from_cache", False),
                        "valor_total_sefaz": vt_sefaz,
                        "valor_total_extracao": vt_ext,
                        "valor_diff": diff_valor,
                        "valor_consistente": diff_valor is not None and abs(diff_valor) <= 0.05,
                        "qtd_itens_sefaz": qtd_sefaz,
                        "qtd_itens_extracao": qtd_ext,
                        "qtd_consistente": qtd_sefaz == qtd_ext if (qtd_sefaz and qtd_ext) else None,
                        "data_emissao_sefaz": dados_sefaz.get("data_emissao"),
                        "protocolo_sefaz": dados_sefaz.get("protocolo_autorizacao"),
                        "divergencias": divs,
                    }
                else:
                    out_v2["_sefaz_validacao"] = {
                        "chave_acesso": chave_nf3e,
                        "consultado": False,
                        "_erro": dados_sefaz.get("_erro"),
                    }
            else:
                out_v2["_sefaz_validacao"] = {
                    "chave_acesso": chave_nf3e,
                    "consultado": False,
                    "_erro": "chave_invalida_ou_nao_nf3e",
                }
    except Exception as e:
        out_v2["_sefaz_erro"] = str(e)[:200]

    # 16.7 SEFAZ como fonte autoritativa de valor_total quando disponível e coerente.
    # SEFAZ NF3e retorna LÍQUIDO em Enel/MT (CCI 5603/5604 = créditos GD com sinal),
    # mas BRUTO em Light (CCI 0603 sem sinal). Sobrescreve só se diff ≤ 10%.
    # Diff > 10%: marca _sefaz_diverge_alta pra revisão manual.
    sv = out_v2.get("_sefaz_validacao") or {}
    if sv.get("consultado") and sv.get("valor_total_sefaz") is not None:
        vv_after = out_v2.get("vencimento_valor") or {}
        try:
            pdf_v = float(str(vv_after.get("valor_total") or "0").replace(".", "").replace(",", "."))
        except: pdf_v = None
        sefaz_v = sv["valor_total_sefaz"]
        if pdf_v is not None and pdf_v > 0 and sefaz_v > 0:
            diff_pct = abs(pdf_v - sefaz_v) / max(pdf_v, sefaz_v)
            # GUARDRAIL: o "total a pagar" do PDF SEMPRE vence. O SEFAZ (vNF) pode trazer
            # o BRUTO antes de subvenção/devolução/compensação GD, divergindo legitimamente
            # (ex.: A3A rural com subvenção → SEFAZ 6.306,42 vs PDF 6.115,72). Não sobrescrever:
            # manter o PDF como valor_total e guardar o SEFAZ só como cross-check + divergência.
            if abs(pdf_v - sefaz_v) > 0.01:
                vv_after["_valor_total_sefaz"] = sefaz_v
                vv_after["_sefaz_diverge"] = {
                    "pdf": pdf_v, "sefaz": sefaz_v, "diff_pct": round(diff_pct * 100, 1),
                    "_obs": "Total do PDF mantido (total a pagar); SEFAZ pode ser bruto (subvenção/GD)",
                }

    # 16.9 Detecta layout_template_id ANTES do validador (via OCR/combo). Necessário
    # pra dists cujo nome só aparece no logo (ex: Light) — assim o check de indicadores
    # consegue dar SKIP mesmo quando _mapa_usado não foi resolvido.
    if not out_v2.get("_layout_template_id"):
        try:
            from detector_layout import detectar_layout
            lt_id = detectar_layout(texto_combo, mapa_pipeline=out_v2.get("_mapa_usado"))
            if lt_id:
                out_v2["_layout_template_id"] = lt_id
        except Exception:
            pass

    # 17. Validador de qualidade fatura-completa (score + gate + divergências) — POR ÚLTIMO
    try:
        from validador_fatura import validar_fatura_completa
        out_v2["_qualidade"] = validar_fatura_completa(out_v2)
    except Exception as e:
        out_v2["_qualidade_erro"] = str(e)[:200]

    # ─── PROPAGAÇÕES FINAIS (fixes da sessão 2026-05-29) ─────────────────────
    # 18.1 Enriquecer com origem sgeeasy_clientes_novo (fallback p/ campos NULL)
    if uid:
        try:
            origem = enriquecer_via_origem_sgeeasy(uid)
            if origem:
                out_v2["_origem_sgeeasy"] = origem
                rvv = out_v2.setdefault("referencia_vencimento_valor", {})
                if origem.get("data_vencimento"): rvv["data_vencimento_origem"] = origem["data_vencimento"]
                if origem.get("valor_total_fatura"): rvv["valor_total_origem"] = origem["valor_total_fatura"]
                if origem.get("mes_referencia"): rvv["mes_referencia_origem"] = origem["mes_referencia"]
                # OVERRIDE cadastral/identificação pela ORIGEM (autoritativa; parse é não-confiável
                # p/ esses — audit 19/06: instalação=nº cliente/barras, venc=emissão, cnpj=dist).
                # Fiscais (total/tributos/itens) NÃO são tocados (ficam pro cross-check/SEFAZ).
                _fmt = lambda d: (d.strftime("%d/%m/%Y") if hasattr(d, "strftime") else str(d))
                _ovv = out_v2.setdefault("vencimento_valor", {})
                if origem.get("data_vencimento"):
                    _ovv["data_vencimento"] = _fmt(origem["data_vencimento"]); _ovv["_data_vencimento_fonte"] = "origem"
                _oid = out_v2.setdefault("identificadores_instalacao", {})
                if origem.get("codigo_instalacao"):
                    _oid["codigo_instalacao"] = origem["codigo_instalacao"]; _oid["_codigo_instalacao_fonte"] = "origem"
                if origem.get("conta_contrato") and not _oid.get("conta_contrato"): _oid["conta_contrato"] = origem["conta_contrato"]
                _ocli = out_v2.setdefault("cliente", {})
                if origem.get("razao_social"):
                    _ocli["razao_social"] = origem["razao_social"]; _ocli["_razao_social_fonte"] = "origem"
                if origem.get("cnpj_cliente"):   # OVERRIDE (parse pega CNPJ da distribuidora)
                    _ocli["cnpj_cliente"] = origem["cnpj_cliente"]; _ocli["_cnpj_cliente_fonte"] = "origem"
                _ocl = out_v2.setdefault("classificacao", {})
                if origem.get("modalidade_tarifaria") and not _ocl.get("modalidade_tarifaria"): _ocl["modalidade_tarifaria"] = origem["modalidade_tarifaria"]
                if origem.get("classe_consumo") and not _ocl.get("classe_consumo"): _ocl["classe_consumo"] = origem["classe_consumo"]
                if origem.get("mes_referencia") and not (_ovv.get("mes_ref") or _ovv.get("mes_referencia")): _ovv["mes_ref"] = origem["mes_referencia"]
        except Exception as e:
            out_v2["_origem_sgeeasy_erro"] = str(e)[:120]

    # 18.2 Subvenção ICMS Enel SP — flag pra atualizar_colunas_db zerar tributos NULL
    if detectar_subvencao_tributos(texto):
        out_v2["_icms_subvencao_detectada"] = True

    # 18.3 Fator potência status (derivado de ERE + subgrupo)
    try:
        sg = (out_v2.get("ligacao_tecnica") or {}).get("subgrupo") \
             or (out_v2.get("classificacao") or {}).get("subgrupo")
        ere = (out_v2.get("reativos_a3") or {}).get("consumo_reativo_excedente_kvarh") \
              or out_v2.get("consumo_reativo_excedente_kvarh")
        out_v2["_fator_potencia_status"] = derivar_fator_potencia_status(ere, sg)
    except Exception: pass

    # 18.4 Flag legado pré-2023 (calculado AFTER qualidade pra ter o gate)
    try:
        mes_ref = (out_v2.get("referencia_vencimento_valor") or {}).get("mes_referencia") \
                  or out_v2.get("mes_referencia")
        data_emiss = (out_v2.get("referencia_vencimento_valor") or {}).get("data_emissao") \
                     or out_v2.get("data_emissao_nf")
        gate = (out_v2.get("_qualidade") or {}).get("gate")
        out_v2["_flag_legado_pre_2023"] = derivar_flag_legado_pre_2023(mes_ref, data_emiss, gate)
    except Exception: pass

    # 18.45 IDs Light RJ (codigo_instalacao + codigo_cliente + conta_contrato)
    # Layout Light tem 3 IDs distintos que o extrator genérico confunde.
    try:
        dist = (out_v2.get("distribuidora") or {}).get("razao_social", "") or ""
        if "LIGHT" in dist.upper() or re.search(r"60\.444\.437/0001", texto, re.I):
            ids_light = extrair_ids_light_rj(texto)
            if ids_light:
                ident = out_v2.setdefault("identificadores_instalacao", {})
                # conta_contrato → codigo_uc (campo principal de cobrança Light)
                if ids_light.get("conta_contrato"):
                    ident["conta_contrato"] = ids_light["conta_contrato"]
                    ident.setdefault("codigo_uc", ids_light["conta_contrato"])
                if ids_light.get("codigo_instalacao"):
                    ident["codigo_instalacao"] = ids_light["codigo_instalacao"]
                if ids_light.get("codigo_cliente"):
                    ident["codigo_cliente"] = ids_light["codigo_cliente"]
                out_v2["_light_ids_extraidos"] = ids_light
    except Exception as e:
        out_v2["_light_ids_erro"] = str(e)[:120]

    # 18.46 Tarifas unitárias por componente (TE/TUSD/Demanda/Fio B/COSIP)
    try:
        itens_atuais = out_v2.get("itens_fatura") or []
        if itens_atuais:
            tarifas = derivar_tarifas_dos_itens(itens_atuais)
            if tarifas:
                out_v2["_tarifas_derivadas"] = tarifas
    except Exception as e:
        out_v2["_tarifas_derivadas_erro"] = str(e)[:120]

    # 18.5 Faturamento pela média + detector de acúmulo (Art. 86 REN 1.000)
    # — flag_faturamento_media: presença literal de "FATURAMENTO PELA MÉDIA/MÍNIMO"
    # — flag_acumulo_pos_media: consumo atual ≥ 3× média 12m anterior
    try:
        out_v2["_flag_faturamento_media"] = 1 if extrair_flag_faturamento_media(texto_combo) else 0
        hist = out_v2.get("historico_consumo") or []
        if not hist:
            # Tenta no JSON do hist Equatorial / universal
            hist = out_v2.get("_historico") or []
        consumo_atual = None
        # consumo_atual = ponta + fponta do mês corrente (campos do v2)
        try:
            p  = float((out_v2.get("consumo") or {}).get("ponta_kwh") or 0)
            fp = float((out_v2.get("consumo") or {}).get("fponta_kwh") or 0)
            if p + fp > 0:
                consumo_atual = p + fp
        except Exception: pass
        d_acum = detectar_acumulo_pos_media(hist, consumo_atual)
        out_v2["_flag_acumulo_pos_media"]    = d_acum.get("flag_acumulo", 0)
        out_v2["_acumulo_ratio_pico_media"] = d_acum.get("ratio_pico_media")
        out_v2["_acumulo_media_12m_kwh"]    = d_acum.get("media_12m_kwh")
    except Exception as e:
        out_v2["_acumulo_erro"] = str(e)[:120]

    return out_v2


if __name__ == "__main__":
    import sys, pdfplumber
    pdf = sys.argv[1] if len(sys.argv) > 1 else "_user_fatura.pdf"
    with pdfplumber.open(pdf) as p:
        texto = "\n".join((pg.extract_text() or "") for pg in p.pages)
    print("=== Cliente UC ===");          print(extrair_cliente_uc(texto))
    print("=== Vencimento Valor ===");    print(extrair_vencimento_valor(texto))
    print("=== mUC/oUC ===");             print(classificar_mUC_oUC(texto, []))
    print("=== Histórico ===")
    for h in extrair_historico_consumo_energisa(texto)[:5]: print(f"  {h}")
    print("=== Indicadores ===");         print(extrair_indicadores_extra(texto))
    print("=== Cod Instalação ===");      print(extrair_codigo_instalacao(texto))
