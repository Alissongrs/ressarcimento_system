# -*- coding: utf-8 -*-
"""Medição por molde de layout (etapa 2 da captura de alto nível, 16/11/2026).

Lê a TABELA DE MEDIÇÃO da fatura (medidor, grandeza, posto, leitura anterior, leitura atual,
constante, consumo) pelas linhas posicionadas do PDF e valida cada registro pela física:

    energia:  consumo = (leit_atual − leit_anterior) × constante           [× (1 + perda)]
    demanda:  consumo = leit_atual × constante  (Enel SP)  ou  (atual − anterior) × constante (Enel Rio)

Um molde descreve como um layout imprime essa tabela (cabeçalho que a identifica, colunas,
vocabulário de grandezas/postos). O resultado é único para todos os moldes:

    {
      "molde": "enel", "medidor": "17845173", "constante": 0.042, "perda_pct": 2.5 | None,
      "perda_origem": "linha" | "inferida" | None,
      "registros": [{medidor, grandeza, posto, sub, leit_ant, leit_atu, constante, consumo,
                     calc, ok, regra}, ...],
      "consumo_medido":   {"p": .., "fp": .., "unico": .., "reservado": .., "intermediario": ..},
      "consumo_faturado": {...idem, já com a perda da linha PERDA aplicada...},
      "demanda_medida":   {"p": .., "fp": ..},
      "leituras": {"p": {"ant", "atu", "constante"}, "fp": {...}},
      "demanda_contratada": {"p": .., "fp": ..},
      "validado": bool, "n_registros": int, "n_ok": int, "obs": [...],
      "aplicar": {coluna SQL: valor}      # o que atualizar_colunas_db._coleta_campos grava
    }

Uso avulso:  python medicao.py fatura.pdf [--json]
"""
from __future__ import annotations

import collections
import io
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

AQUI = Path(__file__).resolve().parent
if str(AQUI) not in sys.path:
    sys.path.insert(0, str(AQUI))

from identificacao import Item, itens_do_pdf, normalizar  # noqa: E402

# ─── números ──────────────────────────────────────────────────────────────────
RE_NUM_BR = re.compile(r"^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$")
RE_NUM_PONTO = re.compile(r"^-?\d{1,4}\.\d{4,6}$")  # constante com ponto decimal: 3.6000, 0.0360, 1.0000
RE_PCT = re.compile(r"(\d+(?:[.,]\d+)?)\s*%")


RE_NUM_PONTO3 = re.compile(r"^-?\d{4,}\.\d{3}$")  # "1463.000" (EDP): 4+ dígitos antes do ponto → decimal


def parse_num(tok: str) -> float | None:
    t = tok.strip()
    if RE_NUM_PONTO.match(t) or RE_NUM_PONTO3.match(t):
        return float(t)
    if RE_NUM_BR.match(t):
        return float(t.replace(".", "").replace(",", "."))
    return None


def eh_num(tok: str) -> bool:
    return parse_num(tok) is not None


# ─── linhas e pedaços ─────────────────────────────────────────────────────────
def agrupar_linhas(itens: list[Item], tol: float = 2.2) -> list[list[Item]]:
    """Agrupa itens em linhas por proximidade de y (mesma página)."""
    linhas: list[list[Item]] = []
    for it in sorted(itens, key=lambda i: (i.page, i.y, i.x)):
        if linhas and linhas[-1][0].page == it.page and abs(linhas[-1][0].y - it.y) <= tol:
            linhas[-1].append(it)
        else:
            linhas.append([it])
    for ln in linhas:
        ln.sort(key=lambda i: i.x)
    return linhas


def pedacos(itens_linha: list[Item]) -> list[tuple[str, float]]:
    """Palavras com x estimado; junta continuações numéricas que o liteparse separa ('27' + '.195,462')."""
    out: list[tuple[str, float]] = []
    for it in itens_linha:
        n = max(len(it.text), 1)
        for m in re.finditer(r"\S+", it.text):
            out.append((m.group(0), it.x + it.w * m.start() / n))
    out.sort(key=lambda p: p[1])
    junt: list[tuple[str, float]] = []
    for tok, x in out:
        if junt and tok[:1] in ".," and re.fullmatch(r"-?\d+", junt[-1][0]) and re.fullmatch(r"[.,][\d.,%]+", tok):
            junt[-1] = (junt[-1][0] + tok, junt[-1][1])
        else:
            junt.append((tok, x))
    return junt


# ─── vocabulário ──────────────────────────────────────────────────────────────
RE_POSTO = re.compile(
    r"(?P<posto>f ponta indu|f ponta cap|f ponta|fora de ponta|fora ponta|ponta indu|ponta cap|ponta|"
    r"unico|reservad\w*|intermediari\w*|hfp|hp|hr|na)\s*$")


_TOK_FP = {"fp", "fpta", "f-pta", "hfp", "fponta", "f.pta", "fora"}
_TOK_P = {"ponta", "pta", "np", "hp", "p"}
_TOK_RES = {"reservado", "hr", "res", "reserv", "rsv"}
_TOK_UNI = {"unico", "total", "tp", "geral"}


def descolar(s: str) -> str:
    """O liteparse às vezes cola palavras do posto ("F PONTAINDU", "PONTACAP") conforme a plataforma; separa."""
    return re.sub(r"\bponta(indu|cap)\b", r"ponta \1", s)


def classificar_posto(s: str) -> tuple[str, str | None]:
    """Posto pelas palavras, em qualquer posição: 'F PONTA INDU' → ('fp', 'indu'); 'Consumo Ativo NP Reg' → ('p', None);
    'En Ativa F-Pta' → ('fp', None); '' / 'Único' / 'Total' → ('unico', None)."""
    n = normalizar(s)
    toks = re.split(r"[\s/]+", n.replace(".", "").replace("-", "-"))
    sub = None
    if "indu" in n:
        sub = "indu"
    elif re.search(r"\bcap\b", n):
        sub = "cap"
    if any(t in _TOK_RES for t in toks) or "reserv" in n:
        return "reservado", sub  # antes do fora ponta: Energisa imprime "RSV  Fora Ponta"
    if any(t in _TOK_FP for t in toks) or re.search(r"\bf\.? ?ponta|fora (de )?ponta|f-pta", n):
        return "fp", sub
    if "intermed" in n:
        return "intermediario", sub
    if any(t in _TOK_P for t in toks):
        return "p", sub
    return "unico", sub


def classificar_grandeza(s: str) -> str:
    n = normalizar(s)
    if "perda" in n:
        return "perda"
    if "injet" in n:
        return "energia_injetada"  # GD: não é consumo
    if "compens" in n:
        return "energia_compensada"
    if "ufer" in n:
        return "ufer"
    if "dmcr" in n or (("demanda" in n or re.search(r"\bdem\b", n)) and ("reativ" in n or "rtv" in n or "reat" in n)):
        return "demanda_reativa"
    if "demanda" in n or re.search(r"\bdem\b", n) or "fio" in n:  # Light ML: "Componente Fio-kW" = demanda
        return "demanda"
    if "reativ" in n or "rtv" in n or re.search(r"\breat\b", n):  # "Consumo Reativo", "Energia Reativa", "ENRGRTV"
        return "energia_reativa"
    if "kvarh" in n or "kvar" in n:
        return "energia_reativa"
    if re.search(r"\brsv\b", n):  # Energisa MT: "RSV" = energia ativa no reservado
        return "energia_ativa"
    if "consumo" in n or "ativ" in n or "atv" in n or "kwh" in n or "energia" in n or "enrg" in n or n.startswith("en "):
        return "energia_ativa"
    return "outra"


