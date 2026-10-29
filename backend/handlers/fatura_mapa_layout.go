package handlers

// Resolve o arquivo de MAPA DE EXTRAÇÃO (o mesmo usado pelo pdf_pipeline em
// ia/map/) responsável pelo modelo de fatura de uma distribuidora e devolve seu
// conteúdo pra ser injetado no prompt do v19. Assim a IA interpreta os campos
// usando o vocabulário e as particularidades daquele layout específico.
//
// Fluxo: distribuidora (como está no banco) → MASTER_DISTRIBUIDORAS_INDEX.json
//        → arquivo de mapa + filial → conteúdo do mapa.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	mapaIndexCache map[string]any
	mapaIndexStat  time.Time
	mapaIndexMu    sync.RWMutex

	mapaFileCache   = map[string]string{}
	mapaFileCacheMu sync.RWMutex
)

// iaMapDir localiza o diretório ia/map a partir do cwd do backend.
func iaMapDir() string {
	cands := []string{
		filepath.Join("ia", "map"),
		filepath.Join("..", "ia", "map"),
		filepath.Join("..", "..", "ia", "map"),
	}
	for _, c := range cands {
		if st, err := os.Stat(c); err == nil && st.IsDir() {
			return c
		}
	}
	return filepath.Join("..", "ia", "map")
}

// carregaMasterIndex lê o MASTER_DISTRIBUIDORAS_INDEX.json (cache por mtime).
func carregaMasterIndex() map[string]any {
	path := filepath.Join(iaMapDir(), "MASTER_DISTRIBUIDORAS_INDEX.json")
	info, err := os.Stat(path)
	if err != nil {
		return nil
	}
	mapaIndexMu.RLock()
	if mapaIndexCache != nil && info.ModTime().Equal(mapaIndexStat) {
		c := mapaIndexCache
		mapaIndexMu.RUnlock()
		return c
	}
	mapaIndexMu.RUnlock()

	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var idx map[string]any
	if json.Unmarshal(b, &idx) != nil {
		return nil
	}
	mapaIndexMu.Lock()
	mapaIndexCache = idx
	mapaIndexStat = info.ModTime()
	mapaIndexMu.Unlock()
	return idx
}

// normNomeDist normaliza nome de distribuidora pra match tolerante (sem acento,
// sem pontuação, sem palavras societárias/genéricas).
func normNomeDist(s string) string {
	s = strings.ToUpper(s)
	acc := strings.NewReplacer(
		"Ã", "A", "Á", "A", "Â", "A", "À", "A",
		"É", "E", "Ê", "E", "Í", "I",
		"Ó", "O", "Ô", "O", "Õ", "O",
		"Ú", "U", "Ü", "U", "Ç", "C",
	)
	s = acc.Replace(s)
	for _, ch := range []string{".", ",", "-", "/", "(", ")", "'", "\""} {
		s = strings.ReplaceAll(s, ch, " ")
	}
	stop := map[string]bool{
		"SA": true, "S": true, "A": true, "LTDA": true, "SA.": true,
		"DISTRIBUICAO": true, "DISTRIBUIDORA": true, "ENERGIA": true,
		"ELETRICA": true, "DE": true, "DO": true, "DA": true,
	}
	out := []string{}
	for _, f := range strings.Fields(s) {
		if stop[f] {
			continue
		}
		out = append(out, f)
	}
	return strings.Join(out, " ")
}

type mapaLayoutInfo struct {
	Distribuidora string `json:"distribuidora"`
	MatchNome     string `json:"match_nome"`
	Mapa          string `json:"mapa"`
	Filial        string `json:"filial"`
	Encontrado    bool   `json:"encontrado"`
	Ambiguo       bool   `json:"ambiguo"`     // >1 candidato casou no match aproximado
	Candidatos    int    `json:"candidatos"`  // quantos nomes casaram
	TipoMatch     string `json:"tipo_match"`  // "exato" | "aproximado"
}

// tokensSet devolve o conjunto de tokens de um nome já normalizado.
func tokensSet(s string) map[string]bool {
	m := map[string]bool{}
	for _, t := range strings.Fields(s) {
		m[t] = true
	}
	return m
}

