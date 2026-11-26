package handlers

// Linha do tempo de cada processo do relatório de priorização (desde a procedência):
//   - anotações da equipe no FT_HISTORICO_MOVIMENTACOES (sem as atualizações automáticas);
//   - e-mails das caixas que citam a UC (resposta da distribuidora, pedidos nossos) e os vinculados ao processo;
//   - o dossiê "Procedente - Relatórios e Evidências" enviado ao financeiro.
// Ex.: 16619 → 05/11 pedido do comprovante · 16/11 Enel CE envia o comprovante · 26/11 detalhamento · 26/11 dossiê.

import (
	"database/sql"
	"log"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type priorizacaoEvento struct {
	Data  string `json:"data"`
	Tipo  string `json:"tipo"`
	Texto string `json:"texto"`
	t     time.Time
	chave string
}

const historicoPrioMax = 15

var reTokenUC = regexp.MustCompile(`[0-9A-Za-z][0-9A-Za-z.\-/]{4,}[0-9]`)
var reHistAuto = regexp.MustCompile(`(?i)^(atualiza[çc][ãa]o autom|ressarcimento estimado alterado|classifica[çc][ãa]o atualizada|e-mail anexado ao processo|reconcilia[çc][ãa]o|tipo: |movido em lote)`)

func cortar(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

func remetentePrio(email, nome string) string {
	email = strings.ToLower(strings.TrimSpace(email))
	if strings.HasSuffix(email, "@amee.com.br") {
		if nome != "" {
			return "AMEE (" + strings.Fields(nome)[0] + ")"
		}
		return "AMEE"
	}
	if i := strings.Index(email, "@"); i >= 0 {
		dom := email[i+1:]
		if j := strings.Index(dom, "."); j > 0 {
			dom = dom[:j]
		}
		return strings.ToUpper(dom[:1]) + dom[1:]
	}
	return email
}

func carregarHistoricoPrio(db *sql.DB, itens []*priorizacaoItem) {
	if len(itens) == 0 {
		return
	}
	por := map[int64]*priorizacaoItem{}
	porUC := map[string][]*priorizacaoItem{}
	ids := make([]string, 0, len(itens))
	desde := time.Now().AddDate(-2, 0, 0)
	inicio := func(it *priorizacaoItem) time.Time {
		if !it.procedencia.IsZero() {
			return it.procedencia.AddDate(0, 0, -1)
		}
		return time.Now().AddDate(0, -6, 0)
	}
	for _, it := range itens {
		por[it.IDProcesso] = it
		ids = append(ids, strconv.FormatInt(it.IDProcesso, 10))
		if k := normUC(it.UC); len(k) >= 6 {
			porUC[k] = append(porUC[k], it)
		}
		if i := inicio(it); i.Before(desde) {
			desde = i
		}
	}
	add := func(it *priorizacaoItem, ev priorizacaoEvento) {
		if ev.t.IsZero() || ev.t.Before(inicio(it)) {
			return
		}
		for _, e := range it.Historico {
			if ev.chave != "" && e.chave == ev.chave {
				return
			}
		}
		ev.Data = ev.t.Format("2006-01-02")
		it.Historico = append(it.Historico, ev)
	}

	// e-mails (assunto + início do texto) do período
	type msg struct {
		t                    time.Time
		de, nome, assunto, s string
	}
	porGraph := map[string]msg{}
	if r, err := db.Query(`SELECT graph_message_id, received_at, COALESCE(from_email,''), COALESCE(from_name,''), COALESCE(subject,''), COALESCE(snippet,'')
	                          FROM mail_messages WHERE received_at >= ?`, desde); err == nil {
		for r.Next() {
			var gid string
			var m msg
			if r.Scan(&gid, &m.t, &m.de, &m.nome, &m.assunto, &m.s) != nil {
				continue
			}
			porGraph[gid] = m
			vistos := map[int64]bool{}
			for _, tok := range reTokenUC.FindAllString(m.assunto+" "+m.s, -1) {
				for _, it := range porUC[normUC(tok)] {
					if vistos[it.IDProcesso] {
						continue
					}
					vistos[it.IDProcesso] = true
					tipo := "E-mail · " + remetentePrio(m.de, m.nome)
					if strings.HasPrefix(m.assunto, "Procedente - Relat") && strings.HasSuffix(strings.ToLower(m.de), "@amee.com.br") {
						tipo = "Dossiê ao financeiro"
					}
					add(it, priorizacaoEvento{t: m.t, Tipo: tipo, Texto: cortar(m.assunto, 160), chave: gid})
				}
			}
		}
		r.Close()
	} else {
		log.Printf("carregarHistoricoPrio e-mails: %v", err)
	}

	// anotações do histórico + e-mails vinculados
	if r, err := db.Query(`SELECT id_processo, data_movimentacao, COALESCE(comentario,''), COALESCE(tipo_movimentacao,''), COALESCE(mail_graph_message_id,'')
	                          FROM FT_HISTORICO_MOVIMENTACOES
	                         WHERE id_processo IN (` + strings.Join(ids, ",") + `)
	                           AND COALESCE(tipo_movimentacao,'') NOT IN ('auto','reconciliacao','status','criacao','classificacao','fatura')`); err == nil {
		for r.Next() {
			var idp int64
			var t time.Time
			var com, tipo, gid string
			if r.Scan(&idp, &t, &com, &tipo, &gid) != nil {
				continue
			}
			it := por[idp]
			if it == nil {
				continue
			}
			if gid != "" {
				if m, ok := porGraph[gid]; ok {
					add(it, priorizacaoEvento{t: m.t, Tipo: "E-mail · " + remetentePrio(m.de, m.nome), Texto: cortar(m.assunto, 160), chave: gid})
					continue
				}
			}
			com = strings.TrimSpace(com)
			if com == "" || reHistAuto.MatchString(com) {
				continue
			}
			add(it, priorizacaoEvento{t: t, Tipo: "Histórico", Texto: cortar(com, 220)})
		}
		r.Close()
	} else {
		log.Printf("carregarHistoricoPrio histórico: %v", err)
	}

	for _, it := range itens {
		h := it.Historico
		sort.SliceStable(h, func(a, b int) bool { return h[a].t.Before(h[b].t) })
		if len(h) > historicoPrioMax {
			h = h[len(h)-historicoPrioMax:]
		}
		if h == nil {
			h = []priorizacaoEvento{}
		}
		it.Historico = h
	}
}
