package handlers

import (
    "database/sql"
    "encoding/csv"
    "fmt"
    "io"
    "log"
    "net/http"
    "strconv"
    "strings"

    "ressarcimento-backend/database"

    "github.com/gin-gonic/gin"
)

// PlanilhaRow representa uma linha "achatada" (processo x item do histórico)
type PlanilhaRow struct {
    ProcessoID        int64   `json:"processo_id"`
    Uc                string  `json:"uc"`
    CNPJ              string  `json:"cnpj"`
    Concessionaria    string  `json:"concessionaria"`
    Cliente           string  `json:"cliente"`
    TipoIrregularidade    string `json:"tipo_irregularidade"`
    SubtipoIrregularidade string `json:"subtipo_irregularidade"`
    RessarcimentoEstimado float64 `json:"ressarcimento_estimado"`
    NomeColuna        string  `json:"nome_coluna"`
    EtapaAtual        string  `json:"etapa_atual"`

    CreditoSimples    float64 `json:"credito_simples"`
    DataSimples       string  `json:"data_simples"`
    CreditoDobro      float64 `json:"credito_dobro"`
    DataDobro         string  `json:"data_dobro"`
    RepasseSimples    float64 `json:"repasse_simples"`
    RepasseDobro      float64 `json:"repasse_dobro"`

    FormaDevolucao    string  `json:"forma_devolucao"`
    ValorFluxo        float64 `json:"valor_fluxo"`
    FluxoSimples      int     `json:"fluxo_simples"`
    FluxoDobro        int     `json:"fluxo_dobro"`
    FluxoSimplesDobro int     `json:"fluxo_simples_dobro"`
    DataFluxo         string  `json:"data_fluxo"`

    NumeroNF          string  `json:"numero_nf"`
    DataEmissao       string  `json:"data_emissao"`
    DataVencimento    string  `json:"data_vencimento"`
    DataPagamento     string  `json:"data_pagamento"`
    ValorNF           float64 `json:"valor_nf"`

    // Histórico
    IDHistorico       int64    `json:"id_historico"`
    HistData          string   `json:"hist_data"`
    HistComentario    string   `json:"hist_comentario"`
    Etapa             string   `json:"etapa"`
    SubEtapa          string   `json:"sub_etapa"`
    TipoMov           string   `json:"tipo_movimentacao"`

    // Score de Progressão (cache de FT_PROCESSOS)
    ScorePercentual   *float64 `json:"score_percentual"`
}

