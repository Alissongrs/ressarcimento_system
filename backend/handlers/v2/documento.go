package v2

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// GeraDocumento — GET /api/v2/processos/:id/documento
//
// Gera documento especializado a partir do tipo/subtipo de irregularidade
// do processo. Lógica:
//   1. Tenta usar DM_SUBTIPO_IRREGULARIDADE.modelo_documento_md (mais específico)
//   2. Se NULL, usa DM_TIPO_IRREGULARIDADE.modelo_documento_md (mais genérico)
//   3. Se também NULL, retorna 404
//
// Substitui placeholders {{campo}} com dados do processo.
//
// Query: ?formato=markdown (default) | text | json
func GeraDocumento(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}

	dados, err := loadDadosProcesso(c.Request.Context(), db, id)
	if err == sql.ErrNoRows {
		apiError(c, http.StatusNotFound, "PROCESSO_NAO_ENCONTRADO",
			fmt.Sprintf("Processo %d não existe", id), nil)
		return
	}
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}

	// Template: subtipo > tipo
	template := strings.TrimSpace(dados["modelo_documento_md_subtipo"].(string))
	descricaoOficial := strings.TrimSpace(dados["descricao_oficial_subtipo"].(string))
	if template == "" {
		template = strings.TrimSpace(dados["modelo_documento_md_tipo"].(string))
	}
	if descricaoOficial == "" {
		descricaoOficial = strings.TrimSpace(dados["descricao_oficial_tipo"].(string))
	}

	if template == "" {
		apiError(c, http.StatusNotFound, "TEMPLATE_NAO_ENCONTRADO",
			"Nem o subtipo nem o tipo desse processo têm modelo de documento configurado",
			gin.H{
				"id_tipo_irregularidade":    dados["id_tipo"],
				"id_subtipo_irregularidade": dados["id_subtipo"],
			})
		return
	}

	// Substitui placeholders
	documento := substituirPlaceholders(template, dados, descricaoOficial)

	// Formato de saída
	formato := strings.ToLower(c.DefaultQuery("formato", "markdown"))
	switch formato {
	case "text", "txt":
		c.Data(http.StatusOK, "text/plain; charset=utf-8", []byte(documento))
	case "json":
		c.JSON(http.StatusOK, gin.H{
			"id_processo":               id,
			"codigo_publico":            dados["codigo_publico"],
			"tipo_irregularidade":       dados["tipo_irregularidade"],
			"subtipo_irregularidade":    dados["subtipo_irregularidade"],
			"descricao_oficial":         descricaoOficial,
			"template_origem":           dados["template_origem"], // "subtipo" ou "tipo"
			"documento_md":              documento,
			"placeholders_disponiveis":  placeholdersDisponiveis(),
		})
	default: // markdown
		c.Data(http.StatusOK, "text/markdown; charset=utf-8", []byte(documento))
	}
}

