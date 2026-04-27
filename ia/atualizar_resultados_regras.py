#!/usr/bin/env python3
"""
atualizar_resultados_regras.py
──────────────────────────────────────────────────────────────────────────────
Atualiza Faturas_Registradas_Cache.resultados_regras com cálculos de ressarcimento
das 460 faturas CONFIRMADO (excluindo UC 634969220, 48799645, 10024660904)

Estrutura:
  resultados_regras: JSON com {
    "fichas": ["F01", "F02"],
    "valor_total": 35442.03,
    "ressarcimento_estimado": 12404.71,
    "taxa": 35,
    "metodologia": "Ficha principal com percentual conservador"
  }
  resultados_regras_em: TIMESTAMP do processamento

Uso:
  python atualizar_resultados_regras.py                # todos (empresa 14 por padrão)
  python atualizar_resultados_regras.py --empresa 4 14 32
  python atualizar_resultados_regras.py --dry-run     # sem fazer update
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
        logging.FileHandler("atualizar_resultados_regras.log", encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)

# ─── Constantes de Ressarcimento ─────────────────────────────────────────────

TAXA_F01 = 0.35  # Divergência tarifária
TAXA_F02 = 0.15  # Pico consumo anômalo
TAXA_F03 = 0.30  # Refaturamento Art. 323

# UCs a Excluir
UCS_EXCLUIR = [634969220, 48799645, 10024660904]


# ─── Funções ────────────────────────────────────────────────────────────────

def calcular_ressarcimento(fichas: list, valor_total: float) -> dict:
    """
    Calcula ressarcimento estimado baseado nas fichas detectadas.

    Retorna:
      {
        "ressarcimento_estimado": float,
        "taxa": int (percentual),
        "metodologia": str
      }
    """
    if not fichas:
        return {
            "ressarcimento_estimado": 0.0,
            "taxa": 0,
            "metodologia": "Sem fichas detectadas"
        }

    # Prioridade: F03 > F01 > F02
    if "F03" in fichas:
        taxa = TAXA_F03
        metodologia = "F03 (Refaturamento Art. 323) - 30%"
    elif "F01" in fichas:
        taxa = TAXA_F01
        metodologia = "F01 (Divergência Tarifária) - 35%"
    elif "F02" in fichas:
        taxa = TAXA_F02
        metodologia = "F02 (Pico Consumo Anômalo) - 15%"
    else:
        taxa = 0
        metodologia = "Ficha não mapeada"

    ressarcimento = round(valor_total * taxa, 2)
    taxa_pct = int(taxa * 100)

    return {
        "ressarcimento_estimado": ressarcimento,
        "taxa": taxa_pct,
        "metodologia": metodologia
    }


def buscar_faturas_confirmado(cur, empresas: list[int] | None = None):
    """
    Busca todas as faturas CONFIRMADO, excluindo UCs específicas.

    Retorna: lista de dicts com (id, UC, fichas, valor_total)
    """
    sql_empresas = " "
    if empresas:
        sql_empresas = f"AND f.Cod_Empresa IN ({', '.join(str(e) for e in empresas)}) "

    query = f"""
    SELECT
        f.id,
        f.UC,
        f.RS_Total_Fatura as valor_total,
        JSON_EXTRACT(f.analise_IA, '$.resultado.ia_fichas_confirmadas') as fichas_json,
        JSON_EXTRACT(f.analise_IA, '$.resultado.ia_status') as ia_status
    FROM Faturas_Registradas_Cache f
    WHERE JSON_EXTRACT(f.analise_IA, '$.resultado.ia_status') = 'CONFIRMADO'
        {sql_empresas}
        AND f.UC NOT IN ({', '.join(str(u) for u in UCS_EXCLUIR)})
    ORDER BY f.RS_Total_Fatura DESC
    LIMIT 500
    """

    cur.execute(query)
    rows = cur.fetchall()

    faturas = []
    for row in rows:
        try:
            fichas = json.loads(row["fichas_json"]) if row["fichas_json"] else []
            if isinstance(fichas, str):
                fichas = [fichas]
            faturas.append({
                "id": row["id"],
                "UC": row["UC"],
                "fichas": fichas,
                "valor_total": float(row["valor_total"] or 0)
            })
        except (json.JSONDecodeError, TypeError) as e:
            log.warning(f"Erro ao parsear fichas para id {row['id']}: {e}")
            continue

    return faturas


def atualizar_resultados(cur, conn, faturas: list, dry_run: bool = False):
    """
    Atualiza resultados_regras para cada fatura.
    """
    total_atualizado = 0
    agora = datetime.now().isoformat()

    for fatura in faturas:
        fatura_id = fatura["id"]
        fichas = fatura["fichas"]
        valor = fatura["valor_total"]

        # Calcula ressarcimento
        calc = calcular_ressarcimento(fichas, valor)

        # Monta JSON de resultado
        resultado_json = {
            "fichas": fichas,
            "valor_total": valor,
            "ressarcimento_estimado": calc["ressarcimento_estimado"],
            "taxa": calc["taxa"],
            "metodologia": calc["metodologia"],
            "processado_em": agora,
            "fonte": "motor_regras_ressarcimento"
        }

        if dry_run:
            log.info(f"[DRY-RUN] ID {fatura_id}: {json.dumps(resultado_json)}")
            continue

        # UPDATE na tabela
        try:
            update_sql = """
            UPDATE Faturas_Registradas_Cache
            SET
                resultados_regras = %s,
                resultados_regras_em = NOW()
            WHERE id = %s
            """
            cur.execute(update_sql, (json.dumps(resultado_json), fatura_id))
            conn.commit()
            total_atualizado += 1

            if total_atualizado % 100 == 0:
                log.info(f"  {total_atualizado} faturas atualizadas...")

        except Exception as e:
            log.error(f"Erro ao atualizar id {fatura_id}: {e}")
            conn.rollback()
            continue

    return total_atualizado


def main(empresas: list[int] | None = None, dry_run: bool = False):
    log.info("=" * 70)
    log.info("Iniciando atualizar_resultados_regras.py")
    log.info(f"  Empresas: {empresas or 'todas'}")
    log.info(f"  UCs excluídas: {UCS_EXCLUIR}")
    log.info(f"  Dry-run: {dry_run}")

    conn = mysql.connector.connect(**DB)
    cur = conn.cursor(dictionary=True)

    try:
        # Busca faturas CONFIRMADO
        log.info("\nBuscando faturas CONFIRMADO...")
        faturas = buscar_faturas_confirmado(cur, empresas)
        log.info(f"  Encontradas: {len(faturas)} faturas")

        if not faturas:
            log.warning("  Nenhuma fatura encontrada!")
            return

        # Resumo de fichas
        fichas_count = {}
        valor_total = 0
        ressarc_total = 0

        for f in faturas:
            valor_total += f["valor_total"]
            for ficha in f["fichas"]:
                fichas_count[ficha] = fichas_count.get(ficha, 0) + 1
            calc = calcular_ressarcimento(f["fichas"], f["valor_total"])
            ressarc_total += calc["ressarcimento_estimado"]

        log.info(f"\n  Resumo:")
        log.info(f"    Valor total: R$ {valor_total:,.2f}")
        log.info(f"    Ressarcimento estimado: R$ {ressarc_total:,.2f}")
        log.info(f"    Taxa média: {ressarc_total/valor_total*100:.1f}%")
        log.info(f"    Fichas encontradas: {dict(fichas_count)}")

        # Atualiza banco
        if dry_run:
            log.info("\n[DRY-RUN] Nenhuma atualização será feita.")
        else:
            log.info("\nAtualizando banco de dados...")
            total = atualizar_resultados(cur, conn, faturas, dry_run=False)
            log.info(f"  ✅ {total} faturas atualizadas com sucesso!")

    except Exception as e:
        log.error(f"Erro: {e}", exc_info=True)
        raise
    finally:
        cur.close()
        conn.close()

    log.info("=" * 70)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Atualizar resultados_regras com cálculos de ressarcimento"
    )
    parser.add_argument(
        "--empresa",
        type=int,
        nargs="+",
        default=None,
        help="Filtrar por Cod_Empresa (ex: 14  ou  4 14 32). Padrão: todas.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Simular sem fazer UPDATE no banco.",
    )
    args = parser.parse_args()
    main(empresas=args.empresa, dry_run=args.dry_run)
