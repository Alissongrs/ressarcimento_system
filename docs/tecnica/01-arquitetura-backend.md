# 01 — Arquitetura do Backend

Backend Go (módulo `ressarcimento-backend`), framework **Gin**, usando tanto
**GORM** quanto `database/sql` cru. Porta **8080** (fixa).

## Boot — `main.go`

Sequência de inicialização (`func main`, ~`main.go:31-81`):

1. `loadEnv()` — carrega `.env` (cwd, `backend/`, dir do executável) via godotenv.
2. `utils.InitLogger()` — slog; JSON em produção quando `LOG_FORMAT=json`.
3. `time.Local = America/Sao_Paulo`.
4. `auth.ValidateJWTSetup()` — **aborta** se o JWT estiver mal configurado em prod.
5. `database.InitDBs()` — abre pools `database/sql` (`DB_App`, `DB_V2`, `DB_Consulta`).
6. `database.InitGorm()` — abre pools GORM (`GormDB_App`, `GormDB_Consulta`,
   `GormDB_Faturas`, `GormDB_Vtal`). **Falha fatal** se `DB_App`/`GormDB_App` forem nil.
7. `handlers.StartMotorCacheWarmer(...)` — aquece o cache do motor de desvio
   (cálculo frio ~20s sobre ~177k faturas). Ver [05](05-motor-de-desvio.md).
8. `startScheduler()` — scheduler gocron **in-process** (ver abaixo).
9. `routes.SetupRouter(...)` — monta o Gin; **as migrations rodam aqui dentro**.
10. `r.Run(":8080")`.

### Scheduler in-process (`startScheduler`, ~`main.go:117`)

gocron em horário local. Tarefas: leitura IMAP a cada 1min (**só se `IMAP_ENABLE=1`**,
default off), verificação de pendências de fluxo (a cada 10 dias), informativo
semanal (sex 18:00), checagem de prazos de requisições/processos (de hora em hora),
cache de cobrança (horário), e-mails de alerta (diário 08:00/08:05), resumos de
processo (1min, lote de 20), refresh do CSV de ML + treino do modelo de score (horário).

> ⚠️ Em produção, o agendamento "oficial" é o **cron da VPS**
> ([08](08-ops-infra-workers.md)). O gocron in-process **também** roda — atenção para
> não duplicar efeitos (ex.: e-mails) se ambos estiverem ativos.

## Rotas — `routes/routes.go`

`SetupRouter` (~linha 53) monta a engine. **Cadeia de middleware global** (ordem):

```
Recovery → RequestID → Metrics → Logger(mascara ?token=) →
SetTrustedProxies → CORS → OPTIONS short-circuit →
GlobalRateLimit → Gzip
```

`MaxMultipartMemory = 32MB`. Trabalho de boot feito dentro do `SetupRouter`:
`database.RunMigrations()`, sincronização de snapshot, `EnsureViewUltimoHistorico`
(view rápida do Kanban). `/metrics` (Prometheus) e `/swagger/*` ficam atrás de
`SwaggerGuard()` (IP interno/admin).

### Árvores de rota

- **`/api/v1`** — API primária.
- **`/api/v2`** — "Controle de Processos v2" (writes transacionais).
- **`/api`** — espelho legado **deprecado** (emite headers `Deprecation`/`Sunset`).
- Aliases públicos de SSE: `/apialertasstream`, `/apievents`.

### Grupos de `/api/v1` por guarda de acesso

