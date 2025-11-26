OCR Service Dependencies

System packages (Debian/Ubuntu)
- tesseract-ocr
- tesseract-ocr-por
- tesseract-ocr-eng
- poppler-utils
- ghostscript
- libjpeg62-turbo
- zlib1g

Python packages (see requirements.txt)
- fastapi==0.115.0
- uvicorn==0.32.0
- pillow==11.0.0
- pytesseract==0.3.13
- pdf2image==1.17.0
- python-multipart==0.0.12

Notes
- pdf2image requires poppler-utils installed in the OS for PDF → image conversion.
- Tesseract language packs ‘por’ and ‘eng’ are installed to improve OCR for Portuguese/English.
- If you run outside Docker, install these OS packages via apt (or the equivalents for your distro).

