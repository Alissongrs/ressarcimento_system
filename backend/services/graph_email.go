package services

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

type graphTokenResp struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int    `json:"expires_in"`
	TokenType   string `json:"token_type"`
}

func graphEnabled() bool {
	return strings.TrimSpace(os.Getenv("AZURE_TENANT_ID")) != "" &&
		strings.TrimSpace(os.Getenv("AZURE_CLIENT_ID")) != "" &&
		strings.TrimSpace(os.Getenv("AZURE_CLIENT_SECRET")) != ""
}

func sendEmailGraph(to, cc, bcc, subject, body string, attachments []EmailAttachment) error {
	sender := strings.TrimSpace(os.Getenv("MAIL_SENDER"))
	if sender == "" {
		sender = strings.TrimSpace(os.Getenv("SMTP_USER"))
	}
	if sender == "" {
		return errors.New("MAIL_SENDER não configurado")
	}

	token, err := getGraphToken()
	if err != nil {
		return err
	}

	msg := map[string]any{
		"subject": subject,
		"body": map[string]any{
			"contentType": "HTML",
			"content":     body,
		},
		"toRecipients":  buildRecipients(to),
		"ccRecipients":  buildRecipients(cc),
		"bccRecipients": buildRecipients(bcc),
	}

	if len(attachments) > 0 {
		msg["attachments"] = buildGraphAttachments(attachments)
	}

	payload := map[string]any{
		"message": msg,
		"saveToSentItems": true,
	}

	url := fmt.Sprintf("https://graph.microsoft.com/v1.0/users/%s/sendMail", sender)
	data, _ := json.Marshal(payload)

	req, _ := http.NewRequest("POST", url, bytes.NewReader(data))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(resp.Body)
		return fmt.Errorf("erro Graph sendMail: status %d — %s", resp.StatusCode, buf.String())
	}
	return nil
}

func getGraphToken() (string, error) {
	tenant := strings.TrimSpace(os.Getenv("AZURE_TENANT_ID"))
	clientID := strings.TrimSpace(os.Getenv("AZURE_CLIENT_ID"))
	secret := strings.TrimSpace(os.Getenv("AZURE_CLIENT_SECRET"))
	if tenant == "" || clientID == "" || secret == "" {
		return "", errors.New("credenciais Azure incompletas")
	}

	form := "client_id=" + urlEncode(clientID) +
		"&client_secret=" + urlEncode(secret) +
		"&grant_type=client_credentials" +
		"&scope=" + urlEncode("https://graph.microsoft.com/.default")
	tokenURL := fmt.Sprintf("https://login.microsoftonline.com/%s/oauth2/v2.0/token", tenant)
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		req, _ := http.NewRequest("POST", tokenURL, strings.NewReader(form))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

		client := &http.Client{Timeout: 10 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
		} else {
			if resp.StatusCode < 200 || resp.StatusCode >= 300 {
				_ = resp.Body.Close()
				lastErr = fmt.Errorf("falha ao obter token Graph: status %d", resp.StatusCode)
			} else {
				var out graphTokenResp
				if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
					lastErr = err
					_ = resp.Body.Close()
				} else if out.AccessToken == "" {
					lastErr = errors.New("token Graph vazio")
					_ = resp.Body.Close()
				} else {
					_ = resp.Body.Close()
					return out.AccessToken, nil
				}
			}
		}
		time.Sleep(time.Duration(attempt) * 700 * time.Millisecond)
	}
	return "", lastErr
}

func buildRecipients(raw string) []map[string]any {
	emails := splitEmails(raw)
	out := make([]map[string]any, 0, len(emails))
	for _, e := range emails {
		out = append(out, map[string]any{
			"emailAddress": map[string]any{"address": e},
		})
	}
	return out // retorna slice vazio (nunca nil) para evitar null no JSON
}

func buildGraphAttachments(items []EmailAttachment) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	for _, a := range items {
		if len(a.Data) == 0 || strings.TrimSpace(a.Name) == "" {
			continue
		}
		ct := strings.TrimSpace(a.ContentType)
		if ct == "" {
			ct = "application/octet-stream"
		}
		out = append(out, map[string]any{
			"@odata.type":  "#microsoft.graph.fileAttachment",
			"name":         a.Name,
			"contentType":  ct,
			"contentBytes": base64.StdEncoding.EncodeToString(a.Data),
		})
	}
	return out
}

func urlEncode(s string) string {
	replacer := strings.NewReplacer(
		"+", "%2B",
		"/", "%2F",
		"=", "%3D",
		" ", "%20",
		"&", "%26",
	)
	return replacer.Replace(s)
}
