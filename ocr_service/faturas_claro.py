import os
import re
import io
import unicodedata
from datetime import datetime
from concurrent.futures import ProcessPoolExecutor, as_completed
import multiprocessing as mp

from pypdf import PdfReader
from pypdf.errors import PdfReadError
from pdf2image import convert_from_path
import pytesseract

# =========================
# CONFIG
# =========================
ROOT = r"C:\Users\AlissonGonçalvesRodr\Downloads\faturas_claro"
UCS = ["421106662", "44834251", "6327427"]

ERROR_LOG = os.path.join(ROOT, "_scan_errors.log")
FOUND_LOG = os.path.join(ROOT, f"_scan_found_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log")

# OCR settings
OCR_MAX_PAGES = int(os.getenv("OCR_MAX_PAGES", "2") or "2")
OCR_DPI = int(os.getenv("OCR_DPI", "240") or "240")
OCR_LANG = os.getenv("OCR_LANG", "por").strip() or "por"
OCR_PSM = os.getenv("OCR_PSM", "6").strip() or "6"
TESSERACT_CMD = os.getenv("TESSERACT_CMD", "").strip()
POPPLER_PATH = os.getenv("POPPLER_PATH", "").strip()

# Turbo: paralelismo
DEFAULT_WORKERS = max(1, (os.cpu_count() or 2) - 1)
MAX_WORKERS = int(os.getenv("MAX_WORKERS", str(DEFAULT_WORKERS)) or str(DEFAULT_WORKERS))

# Progresso
PROGRESS_EVERY = int(os.getenv("PROGRESS_EVERY", "200") or "200")

# =========================
# HELPERS
# =========================
def normalize_text(text: str) -> str:
    normalized = unicodedata.normalize("NFD", text or "")
    normalized = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    normalized = normalized.lower()
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized)
    return " ".join(normalized.split())


def squash_text(text: str) -> str:
    normalized = unicodedata.normalize("NFD", text or "")
    normalized = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    normalized = normalized.lower()
    return re.sub(r"[^a-z0-9]+", "", normalized)


def compile_patterns(ucs):
    patterns = []
    for u in ucs:
        raw = re.compile(r"(?:UC\s*[:\\-]?\\s*)?\\b" + re.escape(u) + r"\\b", re.IGNORECASE)
        norm = normalize_text(u)
        norm_re = re.compile(r"(?:^|\\s)" + re.escape(norm) + r"(?:$|\\s)")
        squashed = squash_text(u)
        patterns.append({"raw": raw, "norm_re": norm_re, "squashed": squashed, "value": u})
    return patterns


