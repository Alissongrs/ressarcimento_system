// Command motor_claro roda o motor de apontamentos F01-F05 (o MESMO da Auditoria de Faturas)
// sobre FATURA_CLARO_DADOS_EXTRAIDOS, uma distribuidora por vez. SOMENTE LEITURA.
//
// Mapeia as colunas da Claro para o formato da FDE:
//   consumo_kwh → kwh_total/consumo FP · leit_anterior/leit_atual/constante → leituras FP (só
//   quando há constante > 0; sem constante as leituras da Claro são lixo de extração — dia da data)
//   mes_referencia: normaliza 'MM/AAAA', 'DD/MM/AAAA' e 'AAAA-MM[-DD]' → 'MM/AAAA'
//   duplicadas (mesma instalação+UC+mês+consumo — 2ª via/cópia) contam UMA vez (menor id).
//
//	cd backend && go run ./cmd/motor_claro -saida ../backups/motor_claro [-dist "CEMIG"]
package main

import (
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/joho/godotenv"

	"ressarcimento-backend/database"
	"ressarcimento-backend/handlers"
)

type apont struct {
	ID              int64    `json:"id"`
	Distribuidora   string   `json:"distribuidora"`
	Cliente         string   `json:"nome_cliente"`
	CNPJ            string   `json:"cnpj_cliente"`
	Instalacao      string   `json:"numero_instalacao"`
	UC              string   `json:"codigo_uc"`
	MesRef          string   `json:"mes_referencia"`
	Consumo         float64  `json:"consumo_kwh"`
	Media           float64  `json:"media_historica_kwh"`
	ValorTotal      float64  `json:"valor_total"`
	Fichas          []string `json:"fichas"`
	DesvioPct       float64  `json:"desvio_pct"`
	Classe          string   `json:"classe_desvio"`
	F02Validacao    string   `json:"f02_validacao"`
	Classificacao   string   `json:"classificacao_historico"`
	LeituraSuspeita bool     `json:"leitura_suspeita"`
	Estimativa      float64  `json:"estimativa_sobre_valor_total"`
	Detalhe         []string `json:"detalhamento"`
	Link            string   `json:"link"`
	UID             string   `json:"uid"`
}

const mesNorm = `CASE
  WHEN mes_referencia REGEXP '^[0-9]{2}/[0-9]{4}$' THEN mes_referencia
  WHEN mes_referencia REGEXP '^[0-9]{2}/[0-9]{2}/[0-9]{4}$' THEN SUBSTRING(mes_referencia,4,7)
  WHEN mes_referencia REGEXP '^[0-9]{4}-[0-9]{2}' THEN CONCAT(SUBSTRING(mes_referencia,6,2),'/',LEFT(mes_referencia,4))
  WHEN mes_referencia REGEXP '^[0-9]{1}/[0-9]{4}$' THEN CONCAT('0',mes_referencia)
  ELSE NULL END`

// fonte: subconsulta com as colunas que o motor lê (formato FDE). 1 placeholder: distribuidora.
func fonte(distNula bool) string {
	filtroDist := "distribuidora = ?"
	if distNula {
		filtroDist = "distribuidora IS NULL"
	}
	return `(SELECT MIN(id) AS id,
	        numero_instalacao, codigo_uc, mes_referencia,
	        ANY_VALUE(numero_medidor) AS numero_medidor, '' AS validador_gate,
	        ANY_VALUE(k) AS constante_k, ANY_VALUE(lant) AS leit_ant_ativa_fponta, ANY_VALUE(latu) AS leit_atu_ativa_fponta,
	        CAST(NULL AS DECIMAL(14,2)) AS consumo_ativo_ponta_kwh, consumo_kwh AS consumo_ativo_fponta_kwh,
	        CAST(NULL AS DECIMAL(14,2)) AS consumo_ativo_sefaz_kwh, '' AS historico_consumo_json,
	        0 AS flag_fatura_revisao, 0 AS flag_acumulo_art113, 0 AS kwh_acumulado_art113,
	        '' AS grupo_tarifario, consumo_kwh AS kwh_total
	   FROM (SELECT id, COALESCE(numero_instalacao,'') AS numero_instalacao, COALESCE(codigo_uc,'') AS codigo_uc,
	                ` + mesNorm + ` AS mes_referencia,
	                NULLIF(numero_medidor,'') AS numero_medidor,
	                CASE WHEN constante > 0 THEN constante END AS k,
	                CASE WHEN constante > 0 THEN leit_anterior END AS lant,
	                CASE WHEN constante > 0 THEN leit_atual END AS latu,
	                consumo_kwh
	           FROM FATURA_CLARO_DADOS_EXTRAIDOS
	          WHERE tipo IN ('fatura','scaneada') AND ` + filtroDist + `
	            AND consumo_kwh > 0
	            AND (COALESCE(numero_instalacao,'') <> '' OR COALESCE(codigo_uc,'') <> '')) x
	  WHERE mes_referencia IS NOT NULL
	  GROUP BY numero_instalacao, codigo_uc, mes_referencia, consumo_kwh) t`
}

