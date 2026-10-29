// Service REST para DM_EMPRESA_PERCENTUAL (percentual de ganho da AMEE por empresa)
// Endpoints suportados:
//   GET    /api/v2/empresas-percentual                              → vigências atuais
//   GET    /api/v2/empresas-percentual/:cod_empresa/historico       → timeline completa
//   POST   /api/v2/empresas-percentual/:cod_empresa/vigencia        → cria nova vigência (fecha atual)
//   PUT    /api/v2/empresas-percentual/vigencia/:id                 → corrige vigência (sem histórico)
//   DELETE /api/v2/empresas-percentual/vigencia/:id                 → desativa

import axios from 'axios';

const USE_MOCK =
  (typeof import.meta !== 'undefined' && import.meta?.env?.VITE_USE_MOCK_V2 === '1') ||
  (typeof window !== 'undefined' && window?.__V2_MOCK__);

const apiV2 = axios.create({
  baseURL:
    (typeof import.meta !== 'undefined' && import.meta?.env?.VITE_API_BASE_V2) ||
    '/api/v2',
  withCredentials: true,
});

/** GET /empresas-percentual — lista a vigência ATUAL de cada empresa */
export async function listEmpresasPercentual() {
  if (USE_MOCK) {
    return { items: [] };
  }
  const { data } = await apiV2.get('/empresas-percentual');
  return data || { items: [] };
}

/** GET /empresas-percentual/:cod_empresa/historico — timeline completa */
export async function getHistoricoEmpresa(codEmpresa) {
  if (USE_MOCK) {
    return { cod_empresa: codEmpresa, vigencias: [] };
  }
  const { data } = await apiV2.get(
    `/empresas-percentual/${codEmpresa}/historico`,
  );
  return data;
}

/** POST /empresas-percentual/:cod_empresa/vigencia — cria nova vigência (fecha a anterior) */
export async function criarVigencia(codEmpresa, payload) {
  const { data } = await apiV2.post(
    `/empresas-percentual/${codEmpresa}/vigencia`,
    payload,
  );
  return data;
}

/** PUT /empresas-percentual/vigencia/:id — corrige uma vigência (sem criar nova) */
export async function atualizarVigencia(idVigencia, payload) {
  const { data } = await apiV2.put(
    `/empresas-percentual/vigencia/${idVigencia}`,
    payload,
  );
  return data;
}

/** DELETE /empresas-percentual/vigencia/:id — desativa (preserva histórico) */
export async function desativarVigencia(idVigencia) {
  const { data } = await apiV2.delete(
    `/empresas-percentual/vigencia/${idVigencia}`,
  );
  return data;
}

/** Cálculo cliente-side: dado um processo + lista de vigências da empresa,
 *  retorna { valor, tipo, cor, detalhe, vigencia_aplicada }.
 *
 *  Precedência do percentual:
 *   1) processo.percentual_repasse (override MANUAL por processo) — quando preenchido,
 *      manda no cálculo SÓ deste processo e ignora a vigência da empresa;
 *   2) vigência ativa da empresa em DM_EMPRESA_PERCENTUAL. */
export function calcularGanho(processo, vigenciasEmpresa) {
  if (!processo) return null;

  // 1) Override manual por processo (não altera o percentual geral da empresa)
  const rawOverride = processo.percentual_repasse ?? processo.percentual_processo;
  const override =
    rawOverride === '' || rawOverride == null ? null : Number(rawOverride);
  const temOverride = override != null && !Number.isNaN(override);

  let pctS;
  let pctD;
  let vigLabel;

  if (temOverride) {
    pctS = override;
    pctD = override;
    vigLabel = 'percentual do processo (manual)';
  } else {
    if (!vigenciasEmpresa || vigenciasEmpresa.length === 0) return null;

    // Data de referência: deferimento > encerramento > hoje
    let dataRef;
    if (processo.data_procedencia) {
      dataRef = processo.data_procedencia;
    } else if (processo.etapa_atual?.id === 6 && processo.data_ultima_movimentacao) {
      dataRef = processo.data_ultima_movimentacao.slice(0, 10);
    } else {
      dataRef = new Date().toISOString().slice(0, 10);
    }

    // Encontra vigência aplicável (mais recente ≤ dataRef e não fechada antes)
    const vig = [...vigenciasEmpresa]
      .filter(
        (v) =>
          v.ativo !== false &&
          v.data_vigencia_inicio &&
          v.data_vigencia_inicio <= dataRef &&
          (!v.data_vigencia_fim || v.data_vigencia_fim >= dataRef),
      )
      .sort((a, b) =>
        b.data_vigencia_inicio.localeCompare(a.data_vigencia_inicio),
      )[0];

    if (!vig) return null;

    pctS = Number(vig.percentual_simples ?? 0);
    pctD = Number(vig.percentual_dobro ?? 0);
    vigLabel = `${vig.data_vigencia_inicio} → ${vig.data_vigencia_fim || 'presente'}`;
  }

  // Fase 1: deferido (valor REAL)
  const cs = Number(processo.credito_simples ?? 0);
  const cd = Number(processo.credito_dobro ?? 0);
  // Arredonda CADA componente a 2 casas, como o banco (colunas DECIMAL repasse_simples/dobro
  // são gravadas já arredondadas). Antes o front somava os brutos e arredondava só no display
  // → divergência de 1 centavo vs banco (arredonda-cada-e-soma ≠ soma-e-arredonda). (bug analista)
  const round2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
  if (cs > 0 || cd > 0) {
    const ganhoS = round2((cs * pctS) / 100);
    const ganhoD = round2((cd * pctD) / 100);
    return {
      valor: round2(ganhoS + ganhoD),
      simples: ganhoS,
      dobro: ganhoD,
      pct_simples: pctS,
      pct_dobro: pctD,
      tipo: 'deferido',
      cor: 'verde',
      detalhe: `${pctS}% × R$ ${cs.toLocaleString('pt-BR')}${cd > 0 ? ` + ${pctD}% × R$ ${cd.toLocaleString('pt-BR')}` : ''}`,
      vigencia_aplicada: vigLabel,
    };
  }

  // Fase 2: ainda não deferido (estimativa) — só há valor estimado (sem quebra simples/dobro)
  const est = Number(processo.ressarcimento_estimado ?? 0);
  if (est > 0) {
    const g = round2((est * pctS) / 100);
    return {
      valor: g,
      simples: g,
      dobro: 0,
      pct_simples: pctS,
      pct_dobro: pctD,
      tipo: 'estimado',
      cor: 'azul',
      detalhe: `${pctS}% × R$ ${est.toLocaleString('pt-BR')} (estimado)`,
      vigencia_aplicada: vigLabel,
    };
  }

  return null;
}
