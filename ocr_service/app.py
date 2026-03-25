# app.py
import os
import io
import sys
import subprocess
import tempfile
import uuid
import json
import re
import hashlib
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from pydantic import BaseModel

from schema import validate_interpreted, schema_json
from cache import FileCache
from llm_client import LLMClient, try_parse_json

from pdf2image import convert_from_bytes
from PIL import Image
import pytesseract
import cv2
import numpy as np
import requests
from dotenv import load_dotenv

from pdfminer.high_level import extract_text as pdf_extract_text
from pdfminer.layout import LAParams

try:
    from paddleocr import PaddleOCR
except ImportError:
    PaddleOCR = None

try:
    import easyocr
except ImportError:
    easyocr = None


# Carrega variáveis do .env (opcional)
load_dotenv()

# Helpers básicos para interpretar variáveis de ambiente
def parse_int_env(name: str, default: int) -> int:
    try:
        value = os.getenv(name)
        if value is None or value.strip() == "":
            return default
        return int(value.strip())
    except (ValueError, TypeError):
        return default


def parse_float_env(name: str, default: float) -> float:
    try:
        value = os.getenv(name)
        if value is None or value.strip() == "":
            return default
        return float(value.strip())
    except (ValueError, TypeError):
        return default


def parse_bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    val = value.strip().lower()
    if val in ("1", "true", "yes", "y", "on"):
        return True
    if val in ("0", "false", "no", "n", "off"):
        return False
    return default


# --- configurações de LLM ---
LLM_PROVIDER = (os.getenv("LLM_PROVIDER", "ollama") or "ollama").strip().lower()
OPENAI_API_KEY = (os.getenv("OPENAI_API_KEY") or "").strip()
OPENAI_API_BASE = (os.getenv("OPENAI_API_BASE", "https://api.openai.com") or "https://api.openai.com").rstrip("/")
OPENAI_OCR_MODEL = (
    os.getenv("OPENAI_OCR_MODEL") or os.getenv("OPENAI_MODEL") or "gpt-4o-mini"
).strip()
OPENAI_TIMEOUT_MS = parse_int_env("OPENAI_TIMEOUT_MS", 0)
OPENAI_MAX_TOKENS = parse_int_env("OPENAI_MAX_TOKENS", 1500)
OPENAI_TEMPERATURE = parse_float_env("OPENAI_TEMPERATURE", 0.1)

# Ajustes de performance do OCR
OCR_MAX_PAGES_DEFAULT = int(os.getenv("OCR_MAX_PAGES", "2") or "2")
OCR_DPI = int(os.getenv("OCR_DPI", "240") or "240")
OCR_LANG = (os.getenv("OCR_LANG", "por") or "por").strip()
OCR_FEWSHOT_PATH = (os.getenv("OCR_FEWSHOT_PATH", "") or "").strip()
OCR_QUICK_INTERPRET = parse_bool_env("OCR_QUICK_INTERPRET", True)
OCR_QUICK_LLM_PROVIDER = (os.getenv("OCR_QUICK_LLM_PROVIDER", "") or "").strip().lower()
OCR_CACHE_DIR = (os.getenv("OCR_CACHE_DIR", "ocr_cache") or "ocr_cache").strip()
OCR_CACHE_TTL = parse_int_env("OCR_CACHE_TTL", 0)
SCHEMA_VERSION = (os.getenv("SCHEMA_VERSION", "1.0.0") or "1.0.0").strip()
OCR_EXPLAIN_ENABLE = parse_bool_env("OCR_EXPLAIN_ENABLE", False)

# Configura caminho do Tesseract (útil em Windows)
TESSERACT_CMD = (os.getenv("TESSERACT_CMD", "") or "").strip()
if TESSERACT_CMD:
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD
else:
    # fallback típico do Scoop no Windows
    default_tess = os.path.expandvars(r"%USERPROFILE%\\scoop\\apps\\tesseract\\current\\tesseract.exe")
    if os.path.exists(default_tess):
        pytesseract.pytesseract.tesseract_cmd = default_tess
        TESSERACT_CMD = default_tess

# Config LLaMA / Ollama (ou outro gateway compatível)
LLM_URL = (os.getenv("LLM_OLLAMA_URL", "http://localhost:11434") or "http://localhost:11434").rstrip("/")
LLM_MODEL = (os.getenv("LLM_OLLAMA_MODEL", "llama3.1:8b") or "llama3.1:8b").strip()
LLM_API_KEY = (os.getenv("LLM_API_KEY", "") or "").strip()

# Caminho opcional do poppler (útil no Windows/Scoop)
POPPLER_PATH = (os.getenv("POPPLER_PATH", "") or "").strip()
if not POPPLER_PATH:
    scoop_poppler = os.path.expandvars(r"%USERPROFILE%\\scoop\\apps\\poppler\\current\\bin")
    if os.path.exists(scoop_poppler):
        POPPLER_PATH = scoop_poppler

# TESSDATA_PREFIX para idiomas do Tesseract
TESSDATA_PREFIX = (os.getenv("TESSDATA_PREFIX", "") or "").strip()
if not TESSDATA_PREFIX:
    default_tessdata = os.path.expandvars(r"%USERPROFILE%\\scoop\\apps\\tesseract\\current\\tessdata")
    if os.path.exists(default_tessdata):
        TESSDATA_PREFIX = default_tessdata
        os.environ["TESSDATA_PREFIX"] = TESSDATA_PREFIX

print(f"[ocr_service] TESSERACT_CMD = {pytesseract.pytesseract.tesseract_cmd}")
print(f"[ocr_service] TESSDATA_PREFIX = {TESSDATA_PREFIX or '(não definido)'}")
print(f"[ocr_service] POPPLER_PATH = {POPPLER_PATH or '(não definido)'}")

# Inicializa motores opcionais (se instalados)
PADDLE_AVAILABLE = False
PADDLE_READER = None
EASY_AVAILABLE = False
EASY_READER = None

if PaddleOCR is not None:
    try:
        PADDLE_READER = PaddleOCR(use_angle_cls=True, lang="pt", use_gpu=False)
        PADDLE_AVAILABLE = True
    except Exception:
        PADDLE_AVAILABLE = False

if easyocr is not None:
    try:
        EASY_READER = easyocr.Reader(["pt"], gpu=False)
        EASY_AVAILABLE = True
    except Exception:
        EASY_AVAILABLE = False


# Prompts de extração (LLM)
PROMPT_FATURA = """
Você é um extrator de dados de faturas de energia.
Receberá texto OCR ruidoso. Devolva apenas JSON válido com os campos:

{
  "numero_fatura": string|null,
  "cliente": string|null,
  "endereco": string|null,
  "data_emissao": "YYYY-MM-DD" or null,
  "data_vencimento": "YYYY-MM-DD" or null,
  "valor_total": number or null,
  "consumo_kwh": number or null,
  "bandeira": string|null,
  "uc": string|null,
  "concessionaria": string|null
}

Regras:
- Se não encontrar, use null.
- Não escreva texto fora do JSON.
- Corrija ruídos (acentos, quebras de linha) quando possível.
- Datas no formato ISO (YYYY-MM-DD).
- valor_total e consumo_kwh em número decimal (ponto).

TEXTO_OCR:
{{TEXTO_OCR}}
"""

