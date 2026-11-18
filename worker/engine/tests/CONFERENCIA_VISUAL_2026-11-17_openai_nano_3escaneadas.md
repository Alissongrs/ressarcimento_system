# Conferência visual × extração — 3 faturas

## Por campo (certo / errado / vazio)

| campo | certo | errado | vazio | acerto |
|---|---:|---:|---:|---:|
| distribuidora | 1 | 2 | 0 | 33% |
| codigo_uc | 2 | 1 | 0 | 67% |
| mes_referencia | 3 | 0 | 0 | 100% |
| valor_total_fatura | 0 | 0 | 3 | 0% |
| grupo_tarifario | 3 | 0 | 0 | 100% |
| modalidade_tarifaria | 3 | 0 | 0 | 100% |
| consumo_ativo_fponta_kwh | 0 | 0 | 3 | 0% |
| consumo_ativo_ponta_kwh | 0 | 0 | 3 | 0% |
| kwh_total | 0 | 0 | 2 | 0% |
| leit_ant_ativa_fponta | 0 | 0 | 2 | 0% |
| leit_atu_ativa_fponta | 0 | 0 | 2 | 0% |
| constante_k | 0 | 0 | 2 | 0% |
| numero_medidor | 3 | 0 | 0 | 100% |
| dias_faturados | 3 | 0 | 0 | 100% |
| icms_valor | 0 | 2 | 1 | 0% |
| pis_valor | 0 | 2 | 0 | 0% |
| cofins_valor | 0 | 2 | 0 | 0% |
| demanda_contratada_fponta_kw | 3 | 0 | 0 | 100% |
| demanda_faturada_fponta_kw | 1 | 0 | 0 | 100% |
| data_vencimento | 3 | 0 | 0 | 100% |
| data_emissao_nf | 1 | 1 | 1 | 33% |

## Por fatura

| fatura | layout | gate | score | certos |
|---|---|---|---:|---:|
| R609784_CPFL_PAUL.pdf | CPFL Paulista A4 Verde livre (escaneada borrada, id 609784) | parcial | None | 8/19 |
| R613243_ENEL_SP.pdf | Enel SP A4 Verde mercado livre (escaneada, id 613243) | parcial | None | 7/15 |
| R613308_ENERGISA_SSE.pdf | Energisa Sul-Sudeste A4 Verde mercado livre (escaneada, id 613308) | parcial | None | 11/21 |

## Erros e vazios, por campo (fatura: verdade → extraído)


### distribuidora
- R609784_CPFL_PAUL.pdf: ['CPFL Paulista', 'Companhia Paulista de Força e Luz'] → CPFL Energia
- R613243_ENEL_SP.pdf: ['Eletropaulo', 'Enel Distribuição São Paulo'] → Eletroprometropolitana Eletricidade de São Paulo S.A.

### codigo_uc
- R613243_ENEL_SP.pdf: ['MTE0010312', '200007520436'] → MTE0010312/200007520436

### valor_total_fatura
- R609784_CPFL_PAUL.pdf: 12287.69 → —
- R613243_ENEL_SP.pdf: 12446.19 → —
- R613308_ENERGISA_SSE.pdf: 15071.63 → —

### consumo_ativo_fponta_kwh
- R609784_CPFL_PAUL.pdf: [28253.4936, 27564] → —
- R613243_ENEL_SP.pdf: 26877.732 → —
- R613308_ENERGISA_SSE.pdf: [32947.599999, 32144.0] → —

### consumo_ativo_ponta_kwh
- R609784_CPFL_PAUL.pdf: [3968.8656, 3872] → —
- R613243_ENEL_SP.pdf: 3857.322 → —
- R613308_ENERGISA_SSE.pdf: [4361.907999, 4255.52] → —

### kwh_total
- R613243_ENEL_SP.pdf: 30735.054 → —
- R613308_ENERGISA_SSE.pdf: [37309.51, 36399.52] → —

### leit_ant_ativa_fponta
- R609784_CPFL_PAUL.pdf: 183434 → —
- R613308_ENERGISA_SSE.pdf: 0 → —

### leit_atu_ativa_fponta
- R609784_CPFL_PAUL.pdf: 217869 → —
- R613308_ENERGISA_SSE.pdf: 32143.999999 → —

### constante_k
- R609784_CPFL_PAUL.pdf: 0.8 → —
- R613308_ENERGISA_SSE.pdf: 1 → —

### icms_valor
- R609784_CPFL_PAUL.pdf: 2791.94 → 2031.79
- R613243_ENEL_SP.pdf: 2477.76 → —
- R613308_ENERGISA_SSE.pdf: 3458.19 → 2814.71

### pis_valor
- R609784_CPFL_PAUL.pdf: 85.23 → 58.93
- R613308_ENERGISA_SSE.pdf: 259.94 → 47.94

### cofins_valor
- R609784_CPFL_PAUL.pdf: 387.93 → 271.0
- R613308_ENERGISA_SSE.pdf: 1197.29 → 220.67

### data_emissao_nf
- R609784_CPFL_PAUL.pdf: 2026-10-06 → 2026-06-10
- R613243_ENEL_SP.pdf: 2026-10-02 → —