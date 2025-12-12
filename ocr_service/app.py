import os
import io
import uuid
import json
import re
from typing import Any, Dict, List

from fastapi import FastAPI, UploadFile, File, HTTPException
from pydantic import BaseModel

from pdf2image import convert_from_bytes
from PIL import Image
import pytesseract
import cv2
import numpy as np
import requests
from dotenv import load_dotenv

# Carrega variáveis do .env (opcional)
load_dotenv()

# Ajustes de performance do OCR
OCR_MAX_PAGES_DEFAULT = int(os.getenv("OCR_MAX_PAGES", "2") or "2")
OCR_DPI = int(os.getenv("OCR_DPI", "240") or "240")
OCR_LANG = os.getenv("OCR_LANG", "por").strip() or "por"

# Configura caminho do Tesseract (útil em Windows)
TESSERACT_CMD = os.getenv("TESSERACT_CMD", "").strip()
if TESSERACT_CMD:
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD
else:
    # fallback típico do Scoop no Windows
    default_tess = os.path.expandvars(r"%USERPROFILE%\\scoop\\apps\\tesseract\\current\\tesseract.exe")
    if os.path.exists(default_tess):
        pytesseract.pytesseract.tesseract_cmd = default_tess
        TESSERACT_CMD = default_tess

# Config LLaMA / Ollama
LLM_URL = os.getenv("LLM_OLLAMA_URL", "http://localhost:11434").rstrip("/")
LLM_MODEL = os.getenv("LLM_OLLAMA_MODEL", "llama3.1:8b")
LLM_API_KEY = os.getenv("LLM_API_KEY", "").strip()

# Caminho opcional do poppler (útil no Windows/Scoop)
POPPLER_PATH = os.getenv("POPPLER_PATH", "").strip()
# Fallback automático para instalação via Scoop
if not POPPLER_PATH:
    scoop_poppler = os.path.expandvars(r"%USERPROFILE%\\scoop\\apps\\poppler\\current\\bin")
    if os.path.exists(scoop_poppler):
        POPPLER_PATH = scoop_poppler

# TESSDATA_PREFIX para idiomas do Tesseract
TESSDATA_PREFIX = os.getenv("TESSDATA_PREFIX", "").strip()
if not TESSDATA_PREFIX:
    # se vier pelo Scoop, tessdata fica em current\tessdata
    default_tessdata = os.path.expandvars(r"%USERPROFILE%\\scoop\\apps\\tesseract\\current\\tessdata")
    if os.path.exists(default_tessdata):
        TESSDATA_PREFIX = default_tessdata
        os.environ["TESSDATA_PREFIX"] = TESSDATA_PREFIX

print(f"[ocr_service] TESSERACT_CMD = {pytesseract.pytesseract.tesseract_cmd}")
print(f"[ocr_service] TESSDATA_PREFIX = {TESSDATA_PREFIX or '(não definido)'}")
print(f"[ocr_service] POPPLER_PATH = {POPPLER_PATH or '(não definido)'}")


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


class OcrResponse(BaseModel):
    request_id: str
    texto_ocr: str
    resultado: Dict[str, Any]


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


def preprocess_image(pil_img: Image.Image) -> Image.Image:
    cv_img = pil_to_cv2(pil_img)
    cv_img = deskew(cv_img)
    gray = cv2.cvtColor(cv_img, cv2.COLOR_BGR2GRAY)
    # Otsu simples para binarizar (mais rápido que adaptativo)
    _, th = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return cv2_to_pil(th)


def extract_text(img: Image.Image) -> str:
    # OEM 1 (LSTM), PSM 3 (página bloqueada)
    config = "--oem 1 --psm 3"
    text = pytesseract.image_to_string(img, lang=OCR_LANG, config=config)
    return text.strip()


def _call_ollama(prompt: str) -> str:
    payload = {
        "model": LLM_MODEL,
        "prompt": prompt,
        "stream": False,
    }
    headers = {}
    if LLM_API_KEY:
        headers["Authorization"] = f"Bearer {LLM_API_KEY}"

    resp = requests.post(
        f"{LLM_URL}/api/generate",
        json=payload,
        headers=headers,
        timeout=3000,  # aumentamos para acomodar modelos pesados
    )
    resp.raise_for_status()
    data = resp.json()
    return data.get("response", "")


def chamar_llama(texto_ocr: str) -> Dict[str, Any]:
    prompt_template = os.getenv("OCR_PROMPT_NAME", "PROMPT_FATURA_V2")
    tpl = PROMPT_FATURA_V2 if 'PROMPT_FATURA_V2' in globals() and prompt_template == "PROMPT_FATURA_V2" else PROMPT_FATURA
    uc_hint = extract_uc_hint(texto_ocr)
    prompt = tpl.replace("{{TEXTO_OCR}}", texto_ocr[:15000])
    if uc_hint:
        prompt += f"\nUC_HINT: {uc_hint}\n"
    raw = _call_ollama(prompt).strip()
    try:
        start = raw.find("{")
        end = raw.rfind("}")
        if start != -1 and end != -1:
            raw_json = raw[start : end + 1]
        else:
            raw_json = raw
        data = json.loads(raw_json)
        return data
    except Exception:
        return {"erro": "json_parse_failed", "raw": raw}


app = FastAPI(title="OCR + LLaMA (teste local)")

# Prompt alternativo (ASCII) reforçando UC/mensagens importantes; usado se OCR_PROMPT_NAME=PROMPT_FATURA_V2
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