# Versão ASCII reforçando UC/mensagens importantes; usado se OCR_PROMPT_NAME=PROMPT_FATURA_V2
PROMPT_FATURA_V2 = """
Voce e um extrator de dados de faturas de energia.
Recebera texto OCR ruidoso. Devolva apenas JSON valido com os campos:

{
  "numero_fatura": string|null,
  "cliente": string|null,
  "endereco": string|null,
  "data_emissao": "YYYY-MM-DD" or null,
  "data_vencimento": "YYYY-MM-DD" or null,
  "valor_total": number or null,
  "consumo_kwh": number or null,
  "bandeira": string|null,
  "uc": string|null,
  "concessionaria": string|null,
  "mensagens_importantes": string|null
}

Regras:
- Se nao encontrar, use null.
- Nao escreva texto fora do JSON.
- Corrija ruidos (acentos, quebras de linha) quando possivel.
- Datas no formato ISO (YYYY-MM-DD).
- valor_total e consumo_kwh em numero decimal (ponto).
- Capture INSTALACAO/UNIDADE CONSUMIDORA/UC em "uc" se existir.
- Se houver secoes de "Mensagens Importantes", consolide-as em "mensagens_importantes".
- Se UC_HINT for informado, use como candidata para uc se fizer sentido.

TEXTO_OCR:
{{TEXTO_OCR}}
"""

PROMPT_SCHEMA_EXTRACT = """
Você é um extrator de dados de faturas de energia.
Devolva apenas JSON válido seguindo o schema informado.
Se não encontrar um campo, use null.
Não escreva texto fora do JSON.

SCHEMA:
{{SCHEMA_JSON}}

TEXTO_OCR:
{{TEXTO_OCR}}
"""

# Saida flat (dotted keys) para integracoes
PROMPT_FATURA_FLAT_V1 = """
Voce e um extrator de dados de faturas de energia.
Recebera texto OCR ruidoso. Devolva apenas JSON valido, com as chaves exatamente como abaixo.
Se nao encontrar um valor, use null. Nao escreva texto fora do JSON.

{
  "fornecedor.nome_razao": null,
  "fornecedor.endereco_linha_1": null,
  "fornecedor.bairro": null,
  "fornecedor.cep": null,
  "fornecedor.cidade": null,
  "fornecedor.uf": null,
  "fornecedor.endereco_completo": null,
  "fornecedor.cnpj": null,
  "fornecedor.site_mencionado": null,
  "fornecedor.ouvidoria": null,
  "fornecedor.aneel_telefone": null,

  "documento.tipo": null,
  "documento.referencia": null,

  "cliente.numero_cliente": null,
  "instalacao.numero_instalacao": null,

  "valores.valor_a_pagar": null,
  "valores.total_a_pagar_texto": null,

  "classe.classe": null,
  "classe.ligacao": null,
  "classe.subclasse": null,
  "classe.modalidade_tarifaria": null,

  "datas.leitura_atual": null,
  "datas.leitura_proxima": null,
  "datas.leitura_anterior": null,
  "datas.data_emissao": null,
  "datas.vencimento": null,

  "medicao.tipo_medicao": null,
  "medicao.codigo_medicao": null,
  "medicao.leitura_anterior": null,
  "medicao.leitura_atual": null,
  "medicao.constante_multiplicacao": null,
  "medicao.consumo_kwh": null,

  "tarifas.info_tarifa_vigente": null,
  "tarifas.tarifa_preco_por_kwh_faturado": null,
  "tarifas.tarifas_aplicadas_sem_impostos_por_kwh": null,

  "bandeiras.texto": null,
  "bandeiras.adicional_incluido_no_valor_a_pagar": null,
  "bandeiras.bandeira_mencionada": null,
  "bandeiras.valor": null,

  "itens_faturados.energia_eletrica.descricao": null,
  "itens_faturados.energia_eletrica.quantidade_kwh": null,
  "itens_faturados.energia_eletrica.valor": null,
  "itens_faturados.encargos.0.descricao": null,
  "itens_faturados.encargos.0.valor": null,

  "historico_consumo.meses": [],
  "historico_consumo.consumo_kwh": [],
  "historico_consumo.media_kwh_dia": [],
  "historico_consumo.dias": [],

  "tributos.reservado_ao_fisco": null,
  "tributos.icms.base_calculo": null,
  "tributos.icms.aliquota_percent": null,
  "tributos.icms.valor": null,
  "tributos.pasep.base_calculo": null,
  "tributos.pasep.aliquota_percent": null,
  "tributos.pasep.valor": null,
  "tributos.cofins.base_calculo": null,
  "tributos.cofins.aliquota_percent": null,
  "tributos.cofins.valor": null,
  "tributos.observacao_raw": null,

  "atendimento.ouvidoria_texto_completo": null,

  "debito_automatico.codigo": null,
  "alertas.0": null,
  "alertas.1": null,
  "alertas.2": null
}

Regras:
- Valores monetarios devem ser numeros (ex.: 22444.54).
- Datas podem estar no formato DD/MM ou DD/MM/AAAA se for o que aparece na fatura.
- Nao invente dados; prefira null se estiver incerto.

TEXTO_OCR:
{{TEXTO_OCR}}
"""

