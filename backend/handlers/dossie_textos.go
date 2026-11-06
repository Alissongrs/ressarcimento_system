package handlers

// Textos do dossiê do apontamento escritos para quem NÃO é da área de energia (jurídico, financeiro, cliente):
//   - regraSimples: a regra "em poucas palavras" — o problema e por que pode haver dinheiro a receber;
//   - regraComoExtra: como o sistema aplicou as regras ligadas em 05/11/2026 (regras_extra.go e
//     regras_componentes.go) — completa regraComo (dossie_energia.go);
//   - glossarioDossie: os termos técnicos que aparecem nas contas.

var regraSimples = map[string]string{
	"F01": "O consumo cobrado não bate com o que o medidor registrou. A conta é simples: leitura atual menos leitura anterior, vezes a constante do medidor, tem que dar o consumo faturado. Se a distribuidora cobrou mais do que o medidor mostra, o cliente pagou energia que não usou.",
	"F02": "O consumo deste mês ficou muito acima do normal da própria unidade (pelo menos o dobro da média dos meses anteriores) e depois voltou ao normal. Isso costuma indicar erro de leitura ou de faturamento, não consumo real — e o excesso pode ser contestado.",
	"F03": "A distribuidora cobrou vários meses pela média ou pelo mínimo, sem ler o medidor, e depois cobrou tudo de uma vez. A norma limita esse tipo de cobrança acumulada.",
	"F04": "O consumo disparou junto com a troca do medidor. Quando o medidor é trocado, a cobrança tem que seguir as leituras de retirada e de instalação; um pico logo na troca indica erro no faturamento.",
	"F05": "A leitura que começa esta fatura não é a mesma que terminou a fatura anterior. Se houve 'salto' entre uma fatura e outra, parte do consumo pode ter sido cobrada duas vezes.",
	"F06": "A fatura cobra consumo sem trazer a leitura do medidor e sem dizer que foi por média ou estimativa. Sem leitura, não dá para saber de onde veio o número cobrado.",
	"F07": "O mostrador do medidor 'deu a volta' (passou do máximo e recomeçou do zero). Nesse caso o consumo tem uma conta própria; se a distribuidora errou a conta, cobrou a mais.",
	"F08": "Houve troca de medidor e o consumo cobrado não fecha com as leituras dos dois medidores (o retirado e o novo).",
	"F10": "A fatura foi cobrada pela média, mas a média usada é maior do que a média real dos meses anteriores da unidade. A cobrança pela média tem que usar a média correta.",
	"F11": "A unidade ficou três meses ou mais seguidos sendo cobrada sem leitura do medidor. A norma limita a cobrança sem leitura; depois disso a distribuidora precisa ler o medidor e acertar a conta.",
	"F13": "A fatura cobra energia reativa (um tipo de cobrança técnica) num mês em que a unidade não consumiu energia. Sem consumo, não há como haver excedente de reativo. Atenção: consumo 0 na fatura não basta — se as leituras do medidor mostram consumo, ou se a unidade tem geração própria que abate o consumo, a regra não se aplica.",
	"F14": "Um dos registradores do medidor 'andou para trás' (a leitura atual é menor que a anterior). Isso é sinal de leitura errada, e a cobrança baseada nela também.",
	"F15": "A unidade teve fator de potência dentro do limite (0,92 ou mais) e mesmo assim pagou multa de reativo excedente. A multa só cabe abaixo de 0,92.",
	"F16": "A fatura cobrou mais energia reativa excedente do que o medidor registrou. A cobrança de reativo tem que seguir o que foi medido.",
	"F17": "Unidade de baixa tensão (Grupo B) pagando reativo excedente. Essa cobrança, em regra, é só para unidades de média/alta tensão (Grupo A).",
	"F18": "A fatura cobra demanda reativa excedente, mas o medidor não tem registro de energia reativa. Sem medição, não há base para a cobrança.",
	"F19": "Depois de uma troca de medidor, apareceu cobrança de reativo que antes não existia. Pode ser medidor novo mal configurado.",
	"F20": "A constante do medidor (o multiplicador que transforma a leitura em kWh) parece errada: o consumo cobrado não bate com as leituras usando a constante. Constante errada multiplica o erro em todos os meses.",
	"F21": "Depois de uma troca de medidor, o consumo mudou muito (mais de 50%) e ficou assim. Pode ser medidor novo com defeito ou constante errada.",
	"F23": "Foi cobrada ultrapassagem de demanda (multa por usar mais potência do que a contratada), mas a demanda medida não passou do limite.",
	"F24": "A demanda contratada mudou de um mês para o outro sem padrão. Mudança de contrato precisa de aditivo; se não houve pedido do cliente, a cobrança pode estar errada.",
	"F26": "O cliente aumentou a demanda contratada e foi multado por ultrapassagem no período de teste, quando a norma dá tolerância.",
	"F27": "Unidade de baixa tensão (Grupo B) pagando demanda. Demanda é cobrança de unidades de média/alta tensão.",
	"F28": "A tarifa cobrada (TE e TUSD) está acima da tarifa oficial aprovada pela ANEEL para a distribuidora naquele período.",
	"F29": "Unidade na modalidade Verde sendo cobrada por demanda na ponta. Na Verde, a demanda é uma só; demanda na ponta é da modalidade Azul.",
	"F31": "O ciclo de leitura começou antes do reajuste da tarifa, mas a distribuidora aplicou a tarifa nova no ciclo inteiro. O certo é proporcional aos dias de cada tarifa.",
	"F32": "A tarifa cobrada está acima até da média ponderada entre a tarifa antiga e a nova — não há conta de reajuste que explique o valor.",
	"F33": "O ciclo de leitura teve menos de 15 dias. A norma fixa prazos mínimos; ciclo curto distorce faixas, mínimo e bandeiras.",
	"F34": "O ciclo de leitura passou do prazo máximo (33 dias no Grupo B ou 47 em qualquer grupo). Ciclo longo empurra o consumo para faixas mais caras.",
	"F35": "O total a pagar não bate com a soma dos itens da fatura (ou com a nota fiscal na SEFAZ). Há valor cobrado sem explicação.",
	"F36": "Em um item da fatura, quantidade × tarifa não dá o valor cobrado. A diferença é cobrança sem base.",
	"F38": "A base de cálculo do ICMS incluiu multa e juros de atraso. Multa e juros não são venda de energia e não deveriam pagar ICMS.",
	"F39": "O imposto cobrado não fecha com a conta base × alíquota impressa na própria fatura, ou o PIS/COFINS está acima do teto possível.",
	"F41": "A bandeira tarifária cobrada (verde, amarela, vermelha) não é a que a ANEEL acionou nos meses do ciclo.",
	"F42": "O valor da bandeira por kWh está acima do valor oficial da ANEEL para aquela cor.",
	"F43": "O ciclo teve dias de bandeiras diferentes, mas a fatura cobrou uma bandeira só para o ciclo todo. O certo é proporcional aos dias de cada cor.",
	"F44": "Em unidade com geração própria (GD), a bandeira foi cobrada sobre todo o consumo, inclusive a parte compensada pelos créditos. A bandeira vale só sobre o que não foi compensado.",
	"F45": "A fatura cobrou o encargo 'CDE Covid' (que paga os empréstimos da pandemia) acima do valor oficial da ANEEL, ou depois que ele deixou de existir.",
	"F46": "A fatura cobrou o encargo 'CDE Escassez Hídrica' (que paga os empréstimos da crise hídrica de 2021) num período em que a ANEEL já tinha zerado ou transformado o encargo em devolução para o consumidor.",
	"F48": "A unidade ficou sem energia por mais tempo (DIC) ou mais vezes (FIC) do que o limite da ANEEL e a distribuidora não pagou a compensação automática, que é obrigatória e não depende de pedido.",
	"F49": "A maior interrupção contínua de energia do mês (DMIC) passou do limite da ANEEL e a distribuidora não pagou a compensação automática.",
	"F51": "A taxa de iluminação pública (CIP) cobrada parece estar na faixa errada quando comparada com outras unidades parecidas do mesmo município.",
	"F52": "A taxa de iluminação pública (CIP) foi cobrada duas vezes na mesma fatura.",
	"F53": "A energia injetada pela geração própria caiu muito em relação ao normal da unidade. Pode ser medição da injeção errada — e créditos perdidos.",
	"F54": "O saldo de créditos de energia da geração não fecha a conta: saldo anterior + injetado − compensado tem que dar o saldo impresso.",
	"F55": "A unidade tinha créditos de energia sobrando e mesmo assim pagou consumo acima do mínimo — os créditos deveriam ter sido usados.",
	"F56": "A unidade com geração (GD II) pagou o 'Fio B' (parte da tarifa de uso da rede) acima do percentual permitido no ano pela Lei 14.300, ou pagou Fio B sendo GD I (isenta).",
	"F57": "Fatura de geração do Grupo B cobrando ao mesmo tempo o custo de disponibilidade e o Fio B. A lei manda cobrar só o maior dos dois.",
	"F59": "Na geração própria, o crédito de um horário (ponta ou fora de ponta) foi usado no outro sem a correção pelo 'fator de ajuste' (a razão entre as tarifas dos dois horários). O kWh de ponta vale mais que o de fora de ponta; usar um pelo outro sem ajuste faz o cliente perder crédito.",
	"F62": "Os créditos de energia da usina foram divididos entre as unidades beneficiárias num percentual diferente do que o cliente cadastrou na distribuidora. Uma unidade recebe menos crédito e paga energia que estaria compensada.",
	"F63": "A usina foi enquadrada numa modalidade da Lei 14.300 (GD I, II ou III) diferente da que tem direito. Quem pediu a conexão até 07/01/2023 é GD I e não paga o Fio B até 2045; enquadrar como GD II ou III gera cobrança indevida.",
	"F22": "Em unidades maiores o medidor não mede a energia inteira: transformadores (TC e TP) reduzem a corrente e a tensão, e a leitura é multiplicada por uma constante = RTC × RTP × K do medidor. Se a constante usada na fatura não bate com os transformadores, todo o consumo e a demanda saem multiplicados errado — a mais (cobrança indevida) ou a menos (a distribuidora cobra retroativo depois).",
	"F64": "Créditos de energia da geração própria valem por 60 meses. Esta fatura mostra créditos que vão expirar em breve (ainda dá para redistribuir entre as unidades e aproveitar) ou que já expiraram enquanto havia consumo cobrado sem compensação — energia gerada que o cliente perde.",
	"F58": "A demanda de geração foi cobrada pela tarifa de consumo e acima da tarifa de geração (TUSD G) aprovada pela ANEEL.",
}

