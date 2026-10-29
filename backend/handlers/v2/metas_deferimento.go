package v2

import (
	"database/sql"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
)

// ============================================================================
// Metas de deferimento (repasse) — barra de progressão no Controle de Processos.
// Métrica: soma do REPASSE (parcela AME) dos processos ENVIADOS AO FINANCEIRO,
// atribuída ao mês em que foram enviados (data_envio_financeiro em
// FT_FLUXO_RESSARCIMENTO), comparada com uma meta calibrável.
//   - Conta só a partir de "enviado ao financeiro" (não todo deferido no mês).
//   - meta_mensal: valor único, editável, vale para todos os meses.
//   - meta_anual:  valor fixo do ano.
// Config persistida em DM_META_REPASSE (linha única id=1), auto-criada.
// ============================================================================

// ensureMetaTable cria a tabela/linha default se ainda não existir (idempotente).
// Best-effort: se o usuário do banco não tiver DDL, apenas segue — o read trata ausência.
func ensureMetaTable(c *gin.Context, db *sql.DB) {
	_, _ = db.ExecContext(c.Request.Context(), `
CREATE TABLE IF NOT EXISTS DM_META_REPASSE (
  id            INT PRIMARY KEY,
  meta_mensal   DECIMAL(14,2) NOT NULL DEFAULT 0,
  meta_anual    DECIMAL(14,2) NOT NULL DEFAULT 0,
  atualizado_em DATETIME NULL
)`)
	// Defaults iniciais (o gestor calibra depois). INSERT IGNORE não sobrescreve.
	_, _ = db.ExecContext(c.Request.Context(),
		`INSERT IGNORE INTO DM_META_REPASSE (id, meta_mensal, meta_anual) VALUES (1, 200000, 2400000)`)
}

type metaMesOut struct {
	Ano     int     `json:"ano"`
	Mes     int     `json:"mes"`
	Repasse float64 `json:"repasse"`
	Qtd     int     `json:"qtd"`
}

// envioDtSub é a subquery (alias `e`) que resolve, por processo, a DATA DE ENVIO AO
// FINANCEIRO manual: COALESCE(fluxo, faturamento, 1ª movimentação p/ Faturamento).
// Reaproveitada no resumo mensal e no detalhe por empresa p/ não divergir a regra.
const envioDtSub = `
    SELECT prc.id_processo, COALESCE(fx.dt, ft.dt, et.dt) AS dt
      FROM (SELECT DISTINCT id_processo FROM FT_DEFERIMENTOS) prc
      LEFT JOIN (SELECT id_processo, MIN(data_envio_financeiro) AS dt
                   FROM FT_FLUXO_RESSARCIMENTO
                  WHERE data_envio_financeiro IS NOT NULL
                  GROUP BY id_processo) fx ON fx.id_processo = prc.id_processo
      LEFT JOIN (SELECT id_processo, MIN(data_envio_financeiro) AS dt
                   FROM FT_FATURAMENTO
                  WHERE data_envio_financeiro IS NOT NULL
                  GROUP BY id_processo) ft ON ft.id_processo = prc.id_processo
      LEFT JOIN (SELECT id_processo, MIN(data_movimentacao) AS dt
                   FROM FT_HISTORICO_MOVIMENTACOES
                  WHERE id_etapa_nova = 4
                  GROUP BY id_processo) et ON et.id_processo = prc.id_processo`

// GetMetasDeferimento — GET /api/v2/metas/deferimento
// Retorna metas + repasse do mês atual + YTD do ano + histórico mês a mês.
func GetMetasDeferimento(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	ensureMetaTable(c, db)

	var metaMensal, metaAnual float64
	var atualizado sql.NullString
	err := db.QueryRowContext(c.Request.Context(),
		`SELECT meta_mensal, meta_anual, DATE_FORMAT(atualizado_em, '%Y-%m-%d %H:%i')
		   FROM DM_META_REPASSE WHERE id = 1`).
		Scan(&metaMensal, &metaAnual, &atualizado)
	if err != nil && err != sql.ErrNoRows {
		// tabela pode não existir (sem DDL) — degrada para metas zeradas em vez de 500
		metaMensal, metaAnual = 0, 0
	}

	// Repasse (parcela AME) dos processos ENVIADOS AO FINANCEIRO, atribuído ao mês do envio.
	// Usa SEMPRE a DATA MANUAL que a analista registrou (não o carimbo automático). Ela
	// mora em DUAS tabelas, conforme a versão do fluxo:
	//   (1) FT_FLUXO_RESSARCIMENTO.data_envio_financeiro (módulo Fluxo, antigo);
	//   (2) FT_FATURAMENTO.data_envio_financeiro (tela de Faturamento, atual).
	// Por processo: COALESCE(data manual do fluxo, data manual do faturamento, 1ª entrada
	// na etapa Faturamento). As DUAS datas manuais vêm antes do carimbo de movimentação —
	// assim um lançamento feito no dia seguinte não joga o processo para o mês errado.
	// A movimentação (et) fica só como último fallback (processo sem data manual).
	// MIN por processo evita duplicar o repasse.
	rows, err := db.QueryContext(c.Request.Context(), `
SELECT YEAR(e.dt)  AS ano,
       MONTH(e.dt) AS mes,
       ROUND(SUM(COALESCE(d.repasse_simples,0) + COALESCE(d.repasse_dobro,0)), 2) AS repasse,
       COUNT(DISTINCT d.id_processo) AS qtd
  FROM FT_DEFERIMENTOS d
  JOIN (`+envioDtSub+`
  ) e ON e.id_processo = d.id_processo
 WHERE e.dt IS NOT NULL
 GROUP BY YEAR(e.dt), MONTH(e.dt)
 ORDER BY ano, mes`)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	defer rows.Close()

	hist := []metaMesOut{}
	for rows.Next() {
		var m metaMesOut
		if err := rows.Scan(&m.Ano, &m.Mes, &m.Repasse, &m.Qtd); err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", "scan: "+err.Error(), nil)
			return
		}
		hist = append(hist, m)
	}

	now := time.Now()
	anoAtual, mesAtual := now.Year(), int(now.Month())
	var repasseMes, repasseAno float64
	var qtdMes, qtdAno int
	for _, m := range hist {
		if m.Ano == anoAtual {
			repasseAno += m.Repasse
			qtdAno += m.Qtd
			if m.Mes == mesAtual {
				repasseMes = m.Repasse
				qtdMes = m.Qtd
			}
		}
	}

	var atualizadoOut interface{}
	if atualizado.Valid {
		atualizadoOut = atualizado.String
	}

	c.JSON(http.StatusOK, gin.H{
		"meta_mensal":   metaMensal,
		"meta_anual":    metaAnual,
		"atualizado_em": atualizadoOut,
		"mes_atual":     gin.H{"ano": anoAtual, "mes": mesAtual, "repasse": repasseMes, "qtd": qtdMes},
		"ano_atual":     gin.H{"ano": anoAtual, "repasse": repasseAno, "qtd": qtdAno},
		"historico":     hist,
	})
}

