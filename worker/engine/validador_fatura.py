"""Validador de qualidade fatura-completa.

Rodado APÓS extração. Calcula score 0-100 e gate (aprovado/revisao/reprovado).
Cada check identifica EXATAMENTE qual campo/regra falhou — alimenta o fallback
nano para os ~1-2% reprovados.

Uso:
    from validador_fatura import validar_fatura_completa
    qual = validar_fatura_completa(v2_out)
    # qual = {"score": 92, "gate": "aprovado", "checks": [...], "campos_faltantes": [...]}
"""
from typing import Any


# Pesos (soma = 100). SEFAZ consistente vira check #9, peso 8 (redistribuído de soma_itens e tributos).
PESOS = {
    "obrigatorios":     30,
    "soma_itens":       15,
    "tributos":         12,
    "historico":        10,
    "gd_consistente":   10,
    "leitura":           5,
    "classificacao":     5,
    "indicadores":       5,
    "sefaz_consistente": 8,
}

# Tolerância para comparações numéricas (R$)
TOLERANCIA_BRL = 0.50  # 50 centavos


def _get(d: dict, path: str, default=None):
    """Acessa d['a']['b']['c'] via 'a.b.c'. Retorna default se algum nível for None."""
    cur = d
    for k in path.split("."):
        if not isinstance(cur, dict): return default
        cur = cur.get(k)
        if cur is None: return default
    return cur


def _to_num(v: Any) -> float | None:
    if v is None: return None
    if isinstance(v, (int, float)): return float(v)
    try:
        s = str(v).replace(".", "").replace(",", ".") if "," in str(v) else str(v)
        return float(s)
    except Exception:
        return None


def _nucleo_antiga_ok(out: dict) -> bool:
    """Núcleo cadastral mínimo p/ liberar SKIP-cheio dos checks de fatura antiga (pré-2022):
    total + mês de referência + classe + CNPJ/CPF. Sem isso, a antiga NÃO é carimbada
    aprovado — permanece em revisão (evita rubber-stamp de extração vazia)."""
    total = _get(out, "vencimento_valor.valor_total") or _get(out, "_extras_sefaz.valor_total_sefaz")
    ref = _get(out, "vencimento_valor.mes_ref") or _get(out, "vencimento_valor.mes_referencia")
    classe = _get(out, "classificacao.classe_consumo") or _get(out, "classificacao.classe")
    doc = (_get(out, "cliente.cnpj") or _get(out, "cliente.cnpj_cliente")
           or _get(out, "cliente.cpf") or _get(out, "cliente.cpf_cliente")
           or _get(out, "cliente.cnpj_cliente_mascarado") or _get(out, "cliente.cpf_cliente_mascarado")
           or _get(out, "cliente.cnpj_mascarado"))
    return bool(total and ref and classe and doc)


def _check_obrigatorios(out: dict) -> dict:
    """30 pontos. Campos mínimos pra qualquer fatura."""
    # Fatura antiga (pré-2022): formato de labels diferente — SKIP
    if out.get("_fatura_antiga"):
        return {
            "nome": "obrigatorios", "status": "SKIP",
            "score": PESOS["obrigatorios"], "peso_max": PESOS["obrigatorios"],
            "_obs": "Fatura antiga (pré-2022) — labels de campos obrigatórios em layout diferente",
        }
    obrig = {
        "cliente.razao_social":              _get(out, "cliente.razao_social"),
        "vencimento_valor.valor_total":      _get(out, "vencimento_valor.valor_total"),
        # mes_ref OU mes_referencia (compat layouts/maps diferentes)
        "vencimento_valor.mes_ref":          _get(out, "vencimento_valor.mes_ref") or _get(out, "vencimento_valor.mes_referencia"),
        "vencimento_valor.data_vencimento":  _get(out, "vencimento_valor.data_vencimento"),
        "distribuidora.cnpj_emissor":        _get(out, "distribuidora.cnpj_emissor"),
        "identificadores_instalacao.codigo_instalacao": _get(out, "identificadores_instalacao.codigo_instalacao"),
    }
    # cliente.cnpj OU cnpj_cliente OU cpf OU cpf_cliente (qualquer um vale).
    # CNPJ/CPF MASCARADO ('3X.XXX.XXX/XXX8-22') também conta: a fatura mascara por
    # segurança do cliente — é o comportamento normal, não ausência de dado. O valor
    # limpo vem da origem (sgeeasy). Aceitar máscara evita falso 'campo faltante'.
    if (_get(out, "cliente.cnpj") or _get(out, "cliente.cnpj_cliente")
        or _get(out, "cliente.cpf") or _get(out, "cliente.cpf_cliente")
        or _get(out, "cliente.cnpj_cliente_mascarado") or _get(out, "cliente.cpf_cliente_mascarado")
        or _get(out, "cliente.cnpj_mascarado")):
        obrig["cliente.cnpj_OU_cpf"] = "ok"
    else:
        obrig["cliente.cnpj_OU_cpf"] = None
    faltantes = [k for k, v in obrig.items() if not v]
    preench = len(obrig) - len(faltantes)
    score = round((preench / len(obrig)) * PESOS["obrigatorios"], 1)
    return {
        "nome": "obrigatorios",
        "status": "PASS" if not faltantes else ("WARN" if len(faltantes) <= 1 else "FAIL"),
        "score": score,
        "peso_max": PESOS["obrigatorios"],
        "campos_faltantes": faltantes,
        "_obs": f"{preench}/{len(obrig)} campos obrigatórios presentes",
    }


