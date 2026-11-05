package v2

import "github.com/gin-gonic/gin"

// RegisterAuthRoutes monta os endpoints públicos de autenticação.
// /login, /logout e /register não exigem AuthMiddleware. /me exige.
//
//   POST /auth/login
//   POST /auth/logout
//   POST /auth/register
//   GET  /auth/me            (chamado dentro do grupo autenticado)
func RegisterAuthRoutesPublic(g *gin.RouterGroup) {
	g.POST("/auth/login", Login)
	g.POST("/auth/logout", Logout)
	g.POST("/auth/register", Register)

	// Login/Vínculo com Microsoft (Entra ID). Tudo público: o /start e o /callback
	// são navegações de página inteira (não dá pra mandar header Authorization);
	// no modo "link" o /callback identifica o usuário pelo cookie auth_token.
	g.GET("/auth/microsoft/config", MicrosoftConfig)
	g.GET("/auth/microsoft/start", MicrosoftStart)
	g.GET("/auth/microsoft/callback", MicrosoftCallback)

	// Login por link mágico (passwordless) — entra com o e-mail da empresa, sem Azure.
	g.GET("/auth/magic/config", MagicConfig)
	g.POST("/auth/magic", MagicRequest)
	g.GET("/auth/magic/verify", MagicVerify)
}

func RegisterAuthRoutesAuthed(g *gin.RouterGroup) {
	g.GET("/auth/me", Me)
}

// RegisterReadRoutes monta os handlers GET do Sprint 1.
// Deve ser chamado em routes.go dentro do grupo /api/v2 já autenticado.
//
// Endpoints:
//   GET /processos                       (listagem com filtros)
//   GET /processos/:id                   (detalhes)
//   GET /processos/:id/historico
//   GET /processos/:id/anexos
//   GET /processos/:id/deferimento
//   GET /processos/:id/faturamento
//   GET /processos/:id/repasse
//   GET /processos/:id/encerramento
//   GET /dimensoes
func RegisterReadRoutes(g *gin.RouterGroup) {
	g.GET("/dimensoes", GetDimensoes)

	g.GET("/processos", ListProcessos)
	g.GET("/auditoria/processos", ExportAuditoria)
	g.GET("/processos/:id", GetProcesso)
	g.GET("/processos/:id/historico", GetHistorico)
	g.GET("/processos/:id/anexos", GetAnexos)
	g.POST("/processos/:id/anexos", AddAnexo)
	g.DELETE("/processos/:id/anexos/:anexoId", DeletarAnexo)
	g.GET("/processos/:id/deferimento", GetDeferimento)
	g.GET("/processos/:id/faturamento", GetFaturamentos)
	g.GET("/processos/:id/repasse", GetRepasses)
	g.GET("/processos/:id/encerramento", GetEncerramento)
	g.GET("/processos/:id/documento", GeraDocumento)
	g.GET("/historico", GetHistoricoGlobal)

	// DM_EMPRESA_PERCENTUAL — ganho da AMEE por empresa, com histórico de vigências
	g.GET("/empresas-percentual", ListEmpresasPercentualVigentes)
	g.GET("/empresas-percentual/:cod_empresa/historico", GetEmpresaPercentualHistorico)

	// Metas de deferimento (repasse) — barra de progressão no Controle de Processos
	g.GET("/metas/deferimento", GetMetasDeferimento)
	g.GET("/metas/deferimento/detalhe", GetMetasDeferimentoDetalhe)

	// Assistente do solicitante (chat em tela cheia) — consultas determinísticas.
	g.GET("/assistente/processo", AssistenteProcesso)
	g.GET("/assistente/cliente", AssistenteCliente)
	g.GET("/assistente/tempo-medio", AssistenteTempoMedio)
	g.GET("/assistente/lista", AssistenteLista)
}

// RegisterWriteRoutes monta os endpoints POST/PUT/DELETE da Sprint 2.
//
//   POST   /processos/:id/movimentar
//   POST   /processos/:id/deferimento
//   POST   /processos/:id/faturamento
//   PUT    /faturamento/:id
//   DELETE /faturamento/:id
//   POST   /processos/:id/repasse
//   PUT    /repasse/:id
//   DELETE /repasse/:id
//   POST   /processos/:id/encerramento
func RegisterWriteRoutes(g *gin.RouterGroup) {
	g.POST("/processos/:id/movimentar", Movimentar)
	g.PATCH("/processos/:id/relevancia", SetRelevancia)

	g.POST("/processos/:id/deferimento", SalvarDeferimento)

	g.POST("/processos/:id/faturamento", CriarFaturamento)
	g.PUT("/faturamento/:id", AtualizarFaturamento)
	g.DELETE("/faturamento/:id", DeletarFaturamento)

	g.POST("/processos/:id/repasse", CriarRepasse)
	g.PUT("/repasse/:id", AtualizarRepasse)
	g.DELETE("/repasse/:id", DeletarRepasse)

	g.PUT("/historico/:id/comentario", EditarComentarioHistorico)
	g.PUT("/processos/:id/full", AtualizarProcessoCompleto)

	g.POST("/processos/:id/encerramento", SalvarEncerramento)

	// DM_EMPRESA_PERCENTUAL — write
	g.POST("/empresas-percentual/:cod_empresa/vigencia", CriarVigenciaEmpresa)
	g.PUT("/empresas-percentual/vigencia/:id", AtualizarVigencia)
	g.DELETE("/empresas-percentual/vigencia/:id", DesativarVigencia)

	// Metas de deferimento (repasse) — calibração da meta mensal/anual
	g.PUT("/metas/deferimento", AtualizarMetasDeferimento)
}
