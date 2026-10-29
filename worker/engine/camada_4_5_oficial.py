"""Camada 4.5 OFICIAL — refina campos divergentes via crop bbox + gpt-5.4 vision flex.

Pipeline cravado pos benchmark 100 ENEL SP cofins_valor (acuracia 98.99% real):

  1. pdfplumber acha bbox da palavra-anchor textual (ex: 'COFINS') na pagina PDF
  2. PyMuPDF renderiza pagina em PNG (scale 2.0)
  3. Recorta faixa horizontal full-width ao redor do anchor (40px acima, 120px abaixo)
  4. gpt-5.4 + vision + flex processa o crop 2x (self-consistency)
  5. Se as 2 calls concordam (|diff| < 0.01) -> aceita o valor
  6. Se discordam -> 3a chamada gpt-5.4 + vision + flex como tiebreaker

Custo: ~$0.04/fatura. Estimativa 25k faturas: ~$1.000.

Setup vencedor do benchmark:
PARA CAMPOS INDIVIDUAIS (--campo cofins_valor, --campo pis_valor, ...):
  - Modelo: gpt-5.4 (macro) + service_tier=flex + N=2 self-consistency + tiebreaker
  - Custo: ~$0.04/fatura
  - Acuracia: 98.99% real em 16 distribuidoras

PARA EXTRACAO DE ITENS (--extrair-itens):
  - Variante D (vencedora): gpt-5.4-nano + N=2 self-consistency + fallback gpt-5.4
  - Nano resolve ~70% (custo ~$0.002), fallback macro em ~30% (custo ~$0.022)
  - Custo medio: ~$0.005-0.010/fatura

Por que macro 2x p/ campos: modelos menores (4.1-mini, 5.4-mini) confundem coluna
"PIS/COFINS por item" das linhas de TUSD/TE com a tabela TRIBUTOS consolidada.
Por que nano 2x p/ itens: tarefa de listar e classificar tabela inteira tolera
modelo mais simples — quando nano fica em duvida, macro entra como tiebreaker.

Crop bbox via PyMuPDF (mais robusto que pdfplumber p/ chars coalescidos).
Sanity check ternario (bate / complexa / diverge).

Uso:
  python camada_4_5_oficial.py --campo cofins_valor --ids 1919 2561 ...
  python camada_4_5_oficial.py --extrair-itens --ids 31586 --apply
"""
import argparse
import base64
import io
import json
import os
import re
import sys
import time
from pathlib import Path

import mysql.connector
import requests
import fitz
from PIL import Image

from completar_vision_5_4 import DB
from llm_fallback import _BASE_URL, _OPENAI_KEY
from camada_3_extracao import baixar_pdf_cached


# === CONFIG CRAVADA (benchmark 100 ENEL SP, 98.99% acuracia real) ===
MODELO = "gpt-5.4"            # macro
SERVICE_TIER = "flex"          # 50% off, gpt-5.x e o-series
N_CALLS_PRIMARIO = 2           # self-consistency
DIFF_TOLERANCIA = 0.01         # centavos
MAX_TOKENS = 300

# Anchor textual por campo — palavras-chave no PDF pra localizar a regiao de extracao
ANCHORS_POR_CAMPO = {
    # TRIBUTOS
    "cofins_valor":          ["COFINS"],
    "pis_valor":             ["PIS"],
    "icms_valor":            ["ICMS"],
    "icms_base_calculo":     ["ICMS"],
    "icms_aliquota":         ["ICMS"],
    "pis_aliquota":          ["PIS"],
    "cofins_aliquota":       ["COFINS"],
    # LEITURAS
    "leit_ant_ativa_ponta":  ["MEDI", "Leitura", "LEITURA"],
    "leit_atu_ativa_ponta":  ["MEDI", "Leitura", "LEITURA"],
    "leit_ant_ativa_fponta": ["MEDI", "Leitura", "LEITURA"],
    "leit_atu_ativa_fponta": ["MEDI", "Leitura", "LEITURA"],
    # DATAS
    "data_leitura_anterior": ["MEDI", "Leitura", "Per", "PERIODO"],
    "data_leitura_atual":    ["MEDI", "Leitura", "Per", "PERIODO"],
    "dias_faturados":        ["Dias", "Per", "PERIODO"],
    # NUMERICOS / IDENTIFICADORES
    "numero_fatura":         ["Nota", "FATURA", "FISCAL", "N°"],
    "numero_medidor":        ["Medidor", "MEDIDOR"],
    "constante_k":           ["Const", "CONST", "Fator"],
    "valor_total_fatura":    ["Total", "TOTAL"],
    # CONSUMO
    "consumo_ativo_ponta_kwh":  ["Consumo", "CONSUMO", "PONTA"],
    "consumo_ativo_fponta_kwh": ["Consumo", "CONSUMO", "Fora"],
    # DEMANDA
    "demanda_contratada_ponta_kw":  ["Demanda", "DEMANDA"],
    "demanda_contratada_fponta_kw": ["Demanda", "DEMANDA"],
    # CLASSIFICACAO
    "grupo_tarifario":       ["Grupo", "GRUPO", "CLASSIFICA"],
    "subgrupo_tarifario":    ["Subgrupo", "SUBGRUPO", "A1", "A2", "A3", "A4", "B1", "B2", "B3"],
    "modalidade_tarifaria":  ["Modalidade", "MODALIDADE", "Tarif"],
    "classe_consumidor":     ["Classe", "CLASSE"],
    "tensao_fornecimento":   ["Tens", "TENS"],
}

# Anchor pra extracao da TABELA INTEIRA de itens (1:N -> FATURA_ITENS_COBRADOS)
# Palavras-cabeçalho que aparecem APENAS na tabela de itens (Quant., Unid., Tarifa unit, etc).
# PyMuPDF tokeniza por palavra — usar tokens unicos do cabecalho da tabela.
ANCHOR_ITENS = ["Quant.", "Quant", "Unid.", "Unid", "Itens"]

PROMPT_ITENS_COBRADOS = """Voce ve UMA fatura BRASILEIRA de energia eletrica.

Extraia DOIS blocos de informacao em UM SO JSON:
(A) ITENS — lista de cada linha da tabela de itens cobrados
(B) METADADOS — indicadores, encargos detalhados, dados tecnicos, GD, observacoes

==== FORMATO NUMERICO BR ====
"1.234,56" = 1234.56 reais   "13.556,70" = 13556.70 (NUNCA 13.5567)

==== (A) ITENS COBRADOS ====
Extraia CADA LINHA da tabela de itens como um objeto.

==== CATEGORIZACAO — REGRAS FIXAS (use EXATAMENTE) ====

TUSD: "TUSD em kWh/kW", "USO SIST. DISTR.", "Consumo Ativo TUSD", "Uso Sistema Fio"
TE: "Energia ACL", "ENERGIA (TE)", "Tarifa de Energia", "Cons.TE", "TE - Ponta"
DEMANDA: "Demanda Contratada/Faturada/Ultrapassagem", "DEMANDA"
BANDEIRA: "Adic. Bandeira" / "ADICIONAL BANDEIRA" (vermelha/amarela/verde)
ENCARGO: "CDE", "CCC", "ESS", "PROINFA", "Encargo Setorial"
TRIBUTO: "ICMS", "PIS/PASEP", "COFINS", "CIP MUNICIPAL", "COSIP" ← COSIP/CIP SEMPRE TRIBUTO
COMPENSACAO_GD: "Energia Compensada GD", "Energia Injetada", "Saldo GD"
APCEI: "APCEI", "Homolog.CCEE", "DEBITO/CREDITO * APCEI"
PARCELAMENTO: "Parc.Art.113", "PC.X/Y", "PARC.ART.323", parcelamento de fatura anterior
RECLAMACAO: "Devolucao", "Reclamacao", "Bonus por Reducao", "Valor a Creditar Proxima Fatura"
CREDITO: valores negativos isolados, descontos
DEBITO: Multa, Juros, Mora (NAO eh parcelamento)
OUTRO: TX.ENTR.FAT., "Cosip-S.B.Campo Municipal" sem "MUNICIPAL"

==== REGRAS RIGIDAS (NAO QUEBRAR) ====
1. NAO inclua "Fator de Carga", "Fator de Potencia", "Demanda Reativa Indutiva/Capacitiva" — sao METRICAS, nao itens cobrados.
2. NAO inclua linhas SEM valor R$ (valor=null) — pula.
3. NAO duplique: se ja extraiu uma linha, NAO repita a mesma descricao+valor.
4. Cada item REAL aparece UMA UNICA VEZ (mesmo que apareca em multiplas colunas da fatura).
5. Inclua os tributos da TABELA TRIBUTOS isolada (PIS/COFINS/ICMS valores consolidados), NAO as colunas PIS/COFINS por linha de item.
6. Se houver subtotal "TOTAL: R$X,XX" no rodape da tabela, IGNORE (eh totalizador).

==== FIX 1: TRIBUTOS OBRIGATORIOS ====
Toda fatura brasileira tem PIS, COFINS, ICMS na TABELA TRIBUTOS (geralmente
no canto direito da fatura, com colunas |Base|Aliquota|Valor|).
- SEMPRE inclua PIS/PASEP, COFINS, ICMS quando a tabela tributos existir,
  mesmo que sejam valores pequenos (~R$1-50).
- SEMPRE inclua COSIP/CIP municipal se houver (eh tributo de iluminacao publica).
- Se nao encontrar PIS ou COFINS na fatura, eh sinal de extracao incompleta —
  procure novamente.

==== FIX 2: DEMANDA LEI ESTADUAL / ITENS COM VALOR 0,00 ====
Itens da fatura podem ter valor R$0,00 por varios motivos:
- DESCONTO/AJUSTE: valor=0 significa que nao foi aplicado → IGNORE.
- DEMANDA LEI ESTADUAL 16.886/18 (SP): aparece com "0,0" na coluna VALOR R$
  mas reflete uma demanda excedente sobre a contratada. Se a fatura tem essa
  linha, INCLUA com tipo=DEMANDA e valor=0 (preservar pra auditoria), mas
  ATENCAO: tem layouts onde a coluna VALOR exibe 0,0 mas existe outro valor
  na coluna ICMS ou TARIFA UNIT que reflete a cobranca real — examine
  TODA a linha antes de decidir o valor.
- DEMANDA / CONSUMO / TUSD / TE com valor=0: provavelmente fatura zero
  (sem consumo). Inclua com valor=0.

==== EXEMPLO DE FATURA GRUPO A ENEL SP ====
Linha tipica: "CONSUMO ATIVO PONTA TE  843,318 KWH  0,43912  370,32"
Quant=843.318, Tarifa=0.43912, Valor=370.32. tipo=TE, posto=PONTA, unidade=kWh.

Linha de demanda: "DEMANDA  22,932 KW  11,09090  254,34"
Quant=22.932, Tarifa=11.09090, Valor=254.34. tipo=DEMANDA, unidade=kW.

Tabela tributos: "PIS  4.551,07  0,89  40,93"
Base=4551.07, Aliquota=0.89, Valor=40.93. tipo=TRIBUTO (descricao=PIS/PASEP).

POSTO: "PONTA" / "F.PONTA" / "UNICO"

==== (B) METADADOS DA FATURA ====
Procure no texto da fatura inteira (cabecalho, itens, observacoes, rodape):

INDICADORES (boolean true/false/null):
- mercado_livre: TRUE se fatura menciona "ACL", "Mercado Livre", "Cliente Livre", "Consumidor Livre"
- geracao_distribuida: TRUE se ha "Energia Compensada GD", "GD I/II", "Saldo de Geracao", energia injetada
- leitura_real: TRUE se ha "Leitura Real" / "LEITURA REAL"
- leitura_estimativa: TRUE se ha "Estimada" / "Faturado pela media"
- tarifa_social: TRUE se ha "Tarifa Social" / "Baixa Renda" / "Subclasse 4"
- cliente_rural: TRUE se classe = RURAL
- beneficio_fiscal: TRUE se ha "ICMS Isento" / "Isencao" / "Beneficio Fiscal"
- troca_medidor: TRUE se menciona "troca de medidor", "substituicao"
- impedimento_leitura: TRUE se menciona "impedimento", "sem acesso", "acesso negado"

ENCARGOS DETALHADOS (R$ ou null):
- cde: valor do encargo CDE (Conta de Desenvolvimento Energetico)
- proinfa: valor PROINFA
- ess: valor ESS (Encargos de Servicos do Sistema)
- eer: valor EER (Encargo de Energia de Reserva)
- ccc: valor CCC (Conta de Consumo de Combustiveis)

TECNICOS (string/numero ou null):
- tipo_medicao: "DIRETA" / "INDIRETA" / "SEMI-INDIRETA" (Grupo A geralmente INDIRETA)
- rtp: relacao de transformacao de potencial (ex: "240/0.4", "13800/220") ou null
- fator_carga: fator de carga decimal (0.0-1.0) se constar na fatura
- fator_potencia: fator de potencia decimal (0.0-1.0) se constar na fatura

GD — GERACAO DISTRIBUIDA (kWh ou null):
- energia_injetada_kwh: kWh injetados na rede
- energia_compensada_kwh: kWh compensados (descontados da conta)
- saldo_credito_energia: saldo de creditos em kWh (proximo ciclo)

TEXTO LIVRE:
- observacoes: bloco "Observacoes" / "Mensagens" / notas livres (ate 500 chars)
- informacoes_operacionais: avisos operacionais (proxima leitura, vencimento, etc., ate 500 chars)

==== JSON RESPOSTA ====
Responda APENAS JSON:
{
  "itens": [{"descricao":"...","tipo":"...","posto":"...","unidade":"...","quantidade":N,"tarifa_unit":N,"valor":N}, ...],
  "metadados": {
    "indicadores": {"mercado_livre":bool, "geracao_distribuida":bool, "leitura_real":bool, "leitura_estimativa":bool, "tarifa_social":bool, "cliente_rural":bool, "beneficio_fiscal":bool, "troca_medidor":bool, "impedimento_leitura":bool},
    "encargos_detalhados": {"cde":N, "proinfa":N, "ess":N, "eer":N, "ccc":N},
    "tecnicos": {"tipo_medicao":"...", "rtp":"...", "fator_carga":N, "fator_potencia":N},
    "gd": {"energia_injetada_kwh":N, "energia_compensada_kwh":N, "saldo_credito_energia":N},
    "observacoes": "...",
    "informacoes_operacionais": "..."
  },
  "confianca": <0.0-1.0>
}

==== INSTRUCAO ANTERIOR PRESERVADA ====
"""


