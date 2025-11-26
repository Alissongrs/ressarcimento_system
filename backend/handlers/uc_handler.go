package handlers

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"strings"

	"ressarcimento-backend/database"
	"ressarcimento-backend/models"

	"github.com/gin-gonic/gin"
)

// normaliza entradas como "01-08-2024", "2024-08", "08/2024" ou "082024" -> "YYYY-MM-01"
func normalizeMonth(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", fmt.Errorf("mês vazio")
	}
	// Normaliza separadores
	s = strings.ReplaceAll(s, "/", "-")
	s = strings.ReplaceAll(s, ".", "-")

	parts := strings.Split(s, "-")
	switch len(parts) {
	case 1:
		// Ex.: 082024 (MMYYYY)
		raw := parts[0]
		if len(raw) == 6 { // MMYYYY
			m := raw[:2]
			y := raw[2:]
			if len(m) == 1 {
				m = "0" + m
			}
			return fmt.Sprintf("%s-%s-01", y, m), nil
		}
	case 2: // yyyy-mm ou mm-yyyy
		if len(parts[0]) == 4 { // YYYY-MM
			y, m := parts[0], parts[1]
			if len(m) == 1 {
				m = "0" + m
			}
			return fmt.Sprintf("%s-%s-01", y, m), nil
		}
		if len(parts[1]) == 4 { // MM-YYYY
			m, y := parts[0], parts[1]
			if len(m) == 1 {
				m = "0" + m
			}
			return fmt.Sprintf("%s-%s-01", y, m), nil
		}
	case 3: // dd-mm-yyyy (no Amee_Serving o dia é sempre 1)
		y, m := parts[2], parts[1]
		if len(m) == 1 {
			m = "0" + m
		}
		return fmt.Sprintf("%s-%s-01", y, m), nil
	}
	return "", fmt.Errorf("formato de mês inválido: %q", s)
}