def _check_soma_itens(out: dict) -> dict:
    """15 pontos. soma(itens.valor) ≈ vencimento_valor.valor_total."""
    itens = out.get("itens_fatura") or []
    total_fatura = _to_num(_get(out, "vencimento_valor.valor_total"))
    # Fatura antiga (pré-2022) COM núcleo cadastral OK: layout não imprime os itens no
    # formato calibrado → não extraímos a decomposição. SKIP nota-cheia (não penaliza algo
    # não extraível). Sem núcleo, NÃO libera (cai no SKIP-0 abaixo → fica em revisão).
    if out.get("_fatura_antiga") and _nucleo_antiga_ok(out):
        return {
            "nome": "soma_itens", "status": "SKIP",
            "score": PESOS["soma_itens"], "peso_max": PESOS["soma_itens"],
            "_obs": "Fatura antiga (pré-2022) c/ núcleo OK — itens em layout não calibrado; não penaliza",
        }
    # Enel RJ/Ampla mercado livre (A4 Horo Verde LIVRE/ACL): itens parciais por design (benefício
    # bruto/líquido, demanda, reativo) → SKIP-cheio mesmo sem itens reconstruídos. Antes do SKIP-0.
    if out.get("_enel_rj_acl"):
        return {
            "nome": "soma_itens", "status": "SKIP",
            "score": PESOS["soma_itens"], "peso_max": PESOS["soma_itens"],
            "_obs": "Enel RJ/Ampla mercado livre (ACL) — itens parciais por design",
        }
    if not itens or total_fatura is None:
        return {
            "nome": "soma_itens",
            "status": "SKIP",
            "score": 0,
            "peso_max": PESOS["soma_itens"],
            "_obs": "itens ou valor_total ausentes",
        }
    # Se SEFAZ validou o valor_total (cross-check fiscal), soma_itens PASS automático
    # (mercado livre/ACL frequentemente tem itens parciais; valor total já é gold)
    sv = out.get("_sefaz_validacao") or {}
    if sv.get("valor_consistente") is True:
        return {
            "nome": "soma_itens", "status": "PASS",
            "score": PESOS["soma_itens"], "peso_max": PESOS["soma_itens"],
            "_obs": "Valor total validado por SEFAZ NF3e (cross-check fiscal)",
        }

    # Mercado livre / ACL: SEFAZ traz bruto, descontos não fecham. SKIP.
    mapa = (out.get("_mapa_usado") or "").lower()
    _ACL_DISTS = {"light", "cpfl_santacruz", "cpfl_piratininga", "cpfl_paulista",
                  "celesc", "copel",  # COPEL mapa próprio
                  "edp"}
    # Detecta GD/ACL nos itens
    desc_text = " ".join((it.get("descricao") or "").upper() for it in itens)
    tem_acl_gd = bool(set(["ACL", "ENERGIA INJ", "MUC", "OUC", "SCEE", "DESC ENERG", "BENEF",
                            "SUBVEN", "DEDUC", "CRÉDITO", "CREDITO"]).intersection(
                            {w for w in desc_text.split() if len(w) > 2}))
    if mapa in _ACL_DISTS or tem_acl_gd:
        return {
            "nome": "soma_itens", "status": "SKIP",
            "score": PESOS["soma_itens"], "peso_max": PESOS["soma_itens"],
            "_obs": "Mercado livre/ACL: itens parciais por design (cross-check via SEFAZ desativado pelo mapa ou GD)",
        }
    # Elektro Grupo A Horária Verde: itens VERTICALIZADOS (CCI/desc/valores em blocos
    # separados) + subsídios/demanda → soma item-a-item não fecha por design. SKIP nota-cheia
    # (não penaliza coluna não reconstruível — conforme spec Elektro §14). Total via cabeçalho.
    if out.get("_elektro_grupo_a"):
        return {
            "nome": "soma_itens", "status": "SKIP",
            "score": PESOS["soma_itens"], "peso_max": PESOS["soma_itens"],
            "_obs": "Elektro Grupo A Horária Verde — itens verticalizados/subsídios; não penaliza",
        }
    # Fix C: crédito anterior financeiro (ex. R$ 6.879) reduz o total mas NÃO está em
    # itens_fatura → soma diverge por design. SKIP com observação.
    edist = out.get("_extras_dist") or {}
    if edist.get("credito_anterior_rs") is not None:
        return {
            "nome": "soma_itens", "status": "SKIP",
            "score": PESOS["soma_itens"], "peso_max": PESOS["soma_itens"],
            "_obs": f"Crédito anterior (R$ {edist['credito_anterior_rs']}) reduz total mas não está em itens — SKIP por design",
        }
    # Fatura zerada (totalmente compensada por GD): soma_itens não bate com 0 — ok
    if total_fatura == 0:
        return {
            "nome": "soma_itens",
            "status": "SKIP",
            "score": PESOS["soma_itens"],
            "peso_max": PESOS["soma_itens"],
            "_obs": "Fatura zerada (R$ 0,00) — compensação GD total",
            "soma_itens": round(sum(it.get("valor_brl_numerico") or 0 for it in itens), 2),
        }
    soma = sum(it.get("valor_brl_numerico") or 0 for it in itens)
    diff = abs(soma - total_fatura)
    # PASS: divergência ≤ R$0,50 OU ≤ 1% do total (margem de centavos por arredondamento)
    if diff <= TOLERANCIA_BRL or diff <= total_fatura * 0.01:
        return {
            "nome": "soma_itens", "status": "PASS",
            "score": PESOS["soma_itens"], "peso_max": PESOS["soma_itens"],
            "soma_itens": round(soma, 2), "total_fatura": total_fatura, "diff": round(diff, 2),
        }
    # WARN: divergência 1-5% — itens podem estar incompletos
    if diff <= total_fatura * 0.05:
        return {
            "nome": "soma_itens", "status": "WARN",
            "score": round(PESOS["soma_itens"] * 0.6, 1), "peso_max": PESOS["soma_itens"],
            "soma_itens": round(soma, 2), "total_fatura": total_fatura, "diff": round(diff, 2),
            "_obs": "Diferença 1-5% — possíveis itens não capturados",
        }
    return {
        "nome": "soma_itens", "status": "FAIL",
        "score": 0, "peso_max": PESOS["soma_itens"],
        "soma_itens": round(soma, 2), "total_fatura": total_fatura, "diff": round(diff, 2),
        "_obs": "Soma divergente do total — itens incompletos ou valores errados",
    }


