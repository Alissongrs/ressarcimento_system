# -*- coding: utf-8 -*-
"""FASE 1 — Pipeline "cerebro" da Auditoria Inteligente (offline, sem UI, sem banco).
Por fatura:
  E1 Extracao multi-fonte (plumber + extrator_v2 + markdown)
  E2 Coleta de CANDIDATOS por campo (varias fontes; nada descartado)
  E3 Normalizacao: deterministico-primeiro (concordancia -> gate coerencia -> maioria);
     4.1-mini SO como desempate ENTRE candidatos (pick-among, nunca inventa numero)
  E4 Motor F01-F05 (regras portadas; historico do bloco impresso + do lote)
  E5 Interpretacao (nano + prompt_confirmar) apenas p/ faturas com ficha
Saidas: _fase1/relatorio.json + _fase1/metricas.json + _fase1/relatorio.md
NAO grava no banco.
"""
import os, re, sys, json, csv, statistics as st, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# Cópia de ia/OCR_claro/_fase1_pipeline.py para a extração da Claro na VPS (backend/claro). Única mudança:
# o texto do PDF vem de texto_pdf.py (mesmo código do pdf_pipeline.extrair_plumber, sem as conexões dele).
from texto_pdf import extrair_plumber, extrair_markdown
from extrator_v2 import FaturaExtractorV2

D = os.path.dirname(os.path.abspath(__file__))
USE_COORD = os.environ.get("FASE1_COORD") == "1"   # plugar coord_layer + complementos
USE_LLM_EXTRATOR = os.environ.get("FASE1_LLM") == "1"  # gpt-4.1-mini como extrator no balde dificil
os.environ["SKIP_SEFAZ"] = "1"                      # sem rede no lote
_suf = ("_coord" if USE_COORD else "") + ("_llm" if USE_LLM_EXTRATOR else "")
OUTDIR = os.environ.get("FASE1_OUTDIR") or os.path.join(D, "_fase1" + _suf)  # só o main() de lote grava aqui

def _best_total(out_v2):
    vv = out_v2.get("vencimento_valor") or {}
    return _br(vv.get("_valor_total_extrator")) or _br(vv.get("valor_total"))

def _camadas_extra(out_v2, texto, pdf_path):
    """Camadas do pdf_pipeline completo: complementos (cascata bbox) + coord_layer (itens/tributos)."""
    dbg = {}
    try:
        from extrator_v3 import cascata_extracao, resumir
        from extrator_complementar import aplicar_complementos
        casc = resumir(cascata_extracao(pdf_path))
        aplicar_complementos(out_v2, texto or "", cascata=casc, pdf_path=pdf_path, uid=None)
        dbg["complementos"] = "ok"
    except Exception as e:
        dbg["complementos"] = str(e)[:80]
    # ANCORA: coord usa _valor_total_ref_v2 (le vencimento_valor.valor_total, bugado "1,90").
    # Injeta o total CORRETO DEPOIS de complementos (que sobrescreve o campo) e ANTES do coord.
    bt = _best_total(out_v2)
    if bt and bt > 0:
        out_v2.setdefault("vencimento_valor", {})["valor_total"] = f"{bt:.2f}".replace(".", ",")
        dbg["anchor_total"] = bt
    try:
        from pdf_pipeline import _aplicar_itens_coord, _aplicar_campos_coord
        dbg["coord_itens"] = _aplicar_itens_coord(out_v2, pdf_path)
        dbg["coord_campos"] = _aplicar_campos_coord(out_v2, pdf_path)
    except Exception as e:
        dbg["coord"] = str(e)[:80]
    return dbg
NORM_MODEL = "gpt-4.1-mini"
# Interpretação: 4.1-mini/4o-mini (o nano delira demais — inventa ficha que não existe).
INTERP_MODELS = ["gpt-4.1-mini", "gpt-4o-mini"]

def _chat(client, model, messages, max_out=180):
    """Chama chat.completions lidando com a familia 5.x (max_completion_tokens, sem temperature)."""
    if model.startswith("gpt-5"):
        # familia 5.x = raciocinio: precisa de headroom (reasoning consome tokens antes do texto)
        return client.chat.completions.create(model=model, messages=messages, max_completion_tokens=max(800, max_out*4))
    return client.chat.completions.create(model=model, messages=messages, max_tokens=max_out, temperature=0.2)

def _f(x):
    try: return float(x)
    except: return None
def _br(x):
    if x is None: return None
    s = str(x).strip().replace(".", "").replace(",", ".")
    try: return float(s)
    except: return None

# ---------- LLM ----------
_LLM = {"client": None, "ok": None, "interp_model": None}
def _find_up(*rel):
    """Sobe a arvore a partir deste modulo procurando <ancestral>/<rel>. Depth-independent
    (funciona de ia/OCR_prod, ia/Copia/essencial ou dentro do container)."""
    p = os.path.abspath(D)
    for _ in range(8):
        cand = os.path.join(p, *rel)
        if os.path.exists(cand):
            return cand
        novo = os.path.dirname(p)
        if novo == p:
            break
        p = novo
    return None
def _key():
    # 1) env (container/prod) — pdf_pipeline ja carrega backend/.env em os.environ no import
    k = os.environ.get("OPENAI_API_KEY")
    if k and "sk-" in k:
        return k.strip()
    # 2) fallback: acha backend/.env subindo a arvore
    envp = _find_up("backend", ".env")
    if envp:
        for ln in open(envp, encoding="utf-8"):
            if ln.strip().startswith("OPENAI_API_KEY=") and "sk-" in ln:
                return ln.split("=", 1)[1].strip()
    return None
def _client():
    if _LLM["client"] is None:
        try:
            from openai import OpenAI
            _LLM["client"] = OpenAI(api_key=_key()); _LLM["ok"] = True
        except Exception as e:
            _LLM["ok"] = False; print("LLM indisponivel:", str(e)[:120])
    return _LLM["client"]

