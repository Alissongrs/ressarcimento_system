package repositories

// Vínculo AUTOMÁTICO de e-mail → processo, só com PROVA no próprio e-mail (21/10/2026).
// Substitui o "auto-link uc" (qualquer token de 5+ caracteres virava "UC" — protocolo/CNPJ
// que coincidia com UC de outro processo ligava errado) e o "auto-link thread" (assunto/conversa
// genérica de sistema propagava o erro). Ordem das provas — vale a 1ª que der UM processo:
//  1. protocolo citado (ANEEL 010.xxx.xxxxx-xx, ou "protocolo/solicitação/manifestação nº N",
//     ≥8 dígitos) que está no histórico ou no nº de protocolo da requisição de UM processo;
//  2. código do processo (PR-AAAA-NNNNNN) ou "processo nº NNNNN" que existe;
//  3. UC com rótulo (UC / unidade consumidora / instalação / nº do cliente / conta contrato)
//     que pertence a UM processo.
// Ambíguo (2+ processos) ou sem prova = NÃO vincula (fica para o analista).

import (
	"regexp"
	"strconv"
	"strings"

	"gorm.io/gorm"
)

var (
	evAneel  = regexp.MustCompile(`010[.\s]?\d{3}[.\s]?\d{5}-?\d{1,2}|\b010\d{10}\b`)
	evProt   = regexp.MustCompile(`(?i)(?:protocolo|solicita[çc][ãa]o|manifesta[çc][ãa]o|reclama[çc][ãa]o|ouvidoria)[^\d]{0,25}(\d[\d./-]{6,}\d)`)
	evPR     = regexp.MustCompile(`(?i)PR-\d{4}-0*(\d{4,6})`)
	evProc   = regexp.MustCompile(`(?i)processo\s*(?:n[ºo°.]*\s*)?#?\s*0*(\d{4,6})\b`)
	evUC     = regexp.MustCompile(`(?i)(?:\bUC\b|unidade consumidora|instala[çc][ãa]o|c[óo]digo do cliente|n[ºo°]\s*(?:do\s+)?cliente|conta contrato)[^\d]{0,25}(\d[\d.\-/ ]{4,}\d)`)
	evNaoDig = regexp.MustCompile(`\D`)
)

func soDig(s string) string { return evNaoDig.ReplaceAllString(s, "") }

// aneelFmt: 0106413942657 → 010.641.39426-57 (forma em que a equipe registra no histórico).
func aneelFmt(d string) string {
	if len(d) == 13 {
		return d[0:3] + "." + d[3:6] + "." + d[6:11] + "-" + d[11:13]
	}
	return d
}

func idsUnicos(tx *gorm.DB, q string, args ...any) map[int64]bool {
	out := map[int64]bool{}
	rows, err := tx.Raw(q, args...).Rows()
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil && id > 0 {
			out[id] = true
		}
	}
	return out
}

func unico(m map[int64]bool) (int64, bool) {
	if len(m) != 1 {
		return 0, false
	}
	for id := range m {
		return id, true
	}
	return 0, false
}

// FindProcessByEvidencia devolve (processo, motivo, ok). motivo ∈ "protocolo" | "processo" | "uc".
func FindProcessByEvidencia(tx *gorm.DB, texto string) (int64, string, bool) {
	texto = strings.TrimSpace(texto)
	if texto == "" {
		return 0, "", false
	}

	// 1) protocolo
	cand := map[int64]bool{}
	vistos := map[string]bool{}
	prots := evAneel.FindAllString(texto, -1)
	for _, m := range evProt.FindAllStringSubmatch(texto, -1) {
		prots = append(prots, m[1])
	}
	for _, p := range prots {
		d := soDig(p)
		if len(d) < 8 || vistos[d] {
			continue
		}
		vistos[d] = true
		for id := range idsUnicos(tx, `SELECT id_requisicao FROM FT_REQUISICOES
			WHERE REPLACE(REPLACE(REPLACE(COALESCE(numero_protocolo,''),'.',''),'-',''),'/','') = ?`, d) {
			cand[id] = true
		}
		formas := []string{d}
		if f := aneelFmt(d); f != d {
			formas = append(formas, f)
		}
		for _, f := range formas {
			for id := range idsUnicos(tx, `SELECT DISTINCT id_processo FROM FT_HISTORICO_MOVIMENTACOES
				WHERE comentario LIKE CONCAT('%', ?, '%')`, f) {
				cand[id] = true
			}
		}
	}
	if pid, ok := unico(cand); ok {
		return pid, "protocolo", true
	}
	if len(cand) > 1 {
		return 0, "", false // protocolo de mais de um processo: não arrisca
	}

	// 2) nº / código do processo
	cand = map[int64]bool{}
	nums := []string{}
	for _, m := range evPR.FindAllStringSubmatch(texto, -1) {
		nums = append(nums, m[1])
	}
	for _, m := range evProc.FindAllStringSubmatch(texto, -1) {
		nums = append(nums, m[1])
	}
	for _, n := range nums {
		if v, err := strconv.ParseInt(n, 10, 64); err == nil {
			for id := range idsUnicos(tx, `SELECT id_processo FROM FT_PROCESSOS WHERE id_processo = ?`, v) {
				cand[id] = true
			}
		}
	}
	if pid, ok := unico(cand); ok {
		return pid, "processo", true
	}
	if len(cand) > 1 {
		return 0, "", false
	}

	// 3) UC com rótulo
	cand = map[int64]bool{}
	for _, m := range evUC.FindAllStringSubmatch(texto, -1) {
		d := soDig(m[1])
		if len(d) < 6 || len(d) > 15 {
			continue
		}
		semZero := strings.TrimLeft(d, "0")
		for id := range idsUnicos(tx, `
			SELECT p.id_processo FROM FT_PROCESSOS p
			  LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
			 WHERE REGEXP_REPLACE(COALESCE(p.uc,''),'[^0-9]','') IN (?, ?)
			    OR REGEXP_REPLACE(COALESCE(p.uc_atual,''),'[^0-9]','') IN (?, ?)
			    OR REGEXP_REPLACE(COALESCE(r.uc,''),'[^0-9]','') IN (?, ?)`, d, semZero, d, semZero, d, semZero) {
			cand[id] = true
		}
	}
	if pid, ok := unico(cand); ok {
		return pid, "uc", true
	}
	return 0, "", false
}
