package handlers

import (
	"database/sql"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"ressarcimento-backend/database"
	"ressarcimento-backend/repositories"
	"ressarcimento-backend/services"

	"github.com/gin-gonic/gin"
)

type DashboardHandler struct {
	svc *services.DashboardService
}

func NewDashboardHandler(s *services.DashboardService) *DashboardHandler {
	return &DashboardHandler{svc: s}
}

// Stats godoc
// @Summary      Estatísticas do dashboard
// @Tags         Dashboard
// @Param        debug             query  bool    false  "Debug"
// @Param        incluir_suspensos  query  bool    false  "Incluir suspensos (1/0)"
// @Param        apenas_relevantes  query  bool    false  "Apenas relevantes (1/0)"
// @Param        ini               query  string  false  "Data inicial (YYYY-MM-DD)"
// @Param        fim               query  string  false  "Data final (YYYY-MM-DD)"
// @Param        cliente           query  string  false  "Filtro por cliente"
// @Param        concessionaria    query  string  false  "Filtro por concessionária"
// @Param        gestor_id         query  int     false  "ID do gestor"
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/dashboard/stats [get]
// GET /api/dashboard/stats[?debug=1]
func (h *DashboardHandler) Stats(c *gin.Context) {
	ctx := c.Request.Context()
	debug := false
	if d := c.Query("debug"); d != "" {
		if b, err := strconv.ParseBool(d); err == nil {
			debug = b
		}
	}
	// filtros básicos
	f := repositories.DashFilters{}
	if v := strings.TrimSpace(c.DefaultQuery("incluir_suspensos", "1")); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			f.IncluirSuspensos = b
		}
		if i, err := strconv.Atoi(v); err == nil {
			f.IncluirSuspensos = (i != 0)
		}
	}
	if v := strings.TrimSpace(c.DefaultQuery("apenas_relevantes", "0")); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			f.ApenasRelevantes = b
		}
		if i, err := strconv.Atoi(v); err == nil {
			f.ApenasRelevantes = (i != 0)
		}
	}
	// período opcional
	if s := strings.TrimSpace(c.Query("ini")); s != "" {
		if t, err := time.Parse("2006-01-02", s); err == nil {
			f.Ini = &t
		}
	}
	if s := strings.TrimSpace(c.Query("fim")); s != "" {
		if t, err := time.Parse("2006-01-02", s); err == nil {
			f.Fim = &t
		}
	}
	// cliente/concessionaria (substring)
	f.Cliente = strings.TrimSpace(c.Query("cliente"))
	f.Concessionaria = strings.TrimSpace(c.Query("concessionaria"))
	// gestor (id)
	if s := strings.TrimSpace(c.Query("gestor_id")); s != "" {
		if id, err := strconv.ParseInt(s, 10, 64); err == nil {
			f.GestorID = &id
		}
	}

	out, err := h.svc.GetStats(ctx, debug, f)
	if err != nil {
		// mesmo com erro, tentamos devolver estrutura útil (warnings explicam a causa)
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":    "failed to compute dashboard stats",
			"detail":   err.Error(),
			"warnings": out.Warnings,
			"partial":  out, // ajuda na inspeÃ§ão
		})
		return
	}
	c.JSON(http.StatusOK, out)
}

// MovimentacoesPeriodo godoc
// @Summary      MovimentaÃ§ões por período
// @Tags         Dashboard
// @Param        ini  query  string  true  "Data inicial (YYYY-MM-DD)"
// @Param        fim  query  string  true  "Data final (YYYY-MM-DD)"
// @Produce      json
// @Success      200  {array}   map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/dashboard/movimentacoes [get]
// GET /api/dashboard/movimentacoes?ini=YYYY-MM-DD&fim=YYYY-MM-DD
func (h *DashboardHandler) MovimentacoesPeriodo(c *gin.Context) {
	iniStr := c.Query("ini")
	fimStr := c.Query("fim")
	if iniStr == "" || fimStr == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "parâmetros ini e fim são obrigatórios (YYYY-MM-DD)"})
		return
	}
	ini, err := time.Parse("2006-01-02", iniStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ini inválido", "detail": err.Error()})
		return
	}
	fim, err := time.Parse("2006-01-02", fimStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "fim inválido", "detail": err.Error()})
		return
	}

	ctx := c.Request.Context()
	rows, err := h.svc.MovimentacoesPeriodo(ctx, ini, fim)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao buscar movimentaÃ§ões", "detail": err.Error()})
		return
	}
	c.JSON(http.StatusOK, rows)
}