# ---------- consumo / coerencia (regra TE/TUSD dedup) ----------
_EXCL = ("DEMANDA","REATIV","BANDEIRA","ADICIONAL","ILUM","CIP","COSIP","UFER","DMCR",
         "MULTA","JUROS","REPERCUSS","PARCELA","ENCARGO","SUBSIDIO","SUBVEN","DESCONTO",
         "CONTRIB","CORRECAO","CRED")
def consumo_itens(itens):
    buck = {}
    for it in (itens or []):
        d = (it.get("descricao") or "").upper()
        if (it.get("unidade") or "").upper() != "KWH": continue
        q = _f(it.get("quantidade_numerica"))
        if q is None or q <= 0: continue
        if "COMPENSAD" in d or "INJET" in d: continue
        if any(x in d for x in _EXCL): continue
        if not any(x in d for x in ("CONSUMO","ENERGIA","SCEE")): continue
        b = "P" if (" PONTA" in d and "FORA" not in d and "F PONTA" not in d) else "FP"
        buck.setdefault(b, set()).add(round(q, 2))
    return round(sum(sum(s) for s in buck.values()), 2)
def soma_itens_valor(itens):
    return round(sum(_f(it.get("valor_brl_numerico")) or 0 for it in (itens or [])), 2)

# ---------- GD vs ACL (deterministico) ----------
def gd_real(itens, texto):
    t = (texto or "").upper()
    marc = ["SISTEMA DE COMPENSAC", "ENERGIA INJ", "ENERGIA COMPENSAD", "SCEE", "MICROGERAC",
            "MINIGERAC", "GERACAO DISTRIBUID", "UC GERADORA", "CLIENTE GERADOR"]
    tem = any(m in t for m in marc)
    for it in (itens or []):
        d = (it.get("descricao") or "").upper()
        if "COMPENSAD" in d or "INJET" in d or "SCEE" in d: tem = True
    # ACL / subvencao NAO e GD
    return bool(tem)

# ---------- candidatos por campo (regex no texto impresso) ----------
def cand_texto(texto):
    t = texto or ""; out = {}
    # total: SO formas rotuladas com ":" ou "(R$)" — evita "Ja Incluido no valor a pagar: R$ 3,13" (bandeira)
    m = re.search(r"(?:Total a Pagar|Valor Atualmente Devido|Valor do Documento|Valor da Conta|Valor a Pagar\s*\(R\$\)|Total R\$)\s*:?\s*R?\$?\s*([\d.]{1,3}(?:\.\d{3})*,\d{2})", t, re.I)
    if m: out["valor_total"] = _br(m.group(1))
    m = re.search(r"Consumo Total Faturado[:\s]*([\d.]+)\s*kWh", t, re.I)
    if m: out["consumo"] = _br(m.group(1))
    # tabela de medicao: leit ant/atu + constante + consumo
    m = re.search(r"Leitura Anterior[:\s]*([\d.]+).{0,60}?Leitura Atual[:\s]*([\d.]+)", t, re.I|re.S)
    if m: out["leit_ant"] = _br(m.group(1)); out["leit_atu"] = _br(m.group(2))
    m = re.search(r"Constante (?:de Multiplica|Medidor|de Faturamento)[^\d]{0,8}([\d,]+)", t, re.I)
    if m: out["constante"] = _br(m.group(1))
    for dist, pat in [("CEMIG","CEMIG"),("CPFL Paulista","COMPANHIA PAULISTA DE"),
                      ("CELESC","CELESC"),("Elektro","ELEKTRO"),("CPFL","CPFL")]:
        if re.search(pat, t, re.I): out["distribuidora"] = dist; break
    return out

def _total_neoenergia(texto):
    """Total 'A PAGAR' das faturas Neoenergia (Celpe/Coelba/Cosern/CEB): header
    'REF:MÊS/ANO  TOTAL A PAGAR R$  VENCIMENTO' seguido de 'MM/YYYY <valor> DD/MM/YYYY'.
    O extrator_v2 genérico não pega esse layout. Retorna float (pode ser 0.0 = GD
    compensada) ou None. Layout específico → não colide com outras distribuidoras."""
    if not texto:
        return None
    m = re.search(r"REF:M[ÊE]S/ANO\s+TOTAL\s+A\s+PAGAR.*?VENCIMENTO\s*\n\s*"
                  r"\d{2}/\d{4}\s+([\d.]*,\d{2})\s+\d{2}/\d{2}/\d{4}", texto, re.I)
    return _br(m.group(1)) if m else None

_RX_MED_NEO = re.compile(r"([A-Z]?\d{5,})\s+Energia\s+Ativa\s+\S+\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d+)", re.I)
def _medidor_neoenergia(texto):
    """Bloco MEDIDOR Neoenergia (Coelba/Celpe/Cosern/CEB): linha
    'SERIAL Energia Ativa <posto> <leit_ant> <leit_atu> <const>'. O extrator_v2 não
    captura o serial nesse layout (o numero_medidor do FDE é doc mis-extraído que muda
    todo mês → F04 falso). Retorna serial + leituras reais, ou None. Serial ESTÁVEL por UC."""
    if not texto:
        return None
    m = _RX_MED_NEO.search(texto)
    if not m:
        return None
    return {"serial": m.group(1), "leit_ant": _br(m.group(2)),
            "leit_atu": _br(m.group(3)), "const": _br(m.group(4))}

