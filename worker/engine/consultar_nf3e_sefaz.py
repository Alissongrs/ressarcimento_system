"""Consulta NF3e SEFAZ por chave de acesso.

Handler-por-UF baseado nos 2 primeiros dígitos da chave NF3e (44 dígitos).
Cache permanente em SQLite local. Retry com backoff. TLS legacy quando necessário.

Uso:
    from consultar_nf3e_sefaz import consultar_nf3e
    dados = consultar_nf3e("33260433050071000158660001289471541091540115")
    # dados = {chave, uf, emitente, destinatario, itens[], valor_total, ...}

Modo C (batch-once + cache permanente): a primeira consulta vai pra rede,
todas as próximas vêm do cache local. Pipeline diário fica 100% offline.
"""
from __future__ import annotations
import os
import re
import sys
import json
import time
import sqlite3
import hashlib
import logging
import html as _html
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Optional, Callable
from urllib.parse import urlparse, parse_qs

import requests
import urllib3
import ssl
from requests.adapters import HTTPAdapter
from urllib3.util.ssl_ import create_urllib3_context

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

LOG = logging.getLogger("nf3e_sefaz")

# ────────────────────────────────────────────────────────────────────────────
# Tabela UF (2 primeiros dígitos da chave NF3e)
# ────────────────────────────────────────────────────────────────────────────
UF_CODIGO = {
    "11": "RO", "12": "AC", "13": "AM", "14": "RR", "15": "PA", "16": "AP", "17": "TO",
    "21": "MA", "22": "PI", "23": "CE", "24": "RN", "25": "PB", "26": "PE", "27": "AL", "28": "SE", "29": "BA",
    "31": "MG", "32": "ES", "33": "RJ", "35": "SP",
    "41": "PR", "42": "SC", "43": "RS",
    "50": "MS", "51": "MT", "52": "GO", "53": "DF",
}

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

# ────────────────────────────────────────────────────────────────────────────
# Cache SQLite (Modo C)
# ────────────────────────────────────────────────────────────────────────────
_CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_cache_sefaz.db")


def _cache_init():
    cn = sqlite3.connect(_CACHE_PATH)
    cn.execute("""
        CREATE TABLE IF NOT EXISTS sefaz_cache (
            chave        TEXT PRIMARY KEY,
            uf           TEXT,
            dados_json   TEXT,
            status       TEXT,
            http_status  INTEGER,
            erro         TEXT,
            consultado_em TEXT,
            html_hash    TEXT
        )
    """)
    # WAL: leitores e escritores concorrentes não se bloqueiam (necessário p/ o
    # backfill em pool de threads). Persiste no arquivo .db — set uma vez basta.
    try:
        cn.execute("PRAGMA journal_mode=WAL")
    except Exception:
        pass
    cn.commit()
    cn.close()


def cache_get(chave: str) -> Optional[dict]:
    _cache_init()
    cn = sqlite3.connect(_CACHE_PATH, timeout=30)
    cn.execute("PRAGMA busy_timeout=30000")  # espera lock até 30s em vez de falhar
    cur = cn.execute("SELECT dados_json, status FROM sefaz_cache WHERE chave=? AND status='ok'", (chave,))
    row = cur.fetchone()
    cn.close()
    if not row:
        return None
    try:
        return json.loads(row[0])
    except json.JSONDecodeError:
        return None


def cache_put(chave: str, uf: str, dados: Optional[dict], status: str,
              http_status: int = 0, erro: str = "", html_raw: str = ""):
    _cache_init()
    cn = sqlite3.connect(_CACHE_PATH, timeout=30)
    cn.execute("PRAGMA busy_timeout=30000")  # espera lock até 30s em vez de falhar
    cn.execute(
        "INSERT OR REPLACE INTO sefaz_cache (chave, uf, dados_json, status, http_status, erro, consultado_em, html_hash) VALUES (?,?,?,?,?,?,?,?)",
        (
            chave, uf,
            json.dumps(dados, ensure_ascii=False) if dados else None,
            status, http_status, erro,
            datetime.now(timezone.utc).isoformat(timespec="seconds"),
            hashlib.sha256(html_raw.encode("utf-8", errors="ignore")).hexdigest()[:16] if html_raw else "",
        )
    )
    cn.commit()
    cn.close()


