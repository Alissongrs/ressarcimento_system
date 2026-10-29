"""Complementos via SEFAZ NF3e — cross-check e enriquecimento.

Usa consultar_nf3e_sefaz.consultar_nf3e (com cache permanente SQLite) e devolve
um dict pronto pra ir em out_v2["_extras_sefaz"] e ser gravado em colunas.

Cross-checks:
  - valor_total_sefaz vs valor_total_fatura (extrator)
  - qtd_itens_sefaz vs len(itens_fatura) (extrator)

Códigos CCI ANEEL mapeados (validados cruzando 30 NF3e MT × JSON extrator):
  0601xxx — TE (Consumo em kWh)
  0604xxx — Subsídio
  0605xxx — Custo de Disponibilidade (TUSD)
  0611xxx — Energia Reativa Excedente
  0621xxx — Demanda / Demanda Complementar (TUSD)
  0631xxx — Adicional Demanda Ultrapassagem
  0640xxx — TUSD Fio B / Subsídio Fio
  0801xxx — CIP/COSIP Iluminação Pública
  0821xxx — Compensação / Parcelamento de débito
  0825xxx — Devolução
  0841xxx — Multa
  0842xxx — Juros de mora
  0843xxx — Atualização monetária
  56xx-59xx — Bandeiras e ajustes

Uso:
    from complementos_sefaz import extrair_complementos_sefaz
    extras = extrair_complementos_sefaz(chave_nfe, valor_total_extrator, qtd_itens_extrator)
"""
from __future__ import annotations
import json
from datetime import datetime
from typing import Optional


# ── Tabela CCI → categoria (validada via cruzamento empírico) ──────────────
def classificar_cci(codigo: str) -> str:
    """Devolve categoria do código CCI ANEEL.

    Mapa validado cruzando 1.031 NF3e MT com JSON do extrator (28/05/2026).
    Veja `_cache_sefaz.db` + DADOS_PARA_DETECCAO.md pra evidências.
    """
    if not codigo or len(codigo) < 4:
        return "desconhecido"
    prefix4 = codigo[:4]
    # Energia Ativa / TE
    if prefix4 == "0601":
        return "te_energia_ativa"
    # Subsídio
    if prefix4 == "0604":
        return "subsidio"
    # TUSD Demanda
    if prefix4 == "0605":
        return "tusd_custo_disponibilidade"
    # Reativo excedente
    if prefix4 == "0611":
        return "reativo_excedente"
    # Demanda (faturada / complementar)
    if prefix4 == "0621":
        return "tusd_demanda"
    if prefix4 == "0631":
        return "tusd_ultrapassagem"
    # TUSD Fio B / Subsídio Fio
    if prefix4 == "0640":
        return "tusd_fio_b"
    # CIP/COSIP
    if prefix4 == "0801":
        return "cip_iluminacao_publica"
    # Compensação/Parcelamento
    if prefix4 == "0821":
        return "compensacao_parcelamento"
    if prefix4 == "0825":
        return "devolucao"
    # Multa/Juros/Atualização
    if prefix4 == "0841":
        return "multa"
    if prefix4 == "0842":
        return "juros_mora"
    if prefix4 == "0843":
        return "atualizacao_monetaria"
    # Faixa 56xx-59xx — reclassificada via cruzamento 28/05/2026 (era genérico 'bandeira')
    if prefix4 == "5603":
        return "gd_energia_injetada"          # Energia Ativa Injetada (GD compensação)
    if prefix4 == "5901":
        return "compensacao_qualidade"         # DIC/FIC/atualização monetária comp
    if prefix4 == "5902":
        return "bonus_itaipu"                   # Bônus Itaipu Lei 10438
    if prefix4 == "5905":
        return "devolucao_subsidio"            # Devolução de subsídio / subsídio negativo
    if prefix4 == "5906":
        return "credito_compensacao"           # Crédito anterior / DIF.CRÉDITO A DEVOLVER
    # Bandeiras tarifárias reais (Vermelha/Amarela/Verde) — geralmente 0608, 0609
    if prefix4 in ("0608", "0609"):
        return "bandeira_tarifaria"
    return "desconhecido"


