package handlers

import (
	"context"
	"database/sql"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
	"ressarcimento-backend/services"
)

// ============================================================================
// Cobrança de retorno (SR = "sem retorno") EM LOTE — pedido feito no chat, ex.:
// "verifique o que está atrasado da CELESC nos Prazos e o que estiver sem resposta
// na caixa de entrada, escreva um e-mail de SR".
//
//   1. Prazos: mesmos processos "Aguardando retorno" VENCIDOS da tela Prazos
//      (services.CalcularProcessosComPrazo, regra 5/10/30/30 por instância);
//   2. filtra pela distribuidora citada;
//   3. "sem resposta": mesma regra do modal de cobrança (último e-mail enviado sem
//      e-mail recebido depois) — via GerarCobrancaParaProcesso / cache;
//   4. devolve os rascunhos (4 tons) prontos. NÃO envia nada: o front abre o modal de
//      cobrança de cada processo, a pessoa revisa e envia (fica registrado no processo).
// ============================================================================

type cobrancaLoteItem struct {
	IDProcesso      int    `json:"id_processo"`
	CodigoPublico   string `json:"codigo_publico"`
	UC              string `json:"uc"`
	Cliente         string `json:"cliente"`
	Concessionaria  string `json:"concessionaria"`
	Instancia       string `json:"instancia"`
	SubEtapa        string `json:"sub_etapa"`
	DiasAtraso      int    `json:"dias_atraso"`
	DiasSemRetorno  int    `json:"dias_sem_retorno"`
	TemEmailEnviado bool   `json:"tem_email_enviado"`
	SemRetorno      bool   `json:"sem_retorno"`
	Para            string `json:"para"`
	Cc              string `json:"cc"`
	Subject         string `json:"subject"`
	Formal          string `json:"formal"`
	Direto          string `json:"direto"`
	Amigavel        string `json:"amigavel"`
	Firme           string `json:"firme"`
	Erro            string `json:"erro,omitempty"`
}

func normConc(s string) string {
	return strings.ToUpper(strings.TrimSpace(reDeAcentoSimples.Replace(s)))
}

var reDeAcentoSimples = strings.NewReplacer(
	"á", "a", "à", "a", "â", "a", "ã", "a", "é", "e", "ê", "e", "í", "i", "ó", "o", "ô", "o", "õ", "o", "ú", "u", "ç", "c",
	"Á", "A", "À", "A", "Â", "A", "Ã", "A", "É", "E", "Ê", "E", "Í", "I", "Ó", "O", "Ô", "O", "Õ", "O", "Ú", "U", "Ç", "C")

// concessionariaNaMensagem acha, no texto livre, qual distribuidora foi citada — comparando
// com as concessionárias que existem nos processos (a mais longa que aparecer vence:
// "ENEL SP" antes de "ENEL").
func concessionariaNaMensagem(msg string, nomes []string) string {
	m := " " + normConc(msg) + " "
	melhor := ""
	for _, n := range nomes {
		nn := normConc(n)
		if len(nn) < 3 {
			continue
		}
		if strings.Contains(m, " "+nn+" ") || strings.Contains(m, " "+nn+",") || strings.Contains(m, " "+nn+".") {
			if len(nn) > len(melhor) {
				melhor = n
			}
		}
	}
	return melhor
}

