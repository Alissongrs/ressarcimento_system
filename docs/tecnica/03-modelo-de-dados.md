# 03 — Modelo de Dados

Dicionário das tabelas principais. **[C]** = confirmado por DDL no repo;
**[I]** = inferido de código/uso (sem DDL versionado). Fonte principal:
`docs/banco-de-dados.md`, `docs/SCHEMA_RESSARCIMENTO.sql` (datado 2026-05-29, já
divergiu da schema viva), structs GORM em `backend/models/` e DDL ad-hoc nos handlers.

> O `SCHEMA_RESSARCIMENTO.sql` é baseline histórico. Colunas como `auditado`,
> `kwh_total`, `rs_kwh_total`, `uc_atual` e as tabelas `DM_STATUS_PROCESSO`/V2 **não**
> constam lá mas são usadas no código atual — confie no código, não no .sql antigo.

## Dois bancos

- **`db_ressarcimento`** (RDS) — tudo abaixo mora aqui, salvo indicação.
- **`sgeeasy_clientes_novo`** (`179.127.27.122`) — **origem** das faturas. Tabelas-fonte
  conhecidas: `Faturas_Registradas_Cache` (energia) e `Faturas_Registradas_Agua_Cache`
  (água). A ponte origem↔FDE é pelo **`uid`**.

---

## Extração de faturas (energia)

### `FATURA_DADOS_EXTRAIDOS` (FDE) — [C]
"Coração do sistema": dados padronizados de cada PDF de fatura, independente da
concessionária (260+ colunas). Alimenta triagem, motor de desvio e views temáticas.

| Coluna | Significado |
|--------|-------------|
| `id` | PK bigint |
| `uid` | chave natural única (SHA; `UNIQUE uk_uid`) — dedup e ponte com a origem |
| `cod_empresa` | código da empresa/cliente (ex. 4=Via Varejo, 2025=VTAL, 14=REZEK) |
| `codigo_uc` | id da UC **na origem sgeeasy** (≠ nº de instalação impresso) |
| `numero_instalacao` | nº de instalação impresso na fatura |
| `mes_referencia` | competência (varchar(10)) |
| `valor_energia_ativa` | R$ da energia ativa (base do cálculo de ressarcimento) |
| `rs_kwh_total` | ⚠️ **TOTAL de energia em R$** (não é tarifa/kWh) |
| `kwh_total` | consumo total em kWh |
| `extraido_em` | datetime de **ingestão** (DEFAULT CURRENT_TIMESTAMP) |
| `atualizado_em` | ON UPDATE |
| `fonte_extracao` | `regex` \| `gpt` \| `ia` |
| `validador_gate` | `aprovado` \| `revisao` \| `reprovado` \| `scaneada` |
| `auditado` | `1` = entra na aba Auditoria (filtrado nos handlers) |
| `historico_consumo_json` / `historico_consumo_12_meses` | histórico do rodapé (JSON) |
| blocos | leituras, demanda, tributos (ICMS/PIS/COFINS, `icms_base_te/tusd` LC194), GD (`energia_injetada_kwh`, `energia_compensada_kwh`), Art.323 (`parcela_art323_*`), acúmulo pós-média (`flag_acumulo_*`), SEFAZ NF3e (`*_sefaz_*`), qualidade (`extracao_score_confianca`, `aritmetica_ok`, `extracao_raw_json`) |

Relações: 1:N → `FATURA_REANALISES`, `EXTRACAO_DIVERGENCIAS` (FK `fatura_id`, CASCADE).
Views de leitura: `vw_fatura_grupo_a`, `vw_fatura_gd`, `vw_fatura_fiscal`,
`vw_fatura_ressarcimento`, `vw_fichas_acumulo`, `vw_fichas_sefaz_divergencia`.

### `FATURA_REANALISES` — [C]
Audit trail de cada reanálise por IA de uma fatura. `fatura_id`→FDE (CASCADE),
`decisao_final`, `ficha_principal`, `fichas_confirmadas` (JSON), `confianca_final`,
`percentual_ressarcimento`, **`recomendacao`** (REJEITADO / SEM ERRO / ERRO CONFIRMADO /
JA_EM_PROCESSO / REFUTADO…), `modelo`, `usuario_id/nome`, `criado_em`.

### `EXTRACAO_DIVERGENCIAS` — [C]
Divergência de valor por campo entre banco × regex × GPT. `campo`,
`valor_banco/extracao/gpt/aplicado`, `origem`, `aplicado`.

---

## Auditoria de energia (snapshot do motor)

