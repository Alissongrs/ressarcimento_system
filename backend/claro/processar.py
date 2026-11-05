# -*- coding: utf-8 -*-
"""Fila dos lotes (zips) da Claro na VPS — roda no container do backend, chamado pelo worker/job_claro.sh.

O backend (handlers/claro_fila_handler.go) baixa cada zip do portal PDP para CLARO_FILA_DIR (/app/claro_fila,
pasta worker/claro_fila no host) e marca <zip>.rdy. Este script faz as partes que precisam do banco e do
extrator; o upload para o Google Drive é feito pelo rclone do host, entre os dois passos:

  python processar.py preparar        → pega o lote mais antigo, descompacta em ex/<seq>, extrai p/ o banco e
                                        imprime "LOTE <seq> <pasta relativa à fila>" (ou "NADA")
  (host) rclone copy <pasta> <remote>/sp_<seq>  +  rclone lsf … > mapa_sp_<seq>.txt
  python processar.py concluir <seq>  → grava os links do Drive (só onde link IS NULL), apaga zip e PDFs e
                                        marca done/<seq>

Um lote extraído e ainda não concluído (ex/<seq>.json) é devolvido de novo pelo "preparar" — se o host cair no
meio do upload, o próximo minuto continua de onde parou, sem extrair duas vezes.
Mesmo fluxo do ferramentas/claro_pdp/consumer_claro.py (PC), que continua lá como reserva.
"""
import glob
import json
import os
import re
import shutil
import sys
import time
import zipfile

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)

ROOT = os.environ.get("CLARO_FILA_DIR", "/app/claro_fila")
DONE = os.path.join(ROOT, "done")
FAILED = os.path.join(ROOT, "failed")
EXD = os.path.join(ROOT, "ex")
LOG = os.path.join(ROOT, "claro.log")
RE_SEQ = re.compile(r"_(\d{6,})\.zip$")


def log(m):
    line = f"[{time.strftime('%d/%m %H:%M:%S')}] {m}"
    print(line, flush=True)
    try:
        novo = not os.path.exists(LOG)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        if novo:
            os.chmod(LOG, 0o666)  # o host também escreve neste log
    except Exception:
        pass


def _dirs():
    for d in (DONE, FAILED, EXD):
        os.makedirs(d, exist_ok=True)
        try:
            os.chmod(d, 0o777)
        except Exception:
            pass


def seq_of(nome):
    m = RE_SEQ.search(nome)
    return m.group(1) if m else nome.replace(".zip", "")


def _estado(seq):
    return os.path.join(EXD, seq + ".json")


def _remover(*caminhos):
    for x in caminhos:
        try:
            if os.path.isdir(x):
                shutil.rmtree(x, ignore_errors=True)
            elif os.path.exists(x):
                os.remove(x)
        except Exception:
            pass


def pendente_de_upload():
    """Lote já extraído esperando o upload/links (o host caiu no meio)."""
    for e in sorted(glob.glob(os.path.join(EXD, "*.json"))):
        try:
            st = json.load(open(e, encoding="utf-8"))
            if st.get("etapa") == "extraido" and os.path.isdir(os.path.join(ROOT, st["alvo"])):
                return st
        except Exception:
            continue
    return None


def preparar():
    _dirs()
    st = pendente_de_upload()
    if st:
        log(f"{st['zip']}: retomando (já extraído, falta o Drive)")
        print(f"LOTE {st['seq']} {st['alvo']}")
        return
    # .busy de uma rodada que morreu no meio da extração → volta para a fila (o job tem trava; não há outra rodando)
    for b in glob.glob(os.path.join(ROOT, "*.zip.rdy.busy")):
        try:
            os.rename(b, b[:-5])
        except Exception:
            pass
    rdys = sorted(glob.glob(os.path.join(ROOT, "*.zip.rdy")), key=lambda p: seq_of(os.path.basename(p)[:-4]))
    if not rdys:
        print("NADA")
        return
    rdy = rdys[0]
    zippath = rdy[:-4]
    nome = os.path.basename(zippath)
    seq = seq_of(nome)
    busy = rdy + ".busy"
    os.rename(rdy, busy)
    if os.path.exists(os.path.join(DONE, seq)):
        log(f"{nome}: lote {seq} já processado antes — descartando a cópia")
        _remover(zippath, busy)
        print("NADA")
        return
    try:
        esp = int(open(busy).read().strip())
    except Exception:
        esp = -1
    real = os.path.getsize(zippath) if os.path.exists(zippath) else -1
    if esp >= 0 and real != esp:
        log(f"{nome}: tamanho diferente do esperado (esperado={esp} disco={real}) → falhou, baixe de novo")
        _remover(busy)
        _falhou(zippath, seq, "tamanho")
        print("NADA")
        return
    ex = os.path.join(EXD, seq)
    _remover(ex)
    os.makedirs(ex, exist_ok=True)
    try:
        with zipfile.ZipFile(zippath) as zf:
            if zf.testzip() is not None:
                raise Exception("zip corrompido (testzip)")
            npdf = len([n for n in zf.namelist() if n.lower().endswith(".pdf")])
            zf.extractall(ex)
    except Exception as e:
        log(f"{nome}: erro ao descompactar ({str(e)[:80]}) → falhou")
        _remover(busy, ex)
        _falhou(zippath, seq, "unzip")
        print("NADA")
        return
    alvo = ex
    if not glob.glob(os.path.join(ex, "*.pdf")):
        for d in sorted(d for d in glob.glob(os.path.join(ex, "*")) if os.path.isdir(d)):
            if glob.glob(os.path.join(d, "*.pdf")):
                alvo = d
                break
    log(f"{nome}: {npdf} PDFs — extraindo para o banco")
    res = {}
    try:
        from extrair_claro import extrair_pasta
        res = extrair_pasta(alvo)
        log(f"{nome}: extraiu pdfs={npdf} inseridas={res.get('inseridas')} dup={res.get('duplicatas')} "
            f"erros={res.get('erros')} em {res.get('segundos')}s")
    except Exception as e:
        # (ex.: banco fora do ar) devolve o zip para a fila e tenta de novo na próxima rodada; na 3ª falha desiste
        tent_f = zippath + ".tentativas"
        try:
            tent = int(open(tent_f).read().strip()) + 1
        except Exception:
            tent = 1
        _remover(ex)
        if tent >= 3:
            log(f"{nome}: erro no extrator pela {tent}ª vez ({str(e)[:160]}) → falhou")
            _remover(busy, tent_f)
            _falhou(zippath, seq, "extrator")
        else:
            log(f"{nome}: erro no extrator ({str(e)[:160]}) — tento de novo na próxima rodada ({tent}/3)")
            open(tent_f, "w").write(str(tent))
            os.rename(busy, rdy)
        print("NADA")
        return
    _remover(zippath + ".tentativas")
    rel = os.path.relpath(alvo, ROOT).replace(os.sep, "/")
    st = {"etapa": "extraido", "seq": seq, "zip": nome, "alvo": rel, "pdfs": npdf, "extracao": res,
          "em": time.strftime("%Y-%m-%d %H:%M:%S")}
    json.dump(st, open(_estado(seq), "w", encoding="utf-8"), ensure_ascii=False)
    # o zip já não é necessário (os PDFs estão em ex/<seq>); libera o disco antes do upload
    _remover(zippath, busy)
    print(f"LOTE {seq} {rel}")


