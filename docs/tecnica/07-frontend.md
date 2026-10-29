# 07 — Frontend

React 18 + Vite. Bibliotecas: react-router-dom (BrowserRouter), @tanstack/react-query
(staleTime 30s), axios, recharts, @dnd-kit (Kanban), ReactQuill (e-mail/avisos),
lucide-react, DOMPurify. Tema por CSS vars (`theme.css` + `context/ThemeContext.jsx`).

## App shell e roteamento — `App.jsx` / `main.jsx`

- `main.jsx` monta `<App/>` dentro de `QueryClientProvider` → `AuthProvider`.
- `App.jsx` envolve em `ThemeProvider` → `EmailComposeProvider` → `<Router>`. Renderiza
  `TopNav` (nav horizontal) + `main`. `RouteKeeper` persiste/restaura a última rota.
  Maioria das páginas é `lazy()` + `<Suspense>` (recharts/xlsx carregam sob demanda).
- **Gating por papel** (`role = user.tipo_conta`): não há `<ProtectedRoute>`; as rotas
  são renderizadas condicionalmente por papel, redirecionando via `<Navigate>`.

### Tabela de rotas (logado)

| Rota | Componente | Acesso |
|------|-----------|--------|
| `/` | `Home` (gestor/admin) **ou** `AssistentePage` (solicitante) | todos |
| `/prazos` | `Prazos` | todos |
| `/solicitacoes` | `Solicitacoes` | todos (painel se auto-limita ao aprovador) |
| `/backlog` | `Backlog` | todos |
| `/novo` | `RequisicaoForm` | todos |
| `/conta` | `MinhaConta` | todos |
| `/auditoria` | `Auditoria` | todos |
| `/Requisicoes` | `Requisicoes` | gestor/admin |
| `/gestao` | `GestaoRequisicoes` | gestor/admin |
| `/processos`, `/controle-processos-v2` | `ControleProcessosV2` | gestor/admin |
| `/processos/:id` | `ProcessoDetalhePage` | gestor/admin |
| `/analise-desvio` (`/:id`) | `AnaliseDesvio` | gestor/admin |
| `/ocr-lote` | `OcrLote` | gestor/admin |
| `/regras` | `Regras` | gestor/admin |
| `/claro` | `ConsultaClaro` | gestor/admin |
| `/caixa-de-email` | `CaixaDeEmail` | gestor/admin |
| `/historico` | `HistoricoFixed` | **só admin** |
| `/dashboard` | `Relatorios` → `RelatoriosMetricas` | **só admin** |
| `/admin/feedbacks` | `AdminFeedbacks` | admin |
| `/login`, `/register` | `LoginPage`, `Register` | deslogado |

> O menu do **solicitante** é reduzido a um único item "Assistente".

## apiClient — `services/apiClient.js`
Instância axios: `baseURL: ''`, `withCredentials: true` (auth primária = cookie
`auth_token`). Interceptor prefixa URLs relativas com `/api/v1/` e adiciona
`Authorization: Bearer <token>` do localStorage como fallback. Extras: **dedupe de writes
em voo**, contador global `app-saving`, retry de erro de rede transitório, `auth:expired`
em 401. Helper `withAuthToken(url)` anexa `?token=` para SSE/download. Serviços por
feature em `services/` (requisicaoService, processoV2Service, relatoriosService,
mailService, assistenteService, solicitacoesService, chatService, alertaService…).

## Páginas (`src/pages/`)

- **`AssistentePage`** — chat tela cheia do **solicitante** (default `/` desse papel):
  Q&A determinístico sobre processo/movimentações, relatório do cliente, tempo médio;
  valor/data só quando há deferimento; composer com auto-grow.
- **`AnaliseDesvio`** — "Auditoria de Faturas": abas de fichas F01–F61, gráficos de
  consumo, abre `ModalFaturaMontada`; hospeda a aba **💧 Água** (`AguaPanel`) e **🅰️ Acer**
  (`AcerPanel`), além de `AuditoriaRankings` e `CatalogoFichasModal`.
- **`Auditoria`** — lista de processos com badges de ficha (view mais leve).
- **`GestaoRequisicoes`** — Kanban de requisições (dnd-kit) com aprovar/rejeitar.
- **`Requisicoes`** / **`RequisicaoForm`** (`/novo`) — gestão e criação de requisições.
- **`ControleProcessosV2`** (`/processos`) — board principal de processos (v2): tabela
  densa tipo Excel, abas por etapa, filtros, KPIs, export (`ExportModal`),
  `ProcessoDrawer`.