def _total_claro(texto):
    """Total 'a pagar' de layouts Claro (ENEL SP, CPFL, Light, Copel, Ampla). Retorna float ou None."""
    if not texto:
        return None
    # 1) UNIVERSAL: linha do boleto "MM/AAAA  DD/MM/AAAA  R$ <valor>" (ENEL SP, Light, Copel, Ampla).
    #    É a "TOTAL A PAGAR" real — evita a armadilha do Light onde "TOTAL <n>" é soma de coluna.
    #    ref = MM | MMM | mês por extenso (Novembro), com espaços opcionais ao redor da barra.
    m = re.search(r"(?:\d{1,2}|[A-Za-zçÇ]{3,})\s*/\s*\d{4}\s+\d{2}/\d{2}/\d{4}\s+R\$\s*([\d.]+,\d{2})", texto)
    if m: return _br(m.group(1))
    # 2) CPFL: header "Total a Pagar (R$)  Data de Vencimento" + linha "<conta> <total> <DD/MM/AAAA>"
    m = re.search(r"Total a Pagar \(R\$\).*?\n[^\n]*?\s([\d.]+,\d{2})\s+\d{2}/\d{2}/\d{4}", texto, re.S)
    if m: return _br(m.group(1))
    # 3) CPFL: "Total Consolidado <total> ..."
    m = re.search(r"Total Consolidado\s+([\d.]+,\d{2})", texto)
    if m: return _br(m.group(1))
    # 3b) Energisa (MS/MT, Grupo A): "TOTAL: <valor>"
    m = re.search(r"\bTOTAL:\s*([\d.]+,\d{2})", texto)
    if m: return _br(m.group(1))
    # 4) ENEL SP boleto: "VALOR DO DOCUMENTO:" ... "R$<valor>"
    m = re.search(r"VALOR DO DOCUMENTO:.*?R\$\s*([\d.]+,\d{2})", texto, re.S)
    if m: return _br(m.group(1))
    return None

def _consumo_claro(texto):
    """Consumo de layouts Claro adicionais. Cobre:
    - CPFL: item código 0605(TUSD)/0601(TE) + '<qtd> kWh' (variantes Energia Ativa Fornecida,
      Consumo Uso Sistema [KWh], Custo Disp...); ignora INJEÇÃO (GD, negativas).
    - Neoenergia Coelba/PE Grupo B: 'CONSUMO KWh <qtd> ...'."""
    if not texto:
        return None
    for ln in texto.splitlines():  # CPFL
        if re.match(r"\s*060[15]", ln) and "kWh" in ln and "Inj" not in ln and "-" not in ln.split("kWh")[0][-3:]:
            m = re.search(r"([\d.]+,\d+)\s*kWh", ln)
            if m:
                v = _br(m.group(1))
                if v and v > 0:
                    return v
    m = re.search(r"\bCONSUMO\s+KWh\s+([\d.]+(?:,\d+)?)\b", texto, re.I)  # Coelba/Neoenergia GB
    if m:
        v = _br(m.group(1))
        if v and v > 0:
            return v
    # Equatorial: medidor "Consumo ATIVO TOTAL <ant> <atu> <k> <consumo> kWh" (delta real; mais confiável)
    m = re.search(r"Consumo ATIVO TOTAL\s+[\d.]+\s+[\d.]+\s+[\d.,]+\s+([\d.]+)\s*kWh", texto)
    if m:
        v = _br(m.group(1))
        if v and v > 0:
            return v
    # Equatorial Pará: "CONSUMO kWh TP <leit_ant> <leit_atu> <k> <consumo>"
    m = re.search(r"\bCONSUMO\s+kWh\s+\w+\s+\d[\d.]*\s+\d[\d.]*\s+[\d.,]+\s+([\d.]+)", texto)
    if m:
        v = _br(m.group(1))
        if v and v > 0:
            return v
    m = re.search(r"Consumo\s*\(kWh\)\s+([\d.]+,\d+)", texto)  # Equatorial (item, fallback)
    if m:
        v = _br(m.group(1))
        if v and v > 0:
            return v
    # Energisa (MS/MT) Grupo A: "Energia ativa em kWh <posto> <leit_ant> <leit_atu> <k> <consumo>"
    m = re.search(r"Energia ativa em kWh\s+\S+\s+\d[\d.]*\s+\d[\d.]*\s+[\d.,]+\s+([\d.]+)", texto)
    if m:
        v = _br(m.group(1))
        if v and v > 0:
            return v
    return None

def coletar_candidatos(out_v2, texto, md):
    itens = out_v2.get("itens_fatura") or []
    lt = out_v2.get("ligacao_tecnica") or {}
    med = out_v2.get("medicao") or {}
    dist = out_v2.get("distribuidora") or {}
    vv = out_v2.get("vencimento_valor") or {}
    ct = cand_texto(texto)
    cm = cand_texto(md) if md else {}
    def push(dd, k, v, fonte):
        v = v if not isinstance(v, str) else v.strip()
        if v in (None, "", 0): return
        dd.setdefault(k, []).append({"valor": v, "fonte": fonte})
    C = {}
    # valor_total
    push(C, "valor_total", _br(vv.get("_valor_total_extrator")), "v2_cabecalho")
    push(C, "valor_total", ct.get("valor_total"), "texto")
    push(C, "valor_total", cm.get("valor_total"), "markdown")
    # Neoenergia (Celpe/Coelba/Cosern/CEB): total do header. Append DIRETO (não via push)
    # porque push descarta 0, e 0,00 é total legítimo de GD compensada.
    _tn = _total_neoenergia(texto)
    if _tn is not None:
        C.setdefault("valor_total", []).append({"valor": _tn, "fonte": "neoenergia"})
    # Total layouts Claro (ENEL SP, CPFL) — o extrator genérico não pega
    _tc = _total_claro(texto)
    if _tc is not None:
        C.setdefault("valor_total", []).append({"valor": _tc, "fonte": "claro"})
    # NAO usar soma_itens como candidato de valor_total (circular com a checagem de coerencia).
    # soma_itens e a CHECAGEM, nao um candidato.
    # consumo
    push(C, "consumo", consumo_itens(itens), "itens_dedup")
    push(C, "consumo", ct.get("consumo"), "texto")
    push(C, "consumo", _consumo_claro(texto), "claro")
    # distribuidora
    push(C, "distribuidora", dist.get("razao_social") if isinstance(dist, dict) else dist, "v2")
    push(C, "distribuidora", ct.get("distribuidora"), "texto")
    # leituras/constante
    for k in ("leit_ant","leit_atu","constante"):
        push(C, k, _f(med.get({"leit_ant":"leit_ant_ativa_fponta","leit_atu":"leit_atu_ativa_fponta","constante":"constante_k"}[k])), "v2")
        push(C, k, ct.get(k), "texto")
    # medidor (serial) + leituras — p/ F04 (troca) e F05 (continuidade)
    _medser = med.get("medidor") or med.get("numero_medidor")
    _mn = _medidor_neoenergia(texto)  # bloco MEDIDOR Neoenergia (só casa nesse layout)
    if _mn:
        if not _medser:
            _medser = _mn["serial"]
        # As leituras do bloco MEDIDOR são AUTORITATIVAS (sobrescrevem o que o cand_texto
        # pegou errado — ~25 = dias/alíquota — que gerava F01 falso). Serial estável por UC.
        if _mn.get("leit_ant") is not None: C["leit_ant"] = [{"valor": _mn["leit_ant"], "fonte": "medidor_neo"}]
        if _mn.get("leit_atu") is not None: C["leit_atu"] = [{"valor": _mn["leit_atu"], "fonte": "medidor_neo"}]
        if _mn.get("const") is not None: C["constante"] = [{"valor": _mn["const"], "fonte": "medidor_neo"}]
    if _medser:
        C.setdefault("medidor", []).append({"valor": str(_medser), "fonte": "v2"})
    # cadastrais
    push(C, "subgrupo", lt.get("subgrupo"), "v2")
    push(C, "modalidade", lt.get("modalidade_tarifaria"), "v2")
    push(C, "classe", lt.get("classe"), "v2")
    return C, itens

