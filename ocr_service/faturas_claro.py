import os
import re
import io
import sys
import time
import unicodedata
import shutil
import json
import hashlib
import threading
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor, wait, FIRST_COMPLETED
import multiprocessing as mp

from pypdf import PdfReader
from pypdf.errors import PdfReadError
from pdf2image import convert_from_path
import pytesseract

# Aho-Corasick (pip install pyahocorasick)
try:
    import ahocorasick
    HAS_AHOCORASICK = True
except ImportError:
    HAS_AHOCORASICK = False

# =========================
# CONFIG - ROOTS
# =========================
def _parse_roots() -> list[str]:
    if len(sys.argv) > 1:
        return [r.strip().strip('"') for r in sys.argv[1:] if str(r).strip()]
    env_roots = os.getenv("ROOT_DIRS", "").strip()
    if env_roots:
        return [r.strip().strip('"') for r in env_roots.split(";") if r.strip()]
    return [
        r"C:\Users\AlissonGonçalvesRodr\OneDrive - AMEnergia\Área de Trabalho\base",
        r"D:\faturas\descompactadas",
    ]


ROOTS = _parse_roots()
OUTPUT_DIR = os.getenv("OUTPUT_DIR", ROOTS[0] if ROOTS else os.getcwd()).strip()

# =========================
# IDS
# =========================
IDS = [
    "20007079917", "20007339201", "20006791021", "20006782611", "20006781436",
    "60000148005", "20006863148", "20006139369", "20006149150", "20006160308",
    "414183927", "20006988026", "60000112002", "20006150802", "413581589",
    "413688892", "413607760", "413646289", "20006067045", "60000153005",
    "60000151001", "413663917", "6327427", "44834251", "4497372", "47822955",
    "46030427", "35528559", "414636858", "414737949", "413615689", "413689788",
    "413694945", "413592946", "414084621", "414007299", "421059110", "413608955",
    "414008097", "2917985", "21575763", "21166067", "5570557", "6461547",
    "6691458", "39026600", "413815170", "413813542", "22797882", "3011912795",
    "21593508", "1300329", "200872003", "101677818", "3012078020", "421106662",
    "420414230", "420444474", "414856849", "414839939", "420424752", "414444347",
    "2000339670", "8083742422", "20006153143", "60000144006", "414843501",
    "60000142001", "20006144028", "60000038003", "21600635", "3011982659",
    "1300329", "4207074",
]

_seen = set()
IDS = [u for u in (str(x).strip() for x in IDS) if u and (u not in _seen and not _seen.add(u))]

# =========================
# OUTPUT / LOGS
# =========================
TS = datetime.now().strftime("%Y%m%d_%H%M%S")
DEST_FOUND_DIR = r"C:\Users\AlissonGonçalvesRodr\OneDrive - AMEnergia\Área de Trabalho\Versoes\faturas"
ERROR_LOG      = os.path.join(OUTPUT_DIR, "_scan_errors.log")
FOUND_LOG      = os.path.join(OUTPUT_DIR, f"_scan_found_{TS}.log")
PROGRESS_LOG   = os.path.join(OUTPUT_DIR, "_scan_progress.jsonl")

# OCR settings
OCR_MAX_PAGES = int(os.getenv("OCR_MAX_PAGES", "1") or "1")
OCR_DPI       = int(os.getenv("OCR_DPI", "240") or "240")
OCR_LANG      = os.getenv("OCR_LANG", "por").strip() or "por"
OCR_PSM       = os.getenv("OCR_PSM", "6").strip() or "6"
TESSERACT_CMD = os.getenv("TESSERACT_CMD", "").strip()
POPPLER_PATH  = os.getenv("POPPLER_PATH", "").strip()

ENABLE_OCR = (os.getenv("ENABLE_OCR", "1").strip() != "0") and (OCR_MAX_PAGES > 0)

# -----------------------------------------------------------------------
# WORKER TYPE: "process" (CPU-bound, local SSD) ou "thread" (I/O, rede)
# -----------------------------------------------------------------------
# Para OneDrive/UNC/NAS: USE_THREADS=1 dá throughput muito maior
USE_THREADS = os.getenv("USE_THREADS", "0").strip() != "0"