// GetUCByNumero busca os detalhes de uma UC pelo número (apenas dados cadastrais + link de fatura mais recente)
func GetUCByNumero(c *gin.Context) {
	numeroUC := c.Param("numero")

	var ucDetalhes models.UCDetalhes
	var idUC, idEmpresa, idConcess int64

	const q = `
SELECT
  u.unidade,
  e.Rz_Social AS RazaoSocialFatura,
  e.CNPJ      AS CNPJ,
  c.Rz_Social AS Distribuidora,
  CONCAT_WS(', ',
    NULLIF(u.Endereco_1, ''),
    NULLIF(u.Bairro_1,   ''),
    NULLIF(u.Cidade_1,   ''),
    NULLIF(u.Estado_1,   '')
  ) AS EnderecoCompleto,
  (
    SELECT fi.Link
    FROM Amee_Serving.Faturas_Implantadas fi
    WHERE fi.id_uc = u.id_uc AND fi.id_empresa = u.id_empresa
    ORDER BY fi.Dt_Vencimento DESC
    LIMIT 1
  ) AS LinkFatura,
  u.id_uc,
  u.id_empresa,
  u.id_concess
FROM Amee_Serving.Unidade u
LEFT JOIN Amee_Serving.Empresa        e ON u.id_empresa = e.id_empresa
LEFT JOIN Amee_Serving.Concessionaria c ON u.id_concess = c.id_concess
WHERE (u.unidade = ? OR u.id_uc = ?);`

	if err := database.DB_Consulta.QueryRow(q, numeroUC, numeroUC).Scan(
		&ucDetalhes.UC,
		&ucDetalhes.RazaoSocialFatura,
		&ucDetalhes.CNPJ,
		&ucDetalhes.Concessionaria,
		&ucDetalhes.EnderecoCompleto,
		&ucDetalhes.LinkFatura,
		&idUC,
		&idEmpresa,
		&idConcess,
	); err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "UC não encontrada"})
			return
		}
		log.Printf("[GetUCByNumero] erro: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro interno"})
		return
	}

	// compat: preencher "Cliente" com a razão social
	ucDetalhes.Cliente = ucDetalhes.RazaoSocialFatura
	ucDetalhes.IDUC = &idUC
	ucDetalhes.IDEmpresa = &idEmpresa
	ucDetalhes.IDConcessionaria = &idConcess

	// Se foram informados meses (?mes_ref=YYYY-MM, aceita múltiplos e variações),
	// agregamos os links de faturas solicitados ao payload desta rota para facilitar o front.
	// Caso não haja meses, retornamos apenas os dados cadastrais.
	raw := append([]string{}, c.QueryArray("mes_ref")...)
	raw = append(raw, c.QueryArray("mes")...)
	// Limpa entradas vazias
	tmp := raw[:0]
	for _, v := range raw {
		if s := strings.TrimSpace(v); s != "" {
			tmp = append(tmp, s)
		}
	}
	raw = tmp
	if len(raw) > 0 {
		// Monta condição por meses normalizados
		var conds []string
		args := []any{idUC, idEmpresa}
		for _, m := range raw {
			mm := strings.TrimSpace(m)
			low := strings.ToLower(mm)
			low = strings.ReplaceAll(low, "até", "a")
			low = strings.ReplaceAll(low, "ate", "a")
			if strings.Contains(low, " a ") {
				parts := strings.SplitN(strings.ReplaceAll(strings.ReplaceAll(mm, "até", " a "), "ate", " a "), " a ", 2)
				if len(parts) == 2 {
					start, err1 := normalizeMonth(parts[0])
					end, err2 := normalizeMonth(parts[1])
					if err1 == nil && err2 == nil {
						conds = append(conds, "(fi.Mes_Ref >= ? AND fi.Mes_Ref < DATE_ADD(?, INTERVAL 1 MONTH))")
						args = append(args, start, end)
						continue
					}
				}
			}
			start, err := normalizeMonth(mm)
			if err != nil {
				// ignora mês inválido ao invés de abortar a rota toda
				continue
			}
			conds = append(conds, "(fi.Mes_Ref >= ? AND fi.Mes_Ref < DATE_ADD(?, INTERVAL 1 MONTH))")
			args = append(args, start, start)
		}
		if len(conds) > 0 {
			qLinks := "SELECT fi.Mes_Ref, fi.Link FROM Amee_Serving.Faturas_Implantadas fi WHERE fi.id_uc = ? AND fi.id_empresa = ? AND (" + strings.Join(conds, " OR ") + ") ORDER BY fi.Mes_Ref DESC"
			rows, err := database.DB_Consulta.Query(qLinks, args...)
			if err == nil {
				defer rows.Close()
				var dets []models.FaturaLink
				var links []string
				for rows.Next() {
					var mes, link sql.NullString
					if err := rows.Scan(&mes, &link); err == nil {
						m := strings.TrimSpace(mes.String)
						l := strings.TrimSpace(link.String)
						if l != "" {
							dets = append(dets, models.FaturaLink{Link: l, MesRef: m})
							links = append(links, l)
						}
					}
				}
				if len(dets) > 0 {
					ucDetalhes.LinksFaturasDetalhes = dets
					ucDetalhes.LinksFaturas = links
				}
			}
		}
	}

	// expose ids to frontend
	ucDetalhes.IDUC = &idUC
	ucDetalhes.IDEmpresa = &idEmpresa
	c.JSON(http.StatusOK, ucDetalhes)
}