# ─── registro ─────────────────────────────────────────────────────────────────
@dataclass
class Registro:
    medidor: str | None
    grandeza: str
    grandeza_txt: str
    posto: str
    sub: str | None
    posto_txt: str
    leit_ant: float | None
    leit_atu: float | None
    constante: float | None
    consumo: float | None
    calc: float | None = None
    ok: bool | None = None
    regra: str | None = None

    def dict(self) -> dict:
        return {"medidor": self.medidor, "grandeza": self.grandeza, "grandeza_txt": self.grandeza_txt,
                "posto": self.posto, "sub": self.sub, "posto_txt": self.posto_txt,
                "leit_ant": self.leit_ant, "leit_atu": self.leit_atu, "constante": self.constante,
                "consumo": self.consumo, "calc": self.calc, "ok": self.ok, "regra": self.regra}


# ─── molde Enel (SP / Rio / Ceará): "Medidor | Grandezas | Postos Tarifários | Leitura Anterior |
#     Leitura Atual | Const. Medidor | Consumo" ──────────────────────────────────────────────
RE_MEDIDOR = re.compile(r"^[A-Z]{0,3}\d[\dA-Z\-]{4,}$")  # sem barra/ponto: "12/2025" e "1.116,57" não são medidor
RE_MES = re.compile(r"\b(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)/\d{2,4}\b|\b\d{2}/\d{4}\b", re.I)


def _cabecalho_enel(linhas: list[list[Item]]) -> dict | None:
    """Acha a faixa de cabeçalho da tabela de medição. Devolve x das colunas e y do fim do cabeçalho."""
    for i, ln in enumerate(linhas):
        med = [it for it in ln if it.norm == "medidor"]
        if not med:
            continue
        # cabeçalho = até 3 linhas (Medidor/Grandezas, Postos/Leitura/Leitura/Const./Consumo, Tarifários/...)
        # só palavras de cabeçalho (sem dígitos): a 1ª linha de dados fica a poucos pontos do cabeçalho
        faixa = [it for l2 in linhas[max(0, i - 2): i + 3] if l2[0].page == ln[0].page
                 for it in l2 if abs(it.y - med[0].y) <= 14 and not re.search(r"\d", it.text)]
        normas = {it.norm for it in faixa}
        if not any(n.startswith("grandeza") for n in normas) or not any("leitura" in n for n in normas):
            continue
        x_med = med[0].x
        x_gr = min((it.x for it in faixa if it.norm.startswith("grandeza")), default=x_med + 40)
        x_cons = max((it.x for it in faixa if it.norm.startswith("consumo")), default=None)
        if x_cons is None:
            continue
        direita = [it.x for it in faixa if it.x > x_cons + 10 and (it.norm.startswith("itens") or it.norm.startswith("unid")
                                                                  or it.norm.startswith("descri"))]
        x_fim = (min(direita) - 2) if direita else x_cons + 75
        # o cabeçalho termina na linha "Anterior / Atual" (a 1ª linha de dados vem logo abaixo, e suas
        # palavras — ENRG ATV, PONTA — não têm dígitos; por isso não se usa o max y da faixa inteira)
        fim = [it.y for it in faixa if it.norm in ("anterior", "atual")]
        y_fim = (max(fim) if fim else med[0].y + 4) + 2
        return {"page": med[0].page, "y_fim": y_fim, "x_med": x_med, "x_gr": x_gr,
                "x_cons": x_cons, "x_fim": x_fim}
    return None


def _ler_enel(itens: list[Item]) -> tuple[list[Registro], float | None] | None:
    linhas = agrupar_linhas(itens)
    cab = _cabecalho_enel(linhas)
    if not cab:
        return None
    regs: list[Registro] = []
    perda_pct = None
    ultimo_medidor = None
    y_ult = cab["y_fim"]
    pendente: Registro | None = None
    for ln in linhas:
        if ln[0].page != cab["page"] or ln[0].y <= cab["y_fim"]:
            continue
        if ln[0].y - y_ult > 40:  # acabou a tabela
            break
        dentro = [it for it in ln if cab["x_med"] - 30 <= it.x < cab["x_fim"] - 1]
        if not dentro:
            continue
        toks = [(t, x) for t, x in pedacos(dentro) if x < cab["x_fim"] - 1]
        if not toks:
            continue
        # linha de perda de transformação: "PERDA DE TRANSF.- 2,5%"
        texto = " ".join(t for t, _ in toks)
        texto_pre = " ".join(t for t, _ in toks[: next((k for k, (t, _) in enumerate(toks) if parse_num(t) is not None), len(toks))])
        if RE_MES.search(texto_pre):
            continue  # histórico ("consumo fora ponta jun/25 …"), não registro (mês DEPOIS dos números é texto vizinho)
        if "perda" in normalizar(texto):
            m = RE_PCT.search(texto)
            if m:
                perda_pct = float(m.group(1).replace(",", "."))
            y_ult = ln[0].y
            continue
        medidor = None
        if toks[0][1] < cab["x_gr"] - 6 and RE_MEDIDOR.match(toks[0][0]) and sum(c.isdigit() for c in toks[0][0]) >= 4:
            medidor = toks[0][0]
            toks = toks[1:]
        palavras, nums = [], []
        for t, x in toks:
            v = parse_num(t)
            if v is not None and not palavras and not nums and medidor is None:
                # linha de continuação só com números (ex.: "Energia Reativa-kVArh 183,87 183,87 1.0000 0,00")
                nums.append(v)
            elif v is not None and (palavras or medidor is not None or nums):
                nums.append(v)
            elif v is None and not nums:
                palavras.append(t)
            else:
                break  # palavra depois dos números: começou outra coisa
        if not palavras and not nums:
            continue
        y_ult = ln[0].y
        texto_p = descolar(normalizar(" ".join(palavras)))
        m = RE_POSTO.search(texto_p)
        posto_txt = m.group("posto") if m else ""
        grand_txt = texto_p[: m.start()].strip(" -") if m else texto_p
        # linha quebrada em duas (Enel Ceará): "PONTA" numa, "Energia Reativa-kVArh 183,87 ..." na outra
        if pendente is not None and (not palavras or (not posto_txt and nums)) and len(nums) >= 3:
            if nums and pendente.leit_ant is None:
                pendente.leit_ant, pendente.leit_atu, pendente.constante, pendente.consumo = (nums + [None] * 4)[:4]
            if grand_txt and pendente.grandeza == "outra":
                pendente.grandeza, pendente.grandeza_txt = classificar_grandeza(grand_txt), grand_txt
            if pendente.leit_ant is not None:
                regs.append(pendente)
                pendente = None
            continue
        if medidor is None and not palavras:
            continue
        posto, sub = classificar_posto(posto_txt or texto_p)  # Equatorial: posto dentro da grandeza ("Consumo Ativo FP Reg")
        grandeza = classificar_grandeza(grand_txt) if grand_txt else "outra"
        if medidor is None and grandeza == "outra" and not posto_txt:
            break  # texto depois da tabela (avisos, débitos): acabou
        if medidor:
            ultimo_medidor = medidor
        reg = Registro(medidor or ultimo_medidor, grandeza, grand_txt, posto, sub, posto_txt,
                       *((nums + [None] * 4)[:4]))
        if reg.leit_ant is None or reg.consumo is None:
            # sem números ainda: pode ser a 1ª metade de uma linha quebrada
            pendente = reg if (grandeza != "outra" or posto_txt) else None
            continue
        if len(nums) == 3:  # sem constante impressa
            reg.leit_ant, reg.leit_atu, reg.constante, reg.consumo = nums[0], nums[1], None, nums[2]
        regs.append(reg)
    return regs, perda_pct


