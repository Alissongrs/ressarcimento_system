// backend/handlers/processo_handler.go
package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"ressarcimento-backend/database"
	"ressarcimento-backend/models"
	"ressarcimento-backend/repositories"
	"ressarcimento-backend/services"
	"ressarcimento-backend/sse"
	"ressarcimento-backend/utils"

	"sync"

	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
	"github.com/spf13/cast"
	"gorm.io/gorm"
)

// helper: allocate *string from value
func strPtr(s string) *string { return &s }

type gormResult struct {
	rowsAffected int64
	lastInsertID int64
}

func (r gormResult) LastInsertId() (int64, error) { return r.lastInsertID, nil }
func (r gormResult) RowsAffected() (int64, error) { return r.rowsAffected, nil }

func execGorm(tx *gorm.DB, query string, args ...interface{}) (sql.Result, error) {
	res := tx.Exec(query, args...)
	if res.Error != nil {
		return nil, res.Error
	}
	var lastID sql.NullInt64
	_ = tx.Raw("SELECT LAST_INSERT_ID()").Row().Scan(&lastID)
	return gormResult{rowsAffected: res.RowsAffected, lastInsertID: lastID.Int64}, nil
}

func queryRowGorm(tx *gorm.DB, query string, args ...interface{}) *sql.Row {
	return tx.Raw(query, args...).Row()
}

func queryGorm(tx *gorm.DB, query string, args ...interface{}) (*sql.Rows, error) {
	return tx.Raw(query, args...).Rows()
}

/* ======================================================================
   Tipos e utilitários
   ====================================================================== */

type KanbanResponse struct {
	Colunas map[string][]models.Processo `json:"colunas"`
	Totais  map[string]float64           `json:"totais"`
}

// mapColunaID: mapeamento robusto de etapa/coluna para ID do Kanban
func mapColunaID(etapa string) int {
	e := strings.TrimSpace(strings.ToLower(etapa))
	switch e {
	case "ativos", "distribuidora", "ouvidoria", "aneel", "sma":
		return 1
	case "deferidos", "deferido", "pendente", "em conciliao", "em conciliacao", "em contestao", "em contestacao":
		return 2
	case "fluxo de ressarcimento", "fluxo ressarcimento", "ressarcimento", "validacao", "validação", "enviado ao financeiro", "envio ao financeiro":
		return 3
	case "faturamento":
		return 4
	case "concluido", "concluídos", "concluidos":
		return 5
	case "indeferidos", "indeferido":
		return 6
	default:
		return 1 // Fallback para Ativos
	}
}

// mapColunaNomeByID: nome da coluna a partir do ID
func mapColunaNomeByID(id int) string {
	switch id {
	case 1:
		return "Ativos"
	case 2:
		return "Deferidos"
	case 3:
		return "Fluxo de Ressarcimento"
	case 4:
		return "Faturamento"
	case 5:
		return "Concluídos"
	case 6:
		return "Indeferidos"
	default:
		return "Desconhecido"
	}
}

// parseBoolLoose: interpreta vários formatos de boolean
func parseBoolLoose(s string) (bool, bool) {
	if s == "" {
		return false, false
	}
	v := strings.TrimSpace(strings.ToLower(s))
	switch v {
	case "1", "true", "t", "yes", "y", "sim", "on":
		return true, true
	case "0", "false", "f", "no", "n", "nao", "não":
		return false, true
	default:
		return false, false
	}
}

// stripAccentsLower normaliza para minúsculas e remove acentos comuns
func stripAccentsLower(s string) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	for _, r := range s {
		switch r {
		case 'á', 'à', 'â', 'ã', 'ä', 'Á', 'À', 'Â', 'Ã', 'Ä':
			r = 'a'
		case 'é', 'è', 'ê', 'ë', 'É', 'È', 'Ê', 'Ë':
			r = 'e'
		case 'í', 'ì', 'î', 'ï', 'Í', 'Ì', 'Î', 'Ï':
			r = 'i'
		case 'ó', 'ò', 'ô', 'õ', 'ö', 'Ó', 'Ò', 'Ô', 'Õ', 'Ö':
			r = 'o'
		case 'ú', 'ù', 'û', 'ü', 'Ú', 'Ù', 'Û', 'Ü':
			r = 'u'
		case 'ç', 'Ç':
			r = 'c'
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return b.String()
}

// parseValorString foi substituído por utils.ParseBrazilianCurrency
// que retorna decimal.Decimal ao invés de float64

// normalizarForma normaliza strings para comparar/aceitar "Depósito" == "Deposito"
func normalizarForma(f string) string {
	return stripAccentsLower(f)
}

// identifica admin pelo contexto (middleware deve popular "isAdmin" ou "role")
func isAdmin(c *gin.Context) bool {
	if v, ok := c.Get("isAdmin"); ok {
		if b, ok2 := v.(bool); ok2 && b {
			return true
		}
	}
	if v, ok := c.Get("role"); ok {
		if s, ok2 := v.(string); ok2 {
			s = strings.ToLower(strings.TrimSpace(s))
			return s == "admin" || s == "administrador"
		}
	}
	return false
}

/* ======================================================================
   Kanban FAST — handler com service (repo -> service -> handler)
   ====================================================================== */

type ProcessosHandler struct {
	svc services.ProcessosService
}

func NewProcessosHandler(svc services.ProcessosService) *ProcessosHandler {
	return &ProcessosHandler{svc: svc}
}

// cache global do kanban-fast (TTL 30s)
var kanbanCache struct {
	sync.RWMutex
	payload   []byte
	expiresAt time.Time
}

// InvalidateKanbanCache força o próximo request a recomputar.
func InvalidateKanbanCache() {
	kanbanCache.Lock()
	kanbanCache.expiresAt = time.Time{}
	kanbanCache.Unlock()
}

// GET /api/processos/kanban-fast
// Retorna um mapa: { "Ativos": [...], "Deferidos": [...], ... }
func (h *ProcessosHandler) KanbanFast(c *gin.Context) {
	ctx := c.Request.Context()

	limit := 0
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n >= 0 {
			limit = n
		}
	}
	coluna := strings.TrimSpace(c.Query("coluna"))

	// Serve do cache apenas quando não há filtros específicos
	useCache := limit == 0 && coluna == ""
	if useCache {
		kanbanCache.RLock()
		if time.Now().Before(kanbanCache.expiresAt) && len(kanbanCache.payload) > 0 {
			payload := kanbanCache.payload
			kanbanCache.RUnlock()
			c.Data(http.StatusOK, "application/json; charset=utf-8", payload)
			return
		}
		kanbanCache.RUnlock()
	}

	itens, err := h.svc.ListarKanbanFast(ctx, limit, coluna)
	if err != nil {
		log.Printf("[kanban-fast] erro na listagem: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	normalizeCol := func(col string) string {
		col = strings.TrimSpace(col)
		switch col {
		case "":
			return "Ativos"
		case "Indeferido":
			return "Indeferidos"
		default:
			return col
		}
	}

	resp := make(map[string][]models.ProcessoKanbanDTO, 6)
	for _, it := range itens {
		if it.Suspenso != nil && *it.Suspenso {
			it.ColunaKanban = "Suspensos"
		}
		col := normalizeCol(it.ColunaKanban)
		resp[col] = append(resp[col], it.ToDTO())
	}

	payload, err := json.Marshal(gin.H{"colunas": resp})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "marshal error"})
		return
	}

	if useCache {
		kanbanCache.Lock()
		kanbanCache.payload = payload
		kanbanCache.expiresAt = time.Now().Add(30 * time.Second)
		kanbanCache.Unlock()
	}

	c.Data(http.StatusOK, "application/json; charset=utf-8", payload)
}

/* ======================================================================
   Kanban (legado) — a versão FAST está em outro handler
   ====================================================================== */

func GetProcessosKanban(c *gin.Context) {
	query := `
        SELECT
            p.id_processo,
            etapa.etapa,
            p.sub_etapa,
            coluna.nome_coluna,
            p.ultima_atualizacao,
            p.data_alerta,
            p.relevancia,
            req.cliente,
            req.uc,
            req.concessionaria,
            req.ressarcimento_estimado,
            req.endereco_completo,
            IFNULL(CONCAT('[', GROUP_CONCAT(DISTINCT JSON_OBJECT('id', t.id_tag, 'nome', t.nome, 'cor', t.cor)), ']'), '[]') AS tags_json,
            def.credito_simples,
            def.credito_dobro,
            COALESCE(p.suspenso, CASE WHEN LOWER(COALESCE(p.sub_etapa,'')) = 'suspenso' THEN 1 ELSE 0 END) AS suspenso
        FROM
            FT_PROCESSOS p
        JOIN FT_REQUISICOES req ON p.id_processo = req.id_requisicao
        JOIN DM_ETAPAS_PROCESSO etapa ON p.id_etapa_processo = etapa.id_etapa_processo
        JOIN DM_KANBAN_COLUNAS coluna ON etapa.id_coluna_kanban = coluna.id_coluna
        LEFT JOIN FT_PROCESSO_TAGS pt ON p.id_processo = pt.id_processo
        LEFT JOIN DM_TAGS t ON pt.id_tag = t.id_tag
        LEFT JOIN FT_DEFERIMENTOS def ON p.id_processo = def.id_processo
        GROUP BY
            p.id_processo, etapa.etapa, p.sub_etapa, coluna.nome_coluna
        ORDER BY
            p.ultima_atualizacao DESC`

	rows, err := database.GormDB_App.Raw(query).Rows()
	if err != nil {
		log.Printf("ERRO NA CONSULTA DO KANBAN: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar processos"})
		return
	}
	defer rows.Close()

	processosAgrupados := make(map[string][]models.Processo)
	totaisPorColuna := make(map[string]float64)

	colunasRows, _ := database.GormDB_App.Raw("SELECT nome_coluna FROM DM_KANBAN_COLUNAS ORDER BY ordem ASC").Rows()
	if colunasRows != nil {
		defer colunasRows.Close()
		for colunasRows.Next() {
			var nomeColuna string
			if err := colunasRows.Scan(&nomeColuna); err == nil {
				processosAgrupados[nomeColuna] = []models.Processo{}
				totaisPorColuna[nomeColuna] = 0.0
			}
		}
	}

	for rows.Next() {
		var p models.Processo
		var deferimento models.Deferimento
		var tagsJSON, enderecoCompleto sql.NullString

		if err := rows.Scan(
			&p.ID, &p.Etapa, &p.SubEtapa, &p.ColunaKanban, &p.UltimaAtualizacao, &p.DataAlerta, &p.Relevancia,
			&p.NomeCliente, &p.UnidadeConsumidora, &p.Concessionaria, &p.ValorEstimado, &enderecoCompleto, &tagsJSON,
			&deferimento.CreditoSimples, &deferimento.CreditoDobro, &p.Suspenso,
		); err != nil {
			log.Printf("Erro ao escanear processo: %v", err)
			continue
		}

		p.Deferimento = &deferimento

		if enderecoCompleto.Valid {
			parts := strings.Split(enderecoCompleto.String, ",")
			if len(parts) >= 2 {
				p.Estado.String = strings.TrimSpace(parts[len(parts)-1])
				p.Estado.Valid = true
			}
			if len(parts) >= 3 {
				p.Cidade.String = strings.TrimSpace(parts[len(parts)-2])
				p.Cidade.Valid = true
			}
		}

		if tagsJSON.Valid && tagsJSON.String != "[]" {
			if err := json.Unmarshal([]byte(tagsJSON.String), &p.Tags); err != nil {
				p.Tags = []models.Tag{}
			}
		} else {
			p.Tags = []models.Tag{}
		}

		nomeColunaKanban := p.ColunaKanban
		if p.Suspenso {
			nomeColunaKanban = "Suspensos"
		}
		if _, ok := processosAgrupados[nomeColunaKanban]; ok {
			processosAgrupados[nomeColunaKanban] = append(processosAgrupados[nomeColunaKanban], p)
			if p.ValorEstimado.Valid {
				totaisPorColuna[nomeColunaKanban] += utils.ToFloat64(p.ValorEstimado.Decimal)
			}
		}
	}

	resposta := KanbanResponse{
		Colunas: processosAgrupados,
		Totais:  totaisPorColuna,
	}
	c.JSON(http.StatusOK, resposta)
}

