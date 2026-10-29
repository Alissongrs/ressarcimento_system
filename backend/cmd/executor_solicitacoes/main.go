// Command executor_solicitacoes é o AGENTE AUTÔNOMO que executa, sem depender de
// uma sessão do Claude, as solicitações que o gestor APROVOU no painel
// "Solicitações ao sistema" (pedidos feitos no chat com a tag #sistema).
//
// Modelo de segurança (escolhido pelo usuário):
//   - LIMITADOR: só são permitidas alterações em PROCESSOS. O write só grava em
//     tabelas da allowlist (tabelasPermitidas = FT_PROCESSOS, FT_DEFERIMENTOS);
//     qualquer op que tente tocar outra tabela é recusada → 'revisao'.
//   - WHITELIST: só executa um conjunto fixo de operações conhecidas, cada uma
//     determinística, validada e com backup. Qualquer pedido que não casa com a
//     whitelist vira status='revisao' (NÃO é executado) — um humano trata.
//   - IDEMPOTENTE: só pega status='aprovado' AND executado_em IS NULL. Depois de
//     executar marca status='executado' + executado_em=NOW() (a "sinalização de
//     já executado" que o usuário pediu), então nunca roda o mesmo pedido 2x.
//   - LOG + BACKUP/UNDO: todo valor alterado é gravado em FT_EXECUTOR_BACKUP com
//     nome do solicitante (usuario_nome), horário (criado_em) e valor_antigo/
//     valor_novo antes do UPDATE. O id_solicitacao é o PROTOCOLO: no chat,
//     "#protocolo <id>" mostra o que foi pedido e permite reverter.
//
// Whitelist atual (v1):
//
//	repasse  — "repasse ... processo <N>" (ou "PR-AAAA-NNNNNN").
//	           Preenche repasse_simples/repasse_dobro em FT_DEFERIMENTOS que
//	           estão NULL, recalculando credito × percentual do cliente
//	           (DM_EMPRESA_PERCENTUAL). Nunca sobrescreve repasse já preenchido.
//	           Se o percentual do cliente não for único/claro → 'revisao'.
//
// Uso na VPS (Ofelia/crontab chama isto, a cada N minutos):
//
//	cd /caminho/do/repo/backend && ./executor_solicitacoes
//
// Lê a conexão do backend/.env. Flags: -dry (não grava, só mostra o que faria).
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/joho/godotenv"

	"ressarcimento-backend/database"
	handlersV2 "ressarcimento-backend/handlers/v2"
	"ressarcimento-backend/procedit"
)

func loadEnv() {
	candidates := []string{".env", filepath.Join("backend", ".env")}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), ".env"), filepath.Join(filepath.Dir(exe), "backend", ".env"))
	}
	for _, p := range candidates {
		if godotenv.Load(p) == nil {
			log.Printf("[executor] .env carregado de %s", p)
			return
		}
	}
	log.Println("[executor] aviso: .env não carregado — usando variáveis do ambiente")
}

var dryRun bool

