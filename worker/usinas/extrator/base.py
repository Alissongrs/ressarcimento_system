"""Funções comuns do extrator determinístico (texto embutido do PDF + posição das palavras).

Nada aqui lê imagem nem usa OCR: só o texto que o próprio PDF carrega (fitz). Cada layout
(light.py, copel.py, ...) usa estas peças para montar o JSON v2 da ESPECIFICACAO_JSON.md.
"""
import re
import unicodedata

import fitz

MESES = {'JAN': 1, 'FEV': 2, 'MAR': 3, 'ABR': 4, 'MAI': 5, 'JUN': 6,
         'JUL': 7, 'AGO': 8, 'SET': 9, 'OUT': 10, 'NOV': 11, 'DEZ': 12}


def sem_acento(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s or '') if unicodedata.category(c) != 'Mn')


class Palavra:
    __slots__ = ('x0', 'y0', 'x1', 'y1', 't')

    def __init__(self, x0, y0, x1, y1, t):
        self.x0, self.y0, self.x1, self.y1, self.t = x0, y0, x1, y1, t

    def __repr__(self):
        return f'{self.t}@{self.x0:.0f}-{self.x1:.0f},{self.y1:.0f}'


class Linha:
    """Palavras com a mesma base (y1) dentro de uma tolerância, em ordem de x."""

    def __init__(self, palavras):
        self.p = sorted(palavras, key=lambda w: w.x0)
        self.y = sum(w.y1 for w in self.p) / len(self.p)

    def texto(self, x_min=-1, x_max=1e9):
        return ' '.join(w.t for w in self.p if x_min <= w.x0 < x_max)

    def entre(self, x_min, x_max):
        return [w for w in self.p if x_min <= w.x0 < x_max]

    def __repr__(self):
        return f'{self.y:.0f}: {self.texto()}'


def palavras(pagina):
    return [Palavra(x0, y0, x1, y1, t) for x0, y0, x1, y1, t, *_ in pagina.get_text('words')]


def linhas(ws, tol=2.6):
    """Agrupa palavras em linhas pela base; tol ~ meia altura de letra."""
    out = []
    for w in sorted(ws, key=lambda w: w.y1):
        if out and abs(out[-1][-1].y1 - w.y1) <= tol:
            out[-1].append(w)
        else:
            out.append([w])
    return [Linha(g) for g in out]


def abrir(caminho):
    return fitz.open(caminho)


# ── números ──────────────────────────────────────────────────────────────────
RE_NUM = re.compile(r'^-?[\d.]+(,\d+)?%?-?$|^-?\d+\.\d+$')


def e_numero(t):
    return bool(RE_NUM.match(t.strip())) and any(c.isdigit() for c in t)


def num(t, ponto_decimal=False):
    """'1.234,56' → 1234.56 ; '-491,71' → -491.71 ; '6.620' → 6620 ; '0,75%' → 0.75.
    ponto_decimal=True: '1.22082' (tarifa sem vírgula) → 1.22082. Sufixo '-' = negativo."""
    if t is None:
        return None
    s = t.strip().replace('R$', '').replace('%', '').strip()
    neg = s.startswith('-') or s.endswith('-')
    s = s.strip('-').strip('*')
    if not s or not any(c.isdigit() for c in s):
        return None
    if ',' in s:
        s = s.replace('.', '').replace(',', '.')
    elif '.' in s and (ponto_decimal or re.fullmatch(r'\d+\.(\d{1,2}|\d{4,})', s)):
        pass  # ponto decimal: '109108.12', '24570.00' ('6.620' com 3 dígitos é milhar)
    elif re.fullmatch(r'\d{1,3}(\.\d{3})+\.(\d{1,2}|\d{4,})', s):
        g = s.split('.')  # milhar e decimal com ponto: '1.136.43' → 1136.43, '1.102.6800' → 1102.68
        s = ''.join(g[:-1]) + '.' + g[-1]
    else:
        s = s.replace('.', '')
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def data_br(t):
    """'14/07/2025' → '2025-07-14'."""
    m = re.match(r'(\d{2})/(\d{2})/(\d{4})', t or '')
    return f'{m[3]}-{m[2]}-{m[1]}' if m else None


def mes_ano(t):
    """'JUN/2025' ou 'JUN/25' → '2025-06'."""
    m = re.match(r'([A-Z]{3})/(\d{2,4})', sem_acento(t or '').upper())
    if not m or m[1] not in MESES:
        return None
    a = int(m[2]) + (2000 if len(m[2]) == 2 else 0)
    return f'{a:04d}-{MESES[m[1]]:02d}'


