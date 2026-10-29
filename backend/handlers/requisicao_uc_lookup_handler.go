package handlers

// requisicao_uc_lookup_handler.go — lookup unificado ao digitar a UC na criação
// de requisição. Fonte principal: sgeeasy Faturas_Registradas_Cache (empresa,
// cliente, concessionária, período, link), enriquecido com CNPJ/endereço do
// Amee_Serving. Sinaliza multi-UC e processos já existentes (alertas).
//
//   GET /api/v1/requisicoes/uc-lookup?uc=<uc>
//
// Resposta: { uc_digitada, total_candidatas, ucs_candidatas[], processos_existentes[], alertas[] }

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

type ucCandidata struct {
	UC               string `json:"uc"`
	UID              string `json:"uid,omitempty"`
	CodEmpresa       int64  `json:"cod_empresa"`
	Cliente          string `json:"cliente"`
	Concessionaria   string `json:"concessionaria"`
	CNPJ             string `json:"cnpj,omitempty"`
	EnderecoCompleto string `json:"endereco_completo,omitempty"`
	PeriodoIni       string `json:"periodo_ini,omitempty"`
	PeriodoFim       string `json:"periodo_fim,omitempty"`
	UltimoLink       string `json:"ultimo_link,omitempty"`
	NFaturas         int    `json:"n_faturas"`
}

type processoExistente struct {
	IDRequisicao int64  `json:"id_requisicao"`
	IDProcesso   int64  `json:"id_processo"`
	UC           string `json:"uc"`
	Cliente      string `json:"cliente"`
	Status       string `json:"status"`
	Tipo         string `json:"tipo"` // "processo" | "requisicao"
	DataCriacao  string `json:"data_criacao,omitempty"`
}

