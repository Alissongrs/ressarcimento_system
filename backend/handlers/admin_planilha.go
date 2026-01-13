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
    RessarcimentoEstimado float64 `json:"ressarcimento_estimado"`
    NomeColuna        string  `json:"nome_coluna"`
    EtapaAtual        string  `json:"etapa_atual"`

    CreditoSimples    float64 `json:"credito_simples"`
    DataSimples       string  `json:"data_simples"`
    CreditoDobro      float64 `json:"credito_dobro"`
    DataDobro         string  `json:"data_dobro"`

    FormaDevolucao    string  `json:"forma_devolucao"`
    ValorFluxo        float64 `json:"valor_fluxo"`
    DataFluxo         string  `json:"data_fluxo"`

    NumeroNF          string  `json:"numero_nf"`
    DataEmissao       string  `json:"data_emissao"`
    DataVencimento    string  `json:"data_vencimento"`
    DataPagamento     string  `json:"data_pagamento"`
    ValorNF           float64 `json:"valor_nf"`

    // Histórico
    IDHistorico       int64   `json:"id_historico"`
    HistData          string  `json:"hist_data"`
    HistComentario    string  `json:"hist_comentario"`
    Etapa             string  `json:"etapa"`
    SubEtapa          string  `json:"sub_etapa"`
    TipoMov           string  `json:"tipo_movimentacao"`
}

