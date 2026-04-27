#!/usr/bin/env python3
"""
consolidar_motores.py
──────────────────────────────────────────────────────────────────────────────
Consolida resultados dos motores SQL (F01-F05, F06-F14) em um JSON único
e grava em Faturas_Registradas_Cache.analise_motores

Fluxo:
  1. Lê fichas_anomalias_cache (motor F01-F05)
  2. Lê fichas_f06_f14_cache (motor F06-F14)
  3. Consolida em JSON com confiança agregada
  4. Grava em Faturas_Registradas_Cache.analise_motores
  5. Marca status_triagem para decisão IA

Uso:
  python consolidar_motores.py                    # todas as empresas
  python consolidar_motores.py --empresa 14       # empresa específica
  python consolidar_motores.py --apenas-analisa   # sem UPDATE
"""

import argparse
import json
import logging
import sys
from datetime import datetime
from pathlib import Path

import mysql.connector

# ─── Conexão ─────────────────────────────────────────────────────────────────

DB = dict(
    host="db-acesso-ressarcimento.cvicxzrqb58o.us-east-2.rds.amazonaws.com",
    port=3306,
    user="super_user_ressarcimento",
    password="qZ8YbD3GxK9uN4RmV2sAeT7LwBjCp5X0",
    database="db_ressarcimento",
    charset="utf8mb4",
    connection_timeout=60,
    use_pure=True,
    ssl_disabled=True,
)

# ─── Logging ─────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("consolidar_motores.log", encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)


# ─── Funções ────────────────────────────────────────────────────────────────

def calcular_confianca_motor(fichas: list, count: int) -> int:
    """
    Calcula score de confiança do motor (0-100).

    Lógica:
      - F01: +35 (Divergência — alta confiabilidade)
      - F02: +30 (Consumo anômalo — verificável via série histórica)
      - F03: +25 (Refaturamento — precisa validação IA)
      - F04-F05: +20 (Menos confiáveis)
      - F06-F14: +15 (Regras de negócio — alto falso positivo)

    Confiança agregada = min(100, 40 + sum(scores))
    """
    base = 40  # baseline: motor fez seu trabalho
    score = 0

    for ficha in fichas:
        if ficha == "F01":
            score += 35
        elif ficha == "F02":
            score += 30
        elif ficha == "F03":
            score += 25
        elif ficha in ["F04", "F05"]:
            score += 20
        elif ficha in ["F06", "F07", "F08", "F09", "F10", "F11", "F12", "F13", "F14"]:
            score += 15

    confianca = min(100, base + score)
    return int(confianca)


def buscar_fichas_f01_f05(cur, empresas: list[int] | None = None) -> dict:
    """Busca resultados do motor F01-F05 (fichas_anomalias_cache)"""
    sql_empresas = ""
    if empresas:
        sql_empresas = f"AND Cod_Empresa IN ({', '.join(str(e) for e in empresas)}) "

    # Tenta buscar - se falhar, retorna vazio (compatibilidade)
    try:
        query = f"""
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'db_ressarcimento'
        AND TABLE_NAME = 'fichas_anomalias_cache'
        """
        cur.execute(query)
        colunas = [row[0] for row in cur.fetchall()]

        if not colunas:
            log.warning("  Motor F01-F05: tabela fichas_anomalias_cache não encontrada")
            return {}

        # Construir query dinamicamente com colunas disponíveis
        cols_select = ["id"]
        if "fichas" in colunas or "Fichas" in colunas:
            cols_select.append("fichas")
        if "desvio_pct_max" in colunas:
            cols_select.append("desvio_pct_max")
        if "confianca_motor" in colunas:
            cols_select.append("confianca_motor")

        query = f"""
        SELECT {', '.join(cols_select)}
        FROM fichas_anomalias_cache
        WHERE 1=1 {sql_empresas}
        LIMIT 10000
        """

        cur.execute(query)
        rows = cur.fetchall()

        resultado = {}
        for row in rows:
            fatura_id = row.get("id")
            fichas_str = row.get("fichas", row.get("Fichas", ""))
            fichas = fichas_str.split(",") if fichas_str else []
            fichas = [f.strip() for f in fichas if f.strip()]

            if fatura_id and fichas:
                resultado[fatura_id] = {
                    "fichas": fichas,
                    "desvio_pct_max": float(row.get("desvio_pct_max") or 0),
                    "confianca": int(row.get("confianca_motor") or calcular_confianca_motor(fichas, len(fichas)))
                }

        log.info(f"  Motor F01-F05: {len(resultado)} faturas com anomalias")
        return resultado

    except Exception as e:
        log.warning(f"  Motor F01-F05: erro ao buscar ({str(e)[:60]})")
        return {}


def buscar_fichas_f06_f14(cur, empresas: list[int] | None = None) -> dict:
    """Busca resultados do motor F06-F14 (fichas_f06_f14_cache)"""
    sql_empresas = ""
    if empresas:
        sql_empresas = f"AND Cod_Empresa IN ({', '.join(str(e) for e in empresas)}) "

    try:
        query = f"""
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'db_ressarcimento'
        AND TABLE_NAME = 'fichas_f06_f14_cache'
        """
        cur.execute(query)
        colunas = [row[0] for row in cur.fetchall()]

        if not colunas:
            log.warning("  Motor F06-F14: tabela fichas_f06_f14_cache não encontrada")
            return {}

        # Construir query dinamicamente
        cols_select = ["id"]
        if "fichas" in colunas or "Fichas" in colunas:
            cols_select.append("fichas")
        if "confianca_motor" in colunas:
            cols_select.append("confianca_motor")

        query = f"""
        SELECT {', '.join(cols_select)}
        FROM fichas_f06_f14_cache
        WHERE 1=1 {sql_empresas}
        LIMIT 10000
        """

        cur.execute(query)
        rows = cur.fetchall()

        resultado = {}
        for row in rows:
            fatura_id = row.get("id")
            fichas_str = row.get("fichas", row.get("Fichas", ""))
            fichas = fichas_str.split(",") if fichas_str else []
            fichas = [f.strip() for f in fichas if f.strip()]

            if fatura_id and fichas:
                resultado[fatura_id] = {
                    "fichas": fichas,
                    "confianca": int(row.get("confianca_motor") or calcular_confianca_motor(fichas, len(fichas)))
                }

        log.info(f"  Motor F06-F14: {len(resultado)} faturas com anomalias")
        return resultado

    except Exception as e:
        log.warning(f"  Motor F06-F14: erro ao buscar ({str(e)[:60]})")
        return {}


