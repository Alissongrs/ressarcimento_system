// models/models.go

package models

import (
	"database/sql"
	"time"

	"github.com/shopspring/decimal"
)

// User representa a estrutura da tabela 'DM_USUARIO'.
type User struct {
	ID             int64  `json:"id"`
	Nome           string `json:"nome"`
	Email          string `json:"email"`
	Senha          string `json:"senha,omitempty"`
	TipoConta      string `json:"tipo_conta"`
	IDDepartamento int64  `json:"id_departamento"`
}

// Requisicao representa a estrutura completa de uma requisição.
type Requisicao struct {
	ID                      int64          `json:"id"`
	UsuarioID               sql.NullInt64  `json:"usuario_id"`
	NomeUsuario             sql.NullString `json:"nome_usuario"`
	Prioridade              sql.NullString `json:"prioridade"`
	UC                      sql.NullString `json:"uc"`
	Cliente                 sql.NullString `json:"cliente"`
	RazaoSocialFatura       sql.NullString `json:"razao_social_fatura"`
	Concessionaria          sql.NullString `json:"concessionaria"`
	RessarcimentoEstimado   sql.NullString `json:"ressarcimento_estimado"`
	PeriodosIrregularidade  sql.NullString `json:"periodos_irregularidade"`
	DescricaoIrregularidade sql.NullString `json:"descricao_irregularidade"`
	DataAlerta              sql.NullString `json:"data_alerta"`
	LinkFatura              sql.NullString `json:"link_fatura"`
	Status                  string         `json:"status"`
	Relevancia              sql.NullBool   `json:"relevancia"`
	ProcessoCriado          bool           `json:"processo_criado"`
	CreatedAt               time.Time      `json:"created_at"`
	DataMudancaStatus       time.Time      `json:"data_mudanca_status"`
	EtapaAtual              sql.NullString `json:"etapa_atual"`
	ColunaKanban            sql.NullString `json:"coluna_kanban"`

	// 🔹 novos campos para irregularidades
	TipoIrregularidadeID    sql.NullInt64 `json:"id_tipo_irregularidade"`
	SubtipoIrregularidadeID sql.NullInt64 `json:"id_subtipo_irregularidade"`

	Deferimento        *Deferimento        `json:"deferimento,omitempty"`
	FluxoRessarcimento *FluxoRessarcimento `json:"fluxo_ressarcimento,omitempty"`
}

// Processo representa um item no Kanban, agora alinhado com a nova estrutura do DB.
type Processo struct {
	ID                 int64               `json:"id"`
	UltimaAtualizacao  sql.NullTime        `json:"ultima_atualizacao"`
	NomeCliente        sql.NullString      `json:"nome_cliente"`
	UnidadeConsumidora sql.NullString      `json:"unidade_consumidora"`
	DataAlerta         sql.NullTime        `json:"data_alerta"`
	ValorEstimado      decimal.NullDecimal `json:"ressarcimento_estimado"`
	Tags               []Tag               `json:"tags"`
	TemPendencia       bool                `json:"tem_pendencia"`
	Relevancia         bool                `json:"relevancia"`
	EtapaAtual         string              `json:"etapa_atual"`
	SubEtapa           sql.NullString      `json:"sub_etapa"`
	FluxoRessarcimento *FluxoRessarcimento `json:"fluxo_ressarcimento"`
	Deferimento        *Deferimento        `json:"deferimento"`
	Concessionaria     sql.NullString      `json:"concessionaria"`

	// Campos adicionais
	Etapa        string         `json:"etapa"`
	Cidade       sql.NullString `json:"cidade"`
	Estado       sql.NullString `json:"estado"`
	ColunaKanban string         `json:"coluna_kanban"`
	Suspenso     bool           `json:"suspenso"`
}

// Deferimento representa os dados da tabela FT_DEFERIMENTOS.
type Deferimento struct {
	StatusAnalise    sql.NullString      `json:"status_analise"`
	DataProcedencia  sql.NullTime        `json:"data_procedencia"`
	CreditoSimples   decimal.NullDecimal `json:"credito_simples"`
	CreditoDobro     decimal.NullDecimal `json:"credito_dobro"`
	DataCreditoDobro sql.NullTime        `json:"data_credito_dobro"`
	RepasseSimples   decimal.NullDecimal `json:"repasse_simples"`
	RepasseDobro     decimal.NullDecimal `json:"repasse_dobro"`
}