def process_file(fh: UploadFile):
    filename = (fh.filename or "arquivo_sem_nome").lower()
    content = fh.file.read() if hasattr(fh, "file") else fh.file.read()
    # Decide se é PDF ou imagem
    if filename.endswith(".pdf"):
        images = pdf_to_images(content)
    else:
        img = Image.open(io.BytesIO(content)).convert("RGB")
        images = [img]

    textos = []
    for img in images:
        img_p = preprocess_image(img)
        texto = extract_text(img_p)
        if texto:
            textos.append(texto)

    texto_ocr = "\n".join(textos).strip()
    return filename, texto_ocr, len(images)


@app.post("/ocr/upload", response_model=OcrResponse)
async def ocr_upload(file: UploadFile = File(...)):
    try:
        request_id = str(uuid.uuid4())
        content = await file.read()
        filename = (file.filename or "arquivo_sem_nome").lower()

        # Decide se é PDF ou imagem
        if filename.endswith(".pdf"):
            images = pdf_to_images(content)
        else:
            img = Image.open(io.BytesIO(content)).convert("RGB")
            images = [img]

        textos = []
        for img in images:
            img_p = preprocess_image(img)
            texto = extract_text(img_p)
            if texto:
                textos.append(texto)

        texto_ocr = "\n".join(textos).strip()
        if not texto_ocr:
            raise HTTPException(status_code=422, detail="OCR retornou vazio")

        resultado = chamar_llama(texto_ocr)

        return OcrResponse(
            request_id=request_id,
            texto_ocr=texto_ocr,
            resultado=resultado,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Healthcheck simples
@app.get("/ping")
def ping():
    return {"ok": True}


@app.post("/ocr/analyze")
async def ocr_analyze(files: List[UploadFile] = File(...)):
    results = []
    for fh in files:
        try:
            data = await fh.read()
            fname = fh.filename or "arquivo_sem_nome"
            # processa
            if fname.lower().endswith(".pdf"):
                images = pdf_to_images(data)
            else:
                img = Image.open(io.BytesIO(data)).convert("RGB")
                images = [img]
            textos = []
            for img in images:
                img_p = preprocess_image(img)
                texto = extract_text(img_p)
                if texto:
                    textos.append(texto)
            texto_ocr = "\n".join(textos).strip()
            llm_json = chamar_llama(texto_ocr) if texto_ocr else {"erro": "ocr_vazio"}
            results.append({
                "file_name": fname,
                "raw_text": texto_ocr,
                "pages_used": len(images),
                "instruction": "",
                "rule_results": llm_json,
            })
        except Exception as e:
            results.append({
                "file_name": fh.filename if fh else "desconhecido",
                "error": str(e),
            })
    return {"results": results}


# Alias compatível com backend (sem prefixo /ocr)
@app.post("/analyze")
async def analyze(files: List[UploadFile] = File(...)):
    return await ocr_analyze(files)


# ============================================================================
# NOVOS ENDPOINTS - OCR EM DUAS ETAPAS
# ============================================================================

@app.post("/ocr/quick")
async def ocr_quick(files: List[UploadFile] = File(...)):
    """
    OCR rápido - extrai APENAS o texto bruto sem IA.
    Ideal para processamento em lote - a interpretação é feita depois.
    """
    results = []

    for fh in files:
        try:
            data = await fh.read()
            fname = fh.filename or "arquivo_sem_nome"

            # 1. Detecta formato
            if fname.lower().endswith(".pdf"):
                images = pdf_to_images(data)
            else:
                img = Image.open(io.BytesIO(data)).convert("RGB")
                images = [img]

            # 2. OCR em cada página
            textos = []
            pages_used = 0
            for img in images[:OCR_MAX_PAGES_DEFAULT]:
                img_p = preprocess_image(img)
                texto = extract_text(img_p)
                if texto:
                    textos.append(texto)
                pages_used += 1

            raw_text = "\n".join(textos).strip()

            # 3. Retorna SEM chamar IA (isso é o diferencial!)
            results.append({
                "file_name": fname,
                "raw_text": raw_text,
                "pages_used": pages_used,
                "status": "success"
            })

        except Exception as e:
            results.append({
                "file_name": fh.filename if fh else "desconhecido",
                "error": str(e),
                "status": "error"
            })

    return {"results": results}


@app.post("/ocr/interpret")
async def ocr_interpret(
    request_id: str,
    filename: str,
    ocr_text: str,
    rules: str = "[]",
    use_llm: bool = True
):
    """
    Interpreta texto OCR já extraído.
    Aplica regras e opcionalmente chama LLM para estruturação.

    Params:
        request_id: ID da requisição original
        filename: Nome do arquivo
        ocr_text: Texto bruto do OCR (já salvo no banco)
        rules: JSON array de regras, ex: ["BANDEIRA_ENEL_SP_GB", "ICMS"]
        use_llm: Se True, chama LLaMA para estruturação adicional
    """
    try:
        # 1. Parseia lista de regras
        rules_list = json.loads(rules) if rules else []

        # 2. Aplica regras (importa rules.py se disponível)
        rule_results = {}
        try:
            from rules import apply_rules
            rule_results = apply_rules(ocr_text, rules_list)
        except ImportError:
            # Se rules.py não existir, retorna apenas META básica
            rule_results = {
                "META": {
                    "info": "rules.py não encontrado, interpretação básica"
                }
            }
        except Exception as e:
            rule_results = {
                "error": f"Erro ao aplicar regras: {str(e)}"
            }

        # 3. Opcionalmente chama LLM para estruturação adicional
        llm_results = {}
        if use_llm and ocr_text:
            try:
                llm_results = chamar_llama(ocr_text)
            except Exception as e:
                llm_results = {
                    "error": f"Erro ao chamar LLM: {str(e)}"
                }

        return {
            "request_id": request_id,
            "filename": filename,
            "rule_results": rule_results,
            "llm_results": llm_results,
            "status": "success"
        }

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Erro na interpretação: {str(e)}"
        )
