package main

import (
	"context"
	"log"
	"os"
	"time"

	"ressarcimento-backend/auth"
	"ressarcimento-backend/database"
	"ressarcimento-backend/repositories"
	"ressarcimento-backend/routes"
	"ressarcimento-backend/services"

	"github.com/go-co-op/gocron"
	"github.com/joho/godotenv"
)

func main() {
	if err := godotenv.Load(); err != nil {
		log.Println("Aviso: Não foi possível carregar .env (usando variáveis do sistema).")
	}

	// Fixar timezone padrão da aplicação em America/Sao_Paulo
	if loc, err := time.LoadLocation("America/Sao_Paulo"); err == nil {
		time.Local = loc
	} else {
		log.Printf("Aviso: falha ao carregar timezone America/Sao_Paulo: %v", err)
	}

	// Valida configuração de segurança JWT (crítico em produção)
	if err := auth.ValidateJWTSetup(); err != nil {
		log.Fatalf("ERRO CRÍTICO na validação JWT: %v", err)
	}

	// Abre as conexões (populará database.DB_App e database.DB_Consulta)
	database.InitDBs()

	// Use a conexão principal da aplicação
	db := database.DB_App
	if db == nil {
		log.Fatal("database.DB_App está nil — verifique se InitDBs() inicializa a conexão principal corretamente.")
	}

	startScheduler()

	// Monte o router via pacote routes (NÀO registre rotas aqui no main)
	r := routes.SetupRouter(db)

	log.Println("Servidor iniciado em http://localhost:8080")
	if err := r.Run(":8080"); err != nil {
		log.Fatalf("Erro fatal ao iniciar o servidor: %v", err)
	}
}

// startScheduler configura e inicia todas as tarefas agendadas.
func startScheduler() {
	// Agendador usando fuso de Brasilia
	loc := time.Local
	s := gocron.NewScheduler(loc)

	log.Println("Configurando agendador de tarefas...")

	// Tarefa 0: Ler e-mails recebidos a cada 5 minutos (desabilitado por padrão)
	// Habilite definindo IMAP_ENABLE=1 no ambiente
	if os.Getenv("IMAP_ENABLE") == "1" {
		s.Every(5).Minutes().Do(services.LerEmailsRecebidos)
	} else {
		log.Println("IMAP desabilitado (defina IMAP_ENABLE=1 para habilitar)")
	}

	// Tarefa 1: Verificar pendências de fluxo a cada 10 dias às 10:00
	s.Every(10).Days().At("10:00").Do(services.VerificarPendenciasDeFluxo)

	// Tarefa 2: Enviar e-mail com movimentações de processos duas vezes ao dia
	s.Every(1).Day().At("06:00").Do(services.EnviarEmailMovimentacoesDiarias)
	s.Every(1).Day().At("12:00").Do(services.EnviarEmailMovimentacoesDiarias)

	// Tarefa 3: Enviar informativo geral toda sexta-feira às 18:00
	s.Cron("0 18 * * 5").Do(services.EnviarInformativoSemanal)

	// Tarefa 4: Checar prazos de requisições (a cada 1 hora)
	s.Every(1).Hour().Do(services.ChecarPrazosRequisicoes)
	// Tarefa 5: Checar prazos de processos (a cada 1 hora)
	s.Every(1).Hour().Do(services.ChecarPrazosProcessos)

    // Tarefa 6: Processar resumos pendentes (a cada 1 minuto)
    s.Every(1).Minutes().Do(func(){
        ctx := context.Background()
        resRepo := repositories.NewResumoRepo(database.DB_App)
        procRepo := repositories.NewProcessosRepo(database.DB_App)
        srv := services.NewResumoService(resRepo, procRepo)
        _ = srv.ProcessarResumos(ctx, 20)
    })

	log.Println("Agendador de tarefas iniciado.")
	s.StartAsync()
}
