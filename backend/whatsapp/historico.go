package whatsapp

// Busca das conversas inteiras: o WhatsApp manda só uma parte do histórico ao parear. O protocolo
// permite pedir ao celular "as N mensagens anteriores a esta" (history sync sob demanda), como o
// WhatsApp Web faz ao rolar para cima. PuxarHistorico percorre as conversas gravadas e repete o pedido,
// 50 por vez, até o celular não mandar mais nada. Uma busca por vez; o progresso aparece na tela.

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
)

// Progresso é o que a tela mostra enquanto a busca roda.
type Progresso struct {
	Rodando      bool       `json:"rodando"`
	Conversa     string     `json:"conversa"`
	ConversaNome string     `json:"conversa_nome"`
	Feitas       int        `json:"feitas"`
	Total        int        `json:"total"`
	Novas        int        `json:"novas"`
	SemAcesso    int        `json:"sem_acesso"` // conversas em que o celular tem mais, mas não libera
	Inicio       *time.Time `json:"inicio"`
	Fim          *time.Time `json:"fim"`
	Erro         string     `json:"erro"`
}

// respostaDemanda: o que veio numa resposta ON_DEMAND. fim = o celular avisou que não há mais nada
// antes; semAcesso = há mais, mas o celular não libera (conversa arquivada/limitada).
type respostaDemanda struct {
	recebidas, novas int
	fim, semAcesso   bool
}

var (
	progMu     sync.Mutex
	prog       Progresso
	pararBusca bool
	respostaCh = make(chan respostaDemanda, 4) // cada resposta ON_DEMAND do celular
)

func ProgressoHistorico() Progresso {
	progMu.Lock()
	defer progMu.Unlock()
	return prog
}

func PararHistorico() {
	progMu.Lock()
	pararBusca = true
	progMu.Unlock()
}

func deveParar() bool {
	progMu.Lock()
	defer progMu.Unlock()
	return pararBusca
}

func setProgErro(e string) {
	progMu.Lock()
	prog.Erro = e
	progMu.Unlock()
}

// PuxarHistorico começa a busca em segundo plano. chat vazio = todas as conversas gravadas.
func PuxarHistorico(chat string) error {
	mu.Lock()
	c := cli
	mu.Unlock()
	if c == nil || !c.IsConnected() {
		return fmt.Errorf("o WhatsApp não está conectado")
	}
	progMu.Lock()
	if prog.Rodando {
		progMu.Unlock()
		return fmt.Errorf("já tem uma busca em andamento; aguarde terminar")
	}
	agora := time.Now()
	prog = Progresso{Rodando: true, Inicio: &agora}
	pararBusca = false
	progMu.Unlock()
	go rodarBusca(c, chat)
	return nil
}

func rodarBusca(c *whatsmeow.Client, soChat string) {
	defer func() {
		progMu.Lock()
		t := time.Now()
		prog.Rodando, prog.Fim, prog.Conversa, prog.ConversaNome = false, &t, "", ""
		progMu.Unlock()
	}()
	db := gdb()
	if db == nil {
		setProgErro("banco indisponível")
		return
	}
	type conv struct{ chat, nome string }
	var convs []conv
	q := `SELECT chat, COALESCE(MAX(chat_nome),'') FROM FT_WHATSAPP_MENSAGENS WHERE origem='whatsapp' AND wa_id IS NOT NULL`
	args := []any{}
	if soChat != "" {
		q += " AND chat=?"
		args = append(args, soChat)
	}
	q += " GROUP BY chat ORDER BY MAX(enviada_em) DESC"
	rows, err := db.Query(q, args...)
	if err != nil {
		setProgErro("ler conversas: " + err.Error())
		return
	}
	for rows.Next() {
		var cv conv
		if rows.Scan(&cv.chat, &cv.nome) == nil {
			convs = append(convs, cv)
		}
	}
	rows.Close()
	progMu.Lock()
	prog.Total = len(convs)
	progMu.Unlock()
	for i, cv := range convs {
		if deveParar() {
			break
		}
		progMu.Lock()
		prog.Conversa, prog.ConversaNome, prog.Feitas = cv.chat, cv.nome, i
		progMu.Unlock()
		for rodada := 0; rodada < 200; rodada++ { // 200 × 50 = 10 mil mensagens por conversa, no máximo
			if deveParar() {
				break
			}
			r, fim := pedirMaisAntigas(c, db, cv.chat)
			progMu.Lock()
			prog.Novas += r.novas
			if r.semAcesso {
				prog.SemAcesso++
			}
			progMu.Unlock()
			// para quando: deu erro/tempo esgotado; o celular avisou que acabou; ou não veio NADA novo
			// (o celular repete as mesmas mensagens quando não tem mais antigas — sem isso o laço não parava)
			if fim || r.fim || r.semAcesso || r.recebidas == 0 || r.novas == 0 {
				break
			}
		}
	}
	progMu.Lock()
	prog.Feitas = len(convs)
	n := prog.Novas
	progMu.Unlock()
	log.Printf("[whatsapp] busca de histórico: %d conversas, %d mensagens novas", len(convs), n)
}

// pedirMaisAntigas pede ao celular 50 mensagens anteriores à mais antiga gravada da conversa e espera a
// resposta (ON_DEMAND). fim=true quando não dá para continuar (sem mensagem base, erro, celular mudo).
func pedirMaisAntigas(c *whatsmeow.Client, db *sql.DB, chat string) (respostaDemanda, bool) {
	var waID, remetente string
	var deMim bool
	var enviada time.Time
	err := db.QueryRow(`SELECT wa_id, COALESCE(remetente,''), de_mim, enviada_em FROM FT_WHATSAPP_MENSAGENS
		WHERE chat=? AND origem='whatsapp' AND wa_id IS NOT NULL ORDER BY enviada_em ASC, id ASC LIMIT 1`, chat).
		Scan(&waID, &remetente, &deMim, &enviada)
	if err != nil {
		return respostaDemanda{}, true
	}
	info, ok := infoDe(waID, chat, remetente, deMim, enviada)
	if !ok {
		return respostaDemanda{}, true
	}
	// descarta resposta atrasada de um pedido anterior
	for {
		select {
		case <-respostaCh:
			continue
		default:
		}
		break
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	log.Printf("[whatsapp] busca: pedindo 50 anteriores a %s (%s) em %s", waID, enviada.Format("2006-01-02 15:04"), chat)
	if _, err := c.SendPeerMessage(ctx, c.BuildHistorySyncRequest(&info, 50)); err != nil {
		setProgErro("pedido ao celular: " + err.Error())
		return respostaDemanda{}, true
	}
	select {
	case r := <-respostaCh:
		return r, false
	case <-time.After(90 * time.Second):
		setProgErro("o celular não respondeu em 90 s (está ligado, com internet e com o WhatsApp aberto?)")
		return respostaDemanda{}, true
	}
}
