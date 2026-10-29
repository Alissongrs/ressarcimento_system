# 05 — Motor de Desvio

O "motor de desvio" é o coração analítico: lê as faturas extraídas e **aponta erros**
prováveis de cobrança. Dois motores independentes: **energia** (fichas F01–F05, em Go,
ao vivo) e **água** (ficha FA02, em Python, offline/cron).

## Motor de energia — `handlers/desvio_handler.go` + `handlers/regras_desvio.go`

### Orquestração
- **`motorApontamentos(sqlDB, empresa, gateGold)`** — roda F01–F05 sobre **toda** a
  `FATURA_DADOS_EXTRAIDOS`, em memória. `gateGold` é **ignorado** desde 08/07/2026
  (sem filtro por `validador_gate`).
- **`motorApontamentosCached`** — cache em memória (chave `tabela|empresa|gateGold`,
  **TTL 120s**), single-flight, warmer de fundo a cada 90s. **O mapa devolvido é
  compartilhado entre requests — os callers só LEEM.** Após computar, aplica
  `filtrarPorProcessosExistentes` antes de cachear.
- **Não grava nada** — tudo ao vivo. Varre ~162–177k faturas; recompute frio ~20s.

### Agrupamento por UC — `chaveAgrupamentoUC(inst, uc)`
Resolve `numero_instalacao` sujo ('C', 'CNPJ', CNPJ de 14 díg., strings curtas/longas).
Se o `inst` é suspeito → chave = `uc:<codigo_uc>`; senão → `inst:<inst>`. **Split por
`codigo_uc`**: dentro de um `inst` limpo, se subgrupos têm médias com razão ≥3× → são
UCs distintas → chave vira `inst:X|uc:Y`.

### Consumo do mês (cascata anti-duplicação)
1. Grupo B com `consP>0 && consP==consFP` → usa só `consP` (bug extrator Energisa).
2. senão `kwh_total` (se >0 e ≤ 1e9) direto.
3. senão `consP+consFP`.
Soma `kwh_acumulado_art113` (destrava o pico do acúmulo). Teto de sanidade
`ConsumoMaxKWh = 1e9` (acima = lixo de extração).

### Baseline (média) do F02
Média = **todo o histórico da UC com consumo>0, exceto o próprio mês** (média simples).
Se a base for rasa (`baseMeses < 3`), usa o **histórico impresso** (rodapé) quando
consistente (`historicoConsistente` exige ao menos 1 mês em [0,5×, 2×] do consumo atual);
`mediaExcluindoPiso` remove o valor-piso dominante.

### As 5 fichas — `AvaliarDesvio` (`regras_desvio.go`)

| Ficha | O que detecta | Como (resumo) | Gates / notas |
|-------|---------------|---------------|---------------|
| **F01** | Divergência de fórmula de medição | por posto: `calc=|LeitAtu−LeitAnt|×K`; aponta se `1,5% < div ≤ 50%` | `div>50%` = leitura corrompida (extração), não erro. **Zera** se `SefazConfirmaConsumo` ou `ContaConsumoCoerente` (postos somam kwh_total, tol 2%) |
| **F02** | Desvio anormal de consumo | `desvioPct=(atual−média)/média`; ≥2,0 = PICO_OUTLIER, ≥1,0 = DESVIO_ALTO | só dispara acima, com `BaseMeses≥3`. **Validação FORWARD**: olha até 3 faturas seguintes; se a média delas ≥ (média+atual)/2 → é novo patamar → **não aponta** (`ATIVACAO`) |
| **F03** | *(removida 08/06/2026 — ~94% falso-positivo)* | — | substituída por F03B |
| **F03B** | Faturamento por média (piso antes de pico) | sequência ≥10 meses no mesmo piso (100/50/30 kWh) imediatamente antes de um pico F02 | dois caminhos: clássico e "leitura-confirmado" (medidor parado → catch-up) |
| **F04** | Troca de medidor + desvio | `trocouMedidor` **E** desvio efetivo (mesmo do F02) | coexiste com F02 |
| **F05** | Quebra de continuidade de leitura | mesmo medidor, meses consecutivos, `quebraContinuidade` | **gate de confiabilidade**: ambas as leituras fecham a própria fórmula (tol 5%). 83% dos F05 antigos eram leitura mal-extraída |

Constantes relevantes: `F02AltoPct=1.00`, `F02PicoPct=2.00`, `F02MinKWh=50`,
`F02BaseMin=3`, `F02JanelaM=12`.

