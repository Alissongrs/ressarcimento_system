# -*- coding: utf-8 -*-
"""Extrai as faturas Claro de uma pasta de PDFs → FATURA_CLARO_DADOS_EXTRAIDOS (roda no container do backend).

Versão para a VPS de ia/OCR_claro/_run_claro.py (o que rodava no PC em C:\\claro_bf). Mesma extração, linha a
linha (_classificar / _processar_um / colunas / INSERT IGNORE); mudou só o que dependia do PC:
- conexão pelo DB_APP_URL do ambiente do container (sem arquivo com senha);
- "já feitos" olha só as linhas mais novas (janela por id) em vez de carregar a tabela inteira na memória;
- duplicata por uid é contada pelo próprio INSERT IGNORE (uid é UNIQUE no banco).
- uid = SHA-256 dos bytes do PDF; tipo fatura|termo|scaneada|outro; motor F01-F05 NÃO roda aqui.

Uso (dentro do container): python /app/claro/extrair_claro.py --dir /app/claro_fila/ex/<seq> [--workers 3]
Imprime "processadas: N | inseridas: N | duplicatas(uid): N | erros: N" (o processar.py lê essa linha).
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor

AQUI = os.path.dirname(os.path.abspath(__file__))
# backend/claro primeiro (extrator_v2 e _fase1_pipeline da Claro), depois o pacote ocr_prod da imagem
# (extrator_complementar, validadores, detector de layout…, todos importados sob try no extrator_v2).
for _p in (os.environ.get("CLARO_OCR_DIR", "/app/ocr_prod"), AQUI):
    while _p in sys.path:
        sys.path.remove(_p)
    sys.path.insert(0, _p)  # AQUI fica em 1º, sempre (o ocr_prod tem um _fase1_pipeline/extrator_v2 mais antigo)
# o FASE1_LLM=1 da imagem liga o gpt-4.1-mini no _fase1_pipeline; a extração da Claro nunca usou
os.environ.pop("FASE1_LLM", None)
os.environ.pop("FASE1_COORD", None)
os.environ["SKIP_SEFAZ"] = "1"

JANELA_IDS = 400000


class _CursorEnsaio:
    """CLARO_ENSAIO=1: finge o banco (não lê nem grava nada) — para testar a fila sem tocar na produção."""
    rowcount = 0

    def execute(self, *a):
        self.rowcount = 0

    def executemany(self, sql, vals):
        self.rowcount = len(vals)

    def fetchone(self):
        return (0,)

    def fetchall(self):
        return []


class _ConexaoEnsaio:
    def cursor(self):
        return _CursorEnsaio()

    def ping(self, reconnect=True):
        pass

    def commit(self):
        pass

    def close(self):
        pass


def conectar():
    """Conexão pelo DB_APP_URL (formato Go: user:senha@tcp(host:porta)/banco?params). Não imprime nada dele."""
    if os.environ.get("CLARO_ENSAIO") == "1":
        return _ConexaoEnsaio()
    url = os.environ.get("DB_APP_URL", "")
    if not url:
        raise SystemExit("DB_APP_URL não está no ambiente")
    cred, resto = url.rsplit("@", 1)
    user, pw = cred.split(":", 1)
    m = re.match(r"tcp\(([^:)]+):?(\d*)\)/([^?]+)", resto)
    if not m:
        raise SystemExit("DB_APP_URL em formato inesperado")
    host, port, db = m.groups()
    try:
        import pymysql
        return pymysql.connect(host=host, port=int(port or 3306), user=user, password=pw, database=db,
                               charset="utf8mb4", autocommit=False, connect_timeout=20)
    except ImportError:
        import mysql.connector
        return mysql.connector.connect(host=host, port=int(port or 3306), user=user, password=pw, database=db,
                                       charset="utf8mb4", use_pure=True, autocommit=False, connection_timeout=20)


# --- worker (import pesado 1× por processo via initializer) ---
_W = {}


def _init():
    os.environ["SKIP_SEFAZ"] = "1"
    import fitz  # noqa: F401  (o _run_claro original carregava; mantém o mesmo ambiente do extrator)
    from texto_pdf import extrair_plumber
    from extrator_v2 import FaturaExtractorV2
    import _fase1_pipeline as F
    FaturaExtractorV2.carregar_mapas()
    _W.update(extrair_plumber=extrair_plumber, V2=FaturaExtractorV2, F=F)


def _classificar(texto_up):
    if len(texto_up.strip()) < 300:
        return "scaneada"
    # marcadores FORTES de fatura (o TERMO também diz "Nota Fiscal de Energia Elétrica")
    tem_fatura = (("TOTAL A PAGAR" in texto_up or "VALOR A PAGAR" in texto_up)
                  and ("KWH" in texto_up or "MEDIDOR" in texto_up or "CONSUMO" in texto_up)) \
        or "DANF3E" in texto_up
    if not tem_fatura and "TERMO DE ADES" in texto_up:
        return "termo"
    if tem_fatura:
        return "fatura"
    return "outro"


def _num(x):
    try:
        return float(x)
    except Exception:
        return None


def _processar_um(path):
    F = _W["F"]
    try:
        b = open(path, "rb").read()
        uid = hashlib.sha256(b).hexdigest()
        r = {"uid": uid, "arquivo_origem": os.path.basename(path), "status": "ok", "erro": None}
        texto, _ = _W["extrair_plumber"](b)
        tipo = _classificar(texto.upper())
        r["tipo"] = tipo
        if tipo in ("termo", "scaneada"):
            return r  # não extrai; registra o tipo p/ estatística/dedup
        v2 = _W["V2"](texto=texto[:80000], conn=None)
        v2.pdf_path = path
        out = v2.extrair_tudo() or {}
        C, itens = F.coletar_candidatos(out, texto, "")
        n = F.normalizar(C, itens, texto)
        dados = F.dados_ricos(out)
        cad = dados.get("cadastro", {})
        doc = dados.get("documento", {})
        r.update(
            distribuidora=n.get("distribuidora"),
            numero_instalacao=cad.get("numero_instalacao"),
            codigo_uc=cad.get("codigo_uc"),
            mes_referencia=(doc.get("mes_referencia") or doc.get("competencia") or doc.get("vencimento") or "")[:10] or None,
            nome_cliente=(cad.get("razao_social") or cad.get("nome_cliente") or "")[:255] or None,
            cnpj_cliente=(cad.get("cnpj_cliente") or cad.get("cnpj") or cad.get("cpf_cnpj") or "")[:24] or None,
            consumo_kwh=_num(n.get("consumo")),
            valor_total=_num(n.get("valor_total")),
            numero_medidor=(str(n.get("medidor")) if n.get("medidor") else None),
            leit_anterior=_num(n.get("leit_ant")),
            leit_atual=_num(n.get("leit_atu")),
            constante=_num(n.get("constante")),
            gd=1 if n.get("gd") else 0,
            soma_bate_total=(None if n.get("_soma_bate_total") is None else (1 if n.get("_soma_bate_total") else 0)),
            gap_pct=_num(n.get("_gap_pct")),
            fichas="",  # motor F01-F05 é passo separado (série por UC)
            n_itens=len(itens),
            dados_json=json.dumps(dados, ensure_ascii=False)[:1000000],
            itens_json=json.dumps(F.itens_limpos(out), ensure_ascii=False)[:1000000],
        )
        return r
    except Exception as e:
        return {"uid": hashlib.sha256(open(path, "rb").read()).hexdigest() if os.path.exists(path) else path,
                "arquivo_origem": os.path.basename(path), "tipo": "outro", "status": "erro", "erro": str(e)[:300]}


COLS = ["uid", "arquivo_origem", "tipo", "distribuidora", "numero_instalacao", "codigo_uc", "mes_referencia",
        "nome_cliente", "cnpj_cliente", "consumo_kwh", "valor_total", "numero_medidor", "leit_anterior",
        "leit_atual", "constante", "gd", "soma_bate_total", "gap_pct", "fichas", "n_itens", "dados_json", "itens_json",
        "status", "erro"]


def _insert(cu, rows):
    if not rows:
        return 0
    ph = ",".join(["%s"] * len(COLS))
    sql = f"INSERT IGNORE INTO FATURA_CLARO_DADOS_EXTRAIDOS ({','.join(COLS)},processado_em) VALUES ({ph},NOW())"
    cu.executemany(sql, [tuple(r.get(c) for c in COLS) for r in rows])
    return cu.rowcount


def _flush(cx, cu, rows):
    """Insere+commita com resiliência (a RDS derruba conexão longa): reconecta e tenta de novo."""
    if not rows:
        return 0, cx, cu
    for tent in range(4):
        try:
            cx.ping(reconnect=True) if hasattr(cx, "ping") else None
            n = _insert(cu, rows)
            cx.commit()
            return n, cx, cu
        except Exception as e:
            print(f"  [db] conexão caiu ({str(e)[:70]}), reconectando (tent {tent + 1}/4)...", flush=True)
            try:
                cx.close()
            except Exception:
                pass
            time.sleep(3)
            try:
                cx = conectar()
                cu = cx.cursor()
            except Exception:
                pass
    print("  [db] lote perdido após 4 reconexões (será re-extraído no próximo resume)", flush=True)
    return 0, cx, cu


def arquivos_ja_gravados(cu, nomes):
    """Nomes de PDF deste lote que já estão na tabela (resume sem reler o disco). Só a janela das linhas novas."""
    if not nomes:
        return set()
    cu.execute("SELECT MAX(id) FROM FATURA_CLARO_DADOS_EXTRAIDOS")
    mx = cu.fetchone()[0] or 0
    cu.execute("SELECT arquivo_origem FROM FATURA_CLARO_DADOS_EXTRAIDOS WHERE id > %s AND arquivo_origem IS NOT NULL",
               (mx - JANELA_IDS,))
    alvo = set(nomes)
    return {r[0] for r in cu.fetchall() if r[0] in alvo}


def workers_padrao():
    v = os.environ.get("CLARO_WORKERS")
    if v and v.isdigit() and int(v) > 0:
        return int(v)
    # deixa CPU para o backend e o site: no máximo 3, e sempre 1 núcleo livre
    return max(1, min(3, (os.cpu_count() or 2) - 1))


def extrair_pasta(pasta, workers=None):
    t0 = time.time()
    arqs = sorted(e.path for e in os.scandir(pasta) if e.name.lower().endswith(".pdf"))
    total_dir = len(arqs)
    workers = workers or workers_padrao()
    cx = conectar()
    cu = cx.cursor()
    ja_arq = arquivos_ja_gravados(cu, [os.path.basename(a) for a in arqs])
    arqs = [a for a in arqs if os.path.basename(a) not in ja_arq]
    print(f"arquivos na pasta: {total_dir} | já na tabela: {len(ja_arq)} | processar: {len(arqs)} | workers: {workers}",
          flush=True)

    tipos = Counter()
    ins = err = proc = enviados = 0
    buf = []
    if arqs:
        with ProcessPoolExecutor(max_workers=workers, initializer=_init) as ex:
            for r in ex.map(_processar_um, arqs, chunksize=8):
                proc += 1
                tipos[r.get("tipo", "?")] += 1
                if r.get("status") == "erro":
                    err += 1
                buf.append(r)
                if len(buf) >= 200:
                    enviados += len(buf)
                    n, cx, cu = _flush(cx, cu, buf)
                    ins += n
                    buf = []
                if proc % 500 == 0:
                    dt = time.time() - t0
                    print(f"  ...{proc}/{len(arqs)} | inseridas={ins} err={err} | {dt:.0f}s | {proc / dt:.1f}/s", flush=True)
    enviados += len(buf)
    n, cx, cu = _flush(cx, cu, buf)
    ins += n
    try:
        cx.close()
    except Exception:
        pass
    dt = time.time() - t0
    dup = max(0, enviados - ins)
    print(f"\n=== FIM ({dt:.0f}s, {proc / max(1, dt):.1f} faturas/s) ===")
    print(f"processadas: {proc} | inseridas: {ins} | duplicatas(uid): {dup} | erros: {err}")
    print("tipos:", dict(tipos), flush=True)
    return {"pdfs": total_dir, "processadas": proc, "inseridas": ins, "duplicatas": dup, "erros": err,
            "tipos": dict(tipos), "segundos": round(dt)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--workers", type=int, default=0)
    a = ap.parse_args()
    extrair_pasta(a.dir, a.workers or None)


if __name__ == "__main__":
    main()
