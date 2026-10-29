package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
	"ressarcimento-backend/services"
)

// ─── Saudação da SURE (1ª conversa do dia) ───────────────────────────────────
// GET /api/v1/chat/saudacao?lat=..&lon=..
// "Bom dia/Boa tarde/Boa noite, {primeiro nome}!" + data, horário e temperatura (pela
// localização do navegador; sem ela, Sorocaba — cidade da AME Energia). Para quem cuida
// de SR (env SAUDACAO_PRAZOS_EMAILS; padrão: a Eliane) inclui o resumo da página Prazos:
// concessionárias com prazo vencendo/vencido, as que estão sem retorno (SR) e a
// recomendação de cobrança do dia. A IA só redige; os números vêm do banco.

const (
	sorocabaLat = -23.5015
	sorocabaLon = -47.4526
)

var diasSemana = []string{"domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"}
var mesesExtenso = []string{"", "janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"}

func primeiroNome(nome string) string {
	f := strings.Fields(strings.TrimSpace(nome))
	if len(f) == 0 {
		return ""
	}
	return f[0]
}

// clima atual (Open-Meteo, sem chave) + nome da cidade (BigDataCloud, sem chave)
func climaAgora(ctx context.Context, lat, lon float64, temCoord bool) (temp float64, cidade string, ok bool) {
	cli := &http.Client{Timeout: 5 * time.Second}
	u := fmt.Sprintf("https://api.open-meteo.com/v1/forecast?latitude=%.4f&longitude=%.4f&current=temperature_2m&timezone=America%%2FSao_Paulo", lat, lon)
	req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
	if resp, err := cli.Do(req); err == nil {
		defer resp.Body.Close()
		var r struct {
			Current struct {
				T float64 `json:"temperature_2m"`
			} `json:"current"`
		}
		if json.NewDecoder(resp.Body).Decode(&r) == nil && resp.StatusCode == 200 {
			temp, ok = r.Current.T, true
		}
	}
	cidade = "Sorocaba"
	if temCoord {
		cidade = ""
		u2 := fmt.Sprintf("https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=%.4f&longitude=%.4f&localityLanguage=pt", lat, lon)
		req2, _ := http.NewRequestWithContext(ctx, "GET", u2, nil)
		if resp, err := cli.Do(req2); err == nil {
			defer resp.Body.Close()
			var g struct {
				City     string `json:"city"`
				Locality string `json:"locality"`
			}
			if json.NewDecoder(resp.Body).Decode(&g) == nil {
				cidade = g.City
				if cidade == "" {
					cidade = g.Locality
				}
			}
		}
	}
	return
}

func recebeResumoPrazos(email string) bool {
	lista := os.Getenv("SAUDACAO_PRAZOS_EMAILS")
	if strings.TrimSpace(lista) == "" {
		lista = "eliane.araujo@amee.com.br"
	}
	email = strings.ToLower(strings.TrimSpace(email))
	for _, e := range strings.Split(lista, ",") {
		if email != "" && email == strings.ToLower(strings.TrimSpace(e)) {
			return true
		}
	}
	return false
}

// resumoPrazosSR: números da página Prazos + SR por concessionária (texto p/ a IA redigir).
func resumoPrazosSR() string {
	ps, err := services.CalcularProcessosComPrazo([]int{2, 3})
	if err != nil {
		return ""
	}
	type agg struct{ vencidos, hoje, amanha, total int }
	por := map[string]*agg{}
	for _, p := range ps {
		if !p.TemRegra {
			continue
		}
		k := strings.TrimSpace(p.Concessionaria)
		if k == "" {
			k = "(sem concessionária)"
		}
		a := por[k]
		if a == nil {
			a = &agg{}
			por[k] = a
		}
		a.total++
		switch {
		case p.Atrasado:
			a.vencidos++
		case p.DiasRestantes <= 0:
			a.hoje++
		case p.DiasRestantes == 1:
			a.amanha++
		}
	}
	nomes := make([]string, 0, len(por))
	for k := range por {
		nomes = append(nomes, k)
	}
	sort.Slice(nomes, func(i, j int) bool {
		a, b := por[nomes[i]], por[nomes[j]]
		return a.hoje*1000+a.amanha*100+a.vencidos > b.hoje*1000+b.amanha*100+b.vencidos
	})
	var sb strings.Builder
	sb.WriteString("PRAZOS (processos aguardando ação/retorno, por concessionária — vencem HOJE / AMANHÃ / já VENCIDOS):\n")
	tot := [3]int{}
	for i, k := range nomes {
		a := por[k]
		tot[0] += a.hoje
		tot[1] += a.amanha
		tot[2] += a.vencidos
		if i < 8 && (a.hoje+a.amanha+a.vencidos) > 0 {
			sb.WriteString(fmt.Sprintf("- %s: vencem hoje %d, amanhã %d, vencidos %d\n", k, a.hoje, a.amanha, a.vencidos))
		}
	}
	sb.WriteString(fmt.Sprintf("TOTAL: vencem hoje %d, amanhã %d, vencidos %d\n", tot[0], tot[1], tot[2]))

	// SR: processos vencidos cuja distribuidora não respondeu ao último e-mail (cache do modal de cobrança)
	rows, err := database.DB_App.Query(`
SELECT COALESCE(p.concessionaria,'?'), COUNT(*), MAX(c.dias_sem_retorno)
  FROM PROCESSO_COBRANCA_CACHE c JOIN FT_PROCESSOS p ON p.id_processo = c.id_processo
 WHERE c.status='ready' AND c.sem_retorno=1
 GROUP BY p.concessionaria ORDER BY COUNT(*) DESC LIMIT 6`)
	if err == nil {
		defer rows.Close()
		first := true
		for rows.Next() {
			var conc string
			var n, dias int
			if rows.Scan(&conc, &n, &dias) == nil {
				if first {
					sb.WriteString("SEM RETORNO (SR) — distribuidora não respondeu ao último e-mail:\n")
					first = false
				}
				if dias > 0 {
					sb.WriteString(fmt.Sprintf("- %s: %d processo(s) sem retorno (o mais antigo há %d dias)\n", conc, n, dias))
				} else {
					sb.WriteString(fmt.Sprintf("- %s: %d processo(s) sem retorno\n", conc, n))
				}
			}
		}
	}
	return sb.String()
}

