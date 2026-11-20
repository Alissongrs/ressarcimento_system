# -*- coding: utf-8 -*-
"""Leitura visual das faturas que o motor determinístico não fecha (etapa 3 da captura de alto nível).

Para cada fatura candidata (PDF só imagem, ou gate "reprovado"): baixa o PDF, renderiza as primeiras
páginas em PNG, pede ao `claude -p` (assinatura do Claude Code na VPS — sem API paga) que leia as
imagens e devolva UM JSON com identificação, medição, itens, tributos e demandas; o JSON passa pelas
mesmas contas do motor (leitura atual − anterior × K = consumo; soma dos itens = total; tributo = base ×
alíquota) e só o que fecha vira coluna. O resultado de cada tentativa fica em FT_LEITURA_VISUAL
(resposta, validação, colunas, valores anteriores para desfazer). Quem falha duas vezes vira "humano"
(fila de revisão humana).

A gravação em FATURA_DADOS_EXTRAIDOS é DESLIGADA por padrão (só preenche colunas vazias, e só com
SURE_VISUAL_GRAVAR=1 / --gravar): a rotina roda, lê e valida; o que gravaria fica em colunas_json.

Uso:
  python leitura_visual.py rodar [--teto 300] [--minutos 300] [--gravar] [--id N ...]   (cron da VPS)
  python leitura_visual.py ler fatura.pdf [--json]        lê um PDF local e mostra o que fecharia
  python leitura_visual.py desfazer <id_fatura>           volta as colunas gravadas (antes_json)
  python leitura_visual.py fila                           quantas candidatas há
"""
from __future__ import annotations

import datetime as dt
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

AQUI = Path(__file__).resolve().parent
if str(AQUI) not in sys.path:
    sys.path.insert(0, str(AQUI))

from identificacao import catalogo, normalizar  # noqa: E402
from medicao import Registro, _r3, classificar_grandeza, classificar_posto, validar  # noqa: E402

CLAUDE = os.environ.get("SURE_CLAUDE_BIN", "claude")
MODELO = "claude-visual"
# motor da leitura: "claude" (claude -p, assinatura da VPS, limite de 5 h) ou "openai" (API, paga por token;
# SURE_VISUAL_MODELO = gpt-5.4-nano | gpt-5.4-mini | gpt-4.1-mini). Chave OPENAI_API_KEY do backend/.env (db_env).
MOTOR = os.environ.get("SURE_VISUAL_MOTOR", "claude")
MODELO_OPENAI = os.environ.get("SURE_VISUAL_MODELO", "gpt-5.4-nano")
ULTIMO_USO: dict = {}  # tokens da última chamada OpenAI (custo)
TIMEOUT_CLAUDE = int(os.environ.get("SURE_VISUAL_TIMEOUT", "240"))
MAX_PAGINAS = int(os.environ.get("SURE_VISUAL_PAGINAS", "3"))
DPI = int(os.environ.get("SURE_VISUAL_DPI", "150"))
WORK = Path(os.environ.get("SURE_VISUAL_DIR", str(AQUI / "_work" / "visual")))

# colunas que a leitura visual pode preencher, por bloco validado
COLS_IDENT = ("distribuidora", "codigo_uc", "mes_referencia", "data_vencimento", "data_emissao_nf", "numero_fatura",
              "dias_faturados", "grupo_tarifario", "subgrupo_tarifario", "modalidade_tarifaria", "valor_total_fatura")
COLS_MED = ("numero_medidor", "constante_k", "leit_ant_ativa_ponta", "leit_atu_ativa_ponta", "leit_ant_ativa_fponta",
            "leit_atu_ativa_fponta", "consumo_ativo_ponta_kwh", "consumo_ativo_fponta_kwh", "kwh_total",
            "demanda_contratada_ponta_kw", "demanda_contratada_fponta_kw", "demanda_faturada_ponta_kw",
            "demanda_faturada_fponta_kw", "medicao_grandezas_json")
COLS_TRIB = ("icms_base_calculo", "icms_aliquota", "icms_valor", "pis_valor", "cofins_valor")

PROMPT = """Você lê FATURAS DE ENERGIA ELÉTRICA brasileiras a partir de imagens. Leia TODAS as imagens
listadas abaixo (use a ferramenta Read em cada caminho) e devolva SOMENTE um JSON, sem texto antes ou
depois, sem bloco de código, neste formato (use null para o que não estiver impresso; NUNCA chute):

{
  "tipo_documento": "fatura" | "nota_acl" | "rateio" | "outro",
  "identificacao": {
    "distribuidora": "nome impresso no cabeçalho", "cnpj_distribuidora": "00.000.000/0000-00 ou null",
    "uc": "código da unidade consumidora / instalação", "codigo_cliente": "nº do cliente, se houver",
    "mes_referencia": "AAAA-MM", "data_emissao": "AAAA-MM-DD", "data_vencimento": "AAAA-MM-DD",
    "numero_nf": "nº da nota fiscal", "dias": 30, "grupo": "A" | "B", "subgrupo": "A4" | "B3" | ...,
    "modalidade": "Verde" | "Azul" | "Convencional" | "Branca", "total_a_pagar": 1234.56
  },
  "medicao": {
    "medidor": "nº do medidor",
    "perda_pct": 2.5,
    "registros": [
      {"grandeza": "texto impresso (ex.: Energia Ativa kWh, Demanda kW, Reativa)", "posto": "Ponta | Fora Ponta | Único | Reservado",
       "leitura_anterior": 12345, "leitura_atual": 12400, "constante": 1.0, "consumo": 55}
    ]
  },
  "demanda": {"contratada_ponta": null, "contratada_fponta": 100.0, "faturada_ponta": null, "faturada_fponta": 98.5},
  "itens": [{"descricao": "texto do item", "unidade": "kWh | kW | kVArh | R$", "quantidade": 55, "valor": 34.56}],
  "tributos": {"icms_base": 100.0, "icms_aliquota": 18.0, "icms_valor": 18.0, "pis_valor": 0.5, "cofins_valor": 2.3},
  "observacoes": "o que ficou ilegível ou ambíguo"
}

Regras:
- Números com ponto decimal e sem separador de milhar; "R$ 1.234,56" vira 1234.56. Datas em AAAA-MM-DD.
- Copie as leituras e a constante como impressas na TABELA DE MEDIÇÃO (medidor, grandeza, posto, leitura
  anterior, leitura atual, constante, consumo). Um registro por linha dessa tabela.
- "itens": todas as linhas da tabela de faturamento, com quantidade e valor como impressos (sinal negativo
  quando for crédito). "total_a_pagar" é o valor em destaque da fatura.
- Se não for fatura de distribuidora (rateio de condomínio, nota de comercializadora, outro documento),
  diga em tipo_documento e preencha o que der.

Imagens:
"""


# ─── infra ────────────────────────────────────────────────────────────────────
def _con():
    import mysql.connector
    from db_env import conexao
    return mysql.connector.connect(**conexao("DB_APP_URL"))


def _log(msg: str) -> None:
    print(f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def baixar(url: str) -> bytes | None:
    try:
        import pdf_pipeline as pp
        return pp.baixar_pdf(url)
    except Exception:
        import requests
        r = requests.get(url.strip(), timeout=30)
        r.raise_for_status()
        return r.content if b"%PDF-" in r.content[:1024] else None


def abrir(pdf_bytes: bytes):
    """Abre o PDF; protegido por senha vazia é destravado, senão levanta ValueError('PDF protegido')."""
    import fitz
    d = fitz.open(stream=pdf_bytes, filetype="pdf")
    if d.is_encrypted and not d.authenticate(""):
        raise ValueError("PDF protegido por senha")
    try:
        d[0]
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"PDF protegido/ilegível: {e}") from e
    return d


def texto_do_pdf(pdf_bytes: bytes, max_paginas: int = 3) -> int:
    """Tamanho da camada de texto (0 = só imagem). Decide se a fatura é mesmo caso de leitura visual."""
    try:
        d = abrir(pdf_bytes)
        return sum(len(pg.get_text()) for i, pg in enumerate(d) if i < max_paginas)
    except Exception:
        return 0


