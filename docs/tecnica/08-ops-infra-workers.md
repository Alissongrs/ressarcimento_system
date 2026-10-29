# 08 — Operação, Infra e Workers

## Deploy

Desde 29/10/2026 o deploy é pelo **GitHub Actions** (botão/`gh workflow run`, com aprovação):
`.env` vindo do segredo `ENV_FILE`, `git pull`, build, healthcheck e rollback automático. Passo a
passo, segredos e o alinhamento da VPS em [11 — GitHub, CI/CD e deploy](11-github-cicd-deploy.md).

## `docker-compose.yml`

Serviços ativos:

| Serviço | Imagem / build | Porta (host→container) | Notas |
|---------|----------------|------------------------|-------|
| `db` | `mysql:8.0` | `127.0.0.1:3306:3306` | utf8mb4, tz `-03:00`, healthcheck, volume `db_data`, init em `./docker/mysql/init` |
| `redis` | `redis:7-alpine` | interno | rate-limit; sem persistência; maxmemory 128mb LRU |
| `backend` | build `./backend/Dockerfile` | `127.0.0.1:8080:8080` | Go API; `env_file: ./backend/.env`; `GO_ENV=production`, `COOKIE_SECURE=true`, `LOG_FORMAT=json`; volume `whatsapp_data:/app/whatsapp_sessao` (sessão do WhatsApp) |
| `frontend` | build `./frontend/Dockerfile` | `127.0.0.1:8090:80` | build React → nginx 1.27-alpine |

Desativados no compose: `ollama`, `ocr`, `llama-agent` (LLM passou a Anthropic Haiku a
partir do backend; OCR via Tesseract) e `caddy`. **TLS público é feito pelo Apache do
host** (reverse-proxy `/`→frontend:8090, `/api`→backend:8080).

**Build do backend** (`backend/Dockerfile`): multi-stage Go 1.26-alpine (binário estático
`CGO_ENABLED=0` + geração do swagger) → runtime `python:3.11-slim` (glibc p/ PyMuPDF/
opencv). Também compila 3 binários usados pelo cron: `auditados`, `inconclusivos`,
`executor_solicitacoes`. Empacota `ocr_prod/` (pip), define `SKIP_SEFAZ=1`, roda como
usuário não-root `app`. ⚠️ `backend/ocr_prod/` **não está no Git** (tem senha no código): o build
na VPS usa a cópia que já existe lá; no CI um diretório vazio substitui. O Swagger é gerado no
build (`swag init`).

### Migrations no boot
`database/migrations.go:RunMigrations()` roda no startup → `runAdditiveMigrations()`
(só DDL **aditivo idempotente**, sob advisory lock, nunca DROP). **É assim que mudanças
de schema entram no deploy** — o deploy **não** roda golang-migrate. Conjunto aditivo
atual: colunas de login Entra/magic-link (`DM_USUARIO.ms_oid/ms_email`, tabela
`FT_MAGIC_LINKS`). Mudança aditiva nova = **uma linha** em `migrations_additive.go`.

## VPS

Linux, host **~179.127.26.37**. Agendamento = **cron do host** (`worker/crontab.sure`),
não Task Scheduler. Instala com `crontab worker/crontab.sure`. Variável `W` =
`/opt/ressarcimento/ressarcimento_system/worker`.

## Cron jobs (`worker/crontab.sure`)

```
*/3 * * * *  $W/run_worker.sh              # Worker tier-2 (claude -p), só se há fila
* * * * *    $W/run_executor.sh            # executor determinístico de solicitações
* * * * *    $W/run_jobs.sh                # jobs de host pedidos no chat (agua_sync)
* * * * *    $W/run_testes_regras.sh       # auditor do botão "Testar" (/regras)
*/5 * * * *  python3 $W/titular_conversas.py   # refinamento de títulos de chat (claude -p)
*/5 * * * *  python3 $W/drive_sync_anexos.py   # upload de anexos → Drive (rclone)
0 3 * * *    $W/backup_sistema.sh rotativo # backup diário (mantém 6)
0 3 * * 5    $W/backup_sistema.sh semanal  # backup semanal (sex, mantém 4)
0 2 * * 1,4  $W/job_pdf_pipeline.sh        # extração em lote (seg e qui 02:00)
0 2 * * 2,4  $W/job_agua.sh                # sync+motor de água (ter e qui 02:00)
0 0 * * *    $W/job_regras.sh              # aplica "regras passadas ao banco" 00:00
```

### Detalhe dos jobs

