package handlers

// Parâmetros da ANEEL (dados abertos, sem login) para as regras que dependem de valor homologado:
//   tarifas de aplicação (TE/TUSD por distribuidora, subgrupo, modalidade, posto e vigência) — F28, F58
//   bandeiras (cor acionada e adicional de cada mês) — F41, F42
// Fonte: https://dadosabertos.aneel.gov.br (CKAN, datastore_search). Valores em R$/MWh (energia) e R$/kW (demanda).
//
// Importação: POST /api/v1/parametros/aneel/importar-cron (cron da VPS, header X-Cron-Token) ou
// POST /api/v1/parametros/aneel/importar (gestor). Busca as distribuidoras que aparecem nas faturas das usinas,
// grava em PARAM_ANEEL_TARIFAS / PARAM_ANEEL_BANDEIRAS (upsert pela chave natural — reimportar não duplica)
// e registra cada execução em PARAM_ANEEL_IMPORTACOES. As tabelas nascem na 1ª importação.

import (
	"crypto/sha1"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	aneelAPI            = "https://dadosabertos.aneel.gov.br/api/3/action/datastore_search"
	aneelRecTarifas     = "fcf2906c-7c32-4b9b-a637-054e7a5234f4" // Tarifas de aplicação das distribuidoras
	aneelRecBandeiras   = "0591b8f6-fe54-437b-b72b-1aa2efd46e42" // Bandeira tarifária — acionamento
	aneelBaseAplicacao  = "Tarifa de Aplicação"
	aneelPagina         = 32000
	aneelVigenciaMinima = "2022-01-01" // faturas das usinas são de 2024 em diante; guarda folga
)

// tarifa homologada (uma linha da ANEEL)
type tarifaANEEL struct {
	CNPJ, Agente, REH, Inicio, Fim, Subgrupo, Modalidade, Classe, Subclasse, Detalhe, Posto, Unidade, Acessante string
	TUSD, TE                                                                                                    float64
	Gerado                                                                                                      string
}

// bandeira acionada num mês
type bandeiraANEEL struct {
	Competencia, Cor string
	Valor            float64 // R$/MWh
}

// base em memória usada pelas regras
type aneelBase struct {
	tarifas   []tarifaANEEL
	bandeiras map[string]bandeiraANEEL // "AAAA-MM" → bandeira
	porCor    map[string]float64       // "AAAA|COR" → adicional R$/MWh do patamar naquele ano
}

func numBR(s string) float64 {
	s = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(s, ".", ""), ",", "."))
	v, _ := strconv.ParseFloat(s, 64)
	return v
}

func aneelGet(recurso string, filtros map[string]string, offset int) ([]map[string]any, int, error) {
	fj, _ := json.Marshal(filtros)
	q := url.Values{"resource_id": {recurso}, "filters": {string(fj)}, "limit": {strconv.Itoa(aneelPagina)},
		"offset": {strconv.Itoa(offset)}}
	cli := &http.Client{Timeout: 5 * time.Minute}
	resp, err := cli.Get(aneelAPI + "?" + q.Encode())
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	var d struct {
		Success bool `json:"success"`
		Result  struct {
			Records []map[string]any `json:"records"`
			Total   int              `json:"total"`
		} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&d); err != nil {
		return nil, 0, err
	}
	if !d.Success {
		return nil, 0, fmt.Errorf("ANEEL respondeu success=false")
	}
	return d.Result.Records, d.Result.Total, nil
}

func str(m map[string]any, k string) string {
	if v, ok := m[k]; ok && v != nil {
		return strings.TrimSpace(fmt.Sprint(v))
	}
	return ""
}

