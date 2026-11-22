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


RE_NUM_PONTO2 = re.compile(r"^-?\d+\.\d{1,2}$")  # OCR (RapidOCR) escreve "45789.00", "1.00": ponto decimal, sem milhar


RE_UNID_COLADA = re.compile(r"^(-?[\d.,]+)\s*(kwh|kw|kvarh|kvar|un)$", re.I)  # OCR cola a unidade: "2.857kWh"
RE_SEP_MISTO = re.compile(r"^-?\d{1,3}(?:[.,]\d{3})+[.,]\d{1,2}$")  # OCR troca separadores: "500.880.00", "47.487.60"


def parse_num(tok: str) -> float | None:
    t = tok.strip()
    m = RE_UNID_COLADA.match(t)
    if m:
        t = m.group(1)
    if RE_NUM_PONTO.match(t) or RE_NUM_PONTO3.match(t) or RE_NUM_PONTO2.match(t):
        return float(t)
    if RE_NUM_BR.match(t):
        return float(t.replace(".", "").replace(",", "."))
    if RE_SEP_MISTO.match(t):  # o último separador é o decimal (1–2 casas); os outros são de milhar
        k = max(t.rfind("."), t.rfind(","))
        return float(re.sub(r"[.,]", "", t[:k]) + "." + t[k + 1:])
    return None


def eh_num(tok: str) -> bool:
    return parse_num(tok) is not None


# ─── linhas e pedaços ─────────────────────────────────────────────────────────
def agrupar_linhas(itens: list[Item], tol: float | None = None) -> list[list[Item]]:
    """Agrupa itens em linhas por proximidade de y (mesma página). Itens de OCR oscilam mais em y: tolerância maior."""
    if tol is None:
        import identificacao as _idn
        tol = 3.5 if _idn.fonte_atual() == "ocr" else 2.2
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
    r"(?<![a-z])(?P<posto>f ponta indu|f ponta cap|f ponta|fora de ponta|fora ponta|ponta indu|ponta cap|ponta|"
    r"unico|reservad\w*|intermediari\w*|hfp|hp|hr|na)\s*$")  # (?<![a-z]): "foraponta" não é "ponta"


_TOK_FP = {"fp", "fpta", "f-pta", "hfp", "fponta", "f.pta", "fora"}
_TOK_P = {"ponta", "pta", "np", "hp", "p"}
_TOK_RES = {"reservado", "hr", "res", "reserv", "rsv"}
_TOK_UNI = {"unico", "total", "tp", "geral"}


def descolar(s: str) -> str:
    """O liteparse às vezes cola palavras do posto ("F PONTAINDU", "PONTACAP") conforme a plataforma; separa."""
    s = re.sub(r"\bponta(indu|cap)\b", r"ponta \1", s)
    s = re.sub(r"\bforaponta\b", "fora ponta", s)  # OCR cola "ForaPonta"
    return re.sub(r"\bfponta\b", "f ponta", s)


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
    if re.search(r"\bkqh\b|\bqh\b", n):  # Copel "KQH kWh TP": grandeza Q (reativa auxiliar), não consumo ativo
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
    """Acha a faixa de cabeçalho da tabela de medição. Devolve x das colunas e y do fim do cabeçalho.
    Trabalha por PALAVRA (não por item): o OCR entrega "Postos Leitura Leitura Const. Consumo" num item só."""
    for i, ln in enumerate(linhas):
        med = [(w, x, it) for it in ln for w, x in pedacos([it]) if normalizar(w) == "medidor" and it.x <= x <= it.x + 2]
        if not med:
            continue
        w0, x_med, it_med = med[0]
        # cabeçalho = até 3 linhas (Medidor/Grandezas, Postos/Leitura/Leitura/Const./Consumo, Tarifários/...)
        # só palavras de cabeçalho (sem dígitos): a 1ª linha de dados fica a poucos pontos do cabeçalho
        palavras: list[tuple[str, float, float]] = []  # (norm, x, y)
        for l2 in linhas[max(0, i - 2): i + 3]:
            if l2[0].page != ln[0].page:
                continue
            for it in l2:
                if abs(it.y - it_med.y) <= 14 and not re.search(r"\d", it.text):
                    for w, x in pedacos([it]):
                        palavras.append((normalizar(w), x, it.y))
        normas = {w for w, _, _ in palavras}
        if not any(n.startswith("grandeza") for n in normas) or not any("leitura" in n for n in normas):
            continue
        x_gr = min((x for w, x, _ in palavras if w.startswith("grandeza")), default=x_med + 40)
        x_cons = max((x for w, x, _ in palavras if w.startswith("consumo")), default=None)
        if x_cons is None:
            continue
        direita = [x for w, x, _ in palavras if x > x_cons + 10 and (w.startswith("itens") or w.startswith("unid") or w.startswith("descri"))]
        x_fim = (min(direita) - 2) if direita else x_cons + 75
        # o cabeçalho termina na linha "Anterior / Atual" (a 1ª linha de dados vem logo abaixo, e suas
        # palavras — ENRG ATV, PONTA — não têm dígitos; por isso não se usa o max y da faixa inteira)
        fim = [y for w, _, y in palavras if w in ("anterior", "atual")]
        y_fim = (max(fim) if fim else it_med.y + 4) + 2
        return {"page": it_med.page, "y_fim": y_fim, "x_med": x_med, "x_gr": x_gr, "x_cons": x_cons, "x_fim": x_fim}
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


