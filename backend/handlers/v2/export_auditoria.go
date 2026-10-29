package v2

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
)

// ExportAuditoria — GET /api/v2/processos/export-auditoria
// Retorna TODOS os processos com os campos pertinentes para auditoria geral dos dados
// (identificação, datas de ciclo, irregularidade, valores, deferimento/encerramento, último comentário).
// Sem paginação — é um dump completo para relatório.
func ExportAuditoria(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}

	const q = `
SELECT
  p.id_processo,
  COALESCE(p.codigo_publico,'')                                   AS codigo_publico,
  COALESCE(NULLIF(p.uc,''), r.uc, '')                             AS uc,
  COALESCE(NULLIF(p.cliente,''), r.cliente, '')                   AS cliente,
  COALESCE(NULLIF(p.concessionaria,''), r.concessionaria, '')     AS concessionaria,
  COALESCE(p.cod_empresa, 0)                                      AS cod_empresa,
  COALESCE(i.nome,'')                                             AS instancia,
  COALESCE(e.nome,'')                                             AS etapa,
  COALESCE(s.nome,'')                                             AS status,
  COALESCE(a.nome,'')                                             AS aprovacao,
  DATE(r.data_criacao)                                            AS data_criacao_requisicao,
  DATE(p.data_criacao)                                            AS data_registro_reclamacao,
  hu.ult                                                          AS data_ultima_movimentacao,
  TIMESTAMPDIFF(DAY, COALESCE(hu.ult, p.data_criacao), NOW())     AS dias_na_etapa,
  COALESCE(NULLIF(p.periodos_irregularidade,''), r.periodos_irregularidade, '')     AS periodos_irregularidade,
  COALESCE(NULLIF(p.descricao_irregularidade,''), r.descricao_irregularidade, '')   AS descricao_irregularidade,
  COALESCE(NULLIF(p.nome_tipo_irregularidade,''), ti.nome, '')    AS tipo_irregularidade,
  COALESCE(NULLIF(p.nome_subtipo_irregularidade,''), sti.nome, '') AS subtipo_irregularidade,
  COALESCE(fat.mes_ref,'')                                        AS mes_referencia,
  COALESCE(r.ressarcimento_estimado, p.ressarcimento_estimado, 0) AS ressarcimento_estimado,
  COALESCE(def.credito_simples, p.credito_simples, 0)            AS credito_simples,
  COALESCE(def.credito_dobro, p.credito_dobro, 0)                AS credito_dobro,
  COALESCE(p.repasse_simples, 0)                                  AS repasse_simples,
  COALESCE(p.repasse_dobro, 0)                                    AS repasse_dobro,
  COALESCE(def.data_procedencia, p.data_procedencia)              AS data_deferimento,
  enc.data_encerramento                                           AS data_encerramento,
  COALESCE(enc.motivo,'')                                         AS motivo_encerramento,
  COALESCE(enc.parecer_final,'')                                  AS parecer_final,
  COALESCE(hc.ultimo_comentario,'')                               AS ultimo_comentario,
  COALESCE(di.nome,'')                                            AS instancia_deferimento,
  COALESCE(def.data_procedencia, p.data_procedencia)              AS data_deferido_simples,
  def.data_credito_dobro                                          AS data_deferido_dobro,
  COALESCE(nf.nfs,'')                                             AS nf,
  nf.data_envio_financeiro                                        AS data_envio_financeiro,
  nf.data_vencimento_nf                                           AS data_vencimento_nf,
  nf.valor_nf                                                     AS valor_nf,
  COALESCE(rp.data_pagamento_nf, nf.data_pagamento_fat)           AS data_pagamento_nf,
  COALESCE(p.relevancia,0)                                        AS relevancia,
  COALESCE(p.suspenso,0)                                          AS suspenso,
  COALESCE(resp.nome,'')                                          AS responsavel,
  DATE(p.data_alerta)                                             AS data_alerta,
  p.ultima_atualizacao                                            AS ultima_atualizacao,
  DATE(p.data_movimentacao)                                       AS data_movimentacao,
  p.data_proxima_acao                                             AS data_proxima_acao,
  p.score_percentual                                              AS score_percentual,
  COALESCE(p.triagem_concluida,0)                                 AS triagem_concluida,
  p.percentual_repasse                                            AS percentual_repasse,
  COALESCE(NULLIF(p.uc_atual,''),'')                              AS uc_atual,
  COALESCE(def.status_analise,'')                                 AS status_analise_def,
  COALESCE(def.observacao,'')                                     AS observacao_def,
  nf.data_emissao_nf                                              AS data_emissao_nf,
  COALESCE(nf.series_nf,'')                                       AS serie_nf,
  COALESCE(nf.status_nf,'')                                       AS status_nf,
  COALESCE(dev.total_devolvido,0)                                 AS total_devolvido,
  COALESCE(dev.formas,'')                                         AS formas_devolucao,
  COALESCE(dev.datas_dev,'')                                      AS datas_devolucao,
  COALESCE(dev.datas_env,'')                                      AS datas_envio_financeiro_dev
FROM FT_PROCESSOS p
LEFT JOIN FT_REQUISICOES          r   ON r.id_requisicao = p.id_processo
LEFT JOIN DM_INSTANCIAS           i   ON i.id_instancia  = p.id_instancia_atual
LEFT JOIN DM_ETAPAS               e   ON e.id_etapa      = p.id_etapa_atual
LEFT JOIN DM_STATUS_PROCESSO      s   ON s.id_status     = p.id_status_atual
LEFT JOIN DM_STATUS_APROVACAO     a   ON a.id_aprovacao  = p.id_aprovacao_atual
LEFT JOIN DM_TIPO_IRREGULARIDADE  ti  ON ti.id_tipo      = p.id_tipo_irregularidade
LEFT JOIN DM_SUBTIPO_IRREGULARIDADE sti ON sti.id_subtipo = p.id_subtipo_irregularidade
LEFT JOIN FT_DEFERIMENTOS         def ON def.id_processo = p.id_processo
LEFT JOIN FT_ENCERRAMENTO         enc ON enc.id_processo = p.id_processo
LEFT JOIN (
  SELECT id_processo, GROUP_CONCAT(DISTINCT NULLIF(mes_ref,'') ORDER BY mes_ref SEPARATOR ', ') AS mes_ref
    FROM FT_REQUISICOES_FATURAS GROUP BY id_processo
) fat ON fat.id_processo = p.id_processo
LEFT JOIN (
  SELECT id_processo, MAX(data_movimentacao) AS ult
    FROM FT_HISTORICO_MOVIMENTACOES GROUP BY id_processo
) hu ON hu.id_processo = p.id_processo
LEFT JOIN (
  SELECT h1.id_processo, h1.comentario AS ultimo_comentario
    FROM FT_HISTORICO_MOVIMENTACOES h1
    JOIN (
      SELECT id_processo, MAX(id_historico) AS mid
        FROM FT_HISTORICO_MOVIMENTACOES
       WHERE comentario IS NOT NULL AND comentario <> ''
       GROUP BY id_processo
    ) h2 ON h2.id_processo = h1.id_processo AND h2.mid = h1.id_historico
) hc ON hc.id_processo = p.id_processo
LEFT JOIN DM_INSTANCIAS di ON di.id_instancia = def.id_instancia
LEFT JOIN (
  SELECT id_processo,
    GROUP_CONCAT(DISTINCT NULLIF(numero_nf,'') ORDER BY numero_nf SEPARATOR ', ') AS nfs,
    SUM(valor)                    AS valor_nf,
    MAX(data_envio_financeiro) AS data_envio_financeiro,
    MAX(data_emissao)             AS data_emissao_nf,
    MAX(data_vencimento)          AS data_vencimento_nf,
    MAX(data_pagamento)           AS data_pagamento_fat,
    GROUP_CONCAT(DISTINCT NULLIF(serie_nf,'') ORDER BY serie_nf SEPARATOR ', ') AS series_nf,
    GROUP_CONCAT(DISTINCT NULLIF(status_nf,'') SEPARATOR ', ')                  AS status_nf
    FROM FT_FATURAMENTO GROUP BY id_processo
) nf ON nf.id_processo = p.id_processo
LEFT JOIN (
  SELECT id_processo, MAX(data_devolucao) AS data_pagamento_nf
    FROM FT_FLUXO_RESSARCIMENTO GROUP BY id_processo
) rp ON rp.id_processo = p.id_processo
LEFT JOIN DM_USUARIOS resp ON resp.id_usuario = p.id_responsavel
LEFT JOIN (
  SELECT id_processo,
    SUM(valor)                                                                  AS total_devolvido,
    GROUP_CONCAT(DISTINCT NULLIF(forma_devolucao,'') SEPARATOR ', ')            AS formas,
    GROUP_CONCAT(DATE(data_devolucao) ORDER BY data_devolucao SEPARATOR ', ')   AS datas_dev,
    GROUP_CONCAT(DISTINCT DATE(data_envio_financeiro) SEPARATOR ', ')           AS datas_env
    FROM FT_FLUXO_RESSARCIMENTO GROUP BY id_processo
) dev ON dev.id_processo = p.id_processo
ORDER BY p.id_processo`

	rows, err := db.QueryContext(c.Request.Context(), q)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	defer rows.Close()

	items := []gin.H{}
	for rows.Next() {
		var (
			idProc                                                        int
			codigo, uc, cliente, conc                                     string
			codEmp                                                        int
			inst, etapa, status, aprov                                    string
			dtCriacaoReq, dtRegReclam, dtUltMov, dtDefer, dtEnc           sql.NullString
			diasEtapa                                                     sql.NullInt64
			periodos, descricao, tipo, subtipo, mesRef                    string
			ressEst, credS, credD, repS, repD                             sql.NullFloat64
			motivoEnc, parecer, ultimoComentario                          string
			instDefer, nfNums                                             string
			dtDefSimples, dtDefDobro, dtEnvioFin, dtVencNF, dtPagNF        sql.NullString
			valorNF                                                       sql.NullFloat64
			relevancia, suspenso                                          int
			responsavel, ucAtual, statusDef, obsDef                       string
			serieNF, statusNF, formasDev, datasDev, datasEnvDev           string
			dtAlerta, ultimaAtual, dtMov, dtProxAcao, dtEmissaoNF         sql.NullString
			scorePct, pctRepasse, totalDev                                sql.NullFloat64
			triagem                                                       int
		)
		if err := rows.Scan(&idProc, &codigo, &uc, &cliente, &conc, &codEmp,
			&inst, &etapa, &status, &aprov,
			&dtCriacaoReq, &dtRegReclam, &dtUltMov, &diasEtapa,
			&periodos, &descricao, &tipo, &subtipo, &mesRef,
			&ressEst, &credS, &credD, &repS, &repD,
			&dtDefer, &dtEnc, &motivoEnc, &parecer, &ultimoComentario,
			&instDefer, &dtDefSimples, &dtDefDobro, &nfNums,
			&dtEnvioFin, &dtVencNF, &valorNF, &dtPagNF,
			&relevancia, &suspenso,
			&responsavel, &dtAlerta, &ultimaAtual, &dtMov, &dtProxAcao,
			&scorePct, &triagem, &pctRepasse, &ucAtual,
			&statusDef, &obsDef, &dtEmissaoNF, &serieNF, &statusNF,
			&totalDev, &formasDev, &datasDev, &datasEnvDev); err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", "scan: "+err.Error(), nil)
			return
		}
		fnum := func(v sql.NullFloat64) interface{} {
			if v.Valid {
				return v.Float64
			}
			return nil
		}
		fstr := func(v sql.NullString) interface{} {
			if v.Valid {
				return v.String
			}
			return nil
		}
		items = append(items, gin.H{
			"id_processo":              idProc,
			"codigo_publico":           codigo,
			"uc":                       uc,
			"cliente":                  cliente,
			"concessionaria":           conc,
			"cod_empresa":              codEmp,
			"instancia":                inst,
			"etapa":                    etapa,
			"status":                   status,
			"aprovacao":                aprov,
			"data_criacao_requisicao":  fstr(dtCriacaoReq),
			"data_registro_reclamacao": fstr(dtRegReclam),
			"data_ultima_movimentacao": fstr(dtUltMov),
			"dias_na_etapa":            func() interface{} { if diasEtapa.Valid { return diasEtapa.Int64 }; return nil }(),
			"periodos_irregularidade":  periodos,
			"descricao_irregularidade": descricao,
			"tipo_irregularidade":      tipo,
			"subtipo_irregularidade":   subtipo,
			"mes_referencia":           mesRef,
			"ressarcimento_estimado":   fnum(ressEst),
			"credito_simples":          fnum(credS),
			"credito_dobro":            fnum(credD),
			"repasse_simples":          fnum(repS),
			"repasse_dobro":            fnum(repD),
			"data_deferimento":         fstr(dtDefer),
			"data_encerramento":        fstr(dtEnc),
			"motivo_encerramento":      motivoEnc,
			"parecer_final":            parecer,
			"ultimo_comentario":        ultimoComentario,
			"instancia_deferimento":    instDefer,
			"data_deferido_simples":    fstr(dtDefSimples),
			"data_deferido_dobro":      fstr(dtDefDobro),
			"nf":                       nfNums,
			"data_envio_financeiro":    fstr(dtEnvioFin),
			"data_vencimento_nf":       fstr(dtVencNF),
			"valor_nf":                 fnum(valorNF),
			"data_pagamento_nf":        fstr(dtPagNF),
			"relevante":                relevancia == 1,
			"suspenso":                 suspenso == 1,
			"responsavel":              responsavel,
			"data_alerta":              fstr(dtAlerta),
			"ultima_atualizacao":       fstr(ultimaAtual),
			"data_movimentacao":        fstr(dtMov),
			"data_proxima_acao":        fstr(dtProxAcao),
			"score_percentual":         fnum(scorePct),
			"triagem_concluida":        triagem == 1,
			"percentual_repasse":       fnum(pctRepasse),
			"uc_atual":                 ucAtual,
			"status_analise_def":       statusDef,
			"observacao_def":           obsDef,
			"data_emissao_nf":          fstr(dtEmissaoNF),
			"serie_nf":                 serieNF,
			"status_nf":                statusNF,
			"total_devolvido":          fnum(totalDev),
			"formas_devolucao":         formasDev,
			"datas_devolucao":          datasDev,
			"datas_envio_financeiro":   datasEnvDev,
		})
	}

	// --- Devoluções (aba Financeiro): uma linha por devolução do FT_FLUXO_RESSARCIMENTO ---
	// Referência = meses da reclamação: usa mes_ref (FT_REQUISICOES_FATURAS) quando houver,
	// senão o periodos_irregularidade do processo. Normalização p/ MM/AAAA é feita no front.
	const qDev = `
SELECT
  f.id_processo,
  COALESCE(p.codigo_publico,'')                               AS codigo_publico,
  COALESCE(NULLIF(p.uc,''), r.uc, '')                         AS uc,
  COALESCE(NULLIF(p.cliente,''), r.cliente, '')               AS cliente,
  COALESCE(NULLIF(p.concessionaria,''), r.concessionaria, '') AS concessionaria,
  f.data_envio_financeiro                                     AS data_envio_financeiro,
  COALESCE(f.forma_devolucao,'')                              AS forma_devolucao,
  f.data_devolucao                                            AS data_devolucao,
  f.valor                                                     AS valor,
  COALESCE(NULLIF(p.periodos_irregularidade,''), r.periodos_irregularidade, '') AS periodos_irregularidade,
  COALESCE(fat.mes_ref,'')                                    AS mes_referencia
FROM FT_FLUXO_RESSARCIMENTO f
JOIN FT_PROCESSOS p ON p.id_processo = f.id_processo
LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = f.id_processo
LEFT JOIN (
  SELECT id_processo, GROUP_CONCAT(DISTINCT NULLIF(mes_ref,'') ORDER BY mes_ref SEPARATOR ', ') AS mes_ref
    FROM FT_REQUISICOES_FATURAS GROUP BY id_processo
) fat ON fat.id_processo = f.id_processo
ORDER BY f.id_processo, f.data_devolucao`

	fnum := func(v sql.NullFloat64) interface{} {
		if v.Valid {
			return v.Float64
		}
		return nil
	}
	fstr := func(v sql.NullString) interface{} {
		if v.Valid {
			return v.String
		}
		return nil
	}

	devolucoes := []gin.H{}
	devRows, err := db.QueryContext(c.Request.Context(), qDev)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "devolucoes: "+err.Error(), nil)
		return
	}
	defer devRows.Close()
	for devRows.Next() {
		var (
			idProc                            int
			codigo, uc, cliente, conc         string
			forma, periodos, mesRef           string
			dtEnvio, dtDev                    sql.NullString
			valor                             sql.NullFloat64
		)
		if err := devRows.Scan(&idProc, &codigo, &uc, &cliente, &conc,
			&dtEnvio, &forma, &dtDev, &valor, &periodos, &mesRef); err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", "scan devolucao: "+err.Error(), nil)
			return
		}
		devolucoes = append(devolucoes, gin.H{
			"id_processo":             idProc,
			"codigo_publico":          codigo,
			"uc":                      uc,
			"cliente":                 cliente,
			"concessionaria":          conc,
			"data_envio_financeiro":   fstr(dtEnvio),
			"forma_devolucao":         forma,
			"data_devolucao":          fstr(dtDev),
			"valor":                   fnum(valor),
			"periodos_irregularidade": periodos,
			"mes_referencia":          mesRef,
		})
	}

	c.JSON(http.StatusOK, gin.H{"items": items, "devolucoes": devolucoes, "total": len(items)})
}
