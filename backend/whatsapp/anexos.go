package whatsapp

// Anexos das mensagens (imagem, vídeo, áudio, documento, figurinha): baixados do WhatsApp e guardados
// em WHATSAPP_DIR/midia/AAAA/MM/<id>.<ext>; a linha da mensagem guarda caminho, mime, nome, tamanho e
// status (pendente → ok | erro | pedido). Mídia antiga (histórico) muitas vezes já saiu dos servidores
// do WhatsApp (404/410): aí pedimos ao celular para reenviar (media retry) e baixamos quando ele
// responde (events.MediaRetry). O proto da mensagem fica guardado (anexo_proto) para esse reenvio e
// para tentar de novo depois (RetentarAnexos).

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waMmsRetry"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

const (
	AnexoPendente = "pendente" // ainda não baixado
	AnexoOK       = "ok"
	AnexoErro     = "erro"
	AnexoPedido   = "pedido" // mídia já saiu do WhatsApp; reenvio pedido ao celular
)

// no máximo 3 downloads ao mesmo tempo (o histórico chega com centenas de mídias de uma vez)
var semAnexo = make(chan struct{}, 3)

// midia é a parte baixável de uma mensagem.
type midia struct {
	dl    whatsmeow.DownloadableMessage
	mime  string
	nome  string // nome do arquivo (documento) ou vazio
	chave []byte
}

func midiaDe(m *waE2E.Message) *midia {
	if m == nil {
		return nil
	}
	switch {
	case m.GetImageMessage() != nil:
		x := m.GetImageMessage()
		return &midia{x, x.GetMimetype(), "", x.GetMediaKey()}
	case m.GetVideoMessage() != nil:
		x := m.GetVideoMessage()
		return &midia{x, x.GetMimetype(), "", x.GetMediaKey()}
	case m.GetAudioMessage() != nil:
		x := m.GetAudioMessage()
		return &midia{x, x.GetMimetype(), "", x.GetMediaKey()}
	case m.GetDocumentMessage() != nil:
		x := m.GetDocumentMessage()
		return &midia{x, x.GetMimetype(), x.GetFileName(), x.GetMediaKey()}
	case m.GetStickerMessage() != nil:
		x := m.GetStickerMessage()
		return &midia{x, x.GetMimetype(), "", x.GetMediaKey()}
	}
	return nil
}

// definirDirectPath aplica o caminho novo que o celular mandou no reenvio.
func definirDirectPath(m *waE2E.Message, dp string) {
	switch {
	case m.GetImageMessage() != nil:
		m.ImageMessage.DirectPath = proto.String(dp)
	case m.GetVideoMessage() != nil:
		m.VideoMessage.DirectPath = proto.String(dp)
	case m.GetAudioMessage() != nil:
		m.AudioMessage.DirectPath = proto.String(dp)
	case m.GetDocumentMessage() != nil:
		m.DocumentMessage.DirectPath = proto.String(dp)
	case m.GetStickerMessage() != nil:
		m.StickerMessage.DirectPath = proto.String(dp)
	}
}

func dirMidia() string {
	dir := os.Getenv("WHATSAPP_DIR")
	if dir == "" {
		dir = "./whatsapp_sessao"
	}
	return filepath.Join(dir, "midia")
}

var extPorMime = map[string]string{
	"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
	"audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/amr": ".amr",
	"video/mp4": ".mp4", "video/3gpp": ".3gp", "application/pdf": ".pdf",
}

func extensao(mimeTipo, nome string) string {
	if e := strings.ToLower(filepath.Ext(nome)); e != "" && len(e) <= 6 {
		return e
	}
	base := strings.ToLower(strings.TrimSpace(strings.SplitN(mimeTipo, ";", 2)[0]))
	if e, ok := extPorMime[base]; ok {
		return e
	}
	if es, _ := mime.ExtensionsByType(base); len(es) > 0 {
		return es[0]
	}
	return ".bin"
}

