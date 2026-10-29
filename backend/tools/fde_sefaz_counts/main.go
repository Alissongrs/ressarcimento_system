package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/url"
	"os"
	"sort"
	"strings"

	_ "github.com/go-sql-driver/mysql"
	"github.com/joho/godotenv"
)

func main() {
	_ = godotenv.Load(".env")
	dsn := strings.TrimSpace(os.Getenv("DB_APP_URL"))
	if dsn == "" {
		log.Fatal("DB_APP_URL nao encontrado")
	}
	if strings.Contains(dsn, "?") {
		dsn += "&parseTime=true&charset=utf8mb4"
	} else {
		dsn += "?parseTime=true&charset=utf8mb4"
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	var total, consultado, valor, cnpj, itens, valorECNPJ, chaveBanco int
	err = db.QueryRow(`
		SELECT
			COUNT(*),
			SUM(sefaz_consultado_em IS NOT NULL),
			SUM(valor_total_sefaz IS NOT NULL AND valor_total_sefaz > 0),
			SUM(cnpj_emissor_sefaz IS NOT NULL AND cnpj_emissor_sefaz <> ''),
			SUM(qtd_itens_sefaz IS NOT NULL AND qtd_itens_sefaz > 0),
			SUM(valor_total_sefaz IS NOT NULL AND valor_total_sefaz > 0 AND cnpj_emissor_sefaz IS NOT NULL AND cnpj_emissor_sefaz <> ''),
			SUM(chave_nfe IS NOT NULL AND chave_nfe <> '')
		FROM FATURA_DADOS_EXTRAIDOS
		WHERE cod_empresa = 4
	`).Scan(&total, &consultado, &valor, &cnpj, &itens, &valorECNPJ, &chaveBanco)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("empresa_4_total=%d\n", total)
	fmt.Printf("sefaz_consultado=%d\n", consultado)
	fmt.Printf("valor_total_sefaz=%d\n", valor)
	fmt.Printf("cnpj_emissor_sefaz=%d\n", cnpj)
	fmt.Printf("qtd_itens_sefaz=%d\n", itens)
	fmt.Printf("valor_e_cnpj_sefaz=%d\n", valorECNPJ)
	fmt.Printf("chave_nfe_banco=%d\n", chaveBanco)

	var cmpRows, cmpExact, cmpTol int
	if err := db.QueryRow(`
		SELECT
			COUNT(*),
			SUM(ROUND(COALESCE(valor_total_fatura, 0), 2) = ROUND(COALESCE(valor_total_sefaz, 0), 2)),
			SUM(ABS(COALESCE(valor_total_fatura, 0) - COALESCE(valor_total_sefaz, 0)) <= 0.01)
		FROM FATURA_DADOS_EXTRAIDOS
		WHERE cod_empresa = 4
			AND valor_total_fatura IS NOT NULL AND valor_total_fatura > 0
			AND valor_total_sefaz IS NOT NULL AND valor_total_sefaz > 0
	`).Scan(&cmpRows, &cmpExact, &cmpTol); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("valor_fde_vs_sefaz_rows=%d\n", cmpRows)
	fmt.Printf("valor_fde_vs_sefaz_exact=%d\n", cmpExact)
	fmt.Printf("valor_fde_vs_sefaz_tol001=%d\n", cmpTol)

	var linkFilled int
	if err := db.QueryRow(`
		SELECT SUM(link_fatura IS NOT NULL AND link_fatura <> '')
		FROM FATURA_DADOS_EXTRAIDOS
		WHERE cod_empresa = 4
	`).Scan(&linkFilled); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("link_fatura_preenchido=%d\n", linkFilled)

	rows, err := db.Query(`
		SELECT link_fatura
		FROM FATURA_DADOS_EXTRAIDOS
		WHERE cod_empresa = 4 AND link_fatura IS NOT NULL AND link_fatura <> ''
	`)
	if err != nil {
		log.Fatal(err)
	}
	defer rows.Close()
	domains := map[string]int{}
	for rows.Next() {
		var raw string
		if rows.Scan(&raw) != nil {
			continue
		}
		host := "(sem host)"
		if u, err := url.Parse(raw); err == nil && u.Host != "" {
			host = strings.ToLower(u.Host)
		}
		domains[host]++
	}
	type kv struct {
		k string
		v int
	}
	var arr []kv
	for k, v := range domains {
		arr = append(arr, kv{k, v})
	}
	sort.Slice(arr, func(i, j int) bool { return arr[i].v > arr[j].v })
	for i, x := range arr {
		if i >= 8 {
			break
		}
		fmt.Printf("link_host_%d=%s:%d\n", i+1, x.k, x.v)
	}
}
