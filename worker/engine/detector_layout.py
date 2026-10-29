"""Detector de layout — identifica qual template casa com o texto de uma fatura.

Caminhos:
  1) Procura arquivos em ia/mapas_manuais/MAPA_*.json e casa via assinatura_template.marcadores
  2) Aplica catálogo built-in dos templates já implementados via patterns no extrator_complementar
     (ELEKTRO L1/L2/L3, CPFL moderno, Equatorial moderno, etc.)

Retorna o template_id (string) ou 'layout_desconhecido'.

Uso:
    from detector_layout import detectar_layout
    template_id = detectar_layout(texto_plumber, mapa_pipeline="equatorial_goias")
"""
from __future__ import annotations
import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Optional


# ────────────────────────────────────────────────────────────────────────────
# Catálogo built-in — templates já cobertos por patterns dist-específicos.
# Cada entry: (marcadores_candidatos, marcadores_proibidos, template_id, min_match)
# Marcadores são strings case-insensitive. Vence o template com mais matches
# (>= min_match). Empate desempata por ordem do catálogo.
# Inclui CNPJ emissor como marcador de alta-confiança.
# ────────────────────────────────────────────────────────────────────────────
_CATALOGO_BUILTIN = [
    # ELEKTRO SP — 3 layouts (mapeados 24/05/2026, marcador único final)
    (["DANFELEKB"],                    [], "elektro_sp_b3_bt_moderno_gd_danf3e", 1),
    (["DANFELEKA"],                    [], "elektro_sp_a4_horaria_verde_demanda_subsidio_danf3e", 1),
    (["GBELEKTRO"],                    [], "elektro_sp_antigo_2021_cci_0601_0699", 1),

    # ENEL SP/RJ/CE
    # Layout ANTIGO 2022 (sem DANF3E, com CCI 0605 USO SIST. DISTR.)
    (["0605 USO SIST", "CCI DESCRIÇÃO", "ESCASSEZ HÍDRICA"],
     ["Ampla Energia", "DANFE - DOCUMENTO AUXILIAR"], "enel_sp_antigo_2022_cci_0605", 2),
    # Layout MODERNO (DANF3E) — inclui variantes OCR de "Eletropaulo" (Elelropaulo, etc)
    (["ENEL DISTRIBUIÇÃO SÃO PAULO", "Eletropaulo", "Elelropaulo", "Eletrop",
      "61.695.227", "DANFE - DOCUMENTO AUXILIAR"],
     ["Ampla Energia", "Enel Distribuição Ceará"], "enel_sp_danf3e_moderno", 1),
    (["Ampla Energia", "33.050.071"],  [], "enel_rio_ampla_danf3e", 1),
    (["Enel Distribuição Ceará", "07.047.251"], [], "enel_ce_danf3e", 1),

    # Light
    (["Light Serviços de Eletricidade", "60.444.437"], [], "light_danf3e_moderno", 1),

    # CPFL (excluindo o antigo Piratininga GD que está nos mapas_manuais)
    (["Companhia Piratininga de Força e Luz", "04.172.213"],
     ["Tarifa Verde-A4 Residencial", "Energia Atv Fornec"], "cpfl_piratininga_danf3e_moderno", 1),
    (["Companhia Paulista de Força e Luz", "33.050.196"], [], "cpfl_paulista_danf3e_moderno", 1),
    (["Companhia Luz e Força Santa Cruz", "33.884.529"], [], "cpfl_santacruz_danf3e_moderno", 1),

    # COPEL/CELESC
    (["Copel Distribuição", "04.368.898"], [], "copel_danf3e_moderno", 1),
    (["Celesc Distribuição", "08.336.783"], [], "celesc_danf3e_moderno", 1),

    # Energisa — família compartilha template DANF3E base (energisa_extraction_map)
    (["Energisa Mato Grosso do Sul", "15.413.826"], [], "energisa_ms_danf3e", 1),
    (["Energisa Mato Grosso", "03.467.321"], ["Mato Grosso do Sul"], "energisa_mt_danf3e", 1),
    (["Energisa Tocantins", "25.086.034"], [], "energisa_tocantins_danf3e", 1),
    (["Energisa Sul-Sudeste", "Energisa Sul Sudeste"], [], "energisa_ss_danf3e", 1),
    (["Energisa Minas Rio"], [], "energisa_mr_danf3e", 1),
    (["Energisa Sergipe"], [], "energisa_se_danf3e", 1),
    (["Energisa Paraiba", "Energisa Paraíba"], [], "energisa_pb_danf3e", 1),

    # CEMIG — DANF3E moderno + layout clássico "Cemig Atende" (VIA VAREJO/comercial)
    (["CEMIG Distribuição", "06.981.180"], [], "cemig_danf3e_moderno", 1),
    (["cemigatende.com.br", "Cemig Atende", "Ouvidoria CEMIG", "Fale com a Cemig"],
     [], "cemig_atende_classico", 1),

    # EDP
    (["EDP São Paulo Distribuição", "02.302.100"], [], "edp_sp_danf3e", 1),
    (["EDP Espírito Santo", "28.152.650"], [], "edp_es_danf3e", 1),

    # Neoenergia (excluindo Coelba A4 Livre Verde, está nos mapas_manuais)
    (["Neoenergia Coelba", "15.139.629", "COMPANHIA DE ELETRICIDADE DO ESTADO DA BAHIA"],
     ["A4 Livre - Verde", "Uso Sistema Fio-Lim"], "neoenergia_ba_coelba_danf3e", 1),
    (["Neoenergia Celpe", "10.835.932"], [], "neoenergia_pe_celpe_danf3e", 1),

    # Equatorial (excluindo o antigo Goiás A3-A THS Verde, está nos mapas_manuais)
    (["Equatorial Goiás", "CELG", "01.543.032"],
     ["A A3-A COMERCIAL", "PARCELA TE HR", "Comercial Normal THS_VERDE"],
     "equatorial_goias_danf3e_moderno", 1),
    (["Equatorial Pará", "04.895.728"], [], "equatorial_pa_danf3e_moderno", 1),

    # CEEE RS / RGE Sul — distribuidoras novas (RS); mapa de extração ainda PENDENTE.
    # Detecta o layout p/ roteamento; extração cai no fallback até criar map/{dist}_extraction_map.json.
    (["CEEE", "Companhia Estadual de Distribuição"], [], "ceee_rs_a4_horaria_verde", 1),
    (["RGE Sul", "Rio Grande Energia"], [], "rge_sul_b3_gd_scee", 1),
]


