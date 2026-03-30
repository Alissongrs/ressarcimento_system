package handlers

import (
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

// AcaoProcesso representa um processo que requer ação
type AcaoProcesso struct {
	ID              int64   `json:"id_processo"`
	UC              string  `json:"uc"`
	Cliente         string  `json:"cliente"`
	Concessionaria  string  `json:"concessionaria"`
	Etapa           string  `json:"etapa"`
	SubEtapa        string  `json:"sub_etapa"`
	DiasRestantes   float64 `json:"dias_restantes,omitempty"`
	HorasRestantes  float64 `json:"horas_restantes,omitempty"`
	Atrasado        bool    `json:"atrasado,omitempty"`
	Deadline        string  `json:"deadline,omitempty"`
	DataBase        string  `json:"data_base,omitempty"`
	DiasSemMov      int     `json:"dias_sem_mov,omitempty"`
	DiasAguardando  int     `json:"dias_aguardando,omitempty"`
	UltimaMovimento string  `json:"ultima_movimentacao,omitempty"`
	CountEmails     int     `json:"count_emails,omitempty"`
}

// AcoesEmailsNaoLidos resume emails não lidos por processo
type AcoesEmailsNaoLidos struct {
	Count     int            `json:"count"`
	Processos []AcaoProcesso `json:"processos"`
}

// AcoesTotais resume as contagens por categoria
type AcoesTotais struct {
	Urgente            int `json:"urgente"`
	SemMovimentacao    int `json:"sem_movimentacao"`
	AguardandoResposta int `json:"aguardando_resposta"`
	EmailsNaoLidos     int `json:"emails_nao_lidos"`
}

// AcoesDodia é a resposta completa do endpoint
type AcoesDodia struct {
	Urgente            []AcaoProcesso      `json:"urgente"`
	SemMovimentacao    []AcaoProcesso      `json:"sem_movimentacao"`
	AguardandoResposta []AcaoProcesso      `json:"aguardando_resposta"`
	EmailsNaoLidos     AcoesEmailsNaoLidos `json:"emails_nao_lidos"`
	Totais             AcoesTotais         `json:"totais"`
}

// GetAcoesDodia retorna a fila de ações do dia para o gestor logado.
// GET /api/v1/acoes-do-dia?threshold_sem_mov=7&threshold_aguardando=5
func GetAcoesDodia(c *gin.Context) {
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"erro": "DB não inicializado"})
		return
	}

	// Lê parâmetros com defaults seguros
	thresholdSemMov := 7
	if v := strings.TrimSpace(c.DefaultQuery("threshold_sem_mov", "7")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 365 {
			thresholdSemMov = n
		}
	}
	thresholdAguardando := 5
	if v := strings.TrimSpace(c.DefaultQuery("threshold_aguardando", "5")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 365 {
			thresholdAguardando = n
		}
	}

	userIDAny, _ := c.Get("userID")
	userID, _ := userIDAny.(int64)

	var (
		urgente            []AcaoProcesso
		semMovimentacao    []AcaoProcesso
		aguardandoResposta []AcaoProcesso
		emailsNaoLidos     []AcaoProcesso
		wg                 sync.WaitGroup
	)

	// ─── Categoria 1: Urgente (SLA vencido ou vencendo em 24h) ───────────────
	wg.Add(1)
	go func() {
		defer wg.Done()
		const q = `
WITH alvo AS (
    SELECT 'Distribuidora' AS etapa, 'Aguardando retorno' AS sub_etapa, 7 AS prazo_dias
    UNION ALL SELECT 'Distribuidora', 'Primeira reclamação - Aguardando retorno', 7
    UNION ALL SELECT 'Ouvidoria', 'Aguardando retorno', 15
    UNION ALL SELECT 'Ouvidoria', 'Em contestação - Aguardando retorno', 15
    UNION ALL SELECT 'Ouvidoria', 'Em Conciliação - Aguardando retorno', 15
    UNION ALL SELECT 'ANEEL', 'Aguardando retorno', 15
    UNION ALL SELECT 'ANEEL', 'Em contestação - Aguardando retorno', 15
    UNION ALL SELECT 'ANEEL', 'Em Conciliação - Aguardando retorno', 15
    UNION ALL SELECT 'SMA', 'Aguardando retorno', 15
    UNION ALL SELECT 'SMA', 'Em contestação - Aguardando retorno', 15
    UNION ALL SELECT 'SMA', 'Em Conciliação - Aguardando retorno', 15
),
hist AS (
    SELECT hm.id_requisicao, MAX(hm.data_movimentacao) AS data_movimentacao
    FROM FT_HISTORICO_MOVIMENTACOES hm
    WHERE LOWER(TRIM(COALESCE(hm.sub_etapa, ''))) IN (
        'aguardando retorno',
        'primeira reclamação - aguardando retorno',
        'em contestação - aguardando retorno',
        'em conciliação - aguardando retorno'
    )
    GROUP BY hm.id_requisicao
)
SELECT
    p.id_processo,
    COALESCE(p.uc, '')             AS uc,
    COALESCE(p.cliente, '')        AS cliente,
    COALESCE(p.concessionaria, '') AS concessionaria,
    e.etapa,
    COALESCE(p.sub_etapa, '')      AS sub_etapa,
    a.prazo_dias,
    h.data_movimentacao            AS data_base
FROM FT_PROCESSOS p
JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
JOIN alvo a
  ON LOWER(TRIM(e.etapa))              = LOWER(TRIM(a.etapa))    COLLATE utf8mb4_unicode_ci
 AND LOWER(TRIM(COALESCE(p.sub_etapa,''))) = LOWER(TRIM(a.sub_etapa)) COLLATE utf8mb4_unicode_ci
JOIN hist h ON h.id_requisicao = p.id_processo
WHERE COALESCE(p.suspenso, 0) = 0
  AND LOWER(TRIM(COALESCE(p.sub_etapa, ''))) NOT LIKE 'suspenso%'
  AND TIMESTAMPDIFF(HOUR, NOW(), DATE_ADD(h.data_movimentacao, INTERVAL a.prazo_dias DAY)) <= 24
ORDER BY TIMESTAMPDIFF(SECOND, NOW(), DATE_ADD(h.data_movimentacao, INTERVAL a.prazo_dias DAY)) ASC
LIMIT 100`

		rows, err := queryGorm(db, q)
		if err != nil {
			return
		}
		defer rows.Close()

		now := time.Now()
		for rows.Next() {
			var (
				id                            int64
				uc, cliente, conc, etapa, sub string
				prazoDias                     int
				dataBase                      time.Time
			)
			if err := rows.Scan(&id, &uc, &cliente, &conc, &etapa, &sub, &prazoDias, &dataBase); err != nil {
				continue
			}
			deadline := dataBase.Add(time.Duration(prazoDias) * 24 * time.Hour)
			delta := deadline.Sub(now)
			urgente = append(urgente, AcaoProcesso{
				ID:             id,
				UC:             strings.TrimSpace(uc),
				Cliente:        strings.TrimSpace(cliente),
				Concessionaria: strings.TrimSpace(conc),
				Etapa:          strings.TrimSpace(etapa),
				SubEtapa:       strings.TrimSpace(sub),
				HorasRestantes: delta.Hours(),
				DiasRestantes:  delta.Hours() / 24.0,
				Atrasado:       delta < 0,
				Deadline:       deadline.Format(time.RFC3339),
				DataBase:       dataBase.Format(time.RFC3339),
			})
		}
	}()

	// ─── Categoria 2: Sem movimentação ───────────────────────────────────────
	wg.Add(1)
	go func() {
		defer wg.Done()
		const q = `
SELECT
    p.id_processo,
    COALESCE(p.uc, '')             AS uc,
    COALESCE(p.cliente, '')        AS cliente,
    COALESCE(p.concessionaria, '') AS concessionaria,
    COALESCE(e.etapa, '')          AS etapa,
    COALESCE(p.sub_etapa, '')      AS sub_etapa,
    DATEDIFF(NOW(), ultima_mov.dt) AS dias_sem_mov,
    ultima_mov.dt                  AS ultima_movimentacao
FROM FT_PROCESSOS p
LEFT JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
JOIN (
    SELECT id_requisicao, MAX(data_movimentacao) AS dt
    FROM FT_HISTORICO_MOVIMENTACOES
    GROUP BY id_requisicao
) ultima_mov ON ultima_mov.id_requisicao = p.id_processo
WHERE COALESCE(p.suspenso, 0) = 0
  AND COALESCE(p.id_coluna, 0) NOT IN (5, 6, 99)
  AND LOWER(TRIM(COALESCE(e.etapa, ''))) NOT REGEXP 'indefer|improced|rejeit|descart'
  AND LOWER(TRIM(COALESCE(p.sub_etapa, ''))) NOT REGEXP 'indefer|improced|rejeit|descart'
  AND DATEDIFF(NOW(), ultima_mov.dt) >= ?
ORDER BY dias_sem_mov DESC
LIMIT 50`

		rows, err := queryGorm(db, q, thresholdSemMov)
		if err != nil {
			return
		}
		defer rows.Close()

		for rows.Next() {
			var (
				id                            int64
				uc, cliente, conc, etapa, sub string
				diasSemMov                    int
				ultimaMov                     time.Time
			)
			if err := rows.Scan(&id, &uc, &cliente, &conc, &etapa, &sub, &diasSemMov, &ultimaMov); err != nil {
				continue
			}
			semMovimentacao = append(semMovimentacao, AcaoProcesso{
				ID:              id,
				UC:              strings.TrimSpace(uc),
				Cliente:         strings.TrimSpace(cliente),
				Concessionaria:  strings.TrimSpace(conc),
				Etapa:           strings.TrimSpace(etapa),
				SubEtapa:        strings.TrimSpace(sub),
				DiasSemMov:      diasSemMov,
				UltimaMovimento: ultimaMov.Format(time.RFC3339),
			})
		}
	}()

	// ─── Categoria 3: Aguardando resposta ────────────────────────────────────
	wg.Add(1)
	go func() {
		defer wg.Done()
		const q = `
SELECT
    p.id_processo,
    COALESCE(p.uc, '')             AS uc,
    COALESCE(p.cliente, '')        AS cliente,
    COALESCE(p.concessionaria, '') AS concessionaria,
    COALESCE(e.etapa, '')          AS etapa,
    COALESCE(p.sub_etapa, '')      AS sub_etapa,
    DATEDIFF(NOW(), ultima_mov.dt) AS dias_aguardando,
    ultima_mov.dt                  AS ultima_movimentacao
FROM FT_PROCESSOS p
JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
JOIN (
    SELECT id_requisicao, MAX(data_movimentacao) AS dt
    FROM FT_HISTORICO_MOVIMENTACOES
    GROUP BY id_requisicao
) ultima_mov ON ultima_mov.id_requisicao = p.id_processo
WHERE COALESCE(p.suspenso, 0) = 0
  AND LOWER(TRIM(e.etapa)) IN ('distribuidora','aneel','ouvidoria','sma')
  AND LOWER(TRIM(COALESCE(p.sub_etapa,''))) LIKE '%aguardando%'
  AND DATEDIFF(NOW(), ultima_mov.dt) >= ?
ORDER BY dias_aguardando DESC
LIMIT 50`

		rows, err := queryGorm(db, q, thresholdAguardando)
		if err != nil {
			return
		}
		defer rows.Close()

		for rows.Next() {
			var (
				id                            int64
				uc, cliente, conc, etapa, sub string
				diasAg                        int
				ultimaMov                     time.Time
			)
			if err := rows.Scan(&id, &uc, &cliente, &conc, &etapa, &sub, &diasAg, &ultimaMov); err != nil {
				continue
			}
			aguardandoResposta = append(aguardandoResposta, AcaoProcesso{
				ID:              id,
				UC:              strings.TrimSpace(uc),
				Cliente:         strings.TrimSpace(cliente),
				Concessionaria:  strings.TrimSpace(conc),
				Etapa:           strings.TrimSpace(etapa),
				SubEtapa:        strings.TrimSpace(sub),
				DiasAguardando:  diasAg,
				UltimaMovimento: ultimaMov.Format(time.RFC3339),
			})
		}
	}()

	// ─── Categoria 4: Emails não lidos (apenas se userID disponível) ─────────
	wg.Add(1)
	go func() {
		defer wg.Done()
		if userID == 0 {
			return
		}
		const q = `
SELECT
    pm.processo_id                 AS id_processo,
    COALESCE(p.uc, '')             AS uc,
    COALESCE(p.cliente, '')        AS cliente,
    COUNT(DISTINCT pm.mail_message_id) AS count_emails
FROM process_mail_links pm
JOIN FT_PROCESSOS p ON p.id_processo = pm.processo_id
LEFT JOIN mail_messages mm ON mm.id = pm.mail_message_id
LEFT JOIN mail_message_reads mr
       ON mr.graph_message_id = mm.graph_message_id
      AND mr.user_id = ?
WHERE mr.id IS NULL
GROUP BY pm.processo_id, p.uc, p.cliente
ORDER BY count_emails DESC
LIMIT 20`

		rows, err := queryGorm(db, q, userID)
		if err != nil {
			return
		}
		defer rows.Close()

		for rows.Next() {
			var (
				id          int64
				uc, cliente string
				countEmails int
			)
			if err := rows.Scan(&id, &uc, &cliente, &countEmails); err != nil {
				continue
			}
			emailsNaoLidos = append(emailsNaoLidos, AcaoProcesso{
				ID:          id,
				UC:          strings.TrimSpace(uc),
				Cliente:     strings.TrimSpace(cliente),
				CountEmails: countEmails,
			})
		}
	}()

	wg.Wait()

	// Garante slices não-nulos na resposta JSON
	if urgente == nil {
		urgente = []AcaoProcesso{}
	}
	if semMovimentacao == nil {
		semMovimentacao = []AcaoProcesso{}
	}
	if aguardandoResposta == nil {
		aguardandoResposta = []AcaoProcesso{}
	}
	if emailsNaoLidos == nil {
		emailsNaoLidos = []AcaoProcesso{}
	}

	totalEmails := 0
	for _, e := range emailsNaoLidos {
		totalEmails += e.CountEmails
	}

	c.JSON(http.StatusOK, AcoesDodia{
		Urgente:            urgente,
		SemMovimentacao:    semMovimentacao,
		AguardandoResposta: aguardandoResposta,
		EmailsNaoLidos: AcoesEmailsNaoLidos{
			Count:     totalEmails,
			Processos: emailsNaoLidos,
		},
		Totais: AcoesTotais{
			Urgente:            len(urgente),
			SemMovimentacao:    len(semMovimentacao),
			AguardandoResposta: len(aguardandoResposta),
			EmailsNaoLidos:     totalEmails,
		},
	})
}
