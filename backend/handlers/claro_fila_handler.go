package handlers

// Fila dos lotes (zips) da Claro NA VPS — substitui o receptor local do PC (ferramentas/claro_pdp/recv_claro.py).
//
// A extensão do SURE entra no portal PDP, pega o link de cada zip novo e manda para cá; o próprio servidor baixa o
// zip (600–800 MB) direto do Azure, sem passar pelo computador de quem clicou. Se o Azure recusar o download vindo
// do servidor, a extensão baixa no navegador e envia em partes (rota /parte). O zip pronto ganha um <zip>.rdy e o
// worker/job_claro.sh (cron do host) extrai para o banco (backend/claro/processar.py), sobe os PDFs para o Google
// Drive (rclone) e grava os links. Pasta: CLARO_FILA_DIR (/app/claro_fila = worker/claro_fila no host).

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

var (
	reNomeZipClaro = regexp.MustCompile(`^[\w.\-]+_(\d{6,})\.zip$`)
	reSeqClaro     = regexp.MustCompile(`^\d{6,}$`)
	claroDL        = struct {
		sync.Mutex
		m map[string]*claroDownload
	}{m: map[string]*claroDownload{}}
	claroParteMu sync.Mutex
)

type claroDownload struct {
	Nome   string `json:"nome"`
	Status string `json:"status"` // baixando | pronto | erro
	Bytes  int64  `json:"bytes"`
	Total  int64  `json:"total"`
	Erro   string `json:"erro,omitempty"`
	Inicio string `json:"inicio"`
}

func claroFilaDir() string {
	if d := strings.TrimSpace(os.Getenv("CLARO_FILA_DIR")); d != "" {
		return d
	}
	return "/app/claro_fila"
}

// a pasta vem do host (bind mount); o worker do host também escreve nela
func claroGarantirDir() (string, error) {
	d := claroFilaDir()
	if err := os.MkdirAll(d, 0o777); err != nil {
		return d, err
	}
	return d, nil
}

func claroNomeValido(nome string) bool {
	return len(nome) <= 160 && reNomeZipClaro.MatchString(nome)
}

// só links do armazenamento do portal (Azure Blob) ou do próprio portal — o servidor não baixa de qualquer lugar
func claroURLPermitida(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil {
		return false
	}
	h := strings.ToLower(u.Hostname())
	return strings.HasSuffix(h, ".blob.core.windows.net") || h == "clarobps-pdp.azurewebsites.net" || h == "pdp.clarobpo.com"
}

func claroSeqs(dir string, filtro func(string) bool) []string {
	ents, _ := os.ReadDir(dir)
	out := []string{}
	for _, e := range ents {
		if filtro(e.Name()) {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out
}

// GET /api/v1/claro-pdp/fila → {pending, freeGB, feitos_total, fila, ultimo, baixando, worker, log}
func ClaroFilaEstado(c *gin.Context) {
	dir, err := claroGarantirDir()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "pasta da fila da Claro indisponível no servidor: " + err.Error()})
		return
	}
	feitos := claroSeqs(filepath.Join(dir, "done"), func(n string) bool { return reSeqClaro.MatchString(n) })
	ultimo := ""
	if len(feitos) > 0 {
		ultimo = feitos[len(feitos)-1]
	}
	// marco do que o PC já tinha processado antes da migração (C:\claro_bf\done) — arquivo versionado no Git
	if b, err := os.ReadFile(filepath.Join(dir, "ultimo_inicial.txt")); err == nil {
		if s := strings.TrimSpace(string(b)); reSeqClaro.MatchString(s) && (ultimo == "" || claroSeqMaior(s, ultimo)) {
			ultimo = s
		}
	}
	fila := map[string]bool{}
	pend := 0
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		n := e.Name()
		base := strings.TrimSuffix(strings.TrimSuffix(n, ".part"), ".rdy")
		base = strings.TrimSuffix(base, ".rdy.busy")
		if m := reNomeZipClaro.FindStringSubmatch(base); m != nil {
			fila[m[1]] = true
			if strings.HasSuffix(n, ".zip.rdy") || strings.HasSuffix(n, ".zip.rdy.busy") {
				pend++
			}
		}
	}
	// lotes já extraídos esperando o Drive (ex/<seq>.json)
	for _, n := range claroSeqs(filepath.Join(dir, "ex"), func(n string) bool { return strings.HasSuffix(n, ".json") }) {
		s := strings.TrimSuffix(n, ".json")
		if reSeqClaro.MatchString(s) {
			fila[s] = true
			pend++
		}
	}
	filaL := make([]string, 0, len(fila))
	for s := range fila {
		filaL = append(filaL, s)
	}
	sort.Strings(filaL)

	claroDL.Lock()
	baixando := []claroDownload{}
	for _, d := range claroDL.m {
		if d.Status == "baixando" {
			baixando = append(baixando, *d)
		}
	}
	claroDL.Unlock()

	// o worker do host grava a hora de cada rodada; sem isso há minutos, o cron não está rodando
	worker := gin.H{"ativo": false}
	if st, err := os.Stat(filepath.Join(dir, "worker_vivo")); err == nil {
		b, _ := os.ReadFile(filepath.Join(dir, "worker_vivo"))
		worker = gin.H{"ativo": time.Since(st.ModTime()) < 5*time.Minute, "visto_em": st.ModTime().Format(time.RFC3339),
			"aviso": strings.TrimSpace(string(b))}
	}
	c.JSON(http.StatusOK, gin.H{
		"pending": pend, "freeGB": claroLivreGB(dir), "feitos_total": len(feitos), "fila": filaL,
		"ultimo": ultimo, "baixando": baixando, "worker": worker, "log": claroLogFinal(filepath.Join(dir, "claro.log"), 12),
	})
}

