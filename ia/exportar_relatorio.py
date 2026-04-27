#!/usr/bin/env python3
"""
exportar_relatorio.py
─────────────────────
Extrai faturas CONFIRMADO com todos os dados e gera:
  - relatorio/resumo.csv          → lista navegável de faturas
  - relatorio/fatura_{id}.txt     → dados completos por fatura (para análise manual)
  - relatorio/inserir_analises.sql → template SQL para gravar resultado_analises

Uso:
  python exportar_relatorio.py --empresa 14
  python exportar_relatorio.py --empresa 4 14 32 --top 20
"""

import argparse
import csv
import json
import re
import sys
from datetime import datetime
from pathlib import Path

import mysql.connector

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

OUT_DIR = Path("relatorio")


def limpar(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bytes):
        return v.decode("utf-8", errors="replace")
    return str(v)


def parse_json(v) -> dict | list:
    if not v:
        return {}
    if isinstance(v, (dict, list)):
        return v
    try:
        return json.loads(v)
    except Exception:
        return {}


def main(empresas: list[int] | None, top: int | None):
    OUT_DIR.mkdir(exist_ok=True)

    conn = mysql.connector.connect(**DB)
    cur  = conn.cursor(dictionary=True)

    sql_emp   = ""
    sql_limit = ""
    args      = []

    if empresas:
        placeholders = ", ".join(["%s"] * len(empresas))
        sql_emp = f"AND f.Cod_Empresa IN ({placeholders})"
        args += empresas
    if top:
        sql_limit = f"LIMIT {top}"

    query = f"""
    SELECT
        f.id,
        f.UC,
        f.Concessionaria,
        f.Mes_Ref,
        f.RS_Total_Fatura       AS valor,
        f.Cod_Empresa,
        f.analise_IA,
        f.resultado_regras,
        COALESCE(f.texto_plumber,   '') AS texto_plumber,
        COALESCE(f.texto_markitdown,'') AS texto_markitdown,
        COALESCE(f.texto_ocr,       '') AS texto_ocr,
        fac.fichas_aplicadas,
        fac.flag_f01, fac.flag_f02, fac.flag_f03, fac.flag_f04,
        fac.flag_f05, fac.flag_f13,
        fac.desvio_pct_max, fac.troca_medidor, fac.detalhamento
    FROM db_ressarcimento.Faturas_Registradas_Cache f
    LEFT JOIN db_ressarcimento.fichas_anomalias_cache fac ON fac.id = f.id
    WHERE JSON_EXTRACT(f.analise_IA, '$.resultado.ia_status') = 'CONFIRMADO'
      {sql_emp}
    ORDER BY f.RS_Total_Fatura DESC
    {sql_limit}
    """

    cur.execute(query, args)
    rows = cur.fetchall()
    print(f"Faturas encontradas: {len(rows)}")

    csv_rows = []
    sql_lines = [
        "-- inserir_analises.sql",
        "-- Gerado em: " + datetime.now().isoformat(),
        "-- Edite o bloco JSON de cada UPDATE com a análise antes de executar.",
        "",
    ]

    for row in rows:
        fid         = row["id"]
        uc          = limpar(row["UC"])
        conc        = limpar(row["Concessionaria"])
        mes_ref     = limpar(row["Mes_Ref"])
        valor       = float(row["valor"] or 0)
        empresa     = row["Cod_Empresa"]

        analise_ia      = parse_json(row["analise_IA"])
        resultado_reg   = parse_json(row["resultado_regras"])

        ia_status  = analise_ia.get("resultado", {}).get("ia_status", "")
        ia_fichas  = analise_ia.get("resultado", {}).get("ia_fichas_confirmadas", [])
        ia_analise = analise_ia.get("resultado", {}).get("analise_texto", "")[:500]

        fichas_aplicadas = limpar(row.get("fichas_aplicadas"))
        desvio           = row.get("desvio_pct_max")
        detalhamento     = limpar(row.get("detalhamento"))

        # Fichas dos motores SQL
        fichas_f01_f05 = resultado_reg.get("f01_f05", {}).get("fichas", []) if resultado_reg else []
        fichas_f06_f14 = resultado_reg.get("f06_f14", {}).get("fichas", []) if resultado_reg else []
        todas_fichas   = fichas_f01_f05 + fichas_f06_f14

        # ── Arquivo por fatura ──────────────────────────────────────────────
        txt_path = OUT_DIR / f"fatura_{fid}.txt"
        with open(txt_path, "w", encoding="utf-8") as f:
            f.write(f"{'='*70}\n")
            f.write(f"FATURA ID: {fid}\n")
            f.write(f"UC: {uc} | Empresa: {empresa} | Concessionária: {conc}\n")
            f.write(f"Período: {mes_ref} | Valor: R$ {valor:,.2f}\n")
            f.write(f"{'='*70}\n\n")

            f.write(f"── ANÁLISE IA (4.1-mini) ──────────────────────────────────────────\n")
            f.write(f"Status: {ia_status}\n")
            f.write(f"Fichas identificadas: {ia_fichas}\n")
            f.write(f"Análise:\n{ia_analise}\n\n")

            f.write(f"── FICHAS ANOMALIAS CACHE (F01-F05) ───────────────────────────────\n")
            f.write(f"Fichas aplicadas : {fichas_aplicadas}\n")
            f.write(f"Desvio máx       : {desvio}%\n")
            f.write(f"Flags            : F01={row.get('flag_f01',0)} F02={row.get('flag_f02',0)} "
                    f"F03={row.get('flag_f03',0)} F04={row.get('flag_f04',0)} "
                    f"F05={row.get('flag_f05',0)} F13={row.get('flag_f13',0)}\n")
            f.write(f"Detalhamento:\n{detalhamento}\n\n")

            f.write(f"── RESULTADO REGRAS (F01-F14 motores SQL) ─────────────────────────\n")
            f.write(f"F01-F05: {fichas_f01_f05}\n")
            f.write(f"F06-F14: {fichas_f06_f14}\n")
            f.write(f"Todas  : {todas_fichas}\n")
            if resultado_reg:
                f.write(f"JSON completo:\n{json.dumps(resultado_reg, ensure_ascii=False, indent=2)}\n\n")

            f.write(f"── TEXTO PDFPLUMBER ───────────────────────────────────────────────\n")
            f.write(limpar(row["texto_plumber"])[:8000] + "\n\n")

            f.write(f"── TEXTO MARKITDOWN ───────────────────────────────────────────────\n")
            f.write(limpar(row["texto_markitdown"])[:8000] + "\n\n")

            f.write(f"── TEXTO OCR ──────────────────────────────────────────────────────\n")
            f.write(limpar(row["texto_ocr"])[:8000] + "\n\n")

        # ── CSV resumo ──────────────────────────────────────────────────────
        csv_rows.append({
            "id"             : fid,
            "UC"             : uc,
            "empresa"        : empresa,
            "concessionaria" : conc,
            "mes_ref"        : mes_ref,
            "valor"          : f"{valor:.2f}",
            "ia_fichas"      : "|".join(ia_fichas) if isinstance(ia_fichas, list) else ia_fichas,
            "motores_fichas" : "|".join(todas_fichas),
            "desvio_pct"     : desvio or "",
            "arquivo"        : txt_path.name,
        })

        # ── SQL template ────────────────────────────────────────────────────
        sql_lines += [
            f"-- ID {fid} | UC {uc} | {conc} | {mes_ref} | R$ {valor:,.2f}",
            f"-- 4.1-mini fichas: {ia_fichas}",
            f"-- Motores SQL    : {todas_fichas}",
            f"UPDATE db_ressarcimento.Faturas_Registradas_Cache",
            f"SET resultado_analises = '{json.dumps({",
            f'  "ia_4_1_apontamentos": {{"fichas": {json.dumps(ia_fichas)}, "status": "CONFIRMADO"}},',
            f'  "motores_sql": {json.dumps({"f01_f05": fichas_f01_f05, "f06_f14": fichas_f06_f14})},',
            f'  "ia_opus_5_4_decisao": {{',
            f'    "decisao_final": "CONFIRMADO",',
            f'    "ficha_principal": "{todas_fichas[0] if todas_fichas else "F01"}",',
            f'    "fichas_confirmadas": {json.dumps(todas_fichas)},',
            f'    "confianca_final": 0,',
            f'    "percentual_ressarcimento": 0,',
            f'    "justificativa": "PREENCHER",',
            f'    "recomendacao": "PREENCHER"',
            f'  }},',
            f'  "processado_em": "{datetime.now().isoformat()}"',
            "}'",
            f", resultado_final_em = NOW()",
            f"WHERE id = {fid};",
            "",
        ]

    # Grava CSV
    csv_path = OUT_DIR / "resumo.csv"
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=csv_rows[0].keys() if csv_rows else [])
        writer.writeheader()
        writer.writerows(csv_rows)

    # Grava SQL template
    sql_path = OUT_DIR / "inserir_analises.sql"
    sql_path.write_text("\n".join(sql_lines), encoding="utf-8")

    print(f"\n[OK] Gerado em: {OUT_DIR.resolve()}")
    print(f"  resumo.csv         → {len(csv_rows)} faturas")
    print(f"  fatura_{{id}}.txt    → arquivo por fatura com todos os textos")
    print(f"  inserir_analises.sql → template SQL para editar e executar")

    cur.close()
    conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--empresa", type=int, nargs="+", default=None)
    parser.add_argument("--top", type=int, default=None, help="Limitar N faturas (padrão: todas)")
    args = parser.parse_args()
    main(empresas=args.empresa, top=args.top)
