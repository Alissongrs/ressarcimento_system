import io
import os
from typing import List

from fastapi import FastAPI, File, UploadFile, Form
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pdf2image import convert_from_bytes
from pdfminer.high_level import extract_text as pdf_extract_text
import pytesseract
from PIL import Image
from rules import apply_rules
import uvicorn

app = FastAPI(title="OCR Service", version="0.1.0")

# CORS – libera para o front em dev (ajuste origins se quiser travar depois)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # ou ["http://localhost:5173"] se quiser travar
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Optional Windows/macOS helpers via env vars
# - TESSERACT_CMD: full path to tesseract executable
# - POPPLER_PATH: directory to poppler bin (for pdf2image on Windows)
TESSERACT_CMD = os.getenv("TESSERACT_CMD")
if TESSERACT_CMD:
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD

POPPLER_PATH = os.getenv("POPPLER_PATH")


@app.get("/ping")
def ping():
    return {"ok": True}


def ocr_image(img: Image.Image, lang: str) -> str:
    # se não vier lang, usa por+eng como default
    return pytesseract.image_to_string(img, lang=lang or "por+eng")


@app.post("/analyze")
async def analyze(
    files: List[UploadFile] = File(...),
    instruction: str = Form(""),
    lang: str = Form("por+eng"),
    max_pages: int = Form(3),
    apply_rules_flag: int = Form(0),
    rules: str = Form(""),
):
    results = []
    max_pages = int(max_pages)

    for f in files:
        name = f.filename or "file"
        content = await f.read()
        text_parts: List[str] = []
        pages_used = 0

        try:
            if name.lower().endswith(".pdf"):
                # 1) Tenta extrair texto nativo do PDF
                try:
                    pdf_text = pdf_extract_text(io.BytesIO(content)) or ""
                except Exception:
                    pdf_text = ""

                if pdf_text.strip():
                    text_parts.append(pdf_text)
                else:
                    # 2) fallback: OCR nas primeiras páginas (PDF imagem)
                    if POPPLER_PATH:
                        pages = convert_from_bytes(
                            content, dpi=200, fmt="png", poppler_path=POPPLER_PATH
                        )
                    else:
                        pages = convert_from_bytes(content, dpi=200, fmt="png")

                    for p in pages:
                        if pages_used >= max_pages:
                            break
                        text_parts.append(ocr_image(p, lang))
                        pages_used += 1
            else:
                # imagem (png/jpg/etc.)
                img = Image.open(io.BytesIO(content)).convert("RGB")
                text_parts.append(ocr_image(img, lang))
                pages_used = 1
        except Exception as e:
            text_parts.append(f"[ocr_error] {e}")

        raw_text = "\n".join(t.strip() for t in text_parts if t)
        item = {
            "file_name": name,
            "raw_text": raw_text,
            "pages_used": pages_used,
            "instruction": instruction,
        }

        if apply_rules_flag:
            rule_list = [s.strip() for s in (rules or "").split(",") if s.strip()]
            item["rule_results"] = apply_rules(raw_text, rule_list)

        results.append(item)

    return JSONResponse({"results": results})


if __name__ == "__main__":
    # Porta 5002 pra não bater com outros serviços (ajuste se quiser)
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "5002")),
        reload=True,
    )
