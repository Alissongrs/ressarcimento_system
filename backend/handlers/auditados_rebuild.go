package handlers

import (
	"database/sql"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// ListInconclusivos devolve os ids da FDE que estão na aba "Inconclusivos" da Auditoria de
// Faturas: o motor F01-F05 APONTOU, mas ainda NÃO estão auditadas (auditado<>1) e não foram
// rejeitadas / já viraram processo (FATURA_REANALISES). Mesma definição do triagem=1 do
// analise_desvio_handler. Serve p/ escopar o --revalidar --auto-audit só nessa fila.
func ListInconclusivos(sqlDB *sql.DB) ([]int64, error) {
	if sqlDB == nil {
		return nil, fmt.Errorf("sqlDB nil")
	}
	motorRes, err := motorApontamentosCached(sqlDB, "", true)
	if err != nil {
		return nil, fmt.Errorf("motor: %w", err)
	}
	if len(motorRes) == 0 {
		return nil, nil
	}
	ids := make([]string, 0, len(motorRes))
	for id := range motorRes {
		ids = append(ids, strconv.FormatInt(id, 10))
	}
	q := "SELECT f.id FROM FATURA_DADOS_EXTRAIDOS f WHERE f.id IN (" + strings.Join(ids, ",") + ") " +
		"AND COALESCE(f.auditado,0)<>1 " +
		"AND NOT EXISTS (SELECT 1 FROM FATURA_REANALISES r WHERE r.fatura_id=f.id " +
		"AND r.recomendacao IN ('REJEITADO','JA_EM_PROCESSO'))"
	rows, err := sqlDB.Query(q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			out = append(out, id)
		}
	}
	return out, rows.Err()
}

// auditadosFator = fator de retenção histórico (0.58). Guardado na coluna fator_retencao;
// NÃO multiplica o ressarcimento_estimado (retenção só se aplica ao total, não ao estimado por linha).
const auditadosFator = 0.58

// AuditadosRebuildStats resume uma reconstrução da FATURA_APONTAMENTOS_AUDITADOS.
type AuditadosRebuildStats struct {
	Auditados     int     `json:"auditados"`      // linhas FDE com auditado=1
	Inseridos     int     `json:"inseridos"`      // linhas gravadas no snapshot
	TotalEstimado float64 `json:"total_estimado"` // soma de ressarcimento_estimado (bruto)
	DuracaoMs     int64   `json:"duracao_ms"`
}

func round2(x float64) float64 { return math.Round(x*100) / 100 }
func round4(x float64) float64 { return math.Round(x*10000) / 10000 }

func nsIface(v sql.NullString) interface{} {
	if v.Valid {
		return v.String
	}
	return nil
}
func niIface(v sql.NullInt64) interface{} {
	if v.Valid {
		return v.Int64
	}
	return nil
}

const auditadosDDL = `CREATE TABLE IF NOT EXISTS FATURA_APONTAMENTOS_AUDITADOS (
  id BIGINT PRIMARY KEY,
  uid VARCHAR(64), distribuidora VARCHAR(255), cod_empresa INT,
  razao_social VARCHAR(255), codigo_uc VARCHAR(64), numero_instalacao VARCHAR(64),
  mes_referencia DATE, kwh_total DECIMAL(18,3),
  desvio_pct DECIMAL(12,4), fichas VARCHAR(64), f02_validacao VARCHAR(32),
  classificacao_historico VARCHAR(32),
  base_ressarcimento DECIMAL(18,2), base_origem VARCHAR(16),
  ressarcimento_bruto DECIMAL(18,2), fator_retencao DECIMAL(5,4),
  ressarcimento_estimado DECIMAL(18,2), atualizado_em DATETIME,
  observacao TEXT NULL,
  KEY(distribuidora), KEY(cod_empresa)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`

// RebuildAuditados reconstrói a FATURA_APONTAMENTOS_AUDITADOS (snapshot de ressarcimento que a
// página "Auditoria de Faturas" lê) a partir dos FDE com auditado=1 + o motor F01-F05.
//
// Substitui o _build_tabela_auditados.py, corrigindo os problemas dele (P1-4):
//   - chama o motor DIRETO em Go (motorApontamentosCached), UMA vez para todos — sem HTTP,
//     sem JWT forjado (que quebra com GO_ENV=production) e sem N+1 (1 chamada por id);
//   - reconstrói em tabela STAGING + RENAME atômico — sem DELETE que deixa a tabela vazia
//     no meio do rebuild;
//   - observações (coluna observacao) são CARREGADAS ADIANTE do snapshot atual — sobrevivem
//     ao rebuild sem dict hardcoded no código.
//
// Fórmula do dinheiro (idêntica ao script original): base = valor_energia_ativa (se >0) senão
// rs_kwh_total; d = desvio_pct_max/100; bruto = base × d/(1+d); estimado = round(bruto,2).
func RebuildAuditados(sqlDB *sql.DB) (AuditadosRebuildStats, error) {
	return rebuildAuditados(sqlDB, false)
}

