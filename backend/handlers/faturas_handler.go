package handlers

import (
	"database/sql"
	"fmt"
	"math"
	"net/http"
	"ressarcimento-backend/database"
	"ressarcimento-backend/models"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

// GetFaturas busca faturas com base em filtros, agora com paginação.
func GetFaturas(c *gin.Context) {
	// Branch: quando informado ?unidade=&mes=..., consulta Amee_Serving.Unidade + Faturas_Implantadas
	if unidade := strings.TrimSpace(c.Query("unidade")); unidade != "" {
		meses := c.QueryArray("mes")
		if len(meses) == 0 {
			// Sem meses: retornar últimas 12 faturas da unidade
			q := "SELECT fi.id_fatura, fi.Mes_Ref, fi.Dt_Vencimento, fi.Link, fi.Valor_Total\n" +
				"FROM Amee_Serving.Unidade u\n" +
				"JOIN Amee_Serving.Faturas_Implantadas fi ON fi.id_uc = u.id_uc AND fi.id_empresa = u.id_empresa\n" +
				"WHERE u.unidade = ? ORDER BY fi.Mes_Ref DESC LIMIT 12"
			rows, err := database.DB_Consulta.Query(q, unidade)
			if err != nil {
				fmt.Printf("[GetFaturas] erro query unidade/12: %v\n", err)
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			defer rows.Close()
			type Fat struct {
				ID         sql.NullInt64   `json:"id_fatura"`
				MesRef     sql.NullString  `json:"mes_ref"`
				Vencimento sql.NullString  `json:"dt_vencimento"`
				Link       sql.NullString  `json:"link"`
				ValorTotal sql.NullFloat64 `json:"valor_total"`
			}
			out := []Fat{}
			for rows.Next() {
				var f Fat
				if err := rows.Scan(&f.ID, &f.MesRef, &f.Vencimento, &f.Link, &f.ValorTotal); err == nil {
					out = append(out, f)
				}
			}
			type Item struct {
				IDFatura     int64   `json:"id_fatura"`
				MesRef       string  `json:"mes_ref"`
				DtVencimento string  `json:"dt_vencimento"`
				Link         string  `json:"link"`
				ValorTotal   float64 `json:"valor_total"`
			}
			items := make([]Item, 0, len(out))
			for _, f := range out {
				it := Item{}
				if f.ID.Valid {
					it.IDFatura = f.ID.Int64
				}
				if f.MesRef.Valid {
					it.MesRef = f.MesRef.String
				}
				if f.Vencimento.Valid {
					it.DtVencimento = f.Vencimento.String
				}
				if f.Link.Valid {
					it.Link = f.Link.String
				}
				if f.ValorTotal.Valid {
					it.ValorTotal = f.ValorTotal.Float64
				}
				items = append(items, it)
			}
			c.JSON(http.StatusOK, gin.H{"faturas": items})
			return
		}

		normalize := func(s string) (string, error) {
			s = strings.TrimSpace(s)
			s = strings.ReplaceAll(s, "/", "-")
			parts := strings.Split(s, "-")
			switch len(parts) {
			case 2:
				if len(parts[0]) == 4 { // yyyy-mm
					y, m := parts[0], parts[1]
					if len(m) == 1 {
						m = "0" + m
					}
					return fmt.Sprintf("%s-%s-01", y, m), nil
				}
				if len(parts[1]) == 4 { // mm-yyyy
					m, y := parts[0], parts[1]
					if len(m) == 1 {
						m = "0" + m
					}
					return fmt.Sprintf("%s-%s-01", y, m), nil
				}
			case 3: // dd-mm-yyyy
				y, m := parts[2], parts[1]
				if len(m) == 1 {
					m = "0" + m
				}
				return fmt.Sprintf("%s-%s-01", y, m), nil
			}
			return "", fmt.Errorf("formato invalido: %q", s)
		}

		conds := make([]string, 0, len(meses))
		args := make([]any, 0, 1+len(meses)*2)
		args = append(args, unidade)
		for _, m := range meses {
			rawm := strings.TrimSpace(m)
			low := strings.ToLower(rawm)
			low = strings.ReplaceAll(low, "até", "a")
			low = strings.ReplaceAll(low, "ate", "a")
			if strings.Contains(low, " a ") {
				parts := strings.SplitN(rawm, " a ", 2)
				if len(parts) != 2 {
					tmp := strings.SplitN(strings.ReplaceAll(strings.ReplaceAll(rawm, "até", " a "), "ate", " a "), " a ", 2)
					if len(tmp) == 2 {
						parts = tmp
					}
				}
				if len(parts) == 2 {
					start, err1 := normalize(parts[0])
					end, err2 := normalize(parts[1])
					if err1 != nil || err2 != nil {
						c.JSON(http.StatusBadRequest, gin.H{"error": "intervalo de meses inválido"})
						return
					}
					conds = append(conds, "(fi.Mes_Ref >= ? AND fi.Mes_Ref < DATE_ADD(?, INTERVAL 1 MONTH))")
					args = append(args, start, end)
					continue
				}
			}
			start, err := normalize(rawm)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
				return
			}
			conds = append(conds, "(fi.Mes_Ref >= ? AND fi.Mes_Ref < DATE_ADD(?, INTERVAL 1 MONTH))")
			args = append(args, start, start)
		}

		q := "SELECT fi.id_fatura, fi.Mes_Ref, fi.Dt_Vencimento, fi.Link, fi.Valor_Total\n" +
			"FROM Amee_Serving.Unidade u\n" +
			"JOIN Amee_Serving.Faturas_Implantadas fi ON fi.id_uc = u.id_uc AND fi.id_empresa = u.id_empresa\n" +
			"WHERE u.unidade = ? AND (" + strings.Join(conds, " OR ") + ") ORDER BY fi.Mes_Ref DESC"

		rows, err := database.DB_Consulta.Query(q, args...)
		if err != nil {
			fmt.Printf("[GetFaturas] erro query unidade/meses: %v\n", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		defer rows.Close()

		type Fat struct {
			ID         sql.NullInt64   `json:"id_fatura"`
			MesRef     sql.NullString  `json:"mes_ref"`
			Vencimento sql.NullString  `json:"dt_vencimento"`
			Link       sql.NullString  `json:"link"`
			ValorTotal sql.NullFloat64 `json:"valor_total"`
		}
		out := []Fat{}
		for rows.Next() {
			var f Fat
			if err := rows.Scan(&f.ID, &f.MesRef, &f.Vencimento, &f.Link, &f.ValorTotal); err == nil {
				out = append(out, f)
			}
		}

		type Item struct {
			IDFatura     int64   `json:"id_fatura"`
			MesRef       string  `json:"mes_ref"`
			DtVencimento string  `json:"dt_vencimento"`
			Link         string  `json:"link"`
			ValorTotal   float64 `json:"valor_total"`
		}
		items := make([]Item, 0, len(out))
		for _, f := range out {
			it := Item{}
			if f.ID.Valid {
				it.IDFatura = f.ID.Int64
			}
			if f.MesRef.Valid {
				it.MesRef = f.MesRef.String
			}
			if f.Vencimento.Valid {
				it.DtVencimento = f.Vencimento.String
			}
			if f.Link.Valid {
				it.Link = f.Link.String
			}
			if f.ValorTotal.Valid {
				it.ValorTotal = f.ValorTotal.Float64
			}
			items = append(items, it)
		}
		c.JSON(http.StatusOK, gin.H{"faturas": items})
		return
	}

	// ====== FILTRO PADRÃO COM PAGINAÇÃO ======

	// Padrões de paginação
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	if page < 1 {
		page = 1
	}
	pageSize, _ := strconv.Atoi(c.DefaultQuery("pageSize", "50"))
	if pageSize <= 0 {
		pageSize = 50
	}
	offset := (page - 1) * pageSize

	// Query base para faturas e para contagem
	queryBase := `
        FROM
            Fato_Faturas_Produtividade f
        JOIN
            DM_Empresa e ON f.Cod_Empresa = e.Cod_Empresa
        JOIN
            DM_Concessionaria co ON f.Cod_Concess = co.Cod_Concess
        JOIN
            DM_UC uc ON f.Cod_UC = uc.Cod_UC
    `
	var conditions []string
	var args []interface{}

	// Construção das condições de filtro (WHERE)
	if empresaID := c.Query("empresaId"); empresaID != "" {
		conditions = append(conditions, "f.Cod_Empresa = ?")
		args = append(args, empresaID)
	}
	if concessID := c.Query("concessId"); concessID != "" {
		conditions = append(conditions, "f.Cod_Concess = ?")
		args = append(args, concessID)
	}
	if ucVal := c.Query("uc"); ucVal != "" {
		conditions = append(conditions, "uc.UC LIKE ?")
		args = append(args, "%"+ucVal+"%")
	}
	if cnpj := c.Query("cnpj"); cnpj != "" {
		conditions = append(conditions, "e.CNPJ LIKE ?")
		args = append(args, "%"+cnpj+"%")
	}
	if tensao := c.Query("tensao"); tensao != "" {
		conditions = append(conditions, "uc.Tensao = ?")
		args = append(args, tensao)
	}
	if dataInicio := c.Query("dataInicio"); dataInicio != "" {
		conditions = append(conditions, "f.Data_Emissao >= ?")
		args = append(args, dataInicio)
	}
	if dataFim := c.Query("dataFim"); dataFim != "" {
		conditions = append(conditions, "f.Data_Emissao <= ?")
		args = append(args, dataFim)
	}

	whereClause := ""
	if len(conditions) > 0 {
		whereClause = " WHERE " + strings.Join(conditions, " AND ")
	}

	// 1. Query de Contagem para saber o total de registros
	var totalRecords int
	countQuery := "SELECT COUNT(DISTINCT f.Cod_Fatura)" + queryBase + whereClause
	if database.DB_Consulta == nil {
		fmt.Println("[GetFaturas] DB_Consulta está nil (verifique DB_CONSULTA_URL)")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "DB_Consulta não inicializado"})
		return
	}
	err := database.DB_Consulta.QueryRow(countQuery, args...).Scan(&totalRecords)
	if err != nil {
		fmt.Printf("[GetFaturas] erro ao contar faturas: %v\n", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao contar faturas: " + err.Error()})
		return
	}

	// 2. Query Principal para buscar os dados da página atual
	dataQuery := `
        SELECT DISTINCT
            f.Cod_Fatura,
            f.Tipo, f.Mes_Ref, f.Data_Emissao, f.Data_Vencimento, f.Link, f.Valor_Total, f.Consumo,
            e.Rz_Social AS Empresa,
            co.Sigla AS Concessionaria,
            uc.UC,
            uc.Tensao
    ` + queryBase + whereClause + " ORDER BY f.Data_Vencimento DESC LIMIT ? OFFSET ?"

	// Adiciona os argumentos de paginação
	pagedArgs := append(args, pageSize, offset)

	rows, err := database.DB_Consulta.Query(dataQuery, pagedArgs...)
	if err != nil {
		fmt.Printf("[GetFaturas] erro ao buscar faturas: %v\n", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar faturas: " + err.Error()})
		return
	}
	defer rows.Close()

	var faturas []models.FaturaDetalhada
	for rows.Next() {
		var f models.FaturaDetalhada
		if err := rows.Scan(
			&f.CodFatura, &f.Tipo, &f.MesRef, &f.DataEmissao, &f.DataVencimento, &f.Link, &f.ValorTotal, &f.Consumo,
			&f.EmpresaRazaoSocial, &f.ConcessionariaSigla, &f.UC, &f.Tensao,
		); err != nil {
			fmt.Printf("[GetFaturas] erro ao escanear fatura: %v\n", err)
			continue
		}
		faturas = append(faturas, f)
	}

	c.JSON(http.StatusOK, gin.H{
		"faturas":      faturas,
		"totalRecords": totalRecords,
		"totalPages":   int(math.Ceil(float64(totalRecords) / float64(pageSize))),
		"currentPage":  page,
	})
}

// GetEmpresasParaFiltro busca todas as empresas para preencher a caixa suspensa.
func GetEmpresasParaFiltro(c *gin.Context) {
	if database.DB_Consulta == nil {
		fmt.Println("[GetEmpresasParaFiltro] DB_Consulta está nil (verifique DB_CONSULTA_URL)")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "DB_Consulta não inicializado"})
		return
	}

	var empresas []models.EmpresaFiltro

	// Se sua DM_Empresa não tiver coluna Status, remova o WHERE.
	query := "SELECT Cod_Empresa, Rz_Social FROM DM_Empresa WHERE Status = 'A' ORDER BY Rz_Social ASC"

	rows, err := database.DB_Consulta.Query(query)
	if err != nil {
		fmt.Printf("[GetEmpresasParaFiltro] erro ao buscar empresas: %v\n", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar empresas: " + err.Error()})
		return
	}
	defer rows.Close()

	for rows.Next() {
		var e models.EmpresaFiltro
		if err := rows.Scan(&e.CodEmpresa, &e.RzSocial); err != nil {
			fmt.Printf("[GetEmpresasParaFiltro] erro ao escanear empresa: %v\n", err)
			continue
		}
		empresas = append(empresas, e)
	}
	c.JSON(http.StatusOK, empresas)
}

// GetConcessionariasParaFiltro busca todas as concessionárias para preencher a caixa suspensa.
func GetConcessionariasParaFiltro(c *gin.Context) {
	if database.DB_Consulta == nil {
		fmt.Println("[GetConcessionariasParaFiltro] DB_Consulta está nil (verifique DB_CONSULTA_URL)")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "DB_Consulta não inicializado"})
		return
	}

	var concessionarias []models.ConcessionariaFiltro
	query := "SELECT Cod_Concess, Sigla FROM DM_Concessionaria ORDER BY Sigla ASC"

	rows, err := database.DB_Consulta.Query(query)
	if err != nil {
		fmt.Printf("[GetConcessionariasParaFiltro] erro ao buscar concessionárias: %v\n", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar concessionárias: " + err.Error()})
		return
	}
	defer rows.Close()

	for rows.Next() {
		var co models.ConcessionariaFiltro
		if err := rows.Scan(&co.CodConcess, &co.Sigla); err != nil {
			fmt.Printf("[GetConcessionariasParaFiltro] erro ao escanear concessionária: %v\n", err)
			continue
		}
		concessionarias = append(concessionarias, co)
	}
	c.JSON(http.StatusOK, concessionarias)
}

// GetTensaoParaFiltro busca os tipos de tensão distintos para o filtro.
func GetTensaoParaFiltro(c *gin.Context) {
	if database.DB_Consulta == nil {
		fmt.Println("[GetTensaoParaFiltro] DB_Consulta está nil (verifique DB_CONSULTA_URL)")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "DB_Consulta não inicializado"})
		return
	}

	var tensoes []string
	query := "SELECT DISTINCT Tensao FROM DM_UC WHERE Tensao IS NOT NULL AND Tensao != '' ORDER BY Tensao ASC"

	rows, err := database.DB_Consulta.Query(query)
	if err != nil {
		fmt.Printf("[GetTensaoParaFiltro] erro ao buscar tensões: %v\n", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar tipos de tensão: " + err.Error()})
		return
	}
	defer rows.Close()

	for rows.Next() {
		var t sql.NullString
		if err := rows.Scan(&t); err != nil {
			fmt.Printf("[GetTensaoParaFiltro] erro ao escanear tensão: %v\n", err)
			continue
		}
		if t.Valid {
			tensoes = append(tensoes, t.String)
		}
	}
	c.JSON(http.StatusOK, tensoes)
}

