package handlers

import (
	"database/sql"
	"strings"

	"gorm.io/gorm"
)

// updateColunaByData aplica regra de coluna baseada nos dados de deferimento/fluxo/faturamento.
// Ordem: Faturamento -> Fluxo -> Deferidos -> (Ativos por etapa/subetapa) -> fallback por etapa.
func updateColunaByData(tx *gorm.DB, processoID int) error {
	// Deferimentos
	var ds, dd sql.NullTime
	_ = queryRowGorm(tx, `SELECT data_procedencia, data_credito_dobro FROM FT_DEFERIMENTOS WHERE id_processo = ?`, processoID).
		Scan(&ds, &dd)
	hasDefer := ds.Valid || dd.Valid

	// Fluxo
	var fluxoValor sql.NullFloat64
	var fluxoData, fluxoEnvio sql.NullTime
	var fluxoForma sql.NullString
	_ = queryRowGorm(tx, `SELECT valor, data_devolucao, data_envio_financeiro, forma_devolucao FROM FT_FLUXO_RESSARCIMENTO WHERE id_processo = ?`, processoID).
		Scan(&fluxoValor, &fluxoData, &fluxoEnvio, &fluxoForma)
	hasFluxo := (fluxoValor.Valid && fluxoValor.Float64 != 0) || fluxoData.Valid || fluxoEnvio.Valid || (fluxoForma.Valid && strings.TrimSpace(fluxoForma.String) != "")

	// Faturamento
	var nf sql.NullString
	var fatEmissao, fatVenc, fatPag sql.NullTime
	var fatValor sql.NullFloat64
	_ = queryRowGorm(tx, `SELECT numero_nf, data_emissao, data_vencimento, data_pagamento, valor FROM FT_FATURAMENTO WHERE id_processo = ?`, processoID).
		Scan(&nf, &fatEmissao, &fatVenc, &fatPag, &fatValor)
	hasFat := (nf.Valid && strings.TrimSpace(nf.String) != "") || fatEmissao.Valid || fatVenc.Valid || fatPag.Valid || (fatValor.Valid && fatValor.Float64 != 0)

	targetCol := int64(0)
	targetName := ""

	switch {
	case hasFat:
		targetCol = 4
		targetName = "Faturamento"
	case hasFluxo:
		targetCol = 3
		targetName = "Fluxo de Ressarcimento"
	case hasDefer:
		targetCol = 2
		targetName = "Deferidos"
	default:
		// Fallback por etapa/subetapa
		var etapa, sub sql.NullString
		_ = queryRowGorm(tx, `SELECT e.etapa, p.sub_etapa FROM FT_PROCESSOS p JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo WHERE p.id_processo = ?`, processoID).
			Scan(&etapa, &sub)
		et := strings.TrimSpace(etapa.String)
		sb := strings.TrimSpace(sub.String)
		if et == "Distribuidora" || et == "Ouvidoria" || et == "ANEEL" || et == "SMA" {
			if sb == "Primeira reclamação da etapa - Em elaboração" ||
				sb == "Primeira reclamação da etapa - Aguardando retorno" ||
				sb == "Primeira reclamação da etapa - Em análise" ||
				sb == "Primeira reclamação da etapa - Pendente" {
				targetCol = 1
				targetName = "Ativos"
			}
		}
	}

	if targetCol == 0 {
		// usa coluna da etapa
		var colID sql.NullInt64
		var colNome sql.NullString
		_ = queryRowGorm(tx, `
			SELECT k.id_coluna, k.nome_coluna
			  FROM FT_PROCESSOS p
			  JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
			  JOIN DM_KANBAN_COLUNAS k ON k.id_coluna = e.id_coluna_kanban
			 WHERE p.id_processo = ?`, processoID).
			Scan(&colID, &colNome)
		if colID.Valid {
			targetCol = colID.Int64
		}
		if colNome.Valid {
			targetName = colNome.String
		}
	}

	if targetCol != 0 {
		_, err := execGorm(tx, `UPDATE FT_PROCESSOS SET id_coluna = ?, nome_coluna = ? WHERE id_processo = ?`, targetCol, targetName, processoID)
		return err
	}
	return nil
}