# 21/11/2026: rótulos do quadro "Grandezas Contratadas" que o leitor por item não pega (o rótulo e o valor saem no
# fim de uma linha da tabela de itens). Só o posto fora ponta/único; o valor tem de ser o único lido.
RE_CONTR_TXT = [
    re.compile(r"montante de uso contratado\s*:?\s*(?P<val>\d[\d.,]*)"),                      # Coelba
    re.compile(r"(?<!ultrapassagem )(?<!excedente )demanda\s*contratada\s*:?\s*(?P<val>\d[\d.,]*)\s*$"),  # Neoenergia DF
    re.compile(r"demanda livre\s*-\s*kw\s*(?P<val>\d[\d.,]*)\s*$"),                           # Equatorial GO
    re.compile(r"montante em todos os periodos\s*:?\s*(?P<val>\d[\d.,]*)\s*kw"),              # Copel
    re.compile(r"\bcomponente fio\s+(?P<val>\d[\d.,]*)\s*$"),                                 # Light
    re.compile(r"montante fora (?:de )?ponta\s*:?\s*(?P<val>\d[\d.,]*)\s*kw"),               # Copel azul
]
RE_CONTR_TXT_P = [re.compile(r"montante na ponta\s*:?\s*(?P<val>\d[\d.,]*)\s*kw")]       # Copel azul


def contratada_texto(itens: list[Item], posto: str = "fp") -> float | None:
    vals = set()
    rxs = RE_CONTR_TXT_P if posto == "p" else RE_CONTR_TXT
    for ln in agrupar_linhas(itens):
        if ln[0].page > 1:
            continue
        n = normalizar(" ".join(t for t, _ in pedacos(ln)))
        n = re.sub(r"demandacontratada", "demanda contratada", n)
        for rx in rxs:
            for m in rx.finditer(n):
                v = parse_num(m.group("val").rstrip(".,"))
                if v and v > 0:
                    vals.add(round(float(v), 3))
    return vals.pop() if len(vals) == 1 else None


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
        for i in range(0, n - 4):  # coluna a mais entre K e consumo (Amazonas "61880 61483 1,00000 5 397": NPL)
            a, u, k, _x, c = nums[i:i + 5]
            out.append((a, u, k, c, "ant atu K x cons"))
            out.append((u, a, k, c, "atu ant K x cons"))
    for i in range(0, max(n - 2, 0) + 1):
        if i + 3 <= n:
            a, u, c = nums[i:i + 3]
            out.append((a, u, None, c, "ant atu cons"))
    return out


def _idn_fonte() -> str:
    try:
        import identificacao as _i
        return _i.fonte_atual()
    except Exception:  # noqa: BLE001
        return ""