# ── Medição (consumo ativo por posto) a partir dos itens da NF3e SEFAZ ──────
# Valida 4/4 vs gabarito Ampla A4 (10/06): consumo ativo vem nos CCI 0601 (TE) e
# 0621 (TUSD energia, kWh) — NÃO o 0621 de demanda (unidade kW) nem o 0611 (reativo).
# Posto = 5º dígito do CCI 7-díg: 1=ponta, 3=fora-ponta, 2=reservado, 0=único.
# Dedupe TUSD/TE do mesmo posto pelo MAX (a mesma quantidade kWh aparece nos dois).
_CCI_ENERGIA_CONSUMO = ("0601", "0621")   # 0601=TE, 0621-kWh=TUSD energia
_CCI_DEMANDA = "0621"                       # 0621-kW = demanda
_CCI_REATIVO = "0611"                       # reativo excedente (kVArh)
_CCI_GD_INJETADA = "5603"                   # energia ativa injetada (GD)
# Posto = 5º dígito do CCI. Validado em Ampla RJ (1=ponta, 3=fora-ponta, 0=único).
# Energisa MT acrescenta o dígito 4 (posto extra fora-ponta/intermediário) — NÃO
# pode ser dropado: o consumo total tem que somar TODOS os postos de energia.
# Por isso fponta = total − ponta − reservado − único (cobre 3, 4 e quaisquer
# outros dígitos não-ponta sem perder kWh).

def sefaz_medicao(dados: Optional[dict]) -> dict:
    """Extrai as grandezas autoritativas da NF3e SEFAZ (dict de consultar_nf3e).

    SEFAZ é a fonte de verdade: o consumo total é a SOMA de todos os postos de
    energia ativa (0601 + 0621-kWh, dedupe TE/TUSD por posto via max). Nenhum
    posto é descartado.

    Retorna dict com (só os presentes):
      total, ponta, fponta, reservado, unico   — consumo ativo (kWh)
      demanda_kw                                 — 0621 un=kW (kW)
      reativo_kvarh                              — 0611 (kVArh)
      gd_injetada_kwh                            — 5603 (kWh)
      postos_raw = {digito: kWh}                 — breakdown bruto (lossless)
      _validado                                  — True se houve energia ativa
    """
    energia: dict = {}        # digito_posto -> kWh (max dedupe TE/TUSD)
    demanda_kw = 0.0
    reativo = 0.0
    gd_inj = 0.0
    for it in (dados or {}).get("itens") or []:
        cci = (it.get("codigo_cci") or "")
        if len(cci) < 5:
            continue
        q = it.get("quantidade_numerica")
        if q is None or q <= 0:
            continue
        p4 = cci[:4]
        un_cod = str(it.get("unidade_codigo") or "").strip()
        un = (it.get("unidade_nome") or "").strip().lower()
        eh_kw = un_cod == "1" or un == "kw"
        if p4 in _CCI_ENERGIA_CONSUMO and not eh_kw:
            energia[cci[4]] = max(energia.get(cci[4], 0.0), float(q))  # dedupe TE/TUSD por posto
        elif p4 == _CCI_DEMANDA and eh_kw:
            demanda_kw = max(demanda_kw, float(q))     # demanda faturada (maior)
        elif p4 == _CCI_REATIVO:
            reativo += float(q)
        elif p4 == _CCI_GD_INJETADA:
            gd_inj += float(q)
    total = round(sum(energia.values()), 2)
    ponta = energia.get("1")
    reservado = energia.get("2")
    unico = energia.get("0")
    resto = sum(v for d, v in energia.items() if d not in ("1", "2", "0"))  # 3, 4, ...
    out: dict = {"total": total}
    if ponta:     out["ponta"] = round(ponta, 2)
    if resto > 0: out["fponta"] = round(resto, 2)
    if reservado: out["reservado"] = round(reservado, 2)
    if unico:     out["unico"] = round(unico, 2)
    if demanda_kw: out["demanda_kw"] = round(demanda_kw, 2)
    if reativo > 0: out["reativo_kvarh"] = round(reativo, 2)
    if gd_inj > 0:  out["gd_injetada_kwh"] = round(gd_inj, 2)
    out["postos_raw"] = {d: round(v, 2) for d, v in energia.items()}
    out["_validado"] = bool(energia)
    return out