# ────────────────────────────────────────────────────────────────────────────
# TLS legacy adapter (necessário para SVRS-RS)
# ────────────────────────────────────────────────────────────────────────────
class _TLSLegacyAdapter(HTTPAdapter):
    def init_poolmanager(self, *args, **kwargs):
        ctx = create_urllib3_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        # OP_LEGACY_SERVER_CONNECT (0x4) — SVRS exige unsafe legacy renegotiation
        try:
            ctx.options |= 0x4
        except Exception:
            pass
        ctx.set_ciphers("DEFAULT@SECLEVEL=0:ALL:@SECLEVEL=0")
        kwargs["ssl_context"] = ctx
        return super().init_poolmanager(*args, **kwargs)


def _new_session(tls_legacy: bool = False) -> requests.Session:
    s = requests.Session()
    if tls_legacy:
        s.mount("https://", _TLSLegacyAdapter())
    s.headers["User-Agent"] = USER_AGENT
    s.headers["Accept-Language"] = "pt-BR,pt;q=0.9"
    return s


# ────────────────────────────────────────────────────────────────────────────
# Parser HTML → dict normalizado (compartilhado entre handlers)
# ────────────────────────────────────────────────────────────────────────────
def _html_to_text(html_raw: str) -> str:
    """Remove scripts/styles/imagens base64 e tags, normaliza whitespace."""
    h = re.sub(r"<script.*?</script>|<style.*?</style>", "", html_raw, flags=re.S)
    h = re.sub(r'src="data:image[^"]+"', "", h)
    txt = re.sub(r"<[^>]+>", " ", h)
    txt = _html.unescape(txt)
    txt = re.sub(r"\s+", " ", txt).strip()
    return txt


# Classificação de CCI (Código de Classificação de Item ANEEL) — Tabela CONFAZ/ANEEL
# Fonte: tabela 4 do MOC NF3e (Manual de Orientação ao Contribuinte) e Despacho ANEEL.
_CCI_TIPOS = {
    # 06xx → Energia Ativa Fornecida (FATURAMENTO PRINCIPAL — positivo)
    "0601": "energia_ativa_fornecida",       # 0601001=TE, 0601002=TUSD, 0601000=combinado
    "0602": "energia_ativa_isenta",
    "0603": "energia_ativa_isenta_tusd",
    # 08xx → Outros encargos (positivo)
    "0801": "iluminacao_publica",            # CIP/COSIP
    "0802": "doacao",
    "0803": "outros",
    "0807": "cip_outros",
    # 56xx → Energia Compensada GD (CRÉDITO — subtrai do total)
    "5603": "compensacao_gd_propria",        # mUC (própria UC, ou simples GD)
    "5604": "compensacao_gd_outras",         # oUC (outras UCs / geradora externa)
    # 04xx, 05xx → Bandeiras, multas, juros (a confirmar)
    "0401": "bandeira",
    "0900": "multa_juros",
    # 23xx → Devoluções, restituições
    "2301": "devolucao",
    "2302": "restituicao",
}


def _classificar_cci(cci: str) -> str:
    """Retorna o tipo inferido pelo prefixo do CCI."""
    if not cci or len(cci) < 4: return "desconhecido"
    return _CCI_TIPOS.get(cci[:4], _CCI_TIPOS.get(cci[:3] + "0", "desconhecido"))