@lru_cache(maxsize=1)
def _carregar_mapas_manuais() -> list[dict]:
    """Carrega todos arquivos JSON de ia/mapas_manuais/ uma vez (cached).

    Retorna lista de dicts {template_id, marcadores, marcadores_negativos, _path}.
    """
    base = Path(__file__).parent / "mapas_manuais"
    if not base.is_dir():
        return []

    out = []
    for path in sorted(base.glob("MAPA_*.json")):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue

        meta = data.get("_meta") or {}
        assin = data.get("assinatura_template") or {}
        template_id = meta.get("template_id")
        if not template_id:
            continue

        marcadores = assin.get("marcadores") or []
        marcadores_neg = assin.get("marcadores_negativos") or []
        if not marcadores:
            continue

        out.append({
            "template_id": template_id,
            "marcadores": [m.upper() for m in marcadores if m],
            "marcadores_negativos": [m.upper() for m in marcadores_neg if m],
            "min_match": max(2, len(marcadores) // 3),  # exige 1/3 dos marcadores, mín 2
            "_path": str(path),
        })
    return out


def _conta_marcadores(texto_upper: str, marcadores: list[str]) -> int:
    """Quantos marcadores aparecem no texto."""
    return sum(1 for m in marcadores if m in texto_upper)


def detectar_layout(texto: str, mapa_pipeline: Optional[str] = None) -> str:
    """Identifica o template_id que melhor casa com o texto da fatura.

    Args:
        texto: texto plumber/markdown da fatura
        mapa_pipeline: opcional — mapa detectado pelo FaturaExtractorV2 (ex: 'equatorial_goias').
                       Usado como dica/desempate quando catálogo built-in tem múltiplas opções.

    Retorna:
        template_id (string) — ex: 'elektro_sp_b3_bt_moderno_gd_danf3e'
                                ou 'layout_desconhecido' se nenhum casou
    """
    if not texto:
        return "layout_desconhecido"

    texto_upper = texto.upper()

    # ── 1) Tenta mapas_manuais primeiro (prioritários — gold-standards) ──────
    melhor_manual = None
    melhor_score_manual = 0
    for mapa in _carregar_mapas_manuais():
        # Rejeita se algum marcador negativo aparece
        if any(neg in texto_upper for neg in mapa["marcadores_negativos"]):
            continue
        n_match = _conta_marcadores(texto_upper, mapa["marcadores"])
        if n_match >= mapa["min_match"] and n_match > melhor_score_manual:
            melhor_score_manual = n_match
            melhor_manual = mapa["template_id"]
    if melhor_manual:
        return melhor_manual

    # ── 2) Catálogo built-in (templates implementados via patterns) ──────────
    # Vence o que tem MAIS matches (>= min_match), desempate por ordem do catálogo
    melhor_builtin = None
    melhor_score_builtin = 0
    for entry in _CATALOGO_BUILTIN:
        marcadores_ok, marcadores_neg, template_id, min_match = entry
        if any(neg.upper() in texto_upper for neg in marcadores_neg):
            continue
        n_match = sum(1 for m in marcadores_ok if m.upper() in texto_upper)
        if n_match >= min_match and n_match > melhor_score_builtin:
            melhor_score_builtin = n_match
            melhor_builtin = template_id
    if melhor_builtin:
        return melhor_builtin

    # ── 3) Fallback — se mapa_pipeline veio detectado mas marcadores não casaram ──
    # Indica layout variante da dist conhecida (provavelmente antigo/raro)
    if mapa_pipeline:
        return f"layout_variante_{mapa_pipeline}"

    return "layout_desconhecido"


def _self_test():
    """Teste rápido — só pra validar quando rodar standalone."""
    casos = [
        ("DANFELEKB (V1.00) Texto Elektro B3", None, "elektro_sp_b3_bt_moderno_gd_danf3e"),
        ("DANFELEKA texto qualquer Horária Verde", None, "elektro_sp_a4_horaria_verde_demanda_subsidio_danf3e"),
        ("Texto antigo da Elektro GBELEKTRO1 (V1.00)", None, "elektro_sp_antigo_2021_cci_0601_0699"),
        ("Companhia Piratininga de Força e Luz DANFE moderno", None, "cpfl_piratininga_danf3e_moderno"),
        ("Companhia Piratininga de Força e Luz Tarifa Verde-A4 Residencial Energia Atv Fornec", None, "cpfl_piratininga_nf_conta_antiga_a4_verde_residencial_gd_boleto_itau_pix_2paginas"),
        ("Lorem ipsum sem nada conhecido", "energisa_mt", "layout_variante_energisa_mt"),
        ("Nada", None, "layout_desconhecido"),
    ]
    print("=== Self-test detector_layout ===")
    for texto, mapa, esperado in casos:
        got = detectar_layout(texto, mapa)
        ok = "✓" if got == esperado else "✗"
        print(f"  {ok}  esperado={esperado:<60} got={got}")


if __name__ == "__main__":
    _self_test()