def consolidar_motores(f01_f05: dict, f06_f14: dict) -> dict:
    """Consolida resultados de ambos os motores"""
    todos_ids = set(f01_f05.keys()) | set(f06_f14.keys())
    consolidado = {}

    for fatura_id in todos_ids:
        dados_f01 = f01_f05.get(fatura_id, {})
        dados_f06 = f06_f14.get(fatura_id, {})

        fichas_f01 = dados_f01.get("fichas", [])
        fichas_f06 = dados_f06.get("fichas", [])
        fichas_union = list(set(fichas_f01 + fichas_f06))

        conf_f01 = dados_f01.get("confianca", 0)
        conf_f06 = dados_f06.get("confianca", 0)
        conf_final = max(conf_f01, conf_f06)

        consolidado[fatura_id] = {
            "f01_f05": {
                "detectadas": fichas_f01,
                "confianca": conf_f01,
                "desvio_pct_max": dados_f01.get("desvio_pct_max", 0)
            },
            "f06_f14": {
                "detectadas": fichas_f06,
                "confianca": conf_f06
            },
            "fichas_union": fichas_union,
            "confianca_final": conf_final,
            "confianca_triagem": "ALTA" if conf_final >= 80 else ("MEDIA" if conf_final >= 50 else "BAIXA"),
            "processado_em": datetime.now().isoformat()
        }

    return consolidado


def atualizar_banco(cur, conn, consolidado: dict, apenas_analisa: bool = False):
    """Atualiza Faturas_Registradas_Cache.analise_motores"""
    total = 0

    if apenas_analisa:
        log.info("  [APENAS ANÁLISE] Nenhuma atualização será feita no banco.")
        for fatura_id, dados in list(consolidado.items())[:5]:
            log.info(f"    ID {fatura_id}: {json.dumps(dados)}")
        return 0

    for fatura_id, dados in consolidado.items():
        try:
            json_dados = json.dumps(dados, ensure_ascii=False, indent=2)

            update_sql = """
            UPDATE Faturas_Registradas_Cache
            SET
                analise_motores = %s,
                status_triagem = %s,
                resultados_regras_em = NOW()
            WHERE id = %s
            """

            status_triagem = "SUSPEITA_CONFIRMADA" if dados["confianca_final"] >= 80 else "SUSPEITA_PENDENTE"

            cur.execute(update_sql, (json_dados, status_triagem, fatura_id))
            conn.commit()
            total += 1

            if total % 100 == 0:
                log.info(f"  {total} faturas atualizadas...")

        except Exception as e:
            log.error(f"Erro ao atualizar id {fatura_id}: {e}")
            conn.rollback()
            continue

    return total


def main(empresas: list[int] | None = None, apenas_analisa: bool = False):
    log.info("=" * 70)
    log.info("Iniciando consolidar_motores.py")
    log.info(f"  Empresas: {empresas or 'todas'}")
    log.info(f"  Apenas análise: {apenas_analisa}")

    conn = mysql.connector.connect(**DB)
    cur = conn.cursor(dictionary=True)

    try:
        log.info("\nBuscando resultados dos motores...")
        f01_f05 = buscar_fichas_f01_f05(cur, empresas)
        f06_f14 = buscar_fichas_f06_f14(cur, empresas)

        log.info("\nConsolidando análises...")
        consolidado = consolidar_motores(f01_f05, f06_f14)
        log.info(f"  Total de faturas com anomalias: {len(consolidado)}")

        # Resumo
        confirmadas = sum(1 for d in consolidado.values() if d["confianca_final"] >= 80)
        pendentes = len(consolidado) - confirmadas

        log.info(f"\n  Classificação de Triagem:")
        log.info(f"    • SUSPEITA_CONFIRMADA (≥80%): {confirmadas}")
        log.info(f"    • SUSPEITA_PENDENTE (<80%): {pendentes}")

        log.info("\nAtualizando banco de dados...")
        total = atualizar_banco(cur, conn, consolidado, apenas_analisa)

        if not apenas_analisa:
            log.info(f"  ✅ {total} faturas consolidadas com sucesso!")
        else:
            log.info(f"  [DRY-RUN] {len(consolidado)} faturas analisadas (sem UPDATE)")

    except Exception as e:
        log.error(f"Erro: {e}", exc_info=True)
        raise
    finally:
        cur.close()
        conn.close()

    log.info("=" * 70)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Consolidar motores de regras SQL")
    parser.add_argument(
        "--empresa",
        type=int,
        nargs="+",
        default=None,
        help="Filtrar por Cod_Empresa. Padrão: todas.",
    )
    parser.add_argument(
        "--apenas-analisa",
        action="store_true",
        help="Apenas analisa sem fazer UPDATE.",
    )
    args = parser.parse_args()
    main(empresas=args.empresa, apenas_analisa=args.apenas_analisa)