PROMPT_ITENS_COBRADOS_LEGADO = """Voce ve UM CROP com a TABELA DE ITENS COBRADOS de uma fatura brasileira de energia eletrica.

Extraia CADA LINHA da tabela como um item separado.

==== FORMATO NUMERICO BR ====
"1.234,56" = 1234.56 reais   "13.556,70" = 13556.70 (NUNCA 13.5567)

==== CLASSIFICACAO DOS TIPOS ====
Pra cada item, classifique em uma destas categorias:

- TUSD          : "TUSD em kWh", "TUSD em kW", "Consumo Ativo Ponta TUSD", "Uso Sistema Fio kW", "Cons.TUSD"
- TE            : "Energia ACL", "Tarifa de Energia", "Cons.TE", "TE - Ponta", "Energia Eletrica Cativo"
- DEMANDA       : "Demanda Contratada", "Demanda Ultrapassagem", "Demanda Faturada", "Dem. Ponta"
- BANDEIRA      : "Adic. Bandeira Amarela/Vermelha/Verde", "Bandeira Tarifaria"
- ENCARGO       : "CDE", "CCC", "ESS", "PROINFA", "Encargo Setorial"
- TRIBUTO       : "ICMS", "PIS", "COFINS", "CIP" (iluminacao publica)
- COMPENSACAO_GD: "Energia Compensada GD", "Energia Injetada", "Saldo GD", "Enrg Atv Inj"
- APCEI         : qualquer item com "APCEI", "Homolog.CCEE", "Diferenca de Faturamento", "Recalculo"
- CREDITO       : "Credito", "Devolucao", "Reclamacao", valores negativos isolados
- DEBITO        : "Debito", "Parcelamento", "Multa", "Juros"
- OUTRO         : qualquer coisa que nao se encaixe acima

==== POSTO ====
Identifique o posto pela descricao:
- "Ponta", "P", "HP" (Hora Ponta) -> "PONTA"
- "Fora Ponta", "F.Ponta", "FPonta", "FP", "HFP" -> "F.PONTA"
- Se nao especifica posto -> "UNICO"

==== EXTRAIA TODAS AS LINHAS ====
Inclua TUDO que estiver na tabela: TUSD (qualquer posto/unidade), TE, deduções, créditos, débitos, APCEI, GD, tributos consolidados, CIP.

Pra cada item:
- descricao: TEXTO LITERAL da fatura (exatamente como aparece, ate 255 chars)
- tipo: uma das categorias acima
- posto: PONTA / F.PONTA / UNICO
- unidade: "kWh", "kW", "UN", "R$" ou null
- quantidade: float ou null
- tarifa_unit: float ou null
- valor: float (em reais, pode ser negativo)

Responda APENAS JSON:
{
  "itens": [
    {"descricao":"...","tipo":"TUSD","posto":"PONTA","unidade":"kWh","quantidade":1021.93,"tarifa_unit":1.974290,"valor":2017.57},
    ...
  ],
  "confianca": 0.95
}"""

