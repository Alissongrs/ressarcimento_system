package handlers

// Tempo de resposta aos protocolos ANEEL (página Métricas, fim da página).
// Para cada e-mail da ANEEL que pede ação (protocolo concluído = resposta da ANEEL, ou prazo da distribuidora
// encerrado), mede quanto tempo a equipe levou até:
//   - atualizar o processo: 1ª movimentação feita por uma pessoa depois do e-mail (não contam o usuário
//     "sistema" nem e-mails anexados automaticamente);
//   - dar "Ciente" no aviso do sininho;
//   - concluir a tarefa criada para o protocolo.
// Compara antes × depois da tela de protocolos (MarcoTelaProtocolos). A base começa em nov/2025: antes disso a
// equipe quase não registrava movimentações no sistema.
//
// Fuso: as colunas DATETIME (ocorrido_em, criado_em, concluida_em, ciente_em) estão em horário de Brasília e as
// TIMESTAMP (data_movimentacao, data_criacao) são absolutas. Tudo vira segundos desde 1970 sem depender do fuso
// da sessão: DATETIME → TIMESTAMPDIFF(...) + 3h; TIMESTAMP → UNIX_TIMESTAMP().

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"ressarcimento-backend/database"
	"ressarcimento-backend/protocolos"

	"github.com/gin-gonic/gin"
)

// MarcoTelaProtocolos: dia em que a tela de protocolos ANEEL (e as tarefas) entrou no ar.
var MarcoTelaProtocolos = time.Date(2026, 10, 25, 0, 0, 0, 0, time.FixedZone("BRT", -3*3600))

const inicioBaseTempoResposta = "2025-11-01"

// segundos desde 1970 de uma coluna DATETIME gravada em horário de Brasília
func epochBRT(col string) string {
	return "(TIMESTAMPDIFF(SECOND, '1970-01-01 00:00:00', " + col + ") + 10800)"
}

type trItem struct {
	IDEvento     int64    `json:"id_evento"`
	Tipo         string   `json:"tipo"` // resposta | prazo
	Protocolo    string   `json:"protocolo"`
	IDProcesso   int64    `json:"id_processo"`
	Chegou       int64    `json:"chegou"` // epoch s
	Atualizou    *int64   `json:"atualizou"`
	QuemAtualiz  string   `json:"quem_atualizou"`
	Ciente       *int64   `json:"ciente"`
	TarefaFim    *int64   `json:"tarefa_concluida"`
	IDTarefa     *int64   `json:"id_tarefa"`
	Responsavel  string   `json:"responsavel"`
	HAtualizacao *float64 `json:"h_atualizacao"`
	HCiente      *float64 `json:"h_ciente"`
	HTarefa      *float64 `json:"h_tarefa"`
	Depois       bool     `json:"depois"`
}

type trResumo struct {
	N              int      `json:"n"`
	Atualizados    int      `json:"atualizados"`
	Pendentes      int      `json:"pendentes"`
	MedianaH       *float64 `json:"mediana_h"`
	Ate24h         float64  `json:"ate_24h_pct"`
	Ate72h         float64  `json:"ate_72h_pct"`
	MedianaCienteH *float64 `json:"mediana_ciente_h"`
	MedianaTarefaH *float64 `json:"mediana_tarefa_h"`
}

func mediana(v []float64) *float64 {
	if len(v) == 0 {
		return nil
	}
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	m := s[len(s)/2]
	if len(s)%2 == 0 {
		m = (s[len(s)/2-1] + s[len(s)/2]) / 2
	}
	return &m
}

func resumirTR(itens []trItem) trResumo {
	r := trResumo{N: len(itens)}
	var hs, hc, ht []float64
	for _, it := range itens {
		if it.HAtualizacao != nil {
			r.Atualizados++
			hs = append(hs, *it.HAtualizacao)
			if *it.HAtualizacao <= 24 {
				r.Ate24h++
			}
			if *it.HAtualizacao <= 72 {
				r.Ate72h++
			}
		} else {
			r.Pendentes++
		}
		if it.HCiente != nil {
			hc = append(hc, *it.HCiente)
		}
		if it.HTarefa != nil {
			ht = append(ht, *it.HTarefa)
		}
	}
	if r.N > 0 {
		r.Ate24h = r.Ate24h * 100 / float64(r.N)
		r.Ate72h = r.Ate72h * 100 / float64(r.N)
	}
	r.MedianaH, r.MedianaCienteH, r.MedianaTarefaH = mediana(hs), mediana(hc), mediana(ht)
	return r
}

