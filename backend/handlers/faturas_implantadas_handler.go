package handlers

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

// GET /api/v1/faturas-implantadas?id_uc=...&mes=...&mes=...&meses=csv
// Se nenhum mês for informado, retorna as últimas 12 faturas do id_uc.
// @Summary Listar faturas implantadas por UC
// @Tags Faturas
// @Produce json
// @Param id_uc query string false "ID UC"
// @Param unidade query string false "Unidade"
// @Param mes query []string false "Meses"
// @Param meses query string false "Meses (csv)"
// @Success 200 {object} map[string]any
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/faturas-implantadas [get]
func GetFaturasImplantadasByIdUC(c *gin.Context) {
	idUcParam := strings.TrimSpace(c.Query("id_uc"))
	unidadeParam := strings.TrimSpace(c.Query("unidade"))
	if idUcParam == "" && unidadeParam == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id_uc ou unidade obrigatórios"})
		return
	}

	// Resolve id_uc a partir de 'id_uc' (numérico) ou 'unidade' (string UC)
	idUc := ""
	if idUcParam != "" {
		// Se não for numérico, tente resolver como 'unidade'
		if _, err := strconv.ParseInt(idUcParam, 10, 64); err == nil {
			idUc = idUcParam
		} else {
			unidadeParam = idUcParam
		}
	}
	if idUc == "" && unidadeParam != "" {
		// Busca id_uc pela unidade
		var resolved sql.NullInt64
		if err := database.DB_Consulta.QueryRow(`SELECT u.id_uc FROM Amee_Serving.Unidade u WHERE u.unidade = ?`, unidadeParam).Scan(&resolved); err == nil && resolved.Valid {
			idUc = strconv.FormatInt(resolved.Int64, 10)
		}
	}
	if idUc == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "UC não encontrada"})
		return
	}

	meses := c.QueryArray("mes")
	if csv := strings.TrimSpace(c.Query("meses")); csv != "" {
		for _, part := range strings.Split(csv, ",") {
			if s := strings.TrimSpace(part); s != "" {
				meses = append(meses, s)
			}
		}
	}

	// Sem meses: últimas 12
	if len(meses) == 0 {
		rows, err := database.DB_Consulta.Query(`
            SELECT
                t.id_fatura,
                t.Mes_Ref,
                t.Dt_Vencimento,
                t.Link,
                t.Valor_Total,
                COUNT(*) OVER () AS total_faturas
            FROM (
                SELECT fi.id_fatura, fi.Mes_Ref, fi.Dt_Vencimento, fi.Link, fi.Valor_Total
                  FROM Amee_Serving.Faturas_Implantadas fi
                 WHERE fi.id_uc = ?
                 ORDER BY fi.Mes_Ref DESC
            ) AS t
            LIMIT 12`, idUc)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao buscar faturas"})
			return
		}
		defer rows.Close()
		type Item struct {
			ID           sql.NullInt64
			MesRef       sql.NullString
			Venc         sql.NullString
			Link         sql.NullString
			Valor        sql.NullFloat64
			TotalFaturas sql.NullInt64
		}
		out := []gin.H{}
		for rows.Next() {
			var it Item
			if err := rows.Scan(&it.ID, &it.MesRef, &it.Venc, &it.Link, &it.Valor, &it.TotalFaturas); err == nil {
				out = append(out, gin.H{
					"id_fatura": func() int64 {
						if it.ID.Valid {
							return it.ID.Int64
						}
						return 0
					}(),
					"mes_ref":       strings.TrimSpace(it.MesRef.String),
					"dt_vencimento": strings.TrimSpace(it.Venc.String),
					"link":          strings.TrimSpace(it.Link.String),
					"valor_total": func() float64 {
						if it.Valor.Valid {
							return it.Valor.Float64
						}
						return 0
					}(),
					"total_faturas": func() int64 {
						if it.TotalFaturas.Valid {
							return it.TotalFaturas.Int64
						}
						return 0
					}(),
				})
			}
		}
		c.JSON(http.StatusOK, gin.H{"faturas": out})
		return
	}

	// Com meses: monta condições por intervalo ou mês único normalizado para 1o dia
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
				return y + "-" + m + "-01", nil
			}
			if len(parts[1]) == 4 { // mm-yyyy
				m, y := parts[0], parts[1]
				if len(m) == 1 {
					m = "0" + m
				}
				return y + "-" + m + "-01", nil
			}
		case 3: // dd-mm-yyyy
			y, m := parts[2], parts[1]
			if len(m) == 1 {
				m = "0" + m
			}
			return y + "-" + m + "-01", nil
		}
		return "", gin.Error{Err: nil}
	}

	conds := []string{}
	args := []any{idUc}
	for _, m := range meses {
		raw := strings.TrimSpace(m)
		low := strings.ToLower(raw)
		low = strings.ReplaceAll(low, "ate", " a ")
		low = strings.ReplaceAll(low, "ate", " a ")
		if strings.Contains(low, " a ") {
			parts := strings.SplitN(raw, " a ", 2)
			if len(parts) == 2 {
				s1, _ := normalize(parts[0])
				s2, _ := normalize(parts[1])
				if s1 != "" && s2 != "" {
					conds = append(conds, "(Mes_Ref >= ? AND Mes_Ref < DATE_ADD(?, INTERVAL 1 MONTH))")
					args = append(args, s1, s2)
					continue
				}
			}
		}
		s1, _ := normalize(raw)
		if s1 != "" {
			conds = append(conds, "(Mes_Ref >= ? AND Mes_Ref < DATE_ADD(?, INTERVAL 1 MONTH))")
			args = append(args, s1, s1)
		}
	}
	if len(conds) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "meses inválidos"})
		return
	}

	q := "SELECT id_fatura, Mes_Ref, Dt_Vencimento, Link, Valor_Total, COUNT(*) OVER () AS total_faturas FROM Amee_Serving.Faturas_Implantadas WHERE id_uc = ? AND (" + strings.Join(conds, " OR ") + ") ORDER BY Mes_Ref DESC"
	rows, err := database.DB_Consulta.Query(q, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao buscar faturas"})
		return
	}
	defer rows.Close()
	type Item struct {
		ID           sql.NullInt64
		MesRef       sql.NullString
		Venc         sql.NullString
		Link         sql.NullString
		Valor        sql.NullFloat64
		TotalFaturas sql.NullInt64
	}
	out := []gin.H{}
	for rows.Next() {
		var it Item
		if err := rows.Scan(&it.ID, &it.MesRef, &it.Venc, &it.Link, &it.Valor, &it.TotalFaturas); err == nil {
			out = append(out, gin.H{
				"id_fatura": func() int64 {
					if it.ID.Valid {
						return it.ID.Int64
					}
					return 0
				}(),
				"mes_ref":       strings.TrimSpace(it.MesRef.String),
				"dt_vencimento": strings.TrimSpace(it.Venc.String),
				"link":          strings.TrimSpace(it.Link.String),
				"valor_total": func() float64 {
					if it.Valor.Valid {
						return it.Valor.Float64
					}
					return 0
				}(),
				"total_faturas": func() int64 {
					if it.TotalFaturas.Valid {
						return it.TotalFaturas.Int64
					}
					return 0
				}(),
			})
		}
	}
	c.JSON(http.StatusOK, gin.H{"faturas": out})
}

