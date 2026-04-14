# Backend — Rotas e Handlers

## Autenticação

| Método | Rota | Handler | Descrição |
|--------|------|---------|-----------|
| POST | `/api/v1/auth/login` | AuthLogin | Login com JWT |
| POST | `/api/v1/auth/refresh` | AuthRefresh | Renovar token |
| POST | `/api/v1/auth/logout` | AuthLogout | Logout |

---

## Processos

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/v1/processos` | Listar processos (filtros) |
| POST | `/api/v1/processos` | Criar processo |
| GET | `/api/v1/processos/:id` | Detalhe do processo |
| PUT | `/api/v1/processos/:id` | Atualizar processo |
| DELETE | `/api/v1/processos/:id` | Remover processo |
| POST | `/api/v1/processos/:id/mover` | Mover para etapa |
| GET | `/api/v1/processos/:id/historico` | Histórico de movimentações |

---

## Alertas

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/v1/alertas` | Listar alertas do usuário |
| POST | `/api/v1/alertas` | Criar alerta (envia e-mail ao criador se pessoal) |
| PUT | `/api/v1/alertas/:id` | Atualizar alerta |
| DELETE | `/api/v1/alertas/:id` | Remover alerta |
| POST | `/api/v1/alertas/ack` | Confirmar alertas |
| GET | `/api/v1/alertas/stream` | SSE — stream de notificações |
| POST | `/api/v1/admin/alertas/disparar-agora` | Disparo manual de e-mails |
| POST | `/api/v1/admin/alertas/disparar-agora?force=1` | Força envio independente de data |

---

## AISURE Chat

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/v1/chat/processos` | Pergunta ao assistente (retorna texto + gráficos) |
| GET | `/api/v1/chat/processos/contexto` | Debug — ver contexto atual do banco |
| POST | `/api/v1/chat/rag` | Chat com RAG (documentos) |
| POST | `/api/v1/chat/upload` | Upload de arquivos para o RAG |
| POST | `/api/v1/chat/learn` | Treinar com novos documentos |
| POST | `/api/v1/chat/feedback` | Feedback de resposta |
| GET | `/api/v1/chat/sessions` | Listar sessões de chat |
| POST | `/api/v1/chat/sessions` | Criar sessão |
| DELETE | `/api/v1/chat/sessions/:id` | Remover sessão |

---

## Análise de Desvio (Faturas)

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/v1/faturas/ucs-resumo` | Lista UCs com anomalias e fichas detectadas |
| GET | `/api/v1/faturas/uc/:uc/consumo-chart` | Dados do gráfico de consumo de uma UC |
| GET | `/api/v1/faturas/uc/:uc/timeline` | Timeline completa da UC |

---

## Admin

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/v1/admin/planilha` | Planilha geral |
| POST | `/api/v1/admin/planilha/import` | Importar dados |
| GET | `/api/v1/admin/prazos` | Configurar prazos por etapa |
| GET | `/api/v1/admin/alarmes` | Regras de alarme |
| POST | `/api/v1/admin/score/precalcular` | Recalcular scores |

---

## Serviços Internos (services/)

| Arquivo | Função |
|---------|--------|
| `automation_service.go` | `SendEmail`, `SendEmailDetailed`, `SendEmailDetailedWithAttachments` |
| `alertas_equipe_service.go` | `ChecarAlertasParaTodos`, `DispararAlertasParaTodosForce`, `EnviarAlertaPessoal` |

---

## Padrão de Resposta

```json
// Sucesso
{ "message": "..." }

// Erro
{ "error": "descrição do erro" }

// Lista
[ { ... }, { ... } ]
```

---

## Middlewares

| Middleware | Descrição |
|-----------|-----------|
| `AuthRequired` | Valida JWT — qualquer usuário logado |
| `GestorRequired` | Valida JWT + perfil gestor/admin |
| `AuthOrQueryToken` | Auth via header ou query param (para SSE) |
| `RateLimit` | Limite de requisições por IP |
| `CORS` | Configurado para o domínio da aplicação |