def renderizar(pdf_bytes: bytes, base: Path, max_paginas: int = MAX_PAGINAS, dpi: int = DPI) -> list[Path]:
    base.parent.mkdir(parents=True, exist_ok=True)
    d = abrir(pdf_bytes)
    out = []
    for i, pg in enumerate(d):
        if i >= max_paginas:
            break
        p = base.with_name(f"{base.name}_p{i + 1}.png")
        pg.get_pixmap(dpi=dpi).save(str(p))
        out.append(p)
    return out


def chamar_claude(imagens: list[Path], foco: dict | None = None) -> tuple[dict | None, str]:
    """Uma chamada `claude -p` por fatura; só a ferramenta Read. Devolve (json, saída bruta).
    `foco` (2ª tentativa) diz o que não fechou na 1ª: o pedido continua o JSON inteiro, mas com atenção dirigida."""
    prompt = PROMPT + "\n".join(f"- {p.resolve()}" for p in imagens) + "\n"
    if foco:
        blocos = ", ".join(foco.get("blocos") or []) or "nenhum bloco"
        prompt += ("\nSEGUNDA LEITURA. Na primeira, estes blocos NÃO fecharam nas contas: " + blocos + ".\n"
                   "Motivos: " + "; ".join(foco.get("obs") or []) + "\n"
                   "Releia com cuidado redobrado: (1) em 'itens', liste TODAS as linhas da tabela de faturamento, inclusive "
                   "créditos negativos, bandeira, iluminação pública, juros, multa e parcelas, com o valor exato de cada uma — "
                   "a soma tem de bater com o total; (2) na tabela de medição, copie cada número dígito a dígito, leitura "
                   "anterior, atual, constante e consumo na ordem impressa; (3) para o ICMS, use a BASE DE CÁLCULO do quadro de "
                   "tributos (não o total da fatura) e a alíquota impressa. Devolva o JSON completo de novo.\n")
    flags = os.environ.get("SURE_VISUAL_CLAUDE_FLAGS", "-p --permission-mode acceptEdits --allowedTools Read")
    args = [CLAUDE] + [a for a in flags.split(" ") if a]
    try:
        p = subprocess.run(args, input=prompt, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=TIMEOUT_CLAUDE)
    except subprocess.TimeoutExpired:
        return None, f"timeout {TIMEOUT_CLAUDE}s"
    except Exception as e:  # noqa: BLE001
        return None, f"falha ao chamar claude: {e}"
    saida = (p.stdout or "").strip()
    m = re.search(r"\{.*\}", saida, re.S)
    if not m:
        return None, (saida or p.stderr or "")[:800]
    try:
        return json.loads(m.group(0)), saida
    except ValueError as e:
        return None, f"JSON inválido ({e}): {saida[:600]}"


# ─── validação ────────────────────────────────────────────────────────────────
def _num(v) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace("R$", "").replace(" ", "")
    if not s:
        return None
    if re.fullmatch(r"-?\d{1,3}(\.\d{3})+(,\d+)?", s) or ("," in s and "." not in s):
        s = s.replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def _data(v) -> str | None:
    if not v:
        return None
    s = str(v).strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        y, mo, d = map(int, m.groups())
    else:
        m = re.match(r"^(\d{2})/(\d{2})/(\d{4})", s)
        if not m:
            return None
        d, mo, y = map(int, m.groups())
    try:
        return dt.date(y, mo, d).isoformat()
    except ValueError:
        return None


def _mes(v) -> str | None:
    if not v:
        return None
    s = str(v).strip()
    m = re.match(r"^(\d{4})-(\d{2})", s) or re.match(r"^(\d{2})/(\d{4})$", s)
    if not m:
        return None
    y, mo = (int(m.group(1)), int(m.group(2))) if len(m.group(1)) == 4 else (int(m.group(2)), int(m.group(1)))
    if 1 <= mo <= 12 and 2000 <= y <= 2100:
        return f"{y:04d}-{mo:02d}-01"
    return None


def _distribuidora(nome: str | None, cnpj: str | None) -> tuple[str | None, str | None]:
    """Nome canônico pelo CNPJ (catálogo por raiz) ou pelo alias do nome impresso."""
    cat = catalogo()
    raizes = cat.get("raizes") or cat
    if cnpj:
        dig = re.sub(r"\D", "", str(cnpj))
        if len(dig) == 14 and dig[:8] in raizes:
            return raizes[dig[:8]].get("nome"), dig[:8]
    if nome:
        n = normalizar(nome)
        for raiz, d in raizes.items():
            if not isinstance(d, dict):
                continue
            for a in [d.get("nome", ""), d.get("sigla", "")] + list(d.get("aliases") or []):
                if a and normalizar(a) and (normalizar(a) in n or n == normalizar(a)):
                    return d.get("nome"), raiz
    return (str(nome).strip() if nome else None), None


