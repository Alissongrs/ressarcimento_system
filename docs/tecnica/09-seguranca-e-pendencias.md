# 09 — Segurança e Pendências

Consolidação dos achados de segurança e dívidas técnicas levantados na varredura de
2026-10-13. **Nenhum é segredo exposto aqui** — são apontamentos de postura.

## Achados de segurança

### 1. Worker tier-2 com `bypassPermissions` (prioridade alta)
`worker/run_worker.sh` roda o agente Claude headless com
`--permission-mode bypassPermissions --allowedTools Bash,Read,Grep,Glob,Write`. Ou seja,
**bypass total de permissões + Bash + Write**. A postura read-only é garantida **apenas
pelo texto do `PROMPT_WORKER.md`**, não pela harness. É o principal alvo de hardening.
- **Mitigação:** apertar para `allowedTools` escopados (como o job de testes de regras já
  faz: `Bash(python3 worker/testes_regras.py:*)`), e/ou usuário MySQL read-only dedicado.
- **Por que importa:** este é o vetor de prompt-injection mais sério — um pedido de chat
  malicioso processado pelo worker roda com permissões amplas. (O
  `executor_solicitacoes` em Go, por outro lado, é bem defendido: whitelist de op/tabela/
  coluna.)

### 2. Sem usuário de banco read-only
Todos os workers conectam com as mesmas credenciais `DB_APP_URL` (read/write total). Um
usuário MySQL **read-only** dedicado para o worker tier-2 / `has_work` / consultas é a
mitigação natural, coerente com a regra "read-only por padrão".

### 3. Rotas de escrita `/api/v2` sem guarda de papel
As rotas de `RegisterWriteRoutes` (`handlers/v2/routes_v2.go`) estão montadas sob
`AuthMiddleware()` **sem `GestorMiddleware`** (`routes/routes.go`). Em tese um
`solicitante` autenticado não é barrado estruturalmente de movimentar/deferimento/
faturamento/repasse no v2 — diverge do v1.
- **Ação:** confirmar se os handlers v2 fazem checagem de papel internamente; se não,
  adicionar `GestorMiddleware` ao grupo de writes v2.

