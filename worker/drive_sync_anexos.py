#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
drive_sync_anexos.py — sobe os ANEXOS dos pedidos (arquivos gerados nas conversas) para o
Google Drive via rclone e grava o link público em FT_SOLICITACOES_ANEXOS.drive_link.

Roda no HOST da VPS (onde o rclone está instalado e o remote 'gdrive' autenticado), pelo cron.
Pega os anexos sem drive_link, escreve o blob num arquivo temporário, faz
`rclone copyto <tmp> gdrive:SURE/anexos/<id>_<nome>` e `rclone link ...` (link "qualquer um com
o link"), e salva o link. Não imprime credenciais.

Env (opcionais):
  SURE_RCLONE_REMOTE  (default 'gdrive')     — nome do remote do rclone
  SURE_DRIVE_DIR      (default 'SURE/anexos') — pasta base no Drive
  SURE_RCLONE_BIN     (default 'rclone')
  SURE_DRIVE_LOTE     (default '20')          — máx. de anexos por rodada
Uso (cron):  python3 worker/drive_sync_anexos.py
"""
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from has_work import ler_dsn  # noqa: E402

RCLONE = os.environ.get("SURE_RCLONE_BIN", "rclone")
REMOTE = os.environ.get("SURE_RCLONE_REMOTE", "gdrive")
DRIVE_DIR = os.environ.get("SURE_DRIVE_DIR", "SURE/anexos").strip("/")
LOTE = int(os.environ.get("SURE_DRIVE_LOTE", "20"))
# retenção: depois de N dias o arquivo é apagado do Drive E do banco (o pedido/resultado fica;
# o anexo some e precisa ser gerado de novo).
DIAS_RETENCAO = int(os.environ.get("SURE_DRIVE_DIAS", "20"))


def conectar():
    import pymysql
    u, p, h, port, db = ler_dsn()
    return pymysql.connect(host=h, port=port, user=u, password=p, database=db, charset="utf8mb4",
                           connect_timeout=15, read_timeout=120, write_timeout=120, autocommit=False)


def rclone(*args, timeout=600):
    return subprocess.run([RCLONE, *args], capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=timeout)


def sanitizar(nome):
    nome = re.sub(r'[\\/:*?"<>|]+', "_", nome or "arquivo").strip()
    return nome[:150] or "arquivo"


def subir_um(cur, aid, idsol, nome, conteudo):
    destino_nome = "%d_%s" % (aid, sanitizar(nome))
    remoto = "%s:%s/%s" % (REMOTE, DRIVE_DIR, destino_nome)
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(prefix="sure_drive_", suffix="_" + sanitizar(nome))
        with os.fdopen(fd, "wb") as f:
            f.write(conteudo)
        up = rclone("copyto", tmp, remoto)
        if up.returncode != 0:
            print("  [#%s anexo %s] upload falhou: %s" % (idsol, aid, (up.stderr or "")[-200:]), file=sys.stderr)
            return False
        ln = rclone("link", remoto)
        link = (ln.stdout or "").strip().splitlines()[-1].strip() if ln.returncode == 0 and ln.stdout.strip() else ""
        if not link:
            print("  [#%s anexo %s] link falhou: %s" % (idsol, aid, (ln.stderr or "")[-200:]), file=sys.stderr)
            return False
        cur.execute("UPDATE FT_SOLICITACOES_ANEXOS SET drive_link=%s, drive_path=%s WHERE id=%s",
                    (link[:512], ("%s/%s" % (DRIVE_DIR, destino_nome))[:512], aid))
        print("  [#%s anexo %s] OK -> %s" % (idsol, aid, link))
        return True
    except subprocess.TimeoutExpired:
        print("  [#%s anexo %s] timeout no rclone" % (idsol, aid), file=sys.stderr)
        return False
    finally:
        if tmp and os.path.exists(tmp):
            try: os.remove(tmp)
            except OSError: pass


def limpar_antigos(con):
    """Apaga anexos com mais de DIAS_RETENCAO dias: remove do Drive (se tiver) e deleta a linha."""
    with con.cursor() as cur:
        cur.execute("""SELECT id, id_solicitacao, nome, drive_path FROM FT_SOLICITACOES_ANEXOS
                        WHERE criado_em < NOW() - INTERVAL %s DAY
                        ORDER BY id LIMIT 200""", (DIAS_RETENCAO,))
        antigos = cur.fetchall()
    if not antigos:
        return
    print("[drive] expirando %d anexo(s) com mais de %d dias" % (len(antigos), DIAS_RETENCAO))
    n = 0
    for aid, idsol, nome, dpath in antigos:
        if dpath:
            try:
                rclone("deletefile", "%s:%s" % (REMOTE, dpath), timeout=120)  # ignora erro (já pode não existir)
            except Exception:
                pass
        with con.cursor() as cur:
            cur.execute("DELETE FROM FT_SOLICITACOES_ANEXOS WHERE id=%s", (aid,))
        con.commit(); n += 1
        print("  [#%s anexo %s] expirado e removido (%s)" % (idsol, aid, nome))
    print("[drive] %d anexo(s) expirado(s)." % n)


def main():
    # checa rclone + remote antes
    try:
        v = rclone("--version", timeout=30)
        if v.returncode != 0:
            print("rclone não encontrado/funcional. Instale e configure o remote '%s'." % REMOTE, file=sys.stderr)
            sys.exit(2)
    except Exception as e:  # noqa: BLE001
        print("rclone indisponível:", e, file=sys.stderr); sys.exit(2)

    con = conectar()
    try:
        # 1) expira anexos antigos (apaga do Drive + do banco)
        limpar_antigos(con)
        # 2) sobe os novos (sem link ainda)
        with con.cursor() as cur:
            cur.execute("""SELECT id, id_solicitacao, nome, conteudo
                             FROM FT_SOLICITACOES_ANEXOS
                            WHERE drive_link IS NULL OR drive_link=''
                            ORDER BY id DESC LIMIT %s""", (LOTE,))
            pend = cur.fetchall()
        if not pend:
            print("[drive] nada a subir.")
            return
        print("[drive] %d anexo(s) para subir ao Drive (%s:%s)" % (len(pend), REMOTE, DRIVE_DIR))
        ok = 0
        with con.cursor() as cur:
            for aid, idsol, nome, conteudo in pend:
                if subir_um(cur, aid, idsol, nome, conteudo):
                    con.commit(); ok += 1
                else:
                    con.rollback()
        print("[drive] concluído: %d/%d com link." % (ok, len(pend)))
    finally:
        con.close()


if __name__ == "__main__":
    main()
