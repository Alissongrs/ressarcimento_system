"""Carregador genérico de mapas de extração por distribuidora.

Lê `map/{dist}_extraction_map.json` e aplica regex em campos não-extraídos do v2.

Sintaxe suportada do mapa:
  - `regex` + `group` (int|str|list) — match simples
  - `chain` — lista de regex, tenta cada até dar match
  - `group="1+2+3"` — concatena grupos com espaço
  - `flags="MULTILINE"` etc.
  - `anchor`, `obs`, `_obs`, `_status`, `especificidade` — ignorados (informativo)

Não-destrutivo: só preenche campos que estão None/vazios no v2.
"""
import os, json, re
from functools import lru_cache


MAPA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "map")


@lru_cache(maxsize=32)
def carregar_mapa(mapa_nome: str) -> dict:
    """Lê e cacheia o map JSON por distribuidora. Tenta nomes:
      1. {mapa}_extraction_map.json
      2. {mapa}_FAMILY_REGISTRY.json (registry de família — pode ter mesmas regras)
      3. Aliases conhecidos (enel_rio/enel_ce → enel_distribuicao_modern_FAMILY_REGISTRY)
    Retorna {} se não existir.
    """
    if not mapa_nome: return {}
    # Aliases conhecidos: mapeiam mapa → arquivo
    aliases = {
        "enel_rio": "enel_distribuicao_modern_FAMILY_REGISTRY",
        "enel_ce": "enel_distribuicao_modern_FAMILY_REGISTRY",
        "enel_rj_ampla": "enel_distribuicao_modern_FAMILY_REGISTRY",
        "ampla": "enel_distribuicao_modern_FAMILY_REGISTRY",
        # COPEL usa Celesc como base (estrutura DANF3E similar)
        "copel": "celesc_extraction_map",
    }
    candidatos = [
        f"{mapa_nome}_extraction_map.json",
        f"{mapa_nome}_FAMILY_REGISTRY.json",
    ]
    if mapa_nome in aliases:
        candidatos.insert(0, f"{aliases[mapa_nome]}.json")

    for nome_arq in candidatos:
        path = os.path.join(MAPA_DIR, nome_arq)
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                continue
    return {}


def _aplicar_regex(texto: str, regex_obj: dict) -> str | None:
    """Aplica um regex_obj (dict com 'regex', 'group', 'flags') no texto."""
    if not isinstance(regex_obj, dict): return None
    rx = regex_obj.get("regex")
    if not rx: return None
    flags = 0
    flags_str = (regex_obj.get("flags") or "").upper()
    if "MULTILINE" in flags_str or "M" in flags_str.split("|"): flags |= re.MULTILINE
    if "IGNORECASE" in flags_str or "I" in flags_str.split("|"): flags |= re.IGNORECASE
    if "DOTALL" in flags_str or "S" in flags_str.split("|"): flags |= re.DOTALL
    try:
        m = re.search(rx, texto, flags)
    except re.error:
        return None
    if not m:
        return None
    g = regex_obj.get("group", 1)
    # group="1+2+3" → concatena grupos
    if isinstance(g, str) and "+" in g:
        partes = []
        for n in g.split("+"):
            try:
                v = m.group(int(n.strip()))
                if v: partes.append(v.strip())
            except (IndexError, ValueError):
                pass
        return " ".join(partes) if partes else None
    elif isinstance(g, int):
        try: return m.group(g)
        except IndexError: return None
    elif isinstance(g, str):
        try: return m.group(g)
        except (IndexError, KeyError): return None
    return m.group(1) if m.groups() else m.group(0)


def _resolver_campo(texto: str, campo_def) -> str | None:
    """Resolve definição de campo (pode ser regex simples ou chain)."""
    if not isinstance(campo_def, dict): return None
    # Chain: lista de regex_obj, tenta na ordem
    chain = campo_def.get("chain")
    if chain and isinstance(chain, list):
        for regex_obj in chain:
            v = _aplicar_regex(texto, regex_obj)
            if v: return v.strip()
        return None
    # Regex único
    return (_aplicar_regex(texto, campo_def) or "").strip() or None


# Mapeamento campo do map → caminho no v2 (estrutura achatada)
# Cada chave do mapa "dist.razao_social" mapeia pra "distribuidora.razao_social" no v2
_PATH_MAP = {
    # secao_no_mapa: prefixo_no_v2
    "distribuidora": "distribuidora",
    "cliente": "cliente",
    "identificadores_instalacao": "identificadores_instalacao",
    "nota_fiscal": "nota_fiscal",
    "vencimento_valor": "vencimento_valor",
    "periodo_leitura": "periodo_leitura",
    "medicao_consumo": "medicao",
    "classificacao": "classificacao",
    "ligacao_tecnica": "ligacao_tecnica",
    "indicadores": "indicadores_qualidade",
    "geracao_distribuida": "geracao_distribuida",
    "tributos": "tributos_por_dist",
}


def aplicar_mapa(v2: dict, texto: str, mapa_nome: str) -> dict:
    """Aplica o map da distribuidora em v2 (não-destrutivo).

    Retorna stats: {campos_preenchidos, campos_tentados, secoes_processadas}.
    """
    mapa = carregar_mapa(mapa_nome)
    if not mapa:
        return {"_erro": f"mapa não encontrado para {mapa_nome}"}

    stats = {"campos_preenchidos": [], "campos_tentados": 0, "secoes": 0}

    for secao_mapa, prefixo_v2 in _PATH_MAP.items():
        secao = mapa.get(secao_mapa)
        if not isinstance(secao, dict): continue
        stats["secoes"] += 1
        sub = v2.setdefault(prefixo_v2, {})
        for campo, campo_def in secao.items():
            if campo.startswith("_"): continue  # _obs, _status, etc.
            stats["campos_tentados"] += 1
            # Só preenche se campo está vazio no v2
            if sub.get(campo): continue
            valor = _resolver_campo(texto, campo_def)
            if valor:
                sub[campo] = valor
                stats["campos_preenchidos"].append(f"{prefixo_v2}.{campo}")

    return stats


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("Uso: aplicar_mapa_distribuidora.py <mapa_nome> <pdf_path>")
        sys.exit(1)
    import pdfplumber
    mapa_nome = sys.argv[1]
    pdf_path = sys.argv[2]
    with pdfplumber.open(pdf_path) as pdf:
        texto = "\n".join(p.extract_text() or "" for p in pdf.pages)
    v2 = {}
    stats = aplicar_mapa(v2, texto, mapa_nome)
    print(f"Stats: {stats['campos_preenchidos']}")
    print(f"Total: {len(stats['campos_preenchidos'])}/{stats['campos_tentados']}")
    print(f"\nv2: {json.dumps(v2, ensure_ascii=False, indent=2, default=str)[:2000]}")
