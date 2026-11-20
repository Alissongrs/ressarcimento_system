# -*- coding: utf-8 -*-
"""Regras de comparação extração × gabarito visual (usadas por conferir_gabarito.py e conferir_ocr.py)."""
import re

CAMPOS = ["distribuidora", "codigo_uc", "mes_referencia", "valor_total_fatura", "grupo_tarifario", "modalidade_tarifaria",
          "consumo_ativo_fponta_kwh", "consumo_ativo_ponta_kwh", "kwh_total", "leit_ant_ativa_fponta", "leit_atu_ativa_fponta",
          "constante_k", "numero_medidor", "dias_faturados", "icms_valor", "pis_valor", "cofins_valor",
          "demanda_contratada_fponta_kw", "demanda_faturada_fponta_kw", "data_vencimento", "data_emissao_nf"]
NUM = {"valor_total_fatura", "consumo_ativo_fponta_kwh", "consumo_ativo_ponta_kwh", "kwh_total", "leit_ant_ativa_fponta",
       "leit_atu_ativa_fponta", "constante_k", "dias_faturados", "icms_valor", "pis_valor", "cofins_valor",
       "demanda_contratada_fponta_kw", "demanda_faturada_fponta_kw"}
ID = {"codigo_uc", "numero_medidor"}


def vazio(v):
    return v in (None, "", "__SET_NULL__", "-")


def num(v):
    try:
        return float(str(v).replace(".", "").replace(",", ".")) if isinstance(v, str) and "," in str(v) else float(v)
    except Exception:
        return None


def so_alnum(s):
    return re.sub(r"[^0-9A-Za-z]", "", str(s)).upper().lstrip("0") or "0"


def confere(campo, verdade, extraido, colunas):
    """→ 'certo' | 'errado' | 'vazio' | None (não se aplica)"""
    if verdade is None:
        return None
    alts = verdade if isinstance(verdade, list) else [verdade]
    if campo == "codigo_uc":  # aceita também em numero_instalacao
        cand = [extraido, colunas.get("numero_instalacao")]
    else:
        cand = [extraido]
    cand = [c for c in cand if not vazio(c)]
    if not cand:
        return "vazio"
    for e in cand:
        for v in alts:
            if campo in NUM:
                a, b = num(e), num(v)
                if a is not None and b is not None and (abs(a - b) <= 0.011 or abs(a - b) <= 0.002 * abs(b)):
                    return "certo"
            elif campo in ID:
                if so_alnum(e) == so_alnum(v):
                    return "certo"
            elif campo == "mes_referencia":
                if str(e)[:7] == str(v)[:7]:
                    return "certo"
            elif campo in ("distribuidora", "modalidade_tarifaria"):
                if str(v).lower() in str(e).lower():
                    return "certo"
            elif campo == "grupo_tarifario":
                if str(e).strip().upper()[:1] == str(v).upper()[:1]:
                    return "certo"
            else:
                if str(e)[:10] == str(v)[:10]:
                    return "certo"
    return "errado"
