# -*- coding: utf-8 -*-
"""Fila das faturas SEM camada de texto (PDF-imagem) para o OCR gratuito do pipeline (RapidOCR/Tesseract).

Quem entra: FATURA_DADOS_EXTRAIDOS com texto_plumber vazio (< 200 caracteres), gate fora de aprovado/revisao,
link http e que ainda não passou por aqui (FT_OCR_SEM_TEXTO) nem está marcada `tem_texto` na leitura visual
(essas vão pelo job_reprocessar_tem_texto.sh). Quase todas já têm um texto_ocr antigo do Tesseract — por isso a
fila tem registro próprio em vez de olhar ocr_gerado_em.

O job (worker/job_ocr_sem_texto.sh) chama:
  ids    --saida ids.txt [--limite 200]   → grava a fila (status 'fila') e os ids da ORIGEM (Faturas_Registradas_Cache.id)
  marcar                                  → depois do pdf_pipeline --force: 'fila' → 'feito' com o gate/medidor/kWh de depois
  resumo                                  → contagem por status e por resultado

FT_OCR_SEM_TEXTO é a tabela de log desta rotina (criada aqui, se não existir). Nenhuma outra escrita.
"""
from __future__ import annotations

import datetime as dt
import os
import sys
from pathlib import Path

AQUI = Path(__file__).resolve().parent
if str(AQUI) not in sys.path:
    sys.path.insert(0, str(AQUI))

DDL = """CREATE TABLE IF NOT EXISTS FT_OCR_SEM_TEXTO (
    id_fatura      INT          NOT NULL,
    uid            VARCHAR(128) NULL,
    id_origem      INT          NULL,
    status         VARCHAR(12)  NOT NULL DEFAULT 'fila',
    gate_antes     VARCHAR(20)  NULL,
    gate_depois    VARCHAR(20)  NULL,
    medidor_depois VARCHAR(40)  NULL,
    kwh_depois     DECIMAL(14,3) NULL,
    ocr_chars      INT          NULL,
    criado_em      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id_fatura),
    KEY ix_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"""

SQL_CANDIDATAS = """
SELECT f.id, f.uid, COALESCE(f.validador_gate, '') AS gate
  FROM FATURA_DADOS_EXTRAIDOS f
  LEFT JOIN FT_OCR_SEM_TEXTO o ON o.id_fatura = f.id
  LEFT JOIN FT_LEITURA_VISUAL v ON v.id_fatura = f.id
 WHERE f.link_fatura LIKE 'http%%'
   AND (f.texto_plumber IS NULL OR LENGTH(f.texto_plumber) < 200)
   AND COALESCE(f.validador_gate, '') NOT IN ('aprovado', 'revisao')
   AND f.uid IS NOT NULL AND f.uid <> ''
   AND o.id_fatura IS NULL
   AND (v.id_fatura IS NULL OR v.status NOT IN ('tem_texto', 'reprocessada'))
 ORDER BY f.mes_referencia DESC, f.id DESC
 LIMIT %s"""


def _con():
    import mysql.connector
    from db_env import conexao
    con = mysql.connector.connect(**conexao("DB_APP_URL"))
    cur = con.cursor()
    cur.execute(DDL)
    con.commit()
    cur.close()
    return con