/* ======================================================================
   Movimentar Processo (etapa/subetapa/relevância + extras)
   ====================================================================== */

func MovimentarProcesso(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do processo inválido"})
		return
	}

	gestorIDValue, _ := c.Get("userID")
	gestorID, _ := gestorIDValue.(int64)
	admin := isAdmin(c)

	type moverReq struct {
		EtapaAtual         *string         `json:"etapa_atual"`
		SubEtapa           *string         `json:"sub_etapa"`
		Comentario         *string         `json:"comentario"`
		Relevancia         *bool           `json:"relevancia"`
		Deferimento        json.RawMessage `json:"deferimento"`
		FluxoRessarcimento json.RawMessage `json:"fluxo_ressarcimento"`
		Faturamento        json.RawMessage `json:"faturamento"`
		Mencoes            json.RawMessage `json:"mencoes"`
		MencoesAccented    json.RawMessage `json:"men\u00e7\u00f5es"`
	}
	var body moverReq

	ctype := strings.ToLower(c.GetHeader("Content-Type"))
	if strings.Contains(ctype, "json") {
		// DEBUG: loga corpo RAW quando JSON
		if bodyBytes, err := io.ReadAll(c.Request.Body); err == nil {
			log.Printf("[DEBUG-MOV-RAW] proc=%d raw=%s", processoID, strings.TrimSpace(string(bodyBytes)))
			c.Request.Body = io.NopCloser(strings.NewReader(string(bodyBytes)))
		}
		_ = c.ShouldBindJSON(&body)
	} else if strings.Contains(ctype, "multipart/form-data") {
		// Força o parse do multipart antes de usar os campos
		if err := c.Request.ParseMultipartForm(50 << 20); err != nil {
			if !strings.Contains(strings.ToLower(err.Error()), "eof") {
				log.Printf("[DEBUG-MOV] ParseMultipartForm aviso: %v", err)
			}
		}
	}

	chooser := func(p *string, v string) string {
		if p != nil {
			return *p
		}
		return v
	}

	// Helper para obter valores de multipart (quando presente) ou cair no PostForm
	getForm := func(name string) string {
		if c.Request != nil && c.Request.MultipartForm != nil {
			if vals, ok := c.Request.MultipartForm.Value[name]; ok && len(vals) > 0 {
				return vals[0]
			}
		}
		return c.PostForm(name)
	}

	hasDeferimentoUpdate := false
	hasFluxoUpdate := false
	hasFaturamentoUpdate := false
	hasValorEstimadoUpdate := false

	// Aceita tanto valor_estimado (legado) quanto ressarcimento_estimado (nome correto da coluna)
	valorEstimadoStr := strings.TrimSpace(getForm("ressarcimento_estimado"))
	if valorEstimadoStr == "" {
		valorEstimadoStr = strings.TrimSpace(getForm("valor_estimado"))
	}
	var valorEstimadoNum sql.NullFloat64
	if valorEstimadoStr != "" {
		clean := strings.ReplaceAll(strings.ReplaceAll(valorEstimadoStr, ".", ""), ",", ".")
		if v, err := strconv.ParseFloat(clean, 64); err == nil {
			valorEstimadoNum.Valid = true
			valorEstimadoNum.Float64 = v
		}
	}

	novaEtapaNome := chooser(body.EtapaAtual, getForm("etapa_atual"))
	if strings.TrimSpace(novaEtapaNome) != "" {
		norm := stripAccentsLower(novaEtapaNome)
		switch norm {
		case "envio ao financeiro", "enviado ao financeiro", "enviado":
			novaEtapaNome = "Enviado ao Financeiro"
		case "validacao":
			// Ajuste: etapa antiga "Validação" passou a se chamar "Enviado ao Financeiro"
			novaEtapaNome = "Enviado ao Financeiro"
		case "concluido":
			novaEtapaNome = "Concluídos"
		case "analise":
			novaEtapaNome = "Análise"
		case "reclamacao":
			novaEtapaNome = "Reclamação"
		case "conciliacao":
			novaEtapaNome = "Conciliação"
		case "contestacao":
			novaEtapaNome = "Contestação"
		case "concluidos":
			novaEtapaNome = "Concluídos"
		case "repasse", "repasse amee":
			novaEtapaNome = "Repasse Amee"
		}
		if strings.EqualFold(strings.TrimSpace(novaEtapaNome), "concluídos") {
			novaEtapaNome = "Concluídos"
		}

		var etapaNomeDB string
		if err := database.GormDB_App.Raw("SELECT etapa FROM DM_ETAPAS_PROCESSO WHERE etapa = ?", novaEtapaNome).Row().Scan(&etapaNomeDB); err == nil {
			novaEtapaNome = etapaNomeDB
		} else {
			colTry := novaEtapaNome
			if strings.EqualFold(colTry, "Fluxo de Ressarcimento") {
				colTry = "Fluxo de Ressarcimento"
			}
			if strings.EqualFold(colTry, "Concluídos") || strings.EqualFold(colTry, "concluidos") {
				colTry = "Concluídos"
			}
			if err2 := database.GormDB_App.Raw(`
				SELECT e.etapa
				  FROM DM_ETAPAS_PROCESSO e
				  JOIN DM_KANBAN_COLUNAS kc ON kc.id_coluna = e.id_coluna_kanban
				 WHERE kc.nome_coluna = ?
			  ORDER BY e.id_etapa_processo ASC
			     LIMIT 1`, colTry).Row().Scan(&etapaNomeDB); err2 == nil {
				novaEtapaNome = etapaNomeDB
			}
		}
	}
	log.Printf("[DEBUG-MOV] proc=%d etapa_resolvida='%s'", processoID, novaEtapaNome)

	novaSubEtapaNome := chooser(body.SubEtapa, getForm("sub_etapa"))
	comentario := chooser(body.Comentario, getForm("comentario"))

	var relevanciaStr string
	var relFromJSON bool
	if body.Relevancia != nil {
		relevanciaStr = fmt.Sprintf("%t", *body.Relevancia)
		relFromJSON = true
	} else {
		relevanciaStr = getForm("relevancia")
	}

	// Log de entrada para depuração
	log.Printf("[DEBUG-MOV-IN] proc=%d ctype='%s' etapa_post='%s' sub_post='%s' relevancia='%s' comentario='%s'",
		processoID, ctype, getForm("etapa_atual"), getForm("sub_etapa"), relevanciaStr, strings.TrimSpace(comentario))

	deferimentoJSON := string(body.Deferimento)
	if deferimentoJSON == "" {
		deferimentoJSON = getForm("deferimento")
	}
	fluxoRessarcimentoJSON := string(body.FluxoRessarcimento)
	if fluxoRessarcimentoJSON == "" {
		fluxoRessarcimentoJSON = getForm("fluxo_ressarcimento")
	}
	faturamentoJSON := string(body.Faturamento)
	if faturamentoJSON == "" {
		faturamentoJSON = getForm("faturamento")
	}

	// aceita tanto "menções" quanto "mencoes" vindos de form-data
	var mencoesJSON string
	mencoesJSON = getForm("men\u00e7\u00f5es")
	if strings.TrimSpace(mencoesJSON) == "" {
		mencoesJSON = getForm("mencoes")
	}

	tx := database.GormDB_App.Begin()
	if tx.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao iniciar transação"})
		return
	}
	defer tx.Rollback()

	// Estado atual
	var etapaAnteriorNome, subEtapaAnterior sql.NullString
	var relevanciaAnterior sql.NullBool
	if err := queryRowGorm(tx, `
		SELECT etapa.etapa, p.sub_etapa, p.relevancia
		  FROM FT_PROCESSOS p
		  JOIN DM_ETAPAS_PROCESSO etapa ON p.id_etapa_processo = etapa.id_etapa_processo
		 WHERE p.id_processo = ?`, processoID).Scan(&etapaAnteriorNome, &subEtapaAnterior, &relevanciaAnterior); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Processo ou etapa anterior não encontrado"})
		return
	}

	// Mudanças detectadas
	etapaMudou := strings.TrimSpace(novaEtapaNome) != "" && novaEtapaNome != etapaAnteriorNome.String
	subProvided := strings.TrimSpace(novaSubEtapaNome) != ""
	subMudou := subProvided && (novaSubEtapaNome != subEtapaAnterior.String)
	relNovo, relProvided := parseBoolLoose(relevanciaStr)
	if relFromJSON {
		relProvided = true
	}
	relMudou := relProvided && (!relevanciaAnterior.Valid || relevanciaAnterior.Bool != relNovo)

	// Atualiza relevância, se enviada
	if relProvided {
		if _, err = execGorm(tx, "UPDATE FT_PROCESSOS SET relevancia = ? WHERE id_processo = ?", relNovo, processoID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao atualizar relevância do processo"})
			return
		}
		// Mantém snapshot alinhado para evitar rollback via sync
		if _, err = execGorm(tx, "UPDATE FT_PROCESSO_SNAPSHOT SET relevancia = ? WHERE id_processo = ?", relNovo, processoID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao atualizar relevância do snapshot"})
			return
		}
	}

	// Atualiza etapa/subetapa no processo (apenas quando mudou algo)
	if etapaMudou || subMudou {
		setClauses := make([]string, 0, 3)
		args := make([]interface{}, 0, 3)

		if etapaMudou {
			var novaEtapaID int
			if err = queryRowGorm(tx, "SELECT id_etapa_processo FROM DM_ETAPAS_PROCESSO WHERE etapa = ?", novaEtapaNome).Scan(&novaEtapaID); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "O nome da etapa fornecida é inválido: " + novaEtapaNome})
				return
			}
			setClauses = append(setClauses, "id_etapa_processo = ?")
			args = append(args, novaEtapaID)
			setClauses = append(setClauses, "etapa = ?")
			args = append(args, novaEtapaNome)

			var colID sql.NullInt64
			var colNome sql.NullString
			_ = queryRowGorm(tx, `
				SELECT k.id_coluna, k.nome_coluna
				  FROM DM_ETAPAS_PROCESSO e
				  JOIN DM_KANBAN_COLUNAS k ON k.id_coluna = e.id_coluna_kanban
				 WHERE e.id_etapa_processo = ?`,
				novaEtapaID,
			).Scan(&colID, &colNome)
			if strings.EqualFold(strings.TrimSpace(novaEtapaNome), "Concluídos") {
				colID = sql.NullInt64{Int64: 5, Valid: true}
				colNome = sql.NullString{String: "Concluídos", Valid: true}
			}
			setClauses = append(setClauses, "id_coluna = ?")
			if colID.Valid {
				args = append(args, colID.Int64)
			} else {
				args = append(args, nil)
			}
			setClauses = append(setClauses, "nome_coluna = ?")
			if colNome.Valid {
				args = append(args, colNome.String)
			} else {
				args = append(args, nil)
			}
		}
		if subMudou {
			setClauses = append(setClauses, "sub_etapa = ?")
			args = append(args, novaSubEtapaNome)
			subID, _ := resolveSubEtapaIDGorm(tx, novaSubEtapaNome)
			setClauses = append(setClauses, "id_sub_etapa_processo = ?")
			args = append(args, nullIntToIface(subID))
		}
		setClauses = append(setClauses, "ultima_atualizacao = NOW()")

		if len(setClauses) > 0 {
			query := fmt.Sprintf("UPDATE FT_PROCESSOS SET %s WHERE id_processo = ?", strings.Join(setClauses, ", "))
			args = append(args, processoID)
			if _, err2 := execGorm(tx, query, args...); err2 != nil {
				log.Printf("[DEBUG-MOV] proc=%d falha UPDATE: %v | query=%s | args=%v", processoID, err2, query, args)
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao atualizar etapa/sub-etapa do processo"})
				return
			}
		}

		// Se houve movimentação manual sem atualização de dados (defer/fluxo/fat),
		// aplica regra automática para alinhar coluna com os dados já existentes.
		if !hasDeferimentoUpdate && !hasFluxoUpdate && !hasFaturamentoUpdate {
			if err := updateColunaByData(tx, processoID, gestorID); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao recalcular coluna do processo"})
				return
			}
		}
	}

	if valorEstimadoNum.Valid {
		// Coluna existe em FT_REQUISICOES (id_requisicao = id_processo)
		if _, err2 := execGorm(tx, 
			"UPDATE FT_REQUISICOES SET ressarcimento_estimado = ? WHERE id_requisicao = ?",
			valorEstimadoNum.Float64, processoID,
		); err2 != nil {
			log.Printf("Erro ao atualizar ressarcimento_estimado da requisicao %d: %v", processoID, err2)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao salvar ressarcimento estimado"})
			return
		}
		hasValorEstimadoUpdate = true
	}

	// Deferimento (aceita números com vírgula como decimal no JSON)
	if strings.TrimSpace(deferimentoJSON) != "" {
		var m map[string]interface{}
		if err := json.Unmarshal([]byte(deferimentoJSON), &m); err == nil {
			toDecimal := func(v interface{}) decimal.Decimal {
				switch t := v.(type) {
				case float64:
					return decimal.NewFromFloat(t)
				case json.Number:
					if f, e := t.Float64(); e == nil {
						return decimal.NewFromFloat(f)
					}
				case string:
					s := strings.TrimSpace(t)
					s = strings.ReplaceAll(s, ".", "")
					s = strings.ReplaceAll(s, ",", ".")
					if d, e := decimal.NewFromString(s); e == nil {
						return d
					}
				}
				return decimal.Zero
			}
			dataProcedencia := strings.TrimSpace(cast.ToString(m["data_procedencia"]))
			dataCreditoDobro := strings.TrimSpace(cast.ToString(m["data_credito_dobro"]))
			cs := toDecimal(m["credito_simples"])
			cd := toDecimal(m["credito_dobro"])
			hasData := dataProcedencia != "" || dataCreditoDobro != "" || cs.Sign() != 0 || cd.Sign() != 0
			if hasData {
				hasDeferimentoUpdate = true
				q := `INSERT INTO FT_DEFERIMENTOS (id_processo, data_procedencia, credito_simples, credito_dobro, data_credito_dobro)
                      VALUES (?, ?, ?, ?, NULLIF(?, ''))
                      ON DUPLICATE KEY UPDATE 
                      data_procedencia   = VALUES(data_procedencia), 
                      credito_simples    = VALUES(credito_simples), 
                      credito_dobro      = VALUES(credito_dobro),
                      data_credito_dobro = VALUES(data_credito_dobro)`
				if _, err = execGorm(tx, q, processoID, dataProcedencia, cs, cd, dataCreditoDobro); err != nil {
					log.Printf("Erro ao salvar deferimento no processo %d: %v", processoID, err)
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao salvar dados de deferimento."})
					return
				}
			}
		}
	}
	// Se houve deferimento e nenhuma sub-etapa foi informada, força a sub-etapa inicial de conciliação.
	if hasDeferimentoUpdate && !subProvided {
		desiredSub := "Em conciliação - Em elaboração"
		if strings.TrimSpace(subEtapaAnterior.String) != desiredSub {
			novaSubEtapaNome = desiredSub
			subProvided = true
			subMudou = true
			subID, _ := resolveSubEtapaIDGorm(tx, novaSubEtapaNome)
			if _, err = execGorm(tx, 
				`UPDATE FT_PROCESSOS
				 SET sub_etapa = ?, id_sub_etapa_processo = ?, ultima_atualizacao = NOW()
				 WHERE id_processo = ?`,
				novaSubEtapaNome, nullIntToIface(subID), processoID,
			); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao atualizar sub-etapa do processo"})
				return
			}
		}
	}

	// Fluxo de Ressarcimento
	if strings.TrimSpace(fluxoRessarcimentoJSON) != "" {
		if err = salvarFluxoRessarcimentoInterno(processoID, fluxoRessarcimentoJSON, tx); err != nil {
			log.Printf("Erro ao salvar fluxo de ressarcimento: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao salvar dados de fluxo de ressarcimento."})
			return
		}
		hasFluxoUpdate = true
	}

	// Faturamento
	if strings.TrimSpace(faturamentoJSON) != "" {
		if err = salvarFaturamentoInterno(processoID, faturamentoJSON, tx); err != nil {
			log.Printf("Erro ao salvar faturamento: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao salvar dados de faturamento."})
			return
		}
		hasFaturamentoUpdate = true
	}

	// Recalcula coluna/etapa automática pela regra (prioriza estágio mais avançado)
	if hasDeferimentoUpdate || hasFluxoUpdate || hasFaturamentoUpdate {
		if err := updateColunaByData(tx, processoID, gestorID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao atualizar coluna do processo"})
			return
		}
	}

	// =====================================================================
	// Histórico — mantém registro quando houver mudança ou comentário
	// =====================================================================
	willInsertHist := etapaMudou || subMudou || relMudou || strings.TrimSpace(comentario) != "" ||
		hasValorEstimadoUpdate || hasDeferimentoUpdate || hasFluxoUpdate || hasFaturamentoUpdate
	log.Printf("[DEBUG-MOV-HIST-COND] proc=%d etapaMudou=%t subMudou=%t relMudou=%t comentario_vazio=%t",
		processoID, etapaMudou, subMudou, relMudou, strings.TrimSpace(comentario) == "")

	// Coleta canais selecionados do formulário (JSON no campo 'canais')
	canaisJSON := getForm("canais")
	var canaisSelecionados []string
	if strings.TrimSpace(canaisJSON) != "" {
		var tmp []string
		if err := json.Unmarshal([]byte(canaisJSON), &tmp); err == nil {
			allowed := map[string]bool{"whatsapp": true, "ligacao": true, "email": true, "sms": true, "site": true, "pessoal": true}
			for _, cNome := range tmp {
				n := strings.ToLower(strings.TrimSpace(cNome))
				if allowed[n] {
					canaisSelecionados = append(canaisSelecionados, n)
				}
			}
		}
	}

	// Efetivos (se não veio etapa/subetapa nova, reaproveita a anterior)
	etapaNovaNomeEfetiva := etapaAnteriorNome.String
	if strings.TrimSpace(novaEtapaNome) != "" {
		etapaNovaNomeEfetiva = novaEtapaNome
	}
	subEtapaNovaEfetiva := strings.TrimSpace(novaSubEtapaNome)
	if subEtapaNovaEfetiva == "" {
		subEtapaNovaEfetiva = strings.TrimSpace(subEtapaAnterior.String)
	}

	// "Etapa - Subetapa"
	statusAnterior := etapaAnteriorNome.String
	if s := strings.TrimSpace(subEtapaAnterior.String); s != "" {
		statusAnterior = statusAnterior + " - " + s
	}
	statusNovo := etapaNovaNomeEfetiva
	if s := strings.TrimSpace(subEtapaNovaEfetiva); s != "" {
		statusNovo = statusNovo + " - " + s
	}

	// relevância (mantém compatibilidade)
	var relAnt, relNov interface{}
	if relMudou {
		if relevanciaAnterior.Valid {
			relAnt = relevanciaAnterior.Bool
		}
		relNov = relNovo
	}

	// tipo de movimentação (admin não deve contar na última movimentação e ser filtrado na VIEW)
	tipoMov := "movimentacao"
	if admin {
		tipoMov = "admin"
	}

	if willInsertHist {
		res, err2 := execGorm(tx, `
			INSERT INTO FT_HISTORICO_MOVIMENTACOES
			  (id_requisicao, id_usuario_gestor, status_anterior, status_novo,
			   etapa_anterior, etapa_nova, sub_etapa,
			   relevancia_anterior, relevancia_nova, comentario,
			   data_movimentacao, justificativa_atraso, tipo_movimentacao)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NULL, ?)`,
			processoID, gestorID,
			statusAnterior, statusNovo,
			etapaAnteriorNome.String, etapaNovaNomeEfetiva, subEtapaNovaEfetiva,
			relAnt, relNov,
			strings.TrimSpace(comentario),
			tipoMov,
		)
		if err2 != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao salvar movimentação no histórico"})
			return
		}

		// Vincula canais selecionados ao registro de histórico criado
		if len(canaisSelecionados) > 0 {
			if lastID, e2 := res.LastInsertId(); e2 == nil {
				for _, nome := range canaisSelecionados {
					if _, e3 := execGorm(tx, 
						`INSERT INTO FT_HISTORICO_CANAIS (id_historico, id_canal)
								SELECT ?, id_canal FROM DM_CANAIS_COMUNICACAO WHERE nome = ?`,
						lastID, nome,
					); e3 != nil {
						log.Printf("[WARN] Falha ao vincular canal '%s' ao historico %d: %v", nome, lastID, e3)
					}
				}
			}
		}

		// Sinaliza via SSE o update (sub-etapa)
		go func(pid int) {
			defer func() { recover() }()
			payload := map[string]interface{}{
				"sub_etapa": strings.TrimSpace(subEtapaNovaEfetiva),
			}
			sse.Broadcast(pid, sse.Event{Type: "processo_update", ProcessoID: pid, Payload: payload})
		}(processoID)

		// Regra: se etapa for Fluxo de Ressarcimento e subetapa for "Enviado",
		// avança automaticamente para a próxima coluna do Kanban (Faturamento)
		if os.Getenv("AUTO_ADVANCE_ENABLED") == "1" &&
			strings.EqualFold(strings.TrimSpace(etapaNovaNomeEfetiva), "Fluxo de Ressarcimento") &&
			(strings.EqualFold(strings.TrimSpace(subEtapaNovaEfetiva), "Enviado") ||
				strings.EqualFold(strings.TrimSpace(subEtapaNovaEfetiva), "Enviado ao Faturamento") ||
				strings.EqualFold(strings.TrimSpace(etapaNovaNomeEfetiva), "Enviado ao Financeiro")) {

			// Descobre etapa destino na coluna Faturamento
			var nextEtapaNome string
			_ = queryRowGorm(tx, `
					SELECT e.etapa
					  FROM DM_ETAPAS_PROCESSO e
					  JOIN DM_KANBAN_COLUNAS kc ON kc.id_coluna = e.id_coluna_kanban
					 WHERE kc.nome_coluna = 'Faturamento'
					 ORDER BY e.id_etapa_processo ASC
					 LIMIT 1`).Scan(&nextEtapaNome)
			if strings.TrimSpace(nextEtapaNome) == "" {
				nextEtapaNome = "Faturamento"
			}
			var nextEtapaID int
			if err2 := queryRowGorm(tx, "SELECT id_etapa_processo FROM DM_ETAPAS_PROCESSO WHERE etapa = ? LIMIT 1", nextEtapaNome).Scan(&nextEtapaID); err2 == nil && nextEtapaID > 0 {
				var colID sql.NullInt64
				var colNome sql.NullString
				_ = queryRowGorm(tx, `
					SELECT k.id_coluna, k.nome_coluna
					  FROM DM_ETAPAS_PROCESSO e
					  JOIN DM_KANBAN_COLUNAS k ON k.id_coluna = e.id_coluna_kanban
					 WHERE e.id_etapa_processo = ?`,
					nextEtapaID,
				).Scan(&colID, &colNome)
				_, _ = execGorm(tx, 
					`UPDATE FT_PROCESSOS
					 SET id_etapa_processo = ?, sub_etapa = NULL, id_sub_etapa_processo = NULL,
					     id_coluna = ?, nome_coluna = ?, ultima_atualizacao = NOW()
					 WHERE id_processo = ?`,
					nextEtapaID,
					func() interface{} { if colID.Valid { return colID.Int64 }; return nil }(),
					func() interface{} { if colNome.Valid { return colNome.String }; return nil }(),
					processoID,
				)
				// Insere histórico de avanço automático
				_, _ = execGorm(tx, `
						INSERT INTO FT_HISTORICO_MOVIMENTACOES (
						  id_requisicao, id_usuario_gestor, status_anterior, status_novo,
						  etapa_anterior, etapa_nova, sub_etapa,
						  relevancia_anterior, relevancia_nova, comentario, data_movimentacao, justificativa_atraso, tipo_movimentacao)
						VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'Avanço automático: Enviado', NOW(), NULL, 'auto')`,
					processoID, gestorID,
					statusNovo, nextEtapaNome,
					etapaNovaNomeEfetiva, nextEtapaNome,
				)
				// Broadcast mudança de coluna
				go func(pid int) {
					defer func() { recover() }()
					sse.Broadcast(pid, sse.Event{Type: "processo_update", ProcessoID: pid, Payload: map[string]any{"etapa": nextEtapaNome}})
				}(processoID)
			}
		}

		// Menções -> Alertas
		if len(body.Mencoes) > 0 {
			mencoesJSON = string(body.Mencoes)
		} else if len(body.MencoesAccented) > 0 {
			mencoesJSON = string(body.MencoesAccented)
		}
		if strings.TrimSpace(mencoesJSON) != "" {
			var mencoesIDs []int64
			if err := json.Unmarshal([]byte(mencoesJSON), &mencoesIDs); err == nil && len(mencoesIDs) > 0 {
				msgComent := strings.TrimSpace(comentario)
				if len(msgComent) > 140 {
					msgComent = msgComent[:140] + "..."
				}
				var gestorNome string
				if v, ok := c.Get("userName"); ok {
					if s, ok2 := v.(string); ok2 {
						gestorNome = s
					}
				}
				if gestorNome == "" {
					gestorNome = "um gestor"
				}
				alertaMsg := fmt.Sprintf("Você foi mencionado no processo PROC-%d por %s. comentário: %s", processoID, gestorNome, msgComent)

				for _, uid := range mencoesIDs {
					if _, err := execGorm(tx, `
					INSERT INTO FT_ALERTAS (id_usuario, id_processo, mensagem, lido, data_criacao)
					VALUES (?, ?, ?, 0, NOW())`,
						uid, processoID, alertaMsg,
					); err != nil {
						log.Printf("Erro ao criar alerta de menção (proc=%d, user=%d): %v", processoID, uid, err)
						c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao criar alertas de menções"})
						return
					}
					// SSE: novo alerta + atualiza contagem para o usuário mencionado
					sse.BroadcastUser(uid, sse.Event{
						Type: "alerta_novo",
						Payload: gin.H{
							"processo_id": processoID,
						},
					})
					notifyUnread(uid)
				}
			}
		}

		// Uploads (anexos)
		if form, err := c.MultipartForm(); err == nil {
			files := form.File["anexos"]
			if len(files) > 0 {
				_ = os.MkdirAll("uploads/", os.ModePerm)
				for _, file := range files {
					filename := filepath.Base(file.Filename)
						filePath := filepath.Join("uploads/", fmt.Sprintf("%d-gestor-%d-%s", processoID, time.Now().Unix(), filename))
					if err := c.SaveUploadedFile(file, filePath); err != nil {
						log.Printf("[MOV-ANEXO] save error (proc=%d file=%s): %v", processoID, filename, err)
						c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao salvar anexo do gestor"})
						return
					}
					if _, err := execGorm(tx,
						"INSERT INTO FT_ANEXOS (id_requisicao, nome_arquivo, caminho_arquivo, enviado_por) VALUES (?, ?, ?, 'gestor')",
						processoID, filename, filePath,
					); err != nil {
						log.Printf("[MOV-ANEXO] insert error (proc=%d file=%s): %v", processoID, filename, err)
						c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao registrar anexo no banco"})
						return
					}
				}
			}
		}
	}

	// Commit (mesmo se não tiver histórico — evita handler sem resposta)
	if err := tx.Commit().Error; err != nil {
    log.Printf("[DEBUG-MOV] commit error (proc=%d): %v", processoID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao finalizar a transação"})
		return
	}

	// Descobre coluna Kanban (robusto com fallback)
	var colID int
	var colNome string
	if err := database.GormDB_App.Raw(`
		SELECT kc.id_coluna, kc.nome_coluna
		  FROM FT_PROCESSOS p
		  JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
		  JOIN DM_KANBAN_COLUNAS kc ON kc.id_coluna = e.id_coluna_kanban
		 WHERE p.id_processo = ?`, processoID).Row().Scan(&colID, &colNome); err != nil {

		colunaID := mapColunaID(func() string {
			if strings.TrimSpace(novaEtapaNome) != "" {
				return novaEtapaNome
			}
			return etapaAnteriorNome.String
		}())

		c.JSON(http.StatusOK, gin.H{
			"message":            "Processo atualizado com sucesso!",
			"coluna_kanban_id":   colunaID,
			"coluna_kanban_nome": mapColunaNomeByID(colunaID),
			"sub_etapa":          strings.TrimSpace(novaSubEtapaNome),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":            "Processo atualizado com sucesso!",
		"coluna_kanban_id":   colID,
		"coluna_kanban_nome": colNome,
		"sub_etapa":          strings.TrimSpace(novaSubEtapaNome),
	})

	// Notifica via SSE (após resposta)
	go func(pid int, idCol int, nomeCol string) {
		defer func() { recover() }()
		payload := map[string]interface{}{
			"coluna_kanban_id":   idCol,
			"coluna_kanban_nome": nomeCol,
			"sub_etapa":          strings.TrimSpace(novaSubEtapaNome),
			"status_composto": func() string {
				s := ""
				if strings.TrimSpace(novaEtapaNome) != "" {
					s = strings.TrimSpace(novaEtapaNome)
				} else {
					s = strings.TrimSpace(etapaAnteriorNome.String)
				}
				if se := strings.TrimSpace(novaSubEtapaNome); se != "" {
					s = s + " - " + se
				} else if se2 := strings.TrimSpace(subEtapaAnterior.String); se2 != "" {
					s = s + " - " + se2
				}
				return s
			}(),
		}
		sse.Broadcast(pid, sse.Event{Type: "processo_update", ProcessoID: pid, Payload: payload})
	}(processoID, colID, colNome)
}

func parseHistIDFromPath(path string) (int64, bool) {
	clean := filepath.ToSlash(strings.TrimSpace(path))
	if clean == "" {
		return 0, false
	}
	pos := strings.Index(clean, "hist-")
	if pos < 0 {
		return 0, false
	}
	start := pos + len("hist-")
	end := start
	for end < len(clean) {
		c := clean[end]
		if c < '0' || c > '9' {
			break
		}
		end++
	}
	if end == start {
		return 0, false
	}
	id, err := strconv.ParseInt(clean[start:end], 10, 64)
	if err != nil {
		return 0, false
	}
	return id, true
}

func GetHistoricoMovimentacoes(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id")) // id da requisição/processo

	type AnexoOut struct {
		Nome       string `json:"nome"`
		URL        string `json:"url"`
		DataUpload string `json:"data_upload,omitempty"`
	}


	rows, err := queryGorm(database.GormDB_App, `
        SELECT
            h.id_historico,
            h.id_usuario_gestor,
            h.status_anterior,
            h.status_novo,
            h.etapa_anterior,
            h.etapa_nova,
            h.sub_etapa,
            h.relevancia_anterior,
            h.relevancia_nova,
            h.comentario,
            h.justificativa_atraso,
            h.data_movimentacao,
            h.tipo_movimentacao,
            u.nome_usuario AS usuario_nome,
            GROUP_CONCAT(LOWER(TRIM(dc.nome)) ORDER BY dc.nome SEPARATOR ',') AS canais_csv
        FROM FT_HISTORICO_MOVIMENTACOES h
        LEFT JOIN DM_USUARIO u ON u.id_usuario = h.id_usuario_gestor
        LEFT JOIN FT_HISTORICO_CANAIS hc ON hc.id_historico = h.id_historico
        LEFT JOIN DM_CANAIS_COMUNICACAO dc ON dc.id_canal = hc.id_canal
        WHERE h.id_requisicao = ?
        GROUP BY
            h.id_historico,
            h.id_usuario_gestor,
            h.status_anterior,
            h.status_novo,
            h.etapa_anterior,
            h.etapa_nova,
            h.sub_etapa,
            h.relevancia_anterior,
            h.relevancia_nova,
            h.comentario,
            h.justificativa_atraso,
            h.data_movimentacao,
            h.tipo_movimentacao,
            u.nome_usuario
        ORDER BY h.data_movimentacao DESC, h.id_historico DESC
    `, id)
	if err != nil {
		log.Printf("[HIST] query error (req=%d): %v", id, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar histórico"})
		return
	}
	defer rows.Close()

	type Item struct {
		ID               int64     `json:"id_historico"`
		GestorID         int64     `json:"id_usuario_gestor"`
		StatusAnt        *string   `json:"status_anterior"`
		StatusNovo       *string   `json:"status_novo"`
		StatusComp       string    `json:"status_composto"`
		EtapaAnt         *string   `json:"etapa_anterior"`
		EtapaNova        *string   `json:"etapa_nova"`
		SubEtapa         *string   `json:"sub_etapa"`
		RelAnt           *bool     `json:"relevancia_anterior"`
		RelNova          *bool     `json:"relevancia_nova"`
		Comentario       *string   `json:"comentario"`
		JustAtraso       *string   `json:"justificativa_atraso"`
		DataMov          *time.Time `json:"data_movimentacao,omitempty"`
		TipoMov          *string   `json:"tipo_movimentacao,omitempty"`
		Canais           []string  `json:"canais,omitempty"`
		CanalComunicacao string    `json:"canal_comunicacao,omitempty"`
		UsuarioNome      *string   `json:"usuario_nome,omitempty"`
		Anexos           []AnexoOut `json:"anexos,omitempty"`
	}
	var out []Item

	for rows.Next() {
		var it Item
		var relAnt, relNov sql.NullBool
		var canaisCSV sql.NullString
		var usuarioNome sql.NullString
		var tipoMov sql.NullString
		var dataMov sql.NullTime
		if err := rows.Scan(
			&it.ID, &it.GestorID, &it.StatusAnt, &it.StatusNovo,
			&it.EtapaAnt, &it.EtapaNova, &it.SubEtapa,
			&relAnt, &relNov, &it.Comentario, &it.JustAtraso, &dataMov,
			&tipoMov, &usuarioNome, &canaisCSV,
		); err == nil {
			if relAnt.Valid {
				v := relAnt.Bool
				it.RelAnt = &v
			}
			if relNov.Valid {
				v := relNov.Bool
				it.RelNova = &v
			}
			if usuarioNome.Valid {
				v := usuarioNome.String
				it.UsuarioNome = &v
			}
			if tipoMov.Valid {
				v := strings.TrimSpace(tipoMov.String)
				it.TipoMov = &v
			}
			if dataMov.Valid {
				v := dataMov.Time
				it.DataMov = &v
			}

			// status_composto (sempre Etapa - Subetapa)
			var sc string
			if it.EtapaNova != nil {
				sc = *it.EtapaNova
			}
			if it.SubEtapa != nil && *it.SubEtapa != "" {
				sc = sc + " - " + *it.SubEtapa
			}
			it.StatusComp = sc

			// Canais agregados na query (GROUP_CONCAT) -> normaliza, deduplica e ordena
			if canaisCSV.Valid && strings.TrimSpace(canaisCSV.String) != "" {
				parts := strings.Split(canaisCSV.String, ",")
				m := make(map[string]struct{}, len(parts))
				clean := make([]string, 0, len(parts))
				for _, raw := range parts {
					v := strings.ToLower(strings.TrimSpace(raw))
					if v == "" {
						continue
					}
					if _, ok := m[v]; ok {
						continue
					}
					m[v] = struct{}{}
					clean = append(clean, v)
				}
				sort.Strings(clean)
				if len(clean) > 0 {
					it.Canais = clean
					it.CanalComunicacao = strings.Join(clean, ", ")
				}
			}
			// Fallback também atualiza StatusNovo se vier vazio
			if (it.StatusNovo == nil || *it.StatusNovo == "") && sc != "" {
				it.StatusNovo = &sc
			}
		}
		out = append(out, it)
	}
	if out == nil {
		out = make([]Item, 0)
	}
	// Carrega anexos do processo e tenta associar ao historico por proximidade de data
	type anexoDB struct {
		Nome   string
		Caminho string
	HistID  sql.NullInt64
		Data   sql.NullTime
	}
	anexosDB := make([]anexoDB, 0)
	if rowsA, errA := queryGorm(database.GormDB_App, `
		SELECT nome_arquivo, caminho_arquivo, data_upload
		  FROM FT_ANEXOS
		 WHERE id_requisicao = ?
		 ORDER BY data_upload DESC`, id); errA == nil {
		defer rowsA.Close()
		for rowsA.Next() {
			var a anexoDB
			if err := rowsA.Scan(&a.Nome, &a.Caminho, &a.Data); err == nil {
				if id, ok := parseHistIDFromPath(a.Caminho); ok { a.HistID = sql.NullInt64{Int64: id, Valid: true} }
				anexosDB = append(anexosDB, a)
			}
		}
	} else if rowsA, errA := queryGorm(database.GormDB_App, `
		SELECT nome_arquivo, caminho_arquivo, NULL
		  FROM FT_ANEXOS
		 WHERE id_requisicao = ?`, id); errA == nil {
		defer rowsA.Close()
		for rowsA.Next() {
			var a anexoDB
			if err := rowsA.Scan(&a.Nome, &a.Caminho, &a.Data); err == nil {
				if id, ok := parseHistIDFromPath(a.Caminho); ok { a.HistID = sql.NullInt64{Int64: id, Valid: true} }
				anexosDB = append(anexosDB, a)
			}
		}
	}
	if len(anexosDB) > 0 && len(out) > 0 {
		attached := make([][]AnexoOut, len(out))
		idIndex := make(map[int64]int, len(out))
		for i, it := range out {
			if it.ID > 0 {
				idIndex[it.ID] = i
			}
		}
		for _, a := range anexosDB {
			if a.HistID.Valid {
				if idx, ok := idIndex[a.HistID.Int64]; ok {
					an := AnexoOut{
						Nome: a.Nome,
						URL:  a.Caminho,
					}
					if a.Data.Valid {
						an.DataUpload = a.Data.Time.Format("2006-01-02 15:04:05")
					}
					attached[idx] = append(attached[idx], an)
					continue
				}
			}
			targetIdx := 0
			if a.Data.Valid {
				minDiff := time.Duration(1<<63 - 1)
				for i, it := range out {
					if it.DataMov == nil {
						continue
					}
					diff := it.DataMov.Sub(a.Data.Time)
					if diff < 0 {
						diff = -diff
					}
					if diff < minDiff {
						minDiff = diff
						targetIdx = i
					}
				}
			}
			an := AnexoOut{
				Nome: a.Nome,
				URL:  a.Caminho,
			}
			if a.Data.Valid {
				an.DataUpload = a.Data.Time.Format("2006-01-02 15:04:05")
			}
			attached[targetIdx] = append(attached[targetIdx], an)
		}
		for i := range out {
			if len(attached[i]) > 0 {
				out[i].Anexos = attached[i]
			}
		}
	}

	// Prepend: criação da requisição como primeiro item do histórico
	// Busca data_criacao e, opcionalmente, nome do criador
	var createdAt time.Time
	var creator sql.NullString
	if err := queryRowGorm(database.GormDB_App, `
        SELECT r.data_criacao, COALESCE(u.nome_usuario,'')
          FROM FT_REQUISICOES r
          LEFT JOIN DM_USUARIO u ON u.id_usuario = r.id_usuario
         WHERE r.id_requisicao = ?
         LIMIT 1`, id).Scan(&createdAt, &creator); err == nil && !createdAt.IsZero() {

		nomePtr := (*string)(nil)
		if creator.Valid {
			v := creator.String
			nomePtr = &v
		}

		created := Item{
			ID:               0,
			GestorID:         0,
			StatusAnt:        nil,
			StatusNovo:       strPtr("Pendente"),
			StatusComp:       "Pendente",
			EtapaAnt:         nil,
			EtapaNova:        strPtr("Pendente"),
			SubEtapa:         nil,
			RelAnt:           nil,
			RelNova:          nil,
			Comentario:       strPtr("Criação da requisição"),
			JustAtraso:       nil,
			DataMov:          &createdAt,
			TipoMov:          strPtr("criacao"),
			Canais:           nil,
			CanalComunicacao: "",
			UsuarioNome:      nomePtr,
		}
		out = append([]Item{created}, out...)
	}

	// Concatena canais ao status_composto (rótulo único) quando disponível
	for i := range out {
		if len(out[i].Canais) > 0 {
			sc, sn, canaisOut, canalStr := normalizeAndAppendCanais(out[i].StatusComp, out[i].StatusNovo, out[i].Canais)
			out[i].StatusComp = sc
			out[i].StatusNovo = sn
			out[i].Canais = canaisOut
			out[i].CanalComunicacao = canalStr
		}
	}

	c.JSON(http.StatusOK, out)
}

// POST /processos/:id/historico/:hid/anexos
func AddHistoricoAnexo(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do processo inválido"})
		return
	}
	histID, err := strconv.Atoi(c.Param("hid"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do histórico inválido"})
		return
	}

	var histTime sql.NullTime
	_ = queryRowGorm(database.GormDB_App,
		"SELECT data_movimentacao FROM FT_HISTORICO_MOVIMENTACOES WHERE id_historico = ? AND id_requisicao = ?",
		histID, processoID,
	).Scan(&histTime)
	if !histTime.Valid {
		histTime = sql.NullTime{Time: time.Now(), Valid: true}
	}

	if err := c.Request.ParseMultipartForm(50 << 20); err != nil {
		log.Printf("[HIST-ANEXO] parse multipart error (proc=%d hist=%d): %v", processoID, histID, err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Falha ao ler anexos"})
		return
	}
	form := c.Request.MultipartForm
	if form == nil {
		log.Printf("[HIST-ANEXO] multipart form vazia (proc=%d hist=%d)", processoID, histID)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Formulario de anexos vazio"})
		return
	}
	files := form.File["anexos"]
	if len(files) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Nenhum anexo enviado"})
		return
	}

	tx := database.GormDB_App.Begin()
	if tx.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao iniciar transação"})
		return
	}
	defer tx.Rollback()

	_ = os.MkdirAll("uploads/", os.ModePerm)
	for _, file := range files {
		filename := filepath.Base(file.Filename)
		dir := filepath.Join("uploads", fmt.Sprintf("hist-%d", histID))
		_ = os.MkdirAll(dir, os.ModePerm)
		filePath := filepath.Join(dir, fmt.Sprintf("%d-gestor-%d-%s", processoID, time.Now().Unix(), filename))
		if err := c.SaveUploadedFile(file, filePath); err != nil {
			log.Printf("[HIST-ANEXO] save error (proc=%d hist=%d file=%s): %v", processoID, histID, filename, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao salvar anexo"})
			return
		}
		_, err := execGorm(tx, 
			"INSERT INTO FT_ANEXOS (id_requisicao, nome_arquivo, caminho_arquivo, enviado_por, data_upload) VALUES (?, ?, ?, 'gestor', ?)",
			processoID, filename, filePath, histTime.Time,
		)
		if err != nil {
			log.Printf("[HIST-ANEXO] insert error (proc=%d hist=%d file=%s): %v", processoID, histID, filename, err)
			// Fallback: coluna data_upload pode não existir
			if _, err2 := execGorm(tx, 
				"INSERT INTO FT_ANEXOS (id_requisicao, nome_arquivo, caminho_arquivo, enviado_por) VALUES (?, ?, ?, 'gestor')",
				processoID, filename, filePath,
			); err2 != nil {
				log.Printf("[HIST-ANEXO] insert fallback error (proc=%d hist=%d file=%s): %v", processoID, histID, filename, err2)
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao registrar anexo"})
				return
			}
		}
	}

	if err := tx.Commit().Error; err != nil {
		log.Printf("[HIST-ANEXO] commit error (proc=%d hist=%d): %v", processoID, histID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao finalizar a transação"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// normalizeAndAppendCanais normaliza (lower+trim), deduplica e ordena os canais;
// retorna status_composto/status_novo atualizados com sufixo " via ..." e os
// campos de canais tratados.
func normalizeAndAppendCanais(statusComp string, statusNovo *string, canais []string) (string, *string, []string, string) {
	// normaliza + dedup
	m := map[string]struct{}{}
	clean := make([]string, 0, len(canais))
	for _, raw := range canais {
		v := strings.ToLower(strings.TrimSpace(raw))
		if v == "" {
			continue
		}
		if _, ok := m[v]; ok {
			continue
		}
		m[v] = struct{}{}
		clean = append(clean, v)
	}
	sort.Strings(clean)
	if len(clean) == 0 {
		return statusComp, statusNovo, canais, ""
	}
	joined := strings.Join(clean, ", ")
	via := " via " + joined
	if statusComp != "" && !strings.Contains(statusComp, " via ") {
		statusComp = statusComp + via
	} else if statusNovo != nil && *statusNovo != "" && !strings.Contains(*statusNovo, " via ") {
		tmp := *statusNovo + via
		statusNovo = &tmp
	}
	return statusComp, statusNovo, clean, joined
}

/* ======================================================================
   Auxiliares internos (fluxo de ressarcimento / faturamento)
   ====================================================================== */

// ComentarProcesso cria um registro de comentário no histórico do processo,
// preenchendo status/etapas com os valores atuais (ou os informados no corpo).
func ComentarProcesso(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do processo inválido"})
		return
	}

	gestorIDValue, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Usuário não autenticado"})
		return
	}
	gestorID, _ := gestorIDValue.(int64)

	var body struct {
		Comentario string   `json:"comentario"`
		Etapa      string   `json:"etapa,omitempty"`
		SubEtapa   string   `json:"sub_etapa,omitempty"`
		Canais     []string `json:"canais,omitempty"`
	}
	// DEBUG: loga corpo RAW
	if bodyBytes, err2 := io.ReadAll(c.Request.Body); err2 == nil {
		log.Printf("[DEBUG-COM-RAW] proc=%d raw=%s", processoID, strings.TrimSpace(string(bodyBytes)))
		c.Request.Body = io.NopCloser(strings.NewReader(string(bodyBytes)))
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Corpo inválido"})
		return
	}
	if strings.TrimSpace(body.Comentario) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "comentário é obrigatório"})
		return
	}

	tx := database.GormDB_App.Begin()
	if tx.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao iniciar transação"})
		return
	}
	defer tx.Rollback()

	// Etapa/Subetapa atuais do processo
	var etapaAtual, subAtual sql.NullString
	_ = queryRowGorm(tx, `
        SELECT e.etapa, p.sub_etapa
          FROM FT_PROCESSOS p
          JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
         WHERE p.id_processo = ?`, processoID).Scan(&etapaAtual, &subAtual)

	etapaTxt := strings.TrimSpace(etapaAtual.String)
	if strings.TrimSpace(body.Etapa) != "" {
		etapaTxt = strings.TrimSpace(body.Etapa)
	}
	if etapaTxt == "" {
		etapaTxt = "Distribuidora"
	}
	subTxt := strings.TrimSpace(subAtual.String)
	if strings.TrimSpace(body.SubEtapa) != "" {
		subTxt = strings.TrimSpace(body.SubEtapa)
	}

	// Logs de depuração do comentar
	log.Printf("[DEBUG-COM-IN] proc=%d etapa_body='%s' sub_body='%s' comentario='%s'",
		processoID, strings.TrimSpace(body.Etapa), strings.TrimSpace(body.SubEtapa), strings.TrimSpace(body.Comentario))
	log.Printf("[DEBUG-COM-RESOLVED] proc=%d etapaTxt='%s' subTxt='%s'",
		processoID, etapaTxt, subTxt)

	statusTxt := etapaTxt
	if subTxt != "" {
		statusTxt = statusTxt + " - " + subTxt
	}

	res, err := execGorm(tx, `
		INSERT INTO FT_HISTORICO_MOVIMENTACOES 
		   (id_requisicao, id_usuario_gestor,
			status_anterior, status_novo,
			etapa_anterior, etapa_nova, sub_etapa,
			comentario, data_movimentacao, tipo_movimentacao)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'comentario')`,
		processoID, gestorID,
		statusTxt, statusTxt,
		etapaTxt, etapaTxt, subTxt,
		strings.TrimSpace(body.Comentario),
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao salvar comentário no histórico"})
		return
	}

	// Vincula canais enviados no JSON (usando LastInsertId)
	if len(body.Canais) > 0 {
		lastID, _ := res.LastInsertId()
		if lastID > 0 {
			allowed := map[string]bool{"whatsapp": true, "ligacao": true, "email": true, "sms": true, "site": true, "pessoal": true}
			for _, rawNome := range body.Canais {
				n := strings.ToLower(strings.TrimSpace(rawNome))
				if !allowed[n] {
					continue
				}
				if _, e3 := execGorm(tx, 
					`INSERT INTO FT_HISTORICO_CANAIS (id_historico, id_canal)
                     SELECT ?, id_canal FROM DM_CANAIS_COMUNICACAO WHERE nome = ?`,
					lastID, n); e3 != nil {
					log.Printf("[WARN] Falha ao vincular canal '%s' ao historico %d: %v", n, lastID, e3)
				}
			}
		}
	}

	// Vincula canais enviados por form (canais JSON no PostForm)
	if raw := c.PostForm("canais"); strings.TrimSpace(raw) != "" {
		var lista []string
		if err := json.Unmarshal([]byte(raw), &lista); err == nil && len(lista) > 0 {
			var lastID int64
			_ = queryRowGorm(tx, "SELECT id_historico FROM FT_HISTORICO_MOVIMENTACOES WHERE id_requisicao = ? ORDER BY id_historico DESC LIMIT 1", processoID).Scan(&lastID)
			if lastID > 0 {
				allowed := map[string]bool{"whatsapp": true, "ligacao": true, "email": true, "sms": true, "site": true, "pessoal": true}
				for _, rawNome := range lista {
					n := strings.ToLower(strings.TrimSpace(rawNome))
					if !allowed[n] {
						continue
					}
					if _, e3 := execGorm(tx, 
						`INSERT INTO FT_HISTORICO_CANAIS (id_historico, id_canal)
                         SELECT ?, id_canal FROM DM_CANAIS_COMUNICACAO WHERE nome = ?`,
						lastID, n); e3 != nil {
						log.Printf("[WARN] Falha ao vincular canal '%s' ao historico %d: %v", n, lastID, e3)
					}
				}
			}
		}
	}

	if err := tx.Commit().Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao finalizar transação"})
		return
	}

	// Notificar via SSE para atualizar histórico em tempo real
	go func(pid int) {
		defer func() { recover() }()
		sse.Broadcast(pid, sse.Event{Type: "processo_update", ProcessoID: pid})
	}(processoID)

	c.JSON(http.StatusOK, gin.H{"message": "comentário registrado no histórico."})
}