// GET /api/v1/faturas-implantadas/count?id_uc=...
// @Summary Contar faturas implantadas por UC
// @Tags Faturas
// @Produce json
// @Param id_uc query string true "ID UC"
// @Success 200 {object} map[string]int
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/faturas-implantadas/count [get]
func CountFaturasImplantadasByIdUC(c *gin.Context) {
	idUc := strings.TrimSpace(c.Query("id_uc"))
	if idUc == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id_uc obrigatório"})
		return
	}
	var n int
	if err := database.DB_Consulta.QueryRow(`SELECT COUNT(*) FROM Amee_Serving.Faturas_Implantadas WHERE id_uc = ?`, idUc).Scan(&n); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao contar faturas"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"count": n})
}

// GET /api/v1/faturas-implantadas/meses?id_uc=...
// Retorna meses distintos (YYYY-MM) baseados em Mes_Ref para o id_uc informado, em ordem crescente.
// @Summary Listar meses de faturas implantadas
// @Tags Faturas
// @Produce json
// @Param id_uc query string true "ID UC"
// @Success 200 {object} map[string][]string
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/faturas-implantadas/meses [get]
func GetFaturasImplantadasMeses(c *gin.Context) {
	idUc := strings.TrimSpace(c.Query("id_uc"))
	if idUc == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id_uc obrigat\u00f3rio"})
		return
	}
	rows, err := database.DB_Consulta.Query(`
        SELECT DISTINCT DATE_FORMAT(Mes_Ref, '%Y-%m') AS mes
          FROM Amee_Serving.Faturas_Implantadas
         WHERE id_uc = ?
         ORDER BY mes ASC`, idUc)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao buscar meses"})
		return
	}
	defer rows.Close()
	meses := []string{}
	for rows.Next() {
		var ms sql.NullString
		if err := rows.Scan(&ms); err == nil {
			s := strings.TrimSpace(ms.String)
			if s != "" {
				meses = append(meses, s)
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{"meses": meses})
}

// GET /api/v1/faturas-implantadas/todas?id_uc=...
// Lista todas as faturas do id_uc informado (sem LIMIT), ordenadas por Mes_Ref ASC, incluindo total_faturas via window function.
// @Summary Listar todas faturas implantadas
// @Tags Faturas
// @Produce json
// @Param id_uc query string true "ID UC"
// @Param id_empresa query string false "ID empresa"
// @Success 200 {object} map[string]any
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/faturas-implantadas/todas [get]
func GetFaturasImplantadasAllByIdUC(c *gin.Context) {
	idUc := strings.TrimSpace(c.Query("id_uc"))
	idEmp := strings.TrimSpace(c.Query("id_empresa"))
	if idUc == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id_uc obrigat\u00f3rio"})
		return
	}
	base := `
        SELECT
            fi.id_fatura,
            fi.Mes_Ref,
            fi.Dt_Vencimento,
            fi.Link,
            fi.Valor_Total,
            COUNT(*) OVER () AS total_faturas
        FROM Amee_Serving.Faturas_Implantadas fi
        WHERE fi.id_uc = ?`
	args := []any{idUc}
	if idEmp != "" {
		base += " AND fi.id_empresa = ?"
		args = append(args, idEmp)
	}
	base += " ORDER BY fi.Mes_Ref ASC"
	rows, err := database.DB_Consulta.Query(base, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao buscar faturas"})
		return
	}
	defer rows.Close()
	type Item struct {
		ID           sql.NullInt64
		MesRef       sql.NullString
		Venc         sql.NullString
		Link         sql.NullString
		Valor        sql.NullFloat64
		TotalFaturas sql.NullInt64
	}
	out := []gin.H{}
	for rows.Next() {
		var it Item
		if err := rows.Scan(&it.ID, &it.MesRef, &it.Venc, &it.Link, &it.Valor, &it.TotalFaturas); err == nil {
			out = append(out, gin.H{
				"id_fatura": func() int64 {
					if it.ID.Valid {
						return it.ID.Int64
					}
					return 0
				}(),
				"mes_ref":       strings.TrimSpace(it.MesRef.String),
				"dt_vencimento": strings.TrimSpace(it.Venc.String),
				"link":          strings.TrimSpace(it.Link.String),
				"valor_total": func() float64 {
					if it.Valor.Valid {
						return it.Valor.Float64
					}
					return 0
				}(),
				"total_faturas": func() int64 {
					if it.TotalFaturas.Valid {
						return it.TotalFaturas.Int64
					}
					return 0
				}(),
			})
		}
	}
	c.JSON(http.StatusOK, gin.H{"faturas": out})
}
