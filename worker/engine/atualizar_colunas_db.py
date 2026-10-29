"""Popula colunas individuais da FATURA_DADOS_EXTRAIDOS a partir do out_v2.

Hoje o pipeline grava só em `extracao_raw_json` (coluna JSON). Este módulo
mapeia os campos do dict out_v2 pras colunas SQL individuais, fazendo
UPDATE não-destrutivo (só preenche colunas vazias).

Uso:
    from atualizar_colunas_db import atualizar_colunas_individuais
    atualizar_colunas_individuais(conn, fatura_id, out_v2, sobrescrever=False)
"""
from __future__ import annotations
import json
import re
import os
from typing import Any

TBL_FDE = os.environ.get("FDE_TABLE", "FATURA_DADOS_EXTRAIDOS")  # env FDE_TABLE redireciona p/ COPIA (default=produção)

# Sentinel pra forçar UPDATE com NULL real (sobrescreve lixo do regex v1).
# Usar como retorno do _coleta_campos quando blacklist limpou o valor.
_FORCE_NULL = "__SET_NULL__"


def _get(d: dict, path: str, default=None):
    """Acessa d['a']['b']['c'] via 'a.b.c'."""
    cur = d
    for k in path.split("."):
        if not isinstance(cur, dict):
            return default
        cur = cur.get(k)
        if cur is None:
            return default
    return cur


def _to_float(v: Any) -> float | None:
    """Converte valor BR/US para float em R$ via parse_brl canônico.

    parse_brl interpreta corretamente "1.234,56" (BR), "1234.56" (US) e
    "5.79250" (OCR sem vírgula → 5.792,50). Rejeita valores acima de R$10M
    (limite plausível) — protege contra confusão milhar/decimal.
    """
    from extrator_complementar import parse_brl
    return parse_brl(v)


def _to_int(v: Any) -> int | None:
    f = _to_float(v)
    return int(f) if f is not None else None


def _mes_ref_para_date(s: str) -> str | None:
    """'MM/AAAA' ou '04/2026' → 'AAAA-MM-01' (date SQL)."""
    if not s: return None
    m = re.match(r"^(\d{1,2})/(\d{4})$", str(s).strip())
    if m:
        return f"{m.group(2)}-{int(m.group(1)):02d}-01"
    # Formato 'ABR/2025' ou 'Abril/2025'
    meses = {"jan":1,"fev":2,"mar":3,"abr":4,"mai":5,"jun":6,
             "jul":7,"ago":8,"set":9,"out":10,"nov":11,"dez":12,
             "janeiro":1,"fevereiro":2,"março":3,"marco":3,"abril":4,"maio":5,"junho":6,
             "julho":7,"agosto":8,"setembro":9,"outubro":10,"novembro":11,"dezembro":12}
    m = re.match(r"^([A-Za-zçÇ]+)/(\d{4})$", str(s).strip())
    if m:
        nome = m.group(1).lower().replace("ç", "c")
        mn = meses.get(nome) or meses.get(nome[:3])
        if mn:
            return f"{m.group(2)}-{mn:02d}-01"
    return None


def _data_br_para_iso(s: str) -> str | None:
    """'DD/MM/AAAA' → 'AAAA-MM-DD'."""
    if not s: return None
    m = re.match(r"^(\d{2})/(\d{2})/(\d{4})", str(s).strip())
    if m:
        return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    return None


# Palavras-lixo que indicam que a string é um LABEL do PDF, não nome de cliente.
# Se QUALQUER uma dessas aparecer na string, ela é rejeitada como razão social.
_RAZAO_PALAVRAS_LIXO = {
    "ENDERECO", "ENDEREÇO", "ENDEREGO",  # variações OCR (com/sem cedilha, G no lugar de Ç)
    "UNIDADE", "CONSUMIDORA", "CONSUMIDOR",
    "DOMICILIO", "DOMICÍLIO",
    "INSTALACAO", "INSTALAÇÃO",
    "CODIGO", "CÓDIGO",
    "RUA", "AVENIDA", "AV.", "ESTRADA", "RODOVIA", "ROD.", "TRAVESSA",
    "CEP", "BAIRRO", "QUADRA", "LOTE",
    "REFERENCIA", "REFERÊNCIA", "MES", "MÊS",
    "NOME DO CLIENTE", "RAZÃO SOCIAL", "RAZAO SOCIAL",
    "FAZENDA", "SITIO", "KM",  # comum em endereços rurais
}

# Sufixos empresariais válidos (alta confiança de razão social)
_RAZAO_SUFIXOS_VALIDOS = (
    "LTDA", "S.A.", "S/A", "S.A", "SA", "EIRELI", "ME", "EPP", "MEI",
    "COOPERATIVA", "ASSOCIAÇÃO", "ASSOCIACAO", "S.S.", "S/S",
)


def _eh_razao_valida(nome: str) -> bool:
    """Valida semanticamente se a string parece razão social.

    Aceita se:
      1) Termina em sufixo empresarial (LTDA/S.A./etc.)
      2) OU é pessoa física (2+ palavras, nenhuma palavra-lixo, sem dígitos)

    Rejeita se contém qualquer palavra-lixo (ENDEREÇO, UNIDADE, RUA, etc.)
    """
    if not nome or len(nome.strip()) < 4:
        return False
    nome_up = nome.upper().strip()

    # Tem dígito? Provavelmente é endereço/código
    if re.search(r"\d", nome_up):
        return False

    # Contém palavra-lixo? Não é razão social
    for lixo in _RAZAO_PALAVRAS_LIXO:
        if lixo in nome_up:
            return False

    # Sufixo empresarial: alta confiança
    for suf in _RAZAO_SUFIXOS_VALIDOS:
        if nome_up.endswith(suf) or nome_up.endswith(suf + ".") or (" " + suf + " ") in nome_up:
            return True

    # Pessoa física: 2+ palavras
    palavras = nome_up.split()
    if len(palavras) >= 2 and all(len(p) >= 2 for p in palavras):
        return True

    return False


def _consumo_gd_override(itens):
    """Consumo correto de UC com GD (Grupo B), espelhando o backfill validado.
    CEMIG: Energia Elétrica + SCEE (itens de energia com valor >= 0).
    Light: 'Energia Fornecida GD' de UMA parcela (TUSD==TE → não dobra).
    Retorna None quando não é GD reconhecido ou é Grupo A (tem posto HP/HFP)."""
    up = lambda s: (s or "").upper()
    descs = [up(it.get("descricao")) for it in itens]
    tem_scee = any("SCEE" in d for d in descs)
    tem_forn = any(("FORNECID" in d and "GD" in d) for d in descs)
    tem_posto = any((" HP" in d or " HFP" in d or " HR" in d or "PONTA" in d) for d in descs)
    if tem_posto or not (tem_scee or tem_forn):
        return None
    if tem_scee:  # CEMIG: EE + SCEE positivos
        tot, ok = 0.0, False
        for it in itens:
            d = up(it.get("descricao")); q = it.get("quantidade_numerica")
            if q is None:
                continue
            if ("ENERGIA EL" in d or "SCEE" in d) and "INJET" not in d and "COMPENSAD" not in d:
                v = it.get("valor_brl_numerico")
                try:
                    if v is not None and float(v) < 0:
                        continue
                except Exception:
                    pass
                tot += q; ok = True
        return round(tot, 2) if ok else None
    if tem_forn:  # Light B: Fornecida GD, uma parcela (maior; TUSD==TE)
        m, ok = 0.0, False
        for it in itens:
            d = up(it.get("descricao")); q = it.get("quantidade_numerica")
            if q is None:
                continue
            if "FORNECID" in d and "GD" in d:
                m = max(m, q); ok = True
        return round(m, 2) if ok else None
    return None


