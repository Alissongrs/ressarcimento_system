package handlers

// =============================================================================
// desvio_handler.go — PONTE: FATURA_DADOS_EXTRAIDOS → motor regras_desvio.go → front
//
// Substitui o caminho antigo (coluna fichas_apontadas, populada pelo pipeline IA
// e hoje vazia). Lê a FATURA_DADOS_EXTRAIDOS no mesmo banco do backend
// (GormDB_App), agrupa por UC, calcula o histórico e roda AvaliarDesvio()
// (F01-F05) AO VIVO. NÃO grava nada.
//
//   motorApontamentos()  — helper: roda o motor e devolve mapa id→ResultadoDesvio.
//   GetDesvioCasos()     — GET /api/v1/desvio/casos (JSON motor-only, p/ debug/prompt).
//
// O endpoint que o front consome (/api/v1/faturas/fde-analise) usa o helper
// quando recebe motor=1 (ver analise_desvio_handler.go).
// =============================================================================

import (
	"database/sql"
	"encoding/json"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"ressarcimento-backend/database"
)

// ── Cache do motor de desvio ──────────────────────────────────────────────────
// motorApontamentos varre ~162k faturas + filesort + calcula F01-F05 a cada
// chamada. As rotas /fde-analise e /fde-analise/empresas o chamam juntas no load
// da tela (mesma chave quando empresa="") → 2 varreduras completas por abertura.
// O cache guarda o resultado por (empresa|gateGold) com TTL curto; o único efeito
// é velocidade (mesmo comportamento). O resultado só muda quando faturas são
// reprocessadas — o TTL cobre isso em no máximo motorCacheTTL.
type motorCacheEntry struct {
	res map[int64]ResultadoDesvio
	at  time.Time
}

var (
	motorCacheMu   sync.Mutex            // protege o mapa de cache
	motorComputeMu sync.Mutex            // single-flight: serializa os cálculos (evita 2 varreduras simultâneas no mount)
	motorCache     = map[string]motorCacheEntry{}
)

const motorCacheTTL = 120 * time.Second

// InvalidarMotorCache limpa o cache de apontamentos do motor. Deve ser chamado
// sempre que uma correção manual (PatchFatura) ou rejeição alterar dados que
// influenciam o desvio, para que a fatura saia (ou entre) da Auditoria na hora,
// sem esperar o TTL de 120s.
func InvalidarMotorCache() {
	motorCacheMu.Lock()
	motorCache = map[string]motorCacheEntry{}
	motorCacheMu.Unlock()
}

// recomputeMotorCache força o recálculo e regrava o cache (bypassa o TTL). Usado pelo
// aquecedor de fundo pra manter o cache sempre quente.
func recomputeMotorCache(sqlDB *sql.DB, empresa string, gateGold bool) {
	motorComputeMu.Lock()
	defer motorComputeMu.Unlock()
	res, err := motorApontamentos(sqlDB, empresa, gateGold)
	if err != nil {
		return
	}
	res = filtrarPorProcessosExistentes(sqlDB, res)
	motorCacheMu.Lock()
	motorCache[empresa+"|"+strconv.FormatBool(gateGold)] = motorCacheEntry{res: res, at: time.Now()}
	motorCacheMu.Unlock()
}

// StartMotorCacheWarmer mantém o cache do motor SEMPRE quente: computa na largada e
// re-computa a cada 90s (antes do TTL de 120s), pra o load da Auditoria de Faturas não
// pegar o caminho frio (~20s recomputando F01-F05 sobre todo o parque de 177k faturas).
// Aquece a chave padrão "todos" ("|true"), que é a do load inicial da tela.
func StartMotorCacheWarmer(sqlDB *sql.DB) {
	if sqlDB == nil {
		return
	}
	safe := func() { defer func() { _ = recover() }(); recomputeMotorCache(sqlDB, "", true) }
	go func() {
		safe() // largada (evita 1º usuário pós-restart pegar frio)
		t := time.NewTicker(90 * time.Second)
		defer t.Stop()
		for range t.C {
			safe()
		}
	}()
}

// motorApontamentosCached é o motorApontamentos com cache + single-flight.
// O mapa devolvido é COMPARTILHADO entre requests — os callers apenas LEEM dele.
func motorApontamentosCached(sqlDB *sql.DB, empresa string, gateGold bool) (map[int64]ResultadoDesvio, error) {
	return motorApontamentosCachedT(sqlDB, empresa, gateGold, "FATURA_DADOS_EXTRAIDOS")
}

// motorApontamentosCachedT — versão com TABELA parametrizada (Acer). Cache-key inclui a tabela.
func motorApontamentosCachedT(sqlDB *sql.DB, empresa string, gateGold bool, tabela string) (map[int64]ResultadoDesvio, error) {
	if tabela == "" {
		tabela = "FATURA_DADOS_EXTRAIDOS"
	}
	key := tabela + "|" + empresa + "|" + strconv.FormatBool(gateGold)

	// fast path: cache quente
	motorCacheMu.Lock()
	if e, ok := motorCache[key]; ok && time.Since(e.at) < motorCacheTTL {
		motorCacheMu.Unlock()
		return e.res, nil
	}
	motorCacheMu.Unlock()

	// compute path serializado — se outra goroutine já estiver calculando, esperamos
	// e reaproveitamos o resultado dela (dedup dos 2 passes do mount).
	motorComputeMu.Lock()
	defer motorComputeMu.Unlock()
	motorCacheMu.Lock()
	if e, ok := motorCache[key]; ok && time.Since(e.at) < motorCacheTTL {
		motorCacheMu.Unlock()
		return e.res, nil
	}
	motorCacheMu.Unlock()

	res, err := motorApontamentosT(sqlDB, empresa, gateGold, tabela)
	if err != nil {
		return nil, err
	}
	// Remove apontamentos cujo (UC, mes_referencia) já corresponde a um
	// processo/requisição existente (mesma UC, mesmo mês) — evita duplicar na
	// Auditoria de Faturas o que já virou processo. Meses DIFERENTES da mesma
	// UC seguem aparecendo (período novo = novo apontamento).
	res = filtrarPorProcessosExistentes(sqlDB, res)
	motorCacheMu.Lock()
	motorCache[key] = motorCacheEntry{res: res, at: time.Now()}
	motorCacheMu.Unlock()
	return res, nil
}

