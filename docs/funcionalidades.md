# Funcionalidades do Sistema

## 1. Kanban de Processos

Quadro visual com colunas por etapa. Cada card representa um processo de ressarcimento.

- Arrastar e soltar para mover entre etapas
- Filtros por concessionária, cliente, UC, analista
- Score de progressão por processo
- Histórico de movimentações com comentários
- Alertas de prazo por etapa

---

## 2. AISURE — Assistente de Processos

Chat inteligente flutuante (botão no canto inferior direito, acima do botão Tema).

**Acesso:** disponível para todos os usuários logados (oculto na tela de login).

**O que responde:**
- Processos por etapa, parados, recentes
- Totais financeiros e valor deferido
- Detalhes de processo específico (ex: "me fale sobre o proc 42")
- Processos de uma UC (ex: "UC 94122288")
- Alertas vencidos ou vencendo hoje

**Gráficos automáticos em cada resposta:**
| Gráfico | Tipo |
|---------|------|
| Ressarcimento mensal (12 meses) | Área |
| Abertura de processos por mês | Área |
| Distribuição por etapa | Pizza |
| Top clientes por processos | Barra horizontal |
| Por concessionária | Barra |
| Média de movimentações por etapa | Barra |
| Tempo médio por etapa (dias) | Barra |

**Exportar:** botão CSV aparece junto aos gráficos.

**Endpoint:** `POST /api/v1/chat/processos`

---

## 3. Alertas e Lembretes

Sistema de alertas com notificação por e-mail.

### Tipos de alerta

| Tipo | Destinatário | Quando envia e-mail |
|------|-------------|-------------------|
| Pessoal (`para_todos=false`) | Criador do alerta | Imediatamente ao criar |
| Equipe (`para_todos=true`) | 5 membros da equipe | No dia do vencimento (08:00) |

### Disparo manual (admin)
```
POST /api/v1/admin/alertas/disparar-agora
POST /api/v1/admin/alertas/disparar-agora?force=1   ← ignora filtro de data
```

### Template de e-mail
- Header com gradiente azul escuro → azul (cores AM Energia)
- Badge de urgência dinâmico (Vence hoje / Vence amanhã / Vencido / Vence em X dias)
- Botão CTA "Ver meus lembretes →"
- Remetente: `complaint@amee.com.br` via Microsoft Graph API

---

## 4. Análise de Desvio

Página dedicada à análise de faturas e detecção de anomalias.

### Visão Por UC
- Tabela com todas as UCs com anomalias detectadas
- Filtro por ficha (F01–F05) com contadores
- Badge colorido por tipo de ficha

### Gráfico de Consumo
- Barras mensais com consumo kWh por UC
- Clique na barra abre a fatura do mês correspondente
- Marcações acima das barras indicando qual ficha foi detectada

### Fluxo de análise
1. **Motor de regras** (SQL determinístico) detecta anomalia → cria ficha em `fichas_anomalias_cache`
2. **IA (AISURE)** pode confirmar ou descartar a anomalia com base no histórico da UC

---

## 5. Caixa de E-mail

Compositor de e-mail flutuante para envio diretamente do sistema.
- Destinatários com autocomplete
- Assunto e corpo livre
- Envio via Microsoft Graph API

---

## 6. OCR de Faturas

Upload de PDF de fatura → extração automática de dados via OCR + IA.
- Identifica UC, cliente, concessionária, período, valores
- Salva os dados extraídos no processo

---

## 7. Dashboard

Página inicial com estatísticas gerais:
- Processos por etapa (gráfico)
- Movimentações recentes
- Alertas pendentes
- Score de progressão da carteira

---

## 8. Histórico e Auditoria

- Trilha de auditoria completa por processo
- Filtros por período, analista, etapa
- Exportação de relatórios
