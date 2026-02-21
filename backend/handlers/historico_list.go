package handlers

import (
    "net/http"
    "strconv"

    "ressarcimento-backend/database"

    "github.com/gin-gonic/gin"
)

// HistoricoItemDTO representa um item de histórico padronizado
type HistoricoItemDTO struct {
    IDHistorico    int64  `json:"id_historico"`
    ProcessoID     int64  `json:"id_processo"`
    UsuarioID      int64  `json:"id_usuario"`
    UsuarioNome    string `json:"usuario_nome"`
    StatusAnterior string `json:"status_anterior"`
    StatusNovo     string `json:"status_novo"`
    EtapaAnterior  string `json:"etapa_anterior"`
    EtapaNova      string `json:"etapa_nova"`
    SubEtapa       string `json:"sub_etapa"`
    Tipo           string `json:"tipo_movimentacao"`
    Quando         string `json:"data_movimentacao"`
    Comentario     string `json:"comentario"`
}

// GET /api/v1/historico?limit=2000
// GET /api/v1/requisicoes/historico?limit=2000 (alias de compatibilidade)
// @Summary Historico recente
// @Tags Historico
// @Produce json
// @Param limit query int false "Limite"
// @Success 200 {array} HistoricoItemDTO
// @Router /api/v1/historico [get]
func HistoricoRecent(c *gin.Context) {
    limStr := c.DefaultQuery("limit", "1000")
    lim, _ := strconv.Atoi(limStr)
    if lim <= 0 { lim = 1000 }
    if lim > 5000 { lim = 5000 }

    // Consulta básica ordenada por data/id desc
    rows, err := queryGorm(database.GormDB_App, `
        SELECT
          h.id_historico,
          h.id_requisicao,
          COALESCE(h.id_usuario_gestor,0) as id_usuario,
          COALESCE(u.nome_usuario,'') AS usuario_nome,
          COALESCE(h.status_anterior, '') AS status_anterior,
          COALESCE(h.status_novo, '')     AS status_novo,
          COALESCE(h.etapa_anterior, '')  AS etapa_anterior,
          COALESCE(h.etapa_nova, '')      AS etapa_nova,
          COALESCE(h.sub_etapa, '')       AS sub_etapa,
          COALESCE(h.tipo_movimentacao,'') AS tipo_movimentacao,
          DATE_FORMAT(h.data_movimentacao, '%Y-%m-%d %H:%i:%s') AS quando,
          COALESCE(h.comentario,'')       AS comentario
        FROM FT_HISTORICO_MOVIMENTACOES h
        LEFT JOIN DM_USUARIO u ON u.id_usuario = h.id_usuario_gestor
        ORDER BY h.data_movimentacao DESC, h.id_historico DESC
        LIMIT ?`, lim)
    if err != nil {
        c.JSON(http.StatusOK, []HistoricoItemDTO{})
        return
    }
    defer rows.Close()

    out := make([]HistoricoItemDTO, 0, lim)
    for rows.Next() {
        var it HistoricoItemDTO
        if err := rows.Scan(
            &it.IDHistorico, &it.ProcessoID, &it.UsuarioID, &it.UsuarioNome,
            &it.StatusAnterior, &it.StatusNovo, &it.EtapaAnterior, &it.EtapaNova, &it.SubEtapa,
            &it.Tipo, &it.Quando, &it.Comentario,
        ); err == nil {
            out = append(out, it)
        }
    }
    if out == nil { out = []HistoricoItemDTO{} }
    c.JSON(http.StatusOK, out)
}

