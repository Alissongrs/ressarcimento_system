package handlers

import (
	"database/sql"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// ─── Meta de repasse no chat (SURE) ──────────────────────────────────────────
// MESMA regra da barra "Metas de deferimento" (handlers/v2/metas_deferimento.go):
// repasse (simples + dobro) dos processos ENVIADOS AO FINANCEIRO, no mês do envio —
// data do Fluxo de Ressarcimento ou, sem ela, a 1ª entrada na etapa Faturamento —
// comparado com a meta mensal/anual configurada em DM_META_REPASSE.

type metaRepasse struct {
	MetaMensal, MetaAnual  float64
	RepasseMes, RepasseAno float64
	PorMes                 []struct {
		Mes     int
		Repasse float64
	}
	Ano, Mes int
}

func lerMetaRepasse(db *sql.DB) (*metaRepasse, error) {
	m := &metaRepasse{}
	agora := time.Now().In(time.FixedZone("BRT", -3*3600))
	m.Ano, m.Mes = agora.Year(), int(agora.Month())
	_ = db.QueryRow(`SELECT meta_mensal, meta_anual FROM DM_META_REPASSE WHERE id = 1`).Scan(&m.MetaMensal, &m.MetaAnual)
	rows, err := db.Query(`
SELECT MONTH(e.dt) AS mes,
       ROUND(SUM(COALESCE(d.repasse_simples,0) + COALESCE(d.repasse_dobro,0)), 2) AS repasse
  FROM FT_DEFERIMENTOS d
  JOIN (
    SELECT prc.id_processo, COALESCE(fx.dt, et.dt) AS dt
      FROM (SELECT DISTINCT id_processo FROM FT_DEFERIMENTOS) prc
      LEFT JOIN (SELECT id_processo, MIN(data_envio_financeiro) AS dt FROM FT_FLUXO_RESSARCIMENTO
                  WHERE data_envio_financeiro IS NOT NULL GROUP BY id_processo) fx ON fx.id_processo = prc.id_processo
      LEFT JOIN (SELECT id_processo, MIN(data_movimentacao) AS dt FROM FT_HISTORICO_MOVIMENTACOES
                  WHERE id_etapa_nova = 4 GROUP BY id_processo) et ON et.id_processo = prc.id_processo
  ) e ON e.id_processo = d.id_processo
 WHERE e.dt IS NOT NULL AND YEAR(e.dt) = ?
 GROUP BY MONTH(e.dt) ORDER BY mes`, m.Ano)
	if err != nil {
		return m, err
	}
	defer rows.Close()
	for rows.Next() {
		var mes int
		var v float64
		if rows.Scan(&mes, &v) != nil {
			continue
		}
		m.PorMes = append(m.PorMes, struct {
			Mes     int
			Repasse float64
		}{mes, v})
		m.RepasseAno += v
		if mes == m.Mes {
			m.RepasseMes = v
		}
	}
	return m, nil
}

func pct(v, meta float64) float64 {
	if meta <= 0 {
		return 0
	}
	return v / meta * 100
}

// linhaMetaResumo: 1 linha p/ o Resumo Executivo (sempre presente no contexto).
func linhaMetaResumo(m *metaRepasse) string {
	if m == nil {
		return ""
	}
	return fmt.Sprintf("- **Meta de repasse (enviado ao financeiro):** mês atual R$ %s = %.1f%% da meta mensal de R$ %s · ano %d R$ %s = %.1f%% da meta anual de R$ %s\n",
		chatFmtBRL(m.RepasseMes), pct(m.RepasseMes, m.MetaMensal), chatFmtBRL(m.MetaMensal),
		m.Ano, chatFmtBRL(m.RepasseAno), pct(m.RepasseAno, m.MetaAnual), chatFmtBRL(m.MetaAnual))
}

var nomesMes = []string{"", "jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"}

// blocoMetaDetalhe: quando a pergunta é sobre meta — mês a mês, quanto falta e o ritmo.
func blocoMetaDetalhe(m *metaRepasse) string {
	if m == nil {
		return ""
	}
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("## Meta de repasse %d (mesma regra da barra \"Metas de deferimento\")\n", m.Ano))
	sb.WriteString("Regra: soma do REPASSE (simples + dobro) dos processos enviados ao financeiro, no mês do envio.\n")
	faltaMes := m.MetaMensal - m.RepasseMes
	if faltaMes < 0 {
		faltaMes = 0
	}
	faltaAno := m.MetaAnual - m.RepasseAno
	if faltaAno < 0 {
		faltaAno = 0
	}
	sb.WriteString(fmt.Sprintf("- Mês atual (%s/%d): R$ %s de R$ %s → **%.1f%%**; faltam R$ %s\n",
		nomesMes[m.Mes], m.Ano, chatFmtBRL(m.RepasseMes), chatFmtBRL(m.MetaMensal), pct(m.RepasseMes, m.MetaMensal), chatFmtBRL(faltaMes)))
	sb.WriteString(fmt.Sprintf("- Ano %d (acumulado até hoje): R$ %s de R$ %s → **%.1f%%**; faltam R$ %s\n",
		m.Ano, chatFmtBRL(m.RepasseAno), chatFmtBRL(m.MetaAnual), pct(m.RepasseAno, m.MetaAnual), chatFmtBRL(faltaAno)))
	if restantes := 12 - m.Mes + 1; restantes > 0 && faltaAno > 0 {
		sb.WriteString(fmt.Sprintf("- Para bater a meta anual: ~R$ %s por mês nos %d meses que restam (incluindo o atual)\n",
			chatFmtBRL(faltaAno/float64(restantes)), restantes))
	}
	sb.WriteString("\n| Mês | Repasse | % da meta mensal |\n|---|---|---|\n")
	for _, x := range m.PorMes {
		sb.WriteString(fmt.Sprintf("| %s | R$ %s | %.1f%% |\n", nomesMes[x.Mes], chatFmtBRL(x.Repasse), pct(x.Repasse, m.MetaMensal)))
	}
	return sb.String()
}

var reMetaIntent = regexp.MustCompile(`(?i)\b(meta|metas|objetivo|batemos|bater|atingi\w*|percentual|%|quanto falta)\b`)