type DesvioCaso struct {
	ID            int64           `json:"id"`
	UC            string          `json:"uc"`
	CodEmpresa    int64           `json:"cod_empresa"`
	Distribuidora string          `json:"distribuidora"`
	MesRef        string          `json:"mes_ref"`
	Medidor       string          `json:"medidor"`
	LinkFatura    string          `json:"link_fatura"`
	ValidadorGate string          `json:"validador_gate"`
	Resultado     ResultadoDesvio `json:"resultado"`
}

// chaveAgrupamentoUC devolve a chave de agrupamento estável de uma fatura na FDE.
//
// PROBLEMA (fix 07/07/2026): numero_instalacao está sujo em uma parcela relevante
// do parque — carrega letras isoladas ('C'), a string 'CNPJ', CNPJs de 14 dígitos
// que vazaram do extrator e strings curtas de 1-2 caracteres. Quando o motor de
// desvio agrupava só por numero_instalacao, faturas de UCs completamente
// diferentes caíam no MESMO bucket, misturando históricos de consumo e gerando
// F02/F04 falsos. Exemplos reais no banco:
//
//   - numero_instalacao='C'                → 202 codigo_uc distintos
//   - numero_instalacao='02041460000193'   → 23 codigo_uc distintos (CNPJ)
//   - numero_instalacao='701513901809'     → 3 codigo_uc distintos
//
// Regra: quando numero_instalacao é "suspeito" (LEN<5, LEN>14, contém letra ou
// símbolo, ou é CNPJ de 14 dígitos), usamos só codigo_uc como chave — codigo_uc
// vem do sgeeasy e é o id imutável da UC. Caso contrário, concatenamos os dois
// (com separador) pra que instalações limpas iguais em UCs distintas ainda
// possam ser separadas se o codigo_uc discordar.
func chaveAgrupamentoUC(inst, uc string) string {
	i := strings.TrimSpace(inst)
	u := strings.TrimSpace(uc)
	suspeito := false
	if len(i) < 5 || len(i) > 14 {
		suspeito = true
	} else {
		for _, ch := range i {
			if (ch < '0' || ch > '9') && ch != '/' {
				suspeito = true
				break
			}
		}
		// 14 dígitos sem separador = tem cheiro de CNPJ (instalações padrão são 6-13)
		if !suspeito && len(i) == 14 {
			suspeito = true
		}
	}
	if suspeito {
		if u != "" {
			return "uc:" + u
		}
		return "inst:" + i // fallback: nem codigo_uc temos → melhor que agrupar tudo
	}
	// Instalação limpa → usa SÓ numero_instalacao como chave.
	// Ajuste 07/07/2026 (research do Agente A): 965 grupos "leves" (26.192 faturas)
	// eram na verdade a MESMA UC com codigo_uc variando de formato ao longo do tempo
	// (ex.: id 466773 codigo_uc='15.139.018-09' + id 448496 codigo_uc='701513901809'
	// = mesmo cliente CEMIG, mesmo CEP 39403-236, mesma instalação 701513901809).
	// Chave composta (inst|uc) quebraria o histórico em 2 trilhas separadas quando o
	// codigo_uc mudasse de formato. Como numero_instalacao é o id imutável da UC no
	// sgeeasy quando está limpo, ele sozinho basta pra agrupar corretamente.
	return "inst:" + i
}

// motorApontamentos roda o motor F01-F05 sobre a FDE e devolve, por id de fatura,
// o ResultadoDesvio das faturas que dispararam ao menos uma regra.
//   empresa: "" = todas.
//   gateGold: MANTIDO no signature pra compat com callers/cache mas IGNORADO —
//     desde 08/07/2026 o motor não filtra mais por validador_gate nem por
//     numero_instalacao vazio nem por flag_fatura_revisao. Aplica F01-F05 sobre
//     TODA FT_DADOS_EXTRAIDOS.
func motorApontamentos(sqlDB *sql.DB, empresa string, gateGold bool) (map[int64]ResultadoDesvio, error) {
	return motorApontamentosT(sqlDB, empresa, gateGold, "FATURA_DADOS_EXTRAIDOS")
}

// motorApontamentosT — igual a motorApontamentos, mas parametriza a TABELA de origem
// (Acer usa FATURA_ACER_DADOS_EXTRAIDOS; vazio = FATURA_DADOS_EXTRAIDOS). MESMA lógica/motor.
func motorApontamentosT(sqlDB *sql.DB, empresa string, gateGold bool, tabela string) (map[int64]ResultadoDesvio, error) {
	if tabela == "" {
		tabela = "FATURA_DADOS_EXTRAIDOS"
	}
	// Filtros removidos:
	//   - numero_instalacao IS NOT NULL AND <> ''  (excluía ~15k faturas do universo).
	//     Faturas sem instalação agora agrupam por codigo_uc via chaveAgrupamentoUC.
	//   - validador_gate IN (aprovado,revisao)  (excluía reprovadas — F02 valia só
	//     nas "gold"). Agora avalia tudo.
	//   - flag_fatura_revisao = 0  (excluía faturas de revisão plurimensal).
	//     Agora entram tb — analista decide se procede.
	_ = gateGold // reservado pra futura reintroduçao; comportamento atual é gate=all
	where := "1=1"
	args := []any{}
	if empresa != "" && empresa != "0" {
		where += " AND cod_empresa = ?"
		args = append(args, empresa)
	}
	return motorApontamentosWhere(sqlDB, tabela, where, args)
}

