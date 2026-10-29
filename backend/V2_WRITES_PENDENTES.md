# Migração V2 backend — WRITES pendentes (fase F/G)

Status em 2026-07-02. A **fase de LEITURA foi concluída** (todas as SELECT/JOIN convergidas no
schema V2 FK-based; `go build ./...` = exit 0; queries validadas contra o banco real). Este
documento lista o que **ainda falta** — são WRITES e config que tocam o audit trail / estado do
processo e foram deixados para uma etapa aprovada, porque exigem o **mapa velho→novo** abaixo.

## Mapa de remodelagem V2 (a antiga "etapa+sub_etapa" texto virou 3 FKs)

O modelo antigo guardava `FT_PROCESSOS.etapa` (texto) + `sub_etapa` (texto composto). No V2 isso
foi decomposto em 3 dimensões:

| Conceito antigo (texto)                          | Coluna V2               | Dimensão / valores |
|--------------------------------------------------|-------------------------|--------------------|
| "etapa" = Distribuidora / Ouvidoria / ANEEL / SMA| `id_instancia_atual`    | DM_INSTANCIAS {1 Distribuidora, 2 Ouvidoria, 3 ANEEL, 4 SMA} |
| prefixo da sub_etapa: "Primeira reclamação…"→Reclamação; "Em contestação…"→Contestação; "Em conciliação…"→Conciliação | `id_etapa_atual` | DM_ETAPAS {1 Reclamação, 2 Contestação, 3 Conciliação, 4 Faturamento, 5 Repasse, 6 Encerramento} |
| sufixo da sub_etapa: "Aguardando retorno" / "Em elaboração" / "Em análise" / "Pendente" | `id_status_atual` | DM_STATUS_PROCESSO {1 Em análise, 2 Em elaboração, 3 Aguardando retorno, 4 Pendente, 5 Suspenso, 6 Cancelado, 7 Encerrado} |
| "Indeferido" | `id_aprovacao_atual = 2` | DM_STATUS_APROVACAO |
| "Deferido"   | `id_aprovacao_atual = 1` | DM_STATUS_APROVACAO |
| "Suspenso"   | `id_status_atual = 5`    | DM_STATUS_PROCESSO |

**Padrão canônico V2 já correto** (usar como referência): `handlers/v2/movimentar.go`,
`handlers/mail_handler.go:2072/2127`, `handlers/requisicao_handler.go:1709`.
Grava id_processo + id_etapa_anterior/nova + id_instancia_* + id_status_* + id_aprovacao_* .

## 1. INSERT INTO FT_HISTORICO_MOVIMENTACOES (schema velho → FK)
Cada um destes ainda insere `(id_requisicao, status_anterior, status_novo, etapa_anterior,
etapa_nova, sub_etapa, ...)` (colunas que não existem no V2) → **Error 1054 em runtime**.
Precisam: `id_requisicao`→`id_processo`; resolver etapa/sub texto → ids via o mapa acima
(idealmente lendo o snapshot atual do processo para "anterior", como faz o movimentar.go).

- aisure_handler.go:838
- admin_planilha.go:454, 1243
- admin_editor.go:~404
- coluna_helper.go:179  (dentro de updateColunaByData — ver item 4)
- desvio_kwh_fponta_handler.go:450, 459
- email_handler.go:184, 218
- faturamento_handler.go:175
- fluxo_ressarcimento_handler.go:198
- processo_handler.go:837, 932, 1636 (comentario), 1957, 2092 (indeferir), 2185 (suspensao), 2305 (retomada)
- requisicao_handler.go:1498 (classificacao), 1549

## 2. UPDATE/INSERT FT_PROCESSOS gravando colunas removidas (etapa/sub_etapa/id_coluna/nome_coluna)
Estas colunas NÃO existem mais; devem gravar só `id_etapa_atual`/`id_status_atual`/
`id_instancia_atual`/`id_aprovacao_atual`/`suspenso`.

- email_handler.go:~206-213  (SET etapa='Distribuidora', sub_etapa=? …)
- fluxo_ressarcimento_handler.go:~188  (SET sub_etapa=?, id_status_atual=? …)
- processo_handler.go: MovimentarProcesso ~646-660 e ~933-934; SuspenderProcesso ~2181; RetomarProcesso ~2278-2293  (SET id_coluna/nome_coluna/sub_etapa)
- desvio_kwh_fponta_handler.go:445  (INSERT INTO FT_PROCESSOS (… sub_etapa, id_coluna, nome_coluna …))
- admin_planilha.go / admin_editor.go: UPDATEs de id_coluna/nome_coluna no BulkMover/editor

## 3. INSERT FT_REQUISICOES_FATURAS — renome trivial (BAIXO risco)
FT_REQUISICOES_FATURAS usa `id_processo` (só FT_REQUISICOES mantém id_requisicao).
- requisicao_handler.go:315, 324 — `(id_requisicao, link, …)` → `(id_processo, link, …)`.
- desvio_kwh_fponta_handler.go:456 — idem.
  (Writes puramente mecânicos; sem risco de mapeamento. Ficaram na fase F só porque estão
  dentro de fluxos que já quebram antes no INSERT de histórico.)