DEFAULT_WORKERS = max(1, (os.cpu_count() or 2) - 1)
if USE_THREADS:
    DEFAULT_WORKERS = min(32, (os.cpu_count() or 4) * 4)

MAX_WORKERS    = int(os.getenv("MAX_WORKERS", str(DEFAULT_WORKERS)) or str(DEFAULT_WORKERS))
PROGRESS_EVERY = int(os.getenv("PROGRESS_EVERY", "200") or "200")

# Buffer de progresso: flush a cada N registros em vez de open/write/close por PDF
PROGRESS_FLUSH_EVERY = int(os.getenv("PROGRESS_FLUSH_EVERY", "50") or "50")

IO_WAIT_SECONDS = int(os.getenv("IO_WAIT_SECONDS", "15") or "15")
IO_MAX_RETRIES  = int(os.getenv("IO_MAX_RETRIES", "3") or "3")  # 3 tentativas em SSD; aumente para OneDrive

QUEUE_MULTIPLIER = int(os.getenv("QUEUE_MULTIPLIER", "3") or "3")
MAX_IN_FLIGHT    = max(MAX_WORKERS, MAX_WORKERS * QUEUE_MULTIPLIER)

ID_PREFIX_RE = (
    r"(?:UC|U\.?\s*C\.?|UNIDADE\s*CONSUMIDORA|CLIENTE|N[ºo°]\s*CLIENTE|"
    r"N(?:U|Ú)MERO\s*(?:DO\s*)?CLIENTE|COD(?:I|Í)GO\s*(?:DO\s*)?CLIENTE|"
    r"COD(?:IGO)?\s*(?:DO\s*)?CLIENTE|C[ÓO]D\.\s*CLIENTE)\s*[:\-]?\s*"
)

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
            print(f"[PAUSA] Aguardando {wait_seconds}s...")
            announced = True
        time.sleep(wait_seconds)
    if announced:
        print(f"[RETOMADO] {root}\n")


def find_root_for_path(path: str) -> str:
    p = norm_path(path)
    for r in _ROOTS_GLOBAL:
        if p.startswith(norm_path(r)):
            return r
    return os.path.dirname(path)



def safe_read_file_bytes(path: str, root_hint: str, max_retries: int = IO_MAX_RETRIES) -> bytes:
    """Lê arquivo com retry automático — útil para OneDrive/rede que pode desconectar."""
    attempts = 0
    while True:
        wait_until_root_available(root_hint)
        try:
            with open(path, "rb") as f:
                return f.read()
        except (OSError, FileNotFoundError) as e:
            attempts += 1
            if attempts >= max_retries:
                raise
            print(f"[IO] Falha ao ler: {path} | {type(e).__name__}: {e}")
            print(f"[IO] Tentativa {attempts} — aguardando {IO_WAIT_SECONDS}s...")
            time.sleep(IO_WAIT_SECONDS)


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


def compile_patterns(ids_list):
    patterns = []
    for item_id in ids_list:
        raw = re.compile(r"(?:%s)?\b%s\b" % (ID_PREFIX_RE, re.escape(item_id)), re.IGNORECASE)
        norm = normalize_text(item_id)
        norm_re = re.compile(r"(?:^|\s)" + re.escape(norm) + r"(?:$|\s)")
        squashed = squash_text(item_id)
        patterns.append({"raw": raw, "norm_re": norm_re, "squashed": squashed, "value": item_id})
    return patterns


# =========================
# AHO-CORASICK (binário)
# =========================
def build_automaton(ids_list: list[str]):
    """Constrói autômato Aho-Corasick para busca binária de todos os IDs de uma vez."""
    if not HAS_AHOCORASICK:
        return None
    A = ahocorasick.Automaton()
    for item_id in ids_list:
        try:
            key = item_id.encode("ascii")
            A.add_word(key, item_id)
        except Exception:
            pass
    if len(A) == 0:
        return None
    A.make_automaton()
    return A


def bin_fast_search_ac(data: bytes, automaton) -> list[str]:
    """Busca todos os IDs em O(len(data)) usando Aho-Corasick."""
    hits = set()
    for _, item_id in automaton.iter(data):
        hits.add(item_id)
    return sorted(hits)


