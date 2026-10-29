# 11 — GitHub, CI/CD e Deploy

Organizado em 29/10/2026. Até então o código ia para a VPS copiado à mão; a partir daqui o caminho é
**PC → GitHub (branch `dev`) → Actions testa → deploy pelo botão → VPS**.

## Repositório

- `github.com/Alissongrs/ressarcimento_system` — **privado** (estava público até 29/10; foi fechado no
  mesmo dia, sem nenhuma senha publicada).
- Branch de trabalho e de produção: **`dev`** (a VPS usa `dev`). O `main` está parado num commit antigo.
- ⚠️ O branch **padrão** do repositório ainda é `main`; por isso o botão "Run workflow" não aparece no
  site. Trocar em Settings → General → Default branch → `dev`. Até lá, disparar por linha de comando
  (ver abaixo).

### O que fica fora do Git (de propósito)

| Fora do Git | Motivo | Onde existe |
|-------------|--------|-------------|
| `backend/.env` | segredos | VPS (+ segredo `ENV_FILE` no GitHub) |
| `backend/ocr_prod/`, `backend/ocr_service/` | têm senha do banco escrita no código | só na VPS (o build usa a cópia de lá) |
| scripts avulsos `backend/_*.py`, `worker/entregar_*`, `worker/executar_pedido_*` | uso único / senha no código | PC |
| `worker/engine/` (3 arquivos com senha) | senha no código | PC / VPS |
| backups `.json`, planilhas `.xlsx/.csv`, `.exe`, logs, `.tar.gz` | dados de cliente / binários / tamanho | PC |
| `ia/`, `backups/`, `node_modules/`, `dist/`, `uploads/` | `.gitignore` | — |
| `.env.novo`, `.env_backups/` | gerados pelo deploy | VPS |

> ⚠️ Antes de subir arquivo novo: procurar senha escrita no código. Arquivo com credencial **não** vai
> para o Git; o certo é ler do `.env`.

## GitHub Actions — `.github/workflows/ci.yml`

Roda em todo push/PR para `dev`/`main` e no disparo manual (`workflow_dispatch`).

| Job | O que faz | Trava o pipeline? |
|-----|-----------|-------------------|
| **Backend Tests (Go)** | `go mod download`, golangci-lint, `go vet`, `go test -race -coverprofile` (MySQL de teste no container) | `vet` e testes **sim**; golangci-lint **não** (informativo — o código nunca passou nele) |
| **Frontend Tests (React)** | `npm ci`, `npm run lint` (máx. **250** warnings, 0 erros), `npm run build` | sim |
| **Security Scan** | Trivy no repositório, upload SARIF, `govulncheck`, `npm audit` | **não** (informativos: repo privado sem Advanced Security; excelize v2.10.0 tem CVEs só corrigidas em commit sem versão) |
| **Docker Build** | build das imagens backend (`load: true`) e frontend + Trivy na imagem; cria `backend/ocr_prod` vazio só para o build no CI | sim |
| **Deploy VPS (manual)** | só em `workflow_dispatch`, ambiente `production` com aprovação | — |

Ajustes de 29/10 para o pipeline ficar verde: 7 erros de lint (um era bug real — `ProcessoCard` chamava
`criarAlertaProcesso`/`salvarDataAlerta` sem importar), BOM removido de 38 arquivos Go (quebrava
`go test` com cobertura), mensagens de validação passaram a usar o nome do campo no JSON
(`utils/validate.go` → "id_departamento é obrigatório").

## Deploy pela VPS

### Como disparar

```powershell
gh workflow run ci.yml --ref dev -R Alissongrs/ressarcimento_system
```
(ou, depois de trocar o branch padrão para `dev`: Actions → CI/CD Pipeline → **Run workflow** → `dev`).
Depois dos testes (~10 min) o job **Deploy VPS** espera aprovação: **Review deployments** →
`production` → **Approve and deploy**.

### O que o deploy faz na VPS