// GET /api/v1/admin/planilha
func AdminPlanilhaList(c *gin.Context) {
    q := strings.TrimSpace(c.Query("q"))
    etapa := strings.TrimSpace(c.Query("etapa"))
    sub := strings.TrimSpace(c.Query("sub"))
    ini := strings.TrimSpace(c.Query("ini")) // YYYY-MM-DD
    fim := strings.TrimSpace(c.Query("fim")) // YYYY-MM-DD
    coluna := strings.TrimSpace(c.Query("coluna"))
    limit := strings.TrimSpace(c.DefaultQuery("limit", "100"))
    offset := strings.TrimSpace(c.DefaultQuery("offset", "0"))

    // Monta SQL base (usa LEFT JOIN e subselect para pegar último fluxo/faturamento)
    sqlBase := `
        SELECT
          p.id_processo                                     AS processo_id,
          COALESCE(r.uc, '')                                AS uc,
          COALESCE(r.cnpj, '')                              AS cnpj,
          COALESCE(r.concessionaria, '')                    AS concessionaria,
          COALESCE(r.cliente, '')                           AS cliente,
          COALESCE(r.ressarcimento_estimado, 0)             AS ressarcimento_estimado,
          COALESCE(kanb.nome_coluna, '')                    AS nome_coluna,
          COALESCE(etapa.etapa, '')                         AS etapa_atual,

          COALESCE(d.credito_simples, 0)                    AS credito_simples,
          COALESCE(DATE_FORMAT(d.data_procedencia, '%Y-%m-%d'), '') AS data_simples,
          COALESCE(d.credito_dobro, 0)                      AS credito_dobro,
          COALESCE(DATE_FORMAT(d.data_credito_dobro, '%Y-%m-%d'), '') AS data_dobro,

          COALESCE(fr.forma_devolucao, '')                  AS forma_devolucao,
          COALESCE(fr.valor, 0)                             AS valor_fluxo,
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
          COALESCE(h.tipo_movimentacao, '')                 AS tipo_movimentacao
        FROM FT_PROCESSOS p
        JOIN FT_REQUISICOES r         ON r.id_requisicao = p.id_processo
        JOIN DM_ETAPAS_PROCESSO etapa ON p.id_etapa_processo = etapa.id_etapa_processo
        JOIN DM_KANBAN_COLUNAS kanb ON etapa.id_coluna_kanban = kanb.id_coluna
        LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON h.id_requisicao = p.id_processo
        LEFT JOIN FT_DEFERIMENTOS d        ON d.id_processo     = p.id_processo
        LEFT JOIN (
          SELECT x.id_processo, x.forma_devolucao, x.valor, x.data_devolucao, x.data_envio_financeiro, x.created_at
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
        like := "%" + strings.ToLower(q) + "%"
        where = append(where, "(LOWER(COALESCE(r.cliente,'')) LIKE ? OR LOWER(COALESCE(r.uc,'')) LIKE ? OR LOWER(COALESCE(h.comentario,'')) LIKE ?)")
        args = append(args, like, like, like)
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
        where = append(where, "LOWER(kanb.nome_coluna) = ?")
        args = append(args, strings.ToLower(coluna))
    }
    if len(where) > 0 {
        sqlBase += " WHERE " + strings.Join(where, " AND ")
    }
    sqlBase += " ORDER BY p.id_processo ASC, h.data_movimentacao ASC"
    if limit != "" {
        sqlBase += fmt.Sprintf(" LIMIT %s", limit)
        if offset != "" && offset != "0" {
            sqlBase += fmt.Sprintf(" OFFSET %s", offset)
        }
    }

    rows, err := database.DB_App.Query(sqlBase, args...)
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
          COALESCE(kanb.nome_coluna, '')                    AS nome_coluna,
          COALESCE(etapa.etapa, '')                         AS etapa_atual,

          COALESCE(d.credito_simples, 0)                    AS credito_simples,
          COALESCE(DATE_FORMAT(d.data_procedencia, '%Y-%m-%d'), '') AS data_simples,
          COALESCE(d.credito_dobro, 0)                      AS credito_dobro,
          COALESCE(DATE_FORMAT(d.data_credito_dobro, '%Y-%m-%d'), '') AS data_dobro,

          ''                                                AS forma_devolucao,
          0                                                 AS valor_fluxo,
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
          COALESCE(h.tipo_movimentacao, '')                 AS tipo_movimentacao
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
        if limit != "" {
            sqlBaseFallback += fmt.Sprintf(" LIMIT %s", limit)
            if offset != "" && offset != "0" {
                sqlBaseFallback += fmt.Sprintf(" OFFSET %s", offset)
            }
        }
        rows, err = database.DB_App.Query(sqlBaseFallback, args...)
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
            &it.ProcessoID, &it.Uc, &it.CNPJ, &it.Concessionaria, &it.Cliente, &it.RessarcimentoEstimado, &it.NomeColuna, &it.EtapaAtual,
            &it.CreditoSimples, &it.DataSimples, &it.CreditoDobro, &it.DataDobro,
            &it.FormaDevolucao, &it.ValorFluxo, &it.DataFluxo,
            &it.NumeroNF, &it.DataEmissao, &it.DataVencimento, &it.DataPagamento, &it.ValorNF,
            &it.IDHistorico, &it.HistData, &it.HistComentario, &it.Etapa, &it.SubEtapa, &it.TipoMov,
        ); err == nil {
            out = append(out, it)
        }
    }

    // Fallback: se não retornou linhas (variação de dados/ambiente), tentar baseado em FT_REQUISICOES
    if len(out) == 0 {
        sqlBaseAlt := `
        SELECT
          r.id_requisicao                                   AS processo_id,
          COALESCE(r.uc, '')                                AS uc,
          COALESCE(r.cnpj, '')                              AS cnpj,
          COALESCE(r.concessionaria, '')                    AS concessionaria,
          COALESCE(r.cliente, '')                           AS cliente,
          COALESCE(r.ressarcimento_estimado, 0)             AS ressarcimento_estimado,
          COALESCE(kanb.nome_coluna, '')                    AS nome_coluna,
          COALESCE(etapa.etapa, '')                         AS etapa_atual,

          COALESCE(d.credito_simples, 0)                    AS credito_simples,
          COALESCE(DATE_FORMAT(d.data_procedencia, '%Y-%m-%d'), '') AS data_simples,
          COALESCE(d.credito_dobro, 0)                      AS credito_dobro,
          COALESCE(DATE_FORMAT(d.data_credito_dobro, '%Y-%m-%d'), '') AS data_dobro,

          COALESCE(fr.forma_devolucao, '')                  AS forma_devolucao,
          COALESCE(fr.valor, 0)                             AS valor_fluxo,
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
          COALESCE(h.tipo_movimentacao, '')                 AS tipo_movimentacao
        FROM FT_REQUISICOES r
        LEFT JOIN FT_PROCESSOS p ON p.id_processo = r.id_requisicao
        LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON h.id_requisicao = r.id_requisicao
        LEFT JOIN FT_DEFERIMENTOS d ON d.id_processo = r.id_requisicao
        LEFT JOIN DM_ETAPAS_PROCESSO etapa ON p.id_etapa_processo = etapa.id_etapa_processo
        LEFT JOIN DM_KANBAN_COLUNAS kanb ON etapa.id_coluna_kanban = kanb.id_coluna
        LEFT JOIN (
          SELECT x.id_processo, x.forma_devolucao, x.valor, x.data_devolucao, x.data_envio_financeiro, x.created_at
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

        rows2, err2 := database.DB_App.Query(sqlBaseAlt, args...)
        if err2 == nil {
            defer rows2.Close()
            for rows2.Next() {
                var it PlanilhaRow
                if err := rows2.Scan(
                    &it.ProcessoID, &it.Uc, &it.CNPJ, &it.Concessionaria, &it.Cliente, &it.RessarcimentoEstimado, &it.NomeColuna, &it.EtapaAtual,
                    &it.CreditoSimples, &it.DataSimples, &it.CreditoDobro, &it.DataDobro,
                    &it.FormaDevolucao, &it.ValorFluxo, &it.DataFluxo,
                    &it.NumeroNF, &it.DataEmissao, &it.DataVencimento, &it.DataPagamento, &it.ValorNF,
                    &it.IDHistorico, &it.HistData, &it.HistComentario, &it.Etapa, &it.SubEtapa, &it.TipoMov,
                ); err == nil {
                    out = append(out, it)
                }
            }
        }
    }
    if out == nil { out = []PlanilhaRow{} }
    c.JSON(http.StatusOK, gin.H{"rows": out})
}