// MotorApontamentosUCs roda o MESMO motor F01-F05 só sobre o histórico das UCs informadas
// (codigo_uc / numero_instalacao) — p/ verificar um lote recém-extraído sem varrer a FDE toda.
// O histórico completo de cada UC entra (o F02 compara com a média da própria UC).
func MotorApontamentosUCs(sqlDB *sql.DB, codigosUC, instalacoes []string) (map[int64]ResultadoDesvio, error) {
	conds := []string{}
	args := []any{}
	if len(codigosUC) > 0 {
		conds = append(conds, "codigo_uc IN (?"+strings.Repeat(",?", len(codigosUC)-1)+")")
		for _, v := range codigosUC {
			args = append(args, v)
		}
	}
	if len(instalacoes) > 0 {
		conds = append(conds, "numero_instalacao IN (?"+strings.Repeat(",?", len(instalacoes)-1)+")")
		for _, v := range instalacoes {
			args = append(args, v)
		}
	}
	if len(conds) == 0 {
		return map[int64]ResultadoDesvio{}, nil
	}
	return motorApontamentosWhere(sqlDB, "FATURA_DADOS_EXTRAIDOS", "("+strings.Join(conds, " OR ")+")", args)
}

func motorApontamentosWhere(sqlDB *sql.DB, tabela, where string, args []any) (map[int64]ResultadoDesvio, error) {
	// ORDER BY cronológico REAL: mes_referencia vem em formatos misturados
	// ('MM/AAAA' e 'AAAA-MM-DD'). Ordenar como string embaralha a história
	// (todos os 'MM/AAAA' caem na frente) e gerava F02 falso. Normaliza p/ ISO.
	// grupo_tarifario + kwh_total: usados pra de-duplicar Grupo B (ponta==fponta
	// dobrado pelo extrator Energisa Grupo B — ~1.900 faturas). Sem esse fix, o
	// F02 dispara falso positivo em quase todo processo Grupo B da Energisa.
	//
	// codigo_uc: entra no SELECT + ORDER BY porque numero_instalacao sozinho
	// misturava UCs distintas quando estava sujo (ver chaveAgrupamentoUC).
	q := `SELECT id, COALESCE(numero_instalacao,''), COALESCE(codigo_uc,''),
	             COALESCE(mes_referencia,''),
	             COALESCE(numero_medidor,''), COALESCE(validador_gate,''),
	             constante_k, leit_ant_ativa_fponta, leit_atu_ativa_fponta,
	             consumo_ativo_ponta_kwh, consumo_ativo_fponta_kwh,
	             consumo_ativo_sefaz_kwh,
	             COALESCE(historico_consumo_json,''),
	             COALESCE(flag_fatura_revisao,0),
	             COALESCE(flag_acumulo_art113,0),
	             COALESCE(kwh_acumulado_art113,0),
	             COALESCE(grupo_tarifario,''), kwh_total
	      FROM ` + tabela + `
	      WHERE ` + where + `
	      ORDER BY numero_instalacao, COALESCE(codigo_uc,''),
	        CASE WHEN mes_referencia LIKE '____-__-__' THEN mes_referencia
	             WHEN mes_referencia LIKE '__/____'   THEN CONCAT(SUBSTRING(mes_referencia,4,4),'-',SUBSTRING(mes_referencia,1,2),'-01')
	             ELSE mes_referencia END`

	rows, err := sqlDB.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[int64]ResultadoDesvio{}

	// Materializa as faturas e indexa o consumo pela CHAVE de agrupamento
	// (rows já ordenadas por numero_instalacao + codigo_uc + mês) — necessário
	// p/ o look-ahead das 3 próximas faturas (validação forward do F02:
	// anomalia x ativação/novo patamar). A chave é (inst, uc) via
	// chaveAgrupamentoUC — evita que numero_instalacao sujo ('C', CNPJ, etc.)
	// misture faturas de UCs distintas no mesmo bucket.
	type fatRow struct {
		id                                    int64
		uc, codUC, chave                      string
		mes, med, vgate, histJSON             string
		k, lant, latu, consP, consFP, sefaz   sql.NullFloat64
		grupo                                 string
		kwhTot                                sql.NullFloat64
		cons                                  float64
		lidx                                  int
		revisao                               int64
		art113                                int64
		art113kwh                             sql.NullFloat64
	}
	var data []fatRow
	consByUC := map[string][]float64{} // chave = chaveAgrupamentoUC(inst, codigo_uc)
	mesByUC := map[string][]string{}   // mesmo índice de consByUC — mês de cada consumo (p/ classificação sazonal)
	for rows.Next() {
		var r fatRow
		if err := rows.Scan(&r.id, &r.uc, &r.codUC, &r.mes, &r.med, &r.vgate,
			&r.k, &r.lant, &r.latu, &r.consP, &r.consFP, &r.sefaz, &r.histJSON, &r.revisao, &r.art113, &r.art113kwh,
			&r.grupo, &r.kwhTot); err != nil {
			continue
		}
		r.chave = chaveAgrupamentoUC(r.uc, r.codUC)
		// Consumo do mês — em cascata pra evitar duplicação Grupo B:
		//   (1) Grupo B com ponta==fponta (>0) — bug extrator Energisa: usa só ponta.
		//   (2) kwh_total > 0 (canônico pós-pipeline) — usa direto.
		//   (3) Soma ponta+fponta com teto de sanidade (comportamento antigo).
		consP := 0.0
		if r.consP.Valid && r.consP.Float64 <= ConsumoMaxKWh {
			consP = r.consP.Float64
		}
		consFP := 0.0
		if r.consFP.Valid && r.consFP.Float64 <= ConsumoMaxKWh {
			consFP = r.consFP.Float64
		}
		if r.grupo == "B" && consP > 0 && consP == consFP {
			r.cons = consP // duplicação conhecida → não soma
		} else if r.kwhTot.Valid && r.kwhTot.Float64 > 0 && r.kwhTot.Float64 <= ConsumoMaxKWh {
			r.cons = r.kwhTot.Float64
		} else {
			r.cons = consP + consFP
		}
		// Soma o consumo acumulado do Art.113 (RES.414) ao consumo do mês — destrava
		// o pico real do acúmulo (que ficava só na parcela corrente, ex.: 12.727→50.909).
		if r.art113kwh.Valid && r.art113kwh.Float64 > 0 && r.art113kwh.Float64 <= ConsumoMaxKWh {
			r.cons += r.art113kwh.Float64
		}
		data = append(data, r) // série (consByUC/lidx) montada abaixo, após decidir splits de codUC
	}

	// ── Split de instalação limpa por codigo_uc quando são UCs DISTINTAS (07/08/2026) ──
	// chaveAgrupamentoUC funde todo codigo_uc sob uma instalação limpa — bom p/ os 965 grupos
	// "mesma UC, codUC variando de formato" (consumo parecido). Mas quando os codigo_uc são
	// UCs GENUINAMENTE diferentes (ex.: inst 6023590 = codUC '346' média ~2.256 × codUC
	// '6023590' média ~18.254), a fusão comparava o mês de uma UC contra o histórico da OUTRA
	// → F02 falso (caso 07/2021). Distingue pelo PERFIL DE CONSUMO: subgrupos de codUC de um
	// inst limpo com médias MUITO diferentes (>3×) são UCs distintas → separa por codUC.
	// Consumo parecido (os 965) → mantém fundido.
	{
		porInst := map[string]map[string][]float64{} // "inst:X" → codUC → consumos (>piso)
		for _, r := range data {
			if !strings.HasPrefix(r.chave, "inst:") || strings.TrimSpace(r.codUC) == "" || r.cons <= F02MinKWh {
				continue
			}
			if porInst[r.chave] == nil {
				porInst[r.chave] = map[string][]float64{}
			}
			porInst[r.chave][r.codUC] = append(porInst[r.chave][r.codUC], r.cons)
		}
		splitInst := map[string]bool{}
		for chave, cods := range porInst {
			if len(cods) < 2 {
				continue
			}
			lo, hi, n := 0.0, 0.0, 0
			for _, cs := range cods {
				if len(cs) < 3 { // subgrupo pequeno não decide
					continue
				}
				var sum float64
				for _, v := range cs {
					sum += v
				}
				med := sum / float64(len(cs))
				if med <= 0 {
					continue
				}
				n++
				if lo == 0 || med < lo {
					lo = med
				}
				if med > hi {
					hi = med
				}
			}
			if n >= 2 && lo > 0 && hi >= 3*lo {
				splitInst[chave] = true
			}
		}
		for i := range data {
			if splitInst[data[i].chave] && strings.TrimSpace(data[i].codUC) != "" {
				data[i].chave = data[i].chave + "|uc:" + strings.TrimSpace(data[i].codUC)
			}
		}
	}

	// Constrói a série por chave (cronológica — data já vem ORDER BY inst, codUC, mês).
	for i := range data {
		ch := data[i].chave
		data[i].lidx = len(consByUC[ch])
		consByUC[ch] = append(consByUC[ch], data[i].cons)
		mesByUC[ch] = append(mesByUC[ch], data[i].mes)
	}

	// Detecta chaves de agrupamento COMPARTILHADAS (16/07/2026) — armadilha VTAL
	// rede neutra: o numero_instalacao é um valor genérico usado por dezenas de UCs
	// distintas (ex.: inst 001012026462 em 9 faturas no MESMO mês; 1014883548 em 12).
	// Uma UC real fatura 1×/mês; 2ª via ocasional gera 2. ≥3 no mesmo mês ⇒ inst
	// compartilhado → a média mistura UCs sem relação → F02 falso. Suprime o
	// apontamento dessas chaves (a identidade real da UC VTAL é o uid, não o inst).
	// Guarda VTAL (inst compartilhado) DESATIVADA a pedido do usuário (ago/2026): a VTAL
	// volta a ser EXIBIDA. Antes: ≥3 faturas no mesmo mês na mesma chave (inst genérico da
	// rede neutra) ⇒ sharedChave=true ⇒ suprimia o apontamento (média misturava UCs). Deixando
	// o mapa vazio, o guard vira no-op e os apontamentos VTAL aparecem normalmente.
	sharedChave := map[string]bool{}

	// F03B pre-processing (08/07/2026) — identifica sequências de piso 100/50/30
	// que precedem picos F02. Um pass sobre cada UC (data já ordenada por chave,mes).
	// Marca cada fatura_id da sequência de piso qualificada com o pico que a fecha.
	f03bLite := make([]f03bLinha, len(data))
	for i, r := range data {
		f03bLite[i] = f03bLinha{id: r.id, chave: r.chave, mes: r.mes, cons: r.cons}
		if r.lant.Valid && r.latu.Valid {
			kk := 1.0
			if r.k.Valid && r.k.Float64 > 0 {
				kk = r.k.Float64
			}
			f03bLite[i].lant, f03bLite[i].latu, f03bLite[i].k, f03bLite[i].leitOK = r.lant.Float64, r.latu.Float64, kk, true
		}
	}
	f03bInfo := precomputeF03B(f03bLite)

	// estado por UC (chave de agrupamento = (numero_instalacao, codigo_uc)
	// via chaveAgrupamentoUC — instalação sozinha misturava UCs quando estava suja)
	var curChave string
	var medAnt string
	var leitAtuAnt sql.NullFloat64
	var mesIdxAnt int
	var leitAntConf bool // F05: leituras da fatura ANTERIOR fecham a fórmula?

	for _, r := range data {
		id, uc, mes, med, vgate, histJSON := r.id, r.uc, r.mes, r.med, r.vgate, r.histJSON
		k, lant, latu, consP, consFP, sefaz := r.k, r.lant, r.latu, r.consP, r.consFP, r.sefaz
		if r.chave != curChave { // nova UC → reseta histórico
			curChave = r.chave
			medAnt = ""
			leitAtuAnt = sql.NullFloat64{}
			mesIdxAnt = 0
			leitAntConf = false
		}
		curMesIdx := mesIndice(mes)
		cons := r.cons
		_ = consP // consumo já somado em r.cons

		// Média sobre TODO o histórico da UC (idêntico ao modal de Auditoria):
		// todos os meses com consumo > 0, EXCETO o próprio mês, média simples.
		// (NOTA 07/08: tentei trailing-3 e trailing-only p/ o falso-positivo do 07/2021 —
		// AMBOS falharam porque consByUC[r.chave] não é série cronológica limpa por UC
		// (o agrupamento por chave mistura/reordena). Corrigir o baseline exige limpar a
		// série ANTES. Revertido ao all-history até isso ser feito. Ver memory.)
		serie := consByUC[r.chave]
		somaBase, baseMeses := 0.0, 0
		for j, v := range serie {
			if j == r.lidx {
				continue // exclui o mês atual
			}
			if v > 0 {
				somaBase += v
				baseMeses++
			}
		}
		media := 0.0
		if baseMeses > 0 {
			media = somaBase / float64(baseMeses)
		}

		// F03 (acúmulo) REMOVIDA — não computa mais sequência de idênticas.

		// Base do F02 (08/07/2026): PREFERE o encadeamento CROSS-FATURA da própria
		// UC dentro da FDE — mais denso (até 12 meses reais), imune a bugs de
		// leitura do quadrinho impresso, e naturalmente consistente com o consumo
		// atual (mesma coluna extraída). O histórico_consumo_json (quadrinho da
		// fatura) tem cobertura efetiva ~42% e frequentemente traz só 1-6 meses:
		// base curta gera desvios fantasma (pico "3147%" que é ruído amostral).
		// Auditoria 08/07 (346 apontamentos F02 ≥20%): 33% dos casos VIA VAREJO
		// tinham "hist_json ruim" comparado ao consumo real.
		//
		// FALLBACK: se cross-fatura tem base < F02BaseMin (UC nova, poucas faturas
		// anteriores), tenta o histórico impresso da fatura — melhor 3 meses do
		// quadrinho que aponte pico real, do que 0 apontamento na UC recente.
		// Guarda de escala continua valendo (historicoConsistente) para evitar
		// o antigo bug CEMIG Grupo A (demanda no campo consumo → 952% fantasma).
		mediaF, baseF := media, baseMeses
		if baseF < F02BaseMin {
			if mh, bm := mediaHistoricoImpresso(histJSON, cons); bm >= F02BaseMin && historicoConsistente(histJSON, cons) {
				mediaF, baseF = mh, bm
			}
		}

		// FORWARD: até 3 faturas SEGUINTES desta UC (look-ahead) p/ distinguir
		// anomalia (consumo volta à média) de ativação/novo patamar (mantém alto).
		// Indexa por r.chave — se usasse `uc` puro, os buckets sujos ('C', CNPJ)
		// contaminariam o look-ahead com faturas de outras UCs.
		var proximas []float64
		fut := consByUC[r.chave]
		for j := r.lidx + 1; j < len(fut) && len(proximas) < 3; j++ {
			proximas = append(proximas, fut[j])
		}

		fd := FaturaDesvio{
			ID: id, UC: uc, Segmento: "FP", Medidor: med, MedidorAnt: medAnt,
			ConsumoAtual: cons, MediaHistorica: mediaF, BaseMeses: baseF,
			MesConsecutivo:  mesIdxAnt > 0 && curMesIdx-mesIdxAnt == 1,
			ConsumoProximas: proximas,
		}
		if info, ok := f03bInfo[id]; ok {
			fd.F03BEmSequenciaPiso = true
			fd.F03BPisoValor = info.piso
			fd.F03BSeqTamanho = info.seqTam
			fd.F03BPicoRefID = info.picoID
			fd.F03BPicoRefMes = info.picoMes
		}
		if leitAtuAnt.Valid {
			fd.LeitAtualAnterior = leitAtuAnt.Float64
		}
		if lant.Valid {
			fd.LeitAnteriorAtual = lant.Float64
		}
		kval := 0.0
		if k.Valid {
			kval = k.Float64
		}
		curConf := false
		if lant.Valid && latu.Valid { // posto FPonta (único com leitura na FDE)
			p := PostoLeitura{Posto: "FP", LeituraAnterior: lant.Float64, LeituraAtual: latu.Float64}
			p.Constante = kval
			if consFP.Valid {
				p.ConsumoFaturado = consFP.Float64
				curConf = leiturasFecham(lant.Float64, latu.Float64, kval, consFP.Float64)
			}
			fd.Postos = []PostoLeitura{p}
		}
		fd.LeituraAtualConfiavel = curConf
		fd.LeituraAntConfiavel = leitAntConf
		// F01: SEFAZ confirma o consumo faturado (ponta+fponta)? Tolerância 2%.
		if sefaz.Valid && sefaz.Float64 > 0 && cons > 0 &&
			math.Abs(sefaz.Float64-cons)/cons <= 0.02 {
			fd.SefazConfirmaConsumo = true
		}
		// F01: os postos (ponta+fponta) somam o total faturado (tol 2%)? Se somam, o
		// consumo cobrado é internamente coerente e a divergência leitura×K é limitação
		// de EXTRAÇÃO da leitura (ex.: fora-ponta em 2 registradores capacit.+indutivo e
		// o motor lê só 1) — não é erro de fatura → não aponta F01. Ver regras_desvio.go.
		if r.kwhTot.Valid && r.kwhTot.Float64 > 0 && consP.Valid && consFP.Valid {
			if somaP := consP.Float64 + consFP.Float64; math.Abs(somaP-r.kwhTot.Float64) <= 0.02*r.kwhTot.Float64 {
				fd.ContaConsumoCoerente = true
			}
		}

		res := AvaliarDesvio(fd)

		// Advisory (não remove apontamento): classifica o F02 pelo histórico da UC
		// (ELEVADO_REAL / DENTRO_DO_HISTORICO / SAZONAL) — o front mostra o rótulo.
		if res.F02 {
			res.ClassificacaoHistorico = classificaHistorico(consByUC[r.chave], mesByUC[r.chave], r.lidx, cons, mediaF)
		}

		_ = vgate // (validador_gate) — não filtra mais; motor considera tudo desde 08/07/2026
		// Guarda VTAL (16/07/2026): chave com inst compartilhado → agrupamento
		// não confiável (média mistura UCs distintas) → NÃO aponta. Preserva UCs
		// de inst único (todos os resultados já validados: 2ª via gera no máx 2/mês).
		if sharedChave[r.chave] {
			medAnt = med
			leitAtuAnt = latu
			mesIdxAnt = curMesIdx
			leitAntConf = curConf
			continue
		}
		// Art.113 / PARCELAMENTO: SEMPRE aponta (F02 + aviso) — o consumo
		// acumulado recuperado em parcelas exige análise humana.
		if r.art113 == 1 {
			res.TemParcelamento = true
			if !res.F02 {
				res.F02 = true
				res.FichasAplicadas = append(res.FichasAplicadas, "F02")
				res.QtdRegras = len(res.FichasAplicadas)
			}
			res.Detalhamento = append(res.Detalhamento, "⚠️ TEM PARCELAMENTO (Art.113) — sempre analisar")
			out[id] = res
		} else if res.QtdRegras > 0 {
			// Antes: exigia !gateGold || gold + r.revisao == 0. Agora aceita tudo
			// que dispara alguma regra F01-F05 — faturas de revisão viram
			// apontamento tb (analista decide se procede).
			out[id] = res
		}

		// atualiza histórico (a média usa consByUC, já montado na 1ª passada)
		medAnt = med
		leitAtuAnt = latu
		mesIdxAnt = curMesIdx
		leitAntConf = curConf
	}
	return out, nil
}