### `FATURA_APONTAMENTOS_AUDITADOS` — [C] (DDL em `handlers/auditados_rebuild.go`)
Materialização persistida do motor F01–F05 (página "Auditoria de Faturas"). Reconstruído
por rebuild + **swap atômico** (`RENAME TABLE`) via `cmd/auditados`.

| Coluna | Significado |
|--------|-------------|
| `id` | = `FDE.id` |
| `uid`, `distribuidora`, `cod_empresa`, `razao_social`, `codigo_uc`, `numero_instalacao`, `mes_referencia`, `kwh_total` | identificação |
| `desvio_pct` | desvio percentual máximo apurado |
| **`fichas`** | VARCHAR(64) — fichas aplicadas, concatenadas por vírgula (ex. "F02", "F01,F02") |
| `f02_validacao`, `classificacao_historico` | metadados do F02 |
| `base_ressarcimento`, `base_origem`, `ressarcimento_bruto`, `fator_retencao`, `ressarcimento_estimado` | financeiro (>0 = aparece na aba) |

Rebuild exclui `cod_empresa=14` (REZEK) e `numero_instalacao='BOLETO'`.

---

## Água

### `FATURA_AGUA_DADOS` — [C] (via `worker/jobs/agua_sync.py`)
Faturas de água, sincronizadas da origem `Faturas_Registradas_Agua_Cache`.
**Chave de fatura = (`cod_empresa`, `cod_uc`, `mes_referencia`)**. `id` **não** é
auto_increment (gerado MAX+1). Colunas: `cod_fatura`, `uc`, `apelido`, `concessionaria`,
`cidade`, `uf`, **`consumo_m3`**, `m3_total`, `rs_agua_fat`, `rs_esgoto_fat`,
`rs_total_fat`, `rs_m3`, `link_fatura`, `criado_em`.

### `FATURA_APONTAMENTOS_AGUA_AUDITADOS` — [C] (via `worker/jobs/agua_motor.py`)
Apontamentos do motor de água (ficha **FA02**; aba 💧). Pico = `consumo_m3 ≥ 2× média`
das ≤12 faturas anteriores (mín. 4 de base).

| Coluna | Significado |
|--------|-------------|
| `id`, `cod_empresa`, `cod_uc`, `uc`, `concessionaria`, `mes_referencia` | identificação |
| `consumo_m3` | consumo do mês |
| **`mediana_m3`** | ⚠️ guarda a **MÉDIA** móvel, não a mediana estatística |
| `n_meses` | meses de base |
| `desvio_pct` | `(consumo−média)/média×100` |
| `excedente_m3` | `consumo − média` |
| `ficha` | sempre `"FA02"` |
| `base_rs`, `ressarcimento_estimado` | `= rs_total_fat × (excedente/consumo)` |
| `link_fatura`, `criado_em` | — |

Dedup por (`cod_uc`, `mes_referencia`).

### `FATURA_AGUA_REJEICOES` — [I]
Rejeições/descartes de apontamentos de água (tabela **própria**, sem a FK de energia —
corrige o bug 1452). O handler exclui apontamentos via `NOT EXISTS (… WHERE r.id=a.id)`.

---

## Fluxo: requisição → processo → deferimento → encerramento

> **Relação-chave: `FT_PROCESSOS.id_processo == FT_REQUISICOES.id_requisicao` (1:1).**
> `id_processo` é PK e FK → `id_requisicao`; nasce igual ao `id_requisicao` (não é
> auto_increment).

### `FT_REQUISICOES` — [C]
Triagem/cadastro do pleito. `id_requisicao` PK auto_increment; `id_usuario`,
`id_status` (→domínio de status), `uc`, `cliente`, `razao_social_fatura`,
`concessionaria`, `cnpj`, `numero_protocolo` (UNIQUE), `ressarcimento_estimado`
DECIMAL(15,2), `periodos_irregularidade` (JSON canônico `[{ano,mes}]`),
`descricao_irregularidade`, `link_fatura`, **`processo_criado`** tinyint (vira 1 quando
o processo é criado), `data_criacao`, `id_tipo/subtipo_irregularidade`. 1:N → `FT_ANEXOS`,
`FT_HISTORICO_MOVIMENTACOES`.

### `FT_PROCESSOS` — [C]
Processo formal (card do Kanban). `id_processo` PK (= id_requisicao); `uc`, `uc_atual`;
Kanban/etapa: `id_coluna`, `id_etapa_processo`/`etapa`/`sub_etapa`, `id_responsavel`,
`instancia_deferimento`, `id_status_atual` (V2); `suspenso`, `relevancia`, `data_alerta`,
`data_movimentacao`; financeiro (espelho do deferimento): `ressarcimento_estimado`,
`data_procedencia`, `credito_simples/dobro`, `repasse_simples/dobro`, `score_percentual`.