func salvarFluxoRessarcimentoInterno(processoID int, fluxoJSON string, tx *gorm.DB) error {
	if fluxoJSON == "" {
		return nil
	}
	log.Printf("[DEBUG-FLUXO-INTERNO] proc=%d json_preview=%.100s", processoID, fluxoJSON)

	var request struct {
		Itens []map[string]interface{} `json:"itens"`
	}
	if err := json.Unmarshal([]byte(fluxoJSON), &request); err != nil {
		// Compat: se veio como string JSON (duplamente serializado), tenta descompactar
		var quoted string
		if err2 := json.Unmarshal([]byte(fluxoJSON), &quoted); err2 == nil {
			if err3 := json.Unmarshal([]byte(quoted), &request); err3 != nil {
				log.Printf("[ERROR-FLUXO-PARSE] proc=%d err=%v", processoID, err3)
				return err3
			}
		} else {
			log.Printf("[ERROR-FLUXO-PARSE] proc=%d err=%v", processoID, err)
			return err
		}
	}

	log.Printf("[DEBUG-FLUXO-ITENS] proc=%d itens_count=%d", processoID, len(request.Itens))

	if _, err := execGorm(tx, "DELETE FROM FT_FLUXO_RESSARCIMENTO WHERE id_processo = ?", processoID); err != nil {
		log.Printf("[ERROR-FLUXO-DELETE] proc=%d err=%v", processoID, err)
		return err
	}

	for idx, item := range request.Itens {
		// Extrai e normaliza campos com tolerância a tipos
		forma := strings.TrimSpace(fmt.Sprint(item["forma_devolucao"]))
		var valorDec decimal.Decimal
		switch v := item["valor"].(type) {
		case float64:
			valorDec = utils.ParseFloatToDecimal(v)
		case string:
			if d, err := utils.ParseBrazilianCurrency(v); err == nil {
				valorDec = d
			}
		case json.Number:
			if f, err := v.Float64(); err == nil {
				valorDec = utils.ParseFloatToDecimal(f)
			}
		}
		dataDev := strings.TrimSpace(fmt.Sprint(item["data_devolucao"]))
		dataEnv := strings.TrimSpace(fmt.Sprint(item["data_envio_financeiro"]))

		// normaliza e padroniza a forma de devolução
		switch normalizarForma(forma) {
		case "fatura":
			forma = "Fatura"
		case "gd":
			forma = "GD"
		case "deposito", "depósito":
			forma = "Depósito"
		default:
			log.Printf("[DEBUG-FLUXO-SKIP] proc=%d idx=%d forma_invalida=%s", processoID, idx, forma)
			continue // ignora valores inválidos
		}

		var dataDevolucao, dataEnvioFinanceiro sql.NullString
		if strings.TrimSpace(dataDev) != "" {
			dataDevolucao = sql.NullString{String: dataDev, Valid: true}
		}
		if strings.TrimSpace(dataEnv) != "" {
			dataEnvioFinanceiro = sql.NullString{String: dataEnv, Valid: true}
		}

		valorFloat, _ := valorDec.Float64()
		log.Printf("[DEBUG-FLUXO-INSERT] proc=%d idx=%d forma=%s valor=%.2f", processoID, idx, forma, valorFloat)

		if _, err := execGorm(tx, `
            INSERT INTO FT_FLUXO_RESSARCIMENTO
                (id_processo, forma_devolucao, valor, data_devolucao, data_envio_financeiro)
            VALUES (?, ?, ?, ?, ?)`,
			processoID, forma, valorDec, dataDevolucao, dataEnvioFinanceiro,
		); err != nil {
			log.Printf("[ERROR-FLUXO-INSERT] proc=%d idx=%d err=%v", processoID, idx, err)
			return err
		}
	}
	log.Printf("[DEBUG-FLUXO-SUCESS] proc=%d", processoID)
	return nil
}