def validar_leitura(resp: dict) -> dict:
    """Confere o JSON lido com as contas da fatura. Devolve {blocos: {...}, colunas: {...}, obs: [...]}."""
    obs: list[str] = []
    blocos = {"identificacao": False, "medicao": False, "financeiro": False, "tributos": False}
    cols: dict = {}
    tipo = str(resp.get("tipo_documento") or "fatura").lower()
    ident = resp.get("identificacao") or {}
    med = resp.get("medicao") or {}
    dem = resp.get("demanda") or {}
    itens = [i for i in (resp.get("itens") or []) if isinstance(i, dict)]
    trib = resp.get("tributos") or {}

    # identificação: mês, datas coerentes, total > 0 (fatura), distribuidora reconhecida
    mes = _mes(ident.get("mes_referencia"))
    emi, ven = _data(ident.get("data_emissao")), _data(ident.get("data_vencimento"))
    total = _num(ident.get("total_a_pagar"))
    dist, raiz = _distribuidora(ident.get("distribuidora"), ident.get("cnpj_distribuidora"))
    uc = re.sub(r"[^0-9A-Za-z./-]", "", str(ident.get("uc") or "")).strip("./-") or None
    ok_ident = bool(mes) and (ven is None or emi is None or ven >= emi) and (uc is not None) and tipo == "fatura"
    if tipo != "fatura":
        obs.append(f"documento classificado como {tipo}")
    if ok_ident:
        blocos["identificacao"] = True
        cols.update({"codigo_uc": uc, "mes_referencia": mes, "data_vencimento": ven, "data_emissao_nf": emi,
                     "numero_fatura": (str(ident.get("numero_nf")).strip() if ident.get("numero_nf") else None),
                     "dias_faturados": int(_num(ident.get("dias"))) if _num(ident.get("dias")) else None,
                     "grupo_tarifario": (str(ident.get("grupo") or "")[:1].upper() or None),
                     "subgrupo_tarifario": (str(ident.get("subgrupo") or "").upper() or None),
                     "modalidade_tarifaria": (str(ident.get("modalidade") or "").capitalize() or None)})
        if dist:
            cols["distribuidora"] = dist
        if raiz is None and ident.get("distribuidora"):
            obs.append("distribuidora fora do catálogo (nome copiado como impresso)")

    # financeiro: soma dos itens = total
    soma = None
    vals = [_num(i.get("valor")) for i in itens]
    if itens and all(v is not None for v in vals):
        soma = round(sum(vals), 2)
    if total is not None and soma is not None and abs(soma - total) <= max(0.05, 0.002 * abs(total)):
        blocos["financeiro"] = True  # inclui fatura zerada por compensação (total 0 = soma 0)
        cols["valor_total_fatura"] = total
    elif total and soma is not None:
        obs.append(f"soma dos itens {soma} ≠ total {total}")
    elif total and not itens:
        obs.append("total sem itens para conferir")

    # tributos: icms = base × alíquota
    ib, ia, iv = _num(trib.get("icms_base")), _num(trib.get("icms_aliquota")), _num(trib.get("icms_valor"))
    if ib is not None and ia is not None and iv is not None and abs(ib * ia / 100 - iv) <= max(0.05, 0.005 * iv):
        blocos["tributos"] = True
        cols.update({"icms_base_calculo": ib, "icms_aliquota": ia, "icms_valor": iv,
                     "pis_valor": _num(trib.get("pis_valor")), "cofins_valor": _num(trib.get("cofins_valor"))})
    elif iv is not None:
        obs.append("ICMS não fecha base × alíquota")

    # medição: física por registro (mesma validação do medicao.py)
    regs: list[Registro] = []
    rsv_visto = False
    for r in med.get("registros") or []:
        if not isinstance(r, dict):
            continue
        gtxt = str(r.get("grandeza") or "")
        ptxt = str(r.get("posto") or "")
        g = classificar_grandeza(gtxt)
        p, sub = classificar_posto(ptxt or gtxt)
        if re.match(r"^rsv\b", normalizar(gtxt)):  # Energisa MT: "RSV Fora Ponta" = reservado; só a 1ª linha é ativa
            p = "reservado"
            if rsv_visto:
                g = "outra"
            rsv_visto = True
        regs.append(Registro(str(med.get("medidor") or "") or None, g, gtxt, p, sub, ptxt,
                             _num(r.get("leitura_anterior")), _num(r.get("leitura_atual")), _num(r.get("constante")),
                             _num(r.get("consumo"))))
    perda_linha = _num(med.get("perda_pct"))
    if regs:
        perda, origem = validar(regs, perda_linha)
        ativa = [r for r in regs if r.grandeza == "energia_ativa"]
        conf = [r for r in ativa if r.ok is not None]
        qs_kwh = [_num(i.get("quantidade")) for i in itens if str(i.get("unidade") or "").lower().startswith("kwh")]

        def _item_bate(v):
            return bool(v) and any(q and abs(q - v) <= max(0.02, 0.003 * v) for q in qs_kwh)

        ok_fisica = bool(conf) and all(r.ok for r in conf)
        com_consumo = [r for r in ativa if r.consumo]
        # leituras iguais com consumo impresso e confirmado item a item (Coelba livre): vale pelos itens
        ok_itens = (not ok_fisica and bool(com_consumo) and all(r.leit_ant == r.leit_atu and _item_bate(r.consumo) for r in com_consumo))
        if ok_itens:
            obs.append("física não fecha (leituras iguais); consumo confirmado pelos itens")
        # física fecha mas CONTRADIZ os itens kWh da própria fatura (nenhum consumo bate, nem com perda de até 10 %):
        # algum registro foi lido/classificado errado — não grava medição
        if ok_fisica and qs_kwh and com_consumo:
            tot_posto: dict[str, float] = {}
            for r in com_consumo:
                tot_posto[r.posto] = tot_posto.get(r.posto, 0.0) + r.consumo
            def _perto(v):
                return any(q and (abs(q - v) <= max(0.02, 0.003 * v) or 1.005 <= q / v <= 1.10) for q in qs_kwh)
            if not any(_perto(v) for v in tot_posto.values()):
                ok_fisica = False
                obs.append("medição fecha na física mas nenhum consumo bate com os itens kWh da fatura: não gravada")
        if ok_fisica or ok_itens:
            blocos["medicao"] = True
            fator = 1 + (perda or 0) / 100 if (origem in ("linha",) and ok_fisica) else 1.0
            por_posto: dict[str, float] = {}
            for r in ativa:
                if r.consumo is not None:
                    por_posto[r.posto] = por_posto.get(r.posto, 0.0) + r.consumo * fator
            cp = por_posto.get("p")
            cfp = sum(v for k, v in por_posto.items() if k in ("fp", "unico", "intermediario")) \
                if any(k in por_posto for k in ("fp", "unico", "intermediario")) else None
            if cp is None and cfp is None and por_posto.get("reservado") is None:
                pass
            lp = max([r for r in ativa if r.posto == "p" and r.leit_ant is not None], key=lambda z: z.consumo or 0, default=None)
            lfp = max([r for r in ativa if r.posto in ("fp", "unico") and r.leit_ant is not None], key=lambda z: z.consumo or 0, default=None)
            if lfp is None and lp is not None and str(ident.get("grupo") or "").upper().startswith("B"):
                lp, lfp = None, lp
                cfp, cp = cp, None
            cols["numero_medidor"] = str(med.get("medidor")).strip() if med.get("medidor") else None
            cols["constante_k"] = (lfp or lp).constante if (lfp or lp) else None
            if lp:
                cols["leit_ant_ativa_ponta"], cols["leit_atu_ativa_ponta"] = lp.leit_ant, lp.leit_atu
            if lfp:
                cols["leit_ant_ativa_fponta"], cols["leit_atu_ativa_fponta"] = lfp.leit_ant, lfp.leit_atu
            # perda de transformação só nos itens (CPFL, Amazonas: tabela imprime o medido; o item kWh vem ×1,025).
            # Mesma regra do medicao.py: itens kWh com a MESMA razão 1,005–1,10 sobre o medido → o faturado é o item
            if fator == 1.0 and not any(_item_bate(v) for v in (cp, cfp) if v):
                razoes = {}
                for posto, base in (("p", cp), ("fp", cfp)):
                    if not base:
                        continue
                    for q in qs_kwh:
                        if q and 1.005 <= q / base <= 1.10:
                            razoes[posto] = (q / base, q)
                            break
                zs = [z for z, _ in razoes.values()]
                if zs and max(zs) - min(zs) < 0.004 and len(razoes) == sum(1 for v in (cp, cfp) if v):
                    if "p" in razoes:
                        cp = razoes["p"][1]
                    if "fp" in razoes:
                        cfp = razoes["fp"][1]
                    obs.append(f"perda de {round((sum(zs) / len(zs) - 1) * 100, 2)}% inferida pelos itens: consumo faturado = item")
            if cp is not None:
                cols["consumo_ativo_ponta_kwh"] = _r3(cp)
            if cfp is not None:
                cols["consumo_ativo_fponta_kwh"] = _r3(cfp)
            if cp is not None or cfp is not None:
                cols["kwh_total"] = _r3((cp or 0) + (cfp or 0) + (por_posto.get("reservado") or 0) * 1.0)
            cols["medicao_grandezas_json"] = json.dumps([r.dict() for r in regs], ensure_ascii=False)
            # consumo confirmado por um item kWh? (reforço, não condição)
            for alvo in (cp, cfp):
                if _item_bate(alvo):
                    obs.append(f"consumo {alvo} confirmado por item kWh")
        else:
            falhas = "; ".join(f"{r.grandeza_txt} {r.posto_txt}: {r.consumo} ≠ {r.regra} = {r.calc}" for r in ativa if r.ok is False)
            obs.append("medição não fecha: " + falhas if falhas else
                       "medição sem registro conferível (leituras/constante ausentes ou zeradas)")
    if med.get("medidor") and "numero_medidor" not in cols:
        cols["numero_medidor"] = str(med.get("medidor")).strip()  # rótulo do medidor é confiável mesmo sem a física fechar

    # demandas: só junto com a medição validada (vêm do mesmo quadro) ou da identificação OK
    if blocos["medicao"] or blocos["identificacao"]:
        for k, c in (("contratada_ponta", "demanda_contratada_ponta_kw"), ("contratada_fponta", "demanda_contratada_fponta_kw"),
                     ("faturada_ponta", "demanda_faturada_ponta_kw"), ("faturada_fponta", "demanda_faturada_fponta_kw")):
            v = _num(dem.get(k))
            if v is not None and v > 0:
                cols[c] = v
        # mesma regra do molde de texto (medicao.py): o item de demanda da fatura prevalece; com vários itens,
        # o mais perto da demanda medida fora ponta (CPFL imprime duas demandas)
        dem_itens = _demanda_itens(itens)
        dm_fp = max([r.consumo for r in regs if r.grandeza == "demanda" and r.posto == "fp" and r.consumo], default=None)
        azul = "azul" in normalizar(str(ident.get("modalidade") or ""))
        if dem_itens and not azul:
            if len(dem_itens) == 1:
                cols["demanda_faturada_fponta_kw"] = dem_itens[0]
            elif dm_fp:
                perto = min(dem_itens, key=lambda v: abs(v - dm_fp))
                if abs(perto - dm_fp) <= 0.05 * dm_fp:
                    cols["demanda_faturada_fponta_kw"] = perto
                    obs.append(f"demanda faturada = item {perto} (mais perto da medida {dm_fp})")
        elif dem_itens and azul and len(dem_itens) == 2:
            cols["demanda_faturada_ponta_kw"], cols["demanda_faturada_fponta_kw"] = dem_itens[0], dem_itens[1]

    cols = {k: v for k, v in cols.items() if v is not None}
    if tipo != "fatura":  # rateio, nota de comercializadora, outro: não é fatura de distribuidora — nada a gravar
        blocos = {k: False for k in blocos}
        cols = {}
    # Enel SP imprime "UC / instalação" no mesmo quadro e a origem grava o 2º número: todos os identificadores lidos
    # contam como "a mesma UC" na comparação com o que já está na base
    uc_alt = [p.strip() for p in re.split(r"[/|]", str(ident.get("uc") or "")) if p.strip()]
    if ident.get("codigo_cliente"):
        uc_alt.append(str(ident["codigo_cliente"]).strip())
    return {"blocos": blocos, "colunas": cols, "obs": obs, "tipo_documento": tipo, "uc_alternativas": uc_alt}