// RequisicaoUCLookup — GET /api/v1/requisicoes/uc-lookup?uc=
func RequisicaoUCLookup(c *gin.Context) {
	ucDig := somenteDigitos(c.Query("uc"))
	if len(ucDig) < 4 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "informe a UC (mínimo 4 dígitos)"})
		return
	}

	candidatas := []ucCandidata{}
	// 1) Candidatas no sgeeasy (agrupa por UC/empresa; período = MIN..MAX Mes_Ref).
	if database.GormDB_Faturas != nil {
		if sqlDB, err := database.GormDB_Faturas.DB(); err == nil {
			rows, e := sqlDB.Query(`
				SELECT UC, MAX(uid), Cod_Empresa, MAX(RAZAO_SOCIAL), MAX(Concessionaria),
				       MIN(Mes_Ref), MAX(Mes_Ref),
				       SUBSTRING_INDEX(GROUP_CONCAT(NULLIF(TRIM(Link),'') ORDER BY Mes_Ref DESC SEPARATOR '|||'), '|||', 1),
				       COUNT(*)
				  FROM Faturas_Registradas_Cache
				 WHERE REPLACE(REPLACE(REPLACE(UC,' ',''),'-',''),'.','') LIKE CONCAT(?, '%')
				    OR REPLACE(REPLACE(REPLACE(COALESCE(UCs_Anteriores,''),' ',''),'-',''),'.','') LIKE CONCAT('%', ?, '%')
				 GROUP BY UC, Cod_Empresa
				 ORDER BY MAX(Mes_Ref) DESC
				 LIMIT 25`, ucDig, ucDig)
			if e == nil {
				defer rows.Close()
				for rows.Next() {
					var cand ucCandidata
					var uid, razao, conc, ini, fim, link sql.NullString
					var cod sql.NullInt64
					if rows.Scan(&cand.UC, &uid, &cod, &razao, &conc, &ini, &fim, &link, &cand.NFaturas) == nil {
						cand.UID = uid.String
						cand.CodEmpresa = cod.Int64
						cand.Cliente = razao.String
						cand.Concessionaria = conc.String
						cand.PeriodoIni = ini.String
						cand.PeriodoFim = fim.String
						cand.UltimoLink = link.String
						candidatas = append(candidatas, cand)
					}
				}
			}
		}
	}

	// 2) Enriquece CNPJ/endereço do Amee_Serving (best-effort, por dígitos da UC).
	if database.DB_Consulta != nil {
		for i := range candidatas {
			var cnpj, endereco, razao sql.NullString
			_ = database.DB_Consulta.QueryRow(`
				SELECT e.CNPJ,
				       CONCAT_WS(', ', NULLIF(u.Endereco_1,''), NULLIF(u.Bairro_1,''), NULLIF(u.Cidade_1,''), NULLIF(u.Estado_1,'')),
				       e.Rz_Social
				  FROM Amee_Serving.Unidade u
				  LEFT JOIN Amee_Serving.Empresa e ON u.id_empresa = e.id_empresa
				 WHERE REPLACE(REPLACE(REPLACE(u.unidade,' ',''),'-',''),'.','') = ?
				 LIMIT 1`, somenteDigitos(candidatas[i].UC)).Scan(&cnpj, &endereco, &razao)
			if cnpj.Valid {
				candidatas[i].CNPJ = cnpj.String
			}
			if endereco.Valid {
				candidatas[i].EnderecoCompleto = endereco.String
			}
			if candidatas[i].Cliente == "" && razao.Valid {
				candidatas[i].Cliente = razao.String
			}
		}
	}

	// 3) Processos/requisições já existentes para a UC (tolerante a formato).
	procs := []processoExistente{}
	if database.GormDB_App != nil {
		if sqlDB, err := database.GormDB_App.DB(); err == nil {
			rows, e := sqlDB.Query(`
				SELECT r.id_requisicao, COALESCE(p.id_processo,0),
				       COALESCE(NULLIF(TRIM(r.uc),''), NULLIF(TRIM(p.uc),''), COALESCE(p.uc_atual,''), ''),
				       COALESCE(r.cliente,''),
				       COALESCE(s.nome,'Nova Requisição'),
				       DATE_FORMAT(r.data_criacao,'%Y-%m-%d')
				  FROM FT_REQUISICOES r
				  LEFT JOIN FT_PROCESSOS p ON p.id_processo = r.id_requisicao
				  LEFT JOIN DM_STATUS_REQUISICAO s ON r.id_status = s.id_status
				 WHERE REPLACE(REPLACE(REPLACE(COALESCE(r.uc,''),' ',''),'-',''),'.','') = ?
				    OR REPLACE(REPLACE(REPLACE(COALESCE(p.uc,''),' ',''),'-',''),'.','') = ?
				    OR REPLACE(REPLACE(REPLACE(COALESCE(p.uc_atual,''),' ',''),'-',''),'.','') = ?
				 ORDER BY r.id_requisicao DESC LIMIT 25`, ucDig, ucDig, ucDig)
			if e == nil {
				defer rows.Close()
				for rows.Next() {
					var p processoExistente
					if rows.Scan(&p.IDRequisicao, &p.IDProcesso, &p.UC, &p.Cliente, &p.Status, &p.DataCriacao) == nil {
						if p.IDProcesso > 0 {
							p.Tipo = "processo"
						} else {
							p.Tipo = "requisicao"
						}
						procs = append(procs, p)
					}
				}
			}
		}
	}

	alertas := []gin.H{}
	if len(candidatas) > 1 {
		alertas = append(alertas, gin.H{"tipo": "multi_uc", "nivel": "warn",
			"msg": "Este número corresponde a mais de uma unidade. Selecione a unidade correta para continuar."})
	}
	if len(procs) > 0 {
		alertas = append(alertas, gin.H{"tipo": "processo_existente", "nivel": "warn",
			"msg": "Já existem processos abertos para esta UC. Verifique se esta requisição não é duplicada antes de enviar."})
	}

	c.JSON(http.StatusOK, gin.H{
		"uc_digitada":          ucDig,
		"total_candidatas":     len(candidatas),
		"ucs_candidatas":       candidatas,
		"processos_existentes": procs,
		"alertas":              alertas,
	})
}
