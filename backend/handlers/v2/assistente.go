package v2

// ─────────────────────────────────────────────────────────────────────────────
// Assistente do SOLICITANTE — consultas determinísticas (sem IA) para o chat em
// tela cheia do perfil "solicitante". O solicitante repassa informação ao cliente,
// então as regras de LIBERAÇÃO de valor ficam aqui, no servidor:
//
//   • Movimentações: sempre retornadas (andamento, não expõem dinheiro).
//   • Valor + data: só quando o DEFERIMENTO está preenchido no sistema. O valor
//     deferido e o devolvido são o MESMO número; cada data vem da sua origem real
//     (deferimento → FT_DEFERIMENTOS.data_procedencia; envio/devolução →
//     FT_FLUXO_RESSARCIMENTO). Nada de estimativa.
//   • Forma de devolução: FT_FLUXO_RESSARCIMENTO.forma_devolucao (Fatura/GD/Deposito).
//   • Tempo de envio do comprovante = data_devolucao − data_envio_financeiro.
//
// Endpoints (sob /api/v2, autenticados):
//   GET /assistente/processo?q=<numero|protocolo>
//   GET /assistente/cliente?nome=<cliente>
//   GET /assistente/tempo-medio?concessionaria=<nome>
// ─────────────────────────────────────────────────────────────────────────────

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

// ─── Processo / requisição ───────────────────────────────────────────────────

type movItem struct {
	Etapa      string `json:"etapa"`
	Data       string `json:"data"`
	Comentario string `json:"comentario"`
}

type devolucaoOut struct {
	Realizada           bool     `json:"realizada"`
	Forma               string   `json:"forma,omitempty"`
	Valor               *float64 `json:"valor,omitempty"`
	DataEnvioFinanceiro string   `json:"data_envio_financeiro,omitempty"`
	DataDevolucao       string   `json:"data_devolucao,omitempty"`
	TempoComprovanteDia *int     `json:"tempo_comprovante_dias,omitempty"`
}

// AssistenteProcesso — GET /assistente/processo?q=
func AssistenteProcesso(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	q := strings.TrimSpace(c.Query("q"))
	if q == "" {
		apiError(c, http.StatusBadRequest, "SEM_Q", "Informe o número do processo, protocolo ou requisição.", nil)
		return
	}
	idNum, _ := strconv.ParseInt(strings.TrimPrefix(q, "#"), 10, 64)

	var (
		idProc    int64
		codPub    sql.NullString
		cliente   sql.NullString
		concess   sql.NullString
		etapaAtu  sql.NullString
		idEtapa   sql.NullInt64
	)
	err := db.QueryRowContext(c.Request.Context(), `
SELECT p.id_processo,
       p.codigo_publico,
       COALESCE(NULLIF(p.cliente,''), r.cliente),
       r.concessionaria,
       e.nome,
       p.id_etapa_atual
  FROM FT_PROCESSOS p
  LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
  LEFT JOIN DM_ETAPAS e ON e.id_etapa = p.id_etapa_atual
 WHERE p.codigo_publico = ? OR r.numero_protocolo = ? OR p.id_processo = ?
 LIMIT 1`, q, q, idNum).
		Scan(&idProc, &codPub, &cliente, &concess, &etapaAtu, &idEtapa)
	if err == sql.ErrNoRows {
		c.JSON(http.StatusOK, gin.H{"encontrado": false, "consulta": q})
		return
	}
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}

	// Movimentações (andamento) — sempre.
	movs := []movItem{}
	rows, err := db.QueryContext(c.Request.Context(), `
SELECT COALESCE(e.nome,''),
       DATE_FORMAT(h.data_movimentacao,'%Y-%m-%d'),
       COALESCE(h.comentario,'')
  FROM FT_HISTORICO_MOVIMENTACOES h
  LEFT JOIN DM_ETAPAS e ON e.id_etapa = h.id_etapa_nova
 WHERE h.id_processo = ?
 ORDER BY h.data_movimentacao ASC`, idProc)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var m movItem
			var dt sql.NullString
			if err := rows.Scan(&m.Etapa, &dt, &m.Comentario); err == nil {
				m.Data = dt.String
				movs = append(movs, m)
			}
		}
	}

	// Deferimento — valor (crédito) + data de procedência.
	var (
		dataDefer sql.NullString
		creditoTot sql.NullFloat64
	)
	_ = db.QueryRowContext(c.Request.Context(), `
SELECT DATE_FORMAT(data_procedencia,'%Y-%m-%d'),
       COALESCE(credito_simples,0) + COALESCE(credito_dobro,0)
  FROM FT_DEFERIMENTOS
 WHERE id_processo = ?
 ORDER BY data_procedencia DESC
 LIMIT 1`, idProc).Scan(&dataDefer, &creditoTot)

	// Devolução — fluxo de ressarcimento (forma + datas + valor executado).
	var (
		forma     sql.NullString
		valExec   sql.NullFloat64
		dtEnvio   sql.NullString
		dtDevol   sql.NullString
		tempoComp sql.NullInt64
	)
	_ = db.QueryRowContext(c.Request.Context(), `
SELECT MAX(forma_devolucao),
       SUM(COALESCE(valor,0)),
       DATE_FORMAT(MIN(data_envio_financeiro),'%Y-%m-%d'),
       DATE_FORMAT(MAX(data_devolucao),'%Y-%m-%d'),
       DATEDIFF(MAX(data_devolucao), MIN(data_envio_financeiro))
  FROM FT_FLUXO_RESSARCIMENTO
 WHERE id_processo = ?`, idProc).
		Scan(&forma, &valExec, &dtEnvio, &dtDevol, &tempoComp)

	// Valor a exibir: deferido == devolvido. Usa o executado quando houver; senão o crédito.
	var valor *float64
	liberado := false
	if dataDefer.Valid && dataDefer.String != "" {
		v := creditoTot.Float64
		if valExec.Valid && valExec.Float64 > 0 {
			v = valExec.Float64
		}
		if v > 0 {
			valor = &v
			liberado = true
		}
	}

	dev := devolucaoOut{Realizada: false}
	if dtDevol.Valid && dtDevol.String != "" {
		dev.Realizada = true
		dev.Forma = normalizaForma(forma.String)
		if valExec.Valid && valExec.Float64 > 0 {
			ve := valExec.Float64
			dev.Valor = &ve
		}
		dev.DataEnvioFinanceiro = dtEnvio.String
		dev.DataDevolucao = dtDevol.String
		if tempoComp.Valid && tempoComp.Int64 >= 0 {
			t := int(tempoComp.Int64)
			dev.TempoComprovanteDia = &t
		}
	}

	out := gin.H{
		"encontrado":     true,
		"id_processo":    idProc,
		"codigo_publico": codPub.String,
		"cliente":        cliente.String,
		"concessionaria": concess.String,
		"etapa_atual":    etapaAtu.String,
		"indeferido":     idEtapa.Valid && idEtapa.Int64 == 11,
		"movimentacoes":  movs,
		"valor_liberado": liberado,
		"devolucao":      dev,
	}
	if liberado {
		out["valor"] = *valor
		out["data_deferimento"] = dataDefer.String
	}
	c.JSON(http.StatusOK, out)
}