def _br_to_float(s: str) -> Optional[float]:
    """Tenta converter número BR (1.234,56) ou US (1234.56) para float."""
    if not s: return None
    s = s.strip()
    # Heurística: se tem vírgula e ponto, ponto é milhar; se só vírgula, é decimal BR
    if "," in s and "." in s:
        # Formato BR: 1.234,56
        s = s.replace(".", "").replace(",", ".")
    elif "," in s:
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def _parse_html_nf3e(html_raw: str, chave: str, fonte: str) -> dict:
    """Parse comum do HTML da consulta NF3e (estrutura semelhante MT e SVRS).

    Retorna dict normalizado. Campos podem ser None se não detectados.
    """
    texto = _html_to_text(html_raw)
    uf = UF_CODIGO.get(chave[:2], "??")

    out: dict = {
        "chave_acesso": chave,
        "uf": uf,
        "modelo": chave[20:22],
        "serie": chave[22:25].lstrip("0") or "0",
        "numero": chave[25:34].lstrip("0") or "0",
        "cnpj_emissor_chave": chave[6:20],
        "data_emissao": None,
        "data_emissao_iso": None,
        "emitente": {"cnpj": None, "razao_social": None, "ie": None, "municipio": None, "uf": uf},
        "destinatario": {"cnpj_mascarado": None, "razao_mascarada": None, "municipio": None},
        "valor_total": None,
        "valor_total_numerico": None,
        "qtd_itens": 0,
        "itens": [],
        "protocolo_autorizacao": None,
        "data_autorizacao": None,
        "digest_value": None,
        "_fonte": fonte,
        "_consultado_em": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "_texto_raw_len": len(texto),
    }

    # Data/hora emissão: aparece sempre antes de 'Emitente' (1ª data com timezone do texto)
    m = re.search(r"(\d{2}/\d{2}/\d{4}\s+\d{2}:\d{2}:\d{2}(?:\s*[-+]\d{2}:\d{2})?)\s+\d+\s+Emitente", texto)
    if m:
        out["data_emissao"] = m.group(1).strip()

    # Emitente (MT traz tudo; RJ omite por privacidade às vezes)
    m_emit = re.search(
        r"Emitente\s+(?:CNPJ\s+Raz[ãa]o\s+Social\s+IE\s+UF\s+)?"
        r"(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2})\s+([A-ZÀ-Ÿ][^\n]{2,80}?)\s+(\d{6,15})\s+([A-Z]{2})\s+Munic[ií]pio\s+([A-ZÀ-Ÿ][^\n]{2,40}?)\s+Destinat[áa]rio",
        texto, re.I
    )
    if m_emit:
        out["emitente"]["cnpj"] = m_emit.group(1)
        out["emitente"]["razao_social"] = m_emit.group(2).strip()
        out["emitente"]["ie"] = m_emit.group(3)
        out["emitente"]["uf"] = m_emit.group(4)
        out["emitente"]["municipio"] = m_emit.group(5).strip()
    else:
        # Fallback: só município emitente (SVRS-RJ)
        m_mun = re.search(r"Emitente\s+Munic[ií]pio\s+([A-ZÀ-Ÿ][^\n]{2,40}?)\s+Destinat[áa]rio", texto, re.I)
        if m_mun:
            out["emitente"]["municipio"] = m_mun.group(1).strip()

    # Destinatário (sempre mascarado por privacidade)
    m_dest = re.search(
        r"Destinat[áa]rio\s+(?:CNPJ\s+Raz[ãa]o\s+Social\s+IE\s+UF\s+)?"
        r"([\*\.\d/\-]+)\s+([A-Z][\*A-Z0-9 ]+?)\s+(?:\d+)?\s*[A-Z]{2}\s+Munic[ií]pio\s+([A-ZÀ-Ÿ][^\n]{2,40}?)\s+Produtos",
        texto, re.I
    )
    if m_dest:
        out["destinatario"]["cnpj_mascarado"] = m_dest.group(1)
        out["destinatario"]["razao_mascarada"] = m_dest.group(2).strip()
        out["destinatario"]["municipio"] = m_dest.group(3).strip()
    else:
        m_mun_d = re.search(r"Destinat[áa]rio\s+Munic[ií]pio\s+([A-ZÀ-Ÿ][^\n]{2,40}?)\s+Produtos", texto, re.I)
        if m_mun_d:
            out["destinatario"]["municipio"] = m_mun_d.group(1).strip()

    # Itens: pattern '<N> <CCI> <DESC...> <UN> - <NOME_UNID> <QTD> <TARIFA> <TOTAL>'
    # MT: '1 0601000 C... 2 - kWh 12382.0000 1.08916073 13485.98'
    # RJ: '1 0801000 C... 5 - Descrição (uMed) não tratada 1.0000 145.9000000000 145.90'
    itens_inicio = texto.find("Produtos")
    itens_fim = texto.find("Eventos e Servi")
    if itens_inicio > 0 and itens_fim > itens_inicio:
        secao = texto[itens_inicio:itens_fim]
        pat = re.compile(
            r"(\d{1,3})\s+"                              # nº item (group 1)
            r"(\d{7})\s+"                                # código CCI 7 dígitos (group 2)
            r"([A-Z]\.{1,5})\s+"                         # descrição abreviada C... E... (group 3)
            r"(\d+)\s+-\s+"                              # cód unidade + traço (group 4)
            r"([^\d][^\n]{1,50}?)\s+"                    # nome unidade lazy (group 5: 'kWh' ou 'Descrição (uMed)...')
            r"(\d+(?:[.,]\d+)?)\s+"                      # quantidade (group 6)
            r"(\d+(?:\.\d+)?)\s+"                        # tarifa US 10 casas (group 7)
            r"([\d.,]+?)(?=\s+\d+\s+\d{7}\s+[A-Z]\.|\s+Eventos|\s*$)",  # total (group 8) — lookahead pra próximo item ou fim
            re.I
        )
        for m in pat.finditer(secao):
            qtd = m.group(6)
            qtd_num = float(qtd.replace(",", ".")) if qtd else None
            tar_num = float(m.group(7))
            val_num = _br_to_float(m.group(8))
            cci = m.group(2)
            tipo = _classificar_cci(cci)
            sinal = -1 if tipo in ("compensacao_gd_propria", "compensacao_gd_outras") else 1
            item = {
                "numero": int(m.group(1)),
                "codigo_cci": cci,
                "tipo_inferido": tipo,
                "sinal": sinal,
                "descricao_abrev": m.group(3),
                "unidade_codigo": m.group(4),
                "unidade_nome": m.group(5).strip(),
                "quantidade_string": qtd,
                "quantidade_numerica": qtd_num,
                "tarifa_unitaria_string": m.group(7),
                "tarifa_unitaria_numerica": tar_num,
                "valor_total_string": m.group(8),
                "valor_total_numerico": val_num,
                "valor_efetivo_numerico": (val_num * sinal) if val_num is not None else None,
            }
            out["itens"].append(item)
        out["qtd_itens"] = len(out["itens"])

        # Valor total LÍQUIDO = soma dos valores com sinal (créditos GD subtraem)
        soma_liq = sum((it["valor_efetivo_numerico"] or 0) for it in out["itens"])
        soma_bruta = sum((it["valor_total_numerico"] or 0) for it in out["itens"])
        out["valor_total_liquido_numerico"] = round(soma_liq, 2)
        out["valor_total_liquido"] = f"{soma_liq:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
        out["valor_total_bruto_numerico"] = round(soma_bruta, 2)
        out["valor_total_bruto"] = f"{soma_bruta:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
        # Compat retro: valor_total = líquido (é o que bate com R$ a pagar na fatura)
        out["valor_total"] = out["valor_total_liquido"]
        out["valor_total_numerico"] = out["valor_total_liquido_numerico"]

    # Protocolo
    m_prot = re.search(r"Autoriza[çc][ãa]o de Uso\s+(\d{15,20})\s+(\d{2}/\d{2}/\d{4}\s+\d{2}:\d{2}:\d{2}(?:\s*[-+]\d{2}:\d{2})?)", texto)
    if m_prot:
        out["protocolo_autorizacao"] = m_prot.group(1)
        out["data_autorizacao"] = m_prot.group(2).strip()

    # Digest
    m_dig = re.search(r"Digest Value\s+([A-Za-z0-9+/=]+)", texto)
    if m_dig:
        out["digest_value"] = m_dig.group(1)

    return out