# ─── validação ────────────────────────────────────────────────────────────────
def _calc_candidatos(r: Registro) -> list[tuple[str, float]]:
    if r.leit_ant is None or r.leit_atu is None or r.leit_ant < 0 or r.leit_atu < 0:
        return []
    if r.constante is not None and r.constante <= 0:
        return []  # constante zero/negativa: não é medição
    k = r.constante if r.constante is not None else 1.0
    atu = r.leit_atu
    if atu < r.leit_ant and r.leit_ant > 0:  # virada do medidor
        atu = atu + 10 ** len(str(int(r.leit_ant)))
    dif = (atu - r.leit_ant) * k
    if r.grandeza in ("demanda", "demanda_reativa"):
        return [("atual×K", r.leit_atu * k), ("(atual−anterior)×K", dif)]
    return [("(atual−anterior)×K", dif)]


def _bate(c: float, calc: float, fator: float = 1.0) -> bool:
    alvo = calc * fator
    tol = max(0.02, 0.003 * abs(c))
    if float(c).is_integer():  # consumo impresso sem decimais (CPFL "3.918", Amazonas "42"): arredondamento
        tol = max(tol, 0.6)
    return abs(c - alvo) <= tol


def validar(regs: list[Registro], perda_linha: float | None) -> tuple[float | None, str | None]:
    """Marca ok/calc/regra em cada registro. Devolve (perda_pct, origem) — 'linha' quando impressa,
    'inferida' quando o consumo da coluna já vem acrescido de uma perda constante (Enel Rio)."""
    fatores = [1.0]
    if perda_linha:
        fatores.append(1 + perda_linha / 100)
    razoes = []
    for r in regs:
        cands = _calc_candidatos(r)
        r.ok = None
        if r.consumo is None or not cands:
            continue
        if r.consumo == 0 and all(abs(c) < 1e-9 for _, c in cands):
            r.ok, r.calc, r.regra = True, 0.0, "sem consumo"
            continue
        for regra, calc in cands:
            for f in fatores:
                if _bate(r.consumo, calc, f):
                    r.ok, r.calc, r.regra = True, round(calc * f, 3), regra + (f" × {f:.4f}" if f != 1.0 else "")
                    break
            if r.ok:
                break
        if r.ok is None:
            r.ok = False
            # candidato mais próximo (razão consumo/cálculo mais perto de 1) — é dele que se infere a perda
            melhor = min((c for c in cands if c[1] > 0), key=lambda c: abs(r.consumo / c[1] - 1), default=cands[0])
            r.calc = round(melhor[1], 3)
            r.regra = melhor[0]
            if r.consumo > 0 and melhor[1] > 0:
                razoes.append(r.consumo / melhor[1])
    perda, origem = perda_linha, ("linha" if perda_linha else None)
    # perda impressa (linha/texto) MAS a coluna consumo só fecha com o fator → a perda já está embutida na
    # coluna (Energisa MT); quem monta o faturado não pode aplicar de novo
    if perda_linha and any(r.ok and re.search(r"× \d", r.regra or "") for r in regs if r.grandeza == "energia_ativa"):
        origem = "embutida"  # regra terminou em "× 1.0250": a coluna só fechou com o fator
    # perda embutida na coluna: todas as linhas que falharam têm a mesma razão (1,0 < r < 1,12)
    if razoes and all(1.001 < z < 1.12 for z in razoes) and max(razoes) - min(razoes) < 0.004:
        f = sum(razoes) / len(razoes)
        for r in regs:
            if r.ok is False and r.consumo and r.consumo > 0:
                for regra, calc in _calc_candidatos(r):
                    if _bate(r.consumo, calc, f):
                        r.ok, r.calc, r.regra = True, round(calc * f, 3), f"{regra} × {f:.4f} (perda inferida)"
                        break
        if perda is None:
            perda, origem = round((f - 1) * 100, 2), "inferida"
    return perda, origem


# ─── demanda contratada (quadro "grandezas contratadas") ──────────────────────
RE_DEM_CONTR = re.compile(
    r"^(?:demanda(?: contratada)?(?: de)?(?: (?P<posto>fora ponta|fora de ponta|ponta|unica))?\s*-?\s*\(?kw\)?|"
    r"demanda contratada(?: (?P<posto2>fora ponta|fora de ponta|ponta|unica))?(?:\s*\(?kw\)?)?)\s*:?\s*(?P<val>[\d.,]+)?\s*$")


def demanda_contratada(itens: list[Item]) -> dict:
    """Rótulo 'Demanda - KW' / 'DEMANDA FORA PONTA - KW' / 'Demanda contratada' como item próprio;
    o valor está no mesmo item ou no item seguinte da linha. Itens da tabela de faturamento não entram."""
    out: dict[str, float] = {}
    for ln in agrupar_linhas(itens):
        if ln[0].page > 1:
            continue
        for k, it in enumerate(ln):
            n = it.norm.strip()
            if n.startswith("d. ctda") or n.startswith("d.ctda"):  # Amazonas: "D. Ctda Pta: 70", "D. Ctda F.Pta: 70"
                mm = re.match(r"d\.\s*ctda\s*(?P<posto>f\.?\s*pta|pta)?\s*:?\s*(?P<val>[\d.,]+)?$", n)
                if mm and mm.group("val"):
                    v = parse_num(mm.group("val"))
                    if v and v > 0:
                        out.setdefault("p" if mm.group("posto") == "pta" else "fp", v)
                continue
            if not n.startswith("demanda"):
                continue
            if re.search(r"geracao|reativ|ultrapass|faturad|medid|retroativ|diferenc|historic|kwh|desconto", n):
                continue
            m = RE_DEM_CONTR.match(n)
            if not m:
                continue
            val = parse_num(m.group("val")) if m.group("val") else None
            if val is None:
                for o in ln[k + 1:]:
                    v = parse_num(o.text.split()[0]) if o.text.split() else None
                    if v is not None:
                        val = v
                        break
                    if re.search(r"[a-z]", o.norm):
                        break
            if not val or val <= 0:
                continue
            posto_txt = m.group("posto") or m.group("posto2") or ""
            posto = "p" if posto_txt == "ponta" else "fp"
            out.setdefault(posto, val)
    return out


