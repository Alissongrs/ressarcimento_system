package services

import (
	"database/sql"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"
)

// PrazoRegra descreve o prazo aplicável a uma instância (DM_INSTANCIAS).
type PrazoRegra struct {
	Dias  int
	Uteis bool // true = dias úteis, false = dias corridos
}

// PrazoPorInstancia — regra de prazo por id_instancia (DM_INSTANCIAS: 1=Distribuidora,
// 2=Ouvidoria, 3=ANEEL, 4=SMA). Mesma regra vale para os status "Em elaboração" e
// "Aguardando retorno" — só muda a etapa coberta (ver StatusEtapas).
var PrazoPorInstancia = map[int]PrazoRegra{
	1: {Dias: 5, Uteis: true},   // Distribuidora
	2: {Dias: 10, Uteis: true},  // Ouvidoria
	3: {Dias: 30, Uteis: false}, // ANEEL
	4: {Dias: 30, Uteis: false}, // SMA
}

// StatusEtapas — para cada id_status_atual (DM_STATUS_PROCESSO) alvo desta feature,
// quais etapas (DM_ETAPAS) ele cobre.
var StatusEtapas = map[int][]int{
	2: {1, 2},    // Em elaboração: Reclamação, Contestação
	3: {1, 2, 3}, // Aguardando retorno: Reclamação, Contestação, Conciliação
}

// ProcessoPrazo é o resultado calculado de prazo para um processo parado
// num dos status alvo.
type ProcessoPrazo struct {
	IDProcesso     int
	IDStatus       int
	IDInstancia    int
	Instancia      string
	Etapa          string
	SubEtapa       string
	UC             string
	Cliente        string
	Concessionaria string
	DataBase       time.Time
	PrazoDias      int
	PrazoUteis     bool
	DiasDecorridos int
	DiasRestantes  int
	Atrasado       bool
	TemRegra       bool // false quando a instância não tem regra configurada (não classificar como vencido)
}

// CalcularProcessosComPrazo busca processos parados em algum dos status informados
// (2=Em elaboração, 3=Aguardando retorno), calcula dias decorridos desde que entraram
// nesse status (data_base = MAX(FT_HISTORICO_MOVIMENTACOES.data_movimentacao) onde
// id_status_novo = status) e aplica o prazo por instância (dias úteis ou corridos
// conforme DM_INSTANCIAS). "Vencido" = decorreu mais que PrazoDias (mostra a partir
// do dia seguinte ao vencimento).
func CalcularProcessosComPrazo(statusIDs []int) ([]ProcessoPrazo, error) {
	db := getAppDB()
	if db == nil {
		return nil, fmt.Errorf("banco não inicializado")
	}
	if len(statusIDs) == 0 {
		statusIDs = []int{2, 3}
	}

	statusIn := make([]string, len(statusIDs))
	statusArgs := make([]any, len(statusIDs))
	for i, s := range statusIDs {
		statusIn[i] = "?"
		statusArgs[i] = s
	}
	placeholders := strings.Join(statusIn, ",")

	// Filtro de etapa por status: (status=2 AND etapa IN (1,2)) OR (status=3 AND etapa IN (1,2,3)) ...
	var etapaConds []string
	var etapaArgs []any
	for _, s := range statusIDs {
		etapas, ok := StatusEtapas[s]
		if !ok || len(etapas) == 0 {
			continue
		}
		ph := make([]string, len(etapas))
		for i, e := range etapas {
			ph[i] = "?"
			etapaArgs = append(etapaArgs, e)
		}
		etapaConds = append(etapaConds, fmt.Sprintf("(p.id_status_atual = %d AND p.id_etapa_atual IN (%s))", s, strings.Join(ph, ",")))
	}
	etapaWhere := "1=1"
	if len(etapaConds) > 0 {
		etapaWhere = strings.Join(etapaConds, " OR ")
	}

	q := `
WITH hist AS (
    SELECT hm.id_processo, hm.id_status_novo, MAX(hm.data_movimentacao) AS data_movimentacao
      FROM FT_HISTORICO_MOVIMENTACOES hm
     WHERE hm.id_status_novo IN (` + placeholders + `)
     GROUP BY hm.id_processo, hm.id_status_novo
)
SELECT
    p.id_processo,
    p.id_status_atual,
    COALESCE(p.id_instancia_atual, 0)     AS id_instancia,
    COALESCE(i.nome, '')                  AS instancia,
    COALESCE(e.nome, '')                  AS etapa,
    COALESCE(s.nome, '')                  AS sub_etapa,
    COALESCE(p.uc, '')                    AS uc,
    COALESCE(p.cliente, '')               AS cliente,
    COALESCE(p.concessionaria, '')        AS concessionaria,
    h.data_movimentacao                   AS data_base
FROM FT_PROCESSOS p
JOIN hist h                ON h.id_processo = p.id_processo AND h.id_status_novo = p.id_status_atual
LEFT JOIN DM_ETAPAS e       ON e.id_etapa = p.id_etapa_atual
LEFT JOIN DM_INSTANCIAS i   ON i.id_instancia = p.id_instancia_atual
LEFT JOIN DM_STATUS_PROCESSO s ON s.id_status = p.id_status_atual
WHERE p.id_status_atual IN (` + placeholders + `)
  AND (` + etapaWhere + `)
`
	// Ordem dos placeholders no texto da query: IN() do hist, IN() do WHERE principal, depois etapaWhere.
	args := make([]any, 0, len(statusArgs)*2+len(etapaArgs))
	args = append(args, statusArgs...)
	args = append(args, statusArgs...)
	args = append(args, etapaArgs...)

	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	now := time.Now()
	out := make([]ProcessoPrazo, 0, 128)
	for rows.Next() {
		var p ProcessoPrazo
		var dataBase sql.NullTime
		if err := rows.Scan(&p.IDProcesso, &p.IDStatus, &p.IDInstancia, &p.Instancia, &p.Etapa, &p.SubEtapa, &p.UC, &p.Cliente, &p.Concessionaria, &dataBase); err != nil {
			log.Printf("CalcularProcessosComPrazo scan error: %v", err)
			continue
		}
		if !dataBase.Valid {
			continue
		}
		p.DataBase = dataBase.Time

		regra, ok := PrazoPorInstancia[p.IDInstancia]
		p.TemRegra = ok
		if !ok {
			// Sem instância/regra conhecida: não classifica como vencido (evita falso positivo).
			out = append(out, p)
			continue
		}
		p.PrazoDias = regra.Dias
		p.PrazoUteis = regra.Uteis

		if regra.Uteis {
			p.DiasDecorridos = DiasUteisEntre(p.DataBase, now)
		} else {
			p.DiasDecorridos = DiasCorridosEntre(p.DataBase, now)
		}
		p.DiasRestantes = regra.Dias - p.DiasDecorridos
		p.Atrasado = p.DiasDecorridos > regra.Dias // mostra a partir do dia N+1

		out = append(out, p)
	}
	return out, rows.Err()
}

