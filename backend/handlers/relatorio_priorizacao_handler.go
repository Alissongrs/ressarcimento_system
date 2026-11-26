package handlers

// Relatório de priorização de casos deferidos (pedido da Luana, 26/11/2026).
//
// Substitui a planilha "Lista de Priorização de Casos": todos os processos deferidos, com
//   - estrela marcada por admin/gestor (1 = prioridade 1, estrela maior; 2 = prioridade 2, estrela menor; 0 = irrelevante);
//   - comprovante de depósito da distribuidora ao cliente e a FONTE de onde veio (cadastro manual/e-mail/WhatsApp,
//     comentário do histórico, e-mail recebido ou, na falta, a entrada em Faturamento);
//   - tempo médio até o comprovante (procedências desde 01/01/2026, por distribuidora quando há 3+ casos) e a data
//     estimada pelo sistema para quem ainda não recebeu, ao lado da data digitada pela Luana.
// Tabelas: FT_RELATORIO_PRIORIZACAO e FT_PROCESSO_COMPROVANTE (migrations_additive.go).

import (
	"database/sql"
	"log"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

// Procedências a partir desta data entram na média ("depois da mudança do sistema").
const priorizacaoInicioMedia = "2026-01-01"

// comentário do histórico que diz que o comprovante CHEGOU (não os pedidos/cobranças de comprovante)
var reComprovanteRecebido = regexp.MustCompile(`(?i)(receb\w*|chegou|enviaram|encaminharam|anexad\w*)[^.;\n]{0,60}comprovante|comprovante[^.;\n]{0,40}(recebid\w*|chegou|anexad\w*)`)
var reComprovantePedido = regexp.MustCompile(`(?i)(cobr\w*|solicit\w*|pedi\w*|aguard\w*|reforç\w*|falt\w*|envio d[oa])[^.;\n]{0,40}comprovante`)

type priorizacaoComprovante struct {
	Data       string `json:"data"`
	Fonte      string `json:"fonte"`
	Referencia string `json:"referencia,omitempty"`
	ID         int64  `json:"id,omitempty"`
	t          time.Time
}

type priorizacaoItem struct {
	IDProcesso       int64                   `json:"id_processo"`
	UC               string                  `json:"uc"`
	Cliente          string                  `json:"cliente"`
	Concessionaria   string                  `json:"concessionaria"`
	Instancia        string                  `json:"instancia"`
	Etapa            string                  `json:"etapa"`
	IDEtapa          int                     `json:"id_etapa"`
	Deferido         bool                    `json:"deferido"`
	Status           string                  `json:"status"`
	DataProcedencia  string                  `json:"data_procedencia"`
	UltimaMov        string                  `json:"ultima_movimentacao"`
	TotalCliente     float64                 `json:"total_cliente"`
	TotalAmee        float64                 `json:"total_amee"`
	EnvioFinanceiro  string                  `json:"data_envio_financeiro"`
	Estrela          int                     `json:"estrela"`
	DataManual       string                  `json:"data_manual"`
	Observacao       string                  `json:"observacao"`
	Comprovante      *priorizacaoComprovante `json:"comprovante"`
	DiasComprovante  *int                    `json:"dias_ate_comprovante"`
	DataEstimada     string                  `json:"data_estimada"`
	BaseEstimativa   string                  `json:"base_estimativa"`
	DiasParaEstimada *int                    `json:"dias_para_estimada"`
	Finalizado       string                  `json:"finalizado_em"`
	FonteFinalizacao string                  `json:"fonte_finalizacao"`
	RefFinalizacao   string                  `json:"ref_finalizacao,omitempty"`
	procedencia      time.Time
}

var reUCNorm = regexp.MustCompile(`[^0-9A-Za-z]`)

// normUC: "8.535.465.018-89" / "0414828816 (PARTE 1)" → só alfanumérico, sem zeros à esquerda.
func normUC(s string) string {
	if i := strings.Index(s, "("); i > 0 {
		s = s[:i]
	}
	return strings.TrimLeft(strings.ToUpper(reUCNorm.ReplaceAllString(s, "")), "0")
}

func priorizacaoDB() (*sql.DB, bool) {
	if database.GormDB_App == nil {
		return nil, false
	}
	db, err := database.GormDB_App.DB()
	if err != nil {
		return nil, false
	}
	return db, true
}

func fmtData(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format("2006-01-02")
}

func parseDataSQL(v sql.NullString) time.Time {
	if !v.Valid || len(v.String) < 10 {
		return time.Time{}
	}
	t, err := time.Parse("2006-01-02", v.String[:10])
	if err != nil {
		return time.Time{}
	}
	return t
}

// priorizacaoDados é o resultado comum da tela e do Excel.
type priorizacaoDados struct {
	Itens      []*priorizacaoItem
	MediaGeral float64 // -1 = sem casos
	NaMedia    int
	PorDist    map[string][2]int
}

// GetRelatorioPriorizacao lista todos os processos deferidos com estrela, comprovante e datas.
// GET /api/v1/relatorios/priorizacao[?encerrados=1]
func GetRelatorioPriorizacao(c *gin.Context) {
	db, ok := priorizacaoDB()
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "banco indisponível"})
		return
	}
	d, err := carregarPriorizacao(db, c.Query("encerrados") == "1")
	if err != nil {
		log.Printf("GetRelatorioPriorizacao: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro na consulta"})
		return
	}
	medias := []gin.H{}
	for k, v := range d.PorDist {
		medias = append(medias, gin.H{"concessionaria": k, "media_dias": math.Round(float64(v[0])/float64(v[1])*10) / 10, "casos": v[1]})
	}
	sort.Slice(medias, func(a, b int) bool { return medias[a]["casos"].(int) > medias[b]["casos"].(int) })
	var mg interface{}
	if d.MediaGeral >= 0 {
		mg = math.Round(d.MediaGeral*10) / 10
	}
	c.JSON(http.StatusOK, gin.H{
		"processos":        d.Itens,
		"media_geral_dias": mg,
		"casos_na_media":   d.NaMedia,
		"medias_por_dist":  medias,
		"inicio_media":     priorizacaoInicioMedia,
		"gerado_em":        time.Now().Format("2006-01-02 15:04"),
	})
}

