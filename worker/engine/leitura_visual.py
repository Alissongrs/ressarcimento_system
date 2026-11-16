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


def renderizar(pdf_bytes: bytes, base: Path, max_paginas: int = MAX_PAGINAS) -> list[Path]:
    import fitz
    base.parent.mkdir(parents=True, exist_ok=True)
    d = fitz.open(stream=pdf_bytes, filetype="pdf")
    out = []
    for i, pg in enumerate(d):
        if i >= max_paginas:
            break
        p = base.with_name(f"{base.name}_p{i + 1}.png")
        pg.get_pixmap(dpi=DPI).save(str(p))
        out.append(p)
    return out


def chamar_claude(imagens: list[Path]) -> tuple[dict | None, str]:
    """Uma chamada `claude -p` por fatura; só a ferramenta Read. Devolve (json, saída bruta)."""
    prompt = PROMPT + "\n".join(f"- {p.resolve()}" for p in imagens) + "\n"
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
            for a in [d.get("nome", "")] + list(d.get("aliases") or []):
                if a and normalizar(a) and normalizar(a) in n:
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
        if conf and all(r.ok for r in conf):
            blocos["medicao"] = True
            fator = 1 + (perda or 0) / 100 if origem in ("linha",) else 1.0
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
            if cp is not None:
                cols["consumo_ativo_ponta_kwh"] = _r3(cp)
            if cfp is not None:
                cols["consumo_ativo_fponta_kwh"] = _r3(cfp)
            if cp is not None or cfp is not None:
                cols["kwh_total"] = _r3((cp or 0) + (cfp or 0) + (por_posto.get("reservado") or 0) * 1.0)
            cols["medicao_grandezas_json"] = json.dumps([r.dict() for r in regs], ensure_ascii=False)
            # consumo confirmado por um item kWh? (reforço, não condição)
            qs = [_num(i.get("quantidade")) for i in itens if str(i.get("unidade") or "").lower().startswith("kwh")]
            for alvo in (cp, cfp):
                if alvo and any(q and abs(q - alvo) <= max(0.02, 0.003 * alvo) for q in qs):
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

    cols = {k: v for k, v in cols.items() if v is not None}
    if tipo != "fatura":  # rateio, nota de comercializadora, outro: não é fatura de distribuidora — nada a gravar
        blocos = {k: False for k in blocos}
        cols = {}
    return {"blocos": blocos, "colunas": cols, "obs": obs, "tipo_documento": tipo}


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
   AND (f.texto_plumber IS NULL OR LENGTH(f.texto_plumber) < 200 OR f.validador_gate = 'reprovado')
   AND (v.id_fatura IS NULL OR (v.status NOT IN ('ok','humano','outro') AND v.tentativas < 2))
 ORDER BY (f.texto_plumber IS NULL OR LENGTH(f.texto_plumber) < 200) DESC, f.mes_referencia DESC, f.id DESC
 LIMIT %s"""


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
                     antes: dict | None, gravado: bool) -> None:
    cur = con.cursor()
    cur.execute("""INSERT INTO FT_LEITURA_VISUAL (id_fatura, uid, tentativas, status, modelo, resposta_json, validacao_json,
                     colunas_json, antes_json, gravado, erro, criado_em, atualizado_em)
                   VALUES (%s, %s, 1, %s, %s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
                   ON DUPLICATE KEY UPDATE tentativas = tentativas + 1, status = VALUES(status), modelo = VALUES(modelo),
                     resposta_json = VALUES(resposta_json), validacao_json = VALUES(validacao_json),
                     colunas_json = VALUES(colunas_json), antes_json = COALESCE(VALUES(antes_json), antes_json),
                     gravado = gravado OR VALUES(gravado), erro = VALUES(erro), atualizado_em = NOW()""",
                (fid, uid, status, MODELO, json.dumps(resp, ensure_ascii=False) if resp else None,
                 json.dumps(val, ensure_ascii=False, default=str) if val else None,
                 json.dumps(val["colunas"], ensure_ascii=False, default=str) if val else None,
                 json.dumps(antes, ensure_ascii=False, default=str) if antes else None, 1 if gravado else 0,
                 (erro or "")[:500] or None))
    # 2ª falha → humano
    cur.execute("UPDATE FT_LEITURA_VISUAL SET status='humano' WHERE id_fatura=%s AND status IN ('falhou','parcial','erro') AND tentativas >= 2", (fid,))
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
def ler_pdf(pdf_bytes: bytes, nome: str) -> tuple[dict | None, dict | None, str | None]:
    """(resposta, validação, erro) de um PDF em bytes."""
    base = WORK / re.sub(r"[^A-Za-z0-9_.-]", "_", nome)
    try:
        imagens = renderizar(pdf_bytes, base)
    except Exception as e:  # noqa: BLE001
        return None, None, f"não renderizou: {e}"
    if not imagens:
        return None, None, "PDF sem páginas"
    resp, bruto = chamar_claude(imagens)
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


def processar(con, row: dict, gravar: bool) -> str:
    fid = row["id"]
    pdf = None
    try:
        pdf = baixar(row["link_fatura"])
    except Exception as e:  # noqa: BLE001
        gravar_tentativa(con, fid, row.get("uid"), None, None, "erro", f"download: {e}", None, False)
        return "erro"
    if not pdf:
        gravar_tentativa(con, fid, row.get("uid"), None, None, "erro", "download vazio / não é PDF", None, False)
        return "erro"
    resp, val, erro = ler_pdf(pdf, f"f{fid}")
    if erro and not val:
        gravar_tentativa(con, fid, row.get("uid"), resp, None, "erro", erro, None, False)
        return "erro"
    status = status_de(val)
    antes, gravadas = ({}, [])
    if gravar and status in ("ok", "parcial") and val["colunas"]:
        antes, gravadas = aplicar_colunas(con, fid, val["colunas"])
        val["colunas_gravadas"] = gravadas
    gravar_tentativa(con, fid, row.get("uid"), resp, val, status, None, antes or None, bool(gravadas))
    return status


# ─── comandos ─────────────────────────────────────────────────────────────────
def cmd_rodar(argv: list[str]) -> int:
    if str(AQUI.parent) not in sys.path:
        sys.path.insert(0, str(AQUI.parent))
    import registrar_execucao as reg  # worker/registrar_execucao.py (painel de rotinas)
    teto = int(_arg(argv, "--teto", os.environ.get("SURE_VISUAL_TETO", "300")))
    minutos = int(_arg(argv, "--minutos", os.environ.get("SURE_VISUAL_MAX_MIN", "300")))
    gravar = "--gravar" in argv or os.environ.get("SURE_VISUAL_GRAVAR", "0") == "1"
    ids = [int(a) for a in _args(argv, "--id")]
    reg.ping("leitura_visual")
    con = _con()
    rows = candidatas(con, teto, ids or None)
    if not rows:
        _log("nada a ler.")
        reg.registrar("leitura_visual", 0, "nenhuma fatura candidata")
        return 0
    eid = reg.inicio("leitura_visual", f"{len(rows)} fatura(s); gravar={'sim' if gravar else 'não (só registra)'}")
    fim = time.time() + minutos * 60
    cont: dict[str, int] = {}
    for i, row in enumerate(rows, 1):
        if time.time() > fim:
            _log(f"tempo esgotado após {i - 1} fatura(s)")
            break
        st = processar(con, row, gravar)
        cont[st] = cont.get(st, 0) + 1
        _log(f"{i}/{len(rows)} fatura {row['id']} ({row.get('distribuidora') or '?'}, gate={row.get('validador_gate')}): {st}")
    con.close()
    resumo = ", ".join(f"{k}: {v}" for k, v in sorted(cont.items())) + ("; gravou colunas vazias" if gravar else "; sem gravar (SURE_VISUAL_GRAVAR=0)")
    reg.fim(eid, 0, resumo)
    _log(resumo)
    return 0


def cmd_ler(argv: list[str]) -> int:
    como_json = "--json" in argv
    pasta_json = _arg(argv, "--pasta-json")  # grava {arquivo, gate, colunas} por PDF → tests/conferir_gabarito.py
    pular = {"--pasta-json": True}
    for i, a in enumerate(argv):
        if a.startswith("--") or (i > 0 and argv[i - 1] in pular):
            continue
        p = Path(a)
        t0 = time.time()
        resp, val, erro = ler_pdf(p.read_bytes(), p.stem)
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