def _parse_data_sefaz(s: str) -> Optional[datetime]:
    """Converte '02/06/2022 20:27:39 -04:00' → datetime aware."""
    if not s:
        return None
    try:
        # Tira timezone se vier (datetime.fromisoformat lida com ISO mas formato BR é tricky)
        parte_dt = s[:19]  # '02/06/2022 20:27:39'
        return datetime.strptime(parte_dt, "%d/%m/%Y %H:%M:%S")
    except (ValueError, TypeError):
        return None


def extrair_complementos_sefaz(
    chave_nfe: str,
    valor_total_extrator: Optional[float] = None,
    qtd_itens_extrator: Optional[int] = None,
    tolerancia_valor_rs: float = 1.00,
) -> dict:
    """Consulta SEFAZ por chave NF3e + faz cross-check com extrator.

    Args:
        chave_nfe: chave de acesso de 44 dígitos
        valor_total_extrator: valor que o extrator extraiu do PDF (pra cross-check)
        qtd_itens_extrator: qtd itens que o extrator capturou (pra cross-check)
        tolerancia_valor_rs: diferença aceitável em R$ no cross-check de valor

    Returns:
        dict pronto pra gravar em colunas SEFAZ. Vazio se chave inválida ou erro.
    """
    if not chave_nfe or len(str(chave_nfe).strip()) != 44:
        return {}
    try:
        from consultar_nf3e_sefaz import consultar_nf3e
    except ImportError:
        return {}

    try:
        dados = consultar_nf3e(chave_nfe.strip())
    except Exception:
        return {}

    if not dados or dados.get("_erro"):
        return {}

    out = {}
    # Cabeçalho
    out["cnpj_emissor_sefaz"] = (dados.get("emitente") or {}).get("cnpj")
    out["ie_emissor_sefaz"] = (dados.get("emitente") or {}).get("ie")
    out["protocolo_autorizacao_sefaz"] = dados.get("protocolo_autorizacao")
    dt = _parse_data_sefaz(dados.get("data_emissao"))
    if dt:
        out["data_emissao_sefaz"] = dt.strftime("%Y-%m-%d %H:%M:%S")
    out["sefaz_consultado_em"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Totais
    vt = dados.get("valor_total_numerico")
    qi = dados.get("qtd_itens")
    if vt is not None:
        out["valor_total_sefaz"] = float(vt)
    if qi is not None:
        out["qtd_itens_sefaz"] = int(qi)

    # CCI: array + classificação
    itens = dados.get("itens") or []
    if itens:
        codigos = [it.get("codigo_cci") for it in itens if it.get("codigo_cci")]
        out["cci_codigos_sefaz"] = codigos
        # Classificação por código
        classif = {}
        for it in itens:
            cci = it.get("codigo_cci")
            if not cci: continue
            cat = classificar_cci(cci)
            v = it.get("valor_efetivo_numerico") or it.get("valor_total_numerico") or 0
            entry = classif.setdefault(cat, {"cci_codigos": [], "valor_total": 0.0, "qtd_itens": 0})
            if cci not in entry["cci_codigos"]:
                entry["cci_codigos"].append(cci)
            entry["valor_total"] = round(entry["valor_total"] + float(v), 2)
            entry["qtd_itens"] += 1
        out["classificacao_cci_sefaz"] = classif

    # Cross-checks
    if vt is not None and valor_total_extrator is not None:
        out["flag_divergencia_valor_sefaz"] = (
            1 if abs(float(vt) - float(valor_total_extrator)) > tolerancia_valor_rs else 0
        )
    if qi is not None and qtd_itens_extrator is not None:
        out["flag_divergencia_qtd_itens_sefaz"] = (
            1 if int(qi) != int(qtd_itens_extrator) else 0
        )

    return out