def _demanda_itens(itens: list) -> list[float]:
    """Quantidades (kW) dos itens de demanda faturada lidos — exclui diferença/retroativa/ultrapassagem/reativa/etc."""
    vals = []
    for it in itens:
        d = normalizar(str(it.get("descricao") or ""))
        u = str(it.get("unidade") or "").upper().replace(" ", "")
        q = _num(it.get("quantidade"))
        if "demanda" not in d or not u.startswith("KW") or u.startswith("KWH") or not q or q <= 0:
            continue
        if re.search(r"diferen|retroativ|ultrapass|reativ|lei estadual|geracao|complement|isent|exced|sem icms|nao utiliz", d):
            continue
        vals.append(round(q, 3))
    return sorted(set(vals))


def status_de(val: dict) -> str:
    b = val["blocos"]
    if val.get("tipo_documento", "fatura") != "fatura":
        return "outro"
    if b["identificacao"] and (b["medicao"] or b["financeiro"]):
        return "ok"
    if any(b.values()):
        return "parcial"
    return "falhou"


# ─── banco ────────────────────────────────────────────────────────────────────
SQL_CANDIDATAS = """
SELECT f.id, f.uid, f.link_fatura, f.cod_empresa, f.distribuidora, f.validador_gate, f.mes_referencia
  FROM FATURA_DADOS_EXTRAIDOS f
  LEFT JOIN FT_LEITURA_VISUAL v ON v.id_fatura = f.id
 WHERE f.link_fatura LIKE 'http%%'
   AND (((f.texto_plumber IS NULL OR LENGTH(f.texto_plumber) < 200) AND COALESCE(f.validador_gate,'') NOT IN ('aprovado','revisao'))
        OR f.validador_gate = 'reprovado')
   AND (v.id_fatura IS NULL OR (v.status NOT IN ('ok','humano','outro','tem_texto','reprocessada') AND v.tentativas < 2))
 ORDER BY (f.texto_plumber IS NULL OR LENGTH(f.texto_plumber) < 200) DESC, f.mes_referencia DESC, f.id DESC
 LIMIT %s"""


# campos-chave: fatura entra na fila do modelo quando algum deles tem uma fonte só, está vazio ou diverge entre fontes
CAMPOS_CHAVE = ("consumo_ativo_fponta_kwh", "consumo_ativo_ponta_kwh", "kwh_total", "leit_ant_ativa_fponta",
                "leit_atu_ativa_fponta", "constante_k", "icms_valor", "pis_valor", "cofins_valor", "valor_total_fatura",
                "demanda_contratada_fponta_kw")
CAMPOS_OBRIGATORIOS = ("consumo_ativo_fponta_kwh", "valor_total_fatura", "icms_valor")  # vazio aqui = confiança baixa


def confianca_baixa(conf_json: str | None) -> list[str]:
    """Campos-chave com n < 2, divergência ou ausentes (dos obrigatórios), a partir do confianca_json."""
    try:
        c = json.loads(conf_json or "")
    except ValueError:
        return []
    n, div = c.get("n") or {}, c.get("div") or {}
    sefaz = set(c.get("sefaz") or [])  # valor da NF3e (fonte oficial): vale sempre, sem leitura do modelo
    n = {k: v for k, v in n.items() if k not in sefaz}
    div = {k: v for k, v in div.items() if k not in sefaz}
    baixos = [k for k in CAMPOS_CHAVE if k in n and int(n[k]) < 2]
    baixos += [k for k in CAMPOS_CHAVE if k in div and k not in baixos]
    baixos += [k for k in CAMPOS_OBRIGATORIOS if k not in n and k not in sefaz and k not in baixos]
    return baixos


def candidatas_confianca(con, teto: int) -> list[dict]:
    """Fila do modelo: faturas com confianca_json (pipeline novo) e campo-chave de confiança baixa, ainda não lidas
    pelo modelo (FT_LEITURA_VISUAL com modelo openai e status ok/humano/outro, ou 2 tentativas)."""
    cur = con.cursor(dictionary=True)
    cur.execute("""SELECT f.id, f.uid, f.link_fatura, f.cod_empresa, f.distribuidora, f.validador_gate, f.mes_referencia, f.confianca_json
                     FROM FATURA_DADOS_EXTRAIDOS f
                     LEFT JOIN FT_LEITURA_VISUAL v ON v.id_fatura = f.id
                    WHERE f.link_fatura LIKE 'http%%' AND f.confianca_json IS NOT NULL AND f.confianca_json <> ''
                      AND (v.id_fatura IS NULL OR (v.status NOT IN ('ok','humano','outro') AND v.tentativas < 2))
                    ORDER BY f.mes_referencia DESC, f.id DESC LIMIT %s""", (max(teto * 20, 500),))
    rows = []
    for r in cur.fetchall():
        baixos = confianca_baixa(r.get("confianca_json"))
        if baixos:
            r["_baixos"] = baixos
            rows.append(r)
        if len(rows) >= teto * 3:
            break
    cur.close()
    return rows


def llm_na_ultima_hora(con) -> int:
    cur = con.cursor()
    cur.execute("SELECT COUNT(*) FROM FT_LEITURA_VISUAL WHERE modelo LIKE 'openai:%%' AND atualizado_em >= NOW() - INTERVAL 1 HOUR")
    n = int(cur.fetchone()[0] or 0)
    cur.close()
    return n


def candidatas(con, teto: int, ids: list[int] | None = None) -> list[dict]:
    cur = con.cursor(dictionary=True)
    if ids:
        ph = ",".join(["%s"] * len(ids))
        cur.execute(f"SELECT id, uid, link_fatura, cod_empresa, distribuidora, validador_gate, mes_referencia "
                    f"FROM FATURA_DADOS_EXTRAIDOS WHERE id IN ({ph})", ids)
    else:
        cur.execute(SQL_CANDIDATAS, (teto,))
    rows = cur.fetchall()
    cur.close()
    return rows