# Prompt v4 — layout-agnostic + formato BR explicito + leitura linha-especifica
PROMPTS_POR_CAMPO = {
    "cofins_valor": """Voce ve UM CROP de fatura BRASILEIRA de energia eletrica. Extraia o VALOR (em R$) do tributo COFINS.

==== FORMATO NUMERICO BR ====
Numeros brasileiros usam VIRGULA como decimal e PONTO como separador de milhar.
Exemplos:
  "126,97"     = 126.97 reais
  "1.234,56"   = 1234.56 reais  (NUNCA 1.23456!)
  "13.556,70"  = 13556.70 reais (NUNCA 13.5567!)
  "2.724,88"   = 2724.88 reais

==== ONDE PROCURAR ====
O COFINS aparece em uma TABELA DE TRIBUTOS junto com PIS/PASEP e ICMS.

Layout tipico (tributos empilhados verticalmente em 3 linhas):
  | TRIBUTO   | BASE CALC (R$) | ALIQUOTA (%) | VALOR (R$)  |
  | PIS/PASEP |   X.XXX,XX     |    0,X%      |    X,XX     |  <- linha PIS
  | COFINS    |   X.XXX,XX     |    X,XX%     |   XX,XX     |  <- linha COFINS  <-- QUERO ESTA
  | ICMS      |   X.XXX,XX     |   18,00%     |  XXX,XX     |  <- linha ICMS

Outro layout (DANF3E moderno): linhas tipo "0699  COFINS (0,32%)  <base>  <aliq>  <VALOR>"
Pode aparecer multiplas vezes (Ponta/Fora Ponta) — some os valores R$ das linhas COFINS.

==== ATENCAO LAYOUT EDP / MERCADO CATIVO + LIVRE ====
Alguns layouts (EDP ES/SP, alguns ENEL etc) tem **2 LINHAS COFINS** com bases muito diferentes (uma pequena, outra grande):
  COFINS  4,22       4,03    0,17     <- linha residual (base pequena)
  COFINS  5.110,94   5,26    268,84   <- linha principal (base grande)
NESTE caso, retorne APENAS o VALOR DA LINHA DE MAIOR VALOR R$ (linha principal):
  cofins_valor = 268.84  (NAO some com 0.17)

==== Diferenca importante ====
- DANF3E ENEL SP com COFINS Ponta + COFINS F.Ponta (codigos 0699): SOMA os valores (sao postos diferentes do mesmo COFINS).
- EDP / Mercado Cativo+Livre com COFINS em duas bases (uma pequena residual + uma grande principal): pega so a MAIOR.

Como distinguir: se os valores R$ sao DA MESMA ORDEM DE GRANDEZA, soma. Se um e MUITO menor que outro (>10x diferenca), pega so o maior.

==== REGRAS CRITICAS ====
1. Identifique especificamente a LINHA COFINS — nao confunda com a linha PIS/PASEP acima nem com ICMS abaixo.
   PIS/PASEP tem aliquota baixa (~0.5-1.5%); COFINS ~3-7%; ICMS ~18-25%. Use isso pra confirmar a linha.
2. O VALOR (R$) e SEMPRE o ULTIMO numero da linha (coluna mais a direita).
3. NUNCA confunda ALIQUOTA (%) com VALOR (R$). Aliquota e o numero PEQUENO seguido de "%".
4. IGNORE colunas tipo "PIS/COFINS" dentro de linhas de itens (Energia/TUSD/TE) — isso e o COFINS unitario do item, NAO o total.
5. Se a tabela mostra "COFINS" sem isolar valor (so combinado com PIS), retorne null.
6. Se ha "Imposto Retido" vs "Imposto Pago", use IMPOSTO PAGO (ultima coluna).

==== EXTRAIA OS 3 TRIBUTOS (FORCA layout-awareness) ====
Pra te forcar a entender o layout corretamente, extraia os 3 valores da tabela (PIS+COFINS+ICMS).
Isso te obriga a mapear as 3 linhas — assim voce nao confunde a linha COFINS com a do PIS.

Responda APENAS JSON: {
  "pis_valor": <float em reais, ou null>,
  "cofins_valor": <float em reais, ou null>,
  "icms_valor": <float em reais, ou null>,
  "confianca": <0.0-1.0>
}""",

    "pis_valor": """Voce ve UM CROP de fatura BRASILEIRA de energia eletrica — uma faixa horizontal que inclui linha(s) do tributo PIS/PASEP.

Em faturas brasileiras, PIS/PASEP aparece de varias formas:

(A) TABELA TRIBUTOS ISOLADA com colunas |TRIBUTO|BASE CALC (R$)|ALIQUOTA (%)|VALOR (R$)|.
Ex: "PIS/PASEP  2.724,88  1,01  27,51" — onde 1,01 e ALIQUOTA (%) e 27,51 e o VALOR (R$).
NAO confunda aliquota (~0.5-1.5%) com valor R$.

(B) LINHAS COM CODIGO DANF3E, tipo "0699  PIS/PASEP (0,07%)  <base>  <aliq%>  <VALOR_RS>".
Pode aparecer multiplas vezes — some os valores R$.

(C) IGNORE colunas "PIS/COFINS" dentro de linhas de itens (TUSD, TE) — e o PIS unitario do item.
IGNORE linhas de COFINS.

Responda APENAS JSON: {"pis_valor": <float, ou null>, "confianca": <0.0-1.0>}""",

    # =============== TRIBUTOS RESTANTES ===============

    "icms_valor": """Voce ve UM CROP com a tabela de TRIBUTOS de fatura brasileira de energia.

Formato BR: virgula = decimal, ponto = milhar. "1.234,56" = 1234.56 (NAO 1.23456).

Tabela tipica:
  | PIS/PASEP | base | 0,X%  | valor |  (aliquota ~0.5-1.5%)
  | COFINS    | base | X,XX% | valor |  (aliquota ~3-7%)
  | ICMS      | base | 18%   | valor |  (aliquota ~18-25%)  <-- QUERO O VALOR ESTA LINHA

Extraia ICMS_valor (ultimo numero R$ da linha ICMS). Se tiver "Imposto Retido" vs "Imposto Pago", use PAGO.
Se ha multiplas linhas ICMS (Mercado Cativo+Livre), pegue a de MAIOR VALOR.

Responda JSON: {"icms_valor": <float reais, ou null>, "confianca": <0-1>}""",

    "icms_base_calculo": """Crop com tabela TRIBUTOS. Extraia a BASE DE CALCULO do ICMS (em R$).

Formato BR: "1.234,56" = 1234.56 (vírgula = decimal).

Layout tipico: |TRIBUTO|BASE CALC R$|ALIQUOTA %|VALOR R$|
Linha ICMS: o PRIMEIRO numero R$ da linha (coluna BASE CALC), nao o ultimo (VALOR).

Responda JSON: {"icms_base_calculo": <float reais, ou null>, "confianca": <0-1>}""",

    "icms_aliquota": """Crop com tabela TRIBUTOS. Extraia a ALIQUOTA do ICMS (em PERCENTUAL).

Aliquota ICMS tipica: 18.00, 19.00, 20.00, 25.00 (varia por estado).
Layout tipico: |TRIBUTO|BASE CALC|ALIQUOTA %|VALOR| — pegue o numero seguido de "%" da linha ICMS.

Retorne so o NUMERO (18.00, nao "18%"). Formato BR: "18,00" = 18.0.

Responda JSON: {"icms_aliquota": <float, ou null>, "confianca": <0-1>}""",

    "pis_aliquota": """Crop com tabela TRIBUTOS. Extraia a ALIQUOTA do PIS/PASEP (em PERCENTUAL).

Aliquota PIS tipica: 0.65, 1.65, 1.0, 1.10 (varia por regime). NAO confunda com VALOR R$.
Layout: |TRIBUTO|BASE CALC|ALIQUOTA %|VALOR R$|. Pegue o numero da coluna ALIQUOTA da linha PIS/PASEP.

Formato BR: "1,65" = 1.65 (NAO confunda "1,65" valor com "1,65%" aliquota).

Responda JSON: {"pis_aliquota": <float, ou null>, "confianca": <0-1>}""",

    "cofins_aliquota": """Crop com tabela TRIBUTOS. Extraia a ALIQUOTA do COFINS (em PERCENTUAL).

Aliquota COFINS tipica: 3.00, 4.00, 5.00, 7.60 (varia por regime).
Layout: |TRIBUTO|BASE CALC|ALIQUOTA %|VALOR R$|. Pegue o numero da coluna ALIQUOTA da linha COFINS.

Se ha 2 linhas COFINS (Mercado Cativo+Livre), pegue a aliquota da LINHA DE MAIOR VALOR R$.

Responda JSON: {"cofins_aliquota": <float, ou null>, "confianca": <0-1>}""",

    # =============== LEITURAS ===============

    "leit_ant_ativa_ponta": """Crop de "DADOS DE MEDIÇÃO" / "QUADRO DE MEDICAO" / "Leituras" de fatura de energia.

Tabela tipica de medicao:
  | Posto       | Leit Anterior | Leit Atual | Consumo |
  | PONTA       |    XXXX,XX    |   XXXX,XX  |  XXX    |
  | FORA PONTA  |    XXXX,XX    |   XXXX,XX  |  XXXX   |
  | RESERVADO   |     ...                                |
  | REATIVA ... |     ...       (IGNORE — eh reativa)    |

Quero a LEITURA ANTERIOR da linha PONTA (posto PONTA, energia ATIVA — NAO reativa).
Formato BR: "1.234,56" = 1234.56.

Responda JSON: {"leit_ant_ativa_ponta": <float, ou null>, "confianca": <0-1>}""",

    "leit_atu_ativa_ponta": """Crop de "DADOS DE MEDIÇÃO" / "QUADRO DE MEDICAO" de fatura.

Quero a LEITURA ATUAL da linha PONTA (energia ATIVA — NAO reativa).
Layout: |Posto|Leit Ant|Leit Atu|Consumo|. Linha PONTA, coluna "Leit Atu" / "Leitura Atual".

Formato BR: "5.432,18" = 5432.18.

Responda JSON: {"leit_atu_ativa_ponta": <float, ou null>, "confianca": <0-1>}""",

    "leit_ant_ativa_fponta": """Crop de "DADOS DE MEDIÇÃO" / "QUADRO DE MEDICAO" de fatura.

Quero a LEITURA ANTERIOR da linha FORA PONTA / F.PONTA / FP (energia ATIVA — NAO reativa).

Responda JSON: {"leit_ant_ativa_fponta": <float, ou null>, "confianca": <0-1>}""",

    "leit_atu_ativa_fponta": """Crop de "DADOS DE MEDIÇÃO" / "QUADRO DE MEDICAO" de fatura.

Quero a LEITURA ATUAL da linha FORA PONTA / F.PONTA / FP (energia ATIVA — NAO reativa).

Responda JSON: {"leit_atu_ativa_fponta": <float, ou null>, "confianca": <0-1>}""",

    # =============== DATAS ===============

    "data_leitura_anterior": """Crop com periodo de leitura da fatura. Extraia a DATA DA LEITURA ANTERIOR.

Aparece como:
  "Leitura Anterior: 03/04/2026"
  "PERIODO: 03/04/2026 a 03/05/2026" (a 1a data eh a anterior)
  "Leit. Ant: 03/04"

Retorne formato DD/MM/AAAA (string). Se so tem DD/MM sem ano, use o ano da fatura.

Responda JSON: {"data_leitura_anterior": "DD/MM/AAAA", "confianca": <0-1>}""",

    "data_leitura_atual": """Crop com periodo de leitura da fatura. Extraia a DATA DA LEITURA ATUAL.

Aparece como:
  "Leitura Atual: 03/05/2026"
  "PERIODO: 03/04/2026 a 03/05/2026" (a 2a data eh a atual)

Retorne formato DD/MM/AAAA.

Responda JSON: {"data_leitura_atual": "DD/MM/AAAA", "confianca": <0-1>}""",

    "dias_faturados": """Crop com periodo de leitura. Extraia o NUMERO DE DIAS faturados (entre leitura anterior e atual).

Aparece como:
  "DIAS: 31"   "Periodo: 30 dias"   "31 dias faturados"
Tipicamente entre 28 e 33 dias.

Responda JSON: {"dias_faturados": <int, ou null>, "confianca": <0-1>}""",

    # =============== IDENTIFICADORES ===============

    "numero_fatura": """Crop do cabecalho ou rodape da fatura. Extraia o NUMERO DA NOTA FISCAL / FATURA.

Aparece como:
  "Nota Fiscal Nº 5361041"
  "N° 187081265"
  "FATURA: 1234567890"

Geralmente eh um numero longo (7-15 digitos), sem letras.

Responda JSON: {"numero_fatura": "<string>", "confianca": <0-1>}""",

    "numero_medidor": """Crop com area de medidor / "DADOS DE MEDIÇÃO".

Extraia o NUMERO DE SERIE DO MEDIDOR (nao da instalacao, nao da UC).

Aparece como:
  "Medidor: OAX162000084"
  "Nº Medidor: 12505959-1"
  "MEDIDOR  4378633"

Pode conter letras + numeros, ou so numeros. Tipicamente 6-15 caracteres.
IGNORE: codigo_uc, numero_instalacao, palavras como "Grandezas", "Leitura".

Responda JSON: {"numero_medidor": "<string>", "confianca": <0-1>}""",

    "constante_k": """Crop com area de medidor. Extraia a CONSTANTE DE MULTIPLICACAO do medidor (Constante K / Const. Medidor / Fator Multiplicador).

Aparece como:
  "Const. Medidor: 0,042"
  "Constante: 1,0"
  "Fator multiplicador: 80"
  "K: 0,525"

Tipicamente: 0.001 a 1000 (decimal ou inteiro).
Formato BR: "0,042" = 0.042; "1,0" = 1.0; "160" = 160.

Responda JSON: {"constante_k": <float, ou null>, "confianca": <0-1>}""",

    "valor_total_fatura": """Crop com area de "TOTAL A PAGAR" da fatura.

Extraia o VALOR TOTAL FINAL (em R$). Eh sempre o valor mais destacado/grande.

Aparece como:
  "TOTAL A PAGAR: R$ 5.588,58"
  "Total: R$ 12.345,67"
  "VALOR TOTAL: R$ 234,90"

Formato BR: "5.588,58" = 5588.58.
IGNORE: subtotais, valores de itens individuais, totais de bloco.

Responda JSON: {"valor_total_fatura": <float reais, ou null>, "confianca": <0-1>}""",

    # =============== CONSUMO ===============

    "consumo_ativo_ponta_kwh": """Crop com area de consumo / faturamento da fatura.

Extraia o CONSUMO ATIVO PONTA em kWh (energia ATIVA — NAO reativa).

Aparece como:
  "Energia Ativa - Ponta  XXX kWh"
  Linha de item: "Cons.Ativo Ponta  XXX  ..."
  Tabela medicao: linha PONTA coluna Consumo

NAO confunda com:
  - Reativa (kvarh)
  - Fora Ponta
  - Demanda (kW)

Formato BR: "1.234,56" = 1234.56.

Responda JSON: {"consumo_ativo_ponta_kwh": <float kWh, ou null>, "confianca": <0-1>}""",

    "consumo_ativo_fponta_kwh": """Crop com area de consumo / faturamento.

Extraia o CONSUMO ATIVO FORA PONTA (F. Ponta / FP) em kWh.

Aparece como:
  "Energia Ativa - F.Ponta  XXX kWh"
  "Cons.Ativo F.Ponta  XXXX"
  Linha "FORA PONTA" da tabela de medicao, coluna Consumo

NAO confunda com Ponta nem com Reativa (kvarh).

Responda JSON: {"consumo_ativo_fponta_kwh": <float kWh, ou null>, "confianca": <0-1>}""",

    # =============== DEMANDA ===============

    "demanda_contratada_ponta_kw": """Crop com area de "GRANDEZAS CONTRATADAS" / "Demanda Contratada".

Extraia a DEMANDA CONTRATADA PONTA em kW.

Aparece como:
  "Demanda Contratada Ponta: 80 kW"
  "GRANDEZAS CONTRATADAS  Demanda HP: 100"
  Tabela: "Dem. Cont. P: 200 kW"

NAO confunda com:
  - Demanda faturada (eh diferente)
  - Demanda Fora Ponta
  - Demanda de geracao GD

Responda JSON: {"demanda_contratada_ponta_kw": <float kW, ou null>, "confianca": <0-1>}""",

    "demanda_contratada_fponta_kw": """Crop com area de "GRANDEZAS CONTRATADAS".

Extraia a DEMANDA CONTRATADA FORA PONTA em kW.

Aparece como:
  "Demanda Contratada F.Ponta: 100 kW"
  "GRANDEZAS CONTRATADAS Demanda HFP: 150"

Em modalidade VERDE, demanda contratada eh UNICA (mesma valor pra Ponta e F.Ponta). Em AZUL, sao diferentes.
Se for VERDE e so ve um valor, esse valor vale pra ambos (Ponta e F.Ponta).

Responda JSON: {"demanda_contratada_fponta_kw": <float kW, ou null>, "confianca": <0-1>}""",

    # =============== CLASSIFICACAO ===============

    "grupo_tarifario": """Crop com area de "CLASSIFICAÇÃO" / "Grupo Tarifario" / cabecalho da fatura.

Extraia o GRUPO TARIFARIO. Valores possiveis: APENAS "A" ou "B".
Regra: se a fatura menciona modalidade "Azul" ou "Verde", eh grupo A. Se eh "Convencional" ou "Branca", normalmente B.
Aparece como:
  "Grupo: A"
  "GRUPO TARIFARIO B"
  "Classificacao: A - A4 - Verde - Comercial"

Responda JSON: {"grupo_tarifario": "A" ou "B", "confianca": <0-1>}""",

    "subgrupo_tarifario": """Crop com area de "CLASSIFICAÇÃO" / cabecalho.

Extraia o SUBGRUPO TARIFARIO. Valores possiveis: A1, A2, A3, A3a, A4, AS, B1, B2, B3, B4.
Aparece como:
  "Subgrupo: A4"
  "A4 - Verde - Comercial"
  "B3 - CONVENCIONAL"

Responda JSON: {"subgrupo_tarifario": "<string>", "confianca": <0-1>}""",

    "modalidade_tarifaria": """Crop com area de "CLASSIFICAÇÃO" / cabecalho.

Extraia a MODALIDADE TARIFARIA. Valores possiveis: Verde, Azul, Convencional, Branca.
Aparece como:
  "Modalidade: Verde"
  "Tarifaria Azul"
  "CONVENCIONAL"

Responda JSON: {"modalidade_tarifaria": "<Verde|Azul|Convencional|Branca>", "confianca": <0-1>}""",

    "classe_consumidor": """Crop com area de "CLASSIFICAÇÃO" / cabecalho.

Extraia a CLASSE DO CONSUMIDOR. Valores ANEEL (siglas em MAIUSCULAS):
  COMERCIAL, RESIDENCIAL, INDUSTRIAL, RURAL, PODER PUBLICO, SERVICO PUBLICO, ILUMINACAO PUBLICA

Aparece como:
  "Classe: Comercial" -> retorna "COMERCIAL"
  "Industrial" -> "INDUSTRIAL"
  "Poder Publico Federal" -> "PODER PUBLICO"

Responda JSON: {"classe_consumidor": "<sigla MAIUSCULA>", "confianca": <0-1>}""",

    "tensao_fornecimento": """Crop com area de "CLASSIFICAÇÃO" / cabecalho / dados tecnicos.

Extraia a TENSAO DE FORNECIMENTO em VOLTS (numero).

Aparece como:
  "Tensao: 13.800 V"  -> 13800
  "Tensao: 220 V"     -> 220
  "11 kV"             -> 11000
  "13,8 kV"           -> 13800

Sempre converta pra VOLTS (multiplicar por 1000 se for kV).

Responda JSON: {"tensao_fornecimento": <int volts, ou null>, "confianca": <0-1>}""",
}


_NUM_RE = re.compile(r"\d[\d.,]{0,12}")
_TRIBUTOS_VIZINHOS = ("PIS", "PASEP", "ICMS", "CONFINS", "COFINS", "TRIBUTO")


def _score_ocorrencia(palavra, words_pg, anchor_up: str) -> float:
    """Score 'esta palavra-anchor esta em tabela de tributos?'

    Maior score = mais provavel ser a tabela TRIBUTOS (nao texto legal).
    """
    # palavra: (x0, y0, x1, y1, text, block, line, word)
    x0, y0, x1, y1, txt = palavra[:5]
    y_centro = (y0 + y1) / 2
    h_linha = y1 - y0
    # Palavras na mesma linha (centro y proximo)
    mesma_linha = [w for w in words_pg
                   if abs(((w[1] + w[3]) / 2) - y_centro) < max(3, h_linha)]
    # Palavras em linhas vizinhas (ate ~3 linhas acima/abaixo)
    proximas = [w for w in words_pg
                if 0 < abs(((w[1] + w[3]) / 2) - y_centro) < h_linha * 5]

    score = 0.0
    # (+) Numeros R$ na mesma linha
    nums_mesma = [w for w in mesma_linha if _NUM_RE.search(w[4]) and "," in w[4]]
    score += len(nums_mesma) * 4
    # (+) Outros tributos em linhas vizinhas (PIS, ICMS prox a COFINS = tabela)
    outros_trib = sum(1 for w in proximas
                      if any(t in w[4].upper() for t in _TRIBUTOS_VIZINHOS)
                      and anchor_up not in w[4].upper())
    score += outros_trib * 5
    # (-) Linha longa = texto corrido / paragrafo legal
    if len(mesma_linha) > 10:
        score -= 10
    # (-) Palavra esta em palavra mais longa tipo "PIS/COFINS" (anchor=COFINS) -> menos especifico
    if txt.upper() != anchor_up and txt.upper().endswith(anchor_up):
        score -= 1
    return score