func salvarFaturamentoInterno(processoID int, faturamentoJSON string, tx *gorm.DB) error {
	if faturamentoJSON == "" {
		return nil
	}
	log.Printf("[DEBUG-FATURA-INTERNO] proc=%d json_preview=%.100s", processoID, faturamentoJSON)

	var request struct {
		Itens []map[string]interface{} `json:"itens"`
	}
	if err := json.Unmarshal([]byte(faturamentoJSON), &request); err != nil {
		// Compat: se veio como string JSON (duplamente serializado), tenta descompactar
		var quoted string
		if err2 := json.Unmarshal([]byte(faturamentoJSON), &quoted); err2 == nil {
			if err3 := json.Unmarshal([]byte(quoted), &request); err3 != nil {
				log.Printf("[ERROR-FATURA-PARSE] proc=%d err=%v", processoID, err3)
				return err3
			}
		} else {
			log.Printf("[ERROR-FATURA-PARSE] proc=%d err=%v", processoID, err)
			return err
		}
	}

	log.Printf("[DEBUG-FATURA-ITENS] proc=%d itens_count=%d", processoID, len(request.Itens))

	if _, err := execGorm(tx, "DELETE FROM FT_FATURAMENTO WHERE id_processo = ?", processoID); err != nil {
		log.Printf("[ERROR-FATURA-DELETE] proc=%d err=%v", processoID, err)
		return err
	}
	for idx, item := range request.Itens {
		var dataEmissao, dataVencimento, dataPagamento sql.NullString
		de := strings.TrimSpace(fmt.Sprint(item["data_emissao"]))
		dv := strings.TrimSpace(fmt.Sprint(item["data_vencimento"]))
		dp := strings.TrimSpace(fmt.Sprint(item["data_pagamento"]))
		if de != "" {
			dataEmissao = sql.NullString{String: de, Valid: true}
		}
		if dv != "" {
			dataVencimento = sql.NullString{String: dv, Valid: true}
		}
		if dp != "" {
			dataPagamento = sql.NullString{String: dp, Valid: true}
		}

		var valorDec decimal.Decimal
		switch v := item["valor"].(type) {
		case float64:
			valorDec = utils.ParseFloatToDecimal(v)
		case string:
			if d, err := utils.ParseBrazilianCurrency(v); err == nil {
				valorDec = d
			}
		case json.Number:
			if f, err := v.Float64(); err == nil {
				valorDec = utils.ParseFloatToDecimal(f)
			}
		}
		numeroNF := strings.TrimSpace(fmt.Sprint(item["numero_nf"]))

		valorFloat, _ := valorDec.Float64()
		log.Printf("[DEBUG-FATURA-INSERT] proc=%d idx=%d nf=%s valor=%.2f", processoID, idx, numeroNF, valorFloat)

		if _, err := execGorm(tx, `
			INSERT INTO FT_FATURAMENTO
			(id_processo, numero_nf, data_emissao, data_vencimento, data_pagamento, valor)
			VALUES (?, ?, ?, ?, ?, ?)`,
			processoID, numeroNF, dataEmissao, dataVencimento, dataPagamento, valorDec,
		); err != nil {
			log.Printf("[ERROR-FATURA-INSERT] proc=%d idx=%d err=%v", processoID, idx, err)
			return err
		}
	}
	log.Printf("[DEBUG-FATURA-SUCCESS] proc=%d", processoID)
	return nil
}