def _coleta_campos(out_v2: dict) -> dict:
    """Mapeia out_v2 → dict {coluna: valor} pra UPDATE SQL.

    REGRA: prioriza `ligacao_tecnica` (extrator atual) sobre `classificacao` (legado).
    Pra tributos: prioriza `tributos_agregados_itens` (calculado, coerente)
                  sobre `tributos_por_dist` (regex bruto, às vezes invertido).
    """
    import datetime as _dt
    cli = out_v2.get("cliente") or {}
    ident = out_v2.get("identificadores_instalacao") or {}
    clf = out_v2.get("classificacao") or {}
    lt = out_v2.get("ligacao_tecnica") or {}
    pl = out_v2.get("periodo_leitura") or {}
    vv = out_v2.get("vencimento_valor") or {}
    tpd = out_v2.get("tributos_por_dist") or {}
    tpd_agg = out_v2.get("tributos_agregados_itens") or {}
    ttl_linha = out_v2.get("tributos_total_linha") or {}
    totais_itens = out_v2.get("totais_tabela_itens") or {}
    gd = out_v2.get("geracao_distribuida") or {}
    aud_gd = out_v2.get("auditoria_gd") or {}
    ind_qual = out_v2.get("indicadores_qualidade") or {}
    nf = out_v2.get("nota_fiscal") or {}
    dist = out_v2.get("distribuidora") or {}

    pis = tpd.get("pis") or {}
    cofins = tpd.get("cofins") or {}
    icms = tpd.get("icms") or {}
    pis_cof = tpd.get("pis_cofins") or {}
    icms_agg = (tpd_agg.get("icms_liquido") or {}) or (tpd_agg.get("icms_agregado") or {})
    pis_cofins_agg = (tpd_agg.get("pis_cofins_liquido") or {}) or (tpd_agg.get("pis_cofins_agregado") or {})

    # Hist 13m (JSON)
    hist = out_v2.get("historico_13m_consumo") or []

    # ── Agrega consumo dos itens_fatura (Grupo A e B) ──
    # Grupo A: "Consumo em kWh - Ponta" e "Consumo em kWh - Fora Ponta" (Energisa MT)
    #          "CONSUMO P", "CONSUMO FP", "CONSUMO HR" (Equatorial Goiás A3A)
    #          "TUSD ENERGIA PONTA TUSD", "TUSD ENERGIA FORA DE PONTA TUSD" (Elektro A4 Verde)
    # Grupo B: "Consumo em kWh" puro → vai pro _fponta (convenção)
    itens = out_v2.get("itens_fatura") or []
    consumo_p = consumo_fp = energia_compensada = 0.0
    tem_consumo_p = tem_consumo_fp = tem_compensada = False
    # Dedup TE/TUSD (bug double-count confirmado CELESC/Copel Grupo A, jul/2026):
    # "Consumo Ponta TE" e "Consumo Ponta TUSD" carregam o MESMO kWh no MESMO posto —
    # a grandeza física é uma só, faturada em duas parcelas tarifárias. Somar as duas
    # dobra o consumo. Regra validada: soma das quantidades DISTINTAS por posto.
    _seen_kwh = {"p": set(), "fp": set()}
    def _add_consumo(bucket, q):
        nonlocal consumo_p, consumo_fp, tem_consumo_p, tem_consumo_fp
        chave = round(float(q), 2)
        if chave in _seen_kwh[bucket]:
            return  # TE/TUSD (mesmo posto, mesmo kWh) já contabilizado — não dobra
        _seen_kwh[bucket].add(chave)
        if bucket == "p":
            consumo_p += q; tem_consumo_p = True
        else:
            consumo_fp += q; tem_consumo_fp = True
    for it in itens:
        desc_up = (it.get("descricao") or "").upper()
        qtd = it.get("quantidade_numerica")
        if qtd is None: continue
        # Energia compensada (créditos GD) — INJETADA/COMPENSADA. ATENÇÃO: "Energia
        # SCEE s/ ICMS" (CEMIG) é CONSUMO (energia compensada CONSUMIDA, valor +),
        # não crédito — o extrator marca eh_credito_gd=True nela por engano. Por
        # isso excluímos "SCEE" daqui (senão o consumo some e a compensada dobra).
        if (it.get("eh_credito_gd") or "INJET" in desc_up or "COMPENSAD" in desc_up) and "SCEE" not in desc_up:
            energia_compensada += abs(qtd)
            tem_compensada = True
            continue
        # Skip itens de bandeira, demanda, reativo, repercussão retroativa, etc.
        if any(s in desc_up for s in ("BANDEIRA", "DEMANDA", "REATIV", "UFER", "DMCR",
                                       "MULTA", "JUROS", "PARCELA", "CIP", "ILUM", "COSIP",
                                       "ENCARGO", "SUBSIDIO", "DESCONTO", "CONTRIB", "AJUSTE",
                                       "COFINS", "PIS", "PASEP", "ICMS", "REPERCUSSAO",
                                       "REPERCUSS")):
            continue
        # Identifica posto: ponta vs fora ponta
        if " - PONTA" in desc_up or " PONTA" in desc_up.split(" - ", 1)[-1] or "CONSUMO P " in desc_up + " " or desc_up.endswith(" P") or " PONTA TE" in desc_up or " PONTA TUSD" in desc_up:
            # ponta (não FORA PONTA)
            if "FORA" not in desc_up and "FPONTA" not in desc_up:
                _add_consumo("p", qtd)
                continue
        if "FORA PONTA" in desc_up or "FORA DE PONTA" in desc_up or "FPONTA" in desc_up or "CONSUMO FP" in desc_up or " FP " in desc_up + " ":
            _add_consumo("fp", qtd)
            continue
        # Sem distinção de posto → Grupo B → cai em _fponta
        if "CONSUMO" in desc_up and "KWH" in desc_up:
            _add_consumo("fp", qtd)

    # Fallback ACL/mercado livre (Ampla DEVEC, Enel, etc.): quando NENHUM consumo ativo foi
    # achado, o consumo vem da linha "Energia elét. adquirida <N>" (energia comprada da
    # comercializadora). A quantidade (kWh, 3 decimais) fica EMBUTIDA na descrição — o extrator
    # não isola quantidade_numerica desses itens. Só dispara com consumo_p/fp vazios (não duplica
    # com TUSD/energia ativa, que quando existem já populam acima).
    if not tem_consumo_p and not tem_consumo_fp:
        for it in itens:
            desc = it.get("descricao") or ""
            if not re.search(r"adquirid", desc, re.I):
                continue
            mq = re.search(r"adquirid\w*[\s\S]{0,90}?(\d[\d.]*,\d{3})(?![\d\-])", desc, re.I)
            if not mq:
                continue
            try:
                q = float(mq.group(1).replace(".", "").replace(",", "."))
            except ValueError:
                continue
            if q <= 0:
                continue
            du = desc.upper()
            if "FORA" in du or "FPONTA" in du:
                consumo_fp += q; tem_consumo_fp = True
            elif " PONTA" in du:
                consumo_p += q; tem_consumo_p = True
            else:
                consumo_fp += q; tem_consumo_fp = True

    # ── Override de consumo para GD (CEMIG SCEE / Light Fornecida GD, Grupo B) ──
    # Mesma lógica validada no backfill _backfill_gd_consumo.py: o consumo real de
    # uma UC com GD = energia consumida + compensada, NÃO só a "Energia Elétrica".
    # Gated por tokens SCEE/"Fornecida GD" e SÓ Grupo B (sem posto) → não afeta
    # outras distribuidoras nem faturas sem GD (retorna None → mantém o genérico).
    _gd = _consumo_gd_override(itens)
    if _gd is not None and _gd > (consumo_p + consumo_fp):
        consumo_p, tem_consumo_p = 0.0, False
        consumo_fp, tem_consumo_fp = round(_gd, 2), True

    # Saldo de crédito GD acumulado (P + FP)
    saldo_p = gd.get("saldo_acumulado_ponta_kwh") or 0
    saldo_fp = gd.get("saldo_acumulado_fora_ponta_kwh") or 0
    saldo_total = (saldo_p or 0) + (saldo_fp or 0)

    # ── Subgrupo: prioriza ligacao_tecnica (atual), fallback classificacao (legado) ──
    subgrupo_val = lt.get("subgrupo") or clf.get("subgrupo")
    modalidade_val = lt.get("modalidade_tarifaria") or clf.get("modalidade_tarifaria")
    classe_val = lt.get("classe") or clf.get("classe_consumo")
    # Fix G: fallback classe — extrai do texto plumber se v2 não pegou
    txt_p = out_v2.get("_texto_plumber") or ""
    if not classe_val and txt_p:
        try:
            from extrator_complementar import extrair_classe_consumo_universal
            classe_extra = extrair_classe_consumo_universal(txt_p)
            if classe_extra:
                classe_val = classe_extra
        except Exception:
            pass
    # Fix G: fallback subgrupo — extrai do texto plumber se v2 não pegou
    if not subgrupo_val and txt_p:
        try:
            from extrator_complementar import extrair_subgrupo_universal
            sub_extra = extrair_subgrupo_universal(txt_p)
            if sub_extra:
                subgrupo_val = sub_extra
        except Exception:
            pass
    # Tensao: prioriza nominal_v (numérico), fallback tipo_ligacao (TRIFASICO/MONOFASICO)
    tensao_val = (lt.get("tensao_nominal_v") or lt.get("tensao_nominal")
                  or lt.get("tipo_ligacao") or lt.get("tipo_fornecimento"))

    # ── Razão social: validação SEMÂNTICA (não enumeração de blacklist) ──
    # Aceita apenas strings que parecem razão social (sufixo LTDA/S.A./etc.
    # ou pessoa física 2+ palavras). Rejeita labels do PDF mesmo com OCR ruim.
    razao_v2 = (cli.get("razao_social") or "").strip()
    razao_bloqueada = bool(razao_v2) and not _eh_razao_valida(razao_v2)
    if razao_bloqueada:
        razao_v2 = ""

    # Fallback 1: domicilio_entrega.razao_social
    if not razao_v2:
        cand = ((out_v2.get("domicilio_entrega") or {}).get("razao_social") or "").strip()
        if cand and _eh_razao_valida(cand):
            razao_v2 = cand
        elif cand:
            razao_bloqueada = True

    # Fallback 2: bloco PAGADOR ou primeira linha do PDF — Fix H
    if not razao_v2:
        try:
            from extrator_complementar import extrair_nome_cliente_pagador
            texto_plumber = out_v2.get("_texto_plumber") or ""
            nome_pag = extrair_nome_cliente_pagador(texto_plumber) if texto_plumber else None
            if nome_pag and _eh_razao_valida(nome_pag):
                razao_v2 = nome_pag
                razao_bloqueada = False
        except Exception:
            pass

    # Se nada válido e tinha lixo, sentinel força NULL no SQL
    razao_final = razao_v2 if razao_v2 else (_FORCE_NULL if razao_bloqueada else None)

    # ── ICMS: prioriza tributos_agregados_itens (coerente) sobre tributos_por_dist (às vezes invertido) ──
    icms_base = (icms_agg.get("base_numerico") if icms_agg.get("base_numerico") is not None
                 else _to_float(icms.get("base_string")))
    icms_val  = (icms_agg.get("valor_numerico") if icms_agg.get("valor_numerico") is not None
                 else _to_float(icms.get("valor_string")))
    icms_aliq = _to_float((icms_agg.get("aliquota_pct") or icms.get("aliquota_pct") or "").replace("%", ""))
    # Sanity: se base < valor, tributos estão invertidos — usar agg que é confiável
    if icms_base is not None and icms_val is not None and icms_base < icms_val:
        icms_base, icms_val = icms_val, icms_base

    # ── PIS/COFINS: prioriza tributos_agregados (combinado), fallback tributos_por_dist ──
    pis_val = _to_float(pis.get("valor_string"))
    cofins_val = _to_float(cofins.get("valor_string"))
    # Se PIS e COFINS separados não existem, mas agregado tem combinado, divide ~17.5%/82.5%
    if (pis_val is None and cofins_val is None) and pis_cofins_agg.get("valor_numerico") is not None:
        combo = pis_cofins_agg["valor_numerico"]
        # Razão típica PIS=0.83%, COFINS=3.81% → PIS ≈ 17.9% do combo, COFINS ≈ 82.1%
        pis_val = round(combo * 0.179, 2)
        cofins_val = round(combo - pis_val, 2)

    # ── Subvenção ICMS Enel SP (Decreto SP nº 64.255/2019) ──────────────────
    # Quando aplicar_complementos detectou subvenção, ICMS/PIS/COFINS NULL viram 0.00.
    if out_v2.get("_icms_subvencao_detectada"):
        if icms_val is None: icms_val = 0.00
        if pis_val is None:  pis_val  = 0.00
        if cofins_val is None: cofins_val = 0.00

    # ── Dias faturados: calcula de (data_atual - data_anterior) quando JSON tem datas (Fix C) ──
    dias_calc = None
    dia_ant = _data_br_para_iso(pl.get("leitura_anterior"))
    dia_atu = _data_br_para_iso(pl.get("leitura_atual"))
    if dia_ant and dia_atu:
        try:
            da = _dt.date.fromisoformat(dia_ant)
            dt_at = _dt.date.fromisoformat(dia_atu)
            dias_calc = (dt_at - da).days
            if dias_calc <= 0 or dias_calc > 90:  # sanity
                dias_calc = None
        except Exception:
            pass
    dias_final = dias_calc or _to_int(pl.get("dias_consumo"))

    # ── Subtotais ──
    subtot_fat = _to_float((out_v2.get("subtotais") or {}).get("subtotal_faturamento")
                            or totais_itens.get("valor_total"))
    subtot_out = _to_float((out_v2.get("subtotais") or {}).get("subtotal_outros"))

    # ── Aritmética (auditoria_gd) ──
    arit = (aud_gd.get("validacoes") or {})
    arit_total_calc = _to_float(arit.get("total_calculado") or arit.get("total_calculado_rs"))
    arit_diff_pct = _to_float(arit.get("diff_pct"))
    arit_ok = arit.get("aritmetica_ok") or arit.get("ok")
    if arit_ok is True: arit_ok = 1
    elif arit_ok is False: arit_ok = 0
    else: arit_ok = None

    # Fix G: numero_fatura — fallback do texto plumber pra layouts pré-DANF3E
    nf_val = (out_v2.get("nota_fiscal") or {}).get("numero_nf")
    if not nf_val:
        try:
            from extrator_complementar import extrair_nf_layout_antigo
            txt = out_v2.get("_texto_plumber") or ""
            nf_extra = extrair_nf_layout_antigo(txt) if txt else ""
            if nf_extra:
                nf_val = nf_extra
        except Exception:
            pass

    # ── DEC/FEC (indicadores ANEEL) ──
    def _to_dec(v):
        if v is None: return None
        try: return float(str(v).replace(",", "."))
        except: return None
    dec_h = _to_dec(ind_qual.get("regex_dic") or ind_qual.get("dic_anual"))
    fec_v = _to_dec(ind_qual.get("regex_fic") or ind_qual.get("fic_anual"))

    # Fix K: Grupo B não tem ponta/fora-ponta separadas — força _fp = NULL se igual ao _p
    # (defesa contra regex v1 que ainda duplica em alguns paths não cobertos pelos guards)
    eh_grupo_b = (subgrupo_val or "").startswith("B")

    # Passo 2 (25/05/2026): 6 colunas críticas universais — já estão no JSON, só persistir
    data_vencimento_iso = _data_br_para_iso(vv.get("data_vencimento"))
    endereco_uc_val     = cli.get("endereco_uc")
    cep_uc_val          = cli.get("cep_uc")
    conjunto_uc_val     = ind_qual.get("conjunto")
    dicri_val           = _to_float(ind_qual.get("regex_dicri") or ind_qual.get("dicri"))
    dmic_val            = _to_float(ind_qual.get("regex_dmic") or ind_qual.get("dmic"))

    # Passo 3 (25/05/2026): 4 colunas Energisa MT específicas
    edist = out_v2.get("_extras_dist") or {}
    perda_ramal_val     = _to_float(edist.get("perda_ramal_kwh"))
    subvencao_val       = _to_float(edist.get("subvencao_rs"))
    data_pagto_iso      = _data_br_para_iso(vv.get("data_pagamento") or edist.get("data_pagamento"))
    status_pagto_val    = vv.get("status_pagamento") or edist.get("status_pagamento")

    # 26/05/2026: Demanda Medida + Demanda Complementar (Art. 300) + flags Energisa
    # Consolidado em extracao_raw_json.regex_v3.v2._extras_dist (não há mais coluna separada).
    # `flag_telemetria_perda` continua coluna SQL TINYINT (filtro WHERE rápido).
    flag_telem_val = 1 if edist.get("flag_telemetria_perda") else None

    # 27/05/2026: 22 campos promovidos do JSON pra coluna (fiscal/NF3e, identificação,
    # técnico Grupo A, GD/distribuidora). Helpers locais.
    def _str_ou_join(v):
        if v is None: return None
        if isinstance(v, (list, tuple)): return " ".join(str(x) for x in v if x) or None
        s = str(v).strip()
        return s or None

    # Art.113 / RES.414 — consumo acumulado recuperado (acúmulo por falta de leitura).
    # O kWh desse item é o consumo acumulado que a distribuidora cobrou de uma vez.
    _kwh_art113 = 0.0
    _tem_art113 = False
    for _it in (out_v2.get("itens_fatura") or []):
        if isinstance(_it, dict) and re.search(r"art\.?\s*113|res\.?\s*414|res414", str(_it.get("descricao") or ""), re.I):
            _tem_art113 = True
            _q = _it.get("quantidade_numerica")
            if isinstance(_q, (int, float)) and _q > 0:
                _kwh_art113 += _q

    cols = {
        # Identificadores
        # Fix L (25/05/2026): codigo_uc prioriza codigo_cliente em layouts antigos sem uc_codigo
        # — evita bug codigo_uc == numero_instalacao (ambos caindo em codigo_instalacao)
        "codigo_uc":             ident.get("uc_codigo") or ident.get("codigo_cliente") or ident.get("codigo_instalacao"),
        "numero_instalacao":     ident.get("codigo_instalacao"),
        "numero_fatura":         nf_val,  # Fix G
        "numero_medidor":        ident.get("medidor"),
        # Cliente — com blacklist anti-label + sentinel _FORCE_NULL (Fix F)
        "nome_cliente":          razao_final,
        "cpf_cnpj":              cli.get("cnpj") or cli.get("cpf"),
        # Classificação — prioriza ligacao_tecnica (Fix A)
        "classe_consumidor":     classe_val,
        "subgrupo_tarifario":    subgrupo_val,
        "modalidade_tarifaria":  modalidade_val,
        "grupo_tarifario":       (subgrupo_val or "")[:1] if subgrupo_val else None,
        "tensao_fornecimento":   tensao_val,
        # Período
        "data_leitura_anterior": dia_ant,
        "data_leitura_atual":    dia_atu,
        "dias_faturados":        dias_final,                                       # Fix C
        "mes_referencia":        _mes_ref_para_date(vv.get("mes_ref") or vv.get("mes_referencia")),
        # Valores — SEFAZ prevalece quando disponível (XML assinado é fonte fiscal autoritativa)
        # Valor A PAGAR primeiro (= SEFAZ líquido, já com crédito de compensação
        # Art.323 subtraído em referencia_vencimento_valor; quando não há crédito,
        # é idêntico ao valor_total_sefaz). Fallbacks: SEFAZ bruto → total do PDF.
        "valor_total_fatura":    _to_float(
            (out_v2.get("referencia_vencimento_valor") or {}).get("valor_total_a_pagar")
            or (out_v2.get("_extras_sefaz") or {}).get("valor_total_sefaz")
            or vv.get("valor_total")
        ),
        "flag_fatura_revisao":   1 if out_v2.get("_flag_fatura_revisao") else 0,
        # valor de energia ativa (R$) = TE energia ativa do SEFAZ (fiscal) — base do
        # R$/kWh usado no ressarcimento. Antes ficava NULL (nunca era populado).
        "valor_energia_ativa":   _to_float(
            ((((out_v2.get("_extras_sefaz") or {}).get("classificacao_cci_sefaz") or {}).get("te_energia_ativa")) or {}).get("valor_total")
        ),
        "flag_acumulo_art113":   1 if _tem_art113 else 0,
        "kwh_acumulado_art113":  round(_kwh_art113, 2) if _kwh_art113 > 0 else None,
        "valor_total_origem":    ("sefaz" if (out_v2.get("_extras_sefaz") or {}).get("valor_total_sefaz") is not None else "extrator"),
        "qtd_itens_origem":      ("sefaz" if (out_v2.get("_extras_sefaz") or {}).get("qtd_itens_sefaz") is not None else "extrator"),
        # Tributos — prioriza tributos_agregados_itens (Fix A)
        "icms_base_calculo":     icms_base,
        "icms_aliquota":         icms_aliq,
        "icms_valor":            icms_val,
        "pis_aliquota":          _to_float((pis.get("aliquota_pct") or "").replace("%", "")),
        "pis_valor":             pis_val,
        "cofins_aliquota":       _to_float((cofins.get("aliquota_pct") or "").replace("%", "")),
        "cofins_valor":          cofins_val,
        # Bandeira — Fix I+J
        "tipo_bandeira_tarifaria": lt.get("bandeira_tarifaria"),
        "tipo_bandeira":           lt.get("bandeira_tarifaria"),
        "periodo_bandeira":        (lt.get("bandeira_periodo_inicio") + " a " + lt.get("bandeira_periodo_fim"))
                                    if lt.get("bandeira_periodo_inicio") and lt.get("bandeira_periodo_fim") else None,
        "valor_bandeira":          _to_float(lt.get("valor_bandeira")),
        "valor_bandeira_rs":       _to_float(lt.get("valor_bandeira")),
        # Consumo (agregado dos itens_fatura — Fix 2)
        "consumo_ativo_ponta_kwh":  consumo_p if tem_consumo_p else None,
        "consumo_ativo_fponta_kwh": consumo_fp if tem_consumo_fp else None,
        # kwh_total derivado dos postos (Fix 31/07: Grupo A total = ponta+fponta; o map do
        # extrator só preenche KWH_Total quando há total ÚNICO na fatura — em Grupo A fica
        # NULL, e gráfico/motor F01-F05/scanner de coerência liam 0 → falso-positivo de queda.
        # UPDATE é não-destrutivo (sobrescrever=False só preenche NULL), então NÃO toca total
        # já válido de Grupo B; só agrega quando o extrator deixou vazio e há consumo por posto.
        "kwh_total": (round(consumo_p + consumo_fp, 2)
                      if (tem_consumo_p or tem_consumo_fp) and (consumo_p + consumo_fp) > 0
                      else None),
        # Demanda contratada (Grupo A) — Fix 5
        "demanda_contratada_ponta_kw":  _to_float(lt.get("demanda_contratada_ponta_kw")),
        "demanda_contratada_fponta_kw": _to_float(lt.get("demanda_contratada_fponta_kw")),
        # GD
        "indicador_geracao_distribuida": 1 if gd.get("tem_gd") else 0,
        "energia_injetada_kwh":  _to_float(gd.get("energia_injetada_hfp") or gd.get("energia_injetada_hp")),
        "energia_compensada_kwh": energia_compensada if tem_compensada else None,  # Fix 3
        "saldo_credito_energia": saldo_total if saldo_total > 0 else None,         # Fix 1
        # JSONs
        "historico_consumo_json": json.dumps(hist, ensure_ascii=False, default=str) if hist else None,
        "itens_cobrados":        json.dumps(out_v2.get("itens_fatura") or [], ensure_ascii=False, default=str),
        # Distribuidora — Fix A (estava faltando o nome textual)
        "distribuidora":         (out_v2.get("distribuidora") or {}).get("razao_social"),
        "cnpj_distribuidora_filial": (out_v2.get("distribuidora") or {}).get("cnpj_emissor"),
        "uf_distribuidora":      (out_v2.get("distribuidora") or {}).get("uf_emissor"),
        # Subtotais — Fix A (fallback totais_tabela_itens)
        "subtotal_faturamento_rs": subtot_fat,
        "subtotal_outros_rs":      subtot_out,
        # Aritmética — Fix A
        "aritmetica_total_calculado_rs": arit_total_calc,
        "aritmetica_diff_pct":   arit_diff_pct,
        "aritmetica_ok":         arit_ok,
        # ANEEL DEC/FEC — Fix A
        "dec_anual_horas":       dec_h,
        "fec_anual_vezes":       fec_v,
        # Audit — gate acompanha o score (antes só o pipeline gravava validador_gate)
        # PROPAGAÇÃO #5 (29/05): se PIS+COFINS+ICMS extraídos (mesmo 0), forçar aprovado.
        # _qualidade.gate é conservador; aqui aplicamos critério determinístico ANEEL/SEFAZ.
        "validador_gate":           (
            "aprovado"
            if (pis_val is not None and cofins_val is not None and icms_val is not None)
            else (out_v2.get("_qualidade") or {}).get("gate")
        ),
        "extracao_score_confianca": (out_v2.get("_qualidade") or {}).get("score"),
        "extracao_versao":       "regex_v5_2026_05_25",
        # Passo 2 (25/05/2026): 6 colunas críticas universais
        "data_vencimento":       data_vencimento_iso,
        "endereco_uc":           endereco_uc_val,
        "cep_uc":                cep_uc_val,
        "conjunto_uc":           conjunto_uc_val,
        "dicri_horas":           dicri_val,
        "dmic_horas":            dmic_val,
        # Passo 3 (25/05/2026): 4 colunas Energisa MT específicas
        "perda_ramal_kwh":       perda_ramal_val,
        "subvencao_subsidio_rs": subvencao_val,
        "data_pagamento":        data_pagto_iso,
        "status_pagamento":      status_pagto_val,
        # 26/05/2026: Demanda Complementar Art. 300 + flags Energisa
        # _extras_dist mora em extracao_raw_json.regex_v3.v2 (NÃO coluna separada).
        # flag_telemetria_perda fica como TINYINT pra WHERE rápido.
        "flag_telemetria_perda":     flag_telem_val,
        # 29/05/2026: Propagações sessão (fator_potencia_status + flag_legado + origem fallback)
        "fator_potencia_status":     out_v2.get("_fator_potencia_status"),
        "flag_legado_pre_2023":      out_v2.get("_flag_legado_pre_2023"),
        # 29/05/2026: Detector acúmulo Art. 86 REN 1.000
        "flag_faturamento_media":    out_v2.get("_flag_faturamento_media"),
        "flag_acumulo_pos_media":    out_v2.get("_flag_acumulo_pos_media"),
        "acumulo_ratio_pico_media":  out_v2.get("_acumulo_ratio_pico_media"),
        "acumulo_media_12m_kwh":     out_v2.get("_acumulo_media_12m_kwh"),
        # 30/05/2026: IDs Light RJ — só sobrescreve quando o extrator Light captura.
        # Em faturas não-Light, _light_ids_extraidos não existe → mantém None (filtrado depois).
        # 27/05/2026: 22 campos promovidos do JSON pra coluna
        # — Fiscal / NF3e (chave: só dígitos, sem espaços/quebras)
        "chave_nfe":             (re.sub(r"\D", "", str(nf.get("chave_acesso"))) or None) if nf.get("chave_acesso") else None,
        "protocolo_autorizacao": _str_ou_join(nf.get("protocolo_autorizacao")),
        "data_emissao_nf":       _data_br_para_iso(nf.get("data_emissao")),
        "data_apresentacao":     _data_br_para_iso(nf.get("data_apresentacao")),
        "serie_nf":              _str_ou_join(nf.get("serie")),
        # — Identificação
        "roteiro_leitura":       _str_ou_join(ident.get("roteiro")),
        "matricula_cliente":     _str_ou_join(ident.get("matricula")),
        "domicilio_bancario":    _str_ou_join(ident.get("dom_bancario")),
        "ie_cliente":            _str_ou_join(cli.get("ie_cliente") or cli.get("ie")),
        "tipo_via":              _str_ou_join(cli.get("tipo_via")),
        # — Técnico Grupo A
        "tensao_contratada_v":   _to_float(ind_qual.get("tensao_contratada_v")),
        "tensao_minima_v":       _to_float(lt.get("tensao_min")),
        "tensao_maxima_v":       _to_float(lt.get("tensao_max")),
        "limite_adequado_min_v": _to_float(ind_qual.get("limite_adequado_min_v")),
        "limite_adequado_max_v": _to_float(ind_qual.get("limite_adequado_max_v")),
        # — GD / Distribuidora
        "saldo_gd_a_expirar":    _to_float(gd.get("saldo_a_expirar")),
        "saldo_gd_ponta_kwh":    _to_float(gd.get("saldo_acumulado_ponta_kwh")),
        "saldo_gd_fponta_kwh":   _to_float(gd.get("saldo_acumulado_fora_ponta_kwh")),
        "ie_distribuidora":      _str_ou_join(dist.get("ie_emissor")),
        "cep_distribuidora":     _str_ou_join(dist.get("cep_emissor")),
        "endereco_distribuidora": _str_ou_join(dist.get("endereco_emissor")),
        "cidade_uf_distribuidora": _str_ou_join(dist.get("cidade_uf_emissor")),
        # 27/05/2026: taxa de perda de transformação (% — Enel SP etc.) + apontamento
        "perda_transformacao_percentual": _to_float(edist.get("perda_transformacao_pct")),
        "flag_menciona_perda_transf":     1 if edist.get("_menciona_perda_transformacao") else None,
        # 28/05/2026: FG04 GD corrigido — fonte gd.* (sobrescreve copy-bug injetada↔compensada).
        # Quando _eh_gd_validado, usa o valor do fix (pode ser 0, válido); senão None (não toca).
        "energia_injetada_kwh":   _to_float(gd.get("energia_injetada_kwh")) if gd.get("_eh_gd_validado") else None,
        "energia_compensada_kwh": _to_float(gd.get("energia_compensada_kwh")) if gd.get("_eh_gd_validado") else None,
        "saldo_credito_energia":  _to_float(gd.get("saldo_credito_energia")),
        # FG04: validação real — só marca GD=1 se confirmado por item; senão preserva
        "indicador_geracao_distribuida": 1 if gd.get("_eh_gd_validado") else None,
        # 28/05/2026: GD mUC/oUC (Energisa MT)
        "energia_compensada_muc_kwh": _to_float(edist.get("energia_compensada_muc_kwh")),
        "energia_compensada_ouc_kwh": _to_float(edist.get("energia_compensada_ouc_kwh")),
        # 28/05/2026: A-3 Reativo (Grupo A)
        "fator_potencia":                _to_float(edist.get("fator_potencia")),
        "consumo_reativo_excedente_kvarh": _to_float(edist.get("consumo_reativo_excedente_kvarh")),
        "demanda_reativa_excedente_kvar": _to_float(edist.get("demanda_reativa_excedente_kvar")),
        "valor_energia_reativa_excedente": _to_float(edist.get("valor_energia_reativa_excedente")),
        "valor_demanda_reativa_excedente": _to_float(edist.get("valor_demanda_reativa_excedente")),
        "reativo_excedente_rs":          _to_float(edist.get("reativo_excedente_rs")),
        "leit_ant_reativa":              _to_float(edist.get("leit_ant_reativa")),
        "leit_atu_reativa":              _to_float(edist.get("leit_atu_reativa")),
        # 28/05/2026: TR-1 ICMS TE vs TUSD (LC 194/2022)
        "icms_base_te":   _to_float(edist.get("icms_base_te")),
        "icms_base_tusd": _to_float(edist.get("icms_base_tusd")),
        # 28/05/2026: CIP/COSIP — Contribuição de Iluminação Pública (isenta de ICMS)
        "cip_iluminacao_publica_rs": _to_float(edist.get("cip_iluminacao_publica_rs")),
        "valor_cip_cosip":           _to_float(edist.get("cip_iluminacao_publica_rs")),
        # 17/06/2026: leituras single-register (registro único — Grupo B). Especialista grava
        # pl['leit_ant_ativa']/['leit_atu_ativa']; cai em fponta (mesma convenção do consumo B).
        # Para não-B / sem valor → None → filtrado (não sobrescreve o caminho regex v1).
        "leit_ant_ativa_fponta":     _to_float(pl.get("leit_ant_ativa")),
        "leit_atu_ativa_fponta":     _to_float(pl.get("leit_atu_ativa")),
        # 28/05/2026: Composição do consumo (Geração/Transmissão/Distribuição/Tributos)
        "composicao_base_icms":      (json.dumps(edist.get("composicao_base_icms"), ensure_ascii=False)
                                       if edist.get("composicao_base_icms") else None),
        # 28/05/2026: Notificações de débitos vencidos (Equatorial GO + outras)
        "debitos_vencidos_qtd":      edist.get("debitos_vencidos_qtd"),
        "debitos_vencidos_periodo":  edist.get("debitos_vencidos_periodo"),
        "debitos_vencidos_valor_rs": _to_float(edist.get("debitos_vencidos_valor_rs")),
        "data_prevista_suspensao":   edist.get("data_prevista_suspensao"),
        "vrc_indicador_continuidade": edist.get("vrc_indicador_continuidade"),
        "cfop":                      edist.get("cfop"),
        "cfop_descricao":            edist.get("cfop_descricao"),
        # 28/05/2026: Pagamento canhoto pág 3
        "data_pagamento_canhoto":    edist.get("data_pagamento_canhoto"),
        "valor_pago_canhoto":        _to_float(edist.get("valor_pago_canhoto")),
        # 28/05/2026: Medição (array com 6 grandezas)
        "medicao_grandezas_json":    (json.dumps(edist.get("medicao_grandezas"), ensure_ascii=False)
                                       if edist.get("medicao_grandezas") else None),
        # 28/05/2026: Validação determinística (checks objetivos)
        "validacao_deterministica":  (json.dumps((out_v2.get("_validacao_deterministica") or {}), ensure_ascii=False)
                                       if out_v2.get("_validacao_deterministica") else None),
    }

    # 28/05/2026: SEFAZ NF3e — cross-check + enriquecimento
    esef = out_v2.get("_extras_sefaz") or {}
    if esef:
        cols.update({
            "cnpj_emissor_sefaz":          esef.get("cnpj_emissor_sefaz"),
            "ie_emissor_sefaz":            esef.get("ie_emissor_sefaz"),
            "protocolo_autorizacao_sefaz": esef.get("protocolo_autorizacao_sefaz"),
            "data_emissao_sefaz":          esef.get("data_emissao_sefaz"),
            "valor_total_sefaz":           _to_float(esef.get("valor_total_sefaz")),
            "qtd_itens_sefaz":             esef.get("qtd_itens_sefaz"),
            "cci_codigos_sefaz":           json.dumps(esef.get("cci_codigos_sefaz")) if esef.get("cci_codigos_sefaz") else None,
            "classificacao_cci_sefaz":     json.dumps(esef.get("classificacao_cci_sefaz"), ensure_ascii=False) if esef.get("classificacao_cci_sefaz") else None,
            "flag_divergencia_valor_sefaz":     esef.get("flag_divergencia_valor_sefaz"),
            "flag_divergencia_qtd_itens_sefaz": esef.get("flag_divergencia_qtd_itens_sefaz"),
            "sefaz_consultado_em":         esef.get("sefaz_consultado_em"),
        })

    # Fix K: força NULL nas leituras fora-ponta quando Grupo B (não tem ponta/FP separadas).
    # Defesa final contra duplicação gravada pelo regex v1 do passo 6.
    if eh_grupo_b:
        # 17/06/2026: só zera fponta quando NÃO há leitura single-register autoritativa
        # (o Fix K original zerava sempre, jogando fora a leitura real do registro único B).
        if not pl.get("leit_ant_ativa"):
            cols["leit_ant_ativa_fponta"] = _FORCE_NULL
        if not pl.get("leit_atu_ativa"):
            cols["leit_atu_ativa_fponta"] = _FORCE_NULL
        cols["leit_demanda_ponta"] = _FORCE_NULL
        cols["leit_demanda_fponta"] = _FORCE_NULL
        cols["demanda_faturada_ponta_kw"] = _FORCE_NULL
        cols["demanda_faturada_fponta_kw"] = _FORCE_NULL
        # consumo_ativo_ponta_kwh do v2 já é None pra B (calculado dos itens)
        # mas se regex v1 gravou indevidamente, força NULL aqui
        if not cols.get("consumo_ativo_ponta_kwh"):
            cols["consumo_ativo_ponta_kwh"] = _FORCE_NULL

        # Fallback consumo Grupo B: soma quantidades dos itens de energia ativa
        # (Light/CPFL/Elektro Via Varejo): o pipeline v2 não popula consumo_ativo_fponta_kwh
        # pra Grupo B; aqui somamos dos itens já extraídos.
        if not cols.get("consumo_ativo_fponta_kwh"):
            soma_kwh = 0.0
            _seen_b = set()  # dedup TE/TUSD (mesmo kWh) — não dobra o consumo
            for it in (out_v2.get("itens_fatura") or []):
                d = (it.get("descricao") or "").upper()
                u = (it.get("unidade") or "").upper()
                q = it.get("quantidade_numerica")
                if not q or u not in ("KWH",): continue
                if any(x in d for x in ("REPERCUSSAO", "REPERCUSS")): continue
                # Aceita: Consumo em kWh / Energia Elétrica / Custo de Disponibilidade
                if any(k in d for k in ("CONSUMO EM KWH", "ENERGIA EL", "CUSTO DE DISPONIB",
                                          "CONSUMO ENERGIA")):
                    chave = round(float(q), 2)
                    if chave in _seen_b: continue  # TE==TUSD já contabilizado
                    _seen_b.add(chave)
                    soma_kwh += float(q)
            if soma_kwh > 0:
                cols["consumo_ativo_fponta_kwh"] = round(soma_kwh, 2)

    # 30/05/2026: IDs Light RJ — sobrescreve campos genéricos quando Light extraiu.
    _light_ids = out_v2.get("_light_ids_extraidos") or {}
    if _light_ids.get("conta_contrato"):
        cols["codigo_uc"] = _light_ids["conta_contrato"]
    if _light_ids.get("codigo_instalacao"):
        cols["numero_instalacao"] = _light_ids["codigo_instalacao"]
    if _light_ids.get("codigo_cliente"):
        cols["matricula_cliente"] = _light_ids["codigo_cliente"]

    # 30/05/2026: Tarifas unitárias derivadas dos itens
    _tarifas = out_v2.get("_tarifas_derivadas") or {}
    for k in ("tarifa_te", "tarifa_te_ponta", "tarifa_tusd", "tarifa_tusd_ponta",
              "tarifa_demanda", "tarifa_demanda_ponta", "tarifa_demanda_fponta",
              "tarifa_fio_b", "tarifa_cosip"):
        if k in _tarifas:
            cols[k] = _tarifas[k]

    return cols