def gravar_tentativa(con, fid: int, uid: str | None, resp: dict | None, val: dict | None, status: str, erro: str | None,
                     antes: dict | None, gravado: bool, conta: bool = True) -> None:
    """conta=False: a falha foi da IA (limite de uso, timeout), não da fatura — não gasta uma das 2 tentativas."""
    cur = con.cursor()
    inc = 1 if conta else 0
    cur.execute(f"""INSERT INTO FT_LEITURA_VISUAL (id_fatura, uid, tentativas, status, modelo, resposta_json, validacao_json,
                     colunas_json, antes_json, gravado, erro, criado_em, atualizado_em)
                   VALUES (%s, %s, {inc}, %s, %s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
                   ON DUPLICATE KEY UPDATE tentativas = tentativas + {inc}, status = VALUES(status), modelo = VALUES(modelo),
                     resposta_json = VALUES(resposta_json), validacao_json = VALUES(validacao_json),
                     colunas_json = VALUES(colunas_json), antes_json = COALESCE(VALUES(antes_json), antes_json),
                     gravado = gravado OR VALUES(gravado), erro = VALUES(erro), atualizado_em = NOW()""",
                (fid, uid, status, MODELO, json.dumps(resp, ensure_ascii=False) if resp else None,
                 json.dumps(val, ensure_ascii=False, default=str) if val else None,
                 json.dumps(val["colunas"], ensure_ascii=False, default=str) if val else None,
                 json.dumps(antes, ensure_ascii=False, default=str) if antes else None, 1 if gravado else 0,
                 (erro or "")[:500] or None))
    # 2ª falha → humano
    cur.execute("UPDATE FT_LEITURA_VISUAL SET status='humano' WHERE id_fatura=%s AND status IN ('falhou','parcial','erro') AND tentativas >= 2 AND erro NOT LIKE '%%PDF protegido%%'", (fid,))
    con.commit()
    cur.close()


def aplicar_colunas(con, fid: int, cols: dict) -> tuple[dict, list[str]]:
    """Preenche SÓ colunas vazias de FATURA_DADOS_EXTRAIDOS. Devolve (valores anteriores, colunas gravadas)."""
    if not cols:
        return {}, []
    nomes = list(cols)
    cur = con.cursor(dictionary=True)
    cur.execute(f"SELECT {', '.join(nomes)} FROM FATURA_DADOS_EXTRAIDOS WHERE id=%s", (fid,))
    antes = cur.fetchone() or {}
    cur.close()
    vazias = [k for k in nomes if antes.get(k) in (None, "", 0) or (isinstance(antes.get(k), (int, float)) and antes.get(k) == 0 and k.startswith("kwh"))]
    if not vazias:
        return antes, []
    sets = ", ".join(f"{k}=%s" for k in vazias) + ", fonte_extracao=%s, extracao_modelo_revisor=%s, extracao_revisao_em=NOW()"
    cur = con.cursor()
    cur.execute(f"UPDATE FATURA_DADOS_EXTRAIDOS SET {sets} WHERE id=%s", [cols[k] for k in vazias] + ["visual", MODELO, fid])
    con.commit()
    cur.close()
    return antes, vazias


def desfazer(con, fid: int) -> int:
    cur = con.cursor(dictionary=True)
    cur.execute("SELECT antes_json, colunas_json, gravado FROM FT_LEITURA_VISUAL WHERE id_fatura=%s", (fid,))
    row = cur.fetchone()
    cur.close()
    if not row or not row.get("gravado") or not row.get("antes_json"):
        return 0
    antes = json.loads(row["antes_json"])
    cols = json.loads(row["colunas_json"] or "{}")
    nomes = [k for k in cols if k in antes]
    if not nomes:
        return 0
    cur = con.cursor()
    cur.execute("UPDATE FATURA_DADOS_EXTRAIDOS SET " + ", ".join(f"{k}=%s" for k in nomes) + " WHERE id=%s",
                [antes[k] for k in nomes] + [fid])
    cur.execute("UPDATE FT_LEITURA_VISUAL SET gravado=0, atualizado_em=NOW() WHERE id_fatura=%s", (fid,))
    con.commit()
    cur.close()
    return len(nomes)


# ─── uma fatura ───────────────────────────────────────────────────────────────
DPI_SEGUNDA = int(os.environ.get("SURE_VISUAL_DPI_SEGUNDA", "220"))


def _chave_openai() -> str | None:
    k = os.environ.get("OPENAI_API_KEY")
    if k:
        return k
    try:
        env = AQUI.parent.parent / "backend" / ".env"
        for ln in env.read_text(encoding="utf-8", errors="replace").splitlines():
            if ln.strip().startswith("OPENAI_API_KEY="):
                return ln.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return None


