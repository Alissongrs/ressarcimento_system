// backend/services/imap_service.go

package services

import (
	"database/sql"
	"io"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/emersion/go-imap"
	"github.com/emersion/go-imap/client"
	"github.com/emersion/go-message/mail"
)

var emailReadMu sync.Mutex
var emailReadRunning bool

// LerEmailsRecebidos conecta ao servidor IMAP, lê e-mails não lidos e os salva no banco.
func LerEmailsRecebidos() {
	log.Println("Executando tarefa: Lendo e-mails recebidos...")
	emailReadMu.Lock()
	if emailReadRunning {
		emailReadMu.Unlock()
		log.Println("Leitura de e-mails já em execução. Ignorando nova chamada.")
		return
	}
	emailReadRunning = true
	emailReadMu.Unlock()
	defer func() {
		emailReadMu.Lock()
		emailReadRunning = false
		emailReadMu.Unlock()
	}()

	if graphEnabled() {
		if err := lerEmailsRecebidosGraph(); err != nil {
			log.Printf("Erro ao ler e-mails via Graph: %v", err)
		}
		return
	}
	log.Println("Usando IMAP (Graph não configurado).")

	imapHost := os.Getenv("IMAP_HOST")
	imapPort := os.Getenv("IMAP_PORT")
	imapUser := os.Getenv("SMTP_USER")
	imapPass := os.Getenv("SMTP_PASS")

	if imapHost == "" {
		log.Println("Aviso: ConfiguraÃ§ões de IMAP não encontradas. Tarefa de leitura de e-mail abortada.")
		return
	}

	// Conectar ao servidor
	c, err := client.DialTLS(imapHost+":"+imapPort, nil)
	if err != nil {
		log.Printf("Erro ao conectar ao servidor IMAP: %v", err)
		return
	}
	defer c.Logout()

	// Login
	if err := c.Login(imapUser, imapPass); err != nil {
		log.Printf("Erro ao fazer login no IMAP: %v", err)
		return
	}

	// Selecionar a Caixa de Entrada (INBOX)
	_, err = c.Select("INBOX", false)
	if err != nil {
		log.Printf("Erro ao selecionar INBOX: %v", err)
		return
	}

	// Procurar por e-mails não lidos
	criteria := imap.NewSearchCriteria()
	criteria.WithoutFlags = []string{imap.SeenFlag}
	ids, err := c.Search(criteria)
	if err != nil {
		log.Printf("Erro ao procurar e-mails não lidos: %v", err)
		return
	}

	if len(ids) == 0 {
		log.Println("Nenhum e-mail novo para ler.")
		return
	}

	seqset := new(imap.SeqSet)
	seqset.AddNum(ids...)

	// Prepara para buscar o corpo do e-mail
	section := &imap.BodySectionName{}
	items := []imap.FetchItem{section.FetchItem()}

	messages := make(chan *imap.Message, 10)
	go func() {
		if err := c.Fetch(seqset, items, messages); err != nil {
			log.Printf("Erro no Fetch de e-mails: %v", err)
		}
	}()

	// Processa cada mensagem
	for msg := range messages {
		r := msg.GetBody(section)
		if r == nil {
			continue
		}

		mr, err := mail.CreateReader(r)
		if err != nil {
			continue
		}

		// Extrai as informaÃ§ões do e-mail
		header := mr.Header
		from, _ := header.AddressList("From")
		to, _ := header.AddressList("To")
		subject, _ := header.Subject()

		// Lê o corpo do e-mail
		var body string
		for {
			p, err := mr.NextPart()
			if err == io.EOF {
				break
			}
			if p.Header.Get("Content-Type") == "text/plain" || strings.Contains(p.Header.Get("Content-Type"), "text/html") {
				b, _ := io.ReadAll(p.Body)
				body = string(b)
			}
		}

		// Tenta associar o e-mail a um processo pelo assunto
		processoID := extrairProcessoIDDoAssunto(subject)

		// Salva o e-mail recebido no banco
		_, dbErr := getAppDB().Exec(`
            INSERT INTO FT_EMAILS_PROCESSO 
            (id_processo, de_email, para_email, assunto, corpo, tipo)
            VALUES (?, ?, ?, ?, ?, 'recebido')`,
			processoID, from[0].Address, to[0].Address, subject, body,
		)
		if dbErr != nil {
			log.Printf("Erro ao salvar e-mail recebido no banco: %v", dbErr)
		}
	}

	log.Printf("%d novo(s) e-mail(s) processado(s).", len(ids))
}

// extrairProcessoIDDoAssunto usa uma expressão regular para encontrar "Processo #123" no assunto.
func extrairProcessoIDDoAssunto(subject string) sql.NullInt64 {
	re := regexp.MustCompile(`(?i)processo\s*#(\d+)`)
	matches := re.FindStringSubmatch(subject)

	if len(matches) > 1 {
		id, err := strconv.Atoi(matches[1])
		if err == nil {
			return sql.NullInt64{Int64: int64(id), Valid: true}
		}
	}
	return sql.NullInt64{Valid: false}
}



