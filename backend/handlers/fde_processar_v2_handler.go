package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

// ProcessarV2Handler — dispara o pdf_pipeline_v2 (reprocessar_v2.py) para 1 ID.
// Calcula score de confiança, chama gpt-4.1-mini revisor (se necessário),
// popula as 34 colunas v19 (parcela_art323_*, compensação, regime_norma,
// encargos_extras, etc) e registra divergências em EXTRACAO_DIVERGENCIAS.
//
// POST /api/v1/faturas/:id/processar-v2
//
// Resposta de sucesso:
//   {
//     "id": 9347,
//     "status": "ok",
//     "score_confianca": 28,
//     "revisada_por_gpt": true,
//     "modelo_revisor": "gpt-4.1-mini",
//     "campos_populados": ["tipo_bandeira", "parcela_art323_alerta", ...]
//   }
//
// Em caso de Python indisponível: retorna 503 com instruções claras.
func ProcessarV2Handler(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id inválido"})
		return
	}

	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}

	// Confirma que a fatura existe
	var existeID int64
	if err := sqlDB.QueryRow("SELECT id FROM FATURA_DADOS_EXTRAIDOS WHERE id = ?", id).Scan(&existeID); err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "fatura não encontrada"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao consultar fatura"})
		return
	}

	// Localiza o script Python — tentando vários paths
	scriptPath := localizarScript("reprocessar_v2.py")
	if scriptPath == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "reprocessar_v2.py não encontrado",
			"detalhe": "verifique se a pasta ia/ está disponível ou rode manualmente: " +
				"python ia/reprocessar_v2.py --id " + idStr + " --force",
		})
		return
	}

	// Localiza o Python (preferir venv local)
	pythonExec := localizarPython(filepath.Dir(scriptPath))
	if pythonExec == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "Python não encontrado",
			"detalhe": "verifique se python ou venv está instalado em ia/",
		})
		return
	}

	// Roda o script com timeout de 90 segundos
	ctx, cancel := context.WithTimeout(c.Request.Context(), 90*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, pythonExec, scriptPath, "--id", idStr, "--force", "--workers", "1")
	cmd.Dir = filepath.Dir(scriptPath)
	// Redireciona PYTHONIOENCODING para utf-8
	cmd.Env = append(os.Environ(), "PYTHONIOENCODING=utf-8")

	output, err := cmd.CombinedOutput()
	logSaida := string(output)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   fmt.Sprintf("erro ao rodar reprocessar_v2.py: %v", err),
			"output":  trimLog(logSaida, 4000),
			"comando": pythonExec + " " + scriptPath + " --id " + idStr + " --force",
		})
		return
	}

	// Lê os campos atualizados após o processamento
	var (
		score        sql.NullInt64
		revisada     sql.NullInt64
		modelo       sql.NullString
		alerta       sql.NullString
		regime       sql.NullString
		comp         sql.NullInt64
		statusPassib sql.NullString
		hash         sql.NullString
	)
	err = sqlDB.QueryRow(`
		SELECT
			extracao_score_confianca,
			extracao_revisada_por_gpt,
			extracao_modelo_revisor,
			parcela_art323_alerta,
			parcela_art323_regime_norma,
			compensacao_ja_aplicada,
			extracao_hash,
			CASE
				WHEN COALESCE(parcela_art323_alerta, '') = 'PARCELAMENTO_SOBREPOSTO'
					THEN 'PARCELAMENTO_SOBREPOSTO'
				WHEN COALESCE(compensacao_ja_aplicada, 0) = 1
				  OR COALESCE(devolucao_em_dobro_ativa, 0) = 1
					THEN 'COMPENSADO_NEUTRALIZADO'
				WHEN COALESCE(ciclo_infinito_art113, 0) = 1
					THEN 'PASSIVEL_CICLO_INFINITO'
				WHEN COALESCE(parcela_art323_alerta, '') = 'PARCELAMENTO'
				  OR COALESCE(parcela_art323_y, 0) > 0
					THEN 'TEM_PARCELAMENTO'
				ELSE NULL
			END AS status_passibilidade
		FROM FATURA_DADOS_EXTRAIDOS WHERE id = ?
	`, id).Scan(&score, &revisada, &modelo, &alerta, &regime, &comp, &hash, &statusPassib)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao ler campos atualizados"})
		return
	}

	resp := gin.H{
		"id":     id,
		"status": "ok",
		"output": trimLog(logSaida, 2000),
	}
	if score.Valid {
		resp["score_confianca"] = score.Int64
	}
	if revisada.Valid {
		resp["revisada_por_gpt"] = revisada.Int64 == 1
	}
	if modelo.Valid {
		resp["modelo_revisor"] = modelo.String
	}
	if alerta.Valid {
		resp["parcela_art323_alerta"] = alerta.String
	}
	if regime.Valid {
		resp["regime_norma"] = regime.String
	}
	if comp.Valid {
		resp["compensacao_ja_aplicada"] = comp.Int64 == 1
	}
	if hash.Valid {
		resp["hash"] = hash.String
	}
	if statusPassib.Valid {
		resp["status_passibilidade"] = statusPassib.String
	}

	c.JSON(http.StatusOK, resp)
	_ = json.RawMessage{} // keep encoding/json import warm
}

// localizarScript busca o script .py em paths comuns relativos ao executável.
func localizarScript(nome string) string {
	candidatos := []string{
		filepath.Join("..", "ia", nome),
		filepath.Join("ia", nome),
		filepath.Join("..", "..", "ia", nome),
		filepath.Join("ressarcimento_system", "ia", nome),
	}
	for _, p := range candidatos {
		if abs, err := filepath.Abs(p); err == nil {
			if _, err := os.Stat(abs); err == nil {
				return abs
			}
		}
	}
	return ""
}

// localizarPython tenta usar o venv da pasta ia/ se existir; caso contrário python global.
func localizarPython(dir string) string {
	candidatos := []string{
		filepath.Join(dir, "venv", "Scripts", "python.exe"),         // Windows
		filepath.Join(dir, "venv", "bin", "python"),                 // Linux/Mac
		filepath.Join(dir, ".venv", "Scripts", "python.exe"),
		filepath.Join(dir, ".venv", "bin", "python"),
	}
	for _, p := range candidatos {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	// Fallback global
	for _, exe := range []string{"python", "python3"} {
		if path, err := exec.LookPath(exe); err == nil {
			return path
		}
	}
	return ""
}

func trimLog(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return s[:max] + "\n... (truncado)"
}