# ─── molde CEMIG grupo B: "Tipo de Medição | Medição | Leitura Anterior | Leitura Atual |
#     Constante de Multiplicação | Consumo kWh"  →  "Energia kWh  ARK191000338  65.967  65.967  1  0"
def _ler_cemig_b(itens: list[Item]) -> tuple[list[Registro], float | None] | None:
    linhas = agrupar_linhas(itens)
    for i, ln in enumerate(linhas):
        if not any(it.norm.startswith("tipo de medicao") for it in ln):
            continue
        faixa = [it for l2 in linhas[i: i + 3] if l2[0].page == ln[0].page for it in l2 if abs(it.y - ln[0].y) <= 14]
        if not any(it.norm.startswith("constante") for it in faixa) or not any(it.norm.startswith("consumo") for it in faixa):
            continue
        x_ini = min(it.x for it in ln) - 5
        y_fim = max(it.y for it in faixa) + 2
        regs: list[Registro] = []
        for l2 in linhas[i + 1:]:
            if l2[0].page != ln[0].page or l2[0].y <= y_fim:
                continue
            if l2[0].y - y_fim > 60 or any(it.norm.startswith("informacoes") for it in l2):
                break
            toks = [(t, x) for t, x in pedacos([it for it in l2 if it.x >= x_ini])]
            palavras = [t for t, _ in toks if parse_num(t) is None and not RE_MEDIDOR.match(t)]
            medidor = next((t for t, _ in toks if RE_MEDIDOR.match(t) and re.search(r"[A-Z]", t) and sum(c.isdigit() for c in t) >= 4), None)
            nums = [parse_num(t) for t, _ in toks if parse_num(t) is not None and t != medidor]
            if not palavras or len(nums) < 3:
                continue
            gtxt = " ".join(palavras)
            grandeza = "energia_ativa" if "kwh" in normalizar(gtxt) and "reativ" not in normalizar(gtxt) else classificar_grandeza(gtxt)
            if len(nums) == 3:
                nums = [nums[0], nums[1], None, nums[2]]
            regs.append(Registro(medidor, grandeza, gtxt, "unico", None, "", nums[0], nums[1], nums[2], nums[3]))
            y_fim = l2[0].y
        return (regs, None) if regs else None
    return None


# ─── molde CEMIG grupo A (pág. "DEMONSTRATIVO DE GRANDEZAS FATURADAS"): tabela LEITURAS com 3
#     segmentos (HFP/único, HP, HR) × (anterior, atual); CONSTANTES (kWh); tabelas ENERGIA (kWh) e
#     DEMANDA (kW) com Registrado / Contratado / Faturado por segmento ───────────────────────────
def _ler_cemig_a(itens: list[Item]) -> tuple[list[Registro], float | None] | None:
    linhas = agrupar_linhas(itens)
    cab = None
    for i, ln in enumerate(linhas):
        if any(it.norm.startswith("segmentos") for it in ln) and i + 1 < len(linhas):
            l2 = linhas[i + 1]
            cols = [it.x for it in l2 if it.norm.startswith("leitura anterior") or it.norm.startswith("leitura atual")]
            if len(cols) >= 4:
                cab = (i + 1, ln[0].page, sorted(cols))
                break
    if not cab:
        return None
    i0, page, cols = cab
    segs = ["fp", "p", "reservado"]  # HFP/único, HP, HR — na ordem das colunas
    leit: dict[str, tuple[float | None, float | None]] = {}
    medidor = None
    for ln in linhas:
        if ln[0].page > page or medidor:
            break
        for k, it in enumerate(ln):
            if it.norm.startswith("medidor"):
                m = re.search(r"medidor\s*:?\s*([A-Z0-9][A-Z0-9\-]{5,})", it.text, re.I)
                if m:
                    medidor = m.group(1)
                elif k + 1 < len(ln) and RE_MEDIDOR.match(ln[k + 1].text.strip()):
                    medidor = ln[k + 1].text.strip()
                break
    for ln in linhas[i0 + 1: i0 + 12]:
        if ln[0].page != page:
            break
        rot = [it for it in ln if it.x < cols[0] - 10 and re.search(r"[a-z]", it.norm)]
        if not rot:
            continue
        n = rot[0].norm
        if not re.fullmatch(r"kwh", n):
            continue
        vals: dict[int, float] = {}
        for it in ln:
            if it in rot:
                continue
            v = parse_num(it.text)
            if v is None:
                continue
            # coluna = a de x mais próximo (os valores vêm alinhados à direita da coluna)
            j = min(range(len(cols)), key=lambda k: abs(cols[k] + 50 - (it.x + it.w)))
            vals[j] = v
        for s, seg in enumerate(segs):
            a, b = vals.get(2 * s), vals.get(2 * s + 1)
            if a is not None and b is not None:
                leit[seg] = (a, b)
        break
    # constantes: bloco "CONSTANTES" → linha "kWh  350" (item 'kWh' e o número à direita dele)
    const = None
    y_const = next((ln[0].y for ln in linhas if ln[0].page == page and any(it.norm == "constantes" for it in ln)), None)
    if y_const is not None:
        for ln in linhas:
            if ln[0].page != page or ln[0].y <= y_const:
                continue
            for k, it in enumerate(ln):
                if it.norm == "kwh":
                    vals = [parse_num(o.text) for o in ln[k + 1:] if parse_num(o.text) is not None]
                    if vals:
                        const = vals[0]
                    break
            if const is not None:
                break
    # tabelas ENERGIA (kWh) e DEMANDA (kW): linhas "Energia ativa" / "Demanda ativa" na ordem HFP, HP, HR;
    # colunas Registrado / Contratado / Faturado normal pelo x do cabeçalho
    def tabela(titulo: str, rotulo: str) -> dict[str, dict]:
        out: dict[str, dict] = {}
        j = next((k for k, ln in enumerate(linhas) if ln[0].page == page and any(it.norm.startswith(titulo) for it in ln)), None)
        if j is None:
            return out
        cab2 = next((ln for ln in linhas[j + 1: j + 3] if any(it.norm.startswith("registrado") for it in ln)), None)
        if not cab2:
            return out
        xs = {it.norm.split()[0]: it.x for it in cab2 if it.norm.split()[0] in ("registrado", "contratado", "faturado")}
        xf = sorted(it.x for it in cab2 if it.norm.startswith("faturado"))
        k = 0
        for ln in linhas[j + 2: j + 20]:
            if ln[0].page != page:
                break
            if any(it.norm.startswith(("constantes", "energia (kwh)", "fatores")) for it in ln) and ln is not linhas[j]:
                break
            if not any(it.norm.startswith(rotulo) for it in ln):
                continue
            seg = segs[k] if k < len(segs) else f"seg{k}"
            k += 1
            d: dict = {}
            for it in ln:
                v = parse_num(it.text)
                if v is None:
                    continue
                xr = it.x + it.w
                if "registrado" in xs and abs(xr - (xs["registrado"] + 40)) < 40:
                    d["registrado"] = v
                elif "contratado" in xs and abs(xr - (xs["contratado"] + 40)) < 40:
                    d["contratado"] = v
                elif xf and xr > xf[-1] - 5:
                    d["faturado"] = v
                elif xf and len(xf) > 1 and xr > xf[0] - 5:
                    d["faturado_ultrapassagem"] = v
            out[seg] = d
        return out
    energia = tabela("energia (kwh)", "energia ativa")
    demanda = tabela("demanda(kw)", "demanda ativa") or tabela("demanda (kw)", "demanda ativa")
    regs: list[Registro] = []
    for seg, (a, b) in leit.items():
        fat = (energia.get(seg) or {}).get("faturado")
        regs.append(Registro(medidor, "energia_ativa", "kWh", seg, None, seg, a, b, const, fat))
    for seg, d in demanda.items():
        if d.get("registrado") is not None:
            regs.append(Registro(medidor, "demanda", "Demanda ativa", seg, None, seg, None, d.get("registrado"), None,
                                 d.get("faturado")))
    if not regs:
        return None
    extras = {
        "demanda_contratada": {s: d["contratado"] for s, d in demanda.items() if d.get("contratado")},
        "demanda_faturada": {s: d["faturado"] for s, d in demanda.items() if d.get("faturado")},
    }
    return regs, None, extras