def achar_bbox_anchor(pdf_bytes: bytes, anchors: list[str]):
    """Encontra bbox que UNE todas ocorrencias do anchor na regiao da tabela tributos.

    Estrategia v3:
    1. Coleta TODAS ocorrencias do anchor + scores
    2. Escolhe a com maior score = ancora primaria (provavel tabela tributos)
    3. Procura outras ocorrencias do mesmo anchor PROXIMAS (mesma pagina, dy<100px)
       e une os bboxes — pra cobrir layouts EDP/etc com multiplas linhas COFINS.

    Retorna (page_idx, bbox_unido, page_w, page_h) ou (None, None, None, None).
    """
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        print(f"    [erro fitz: {e}]")
        return None, None, None, None
    try:
        # Coleta todas ocorrencias com score
        todas = []  # [(score, pidx, w_tuple, pw, ph), ...]
        for pidx, page in enumerate(doc):
            words_pg = page.get_text("words")
            for anchor in anchors:
                anchor_up = anchor.upper()
                for w in words_pg:
                    txt_up = w[4].upper()
                    if not (txt_up.startswith(anchor_up) or anchor_up in txt_up):
                        continue
                    score = _score_ocorrencia(w, words_pg, anchor_up)
                    todas.append((score, pidx, w, page.rect.width, page.rect.height))
        if not todas:
            return None, None, None, None
        # Melhor ocorrencia (ancora primaria)
        todas.sort(key=lambda t: -t[0])
        score_max, pidx_p, w_p, pw, ph = todas[0]
        # Une outras na mesma pagina e dentro de 100px verticais (mesma regiao)
        bbox = {"x0": w_p[0], "x1": w_p[2], "top": w_p[1], "bottom": w_p[3]}
        y_centro_p = (w_p[1] + w_p[3]) / 2
        for score, pidx, w, _, _ in todas[1:]:
            if pidx != pidx_p:
                continue
            y_centro_w = (w[1] + w[3]) / 2
            if abs(y_centro_w - y_centro_p) > 100:
                continue
            # Score similar (>= 50% do max) — evita unir com ocorrencia fraca (texto legal)
            if score < score_max * 0.5 and score < 5:
                continue
            bbox["top"] = min(bbox["top"], w[1])
            bbox["bottom"] = max(bbox["bottom"], w[3])
            bbox["x0"] = min(bbox["x0"], w[0])
            bbox["x1"] = max(bbox["x1"], w[2])
        return pidx_p, bbox, pw, ph
    finally:
        doc.close()
    return None, None, None, None


def crop_imagem(pdf_bytes: bytes, page_idx: int, bbox: dict,
                page_w: float, page_h: float,
                expand_top: int = 40, expand_bot: int = 120,
                scale: float = 2.0) -> str:
    """Faixa horizontal full-width ao redor do bbox. Retorna PNG base64."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    page = doc[page_idx]
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    doc.close()
    img_w, img_h = img.size
    sy = img_h / page_h
    y0 = max(0, int(bbox["top"] * sy - expand_top))
    y1 = min(img_h, int(bbox["bottom"] * sy + expand_bot))
    crop = img.crop((0, y0, img_w, y1))
    buf = io.BytesIO()
    crop.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def chamar_vision(prompt: str, imagens_b64: list[str], max_tokens: int = None) -> dict:
    """gpt-5.4 + vision + flex, 1 call. Retorna dict ou {'erro': ...}."""
    if not _OPENAI_KEY:
        return {"erro": "no api key"}
    content = [{"type": "text", "text": prompt}]
    for b64 in imagens_b64:
        content.append({"type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{b64}"}})
    body = {
        "model": MODELO,
        "messages": [{"role": "user", "content": content}],
        "max_completion_tokens": max_tokens or MAX_TOKENS,
        "response_format": {"type": "json_object"},
        "service_tier": SERVICE_TIER,
    }
    headers = {"Authorization": f"Bearer {_OPENAI_KEY}",
               "Content-Type": "application/json"}
    for tentativa in range(3):
        try:
            r = requests.post(f"{_BASE_URL}/v1/chat/completions",
                              headers=headers, json=body, timeout=180)
            if r.status_code == 200:
                raw = r.json()["choices"][0]["message"]["content"]
                try:
                    return json.loads(raw)
                except json.JSONDecodeError:
                    m = re.search(r"\{[\s\S]+\}", raw)
                    if m:
                        try:
                            return json.loads(m.group(0))
                        except Exception:
                            return {"erro": "parse_error", "raw": raw[:200]}
                    return {"erro": "parse_error"}
            if r.status_code in (429, 503):
                time.sleep(min(60, 5 * (2 ** tentativa)))
                continue
            return {"erro": f"http {r.status_code}", "detalhe": r.text[:200]}
        except requests.exceptions.RequestException:
            time.sleep(3 * (tentativa + 1))
    return {"erro": "network"}


def extrair_campo(fid: int, link: str, campo: str) -> dict:
    """Pipeline campeao: crop bbox + gpt-5.4 vision flex 2x + fallback se discordam.

    Retorna {valor, confianca, fonte, calls, sem_anchor?, erro?}"""
    anchors = ANCHORS_POR_CAMPO.get(campo)
    prompt = PROMPTS_POR_CAMPO.get(campo)
    if not anchors or not prompt:
        return {"erro": f"campo {campo} nao tem anchor/prompt configurado"}

    pdf = baixar_pdf_cached(fid, link)
    if not pdf:
        return {"erro": "sem pdf"}
    pidx, bbox, pw, ph = achar_bbox_anchor(pdf, anchors)
    if bbox is None:
        return {"sem_anchor": True}
    crop = crop_imagem(pdf, pidx, bbox, pw, ph)

    # 2 calls self-consistency
    calls = []
    for _ in range(N_CALLS_PRIMARIO):
        resp = chamar_vision(prompt, [crop])
        v = resp.get(campo) if isinstance(resp, dict) else None
        c = resp.get("confianca", 0) if isinstance(resp, dict) else 0
        e = resp.get("erro") if isinstance(resp, dict) else "no_response"
        calls.append({"val": v, "conf": c, "erro": e})

    vals = [c["val"] for c in calls]
    consistente = True
    if any(v is None for v in vals):
        consistente = False
    else:
        try:
            consistente = max(vals) - min(vals) < DIFF_TOLERANCIA
        except Exception:
            consistente = False

    if consistente:
        return {"valor": vals[0], "confianca": calls[0]["conf"],
                "fonte": f"{MODELO}-self-consistent", "calls": calls}

    # 3a call de desempate
    resp_tb = chamar_vision(prompt, [crop])
    v_tb = resp_tb.get(campo) if isinstance(resp_tb, dict) else None
    c_tb = resp_tb.get("confianca", 0) if isinstance(resp_tb, dict) else 0
    return {"valor": v_tb, "confianca": c_tb,
            "fonte": f"{MODELO}-tiebreaker", "calls": calls + [{"val": v_tb, "conf": c_tb}]}


def crop_tabela_inteira(pdf_bytes: bytes, page_idx: int, bbox: dict,
                        page_w: float, page_h: float,
                        expand_top: int = 30, expand_bot: int = 1500,
                        scale: float = 2.0) -> str:
    """Recorta uma faixa horizontal LARGA pra capturar a tabela de itens inteira.
    expand_bot=1500 cobre tabelas longas (Grupo A/ACL podem ter 25+ linhas)."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    page = doc[page_idx]
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    doc.close()
    img_w, img_h = img.size
    sy = img_h / page_h
    y0 = max(0, int(bbox["top"] * sy - expand_top))
    y1 = min(img_h, int(bbox["bottom"] * sy + expand_bot))
    crop = img.crop((0, y0, img_w, y1))
    buf = io.BytesIO()
    crop.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


# Palavras-cabeçalho de tabelas de itens em fatura BR (varias distribuidoras)
_HEADERS_TABELA = {"QUANT.", "QUANT", "UNID.", "UNID", "ITENS",
                   "DESCRIÇÃO", "DESCRICAO", "DESCRIÇAO", "DESCRICÃO",
                   "TARIFA", "VALOR", "PREÇO", "PRECO", "VALOR(R$)",
                   "BASE", "ALÍQ.", "ALIQ", "ICMS"}

# Palavras de ITEM (componentes tipicos da fatura). Fallback se header nao acha.
_PALAVRAS_ITEM = {"TUSD", "TUSDG", "TE", "CONSUMO", "DEMANDA", "BANDEIRA",
                  "ENERGIA", "ACL", "CIP", "ICMS", "COFINS", "PIS",
                  "ENCARGO", "UFER", "APCEI", "COMPENSADA", "INJETADA",
                  "CREDITO", "DEBITO"}


def achar_bbox_tabela_itens(pdf_bytes: bytes):
    """Acha a TABELA DE ITENS via clustering de palavras-cabeçalho na mesma linha.

    Estrategia: tabelas de itens tem header com 3-7 palavras-cabeçalho lado-a-lado
    (DESCRIÇÃO + UNID + QUANT + TARIFA + VALOR, ou similar). Score = numero de
    palavras-cabeçalho na mesma faixa Y (linha). O grupo com mais headers ganha.

    Retorna (pidx, bbox_do_grupo, pw, ph) ou (None, None, None, None).
    """
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        print(f"    [erro fitz: {e}]")
        return None, None, None, None
    try:
        # Tentativa 1: clustering de HEADERS (Quant, Unid, Tarifa, etc) na mesma linha
        melhor = None  # (n_headers, pidx, bbox, pw, ph)
        for pidx, page in enumerate(doc):
            words = page.get_text("words")
            headers = [w for w in words if w[4].upper() in _HEADERS_TABELA]
            if len(headers) < 2:
                continue
            grupos = []
            for h in headers:
                y_c = (h[1] + h[3]) / 2
                for g in grupos:
                    if abs(g["y"] - y_c) <= 6:
                        g["palavras"].append(h)
                        g["y"] = sum(((p[1]+p[3])/2) for p in g["palavras"]) / len(g["palavras"])
                        break
                else:
                    grupos.append({"y": y_c, "palavras": [h]})
            ph = page.rect.height
            for g in grupos:
                n = len(g["palavras"])
                if n < 3:
                    continue
                # Penalidade espacial: grupos no terço inferior (rodapé "Reservado ao Fisco",
                # "Base de Cálculo ICMS", etc) tendem a ser tabelas-resumo NAO de itens.
                # Subtrai 1 ponto por cada 100px abaixo de 50% da página.
                y_centro = g["y"]
                penalty = max(0, (y_centro - ph * 0.5) / 100)
                score = n - penalty
                if melhor is None or score > melhor[0]:
                    pals = g["palavras"]
                    bbox = {
                        "x0": min(p[0] for p in pals),
                        "x1": max(p[2] for p in pals),
                        "top": min(p[1] for p in pals),
                        "bottom": max(p[3] for p in pals),
                    }
                    melhor = (score, pidx, bbox, page.rect.width, page.rect.height)
        if melhor:
            return melhor[1], melhor[2], melhor[3], melhor[4]

        # Tentativa 2 (FALLBACK): clustering de PALAVRAS-ITEM (TUSD, TE, ICMS, BANDEIRA, etc).
        # Útil pra layouts onde headers nao tem texto (ELEKTRO, PDFs rasterizados parcialmente).
        # Acha a regiao com MAIOR concentracao vertical de palavras-item.
        melhor_fb = None  # (n_palavras, pidx, bbox, pw, ph)
        for pidx, page in enumerate(doc):
            words = page.get_text("words")
            itens_w = [w for w in words if w[4].upper() in _PALAVRAS_ITEM]
            if len(itens_w) < 3:
                continue
            # Janela deslizante: pra cada palavra, conta quantas outras estao em janela vertical de 200px
            for centro in itens_w:
                y_c = (centro[1] + centro[3]) / 2
                janela = [w for w in itens_w if abs(((w[1]+w[3])/2) - y_c) <= 100]
                n = len(janela)
                if n < 3:
                    continue
                if melhor_fb is None or n > melhor_fb[0]:
                    bbox = {
                        "x0": min(p[0] for p in janela),
                        "x1": max(p[2] for p in janela),
                        "top": min(p[1] for p in janela),
                        "bottom": max(p[3] for p in janela),
                    }
                    melhor_fb = (n, pidx, bbox, page.rect.width, page.rect.height)
        if melhor_fb:
            return melhor_fb[1], melhor_fb[2], melhor_fb[3], melhor_fb[4]
    finally:
        doc.close()
    return None, None, None, None