// CobrancaLoteHandler — POST /api/v1/processos/cobranca-lote
// Body: {"mensagem": "texto do chat"} e/ou {"concessionaria": "CELESC"}, "incluir_respondidos": false, "limite": 25
func CobrancaLoteHandler(c *gin.Context) {
	var body struct {
		Mensagem          string `json:"mensagem"`
		Concessionaria    string `json:"concessionaria"`
		IncluirRespondido bool   `json:"incluir_respondidos"`
		Limite            int    `json:"limite"`
	}
	_ = c.ShouldBindJSON(&body)
	if body.Limite <= 0 || body.Limite > 40 {
		body.Limite = 25
	}

	processos, err := services.CalcularProcessosComPrazo([]int{3}) // 3 = Aguardando retorno
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	conc := strings.TrimSpace(body.Concessionaria)
	if conc == "" && strings.TrimSpace(body.Mensagem) != "" {
		vistos := map[string]bool{}
		var nomes []string
		for _, p := range processos {
			if p.Concessionaria != "" && !vistos[p.Concessionaria] {
				vistos[p.Concessionaria] = true
				nomes = append(nomes, p.Concessionaria)
			}
		}
		conc = concessionariaNaMensagem(body.Mensagem, nomes)
	}

	// vencidos (com regra de prazo) da distribuidora pedida — mais atrasados primeiro
	var alvo []services.ProcessoPrazo
	for _, p := range processos {
		if !p.Atrasado || !p.TemRegra {
			continue
		}
		if conc != "" && !strings.Contains(normConc(p.Concessionaria), normConc(conc)) {
			continue
		}
		alvo = append(alvo, p)
	}
	sort.Slice(alvo, func(i, j int) bool {
		return alvo[i].DiasDecorridos-alvo[i].PrazoDias > alvo[j].DiasDecorridos-alvo[j].PrazoDias
	})
	totalAtrasados := len(alvo)
	truncado := false
	if len(alvo) > body.Limite {
		alvo, truncado = alvo[:body.Limite], true
	}

	db := database.GormDB_App
	codigos := map[int]string{}
	for _, p := range alvo {
		var cod string
		_ = queryRowGorm(db, `SELECT COALESCE(codigo_publico,'') FROM FT_PROCESSOS WHERE id_processo=?`, p.IDProcesso).Scan(&cod)
		codigos[p.IDProcesso] = cod
	}

	// gera (ou reaproveita do cache, se o thread de e-mail não mudou) — 3 em paralelo
	ctx, cancel := context.WithTimeout(c.Request.Context(), 4*time.Minute)
	defer cancel()
	itens := make([]cobrancaLoteItem, len(alvo))
	sem := make(chan struct{}, 3)
	var wg sync.WaitGroup
	for i, p := range alvo {
		wg.Add(1)
		go func(i int, p services.ProcessoPrazo) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			it := cobrancaLoteItem{IDProcesso: p.IDProcesso, CodigoPublico: codigos[p.IDProcesso], UC: p.UC, Cliente: p.Cliente,
				Concessionaria: p.Concessionaria, Instancia: p.Instancia, SubEtapa: p.SubEtapa, DiasAtraso: p.DiasDecorridos - p.PrazoDias}
			res, e := cobrancaDoCacheOuGera(ctx, p.IDProcesso)
			if e != nil {
				it.Erro = e.Error()
			} else {
				it.SemRetorno, it.TemEmailEnviado, it.DiasSemRetorno = res.SemRetorno, res.TemEmailEnviado, res.DiasSemRetorno
				it.Para, it.Cc, it.Subject = res.Para, res.Cc, res.Subject
				it.Formal, it.Direto, it.Amigavel, it.Firme = res.Formal, res.Direto, res.Amigavel, res.Firme
			}
			itens[i] = it
		}(i, p)
	}
	wg.Wait()

	out := make([]cobrancaLoteItem, 0, len(itens))
	respondidos := 0
	for _, it := range itens {
		if it.Erro == "" && !it.SemRetorno && !body.IncluirRespondido {
			respondidos++ // a distribuidora respondeu depois do último envio → não é SR
			continue
		}
		out = append(out, it)
	}
	c.JSON(http.StatusOK, gin.H{
		"concessionaria":  conc,
		"total_atrasados": totalAtrasados,
		"analisados":      len(itens),
		"truncado":        truncado,
		"respondidos":     respondidos,
		"itens":           out,
	})
}

// cobrancaDoCacheOuGera usa o PROCESSO_COBRANCA_CACHE quando o thread de e-mail do processo
// não mudou desde a última análise; senão gera de novo e atualiza o cache.
func cobrancaDoCacheOuGera(ctx context.Context, id int) (*CobrancaResultado, error) {
	db := database.GormDB_App
	hash := emailThreadHash(db, id)
	var hashAtual, status, subject, formal, direto string
	var amigavel, firme sql.NullString
	var semRetorno, temEmail bool
	var dias int
	err := queryRowGorm(db, `SELECT email_thread_hash, status, subject, opcao1, opcao2, amigavel, firme,
  sem_retorno, tem_email_enviado, dias_sem_retorno FROM PROCESSO_COBRANCA_CACHE WHERE id_processo=?`, id).
		Scan(&hashAtual, &status, &subject, &formal, &direto, &amigavel, &firme, &semRetorno, &temEmail, &dias)
	if err == nil && status == "ready" && hashAtual == hash {
		para, cc := ultimoEmailEnviadoDestinatarios(db, id)
		return &CobrancaResultado{Subject: subject, Formal: formal, Direto: direto, Amigavel: amigavel.String, Firme: firme.String,
			Para: para, Cc: cc, SemRetorno: semRetorno, TemEmailEnviado: temEmail, DiasSemRetorno: dias}, nil
	}
	res, err := GerarCobrancaParaProcesso(ctx, id)
	if err != nil {
		salvarCacheCobranca(db, id, hash, nil, "error", err.Error())
		return nil, err
	}
	salvarCacheCobranca(db, id, hash, res, "ready", "")
	return res, nil
}