# ---------- normalizacao ----------
def _norm_num(cands, tol=0.02):
    """agrupa candidatos numericos ~iguais; retorna (valor, n_concordam, total)."""
    vals = [c["valor"] for c in cands if isinstance(c["valor"], (int, float))]
    if not vals: return None, 0, 0
    grupos = []
    for v in vals:
        for g in grupos:
            if abs(v - g[0]) <= max(0.5, abs(g[0]) * tol): g[1].append(v); break
        else: grupos.append([v, [v]])
    grupos.sort(key=lambda g: -len(g[1]))
    return round(st.mean(grupos[0][1]), 2), len(grupos[0][1]), len(vals)

def normalizar(C, itens, texto):
    out = {}; conf = {}; usou_llm = []
    soma = soma_itens_valor(itens)
    # valor_total CANONICO = cabecalho (_valor_total_extrator) > texto > markdown.
    # soma_itens NAO seleciona (era circular) — soma e so a CHECAGEM de coerencia.
    if C.get("valor_total"):
        vals = [c for c in C["valor_total"] if isinstance(c["valor"], (int, float))]
        ordem = {"v2_cabecalho": 0, "neoenergia": 0, "claro": 0, "texto": 1, "markdown": 2}
        vals.sort(key=lambda c: ordem.get(c["fonte"], 9))
        if vals:
            out["valor_total"] = round(vals[0]["valor"], 2)
            indep = [c["valor"] for c in vals]
            conf["valor_total"] = 95 if (len(indep) >= 2 and max(indep)-min(indep) <= max(0.5, out["valor_total"]*0.02)) else 85
    # consumo
    if C.get("consumo"):
        v, n, tot = _norm_num(C["consumo"])
        out["consumo"] = v; conf["consumo"] = int(90 * n / max(1, tot))
    # leituras/constante -> checa leitura x const = consumo
    for k in ("leit_ant","leit_atu","constante"):
        if C.get(k):
            v, n, tot = _norm_num(C[k]); out[k] = v; conf[k] = int(90 * n / max(1, tot))
    # distribuidora (texto tem prioridade sobre v2 hardcoded errado)
    if C.get("distribuidora"):
        vt = [c for c in C["distribuidora"] if c["fonte"] == "texto"]
        out["distribuidora"] = (vt[0] if vt else C["distribuidora"][0])["valor"]
        vals = set(str(c["valor"]).upper()[:5] for c in C["distribuidora"])
        conf["distribuidora"] = 95 if len(vals) == 1 else 75
    for k in ("subgrupo","modalidade","classe"):
        if C.get(k): out[k] = C[k][0]["valor"]; conf[k] = 90
    if C.get("medidor"): out["medidor"] = C["medidor"][0]["valor"]
    # GD/ACL deterministico
    out["gd"] = gd_real(itens, texto); conf["gd"] = 90
    # gate leitura x const
    la, lt_, kk = out.get("leit_ant"), out.get("leit_atu"), out.get("constante")
    if la is not None and lt_ is not None and kk and lt_ >= la and out.get("consumo"):
        medido = (lt_ - la) * kk
        conf["consumo"] = 99 if abs(medido - out["consumo"]) <= max(5, out["consumo"] * 0.05) else conf.get("consumo", 60)
    # coerencia soma (+ ACL-aware: tagueia mercado livre p/ reportar separado)
    t = (texto or "").upper()
    acl = ("LIVRE" in t and ("ACL" in t or "MERCADO LIVRE" in t)) or \
          any("ACL" in (it.get("descricao") or "").upper() for it in itens)
    out["_acl"] = bool(acl)
    out["_soma_itens"] = soma
    vt = out.get("valor_total")
    # Compensação: total LÍQUIDO (o que se paga) == 0 (ou GD com total << soma BRUTA).
    # soma_itens==total é N/A aqui — não é falha de extração (o cliente compensou o
    # consumo). Independe de detectar "GD" no texto: total 0 + itens > 0 já é estrutural.
    if (soma > 0 and vt == 0) or (out.get("gd") and (vt is None or (soma > 0 and vt is not None and vt < soma * 0.5))):
        out["_gap_pct"] = None; out["_soma_bate_total"] = None; out["_compensado"] = True
    elif vt and soma > 0:
        gap = abs(soma - vt)
        out["_gap_pct"] = round(100 * gap / vt, 1)
        out["_soma_bate_total"] = bool(gap <= max(0.5, vt * 0.02))
    else:
        out["_gap_pct"] = None; out["_soma_bate_total"] = False
    out["_confianca"] = conf
    return out