// SalvarDeferimentoSimples: upsert de deferimento com histórico básico
func SalvarDeferimentoSimples(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID inválido"})
		return
	}

	var payload struct {
		CreditoSimples   string `json:"credito_simples"`   // Recebe como string, converte abaixo
		CreditoDobro     string `json:"credito_dobro"`     // Recebe como string, converte abaixo
		DataProcedencia  string `json:"data_procedencia"`
		DataCreditoDobro string `json:"data_credito_dobro"`
	}
	body, _ := io.ReadAll(c.Request.Body)
	if len(body) > 0 {
		c.Request.Body = io.NopCloser(strings.NewReader(string(body)))
	}
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "JSON inválido: " + err.Error()})
		return
	}

	// Converte strings para decimal
	creditoSimples, err := utils.ParseBrazilianCurrency(payload.CreditoSimples)
	if err != nil && payload.CreditoSimples != "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Crédito simples inválido: " + err.Error()})
		return
	}

	creditoDobro, err := utils.ParseBrazilianCurrency(payload.CreditoDobro)
	if err != nil && payload.CreditoDobro != "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Crédito dobro inválido: " + err.Error()})
		return
	}

	tx := database.GormDB_App.Begin()
	if tx.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao iniciar transação"})
		return
	}
	defer tx.Rollback()

	var prevCS, prevCD decimal.NullDecimal
	var prevDP, prevDD sql.NullString
	_ = queryRowGorm(tx, `SELECT credito_simples, credito_dobro, data_procedencia, data_credito_dobro FROM FT_DEFERIMENTOS WHERE id_processo = ?`, processoID).
		Scan(&prevCS, &prevCD, &prevDP, &prevDD)

	if _, err := execGorm(tx, `
        INSERT INTO FT_DEFERIMENTOS (id_processo, data_procedencia, credito_simples, credito_dobro, data_credito_dobro)
        VALUES (?, NULLIF(?, ''), ?, ?, NULLIF(?, ''))
        ON DUPLICATE KEY UPDATE data_procedencia=VALUES(data_procedencia), credito_simples=VALUES(credito_simples), credito_dobro=VALUES(credito_dobro), data_credito_dobro=VALUES(data_credito_dobro)
    `, processoID, strings.TrimSpace(payload.DataProcedencia), creditoSimples, creditoDobro, strings.TrimSpace(payload.DataCreditoDobro)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao salvar deferimento"})
		return
	}

	gestorIDVal, _ := c.Get("userID")
	gestorID, _ := gestorIDVal.(int64)

	if err := updateColunaByData(tx, processoID, gestorID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao atualizar coluna do processo"})
		return
	}
	// etapa/sub-etapa atuais
	var etapaNome, subEtapa sql.NullString
	_ = queryRowGorm(tx, `SELECT e.etapa, p.sub_etapa FROM FT_PROCESSOS p JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo WHERE p.id_processo = ?`, processoID).
		Scan(&etapaNome, &subEtapa)

	msg := "Deferimento atualizado"
	if !prevCS.Valid && !utils.IsZero(creditoSimples) {
		msg = "Valor de crédito simples adicionado"
	} else if prevCS.Valid && !prevCS.Decimal.Equal(creditoSimples) {
		msg = fmt.Sprintf("Crédito simples alterado de %s para %s",
			utils.FormatBrazilianCurrencyWithSymbol(prevCS.Decimal),
			utils.FormatBrazilianCurrencyWithSymbol(creditoSimples))
	}
	if strings.TrimSpace(payload.DataProcedencia) != "" && payload.DataProcedencia != prevDP.String {
		msg = msg + " na data " + payload.DataProcedencia
	}

	_, _ = execGorm(tx, `INSERT INTO FT_HISTORICO_MOVIMENTACOES (id_requisicao, id_usuario_gestor, status_anterior, status_novo, etapa_anterior, etapa_nova, sub_etapa, comentario, data_movimentacao)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
		processoID, gestorID, etapaNome.String, etapaNome.String, etapaNome.String, etapaNome.String, subEtapa.String, msg)

	if err := tx.Commit().Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao finalizar"})
		return
	}
	go func(pid int) {
		defer func() { recover() }()
		sse.Broadcast(pid, sse.Event{Type: "processo_update", ProcessoID: pid})
	}(processoID)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

/* ======================================================================
   Data de Alerta
   ====================================================================== */

func SalvarDataAlerta(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID de processo inválido"})
		return
	}

	var bodyJSON struct {
		DataAlerta *string `json:"data_alerta"`
	}
	bindErr := c.ShouldBindJSON(&bodyJSON)

	var dataStr *string
	if bindErr == nil {
		dataStr = bodyJSON.DataAlerta
	} else {
		if v := c.PostForm("data_alerta"); v != "" {
			dataStr = &v
		} else if v := c.Query("data_alerta"); v != "" {
			dataStr = &v
		}
	}

	var driverVal interface{}
	if dataStr == nil || strings.TrimSpace(*dataStr) == "" {
		driverVal = nil
	} else {
		val := strings.TrimSpace(*dataStr)
		if len(val) == 10 {
			if _, err := time.Parse("2006-01-02", val); err == nil {
				driverVal = val
			} else if t, err2 := time.Parse(time.RFC3339, val); err2 == nil {
				driverVal = t
			} else {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Formato de data inválido"})
				return
			}
		} else if t, err := time.Parse(time.RFC3339, val); err == nil {
			driverVal = t
		} else {
			driverVal = val
		}
	}

	if _, err := execGorm(database.GormDB_App, "UPDATE FT_PROCESSOS SET data_alerta = ? WHERE id_processo = ?", driverVal, id); err != nil {
		log.Printf("SalvarDataAlerta Exec error (id=%d, val=%v, bindErr=%v): %v", id, driverVal, bindErr, err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "não foi possível salvar a data de alerta"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Data de alerta atualizada com sucesso"})
}

/* ======================================================================
   Indeferir (descartar) processo
   ====================================================================== */

func DescartarProcesso(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do processo inválido"})
		return
	}

	gestorIDValue, _ := c.Get("userID")
	gestorID, _ := gestorIDValue.(int64)

	var input struct {
		Comentario string `json:"comentario"`
	}
	if err := c.ShouldBindJSON(&input); err != nil || strings.TrimSpace(input.Comentario) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "comentário é obrigatório"})
		return
	}

	tx := database.GormDB_App.Begin()
	if tx.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao iniciar transação"})
		return
	}
	defer tx.Rollback()

	var etapaAnteriorNome, subAnterior sql.NullString
	if err = queryRowGorm(tx, `
		SELECT e.etapa, p.sub_etapa
		  FROM FT_PROCESSOS p 
		  JOIN DM_ETAPAS_PROCESSO e ON p.id_etapa_processo = e.id_etapa_processo 
		 WHERE p.id_processo = ?`, processoID).Scan(&etapaAnteriorNome, &subAnterior); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Processo ou etapa anterior não encontrado"})
		return
	}

	var novaEtapaID int
	if err = queryRowGorm(tx, "SELECT id_etapa_processo FROM DM_ETAPAS_PROCESSO WHERE etapa = 'Indeferido'").Scan(&novaEtapaID); err != nil {
		log.Printf("Erro ao buscar ID da etapa Indeferido: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro interno ao descartar o processo"})
		return
	}

	// mantemos ultima_atualizacao (mesmo para admin) por ser transição de status
	if _, err = execGorm(tx, "UPDATE FT_PROCESSOS SET id_etapa_processo = ?, ultima_atualizacao = NOW() WHERE id_processo = ?", novaEtapaID, processoID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao descartar o processo"})
		return
	}

	// Monta status_anterior/status_novo
	statusAnterior := etapaAnteriorNome.String
	if s := strings.TrimSpace(subAnterior.String); s != "" {
		statusAnterior = statusAnterior + " - " + s
	}
	statusNovo := "Indeferido"

	if _, err = execGorm(tx, 
		`INSERT INTO FT_HISTORICO_MOVIMENTACOES 
           (id_requisicao, id_usuario_gestor, status_anterior, status_novo, 
            etapa_anterior, etapa_nova, sub_etapa, comentario, data_movimentacao, tipo_movimentacao) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'movimentacao')`,
		processoID, gestorID, statusAnterior, statusNovo, etapaAnteriorNome.String, "Indeferido", "", strings.TrimSpace(input.Comentario),
	); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao salvar movimentação no histórico"})
		return
	}

	if err := tx.Commit().Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao finalizar transação"})
		return
	}

	go func(pid int) {
		defer func() { recover() }()
		payload := map[string]interface{}{
			"coluna_kanban_id":   6,
			"coluna_kanban_nome": "Indeferidos",
		}
		sse.Broadcast(pid, sse.Event{Type: "processo_update", ProcessoID: pid, Payload: payload})
	}(processoID)

	c.JSON(http.StatusOK, gin.H{"message": "Processo movido para Indeferido com sucesso!"})
}

/* ======================================================================
   Exclusão permanente
   ====================================================================== */

func ExcluirProcessoPermanentemente(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do processo inválido"})
		return
	}
	if _, err = execGorm(database.GormDB_App, "DELETE FROM FT_REQUISICOES WHERE id_requisicao = ?", processoID); err != nil {
		log.Printf("Erro ao excluir permanentemente o processo %d: %v", processoID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao excluir o processo do banco de dados."})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Processo excluído permanentemente com sucesso."})
}

/* ======================================================================
   Alertas / Suspenso (suspenso como flag — não usa sub_etapa)
   ====================================================================== */

func SuspenderProcesso(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do processo inválido"})
		return
	}
	gestorIDVal, _ := c.Get("userID")
	gestorID, _ := gestorIDVal.(int64)

	var body struct {
		Comentario string `json:"comentario"`
	}
	_ = c.ShouldBindJSON(&body)

	tx := database.GormDB_App.Begin()
	if tx.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao iniciar transação"})
		return
	}
	defer tx.Rollback()

	var etapaAtual, subAtual sql.NullString
	_ = queryRowGorm(tx, `SELECT e.etapa, p.sub_etapa FROM FT_PROCESSOS p JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo=p.id_etapa_processo WHERE p.id_processo=?`,
		processoID).Scan(&etapaAtual, &subAtual)

	// não mexe na sub_etapa; não altera ultima_atualizacao (opcional: pode alterar se desejar)
	var etapaSuspID sql.NullInt64
	_ = queryRowGorm(tx, `SELECT id_etapa_processo FROM DM_ETAPAS_PROCESSO WHERE etapa IN ('Suspenso','Suspensos') LIMIT 1`).Scan(&etapaSuspID)

	if etapaSuspID.Valid {
		if _, err := execGorm(tx, `UPDATE FT_PROCESSOS SET suspenso=1, id_etapa_processo=?, sub_etapa='Suspenso', id_sub_etapa_processo=NULL, id_coluna=99, nome_coluna='Suspensos', ultima_atualizacao=NOW() WHERE id_processo=?`, etapaSuspID.Int64, processoID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao suspender processo"})
			return
		}
	} else {
		if _, err := execGorm(tx, `UPDATE FT_PROCESSOS SET suspenso=1 WHERE id_processo=?`, processoID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao suspender processo"})
			return
		}
	}

	_, _ = execGorm(tx, `INSERT INTO FT_HISTORICO_MOVIMENTACOES
        (id_requisicao, id_usuario_gestor, status_anterior, status_novo, etapa_anterior, etapa_nova, sub_etapa, comentario, data_movimentacao, tipo_movimentacao)
        VALUES (?,?,?,?,?,?,?,?,NOW(),'suspensao')`,
		processoID,
		gestorID,
		buildStatus(etapaAtual.String, subAtual.String),
		"Suspenso",
		etapaAtual.String, "Suspenso", "Suspenso",
		strings.TrimSpace(body.Comentario),
	)

	if err := tx.Commit().Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao finalizar transação"})
		return
	}
	go func(pid int) {
		defer func() { recover() }()
		sse.Broadcast(pid, sse.Event{Type: "processo_update", ProcessoID: pid})
	}(processoID)
	c.JSON(http.StatusOK, gin.H{"message": "Processo suspenso"})
}

// RetomarProcesso: remove suspenso (suspenso=0) e registra histórico (sem alterar sub_etapa)
func RetomarProcesso(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do processo inválido"})
		return
	}
	gestorIDVal, _ := c.Get("userID")
	gestorID, _ := gestorIDVal.(int64)

	var body struct {
		Comentario string `json:"comentario"`
	}
	_ = c.ShouldBindJSON(&body)

	tx := database.GormDB_App.Begin()
	if tx.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao iniciar transação"})
		return
	}
	defer tx.Rollback()

	var etapaAtual, subAtual sql.NullString
	_ = queryRowGorm(tx, `SELECT e.etapa, p.sub_etapa FROM FT_PROCESSOS p JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo=p.id_etapa_processo WHERE p.id_processo=?`,
		processoID).Scan(&etapaAtual, &subAtual)

	var prevEtapa, prevSub sql.NullString
	_ = queryRowGorm(tx, `
        SELECT etapa_anterior, sub_etapa
          FROM FT_HISTORICO_MOVIMENTACOES
         WHERE id_requisicao = ? AND tipo_movimentacao = 'suspensao'
         ORDER BY data_movimentacao DESC
         LIMIT 1`, processoID).Scan(&prevEtapa, &prevSub)

	targetStage := strings.TrimSpace(prevEtapa.String)
	if targetStage == "" {
		targetStage = strings.TrimSpace(etapaAtual.String)
	}
	targetSub := strings.TrimSpace(prevSub.String)

	setClauses := []string{"suspenso = 0"}
	args := []interface{}{}
	if targetStage != "" {
		var stageID sql.NullInt64
		_ = queryRowGorm(tx, "SELECT id_etapa_processo FROM DM_ETAPAS_PROCESSO WHERE etapa = ?", targetStage).Scan(&stageID)
		if stageID.Valid {
			setClauses = append(setClauses, "id_etapa_processo = ?")
			args = append(args, stageID.Int64)
			var colID sql.NullInt64
			var colNome sql.NullString
			_ = queryRowGorm(tx, `
				SELECT k.id_coluna, k.nome_coluna
				  FROM DM_ETAPAS_PROCESSO e
				  JOIN DM_KANBAN_COLUNAS k ON k.id_coluna = e.id_coluna_kanban
				 WHERE e.id_etapa_processo = ?`,
				stageID.Int64,
			).Scan(&colID, &colNome)
			setClauses = append(setClauses, "id_coluna = ?")
			if colID.Valid {
				args = append(args, colID.Int64)
			} else {
				args = append(args, nil)
			}
			setClauses = append(setClauses, "nome_coluna = ?")
			if colNome.Valid {
				args = append(args, colNome.String)
			} else {
				args = append(args, nil)
			}
		}
	}
	if targetSub != "" {
		setClauses = append(setClauses, "sub_etapa = ?")
		args = append(args, targetSub)
		subID, _ := resolveSubEtapaIDGorm(tx, targetSub)
		setClauses = append(setClauses, "id_sub_etapa_processo = ?")
		args = append(args, nullIntToIface(subID))
	}
	args = append(args, processoID)
	query := fmt.Sprintf("UPDATE FT_PROCESSOS SET %s WHERE id_processo = ?", strings.Join(setClauses, ", "))
	if _, err := execGorm(tx, query, args...); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao retomar processo"})
		return
	}

	restoredStage := targetStage
	if restoredStage == "" {
		restoredStage = etapaAtual.String
	}
	restoredSub := targetSub
	if restoredSub == "" {
		restoredSub = subAtual.String
	}
	_, _ = execGorm(tx, `INSERT INTO FT_HISTORICO_MOVIMENTACOES
        (id_requisicao, id_usuario_gestor, status_anterior, status_novo, etapa_anterior, etapa_nova, sub_etapa, comentario, data_movimentacao, tipo_movimentacao)
        VALUES (?,?,?,?,?,?,?,?,NOW(),'retomada')`,
		processoID,
		gestorID,
		buildStatus(etapaAtual.String, subAtual.String),
		buildStatus(restoredStage, restoredSub),
		etapaAtual.String, restoredStage, restoredSub,
		strings.TrimSpace(body.Comentario),
	)

	if err := tx.Commit().Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao finalizar transação"})
		return
	}
	go func(pid int) {
		defer func() { recover() }()
		sse.Broadcast(pid, sse.Event{Type: "processo_update", ProcessoID: pid})
	}(processoID)
	c.JSON(http.StatusOK, gin.H{"message": "Processo retomado"})
}

func buildStatus(etapa, sub string) string {
	s := strings.TrimSpace(etapa)
	if se := strings.TrimSpace(sub); se != "" {
		s += " - " + se
	}
	return s
}

func GetAlertasByUser(c *gin.Context) {
	userIDValue, exists := c.Get("userID")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Usuário não autenticado"})
		return
	}
	userID, ok := userIDValue.(int64)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Tipo do ID do Usuário inválido"})
		return
	}

	var alertas []models.Alerta
	rows, err := queryGorm(database.GormDB_App, `
		SELECT id_alerta, id_processo, mensagem, lido, data_criacao
		  FROM FT_ALERTAS
		 WHERE id_usuario = ?
		 ORDER BY data_criacao DESC`,
		userID,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar alertas"})
		return
	}
	defer rows.Close()

	for rows.Next() {
		var a models.Alerta
		if err := rows.Scan(&a.ID, &a.ProcessoID, &a.Mensagem, &a.Lido, &a.DataCriacao); err != nil {
			continue
		}
		alertas = append(alertas, a)
	}
	if alertas == nil {
		alertas = make([]models.Alerta, 0)
	}
	c.JSON(http.StatusOK, alertas)
}

func MarcarAlertaComoLido(c *gin.Context) {
	var input struct {
		AlertaIDs []int `json:"alerta_ids"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Corpo da requisição inválido"})
		return
	}
	if len(input.AlertaIDs) == 0 {
		c.JSON(http.StatusOK, gin.H{"message": "Nenhum alerta para marcar."})
		return
	}

	args := make([]interface{}, len(input.AlertaIDs))
	for i, id := range input.AlertaIDs {
		args[i] = id
	}

	query := "UPDATE FT_ALERTAS SET lido = TRUE WHERE id_alerta IN (?" + strings.Repeat(",?", len(input.AlertaIDs)-1) + ")"
	if _, err := execGorm(database.GormDB_App, query, args...); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao marcar alertas como lidos"})
		return
	}
	// SSE: reenvia contagem e um evento "lido" para sincronizar o badge no front
	if v, ok := c.Get("userID"); ok {
		if uid, ok2 := v.(int64); ok2 {
			notifyUnread(uid)
			sse.BroadcastUser(uid, sse.Event{Type: "alerta_lido"})
		}
	}
	c.JSON(http.StatusOK, gin.H{"message": "Alertas marcados como lidos."})
}