// CriarAlertasDePrazoVencido cria um alerta (FT_ALERTAS) por processo vencido, para
// cada gestor ativo, deduplicado por dia (não repete o mesmo alerta no mesmo dia).
// Retorna quantos alertas novos foram criados.
func CriarAlertasDePrazoVencido(processos []ProcessoPrazo) (int, error) {
	db := getAppDB()
	if db == nil {
		return 0, fmt.Errorf("banco não inicializado")
	}

	var idsGestores []int64
	rows, err := db.Query(`SELECT id_usuario FROM DM_USUARIO WHERE perfil='gestor' AND usuario_ativo=1`)
	if err != nil {
		return 0, err
	}
	for rows.Next() {
		var uid int64
		if err := rows.Scan(&uid); err == nil {
			idsGestores = append(idsGestores, uid)
		}
	}
	rows.Close()

	criados := 0
	for _, p := range processos {
		if !p.Atrasado {
			continue
		}
		statusNome := "Aguardando retorno"
		if p.IDStatus == 2 {
			statusNome = "Em elaboração"
		}
		msg := "Prazo limite expirou para o processo #" + strconv.Itoa(p.IDProcesso) + " (" + statusNome + " / " + strings.TrimSpace(p.Instancia) + ")"
		for _, uid := range idsGestores {
			var cnt int
			_ = db.QueryRow(
				"SELECT COUNT(1) FROM FT_ALERTAS WHERE id_usuario=? AND id_processo=? AND DATE(data_criacao)=CURRENT_DATE AND mensagem LIKE 'Prazo limite expirou%'",
				uid, p.IDProcesso,
			).Scan(&cnt)
			if cnt > 0 {
				continue
			}
			if _, err := db.Exec(
				"INSERT INTO FT_ALERTAS (id_usuario, id_processo, mensagem, lido, acknowledged, data_criacao, data_alerta) VALUES (?, ?, ?, 0, 0, NOW(), CURRENT_DATE)",
				uid, p.IDProcesso, msg,
			); err == nil {
				criados++
			}
		}
	}
	return criados, nil
}
