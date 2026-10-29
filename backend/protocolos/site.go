package protocolos

// Situação lida no site da ANEEL (Ouvidoria › Meus Registros › detalhe da solicitação).
// Quem lê é a extensão "SURE — Consulta ANEEL" no navegador do usuário, depois que ELE faz o login
// (o sistema não loga nem passa pela verificação anti-robô). A extensão manda o resultado para cá.

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"ressarcimento-backend/rotinas"

	"gorm.io/gorm"
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
	Endereco  string `json:"endereco"`   // campo "Endereço" do detalhe: costuma trazer empresa, UC e endereço
}

type ResultadoSite struct {
	Recebidos     int `json:"recebidos"`
	Atualizados   int `json:"atualizados"`
	Mudaram       int `json:"mudaram"`
	Concluidos    int `json:"concluidos"`
	Desconhecidos int `json:"desconhecidos"`
	Tarefas       int `json:"tarefas"`
	Vinculados    int `json:"vinculados"` // protocolos sem processo vinculados pela UC do campo Endereço
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

// AbertosNoSite lista os protocolos que ainda valem consultar (não concluídos no site, ou ainda sem
// processo — o detalhe traz a UC no campo Endereço, que vincula o processo);
// com todos=true, lista todos os ativos (para reler o texto completo das respostas).
func AbertosNoSite(todos bool) []string {
	var out []string
	if todos {
		gdb().Raw(`SELECT DISTINCT protocolo FROM FT_PROTOCOLOS_ANEEL WHERE ativo = 1 ORDER BY protocolo`).Scan(&out)
		return out
	}
	gdb().Raw(`SELECT DISTINCT protocolo FROM FT_PROTOCOLOS_ANEEL
		WHERE ativo = 1 AND (COALESCE(situacao,'') <> ? OR id_processo IS NULL) ORDER BY protocolo`, SitConcluidaSite).Scan(&out)
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
		if !temProcesso(db, num) && vincularPorEndereco(db, num, it.Endereco) {
			r.Vinculados++
		}
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

// reNumeroEndereco: números do campo Endereço do site ("JACESA -585359105940 - Presidente Dutra - (RJ)",
// "CLARO - UC 90569563 - ..."); pontos, traços e barras fazem parte do número.
var reNumeroEndereco = regexp.MustCompile(`\d[\d.\-/]*\d`)

// UCsDoEndereco devolve os números do Endereço que podem ser UC (só dígitos, sem zeros à esquerda, 6+ dígitos;
// CEP fica de fora).
func UCsDoEndereco(endereco string) []string {
	var out []string
	visto := map[string]bool{}
	semCEP := regexp.MustCompile(`(?i)CEP:?\s*[\d.\-]+`).ReplaceAllString(endereco, "")
	for _, m := range reNumeroEndereco.FindAllString(semCEP, -1) {
		d := strings.TrimLeft(regexp.MustCompile(`\D`).ReplaceAllString(m, ""), "0")
		if len(d) >= 6 && !visto[d] {
			visto[d] = true
			out = append(out, d)
		}
	}
	return out
}

// vincularPorEndereco: protocolo sem processo cujo Endereço no site traz a UC de um processo. Vincula (UC em mais
// de um processo → "confirmar", o admin decide) e, com um processo só, a tarefa vai para quem fez a última
// alteração no processo (pedido do Alisson, 29/10/2026). Ninguém → tarefa sem responsável (alguém assume no sininho).
func vincularPorEndereco(db *gorm.DB, num, endereco string) bool {
	var procs []int64
	for _, uc := range UCsDoEndereco(endereco) {
		var achados []int64
		_ = db.Raw(`SELECT DISTINCT p.id_processo FROM FT_PROCESSOS p JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
			WHERE TRIM(LEADING '0' FROM REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(r.uc,''),'.',''),'-',''),' ',''),'/','')) = ?
			   OR TRIM(LEADING '0' FROM REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(p.uc,''),'.',''),'-',''),' ',''),'/','')) = ?
			   OR TRIM(LEADING '0' FROM REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(p.uc_atual,''),'.',''),'-',''),' ',''),'/','')) = ?
			LIMIT 4`, uc, uc, uc).Scan(&achados).Error
		if len(achados) > 0 && len(achados) <= 3 { // UC em muitos processos não identifica nada
			procs = achados
			break
		}
	}
	if len(procs) == 0 {
		return false
	}
	agora := time.Now()
	for _, p := range procs {
		VincularSeNovo(db, num, p, "site", nil, 0, &agora)
	}
	alvo := fmt.Sprintf("processo #%d", procs[0])
	var resp *int64
	if len(procs) == 1 {
		resp = UltimoAlterador(db, procs[0])
	} else {
		alvo = fmt.Sprintf("processos %v (confirmar qual)", procs)
	}
	titulo := fmt.Sprintf("Protocolo ANEEL %s vinculado ao %s — conferir", Formatar(num), alvo)
	desc := fmt.Sprintf("Protocolo estava sem processo no SURE; vinculado pelo campo Endereço do site da ANEEL (%s). "+
		"Responsável: quem fez a última alteração no processo.", strings.TrimSpace(endereco))
	db.Exec(`INSERT INTO FT_TAREFAS (tipo, titulo, descricao, id_processo, protocolo_num, id_usuario_responsavel, direcionado_em)
		VALUES ('protocolo_vinculo', ?, ?, ?, ?, ?, IF(? IS NULL, NULL, NOW()))`, titulo, desc, procs[0], num, resp, resp)
	if resp != nil {
		db.Exec("UPDATE FT_PROTOCOLOS_ANEEL SET id_usuario_responsavel = ? WHERE protocolo_num = ? AND id_processo = ?", *resp, num, procs[0])
		rotinas.NotificarNoSistema(db, *resp, "Nova tarefa para você: "+titulo)
	}
	return true
}

// UltimoAlterador: quem fez a última alteração no processo — movimentação no histórico ou edição registrada em
// FT_AUDIT_EDICAO, a mais recente. Só usuário ativo de verdade ("sistema" não conta); nil se ninguém.
func UltimoAlterador(db *gorm.DB, idProcesso int64) *int64 {
	var id int64
	err := db.Raw(`SELECT x.id_usuario FROM (
			SELECT id_usuario_gestor AS id_usuario, data_movimentacao AS quando FROM FT_HISTORICO_MOVIMENTACOES
			 WHERE id_processo = ? AND id_usuario_gestor IS NOT NULL
			UNION ALL
			SELECT id_usuario, data_edicao FROM FT_AUDIT_EDICAO
			 WHERE entidade = 'FT_PROCESSOS' AND id_entidade = ? AND id_usuario IS NOT NULL
		) x JOIN DM_USUARIO u ON u.id_usuario = x.id_usuario AND u.usuario_ativo = 1 AND u.nome_usuario <> 'sistema'
		ORDER BY x.quando DESC LIMIT 1`, idProcesso, idProcesso).Row().Scan(&id)
	if err != nil || id <= 0 {
		return nil
	}
	return &id
}