var regraComoExtra = map[string]string{
	"F10": "Para cada fatura cobrada sem leitura real, o sistema calcula a média dos até 12 ciclos anteriores com leitura real e compara com o consumo cobrado. Aponta quando o cobrado passa de 10% acima dessa média.",
	"F11": "O sistema percorre a série de faturas da UC e procura 3 ou mais ciclos seguidos sem leitura real (média, estimativa ou impedimento). Aponta uma vez por sequência, dizendo de que mês a que mês.",
	"F16": "Soma o reativo excedente cobrado (kvarh, UFER) e compara com o registrador de EXCEDENTE do próprio medidor, com 3% + 2 kvarh de folga. Quando o registrador é de baixa resolução, ou só há o reativo total, fica como alerta.",
	"F18": "Procura cobrança de demanda reativa excedente (UFDR/DMCR) numa fatura cujo medidor não tem nenhum registrador de energia reativa.",
	"F19": "Detecta a troca de medidor (o número mudou e continuou o novo) e verifica se apareceu cobrança de reativo de pelo menos R$ 10 nos 3 ciclos seguintes.",
	"F20": "Deduz a constante que fecha a conta (consumo cobrado ÷ diferença de leituras) e compara com a constante impressa. Exige consumo de 100 kWh ou mais e 20 unidades de leitura, e não aponta quando o registrador total fecha a conta. Cobrança de 4% a 50% acima do que a constante impressa dá é erro; desvios menores ou maiores ficam como alerta.",
	"F21": "Depois de uma troca de medidor, compara o consumo médio dos 2 meses seguintes com o de antes. Aponta desvio acima de 50%.",
	"F23": "Compara a demanda medida em cada posto com a contratada (com a tolerância da norma). Se houve cobrança de ultrapassagem e a medida não passou do limite, aponta. Ultrapassagem de GERAÇÃO não entra.",
	"F24": "Acompanha a demanda contratada impressa mês a mês e aponta mudanças sem padrão (fora da sazonalidade), dentro de 50% a 200% do valor anterior, para conferir o contrato.",
	"F26": "Depois de um aumento da demanda contratada, verifica se houve cobrança de ultrapassagem nos 3 primeiros ciclos com a medida abaixo do limite do período de teste.",
	"F29": "Na modalidade Verde, procura demanda cobrada no posto ponta.",
	"F31": "Quando o ciclo atravessa a data de um reajuste, calcula a tarifa ponderada pelos dias de cada tarifa (antiga e nova, homologadas pela ANEEL) e compara com a cobrada. Aponta quando a fatura usou a tarifa nova no ciclo inteiro; em geração própria, conta só os kWh não compensados.",
	"F32": "Mesmo caso do F31, mas a tarifa cobrada passa até da maior tarifa possível com PIS/COFINS no teto.",
	"F38": "Verifica se a base do ICMS do quadro de tributos inclui multa, juros ou correção monetária.",
	"F39": "Para cada tributo do quadro da fatura, confere valor = base × alíquota. PIS acima de 1,65% ou COFINS acima de 7,6% vira alerta.",
	"F43": "Compara as bandeiras oficiais da ANEEL em cada dia do ciclo com a cobrada. Aponta quando o ciclo misturou cores e a fatura cobrou uma só, com diferença acima de 10%.",
	"F44": "Em unidade com geração própria, compara a quantidade de kWh da linha de bandeira com o consumo bruto e com o compensado: se a bandeira foi sobre o bruto, o excesso é a parte compensada.",
	"F45": "Soma, por posto, as linhas de CDE Covid da fatura e divide pelos kWh (R$/MWh). Compara com o componente CDE Covid homologado pela ANEEL para a distribuidora no período (dados abertos da ANEEL, 'Componentes Tarifárias'), aceitando até 45% de tributos. Se o componente estava zerado ou negativo (devolução), qualquer cobrança positiva é indevida. Clientes do mercado livre ficam de fora (pagam o encargo à parte).",
	"F46": "Igual ao F45: a ANEEL não separa a Escassez Hídrica da Covid — as duas estão no mesmo componente da tarifa. Nos reajustes de 2025 esse componente virou devolução (negativo); linha positiva de Escassez em cliente cativo nessa vigência é indevida.",
	"F48": "Lê o quadro de continuidade (DIC, FIC, DMIC apurados e limites). Se algum passou do limite, calcula a compensação pela fórmula do PRODIST, Módulo 8, item 225: indicador × VRC ÷ 730 × kei (34 baixa, 40 média, 108 alta tensão; o FIC usa FIC÷limite × limite do DIC); vale o maior, com teto de 18 × VRC. O VRC é o impresso na fatura ou o calculado com o Fio B homologado. Depois procura o crédito nas faturas dos 3 meses seguintes à apuração.",
	"F49": "Lê o quadro de continuidade da fatura (DMIC apurado e limite). Quando a fatura não imprime o limite do DMIC, ele é deduzido pela tabela da ANEEL (Anexo 8.B do PRODIST, REN 1.137/2025) a partir do limite do DIC impresso. Se o DMIC passou do limite, calcula a compensação pela fórmula do PRODIST, Módulo 8, item 225: DMIC apurado × VRC ÷ 730 × kei (34 baixa, 40 média, 108 alta tensão), com teto de 18 × VRC. O VRC é o impresso na fatura (\"Valor EUSD/VRC\") ou, sem ele, o calculado com o Fio B homologado pela ANEEL. Depois procura o crédito da compensação nas faturas dos 3 meses seguintes à apuração; só vira ERRO quando as 3 faturas estão na base e nenhuma traz o crédito.",
	"F22": "Lê o quadro técnico da fatura (RTC, RTP e o K do medidor — Copel e CEMIG imprimem) e a constante usada nas leituras. Com o K impresso, a constante tem de ser RTC × RTP × K (tolerância de 1,5%); sem ele, a razão constante ÷ (RTC × RTP) tem de ser a mesma das outras faturas da UC. No histórico, quando a constante muda de uma fatura para a outra (troca de TC/TP ou de medidor), compara o consumo do mês da troca e do seguinte com a média de até 6 meses antes: desvio acima de 50% nos dois meses, no mesmo sentido, vira alerta. Troca com consumo normal significa que a relação nova foi aplicada certo.",
	"F63": "Lê a classe da GD impressa em cada fatura (campo de modalidade ou o nome da linha da energia injetada: 'Injetada GDI/GDII/GDIII'). Se a classe muda de uma fatura para a seguinte na mesma UC e a nova se mantém, aponta alerta com o valor do 'Ajuste GD' (Fio B) cobrado depois da troca. Também procura a usina na lista de GD da ANEEL — só aceita quando município, raiz do CNPJ do titular e potência (±10%) apontam um único empreendimento; se o cadastro na ANEEL é de até 07/01/2023, a usina é GD I e cobrar Fio B ou tratá-la como GD II/III é erro.",
	"F64": "Lê o quadro de créditos da fatura (lançamentos 'a expirar' com o mês e 'expirados'). Aponta os créditos que expiram em até 2 meses depois do mês da fatura (oportunidade de redistribuir o rateio) e os já expirados no ciclo, dizendo se a mesma fatura cobrou consumo sem compensação. Fica como alerta: o ganho depende de redistribuir ou de provar que havia consumo para abater.",
	"F56": "Na linha de Fio B da GD (\"Ajuste GD II – Lei 14.300\"), divide o valor pelos kWh e compara com o percentual do ano (15% em 2023, 30% em 2024, 45% em 2025, 60% em 2026…) × a TUSD Fio B homologada pela ANEEL. GD I com Fio B cobrado é indevido; GD III não é conferida.",
}

