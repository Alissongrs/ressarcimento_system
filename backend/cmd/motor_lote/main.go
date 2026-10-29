// Command motor_lote roda o motor de apontamentos F01-F05 SÓ sobre as faturas extraídas a
// partir de uma data (o lote que acabou de subir) — usa o histórico das UCs dessas faturas,
// mas reporta apenas as faturas do lote. Somente leitura: não grava nada no banco.
//
//	cd backend && go run ./cmd/motor_lote -desde 2026-10-20 [-saida motor_lote.json]
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/joho/godotenv"

	"ressarcimento-backend/database"
	"ressarcimento-backend/handlers"
)

type apont struct {
	ID              int64    `json:"id"`
	CodEmpresa      int64    `json:"cod_empresa"`
	Distribuidora   string   `json:"distribuidora"`
	UC              string   `json:"uc"`
	Instalacao      string   `json:"numero_instalacao"`
	MesRef          string   `json:"mes_referencia"`
	KwhTotal        float64  `json:"kwh_total"`
	Fichas          []string `json:"fichas"`
	DesvioPct       float64  `json:"desvio_pct"`
	F02Validacao    string   `json:"f02_validacao"`
	Classificacao   string   `json:"classificacao_historico"`
	LeituraSuspeita bool     `json:"leitura_suspeita"`
	Ressarcimento   float64  `json:"ressarcimento_estimado"`
	Detalhe         []string `json:"detalhamento"`
	Link            string   `json:"link_fatura"`
}

func main() {
	desde := flag.String("desde", "", "data (AAAA-MM-DD) a partir da qual a fatura foi extraída")
	saida := flag.String("saida", "", "arquivo JSON de saída (opcional)")
	flag.Parse()
	if *desde == "" {
		log.Fatal("informe -desde AAAA-MM-DD")
	}
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

	rows, err := db.Query(`
SELECT id, COALESCE(cod_empresa,0), COALESCE(distribuidora,''), COALESCE(codigo_uc,''),
       COALESCE(numero_instalacao,''), COALESCE(mes_referencia,''), COALESCE(kwh_total,0),
       COALESCE(valor_energia_ativa,0), COALESCE(rs_kwh_total,0), COALESCE(link_fatura,'')
  FROM FATURA_DADOS_EXTRAIDOS
 WHERE extraido_em >= ? AND validador_gate IS NOT NULL`, *desde)
	if err != nil {
		log.Fatal(err)
	}
	type lote struct {
		a          apont
		vea, rsTot float64
	}
	novas := map[int64]lote{}
	ucs, insts := map[string]bool{}, map[string]bool{}
	for rows.Next() {
		var l lote
		if err := rows.Scan(&l.a.ID, &l.a.CodEmpresa, &l.a.Distribuidora, &l.a.UC, &l.a.Instalacao,
			&l.a.MesRef, &l.a.KwhTotal, &l.vea, &l.rsTot, &l.a.Link); err != nil {
			log.Fatal(err)
		}
		novas[l.a.ID] = l
		if u := strings.TrimSpace(l.a.UC); u != "" {
			ucs[u] = true
		}
		if i := strings.TrimSpace(l.a.Instalacao); len(i) >= 5 {
			insts[i] = true
		}
	}
	rows.Close()
	log.Printf("[motor_lote] %d faturas extraídas desde %s | %d UCs | %d instalações", len(novas), *desde, len(ucs), len(insts))

	keys := func(m map[string]bool) []string {
		s := make([]string, 0, len(m))
		for k := range m {
			s = append(s, k)
		}
		return s
	}
	res, err := handlers.MotorApontamentosUCs(db, keys(ucs), keys(insts))
	if err != nil {
		log.Fatal(err)
	}

	out := []apont{}
	total := 0.0
	for id, r := range res {
		l, ok := novas[id]
		if !ok {
			continue // fatura antiga da UC — só serviu de histórico
		}
		a := l.a
		a.Fichas, a.DesvioPct, a.F02Validacao = r.FichasAplicadas, r.DesvioPctMax, r.F02Validacao
		a.Classificacao, a.LeituraSuspeita, a.Detalhe = r.ClassificacaoHistorico, r.LeituraSuspeita, r.Detalhamento
		if r.F02 && r.DesvioPctMax > 0 { // mesma fórmula da Auditoria: base × d/(1+d)
			base := l.vea
			if base <= 0 {
				base = l.rsTot
			}
			d := r.DesvioPctMax / 100
			a.Ressarcimento = float64(int64(base*d/(1+d)*100+0.5)) / 100
			total += a.Ressarcimento
		}
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Ressarcimento > out[j].Ressarcimento })

	cont := map[string]int{}
	for _, a := range out {
		for _, f := range a.Fichas {
			cont[f]++
		}
	}
	fmt.Printf("faturas do lote: %d | com apontamento: %d | ressarcimento estimado (F02): R$ %.2f | por ficha: %v\n",
		len(novas), len(out), total, cont)
	for i, a := range out {
		if i >= 40 {
			break
		}
		fmt.Printf("  id=%d emp=%d %-28.28s uc=%s mes=%s fichas=%v desvio=%.0f%% %s %s R$ %.2f\n",
			a.ID, a.CodEmpresa, a.Distribuidora, a.UC, a.MesRef, a.Fichas, a.DesvioPct, a.Classificacao, a.F02Validacao, a.Ressarcimento)
	}
	if *saida != "" {
		b, _ := json.MarshalIndent(out, "", " ")
		if err := os.WriteFile(*saida, b, 0o644); err != nil {
			log.Fatal(err)
		}
		log.Printf("[motor_lote] gravado %s", *saida)
	}
}
