package handlers

import (
	"database/sql"
	"strings"

	"gorm.io/gorm"
)

// deferimentoSubetapaMap mapeia subetapas pre-deferimento para subetapas pos-deferimento (em conciliacao).
// Quando o processo recebe dados de deferimento (FT_DEFERIMENTOS), ele deve avancar de
// "Em contestacao - X" ou "Primeira reclamacao - X" para "Em Conciliacao - X" mantendo o sufixo de estado.
// IDs conforme DM_SUBETAPA_PROCESSOS.
var deferimentoSubetapaMap = map[int64]struct {
	NovoID   int64
	NovoNome string
}{
	1: {10, "Em conciliação - Em elaboração"},      // Primeira reclamação - Em elaboração
	2: {11, "Em Conciliação - Aguardando retorno"}, // Primeira reclamação - Aguardando retorno
	3: {10, "Em conciliação - Em elaboração"},      // Em contestação - Em elaboração
	4: {12, "Em Conciliação - Em análise"},         // Primeira reclamação - Em análise
	6: {13, "Em Conciliação - Pendente"},           // Primeira reclamação - Pendente
	7: {11, "Em Conciliação - Aguardando retorno"}, // Em contestação - Aguardando retorno
	8: {12, "Em Conciliação - Em análise"},         // Em contestação - Em análise
	9: {13, "Em Conciliação - Pendente"},           // Em contestação - Pendente
}

// updateColunaByData aplica regra de coluna baseada nos dados de deferimento/fluxo/faturamento.
// Ordem: Faturamento -> Fluxo -> Deferidos -> (Ativos por etapa/subetapa) -> fallback por etapa.
// Quando houver mudança automática de coluna, registra histórico com o usuário que realizou a ação.
//
// Quando hasDefer dispara coluna "Deferidos", a sub-etapa atual e automaticamente promovida
// de "Em contestacao - X"/"Primeira reclamacao - X" para "Em Conciliacao - X" via deferimentoSubetapaMap.
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
	// Promocao automatica de sub-etapa apos deferimento (so dispara quando hasDefer).
	// Mantem 0/"" quando nao se aplica (caso outras colunas ou subetapa fora do mapa).
	targetSubID := int64(0)
	targetSubNome := ""

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
		// Quando entra em Deferidos, promove sub-etapa "Em contestacao - X" / "Primeira reclamacao - X"
		// para "Em Conciliacao - X" mantendo o sufixo de estado (Em elaboracao / Aguardando retorno / etc).
		var curSubID sql.NullInt64
		_ = queryRowGorm(tx, `SELECT id_sub_etapa_processo FROM FT_PROCESSOS WHERE id_processo = ?`, processoID).
			Scan(&curSubID)
		if curSubID.Valid {
			if novo, ok := deferimentoSubetapaMap[curSubID.Int64]; ok && novo.NovoID != curSubID.Int64 {
				targetSubID = novo.NovoID
				targetSubNome = novo.NovoNome
			}
		}
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
	// Early return so se NAO houver mudanca de coluna E NAO houver promocao de sub-etapa pendente.
	mesmaColuna := curCol.Valid && curCol.Int64 == targetCol
	if mesmaColuna && targetSubID == 0 {
		return nil
	}

	if targetSubID > 0 {
		// UPDATE estendido: coluna + sub-etapa (promocao pos-deferimento)
		if _, err := execGorm(tx, `UPDATE FT_PROCESSOS SET id_coluna = ?, nome_coluna = ?, id_sub_etapa_processo = ?, sub_etapa = ?, ultima_atualizacao = NOW() WHERE id_processo = ?`, targetCol, targetName, targetSubID, targetSubNome, processoID); err != nil {
			return err
		}
	} else if !mesmaColuna {
		// UPDATE so de coluna (comportamento original)
		if _, err := execGorm(tx, `UPDATE FT_PROCESSOS SET id_coluna = ?, nome_coluna = ?, ultima_atualizacao = NOW() WHERE id_processo = ?`, targetCol, targetName, processoID); err != nil {
			return err
		}
	}

	if userID > 0 {
		var etapa, sub sql.NullString
		_ = queryRowGorm(tx, `SELECT e.etapa, p.sub_etapa FROM FT_PROCESSOS p JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo WHERE p.id_processo = ?`, processoID).
			Scan(&etapa, &sub)
		statusNovo := strings.TrimSpace(etapa.String)
		if s := strings.TrimSpace(sub.String); s != "" {
			statusNovo = statusNovo + " - " + s
		}
		comentario := "Atualização automática de coluna para " + targetName
		statusAnterior := statusNovo
		if targetSubID > 0 {
			// Promocao de sub-etapa pos-deferimento: status_anterior reflete a sub-etapa antiga
			// pra rastrear a transicao no historico.
			etapaTxt := strings.TrimSpace(etapa.String)
			// Tenta inverter o mapping pra recuperar a sub_etapa anterior (heuristica: troca "Em Conciliação"/"Em conciliação" por "Em contestação")
			subAnterior := strings.Replace(targetSubNome, "Em Conciliação", "Em contestação", 1)
			subAnterior = strings.Replace(subAnterior, "Em conciliação", "Em contestação", 1)
			statusAnterior = etapaTxt + " - " + subAnterior
			comentario = "Atualização automática: coluna -> " + targetName + " | sub-etapa: " + subAnterior + " -> " + targetSubNome
		}
		_, _ = execGorm(tx, `
			INSERT INTO FT_HISTORICO_MOVIMENTACOES
			  (id_requisicao, id_usuario_gestor, status_anterior, status_novo,
			   etapa_anterior, etapa_nova, sub_etapa,
			   comentario, data_movimentacao, tipo_movimentacao)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'auto')`,
			processoID, userID,
			statusAnterior, statusNovo,
			etapa.String, etapa.String, sub.String,
			comentario,
		)
	}
	return nil
}