// GetUCOpcoesByNumero retorna todas as combinações de unidade/empresa/concessionária
// para um determinado número de UC, consolidando nomes para exibição.
// GET /api/v1/uc/:numero/opcoes
func GetUCOpcoesByNumero(c *gin.Context) {
	numeroUC := c.Param("numero")
	type Opcao struct {
		IDUC             int64  `json:"id_uc"`
		Unidade          string `json:"unidade"`
		IDEmpresa        int64  `json:"id_empresa"`
		IDConcessionaria int64  `json:"id_concessionaria"`
		Cliente          string `json:"cliente"`
		Concessionaria   string `json:"concessionaria"`
		Sigla            string `json:"sigla"`
	}

	const q = `
SELECT
  u.id_uc,
  u.unidade,
  u.id_empresa,
  u.id_concess,
  COALESCE(e.Rz_Social, '') AS cliente,
  COALESCE(c.Rz_Social, '') AS concessionaria,
  COALESCE(c.Sigla, '')     AS sigla
FROM Amee_Serving.Unidade u
LEFT JOIN Amee_Serving.Empresa        e ON u.id_empresa = e.id_empresa
LEFT JOIN Amee_Serving.Concessionaria c ON u.id_concess = c.id_concess
WHERE u.unidade = ?
ORDER BY e.Rz_Social, c.Sigla`

	rows, err := database.DB_Consulta.Query(q, numeroUC)
	if err != nil {
		log.Printf("[UC] opcoes query error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao buscar opções de UC"})
		return
	}
	defer rows.Close()

	var out []Opcao
	for rows.Next() {
		var it Opcao
		if err := rows.Scan(&it.IDUC, &it.Unidade, &it.IDEmpresa, &it.IDConcessionaria, &it.Cliente, &it.Concessionaria, &it.Sigla); err == nil {
			out = append(out, it)
		}
	}
	if out == nil {
		out = []Opcao{}
	}
	c.JSON(http.StatusOK, gin.H{"opcoes": out})
}

// GetFaturasPorUC retorna links de faturas para a UC informada e meses enviados (?mes_ref=YYYY-MM). Aceita múltiplos.
func GetFaturasPorUC(c *gin.Context) {
	numeroUC := c.Param("numero")
	// Resolve id_uc e id_empresa
	var idUC, idEmpresa int64
	if err := database.DB_Consulta.QueryRow(`SELECT u.id_uc, u.id_empresa FROM Amee_Serving.Unidade u WHERE u.unidade = ?`, numeroUC).Scan(&idUC, &idEmpresa); err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "UC não encontrada"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao buscar UC"})
		return
	}

	// Meses aceitos via ?mes_ref=... (pode repetir) ou ?mes=
	raw := append([]string{}, c.QueryArray("mes_ref")...)
	raw = append(raw, c.QueryArray("mes")...)
	// Limpa
	tmp := raw[:0]
	for _, v := range raw {
		if s := strings.TrimSpace(v); s != "" {
			tmp = append(tmp, s)
		}
	}
	raw = tmp
	if len(raw) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "informe ao menos um mes_ref"})
		return
	}

	var conds []string
	args := []any{idUC, idEmpresa}
	for _, m := range raw {
		mm := strings.TrimSpace(m)
		low := strings.ToLower(mm)
		// aceitar intervalos com "a" ou "até"
		low = strings.ReplaceAll(low, "até", "a")
		low = strings.ReplaceAll(low, "ate", "a")
		if strings.Contains(low, " a ") {
			parts := strings.SplitN(strings.ReplaceAll(strings.ReplaceAll(mm, "até", " a "), "ate", " a "), " a ", 2)
			if len(parts) == 2 {
				start, err1 := normalizeMonth(parts[0])
				end, err2 := normalizeMonth(parts[1])
				if err1 != nil || err2 != nil {
					c.JSON(http.StatusBadRequest, gin.H{"error": "intervalo de meses inválido"})
					return
				}
				conds = append(conds, "(fi.Mes_Ref >= ? AND fi.Mes_Ref < DATE_ADD(?, INTERVAL 1 MONTH))")
				args = append(args, start, end)
				continue
			}
		}
		start, err := normalizeMonth(mm)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		conds = append(conds, "(fi.Mes_Ref >= ? AND fi.Mes_Ref < DATE_ADD(?, INTERVAL 1 MONTH))")
		args = append(args, start, start)
	}

	q := "SELECT fi.id_fatura, fi.Mes_Ref, fi.Link, fi.Dt_Vencimento, fi.Valor_Total FROM Amee_Serving.Faturas_Implantadas fi WHERE fi.id_uc = ? AND fi.id_empresa = ? AND (" + strings.Join(conds, " OR ") + ") ORDER BY fi.Mes_Ref DESC"
	rows, err := database.DB_Consulta.Query(q, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao buscar faturas"})
		return
	}
	defer rows.Close()

	type FaturaItem struct {
		IDFatura     *int64   `json:"id_fatura,omitempty"`
		MesRef       *string  `json:"mes_ref,omitempty"`
		Link         *string  `json:"link,omitempty"`
		DtVencimento *string  `json:"dt_vencimento,omitempty"`
		ValorTotal   *float64 `json:"valor_total,omitempty"`
	}
	out := make([]FaturaItem, 0, 8)
	for rows.Next() {
		var id sql.NullInt64
		var mes, link, venc sql.NullString
		var valor sql.NullFloat64
		if err := rows.Scan(&id, &mes, &link, &venc, &valor); err == nil {
			var idPtr *int64
			var mPtr, lPtr, vPtr *string
			var valPtr *float64
			if id.Valid {
				idPtr = &id.Int64
			}
			if mes.Valid {
				mPtr = &mes.String
			}
			if link.Valid {
				lPtr = &link.String
			}
			if venc.Valid {
				vPtr = &venc.String
			}
			if valor.Valid {
				val := valor.Float64
				valPtr = &val
			}
			out = append(out, FaturaItem{IDFatura: idPtr, MesRef: mPtr, Link: lPtr, DtVencimento: vPtr, ValorTotal: valPtr})
		}
	}
	c.JSON(http.StatusOK, gin.H{"faturas": out, "qtd": len(out), "uc": numeroUC, "id_uc": idUC, "id_emp": idEmpresa})
}

