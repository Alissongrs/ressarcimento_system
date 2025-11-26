package models

import "time"

type HistoricoMovimentacao struct {
	ID                 int64     `json:"id"`
	RequisicaoID       int64     `json:"id_requisicao"` // <-- necessário para o automation_service.go
	NomeUsuario        string    `json:"nome_usuario"`
	StatusAnterior     string    `json:"status_anterior"`
	StatusNovo         string    `json:"status_novo"`
	EtapaAnterior      string    `json:"etapa_anterior"`
	EtapaNova          string    `json:"etapa_nova"`
	RelevanciaAnterior string    `json:"relevancia_anterior"`
	RelevanciaNova     string    `json:"relevancia_nova"`
	SubEtapa           string    `json:"sub_etapa"`
	Comentario         string    `json:"comentario"`
	DataMovimentacao   time.Time `json:"data_movimentacao"`
	// Campos opcionais para futuras consultas que retornem sub-etapas separadas
	SubEtapaAnterior string `json:"sub_etapa_anterior,omitempty"`
	SubEtapaNova     string `json:"sub_etapa_nova,omitempty"`
	TipoMovimentacao string `json:"tipo_movimentacao,omitempty"`
}
