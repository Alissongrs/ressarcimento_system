package whatsapp

// Envio de arquivo pela conversa (imagem, vídeo, áudio ou documento) com o número do departamento.
// O arquivo sobe para o WhatsApp (criptografado), a mensagem é enviada e fica gravada em
// FT_WHATSAPP_MENSAGENS (origem sistema) com o anexo guardado em WHATSAPP_DIR/midia, como os recebidos.

import (
	"context"
	"fmt"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// LimiteArquivo é o tamanho máximo aceito para envio (o WhatsApp aceita mais, mas basta para o uso).
const LimiteArquivo = 25 << 20

// EnviarArquivo manda um arquivo para o telefone/chat e grava no histórico. enviadoPor = usuário da tela.
func EnviarArquivo(para, nome, mimeTipo string, dados []byte, legenda string, enviadoPor int64) error {
	if len(dados) == 0 {
		return fmt.Errorf("arquivo vazio")
	}
	if len(dados) > LimiteArquivo {
		return fmt.Errorf("arquivo maior que %d MB", LimiteArquivo>>20)
	}
	mu.Lock()
	c := cli
	mu.Unlock()
	if c == nil || !c.IsConnected() || !c.IsLoggedIn() {
		return fmt.Errorf("WhatsApp não está conectado")
	}
	jid, err := destino(c, para)
	if err != nil {
		return err
	}
	mimeTipo = strings.TrimSpace(strings.SplitN(mimeTipo, ";", 2)[0])
	if mimeTipo == "" {
		mimeTipo = "application/octet-stream"
	}
	nome = strings.TrimSpace(nome)
	legenda = strings.TrimSpace(legenda)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	var tipoMidia whatsmeow.MediaType
	tipo := "documento"
	switch {
	case strings.HasPrefix(mimeTipo, "image/") && mimeTipo != "image/gif":
		tipoMidia, tipo = whatsmeow.MediaImage, "imagem"
	case strings.HasPrefix(mimeTipo, "video/"):
		tipoMidia, tipo = whatsmeow.MediaVideo, "vídeo"
	case strings.HasPrefix(mimeTipo, "audio/"):
		tipoMidia, tipo = whatsmeow.MediaAudio, "áudio"
	default:
		tipoMidia = whatsmeow.MediaDocument
	}
	up, err := c.Upload(ctx, dados, tipoMidia)
	if err != nil {
		return fmt.Errorf("subir o arquivo para o WhatsApp: %w", err)
	}
	msg := &waE2E.Message{}
	switch tipo {
	case "imagem":
		msg.ImageMessage = &waE2E.ImageMessage{
			URL: proto.String(up.URL), DirectPath: proto.String(up.DirectPath), MediaKey: up.MediaKey,
			Mimetype: proto.String(mimeTipo), FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256,
			FileLength: proto.Uint64(up.FileLength), Caption: proto.String(legenda),
		}
	case "vídeo":
		msg.VideoMessage = &waE2E.VideoMessage{
			URL: proto.String(up.URL), DirectPath: proto.String(up.DirectPath), MediaKey: up.MediaKey,
			Mimetype: proto.String(mimeTipo), FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256,
			FileLength: proto.Uint64(up.FileLength), Caption: proto.String(legenda),
		}
	case "áudio":
		msg.AudioMessage = &waE2E.AudioMessage{
			URL: proto.String(up.URL), DirectPath: proto.String(up.DirectPath), MediaKey: up.MediaKey,
			Mimetype: proto.String(mimeTipo), FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256,
			FileLength: proto.Uint64(up.FileLength),
		}
	default:
		if nome == "" {
			nome = "arquivo" + extensao(mimeTipo, "")
		}
		msg.DocumentMessage = &waE2E.DocumentMessage{
			URL: proto.String(up.URL), DirectPath: proto.String(up.DirectPath), MediaKey: up.MediaKey,
			Mimetype: proto.String(mimeTipo), FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256,
			FileLength: proto.Uint64(up.FileLength), FileName: proto.String(nome), Title: proto.String(nome),
			Caption: proto.String(legenda),
		}
	}
	resp, err := c.SendMessage(ctx, jid, msg)
	status, erro := "ok", ""
	if err != nil {
		status, erro = "erro", err.Error()
	}
	texto := legenda
	if texto == "" {
		texto = nome
	}
	if db := gdb(); db != nil {
		res, e := db.Exec(`INSERT INTO FT_WHATSAPP_MENSAGENS
			(wa_id, chat, grupo, remetente, de_mim, origem, tipo, texto, enviada_em, enviado_por, status_envio, erro, anexo_status, anexo_mime, anexo_nome)
			VALUES (?, ?, ?, ?, 1, 'sistema', ?, ?, NOW(), ?, ?, ?, ?, ?, ?)`,
			nullSe(string(resp.ID)), jid.String(), jid.Server == types.GroupServer, c.Store.ID.User, tipo, nullSe(texto),
			nullZero(enviadoPor), status, nullSe(erro), AnexoPendente, mimeTipo, nullSe(nome))
		if e == nil {
			if id, e2 := res.LastInsertId(); e2 == nil {
				// guarda a cópia local para aparecer na conversa (mesma pasta dos recebidos)
				gravarArquivo(db, id, &midia{mime: mimeTipo, nome: nome}, dados)
			}
		}
	}
	return err
}
