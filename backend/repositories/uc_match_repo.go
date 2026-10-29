package repositories

import (
	"regexp"
	"strings"

	"gorm.io/gorm"
)

// ucTokenRe casa tokens que parecem número de UC (alfanumérico, opcionalmente com
// hífens, 5+ caracteres) — mesmo padrão usado historicamente em mail_handler.go para
// achar UC em texto livre (assunto/corpo de e-mail, texto de fatura extraído, etc.).
var ucTokenRe = regexp.MustCompile(`[A-Za-z0-9-]{5,}`)

// FindProcessByUC extrai tokens tipo-UC do texto (com e sem hífen) e casa contra
// FT_REQUISICOES.uc. Só retorna match quando há EXATAMENTE UM candidato — ambiguidade
// (zero ou mais de um) não conta como match, para nunca vincular errado.
//
// Ponto único de verdade dessa regra: reaproveitado tanto pelo vínculo manual de e-mail
// (mail_handler.go) quanto pelo motor do Agente de Recepção (services/agente_recepcao_service.go).
func FindProcessByUC(tx *gorm.DB, text string) (int64, bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0, false
	}
	raw := ucTokenRe.FindAllString(text, -1)
	if len(raw) == 0 {
		return 0, false
	}
	tokens := make([]string, 0, len(raw))
	tokensNoHyphen := make([]string, 0, len(raw))
	seen := map[string]struct{}{}
	seenNo := map[string]struct{}{}
	for _, t := range raw {
		low := strings.ToLower(strings.TrimSpace(t))
		if low == "" {
			continue
		}
		if _, ok := seen[low]; !ok {
			seen[low] = struct{}{}
			tokens = append(tokens, low)
		}
		no := strings.ReplaceAll(low, "-", "")
		if no != "" {
			if _, ok := seenNo[no]; !ok {
				seenNo[no] = struct{}{}
				tokensNoHyphen = append(tokensNoHyphen, no)
			}
		}
	}
	if len(tokens) == 0 && len(tokensNoHyphen) == 0 {
		return 0, false
	}

	candidates := make(map[int64]struct{})

	if len(tokens) > 0 {
		ph := strings.Repeat("?,", len(tokens))
		ph = strings.TrimSuffix(ph, ",")
		args := make([]any, 0, len(tokens))
		for _, t := range tokens {
			args = append(args, t)
		}
		rows, err := tx.Raw(`
			SELECT r.id_requisicao
			FROM FT_REQUISICOES r
			WHERE LOWER(r.uc) IN (`+ph+`)`, args...).Rows()
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var pid int64
				if err := rows.Scan(&pid); err == nil && pid > 0 {
					candidates[pid] = struct{}{}
				}
			}
		}
	}

	if len(tokensNoHyphen) > 0 {
		ph := strings.Repeat("?,", len(tokensNoHyphen))
		ph = strings.TrimSuffix(ph, ",")
		args := make([]any, 0, len(tokensNoHyphen))
		for _, t := range tokensNoHyphen {
			args = append(args, t)
		}
		rows, err := tx.Raw(`
			SELECT r.id_requisicao
			FROM FT_REQUISICOES r
			WHERE REPLACE(LOWER(r.uc), '-', '') IN (`+ph+`)`, args...).Rows()
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var pid int64
				if err := rows.Scan(&pid); err == nil && pid > 0 {
					candidates[pid] = struct{}{}
				}
			}
		}
	}

	if len(candidates) != 1 {
		return 0, false
	}
	for pid := range candidates {
		return pid, true
	}
	return 0, false
}