# ---------- motor F01-F05 (portado) ----------
F02_ALTO=1.00; F02_PICO=2.00; F02_MIN=50.0; F02_BASE=3; F03B_FLOOR=100.0; F03B_CATCHUP=300.0
F03B_PISO_MIN=10; F03B_JANELA=3  # alinhado ao motor Go (regras_desvio.go F03BPisoMinSeq/JanelaPos)
F05_TOL_UNID=2.0  # tolerância (unidades) na continuidade de leitura entre meses

def _norm_medidor(s):
    """Serial do medidor só-dígitos, sem zeros à esquerda (evita '000292603'↔'292603')."""
    d = re.sub(r"\D", "", str(s or "")).lstrip("0")
    return d if len(d) >= 3 else ""
def _trocou_medidor(ant, atu):
    a, b = _norm_medidor(ant), _norm_medidor(atu)
    return bool(a and b and a != b)
def _leituras_fecham(la, lt, k, cons):
    """|leit_atu - leit_ant|×K ≈ consumo (tol 5%). Sem isso a 'quebra' é só extração ruim."""
    if not la or not lt or not cons: return False
    calc = abs(lt - la) * (k or 1)
    return abs(calc - cons) / cons <= 0.05
def _quebra_continuidade(leit_atu_ant, leit_ant_atu):
    """Leitura final do mês anterior ≠ leitura inicial do mês atual (não 'emenda')."""
    if not leit_atu_ant or not leit_ant_atu: return False
    if abs(leit_atu_ant - leit_ant_atu) <= F05_TOL_UNID: return False
    for f in (10, 100):  # equivalência por escala (OCR ×10/×100)
        if abs(leit_atu_ant*f - leit_ant_atu) <= F05_TOL_UNID or abs(leit_atu_ant - leit_ant_atu*f) <= F05_TOL_UNID:
            return False
    return True
def motor(serie_consumos, idx, norm, hist_impresso, prev=None, mes_consecutivo=False):
    cons = norm.get("consumo") or 0
    fichas = []; det = {}
    base = [c for i, c in enumerate(serie_consumos) if i != idx and c > F02_MIN]
    if len(base) < F02_BASE and hist_impresso:
        base = [c for c in hist_impresso if c and c > F02_MIN]
    if len(base) >= F02_BASE and cons > F02_MIN:
        media = st.mean(base)
        if media > 0:
            dev = cons / media - 1
            if cons >= media * (1 + F02_PICO): fichas.append("F02_PICO"); det["desvio_pct"] = round(dev*100)
            elif cons >= media * (1 + F02_ALTO): fichas.append("F02_ALTO"); det["desvio_pct"] = round(dev*100)
            det["media"] = round(media)
    # F03B — "piso ANTES de pico" (Art.113). RÍGIDO (anti-falso-positivo, alinhado ao
    # motor Go): exige um RUN de >=F03B_PISO_MIN meses CONSECUTIVOS no piso (<=floor)
    # SEGUIDO por um pico (catch-up) dentro de F03B_JANELA meses. Um único mês baixo NÃO
    # é F03B (era o bug: cons<=100 + próximo>=300 disparava em consumo normal oscilante).
    if cons <= F03B_FLOOR:
        lo = idx
        while lo-1 >= 0 and (serie_consumos[lo-1] or 0) <= F03B_FLOOR: lo -= 1
        hi = idx
        while hi+1 < len(serie_consumos) and (serie_consumos[hi+1] or 0) <= F03B_FLOOR: hi += 1
        run = hi - lo + 1
        pico = None
        for k in range(hi+1, min(hi+1+F03B_JANELA, len(serie_consumos))):
            v = serie_consumos[k] or 0
            if v >= F03B_CATCHUP and v >= (cons or 1)*3: pico = v; break
        if run >= F03B_PISO_MIN and pico:
            fichas.append("F03B"); det["catchup"] = round(pico); det["piso_run"] = run
    # F01 (erro de fórmula) é RARO e difícil de acontecer. Em fatura GD o consumo (c/ SCEE)
    # não bate com leitura×constante por design → gera F01 falso. Gate: só não-GD, sem ACL,
    # e divergência GRANDE (>25%). Na dúvida, NÃO aponta F01.
    la, lt_, kk = norm.get("leit_ant"), norm.get("leit_atu"), norm.get("constante")
    if (not norm.get("gd") and not norm.get("_acl")
            and la is not None and lt_ is not None and kk and lt_ >= la and cons > 0):
        medido = (lt_-la)*kk
        if medido > 0:
            ratio = cons / medido
            # Ignora divergência que é um FATOR DE ESCALA limpo (×10/×100/×1000) — quase
            # sempre é misparse de constante/leitura (decimal), NÃO erro de fórmula real
            # (ex.: const 0,08 no lugar de 0,8 → medido 10× menor que o faturado).
            escala = any(abs(ratio - f) <= f*0.08 or abs(ratio - 1.0/f) <= (1.0/f)*0.08 for f in (10, 100, 1000))
            if not escala and abs(ratio - 1) > 0.25:
                fichas.append("F01"); det["medido"] = round(medido); det["faturado"] = round(cons)
    # ---- F04 (troca de medidor + desvio) e F05 (quebra de continuidade) ----
    # Precisam do mês ANTERIOR da mesma UC (prev = norm da fatura anterior na série).
    if prev is not None:
        tem_f02 = any(f.startswith("F02") for f in fichas)
        if _trocou_medidor(prev.get("medidor"), norm.get("medidor")) and tem_f02:
            fichas.append("F04"); det["medidor_ant"] = prev.get("medidor"); det["medidor_atu"] = norm.get("medidor")
        # F05: mesmo medidor, meses CONSECUTIVOS, leituras dos 2 meses fecham a fórmula,
        # e a leitura final do mês anterior NÃO emenda com a inicial do atual.
        elif (not _trocou_medidor(prev.get("medidor"), norm.get("medidor")) and _norm_medidor(prev.get("medidor"))
              and mes_consecutivo
              and _leituras_fecham(prev.get("leit_ant"), prev.get("leit_atu"), prev.get("constante"), prev.get("consumo"))
              and _leituras_fecham(norm.get("leit_ant"), norm.get("leit_atu"), norm.get("constante"), norm.get("consumo"))
              and _quebra_continuidade(prev.get("leit_atu"), norm.get("leit_ant"))):
            fichas.append("F05"); det["leit_fim_ant"] = prev.get("leit_atu"); det["leit_ini_atu"] = norm.get("leit_ant")
    return sorted(set(fichas)), det