def bin_fast_search_fallback(data: bytes, ids_list: list[str]) -> list[str]:
    """Fallback sem pyahocorasick — loop simples."""
    hits = []
    for item_id in ids_list:
        try:
            if item_id.encode("ascii") in data:
                hits.append(item_id)
        except Exception:
            continue
    return hits


# =========================
# PDF TEXT
# =========================
def extract_text_tolerant_from_bytes(data: bytes) -> str:
    if len(data) < 2_000:
        return ""
    if b"%%EOF" not in data[-4096:]:
        data = data + b"\n%%EOF\n"
    try:
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
    except Exception:
        return ""


def search_in_text(text: str, patterns) -> list[str]:
    if not text:
        return []
    hits = [p["value"] for p in patterns if p["raw"].search(text)]
    if hits:
        return sorted(set(hits))
    norm_text = normalize_text(text)
    squashed_text = squash_text(text)
    hits = [
        p["value"]
        for p in patterns
        if p["norm_re"].search(norm_text) or p["squashed"] in squashed_text
    ]
    return sorted(set(hits))


def fallback_search_bytes_decoded(data: bytes, patterns) -> list[str]:
    decoded = data.decode("latin-1", errors="ignore")
    norm_text = normalize_text(decoded)
    squashed_text = squash_text(decoded)
    hits = []
    for p in patterns:
        if p["raw"].search(decoded) or p["norm_re"].search(norm_text) or p["squashed"] in squashed_text:
            hits.append(p["value"])
    return sorted(set(hits))


def ocr_pdf_text_progressive(path: str, patterns) -> tuple[str, list, int]:
    """OCR com uma única chamada convert_from_path para todas as páginas."""
    kwargs = {"dpi": OCR_DPI}
    if POPPLER_PATH:
        kwargs["poppler_path"] = POPPLER_PATH

    config = f"--oem 1 --psm {OCR_PSM}"
    root_hint = find_root_for_path(path)
    last_page = max(1, OCR_MAX_PAGES)

    try:
        wait_until_root_available(root_hint)
        # Uma única chamada para todas as páginas necessárias
        images = convert_from_path(path, first_page=1, last_page=last_page, **kwargs)
    except Exception:
        return "", [], 0

    texts = []
    for i, img in enumerate(images):
        try:
            texts.append(pytesseract.image_to_string(img, lang=OCR_LANG, config=config))
        except Exception:
            texts.append("")

        # early exit: verifica hits após cada página
        partial_text = "\n".join(texts)
        hits = search_in_text(partial_text, patterns)
        if hits:
            return partial_text, hits, i + 1

    full = "\n".join(texts)
    return full, search_in_text(full, patterns), len(images)


# =========================
# LOG HELPERS
# =========================
def write_found_log(found_items, log_path: str):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(log_path, "w", encoding="utf-8") as f:
        f.write("# Scan FOUND log\n")
        f.write(f"# created_at: {ts}\n")
        f.write(f"# roots: {', '.join(ROOTS)}\n")
        f.write(f"# ids_count: {len(IDS)}\n")
        f.write(f"# dest_found_dir: {DEST_FOUND_DIR}\n")
        f.write(f"# output_dir: {OUTPUT_DIR}\n")
        f.write(f"# progress_log: {PROGRESS_LOG}\n")
        f.write(f"# total_found_files: {len(found_items)}\n\n")
        for item in found_items:
            hits_str = ", ".join(item["hits"])
            copied_to = ", ".join(item.get("copied_to", []))
            f.write(f"{item['path']} | hits: {hits_str} | method: {item['method']} | copied_to: {copied_to}\n")


def write_error_log(error_items, log_path: str):
    with open(log_path, "a", encoding="utf-8") as f:
        for item in error_items:
            f.write(item + "\n")


# =========================
# PROGRESS — com buffer
# =========================
_progress_buffer: list[str] = []
_progress_lock = threading.Lock()


