package handlers

import (
    "database/sql"
    "fmt"
    "net/http"
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
        LEFT JOIN FT_REQUISICOES r         ON r.id_requisicao = p.id_processo
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
    if len(where) > 0 {
        sqlBase += " WHERE " + strings.Join(where, " AND ")
    }
    sqlBase += " ORDER BY p.id_processo DESC, h.data_movimentacao DESC"
    if limit != "" {
        sqlBase += fmt.Sprintf(" LIMIT %s", limit)
        if offset != "" && offset != "0" {
            sqlBase += fmt.Sprintf(" OFFSET %s", offset)
        }
    }

    rows, err := database.DB_App.Query(sqlBase, args...)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    defer rows.Close()

    out := make([]PlanilhaRow, 0, 200)
    for rows.Next() {
        var it PlanilhaRow
        if err := rows.Scan(
            &it.ProcessoID, &it.Uc, &it.CNPJ, &it.Concessionaria, &it.Cliente,
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
        LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON h.id_requisicao = r.id_requisicao
        LEFT JOIN FT_DEFERIMENTOS d ON d.id_processo = r.id_requisicao
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
        sqlBaseAlt += " ORDER BY r.id_requisicao DESC, h.data_movimentacao DESC"

        rows2, err2 := database.DB_App.Query(sqlBaseAlt, args...)
        if err2 == nil {
            defer rows2.Close()
            for rows2.Next() {
                var it PlanilhaRow
                if err := rows2.Scan(
                    &it.ProcessoID, &it.Uc, &it.CNPJ, &it.Concessionaria, &it.Cliente,
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
