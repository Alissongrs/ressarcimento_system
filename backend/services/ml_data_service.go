package services

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

// AtualizarCSVsML executa o script de extração de dados para atualizar CSVs dos modelos ML
func AtualizarCSVsML(ctx context.Context) error {
	log.Println("[ML-DATA] Iniciando atualização de CSVs para modelos ML...")

	// Detecta caminho do projeto
	projDir := os.Getenv("PROJECT_DIR")
	if projDir == "" {
		// Tenta descobrir automaticamente
		ex, err := os.Executable()
		if err == nil {
			projDir = filepath.Dir(filepath.Dir(ex))
		}
	}

	// Caminho do script de extração
	iaDir := filepath.Join(projDir, "ia")
	scriptPath := filepath.Join(iaDir, "extract_data_from_db.py")

	// Verifica se o script existe
	if _, err := os.Stat(scriptPath); os.IsNotExist(err) {
		return fmt.Errorf("script não encontrado: %s", scriptPath)
	}

	log.Printf("[ML-DATA] Executando: %s", scriptPath)

	// Prepara comando Python
	var cmd *exec.Cmd

	if runtime.GOOS == "windows" {
		// Windows: usa python diretamente
		cmd = exec.CommandContext(ctx, "python", scriptPath)
	} else {
		// Linux/Mac: usa python3
		cmd = exec.CommandContext(ctx, "python3", scriptPath)
	}

	// Define diretório de trabalho
	cmd.Dir = iaDir

	// Captura output
	output, err := cmd.CombinedOutput()

	// Log do output
	logMsg := string(output)
	if err != nil {
		log.Printf("[ML-DATA] ERRO ao atualizar CSVs: %v\n%s", err, logMsg)
		return fmt.Errorf("execução falhou: %w\n%s", err, logMsg)
	}

	log.Printf("[ML-DATA] CSVs atualizados com sucesso!\n%s", logMsg)
	log.Printf("[ML-DATA] Dados disponíveis para AdminPlanilha (requisições) e Ativos")

	return nil
}

// AtualizarCSVsMLAsync executa atualização de CSVs em background
func AtualizarCSVsMLAsync() {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()

		startTime := time.Now()
		if err := AtualizarCSVsML(ctx); err != nil {
			log.Printf("[ML-DATA] Falha na atualização: %v (tempo: %v)", err, time.Since(startTime))
		} else {
			log.Printf("[ML-DATA] Atualização concluída em %v", time.Since(startTime))
		}
	}()
}
