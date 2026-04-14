# Banco de Dados

## Bancos

| Identificador | Host | Banco | Usado para |
|--------------|------|-------|-----------|
| `GormDB_App` / `DB_App` | Amazon RDS | `db_ressarcimento` | Processos, usuários, alertas, fichas, cache de faturas |
| `GormDB_Faturas` / `DB_Faturas` | 179.127.27.122 | `sgeeasy_clientes_novo` | Faturas originais das UCs |

> **Importante:** `fichas_anomalias_cache` e `Faturas_Registradas_Cache` existem em **ambos** os bancos,
> mas JOINs entre elas só funcionam via `GormDB_App` (mesmo servidor RDS).

---

## Tabelas Principais — db_ressarcimento

### Processos

| Tabela | Descrição |
|--------|-----------|
| `FT_PROCESSOS` | Processo de ressarcimento (id, etapa, status) |
| `FT_REQUISICOES` | Dados da requisição (UC, cliente, concessionária, data_criacao) |
| `DM_ETAPAS_PROCESSO` | Dimensão de etapas do Kanban |
| `FT_HISTORICO_MOVIMENTACOES` | Auditoria de movimentações por processo |
| `FT_DEFERIMENTOS` | Valores deferidos/ressarcidos por processo |
| `FT_COMENTARIOS` | Comentários dos analistas nos processos |

### Usuários e Alertas

| Tabela | Descrição |
|--------|-----------|
| `DM_USUARIOS` | Usuários do sistema (id, nome, email, tipo_conta) |
| `FT_ALERTAS` | Alertas/lembretes (para_todos, data_alerta, email_enviado_em) |

### Faturas e Análise

| Tabela | Descrição |
|--------|-----------|
| `Faturas_Registradas_Cache` | Cache de faturas com consumo e valores |
| `fichas_anomalias_cache` | Anomalias detectadas pelo motor de regras (F01–F05) |

### IA e Chat

| Tabela | Descrição |
|--------|-----------|
| `AI_CHAT_LOG` | Log de perguntas e respostas do AISURE |
| `AI_CHAT_SESSIONS` | Sessões do chat RAG |
| `AI_CHAT_MESSAGES` | Mensagens das sessões RAG |

---

## Fichas de Anomalia (F01–F05)

| Código | Nome | Descrição |
|--------|------|-----------|
| F01 | Fórmula | Erro na aplicação de fórmula tarifária |
| F02 | Desvio | Desvio de consumo em relação à média histórica |
| F03 | Acúmulo | Acúmulo anormal de consumo |
| F04 | Medidor | Suspeita de problema no medidor |
| F05 | Leitura | Leitura inconsistente |

---

## Equipe de Ressarcimento (IDs fixos)

| ID | Nome |
|----|------|
| 1 | Alisson Rodrigues |
| 1000 | Luana Nascimento |
| 1001 | Eliane Fátima de Araújo |
| 1003 | Paulo Giovani Pereira Passos |
| 1004 | Eduardo Navarro |
