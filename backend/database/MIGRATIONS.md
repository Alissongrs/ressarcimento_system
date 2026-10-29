# Migrations

## Como está agora (05/07/2026)

O backend **não roda mais DDL no boot**. Ao subir, ele apenas chama
`CheckSchemaVersion(DB_App)` que:

1. Verifica se a tabela `schema_migrations` (formato golang-migrate) existe.
2. Lê `version` + `dirty`.
3. Falha o boot se `dirty = 1` (última migração foi interrompida — precisa de
   intervenção manual antes de continuar).
4. Loga a versão atual e retorna sucesso.

**Não** cria, altera ou remove nenhum objeto do schema.

### Antes (ruim)

`RunMigrations()` executava ~1200 linhas de `CREATE TABLE`/`ALTER TABLE` a cada
boot, inclusive `DROP COLUMN` em `DM_USUARIO`. Isso era destrutivo, não
versionado, e rodava em paralelo se duas instâncias subiam ao mesmo tempo.

## Como aplicar mudanças de schema (produção)

Passo explícito no deploy, **fora** do boot do backend, usando
[`golang-migrate`](https://github.com/golang-migrate/migrate):

```bash
# instala uma vez
go install -tags 'mysql' github.com/golang-migrate/migrate/v4/cmd/migrate@latest

# cria par de arquivos {versao}_{nome}.up.sql / .down.sql
migrate create -ext sql -dir backend/database/migrations -seq add_x_column

# roda migrações pendentes (o próprio migrate pega GET_LOCK internamente)
migrate -path backend/database/migrations \
        -database "mysql://$DB_APP_URL" \
        up
```

O `golang-migrate` grava/atualiza `schema_migrations` automaticamente e usa
`GET_LOCK('migrate', ...)` no MySQL — dois deploys concorrentes não vão pisar
um no outro.

Se algo falhar no meio, `schema_migrations.dirty = 1` — o backend recusa a
subir enquanto isso não for resolvido:

```bash
# depois de investigar e ajustar o schema à mão:
migrate -path ... -database ... force <versao>
```

## Escape hatch — só desenvolvimento local

Se você quer o comportamento antigo (o blob roda tudo idempotentemente no
boot), setar no `.env` local:

```env
SURE_LEGACY_AUTO_MIGRATE=true
```

Isso re-habilita `runLegacyMigrationsUnsafe`, protegido por advisory lock
`GET_LOCK('sure_migrate', 30)`. **Nunca** ligue isso em produção.

## Plano de migração

- [x] Boot só faz version check
- [x] Advisory lock protegendo o legado quando opt-in
- [ ] Baseline: `migrate create initial_schema` → dump do schema atual em
      `.up.sql`, `.down.sql` com `DROP DATABASE` (ou noop)
- [ ] Registrar a versão baseline no PROD com `migrate force 1`
- [ ] Deletar `runLegacyMigrationsUnsafe` e o `SURE_LEGACY_AUTO_MIGRATE`
- [ ] Todo DDL futuro entra como par de arquivos em `migrations/`
