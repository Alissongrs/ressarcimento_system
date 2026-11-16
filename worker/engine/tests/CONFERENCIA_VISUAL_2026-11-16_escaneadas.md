# Conferência visual × extração — 7 faturas

## Por campo (certo / errado / vazio)

| campo | certo | errado | vazio | acerto |
|---|---:|---:|---:|---:|
| distribuidora | 7 | 0 | 0 | 100% |
| codigo_uc | 7 | 0 | 0 | 100% |
| mes_referencia | 7 | 0 | 0 | 100% |
| valor_total_fatura | 6 | 0 | 1 | 86% |
| grupo_tarifario | 7 | 0 | 0 | 100% |
| modalidade_tarifaria | 7 | 0 | 0 | 100% |
| consumo_ativo_fponta_kwh | 7 | 0 | 0 | 100% |
| consumo_ativo_ponta_kwh | 4 | 0 | 0 | 100% |
| kwh_total | 6 | 0 | 0 | 100% |
| leit_ant_ativa_fponta | 6 | 0 | 0 | 100% |
| leit_atu_ativa_fponta | 6 | 0 | 0 | 100% |
| constante_k | 6 | 0 | 0 | 100% |
| numero_medidor | 7 | 0 | 0 | 100% |
| dias_faturados | 7 | 0 | 0 | 100% |
| icms_valor | 7 | 0 | 0 | 100% |
| pis_valor | 6 | 0 | 0 | 100% |
| cofins_valor | 6 | 0 | 0 | 100% |
| demanda_contratada_fponta_kw | 4 | 0 | 0 | 100% |
| demanda_faturada_fponta_kw | 2 | 0 | 0 | 100% |
| data_vencimento | 7 | 0 | 0 | 100% |
| data_emissao_nf | 7 | 0 | 0 | 100% |

## Por fatura

| fatura | layout | gate | score | certos |
|---|---|---|---:|---:|
| R606344_COELBA.pdf | Neoenergia Coelba A4 Azul poder público (escaneada, id 606344) | ok | None | 21/21 |
| R609784_CPFL_PAUL.pdf | CPFL Paulista A4 Verde livre (escaneada borrada, id 609784) | ok | None | 19/19 |
| R609871_ENEL_CE.pdf | Enel Ceará B3 (escaneada, 2ª via, id 609871) | ok | None | 18/18 |
| R612181_BRASILIA.pdf | Neoenergia Brasília B3 (escaneada, total zero por devolução, id 612181) | ok | None | 17/18 |
| R612203_EQ_MA.pdf | Equatorial Maranhão B3 (escaneada amassada, 2ª via, id 612203) | ok | None | 18/18 |
| R613243_ENEL_SP.pdf | Enel SP A4 Verde mercado livre (escaneada, id 613243) | ok | None | 15/15 |
| R613308_ENERGISA_SSE.pdf | Energisa Sul-Sudeste A4 Verde mercado livre (escaneada, id 613308) | ok | None | 21/21 |

## Erros e vazios, por campo (fatura: verdade → extraído)


### valor_total_fatura
- R612181_BRASILIA.pdf: [0.0, 767.66] → —