# ────────────────────────────────────────────────────────────────────────────
# Handler: SEFAZ-MT (GET direto, sem TLS legacy)
# ────────────────────────────────────────────────────────────────────────────
def _handler_sefaz_mt(chave: str) -> tuple[Optional[dict], int, str]:
    url = f"https://www.sefaz.mt.gov.br/nf3e/QRCode?chNF3e={chave}&tpAmb=1"
    s = _new_session(tls_legacy=False)
    try:
        r = s.get(url, timeout=30, verify=False)
        if r.status_code != 200 or len(r.text) < 1000:
            return None, r.status_code, f"resposta vazia ou status {r.status_code}"
        dados = _parse_html_nf3e(r.text, chave, "sefaz_mt")
        return dados, 200, ""
    except requests.RequestException as e:
        return None, 0, f"{type(e).__name__}: {str(e)[:200]}"


# ────────────────────────────────────────────────────────────────────────────
# Handler: SVRS-RS (POST com cookies + TLS legacy — cobre RJ, PR, RS, BA, PE, etc)
# ────────────────────────────────────────────────────────────────────────────
def _handler_svrs(chave: str) -> tuple[Optional[dict], int, str]:
    base_url = "https://dfe-portal.svrs.rs.gov.br"
    url_get = f"{base_url}/nf3e/QRCode?chNF3e={chave}&tpAmb=1"
    url_post = f"{base_url}/Nf3e/QrCode"
    s = _new_session(tls_legacy=True)
    try:
        r1 = s.get(url_get, timeout=30, verify=False)
        if r1.status_code != 200:
            return None, r1.status_code, f"GET inicial falhou: {r1.status_code}"
        post_data = {
            "pesq.Sistema": "Nf3e",
            "pesq.tpAmb": "1",
            "pesq.chBpe": chave,
            "pesq.chCte": chave,
            "pesq.chMdfe": chave,
        }
        # Referer+Origin obrigatórios pra SVRS-RS aceitar o POST
        headers_post = {
            "Referer": url_get,
            "Origin": base_url,
            "Content-Type": "application/x-www-form-urlencoded",
        }
        r2 = s.post(url_post, data=post_data, headers=headers_post,
                    timeout=30, verify=False, allow_redirects=True)
        if r2.status_code != 200:
            return None, r2.status_code, f"POST status {r2.status_code}"
        # Detecta resposta de erro "205 - NF3E não consta na base" (UF não atendida)
        if "não consta na nossa base" in r2.text or "não consta na nossa base" in r2.text:
            return None, 205, "nf3e_nao_encontrada_svrs"
        if len(r2.text) < 1000:
            return None, r2.status_code, f"POST vazio ({len(r2.text)} bytes)"
        dados = _parse_html_nf3e(r2.text, chave, "svrs")
        return dados, 200, ""
    except requests.RequestException as e:
        return None, 0, f"{type(e).__name__}: {str(e)[:200]}"