// mesMM extrai o mês (MM) de um mes_referencia em "YYYY-MM[-DD]" ou "MM/YYYY".
func mesMM(s string) string {
	if m := regexp.MustCompile(`^\d{4}-(\d{2})`).FindStringSubmatch(s); m != nil {
		return m[1]
	}
	if m := regexp.MustCompile(`^(\d{2})/\d{4}`).FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return ""
}

// classificaHistorico rotula um apontamento F02 pelo histórico da PRÓPRIA UC (advisory,
// não remove nada): "DENTRO_DO_HISTORICO" quando o consumo já foi atingido antes (≤ 1,05×
// o máximo histórico), "SAZONAL" quando o mesmo mês em outros anos também é alto (safra/
// entressafra), senão "ELEVADO_REAL". serie/meses têm o MESMO índice; lidx = mês atual.
func classificaHistorico(serie []float64, meses []string, lidx int, cons, media float64) string {
	if lidx < 0 || lidx >= len(serie) {
		return "ELEVADO_REAL"
	}
	mm := ""
	if lidx < len(meses) {
		mm = mesMM(meses[lidx])
	}
	histMax, maxMesmoMes := 0.0, 0.0
	for j, v := range serie {
		if j == lidx || v <= F02MinKWh {
			continue
		}
		if v > histMax {
			histMax = v
		}
		if mm != "" && j < len(meses) && mesMM(meses[j]) == mm && v > maxMesmoMes {
			maxMesmoMes = v
		}
	}
	if histMax > 0 && cons <= histMax*1.05 {
		return "DENTRO_DO_HISTORICO"
	}
	if maxMesmoMes > 0 && (cons <= 1.5*maxMesmoMes || (media > 0 && maxMesmoMes >= media*1.8)) {
		return "SAZONAL"
	}
	// CRESCENTE (07/08/2026): consumo subindo de um piso baixo para um novo patamar
	// (ex.: cliente saiu do mínimo e cresceu gradualmente). O mínimo antigo puxa a média
	// pra baixo e infla o desvio — MAS o apontamento se mantém (pode ser mudança real de
	// carga, normal, OU subfaturamento por estimativa no período anterior). Só rotula
	// (advisory), não remove. Sinal: metade RECENTE do histórico anterior >> metade antiga.
	{
		ant := make([]float64, 0, lidx)
		for j := 0; j < lidx; j++ {
			if serie[j] > F02MinKWh {
				ant = append(ant, serie[j])
			}
		}
		if len(ant) >= 4 {
			h := len(ant) / 2
			var a1, a2 float64
			for _, v := range ant[:h] {
				a1 += v
			}
			for _, v := range ant[h:] {
				a2 += v
			}
			a1 /= float64(h)
			a2 /= float64(len(ant) - h)
			if a1 > 0 && a2 >= 1.8*a1 && cons >= a2 {
				return "CRESCENTE"
			}
		}
	}
	return "ELEVADO_REAL"
}