# Saida detalhada (Ilttio) - esquema ampliado conforme solicitado
PROMPT_FATURA_ILTTO_V1 = """
Voce e um extrator de dados de faturas de energia.
Recebera texto OCR ruidoso. Devolva apenas JSON valido, com as chaves exatamente como abaixo.
Se nao encontrar um valor, use null. Nao escreva texto fora do JSON.

{
  "id": null,
  "UID": null,
  "EndID": null,
  "N_Agrupamento": null,
  "CNPJ_Fatura": null,
  "Concessionaria": null,
  "CNPJ_Concessionaria": null,
  "Tp_Pagamento": null,
  "Tipo": null,
  "Mes_Ref": null,
  "Status": "success",
  "UF": null,
  "Cidade": null,
  "CEP": null,
  "Endereco": null,
  "Bairro": null,
  "Complemento": null,
  "Tp_Tensao": null,
  "Classe_Tarifaria": null,
  "Subclasse_Tarifaria": null,
  "Modalidade_Tarifaria": null,
  "Mercado": null,
  "Usina": null,
  "NroMedidor": null,
  "Dt_Leitura_Anterior": null,
  "Dt_Leitura_Atual": null,
  "Qtd_Dias": null,
  "Dt_Implantacao": null,
  "Dt_Alteracao": null,
  "Media_Consumo": null,

  "KWH_Ponta": null,
  "RS_KWH_Ponta": null,
  "KWH_FPonta": null,
  "RS_KWH_FPonta": null,
  "KWH_Reservado": null,
  "RS_KWH_Reservado": null,
  "KWH_Total": null,
  "RS_KWH_Total": null,

  "KWH_Ponta_Injet": null,
  "RS_KWH_Ponta_Injet": null,
  "KWH_FPonta_Injet": null,
  "RS_KWH_FPonta_Injet": null,
  "KWH_Total_Injet": null,
  "RS_KWH_Total_Injet": null,

  "KW_Ponta": null,
  "RS_KW_Ponta": null,
  "KW_Ult_Ponta": null,
  "RS_Ult_Ponta": null,
  "KW_FPonta": null,
  "RS_KW_FPonta": null,
  "KW_Ult_FPonta": null,
  "RS_Ult_FPonta": null,

  "UFER_Ponta": null,
  "RS_UFER_Ponta": null,
  "UFER_FPonta": null,
  "RS_UFER_FPonta": null,
  "UFER_Reservado": null,
  "RS_UFER_Reservado": null,

  "UFDR_Ponta": null,
  "RS_UFDR_Ponta": null,
  "UFDR_FPonta": null,
  "RS_UFDR_FPonta": null,

  "Multa": null,
  "Juros": null,
  "Taxa": null,
  "CIP": null,
  "Tp_Devolucao": null,
  "RS_Devolucao": null,
  "RS_Total_Fatura": null,

  "NroNF": null,
  "SerieNF": null,
  "Dt_Emissao_NF": null,
  "Dt_Venc_NF": null,

  "Base_de_Calculo_ICMS": null,
  "Aliquota_ICMS": null,
  "ICMS_RS": null,
  "Aliquota_PIS": null,
  "PIS_RS": null,
  "Aliquota_COFINS": null,
  "COFINS_RS": null,

  "Amarela": null,
  "Vermelha_P1": null,
  "Vermelha_P2": null,
  "Hidrica": null,

  "Protocolo_Envio": null,
  "NroPedido": null,
  "THD": null,
  "Lancamento_Efetuado": null,
  "Doc_Contabil": null,
  "Doc_Compensacao": null,
  "Estorno": null,
  "Pgto_Realizado": null,

  "Cod_Barras": null,
  "Chave_Debito": null,
  "Lat": null,
  "Long": null,
  "Status_Fatura": null,
  "Obs_Fatura": null,

  "Link": null,
  "UC": null,
  "Link2": null,
  "Cod_UC": null,

  "Refaturamento": null,
  "Cod_Empresa": null,
  "Apelido": null,
  "DESTINACAO_RATEIO": null,
  "RAZAO_SOCIAL": null,
  "Status_Pagamento": null,

  "KW_Contratada_Ponta": null,
  "KW_Contratada_FPonta": null,
  "KW_Registrada_Ponta": null,
  "KW_Registrada_FPonta": null,

  "Tp_NF": null,
  "AVISO_CORTE": null,
  "IMPEDIMENTO_LEITURA": null,
  "Data_Cadastro": null,
  "Data_Ativacao": null,
  "Data_Desativacao": null,
  "Data_Processo_GEDI": null,
  "Fator_Carga_Global": null,
  "Responsavel_Implantacao": null,

  "Leitura_Anterior_KWH_P": null,
  "Leitura_Atual_KWH_P": null,
  "Leitura_Anterior_KWH_FP": null,
  "Leitura_Atual_KWH_FP": null,
  "Leitura_Anterior_KWH_R": null,
  "Leitura_Atual_KWH_R": null,
  "Leitura_Anterior_KW_P": null,
  "Leitura_Atual_KW_P": null,
  "Leitura_Anterior_KW_FP": null,
  "Leitura_Atual_KW_FP": null,

  "Constante_KWH_P": null,
  "Constante_KWH_FP": null,

  "Area_Total": null,
  "RS_M2": null,
  "KWH_M2": null,
  "Numero_Dias": null,
  "Custo_Medio": null,
  "IPCA_IGPM": null,
  "CONJUNTO_ELETRICO": null,

  "TOTAL_NF_ML": null,
  "TOTAL_FATURA_TUSD_TE": null,

  "Empresa": null,
  "Des_Empresa": null,
  "Portal_Fornecedores": null,

  "Chave_Acesso": null,
  "Tipo_Rede": null,
  "Classe_Infra": null,
  "GSBI": null,
  "Base64": null,

  "DATA_PROXIMA_LEITURA": null,
  "DATA_ENVIO_GEDI": null,

  "Total_Geracao_Usina": null,
  "Total_Saldo_Fatura": null,

  "Tarifa_Cheia_KWH_Ponta_SImpostos": null,
  "Tarifa_Cheia_KWH_FPonta_SImpostos": null,
  "Tarifa_Cheia_INJ_Ponta_SImpostos": null,
  "Tarifa_Cheia_INJ_FPonta_SImpostos": null,

  "Percentual_Rateio": null,
  "Importe_Somar": null,
  "Importe_Diminuir": null,

  "Base_de_Calculo_PIS_COFINS": null,
  "Devolucao_Amarela": null,
  "Devolucao_Vermelha_P1": null,
  "Devolucao_Vermelha_P2": null,
  "Devolucao_Hidrica": null,

  "Regional": null,
  "Campanha": null,
  "CPF": null,

  "Protocolo_Autorizacao": null,
  "Base_de_Calculo_Substituicao": null,
  "ICMS_RS_Substituicao": null,

  "Constante_KWH_R": null,
  "Tarifa_Cheia_KWH_Reservado_SImpostos": null,

  "KW_Ult_P_Ger": null,
  "Tarifa_Cheia_KW_Ger_Ult_SImpostos": null,
  "RS_Ult_P_Ger": null,
  "KW_Max_Atu": null,
  "KW_P_Ger": null,
  "Tarifa_Cheia_KW_Ger_SImpostos": null,
  "RS_P_Ger": null,

  "Conta_Contrato": null,

  "Tarifa_INJ_Ponta_Tusd_SImpostos": null,
  "Tarifa_INJ_FPonta_Tusd_SImpostos": null,
  "Tarifa_INJ_Ponta_Te_SImpostos": null,
  "Tarifa_INJ_FPonta_Te_SImpostos": null,

  "Documento_Segunda_Via": null,
  "Leitura_Tipo": null,
  "Bandeira_Informada_Tarifa_R$_kWh": null,
  "Bandeira_Informada_Cor": null,
  "Bandeira_Informada_Texto": null,
  "CIP_Contato_Municipio": null,
  "CIP_Contato_Telefone": null,

  "Item_0D_Consumo_TE": null,
  "Item_0E_Consumo_TUSD": null,
  "Item_0R_Energia_Injet_TE_Pequena": null,
  "Item_0R_Energia_Injet_TE": null,
  "Item_0S_Energia_Injet_TUSD_Pequena": null,
  "Item_0S_Energia_Injet_TUSD": null,
  "Item_2L_Bandeira_Amarela": null,
  "Item_2M_Bandeira_Amarela_Injet": null,
  "Item_C0_COSIP_Municipal": null,

  "Subtotal_Energia_e_Encargos_rs": null,
  "Subtotal_Com_COSIP_rs": null,

  "Historico_Consumo_KWH": null,
  "GD_Beneficiaria_Movimentos": null
}

Regras:
- Mantenha as chaves exatamente como acima (case sensitive).
- Numeros como number (ponto decimal).
- Datas no formato DD/MM/AAAA quando exibidas na fatura.
- Se tiver valores negativos, mantenha o sinal.
- Nao escreva texto fora do JSON.

TEXTO_OCR:
{{TEXTO_OCR}}
"""

