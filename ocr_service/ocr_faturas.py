# -*- coding: utf-8 -*-
import os
import re
import io
import sys
import csv
import json
import time
import unicodedata
import multiprocessing as mp
from concurrent.futures import ProcessPoolExecutor
from typing import Iterable, Optional, Dict, List, Tuple

from pypdf import PdfReader
from pypdf.errors import PdfReadError
from pdf2image import convert_from_path
import pytesseract

# =========================
# CONFIG
# =========================
ROOT = sys.argv[1] if len(sys.argv) > 1 else os.getenv("ROOT_DIR", r"D:\faturas\descompactadas")

OUTPUT_DIR = os.getenv(
    "OUTPUT_DIR",
    r"C:\Users\AlissonGonçalvesRodr\OneDrive - AMEnergia\Área de Trabalho"
)

OUTPUT_CSV = os.path.join(OUTPUT_DIR, "_mapeamento_faturas.csv")
PROGRESS_LOG = os.path.join(OUTPUT_DIR, "_mapeamento_faturas.progress.jsonl")
ERROR_LOG = os.path.join(OUTPUT_DIR, "_mapeamento_faturas.errors.log")

OCR_MAX_PAGES = int(os.getenv("OCR_MAX_PAGES", "3") or "3")
OCR_DPI = int(os.getenv("OCR_DPI", "220") or "220")
OCR_LANG = os.getenv("OCR_LANG", "por").strip() or "por"
OCR_PSM = os.getenv("OCR_PSM", "6").strip() or "6"

TEXT_MAX_PAGES = int(os.getenv("TEXT_MAX_PAGES", "3") or "3")
PDF_TEXT_MIN_LEN = int(os.getenv("PDF_TEXT_MIN_LEN", "30") or "30")

IO_WAIT_SECONDS = int(os.getenv("IO_WAIT_SECONDS", "15") or "15")
IO_MAX_RETRIES = int(os.getenv("IO_MAX_RETRIES", "999999") or "999999")

FORCE_REPROCESS = (os.getenv("FORCE_REPROCESS", "0") or "0").strip() == "1"
OCR_WHEN_MISSING_ANY_FIELD = (os.getenv("OCR_WHEN_MISSING_ANY_FIELD", "1") or "1").strip() == "1"

DEFAULT_WORKERS = max(1, (os.cpu_count() or 2) - 1)
MAX_WORKERS = int(os.getenv("MAX_WORKERS", str(DEFAULT_WORKERS)) or str(DEFAULT_WORKERS))
CHUNKSIZE = int(os.getenv("CHUNKSIZE", "50") or "50")
FLUSH_EVERY = int(os.getenv("FLUSH_EVERY", "1000") or "1000")
PROGRESS_EVERY = int(os.getenv("PROGRESS_EVERY", "100") or "100")

TESSERACT_CMD = os.getenv("TESSERACT_CMD", "").strip()
POPPLER_PATH = os.getenv("POPPLER_PATH", "").strip()

# =========================
# RÓTULOS / SINÔNIMOS
# Tudo em texto normalizado sem acento
# =========================
UC_LABELS = [
    r"\bu\s*\.?\s*c\s*\.?\b",
    r"\bunidade\s+consumidora\b",
    r"\bunidade\s+de\s+consumo\b",
    r"\bnumero\s+da\s+uc\b",
    r"\bnumero\s+da\s+unidade\s+consumidora\b",
    r"\bcodigo\s+da\s+uc\b",
    r"\bcodigo\s+da\s+unidade\s+consumidora\b",

    r"\binstalacao\b",
    r"\bcodigo\s+da\s+instalacao\b",
    r"\bcodigo\s+instalacao\b",
    r"\bparceiro\s+de\s+negocio\b",

    r"\binstalacao\s*/\s*unidade\s+consumidora\b",
    r"\bunidade\s+consumidora\s*/\s*instalacao\b",
    r"\bcodigo\s+da\s+instalacao\s*/\s*parceiro\s+de\s+negocio\b",
    r"\bparceiro\s+de\s+negocio\s*/\s*codigo\s+da\s+instalacao\b",
]