// f03bLinha — subset das colunas usadas no pré-cálculo (evita dependência
// do type interno fatRow).
type f03bLinha struct {
	id     int64
	chave  string
	mes    string
	cons   float64
	lant   float64 // leitura anterior (FP) — p/ F03B leitura-confirmado
	latu   float64 // leitura atual (FP)
	k      float64 // constante
	leitOK bool    // leituras válidas?
}

// f03bMatch — resultado do pré-cálculo F03B por fatura_id.
type f03bMatch struct {
	piso    float64
	seqTam  int
	picoID  int64
	picoMes string
}

// precomputeF03B detecta padrão "piso longo → pico" por UC:
//   - Encontra sequências ≥F03BPisoMinSeq no mesmo piso (100/50/30 kWh) consecutivas.
//   - Checa se o próximo mês (ou até F03BJanelaPos meses após) é PICO F02
//     (≥100% acima da média cross-fatura calculada com valores ANTES da sequência).
//   - Se qualifica, marca cada fatura_id da sequência de piso com o pico de referência.
// A sequência de piso É a irregularidade (meses estimados); o mês do pico já é F02.
func precomputeF03B(data []f03bLinha) map[int64]f03bMatch {
	out := map[int64]f03bMatch{}
	pisos := map[float64]bool{100: true, 50: true, 30: true}

	// agrupa por chave (UC) mantendo ordem cronológica
	byChave := map[string][]int{} // chave → índices em data
	for i, r := range data {
		byChave[r.chave] = append(byChave[r.chave], i)
	}

	for _, idxs := range byChave {
		if len(idxs) < F03BPisoMinSeq+1 {
			continue
		}
		i := 0
		for i < len(idxs) {
			cons := round1(data[idxs[i]].cons)
			if !pisos[cons] {
				i++
				continue
			}
			// conta seq consecutiva no MESMO piso
			j := i
			for j < len(idxs) && round1(data[idxs[j]].cons) == cons {
				j++
			}
			seqTam := j - i
			if seqTam < F03BPisoMinSeq {
				i = j
				continue
			}
			// procura pico F02 em até F03BJanelaPos meses após a sequência
			picoIdx := -1
			for k := j; k < len(idxs) && k < j+F03BJanelaPos; k++ {
				consK := data[idxs[k]].cons
				if consK <= F02MinKWh {
					continue
				}
				// média cross-fatura dos valores ANTERIORES à sequência de piso
				base := []float64{}
				start := i - F02JanelaM
				if start < 0 {
					start = 0
				}
				for m := start; m < i; m++ {
					v := data[idxs[m]].cons
					if v > F02MinKWh {
						base = append(base, v)
					}
				}
				media, baseN := mediaExcluindoPiso(base)
				if baseN >= F02BaseMin && media > 0 && (consK-media)/media >= F02AltoPct {
					picoIdx = k
					break
				}
			}
			if picoIdx < 0 {
				i = j
				continue
			}
			// qualifica: marca cada mês do run como F03B, vinculado ao pico
			pico := data[idxs[picoIdx]]
			for m := i; m < j; m++ {
				fid := data[idxs[m]].id
				out[fid] = f03bMatch{
					piso:    cons,
					seqTam:  seqTam,
					picoID:  pico.id,
					picoMes: pico.mes,
				}
			}
			i = j
		}
	}

	// ── F03B LEITURA-CONFIRMADO (17/07/2026) ──────────────────────────────
	// Certeza pelo medidor: run de meses (piso + medidor parado) fechado por
	// catch-up com leitura real. Não exige base anterior — pega UC estimada
	// desde o início (VTAL etc.). Só marca ids ainda não pegos pelo path clássico.
	for _, idxs := range byChave {
		n := len(idxs)
		i := 0
		for i < n {
			r := data[idxs[i]]
			if !(r.leitOK && r.cons <= F03BFloorMax && math.Abs((r.latu-r.lant)*r.k) <= F03BMeterStill) {
				i++
				continue
			}
			// estende o run de (piso + medidor parado)
			j := i
			for j < n {
				rj := data[idxs[j]]
				if !rj.leitOK || rj.cons > F03BFloorMax || math.Abs((rj.latu-rj.lant)*rj.k) > F03BMeterStill {
					break
				}
				j++
			}
			runLen := j - i
			if runLen < F03BMinRunLeit {
				if j == i {
					j = i + 1
				}
				i = j
				continue
			}
			// catch-up nos próximos F03BJanelaPos meses: mês real com delta grande
			catchIdx := -1
			for k := j; k < n && k < j+F03BJanelaPos; k++ {
				rk := data[idxs[k]]
				if rk.leitOK && rk.cons > F02MinKWh && (rk.latu-rk.lant)*rk.k >= F03BCatchupMin {
					catchIdx = k
					break
				}
			}
			if catchIdx < 0 {
				i = j
				continue
			}
			pico := data[idxs[catchIdx]]
			for m := i; m < j; m++ {
				fid := data[idxs[m]].id
				if _, exists := out[fid]; !exists {
					out[fid] = f03bMatch{piso: data[idxs[m]].cons, seqTam: runLen, picoID: pico.id, picoMes: pico.mes}
				}
			}
			i = j
		}
	}
	return out
}