def atualizar_colunas_individuais(conn, fatura_id: int, out_v2: dict,
                                  sobrescrever: bool = False, commit: bool = True) -> dict:
    """Atualiza colunas individuais a partir de out_v2.

    Args:
        conn: conexão MySQL
        fatura_id: id da FATURA_DADOS_EXTRAIDOS
        out_v2: dict completo do aplicar_complementos
        sobrescrever: se False (default), só atualiza colunas NULL no banco.
                      Se True, sobrescreve tudo.

    Returns:
        dict {colunas_atualizadas: list, qtd: int}
    """
    cols_calculadas = _coleta_campos(out_v2)
    # Fix F: trata sentinel _FORCE_NULL — força UPDATE com NULL (limpa lixo do regex v1).
    # Valores None continuam sendo descartados (não tocam o banco).
    cols_to_set = {}
    for k, v in cols_calculadas.items():
        if v == _FORCE_NULL:
            cols_to_set[k] = None
        elif v is not None:
            cols_to_set[k] = v

    if not cols_to_set:
        return {"colunas_atualizadas": [], "qtd": 0, "_obs": "sem dados pra atualizar"}

    cur = conn.cursor(dictionary=True)
    if not sobrescrever:
        # Lê quais colunas estão NULL/vazias no banco — só atualiza essas
        colunas_str = ", ".join(f"`{c}`" for c in cols_to_set)
        cur.execute(f"SELECT {colunas_str} FROM {TBL_FDE} WHERE id=%s", (fatura_id,))
        atual = cur.fetchone() or {}
        cols_to_set = {k: v for k, v in cols_to_set.items() if not atual.get(k)}

    if not cols_to_set:
        cur.close()
        return {"colunas_atualizadas": [], "qtd": 0, "_obs": "todas as colunas já preenchidas (use sobrescrever=True)"}

    sets = ", ".join(f"`{c}`=%s" for c in cols_to_set)
    valores = list(cols_to_set.values()) + [fatura_id]
    cur.execute(f"UPDATE {TBL_FDE} SET {sets}, atualizado_em=NOW() WHERE id=%s", valores)
    if commit:
        conn.commit()
    cur.close()

    # Mescla _extras_dist (do out_v2 já hidratado pelo aplicar_complementos)
    # em extracao_raw_json.regex_v3.v2._extras_dist via JSON_MERGE_PATCH.
    # Isso garante demanda_complementar/medida + flags Energisa + motivo_faturamento
    # ficam todos numa fonte única, sem coluna duplicada.
    edist_dict = out_v2.get("_extras_dist") or {}
    if edist_dict:
        cur2 = conn.cursor()
        try:
            cur2.execute(
                f"UPDATE {TBL_FDE} "
                "SET extracao_raw_json = JSON_MERGE_PATCH("
                "  IFNULL(extracao_raw_json, JSON_OBJECT()),"
                "  JSON_OBJECT('regex_v3', JSON_OBJECT('v2', JSON_OBJECT('_extras_dist', CAST(%s AS JSON))))"
                ") WHERE id = %s",
                (json.dumps(edist_dict, ensure_ascii=False, default=str), fatura_id),
            )
            if commit:
                conn.commit()
        except Exception:
            pass
        finally:
            cur2.close()

    # Validador Art. 300 — só roda quando há sinal de demanda complementar (fail-fast).
    # Resultado grava em extracao_raw_json.validacao_art300 (não em coluna separada).
    try:
        tem_compl = any("demanda_complementar" in k for k in edist_dict.keys())
        if tem_compl and TBL_FDE == "FATURA_DADOS_EXTRAIDOS":  # validador_art300 só na produção (hardcoded na tabela)
            from validador_art300 import validar, gravar_resultado
            res = validar(conn, fatura_id)
            if not res.get("_erro") and not res.get("_skip"):
                gravar_resultado(conn, fatura_id, res)
    except Exception:
        pass  # não bloqueia o UPDATE principal

    return {"colunas_atualizadas": list(cols_to_set.keys()), "qtd": len(cols_to_set)}