## 3b. FT_ANEXOS — JÁ CORRIGIDO nesta passada (02/07)
Descoberto no restart: FT_ANEXOS usa `id_processo`, não `id_requisicao` (premissa errada dos
subagentes). Corrigidos reads+inserts de anexo: aisure_handler:885, ml_handler:94,
processos_meta:99, processo_handler:1312/1326 (reads) e 1505/1512 (inserts de anexo);
email_extract_handler:51 (read) e admin_editor:383 (DELETE guard). Verificado: **só FT_REQUISICOES
usa id_requisicao**; todas as outras FT_ usam id_processo.

## ✅ FEITO 02/07 (classificação end-to-end)
- `SincronizarStatusProcesso` (coluna_helper.go) REESCRITO pro V2: sync direto
  `FT_PROCESSOS.{id_etapa,id_instancia,id_status,id_aprovacao}_atual = *_nova` da última
  movimentação (respeita `suspenso` e "só se mais recente"). Beneficia TODOS os write-paths
  que o chamam.
- `UpdateRequisicaoCompleta` (requisicao_handler.go): INSERTs de **classificacao** e **comentario**
  reescritos pra FK, gravando o snapshot atual do processo via `SELECT ... FROM FT_PROCESSOS`
  (sem parsear string composta).
- Front `Requisicoes.jsx`: classificação salva automaticamente no onChange dos selects; botão
  "Salvar classificação" removido.
- `MovimentarProcesso` (processo_handler.go, POST /processos/:id/movimentar) — caminho principal de
  MOVIMENTAÇÃO reescrito pro V2: UPDATE FT_PROCESSOS só grava id_etapa_atual/id_status_atual (removidas
  etapa/id_coluna/nome_coluna/sub_etapa); INSERT de histórico → FK (from→to resolvido por nome);
  chamada a `updateColunaByData` trocada por `SincronizarStatusProcesso` (coluna derivada); anexo
  (`form.File["anexos"]`) grava com id_processo='gestor' na mesma tx → aparece na aba de anexos.
- Snapshot morto neutralizado: `syncSnapshotFromOriginal` = no-op; removido `UPDATE FT_PROCESSO_SNAPSHOT`
  fatal (relevância). `SincronizarStatusProcesso` reescrito pro V2.
- Aprovação agora copia uc/cliente/concessionaria/ressarcimento/irregularidade da FT_REQUISICOES pro
  FT_PROCESSOS (INSERT...SELECT) → Reclamação vem com colunas preenchidas.

Ainda 500/pendente (fase F): dentro do movimentar os sub-blocos deferimento/fluxo/faturamento;
handlers faturamento, fluxo, indeferir, suspender/retomar, email, aisure, admin planilha/editor mover
— cada um tem seu INSERT velho + `updateColunaByData` (que segue mangled, só chamado por esses).
Auto-advance (AUTO_ADVANCE_ENABLED=1) no movimentar ainda tem colunas mortas (env-gated, off).

## 4. coluna_helper.go — updateColunaByData (rewrite) — SincronizarStatusProcesso JÁ FEITO
`updateColunaByData` (ainda mangled) é chamado por: admin_planilha:571, admin_editor:429,
faturamento:198, fluxo:221, processo_handler:681/787/1943. Grava id_coluna/nome_coluna (colunas
removidas). Como kanban é derivado no V2, o miolo dele é obsoleto — provável rewrite: reduzir a
chamar SincronizarStatusProcesso (+ eventual promoção de status pós-deferimento como regra de
negócio). NÃO está no caminho da classificação.
Totalmente mangled: referencia `p.etapa`, `p.sub_etapa`, `p.id_coluna`, `p.nome_coluna`,
`d.etapa`, `e.id_coluna_kanban`, `DM_KANBAN_COLUNAS`, `u.id_requisicao` (tudo dropado), e chega a
ter atribuição a literal `'' /* TODO V2 */ = CASE…`. Chamado por ~15 write-paths no fim de cada
transação. Precisa ser reescrito pro modelo FK/derivado (coluna kanban = CASE derivado; sem
DM_KANBAN_COLUNAS). Enquanto não reescrito, todo write que o chama vai falhar nesse ponto — mas
hoje eles já falham antes, no INSERT do item 1.

## 5. Config / DDL (remodelagem de negócio à parte)
- prazos_handler.go GetPrazosConfig/SavePrazosConfig — usa DM_KANBAN_COLUNAS, DM_ETAPAS_PROCESSO, DM_PRAZOS_KANBAN, DM_PRAZOS_ETAPA (kanban legado). Onde a config de prazos passa a morar no V2 é decisão de negócio.
- automation_service.go:406-409, 537-540 — blocos de prazo (DM_PRAZOS_ETAPA/DM_PRAZOS_KANBAN).
- database/migrations.go:483-518 — criação de VIEW PowerBI referenciando e.etapa/h.sub_etapa/DM_KANBAN_COLUNAS. Verificar se roda no boot (o servidor está de pé, então provavelmente é idempotente/guarded).
- tools/fix_kanban_map/main.go — ferramenta avulsa (não é o servidor).

## Endpoints DESBLOQUEADOS pela fase de reads (já funcionam)
/processos/kanban-fast, /processos/backlog, /processos/:id/score, /requisicoes/:id/faturas,
/requisicoes/:id/historico, /processos/:id/historico, /filtros/etapas, dashboards, /historico,
GetRequisicaoByID, e as listagens de admin/planilha/export (parte de leitura).
