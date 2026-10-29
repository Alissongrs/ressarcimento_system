// Package whatsapp — WhatsApp da empresa conectado ao SURE por QR code (pedido do Alisson, 25/10/2026).
//
// É um número só, do departamento. O admin abre a página WhatsApp, escaneia o QR com esse celular
// (Aparelhos conectados) e o servidor passa a funcionar como um "WhatsApp Web": grava as mensagens em
// FT_WHATSAPP_MENSAGENS para monitorar dentro do sistema, avisa na tela do SURE quando chega mensagem
// nova e permite responder pela tela. Os avisos das tarefas vão para um grupo do WhatsApp escolhido
// pelo admin (onde está a equipe do departamento) — FT_WHATSAPP_CONFIG chave 'grupo_avisos'.
//
// A sessão (chaves do aparelho conectado) fica num SQLite em WHATSAPP_DIR (volume próprio no Docker,
// fora de /app/uploads, que é público). Nada da sessão vai para o MySQL.
// WHATSAPP_DESLIGADO=1 desliga tudo (ex.: backend local apontando para o banco de produção).
//
// Usa a mesma conexão do WhatsApp Web (biblioteca whatsmeow), não a API oficial do Meta: o número
// pode ser bloqueado pelo WhatsApp se mandar mensagens em massa — o SURE só envia o que o admin digita.
package whatsapp

import (
	"context"
	"database/sql"
	"encoding/base64"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"ressarcimento-backend/database"
	"ressarcimento-backend/rotinas"

	"github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite"
)

// Estado é o que a página mostra.
type Estado struct {
	Ligado     bool       `json:"ligado"`    // false = WHATSAPP_DESLIGADO ou falha ao abrir a sessão
	Conectado  bool       `json:"conectado"` // socket aberto e com aparelho vinculado
	Vinculado  bool       `json:"vinculado"` // existe aparelho vinculado (mesmo que caído agora)
	Numero     string     `json:"numero"`
	Nome       string     `json:"nome"`
	QR         string     `json:"qr"` // data:image/png;base64,… enquanto espera o escaneamento
	QRExpiraEm *time.Time `json:"qr_expira_em"`
	Erro       string     `json:"erro"`
	Desde      *time.Time `json:"desde"`
}

var (
	mu        sync.Mutex
	container *sqlstore.Container
	cli       *whatsmeow.Client
	est       = Estado{}
	nomesGrp  = map[string]string{}
)

func gdb() *sql.DB {
	if database.GormDB_App == nil {
		return nil
	}
	d, _ := database.GormDB_App.DB()
	return d
}

// Iniciar abre a sessão salva e reconecta se já houver aparelho vinculado. Chamado no boot.
func Iniciar() {
	if os.Getenv("WHATSAPP_DESLIGADO") == "1" {
		log.Printf("[whatsapp] desligado (WHATSAPP_DESLIGADO=1)")
		return
	}
	dir := os.Getenv("WHATSAPP_DIR")
	if dir == "" {
		dir = "./whatsapp_sessao"
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		setErro("pasta da sessão: " + err.Error())
		return
	}
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "sessao.db")+
		"?_pragma=foreign_keys(1)&_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)")
	if err != nil {
		setErro("sessão: " + err.Error())
		return
	}
	c := sqlstore.NewWithDB(db, "sqlite3", waLog.Stdout("whatsapp-db", "WARN", false))
	if err := c.Upgrade(context.Background()); err != nil {
		setErro("sessão: " + err.Error())
		return
	}
	mu.Lock()
	container = c
	est.Ligado = true
	mu.Unlock()
	if err := novoCliente(); err != nil {
		setErro(err.Error())
		return
	}
	mu.Lock()
	vinculado := cli.Store.ID != nil
	mu.Unlock()
	if vinculado {
		if err := cli.Connect(); err != nil {
			setErro("conectar: " + err.Error())
		}
	}
}

func novoCliente() error {
	dev, err := container.GetFirstDevice(context.Background())
	if err != nil {
		return fmt.Errorf("sessão: %w", err)
	}
	c := whatsmeow.NewClient(dev, waLog.Stdout("whatsapp", "WARN", false))
	c.AddEventHandler(aoEvento)
	mu.Lock()
	cli = c
	est.Vinculado = dev.ID != nil
	if dev.ID != nil {
		est.Numero = dev.ID.User
		est.Nome = dev.PushName
	}
	mu.Unlock()
	return nil
}