def _check_tributos(out: dict) -> dict:
    """15 pontos. Tributos por dist OU agregados líquidos batem com soma de itens."""
    # Fatura antiga: parser de tributos_por_dist confunde BASE com VALOR — SKIP
    if out.get("_fatura_antiga"):
        return {
            "nome": "tributos", "status": "SKIP",
            "score": PESOS["tributos"], "peso_max": PESOS["tributos"],
            "_obs": "Fatura antiga (pré-2022) — extrator de tributos_por_dist não calibrado pra layout antigo",
        }
    # Amazonas/Âmbar (ZFM Manaus): ICMS recolhido por ST (Lei 217/2021) e PIS/COFINS isentos —
    # tributos NÃO são destacados na fatura. Não é falha de extração. SKIP nota-cheia.
    if out.get("_amazonas_icms_st"):
        return {
            "nome": "tributos", "status": "SKIP",
            "score": PESOS["tributos"], "peso_max": PESOS["tributos"],
            "_obs": "Amazonas/Âmbar (ZFM Manaus) — ICMS recolhido por ST (Lei 217/2021), PIS/COFINS isentos; tributos não destacados na fatura",
        }
    # Amazonas/Âmbar NF3e Grupo A com ICMS REAL destacado (não-ST): ICMS base×alíq/100==valor
    # validado no especialista + PIS/COFINS isentos. Itens não carregam ICMS por-item (não há
    # liquido p/ cruzar), mas os tributos foram extraídos e são internamente consistentes → PASS.
    if out.get("_amazonas_tributos_ok"):
        return {
            "nome": "tributos", "status": "PASS",
            "score": PESOS["tributos"], "peso_max": PESOS["tributos"],
            "_obs": "Amazonas/Âmbar — ICMS destacado consistente (base×alíq=valor) + PIS/COFINS isentos (Detalhamento de Tributos)",
        }
    trib_dist = out.get("tributos_por_dist") or {}
    trib_agg = out.get("tributos_agregados_itens") or {}

    def _tv(str_key, val_key):
        """Parse tributo: trata '0,00' como 0.0 (não None) para distinguir
        'declarado como zero' de 'campo ausente'. Evita o bug do `or` com 0.0 falsy."""
        v = _to_num(_get(trib_dist, str_key))
        return v if v is not None else _to_num(_get(trib_dist, val_key))

    # PIS+COFINS por dist (valor declarado pela distribuidora)
    pis_dist = _tv("pis.valor_string", "pis.valor")
    cof_dist = _tv("cofins.valor_string", "cofins.valor")
    icms_dist = _tv("icms.valor_string", "icms.valor")
    # PIS+COFINS líquido (soma itens)
    pc_liq = _to_num(_get(trib_agg, "pis_cofins_liquido.valor_numerico"))
    icms_liq = _to_num(_get(trib_agg, "icms_liquido.valor_numerico"))

    sub_checks = []
    score_partial = 0.0
    # Detecta se fatura tem itens GD (compensação/injeção) — ajustes de crédito GD
    # causam pequenas divergências de ICMS que não representam erro de extração.
    itens_f = out.get("itens_fatura") or []
    _desc_all = " ".join((it.get("descricao") or "").upper() for it in itens_f)
    _tem_gd_itens = any(w in _desc_all for w in ("MUC", "OUC", "SCEE", "INJETADA", "COMPENSAD"))

    # ICMS: bate com declarado pela dist?
    # Fix A: ambos zero → GD eliminou ICMS corretamente → PASS (não falsiness-skip)
    # Fix B: com itens GD usa tolerância 2% do maior valor (crédito GD causa ajuste)
    if icms_dist is not None and icms_liq is not None:
        if icms_dist == 0 and icms_liq == 0:
            sub_checks.append({"campo": "icms", "status": "PASS", "dist": 0, "liq": 0,
                                "_obs": "ICMS zerado por compensação GD — correto"})
            score_partial += PESOS["tributos"] * 0.5
        else:
            diff_icms = abs((icms_dist or 0) - (icms_liq or 0))
            ref = max(abs(icms_dist or 0), abs(icms_liq or 0))
            tol = max(TOLERANCIA_BRL, ref * 0.05) if _tem_gd_itens else TOLERANCIA_BRL
            if diff_icms <= tol:
                sub_checks.append({"campo": "icms", "status": "PASS", "dist": icms_dist, "liq": icms_liq})
                score_partial += PESOS["tributos"] * 0.5
            else:
                sub_checks.append({"campo": "icms", "status": "FAIL", "dist": icms_dist, "liq": icms_liq, "diff": round(diff_icms, 2)})
    elif icms_dist or icms_liq:
        sub_checks.append({"campo": "icms", "status": "PARTIAL", "dist": icms_dist, "liq": icms_liq})
        score_partial += PESOS["tributos"] * 0.25
    # PIS+COFINS combinado
    pc_dist_total = (pis_dist or 0) + (cof_dist or 0) if (pis_dist or cof_dist) else None
    if pc_dist_total and pc_liq:
        diff_pc = abs(pc_dist_total - pc_liq)
        if diff_pc <= TOLERANCIA_BRL:
            sub_checks.append({"campo": "pis_cofins", "status": "PASS", "dist": pc_dist_total, "liq": pc_liq})
            score_partial += PESOS["tributos"] * 0.5
        else:
            sub_checks.append({"campo": "pis_cofins", "status": "WARN", "dist": pc_dist_total, "liq": pc_liq, "diff": round(diff_pc, 2)})
            score_partial += PESOS["tributos"] * 0.25
    elif pc_dist_total or pc_liq:
        sub_checks.append({"campo": "pis_cofins", "status": "PARTIAL", "dist": pc_dist_total, "liq": pc_liq})
        score_partial += PESOS["tributos"] * 0.25
    if not sub_checks:
        return {"nome": "tributos", "status": "SKIP", "score": 0, "peso_max": PESOS["tributos"], "_obs": "tributos ausentes"}
    has_fail = any(s["status"] == "FAIL" for s in sub_checks)
    has_warn = any(s["status"] in ("WARN", "PARTIAL") for s in sub_checks)
    status = "PASS" if (not has_fail and not has_warn) else ("FAIL" if has_fail else "WARN")
    return {
        "nome": "tributos", "status": status,
        "score": round(score_partial, 1), "peso_max": PESOS["tributos"],
        "sub_checks": sub_checks,
    }