// DeferimentoInput é usada para receber os dados do JSON do frontend ao salvar.
type DeferimentoInput struct {
	StatusAnalise    string `json:"status_analise"`
	DataProcedencia  string `json:"data_procedencia"`
	CreditoSimples   string `json:"credito_simples"`   // Recebe como string, converte no handler
	CreditoDobro     string `json:"credito_dobro"`     // Recebe como string, converte no handler
	DataCreditoDobro string `json:"data_credito_dobro"`
	RepasseSimples   string `json:"repasse_simples"`
	RepasseDobro     string `json:"repasse_dobro"`
}

// FluxoRessarcimento representa os campos do fluxo no banco de dados.
type FluxoRessarcimento struct {
	FormaDevolucao           sql.NullString `json:"FormaDevolucao"`
	DataRessarcimentoCliente sql.NullTime   `json:"DataRessarcimentoCliente"`
	DataRessarcimentoDobro   sql.NullTime   `json:"DataRessarcimentoDobro"`
	DataRepasseAmee          sql.NullTime   `json:"DataRepasseAmee"`
	DataEnvioGestao          sql.NullTime   `json:"DataEnvioGestao"`
	NumeroNF                 sql.NullString `json:"NumeroNF"`
	DataEmissaoNF            sql.NullTime   `json:"DataEmissaoNF"`
	DataPagamentoNF          sql.NullTime   `json:"DataPagamentoNF"`
}

// FluxoRessarcimentoInput é usada para receber os dados do JSON do frontend.
type FluxoRessarcimentoInput struct {
	FormasDevolucao          []string `json:"formas_devolucao"`
	DataRessarcimentoCliente string   `json:"data_ressarcimento_cliente"`
	DataRessarcimentoDobro   string   `json:"data_ressarcimento_dobro"`
	DataRepasseAmee          string   `json:"data_repasse_amee"`
	DataEnvioGestao          string   `json:"data_envio_gestao"`
	NumeroNF                 string   `json:"numero_nf"`
	DataEmissaoNF            string   `json:"data_emissao_nf"`
	DataPagamentoNF          string   `json:"data_pagamento_nf"`
}

// FluxoRessarcimentoItem representa um item de devolução no fluxo de ressarcimento
type FluxoRessarcimentoItem struct {
	ID                  int    `json:"id" db:"id_fluxo"`
	IDProcesso          int    `json:"id_processo" db:"id_processo"`
	FormaDevolucao      string `json:"forma_devolucao" db:"forma_devolucao"`
	Valor               string `json:"valor" db:"valor"` // Recebe como string, converte no handler
	DataDevolucao       string `json:"data_devolucao" db:"data_devolucao"`
	DataEnvioFinanceiro string `json:"data_envio_financeiro" db:"data_envio_financeiro"`
	CreatedAt           string `json:"created_at" db:"created_at"`
}

// FluxoRessarcimentoRequest representa a requisição para salvar dados do fluxo
type FluxoRessarcimentoRequest struct {
	Itens []FluxoRessarcimentoItem `json:"itens"`
}

// FaturamentoItem representa um item de faturamento
type FaturamentoItem struct {
	ID             int    `json:"id" db:"id_faturamento"`
	IDProcesso     int    `json:"id_processo" db:"id_processo"`
	NumeroNF       string `json:"numero_nf" db:"numero_nf"`
	DataEmissao    string `json:"data_emissao" db:"data_emissao"`
	DataVencimento string `json:"data_vencimento" db:"data_vencimento"`
	DataPagamento  string `json:"data_pagamento" db:"data_pagamento"`
	Valor          string `json:"valor" db:"valor"` // Recebe como string, converte no handler
	CreatedAt      string `json:"created_at" db:"created_at"`
}

// FaturamentoRequest representa a requisição para salvar dados do faturamento
type FaturamentoRequest struct {
	Itens []FaturamentoItem `json:"itens"`
}

// FaturamentoStats representa estatísticas do faturamento
type FaturamentoStats struct {
	TotalItens    int             `json:"total_itens"`
	ValorTotal    decimal.Decimal `json:"valor_total"`
	ItensPagos    int             `json:"itens_pagos"`
	ItensVencidos int             `json:"itens_vencidos"`
}