### `FT_DEFERIMENTOS` — [C]
Decisão (procedência). 1:1 com processo (`id_processo` UNIQUE, FK CASCADE).
`status_analise`, `instancia_deferimento`, `data_procedencia`, `credito_simples/dobro`,
`repasse_simples/dobro`, tipo/subtipo. **O front lê o repasse daqui** (não de FT_PROCESSOS).

### `FT_HISTORICO_MOVIMENTACOES` — [C]
Linha do tempo / **fonte de verdade do status** de cada processo. `id_historico` PK;
`id_requisicao` (= id_processo); `status_anterior/novo`, `etapa_anterior/nova`,
`sub_etapa`, `comentario`, `tipo_movimentacao`, `data_movimentacao`,
`mail_graph_message_id`. (Em V2, `id_status_anterior/novo` + JOIN `DM_STATUS_PROCESSO`.)

### Demais do fluxo — [C]
`FT_ENCERRAMENTO` (encerramento formal, ETAPA 6), `FT_ANEXOS` (PDFs/ofícios/e-mails,
`arquivo_blob`), `FT_FLUXO_RESSARCIMENTO` (devolução ao cliente), `FT_FATURAMENTO`
(NF emitida ao cliente — é daqui que sai a lista de "repasse ao cliente"),
`FT_COMENTARIOS`, `FT_REQUISICOES_FATURAS` (faturas vinculadas à requisição),
`FT_SOLICITACOES` (fila do chat — ver [04](04-fluxo-requisicao-processo.md)),
`FT_EXECUTOR_BACKUP` (log/undo do executor autônomo).

---

## Domínios (`DM_*`)

| Tabela | Valores / papel |
|--------|-----------------|
| `DM_STATUS_REQUISICAO` (física `DM_STATUS`) [I] | `1`=Nova, `2`=Em Análise, `3`=Aprovado, `4`=Rejeitado |
| `DM_STATUS_PROCESSO` [C] | `1`=Em análise, `2`=Em elaboração, `3`=Aguardando retorno, `4`=Pendente, `5`=Suspenso, `6`=Cancelado, `7`=Encerrado |
| `DM_ETAPAS_PROCESSO` [C] | `1`=Reclamação/Distribuidora … `4`=Faturamento, `5`=Repasse, `6`=Encerramento (+ `10`=Concluído, `11`=Indeferido, `12`=Rejeitado, `13`=Suspenso) |
| `DM_STATUS_APROVACAO` [C] | `1`=Deferido, `2`=Indeferido |
| `DM_KANBAN_COLUNAS` [C] | colunas do board (Ativos/Suspensos/Concluídos) |
| `DM_INFORMATIVO` [C] | janelinha "como funciona"/avisos (linha única id=1; `versao` reseta o "não exibir") |
| `DM_META_REPASSE` [C] | meta de repasse (id=1; `meta_mensal`/`meta_anual`) |
| `DM_TIPO_IRREGULARIDADE` / `DM_SUBTIPO_IRREGULARIDADE` [C] | tipos de pleito (subtipo FK→tipo) |
| `DM_PRIORIDADE`, `DM_INSTANCIA_DEFERIMENTO`, `DM_SUBETAPA_PROCESSOS`, `DM_DEPARTAMENTO` [C] | dimensões auxiliares |

### `DM_USUARIO` — [C] (SENSÍVEL)
Usuários/gestores. Colunas: `id_usuario` PK, `nome`, `email`, `senha` (hash — **nunca
exibir**; login é por link mágico), `tipo_conta`/`perfil`, `id_departamento`,
`usuario_ativo`, `ms_oid`/`ms_email` (vínculo Entra). ⚠️ Tratar e-mails/senhas como
dados sensíveis; não despejar.

---

## Outras tabelas confirmadas — [C]
`AGENTE_RECEPCAO_LOG` (log do Agente de Recepção de e-mails órfãos; `dedup_key` sha256),
`PROCESSO_COBRANCA_CACHE` (sugestão de cobrança/SR por processo),
`AI_CHAT_LOG`/`AI_CHAT_SESSIONS`/`AI_CHAT_MESSAGES` (RAG do AISURE),
`FATURA_CLARO_DADOS_EXTRAIDOS` (~695k faturas Claro, pipeline separado),
`FT_MAGIC_LINKS` (tokens de link mágico), `DM_REGRAS`/`DM_REGRAS_BACKUP` (catálogo de 61
fichas editável), `FT_TESTES_REGRA` (fila do botão "Testar").