# ---------- interpretacao (nano + prompt_confirmar) ----------
def _prompt_confirmar():
    p = os.environ.get("PROMPT_CONFIRMAR_PATH") or _find_up("backend", "data", "prompt_confirmar.txt") or ""
    try: return open(p, encoding="utf-8").read()[:6000]
    except: return "Voce e um auditor de faturas de energia. Explique as fichas apontadas em linguagem tecnica clara."
def interpretar(norm, fichas, det, arquivo):
    c = _client()
    if not _LLM["ok"] or not fichas: return None
    if _LLM["interp_model"] is None:
        _LLM["interp_model"] = INTERP_MODELS[-1]
        for m in INTERP_MODELS:
            try:
                _chat(c, m, [{"role":"user","content":"ok"}], max_out=16)
                _LLM["interp_model"] = m; break
            except Exception: continue
    ctx = f"Fatura {arquivo}. Distribuidora {norm.get('distribuidora')}. Consumo {norm.get('consumo')} kWh. Fichas: {fichas}. Detalhe: {json.dumps(det,ensure_ascii=False)}."
    try:
        r = _chat(c, _LLM["interp_model"],
            [{"role":"system","content":_prompt_confirmar()[:3000]},
             {"role":"user","content":ctx+"\nEscreva 2-3 frases objetivas para o analista sobre o que foi apontado e por que."}],
            max_out=220)
        return (r.choices[0].message.content or "").strip()
    except Exception as e:
        return f"(interpretacao indisponivel: {str(e)[:60]})"

# ---------- historico impresso (bloco da propria fatura) ----------
def hist_impresso(texto):
    vals = []
    for m in re.finditer(r"(?:JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)[/ ]?\d{2,4}\s+([\d.]{2,7})(?:,\d+)?\s", (texto or ""), re.I):
        v = _br(m.group(1))
        if v and 0 < v < 1_000_000: vals.append(v)
    return vals[:13]

def extrator_llm(texto):
    """FONTE DE CANDIDATOS via gpt-4.1-mini lendo o TEXTO (extrator, nao normalizador).
    Captura estrutura +/- completa (resolve ACL) e total onde regex nao acha (cobertura)."""
    c = _client()
    if not _LLM["ok"]: return {}
    prompt = ('Extraia da conta de energia (texto no fim) e responda SOMENTE JSON valido:\n'
        '{"valor_total":number|null,"consumo_kwh":number|null,"distribuidora":string|null,'
        '"classe":string|null,"modalidade":string|null,"gd":boolean,'
        '"itens":[{"descricao":string,"valor":number}]}\n'
        'Regras: LEIA literalmente, NAO calcule. valor_total = "Total a Pagar"/"Valor a Pagar". '
        'consumo_kwh = energia ativa consumida em kWh (some ponta+fora ponta se houver; NAO conte TE e TUSD em dobro). '
        'itens = TODAS as linhas de cobranca do detalhamento, INCLUINDO negativas (descontos, creditos, energia ACL, subvencao). '
        'gd=true SO se houver compensacao/SCEE/energia injetada/microgeracao. Campo ausente = null.\n\nTEXTO:\n'
        + (texto or "")[:12000])
    try:
        r = _chat(c, NORM_MODEL, [{"role":"user","content":prompt}], max_out=1600)
        m = re.search(r"\{.*\}", r.choices[0].message.content or "", re.S)
        return json.loads(m.group(0)) if m else {}
    except Exception as e:
        return {"_erro": str(e)[:90]}

def dados_ricos(out_v2):
    """Bloco de dados EXPANDIDO — tudo que o extrator captura, além dos campos-chave."""
    cli = out_v2.get("cliente") or {}; med = out_v2.get("medicao") or {}
    nf = out_v2.get("nota_fiscal") or {}; lt = out_v2.get("ligacao_tecnica") or {}
    pl = out_v2.get("periodo_leitura") or {}; ii = out_v2.get("identificadores_instalacao") or {}
    vv = out_v2.get("vencimento_valor") or {}; trib = out_v2.get("tributos_por_dist") or {}
    gd = out_v2.get("geracao_distribuida") or {}
    def tv(k):
        t = trib.get(k) or {}
        return {"base": t.get("base_string") or t.get("base"),
                "aliquota": t.get("aliquota_string") or t.get("aliquota"),
                "valor": t.get("valor_string") or t.get("valor")}
    return {
        "cadastro": {
            "razao_social": cli.get("razao_social"),
            "cnpj_cliente": cli.get("cnpj") or cli.get("cnpj_cliente_mascarado"),
            "endereco": cli.get("endereco"), "bairro": cli.get("bairro"), "cidade_uf": cli.get("cep_cidade_uf"),
            "numero_instalacao": ii.get("codigo_instalacao") or ii.get("uc_codigo"),
            "numero_cliente": ii.get("codigo_cliente"),
            "medidor": ii.get("medidor") or med.get("medidor") or lt.get("numero_medidor"),
            "classe": lt.get("classificacao_completa"), "subgrupo": lt.get("subgrupo"),
            "modalidade": lt.get("modalidade_tarifaria") or lt.get("modalidade"),
        },
        "documento": {
            "mes_referencia": vv.get("mes_referencia"), "vencimento": vv.get("data_vencimento"),
            "emissao": nf.get("data_emissao"), "nf_numero": nf.get("numero_nf"), "nf_serie": nf.get("serie"),
            "chave_acesso": nf.get("chave_acesso"), "protocolo": nf.get("protocolo_autorizacao"),
        },
        "medicao": {
            "medidor": med.get("medidor"), "leit_anterior": med.get("leitura_anterior") or pl.get("leitura_anterior"),
            "leit_atual": med.get("leitura_atual") or pl.get("leitura_atual"),
            "constante": med.get("constante"), "consumo_medido": med.get("consumo"),
            "proxima_leitura": pl.get("proxima_leitura"), "dias": pl.get("dias_consumo"),
        },
        "bandeira": lt.get("bandeira_tarifaria"),
        "tributos": {"icms": tv("icms"), "pis": tv("pis"), "cofins": tv("cofins")},
        "gd": {"tem_gd": gd.get("tem_gd"), "injetada_kwh": gd.get("energia_injetada_kwh"),
               "compensada_kwh": gd.get("energia_compensada_kwh"),
               "saldo_fora_ponta_kwh": gd.get("saldo_acumulado_fora_ponta_kwh"),
               "lei": gd.get("lei_referencia"), "classificacao": gd.get("classificacao")},
        "historico": [
            {"mes": h.get("mes"), "ano": h.get("ano"),
             "consumo_kwh": h.get("consumo_kwh"), "dias": h.get("dias_ciclo")}
            for h in (out_v2.get("historico_13m_consumo") or [])
        ],
    }

