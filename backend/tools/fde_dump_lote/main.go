package main

import (
	"database/sql"
	"encoding/json"
	"log"
	"os"
	"strings"

	_ "github.com/go-sql-driver/mysql"
	"github.com/joho/godotenv"
)

type LoteItem struct {
	FaturaID int64 `json:"fatura_id"`
}

type Out struct {
	ID            int64   `json:"id"`
	UID           string  `json:"uid"`
	CodEmpresa    int     `json:"cod_empresa"`
	Distribuidora string  `json:"distribuidora"`
	ChaveNFE      string  `json:"chave_nfe"`
	LinkFatura    string  `json:"link_fatura"`
	CodigoUC      string  `json:"codigo_uc"`
	NumeroInst    string  `json:"numero_instalacao"`
	Matricula     string  `json:"matricula_cliente"`
	ValorTotal    float64 `json:"valor_total_fatura"`
	ItensCobrados string  `json:"itens_cobrados"`
	QtdItensSEFAZ int     `json:"qtd_itens_sefaz"`
	QtdItensOrigem string `json:"qtd_itens_origem"`
	TextoPlumber  string  `json:"texto_plumber"`
	TextoMarkdown string  `json:"texto_markdown"`
	TextoBBox     string  `json:"texto_bbox"`
	TextoOCR      string  `json:"texto_ocr"`
}

func main() {
	_ = godotenv.Load(".env")
	lotePath := "../ia/precisao/colab/lote_faturas.json"
	if len(os.Args) > 1 {
		lotePath = os.Args[1]
	}
	outPath := ""
	if len(os.Args) > 2 {
		outPath = os.Args[2]
	}
	b, err := os.ReadFile(lotePath)
	if err != nil {
		log.Fatal(err)
	}
	var lote []LoteItem
	if err := json.Unmarshal(b, &lote); err != nil {
		log.Fatal(err)
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
	outFile := os.Stdout
	if outPath != "" {
		f, err := os.Create(outPath)
		if err != nil {
			log.Fatal(err)
		}
		defer f.Close()
		outFile = f
	}
	enc := json.NewEncoder(outFile)
	enc.SetEscapeHTML(false)
	for _, it := range lote {
		row := db.QueryRow(`
			SELECT id, COALESCE(uid,''), COALESCE(cod_empresa,0), COALESCE(distribuidora,''), COALESCE(chave_nfe,''), COALESCE(link_fatura,''),
			       COALESCE(codigo_uc,''), COALESCE(numero_instalacao,''), COALESCE(matricula_cliente,''),
			       COALESCE(valor_total_fatura,0),
			       COALESCE(CAST(itens_cobrados AS CHAR), ''), COALESCE(qtd_itens_sefaz,0), COALESCE(qtd_itens_origem,''),
			       COALESCE(texto_plumber,''), COALESCE(texto_markdown,''), COALESCE(texto_bbox,''), COALESCE(texto_ocr,'')
			FROM FATURA_DADOS_EXTRAIDOS
			WHERE id = ?
		`, it.FaturaID)
		var out Out
		if err := row.Scan(&out.ID, &out.UID, &out.CodEmpresa, &out.Distribuidora, &out.ChaveNFE, &out.LinkFatura, &out.CodigoUC, &out.NumeroInst, &out.Matricula, &out.ValorTotal, &out.ItensCobrados, &out.QtdItensSEFAZ, &out.QtdItensOrigem, &out.TextoPlumber, &out.TextoMarkdown, &out.TextoBBox, &out.TextoOCR); err != nil {
			log.Fatal(err)
		}
		if err := enc.Encode(out); err != nil {
			log.Fatal(err)
		}
	}
}