def read_file_bytes(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def extract_text_tolerant_from_bytes(data: bytes) -> str:
    if len(data) < 2_000:
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
    for page in reader.pages:
        try:
            parts.append(page.extract_text() or "")
        except Exception:
            continue
    return "\n".join(parts)


def search_in_text(text: str, patterns):
    if not text:
        return []

    hits = [p["value"] for p in patterns if p["raw"].search(text)]
    if hits:
        return hits

    norm_text = normalize_text(text)
    squashed_text = squash_text(text)

    hits = [
        p["value"]
        for p in patterns
        if p["norm_re"].search(norm_text) or p["squashed"] in squashed_text
    ]
    return hits


def fallback_search_bytes_decoded(data: bytes, patterns):
    s = data.decode("latin-1", errors="ignore")
    norm_text = normalize_text(s)
    squashed_text = squash_text(s)
    hits = []
    for p in patterns:
        if p["raw"].search(s) or p["norm_re"].search(norm_text) or p["squashed"] in squashed_text:
            hits.append(p["value"])
    return hits


def bin_fast_search(data: bytes, ucs):
    candidates = []
    for u in ucs:
        try:
            if u.encode("ascii") in data:
                candidates.append(u)
        except Exception:
            continue
    return candidates


def ocr_pdf_text_progressive(path: str, patterns) -> tuple[str, list, int]:
    kwargs = {"dpi": OCR_DPI}
    if POPPLER_PATH:
        kwargs["poppler_path"] = POPPLER_PATH

    config = f"--oem 1 --psm {OCR_PSM}"

    # Page 1
    try:
        images = convert_from_path(path, first_page=1, last_page=1, **kwargs)
        text1 = pytesseract.image_to_string(images[0], lang=OCR_LANG, config=config) if images else ""
    except Exception:
        text1 = ""

    hits1 = search_in_text(text1, patterns)
    if hits1:
        return text1, hits1, 1

    if OCR_MAX_PAGES >= 2:
        try:
            images = convert_from_path(path, first_page=2, last_page=2, **kwargs)
            text2 = pytesseract.image_to_string(images[0], lang=OCR_LANG, config=config) if images else ""
        except Exception:
            text2 = ""

        full = (text1 or "") + "\n" + (text2 or "")
        hits2 = search_in_text(full, patterns)
        return full, hits2, 2

    return text1 or "", [], 1


def write_found_log(found_items, log_path: str):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(log_path, "w", encoding="utf-8") as f:
        f.write("# Scan FOUND log\n")
        f.write(f"# created_at: {ts}\n")
        f.write(f"# root: {ROOT}\n")
        f.write(f"# ucs: {', '.join(UCS)}\n")
        f.write(f"# total_found_files: {len(found_items)}\n\n")
        for item in found_items:
            hits_str = ", ".join(item["hits"])
            f.write(f"{item['path']} | hits: {hits_str} | method: {item['method']}\n")


def write_error_log(error_items, log_path: str):
    with open(log_path, "a", encoding="utf-8") as f:
        for item in error_items:
            f.write(item + "\n")


def list_pdfs(root: str):
    pdfs = []
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            if name.lower().endswith(".pdf"):
                pdfs.append(os.path.join(dirpath, name))
    return pdfs


# =========================
# TURBO: multiprocessing
# =========================
_PATTERNS = None
_UCS = None


def _init_worker(ucs):
    global _PATTERNS, _UCS
    _UCS = list(ucs)
    _PATTERNS = compile_patterns(_UCS)

    if TESSERACT_CMD:
        pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD


def _process_one_pdf(path: str):
    global _PATTERNS, _UCS
    try:
        data = read_file_bytes(path)

        candidates = bin_fast_search(data, _UCS)
        if candidates:
            decoded = data.decode("latin-1", errors="ignore")
            hits = [p["value"] for p in _PATTERNS if p["value"] in candidates and p["raw"].search(decoded)]
            if hits:
                return {"status": "hit", "path": path, "hits": hits, "method": "bin-fast-confirmed"}

        text = extract_text_tolerant_from_bytes(data)
        hits = search_in_text(text, _PATTERNS)
        if hits:
            return {"status": "hit", "path": path, "hits": hits, "method": "text"}

        if not text or len(text.strip()) < 20:
            hits = fallback_search_bytes_decoded(data, _PATTERNS)
            if hits:
                return {"status": "hit", "path": path, "hits": hits, "method": "fallback-bytes"}

            _, hits, pages_used = ocr_pdf_text_progressive(path, _PATTERNS)
            if hits:
                return {"status": "hit", "path": path, "hits": hits, "method": f"ocr-p{pages_used}"}

        return {"status": "none", "path": path, "hits": [], "method": ""}

    except (PdfReadError, OSError) as exc:
        try:
            data = read_file_bytes(path)
            hits = fallback_search_bytes_decoded(data, _PATTERNS)
            if hits:
                return {"status": "hit", "path": path, "hits": hits, "method": "fallback-bytes"}
        except Exception:
            pass

        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        return {
            "status": "error",
            "path": path,
            "hits": [],
            "method": "",
            "error_line": f"[{ts}] {path} -> {type(exc).__name__}: {exc}",
        }

    except Exception as exc:
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        return {
            "status": "error",
            "path": path,
            "hits": [],
            "method": "",
            "error_line": f"[{ts}] {path} -> {type(exc).__name__}: {exc}",
        }


def run_turbo_scan(root: str, ucs: list[str]):
    pdfs = list_pdfs(root)

    found_items = []
    error_lines = []

    scanned = 0
    matches = 0
    errors = 0
    found_by_uc = {u: 0 for u in ucs}

    with ProcessPoolExecutor(max_workers=MAX_WORKERS, initializer=_init_worker, initargs=(ucs,)) as ex:
        futures = [ex.submit(_process_one_pdf, p) for p in pdfs]

        for fut in as_completed(futures):
            res = fut.result()
            scanned += 1

            if res["status"] == "hit":
                matches += 1
                hits = res["hits"]
                line = f"{res['path']} -> {', '.join(hits)} ({res['method']})"
                print(line)
                found_items.append({"path": res["path"], "hits": hits, "method": res["method"]})
                for h in set(hits):
                    if h in found_by_uc:
                        found_by_uc[h] += 1

            elif res["status"] == "error":
                errors += 1
                error_lines.append(res["error_line"])

            if PROGRESS_EVERY and scanned % PROGRESS_EVERY == 0:
                print(f"Progresso: {scanned}/{len(pdfs)} PDFs concluídos...")

    if found_items:
        write_found_log(found_items, FOUND_LOG)

    if error_lines:
        write_error_log(error_lines, ERROR_LOG)

    return scanned, matches, errors, found_items, found_by_uc, len(pdfs)


# =========================
# MAIN
# =========================
if __name__ == "__main__":
    mp.freeze_support()

    try:
        print(f"Turbo scan iniciado em: {ROOT}")
        print(f"MAX_WORKERS = {MAX_WORKERS} (ajuste com env MAX_WORKERS)")
        print(f"OCR_DPI={OCR_DPI} OCR_MAX_PAGES={OCR_MAX_PAGES} OCR_LANG={OCR_LANG} OCR_PSM={OCR_PSM}")

        scanned, total, errors, found_items, found_by_uc, total_pdfs = run_turbo_scan(ROOT, UCS)

        print(f"\nTotal de PDFs encontrados no disco: {total_pdfs}")
        print(f"PDFs processados: {scanned}")
        print(f"Arquivos com correspondência: {total}")
        print(f"Arquivos com erro (log): {errors}")

        # ✅ NOVO: imprime no final os caminhos encontrados (igual ao console durante a varredura)
        if found_items:
            print("\n==============================")
            print("FATURAS ENCONTRADAS (FINAL):")
            print("==============================")
            # Ordena por caminho para ficar fácil de copiar/colar
            for item in sorted(found_items, key=lambda x: x["path"].lower()):
                print(f"{item['path']} -> {', '.join(item['hits'])} ({item['method']})")

            print(f"\nLog de encontrados: {FOUND_LOG}")

            print("\nResumo por UC (qtd de PDFs onde apareceu):")
            for uc, count in sorted(found_by_uc.items(), key=lambda x: (-x[1], x[0])):
                print(f"- {uc}: {count}")

        if errors:
            print(f"\nLog de erros: {ERROR_LOG}")

    except KeyboardInterrupt:
        print("\nInterrompido pelo usuário (sem traceback).")