- **Worker tier-2** (`run_worker.sh`): gate por `has_work.py` (SELECT COUNT read-only em
  `FT_SOLICITACOES`), `flock` single-instance, roda `claude -p < PROMPT_WORKER.md`,
  `timeout 900s`. Processa os pedidos de texto livre (relatório/consulta) que o executor
  determinístico não entende; pode perguntar de volta ao solicitante
  (`status='preciso_confirmar'`). ⚠️ **Flags de risco:
  `--permission-mode bypassPermissions --allowedTools Bash,Read,Grep,Glob,Write`** — ver
  [09](09-seguranca-e-pendencias.md).
- **Executor determinístico** (`run_executor.sh`): a cada minuto, `docker compose exec -T
  backend /app/executor_solicitacoes`. Aplica ops **whitelisted** de solicitações
  aprovadas (editar campo de processo, repasse, inserir histórico, movimentar, relatório).
- **run_jobs** (`run_jobs.py`): reserva solicitação aprovada com `op="rodar_job"`
  (status→`executando`), roda o job **whitelisted = só `agua_sync`** (timeout 30min); em
  sucesso roda também `agua_motor.py`. Job desconhecido → `revisao` (manual).
- **job_pdf_pipeline** (seg/qui 02:00): backup rotativo primeiro, depois
  `pdf_pipeline.py --prod --empresa <~40 cod> --no-ocr --skip-processadas`.
- **job_agua** (ter/qui 02:00): `agua_sync.py dry` → `apply` (insere só faturas novas,
  backup reversível) → `agua_motor.py apply` (FA02 → aba 💧).
- **run_testes_regras** (`testes_regras.py`): gated em `FT_TESTES_REGRA` (botão "Testar"),
  `claude -p < PROMPT_TESTE_REGRAS.md`, `timeout 2400s`. **Permissões mais apertadas** que
  o worker tier-2: `--permission-mode acceptEdits --allowedTools "Bash(python3
  worker/testes_regras.py:*)" Read Write` (Bash escopado a um script).
- **job_regras** (00:00): `POST http://127.0.0.1:8080/api/v1/rules/aplicar-agendadas` com
  header `X-Cron-Token: $CRON_TOKEN`. Grava `DM_REGRAS` com backup em `DM_REGRAS_BACKUP`.
  **No-op** se `CRON_TOKEN` ausente.
- **Backups** (`backup_sistema.sh`): mysqldump (`--single-transaction --quick --routines
  --events`), gzip em `/opt/ressarcimento/backups/{rotativo,semanal}`. **Exclui dados** de
  tabelas pesadas regeneráveis (`TBL_FDE`, `FATURA_CLARO_DADOS_EXTRAIDOS`,
  `FATURA_AGUA_DADOS` — estrutura mantida). Tara também `backend/.env` e `worker/`.

### Gating / fila
- **`has_work.py`**: gate read-only do worker tier-2; `SELECT COUNT(*) FROM
  FT_SOLICITACOES` com filtro `status='revisao' AND (executado_em IS NULL OR resultado
  LIKE 'Pedido não reconhecido%')`. Exit 0 = há trabalho / exit 1 = vazio (worker pula →
  economiza tokens).
- **`FT_SOLICITACOES`** é a fila: `pendente`/`aprovado` → `executando` → `executado` /
  `revisao` / `preciso_confirmar`. Executor determinístico (ops whitelisted), `run_jobs`
  (`op=rodar_job`) e worker Claude (texto livre) — os três usam `flock`. Leitura/relatório
  roda sem aprovação; escrita exige `aprovado_por`.

## Integrações

- **rclone → Google Drive** (`drive_sync_anexos.py`): sobe blobs de
  `FT_SOLICITACOES_ANEXOS` → `gdrive:SURE/anexos/…`, grava link público em `drive_link`.
  Retenção 20 dias (apaga do Drive + linha; texto do resultado é mantido).
- **Microsoft Graph (e-mail)**: `services/graph_mail_service.go`, `graph_email.go`;
  login Entra em `handlers/v2/auth_microsoft.go`. Credenciais `AZURE_*`. Ingere em
  `mail_messages`/`process_mail_links`, expostos como e-mails do processo. **Roda dentro
  do backend Go**, não como cron.
- **SSE / push**: `handlers/sse_handler.go` (`GET /processos/:id/events`) + `alertas_stream.go`.

## Incertezas (sinalizadas pelo mapeamento)
- Os binários `auditados`/`inconclusivos` são compilados na imagem e o Dockerfile diz que
  rodam "pelo cron via docker compose exec", mas **não há linha de cron para eles** em
  `crontab.sure` — agendamento pode estar em outro crontab ou ser manual.
- O backup referencia `docker-compose.prod.yml`, que **não existe na raiz** aqui — prod
  pode usar outro nome de arquivo, ou a entrada está obsoleta.
