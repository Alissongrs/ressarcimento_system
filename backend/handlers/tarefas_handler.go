package handlers

// Página "Tarefas" (/tarefas, só admin): roda pela tela as tarefas da VPS — pdf_pipeline (extração das faturas
// de energia) e agua_sync (faturas de água + regras de água). Não roda nada aqui: o botão cria um pedido
// FT_SOLICITACOES já aprovado com acao_json {"op":"rodar_job"} — o MESMO caminho do chat — e o worker do host
// (worker/run_jobs.py, cron a cada minuto) executa, grava o andamento (fim do log) e o resultado no pedido.

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

type tarefaDef struct {
	Job        string `json:"job"`
	Nome       string `json:"nome"`
	Descricao  string `json:"descricao"`
	Agenda     string `json:"agenda"`
	Duracao    string `json:"duracao"`
	ComEmpresa bool   `json:"com_empresas"`
}

// tarefasVPS — whitelist (a mesma do worker/run_jobs.py)
var tarefasVPS = []tarefaDef{
	{"pdf_pipeline", "Extração das faturas de energia (pdf_pipeline)",
		"Faz backup do banco, baixa e extrai as faturas novas das empresas (só as ainda não processadas). Os itens de baixa confiança caem nas filas de conferência da Auditoria de Faturas.",
		"automático: segunda e quinta, 02:00", "pode levar horas", true},
	{"agua_sync", "Faturas de água (agua_sync)",
		"Traz da origem só as faturas de água novas (com backup das chaves inseridas). Depois o motor de regras do sistema aplica as regras de água — pico de consumo e cobrança sem medição — e os apontamentos novos aparecem na aba 💧 Água.",
		"automático: terça e quinta, 02:00", "alguns minutos", true},
}

var reEmpresasTarefa = regexp.MustCompile(`^\s*\d{1,6}(\s*[,; ]\s*\d{1,6})*\s*$`)

func tarefaPorJob(job string) *tarefaDef {
	for i := range tarefasVPS {
		if tarefasVPS[i].Job == job {
			return &tarefasVPS[i]
		}
	}
	return nil
}

// GET /api/v1/tarefas-vps — tarefas, a que está em andamento e o histórico das execuções
func ListarTarefasVPS(c *gin.Context) {
	sqlDB := solicDB(c)
	if sqlDB == nil {
		return
	}
	rows, err := sqlDB.Query(`SELECT id, COALESCE(usuario_nome,''), status, COALESCE(resultado,''), COALESCE(acao_json,''),
		DATE_FORMAT(criado_em,'%Y-%m-%dT%H:%i:%s'), COALESCE(DATE_FORMAT(executado_em,'%Y-%m-%dT%H:%i:%s'),'')
		FROM FT_SOLICITACOES WHERE acao_json LIKE '%"op":"rodar_job"%' ORDER BY id DESC LIMIT 60`)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	type exec struct {
		ID         int64  `json:"id"`
		Job        string `json:"job"`
		Empresas   string `json:"empresas,omitempty"`
		Usuario    string `json:"usuario"`
		Status     string `json:"status"`
		Resultado  string `json:"resultado"`
		CriadoEm   string `json:"criado_em"`
		Executado  string         `json:"executado_em,omitempty"`
		EmAndament bool           `json:"em_andamento"`
		Metricas   map[string]any `json:"metricas,omitempty"`
	}
	hist := []exec{}
	for rows.Next() {
		var e exec
		var aj string
		if rows.Scan(&e.ID, &e.Usuario, &e.Status, &e.Resultado, &aj, &e.CriadoEm, &e.Executado) != nil {
			continue
		}
		var a struct {
			Params map[string]string `json:"params"`
		}
		_ = json.Unmarshal([]byte(aj), &a)
		e.Job, e.Empresas = a.Params["job"], a.Params["empresas"]
		e.EmAndament = e.Status == "aprovado" || e.Status == "executando" || e.Status == "pendente"
		e.Resultado, e.Metricas = metricasTarefa(e.Job, e.Resultado)
		hist = append(hist, e)
	}
	c.JSON(http.StatusOK, gin.H{"tarefas": tarefasVPS, "execucoes": hist})
}