// GET /api/v1/admin/processos
// AdminPlanilhaList godoc
// @Summary      Lista planilha admin
// @Tags         Admin
// @Param        q                query  string  false  "Busca"
// @Param        etapa            query  string  false  "Etapa"
// @Param        sub              query  string  false  "Subetapa"
// @Param        kanban           query  string  false  "Coluna kanban"
// @Param        ini              query  string  false  "Data inicial"
// @Param        fim              query  string  false  "Data final"
// @Param        analise          query  string  false  "Status análise"
// @Param        status           query  string  false  "Status"
// @Param        pendencias       query  string  false  "Pendências"
// @Param        historico        query  string  false  "Histórico"
// @Param        tags             query  string  false  "Tags"
// @Param        data_criacao_ini query  string  false  "Data criaÃ§ão inicial"
// @Param        data_criacao_fim query  string  false  "Data criaÃ§ão final"
// @Param        gestores         query  string  false  "Gestores"
// @Param        limit            query  int     false  "Limite"
// @Param        offset           query  int     false  "Offset"
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/admin/processos [get]
func AdminPlanilhaList(c *gin.Context) {
    q := strings.TrimSpace(c.Query("q"))
    etapa := strings.TrimSpace(c.Query("etapa"))
    sub := strings.TrimSpace(c.Query("sub"))
    ini := strings.TrimSpace(c.Query("ini")) // YYYY-MM-DD
    fim := strings.TrimSpace(c.Query("fim")) // YYYY-MM-DD
    coluna := strings.TrimSpace(c.Query("coluna"))
    limitVal, err := strconv.Atoi(strings.TrimSpace(c.DefaultQuery("limit", "100")))
    if err != nil || limitVal < 1 {
        limitVal = 100
    }
    if limitVal > 500 {
        limitVal = 500
    }
    offsetVal, err := strconv.Atoi(strings.TrimSpace(c.DefaultQuery("offset", "0")))
    if err != nil || offsetVal < 0 {
        offsetVal = 0
    }

    // Monta SQL base (usa LEFT JOIN e subselect para pegar último fluxo/faturamento)
    sqlBase := `
        SELECT
          p.id_processo                                     AS processo_id,
          COALESCE(r.uc, '')                                AS uc,
          COALESCE(r.cnpj, '')                              AS cnpj,
          COALESCE(r.concessionaria, '')                    AS concessionaria,
          COALESCE(r.cliente, '')                           AS cliente,
          COALESCE(ti.nome, '')                             AS tipo_irregularidade,
          COALESCE(sti.nome, '')                            AS subtipo_irregularidade,
          COALESCE(r.ressarcimento_estimado, 0)             AS ressarcimento_estimado,
          COALESCE(p.nome_coluna, kanb.nome_coluna, '')     AS nome_coluna,
          COALESCE(etapa.etapa, '')                         AS etapa_atual,

          COALESCE(d.credito_simples, 0)                    AS credito_simples,
          COALESCE(DATE_FORMAT(d.data_procedencia, '%Y-%m-%d'), '') AS data_simples,
          COALESCE(d.credito_dobro, 0)                      AS credito_dobro,
          COALESCE(DATE_FORMAT(d.data_credito_dobro, '%Y-%m-%d'), '') AS data_dobro,
          COALESCE(d.repasse_simples, 0)                    AS repasse_simples,
          COALESCE(d.repasse_dobro, 0)                      AS repasse_dobro,

          COALESCE(fr.forma_devolucao, '')                  AS forma_devolucao,
          COALESCE(fr.valor, 0)                             AS valor_fluxo,
          COALESCE(fr.simples, 0)                           AS fluxo_simples,
          COALESCE(fr.dobro, 0)                             AS fluxo_dobro,
          COALESCE(fr.simples_dobro, 0)                     AS fluxo_simples_dobro,
          COALESCE(DATE_FORMAT(fr.data_devolucao, '%Y-%m-%d'), '') AS data_fluxo,

          COALESCE(f.numero_nf, '')                         AS numero_nf,
          COALESCE(DATE_FORMAT(f.data_emissao, '%Y-%m-%d'), '')     AS data_emissao,
          COALESCE(DATE_FORMAT(f.data_vencimento, '%Y-%m-%d'), '')  AS data_vencimento,
          COALESCE(DATE_FORMAT(f.data_pagamento, '%Y-%m-%d'), '')   AS data_pagamento,
          COALESCE(f.valor, 0)                              AS valor_nf,

          COALESCE(h.id_historico, 0)                       AS id_historico,
          COALESCE(DATE_FORMAT(h.data_movimentacao, '%Y-%m-%d %H:%i:%s'), '') AS hist_data,
          COALESCE(h.comentario, '')                        AS hist_comentario,
          COALESCE(h.etapa_nova, '')                        AS etapa,
          COALESCE(h.sub_etapa, '')                         AS sub_etapa,
          COALESCE(h.tipo_movimentacao, '')                 AS tipo_movimentacao,
          p.score_percentual                                AS score_percentual
        FROM FT_PROCESSOS p
        JOIN FT_REQUISICOES r         ON r.id_requisicao = p.id_processo
        JOIN DM_ETAPAS_PROCESSO etapa ON p.id_etapa_processo = etapa.id_etapa_processo
        JOIN DM_KANBAN_COLUNAS kanb ON etapa.id_coluna_kanban = kanb.id_coluna
        LEFT JOIN DM_TIPO_IRREGULARIDADE ti ON ti.id_tipo = r.id_tipo_irregularidade
        LEFT JOIN DM_SUBTIPO_IRREGULARIDADE sti ON sti.id_subtipo = r.id_subtipo_irregularidade
        LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON h.id_requisicao = p.id_processo
        LEFT JOIN FT_DEFERIMENTOS d        ON d.id_processo     = p.id_processo
        LEFT JOIN (
          SELECT x.id_processo, x.forma_devolucao, x.valor, x.simples, x.dobro, x.simples_dobro, x.data_devolucao, x.data_envio_financeiro, x.created_at
            FROM FT_FLUXO_RESSARCIMENTO x
            JOIN (
              SELECT id_processo, MAX(created_at) AS mx
                FROM FT_FLUXO_RESSARCIMENTO
               GROUP BY id_processo
            ) ult ON ult.id_processo = x.id_processo AND ult.mx = x.created_at
        ) fr ON fr.id_processo = p.id_processo
        LEFT JOIN (
          SELECT y.id_processo, y.numero_nf, y.data_emissao, y.data_vencimento, y.data_pagamento, y.valor, y.created_at
            FROM FT_FATURAMENTO y
            JOIN (
              SELECT id_processo, MAX(created_at) AS my
                FROM FT_FATURAMENTO
               GROUP BY id_processo
            ) uf ON uf.id_processo = y.id_processo AND uf.my = y.created_at
        ) f ON f.id_processo = p.id_processo
    `

    where := make([]string, 0, 4)
    args := make([]any, 0, 4)
    if q != "" {
        if pid, err2 := strconv.ParseInt(q, 10, 64); err2 == nil && pid > 0 {
            where = append(where, "r.id_requisicao = ?")
            args = append(args, pid)
        } else {
            like := "%" + strings.ToLower(q) + "%"
            where = append(where, "(LOWER(COALESCE(r.cliente,'')) LIKE ? OR LOWER(COALESCE(r.uc,'')) LIKE ? OR LOWER(COALESCE(h.comentario,'')) LIKE ?)")
            args = append(args, like, like, like)
        }
    }
    if etapa != "" {
        where = append(where, "LOWER(COALESCE(h.etapa_nova,'')) = ?")
        args = append(args, strings.ToLower(etapa))
    }
    if sub != "" {
        where = append(where, "LOWER(COALESCE(h.sub_etapa,'')) = ?")
        args = append(args, strings.ToLower(sub))
    }
    if ini != "" {
        where = append(where, "DATE(h.data_movimentacao) >= ?")
        args = append(args, ini)
    }
    if fim != "" {
        where = append(where, "DATE(h.data_movimentacao) <= ?")
        args = append(args, fim)
    }
    if coluna != "" {
        where = append(where, "LOWER(COALESCE(p.nome_coluna, kanb.nome_coluna)) = ?")
        args = append(args, strings.ToLower(coluna))
    }
    if len(where) > 0 {
        sqlBase += " WHERE " + strings.Join(where, " AND ")
    }
    sqlBase += " ORDER BY p.id_processo ASC, h.data_movimentacao ASC"
    sqlBase += " LIMIT ? OFFSET ?"
    args = append(args, limitVal, offsetVal)

    rows, err := queryGorm(database.GormDB_App, sqlBase, args...)
    if err != nil {
        log.Printf("[admin_planilha] query error (full): %v", err)
        // Fallback simples: remove joins de fluxo/faturamento (caso colunas/tabelas não existam).
        sqlBaseFallback := `
        SELECT
          p.id_processo                                     AS processo_id,
          COALESCE(r.uc, '')                                AS uc,
          COALESCE(r.cnpj, '')                              AS cnpj,
          COALESCE(r.concessionaria, '')                    AS concessionaria,
          COALESCE(r.cliente, '')                           AS cliente,
          ''                                                AS tipo_irregularidade,
          ''                                                AS subtipo_irregularidade,
          0                                                 AS ressarcimento_estimado,
          COALESCE(p.nome_coluna, kanb.nome_coluna, '')     AS nome_coluna,
          COALESCE(etapa.etapa, '')                         AS etapa_atual,

          COALESCE(d.credito_simples, 0)                    AS credito_simples,
          COALESCE(DATE_FORMAT(d.data_procedencia, '%Y-%m-%d'), '') AS data_simples,
          COALESCE(d.credito_dobro, 0)                      AS credito_dobro,
          COALESCE(DATE_FORMAT(d.data_credito_dobro, '%Y-%m-%d'), '') AS data_dobro,
          COALESCE(d.repasse_simples, 0)                    AS repasse_simples,
          COALESCE(d.repasse_dobro, 0)                      AS repasse_dobro,

          ''                                                AS forma_devolucao,
          0                                                 AS valor_fluxo,
          0                                                 AS fluxo_simples,
          0                                                 AS fluxo_dobro,
          0                                                 AS fluxo_simples_dobro,
          ''                                                AS data_fluxo,

          ''                                                AS numero_nf,
          ''                                                AS data_emissao,
          ''                                                AS data_vencimento,
          ''                                                AS data_pagamento,
          0                                                 AS valor_nf,

          COALESCE(h.id_historico, 0)                       AS id_historico,
          COALESCE(DATE_FORMAT(h.data_movimentacao, '%Y-%m-%d %H:%i:%s'), '') AS hist_data,
          COALESCE(h.comentario, '')                        AS hist_comentario,
          COALESCE(h.etapa_nova, '')                        AS etapa,
          COALESCE(h.sub_etapa, '')                         AS sub_etapa,
          COALESCE(h.tipo_movimentacao, '')                 AS tipo_movimentacao,
          p.score_percentual                                AS score_percentual
        FROM FT_PROCESSOS p
        JOIN FT_REQUISICOES r         ON r.id_requisicao = p.id_processo
        JOIN DM_ETAPAS_PROCESSO etapa ON p.id_etapa_processo = etapa.id_etapa_processo
        JOIN DM_KANBAN_COLUNAS kanb ON etapa.id_coluna_kanban = kanb.id_coluna
        LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON h.id_requisicao = p.id_processo
        LEFT JOIN FT_DEFERIMENTOS d        ON d.id_processo     = p.id_processo
        `
        if len(where) > 0 {
            sqlBaseFallback += " WHERE " + strings.Join(where, " AND ")
        }
        sqlBaseFallback += " ORDER BY p.id_processo ASC, h.data_movimentacao ASC"
        sqlBaseFallback += " LIMIT ? OFFSET ?"
        fallbackArgs := append(args, limitVal, offsetVal)
        rows, err = queryGorm(database.GormDB_App, sqlBaseFallback, fallbackArgs...)
        if err != nil {
            c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
            return
        }
    }
    defer rows.Close()

    out := make([]PlanilhaRow, 0, 200)
    for rows.Next() {
        var it PlanilhaRow
        if err := rows.Scan(
            &it.ProcessoID, &it.Uc, &it.CNPJ, &it.Concessionaria, &it.Cliente, &it.TipoIrregularidade, &it.SubtipoIrregularidade, &it.RessarcimentoEstimado, &it.NomeColuna, &it.EtapaAtual,
            &it.CreditoSimples, &it.DataSimples, &it.CreditoDobro, &it.DataDobro, &it.RepasseSimples, &it.RepasseDobro,
            &it.FormaDevolucao, &it.ValorFluxo, &it.FluxoSimples, &it.FluxoDobro, &it.FluxoSimplesDobro, &it.DataFluxo,
            &it.NumeroNF, &it.DataEmissao, &it.DataVencimento, &it.DataPagamento, &it.ValorNF,
            &it.IDHistorico, &it.HistData, &it.HistComentario, &it.Etapa, &it.SubEtapa, &it.TipoMov, &it.ScorePercentual,
        ); err == nil {
            out = append(out, it)
        }
    }

    // Fallback: se não retornou linhas (variaÃ§ão de dados/ambiente), tentar baseado em FT_REQUISICOES
    if len(out) == 0 {
        sqlBaseAlt := `
        SELECT
          r.id_requisicao                                   AS processo_id,
          COALESCE(r.uc, '')                                AS uc,
          COALESCE(r.cnpj, '')                              AS cnpj,
          COALESCE(r.concessionaria, '')                    AS concessionaria,
          COALESCE(r.cliente, '')                           AS cliente,
          COALESCE(ti.nome, '')                             AS tipo_irregularidade,
          COALESCE(sti.nome, '')                            AS subtipo_irregularidade,
          COALESCE(r.ressarcimento_estimado, 0)             AS ressarcimento_estimado,
          COALESCE(p.nome_coluna, kanb.nome_coluna, '')     AS nome_coluna,
          COALESCE(etapa.etapa, '')                         AS etapa_atual,

          COALESCE(d.credito_simples, 0)                    AS credito_simples,
          COALESCE(DATE_FORMAT(d.data_procedencia, '%Y-%m-%d'), '') AS data_simples,
          COALESCE(d.credito_dobro, 0)                      AS credito_dobro,
          COALESCE(DATE_FORMAT(d.data_credito_dobro, '%Y-%m-%d'), '') AS data_dobro,
          COALESCE(d.repasse_simples, 0)                    AS repasse_simples,
          COALESCE(d.repasse_dobro, 0)                      AS repasse_dobro,

          COALESCE(fr.forma_devolucao, '')                  AS forma_devolucao,
          COALESCE(fr.valor, 0)                             AS valor_fluxo,
          COALESCE(fr.simples, 0)                           AS fluxo_simples,
          COALESCE(fr.dobro, 0)                             AS fluxo_dobro,
          COALESCE(fr.simples_dobro, 0)                     AS fluxo_simples_dobro,
          COALESCE(DATE_FORMAT(fr.data_devolucao, '%Y-%m-%d'), '') AS data_fluxo,

          COALESCE(f.numero_nf, '')                         AS numero_nf,
          COALESCE(DATE_FORMAT(f.data_emissao, '%Y-%m-%d'), '')     AS data_emissao,
          COALESCE(DATE_FORMAT(f.data_vencimento, '%Y-%m-%d'), '')  AS data_vencimento,
          COALESCE(DATE_FORMAT(f.data_pagamento, '%Y-%m-%d'), '')   AS data_pagamento,
          COALESCE(f.valor, 0)                              AS valor_nf,

          COALESCE(h.id_historico, 0)                       AS id_historico,
          COALESCE(DATE_FORMAT(h.data_movimentacao, '%Y-%m-%d %H:%i:%s'), '') AS hist_data,
          COALESCE(h.comentario, '')                        AS hist_comentario,
          COALESCE(h.etapa_nova, '')                        AS etapa,
          COALESCE(h.sub_etapa, '')                         AS sub_etapa,
          COALESCE(h.tipo_movimentacao, '')                 AS tipo_movimentacao,
          p.score_percentual                                AS score_percentual
        FROM FT_REQUISICOES r
        LEFT JOIN FT_PROCESSOS p ON p.id_processo = r.id_requisicao
        LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON h.id_requisicao = r.id_requisicao
        LEFT JOIN FT_DEFERIMENTOS d ON d.id_processo = r.id_requisicao
        LEFT JOIN DM_ETAPAS_PROCESSO etapa ON p.id_etapa_processo = etapa.id_etapa_processo
        LEFT JOIN DM_KANBAN_COLUNAS kanb ON etapa.id_coluna_kanban = kanb.id_coluna
        LEFT JOIN DM_TIPO_IRREGULARIDADE ti ON ti.id_tipo = r.id_tipo_irregularidade
        LEFT JOIN DM_SUBTIPO_IRREGULARIDADE sti ON sti.id_subtipo = r.id_subtipo_irregularidade
        LEFT JOIN (
          SELECT x.id_processo, x.forma_devolucao, x.valor, x.simples, x.dobro, x.simples_dobro, x.data_devolucao, x.data_envio_financeiro, x.created_at
            FROM FT_FLUXO_RESSARCIMENTO x
            JOIN (
              SELECT id_processo, MAX(created_at) AS mx
                FROM FT_FLUXO_RESSARCIMENTO
               GROUP BY id_processo
            ) ult ON ult.id_processo = x.id_processo AND ult.mx = x.created_at
        ) fr ON fr.id_processo = r.id_requisicao
        LEFT JOIN (
          SELECT y.id_processo, y.numero_nf, y.data_emissao, y.data_vencimento, y.data_pagamento, y.valor, y.created_at
            FROM FT_FATURAMENTO y
            JOIN (
              SELECT id_processo, MAX(created_at) AS my
                FROM FT_FATURAMENTO
               GROUP BY id_processo
            ) uf ON uf.id_processo = y.id_processo AND uf.my = y.created_at
        ) f ON f.id_processo = r.id_requisicao
        `
        if len(where) > 0 {
            sqlBaseAlt += " WHERE " + strings.Join(where, " AND ")
        }
        sqlBaseAlt += " ORDER BY r.id_requisicao ASC, h.data_movimentacao ASC"

        rows2, err2 := queryGorm(database.GormDB_App, sqlBaseAlt, args...)
        if err2 == nil {
            defer rows2.Close()
            for rows2.Next() {
                var it PlanilhaRow
                if err := rows2.Scan(
                    &it.ProcessoID, &it.Uc, &it.CNPJ, &it.Concessionaria, &it.Cliente, &it.TipoIrregularidade, &it.SubtipoIrregularidade, &it.RessarcimentoEstimado, &it.NomeColuna, &it.EtapaAtual,
                    &it.CreditoSimples, &it.DataSimples, &it.CreditoDobro, &it.DataDobro, &it.RepasseSimples, &it.RepasseDobro,
                    &it.FormaDevolucao, &it.ValorFluxo, &it.FluxoSimples, &it.FluxoDobro, &it.FluxoSimplesDobro, &it.DataFluxo,
                    &it.NumeroNF, &it.DataEmissao, &it.DataVencimento, &it.DataPagamento, &it.ValorNF,
                    &it.IDHistorico, &it.HistData, &it.HistComentario, &it.Etapa, &it.SubEtapa, &it.TipoMov, &it.ScorePercentual,
                ); err == nil {
                    out = append(out, it)
                }
            }
        }
    }
    if out == nil { out = []PlanilhaRow{} }
    c.JSON(http.StatusOK, gin.H{"rows": out})
}