CONTRATO_LABELS = [
    r"\bconta\s+contrato\b",
    r"\bnumero\s+da\s+conta\s+contrato\b",
    r"\bnumero\s+do\s+contrato\b",
    r"\bcodigo\s+do\s+contrato\b",
    r"\bcontrato\b",
    r"\bnumero\s+do\s+cliente\b",
    r"\bn\s*[ºo°]?\s*cliente\b",
    r"\bcodigo\s+do\s+cliente\b",
    r"\bcliente\b",
]

MES_LABELS = [
    r"\bmes\s+de\s+referencia\b",
    r"\bmes\s+referencia\b",
    r"\bmes\s+ref\b",
    r"\breferencia\s+da\s+fatura\b",
    r"\breferencia\s+faturamento\b",
    r"\breferencia\s+de\s+consumo\b",
    r"\breferencia\b",
    r"\bcompetencia\b",
    r"\bmes\s+de\s+cobranca\b",
    r"\bmes\s*/\s*ano\b",
]

MONTH_NAME_MAP = {
    "jan": 1, "janeiro": 1,
    "fev": 2, "fevereiro": 2,
    "mar": 3, "marco": 3,
    "abr": 4, "abril": 4,
    "mai": 5, "maio": 5,
    "jun": 6, "junho": 6,
    "jul": 7, "julho": 7,
    "ago": 8, "agosto": 8,
    "set": 9, "setembro": 9,
    "out": 10, "outubro": 10,
    "nov": 11, "novembro": 11,
    "dez": 12, "dezembro": 12,
}

UC_LABEL_RE = None
CONTRATO_LABEL_RE = None
MES_LABEL_RE = None

# =========================
# HELPERS
# =========================
def norm_path(path: str) -> str:
    return os.path.normcase(os.path.normpath(path))


def is_root_available(root: str) -> bool:
    try:
        return os.path.exists(root)
    except Exception:
        return False


def wait_until_root_available(root: str, wait_seconds: int = IO_WAIT_SECONDS):
    announced = False
    while not is_root_available(root):
        if not announced:
            print(f"\n[PAUSA] Fonte indisponível: {root}")
            print(f"[PAUSA] Aguardando a unidade/pasta voltar... nova checagem em {wait_seconds}s.")
            announced = True
        time.sleep(wait_seconds)

    if announced:
        print(f"[RETOMADO] Fonte voltou a responder: {root}\n")


def safe_read_file_bytes(path: str, root: str, max_retries: int = IO_MAX_RETRIES) -> bytes:
    attempts = 0
    while True:
        wait_until_root_available(root)
        try:
            with open(path, "rb") as f:
                return f.read()
        except (OSError, FileNotFoundError) as e:
            attempts += 1
            if attempts >= max_retries:
                raise
            print(f"[IO] Falha ao ler: {path}")
            print(f"[IO] Motivo: {type(e).__name__}: {e}")
            print(f"[IO] Aguardando {IO_WAIT_SECONDS}s para tentar novamente...")
            time.sleep(IO_WAIT_SECONDS)


def normalize_text(text: str) -> str:
    if not text:
        return ""
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.replace("\x00", " ")
    text = text.lower()
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r"\n{2,}", "\n", text)
    return text


def unique_preserve_order(values: List[str]) -> List[str]:
    seen = set()
    out: List[str] = []
    for v in values:
        if v and v not in seen:
            seen.add(v)
            out.append(v)
    return out


def split_clean_lines(text: str) -> List[str]:
    text = normalize_text(text)
    lines = [re.sub(r"\s+", " ", line).strip(" :\t") for line in text.split("\n")]
    return [line for line in lines if line]