def flush_progress_buffer(force: bool = False):
    global _progress_buffer
    with _progress_lock:
        if not _progress_buffer:
            return
        if not force and len(_progress_buffer) < PROGRESS_FLUSH_EVERY:
            return
        lines = _progress_buffer[:]
        _progress_buffer = []

    try:
        os.makedirs(os.path.dirname(PROGRESS_LOG), exist_ok=True)
        with open(PROGRESS_LOG, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    except Exception:
        pass


def append_progress(res: dict):
    line = json.dumps(res, ensure_ascii=False)
    with _progress_lock:
        _progress_buffer.append(line)
        should_flush = len(_progress_buffer) >= PROGRESS_FLUSH_EVERY
    if should_flush:
        flush_progress_buffer()


def load_processed_paths(progress_log: str) -> set[str]:
    processed = set()
    if not os.path.exists(progress_log):
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
            if path and status in {"hit", "none", "error"}:
                processed.add(norm_path(path))
    return processed


# =========================
# FILE SYSTEM
# =========================
def list_pdfs_multi(roots: list[str]) -> list[str]:
    pdfs = []
    for root in roots:
        wait_until_root_available(root)
        for dirpath, _, filenames in os.walk(root):
            for name in filenames:
                if name.lower().endswith(".pdf"):
                    pdfs.append(os.path.join(dirpath, name))
    seen = set()
    out = []
    for p in pdfs:
        np = norm_path(p)
        if np in seen:
            continue
        seen.add(np)
        out.append(p)
    return out


def safe_filename_part(value: str) -> str:
    value = str(value).strip()
    value = re.sub(r'[<>:"/\\|?*]+', "_", value)
    return value.strip(" ._") or "sem_id"


def copy_found_pdf_to_hit_folders(src_path: str, hits: list[str]) -> tuple[list[str], list[str]]:
    copied_paths = []
    errors = []
    try:
        os.makedirs(DEST_FOUND_DIR, exist_ok=True)
    except Exception as e:
        return [], [f"{type(e).__name__}: {e}"]

    base = os.path.splitext(os.path.basename(src_path))[0]
    ext = os.path.splitext(src_path)[1] or ".pdf"
    src_hash = hashlib.sha1(src_path.encode("utf-8", errors="ignore")).hexdigest()[:10]
    dest_name = f"{base}_{src_hash}{ext}"

    for hit in sorted(set(hits)):
        try:
            hit_folder = os.path.join(DEST_FOUND_DIR, safe_filename_part(hit))
            os.makedirs(hit_folder, exist_ok=True)
            dest_path = os.path.join(hit_folder, dest_name)
            if not os.path.exists(dest_path):
                shutil.copy2(src_path, dest_path)
            copied_paths.append(dest_path)
        except Exception as e:
            errors.append(f"{src_path} -> pasta {hit}: {type(e).__name__}: {e}")

    return copied_paths, errors


# =========================
# WORKER GLOBALS
# =========================
_PATTERNS = None
_IDS = None
_ROOTS_GLOBAL = []
_AUTOMATON = None   # Aho-Corasick


def _init_worker(ids_list, roots_list):
    global _PATTERNS, _IDS, _ROOTS_GLOBAL, _AUTOMATON
    _IDS = list(ids_list)
    _ROOTS_GLOBAL = list(roots_list)
    _PATTERNS = compile_patterns(_IDS)
    _AUTOMATON = build_automaton(_IDS)
    if TESSERACT_CMD:
        pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD


def _process_one_pdf(path: str):
    global _PATTERNS, _IDS, _ROOTS_GLOBAL, _AUTOMATON
    try:
        root_hint = find_root_for_path(path)
        wait_until_root_available(root_hint)

        # 1) Lê bytes com retry (OneDrive/rede pode falhar temporariamente)
        data = safe_read_file_bytes(path, root_hint)  # retry automático em falhas de IO

        # 2) BINÁRIO primeiro — Aho-Corasick ou loop simples (mais rápido)
        #    Só funciona se o PDF não for comprimido/encoded, mas custa quase nada
        if _AUTOMATON is not None:
            candidates = bin_fast_search_ac(data, _AUTOMATON)
        else:
            candidates = bin_fast_search_fallback(data, _IDS)

        if candidates:
            decoded = data.decode("latin-1", errors="ignore")
            hits = [
                p["value"]
                for p in _PATTERNS
                if p["value"] in candidates and p["raw"].search(decoded)
            ]
            hits = sorted(set(hits))
            if hits:
                return {"status": "hit", "path": path, "hits": hits, "method": "bin-fast-confirmed"}

        # 3) TEXTO do PDF — só entra aqui se binário não achou
        text = extract_text_tolerant_from_bytes(data)
        hits = search_in_text(text, _PATTERNS)
        if hits:
            return {"status": "hit", "path": path, "hits": hits, "method": "text"}

        # 4) FALLBACK latin-1 — só roda se o PDF não tinha texto extraível
        #    Evita normalizar/squash de arquivos grandes desnecessariamente
        if not text or len(text.strip()) < 50:
            hits = fallback_search_bytes_decoded(data, _PATTERNS)
            if hits:
                return {"status": "hit", "path": path, "hits": hits, "method": "fallback-bytes"}

        # 5) OCR — último recurso, só PDFs escaneados sem texto extraível
        if ENABLE_OCR:
            _, hits, pages_used = ocr_pdf_text_progressive(path, _PATTERNS)
            if hits:
                return {"status": "hit", "path": path, "hits": hits, "method": f"ocr-p{pages_used}"}

        return {"status": "none", "path": path, "hits": [], "method": ""}

    except (PdfReadError, OSError) as exc:
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        return {
            "status": "error", "path": path, "hits": [], "method": "",
            "error_line": f"[{ts}] {path} -> {type(exc).__name__}: {exc}",
        }
    except Exception as exc:
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        return {
            "status": "error", "path": path, "hits": [], "method": "",
            "error_line": f"[{ts}] {path} -> {type(exc).__name__}: {exc}",
        }


# =========================
# SCAN PRINCIPAL
# =========================
def run_turbo_scan(roots: list[str], ids_list: list[str]):
    all_pdfs = list_pdfs_multi(roots)
    processed_paths = load_processed_paths(PROGRESS_LOG)
    pending_pdfs = [p for p in all_pdfs if norm_path(p) not in processed_paths]

    found_items = []
    error_lines = []

    already_done  = len(processed_paths)
    scanned_now   = 0
    matches_now   = 0
    errors_now    = 0
    found_by_id   = {u: 0 for u in ids_list}

    os.makedirs(DEST_FOUND_DIR, exist_ok=True)

    executor_cls = ThreadPoolExecutor if USE_THREADS else ProcessPoolExecutor

    print(f"Total de PDFs no disco: {len(all_pdfs)}")
    print(f"Já processados: {already_done}")
    print(f"Pendentes: {len(pending_pdfs)}")
    print(f"Executor: {'Thread' if USE_THREADS else 'Process'}PoolExecutor")
    print(f"MAX_WORKERS={MAX_WORKERS}  MAX_IN_FLIGHT={MAX_IN_FLIGHT}")
    print(f"OCR={ENABLE_OCR}  Aho-Corasick={'sim' if HAS_AHOCORASICK else 'não (pip install pyahocorasick)'}")
    print(f"PROGRESS_FLUSH_EVERY={PROGRESS_FLUSH_EVERY}")

    if not pending_pdfs:
        return 0, 0, 0, found_items, found_by_id, len(all_pdfs), already_done, 0

    pending_iter = iter(pending_pdfs)
    futures_map = {}

    # Inicializa globals do worker:
    # - ProcessPool: usa initializer (cada processo filho recebe uma cópia)
    # - ThreadPool: chama direto no processo principal (threads compartilham memória)
    #   _ROOTS_GLOBAL precisa estar setado ANTES do primeiro submit — não após o with
    _init_worker(ids_list, roots)

    init_kwargs = {}
    if not USE_THREADS:
        init_kwargs = {"initializer": _init_worker, "initargs": (ids_list, roots)}

    with executor_cls(max_workers=MAX_WORKERS, **init_kwargs) as ex:

        def submit_more():
            while len(futures_map) < MAX_IN_FLIGHT:
                try:
                    path = next(pending_iter)
                except StopIteration:
                    break
                fut = ex.submit(_process_one_pdf, path)
                futures_map[fut] = path

        submit_more()

        while futures_map:
            done, _ = wait(set(futures_map.keys()), return_when=FIRST_COMPLETED)

            for fut in done:
                src_path = futures_map.pop(fut, None)
                try:
                    res = fut.result()
                except Exception as exc:
                    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    res = {
                        "status": "error", "path": src_path or "", "hits": [], "method": "",
                        "error_line": f"[{ts}] {src_path} -> {type(exc).__name__}: {exc}",
                    }

                scanned_now += 1
                append_progress(res)

                if res["status"] == "hit":
                    matches_now += 1
                    hits = sorted(set(res["hits"]))
                    copied_to, copy_errors = copy_found_pdf_to_hit_folders(res["path"], hits)
                    if copy_errors:
                        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                        for err in copy_errors:
                            error_lines.append(f"[{ts}] COPY FAIL {err}")

                    print(f"{res['path']} -> {', '.join(hits)} ({res['method']})")
                    found_items.append({"path": res["path"], "hits": hits, "method": res["method"], "copied_to": copied_to})
                    for hit in hits:
                        if hit in found_by_id:
                            found_by_id[hit] += 1

                elif res["status"] == "error":
                    errors_now += 1
                    error_lines.append(res.get("error_line", ""))

                total_done_global = already_done + scanned_now
                if PROGRESS_EVERY and total_done_global % PROGRESS_EVERY == 0:
                    flush_progress_buffer(force=True)  # salva buffer se processo morrer
                    print(f"Progresso: {total_done_global}/{len(all_pdfs)} PDFs...")
            submit_more()

    # Flush final do buffer de progresso
    flush_progress_buffer(force=True)

    if found_items:
        write_found_log(found_items, FOUND_LOG)
    if error_lines:
        write_error_log(error_lines, ERROR_LOG)

    return (
        scanned_now, matches_now, errors_now,
        found_items, found_by_id,
        len(all_pdfs), already_done, len(pending_pdfs),
    )


# =========================
# MAIN
# =========================
if __name__ == "__main__":
    mp.freeze_support()

    try:
        os.makedirs(OUTPUT_DIR, exist_ok=True)

        print("=== Turbo scan v2 iniciado ===")
        print(f"ROOTS: {ROOTS}")
        for r in ROOTS:
            print(f"  - {r} | existe? {os.path.exists(r)}")
        print(f"OUTPUT_DIR: {OUTPUT_DIR}")
        print(f"MAX_WORKERS={MAX_WORKERS}  USE_THREADS={USE_THREADS}")
        print(f"OCR={ENABLE_OCR} DPI={OCR_DPI} MAX_PAGES={OCR_MAX_PAGES}")
        print(f"Aho-Corasick: {'disponível' if HAS_AHOCORASICK else 'INDISPONÍVEL — pip install pyahocorasick'}")
        print(f"PROGRESS_LOG: {PROGRESS_LOG}")
        print(f"DEST_FOUND_DIR: {DEST_FOUND_DIR}")
        print()
        print("Ordem de busca por PDF: binário → texto PDF → fallback latin-1 → OCR")
        print()
        if not USE_THREADS:
            print("Dica OneDrive/rede: $env:USE_THREADS='1'; $env:MAX_WORKERS='24'; $env:ENABLE_OCR='0'")
        else:
            print("Dica SSD local:    $env:USE_THREADS='0'; $env:MAX_WORKERS='11'; $env:ENABLE_OCR='0'")

        (
            scanned_now, total_hits_now, errors_now,
            found_items, found_by_id,
            total_pdfs, already_done, pending_count,
        ) = run_turbo_scan(ROOTS, IDS)

        print(f"\nTotal PDFs no disco:       {total_pdfs}")
        print(f"Já processados antes:       {already_done}")
        print(f"Processados agora:          {scanned_now}")
        print(f"Pendentes no início:        {pending_count}")
        print(f"Com correspondência:        {total_hits_now}")
        print(f"Com erro:                   {errors_now}")
        print(f"Total concluído:            {already_done + scanned_now}/{total_pdfs}")

        if found_items:
            print("\n===== FATURAS ENCONTRADAS =====")
            for item in sorted(found_items, key=lambda x: x["path"].lower()):
                print(
                    f"{item['path']} -> {', '.join(item['hits'])} ({item['method']}) | "
                    f"cópias: {', '.join(item.get('copied_to', []))}"
                )
            print(f"\nLog: {FOUND_LOG}")

    except KeyboardInterrupt:
        flush_progress_buffer(force=True)
        print("\nInterrompido pelo usuário.")
