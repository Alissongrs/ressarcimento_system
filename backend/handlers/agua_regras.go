package handlers

// Motor de regras de ÁGUA no backend (substitui worker/jobs/agua_motor.py e agua_sem_medicao.py, 03/11/2026).
// A tarefa agua_sync só sincroniza as faturas; depois o worker chama POST /api/v1/agua/regras/aplicar
// (X-Cron-Token) e as regras rodam AQUI, gravando no mesmo snapshot FATURA_APONTAMENTOS_AGUA_AUDITADOS
// que a aba 💧 Água, a conferência, a rejeição e o dossiê já usam (ids e conferências continuam valendo).
//
//   FA02 pico de consumo — consumo POR DIA ≥ 1,8× (80% acima) do consumo por dia das ≤12 faturas anteriores
//        da UC (mín. 4). Só nas faturas que entraram desde `desde` e que ainda não têm apontamento.
//        ressarcimento = valor da fatura × (excedente / consumo).
//   FA05 cobrança sem medição — o MESMO m³ cobrado ≥3 faturas seguidas, ≥1,5× o normal da UC (mediana dos
//        outros meses, mín. 4) e ≥5 m³ acima. Um apontamento por sequência; se a sequência cresce, atualiza.
//
// Apontamento rejeitado não volta: a rejeição guarda a chave (empresa, UC, mês, ficha) desde 03/11/2026.
// Escrita numa transação; a resposta traz o backup (ids inseridos + linhas antes da atualização) e o
// worker grava em backups/. modo=dry só calcula.

import (
	"database/sql"
	"fmt"
	"math"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	aguaPicoJanela   = 12
	aguaPicoBaseMin  = 4
	aguaPicoLimite   = 80.0 // % acima da média (régua do gestor, 27/10/2026)
	aguaSemMedMeses  = 3
	aguaSemMedFator  = 1.5
	aguaSemMedMinDif = 5.0
)

type aguaFatRegra struct {
	ID       int64
	Emp      int64
	CodUC    int64
	UC       string
	Conc     string
	Mes      time.Time
	Consumo  float64
	ValorRS  float64
	Link     string
	DtAnt    sql.NullTime
	DtAtu    sql.NullTime
	CriadoEm sql.NullTime
}

// aguaApont — uma linha de FATURA_APONTAMENTOS_AGUA_AUDITADOS
type aguaApont struct {
	ID          int64   `json:"id,omitempty"`
	Emp         int64   `json:"cod_empresa"`
	CodUC       int64   `json:"cod_uc"`
	UC          string  `json:"uc"`
	Conc        string  `json:"concessionaria"`
	Mes         string  `json:"mes_referencia"`
	Consumo     float64 `json:"consumo_m3"`
	Mediana     float64 `json:"mediana_m3"`
	NMeses      int     `json:"n_meses"`
	DesvioPct   float64 `json:"desvio_pct"`
	ExcedenteM3 float64 `json:"excedente_m3"`
	Ficha       string  `json:"ficha"`
	BaseRS      float64 `json:"base_rs"`
	Ressarc     float64 `json:"ressarcimento_estimado"`
	Link        string  `json:"link_fatura"`
	inicioSeq   time.Time
}

type aguaRegrasResultado struct {
	Modo            string           `json:"modo"`
	Desde           string           `json:"desde"`
	FaturasNovas    int              `json:"faturas_novas"` // faturas com consumo que entraram desde `desde`
	PicoNovos       int              `json:"pico_novos"`
	SemMedNovos     int              `json:"sem_medicao_novos"`
	SemMedAtualiz   int              `json:"sem_medicao_atualizados"`
	Ressarcimento   float64          `json:"ressarcimento_novos"`
	PorEmpresa      map[string]int   `json:"por_empresa"`
	IgnoradosRejeit int              `json:"ignorados_rejeitados"`
	Novos           []aguaApont      `json:"novos"`
	Backup          aguaRegrasBackup `json:"backup"`
}

type aguaRegrasBackup struct {
	Tabela            string           `json:"tabela"`
	IdsInseridos      []int64          `json:"ids_inseridos"`
	AtualizadosAntes  []map[string]any `json:"atualizados_antes"`
	ComoDesfazerNovos string           `json:"como_desfazer"`
}

