package whatsapp

// Nomes dos contatos: o WhatsApp manda ao parear a agenda do celular (app state "critical_unblock_low")
// e a biblioteca guarda em Store.Contacts. A mensagem recebida ao vivo só traz o "nome de exibição"
// que a própria pessoa configurou (PushName); aqui preferimos o nome como está salvo na agenda do
// celular do departamento, que é o que a equipe reconhece.

import (
	"context"
	"log"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/appstate"
	"go.mau.fi/whatsmeow/types"
)

// nomeContato devolve o nome da agenda (ou o de exibição) de um contato; "" se não souber.
func nomeContato(jid types.JID) string {
	mu.Lock()
	c := cli
	mu.Unlock()
	if c == nil || jid.Server == types.GroupServer {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	alvo := jid.ToNonAD()
	if alvo.Server == types.HiddenUserServer { // id interno "@lid": tenta o telefone correspondente
		if pn, err := c.Store.LIDs.GetPNForLID(ctx, alvo); err == nil && !pn.IsEmpty() {
			if n := nomeDeContato(ctx, c, pn.ToNonAD()); n != "" {
				return n
			}
		}
	}
	return nomeDeContato(ctx, c, alvo)
}

func nomeDeContato(ctx context.Context, c *whatsmeow.Client, jid types.JID) string {
	ci, err := c.Store.Contacts.GetContact(ctx, jid)
	if err != nil || !ci.Found {
		return ""
	}
	for _, n := range []string{ci.FullName, ci.FirstName, ci.BusinessName, ci.PushName} {
		if n = strings.TrimSpace(n); n != "" {
			return n
		}
	}
	return ""
}

// AtualizarNomesContatos sincroniza a agenda (se ainda não veio) e grava o nome da agenda em todas as
// conversas diretas gravadas. Devolve quantas conversas ganharam/trocaram nome.
func AtualizarNomesContatos() (int, error) {
	mu.Lock()
	c := cli
	mu.Unlock()
	db := gdb()
	if c == nil || !c.IsConnected() || db == nil {
		return 0, errAviso("o WhatsApp não está conectado")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	// agenda do celular: só busca de novo se ainda não sincronizou
	if err := c.FetchAppState(ctx, appstate.WAPatchCriticalUnblockLow, false, true); err != nil {
		log.Printf("[whatsapp] agenda: %v", err)
	}
	rows, err := db.Query(`SELECT chat, COALESCE(MAX(chat_nome),'') FROM FT_WHATSAPP_MENSAGENS WHERE grupo=0 GROUP BY chat`)
	if err != nil {
		return 0, err
	}
	type cv struct{ chat, nome string }
	var lista []cv
	for rows.Next() {
		var x cv
		if rows.Scan(&x.chat, &x.nome) == nil {
			lista = append(lista, x)
		}
	}
	rows.Close()
	n := 0
	for _, x := range lista {
		jid, err := types.ParseJID(x.chat)
		if err != nil {
			continue
		}
		nome := nomeContato(jid)
		if nome == "" || nome == x.nome {
			continue
		}
		if _, err := db.Exec(`UPDATE FT_WHATSAPP_MENSAGENS SET chat_nome=? WHERE chat=?`, nome, x.chat); err == nil {
			n++
		}
	}
	log.Printf("[whatsapp] nomes da agenda: %d conversa(s) atualizada(s) de %d", n, len(lista))
	return n, nil
}

type errAviso string

func (e errAviso) Error() string { return string(e) }