# ────────────────────────────────────────────────────────────────────────────
# Roteador por UF
# ────────────────────────────────────────────────────────────────────────────
_HANDLERS_POR_UF = {
    # UFs com portal próprio confirmado
    "MT": _handler_sefaz_mt,
    # Todos os demais: SVRS-RS (autorizador NF3e padrão CONFAZ)
    "RO": _handler_svrs, "AC": _handler_svrs, "AM": _handler_svrs, "RR": _handler_svrs,
    "PA": _handler_svrs, "AP": _handler_svrs, "TO": _handler_svrs,
    "MA": _handler_svrs, "PI": _handler_svrs, "CE": _handler_svrs, "RN": _handler_svrs,
    "PB": _handler_svrs, "PE": _handler_svrs, "AL": _handler_svrs, "SE": _handler_svrs, "BA": _handler_svrs,
    "MG": _handler_svrs, "ES": _handler_svrs, "RJ": _handler_svrs, "SP": _handler_svrs,
    "PR": _handler_svrs, "SC": _handler_svrs, "RS": _handler_svrs,
    "MS": _handler_svrs, "GO": _handler_svrs, "DF": _handler_svrs,
}


def chave_valida(chave: str) -> bool:
    """Valida formato básico da chave NF3e (44 dígitos, UF conhecida, modelo 66)."""
    if not chave or not chave.isdigit() or len(chave) != 44:
        return False
    if chave[:2] not in UF_CODIGO:
        return False
    if chave[20:22] != "66":  # Modelo NF3e = 66
        return False
    return True