func main() {
	flag.BoolVar(&dryRun, "dry", false, "não grava nada; apenas mostra o que faria")
	flag.Parse()

	loadEnv()
	database.InitDBs()
	db := database.DB_App
	if db == nil {
		log.Fatal("[executor] DB_App nulo")
	}
	if err := ensureBackupTable(db); err != nil {
		log.Fatalf("[executor] ensureBackupTable: %v", err)
	}

	rows, err := db.Query(`SELECT id, COALESCE(usuario_nome,''), mensagem, COALESCE(acao_json,'')
		FROM FT_SOLICITACOES
		WHERE status='aprovado' AND executado_em IS NULL
		ORDER BY id`)
	if err != nil {
		log.Fatalf("[executor] query pendentes: %v", err)
	}
	type pend struct {
		id    int64
		user  string
		msg   string
		acaoJ string
	}
	var fila []pend
	for rows.Next() {
		var p pend
		if err := rows.Scan(&p.id, &p.user, &p.msg, &p.acaoJ); err != nil {
			log.Printf("[executor] scan: %v", err)
			continue
		}
		fila = append(fila, p)
	}
	rows.Close()

	if len(fila) == 0 {
		log.Println("[executor] nada a fazer (0 aprovadas)")
		return
	}
	log.Printf("[executor] %d solicitação(ões) aprovada(s) para processar", len(fila))

	for _, p := range fila {
		log.Printf("[executor] #%d (%s): %q", p.id, p.user, oneline(p.msg))
		status, resultado := handle(db, p.id, p.user, p.msg, p.acaoJ)
		if status == "" {
			log.Printf("[executor] #%d → deixado para o run_jobs da VPS", p.id)
			continue
		}
		if dryRun {
			log.Printf("[executor] #%d DRY → status=%s resultado=%s", p.id, status, resultado)
			continue
		}
		// 'revisao' = NÃO executado (passa para a fila do worker tier-2) → mantém
		// executado_em NULL, senão o worker não enxerga (filtro executado_em IS NULL).
		q := `UPDATE FT_SOLICITACOES SET status=?, resultado=?, executado_em=NOW() WHERE id=?`
		if status == "revisao" {
			q = `UPDATE FT_SOLICITACOES SET status=?, resultado=? WHERE id=?`
		}
		if _, err := db.Exec(q, status, resultado, p.id); err != nil {
			log.Printf("[executor] #%d falha ao marcar status: %v", p.id, err)
			continue
		}
		log.Printf("[executor] #%d → %s | %s", p.id, strings.ToUpper(status), resultado)
	}
}

// tabelasPermitidas é o LIMITADOR: o executor só pode gravar em tabelas ligadas
// a PROCESSO. Qualquer op futura que tente outra tabela é bloqueada no backup().
var tabelasPermitidas = map[string]bool{
	"FT_PROCESSOS":    true,
	"FT_DEFERIMENTOS": true,
	"DM_META_REPASSE": true, // metas-alvo do sistema (op editar_meta, só colunas meta_*)
}

// handle roteia a solicitação. Prioriza a AÇÃO ESTRUTURADA (acao_json, montada no
// chat e aprovada pelo gestor); só cai no texto como fallback. Retorna (status, resultado).
// status ∈ {executado, revisao, erro}.
func handle(db *sql.DB, solID int64, user, msg, acaoJSON string) (string, string) {
	// --- Mix A+B: ação já estruturada e aprovada ---
	if strings.TrimSpace(acaoJSON) != "" {
		var a procedit.Acao
		if err := json.Unmarshal([]byte(acaoJSON), &a); err != nil {
			return "revisao", "Ação estruturada ilegível; requer execução manual."
		}
		switch a.Op {
		case "recalcular_repasse":
			return opRepasse(db, solID, user, a.Processo)
		case "editar_processo":
			return opEditarProcesso(db, solID, user, &a)
		case "editar_meta":
			// mesma máquina determinística: valida contra CamposPermitidos (que já inclui
			// DM_META_REPASSE.meta_*) e grava via aplicar() (backup + limitador de tabela).
			return opEditarProcesso(db, solID, user, &a)
		case "relatorio":
			return opRelatorio(db, &a)
		case "inserir_historico":
			return opInserirHistorico(db, solID, user, &a)
		case "movimentar":
			return opMovimentar(db, solID, user, &a)
		case "rodar_job":
			// tarefa conhecida (ex.: agua_sync) roda no HOST da VPS (worker/run_jobs.py), não aqui
			return "", ""
		default:
			return "revisao", "Operação não suportada pela whitelist; requer execução manual."
		}
	}

	// --- Fallback por texto (quando não houve interpretação estruturada) ---
	low := strings.ToLower(msg)
	if strings.Contains(low, "repasse") {
		proc, ok := extractProcesso(msg)
		if !ok {
			return "revisao", "Operação 'repasse' reconhecida, mas não consegui identificar o número do processo. Requer execução manual."
		}
		return opRepasse(db, solID, user, proc)
	}
	return "revisao", "Pedido não reconhecido pela whitelist de operações automáticas. Requer execução manual."
}

