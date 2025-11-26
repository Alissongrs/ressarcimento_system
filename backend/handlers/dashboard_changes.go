package handlers

import (
	"net/http"
	"time"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

type changeDTO struct {
	IDHistorico    int64     `json:"id_historico"`
	ProcessoID     int64     `json:"id_processo"`
	UsuarioID      int64     `json:"id_usuario"`
	UsuarioNome    string    `json:"usuario_nome"`
	StatusAnterior string    `json:"status_anterior"`
	StatusNovo     string    `json:"status_novo"`
	EtapaAnterior  string    `json:"etapa_anterior"`
	EtapaNova      string    `json:"etapa_nova"`
	SubEtapa       string    `json:"sub_etapa"`
	Tipo           string    `json:"tipo_movimentacao"`
	Quando         time.Time `json:"data_movimentacao"`
	Comentario     string    `json:"comentario"`
}

// MovimentacoesUltimas24h retorna as movimentações das últimas 24h.
// Em ambiente de desenvolvimento, se a consulta falhar (ex.: tabela ausente), retorna lista vazia.
func MovimentacoesUltimas24h(c *gin.Context) {
	rows, err := database.DB_App.Query(`
        SELECT
          h.id_historico,
          h.id_requisicao,
          h.id_usuario_gestor,
          COALESCE(u.nome_usuario, '') AS usuario_nome,
          COALESCE(h.status_anterior, ''),
          COALESCE(h.status_novo, ''),
          COALESCE(h.etapa_anterior, ''),
          COALESCE(h.etapa_nova, ''),
          COALESCE(h.sub_etapa, ''),
          COALESCE(h.tipo_movimentacao, ''),
          h.data_movimentacao,
          COALESCE(h.comentario, '')
        FROM FT_HISTORICO_MOVIMENTACOES h
        LEFT JOIN DM_USUARIO u ON u.id_usuario = h.id_usuario_gestor
        WHERE h.data_movimentacao >= NOW() - INTERVAL 1 DAY
        ORDER BY h.data_movimentacao DESC, h.id_historico DESC`)
	if err != nil {
		c.JSON(http.StatusOK, []changeDTO{})
		return
	}
	defer rows.Close()

	var out []changeDTO
	for rows.Next() {
		var it changeDTO
		if err := rows.Scan(
			&it.IDHistorico, &it.ProcessoID, &it.UsuarioID, &it.UsuarioNome,
			&it.StatusAnterior, &it.StatusNovo, &it.EtapaAnterior, &it.EtapaNova, &it.SubEtapa,
			&it.Tipo, &it.Quando, &it.Comentario,
		); err == nil {
			out = append(out, it)
		}
	}
	if out == nil {
		out = []changeDTO{}
	}
	c.JSON(http.StatusOK, out)
}