// ChatSaudacao — GET /api/v1/chat/saudacao
func ChatSaudacao(c *gin.Context) {
	uid, uname := usuarioIA(c)
	var email, nomeDB string
	if uid > 0 && database.DB_App != nil {
		_ = database.DB_App.QueryRow(`SELECT COALESCE(email,''), COALESCE(nome_usuario,'') FROM DM_USUARIO WHERE id_usuario=?`, uid).Scan(&email, &nomeDB)
	}
	nome := primeiroNome(uname)
	if nome == "" {
		nome = primeiroNome(nomeDB)
	}

	loc := time.FixedZone("BRT", -3*3600)
	agora := time.Now().In(loc)
	periodo := "Bom dia"
	if h := agora.Hour(); h >= 18 || h < 5 {
		periodo = "Boa noite"
	} else if h >= 12 {
		periodo = "Boa tarde"
	}
	data := fmt.Sprintf("%s, %d de %s", diasSemana[agora.Weekday()], agora.Day(), mesesExtenso[agora.Month()])
	hora := agora.Format("15:04")

	lat, errLat := strconv.ParseFloat(c.Query("lat"), 64)
	lon, errLon := strconv.ParseFloat(c.Query("lon"), 64)
	temCoord := errLat == nil && errLon == nil && lat != 0 && lon != 0
	if !temCoord {
		lat, lon = sorocabaLat, sorocabaLon
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 25*time.Second)
	defer cancel()
	temp, cidade, okClima := climaAgora(ctx, lat, lon, temCoord)

	clima := ""
	if okClima {
		if cidade != "" {
			clima = fmt.Sprintf("%.0f °C em %s", temp, cidade)
		} else {
			clima = fmt.Sprintf("%.0f °C", temp)
		}
	}
	cumprimento := periodo
	if nome != "" {
		cumprimento += ", " + nome
	}
	// texto-base (usado se a IA falhar)
	base := fmt.Sprintf("%s! Hoje é %s, %s.", cumprimento, data, hora)
	if clima != "" {
		base += " Agora faz " + clima + "."
	}

	resumo := ""
	if recebeResumoPrazos(email) {
		resumo = resumoPrazosSR()
	}
	if resumo == "" {
		c.JSON(http.StatusOK, gin.H{"texto": base + " Como posso te ajudar hoje?" + fechoEspecial(email, periodo), "resumo": false})
		return
	}

	sys := `Você é a SURE, assistente do sistema de ressarcimento de energia. Escreva a SAUDAÇÃO do primeiro
contato do dia, que será LIDA EM VOZ ALTA: português do Brasil, natural, calorosa e objetiva, frases curtas,
sem markdown, sem listas, sem emojis. Máximo de 110 palavras.
Estrutura: 1) cumprimento com o primeiro nome + data + horário + temperatura (use exatamente os dados dados);
2) resumo dos prazos: destaque as concessionárias com processos vencendo HOJE (e amanhã), peça atenção a elas;
3) SR: cite a(s) concessionária(s) que estão sem responder e recomende aguardar até o fim do dia e, sem
resposta, enviar a cobrança de retorno (SR); 4) termine perguntando como pode ajudar.
Use só os números fornecidos; não invente.`
	user := fmt.Sprintf("Cumprimento: %s\nData: %s\nHorário: %s\nTemperatura: %s\n\n%s", cumprimento, data, hora, clima, resumo)
	texto, err := callAisureOpenAI(ctx, nil, user, "", sys)
	if err != nil || strings.TrimSpace(texto) == "" {
		texto = base + " Dei uma olhada nos prazos: há processos vencendo e concessionárias sem retorno — vale conferir a página Prazos. Como posso te ajudar hoje?"
	}
	c.JSON(http.StatusOK, gin.H{"texto": strings.TrimSpace(texto) + fechoEspecial(email, periodo), "resumo": true})
}

// fechoEspecial: frase personalizada no FIM da saudação de algumas pessoas (varia a cada dia).
// Eduardo Navarro: "Bom dia, Eduardo, bem-vindo à Skynet." / "Bom dia, Navarrex." (período do dia).
func fechoEspecial(email, periodo string) string {
	switch strings.ToLower(strings.TrimSpace(email)) {
	case "eduardo.navarro@amee.com.br":
		opcoes := []string{
			periodo + ", Eduardo, bem-vindo à Skynet.",
			periodo + ", Navarrex.",
			periodo + ", Navarrex! Bem-vindo à Skynet.",
		}
		return " " + opcoes[rand.Intn(len(opcoes))]
	}
	return ""
}