def build_compiled_label_regexes():
    uc = re.compile("|".join(f"(?:{p})" for p in UC_LABELS), re.IGNORECASE)
    contrato = re.compile("|".join(f"(?:{p})" for p in CONTRATO_LABELS), re.IGNORECASE)
    mes = re.compile("|".join(f"(?:{p})" for p in MES_LABELS), re.IGNORECASE)
    return uc, contrato, mes


def clean_numeric_candidate(raw: str) -> Optional[str]:
    if not raw:
        return None

    raw = raw.strip()

    if re.fullmatch(r"\d{1,2}\s*[/\-]\s*\d{2,4}", raw):
        return None
    if re.fullmatch(r"\d{1,2}\s*[/\-]\s*\d{1,2}\s*[/\-]\s*\d{2,4}", raw):
        return None

    digits = re.sub(r"\D", "", raw)
    if not digits:
        return None

    if len(digits) < 5 or len(digits) > 20:
        return None

    return digits


def extract_numeric_candidates(region: str) -> List[str]:
    if not region:
        return []

    out = []
    for m in re.finditer(r"(?<!\d)(\d[\d ./\-]{3,30}\d|\d{5,20})(?!\d)", region):
        cleaned = clean_numeric_candidate(m.group(1))
        if cleaned:
            out.append(cleaned)
    return unique_preserve_order(out)


def parse_month_token(raw: str) -> Optional[str]:
    if not raw:
        return None

    txt = normalize_text(raw)
    txt = re.sub(r"\s+", " ", txt).strip()

    m = re.search(r"\b(0?[1-9]|1[0-2])\s*[/\-]\s*(\d{2,4})\b", txt)
    if m:
        mm = int(m.group(1))
        yy = m.group(2)
        yyyy = int("20" + yy) if len(yy) == 2 else int(yy)
        return f"{mm:02d}/{yyyy:04d}"

    m = re.search(r"\b(0[1-9]|1[0-2])(\d{4})\b", txt)
    if m:
        return f"{int(m.group(1)):02d}/{int(m.group(2)):04d}"

    m = re.search(
        r"\b(jan(?:eiro)?|fev(?:ereiro)?|mar(?:co)?|abr(?:il)?|mai(?:o)?|jun(?:ho)?|jul(?:ho)?|ago(?:sto)?|set(?:embro)?|out(?:ubro)?|nov(?:embro)?|dez(?:embro)?)\s*[/\- ]\s*(\d{2,4})\b",
        txt,
        re.IGNORECASE,
    )
    if m:
        mes_nome = m.group(1)
        ano = m.group(2)
        yyyy = int("20" + ano) if len(ano) == 2 else int(ano)
        mm = MONTH_NAME_MAP.get(mes_nome, MONTH_NAME_MAP.get(mes_nome[:3]))
        if mm:
            return f"{mm:02d}/{yyyy:04d}"

    return None


def extract_month_candidates(region: str) -> List[str]:
    if not region:
        return []

    found: List[str] = []
    region = normalize_text(region)

    for m in re.finditer(r"\b(0?[1-9]|1[0-2])\s*[/\-]\s*(\d{2,4})\b", region):
        token = parse_month_token(m.group(0))
        if token:
            found.append(token)

    for m in re.finditer(r"\b(0[1-9]|1[0-2])(\d{4})\b", region):
        token = parse_month_token(m.group(0))
        if token:
            found.append(token)

    for m in re.finditer(
        r"\b(jan(?:eiro)?|fev(?:ereiro)?|mar(?:co)?|abr(?:il)?|mai(?:o)?|jun(?:ho)?|jul(?:ho)?|ago(?:sto)?|set(?:embro)?|out(?:ubro)?|nov(?:embro)?|dez(?:embro)?)\s*[/\- ]\s*(\d{2,4})\b",
        region,
        re.IGNORECASE,
    ):
        token = parse_month_token(m.group(0))
        if token:
            found.append(token)

    return unique_preserve_order(found)