TEMPLATE_FLAT_FIELDS = {
    "fornecedor.nome_razao": None,
    "fornecedor.endereco_linha_1": None,
    "fornecedor.bairro": None,
    "fornecedor.cep": None,
    "fornecedor.cidade": None,
    "fornecedor.uf": None,
    "fornecedor.endereco_completo": None,
    "fornecedor.cnpj": None,
    "fornecedor.site_mencionado": None,
    "fornecedor.ouvidoria": None,
    "fornecedor.aneel_telefone": None,
    "documento.tipo": None,
    "documento.referencia": None,
    "cliente.numero_cliente": None,
    "instalacao.numero_instalacao": None,
    "valores.valor_a_pagar": None,
    "valores.total_a_pagar_texto": None,
    "classe.classe": None,
    "classe.ligacao": None,
    "classe.subclasse": None,
    "classe.modalidade_tarifaria": None,
    "datas.leitura_atual": None,
    "datas.leitura_proxima": None,
    "datas.leitura_anterior": None,
    "datas.data_emissao": None,
    "datas.vencimento": None,
    "medicao.tipo_medicao": None,
    "medicao.codigo_medicao": None,
    "medicao.leitura_anterior": None,
    "medicao.leitura_atual": None,
    "medicao.constante_multiplicacao": None,
    "medicao.consumo_kwh": None,
    "tarifas.info_tarifa_vigente": None,
    "tarifas.tarifa_preco_por_kwh_faturado": None,
    "tarifas.tarifas_aplicadas_sem_impostos_por_kwh": None,
    "bandeiras.texto": None,
    "bandeiras.adicional_incluido_no_valor_a_pagar": None,
    "bandeiras.bandeira_mencionada": None,
    "bandeiras.valor": None,
    "itens_faturados.energia_eletrica.descricao": None,
    "itens_faturados.energia_eletrica.quantidade_kwh": None,
    "itens_faturados.energia_eletrica.valor": None,
    "itens_faturados.encargos.0.descricao": None,
    "itens_faturados.encargos.0.valor": None,
    "historico_consumo.meses": [],
    "historico_consumo.consumo_kwh": [],
    "historico_consumo.media_kwh_dia": [],
    "historico_consumo.dias": [],
    "tributos.reservado_ao_fisco": None,
    "tributos.icms.base_calculo": None,
    "tributos.icms.aliquota_percent": None,
    "tributos.icms.valor": None,
    "tributos.pasep.base_calculo": None,
    "tributos.pasep.aliquota_percent": None,
    "tributos.pasep.valor": None,
    "tributos.cofins.base_calculo": None,
    "tributos.cofins.aliquota_percent": None,
    "tributos.cofins.valor": None,
    "tributos.observacao_raw": None,
    "atendimento.ouvidoria_texto_completo": None,
    "debito_automatico.codigo": None,
    "alertas.0": None,
    "alertas.1": None,
    "alertas.2": None,
}


class OcrResponse(BaseModel):
    request_id: str
    texto_ocr: str
    resultado: Dict[str, Any]


class InterpretPayload(BaseModel):
    request_id: str
    filename: str
    ocr_text: Optional[str] = None
    interpreted: Optional[Dict[str, Any]] = None
    file_hash: Optional[str] = None
    rules: List[str] = []
    use_llm: bool = True
    llm_provider: Optional[str] = None


def pdf_to_images(pdf_bytes: bytes, max_pages: int = OCR_MAX_PAGES_DEFAULT) -> List[Image.Image]:
    kwargs = {"dpi": OCR_DPI}
    if max_pages and max_pages > 0:
        kwargs["first_page"] = 1
        kwargs["last_page"] = max_pages
    if POPPLER_PATH:
        kwargs["poppler_path"] = POPPLER_PATH
    images = convert_from_bytes(pdf_bytes, **kwargs)
    return images


def pil_to_cv2(pil_img: Image.Image):
    return cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)


def cv2_to_pil(cv_img) -> Image.Image:
    return Image.fromarray(cv2.cvtColor(cv_img, cv2.COLOR_BGR2RGB))


def extract_uc_hint(text: str) -> str:
    if not text:
        return ""
    pats = [
        r"uc[:\s]+([0-9.\-\s]+)",
        r"unidade\s+consumidora[:\s]+([0-9.\-\s]+)",
        r"instala[cç][aã]o[:\s]+([0-9.\-\s]+)",
        r"numero\s+do\s+cliente[:\s]+([0-9.\-\s]+)",
    ]
    best = ""
    for pat in pats:
        for m in re.finditer(pat, text, flags=re.IGNORECASE):
            digits = re.sub(r"\D", "", m.group(1))
            if 5 <= len(digits) <= 20 and len(digits) > len(best):
                best = digits
    if not best:
        for m in re.finditer(r"\d{6,20}", text):
            digits = m.group(0)
            if len(digits) > len(best):
                best = digits
    return best


