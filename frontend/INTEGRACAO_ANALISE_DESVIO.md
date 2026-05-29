# Integração da Nova Análise de Desvio

## 📋 O que foi criado

### 1. **DetalhesFaturaModal.jsx**
Componente modal que exibe detalhes completos de uma fatura:
- Dados básicos (ID, UC, Valor, Concessionária, Período)
- Gráfico de consumo (série histórica 12 meses)
- Fichas detectadas pelo 4.1-mini
- Análise final gpt-5.4 com:
  - Decisão final (CONFIRMADO/REFUTADO/INCONCLUSIVO)
  - Confiança (0-100%)
  - Ressarcimento estimado (%)
  - Ficha principal
  - Justificativa da decisão
  - Recomendação
- Botões: Reprocessar, Aprovar, Rejeitar

**Localização:** `src/components/DetalhesFaturaModal.jsx`

### 2. **AnaliseDesvioSimples.jsx**
Página que substitui o antigo agrupamento por UC:
- Lista **plana** de faturas (sem agrupamento)
- Filtros por empresa e status
- Tabela com 9 colunas: ID, UC, Concessionária, Período, Valor, Status, Confiança, Ressarcimento, Ação
- Cards de resumo: Total, Confirmadas, Refutadas, Ressarcimento Total
- Clique em qualquer linha abre o modal de detalhes

**Localização:** `src/pages/AnaliseDesvioSimples.jsx`

---

## 🔧 Como Integrar

### Opção 1: Substituir a rota existente

No arquivo `src/App.jsx` ou seu arquivo de rotas:

```javascript
// ANTES
import AnaliseDesvio from './pages/AnaliseDesvio';

<Route path="/analise-desvio" element={<AnaliseDesvio />} />

// DEPOIS
import AnaliseDesvioSimples from './pages/AnaliseDesvioSimples';

<Route path="/analise-desvio" element={<AnaliseDesvioSimples />} />
```

### Opção 2: Manter ambas e criar uma nova rota

```javascript
import AnaliseDesvio from './pages/AnaliseDesvio';
import AnaliseDesvioSimples from './pages/AnaliseDesvioSimples';

<Route path="/analise-desvio" element={<AnaliseDesvio />} />
<Route path="/analise-desvio-simples" element={<AnaliseDesvioSimples />} />
```

---

## 📡 API Endpoints Necessários

O frontend espera que o backend tenha estes endpoints:

### 1. Listar Faturas com Análise
```
GET /api/v1/faturas/com-analise
Query Params:
  - empresa: number (ex: 14)
  - status: string (CONFIRMADO | REFUTADO | INCONCLUSIVO | "")
  - limit: number (ex: 1000)

Response:
[
  {
    id: number,
    UC: string,
    valor: number,
    concessionaria: string,
    mes_ref: string,
    status: string,
    resultado_analises: {
      ia_4_1_apontamentos: {
        fichas: string[],
        status: string
      },
      ia_opus_5_4_decisao: {
        decisao_final: string,
        ficha_principal: string,
        fichas_confirmadas: string[],
        confianca_final: number,
        percentual_ressarcimento: number,
        justificativa: string,
        recomendacao: string
      }
    }
  }
]
```

### 2. Obter Detalhes de Fatura
```
GET /api/v1/faturas/{id}/detalhes

Response:
{
  id: number,
  UC: string,
  valor: number,
  concessionaria: string,
  mes_ref: string,
  resultado_analises: { ... }
}
```

### 3. Reprocessar Fatura com IA
```
POST /api/v1/faturas/{id}/reprocessar-ia

Response:
{
  success: boolean,
  message: string,
  resultado_analises: { ... }
}
```

---

## 🎨 Features Implementadas

✅ **Lista Plana** - Faturas individualizadas (SEM agrupamento por UC)
✅ **Clique para Detalhes** - Modal com informações completas
✅ **Gráfico de Consumo** - Série histórica últimos 12 meses
✅ **Fichas 4.1-mini** - Exibição das fichas inicialmente detectadas
✅ **Análise gpt-5.4** - Resultado final com:
  - Decisão final
  - Confiança
  - Ressarcimento estimado
  - Ficha principal
  - Justificativa
  - Recomendação