// opEditarProcesso aplica a ação estruturada de edição de campos de processo.
// Cada alteração é validada contra a whitelist de CAMPOS (procedit) e gravada pela
// aplicar() (limitador de TABELA + backup + transação). "aprovou = feito".
func opEditarProcesso(db *sql.DB, solID int64, user string, a *procedit.Acao) (string, string) {
	if len(a.Alteracoes) == 0 {
		return "revisao", "Ação sem alterações; requer execução manual."
	}
	permitidos := procedit.CamposPermitidos()

	// agrupa por (tabela, pk) p/ um UPDATE por linha
	type chave struct{ tab, pkCol, pkVal string }
	grupos := map[chave][]campo{}
	ordem := []chave{}
	var detalhes []string
	for _, alt := range a.Alteracoes {
		tipo, ok := permitidos[alt.Tabela+"."+alt.Coluna]
		if !ok || tipo != alt.Tipo {
			return "revisao", fmt.Sprintf("Campo %s.%s fora da whitelist de processos; requer execução manual.", alt.Tabela, alt.Coluna)
		}
		val, err := procedit.ConverterValor(alt.Tipo, alt.ValorTxt)
		if err != nil {
			return "revisao", "Valor inválido (" + err.Error() + "); requer execução manual."
		}
		k := chave{alt.Tabela, alt.PkColuna, alt.PkValor}
		if _, seen := grupos[k]; !seen {
			ordem = append(ordem, k)
		}
		grupos[k] = append(grupos[k], campo{alt.Coluna, alt.Antes, val, newTxtOf(alt)})
		detalhes = append(detalhes, alt.Preview)
	}

	if dryRun {
		return "executado", fmt.Sprintf("[DRY] Processo %d: %s", a.IdProcesso, strings.Join(dedup(detalhes), "; "))
	}

	for _, k := range ordem {
		if err := aplicar(db, solID, user, "editar_processo", k.tab, k.pkCol, k.pkVal, grupos[k]); err != nil {
			if strings.HasPrefix(err.Error(), "limitador:") {
				return "revisao", "Bloqueado pelo limitador: somente processos podem ser alterados."
			}
			return "erro", fmt.Sprintf("falha ao aplicar em %s: %v", k.tab, err)
		}
	}
	return "executado", fmt.Sprintf("Processo %d (%s): %s", a.IdProcesso, a.Cliente, strings.Join(dedup(detalhes), "; "))
}

