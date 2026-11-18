# Conferência visual × extração — 7 faturas

## Por campo (certo / errado / vazio)

| campo | certo | errado | vazio | acerto |
|---|---:|---:|---:|---:|
| distribuidora | 7 | 0 | 0 | 100% |
| codigo_uc | 5 | 2 | 0 | 71% |
| mes_referencia | 7 | 0 | 0 | 100% |
| valor_total_fatura | 6 | 0 | 1 | 86% |
| grupo_tarifario | 6 | 0 | 1 | 86% |
| modalidade_tarifaria | 6 | 1 | 0 | 86% |
| consumo_ativo_fponta_kwh | 4 | 0 | 3 | 57% |
| consumo_ativo_ponta_kwh | 2 | 0 | 2 | 50% |
| kwh_total | 4 | 0 | 2 | 67% |
| leit_ant_ativa_fponta | 4 | 0 | 2 | 67% |
| leit_atu_ativa_fponta | 4 | 0 | 2 | 67% |
| constante_k | 5 | 0 | 1 | 83% |
| numero_medidor | 7 | 0 | 0 | 100% |
| dias_faturados | 7 | 0 | 0 | 100% |
| icms_valor | 6 | 0 | 1 | 86% |
| pis_valor | 6 | 0 | 0 | 100% |
| cofins_valor | 6 | 0 | 0 | 100% |
| demanda_contratada_fponta_kw | 0 | 0 | 4 | 0% |
| demanda_faturada_fponta_kw | 0 | 0 | 2 | 0% |
| data_vencimento | 7 | 0 | 0 | 100% |
| data_emissao_nf | 2 | 1 | 4 | 29% |

## Por fatura

| fatura | layout | gate | score | certos |
|---|---|---|---:|---:|
| R606344_COELBA.pdf | Neoenergia Coelba A4 Azul poder público (escaneada, id 606344) | reprovado | 58.0 | 17/21 |
| R609784_CPFL_PAUL.pdf | CPFL Paulista A4 Verde livre (escaneada borrada, id 609784) | reprovado | 69.7 | 12/19 |
| R609871_ENEL_CE.pdf | Enel Ceará B3 (escaneada, 2ª via, id 609871) | reprovado | 66.0 | 16/18 |
| R612181_BRASILIA.pdf | Neoenergia Brasília B3 (escaneada, total zero por devolução, id 612181) | reprovado | 59.7 | 15/18 |
| R612203_EQ_MA.pdf | Equatorial Maranhão B3 (escaneada amassada, 2ª via, id 612203) | reprovado | 61.3 | 17/18 |
| R613243_ENEL_SP.pdf | Enel SP A4 Verde mercado livre (escaneada, id 613243) | reprovado | 63.0 | 9/15 |
| R613308_ENERGISA_SSE.pdf | Energisa Sul-Sudeste A4 Verde mercado livre (escaneada, id 613308) | aprovado | 91.0 | 15/21 |

## Erros e vazios, por campo (fatura: verdade → extraído)


### codigo_uc
- R609871_ENEL_CE.pdf: ['9588042', '62053637'] → 9588042/62053637
- R613243_ENEL_SP.pdf: ['MTE0010312', '200007520436'] → 200007520436 - AGG

### valor_total_fatura
- R612181_BRASILIA.pdf: [0.0, 767.66] → —

### grupo_tarifario
- R612181_BRASILIA.pdf: B → —

### modalidade_tarifaria
- R606344_COELBA.pdf: Azul → Convencional Monômia

### consumo_ativo_fponta_kwh
- R609784_CPFL_PAUL.pdf: [28253.4936, 27564] → —
- R613243_ENEL_SP.pdf: 26877.732 → —
- R613308_ENERGISA_SSE.pdf: [32947.599999, 32144.0] → —

### consumo_ativo_ponta_kwh
- R609784_CPFL_PAUL.pdf: [3968.8656, 3872] → —
- R613243_ENEL_SP.pdf: 3857.322 → —

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

### icms_valor
- R613243_ENEL_SP.pdf: 2477.76 → —

### demanda_contratada_fponta_kw
- R606344_COELBA.pdf: 1116.0 → —
- R609784_CPFL_PAUL.pdf: 90.0 → —
- R613243_ENEL_SP.pdf: 149.0 → —
- R613308_ENERGISA_SSE.pdf: 110.0 → —

### demanda_faturada_fponta_kw
- R606344_COELBA.pdf: 1116.0 → —
- R613308_ENERGISA_SSE.pdf: [117.42, 110.0] → —

### data_emissao_nf
- R606344_COELBA.pdf: 2026-09-28 → —
- R609784_CPFL_PAUL.pdf: 2026-10-06 → —
- R609871_ENEL_CE.pdf: 2026-10-13 → 2026-10-20
- R612181_BRASILIA.pdf: 2026-09-03 → —
- R612203_EQ_MA.pdf: 2026-10-20 → —