def atualizar_lote(conn, fatura_ids: list[int], sobrescrever: bool = False,
                   verbose: bool = False) -> dict:
    """Processa um lote de IDs — extrai cada um e atualiza colunas."""
    import sys
    sys.path.insert(0, ".")
    from extrator_v2 import FaturaExtractorV2
    from extrator_complementar import aplicar_complementos
    from aplicar_mapa_distribuidora import carregar_mapa

    stats = {"ok": 0, "sem_texto": 0, "erro": 0, "colunas_total": 0}
    cur = conn.cursor(dictionary=True)
    for fid in fatura_ids:
        FaturaExtractorV2._mapas_cache = {}
        carregar_mapa.cache_clear()
        cur.execute("SELECT texto_plumber, texto_markdown, texto_ocr FROM FATURA_DADOS_EXTRAIDOS WHERE id=%s", (fid,))
        r = cur.fetchone()
        if not r or not r["texto_plumber"]:
            stats["sem_texto"] += 1
            continue
        try:
            # Combo plumber+markdown+ocr (igual pdf_pipeline): o OCR traz marcadores de
            # logo que o plumber não pega (ex: 'Light Serviços de Eletricidade') —
            # necessário pro detector_layout e SKIP de indicadores. Inclui AMBOS
            # (markdown E ocr) porque faturas antigas têm markdown mas o marcador
            # da dist costuma estar só no OCR.
            _md = ((r.get("texto_markdown") or "") + "\n\n" + (r.get("texto_ocr") or "")).strip()
            v2 = FaturaExtractorV2(fatura_id=fid, texto=r["texto_plumber"], conn=None,
                                    texto_md_fallback=_md)
            out = v2.extrair_tudo()
            aplicar_complementos(out, r["texto_plumber"], texto_md=_md)
            ret = atualizar_colunas_individuais(conn, fid, out, sobrescrever=sobrescrever)
            stats["ok"] += 1
            stats["colunas_total"] += ret["qtd"]
            if verbose:
                print(f"  id={fid}: {ret['qtd']} colunas atualizadas")
        except Exception as e:
            stats["erro"] += 1
            if verbose:
                print(f"  id={fid}: ERRO {type(e).__name__}: {str(e)[:80]}")
    cur.close()
    return stats