def montar_prompt_reextrair(itens_anterior: list, validacao: dict) -> str:
    """Prompt de re-extracao quando soma diverge — passa feedback pro modelo."""
    soma_calc = validacao.get("soma_principal", 0)
    valor_fatura = validacao.get("valor_fatura", 0)
    diff_pct = validacao.get("diff_pct", 0) * 100
    diff_abs = abs(soma_calc - valor_fatura)
    # Lista resumida dos itens extraidos anteriormente
    resumo = []
    for it in itens_anterior[:15]:
        resumo.append(f"  - [{it.get('tipo','?')}] {it.get('descricao','?')[:50]} = R${it.get('valor', 0)}")

    return f"""EXTRACAO ANTERIOR FOI INCONSISTENTE — re-extraia com mais cuidado.

PROBLEMA DETECTADO:
A soma dos itens TUSD+TE+BANDEIRA+ENCARGO+DEMANDA+OUTRO que voce extraiu = R${soma_calc:.2f}
Mas o VALOR TOTAL da fatura no banco = R${valor_fatura:.2f}
Diferenca: R${diff_abs:.2f} ({diff_pct:.0f}% de erro)

ITENS QUE VOCE EXTRAIU DA ULTIMA VEZ (revise):
{chr(10).join(resumo)}

POSSIVEIS PROBLEMAS A VERIFICAR:
1. FALTOU ALGUM ITEM? (caso soma < fatura) — ha mais linhas na tabela que voce nao viu?
2. DUPLICOU ALGUM? (caso soma >> fatura) — extraiu mesmo item 2 vezes?
3. CLASSIFICACAO ERRADA? — talvez classificou algo como TRIBUTO quando era TUSD/TE?
4. VALORES ERRADOS? — confundiu BASE_CALCULO com VALOR R$?
5. SINAL TROCADO? — credito (negativo) virou debito (positivo) ou vice-versa?

==== FORMATO NUMERICO BR ====
"1.234,56" = 1234.56 reais   "13.556,70" = 13556.70 (NUNCA 13.5567)

==== CLASSIFICACAO TIPOS ====
- TUSD: "TUSD em kWh/kW", "Consumo Ativo TUSD", "Uso Sistema Fio"
- TE:   "Energia ACL", "Tarifa Energia", "Cons.TE", "Energia Eletrica Cativo"
- DEMANDA: "Demanda Contratada/Faturada/Ultrapassagem"
- BANDEIRA: "Adic. Bandeira"
- ENCARGO: "CDE", "PROINFA"
- TRIBUTO: "ICMS", "PIS", "COFINS", "CIP"
- COMPENSACAO_GD: "Energia Compensada/Injetada GD"
- APCEI: "APCEI", "Homolog.CCEE"
- CREDITO: valores negativos (Bonus, Devolucao, Reclamacao)
- DEBITO: parcelamentos, multas, juros

Reextraia AGORA com atencao. Responda APENAS JSON:
{{
  "itens": [{{"descricao":"...","tipo":"...","posto":"...","unidade":"...","quantidade":N,"tarifa_unit":N,"valor":N}}, ...],
  "confianca": <0-1>
}}"""


