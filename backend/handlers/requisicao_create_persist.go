package handlers

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"ressarcimento-backend/database"
	"ressarcimento-backend/sse"

	"github.com/gin-gonic/gin"
)

// CreateRequisicaoPersist aceita multipart/form-data e salva na FT_REQUISICOES
func CreateRequisicaoPersist(c *gin.Context) {
	userIDValue, exists := c.Get("userID")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Usuário não autenticado"})
		return
	}
	userID, ok := userIDValue.(int64)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Tipo do ID do usuário inválido"})
		return
	}

	if err := c.Request.ParseMultipartForm(20 << 20); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Erro ao processar formulário: " + err.Error()})
		return
	}

	uc := c.PostForm("uc")
	cliente := c.PostForm("cliente")
	razaoSocialFatura := c.PostForm("razaoSocialFatura")
	concessionaria := c.PostForm("concessionaria")
	cnpj := c.PostForm("cnpj")
	enderecoCompleto := c.PostForm("enderecoCompleto")
	ressarcimentoEstimado := c.PostForm("RessarcimentoEstimado")
	descricaoIrregularidade := c.PostForm("descricaoIrregularidade")
    linkFatura := c.PostForm("linkFatura")
    faturasJson := strings.TrimSpace(c.PostForm("faturas")) // JSON opcional com faturas selecionadas
	periodos := c.PostForm("periodosIrregularidade")
	prioridadeNome := strings.TrimSpace(c.PostForm("prioridade"))

	// Conversões
	var valorEstimadoFloat float64
	if v := strings.ReplaceAll(strings.TrimSpace(ressarcimentoEstimado), ",", "."); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			valorEstimadoFloat = f
		}
	}
	if strings.TrimSpace(periodos) == "" {
		periodos = "[]"
	}

	// id_prioridade por nome (se existir)
	var prior interface{}
	if prioridadeNome != "" {
		var pid int64
		if err := database.DB_App.QueryRow("SELECT id_prioridade FROM DM_PRIORIDADE WHERE LOWER(prioridade)=LOWER(?) LIMIT 1", prioridadeNome).Scan(&pid); err == nil {
			prior = pid
		}
	}

	// Inserção básica (id_status NULL => aparecerá como 'Nova Requisição')
	q := `
        INSERT INTO FT_REQUISICOES (
            id_usuario, id_prioridade, id_status,
            uc, cliente, razao_social_fatura, concessionaria,
            cnpj, endereco_completo, numero_protocolo,
            ressarcimento_estimado, periodos_irregularidade,
            descricao_irregularidade, link_fatura, processo_criado
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, FALSE)`

	res, err := database.DB_App.Exec(q,
		userID, prior,
		uc, cliente, razaoSocialFatura, concessionaria,
		cnpj, enderecoCompleto,
		valorEstimadoFloat, periodos,
		descricaoIrregularidade, linkFatura,
	)
	if err != nil {
		log.Printf("CreateRequisicaoPersist: erro ao inserir FT_REQUISICOES: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao salvar requisição"})
		return
	}

    newID, _ := res.LastInsertId()

    // Persistir faturas selecionadas (se fornecidas)
    if faturasJson != "" {
        var items []struct {
            Link         string   `json:"link"`
            MesRef       string   `json:"mes_ref"`
            DtVencimento string   `json:"dt_vencimento"`
            ValorTotal   *float64 `json:"valor_total"`
        }
        if err := json.Unmarshal([]byte(faturasJson), &items); err == nil {
            for _, it := range items {
                lnk := strings.TrimSpace(it.Link)
                if lnk == "" { continue }
                _, _ = database.DB_App.Exec(`
                    INSERT INTO FT_REQUISICOES_FATURAS (id_requisicao, link, mes_ref, dt_vencimento, valor_total)
                    VALUES (?,?,?,?,?)`,
                    newID, lnk, strings.TrimSpace(it.MesRef), strings.TrimSpace(it.DtVencimento), it.ValorTotal,
                )
            }
        }
    }
    // Se veio apenas linkFatura simples e não houve lista, guarda como 1 item
    if faturasJson == "" && strings.TrimSpace(linkFatura) != "" {
        _, _ = database.DB_App.Exec(`
            INSERT INTO FT_REQUISICOES_FATURAS (id_requisicao, link, mes_ref, dt_vencimento, valor_total)
            VALUES (?,?,?,?,NULL)`, newID, strings.TrimSpace(linkFatura), "", "")
    }

	// Salvar anexos enviados no create (campo: "anexos")
	if c.Request.MultipartForm != nil {
		if files, ok := c.Request.MultipartForm.File["anexos"]; ok && len(files) > 0 {
			if err := os.MkdirAll("uploads", os.ModePerm); err == nil {
				for _, f := range files {
					name := filepath.Base(f.Filename)
					path := filepath.Join("uploads", fmt.Sprintf("%d-%d-%s", newID, time.Now().UnixNano(), name))
					if err := c.SaveUploadedFile(f, path); err == nil {
						// enviado_por: 'cliente' (criação)
						_, _ = database.DB_App.Exec(`
                            INSERT INTO FT_ANEXOS
                                (id_requisicao, nome_arquivo, caminho_arquivo, enviado_por, data_upload)
                            VALUES (?, ?, ?, 'cliente', NOW())`,
							newID, name, path,
						)
					}
				}
			}
		}
	}

	// Criar alertas para admins/gestores: nova requisição criada
	// Seleciona usuários destinatários
	rows, errAdmins := database.DB_App.Query(`
        SELECT id_usuario
          FROM DM_USUARIO
         WHERE usuario_ativo = TRUE
           AND LOWER(perfil) IN ('admin','gestor')`)
	if errAdmins == nil {
		defer rows.Close()
		for rows.Next() {
			var adminID int64
			if err := rows.Scan(&adminID); err != nil {
				continue
			}
			// Insere alerta
			_, _ = database.DB_App.Exec(
				"INSERT INTO FT_ALERTAS (id_usuario, id_processo, mensagem, lido, acknowledged, data_criacao, data_alerta) VALUES (?, ?, ?, 0, 0, NOW(), NULL)",
				adminID, newID, "Nova Requisição",
			)
			// Notifica via SSE (sino)
			notifyUnread(adminID)
			sse.BroadcastUser(adminID, sse.Event{Type: "alerta_novo", ProcessoID: int(newID), Payload: gin.H{"uc": uc, "cliente": cliente, "concessionaria": concessionaria}})
		}
	}

	// Broadcast SSE por usuário (criador) – opcional
	go func(id int64, uid int64) {
		defer func() { recover() }()
		sse.BroadcastUser(uid, sse.Event{Type: "requisicao_nova", ProcessoID: int(id)})
	}(newID, userID)

	// Retorno
	c.JSON(http.StatusCreated, gin.H{
		"id":                       newID,
		"uc":                       uc,
		"cliente":                  cliente,
		"razao_social_fatura":      razaoSocialFatura,
		"concessionaria":           concessionaria,
		"cnpj":                     cnpj,
		"endereco_completo":        enderecoCompleto,
		"ressarcimento_estimado":   valorEstimadoFloat,
		"descricao_irregularidade": descricaoIrregularidade,
		"link_fatura":              linkFatura,
		"periodos_irregularidade":  periodos,
		"message":                  "Requisição criada com sucesso",
	})
}
