# ops/ — operação fora do código

Aqui ficam os arquivos que **não são o sistema**, mas que a operação gera e precisa guardar:
scripts de correção pontual, backups feitos antes de cada correção, planilhas de conferência,
relatórios e binários compilados. Nada disto vai para o Git (só este README e o `MANIFESTO.md`),
porque os backups contêm dados do banco.

Regra: **`backend/`, `frontend/` e `worker/` só têm código**. Script que roda uma vez, backup e
planilha entram aqui, numa pasta `AAAA-MM_assunto/`.

## Pastas

| Pasta | O que é |
|---|---|
| `2026-06_migracao-v2/` | Scripts e backups da migração do banco para o esquema V2 (jun/2026): backfills de aprovação, cod_empresa, horários do histórico, simulação do fluxo 18352. |
| `2026-07_correcoes-deferimento-distribuidora/` | Correções de julho: distribuidora por CNPJ, itens de faturamento, deferimentos marcados/removidos em lote, planilhas comparativas backup × V2, drift de schema, lote dos 377. |
| `2026-10_login-link-magico/` | `aplicar_migracao_magic.py`, usado uma vez quando a migração do link mágico não aplicou no deploy. |
| `2026-10_entregas-worker/` | Scripts de entrega manual de pedidos do chat (Luana, Eliane, Eduardo), backups de pedidos e versões antigas do `PROMPT_WORKER.md`. |
| `backups-agua/` | Backups do `agua_sync` (origem → destino). |
| `conferencias-2026/` | Relatórios e planilhas das conferências visuais (Celesc, Enel, apontadas geral, controle de processos). |
| `binarios/` | Executáveis compilados localmente (`auditados.exe`, `inconclusivos.exe`, `executor_solicitacoes.exe`). O deploy compila na VPS; estes podem ser apagados. |
| `snapshots/` | Cópia completa do repositório de 25/06/2026 (`.tar.gz`, 104 MB). Pode ser apagada: o Git tem o histórico. |
| `diversos/` | Logs antigos e restos (`startup.err`, `_tmp_check`). |

## Backups das correções feitas pelo Claude

Os backups das correções feitas em sessão (JSON com as linhas antes da alteração) ficam fora do
repositório, em `..\_backups_banco\` (pasta `Docker\_backups_banco`), um arquivo por correção,
com data e hora no nome. Dentro do sistema, duas tabelas guardam o antes/depois de ações
reversíveis: `FT_EXECUTOR_BACKUP` (pedidos do chat executados pelo servidor) e
`FT_STATUS_RECONCILIACAO` (correções de status × histórico feitas em Tarefas do sistema).

## Manifesto

`MANIFESTO.md` registra cada arquivo movido para cá, de onde veio e para onde foi.