// Anexo representa um arquivo anexado.
type Anexo struct {
	ID             int64        `json:"id"`
	NomeArquivo    string       `json:"nome_arquivo"`
	CaminhoArquivo string       `json:"caminho_arquivo"`
	EnviadoPor     string       `json:"enviado_por"`
	DataUpload     sql.NullTime `json:"data_upload"`
}

// Tag representa a estrutura da tabela 'DM_TAGS'.
type Tag struct {
	ID   int64  `json:"id"`
	Nome string `json:"nome"`
	Cor  string `json:"cor"`
}

// Alerta representa uma notificação para um usuário.
type Alerta struct {
	ID          int64         `json:"id"`
	ProcessoID  sql.NullInt64 `json:"processo_id" swaggertype:"integer"`
	Mensagem    string        `json:"mensagem"`
	Lido        bool          `json:"lido"`
	DataCriacao time.Time     `json:"data_criacao"`
}

// FaturaDetalhada representa uma linha na tabela de Análise de Faturas.
type FaturaDetalhada struct {
	CodFatura           string          `json:"cod_fatura"`
	Tipo                sql.NullString  `json:"tipo"`
	MesRef              sql.NullString  `json:"mes_ref"`
	DataEmissao         sql.NullString  `json:"data_emissao"`
	DataVencimento      sql.NullString  `json:"data_vencimento"`
	Link                sql.NullString  `json:"link"`
	ValorTotal          sql.NullFloat64 `json:"valor_total"`
	Consumo             sql.NullFloat64 `json:"consumo"`
	EmpresaRazaoSocial  sql.NullString  `json:"empresa_razao_social"`
	ConcessionariaSigla sql.NullString  `json:"concessionaria_sigla"`
	UC                  string          `json:"uc"`
	Tensao              sql.NullString  `json:"tensao"`
}

// EmpresaFiltro é usada para preencher a caixa suspensa de empresas.
type EmpresaFiltro struct {
	CodEmpresa int    `json:"cod_empresa"`
	RzSocial   string `json:"rz_social"`
}

// ConcessionariaFiltro foi atualizado para corresponder à consulta.
type ConcessionariaFiltro struct {
	CodConcess int    `json:"cod_concess"`
	Sigla      string `json:"sigla"`
}

// UCDetalhes fornece detalhes da consulta de UC.
type UCDetalhes struct {
	UC                   string         `json:"uc"`
	Cliente              sql.NullString `json:"cliente" swaggertype:"string"`
	RazaoSocialFatura    sql.NullString `json:"razao_social_fatura" swaggertype:"string"`
	Concessionaria       sql.NullString `json:"concessionaria" swaggertype:"string"`
	CNPJ                 sql.NullString `json:"cnpj" swaggertype:"string"`
	EnderecoCompleto     sql.NullString `json:"endereco_completo" swaggertype:"string"`
	LinkFatura           sql.NullString `json:"link_fatura" swaggertype:"string"`
	IDUC                 *int64         `json:"id_uc,omitempty"`
	IDEmpresa            *int64         `json:"id_empresa,omitempty"`
	IDConcessionaria     *int64         `json:"id_concessionaria,omitempty"`
	LinksFaturas         []string       `json:"links_faturas,omitempty"`
	LinksFaturasDetalhes []FaturaLink   `json:"links_faturas_detalhes,omitempty"`
}

// FaturaLink representa um par Mes_Ref -> Link
type FaturaLink struct {
	Link   string `json:"link"`
	MesRef string `json:"mes_ref"`
}

// EmailProcesso representa um e-mail trocado.
type EmailProcesso struct {
	ID                 int64          `json:"id_email"`
	ProcessoID         int64          `json:"id_processo"`
	UsuarioRemetenteID sql.NullInt64  `json:"id_usuario_remetente"`
	UsuarioRemetente   sql.NullString `json:"usuario_remetente,omitempty"`
	DeEmail            string         `json:"de_email"`
	ParaEmail          string         `json:"para_email"`
	CcEmail            sql.NullString `json:"cc_email"`
	CcoEmail           sql.NullString `json:"cco_email"`
	Assunto            sql.NullString `json:"assunto"`
	Corpo              sql.NullString `json:"corpo"`
	DataEnvio          time.Time      `json:"data_envio"`
	Tipo               string         `json:"tipo"`
	ReadBy             []string       `json:"read_by,omitempty"`
}

// Departamento representa a estrutura da tabela DM_DEPARTAMENTO.
type Departamento struct {
	ID   int64  `json:"id_departamento"`
	Nome string `json:"nome"`
}