// MovimentacoesUltimas24h godoc
// @Summary      MovimentaÃ§ões das últimas 24h
// @Tags         Dashboard
// @Produce      json
// @Success      200  {array}   map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/dashboard/changes-24h [get]
// GET /api/dashboard/changes-24h
// Lista alteraÃ§ões de histórico nas últimas 24h, com usuário e canais.
func (h *DashboardHandler) MovimentacoesUltimas24h(c *gin.Context) {
	rows, err := queryGorm(database.GormDB_App, `
		SELECT
			h.id_historico,
			h.id_requisicao,
			h.id_usuario_gestor,
			u.nome_usuario AS usuario_nome,
			h.status_anterior,
			h.status_novo,
			h.etapa_anterior,
			h.etapa_nova,
			h.sub_etapa,
			h.comentario,
			h.data_movimentacao,
			GROUP_CONCAT(LOWER(TRIM(dc.nome)) ORDER BY dc.nome SEPARATOR ',') AS canais_csv
		FROM FT_HISTORICO_MOVIMENTACOES h
		LEFT JOIN DM_USUARIO u            ON u.id_usuario = h.id_usuario_gestor
		LEFT JOIN FT_HISTORICO_CANAIS hc  ON hc.id_historico = h.id_historico
		LEFT JOIN DM_CANAIS_COMUNICACAO dc ON dc.id_canal = hc.id_canal
		WHERE h.data_movimentacao >= NOW() - INTERVAL 24 HOUR
		GROUP BY
			h.id_historico,
			h.id_requisicao,
			h.id_usuario_gestor,
			u.nome_usuario,
			h.status_anterior,
			h.status_novo,
			h.etapa_anterior,
			h.etapa_nova,
			h.sub_etapa,
			h.comentario,
			h.data_movimentacao
		ORDER BY h.data_movimentacao DESC, h.id_historico DESC;
	`)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar movimentaÃ§ões das últimas 24h"})
		return
	}
	defer rows.Close()

	type Item struct {
		IDHistorico int64     `json:"id_historico"`
		IDProcesso  int64     `json:"id_processo"`
		IDGestor    *int64    `json:"id_usuario_gestor,omitempty"`
		UsuarioNome *string   `json:"usuario_nome,omitempty"`
		StatusAnt   *string   `json:"status_anterior,omitempty"`
		StatusNovo  *string   `json:"status_novo,omitempty"`
		EtapaAnt    *string   `json:"etapa_anterior,omitempty"`
		EtapaNova   *string   `json:"etapa_nova,omitempty"`
		SubEtapa    *string   `json:"sub_etapa,omitempty"`
		Comentario  *string   `json:"comentario,omitempty"`
		DataMov     time.Time `json:"data_movimentacao"`
		Canais      []string  `json:"canais,omitempty"`
		CanalResumo string    `json:"canal_comunicacao,omitempty"`
	}

	var out []Item

	for rows.Next() {
		var it Item
		var idProc sql.NullInt64
		var idGest sql.NullInt64
		var usuarioNome sql.NullString
		var statusAnt, statusNovo sql.NullString
		var etapaAnt, etapaNova, sub sql.NullString
		var comentario sql.NullString
		var canaisCSV sql.NullString

		if err := rows.Scan(
			&it.IDHistorico,
			&idProc,
			&idGest,
			&usuarioNome,
			&statusAnt,
			&statusNovo,
			&etapaAnt,
			&etapaNova,
			&sub,
			&comentario,
			&it.DataMov,
			&canaisCSV,
		); err != nil {
			continue
		}

		if idProc.Valid {
			it.IDProcesso = idProc.Int64
		}
		if idGest.Valid {
			v := idGest.Int64
			it.IDGestor = &v
		}
		if usuarioNome.Valid {
			v := usuarioNome.String
			it.UsuarioNome = &v
		}
		if statusAnt.Valid {
			v := statusAnt.String
			it.StatusAnt = &v
		}
		if statusNovo.Valid {
			v := statusNovo.String
			it.StatusNovo = &v
		}
		if etapaAnt.Valid {
			v := etapaAnt.String
			it.EtapaAnt = &v
		}
		if etapaNova.Valid {
			v := etapaNova.String
			it.EtapaNova = &v
		}
		if sub.Valid {
			v := sub.String
			it.SubEtapa = &v
		}
		if comentario.Valid {
			v := comentario.String
			it.Comentario = &v
		}

		// Trata canais agregados (se houver)
		if canaisCSV.Valid && strings.TrimSpace(canaisCSV.String) != "" {
			parts := strings.Split(canaisCSV.String, ",")
			m := make(map[string]struct{}, len(parts))
			clean := make([]string, 0, len(parts))
			for _, raw := range parts {
				v := strings.ToLower(strings.TrimSpace(raw))
				if v == "" {
					continue
				}
				if _, ok := m[v]; ok {
					continue
				}
				m[v] = struct{}{}
				clean = append(clean, v)
			}
			sort.Strings(clean)
			it.Canais = clean
			it.CanalResumo = strings.Join(clean, ", ")
		}

		out = append(out, it)
	}

	if out == nil {
		out = make([]Item, 0)
	}
	c.JSON(http.StatusOK, out)
}