type metaEmpresaOut struct {
	Empresa string  `json:"empresa"`
	Qtd     int     `json:"qtd"`
	Repasse float64 `json:"repasse"`
}

// GetMetasDeferimentoDetalhe — GET /api/v2/metas/deferimento/detalhe?ano=YYYY[&mes=M]
// Resumo por EMPRESA (cliente) dos processos enviados ao financeiro no período:
//   - com `mes`: só aquele mês;
//   - sem `mes`: o ano inteiro (até o momento).
// Mesma regra de data de envio do resumo mensal (envioDtSub).
func GetMetasDeferimentoDetalhe(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}

	ano, err := strconv.Atoi(c.Query("ano"))
	if err != nil || ano < 2000 || ano > 2100 {
		apiError(c, http.StatusBadRequest, "ANO_INVALIDO", "informe ?ano=AAAA", nil)
		return
	}
	where := "e.dt IS NOT NULL AND YEAR(e.dt) = ?"
	args := []interface{}{ano}
	mesStr := c.Query("mes")
	mes := 0
	if mesStr != "" {
		mes, err = strconv.Atoi(mesStr)
		if err != nil || mes < 1 || mes > 12 {
			apiError(c, http.StatusBadRequest, "MES_INVALIDO", "mês deve ser 1..12", nil)
			return
		}
		where += " AND MONTH(e.dt) = ?"
		args = append(args, mes)
	}

	q := `
SELECT COALESCE(NULLIF(TRIM(p.cliente), ''), '(sem cliente)') AS empresa,
       COUNT(DISTINCT d.id_processo) AS qtd,
       ROUND(SUM(COALESCE(d.repasse_simples,0) + COALESCE(d.repasse_dobro,0)), 2) AS repasse
  FROM FT_DEFERIMENTOS d
  JOIN (` + envioDtSub + `
  ) e ON e.id_processo = d.id_processo
  JOIN FT_PROCESSOS p ON p.id_processo = d.id_processo
 WHERE ` + where + `
 GROUP BY empresa
 ORDER BY repasse DESC, qtd DESC`

	rows, err := db.QueryContext(c.Request.Context(), q, args...)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	defer rows.Close()

	out := []metaEmpresaOut{}
	var totQtd int
	var totRepasse float64
	for rows.Next() {
		var e metaEmpresaOut
		if err := rows.Scan(&e.Empresa, &e.Qtd, &e.Repasse); err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", "scan: "+err.Error(), nil)
			return
		}
		out = append(out, e)
		totQtd += e.Qtd
		totRepasse += e.Repasse
	}

	c.JSON(http.StatusOK, gin.H{
		"ano":          ano,
		"mes":          mes, // 0 = ano inteiro
		"empresas":     out,
		"total_qtd":    totQtd,
		"total_repasse": totRepasse,
	})
}

type metaUpdateIn struct {
	MetaMensal *float64 `json:"meta_mensal"`
	MetaAnual  *float64 `json:"meta_anual"`
}

// AtualizarMetasDeferimento — PUT /api/v2/metas/deferimento
// Body: {meta_mensal?, meta_anual?} — atualiza o que vier (parcial).
func AtualizarMetasDeferimento(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	ensureMetaTable(c, db)

	var in metaUpdateIn
	if err := c.ShouldBindJSON(&in); err != nil {
		apiError(c, http.StatusBadRequest, "BODY_INVALIDO", err.Error(), nil)
		return
	}
	if in.MetaMensal == nil && in.MetaAnual == nil {
		apiError(c, http.StatusBadRequest, "SEM_CAMPOS", "informe meta_mensal e/ou meta_anual", nil)
		return
	}
	if (in.MetaMensal != nil && *in.MetaMensal < 0) || (in.MetaAnual != nil && *in.MetaAnual < 0) {
		apiError(c, http.StatusBadRequest, "VALOR_INVALIDO", "metas não podem ser negativas", nil)
		return
	}

	if in.MetaMensal != nil {
		if _, err := db.ExecContext(c.Request.Context(),
			`UPDATE DM_META_REPASSE SET meta_mensal = ?, atualizado_em = NOW() WHERE id = 1`,
			*in.MetaMensal); err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
			return
		}
	}
	if in.MetaAnual != nil {
		if _, err := db.ExecContext(c.Request.Context(),
			`UPDATE DM_META_REPASSE SET meta_anual = ?, atualizado_em = NOW() WHERE id = 1`,
			*in.MetaAnual); err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}
