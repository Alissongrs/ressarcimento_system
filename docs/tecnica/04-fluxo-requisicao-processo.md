# 04 — Fluxo: Requisição → Processo → Ressarcimento

Ciclo de vida do pleito, do apontamento ao ressarcimento ao cliente. Invariante central:
**`id_requisicao == id_processo`** (a linha de `FT_PROCESSOS` nasce com
`id_processo = r.id_requisicao`).

```
Apontamento (motor/auditoria)
      │ gestor cria
      ▼
FT_REQUISICOES (id_status=1 "Nova")
      │ 1. Aprovar  → id_status=3 (NÃO cria processo)
      │ 2. Criar processo (movimentar)
      ▼
FT_PROCESSOS (etapa=1, status=3)   ── histórico em FT_HISTORICO_MOVIMENTACOES
      │ movimentações (Kanban)
      ▼
Deferimento (FT_DEFERIMENTOS) → Repasse (derivado) → Encerramento (FT_ENCERRAMENTO)
      │
      ▼
Faturamento ao cliente (FT_FATURAMENTO / FT_FLUXO_RESSARCIMENTO)
```

## 1. Criação da requisição — `handlers/requisicao_handler.go`

Handler real: **`createRequisicaoPersistente`** (alias `CreateRequisicaoPersist`;
os `CreateRequisicao`/`CreateRequisicaoSimple` legados **não** persistem).

Payload (`CreateRequisicaoPayload`): `uc`, `cliente`, `concessionaria`, `cnpj`,
`ressarcimentoEstimado`, `descricaoIrregularidade`, `periodosIrregularidade`
(JSON `[{mes,ano}]`), `linkFatura`, `anexos[]`, etc. Comportamento:

- **Nome do cliente vem do banco**: se vier um `cod_cliente/cod_empresa`, resolve
  `Tab_Empresa.Rz_Social` (o texto postado não é a fonte da verdade).
- `resolveUCInstalacao(uc)` — salvaguarda: se o `uc` enviado for na verdade o
  `codigo_uc` interno, troca pelo `numero_instalacao` real (só quando o mapa é único).
- `periodos` normalizados via `periodosnorm.Normalizar` → canônico `[{ano,mes}]`.
- **Fallback de link**: se o front não mandar link, busca `link_fatura` na FDE por
  `numero_instalacao`+`mes_referencia` (pulado para água / fichas `FA`).
- Validações: uc, cliente, concessionaria, descrição, períodos, `ressarcimento>0`.
- **INSERT `FT_REQUISICOES`** com `id_status=1` (Nova), `data_criacao=NOW()`.
- **Não cria `FT_PROCESSOS` aqui** (só na aprovação/criação de processo).
- Faturas vinculadas vão para `FT_REQUISICOES_FATURAS`.
- **`anexarFaturasDaRequisicao`** roda em goroutine: baixa os PDFs (fatura apontada +
  faturas dos períodos), valida *magic bytes* `%PDF` (rejeita HTML de portal), deduplica
  e insere em `FT_ANEXOS` (`enviado_por='gestor'`, `arquivo_blob`). Dispara cálculo de
  score em background.

Destaques visuais nas listagens: `LIKE '%[RECUP-ABERTO%'` → card laranja;
`id_usuario=1` (Alisson) → card dourado.

## 2. Status

- **DM_STATUS_REQUISICAO** (`FT_REQUISICOES.id_status`): `1`=Nova, `2`=Em Análise,
  `3`=Aprovado, `4`=Rejeitado. (Mapeamento confirmado por uso; nomes resolvidos por
  `.nome` no banco.)
- **DM_STATUS_PROCESSO** (`FT_PROCESSOS.id_status_atual`): `1`=Em análise … `7`=Encerrado
  (mapa canônico em `procedit/procedit.go`). Domínio distinto das **DM_ETAPAS** (1–6:
  Reclamação, Contestação, Conciliação, Faturamento, Repasse, Encerramento) e
  **DM_STATUS_APROVACAO** (1=Deferido, 2=Indeferido).

