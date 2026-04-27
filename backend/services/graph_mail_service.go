package services

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type GraphFolder struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
}

type GraphMessage struct {
	ID                 string `json:"id"`
	InternetMessageID  string `json:"internet_message_id"`
	ConversationID     string `json:"thread_id"`
	Subject            string `json:"subject"`
	FromEmail          string `json:"from_email"`
	FromName           string `json:"from_name"`
	To                []string `json:"to"`
	Cc                []string `json:"cc"`
	ReceivedAt         string `json:"received_at"`
	BodyPreview        string `json:"snippet"`
	HasAttachments     bool   `json:"has_attachments"`
	IsRead             bool   `json:"is_read"`
	FolderID           string `json:"folder_id"`
}

type GraphMessageDetail struct {
	ID                 string `json:"id"`
	InternetMessageID  string `json:"internet_message_id"`
	ConversationID     string `json:"thread_id"`
	Subject            string `json:"subject"`
	FromEmail          string `json:"from_email"`
	FromName           string `json:"from_name"`
	To                []string `json:"to"`
	Cc                []string `json:"cc"`
	ReceivedAt         string `json:"received_at"`
	BodyPreview        string `json:"snippet"`
	HasAttachments     bool   `json:"has_attachments"`
	IsRead             bool   `json:"is_read"`
	BodyType           string `json:"body_type"`
	BodyContent        string `json:"body_content"`
	FolderID           string `json:"folder_id"`
}

type GraphAttachment struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
	IsInline    bool   `json:"is_inline"`
	ContentID   string `json:"content_id"`
}

type MailSendAttachment struct {
	Name        string
	ContentType string
	Content     []byte
}

func graphSender() (string, error) {
	sender := strings.TrimSpace(os.Getenv("MAIL_SENDER"))
	if sender == "" {
		sender = strings.TrimSpace(os.Getenv("SMTP_USER"))
	}
	if sender == "" {
		return "", errors.New("MAIL_SENDER nao configurado")
	}
	return sender, nil
}

func graphRequest(method, urlStr string, body io.Reader, extraHeaders map[string]string) (*http.Response, error) {
	token, err := getGraphToken()
	if err != nil {
		return nil, err
	}
	req, _ := http.NewRequest(method, urlStr, body)
	req.Header.Set("Authorization", "Bearer "+token)
	for k, v := range extraHeaders {
		req.Header.Set(k, v)
	}
	client := &http.Client{Timeout: 30 * time.Second}
	return client.Do(req)
}