def itens_limpos(out_v2):
    out = []
    for it in (out_v2.get("itens_fatura") or []):
        out.append({
            "descricao": it.get("descricao"), "unidade": it.get("unidade"), "posto": it.get("posto"),
            "qtd": it.get("quantidade_numerica"), "tarifa": it.get("tarifa_unit_numerica"),
            "valor": it.get("valor_brl_numerico"),
            "icms": it.get("icms_numerico") if "icms_numerico" in it else it.get("icms_brl_numerico"),
            "pis_cofins": it.get("pis_cofins_brl_numerico"), "credito_gd": it.get("eh_credito_gd"),
        })
    return out

def parse_nome(fn):
    m = re.match(r"(.+?)_(\d{2})-(\d{2})\.pdf$", fn, re.I)
    if m: return m.group(1), f"{m.group(2)}-{m.group(3)}", (int(m.group(3)), int(m.group(2)))
    return fn, None, (0, 0)

def _chave_uc(r):
    """Chave de agrupamento por CONTEÚDO: a instalação LIDA do PDF (não o nome do
    arquivo). Fallback: uc do nome / arquivo. Assim 20 faturas da mesma UC com
    qualquer nome agrupam e formam a série p/ o motor."""
    inst = ((r.get("dados") or {}).get("cadastro") or {}).get("numero_instalacao")
    inst = re.sub(r"\D", "", str(inst or ""))
    return inst if len(inst) >= 4 else str(r.get("uc") or r.get("arquivo") or "?")

def _ord_key(r):
    """Chave de ordenação cronológica (ano*12+mês). Usa o mês do NOME (_ordem) se
    houver; senão o vencimento/emissão EXTRAÍDO do PDF. 0 = sem data (fica no início)."""
    o = r.get("_ordem") or (0, 0)
    if o != (0, 0):
        y = o[0] + 2000 if o[0] < 100 else o[0]
        return y * 12 + o[1]
    doc = (r.get("dados") or {}).get("documento") or {}
    for campo in ("vencimento", "emissao", "competencia"):
        s = str(doc.get(campo) or "")
        mb = re.search(r"\b(\d{2})/(\d{2})/(\d{4})\b", s)
        if mb: return int(mb.group(3)) * 12 + int(mb.group(2))
        mi = re.search(r"\b(\d{4})-(\d{2})-\d{2}\b", s)
        if mi: return int(mi.group(1)) * 12 + int(mi.group(2))
    return 0

