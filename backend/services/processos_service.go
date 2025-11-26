package services

import (
	"context"

	"ressarcimento-backend/models"
	"ressarcimento-backend/repositories"
)

type ProcessosService interface {
	ListarKanbanFast(ctx context.Context) ([]models.ProcessoKanban, error)
}

type processosService struct {
	repo repositories.ProcessosRepository
}

func NewProcessosService(r repositories.ProcessosRepository) ProcessosService {
	return &processosService{repo: r}
}

func (s *processosService) ListarKanbanFast(ctx context.Context) ([]models.ProcessoKanban, error) {
	return s.repo.ListarKanbanFast(ctx)
}