func ListMailFolders() ([]GraphFolder, error) {
	sender, err := graphSender()
	if err != nil {
		return nil, err
	}
	urlStr := fmt.Sprintf("https://graph.microsoft.com/v1.0/users/%s/mailFolders?$top=200", sender)
	resp, err := graphRequest("GET", urlStr, nil, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("erro Graph folders: status %d", resp.StatusCode)
	}
	var payload struct {
		Value []struct {
			ID          string `json:"id"`
			DisplayName string `json:"displayName"`
		} `json:"value"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	out := make([]GraphFolder, 0, len(payload.Value))
	for _, f := range payload.Value {
		out = append(out, GraphFolder{ID: f.ID, DisplayName: f.DisplayName})
	}
	return out, nil
}

func ListMailMessages(folderID, q string, unread *bool, limit, offset int) ([]GraphMessage, error) {
	originalQ := strings.TrimSpace(q)
	out, err := fetchMailGraph(folderID, originalQ, unread, limit, offset)
	if err != nil {
		return nil, err
	}
	// Identificadores como "30.123.456" / "2024-001" são tokenizados com a pontuação
	// pelo indexador do Graph. Se o phrase search retornar vazio, tenta de novo
	// com a pontuação removida — frequentemente o termo "limpo" foi indexado.
	if len(out) == 0 && originalQ != "" {
		cleaned := stripIDPunctuation(originalQ)
		if cleaned != "" && cleaned != originalQ {
			if alt, altErr := fetchMailGraph(folderID, cleaned, unread, limit, offset); altErr == nil && len(alt) > 0 {
				out = alt
			}
		}
	}
	return out, nil
}

// fetchMailGraph chama o Graph com phrase search global e aplica fallback local
// (filtra por subject + bodyPreview + remetentes/destinatários) quando o $search é rejeitado com 400.
func fetchMailGraph(folderID, q string, unread *bool, limit, offset int) ([]GraphMessage, error) {
	sender, err := graphSender()
	if err != nil {
		return nil, err
	}
	selectFields := "id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,hasAttachments,isRead,internetMessageId,conversationId,parentFolderId"
	params := url.Values{}
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	params.Set("$top", strconv.Itoa(limit))
	if offset < 0 {
		offset = 0
	}
	if offset > 0 {
		params.Set("$skip", strconv.Itoa(offset))
	}
	params.Set("$orderby", "receivedDateTime desc")
	params.Set("$select", selectFields)
	if q != "" {
		// Phrase search global: deixa o Graph escolher os campos relevantes (body, subject, from, to...)
		// e tolera melhor pontuação do que `body:"x" OR subject:"x"`.
		params.Set("$search", strconv.Quote(q))
	}
	if unread != nil {
		params.Set("$filter", fmt.Sprintf("isRead eq %v", !*unread))
	}
	urlStr := fmt.Sprintf("https://graph.microsoft.com/v1.0/users/%s/mailFolders/%s/messages?%s", sender, url.PathEscape(folderID), params.Encode())
	headers := map[string]string{}
	if q != "" {
		headers["ConsistencyLevel"] = "eventual"
	}
	resp, err := graphRequest("GET", urlStr, nil, headers)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	// Fallback de status 400: remove $search e filtra localmente.
	usedFallback := false
	if resp.StatusCode == http.StatusBadRequest && q != "" {
		_ = resp.Body.Close()
		params.Del("$search")
		urlStr = fmt.Sprintf("https://graph.microsoft.com/v1.0/users/%s/mailFolders/%s/messages?%s", sender, url.PathEscape(folderID), params.Encode())
		resp, err = graphRequest("GET", urlStr, nil, map[string]string{})
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		usedFallback = true
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("erro Graph messages: status %d", resp.StatusCode)
	}
	var payload struct {
		Value []graphMessageRaw `json:"value"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	out := make([]GraphMessage, 0, len(payload.Value))
	for _, m := range payload.Value {
		out = append(out, mapGraphMessage(m))
	}
	if usedFallback && q != "" {
		needle := strings.ToLower(q)
		filtered := make([]GraphMessage, 0, len(out))
		for _, m := range out {
			if strings.Contains(strings.ToLower(m.Subject), needle) ||
				strings.Contains(strings.ToLower(m.FromEmail), needle) ||
				strings.Contains(strings.ToLower(m.FromName), needle) ||
				strings.Contains(strings.ToLower(m.BodyPreview), needle) {
				filtered = append(filtered, m)
				continue
			}
			hay := strings.ToLower(strings.Join(m.To, " ")) + " " + strings.ToLower(strings.Join(m.Cc, " "))
			if strings.Contains(hay, needle) {
				filtered = append(filtered, m)
			}
		}
		out = filtered
	}
	return out, nil
}

// stripIDPunctuation remove ., -, /, espaços de termos que parecem identificadores numéricos
// (mantém só se o resultado contiver ao menos um dígito — para não atrapalhar busca em frases comuns).
func stripIDPunctuation(s string) string {
	var b strings.Builder
	hasDigit := false
	for _, r := range s {
		switch r {
		case '.', '-', '/', ' ', '\t':
			continue
		default:
			if r >= '0' && r <= '9' {
				hasDigit = true
			}
			b.WriteRune(r)
		}
	}
	if !hasDigit {
		return s
	}
	return b.String()
}

func GetMailMessage(id string) (*GraphMessageDetail, error) {
	sender, err := graphSender()
	if err != nil {
		return nil, err
	}
	selectFields := "id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,hasAttachments,isRead,internetMessageId,conversationId,parentFolderId,body"
	urlStr := fmt.Sprintf("https://graph.microsoft.com/v1.0/users/%s/messages/%s?$select=%s", sender, url.PathEscape(id), url.QueryEscape(selectFields))
	resp, err := graphRequest("GET", urlStr, nil, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("erro Graph message: status %d", resp.StatusCode)
	}
	var raw graphMessageRaw
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}
	detail := mapGraphMessageDetail(raw)
	return &detail, nil
}