- **`ProcessoDetalhePage`** (`/processos/:id`) — detalhe dedicado do processo.
- **`Prazos`** — SLA de processos "Aguardando retorno" perto/depois do prazo; envia
  cobrança por e-mail.
- **`RelatoriosMetricas`** — dashboard de métricas (KPIs recharts, composição do Kanban).
- **`Solicitacoes`** — fila de pedidos "#sistema" (gated ao aprovador) → `SolicitacoesPanel`.
- **`CaixaDeEmail`** — cliente de e-mail completo (Graph): pastas, ler/responder/
  encaminhar, anexar a processo, compor (ReactQuill), render com DOMPurify.
- **`ConsultaClaro`** — browser read-only das faturas Claro (~695k), tabela paginada no
  servidor + link do PDF no Drive.
- **`Regras`** — catálogo editável das 61 fichas (F01–F61): interpretação, faturas
  exigidas, critérios, passo a passo; "Alterar" (com backup), "Melhorar com IA",
  "Testar fatura" (anexa 1–13 PDFs → fila → agente Claude na VPS → laudo).
- **`OcrLote`** — upload de OCR em lote (blocos de 30, até 300), com polling.
- **`HistoricoFixed`** (admin) — histórico de movimentações (`/api/v2/historico`).
- **`Backlog`**, **`ChatRequisicao`**, **`MinhaConta`** (vínculo Entra),
  **`AdminFeedbacks`**.

> Legado/não roteado: `Welcome`, `HomeGestorAdmin` (só exporta o `CobrancaEmailModal`),
> `ApontamentosOrigem`, `AdminEditor` (redireciona para `/`).

## Componentes reutilizáveis (`src/components/`)

- **`ProcessoDrawer/`** — drawer lateral com 7 abas (Resumo, Histórico, Anexos,
  Deferimento, Faturamento, Repasse, Encerramento); **só a aba da etapa atual é editável**.
- **`ModalFaturaMontada/`** — "fatura montada" a partir de um apontamento: gráfico de
  consumo + abrir PDF + todos os campos capturados agrupados.
- **`ModalAuditoriaComparativa/`** — comparação 3 colunas (FDE / Sgeeasy / IA) com
  validação por coluna; grava na FDE via `/validar-comparativo`.
- **`ModalCorrigirDadosFatura/`** — analista corrige campos extraídos; `PATCH
  /api/v1/faturas/:id`, cada mudança logada em `FT_AUDIT_EDICAO`.
- **`AguaPanel`** — aba 💧 (apontamentos de água; gerar requisição / rejeitar / PDF /
  histórico). **`AcerPanel`** — aba Acer (empresa 2028).
- **`ConvergenciaAba`**, **`LacunasSgeeasy`**, **`AuditoriaRankings`**,
  **`CatalogoFichasModal`** — apoio à auditoria.
- **`SolicitacoesPanel`** — fila de pedidos do chat (aprovar → fila do Claude / reverter),
  auto-refresh 15s.
- **`MetaDeferimentoBar/`** — barra realizado × meta com drill-down (ano/mês/empresa).
- **`CommandPalette`** — launcher ⌘K com busca no banco.
- **`InformativoModal`** — janelinha de novidades (ver abaixo).
- **`GlobalChatWidget`** — chat global flutuante com acesso ao banco (gestor/admin).
- Alertas: `GlobalNewProcessNotifier`, `AlertTicker`, `NavBell`, `Toast`.
- `charts/*` (Donut, Funnel, LineChart, Sparkline, Pareto, Heatmap…), `ui/*`
  (shadcn-style), `ErrorBoundary`, `SureLogo`.

## UX notável

- **`InformativoModal`** (novidades): modal pequeno explicando o fluxo de aprovação +
  movimentação (diagramas SVG inline) e um aviso editável. Checkbox "Não exibir mais"
  dispensa por **versão** do aviso (localStorage `sure_info_dismiss_v`); senão reaparece
  em horas redondas. Admin edita inline (publicar incrementa a versão → reexibe a todos).
- **Composer estilo Claude web**: `GlobalChatWidget` (flutuante, com mic/anexo/histórico e
  barra de progresso estimada) e `AssistentePage` (tela cheia, textarea auto-grow até
  200px).
- **SSE no front**: `App.jsx` abre `connectAlertasSSE()` (badge de não-lidos + toasts,
  fallback de polling 30s quando o `EventSource` fecha); `GlobalNewProcessNotifier` usa
  `subscribeGlobal()` para toast de processo novo (gestor); hooks `useProcessoSSE` para
  updates por processo. **E-mail não-lido é por polling (60s), não SSE.**
