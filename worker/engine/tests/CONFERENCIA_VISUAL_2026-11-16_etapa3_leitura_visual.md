# Conferência visual × extração — 11 faturas

## Por campo (certo / errado / vazio)

| campo | certo | errado | vazio | acerto |
|---|---:|---:|---:|---:|
| distribuidora | 10 | 0 | 0 | 100% |
| codigo_uc | 10 | 0 | 0 | 100% |
| mes_referencia | 10 | 0 | 1 | 91% |
| valor_total_fatura | 9 | 0 | 2 | 82% |
| grupo_tarifario | 10 | 0 | 0 | 100% |
| modalidade_tarifaria | 8 | 0 | 1 | 89% |
| consumo_ativo_fponta_kwh | 7 | 0 | 2 | 78% |
| consumo_ativo_ponta_kwh | 4 | 0 | 1 | 80% |
| kwh_total | 7 | 0 | 4 | 64% |
| leit_ant_ativa_fponta | 7 | 0 | 1 | 88% |
| leit_atu_ativa_fponta | 7 | 0 | 1 | 88% |
| constante_k | 7 | 0 | 0 | 100% |
| numero_medidor | 8 | 0 | 0 | 100% |
| dias_faturados | 9 | 0 | 0 | 100% |
| icms_valor | 7 | 0 | 1 | 88% |
| pis_valor | 7 | 0 | 2 | 78% |
| cofins_valor | 7 | 0 | 2 | 78% |
| demanda_contratada_fponta_kw | 5 | 0 | 0 | 100% |
| demanda_faturada_fponta_kw | 3 | 1 | 0 | 75% |
| data_vencimento | 10 | 0 | 1 | 91% |
| data_emissao_nf | 10 | 0 | 1 | 91% |

## Por fatura

| fatura | layout | gate | score | certos |
|---|---|---|---:|---:|
| A_18643251.pdf | CPFL Paulista A4 Verde | ok | None | 20/21 |
| A_18645280.pdf | CEMIG A4 THS Verde | ok | None | 21/21 |
| A_18649884.pdf | Amazonas Energia A4 | ok | None | 15/18 |
| A_18869867.pdf | Rateio de condomínio (boleto Itaú) — NÃO é fatura de distribuidora | outro | None | 0/5 |
| B3_18647141.pdf | Celesc B3 Convencional (fatura zerada por compensação) | ok | None | 18/18 |
| B3_18650495.pdf | Neoenergia Brasília B3 Convencional | ok | None | 12/16 |
| GD_18644914.pdf | Equatorial Goiás B3 com GD | ok | None | 18/18 |
| GD_18651470.pdf | Elektro B com GD (layout verde) | ok | None | 14/18 |
| ML_18640885.pdf | Coelba A4 Verde mercado livre | ok | None | 15/18 |
| ML_18652038.pdf | CPFL Santa Cruz nota ACL (6 páginas) | ok | None | 8/9 |
| RURAL_18834619.pdf | Energisa MT A4 Verde rural com GD | ok | None | 21/21 |

## Erros e vazios, por campo (fatura: verdade → extraído)


### mes_referencia
- A_18869867.pdf: 2025-07 → —

### valor_total_fatura
- A_18649884.pdf: 10382.98 → —
- A_18869867.pdf: 7154.33 → —

### modalidade_tarifaria
- GD_18651470.pdf: Convencional → —

### consumo_ativo_fponta_kwh
- B3_18650495.pdf: [100, 0] → —
- ML_18640885.pdf: 4364.05 → —

### consumo_ativo_ponta_kwh
- ML_18640885.pdf: 724.92 → —

### kwh_total
- A_18869867.pdf: 15641 → —
- B3_18650495.pdf: [100, 0] → —
- ML_18640885.pdf: 5088.97 → —
- ML_18652038.pdf: 4727.96 → —

### leit_ant_ativa_fponta
- B3_18650495.pdf: 0 → —

### leit_atu_ativa_fponta
- B3_18650495.pdf: 0 → —

### icms_valor
- GD_18651470.pdf: 251.75 → —

### pis_valor
- A_18649884.pdf: 6.09 → —
- GD_18651470.pdf: 0.61 → —

### cofins_valor
- A_18649884.pdf: 49.74 → —
- GD_18651470.pdf: 2.85 → —

### demanda_faturada_fponta_kw
- A_18643251.pdf: 13.53 → 16.47

### data_vencimento
- A_18869867.pdf: 2025-09-15 → —

### data_emissao_nf
- A_18869867.pdf: 2025-08-26 → —