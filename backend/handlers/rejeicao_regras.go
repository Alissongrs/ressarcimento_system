package handlers

// Rejeição POR REGRA. O analista rejeita o apontamento que viu — ou seja, as regras que estavam apontando
// naquela hora —, não a fatura para sempre. A rejeição (FATURA_REANALISES, recomendacao='REJEITADO') grava
// essas regras em regras_rejeitadas ("F02,F05"). Rejeição antiga, sem a coluna preenchida, vale para as
// regras que existiam quando foi feita: F01–F05 (o motor da Auditoria).
//
// Quando outra regra é aplicada ao banco: a fatura continua rejeitada para as regras já rejeitadas; se uma
// regra que NÃO foi rejeitada aponta, ela volta à lista marcada "rejeitada por F02 (analista, data) — novo
// apontamento por F28", e o analista decide de novo só sobre o problema novo.

import (
	"database/sql"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// regras que existiam antes da rejeição por regra (rejeição sem regras_rejeitadas vale para estas)
var regrasRejeicaoLegado = []string{"F01", "F02", "F03", "F04", "F05"}

var reCodigoRegra = regexp.MustCompile(`(?i)\bF\d{2}\b`)

// normalizarRegras — "f02, F05;F02" → "F02,F05" (vazio se não houver código)
func normalizarRegras(lst ...string) string {
	set := map[string]bool{}
	for _, s := range lst {
		for _, m := range reCodigoRegra.FindAllString(s, -1) {
			set[strings.ToUpper(m)] = true
		}
	}
	var out []string
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}

// regrasDaRejeicao — regras que o analista está rejeitando: as que a tela mandou ou, sem elas, as do
// apontamento auditado da fatura. NULL quando não dá para saber (vale o legado F01–F05).
func regrasDaRejeicao(sqlDB *sql.DB, faturaID string, recebidas []string) sql.NullString {
	if s := normalizarRegras(recebidas...); s != "" {
		return sql.NullString{String: s, Valid: true}
	}
	var fichas sql.NullString
	if sqlDB != nil && faturaID != "" {
		_ = sqlDB.QueryRow("SELECT fichas FROM FATURA_APONTAMENTOS_AUDITADOS WHERE id = ?", faturaID).Scan(&fichas)
	}
	if s := normalizarRegras(fichas.String); s != "" {
		return sql.NullString{String: s, Valid: true}
	}
	return sql.NullString{}
}

// Rejeicao — o que já foi rejeitado numa fatura (soma de todas as rejeições dela)
type Rejeicao struct {
	Regras  map[string]bool `json:"-"`
	Lista   []string        `json:"regras"`
	Usuario string          `json:"usuario"`
	Em      string          `json:"em"`
}

// CarregarRejeicoes — rejeições por id de fatura (só ids numéricos). Para usar quando uma regra nova roda:
// NovasRegras(apontadas, rej) diz quais regras apontam algo que o analista ainda não viu.
func CarregarRejeicoes(sqlDB *sql.DB, ids []string) map[string]*Rejeicao {
	out := map[string]*Rejeicao{}
	var nums []string
	for _, id := range ids {
		if _, err := strconv.ParseInt(id, 10, 64); err == nil {
			nums = append(nums, id)
		}
	}
	for i := 0; i < len(nums); i += 1000 {
		fim := i + 1000
		if fim > len(nums) {
			fim = len(nums)
		}
		rows, err := sqlDB.Query(`SELECT fatura_id, COALESCE(regras_rejeitadas,''), COALESCE(usuario_nome,''),
			COALESCE(DATE_FORMAT(criado_em,'%d/%m/%Y'),'') FROM FATURA_REANALISES
			WHERE recomendacao = 'REJEITADO' AND fatura_id IN (` + strings.Join(nums[i:fim], ",") + `) ORDER BY criado_em`)
		if err != nil {
			continue
		}
		for rows.Next() {
			var id, regras, usuario, em string
			if rows.Scan(&id, &regras, &usuario, &em) != nil {
				continue
			}
			r := out[id]
			if r == nil {
				r = &Rejeicao{Regras: map[string]bool{}}
				out[id] = r
			}
			lst := strings.Split(normalizarRegras(regras), ",")
			if regras == "" {
				lst = regrasRejeicaoLegado
			}
			for _, c := range lst {
				if c != "" {
					r.Regras[c] = true
				}
			}
			r.Usuario, r.Em = usuario, em
		}
		rows.Close()
	}
	for _, r := range out {
		for c := range r.Regras {
			r.Lista = append(r.Lista, c)
		}
		sort.Strings(r.Lista)
	}
	return out
}

// NovasRegras — das regras que apontaram, as que o analista ainda não rejeitou nesta fatura
func NovasRegras(apontadas []string, rej *Rejeicao) []string {
	var out []string
	for _, c := range apontadas {
		if rej == nil || !rej.Regras[strings.ToUpper(c)] {
			out = append(out, c)
		}
	}
	return out
}
