// backend/handlers/health_handler.go
package handlers

import (
	"context"
	"database/sql"
	"net/http"
	"os"
	"time"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

// HealthResponse estrutura de resposta do health check
type HealthResponse struct {
	Status    string            `json:"status"`
	Timestamp string            `json:"timestamp"`
	Version   string            `json:"version,omitempty"`
	Checks    map[string]Health `json:"checks,omitempty"`
}

// Health status de um componente individual
type Health struct {
	Status      string `json:"status"`
	Message     string `json:"message,omitempty"`
	Latency     string `json:"latency,omitempty"`
	OpenConns   int    `json:"open_conns,omitempty"`
	InUse       int    `json:"in_use,omitempty"`
	IdleConns   int    `json:"idle_conns,omitempty"`
}

// SimpleHealthCheck health check simples (apenas status ok)
// @Summary Healthcheck simples
// @Tags Health
// @Produce json
// @Success 200 {object} map[string]bool
// @Router /api/v1/healthz [get]
func SimpleHealthCheck(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// AdvancedHealthCheck health check avançado (verifica dependências)
// @Summary Healthcheck avancado
// @Tags Health
// @Produce json
// @Success 200 {object} HealthResponse
// @Failure 503 {object} HealthResponse
// @Router /api/v1/health [get]
func AdvancedHealthCheck(c *gin.Context) {
	start := time.Now()
	checks := make(map[string]Health)

	// 1. Verifica banco de dados principal
	checks["database"] = checkDatabase()

	// 2. Verifica banco de consulta (opcional)
	if database.DB_Consulta != nil {
		checks["database_consulta"] = checkDatabaseConsulta()
	}

	// 3b. Verifica banco de faturas GORM (opcional)
	if database.GormDB_Faturas != nil {
		checks["database_faturas"] = checkGormDB("faturas", database.GormDB_Faturas)
	}

	// 3. Verifica OCR service (opcional, sem bloquear)
	if ocrURL := os.Getenv("OCR_BACKEND_URL"); ocrURL != "" {
		checks["ocr_service"] = checkOCRService(ocrURL)
	}

	// 4. Verifica Ollama/LLM (opcional, sem bloquear)
	if llmURL := os.Getenv("LLM_OLLAMA_URL"); llmURL != "" {
		checks["llm_service"] = checkLLMService(llmURL)
	}

	// Determina status geral
	status := "healthy"
	statusCode := http.StatusOK

	for _, check := range checks {
		if check.Status == "unhealthy" {
			// Se componente crítico (database) está unhealthy, sistema está unhealthy
			if checks["database"].Status == "unhealthy" {
				status = "unhealthy"
				statusCode = http.StatusServiceUnavailable
				break
			}
			// Componentes opcionais unhealthy = degraded
			status = "degraded"
		}
	}

	response := HealthResponse{
		Status:    status,
		Timestamp: time.Now().Format(time.RFC3339),
		Version:   os.Getenv("APP_VERSION"),
		Checks:    checks,
	}

	c.Header("X-Health-Check-Duration", time.Since(start).String())
	c.JSON(statusCode, response)
}

func checkDatabase() Health {
	if database.GormDB_App == nil {
		return Health{
			Status:  "unhealthy",
			Message: "database connection not initialized",
		}
	}

	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	sqlDB, err := database.GormDB_App.DB()
	if err != nil {
		return Health{
			Status:  "unhealthy",
			Message: err.Error(),
		}
	}
	if err := sqlDB.PingContext(ctx); err != nil {
		return Health{
			Status:  "unhealthy",
			Message: err.Error(),
		}
	}

	stats := sqlDB.Stats()
	return Health{
		Status:    "healthy",
		Latency:   time.Since(start).String(),
		OpenConns: stats.OpenConnections,
		InUse:     stats.InUse,
		IdleConns: stats.Idle,
	}
}

// checkGormDB é um helper genérico para qualquer conexão GORM.
func checkGormDB(name string, gdb interface{ DB() (*sql.DB, error) }) Health {
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	sqlDB, err := gdb.DB()
	if err != nil {
		return Health{Status: "unhealthy", Message: name + ": " + err.Error()}
	}
	if err := sqlDB.PingContext(ctx); err != nil {
		return Health{Status: "degraded", Message: name + ": " + err.Error()}
	}
	stats := sqlDB.Stats()
	return Health{
		Status:    "healthy",
		Latency:   time.Since(start).String(),
		OpenConns: stats.OpenConnections,
		InUse:     stats.InUse,
		IdleConns: stats.Idle,
	}
}

func checkDatabaseConsulta() Health {
	if database.DB_Consulta == nil {
		return Health{
			Status:  "healthy",
			Message: "not configured",
		}
	}

	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if err := database.DB_Consulta.PingContext(ctx); err != nil {
		return Health{
			Status:  "degraded",
			Message: err.Error(),
		}
	}

	return Health{
		Status:  "healthy",
		Latency: time.Since(start).String(),
	}
}

func checkOCRService(url string) Health {
	start := time.Now()
	client := &http.Client{Timeout: 3 * time.Second}

	resp, err := client.Get(url + "/ping")
	if err != nil {
		return Health{
			Status:  "degraded",
			Message: "unreachable: " + err.Error(),
		}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return Health{
			Status:  "degraded",
			Message: "responded with non-200 status",
		}
	}

	return Health{
		Status:  "healthy",
		Latency: time.Since(start).String(),
	}
}

func checkLLMService(url string) Health {
	start := time.Now()
	client := &http.Client{Timeout: 3 * time.Second}

	// Ollama health endpoint
	resp, err := client.Get(url + "/api/tags")
	if err != nil {
		return Health{
			Status:  "degraded",
			Message: "unreachable (optional service)",
		}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return Health{
			Status:  "degraded",
			Message: "responded with non-200 status (optional service)",
		}
	}

	return Health{
		Status:  "healthy",
		Latency: time.Since(start).String(),
	}
}

// ReadinessCheck verifica se o serviço está pronto para receber tráfego
// @Summary Readiness check
// @Tags Health
// @Produce json
// @Success 200 {object} map[string]bool
// @Failure 503 {object} map[string]any
// @Router /api/v1/health/ready [get]
func ReadinessCheck(c *gin.Context) {
	// Verifica apenas componentes críticos
	if database.GormDB_App == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"ready": false,
			"error": "database not initialized",
		})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	sqlDB, err := database.GormDB_App.DB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"ready": false,
			"error": "database unreachable",
		})
		return
	}
	if err := sqlDB.PingContext(ctx); err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"ready": false,
			"error": "database unreachable",
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ready": true})
}

// LivenessCheck verifica se o serviço está vivo (sem verificar dependências)
// @Summary Liveness check
// @Tags Health
// @Produce json
// @Success 200 {object} map[string]bool
// @Router /api/v1/health/live [get]
func LivenessCheck(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"alive": true})
}
