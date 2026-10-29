package v2

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
)

// GetDimensoes — GET /api/v2/dimensoes
// Carrega catálogos (DM_*) + distribuidoras derivadas de FT_PROCESSOS.
func GetDimensoes(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}

	out := gin.H{}

	type kv struct {
		ID   int    `json:"id"`
		Nome string `json:"nome"`
	}
	loadKV := func(query string) ([]kv, error) {
		rows, err := db.QueryContext(c.Request.Context(), query)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var items []kv
		for rows.Next() {
			var k kv
			if err := rows.Scan(&k.ID, &k.Nome); err != nil {
				return nil, err
			}
			items = append(items, k)
		}
		return items, rows.Err()
	}

	// Instâncias
	v, err := loadKV("SELECT id_instancia, nome FROM DM_INSTANCIAS ORDER BY ordem, id_instancia")
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "instancias: "+err.Error(), nil)
		return
	}
	out["instancias"] = v

	// Etapas (com ordem)
	type etapaOut struct {
		ID    int    `json:"id"`
		Nome  string `json:"nome"`
		Ordem int    `json:"ordem"`
	}
	var etapas []etapaOut
	rows, err := db.QueryContext(c.Request.Context(),
		"SELECT id_etapa, nome, ordem FROM DM_ETAPAS ORDER BY ordem")
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "etapas: "+err.Error(), nil)
		return
	}
	for rows.Next() {
		var e etapaOut
		if err := rows.Scan(&e.ID, &e.Nome, &e.Ordem); err != nil {
			rows.Close()
			apiError(c, http.StatusInternalServerError, "DB_ERR", "etapas scan: "+err.Error(), nil)
			return
		}
		etapas = append(etapas, e)
	}
	rows.Close()
	out["etapas"] = etapas

	// Status processo
	v, err = loadKV("SELECT id_status, nome FROM DM_STATUS_PROCESSO ORDER BY id_status")
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "status: "+err.Error(), nil)
		return
	}
	out["status"] = v

	// Aprovações
	v, err = loadKV("SELECT id_aprovacao, nome FROM DM_STATUS_APROVACAO ORDER BY id_aprovacao")
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "aprovacoes: "+err.Error(), nil)
		return
	}
	out["aprovacoes"] = v

	// Prioridades (com cor)
	type prioOut struct {
		ID   int    `json:"id"`
		Nome string `json:"nome"`
		Cor  string `json:"cor"`
	}
	var prios []prioOut
	// DM_PRIORIDADE: coluna real é `prioridade` (não `nome`); sem peso/cor_hex
	rows, err = db.QueryContext(c.Request.Context(),
		"SELECT id_prioridade, prioridade, '' FROM DM_PRIORIDADE ORDER BY id_prioridade")
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "prioridades: "+err.Error(), nil)
		return
	}
	for rows.Next() {
		var p prioOut
		if err := rows.Scan(&p.ID, &p.Nome, &p.Cor); err != nil {
			rows.Close()
			apiError(c, http.StatusInternalServerError, "DB_ERR", "prioridades scan: "+err.Error(), nil)
			return
		}
		prios = append(prios, p)
	}
	rows.Close()
	out["prioridades"] = prios

	// Formas de devolução
	type formaOut struct {
		ID                   int    `json:"id"`
		Nome                 string `json:"nome"`
		RequerDadosBancarios bool   `json:"requer_dados_bancarios"`
	}
	var formas []formaOut
	rows, err = db.QueryContext(c.Request.Context(),
		"SELECT id_forma, nome, requer_dados_bancarios FROM DM_FORMAS_DEVOLUCAO ORDER BY id_forma")
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "formas_devolucao: "+err.Error(), nil)
		return
	}
	for rows.Next() {
		var f formaOut
		var requer int
		if err := rows.Scan(&f.ID, &f.Nome, &requer); err != nil {
			rows.Close()
			apiError(c, http.StatusInternalServerError, "DB_ERR", "formas scan: "+err.Error(), nil)
			return
		}
		f.RequerDadosBancarios = requer == 1
		formas = append(formas, f)
	}
	rows.Close()
	out["formas_devolucao"] = formas

	// Distribuidoras (derivado — não há tabela)
	type distOut struct {
		Nome string `json:"nome"`
	}
	var dists []distOut
	rows, err = db.QueryContext(c.Request.Context(),
		"SELECT DISTINCT TRIM(concessionaria) AS nome FROM FT_PROCESSOS "+
			"WHERE concessionaria IS NOT NULL AND TRIM(concessionaria) <> '' ORDER BY nome")
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "distribuidoras: "+err.Error(), nil)
		return
	}
	for rows.Next() {
		var d distOut
		if err := rows.Scan(&d.Nome); err != nil {
			rows.Close()
			apiError(c, http.StatusInternalServerError, "DB_ERR", "distribuidoras scan: "+err.Error(), nil)
			return
		}
		dists = append(dists, d)
	}
	rows.Close()
	out["distribuidoras"] = dists

	// Clientes (derivado — DISTINCT de FT_PROCESSOS.cliente)
	type cliOut struct {
		Nome string `json:"nome"`
	}
	var clientes []cliOut
	rows, err = db.QueryContext(c.Request.Context(),
		"SELECT DISTINCT TRIM(cliente) AS nome FROM FT_PROCESSOS "+
			"WHERE cliente IS NOT NULL AND TRIM(cliente) <> '' ORDER BY nome")
	if err == nil {
		for rows.Next() {
			var ci cliOut
			if err := rows.Scan(&ci.Nome); err == nil {
				clientes = append(clientes, ci)
			}
		}
		rows.Close()
	}
	out["clientes"] = clientes

	// Tipos / Subtipos de irregularidade
	v, err = loadKV("SELECT id_tipo, nome FROM DM_TIPO_IRREGULARIDADE ORDER BY nome")
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "tipos: "+err.Error(), nil)
		return
	}
	out["tipos_irregularidade"] = v

	type subtipoOut struct {
		ID     int    `json:"id"`
		IDTipo int    `json:"id_tipo"`
		Nome   string `json:"nome"`
	}
	var subs []subtipoOut
	rows, err = db.QueryContext(c.Request.Context(),
		"SELECT id_subtipo, id_tipo, nome FROM DM_SUBTIPO_IRREGULARIDADE ORDER BY id_tipo, nome")
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "subtipos: "+err.Error(), nil)
		return
	}
	for rows.Next() {
		var s subtipoOut
		if err := rows.Scan(&s.ID, &s.IDTipo, &s.Nome); err != nil {
			rows.Close()
			apiError(c, http.StatusInternalServerError, "DB_ERR", "subtipos scan: "+err.Error(), nil)
			return
		}
		subs = append(subs, s)
	}
	rows.Close()
	out["subtipos_irregularidade"] = subs

	// Percentuais de repasse por empresa — TODAS as vigências (ativas + fechadas)
	// pra permitir cálculo retroativo no front (processo deferido em 2023 usa o % de 2023).
	type vigPercOut struct {
		ID                  int      `json:"id"`
		DataVigenciaInicio  string   `json:"data_vigencia_inicio"`
		DataVigenciaFim     *string  `json:"data_vigencia_fim"`
		PercentualSimples   *float64 `json:"percentual_simples"`
		PercentualDobro     *float64 `json:"percentual_dobro"`
	}
	type empPercOut struct {
		CodEmpresa  int          `json:"cod_empresa"`
		NomeEmpresa string       `json:"nome_empresa"`
		Vigencias   []vigPercOut `json:"vigencias"`
	}
	mapEmp := map[int]*empPercOut{}
	rows, err = db.QueryContext(c.Request.Context(), `
SELECT id_empresa_percentual, cod_empresa, COALESCE(nome_empresa, '') AS nome_empresa,
       DATE(data_vigencia_inicio), data_vigencia_fim,
       percentual_simples, percentual_dobro
  FROM DM_EMPRESA_PERCENTUAL
 WHERE ativo = 1
 ORDER BY cod_empresa, data_vigencia_inicio`)
	if err == nil {
		for rows.Next() {
			var (
				id      int
				cod     int
				nome    string
				di      string
				df      sql.NullTime
				ps, pd  sql.NullFloat64
			)
			if err := rows.Scan(&id, &cod, &nome, &di, &df, &ps, &pd); err == nil {
				e, ok := mapEmp[cod]
				if !ok {
					e = &empPercOut{CodEmpresa: cod, NomeEmpresa: nome, Vigencias: []vigPercOut{}}
					mapEmp[cod] = e
				}
				if e.NomeEmpresa == "" && nome != "" {
					e.NomeEmpresa = nome
				}
				v := vigPercOut{ID: id, DataVigenciaInicio: di}
				if df.Valid {
					s := df.Time.Format("2006-01-02")
					v.DataVigenciaFim = &s
				}
				if ps.Valid {
					f := ps.Float64
					v.PercentualSimples = &f
				}
				if pd.Valid {
					f := pd.Float64
					v.PercentualDobro = &f
				}
				e.Vigencias = append(e.Vigencias, v)
			}
		}
		rows.Close()
	}
	percEmpresas := make([]empPercOut, 0, len(mapEmp))
	for _, e := range mapEmp {
		percEmpresas = append(percEmpresas, *e)
	}
	out["percentuais_empresa"] = percEmpresas

	// Canais de comunicação (DM_CANAIS_COMUNICACAO)
	type canalOut struct {
		ID    int    `json:"id"`
		Nome  string `json:"nome"`
		Icone string `json:"icone"`
	}
	var canais []canalOut
	rows, err = db.QueryContext(c.Request.Context(),
		"SELECT id_canal, nome, COALESCE(icone,'') FROM DM_CANAIS_COMUNICACAO ORDER BY id_canal")
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "canais: "+err.Error(), nil)
		return
	}
	for rows.Next() {
		var ch canalOut
		if err := rows.Scan(&ch.ID, &ch.Nome, &ch.Icone); err != nil {
			rows.Close()
			apiError(c, http.StatusInternalServerError, "DB_ERR", "canais scan: "+err.Error(), nil)
			return
		}
		canais = append(canais, ch)
	}
	rows.Close()
	out["canais_comunicacao"] = canais

	c.JSON(http.StatusOK, out)
}