## 3. Aprovação em 2 passos — `UpdateRequisicaoCompleta`

Rota `POST /api/requisicoes/:id/update`.

- **Passo 1 — Aprovar:** só muda `id_status` da requisição (e `data_mudanca_status`).
  Comentário explícito: *"V2: aprovar NÃO cria mais o processo… nenhuma linha em
  FT_PROCESSOS é criada aqui."* Guardas: exige Tipo+Subtipo antes de sair de "Nova";
  movimentação atrasada exige justificativa.
- **Passo 2 — Criar processo:** front → `POST /api/v2/processos/:id/movimentar` →
  `v2.Movimentar`. Quando não existe snapshot (sem `FT_PROCESSOS`), chama
  **`criarProcessoDeRequisicao`**: `INSERT FT_PROCESSOS SELECT FROM FT_REQUISICOES` com
  `id_processo=id_requisicao`, estado inicial `etapa=1, status=3`; gera `codigo_publico`
  (`PR-<ano>-<id6>`) e resolve `cod_empresa` por nome do cliente.

## 4. Processos, movimentações, deferimento, encerramento (`handlers/v2/`)

Rotas base `/api/v2` (`routes_v2.go`): `GET /processos`, `/processos/:id` +
`/historico /anexos /deferimento /faturamento /repasse /encerramento`; `POST
/processos/:id/movimentar`, `/deferimento`, `/faturamento`, `/repasse`, `/encerramento`;
`PUT /processos/:id/full`; `PATCH /processos/:id/relevancia`; `/metas/deferimento`.

### Movimentação — invariante histórico+processo juntos
`MovimentarCore`/`MovimentarCoreHist` (`handlers/v2/movimentar.go`) é o **núcleo único**
(usado pelo HTTP e pelo executor autônomo). Numa **transação**: valida a transição
(adjacência / Conciliação / Encerramento exige aprovação), **INSERT** da linha de→para
no histórico (snapshot anterior + nova etapa/instância/status/aprovação), insere canais
(N:N), e **UPDATE** de `FT_PROCESSOS.*_atual`.
**Histórico e processo são gravados juntos para nunca dessincronizar.**

### Deferimento / Repasse — `SalvarDeferimento` (`handlers/v2/writes.go`)
`POST /processos/:id/deferimento`. Grava `FT_DEFERIMENTOS` (UNIQUE id_processo → 1 linha)
e espelha em `FT_PROCESSOS`.

> ⚠️ **COALESCE só-NULL:** o UPSERT usa `col = COALESCE(VALUES(col), col)`. Isso
> **preserva** o valor existente quando o campo vem omitido/nil — essencial para não
> apagar a marcação "Deferido" vinda do movimentar. **Efeito colateral:** você
> **não consegue limpar um campo para NULL** por esse caminho (campo omitido = no-op).
> Mandar um valor novo funciona normalmente.

**Repasse é derivado no backend:** `recomputeRepasse` recalcula
`repasse_simples/dobro = crédito × percentual` (override no processo ou
`DM_EMPRESA_PERCENTUAL` na data da procedência). O front manda só o crédito.
A listagem "repasse ao cliente" (`GetRepasses`) na verdade lê **`FT_FATURAMENTO`**
(data_pagamento, valor, numero_nf) — uma linha por NF.

### Encerramento
`SalvarEncerramento` (`POST /processos/:id/encerramento`) grava `FT_ENCERRAMENTO`
(`data_encerramento`, `motivo`, `id_aprovacao_final`, `parecer_final`). Há também um
caminho legado em `handlers/processo_handler.go` (v1, 2558 linhas).

## 5. Solicitações / Assistente (chat) {#solicitações--assistente}

`handlers/solicitacoes.go`, tabela **`FT_SOLICITACOES`** (status: pendente / revisao /
aprovado / preciso_confirmar / executado / erro / revertido).

