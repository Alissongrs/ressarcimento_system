package handlers

import (
	"database/sql"
	"strings"

	"gorm.io/gorm"
)

// updateColunaByData aplica regra de coluna baseada nos dados de deferimento/fluxo/faturamento.
// Ordem: Faturamento -> Fluxo -> Deferidos -> (Ativos por etapa/subetapa) -> fallback por etapa.
// Quando houver mudança automática de coluna, registra histórico com o usuário que realizou a ação.
func updateColunaByData(tx *gorm.DB, processoID int, userID int64) error {
	// Deferimentos
	var ds, dd sql.NullTime
	var cs, cd, rs, rd sql.NullFloat64
	_ = queryRowGorm(tx, `
		SELECT data_procedencia, data_credito_dobro, credito_simples, credito_dobro, repasse_simples, repasse_dobro
		  FROM FT_DEFERIMENTOS
		 WHERE id_processo = ?`, processoID).
		Scan(&ds, &dd, &cs, &cd, &rs, &rd)
	hasDefer := ds.Valid || dd.Valid ||
		(cs.Valid && cs.Float64 != 0) || (cd.Valid && cd.Float64 != 0) ||
		(rs.Valid && rs.Float64 != 0) || (rd.Valid && rd.Float64 != 0)

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
	hasFat := fatValor.Valid && fatValor.Float64 != 0
	hasPagamento := fatPag.Valid

	targetCol := int64(0)
	targetName := ""

	switch {
	case hasPagamento:
		targetCol = 5
		targetName = "Concluídos"
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

	if targetCol == 0 {
		return nil
	}

	var curCol sql.NullInt64
	var curNome sql.NullString
	_ = queryRowGorm(tx, `SELECT id_coluna, nome_coluna FROM FT_PROCESSOS WHERE id_processo = ?`, processoID).
		Scan(&curCol, &curNome)
	if curCol.Valid && curCol.Int64 == targetCol {
		return nil
	}

	if _, err := execGorm(tx, `UPDATE FT_PROCESSOS SET id_coluna = ?, nome_coluna = ?, ultima_atualizacao = NOW() WHERE id_processo = ?`, targetCol, targetName, processoID); err != nil {
		return err
	}

	if userID > 0 {
		var etapa, sub sql.NullString
		_ = queryRowGorm(tx, `SELECT e.etapa, p.sub_etapa FROM FT_PROCESSOS p JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo WHERE p.id_processo = ?`, processoID).
			Scan(&etapa, &sub)
		status := strings.TrimSpace(etapa.String)
		if s := strings.TrimSpace(sub.String); s != "" {
			status = status + " - " + s
		}
		_, _ = execGorm(tx, `
			INSERT INTO FT_HISTORICO_MOVIMENTACOES
			  (id_requisicao, id_usuario_gestor, status_anterior, status_novo,
			   etapa_anterior, etapa_nova, sub_etapa,
			   comentario, data_movimentacao, tipo_movimentacao)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'auto')`,
			processoID, userID,
			status, status,
			etapa.String, etapa.String, sub.String,
			"Atualização automática de coluna para "+targetName,
		)
	}
	return nil
}