func aguaDias(ant, atu sql.NullTime) float64 {
	if ant.Valid && atu.Valid {
		d := atu.Time.Sub(ant.Time).Hours() / 24
		d = math.Round(d)
		if d >= 15 && d <= 400 {
			return d
		}
	}
	return 30
}

func aguaR2(v float64) float64 { return math.Round(v*100) / 100 }
func aguaR1(v float64) float64 { return math.Round(v*10) / 10 }

func aguaChave(emp, uc int64, mes time.Time) string {
	return fmt.Sprintf("%d|%d|%s", emp, uc, mes.Format("2006-01-02"))
}

// carregarFaturasAguaRegra — todas as faturas com consumo > 0 (por empresa, UC, mês)
func carregarFaturasAguaRegra(db *sql.DB, empresas []int64) (map[[2]int64][]aguaFatRegra, error) {
	q := `SELECT id, cod_empresa, cod_uc, COALESCE(uc,''), COALESCE(concessionaria,''), mes_referencia, consumo_m3,
	        COALESCE(rs_total_fat,0), COALESCE(link_fatura,''), dt_leitura_anterior, dt_leitura_atual, criado_em
	      FROM FATURA_AGUA_DADOS
	      WHERE COALESCE(consumo_m3,0) > 0 AND mes_referencia IS NOT NULL AND cod_empresa IS NOT NULL AND cod_uc IS NOT NULL`
	args := []any{}
	if len(empresas) > 0 {
		q += " AND cod_empresa IN (" + strings.TrimSuffix(strings.Repeat("?,", len(empresas)), ",") + ")"
		for _, e := range empresas {
			args = append(args, e)
		}
	}
	q += " ORDER BY cod_empresa, cod_uc, mes_referencia, id"
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	por := map[[2]int64][]aguaFatRegra{}
	for rows.Next() {
		var f aguaFatRegra
		if err := rows.Scan(&f.ID, &f.Emp, &f.CodUC, &f.UC, &f.Conc, &f.Mes, &f.Consumo, &f.ValorRS, &f.Link,
			&f.DtAnt, &f.DtAtu, &f.CriadoEm); err != nil {
			return nil, err
		}
		k := [2]int64{f.Emp, f.CodUC}
		por[k] = append(por[k], f)
	}
	return por, rows.Err()
}

// regraAguaPico (FA02) — para as faturas novas da UC; serie = todas as faturas da UC, em ordem de mês
func regraAguaPico(serie []aguaFatRegra, nova aguaFatRegra) *aguaApont {
	ant := []aguaFatRegra{}
	for _, h := range serie {
		if h.Mes.Before(nova.Mes) {
			ant = append(ant, h)
		}
	}
	if len(ant) > aguaPicoJanela {
		ant = ant[len(ant)-aguaPicoJanela:]
	}
	if len(ant) < aguaPicoBaseMin {
		return nil
	}
	soma, dias := 0.0, 0.0
	for _, h := range ant {
		soma += h.Consumo
		dias += aguaDias(h.DtAnt, h.DtAtu)
	}
	baseDia := soma / dias
	if baseDia <= 0 {
		return nil
	}
	esperado := aguaR2(baseDia * aguaDias(nova.DtAnt, nova.DtAtu))
	desvio := aguaR1((nova.Consumo - esperado) / esperado * 100)
	if desvio < aguaPicoLimite {
		return nil
	}
	exced := nova.Consumo - esperado
	ress := 0.0
	if nova.Consumo > 0 {
		ress = aguaR2(nova.ValorRS * (exced / nova.Consumo))
	}
	return &aguaApont{Emp: nova.Emp, CodUC: nova.CodUC, UC: nova.UC, Conc: nova.Conc, Mes: nova.Mes.Format("2006-01-02"),
		Consumo: nova.Consumo, Mediana: esperado, NMeses: len(ant), DesvioPct: desvio, ExcedenteM3: aguaR2(exced),
		Ficha: "FA02", BaseRS: aguaR2(nova.ValorRS), Ressarc: ress, Link: nova.Link}
}