// ─── Relatório de cliente ────────────────────────────────────────────────────

type formaQtd struct {
	Forma string `json:"forma"`
	Qtd   int    `json:"qtd"`
}

// AssistenteCliente — GET /assistente/cliente?nome=
func AssistenteCliente(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	nome := strings.TrimSpace(c.Query("nome"))
	if nome == "" {
		apiError(c, http.StatusBadRequest, "SEM_NOME", "Informe o nome do cliente.", nil)
		return
	}
	// Frase livre ("relatório da claro de 2026") → nome cadastrado que aparece nela.
	if r := resolveClienteNaFrase(c.Request.Context(), db, nome); r != "" {
		nome = r
	}
	like := "%" + strings.ToLower(nome) + "%"

	var total, deferidos, indeferidos sql.NullInt64
	_ = db.QueryRowContext(c.Request.Context(), `
SELECT COUNT(*) ,
       SUM(CASE WHEN df.id_processo IS NOT NULL THEN 1 ELSE 0 END),
       SUM(CASE WHEN p.id_etapa_atual = 11 THEN 1 ELSE 0 END)
  FROM FT_PROCESSOS p
  LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
  LEFT JOIN (SELECT DISTINCT id_processo FROM FT_DEFERIMENTOS) df ON df.id_processo = p.id_processo
 WHERE LOWER(COALESCE(NULLIF(p.cliente,''), r.cliente)) LIKE ?`, like).
		Scan(&total, &deferidos, &indeferidos)

	if total.Int64 == 0 {
		c.JSON(http.StatusOK, gin.H{"encontrado": false, "cliente": nome})
		return
	}

	var valorTotal, tMedDefer sql.NullFloat64
	_ = db.QueryRowContext(c.Request.Context(), `
SELECT ROUND(SUM(COALESCE(fx.valor, COALESCE(d.credito_simples,0)+COALESCE(d.credito_dobro,0))),2),
       ROUND(AVG(NULLIF(DATEDIFF(d.data_procedencia, r.data_criacao),0)),0)
  FROM FT_DEFERIMENTOS d
  JOIN FT_PROCESSOS p ON p.id_processo = d.id_processo
  LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
  LEFT JOIN (SELECT id_processo, SUM(valor) valor FROM FT_FLUXO_RESSARCIMENTO GROUP BY id_processo) fx
         ON fx.id_processo = d.id_processo
 WHERE LOWER(COALESCE(NULLIF(p.cliente,''), r.cliente)) LIKE ?`, like).
		Scan(&valorTotal, &tMedDefer)

	var tMedComp sql.NullFloat64
	_ = db.QueryRowContext(c.Request.Context(), `
SELECT ROUND(AVG(DATEDIFF(f.data_devolucao, f.data_envio_financeiro)),0)
  FROM FT_FLUXO_RESSARCIMENTO f
  JOIN FT_PROCESSOS p ON p.id_processo = f.id_processo
  LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
 WHERE f.data_devolucao IS NOT NULL AND f.data_envio_financeiro IS NOT NULL
   AND LOWER(COALESCE(NULLIF(p.cliente,''), r.cliente)) LIKE ?`, like).Scan(&tMedComp)

	formas := []formaQtd{}
	frows, err := db.QueryContext(c.Request.Context(), `
SELECT f.forma_devolucao, COUNT(*)
  FROM FT_FLUXO_RESSARCIMENTO f
  JOIN FT_PROCESSOS p ON p.id_processo = f.id_processo
  LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
 WHERE f.forma_devolucao IS NOT NULL AND f.forma_devolucao <> ''
   AND LOWER(COALESCE(NULLIF(p.cliente,''), r.cliente)) LIKE ?
 GROUP BY f.forma_devolucao
 ORDER BY COUNT(*) DESC`, like)
	if err == nil {
		defer frows.Close()
		for frows.Next() {
			var fq formaQtd
			var f sql.NullString
			if err := frows.Scan(&f, &fq.Qtd); err == nil {
				fq.Forma = normalizaForma(f.String)
				formas = append(formas, fq)
			}
		}
	}

	emAnalise := total.Int64 - deferidos.Int64 - indeferidos.Int64
	if emAnalise < 0 {
		emAnalise = 0
	}
	c.JSON(http.StatusOK, gin.H{
		"encontrado":                  true,
		"cliente":                     nome,
		"total_processos":             total.Int64,
		"deferidos":                   deferidos.Int64,
		"em_analise":                  emAnalise,
		"indeferidos":                 indeferidos.Int64,
		"valor_total_deferido":        nullF(valorTotal),
		"tempo_medio_deferimento_dias": nullI(tMedDefer),
		"tempo_medio_comprovante_dias": nullI(tMedComp),
		"formas":                      formas,
	})
}