1. **Envia o `.env`**: o conteúdo do segredo `ENV_FILE` vai pelo stdin do SSH para
   `backend/.env.novo` (não aparece em log nem em linha de comando). `ENV_FILE_RAIZ` (opcional) vira
   o `.env` da raiz — **hoje a VPS não tem `.env` na raiz**, então não é usado. Sem `ENV_FILE`, o
   `.env` da VPS fica como está.
2. Guarda o `.env` atual em `.env_backups/<arquivo>.<data_hora>` (mantém os 20 mais recentes no total),
   troca pelo novo com permissão `600`.
3. `git fetch` → `git checkout dev` → `git pull --ff-only`.
4. `docker compose build backend frontend` → `docker compose up -d`.
5. Espera `GET http://127.0.0.1:8080/api/v1/healthz` por até ~90 s.
6. **Se não responder: rollback** — restaura o `.env` anterior, `git reset --hard` no commit anterior,
   rebuild e sobe de novo; o job termina em erro.

As migrações aditivas rodam sozinhas no boot do backend (ver [01](01-arquitetura-backend.md)).

### Segredos (Settings → Environments → `production`)

| Segredo | Valor |
|---------|-------|
| `VPS_HOST` | `179.127.26.37` |
| `VPS_USER` | `ressarcimento` |
| `VPS_APP_DIR` | `/opt/ressarcimento/ressarcimento_system` |
| `VPS_SSH_KEY` | chave privada `ed25519` de deploy (`deploy-github-sure`) |
| `ENV_FILE` | conteúdo inteiro do `backend/.env` da VPS |

Proteções do ambiente: **Required reviewers** (Alisson) e **Deployment branches** só `dev`. Conta do
GitHub com **2FA**. Os valores dos segredos não podem ser lidos de volta, nem pelo dono — só o
Actions os recebe durante a execução.

### Chave SSH de deploy

Gerada no PC com `ssh-keygen -t ed25519 -C "deploy-github-sure"`; a pública está em
`/home/ressarcimento/.ssh/authorized_keys` (a pasta `.ssh` era do `root` e foi corrigida com
`chown`), a privada só no segredo `VPS_SSH_KEY`. Para revogar: apagar a linha `deploy-github-sure`
do `authorized_keys`.

## Estado da VPS (alinhamento de 29/10)

Antes: Git no commit `b007e108` (março), com 1 commit local e dezenas de arquivos copiados à mão.
Alinhamento feito:
- backup: branch `backup-vps-20261029`, `~/vps_alteracoes_20261029.patch`,
  `~/vps_antes_github_20261029.tgz`;
- `git reset --hard origin/dev` → VPS = GitHub. Arquivos fora do Git (`.env`, `ocr_prod`,
  `ocr_service`, worker com senha) ficaram intactos.
- Desfazer: `git reset --hard backup-vps-20261029`.

Containers antigos ainda no ar (fora do compose atual, não usados): `ollama`, `ocr`, `llama-agent`.
O deploy não mexe neles; podem ser desligados depois.

## Problemas conhecidos / dicas

- **`git pull` reclama de "untracked working tree files would be overwritten"** → arquivo copiado à
  mão na VPS colide com o Git; usar `git reset --hard origin/dev` (arquivos fora do Git ficam).
- **`gh … not a git repository`** → rodar dentro da pasta do projeto ou passar
  `-R Alissongrs/ressarcimento_system`.
- **`Load key ... error in libcrypto`** → chave colada com quebras de linha do Windows (CRLF). O workflow
  já remove os `` e valida a chave antes de usar ("VPS_SSH_KEY inválida"); se ainda falhar, colar
  de novo a chave inteira, com as linhas BEGIN/END.
- **Deploy rodou sem pedir aprovação** → o ambiente `production` está sem *Required reviewers*.
- **Re-run de uma execução de push não faz deploy** — o job de deploy só roda em disparo manual.
- O classificador do Claude Code bloqueia o assistente de disparar deploy de produção: o disparo e a
  aprovação são sempre do usuário.