func claroSeqMaior(a, b string) bool {
	x, e1 := strconv.ParseUint(a, 10, 64)
	y, e2 := strconv.ParseUint(b, 10, 64)
	if e1 != nil || e2 != nil {
		return a > b
	}
	return x > y
}

func claroLogFinal(p string, n int) []string {
	f, err := os.Open(p)
	if err != nil {
		return []string{}
	}
	defer f.Close()
	st, _ := f.Stat()
	off := st.Size() - 16*1024
	if off < 0 {
		off = 0
	}
	_, _ = f.Seek(off, io.SeekStart)
	b, _ := io.ReadAll(f)
	ls := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if off > 0 && len(ls) > 0 {
		ls = ls[1:] // 1ª linha pode estar cortada
	}
	if len(ls) > n {
		ls = ls[len(ls)-n:]
	}
	return ls
}

// POST /api/v1/claro-pdp/fila/link {nome, url} → o servidor baixa o zip em segundo plano
func ClaroFilaLink(c *gin.Context) {
	var in struct {
		Nome string `json:"nome"`
		URL  string `json:"url"`
	}
	if err := c.ShouldBindJSON(&in); err != nil || !claroNomeValido(in.Nome) || !claroURLPermitida(in.URL) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "nome do zip ou link inválido"})
		return
	}
	dir, err := claroGarantirDir()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "pasta da fila indisponível: " + err.Error()})
		return
	}
	if livre := claroLivreGB(dir); livre >= 0 && livre < 4 {
		c.JSON(http.StatusInsufficientStorage, gin.H{"error": fmt.Sprintf("pouco espaço em disco no servidor (%.1f GB livres; precisa de 4 GB)", livre)})
		return
	}
	claroDL.Lock()
	if d, ok := claroDL.m[in.Nome]; ok && d.Status == "baixando" {
		cp := *d
		claroDL.Unlock()
		c.JSON(http.StatusOK, cp)
		return
	}
	d := &claroDownload{Nome: in.Nome, Status: "baixando", Inicio: time.Now().Format(time.RFC3339)}
	claroDL.m[in.Nome] = d
	claroDL.Unlock()
	go claroBaixar(dir, d, in.URL)
	c.JSON(http.StatusAccepted, *d)
}