// GET /api/v1/faturas-anos?id_uc=&id_empresa=&id_concessionaria=
// Retorna anos distintos (YYYY) existentes em Faturas_Implantadas conforme filtros informados.
func GetFaturasAnos(c *gin.Context) {
	if database.DB_Consulta == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "DB_Consulta não inicializado"})
		return
	}

	idUC := strings.TrimSpace(c.Query("id_uc"))
	idEmp := strings.TrimSpace(c.Query("id_empresa"))
	idConc := strings.TrimSpace(c.Query("id_concessionaria"))

	base := "SELECT DISTINCT YEAR(Mes_Ref) AS ano FROM Amee_Serving.Faturas_Implantadas WHERE 1=1"
	args := make([]any, 0, 3)
	if idUC != "" {
		base += " AND id_uc = ?"
		args = append(args, idUC)
	}
	if idEmp != "" {
		base += " AND id_empresa = ?"
		args = append(args, idEmp)
	}
	if idConc != "" {
		base += " AND id_concessionaria = ?"
		args = append(args, idConc)
	}
	base += " ORDER BY ano ASC"

	rows, err := database.DB_Consulta.Query(base, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao buscar anos"})
		return
	}
	defer rows.Close()

	out := make([]int, 0, 16)
	for rows.Next() {
		var ano sql.NullInt64
		if err := rows.Scan(&ano); err == nil {
			if ano.Valid {
				out = append(out, int(ano.Int64))
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{"anos": out})
}