### 4. Credencial RDS hardcoded no `agua_motor.py`
`worker/jobs/agua_motor.py` (e a cópia em `C:\claro_bf\`) tem usuário/senha do RDS no
código. O `agua_sync.py` já lê do `.env` corretamente — alinhar o motor ao mesmo padrão
(`ler_dsn()`), e rotacionar a credencial exposta.

### 5. TLS do banco sem verificação de cadeia
`DB_APP_TLS=skip-verify` no compose: o tráfego RDS é **criptografado mas a cadeia do
certificado não é validada**. Mover para `DB_APP_TLS=rds` (verificação completa com
`certs/global-bundle.pem`) após confirmar a partir da VPS.

### 6. Senhas default no compose
`MYSQL_ROOT_PASSWORD`/`MYSQL_PASSWORD` têm literais de fallback no `docker-compose.yml` —
devem ser sobrescritos por env em produção.

### 7. Senhas escritas no código (descoberto em 29/10)
53 arquivos Python têm a senha do banco no código: `backend/_*.py` (scripts avulsos),
`backend/ocr_prod/` (4), `backend/ocr_service/` (26), `worker/engine/` (3). **Ficaram fora do
GitHub** por isso. Ação: trocar por leitura do `.env`/variável de ambiente e então versionar;
rotacionar a senha.

### 8. Repositório esteve público
Até 29/10 o repositório no GitHub era **público**. Foi fechado no mesmo dia; antes do envio foi
feita varredura de segredos (nenhum publicado). Histórico antigo (antes de 29/10) não foi
auditado em profundidade — recomendável rodar um scanner de segredos no histórico
(ex.: gitleaks) e rotacionar o que aparecer.

### 9. Dependências com CVE
`govulncheck`: `github.com/xuri/excelize/v2@v2.10.0` com CVEs corrigidas só em commits sem
versão publicada — atualizar quando sair a v2.11.x. O Go da imagem/CI é o 1.26 mais recente
(corrige as CVEs da biblioteca padrão).

## Pendências operacionais

### CRON_TOKEN
`job_regras.sh` fica **inerte** (loga warning e no-op) enquanto `CRON_TOKEN` não estiver
no `backend/.env` e no env do backend. Sem ele, a aplicação diária de regras não roda.

### Colisão de agendamento
`job_agua` e `job_pdf_pipeline` colidem na **quinta 02:00**. Sugestão no próprio
comentário: mover a água para `30 2 * * 2,4`.

### Deploy
Até 28/10 o código ia para a VPS copiado à mão e muita coisa ficava pendente de deploy. Desde
29/10 tudo está no GitHub (`dev`) e a VPS foi alinhada; o deploy é pelo Actions
([11](11-github-cicd-deploy.md)). Pendências ligadas ao deploy:
- trocar o branch padrão do GitHub para `dev` (para o botão "Run workflow" aparecer);
- escolher o grupo de avisos em `/whatsapp` (sem isso nada sai pelo WhatsApp);
- desligar os containers antigos `ollama`, `ocr`, `llama-agent` (fora do compose, sem uso);
- `backend/.env` na VPS estava `664` → deixar `600` (o deploy já grava assim).

### Swagger
O Swagger (`/swagger`, gerado no build por `swag init`) só cobre as rotas com anotação
`@Router` nos handlers. Ver a seção de Swagger em [01](01-arquitetura-backend.md).

### Histórico: deploy pendente (até 28/10)
Vários módulos aparecem na memória do projeto como **UNCOMMITTED / pendentes de deploy**.
A documentação descreve o **código no disco**, não necessariamente o que roda em PROD.
Itens conhecidos aguardando deploy (confirmar antes de assumir que estão no ar):
- Ajuste de redirect do link mágico + HTML de e-mail seguro;
- Correções da aba de auditoria e da aba 💧 Água (ex.: bug "analisar UC" mostrando fatura
  de outra unidade);
- Estilo do `AssistentePage` (composer estilo Claude web), resize do `InformativoModal`;
- Trava do solicitante (write-lock) no `handlers/solicitacoes.go`.

## Observações de projeto (não são bugs)
- **Repasse persiste em duas tabelas** (`FT_PROCESSOS` + `FT_DEFERIMENTOS`); o front lê de
  `FT_DEFERIMENTOS`. O UPSERT com `COALESCE` só-NULL faz campo omitido virar no-op — não
  dá para limpar campo para NULL por esse caminho (ver [04](04-fluxo-requisicao-processo.md)).
- **Divergência de valores históricos de repasse NÃO é bug** — não recalcular/dropar.
- `SCHEMA_RESSARCIMENTO.sql` é baseline de 2026-05-29 e já divergiu do schema vivo — use
  o código como fonte da verdade (ver [03](03-modelo-de-dados.md)).

## Checklist de hardening (resumo priorizado)

1. [ ] Remover `bypassPermissions` do `run_worker.sh` → `allowedTools` escopados.
2. [ ] Criar usuário MySQL read-only para os workers de leitura.
3. [ ] Adicionar guarda de papel (`GestorMiddleware`) nas rotas de escrita `/api/v2`.
4. [ ] Tirar credencial hardcoded do `agua_motor.py` (ler do `.env`) + rotacionar.
5. [ ] `DB_APP_TLS=rds` (verificação de cadeia) após validar da VPS.
6. [ ] Sobrescrever senhas default do MySQL no compose de produção.
7. [ ] Definir `CRON_TOKEN` para ativar a aplicação de regras.
8. [ ] Resolver colisão de cron água × pdf_pipeline (quinta 02:00).
9. [ ] Tirar senhas do código dos 53 arquivos Python e versioná-los; rotacionar a senha.
10. [ ] Varredura de segredos no histórico do Git (repo esteve público).
11. [ ] 2FA na conta do GitHub + ambiente `production` com aprovação obrigatória.
12. [ ] Atualizar excelize quando sair versão com as correções.