// Quem vê a seção de protocolos ANEEL nas Métricas (pedido do Alisson em 29/10/2026). A equipe toda é admin,
// então a rota adminOnly não basta: só Alisson (1), Luana Nascimento (1000) e Eduardo Navarro (1004).
var podeVerTempoRespostaProtocolos = map[int64]bool{1: true, 1000: true, 1004: true}

// GET /relatorios/tempo-resposta-protocolos
func GetTempoRespostaProtocolos(c *gin.Context) {
	userID, _ := c.Get("userID")
	if uid, _ := userID.(int64); !podeVerTempoRespostaProtocolos[uid] {
		c.JSON(http.StatusForbidden, gin.H{"error": "sem acesso", "sem_acesso": true})
		return
	}
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}

	// 1) e-mails da ANEEL que pedem ação, com o processo do protocolo
	type evRow struct {
		ID         int64
		Situacao   string
		Protocolo  string
		IDProcesso int64
		Chegou     int64
	}
	var evs []evRow
	if err := db.Raw(`SELECT e.id, e.situacao_nova AS situacao, e.protocolo_num AS protocolo, p.id_processo,
			`+epochBRT("e.ocorrido_em")+` AS chegou
		FROM FT_PROTOCOLO_EVENTOS e
		JOIN FT_PROTOCOLOS_ANEEL p ON p.protocolo_num = e.protocolo_num AND p.id_processo IS NOT NULL AND p.ativo = 1
		WHERE e.fonte = 'email' AND e.situacao_nova IN (?, ?) AND e.ocorrido_em >= ?
		ORDER BY e.ocorrido_em`, protocolos.SitConcluidaSite, protocolos.SitPrazoDistrib, inicioBaseTempoResposta).
		Scan(&evs).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if len(evs) == 0 {
		c.JSON(http.StatusOK, gin.H{"marco": MarcoTelaProtocolos.Format("2006-01-02"), "itens": []trItem{}})
		return
	}
	procSet := map[int64]bool{}
	var procs []int64
	for _, e := range evs {
		if !procSet[e.IDProcesso] {
			procSet[e.IDProcesso] = true
			procs = append(procs, e.IDProcesso)
		}
	}

	// 2) movimentações feitas por pessoas nesses processos
	type movRow struct {
		IDProcesso int64
		Quando     int64
		Nome       string
	}
	movs := map[int64][]movRow{}
	for i := 0; i < len(procs); i += 500 {
		fim := i + 500
		if fim > len(procs) {
			fim = len(procs)
		}
		var rows []movRow
		db.Raw(`SELECT h.id_processo, UNIX_TIMESTAMP(h.data_movimentacao) AS quando, COALESCE(u.nome_usuario,'') AS nome
			FROM FT_HISTORICO_MOVIMENTACOES h LEFT JOIN DM_USUARIO u ON u.id_usuario = h.id_usuario_gestor
			WHERE h.id_processo IN ? AND h.id_usuario_gestor IS NOT NULL AND h.id_usuario_gestor <> 999
			  AND COALESCE(h.tipo_movimentacao,'') NOT IN ('EMAIL','E-mail','auto')
			ORDER BY h.data_movimentacao`, procs[i:fim]).Scan(&rows)
		for _, m := range rows {
			movs[m.IDProcesso] = append(movs[m.IDProcesso], m)
		}
	}

	// 3) tarefas (ligadas ao evento) e o "Ciente" do aviso de cada tarefa
	type tarRow struct {
		IDTarefa    int64
		IDEvento    int64
		IDProcesso  int64
		IDResp      *int64
		Responsavel string
		Titulo      string
		Concluida   *int64
	}
	var tars []tarRow
	db.Raw(`SELECT t.id_tarefa, t.id_evento, COALESCE(t.id_processo,0) AS id_processo, t.id_usuario_responsavel AS id_resp,
			COALESCE(u.nome_usuario,'') AS responsavel, t.titulo,
			CASE WHEN t.concluida_em IS NULL THEN NULL ELSE ` + epochBRT("t.concluida_em") + ` END AS concluida
		FROM FT_TAREFAS t LEFT JOIN DM_USUARIO u ON u.id_usuario = t.id_usuario_responsavel
		WHERE t.tipo LIKE 'protocolo\_%' AND t.id_evento IS NOT NULL`).Scan(&tars)
	tarDe := map[[2]int64]tarRow{}
	for _, t := range tars {
		tarDe[[2]int64{t.IDEvento, t.IDProcesso}] = t
	}
	// avisos de tarefa: "... <título> (processo #N)" para o responsável; o Ciente é a hora em que ele confirmou
	type alRow struct {
		IDUsuario int64
		Mensagem  string
		Ciente    int64
	}
	var als []alRow
	db.Raw(`SELECT id_usuario, mensagem, ` + epochBRT("ciente_em") + ` AS ciente
		FROM FT_ALERTAS WHERE ciente_em IS NOT NULL AND data_alerta IS NULL AND mensagem LIKE '%Protocolo ANEEL%'`).Scan(&als)

	itens := make([]trItem, 0, len(evs))
	marco := MarcoTelaProtocolos.Unix()
	for _, e := range evs {
		it := trItem{IDEvento: e.ID, Protocolo: protocolos.Formatar(e.Protocolo), IDProcesso: e.IDProcesso, Chegou: e.Chegou,
			Tipo: "resposta", Depois: e.Chegou >= marco}
		if e.Situacao == protocolos.SitPrazoDistrib {
			it.Tipo = "prazo"
		}
		for _, m := range movs[e.IDProcesso] {
			if m.Quando >= e.Chegou {
				q := m.Quando
				it.Atualizou, it.QuemAtualiz = &q, m.Nome
				h := float64(q-e.Chegou) / 3600
				it.HAtualizacao = &h
				break
			}
		}
		if t, ok := tarDe[[2]int64{e.ID, e.IDProcesso}]; ok {
			id := t.IDTarefa
			it.IDTarefa, it.Responsavel = &id, t.Responsavel
			if t.Concluida != nil {
				it.TarefaFim = t.Concluida
				h := float64(*t.Concluida-e.Chegou) / 3600
				it.HTarefa = &h
			}
			if t.IDResp != nil {
				marca := "(processo #" + strconv.FormatInt(e.IDProcesso, 10) + ")"
				for _, a := range als {
					if a.IDUsuario == *t.IDResp && strings.Contains(a.Mensagem, it.Protocolo) && strings.Contains(a.Mensagem, marca) {
						q := a.Ciente
						h := float64(q-e.Chegou) / 3600
						it.Ciente, it.HCiente = &q, &h
						break
					}
				}
			}
		}
		if it.Responsavel == "" {
			it.Responsavel = it.QuemAtualiz
		}
		itens = append(itens, it)
	}

	// resumos: antes × depois, por mês e por analista (desde o marco)
	por := func(tipo string, depois *bool) []trItem {
		var out []trItem
		for _, it := range itens {
			if it.Tipo == tipo && (depois == nil || it.Depois == *depois) {
				out = append(out, it)
			}
		}
		return out
	}
	f, t := false, true
	resumo := gin.H{}
	for _, tipo := range []string{"resposta", "prazo"} {
		resumo[tipo] = gin.H{"antes": resumirTR(por(tipo, &f)), "depois": resumirTR(por(tipo, &t))}
	}

	brt := MarcoTelaProtocolos.Location()
	meses := map[string]map[string][]trItem{}
	for _, it := range itens {
		k := time.Unix(it.Chegou, 0).In(brt).Format("2006-01")
		if meses[k] == nil {
			meses[k] = map[string][]trItem{}
		}
		meses[k][it.Tipo] = append(meses[k][it.Tipo], it)
	}
	var chaves []string
	for k := range meses {
		chaves = append(chaves, k)
	}
	sort.Strings(chaves)
	porMes := make([]gin.H, 0, len(chaves))
	for _, k := range chaves {
		porMes = append(porMes, gin.H{"mes": k, "resposta": resumirTR(meses[k]["resposta"]), "prazo": resumirTR(meses[k]["prazo"])})
	}

	// por analista (desde o marco), separado por tipo de e-mail
	porAnalista := gin.H{}
	for _, tipo := range []string{"resposta", "prazo"} {
		analistas := map[string][]trItem{}
		for _, it := range itens {
			if !it.Depois || it.Tipo != tipo {
				continue
			}
			nome := it.Responsavel
			if nome == "" {
				nome = "Sem responsável"
			}
			analistas[nome] = append(analistas[nome], it)
		}
		lista := make([]gin.H, 0, len(analistas))
		for nome, lst := range analistas {
			lista = append(lista, gin.H{"analista": nome, "resumo": resumirTR(lst)})
		}
		sort.Slice(lista, func(i, j int) bool {
			return lista[i]["resumo"].(trResumo).N > lista[j]["resumo"].(trResumo).N
		})
		porAnalista[tipo] = lista
	}

	// lista: tudo desde o marco, mais recente primeiro
	recentes := make([]trItem, 0)
	for i := len(itens) - 1; i >= 0; i-- {
		if itens[i].Depois {
			recentes = append(recentes, itens[i])
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"marco":        MarcoTelaProtocolos.Format("2006-01-02"),
		"inicio_base":  inicioBaseTempoResposta,
		"gerado_em":    time.Now().Unix(),
		"resumo":       resumo,
		"por_mes":      porMes,
		"por_analista": porAnalista,
		"itens":        recentes,
	})
}
