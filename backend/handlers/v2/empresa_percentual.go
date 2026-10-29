package v2

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

// ============================================================================
// DM_EMPRESA_PERCENTUAL — percentual de ganho da AMEE por empresa, com histórico
// de vigências (uma empresa pode ter N períodos com % diferentes ao longo do tempo).
// ============================================================================

type empresaPercVigenteOut struct {
	IDEmpresaPercentual    int      `json:"id_empresa_percentual"`
	CodEmpresa             int      `json:"cod_empresa"`
	NomeEmpresa            string   `json:"nome_empresa"`
	CNPJ                   string   `json:"cnpj"`
	PercentualSimples      *float64 `json:"percentual_simples"`
	PercentualDobro        *float64 `json:"percentual_dobro"`
	DataVigenciaInicio     string   `json:"data_vigencia_inicio"`
	QtdVigenciasAnteriores int      `json:"qtd_vigencias_anteriores"`
}

// ListEmpresasPercentualVigentes — GET /api/v2/empresas-percentual
// Lista a vigência ATUAL de cada empresa (1 linha por empresa).
func ListEmpresasPercentualVigentes(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}

	const q = `
SELECT v.id_empresa_percentual, v.cod_empresa,
       COALESCE(v.nome_empresa, '') AS nome_empresa,
       COALESCE(v.cnpj, '') AS cnpj,
       v.percentual_simples, v.percentual_dobro,
       DATE(v.data_vigencia_inicio) AS data_vigencia_inicio,
       (SELECT COUNT(*) FROM DM_EMPRESA_PERCENTUAL h
         WHERE h.cod_empresa = v.cod_empresa
           AND h.id_empresa_percentual <> v.id_empresa_percentual
           AND h.ativo = 1) AS qtd_vigencias_anteriores
  FROM DM_EMPRESA_PERCENTUAL v
 WHERE v.ativo = 1
   AND v.data_vigencia_fim IS NULL
 ORDER BY COALESCE(v.nome_empresa, CAST(v.cod_empresa AS CHAR))`

	rows, err := db.QueryContext(c.Request.Context(), q)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	defer rows.Close()

	items := []empresaPercVigenteOut{}
	for rows.Next() {
		var (
			it   empresaPercVigenteOut
			ps   sql.NullFloat64
			pd   sql.NullFloat64
			data sql.NullString
		)
		if err := rows.Scan(&it.IDEmpresaPercentual, &it.CodEmpresa,
			&it.NomeEmpresa, &it.CNPJ,
			&ps, &pd, &data, &it.QtdVigenciasAnteriores); err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", "scan: "+err.Error(), nil)
			return
		}
		if ps.Valid {
			v := ps.Float64
			it.PercentualSimples = &v
		}
		if pd.Valid {
			v := pd.Float64
			it.PercentualDobro = &v
		}
		if data.Valid {
			it.DataVigenciaInicio = data.String
		}
		items = append(items, it)
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

// GetEmpresaPercentualHistorico — GET /api/v2/empresas-percentual/:cod_empresa/historico
// Lista todas as vigências (ativas + fechadas) de uma empresa, do mais antigo ao mais recente.
func GetEmpresaPercentualHistorico(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	codStr := c.Param("cod_empresa")
	cod, err := strconv.Atoi(codStr)
	if err != nil {
		apiError(c, http.StatusBadRequest, "PARAM_INVALIDO", "cod_empresa deve ser int", nil)
		return
	}

	rows, err := db.QueryContext(c.Request.Context(), `
SELECT id_empresa_percentual,
       COALESCE(nome_empresa,'') AS nome_empresa,
       COALESCE(cnpj,'') AS cnpj,
       percentual_simples, percentual_dobro,
       DATE(data_vigencia_inicio), data_vigencia_fim,
       COALESCE(motivo_alteracao,'') AS motivo,
       COALESCE(observacao,'') AS observacao,
       ativo
  FROM DM_EMPRESA_PERCENTUAL
 WHERE cod_empresa = ?
 ORDER BY data_vigencia_inicio ASC, id_empresa_percentual ASC`, cod)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	defer rows.Close()

	var (
		nomeEmpresa string
		cnpj        string
	)
	vigencias := []gin.H{}
	for rows.Next() {
		var (
			id                       int
			nomeAtual, cnpjAtual     string
			ps, pd                   sql.NullFloat64
			dtInicio                 sql.NullString
			dtFim                    sql.NullTime
			motivo, observacao       string
			ativo                    int
		)
		if err := rows.Scan(&id, &nomeAtual, &cnpjAtual, &ps, &pd,
			&dtInicio, &dtFim, &motivo, &observacao, &ativo); err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", "scan: "+err.Error(), nil)
			return
		}
		if nomeEmpresa == "" && nomeAtual != "" {
			nomeEmpresa = nomeAtual
		}
		if cnpj == "" && cnpjAtual != "" {
			cnpj = cnpjAtual
		}
		v := gin.H{
			"id_empresa_percentual": id,
			"data_vigencia_inicio":  dtInicio.String,
			"motivo_alteracao":      nullableStr(motivo),
			"observacao":            nullableStr(observacao),
			"ativo":                 ativo == 1,
		}
		if ps.Valid {
			v["percentual_simples"] = ps.Float64
		}
		if pd.Valid {
			v["percentual_dobro"] = pd.Float64
		}
		if dtFim.Valid {
			v["data_vigencia_fim"] = dtFim.Time.Format("2006-01-02")
		} else {
			v["data_vigencia_fim"] = nil
			v["vigente"] = true
		}
		vigencias = append(vigencias, v)
	}

	c.JSON(http.StatusOK, gin.H{
		"cod_empresa":  cod,
		"nome_empresa": nomeEmpresa,
		"cnpj":         cnpj,
		"vigencias":    vigencias,
	})
}

