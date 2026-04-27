"""
migrar_analise_ia.py
--------------------
Popula fichas_anomalias_cache a partir de Faturas_Registradas_Cache.analise_IA.
Útil quando a tabela fichas_anomalias_cache foi truncada ou perdeu registros por
falha de conexão durante o batch.

Uso:
    python migrar_analise_ia.py
    python migrar_analise_ia.py --empresa 14
    python migrar_analise_ia.py --force      # re-processa mesmo quem já tem resultado_ia
"""

import argparse
import logging
import re
import sys
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

logging.basicConfig(
    level   = logging.INFO,
    format  = "%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt = "%Y-%m-%d %H:%M:%S",
    handlers = [
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("migrar_analise_ia.log", encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)

# ─── Parsers ────────────────────────────────────────────────────────────────────

_FICHA_PAT = r"F(?:0[1-9]|1[0-4])"

def _parse_fichas(texto: str) -> tuple[str, str]:
    """Extrai fichas confirmadas e status a partir de analise_IA.
    Retorna (fichas_str, ia_status): ex. ('F01,F03', 'CONFIRMADO')
    Handles todas as variantes: '1 (F03)', '[F09]', 'nenhuma', '0 []', etc.
    """
    line_m = re.search(r"Fichas\s+Confirmadas\s*:([^\n]{0,100})", texto, re.IGNORECASE)
    if line_m:
        line = line_m.group(1).strip()
        fichas_found = re.findall(_FICHA_PAT, line, re.IGNORECASE)
        fichas_str = ",".join(sorted(set(c.upper() for c in fichas_found)))
        count_m = re.match(r"(\d+)", line)
        count = int(count_m.group(1)) if count_m else None
        is_nenhuma = bool(re.search(r"nenhuma|none", line, re.IGNORECASE))

        if fichas_str:
            return fichas_str, "CONFIRMADO"
        elif count is not None and count > 0:
            return "", "CONFIRMADO"
        elif is_nenhuma or count == 0 or not line:
            return "", "FALSO_POSITIVO"
        else:
            return "", "FALSO_POSITIVO"
    return "", "FALSO_POSITIVO"


def _parse_valor(texto: str) -> float | None:
    """Extrai valor estimado de ressarcimento do texto."""
    patterns = [
        r"valor_ressarcimento_total\s*[=:]\s*R?\$?\s*([\d.,]+)",
        r"valor_ressarcimento_estimado\s*[=:]\s*R?\$?\s*([\d.,]+)",
        r"Valor Estimado Simples:\s*R\$\s*([\d.,]+)",
        r"valor_estimado\s*[=:]\s*R?\$?\s*([\d.,]+)",
    ]
    for pat in patterns:
        m = re.search(pat, texto, re.IGNORECASE)
        if m:
            raw = m.group(1).replace(".", "").replace(",", ".")
            try:
                v = float(raw)
                if v > 0:
                    return round(v, 2)
            except ValueError:
                pass
    return None


def _flags_fichas(fichas_str: str) -> dict:
    s = (fichas_str or "").upper()
    return {
        "flag_f01": 1 if "F01" in s else 0,
        "flag_f02": 1 if "F02" in s else 0,
        "flag_f03": 1 if "F03" in s else 0,
        "flag_f04": 1 if "F04" in s else 0,
        "flag_f05": 1 if "F05" in s else 0,
    }


def _ia_status_from_fichas(fichas_str: str, texto: str) -> str:
    if fichas_str:
        return "CONFIRMADO"
    # Se o texto indica explicitamente sem anomalia
    if re.search(r"nenhuma anomalia confirmada|sem anomalia", texto, re.IGNORECASE):
        return "FALSO_POSITIVO"
    # F02 calculado mas não monetizado → INCONCLUSIVO
    if re.search(r"valor_f02\s*[≈=]\s*R?\$?\s*0", texto, re.IGNORECASE):
        return "FALSO_POSITIVO"
    return "FALSO_POSITIVO"


# ─── Main ────────────────────────────────────────────────────────────────────────

def main(empresas: list[int] | None, force: bool):
    conn = mysql.connector.connect(**DB)
    cur  = conn.cursor(dictionary=True)

    filtro_empresa = ""
    params: list = []
    if empresas:
        ph = ", ".join(["%s"] * len(empresas))
        filtro_empresa = f"AND frc.Cod_Empresa IN ({ph})"
        params = list(empresas)

    filtro_force = ""
    if not force:
        filtro_force = "AND (fac.id IS NULL OR fac.resultado_ia IS NULL OR fac.resultado_ia = '')"

    cur.execute(f"""
        SELECT frc.id, frc.UC, frc.Cod_Empresa, frc.Concessionaria,
               frc.Mes_Ref, frc.Tp_Tensao, frc.NroMedidor,
               frc.RAZAO_SOCIAL, frc.Link, frc.RS_Total_Fatura,
               frc.analise_IA, frc.ia_analisado_em
        FROM Faturas_Registradas_Cache frc
        LEFT JOIN fichas_anomalias_cache fac ON fac.id = frc.id AND fac.deletado = 0
        WHERE frc.analise_IA IS NOT NULL AND frc.analise_IA != ''
          {filtro_empresa}
          {filtro_force}
        ORDER BY frc.ia_analisado_em DESC
    """, params or [])

    rows = cur.fetchall()
    log.info(f"Faturas a migrar: {len(rows)}")

    ok = erro = 0
    for row in rows:
        fid    = row["id"]
        texto  = row["analise_IA"] or ""
        fichas, status = _parse_fichas(texto)
        valor  = _parse_valor(texto)
        flags  = _flags_fichas(fichas)
        qtd    = sum(flags.values())

        try:
            cur.execute("""
                INSERT INTO fichas_anomalias_cache
                    (id, UC, Cod_Empresa, Concessionaria, Mes_Ref, Tp_Tensao, NroMedidor,
                     RAZAO_SOCIAL, Link, RS_Total_Fatura,
                     flag_f01, flag_f02, flag_f03, flag_f04, flag_f05,
                     qtd_regras, fichas_aplicadas, ia_fichas_confirmadas,
                     ia_status, resultado_ia, valor_ressarcimento_estimado,
                     resultado_salvo_em)
                VALUES
                    (%s, %s, %s, %s, %s, %s, %s,
                     %s, %s, %s,
                     %s, %s, %s, %s, %s,
                     %s, %s, %s,
                     %s, %s, %s,
                     %s)
                ON DUPLICATE KEY UPDATE
                    ia_status                    = VALUES(ia_status),
                    resultado_ia                 = VALUES(resultado_ia),
                    ia_fichas_confirmadas        = VALUES(ia_fichas_confirmadas),
                    fichas_aplicadas             = VALUES(fichas_aplicadas),
                    flag_f01 = VALUES(flag_f01), flag_f02 = VALUES(flag_f02),
                    flag_f03 = VALUES(flag_f03), flag_f04 = VALUES(flag_f04),
                    flag_f05 = VALUES(flag_f05), qtd_regras = VALUES(qtd_regras),
                    valor_ressarcimento_estimado = VALUES(valor_ressarcimento_estimado),
                    resultado_salvo_em           = VALUES(resultado_salvo_em)
            """, (
                fid, row["UC"], row["Cod_Empresa"], row["Concessionaria"],
                row["Mes_Ref"], row["Tp_Tensao"], row["NroMedidor"],
                row["RAZAO_SOCIAL"], row["Link"], row["RS_Total_Fatura"],
                flags["flag_f01"], flags["flag_f02"], flags["flag_f03"],
                flags["flag_f04"], flags["flag_f05"],
                qtd, fichas, fichas,
                status, texto[:65000], valor,
                row["ia_analisado_em"],
            ))
            conn.commit()
            ok += 1
            if fichas:
                log.info(f"  id={fid} UC={row['UC']} → {status} | fichas={fichas} | valor={valor}")
        except Exception as e:
            log.warning(f"  id={fid} erro: {e}")
            erro += 1

    log.info(f"\nConcluído: {ok} migrados | {erro} erros")
    cur.close()
    conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--empresa", type=int, nargs="+", default=None)
    parser.add_argument("--force",   action="store_true",
                        help="Re-migrar mesmo quem já tem resultado_ia em fichas_anomalias_cache")
    args = parser.parse_args()
    main(empresas=args.empresa, force=args.force)
