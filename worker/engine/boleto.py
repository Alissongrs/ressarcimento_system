# -*- coding: utf-8 -*-
"""Valor do documento lido da LINHA DIGITÁVEL impressa na fatura (24/11/2026).

A linha digitável carrega o valor e dígitos verificadores (módulo 10 por campo + DV geral módulo 11 no boleto
bancário; módulo 10/11 por bloco no de arrecadação). Só vale a linha cujos dígitos verificadores TODOS fecham:
assim um dígito trocado pelo OCR não passa. É o total impresso, conferido pela própria fatura.

Uso no pdf_pipeline: fatura escaneada com camada de OCR antiga (Energisa MT 2021) não traz o "TOTAL" legível e o
extrator pegava o valor do 1º item (817,81 onde a fatura e o boleto dizem 882,66).
"""
from __future__ import annotations

import datetime as _dt
import re

# bancário: AAABC.CCCCX DDDDD.DDDDDY EEEEE.EEEEEZ K UUUUVVVVVVVVVV
RE_BANCARIO = re.compile(r"(?<!\d)(\d{5})\.?(\d{5})\s*(\d{5})\.?(\d{6})\s*(\d{5})\.?(\d{6})\s*(\d)\s*(\d{14})(?!\d)")
# arrecadação (concessionária): 8XXXXXXXXXX-D XXXXXXXXXXX-D XXXXXXXXXXX-D XXXXXXXXXXX-D
RE_ARRECADACAO = re.compile(r"(?<!\d)(8\d{10})\s*-?\s*(\d)\s+(\d{11})\s*-?\s*(\d)\s+(\d{11})\s*-?\s*(\d)\s+(\d{11})\s*-?\s*(\d)(?!\d)")


def _mod10(num: str) -> int:
    soma, peso = 0, 2
    for d in reversed(num):
        p = int(d) * peso
        soma += p // 10 + p % 10
        peso = 1 if peso == 2 else 2
    return (10 - soma % 10) % 10


def _mod11_bancario(num: str) -> int:
    soma, peso = 0, 2
    for d in reversed(num):
        soma += int(d) * peso
        peso = 2 if peso == 9 else peso + 1
    dv = 11 - soma % 11
    return 1 if dv in (0, 10, 11) else dv


def _mod11_arrecadacao(num: str) -> set[int]:
    soma, peso = 0, 2
    for d in reversed(num):
        soma += int(d) * peso
        peso = 2 if peso == 9 else peso + 1
    r = soma % 11
    if r in (0, 1):
        return {0, 1} if r == 1 else {0}  # bancos variam no resto 1 (0 ou 1)
    return {11 - r}


def _datas_fator(f: int) -> set[_dt.date]:
    """Fator de vencimento → data. Ciclo 1: 07/10/1997 + f; ciclo 2 (fator 9999 esgotou em 21/02/2025): 1000 = 22/02/2025."""
    out = {_dt.date(1997, 10, 7) + _dt.timedelta(days=f)}
    if f >= 1000:
        out.add(_dt.date(2025, 2, 22) + _dt.timedelta(days=f - 1000))
    return out


def _bancario(m: re.Match, vencimento: _dt.date | None = None) -> float | None:
    g = m.groups()
    c1, c2, c3, dv, c5 = g[0] + g[1], g[2] + g[3], g[4] + g[5], g[6], g[7]
    if _mod10(c1[:9]) != int(c1[9]) or _mod10(c2[:10]) != int(c2[10]) or _mod10(c3[:10]) != int(c3[10]):
        return None
    sem_dv = c1[:4] + c5 + c1[4:9] + c2[:10] + c3[:10]  # 43 dígitos do código de barras sem o DV geral
    if _mod11_bancario(sem_dv) != int(dv):
        return None
    fator = int(c5[:4])
    if fator == 0:
        return None  # boleto sem vencimento: não é o da fatura (PDF com 2ª via de outro documento — Energisa 2025)
    if vencimento is not None and vencimento not in _datas_fator(fator):
        return None  # vencimento do boleto ≠ vencimento da fatura: boleto de outro documento
    return int(c5[4:]) / 100


def _arrecadacao(m: re.Match, vencimento: _dt.date | None = None) -> float | None:
    g = m.groups()
    blocos = [(g[i], int(g[i + 1])) for i in range(0, 8, 2)]
    ident = blocos[0][0][2]
    if ident not in "6789":
        return None
    for b, dv in blocos:
        if ident in "67":
            if _mod10(b) != dv:
                return None
        elif dv not in _mod11_arrecadacao(b):
            return None
    if ident not in "68":
        return None  # 7/9: campo é referência, não valor
    barras = "".join(b for b, _ in blocos)
    return int(barras[4:15]) / 100