// GET /api/v1/processos/suspensos
func GetProcessosSuspensos(c *gin.Context) {
	limit := 100
	offset := 0
	if v := strings.TrimSpace(c.DefaultQuery("limit", "100")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}
	if v := strings.TrimSpace(c.DefaultQuery("offset", "0")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			offset = n
		}
	}

	repo := repositories.NewProcessosRepo(database.GormDB_App)
	items, err := repo.ListarSuspensos(c.Request.Context(), limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar suspensos"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"rows": items, "limit": limit, "offset": offset})
}

// CreateAlertaManual cria um alerta associado a um processo, para o Usuário logado
// POST /api/processos/:id/alertas { mensagem: "...", data_alerta?: "YYYY-MM-DD" }
func CreateAlertaManual(c *gin.Context) {
	userIDVal, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Usuário não autenticado"})
		return
	}
	userID, _ := userIDVal.(int64)

	procID := c.Param("id")
	var body struct {
		Mensagem   string  `json:"mensagem"`
		DataAlerta *string `json:"data_alerta,omitempty"` // opcional: YYYY-MM-DD
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Corpo inválido"})
		return
	}
	msg := strings.TrimSpace(body.Mensagem)
	if msg == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Mensagem obrigatória"})
		return
	}

	var driverDate interface{}
	if body.DataAlerta != nil && strings.TrimSpace(*body.DataAlerta) != "" {
		val := strings.TrimSpace(*body.DataAlerta)
		if _, err := time.Parse("2006-01-02", val); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "data_alerta inválida (YYYY-MM-DD)"})
			return
		}
		driverDate = val
	}

	if _, err := execGorm(database.GormDB_App,
		"INSERT INTO FT_ALERTAS (id_usuario, id_processo, mensagem, lido, data_criacao, data_alerta) VALUES (?, ?, ?, 0, NOW(), ?)",
		userID, procID, msg, driverDate,
	); err != nil {
		log.Printf("Erro ao criar alerta manual (proc=%s, user=%d): %v", procID, userID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao criar alerta"})
		return
	}

	// SSE: novo alerta + atualiza contagem do Usuário
	procInt, _ := strconv.Atoi(procID)
	sse.BroadcastUser(userID, sse.Event{
		Type:    "alerta_novo",
		Payload: gin.H{"processo_id": procInt},
	})
	notifyUnread(userID)

	c.JSON(http.StatusCreated, gin.H{"message": "Alerta criado"})
}