// opInserirHistorico grava um HISTÓRICO mesma-etapa (não muda status/etapa) no processo
// e anexa ao processo os arquivos que vieram com o pedido. Transação + backup p/ reversão.
func opInserirHistorico(db *sql.DB, solID int64, user string, a *procedit.Acao) (string, string) {
	if strings.TrimSpace(a.Comentario) == "" {
		return "revisao", "Histórico sem texto; requer execução manual."
	}
	// snapshot atual — o histórico mantém a MESMA etapa/status/instância/aprovação.
	var et, inst, st, apr sql.NullInt64
	if err := db.QueryRow(
		`SELECT id_etapa_atual, id_instancia_atual, id_status_atual, id_aprovacao_atual FROM FT_PROCESSOS WHERE id_processo=?`,
		a.IdProcesso).Scan(&et, &inst, &st, &apr); err != nil {
		return "revisao", fmt.Sprintf("Processo %d não encontrado: %v. Requer execução manual.", a.IdProcesso, err)
	}
	if dryRun {
		return "executado", fmt.Sprintf("[DRY] histórico no processo %d: %q", a.IdProcesso, oneline(a.Comentario))
	}

	tx, err := db.Begin()
	if err != nil {
		return "erro", err.Error()
	}
	defer func() { _ = tx.Rollback() }()

	var dataArg interface{}
	if a.DataHist != "" {
		dataArg = a.DataHist
	}
	res, err := tx.Exec(`INSERT INTO FT_HISTORICO_MOVIMENTACOES
		(id_processo, id_usuario_gestor,
		 id_etapa_anterior, id_instancia_anterior, id_status_anterior, id_aprovacao_anterior,
		 id_etapa_nova, id_instancia_nova, id_status_novo, id_aprovacao_nova,
		 tipo_movimentacao, comentario, data_movimentacao)
		 VALUES (?, NULL, ?,?,?,?, ?,?,?,?, 'manual', ?, COALESCE(?, NOW()))`,
		a.IdProcesso, ni(et), ni(inst), ni(st), ni(apr), ni(et), ni(inst), ni(st), ni(apr), a.Comentario, dataArg)
	if err != nil {
		return "erro", "insert histórico: " + err.Error()
	}
	histID, _ := res.LastInsertId()
	backupInsert(tx, solID, user, "inserir_historico", "FT_HISTORICO_MOVIMENTACOES", "id_historico", fmt.Sprint(histID))

	// copia os anexos do pedido → anexos do processo (FT_ANEXOS)
	type anx struct {
		nome, mime string
		tam        int
		cont       []byte
	}
	var lista []anx
	if rows, e := tx.Query(`SELECT nome, COALESCE(mime,''), COALESCE(tamanho,0), conteudo FROM FT_SOLICITACOES_ANEXOS WHERE id_solicitacao=?`, solID); e == nil {
		for rows.Next() {
			var x anx
			if err := rows.Scan(&x.nome, &x.mime, &x.tam, &x.cont); err == nil {
				lista = append(lista, x)
			}
		}
		rows.Close()
	}
	for _, x := range lista {
		r2, err := tx.Exec(`INSERT INTO FT_ANEXOS
			(id_processo, nome_arquivo, caminho_arquivo, enviado_por, data_upload, mime_type, tamanho_bytes, arquivo_blob)
			VALUES (?, ?, NULL, NULL, NOW(), ?, ?, ?)`,
			a.IdProcesso, x.nome, x.mime, x.tam, x.cont)
		if err != nil {
			return "erro", "copiar anexo: " + err.Error()
		}
		aid, _ := r2.LastInsertId()
		backupInsert(tx, solID, user, "inserir_historico", "FT_ANEXOS", "id_anexo", fmt.Sprint(aid))
	}

	if err := tx.Commit(); err != nil {
		return "erro", "commit: " + err.Error()
	}
	msg := fmt.Sprintf("Processo %d (%s): histórico inserido (hist #%d)", a.IdProcesso, a.Cliente, histID)
	if len(lista) > 0 {
		msg += fmt.Sprintf(" + %d anexo(s) no processo", len(lista))
	}
	return "executado", msg + "."
}

