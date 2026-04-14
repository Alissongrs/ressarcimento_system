# Frontend — Páginas e Componentes

## Páginas (src/pages/)

| Arquivo | Rota | Descrição |
|---------|------|-----------|
| `LoginPage.jsx` | `/login` | Tela de login |
| `HomeGestorAdmin.jsx` | `/inicio` | Dashboard principal |
| `ControleProcessos.jsx` | `/processos` | Kanban de processos |
| `Requisicoes.jsx` | `/requisicoes` | Lista de requisições |
| `RequisicaoForm.jsx` | `/requisicao/nova` | Formulário novo processo |
| `Auditoria.jsx` | `/auditoria` | Auditoria IA |
| `AnaliseDesvio.jsx` | `/analise-desvio` | Análise de faturas + gráficos |
| `AdminPlanilha.jsx` | `/admin/planilha` | Planilha administrativa |
| `AdminEditor.jsx` | `/admin/editor` | Editor de processo completo |
| `AdminPrazos.jsx` | `/admin/prazos` | Configuração de prazos |
| `CaixaDeEmail.jsx` | `/email` | Caixa de e-mail |
| `Ocr.jsx` | `/ocr` | OCR de faturas |
| `RelatoriosMetricas.jsx` | `/relatorios` | Relatórios e métricas |
| `DashboardAuditoria.jsx` | `/dashboard-auditoria` | Dashboard de auditoria |

---

## Componentes Principais (src/components/)

| Componente | Descrição |
|-----------|-----------|
| `GlobalChatWidget.jsx` | AISURE — chat flutuante com gráficos e exportação CSV |
| `ThemeButton.jsx` | Seletor de tema (12 temas disponíveis), fixo no canto inferior direito |
| `AlertCalendarModal.jsx` | Modal do calendário de alertas |
| `AlertTicker.jsx` | Ticker de alertas no topo da tela |
| `AlertsModal.jsx` | Modal de lista de alertas |
| `FloatingEmailComposer.jsx` | Compositor de e-mail flutuante |
| `CommandPaletteHost.jsx` | Paleta de comandos (Ctrl+K) |
| `ProcessoCard.jsx` | Card do processo no Kanban |
| `HistoricoModal.jsx` | Modal de histórico de movimentações |
| `DetalhesProcessoModal.jsx` | Modal de detalhes do processo |
| `Layout.jsx` | Layout principal com sidebar |
| `Login.jsx` | Componente de formulário de login |
| `ThemeSwitcher.jsx` | Contexto de tema |

---

## Posicionamento dos Botões Flutuantes

```
┌─────────────────────────┐
│                         │
│      [conteúdo]         │
│                         │
│              [AISURE]   │ ← bottom: 72px, right: 16px
│              [Tema  ]   │ ← bottom: 16px, right: 16px
└─────────────────────────┘
```

---

## Temas Disponíveis

| Valor | Nome |
|-------|------|
| `dark` | Escuro |
| `light` | Claro (Padrão) |
| `light-1` | Claro A (roxo) |
| `light-2` | Claro B (verde) |
| `light-3` | Claro C (azul) |
| `light-4` | Claro D (cinza) |
| `pink` | Rosa |
| `pinklight` | Rosa Claro |
| `sap` | SAP |
| `navy` | Marinho |
| `orange-gray` | Laranja + Cinza |
| `green-orange` | Verde + Laranja |
| `orange-purple-green` | Laranja + Roxo + Verde |

---

## Serviços (src/services/)

| Arquivo | Funções principais |
|---------|-------------------|
| `apiClient.js` | Axios configurado com baseURL e interceptors JWT |
| `authService.js` | login, logout, refreshToken |
| `alertaService.js` | getAlertas, createAlerta, updateAlerta, ackAlertas |
| `chatService.js` | askRag, askProcessosChat, sendChatFeedback, sessões |
| `requisicaoService.js` | getRequisicoes, createRequisicao, moverProcesso |
| `relatoriosService.js` | getRelatorios, exportRelatorio |
| `ocrService.js` | uploadFatura, processOcr |

---

## AISURE — Gráficos (GlobalChatWidget.jsx)

Os gráficos são renderizados automaticamente após cada resposta do assistente,
baseados nos dados retornados no campo `context` da API.

| Chave do context | Gráfico | Cor |
|-----------------|---------|-----|
| `ressarcimento_mensal` | AreaChart (valor R$) | Indigo |
| `abertura_mensal` | AreaChart (qtd processos) | Cyan |
| `por_etapa` | PieChart | Multi |
| `por_cliente` | BarChart horizontal | Multi |
| `por_concessionaria` | BarChart vertical | Vermelho |
| `media_movimentacoes` | BarChart | Multi |
| `tempo_por_etapa` | BarChart | Multi |

**Exportação CSV:** botão aparece junto aos gráficos com os dados tabelados.

**Modo expandido:** gráficos ficam maiores (200px vs 160px de altura).