if __name__ == "__main__":
    import sys, mysql.connector
    sys.path.insert(0, ".")
    from completar_vision_5_4 import DB

    if len(sys.argv) < 2:
        print("Uso: atualizar_colunas_db.py <fatura_id> [--sobrescrever]")
        print("     atualizar_colunas_db.py --lote 11309 54487 50187 --verbose")
        print("     atualizar_colunas_db.py --lote --empresa 144 --sobrescrever  (TODAS da empresa)")
        print("     atualizar_colunas_db.py --lote --empresa 144 --limite 50      (primeiras N)")
        sys.exit(1)

    sobrescrever = "--sobrescrever" in sys.argv
    verbose = "--verbose" in sys.argv

    # Flags opcionais: --empresa N, --limite N, --chunk N
    def _flag_val(name, default=None, cast=int):
        if name in sys.argv:
            idx = sys.argv.index(name)
            if idx + 1 < len(sys.argv):
                try: return cast(sys.argv[idx + 1])
                except: return default
        return default
    empresa = _flag_val("--empresa")
    limite  = _flag_val("--limite")
    chunk   = _flag_val("--chunk", default=200)

    conn = mysql.connector.connect(**DB)
    if sys.argv[1] == "--lote":
        # 2 modos: (a) IDs explícitos, (b) --empresa N (busca todos do banco)
        if empresa is not None:
            cur = conn.cursor(dictionary=True)
            sql = ("SELECT id FROM FATURA_DADOS_EXTRAIDOS "
                   "WHERE cod_empresa = %s AND texto_plumber IS NOT NULL "
                   "ORDER BY id")
            params = [empresa]
            if limite:
                sql += " LIMIT %s"
                params.append(limite)
            cur.execute(sql, tuple(params))
            ids = [r["id"] for r in cur.fetchall()]
            cur.close()
            print(f"Empresa {empresa}: {len(ids)} faturas. Processando em chunks de {chunk}...")
            stats = {"ok": 0, "sem_texto": 0, "erro": 0, "colunas_total": 0}
            import time as _time
            t0 = _time.time()
            for i in range(0, len(ids), chunk):
                bloco = ids[i:i + chunk]
                s = atualizar_lote(conn, bloco, sobrescrever=sobrescrever, verbose=verbose)
                for k in stats: stats[k] += s.get(k, 0)
                pct = (i + len(bloco)) / len(ids) * 100
                rate = (i + len(bloco)) / max(0.1, _time.time() - t0)
                eta_s = (len(ids) - (i + len(bloco))) / max(0.1, rate)
                print(f"  [{i + len(bloco)}/{len(ids)}] {pct:.1f}%  rate={rate:.1f} fat/s  "
                      f"eta={eta_s/60:.1f}min  ok={stats['ok']} erro={stats['erro']}")
            print(f"\nLote (empresa {empresa}): {stats}  tempo={(_time.time()-t0)/60:.1f}min")
        else:
            ids = [int(x) for x in sys.argv[2:] if x.isdigit()]
            stats = atualizar_lote(conn, ids, sobrescrever=sobrescrever, verbose=verbose)
            print(f"\nLote: {stats}")
    else:
        fid = int(sys.argv[1])
        from extrator_v2 import FaturaExtractorV2
        from extrator_complementar import aplicar_complementos
        cur = conn.cursor(dictionary=True)
        cur.execute("SELECT texto_plumber, texto_markdown FROM FATURA_DADOS_EXTRAIDOS WHERE id=%s", (fid,))
        r = cur.fetchone()
        cur.close()
        v2 = FaturaExtractorV2(fatura_id=fid, texto=r["texto_plumber"], conn=None,
                                texto_md_fallback=r.get("texto_markdown") or "")
        out = v2.extrair_tudo()
        aplicar_complementos(out, r["texto_plumber"], texto_md=r.get("texto_markdown") or "")
        ret = atualizar_colunas_individuais(conn, fid, out, sobrescrever=sobrescrever)
        print(f"Atualizado id={fid}: {ret['qtd']} colunas")
        for c in ret["colunas_atualizadas"]:
            print(f"  - {c}")
    conn.close()
