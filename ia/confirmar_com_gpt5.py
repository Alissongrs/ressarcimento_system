#!/usr/bin/env python3
"""
confirmar_com_gpt5.py
─────────────────────
Processa APENAS faturas já marcadas como CONFIRMADO com gpt-4.1-mini
e as re-analisa com gpt-5.4 + PDF para confirmação final.

Uso:
    python confirmar_com_gpt5.py                    # processa todos os confirmados
    python confirmar_com_gpt5.py --empresa 14       # apenas empresa 14
    python confirmar_com_gpt5.py --limite 10        # máximo 10 faturas
    python confirmar_com_gpt5.py --empresa 14 --limite 5

Resultado: salva em fichas_anomalias_cache com modelo_ia='gpt-5.4'
"""

import argparse
import base64
import io
import json
import logging
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

import mysql.connector
import requests

try:
    import pypdfium2 as pdfium
    HAS_PDFIUM = True
except ImportError:
    HAS_PDFIUM = False

# ─── Configuração ─────────────────────────────────────────────────────────────
OPENAI_API_KEY   = os.getenv("OPENAI_API_KEY", "")
MODELO_CONFIRMACAO = "gpt-5.4"
OPENAI_BASE_URL  = "https://api.openai.com"
OPENAI_TIMEOUT   = 300

MAX_PAGINAS_PDF = 4
ESCALA_PDF      = 2.0
PAUSA_ENTRE     = 1.5