def _falhou(zippath, seq, motivo):
    try:
        if os.path.exists(zippath):
            shutil.move(zippath, os.path.join(FAILED, os.path.basename(zippath)))
    except Exception:
        _remover(zippath)
    open(os.path.join(DONE, seq + ".FAIL"), "w").write(motivo)


def aplicar_links(mapa):
    """Mesmo critério do ferramentas/claro_pdp/claro_link_od.py: casa pelo nome do PDF, só onde link IS NULL."""
    from extrair_claro import JANELA_IDS, conectar
    ids = {}
    for ln in open(mapa, encoding="utf-8", errors="ignore"):
        ln = ln.strip()
        if "|" not in ln:
            continue
        gid, caminho = ln.split("|", 1)
        nm = os.path.basename(caminho)
        if gid and nm.lower().endswith(".pdf"):
            ids[nm] = gid
    if not ids:
        return 0, 0
    cn = conectar()
    try:
        cur = cn.cursor()
        cur.execute("SELECT MAX(id) FROM FATURA_CLARO_DADOS_EXTRAIDOS")
        mx = cur.fetchone()[0] or 0
        cur.execute("SELECT id, arquivo_origem FROM FATURA_CLARO_DADOS_EXTRAIDOS WHERE id > %s AND link IS NULL",
                    (mx - JANELA_IDS,))
        alvo = [(i, a) for i, a in cur.fetchall() if a in ids]
        n = 0
        for k in range(0, len(alvo), 500):
            lote = alvo[k:k + 500]
            cur.executemany("UPDATE FATURA_CLARO_DADOS_EXTRAIDOS SET link=%s WHERE id=%s AND link IS NULL",
                            [(f"https://drive.google.com/file/d/{ids[a]}/view", i) for i, a in lote])
            n += cur.rowcount
            cn.commit()
        return len(ids), n
    finally:
        cn.close()


def concluir(seq):
    _dirs()
    est = _estado(seq)
    if not os.path.exists(est):
        print(f"ERRO lote {seq} não está preparado")
        return
    st = json.load(open(est, encoding="utf-8"))
    mapa = os.path.join(ROOT, f"mapa_sp_{seq}.txt")
    no_drive = links = 0
    if os.path.exists(mapa):
        try:
            no_drive, links = aplicar_links(mapa)
        except Exception as e:
            log(f"{st['zip']}: erro ao gravar os links ({str(e)[:120]}) — tente de novo")
            print("ERRO links")
            return
    else:
        log(f"{st['zip']}: sem o mapa do Drive — links não gravados")
    ext = st.get("extracao") or {}
    log(f"{st['zip']}: no Drive={no_drive} links gravados={links} — lote concluído")
    open(os.path.join(DONE, seq), "w").write(
        f"pdfs={st.get('pdfs')} inseridas={ext.get('inseridas')} drive={no_drive} links={links} em={time.strftime('%Y-%m-%d %H:%M:%S')}")
    _remover(os.path.join(EXD, seq), est, mapa)
    print(f"OK {seq} links={links}")


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "preparar":
        preparar()
    elif len(sys.argv) >= 3 and sys.argv[1] == "concluir":
        concluir(sys.argv[2])
    else:
        raise SystemExit(__doc__)