// POST /api/v1/admin/processos/bulk-mover
// AdminPlanilhaBulkMover godoc
// @Summary      Move processos em lote (planilha)
// @Tags         Admin
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/admin/processos/bulk-mover [post]
func AdminPlanilhaBulkMover(c *gin.Context) {
    var body struct{
        ProcessoIDs []int64 `json:"processo_ids"`
        Etapa       string  `json:"etapa"`
        SubEtapa    string  `json:"sub_etapa"`
        Comentario  string  `json:"comentario"`
    }
    if err := c.ShouldBindJSON(&body); err != nil || len(body.ProcessoIDs) == 0 || strings.TrimSpace(body.Etapa) == "" {
        c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido"})
        return
    }

    userIDVal, _ := c.Get("userID")
    userID, ok := userIDVal.(int64)
    var userIDNull sql.NullInt64
    if ok && userID > 0 {
        userIDNull = sql.NullInt64{Int64: userID, Valid: true}
    }

    tx := database.GormDB_App.Begin()
    if tx.Error != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": tx.Error.Error()}); return }
    defer tx.Rollback()

    // Mapear etapa -> id_etapa_processo
    var etapaID sql.NullInt64
    _ = queryRowGorm(tx, "SELECT id_etapa_processo FROM DM_ETAPAS_PROCESSO WHERE etapa = ?", strings.TrimSpace(body.Etapa)).Scan(&etapaID)
    if !etapaID.Valid { etapaID = sql.NullInt64{Int64: 1, Valid: true} }

    var colID sql.NullInt64
    var colNome sql.NullString
    _ = queryRowGorm(tx, `
        SELECT k.id_coluna, k.nome_coluna
          FROM DM_ETAPAS_PROCESSO e
          JOIN DM_KANBAN_COLUNAS k ON k.id_coluna = e.id_coluna_kanban
         WHERE e.id_etapa_processo = ?`,
        etapaID.Int64,
    ).Scan(&colID, &colNome)

    subID, _ := resolveSubEtapaIDGorm(tx, strings.TrimSpace(body.SubEtapa))
    for _, pid := range body.ProcessoIDs {
        // Captura coluna e id_requisicao atuais antes de mover
        var oldColuna sql.NullInt64
        var reqID sql.NullInt64
        _ = queryRowGorm(tx, `SELECT id_coluna, id_requisicao FROM FT_PROCESSOS WHERE id_processo = ?`, pid).Scan(&oldColuna, &reqID)

        // Atualiza processo
        if _, err := execGorm(tx, "UPDATE FT_PROCESSOS SET id_etapa_processo = ?, sub_etapa = ?, id_sub_etapa_processo = ?, id_coluna = ?, nome_coluna = ?, ultima_atualizacao = NOW() WHERE id_processo = ?",
            etapaID.Int64, strings.TrimSpace(body.SubEtapa), nullIntToIface(subID),
            nullIntToIface(colID), func() interface{} { if colNome.Valid { return colNome.String }; return nil }(),
            pid,
        ); err != nil {
            c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("falha ao atualizar processo %d: %v", pid, err)})
            return
        }
        // Registra histórico da movimentação (status compatível com DM_STATUS)
        statusNome := getStatusNomeByRequisicaoGorm(tx, int64(pid))
        if _, err := execGorm(tx, `INSERT INTO FT_HISTORICO_MOVIMENTACOES (id_requisicao, id_usuario_gestor, status_anterior, status_novo, etapa_anterior, etapa_nova, sub_etapa, comentario, data_movimentacao)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_SUB(NOW(), INTERVAL 3 HOUR))`,
            pid, userIDNull, statusNome, statusNome, body.Etapa, body.Etapa, strings.TrimSpace(body.SubEtapa), strings.TrimSpace(body.Comentario)); err != nil {
            c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("falha ao registrar histórico %d: %v", pid, err)})
            return
        }

        // Sincroniza FT_PROCESSOS com a ultima movimentacao do historico (best-effort, por processo).
        _ = SincronizarStatusProcesso(tx, int(pid))

        // Se saiu de Ativos (id_coluna=1): invalida cache e grava training log
        if oldColuna.Valid && oldColuna.Int64 == 1 && reqID.Valid && colID.Valid {
            go func(rID int64, newCol int64) {
                InvalidateScoreCache(rID)
                RegistrarTrainingLog(rID, int(newCol), ScoreData{})
            }(reqID.Int64, colID.Int64)
        }
    }

    if err := tx.Commit().Error; err != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return }
    c.JSON(http.StatusOK, gin.H{"ok": true, "count": len(body.ProcessoIDs)})
}