func setErro(e string) {
	log.Printf("[whatsapp] %s", e)
	mu.Lock()
	est.Erro = e
	mu.Unlock()
}

// ObterEstado devolve uma cópia do estado atual.
func ObterEstado() Estado {
	mu.Lock()
	defer mu.Unlock()
	e := est
	if cli != nil {
		e.Conectado = cli.IsConnected() && cli.IsLoggedIn()
	}
	return e
}

// Conectar começa o vínculo por QR code (se ainda não houver aparelho) ou reconecta.
func Conectar() error {
	mu.Lock()
	c := cli
	ligado := est.Ligado
	mu.Unlock()
	if !ligado || c == nil {
		return fmt.Errorf("WhatsApp desligado neste servidor")
	}
	if c.Store.ID != nil {
		if c.IsConnected() {
			return nil
		}
		return c.Connect()
	}
	if c.IsConnected() {
		c.Disconnect()
	}
	ch, err := c.GetQRChannel(context.Background())
	if err != nil {
		return err
	}
	if err := c.Connect(); err != nil {
		return err
	}
	go func() {
		for item := range ch {
			mu.Lock()
			switch item.Event {
			case "code":
				png, err := qrcode.Encode(item.Code, qrcode.Medium, 320)
				if err == nil {
					est.QR = "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
					t := time.Now().Add(item.Timeout)
					est.QRExpiraEm = &t
				}
				est.Erro = ""
			case "success":
				est.QR, est.QRExpiraEm = "", nil
			default: // timeout / erro: o admin clica em Conectar de novo
				est.QR, est.QRExpiraEm = "", nil
				if item.Event == "timeout" {
					est.Erro = "O QR code expirou. Clique em Conectar para gerar outro."
				} else if item.Error != nil {
					est.Erro = item.Error.Error()
				}
			}
			mu.Unlock()
		}
	}()
	return nil
}

// Desconectar desvincula o aparelho (some de "Aparelhos conectados" no celular).
func Desconectar() error {
	mu.Lock()
	c := cli
	mu.Unlock()
	if c == nil {
		return nil
	}
	if c.Store.ID != nil {
		if err := c.Logout(context.Background()); err != nil {
			c.Disconnect()
		}
	} else {
		c.Disconnect()
	}
	mu.Lock()
	est.Vinculado, est.Numero, est.Nome, est.Desde, est.QR = false, "", "", nil, ""
	mu.Unlock()
	return novoCliente()
}

func aoEvento(ev any) {
	switch v := ev.(type) {
	case *events.Connected:
		mu.Lock()
		t := time.Now()
		est.Desde, est.Erro, est.QR = &t, "", ""
		if cli != nil && cli.Store.ID != nil {
			est.Vinculado, est.Numero, est.Nome = true, cli.Store.ID.User, cli.Store.PushName
		}
		mu.Unlock()
		log.Printf("[whatsapp] conectado como %s", est.Numero)
	case *events.PairSuccess:
		mu.Lock()
		est.Vinculado, est.Numero, est.Nome, est.QR = true, v.ID.User, v.BusinessName, ""
		mu.Unlock()
	case *events.LoggedOut:
		setErro("O celular desconectou o SURE (Aparelhos conectados). Conecte de novo pelo QR code.")
		mu.Lock()
		est.Vinculado, est.Desde = false, nil
		mu.Unlock()
		go func() { _ = novoCliente() }()
	case *events.StreamReplaced:
		setErro("Outra instância do SURE abriu esta mesma sessão do WhatsApp.")
	case *events.Disconnected:
		mu.Lock()
		est.Desde = nil
		mu.Unlock()
	case *events.Message:
		gravarRecebida(v, true)
	case *events.HistorySync:
		go importarHistorico(v)
	}
}

