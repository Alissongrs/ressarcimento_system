package protocolos

// Situação lida no site da ANEEL (Ouvidoria › Meus Registros › detalhe da solicitação).
// Quem lê é a extensão "SURE — Consulta ANEEL" no navegador do usuário, depois que ELE faz o login
// (o sistema não loga nem passa pela verificação anti-robô). A extensão manda o resultado para cá.

import (
	"fmt"
	"strings"
	"time"
)

const (
	SitConcluidaSite     = "Concluída na ANEEL"
	SitAnaliseDistribuid = "Em análise na concessionária"
	SitAnaliseANEEL      = "Em análise na ANEEL"
)

// rótulos do SURE para o status mostrado no site
var rotuloSite = map[string]string{
	"CONCLUÍDA":                    SitConcluidaSite,
	"EM ANÁLISE NA CONCESSIONÁRIA": SitAnaliseDistribuid,
	"EM ANÁLISE NA AGÊNCIA":        SitAnaliseANEEL,
	"SOLICITAÇÃO REGISTRADA":       SitRegistrado,
}

// ItemSite é um protocolo lido no site.
type ItemSite struct {
	Protocolo string `json:"protocolo"`
	Status    string `json:"status"`     // como aparece no site, ex. "CONCLUÍDA"
	UltimaMov string `json:"ultima_mov"` // dd/mm/aaaa da última linha do histórico
	Entrada   string `json:"entrada"`    // dd/mm/aaaa
	Resposta  string `json:"resposta"`   // trecho da resposta ao consumidor
}

type ResultadoSite struct {
	Recebidos     int `json:"recebidos"`
	Atualizados   int `json:"atualizados"`
	Mudaram       int `json:"mudaram"`
	Concluidos    int `json:"concluidos"`
	Desconhecidos int `json:"desconhecidos"`
	Tarefas       int `json:"tarefas"`
}

// RotuloSite converte o status do site no rótulo do SURE.
func RotuloSite(status string) string {
	s := strings.ToUpper(strings.TrimSpace(status))
	if r, ok := rotuloSite[s]; ok {
		return r
	}
	if s == "" {
		return ""
	}
	return strings.ToUpper(s[:1]) + strings.ToLower(s[1:])
}

// AbertosNoSite lista os protocolos que ainda valem consultar (não concluídos no site);
// com todos=true, lista todos os ativos (para reler o texto completo das respostas).
func AbertosNoSite(todos bool) []string {
	var out []string
	if todos {
		gdb().Raw(`SELECT DISTINCT protocolo FROM FT_PROTOCOLOS_ANEEL WHERE ativo = 1 ORDER BY protocolo`).Scan(&out)
		return out
	}
	gdb().Raw(`SELECT DISTINCT protocolo FROM FT_PROTOCOLOS_ANEEL
		WHERE ativo = 1 AND COALESCE(situacao,'') <> ? ORDER BY protocolo`, SitConcluidaSite).Scan(&out)
	return out
}

// ImportarSite grava a situação lida no site. Mudança vira evento (fonte 'site'); conclusão recente
// (últimas 72h) vira tarefa + aviso, como a resposta por e-mail. Situação antiga só é registrada.
func ImportarSite(itens []ItemSite) ResultadoSite {
	db := gdb()
	r := ResultadoSite{Recebidos: len(itens)}
	mu.Lock()
	defer mu.Unlock()
	for _, it := range itens {
		nums := Extrair(it.Protocolo)
		sit := RotuloSite(it.Status)
		if len(nums) == 0 || sit == "" {
			continue
		}
		num := nums[0]
		quando, err := time.ParseInLocation("02/01/2006", firstNonEmpty(it.UltimaMov, it.Entrada), time.Local)
		if err != nil {
			quando = time.Now()
		}
		linhas := linhasDo(db, num)
		if len(linhas) == 0 {
			r.Desconhecidos++
			continue
		}
		andamento := strings.TrimSpace(fmt.Sprintf("Site da ANEEL: %s.\n\n%s", it.Status, it.Resposta))
		if len([]rune(andamento)) > 20000 {
			andamento = string([]rune(andamento)[:20000])
		}
		anterior := linhas[0].situacao
		var idEvento int64
		if anterior != sit {
			r.Mudaram++
			db.Exec(`INSERT INTO FT_PROTOCOLO_EVENTOS (protocolo_num, fonte, situacao_anterior, situacao_nova, andamento, id_mail_message, ocorrido_em)
				VALUES (?, 'site', ?, ?, ?, NULL, ?)`, num, nullSe(anterior), sit, andamento, quando)
			_ = db.Raw(`SELECT id FROM FT_PROTOCOLO_EVENTOS WHERE protocolo_num = ? AND fonte = 'site' ORDER BY id DESC LIMIT 1`, num).Row().Scan(&idEvento)
		}
		res := db.Exec(`UPDATE FT_PROTOCOLOS_ANEEL SET situacao = ?, ultimo_andamento = ?, ultima_mudanca_em = ?,
			ultima_fonte = 'site', ultima_verificacao_em = NOW() WHERE protocolo_num = ? AND ativo = 1`, sit, andamento, quando, num)
		r.Atualizados += int(res.RowsAffected)
		if sit != SitConcluidaSite || anterior == sit {
			continue
		}
		r.Concluidos++
		if time.Since(quando) > 72*time.Hour {
			continue // conclusão antiga: só registra
		}
		for _, l := range linhas {
			if tarefaDaMudanca(db, "resposta", num, l, 0) {
				r.Tarefas++
			}
		}
	}
	return r
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}
