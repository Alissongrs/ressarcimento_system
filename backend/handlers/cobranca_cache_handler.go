package handlers

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"ressarcimento-backend/database"
	"ressarcimento-backend/services"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// emailThreadHash resume o estado atual da troca de e-mails de um processo (id+tipo+data
// de cada e-mail) num hash — usado pra saber se chegou algo novo desde a última análise,
// sem precisar comparar o conteúdo inteiro.
func emailThreadHash(db *gorm.DB, idProcesso int) string {
	rows, err := queryGorm(db, `
		SELECT id_email, tipo, data_envio FROM FT_EMAILS_PROCESSO
		WHERE id_processo = ? ORDER BY id_email`, idProcesso)
	if err != nil {
		return ""
	}
	defer rows.Close()
	h := sha256.New()
	for rows.Next() {
		var idEmail int64
		var tipo string
		var dataEnvio time.Time
		if rows.Scan(&idEmail, &tipo, &dataEnvio) == nil {
			fmt.Fprintf(h, "%d|%s|%s;", idEmail, tipo, dataEnvio.Format(time.RFC3339))
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}

// salvarCacheCobranca grava/atualiza a linha de cache pra um processo (upsert).
func salvarCacheCobranca(db *gorm.DB, idProcesso int, hash string, res *CobrancaResultado, status, erro string) {
	subject, formal, direto, amigavel, firme := "", "", "", "", ""
	semRetorno, temEmail, dias := false, false, 0
	if res != nil {
		subject, formal, direto, amigavel, firme = res.Subject, res.Formal, res.Direto, res.Amigavel, res.Firme
		semRetorno, temEmail, dias = res.SemRetorno, res.TemEmailEnviado, res.DiasSemRetorno
	}
	_, err := execGorm(db, `
		INSERT INTO PROCESSO_COBRANCA_CACHE
			(id_processo, email_thread_hash, sem_retorno, tem_email_enviado, dias_sem_retorno,
			 subject, opcao1, opcao2, amigavel, firme, modelo, status, erro, atualizado_em)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
		ON DUPLICATE KEY UPDATE
			email_thread_hash=VALUES(email_thread_hash), sem_retorno=VALUES(sem_retorno),
			tem_email_enviado=VALUES(tem_email_enviado), dias_sem_retorno=VALUES(dias_sem_retorno),
			subject=VALUES(subject), opcao1=VALUES(opcao1), opcao2=VALUES(opcao2),
			amigavel=VALUES(amigavel), firme=VALUES(firme),
			modelo=VALUES(modelo), status=VALUES(status), erro=VALUES(erro), atualizado_em=NOW()`,
		idProcesso, hash, semRetorno, temEmail, dias, subject, formal, direto, amigavel, firme,
		aisureOpenAIModel(), status, erro,
	)
	if err != nil {
		log.Printf("[cobranca_cache] erro ao salvar cache do processo %d: %v", idProcesso, err)
	}
}

// GetCobrancaCacheHandler godoc
// @Summary      Lê o cache de cobrança/SR de um processo (sem chamar IA)
// @Tags         Processos
// @Produce      json
// @Param        id path int true "ID do processo"
// @Success      200 {object} map[string]any
// @Failure      404 {object} map[string]string
// @Router       /api/v1/processos/{id}/cobranca-cache [get]
func GetCobrancaCacheHandler(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id inválido"})
		return
	}
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "banco indisponível"})
		return
	}
	var subject, formal, direto, status string
	var amigavel, firme sql.NullString
	var semRetorno, temEmail bool
	var dias int
	var atualizadoEm time.Time
	err = queryRowGorm(db, `
		SELECT subject, opcao1, opcao2, amigavel, firme, sem_retorno, tem_email_enviado, dias_sem_retorno, status, atualizado_em
		FROM PROCESSO_COBRANCA_CACHE WHERE id_processo = ?`, id,
	).Scan(&subject, &formal, &direto, &amigavel, &firme, &semRetorno, &temEmail, &dias, &status, &atualizadoEm)
	if err != nil || status != "ready" {
		c.JSON(http.StatusNotFound, gin.H{"error": "sem cache disponível"})
		return
	}
	// Para/Cc não ficam no cache (mudam a cada e-mail novo, não vale a pena persistir) —
	// recalculados na hora, query leve por índice de id_processo.
	para, cc := ultimoEmailEnviadoDestinatarios(db, id)
	c.JSON(http.StatusOK, gin.H{
		"subject":           subject,
		"formal":            formal,
		"direto":            direto,
		"amigavel":          amigavel.String,
		"firme":             firme.String,
		"para":              para,
		"cc":                cc,
		"sem_retorno":       semRetorno,
		"tem_email_enviado": temEmail,
		"dias_sem_retorno":  dias,
		"atualizado_em":     atualizadoEm.Format(time.RFC3339),
		"cache":             true,
	})
}

// ProcessarCobrancasCache é o cron (hora em hora) do cache de cobrança/SR: para cada
// processo "Aguardando retorno" vencido, verifica se o thread de e-mail mudou desde a
// última análise (hash) e, se sim, gera de novo e atualiza o cache. Não gera alerta nem
// envia nada — só mantém a sugestão pronta pra quando alguém abrir o modal.
func ProcessarCobrancasCache() {
	db := database.GormDB_App
	if db == nil {
		return
	}
	processos, err := services.CalcularProcessosComPrazo([]int{3}) // 3 = Aguardando retorno
	if err != nil {
		log.Printf("[cobranca_cache] erro ao listar processos vencidos: %v", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	atualizados := 0
	for _, p := range processos {
		if !p.Atrasado {
			continue
		}
		hash := emailThreadHash(db, p.IDProcesso)
		var hashAtual string
		var statusAtual string
		_ = queryRowGorm(db, `SELECT email_thread_hash, status FROM PROCESSO_COBRANCA_CACHE WHERE id_processo = ?`, p.IDProcesso).
			Scan(&hashAtual, &statusAtual)
		if hashAtual == hash && statusAtual == "ready" {
			continue // nada novo desde a última análise
		}
		res, err := GerarCobrancaParaProcesso(ctx, p.IDProcesso)
		if err != nil {
			salvarCacheCobranca(db, p.IDProcesso, hash, nil, "error", err.Error())
			continue
		}
		salvarCacheCobranca(db, p.IDProcesso, hash, res, "ready", "")
		atualizados++
	}
	if atualizados > 0 {
		log.Printf("[cobranca_cache] %d processo(s) com cache de cobrança atualizado.", atualizados)
	}
}