// baixarTarifasANEEL — tarifas de aplicação das distribuidoras (CNPJ só com dígitos), com vigência recente
func baixarTarifasANEEL(cnpjs []string) ([]tarifaANEEL, error) {
	var out []tarifaANEEL
	for _, cnpj := range cnpjs {
		for off := 0; ; off += aneelPagina {
			recs, total, err := aneelGet(aneelRecTarifas, map[string]string{"NumCNPJDistribuidora": cnpj,
				"DscBaseTarifaria": aneelBaseAplicacao}, off)
			if err != nil {
				return nil, fmt.Errorf("tarifas %s: %w", cnpj, err)
			}
			for _, r := range recs {
				t := tarifaANEEL{CNPJ: str(r, "NumCNPJDistribuidora"), Agente: str(r, "SigAgente"), REH: str(r, "DscREH"),
					Inicio: str(r, "DatInicioVigencia"), Fim: str(r, "DatFimVigencia"), Subgrupo: str(r, "DscSubGrupo"),
					Modalidade: str(r, "DscModalidadeTarifaria"), Classe: str(r, "DscClasse"), Subclasse: str(r, "DscSubClasse"),
					Detalhe: str(r, "DscDetalhe"), Posto: str(r, "NomPostoTarifario"), Unidade: str(r, "DscUnidadeTerciaria"),
					Acessante: str(r, "SigAgenteAcessante"), TUSD: numBR(str(r, "VlrTUSD")), TE: numBR(str(r, "VlrTE")),
					Gerado: str(r, "DatGeracaoConjuntoDados")}
				if t.Fim >= aneelVigenciaMinima {
					out = append(out, t)
				}
			}
			if off+aneelPagina >= total || len(recs) == 0 {
				break
			}
		}
	}
	return out, nil
}

func baixarBandeirasANEEL() ([]bandeiraANEEL, error) {
	recs, _, err := aneelGet(aneelRecBandeiras, map[string]string{}, 0)
	if err != nil {
		return nil, err
	}
	var out []bandeiraANEEL
	for _, r := range recs {
		comp := str(r, "DatCompetencia")
		if len(comp) >= 7 {
			out = append(out, bandeiraANEEL{Competencia: comp[:7], Cor: corBandeira(str(r, "NomBandeiraAcionada")),
				Valor: numBR(str(r, "VlrAdicionalBandeira"))})
		}
	}
	return out, nil
}

var reCor = regexp.MustCompile(`(?i)escassez|vermelha\s*(p|pat\S*|patamar)?\s*([12])|vermelha|amarela|verde`)

// corBandeira — normaliza o nome da cor: VERDE, AMARELA, VERMELHA_1, VERMELHA_2, VERMELHA (sem patamar), ESCASSEZ
func corBandeira(s string) string {
	m := reCor.FindStringSubmatch(s)
	if m == nil {
		return ""
	}
	t := strings.ToUpper(m[0])
	switch {
	case strings.HasPrefix(t, "ESCASSEZ"):
		return "ESCASSEZ"
	case strings.HasPrefix(t, "VERMELHA"):
		switch m[2] {
		case "2":
			return "VERMELHA_2"
		case "1":
			return "VERMELHA_1"
		}
		return "VERMELHA" // patamar não impresso
	case strings.HasPrefix(t, "AMARELA"):
		return "AMARELA"
	}
	return "VERDE"
}

func novaBase(t []tarifaANEEL, b []bandeiraANEEL) *aneelBase {
	base := &aneelBase{tarifas: t, bandeiras: map[string]bandeiraANEEL{}, porCor: map[string]float64{}}
	for _, x := range b {
		base.bandeiras[x.Competencia] = x
		if x.Valor > 0 {
			base.porCor[x.Competencia[:4]+"|"+x.Cor] = x.Valor
		}
	}
	return base
}

// AneelBaseDaAPI — base montada direto da API (sem banco); usada em teste e no cmd motor_usinas -aneel-api
func AneelBaseDaAPI(db *sql.DB) (*aneelBase, error) {
	cnpjs, err := cnpjsDistribuidoras(db)
	if err != nil {
		return nil, err
	}
	t, err := baixarTarifasANEEL(cnpjs)
	if err != nil {
		return nil, err
	}
	b, err := baixarBandeirasANEEL()
	if err != nil {
		return nil, err
	}
	return novaBase(t, b), nil
}

