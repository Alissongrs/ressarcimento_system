import biApi from './biApi';

function buildQS(filters = {}) {
  const p = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') p.append(k, v);
  });
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

export const biProcessCounts = async (filters) => {
  const { data } = await biApi.get(`process_counts${buildQS(filters)}`);
  return data;
};
export const biStatusCounts = async (filters) => {
  const { data } = await biApi.get(`status_counts${buildQS(filters)}`);
  return data;
};
export const biValueEstimate = async (filters) => {
  const { data } = await biApi.get(`value_estimate${buildQS(filters)}`);
  return data;
};
export const biCreditsTotals = async (filters) => {
  const { data } = await biApi.get(`credits_totals${buildQS(filters)}`);
  return data;
};
export const biFunnel = async (filters) => {
  const { data } = await biApi.get(`funnel${buildQS(filters)}`);
  return data;
};
export const biThroughputWeek = async (filters) => {
  const { data } = await biApi.get(`throughput/week${buildQS(filters)}`);
  return data;
};
export const biThroughputMonth = async (filters) => {
  const { data } = await biApi.get(`throughput/month${buildQS(filters)}`);
  return data;
};
export const biTopConcessionarias = async (filters) => {
  const { data } = await biApi.get(`top/concessionarias${buildQS(filters)}`);
  return data;
};
export const biTopClientes = async (filters) => {
  const { data } = await biApi.get(`top/clientes${buildQS(filters)}`);
  return data;
};
export const biAgingBuckets = async (filters) => {
  const { data } = await biApi.get(`aging/buckets${buildQS(filters)}`);
  return data;
};
export const biSLA = async (filters) => {
  const { data } = await biApi.get(`sla${buildQS(filters)}`);
  return data;
};
export const biHeatmapWeek = async (filters) => {
  const { data } = await biApi.get(`heatmap/week${buildQS(filters)}`);
  return data;
};
export const biWipGestores = async (filters) => {
  const { data } = await biApi.get(`wip/gestores${buildQS(filters)}`);
  return data;
};
export const biHistValor = async (filters) => {
  const { data } = await biApi.get(`hist/valor${buildQS(filters)}`);
  return data;
};
export const biBubblesConcessionarias = async (filters) => {
  const { data } = await biApi.get(`bubbles/concessionarias${buildQS(filters)}`);
  return data;
};
export const biBubblesClientes = async (filters) => {
  const { data } = await biApi.get(`bubbles/clientes${buildQS(filters)}`);
  return data;
};
export const biPareto = async (filters, group = 'concessionaria') => {
  const { data } = await biApi.get(`patterns/pareto${buildQS({ ...(filters||{}), group })}`);
  return data;
};
export const biInsightsSummary = async (filters) => {
  const { data } = await biApi.get(`insights/summary${buildQS(filters)}`);
  return data;
};
export const biThroughputForecast = async (filters, period = 'week', steps = 8) => {
  const { data } = await biApi.get(`throughput/forecast${buildQS({ ...(filters||{}), period, steps })}`);
  return data;
};

export const biPing = async () => {
  const { data } = await biApi.get('ping');
  return data;
};
