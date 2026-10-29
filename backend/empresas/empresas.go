// Package empresas — nome oficial do cliente a partir do cadastro (DM_EMPRESA_PERCENTUAL).
//
// O mesmo cliente aparecia escrito de vários jeitos nos processos ("CLARO SA", "VIA SA",
// "SER EDUCACIONAL S A", "HAPVIDA ASSISTÊNCIA MÉDICA S.A."…) porque o nome vinha digitado da
// requisição. Canonico() casa o nome digitado com o cadastro ignorando acento, pontuação e
// sufixos societários (S.A., SA, S/A, LTDA, EIRELI, ME, EPP) e devolve cod_empresa + nome
// oficial. Sem casamento único, não mexe (ok=false). Padronização feita em 23/10/2026.
package empresas

import (
	"context"
	"database/sql"
	"strings"
	"sync"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

type empresa struct {
	cod    int64
	nome   string
	tokens []string
}

var (
	mu      sync.Mutex
	cache   []empresa
	cacheEm time.Time
	sufixos = map[string]bool{"SA": true, "S": true, "A": true, "LTDA": true, "EIRELI": true, "ME": true, "EPP": true}
)

// Tokens normaliza: maiúsculo, sem acento, só letras/dígitos, sem sufixo societário no fim.
func Tokens(s string) []string {
	var b strings.Builder
	for _, r := range norm.NFD.String(strings.ToUpper(s)) {
		switch {
		case unicode.Is(unicode.Mn, r):
			// acento: descarta
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
		default:
			b.WriteRune(' ')
		}
	}
	t := strings.Fields(b.String())
	for len(t) > 1 && sufixos[t[len(t)-1]] {
		t = t[:len(t)-1]
	}
	return t
}

func carregar(ctx context.Context, db *sql.DB) []empresa {
	mu.Lock()
	defer mu.Unlock()
	if cache != nil && (db == nil || time.Since(cacheEm) < 5*time.Minute) {
		return cache
	}
	if db == nil {
		return nil
	}
	rows, err := db.QueryContext(ctx, `SELECT cod_empresa, nome_empresa FROM DM_EMPRESA_PERCENTUAL
		WHERE ativo = 1 AND cod_empresa IS NOT NULL AND COALESCE(nome_empresa,'') <> ''
		ORDER BY data_vigencia_inicio DESC`)
	if err != nil {
		return cache
	}
	defer rows.Close()
	visto := map[int64]bool{}
	var l []empresa
	for rows.Next() {
		var e empresa
		if rows.Scan(&e.cod, &e.nome) != nil || visto[e.cod] {
			continue
		}
		visto[e.cod] = true
		e.nome = strings.TrimSpace(e.nome)
		e.tokens = Tokens(e.nome)
		l = append(l, e)
	}
	cache, cacheEm = l, time.Now()
	return cache
}

func igual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// extrasOk: palavras que podem sobrar quando o cadastro tem UMA palavra só ("VIA" × "VIA VAREJO",
// "OI" × "OI EM RECUPERACAO JUDICIAL") — evita "VIA ITALIA RESTAURANTE" virar VIA S.A.
var extrasOk = map[string]bool{"VAREJO": true, "EM": true, "RECUPERACAO": true, "JUDICIAL": true,
	"S": true, "A": true, "SA": true, "LTDA": true, "BRASIL": true, "DO": true, "DE": true, "DA": true, "CIA": true, "COMPANHIA": true, "GRUPO": true}

// prefixo: as palavras de p iniciam as de t (ex.: "SER EDUCACIONAL" × "SER EDUCACIONAL S A").
func prefixo(p, t []string) bool {
	if len(p) == 0 || len(p) > len(t) || !igual(p, t[:len(p)]) {
		return false
	}
	if len(p) == 1 {
		for _, x := range t[1:] {
			if !extrasOk[x] {
				return false
			}
		}
	}
	return true
}

// Canonico devolve (cod_empresa, nome oficial, ok) para o nome digitado.
// 1º match exato normalizado; senão, único cadastro cujo nome é prefixo (por palavra) do digitado
// ou vice-versa. Mais de um candidato = não decide.
func Canonico(ctx context.Context, db *sql.DB, nome string) (int64, string, bool) {
	t := Tokens(nome)
	if len(t) == 0 {
		return 0, "", false
	}
	l := carregar(ctx, db)
	for _, e := range l {
		if igual(e.tokens, t) {
			return e.cod, e.nome, true
		}
	}
	var achou *empresa
	for i := range l {
		e := &l[i]
		if prefixo(e.tokens, t) || prefixo(t, e.tokens) {
			if achou != nil && achou.cod != e.cod {
				return 0, "", false
			}
			achou = e
		}
	}
	if achou != nil {
		return achou.cod, achou.nome, true
	}
	return 0, "", false
}