// POST /api/v1/admin/planilha/bulk-mover
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

    tx, err := database.DB_App.Begin()
    if err != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return }
    defer tx.Rollback()

    // Mapear etapa -> id_etapa_processo
    var etapaID sql.NullInt64
    _ = tx.QueryRow("SELECT id_etapa_processo FROM DM_ETAPAS_PROCESSO WHERE etapa = ?", strings.TrimSpace(body.Etapa)).Scan(&etapaID)
    if !etapaID.Valid { etapaID = sql.NullInt64{Int64: 1, Valid: true} }

    for _, pid := range body.ProcessoIDs {
        // Atualiza processo
        if _, err := tx.Exec("UPDATE FT_PROCESSOS SET id_etapa_processo = ?, sub_etapa = ?, ultima_atualizacao = NOW() WHERE id_processo = ?", etapaID.Int64, strings.TrimSpace(body.SubEtapa), pid); err != nil {
            c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("falha ao atualizar processo %d: %v", pid, err)})
            return
        }
        // Registra histórico da movimentação
        if _, err := tx.Exec(`INSERT INTO FT_HISTORICO_MOVIMENTACOES (id_requisicao, status_anterior, status_novo, etapa_anterior, etapa_nova, sub_etapa, comentario, data_movimentacao)
                              VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`, pid, "", "", body.Etapa, body.Etapa, strings.TrimSpace(body.SubEtapa), strings.TrimSpace(body.Comentario)); err != nil {
            c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("falha ao registrar histórico %d: %v", pid, err)})
            return
        }
    }

    if err := tx.Commit(); err != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return }
    c.JSON(http.StatusOK, gin.H{"ok": true, "count": len(body.ProcessoIDs)})
}

// POST /api/v1/admin/planilha/bulk-comentario-replace
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

    if _, err := database.DB_App.Exec(q, args...); err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    c.JSON(http.StatusOK, gin.H{"ok": true, "count": len(body.HistoricoIDs)})
}

