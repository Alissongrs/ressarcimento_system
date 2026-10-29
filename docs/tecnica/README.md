# Documentação Técnica — SURE / Sistema de Ressarcimento

> Conjunto de documentação técnica do sistema **SURE** (AM Energia) — gestão de
> ressarcimento de energia elétrica e água. Gerado a partir de varredura do
> código em **2026-10-13**, atualizado em **2026-10-29** (protocolos ANEEL,
> tarefas/sininho, WhatsApp, GitHub + CI/CD + deploy). Para a versão ilustrada (não-técnica), veja o site HTML
> que acompanha esta entrega.

## Como ler

Cada arquivo cobre um módulo. A ordem recomendada para quem está chegando:

| # | Documento | O que cobre |
|---|-----------|-------------|
| 00 | [Visão geral](00-visao-geral.md) | O que é o sistema, stack, pastas, ambientes |
| 01 | [Arquitetura do backend](01-arquitetura-backend.md) | Boot, rotas, middleware, conexões de banco, SSE, scheduler |
| 02 | [Autenticação e perfis](02-autenticacao-e-perfis.md) | Login por link mágico, JWT, papéis, trava do solicitante |
| 03 | [Modelo de dados](03-modelo-de-dados.md) | Dicionário das tabelas principais (energia, água, fluxo, domínios) |
| 04 | [Fluxo requisição → processo → ressarcimento](04-fluxo-requisicao-processo.md) | Ciclo de vida do pleito, aprovação em 2 passos, movimentações |
| 05 | [Motor de desvio](05-motor-de-desvio.md) | Fichas F01–F05 (energia) e FA02 (água), fórmulas, gates |
| 06 | [Pipeline de extração e OCR](06-pipeline-extracao-ocr.md) | PDF → OCR/LLM → `FATURA_DADOS_EXTRAIDOS`, parsers, flags |
| 07 | [Frontend](07-frontend.md) | Páginas, componentes, roteamento por perfil, assistente, SSE |
| 08 | [Operação, infra e workers](08-ops-infra-workers.md) | Docker, VPS, cron, worker `claude -p`, backups, integrações |
| 09 | [Segurança e pendências](09-seguranca-e-pendencias.md) | Achados de segurança, dívidas técnicas, itens de deploy |
| 10 | [Protocolos ANEEL, tarefas, sininho e WhatsApp](10-protocolos-aneel-tarefas-avisos.md) | Monitor da Ouvidoria ANEEL (e-mail 15 min + extensão), tarefas com responsável, Ciente/Assumir, avisos no grupo, métricas e relatórios de protocolos |
| 11 | [GitHub, CI/CD e deploy](11-github-cicd-deploy.md) | Repositório, o que fica fora do Git, Actions, deploy pelo botão, segredos/`ENV_FILE`, chave SSH, rollback |

## Convenções

- **Nomes de tabela** em MAIÚSCULAS (`FATURA_DADOS_EXTRAIDOS`, `FT_PROCESSOS`…).
- Caminhos de arquivo relativos à raiz `ressarcimento_system/`.
- Referências `arquivo.go:123` apontam linha aproximada (podem deslocar com edições).
- ⚠️ marca armadilha, risco ou ponto que exige atenção.
- Credenciais/segredos **nunca** aparecem aqui — só o **nome** da variável de ambiente.

## Dois bancos de dados

O sistema fala com dois MySQL distintos (ver [03](03-modelo-de-dados.md)):

- **`db_ressarcimento`** (Amazon RDS) — banco da aplicação: processos, requisições,
  fichas, dados extraídos, usuários. É o `DB_APP_URL`.
- **`sgeeasy_clientes_novo`** (host `179.127.27.122`) — banco **origem** das faturas
  (energia e água) de onde o pipeline extrai/sincroniza. É o `DB_FATURAS`.