def main():
    global OUTDIR
    job = os.environ.get("JOB_DIR")  # modo JOB (backend): le <job>/pdfs, escreve <job>/relatorio + status.json
    if job:
        pasta = os.path.join(job, "pdfs"); OUTDIR = os.path.join(job, "relatorio"); os.makedirs(OUTDIR, exist_ok=True)
        STATUS = os.path.join(job, "status.json")
    else:
        os.makedirs(OUTDIR, exist_ok=True)
        pasta = sys.argv[1] if len(sys.argv) > 1 else \
            r"C:\Users\AlissonGonçalvesRodr\OneDrive - AMEnergia\Área de Trabalho\Docker\protótipos\Faturas Santander - Vinicius_19-06-2026"
        STATUS = os.path.join(OUTDIR, "status.json")
    limite = int(sys.argv[2]) if (not job and len(sys.argv) > 2) else 0
    def _status(**kw):
        try: json.dump(kw, open(STATUS, "w", encoding="utf-8"), ensure_ascii=False)
        except Exception: pass
    pdfs = sorted(f for f in os.listdir(pasta) if f.lower().endswith(".pdf"))
    if limite > 0:
        pdfs = pdfs[:limite]
    elif limite < 0:  # amostra ESTRATIFICADA (espalhada) para bater os 2 baldes
        n = abs(limite); step = max(1, len(pdfs)//n); pdfs = pdfs[::step][:n]
    print(f"FASE1: {len(pdfs)} PDFs | coord={USE_COORD} | LLM_norm={NORM_MODEL} | out={os.path.basename(OUTDIR)}")
    FaturaExtractorV2.carregar_mapas()
    t0 = time.time(); regs = []; erros = 0
    _status(estado="processando", etapa="extracao", total=len(pdfs), prontas=0, erros=0, tempo_s=0)
    for i, fn in enumerate(pdfs, 1):
        uc, mes, ordem = parse_nome(fn)
        r = {"arquivo": fn, "uc": uc, "mes": mes, "_ordem": ordem}
        try:
            b = open(os.path.join(pasta, fn), "rb").read()
            texto, _ = extrair_plumber(b)
            r["_ocr"] = len(texto.strip()) < 500
            md = ""
            if len(texto.strip()) < 800:   # so 2a leitura quando o texto nativo e fraco (evita liteparse lento)
                try: md = extrair_markdown(b) or ""
                except Exception: pass
            pdf_path = os.path.join(pasta, fn)
            v2 = FaturaExtractorV2(texto=texto[:80000], conn=None); v2.pdf_path = pdf_path
            out_v2 = v2.extrair_tudo() or {}
            if USE_COORD:
                r["_camadas"] = _camadas_extra(out_v2, texto, pdf_path)
            C, itens = coletar_candidatos(out_v2, texto, md)
            norm = normalizar(C, itens, texto)
            # FASE 1c: extrator LLM SO no balde dificil (sem-total / nao-reconcilia / ACL)
            hard = (not norm.get("valor_total")) or (not norm.get("_soma_bate_total")) or norm.get("_acl")
            if USE_LLM_EXTRATOR and hard:
                llm = extrator_llm(texto); r["llm"] = {k: llm.get(k) for k in ("valor_total","consumo_kwh","distribuidora","gd") if k in llm}
                if llm and not llm.get("_erro"):
                    if _f(llm.get("valor_total")): C.setdefault("valor_total", []).append({"valor": _f(llm["valor_total"]), "fonte": "llm"})
                    if _f(llm.get("consumo_kwh")): C.setdefault("consumo", []).append({"valor": _f(llm["consumo_kwh"]), "fonte": "llm"})
                    if llm.get("distribuidora"): C.setdefault("distribuidora", []).append({"valor": llm["distribuidora"], "fonte": "llm"})
                    norm = normalizar(C, itens, texto)
                    # ACL-aware: itens +/- do LLM reconciliam com o total?
                    soma_llm = round(sum(_f(it.get("valor")) or 0 for it in (llm.get("itens") or [])), 2)
                    vt = norm.get("valor_total")
                    if vt and soma_llm != 0 and abs(soma_llm - vt) <= max(0.5, vt * 0.02):
                        norm["_soma_bate_total"] = True; norm["_reconc_fonte"] = "llm_itens"; norm["_gap_pct"] = 0.0
                    norm["_llm_usado"] = True
            r["candidatos"] = C; r["normalizado"] = norm
            r["dados"] = dados_ricos(out_v2); r["itens"] = itens_limpos(out_v2)
            r["hist_impresso"] = hist_impresso(texto)
        except Exception as e:
            r["_erro"] = str(e)[:200]
        if r.get("_erro"): erros += 1
        regs.append(r)
        _status(estado="processando", etapa="extracao", total=len(pdfs), prontas=i, erros=erros, tempo_s=round(time.time()-t0,1))
        if i % 40 == 0: print(f"  ...{i}/{len(pdfs)}  ({time.time()-t0:.0f}s)")

    _status(estado="processando", etapa="motor_e_interpretacao", total=len(pdfs), prontas=len(pdfs), erros=erros, tempo_s=round(time.time()-t0,1))
    # motor por UC (serie) — agrupa pela INSTALAÇÃO lida do PDF (fallback nome do arquivo)
    por_uc = {}
    for r in regs:
        if not r.get("_erro"): por_uc.setdefault(_chave_uc(r), []).append(r)
    for uc, rs in por_uc.items():
        rs.sort(key=_ord_key)
        serie = [(x["normalizado"].get("consumo") or 0) for x in rs]
        okeys = [_ord_key(x) for x in rs]
        for idx, r in enumerate(rs):
            prev = rs[idx-1]["normalizado"] if idx > 0 else None
            mc = bool(idx > 0 and okeys[idx] and okeys[idx-1] and okeys[idx]-okeys[idx-1] == 1)
            fichas, det = motor(serie, idx, r["normalizado"], r.get("hist_impresso"), prev, mc)
            r["fichas"] = fichas; r["fichas_det"] = det

    # interpretacao (so faturas com ficha)
    n_interp = 0
    for r in regs:
        if r.get("fichas"):
            r["interpretacao"] = interpretar(r["normalizado"], r["fichas"], r.get("fichas_det", {}), r["arquivo"]); n_interp += 1

    # ---- saidas ----
    json.dump(regs, open(os.path.join(OUTDIR, "relatorio.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    # metricas (§23)
    ok = [r for r in regs if not r.get("_erro")]
    soma_ok = sum(1 for r in ok if r["normalizado"].get("_soma_bate_total"))
    gd_true = sum(1 for r in ok if r["normalizado"].get("gd"))
    from collections import Counter
    fic = Counter()
    for r in ok:
        for f in r.get("fichas", []): fic[f] += 1
    conf_baixa = sum(1 for r in ok for k, v in (r["normalizado"].get("_confianca") or {}).items() if v < 80)
    met = {"total": len(regs), "ok": len(ok), "erro": len(regs)-len(ok),
           "ocr_necessario": sum(1 for r in ok if r.get("_ocr")),
           "soma_bate_total": f"{soma_ok}/{len(ok)}",
           "pct_coerencia": round(100*soma_ok/max(1,len(ok)),1),
           "gd_true": gd_true, "campos_conf_baixa": conf_baixa,
           "fichas": dict(fic), "faturas_com_ficha": sum(1 for r in ok if r.get("fichas")),
           "interpretadas": n_interp, "tempo_s": round(time.time()-t0,1),
           "llm_norm": NORM_MODEL, "llm_interp": _LLM.get("interp_model")}
    json.dump(met, open(os.path.join(OUTDIR, "metricas.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    _status(estado="concluido", etapa="fim", total=len(regs), prontas=len(regs), erros=len(regs)-len(ok),
            tempo_s=round(time.time()-t0,1), fichas=dict(fic), faturas_com_ficha=met["faturas_com_ficha"])
    print("\n=== METRICAS FASE 1 ===")
    for k, v in met.items(): print(f"  {k}: {v}")
    print(f"\nsaidas em: {OUTDIR} (relatorio.json, metricas.json)")

if __name__ == "__main__":
    main()
