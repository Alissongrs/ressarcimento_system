package main

import (
	"database/sql"
	"encoding/json"
	"log"
	"os"
	"strconv"
	"strings"

	_ "github.com/go-sql-driver/mysql"
	"github.com/joho/godotenv"
)

func main() {
	_ = godotenv.Load(".env")
	id := 130738
	if len(os.Args) > 1 {
		if n, err := strconv.Atoi(os.Args[1]); err == nil {
			id = n
		}
	}
	dsn := strings.TrimSpace(os.Getenv("DB_APP_URL"))
	if dsn == "" {
		log.Fatal("DB_APP_URL vazio")
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
	row := db.QueryRow(`
		SELECT id, uid, cod_empresa, distribuidora, chave_nfe, link_fatura,
		       COALESCE(codigo_uc,''), COALESCE(numero_instalacao,''), COALESCE(matricula_cliente,''),
		       COALESCE(tarifa_tusd,0), COALESCE(tarifa_te,0), COALESCE(valor_total_fatura,0),
		       COALESCE(texto_plumber,''), COALESCE(texto_markdown,''), COALESCE(texto_bbox,''), COALESCE(texto_ocr,'')
		FROM FATURA_DADOS_EXTRAIDOS
		WHERE id = ?
	`, id)
	var out struct {
		ID             int    `json:"id"`
		UID            string `json:"uid"`
		CodEmpresa     int    `json:"cod_empresa"`
		Distribuidora  string `json:"distribuidora"`
		ChaveNFE       string `json:"chave_nfe"`
		LinkFatura     string `json:"link_fatura"`
		CodigoUC       string `json:"codigo_uc"`
		NumeroInst     string `json:"numero_instalacao"`
		Matricula      string `json:"matricula_cliente"`
		TarifaTUSD     float64 `json:"tarifa_tusd"`
		TarifaTE       float64 `json:"tarifa_te"`
		ValorTotal     float64 `json:"valor_total_fatura"`
		TextoPlumber   string `json:"texto_plumber"`
		TextoMarkdown  string `json:"texto_markdown"`
		TextoBBox      string `json:"texto_bbox"`
		TextoOCR       string `json:"texto_ocr"`
	}
	if err := row.Scan(&out.ID, &out.UID, &out.CodEmpresa, &out.Distribuidora, &out.ChaveNFE, &out.LinkFatura, &out.CodigoUC, &out.NumeroInst, &out.Matricula, &out.TarifaTUSD, &out.TarifaTE, &out.ValorTotal, &out.TextoPlumber, &out.TextoMarkdown, &out.TextoBBox, &out.TextoOCR); err != nil {
		log.Fatal(err)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	_ = enc.Encode(out)
}