func main() {
	saida := flag.String("saida", "motor_claro", "pasta de saída (um .json por distribuidora + resumo)")
	so := flag.String("dist", "", "rodar só esta distribuidora (nome exato)")
	flag.Parse()
	for _, p := range []string{".env", filepath.Join("backend", ".env")} {
		if godotenv.Load(p) == nil {
			break
		}
	}
	database.InitDBs()
	db := database.DB_App
	if db == nil {
		log.Fatal("DB_App nil — verifique DB_APP_URL no .env")
	}
	if err := os.MkdirAll(*saida, 0o755); err != nil {
		log.Fatal(err)
	}

	type dist struct {
		nome string
		nula bool
		n    int
	}
	var dists []dist
	rows, err := db.Query(`SELECT distribuidora, COUNT(*) FROM FATURA_CLARO_DADOS_EXTRAIDOS
		WHERE tipo IN ('fatura','scaneada') GROUP BY distribuidora ORDER BY COUNT(*) DESC`)
	if err != nil {
		log.Fatal(err)
	}
	for rows.Next() {
		var n sql.NullString
		var c int
		if rows.Scan(&n, &c) == nil {
			if *so != "" && n.String != *so {
				continue
			}
			dists = append(dists, dist{n.String, !n.Valid, c})
		}
	}
	rows.Close()
	log.Printf("[motor_claro] %d distribuidoras", len(dists))

	type resumoDist struct {
		Distribuidora string         `json:"distribuidora"`
		Faturas       int            `json:"faturas"`
		Apontamentos  int            `json:"apontamentos"`
		PorFicha      map[string]int `json:"por_ficha"`
		Estimativa    float64        `json:"estimativa_f02"`
		Segundos      float64        `json:"segundos"`
		Erro          string         `json:"erro,omitempty"`
	}
	var resumo []resumoDist
	salvar := func() {
		b, _ := json.MarshalIndent(resumo, "", " ")
		_ = os.WriteFile(filepath.Join(*saida, "_resumo.json"), b, 0o644)
	}

	for i, d := range dists {
		ini := time.Now()
		nome := d.nome
		if d.nula {
			nome = "(sem distribuidora)"
		}
		rd := resumoDist{Distribuidora: nome, Faturas: d.n, PorFicha: map[string]int{}}
		args := []any{}
		if !d.nula {
			args = append(args, d.nome)
		}
		res, err := handlers.MotorApontamentosFonte(db, fonte(d.nula), "1=1", args)
		if err != nil {
			rd.Erro = err.Error()
			log.Printf("[motor_claro] %d/%d %s: ERRO %v", i+1, len(dists), nome, err)
			resumo = append(resumo, rd)
			salvar()
			continue
		}
		// detalhes das faturas apontadas
		ids := make([]int64, 0, len(res))
		for id := range res {
			ids = append(ids, id)
		}
		meta := map[int64]apont{}
		for k := 0; k < len(ids); k += 1000 {
			fim := k + 1000
			if fim > len(ids) {
				fim = len(ids)
			}
			ph := strings.TrimSuffix(strings.Repeat("?,", fim-k), ",")
			a := make([]any, 0, fim-k)
			for _, id := range ids[k:fim] {
				a = append(a, id)
			}
			mr, err := db.Query(`SELECT id, COALESCE(distribuidora,''), COALESCE(nome_cliente,''), COALESCE(cnpj_cliente,''),
				COALESCE(numero_instalacao,''), COALESCE(codigo_uc,''), COALESCE(mes_referencia,''),
				COALESCE(consumo_kwh,0), COALESCE(valor_total,0), COALESCE(link,''), COALESCE(uid,'')
				FROM FATURA_CLARO_DADOS_EXTRAIDOS WHERE id IN (`+ph+`)`, a...)
			if err != nil {
				log.Printf("[motor_claro] meta: %v", err)
				continue
			}
			for mr.Next() {
				var x apont
				if mr.Scan(&x.ID, &x.Distribuidora, &x.Cliente, &x.CNPJ, &x.Instalacao, &x.UC, &x.MesRef,
					&x.Consumo, &x.ValorTotal, &x.Link, &x.UID) == nil {
					meta[x.ID] = x
				}
			}
			mr.Close()
		}
		out := make([]apont, 0, len(res))
		for id, r := range res {
			x := meta[id]
			x.ID = id
			x.Fichas, x.DesvioPct, x.Classe, x.F02Validacao = r.FichasAplicadas, r.DesvioPctMax, r.ClasseDesvio, r.F02Validacao
			x.Classificacao, x.LeituraSuspeita, x.Detalhe = r.ClassificacaoHistorico, r.LeituraSuspeita, r.Detalhamento
			if r.DesvioPctMax > 0 {
				x.Media = x.Consumo / (1 + r.DesvioPctMax/100)
			}
			if r.F02 && r.DesvioPctMax > 0 && x.ValorTotal > 0 { // base × d/(1+d), base = valor total
				dd := r.DesvioPctMax / 100
				x.Estimativa = float64(int64(x.ValorTotal*dd/(1+dd)*100+0.5)) / 100
				rd.Estimativa += x.Estimativa
			}
			for _, f := range r.FichasAplicadas {
				rd.PorFicha[f]++
			}
			out = append(out, x)
		}
		rd.Apontamentos = len(out)
		rd.Segundos = time.Since(ini).Seconds()
		arq := strings.Map(func(r rune) rune {
			if r == '/' || r == '\\' || r == ':' || r == '*' || r == '?' || r == '"' || r == '<' || r == '>' || r == '|' {
				return '_'
			}
			return r
		}, nome)
		b, _ := json.Marshal(out)
		_ = os.WriteFile(filepath.Join(*saida, fmt.Sprintf("%02d_%s.json", i+1, arq)), b, 0o644)
		resumo = append(resumo, rd)
		salvar()
		log.Printf("[motor_claro] %d/%d %-45.45s faturas=%d apont=%d fichas=%v est=R$ %.0f (%.0fs)",
			i+1, len(dists), nome, d.n, rd.Apontamentos, rd.PorFicha, rd.Estimativa, rd.Segundos)
	}
	log.Printf("[motor_claro] concluído → %s", *saida)
}