// GetFaturasByUC: retorna faturas com campos adicionais {mes_ref, link, dt_vencimento, valor_total}
func GetFaturasByUC(c *gin.Context) {
	numeroUC := c.Param("numero")
	var idUC, idEmpresa int64
	if err := database.DB_Consulta.QueryRow(`SELECT u.id_uc, u.id_empresa FROM Amee_Serving.Unidade u WHERE u.unidade = ?`, numeroUC).Scan(&idUC, &idEmpresa); err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "UC não encontrada"})
			return
		}
		log.Printf("[GetFaturasByUC] erro UC: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro interno"})
		return
	}

	raw := append([]string{}, c.QueryArray("mes")...)
	raw = append(raw, c.QueryArray("mes_ref")...)
	filt := raw[:0]
	for _, v := range raw {
		if s := strings.TrimSpace(v); s != "" {
			filt = append(filt, s)
		}
	}
	// Sem filtro informado: retorna as últimas 12 faturas da UC/empresa
	if len(filt) == 0 {
		args := []any{idUC, idEmpresa}
		q := `SELECT fi.id_fatura, fi.Mes_Ref, fi.Link, fi.Dt_Vencimento, fi.Valor_Total
              FROM Amee_Serving.Faturas_Implantadas fi
              WHERE fi.id_uc = ? AND fi.id_empresa = ?
              ORDER BY fi.Mes_Ref DESC
              LIMIT 12`
		rows, err := database.DB_Consulta.Query(q, args...)
		if err != nil {
			log.Printf("[GetFaturasByUC] erro faturas (default): %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao buscar faturas"})
			return
		}
		defer rows.Close()
		type FaturaItem struct {
			IDFatura     *int64   `json:"id_fatura,omitempty"`
			MesRef       *string  `json:"mes_ref,omitempty"`
			Link         *string  `json:"link,omitempty"`
			DtVencimento *string  `json:"dt_vencimento,omitempty"`
			ValorTotal   *float64 `json:"valor_total,omitempty"`
		}
		out := make([]FaturaItem, 0, 12)
		for rows.Next() {
			var id sql.NullInt64
			var mes, link, venc sql.NullString
			var valor sql.NullFloat64
			if err := rows.Scan(&id, &mes, &link, &venc, &valor); err == nil {
				var idPtr *int64
				var mPtr, lPtr, vPtr *string
				var valPtr *float64
				if id.Valid {
					idPtr = &id.Int64
				}
				if mes.Valid {
					mPtr = &mes.String
				}
				if link.Valid {
					lPtr = &link.String
				}
				if venc.Valid {
					vPtr = &venc.String
				}
				if valor.Valid {
					val := valor.Float64
					valPtr = &val
				}
				out = append(out, FaturaItem{IDFatura: idPtr, MesRef: mPtr, Link: lPtr, DtVencimento: vPtr, ValorTotal: valPtr})
			}
		}
		c.JSON(http.StatusOK, gin.H{"uc": numeroUC, "id_uc": idUC, "id_emp": idEmpresa, "faturas": out, "qtd": len(out)})
		return
	}
	if len(filt) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "informe ao menos um mês (mes ou mes_ref)"})
		return
	}

	var conds []string
	args := []any{idUC, idEmpresa}
	for _, m := range filt {
		rawm := strings.TrimSpace(m)
		low := strings.ToLower(rawm)
		low = strings.ReplaceAll(low, "até", "a")
		low = strings.ReplaceAll(low, "ate", "a")
		if strings.Contains(low, " a ") {
			parts := strings.SplitN(strings.ReplaceAll(strings.ReplaceAll(rawm, "até", " a "), "ate", " a "), " a ", 2)
			if len(parts) == 2 {
				start, err1 := normalizeMonth(parts[0])
				end, err2 := normalizeMonth(parts[1])
				if err1 != nil || err2 != nil {
					c.JSON(http.StatusBadRequest, gin.H{"error": "intervalo de meses inválido"})
					return
				}
				conds = append(conds, "(fi.Mes_Ref >= ? AND fi.Mes_Ref < DATE_ADD(?, INTERVAL 1 MONTH))")
				args = append(args, start, end)
				continue
			}
		}
		start, err := normalizeMonth(rawm)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		conds = append(conds, "(fi.Mes_Ref >= ? AND fi.Mes_Ref < DATE_ADD(?, INTERVAL 1 MONTH))")
		args = append(args, start, start)
	}

	q := `
SELECT fi.id_fatura, fi.Mes_Ref, fi.Link, fi.Dt_Vencimento, fi.Valor_Total
FROM Amee_Serving.Faturas_Implantadas fi
WHERE fi.id_uc = ? AND fi.id_empresa = ? AND (` + strings.Join(conds, " OR ") + `)
ORDER BY fi.Mes_Ref DESC;`

	rows, err := database.DB_Consulta.Query(q, args...)
	if err != nil {
		log.Printf("[GetFaturasByUC] erro faturas: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao buscar faturas"})
		return
	}
	defer rows.Close()

	type FaturaItem struct {
		IDFatura     *int64   `json:"id_fatura,omitempty"`
		MesRef       *string  `json:"mes_ref,omitempty"`
		Link         *string  `json:"link,omitempty"`
		DtVencimento *string  `json:"dt_vencimento,omitempty"`
		ValorTotal   *float64 `json:"valor_total,omitempty"`
	}
	out := make([]FaturaItem, 0, 8)
	for rows.Next() {
		var id sql.NullInt64
		var mes, link, venc sql.NullString
		var valor sql.NullFloat64
		if err := rows.Scan(&id, &mes, &link, &venc, &valor); err == nil {
			var idPtr *int64
			var mPtr, lPtr, vPtr *string
			var valPtr *float64
			if id.Valid {
				idPtr = &id.Int64
			}
			if mes.Valid {
				mPtr = &mes.String
			}
			if link.Valid {
				lPtr = &link.String
			}
			if venc.Valid {
				vPtr = &venc.String
			}
			if valor.Valid {
				val := valor.Float64
				valPtr = &val
			}
			out = append(out, FaturaItem{IDFatura: idPtr, MesRef: mPtr, Link: lPtr, DtVencimento: vPtr, ValorTotal: valPtr})
		}
	}
	c.JSON(http.StatusOK, gin.H{"uc": numeroUC, "id_uc": idUC, "id_emp": idEmpresa, "faturas": out, "qtd": len(out)})
}