// POST /api/v1/admin/processos/bulk-comentario-replace
// AdminPlanilhaBulkComentarioReplace godoc
// @Summary      Substitui comentários em lote
// @Tags         Admin
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/admin/processos/bulk-comentario-replace [post]
func AdminPlanilhaBulkComentarioReplace(c *gin.Context) {
    var body struct{
        HistoricoIDs []int64 `json:"historico_ids"`
        From         string  `json:"from"`
        To           string  `json:"to"`
    }
    if err := c.ShouldBindJSON(&body); err != nil || len(body.HistoricoIDs) == 0 {
        c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido"})
        return
    }
    // Monta IN (? , ? , ...)
    qs := make([]string, 0, len(body.HistoricoIDs))
    args := make([]any, 0, len(body.HistoricoIDs)+2)
    for _, id := range body.HistoricoIDs { qs = append(qs, "?"); args = append(args, id) }

    q := "UPDATE FT_HISTORICO_MOVIMENTACOES SET comentario = REPLACE(COALESCE(comentario,''), ?, ?) WHERE id_historico IN (" + strings.Join(qs, ",") + ")"
    args = append([]any{body.From, body.To}, args...)

    if _, err := execGorm(database.GormDB_App, q, args...); err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    c.JSON(http.StatusOK, gin.H{"ok": true, "count": len(body.HistoricoIDs)})
}

// POST /api/v1/admin/processos/recalcular-coluna
// Recalcula coluna do kanban para processos com dados (deferimento/fluxo/faturamento).
func AdminPlanilhaRecalcularColuna(c *gin.Context) {
    db := database.GormDB_App
    if db == nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "DB not initialized"})
        return
    }

    limit := 1000
    if v := strings.TrimSpace(c.DefaultQuery("limit", "")); v != "" {
        if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 20000 {
            limit = n
        }
    }

    userIDVal, _ := c.Get("userID")
    userID, _ := userIDVal.(int64)

    rows, err := queryGorm(db, `
        SELECT p.id_processo
          FROM FT_PROCESSOS p
          LEFT JOIN FT_DEFERIMENTOS d ON d.id_processo = p.id_processo
          LEFT JOIN FT_FLUXO_RESSARCIMENTO fr ON fr.id_processo = p.id_processo
          LEFT JOIN FT_FATURAMENTO f ON f.id_processo = p.id_processo
         WHERE (
            d.data_procedencia IS NOT NULL OR d.data_credito_dobro IS NOT NULL
            OR d.credito_simples IS NOT NULL OR d.credito_dobro IS NOT NULL
            OR d.repasse_simples IS NOT NULL OR d.repasse_dobro IS NOT NULL
            OR fr.valor IS NOT NULL OR fr.data_devolucao IS NOT NULL OR fr.data_envio_financeiro IS NOT NULL
            OR fr.forma_devolucao IS NOT NULL OR fr.simples = 1 OR fr.dobro = 1 OR fr.simples_dobro = 1
            OR (f.numero_nf IS NOT NULL AND TRIM(f.numero_nf) <> '')
            OR f.data_emissao IS NOT NULL OR f.data_vencimento IS NOT NULL OR f.data_pagamento IS NOT NULL
            OR f.valor IS NOT NULL
         )
         GROUP BY p.id_processo
         ORDER BY p.id_processo DESC
         LIMIT ?`, limit)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao listar processos"})
        return
    }
    defer rows.Close()

    ids := make([]int, 0, limit)
    for rows.Next() {
        var pid int
        if err := rows.Scan(&pid); err == nil && pid > 0 {
            ids = append(ids, pid)
        }
    }

    tx := db.Begin()
    if tx.Error != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": tx.Error.Error()})
        return
    }
    defer tx.Rollback()

    updated := 0
    for _, pid := range ids {
        if err := updateColunaByData(tx, pid, userID); err != nil {
            c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("falha ao atualizar processo %d: %v", pid, err)})
            return
        }
        updated++
    }

    if err := tx.Commit().Error; err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }

    c.JSON(http.StatusOK, gin.H{
        "ok":      true,
        "scanned": len(ids),
        "updated": updated,
        "limit":   limit,
    })
}