### Saída — `ResultadoDesvio`
`F01..F05, F03B bool`; `QtdRegras`; **`FichasAplicadas []string`** (ordem F01,F02,F03B,
F04,F05); **`DesvioPctMax float64`** (`= round1(desvioPct*100)`); `ClasseDesvio`,
`F02Validacao`, `ClassificacaoHistorico` (advisory: ELEVADO_REAL / DENTRO_DO_HISTORICO /
SAZONAL / CRESCENTE — rótulo, não remove), `Detalhamento`, `LeituraSuspeita`.
- **Art.113 / parcelamento**: se `flag_acumulo_art113==1`, **sempre aponta** (força F02).
- Entra no resultado se `art113==1` **ou** `QtdRegras>0`.

### Fórmula do dinheiro (`auditados_rebuild.go`; idêntica em `relatorio_auditoria.go`)
```
base = valor_energia_ativa  (se > 0)
     = rs_kwh_total         (senão)
d    = desvio_pct_max / 100
est  = round2( base × d/(1+d) )     # só se base>0 e d>0
```
`auditadosFator = 0.58` é gravado em `fator_retencao` mas **não** multiplica o
`ressarcimento_estimado` (retenção entra só no total). Linhas com `est ≤ 0` são excluídas.

## Filtro de processo existente — `filtro_processo_existente.go`

- **`filtrarPorProcessosExistentes(sqlDB, res)`** retorna um **NOVO mapa** — **não muta**
  `res`. Se cobertura vazia/erro, devolve `res` intacto.
- `carregarProcessosCobertos` lê `FT_PROCESSOS` (uc, uc_atual) + `FT_REQUISICOES` (uc).
  **Regra vigente: dedup por UC, independente do mês.**
- **`normalizarUC(s)`** = só dígitos (ex. "015.139.018-09" ≈ "701513901809").
- O filtro testa **ambos** `numero_instalacao` e `codigo_uc`; remove o apontamento se
  qualquer um já é processo.

## Motor de água — `worker/jobs/agua_motor.py` (também em `C:\claro_bf\agua_motor.py`)

Ficha **FA02**. Constantes: `JAN=12` (janela), `BASE_MIN=4`, `THRESH=100.0` (%).

```
ant  = consumos dos meses anteriores com consumo>0, últimos ≤12
if len(ant) < 4: pula                      # base rasa
med  = média(ant)                          # ⚠️ coluna 'mediana_m3' guarda a MÉDIA
desv = (consumo − med) / med × 100
if desv < 100: pula                        # exige consumo ≥ 2× média
exced = consumo − med
ress  = round2( rs_total_fat × (exced/consumo) )
```
Fonte: faturas novas (`criado_em>=hoje AND consumo_m3>0`). Dedup por
(`cod_uc`, `mes_referencia`). Modos `test`/`dry`/`apply` (INSERT em
`FATURA_APONTAMENTOS_AGUA_AUDITADOS`, id sequencial MAX+1).

> ⚠️ `agua_motor.py` tem **credencial RDS hardcoded** (dívida de segurança — ver
> [09](09-seguranca-e-pendencias.md)). O `agua_sync.py` lê do `.env` corretamente.

### Sync de água — `worker/jobs/agua_sync.py`
Sync **banco→banco** (origem `sgeeasy…Faturas_Registradas_Agua_Cache` →
`FATURA_AGUA_DADOS`). **Não** é o pdf_pipeline. INSERT aditivo só de faturas novas;
dedup por (`cod_empresa`, `cod_uc`, `mes_referencia`). Só empresas na lista `EMPRESAS` e
só `Cod_Fatura IS NOT NULL`. Backup reversível das chaves em JSON antes do apply.
**Depois do sync, sempre rodar o `agua_motor.py apply`** para gerar os apontamentos.

## Como os resultados chegam ao front

### Energia
- **`motor=1`** (query param) em `GET /api/v1/faturas/fde-analise`
  (`analise_desvio_handler.go`) → chama `motorApontamentosCached`, restringe a lista aos
  ids apontados e sintetiza `fichas_confirmadas`/`detalhamento_motor` por id.
- **Snapshot `FATURA_APONTAMENTOS_AUDITADOS`** = materialização persistida do motor +
  fórmula do dinheiro. Reconstruído por `RebuildAuditados` (roda o motor 1×, lê FDE
  `auditado=1`, exclui REZEK/Boleto/REJEITADO, monta em staging + `RENAME` atômico). A aba
  "Auditoria" faz `LEFT JOIN` nesse snapshot para o ressarcimento canônico.
- `triagem=1` = aba Inconclusivos (motor apontou, fora de Auditados).

### Água
- **Snapshot `FATURA_APONTAMENTOS_AGUA_AUDITADOS`** (gravado pelo `agua_motor.py`) é lido
  por `handlers/agua_handler.go` → serve a aba 💧. Aqui o motor (Python, cron) **persiste
  direto** no snapshot, em vez de rodar ao vivo como o de energia.
