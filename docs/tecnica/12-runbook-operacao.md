# 12 — Runbook de operação

O que fazer quando algo acontece. Escrito para quem opera o SURE, não para quem o programa.
Caminhos são relativos à raiz `ressarcimento_system/`; na VPS o repositório fica em
`/opt/ressarcimento/ressarcimento_system`.

## 1. Subir uma mudança (deploy)

1. No PC, na raiz do repositório: `.\deploy.ps1`. Ele faz commit e push, dispara o pipeline e acompanha.
2. Quando o job **Deploy VPS** pedir aprovação, o script pergunta; digite `s`.
3. Em 10 a 15 minutos o site está atualizado. Conferir: abrir o SURE, e para a extensão
   `https://sure.app.br/extensao_sure.json` mostra a versão servida.

**Deu errado depois do deploy?** `git revert <commit>` na branch `dev`, push e deploy de novo.
O pipeline tem healthcheck e rollback automático da imagem; detalhes em [11](11-github-cicd-deploy.md).

**O CI recusou por "Rotas novas sem Swagger"**: na pasta `backend`, rode
`python scripts/gen_swagger_rotas.py` e inclua `handlers/zz_swagger_rotas_gen.go` no commit
(o `deploy.ps1` já faz isso sozinho).

## 2. Uma rotina do cron não rodou ou falhou

As rotinas estão em `worker/crontab.sure` (horários no fuso da VPS). Cada uma escreve um log em
`worker/`:

| Rotina | Quando | Log | Rodar à mão (na VPS) |
|---|---|---|---|
| Fila do chat (`run_worker.sh`) | a cada 3 min | `worker/worker.log` | `worker/run_worker.sh` |
| Executor de pedidos (`run_executor.sh`) | a cada 1 min | `worker/executor.log` | `worker/run_executor.sh` |
| Jobs pedidos pela tela (`run_jobs.sh`) | a cada 1 min | `worker/run_jobs.log` | `worker/run_jobs.sh` |
| Extração de faturas (`job_pdf_pipeline.sh`) | seg e qui 02:00 | `worker/pdf_pipeline.log` | `worker/job_pdf_pipeline.sh` |
| Água (`job_agua.sh`) | ter e qui 02:00 | `worker/agua.log` | `worker/job_agua.sh` |
| Regras de auditoria (`job_regras.sh`) | 00:00 | `worker/regras.log` | `worker/job_regras.sh` |
| Protocolos ANEEL (`job_aneel.sh`) | 05:30 | `worker/aneel.log` | `worker/job_aneel.sh` |
| Backup (`backup_sistema.sh`) | 03:00 (sex: semanal) | `/opt/ressarcimento/backups/backup.log` | `worker/backup_sistema.sh rotativo` |

Desde 13/11/2026 cada rotina registra no banco que rodou (`worker/registrar_execucao.py`, chamado
pelos `.sh` via `rotina_lib.sh`) e o que fez. O cartão **Tarefas do sistema → Rotinas** mostra cada uma
com o estado (OK, atrasada, erro, travada, rodando, sem sinal), o último sinal e o histórico das
execuções. O backend confere a cada 15 min e avisa **uma pessoa** (escolhida no próprio cartão: alerta
na tela e, se houver celular e o WhatsApp do departamento estiver conectado, mensagem no WhatsApp);
repete o mesmo problema só depois de 24 h e avisa quando volta ao normal. Tabelas:
`FT_ROTINAS_HEARTBEAT`, `FT_ROTINAS_EXECUCOES`, `FT_ROTINAS_AVISOS`; o catálogo do que se espera de
cada rotina está em `backend/saude/saude.go`.

Passos:
1. Na tela **Tarefas do sistema**, cartão **Rotinas**: veja o estado e o motivo; abra o histórico da rotina.
2. Na VPS, `tail -100` do log da rotina. As mensagens dizem o motivo (sem credencial).
3. Se foi falta de rede ou um arquivo travado, rode à mão com o comando da tabela. Todas as rotinas
   usam `flock`: não rodam duas ao mesmo tempo.
4. Se a rotina depende do Drive (`rclone`), confira `rclone listremotes` → tem que listar `gdrive:`.
   Como configurar: `worker/RCLONE_SETUP.md`.

## 3. Reverter um pedido feito pelo chat

O executor guarda o antes/depois de tudo o que grava em `FT_EXECUTOR_BACKUP`. Para desfazer:
no chat, digite `#protocolo N` (N = número do pedido): aparece o que foi feito e o botão
**Reverter** (rota `POST /api/v1/solicitacoes/N/reverter`). O pedido fica com status `revertido`.
Só processos podem ser alterados pelo executor (lista permitida); qualquer outra tabela é recusada.