// GET /api/v1/admin/processos/export
// AdminPlanilhaExport godoc
// @Summary      Exporta planilha admin (CSV)
// @Tags         Admin
// @Param        q                query  string  false  "Busca"
// @Param        etapa            query  string  false  "Etapa"
// @Param        sub              query  string  false  "Subetapa"
// @Param        kanban           query  string  false  "Coluna kanban"
// @Param        ini              query  string  false  "Data inicial"
// @Param        fim              query  string  false  "Data final"
// @Param        analise          query  string  false  "Status análise"
// @Param        status           query  string  false  "Status"
// @Param        pendencias       query  string  false  "Pendências"
// @Param        historico        query  string  false  "Histórico"
// @Param        tags             query  string  false  "Tags"
// @Param        data_criacao_ini query  string  false  "Data criaÃ§ão inicial"
// @Param        data_criacao_fim query  string  false  "Data criaÃ§ão final"
// @Param        gestores         query  string  false  "Gestores"
// @Produce      text/csv
// @Success      200  {file}  file
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/admin/processos/export [get]
func AdminPlanilhaExport(c *gin.Context) {
    q := strings.TrimSpace(c.Query("q"))
    etapa := strings.TrimSpace(c.Query("etapa"))
    sub := strings.TrimSpace(c.Query("sub"))
    ini := strings.TrimSpace(c.Query("ini"))
    fim := strings.TrimSpace(c.Query("fim"))
    coluna := strings.TrimSpace(c.Query("coluna"))

    // filtros extras (todas as colunas do relatório)
    ucFilter := strings.TrimSpace(c.Query("uc"))
    idReq := strings.TrimSpace(c.Query("id_requisicao"))
    clienteFilter := strings.TrimSpace(c.Query("cliente"))
    concFilter := strings.TrimSpace(c.Query("concessionaria"))
    dataCriacaoIni := strings.TrimSpace(c.Query("data_criacao_ini"))
    dataCriacaoFim := strings.TrimSpace(c.Query("data_criacao_fim"))
    idStatusFilter := strings.TrimSpace(c.Query("id_status"))
    statusFilter := strings.TrimSpace(c.Query("status"))
    ultimaAtualIni := strings.TrimSpace(c.Query("ultima_atualizacao_ini"))
    ultimaAtualFim := strings.TrimSpace(c.Query("ultima_atualizacao_fim"))
    ultimaMovIni := strings.TrimSpace(c.Query("ultima_movimentacao_ini"))
    ultimaMovFim := strings.TrimSpace(c.Query("ultima_movimentacao_fim"))
    etapaHistFilter := strings.TrimSpace(c.Query("etapa_historico"))
    subEtapaHistFilter := strings.TrimSpace(c.Query("sub_etapa_historico"))
    suspensoFilter := strings.TrimSpace(c.Query("suspenso"))
    dataDefSimplesIni := strings.TrimSpace(c.Query("data_deferido_simples_ini"))
    dataDefSimplesFim := strings.TrimSpace(c.Query("data_deferido_simples_fim"))
    dataDefDobroIni := strings.TrimSpace(c.Query("data_deferido_dobro_ini"))
    dataDefDobroFim := strings.TrimSpace(c.Query("data_deferido_dobro_fim"))
    formaDevolucaoFilter := strings.TrimSpace(c.Query("forma_devolucao"))
    dataEnvioFinIni := strings.TrimSpace(c.Query("data_envio_financeiro_ini"))
    dataEnvioFinFim := strings.TrimSpace(c.Query("data_envio_financeiro_fim"))
    primeiraNfFilter := strings.TrimSpace(c.Query("primeira_nf"))

    // ranges numericos
    ressarcimentoMin := strings.TrimSpace(c.Query("ressarcimento_estimado_min"))
    ressarcimentoMax := strings.TrimSpace(c.Query("ressarcimento_estimado_max"))
    qtdeDeferidosMin := strings.TrimSpace(c.Query("qtde_deferidos_min"))
    qtdeDeferidosMax := strings.TrimSpace(c.Query("qtde_deferidos_max"))
    creditoSimplesMin := strings.TrimSpace(c.Query("credito_simples_min"))
    creditoSimplesMax := strings.TrimSpace(c.Query("credito_simples_max"))
    creditoDobroMin := strings.TrimSpace(c.Query("credito_dobro_min"))
    creditoDobroMax := strings.TrimSpace(c.Query("credito_dobro_max"))
    totalClienteMin := strings.TrimSpace(c.Query("total_cliente_min"))
    totalClienteMax := strings.TrimSpace(c.Query("total_cliente_max"))
    repasseSimplesMin := strings.TrimSpace(c.Query("repasse_simples_min"))
    repasseSimplesMax := strings.TrimSpace(c.Query("repasse_simples_max"))
    repasseDobroMin := strings.TrimSpace(c.Query("repasse_dobro_min"))
    repasseDobroMax := strings.TrimSpace(c.Query("repasse_dobro_max"))
    totalAmeeMin := strings.TrimSpace(c.Query("total_amee_min"))
    totalAmeeMax := strings.TrimSpace(c.Query("total_amee_max"))
    qtdeFluxoMin := strings.TrimSpace(c.Query("qtde_registros_fluxo_min"))
    qtdeFluxoMax := strings.TrimSpace(c.Query("qtde_registros_fluxo_max"))
    valorFluxoMin := strings.TrimSpace(c.Query("valor_fluxo_min"))
    valorFluxoMax := strings.TrimSpace(c.Query("valor_fluxo_max"))
    qtdeFatMin := strings.TrimSpace(c.Query("qtde_registros_faturamento_min"))
    qtdeFatMax := strings.TrimSpace(c.Query("qtde_registros_faturamento_max"))
    valorFatMin := strings.TrimSpace(c.Query("valor_fat_min"))
    valorFatMax := strings.TrimSpace(c.Query("valor_fat_max"))

    sqlBase := `
        SELECT DISTINCT
          COALESCE(r.uc, '') AS uc,
          r.id_requisicao AS id_requisicao,
          COALESCE(r.cliente, '') AS cliente,
          COALESCE(r.concessionaria, '') AS concessionaria,
          COALESCE(DATE_FORMAT(r.data_criacao, '%Y-%m-%d %H:%i:%s'), '') AS data_criacao,
          COALESCE(r.id_status, 0) AS id_status,
          COALESCE(r.ressarcimento_estimado, 0) AS ressarcimento_estimado,
          COALESCE(s.status, '') AS status,
          COALESCE(DATE_FORMAT(p.ultima_atualizacao, '%Y-%m-%d %H:%i:%s'), '') AS ultima_atualizacao,
          COALESCE(DATE_FORMAT(h.ultima_movimentacao_historico, '%Y-%m-%d %H:%i:%s'), '') AS ultima_movimentacao_historico,
          COALESCE(h.etapa_historico, '') AS etapa_historico,
          COALESCE(h.sub_etapa_historico, '') AS sub_etapa_historico,
          COALESCE(ep.etapa, '') AS etapa,
          COALESCE(p.sub_etapa, '') AS sub_etapa,
          COALESCE(p.nome_coluna, k.nome_coluna, '') AS coluna_kanban,
          IF(p.suspenso = 1, 'Suspenso', '') AS suspenso,
          COALESCE(d.qtde_deferidos, 0) AS qtde_deferidos,
          COALESCE(DATE_FORMAT(d.data_credito_simples, '%Y-%m-%d'), '') AS data_deferido_simples,
          COALESCE(DATE_FORMAT(d.data_credito_dobro, '%Y-%m-%d'), '') AS data_deferido_dobro,
          COALESCE(d.credito_simples, 0) AS credito_simples,
          COALESCE(d.credito_dobro, 0) AS credito_dobro,
          (COALESCE(d.credito_simples, 0) + COALESCE(d.credito_dobro, 0)) AS total_cliente,
          COALESCE(d.repasse_simples, 0) AS repasse_simples,
          COALESCE(d.repasse_dobro, 0) AS repasse_dobro,
          (COALESCE(d.repasse_simples, 0) + COALESCE(d.repasse_dobro, 0)) AS total_amee,
          COALESCE(f.qtde_registros_fluxo, 0) AS qtde_registros_fluxo,
          COALESCE(f.valor, 0) AS valor_fluxo,
          COALESCE(f.forma_devolucao, '') AS forma_devolucao,
          COALESCE(DATE_FORMAT(f.data_envio_financeiro, '%Y-%m-%d'), '') AS primeira_data_envio_financeiro,
          COALESCE(ft.qtde_registros_faturamento, 0) AS qtde_registros_faturamento,
          COALESCE(ft.numero_nf, '') AS primeira_nf,
          COALESCE(ft.valor_fat, 0) AS valor_fat
        FROM FT_REQUISICOES r
        LEFT JOIN DM_STATUS s ON r.id_status = s.id_status
        LEFT JOIN FT_PROCESSOS p ON r.id_requisicao = p.id_processo
        LEFT JOIN DM_ETAPAS_PROCESSO ep ON p.id_etapa_processo = ep.id_etapa_processo
        LEFT JOIN DM_KANBAN_COLUNAS k ON ep.id_coluna_kanban = k.id_coluna
        LEFT JOIN (
          SELECT
            id_processo,
            COUNT(id_processo) AS qtde_deferidos,
            MIN(data_procedencia) AS data_credito_simples,
            MIN(data_credito_dobro) AS data_credito_dobro,
            SUM(IFNULL(credito_simples, 0)) AS credito_simples,
            SUM(IFNULL(credito_dobro, 0)) AS credito_dobro,
            SUM(IFNULL(repasse_simples, 0)) AS repasse_simples,
            SUM(IFNULL(repasse_dobro, 0)) AS repasse_dobro
          FROM FT_DEFERIMENTOS
          GROUP BY id_processo
        ) d ON r.id_requisicao = d.id_processo
        LEFT JOIN (
          SELECT t2.*
          FROM (
            SELECT
              RANK() OVER (PARTITION BY id_requisicao ORDER BY id_requisicao, ultima_movimentacao_historico DESC, id_historico DESC) AS n_rank,
              t.*
            FROM (
              SELECT DISTINCT
                id_requisicao,
                id_historico,
                etapa_nova AS etapa_historico,
                sub_etapa AS sub_etapa_historico,
                data_movimentacao AS ultima_movimentacao_historico
              FROM FT_HISTORICO_MOVIMENTACOES
            ) t
          ) t2
          WHERE n_rank = 1
        ) h ON r.id_requisicao = h.id_requisicao
        LEFT JOIN (
          SELECT
            id_processo,
            COUNT(id_processo) AS qtde_registros_fluxo,
            SUM(valor) AS valor,
            MIN(data_envio_financeiro) AS data_envio_financeiro,
            GROUP_CONCAT(forma_devolucao SEPARATOR '|') AS forma_devolucao
          FROM FT_FLUXO_RESSARCIMENTO
          GROUP BY id_processo
        ) f ON r.id_requisicao = f.id_processo
        LEFT JOIN (
          SELECT
            id_processo,
            COUNT(id_processo) AS qtde_registros_faturamento,
            MIN(numero_nf) AS numero_nf,
            SUM(valor) AS valor_fat
          FROM FT_FATURAMENTO
          GROUP BY id_processo
        ) ft ON r.id_requisicao = ft.id_processo
    `

    where := make([]string, 0, 7)
    args := make([]any, 0, 6)
    where = append(where, "s.id_status <> 4")
    if q != "" {
        like := "%" + strings.ToLower(q) + "%"
        where = append(where, "(LOWER(COALESCE(r.cliente,'')) LIKE ? OR LOWER(COALESCE(r.uc,'')) LIKE ?)")
        args = append(args, like, like)
    }
    if ucFilter != "" {
        where = append(where, "COALESCE(r.uc,'') = ?")
        args = append(args, ucFilter)
    }
    if idReq != "" {
        where = append(where, "r.id_requisicao = ?")
        args = append(args, idReq)
    }
    if clienteFilter != "" {
        where = append(where, "LOWER(COALESCE(r.cliente,'')) = ?")
        args = append(args, strings.ToLower(clienteFilter))
    }
    if concFilter != "" {
        where = append(where, "LOWER(COALESCE(r.concessionaria,'')) = ?")
        args = append(args, strings.ToLower(concFilter))
    }
    if dataCriacaoIni != "" {
        where = append(where, "DATE(r.data_criacao) >= ?")
        args = append(args, dataCriacaoIni)
    }
    if dataCriacaoFim != "" {
        where = append(where, "DATE(r.data_criacao) <= ?")
        args = append(args, dataCriacaoFim)
    }
    if idStatusFilter != "" {
        where = append(where, "r.id_status = ?")
        args = append(args, idStatusFilter)
    }
    if statusFilter != "" {
        where = append(where, "LOWER(COALESCE(s.status,'')) = ?")
        args = append(args, strings.ToLower(statusFilter))
    }
    if etapa != "" {
        where = append(where, "LOWER(COALESCE(ep.etapa,'')) = ?")
        args = append(args, strings.ToLower(etapa))
    }
    if sub != "" {
        where = append(where, "LOWER(COALESCE(p.sub_etapa,'')) = ?")
        args = append(args, strings.ToLower(sub))
    }
    if etapaHistFilter != "" {
        where = append(where, "LOWER(COALESCE(h.etapa_historico,'')) = ?")
        args = append(args, strings.ToLower(etapaHistFilter))
    }
    if subEtapaHistFilter != "" {
        where = append(where, "LOWER(COALESCE(h.sub_etapa_historico,'')) = ?")
        args = append(args, strings.ToLower(subEtapaHistFilter))
    }
    if ini != "" {
        where = append(where, "DATE(h.ultima_movimentacao_historico) >= ?")
        args = append(args, ini)
    }
    if fim != "" {
        where = append(where, "DATE(h.ultima_movimentacao_historico) <= ?")
        args = append(args, fim)
    }
    if coluna != "" {
        where = append(where, "LOWER(COALESCE(p.nome_coluna, k.nome_coluna)) = ?")
        args = append(args, strings.ToLower(coluna))
    }
    if ultimaAtualIni != "" {
        where = append(where, "DATE(p.ultima_atualizacao) >= ?")
        args = append(args, ultimaAtualIni)
    }
    if ultimaAtualFim != "" {
        where = append(where, "DATE(p.ultima_atualizacao) <= ?")
        args = append(args, ultimaAtualFim)
    }
    if ultimaMovIni != "" {
        where = append(where, "DATE(h.ultima_movimentacao_historico) >= ?")
        args = append(args, ultimaMovIni)
    }
    if ultimaMovFim != "" {
        where = append(where, "DATE(h.ultima_movimentacao_historico) <= ?")
        args = append(args, ultimaMovFim)
    }
    if suspensoFilter != "" {
        if strings.EqualFold(suspensoFilter, "Suspenso") || suspensoFilter == "1" || strings.EqualFold(suspensoFilter, "true") {
            where = append(where, "p.suspenso = 1")
        } else {
            where = append(where, "p.suspenso = 0")
        }
    }
    if dataDefSimplesIni != "" {
        where = append(where, "DATE(d.data_credito_simples) >= ?")
        args = append(args, dataDefSimplesIni)
    }
    if dataDefSimplesFim != "" {
        where = append(where, "DATE(d.data_credito_simples) <= ?")
        args = append(args, dataDefSimplesFim)
    }
    if dataDefDobroIni != "" {
        where = append(where, "DATE(d.data_credito_dobro) >= ?")
        args = append(args, dataDefDobroIni)
    }
    if dataDefDobroFim != "" {
        where = append(where, "DATE(d.data_credito_dobro) <= ?")
        args = append(args, dataDefDobroFim)
    }
    if formaDevolucaoFilter != "" {
        where = append(where, "LOWER(COALESCE(f.forma_devolucao,'')) LIKE ?")
        args = append(args, "%"+strings.ToLower(formaDevolucaoFilter)+"%")
    }
    if dataEnvioFinIni != "" {
        where = append(where, "DATE(f.data_envio_financeiro) >= ?")
        args = append(args, dataEnvioFinIni)
    }
    if dataEnvioFinFim != "" {
        where = append(where, "DATE(f.data_envio_financeiro) <= ?")
        args = append(args, dataEnvioFinFim)
    }
    if primeiraNfFilter != "" {
        where = append(where, "LOWER(COALESCE(ft.numero_nf,'')) = ?")
        args = append(args, strings.ToLower(primeiraNfFilter))
    }
    addRange := func(col string, minVal string, maxVal string) {
        if minVal != "" {
            where = append(where, col+" >= ?")
            args = append(args, minVal)
        }
        if maxVal != "" {
            where = append(where, col+" <= ?")
            args = append(args, maxVal)
        }
    }
    addRange("COALESCE(r.ressarcimento_estimado,0)", ressarcimentoMin, ressarcimentoMax)
    addRange("COALESCE(d.qtde_deferidos,0)", qtdeDeferidosMin, qtdeDeferidosMax)
    addRange("COALESCE(d.credito_simples,0)", creditoSimplesMin, creditoSimplesMax)
    addRange("COALESCE(d.credito_dobro,0)", creditoDobroMin, creditoDobroMax)
    addRange("(COALESCE(d.credito_simples,0)+COALESCE(d.credito_dobro,0))", totalClienteMin, totalClienteMax)
    addRange("COALESCE(d.repasse_simples,0)", repasseSimplesMin, repasseSimplesMax)
    addRange("COALESCE(d.repasse_dobro,0)", repasseDobroMin, repasseDobroMax)
    addRange("(COALESCE(d.repasse_simples,0)+COALESCE(d.repasse_dobro,0))", totalAmeeMin, totalAmeeMax)
    addRange("COALESCE(f.qtde_registros_fluxo,0)", qtdeFluxoMin, qtdeFluxoMax)
    addRange("COALESCE(f.valor,0)", valorFluxoMin, valorFluxoMax)
    addRange("COALESCE(ft.qtde_registros_faturamento,0)", qtdeFatMin, qtdeFatMax)
    addRange("COALESCE(ft.valor_fat,0)", valorFatMin, valorFatMax)
    if len(where) > 0 {
        sqlBase += " WHERE " + strings.Join(where, " AND ")
    }
    sqlBase += " ORDER BY r.id_requisicao ASC"

    rows, err := queryGorm(database.GormDB_App, sqlBase, args...)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    defer rows.Close()

    c.Header("Content-Type", "text/csv; charset=utf-8")
    c.Header("Content-Disposition", "attachment; filename=admin_planilha_export.csv")
    _, _ = io.WriteString(c.Writer, "\ufeff")
    w := csv.NewWriter(c.Writer)
    w.Comma = ';'

    header := []string{
        "uc",
        "id_requisicao",
        "cliente",
        "concessionaria",
        "data_criacao",
        "id_status",
        "ressarcimento_estimado",
        "status",
        "ultima_atualizacao",
        "ultima_movimentacao_historico",
        "etapa_historico",
        "sub_etapa_historico",
        "etapa",
        "sub_etapa",
        "coluna_kanban",
        "suspenso",
        "qtde_deferidos",
        "data_deferido_simples",
        "data_deferido_dobro",
        "credito_simples",
        "credito_dobro",
        "total_cliente",
        "repasse_simples",
        "repasse_dobro",
        "total_amee",
        "qtde_registros_fluxo",
        "valor_fluxo",
        "forma_devolucao",
        "primeira_data_envio_financeiro",
        "qtde_registros_faturamento",
        "primeira_nf",
        "valor_fat",
    }
    _ = w.Write(header)

    for rows.Next() {
        var (
            uc, cliente, concessionaria, dataCriacao, status string
            ultimaAtualizacao, ultimaMov, etapaHist, subEtapaHist string
            etapaAtual, subEtapa, colunaKanban, suspenso string
            dataDefSimples, dataDefDobro, formaDevolucao, dataEnvioFin string
            primeiraNF string
            idRequisicao, idStatus, qtdeDeferidos, qtdeFluxo, qtdeFat int64
            ressarcimentoEstimado, creditoSimples, creditoDobro, totalCliente float64
            repasseSimples, repasseDobro, totalAmee, valorFluxo, valorFat float64
        )
        if err := rows.Scan(
            &uc,
            &idRequisicao,
            &cliente,
            &concessionaria,
            &dataCriacao,
            &idStatus,
            &ressarcimentoEstimado,
            &status,
            &ultimaAtualizacao,
            &ultimaMov,
            &etapaHist,
            &subEtapaHist,
            &etapaAtual,
            &subEtapa,
            &colunaKanban,
            &suspenso,
            &qtdeDeferidos,
            &dataDefSimples,
            &dataDefDobro,
            &creditoSimples,
            &creditoDobro,
            &totalCliente,
            &repasseSimples,
            &repasseDobro,
            &totalAmee,
            &qtdeFluxo,
            &valorFluxo,
            &formaDevolucao,
            &dataEnvioFin,
            &qtdeFat,
            &primeiraNF,
            &valorFat,
        ); err != nil {
            continue
        }
        line := []string{
            uc,
            strconv.FormatInt(idRequisicao, 10),
            cliente,
            concessionaria,
            dataCriacao,
            strconv.FormatInt(idStatus, 10),
            fmt.Sprintf("%.2f", ressarcimentoEstimado),
            status,
            ultimaAtualizacao,
            ultimaMov,
            etapaHist,
            subEtapaHist,
            etapaAtual,
            subEtapa,
            colunaKanban,
            suspenso,
            strconv.FormatInt(qtdeDeferidos, 10),
            dataDefSimples,
            dataDefDobro,
            fmt.Sprintf("%.2f", creditoSimples),
            fmt.Sprintf("%.2f", creditoDobro),
            fmt.Sprintf("%.2f", totalCliente),
            fmt.Sprintf("%.2f", repasseSimples),
            fmt.Sprintf("%.2f", repasseDobro),
            fmt.Sprintf("%.2f", totalAmee),
            strconv.FormatInt(qtdeFluxo, 10),
            fmt.Sprintf("%.2f", valorFluxo),
            formaDevolucao,
            dataEnvioFin,
            strconv.FormatInt(qtdeFat, 10),
            primeiraNF,
            fmt.Sprintf("%.2f", valorFat),
        }
        _ = w.Write(line)
    }
    w.Flush()
}