// GET /api/v1/admin/planilha/export
func AdminPlanilhaExport(c *gin.Context) {
    q := strings.TrimSpace(c.Query("q"))
    etapa := strings.TrimSpace(c.Query("etapa"))
    sub := strings.TrimSpace(c.Query("sub"))
    ini := strings.TrimSpace(c.Query("ini"))
    fim := strings.TrimSpace(c.Query("fim"))
    coluna := strings.TrimSpace(c.Query("coluna"))

    sqlBase := `
        SELECT
          p.id_processo                                     AS processo_id,
          COALESCE(r.uc, '')                                AS uc,
          COALESCE(r.cnpj, '')                              AS cnpj,
          COALESCE(r.concessionaria, '')                    AS concessionaria,
          COALESCE(r.cliente, '')                           AS cliente,
          COALESCE(kanb.nome_coluna, '')                    AS nome_coluna,
          COALESCE(etapa.etapa, '')                         AS etapa_atual,
          COALESCE(p.sub_etapa, '')                         AS sub_etapa,
          COALESCE(d.credito_simples, 0)                    AS credito_simples,
          COALESCE(DATE_FORMAT(d.data_procedencia, '%Y-%m-%d'), '') AS data_simples,
          COALESCE(d.credito_dobro, 0)                      AS credito_dobro,
          COALESCE(DATE_FORMAT(d.data_credito_dobro, '%Y-%m-%d'), '') AS data_dobro,
          COALESCE(fr.forma_devolucao, '')                  AS forma_devolucao,
          COALESCE(fr.valor, 0)                             AS valor_fluxo,
          COALESCE(DATE_FORMAT(fr.data_devolucao, '%Y-%m-%d'), '') AS data_fluxo,
          COALESCE(f.numero_nf, '')                         AS numero_nf,
          COALESCE(DATE_FORMAT(f.data_emissao, '%Y-%m-%d'), '')     AS data_emissao,
          COALESCE(DATE_FORMAT(f.data_vencimento, '%Y-%m-%d'), '')  AS data_vencimento,
          COALESCE(DATE_FORMAT(f.data_pagamento, '%Y-%m-%d'), '')   AS data_pagamento,
          COALESCE(f.valor, 0)                              AS valor_nf,
          COALESCE(DATE_FORMAT(hmax.data_movimentacao, '%Y-%m-%d %H:%i:%s'), '') AS ultima_movimentacao
        FROM FT_PROCESSOS p
        JOIN FT_REQUISICOES r         ON r.id_requisicao = p.id_processo
        JOIN DM_ETAPAS_PROCESSO etapa ON p.id_etapa_processo = etapa.id_etapa_processo
        JOIN DM_KANBAN_COLUNAS kanb ON etapa.id_coluna_kanban = kanb.id_coluna
        LEFT JOIN FT_DEFERIMENTOS d        ON d.id_processo     = p.id_processo
        LEFT JOIN (
          SELECT x.id_processo, x.forma_devolucao, x.valor, x.data_devolucao, x.created_at
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
        LEFT JOIN (
          SELECT id_requisicao, MAX(data_movimentacao) AS data_movimentacao
            FROM FT_HISTORICO_MOVIMENTACOES
           GROUP BY id_requisicao
        ) hmax ON hmax.id_requisicao = p.id_processo
    `

    where := make([]string, 0, 6)
    args := make([]any, 0, 6)
    if q != "" {
        like := "%" + strings.ToLower(q) + "%"
        where = append(where, "(LOWER(COALESCE(r.cliente,'')) LIKE ? OR LOWER(COALESCE(r.uc,'')) LIKE ?)")
        args = append(args, like, like)
    }
    if etapa != "" {
        where = append(where, "LOWER(COALESCE(etapa.etapa,'')) = ?")
        args = append(args, strings.ToLower(etapa))
    }
    if sub != "" {
        where = append(where, "LOWER(COALESCE(p.sub_etapa,'')) = ?")
        args = append(args, strings.ToLower(sub))
    }
    if ini != "" {
        where = append(where, "DATE(hmax.data_movimentacao) >= ?")
        args = append(args, ini)
    }
    if fim != "" {
        where = append(where, "DATE(hmax.data_movimentacao) <= ?")
        args = append(args, fim)
    }
    if coluna != "" {
        where = append(where, "LOWER(kanb.nome_coluna) = ?")
        args = append(args, strings.ToLower(coluna))
    }
    if len(where) > 0 {
        sqlBase += " WHERE " + strings.Join(where, " AND ")
    }
    sqlBase += " ORDER BY p.id_processo ASC"

    rows, err := database.DB_App.Query(sqlBase, args...)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    defer rows.Close()

    c.Header("Content-Type", "text/csv; charset=utf-8")
    c.Header("Content-Disposition", "attachment; filename=admin_planilha_export.csv")
    w := csv.NewWriter(c.Writer)
    w.Comma = ';'

    header := []string{
        "processo_id", "uc", "cnpj", "concessionaria", "cliente", "coluna_kanban", "etapa", "sub_etapa",
        "credito_simples", "data_simples", "credito_dobro", "data_dobro",
        "forma_devolucao", "valor_fluxo", "data_fluxo",
        "numero_nf", "data_emissao", "data_vencimento", "data_pagamento", "valor_nf",
        "comentario",
    }
    _ = w.Write(header)

    for rows.Next() {
        var (
            processoID int64
            uc, cnpj, concessionaria, cliente, colunaKanban, etapaAtual, subEtapa string
            dataSimples, dataDobro, formaDevolucao, dataFluxo string
            numeroNF, dataEmissao, dataVenc, dataPag string
            ultimaMov string
            creditoSimples, creditoDobro, valorFluxo, valorNF float64
        )
        if err := rows.Scan(
            &processoID,
            &uc,
            &cnpj,
            &concessionaria,
            &cliente,
            &colunaKanban,
            &etapaAtual,
            &subEtapa,
            &creditoSimples,
            &dataSimples,
            &creditoDobro,
            &dataDobro,
            &formaDevolucao,
            &valorFluxo,
            &dataFluxo,
            &numeroNF,
            &dataEmissao,
            &dataVenc,
            &dataPag,
            &valorNF,
            &ultimaMov,
        ); err != nil {
            continue
        }
        line := []string{
            strconv.FormatInt(processoID, 10),
            uc,
            cnpj,
            concessionaria,
            cliente,
            colunaKanban,
            etapaAtual,
            subEtapa,
            fmt.Sprintf("%.2f", creditoSimples),
            dataSimples,
            fmt.Sprintf("%.2f", creditoDobro),
            dataDobro,
            formaDevolucao,
            fmt.Sprintf("%.2f", valorFluxo),
            dataFluxo,
            numeroNF,
            dataEmissao,
            dataVenc,
            dataPag,
            fmt.Sprintf("%.2f", valorNF),
            "",
        }
        _ = w.Write(line)
    }
    w.Flush()
}