// mediaExcluindoPiso calcula a média ignorando o "piso" de faturamento mínimo/
// estimado: quando UM mesmo valor se repete e domina a janela (>=3x e >=40% dos
// meses), ele é tratado como mínimo/estimado e removido — desde que sobrem
// >=F02BaseMin valores reais. Evita F02 FALSO quando a instalação sai de meses
// de mínimo (ex.: 100 kWh fixos) pro consumo real (caso ENEL SP inst. 203833461:
// 15 meses de 100 puxavam a média p/ ~186 e faziam 417 parecer +124%).
// Retorna (média, nº de meses efetivos).
func mediaExcluindoPiso(vals []float64) (float64, int) {
	if len(vals) == 0 {
		return 0, 0
	}
	cont := map[float64]int{}
	for _, v := range vals {
		cont[round1(v)]++
	}
	var piso float64
	pisoN := 0
	for v, n := range cont {
		if n > pisoN {
			pisoN = n
			piso = v
		}
	}
	use := vals
	if pisoN >= 3 && float64(pisoN) >= 0.4*float64(len(vals)) {
		f := make([]float64, 0, len(vals))
		for _, v := range vals {
			if round1(v) != piso {
				f = append(f, v)
			}
		}
		if len(f) >= F02BaseMin {
			use = f
		}
	}
	s := 0.0
	for _, v := range use {
		s += v
	}
	return s / float64(len(use)), len(use)
}

