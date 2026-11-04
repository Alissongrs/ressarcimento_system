package handlers

// Tela Tarefas — "situação da base" de cada tarefa (só leitura): quando entrou a última fatura, quantas
// entraram em 1/7/30 dias e por empresa nos últimos 30 dias. E, para o pdf_pipeline, o motivo de uma falha
// em linguagem simples (o log técnico fica recolhido no front).

import (
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

type situacaoEmpresa struct {
	Cod    int64  `json:"cod_empresa"`
	Nome   string `json:"nome"`
	N30    int64  `json:"n30"`
	Ultima string `json:"ultima"`
}

// GET /api/v1/tarefas-vps/situacao?job=pdf_pipeline|agua_sync
func SituacaoTarefaVPS(c *gin.Context) {
	db := solicDB(c)
	if db == nil {
		return
	}
	tabela, col := "FATURA_DADOS_EXTRAIDOS", "extraido_em"
	if c.Query("job") == "agua_sync" {
		tabela, col = "FATURA_AGUA_DADOS", "criado_em"
	}
	if c.Query("job") == "claro_pdp" {
		situacaoClaro(c, db)
		return
	}
	// só a janela recente (índice/escaneamento menor); "última" além de 120 dias vem da consulta de reserva
	var ultima, d1, d7, d30 any
	_ = db.QueryRow(`SELECT DATE_FORMAT(MAX(`+col+`),'%Y-%m-%dT%H:%i:%s'),
		COALESCE(SUM(`+col+` >= NOW() - INTERVAL 1 DAY),0), COALESCE(SUM(`+col+` >= NOW() - INTERVAL 7 DAY),0),
		COALESCE(SUM(`+col+` >= NOW() - INTERVAL 30 DAY),0)
		FROM `+tabela+` WHERE `+col+` >= NOW() - INTERVAL 120 DAY`).Scan(&ultima, &d1, &d7, &d30)
	if ultima == nil {
		_ = db.QueryRow(`SELECT DATE_FORMAT(MAX(` + col + `),'%Y-%m-%dT%H:%i:%s') FROM ` + tabela).Scan(&ultima)
	}
	ult := ""
	switch v := ultima.(type) {
	case []byte:
		ult = string(v)
	case string:
		ult = v
	}
	dias := -1
	if t, err := time.Parse("2006-01-02T15:04:05", ult); err == nil {
		dias = int(time.Since(t).Hours() / 24)
	}

	emps := []situacaoEmpresa{}
	rows, err := db.Query(`SELECT COALESCE(f.cod_empresa,0), COALESCE(MAX(e.nome),''), COUNT(*), DATE_FORMAT(MAX(f.`+col+`),'%Y-%m-%dT%H:%i:%s')
		FROM `+tabela+` f
		LEFT JOIN (SELECT cod_empresa, ANY_VALUE(nome_empresa) nome FROM DM_EMPRESA_PERCENTUAL GROUP BY cod_empresa) e ON e.cod_empresa = f.cod_empresa
		WHERE f.`+col+` >= NOW() - INTERVAL 30 DAY GROUP BY f.cod_empresa ORDER BY COUNT(*) DESC LIMIT 15`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var s situacaoEmpresa
			if rows.Scan(&s.Cod, &s.Nome, &s.N30, &s.Ultima) == nil {
				emps = append(emps, s)
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"ultima": ult, "dias_sem_entrar": dias,
		"d1": toInt64(d1), "d7": toInt64(d7), "d30": toInt64(d30), "por_empresa_30d": emps,
	})
}

func toInt64(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case []byte:
		var n int64
		for _, ch := range string(x) {
			if ch < '0' || ch > '9' {
				break
			}
			n = n*10 + int64(ch-'0')
		}
		return n
	case float64:
		return int64(x)
	}
	return 0
}

var (
	reCodigoPipeline = regexp.MustCompile(`\(código ([1-9]\d*)\)|terminou \(rc=([1-9]\d*)\)`)
	reUltimoErroPy   = regexp.MustCompile(`(?m)^\s*([A-Za-z]+(?:Error|Exception)):\s*(.+)$`)
)

// motivoFalhaPipeline — o porquê de uma execução do pdf_pipeline ter falhado, em palavras simples.
// Devolve "" quando a execução não falhou.
func motivoFalhaPipeline(status, res string) string {
	if status != "erro" && !reCodigoPipeline.MatchString(res) {
		return ""
	}
	var mot []string
	switch {
	case strings.Contains(res, "C:/paddleocr"):
		mot = append(mot, "o script procurou uma pasta do Windows (C:/paddleocr) que não existe no servidor e parou antes de extrair qualquer fatura — corrigido no deploy de 03/11; rode de novo")
	case strings.Contains(res, "Character set 'utf8' unsupported"):
		mot = append(mot, "a biblioteca de conexão MySQL instalada na VPS (mysql-connector-python 8.0.x) tem um defeito e não conecta no banco de origem das faturas (MariaDB) — o job troca a biblioteca sozinho a partir do deploy que trata qualquer 8.0.x; até lá, dá para atualizar à mão na VPS")
	case reUltimoErroPy.MatchString(res):
		m := reUltimoErroPy.FindAllStringSubmatch(res, -1)
		u := m[len(m)-1]
		txt := u[2]
		if len(txt) > 160 {
			txt = txt[:160] + "…"
		}
		mot = append(mot, "o script parou com erro ("+u[1]+": "+txt+")")
	case strings.Contains(res, "parou sem a linha de término"):
		mot = append(mot, "o processo foi interrompido no meio (servidor reiniciado ou processo encerrado)")
	default:
		mot = append(mot, "o script terminou com código de erro — veja o log técnico")
	}
	if strings.Contains(res, "backup_sistema.sh: Permission denied") {
		mot = append(mot, "o backup antes da extração também não rodou (falta permissão de execução no script — corrigido no deploy de 03/11)")
	}
	return strings.Join(mot, "; ")
}