def build_regions(lines: List[str], idx: int, match_end: int) -> List[str]:
    same_suffix = lines[idx][match_end:].strip()
    next1 = lines[idx + 1] if idx + 1 < len(lines) else ""
    next2 = lines[idx + 2] if idx + 2 < len(lines) else ""
    next3 = lines[idx + 3] if idx + 3 < len(lines) else ""

    regions = [
        same_suffix[:140],
        (same_suffix + " " + next1).strip()[:180],
        next1[:140],
        (next1 + " " + next2).strip()[:180],
        next2[:140],
        (next2 + " " + next3).strip()[:180],
        next3[:140],
    ]
    return [r for r in regions if r]


def extract_numbers_by_label(lines: List[str], label_re: re.Pattern) -> List[str]:
    out: List[str] = []

    for idx, line in enumerate(lines):
        for m in label_re.finditer(line):
            regions = build_regions(lines, idx, m.end())
            picked = []

            for region in regions:
                nums = extract_numeric_candidates(region)
                if nums:
                    picked.extend(nums[:2])
                    break

            if picked:
                out.extend(picked)

    return unique_preserve_order(out)


def extract_months_by_label(lines: List[str], label_re: re.Pattern) -> List[str]:
    out: List[str] = []

    for idx, line in enumerate(lines):
        for m in label_re.finditer(line):
            regions = build_regions(lines, idx, m.end())
            picked = []

            for region in regions:
                months = extract_month_candidates(region)
                if months:
                    picked.extend(months[:2])
                    break

            if picked:
                out.extend(picked)

    return unique_preserve_order(out)


def fallback_global_month(lines: List[str]) -> List[str]:
    first_lines = lines[:40]
    all_months: List[str] = []
    for line in first_lines:
        all_months.extend(extract_month_candidates(line))
    all_months = unique_preserve_order(all_months)

    if len(all_months) == 1:
        return all_months
    return []


def extract_fields_from_text(text: str) -> dict:
    lines = split_clean_lines(text)

    uc_values = extract_numbers_by_label(lines, UC_LABEL_RE)
    contrato_values = extract_numbers_by_label(lines, CONTRATO_LABEL_RE)
    mes_values = extract_months_by_label(lines, MES_LABEL_RE)

    if not mes_values:
        mes_values = fallback_global_month(lines)

    return {
        "unidade_consumo_list": unique_preserve_order(uc_values),
        "contrato_list": unique_preserve_order(contrato_values),
        "mes_referencia_list": unique_preserve_order(mes_values),
    }


def merge_extracted(a: dict, b: dict) -> dict:
    return {
        "unidade_consumo_list": unique_preserve_order((a or {}).get("unidade_consumo_list", []) + (b or {}).get("unidade_consumo_list", [])),
        "contrato_list": unique_preserve_order((a or {}).get("contrato_list", []) + (b or {}).get("contrato_list", [])),
        "mes_referencia_list": unique_preserve_order((a or {}).get("mes_referencia_list", []) + (b or {}).get("mes_referencia_list", [])),
    }


def missing_fields(extracted: dict) -> List[str]:
    missing = []
    if not extracted.get("unidade_consumo_list"):
        missing.append("unidade_consumo")
    if not extracted.get("contrato_list"):
        missing.append("contrato")
    if not extracted.get("mes_referencia_list"):
        missing.append("mes_referencia")
    return missing


def extract_text_tolerant_from_bytes(data: bytes, max_pages: int = TEXT_MAX_PAGES) -> str:
    if len(data) < 100:
        return ""

    if b"%%EOF" not in data[-4096:]:
        data = data + b"\n%%EOF\n"

    reader = PdfReader(io.BytesIO(data), strict=False)

    if getattr(reader, "is_encrypted", False):
        try:
            reader.decrypt("")
        except Exception:
            return ""

    parts = []
    total_pages = len(reader.pages)
    limit = min(total_pages, max_pages) if max_pages > 0 else total_pages

    for i in range(limit):
        try:
            parts.append(reader.pages[i].extract_text() or "")
        except Exception:
            continue

    return "\n".join(parts)


