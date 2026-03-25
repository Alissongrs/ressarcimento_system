package models

import "time"

// Linha que vem da query
type ProcessoKanban struct {
	ColunaKanban           string     `db:"coluna_kanban"            json:"-"` // usado só para agrupar no handler
	ID                     int        `db:"id"                       json:"id"`
	IdColuna               *int       `db:"id_coluna"               json:"id_coluna,omitempty"`
	IdEtapaProcesso        int        `db:"id_etapa_processo"        json:"id_etapa_processo"`
	NomeColuna             *string    `db:"nome_coluna"             json:"nome_coluna,omitempty"`
	Etapa                  *string    `db:"etapa_nome"               json:"etapa,omitempty"`
	UC                     *string    `db:"uc"                       json:"uc,omitempty"`
	Cliente                *string    `db:"cliente"                  json:"cliente,omitempty"`
	Concessionaria         *string    `db:"concessionaria"           json:"concessionaria,omitempty"`
	ValorEstimado          *float64   `db:"valor_estimado"           json:"valor_estimado,omitempty"`
	CreditoSimples         *float64   `db:"credito_simples"          json:"credito_simples,omitempty"`
	CreditoDobro           *float64   `db:"credito_dobro"            json:"credito_dobro,omitempty"`
	DataSimples            *string    `db:"data_simples"             json:"data_simples,omitempty"`
	DataDobro              *string    `db:"data_dobro"               json:"data_dobro,omitempty"`
	RepasseSimples         *float64   `db:"repasse_simples"          json:"repasse_simples,omitempty"`
	RepasseDobro           *float64   `db:"repasse_dobro"            json:"repasse_dobro,omitempty"`
	AlertasCount           *int       `db:"alertas_count"            json:"alertas_count,omitempty"`
	SubEtapa               *string    `db:"sub_etapa"                json:"sub_etapa,omitempty"`
	Relevancia             bool       `db:"relevancia"               json:"relevancia"`
	DataAlerta             *time.Time `db:"data_alerta"              json:"data_alerta,omitempty"`
	UltimaAtualizacao      *time.Time `db:"ultima_atualizacao"       json:"ultima_atualizacao,omitempty"`
	DataUltimaMovimentacao *time.Time `db:"data_ultima_movimentacao" json:"data_ultima_movimentacao,omitempty"`
	Suspenso               *bool      `db:"suspenso"                 json:"suspenso,omitempty"`
	ScorePercentual        *float64   `db:"score_percentual"         json:"score_percentual,omitempty"`
}

// DTO enviado ao front (sem coluna_kanban dentro do item)
type ProcessoKanbanDTO struct {
	ID                     int        `json:"id"`
	IdColuna               *int       `json:"id_coluna,omitempty"`
	IdEtapaProcesso        int        `json:"id_etapa_processo"`
	NomeColuna             *string    `json:"nome_coluna,omitempty"`
	Etapa                  *string    `json:"etapa,omitempty"`
	UC                     *string    `json:"uc,omitempty"`
	Cliente                *string    `json:"cliente,omitempty"`
	Concessionaria         *string    `json:"concessionaria,omitempty"`
	ValorEstimado          *float64   `json:"valor_estimado,omitempty"`
	CreditoSimples         *float64   `json:"credito_simples,omitempty"`
	CreditoDobro           *float64   `json:"credito_dobro,omitempty"`
	DataSimples            *string    `json:"data_simples,omitempty"`
	DataDobro              *string    `json:"data_dobro,omitempty"`
	RepasseSimples         *float64   `json:"repasse_simples,omitempty"`
	RepasseDobro           *float64   `json:"repasse_dobro,omitempty"`
	AlertasCount           *int       `json:"alertas_count,omitempty"`
	SubEtapa               *string    `json:"sub_etapa,omitempty"`
	Relevancia             bool       `json:"relevancia"`
	DataAlerta             *time.Time `json:"data_alerta,omitempty"`
	UltimaAtualizacao      *time.Time `json:"ultima_atualizacao,omitempty"`
	DataUltimaMovimentacao *time.Time `json:"data_ultima_movimentacao,omitempty"`
	Suspenso               *bool      `json:"suspenso,omitempty"`
	ScorePercentual        *float64   `json:"score_percentual,omitempty"`
}

func (p ProcessoKanban) ToDTO() ProcessoKanbanDTO {
	return ProcessoKanbanDTO{
		ID:                     p.ID,
		IdColuna:               p.IdColuna,
		IdEtapaProcesso:        p.IdEtapaProcesso,
		NomeColuna:             p.NomeColuna,
		Etapa:                  p.Etapa,
		UC:                     p.UC,
		Cliente:                p.Cliente,
		Concessionaria:         p.Concessionaria,
		ValorEstimado:          p.ValorEstimado,
		CreditoSimples:         p.CreditoSimples,
		CreditoDobro:           p.CreditoDobro,
		DataSimples:            p.DataSimples,
		DataDobro:              p.DataDobro,
		RepasseSimples:         p.RepasseSimples,
		RepasseDobro:           p.RepasseDobro,
		AlertasCount:           p.AlertasCount,
		SubEtapa:               p.SubEtapa,
		Relevancia:             p.Relevancia,
		DataAlerta:             p.DataAlerta,
		UltimaAtualizacao:      p.UltimaAtualizacao,
		DataUltimaMovimentacao: p.DataUltimaMovimentacao,
		Suspenso:               p.Suspenso,
		ScorePercentual:        p.ScorePercentual,
	}
}
