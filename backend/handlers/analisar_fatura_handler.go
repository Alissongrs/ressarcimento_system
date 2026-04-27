package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

// ─── SQL das regras para uma única fatura ────────────────────────────────────
// Mesma CTE de fichaUnificadaSQL, mas o SELECT final retorna SEMPRE a fatura
// solicitada (mesmo sem flags) para que possamos gravar "nenhuma regra disparou".

const fichaUnificadaSQLUnico = fichaUnificadaSQL + `
-- sobrescreve WHERE final para buscar por id específico
` // não usável diretamente — veja buildRegrasSQL()

// buildRegrasSQL monta a query de regras para um único id de fatura.
// Aproveitamos fichaUnificadaSQL mas trocamos o WHERE final.
func buildRegrasSQL() string {
	// fichaUnificadaSQL termina com:
	//   WHERE COALESCE(f1.flag_f01,0)=1 OR ... OR COALESCE(f25.flag_f05,0)=1
	// Removemos esse WHERE e adicionamos filtro por id.
	base := fichaUnificadaSQL
	const sentinel = "\nWHERE COALESCE(f1.flag_f01,  0) = 1\n   OR COALESCE(f25.flag_f02, 0) = 1\n   OR COALESCE(f25.flag_f03, 0) = 1\n   OR COALESCE(f25.flag_f04, 0) = 1\n   OR COALESCE(f25.flag_f05, 0) = 1"
	idx := strings.LastIndex(base, sentinel)
	if idx < 0 {
		// fallback: adiciona filtro por AND
		return base + "\n  AND b.id = ?"
	}
	return base[:idx] + "\nWHERE b.id = ?"
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

type resultadoRegras struct {
	FaturaID        int64    `json:"fatura_id"`
	UC              string   `json:"uc"`
	Concessionaria  string   `json:"concessionaria"`
	MesRef          string   `json:"mes_ref"`
	FlagF01         int      `json:"flag_f01"`
	FlagF02         int      `json:"flag_f02"`
	FlagF03         int      `json:"flag_f03"`
	FlagF04         int      `json:"flag_f04"`
	FlagF05         int      `json:"flag_f05"`
	QtdRegras       int      `json:"qtd_regras"`
	FichasAplicadas string   `json:"fichas_aplicadas"`
	DesvioMax       *float64 `json:"desvio_pct_max"`
	TrocaMedidor    *string  `json:"troca_medidor"`
	Detalhamento    string   `json:"detalhamento"`
	NenhumaRegra    bool     `json:"nenhuma_regra"`
}

// ─── POST /api/v1/ia/analisar-fatura/:id ─────────────────────────────────────
// Roda as regras SQL (F01-F05) para a fatura e grava resultado_regras.

func AnalisarFaturaRegrasHandler(c *gin.Context) {
	faturaID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || faturaID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id inválido"})
		return
	}

	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}

	query := buildRegrasSQL()

	var res resultadoRegras

	rows, qErr := sqlDB.Query(query, faturaID)
	if qErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("erro ao executar regras: %v", qErr)})
		return
	}
	defer rows.Close()

	cols, _ := rows.Columns()
	res.NenhumaRegra = true

	if rows.Next() {
		res.NenhumaRegra = false
		vals := make([]interface{}, len(cols))
		ptrs := make([]interface{}, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if sErr := rows.Scan(ptrs...); sErr == nil {
			colIdx := make(map[string]int, len(cols))
			for i, c := range cols {
				colIdx[c] = i
			}
			strVal := func(key string) string {
				idx, ok := colIdx[key]
				if !ok {
					return ""
				}
				v := vals[idx]
				if v == nil {
					return ""
				}
				if b, ok2 := v.([]byte); ok2 {
					return string(b)
				}
				return fmt.Sprintf("%v", v)
			}
			intVal := func(key string) int {
				s := strVal(key)
				n, _ := strconv.Atoi(s)
				return n
			}
			floatPtr := func(key string) *float64 {
				s := strVal(key)
				if s == "" {
					return nil
				}
				f, err := strconv.ParseFloat(s, 64)
				if err != nil {
					return nil
				}
				return &f
			}
			strPtr := func(key string) *string {
				s := strVal(key)
				if s == "" {
					return nil
				}
				return &s
			}

			res.FaturaID = faturaID
			res.UC = strVal("UC")
			res.Concessionaria = strVal("Concessionaria")
			res.MesRef = strVal("Mes_Ref")
			res.FlagF01 = intVal("flag_f01")
			res.FlagF02 = intVal("flag_f02")
			res.FlagF03 = intVal("flag_f03")
			res.FlagF04 = intVal("flag_f04")
			res.FlagF05 = intVal("flag_f05")
			res.QtdRegras = intVal("qtd_regras")
			res.FichasAplicadas = strVal("fichas_aplicadas")
			res.DesvioMax = floatPtr("desvio_pct_max")
			res.TrocaMedidor = strPtr("troca_medidor")
			if detalhamento := strPtr("detalhamento"); detalhamento != nil {
				res.Detalhamento = *detalhamento
			}
		}
	}
	_ = rows.Close()

	// Formata como texto para a IA
	var sb strings.Builder
	if res.NenhumaRegra {
		sb.WriteString(fmt.Sprintf("Fatura ID %d: nenhuma regra SQL (F01-F05) disparou. A fatura pode não estar no escopo das regras (Tp_Tensao, Cod_Empresa) ou não apresenta desvios detectáveis.", faturaID))
	} else {
		sb.WriteString(fmt.Sprintf("Fatura ID %d | UC: %s | Concessionária: %s | Ref: %s\n", res.FaturaID, res.UC, res.Concessionaria, res.MesRef))
		sb.WriteString(fmt.Sprintf("Regras disparadas: %s (%d regra(s))\n", res.FichasAplicadas, res.QtdRegras))
		if res.DesvioMax != nil {
			sb.WriteString(fmt.Sprintf("Desvio máximo: %.1f%%\n", *res.DesvioMax))
		}
		if res.TrocaMedidor != nil {
			sb.WriteString(fmt.Sprintf("Troca de medidor: %s\n", *res.TrocaMedidor))
		}
		sb.WriteString(fmt.Sprintf("Detalhamento: %s\n", res.Detalhamento))
		sb.WriteString(fmt.Sprintf("Flags: F01=%d F02=%d F03=%d F04=%d F05=%d", res.FlagF01, res.FlagF02, res.FlagF03, res.FlagF04, res.FlagF05))
	}
	textoRegras := sb.String()

	// Serializa o JSON completo para gravar na coluna
	jsonRegras, _ := json.Marshal(res)

	// Grava na tabela
	now := time.Now()
	_, updErr := sqlDB.Exec(
		"UPDATE Faturas_Registradas_Cache SET resultado_regras = ?, resultado_regras_em = ? WHERE id = ?",
		string(jsonRegras), now, faturaID,
	)
	if updErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("erro ao gravar resultado_regras: %v", updErr)})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"fatura_id":    faturaID,
		"resultado":    res,
		"texto_resumo": textoRegras,
		"gravado_em":   now.Format(time.RFC3339),
	})
}