// overlapTokens conta tokens em comum entre dois nomes normalizados.
func overlapTokens(a, b string) int {
	sa := tokensSet(a)
	n := 0
	for t := range tokensSet(b) {
		if sa[t] {
			n++
		}
	}
	return n
}

// resolverMapaLayout: nome da distribuidora → conteúdo do mapa + metadados.
// Retorna "" se não achou (o v19 segue rodando normalmente sem o mapa).
func resolverMapaLayout(distribuidora string) (string, mapaLayoutInfo) {
	info := mapaLayoutInfo{Distribuidora: distribuidora}
	dist := strings.TrimSpace(distribuidora)
	if dist == "" {
		return "", info
	}
	idx := carregaMasterIndex()
	if idx == nil {
		return "", info
	}
	tabela, _ := idx["indice_por_nome_banco"].(map[string]any)
	if tabela == nil {
		return "", info
	}

	// Chaves ordenadas → iteração determinística (map em Go é aleatório).
	nomes := make([]string, 0, len(tabela))
	for nome := range tabela {
		nomes = append(nomes, nome)
	}
	sort.Strings(nomes)

	var entry map[string]any
	var matchNome string

	// 1) match exato (case-insensitive)
	for _, nome := range nomes {
		if strings.EqualFold(strings.TrimSpace(nome), dist) {
			entry, _ = tabela[nome].(map[string]any)
			matchNome = nome
			info.TipoMatch = "exato"
			break
		}
	}

	// 2) match aproximado DETERMINÍSTICO: coleta TODOS os candidatos (igual ou
	//    contido nos dois sentidos) e escolhe o de maior sobreposição de tokens;
	//    empate desfaz por ordem alfabética (nomes já ordenados). Antes o código
	//    parava no primeiro match de um `range` aleatório → filial errada.
	if entry == nil {
		nd := normNomeDist(dist)
		if nd != "" {
			bestScore := -1
			cands := 0
			for _, nome := range nomes {
				nn := normNomeDist(nome)
				if nn == "" {
					continue
				}
				if nn == nd || strings.Contains(nn, nd) || strings.Contains(nd, nn) {
					cands++
					sc := overlapTokens(nn, nd)
					if sc > bestScore {
						bestScore = sc
						matchNome = nome
						entry, _ = tabela[nome].(map[string]any)
					}
				}
			}
			info.Candidatos = cands
			info.Ambiguo = cands > 1
			if entry != nil {
				info.TipoMatch = "aproximado"
			}
		}
	}
	if entry == nil {
		return "", info
	}

	mapaFile, _ := entry["mapa"].(string)
	registry, _ := entry["registry"].(string)
	info.MatchNome = matchNome
	if f, ok := entry["filial"].(string); ok {
		info.Filial = f
	}

	// Tenta o mapa; se estiver ausente/vazio (algumas dists usam só o
	// FAMILY_REGISTRY), cai pro registry.
	conteudo := ""
	if mapaFile != "" {
		conteudo = carregaMapaArquivo(mapaFile)
		if conteudo != "" {
			info.Mapa = mapaFile
		}
	}
	if conteudo == "" && registry != "" {
		conteudo = carregaMapaArquivo(registry)
		if conteudo != "" {
			info.Mapa = registry
		}
	}
	if conteudo == "" {
		return "", info
	}
	info.Encontrado = true
	return conteudo, info
}

func carregaMapaArquivo(nome string) string {
	// evita path traversal — só o basename
	nome = filepath.Base(nome)
	mapaFileCacheMu.RLock()
	if c, ok := mapaFileCache[nome]; ok {
		mapaFileCacheMu.RUnlock()
		return c
	}
	mapaFileCacheMu.RUnlock()

	b, err := os.ReadFile(filepath.Join(iaMapDir(), nome))
	if err != nil {
		return ""
	}
	s := string(b)
	mapaFileCacheMu.Lock()
	mapaFileCache[nome] = s
	mapaFileCacheMu.Unlock()
	return s
}