def _log(msg: str) -> None:
    print(f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def cmd_ids(argv: list[str]) -> int:
    import mysql.connector
    from db_env import conexao
    saida = _arg(argv, "--saida", "ocr_sem_texto_ids.txt")
    limite = int(_arg(argv, "--limite", os.environ.get("SURE_OCR_LIMITE", "200")))
    con = _con()
    cur = con.cursor()
    cur.execute(SQL_CANDIDATAS, (limite,))
    rows = cur.fetchall()
    if not rows:
        Path(saida).write_text("", encoding="utf-8")
        _log("0 fatura(s) sem texto na fila")
        con.close()
        return 0
    uids = [u for _, u, _ in rows]
    orig = mysql.connector.connect(**conexao("DB_FATURAS", "DB_FATURAS_URL"))
    oc = orig.cursor()
    por_uid: dict[str, int] = {}
    for i in range(0, len(uids), 500):
        bloco = uids[i:i + 500]
        oc.execute(f"SELECT UID, id FROM Faturas_Registradas_Cache WHERE UID IN ({','.join(['%s'] * len(bloco))})", bloco)
        for u, oid in oc.fetchall():
            por_uid[u] = int(oid)
    orig.close()
    for fid, uid, gate in rows:
        oid = por_uid.get(uid)
        cur.execute("INSERT INTO FT_OCR_SEM_TEXTO (id_fatura, uid, id_origem, status, gate_antes) VALUES (%s,%s,%s,%s,%s) "
                    "ON DUPLICATE KEY UPDATE status = VALUES(status)",
                    (fid, uid, oid, "fila" if oid else "sem_origem", gate or None))
    con.commit()
    ids = sorted(set(por_uid.values()))
    Path(saida).write_text("\n".join(str(i) for i in ids) + ("\n" if ids else ""), encoding="utf-8")
    _log(f"{len(rows)} fatura(s) sem texto → {len(ids)} id(s) da origem em {saida}; {len(rows) - len(ids)} sem id na origem")
    con.close()
    return 0


def cmd_marcar(argv: list[str]) -> int:
    con = _con()
    cur = con.cursor()
    cur.execute("""UPDATE FT_OCR_SEM_TEXTO o JOIN FATURA_DADOS_EXTRAIDOS f ON f.id = o.id_fatura
                      SET o.status = 'feito', o.gate_depois = f.validador_gate, o.medidor_depois = f.numero_medidor,
                          o.kwh_depois = f.kwh_total, o.ocr_chars = LENGTH(COALESCE(f.texto_ocr, ''))
                    WHERE o.status = 'fila'""")
    n = cur.rowcount
    con.commit()
    cur.execute("""SELECT COALESCE(gate_depois, ''), SUM(medidor_depois IS NOT NULL AND medidor_depois <> ''),
                          SUM(kwh_depois IS NOT NULL AND kwh_depois > 0), COUNT(*)
                     FROM FT_OCR_SEM_TEXTO WHERE status = 'feito' AND atualizado_em >= NOW() - INTERVAL 1 MINUTE GROUP BY 1""")
    _log(f"{n} fatura(s) marcada(s) como feito")
    for gate, med, kwh, tot in cur.fetchall():
        _log(f"  gate '{gate}': {tot} fatura(s), medidor em {int(med or 0)}, kWh em {int(kwh or 0)}")
    con.close()
    return 0


def cmd_resumo() -> int:
    con = _con()
    cur = con.cursor()
    cur.execute("SELECT status, COUNT(*) FROM FT_OCR_SEM_TEXTO GROUP BY status")
    print("por status:", dict(cur.fetchall()))
    cur.execute("""SELECT COALESCE(gate_depois, ''), COUNT(*), SUM(medidor_depois IS NOT NULL AND medidor_depois <> ''),
                          SUM(kwh_depois IS NOT NULL AND kwh_depois > 0)
                     FROM FT_OCR_SEM_TEXTO WHERE status = 'feito' GROUP BY 1""")
    for gate, tot, med, kwh in cur.fetchall():
        print(f"  feito, gate '{gate}': {tot}; medidor {int(med or 0)}; kWh {int(kwh or 0)}")
    cur.execute(SQL_CANDIDATAS.replace("LIMIT %s", "LIMIT 100000"))
    print("ainda na fila (candidatas):", len(cur.fetchall()))
    con.close()
    return 0


def _arg(argv, nome, default=None):
    return argv[argv.index(nome) + 1] if nome in argv and argv.index(nome) + 1 < len(argv) else default


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if argv[0] == "ids":
        return cmd_ids(argv[1:])
    if argv[0] == "marcar":
        return cmd_marcar(argv[1:])
    if argv[0] == "resumo":
        return cmd_resumo()
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