# ─── molde genérico (sem cabeçalho): qualquer linha "[medidor] grandeza/posto  n1 n2 n3 [n4] [unid]" em que
#     a física fecha — (atual − anterior) × K = consumo — vira registro. Cobre CPFL/RGE ("40217290 Energia
#     Ativa - kWh Ponta 004922 006557 0,40000 654"), Copel ("0251784558 CONSUMO kWh TP 18451 18530 80 6320"),
#     Energisa PB/MT, Equatorial Goiás/Piauí, EDP ("Ativo 14955705 18.542 18.755 1,00000 213,00"), Celesc
#     ("42133811 Energia Único 423 426 30,00000 0,00 90"), Amazonas (atual antes da anterior). ─────────────
def _ordenacoes(nums: list[float]) -> list[tuple[float, float, float | None, float, str]]:
    """Janelas (ant, atu, K, consumo, nome) a tentar numa sequência de números."""
    out = []
    n = len(nums)
    for i in range(0, max(n - 3, 0) + 1):
        if i + 4 <= n:
            a, u, k, c = nums[i:i + 4]
            out.append((a, u, k, c, "ant atu K cons"))
            out.append((u, a, k, c, "atu ant K cons"))
    if n >= 5:
        out.append((nums[0], nums[1], nums[2], nums[-1], "ant atu K … cons"))
    for i in range(0, max(n - 2, 0) + 1):
        if i + 3 <= n:
            a, u, c = nums[i:i + 3]
            out.append((a, u, None, c, "ant atu cons"))
    return out


def _ler_generico(itens: list[Item]) -> tuple[list[Registro], float | None, dict] | None:
    regs: list[Registro] = []
    vistos: set = set()
    for ln in agrupar_linhas(itens):
        if ln[0].page > 1:
            break
        toks = pedacos(ln)
        # corrida de números
        flags = [parse_num(t) is not None for t, _ in toks]
        tem_medidor = any(RE_MEDIDOR.match(t) and sum(ch.isdigit() for ch in t) >= 4 for t, _ in toks)
        if sum(flags) > 6 and not tem_medidor:
            continue  # linha de item (quantidade, tarifa, valor, base, alíquota, …): não é medição
        i = 0
        while i < len(toks):
            if not flags[i]:
                i += 1
                continue
            j = i
            while j < len(toks) and flags[j]:
                j += 1
            run = [parse_num(t) for t, _ in toks[i:j]]
            antes = toks[:i]
            texto_antes = " ".join(t for t, _ in antes)
            if "r$" in texto_antes.lower() or "%" in texto_antes or RE_MES.search(texto_antes):
                i = j
                continue  # item de faturamento / histórico (mês de referência na descrição)
            if len(run) >= 3 and antes:
                medidor = next((t for t, _ in antes if RE_MEDIDOR.match(t) and sum(ch.isdigit() for ch in t) >= 4), None)
                palavras = [t for t, _ in antes if t != medidor and not RE_MEDIDOR.match(t)]
                txt = " ".join(palavras)
                txt_n = descolar(normalizar(txt))
                grandeza = classificar_grandeza(txt_n) if txt else "outra"
                if grandeza not in ("outra", "perda") and (medidor or len(palavras) >= 1):
                    posto, sub = classificar_posto(txt_n)
                    escolhido = quase = None
                    for a, u, k, c, nome in _ordenacoes(run):
                        r = Registro(medidor, grandeza, txt, posto, sub, "", a, u, k, c)
                        cands = _calc_candidatos(r)
                        if any(_bate(c, calc) for _, calc in cands) and not (c == 0 and a == u and medidor is None):
                            r.regra = nome
                            escolhido = r
                            break
                        if c == 0 and a == u and medidor and nome.startswith("ant atu K"):
                            r.regra = nome
                            escolhido = r
                            break
                        # com medidor na linha, aceita consumo até 11% acima do cálculo (perda de transformação
                        # embutida — Energisa MT, Enel Rio); validar() infere a perda se for a mesma em todas
                        if medidor and quase is None and nome.startswith("ant atu K") and c > 0:
                            if any(calc > 0 and 1.0 < c / calc <= 1.11 for _, calc in cands):
                                r.regra = nome
                                quase = r
                    escolhido = escolhido or quase
                    if escolhido:
                        chave = (escolhido.medidor, escolhido.grandeza, escolhido.posto, escolhido.leit_ant,
                                 escolhido.leit_atu, escolhido.constante, escolhido.consumo)
                        if chave not in vistos:  # a 2ª via (pág. 2) repete a tabela
                            vistos.add(chave)
                            regs.append(escolhido)
                        break  # uma só corrida por linha
            i = j
    if not regs:
        return None
    # Energisa MT imprime várias linhas "RSV Fora Ponta" sem dizer a grandeza (a 1ª é a energia ativa no
    # reservado — bate com o item "Consumo em kWh Reservado"; as seguintes são reativa/outras): só a 1ª conta
    vistos_rsv = False
    for r in regs:
        if re.match(r"^rsv\b", normalizar(r.grandeza_txt)):
            if vistos_rsv:
                r.grandeza = "outra"
            vistos_rsv = True
    extras = {"medidor": _medidor_rotulado(itens)}
    return regs, None, extras


