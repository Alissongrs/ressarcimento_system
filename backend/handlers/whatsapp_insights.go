package handlers

// Insights da tela WhatsApp (só admin): números do período, conversas aguardando resposta, tempo de
// resposta, volume por dia/hora, contatos mais ativos, assuntos (por palavras-chave) e mensagens com
// palavras de alerta. Só conversas diretas — grupos (inclusive o grupo dos avisos) ficam de fora.
// Nada é ligado a processo.

import (
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

// assuntos por palavras-chave (texto sem acento, minúsculo) — é estimativa, não leitura de IA
var waAssuntos = []struct {
	Nome string
	Re   *regexp.Regexp
}{
	{"Andamento / status", regexp.MustCompile(`andamento|status|novidade|atualiza|como (esta|ficou|anda)|previsao|alguma posicao|retorno`)},
	{"Documentos / comprovantes", regexp.MustCompile(`comprovante|documento|procuracao|contrato|anexo|segue (o|a|em)|planilha|\bpdf\b`)},
	{"Fatura / conta de energia", regexp.MustCompile(`fatura|conta de (luz|energia)|boleto|2a via|segunda via|consumo|leitura|medidor`)},
	{"Pagamento / crédito / depósito", regexp.MustCompile(`pagamento|pagar|deposito|credito|reembolso|devolu|ressarc|\bpix\b|valor`)},
	{"Reclamação / insatisfação", regexp.MustCompile(`reclama|demora|absurdo|insatisf|descaso|ninguem (responde|retorna)|sem resposta`)},
}

var waReAlerta = regexp.MustCompile(`procon|advogad|judicial|justica|processar|cancelar|cancelamento|urgente|urgencia|absurdo|descaso`)

var waSemAcento = strings.NewReplacer("á", "a", "à", "a", "â", "a", "ã", "a", "é", "e", "ê", "e", "í", "i",
	"ó", "o", "ô", "o", "õ", "o", "ú", "u", "ü", "u", "ç", "c")

func waNorm(s string) string { return waSemAcento.Replace(strings.ToLower(s)) }

type waContato struct {
	Chat      string `json:"chat"`
	Nome      string `json:"nome"`
	Recebidas int    `json:"recebidas"`
	Enviadas  int    `json:"enviadas"`
}

type waAguardando struct {
	Chat        string    `json:"chat"`
	Nome        string    `json:"nome"`
	Desde       time.Time `json:"desde"`
	EsperaMin   int       `json:"espera_min"`
	SemResposta int       `json:"sem_resposta"`
	UltimoTexto string    `json:"ultimo_texto"`
	UltimoTipo  string    `json:"ultimo_tipo"`
}

type waAlerta struct {
	Chat    string    `json:"chat"`
	Nome    string    `json:"nome"`
	Quando  time.Time `json:"quando"`
	Texto   string    `json:"texto"`
	Palavra string    `json:"palavra"`
}

type waDia struct {
	Dia       string `json:"dia"`
	Recebidas int    `json:"recebidas"`
	Enviadas  int    `json:"enviadas"`
}

type waAssunto struct {
	Assunto   string `json:"assunto"`
	Conversas int    `json:"conversas"`
	Mensagens int    `json:"mensagens"`
	Exemplo   string `json:"exemplo"`
}

// GET /whatsapp/insights?dias=30
func WhatsappInsights(c *gin.Context) {
	if _, ok := waEquipe(c); !ok {
		return
	}
	dias, _ := strconv.Atoi(c.DefaultQuery("dias", "30"))
	if dias <= 0 || dias > 365 {
		dias = 30
	}
	var msgs []struct {
		Chat      string
		ChatNome  string
		DeMim     bool
		Tipo      string
		Texto     string
		EnviadaEm time.Time
	}
	database.GormDB_App.Raw(`SELECT chat, COALESCE(chat_nome,'') AS chat_nome, de_mim, tipo, COALESCE(texto,'') AS texto, enviada_em
		FROM FT_WHATSAPP_MENSAGENS
		WHERE grupo = 0 AND status_envio = 'ok' AND enviada_em >= CURDATE() - INTERVAL ? DAY
		ORDER BY chat, enviada_em, id`, dias-1).Scan(&msgs)

	loc, err := time.LoadLocation("America/Sao_Paulo")
	if err != nil {
		loc = time.Local
	}
	agora := time.Now()

	porDia := map[string]*waDia{}
	serieDias := make([]*waDia, 0, dias)
	for i := dias - 1; i >= 0; i-- {
		d := &waDia{Dia: agora.In(loc).AddDate(0, 0, -i).Format("2006-01-02")}
		porDia[d.Dia] = d
		serieDias = append(serieDias, d)
	}
	porHora := make([]int, 24)
	porTipo := map[string]int{}
	contatos := map[string]*waContato{}
	assuntoConversas := make([]map[string]bool, len(waAssuntos))
	assuntoMsgs := make([]int, len(waAssuntos))
	assuntoExemplo := make([]string, len(waAssuntos))
	for i := range assuntoConversas {
		assuntoConversas[i] = map[string]bool{}
	}
	var respostas []float64
	espera := []waAguardando{}
	alertas := []waAlerta{}
	recebidas, enviadas := 0, 0

	// mensagens vêm ordenadas por conversa e hora: percorre conversa a conversa
	for i := 0; i < len(msgs); {
		j := i
		for j < len(msgs) && msgs[j].Chat == msgs[i].Chat {
			j++
		}
		conv := msgs[i:j]
		ct := &waContato{Chat: conv[0].Chat}
		var esperaDesde *time.Time // 1ª mensagem do contato ainda sem resposta
		semResp := 0
		for _, m := range conv {
			if m.ChatNome != "" {
				ct.Nome = m.ChatNome
			}
			t := m.EnviadaEm.In(loc)
			if d := porDia[t.Format("2006-01-02")]; d != nil {
				if m.DeMim {
					d.Enviadas++
				} else {
					d.Recebidas++
				}
			}
			if m.DeMim {
				enviadas++
				ct.Enviadas++
				if esperaDesde != nil {
					respostas = append(respostas, m.EnviadaEm.Sub(*esperaDesde).Minutes())
					esperaDesde, semResp = nil, 0
				}
				continue
			}
			recebidas++
			ct.Recebidas++
			porHora[t.Hour()]++
			porTipo[m.Tipo]++
			if m.Tipo == "reação" {
				continue // reação não pede resposta nem tem assunto
			}
			if esperaDesde == nil {
				tt := m.EnviadaEm
				esperaDesde = &tt
			}
			semResp++
			txt := waNorm(m.Texto)
			if txt == "" {
				continue
			}
			for k, a := range waAssuntos {
				if a.Re.MatchString(txt) {
					assuntoConversas[k][m.Chat] = true
					assuntoMsgs[k]++
					assuntoExemplo[k] = m.Texto
				}
			}
			if p := waReAlerta.FindString(txt); p != "" {
				alertas = append(alertas, waAlerta{Chat: m.Chat, Quando: m.EnviadaEm, Texto: m.Texto, Palavra: p})
			}
		}
		if esperaDesde != nil {
			u := conv[len(conv)-1]
			espera = append(espera, waAguardando{Chat: ct.Chat, Desde: *esperaDesde, EsperaMin: int(agora.Sub(*esperaDesde).Minutes()),
				SemResposta: semResp, UltimoTexto: u.Texto, UltimoTipo: u.Tipo})
		}
		contatos[ct.Chat] = ct
		i = j
	}
	for k := range espera {
		espera[k].Nome = contatos[espera[k].Chat].Nome
	}
	for k := range alertas {
		alertas[k].Nome = contatos[alertas[k].Chat].Nome
	}
	sort.Slice(espera, func(a, b int) bool { return espera[a].Desde.Before(espera[b].Desde) })
	sort.Slice(alertas, func(a, b int) bool { return alertas[a].Quando.After(alertas[b].Quando) })
	if len(alertas) > 30 {
		alertas = alertas[:30]
	}
	top := make([]*waContato, 0, len(contatos))
	for _, ct := range contatos {
		top = append(top, ct)
	}
	sort.Slice(top, func(a, b int) bool { return top[a].Recebidas+top[a].Enviadas > top[b].Recebidas+top[b].Enviadas })
	if len(top) > 10 {
		top = top[:10]
	}

	assuntos := make([]waAssunto, 0, len(waAssuntos))
	for k, a := range waAssuntos {
		assuntos = append(assuntos, waAssunto{a.Nome, len(assuntoConversas[k]), assuntoMsgs[k], assuntoExemplo[k]})
	}
	sort.SliceStable(assuntos, func(a, b int) bool { return assuntos[a].Conversas > assuntos[b].Conversas })

	resp := gin.H{"amostras": len(respostas)}
	if len(respostas) > 0 {
		sort.Float64s(respostas)
		dentro1h := 0
		for _, r := range respostas {
			if r <= 60 {
				dentro1h++
			}
		}
		resp["mediana_min"] = int(respostas[len(respostas)/2])
		resp["p90_min"] = int(respostas[(len(respostas)*9)/10])
		resp["pct_1h"] = 100 * dentro1h / len(respostas)
	}
	c.JSON(http.StatusOK, gin.H{
		"dias": dias, "conversas": len(contatos), "recebidas": recebidas, "enviadas": enviadas,
		"aguardando": espera, "resposta": resp, "por_dia": serieDias, "por_hora": porHora, "por_tipo": porTipo,
		"top_contatos": top, "assuntos": assuntos, "alertas": alertas,
	})
}