// mediaHistoricoImpresso calcula a média do consumo a partir do histórico
// impresso NA PRÓPRIA fatura (historico_consumo_json) — a base correta p/ F02,
// pois é densa e contemporânea, imune ao encadeamento cross-fatura esparso/fora
// de ordem. Soma consumo_kwh (ou ponta+fponta), filtra meses > F02MinKWh,
// exclui UMA ocorrência do próprio mês (consumo ≈ atual) e usa até F02JanelaM.
// Retorna (média, nº de meses na base). base 0 = sem histórico utilizável.
func mediaHistoricoImpresso(js string, consumoAtual float64) (float64, int) {
	if strings.TrimSpace(js) == "" {
		return 0, 0
	}
	var arr []struct {
		Ano           int      `json:"ano"`
		Mes           string   `json:"mes"`
		ConsumoKwh    *float64 `json:"consumo_kwh"`
		ConsumoPonta  *float64 `json:"consumo_ponta_kwh"`
		ConsumoFponta *float64 `json:"consumo_fponta_kwh"`
	}
	if json.Unmarshal([]byte(js), &arr) != nil {
		return 0, 0
	}
	vals := make([]float64, 0, len(arr))
	for _, e := range arr {
		v := 0.0
		switch {
		case e.ConsumoKwh != nil:
			v = *e.ConsumoKwh
		default:
			if e.ConsumoPonta != nil {
				v += *e.ConsumoPonta
			}
			if e.ConsumoFponta != nil {
				v += *e.ConsumoFponta
			}
		}
		if v > F02MinKWh {
			vals = append(vals, v)
		}
	}
	// exclui o próprio mês (o histórico Light/etc. inclui o mês corrente no topo)
	for i, v := range vals {
		if math.Abs(v-consumoAtual) <= 0.5 {
			vals = append(vals[:i], vals[i+1:]...)
			break
		}
	}
	if len(vals) > F02JanelaM {
		vals = vals[:F02JanelaM]
	}
	if len(vals) == 0 {
		return 0, 0
	}
	return mediaExcluindoPiso(vals)
}