# ─── molde Elektro: "AR0251225  COMERCIAL,… -TRIFASICO  40" (medidor, classe, constante) e, abaixo,
#     "CONSUMO  6766  6831" (leituras); o consumo é o item "CONSUMO TE/TUSD  2.600,00" ─────────────
def _ler_elektro(itens: list[Item]) -> tuple[list[Registro], float | None, dict] | None:
    linhas = [ln for ln in agrupar_linhas(itens) if ln[0].page == 0]
    for i, ln in enumerate(linhas):
        toks = pedacos(ln)
        if len(toks) != 3 or normalizar(toks[0][0]) != "consumo":
            continue
        a, u = parse_num(toks[1][0]), parse_num(toks[2][0])
        if a is None or u is None or not float(a).is_integer():
            continue
        medidor, k = None, None
        for l2 in linhas[max(0, i - 12): i]:
            t2 = pedacos(l2)
            if t2 and RE_MEDIDOR.match(t2[0][0]) and re.search(r"[A-Z]", t2[0][0]) and l2[0].x < 60:
                nums = [parse_num(t) for t, _ in t2[1:] if parse_num(t) is not None]
                if nums and float(nums[0]).is_integer() and 1 <= nums[0] <= 10000:
                    medidor, k = t2[0][0], nums[0]
        if k is None:
            continue
        consumo = None
        for l2 in linhas:
            t2 = pedacos(l2)
            for j, (t, _) in enumerate(t2):
                if normalizar(t) == "consumo" and j + 2 < len(t2) and normalizar(t2[j + 1][0]) in ("te", "tusd"):
                    consumo = parse_num(t2[j + 2][0])
                    break
            if consumo is not None:
                break
        reg = Registro(medidor, "energia_ativa", "Consumo", "unico", None, "", a, u, k, consumo)
        regs = [reg]
        for l2 in linhas[i + 1: i + 4]:
            t2 = pedacos(l2)
            if len(t2) == 3 and "reativ" in normalizar(t2[0][0]):
                ra, ru = parse_num(t2[1][0]), parse_num(t2[2][0])
                if ra is not None and ru is not None:
                    regs.append(Registro(medidor, "energia_reativa", t2[0][0], "unico", None, "", ra, ru, k, None))
        return regs, None, {"medidor": medidor}
    return None


def _medidor_rotulado(itens: list[Item]) -> str | None:
    """'MEDIDOR: 2375040', 'Medidor: N5210689329', 'N° MEDIDOR - 1134130551' (rótulo + valor, mesmo item ou o
    seguinte) ou cabeçalho de coluna 'Medidor' / 'Nº do Medidor' com o valor logo abaixo, na mesma coluna."""
    linhas = [ln for ln in agrupar_linhas(itens) if ln[0].page <= 1]
    coluna: list[Item] = []
    for ln in linhas:
        for k, it in enumerate(ln):
            if "medidor" not in it.norm:
                continue
            m = re.search(r"\bmedidor\b\s*[:\-]?\s*([a-z0-9][a-z0-9\-]{4,})?", it.norm)
            if not m:
                continue
            if re.fullmatch(r"(n[o.º°]?\s*(do\s+)?)?medidor", it.norm.strip()):
                coluna.append(it)  # cabeçalho de coluna: valor abaixo
                continue
            v = m.group(1).upper() if m.group(1) else None
            if not v and k + 1 < len(ln):
                v = ln[k + 1].text.strip().split()[0] if ln[k + 1].text.strip() else None
            if v and RE_MEDIDOR.match(v) and sum(c.isdigit() for c in v) >= 4 and not RE_MES.search(v):
                return v
    for cab in coluna:
        for ln in linhas:
            if ln[0].page != cab.page or ln[0].y <= cab.y or ln[0].y > cab.y + 70:
                continue
            for it in ln:
                v = it.text.strip().split()[0] if it.text.strip() else ""
                if abs(it.x - cab.x) <= 25 and RE_MEDIDOR.match(v) and sum(c.isdigit() for c in v) >= 5:
                    return v
    return None


# ─── leitura completa ─────────────────────────────────────────────────────────
MOLDES = [("enel", _ler_enel), ("cemig_a", _ler_cemig_a), ("cemig_b", _ler_cemig_b), ("elektro", _ler_elektro),
          ("generico", _ler_generico)]


def ler_medicao(pdf_bytes: bytes, itens: list[Item] | None = None) -> dict | None:
    if itens is None:
        itens, _, _ = itens_do_pdf(pdf_bytes, 3)
    for nome, fn in MOLDES:
        r = fn(itens)
        if r is None:
            continue
        regs, perda_linha = r[0], r[1]
        extras = r[2] if len(r) > 2 else {}
        if not regs:
            continue
        perda, origem = validar(regs, perda_linha)
        med = montar(nome, regs, perda, origem, extras.get("demanda_contratada") or demanda_contratada(itens))
        if extras.get("demanda_faturada"):
            med["demanda_faturada"] = extras["demanda_faturada"]
        if not med.get("medidor"):
            med["medidor"] = extras.get("medidor") or _medidor_rotulado(itens)
        return med
    # nenhuma tabela: ao menos o medidor rotulado
    m = _medidor_rotulado(itens)
    return {"molde": None, "medidor": m, "constante": None, "perda_pct": None, "perda_origem": None, "registros": [],
            "consumo_medido": {}, "consumo_faturado": {}, "demanda_medida": {}, "leituras": {},
            "demanda_contratada": demanda_contratada(itens), "validado": False, "n_registros": 0, "n_ok": 0,
            "obs": ["nenhum molde reconheceu a tabela de medição"]} if m else None


def _r3(v: float | None) -> float | None:
    return None if v is None else round(v, 3)


def montar(molde: str, regs: list[Registro], perda: float | None, origem: str | None, dem_contr: dict) -> dict:
    fator = 1 + perda / 100 if (perda and origem == "linha") else 1.0
    ativa = [r for r in regs if r.grandeza == "energia_ativa"]
    medidores = collections.Counter(r.medidor for r in ativa if r.medidor) or collections.Counter(r.medidor for r in regs if r.medidor)
    # constante das colunas = a do registro fora ponta/único de maior consumo (Enel Rio imprime K diferente por posto)
    constantes = collections.Counter(r.constante for r in ativa if r.constante is not None)
    pref = [r for r in ativa if r.posto in ("fp", "unico") and r.constante is not None]
    if pref:
        constantes = collections.Counter([max(pref, key=lambda z: (z.consumo or 0)).constante])
    medido: dict[str, float] = collections.defaultdict(float)
    for r in ativa:
        if r.consumo is not None:
            medido[r.posto] += r.consumo
    faturado = {p: _r3(v * fator) for p, v in medido.items()}
    dem: dict[str, float] = {}
    for r in regs:
        if r.grandeza == "demanda" and r.consumo is not None:
            dem[r.posto] = max(dem.get(r.posto, 0.0), r.consumo * fator)
    leituras: dict[str, dict] = {}
    for posto in ("p", "fp", "unico", "reservado", "intermediario"):
        cands = [r for r in ativa if r.posto == posto and r.leit_ant is not None]
        if cands:
            r = max(cands, key=lambda z: (z.consumo or 0))
            leituras[posto] = {"ant": r.leit_ant, "atu": r.leit_atu, "constante": r.constante,
                               "registros": len(cands)}
    n_ok = sum(1 for r in regs if r.ok)
    # validado = há registro de energia ativa, todos os conferíveis batem e pelo menos um bateu
    # (fatura sem consumo — custo de disponibilidade — tem leituras iguais e consumo 0: válida)
    conferiveis = [r for r in ativa if r.ok is not None]
    validado = bool(conferiveis) and all(r.ok for r in conferiveis)
    obs = []
    if not ativa:
        obs.append("sem registro de energia ativa")
    for r in regs:
        if r.ok is False:
            obs.append(f"{r.grandeza_txt or r.grandeza} {r.posto_txt}: consumo {r.consumo} ≠ {r.regra} = {r.calc}")
    if any(v.get("registros", 1) > 1 for v in leituras.values()):
        obs.append("mais de um registro por posto; leituras das colunas = registro de maior consumo")
    out = {
        "molde": molde,
        "medidor": medidores.most_common(1)[0][0] if medidores else None,
        "constante": constantes.most_common(1)[0][0] if constantes else None,
        "perda_pct": perda, "perda_origem": origem,
        "registros": [r.dict() for r in regs],
        "consumo_medido": {p: _r3(v) for p, v in medido.items()},
        "consumo_faturado": faturado,
        "demanda_medida": {p: _r3(v) for p, v in dem.items()},
        "leituras": leituras,
        "demanda_contratada": dem_contr,
        "validado": validado, "n_registros": len(regs), "n_ok": n_ok, "obs": obs,
    }
    return out