// distribuidoras que aparecem nas faturas das usinas
func cnpjsDistribuidoras(db *sql.DB) ([]string, error) {
	rows, err := db.Query(`SELECT DISTINCT REGEXP_REPLACE(distribuidora_cnpj,'[^0-9]','') FROM FATURA_USINA
		WHERE distribuidora_cnpj IS NOT NULL AND distribuidora_cnpj <> ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var c string
		if rows.Scan(&c) == nil && len(c) == 14 {
			out = append(out, c)
		}
	}
	return out, nil
}

// carregarAneelBanco — base a partir das tabelas importadas (nil, sem erro, se ainda não houve importação)
func carregarAneelBanco(db *sql.DB) (*aneelBase, error) {
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM PARAM_ANEEL_TARIFAS`).Scan(&n); err != nil || n == 0 {
		return nil, nil
	}
	rows, err := db.Query(`SELECT cnpj, agente, reh, DATE_FORMAT(inicio_vigencia,'%Y-%m-%d'), DATE_FORMAT(fim_vigencia,'%Y-%m-%d'),
		subgrupo, modalidade, classe, subclasse, detalhe, posto, unidade, acessante, vlr_tusd, vlr_te FROM PARAM_ANEEL_TARIFAS`)
	if err != nil {
		return nil, err
	}
	var ts []tarifaANEEL
	for rows.Next() {
		var t tarifaANEEL
		if rows.Scan(&t.CNPJ, &t.Agente, &t.REH, &t.Inicio, &t.Fim, &t.Subgrupo, &t.Modalidade, &t.Classe, &t.Subclasse,
			&t.Detalhe, &t.Posto, &t.Unidade, &t.Acessante, &t.TUSD, &t.TE) == nil {
			ts = append(ts, t)
		}
	}
	rows.Close()
	var bs []bandeiraANEEL
	if br, err := db.Query(`SELECT DATE_FORMAT(competencia,'%Y-%m'), cor, valor_mwh FROM PARAM_ANEEL_BANDEIRAS`); err == nil {
		for br.Next() {
			var b bandeiraANEEL
			if br.Scan(&b.Competencia, &b.Cor, &b.Valor) == nil {
				bs = append(bs, b)
			}
		}
		br.Close()
	}
	return novaBase(ts, bs), nil
}

