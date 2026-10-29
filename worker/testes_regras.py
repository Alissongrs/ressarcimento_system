#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
testes_regras.py — ponte entre a fila FT_TESTES_REGRA (botão "Testar" da página /regras)
e o agente claude -p da VPS. Toda a parte de banco é DETERMINÍSTICA aqui; o agente só
lê os arquivos que este script prepara e devolve o laudo.

Uso:
  testes_regras.py pendentes          -> imprime nº de testes na fila; exit 0 se há, 1 se vazia
  testes_regras.py pegar              -> reserva o teste mais antigo (status 'processando'),
                                         salva cada PDF + texto + imagens em /tmp e imprime JSON com
                                         {id, faturas[{ordem,nome,pdf,texto,imagens}], regras[]}; {"vazio":true}
                                         se não houver
  testes_regras.py concluir ID LAUDO  -> grava o laudo (arquivo .md) e marca 'concluido'
  testes_regras.py falhar ID "msg"    -> marca 'erro' com a mensagem

Toca SOMENTE FT_TESTES_REGRA (status/resultado/datas); lê DM_FICHAS_REGRAS e FT_TESTES_REGRA_ARQUIVOS.
Conexão: DB_APP_URL do backend/.env (mesma lógica do has_work.py). Não imprime credenciais.
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from has_work import ler_dsn  # noqa: E402

TMP = os.environ.get("SURE_TESTES_TMP", os.path.join(tempfile.gettempdir(), "sure_testes_regra"))
STALE_MIN = int(os.environ.get("SURE_TESTES_STALE_MIN", "40"))


def conectar():
    import pymysql
    user, pwd, host, port, db = ler_dsn()
    return pymysql.connect(host=host, port=port, user=user, password=pwd, database=db,
                           charset="utf8mb4", connect_timeout=15, read_timeout=120,
                           write_timeout=120, autocommit=False)


def expirar_presos(cur):
    # teste "processando" há muito tempo = agente caiu no meio → marca erro (o usuário re-testa)
    cur.execute(
        "UPDATE FT_TESTES_REGRA SET status='erro', concluido_em=NOW(), "
        "resultado=CONCAT(COALESCE(resultado,''), 'O agente não concluiu o teste a tempo. Tente novamente.') "
        "WHERE status='processando' AND iniciado_em < NOW() - INTERVAL %s MINUTE", (STALE_MIN,))


def cmd_pendentes():
    con = conectar()
    with con.cursor() as cur:
        expirar_presos(cur)
        con.commit()
        cur.execute("SELECT COUNT(*) FROM FT_TESTES_REGRA WHERE status='pendente'")
        n = cur.fetchone()[0]
    con.close()
    print(int(n))
    sys.exit(0 if n > 0 else 1)


def preparar_fatura(tid, ordem, nome, blob):
    """Salva 1 PDF e extrai texto + imagens das primeiras páginas (PyMuPDF)."""
    os.makedirs(TMP, exist_ok=True)
    base = os.path.join(TMP, f"teste_{tid}_fat{ordem}")
    pdf = base + ".pdf"
    with open(pdf, "wb") as f:
        f.write(blob)
    item = {"ordem": ordem, "nome": nome, "pdf": pdf, "texto": None, "imagens": []}
    try:
        import fitz  # PyMuPDF
        doc = fitz.open(pdf)
        partes = []
        for i, pg in enumerate(doc):
            partes.append(f"===== PÁGINA {i + 1} =====\n{pg.get_text()}")
            if i < 4:  # o agente LÊ a imagem p/ conferir tabelas/rótulos em imagem
                png = f"{base}_p{i + 1}.png"
                pg.get_pixmap(dpi=130).save(png)
                item["imagens"].append(png)
        item["texto"] = base + ".txt"
        with open(item["texto"], "w", encoding="utf-8") as f:
            f.write("\n".join(partes))
    except Exception as e:  # noqa: BLE001 — sem PyMuPDF o agente ainda pode ler o PDF direto
        print(f"aviso: não extraí texto/imagens de {nome} ({e})", file=sys.stderr)
    return item


def cmd_pegar():
    con = conectar()
    with con.cursor() as cur:
        expirar_presos(cur)
        cur.execute("SELECT id, fichas FROM FT_TESTES_REGRA "
                    "WHERE status='pendente' ORDER BY id LIMIT 1 FOR UPDATE")
        row = cur.fetchone()
        if not row:
            con.commit()
            con.close()
            print(json.dumps({"vazio": True}))
            return
        tid, fichas = row
        cur.execute("UPDATE FT_TESTES_REGRA SET status='processando', iniciado_em=NOW() WHERE id=%s", (tid,))
        con.commit()
        cods = [c.strip() for c in fichas.split(",") if c.strip()]
        ph = ",".join(["%s"] * len(cods))
        cur.execute(f"SELECT codigo, nome, grupo, interpretacao, faturas_necessarias, criterios, aplicacao, base_legal "
                    f"FROM DM_FICHAS_REGRAS WHERE codigo IN ({ph}) ORDER BY ordem", cods)
        regras = [dict(zip(("codigo", "nome", "grupo", "interpretacao", "faturas_necessarias", "criterios",
                            "aplicacao", "base_legal"), r)) for r in cur.fetchall()]
        cur.execute("SELECT ordem, nome, conteudo FROM FT_TESTES_REGRA_ARQUIVOS WHERE id_teste=%s ORDER BY ordem", (tid,))
        arquivos = cur.fetchall()
    con.close()
    faturas = [preparar_fatura(tid, o, n, b) for (o, n, b) in arquivos]
    print(json.dumps({"id": tid, "qtd_faturas": len(faturas), "faturas": faturas, "regras": regras},
                     ensure_ascii=False))


def cmd_concluir(tid, laudo_path):
    with open(laudo_path, "r", encoding="utf-8") as f:
        laudo = f.read().strip()
    if not laudo:
        cmd_falhar(tid, "laudo vazio")
        return
    con = conectar()
    with con.cursor() as cur:
        n = cur.execute("UPDATE FT_TESTES_REGRA SET status='concluido', resultado=%s, concluido_em=NOW() "
                        "WHERE id=%s AND status='processando'", (laudo, tid))
    con.commit()
    con.close()
    print("ok" if n else "ignorado (teste cancelado ou já finalizado)")


def cmd_falhar(tid, msg):
    con = conectar()
    with con.cursor() as cur:
        cur.execute("UPDATE FT_TESTES_REGRA SET status='erro', resultado=%s, concluido_em=NOW() "
                    "WHERE id=%s AND status='processando'", (msg[:2000], tid))
    con.commit()
    con.close()
    print("ok")


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        sys.exit(2)
    if a[0] == "pendentes":
        cmd_pendentes()
    elif a[0] == "pegar":
        cmd_pegar()
    elif a[0] == "concluir" and len(a) == 3:
        cmd_concluir(int(a[1]), a[2])
    elif a[0] == "falhar" and len(a) >= 3:
        cmd_falhar(int(a[1]), " ".join(a[2:]))
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