def colunas_por_ancora(ws, ancoras):
    """Distribui palavras numéricas entre colunas: cada uma vai para a âncora (borda direita do
    cabeçalho) mais próxima da sua borda direita. ancoras = {nome: x1}. Retorna {nome: texto}."""
    out = {}
    for w in ws:
        nome = min(ancoras, key=lambda k: abs(ancoras[k] - w.x1))
        out[nome] = (out[nome] + ' ' + w.t) if nome in out else w.t
    return out


def esqueleto(fid, caminho, paginas):
    """JSON v2 vazio, com todas as seções da especificação."""
    return {
        'id_fatura': fid,
        'arquivo': {'caminho': caminho, 'paginas': paginas},
        'documento': {'tipo': 'fatura_energia', 'distribuidora': None, 'distribuidora_sigla': None,
                      'distribuidora_cnpj': None, 'distribuidora_ie': None, 'distribuidora_endereco': None,
                      'nota_fiscal': {'numero': None, 'serie': None, 'modelo': None, 'data_emissao': None,
                                      'data_apresentacao': None, 'chave_acesso': None,
                                      'protocolo_autorizacao': None, 'data_autorizacao': None,
                                      'reservado_fisco': None, 'periodo_fiscal': None}},
        'titular': {'nome': None, 'cnpj_cpf': None, 'inscricao_estadual': None, 'endereco': None, 'cep': None,
                    'cidade': None, 'uf': None, 'codigo_cliente': None, 'conta_contrato': None,
                    'parceiro_negocio': None},
        'unidade_consumidora': {'uc': None, 'instalacao': None, 'medidor': [], 'endereco': None,
                                'roteiro_leitura': None, 'lote': None, 'classificacao': None, 'grupo': None,
                                'subgrupo': None, 'modalidade_tarifaria': None, 'classe': None, 'subclasse': None,
                                'tipo_fornecimento': None, 'tensao_nominal': None, 'tensao_contratada_v': None,
                                'geracao': {'e_gerador': None, 'tipo_usina': None, 'modalidade_gd': None,
                                            'potencia_instalada_kw': None, 'numero_cadastro_gd': None}},
        'referencia': {'mes_referencia': None, 'data_vencimento': None, 'leitura_anterior': None,
                       'leitura_atual': None, 'dias_faturados': None, 'proxima_leitura': None, 'data_emissao': None},
        'totais': {'total_a_pagar': None, 'total_distribuidora': None, 'subtotal': None, 'total_consolidado': None,
                   'total_tributos': None, 'valor_cosip_cip': None, 'multa_juros_anteriores': None,
                   'debitos_anteriores': None, 'creditos_aplicados': None},
        'itens': [], 'tributos': [], 'medicoes': [], 'demanda': [],
        'gd': {'energia_injetada': [], 'energia_compensada': [], 'saldo_creditos': [], 'creditos_a_expirar': [],
               'excedente': [], 'rateio_beneficiarias': [], 'outros': []},
        'historico': [], 'historico_formato': None, 'tarifas': [], 'bandeiras': [], 'qualidade_servico': [],
        'tabelas_complementares': [], 'valores_alternativos': [],
        'pagamento': {'linha_digitavel': None, 'codigo_barras': None, 'pix': None, 'debito_automatico': None,
                      'banco': None, 'agencia': None, 'numero_fatura': None},
        'mensagens': [], 'outros': [],
        'extracao': {'metodo': 'robo', 'versao_formato': 2, 'parser': None, 'paginas_lidas': [], 'ilegiveis': [],
                     'observacoes': [], 'divergencias_impressas': []},
    }


def posto_de(desc):
    """Posto tarifário pelo texto da descrição (HP/HFP, Ponta/Fora Ponta, Único...)."""
    d = ' ' + sem_acento(desc).upper().replace('/', ' ') + ' '
    if re.search(r' (HFP|FP|FORA PONTA|F PONTA) ', d):
        return 'FORA_PONTA'
    if re.search(r' (HP|PONTA|PT) ', d):
        return 'PONTA'
    if re.search(r' (INTERMEDIARI[OA]|HI) ', d):
        return 'INTERMEDIARIO'
    if re.search(r' (UNICO|UNICA) ', d):
        return 'UNICO'
    if 'CAPACITIV' in d:
        return 'CAPACITIVO'
    if 'INDUTIV' in d:
        return 'INDUTIVO'
    return None
