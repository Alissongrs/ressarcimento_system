#!/usr/bin/env python3
"""
Corrige valor_total_fatura em FATURA_DADOS_EXTRAIDOS onde o pipeline
capturou erroneamente o "Valor dos Tributos" em vez do total real.

O problema ocorre em faturas ENEL SP (e similares) onde o valor total
aparece no boleto no formato "<COD_BARRAS> DD MMM YYYY VALOR" sem prefixo R$.
O fallback max(R$) do pipeline pegava o único R$ no texto: "Valor dos Tributos".

Este script:
  1. Busca todos os registros com texto_plumber preenchido
  2. Reaplicar o novo regex de boleto sobre texto_plumber
  3. Onde o valor extraído difere do armazenado, atualiza e loga
"""
import re
import sys
from pathlib import Path
import mysql.connector

DB_CONFIG = dict(
    host="db-acesso-ressarcimento.cvicxzrqb58o.us-east-2.rds.amazonaws.com",
    port=3306,
    user="super_user_ressarcimento",
    password="qZ8YbD3GxK9uN4RmV2sAeT7LwBjCp5X0",
    database="db_ressarcimento",
    ssl_disabled=True,
    use_pure=True,
)

_MESES_PT = r"(?:JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)"
_PAT_BOLETO = re.compile(
    r"\d{5,}[\s\d]*\b(\d{2})\s+" + _MESES_PT + r"\s+(\d{4})\s+([\d\.]+,\d{2})\b",
    re.IGNORECASE,
)


def _num(s: str) -> float | None:
    if not s:
        return None
    try:
        return float(s.replace(".", "").replace(",", "."))
    except ValueError:
        return None


def extrair_valor_boleto(texto: str) -> float | None:
    m = _PAT_BOLETO.search(texto)
    if m:
        return _num(m.group(3))
    return None


UID_FILE = Path(__file__).parent / "uids_valor_corrigido.txt"


def main(dry_run: bool = True):
    conn = mysql.connector.connect(**DB_CONFIG)
    cur_read  = conn.cursor(dictionary=True, buffered=True)
    cur_write = conn.cursor()

    print(f"[modo] {'DRY-RUN (sem alteracoes)' if dry_run else 'GRAVANDO no banco'}")

    # Busca registros que têm texto_plumber preenchido
    cur_read.execute("""
        SELECT uid, mes_referencia, codigo_uc, valor_total_fatura, texto_plumber
        FROM FATURA_DADOS_EXTRAIDOS
        WHERE texto_plumber IS NOT NULL AND texto_plumber != ''
        ORDER BY id
    """)

    total = 0
    corrigidos = 0
    sem_match = 0
    uids_corrigidos: list[str] = []

    for row in cur_read:
        total += 1
        uid           = row["uid"]
        valor_atual   = float(row["valor_total_fatura"] or 0)
        texto         = row["texto_plumber"]

        novo_valor = extrair_valor_boleto(texto)
        if novo_valor is None:
            sem_match += 1
            continue

        # Ignora extração inválida (0 ou negativo)
        if novo_valor <= 0:
            sem_match += 1
            continue

        # Só atualiza se diferença > R$ 1,00 (evita ajustes por arredondamento)
        if abs(novo_valor - valor_atual) < 1.0:
            continue

        corrigidos += 1
        uids_corrigidos.append(uid)
        uc  = row["codigo_uc"] or ""
        mes = row["mes_referencia"] or ""
        print(f"  [{uid}] UC={uc} {mes}: {valor_atual:,.2f} -> {novo_valor:,.2f}")

        if not dry_run:
            cur_write.execute(
                "UPDATE FATURA_DADOS_EXTRAIDOS SET valor_total_fatura = %s WHERE uid = %s",
                (novo_valor, uid),
            )

    if not dry_run:
        conn.commit()

    print(f"\n[resumo] analisados={total} | sem_padrao_boleto={sem_match} | corrigidos={corrigidos}")

    if not dry_run and uids_corrigidos:
        UID_FILE.write_text("\n".join(uids_corrigidos), encoding="utf-8")
        print(f"  -> UIDs gravados em: {UID_FILE}")
        print(f"  -> Para reprocessar a IA: python pipeline.py --uid-arquivo {UID_FILE}")
    elif dry_run and corrigidos > 0:
        print("  -> rode com argumento --aplicar para gravar as correcoes")

    cur_read.close()
    cur_write.close()
    conn.close()


if __name__ == "__main__":
    dry_run = "--aplicar" not in sys.argv
    main(dry_run=dry_run)