// opMovimentar move o processo (etapa/instância/status/aprovação) pelo MESMO núcleo do
// Kanban (v2.MovimentarCoreHist): valida a transição (sem pular etapa; Encerramento só
// com Deferido/Indeferido) e grava FT_HISTORICO_MOVIMENTACOES + FT_PROCESSOS numa única
// transação — status/etapa nunca dessincronizam do histórico. Depois registra o backup
// (linha de histórico inserida + ponteiros antigos) p/ "#protocolo N" poder reverter.
func opMovimentar(db *sql.DB, solID int64, user string, a *procedit.Acao) (string, string) {
	m := a.Mov
	if m == nil || a.IdProcesso == 0 || m.EtapaID < 1 || m.EtapaID > 6 || m.StatusID < 1 {
		return "revisao", "Movimentação incompleta; requer execução manual."
	}
	var et, inst, st, apr sql.NullInt64
	if err := db.QueryRow(`SELECT id_etapa_atual, id_instancia_atual, id_status_atual, id_aprovacao_atual
		FROM FT_PROCESSOS WHERE id_processo=?`, a.IdProcesso).Scan(&et, &inst, &st, &apr); err != nil {
		return "revisao", fmt.Sprintf("Processo %d não encontrado: %v. Requer execução manual.", a.IdProcesso, err)
	}
	// o processo mudou entre a prévia e a execução? não sobrescreve — manda p/ revisão
	mesmo := func(n sql.NullInt64, p *int) bool {
		if p == nil {
			return !n.Valid || n.Int64 == 0
		}
		return n.Valid && int(n.Int64) == *p
	}
	if int(et.Int64) != m.EtapaAntes || !mesmo(inst, m.InstanciaAntes) || !mesmo(st, m.StatusAntes) || !mesmo(apr, m.AprovacaoAntes) {
		return "revisao", fmt.Sprintf("O processo %s foi movimentado depois do pedido (estado atual diferente da prévia). Refaça o pedido para conferir a nova prévia.", a.Processo)
	}
	if dryRun {
		return "executado", fmt.Sprintf("[DRY] Processo %s (%s): %s", a.Processo, a.Cliente, m.DePara)
	}

	coment := strings.TrimSpace(a.Comentario)
	origem := fmt.Sprintf("[via chat · pedido de %s · protocolo #%d]", user, solID)
	if coment == "" {
		coment = origem
	} else {
		coment = coment + " " + origem
	}
	req := handlersV2.MovimentarRequest{
		EtapaID: m.EtapaID, InstanciaID: m.InstanciaID, StatusID: m.StatusID,
		AprovacaoID: m.AprovacaoID, Comentario: coment,
	}
	histID, err := handlersV2.MovimentarCoreHist(context.Background(), db, int(a.IdProcesso), req, 0)
	if err != nil {
		switch err {
		case handlersV2.ErrEtapaTerminal:
			return "revisao", "O processo já está em Encerramento (etapa terminal) — não pode ser movimentado."
		case handlersV2.ErrEncerramentoSemAprov:
			return "revisao", "Para encerrar é preciso dizer 'deferido' ou 'indeferido'."
		case handlersV2.ErrEtapaPularNaoPermitido:
			return "revisao", "Não é permitido pular etapas — mova uma etapa por vez."
		}
		return "erro", "falha ao movimentar: " + err.Error()
	}

	// backup p/ reversão: linha de histórico inserida + ponteiros antigos do processo
	if tx, err := db.Begin(); err == nil {
		backupInsert(tx, solID, user, "movimentar", "FT_HISTORICO_MOVIMENTACOES", "id_historico", fmt.Sprint(histID))
		nv := func(p *int) string {
			if p == nil {
				return ""
			}
			return fmt.Sprint(*p)
		}
		et0, st0 := fmt.Sprint(m.EtapaAntes), nv(m.StatusAntes)
		for _, c := range []struct{ col, antes, novo string }{
			{"id_etapa_atual", et0, fmt.Sprint(m.EtapaID)},
			{"id_instancia_atual", nv(m.InstanciaAntes), nv(m.InstanciaID)},
			{"id_status_atual", st0, fmt.Sprint(m.StatusID)},
			{"id_aprovacao_atual", nv(m.AprovacaoAntes), nv(m.AprovacaoID)},
		} {
			_, _ = tx.Exec(`INSERT INTO FT_EXECUTOR_BACKUP
				(id_solicitacao, usuario_nome, acao, tabela, pk_coluna, pk_valor, coluna, valor_antigo, valor_novo)
				VALUES (?,?,'movimentar','FT_PROCESSOS','id_processo',?,?,?,?)`,
				solID, user, fmt.Sprint(a.IdProcesso), c.col, c.antes, c.novo)
		}
		_ = tx.Commit()
	}
	return "executado", fmt.Sprintf("Processo %s (%s) movimentado — %s (hist #%d).", a.Processo, a.Cliente, m.DePara, histID)
}

func ni(n sql.NullInt64) interface{} {
	if n.Valid {
		return n.Int64
	}
	return nil
}

// backupInsert registra uma LINHA INSERIDA (p/ reversão por DELETE). coluna='__inserido__'.
func backupInsert(tx *sql.Tx, solID int64, user, acao, tabela, pkCol, pkVal string) {
	_, _ = tx.Exec(`INSERT INTO FT_EXECUTOR_BACKUP
		(id_solicitacao, usuario_nome, acao, tabela, pk_coluna, pk_valor, coluna, valor_antigo, valor_novo)
		VALUES (?,?,?,?,?,?, '__inserido__', '', '(linha inserida)')`,
		solID, user, acao, tabela, pkCol, pkVal)
}

// opRelatorio executa um relatório (SOMENTE LEITURA) e devolve a tabela formatada
// em markdown no resultado — que aparece no chat de quem pediu. Não grava nada.
func opRelatorio(db *sql.DB, a *procedit.Acao) (string, string) {
	tabs, resumo, err := procedit.RunRelatorioAbas(db, a.Relatorio, a.Params)
	if err != nil {
		return "erro", "falha ao gerar relatório: " + err.Error()
	}
	return "executado", procedit.FormatarResultado(tabs, resumo, 3000) // teto por aba; a lista da página Protocolos ANEEL passa de 1.200
}