func ensureAneelTables(db *sql.DB) error {
	for _, q := range []string{`CREATE TABLE IF NOT EXISTS PARAM_ANEEL_TARIFAS (
  chave            CHAR(40)      NOT NULL PRIMARY KEY,
  cnpj             VARCHAR(14)   NOT NULL,
  agente           VARCHAR(80)   NULL,
  reh              VARCHAR(255)  NULL,
  inicio_vigencia  DATE          NOT NULL,
  fim_vigencia     DATE          NOT NULL,
  subgrupo         VARCHAR(20)   NOT NULL,
  modalidade       VARCHAR(60)   NOT NULL,
  classe           VARCHAR(80)   NOT NULL,
  subclasse        VARCHAR(120)  NOT NULL,
  detalhe          VARCHAR(80)   NOT NULL,
  posto            VARCHAR(40)   NOT NULL,
  unidade          VARCHAR(20)   NOT NULL,
  acessante        VARCHAR(200)  NOT NULL,
  vlr_tusd         DECIMAL(14,4) NOT NULL,
  vlr_te           DECIMAL(14,4) NOT NULL,
  gerado_aneel     VARCHAR(20)   NULL,
  importado_em     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pat_busca (cnpj, subgrupo, modalidade, inicio_vigencia)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, `CREATE TABLE IF NOT EXISTS PARAM_ANEEL_BANDEIRAS (
  competencia   DATE          NOT NULL PRIMARY KEY,
  cor           VARCHAR(20)   NOT NULL,
  valor_mwh     DECIMAL(10,4) NOT NULL,
  importado_em  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`, `CREATE TABLE IF NOT EXISTS PARAM_ANEEL_IMPORTACOES (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  iniciado_em  DATETIME     NOT NULL,
  terminado_em DATETIME     NULL,
  origem       VARCHAR(20)  NOT NULL,
  usuario      VARCHAR(255) NULL,
  status       VARCHAR(20)  NOT NULL,
  resumo       VARCHAR(500) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`} {
		if _, err := db.Exec(q); err != nil {
			return err
		}
	}
	return nil
}

func chaveTarifa(t tarifaANEEL) string {
	h := sha1.Sum([]byte(strings.Join([]string{t.CNPJ, t.Inicio, t.Fim, t.Subgrupo, t.Modalidade, t.Classe, t.Subclasse,
		t.Detalhe, t.Posto, t.Unidade, t.Acessante}, "|")))
	return hex.EncodeToString(h[:])
}

var aneelImportMu sync.Mutex

// ImportarANEEL — baixa e grava (upsert). Retorna o resumo.
func ImportarANEEL(db *sql.DB, origem, usuario string) (string, error) {
	aneelImportMu.Lock()
	defer aneelImportMu.Unlock()
	if err := ensureAneelTables(db); err != nil {
		return "", err
	}
	ini := time.Now()
	res, _ := db.Exec(`INSERT INTO PARAM_ANEEL_IMPORTACOES (iniciado_em, origem, usuario, status) VALUES (NOW(),?,?,'rodando')`, origem, usuario)
	idImp, _ := res.LastInsertId()
	fim := func(status, resumo string) {
		_, _ = db.Exec(`UPDATE PARAM_ANEEL_IMPORTACOES SET terminado_em = NOW(), status = ?, resumo = ? WHERE id = ?`, status, resumo, idImp)
	}
	cnpjs, err := cnpjsDistribuidoras(db)
	if err != nil {
		fim("erro", err.Error())
		return "", err
	}
	ts, err := baixarTarifasANEEL(cnpjs)
	if err != nil {
		fim("erro", err.Error())
		return "", err
	}
	bs, err := baixarBandeirasANEEL()
	if err != nil {
		fim("erro", err.Error())
		return "", err
	}
	afetadas := 0
	tx, err := db.Begin()
	if err != nil {
		fim("erro", err.Error())
		return "", err
	}
	defer tx.Rollback()
	const lote = 300
	for k := 0; k < len(ts); k += lote {
		f := k + lote
		if f > len(ts) {
			f = len(ts)
		}
		ph := make([]string, 0, f-k)
		args := make([]any, 0, (f-k)*17)
		for _, t := range ts[k:f] {
			ph = append(ph, "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
			args = append(args, chaveTarifa(t), t.CNPJ, t.Agente, t.REH, t.Inicio, t.Fim, t.Subgrupo, t.Modalidade, t.Classe,
				t.Subclasse, t.Detalhe, t.Posto, t.Unidade, t.Acessante, t.TUSD, t.TE, t.Gerado)
		}
		r, err := tx.Exec(`INSERT INTO PARAM_ANEEL_TARIFAS (chave, cnpj, agente, reh, inicio_vigencia, fim_vigencia, subgrupo,
			modalidade, classe, subclasse, detalhe, posto, unidade, acessante, vlr_tusd, vlr_te, gerado_aneel) VALUES `+
			strings.Join(ph, ",")+` ON DUPLICATE KEY UPDATE vlr_tusd = VALUES(vlr_tusd), vlr_te = VALUES(vlr_te),
			reh = VALUES(reh), gerado_aneel = VALUES(gerado_aneel), importado_em = IF(vlr_tusd <> VALUES(vlr_tusd)
			OR vlr_te <> VALUES(vlr_te), NOW(), importado_em)`, args...)
		if err != nil {
			fim("erro", err.Error())
			return "", err
		}
		// MySQL: 1 por linha nova, 2 por linha alterada, 0 sem mudança
		n, _ := r.RowsAffected()
		afetadas += int(n)
	}
	for _, b := range bs {
		if _, err := tx.Exec(`INSERT INTO PARAM_ANEEL_BANDEIRAS (competencia, cor, valor_mwh) VALUES (?,?,?)
			ON DUPLICATE KEY UPDATE cor = VALUES(cor), valor_mwh = VALUES(valor_mwh)`, b.Competencia+"-01", b.Cor, b.Valor); err != nil {
			fim("erro", err.Error())
			return "", err
		}
	}
	if err := tx.Commit(); err != nil {
		fim("erro", err.Error())
		return "", err
	}
	var totT, totB int
	_ = db.QueryRow(`SELECT COUNT(*) FROM PARAM_ANEEL_TARIFAS`).Scan(&totT)
	_ = db.QueryRow(`SELECT COUNT(*) FROM PARAM_ANEEL_BANDEIRAS`).Scan(&totB)
	resumo := fmt.Sprintf("%d distribuidoras; %d tarifas lidas (linhas afetadas %d); %d meses de bandeira; base: %d tarifas, %d bandeiras; %.0fs",
		len(cnpjs), len(ts), afetadas, len(bs), totT, totB, time.Since(ini).Seconds())
	fim("ok", resumo)
	usinasCacheMu.Lock()
	usinasCache = nil
	usinasCacheMu.Unlock()
	return resumo, nil
}

// POST /api/v1/parametros/aneel/importar-cron — cron da VPS (header X-Cron-Token == env CRON_TOKEN)
func ImportarANEELCron(c *gin.Context) {
	tok := strings.TrimSpace(os.Getenv("CRON_TOKEN"))
	if tok == "" || c.GetHeader("X-Cron-Token") != tok {
		c.JSON(http.StatusForbidden, gin.H{"error": "token de cron inválido"})
		return
	}
	db, err := usinasDB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	r, err := ImportarANEEL(db, "cron", "cron")
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "resumo": r})
}

// POST /api/v1/parametros/aneel/importar — botão "Atualizar agora" (gestor)
func ImportarANEELManual(c *gin.Context) {
	db, err := usinasDB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	_, uname := usuarioIA(c)
	r, err := ImportarANEEL(db, "manual", uname)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "resumo": r})
}

// GET /api/v1/parametros/aneel/status — última importação e tamanho da base
func StatusANEEL(c *gin.Context) {
	db, err := usinasDB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	out := gin.H{"importado": false}
	var totT, totB int
	if db.QueryRow(`SELECT COUNT(*) FROM PARAM_ANEEL_TARIFAS`).Scan(&totT) == nil {
		_ = db.QueryRow(`SELECT COUNT(*) FROM PARAM_ANEEL_BANDEIRAS`).Scan(&totB)
		out["importado"] = totT > 0
		out["tarifas"], out["bandeiras"] = totT, totB
		var ini, st, res sql.NullString
		if db.QueryRow(`SELECT DATE_FORMAT(iniciado_em,'%Y-%m-%d %H:%i'), status, resumo FROM PARAM_ANEEL_IMPORTACOES
			ORDER BY id DESC LIMIT 1`).Scan(&ini, &st, &res) == nil {
			out["ultima"] = gin.H{"em": ini.String, "status": st.String, "resumo": res.String}
		}
		var ult sql.NullString
		_ = db.QueryRow(`SELECT DATE_FORMAT(MAX(competencia),'%m/%Y') FROM PARAM_ANEEL_BANDEIRAS`).Scan(&ult)
		out["bandeira_ate"] = ult.String
	}
	c.JSON(http.StatusOK, out)
}

// ---------------------------------------------------------------- consultas usadas pelas regras

func normModalidade(m string) string {
	t := strings.ToUpper(sem(m))
	switch {
	case strings.Contains(t, "VERDE"):
		return "Verde"
	case strings.Contains(t, "AZUL"):
		return "Azul"
	case strings.Contains(t, "BRANCA"):
		return "Branca"
	case strings.Contains(t, "CONVENCIONAL"):
		return "Convencional"
	}
	return ""
}

func postoANEEL(p string) string {
	switch p {
	case "PONTA":
		return "Ponta"
	case "FORA_PONTA":
		return "Fora ponta"
	case "INTERMEDIARIO":
		return "Intermediário"
	}
	return "Não se aplica"
}

// tarifasVigentes — linhas homologadas da distribuidora/subgrupo/modalidade/posto/unidade vigentes na data.
// detalhe: "Não se aplica" (tarifa normal) ou "SCEE"; geração = modalidade "Geração".
func (b *aneelBase) tarifasVigentes(cnpj, subgrupo, modalidade, posto, unidade, detalhe, data string) []tarifaANEEL {
	var out []tarifaANEEL
	for _, t := range b.tarifas {
		if t.CNPJ != cnpj || !strings.EqualFold(t.Subgrupo, subgrupo) || t.Modalidade != modalidade ||
			t.Detalhe != detalhe || !strings.EqualFold(t.Unidade, unidade) || t.Inicio > data || t.Fim < data {
			continue
		}
		if posto != "" && t.Posto != posto {
			continue
		}
		if t.Acessante != "" && t.Acessante != "Não se aplica" {
			continue // tarifa específica de um gerador (TUSDg de usina nomeada)
		}
		out = append(out, t)
	}
	return out
}

// rehMudou — há início de vigência entre as duas datas (ciclo atravessa um reajuste)
func (b *aneelBase) rehMudou(cnpj, subgrupo, modalidade, de, ate string) bool {
	for _, t := range b.tarifas {
		if t.CNPJ == cnpj && strings.EqualFold(t.Subgrupo, subgrupo) && t.Modalidade == modalidade && t.Inicio > de && t.Inicio <= ate {
			return true
		}
	}
	return false
}