// importarHistorico grava as conversas que o celular manda logo depois de conectar pelo QR code
// (o WhatsApp envia o histórico recente nessa hora). Sem alertas na tela: são mensagens antigas.
func importarHistorico(v *events.HistorySync) {
	mu.Lock()
	c := cli
	mu.Unlock()
	if c == nil || v.Data == nil {
		return
	}
	n := 0
	for _, conv := range v.Data.GetConversations() {
		jid, err := types.ParseJID(conv.GetID())
		if err != nil {
			continue
		}
		if jid.Server == types.GroupServer && conv.GetName() != "" {
			mu.Lock()
			nomesGrp[jid.String()] = conv.GetName()
			mu.Unlock()
		}
		for _, hm := range conv.GetMessages() {
			msg, err := c.ParseWebMessage(jid, hm.GetMessage())
			if err != nil {
				continue
			}
			gravarRecebida(msg, false)
			n++
		}
	}
	log.Printf("[whatsapp] histórico do celular: %d mensagens (%s)", n, v.Data.GetSyncType())
}

// ── mensagens ───────────────────────────────────────────────────────────────

// chatDe: conversa identificada pelo telefone sempre que possível (o WhatsApp às vezes usa um id
// interno "@lid" no lugar do número).
func chatDe(info types.MessageInfo) types.JID {
	chat := info.Chat
	if chat.Server == types.HiddenUserServer {
		if alt := info.SenderAlt; !info.IsFromMe && alt.Server == types.DefaultUserServer {
			return alt.ToNonAD()
		}
		if alt := info.RecipientAlt; info.IsFromMe && alt.Server == types.DefaultUserServer {
			return alt.ToNonAD()
		}
		mu.Lock()
		c := cli
		mu.Unlock()
		if c != nil {
			if pn, err := c.Store.LIDs.GetPNForLID(context.Background(), chat); err == nil && !pn.IsEmpty() {
				return pn.ToNonAD()
			}
		}
	}
	return chat.ToNonAD()
}

func textoETipo(m *waE2E.Message) (string, string) {
	if m == nil {
		return "", "outro"
	}
	switch {
	case m.GetConversation() != "":
		return m.GetConversation(), "texto"
	case m.GetExtendedTextMessage() != nil:
		return m.GetExtendedTextMessage().GetText(), "texto"
	case m.GetImageMessage() != nil:
		return m.GetImageMessage().GetCaption(), "imagem"
	case m.GetVideoMessage() != nil:
		return m.GetVideoMessage().GetCaption(), "vídeo"
	case m.GetAudioMessage() != nil:
		return "", "áudio"
	case m.GetDocumentMessage() != nil:
		d := m.GetDocumentMessage()
		return strings.TrimSpace(d.GetFileName() + " " + d.GetCaption()), "documento"
	case m.GetStickerMessage() != nil:
		return "", "figurinha"
	case m.GetLocationMessage() != nil:
		return "", "localização"
	case m.GetContactMessage() != nil:
		return m.GetContactMessage().GetDisplayName(), "contato"
	case m.GetReactionMessage() != nil:
		return m.GetReactionMessage().GetText(), "reação"
	case m.GetProtocolMessage() != nil:
		return "", "" // apagou/editou mensagem: não grava
	}
	return "", "outro"
}