func cortar(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func marcarAnexo(db *sql.DB, id int64, status, erro string) {
	_, _ = db.Exec(`UPDATE FT_WHATSAPP_MENSAGENS SET anexo_status=?, anexo_erro=? WHERE id=?`, status, nullSe(cortar(erro, 200)), id)
}

// baixarAnexo baixa a mídia da mensagem (já gravada em FT_WHATSAPP_MENSAGENS com este wa_id).
// Idempotente: se já está ok, não faz nada. Roda em goroutine.
func baixarAnexo(waID string, info types.MessageInfo, m *waE2E.Message) {
	md := midiaDe(m)
	if md == nil {
		return
	}
	db := gdb()
	if db == nil {
		return
	}
	var id int64
	var status sql.NullString
	var temProto bool
	if err := db.QueryRow(`SELECT id, anexo_status, anexo_proto IS NOT NULL FROM FT_WHATSAPP_MENSAGENS WHERE wa_id=?`, waID).
		Scan(&id, &status, &temProto); err != nil {
		return
	}
	if status.String == AnexoOK {
		return
	}
	if !temProto {
		if raw, err := proto.Marshal(m); err == nil {
			_, _ = db.Exec(`UPDATE FT_WHATSAPP_MENSAGENS SET anexo_proto=?, anexo_status=COALESCE(anexo_status,?), anexo_mime=?, anexo_nome=? WHERE id=?`,
				raw, AnexoPendente, nullSe(md.mime), nullSe(md.nome), id)
		}
	}
	semAnexo <- struct{}{}
	defer func() { <-semAnexo }()
	mu.Lock()
	c := cli
	mu.Unlock()
	if c == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	data, err := c.Download(ctx, md.dl)
	if err == nil {
		gravarArquivo(db, id, md, data)
		return
	}
	if errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith404) || errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith410) ||
		errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith403) {
		// mídia antiga já saiu dos servidores: pede ao celular reenviar (resposta chega em events.MediaRetry)
		if status.String != AnexoPedido {
			if e2 := c.SendMediaRetryReceipt(ctx, &info, md.chave); e2 == nil {
				marcarAnexo(db, id, AnexoPedido, "reenvio pedido ao celular")
				return
			}
		}
	}
	marcarAnexo(db, id, AnexoErro, err.Error())
}

func gravarArquivo(db *sql.DB, id int64, md *midia, data []byte) {
	t := time.Now()
	rel := filepath.Join(t.Format("2006"), t.Format("01"))
	nome := fmt.Sprintf("%d%s", id, extensao(md.mime, md.nome))
	dir := filepath.Join(dirMidia(), rel)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		marcarAnexo(db, id, AnexoErro, "pasta: "+err.Error())
		return
	}
	if err := os.WriteFile(filepath.Join(dir, nome), data, 0o600); err != nil {
		marcarAnexo(db, id, AnexoErro, "gravar: "+err.Error())
		return
	}
	mostrar := strings.TrimSpace(md.nome)
	if mostrar == "" {
		mostrar = nome
	}
	_, _ = db.Exec(`UPDATE FT_WHATSAPP_MENSAGENS SET anexo_caminho=?, anexo_mime=?, anexo_nome=?, anexo_tamanho=?, anexo_status=?, anexo_erro=NULL WHERE id=?`,
		filepath.ToSlash(filepath.Join(rel, nome)), nullSe(md.mime), cortar(mostrar, 255), len(data), AnexoOK, id)
}

// aoReenvio trata a resposta do celular ao pedido de reenvio de uma mídia antiga.
func aoReenvio(v *events.MediaRetry) {
	db := gdb()
	if db == nil || v == nil {
		return
	}
	var id int64
	var raw []byte
	if err := db.QueryRow(`SELECT id, anexo_proto FROM FT_WHATSAPP_MENSAGENS WHERE wa_id=? AND anexo_proto IS NOT NULL`, string(v.MessageID)).
		Scan(&id, &raw); err != nil {
		return
	}
	var m waE2E.Message
	if err := proto.Unmarshal(raw, &m); err != nil {
		return
	}
	md := midiaDe(&m)
	if md == nil {
		return
	}
	if v.Error != nil && (v.Ciphertext == nil || v.IV == nil) {
		marcarAnexo(db, id, AnexoErro, fmt.Sprintf("o celular não reenviou (código %d)", v.Error.Code))
		return
	}
	notif, err := whatsmeow.DecryptMediaRetryNotification(v, md.chave)
	if err != nil {
		marcarAnexo(db, id, AnexoErro, "reenvio: "+err.Error())
		return
	}
	if notif.GetResult() != waMmsRetry.MediaRetryNotification_SUCCESS || notif.GetDirectPath() == "" {
		marcarAnexo(db, id, AnexoErro, "o celular não tem mais este arquivo")
		return
	}
	definirDirectPath(&m, notif.GetDirectPath())
	md = midiaDe(&m)
	mu.Lock()
	c := cli
	mu.Unlock()
	if c == nil {
		return
	}
	semAnexo <- struct{}{}
	defer func() { <-semAnexo }()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	data, err := c.Download(ctx, md.dl)
	if err != nil {
		marcarAnexo(db, id, AnexoErro, "depois do reenvio: "+err.Error())
		return
	}
	gravarArquivo(db, id, md, data)
}