func claroBaixar(dir string, d *claroDownload, link string) {
	falhar := func(err error) {
		claroDL.Lock()
		d.Status, d.Erro = "erro", err.Error()
		claroDL.Unlock()
		_ = os.Remove(filepath.Join(dir, d.Nome+".part"))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Hour)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	cli := &http.Client{CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) > 3 || !claroURLPermitida(r.URL.String()) {
			return errors.New("redirecionamento não permitido")
		}
		return nil
	}}
	resp, err := cli.Do(req)
	if err != nil {
		falhar(fmt.Errorf("o servidor não conseguiu baixar: %v", err))
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		falhar(fmt.Errorf("o Azure respondeu %d ao servidor", resp.StatusCode))
		return
	}
	claroDL.Lock()
	d.Total = resp.ContentLength
	claroDL.Unlock()
	part := filepath.Join(dir, d.Nome+".part")
	f, err := os.OpenFile(part, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o666)
	if err != nil {
		falhar(err)
		return
	}
	buf := make([]byte, 1<<20)
	var n int64
	for {
		k, rerr := resp.Body.Read(buf)
		if k > 0 {
			if _, werr := f.Write(buf[:k]); werr != nil {
				f.Close()
				falhar(fmt.Errorf("erro gravando no disco do servidor: %v", werr))
				return
			}
			n += int64(k)
			claroDL.Lock()
			d.Bytes = n
			claroDL.Unlock()
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			falhar(fmt.Errorf("download interrompido: %v", rerr))
			return
		}
	}
	if err := f.Close(); err != nil {
		falhar(err)
		return
	}
	if resp.ContentLength > 0 && n != resp.ContentLength {
		falhar(fmt.Errorf("arquivo incompleto (%d de %d bytes)", n, resp.ContentLength))
		return
	}
	if err := claroMarcarPronto(dir, d.Nome, part, n); err != nil {
		falhar(err)
		return
	}
	claroDL.Lock()
	d.Status = "pronto"
	claroDL.Unlock()
}

func claroMarcarPronto(dir, nome, part string, tam int64) error {
	final := filepath.Join(dir, nome)
	if err := os.Rename(part, final); err != nil {
		return err
	}
	_ = os.Chmod(final, 0o666)
	if err := os.WriteFile(final+".rdy", []byte(strconv.FormatInt(tam, 10)), 0o666); err != nil {
		return err
	}
	_ = os.Chmod(final+".rdy", 0o666)
	return nil
}

// GET /api/v1/claro-pdp/fila/arquivo?f=<zip> → situação do download pelo servidor
func ClaroFilaArquivo(c *gin.Context) {
	nome := c.Query("f")
	if !claroNomeValido(nome) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "nome inválido"})
		return
	}
	claroDL.Lock()
	d, ok := claroDL.m[nome]
	var cp claroDownload
	if ok {
		cp = *d
	}
	claroDL.Unlock()
	if ok {
		c.JSON(http.StatusOK, cp)
		return
	}
	// reinício do backend no meio: olha o disco
	dir := claroFilaDir()
	if _, err := os.Stat(filepath.Join(dir, nome+".rdy")); err == nil {
		c.JSON(http.StatusOK, claroDownload{Nome: nome, Status: "pronto"})
		return
	}
	c.JSON(http.StatusOK, claroDownload{Nome: nome, Status: "desconhecido"})
}

// POST /api/v1/claro-pdp/fila/parte?f=<zip>&mode=start|done (sem mode = acrescenta o corpo) — reserva: a extensão
// baixa no navegador e manda em partes de até 8 MB (mesmo protocolo do recv_claro.py). Responde o tamanho no disco.
func ClaroFilaParte(c *gin.Context) {
	nome := c.Query("f")
	if !claroNomeValido(nome) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "nome inválido"})
		return
	}
	dir, err := claroGarantirDir()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	part := filepath.Join(dir, nome+".part")
	claroParteMu.Lock()
	defer claroParteMu.Unlock()
	switch c.Query("mode") {
	case "start":
		if livre := claroLivreGB(dir); livre >= 0 && livre < 4 {
			c.JSON(http.StatusInsufficientStorage, gin.H{"error": fmt.Sprintf("pouco espaço em disco no servidor (%.1f GB livres)", livre)})
			return
		}
		if err := os.WriteFile(part, nil, 0o666); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	case "done":
		st, err := os.Stat(part)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "envio não iniciado"})
			return
		}
		if exp := c.Query("total"); exp != "" && exp != strconv.FormatInt(st.Size(), 10) {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("arquivo incompleto (%d bytes no servidor, esperado %s)", st.Size(), exp)})
			return
		}
		if err := claroMarcarPronto(dir, nome, part, st.Size()); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"tamanho": st.Size()})
		return
	default:
		f, err := os.OpenFile(part, os.O_APPEND|os.O_WRONLY, 0o666)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "envio não iniciado"})
			return
		}
		_, err = io.Copy(f, http.MaxBytesReader(c.Writer, c.Request.Body, 16<<20))
		cerr := f.Close()
		if err != nil || cerr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "parte não gravada"})
			return
		}
	}
	tam := int64(-1)
	if st, err := os.Stat(part); err == nil {
		tam = st.Size()
	}
	c.JSON(http.StatusOK, gin.H{"tamanho": tam})
}