func nomeGrupo(jid types.JID) string {
	mu.Lock()
	n, ok := nomesGrp[jid.String()]
	c := cli
	mu.Unlock()
	if ok || c == nil {
		return n
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if gi, err := c.GetGroupInfo(ctx, jid); err == nil {
		n = gi.Name
	}
	mu.Lock()
	nomesGrp[jid.String()] = n
	mu.Unlock()
	return n
}

func gravarRecebida(v *events.Message, alertar bool) {
	info := v.Info
	if info.Chat.Server == types.BroadcastServer || info.Chat.Server == types.NewsletterServer {
		return // status / canais
	}
	texto, tipo := textoETipo(v.Message)
	if tipo == "" {
		return
	}
	db := gdb()
	if db == nil {
		return
	}
	chat := chatDe(info)
	chatNome := ""
	if info.IsGroup {
		chatNome = nomeGrupo(info.Chat)
	} else if !info.IsFromMe {
		chatNome = info.PushName
	}
	remetente := info.Sender.ToNonAD().User
	if info.SenderAlt.Server == types.DefaultUserServer {
		remetente = info.SenderAlt.User
	}
	res, err := db.Exec(`INSERT IGNORE INTO FT_WHATSAPP_MENSAGENS
		(wa_id, chat, chat_nome, grupo, remetente, remetente_nome, de_mim, origem, tipo, texto, enviada_em, status_envio)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'whatsapp', ?, ?, ?, 'ok')`,
		string(info.ID), chat.String(), nullSe(chatNome), info.IsGroup, remetente, nullSe(info.PushName),
		info.IsFromMe, tipo, texto, info.Timestamp)
	if err != nil {
		log.Printf("[whatsapp] gravar mensagem: %v", err)
		return
	}
	// mensagem nova (não repetida), de outra pessoa, em conversa direta → alerta na tela
	if n, _ := res.RowsAffected(); alertar && n == 1 && !info.IsFromMe && !info.IsGroup && tipo != "reação" {
		avisarNovaMensagem(chat, chatNome, texto, tipo)
	}
}

func nullSe(s string) any {
	if s == "" {
		return nil
	}
	return s
}

var reDigitos = regexp.MustCompile(`\D`)

// NormalizarCelular: só dígitos, com DDI 55 quando vier só DDD+número. "" se não parecer celular.
func NormalizarCelular(s string) string {
	d := reDigitos.ReplaceAllString(s, "")
	if len(d) == 10 || len(d) == 11 {
		d = "55" + d
	}
	if len(d) < 12 || len(d) > 15 {
		return ""
	}
	return d
}

// destino resolve o JID de um telefone (ou devolve o próprio JID se já vier "…@s.whatsapp.net").
func destino(c *whatsmeow.Client, para string) (types.JID, error) {
	if strings.Contains(para, "@") {
		return types.ParseJID(para)
	}
	tel := NormalizarCelular(para)
	if tel == "" {
		return types.JID{}, fmt.Errorf("celular inválido")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	resp, err := c.IsOnWhatsApp(ctx, []string{"+" + tel})
	if err != nil {
		return types.JID{}, err
	}
	for _, r := range resp {
		if r.IsIn {
			return r.JID, nil
		}
	}
	return types.JID{}, fmt.Errorf("o número %s não tem WhatsApp", tel)
}

// Enviar manda um texto e grava em FT_WHATSAPP_MENSAGENS (origem sistema). idUsuario = quem recebe
// (0 se não for um usuário do SURE); enviadoPor = quem mandou pela tela (0 = o próprio sistema).
func Enviar(para, texto string, idUsuario, enviadoPor int64) error {
	mu.Lock()
	c := cli
	mu.Unlock()
	db := gdb()
	if c == nil || !c.IsConnected() || !c.IsLoggedIn() {
		return fmt.Errorf("WhatsApp não está conectado")
	}
	jid, err := destino(c, para)
	status, erro, waID := "ok", "", ""
	if err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		resp, e := c.SendMessage(ctx, jid, &waE2E.Message{Conversation: proto.String(texto)})
		cancel()
		err, waID = e, string(resp.ID)
	}
	if err != nil {
		status, erro = "erro", err.Error()
	}
	if db != nil {
		chat := jid.String()
		if jid.IsEmpty() {
			chat = NormalizarCelular(para) + "@" + types.DefaultUserServer
		}
		_, _ = db.Exec(`INSERT INTO FT_WHATSAPP_MENSAGENS
			(wa_id, chat, grupo, remetente, de_mim, origem, tipo, texto, enviada_em, id_usuario_destino, enviado_por, status_envio, erro)
			VALUES (?, ?, 0, ?, 1, 'sistema', 'texto', ?, NOW(), ?, ?, ?, ?)`,
			nullSe(waID), chat, c.Store.ID.User, texto, nullZero(idUsuario), nullZero(enviadoPor), status, nullSe(erro))
	}
	return err
}

func nullZero(n int64) any {
	if n <= 0 {
		return nil
	}
	return n
}

// avisarNovaMensagem: alerta na tela dos admins quando chega mensagem de alguém no número do departamento.
// No máximo um alerta por conversa a cada 30 min, para não lotar a tela numa conversa longa.
func avisarNovaMensagem(chat types.JID, nome, texto, tipo string) {
	gdbGorm := database.GormDB_App
	if gdbGorm == nil {
		return
	}
	mu.Lock()
	ult, ok := ultimoAviso[chat.String()]
	if ok && time.Since(ult) < 30*time.Minute {
		mu.Unlock()
		return
	}
	ultimoAviso[chat.String()] = time.Now()
	mu.Unlock()

	quem := nome
	if quem == "" {
		quem = "+" + chat.User
	}
	trecho := texto
	if tipo != "texto" {
		trecho = strings.TrimSpace(tipo + " " + texto)
	}
	if r := []rune(trecho); len(r) > 120 {
		trecho = string(r[:120]) + "…"
	}
	msg := fmt.Sprintf("WhatsApp do departamento — nova mensagem de %s: %s (ver em WhatsApp › Conversas)", quem, trecho)
	var ids []int64
	_ = gdbGorm.Raw("SELECT id_usuario FROM DM_USUARIO WHERE usuario_ativo = 1 AND perfil = 'admin'").Scan(&ids).Error
	for _, id := range ids {
		rotinas.NotificarNoSistema(gdbGorm, id, msg)
	}
}

var ultimoAviso = map[string]time.Time{}

// ── grupo dos avisos ────────────────────────────────────────────────────────

// Grupo é um grupo em que o número do departamento participa.
type Grupo struct {
	JID           string `json:"jid"`
	Nome          string `json:"nome"`
	Participantes int    `json:"participantes"`
}

var (
	gruposCache []Grupo
	gruposEm    time.Time
)

// Grupos lista os grupos do número do departamento (lista de conversas e grupo dos avisos).
// Guarda a lista por 5 minutos para não consultar o WhatsApp a cada atualização da tela.
func Grupos() ([]Grupo, error) {
	mu.Lock()
	c := cli
	if gruposCache != nil && time.Since(gruposEm) < 5*time.Minute {
		gs := gruposCache
		mu.Unlock()
		return gs, nil
	}
	mu.Unlock()
	if c == nil || !c.IsConnected() || !c.IsLoggedIn() {
		return nil, fmt.Errorf("WhatsApp não está conectado")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	gs, err := c.GetJoinedGroups(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Grupo, 0, len(gs))
	for _, g := range gs {
		out = append(out, Grupo{JID: g.JID.String(), Nome: g.Name, Participantes: len(g.Participants)})
	}
	mu.Lock()
	gruposCache, gruposEm = out, time.Now()
	for _, g := range out {
		nomesGrp[g.JID] = g.Nome
	}
	mu.Unlock()
	return out, nil
}

// GrupoAvisos devolve o JID do grupo escolhido ("" = nenhum).
func GrupoAvisos() string {
	db := gdb()
	if db == nil {
		return ""
	}
	var v sql.NullString
	_ = db.QueryRow("SELECT valor FROM FT_WHATSAPP_CONFIG WHERE chave = 'grupo_avisos'").Scan(&v)
	return v.String
}

// DefinirGrupoAvisos grava o grupo escolhido ("" desliga os avisos no WhatsApp).
func DefinirGrupoAvisos(jid string, idUsuario int64) error {
	db := gdb()
	if db == nil {
		return fmt.Errorf("banco indisponível")
	}
	if jid != "" {
		j, err := types.ParseJID(jid)
		if err != nil || j.Server != types.GroupServer {
			return fmt.Errorf("grupo inválido")
		}
	}
	_, err := db.Exec(`INSERT INTO FT_WHATSAPP_CONFIG (chave, valor, atualizado_por) VALUES ('grupo_avisos', ?, ?)
		ON DUPLICATE KEY UPDATE valor = VALUES(valor), atualizado_por = VALUES(atualizado_por)`, nullSe(jid), nullZero(idUsuario))
	return err
}

// AvisarGrupo manda o aviso para o grupo da equipe, se houver grupo escolhido e o WhatsApp estiver
// conectado. Não bloqueia: roda em segundo plano, um de cada vez, e só registra falhas.
func AvisarGrupo(msg string) {
	grupo := GrupoAvisos()
	if grupo == "" || !ObterEstado().Conectado {
		return
	}
	go func() {
		filaEnvio.Lock() // um de cada vez, com intervalo, para não parecer disparo em massa
		defer filaEnvio.Unlock()
		if err := Enviar(grupo, "🔔 SURE — "+msg, 0, 0); err != nil {
			log.Printf("[whatsapp] aviso no grupo: %v", err)
		}
		time.Sleep(3 * time.Second)
	}()
}

var filaEnvio sync.Mutex