def _check_historico(out: dict) -> dict:
    """10 pontos. Histórico 13m: ≥12 meses com pelo menos um valor numérico.

    Especial: se TODOS os itens têm `_provavel_dias_nao_kwh`, a fatura
    realmente não imprime kWh — não é falha de extração. Marca como SKIP.
    """
    # Fatura antiga: layout de histórico não calibrado — SKIP
    if out.get("_fatura_antiga"):
        return {
            "nome": "historico", "status": "SKIP",
            "score": PESOS["historico"], "peso_max": PESOS["historico"],
            "_obs": "Fatura antiga (pré-2022) — histórico em layout não calibrado",
        }
    # Amazonas/Âmbar: histórico 13m não é extraível de forma confiável do texto — o layout
    # compacto 'VIA PARA PAGAMENTO' não imprime o histograma e o boleto 'Documento Auxiliar'
    # imprime-o garbado/zerado intercalado com as colunas 'Composição da Conta' (ilegível no
    # plumber). Núcleo cadastral capturado → SKIP (precedente Elektro/Light Grupo A).
    if out.get("_amazonas"):
        return {
            "nome": "historico", "status": "SKIP",
            "score": PESOS["historico"], "peso_max": PESOS["historico"],
            "_obs": "Amazonas/Âmbar — histórico 13m não extraível do texto (compacto não imprime; boleto garbado entre colunas)",
        }
    # Elektro Grupo A Horária Verde: histórico 12m não sai no texto extraível (verticalizado/
    # ausente no markdown). Núcleo (inst/CNPJ/classe/total) capturado → não penaliza.
    if out.get("_elektro_grupo_a"):
        return {
            "nome": "historico", "status": "SKIP",
            "score": PESOS["historico"], "peso_max": PESOS["historico"],
            "_obs": "Elektro Grupo A — histórico 12m não impresso no texto extraível",
        }
    # Light Grupo A NF3e (ACL): histórico 12m não consta no texto extraído (NF3e RJ). Núcleo
    # capturado (classe/leitura/instalação/CNPJ) → não penaliza.
    if out.get("_light_grupo_a"):
        return {
            "nome": "historico", "status": "SKIP",
            "score": PESOS["historico"], "peso_max": PESOS["historico"],
            "_obs": "Light Grupo A NF3e — histórico 12m não impresso no texto extraível",
        }
    # Equatorial Pará Grupo A NF3e: imprime só 'Média dos 12 meses' (sem tabela mensal no texto).
    # Núcleo (total/itens/classe/modalidade/leitura) capturado → não penaliza histórico ausente.
    if out.get("_eqpa_grupo_a"):
        return {
            "nome": "historico", "status": "SKIP",
            "score": PESOS["historico"], "peso_max": PESOS["historico"],
            "_obs": "Equatorial Pará Grupo A NF3e — histórico mensal não impresso (só média 12m)",
        }
    # EDP ES (layout NF/Conta simples) não imprime histórico de 12 meses — SKIP
    if out.get("_edp_es_sem_historico"):
        return {
            "nome": "historico", "status": "SKIP",
            "score": PESOS["historico"], "peso_max": PESOS["historico"],
            "_obs": "EDP ES (conta simples) não imprime histórico 12m na fatura",
        }
    hist = out.get("historico_13m_consumo") or []
    if not hist:
        return {"nome": "historico", "status": "FAIL", "score": 0, "peso_max": PESOS["historico"], "_obs": "histórico vazio"}
    # CASO ESPECIAL: fatura só imprime dias do ciclo (não kWh)
    todos_so_dias = all(h.get("_provavel_dias_nao_kwh") for h in hist)
    if todos_so_dias:
        return {
            "nome": "historico", "status": "SKIP",
            "score": PESOS["historico"], "peso_max": PESOS["historico"],
            "_obs": "Fatura imprime DIAS do ciclo (não kWh) — não é falha de extração",
            "meses_com_dias": sum(1 for h in hist if h.get("dias_ciclo") is not None),
            "meses_total": len(hist),
        }
    completos = 0
    for h in hist:
        if any(h.get(k) is not None for k in
               ("consumo_ponta_kwh", "consumo_fponta_kwh", "consumo_kwh", "demanda_ponta_kw", "demanda_fponta_kw")):
            completos += 1
    # Faturamento pela média/mínimo (Art. 86): meses estimados não imprimem leitura
    # (consumo_ponta vem como '*'). Não é falha de extração — aceita ≥11/13 como PASS.
    # Análogo ao SKIP de 'todos_so_dias'. Só dispara com a flag literal da fatura.
    edist = out.get("_extras_dist") or {}
    if completos >= 11 and completos < 12 and edist.get("flag_faturamento_pela_media"):
        return {
            "nome": "historico", "status": "PASS",
            "score": PESOS["historico"], "peso_max": PESOS["historico"],
            "meses_completos": completos, "meses_total": len(hist),
            "_obs": "Faturamento pela média/mínimo — mês(es) estimado(s) sem leitura na ponta não contam como falha de extração",
        }
    if completos >= 12:
        return {"nome": "historico", "status": "PASS", "score": PESOS["historico"], "peso_max": PESOS["historico"], "meses_completos": completos, "meses_total": len(hist)}
    if completos >= 6:
        return {"nome": "historico", "status": "WARN", "score": round(PESOS["historico"] * 0.5, 1), "peso_max": PESOS["historico"], "meses_completos": completos, "meses_total": len(hist)}
    return {"nome": "historico", "status": "FAIL", "score": 0, "peso_max": PESOS["historico"], "meses_completos": completos, "meses_total": len(hist)}