| Grupo | Middleware | Quem acessa | Conteúdo (resumo) |
|-------|-----------|-------------|-------------------|
| **Público** | — | qualquer um | health, SSE (`AuthOrQueryToken`), `/register`, `/login` (`AuthRateLimit`), `/logout`, `/whoami`, download de anexo por token |
| **authRequired** | `AuthMiddleware` | **qualquer autenticado, incl. solicitante** | filtros, **solicitações** (chat→fila), chat/histórico, informativo (GET), lookups de UC, **requisições** (criar + próprias), **faturas** (superfície enorme: FDE, fichas F01–F14, auditar/rejeitar apontamento, água-análise, acer, claro, desvio), busca global, feedback, dashboard (leitura) |
| **gestorRequired** | `AuthMiddleware` + `GestorMiddleware` | gestor ou admin | triagem de requisições, **processos/fluxo** (kanban, movimentar, deferimento, suspender, prazos, backlog), fluxo-ressarcimento, faturamento, **mail/** (Graph), documento DOCX, admin/processos (planilha), score, regras CRUD, fichas-regras + "Testar" |
| **adminOnly** | `AuthMiddleware` + `StrictAdminMiddleware` | **só admin** | `/historico` global, `/relatorios/metricas`, `/relatorios/kanban-composicao`, `PUT /informativo` |
| **Cron** | header `X-Cron-Token == CRON_TOKEN` | job da VPS | `POST /rules/aplicar-agendadas` |

### `/api/v2`

Rotas públicas de auth, depois um grupo com **apenas `AuthMiddleware()`** →
`RegisterAuthRoutesAuthed` + `RegisterReadRoutes` + `RegisterWriteRoutes`.

> ⚠️ **Achado de segurança:** os *writes* do v2 (movimentar, deferimento, faturamento,
> repasse, encerramento, metas) estão sob `AuthMiddleware()` **sem `GestorMiddleware`**.
> Em tese um `solicitante` autenticado não é barrado estruturalmente nessas rotas —
> diferente do v1. Ver [09 — Segurança](09-seguranca-e-pendencias.md).

## Middleware (`middleware/`)

- **`AuthMiddleware`** (`auth_middleware.go`): resolve o token na ordem (1) cookie
  HttpOnly `auth_token`, (2) `Authorization: Bearer`, (3) `?token=` (só quando
  `allowQueryAlways`, usado por SSE/download). Valida JWT HS256. **Chaves de contexto**:
  `userID`, `userName`, `userEmail`, `userTipoConta`, `role` (minúsculo), `isAdmin`.
  Derivação do papel: `claims.Role` → `claims.TipoConta` → fallback **`solicitante`**.
- **`GestorMiddleware`**: permite `gestor` ou `admin`; senão 403.
- **`AdminMiddleware`**: `admin` ou `gestor`. **`StrictAdminMiddleware`**: só `admin`.
- **CORS**: origens de `CORS_ALLOW_ORIGINS` (CSV); `AllowCredentials: true`.
- **Rate-limit** (`ratelimit.go`): in-memory ou **Redis** (quando `REDIS_URL`).
  `GlobalRateLimit` 1000/min por IP; `AuthRateLimit` 30/5min em login/register;
  `OCRChatRateLimit` 12/min.

## Conexões de banco (`database/`)

Dois arquivos: `database.go` (`database/sql`) e `gorm.go` (GORM). Ambos montam DSNs
com `parseTime=true&charset=utf8mb4&loc=Local` e **`time_zone` embutido na DSN**
(default `-03:00` via `DB_TIMEZONE`) — cada conexão do pool já nasce em BRT (corrige
o bug de carimbo +3h UTC). TLS por conexão: `DB_*_TLS` ∈ `skip-verify`|`rds`|`true`
(modo `rds` carrega o bundle `certs/global-bundle.pem`).

| Handle | Variável | Aponta para (conceito) |
|--------|----------|------------------------|
| `DB_App` / `GormDB_App` | `DB_APP_URL` | **Banco da aplicação** (`db_ressarcimento`, RDS) |
| `DB_V2` | `DB_APP_URL` | mesmo banco da app (usado pelos handlers v2) |
| `DB_Consulta` / `GormDB_Consulta` | `DB_CONSULTA_URL` | banco de consulta ("Amee_Serving"), opcional |
| `GormDB_Faturas` | `DB_FATURAS` | **origem das faturas** (`sgeeasy_clientes_novo`) |
| `GormDB_Vtal` | `DB_VTAL` | origem VTAL (`quivere_vtal`, cod_empresa 2025) |

## Migrations

- `RunMigrations()` roda dentro do `SetupRouter` **em todo boot** (incl. prod):
  `CheckSchemaVersion` (read-only; bloqueia boot se `schema_migrations.dirty=1`) →
  `runAdditiveMigrations`.
- **`runAdditiveMigrations`** (`migrations_additive.go`): aplica **só DDL aditivo e
  idempotente** — `createTableIfNotExists`, `addColumnIfMissing`, `createIndexIfMissing`
  (nunca DROP/destrutivo), sob lock de advisory. **É o mecanismo pelo qual mudanças de
  schema entram no deploy**, porque o deploy **não** roda golang-migrate. Mudança
  aditiva nova = **uma linha** aqui.
- O bloco legado destrutivo (`runLegacyMigrationsUnsafe`) só roda se
  `SURE_LEGACY_AUTO_MIGRATE=true` (escape de dev). Em prod, golang-migrate é passo
  manual de deploy.

> Ver [memória do projeto: deploy não roda migração]. Para adicionar coluna/tabela
> nova sem quebrar o deploy, adicione a chamada aditiva em `migrations_additive.go`.

## SSE (`sse/` + `handlers/sse_handler.go`)

Pub/sub in-process (`sse/hub.go`): `Subscribe(processoID)` / `Broadcast`. Handlers:
`GET /processos/:id/events` (updates por processo), `GET /events` (canal global),
`GET /alertas/stream`. Usa `AuthOrQueryToken` porque `EventSource` não envia header
`Authorization`. Emite em tempo real: movimentações de processo e alertas → Kanban e
sininho do front.