// NovaVigenciaRequest — body do POST /api/v2/empresas-percentual/:cod_empresa/vigencia
type NovaVigenciaRequest struct {
	NomeEmpresa        string   `json:"nome_empresa"`
	CNPJ               string   `json:"cnpj"`
	DataVigenciaInicio string   `json:"data_vigencia_inicio"` // YYYY-MM-DD
	PercentualSimples  *float64 `json:"percentual_simples"`
	PercentualDobro    *float64 `json:"percentual_dobro"`
	MotivoAlteracao    string   `json:"motivo_alteracao"`
	Observacao         string   `json:"observacao"`
}

// CriarVigenciaEmpresa — POST /api/v2/empresas-percentual/:cod_empresa/vigencia
// Cria uma nova vigência. Se já houver vigência atual (data_vigencia_fim IS NULL),
// ela é fechada automaticamente com data_vigencia_fim = nova.data_vigencia_inicio - 1 dia.
func CriarVigenciaEmpresa(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	codStr := c.Param("cod_empresa")
	cod, err := strconv.Atoi(codStr)
	if err != nil {
		apiError(c, http.StatusBadRequest, "PARAM_INVALIDO", "cod_empresa deve ser int", nil)
		return
	}

	var req NovaVigenciaRequest
	if !bindJSON(c, &req) {
		return
	}
	if req.DataVigenciaInicio == "" {
		apiError(c, http.StatusBadRequest, "CAMPO_OBRIGATORIO",
			"data_vigencia_inicio é obrigatório (YYYY-MM-DD)", nil)
		return
	}

	idUser := resolverUsuarioV2(c, db)
	tx, err := db.BeginTx(c.Request.Context(), nil)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	defer func() { _ = tx.Rollback() }()

	// Fecha vigência atual (se existir)
	if _, err := tx.ExecContext(c.Request.Context(), `
UPDATE DM_EMPRESA_PERCENTUAL
   SET data_vigencia_fim = DATE_SUB(?, INTERVAL 1 DAY)
 WHERE cod_empresa = ?
   AND ativo = 1
   AND data_vigencia_fim IS NULL`, req.DataVigenciaInicio, cod); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "fechar atual: "+err.Error(), nil)
		return
	}

	// Insere a nova
	res, err := tx.ExecContext(c.Request.Context(), `
INSERT INTO DM_EMPRESA_PERCENTUAL (
  cod_empresa, nome_empresa, cnpj,
  percentual_simples, percentual_dobro,
  data_vigencia_inicio, data_vigencia_fim,
  motivo_alteracao, observacao, ativo, id_usuario_criacao
) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, ?)`,
		cod, nullableStr(req.NomeEmpresa), nullableStr(req.CNPJ),
		req.PercentualSimples, req.PercentualDobro,
		req.DataVigenciaInicio,
		nullableStr(req.MotivoAlteracao), nullableStr(req.Observacao),
		nilUser(idUser))
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "insert vigência: "+err.Error(), nil)
		return
	}
	newID, _ := res.LastInsertId()

	if err := tx.Commit(); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "commit: "+err.Error(), nil)
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"id_empresa_percentual": newID,
		"cod_empresa":           cod,
	})
}

// AtualizarVigencia — PUT /api/v2/empresas-percentual/vigencia/:id
// Corrige uma vigência existente (sem criar nova). Use só pra correção de erro.
func AtualizarVigencia(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}

	var req NovaVigenciaRequest
	if !bindJSON(c, &req) {
		return
	}

	res, err := db.ExecContext(c.Request.Context(), `
UPDATE DM_EMPRESA_PERCENTUAL SET
  nome_empresa = COALESCE(?, nome_empresa),
  cnpj = COALESCE(?, cnpj),
  percentual_simples = ?,
  percentual_dobro = ?,
  data_vigencia_inicio = COALESCE(?, data_vigencia_inicio),
  motivo_alteracao = ?,
  observacao = ?
WHERE id_empresa_percentual = ?`,
		nullableStr(req.NomeEmpresa), nullableStr(req.CNPJ),
		req.PercentualSimples, req.PercentualDobro,
		nullableStr(req.DataVigenciaInicio),
		nullableStr(req.MotivoAlteracao), nullableStr(req.Observacao),
		id)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		apiError(c, http.StatusNotFound, "VIGENCIA_NAO_ENCONTRADA",
			"Vigência não existe", nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"id_empresa_percentual": id})
}

// DesativarVigencia — DELETE /api/v2/empresas-percentual/vigencia/:id
// Marca como inativa (ativo=0). Não dropa pra preservar histórico.
func DesativarVigencia(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}
	res, err := db.ExecContext(c.Request.Context(),
		"UPDATE DM_EMPRESA_PERCENTUAL SET ativo = 0 WHERE id_empresa_percentual = ?", id)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		apiError(c, http.StatusNotFound, "VIGENCIA_NAO_ENCONTRADA",
			"Vigência não existe", nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"deactivated": true})
}