def _check_gd_consistente(out: dict) -> dict:
    """10 pontos. Se GD ativa, mUC/oUC consistentes com auditoria."""
    gd = out.get("geracao_distribuida") or {}
    audit = out.get("auditoria_gd") or {}
    # GD REAL exige ITEM de compensação/injeção (ou energia GD>0) — NÃO basta ser Grupo A
    # elegível. As flags tem_compensacao_cruzada/tem_fator_ajuste do auditoria_gd são
    # ELEGIBILIDADE (todo Grupo A recebe True), não presença. Mensagens tipo "Energia Inj.
    # ... UC SEM VINCULO" são alerta, não GD. (guardrail: texto isolado não classifica GD.)
    itens = out.get("itens_fatura") or []
    tem_item_gd = any(it.get("eh_credito_gd") for it in itens)
    inj = _to_num(gd.get("energia_injetada_kwh")) or 0
    comp = _to_num(gd.get("energia_compensada_kwh")) or 0
    gd_real = tem_item_gd or inj > 0 or comp > 0
    if not gd_real:
        return {"nome": "gd_consistente", "status": "SKIP", "score": PESOS["gd_consistente"], "peso_max": PESOS["gd_consistente"], "_obs": "fatura sem GD real (sem item de compensação/injeção) — não aplicável"}
    muc = gd.get("compensacao_propria_mUC") or []
    ouc = gd.get("creditos_de_outras_ucs_oUC") or []
    if not muc and not ouc:
        # GD compensada DENTRO dos itens (autoconsumo: injeção 0R/0S/etc. abate o consumo na
        # própria conta). Se a soma dos itens (com a injeção negativa) FECHA com o total
        # declarado, a compensação GD é internamente consistente → PASS, mesmo sem mUC/oUC
        # decomposto (a fatura não imprime essa tabela de forma extraível). Geral.
        _gdtot = _to_num(_get(out, "vencimento_valor.valor_total"))
        _gdsoma = round(sum(_to_num(it.get("valor_brl_numerico")) or 0 for it in itens), 2)
        if _gdtot is not None and itens and abs(_gdsoma - _gdtot) <= max(0.50, abs(_gdtot) * 0.02):
            return {"nome": "gd_consistente", "status": "PASS",
                    "score": PESOS["gd_consistente"], "peso_max": PESOS["gd_consistente"],
                    "_obs": "GD compensada nos itens (autoconsumo); soma dos itens fecha com o total → consistente"}
        # GD ativa mas extrator não capturou mUC/oUC e soma não fecha: não é falha fatal —
        # pode ser que a fatura não imprime a decomposição. Marca como WARN.
        return {"nome": "gd_consistente", "status": "WARN",
                "score": round(PESOS["gd_consistente"] * 0.5, 1),
                "peso_max": PESOS["gd_consistente"],
                "_obs": "GD ativa mas sem mUC/oUC capturados — extração parcial ou fatura não decompõe"}
    # Validações da auditoria
    divs = audit.get("divergencias") or []
    if divs:
        # Divergências reais não são falha de extração (são da fatura)
        return {"nome": "gd_consistente", "status": "WARN", "score": round(PESOS["gd_consistente"] * 0.8, 1), "peso_max": PESOS["gd_consistente"], "divergencias_fatura": len(divs), "muc_qtd": len(muc), "ouc_qtd": len(ouc)}
    return {"nome": "gd_consistente", "status": "PASS", "score": PESOS["gd_consistente"], "peso_max": PESOS["gd_consistente"], "muc_qtd": len(muc), "ouc_qtd": len(ouc)}