- **`CriarSolicitacao`** (`POST /api/v1/solicitacoes`): chama `procedit.Montar` para
  transformar o texto livre em `acao_json` + preview, depois **gating**:
  - `EhLeitura(msg, acao)` → consulta/relatório ignora aprovação de gestor;
  - **`podeAlterar(c)`** = papel/`userTipoConta` ∈ {gestor, admin}. Solicitante é
    read-only; pedido de escrita de não-gestor → **403 na origem**;
  - relatório de leitura com ação → `aprovado` na hora; leitura em texto livre →
    `revisao` (o worker avalia custo); escrita → `pendente`; pedido do próprio
    aprovador (`ehAprovador`, env `SOLIC_APROVADORES`, default "1"=Alisson) → auto-aprova.
- Outros: `AprovarSolicitacao`, `RejeitarSolicitacao`, `ResultadoSolicitacao` (executor
  marca executado/erro/preciso_confirmar), `CorrigirSolicitacao`/`ResponderConfirmacao`
  (round-trip), `FeedbackSolicitacao`, `ExportarSolicitacao` (excel/pdf/word/txt),
  **`ReverterSolicitacao`** (desfaz via `FT_EXECUTOR_BACKUP`, limitado a
  `solTabelasReversiveis`).

### Pacote `procedit` — texto livre → ação determinística
`procedit/procedit.go` (o "mix A+B"): o texto vira uma `Acao` estruturada, aplicada
deterministicamente ("aprovou = feito", não reinterpretada na execução).

- **`EhComando(msg)`** — distingue comando (editar/relatório/mover etapa) de pergunta (Q&A).
- **`EhLeitura(msg, acao)`** — com ação, só `Op=="relatorio"` é leitura; sem ação,
  leitura = sem verbo de escrita (regex `reEscrita`).
- **`Montar(db, msg)`** — resolve o processo (`PR-code` / id / `UC:<nº>`; UC ambígua
  retorna erro listando os códigos), lê valores atuais e devolve `Acao` + preview
  "antes→depois". **Ops:** `editar_processo`, `recalcular_repasse`, `movimentar`,
  `inserir_historico`, `editar_meta`, `relatorio`, `rodar_job`.
- **Limitador (whitelist):** `campos`/`CamposPermitidos()` é a barreira coluna-a-coluna
  (`TABELA.coluna→tipo`) do executor. Ponteiros de workflow (etapa/status/instância/
  aprovação) são **deliberadamente excluídos** — mudá-los sem histórico dessincroniza →
  tem que usar `movimentar`. Relatórios de leitura têm whitelist própria
  (`procedit/relatorios.go`, ex. `protocolos_aneel`, SELECT parametrizado, sem SQL livre).

## 6. Relatórios

- **`handlers/relatorio_auditoria.go`** — `RelatorioAuditoria(db, ini, fim)`: coorte
  **read-only** F01–F05. Roda o motor ao vivo sobre a FDE e classifica cada apontamento
  em um desfecho exclusivo por vínculo de UC: **Processo** (UC∈FT_PROCESSOS),
  **Descartado** (FATURA_REANALISES REJEITADO/SEM ERRO/REFUTADO ou requisição id_status=4),
  **Em requisição** (UC∈FT_REQUISICOES), **Não trabalhado**. Dois universos: ComVtal
  (exclui 14=REZEK) e SemVtal (também exclui 2025=VTAL). Consumido por
  `cmd/relatorio_auditoria`.
- **`handlers/relatorios_handler.go`** — API de métricas do dashboard
  (`GetRelatoriosMetricas`, `GetRelatoriosMetricasBatch`, `GetKanbanComposicao`); ~40
  indicadores via `repositories.DashboardRepo`.
- **`handlers/v2/export_auditoria.go`** — export do Controle de Processos
  (`GET /api/v2/auditoria/processos`).