def _descolar_k_consumo(toks: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """OCR cola a constante no consumo: "85875.00 97045.00 1.0011170.00" (Enel CE 609870). Um token com dois
    separadores decimais logo depois de duas leituras vira K + consumo no ponto em que (atual − anterior) × K fecha."""
    out = list(toks)
    for i, (t, x) in enumerate(toks):
        if i < 2 or parse_num(t) is not None or not re.fullmatch(r"\d+[.,]\d+[.,]\d+", t):
            continue
        a, u = parse_num(toks[i - 2][0]), parse_num(toks[i - 1][0])
        if a is None or u is None or u <= a:
            continue
        sep = re.search(r"[.,]", t).start()
        for j in range(sep + 2, len(t) - 3):
            k, c = parse_num(t[:j]), parse_num(t[j:])
            if k and c and 0 < k < 1000 and _bate(c, (u - a) * k):
                return out[:i] + [(t[:j], x), (t[j:], x + 1)] + out[i + 1:]
    return out


def _ler_generico(itens: list[Item]) -> tuple[list[Registro], float | None, dict] | None:
    regs: list[Registro] = []
    vistos: set = set()
    for ln in agrupar_linhas(itens):
        if ln[0].page > 1:
            break
        toks = _descolar_k_consumo(pedacos(ln))
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
                        # consumo 0 com leituras diferentes não existe: era a constante colada na leitura
                        # (Copel A4 "2155 2155.024 … 0", 21/11/2026 — gravava consumo 0 por cima do 4.898 impresso)
                        if c == 0 and a != u:
                            continue
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
                    # OCR: linha de energia ativa com medidor que não fecha (dígito lido errado no consumo, 550695
                    # "3014" por 3614) entra PENDENTE — _ocr_confirma_por_itens só a aceita se leituras × K × perda
                    # baterem com o item kWh impresso
                    if not escolhido and medidor and grandeza == "energia_ativa" and _idn_fonte() == "ocr":
                        for a, u, k, c, nome in _ordenacoes(run):
                            if nome == "ant atu K cons" and a < u and k is not None and 0 < k < 1000:
                                escolhido = Registro(medidor, grandeza, txt, posto, sub, "", a, u, k, c)
                                escolhido.regra = "ocr_pendente"
                                break
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


def _medidor_repetido(itens: list[Item]) -> str | None:
    """Sem rótulo legível (OCR gruda 'NºMedidor' a outros cabeçalhos): o número que ABRE 3+ linhas da tabela de
    medição (linhas com 2+ números depois dele) é o medidor — a tabela repete o medidor em cada grandeza/posto.
    CPFL Paulista escaneada (553359): '40177826' em 6 linhas; o extrator pegava o nº da nota fiscal."""
    import collections
    cont: collections.Counter = collections.Counter()
    for ln in agrupar_linhas(itens):
        if ln[0].page > 2:
            continue
        toks = " ".join(i.text for i in sorted(ln, key=lambda i: i.x)).split()
        if len(toks) < 3:
            continue
        v = toks[0].strip(".:;")
        if not (RE_MEDIDOR.match(v) and 6 <= sum(c.isdigit() for c in v) <= 13) or RE_MES.search(v):
            continue
        if re.fullmatch(r"\d{1,3}([.,]\d{3})*([.,]\d+)?", v) and ("." in v or "," in v):
            continue  # valor monetário/quantidade, não identificador
        if sum(1 for t in toks[1:] if re.search(r"\d", t)) >= 2:
            cont[v] += 1
    if not cont:
        return None
    v, n = cont.most_common(1)[0]
    return v if n >= 3 and (len(cont) == 1 or cont.most_common(2)[1][1] < n) else None


# ─── leitura completa ─────────────────────────────────────────────────────────
# ─── molde Copel A (21/11/2026): "0044629187 CONSUMO kWh FP 4029997 4229109.024 4898" — medidor, grandeza, unidade,
#     posto (PT/FP/TP), leitura anterior, leitura atual, constante, consumo. A camada de texto cola a leitura atual
#     com a constante (".024" = 0,024); a constante certa vem do quadro "Constante 0.09600 0.02400" (kW, kWh). TP
#     (total) não entra. O consumo da coluna já vem com a perda de transformação (2,5 %, inferida pela validação).
RE_COPEL = re.compile(r"^(?P<med>\d{8,12}) (?P<g>consumo|en\.? ?exce|demanda|kqh|[a-z.]+) (?P<u>kwh|kw|kvarh|kvar) "
                      r"(?P<posto>pt|fp|tp) (?P<nums>[\d., ]+)$")
RE_COPEL_K = re.compile(r"constante (?P<kw>\d+[.,]\d+) (?P<kwh>\d+[.,]\d+)")


def _num_copel(t: str) -> float | None:
    if re.fullmatch(r"\d+(\.\d{1,2})?", t):  # Copel imprime "14.76" (ponto decimal) e "25801" (sem milhar)
        return float(t)
    return parse_num(t)


def _ler_copel(itens: list[Item]) -> tuple[list[Registro], float | None] | None:
    linhas = [(ln, normalizar(" ".join(t for t, _ in pedacos(ln)))) for ln in agrupar_linhas(itens) if ln[0].page <= 2]
    k_kw = k_kwh = None
    for _, n in linhas:
        m = RE_COPEL_K.search(n)
        if m:
            k_kw, k_kwh = float(m.group("kw").replace(",", ".")), float(m.group("kwh").replace(",", "."))
            break
    regs: list[Registro] = []
    for _, n in linhas:
        m = RE_COPEL.match(n)
        if not m or m.group("posto") == "tp":
            continue
        toks = m.group("nums").split()
        k = None
        if len(toks) == 3 and re.fullmatch(r"\d+\.\d+", toks[1]):  # leitura atual colada na constante
            atu_s, k_s = toks[1].split(".")
            toks = [toks[0], atu_s, "0." + k_s, toks[2]]
        if len(toks) != 4:
            continue
        ant, atu, cons = parse_num(toks[0]), parse_num(toks[1]), _num_copel(toks[3])
        k = float(toks[2]) if re.fullmatch(r"\d*\.\d+", toks[2]) else parse_num(toks[2])
        g = m.group("g")
        if g == "demanda":
            grandeza, k = "demanda", (k_kw or k)
        elif g == "consumo" and m.group("u") == "kwh":
            grandeza, k = "energia_ativa", (k_kwh or k)
        else:
            grandeza, k = "energia_reativa", (k_kwh or k)
        posto = "p" if m.group("posto") == "pt" else "fp"
        regs.append(Registro(m.group("med"), grandeza, f"{g} {m.group('u')} {m.group('posto')}", posto, None,
                             m.group("posto"), ant, atu, k, cons))
    return (regs, None) if sum(r.grandeza == "energia_ativa" for r in regs) >= 1 else None


MOLDES = [("copel", _ler_copel), ("enel", _ler_enel), ("cemig_a", _ler_cemig_a), ("cemig_b", _ler_cemig_b), ("elektro", _ler_elektro),
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
            med["medidor"] = extras.get("medidor") or _medidor_rotulado(itens) or _medidor_repetido(itens)
        return med
    # nenhuma tabela: ao menos o medidor rotulado
    m = _medidor_rotulado(itens) or _medidor_repetido(itens)
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


def _demanda_item(itens_fatura: list, partes: bool = False) -> list[float]:
    """Quantidades (kW) dos itens de demanda faturada — exclui diferença/retroativa/ultrapassagem/reativa/lei estadual.
    partes=True: lista SEM deduplicar e COM as parcelas isenta/sem ICMS — a mesma demanda partida por tributo
    (Enel CE "Demanda Distribuição sem ICMS" 34,65 + "Demanda Distribuição" 65,35; CPFL dois "Demanda [kW] - TUSD")."""
    vals = []
    for it in itens_fatura or []:
        if not isinstance(it, dict):
            continue
        d = normalizar(it.get("descricao") or "")
        u = (it.get("unidade") or "").upper().replace(" ", "")
        q = it.get("quantidade_numerica")
        if "demanda" not in d or not u.startswith("KW") or u.startswith("KWH") or not isinstance(q, (int, float)) or q <= 0:
            continue
        if re.search(r"diferen|retroativ|ultrapass|reativ|lei estadual|geracao|complement|exced"
                     + ("" if partes else r"|isent|sem icms"), d):
            continue
        vals.append(round(float(q), 3))
    return vals if partes else sorted(set(vals))


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


def _demanda_linhas(itens_pdf: list, posto: str = "fp") -> tuple[list[float], bool]:
    """Parcelas de demanda cobrada lidas direto do TEXTO impresso do quadro de itens ("Demanda Distribuição (kW)
    147,98", "Demanda Distrib. Isenta ICMS (kW) 2,02", "DEMANDA DE DISTRIBUICAO TUSD ISENTA kW ICMS 198,48"): a
    quantidade é o número logo depois da unidade kW. Lê por TRECHO "demanda … kW número" — a linha agrupada junta o
    quadro de medição ao lado (Enel CE). Para quando o extrator de itens não trouxe a demanda (Equatorial, Enel CE,
    Copel). Devolve (parcelas, partição_icms): partição = uma parcela isenta/sem ICMS e outra tributada.
    posto="fp": trechos sem posto ou de fora ponta; "p": só os de ponta (Copel A4 azul: "DEMANDA DISTR USD PONTA kW
    231,84" + "... PONTA ISENTA ICMS kW 88,16"). 21/11/2026: rótulo "DEMANDA LIVRE - kW 90" (quadro da contratada,
    Equatorial GO) não é parcela — o hífen antes do kW marca rótulo; "ICMSkW" colado (Copel) é separado."""
    vistos, vals, isenta = set(), [], False
    rx = re.compile(r"demanda(?:(?!demanda).){0,60}?\bkw\)?(?:\s+icms)?\s+(\d{1,3}(?:\.\d{3})*,\d+|\d+(?:[.,]\d+)?)\b")
    for ln in agrupar_linhas(itens_pdf or []):
        n = re.sub(r"icmskw\b", "icms kw", normalizar(" ".join(t for t, _ in pedacos(ln))))
        for m in rx.finditer(n):
            seg = m.group(0)
            if seg in vistos or re.search(r"reativ|ultrapass|exced|diferen|retroativ|geracao|complement|dmcr|contratad"
                                          r"|medid|registrad|maxim|histor|faturad|-\s*kw|ponta:", seg):
                continue
            fora = bool(re.search(r"fora\s*(?:de\s*)?ponta|\bf\W{0,2}ponta|\bfp\b", seg))
            if (posto == "p") != (bool(re.search(r"ponta", seg)) and not fora):
                continue
            v = parse_num(m.group(1))
            if v is not None and v > 0:
                vistos.add(seg)
                vals.append(round(float(v), 3))
                isenta = isenta or bool(re.search(r"isent|sem icms", seg))
    return vals, (isenta and len(vals) == 2)


def _consumo_impresso(itens_pdf: list[Item], posto: str, alvo: float) -> float | None:
    """Número impresso numa linha de consumo do posto (não injetada/compensada/reativa/bandeira) que bate com `alvo`
    (até 1 kWh ou 0,2 % — a fatura trunca/arredonda). Um só candidato; dois diferentes = dúvida, nada."""
    achados = set()
    for ln in agrupar_linhas(itens_pdf):
        toks = pedacos(ln)
        n = re.sub(r"\bf\W{0,2}ponta\b", "fora ponta", normalizar(" ".join(t for t, _ in toks)))  # Amazonas "F/Ponta"
        # "Consumo Ponta" ou "TUSD Energia Ponta (kWh)" (Equatorial PA)
        if not ("consumo" in n or ("energia" in n and "kwh" in n)) \
                or re.search(r"injet|compens|reativ|exced|band|histor|media|medio|escassez|demanda", n):
            continue
        if classificar_posto(n)[0] != posto:
            continue
        for tok, _ in toks:
            v = parse_num(tok.strip())
            if v is not None and v > 0 and abs(v - alvo) <= max(1.0, 0.002 * alvo):
                achados.add(round(v, 4))
    return achados.pop() if len(achados) == 1 else None


def _ocr_confirma_por_itens(med: dict, itens_pdf: list) -> bool:
    """21/11/2026, só OCR: o OCR troca dígito no consumo da tabela (550695: "3014" por 3614) mas as leituras e a
    constante saem iguais. Confere cada posto de energia ativa por (atual − anterior) × K × f = quantidade impressa num
    item kWh, com o MESMO f (perda de transformação, 1,000–1,060) em todos os postos; com um posto só, f = 1 e o
    número em duas linhas kWh (TE e TUSD). Confirmado: consumo = a quantidade impressa (o faturado)."""
    regs = [r for r in med.get("registros") or [] if r.get("grandeza") == "energia_ativa"
            and r.get("leit_ant") is not None and r.get("leit_atu") is not None]
    por_posto: dict = {}
    for r in regs:
        p = "p" if r.get("posto") == "p" else "fp"
        k = r.get("constante") or 1.0
        calc = (r["leit_atu"] - r["leit_ant"]) * k
        if calc <= 0 or p in por_posto:
            return False
        por_posto[p] = (r, calc)
    if not por_posto:
        return False
    qs: dict = {}
    for ln in agrupar_linhas(itens_pdf):
        if ln[0].page > 1:
            continue
        n = normalizar(" ".join(t for t, _ in pedacos(ln)))
        if not re.search(r"kw\s*h|kwn|kvh", n) or re.search(r"injet|compens|reativ|kvar", n):
            continue
        for t, _ in pedacos(ln):
            v = parse_num(t.strip())
            if v is not None and v > 0:
                qs[round(v, 4)] = qs.get(round(v, 4), 0) + 1
    cand = {p: [(q / calc, q) for q in qs if 0.9995 <= q / calc <= 1.06] for p, (_, calc) in por_posto.items()}
    if len(por_posto) == 1:
        p = next(iter(cand))
        ok = [(z, q) for z, q in cand[p] if abs(z - 1) <= 0.001 and qs[q] >= 2]
        if len({q for _, q in ok}) != 1:
            return False
        escolha = {p: ok[0]}
    else:
        pares = [(zp, qp, zf, qf) for zp, qp in cand.get("p", []) for zf, qf in cand.get("fp", [])
                 if abs(zp - zf) <= 0.0015]
        if len({(qp, qf) for _, qp, _, qf in pares}) != 1:
            return False
        zp, qp, zf, qf = pares[0]
        escolha = {"p": (zp, qp), "fp": (zf, qf)}
    fat = dict(med.get("consumo_faturado") or {})
    medido = dict(med.get("consumo_medido") or {})
    leit = dict(med.get("leituras") or {})
    for p, (z, q) in escolha.items():
        r, calc = por_posto[p]
        r["ok"], r["calc"], r["regra"] = True, round(q, 4), f"(atual−anterior)×K × {z:.4f} = item kWh (OCR)"
        chave = p if (p == "p" or "unico" not in fat) else "unico"
        fat[chave] = round(q, 4)
        medido[chave] = round(calc, 3)
        leit[chave] = {"ant": r["leit_ant"], "atu": r["leit_atu"], "constante": r.get("constante"), "registros": 1}
    med["consumo_faturado"], med["consumo_medido"], med["leituras"] = fat, medido, leit
    z = max(z for z, _ in escolha.values())
    if z > 1.0005:
        med["perda_pct"], med["perda_origem"] = round((z - 1) * 100, 2), "itens"
    med["validado"], med["validado_por"], med["confirmado_ocr_itens"] = True, "itens_ocr", True
    med["n_ok"] = sum(1 for r in med["registros"] if r.get("ok"))
    med.setdefault("obs", []).append("OCR: postos confirmados por leituras × K × perda = item kWh impresso")
    return True


def aplicar_medicao(v2_out: dict, pdf_bytes: bytes) -> dict:
    """Lê a medição pelo molde e deixa em v2_out['_medicao'] (com 'aplicar' = colunas a gravar).
    Nunca levanta exceção."""
    try:
        itens_pdf, _, _ = itens_do_pdf(pdf_bytes, 3)
        import identificacao as _idn
        # fonte das linhas (camada de texto ou OCR): atualizar_colunas_db só deixa o extrator antigo gravar
        # consumo/tributo/demanda quando é texto
        v2_out["_fonte_itens"] = "ocr" if _idn.fonte_atual() == "ocr" else "texto"
        med = ler_medicao(pdf_bytes, itens_pdf)
    except Exception as e:  # pragma: no cover
        v2_out["_medicao"] = {"erro": str(e)[:200]}
        return v2_out
    if med and v2_out.get("_fonte_itens") == "ocr" and med.get("registros"):
        _pend = any(r.get("regra") == "ocr_pendente" or r.get("ok") is False for r in med["registros"]
                    if r.get("grandeza") == "energia_ativa")
        if _pend or not med.get("validado"):
            _ocr_confirma_por_itens(med, itens_pdf)
    if not med:
        # sem molde de medição (Copel refaturamento 596803): a contratada impressa no quadro ainda vale
        _ct = contratada_texto(itens_pdf) if v2_out.get("_fonte_itens") != "ocr" else None
        if _ct is not None:
            v2_out["_medicao"] = {"aplicar": {"demanda_contratada_fponta_kw": _ct}, "demanda_contratada": {"fp": _ct},
                                  "validado": False, "obs": ["sem molde de medição: só a contratada do quadro"]}
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
            if pt:  # só informação: o consumo gravado é o impresso (medido); a regra decide se a perda devia incidir
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
    # 20/11/2026 (usuário): a coluna de consumo grava o FATURADO. Perda impressa (texto "Perdas: 2.5" ou linha da
    # tabela) e itens que o leitor não quantificou (Equatorial PI, Amazonas): procura na linha "Consumo <posto>" o
    # número IMPRESSO igual a medido × (1 + perda) — é o faturado, conferido pela física + perda. Sem achar, fica o
    # que já estava (medido, ou medido × perda da linha).
    # Posto que já é EXATAMENTE a quantidade de um item impresso não muda; "confirmado" pela folga dos itens
    # (607,974 calculado ≈ 605,431 impresso) não basta — vale o impresso.
    _qtd_itens = {round(float(i["quantidade_numerica"]), 3) for i in itens if isinstance(i, dict)
                  and isinstance(i.get("quantidade_numerica"), (int, float))}
    def _exato(v) -> bool:
        return v is not None and round(float(v), 3) in _qtd_itens
    if med["validado"] and med.get("perda_pct") and med.get("perda_origem") in ("texto", "linha"):
        fator_p = 1 + float(med["perda_pct"]) / 100
        medido = med.get("consumo_medido") or {}
        for posto in ("p", "fp"):
            base = medido.get(posto) if posto == "p" else (medido.get("fp") or medido.get("unico"))
            if not base or _exato(cons_p if posto == "p" else cons_fp):
                continue
            q = _consumo_impresso(itens_pdf, posto, base * fator_p)
            if q is not None:
                if posto == "p":
                    cons_p = q
                else:
                    cons_fp = q
                confirma[posto] = True
                med["obs"].append(f"{posto}: faturado impresso {q} = medido {base} × {fator_p:.4f}")
    # o item impresso pode usar um fator um pouco diferente do % da linha (Enel SP 594936: perda 2,5 % impressa,
    # itens 60,254 / 605,431 = medido × 1,0207 nos dois postos), ou a perda nem estar legível e a física não fechar
    # (590986: "Uso Sistema Encar.NP/FP" 289,05 / 7.125,53 = medido × 1,025). Vale o IMPRESSO no item quando CADA
    # posto medido tem um só item kWh com fator 1,005–1,10 sobre o medido e o fator é o mesmo em todos. Só texto exato.
    medido = med.get("consumo_medido") or {}
    if v2_out.get("_fonte_itens") != "ocr" and medido:
        cand: dict = {}
        precisa = 0
        for posto in ("p", "fp"):
            base = medido.get(posto) if posto == "p" else (medido.get("fp") or medido.get("unico"))
            if not base or base <= 0 or _exato(cons_p if posto == "p" else cons_fp):
                continue
            precisa += 1
            qs, qs_consumo = set(), set()
            for it in itens:
                if not isinstance(it, dict):
                    continue
                q, u = it.get("quantidade_numerica"), (it.get("unidade") or "").upper().replace(" ", "")
                d = normalizar(it.get("descricao") or "")
                if not isinstance(q, (int, float)) or q <= 0 or not u.startswith("KWH"):
                    continue
                if re.search(r"injet|compens|band|exced|reativ|dispon|deduc|escassez|ajuste|retroat|diferen", d):
                    continue
                p_it, _ = classificar_posto(re.sub(r"[.]", " ", d))
                if (p_it if p_it in ("p", "fp") else "fp") == posto and 1.005 <= float(q) / base <= 1.10:
                    qs.add(round(float(q), 4))
                    if "consumo" in d:
                        qs_consumo.add(round(float(q), 4))
            if qs_consumo:  # item "Consumo <posto>" manda; os outros kWh (TE, ACL) só quando não há nenhum
                qs = qs_consumo
            if len(qs) == 1:
                cand[posto] = (qs.pop(), base)
        zs = [q / b for q, b in cand.values()]
        if cand and len(cand) == precisa and max(zs) - min(zs) < 0.004:
            for posto, (q, base) in cand.items():
                if posto == "p":
                    cons_p = q
                else:
                    cons_fp = q
                confirma[posto] = True
                med["obs"].append(f"{posto}: faturado impresso no item {q} (medido {base} × {q / base:.4f})")
    med["consumo_faturado"] = {**fat, **({"p": cons_p} if cons_p is not None else {}),
                               **({"fp": cons_fp} if cons_fp is not None else {}),
                               **({"reservado": cons_res} if cons_res is not None else {})}
    med["demanda_medida"] = dm
    med["itens_confirmam"] = confirma
    dem_itens = _demanda_item(itens)
    med["demanda_itens_kw"] = dem_itens
    # Trava do modo OCR (PDF-imagem lido pelo RapidOCR/Tesseract): a física não pega posto trocado nem dígito
    # lido errado que ainda feche a conta; só se grava a medição quando cada posto com consumo bate com um item
    # kWh da fatura. Sem confirmação fica vazio (fila humana / leitura visual à mão), nunca um valor inventado.
    med["fonte"] = v2_out.get("_fonte_itens") or "texto"
    if med["fonte"] == "ocr" and med["validado"] and not med.get("confirmado_ocr_itens"):
        postos = [p for p, c in (("p", cons_p), ("fp", cons_fp)) if c is not None]  # fp lido como 0 conta (troca)
        # com um posto só não há troca possível e a física (3 números que fecham) basta; com ponta E fora ponta,
        # cada um tem de bater com um item kWh
        if len(postos) > 1 and not all(confirma.get(p) for p in postos):
            med["validado"], med["validado_por"] = False, None
            med["obs"].append("OCR: consumo por posto não confirmado pelos itens da fatura; medição não gravada")
    aplicar: dict = {}
    if med.get("medidor"):
        aplicar["numero_medidor"] = med["medidor"]
        v2_out.setdefault("identificadores_instalacao", {})["medidor"] = med["medidor"]
    # Grava o que está impresso. Com texto exato, leituras e consumo da tabela entram mesmo quando a física não fecha —
    # é a regra F01 (motor) quem aponta "consumo ≠ (atual − anterior) × K", não o extrator que esconde. O molde
    # genérico só devolve linhas que fecham, então aqui são os moldes estruturais (enel, cemig, elektro). No OCR a
    # dúvida é de leitura: continua exigindo a conferência.
    impresso = (med["fonte"] != "ocr" and not med["validado"] and med.get("molde") not in (None, "generico")
                and any(r.get("grandeza") == "energia_ativa" and r.get("leit_ant") is not None for r in med["registros"]))
    if impresso:
        med["obs"].append("texto exato: medição gravada como impressa, física não fecha (regra F01)")
    med["gravado_sem_conferencia"] = impresso
    if med["validado"] or impresso:
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
        if cons_fp is not None:  # só ponta lida (fora ponta ilegível) não é total
            aplicar["kwh_total"] = _r3((cons_p or 0) + cons_fp + (cons_res or 0))
        dc = med["demanda_contratada"]
        df = med.get("demanda_faturada") or {}
        if not df:  # a tabela de medição imprime a linha "Demanda Faturada-kW" (Enel ML, Energisa): é impresso, vale
            for r in med["registros"]:
                if r.get("grandeza") == "demanda" and "faturad" in normalizar(r.get("grandeza_txt") or "") and r.get("consumo") is not None:
                    df[r.get("posto") or "fp"] = max(df.get(r.get("posto") or "fp", 0.0), float(r["consumo"]))
        # perda de transformação IMPRESSA (linha da tabela ou texto "Perdas 2,5 %"): vai para a coluna; a inferida
        # pelos itens é cálculo e fica só na observação
        if med.get("perda_pct") is not None and med.get("perda_origem") in ("linha", "texto"):
            aplicar["perda_transformacao_percentual"] = med["perda_pct"]
        azul = "azul" in modalidade
        # 20/11/2026: demanda cobrada em parcelas (isenta/sem ICMS + tributada, ou duas linhas TUSD): a soma das
        # parcelas é a demanda faturada quando fecha com a contratada ou a medida — prova de que é partição do mesmo
        # kW, não ponta/fora ponta. Vale por cima da "Demanda Faturada" da tabela de medição (Enel CE imprime ali a
        # medida 65,35 e cobra 34,65 + 65,35 = 100 = contratada).
        _refs = [v for v in (dc.get("fp"), dm.get("fp"), df.get("fp")) if v]
        _soma = None
        _lin, _part_icms = _demanda_linhas(itens_pdf) if not azul and med["fonte"] != "ocr" else ([], False)
        for _partes, _prova in ((_demanda_item(itens, partes=True), False), (_lin, _part_icms)):
            _s = _r3(sum(_partes)) if len(_partes) >= 2 else None
            # prova: fecha com contratada/medida, ou é a partição explícita do ICMS (uma parcela isenta + uma tributada)
            if _s and (_prova or any(abs(_s - r) <= max(0.05, 0.005 * r) for r in _refs)):
                _soma = _s
                break
        _azul_parc = {}
        if med["fonte"] != "ocr":
            # azul (Copel A4): parcelas por posto — só vale a partição explícita do ICMS (isenta + tributada). Item
            # de demanda de PONTA só existe na azul: a ponta não espera a modalidade (ainda não lida aqui)
            for _posto, _col in (("fp", "demanda_faturada_fponta_kw"), ("p", "demanda_faturada_ponta_kw")):
                if _posto == "fp" and not azul:
                    continue
                _pp, _pi = _demanda_linhas(itens_pdf, _posto)
                if len(_pp) == 2 and _pi:
                    _azul_parc[_col] = _r3(sum(_pp))
        if _soma:
            aplicar["demanda_faturada_fponta_kw"] = _soma
        elif df:  # o molde leu a demanda faturada explícita (CEMIG A: coluna "Faturado")
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
            # senão a maior entre medida e contratada (no modo OCR a contratada não é confiável: fica vazio)
            perto = min(dem_itens, key=lambda v: abs(v - dm["fp"]))
            if abs(perto - dm["fp"]) <= 0.05 * dm["fp"]:
                aplicar["demanda_faturada_fponta_kw"] = perto
        aplicar.update(_azul_parc)  # a partição impressa vale por cima da tabela de medição e dos itens
        # sem item de demanda impresso, fica vazio: calcular "a maior entre medida e contratada" seria o extrator
        # dizendo o que a concessionária devia cobrar — e escondendo quando ela cobrou diferente (17/11/2026)
    elif med["fonte"] != "ocr":
        # 21/11/2026: medição não fechou (Copel A4: o molde não lê o quadro), mas a demanda COBRADA não depende dela —
        # vale a partição explícita do ICMS impressa nos itens (tributada + isenta), por posto: item de demanda com
        # "PONTA" (sem "fora") só existe na azul — a modalidade ainda não está lida aqui (568081 Azul)
        for _posto, _col in (("fp", "demanda_faturada_fponta_kw"), ("p", "demanda_faturada_ponta_kw")):
            _pp, _pi = _demanda_linhas(itens_pdf, _posto)
            if len(_pp) == 2 and _pi:
                aplicar[_col] = _r3(sum(_pp))
    # contratada: não depende da medição fechar (21/11/2026: só gravava com a medição validada). O rótulo do quadro
    # "Grandezas Contratadas" lido no texto vale por cima do leitor por item. OCR: sem conferência → fica vazia.
    if med["fonte"] != "ocr":
        dc = dict(med.get("demanda_contratada") or {})
        _ct = contratada_texto(itens_pdf)
        if _ct is not None:
            if dc.get("fp") not in (None, _ct):
                med["obs"].append(f"contratada: quadro impresso {_ct} no lugar de {dc.get('fp')}")
            dc["fp"] = _ct
            med["demanda_contratada"] = dc
        _ctp = contratada_texto(itens_pdf, "p")
        if _ctp is not None:
            dc["p"] = _ctp
            med["demanda_contratada"] = dc
        for _posto, _col in (("fp", "demanda_contratada_fponta_kw"), ("p", "demanda_contratada_ponta_kw")):
            if dc.get(_posto) is not None:
                aplicar[_col] = dc[_posto]
                lt.setdefault(_col, dc[_posto])
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
