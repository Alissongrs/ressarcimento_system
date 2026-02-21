package handlers

import (
	"encoding/json"
	"os"
	"strings"
	"sync"
	"time"
)

type legacyIndex struct {
	Fonte       string            `json:"fonte"`
	Componentes []legacyComponent `json:"componentes"`
}

type legacyComponent struct {
	Nome      string      `json:"nome"`
	Descricao string      `json:"descricao"`
	Conteudo  interface{} `json:"conteudo"`
}

var ragIndexFileMu sync.Mutex

func isTextIndex(path string) bool {
	return strings.HasSuffix(strings.ToLower(path), ".txt")
}

func loadLegacyIndex(path string) (legacyIndex, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return legacyIndex{}, err
	}
	var idx legacyIndex
	if err := json.Unmarshal(raw, &idx); err != nil {
		return legacyIndex{}, err
	}
	return idx, nil
}

func saveLegacyIndex(path string, idx legacyIndex) error {
	raw, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0644)
}

func ensureLegacyIndex(path string) (legacyIndex, error) {
	idx, err := loadLegacyIndex(path)
	if err == nil {
		return idx, nil
	}
	if !os.IsNotExist(err) {
		return legacyIndex{}, err
	}
	idx = legacyIndex{
		Fonte:       "Auditta + Catalogo de Erros de Faturamento",
		Componentes: []legacyComponent{},
	}
	if err := saveLegacyIndex(path, idx); err != nil {
		return legacyIndex{}, err
	}
	return idx, nil
}

func appendLegacyComponent(name, desc string, content interface{}) error {
	path := getRagIndexPath()
	ragIndexFileMu.Lock()
	defer ragIndexFileMu.Unlock()

	if isTextIndex(path) {
		block := buildTextComponentBlock(name, desc, content)
		f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err != nil {
			return err
		}
		defer f.Close()
		if _, err := f.WriteString(block); err != nil {
			return err
		}
		ragIndex.mu.Lock()
		ragIndex.loaded = false
		ragIndex.docs = nil
		ragIndex.mu.Unlock()
		return nil
	}

	idx, err := ensureLegacyIndex(path)
	if err != nil {
		return err
	}
	idx.Componentes = append(idx.Componentes, legacyComponent{
		Nome:      name,
		Descricao: desc,
		Conteudo:  content,
	})
	if err := saveLegacyIndex(path, idx); err != nil {
		return err
	}

	ragIndex.mu.Lock()
	ragIndex.loaded = false
	ragIndex.docs = nil
	ragIndex.mu.Unlock()

	return nil
}

func buildTextComponentBlock(name, desc string, content interface{}) string {
	var parts []string
	parts = append(parts, "\n\n=== NOVO CONHECIMENTO ===")
	if strings.TrimSpace(name) != "" {
		parts = append(parts, "Nome: "+strings.TrimSpace(name))
	}
	if strings.TrimSpace(desc) != "" {
		parts = append(parts, "Descricao: "+strings.TrimSpace(desc))
	}
	if content != nil {
		if b, err := json.MarshalIndent(content, "", "  "); err == nil && len(b) > 0 {
			parts = append(parts, "Conteudo:\n"+string(b))
		}
	}
	return strings.Join(parts, "\n") + "\n"
}

func buildLegacyInstructionText(idx legacyIndex) string {
	var parts []string
	if strings.TrimSpace(idx.Fonte) != "" {
		parts = append(parts, "Fonte: "+strings.TrimSpace(idx.Fonte))
	}
	for _, c := range idx.Componentes {
		if strings.TrimSpace(c.Nome) != "" {
			parts = append(parts, "\nComponente: "+strings.TrimSpace(c.Nome))
		}
		if strings.TrimSpace(c.Descricao) != "" {
			parts = append(parts, "Descricao: "+strings.TrimSpace(c.Descricao))
		}
		if c.Conteudo != nil {
			if b, err := json.MarshalIndent(c.Conteudo, "", "  "); err == nil && len(b) > 0 {
				parts = append(parts, "Conteudo:\n"+string(b))
			}
		}
	}
	return truncateString(strings.Join(parts, "\n"), 12000)
}

func instructionContext() string {
	path := getRagIndexPath()
	if isTextIndex(path) {
		raw, err := os.ReadFile(path)
		if err != nil {
			return ""
		}
		return truncateString(string(raw), 12000)
	}
	idx, err := loadLegacyIndex(path)
	if err != nil {
		return ""
	}
	return buildLegacyInstructionText(idx)
}

func truncateString(s string, max int) string {
	if max <= 0 || len(s) <= max {
		return s
	}
	return s[:max] + "\n[truncated]"
}

func nowISO() string {
	return time.Now().Format(time.RFC3339)
}