// RetentarAnexos tenta de novo os anexos que não baixaram (pendente/erro/pedido). Devolve quantos entraram na fila.
func RetentarAnexos() int {
	db := gdb()
	if db == nil {
		return 0
	}
	rows, err := db.Query(`SELECT id, wa_id, chat, COALESCE(remetente,''), de_mim, anexo_proto FROM FT_WHATSAPP_MENSAGENS
		WHERE anexo_proto IS NOT NULL AND (anexo_status IS NULL OR anexo_status IN (?,?,?)) ORDER BY id DESC LIMIT 500`,
		AnexoPendente, AnexoErro, AnexoPedido)
	if err != nil {
		return 0
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var id int64
		var waID, chat, remetente string
		var deMim bool
		var raw []byte
		if rows.Scan(&id, &waID, &chat, &remetente, &deMim, &raw) != nil {
			continue
		}
		m := &waE2E.Message{}
		if proto.Unmarshal(raw, m) != nil {
			continue
		}
		info, ok := infoDe(waID, chat, remetente, deMim, time.Time{})
		if !ok {
			continue
		}
		// volta para pendente: o download decide de novo entre ok / pedido / erro
		_, _ = db.Exec(`UPDATE FT_WHATSAPP_MENSAGENS SET anexo_status=? WHERE id=?`, AnexoPendente, id)
		go baixarAnexo(waID, info, m)
		n++
	}
	return n
}

// infoDe reconstrói a identificação da mensagem a partir do que está gravado (para reenvio/pedidos ao celular).
func infoDe(waID, chat, remetente string, deMim bool, quando time.Time) (types.MessageInfo, bool) {
	jid, err := types.ParseJID(chat)
	if err != nil {
		return types.MessageInfo{}, false
	}
	info := types.MessageInfo{ID: waID, Timestamp: quando}
	info.Chat, info.IsFromMe, info.IsGroup = jid, deMim, jid.Server == types.GroupServer
	mu.Lock()
	c := cli
	mu.Unlock()
	switch {
	case deMim && c != nil && c.Store.ID != nil:
		info.Sender = c.Store.ID.ToNonAD()
	case remetente != "":
		info.Sender = types.NewJID(remetente, types.DefaultUserServer)
	default:
		info.Sender = jid
	}
	return info, true
}

// ArquivoAnexo devolve o caminho completo, o mime e o nome de um anexo baixado.
func ArquivoAnexo(id int64) (caminho, mimeTipo, nome string, err error) {
	db := gdb()
	if db == nil {
		return "", "", "", fmt.Errorf("banco indisponível")
	}
	var rel string
	var mm, nn sql.NullString
	if err = db.QueryRow(`SELECT anexo_caminho, anexo_mime, anexo_nome FROM FT_WHATSAPP_MENSAGENS WHERE id=? AND anexo_status=?`, id, AnexoOK).
		Scan(&rel, &mm, &nn); err != nil {
		return "", "", "", fmt.Errorf("anexo não encontrado")
	}
	base, _ := filepath.Abs(dirMidia())
	caminho, _ = filepath.Abs(filepath.Join(base, filepath.FromSlash(rel)))
	if !strings.HasPrefix(caminho, base+string(os.PathSeparator)) {
		return "", "", "", fmt.Errorf("caminho inválido")
	}
	if _, err = os.Stat(caminho); err != nil {
		log.Printf("[whatsapp] anexo %d sem arquivo: %v", id, err)
		return "", "", "", fmt.Errorf("arquivo do anexo não está mais no servidor")
	}
	mimeTipo = strings.TrimSpace(strings.SplitN(mm.String, ";", 2)[0])
	if mimeTipo == "" {
		mimeTipo = "application/octet-stream"
	}
	nome = nn.String
	if nome == "" {
		nome = filepath.Base(caminho)
	}
	return caminho, mimeTipo, nome, nil
}