def deskew(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    coords = np.column_stack(np.where(gray > 0))
    if coords.shape[0] == 0:
        return image
    angle = cv2.minAreaRect(coords)[-1]
    if angle < -45:
        angle = -(90 + angle)
    else:
        angle = -angle
    (h, w) = image.shape[:2]
    M = cv2.getRotationMatrix2D((w // 2, h // 2), angle, 1.0)
    return cv2.warpAffine(
        image,
        M,
        (w, h),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )


def preprocess_image(pil_img: Image.Image, profile: str = "BALANCED") -> Image.Image:
    cv_img = pil_to_cv2(pil_img)
    if profile != "FAST":
        cv_img = deskew(cv_img)
    gray = cv2.cvtColor(cv_img, cv2.COLOR_BGR2GRAY)
    if profile == "HIGH":
        gray = cv2.medianBlur(gray, 3)
    elif profile == "FAST":
        gray = cv2.GaussianBlur(gray, (3, 3), 0)
    _, th = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return cv2_to_pil(th)


def tesseract_extract_text(img: Image.Image) -> str:
    # OEM 1 (LSTM), PSM 3 (página bloqueada)
    config = "--oem 1 --psm 3"
    text = pytesseract.image_to_string(img, lang=OCR_LANG, config=config)
    return (text or "").strip()


# Helpers para motor/pipeline
ALLOWED_ENGINES = {"AUTO", "TESSERACT", "PADDLE", "EASYOCR", "PDFTEXT", "PREMIUM"}
ALLOWED_PROFILES = {"FAST", "BALANCED", "HIGH"}


def pages_for_profile(profile: str) -> int:
    if profile == "FAST":
        return 1
    if profile == "HIGH":
        return max(OCR_MAX_PAGES_DEFAULT, 3)
    return OCR_MAX_PAGES_DEFAULT


def text_quality_score(text: str) -> float:
    stripped = re.sub(r"\s+", " ", (text or "")).strip()
    if not stripped:
        return 0.0
    length = len(stripped)
    score = 0.45 + min(length, 2000) / 2000 * 0.35
    digits = len(re.findall(r"\d", stripped))
    if digits > 20:
        score += 0.08
    return min(0.99, score)


def extract_pdf_text_from_bytes(data: bytes, max_pages: int) -> str:
    if not data:
        return ""
    try:
        laparams = LAParams()
        text = pdf_extract_text(io.BytesIO(data), laparams=laparams, maxpages=max_pages)
        return (text or "").strip()
    except Exception:
        return ""


def limit_images_for_profile(images: List[Image.Image], profile: str) -> List[Image.Image]:
    if not images:
        return []
    limit = pages_for_profile(profile)
    return images[:limit]


def run_tesseract_on_images(images: List[Image.Image], profile: str) -> Tuple[str, float]:
    if not images:
        return "", 0.0
    texts = []
    for img in images:
        processed = preprocess_image(img, profile)
        text = tesseract_extract_text(processed)
        if text:
            texts.append(text)
    joined = "\n".join(texts).strip()
    return joined, text_quality_score(joined)


def run_paddle_on_images(images: List[Image.Image]) -> Tuple[str, float]:
    if not images or not PADDLE_AVAILABLE or PADDLE_READER is None:
        return "", 0.0
    texts = []
    confidences = []
    for img in images:
        try:
            arr = pil_to_cv2(img)
            result = PADDLE_READER.ocr(arr, cls=True)
            for item in result:
                if not item or len(item) < 2:
                    continue
                payload = item[1]
                if not payload:
                    continue
                text = (payload[0] or "").strip()
                conf = payload[1]
                conf_val = float(conf) if isinstance(conf, (float, int, str)) and str(conf).strip() else 0.0
                if text:
                    texts.append(text)
                    confidences.append(conf_val)
        except Exception:
            continue
    joined = "\n".join(texts).strip()
    avg = (sum(confidences) / len(confidences)) if confidences else text_quality_score(joined)
    return joined, min(0.99, float(avg))


def run_easyocr_on_images(images: List[Image.Image]) -> Tuple[str, float]:
    if not images or not EASY_AVAILABLE or EASY_READER is None:
        return "", 0.0
    texts = []
    confidences = []
    for img in images:
        try:
            arr = np.array(img.convert("RGB"))
            result = EASY_READER.readtext(arr, detail=1)
            for _, text, conf in result:
                cleaned = (text or "").strip()
                if cleaned:
                    texts.append(cleaned)
                    confidences.append(conf if isinstance(conf, (float, int)) else 0.0)
        except Exception:
            continue
    joined = "\n".join(texts).strip()
    avg = (sum(confidences) / len(confidences)) if confidences else text_quality_score(joined)
    return joined, min(0.99, float(avg))


def auto_select_engine(fname: str, data: bytes, images: List[Image.Image], profile: str) -> Tuple[str, float, str, str]:
    if not images:
        return "", 0.0, "TESSERACT", "sem páginas para processar"

    # 1) Se PDF digital, tenta extrair texto direto primeiro (mais rápido e mais fiel)
    if fname.lower().endswith(".pdf"):
        pdf_text = extract_pdf_text_from_bytes(data, pages_for_profile(profile))
        if pdf_text and len(pdf_text) >= 32:
            return pdf_text, 0.97, "PDFTEXT", "PDF digital (texto extraído)"

    # 2) Tesseract como base
    text, confidence = run_tesseract_on_images(images, profile)
    engine_used = "TESSERACT"
    notes = "Tesseract OCR"

    # 3) Fallbacks opcionais (se instalados) quando qualidade estiver ruim
    fallback_candidates = []
    if PADDLE_AVAILABLE:
        fallback_candidates.append(("PADDLE", run_paddle_on_images))
    if EASY_AVAILABLE:
        fallback_candidates.append(("EASYOCR", run_easyocr_on_images))

    for fallback_name, runner in fallback_candidates:
        if confidence >= 0.85:
            break
        fallback_text, fallback_conf = runner(images)
        if fallback_text and fallback_conf > max(0.05, confidence):
            text = fallback_text
            confidence = fallback_conf
            engine_used = fallback_name
            notes = f"Fallback para {fallback_name}"

    if not text:
        notes = f"{notes} (sem texto)"
    return text, confidence, engine_used, notes


def _call_ollama(prompt: str) -> str:
    payload = {"model": LLM_MODEL, "prompt": prompt, "stream": False}
    headers = {}
    if LLM_API_KEY:
        headers["Authorization"] = f"Bearer {LLM_API_KEY}"

    resp = requests.post(
        f"{LLM_URL}/api/generate",
        json=payload,
        headers=headers,
        timeout=3000,
    )
    resp.raise_for_status()
    data = resp.json()
    return (data.get("response", "") or "").strip()


def _call_openai(prompt: str) -> str:
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY não configurada para OpenAI.")

    payload = {
        "model": OPENAI_OCR_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": OPENAI_TEMPERATURE,
        "max_tokens": min(4096, OPENAI_MAX_TOKENS),
    }
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }
    timeout = (OPENAI_TIMEOUT_MS / 1000.0) if OPENAI_TIMEOUT_MS > 0 else None
    resp = requests.post(
        f"{OPENAI_API_BASE}/v1/chat/completions",
        json=payload,
        headers=headers,
        timeout=timeout,
    )
    resp.raise_for_status()
    data = resp.json()
    choices = data.get("choices") or []
    if not choices:
        raise ValueError("Resposta da OpenAI não retornou choices.")
    first = choices[0]
    message = (first.get("message") or {}).get("content") or first.get("text") or ""
    return (message or "").strip()


def _call_llm(prompt: str, provider: Optional[str] = None) -> str:
    chosen = (provider or LLM_PROVIDER or "ollama").strip().lower()
    if chosen == "openai":
        return _call_openai(prompt)
    return _call_ollama(prompt)


def chamar_llm(texto_ocr: str, provider: Optional[str] = None) -> Dict[str, Any]:
    prompt_template = (os.getenv("OCR_PROMPT_NAME", "PROMPT_FATURA_FLAT_V1") or "PROMPT_FATURA_FLAT_V1").strip()
    if prompt_template == "PROMPT_FATURA_FLAT_V1":
        tpl = PROMPT_FATURA_FLAT_V1
    elif prompt_template == "PROMPT_FATURA_V2":
        tpl = PROMPT_FATURA_V2
    elif prompt_template == "PROMPT_FATURA_ILTTO_V1":
        tpl = PROMPT_FATURA_ILTTO_V1
    else:
        tpl = PROMPT_FATURA

    if OCR_FEWSHOT_PATH:
        try:
            fewshot_text = Path(OCR_FEWSHOT_PATH).read_text(encoding="utf-8").strip()
            if fewshot_text:
                tpl = f"{tpl}\n\n# EXEMPLOS\n{fewshot_text}\n"
        except Exception:
            pass

    uc_hint = extract_uc_hint(texto_ocr)
    prompt = tpl.replace("{{TEXTO_OCR}}", (texto_ocr or "")[:15000])
    if uc_hint:
        prompt += f"\nUC_HINT: {uc_hint}\n"

    raw = _call_llm(prompt, provider).strip()
    try:
        start = raw.find("{")
        end = raw.rfind("}")
        raw_json = raw[start : end + 1] if (start != -1 and end != -1 and end > start) else raw
        return json.loads(raw_json)
    except Exception:
        return {"erro": "json_parse_failed", "raw": raw}


def extract_structured_llm(texto_ocr: str, provider: Optional[str] = None) -> Dict[str, Any]:
    prompt = PROMPT_SCHEMA_EXTRACT.replace("{{SCHEMA_JSON}}", schema_json()).replace(
        "{{TEXTO_OCR}}", (texto_ocr or "")[:15000]
    )
    raw = ""
    try:
        chosen = (provider or LLM_PROVIDER or "ollama").strip().lower()
        if chosen == "openai":
            raw = _call_openai(prompt)
        else:
            raw = llm_client.generate(prompt) or ""
        parsed = try_parse_json(raw)
        if parsed is not None:
            return parsed
        repaired = _repair_with_llm(texto_ocr, raw)
        if repaired is not None:
            return repaired
    except Exception:
        pass
    # fallback to previous extractor
    return chamar_llm(texto_ocr, provider)


def interpret_ocr_text(
    ocr_text: str,
    rules: List[str],
    use_llm: bool,
    llm_provider: Optional[str] = None,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    # 1) Regras determinísticas (rules.py)
    rule_results: Dict[str, Any] = {}
    try:
        from rules import apply_rules  # type: ignore
        rule_results = apply_rules(ocr_text, rules)
    except ImportError:
        rule_results = {"META": {"info": "rules.py não encontrado, interpretação básica"}}
    except Exception as err:
        rule_results = {"error": f"Erro ao aplicar regras: {str(err)}"}

    # 2) LLM (opcional)
    llm_results: Dict[str, Any] = {}
    if use_llm and ocr_text:
        try:
            llm_results = chamar_llm(ocr_text, llm_provider)
        except Exception as err:
            llm_results = {"error": f"Erro ao chamar LLM: {str(err)}"}

    return rule_results, llm_results


def flatten_dotted(data: Any) -> Dict[str, Any]:
    out: Dict[str, Any] = {}

    def is_dict_list(v: Any) -> bool:
        return isinstance(v, list) and len(v) > 0 and all(isinstance(x, dict) for x in v)

    def rec(obj: Any, prefix: str) -> None:
        if isinstance(obj, dict):
            for k, v in obj.items():
                key = f"{prefix}.{k}" if prefix else str(k)
                rec(v, key)
            return
        if isinstance(obj, list):
            if is_dict_list(obj):
                for i, item in enumerate(obj):
                    key = f"{prefix}.{i}" if prefix else str(i)
                    rec(item, key)
            else:
                out[prefix] = obj
            return
        out[prefix] = obj

    if isinstance(data, dict):
        rec(data, "")
    return out


def apply_template_flat(flat: Dict[str, Any]) -> Dict[str, Any]:
    ordered: Dict[str, Any] = {}
    for k, v in TEMPLATE_FLAT_FIELDS.items():
        if flat is None:
            ordered[k] = v
        else:
            ordered[k] = flat.get(k, v)
    return ordered


OLD_TO_NEW_KEYS = {
    "valores.valor_a_pagar_r$": "valores.valor_a_pagar",
    "tarifas.tarifa_preco_r$_por_kwh_faturado": "tarifas.tarifa_preco_por_kwh_faturado",
    "tarifas.tarifas_aplicadas_sem_impostos_r$_por_kwh": "tarifas.tarifas_aplicadas_sem_impostos_por_kwh",
    "bandeiras.valor_r$": "bandeiras.valor",
    "itens_faturados.energia_eletrica.valor_r$": "itens_faturados.energia_eletrica.valor",
    "itens_faturados.encargos.0.valor_r$": "itens_faturados.encargos.0.valor",
    "tributos.icms.base_calculo_r$": "tributos.icms.base_calculo",
    "tributos.icms.valor_r$": "tributos.icms.valor",
    "tributos.pasep.base_calculo_r$": "tributos.pasep.base_calculo",
    "tributos.pasep.valor_r$": "tributos.pasep.valor",
    "tributos.cofins.base_calculo_r$": "tributos.cofins.base_calculo",
    "tributos.cofins.valor_r$": "tributos.cofins.valor",
}


def normalize_flat_keys(flat: Dict[str, Any]) -> Dict[str, Any]:
    if not flat:
        return {}
    out: Dict[str, Any] = {}
    for k, v in flat.items():
        new_key = OLD_TO_NEW_KEYS.get(k, k)
        if new_key not in out:
            out[new_key] = v
    return out


def _parse_year_hint(val: Any) -> Optional[str]:
    if val is None:
        return None
    s = str(val).strip()
    m = re.search(r"(\d{4})", s)
    return m.group(1) if m else None


def _to_ddmmyyyy(val: Any, year_hint: Optional[str]) -> Any:
    if val is None:
        return None
    s = str(val).strip()
    if not s:
        return val
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", s)
    if m:
        return f"{m.group(3)}/{m.group(2)}/{m.group(1)}"
    m = re.match(r"^(\d{2})/(\d{2})/(\d{2}|\d{4})$", s)
    if m:
        y = m.group(3)
        if len(y) == 2:
            y = f"20{y}"
        return f"{m.group(1)}/{m.group(2)}/{y}"
    m = re.match(r"^(\d{2})/(\d{2})$", s)
    if m and year_hint:
        return f"{m.group(1)}/{m.group(2)}/{year_hint}"
    return val


def normalize_dates_flat(flat: Dict[str, Any]) -> Dict[str, Any]:
    if not flat:
        return {}
    out = dict(flat)
    year_hint = _parse_year_hint(out.get("datas.data_emissao")) or _parse_year_hint(out.get("datas.vencimento"))
    date_keys = [
        "datas.leitura_atual",
        "datas.leitura_proxima",
        "datas.leitura_anterior",
        "datas.data_emissao",
        "datas.vencimento",
    ]
    for k in date_keys:
        if k in out:
            out[k] = _to_ddmmyyyy(out.get(k), year_hint)
    return out


CRITICAL_FIELDS = [
    "uc",
    "cnpj",
    "concessionaria",
    "data_emissao",
    "data_vencimento",
    "valor_total",
]


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _pick_first(flat: Dict[str, Any], keys: List[str]) -> Optional[Any]:
    for k in keys:
        if k in flat and flat.get(k) not in (None, "", []):
            return flat.get(k)
    return None


def extract_critical_fields(base: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(base, dict):
        return {}
    flat = flatten_dotted(base)
    return {
        "uc": _pick_first(flat, ["uc", "uc.codigo", "uc.unidade_consumidora", "uc.numero_unidade_consumidora", "uc.codigo_cliente", "cliente.codigo", "cliente.numero_cliente", "cliente.numero_instalacao"]),
        "cnpj": _pick_first(flat, ["cnpj", "cliente.cnpj", "cliente.cpf_cnpj", "fornecedor.cnpj", "fornecedor.cnpj_concessionaria"]),
        "concessionaria": _pick_first(flat, ["concessionaria", "fornecedor.concessionaria", "fornecedor.nome", "fornecedor.nome_razao"]),
        "data_emissao": _pick_first(flat, ["data_emissao", "datas.data_emissao", "nota_fiscal.data_emissao"]),
        "data_vencimento": _pick_first(flat, ["data_vencimento", "datas.vencimento", "vencimento.data"]),
        "valor_total": _pick_first(flat, ["valor_total", "valores.valor_a_pagar", "valores.valor_a_pagar_r$", "valores.total_a_pagar_r$", "valores.total", "valores.total_a_pagar", "valores.total_fatura"]),
    }


def _find_evidence(raw_text: str, value: Any, regex: Optional[str] = None) -> Optional[Tuple[str, int, int]]:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    text = raw_text or ""
    if regex:
        m = re.search(regex, text, re.IGNORECASE)
        if m:
            return m.group(0), m.start(), m.end()
    idx = text.find(s)
    if idx >= 0:
        return s, idx, idx + len(s)
    return None


def build_evidence_map(raw_text: str, critical: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if not raw_text:
        return out
    for key, val in critical.items():
        regex = None
        if key == "cnpj":
            regex = r"\b\d{2}\.?\d{3}\.?\d{3}/\d{4}-\d{2}\b"
        elif key == "uc":
            regex = r"\b\d{6,12}\b"
        elif key in ("data_emissao", "data_vencimento"):
            regex = r"\b\d{2}/\d{2}/\d{4}\b"
        elif key == "valor_total":
            regex = r"R\$\s*[\d\.\,]+"
        ev = _find_evidence(raw_text, val, regex)
        if ev:
            text, start, end = ev
            out[key] = {"text": text, "start": start, "end": end, "confidence": 0.85}
    return out


def build_interpreted_payload(raw_text: str, extracted_fields: Dict[str, Any], model_version: str) -> Dict[str, Any]:
    critical = extract_critical_fields(extracted_fields)
    missing_fields = [k for k, v in critical.items() if v in (None, "", [])]
    evidence_map = build_evidence_map(raw_text, critical)
    missing_evidence_fields = [k for k, v in critical.items() if v not in (None, "", []) and k not in evidence_map]

    found = len([k for k in critical if k not in missing_fields])
    total = len(critical) if critical else 1
    confidence = max(0.0, min(1.0, round(found / total, 4)))
    if missing_evidence_fields:
        confidence = max(0.0, round(confidence - 0.1, 4))

    status = "OK" if not missing_fields else "DADOS_INSUFICIENTES"
    payload = {
        "status": status,
        "schema_version": SCHEMA_VERSION,
        "model_version": model_version,
        "confidence": confidence,
        "extracted_fields": extracted_fields,
        "missing_fields": missing_fields,
        "missing_evidence_fields": missing_evidence_fields,
        "evidence_map": evidence_map,
        "warnings": [],
        "errors": [],
    }
    try:
        return validate_interpreted(payload)
    except Exception as err:
        payload["status"] = "INVALID_JSON"
        payload["errors"] = [str(err)]
        return payload


def _repair_with_llm(raw_text: str, bad_json: str) -> Optional[Dict[str, Any]]:
    if llm_client.provider in ("off", "none", "disabled"):
        return None
    prompt = (
        "Corrija o JSON abaixo para aderir ao schema. Responda APENAS com JSON valido.\n"
        f"SCHEMA:\n{schema_json()}\n\n"
        f"JSON_COM_ERRO:\n{bad_json}\n\n"
        f"TEXTO_OCR:\n{raw_text[:8000]}\n"
    )
    resp = llm_client.generate(prompt)
    return try_parse_json(resp or "")


def _ruleset_version(rules: List[str]) -> str:
    joined = ",".join(sorted([r.strip().upper() for r in rules if r]))
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:12]
app = FastAPI(title="OCR + LLaMA (teste local)", version="0.1.0")
cache = FileCache(OCR_CACHE_DIR)
llm_client = LLMClient()


# Healthcheck simples
@app.get("/ping")
def ping():
    return {"ok": True}


@app.post("/ocr/upload", response_model=OcrResponse)
async def ocr_upload(file: UploadFile = File(...)):
    try:
        request_id = str(uuid.uuid4())
        content = await file.read()
        filename = (file.filename or "arquivo_sem_nome").lower()

        if filename.endswith(".pdf"):
            images = pdf_to_images(content)
        else:
            img = Image.open(io.BytesIO(content)).convert("RGB")
            images = [img]

        textos = []
        for img in images:
            img_p = preprocess_image(img, "BALANCED")
            texto = tesseract_extract_text(img_p)
            if texto:
                textos.append(texto)

        texto_ocr = "\n".join(textos).strip()
        if not texto_ocr:
            raise HTTPException(status_code=422, detail="OCR retornou vazio")

            resultado = chamar_llm(texto_ocr)

        return OcrResponse(request_id=request_id, texto_ocr=texto_ocr, resultado=resultado)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Erro interno: {e}")
        raise HTTPException(status_code=500, detail="Erro interno no servidor")


@app.post("/ocr/analyze")
async def ocr_analyze(files: List[UploadFile] = File(...)):
    results = []
    for fh in files:
        try:
            data = await fh.read()
            fname = fh.filename or "arquivo_sem_nome"

            if fname.lower().endswith(".pdf"):
                images = pdf_to_images(data)
            else:
                img = Image.open(io.BytesIO(data)).convert("RGB")
                images = [img]

            textos = []
            for img in images:
                img_p = preprocess_image(img, "BALANCED")
                texto = tesseract_extract_text(img_p)
                if texto:
                    textos.append(texto)

            texto_ocr = "\n".join(textos).strip()
            model_version = f"{LLM_PROVIDER}:{LLM_MODEL}" if LLM_PROVIDER != "openai" else f"openai:{OPENAI_OCR_MODEL}"
            llm_json = extract_structured_llm(texto_ocr) if texto_ocr else {"erro": "ocr_vazio"}
            interpreted = build_interpreted_payload(texto_ocr, llm_json if isinstance(llm_json, dict) else {}, model_version)
            enriched = {
                "file_name": fname,
                "raw_text": texto_ocr,
                "pages_used": len(images),
                "status": "success",
            }
            if isinstance(interpreted, dict):
                for k, v in interpreted.items():
                    if k not in enriched:
                        enriched[k] = v

            results.append(
                {
                    **enriched,
                    "instruction": "",
                    "rule_results": llm_json,
                }
            )
        except Exception as e:
            results.append(
                {
                    "file_name": fh.filename if fh else "desconhecido",
                    "error": str(e),
                    "status": "error",
                }
            )
    return {"results": results}


# Alias compatível (sem prefixo /ocr)
@app.post("/analyze")
async def analyze(files: List[UploadFile] = File(...)):
    return await ocr_analyze(files)


@app.post("/ocr/desvio-media")
async def ocr_desvio_media(
    file: UploadFile = File(...),
    instruction: str = Form(""),
    unit_col: str = Form("UC"),
    concessionaria_col: str = Form("Concessionaria"),
    value_col: str = Form("KWH_FPonta"),
    placeholder: str = Form("0,1,50"),
    min_base: str = Form("8"),
    score_threshold: str = Form("3.0"),
    pct_high: str = Form("1.0"),
    pct_low: str = Form("-0.9"),
    k: str = Form("3.0"),
    placeholder_repeat_threshold: str = Form("3"),
    max_anom: str = Form("200"),
    header_row: str = Form("1"),
    sheet: str = Form(""),
    mes_col: str = Form(""),
):
    try:
        data = await file.read()
        suffix = Path(file.filename or "").suffix or ".xlsx"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        script_path = Path(__file__).with_name("desvio_media.py")
        args = [
            str(script_path),
            "--input",
            tmp_path,
            "--unit-col",
            unit_col,
            "--concessionaria-col",
            concessionaria_col,
            "--value-col",
            value_col,
            "--placeholder",
            placeholder,
            "--min-base",
            min_base,
            "--score-threshold",
            score_threshold,
            "--pct-high",
            pct_high,
            "--pct-low",
            pct_low,
            "--k",
            k,
            "--placeholder-repeat-threshold",
            placeholder_repeat_threshold,
            "--max-anom",
            max_anom,
            "--header-row",
            header_row,
            "--pretty",
        ]
        if mes_col:
            args += ["--mes-col", mes_col]
        if sheet:
            args += ["--sheet", sheet]

        timeout_sec = parse_int_env("DESVIO_MEDIA_TIMEOUT_SEC", 120)
        proc = subprocess.run(
            [sys.executable, *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_sec,
            check=False,
        )
        os.unlink(tmp_path)

        if proc.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=(proc.stderr.decode("utf-8", errors="replace") or "Falha ao executar desvio_media.py"),
            )

        raw = proc.stdout.decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw)
            return payload
        except Exception:
            return {"raw": raw, "stderr": proc.stderr.decode("utf-8", errors="replace")}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Erro interno: {e}")
        raise HTTPException(status_code=500, detail="Erro interno no servidor")


# ============================================================================
# OCR EM DUAS ETAPAS
# ============================================================================

@app.post("/ocr/quick")
async def ocr_quick(
    files: List[UploadFile] = File(...),
    engine: str = Form("AUTO"),
    profile: str = Form("BALANCED"),
    instruction: str = Form(""),
    request_id: str = Form(""),
    force: str = Form("false"),
):
    """
    Stage 1: extrai texto (sem LLM) e devolve resultados por arquivo.
    Aceita request_id opcional (útil quando um gateway/Go handler já gerou).
    """
    results = []

    engine_param = (engine or "AUTO").upper().strip()
    profile_param = (profile or "BALANCED").upper().strip()

    if engine_param not in ALLOWED_ENGINES:
        engine_param = "AUTO"
    if profile_param not in ALLOWED_PROFILES:
        profile_param = "BALANCED"

    rid = (request_id or "").strip() or str(uuid.uuid4())

    force_cache = str(force or "").strip().lower() in ("1", "true", "yes", "y", "on")
    model_version = f"{LLM_PROVIDER}:{LLM_MODEL}" if LLM_PROVIDER != "openai" else f"openai:{OPENAI_OCR_MODEL}"

    for fh in files:
        try:
            data = await fh.read()
            fname = (fh.filename or "arquivo_sem_nome").lower()
            file_hash = _sha256_bytes(data)
            cache_key = f"cache:ocr:{file_hash}:{SCHEMA_VERSION}:{model_version}"

            cached = None if force_cache else cache.get(cache_key)
            if cached:
                results.append(
                    {
                        "file_name": fname,
                        "raw_text": cached.get("raw_text") or "",
                        "pages_used": cached.get("pages_used") or 1,
                        "status": "success",
                        "engine_used": "CACHE",
                        "profile_used": profile_param,
                        "confidence": round(float(cached.get("confidence") or 0), 4),
                        "engine_notes": "cache_hit",
                        "instruction": instruction or "",
                        "rule_results": cached.get("rule_results") or {},
                        "llm_results": cached.get("llm_results") or {},
                        "interpreted": cached.get("interpreted") or {},
                        "cache_hit": True,
                        "file_hash": file_hash,
                    }
                )
                continue

            # Detecta formato e converte em imagens
            if fname.endswith(".pdf"):
                images = pdf_to_images(data, max_pages=pages_for_profile(profile_param))
            else:
                img = Image.open(io.BytesIO(data)).convert("RGB")
                images = [img]

            if not images:
                raise ValueError("Arquivo sem páginas válidas")

            images_used = limit_images_for_profile(images, profile_param)
            if not images_used:
                images_used = images[:1]
            pages_used = max(1, len(images_used))

            used_engine = engine_param
            notes = ""
            text = ""
            confidence = 0.0

            if engine_param == "PDFTEXT":
                text = extract_pdf_text_from_bytes(data, pages_used)
                confidence = text_quality_score(text)
                notes = "PDF digital (texto direto)"
                if not text:
                    text, confidence, used_engine, notes = auto_select_engine(fname, data, images_used, profile_param)

            elif engine_param == "TESSERACT":
                text, confidence = run_tesseract_on_images(images_used, profile_param)
                used_engine = "TESSERACT"
                notes = "Tesseract OCR"

            elif engine_param == "PADDLE":
                if PADDLE_AVAILABLE:
                    text, confidence = run_paddle_on_images(images_used)
                    used_engine = "PADDLE"
                    notes = "PaddleOCR"
                else:
                    text, confidence, used_engine, notes = auto_select_engine(fname, data, images_used, profile_param)

            elif engine_param == "EASYOCR":
                if EASY_AVAILABLE:
                    text, confidence = run_easyocr_on_images(images_used)
                    used_engine = "EASYOCR"
                    notes = "EasyOCR"
                else:
                    text, confidence, used_engine, notes = auto_select_engine(fname, data, images_used, profile_param)

            else:
                # AUTO / PREMIUM (aqui PREMIUM cai como AUTO)
                text, confidence, used_engine, notes = auto_select_engine(fname, data, images_used, profile_param)

            if not text:
                notes = notes or "Texto não extraído"

            rule_results = {}
            llm_results = {}
            interpreted = {}
            if OCR_QUICK_INTERPRET and text:
                provider = OCR_QUICK_LLM_PROVIDER if OCR_QUICK_LLM_PROVIDER else None
                extracted = extract_structured_llm(text, provider)
                interpreted = build_interpreted_payload(text, extracted if isinstance(extracted, dict) else {}, model_version)
                llm_results = extracted if isinstance(extracted, dict) else {}

            results.append(
                {
                    "file_name": fname,
                    "raw_text": text,
                    "pages_used": pages_used,
                    "status": "success",
                    "engine_used": used_engine,
                    "profile_used": profile_param,
                    "confidence": round(float(confidence), 4),
                    "engine_notes": notes,
                    "instruction": instruction or "",
                    "rule_results": rule_results,
                    "llm_results": llm_results,
                    "interpreted": interpreted,
                    "cache_hit": False,
                    "file_hash": file_hash,
                }
            )
            if interpreted:
                cache.set(
                    cache_key,
                    {
                        "raw_text": text,
                        "pages_used": pages_used,
                        "confidence": round(float(confidence), 4),
                        "rule_results": rule_results,
                        "llm_results": llm_results,
                        "interpreted": interpreted,
                        "file_hash": file_hash,
                        "schema_version": SCHEMA_VERSION,
                        "model_version": model_version,
                        "created_at": time.time(),
                    },
                    OCR_CACHE_TTL,
                )
        except Exception as e:
            results.append(
                {
                    "file_name": fh.filename if fh else "desconhecido",
                    "error": str(e),
                    "status": "error",
                    "instruction": instruction or "",
                }
            )

    return {"request_id": rid, "results": results}


@app.post("/ocr/interpret")
async def ocr_interpret(
    request_id: str,
    filename: str,
    ocr_text: str,
    rules: str = "[]",
    use_llm: bool = True,
    llm_provider: str = "",
):
    """
    Stage 2: interpreta texto OCR (aplica regras + LLM opcional).
    OBS: ocr_text aqui é query param; para payload grande prefira /ocr/interpret_json.
    """
    try:
        # rules pode vir como JSON string '["A","B"]' ou "A,B"
        rules_list: List[str] = []
        if rules:
            r = rules.strip()
            if r.startswith("["):
                rules_list = json.loads(r)
            else:
                rules_list = [x.strip() for x in r.split(",") if x.strip()]

        provider = (llm_provider or "").strip().lower()
        if provider in ("", "auto"):
            provider = None
        rule_results, llm_results = interpret_ocr_text(ocr_text, rules_list, use_llm, provider)
        base = llm_results if isinstance(llm_results, dict) and llm_results else rule_results
        flat = flatten_dotted(base) if isinstance(base, dict) else {}
        flat_norm = normalize_dates_flat(normalize_flat_keys(flat))
        flat_ordered = apply_template_flat(flat_norm)

        return {
            "request_id": request_id,
            "filename": filename,
            "rule_results": rule_results,
            "llm_results": llm_results,
            "interpreted": flat_ordered,
            "ruleset_version": _ruleset_version(rules_list),
            "status": "success",
        }
    except Exception as e:
        logger.error(f"Erro na interpretação: {e}")
        raise HTTPException(status_code=500, detail="Erro interno na interpretação")


@app.post("/ocr/interpret_json")
def ocr_interpret_json(payload: InterpretPayload):
    """
    Stage 2 (recomendado): interpreta usando JSON body (sem estourar URL).
    """
    try:
        if not payload.ocr_text:
            raise HTTPException(status_code=422, detail="ocr_text é obrigatório para aplicar regras")
        provider = (payload.llm_provider or "").strip().lower()
        if provider in ("", "auto"):
            provider = None
        rule_results, llm_results = interpret_ocr_text(
            payload.ocr_text,
            payload.rules,
            payload.use_llm,
            provider,
        )
        base = llm_results if isinstance(llm_results, dict) and llm_results else rule_results
        flat = flatten_dotted(base) if isinstance(base, dict) else {}
        flat_norm = normalize_dates_flat(normalize_flat_keys(flat))
        flat_ordered = apply_template_flat(flat_norm)
        return {
            "filename": payload.filename,
            "request_id": payload.request_id,
            "rule_results": rule_results,
            "llm_results": llm_results,
            "interpreted": flat_ordered,
            "ruleset_version": _ruleset_version(payload.rules),
            "status": "success",
        }
    except Exception as e:
        logger.error(f"Erro na interpretação: {e}")
        raise HTTPException(status_code=500, detail="Erro interno na interpretação")

@app.post("/ocr/explain")
def ocr_explain(payload: dict):
    """
    Explicação opcional baseada em evidências (sem misturar com a extração).
    """
    if not OCR_EXPLAIN_ENABLE:
        return {"status": "disabled", "message": "OCR explain disabled"}
    interpreted = payload.get("interpreted") or {}
    evidence_map = interpreted.get("evidence_map") or {}
    fields = payload.get("fields") or list(evidence_map.keys())
    bullets = []
    for key in fields:
        ev = evidence_map.get(key) if isinstance(evidence_map, dict) else None
        if isinstance(ev, dict):
            text = ev.get("text") or ""
            if text:
                bullets.append(f"{key}: {text}")
    return {
        "status": "success",
        "bullets": bullets,
        "text": "\n".join(bullets),
    }