// RebuildAuditadosDry roda tudo (motor + staging) mas NÃO faz o swap: compara a staging
// com a tabela viva e descarta a staging. Serve p/ testar sem tocar em produção.
func RebuildAuditadosDry(sqlDB *sql.DB) (AuditadosRebuildStats, error) {
	return rebuildAuditados(sqlDB, true)
}

func rebuildAuditados(sqlDB *sql.DB, dryRun bool) (AuditadosRebuildStats, error) {
	var st AuditadosRebuildStats
	t0 := time.Now()
	if sqlDB == nil {
		return st, fmt.Errorf("sqlDB nil")
	}

	// 1) motor F01-F05 uma vez, todas as empresas, gate gold (aprovado/revisão).
	motorRes, err := motorApontamentosCached(sqlDB, "", true)
	if err != nil {
		return st, fmt.Errorf("motor: %w", err)
	}

	// 2) garante a tabela final (1ª execução).
	if _, err := sqlDB.Exec(auditadosDDL); err != nil {
		return st, fmt.Errorf("ddl: %w", err)
	}

	// 3) carrega observações atuais (carry-forward — sobrevivem ao rebuild).
	obs := map[int64]string{}
	if rs, err := sqlDB.Query("SELECT id, observacao FROM FATURA_APONTAMENTOS_AUDITADOS WHERE observacao IS NOT NULL AND observacao <> ''"); err == nil {
		for rs.Next() {
			var id int64
			var o sql.NullString
			if rs.Scan(&id, &o) == nil && o.Valid {
				obs[id] = o.String
			}
		}
		rs.Close()
	}

	// 4) staging fresca (mesma estrutura da tabela final).
	if _, err := sqlDB.Exec("DROP TABLE IF EXISTS _stg_auditados"); err != nil {
		return st, fmt.Errorf("drop staging: %w", err)
	}
	if _, err := sqlDB.Exec("CREATE TABLE _stg_auditados LIKE FATURA_APONTAMENTOS_AUDITADOS"); err != nil {
		return st, fmt.Errorf("create staging: %w", err)
	}

	// 5) carrega os FDE auditado=1 em memória (evita query concorrente durante o insert).
	type fdeRow struct {
		id                             int64
		uid, dist, razao, uc, inst     sql.NullString
		codEmp                         sql.NullInt64
		mes                            sql.NullString
		kwh, vea, rs                   float64
	}
	var lista []fdeRow
	// Fix (01/08): exclui auditado=1 que foi REJEITADO/JA_EM_PROCESSO — antes a montagem
	// principal só filtrava auditado=1, então um apontamento descartado voltava a cada rebuild
	// ("descarta e volta pra lista"). A triagem de candidatos já filtrava; a montagem não.
	rows, err := sqlDB.Query(`SELECT id, uid, distribuidora, cod_empresa, razao_social, codigo_uc,
	       numero_instalacao, DATE_FORMAT(mes_referencia,'%Y-%m-%d'), COALESCE(kwh_total,0),
	       COALESCE(valor_energia_ativa,0), COALESCE(rs_kwh_total,0)
	  FROM FATURA_DADOS_EXTRAIDOS WHERE auditado=1
	    -- REZEK (emp 14) removido a pedido — nao trabalhamos mais com esse cliente. (VTAL reincluida.)
	    AND COALESCE(cod_empresa,0) <> 14
	    -- Exclui documentos que NÃO são fatura de energia: "Boleto"/demonstrativo de
	    -- rateio de condomínio (dist='Boleto', inst='BOLETO') foram capturados por engano;
	    -- não têm consumo medido em kWh (o kwh_total é espúrio). Ver id443506 (Pão de Açúcar).
	    AND COALESCE(distribuidora,'') <> 'Boleto'
	    AND COALESCE(numero_instalacao,'') <> 'BOLETO'
	    AND NOT EXISTS (SELECT 1 FROM FATURA_REANALISES r
	                    WHERE r.fatura_id = FATURA_DADOS_EXTRAIDOS.id
	                      AND r.recomendacao IN ('REJEITADO','JA_EM_PROCESSO'))
	  ORDER BY id`)
	if err != nil {
		return st, fmt.Errorf("select fde: %w", err)
	}
	for rows.Next() {
		var r fdeRow
		if err := rows.Scan(&r.id, &r.uid, &r.dist, &r.codEmp, &r.razao, &r.uc, &r.inst,
			&r.mes, &r.kwh, &r.vea, &r.rs); err != nil {
			rows.Close()
			return st, fmt.Errorf("scan fde: %w", err)
		}
		lista = append(lista, r)
	}
	rows.Close()
	st.Auditados = len(lista)

	// 6) monta e insere na staging.
	ins, err := sqlDB.Prepare(`INSERT INTO _stg_auditados
	  (id,uid,distribuidora,cod_empresa,razao_social,codigo_uc,numero_instalacao,mes_referencia,kwh_total,
	   desvio_pct,fichas,f02_validacao,classificacao_historico,base_ressarcimento,base_origem,
	   ressarcimento_bruto,fator_retencao,ressarcimento_estimado,atualizado_em,observacao)
	  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),?)`)
	if err != nil {
		return st, fmt.Errorf("prepare: %w", err)
	}
	defer ins.Close()

	for _, r := range lista {
		res := motorRes[r.id] // zero-value se a fatura não foi apontada pelo motor
		// POLÍTICA (30/07): a página "Auditoria de Faturas" só lista o que a REGRA (motor
		// F01-F05) APONTOU. auditado=1 sem apontamento (extração boa, mas sem desvio) NÃO
		// entra no snapshot — fica só como flag de extração confiável na FDE. Evita poluir
		// a página com faturas R$0 vindas do auto-audit em massa.
		if res.DesvioPctMax <= 0 && len(res.FichasAplicadas) == 0 {
			continue
		}
		base, origem := r.rs, "-"
		if r.vea > 0 {
			base, origem = r.vea, "vea"
		} else if r.rs > 0 {
			origem = "rs_kwh_total"
		}
		desv := res.DesvioPctMax
		d := desv / 100.0
		bruto := 0.0
		if base > 0 && d > 0 {
			bruto = base * (d / (1 + d))
		}
		est := round2(bruto)
		// POLÍTICA (30/07): obrigatório ter valor a ressarcir (est > 0). Apontado SEM base de
		// cálculo (sem valor_energia_ativa/rs_kwh_total → R$0) NÃO entra na página. Espelha o
		// filtro do front (aba Auditados: ressarcimento_estimado > 0).
		if est <= 0 {
			continue
		}
		st.TotalEstimado += est

		fichas := strings.Join(res.FichasAplicadas, ",")
		if len(fichas) > 64 {
			fichas = fichas[:64]
		}
		var mesArg interface{}
		if r.mes.Valid && r.mes.String != "" {
			mesArg = r.mes.String
		}
		var obsArg interface{}
		if o, ok := obs[r.id]; ok {
			obsArg = o
		}
		if _, err := ins.Exec(r.id, nsIface(r.uid), nsIface(r.dist), niIface(r.codEmp),
			nsIface(r.razao), nsIface(r.uc), nsIface(r.inst), mesArg, r.kwh,
			round4(desv), fichas, res.F02Validacao, res.ClassificacaoHistorico,
			round2(base), origem, round2(bruto), auditadosFator, est, obsArg); err != nil {
			return st, fmt.Errorf("insert id %d: %w", r.id, err)
		}
		st.Inseridos++
	}

	// 7) DRY: compara staging × tabela viva e descarta — sem tocar em produção.
	if dryRun {
		var liveN int
		var liveTot sql.NullFloat64
		_ = sqlDB.QueryRow("SELECT COUNT(*), COALESCE(SUM(ressarcimento_estimado),0) FROM FATURA_APONTAMENTOS_AUDITADOS").Scan(&liveN, &liveTot)
		var stgN int
		var stgTot sql.NullFloat64
		_ = sqlDB.QueryRow("SELECT COUNT(*), COALESCE(SUM(ressarcimento_estimado),0) FROM _stg_auditados").Scan(&stgN, &stgTot)
		fmt.Printf("[DRY] staging: %d linhas, R$ %.2f  |  tabela viva: %d linhas, R$ %.2f  |  swap NÃO executado\n",
			stgN, stgTot.Float64, liveN, liveTot.Float64)
		_, _ = sqlDB.Exec("DROP TABLE IF EXISTS _stg_auditados")
		st.DuracaoMs = time.Since(t0).Milliseconds()
		return st, nil
	}

	// 8) swap atômico (sem janela vazia).
	_, _ = sqlDB.Exec("DROP TABLE IF EXISTS _old_auditados")
	if _, err := sqlDB.Exec("RENAME TABLE FATURA_APONTAMENTOS_AUDITADOS TO _old_auditados, _stg_auditados TO FATURA_APONTAMENTOS_AUDITADOS"); err != nil {
		return st, fmt.Errorf("swap: %w", err)
	}
	_, _ = sqlDB.Exec("DROP TABLE IF EXISTS _old_auditados")

	st.DuracaoMs = time.Since(t0).Milliseconds()
	return st, nil
}
