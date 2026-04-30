#!/usr/bin/env python3
"""
rodar_empresa.py
─────────────────────────────────────────────────────────────────────────────
Orquestrador: executa pdf_pipeline.py e depois pipeline.py para uma ou mais
empresas em sequência.

Fluxo:
  1) pdf_pipeline.py --empresa <X> [opções de extração]
  2) pipeline.py     --empresa <X> [opções de IA]

Uso:
  python rodar_empresa.py --empresa 14
  python rodar_empresa.py --empresa 4 14 32
  python rodar_empresa.py --empresa 14 --limite 50 --top 50
  python rodar_empresa.py --empresa 14 --force
  python rodar_empresa.py --empresa 14 --ASC
  python rodar_empresa.py --empresa 14 --flex
  python rodar_empresa.py --empresa 14 --so-pdf      # apenas extração, sem IA
  python rodar_empresa.py --empresa 14 --so-ia       # apenas IA (pula extração)
  python rodar_empresa.py --empresa 14 --com-triagem # ativa Passo 1 no pipeline
  python rodar_empresa.py --id 274                   # fatura específica (ambos os passos)
  python rodar_empresa.py --id 274 --so-ia           # fatura específica, só IA
"""

import argparse
import subprocess
import sys
from pathlib import Path

_DIR = Path(__file__).resolve().parent


def _run(cmd: list[str], label: str) -> int:
    print(f"\n{'='*72}")
    print(f"  {label}")
    print(f"  $ {' '.join(cmd)}")
    print(f"{'='*72}\n")
    result = subprocess.run(cmd, cwd=_DIR)
    return result.returncode


def main():
    p = argparse.ArgumentParser(
        description="Orquestrador pdf_pipeline + pipeline para uma ou mais empresas."
    )

    # Seleção de alvo
    target = p.add_mutually_exclusive_group(required=True)
    target.add_argument("--empresa", type=int, nargs="+", metavar="COD",
                        help="Código(s) de empresa a processar")
    target.add_argument("--id", type=int, nargs="+", metavar="ID",
                        help="ID(s) específico(s) de fatura (passa --id para ambos os scripts)")

    # Controle de etapas
    p.add_argument("--so-pdf", action="store_true",
                   help="Executa apenas pdf_pipeline.py (sem IA)")
    p.add_argument("--so-ia", action="store_true",
                   help="Executa apenas pipeline.py (sem extração PDF)")

    # Flags repassadas ao pdf_pipeline.py
    p.add_argument("--limite", type=int, default=None,
                   help="--limite para pdf_pipeline.py")
    p.add_argument("--extrator", choices=["plumber", "markdown", "ocr"], default=None,
                   help="--extrator para pdf_pipeline.py")
    p.add_argument("--ASC", action="store_true",
                   help="--ASC para pdf_pipeline.py (processa mais antigos primeiro)")

    # Flags repassadas ao pipeline.py
    p.add_argument("--top", type=int, default=None,
                   help="--top para pipeline.py")
    p.add_argument("--flex", action="store_true",
                   help="--flex para pipeline.py (service_tier=flex)")
    p.add_argument("--com-triagem", action="store_true",
                   help="--com-triagem para pipeline.py (ativa Passo 1)")
    p.add_argument("--modelo", type=str, default=None,
                   help="--modelo para pipeline.py")

    # Flags comuns
    p.add_argument("--force", action="store_true",
                   help="--force para ambos os scripts (reprocessa faturas já processadas)")
    p.add_argument("--dry-run", action="store_true",
                   help="--dry-run para ambos os scripts (simulação sem gravação)")

    args = p.parse_args()

    if args.so_pdf and args.so_ia:
        p.error("--so-pdf e --so-ia não podem ser usados juntos.")

    python = sys.executable
    erros = []

    def build_pdf_args() -> list[str]:
        cmd = [python, str(_DIR / "pdf_pipeline.py")]
        if args.empresa:
            cmd += ["--empresa"] + [str(e) for e in args.empresa]
        elif args.id:
            cmd += ["--id"] + [str(i) for i in args.id]
        if args.limite:
            cmd += ["--limite", str(args.limite)]
        if args.extrator:
            cmd += ["--extrator", args.extrator]
        if args.ASC:
            cmd += ["--ASC"]
        if args.force:
            cmd += ["--force"]
        if args.dry_run:
            cmd += ["--dryrun"]
        return cmd

    def build_ia_args() -> list[str]:
        cmd = [python, str(_DIR / "pipeline.py")]
        if args.empresa:
            cmd += ["--empresa"] + [str(e) for e in args.empresa]
        elif args.id:
            cmd += ["--id"] + [str(i) for i in args.id]
        if args.top:
            cmd += ["--top", str(args.top)]
        if args.flex:
            cmd += ["--flex"]
        if args.com_triagem:
            cmd += ["--com-triagem"]
        if args.modelo:
            cmd += ["--modelo", args.modelo]
        if args.force:
            cmd += ["--force"]
        if args.dry_run:
            cmd += ["--dry-run"]
        return cmd

    # ── Etapa 1: PDF ─────────────────────────────────────────────────────────
    if not args.so_ia:
        rc = _run(build_pdf_args(), "ETAPA 1 — Extração PDF (pdf_pipeline.py)")
        if rc != 0:
            print(f"\n[ERRO] pdf_pipeline.py terminou com código {rc}.")
            erros.append(f"pdf_pipeline returncode={rc}")
            if not args.so_pdf:
                print("[AVISO] Continuando para a etapa de IA mesmo com erro na extração.\n")

    # ── Etapa 2: IA ──────────────────────────────────────────────────────────
    if not args.so_pdf:
        rc = _run(build_ia_args(), "ETAPA 2 — Análise IA (pipeline.py)")
        if rc != 0:
            print(f"\n[ERRO] pipeline.py terminou com código {rc}.")
            erros.append(f"pipeline returncode={rc}")

    # ── Resumo ────────────────────────────────────────────────────────────────
    print(f"\n{'='*72}")
    if erros:
        print(f"  Concluído COM ERROS: {'; '.join(erros)}")
        sys.exit(1)
    else:
        print("  Concluído com sucesso.")
    print(f"{'='*72}\n")


if __name__ == "__main__":
    main()
