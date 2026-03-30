// routes/routes.go
package routes

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	swaggerFiles "github.com/swaggo/files"
	ginSwagger "github.com/swaggo/gin-swagger"

	"ressarcimento-backend/database"
	"ressarcimento-backend/handlers"
	"ressarcimento-backend/middleware"
	"ressarcimento-backend/repositories"
	"ressarcimento-backend/services"

	"gorm.io/gorm"
)

func maskTokenQuery(raw string) string {
	if raw == "" {
		return raw
	}
	vals, err := url.ParseQuery(raw)
	if err == nil {
		if _, ok := vals["token"]; ok {
			vals.Set("token", "***")
		}
		return vals.Encode()
	}
	if idx := strings.Index(raw, "token="); idx >= 0 {
		rest := raw[idx+len("token="):]
		if end := strings.Index(rest, "&"); end >= 0 {
			return raw[:idx] + "token=***" + rest[end:]
		}
		return raw[:idx] + "token=***"
	}
	return raw
}

func registerGestorHistoricoRoutes(group *gin.RouterGroup) {
	group.POST("/processos/:id/historico/:hid/anexos", handlers.AddHistoricoAnexo)
	group.POST("/processos/:id/historico/:hid/extrair-email", handlers.ExtrairDadosEmail)
}

func SetupRouter(gdb *gorm.DB) *gin.Engine {
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(gin.LoggerWithFormatter(func(param gin.LogFormatterParams) string {
		path := param.Path
		if param.Request != nil && param.Request.URL != nil && param.Request.URL.RawQuery != "" {
			raw := maskTokenQuery(param.Request.URL.RawQuery)
			if raw != "" {
				path = path + "?" + raw
			}
		}
		return fmt.Sprintf("[GIN] %v | %3d | %13v | %15s | %-7s %s\n",
			param.TimeStamp.Format("2006/01/02 - 15:04:05"),
			param.StatusCode,
			param.Latency,
			param.ClientIP,
			param.Method,
			path,
		)
	}))
	// NÃ£o confiar em proxies por padrÃ£o
	if err := r.SetTrustedProxies(nil); err != nil {
		println("[routes] aviso: falha ao definir trusted proxies:", err.Error())
	}

	// MemÃ³ria p/ multipart (uploads)
	r.MaxMultipartMemory = 512 << 20 // 512MB

	// MigraÃ§Ãµes bÃ¡sicas
	if err := database.RunMigrations(); err != nil {
		println("[routes] migraÃ§Ãµes falharam:", err.Error())
	}
	sqlDB, _ := gdb.DB()
	if sqlDB != nil {
		database.LogSnapshotSyncStatus(sqlDB)
		database.BackfillSnapshotIfEnabled(sqlDB)
	}

	// VIEW usada no Kanban Fast
	if gdb != nil {
		if err := repositories.NewHistoricoRepo(gdb).EnsureViewUltimoHistorico(context.Background()); err != nil {
			println("[routes] aviso: falha ao garantir VIEW VW_ULTIMO_HISTORICO:", err.Error())
		}
	}

	// ===== CORS =====
	cfg := cors.Config{
		AllowOrigins: []string{
			"http://localhost:3000",
			"http://localhost:5173",
			"http://127.0.0.1:5173",
			"http://127.0.0.1:3000",
		},
		AllowMethods: []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"},
		AllowHeaders: []string{
			"Origin", "Content-Type", "Authorization",
			"X-Auth-Token", "X-Session-Token", "Accept", "Cache-Control",
		},
		AllowCredentials: true,
		// Expor cabeÃ§alhos Ãºteis ao front (rate limit / auth)
		ExposeHeaders: []string{
			"Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "WWW-Authenticate",
		},
	}

	// Permite override de origens via env CORS_ALLOW_ORIGINS (lista separada por vÃ­rgulas)
	if env := strings.TrimSpace(os.Getenv("CORS_ALLOW_ORIGINS")); env != "" {
		parts := strings.Split(env, ",")
		cfg.AllowOrigins = make([]string, 0, len(parts))
		for _, p := range parts {
			p = strings.TrimSpace(p)
			if p != "" {
				cfg.AllowOrigins = append(cfg.AllowOrigins, p)
			}
		}
	}
	r.Use(cors.New(cfg))

	// Swagger (OpenAPI) UI
	r.GET("/swagger/*any", ginSwagger.WrapHandler(swaggerFiles.Handler))

	// Liberar OPTIONS (preflight) antes de autenticaÃ§Ã£o para evitar 403 em CORS
	r.Use(func(c *gin.Context) {
		if c.Request.Method == http.MethodOptions {
			c.Status(http.StatusOK)
			c.Abort()
			return
		}
	})

	// ===== RATE LIMITING GLOBAL =====
	// Aplica a todas as rotas exceto health checks
	r.Use(middleware.GlobalRateLimit())

	// ===== COMPRESSÃƒO GZIP =====
	// Comprime respostas JSON e HTML automaticamente
	r.Use(middleware.Gzip())

	// Arquivos estÃ¡ticos
	r.Static("/uploads", "./uploads")

	// ===== SSE pÃºblicas (aliases DEV) =====
	// Aceitam ?token= porque EventSource nÃ£o envia Authorization
	r.GET("/apialertasstream", middleware.AuthOrQueryToken(), handlers.StreamAlertas)
	r.GET("/apievents", middleware.AuthOrQueryToken(), handlers.StreamGlobalEvents)

	// ====== DI: processos fast (repo -> service -> handler) ======
	procRepo := repositories.NewProcessosRepo(gdb)
	procSvc := services.NewProcessosService(procRepo)
	procHandler := handlers.NewProcessosHandler(procSvc)

	// ====== DI: dashboard ======
	dashRepo := repositories.NewDashboardRepo(gdb)
	dashSvc := services.NewDashboardService(dashRepo)
	dashHandler := handlers.NewDashboardHandler(dashSvc)

	// ============================================================
	// API v1
	// ============================================================
	apiV1 := r.Group("/api/v1")
	{
		// Health checks (mÃºltiplas versÃµes para diferentes necessidades)
		apiV1.GET("/healthz", handlers.SimpleHealthCheck)   // Simples (ok: true)
		apiV1.GET("/health", handlers.AdvancedHealthCheck)  // AvanÃ§ado (verifica dependÃªncias)
		apiV1.GET("/health/live", handlers.LivenessCheck)   // Kubernetes liveness
		apiV1.GET("/health/ready", handlers.ReadinessCheck) // Kubernetes readiness

		// ===== SSE oficiais =====
		apiV1.GET("/alertas/stream", middleware.AuthOrQueryToken(), handlers.StreamAlertas)
		apiV1.GET("/events", middleware.AuthOrQueryToken(), handlers.StreamGlobalEvents)
		apiV1.GET("/processos/:id/events", middleware.AuthOrQueryToken(), handlers.StreamProcessoEvents)
		apiV1.GET("/anexos/:anexoId/download", middleware.AuthOrQueryToken(), handlers.DownloadAnexoByID)

		// ===== OCR CHAT (fora do grupo autenticado padrÃ£o)
		// Aceita Authorization: Bearer <jwt> OU ?token=<jwt> / cookies
		apiV1.POST("/ocr/chat",
			middleware.AuthOrQueryToken(),
			middleware.OCRChatRateLimit(),
			handlers.OCRChat,
		)

		// ===== DiagnÃ³stico simples (quem sou? / exp / role)
		apiV1.GET("/whoami", middleware.AuthOrQueryToken(), func(c *gin.Context) {
			uid, _ := c.Get("userID")
			userName, _ := c.Get("userName")
			role, _ := c.Get("role")
			userTipo, _ := c.Get("userTipoConta")
			c.JSON(200, gin.H{
				"userID":        uid,
				"userName":      userName,
				"role":          role,
				"userTipoConta": userTipo,
			})
		})

		// PÃºblico com rate limiting restrito para autenticaÃ§Ã£o
		apiV1.POST("/register", middleware.AuthRateLimit(), handlers.Register)
		apiV1.POST("/login", middleware.AuthRateLimit(), handlers.Login)
		apiV1.GET("/uc/:numero", handlers.GetUCByNumero)
		apiV1.GET("/uc/:numero/faturas", handlers.GetFaturasByUC)

		// Alias pÃºblico para faturas por unidade (Amee_Serving)
		apiV1.GET("/faturas-uc", handlers.GetFaturas)

		// Faturas Implantadas (por id_uc)
		apiV1.GET("/faturas-implantadas", handlers.GetFaturasImplantadasByIdUC)
		apiV1.GET("/faturas-implantadas/count", handlers.CountFaturasImplantadasByIdUC)
		apiV1.GET("/faturas-implantadas/meses", handlers.GetFaturasImplantadasMeses)
		apiV1.GET("/faturas-implantadas/todas", handlers.GetFaturasImplantadasAllByIdUC)

		apiV1.GET("/departamentos", handlers.GetDepartamentos)

		// ------------------- Autenticado (qualquer usuÃ¡rio) -------------------
		authRequired := apiV1.Group("/")
		authRequired.Use(middleware.AuthMiddleware())
		{
			authRequired.GET("/historico", handlers.HistoricoRecent)
			authRequired.GET("/requisicoes/historico", handlers.HistoricoRecent)

			// Filtros
			authRequired.GET("/filtros/etapas", handlers.GetEtapasParaFiltro)
			authRequired.GET("/filtros/subetapas", handlers.GetSubEtapasParaFiltro)
			authRequired.GET("/filtros/etapas-subetapas", handlers.GetEtapaSubCombinacoes)

			// Regras (somente leitura)
			authRequired.GET("/rules", handlers.GetRules)
			authRequired.GET("/rules/active", handlers.GetActiveRules)

			// Batch meta para cards do Kanban
			authRequired.GET("/processos/cards-meta", handlers.GetProcessosCardsMeta)

			// UC: opÃ§Ãµes (unidade/empresa/concessionÃ¡ria)
			authRequired.GET("/uc/:numero/opcoes", handlers.GetUCOpcoesByNumero)

			// Resumos de processo (persistidos)
			authRequired.GET("/processos/:id/summary", handlers.GetProcessoSummary)
			authRequired.POST("/processos/:id/summary/refresh", handlers.RefreshProcessoSummary)
			// ML (predicoes)
			authRequired.GET("/processo/:id/predict-status", handlers.PredictStatusML)
			authRequired.POST("/detect/anomaly", handlers.PredictAnomalyML)
			authRequired.POST("/predict/sla", handlers.PredictSLAML)
			// Monitoramento simples (status)
			authRequired.GET("/resumos/status", handlers.GetResumosStatus)
			// Lista de pendentes (preview)
			authRequired.GET("/resumos/pending", handlers.GetResumosPending)
			// Enfileirar em massa (ids, mode=changed|all, limit)
			authRequired.POST("/resumos/enqueue", handlers.EnqueueResumos)

			// RequisiÃ§Ãµes
			authRequired.POST("/requisicoes", handlers.CreateRequisicaoPersist)
			authRequired.GET("/requisicoes/departamento", handlers.GetRequisicoesDepartamento)

			// Alertas
			authRequired.GET("/alertas", handlers.GetAlertasByUser)
			authRequired.POST("/alertas/marcar-lido", handlers.MarcarAlertaComoLido)
			authRequired.PUT("/alertas/:id", handlers.UpdateAlerta)
			authRequired.DELETE("/alertas/:id", handlers.DeleteAlerta)

			// Faturas auxiliares
			authRequired.GET("/faturas-anos", handlers.GetFaturasAnos)

			// Faturas Kanban (AnÃ¡lise de Desvio)
			authRequired.GET("/faturas/cache", handlers.ListFaturasCache)

			// Fichas de AnÃ¡lise (F01â€“F05 + Resumo)
			authRequired.GET("/faturas/ficha/resumo", handlers.ListFichaResumo)
			authRequired.GET("/faturas/ficha/01", handlers.ListFicha01)
			authRequired.GET("/faturas/ficha/02", handlers.ListFicha02)
			authRequired.GET("/faturas/ficha/03", handlers.ListFicha03)
			authRequired.GET("/faturas/ficha/04", handlers.ListFicha04)
			authRequired.GET("/faturas/ficha/05", handlers.ListFicha05)
			authRequired.GET("/faturas/uc-historico", handlers.GetUCFaturas)
			authRequired.GET("/faturas/ucs-em-processo", handlers.ListUCsEmProcesso)
			authRequired.POST("/faturas/aisure/chat", handlers.AisureChatHandler)
			authRequired.GET("/faturas/aisure/fetch", handlers.AisureFetchFaturaHandler)
			authRequired.POST("/faturas/aisure/confirmar", handlers.AisureConfirmarHandler)
			authRequired.POST("/faturas/aisure/gerar-email", handlers.GerarEmailHandler)

			// Busca global
			authRequired.GET("/search/global", handlers.SearchGlobal)

			// Feedback
			authRequired.POST("/feedback", handlers.CreateFeedback)
			authRequired.POST("/ai/resumo/feedback", handlers.CreateResumoFeedback)
			authRequired.POST("/chat/rag", handlers.ChatRAGHandler)
			authRequired.POST("/chat/feedback", handlers.CreateChatFeedback)
			authRequired.POST("/chat/upload", handlers.ChatUploadHandler)
			authRequired.POST("/chat/learn", handlers.ChatLearnHandler)
			authRequired.POST("/chat/sessions", handlers.CreateChatSession)
			authRequired.GET("/chat/sessions", handlers.ListChatSessions)
			authRequired.GET("/chat/sessions/:id/messages", handlers.ListChatMessages)
			authRequired.POST("/chat/sessions/:id/messages", handlers.AddChatMessage)
			authRequired.DELETE("/chat/sessions/:id", handlers.DeleteChatSession)

			// Irregularidades
			authRequired.GET("/tipos-irregularidade", handlers.GetTiposIrregularidade)
			authRequired.GET("/tipos-irregularidade/:tipoID/subtipos", handlers.GetSubtiposIrregularidade)

			// Dashboard de deferidos (autenticado)
			authRequired.GET("/dashboard/deferidos", handlers.GetDashboardDeferidos)

			// HistÃ³rico (qualquer usuÃ¡rio autenticado)
			authRequired.GET("/requisicoes/:id/historico", handlers.GetHistoricoByRequisicaoID)
			authRequired.GET("/requisicoes/:id", handlers.GetRequisicaoByID)
			authRequired.GET("/processos/:id/historico", handlers.GetHistoricoMovimentacoes)
		}

		// ------------------------- Gestor -------------------------
		gestorRequired := apiV1.Group("/")
		gestorRequired.Use(middleware.AuthMiddleware(), middleware.GestorMiddleware())
		{
			// RequisiÃ§Ãµes (triagem)
			gestorRequired.GET("/requisicoes", handlers.GetAllRequisicoes)
			gestorRequired.GET("/requisicoes/:id/faturas", handlers.GetFaturasSelecionadasByRequisicaoID)
			gestorRequired.POST("/requisicoes/:id/update", handlers.UpdateRequisicaoCompleta)
			gestorRequired.GET("/requisicoes/:id/anexos", handlers.GetAnexosByRequisicaoID)
			gestorRequired.POST("/requisicoes/:id/anexos", handlers.AddAnexoByRequisicaoID)
			gestorRequired.DELETE("/requisicoes/:id/anexos/:anexoId", handlers.DeleteAnexoByRequisicaoID)

			// Processos (fluxo)
			gestorRequired.GET("/processos/kanban", handlers.GetProcessosKanban) // legado
			gestorRequired.GET("/processos/kanban-fast", procHandler.KanbanFast) // fast
			registerGestorHistoricoRoutes(gestorRequired)
			gestorRequired.GET("/processos/:id/deferimento", handlers.GetDeferimentoByProcesso)
			gestorRequired.POST("/processos/:id/movimentar", handlers.MovimentarProcesso)
			gestorRequired.POST("/processos/:id/deferimento", handlers.SalvarDeferimentoSimples)
			gestorRequired.POST("/processos/:id/comentar", handlers.ComentarProcesso)
			gestorRequired.POST("/processos/:id/descartar", handlers.DescartarProcesso)
			gestorRequired.POST("/processos/:id/alerta", handlers.SalvarDataAlerta)
			gestorRequired.POST("/processos/:id/alertas", handlers.CreateAlertaManual)
			gestorRequired.POST("/processos/:id/suspender", handlers.SuspenderProcesso)
			gestorRequired.POST("/processos/:id/retomar", handlers.RetomarProcesso)
			gestorRequired.GET("/processos/prazos", handlers.GetProcessosComPrazo)
			gestorRequired.GET("/processos/backlog", handlers.GetBacklogProcessos)
			gestorRequired.POST("/processos/:id/backlog-check", handlers.ToggleBacklogCheck)
			gestorRequired.GET("/processos/suspensos", handlers.GetProcessosSuspensos)
			gestorRequired.DELETE("/processos/:id", handlers.ExcluirProcessoPermanentemente)
			gestorRequired.POST("/ocr/excel/analyze", handlers.AnalyzeExcelMetric)
			gestorRequired.POST("/ocr/desvio-media", handlers.DesvioMedia)
			gestorRequired.GET("/desvio-kwh-fponta", handlers.ListDesvioKwhFponta)
			gestorRequired.GET("/desvio-kwh-fponta/options", handlers.ListDesvioKwhOptions)
			gestorRequired.POST("/desvio-kwh-fponta/:id/flags", handlers.UpdateDesvioKwhFlags)
			gestorRequired.POST("/desvio-kwh-fponta/:id/create-processo", handlers.CreateProcessoFromDesvioKwh)

			// Fluxo de Ressarcimento
			gestorRequired.POST("/fluxo-ressarcimento/:id", handlers.SalvarFluxoRessarcimento)
			gestorRequired.GET("/fluxo-ressarcimento/:id", handlers.BuscarFluxoRessarcimento)
			gestorRequired.DELETE("/fluxo-ressarcimento/item/:itemId", handlers.DeletarItemFluxoRessarcimento)

			// Faturamento
			gestorRequired.POST("/faturamento/:id", handlers.SalvarFaturamento)
			gestorRequired.GET("/faturamento/:id", handlers.BuscarFaturamento)
			gestorRequired.DELETE("/faturamento/item/:itemId", handlers.DeletarItemFaturamento)
			gestorRequired.GET("/faturamento/:id/stats", handlers.GetFaturamentoStats)

			// E-mails
			gestorRequired.POST("/processos/:id/emails", handlers.EnviarEmailProcesso)
			gestorRequired.GET("/processos/:id/emails", handlers.GetEmailsByProcessoID)
			gestorRequired.POST("/processos/:id/emails/:emailId/read", handlers.MarkEmailProcessoRead)
			gestorRequired.POST("/processos/:id/gerar-cobranca", handlers.GerarCobrancaEmailHandler)

			// Tese técnico-jurídica
			gestorRequired.GET("/processos/:id/tese", handlers.GetTeseHandler)
			gestorRequired.POST("/processos/:id/tese/gerar", handlers.GerarTeseHandler)
			gestorRequired.POST("/processos/:id/tese/salvar", handlers.SalvarTeseHandler)
			gestorRequired.GET("/processos/:id/tese/pdf", handlers.PDFTeseHandler)
			gestorRequired.POST("/processos/:id/tese/enviar-email", handlers.EnviarEmailTeseHandler)
			gestorRequired.POST("/processos/:id/tese/gerar-email", handlers.GerarEmailTeseHandler)

			// Mailbox (Microsoft Graph)
			gestorRequired.GET("/mail/folders", handlers.MailFolders)
			gestorRequired.GET("/mail/messages", handlers.MailMessages)
			gestorRequired.GET("/mail/messages/:id", handlers.MailMessageByID)
			gestorRequired.GET("/mail/messages/:id/mime", handlers.MailMessageMime)
			gestorRequired.GET("/mail/messages/:id/attachments", handlers.MailMessageAttachments)
			gestorRequired.GET("/mail/messages/:id/attachments/:attId/download", handlers.MailMessageAttachmentDownload)
			gestorRequired.POST("/mail/messages/:id/move", handlers.MailMessageMove)
			gestorRequired.POST("/mail/messages/:id/read", handlers.MailMessageSetRead)
			gestorRequired.POST("/mail/messages/:id/read-local", handlers.MailMessageSetReadLocal)
			gestorRequired.POST("/mail/messages/:id/analisar-ia", handlers.MailMessageAnalyzeIA)
			gestorRequired.POST("/mail/messages/:id/reply", handlers.MailMessageReply)
			gestorRequired.POST("/mail/messages/:id/reply-all", handlers.MailMessageReplyAll)
			gestorRequired.POST("/mail/messages/:id/forward", handlers.MailMessageForward)
			gestorRequired.POST("/mail/send", handlers.MailSend)
			gestorRequired.POST("/mail/messages/:id/link-process", handlers.MailMessageLinkProcess)
			gestorRequired.GET("/mail/processes/search", handlers.MailProcessSearch)

			// Auditoria Ilttio (Excel)
			gestorRequired.POST("/ocr/excel", handlers.ImportIlttioExcel)

			// Faturas e filtros
			gestorRequired.GET("/faturas", handlers.GetFaturas)
			gestorRequired.GET("/filtros/empresas", handlers.GetEmpresasParaFiltro)
			gestorRequired.GET("/filtros/concessionarias", handlers.GetConcessionariasParaFiltro)
			gestorRequired.GET("/filtros/tensao", handlers.GetTensaoParaFiltro)

			// Admin - Planilha (lista e operaÃ§Ãµes em massa)
			gestorRequired.GET("/admin/planilha", handlers.AdminPlanilhaList)
			gestorRequired.GET("/admin/planilha/export", handlers.AdminPlanilhaExport)
			gestorRequired.POST("/admin/planilha/import", handlers.AdminPlanilhaImport)
			gestorRequired.POST("/admin/planilha/bulk-mover", handlers.AdminPlanilhaBulkMover)
			gestorRequired.POST("/admin/planilha/bulk-comentario-replace", handlers.AdminPlanilhaBulkComentarioReplace)
			gestorRequired.POST("/admin/planilha/recalcular-coluna", handlers.AdminPlanilhaRecalcularColuna)
			gestorRequired.DELETE("/admin/historico/:id", handlers.AdminDeleteHistorico)

			// Admin - Prazos (configuraÃ§Ãµes de prazos por kanban/etapa)
			gestorRequired.GET("/admin/prazos", handlers.GetPrazosConfig)
			gestorRequired.POST("/admin/prazos", handlers.SavePrazosConfig)

			// Admin - Alarmes (regras de alerta por etapa/coluna)
			gestorRequired.GET("/admin/alarmes", handlers.GetAlarmes)
			gestorRequired.POST("/admin/alarmes", handlers.SaveAlarme)
			gestorRequired.DELETE("/admin/alarmes/:id", handlers.DeleteAlarme)

			// Admin - Editor completo (processo + mÃ³dulos)
			gestorRequired.POST("/admin/editor/processo", handlers.AdminEditProcesso)
			gestorRequired.GET("/admin/editor/next-id", handlers.AdminNextProcessID)

			// Dashboard
			gestorRequired.GET("/dashboard/stats", dashHandler.Stats)
			gestorRequired.GET("/dashboard/movimentacoes", dashHandler.MovimentacoesPeriodo)
			gestorRequired.GET("/dashboard/changes-24h", dashHandler.MovimentacoesUltimas24h)
			gestorRequired.GET("/relatorios/metricas", handlers.GetRelatoriosMetricas)
			gestorRequired.GET("/relatorios/kanban-composicao", handlers.GetKanbanComposicao)

			// IA
			gestorRequired.POST("/perguntar-ia", handlers.PerguntaIAHandler)

			// Score de ProgressÃ£o
			gestorRequired.GET("/processos/:id/score", handlers.ScoreProcessoHandler)
			gestorRequired.POST("/admin/score/precalcular", handlers.PrecalcularScoresHandler)

			// Fila de aÃ§Ãµes do dia
			gestorRequired.GET("/acoes-do-dia", handlers.GetAcoesDodia)

			// MenÃ§Ãµes
			gestorRequired.GET("/usuarios/mencoes", handlers.GetUsuariosMencoes)

			// Tags
			gestorRequired.GET("/tags", handlers.GetAllTags)
			gestorRequired.POST("/tags", handlers.CreateTag)
			gestorRequired.PUT("/processos/:id/tags", handlers.UpdateProcessoTags)

			// OCR (somente gestor/admin)
			gestorRequired.POST("/ocr/analyze", handlers.OCRAnalyze)
			gestorRequired.POST("/ocr/quick", handlers.OCRQuick)         // Two-stage OCR: Stage 1 (fast extraction)
			gestorRequired.POST("/ocr/interpret", handlers.OCRInterpret) // Two-stage OCR: Stage 2 (interpretation)
			gestorRequired.POST("/ocr/interpret_json", handlers.OCRInterpretJson)

			// Regras de auditoria (CRUD)
			gestorRequired.POST("/rules", handlers.CreateRule)
			gestorRequired.PUT("/rules/:id", handlers.UpdateRule)
			gestorRequired.DELETE("/rules/:id", handlers.DeleteRule)
			gestorRequired.POST("/rules/interpret", handlers.InterpretRule)
		}
	}

	// ============================================================
	// Compatibilidade: espelho em /api (legado)
	// ============================================================
	api := r.Group("/api")
	{
		api.GET("/healthz", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
		api.GET("/alertas/stream", middleware.AuthOrQueryToken(), handlers.StreamAlertas)
		api.GET("/events", middleware.AuthOrQueryToken(), handlers.StreamGlobalEvents)
		api.GET("/processos/:id/events", middleware.AuthOrQueryToken(), handlers.StreamProcessoEvents)
		api.GET("/anexos/:anexoId/download", middleware.AuthOrQueryToken(), handlers.DownloadAnexoByID)

		// Mailbox (Microsoft Graph) - legado /api
		api.GET("/mail/folders", middleware.AuthOrQueryToken(), handlers.MailFolders)
		api.GET("/mail/messages", middleware.AuthOrQueryToken(), handlers.MailMessages)
		api.GET("/mail/messages/:id", middleware.AuthOrQueryToken(), handlers.MailMessageByID)
		api.GET("/mail/messages/:id/mime", middleware.AuthOrQueryToken(), handlers.MailMessageMime)
		api.GET("/mail/messages/:id/attachments", middleware.AuthOrQueryToken(), handlers.MailMessageAttachments)
		api.GET("/mail/messages/:id/attachments/:attId/download", middleware.AuthOrQueryToken(), handlers.MailMessageAttachmentDownload)
		api.POST("/mail/messages/:id/move", middleware.AuthOrQueryToken(), handlers.MailMessageMove)
		api.POST("/mail/messages/:id/read", middleware.AuthOrQueryToken(), handlers.MailMessageSetRead)
		api.POST("/mail/messages/:id/read-local", middleware.AuthOrQueryToken(), handlers.MailMessageSetReadLocal)
		api.POST("/mail/messages/:id/analisar-ia", middleware.AuthOrQueryToken(), handlers.MailMessageAnalyzeIA)
		api.POST("/mail/messages/:id/reply", middleware.AuthOrQueryToken(), handlers.MailMessageReply)
		api.POST("/mail/messages/:id/reply-all", middleware.AuthOrQueryToken(), handlers.MailMessageReplyAll)
		api.POST("/mail/messages/:id/forward", middleware.AuthOrQueryToken(), handlers.MailMessageForward)
		api.POST("/mail/send", middleware.AuthOrQueryToken(), handlers.MailSend)
		api.POST("/mail/messages/:id/link-process", middleware.AuthOrQueryToken(), handlers.MailMessageLinkProcess)
		api.GET("/mail/processes/search", middleware.AuthOrQueryToken(), handlers.MailProcessSearch)

		// OCR CHAT legado (mesmo comportamento de /api/v1)
		api.POST("/ocr/chat",
			middleware.AuthOrQueryToken(),
			middleware.OCRChatRateLimit(),
			handlers.OCRChat,
		)

		// DiagnÃ³stico legado
		api.GET("/whoami", middleware.AuthOrQueryToken(), func(c *gin.Context) {
			uid, _ := c.Get("userID")
			userName, _ := c.Get("userName")
			role, _ := c.Get("role")
			userTipo, _ := c.Get("userTipoConta")
			c.JSON(200, gin.H{
				"userID":        uid,
				"userName":      userName,
				"role":          role,
				"userTipoConta": userTipo,
			})
		})

		api.POST("/register", handlers.Register)
		api.POST("/login", handlers.Login)

		api.GET("/uc/:numero", handlers.GetUCByNumero)
		api.GET("/uc/:numero/faturas", handlers.GetFaturasByUC)
		api.GET("/departamentos", handlers.GetDepartamentos)

		api.PUT("/alertas/:id", handlers.UpdateAlerta)
		api.DELETE("/alertas/:id", handlers.DeleteAlerta)

		authRequired := api.Group("/")
		authRequired.Use(middleware.AuthMiddleware())
		{
			authRequired.GET("/historico", handlers.HistoricoRecent)
			authRequired.GET("/requisicoes/historico", handlers.HistoricoRecent)
			authRequired.POST("/requisicoes", handlers.CreateRequisicaoPersist)
			authRequired.GET("/requisicoes/departamento", handlers.GetRequisicoesDepartamento)
			authRequired.GET("/alertas", handlers.GetAlertasByUser)
			authRequired.POST("/alertas/marcar-lido", handlers.MarcarAlertaComoLido)
			authRequired.POST("/feedback", handlers.CreateFeedback)
			authRequired.POST("/ai/resumo/feedback", handlers.CreateResumoFeedback)
			authRequired.GET("/tipos-irregularidade", handlers.GetTiposIrregularidade)
			authRequired.GET("/tipos-irregularidade/:tipoID/subtipos", handlers.GetSubtiposIrregularidade)

			// Dashboard de deferidos (legado, autenticado)
			authRequired.GET("/dashboard/deferidos", handlers.GetDashboardDeferidos)

			// HistÃ³rico (legado, qualquer usuÃ¡rio autenticado)
			authRequired.GET("/requisicoes/:id/historico", handlers.GetHistoricoByRequisicaoID)
			authRequired.GET("/processos/:id/historico", handlers.GetHistoricoMovimentacoes)
		}

		gestorRequired := api.Group("/")
		gestorRequired.Use(middleware.AuthMiddleware(), middleware.GestorMiddleware())
		{
			gestorRequired.GET("/requisicoes", handlers.GetAllRequisicoes)
			gestorRequired.GET("/requisicoes/:id", handlers.GetRequisicaoByID)
			gestorRequired.GET("/requisicoes/:id/faturas", handlers.GetFaturasSelecionadasByRequisicaoID)
			gestorRequired.POST("/requisicoes/:id/update", handlers.UpdateRequisicaoCompleta)
			gestorRequired.GET("/requisicoes/:id/anexos", handlers.GetAnexosByRequisicaoID)
			gestorRequired.POST("/requisicoes/:id/anexos", handlers.AddAnexoByRequisicaoID)
			gestorRequired.DELETE("/requisicoes/:id/anexos/:anexoId", handlers.DeleteAnexoByRequisicaoID)

			gestorRequired.GET("/processos/kanban", handlers.GetProcessosKanban)
			gestorRequired.GET("/processos/kanban-fast", procHandler.KanbanFast)
			registerGestorHistoricoRoutes(gestorRequired)
			gestorRequired.GET("/processos/:id/deferimento", handlers.GetDeferimentoByProcesso)
			gestorRequired.POST("/processos/:id/movimentar", handlers.MovimentarProcesso)
			gestorRequired.POST("/processos/:id/comentar", handlers.ComentarProcesso)
			gestorRequired.POST("/processos/:id/descartar", handlers.DescartarProcesso)
			gestorRequired.POST("/processos/:id/alerta", handlers.SalvarDataAlerta)
			gestorRequired.POST("/processos/:id/alertas", handlers.CreateAlertaManual)
			gestorRequired.POST("/processos/:id/suspender", handlers.SuspenderProcesso)
			gestorRequired.POST("/processos/:id/retomar", handlers.RetomarProcesso)
			gestorRequired.GET("/processos/prazos", handlers.GetProcessosComPrazo)
			gestorRequired.GET("/processos/backlog", handlers.GetBacklogProcessos)
			gestorRequired.POST("/processos/:id/backlog-check", handlers.ToggleBacklogCheck)
			gestorRequired.GET("/processos/suspensos", handlers.GetProcessosSuspensos)
			gestorRequired.DELETE("/processos/:id", handlers.ExcluirProcessoPermanentemente)

			gestorRequired.POST("/fluxo-ressarcimento/:id", handlers.SalvarFluxoRessarcimento)
			gestorRequired.GET("/fluxo-ressarcimento/:id", handlers.BuscarFluxoRessarcimento)
			gestorRequired.DELETE("/fluxo-ressarcimento/item/:itemId", handlers.DeletarItemFluxoRessarcimento)

			gestorRequired.POST("/faturamento/:id", handlers.SalvarFaturamento)
			gestorRequired.GET("/faturamento/:id", handlers.BuscarFaturamento)
			gestorRequired.DELETE("/faturamento/item/:itemId", handlers.DeletarItemFaturamento)
			gestorRequired.GET("/faturamento/:id/stats", handlers.GetFaturamentoStats)

			gestorRequired.POST("/processos/:id/emails", handlers.EnviarEmailProcesso)
			gestorRequired.GET("/processos/:id/emails", handlers.GetEmailsByProcessoID)
			gestorRequired.POST("/processos/:id/emails/:emailId/read", handlers.MarkEmailProcessoRead)

			// Tese técnico-jurídica
			gestorRequired.GET("/processos/:id/tese", handlers.GetTeseHandler)
			gestorRequired.POST("/processos/:id/tese/gerar", handlers.GerarTeseHandler)
			gestorRequired.POST("/processos/:id/tese/salvar", handlers.SalvarTeseHandler)
			gestorRequired.GET("/processos/:id/tese/pdf", handlers.PDFTeseHandler)
			gestorRequired.POST("/processos/:id/tese/enviar-email", handlers.EnviarEmailTeseHandler)
			gestorRequired.POST("/processos/:id/tese/gerar-email", handlers.GerarEmailTeseHandler)

			gestorRequired.GET("/faturas", handlers.GetFaturas)

			gestorRequired.GET("/dashboard/stats", dashHandler.Stats)
			gestorRequired.GET("/dashboard/movimentacoes", dashHandler.MovimentacoesPeriodo)
			gestorRequired.GET("/dashboard/changes-24h", dashHandler.MovimentacoesUltimas24h)
			gestorRequired.GET("/search/global", handlers.SearchGlobal)

			gestorRequired.POST("/perguntar-ia", handlers.PerguntaIAHandler)

			// Score de ProgressÃ£o (novo)
			gestorRequired.GET("/processos/:id/score", handlers.ScoreProcessoHandler)
			gestorRequired.POST("/admin/score/precalcular", handlers.PrecalcularScoresHandler)

			// Fila de aÃ§Ãµes do dia
			gestorRequired.GET("/acoes-do-dia", handlers.GetAcoesDodia)

			gestorRequired.GET("/usuarios/mencoes", handlers.GetUsuariosMencoes)
			gestorRequired.GET("/tags", handlers.GetAllTags)
			gestorRequired.POST("/tags", handlers.CreateTag)
			gestorRequired.PUT("/processos/:id/tags", handlers.UpdateProcessoTags)
		}
	}

	// Raiz simples para liveness checks e para evitar 404 em "/"
	r.GET("/", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })

	return r
}
