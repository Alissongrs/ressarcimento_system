# -*- coding: utf-8 -*-
"""Gabarito permanente das faturas ESCANEADAS (OCR) — mede cada mudança no OCR/leitores antes de subir.

46 faturas sem camada de texto conferidas visualmente (gabarito_escaneadas.json; 7 de 17/11 + 39 de 19/11/2026).
Os PDFs NÃO ficam no Git (documento de cliente): são baixados pelo link de escaneadas_fontes.json para
tests/.cache_escaneadas/ na primeira vez. Não roda no CI (precisa do RapidOCR e leva ~4 min por fatura): rode na
máquina de OCR, no ambiente de requirements-ocr.txt + rapidocr_onnxruntime.

    python tests/conferir_ocr.py                  # extrai as 46, compara com o gabarito e com a linha de base
    python tests/conferir_ocr.py --workers 3      # em paralelo (processos)
    python tests/conferir_ocr.py --so S398057.pdf
    python tests/conferir_ocr.py --gravar-base    # depois de conferir que a mudança é melhoria: regrava ocr_base.json

Sai com 1 se algum campo passou a ter valor ERRADO que não tinha na linha de base (ocr_base.json) — vazio a mais
só avisa. Sem banco: SKIP_SEFAZ=1 e sem gravação; usa o motor da pasta acima.
"""
from __future__ import annotations

import io
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

AQUI = Path(__file__).resolve().parent
ENGINE = AQUI.parent
CACHE = AQUI / ".cache_escaneadas"
SAIDA = AQUI / ".saida_ocr"
GAB = AQUI / "gabarito_escaneadas.json"
FONTES = AQUI / "escaneadas_fontes.json"
BASE = AQUI / "ocr_base.json"

sys.path.insert(0, str(AQUI))
from conferir_gabarito_lib import CAMPOS, confere, vazio  # noqa: E402

IGNORA = {"distribuidora", "codigo_uc"}  # gabarito tem o nome/número impresso; a coluna guarda o nome curto/id do cadastro


def _pdf(nome: str) -> bytes | None:
    CACHE.mkdir(exist_ok=True)
    p = CACHE / nome
    if p.exists():
        return p.read_bytes()
    os.chdir(ENGINE)
    sys.path.insert(0, str(ENGINE))
    import leitura_visual as lv
    link = (json.loads(FONTES.read_text(encoding="utf-8")).get(nome) or {}).get("link")
    if not link:
        return None
    b = lv.baixar(link)
    if b:
        p.write_bytes(b)
    return b


def _extrair(nome: str) -> tuple[str, dict]:
    os.environ["PDF_PIPELINE_NO_OCR"] = "0"
    os.environ["SKIP_SEFAZ"] = "1"
    os.environ["SURE_SEFAZ_CONFIRMA"] = "0"  # sem SEFAZ: o resultado não depende do cache desta máquina
    os.chdir(ENGINE)
    sys.path.insert(0, str(ENGINE))
    import extrair_fatura as ef
    out = SAIDA / (nome + ".json")
    if out.exists():
        return nome, json.loads(out.read_text(encoding="utf-8"))
    t0 = time.time()
    try:
        b = _pdf(nome)
        if not b:
            return nome, {"_erro": "não baixou"}
        uid = (json.loads(FONTES.read_text(encoding="utf-8")).get(nome) or {}).get("uid")
        r = ef.extrair_campos(b, nome, uid=uid)
        res = {"colunas": r.get("colunas"), "gate": r.get("gate"), "_segundos": round(time.time() - t0, 1)}
    except Exception as e:  # noqa: BLE001
        res = {"_erro": repr(e)[:300]}
    SAIDA.mkdir(exist_ok=True)
    out.write_text(json.dumps(res, ensure_ascii=False, default=str), encoding="utf-8")
    return nome, res


def main(argv: list[str]) -> int:
    gab = json.loads(GAB.read_text(encoding="utf-8"))
    nomes = sorted(gab)
    if "--so" in argv:
        nomes = [argv[argv.index("--so") + 1]]
    workers = int(argv[argv.index("--workers") + 1]) if "--workers" in argv else 1
    if "--refazer" in argv and SAIDA.exists():
        for f in SAIDA.glob("*.json"):
            f.unlink()
    resultados: dict[str, dict] = {}
    if workers > 1:
        with ProcessPoolExecutor(workers) as ex:
            for nome, r in ex.map(_extrair, nomes):
                resultados[nome] = r
                print(f"{nome}: {r.get('_segundos', '-')} s {r.get('_erro', '')}", flush=True)
    else:
        for nome in nomes:
            _, r = _extrair(nome)
            resultados[nome] = r
            print(f"{nome}: {r.get('_segundos', '-')} s {r.get('_erro', '')}", flush=True)

    tot: dict[str, dict] = {c: {"certo": 0, "errado": 0, "vazio": 0} for c in CAMPOS if c not in IGNORA}
    errados: set[str] = set()
    for nome, verdade in gab.items():
        if nome not in resultados or "_nao_fatura" in verdade:
            continue
        col = (resultados[nome].get("colunas") or {})
        for c in tot:
            v = confere(c, verdade.get(c), col.get(c), col)
            if v:
                tot[c][v] += 1
                if v == "errado":
                    errados.add(f"{nome}:{c}")
    print(f"\n{'campo':30} {'certo':>6} {'errado':>6} {'vazio':>6} {'acerto':>7}")
    for c, t in tot.items():
        n = sum(t.values())
        if n:
            print(f"{c:30} {t['certo']:6} {t['errado']:6} {t['vazio']:6} {100 * t['certo'] / n:6.0f}%")
    c = sum(t["certo"] for t in tot.values()); e = sum(t["errado"] for t in tot.values()); v = sum(t["vazio"] for t in tot.values())
    print(f"\nprecisão {100 * c / max(1, c + e):.1f}%  cobertura {100 * c / max(1, c + e + v):.1f}%  ({c} certos, {e} errados, {v} vazios)")

    if "--gravar-base" in argv:
        BASE.write_text(json.dumps({"errados": sorted(errados), "totais": tot}, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"linha de base gravada: {BASE.name}")
        return 0
    if BASE.exists() and "--so" not in argv:
        base = json.loads(BASE.read_text(encoding="utf-8"))
        novos = sorted(errados - set(base.get("errados") or []))
        piores = [k for k, t in tot.items() if t["certo"] < (base.get("totais", {}).get(k) or {}).get("certo", 0)]
        if piores:
            print("AVISO: menos certos que a linha de base em:", ", ".join(piores))
        if novos:
            print("FALHOU: valores ERRADOS novos (não estavam na linha de base):")
            for x in novos:
                print("  ", x)
            return 1
        print("ok: nenhum valor errado novo em relação à linha de base")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