// SincronizarStatusProcesso mantem FT_PROCESSOS coerente com a ULTIMA movimentacao
// do FT_HISTORICO_MOVIMENTACOES (fonte de verdade — regra de negocio 26/05/2026).
//
// Deve ser chamada DENTRO da mesma transacao, DEPOIS de inserir a movimentacao no
// historico. Recalcula o estado a partir do historico, entao funciona independente
// de como/onde o INSERT foi feito (movimentacao, comentario, admin, importacao).
//
// Protecoes (espelham trigger_sync_ft_processos.sql):
//   - So considera movimentacoes cuja etapa_nova existe em DM_ETAPAS_PROCESSO.
//   - So atualiza se a movimentacao for MAIS RECENTE que FT_PROCESSOS.data_movimentacao
//     (nunca regride para movimentacao antiga/retroativa; empate => mantem atual).
//   - NAO toca processos suspensos (suspenso=1).
//   - sub_etapa do historico so sobrescreve se nao for vazia/NULL.
//   - Mapeia id_coluna/nome_coluna via DM_ETAPAS_PROCESSO.id_coluna_kanban + DM_KANBAN_COLUNAS.
//
// Best-effort: o erro e retornado para log, mas o chamador normalmente ignora
// (a movimentacao no historico ja foi gravada — a sync nao deve reverter isso).
func SincronizarStatusProcesso(tx *gorm.DB, processoID int) error {
	_, err := execGorm(tx, `
		UPDATE FT_PROCESSOS p
		JOIN (
			SELECT h.id_requisicao, h.etapa_nova, h.sub_etapa, h.data_movimentacao,
			       d.id_etapa_processo, d.id_coluna_kanban, kc.nome_coluna
			  FROM FT_HISTORICO_MOVIMENTACOES h
			  JOIN DM_ETAPAS_PROCESSO d ON TRIM(LOWER(d.etapa)) = TRIM(LOWER(h.etapa_nova))
			  JOIN DM_KANBAN_COLUNAS  kc ON kc.id_coluna = d.id_coluna_kanban
			 WHERE h.id_requisicao = ?
			 ORDER BY h.data_movimentacao DESC, h.id_historico DESC
			 LIMIT 1
		) u ON u.id_requisicao = p.id_processo
		SET p.etapa              = u.etapa_nova,
		    p.id_etapa_processo  = u.id_etapa_processo,
		    p.sub_etapa          = COALESCE(NULLIF(TRIM(u.sub_etapa), ''), p.sub_etapa),
		    p.id_coluna          = u.id_coluna_kanban,
		    p.nome_coluna        = u.nome_coluna,
		    p.data_movimentacao  = u.data_movimentacao,
		    p.ultima_atualizacao = NOW()
		WHERE p.id_processo = ?
		  AND COALESCE(p.suspenso, 0) = 0
		  AND (p.data_movimentacao IS NULL OR u.data_movimentacao > p.data_movimentacao)`,
		processoID, processoID)
	return err
}