// ─── POST /api/v1/ia/arbitrar-fatura/:id ─────────────────────────────────────
// IA compara analise_IA + resultado_regras e decide se há anomalia real.
// Grava resultado_analises + resultado_final_em.
// Se confirmar anomalia, cria/atualiza registro em fichas_anomalias_cache.

func ArbitrarFaturaHandler(c *gin.Context) {
	faturaID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || faturaID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id inválido"})
		return
	}

	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}

	// Lê dados da fatura
	type faturaRow struct {
		AnaliseIA       *string
		ResultadoRegras *string
		UC              *string
		Concessionaria  *string
		MesRef          *[]byte
		CodEmpresa      *int
		RazaoSocial     *string
		Link            *string
		RsTotal         *float64
	}
	var fr faturaRow
	rowErr := sqlDB.QueryRow(`
			SELECT analise_IA, resultado_regras, UC, Concessionaria, Mes_Ref,
			       Cod_Empresa, RAZAO_SOCIAL, Link, RS_Total_Fatura
			FROM Faturas_Registradas_Cache WHERE id = ?`, faturaID,
	).Scan(
		&fr.AnaliseIA, &fr.ResultadoRegras, &fr.UC, &fr.Concessionaria, &fr.MesRef,
		&fr.CodEmpresa, &fr.RazaoSocial, &fr.Link, &fr.RsTotal,
	)
	if rowErr != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("fatura não encontrada: %v", rowErr)})
		return
	}

	analiseIA := ""
	if fr.AnaliseIA != nil {
		analiseIA = *fr.AnaliseIA
	}
	regrasTxt := ""
	if fr.ResultadoRegras != nil {
		// resultado_regras pode ser JSON — extraímos o texto legível
		var rr resultadoRegras
		if json.Unmarshal([]byte(*fr.ResultadoRegras), &rr) == nil {
			var sb strings.Builder
			if rr.NenhumaRegra {
				sb.WriteString("Nenhuma regra SQL disparou para esta fatura.")
			} else {
				sb.WriteString(fmt.Sprintf("Regras: %s (%d)\n", rr.FichasAplicadas, rr.QtdRegras))
				if rr.DesvioMax != nil {
					sb.WriteString(fmt.Sprintf("Desvio: %.1f%%\n", *rr.DesvioMax))
				}
				sb.WriteString(fmt.Sprintf("Detalhamento: %s", rr.Detalhamento))
			}
			regrasTxt = sb.String()
		} else {
			regrasTxt = *fr.ResultadoRegras
		}
	}

	if analiseIA == "" && regrasTxt == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "fatura sem analise_IA nem resultado_regras — execute os dois antes de arbitrar"})
		return
	}

	uc := ""
	if fr.UC != nil {
		uc = *fr.UC
	}
	conc := ""
	if fr.Concessionaria != nil {
		conc = *fr.Concessionaria
	}
	mesRef := ""
	if fr.MesRef != nil {
		mesRef = string(*fr.MesRef)
	}

	// Monta prompt para o árbitro
	systemPrompt := `Você é um árbitro especializado em anomalias de faturas de energia elétrica.
Receberá dois insumos sobre a mesma fatura:
1. ANÁLISE_IA: análise gerada por IA diretamente sobre o texto/imagem da fatura.
2. RESULTADO_REGRAS: resultado das regras SQL (F01-F05) aplicadas ao histórico da UC.

Sua tarefa:
- Compare os dois insumos e avalie se há realmente uma irregularidade na fatura.
- Seja criterioso: falsos positivos custam tempo; falsos negativos custam dinheiro.
- Responda em formato estruturado:

VEREDICTO: CONFIRMADO | FALSO_POSITIVO
MOTIVO: <explicação objetiva em 2-4 frases>
FICHAS_CONFIRMADAS: <ex: F01, F02 — ou "nenhuma">
CONFIANCA: ALTA | MEDIA | BAIXA
RECOMENDACAO: <próximo passo sugerido>`

	userMsg := fmt.Sprintf(`Fatura ID: %d | UC: %s | Concessionária: %s | Ref: %s

=== ANÁLISE_IA ===
%s

=== RESULTADO_REGRAS ===
%s`,
		faturaID, uc, conc, mesRef,
		orDefault(analiseIA, "(não disponível)"),
		orDefault(regrasTxt, "(não disponível)"),
	)

	ctx, cancel := context.WithTimeout(c.Request.Context(), 90*time.Second)
	defer cancel()

	arbitragem, aiErr := callAisureOpenAI(ctx, nil, userMsg, "", systemPrompt)
	if aiErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("erro na IA árbitro: %v", aiErr)})
		return
	}

	// Parse do veredicto
	veredicto := parseArbitragemVeredicto(arbitragem)
	confirmado := veredicto == "CONFIRMADO"

	// Grava resultado_analises + resultado_final_em
	now := time.Now()
	_, updErr := sqlDB.Exec(
		"UPDATE Faturas_Registradas_Cache SET resultado_analises = ?, resultado_final_em = ? WHERE id = ?",
		arbitragem, now, faturaID,
	)
	if updErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("erro ao gravar resultado_analises: %v", updErr)})
		return
	}

	// Se confirmado, cria/atualiza registro em fichas_anomalias_cache
	if confirmado && fr.ResultadoRegras != nil {
		var rr resultadoRegras
		if json.Unmarshal([]byte(*fr.ResultadoRegras), &rr) == nil && !rr.NenhumaRegra {
			ucVal := ""
			if fr.UC != nil {
				ucVal = *fr.UC
			}
			codEmpresa := 0
			if fr.CodEmpresa != nil {
				codEmpresa = *fr.CodEmpresa
			}
			concVal := ""
			if fr.Concessionaria != nil {
				concVal = *fr.Concessionaria
			}
			razao := ""
			if fr.RazaoSocial != nil {
				razao = *fr.RazaoSocial
			}
			link := ""
			if fr.Link != nil {
				link = *fr.Link
			}
			var rsTotal interface{} = nil
			if fr.RsTotal != nil {
				rsTotal = *fr.RsTotal
			}
			var desvioMax interface{} = nil
			if rr.DesvioMax != nil {
				desvioMax = *rr.DesvioMax
			}
			var trocaMed interface{} = nil
			if rr.TrocaMedidor != nil {
				trocaMed = *rr.TrocaMedidor
			}

			// Upsert: insere se não existir, atualiza resultado_ia se já existir
			_, insErr := sqlDB.Exec(`
					INSERT INTO fichas_anomalias_cache
					  (id, UC, Cod_Empresa, Concessionaria, Mes_Ref, RAZAO_SOCIAL, Link,
					   RS_Total_Fatura, flag_f01, flag_f02, flag_f03, flag_f04, flag_f05,
					   qtd_regras, fichas_aplicadas, desvio_pct_max, troca_medidor,
					   detalhamento, ia_status, resultado_ia, resultado_salvo_em, atualizado_em)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMADO', ?, ?, NOW())
					ON DUPLICATE KEY UPDATE
					  ia_status = 'CONFIRMADO',
					  resultado_ia = VALUES(resultado_ia),
					  resultado_salvo_em = VALUES(resultado_salvo_em),
					  atualizado_em = NOW()`,
				faturaID, ucVal, codEmpresa, concVal, mesRef, razao, link,
				rsTotal,
				rr.FlagF01, rr.FlagF02, rr.FlagF03, rr.FlagF04, rr.FlagF05,
				rr.QtdRegras, rr.FichasAplicadas, desvioMax, trocaMed,
				rr.Detalhamento, arbitragem, now,
			)
			if insErr != nil {
				// Não falha o request — só loga
				fmt.Printf("[ArbitrarFatura] aviso: erro ao inserir fichas_anomalias_cache id=%d: %v\n", faturaID, insErr)
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"fatura_id":    faturaID,
		"veredicto":    veredicto,
		"confirmado":   confirmado,
		"arbitragem":   arbitragem,
		"gravado_em":   now.Format(time.RFC3339),
		"ficha_criada": confirmado,
	})
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func parseArbitragemVeredicto(text string) string {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(strings.ToUpper(line), "VEREDICTO:") {
			val := strings.TrimSpace(line[len("VEREDICTO:"):])
			val = strings.ToUpper(val)
			for _, v := range []string{"CONFIRMADO", "FALSO_POSITIVO"} {
				if strings.Contains(val, v) {
					return v
				}
			}
		}
	}
	return "PENDENTE"
}

func orDefault(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}