// GET /api/v1/processos/:id/deferimento
func GetDeferimentoByProcesso(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID invalido"})
		return
	}

	var out models.Deferimento
	err = queryRowGorm(database.GormDB_App, `
        SELECT status_analise, data_procedencia, credito_simples, credito_dobro, data_credito_dobro
        FROM FT_DEFERIMENTOS
        WHERE id_processo = ?
        LIMIT 1
    `, processoID).Scan(
		&out.StatusAnalise,
		&out.DataProcedencia,
		&out.CreditoSimples,
		&out.CreditoDobro,
		&out.DataCreditoDobro,
	)

	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusOK, gin.H{})
			return
		}
		log.Printf("Erro ao buscar deferimento do processo %d: %v", processoID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar deferimento"})
		return
	}

	c.JSON(http.StatusOK, out)
}

/* ======================================================================
   Update & Delete de Alertas (utilitários)
   ====================================================================== */

// DELETE /api/alertas/:id
func DeleteAlerta(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	if _, err := execGorm(database.GormDB_App, "DELETE FROM FT_ALERTAS WHERE id_alerta=?", id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao excluir"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Alerta excluído"})
}

// notifica ao Usuário a contagem de não lidos via SSE
func notifyUnread(userID int64) {
	var unread int
	_ = queryRowGorm(database.GormDB_App,
		"SELECT COUNT(*) FROM FT_ALERTAS WHERE id_usuario=? AND lido=0",
		userID,
	).Scan(&unread)

	sse.BroadcastUser(userID, sse.Event{
		Type: "alerta_unread",
		Payload: gin.H{
			"unread": unread,
		},
	})
}
