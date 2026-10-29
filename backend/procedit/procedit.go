// Package procedit é o núcleo compartilhado do mix A+B das "Solicitações ao
// sistema": interpreta um pedido em texto livre (B) numa AÇÃO ESTRUTURADA sobre
// um PROCESSO, que depois é aplicada de forma determinística e segura (A).
//
// É usado em dois lugares:
//   - handlers (no momento do chat): Montar() traduz o texto, lê os valores
//     atuais e devolve a ação + um preview "antes → depois" p/ o usuário aprovar.
//   - cmd/executor_solicitacoes (na execução): lê a ação já estruturada (JSON
//     armazenado) e aplica. Não re-interpreta texto → "aprovou = feito".
//
// LIMITADOR: só campos de PROCESSO entram na whitelist (CamposPermitidos). Campos
// de workflow (status/etapa/instância) e irregularidade (FK) ficam de fora de
// propósito → caem em revisão manual.
package procedit

import (
	"database/sql"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Alt é uma alteração concreta a aplicar: tabela/coluna/pk + valor (texto) + o
// valor anterior e um preview legível. ValorTxt é o canônico p/ gravar (decimal
// "40000.00", data "2006-01-02", texto cru) — o executor converte conforme Tipo.
type Alt struct {
	Tabela   string `json:"tabela"`
	Coluna   string `json:"coluna"`
	Tipo     string `json:"tipo"` // decimal | date | texto
	PkColuna string `json:"pk_coluna"`
	PkValor  string `json:"pk_valor"`
	ValorTxt string `json:"valor"`
	Antes    string `json:"antes"`
	Preview  string `json:"preview"`
}

// MovSpec é a especificação de uma movimentação de etapa (op "movimentar"). Os
// ids seguem DM_ETAPAS/DM_STATUS_PROCESSO/DM_STATUS_APROVACAO. O executor passa
// isto para v2.MovimentarCore (mesmo caminho do Kanban → grava no histórico).
type MovSpec struct {
	EtapaID     int    `json:"etapa_id"`
	EtapaNome   string `json:"etapa_nome"`
	StatusID    int    `json:"status_id"`
	InstanciaID *int   `json:"instancia_id"`
	AprovacaoID *int   `json:"aprovacao_id"`
	DePara      string `json:"de_para"`
	// estado do processo no momento da prévia — se mudar até a execução, o executor
	// não aplica (manda p/ revisão) para não sobrescrever uma movimentação feita depois.
	EtapaAntes     int  `json:"etapa_antes"`
	InstanciaAntes *int `json:"instancia_antes"`
	StatusAntes    *int `json:"status_antes"`
	AprovacaoAntes *int `json:"aprovacao_antes"`
}

// montarMov resolve a movimentação contra o estado ATUAL do processo: o que o pedido
// não disse mantém o valor atual; valida a transição (mesma regra do Kanban) e monta
// a prévia "de → para" para o usuário/aprovador conferirem.
func montarMov(db *sql.DB, p plano, idProc int64, cliente, codPub string) (*Acao, string, bool, string) {
	var et, inst, st, apr sql.NullInt64
	if err := db.QueryRow(`SELECT id_etapa_atual, id_instancia_atual, id_status_atual, id_aprovacao_atual
  FROM FT_PROCESSOS WHERE id_processo=?`, idProc).Scan(&et, &inst, &st, &apr); err != nil {
		return nil, "", false, "erro ao ler o processo: " + err.Error()
	}
	ptr := func(n sql.NullInt64) *int {
		if !n.Valid || n.Int64 == 0 {
			return nil
		}
		v := int(n.Int64)
		return &v
	}
	atualEt := int(et.Int64)
	atualInst, atualSt, atualApr := ptr(inst), ptr(st), ptr(apr)

	// destino: o que não foi dito, mantém
	alvo := atualEt
	switch {
	case p.movEtapa > 0:
		alvo = p.movEtapa
	case p.movDir != 0:
		alvo = atualEt + p.movDir
		if alvo < 1 || alvo > 6 {
			return nil, "", false, fmt.Sprintf("não há etapa %s de %s", map[int]string{1: "depois", -1: "antes"}[p.movDir], etapaNomeByID(atualEt))
		}
	}
	novaInst := atualInst
	if p.movInst != nil {
		novaInst = p.movInst
	}
	novoApr := atualApr
	if p.movAprov != nil {
		novoApr = p.movAprov
	}
	if alvo == 3 { // Conciliação congela Deferido (igual ao Kanban)
		d := 1
		novoApr = &d
	}
	novoSt := 1
	if atualSt != nil {
		novoSt = *atualSt
	}
	if p.movStatus != nil {
		novoSt = *p.movStatus
	} else if alvo == 6 && atualEt != 6 {
		novoSt = 7 // Encerramento sem status dito → Encerrado
	}

	if msg := validarTransicaoLocal(atualEt, alvo, novoApr); msg != "" {
		return nil, "", false, msg
	}
	igual := func(a, b *int) bool { return (a == nil && b == nil) || (a != nil && b != nil && *a == *b) }
	stAtual := 0
	if atualSt != nil {
		stAtual = *atualSt
	}
	if alvo == atualEt && igual(novaInst, atualInst) && novoSt == stAtual && igual(novoApr, atualApr) {
		return nil, "", false, fmt.Sprintf("o processo %s já está em %s / %s / %s — nada a movimentar (para só registrar um texto, peça \"inserir histórico no processo %s: …\")",
			codPub, etapaNomeByID(atualEt), nomeInst(atualInst), statusNomeID[stAtual], codPub)
	}

	linha := func(rot, de, para string) string {
		if de == para {
			return fmt.Sprintf("%s: %s (mantém)", rot, de)
		}
		return fmt.Sprintf("%s: %s → %s", rot, de, para)
	}
	stAtualPtr := &stAtual
	partes := []string{
		linha("Etapa", etapaNomeByID(atualEt), etapaNomeByID(alvo)),
		linha("Instância", nomeInst(atualInst), nomeInst(novaInst)),
		linha("Status", nomeOuTraco(statusNomeID, stAtualPtr), nomeOuTraco(statusNomeID, &novoSt)),
		linha("Aprovação", nomeOuTraco(aprovNomeID, atualApr), nomeOuTraco(aprovNomeID, novoApr)),
	}
	dePara := strings.Join(partes, " · ")
	a := &Acao{Op: "movimentar", Processo: codPub, IdProcesso: idProc, Cliente: cliente, Rotulo: "movimentar",
		Comentario: p.comentario,
		Mov: &MovSpec{EtapaID: alvo, EtapaNome: etapaNomeByID(alvo), StatusID: novoSt, InstanciaID: novaInst,
			AprovacaoID: novoApr, DePara: dePara,
			EtapaAntes: atualEt, InstanciaAntes: atualInst, StatusAntes: atualSt, AprovacaoAntes: atualApr}}
	prev := fmt.Sprintf("Movimentar o processo %s (%s):\n%s", codPub, cliente, strings.Join(partes, "\n"))
	if p.comentario != "" {
		prev += fmt.Sprintf("\nComentário no histórico: %q", p.comentario)
	}
	return a, prev, true, ""
}

func nomeInst(v *int) string {
	if v == nil || *v == 0 {
		return "—"
	}
	return instanciaNomeByID(*v)
}

// Acao é a ação estruturada completa (serializada em FT_SOLICITACOES.acao_json).
type Acao struct {
	Op         string            `json:"op"` // editar_processo | recalcular_repasse | movimentar
	Processo   string            `json:"processo"`
	IdProcesso int64             `json:"id_processo"`
	Cliente    string            `json:"cliente"`
	Rotulo     string            `json:"rotulo"`
	Alteracoes []Alt             `json:"alteracoes"`
	Mov        *MovSpec          `json:"mov,omitempty"`
	Relatorio  string            `json:"relatorio,omitempty"`
	Params     map[string]string `json:"params,omitempty"`
	Comentario string            `json:"comentario,omitempty"` // op inserir_historico
	DataHist   string            `json:"data_hist,omitempty"`  // data/hora do histórico (opcional)
}

// fieldDef descreve um campo editável de processo.
type fieldDef struct {
	chave   string
	coluna  string
	tipo    string
	tabelas []string // FT_PROCESSOS e/ou FT_DEFERIMENTOS (valores espelhados)
	rotulo  string
}

const (
	tProc  = "FT_PROCESSOS"
	tDefer = "FT_DEFERIMENTOS"
	tMeta  = "DM_META_REPASSE" // metas-alvo do sistema (1 linha, id=1)
)

// campos é a WHITELIST de campos editáveis de PROCESSO. Valores de dinheiro/data
// que vivem nas duas tabelas gravam nas duas p/ não dessincronizar (front lê
// FT_DEFERIMENTOS).
//
// NÃO entram aqui de propósito (editar cru quebra o sistema → revisão manual):
//   - PKs/FKs de identidade: id_processo, id_deferimento, cod_empresa, id_responsavel
//   - ponteiros de workflow: id_instancia_atual, id_etapa_atual, id_status_atual,
//     id_aprovacao_atual, status_analise, instancia_deferimento
//     (mudar o ponteiro sem gravar FT_HISTORICO_MOVIMENTACOES dessincroniza — use
//     uma operação "movimentar" dedicada, não edição crua)
//   - irregularidade por FK: id_tipo/id_subtipo + nome_* (id e nome em 2 lugares)
//   - carimbos automáticos: data_criacao, ultima_atualizacao, data_movimentacao
//   - identificador público: codigo_publico (quebra links)
//   - JSON canônico: periodos_irregularidade (precisa do normalizador no write-path)
var campos = []fieldDef{
	// --- valores em dinheiro (espelhados nas 2 tabelas) ---
	{"credito_simples", "credito_simples", "decimal", []string{tProc, tDefer}, "crédito simples"},
	{"credito_dobro", "credito_dobro", "decimal", []string{tProc, tDefer}, "crédito dobro"},
	{"repasse_simples", "repasse_simples", "decimal", []string{tProc, tDefer}, "repasse simples"},
	{"repasse_dobro", "repasse_dobro", "decimal", []string{tProc, tDefer}, "repasse dobro"},
	// --- valores só em FT_PROCESSOS ---
	{"ressarcimento_estimado", "ressarcimento_estimado", "decimal", []string{tProc}, "ressarcimento estimado"},
	{"percentual_repasse", "percentual_repasse", "decimal", []string{tProc}, "percentual de repasse"},
	{"score_percentual", "score_percentual", "decimal", []string{tProc}, "score percentual"},
	// --- datas (espelhadas) ---
	{"data_procedencia", "data_procedencia", "date", []string{tProc, tDefer}, "data de procedência"},
	{"data_credito_dobro", "data_credito_dobro", "date", []string{tProc, tDefer}, "data do crédito dobro"},
	// --- datas só em FT_PROCESSOS ---
	{"data_alerta", "data_alerta", "date", []string{tProc}, "data de alerta"},
	{"data_proxima_acao", "data_proxima_acao", "date", []string{tProc}, "data da próxima ação"},
	// --- textos ---
	{"cliente", "cliente", "texto", []string{tProc}, "cliente"},
	{"concessionaria", "concessionaria", "texto", []string{tProc}, "concessionária"},
	{"uc", "uc", "texto", []string{tProc}, "UC"},
	{"uc_atual", "uc_atual", "texto", []string{tProc}, "UC atual"},
	{"descricao", "descricao_irregularidade", "texto", []string{tProc}, "descrição da irregularidade"},
	{"observacao", "observacao", "texto", []string{tDefer}, "observação"},
	// --- inteiros / flags ---
	{"relevancia", "relevancia", "int", []string{tProc}, "relevância"},
	{"suspenso", "suspenso", "bool", []string{tProc}, "suspenso"},
	{"triagem_concluida", "triagem_concluida", "bool", []string{tProc}, "triagem concluída"},
}

func fieldByChave(ch string) *fieldDef {
	for i := range campos {
		if campos[i].chave == ch {
			return &campos[i]
		}
	}
	return nil
}

// camposMeta é a whitelist das METAS-ALVO do sistema (DM_META_REPASSE, linha id=1).
// São valores de configuração globais (não de processo) — por isso ficam separados
// de `campos` e não entram no casamento de sinônimos de campo de processo.
var camposMeta = []fieldDef{
	{"meta_mensal", "meta_mensal", "decimal", []string{tMeta}, "meta mensal"},
	{"meta_anual", "meta_anual", "decimal", []string{tMeta}, "meta anual"},
}

func metaByChave(ch string) *fieldDef {
	for i := range camposMeta {
		if camposMeta[i].chave == ch {
			return &camposMeta[i]
		}
	}
	return nil
}

// CamposPermitidos é a allowlist no nível de coluna ("TABELA.coluna" → tipo),
// usada pelo executor como barreira final antes de gravar.
func CamposPermitidos() map[string]string {
	m := map[string]string{}
	for _, f := range campos {
		for _, t := range f.tabelas {
			m[t+"."+f.coluna] = f.tipo
		}
	}
	for _, f := range camposMeta {
		for _, t := range f.tabelas {
			m[t+"."+f.coluna] = f.tipo
		}
	}
	return m
}

// sinonimos: frase normalizada → chave do campo. Mais específicas (e mais longas)
// primeiro, p/ "data do credito dobro" não cair antes em "credito dobro".
var sinonimos = []struct{ frase, chave string }{
	{"data do credito dobro", "data_credito_dobro"},
	{"data credito dobro", "data_credito_dobro"},
	{"data de procedencia", "data_procedencia"},
	{"data procedencia", "data_procedencia"},
	{"data da proxima acao", "data_proxima_acao"},
	{"data de proxima acao", "data_proxima_acao"},
	{"proxima acao", "data_proxima_acao"},
	{"data de alerta", "data_alerta"},
	{"data do alerta", "data_alerta"},
	{"alerta", "data_alerta"},
	{"credito em dobro", "credito_dobro"},
	{"credito dobro", "credito_dobro"},
	{"credito simples", "credito_simples"},
	{"repasse em dobro", "repasse_dobro"},
	{"repasse dobro", "repasse_dobro"},
	{"repasse simples", "repasse_simples"},
	{"percentual de repasse", "percentual_repasse"},
	{"percentual repasse", "percentual_repasse"},
	{"ressarcimento estimado", "ressarcimento_estimado"},
	{"score percentual", "score_percentual"},
	{"score", "score_percentual"},
	{"procedencia", "data_procedencia"},
	{"descricao da irregularidade", "descricao"},
	{"descricao irregularidade", "descricao"},
	{"descricao", "descricao"},
	{"observacao", "observacao"},
	{"concessionaria", "concessionaria"},
	{"distribuidora", "concessionaria"},
	{"unidade consumidora", "uc"},
	{"uc atual", "uc_atual"},
	{"uc", "uc"},
	{"relevancia", "relevancia"},
	{"triagem concluida", "triagem_concluida"},
	{"triagem", "triagem_concluida"},
	{"suspensao", "suspenso"},
	{"suspenso", "suspenso"},
	{"suspender", "suspenso"},
	{"cliente", "cliente"},
}

// sinRe compila cada sinônimo com fronteira de palavra (\b), p/ "uc" não casar
// dentro de "conducao" etc.
var sinRe = func() []struct {
	re    *regexp.Regexp
	chave string
} {
	out := make([]struct {
		re    *regexp.Regexp
		chave string
	}, 0, len(sinonimos))
	for _, s := range sinonimos {
		out = append(out, struct {
			re    *regexp.Regexp
			chave string
		}{regexp.MustCompile(`\b` + regexp.QuoteMeta(s.frase) + `\b`), s.chave})
	}
	return out
}()

var (
	reDeAcento  = strings.NewReplacer("á", "a", "à", "a", "â", "a", "ã", "a", "é", "e", "ê", "e", "í", "i", "ó", "o", "ô", "o", "õ", "o", "ú", "u", "ç", "c")
	reProcNum   = regexp.MustCompile(`(?i)processos?\s*(?:n[ºo.]*\s*)?#?\s*(\d{3,9})`)
	rePRcode    = regexp.MustCompile(`(?i)(PR-\d{4}-\d+)`)
	reHashNum   = regexp.MustCompile(`#\s*(\d{3,9})`)
	reData      = regexp.MustCompile(`(\d{1,2})/(\d{1,2})/(\d{4})`)
	reDataISO   = regexp.MustCompile(`(\d{4})-(\d{2})-(\d{2})`)
	reValorApos = regexp.MustCompile(`(?i)(?:\bpara\b|=|:)\s*(.+)$`)
	reWorkflow  = regexp.MustCompile(`\b(status|etapa|situacao|instancia|aprovacao|deferir|indeferir|mover|movimentar)\b`)
	reMeta      = regexp.MustCompile(`\bmeta\b`) // meta-alvo do sistema (DM_META_REPASSE)
)

// detectarMeta identifica um pedido de edição de meta-alvo (mensal/anual). Retorna o
// campo, se achou valor e o motivo quando não deu. Só dispara com um valor explícito
// ("... para N"), p/ não confundir com uma pergunta sobre a meta.
func detectarMeta(msg, n string) (*fieldDef, string, string, bool) {
	if !reMeta.MatchString(n) {
		return nil, "", "", false
	}
	hasM, hasA := strings.Contains(n, "mensal"), strings.Contains(n, "anual")
	if !hasM && !hasA {
		return nil, "", "diga 'meta mensal' ou 'meta anual'", true
	}
	ch := "meta_mensal"
	if hasA {
		ch = "meta_anual"
	}
	f := metaByChave(ch)
	val, ok := extrairValor(msg, "decimal")
	if !ok {
		return f, "", "informe o novo valor (ex.: 'meta mensal para 250000')", true
	}
	return f, val, "", true
}

func norm(s string) string { return reDeAcento.Replace(strings.ToLower(strings.TrimSpace(s))) }

// ExtrairProcesso pega "PR-AAAA-NNNNNN", "processo 18789" ou "#18789".
func ExtrairProcesso(msg string) (string, bool) {
	if m := rePRcode.FindStringSubmatch(msg); m != nil {
		return strings.ToUpper(m[1]), true
	}
	if m := reProcNum.FindStringSubmatch(msg); m != nil {
		return m[1], true
	}
	if m := reHashNum.FindStringSubmatch(msg); m != nil {
		return m[1], true
	}
	// pela unidade consumidora: "unidade 200994986", "UC 5/2445677-4", "instalação 123456"
	// → ref "UC:<texto>"; o Montar resolve para o processo (se houver só um).
	if m := reUCRef.FindStringSubmatch(msg); m != nil {
		return "UC:" + m[1], true
	}
	return "", false
}

var reUCRef = regexp.MustCompile(`(?i)\b(?:uc|unidade(?:\s+consumidora)?|instala[cç][aã]o)\s*(?:n[ºo°.]*\s*)?[:#]?\s*(\d[\d./-]{3,24}\d)`)

// resolverProcesso traduz a referência (PR-AAAA-N, id ou "UC:<nº>") no processo.
// Pela UC: procura em uc/uc_atual (como digitado e só dígitos); se houver mais de um
// processo, devolve erro listando os códigos p/ o usuário escolher.
func resolverProcesso(db *sql.DB, ref string) (int64, string, string, error) {
	var id int64
	var cliente, codigo sql.NullString
	if strings.HasPrefix(ref, "UC:") {
		uc := strings.TrimPrefix(ref, "UC:")
		dig := regexp.MustCompile(`\D`).ReplaceAllString(uc, "")
		rows, err := db.Query(`SELECT id_processo, cliente, codigo_publico, id_etapa_atual FROM FT_PROCESSOS
  WHERE uc IN (?,?) OR uc_atual IN (?,?) ORDER BY (id_etapa_atual=6), id_processo DESC LIMIT 10`, uc, dig, uc, dig)
		if err != nil {
			return 0, "", "", err
		}
		defer rows.Close()
		type cand struct {
			id        int64
			cli, cod  string
			encerrado bool
		}
		var cs []cand
		for rows.Next() {
			var c cand
			var cl, co sql.NullString
			var et sql.NullInt64
			if rows.Scan(&c.id, &cl, &co, &et) == nil {
				c.cli, c.cod, c.encerrado = cl.String, co.String, et.Valid && et.Int64 == 6
				cs = append(cs, c)
			}
		}
		if len(cs) == 0 {
			return 0, "", "", fmt.Errorf("não encontrei processo para a unidade %s", uc)
		}
		// ignora encerrados se houver algum em andamento
		var ativos []cand
		for _, c := range cs {
			if !c.encerrado {
				ativos = append(ativos, c)
			}
		}
		if len(ativos) == 0 {
			ativos = cs
		}
		if len(ativos) > 1 {
			var lst []string
			for _, c := range ativos {
				lst = append(lst, c.cod)
			}
			return 0, "", "", fmt.Errorf("a unidade %s tem %d processos (%s) — diga qual (ex.: \"processo %s\")", uc, len(ativos), strings.Join(lst, ", "), ativos[0].cod)
		}
		return ativos[0].id, ativos[0].cli, ativos[0].cod, nil
	}
	q := `SELECT id_processo, cliente, codigo_publico FROM FT_PROCESSOS WHERE id_processo=?`
	if rePRcode.MatchString(ref) {
		q = `SELECT id_processo, cliente, codigo_publico FROM FT_PROCESSOS WHERE codigo_publico=?`
	}
	if err := db.QueryRow(q, ref).Scan(&id, &cliente, &codigo); err != nil {
		return 0, "", "", fmt.Errorf("processo %s não encontrado", ref)
	}
	return id, cliente.String, codigo.String, nil
}

// plano é o resultado puro da interpretação (sem DB).
type plano struct {
	op          string // editar_processo | recalcular_repasse | movimentar
	processoRef string
	field       *fieldDef
	valorTxt    string // canônico p/ gravar
	motivo      string // quando !ok, explica
	// movimentação
	movEtapa     int
	movEtapaNome string
	movDir       int // +1 avançar / -1 voltar uma etapa (quando a etapa não foi nomeada)
	movAprov     *int
	movInst      *int
	movStatus    *int
	// relatório (somente leitura)
	relatorio string
	params    map[string]string
	// inserir histórico
	comentario string
	dataHist   string
}

// Etapas e status (DM_ETAPAS / DM_STATUS_PROCESSO / DM_STATUS_APROVACAO).
var etapaNomes = []struct {
	frase string
	id    int
	nome  string
}{
	{"reclamacao", 1, "Reclamação"},
	{"contestacao", 2, "Contestação"},
	{"conciliacao", 3, "Conciliação"},
	{"faturamento", 4, "Faturamento"},
	{"repasse", 5, "Repasse"},
	{"encerramento", 6, "Encerramento"},
}

func etapaNomeByID(id int) string {
	for _, e := range etapaNomes {
		if e.id == id {
			return e.nome
		}
	}
	return fmt.Sprintf("etapa %d", id)
}

var statusNomes = []struct {
	frase string
	id    int
}{
	{"em analise", 1}, {"em elaboracao", 2}, {"aguardando retorno", 3}, {"aguardando resposta", 3}, {"aguardando", 3},
	{"pendente", 4}, {"suspenso", 5}, {"cancelado", 6}, {"encerrado", 7},
}

var (
	rePergunta = regexp.MustCompile(`^\s*(qual|quais|quanto|quantos|quantas|como|quem|onde|quando|porque|por que|o que|mostr|list|exib|me fale|me diga|me mostr|me list|quero saber|gostaria|tem quantos|existe|quantos)\b`)
	reCmdVerbo = regexp.MustCompile(`\b(atualiz\w*|alter\w*|corrig\w*|ajust\w*|mud\w*|inserir|adicion\w*|registr\w*|inclu\w*|lanc\w*|recalcul\w*|ger\w*|criar|grav\w*|defin\w*|troc\w*|coloc\w*)\b`)
	reHist     = regexp.MustCompile(`\b(inserir|adicionar|registrar|incluir|lancar|criar|gravar)\b.{0,20}\bhistoric`)
	reDataHora = regexp.MustCompile(`(\d{1,2})/(\d{1,2})/(\d{4})(?:\D{1,4}(\d{1,2})[:h](\d{2}))?`)
	reMovVerbo = regexp.MustCompile(`\b(mover|mova|movimentar|movimente|movimenta|movimentacao|avancar|avance|avanca|avanco|voltar|volte|retroceder|retroceda|encerrar|encerre|encerramento|deferir|defira|deferido|indeferir|indefira|indeferido|conciliar|transferir|transfira|mudar de etapa|mudar a etapa|mudar de instancia|passar para|passe para|ir para a etapa|levar para|leve para)\b`)
	reDeferir  = regexp.MustCompile(`\b(deferir|deferido)\b`)
	reIndefer  = regexp.MustCompile(`\b(indeferir|indeferido)\b`)
	reEncerrar = regexp.MustCompile(`\b(encerrar|encerramento)\b`)
)

// validarTransicaoLocal replica a regra de v2.validarTransicao (adjacência / Conciliação /
// Encerramento-com-aprovação) só para o PREVIEW avisar antes. A validação autoritativa
// roda no executor via v2.MovimentarCore. Ordem: 1..6.
func validarTransicaoLocal(atual, alvo int, aprov *int) string {
	if atual == 6 && alvo != 6 {
		return "processo já está em Encerramento (etapa terminal)"
	}
	if alvo == 6 {
		if aprov == nil || *aprov == 0 {
			return "para encerrar, diga 'deferido' ou 'indeferido'"
		}
		return ""
	}
	if alvo == 3 {
		return ""
	}
	d := alvo - atual
	if d < 0 {
		d = -d
	}
	if d > 1 {
		return fmt.Sprintf("não é permitido pular etapas (de %s para %s) — mova uma etapa por vez", etapaNomeByID(atual), etapaNomeByID(alvo))
	}
	return ""
}

// interpretarMov parseia uma movimentação: etapa de destino (por nome, ou avançar/
// voltar uma etapa), instância (distribuidora/ouvidoria/ANEEL/SMA), aprovação
// (deferido/indeferido), status opcional e comentário (texto depois de ':').
// O que não for dito MANTÉM o valor atual (resolvido no Montar, que lê o processo).
func interpretarMov(n, pr, msgOriginal string) (plano, bool) {
	p := plano{op: "movimentar", processoRef: pr}
	// o comentário (depois de ':') não pode influenciar a interpretação do comando
	cmd := n
	if i := idxComentarioMov(cmd); i >= 0 {
		cmd = cmd[:i]
	}

	// deferir/indeferir → Encerramento + aprovação
	if reIndefer.MatchString(cmd) {
		a := 2
		p.movEtapa, p.movEtapaNome, p.movAprov = 6, "Encerramento", &a
	} else if reDeferir.MatchString(cmd) {
		a := 1
		p.movEtapa, p.movEtapaNome, p.movAprov = 6, "Encerramento", &a
	}

	// etapa de destino explícita por nome (a ÚLTIMA citada = destino: "de contestação para conciliação")
	if p.movEtapa == 0 {
		melhor := -1
		for _, e := range etapaNomes {
			for _, loc := range regexp.MustCompile(`\b`+e.frase+`\b`).FindAllStringIndex(cmd, -1) {
				if loc[0] > melhor {
					melhor = loc[0]
					p.movEtapa, p.movEtapaNome = e.id, e.nome
				}
			}
		}
	}
	if p.movEtapa == 0 && reEncerrar.MatchString(cmd) {
		p.movEtapa, p.movEtapaNome = 6, "Encerramento"
	}
	if p.movEtapa == 0 {
		if reAvancar.MatchString(cmd) {
			p.movDir = 1
		} else if reVoltar.MatchString(cmd) {
			p.movDir = -1
		}
	}

	// instância (a última citada = destino: "da ouvidoria para a ANEEL")
	melhor := -1
	for _, it := range instanciaNomes {
		for _, loc := range it.re.FindAllStringIndex(cmd, -1) {
			if loc[0] > melhor {
				melhor = loc[0]
				id := it.id
				p.movInst = &id
			}
		}
	}

	// status opcional: "status pendente" (qualquer status) ou, sem a palavra "status",
	// as expressões inequívocas ("aguardando resposta/retorno", "em análise", "em elaboração").
	if i := strings.Index(cmd, "status"); i >= 0 {
		resto := cmd[i:]
		for _, s := range statusNomes {
			if regexp.MustCompile(`\b` + s.frase + `\b`).MatchString(resto) {
				id := s.id
				p.movStatus = &id
				break
			}
		}
	}
	if p.movStatus == nil {
		if m := reStatusLivre.FindString(cmd); m != "" {
			for _, s := range statusNomes {
				if strings.HasPrefix(m, s.frase) {
					id := s.id
					p.movStatus = &id
					break
				}
			}
		}
	}

	if p.movEtapa == 0 && p.movDir == 0 && p.movInst == nil && p.movStatus == nil {
		return plano{op: "movimentar", processoRef: pr, motivo: "não identifiquei para onde mover: diga a etapa (reclamação, contestação, conciliação, faturamento, repasse, encerramento), a instância (distribuidora, ouvidoria, ANEEL, SMA), 'avançar'/'voltar' ou 'deferido'/'indeferido'"}, false
	}
	if i := idxComentarioMov(msgOriginal); i >= 0 {
		p.comentario = strings.TrimSpace(msgOriginal[i+1:])
	}
	return p, true
}

// idxComentarioMov acha o ':' que separa o comando do comentário da movimentação,
// ignorando o ':' de rótulos de identificação ("UC: 123", "processo: 456", "nº: 7").
func idxComentarioMov(s string) int {
	off := 0
	for {
		i := strings.Index(s[off:], ":")
		if i < 0 {
			return -1
		}
		i += off
		antes := strings.ToLower(strings.TrimSpace(s[:i]))
		if !reRotuloAntesDoisPontos.MatchString(antes) {
			return i
		}
		off = i + 1
	}
}

var reRotuloAntesDoisPontos = regexp.MustCompile(`(?i)(?:^|\s)(uc|unidade|consumidora|processo|instala\S*|n[ºo°.]|status|etapa|instancia|instância)$`)

var (
	reStatusLivre = regexp.MustCompile(`\b(aguardando retorno|aguardando resposta|em analise|em elaboracao)\b`)
	reAvancar     = regexp.MustCompile(`\b(avancar|avance|avanca|avanco|proxima etapa)\b`)
	reVoltar      = regexp.MustCompile(`\b(voltar|volte|volta|retroceder|retroceda|etapa anterior)\b`)
)

// Instâncias (DM_INSTANCIAS).
var instanciaNomes = []struct {
	re   *regexp.Regexp
	id   int
	nome string
}{
	{regexp.MustCompile(`\b(distribuidora|concessionaria)\b`), 1, "Distribuidora"},
	{regexp.MustCompile(`\bouvidoria\b`), 2, "Ouvidoria"},
	{regexp.MustCompile(`\baneel\b`), 3, "ANEEL"},
	{regexp.MustCompile(`\b(sma|juridico|ministerio publico)\b`), 4, "SMA"},
}

func instanciaNomeByID(id int) string {
	for _, i := range instanciaNomes {
		if i.id == id {
			return i.nome
		}
	}
	return fmt.Sprintf("instância %d", id)
}

var statusNomeID = map[int]string{1: "Em análise", 2: "Em elaboração", 3: "Aguardando retorno", 4: "Pendente", 5: "Suspenso", 6: "Cancelado", 7: "Encerrado"}
var aprovNomeID = map[int]string{1: "Deferido", 2: "Indeferido"}

func nomeOuTraco(m map[int]string, v *int) string {
	if v == nil || *v == 0 {
		return "—"
	}
	if s, ok := m[*v]; ok {
		return s
	}
	return fmt.Sprint(*v)
}

// EhComando diz se a mensagem é um COMANDO de sistema (alterar campo / relatório /
// inserir histórico / mover etapa) e NÃO uma pergunta de leitura. Usado para decidir,
// sem a tag #sistema, se o chat trata como pedido (prévia+aprovação) ou como Q&A.
func EhComando(msg string) bool {
	n := norm(msg)
	if rePergunta.MatchString(n) {
		return false // pergunta → Q&A
	}
	if reHist.MatchString(n) || reMovVerbo.MatchString(n) {
		return true
	}
	// edição de meta-alvo (mensal/anual) com verbo de comando, sem processo
	if reMeta.MatchString(n) && (strings.Contains(n, "mensal") || strings.Contains(n, "anual")) && reCmdVerbo.MatchString(n) {
		return true
	}
	if _, ok := interpretarJob(n); ok {
		return true // rodar tarefa conhecida (ex.: agua_sync)
	}
	if _, _, ok := interpretarRelatorio(n); ok {
		return true
	}
	if _, okp := ExtrairProcesso(msg); okp && reCmdVerbo.MatchString(n) {
		return true // verbo de comando + nº de processo
	}
	return false
}

// interpretar: texto livre → plano. Determinístico, sem DB.
func interpretar(msg string) (plano, bool) {
	n := norm(msg)

	// Inserir histórico tem prioridade: o texto do histórico pode mencionar "ANEEL",
	// "protocolo", "mover" etc., que casariam por engano com relatório/movimentação.
	if reHist.MatchString(n) {
		if pr, okp := ExtrairProcesso(msg); okp {
			com := extrairComentarioHist(msg)
			if com == "" {
				return plano{processoRef: pr, motivo: "inclua o texto do histórico (depois de ':')"}, false
			}
			return plano{op: "inserir_historico", processoRef: pr, comentario: com, dataHist: extrairDataHist(msg)}, true
		}
	}

	// Meta-alvo do sistema (mensal/anual) — não exige processo. Só captura quando há
	// valor explícito ("... para N") ou verbo de comando, p/ não atropelar consultas.
	if f, val, motivo, isMeta := detectarMeta(msg, n); isMeta && (val != "" || reCmdVerbo.MatchString(n)) {
		if val == "" {
			return plano{op: "editar_meta", field: f, motivo: motivo}, false
		}
		return plano{op: "editar_meta", field: f, valorTxt: val}, true
	}

	// Tarefas conhecidas do sistema (ex.: sincronizar faturas de água) — rodadas no host da
	// VPS por worker/run_jobs.py (o executor deixa passar). Não exigem processo.
	if params, ok := interpretarJob(n); ok {
		return plano{op: "rodar_job", params: params}, true
	}

	// Relatórios (somente leitura) — não exigem número de processo.
	if rel, params, ok := interpretarRelatorio(n); ok {
		return plano{op: "relatorio", relatorio: rel, params: params}, true
	}

	pr, okP := ExtrairProcesso(msg)
	if !okP {
		return plano{motivo: "não identifiquei o número do processo"}, false
	}

	// Movimentação (etapa/instância/status/aprovação) — vira op "movimentar", aplicada
	// pelo executor via v2.MovimentarCoreHist (MESMO caminho do Kanban: grava o
	// FT_HISTORICO_MOVIMENTACOES e o FT_PROCESSOS juntos, numa transação). Fica antes
	// da edição de campos p/ "avançar para repasse" não virar recálculo de repasse.
	if reMovVerbo.MatchString(n) {
		return interpretarMov(n, pr, msg)
	}

	// qual campo? (fronteira de palavra; mais específico primeiro)
	var ch string
	for _, s := range sinRe {
		if s.re.MatchString(n) {
			ch = s.chave
			break
		}
	}

	// repasse genérico (sem simples/dobro) e sem valor → recalcular pelo percentual
	hasValor := reValorApos.MatchString(msg) || reData.MatchString(msg)
	if ch == "" {
		if strings.Contains(n, "repasse") && !hasValor {
			return plano{op: "recalcular_repasse", processoRef: pr}, true
		}
		if reWorkflow.MatchString(n) {
			return plano{processoRef: pr, motivo: "status/etapa/instância mudam só pelo fluxo de movimentação (senão o histórico dessincroniza) — execução manual"}, false
		}
		return plano{processoRef: pr, motivo: "não reconheci o campo a alterar"}, false
	}
	if strings.Contains(n, "repasse") && ch == "" {
		return plano{processoRef: pr, motivo: "especifique 'repasse simples' ou 'repasse dobro'"}, false
	}

	f := fieldByChave(ch)
	if f == nil {
		return plano{processoRef: pr, motivo: "campo não editável"}, false
	}

	// valor
	valTxt, ok := extrairValor(msg, f.tipo)
	if !ok {
		return plano{op: "editar_processo", processoRef: pr, field: f, motivo: "não consegui ler o novo valor para " + f.rotulo}, false
	}
	return plano{op: "editar_processo", processoRef: pr, field: f, valorTxt: valTxt}, true
}

var (
	reBoolNeg = regexp.MustCompile(`\b(nao|false|0|reativar|desmarcar|remover|retirar|desativar)\b`)
	reBoolPos = regexp.MustCompile(`\b(sim|true|1|suspender|suspenso|concluida|concluir|marcar|ativar|ativa)\b`)
)

func extrairValor(msg, tipo string) (string, bool) {
	switch tipo {
	case "bool":
		n := norm(msg)
		if reBoolNeg.MatchString(n) {
			return "0", true
		}
		if reBoolPos.MatchString(n) {
			return "1", true
		}
		return "", false
	case "int":
		m := reValorApos.FindStringSubmatch(msg)
		src := msg
		if m != nil {
			src = m[1]
		}
		v, ok := ParseDecimalBR(src)
		if !ok {
			return "", false
		}
		return strconv.FormatInt(int64(v), 10), true
	case "date":
		if m := reData.FindStringSubmatch(msg); m != nil {
			return fmt.Sprintf("%04s-%02s-%02s", m[3], pad2(m[2]), pad2(m[1])), true
		}
		if m := reDataISO.FindStringSubmatch(msg); m != nil {
			return fmt.Sprintf("%s-%s-%s", m[1], m[2], m[3]), true
		}
		return "", false
	case "decimal":
		m := reValorApos.FindStringSubmatch(msg)
		src := msg
		if m != nil {
			src = m[1]
		}
		v, ok := ParseDecimalBR(src)
		if !ok {
			return "", false
		}
		return strconv.FormatFloat(v, 'f', 2, 64), true
	default: // texto
		m := reValorApos.FindStringSubmatch(msg)
		if m == nil {
			return "", false
		}
		t := strings.TrimSpace(m[1])
		t = strings.Trim(t, "\"'.")
		if t == "" {
			return "", false
		}
		return t, true
	}
}

func pad2(s string) string {
	if len(s) == 1 {
		return "0" + s
	}
	return s
}

var reCmdHist = regexp.MustCompile(`(?i)#?sistema|\b(inserir|adicionar|registrar|incluir|lancar|lançar|criar|gravar)\b|\b(um|no|do|a|o)\b|hist[oó]rico|processos?\s*#?\s*\d{3,9}|PR-\d{4}-\d+`)

// extrairComentarioHist pega o texto do histórico: tudo após o primeiro ":",
// ou o que sobra depois de remover o comando e o nº do processo.
func extrairComentarioHist(msg string) string {
	if i := strings.Index(msg, ":"); i >= 0 && i+1 < len(msg) {
		return strings.TrimSpace(msg[i+1:])
	}
	return strings.Join(strings.Fields(reCmdHist.ReplaceAllString(msg, " ")), " ")
}

// extrairDataHist acha dd/mm/aaaa [hh:mm] no texto → "AAAA-MM-DD[ HH:MM:SS]".
func extrairDataHist(msg string) string {
	m := reDataHora.FindStringSubmatch(msg)
	if m == nil {
		return ""
	}
	out := m[3] + "-" + pad2(m[2]) + "-" + pad2(m[1])
	if m[4] != "" && m[5] != "" {
		out += " " + pad2(m[4]) + ":" + m[5] + ":00"
	}
	return out
}

// ParseDecimalBR lê "R$ 40.000,00", "40000", "40.000,00", "1.500", "40,50".
func ParseDecimalBR(s string) (float64, bool) {
	s = strings.ToLower(s)
	s = strings.NewReplacer("r$", "", " ", "", "\t", "").Replace(s)
	// pega o primeiro bloco numérico com . , dígitos
	m := regexp.MustCompile(`-?[\d.,]+`).FindString(s)
	if m == "" {
		return 0, false
	}
	hasDot := strings.Contains(m, ".")
	hasCom := strings.Contains(m, ",")
	switch {
	case hasDot && hasCom: // 40.000,00 → ponto=milhar, vírgula=decimal
		m = strings.ReplaceAll(m, ".", "")
		m = strings.ReplaceAll(m, ",", ".")
	case hasCom: // 40000,00 → vírgula decimal
		m = strings.ReplaceAll(m, ",", ".")
	case hasDot: // 40.000 (milhar) vs 40.50 (decimal): se a parte após o último '.' tem 3 dígitos → milhar
		parts := strings.Split(m, ".")
		if len(parts[len(parts)-1]) == 3 {
			m = strings.ReplaceAll(m, ".", "")
		}
	}
	v, err := strconv.ParseFloat(m, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// ConverterValor transforma o ValorTxt canônico no valor a gravar no banco.
func ConverterValor(tipo, valorTxt string) (interface{}, error) {
	switch tipo {
	case "decimal":
		v, err := strconv.ParseFloat(valorTxt, 64)
		if err != nil {
			return nil, fmt.Errorf("decimal inválido: %q", valorTxt)
		}
		return v, nil
	case "int", "bool":
		v, err := strconv.ParseInt(valorTxt, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("inteiro inválido: %q", valorTxt)
		}
		if tipo == "bool" && v != 0 && v != 1 {
			return nil, fmt.Errorf("booleano inválido: %q", valorTxt)
		}
		return v, nil
	case "date":
		if !reDataISO.MatchString(valorTxt) {
			return nil, fmt.Errorf("data inválida: %q (esperado AAAA-MM-DD)", valorTxt)
		}
		return valorTxt, nil
	default:
		return valorTxt, nil
	}
}

func displayValor(tipo, canon string) string {
	switch tipo {
	case "decimal":
		v, err := strconv.ParseFloat(canon, 64)
		if err != nil {
			return canon
		}
		return formatBR(v)
	case "date":
		if m := reDataISO.FindStringSubmatch(canon); m != nil {
			return m[3] + "/" + m[2] + "/" + m[1]
		}
		return canon
	case "bool":
		return boolBR(canon)
	default:
		return canon
	}
}

func boolBR(s string) string {
	if s == "1" {
		return "sim"
	}
	if s == "0" {
		return "não"
	}
	return s
}

func formatBR(v float64) string {
	s := strconv.FormatFloat(v, 'f', 2, 64)
	intp, decp := s, "00"
	if i := strings.IndexByte(s, '.'); i >= 0 {
		intp, decp = s[:i], s[i+1:]
	}
	neg := strings.HasPrefix(intp, "-")
	intp = strings.TrimPrefix(intp, "-")
	var out []byte
	for i, c := range []byte(intp) {
		if i > 0 && (len(intp)-i)%3 == 0 {
			out = append(out, '.')
		}
		out = append(out, c)
	}
	res := string(out) + "," + decp
	if neg {
		res = "-" + res
	}
	return res
}

// Montar interpreta o texto, resolve o processo, lê os valores atuais e devolve a
// ação estruturada + um preview "antes → depois". ok=false com motivo p/ revisão.
func Montar(db *sql.DB, msg string) (*Acao, string, bool, string) {
	p, ok := interpretar(msg)
	if !ok {
		// "relatório da Alloha" / "planilha da claro em tratativa": pedido de relatório que cita
		// um CLIENTE cadastrado (sem a palavra "processos") → relatório completo do cliente.
		// Precisa do banco p/ saber se o nome é de cliente, por isso fica aqui e não no interpretar.
		n := norm(msg)
		if rePedidoRelat.MatchString(n) && !reMovVerbo.MatchString(n) && !reCmdVerbo.MatchString(n) &&
			!strings.Contains(n, "aneel") && clienteNaFrase(db, msg) != "" {
			pr := relatorioByChave("processos_cliente").params(n)
			a := &Acao{Op: "relatorio", Relatorio: "processos_cliente", Params: pr, Rotulo: "relatório"}
			return a, PreviewRelatorio("processos_cliente", pr), true, ""
		}
		return nil, "", false, p.motivo
	}

	// Relatório (só leitura) — não precisa resolver processo.
	if p.op == "rodar_job" {
		a := &Acao{Op: "rodar_job", Rotulo: "rodar tarefa", Params: p.params}
		emp := p.params["empresas"]
		quais := "todas as empresas configuradas no script"
		if emp != "" {
			quais = fmt.Sprintf("%d empresas (%s)", len(strings.Split(emp, ",")), emp)
		}
		return a, fmt.Sprintf("Rodar a sincronização de FATURAS DE ÁGUA (agua_sync) para %s: insere só as faturas novas, com backup das chaves inseridas.", quais), true, ""
	}

	if p.op == "relatorio" {
		a := &Acao{Op: "relatorio", Relatorio: p.relatorio, Params: p.params, Rotulo: "relatório"}
		return a, PreviewRelatorio(p.relatorio, p.params), true, ""
	}

	// Edição de meta-alvo do sistema (DM_META_REPASSE, id=1) — não precisa de processo.
	if p.op == "editar_meta" {
		f := p.field
		if f == nil {
			return nil, "", false, "diga 'meta mensal' ou 'meta anual'"
		}
		// garante a linha de config (idempotente; não sobrescreve se já existe)
		_, _ = db.Exec(`INSERT IGNORE INTO DM_META_REPASSE (id, meta_mensal, meta_anual) VALUES (1, 0, 0)`)
		var antes sql.NullString
		if err := db.QueryRow(fmt.Sprintf("SELECT CAST(`%s` AS CHAR) FROM DM_META_REPASSE WHERE id=1", f.coluna)).Scan(&antes); err != nil {
			return nil, "", false, "erro ao ler a meta atual: " + err.Error()
		}
		a := &Acao{Op: "editar_meta", Rotulo: f.rotulo, Alteracoes: []Alt{{
			Tabela: tMeta, Coluna: f.coluna, Tipo: "decimal", PkColuna: "id", PkValor: "1",
			ValorTxt: p.valorTxt, Antes: antes.String,
			Preview: fmt.Sprintf("%s: %s → %s", f.rotulo, displayAntes("decimal", antes), displayValor("decimal", p.valorTxt)),
		}}}
		return a, fmt.Sprintf("Alterar a %s do sistema: %s → %s (vale para todos os usuários).",
			f.rotulo, displayAntes("decimal", antes), displayValor("decimal", p.valorTxt)), true, ""
	}

	// resolve processo (por PR-AAAA-N, id ou unidade consumidora)
	idProc, cli, codPub, err := resolverProcesso(db, p.processoRef)
	if err != nil {
		return nil, "", false, err.Error()
	}
	cliente := sql.NullString{String: cli, Valid: true}
	if strings.HasPrefix(p.processoRef, "UC:") {
		p.processoRef = codPub // a ação guarda o processo resolvido, não a UC
	}

	if p.op == "movimentar" {
		return montarMov(db, p, idProc, cli, codPub)
	}

	if p.op == "recalcular_repasse" {
		// mantém o caminho determinístico de recálculo no executor (usa percentual).
		a := &Acao{Op: "recalcular_repasse", Processo: p.processoRef, IdProcesso: idProc, Cliente: cliente.String, Rotulo: "recalcular repasse"}
		return a, fmt.Sprintf("Recalcular o repasse do processo %d (%s) pelo percentual do cliente.", idProc, cliente.String), true, ""
	}

	if p.op == "inserir_historico" {
		a := &Acao{Op: "inserir_historico", Processo: p.processoRef, IdProcesso: idProc, Cliente: cliente.String,
			Rotulo: "inserir histórico", Comentario: p.comentario, DataHist: p.dataHist}
		quando := ""
		if p.dataHist != "" {
			quando = " (data " + p.dataHist + ")"
		}
		prev := p.comentario
		if len(prev) > 140 {
			prev = prev[:140] + "…"
		}
		return a, fmt.Sprintf("Inserir histórico no processo %d (%s)%s — mesma etapa, não muda status:\n\n%q", idProc, cliente.String, quando, prev), true, ""
	}

	f := p.field
	a := &Acao{Op: "editar_processo", Processo: p.processoRef, IdProcesso: idProc, Cliente: cliente.String, Rotulo: f.rotulo}

	for _, tab := range f.tabelas {
		if tab == tDefer {
			// precisa de exatamente 1 deferimento (senão ambíguo → revisão)
			var n int
			_ = db.QueryRow(`SELECT COUNT(*) FROM FT_DEFERIMENTOS WHERE id_processo=?`, idProc).Scan(&n)
			if n == 0 {
				continue // sem deferimento: grava só em FT_PROCESSOS
			}
			if n > 1 {
				return nil, "", false, fmt.Sprintf("processo %d tem %d deferimentos; ajuste a instância manualmente", idProc, n)
			}
			var idDef int64
			var antes sql.NullString
			if err := db.QueryRow(fmt.Sprintf("SELECT id_deferimento, CAST(`%s` AS CHAR) FROM FT_DEFERIMENTOS WHERE id_processo=?", f.coluna), idProc).Scan(&idDef, &antes); err != nil {
				return nil, "", false, "erro ao ler deferimento: " + err.Error()
			}
			a.Alteracoes = append(a.Alteracoes, Alt{
				Tabela: tDefer, Coluna: f.coluna, Tipo: f.tipo, PkColuna: "id_deferimento", PkValor: fmt.Sprint(idDef),
				ValorTxt: p.valorTxt, Antes: antes.String,
				Preview: fmt.Sprintf("%s: %s → %s", f.rotulo, displayAntes(f.tipo, antes), displayValor(f.tipo, p.valorTxt)),
			})
		} else { // FT_PROCESSOS
			var antes sql.NullString
			if err := db.QueryRow(fmt.Sprintf("SELECT CAST(`%s` AS CHAR) FROM FT_PROCESSOS WHERE id_processo=?", f.coluna), idProc).Scan(&antes); err != nil {
				return nil, "", false, "erro ao ler processo: " + err.Error()
			}
			a.Alteracoes = append(a.Alteracoes, Alt{
				Tabela: tProc, Coluna: f.coluna, Tipo: f.tipo, PkColuna: "id_processo", PkValor: fmt.Sprint(idProc),
				ValorTxt: p.valorTxt, Antes: antes.String,
				Preview: fmt.Sprintf("%s: %s → %s", f.rotulo, displayAntes(f.tipo, antes), displayValor(f.tipo, p.valorTxt)),
			})
		}
	}
	if len(a.Alteracoes) == 0 {
		return nil, "", false, "nada a alterar"
	}

	// preview geral (dedup — tabelas espelhadas mostram o mesmo antes→depois)
	prev := fmt.Sprintf("Processo %d (%s) — %s", idProc, cliente.String, a.Alteracoes[0].Preview)
	return a, prev, true, ""
}

func displayAntes(tipo string, antes sql.NullString) string {
	if !antes.Valid || antes.String == "" {
		return "(vazio)"
	}
	if tipo == "decimal" {
		if v, err := strconv.ParseFloat(antes.String, 64); err == nil {
			return formatBR(v)
		}
	}
	if tipo == "date" {
		if m := reDataISO.FindStringSubmatch(antes.String); m != nil {
			return m[3] + "/" + m[2] + "/" + m[1]
		}
	}
	if tipo == "bool" {
		return boolBR(antes.String)
	}
	return antes.String
}

// reEscrita: verbos que indicam ALTERAÇÃO de dado — esses pedidos sempre passam pela
// aprovação do gestor. ("gerar relatório" NÃO é escrita: gerar/montar/listar ficam de fora.)
var reEscrita = regexp.MustCompile(`\b(atualiz(ar|e|a)|alter(ar|e|a)|corrig(ir|e|a)|ajust(ar|e|a)|mud(ar|e|a)|mover|mova|movimentar|movimente|inserir|insira|adicion(ar|e)|registr(ar|e)|inclu(ir|a)|lanc(ar|e)|recalcul(ar|e)|grav(ar|e)|defin(ir|a)|troc(ar|e)|colocar|coloque|coloca|ponha|por o|exclu(ir|a)|apag(ar|ue)|delet(ar|e)|remov(er|a)|cancel(ar|e)|encerr(ar|e)|deferir|defira|indeferir|indefira|aprov(ar|e)|reprov(ar|e)|transfer(ir|a)|avanc(ar|e)|volt(ar|e)|reabr(ir|a)|suspend(er|a)|vincul(ar|e)|desvincul(ar|e)|envi(ar|e) (o |um )?e-?mail)\b`)

// EhLeitura diz se o pedido é SÓ LEITURA (consulta/relatório) — esses não precisam da
// aprovação do gestor. Com ação estruturada, só o relatório é leitura; sem ação (pedido
// livre que vai p/ o worker), é leitura se não houver verbo de alteração.
func EhLeitura(msg string, acao *Acao) bool {
	if acao != nil {
		return acao.Op == "relatorio"
	}
	n := norm(msg)
	return strings.TrimSpace(n) != "" && !reEscrita.MatchString(n)
}

// ── Tarefas conhecidas (rodadas no host da VPS por worker/run_jobs.py) ─────────
var (
	reJobVerbo = regexp.MustCompile(`\b(rod\w*|execut\w*|sincroniz\w*|atualiz\w*|import\w*|puxa\w*|traz\w*|traga)\b`)
	reJobAgua  = regexp.MustCompile(`agua_sync|agua sync|sync (de |da )?agua|faturas? (de |da )agua|sincroniz\w* .{0,30}agua`)
	reEmpresas = regexp.MustCompile(`empresas?[^\d]{0,25}((?:\d{1,5}[\s,;e]*)+)`) // "empresas: 4 14…" / "as empresas são as 4 14…"
	reNumero   = regexp.MustCompile(`\d{1,5}`)
)

// interpretarJob reconhece "rode o agua_sync … empresas 4 14 32 …" → job + lista de empresas.
func interpretarJob(n string) (map[string]string, bool) {
	if !reJobAgua.MatchString(n) || !reJobVerbo.MatchString(n) {
		return nil, false
	}
	params := map[string]string{"job": "agua_sync"}
	if m := reEmpresas.FindStringSubmatch(n); m != nil {
		var lst []string
		vistos := map[string]bool{}
		for _, x := range reNumero.FindAllString(m[1], -1) {
			if !vistos[x] {
				vistos[x] = true
				lst = append(lst, x)
			}
		}
		if len(lst) > 0 {
			params["empresas"] = strings.Join(lst, ",")
		}
	}
	return params, true
}
