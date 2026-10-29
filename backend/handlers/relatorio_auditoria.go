package handlers

import (
	"database/sql"
	"fmt"
	"sort"
	"strings"
)

// Relatorio de auditoria F01-F05 (gerencial). READ-ONLY: roda o motor ao vivo
// (motorApontamentos) sobre a FDE e NÃO grava nada. Usado pelo cmd/relatorio_auditoria.
//
// COHORT ESTRITA PONTA A PONTA: a unidade é o APONTAMENTO (fatura apontada pelo motor
// que ingressou no período, por extraido_em). Cada apontamento é classificado em UM
// desfecho (mutuamente exclusivo, soma = apontados), por vínculo de UC:
//   Virou processo  (UC ∈ FT_PROCESSOS)
//   Descartado      (fatura REJEITADO/SEM ERRO em FATURA_REANALISES, ou UC de requisição Rejeitada)
//   Em requisição   (UC ∈ FT_REQUISICOES, ainda não processo nem rejeitada)
//   Não trabalhado  (apontado sem nenhuma ação)
//
// Dois universos: ComVtal (exclui só REZEK/14) e SemVtal (exclui REZEK/14 e VTAL/2025).

type RelAudMes struct {
	Mes                  string         `json:"mes"`
	FaturasAnalisadas    int            `json:"faturas_analisadas"`
	Apontados            int            `json:"apontados"`
	ApontadosPorFicha    map[string]int `json:"apontados_por_ficha"`
	Processo             int            `json:"processo"`       // virou processo
	ProcessoPorFicha     map[string]int `json:"processo_por_ficha"`
	Descartado           int            `json:"descartado"`     // rejeitado
	EmRequisicao         int            `json:"em_requisicao"`  // requisição aberta (sem processo/descarte)
	NaoTrabalhado        int            `json:"nao_trabalhado"` // apontado sem ação
	SomaEstimadoApontado float64        `json:"soma_estimado_apontado"`
	TicketMedioApontado  float64        `json:"ticket_medio_apontado"`
	SomaEstimadoProcesso float64        `json:"soma_estimado_processo"`
	TicketMedioProcesso  float64        `json:"ticket_medio_processo"`
	PctConversao         float64        `json:"pct_conversao"` // processo / apontados
	PctDescarte          float64        `json:"pct_descarte"`  // descartado / apontados
}

type RelUniverso struct {
	Label string      `json:"label"`
	Meses []RelAudMes `json:"meses"`
	Total RelAudMes   `json:"total"`
}

type RelAuditoria struct {
	Inicio             string      `json:"inicio"`
	Fim                string      `json:"fim"`
	ComVtal            RelUniverso `json:"com_vtal"`
	SemVtal            RelUniverso `json:"sem_vtal"`
	MotorApontadosTodo int         `json:"motor_apontados_total_parque"`
}

func fichaFamilia(f string) string {
	f = strings.ToUpper(strings.TrimSpace(f))
	if strings.HasPrefix(f, "F03") {
		return "F03"
	}
	if len(f) >= 3 {
		switch f[:3] {
		case "F01", "F02", "F04", "F05":
			return f[:3]
		}
	}
	return ""
}

func setUCFrom(sqlDB *sql.DB, query string) (map[string]bool, error) {
	set := map[string]bool{}
	rows, err := sqlDB.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	raw := make([]sql.NullString, len(cols))
	ptrs := make([]interface{}, len(cols))
	for i := range raw {
		ptrs[i] = &raw[i]
	}
	for rows.Next() {
		if rows.Scan(ptrs...) != nil {
			continue
		}
		for _, v := range raw {
			if v.Valid {
				if n := normalizarUC(v.String); n != "" {
					set[n] = true
				}
			}
		}
	}
	return set, rows.Err()
}

func ucInSet(set map[string]bool, s string) bool {
	if s == "" {
		return false
	}
	n := normalizarUC(s)
	return n != "" && set[n]
}

type relAcc struct {
	fat, apont             int
	proc, desc, emReq, nao int
	apontF, procF          map[string]int
	apontEstSum, procEstSum float64
	apontEstN, procEstN    int
}

func newRelAcc() *relAcc { return &relAcc{apontF: map[string]int{}, procF: map[string]int{}} }

func (a *relAcc) toMes(m string) RelAudMes {
	tmA, tmP, pc, pd := 0.0, 0.0, 0.0, 0.0
	if a.apontEstN > 0 {
		tmA = round2(a.apontEstSum / float64(a.apontEstN))
	}
	if a.procEstN > 0 {
		tmP = round2(a.procEstSum / float64(a.procEstN))
	}
	if a.apont > 0 {
		pc = round4(float64(a.proc) / float64(a.apont))
		pd = round4(float64(a.desc) / float64(a.apont))
	}
	return RelAudMes{
		Mes: m, FaturasAnalisadas: a.fat, Apontados: a.apont, ApontadosPorFicha: a.apontF,
		Processo: a.proc, ProcessoPorFicha: a.procF, Descartado: a.desc,
		EmRequisicao: a.emReq, NaoTrabalhado: a.nao,
		SomaEstimadoApontado: round2(a.apontEstSum), TicketMedioApontado: tmA,
		SomaEstimadoProcesso: round2(a.procEstSum), TicketMedioProcesso: tmP,
		PctConversao: pc, PctDescarte: pd,
	}
}