// historicoConsistente — true se o histórico impresso está na MESMA escala do
// consumo atual (colunas): existe ao menos um mês cujo total (consumo_kwh, ou
// consumo_ponta+consumo_fponta) cai em [0,5×, 2×] do consumo atual. Quando NENHUM
// mês chega perto, a extração do histórico está inconsistente (ex.: fora-ponta
// jogada no campo demanda) e NÃO serve de base p/ F02 — evita PICO_OUTLIER falso.
func historicoConsistente(js string, consumoAtual float64) bool {
	if consumoAtual <= 0 || strings.TrimSpace(js) == "" {
		return false
	}
	var arr []struct {
		ConsumoKwh    *float64 `json:"consumo_kwh"`
		ConsumoPonta  *float64 `json:"consumo_ponta_kwh"`
		ConsumoFponta *float64 `json:"consumo_fponta_kwh"`
	}
	if json.Unmarshal([]byte(js), &arr) != nil {
		return false
	}
	lo, hi := 0.5*consumoAtual, 2.0*consumoAtual
	for _, e := range arr {
		v := 0.0
		if e.ConsumoKwh != nil {
			v = *e.ConsumoKwh
		} else {
			if e.ConsumoPonta != nil {
				v += *e.ConsumoPonta
			}
			if e.ConsumoFponta != nil {
				v += *e.ConsumoFponta
			}
		}
		if v >= lo && v <= hi {
			return true
		}
	}
	return false
}

// mesIndice converte mes_referencia em índice (ano*12+mês) p/ checar adjacência.
// Aceita "AAAA-MM[-DD]" e "MM/AAAA". 0 = não reconhecido.
func mesIndice(s string) int {
	if m := regexp.MustCompile(`^(\d{4})-(\d{2})`).FindStringSubmatch(s); m != nil {
		y, _ := strconv.Atoi(m[1]); mo, _ := strconv.Atoi(m[2])
		if y > 0 && mo > 0 {
			return y*12 + mo
		}
	}
	if m := regexp.MustCompile(`^(\d{2})/(\d{4})`).FindStringSubmatch(s); m != nil {
		mo, _ := strconv.Atoi(m[1]); y, _ := strconv.Atoi(m[2])
		if y > 0 && mo > 0 {
			return y*12 + mo
		}
	}
	return 0
}

// GetDesvioCasos — GET /api/v1/desvio/casos?empresa=4&gate=gold
// JSON motor-only (casos + resumo + catálogo de regras). Útil p/ debug e prompt.
func GetDesvioCasos(c *gin.Context) {
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro de conexão"})
		return
	}
	empresa := strings.TrimSpace(c.Query("empresa"))
	gateGold := strings.ToLower(strings.TrimSpace(c.DefaultQuery("gate", "gold"))) != "all"

	apont, err := motorApontamentos(sqlDB, empresa, gateGold)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Reconsulta os campos de exibição só das faturas apontadas.
	casos := []DesvioCaso{}
	resumo := map[string]int{"F01": 0, "F02": 0, "F03": 0, "F04": 0, "F05": 0, "total": 0}
	if len(apont) > 0 {
		ids := make([]string, 0, len(apont))
		qargs := make([]any, 0, len(apont))
		for id := range apont {
			ids = append(ids, "?")
			qargs = append(qargs, id)
		}
		q := `SELECT id, COALESCE(cod_empresa,0), COALESCE(distribuidora,''),
		             COALESCE(numero_instalacao,''), COALESCE(mes_referencia,''),
		             COALESCE(numero_medidor,''), COALESCE(validador_gate,''), COALESCE(link_fatura,'')
		      FROM FATURA_DADOS_EXTRAIDOS WHERE id IN (` + strings.Join(ids, ",") + `)`
		rows, err := sqlDB.Query(q, qargs...)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var id, codEmp int64
				var dist, uc, mes, med, vgate, link string
				if rows.Scan(&id, &codEmp, &dist, &uc, &mes, &med, &vgate, &link) != nil {
					continue
				}
				res := apont[id]
				casos = append(casos, DesvioCaso{
					ID: id, UC: uc, CodEmpresa: codEmp, Distribuidora: dist, MesRef: mes,
					Medidor: med, LinkFatura: link, ValidadorGate: vgate, Resultado: res,
				})
				resumo["total"]++
				for _, f := range res.FichasAplicadas {
					resumo[f]++
				}
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"casos":  casos,
		"resumo": resumo,
		"regras": RegistroRegras,
	})
}

// MotorApontamentosFonte roda o MESMO motor F01-F05 sobre uma fonte arbitrária (tabela ou
// subconsulta "(SELECT ...) t" com as colunas da FDE) — usado pelo cmd/motor_claro, que mapeia
// FATURA_CLARO_DADOS_EXTRAIDOS para o formato da FDE. Somente leitura.
func MotorApontamentosFonte(sqlDB *sql.DB, fonte, where string, args []any) (map[int64]ResultadoDesvio, error) {
	return motorApontamentosWhere(sqlDB, fonte, where, args)
}