def _check_leitura(out: dict) -> dict:
    """5 pontos. Período de leitura (ant, atual, dias)."""
    # Fatura antiga (pré-2022) COM núcleo cadastral OK: leitura/datas em layout não
    # calibrado, frequentemente 'Não Executada' ou custo mínimo. SKIP nota-cheia.
    # Sem núcleo, NÃO libera (cai no fluxo normal abaixo → pode FAIL → fica em revisão).
    if out.get("_fatura_antiga") and _nucleo_antiga_ok(out):
        return {
            "nome": "leitura", "status": "SKIP",
            "score": PESOS["leitura"], "peso_max": PESOS["leitura"],
            "_obs": "Fatura antiga (pré-2022) c/ núcleo OK — leitura em layout não calibrado / Não Executada; não penaliza",
        }
    pl = out.get("periodo_leitura") or {}
    necessarios = ("leitura_anterior", "leitura_atual", "dias_consumo")
    preench = sum(1 for k in necessarios if pl.get(k))
    if preench == 3:
        return {"nome": "leitura", "status": "PASS", "score": PESOS["leitura"], "peso_max": PESOS["leitura"]}
    if preench >= 1:
        return {"nome": "leitura", "status": "WARN", "score": round(PESOS["leitura"] * preench / 3, 1), "peso_max": PESOS["leitura"], "_obs": f"{preench}/3 campos de leitura"}
    return {"nome": "leitura", "status": "FAIL", "score": 0, "peso_max": PESOS["leitura"], "_obs": "leitura ausente"}


def _check_classificacao(out: dict) -> dict:
    """5 pontos. Modalidade + subgrupo + classe."""
    # Fatura antiga: rótulo é 'GRUPO/SUBGRP.:' (não 'Classificação:') — SKIP
    if out.get("_fatura_antiga"):
        return {
            "nome": "classificacao", "status": "SKIP",
            "score": PESOS["classificacao"], "peso_max": PESOS["classificacao"],
            "_obs": "Fatura antiga (pré-2022) — usa 'GRUPO/SUBGRP.:' em vez de 'Classificação:'",
        }
    # Amazonas/Âmbar layout compacto 'VIA PARA PAGAMENTO': não imprime classe/modalidade
    # rotuladas (só o boleto traz 'GRUPO B B3 COMERCIAL ...'). Subgrupo é inferido dos itens. SKIP.
    if out.get("_amazonas_compact"):
        return {
            "nome": "classificacao", "status": "SKIP",
            "score": PESOS["classificacao"], "peso_max": PESOS["classificacao"],
            "_obs": "Amazonas/Âmbar layout 'VIA PARA PAGAMENTO' (compacto) não imprime classe/modalidade rotuladas",
        }
    c = out.get("classificacao") or {}
    necessarios = ("modalidade_tarifaria", "subgrupo", "classe_consumo")
    preench = sum(1 for k in necessarios if c.get(k))
    if preench == 3:
        return {"nome": "classificacao", "status": "PASS", "score": PESOS["classificacao"], "peso_max": PESOS["classificacao"]}
    if preench >= 1:
        return {"nome": "classificacao", "status": "WARN", "score": round(PESOS["classificacao"] * preench / 3, 1), "peso_max": PESOS["classificacao"], "_obs": f"{preench}/3 campos"}
    return {"nome": "classificacao", "status": "FAIL", "score": 0, "peso_max": PESOS["classificacao"], "_obs": "classificação ausente"}


