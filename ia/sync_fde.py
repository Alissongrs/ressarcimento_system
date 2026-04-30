#!/usr/bin/env python3
"""
sync_fde.py
───────────────────────────────────────────────────────────────────────────────
Comparativo entre Faturas_Registradas_Cache (fonte) e FATURA_DADOS_EXTRAIDOS
(tabela processada).

Detecta:
  - novos      : UIDs na fonte que ainda não estão em FATURA_DADOS_EXTRAIDOS
  - link_alt   : UIDs em ambos mas com Link diferente (fatura foi atualizada)
  - ok         : UIDs em ambos com mesmo link

Uso:
  python sync_fde.py                         # só relatório
  python sync_fde.py --empresa 14            # filtra empresa
  python sync_fde.py --processar-novos       # dispara pdf_pipeline nos novos
  python sync_fde.py --processar-alterados   # dispara pdf_pipeline nos alterados
  python sync_fde.py --processar-todos       # novos + alterados
  python sync_fde.py --limite 50             # limita quantos processar
"""

import argparse
import logging
import os
import subprocess
import sys
from pathlib import Path

import mysql.connector

_env = Path(__file__).resolve().parent.parent / "backend" / ".env"
if _env.exists():
    for _l in _env.read_text(encoding="utf-8").splitlines():
        _l = _l.strip()
        if _l and not _l.startswith("#") and "=" in _l:
            k, _, v = _l.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)

DB = dict(
    host               = "db-acesso-ressarcimento.cvicxzrqb58o.us-east-2.rds.amazonaws.com",
    port               = 3306,
    user               = "super_user_ressarcimento",
    password           = "qZ8YbD3GxK9uN4RmV2sAeT7LwBjCp5X0",
    database           = "db_ressarcimento",
    charset            = "utf8mb4",
    connection_timeout = 60,
    use_pure           = True,
    ssl_disabled       = True,
)

PYTHON = sys.executable
PIPELINE_SCRIPT = str(Path(__file__).parent / "pdf_pipeline.py")


def _conectar():
    conn = mysql.connector.connect(**DB)
    cur  = conn.cursor(dictionary=True)
    return conn, cur


def buscar_fonte(cur, empresas: list[int] | None) -> dict[str, dict]:
    """Retorna {UID: {id, link, cod_empresa, uc, mes_ref}} da Faturas_Registradas_Cache."""
    emp_sql = ""
    if empresas:
        emp_sql = f"AND frc.Cod_Empresa IN ({', '.join(str(e) for e in empresas)})"

    cur.execute(f"""
        SELECT frc.id, frc.UID, COALESCE(frc.Link,'') AS link,
               frc.Cod_Empresa, frc.UC,
               DATE_FORMAT(frc.Mes_Ref, '%Y-%m') AS mes_ref
        FROM Faturas_Registradas_Cache frc
        WHERE frc.UID IS NOT NULL AND frc.UID != ''
          AND frc.Link IS NOT NULL AND frc.Link != ''
          {emp_sql}
        ORDER BY frc.id
    """)
    return {row["UID"]: row for row in cur.fetchall()}


def buscar_processados(cur, empresas: list[int] | None) -> dict[str, dict]:
    """Retorna {uid: {id, link_fatura, cod_empresa}} de FATURA_DADOS_EXTRAIDOS."""
    emp_sql = ""
    if empresas:
        emp_sql = f"AND fde.cod_empresa IN ({', '.join(str(e) for e in empresas)})"

    cur.execute(f"""
        SELECT fde.id, fde.uid, COALESCE(fde.link_fatura,'') AS link_fatura,
               fde.cod_empresa, fde.fonte_extracao, fde.atualizado_em
        FROM FATURA_DADOS_EXTRAIDOS fde
        WHERE fde.uid IS NOT NULL AND fde.uid != ''
          {emp_sql}
    """)
    return {row["uid"]: row for row in cur.fetchall()}


def comparar(fonte: dict, processados: dict) -> tuple[list, list, list]:
    """Retorna (novos, link_alterado, ok) como listas de dicts da fonte."""
    novos        = []
    link_alt     = []
    ok           = []

    for uid, src in fonte.items():
        if uid not in processados:
            novos.append(src)
        elif src["link"].strip() != processados[uid]["link_fatura"].strip():
            src["_link_antigo"] = processados[uid]["link_fatura"]
            link_alt.append(src)
        else:
            ok.append(src)

    return novos, link_alt, ok