// ─── Tempo médio por concessionária ──────────────────────────────────────────

// AssistenteTempoMedio — GET /assistente/tempo-medio?concessionaria=
func AssistenteTempoMedio(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	conc := strings.TrimSpace(c.Query("concessionaria"))
	if conc == "" {
		apiError(c, http.StatusBadRequest, "SEM_CONC", "Informe a concessionária.", nil)
		return
	}
	like := "%" + strings.ToLower(conc) + "%"

	var tMed, minD, maxD, amostra sql.NullFloat64
	_ = db.QueryRowContext(c.Request.Context(), `
SELECT ROUND(AVG(DATEDIFF(d.data_procedencia, r.data_criacao)),0),
       MIN(DATEDIFF(d.data_procedencia, r.data_criacao)),
       MAX(DATEDIFF(d.data_procedencia, r.data_criacao)),
       COUNT(*)
  FROM FT_DEFERIMENTOS d
  JOIN FT_PROCESSOS p ON p.id_processo = d.id_processo
  JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
 WHERE d.data_procedencia IS NOT NULL AND r.data_criacao IS NOT NULL
   AND LOWER(r.concessionaria) LIKE ?`, like).
		Scan(&tMed, &minD, &maxD, &amostra)

	var tMedComp sql.NullFloat64
	_ = db.QueryRowContext(c.Request.Context(), `
SELECT ROUND(AVG(DATEDIFF(f.data_devolucao, f.data_envio_financeiro)),0)
  FROM FT_FLUXO_RESSARCIMENTO f
  JOIN FT_PROCESSOS p ON p.id_processo = f.id_processo
  JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
 WHERE f.data_devolucao IS NOT NULL AND f.data_envio_financeiro IS NOT NULL
   AND LOWER(r.concessionaria) LIKE ?`, like).Scan(&tMedComp)

	c.JSON(http.StatusOK, gin.H{
		"concessionaria":               conc,
		"amostra":                      nullI(amostra),
		"tempo_medio_deferimento_dias": nullI(tMed),
		"min_dias":                     nullI(minD),
		"max_dias":                     nullI(maxD),
		"tempo_medio_comprovante_dias": nullI(tMedComp),
	})
}

// ─── helpers ─────────────────────────────────────────────────────────────────

func normalizaForma(f string) string {
	switch strings.ToLower(strings.TrimSpace(f)) {
	case "deposito", "depósito":
		return "Depósito"
	case "fatura":
		return "Fatura"
	case "gd":
		return "GD"
	default:
		return strings.TrimSpace(f)
	}
}

func nullF(v sql.NullFloat64) interface{} {
	if v.Valid {
		return v.Float64
	}
	return nil
}

func nullI(v sql.NullFloat64) interface{} {
	if v.Valid {
		return int(v.Float64)
	}
	return nil
}