func aguaMediana(v []float64) float64 {
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	n := len(s)
	if n == 0 {
		return 0
	}
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

// regraAguaSemMedicao (FA05) — sequências do mesmo m³ na série da UC
func regraAguaSemMedicao(serie []aguaFatRegra) []aguaApont {
	out := []aguaApont{}
	for i := 0; i < len(serie); {
		j := i
		for j+1 < len(serie) && serie[j+1].Consumo == serie[i].Consumo {
			j++
		}
		n := j - i + 1
		if n >= aguaSemMedMeses {
			v := serie[i].Consumo
			outros := []float64{}
			for _, r := range serie {
				if r.Consumo != v {
					outros = append(outros, r.Consumo)
				}
			}
			if len(outros) >= 4 {
				med := aguaMediana(outros)
				if v >= aguaSemMedFator*med && v-med >= aguaSemMedMinDif {
					seq := serie[i : j+1]
					base, ress := 0.0, 0.0
					for _, r := range seq {
						base += r.ValorRS
						ress += (v - med) / v * r.ValorRS
					}
					desv := 0.0
					if med != 0 {
						desv = aguaR1((v - med) / med * 100)
					}
					u := seq[len(seq)-1]
					out = append(out, aguaApont{Emp: u.Emp, CodUC: u.CodUC, UC: u.UC, Conc: u.Conc,
						Mes: u.Mes.Format("2006-01-02"), Consumo: v, Mediana: aguaR2(med), NMeses: n, DesvioPct: desv,
						ExcedenteM3: aguaR2((v - med) * float64(n)), Ficha: "FA05", BaseRS: aguaR2(base), Ressarc: aguaR2(ress),
						Link: u.Link, inicioSeq: seq[0].Mes})
				}
			}
		}
		i = j + 1
	}
	return out
}

type aguaApontExistente struct {
	ID    int64
	Mes   time.Time
	N     int
	Ficha string
}

// avaliarRegrasAgua — calcula (sem gravar) os apontamentos novos e as atualizações de FA05
func avaliarRegrasAgua(db *sql.DB, desde time.Time, empresas []int64) (*aguaRegrasResultado, []aguaApont, [][2]any, error) {
	por, err := carregarFaturasAguaRegra(db, empresas)
	if err != nil {
		return nil, nil, nil, err
	}
	// apontamentos existentes (qualquer ficha) — inclui os rejeitados que ainda estão no snapshot
	ja := map[string]bool{}
	fa05 := map[[2]int64][]aguaApontExistente{}
	rows, err := db.Query(`SELECT id, cod_empresa, cod_uc, mes_referencia, COALESCE(n_meses,0), COALESCE(ficha,'')
		FROM FATURA_APONTAMENTOS_AGUA_AUDITADOS WHERE mes_referencia IS NOT NULL`)
	if err != nil {
		return nil, nil, nil, err
	}
	for rows.Next() {
		var e aguaApontExistente
		var emp, uc int64
		if rows.Scan(&e.ID, &emp, &uc, &e.Mes, &e.N, &e.Ficha) != nil {
			continue
		}
		ja[aguaChave(emp, uc, e.Mes)] = true
		if e.Ficha == "FA05" {
			fa05[[2]int64{emp, uc}] = append(fa05[[2]int64{emp, uc}], e)
		}
	}
	rows.Close()
	// rejeitados com chave (desde 03/11/2026): não voltam nunca
	rejeit := map[string]bool{}
	if rr, e := db.Query(`SELECT cod_empresa, cod_uc, mes_referencia, COALESCE(ficha,'') FROM FATURA_AGUA_REJEICOES
		WHERE cod_empresa IS NOT NULL AND cod_uc IS NOT NULL AND mes_referencia IS NOT NULL`); e == nil {
		for rr.Next() {
			var emp, uc int64
			var mes time.Time
			var ficha string
			if rr.Scan(&emp, &uc, &mes, &ficha) == nil {
				rejeit[ficha+"|"+aguaChave(emp, uc, mes)] = true
			}
		}
		rr.Close()
	}

	desdeStr := desde.Format("2006-01-02")
	res := &aguaRegrasResultado{Desde: desdeStr, PorEmpresa: map[string]int{}}
	novos := []aguaApont{}
	atualizar := [][2]any{} // {id, aguaApont}
	chaves := make([][2]int64, 0, len(por))
	for k := range por {
		chaves = append(chaves, k)
	}
	sort.Slice(chaves, func(a, b int) bool {
		if chaves[a][0] != chaves[b][0] {
			return chaves[a][0] < chaves[b][0]
		}
		return chaves[a][1] < chaves[b][1]
	})
	for _, k := range chaves {
		serie := por[k]
		// FA02 — só nas faturas que entraram desde `desde`
		for _, f := range serie {
			// compara a DATA gravada (relógio de quem inseriu, o agua_sync da VPS) — sem conversão de fuso
			if !f.CriadoEm.Valid || f.CriadoEm.Time.Format("2006-01-02") < desdeStr {
				continue
			}
			res.FaturasNovas++
			ch := aguaChave(f.Emp, f.CodUC, f.Mes)
			if ja[ch] {
				continue
			}
			if a := regraAguaPico(serie, f); a != nil {
				if rejeit["FA02|"+ch] {
					res.IgnoradosRejeit++
					continue
				}
				ja[ch] = true
				novos = append(novos, *a)
			}
		}
		// FA05 — a série inteira (a sequência pode ter crescido)
		for _, s := range regraAguaSemMedicao(serie) {
			var achou *aguaApontExistente
			for i := range fa05[k] {
				e := fa05[k][i]
				if !e.Mes.Before(s.inicioSeq) && !e.Mes.After(mustData(s.Mes)) {
					achou = &fa05[k][i]
				}
			}
			if achou == nil {
				if rejeit["FA05|"+aguaChave(s.Emp, s.CodUC, mustData(s.Mes))] {
					res.IgnoradosRejeit++
					continue
				}
				novos = append(novos, s)
			} else if achou.Mes.Format("2006-01-02") != s.Mes || achou.N != s.NMeses {
				atualizar = append(atualizar, [2]any{achou.ID, s})
			}
		}
	}
	for _, a := range novos {
		res.Ressarcimento += a.Ressarc
		res.PorEmpresa[strconv.FormatInt(a.Emp, 10)]++
		if a.Ficha == "FA02" {
			res.PicoNovos++
		} else {
			res.SemMedNovos++
		}
	}
	res.Ressarcimento = aguaR2(res.Ressarcimento)
	res.SemMedAtualiz = len(atualizar)
	sort.SliceStable(novos, func(a, b int) bool { return novos[a].Ressarc > novos[b].Ressarc })
	return res, novos, atualizar, nil
}

func mustData(s string) time.Time {
	t, _ := time.Parse("2006-01-02", s)
	return t
}

// gravarRegrasAgua — insere os novos e atualiza as sequências FA05, numa transação, devolvendo o backup
func gravarRegrasAgua(db *sql.DB, novos []aguaApont, atualizar [][2]any) (aguaRegrasBackup, error) {
	bk := aguaRegrasBackup{Tabela: "FATURA_APONTAMENTOS_AGUA_AUDITADOS", IdsInseridos: []int64{}, AtualizadosAntes: []map[string]any{}}
	if len(novos) == 0 && len(atualizar) == 0 {
		return bk, nil
	}
	tx, err := db.Begin()
	if err != nil {
		return bk, err
	}
	defer tx.Rollback() //nolint:errcheck
	// linhas antes da atualização (backup)
	for _, u := range atualizar {
		id := u[0].(int64)
		var emp, uc, n sql.NullInt64
		var mes, ficha, link sql.NullString
		var cons, med, desv, exc, base, ress sql.NullFloat64
		if err := tx.QueryRow(`SELECT cod_empresa, cod_uc, DATE_FORMAT(mes_referencia,'%Y-%m-%d'), consumo_m3, mediana_m3, n_meses,
			desvio_pct, excedente_m3, ficha, base_rs, ressarcimento_estimado, link_fatura
			FROM FATURA_APONTAMENTOS_AGUA_AUDITADOS WHERE id=? FOR UPDATE`, id).Scan(&emp, &uc, &mes, &cons, &med, &n,
			&desv, &exc, &ficha, &base, &ress, &link); err != nil {
			return bk, err
		}
		bk.AtualizadosAntes = append(bk.AtualizadosAntes, map[string]any{"id": id, "cod_empresa": emp.Int64, "cod_uc": uc.Int64,
			"mes_referencia": mes.String, "consumo_m3": cons.Float64, "mediana_m3": med.Float64, "n_meses": n.Int64,
			"desvio_pct": desv.Float64, "excedente_m3": exc.Float64, "ficha": ficha.String, "base_rs": base.Float64,
			"ressarcimento_estimado": ress.Float64, "link_fatura": link.String})
	}
	var maxID int64
	if err := tx.QueryRow("SELECT COALESCE(MAX(id),0) FROM FATURA_APONTAMENTOS_AGUA_AUDITADOS FOR UPDATE").Scan(&maxID); err != nil {
		return bk, err
	}
	agora := time.Now().Format("2006-01-02 15:04:05")
	for i := range novos {
		maxID++
		a := novos[i]
		if _, err := tx.Exec(`INSERT INTO FATURA_APONTAMENTOS_AGUA_AUDITADOS (id,cod_empresa,cod_uc,uc,concessionaria,mes_referencia,
			consumo_m3,mediana_m3,n_meses,desvio_pct,excedente_m3,ficha,base_rs,ressarcimento_estimado,link_fatura,criado_em)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, maxID, a.Emp, a.CodUC, a.UC, a.Conc, a.Mes, a.Consumo, a.Mediana,
			a.NMeses, a.DesvioPct, a.ExcedenteM3, a.Ficha, a.BaseRS, a.Ressarc, a.Link, agora); err != nil {
			return bk, err
		}
		novos[i].ID = maxID
		bk.IdsInseridos = append(bk.IdsInseridos, maxID)
	}
	for _, u := range atualizar {
		s := u[1].(aguaApont)
		if _, err := tx.Exec(`UPDATE FATURA_APONTAMENTOS_AGUA_AUDITADOS SET mes_referencia=?, consumo_m3=?, mediana_m3=?, n_meses=?,
			desvio_pct=?, excedente_m3=?, base_rs=?, ressarcimento_estimado=?, link_fatura=? WHERE id=?`,
			s.Mes, s.Consumo, s.Mediana, s.NMeses, s.DesvioPct, s.ExcedenteM3, s.BaseRS, s.Ressarc, s.Link, u[0].(int64)); err != nil {
			return bk, err
		}
	}
	if err := tx.Commit(); err != nil {
		return bk, err
	}
	if len(bk.IdsInseridos) > 0 {
		ids := make([]string, len(bk.IdsInseridos))
		for i, v := range bk.IdsInseridos {
			ids[i] = strconv.FormatInt(v, 10)
		}
		bk.ComoDesfazerNovos = "DELETE FROM FATURA_APONTAMENTOS_AGUA_AUDITADOS WHERE id IN (" + strings.Join(ids, ",") +
			"); e restaurar 'atualizados_antes' com UPDATE"
	}
	return bk, nil
}

var reCodEmpresas = regexp.MustCompile(`\d{1,6}`)

// POST /api/v1/agua/regras/aplicar  (X-Cron-Token)  {"desde":"AAAA-MM-DD","empresas":"4,14","modo":"apply"|"dry"}
func AplicarRegrasAguaCron(c *gin.Context) {
	tok := strings.TrimSpace(os.Getenv("CRON_TOKEN"))
	if tok == "" || c.GetHeader("X-Cron-Token") != tok {
		c.JSON(http.StatusForbidden, gin.H{"error": "token de cron inválido"})
		return
	}
	var body struct {
		Desde    string `json:"desde"`
		Empresas string `json:"empresas"`
		Modo     string `json:"modo"`
	}
	_ = c.ShouldBindJSON(&body)
	desde := time.Now()
	if s := strings.TrimSpace(body.Desde); s != "" {
		t, err := time.Parse("2006-01-02", s)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "desde: use AAAA-MM-DD"})
			return
		}
		desde = t
	}
	empresas := []int64{}
	for _, m := range reCodEmpresas.FindAllString(body.Empresas, -1) {
		v, _ := strconv.ParseInt(m, 10, 64)
		empresas = append(empresas, v)
	}
	db := solicDB(c)
	if db == nil {
		return
	}
	res, novos, atualizar, err := avaliarRegrasAgua(db, desde, empresas)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	res.Modo = "dry"
	if body.Modo == "apply" {
		res.Modo = "apply"
		bk, err := gravarRegrasAgua(db, novos, atualizar)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "nada gravado (transação desfeita): " + err.Error()})
			return
		}
		res.Backup = bk
	}
	if len(novos) > 50 {
		res.Novos = novos[:50]
	} else {
		res.Novos = novos
	}
	c.JSON(http.StatusOK, res)
}