// POST /api/v1/admin/processos/import
// AdminPlanilhaImport godoc
// @Summary      Importa planilha admin
// @Tags         Admin
// @Accept       multipart/form-data
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/admin/processos/import [post]
func AdminPlanilhaImport(c *gin.Context) {
    file, _, err := c.Request.FormFile("file")
    if err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": "arquivo inválido"})
        return
    }
    defer file.Close()

    reader := csv.NewReader(file)
    reader.Comma = ';'
    reader.FieldsPerRecord = -1

    userIDVal, _ := c.Get("userID")
    userID, ok := userIDVal.(int64)
    var userIDNull sql.NullInt64
    if ok && userID > 0 {
        userIDNull = sql.NullInt64{Int64: userID, Valid: true}
    }

    header, err := reader.Read()
    if err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": "arquivo vazio"})
        return
    }
    idx := map[string]int{}
    for i, h := range header {
        key := strings.ToLower(strings.TrimSpace(h))
        idx[key] = i
    }
    get := func(row []string, name string) string {
        i, ok := idx[name]
        if !ok || i >= len(row) {
            return ""
        }
        return strings.TrimSpace(row[i])
    }

    tx := database.GormDB_App.Begin()
    if tx.Error != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": tx.Error.Error()})
        return
    }
    defer tx.Rollback()

    parseFloat := func(s string) float64 {
        s = strings.TrimSpace(strings.ReplaceAll(s, ".", ""))
        s = strings.ReplaceAll(s, ",", ".")
        if s == "" {
            return 0
        }
        v, _ := strconv.ParseFloat(s, 64)
        return v
    }
    nullable := func(s string) any {
        s = strings.TrimSpace(s)
        if s == "" {
            return nil
        }
        return s
    }

    count := 0
    for {
        row, err := reader.Read()
        if err == io.EOF {
            break
        }
        if err != nil {
            c.JSON(http.StatusBadRequest, gin.H{"error": "erro ao ler CSV"})
            return
        }
        pidStr := get(row, "processo_id")
        if pidStr == "" {
            continue
        }
        pid, _ := strconv.ParseInt(pidStr, 10, 64)
        if pid == 0 {
            continue
        }

        etapa := get(row, "etapa")
        sub := get(row, "sub_etapa")
        comentario := get(row, "comentario")

        rawCreditoSimples := get(row, "credito_simples")
        rawCreditoDobro := get(row, "credito_dobro")
        rawDataSimples := get(row, "data_simples")
        rawDataDobro := get(row, "data_dobro")

        creditoSimples := parseFloat(rawCreditoSimples)
        creditoDobro := parseFloat(rawCreditoDobro)
        dataSimples := nullable(rawDataSimples)
        dataDobro := nullable(rawDataDobro)

        formaDevolucao := get(row, "forma_devolucao")
        valorFluxo := parseFloat(get(row, "valor_fluxo"))
        dataFluxo := nullable(get(row, "data_fluxo"))

        numeroNF := get(row, "numero_nf")
        dataEmissao := nullable(get(row, "data_emissao"))
        dataVenc := nullable(get(row, "data_vencimento"))
        dataPag := nullable(get(row, "data_pagamento"))
        valorNF := parseFloat(get(row, "valor_nf"))

        if rawCreditoSimples != "" || rawCreditoDobro != "" || rawDataSimples != "" || rawDataDobro != "" {
            if _, err := execGorm(tx, `
                INSERT INTO FT_DEFERIMENTOS (id_processo, credito_simples, data_procedencia, credito_dobro, data_credito_dobro)
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                  credito_simples = VALUES(credito_simples),
                  data_procedencia = VALUES(data_procedencia),
                  credito_dobro = VALUES(credito_dobro),
                  data_credito_dobro = VALUES(data_credito_dobro)`,
                pid, creditoSimples, dataSimples, creditoDobro, dataDobro); err != nil {
                c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("falha deferimento %d: %v", pid, err)})
                return
            }
        }

        if formaDevolucao != "" || valorFluxo > 0 || dataFluxo != nil {
            if _, err := execGorm(tx, `
                INSERT INTO FT_FLUXO_RESSARCIMENTO (id_processo, forma_devolucao, valor, data_devolucao, created_at)
                VALUES (?, ?, ?, ?, NOW())`,
                pid, formaDevolucao, valorFluxo, dataFluxo); err != nil {
                c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("falha fluxo %d: %v", pid, err)})
                return
            }
        }

        if numeroNF != "" || valorNF > 0 || dataEmissao != nil || dataVenc != nil || dataPag != nil {
            if _, err := execGorm(tx, `
                INSERT INTO FT_FATURAMENTO (id_processo, numero_nf, data_emissao, data_vencimento, data_pagamento, valor, created_at)
                VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                pid, numeroNF, dataEmissao, dataVenc, dataPag, valorNF); err != nil {
                c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("falha faturamento %d: %v", pid, err)})
                return
            }
        }

        if etapa != "" || sub != "" || comentario != "" {
            var etapaAtual, subAtual string
            _ = queryRowGorm(tx, `
                SELECT COALESCE(e.etapa,''), COALESCE(p.sub_etapa,'')
                FROM FT_PROCESSOS p
                JOIN DM_ETAPAS_PROCESSO e ON p.id_etapa_processo = e.id_etapa_processo
                WHERE p.id_processo = ?`, pid).Scan(&etapaAtual, &subAtual)

            etapaNova := etapa
            if etapaNova == "" {
                etapaNova = etapaAtual
            }
            subNova := sub
            if subNova == "" {
                subNova = subAtual
            }

            if etapa != "" || sub != "" {
                var etapaID sql.NullInt64
                _ = queryRowGorm(tx, "SELECT id_etapa_processo FROM DM_ETAPAS_PROCESSO WHERE etapa = ?", strings.TrimSpace(etapaNova)).Scan(&etapaID)
                if etapaID.Valid {
                    subID, _ := resolveSubEtapaIDGorm(tx, strings.TrimSpace(subNova))
                    var colID sql.NullInt64
                    var colNome sql.NullString
                    _ = queryRowGorm(tx, `
                        SELECT k.id_coluna, k.nome_coluna
                          FROM DM_ETAPAS_PROCESSO e
                          JOIN DM_KANBAN_COLUNAS k ON k.id_coluna = e.id_coluna_kanban
                         WHERE e.id_etapa_processo = ?`,
                        etapaID.Int64,
                    ).Scan(&colID, &colNome)
                    if _, err := execGorm(tx, `UPDATE FT_PROCESSOS SET id_etapa_processo = ?, sub_etapa = ?, id_sub_etapa_processo = ?, id_coluna = ?, nome_coluna = ?, ultima_atualizacao = NOW() WHERE id_processo = ?`,
                        etapaID.Int64, subNova, nullIntToIface(subID), nullIntToIface(colID), func() interface{} { if colNome.Valid { return colNome.String }; return nil }(), pid); err != nil {
                        c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("falha atualizar processo %d: %v", pid, err)})
                        return
                    }
                }
            }

            if comentario == "" {
                comentario = "ImportaÃ§ão de planilha"
            }
            statusNome := getStatusNomeByRequisicaoGorm(tx, int64(pid))
            if _, err := execGorm(tx, `
                INSERT INTO FT_HISTORICO_MOVIMENTACOES (id_requisicao, id_usuario_gestor, status_anterior, status_novo, etapa_anterior, etapa_nova, sub_etapa, comentario, data_movimentacao)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_SUB(NOW(), INTERVAL 3 HOUR))`,
                pid, userIDNull, statusNome, statusNome, etapaAtual, etapaNova, subNova, comentario); err != nil {
                c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("falha historico %d: %v", pid, err)})
                return
            }

            // Sincroniza FT_PROCESSOS com a ultima movimentacao do historico (best-effort, por processo).
            _ = SincronizarStatusProcesso(tx, int(pid))
        }

        count++
    }

    if err := tx.Commit().Error; err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    c.JSON(http.StatusOK, gin.H{"ok": true, "count": count})
}