def imprimir_relatorio(novos, link_alt, ok, fonte_total: int):
    print("\n" + "═" * 60)
    print("  SYNC FATURA_DADOS_EXTRAIDOS")
    print("═" * 60)
    print(f"  Fonte (Faturas_Registradas_Cache com link): {fonte_total:>6}")
    print(f"  Processados (FATURA_DADOS_EXTRAIDOS):       {len(ok) + len(link_alt):>6}")
    print(f"  ─────────────────────────────────────────────────────")
    print(f"  ✅ OK (uid + link iguais):                  {len(ok):>6}")
    print(f"  🆕 Novos (ainda não processados):           {len(novos):>6}")
    print(f"  🔄 Link alterado (precisam reprocessar):    {len(link_alt):>6}")
    print("═" * 60 + "\n")

    if novos:
        print(f"  NOVOS (primeiros 10):")
        for r in novos[:10]:
            print(f"    id={r['id']:>8}  uid={r['UID'][:30]:<30}  uc={r['UC']}  {r['mes_ref']}")
        if len(novos) > 10:
            print(f"    ... e mais {len(novos)-10}")
        print()

    if link_alt:
        print(f"  LINK ALTERADO (primeiros 10):")
        for r in link_alt[:10]:
            print(f"    id={r['id']:>8}  uid={r['UID'][:30]:<30}  uc={r['UC']}  {r['mes_ref']}")
            print(f"      antigo: {r.get('_link_antigo','')[:80]}")
            print(f"      novo:   {r['link'][:80]}")
        if len(link_alt) > 10:
            print(f"    ... e mais {len(link_alt)-10}")
        print()


def processar_ids(ids: list[int], limite: int | None, label: str):
    """Dispara pdf_pipeline.py --id <id1> <id2> ..."""
    if not ids:
        log.info(f"[{label}] Nenhum ID para processar.")
        return

    if limite:
        ids = ids[:limite]

    log.info(f"[{label}] Processando {len(ids)} faturas via pdf_pipeline...")
    chunk = 50  # evita linha de comando gigante
    for i in range(0, len(ids), chunk):
        batch = ids[i:i+chunk]
        cmd = [PYTHON, PIPELINE_SCRIPT, "--id"] + [str(x) for x in batch] + ["--force"]
        log.info(f"  Lote {i//chunk + 1}: ids {batch[0]}..{batch[-1]}")
        result = subprocess.run(cmd, capture_output=False)
        if result.returncode != 0:
            log.warning(f"  Lote com erro (returncode={result.returncode})")


def main():
    ap = argparse.ArgumentParser(description="Sync FATURA_DADOS_EXTRAIDOS vs Faturas_Registradas_Cache")
    ap.add_argument("--empresa", type=int, nargs="+", metavar="COD", help="Filtrar por Cod_Empresa")
    ap.add_argument("--processar-novos",     action="store_true", help="Dispara pdf_pipeline nos novos")
    ap.add_argument("--processar-alterados", action="store_true", help="Dispara pdf_pipeline nos com link alterado")
    ap.add_argument("--processar-todos",     action="store_true", help="Novos + alterados")
    ap.add_argument("--limite", type=int, default=None, metavar="N", help="Máximo de faturas a processar")
    args = ap.parse_args()

    conn, cur = _conectar()
    try:
        log.info("Buscando dados da fonte...")
        fonte       = buscar_fonte(cur, args.empresa)
        log.info(f"  {len(fonte)} UIDs com link na fonte")

        log.info("Buscando processados...")
        processados = buscar_processados(cur, args.empresa)
        log.info(f"  {len(processados)} UIDs em FATURA_DADOS_EXTRAIDOS")

        novos, link_alt, ok = comparar(fonte, processados)
        imprimir_relatorio(novos, link_alt, ok, len(fonte))

    finally:
        cur.close()
        conn.close()

    # Processamento opcional
    rodar_novos     = args.processar_novos     or args.processar_todos
    rodar_alterados = args.processar_alterados or args.processar_todos

    if rodar_novos:
        processar_ids([r["id"] for r in novos], args.limite, "NOVOS")

    if rodar_alterados:
        processar_ids([r["id"] for r in link_alt], args.limite, "LINK_ALTERADO")

    if not rodar_novos and not rodar_alterados and (novos or link_alt):
        print("  Dica: rode com --processar-novos, --processar-alterados ou --processar-todos")
        print("        para disparar o pipeline automaticamente.\n")


if __name__ == "__main__":
    main()