func universo(label string, byMes map[string]*relAcc, tot *relAcc) RelUniverso {
	keys := make([]string, 0, len(byMes))
	for k := range byMes {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	meses := make([]RelAudMes, 0, len(keys))
	for _, k := range keys {
		meses = append(meses, byMes[k].toMes(k))
	}
	return RelUniverso{Label: label, Meses: meses, Total: tot.toMes("TOTAL")}
}

// RelatorioAuditoria computa a cohort para faturas ingressadas em [iniISO, fimISO). Datas 'YYYY-MM-DD'.
func RelatorioAuditoria(sqlDB *sql.DB, iniISO, fimISO string) (*RelAuditoria, error) {
	if sqlDB == nil {
		return nil, fmt.Errorf("sqlDB nil")
	}
	raw, err := motorApontamentos(sqlDB, "", true)
	if err != nil {
		return nil, fmt.Errorf("motor: %w", err)
	}

	processoSet, err := setUCFrom(sqlDB, "SELECT uc, uc_atual FROM FT_PROCESSOS WHERE uc IS NOT NULL OR uc_atual IS NOT NULL")
	if err != nil {
		return nil, fmt.Errorf("processos: %w", err)
	}
	reqSet, err := setUCFrom(sqlDB, "SELECT uc FROM FT_REQUISICOES WHERE uc IS NOT NULL")
	if err != nil {
		return nil, fmt.Errorf("requisicoes: %w", err)
	}
	reqRejSet, err := setUCFrom(sqlDB, "SELECT uc FROM FT_REQUISICOES WHERE id_status=4 AND uc IS NOT NULL")
	if err != nil {
		return nil, fmt.Errorf("requisicoes rejeitadas: %w", err)
	}
	descSet := map[int64]bool{}
	if rows, err := sqlDB.Query("SELECT fatura_id FROM FATURA_REANALISES WHERE recomendacao IN ('REJEITADO','SEM ERRO','REFUTADO')"); err == nil {
		for rows.Next() {
			var id int64
			if rows.Scan(&id) == nil {
				descSet[id] = true
			}
		}
		rows.Close()
	}

	aByMes, aTot := map[string]*relAcc{}, newRelAcc()
	bByMes, bTot := map[string]*relAcc{}, newRelAcc()
	getA := func(m string) *relAcc {
		if aByMes[m] == nil {
			aByMes[m] = newRelAcc()
		}
		return aByMes[m]
	}
	getB := func(m string) *relAcc {
		if bByMes[m] == nil {
			bByMes[m] = newRelAcc()
		}
		return bByMes[m]
	}

	rows, err := sqlDB.Query(`SELECT id, DATE_FORMAT(extraido_em,'%Y-%m') mes, COALESCE(cod_empresa,0),
	       COALESCE(numero_instalacao,''), COALESCE(codigo_uc,''),
	       COALESCE(valor_energia_ativa,0), COALESCE(rs_kwh_total,0)
	  FROM FATURA_DADOS_EXTRAIDOS
	  WHERE extraido_em >= ? AND extraido_em < ?
	    AND COALESCE(cod_empresa,0) <> 14`, iniISO, fimISO)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var id, codEmp int64
		var mes, numInst, codUC string
		var vea, rs float64
		if rows.Scan(&id, &mes, &codEmp, &numInst, &codUC, &vea, &rs) != nil {
			continue
		}
		accs := []*relAcc{getA(mes), aTot}
		if codEmp != 2025 { // SemVtal também
			accs = append(accs, getB(mes), bTot)
		}
		for _, a := range accs {
			a.fat++
		}

		res, apontado := raw[id]
		if !apontado {
			continue
		}
		fams := map[string]bool{}
		for _, f := range res.FichasAplicadas {
			if fam := fichaFamilia(f); fam != "" {
				fams[fam] = true
			}
		}
		if len(fams) == 0 {
			continue
		}
		base := rs
		if vea > 0 {
			base = vea
		}
		d := res.DesvioPctMax / 100.0
		est := 0.0
		if base > 0 && d > 0 {
			est = round2(base * (d / (1 + d)))
		}

		// Classificação ponta a ponta (prioridade: processo > descartado > requisição > nada).
		inProc := ucInSet(processoSet, numInst) || ucInSet(processoSet, codUC)
		inRej := descSet[id] || ucInSet(reqRejSet, numInst) || ucInSet(reqRejSet, codUC)
		inReq := ucInSet(reqSet, numInst) || ucInSet(reqSet, codUC)

		for _, a := range accs {
			a.apont++
			if est > 0 {
				a.apontEstSum += est
				a.apontEstN++
			}
			for fam := range fams {
				a.apontF[fam]++
			}
			switch {
			case inProc:
				a.proc++
				if est > 0 {
					a.procEstSum += est
					a.procEstN++
				}
				for fam := range fams {
					a.procF[fam]++
				}
			case inRej:
				a.desc++
			case inReq:
				a.emReq++
			default:
				a.nao++
			}
		}
	}

	return &RelAuditoria{
		Inicio: iniISO, Fim: fimISO,
		ComVtal:            universo("Inclui VTAL (exclui apenas REZEK)", aByMes, aTot),
		SemVtal:            universo("Exclui REZEK e VTAL", bByMes, bTot),
		MotorApontadosTodo: len(raw),
	}, nil
}