// loadDadosProcesso busca tudo que vai entrar no template num único SELECT.
func loadDadosProcesso(ctx context.Context, db *sql.DB, id int) (map[string]interface{}, error) {
	const q = `
SELECT
    p.id_processo,
    COALESCE(p.codigo_publico,'')        AS codigo_publico,
    COALESCE(p.cliente,'')               AS cliente,
    COALESCE(r.cnpj,'')                  AS cnpj,
    COALESCE(r.razao_social_fatura,'')   AS razao_social_fatura,
    COALESCE(p.uc,'')                    AS uc,
    COALESCE(r.endereco_completo,'')     AS endereco,
    COALESCE(p.concessionaria,'')        AS distribuidora,
    COALESCE(ti.id_tipo, 0)              AS id_tipo,
    COALESCE(ti.nome,'')                 AS tipo_nome,
    COALESCE(ti.descricao_oficial,'')    AS descricao_oficial_tipo,
    COALESCE(ti.modelo_documento_md,'')  AS modelo_documento_md_tipo,
    COALESCE(sti.id_subtipo, 0)          AS id_subtipo,
    COALESCE(sti.nome,'')                AS subtipo_nome,
    COALESCE(sti.descricao_oficial,'')   AS descricao_oficial_subtipo,
    COALESCE(sti.modelo_documento_md,'') AS modelo_documento_md_subtipo,
    COALESCE(r.descricao_irregularidade, p.descricao_irregularidade, '') AS descricao_irregularidade,
    p.ressarcimento_estimado,
    p.data_criacao,
    p.data_alerta,
    COALESCE(e.nome,'')                  AS etapa_atual,
    COALESCE(i.nome,'')                  AS instancia_atual,
    COALESCE(s.nome,'')                  AS status_atual,
    COALESCE(u.nome_usuario,'')          AS responsavel
FROM FT_PROCESSOS p
LEFT JOIN FT_REQUISICOES r              ON r.id_requisicao        = p.id_processo
LEFT JOIN DM_TIPO_IRREGULARIDADE ti     ON ti.id_tipo             = r.id_tipo_irregularidade
LEFT JOIN DM_SUBTIPO_IRREGULARIDADE sti ON sti.id_subtipo         = r.id_subtipo_irregularidade
LEFT JOIN DM_ETAPAS e                   ON e.id_etapa             = p.id_etapa_atual
LEFT JOIN DM_INSTANCIAS i               ON i.id_instancia         = p.id_instancia_atual
LEFT JOIN DM_STATUS_PROCESSO s          ON s.id_status            = p.id_status_atual
LEFT JOIN DM_USUARIO u                  ON u.id_usuario           = p.id_responsavel
WHERE p.id_processo = ?`

	var (
		idProc                                                                    int
		codigoPublico, cliente, cnpj, razaoFat, uc, endereco, distribuidora       string
		idTipo                                                                    int
		tipoNome, descOficialTipo, templateTipo                                   string
		idSubtipo                                                                 int
		subtipoNome, descOficialSubtipo, templateSubtipo                          string
		descricaoIrregularidade                                                   string
		ressNull                                                                  sql.NullFloat64
		dataCriacao                                                               sql.NullTime
		dataAlerta                                                                sql.NullTime
		etapaAtual, instanciaAtual, statusAtual, responsavel                      string
	)

	err := db.QueryRowContext(ctx, q, id).Scan(
		&idProc, &codigoPublico, &cliente, &cnpj, &razaoFat, &uc, &endereco, &distribuidora,
		&idTipo, &tipoNome, &descOficialTipo, &templateTipo,
		&idSubtipo, &subtipoNome, &descOficialSubtipo, &templateSubtipo,
		&descricaoIrregularidade,
		&ressNull, &dataCriacao, &dataAlerta,
		&etapaAtual, &instanciaAtual, &statusAtual, &responsavel,
	)
	if err != nil {
		return nil, err
	}

	templateOrigem := "tipo"
	if strings.TrimSpace(templateSubtipo) != "" {
		templateOrigem = "subtipo"
	}

	dados := map[string]interface{}{
		"id_processo":                  idProc,
		"codigo_publico":               codigoPublico,
		"cliente":                      cliente,
		"cnpj":                         cnpj,
		"razao_social_fatura":          razaoFat,
		"uc":                           uc,
		"endereco":                     endereco,
		"distribuidora":                distribuidora,
		"id_tipo":                      idTipo,
		"tipo_irregularidade":          tipoNome,
		"descricao_oficial_tipo":       descOficialTipo,
		"modelo_documento_md_tipo":     templateTipo,
		"id_subtipo":                   idSubtipo,
		"subtipo_irregularidade":       subtipoNome,
		"descricao_oficial_subtipo":    descOficialSubtipo,
		"modelo_documento_md_subtipo":  templateSubtipo,
		"template_origem":              templateOrigem,
		"descricao_irregularidade":     descricaoIrregularidade,
		"etapa_atual":                  etapaAtual,
		"instancia_atual":              instanciaAtual,
		"status_atual":                 statusAtual,
		"responsavel":                  responsavel,
	}

	if ressNull.Valid {
		dados["ressarcimento_estimado"] = fmtMoeda(ressNull.Float64)
	} else {
		dados["ressarcimento_estimado"] = "—"
	}
	if dataCriacao.Valid {
		dados["data_abertura"] = dataCriacao.Time.Format("02/01/2006")
	} else {
		dados["data_abertura"] = "—"
	}
	if dataAlerta.Valid {
		dados["data_alerta"] = dataAlerta.Time.Format("02/01/2006")
	} else {
		dados["data_alerta"] = "—"
	}
	dados["data_geracao"] = time.Now().Format("02/01/2006 15:04")

	return dados, nil
}

// substituirPlaceholders troca {{campo}} pelos valores do mapa.
// `descricao_oficial` é o resolvido (subtipo > tipo) — também acessível como {{descricao_oficial}}.
func substituirPlaceholders(template string, dados map[string]interface{}, descricaoOficial string) string {
	out := template

	// Alias resolvido
	out = strings.ReplaceAll(out, "{{descricao_oficial}}", descricaoOficial)

	for chave, valor := range dados {
		placeholder := "{{" + chave + "}}"
		valStr := ""
		switch v := valor.(type) {
		case string:
			valStr = v
		case int:
			valStr = fmt.Sprintf("%d", v)
		case float64:
			valStr = fmt.Sprintf("%.2f", v)
		case nil:
			valStr = ""
		default:
			valStr = fmt.Sprintf("%v", v)
		}
		out = strings.ReplaceAll(out, placeholder, valStr)
	}
	return out
}

// fmtMoeda formata pra "1.234,56".
func fmtMoeda(v float64) string {
	intPart := int64(v)
	cents := int64((v - float64(intPart)) * 100)
	if cents < 0 {
		cents = -cents
	}
	intStr := fmt.Sprintf("%d", intPart)
	if intPart < 0 {
		intStr = intStr[1:]
	}
	var b strings.Builder
	n := len(intStr)
	for i, ch := range intStr {
		if i > 0 && (n-i)%3 == 0 {
			b.WriteByte('.')
		}
		b.WriteRune(ch)
	}
	prefix := ""
	if intPart < 0 {
		prefix = "-"
	}
	return fmt.Sprintf("%s%s,%02d", prefix, b.String(), cents)
}

func placeholdersDisponiveis() []string {
	return []string{
		"{{codigo_publico}}",
		"{{cliente}}",
		"{{cnpj}}",
		"{{razao_social_fatura}}",
		"{{uc}}",
		"{{endereco}}",
		"{{distribuidora}}",
		"{{tipo_irregularidade}}",
		"{{subtipo_irregularidade}}",
		"{{descricao_oficial}}",         // resolvido (subtipo > tipo)
		"{{descricao_oficial_tipo}}",    // do tipo
		"{{descricao_oficial_subtipo}}", // do subtipo
		"{{descricao_irregularidade}}",  // texto livre do cliente
		"{{ressarcimento_estimado}}",
		"{{data_abertura}}",
		"{{data_alerta}}",
		"{{data_geracao}}",
		"{{etapa_atual}}",
		"{{instancia_atual}}",
		"{{status_atual}}",
		"{{responsavel}}",
	}
}

var _ = errors.New // keep import warm
