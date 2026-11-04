package services

// Código de segurança do portal de faturas da Claro (PDP Claro / Accenture).
// O portal manda o código por e-mail (no-reply-PDP@accenture.com) para a Luciana; às vezes ele chega
// encaminhado para a Eliane. A extensão do SURE pede o código depois de enviar o login, e o backend
// procura SÓ esse e-mail nas caixas configuradas (autorizado pelo Alisson em 04/11/2026) e devolve
// apenas o número — nenhum outro conteúdo das caixas sai daqui.

import (
	"encoding/json"
	"fmt"
	"html"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

var (
	reCodigoPDP   = regexp.MustCompile(`(?i)portal\s+PDP\s*:?\s*(\d{4,8})`)
	reTagsHTMLPDP = regexp.MustCompile(`<[^>]+>`)
)

// CaixasCodigoPDP — caixas onde o código chega (env CLARO_PDP_CAIXAS, separadas por vírgula).
func CaixasCodigoPDP() []string {
	v := strings.TrimSpace(os.Getenv("CLARO_PDP_CAIXAS"))
	if v == "" {
		v = "luciana@amee.com.br,eliane.araujo@amee.com.br"
	}
	var out []string
	for _, c := range strings.Split(v, ",") {
		if c = strings.TrimSpace(c); strings.Contains(c, "@") {
			out = append(out, c)
		}
	}
	return out
}

// CodigoPDPClaro — o código mais recente recebido a partir de `desde` em qualquer das caixas.
// Devolve "" (sem erro) quando ainda não chegou.
func CodigoPDPClaro(desde time.Time) (codigo string, recebido time.Time, caixa string, err error) {
	params := url.Values{}
	params.Set("$filter", "receivedDateTime ge "+desde.UTC().Format("2006-01-02T15:04:05Z"))
	params.Set("$orderby", "receivedDateTime desc")
	params.Set("$top", "25")
	params.Set("$select", "subject,receivedDateTime,body")
	var ultimoErro error
	for _, cx := range CaixasCodigoPDP() {
		u := fmt.Sprintf("https://graph.microsoft.com/v1.0/users/%s/messages?%s", url.PathEscape(cx), params.Encode())
		resp, e := graphRequest("GET", u, nil, map[string]string{})
		if e != nil {
			ultimoErro = e
			continue
		}
		var payload struct {
			Value []struct {
				Subject          string `json:"subject"`
				ReceivedDateTime string `json:"receivedDateTime"`
				Body             struct {
					Content string `json:"content"`
				} `json:"body"`
			} `json:"value"`
		}
		ok := resp.StatusCode >= 200 && resp.StatusCode < 300
		if ok {
			e = json.NewDecoder(resp.Body).Decode(&payload)
		}
		resp.Body.Close()
		if !ok {
			ultimoErro = fmt.Errorf("Graph %s: status %d", cx, resp.StatusCode)
			continue
		}
		if e != nil {
			ultimoErro = e
			continue
		}
		for _, m := range payload.Value {
			if !strings.Contains(strings.ToLower(m.Subject), "plataforma digital de pagamentos") {
				continue
			}
			txt := html.UnescapeString(reTagsHTMLPDP.ReplaceAllString(m.Body.Content, " "))
			mm := reCodigoPDP.FindStringSubmatch(txt)
			if mm == nil {
				continue
			}
			t, _ := time.Parse(time.RFC3339, m.ReceivedDateTime)
			if t.After(recebido) {
				codigo, recebido, caixa = mm[1], t, cx
			}
			break // a lista vem do mais novo para o mais antigo
		}
	}
	if codigo == "" && ultimoErro != nil {
		return "", time.Time{}, "", ultimoErro
	}
	return codigo, recebido, caixa, nil
}