# ─── integração com o pdf_pipeline ────────────────────────────────────────────
def _itens_confirmam(itens_fatura: list, valor: float | None, unidade: str = "KWH") -> bool:
    if not valor:
        return False
    for it in itens_fatura or []:
        if not isinstance(it, dict):
            continue
        q = it.get("quantidade_numerica")
        u = (it.get("unidade") or "").upper().replace(" ", "")
        if isinstance(q, (int, float)) and u.startswith(unidade) and abs(float(q) - valor) <= max(0.02, 0.003 * valor):
            return True
    return False


def _demanda_item(itens_fatura: list) -> list[float]:
    """Quantidades (kW) dos itens de demanda faturada — exclui diferença/retroativa/ultrapassagem/reativa/lei estadual."""
    vals = []
    for it in itens_fatura or []:
        if not isinstance(it, dict):
            continue
        d = normalizar(it.get("descricao") or "")
        u = (it.get("unidade") or "").upper().replace(" ", "")
        q = it.get("quantidade_numerica")
        if "demanda" not in d or not u.startswith("KW") or u.startswith("KWH") or not isinstance(q, (int, float)) or q <= 0:
            continue
        if re.search(r"diferen|retroativ|ultrapass|reativ|lei estadual|geracao|complement|isent|exced|sem icms", d):
            continue
        vals.append(round(float(q), 3))
    return sorted(set(vals))


RE_PERDA_TXT = re.compile(r"perdas?\b[^0-9%\n]{0,45}?(\d{1,2}(?:[.,]\d{1,2})?)\s*%?(?![\d.,])")


def _perda_texto(itens: list[Item]) -> float | None:
    """Percentual de perdas de transformação escrito na fatura: 'PERDAS DE TRANSFORMAÇÃO / RAMAL: 2,50 %',
    'compensação de perdas de 2,5%', 'Perdas: 2.5', 'Taxa de perda  2,5'. Só valores entre 0,5 e 10."""
    for ln in agrupar_linhas(itens):
        if ln[0].page > 2:
            break
        texto = " ".join(it.text for it in ln)
        if "perda" not in texto.lower():
            continue
        for m in RE_PERDA_TXT.finditer(texto.lower()):
            v = float(m.group(1).replace(",", "."))
            if 0.5 <= v <= 10:
                return v
    return None