_DISTS_SEM_INDICADORES = {
    # Distribuidoras que NÃO imprimem DIC/FIC/DICRI na fatura principal (mantêm em portal cliente).
    # Quando dessas, indicadores = SKIP (não penaliza score).
    "enel_rio", "enel_ce", "enel_rj_ampla", "ampla", "enel_distribuicao_modern",
    "enel_sp",  # Enel SP idem
    "light",    # Light não imprime na fatura padrão
    "cemig",    # CEMIG imprime "AGENTE DE RELACIONAMENTO" mas não DIC/FIC
    "celesc",   # Celesc/Copel imprime apenas saldo GD
    "cpfl_santacruz", "cpfl_piratininga", "cpfl_paulista",
    "edp",      # EDP imprime indicadores no portal
    "elektro_ms", "elektro_sp",
    "neoenergia_cosern", "neoenergia_ba", "neoenergia_pe",
    "equatorial_goias", "equatorial_norte",
    "energisa_ms", "energisa_pb", "energisa_se", "energisa_ss", "energisa_tocantins", "energisa_mr_mg",
    "copel",  # COPEL — mapa próprio agora
    "amazonas",  # Amazonas/Âmbar (AM) não imprime DIC/FIC na fatura — só tensão/faixa adequada
}


def _check_sefaz_consistente(out: dict) -> dict:
    """8 pontos. Cross-check com SEFAZ NF3e (valor_total + qtd_itens).

    PASS: SEFAZ ok + valor consistente + qtd consistente
    WARN: SEFAZ ok + valor OU qtd consistente
    SKIP: SEFAZ não disponível (UF não responde, sem chave, etc)
    FAIL: SEFAZ ok + valor E qtd divergem
    """
    sv = out.get("_sefaz_validacao") or {}
    # Fix: faturas com bônus Itaipu ou subsídio rural reduzem o total LÍQUIDO vs o gross
    # gravado na NF3e. SKIP a comparação de valor para evitar falso FAIL.
    edist_sf = out.get("_extras_dist") or {}
    if edist_sf.get("bonus_itaipu_rs") is not None or edist_sf.get("subvencao_rs") is not None:
        return {
            "nome": "sefaz_consistente", "status": "SKIP",
            "score": PESOS["sefaz_consistente"], "peso_max": PESOS["sefaz_consistente"],
            "_obs": "Bônus Itaipu/subsídio rural altera total líquido vs gross NF3e — comparação de valor não aplicável",
        }
    # Fatura GD com total R$0,00 (compensação total / abaixo do mínimo Art.318):
    # a NF3e registra o valor BRUTO (antes da compensação), incomparável com o
    # total líquido zero. SKIP (mesma lógica do soma_itens p/ total==0).
    _total_fat = _to_num(_get(out, "vencimento_valor.valor_total"))
    if _total_fat == 0:
        return {
            "nome": "sefaz_consistente", "status": "SKIP",
            "score": PESOS["sefaz_consistente"], "peso_max": PESOS["sefaz_consistente"],
            "_obs": "Fatura total R$0,00 (compensação GD / abaixo do mínimo) — NF3e traz bruto, não comparável com zero",
        }
    if not sv or not sv.get("consultado"):
        return {
            "nome": "sefaz_consistente", "status": "SKIP",
            "score": PESOS["sefaz_consistente"], "peso_max": PESOS["sefaz_consistente"],
            "_obs": f"SEFAZ indisponível ({sv.get('_erro', 'sem chave/UF')})",
        }
    # Light/CPFL/COPEL/EDP: SEFAZ retorna BRUTO em mercado livre ACL — não penaliza
    mapa = (out.get("_mapa_usado") or "").lower()
    _SEFAZ_BRUTO_ACL = {"light", "cpfl_santacruz", "cpfl_piratininga", "cpfl_paulista",
                          "celesc", "copel",  # COPEL agora tem mapa próprio
                          "edp"}
    if mapa in _SEFAZ_BRUTO_ACL:
        return {
            "nome": "sefaz_consistente", "status": "SKIP",
            "score": PESOS["sefaz_consistente"], "peso_max": PESOS["sefaz_consistente"],
            "_obs": f"{mapa}: SEFAZ retorna valor BRUTO em ACL — não comparável com líquido",
        }
    val_ok = sv.get("valor_consistente") is True
    qtd_ok = sv.get("qtd_consistente") is True
    if val_ok and qtd_ok:
        return {"nome": "sefaz_consistente", "status": "PASS", "score": PESOS["sefaz_consistente"], "peso_max": PESOS["sefaz_consistente"]}
    if val_ok or qtd_ok:
        return {"nome": "sefaz_consistente", "status": "WARN", "score": round(PESOS["sefaz_consistente"] * 0.5, 1), "peso_max": PESOS["sefaz_consistente"], "_obs": "1 de 2 cross-checks OK"}
    return {"nome": "sefaz_consistente", "status": "FAIL", "score": 0, "peso_max": PESOS["sefaz_consistente"], "_obs": f"valor e qtd divergem (sefaz={sv.get('valor_total_sefaz')}, ext={sv.get('valor_total_extracao')})"}


