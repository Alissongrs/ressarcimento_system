package services

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type graphMessageResp struct {
	Value    []graphMessage `json:"value"`
	NextLink string         `json:"@odata.nextLink"`
}

type graphMessage struct {
	ID      string `json:"id"`
	Subject string `json:"subject"`
	Body    struct {
		ContentType string `json:"contentType"`
		Content     string `json:"content"`
	} `json:"body"`
	From struct {
		EmailAddress struct {
			Address string `json:"address"`
		} `json:"emailAddress"`
	} `json:"from"`
	ToRecipients []struct {
		EmailAddress struct {
			Address string `json:"address"`
		} `json:"emailAddress"`
	} `json:"toRecipients"`
	CcRecipients []struct {
		EmailAddress struct {
			Address string `json:"address"`
		} `json:"emailAddress"`
	} `json:"ccRecipients"`
}

func lerEmailsRecebidosGraph() error {
	sender := strings.TrimSpace(os.Getenv("MAIL_SENDER"))
	if sender == "" {
		sender = strings.TrimSpace(os.Getenv("SMTP_USER"))
	}
	if sender == "" {
		return fmt.Errorf("MAIL_SENDER não configurado")
	}
	token, err := getGraphToken()
	if err != nil {
		return err
	}

	url := fmt.Sprintf("https://graph.microsoft.com/v1.0/users/%s/mailFolders/Inbox/messages?$top=25&$filter=isRead%%20eq%%20false", sender)
	client := &http.Client{Timeout: 25 * time.Second}
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("Graph inbox status %d", resp.StatusCode)
	}

	var payload graphMessageResp
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return err
	}
	if len(payload.Value) == 0 {
		return nil
	}

	for _, msg := range payload.Value {
		processoID := extrairProcessoIDDoAssunto(msg.Subject)
		from := strings.TrimSpace(msg.From.EmailAddress.Address)
		to := joinRecipients(msg.ToRecipients)
		cc := joinRecipients(msg.CcRecipients)
		subject := strings.TrimSpace(msg.Subject)
		body := strings.TrimSpace(msg.Body.Content)

		_, dbErr := getAppDB().Exec(`
            INSERT INTO FT_EMAILS_PROCESSO 
            (id_processo, de_email, para_email, cc_email, assunto, corpo, tipo)
            VALUES (?, ?, ?, ?, ?, ?, 'recebido')`,
			processoID, from, to, cc, subject, body,
		)
		if dbErr != nil {
			// segue para o próximo
		}

		// marca como lido
		_ = markGraphRead(token, sender, msg.ID)
	}

	return nil
}

func joinRecipients(list []struct {
	EmailAddress struct {
		Address string `json:"address"`
	} `json:"emailAddress"`
}) string {
	out := make([]string, 0, len(list))
	for _, r := range list {
		if addr := strings.TrimSpace(r.EmailAddress.Address); addr != "" {
			out = append(out, addr)
		}
	}
	return strings.Join(out, ", ")
}

func markGraphRead(token, sender, msgID string) error {
	url := fmt.Sprintf("https://graph.microsoft.com/v1.0/users/%s/messages/%s", sender, msgID)
	payload := []byte(`{"isRead": true}`)
	req, _ := http.NewRequest("PATCH", url, bytes.NewReader(payload))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("Graph mark read status %d: %s", resp.StatusCode, string(b))
	}
	return nil
}