func comoAplicou(cod string) string {
	if t := regraComo[cod]; t != "" {
		return t
	}
	return regraComoExtra[cod]
}

// porqueNivel — o que significa estar como ERRO ou ALERTA, em palavras simples
func porqueNivel(nivel string, extraida bool) string {
	if nivel == "ERRO" {
		return "ERRO quer dizer que a conta da regra fechou com os números da própria fatura: o valor cobrado está fora do que a norma permite. Mesmo assim, antes do pedido à distribuidora, confira os valores marcados na fatura (páginas no fim)."
	}
	t := "ALERTA quer dizer que há um indício forte, mas falta uma confirmação: um dado que a fatura não traz, uma fatura do histórico que não está na base, ou um valor que precisa ser conferido na imagem."
	if extraida {
		t += " Nesta base os dados foram lidos automaticamente da fatura, e a leitura automática pode errar — por isso o sistema não afirma o erro sem a conferência."
	}
	return t + " Se a conferência confirmar, o alerta vira pedido."
}

var glossarioDossie = [][2]string{
	{"UC", "Unidade consumidora: o 'endereço' de energia do cliente na distribuidora (número da instalação)."},
	{"kWh / MWh", "Unidade de energia consumida. 1 MWh = 1.000 kWh."},
	{"kW", "Unidade de potência (demanda): quanto a unidade 'puxa' da rede ao mesmo tempo."},
	{"TE", "Tarifa de Energia: o preço da energia em si."},
	{"TUSD", "Tarifa de Uso do Sistema de Distribuição: o preço pelo uso da rede da distribuidora (o 'frete' da energia)."},
	{"Fio B", "Parte da TUSD que remunera a própria rede da distribuidora. Base de cálculo da compensação de DIC/FIC/DMIC e do pagamento da geração GD II."},
	{"Ponta / fora ponta", "Horários do dia: ponta é a faixa de 3 horas de maior uso da rede (mais cara); fora ponta é o resto."},
	{"Grupo A / Grupo B", "Grupo A: unidades de média e alta tensão (indústrias, comércios grandes, usinas), que pagam demanda. Grupo B: baixa tensão (residências, pequenos comércios)."},
	{"Modalidade Verde / Azul", "Formas de cobrança do Grupo A: na Verde há uma demanda só; na Azul há demanda de ponta e de fora ponta."},
	{"Demanda contratada / ultrapassagem", "Potência que o cliente contratou; passar do limite (com tolerância) gera multa de ultrapassagem."},
	{"Energia reativa / UFER / UFDR", "Energia que não produz trabalho e sobrecarrega a rede; cobrada quando o fator de potência fica abaixo de 0,92."},
	{"Constante do medidor (K)", "Multiplicador que transforma a diferença de leituras em kWh."},
	{"GD (geração distribuída)", "Geração própria do cliente (ex.: usina solar). A energia injetada vira crédito que abate o consumo. GD I: protocolada até 07/01/2023 (isenta do Fio B até 2045); GD II: depois disso, paga parte do Fio B; GD III: usinas maiores, pagam mais."},
	{"ANEEL / REH", "Agência reguladora do setor elétrico. REH (Resolução Homologatória) é o ato que fixa as tarifas de cada distribuidora."},
	{"CDE", "Conta de Desenvolvimento Energético: encargo do setor. 'CDE Covid' e 'CDE Escassez Hídrica' pagam os empréstimos da pandemia e da crise hídrica de 2021."},
	{"Bandeira tarifária", "Adicional por kWh acionado pela ANEEL conforme o custo de geração (verde = sem adicional; amarela; vermelha)."},
	{"DIC / FIC / DMIC", "Indicadores de falta de energia da unidade no mês: DIC = horas sem energia; FIC = quantas vezes faltou; DMIC = a maior interrupção contínua. Passou do limite, a distribuidora paga compensação automática."},
	{"VRC / EUSD", "Valor base da compensação de continuidade: o encargo de uso da rede (parcela Fio B) do mês apurado."},
	{"PRODIST / REN 1000", "Normas da ANEEL: o PRODIST trata dos procedimentos de distribuição (qualidade, medição); a REN 1.000/2021 traz os direitos e deveres na prestação do serviço e no faturamento."},
	{"Cativo / livre (ACL)", "Cativo compra energia da distribuidora; livre (Ambiente de Contratação Livre) compra de um fornecedor e paga à distribuidora só o uso da rede."},
	{"ICMS / PIS / COFINS", "Tributos sobre a fatura: ICMS é estadual; PIS e COFINS são federais."},
}
