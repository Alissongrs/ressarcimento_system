package models

import "time"

// Linha que vem da query
type ProcessoKanban struct {
	ColunaKanban           string     `db:"coluna_kanban"            json:"-"` // usado só para agrupar no handler
	ID                     int        `db:"id"                       json:"id"`
	IdColunaKanban         int        `db:"id_coluna_kanban"         json:"id_coluna_kanban"`
	IdEtapaProcesso        int        `db:"id_etapa_processo"        json:"id_etapa_processo"`
	Etapa                  *string    `db:"etapa_nome"               json:"etapa,omitempty"`
	UC                     *string    `db:"uc"                       json:"uc,omitempty"`
	Cliente                *string    `db:"cliente"                  json:"cliente,omitempty"`
	Concessionaria         *string    `db:"concessionaria"           json:"concessionaria,omitempty"`
	ValorEstimado          *float64   `db:"valor_estimado"           json:"valor_estimado,omitempty"`
	CreditoSimples         *float64   `db:"credito_simples"          json:"credito_simples,omitempty"`
	CreditoDobro           *float64   `db:"credito_dobro"            json:"credito_dobro,omitempty"`
	AlertasCount           *int       `db:"alertas_count"            json:"alertas_count,omitempty"`
	SubEtapa               *string    `db:"sub_etapa"                json:"sub_etapa,omitempty"`
	Relevancia             bool       `db:"relevancia"               json:"relevancia"`
	DataAlerta             *time.Time `db:"data_alerta"              json:"data_alerta,omitempty"`
	UltimaAtualizacao      *time.Time `db:"ultima_atualizacao"       json:"ultima_atualizacao,omitempty"`
	DataUltimaMovimentacao *time.Time `db:"data_ultima_movimentacao" json:"data_ultima_movimentacao,omitempty"`
	Suspenso               *bool      `db:"suspenso"                 json:"suspenso,omitempty"`
}

// DTO enviado ao front (sem coluna_kanban dentro do item)
type ProcessoKanbanDTO struct {
	ID                     int        `json:"id"`
	IdColunaKanban         int        `json:"id_coluna_kanban"`
	IdEtapaProcesso        int        `json:"id_etapa_processo"`
	Etapa                  *string    `json:"etapa,omitempty"`
	UC                     *string    `json:"uc,omitempty"`
	Cliente                *string    `json:"cliente,omitempty"`
	Concessionaria         *string    `json:"concessionaria,omitempty"`
	ValorEstimado          *float64   `json:"valor_estimado,omitempty"`
	CreditoSimples         *float64   `json:"credito_simples,omitempty"`
	CreditoDobro           *float64   `json:"credito_dobro,omitempty"`
	AlertasCount           *int       `json:"alertas_count,omitempty"`
	SubEtapa               *string    `json:"sub_etapa,omitempty"`
	Relevancia             bool       `json:"relevancia"`
	DataAlerta             *time.Time `json:"data_alerta,omitempty"`
	UltimaAtualizacao      *time.Time `json:"ultima_atualizacao,omitempty"`
	DataUltimaMovimentacao *time.Time `json:"data_ultima_movimentacao,omitempty"`
	Suspenso               *bool      `json:"suspenso,omitempty"`
}

func (p ProcessoKanban) ToDTO() ProcessoKanbanDTO {
	return ProcessoKanbanDTO{
		ID:                     p.ID,
		IdColunaKanban:         p.IdColunaKanban,
		IdEtapaProcesso:        p.IdEtapaProcesso,
		Etapa:                  p.Etapa,
		UC:                     p.UC,
		Cliente:                p.Cliente,
		Concessionaria:         p.Concessionaria,
		ValorEstimado:          p.ValorEstimado,
		CreditoSimples:         p.CreditoSimples,
		CreditoDobro:           p.CreditoDobro,
		AlertasCount:           p.AlertasCount,
		SubEtapa:               p.SubEtapa,
		Relevancia:             p.Relevancia,
		DataAlerta:             p.DataAlerta,
		UltimaAtualizacao:      p.UltimaAtualizacao,
		DataUltimaMovimentacao: p.DataUltimaMovimentacao,
		Suspenso:               p.Suspenso,
	}
}
