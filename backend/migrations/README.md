# Migrations — golang-migrate

Migrations versionadas para o BD principal (`DB_APP_URL`).

Tool: [golang-migrate/migrate](https://github.com/golang-migrate/migrate)

## Convenções

- Arquivos: `NNNNNN_descricao_curta.{up,down}.sql`
- Numeração: 6 dígitos sequenciais (000001, 000002, ...)
- Cada migration tem par `up`/`down`
- `up.sql`: aplica a mudança (DDL/DML)
- `down.sql`: reverte exatamente o que `up.sql` fez
- **Nunca edite uma migration já mergeada em `main`** — crie uma nova

## Como rodar

### Via Docker (recomendado — não precisa instalar nada localmente):

```bash
# Aplicar todas as migrations pendentes
docker run --rm --network ressarcimento_system_backend \
  -v "$(pwd)/backend/migrations:/migrations" \
  migrate/migrate:v4.18.1 \
    -path=/migrations \
    -database "mysql://appuser:App_S3cur3!@tcp(db:3306)/appdb" \
    up

# Aplicar uma migration específica (N steps)
docker run --rm --network ressarcimento_system_backend \
  -v "$(pwd)/backend/migrations:/migrations" \
  migrate/migrate:v4.18.1 \
    -path=/migrations \
    -database "mysql://appuser:App_S3cur3!@tcp(db:3306)/appdb" \
    up 1

# Reverter última migration
docker run --rm --network ressarcimento_system_backend \
  -v "$(pwd)/backend/migrations:/migrations" \
  migrate/migrate:v4.18.1 \
    -path=/migrations \
    -database "mysql://appuser:App_S3cur3!@tcp(db:3306)/appdb" \
    down 1

# Versão atual
docker run --rm --network ressarcimento_system_backend \
  -v "$(pwd)/backend/migrations:/migrations" \
  migrate/migrate:v4.18.1 \
    -path=/migrations \
    -database "mysql://appuser:App_S3cur3!@tcp(db:3306)/appdb" \
    version
```

### Em produção (RDS):

```bash
docker run --rm \
  -v "$(pwd)/migrations:/migrations" \
  migrate/migrate:v4.18.1 \
    -path=/migrations \
    -database "mysql://USER:PASS@tcp(rds-endpoint:3306)/appdb?tls=true" \
    up
```

Sempre executar com snapshot RDS recente (ver BACKUP_PLAN.md).

## Criando uma nova migration

```bash
# Próximo número
NEXT=$(printf "%06d" $(( $(ls backend/migrations/*.up.sql 2>/dev/null | wc -l) + 1 )))

# Criar par de arquivos
touch "backend/migrations/${NEXT}_minha_mudanca.up.sql"
touch "backend/migrations/${NEXT}_minha_mudanca.down.sql"
```

Ou pelo CLI do golang-migrate:
```bash
docker run --rm -v "$(pwd)/backend/migrations:/migrations" \
  migrate/migrate:v4.18.1 \
  create -ext sql -dir /migrations -seq minha_mudanca
```

## Baseline

A migration `000001_baseline` é apenas placeholder. O schema histórico foi criado via DDL ad-hoc antes da introdução de migrations.

Para gerar baseline real do schema atual:
```bash
docker exec ressarcimento_system-db-1 \
  mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" \
  --no-data --routines --triggers --events --no-tablespaces \
  appdb > backend/migrations/000001_baseline.up.sql
```

E marcar a versão atual sem reaplicar:
```bash
docker run --rm --network ressarcimento_system_backend \
  -v "$(pwd)/backend/migrations:/migrations" \
  migrate/migrate:v4.18.1 \
    -path=/migrations \
    -database "mysql://appuser:App_S3cur3!@tcp(db:3306)/appdb" \
    force 1
```

## Boas práticas

- Migrations devem ser **idempotentes quando possível** (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`)
- Mudanças destrutivas (DROP) em migration separada, com janela de manutenção planejada
- Nunca colocar dados de produção em migration — use seeds separados
- DML (INSERT/UPDATE) em migration apenas para dados de configuração imutáveis (ex: tipos de status)
- Testar `up` e `down` localmente antes de mergear
- Em PRs, mencionar o número da migration no commit message

## Tabela de controle

`golang-migrate` cria `schema_migrations(version, dirty)` automaticamente. Não editar manualmente.

Se ficar `dirty=1` (migration falhou no meio):
```bash
# Investigar o erro, corrigir manualmente, depois:
docker run --rm --network ressarcimento_system_backend \
  -v "$(pwd)/backend/migrations:/migrations" \
  migrate/migrate:v4.18.1 \
    -path=/migrations \
    -database "mysql://..." \
    force <version>
```