def _chamar_vision_modelo(modelo: str, prompt: str, imagens_b64: list[str],
                           max_tokens: int = 4000) -> dict:
    """Variante de chamar_vision que aceita modelo arbitrario (nano/mini/macro).
    Lida com service_tier flex condicional (so gpt-5.x e o-series)."""
    if not _OPENAI_KEY:
        return {"erro": "no api key"}
    content = [{"type": "text", "text": prompt}]
    for b64 in imagens_b64:
        content.append({"type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{b64}"}})
    body = {
        "model": modelo,
        "messages": [{"role": "user", "content": content}],
        "max_completion_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    if modelo.startswith("gpt-5") or modelo.startswith("o"):
        body["service_tier"] = "flex"
    headers = {"Authorization": f"Bearer {_OPENAI_KEY}",
               "Content-Type": "application/json"}
    for tentativa in range(3):
        try:
            r = requests.post(f"{_BASE_URL}/v1/chat/completions",
                              headers=headers, json=body, timeout=180)
            if r.status_code == 200:
                raw = r.json()["choices"][0]["message"]["content"]
                try: return json.loads(raw)
                except json.JSONDecodeError:
                    m = re.search(r"\{[\s\S]+\}", raw)
                    if m:
                        try: return json.loads(m.group(0))
                        except Exception: return {"erro": "parse_error", "raw": raw[:200]}
                    return {"erro": "parse_error"}
            if r.status_code in (429, 503):
                time.sleep(min(60, 5 * (2 ** tentativa))); continue
            return {"erro": f"http {r.status_code}", "detalhe": r.text[:200]}
        except requests.exceptions.RequestException:
            time.sleep(3 * (tentativa + 1))
    return {"erro": "network"}


def extrair_itens_fatura(fid: int, link: str,
                         valor_total_fatura: float | None = None,
                         modelo_primario: str | list[str] = None,
                         modelo_fallback: str = None,
                         n_calls: int = 1,
                         grupo_tarifario: str | None = None,
                         modalidade_tarifaria: str | None = None,
                         adaptativo: bool = False) -> dict:
    """Se adaptativo=True, escolhe modelo baseado em grupo/modalidade automaticamente."""
    if adaptativo:
        modelo_primario, modelo_fallback, n_calls = _modelo_adaptativo(grupo_tarifario, modalidade_tarifaria)
    """Extrai itens cobrados da fatura via vision.

    Args:
        modelo_primario: str (1 modelo) ou list[str] (cross-model). Default: gpt-5.4
        modelo_fallback: usado se primario diverge (self-consistency falha ou cross-model discorda)
        n_calls: self-consistency se >= 2 e modelo_primario for str.

    Retorna {itens, confianca, fonte, custo_estimado, calls} ou {erro}."""
    if modelo_primario is None:
        modelo_primario = MODELO
    pdf = baixar_pdf_cached(fid, link)
    if not pdf: return {"erro": "sem pdf"}
    pidx, bbox, pw, ph = achar_bbox_tabela_itens(pdf)
    if bbox is None:
        pidx, bbox, pw, ph = achar_bbox_anchor(pdf, ANCHOR_ITENS)
    if bbox is None: return {"erro": "anchor tabela itens nao encontrado"}
    crop = crop_tabela_inteira(pdf, pidx, bbox, pw, ph)

    # Determina lista de modelos a chamar
    if isinstance(modelo_primario, str):
        if "," in modelo_primario:
            modelos = [m.strip() for m in modelo_primario.split(",")]
            cross_model = True
        else:
            modelos = [modelo_primario] * max(1, n_calls)
            cross_model = False
    else:
        modelos = list(modelo_primario)
        cross_model = len(modelos) > 1

    calls = []
    for m in modelos:
        resp = _chamar_vision_modelo(m, PROMPT_ITENS_COBRADOS, [crop], max_tokens=6000)
        itens = resp.get("itens", []) if isinstance(resp, dict) else []
        metadados = resp.get("metadados", {}) if isinstance(resp, dict) else {}
        conf = resp.get("confianca", 0) if isinstance(resp, dict) else 0
        soma_p = sum(float(it.get("valor", 0) or 0) for it in itens
                     if (it.get("tipo") or "").upper() in {"TUSD","TE","BANDEIRA","ENCARGO","DEMANDA","OUTRO"} and (it.get("valor", 0) or 0) > 0)
        calls.append({"modelo": m, "itens": itens, "metadados": metadados,
                      "conf": conf, "n": len(itens), "soma_p": round(soma_p, 2)})

    # Se 1 call: dispara fallback condicional se primario "fraco"
    if len(calls) == 1:
        c = calls[0]
        precisa_fb = False
        if modelo_fallback:
            if (c["conf"] or 0) < 0.70:
                precisa_fb = True
            elif valor_total_fatura and c["soma_p"]:
                diff_pct = abs(c["soma_p"] - float(valor_total_fatura)) / max(1, float(valor_total_fatura))
                if diff_pct > 0.15:
                    precisa_fb = True
        if precisa_fb:
            resp_fb = _chamar_vision_modelo(modelo_fallback, PROMPT_ITENS_COBRADOS, [crop], max_tokens=6000)
            itens_fb = resp_fb.get("itens", []) if isinstance(resp_fb, dict) else []
            metadados_fb = resp_fb.get("metadados", {}) if isinstance(resp_fb, dict) else {}
            conf_fb = resp_fb.get("confianca", 0) if isinstance(resp_fb, dict) else 0
            if itens_fb:
                calls.append({"modelo": f"{modelo_fallback}-fallback", "itens": itens_fb,
                              "metadados": metadados_fb, "conf": conf_fb, "n": len(itens_fb),
                              "soma_p": sum(float(it.get("valor", 0) or 0) for it in itens_fb
                                             if (it.get("tipo") or "").upper() in {"TUSD","TE","BANDEIRA","ENCARGO","DEMANDA","OUTRO"} and (it.get("valor", 0) or 0) > 0)})
                return {"itens": _posprocessar_itens(itens_fb), "metadados": metadados_fb,
                        "confianca": conf_fb, "fonte": f"{modelo_fallback}-fallback", "calls": calls}
        return {"itens": _posprocessar_itens(c["itens"]), "metadados": c["metadados"],
                "confianca": c["conf"], "fonte": c["modelo"], "calls": calls}

    # Multiplas calls: escolhe a melhor — proxima do valor_total_fatura, ou maior #itens
    melhor = calls[0]
    for c in calls[1:]:
        if valor_total_fatura:
            diff_m = abs(melhor["soma_p"] - float(valor_total_fatura))
            diff_c = abs(c["soma_p"] - float(valor_total_fatura))
            if diff_c < diff_m: melhor = c
        elif c["n"] > melhor["n"]:
            melhor = c

    # Detecta inconsistencia: se as somas dos calls variam >10%, dispara fallback macro
    inconsistente = False
    if len(calls) >= 2:
        somas = [c["soma_p"] for c in calls if c["soma_p"] > 0]
        if len(somas) >= 2:
            inconsistente = (max(somas) - min(somas)) / max(1, max(somas)) > 0.10

    if inconsistente and modelo_fallback:
        resp_fb = _chamar_vision_modelo(modelo_fallback, PROMPT_ITENS_COBRADOS, [crop], max_tokens=6000)
        itens_fb = resp_fb.get("itens", []) if isinstance(resp_fb, dict) else []
        metadados_fb = resp_fb.get("metadados", {}) if isinstance(resp_fb, dict) else {}
        conf_fb = resp_fb.get("confianca", 0) if isinstance(resp_fb, dict) else 0
        if itens_fb:
            calls.append({"modelo": f"{modelo_fallback}-fallback", "itens": itens_fb,
                          "metadados": metadados_fb, "conf": conf_fb, "n": len(itens_fb)})
            return {"itens": _posprocessar_itens(itens_fb), "metadados": metadados_fb,
                    "confianca": conf_fb, "fonte": f"{modelo_fallback}-fallback", "calls": calls}

    return {"itens": _posprocessar_itens(melhor["itens"]), "metadados": melhor.get("metadados", {}),
            "confianca": melhor["conf"],
            "fonte": melhor["modelo"] + ("-cross" if cross_model else "-sc"), "calls": calls}


# Tipos que SOMAM no valor cobrado (positivos)
_TIPOS_POSITIVOS = {"TUSD","TE","BANDEIRA","ENCARGO","DEMANDA","OUTRO","PARCELAMENTO","TRIBUTO"}
# Tipos que ABATEM (descontos/creditos — geralmente negativos no valor)
_TIPOS_NEGATIVOS = {"COMPENSACAO_GD","CREDITO","RECLAMACAO","APCEI"}
# Tipos INFORMATIVOS: NAO entram em soma_liquida (saldo a usar, valor a creditar, tributos box DANF3E)
_TIPOS_INFORMATIVOS = {"INFORMATIVO", "TRIBUTO_INFORMATIVO"}

# Tributos do box "Demonstrativo de Tributos" (Convenio ICMS 16/2020 — DANF3E).
# Descricoes curtas e isoladas, sem quantidade/tarifa. Ja embutidos nos precos.
_DESCS_TRIBUTO_INFORMATIVO = {"ICMS", "COFINS", "PIS", "PIS/PASEP", "PASEP",
                                "PIS / PASEP", "PIS/COFINS"}

# Distribuidoras DANF3E: precos de consumo ja vem com tributos embutidos.
# Em todas estas, ICMS/PIS/COFINS isolados no JSON sao do box informativo.
# EDP SP e ENEL SP ficam FORA: layouts mistos com tributos como linha real.
_DANF3E_WHITELIST = {
    "CEMIG", "COPEL",
    "CPFL PAULISTA", "CPFL PIRATININGA", "CPFL SANTA CRUZ",
    "EQUATORIAL AL", "EQUATORIAL GO (ENEL GOIAS)", "EQUATORIAL MAR",
    "EQUATORIAL PA", "EQUATORIAL PI", "EQUATORIAL MA",
    "CELESC", "ELEKTRO", "ELEKTRO SP", "RGE",
    "ENERGISA SUL/SUDESTE", "ENERGISA TO", "ENERGISA MT", "ENERGISA MS",
    "NEOENERGIA PE (CELPE)", "NEOENERGIA BA (COELBA)", "NEOENERGIA CE",
    "LIGHT", "ENEL RIO", "EDP ES",
}


def _eh_tributo_informativo_danf3e(item: dict, distribuidora: str | None = None) -> bool:
    """DANF3E box lateral: ICMS/PIS/COFINS isolados = informativos.

    Disparam 2 vias:
    1. Whitelist: distribuidora conhecidamente DANF3E (precos ja com tributos).
    2. Sinal estrutural: pelo menos um entre quantidade ou tarifa_unit populado
       (LLM emite base_calculo em "quantidade" e aliquota% em "tarifa_unit").

    Distribuidora fora da whitelist E sem sinal estrutural = TRIBUTO somavel
    (ex: EDP SP 1214 layout sem tributos embutidos)."""
    desc = (item.get("descricao") or "").strip().upper()
    desc_base = desc.split("(")[0].strip().rstrip(".")
    if desc_base not in _DESCS_TRIBUTO_INFORMATIVO:
        return False
    # Via 1: whitelist distribuidoras DANF3E
    if distribuidora and distribuidora.strip().upper() in _DANF3E_WHITELIST:
        return True
    # Via 2: sinal estrutural
    if item.get("quantidade") is not None or item.get("tarifa_unit") is not None:
        return True
    return False


def soma_liquida_itens(itens: list[dict]) -> tuple[float, float, float]:
    """Retorna (soma_pos, soma_neg, soma_liquida).

    soma_liquida ~= valor_total_fatura (positivos - compensacoes/creditos).
    Note: COMPENSACAO_GD/CREDITO ja vem com sinal negativo no JSON.
    Tipos INFORMATIVO (saldo a usar, valor a creditar) sao ignorados."""
    pos = neg = 0.0
    for it in itens:
        try: v = float(it.get("valor", 0) or 0)
        except Exception: continue
        tipo = (it.get("tipo") or "").upper()
        if tipo in _TIPOS_POSITIVOS:
            if v > 0: pos += v
        elif tipo in _TIPOS_NEGATIVOS:
            neg += v  # ja negativo
        # INFORMATIVO ignorado
    return round(pos, 2), round(neg, 2), round(pos + neg, 2)


# Faixas de confianca operacionais (bench v4: 76% verde, 3% amarelo, 5% vermelho, 16% anomalo).
# Validado: 9/10 verdes concordam entre extracao nova e JSON legado.
def classificar_confianca(diff_pct: float | None) -> str:
    """Operacionaliza flags pra backfill em massa:
      verde (<5%):     auto-grava no banco, alta confianca
      amarelo (5-15%): grava + flag de revisao por amostragem
      vermelho (15-50%): nao grava automaticamente, fila revisao manual
      anomalo (>=50%): so loga, requer investigacao (provavel VrFt errado banco)
    """
    if diff_pct is None: return "sem_dados"
    if diff_pct < 5: return "verde"
    if diff_pct < 15: return "amarelo"
    if diff_pct < 50: return "vermelho"
    return "anomalo"


# Classificacao tripartite pra AUDITORIA (caso de uso alta precisao):
# 3 dimensoes independentes — soma, consistencia interna, completude semantica
_DESCS_ALIQUOTA_TRIB = {"ICMS","COFINS","PIS","PIS/PASEP","PASEP","PIS/COFINS"}

def classificar_para_auditoria(itens: list[dict], valor_total_fatura: float | None) -> dict:
    """Critério rigoroso pra uso em AUDITORIA de fatura (ressarcimento tributario,
    reclassificacao tarifaria, conformidade ANEEL).

    Avalia 3 dimensoes:
      1. SOMA OK: soma_liquida_itens ~ VrFt (tolerancia 5%)
      2. ESTRUTURAL OK: itens com qtd+tarifa+valor tem q*t ~ v (excluindo tributos com aliquota%)
      3. SEMANTICO OK: tem pelo menos um TUSD/TE + um TRIBUTO/TRIBUTO_INFORMATIVO

    Faixas:
      verde_auditavel:           3 dimensoes OK → fila auditoria direta
      verde_revisao_categoria:   soma + estrutural OK, semantico NAO → revisao rapida
      amarelo_revisao_estrutural: soma OK, estrutural ou semantico NAO → revisao normal
      vermelho_extracao_revisar: soma NAO bate → fila revisao manual completa
      sem_dados:                 sem itens ou sem VrFt
    """
    if not itens or valor_total_fatura is None:
        return {"flag": "sem_dados", "soma_ok": False, "estrutural_ok": False, "semantico_ok": False}
    vrft = float(valor_total_fatura)
    if vrft == 0:
        return {"flag": "anomalo_vrft_zero", "soma_ok": False, "estrutural_ok": False, "semantico_ok": False}

    # Soma
    pos, neg, soma = soma_liquida_itens(itens)
    diff_pct = abs(soma - vrft) / max(1, vrft) * 100
    soma_ok = diff_pct < 5

    # Estrutural: q*t ~ v
    # Pula: informativos, tributos com aliquota%, bandeira (taxa fixa)
    # Tolera: TUSD/TE com diff 18-30% (tarifa com tributos embutidos, padrao ANEEL)
    estrutural_ok = True
    inconsistencias = 0
    ambiguidades_tributo_embutido = 0
    for it in itens:
        if it.get("_eh_informativo") or it.get("_motivo_informativo"):
            continue
        desc = (it.get("descricao") or "").strip().upper()
        desc_base = desc.split("(")[0].strip().rstrip(".")
        # Fix 2: pula tributos com aliquota% (PIS/COFINS/ICMS box DANF3E)
        if desc_base in _DESCS_ALIQUOTA_TRIB:
            continue
        q = it.get("quantidade"); t = it.get("tarifa_unit"); v = it.get("valor")
        if q is None or t is None or v is None:
            continue
        # Fix 1: bandeira tarifaria com q=0 t=0 v>0 e taxa fixa, nao cobranca por qtd
        tipo = (it.get("tipo") or "").upper()
        if tipo == "BANDEIRA" or "BANDEIRA" in desc:
            if (q == 0 or t == 0) and v:
                continue  # taxa fixa, nao calcula
        # GD pode ter sinal invertido — comparar abs
        esp_cmp = abs(q * t) if tipo == "COMPENSACAO_GD" else q * t
        v_cmp = abs(v) if tipo == "COMPENSACAO_GD" else v
        diff_pct_item = abs(esp_cmp - v_cmp) / max(1, abs(v_cmp))
        if diff_pct_item <= 0.05:
            continue
        # Fix 3: TUSD/TE com diff 18-30% e provavelmente tarifa com tributos embutidos
        # (ICMS 18% + PIS/COFINS ~6-9% = 24-27% tipico)
        if tipo in {"TUSD", "TE"} and 0.15 <= diff_pct_item <= 0.32:
            ambiguidades_tributo_embutido += 1
            continue
        inconsistencias += 1
    if inconsistencias > 0:
        estrutural_ok = False

    # Semantico
    tipos = {(it.get("tipo") or "").upper() for it in itens}
    tem_principal = bool(tipos & {"TUSD", "TE"})
    tem_tributo = bool(tipos & {"TRIBUTO", "TRIBUTO_INFORMATIVO"})
    semantico_ok = tem_principal and tem_tributo

    # Classifica
    if soma_ok and estrutural_ok and semantico_ok:
        # Verde auditavel, mas marca se teve ambiguidade ANEEL
        flag = "verde_tarifa_aneel" if ambiguidades_tributo_embutido > 0 else "verde_auditavel"
    elif soma_ok and estrutural_ok:
        flag = "verde_revisao_categoria"
    elif soma_ok:
        flag = "amarelo_revisao_estrutural"
    elif diff_pct < 50:
        flag = "vermelho_extracao_revisar"
    else:
        flag = "anomalo_revisar_manual"

    return {
        "flag": flag,
        "soma_ok": soma_ok,
        "estrutural_ok": estrutural_ok,
        "semantico_ok": semantico_ok,
        "diff_pct": round(diff_pct, 2),
        "inconsistencias_estruturais": inconsistencias,
        "ambiguidades_tributo_embutido": ambiguidades_tributo_embutido,
    }


def metrica_gd_aderencia(itens: list[dict], valor_total_fatura: float) -> dict:
    """Metrica especifica pra faturas com GD: ignora RECLAMACAO/CREDITO/INFORMATIVO
    (saldos diferidos, devolucoes pontuais) e mede apenas o "valor cobrado base":
       TUSD + TE + BANDEIRA + TRIBUTO + DEMANDA + ENCARGO + OUTRO + PARCELAMENTO
       - |COMPENSACAO_GD|  ~= valor_total_fatura

    Faturas GD ENEL SP tem 'VALOR A SER CREDITADO NA PROXIMA FATURA' (informativo) que
    distorce soma_liquida. Esta metrica e mais justa pra GD."""
    base_pos = 0.0
    comp_gd = 0.0
    for it in itens:
        try: v = float(it.get("valor", 0) or 0)
        except Exception: continue
        tipo = (it.get("tipo") or "").upper()
        if tipo in _TIPOS_POSITIVOS and v > 0:
            base_pos += v
        elif tipo == "COMPENSACAO_GD":
            comp_gd += v  # ja negativo
    soma = base_pos + comp_gd
    vf = float(valor_total_fatura or 0)
    diff_pct = abs(soma - vf) / max(1.0, vf) * 100
    return {
        "base_pos": round(base_pos, 2),
        "compensacao_gd": round(comp_gd, 2),
        "soma_gd": round(soma, 2),
        "valor_fatura": round(vf, 2),
        "diff_pct": round(diff_pct, 2),
        "bate": diff_pct < 15.0,
    }


def validar_soma_itens(itens: list[dict], valor_total_fatura: float | None,
                        tolerancia_pct: float = 0.15) -> dict:
    """Sanity check: estimativa do valor da fatura a partir dos itens extraidos.

    A relacao itens<->valor_total varia por distribuidora/layout:
    - Faturas SIMPLES (sem creditos): TUSD+TE+BANDEIRA+ENCARGO ~= valor_total
    - Faturas com APCEI/CREDITOS/COMPENSACAO: ha valores diferidos pra proxima fatura,
      deducoes que se cancelam (ACL +X / Dedução ACL -X), etc.

    Estrategia: calcula soma_principal = TUSD + TE + BANDEIRA + ENCARGO + DEMANDA + OUTRO (positivos).
    Esses sao os componentes do "Subtotal Faturamento" que tende a aproximar o valor_total
    (mais ou menos creditos/debitos especificos). NAO incluimos TRIBUTO (embutidos),
    nem CREDITO/DEBITO/APCEI (podem ser diferidos), nem COMPENSACAO_GD.

    bate=True so se houver tolerancia. bate=False so se NAO ha creditos/apcei (faturas complexas
    sao marcadas como 'complexa' em vez de 'bate=False' pra evitar falso negativo).

    Retorna dict com diagnostico detalhado."""
    if not itens or valor_total_fatura is None:
        return {"bate": None, "motivo": "sem_dados"}
    tipos_que_somam = {"TUSD", "TE", "BANDEIRA", "ENCARGO", "DEMANDA", "OUTRO"}
    soma_principal = 0.0
    soma_tributos = 0.0
    soma_creditos = 0.0     # CREDITO/APCEI negativos
    soma_debitos = 0.0      # DEBITO/APCEI positivos extras
    soma_compensacao = 0.0
    tem_complicador = False
    for it in itens:
        v = it.get("valor")
        if v is None: continue
        try: v = float(v)
        except Exception: continue
        tipo = (it.get("tipo") or "").upper()
        if tipo in tipos_que_somam:
            if v > 0: soma_principal += v
        elif tipo == "TRIBUTO":
            soma_tributos += v
        elif tipo == "COMPENSACAO_GD":
            soma_compensacao += v
            tem_complicador = True
        elif tipo == "APCEI":
            if v < 0: soma_creditos += v
            else: soma_debitos += v
            tem_complicador = True
        elif tipo == "CREDITO":
            soma_creditos += v
            tem_complicador = True
        elif tipo == "DEBITO":
            soma_debitos += v
            tem_complicador = True
    # Estimativa 1: faturas simples (sem creditos) — soma_principal ~ valor_total
    valor = float(valor_total_fatura)
    diff = abs(soma_principal - valor)
    diff_pct = diff / max(1, valor)
    bate_simples = diff_pct <= tolerancia_pct
    return {
        "soma_principal": round(soma_principal, 2),
        "soma_tributos": round(soma_tributos, 2),
        "soma_creditos": round(soma_creditos, 2),
        "soma_debitos": round(soma_debitos, 2),
        "soma_compensacao_gd": round(soma_compensacao, 2),
        "valor_fatura": valor,
        "diff_pct": round(diff_pct, 4),
        "tem_complicador": tem_complicador,
        # bate=True: soma bate diretamente; bate='complexa': tem creditos/apcei
        # (extração pode estar OK mesmo com soma diferente); bate=False: diverge sem motivo claro
        "bate": True if bate_simples else ("complexa" if tem_complicador else False),
    }


def _posprocessar_itens(itens: list[dict], distribuidora: str | None = None) -> list[dict]:
    """Pos-processamento v10:
    1. Remove itens invalidos (Fator de Carga, sem valor)
    2. Deduplica (mesma desc+valor)
    3. Normaliza categorias (COSIP -> TRIBUTO)
    4. Marca TRIBUTO_INFORMATIVO em distribuidoras DANF3E (whitelist)
    """
    if not itens:
        return []
    METRICAS_BANIDAS = {"FATOR DE CARGA", "FATOR DE POTENCIA", "FATOR DE POTÊNCIA",
                        "DEMANDA REATIVA INDUTIVA", "DEMANDA REATIVA CAPACITIVA"}

    limpos = []
    seen = set()
    for it in itens:
        desc = (it.get("descricao") or "").strip()
        desc_up = desc.upper()
        # Filtro 1: metricas banidas
        if any(m in desc_up for m in METRICAS_BANIDAS):
            continue

        # FIX: valor=0 com quantidade+tarifa > 0 -> calcular (DEMANDA LEI ESTADUAL etc.)
        # Item aparece com "0,00" na coluna VALOR mas o cliente paga porque
        # tem quant x tarifa real. Recupera o valor cobrado.
        v_raw = it.get("valor")
        q = it.get("quantidade")
        t = it.get("tarifa_unit")
        if (v_raw is None or v_raw == 0) and q is not None and t is not None:
            try:
                qf = float(q); tf = float(t)
                if qf > 0 and tf > 0:
                    valor_calc = round(qf * tf, 2)
                    if valor_calc > 0:
                        it["valor"] = valor_calc
                        it["valor_calculado"] = True   # flag de auditoria
            except Exception:
                pass

        # Filtro 2: sem valor (None ou 0 sem ser credito intencional)
        v = it.get("valor")
        if v is None:
            continue
        try:
            float(v)
        except Exception:
            continue
        # Filtro 3: TOTAL / SUBTOTAL (rodape)
        if desc_up.startswith(("TOTAL", "SUBTOTAL")):
            continue
        # Filtro 4: dedup
        key = (desc_up[:80], round(float(v), 2))
        if key in seen:
            continue
        seen.add(key)

        # Normaliza categorias: COSIP/CIP MUNICIPAL -> TRIBUTO
        tipo = (it.get("tipo") or "OUTRO").upper()
        # Tributos do box DANF3E -> INFORMATIVO (whitelist OU sinal estrutural)
        if _eh_tributo_informativo_danf3e(it, distribuidora):
            tipo = "TRIBUTO_INFORMATIVO"
            it["_motivo_informativo"] = ("danf3e_whitelist"
                if (distribuidora and distribuidora.strip().upper() in _DANF3E_WHITELIST)
                else "danf3e_estrutural")
        elif any(k in desc_up for k in ("COSIP", "CIP MUNICIPAL", "ILUM PUBLICA",
                                       "ILUMINACAO PUBLICA", "CIP-S", "CIP S")):
            tipo = "TRIBUTO"
        # Parcelamento Art.113/323
        elif any(k in desc_up for k in ("PC.", "PARC.ART", "ART.113", "ART.323", "PARCELAMENTO")):
            tipo = "PARCELAMENTO"
        # INFORMATIVO: saldo a usar / valor a creditar proxima fatura (nao impacta VrFt)
        elif any(k in desc_up for k in ("VALOR A SER CREDITADO", "VALOR CREDITAR PROXIMA",
                                          "VALOR A CREDITAR PROXIMA", "SALDO A USAR",
                                          "SALDO ATUAL DE CREDITOS")):
            tipo = "INFORMATIVO"
        # Reclamacao/Devolucao (impacta valor cobrado — geralmente negativo)
        elif any(k in desc_up for k in ("DEVOLUCAO", "DEVOLUÇÃO", "RECLAMACAO",
                                          "RECLAMAÇÃO", "BONUS POR REDUCAO")):
            tipo = "RECLAMACAO"

        it["tipo"] = tipo
        limpos.append(it)
    return limpos


def _modelo_adaptativo(grupo_tarifario: str | None,
                        modalidade_tarifaria: str | None) -> tuple[str, str, int]:
    """Escolhe modelo baseado na complexidade da fatura:
    Grupo A ou Mercado Livre -> macro direto (1 call)
    Grupo B Convencional -> nano 2x + macro fallback
    Retorna (modelo_primario, modelo_fallback, n_calls)."""
    grp = (grupo_tarifario or "").upper().strip()
    mod = (modalidade_tarifaria or "").upper().strip()
    # Grupo A ou modalidade complexa -> macro
    if grp == "A" or mod in ("VERDE", "AZUL"):
        return "gpt-5.4", "gpt-5.4", 1
    # Default: nano 2x + macro fallback (eficiente em B simples)
    return "gpt-5.4-nano", "gpt-5.4", 2


def gravar_itens_cobrados(cur, conn, fatura_id: int, itens: list[dict],
                           origem: str = "camada_4_5") -> int:
    """UPDATE coluna itens_cobrados (JSON) em FATURA_DADOS_EXTRAIDOS.
    Retorna numero de itens gravados."""
    if not itens:
        return 0
    json_str = json.dumps(itens, ensure_ascii=False, default=str)
    try:
        cur.execute(
            "UPDATE FATURA_DADOS_EXTRAIDOS "
            "SET itens_cobrados=%s, itens_extraido_em=NOW() "
            "WHERE id=%s",
            (json_str, fatura_id)
        )
        conn.commit()
        return len(itens)
    except Exception as e:
        print(f"    [erro update itens fatura {fatura_id}: {e}]")
        return 0


def _chamar_modelo_texto(modelo: str, prompt: str, texto: str,
                          max_tokens: int = 6000) -> dict:
    """Chamada texto-only (sem vision). Bem mais barato/rapido."""
    if not _OPENAI_KEY:
        return {"erro": "no api key"}
    body = {
        "model": modelo,
        "messages": [{"role": "user", "content": prompt + "\n\n=== TEXTO DA FATURA ===\n" + texto}],
        "max_completion_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    if modelo.startswith("gpt-5") or modelo.startswith("o"):
        body["service_tier"] = "flex"
    headers = {"Authorization": f"Bearer {_OPENAI_KEY}",
               "Content-Type": "application/json"}
    for tentativa in range(3):
        try:
            r = requests.post(f"{_BASE_URL}/v1/chat/completions",
                              headers=headers, json=body, timeout=120)
            if r.status_code == 200:
                raw = r.json()["choices"][0]["message"]["content"]
                try: return json.loads(raw)
                except json.JSONDecodeError:
                    m = re.search(r"\{[\s\S]+\}", raw)
                    if m:
                        try: return json.loads(m.group(0))
                        except Exception: return {"erro": "parse_error"}
                    return {"erro": "parse_error"}
            if r.status_code in (429, 503):
                time.sleep(min(60, 5 * (2 ** tentativa))); continue
            return {"erro": f"http {r.status_code}", "detalhe": r.text[:200]}
        except requests.exceptions.RequestException:
            time.sleep(3 * (tentativa + 1))
    return {"erro": "network"}


def extrair_itens_de_texto(fatura_id: int, valor_total_fatura: float | None = None,
                            modelo: str = "gpt-5.4-nano", n_calls: int = 2) -> dict:
    """Extracao SEM vision — usa texto_plumber/markdown/ocr ja gravado no banco.

    Estrategia: monta texto consolidado (plumber + markdown + ocr) e chama LLM texto.
    Custo ~10x menor que vision. Latencia ~5x menor.

    Retorna {itens, metadados, confianca, fonte, calls} ou {erro}."""
    conn = mysql.connector.connect(**DB)
    cur = conn.cursor(dictionary=True)
    cur.execute("""SELECT texto_plumber, texto_markdown, texto_ocr, distribuidora
                   FROM FATURA_DADOS_EXTRAIDOS WHERE id=%s""", (fatura_id,))
    row = cur.fetchone()
    cur.close(); conn.close()
    if not row:
        return {"erro": "fatura nao encontrada"}
    distribuidora = row.get("distribuidora")
    # CONSOLIDA os 3 textos (plumber + markdown + ocr) em 1 input.
    # Bench mostrou +6pp acerto vs usar so markdown (mini consegue triangular
    # info entre extratores diferentes).
    partes = []
    if row.get("texto_plumber"):
        partes.append("=== TEXTO PLUMBER ===\n" + str(row["texto_plumber"])[:6000])
    if row.get("texto_markdown"):
        partes.append("=== TEXTO MARKDOWN ===\n" + str(row["texto_markdown"])[:6000])
    if row.get("texto_ocr"):
        partes.append("=== TEXTO OCR ===\n" + str(row["texto_ocr"])[:4000])
    texto = "\n\n".join(partes)
    if not texto or len(texto) < 200:
        return {"erro": "texto vazio ou muito curto", "len": len(texto)}
    # Limite global 16000 (mini processa bem; nano/4.1-mini se perdem)
    if len(texto) > 16000:
        texto = texto[:16000]

    calls = []
    for _ in range(max(1, n_calls)):
        resp = _chamar_modelo_texto(modelo, PROMPT_ITENS_COBRADOS, texto, max_tokens=6000)
        itens = resp.get("itens", []) if isinstance(resp, dict) else []
        meta = resp.get("metadados", {}) if isinstance(resp, dict) else {}
        conf = resp.get("confianca", 0) if isinstance(resp, dict) else 0
        soma_p = sum(float(it.get("valor",0) or 0) for it in itens
                     if (it.get("tipo") or "").upper() in {"TUSD","TE","BANDEIRA","ENCARGO","DEMANDA","OUTRO","PARCELAMENTO","TRIBUTO"} and (it.get("valor",0) or 0) > 0)
        calls.append({"itens": itens, "metadados": meta, "conf": conf,
                      "n": len(itens), "soma_p": round(soma_p, 2)})

    if len(calls) == 1:
        c = calls[0]
        return {"itens": _posprocessar_itens(c["itens"], distribuidora), "metadados": c["metadados"],
                "confianca": c["conf"], "fonte": f"{modelo}-texto", "calls": calls}

    # Self-consistency: escolhe melhor (mais proxima de valor_total)
    melhor = calls[0]
    for c in calls[1:]:
        if valor_total_fatura:
            diff_m = abs(melhor["soma_p"] - float(valor_total_fatura))
            diff_c = abs(c["soma_p"] - float(valor_total_fatura))
            if diff_c < diff_m: melhor = c
        elif c["n"] > melhor["n"]:
            melhor = c
    return {"itens": _posprocessar_itens(melhor["itens"], distribuidora), "metadados": melhor["metadados"],
            "confianca": melhor["conf"], "fonte": f"{modelo}-texto-sc", "calls": calls}


def extrair_itens_cascata(fatura_id: int, link_fatura: str,
                           valor_total_fatura: float | None = None,
                           grupo_tarifario: str | None = None,
                           modalidade_tarifaria: str | None = None,
                           modelo_texto: str = "gpt-5.4-mini",
                           n_calls_texto: int = 2,
                           thr_diff: float = 0.15) -> dict:
    """PIPELINE CASCATA: tenta texto primeiro (barato), vision so se falhar.

    Falha do texto = (a) erro de extracao, (b) 0 itens, (c) soma diverge >thr_diff.

    Retorna {itens, metadados, confianca, fonte, modo_usado}."""
    # Passo 1: TEXTO
    res_t = extrair_itens_de_texto(fatura_id, valor_total_fatura, modelo_texto, n_calls_texto)
    if not res_t.get("erro") and res_t.get("itens"):
        itens = res_t["itens"]
        soma = sum(float(it.get("valor",0) or 0) for it in itens
                   if (it.get("tipo") or "").upper() in {"TUSD","TE","BANDEIRA","ENCARGO","DEMANDA","OUTRO","PARCELAMENTO","TRIBUTO"} and (it.get("valor",0) or 0) > 0)
        if valor_total_fatura:
            diff = abs(soma - float(valor_total_fatura)) / max(1, float(valor_total_fatura))
            if diff <= thr_diff:
                res_t["modo_usado"] = "texto"
                return res_t
        else:
            res_t["modo_usado"] = "texto"
            return res_t
    # Passo 2: FALLBACK VISION (so se texto falhou)
    res_v = extrair_itens_fatura(fatura_id, link_fatura,
                                  valor_total_fatura=valor_total_fatura,
                                  grupo_tarifario=grupo_tarifario,
                                  modalidade_tarifaria=modalidade_tarifaria,
                                  adaptativo=True)
    res_v["modo_usado"] = "vision_fallback"
    res_v["texto_tentativa"] = {"erro": res_t.get("erro"), "soma": res_t.get("calls",[{}])[0].get("soma_p") if res_t.get("calls") else None}
    return res_v


def gravar_metadados_fatura(cur, conn, fatura_id: int, metadados: dict) -> bool:
    """UPDATE coluna metadados_fatura (JSON) em FATURA_DADOS_EXTRAIDOS."""
    if not metadados:
        return False
    json_str = json.dumps(metadados, ensure_ascii=False, default=str)
    try:
        cur.execute(
            "UPDATE FATURA_DADOS_EXTRAIDOS SET metadados_fatura=%s WHERE id=%s",
            (json_str, fatura_id)
        )
        conn.commit()
        return True
    except Exception as e:
        print(f"    [erro update metadados fatura {fatura_id}: {e}]")
        return False


def _extrair_itens_pipeline(ids: list[int], args, out: str):
    """Pipeline dedicado pra extrair itens cobrados de N faturas e gravar em FATURA_ITENS_COBRADOS."""
    conn = mysql.connector.connect(**DB)
    cur = conn.cursor(dictionary=True)
    fmt = ",".join(["%s"] * len(ids))
    cur.execute(f"SELECT id, link_fatura, valor_total_fatura FROM FATURA_DADOS_EXTRAIDOS WHERE id IN ({fmt})", tuple(ids))
    rows = {r["id"]: r for r in cur.fetchall()}
    cur.close()
    cur_apply = conn.cursor() if args.apply else None

    fout = open(out, "w", encoding="utf-8")
    stats = {"ok": 0, "sem_anchor": 0, "erros": 0, "total_itens": 0,
             "aplicados": 0, "soma_bate": 0, "soma_complexa": 0, "soma_diverge": 0}
    t0 = time.time()
    for i, fid in enumerate(ids, 1):
        row = rows.get(fid)
        if not row:
            print(f"  [{i}/{len(ids)}] ID {fid} — nao encontrado"); continue
        res = extrair_itens_fatura(fid, row["link_fatura"],
                                    valor_total_fatura=row.get("valor_total_fatura"),
                                    modelo_primario=args.modelo_itens,
                                    modelo_fallback=args.modelo_fallback_itens,
                                    n_calls=args.n_calls_itens)
        if res.get("erro"):
            print(f"  [{i}/{len(ids)}] ID {fid} — ERRO {res['erro']}")
            stats["erros" if "anchor" not in res["erro"] else "sem_anchor"] += 1
            fout.write(json.dumps({"id": fid, **res}, default=str) + "\n"); fout.flush()
            continue
        itens = res.get("itens", [])
        stats["ok"] += 1
        stats["total_itens"] += len(itens)
        # Sanity check: SUM(itens) ~= valor_total_fatura
        validacao = validar_soma_itens(itens, row.get("valor_total_fatura"))
        if validacao.get("bate") is True: stats["soma_bate"] += 1
        elif validacao.get("bate") == "complexa": stats["soma_complexa"] += 1
        elif validacao.get("bate") is False: stats["soma_diverge"] += 1
        # Apply: grava itens_cobrados + metadados_fatura (so se conf >= threshold)
        conf = res.get('confianca', 0) or 0
        metadados = res.get('metadados', {}) or {}
        if args.apply and itens and cur_apply and conf >= args.conf_min_apply:
            inseridos = gravar_itens_cobrados(cur_apply, conn, fid, itens)
            if metadados:
                gravar_metadados_fatura(cur_apply, conn, fid, metadados)
            stats["aplicados"] += inseridos
            sufix = f" [APPLY OK {inseridos} itens + metadados]"
        elif args.apply and conf < args.conf_min_apply:
            sufix = f" [skip-apply: conf={conf:.2f} < {args.conf_min_apply}]"
        else:
            sufix = f" [DRY-RUN {len(itens)} itens]" if itens else " [0 itens]"
        # marca sanity check no log
        v = validacao
        if v.get("bate") is True:
            check = f" SOMA_OK (diff={v['diff_pct']*100:.1f}%)"
        elif v.get("bate") == "complexa":
            check = f" SOMA_complexa (creditos/apcei)"
        elif v.get("bate") is False:
            check = f" SOMA_DIVERGE (calc={v.get('soma_principal')} vs {v['valor_fatura']}, diff={v['diff_pct']*100:.1f}%)"
        else:
            check = ""
        print(f"  [{i}/{len(ids)}] ID {fid} — extraiu {len(itens)} itens (conf={res.get('confianca', 0):.2f}){check}{sufix}")
        fout.write(json.dumps({"id": fid, "validacao": v, **res}, default=str) + "\n"); fout.flush()
    fout.close()
    if cur_apply: cur_apply.close()
    conn.close()
    dt = time.time() - t0
    print(f"\n=== Sumario itens cobrados ({dt:.0f}s) ===")
    print(f"  Faturas processadas: {stats['ok']}/{len(ids)}")
    print(f"  Total de itens extraidos: {stats['total_itens']}")
    print(f"  Sem anchor: {stats['sem_anchor']}, erros: {stats['erros']}")
    n_validados = stats['soma_bate'] + stats['soma_complexa'] + stats['soma_diverge']
    if n_validados:
        print(f"  Sanity check SOMA: bate={stats['soma_bate']}/{n_validados}, "
              f"complexa={stats['soma_complexa']}/{n_validados}, "
              f"DIVERGE={stats['soma_diverge']}/{n_validados}")
    if args.apply:
        print(f"  APLICADOS no banco: {stats['aplicados']} itens (em {stats['ok']} faturas)")
    print(f"  Custo estimado: ~${stats['ok']*0.04:.2f}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--campo", required=False, choices=list(PROMPTS_POR_CAMPO.keys()),
                   help="Campo a refinar (cofins_valor, pis_valor, etc). Ignorado se --extrair-itens")
    p.add_argument("--extrair-itens", action="store_true",
                   help="Extrai todos os itens cobrados da fatura e grava em FATURA_ITENS_COBRADOS")
    p.add_argument("--ids", nargs="+", type=int,
                   help="IDs ENEL SP a processar (mutuamente exclusivo com --input)")
    p.add_argument("--input",
                   help="JSONL de camada_4 — processa todos os divergentes do campo")
    p.add_argument("--out", default=None)
    p.add_argument("--apply", action="store_true",
                   help="Aplica no banco (UPDATE FATURA_DADOS_EXTRAIDOS) onde self-consistent ou conf>=0.85")
    p.add_argument("--conf-min-apply", type=float, default=0.85,
                   help="Confianca minima pra aplicar quando fonte=tiebreaker (self-consistent sempre aplica)")
    # === DEFAULTS PRODUCAO PARA --extrair-itens ===
    # Variante D venceu o bench: nano 2x self-consistency + gpt-5.4 fallback se discordam.
    # Custo medio: ~$0.005-0.010/fatura (nano resolve 70%, fallback dispara em ~30%).
    p.add_argument("--modelo-itens", default="gpt-5.4-nano",
                   help="Modelo primario pra --extrair-itens (default: gpt-5.4-nano). Aceita lista comma-separated pra cross-model.")
    p.add_argument("--n-calls-itens", type=int, default=2,
                   help="Self-consistency pra --extrair-itens (default 2). Se as calls discordam, dispara fallback.")
    p.add_argument("--modelo-fallback-itens", default="gpt-5.4",
                   help="Modelo de fallback se primario diverge (default: gpt-5.4)")
    args = p.parse_args()

    if not args.ids and not args.input:
        print("[!] passar --ids OU --input"); sys.exit(1)
    if not args.extrair_itens and not args.campo:
        print("[!] passar --campo OU --extrair-itens"); sys.exit(1)

    out = args.out or (f"camada_4_5_itens.jsonl" if args.extrair_itens else f"camada_4_5_{args.campo}.jsonl")

    # Carrega IDs alvo
    ids = []
    bank_valores = {}
    if args.ids:
        ids = args.ids
    elif args.extrair_itens:
        # Extrai itens: aceita JSONL com qualquer 'id' (input livre)
        with open(args.input, encoding="utf-8") as f:
            for line in f:
                try:
                    d = json.loads(line); fid = d.get("id")
                    if fid: ids.append(int(fid))
                except Exception:
                    continue
    else:
        with open(args.input, encoding="utf-8") as f:
            for line in f:
                d = json.loads(line)
                if d.get("skipped"): continue
                if "stats_final" not in d: continue
                for div in d["stats_final"].get("diverge", []):
                    if div["campo"] == args.campo:
                        ids.append(d["id"])
                        bank_valores[d["id"]] = div.get("db")

    # Caminho dedicado pra extracao de itens (tabela auxiliar)
    if args.extrair_itens:
        return _extrair_itens_pipeline(ids, args, out)

    # Banco (link + valor atual pra comparar)
    conn = mysql.connector.connect(**DB)
    cur = conn.cursor(dictionary=True)
    fmt = ",".join(["%s"] * len(ids))
    cur.execute(f"SELECT id, link_fatura, {args.campo} bank FROM FATURA_DADOS_EXTRAIDOS WHERE id IN ({fmt})", tuple(ids))
    rows = {r["id"]: r for r in cur.fetchall()}
    cur.close(); conn.close()

    fout = open(out, "w", encoding="utf-8")
    stats = {"bate": 0, "diverge": 0, "sem_anchor": 0, "erros": 0, "aplicados": 0}
    # Conexao persistente pra apply
    conn_apply = mysql.connector.connect(**DB) if args.apply else None
    cur_apply = conn_apply.cursor() if conn_apply else None
    t0 = time.time()
    for i, fid in enumerate(ids, 1):
        row = rows.get(fid)
        if not row:
            print(f"  [{i}/{len(ids)}] ID {fid} — nao encontrado no banco"); continue
        bank = row["bank"]
        res = extrair_campo(fid, row["link_fatura"], args.campo)
        if res.get("erro"):
            print(f"  [{i}/{len(ids)}] ID {fid} — ERRO {res['erro']}")
            stats["erros"] += 1
        elif res.get("sem_anchor"):
            print(f"  [{i}/{len(ids)}] ID {fid} — sem anchor")
            stats["sem_anchor"] += 1
        else:
            val = res.get("valor")
            try:
                bate = abs(float(val) - float(bank)) < DIFF_TOLERANCIA if val is not None and bank is not None else False
            except Exception:
                bate = False
            stats["bate" if bate else "diverge"] += 1
            # Apply: aplica no banco se self-consistent OU (tiebreaker com conf alta)
            aplicou = False
            if args.apply and val is not None:
                fonte = res.get("fonte", "")
                conf = res.get("confianca", 0) or 0
                ok_self = "self-consistent" in fonte
                ok_tb = "tiebreaker" in fonte and conf >= args.conf_min_apply
                if ok_self or ok_tb:
                    try:
                        cur_apply.execute(
                            f"UPDATE FATURA_DADOS_EXTRAIDOS SET {args.campo}=%s, extracao_revisao_em=NOW() WHERE id=%s",
                            (float(val), fid)
                        )
                        conn_apply.commit()
                        stats["aplicados"] += 1
                        aplicou = True
                    except Exception as e:
                        print(f"    [ERRO apply: {e}]")
            sufix_apply = f" [APPLY OK]" if aplicou else (f" [skip-apply: conf={res.get('confianca')}]" if args.apply else "")
            print(f"  [{i}/{len(ids)}] ID {fid} — bank={bank} val={val} fonte={res.get('fonte')} bate={bate}{sufix_apply}")
        fout.write(json.dumps({"id": fid, "bank": bank, **res}, default=str) + "\n")
        fout.flush()
    fout.close()
    if cur_apply: cur_apply.close()
    if conn_apply: conn_apply.close()
    dt = time.time() - t0

    n = stats["bate"] + stats["diverge"]
    print(f"\n=== Sumario ({dt:.0f}s) ===")
    print(f"  Processados: {n}/{len(ids)}")
    print(f"  Bate: {stats['bate']}/{n} ({stats['bate']/max(1,n)*100:.1f}%)")
    print(f"  Diverge: {stats['diverge']}, sem_anchor: {stats['sem_anchor']}, erros: {stats['erros']}")
    if args.apply:
        print(f"  APLICADOS no banco: {stats['aplicados']}")
    print(f"  Custo estimado: ~${n*0.04:.2f}")


if __name__ == "__main__":
    main()