func newTxtOf(alt procedit.Alt) string {
	// texto do valor novo p/ o log: usa o ValorTxt canônico (decimal/date/texto)
	if alt.Tipo == "date" {
		if len(alt.ValorTxt) == 10 {
			return alt.ValorTxt[8:10] + "/" + alt.ValorTxt[5:7] + "/" + alt.ValorTxt[0:4]
		}
	}
	return alt.ValorTxt
}

func dedup(ss []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range ss {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// opRepasse preenche repasse_simples/dobro NULOS de um processo recalculando
// credito × percentual do cliente. Só preenche NULL (nunca sobrescreve). Backup.
func opRepasse(db *sql.DB, solID int64, user, procRef string) (string, string) {
	idProc, cliente, err := resolveProcesso(db, procRef)
	if err != nil {
		return "revisao", fmt.Sprintf("Processo '%s' não encontrado: %v. Requer execução manual.", procRef, err)
	}

	ps, pd, perr := percentualCliente(db, cliente)
	if perr != nil {
		return "revisao", fmt.Sprintf("Processo %d (cliente %q): %v. Requer execução manual.", idProc, cliente, perr)
	}

	rows, err := db.Query(`SELECT id_deferimento, credito_simples, credito_dobro, repasse_simples, repasse_dobro
		FROM FT_DEFERIMENTOS WHERE id_processo=?`, idProc)
	if err != nil {
		return "erro", fmt.Sprintf("erro ao ler deferimentos do processo %d: %v", idProc, err)
	}
	type defRow struct {
		id     int64
		cs, cd sql.NullFloat64
		rs, rd sql.NullFloat64
	}
	var defs []defRow
	for rows.Next() {
		var d defRow
		if err := rows.Scan(&d.id, &d.cs, &d.cd, &d.rs, &d.rd); err != nil {
			rows.Close()
			return "erro", fmt.Sprintf("scan deferimento: %v", err)
		}
		defs = append(defs, d)
	}
	rows.Close()

	if len(defs) == 0 {
		return "revisao", fmt.Sprintf("Processo %d não tem deferimentos. Requer execução manual.", idProc)
	}

	var changed int
	var detalhes []string
	for _, d := range defs {
		newRS, newRD := d.rs, d.rd
		did := false
		if !d.rs.Valid && d.cs.Valid { // só preenche NULL
			newRS = sql.NullFloat64{Float64: round2(d.cs.Float64 * ps / 100.0), Valid: true}
			did = true
		}
		if !d.rd.Valid && d.cd.Valid {
			newRD = sql.NullFloat64{Float64: round2(d.cd.Float64 * pd / 100.0), Valid: true}
			did = true
		}
		if !did {
			continue
		}
		if dryRun {
			detalhes = append(detalhes, fmt.Sprintf("def %d: rs→%s rd→%s", d.id, fval(newRS), fval(newRD)))
			changed++
			continue
		}
		// aplicar() é o ÚNICO ponto que grava — o LIMITADOR (só processos) vive lá.
		campos := []campo{
			{"repasse_simples", fval(d.rs), nf(newRS), fval(newRS)},
			{"repasse_dobro", fval(d.rd), nf(newRD), fval(newRD)},
		}
		if err := aplicar(db, solID, user, "repasse", "FT_DEFERIMENTOS", "id_deferimento", fmt.Sprint(d.id), campos); err != nil {
			if strings.HasPrefix(err.Error(), "limitador:") {
				return "revisao", "Bloqueado pelo limitador: somente processos podem ser alterados."
			}
			return "erro", fmt.Sprintf("falha ao aplicar no deferimento %d: %v", d.id, err)
		}
		detalhes = append(detalhes, fmt.Sprintf("def %d: repasse_simples=%s repasse_dobro=%s", d.id, fval(newRS), fval(newRD)))
		changed++
	}

	if changed == 0 {
		return "executado", fmt.Sprintf("Processo %d (cliente %q, %.0f%%/%.0f%%): repasse já estava preenchido; nada a fazer.", idProc, cliente, ps, pd)
	}
	return "executado", fmt.Sprintf("Processo %d (cliente %q, percentual %.0f%% simples / %.0f%% dobro): %d deferimento(s) atualizado(s). %s", idProc, cliente, ps, pd, changed, strings.Join(detalhes, "; "))
}

// resolveProcesso aceita um id numérico ou um codigo_publico (PR-AAAA-NNNNNN).
func resolveProcesso(db *sql.DB, ref string) (int64, string, error) {
	ref = strings.TrimSpace(ref)
	var id int64
	var cliente sql.NullString
	if reCodigoPub.MatchString(ref) {
		err := db.QueryRow(`SELECT id_processo, cliente FROM FT_PROCESSOS WHERE codigo_publico=?`, ref).Scan(&id, &cliente)
		if err != nil {
			return 0, "", err
		}
		return id, cliente.String, nil
	}
	err := db.QueryRow(`SELECT id_processo, cliente FROM FT_PROCESSOS WHERE id_processo=?`, ref).Scan(&id, &cliente)
	if err != nil {
		return 0, "", err
	}
	return id, cliente.String, nil
}

// percentualCliente acha o percentual do cliente de forma CONSERVADORA: precisa
// de exatamente um par (simples,dobro) não-nulo entre as linhas ativas cujo
// nome_empresa casa (normalizado) com o cliente. Ambíguo/ausente → erro.
func percentualCliente(db *sql.DB, cliente string) (float64, float64, error) {
	nc := normNome(cliente)
	if nc == "" {
		return 0, 0, fmt.Errorf("cliente vazio no processo")
	}
	rows, err := db.Query(`SELECT nome_empresa, percentual_simples, percentual_dobro
		FROM DM_EMPRESA_PERCENTUAL
		WHERE ativo=1 AND percentual_simples IS NOT NULL AND percentual_dobro IS NOT NULL`)
	if err != nil {
		return 0, 0, err
	}
	defer rows.Close()
	type pc struct{ s, d float64 }
	matches := map[pc]bool{}
	for rows.Next() {
		var nome sql.NullString
		var ps, pd sql.NullFloat64
		if err := rows.Scan(&nome, &ps, &pd); err != nil {
			return 0, 0, err
		}
		nn := normNome(nome.String)
		if len(nn) < 3 {
			continue
		}
		if nc == nn || strings.HasPrefix(nc, nn+" ") || strings.HasPrefix(nn, nc+" ") {
			matches[pc{ps.Float64, pd.Float64}] = true
		}
	}
	if len(matches) == 0 {
		return 0, 0, fmt.Errorf("percentual não cadastrado para o cliente (DM_EMPRESA_PERCENTUAL)")
	}
	if len(matches) > 1 {
		return 0, 0, fmt.Errorf("percentual ambíguo (%d combinações diferentes casam com o nome)", len(matches))
	}
	for k := range matches {
		return k.s, k.d, nil
	}
	return 0, 0, fmt.Errorf("inesperado")
}

// --- helpers ---

var (
	reCodigoPub = regexp.MustCompile(`(?i)^PR-\d{4}-\d+$`)
	reProcNum   = regexp.MustCompile(`(?i)processos?\s*(?:n[ºo.]*\s*)?#?\s*(\d{3,9})`)
	rePRcode    = regexp.MustCompile(`(?i)(PR-\d{4}-\d+)`)
	reHashNum   = regexp.MustCompile(`#\s*(\d{3,9})`)
	reNonAlnum  = regexp.MustCompile(`[^A-Z0-9]+`)
)

// extractProcesso pega "PR-AAAA-NNNNNN", ou "processo 18789", ou "#18789".
func extractProcesso(msg string) (string, bool) {
	if m := rePRcode.FindStringSubmatch(msg); m != nil {
		return strings.ToUpper(m[1]), true
	}
	if m := reProcNum.FindStringSubmatch(msg); m != nil {
		return m[1], true
	}
	if m := reHashNum.FindStringSubmatch(msg); m != nil {
		return m[1], true
	}
	return "", false
}

var sufixos = map[string]bool{"SA": true, "S": true, "A": true, "LTDA": true, "ME": true, "EIRELI": true, "EPP": true, "CIA": true}

// normNome: upper, tira acentos comuns, tudo não-alfanumérico vira espaço, e
// remove sufixos societários do fim (SA, LTDA, ...).
func normNome(s string) string {
	s = strings.ToUpper(strings.TrimSpace(s))
	repl := strings.NewReplacer("Á", "A", "À", "A", "Â", "A", "Ã", "A", "É", "E", "Ê", "E", "Í", "I", "Ó", "O", "Ô", "O", "Õ", "O", "Ú", "U", "Ç", "C")
	s = repl.Replace(s)
	s = reNonAlnum.ReplaceAllString(s, " ")
	toks := strings.Fields(s)
	for len(toks) > 1 && sufixos[toks[len(toks)-1]] {
		toks = toks[:len(toks)-1]
	}
	return strings.Join(toks, " ")
}

func round2(f float64) float64 {
	if f < 0 {
		return -round2(-f)
	}
	return float64(int64(f*100+0.5)) / 100.0
}

func fval(n sql.NullFloat64) string {
	if !n.Valid {
		return "NULL"
	}
	return fmt.Sprintf("%.2f", n.Float64)
}

func nf(n sql.NullFloat64) interface{} {
	if !n.Valid {
		return nil
	}
	return n.Float64
}

func oneline(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > 120 {
		return s[:120] + "…"
	}
	return s
}

// campo é uma coluna a alterar: valor antigo (texto, p/ log), valor novo a gravar
// (nil = NULL) e o texto do valor novo (p/ log).
type campo struct {
	col    string
	oldTxt string
	val    interface{}
	newTxt string
}

var reIdent = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func identOK(s string) bool { return reIdent.MatchString(s) }

// aplicar é o ÚNICO ponto do executor que grava no banco. Aqui mora o LIMITADOR:
// só tabelas de PROCESSO (tabelasPermitidas) passam — qualquer outra é recusada,
// então nenhuma operação (atual ou futura) consegue alterar algo que não seja
// processo. Grava o backup (nome + horário + antigo→novo) e então o UPDATE, numa
// transação. Identificadores são validados (defesa contra injeção de nome).
func aplicar(db *sql.DB, solID int64, user, acao, tabela, pkCol, pkVal string, campos []campo) error {
	if !tabelasPermitidas[tabela] {
		return fmt.Errorf("limitador: tabela %q não permitida (somente processos)", tabela)
	}
	if !identOK(tabela) || !identOK(pkCol) {
		return fmt.Errorf("limitador: identificador inválido")
	}
	if len(campos) == 0 {
		return nil
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	sets := make([]string, 0, len(campos))
	args := make([]interface{}, 0, len(campos)+1)
	for _, cp := range campos {
		if !identOK(cp.col) {
			_ = tx.Rollback()
			return fmt.Errorf("limitador: coluna inválida %q", cp.col)
		}
		if _, err := tx.Exec(`INSERT INTO FT_EXECUTOR_BACKUP
			(id_solicitacao, usuario_nome, acao, tabela, pk_coluna, pk_valor, coluna, valor_antigo, valor_novo)
			VALUES (?,?,?,?,?,?,?,?,?)`, solID, user, acao, tabela, pkCol, pkVal, cp.col, cp.oldTxt, cp.newTxt); err != nil {
			_ = tx.Rollback()
			return err
		}
		sets = append(sets, fmt.Sprintf("`%s`=?", cp.col))
		args = append(args, cp.val)
	}
	args = append(args, pkVal)
	q := fmt.Sprintf("UPDATE `%s` SET %s WHERE `%s`=?", tabela, strings.Join(sets, ", "), pkCol)
	if _, err := tx.Exec(q, args...); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func ensureBackupTable(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS FT_EXECUTOR_BACKUP (
		id BIGINT NOT NULL AUTO_INCREMENT,
		id_solicitacao BIGINT,
		usuario_nome VARCHAR(255),
		acao VARCHAR(32),
		tabela VARCHAR(64),
		pk_coluna VARCHAR(64),
		pk_valor VARCHAR(64),
		coluna VARCHAR(64),
		valor_antigo TEXT,
		valor_novo TEXT,
		criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		revertido_em DATETIME NULL,
		PRIMARY KEY (id),
		KEY k_solic (id_solicitacao)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
	return err
}