// POST /api/v1/tarefas-vps/:job {"empresas":"4,14"} — pede a execução (vai direto para a fila do worker da VPS)
func RodarTarefaVPS(c *gin.Context) {
	sqlDB := solicDB(c)
	if sqlDB == nil {
		return
	}
	t := tarefaPorJob(c.Param("job"))
	if t == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "tarefa desconhecida"})
		return
	}
	var body struct {
		Empresas string `json:"empresas"`
	}
	_ = c.ShouldBindJSON(&body)
	emp := ""
	if s := strings.TrimSpace(body.Empresas); s != "" {
		if !t.ComEmpresa || !reEmpresasTarefa.MatchString(s) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "empresas: use só os códigos separados por vírgula (ex.: 4, 14, 189)"})
			return
		}
		emp = strings.Join(strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ';' || r == ' ' }), ",")
	}
	// uma de cada vez: se a mesma tarefa já está na fila ou rodando, não enfileira outra
	var aberto sql.NullInt64
	_ = sqlDB.QueryRow(`SELECT MAX(id) FROM FT_SOLICITACOES WHERE status IN ('pendente','aprovado','executando')
		AND acao_json LIKE '%"op":"rodar_job"%' AND acao_json LIKE ?`, `%"job":"`+t.Job+`"%`).Scan(&aberto)
	if aberto.Valid {
		c.JSON(http.StatusConflict, gin.H{"error": "esta tarefa já está na fila ou rodando (pedido #" + itoa64(aberto.Int64) + ")"})
		return
	}
	params := map[string]string{"job": t.Job}
	if emp != "" {
		params["empresas"] = emp
	}
	acao, _ := json.Marshal(map[string]any{"op": "rodar_job", "rotulo": "rodar tarefa", "params": params})
	uid, uname := usuarioIA(c)
	msg := "[tela Tarefas] rodar " + t.Job
	prev := "Rodar " + t.Nome
	if emp != "" {
		msg += " — empresas " + emp
		prev += " — empresas " + emp
	}
	res, err := sqlDB.Exec(`INSERT INTO FT_SOLICITACOES (id_usuario, usuario_nome, mensagem, preview, status, criado_em, acao_json, aprovado_por, aprovado_em)
		VALUES (?, ?, ?, ?, 'aprovado', NOW(), ?, ?, NOW())`, uid, uname, msg, prev, string(acao), uname+" (tela Tarefas)")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	id, _ := res.LastInsertId()
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": id})
}

var (
	reMetricas      = regexp.MustCompile(`(?s)\s*<!--metricas (\{.*?\})-->`)
	reMetFaturasAg  = regexp.MustCompile(`(\d+) fatura\(s\) nova\(s\) inserida`)
	reMetPicoAntigo = regexp.MustCompile(`aplicada: (\d+) apontamento`)
	reMetSemMedAnt  = regexp.MustCompile(`(\d+) apontamento\(s\) novo\(s\), (\d+) atualizado`)
	reMetPipeline   = regexp.MustCompile(`concluído\*\* — (\d+) fatura\(s\) extraída\(s\), (\d+) com erro`)
)

// metricasTarefa — tira do resultado a linha escondida <!--metricas {...}--> que o worker grava (números da
// execução para a tela). Execuções antigas, sem a linha, têm os números lidos do próprio texto.
func metricasTarefa(job, res string) (string, map[string]any) {
	if m := reMetricas.FindStringSubmatch(res); m != nil {
		var d map[string]any
		if json.Unmarshal([]byte(m[1]), &d) == nil {
			return strings.TrimSpace(reMetricas.ReplaceAllString(res, "")), d
		}
	}
	d := map[string]any{}
	switch job {
	case "agua_sync":
		d["base_qualidade"] = "agua"
		if m := reMetFaturasAg.FindStringSubmatch(res); m != nil {
			d["faturas_novas"], _ = strconv.Atoi(m[1])
		}
		ap := 0
		achou := false
		if m := reMetPicoAntigo.FindStringSubmatch(res); m != nil {
			v, _ := strconv.Atoi(m[1])
			ap += v
			achou = true
		}
		if m := reMetSemMedAnt.FindStringSubmatch(res); m != nil {
			v, _ := strconv.Atoi(m[1])
			u, _ := strconv.Atoi(m[2])
			ap += v
			d["apontamentos_atualizados"] = u
			achou = true
		}
		if achou {
			d["apontamentos_novos"] = ap
		}
	case "pdf_pipeline":
		d["base_qualidade"] = "energia"
		if m := reMetPipeline.FindStringSubmatch(res); m != nil {
			d["faturas_novas"], _ = strconv.Atoi(m[1])
			d["faturas_erro"], _ = strconv.Atoi(m[2])
		}
	}
	if len(d) <= 1 {
		return res, nil
	}
	return res, d
}

func itoa64(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}