func GetMailMessageMime(id string) ([]byte, error) {
	sender, err := graphSender()
	if err != nil {
		return nil, err
	}
	urlStr := fmt.Sprintf("https://graph.microsoft.com/v1.0/users/%s/messages/%s/$value", sender, url.PathEscape(id))
	resp, err := graphRequest("GET", urlStr, nil, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("erro Graph MIME: status %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

func ListMailAttachments(messageID string) ([]GraphAttachment, error) {
	sender, err := graphSender()
	if err != nil {
		return nil, err
	}
	urlStr := fmt.Sprintf("https://graph.microsoft.com/v1.0/users/%s/messages/%s/attachments?$top=100", sender, url.PathEscape(messageID))
	resp, err := graphRequest("GET", urlStr, nil, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("erro Graph attachments: status %d", resp.StatusCode)
	}
	var payload struct {
		Value []struct {
			ID          string `json:"id"`
			Name        string `json:"name"`
			ContentType string `json:"contentType"`
			Size        int64  `json:"size"`
			IsInline    bool   `json:"isInline"`
			ContentID   string `json:"contentId"`
			OdataType   string `json:"@odata.type"`
		} `json:"value"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	out := make([]GraphAttachment, 0, len(payload.Value))
	for _, a := range payload.Value {
		out = append(out, GraphAttachment{
			ID:          a.ID,
			Name:        a.Name,
			ContentType: a.ContentType,
			Size:        a.Size,
			IsInline:    a.IsInline,
			ContentID:   a.ContentID,
		})
	}
	return out, nil
}

func DownloadMailAttachment(messageID, attachmentID string) (string, string, []byte, error) {
	sender, err := graphSender()
	if err != nil {
		return "", "", nil, err
	}
	urlStr := fmt.Sprintf("https://graph.microsoft.com/v1.0/users/%s/messages/%s/attachments/%s", sender, url.PathEscape(messageID), url.PathEscape(attachmentID))
	resp, err := graphRequest("GET", urlStr, nil, nil)
	if err != nil {
		return "", "", nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", nil, fmt.Errorf("erro Graph attachment: status %d", resp.StatusCode)
	}
	var raw map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return "", "", nil, err
	}
	name, _ := raw["name"].(string)
	ct, _ := raw["contentType"].(string)
	if ct == "" {
		ct = "application/octet-stream"
	}
	if odataType, ok := raw["@odata.type"].(string); ok && odataType != "" {
		if !strings.Contains(strings.ToLower(odataType), "fileattachment") {
			return name, ct, nil, fmt.Errorf("tipo de anexo não suportado: %s", odataType)
		}
	}
	// fileAttachment traz contentBytes
	if contentBytes, ok := raw["contentBytes"].(string); ok && contentBytes != "" {
		data, err := decodeBase64(contentBytes)
		if err == nil {
			return name, ct, data, nil
		}
		// fallback: some attachments come with url-safe/base64 variants
	}
	// fallback: baixar raw
	urlRaw := fmt.Sprintf("https://graph.microsoft.com/v1.0/users/%s/messages/%s/attachments/%s/$value", sender, url.PathEscape(messageID), url.PathEscape(attachmentID))
	resp2, err := graphRequest("GET", urlRaw, nil, nil)
	if err != nil {
		return "", "", nil, err
	}
	defer resp2.Body.Close()
	if resp2.StatusCode < 200 || resp2.StatusCode >= 300 {
		return "", "", nil, fmt.Errorf("erro Graph attachment raw: status %d", resp2.StatusCode)
	}
	data, err := io.ReadAll(resp2.Body)
	if err != nil {
		return "", "", nil, err
	}
	return name, ct, data, nil
}

func MoveMailMessage(messageID, folderID string) error {
	sender, err := graphSender()
	if err != nil {
		return err
	}
	payload := map[string]any{"destinationId": folderID}
	data, _ := json.Marshal(payload)
	urlStr := fmt.Sprintf("https://graph.microsoft.com/v1.0/users/%s/messages/%s/move", sender, url.PathEscape(messageID))
	resp, err := graphRequest("POST", urlStr, bytes.NewReader(data), map[string]string{"Content-Type": "application/json"})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("erro Graph move: status %d", resp.StatusCode)
	}
	return nil
}

func SetMailRead(messageID string, isRead bool) error {
	sender, err := graphSender()
	if err != nil {
		return err
	}
	payload := map[string]any{"isRead": isRead}
	data, _ := json.Marshal(payload)
	urlStr := fmt.Sprintf("https://graph.microsoft.com/v1.0/users/%s/messages/%s", sender, url.PathEscape(messageID))
	resp, err := graphRequest("PATCH", urlStr, bytes.NewReader(data), map[string]string{"Content-Type": "application/json"})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("erro Graph set read: status %d", resp.StatusCode)
	}
	return nil
}

func ReplyMailMessage(messageID string, comment string, replyAll bool) error {
	sender, err := graphSender()
	if err != nil {
		return err
	}
	action := "reply"
	if replyAll {
		action = "replyAll"
	}
	payload := map[string]any{"comment": comment}
	data, _ := json.Marshal(payload)
	urlStr := fmt.Sprintf("https://graph.microsoft.com/v1.0/users/%s/messages/%s/%s", sender, url.PathEscape(messageID), action)
	resp, err := graphRequest("POST", urlStr, bytes.NewReader(data), map[string]string{"Content-Type": "application/json"})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("erro Graph %s: status %d", action, resp.StatusCode)
	}
	return nil
}

func ForwardMailMessage(messageID string, to string, comment string) error {
	sender, err := graphSender()
	if err != nil {
		return err
	}
	payload := map[string]any{
		"comment":      comment,
		"toRecipients": buildRecipients(to),
	}
	data, _ := json.Marshal(payload)
	urlStr := fmt.Sprintf("https://graph.microsoft.com/v1.0/users/%s/messages/%s/forward", sender, url.PathEscape(messageID))
	resp, err := graphRequest("POST", urlStr, bytes.NewReader(data), map[string]string{"Content-Type": "application/json"})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("erro Graph forward: status %d", resp.StatusCode)
	}
	return nil
}

func SendMailMessage(subject, body, bodyType string, to, cc, bcc []string, attachments []MailSendAttachment) (string, error) {
	sender, err := graphSender()
	if err != nil {
		return "", err
	}
	if bodyType == "" {
		bodyType = "HTML"
	}

	type recipient struct {
		EmailAddress struct {
			Address string `json:"address"`
		} `json:"emailAddress"`
	}
	makeRecipients := func(list []string) []recipient {
		out := make([]recipient, 0, len(list))
		for _, addr := range list {
			addr = strings.TrimSpace(addr)
			if addr == "" {
				continue
			}
			var r recipient
			r.EmailAddress.Address = addr
			out = append(out, r)
		}
		return out
	}

	msg := map[string]any{
		"subject": subject,
		"body": map[string]any{
			"contentType": strings.ToUpper(bodyType),
			"content":     body,
		},
		"toRecipients":  makeRecipients(to),
		"ccRecipients":  makeRecipients(cc),
		"bccRecipients": makeRecipients(bcc),
	}

	if len(attachments) > 0 {
		atts := make([]map[string]any, 0, len(attachments))
		for _, att := range attachments {
			if len(att.Content) == 0 || att.Name == "" {
				continue
			}
			atts = append(atts, map[string]any{
				"@odata.type": "#microsoft.graph.fileAttachment",
				"name":        att.Name,
				"contentType": att.ContentType,
				"contentBytes": base64.StdEncoding.EncodeToString(att.Content),
			})
		}
		if len(atts) > 0 {
			msg["attachments"] = atts
		}
	}

	payload := map[string]any{
		"message":         msg,
		"saveToSentItems": true,
	}
	bodyBytes, _ := json.Marshal(payload)

	// Cria mensagem (rascunho) para obter o ID
	createURL := fmt.Sprintf("https://graph.microsoft.com/v1.0/users/%s/messages", sender)
	resp, err := graphRequest("POST", createURL, bytes.NewReader(bodyBytes), map[string]string{
		"Content-Type": "application/json",
	})
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("erro Graph create message: status %d: %s", resp.StatusCode, string(b))
	}

	var created struct {
		ID string `json:"id"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&created)
	if strings.TrimSpace(created.ID) == "" {
		return "", fmt.Errorf("nao foi possivel obter id da mensagem criada")
	}

	sendURL := fmt.Sprintf("https://graph.microsoft.com/v1.0/users/%s/messages/%s/send", sender, url.PathEscape(created.ID))
	sendResp, err := graphRequest("POST", sendURL, bytes.NewReader([]byte{}), map[string]string{
		"Content-Type": "application/json",
	})
	if err != nil {
		return "", err
	}
	defer sendResp.Body.Close()
	if sendResp.StatusCode < 200 || sendResp.StatusCode >= 300 {
		b, _ := io.ReadAll(sendResp.Body)
		return "", fmt.Errorf("erro Graph send: status %d: %s", sendResp.StatusCode, string(b))
	}
	return created.ID, nil
}

type graphMessageRaw struct {
	ID                string `json:"id"`
	Subject           string `json:"subject"`
	BodyPreview       string `json:"bodyPreview"`
	ReceivedDateTime  string `json:"receivedDateTime"`
	HasAttachments    bool   `json:"hasAttachments"`
	IsRead            bool   `json:"isRead"`
	InternetMessageID string `json:"internetMessageId"`
	ConversationID    string `json:"conversationId"`
	ParentFolderID    string `json:"parentFolderId"`
	From              struct {
		EmailAddress struct {
			Address string `json:"address"`
			Name    string `json:"name"`
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
	Body struct {
		ContentType string `json:"contentType"`
		Content     string `json:"content"`
	} `json:"body"`
}

func mapGraphMessage(raw graphMessageRaw) GraphMessage {
	to := make([]string, 0)
	for _, r := range raw.ToRecipients {
		if addr := strings.TrimSpace(r.EmailAddress.Address); addr != "" {
			to = append(to, addr)
		}
	}
	cc := make([]string, 0)
	for _, r := range raw.CcRecipients {
		if addr := strings.TrimSpace(r.EmailAddress.Address); addr != "" {
			cc = append(cc, addr)
		}
	}
	return GraphMessage{
		ID:                raw.ID,
		InternetMessageID: raw.InternetMessageID,
		ConversationID:    raw.ConversationID,
		Subject:           raw.Subject,
		FromEmail:         strings.TrimSpace(raw.From.EmailAddress.Address),
		FromName:          strings.TrimSpace(raw.From.EmailAddress.Name),
		To:               to,
		Cc:               cc,
		ReceivedAt:        raw.ReceivedDateTime,
		BodyPreview:       raw.BodyPreview,
		HasAttachments:    raw.HasAttachments,
		IsRead:            raw.IsRead,
		FolderID:          raw.ParentFolderID,
	}
}

func mapGraphMessageDetail(raw graphMessageRaw) GraphMessageDetail {
	base := mapGraphMessage(raw)
	return GraphMessageDetail{
		ID:                base.ID,
		InternetMessageID: base.InternetMessageID,
		ConversationID:    base.ConversationID,
		Subject:           base.Subject,
		FromEmail:         base.FromEmail,
		FromName:          base.FromName,
		To:               base.To,
		Cc:               base.Cc,
		ReceivedAt:        base.ReceivedAt,
		BodyPreview:       base.BodyPreview,
		HasAttachments:    base.HasAttachments,
		IsRead:            base.IsRead,
		BodyType:          raw.Body.ContentType,
		BodyContent:       raw.Body.Content,
		FolderID:          base.FolderID,
	}
}

func decodeBase64(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, errors.New("base64 vazio")
	}
	// try standard base64
	if data, err := base64.StdEncoding.DecodeString(s); err == nil {
		return data, nil
	}
	// try raw standard (no padding)
	if data, err := base64.RawStdEncoding.DecodeString(s); err == nil {
		return data, nil
	}
	// try url-safe variants
	if data, err := base64.RawURLEncoding.DecodeString(s); err == nil {
		return data, nil
	}
	if data, err := base64.URLEncoding.DecodeString(s); err == nil {
		return data, nil
	}
	// normalize url-safe to standard and retry
	n := strings.ReplaceAll(strings.ReplaceAll(s, "-", "+"), "_", "/")
	if data, err := base64.StdEncoding.DecodeString(n); err == nil {
		return data, nil
	}
	return nil, errors.New("base64 inválido")
}