def consultar_nf3e(chave: str, force_refresh: bool = False, retry: int = 2,
                   backoff_seconds: float = 2.0) -> dict:
    """Consulta NF3e por chave de acesso, com cache permanente.

    Args:
        chave: chave de acesso de 44 dígitos
        force_refresh: ignora cache e consulta de novo
        retry: número de tentativas em caso de erro de rede
        backoff_seconds: pausa inicial entre tentativas (exponencial)

    Returns:
        dict normalizado com {chave, uf, emitente, destinatario, itens, valor_total, ...}
        Em caso de erro: {chave, uf, _erro: str, _http_status: int}
    """
    # SKIP_SEFAZ (rollout): NÃO bate na rede SEFAZ (lenta/retry-sleep = gargalo ~6-15s/fatura).
    # Usa só o cache local (SQLite, rápido) se houver; senão devolve marcador. Enriquecimento
    # SEFAZ vira batch separado não-bloqueante.
    if os.environ.get("SKIP_SEFAZ"):
        _c = cache_get(chave.strip()) if chave else None
        return _c if _c else {"chave_acesso": chave, "_erro": "skip_sefaz", "uf": "??"}

    if not chave_valida(chave):
        return {"chave_acesso": chave, "_erro": "chave_invalida", "uf": UF_CODIGO.get(chave[:2] if chave else "", "??")}

    chave = chave.strip()
    uf = UF_CODIGO[chave[:2]]

    # Cache hit
    if not force_refresh:
        cached = cache_get(chave)
        if cached:
            cached["_from_cache"] = True
            return cached

    handler = _HANDLERS_POR_UF.get(uf)
    if not handler:
        erro = f"handler_nao_implementado_uf_{uf}"
        cache_put(chave, uf, None, "erro", 0, erro)
        return {"chave_acesso": chave, "uf": uf, "_erro": erro}

    ultimo_erro = ""
    ultimo_http = 0
    for tentativa in range(retry + 1):
        dados, http_status, erro = handler(chave)
        if dados:
            cache_put(chave, uf, dados, "ok", http_status)
            dados["_from_cache"] = False
            return dados
        ultimo_erro = erro
        ultimo_http = http_status
        if tentativa < retry:
            time.sleep(backoff_seconds * (2 ** tentativa))

    cache_put(chave, uf, None, "erro", ultimo_http, ultimo_erro)
    return {"chave_acesso": chave, "uf": uf, "_erro": ultimo_erro, "_http_status": ultimo_http}


# ────────────────────────────────────────────────────────────────────────────
# CLI de teste
# ────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if len(sys.argv) < 2:
        print("Uso: python consultar_nf3e_sefaz.py <chave_44_digitos> [--force]")
        sys.exit(1)
    chave_in = sys.argv[1]
    force = "--force" in sys.argv
    dados = consultar_nf3e(chave_in, force_refresh=force)
    print(json.dumps(dados, ensure_ascii=False, indent=2, default=str))