def decode_bytes_fallback(data: bytes) -> str:
    try:
        return data.decode("latin-1", errors="ignore")
    except Exception:
        return ""


def ocr_pdf_text_progressive(path: str) -> Tuple[str, int]:
    kwargs = {"dpi": OCR_DPI}
    if POPPLER_PATH:
        kwargs["poppler_path"] = POPPLER_PATH

    config = f"--oem 1 --psm {OCR_PSM}"
    parts = []
    pages_used = 0

    for page_no in range(1, OCR_MAX_PAGES + 1):
        try:
            wait_until_root_available(ROOT)
            images = convert_from_path(path, first_page=page_no, last_page=page_no, **kwargs)
            text = pytesseract.image_to_string(images[0], lang=OCR_LANG, config=config) if images else ""
            if text and text.strip():
                parts.append(text)
            pages_used = page_no
        except Exception:
            continue

    return "\n".join(parts), pages_used


def append_progress(res: dict):
    with open(PROGRESS_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(res, ensure_ascii=False) + "\n")


def append_error_line(line: str):
    with open(ERROR_LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_processed_paths(progress_log: str) -> set:
    processed = set()

    if FORCE_REPROCESS or not os.path.exists(progress_log):
        return processed

    with open(progress_log, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except Exception:
                continue

            path = item.get("path")
            status = item.get("status")

            if path and status == "ok":
                processed.add(norm_path(path))

    return processed


def get_pdf_files(root: str, processed_paths: set) -> Iterable[str]:
    wait_until_root_available(root)

    for root_dir, _, filenames in os.walk(root):
        for filename in filenames:
            if not filename.lower().endswith(".pdf"):
                continue
            if filename.startswith("._"):
                continue

            full_path = os.path.join(root_dir, filename)

            if norm_path(full_path) in processed_paths:
                continue

            yield full_path


# =========================
# WORKER
# =========================
def _init_worker():
    global UC_LABEL_RE, CONTRATO_LABEL_RE, MES_LABEL_RE

    UC_LABEL_RE, CONTRATO_LABEL_RE, MES_LABEL_RE = build_compiled_label_regexes()

    if TESSERACT_CMD:
        pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD


def process_file(path: str):
    try:
        data = safe_read_file_bytes(path, ROOT)

        extracted_total = {
            "unidade_consumo_list": [],
            "contrato_list": [],
            "mes_referencia_list": [],
        }
        methods: List[str] = []

        # 1) texto nativo
        text = extract_text_tolerant_from_bytes(data, max_pages=TEXT_MAX_PAGES) or ""
        if text.strip():
            methods.append("text")
            extracted_total = merge_extracted(extracted_total, extract_fields_from_text(text))

        # 2) bytes fallback
        if len(text.strip()) < PDF_TEXT_MIN_LEN or missing_fields(extracted_total):
            decoded = decode_bytes_fallback(data)
            extracted_bytes = extract_fields_from_text(decoded)
            if (
                extracted_bytes["unidade_consumo_list"]
                or extracted_bytes["contrato_list"]
                or extracted_bytes["mes_referencia_list"]
            ):
                methods.append("bytes")
                extracted_total = merge_extracted(extracted_total, extracted_bytes)

        # 3) OCR quando faltar qualquer campo
        if OCR_WHEN_MISSING_ANY_FIELD and missing_fields(extracted_total):
            ocr_text, pages_used = ocr_pdf_text_progressive(path)
            if ocr_text.strip():
                methods.append(f"ocr-p{pages_used}")
                extracted_total = merge_extracted(extracted_total, extract_fields_from_text(ocr_text))

        return {
            "status": "ok",
            "path": path,
            "arquivo": os.path.basename(path),
            "unidade_consumo": " | ".join(unique_preserve_order(extracted_total["unidade_consumo_list"])),
            "contrato": " | ".join(unique_preserve_order(extracted_total["contrato_list"])),
            "mes_referencia": " | ".join(unique_preserve_order(extracted_total["mes_referencia_list"])),
            "method": "+".join(unique_preserve_order(methods)),
            "missing": missing_fields(extracted_total),
        }

    except (PdfReadError, OSError) as exc:
        return {
            "status": "error",
            "path": path,
            "arquivo": os.path.basename(path),
            "unidade_consumo": "",
            "contrato": "",
            "mes_referencia": "",
            "method": "",
            "missing": ["unidade_consumo", "contrato", "mes_referencia"],
            "error_line": f"{path} -> {type(exc).__name__}: {exc}",
        }

    except Exception as exc:
        return {
            "status": "error",
            "path": path,
            "arquivo": os.path.basename(path),
            "unidade_consumo": "",
            "contrato": "",
            "mes_referencia": "",
            "method": "",
            "missing": ["unidade_consumo", "contrato", "mes_referencia"],
            "error_line": f"{path} -> {type(exc).__name__}: {exc}",
        }


# =========================
# MAIN
# =========================
def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    if FORCE_REPROCESS:
        for fp in (OUTPUT_CSV, PROGRESS_LOG, ERROR_LOG):
            try:
                if os.path.exists(fp):
                    os.remove(fp)
            except Exception:
                pass

    processed_paths = load_processed_paths(PROGRESS_LOG)

    csv_exists = os.path.exists(OUTPUT_CSV)
    csv_mode = "a" if (csv_exists and processed_paths and not FORCE_REPROCESS) else "w"

    print(f"[*] ROOT: {ROOT}")
    print(f"[*] OUTPUT_DIR: {OUTPUT_DIR}")
    print(f"[*] OUTPUT_CSV: {OUTPUT_CSV}")
    print(f"[*] PROGRESS_LOG: {PROGRESS_LOG}")
    print(f"[*] ERROR_LOG: {ERROR_LOG}")
    print(f"[*] MAX_WORKERS: {MAX_WORKERS}")
    print(f"[*] CHUNKSIZE: {CHUNKSIZE}")
    print(f"[*] OCR_MAX_PAGES: {OCR_MAX_PAGES}")
    print(f"[*] TEXT_MAX_PAGES: {TEXT_MAX_PAGES}")
    print(f"[*] FORCE_REPROCESS: {FORCE_REPROCESS}")
    print(f"[*] Já processados: {len(processed_paths)}")

    with open(OUTPUT_CSV, csv_mode, newline="", encoding="utf-8-sig") as f_out:
        writer = csv.writer(f_out)

        if csv_mode == "w":
            writer.writerow(["arquivo", "unidade_consumo", "contrato", "mes_referencia"])

        with ProcessPoolExecutor(max_workers=MAX_WORKERS, initializer=_init_worker) as executor:
            results = executor.map(
                process_file,
                get_pdf_files(ROOT, processed_paths),
                chunksize=CHUNKSIZE,
            )

            for i, res in enumerate(results, 1):
                append_progress(res)

                if res["status"] == "ok":
                    writer.writerow([
                        res.get("arquivo", ""),
                        res.get("unidade_consumo", ""),
                        res.get("contrato", ""),
                        res.get("mes_referencia", ""),
                    ])
                else:
                    append_error_line(res.get("error_line", "erro_desconhecido"))

                if i % PROGRESS_EVERY == 0:
                    miss = ",".join(res.get("missing") or []) if isinstance(res, dict) else "-"
                    sys.stdout.write(
                        f"\r[PROCESSO] {i} PDFs nesta execução... último={res.get('arquivo', '')} faltando={miss or '-'}"
                    )
                    sys.stdout.flush()

                if i % FLUSH_EVERY == 0:
                    f_out.flush()

        f_out.flush()

    print(f"\n[FINALIZADO] CSV: {OUTPUT_CSV}")


if __name__ == "__main__":
    mp.freeze_support()
    main()