def valor_boleto(texto: str | None, vencimento: _dt.date | None = None) -> float | None:
    """Valor da linha digitável com todos os DVs conferidos (no bancário, também o fator = vencimento da fatura, quando
    conhecido). Mais de um valor diferente na fatura → None (ambíguo)."""
    vals: set[float] = set()
    for rx, fn in ((RE_BANCARIO, _bancario), (RE_ARRECADACAO, _arrecadacao)):
        for m in rx.finditer(texto or ""):
            v = fn(m, vencimento)
            if v is not None and v > 0:
                vals.add(round(v, 2))
    return vals.pop() if len(vals) == 1 else None


# ─── código de barras / QR lidos da IMAGEM (codigos.py) — 24/11/2026 ─────────────────────────────────────────────
def valor_barras(cod: str, vencimento: _dt.date | None = None, estrito: bool = True) -> float | None:
    """Valor do código de barras de 44 dígitos (ITF) com o DV geral conferido. Bancário: BBB M D FFFF VVVVVVVVVV +25
    livres, fator ≠ 0 e = vencimento quando conhecido (estrito=False dispensa o fator: Equatorial imprime fator 0000 —
    vale só para CONFIRMAR o total gravado, nunca para trocá-lo). Arrecadação: 8 S I D VVVVVVVVVVV ..., ident 6/8 = valor."""
    if not cod or not re.fullmatch(r"\d{44}", cod):
        return None
    if cod[0] == "8":
        ident = cod[2]
        sem = cod[:3] + cod[4:]
        if ident in "67":
            if _mod10(sem) != int(cod[3]):
                return None
        elif ident in "89":
            if int(cod[3]) not in _mod11_arrecadacao(sem):
                return None
        else:
            return None
        return int(cod[4:15]) / 100 if ident in "68" else None
    if _mod11_bancario(cod[:4] + cod[5:]) != int(cod[4]):
        return None
    fator = int(cod[5:9])
    if estrito and (fator == 0 or (vencimento is not None and vencimento not in _datas_fator(fator))):
        return None
    return int(cod[9:19]) / 100


def _crc16_ccitt(s: str) -> str:
    crc = 0xFFFF
    for ch in s.encode("utf-8"):
        crc ^= ch << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else crc << 1
            crc &= 0xFFFF
    return f"{crc:04X}"


def _tlv(s: str) -> dict[str, str] | None:
    out, i = {}, 0
    while i + 4 <= len(s):
        tag, n = s[i:i + 2], s[i + 2:i + 4]
        if not n.isdigit():
            return None
        out[tag] = s[i + 4:i + 4 + int(n)]
        i += 4 + int(n)
    return out if i == len(s) else None


def valor_pix(payload: str) -> float | None:
    """Valor do QR PIX (BR Code EMV): campo 54, só com o CRC16 (campo 63) conferido."""
    if not payload or not payload.startswith("000201") or "6304" not in payload[-8:]:
        return None
    if _crc16_ccitt(payload[:-4]) != payload[-4:].upper():
        return None
    t = _tlv(payload)
    try:
        return float(t["54"]) if t and t.get("54") else None
    except ValueError:
        return None


def chave_nf3e(texto: str) -> str | None:
    """Chave de acesso de 44 dígitos (QR da SEFAZ: ...chNF3e=XXXX), com o DV módulo 11 conferido."""
    m = re.search(r"ch(?:NF3e|NFe|NFCom)?=(\d{44})", texto or "") or re.fullmatch(r"(\d{44})", (texto or "").strip())
    if not m:
        return None
    ch = m.group(1)
    return ch if chave_dv_ok(ch) else None


_UFS = {11, 12, 13, 14, 15, 16, 17, 21, 22, 23, 24, 25, 26, 27, 28, 29, 31, 32, 33, 35, 41, 42, 43, 50, 51, 52, 53}


def chave_dv_ok(ch: str) -> bool:
    """Chave de acesso: 44 dígitos, UF válida, mês 01–12, modelo de documento fiscal (55/57/62/65/66) e DV módulo 11.
    A estrutura barra número de boleto que fecha o DV por coincidência (24/11/2026)."""
    if not ch or not re.fullmatch(r"\d{44}", ch):
        return False
    if int(ch[:2]) not in _UFS or not 1 <= int(ch[4:6]) <= 12 or ch[20:22] not in ("55", "57", "62", "65", "66"):
        return False
    soma, peso = 0, 2
    for d in reversed(ch[:43]):
        soma += int(d) * peso
        peso = 2 if peso == 9 else peso + 1
    r = soma % 11
    return int(ch[43]) == (0 if r in (0, 1) else 11 - r)
