# Conferência visual × extração — 3 faturas

## Por campo (certo / errado / vazio)

| campo | certo | errado | vazio | acerto |
|---|---:|---:|---:|---:|
| distribuidora | 3 | 0 | 0 | 100% |
| codigo_uc | 2 | 1 | 0 | 67% |
| mes_referencia | 3 | 0 | 0 | 100% |
| valor_total_fatura | 0 | 0 | 3 | 0% |
| grupo_tarifario | 3 | 0 | 0 | 100% |
| modalidade_tarifaria | 3 | 0 | 0 | 100% |
| consumo_ativo_fponta_kwh | 1 | 0 | 2 | 33% |
| consumo_ativo_ponta_kwh | 1 | 0 | 2 | 33% |
| kwh_total | 1 | 0 | 1 | 50% |
| leit_ant_ativa_fponta | 1 | 0 | 1 | 50% |
| leit_atu_ativa_fponta | 1 | 0 | 1 | 50% |
| constante_k | 1 | 0 | 1 | 50% |
| numero_medidor | 2 | 1 | 0 | 67% |
| dias_faturados | 3 | 0 | 0 | 100% |
| icms_valor | 3 | 0 | 0 | 100% |
| pis_valor | 1 | 1 | 0 | 50% |
| cofins_valor | 1 | 1 | 0 | 50% |
| demanda_contratada_fponta_kw | 1 | 0 | 2 | 33% |
| demanda_faturada_fponta_kw | 1 | 0 | 0 | 100% |
| data_vencimento | 3 | 0 | 0 | 100% |
| data_emissao_nf | 3 | 0 | 0 | 100% |

## Por fatura

| fatura | layout | gate | score | certos |
|---|---|---|---:|---:|
| R609784_CPFL_PAUL.pdf | CPFL Paulista A4 Verde livre (escaneada borrada, id 609784) | parcial | None | 10/19 |
| R613243_ENEL_SP.pdf | Enel SP A4 Verde mercado livre (escaneada, id 613243) | parcial | None | 8/15 |
| R613308_ENERGISA_SSE.pdf | Energisa Sul-Sudeste A4 Verde mercado livre (escaneada, id 613308) | ok | None | 20/21 |

## Erros e vazios, por campo (fatura: verdade → extraído)


### codigo_uc
- R613243_ENEL_SP.pdf: ['MTE0010312', '200007520436'] → MTE0010312/200007520436

### valor_total_fatura
- R609784_CPFL_PAUL.pdf: 12287.69 → —
- R613243_ENEL_SP.pdf: 12446.19 → —
- R613308_ENERGISA_SSE.pdf: 15071.63 → —

### consumo_ativo_fponta_kwh
- R609784_CPFL_PAUL.pdf: [28253.4936, 27564] → —
- R613243_ENEL_SP.pdf: 26877.732 → —

### consumo_ativo_ponta_kwh
- R609784_CPFL_PAUL.pdf: [3968.8656, 3872] → —
- R613243_ENEL_SP.pdf: 3857.322 → —

### kwh_total
- R613243_ENEL_SP.pdf: 30735.054 → —

### leit_ant_ativa_fponta
- R609784_CPFL_PAUL.pdf: 183434 → —

### leit_atu_ativa_fponta
- R609784_CPFL_PAUL.pdf: 217869 → —

### constante_k
- R609784_CPFL_PAUL.pdf: 0.8 → —

### numero_medidor
- R613243_ENEL_SP.pdf: 13233351 → 13223351

### pis_valor
- R609784_CPFL_PAUL.pdf: 85.23 → 0.67

### cofins_valor
- R609784_CPFL_PAUL.pdf: 387.93 → 3.05

### demanda_contratada_fponta_kw
- R609784_CPFL_PAUL.pdf: 90.0 → —
- R613243_ENEL_SP.pdf: 149.0 → —