def chamar_openai(imagens: list[Path], foco: dict | None = None, modelo: str | None = None) -> tuple[dict | None, str]:
    """Mesmo prompt da leitura visual, pela API da OpenAI (chat completions, imagens em base64, resposta JSON).
    Guarda os tokens em ULTIMO_USO. Devolve (json, saída bruta)."""
    global ULTIMO_USO
    import base64
    import urllib.request
    import urllib.error
    chave = _chave_openai()
    if not chave:
        return None, "OPENAI_API_KEY ausente"
    modelo = modelo or MODELO_OPENAI
    texto = PROMPT.rstrip() + "\nAs imagens das páginas estão anexadas nesta mensagem, na ordem.\n"
    if foco:
        blocos = ", ".join(foco.get("blocos") or []) or "nenhum bloco"
        texto += ("\nSEGUNDA LEITURA. Na primeira, estes blocos NÃO fecharam nas contas: " + blocos + ".\n"
                  "Motivos: " + "; ".join(foco.get("obs") or []) + "\n"
                  "Releia com cuidado redobrado e devolva o JSON completo de novo.\n")
    conteudo: list = [{"type": "text", "text": texto}]
    for p in imagens:
        b64 = base64.b64encode(p.read_bytes()).decode("ascii")
        conteudo.append({"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64, "detail": "high"}})
    corpo = {"model": modelo, "messages": [{"role": "user", "content": conteudo}],
             "response_format": {"type": "json_object"}, "max_completion_tokens": 6000}
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=json.dumps(corpo).encode("utf-8"),
                                 headers={"Authorization": "Bearer " + chave, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_CLAUDE) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.read()[:300].decode('utf-8', 'replace')}"
    except Exception as e:  # noqa: BLE001
        return None, f"falha ao chamar openai: {e}"
    ULTIMO_USO = dict(d.get("usage") or {})
    ULTIMO_USO["modelo"] = modelo
    saida = ((d.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    m = re.search(r"\{.*\}", saida, re.S)
    if not m:
        return None, saida[:800]
    try:
        return json.loads(m.group(0)), saida
    except ValueError as e:
        return None, f"JSON inválido ({e}): {saida[:600]}"


def ler_pdf(pdf_bytes: bytes, nome: str, foco: dict | None = None, motor: str | None = None) -> tuple[dict | None, dict | None, str | None]:
    """(resposta, validação, erro) de um PDF em bytes. Com `foco` é a 2ª tentativa: páginas em mais resolução
    e pedido dirigido ao que não fechou."""
    base = WORK / re.sub(r"[^A-Za-z0-9_.-]", "_", nome)
    try:
        imagens = renderizar(pdf_bytes, base, dpi=DPI_SEGUNDA if foco else DPI)
    except Exception as e:  # noqa: BLE001
        return None, None, f"não renderizou: {e}"
    if not imagens:
        return None, None, "PDF sem páginas"
    resp, bruto = chamar_openai(imagens, foco) if (motor or MOTOR) == "openai" else chamar_claude(imagens, foco)
    for p in imagens:
        try:
            p.unlink()
        except OSError:
            pass
    if not resp:
        return None, None, f"sem JSON: {bruto[:300]}"
    try:
        val = validar_leitura(resp)
    except Exception as e:  # noqa: BLE001
        return resp, None, f"validação quebrou: {e}"
    return resp, val, None


def foco_anterior(con, fid: int) -> dict | None:
    """Se já houve uma tentativa, o que não fechou nela (blocos + motivos) para dirigir a 2ª leitura."""
    cur = con.cursor(dictionary=True)
    cur.execute("SELECT tentativas, validacao_json, erro FROM FT_LEITURA_VISUAL WHERE id_fatura=%s", (fid,))
    row = cur.fetchone()
    cur.close()
    if not row or not row.get("tentativas"):
        return None
    try:
        val = json.loads(row.get("validacao_json") or "{}")
    except ValueError:
        val = {}
    blocos = [k for k, v in (val.get("blocos") or {}).items() if not v] or ["identificacao", "medicao", "financeiro", "tributos"]
    return {"blocos": blocos, "obs": (val.get("obs") or []) + ([row["erro"]] if row.get("erro") else [])}


def divergencias(con, fid: int, cols: dict, uc_alternativas: list | None = None) -> list[dict]:
    """Colunas já preenchidas na base cujo valor difere do lido e validado — matéria-prima da etapa 4; nada é sobrescrito."""
    nomes = [k for k in cols if k != "medicao_grandezas_json"]
    if not nomes:
        return []
    cur = con.cursor(dictionary=True)
    cur.execute(f"SELECT {', '.join(nomes)} FROM FATURA_DADOS_EXTRAIDOS WHERE id=%s", (fid,))
    atual = cur.fetchone() or {}
    cur.close()
    out = []
    for k in nomes:
        a, l = atual.get(k), cols[k]
        if a in (None, ""):
            continue
        if k in ("codigo_uc", "numero_medidor", "numero_fatura"):
            # formato não é divergência: "585359105940 - DDG" (origem com sufixo) = "5.853.591.059-40"
            sa = re.sub(r"[^0-9A-Za-z]", "", str(a).split(" - ")[0]).upper().lstrip("0")
            candidatos = [str(l)] + (list(uc_alternativas or []) if k == "codigo_uc" else [])
            if sa not in {re.sub(r"[^0-9A-Za-z]", "", c).upper().lstrip("0") for c in candidatos}:
                out.append({"coluna": k, "atual": str(a), "lido": str(l)})
            continue
        if k == "distribuidora":
            # mesma distribuidora com grafia diferente ("ENERGISA SUL/SUDESTE" × "Energisa Sul-Sudeste"): compara pelo catálogo
            ca, _ = _distribuidora(str(a), None)
            cl, _ = _distribuidora(str(l), None)
            comp_a = re.sub(r"[^a-z0-9]", "", normalizar(ca or str(a)))
            comp_l = re.sub(r"[^a-z0-9]", "", normalizar(cl or str(l)))
            # "EQUATORIAL MAR" (origem abrevia) é prefixo de "equatorialmaranhao": mesma distribuidora
            mesma = comp_a == comp_l or (min(len(comp_a), len(comp_l)) >= 8 and (comp_l.startswith(comp_a) or comp_a.startswith(comp_l)))
            if not mesma:
                out.append({"coluna": k, "atual": str(a), "lido": str(l)})
            continue
        if k in ("modalidade_tarifaria", "subgrupo_tarifario", "grupo_tarifario"):
            if normalizar(str(a)) != normalizar(str(l)):
                out.append({"coluna": k, "atual": str(a), "lido": str(l)})
            continue
        an, ln_ = _num(a), _num(l)
        if an is not None and ln_ is not None:
            if abs(an - ln_) > max(0.011, 0.005 * abs(ln_)):
                out.append({"coluna": k, "atual": an, "lido": ln_})
        elif str(a).strip()[:10] != str(l).strip()[:10] and normalizar(str(a)) != normalizar(str(l)):
            out.append({"coluna": k, "atual": str(a), "lido": str(l)})
    return out


def processar(con, row: dict, gravar: bool, motor: str | None = None, modo: str = "visual") -> tuple[str, str]:
    """Devolve (status, detalhe). Detalhe começa com 'claude:' quando a falha foi na chamada da IA (disjuntor).
    modo="confianca": fila de confiança baixa — o modelo é fonte; grava só com outra fonte concordando."""
    global MODELO
    motor = motor or MOTOR
    MODELO = ("openai:" + MODELO_OPENAI) if motor == "openai" else "claude-visual"
    fid = row["id"]
    pdf = None
    try:
        pdf = baixar(row["link_fatura"])
    except Exception as e:  # noqa: BLE001
        gravar_tentativa(con, fid, row.get("uid"), None, None, "erro", f"download: {e}", None, False)
        return "erro", f"download: {e}"
    if not pdf:
        gravar_tentativa(con, fid, row.get("uid"), None, None, "erro", "download vazio / não é PDF", None, False)
        return "erro", "download vazio"
    # "sem texto" na base nem sempre é PDF-imagem (o caminho da Claro não guarda texto_plumber): se o PDF tem
    # camada de texto, não é caso de leitura visual — é do pipeline determinístico (--revalidar). Registra e pula.
    if modo != "confianca" and row.get("validador_gate") != "reprovado" and texto_do_pdf(pdf) >= int(os.environ.get("SURE_VISUAL_MIN_TEXTO", "200")):
        gravar_tentativa(con, fid, row.get("uid"), None, None, "tem_texto", "PDF tem camada de texto: cabe ao pipeline determinístico", None, False)
        return "tem_texto", ""
    foco = foco_anterior(con, fid)
    resp, val, erro = ler_pdf(pdf, f"f{fid}", foco, motor=motor)
    if erro and not val:
        da_ia = erro.startswith("sem JSON") or erro.startswith("timeout") or "falha ao chamar" in erro
        gravar_tentativa(con, fid, row.get("uid"), resp, None, "erro", erro, None, False, conta=not da_ia)
        return "erro", ("claude: " + erro) if da_ia else erro
    status = status_de(val)
    val["tentativa"] = 2 if foco else 1
    try:
        val["divergencias"] = divergencias(con, fid, val["colunas"], val.get("uc_alternativas"))
    except Exception as e:  # noqa: BLE001
        val["divergencias"] = [{"erro": str(e)[:200]}]
    antes, gravadas = ({}, [])
    if motor == "openai":
        val["tokens"] = dict(ULTIMO_USO)
    if modo == "confianca":
        val["campos_baixos"] = row.get("_baixos") or []
        try:
            preencher, conf = integrar_confianca(con, fid, row.get("uid"), val)
            val["preencher"] = preencher
            val["confianca"] = conf
            if gravar:
                if preencher:
                    antes, gravadas = aplicar_colunas(con, fid, preencher)
                    val["colunas_gravadas"] = gravadas
                gravar_confianca(con, fid, conf)
        except Exception as e:  # noqa: BLE001
            val["erro_confianca"] = str(e)[:200]
    elif gravar and status in ("ok", "parcial") and val["colunas"]:
        antes, gravadas = aplicar_colunas(con, fid, val["colunas"])
        val["colunas_gravadas"] = gravadas
    gravar_tentativa(con, fid, row.get("uid"), resp, val, status, None, antes or None, bool(gravadas))
    det = f"{len(val['divergencias'])} divergência(s)" if val["divergencias"] else ""
    if modo == "confianca":
        det += f" baixos={val.get('campos_baixos')} preencher={list((val.get('preencher') or {}).keys())}"
    return status, det.strip()


def integrar_confianca(con, fid: int, uid: str | None, val: dict) -> tuple[dict, dict]:
    """O modelo como fonte "llm" na confiança por campo. Devolve (colunas que podem ser preenchidas, conf atualizada).
    - campo já na base e o modelo concorda → fonte "llm" entra (n + 1);
    - campo vazio na base: preenche só se a origem (sgeeasy) diz o mesmo, ou, na medição, se a leitura do modelo
      fechou na física E bate com item kWh (o nano inventou tributos que fechavam na conta: tributo/total/contratada
      exigem a origem);
    - discorda → divergência "llm" registrada. Nunca grava sozinho."""
    from confirmacao import CAMPOS_ORIGEM, iguais, origem_por_uid, TIPO_COL
    cur = con.cursor(dictionary=True)
    try:
        cur.execute("SELECT confianca_json FROM FATURA_DADOS_EXTRAIDOS WHERE id=%s", (fid,))
        r = cur.fetchone() or {}
    except Exception:  # coluna ainda não existe (antes do deploy da migração): só a origem como outra fonte
        r = {}
    cur.close()
    try:
        conf = json.loads(r.get("confianca_json") or "{}")
    except ValueError:
        conf = {}
    conf.setdefault("n", {}); conf.setdefault("div", {}); conf.setdefault("fontes_llm", [])
    origem = origem_por_uid(uid) if uid else None
    atuais = {d["coluna"]: d for d in (val.get("divergencias") or [])}
    cols = val.get("colunas") or {}
    blocos = val.get("blocos") or {}
    medicao_ok = bool(blocos.get("medicao")) and any("confirmado por item" in o for o in (val.get("obs") or []))
    preencher: dict = {}
    for k, v in cols.items():
        if k == "medicao_grandezas_json" or v in (None, ""):
            continue
        tipo = TIPO_COL.get(k, "num") if k in TIPO_COL else ("data" if k.startswith(("data_", "mes_")) else "num")
        if k in ("distribuidora", "grupo_tarifario", "subgrupo_tarifario", "numero_fatura"):
            tipo = "ident"
        if k in atuais:  # a base tem outro valor: divergência do modelo, nada muda
            conf["div"].setdefault(k, {})["llm"] = str(v)
            continue
        if k in conf["n"]:  # a base tem o mesmo valor (não divergiu): o modelo confirma
            if "llm" not in conf["fontes_llm"]:
                pass
            conf["n"][k] = int(conf["n"][k]) + 1
            if k not in conf["fontes_llm"]:
                conf["fontes_llm"].append(k)
            continue
        # vazio na base: precisa de outra fonte concordando
        col_o = (CAMPOS_ORIGEM.get(k) or (None, None))[0]
        ok_origem = bool(origem) and col_o is not None and iguais(k, CAMPOS_ORIGEM[k][1], v, origem.get(col_o)) is True
        # física + item só sustenta o que a física confere: leituras, constante, consumo e total em kWh (demanda não)
        ok_fisica = medicao_ok and k in ("constante_k", "leit_ant_ativa_ponta", "leit_atu_ativa_ponta", "leit_ant_ativa_fponta",
                                         "leit_atu_ativa_fponta", "consumo_ativo_ponta_kwh", "consumo_ativo_fponta_kwh", "kwh_total")
        if ok_origem or ok_fisica:
            preencher[k] = v
            conf["n"][k] = 2 + (1 if (ok_origem and ok_fisica) else 0)
            conf["fontes_llm"].append(k)
        else:
            conf["div"].setdefault(k, {})["llm"] = str(v) + " (sem outra fonte)"
    return preencher, conf


def gravar_confianca(con, fid: int, conf: dict) -> None:
    cur = con.cursor()
    try:
        cur.execute("UPDATE FATURA_DADOS_EXTRAIDOS SET confianca_json=%s WHERE id=%s", (json.dumps(conf, ensure_ascii=False, default=str), fid))
        con.commit()
    except Exception:
        pass  # coluna ainda não existe
    cur.close()


# ─── comandos ─────────────────────────────────────────────────────────────────
def cmd_rodar(argv: list[str]) -> int:
    if str(AQUI.parent) not in sys.path:
        sys.path.insert(0, str(AQUI.parent))
    import registrar_execucao as reg  # worker/registrar_execucao.py (painel de rotinas)
    teto = int(_arg(argv, "--teto", os.environ.get("SURE_VISUAL_TETO", "300")))
    minutos = int(_arg(argv, "--minutos", os.environ.get("SURE_VISUAL_MAX_MIN", "300")))
    gravar = "--gravar" in argv or os.environ.get("SURE_VISUAL_GRAVAR", "0") == "1"
    ids = [int(a) for a in _args(argv, "--id")]
    fila = _arg(argv, "--fila", "visual")  # visual (sem texto / reprovadas) | confianca (campo-chave com 1 fonte ou divergente)
    motor = _arg(argv, "--motor", MOTOR)
    global MODELO_OPENAI
    MODELO_OPENAI = _arg(argv, "--modelo", MODELO_OPENAI)
    rotina = "llm_confianca" if fila == "confianca" else "leitura_visual"
    reg.ping(rotina)
    con = _con()
    if motor == "openai":  # limite por hora da API paga (SURE_LLM_POR_HORA, padrão 20): desconta o que já rodou na última hora
        por_hora = int(os.environ.get("SURE_LLM_POR_HORA", "20"))
        ja = llm_na_ultima_hora(con)
        if ja >= por_hora and not ids:
            _log(f"limite de {por_hora} leituras por hora já usado ({ja} na última hora)")
            reg.registrar(rotina, 0, f"limite por hora: {ja}/{por_hora} já usados")
            con.close()
            return 0
        teto = min(teto, por_hora - ja) if not ids else teto
    if fila == "confianca" and not ids:
        rows = candidatas_confianca(con, teto)
    else:
        rows = candidatas(con, teto * 3, ids or None)  # sobra para os pulos (tem_texto, download); o teto conta leituras
        if fila == "confianca":
            for r in rows:
                cur = con.cursor(dictionary=True)
                try:
                    cur.execute("SELECT confianca_json FROM FATURA_DADOS_EXTRAIDOS WHERE id=%s", (r["id"],))
                    r["_baixos"] = confianca_baixa((cur.fetchone() or {}).get("confianca_json")) or ["(sem confianca_json)"]
                except Exception:
                    r["_baixos"] = ["(sem confianca_json)"]
                cur.close()
    if not rows:
        _log("nada a ler.")
        reg.registrar(rotina, 0, "nenhuma fatura candidata")
        return 0
    eid = reg.inicio(rotina, f"{len(rows)} fatura(s); motor={motor}; gravar={'sim' if gravar else 'não (só registra)'}")
    fim = time.time() + minutos * 60
    max_seguidos = int(os.environ.get("SURE_VISUAL_MAX_ERROS_SEGUIDOS", "5"))
    cont: dict[str, int] = {}
    seguidos, parado, rc, lidas = 0, "", 0, 0
    for i, row in enumerate(rows, 1):
        if time.time() > fim:
            _log(f"tempo esgotado após {i - 1} fatura(s)")
            break
        if lidas >= teto:
            _log(f"teto de {teto} leituras atingido")
            break
        st, det = processar(con, row, gravar, motor=motor, modo=("confianca" if fila == "confianca" else "visual"))
        cont[st] = cont.get(st, 0) + 1
        if st not in ("tem_texto",) and not det.startswith("download"):
            lidas += 1
        _log(f"{i}/{len(rows)} fatura {row['id']} ({row.get('distribuidora') or '?'}, gate={row.get('validador_gate')}): {st} {det}")
        # limite de 5 h da assinatura ("You've hit your 5-hour limit · resets 2:30pm"): espera o reset e segue,
        # se couber no orçamento de minutos; a fatura volta à fila (o erro da IA não contou tentativa)
        espera = _segundos_ate_reset(det) if det.startswith("claude:") else None
        if espera is not None:
            if time.time() + espera + 60 < fim:
                _log(f"limite de uso da assinatura: dormindo {espera // 60} min até o reset")
                time.sleep(espera + 60)
                seguidos = 0
                continue
            parado = f"parado: limite de uso da assinatura, reset só em {espera // 60} min (fora do orçamento)"
            rc = 1
            _log(parado)
            break
        # disjuntor: a IA falhando seguidamente (sessão expirada, binário, rede) — para a noite em vez de queimar a fila
        seguidos = seguidos + 1 if det.startswith("claude:") else 0
        if seguidos >= max_seguidos:
            parado = f"parado: {seguidos} erros seguidos do claude ({det[8:80]})"
            rc = 1
            _log(parado)
            break
    con.close()
    resumo = ", ".join(f"{k}: {v}" for k, v in sorted(cont.items())) + ("; gravou colunas vazias" if gravar else "; sem gravar (SURE_VISUAL_GRAVAR=0)")
    if parado:
        resumo = parado + "; " + resumo
    reg.fim(eid, rc, resumo)
    _log(resumo)
    return rc


def cmd_ler(argv: list[str]) -> int:
    como_json = "--json" in argv
    pasta_json = _arg(argv, "--pasta-json")  # grava {arquivo, gate, colunas} por PDF → tests/conferir_gabarito.py
    motor = _arg(argv, "--motor", MOTOR)  # --motor openai [--modelo gpt-5.4-nano]
    global MODELO_OPENAI
    MODELO_OPENAI = _arg(argv, "--modelo", MODELO_OPENAI)
    pular = {"--pasta-json": True, "--motor": True, "--modelo": True}
    for i, a in enumerate(argv):
        if a.startswith("--") or (i > 0 and argv[i - 1] in pular):
            continue
        p = Path(a)
        t0 = time.time()
        resp, val, erro = ler_pdf(p.read_bytes(), p.stem, motor=motor)
        if motor == "openai" and ULTIMO_USO:
            print(f"   tokens: entrada {ULTIMO_USO.get('prompt_tokens')} saída {ULTIMO_USO.get('completion_tokens')} ({ULTIMO_USO.get('modelo')})")
        if "--segunda" in argv and (erro or not all((val or {}).get("blocos", {}).values())):
            foco = {"blocos": [k for k, v in ((val or {}).get("blocos") or {}).items() if not v] or ["todos"],
                    "obs": ((val or {}).get("obs") or []) + ([erro] if erro else [])}
            print(f"   2ª leitura ({p.name}): foco {foco['blocos']}")
            resp2, val2, erro2 = ler_pdf(p.read_bytes(), p.stem, foco, motor=motor)
            if val2 and (not val or sum(val2["blocos"].values()) >= sum(val["blocos"].values())):
                resp, val, erro = resp2, val2, erro2
        if pasta_json:
            Path(pasta_json).mkdir(parents=True, exist_ok=True)
            Path(pasta_json, p.stem + ".json").write_text(json.dumps(
                {"arquivo": p.name, "gate": (erro and "erro") or status_de(val), "score": None, "segundos": round(time.time() - t0),
                 "colunas": (val or {}).get("colunas") or {}, "obs": (val or {}).get("obs"), "erro": erro},
                ensure_ascii=False, indent=1, default=str), encoding="utf-8")
        if como_json:
            print(json.dumps({"arquivo": p.name, "resposta": resp, "validacao": val, "erro": erro}, ensure_ascii=False, indent=1, default=str))
            continue
        print(f"== {p.name}: {erro or status_de(val)}")
        if val:
            print("   blocos:", val["blocos"])
            for k, v in val["colunas"].items():
                if k != "medicao_grandezas_json":
                    print(f"   {k} = {v}")
            for o in val["obs"]:
                print("   obs:", o)
    return 0


def cmd_fila() -> int:
    con = _con()
    cur = con.cursor()
    cur.execute(SQL_CANDIDATAS.replace("LIMIT %s", "LIMIT 100000"))
    n = len(cur.fetchall())
    cur.execute("SELECT status, COUNT(*) FROM FT_LEITURA_VISUAL GROUP BY status")
    feitas = dict(cur.fetchall())
    con.close()
    print(f"candidatas: {n}; já lidas: {feitas}")
    return 0


def cmd_tem_texto_ids(argv: list[str]) -> int:
    """Faturas marcadas `tem_texto` (PDF com camada de texto que a base não guardou) → ids da ORIGEM
    (Faturas_Registradas_Cache.id, via uid) num arquivo, para o pdf_pipeline reprocessar com --force.
    uso: tem-texto-ids --saida ids.txt [--limite 300]"""
    import mysql.connector
    from db_env import conexao
    saida = _arg(argv, "--saida", "tem_texto_ids.txt")
    limite = int(_arg(argv, "--limite", os.environ.get("SURE_REPROC_LIMITE", "300")))
    con = _con()
    cur = con.cursor()
    cur.execute("""SELECT v.id_fatura, f.uid FROM FT_LEITURA_VISUAL v JOIN FATURA_DADOS_EXTRAIDOS f ON f.id = v.id_fatura
                    WHERE v.status = 'tem_texto' AND f.uid IS NOT NULL AND f.uid <> '' ORDER BY v.atualizado_em LIMIT %s""", (limite,))
    pares = cur.fetchall()
    con.close()
    if not pares:
        Path(saida).write_text("", encoding="utf-8")
        print("0 fatura(s) tem_texto")
        return 0
    uids = [u for _, u in pares]
    orig = mysql.connector.connect(**conexao("DB_FATURAS", "DB_FATURAS_URL"))
    oc = orig.cursor()
    ids = []
    for i in range(0, len(uids), 500):
        bloco = uids[i:i + 500]
        oc.execute(f"SELECT id FROM Faturas_Registradas_Cache WHERE UID IN ({','.join(['%s'] * len(bloco))})", bloco)
        ids += [r[0] for r in oc.fetchall()]
    orig.close()
    Path(saida).write_text("\n".join(str(i) for i in sorted(set(ids))) + "\n", encoding="utf-8")
    print(f"{len(pares)} fatura(s) tem_texto → {len(set(ids))} id(s) da origem em {saida}")
    return 0


def cmd_tem_texto_marcar(argv: list[str]) -> int:
    """Depois do reprocesso: tem_texto → reprocessada (não volta à fila). uso: tem-texto-marcar [--limite 300]"""
    limite = int(_arg(argv, "--limite", os.environ.get("SURE_REPROC_LIMITE", "300")))
    con = _con()
    cur = con.cursor()
    cur.execute("""UPDATE FT_LEITURA_VISUAL SET status = 'reprocessada', erro = 'PDF com texto: reprocessado pelo pdf_pipeline --force',
                    atualizado_em = NOW() WHERE status = 'tem_texto' ORDER BY atualizado_em LIMIT %s""", (limite,))
    n = cur.rowcount
    con.commit()
    con.close()
    print(f"{n} fatura(s) marcada(s) como reprocessada")
    return 0


def _segundos_ate_reset(det: str) -> int | None:
    """'…hit your 5-hour limit · resets 2:30pm (America/Sao_Paulo)' → segundos até lá (hora local da máquina)."""
    if "limit" not in det or "reset" not in det:
        return None
    m = re.search(r"resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?", det, re.I)
    if not m:
        return 3600
    h, mi, ampm = int(m.group(1)), int(m.group(2) or 0), (m.group(3) or "").lower()
    if ampm == "pm" and h < 12:
        h += 12
    if ampm == "am" and h == 12:
        h = 0
    agora = dt.datetime.now()
    alvo = agora.replace(hour=h % 24, minute=mi, second=0, microsecond=0)
    if alvo <= agora:
        if (agora - alvo) < dt.timedelta(hours=6):
            return 0  # o reset já passou (a mensagem é de antes dele): segue em frente
        alvo += dt.timedelta(days=1)
    return int((alvo - agora).total_seconds())


def _arg(argv, nome, default=None):
    return argv[argv.index(nome) + 1] if nome in argv and argv.index(nome) + 1 < len(argv) else default


def _args(argv, nome):
    out, i = [], 0
    while i < len(argv):
        if argv[i] == nome and i + 1 < len(argv):
            out.append(argv[i + 1]); i += 2
        else:
            i += 1
    return out


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd, resto = argv[0], argv[1:]
    if cmd == "rodar":
        return cmd_rodar(resto)
    if cmd == "ler":
        return cmd_ler(resto)
    if cmd == "fila":
        return cmd_fila()
    if cmd == "tem-texto-ids":
        return cmd_tem_texto_ids(resto)
    if cmd == "tem-texto-marcar":
        return cmd_tem_texto_marcar(resto)
    if cmd == "desfazer":
        con = _con()
        n = desfazer(con, int(resto[0]))
        con.close()
        print(f"{n} coluna(s) restaurada(s)")
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    os.environ.setdefault("SKIP_SEFAZ", "1")
    os.environ.setdefault("PDF_PIPELINE_NO_OCR", "1")
    sys.exit(main(sys.argv[1:]))