def aplicar_medicao(v2_out: dict, pdf_bytes: bytes) -> dict:
    """Lê a medição pelo molde e deixa em v2_out['_medicao'] (com 'aplicar' = colunas a gravar).
    Nunca levanta exceção."""
    try:
        itens_pdf, _, _ = itens_do_pdf(pdf_bytes, 3)
        med = ler_medicao(pdf_bytes, itens_pdf)
    except Exception as e:  # pragma: no cover
        v2_out["_medicao"] = {"erro": str(e)[:200]}
        return v2_out
    if not med:
        return v2_out
    itens = v2_out.get("itens_fatura") or []
    lt = v2_out.get("ligacao_tecnica") or {}
    modalidade = normalizar(str(lt.get("modalidade_tarifaria") or ""))
    subgrupo = str(lt.get("subgrupo") or lt.get("subgrupo_tarifario") or "").upper()
    fat = dict(med["consumo_faturado"])
    eh_b = subgrupo.startswith("B") or (not subgrupo and "p" in fat and not any(k in fat for k in ("fp", "unico")))
    if eh_b and "p" in fat and not any(k in fat for k in ("fp", "unico")):
        # grupo B só tem um registro; Energisa imprime o posto como "Ponta" — é o único/fora ponta das colunas
        fat["unico"] = fat.pop("p")
        if "p" in med["leituras"]:
            med["leituras"]["unico"] = med["leituras"].pop("p")
        med["obs"].append("grupo B: registro impresso como 'Ponta' tratado como único")
    cons_p = fat.get("p")
    cons_fp = _r3(sum(v for k, v in fat.items() if k in ("fp", "unico", "intermediario") and v is not None)) \
        if any(k in fat for k in ("fp", "unico", "intermediario")) else None
    cons_res = fat.get("reservado")
    dm = dict(med["demanda_medida"])
    confirma = {"p": _itens_confirmam(itens, cons_p), "fp": _itens_confirmam(itens, cons_fp)}
    if not confirma["fp"] and cons_fp and cons_res:  # EDP livre: fora ponta faturado junto com o reservado
        if _itens_confirmam(itens, _r3(cons_fp + cons_res)):
            cons_fp, cons_res, confirma["fp"] = _r3(cons_fp + cons_res), None, True
            med["obs"].append("reservado faturado dentro do fora ponta")
    # leituras iguais mas consumo impresso e confirmado item a item (Coelba livre): vale pelos itens
    if not med["validado"] and med["registros"] and all(confirma[p] for p, c in (("p", cons_p), ("fp", cons_fp)) if c):
        if any(c for c in (cons_p, cons_fp)):
            med["validado"], med["validado_por"] = True, "itens"
            med["obs"].append("física não fecha (leituras iguais); consumo confirmado pelos itens da fatura")
    # perda de transformação não impressa na tabela: (1) itens kWh com a mesma razão 1,005–1,10 sobre o medido
    # (CPFL: medição 3.918 arredondada, item 4.015,7901 = ×1,025); (2) percentual escrito no texto
    if med["validado"] and not any(confirma.values()) and med.get("perda_origem") is None:
        razoes = {}
        bases = [("p", cons_p), ("fp", cons_fp)]
        if cons_res and cons_fp:
            bases.append(("fp", _r3(cons_fp + cons_res)))
        for posto, base in bases:
            if not base or posto in razoes:
                continue
            for it in itens:
                if not isinstance(it, dict):
                    continue
                q, u = it.get("quantidade_numerica"), (it.get("unidade") or "").upper().replace(" ", "")
                if not isinstance(q, (int, float)) or q <= 0 or not u.startswith("KWH"):
                    continue
                d = normalizar(it.get("descricao") or "")
                if re.search(r"injet|compens|band|exced|reativ|dispon|encargo setorial|deduc", d):
                    continue
                p_it, _ = classificar_posto(d)
                if (p_it if p_it in ("p", "fp") else "fp") != posto:
                    continue
                z = float(q) / base
                if 1.005 <= z <= 1.10:
                    razoes[posto] = (z, round(float(q), 4), base)
                    break
        zs = [z for z, _, _ in razoes.values()]
        fator = None
        if zs and max(zs) - min(zs) < 0.004:
            fator = sum(zs) / len(zs)
            med["perda_pct"], med["perda_origem"] = round((fator - 1) * 100, 2), "itens"
            if "fp" in razoes and razoes["fp"][2] != cons_fp:  # base era fp + reservado
                cons_fp, cons_res = razoes["fp"][2], None
            confirma = {p: p in razoes for p in ("p", "fp")}
        else:
            pt = _perda_texto(itens_pdf)
            if pt:
                fator = 1 + pt / 100
                med["perda_pct"], med["perda_origem"] = pt, "texto"
        if fator:
            cons_p = _r3(cons_p * fator) if cons_p is not None else None
            cons_fp = _r3(cons_fp * fator) if cons_fp is not None else None
            cons_res = _r3(cons_res * fator) if cons_res is not None else None
            dm = {k: _r3(v * fator) for k, v in dm.items()}
            for posto, (_, q, _) in razoes.items():
                if posto == "p":
                    cons_p = q
                else:
                    cons_fp = q
    med["consumo_faturado"] = {**fat, **({"p": cons_p} if cons_p is not None else {}),
                               **({"fp": cons_fp} if cons_fp is not None else {}),
                               **({"reservado": cons_res} if cons_res is not None else {})}
    med["demanda_medida"] = dm
    med["itens_confirmam"] = confirma
    dem_itens = _demanda_item(itens)
    med["demanda_itens_kw"] = dem_itens
    aplicar: dict = {}
    if med.get("medidor"):
        aplicar["numero_medidor"] = med["medidor"]
        v2_out.setdefault("identificadores_instalacao", {})["medidor"] = med["medidor"]
    if med["validado"]:
        if med.get("constante") is not None:
            aplicar["constante_k"] = med["constante"]
        le = med["leituras"]
        lp = le.get("p")
        lfp = le.get("fp") or le.get("unico") or le.get("intermediario")
        if lp:
            aplicar["leit_ant_ativa_ponta"], aplicar["leit_atu_ativa_ponta"] = lp["ant"], lp["atu"]
        if lfp:
            aplicar["leit_ant_ativa_fponta"], aplicar["leit_atu_ativa_fponta"] = lfp["ant"], lfp["atu"]
            pl = v2_out.setdefault("periodo_leitura", {})
            if subgrupo.startswith("B") or not lp:
                pl["leit_ant_ativa"], pl["leit_atu_ativa"] = lfp["ant"], lfp["atu"]
        if cons_p is not None:
            aplicar["consumo_ativo_ponta_kwh"] = cons_p
        if cons_fp is not None:
            aplicar["consumo_ativo_fponta_kwh"] = cons_fp
        if cons_p is not None or cons_fp is not None:
            aplicar["kwh_total"] = _r3((cons_p or 0) + (cons_fp or 0) + (cons_res or 0))
        dc = med["demanda_contratada"]
        df = med.get("demanda_faturada") or {}
        azul = "azul" in modalidade
        if df:  # o molde leu a demanda faturada explícita (CEMIG A: coluna "Faturado")
            if df.get("fp") is not None:
                aplicar["demanda_faturada_fponta_kw"] = df["fp"]
            if df.get("p") is not None and azul:
                aplicar["demanda_faturada_ponta_kw"] = df["p"]
        elif azul and len(dem_itens) == 2:  # item de demanda ponta e fora ponta
            aplicar["demanda_faturada_ponta_kw"], aplicar["demanda_faturada_fponta_kw"] = dem_itens[0], dem_itens[1]
        elif len(dem_itens) == 1 and not azul:  # o item de demanda da fatura prevalece sobre a medida
            aplicar["demanda_faturada_fponta_kw"] = dem_itens[0]
        elif dem_itens and not azul and dm.get("fp"):
            # vários itens de demanda (CPFL: TUSD 13,53 e outro 16,47): o mais perto da medida, se ficar a ≤ 5 %;
            # senão a maior entre medida e contratada
            perto = min(dem_itens, key=lambda v: abs(v - dm["fp"]))
            aplicar["demanda_faturada_fponta_kw"] = perto if abs(perto - dm["fp"]) <= 0.05 * dm["fp"] \
                else _r3(max(dm["fp"], dc.get("fp") or 0))
        elif dm.get("fp") is not None:
            # sem item: cativo fatura a maior entre a medida e a contratada (REN 1000); no mercado livre a TUSD
            # de demanda vem como a medida impressa. Sem medida não se chuta a contratada.
            livre = bool(((v2_out.get("_identificacao") or {}).get("classificacao") or {}).get("mercado_livre"))
            aplicar["demanda_faturada_fponta_kw"] = dm["fp"] if livre else _r3(max(dm["fp"], dc.get("fp") or 0))
            if dm.get("p") is not None and azul:
                aplicar["demanda_faturada_ponta_kw"] = dm["p"] if livre else _r3(max(dm["p"], dc.get("p") or 0))
        if dc.get("fp") is not None:
            aplicar["demanda_contratada_fponta_kw"] = dc["fp"]
            lt.setdefault("demanda_contratada_fponta_kw", dc["fp"])
        if dc.get("p") is not None:
            aplicar["demanda_contratada_ponta_kw"] = dc["p"]
            lt.setdefault("demanda_contratada_ponta_kw", dc["p"])
    if med["registros"]:
        aplicar["medicao_grandezas_json"] = json.dumps(med["registros"], ensure_ascii=False)
    med["aplicar"] = aplicar
    v2_out["_medicao"] = med
    if lt and "ligacao_tecnica" not in v2_out:
        v2_out["ligacao_tecnica"] = lt
    return v2_out


# ─── uso avulso ───────────────────────────────────────────────────────────────
def _principal(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    como_json = "--json" in argv
    for a in argv:
        if a.startswith("--"):
            continue
        pdf = Path(a).read_bytes()
        med = ler_medicao(pdf)
        if como_json:
            print(json.dumps(med, ensure_ascii=False, indent=1, default=str))
            continue
        print(f"== {a}")
        if not med:
            print("  (nenhum molde reconheceu a tabela de medição)")
            continue
        print(f"  molde={med['molde']} medidor={med['medidor']} K={med['constante']} perda={med['perda_pct']} ({med['perda_origem']}) "
              f"validado={med['validado']} {med['n_ok']}/{med['n_registros']} ok")
        for r in med["registros"]:
            print(f"  {'ok ' if r['ok'] else ('-- ' if r['ok'] is None else 'XX ')}{r['grandeza']:16s} {r['posto']:6s} {str(r['sub'] or ''):5s} "
                  f"ant={r['leit_ant']} atu={r['leit_atu']} K={r['constante']} consumo={r['consumo']} calc={r['calc']} [{r['regra']}]")
        print(f"  consumo_faturado={med['consumo_faturado']} demanda_medida={med['demanda_medida']} "
              f"contratada={med['demanda_contratada']} leituras={med['leituras']}")
        for o in med["obs"]:
            print(f"  obs: {o}")
    return 0


if __name__ == "__main__":
    sys.exit(_principal(sys.argv[1:]))