## 4. Status de um processo diferente do histórico

Desde 12/11/2026 toda mudança de status grava a movimentação no histórico na mesma transação.
O estoque antigo e qualquer caso novo aparecem em **Tarefas do sistema → Status × histórico**,
com a direção sugerida pelas datas:
- *Registrar no histórico*: a lista está certa e faltou a movimentação (o mais comum).
- *Atualizar a lista*: a movimentação é mais nova e a lista ficou para trás.

Cada correção grava backup em `FT_STATUS_RECONCILIACAO`. Uma rotina do backend confere todo dia
às 06:30 e avisa os administradores enquanto houver diferença.

## 5. Login

- **Senha + código do autenticador** (padrão desde 12/11/2026): e-mail e senha; se a conta tem o
  autenticador ativo, a tela pede em seguida o código de 6 dígitos do Microsoft Authenticator.
  Quem ativa o autenticador faz isso em *Minha conta* (clique no próprio nome, no alto da tela).
  Perdeu o celular: use um código de recuperação (8 foram mostrados na ativação). Perdeu os dois:
  um administrador zera o autenticador da pessoa com `POST /api/v2/auth/totp/desativar/{id_usuario}`
  (pelo Swagger, logado como admin) e ela ativa de novo.
- **Esqueci minha senha**: manda o link por e-mail; ao entrar por ele, a pessoa cai em *Minha conta*
  e define a senha nova. Depende do e-mail da empresa estar no ar.
- **Link por e-mail** continua como opção ("Entrar com link por e-mail"); é também o caminho do
  primeiro acesso (cria o usuário) e de quem ainda não tem senha.
- **Só com o código**: quem tem o autenticador ativo entra com e-mail + código, sem senha.
- Novo usuário: criado sozinho no primeiro acesso com e-mail dos domínios permitidos
  (`REGISTER_ALLOWED_DOMAINS`), com perfil `solicitante`. Mudar o perfil: tela de administração.

## 6. Extensão do Chrome (ANEEL)

- Instalar/atualizar: botão **Baixar a extensão do SURE** (telas Tarefas do sistema e Protocolos
  ANEEL), descompactar por cima da mesma pasta e clicar em ↻ em `chrome://extensions`.
- Login automático na Ouvidoria: **Detalhes → Opções da extensão**, seção "Ouvidoria da ANEEL".
  A verificação "não sou um robô" é sempre da pessoa; o sistema não a contorna.
- Gerar uma versão nova para todos: alterar `extensao_aneel/manifest.json` (versão), rodar
  `python ferramentas/empacotar_extensao.py` e fazer deploy (o zip fica em `frontend/public/`).
- Só funciona em computador. No celular não há extensão; para operar de fora, acesso remoto ao
  computador que tem a extensão.

## 7. Faturas da Claro

Desde 12/11/2026 a atualização é manual (o módulo da extensão foi removido). O servidor continua
sabendo processar um lote: `worker/job_claro.sh` baixa o zip, extrai para o banco, sobe os PDFs para
o Drive e grava os links; a fila e o marco estão em `worker/claro_fila/` (ver `LEIAME.md` lá).

## 8. Backups e onde estão

- **Banco e arquivos**: `/opt/ressarcimento/backups/rotativo` (6 gerações diárias) e `/semanal`
  (4 gerações), feitos por `worker/backup_sistema.sh`. Restaurar: importar o `.sql.gz`. As tabelas
  pesadas de faturas (`TBL_FDE`, `FATURA_CLARO_DADOS_EXTRAIDOS`, `FATURA_AGUA_DADOS`) entram só com
  estrutura: são regeneráveis pela extração.
- **Correções manuais** (feitas em sessão com o Claude): JSON com as linhas antes da alteração em
  `Docker\_backups_banco\`, fora do repositório, um arquivo por correção.
- **Ações reversíveis dentro do sistema**: `FT_EXECUTOR_BACKUP` (pedidos do chat) e
  `FT_STATUS_RECONCILIACAO` (status × histórico).

## 9. Banco de dados

- Nada é escrito no banco de produção sem aprovação e sem backup. Consultas e relatórios podem.
- Mudança de esquema: uma linha em `backend/database/migrations_additive.go`, só aditiva
  (`ADD COLUMN`, `CREATE TABLE IF NOT EXISTS`, índice). Remoção ou mudança de tipo vai como migração
  versionada revisada.
- Valores históricos de repasse não se recalculam: divergência entre crédito × percentual e o
  valor gravado é negociação antiga, não erro.

## 10. Onde ficam os scripts que rodaram uma vez

Em `ops/`, por mês e assunto, com o `MANIFESTO.md` dizendo de onde cada arquivo veio. Pastas de
código não recebem script pontual, backup, planilha nem binário.