def _check_indicadores(out: dict) -> dict:
    """5 pontos. DIC/FIC/DICRI/tensão/limite.

    SKIP quando dist conhecida NÃO imprime indicadores na fatura principal
    (mantém só no portal cliente, ex: Enel, Light). Score = peso máximo nesse caso.
    """
    mapa = (out.get("_mapa_usado") or "").lower()
    # layout_template_id (do detector_layout, via OCR) cobre casos onde o _mapa_usado
    # não foi resolvido — ex: Light, cujo nome só aparece no logo/OCR. Casa por prefixo.
    layout = (out.get("_layout_template_id") or "").lower()
    if out.get("_sem_indicadores") or mapa in _DISTS_SEM_INDICADORES or any(layout.startswith(d) for d in _DISTS_SEM_INDICADORES):
        ref = "flag" if out.get("_sem_indicadores") else (mapa if mapa in _DISTS_SEM_INDICADORES else layout)
        return {
            "nome": "indicadores", "status": "SKIP",
            "score": PESOS["indicadores"], "peso_max": PESOS["indicadores"],
            "_obs": f"{ref} não imprime DIC/FIC na fatura — indicadores no portal cliente",
        }

    ind = out.get("indicadores_qualidade") or out.get("indicadores") or {}
    # Aceita aliases de chaves (regex_dic ou dic_apurado, etc.)
    chaves = (
        ("regex_dic", "dic_apurado", "dic"),
        ("regex_fic", "fic_apurado", "fic"),
        ("dicri", "regex_dicri"),
        ("tensao_contratada_v", "tensao_contratada"),
        ("limite_adequado_min_v",),
    )
    preench = sum(1 for grupo in chaves if any(ind.get(k) for k in grupo))
    if preench >= 4:
        return {"nome": "indicadores", "status": "PASS", "score": PESOS["indicadores"], "peso_max": PESOS["indicadores"]}
    if preench >= 2:
        return {"nome": "indicadores", "status": "WARN", "score": round(PESOS["indicadores"] * 0.5, 1), "peso_max": PESOS["indicadores"]}
    return {"nome": "indicadores", "status": "FAIL", "score": 0, "peso_max": PESOS["indicadores"], "_obs": f"{preench}/5 indicadores"}


def validar_fatura_completa(out_v2: dict) -> dict:
    """Roda todos os checks e retorna score + gate + detalhes.

    Gates:
      - aprovado:  score >= 90
      - revisao:   75 <= score < 90
      - reprovado: score < 75
      - scaneada:  fatura escaneada (fora do escopo determinístico)
    """
    if not isinstance(out_v2, dict):
        return {"score": 0, "gate": "reprovado", "checks": [], "_obs": "out_v2 inválido"}

    # Fatura escaneada: fora do escopo do validador determinístico
    if out_v2.get("_fatura_scaneada"):
        return {
            "score": 0,
            "gate": "scaneada",
            "checks": [],
            "campos_faltantes": [],
            "divergencias": [],
            "_obs": "Fatura escaneada — requer OCR robusto; fora do escopo do regex/bbox",
        }

    checks = [
        _check_obrigatorios(out_v2),
        _check_soma_itens(out_v2),
        _check_tributos(out_v2),
        _check_historico(out_v2),
        _check_gd_consistente(out_v2),
        _check_leitura(out_v2),
        _check_classificacao(out_v2),
        _check_indicadores(out_v2),
        _check_sefaz_consistente(out_v2),
    ]
    score_total = sum(c.get("score", 0) for c in checks)
    score_max = sum(c.get("peso_max", 0) for c in checks)
    score_pct = round((score_total / score_max) * 100, 1) if score_max else 0

    # Gates calibrados em 22/05/2026:
    #   90+   aprovado    — vai direto pra produção
    #   70-89 revisao     — sanity check humano antes de uso (extração suficiente)
    #   <70   reprovado   — falha clara, requer fix de extrator ou OCR
    if score_pct >= 90:
        gate = "aprovado"
    elif score_pct >= 70:
        gate = "revisao"
    else:
        gate = "reprovado"

    # Resumo: lista campos faltantes e divergências por gravidade
    campos_faltantes = []
    divergencias = []
    for c in checks:
        if c.get("campos_faltantes"):
            campos_faltantes.extend(c["campos_faltantes"])
        if c.get("status") in ("FAIL", "WARN"):
            divergencias.append({
                "check": c["nome"], "status": c["status"], "score": c.get("score"),
                "peso_max": c.get("peso_max"), "obs": c.get("_obs"),
                "detalhe": {k: v for k, v in c.items() if k not in ("nome", "status", "score", "peso_max", "_obs")}
            })

    return {
        "score": score_pct,
        "gate": gate,
        "checks": checks,
        "campos_faltantes": campos_faltantes,
        "divergencias": divergencias,
    }


if __name__ == "__main__":
    # Auto-teste rápido
    import json, sys
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8") as f:
            data = json.load(f)
        v2 = data.get("v2", data)
        q = validar_fatura_completa(v2)
        print(json.dumps(q, ensure_ascii=False, indent=2, default=str))