// POST /api/v1/admin/planilha/import
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

    tx, err := database.DB_App.Begin()
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
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
            if _, err := tx.Exec(`
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
            if _, err := tx.Exec(`
                INSERT INTO FT_FLUXO_RESSARCIMENTO (id_processo, forma_devolucao, valor, data_devolucao, created_at)
                VALUES (?, ?, ?, ?, NOW())`,
                pid, formaDevolucao, valorFluxo, dataFluxo); err != nil {
                c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("falha fluxo %d: %v", pid, err)})
                return
            }
        }

        if numeroNF != "" || valorNF > 0 || dataEmissao != nil || dataVenc != nil || dataPag != nil {
            if _, err := tx.Exec(`
                INSERT INTO FT_FATURAMENTO (id_processo, numero_nf, data_emissao, data_vencimento, data_pagamento, valor, created_at)
                VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                pid, numeroNF, dataEmissao, dataVenc, dataPag, valorNF); err != nil {
                c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("falha faturamento %d: %v", pid, err)})
                return
            }
        }

        if etapa != "" || sub != "" || comentario != "" {
            var etapaAtual, subAtual string
            _ = tx.QueryRow(`
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
                _ = tx.QueryRow("SELECT id_etapa_processo FROM DM_ETAPAS_PROCESSO WHERE etapa = ?", strings.TrimSpace(etapaNova)).Scan(&etapaID)
                if etapaID.Valid {
                    if _, err := tx.Exec(`UPDATE FT_PROCESSOS SET id_etapa_processo = ?, sub_etapa = ?, ultima_atualizacao = NOW() WHERE id_processo = ?`,
                        etapaID.Int64, subNova, pid); err != nil {
                        c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("falha atualizar processo %d: %v", pid, err)})
                        return
                    }
                }
            }

            if comentario == "" {
                comentario = "Importação de planilha"
            }
            if _, err := tx.Exec(`
                INSERT INTO FT_HISTORICO_MOVIMENTACOES (id_requisicao, status_anterior, status_novo, etapa_anterior, etapa_nova, sub_etapa, comentario, data_movimentacao)
                VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
                pid, "", "", etapaAtual, etapaNova, subNova, comentario); err != nil {
                c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("falha historico %d: %v", pid, err)})
                return
            }
        }

        count++
    }

    if err := tx.Commit(); err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    c.JSON(http.StatusOK, gin.H{"ok": true, "count": count})
}