// carregarPriorizacao: deferidos (sem os encerrados, salvo encerrados=true) + todo processo marcado com estrela,
// mesmo que não esteja deferido no sistema (a Luana prioriza casos ainda em contestação).
func carregarPriorizacao(db *sql.DB, encerrados bool) (*priorizacaoDados, error) {
	filtroEtapa := "AND COALESCE(p.id_etapa_atual,0) <> 6"
	if encerrados {
		filtroEtapa = ""
	}
	rows, err := db.Query(`
		SELECT p.id_processo, COALESCE(p.uc,''), COALESCE(p.cliente,''), COALESCE(p.concessionaria,''),
		       COALESCE(i.nome,''), COALESCE(e.nome,''), COALESCE(p.id_etapa_atual,0), COALESCE(s.nome,''),
		       DATE_FORMAT(COALESCE(d.data_procedencia, p.data_procedencia),'%Y-%m-%d'),
		       DATE_FORMAT(p.data_movimentacao,'%Y-%m-%d'),
		       COALESCE(d.credito_simples, p.credito_simples, 0) + COALESCE(d.credito_dobro, p.credito_dobro, 0),
		       COALESCE(d.repasse_simples, p.repasse_simples, 0) + COALESCE(d.repasse_dobro, p.repasse_dobro, 0),
		       DATE_FORMAT(f.data_envio_financeiro,'%Y-%m-%d'),
		       COALESCE(r.estrela,0), DATE_FORMAT(r.data_manual,'%Y-%m-%d'), COALESCE(r.observacao,''),
		       COALESCE(p.id_aprovacao_atual,0) = 1
		  FROM FT_PROCESSOS p
		  LEFT JOIN DM_INSTANCIAS i ON i.id_instancia = p.id_instancia_atual
		  LEFT JOIN DM_ETAPAS e ON e.id_etapa = p.id_etapa_atual
		  LEFT JOIN DM_STATUS_PROCESSO s ON s.id_status = p.id_status_atual
		  LEFT JOIN (SELECT id_processo, MAX(id_deferimento) mx FROM FT_DEFERIMENTOS GROUP BY id_processo) dm ON dm.id_processo = p.id_processo
		  LEFT JOIN FT_DEFERIMENTOS d ON d.id_deferimento = dm.mx
		  LEFT JOIN (SELECT id_processo, MIN(data_envio_financeiro) data_envio_financeiro FROM FT_FATURAMENTO GROUP BY id_processo) f ON f.id_processo = p.id_processo
		  LEFT JOIN FT_RELATORIO_PRIORIZACAO r ON r.id_processo = p.id_processo
		 WHERE (p.id_aprovacao_atual = 1 ` + filtroEtapa + `) OR COALESCE(r.estrela,0) > 0
		 ORDER BY p.id_processo`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	itens := []*priorizacaoItem{}
	por := map[int64]*priorizacaoItem{}
	for rows.Next() {
		it := &priorizacaoItem{}
		var proc, mov, envio, manual sql.NullString
		if err := rows.Scan(&it.IDProcesso, &it.UC, &it.Cliente, &it.Concessionaria, &it.Instancia, &it.Etapa, &it.IDEtapa,
			&it.Status, &proc, &mov, &it.TotalCliente, &it.TotalAmee, &envio, &it.Estrela, &manual, &it.Observacao, &it.Deferido); err != nil {
			log.Printf("GetRelatorioPriorizacao scan: %v", err)
			continue
		}
		it.procedencia = parseDataSQL(proc)
		it.DataProcedencia = fmtData(it.procedencia)
		it.UltimaMov = mov.String
		it.EnvioFinanceiro = envio.String
		it.DataManual = manual.String
		itens = append(itens, it)
		por[it.IDProcesso] = it
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Finalização: a equipe só encerra depois que a distribuidora manda o comprovante de depósito. O encerramento é o
	// dossiê "Procedente - Relatórios e Evidências - Instalação <UC>" mandado ao financeiro; no sistema, a data de envio
	// ao financeiro (Faturamento), que às vezes é lançada dias depois — por isso vale a data do financeiro quando existe
	// e, sem ela, a do dossiê.
	porUC := map[string][]*priorizacaoItem{}
	for _, it := range itens {
		if k := normUC(it.UC); k != "" {
			porUC[k] = append(porUC[k], it)
		}
	}
	if r, err := db.Query(`SELECT TRIM(SUBSTRING_INDEX(subject,'Instalação',-1)), DATE_FORMAT(received_at,'%Y-%m-%d'), subject
	                          FROM mail_messages
	                         WHERE subject LIKE 'Procedente - Relat%' AND from_email LIKE '%@amee.com.br'
	                         ORDER BY received_at`); err == nil {
		for r.Next() {
			var uc, d, assunto sql.NullString
			if r.Scan(&uc, &d, &assunto) != nil {
				continue
			}
			t := parseDataSQL(d)
			for _, it := range porUC[normUC(uc.String)] {
				if it.EnvioFinanceiro != "" || it.Finalizado != "" || t.IsZero() {
					continue
				}
				if !it.procedencia.IsZero() && t.Before(it.procedencia) {
					continue // dossiê de um procedente anterior da mesma UC
				}
				it.Finalizado, it.FonteFinalizacao, it.RefFinalizacao = fmtData(t), "dossiê ao financeiro (e-mail)", assunto.String
			}
		}
		r.Close()
	} else {
		log.Printf("carregarPriorizacao dossiês: %v", err)
	}
	for _, it := range itens {
		if it.EnvioFinanceiro != "" {
			it.Finalizado, it.FonteFinalizacao = it.EnvioFinanceiro, "envio ao financeiro"
		}
	}

	// comprovantes, da fonte mais forte para a mais fraca; fica o primeiro achado de cada processo
	definir := func(id int64, t time.Time, fonte, ref string, idc int64) {
		it := por[id]
		if it == nil || t.IsZero() || it.Comprovante != nil {
			return
		}
		if !it.procedencia.IsZero() && t.Before(it.procedencia.AddDate(0, 0, -1)) {
			return // comprovante anterior à procedência é de outra devolução
		}
		it.Comprovante = &priorizacaoComprovante{Data: fmtData(t), Fonte: fonte, Referencia: ref, ID: idc, t: t}
	}
	if r, err := db.Query(`SELECT id, id_processo, DATE_FORMAT(data_comprovante,'%Y-%m-%d'), fonte, COALESCE(referencia,'')
	                          FROM FT_PROCESSO_COMPROVANTE ORDER BY data_comprovante, id`); err == nil {
		for r.Next() {
			var idc, idp int64
			var d sql.NullString
			var fonte, ref string
			if r.Scan(&idc, &idp, &d, &fonte, &ref) == nil {
				definir(idp, parseDataSQL(d), fonte, ref, idc)
			}
		}
		r.Close()
	} else {
		log.Printf("GetRelatorioPriorizacao comprovantes: %v", err)
	}
	if r, err := db.Query(`SELECT h.id_processo, DATE_FORMAT(h.data_movimentacao,'%Y-%m-%d'), h.comentario
	                          FROM FT_HISTORICO_MOVIMENTACOES h
	                         WHERE h.comentario LIKE '%comprovante%'
	                         ORDER BY h.data_movimentacao`); err == nil {
		for r.Next() {
			var idp int64
			var d sql.NullString
			var com string
			if r.Scan(&idp, &d, &com) == nil && reComprovanteRecebido.MatchString(com) && !reComprovantePedido.MatchString(com) {
				ref := strings.TrimSpace(com)
				if len([]rune(ref)) > 160 {
					ref = string([]rune(ref)[:160]) + "…"
				}
				definir(idp, parseDataSQL(d), "historico", ref, 0)
			}
		}
		r.Close()
	}
	if r, err := db.Query(`SELECT id_processo, DATE_FORMAT(MIN(data_envio),'%Y-%m-%d'), MIN(assunto)
	                          FROM FT_EMAILS_PROCESSO
	                         WHERE tipo = 'recebido' AND id_processo IS NOT NULL AND assunto LIKE '%comprovante%'
	                         GROUP BY id_processo`); err == nil {
		for r.Next() {
			var idp int64
			var d, ass sql.NullString
			if r.Scan(&idp, &d, &ass) == nil {
				definir(idp, parseDataSQL(d), "email", ass.String, 0)
			}
		}
		r.Close()
	}
	// Envio ao financeiro NÃO é comprovante: é o informativo nosso para o financeiro
	// cobrar o cliente. Comprovante = documento enviado pela distribuidora a nós.

	// tempo médio procedência → comprovante (procedências desde 01/01/2026)
	inicio, _ := time.Parse("2006-01-02", priorizacaoInicioMedia)
	soma, n := 0, 0
	porDist := map[string][2]int{}
	for _, it := range itens {
		if it.Comprovante == nil || it.procedencia.IsZero() {
			continue
		}
		dias := int(it.Comprovante.t.Sub(it.procedencia).Hours() / 24)
		if dias < 0 {
			dias = 0
		}
		d := dias
		it.DiasComprovante = &d
		if it.procedencia.Before(inicio) {
			continue
		}
		soma += dias
		n++
		k := strings.ToUpper(strings.TrimSpace(it.Concessionaria))
		v := porDist[k]
		porDist[k] = [2]int{v[0] + dias, v[1] + 1}
	}
	mediaGeral := -1.0
	if n > 0 {
		mediaGeral = float64(soma) / float64(n)
	}
	hoje := time.Now()
	hoje = time.Date(hoje.Year(), hoje.Month(), hoje.Day(), 0, 0, 0, 0, time.Local)
	for _, it := range itens {
		if it.Comprovante != nil || it.Finalizado != "" || it.procedencia.IsZero() {
			continue
		}
		media, base := mediaGeral, "média geral"
		if v := porDist[strings.ToUpper(strings.TrimSpace(it.Concessionaria))]; v[1] >= 3 {
			media, base = float64(v[0])/float64(v[1]), "média da distribuidora"
		}
		if media < 0 {
			continue
		}
		est := it.procedencia.AddDate(0, 0, int(math.Round(media)))
		it.DataEstimada = fmtData(est)
		it.BaseEstimativa = base
		faltam := int(math.Round(est.Sub(hoje).Hours() / 24))
		it.DiasParaEstimada = &faltam
	}
	return &priorizacaoDados{Itens: itens, MediaGeral: mediaGeral, NaMedia: n, PorDist: porDist}, nil
}

// PutRelatorioPriorizacao grava estrela e/ou data manual de um processo.
// PUT /api/v1/relatorios/priorizacao/:id  {"estrela":0|1|2, "data_manual":"AAAA-MM-DD"|""}
func PutRelatorioPriorizacao(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "processo inválido"})
		return
	}
	var in struct {
		Estrela    *int    `json:"estrela"`
		DataManual *string `json:"data_manual"`
		Observacao *string `json:"observacao"`
	}
	if err := c.ShouldBindJSON(&in); err != nil || (in.Estrela == nil && in.DataManual == nil && in.Observacao == nil) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "nada para gravar"})
		return
	}
	if in.Estrela != nil && (*in.Estrela < 0 || *in.Estrela > 2) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "estrela deve ser 0, 1 ou 2"})
		return
	}
	var data interface{}
	if in.DataManual != nil && strings.TrimSpace(*in.DataManual) != "" {
		t, err := time.Parse("2006-01-02", strings.TrimSpace(*in.DataManual))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "data no formato AAAA-MM-DD"})
			return
		}
		data = t.Format("2006-01-02")
	}
	db, ok := priorizacaoDB()
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "banco indisponível"})
		return
	}
	uid, _ := getUserIDFromContext(c)
	agora := time.Now()
	if in.Estrela != nil {
		_, err = db.Exec(`INSERT INTO FT_RELATORIO_PRIORIZACAO (id_processo, estrela, atualizado_por, atualizado_em) VALUES (?,?,?,?)
		                  ON DUPLICATE KEY UPDATE estrela = VALUES(estrela), atualizado_por = VALUES(atualizado_por), atualizado_em = VALUES(atualizado_em)`,
			id, *in.Estrela, uid, agora)
	}
	if err == nil && in.DataManual != nil {
		_, err = db.Exec(`INSERT INTO FT_RELATORIO_PRIORIZACAO (id_processo, estrela, data_manual, atualizado_por, atualizado_em) VALUES (?,0,?,?,?)
		                  ON DUPLICATE KEY UPDATE data_manual = VALUES(data_manual), atualizado_por = VALUES(atualizado_por), atualizado_em = VALUES(atualizado_em)`,
			id, data, uid, agora)
	}
	if err == nil && in.Observacao != nil {
		obs := strings.TrimSpace(*in.Observacao)
		if len([]rune(obs)) > 1000 {
			obs = string([]rune(obs)[:1000])
		}
		var v any
		if obs != "" {
			v = obs
		}
		_, err = db.Exec(`INSERT INTO FT_RELATORIO_PRIORIZACAO (id_processo, estrela, observacao, atualizado_por, atualizado_em) VALUES (?,0,?,?,?)
		                  ON DUPLICATE KEY UPDATE observacao = VALUES(observacao), atualizado_por = VALUES(atualizado_por), atualizado_em = VALUES(atualizado_em)`,
			id, v, uid, agora)
	}
	if err != nil {
		log.Printf("PutRelatorioPriorizacao: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao gravar"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// PostComprovanteProcesso registra o comprovante de depósito de um processo com a fonte.
// POST /api/v1/relatorios/priorizacao/:id/comprovante  {"data":"AAAA-MM-DD","fonte":"email|whatsapp|manual","referencia":"..."}
func PostComprovanteProcesso(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "processo inválido"})
		return
	}
	var in struct {
		Data       string `json:"data"`
		Fonte      string `json:"fonte"`
		Referencia string `json:"referencia"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "dados inválidos"})
		return
	}
	t, err := time.Parse("2006-01-02", strings.TrimSpace(in.Data))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "data no formato AAAA-MM-DD"})
		return
	}
	fonte := strings.ToLower(strings.TrimSpace(in.Fonte))
	if fonte != "email" && fonte != "whatsapp" && fonte != "manual" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "fonte deve ser email, whatsapp ou manual"})
		return
	}
	ref := strings.TrimSpace(in.Referencia)
	if len([]rune(ref)) > 255 {
		ref = string([]rune(ref)[:255])
	}
	db, ok := priorizacaoDB()
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "banco indisponível"})
		return
	}
	uid, _ := getUserIDFromContext(c)
	res, err := db.Exec(`INSERT INTO FT_PROCESSO_COMPROVANTE (id_processo, data_comprovante, fonte, referencia, id_usuario, criado_em)
	                     VALUES (?,?,?,?,?,?)`, id, t.Format("2006-01-02"), fonte, ref, uid, time.Now())
	if err != nil {
		log.Printf("PostComprovanteProcesso: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao gravar"})
		return
	}
	novo, _ := res.LastInsertId()
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": novo})
}

// DeleteComprovanteProcesso apaga um comprovante cadastrado (só os da tabela própria).
// DELETE /api/v1/relatorios/priorizacao/comprovante/:idc
func DeleteComprovanteProcesso(c *gin.Context) {
	idc, err := strconv.ParseInt(c.Param("idc"), 10, 64)
	if err != nil || idc <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "comprovante inválido"})
		return
	}
	db, ok := priorizacaoDB()
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "banco indisponível"})
		return
	}
	if _, err := db.Exec(`DELETE FROM FT_PROCESSO_COMPROVANTE WHERE id = ?`, idc); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao apagar"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