# ─── Banco ────────────────────────────────────────────────────────────────────
DB_APP = dict(
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

# ─── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level    = logging.INFO,
    format   = "%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt  = "%Y-%m-%d %H:%M:%S",
    handlers = [
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("confirmar_gpt5.log", encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)

# ─── Utilitários ──────────────────────────────────────────────────────────────

def _sanitize(text: str) -> str:
    """Remove caracteres inválidos para UTF-8."""
    if not isinstance(text, str):
        text = str(text) if text is not None else ""
    return text.encode("utf-8", errors="surrogatepass").decode("utf-8", errors="ignore")

def pdf_bytes_para_imagens(pdf_bytes: bytes) -> list[dict]:
    """Converte PDF em lista de imagens base64 PNG."""
    if not HAS_PDFIUM:
        log.warning("pypdfium2 não instalado — sem visão de imagem")
        return []
    try:
        pdf = pdfium.PdfDocument(pdf_bytes)
        imagens = []
        for i in range(min(len(pdf), MAX_PAGINAS_PDF)):
            page = pdf[i]
            bitmap = page.render(scale=ESCALA_PDF)
            pil_img = bitmap.to_pil()
            buf = io.BytesIO()
            pil_img.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode()
            imagens.append({"base64": b64, "mime": "image/png", "pagina": i + 1})
        return imagens
    except Exception as e:
        log.warning(f"    Erro ao converter PDF: {e}")
        return []

def baixar_pdf(url: str) -> bytes | None:
    try:
        r = requests.get(url, timeout=30, stream=True)
        r.raise_for_status()
        return r.content
    except Exception as e:
        log.warning(f"    Falha no download: {e}")
        return None

def carregar_prompt() -> str:
    """Carrega o prompt de confirmação."""
    prompt_paths = [
        Path(__file__).parent.parent / "backend" / "data" / "prompt_confirmar.txt",
        Path("data") / "prompt_confirmar.txt",
    ]
    for p in prompt_paths:
        if p.exists():
            return p.read_text(encoding="utf-8")
    log.error("prompt_confirmar.txt não encontrado")
    return ""

# ─── Busca e confirmação ───────────────────────────────────────────────────────

def buscar_confirmados(cur, empresa_id=None, limite=None):
    """Busca faturas com ia_status=CONFIRMADO em fichas_anomalias_cache para verificar com gpt-5.4."""
    sql = """
        SELECT
            fac.id, fac.UC, fac.Mes_Ref, fac.Link,
            frc.analise_IA, frc.Cod_Empresa, frc.Concessionaria, frc.Tp_Tensao, frc.NroMedidor,
            frc.RAZAO_SOCIAL, frc.RS_Total_Fatura,
            frc.KWH_Ponta, frc.KWH_FPonta, frc.KWH_Reservado, frc.KWH_Total,
            frc.Leitura_Anterior_KWH_P, frc.Leitura_Atual_KWH_P,
            frc.Leitura_Anterior_KWH_FP, frc.Leitura_Atual_KWH_FP,
            frc.Constante_KWH_P, frc.Constante_KWH_FP,
            frc.Base_de_Calculo_ICMS, frc.Aliquota_ICMS, frc.ICMS_RS, frc.CIP,
            frc.Dt_Venc_NF,
            frc.texto_plumber, frc.texto_markitdown, frc.texto_ocr,
            frc.resultado_analises, frc.resultado_final_em
        FROM fichas_anomalias_cache fac
        JOIN Faturas_Registradas_Cache frc ON fac.id = frc.id
        WHERE fac.ia_status = 'CONFIRMADO'
          AND fac.deletado = 0
          AND frc.Link IS NOT NULL
    """
    params = []

    if empresa_id:
        sql += " AND fac.Cod_Empresa = %s"
        params.append(empresa_id)

    sql += " ORDER BY fac.id ASC"

    if limite:
        sql += f" LIMIT {limite}"

    cur.execute(sql, params)
    return cur.fetchall()

def confirmar_com_gpt5(faturas: list, prompt: str, cur, conn):
    """Re-analisa com gpt-5.4 + imagens os casos CONFIRMADO pelo mini."""
    log.info(f"\n{'═'*70}")
    log.info(f"CONFIRMAÇÃO: {len(faturas)} fatura(s) com {MODELO_CONFIRMACAO} + PDF")
    log.info('═' * 70)

    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }

    ok = erro = 0
    cnt = {"CONFIRMADO": 0, "FALSO_POSITIVO": 0, "INCONCLUSIVO": 0}

    for i, fatura in enumerate(faturas, 1):
        fid = fatura["id"]
        uc = fatura["UC"]
        mes = str(fatura["Mes_Ref"])[:7]
        link = str(fatura.get("Link") or "").strip()

        log.info(f"  [{i}/{len(faturas)}] ID={fid} UC={uc} Mês={mes}")

        if not link:
            log.warning(f"    Sem Link — pulando")
            continue

        # 1. Baixa PDF e extrai imagens
        pdf_bytes = baixar_pdf(link)
        imagens = pdf_bytes_para_imagens(pdf_bytes) if pdf_bytes else []
        log.info(f"    {len(imagens)} página(s) extraída(s)")

        # 2. Monta contexto com dados da fatura + resultado anterior + extrações
        resultado_mini = fatura.get("analise_IA", "{}")
        try:
            dados_mini = json.loads(resultado_mini)
        except:
            dados_mini = {}

        # Dados da fatura do banco
        contexto = f"""VERIFICAÇÃO FINAL COM GPT-5.4
═══════════════════════════════════════════════════════════════

DADOS DA FATURA (do banco):
──────────────────────────
UC: {fatura.get('UC')}
Mês: {mes}
Concessionária: {fatura.get('Concessionaria')}
Cliente: {fatura.get('RAZAO_SOCIAL')}
Total Fatura: R$ {fatura.get('RS_Total_Fatura', 0)}
Vencimento: {fatura.get('Dt_Venc_NF', '—')}

Dados Técnicos:
  Tensão: {fatura.get('Tp_Tensao', '—')}
  Medidor: {fatura.get('NroMedidor', '—')}
  KWH Ponta: {fatura.get('KWH_Ponta', '—')}
  KWH Fora Ponta: {fatura.get('KWH_FPonta', '—')}
  KWH Total: {fatura.get('KWH_Total', '—')}
  Leitura Ant. P: {fatura.get('Leitura_Anterior_KWH_P', '—')} → Atual: {fatura.get('Leitura_Atual_KWH_P', '—')}
  Leitura Ant. FP: {fatura.get('Leitura_Anterior_KWH_FP', '—')} → Atual: {fatura.get('Leitura_Atual_KWH_FP', '—')}
  Constante P: {fatura.get('Constante_KWH_P', '—')} | Constante FP: {fatura.get('Constante_KWH_FP', '—')}
  ICMS: {fatura.get('Aliquota_ICMS', '—')} | CIP: R$ {fatura.get('CIP', 0)}

RESULTADO ANTERIOR (GPT-4.1-MINI):
──────────────────────────────────
Status: {dados_mini.get('ia_status', '?')}
Fichas: {dados_mini.get('ia_fichas_confirmadas', '—')}
Valor estimado: R$ {dados_mini.get('valor_ressarcimento_estimado', 0):.2f}
Detalhes: {dados_mini.get('detalhamento', '—')}

EXTRAÇÕES REALIZADAS ANTERIORMENTE:
────────────────────────────────────
"""

        # Inclui as extrações que já foram feitas
        plumber = str(fatura.get("texto_plumber") or "").strip()
        if plumber and not plumber.startswith("[ERRO_"):
            contexto += f"\n=== PLUMBER (extração direta do PDF) ===\n{plumber}\n"

        ocr = str(fatura.get("texto_ocr") or "").strip()
        if ocr and not ocr.startswith("[ERRO_"):
            contexto += f"\n=== OCR (leitura visual) ===\n{ocr}\n"

        md = str(fatura.get("texto_markitdown") or "").strip()
        if md and not md.startswith("[ERRO_"):
            contexto += f"\n=== MARKITDOWN (estrutura da fatura) ===\n{md}\n"

        if not (plumber or ocr or md):
            contexto += "(Nenhuma extração anterior disponível)"

        contexto += """

TAREFA PARA GPT-5.4:
───────────────────
Verifique as imagens do PDF abaixo e VALIDE o diagnóstico do gpt-4.1-mini:
1. CONFIRME se as fichas estão corretas (dados batem com PDF + banco)
2. REVISE se há erros na extração ou diagnóstico anterior
3. REJEITE se foi um falso positivo

Responda em JSON com: ia_status, ia_fichas_confirmadas, valor_ressarcimento_estimado, detalhamento.
"""

        # 3. Constrói request com array de content
        user_content = [{"type": "text", "text": _sanitize(contexto)}]
        for img in imagens:
            user_content.append({
                "type": "image_url",
                "image_url": {"url": f"data:{img['mime']};base64,{img['base64']}", "detail": "high"},
            })

        body = {
            "model": MODELO_CONFIRMACAO,
            "max_completion_tokens": 2048,
            "messages": [
                {"role": "system", "content": _sanitize(prompt)},
                {"role": "user", "content": user_content},
            ],
        }

        # 4. Envia para gpt-5.4
        try:
            log.info(f"    Enviando para {MODELO_CONFIRMACAO}...")
            r = requests.post(
                f"{OPENAI_BASE_URL}/v1/chat/completions",
                headers=headers,
                json=body,
                timeout=OPENAI_TIMEOUT,
            )

            if r.status_code != 200:
                log.error(f"    HTTP {r.status_code}")
                try:
                    error_detail = r.json()
                    error_msg = error_detail.get('error', {}).get('message', '?')
                    log.error(f"    Erro: {error_msg}")
                except:
                    log.error(f"    Response: {r.text[:200]}")
                erro += 1
                time.sleep(PAUSA_ENTRE)
                continue

            resposta = r.json()["choices"][0]["message"]["content"]
            log.info(f"    ✓ Resposta recebida ({len(resposta)} chars)")

            # 5. Salva resultado_analises em Faturas_Registradas_Cache
            try:
                # Monta JSON com observação (não interploa resposta direto)
                resultado_dict = {
                    "modelo": MODELO_CONFIRMACAO,
                    "observacao": "Verificado com OpenAI 5.4",
                    "resultado": _sanitize(resposta)[:65000]
                }
                resultado_json = json.dumps(resultado_dict, ensure_ascii=True)

                sql_update = """
                    UPDATE Faturas_Registradas_Cache
                    SET resultado_analises = %s,
                        resultado_final_em = NOW()
                    WHERE id = %s
                """
                cur.execute(sql_update, (resultado_json, fid))
                conn.commit()
                log.info(f"    ✓ Salvo em resultado_analises")
                ok += 1
                cnt["CONFIRMADO"] += 1
            except Exception as e:
                log.error(f"    Erro ao salvar: {e}")
                erro += 1

        except requests.exceptions.RequestException as e:
            log.error(f"    Erro na requisição: {e}")
            erro += 1
        except Exception as e:
            log.error(f"    Erro inesperado: {e}")
            erro += 1

        time.sleep(PAUSA_ENTRE)

    log.info(f"\n{'═'*70}")
    log.info(f"RESUMO: {ok} confirmados | {erro} erros")
    log.info('═' * 70)

    return ok, erro, cnt

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Confirma faturas CONFIRMADO com gpt-5.4"
    )
    parser.add_argument("--empresa", type=int, help="ID da empresa (ex: 14)")
    parser.add_argument("--limite", type=int, help="Máximo de faturas a processar")
    args = parser.parse_args()

    log.info(f"Iniciando confirmação com {MODELO_CONFIRMACAO}")
    log.info(f"Empresa: {args.empresa or 'todas'}")
    log.info(f"Limite: {args.limite or 'sem limite'}")

    # Carrega prompt
    prompt = carregar_prompt()
    if not prompt:
        log.error("Prompt não carregado. Abortando.")
        return 1

    # Conecta ao banco
    try:
        conn = mysql.connector.connect(**DB_APP)
        cur = conn.cursor(dictionary=True)
    except Exception as e:
        log.error(f"Erro de conexão: {e}")
        return 1

    # Busca faturas confirmadas
    faturas = buscar_confirmados(cur, empresa_id=args.empresa, limite=args.limite)
    log.info(f"\n{len(faturas)} fatura(s) encontrada(s) para confirmação")

    if not faturas:
        log.info("Nenhuma fatura para processar.")
        cur.close()
        conn.close()
        return 0

    # Processa com gpt-5.4
    ok, erro, cnt = confirmar_com_gpt5(faturas, prompt, cur, conn)

    # Relatório final
    log.info(f"\nRELATÓRIO FINAL")
    log.info(f"═" * 70)
    log.info(f"Total processado: {ok + erro}")
    log.info(f"  ✓ Sucesso:      {ok}")
    log.info(f"  ✗ Erro:         {erro}")
    log.info(f"Custo estimado: ~${len(faturas) * 0.003:.2f} (contexto longo)")

    cur.close()
    conn.close()
    return 0 if erro == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