✅ **Reprocessamento** - Botão para reprocessar com IA
✅ **Aprovação/Rejeição** - Botões para ações finais
✅ **Filtros** - Por empresa e status
✅ **Resumo** - Cards com KPIs principais
✅ **Status Visual** - Cores diferentes para cada decisão

---

## 🚀 Fluxo do Usuário

1. **Acessa a página** `/analise-desvio`
2. **Vê lista plana** de todas as 497 faturas da empresa 14
3. **Clica em uma fatura** para ver detalhes
4. **Modal abre mostrando:**
   - Gráfico de consumo (série histórica)
   - Fichas detectadas pelo modelo 4.1-mini
   - Resultado final da análise gpt-5.4
   - Valor estimado de ressarcimento
   - Justificativa e recomendação
5. **Opções:**
   - Reprocessar com IA (se necessário)
   - Aprovar ressarcimento
   - Rejeitar ressarcimento
   - Fechar modal

---

## 📝 Dados que Vêm do Backend

Tudo vem da coluna `resultado_analises` em `Faturas_Registradas_Cache` que foi preenchida por:

```
analisar_com_motores_ia.py
  └─ gpt-5.4
    └─ Salva em resultado_analises
```

**Estrutura:**
```json
{
  "ia_4_1_apontamentos": {
    "fichas": ["F01", "F02"],
    "status": "CONFIRMADO"
  },
  "ia_opus_5_4_decisao": {
    "decisao_final": "CONFIRMADO",
    "ficha_principal": "F01",
    "fichas_confirmadas": ["F01", "F02"],
    "confianca_final": 90,
    "percentual_ressarcimento": 40,
    "justificativa": "Análise corrobora cobranças irregulares...",
    "recomendacao": "Prosseguir com ressarcimento"
  },
  "processado_em": "2026-04-24T15:13:05",
  "modelo": "gpt-5.4"
}
```

---

## 🔄 Fluxo Completo

```
Fatura no DB
  ↓
[resultado_analises PREENCHIDO]
  ↓
Frontend busca
  ↓
AnaliseDesvioSimples.jsx lista
  ↓
Usuário clica
  ↓
DetalhesFaturaModal.jsx abre
  ↓
Exibe todos os dados + gráfico
  ↓
Opção: Reprocessar ou Aprovar/Rejeitar
```

---

## 🛠️ Customizações Disponíveis

### Cores por Status
No `AnaliseDesvioSimples.jsx`, função `getStatusColor()`:
```javascript
case 'CONFIRMADO': return 'bg-green-500/20 text-green-400 border-green-500/50';
case 'REFUTADO': return 'bg-red-500/20 text-red-400 border-red-500/50';
```

### Número de Meses no Gráfico
No `DetalhesFaturaModal.jsx`, função `gerarDadosConsumo()`:
```javascript
const meses = ['Jan', 'Fev', 'Mar', ...]; // Alterar para mais/menos meses
```

### Limite de Faturas
No `AnaliseDesvioSimples.jsx`, função `carregarFaturas()`:
```javascript
limit: 1000  // Mudar para outro valor
```

---

## ✅ Checklist de Integração

- [ ] Copiar `DetalhesFaturaModal.jsx` para `src/components/`
- [ ] Copiar `AnaliseDesvioSimples.jsx` para `src/pages/`
- [ ] Atualizar rotas em `App.jsx`
- [ ] Implementar endpoints da API (3 endpoints listados acima)
- [ ] Testar modal ao clicar em fatura
- [ ] Testar gráfico de consumo
- [ ] Testar filtros (empresa e status)
- [ ] Testar botão "Reprocessar"
- [ ] Testar botões "Aprovar" e "Rejeitar"
- [ ] Validar estilos/cores no seu tema

---

**Pronto para integrar! 🚀**
