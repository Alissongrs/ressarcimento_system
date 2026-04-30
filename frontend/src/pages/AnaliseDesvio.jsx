import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ReferenceLine, ReferenceArea, ScatterChart, Scatter, ZAxis, Cell,
} from 'recharts';
import apiClient from '../services/apiClient';

/* ────────────────────────────────────────────────────────────────────────────
   Constantes
   ──────────────────────────────────────────────────────────────────────────── */

const FICHAS = [
  { id: 'f01', label: 'F01', nome: 'Divergência de Fórmula',        endpoint: '/api/v1/faturas/ficha/01', cor: '#1a56db' },
  { id: 'f02', label: 'F02', nome: 'Desvio de Média',               endpoint: '/api/v1/faturas/ficha/02', cor: '#0e9f6e' },
  { id: 'f03', label: 'F03', nome: 'Acúmulo de Consumo',            endpoint: '/api/v1/faturas/ficha/03', cor: '#c27803' },
  { id: 'f04', label: 'F04', nome: 'Troca de Medidor',              endpoint: '/api/v1/faturas/ficha/04', cor: '#9061f9' },
  { id: 'f05', label: 'F05', nome: 'Quebra de Leitura',             endpoint: '/api/v1/faturas/ficha/05', cor: '#e02424' },
  { id: 'f06', label: 'F06', nome: 'Ausência de Leituras',          endpoint: '/api/v1/faturas/ficha/06', cor: '#0891b2' },
  { id: 'f07', label: 'F07', nome: 'Rollover de Medidor',           endpoint: '/api/v1/faturas/ficha/07', cor: '#7c3aed' },
  { id: 'f08', label: 'F08', nome: 'Troca sem Zeramento',           endpoint: '/api/v1/faturas/ficha/08', cor: '#b45309' },
  { id: 'f09', label: 'F09', nome: 'Leitura Estimada',              endpoint: '/api/v1/faturas/ficha/09', cor: '#be185d' },
  { id: 'f10', label: 'F10', nome: 'Tarifa Incorreta',              endpoint: '/api/v1/faturas/ficha/10', cor: '#065f46' },
  { id: 'f11', label: 'F11', nome: 'Demanda Contratada',            endpoint: '/api/v1/faturas/ficha/11', cor: '#1e40af' },
  { id: 'f12', label: 'F12', nome: 'Ausência de Medição',            endpoint: '/api/v1/faturas/ficha/12', cor: '#92400e' },
  { id: 'f13', label: 'F13', nome: 'Consumo Zero com Demanda/Rea.', endpoint: '/api/v1/faturas/ficha/13', cor: '#dc6803' },
  { id: 'f14', label: 'F14', nome: 'Outros Erros IA',               endpoint: '/api/v1/faturas/ficha/14', cor: '#374151' },
];

const FICHA_COLORS = {
  F01: '#1a56db', F02: '#0e9f6e', F03: '#c27803', F04: '#9061f9', F05: '#e02424',
  F06: '#0891b2', F07: '#7c3aed', F08: '#b45309', F09: '#be185d', F10: '#065f46',
  F11: '#1e40af', F12: '#92400e', F13: '#dc6803', F14: '#374151',
};

const FICHA_DESCRICAO = {
  F01: { nome: 'Divergência de Fórmula',
         desc: 'Cálculo (LeitAtu − LeitAnt) × Constante não fecha com o kWh faturado.' },
  F02: { nome: 'Desvio de Média',
         desc: 'Consumo do mês difere significativamente (≥100%) da média histórica da UC.' },
  F03: { nome: 'Acúmulo de Consumo',
         desc: 'Consumo concentrado em um mês após período com leituras zero ou estimadas.' },
  F04: { nome: 'Troca de Medidor',
         desc: 'Medidor substituído sem zeramento adequado da leitura ou cobrança duplicada.' },
  F05: { nome: 'Quebra de Leitura',
         desc: 'Leitura atual menor que a anterior (rollover ou erro) sem ajuste.' },
  F06: { nome: 'Ausência de Leituras',
         desc: 'Mês sem leitura registrada — fatura emitida com estimativa.' },
  F07: { nome: 'Rollover de Medidor',
         desc: 'Medidor virou de capacidade (ex: 99999 → 00000) sem tratamento.' },
  F08: { nome: 'Troca sem Zeramento',
         desc: 'Substituição do medidor sem reset, gerando consumo fantasma.' },
  F09: { nome: 'Leitura Estimada',
         desc: 'Leitura calculada por estimativa (não real) cobrada como real.' },
  F10: { nome: 'Tarifa Incorreta',
         desc: 'Tarifa aplicada não corresponde à modalidade/grupo/subgrupo da UC.' },
  F11: { nome: 'Demanda Contratada',
         desc: 'Cobrança de demanda divergente do contrato ou ultrapassagem indevida.' },
  F12: { nome: 'Ausência de Medição',
         desc: 'Fatura sem identificação do medidor (campo NroMedidor vazio) com consumo significativo.' },
  F13: { nome: 'Consumo Zero com Demanda/Reativo',
         desc: 'Consumo ativo zero mas com demanda ou reativo — incoerência técnica.' },
  F14: { nome: 'Outros Erros IA',
         desc: 'Anomalia identificada pela IA que não se encaixa nas categorias F01-F13.' },
};

const SEVERITY_COLORS = { 5: '#ef4444', 4: '#f97316', 3: '#eab308', 2: '#22c55e', 1: '#3b82f6' };
const SEVERITY_LABELS = { 5: 'Urgente', 4: 'Crítico', 3: 'Alto', 2: 'Médio', 1: 'Baixo' };

// Fallback de razão social por Cod_Empresa (quando o backend não retorna cliente).
// Fonte oficial: Tab_Empresas (Rz_Social) — esse mapa é cache local.
const EMPRESA_NOME = {
  4:   'VIA S.A.',
  14:  'REZEK',
  32:  'VULCABRAS',
  33:  'MOINHO DO PIAUI LTDA',
  69:  'KAZOLY ECOLOGICA LTDA',
  70:  'GRANTRIGO (PRÉVIA)',
  80:  'TECNO INDUSTRIA E COMERCIO DE COMPUTADORES LTDA',
  120: 'VITALLIS CENTRO MEDICO',
  135: 'VTAL REDE NEUTRA DE TELECOMUNICACOES S.A.',
  144: 'GGF AGRO LTDA',
  145: 'NAZARIA',
  154: 'COYOTE ALIMENTACAO LTDA',
  176: 'REAL ALIMENTOS LTDA',
  180: 'MACSO IND COM LTDA',
  181: 'ITARAI METALURGICA LTDA',
  183: 'LEGIAO DA BOA VONTADE',
  189: 'HOSPITAL ISRAELITA ALBERT EINSTEIN',
  191: 'AGENCIA VIP AIR ENERGY ADVISOR',
  199: 'BP BUNGE',
  202: 'NUTRISAVOUR COMERCIO DE ALIMENTOS LTDA',
  203: 'AB BRASIL INDL E COM DE ALIMENTOS LTDA',
  204: 'ACOTEMPERA TRATAMENTO TERMICO LTDA',
  205: 'ALUMINIO FUJI LTDA',
  206: 'AUTOMEC COMERCIAL LTDA',
  209: 'PANIFICADORA PIVETTA LTDA (SANTA ROSALIA)',
  210: 'OPERADORA HOTELEIRA VILLA ROSSA LTDA',
  211: 'TROPICAL MOTEL LTDA',
  212: 'NEWKAR DISTRIBUIDORA DE PECAS LTDA',
  213: 'ALPHAVILLE GRACIOSA CLUBE',
  214: 'MRM RELACOES E EVENTOS LTDA',
  216: 'BIOLABOR - LABORATORIO DE ANALISES CLINICAS',
  217: 'NOVA GALREI GALVANOPLASTIA INDUSTRIAL',
  218: 'LINUS PAULING MEDICINA DIAGNOSTICA EIRELI',
  219: 'FARMA PONTE',
  223: 'ABRAO REZE COMERCIO DE VEICULOS LTDA',
  224: 'ANTONIO BOZELLI FILHO',
  226: 'ECOPLAST INDUSTRIA E COMERCIO DE RECICLADOS EIRELI',
  227: 'NOVA MILANO INVESTIMENTOS LTDA',
  359: 'SER EDUCACIONAL S.A.',
  362: 'HAPVIDA ASSISTENCIA MEDICA S.A.',
  366: 'FRANQUEADOS MCDONALDS',
  367: 'VENEZA NEGOCIOS E PARTICIPACOES SA',
  368: 'ZILDO LINO',
  369: 'BEVERDE EMPREENDIMENTOS',
  370: 'BAZZA DISTRIBUIDORA LTDA.',
  374: 'EVEN CONSTRUTORA',
};

const getNomeEmpresa = (row) => {
  const cod = Number(row?.Cod_Empresa ?? row?.cod_empresa ?? row?.empresa);
  // 1) Backend retornou nome direto?
  const direto = row?.RAZAO_SOCIAL || row?.razao_social || row?.cliente
              || row?.Razao_Social || row?.RazaoSocial;
  const nome = (direto && String(direto).trim())
    ? String(direto).trim()
    : (cod && EMPRESA_NOME[cod]) || null;
  if (cod && nome) return `${cod} — ${nome}`;
  if (nome)         return nome;
  if (cod)          return String(cod);
  return '—';
};

const TABS = [
  { id: 'apontados',     label: 'Apontados',     cor: '#0ea5e9', sub: 'pendentes de IA' },
  { id: 'aprovados',     label: 'Aprovados',     cor: '#22c55e', sub: 'CONFIRMADO' },
  { id: 'inconclusivos', label: 'Inconclusivos', cor: '#eab308', sub: 'INCONCLUSIVO' },
  { id: 'rejeitados',    label: 'Rejeitados',    cor: '#ef4444', sub: 'REFUTADO' },
];

const STATUS_POR_TAB = {
  aprovados:     'CONFIRMADO',
  inconclusivos: 'INCONCLUSIVO',
  rejeitados:    'REFUTADO',
};

/* ────────────────────────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────────────────────────── */

const fmtCurrency = (v) => {
  const n = Number(v);
  if (v == null || v === '' || Number.isNaN(n)) return '—';
  return `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtPct = (v) => {
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
};

const getRowLink = (r) => String(r?.Link ?? r?.link ?? '').trim();

const parseAnalises = (raw) => {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
};

const getDecisao = (row) => {
  const a = parseAnalises(row?.resultado_analises);
  return a?.ia_opus_5_4_decisao || null;
};

const extractFichas = (raw) => {
  if (!raw) return [];
  const s = String(raw);
  return [...new Set(s.match(/F\d{2}/gi) ?? [])].map(f => f.toUpperCase());
};

/* ────────────────────────────────────────────────────────────────────────────
   FichasBadge
   ──────────────────────────────────────────────────────────────────────────── */

function FichasBadge({ fichas }) {
  if (!fichas?.length) return <span className="text-gray-400">—</span>;
  return (
    <div className="flex flex-wrap gap-0.5">
      {fichas.map(f => {
        const cor  = FICHA_COLORS[f] ?? '#6b7280';
        const info = FICHA_DESCRICAO[f];
        const tip  = info ? `${f} — ${info.nome}\n${info.desc}` : f;
        return (
          <span key={f} title={tip}
            style={{ backgroundColor: cor + '33', color: cor, border: `1px solid ${cor}55` }}
            className="px-1 py-0 rounded text-[10px] font-bold inline-block cursor-help">
            {f}
          </span>
        );
      })}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Status / Confiança
   ──────────────────────────────────────────────────────────────────────────── */

function StatusBadge({ status }) {
  const cores = {
    CONFIRMADO:   'bg-green-500/20 text-green-400 border-green-500/40',
    INCONCLUSIVO: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40',
    REFUTADO:     'bg-red-500/20 text-red-400 border-red-500/40',
    PENDENTE:     'bg-gray-500/20 text-gray-400 border-gray-500/40',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${cores[status] ?? cores.PENDENTE}`}>
      {status || 'PENDENTE'}
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Matriz de Risco — scatter Desvio % × Valor R$
   ──────────────────────────────────────────────────────────────────────────── */

function RiscoMatrizChart({ rows }) {
  const pts = useMemo(() => {
    const groups = {};
    rows.forEach(r => {
      const uc = String(r.UC ?? r.uc ?? r.id ?? '').trim();
      if (!uc) return;
      const x = parseFloat(r.desvio_pct_max ?? r.desvio_pct);
      const y = parseFloat(r.RS_Total_Fatura ?? r.valor);
      const peso = parseInt(r.peso_alerta_max ?? 1, 10) || 1;
      if (!groups[uc]) groups[uc] = { uc, xs: [], ys: [], pesos: [], fichas: new Set() };
      if (!Number.isNaN(x)) groups[uc].xs.push(x);
      if (!Number.isNaN(y)) groups[uc].ys.push(y);
      groups[uc].pesos.push(peso);
      extractFichas(r.fichas_aplicadas).forEach(f => groups[uc].fichas.add(f));
    });

    return Object.values(groups).map(g => {
      const x = g.xs.length ? Math.max(...g.xs) : 0;
      const y = g.ys.length ? Math.max(...g.ys) : 0;
      if (!x && !y) return null;
      const peso = Math.max(...g.pesos);
      return {
        x, y, z: Math.max(1, peso) * 18, peso,
        uc: g.uc, fichas: [...g.fichas].join(', '),
      };
    }).filter(Boolean);
  }, [rows]);

  const medX = useMemo(() => {
    if (!pts.length) return 0;
    const s = [...pts].sort((a, b) => a.x - b.x);
    return s[Math.floor(s.length / 2)]?.x ?? 0;
  }, [pts]);
  const medY = useMemo(() => {
    if (!pts.length) return 0;
    const s = [...pts].sort((a, b) => a.y - b.y);
    return s[Math.floor(s.length / 2)]?.y ?? 0;
  }, [pts]);

  if (pts.length === 0) return (
    <div className="flex items-center justify-center h-32 text-xs opacity-30">
      Sem dados de desvio × valor para exibir matriz
    </div>
  );

  const fmtMoeda = (v) => v >= 1000 ? `R$${(v/1000).toFixed(0)}k` : `R$${v.toFixed(0)}`;

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload; if (!d) return null;
    const col = SEVERITY_COLORS[d.peso] ?? '#6b7280';
    return (
      <div className="rounded-lg border px-3 py-2 text-xs shadow-xl"
        style={{ background: '#0d1a2e', borderColor: `${col}55`, color: '#e2e8f0', minWidth: 180 }}>
        <div className="font-bold font-mono mb-1" style={{ color: col }}>UC {d.uc}</div>
        {d.fichas && <div className="opacity-70 mb-1">{d.fichas}</div>}
        <div>Desvio: <span style={{ color: col }} className="font-semibold">{fmtPct(d.x)}</span></div>
        <div>Valor: <span className="font-semibold">{fmtCurrency(d.y)}</span></div>
        <div>Severidade: <span style={{ color: col }}>{SEVERITY_LABELS[d.peso]}</span></div>
      </div>
    );
  };

  const byPeso = [5,4,3,2,1].map(p => ({
    p, color: SEVERITY_COLORS[p], label: SEVERITY_LABELS[p],
    data: pts.filter(d => d.peso === p),
  })).filter(g => g.data.length > 0);

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-[11px] font-bold tracking-wide opacity-80">MATRIZ DE RISCO</div>
          <div className="text-[9px] opacity-40">{pts.length} UCs · pior mês histórico</div>
        </div>
        <div className="flex items-center gap-3 text-[10px] opacity-60">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{background:'#ef4444'}}/> ACT NOW</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{background:'#eab308'}}/> Monitorar</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{background:'#22c55e'}}/> Baixo</span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <ScatterChart margin={{ top: 8, right: 28, bottom: 24, left: 12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis dataKey="x" name="Desvio" type="number" unit="%" domain={['auto','auto']}
            tick={{ fontSize: 9, fill: '#475569' }}
            label={{ value: 'Desvio %', position: 'insideBottom', offset: -10, fontSize: 10, fill: '#475569' }} />
          <YAxis dataKey="y" name="Valor" type="number" tickFormatter={fmtMoeda}
            tick={{ fontSize: 9, fill: '#475569' }}
            label={{ value: 'Valor', angle: -90, position: 'insideLeft', offset: 10, fontSize: 10, fill: '#475569' }} />
          <ZAxis dataKey="z" range={[40, 220]} />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine x={medX} stroke="rgba(255,255,255,0.08)" strokeDasharray="5 3"/>
          <ReferenceLine y={medY} stroke="rgba(255,255,255,0.08)" strokeDasharray="5 3"/>
          <ReferenceArea x1={medX} y1={medY} fill="rgba(239,68,68,0.06)" />
          <ReferenceArea x2={medX} y1={medY} fill="rgba(245,158,11,0.04)" />
          <ReferenceArea x1={medX} y2={medY} fill="rgba(245,158,11,0.03)" />
          {byPeso.map(({ p, color, label, data }) => (
            <Scatter key={p} name={label} data={data} fill={color} fillOpacity={0.8} />
          ))}
          <Legend iconSize={8} iconType="circle" wrapperStyle={{ fontSize: 10, paddingTop: 4, color: '#64748b' }} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Histórico Drawer (gráfico de barras com onClick)
   ──────────────────────────────────────────────────────────────────────────── */

function MiniChart({ titulo, dados, dataKey, cor, onBarClick, formatTip, media }) {
  const Tip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload;
    const val = d[dataKey] ?? 0;
    const devPct = media > 0 ? ((val - media) / media * 100) : null;
    return (
      <div className="rounded border bg-[#0d1a2e] border-blue-500/40 px-3 py-2 text-xs">
        <div className="font-mono font-bold text-blue-300">{d.mes}</div>
        <div className="font-semibold">{formatTip ? formatTip(val) : val}</div>
        {devPct !== null && (
          <div className={`text-[10px] mt-1 ${Math.abs(devPct) > 50 ? 'text-orange-400 font-semibold' : 'opacity-60'}`}>
            {devPct >= 0 ? '+' : ''}{devPct.toFixed(0)}% vs média ({formatTip ? formatTip(media) : media.toFixed(0)})
          </div>
        )}
        {d.link && <div className="text-[10px] opacity-60 mt-1">clique para abrir fatura</div>}
      </div>
    );
  };
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
      <div className="text-[11px] opacity-60 mb-2 flex items-center gap-2">
        {titulo}
        {media > 0 && (
          <span className="ml-auto text-[10px] text-amber-400 opacity-80">
            — média: {formatTip ? formatTip(media) : media.toFixed(0)}
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart data={dados} margin={{ top: 6, right: 40, bottom: 24, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis dataKey="mes" tick={{ fontSize: 9, fill: '#94a3b8' }} angle={-30} textAnchor="end" height={42}/>
          <YAxis tick={{ fontSize: 9, fill: '#94a3b8' }}
            tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v.toString()}/>
          <Tooltip content={<Tip />} />
          {media > 0 && (
            <ReferenceLine y={media} stroke="#f59e0b" strokeDasharray="4 2" strokeWidth={1.5}
              label={{ value: 'média', fill: '#f59e0b', fontSize: 9, position: 'insideRight' }} />
          )}
          <Bar dataKey={dataKey} fill={cor} radius={[3, 3, 0, 0]} onClick={onBarClick} cursor="pointer">
            {dados.map((d, i) => {
              let fill = d.link ? cor : '#475569';
              if (media > 0) {
                const dev = (d[dataKey] - media) / media;
                if (dev > 1.0 || dev < -0.9) fill = '#ef4444';
                else if (dev > 0.5 || dev < -0.5) fill = '#f97316';
              }
              return <Cell key={i} fill={fill} />;
            })}
          </Bar>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function HistoricoDrawer({ uc, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Fonte: FATURA_DADOS_EXTRAIDOS (db_ressarcimento)
  useEffect(() => {
    if (!uc) return;
    setLoading(true); setError('');
    apiClient.get('/api/v1/faturas/fde-uc-historico', { params: { uc } })
      .then(r => setRows(r.data?.rows ?? []))
      .catch(() => setError('Erro ao carregar histórico'))
      .finally(() => setLoading(false));
  }, [uc]);

  const data = useMemo(() => {
    return [...rows]
      .map(r => ({
        mes:      String(r.Mes_Ref ?? '').slice(0, 7),
        valor:    parseFloat(r.RS_Total_Fatura ?? 0) || 0,
        kwhTotal: parseFloat(r.KWH_Total ?? 0) || 0,
        link:     String(r.Link ?? '').trim(),
        id:       r.id,
      }))
      .filter(d => d.mes)
      .sort((a, b) => a.mes.localeCompare(b.mes));
  }, [rows]);

  const mediaValor    = useMemo(() => { const vs = data.filter(d => d.valor > 0).map(d => d.valor);       return vs.length ? vs.reduce((a,b)=>a+b,0)/vs.length : 0; }, [data]);
  const mediaKwhTotal = useMemo(() => { const vs = data.filter(d => d.kwhTotal > 0).map(d => d.kwhTotal); return vs.length ? vs.reduce((a,b)=>a+b,0)/vs.length : 0; }, [data]);

  const handleBarClick = useCallback((p) => {
    const link = p?.payload?.link;
    if (!link) { alert('Esta fatura não tem PDF vinculado.'); return; }
    window.open(link, '_blank', 'noopener,noreferrer');
  }, []);

  const fmtKwh = (v) => `${v.toLocaleString('pt-BR')} kWh`;

  return (
    <div className="fixed inset-0 z-[9999] flex justify-end bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-3xl bg-[var(--bg)] flex flex-col border-l border-[var(--border)] h-full"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)]"
          style={{ background: 'linear-gradient(135deg, #1e3a5f, #0f2340)' }}>
          <div>
            <div className="text-white font-bold text-sm">Histórico da UC — FATURA_DADOS_EXTRAIDOS</div>
            <div className="text-white/50 text-xs font-mono mt-0.5">{uc}</div>
          </div>
          <button onClick={onClose} className="text-white/60 hover:text-white text-xl leading-none px-2">×</button>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-3">
          {loading && <div className="text-sm opacity-60 py-8 text-center">Carregando histórico...</div>}
          {error   && <div className="text-sm text-red-400 py-8 text-center">{error}</div>}
          {!loading && !error && data.length === 0 && (
            <div className="text-sm opacity-60 py-8 text-center">Sem histórico disponível para esta UC.</div>
          )}
          {!loading && !error && data.length > 0 && (
            <>
              <MiniChart
                titulo="VALOR DA FATURA · clique numa barra para abrir o PDF"
                dados={data} dataKey="valor" cor="#3b82f6"
                onBarClick={handleBarClick} formatTip={fmtCurrency} media={mediaValor}
              />
              <MiniChart
                titulo="kWh TOTAL"
                dados={data} dataKey="kwhTotal" cor="#f59e0b"
                onBarClick={handleBarClick} formatTip={fmtKwh} media={mediaKwhTotal}
              />

              <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]">
                <div className="text-[11px] opacity-60 px-3 py-2 border-b border-[var(--border)]">
                  TODAS AS FATURAS · {data.length}
                </div>
                <div className="max-h-72 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-[var(--bg)] sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left">Mês</th>
                        <th className="px-3 py-2 text-right">Valor R$</th>
                        <th className="px-3 py-2 text-right">kWh Total</th>
                        <th className="px-3 py-2 text-center">PDF</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.map(d => (
                        <tr key={d.id} className="border-t border-[var(--border)]">
                          <td className="px-3 py-2 font-mono">{d.mes}</td>
                          <td className="px-3 py-2 text-right">{fmtCurrency(d.valor)}</td>
                          <td className="px-3 py-2 text-right font-mono">
                            {d.kwhTotal > 0 ? d.kwhTotal.toLocaleString('pt-BR') : '—'}
                          </td>
                          <td className="px-3 py-2 text-center">
                            {d.link
                              ? <a href={d.link} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">abrir</a>
                              : <span className="opacity-30">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Modal Análise IA — mostra resultado salvo + reprocessar
   ──────────────────────────────────────────────────────────────────────────── */

function AnaliseIAModal({ row, onClose, onReprocessed }) {
  const [reprocessing, setReprocessing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const decisao = getDecisao(row);
  const analise = parseAnalises(row?.resultado_analises);
  const triagem = analise?.triagem_confirmar;
  const apontamentos = analise?.ia_4_1_apontamentos;

  const handleReprocessar = useCallback(async () => {
    setReprocessing(true); setError(''); setSuccess('');
    try {
      await apiClient.post(`/api/v1/faturas/${row.id}/reprocessar-ia`);
      setSuccess('Reprocessamento iniciado. Atualize em alguns minutos.');
      onReprocessed?.(row.id);
    } catch (e) {
      setError(e?.response?.data?.error || 'Falha ao reprocessar.');
    } finally {
      setReprocessing(false);
    }
  }, [row?.id, onReprocessed]);

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-3xl bg-[var(--bg)] rounded-xl shadow-2xl flex flex-col border border-[var(--border)]"
        style={{ maxHeight: '92vh' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 rounded-t-xl"
          style={{ background: 'linear-gradient(135deg, #1e3a5f, #0f2340)' }}>
          <div>
            <div className="text-white font-bold text-sm">Análise da IA</div>
            <div className="text-white/50 text-xs font-mono mt-0.5">UC {row.UC} · ID {row.id}</div>
          </div>
          <button onClick={onClose} className="text-white/60 hover:text-white text-xl leading-none px-2">×</button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          {!analise && (
            <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-4 text-sm">
              Nenhuma análise IA disponível. Clique em <strong>Analisar com IA</strong> para iniciar.
            </div>
          )}

          {decisao && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[11px] opacity-60">DECISÃO FINAL · gpt-5.4</div>
                <StatusBadge status={decisao.decisao_final} />
              </div>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <div className="text-[10px] opacity-60">Confiança</div>
                  <div className="font-bold text-blue-400">{decisao.confianca_final ?? 0}%</div>
                </div>
                <div>
                  <div className="text-[10px] opacity-60">Ressarcimento</div>
                  <div className="font-bold text-green-400">{decisao.percentual_ressarcimento ?? 0}%</div>
                </div>
                <div>
                  <div className="text-[10px] opacity-60">Ficha principal</div>
                  <div className="font-bold">{decisao.ficha_principal || '—'}</div>
                </div>
              </div>
              {decisao.fichas_confirmadas?.length > 0 && (
                <div>
                  <div className="text-[10px] opacity-60 mb-1">Fichas confirmadas</div>
                  <FichasBadge fichas={decisao.fichas_confirmadas} />
                </div>
              )}
              {decisao.justificativa && (
                <div>
                  <div className="text-[10px] opacity-60 mb-1">Justificativa</div>
                  <div className="text-xs whitespace-pre-wrap leading-relaxed">{decisao.justificativa}</div>
                </div>
              )}
              {decisao.recomendacao && (
                <div>
                  <div className="text-[10px] opacity-60 mb-1">Recomendação</div>
                  <div className="text-xs whitespace-pre-wrap leading-relaxed">{decisao.recomendacao}</div>
                </div>
              )}
            </div>
          )}

          {triagem && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-2">
              <div className="text-[11px] opacity-60">TRIAGEM · gpt-4.1-mini</div>
              {triagem.fichas_confirmadas?.length > 0 && (
                <div>
                  <div className="text-[10px] opacity-60 mb-1">Fichas que a triagem confirmou</div>
                  <FichasBadge fichas={triagem.fichas_confirmadas} />
                </div>
              )}
              {apontamentos?.analise && (
                <div>
                  <div className="text-[10px] opacity-60 mb-1">Análise inicial</div>
                  <div className="text-xs whitespace-pre-wrap leading-relaxed opacity-80">{apontamentos.analise}</div>
                </div>
              )}
            </div>
          )}

          {error &&<div className="text-sm text-red-400">{error}</div>}
          {success && <div className="text-sm text-green-400">{success}</div>}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-[var(--border)]">
          <button onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-[var(--border)] hover:bg-[var(--bg-secondary)]">
            Fechar
          </button>
          <button onClick={handleReprocessar} disabled={reprocessing}
            className="px-4 py-2 text-sm rounded-lg text-white font-semibold disabled:opacity-50"
            style={{ backgroundColor: '#1e3a5f' }}>
            {reprocessing ? 'Reprocessando...' : 'Reanalisar com IA'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Modal Criar Requisição — pré-preenchido com fatura + análise
   ──────────────────────────────────────────────────────────────────────────── */

function CriarRequisicaoModal({ row, onClose, onCreated }) {
  const decisao = getDecisao(row);
  const fichasIA = decisao?.fichas_confirmadas ?? [];
  const valorFatura = Number(row?.valor ?? row?.RS_Total_Fatura ?? 0);
  const pctRess = Number(decisao?.percentual_ressarcimento ?? 0);
  const valorEstimado = (valorFatura * pctRess) / 100;

  const [form, setForm] = useState({
    uc: row?.UC ?? '',
    concessionaria: row?.Concessionaria ?? row?.concessionaria ?? '',
    cliente: getNomeEmpresa(row),
    mes_ref: row?.Mes_Ref ?? row?.mes_ref ?? '',
    tipo_irregularidade: fichasIA[0] ?? '',
    valor_estimado: valorEstimado.toFixed(2),
    descricao: decisao?.justificativa ?? '',
    fichas: fichasIA.join(', '),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const upd = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const handleSubmit = useCallback(async () => {
    setSaving(true); setError('');
    try {
      const fd = new FormData();
      fd.append('uc', form.uc);
      fd.append('concessionaria', form.concessionaria);
      fd.append('cliente', form.cliente);
      fd.append('mes_ref', form.mes_ref);
      fd.append('tipo_irregularidade', form.tipo_irregularidade);
      fd.append('valor_estimado', form.valor_estimado);
      fd.append('descricao', form.descricao);
      fd.append('fichas', form.fichas);
      fd.append('fatura_id', String(row.id ?? ''));
      fd.append('analise_ia', JSON.stringify(decisao ?? {}));

      const res = await apiClient.post('/api/v1/requisicoes', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      onCreated?.(res?.data);
      onClose();
    } catch (e) {
      setError(e?.response?.data?.error || 'Falha ao criar requisição.');
    } finally {
      setSaving(false);
    }
  }, [form, row, decisao, onCreated, onClose]);

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-2xl bg-[var(--bg)] rounded-xl shadow-2xl flex flex-col border border-[var(--border)]"
        style={{ maxHeight: '92vh' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 rounded-t-xl"
          style={{ background: 'linear-gradient(135deg, #15803d, #052e16)' }}>
          <div>
            <div className="text-white font-bold text-sm">Abrir Requisição</div>
            <div className="text-white/50 text-xs font-mono mt-0.5">UC {row.UC} · ID {row.id}</div>
          </div>
          <button onClick={onClose} className="text-white/60 hover:text-white text-xl leading-none px-2">×</button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="UC" value={form.uc} onChange={upd('uc')} />
            <Field label="Concessionária" value={form.concessionaria} onChange={upd('concessionaria')} />
            <Field label="Cliente / Razão Social" value={form.cliente} onChange={upd('cliente')} className="col-span-2"/>
            <Field label="Mês referência" value={form.mes_ref} onChange={upd('mes_ref')} />
            <Field label="Tipo irregularidade (ficha principal)" value={form.tipo_irregularidade} onChange={upd('tipo_irregularidade')} />
            <Field label="Fichas confirmadas" value={form.fichas} onChange={upd('fichas')} className="col-span-2"/>
            <Field label="Valor estimado (R$)" value={form.valor_estimado} onChange={upd('valor_estimado')} className="col-span-2"/>
          </div>

          <div>
            <div className="text-[11px] opacity-60 mb-1">DESCRIÇÃO / JUSTIFICATIVA</div>
            <textarea value={form.descricao} onChange={upd('descricao')} rows={5}
              className="w-full px-3 py-2 text-sm rounded border border-[var(--border)] bg-[var(--bg-secondary)] focus:outline-none focus:ring-1 focus:ring-green-500"
            />
          </div>

          {error && <div className="text-sm text-red-400">{error}</div>}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-[var(--border)]">
          <button onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-[var(--border)] hover:bg-[var(--bg-secondary)]">
            Cancelar
          </button>
          <button onClick={handleSubmit} disabled={saving || !form.uc}
            className="px-4 py-2 text-sm rounded-lg text-white font-semibold disabled:opacity-50"
            style={{ backgroundColor: '#16a34a' }}>
            {saving ? 'Criando...' : 'Criar Requisição'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, className = '' }) {
  return (
    <div className={className}>
      <label className="block text-[10px] opacity-60 mb-1">{label.toUpperCase()}</label>
      <input value={value ?? ''} onChange={onChange}
        className="w-full px-3 py-2 text-sm rounded border border-[var(--border)] bg-[var(--bg-secondary)] focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Menu de ações por linha
   ──────────────────────────────────────────────────────────────────────────── */

function AcoesMenu({ row, onAction, onClose, anchor }) {
  const ref = useRef(null);
  useEffect(() => {
    const click = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', click);
    return () => document.removeEventListener('mousedown', click);
  }, [onClose]);

  const top = anchor?.bottom ?? 0;
  const left = Math.max(8, (anchor?.right ?? 0) - 220);

  return (
    <div ref={ref}
      className="fixed z-[9998] w-56 rounded-lg border border-[var(--border)] bg-[var(--bg)] shadow-xl py-1"
      style={{ top: top + 4, left }}
    >
      <button onClick={() => onAction('ia')}
        className="w-full px-3 py-2 text-left text-sm hover:bg-[var(--bg-secondary)] flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400"/>
        Analisar com IA
      </button>
      <button onClick={() => onAction('requisicao')}
        className="w-full px-3 py-2 text-left text-sm hover:bg-[var(--bg-secondary)] flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400"/>
        Abrir Requisição
      </button>
      <button onClick={() => onAction('historico')}
        className="w-full px-3 py-2 text-left text-sm hover:bg-[var(--bg-secondary)] flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-yellow-400"/>
        Ver Histórico (gráfico)
      </button>
      {getRowLink(row) && (
        <>
          <div className="border-t border-[var(--border)] my-1"/>
          <a href={getRowLink(row)} target="_blank" rel="noreferrer"
            className="block px-3 py-2 text-sm hover:bg-[var(--bg-secondary)] text-blue-400">
            Abrir PDF da fatura ↗
          </a>
        </>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Filtros
   ──────────────────────────────────────────────────────────────────────────── */

function FiltrosBar({ filtros, setFiltros, ficha, setFicha, fichaCounts, mostrarFicha }) {
  const upd = (k) => (e) => setFiltros({ ...filtros, [k]: e.target.value });
  const clear = () => setFiltros({
    empresa: '', busca: '', valorMin: '', valorMax: '', desvioMin: '', periodoIni: '', periodoFim: '',
  });

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3 space-y-2">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
        <input value={filtros.empresa} onChange={upd('empresa')} placeholder="Empresa"
          className="px-2 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--bg)]"/>
        <input value={filtros.busca} onChange={upd('busca')} placeholder="UC / Cliente / Distribuidora"
          className="px-2 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--bg)] col-span-2"/>
        <input value={filtros.valorMin} onChange={upd('valorMin')} placeholder="Valor min" type="number"
          className="px-2 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--bg)]"/>
        <input value={filtros.valorMax} onChange={upd('valorMax')} placeholder="Valor max" type="number"
          className="px-2 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--bg)]"/>
        <input value={filtros.desvioMin} onChange={upd('desvioMin')} placeholder="Desvio min %" type="number"
          className="px-2 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--bg)]"/>
        <button onClick={clear}
          className="px-2 py-1.5 text-xs rounded border border-[var(--border)] hover:bg-[var(--bg)]">
          Limpar
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <input type="month" value={filtros.periodoIni} onChange={upd('periodoIni')} placeholder="Período início"
          className="px-2 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--bg)]"/>
        <input type="month" value={filtros.periodoFim} onChange={upd('periodoFim')} placeholder="Período fim"
          className="px-2 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--bg)]"/>
      </div>

      {mostrarFicha && (
        <div className="flex flex-wrap gap-1 pt-1 border-t border-[var(--border)]">
          <span className="text-[10px] opacity-50 self-center mr-1">FICHA:</span>
          {FICHAS.map(f => {
            const ativo = ficha === f.id;
            const c = fichaCounts?.[f.id] ?? 0;
            return (
              <button key={f.id} onClick={() => setFicha(f.id)}
                className="px-2 py-0.5 rounded text-[10px] font-bold transition"
                style={{
                  background: ativo ? f.cor : f.cor + '22',
                  color: ativo ? '#fff' : f.cor,
                  border: `1px solid ${f.cor}55`,
                }}
                title={f.nome}>
                {f.label} {c > 0 && <span className="opacity-70">·{c}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Página principal
   ──────────────────────────────────────────────────────────────────────────── */

export default function AnaliseDesvio() {
  const [tab, setTab] = useState('apontados');
  const [ficha, setFicha] = useState('f02');
  const [fichaCounts, setFichaCounts] = useState({});
  const [filtros, setFiltros] = useState({
    empresa: '', busca: '', valorMin: '', valorMax: '', desvioMin: '', periodoIni: '', periodoFim: '',
  });

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showMatriz, setShowMatriz] = useState(true);
  // Ordenação da tabela: { col, dir } onde dir = 'asc' | 'desc'
  const [sort, setSort] = useState({ col: 'id', dir: 'desc' });

  const toggleSort = useCallback((col) => {
    setSort(s => s.col === col
      ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { col, dir: 'asc' }
    );
  }, []);

  const sortValue = (row, col) => {
    const d = getDecisao(row);
    switch (col) {
      case 'id':           return Number(row.id) || 0;
      case 'uc':           return String(row.UC ?? row.uc ?? '');
      case 'cliente':      return getNomeEmpresa(row).toLowerCase();
      case 'concessionaria': return String(row.Concessionaria ?? row.concessionaria ?? '').toLowerCase();
      case 'mes':          return String(row.Mes_Ref ?? row.mes_ref ?? '');
      case 'valor':        return Number(row.RS_Total_Fatura ?? row.valor ?? 0);
      case 'desvio':       return Number(row.desvio_pct_max ?? 0);
      case 'status_ia':    return String(d?.decisao_final ?? 'PENDENTE');
      case 'confianca':    return Number(d?.confianca_final ?? 0);
      case 'ressarcimento': {
        const v = Number(row.RS_Total_Fatura ?? row.valor ?? 0);
        const p = Number(d?.percentual_ressarcimento ?? 0);
        return (v * p) / 100;
      }
      default: return 0;
    }
  };

  const [menuRow, setMenuRow] = useState(null);
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [modalIA, setModalIA] = useState(null);
  const [modalReq, setModalReq] = useState(null);
  const [drawerHist, setDrawerHist] = useState(null);

  // Carrega contagem de fichas por tipo a partir de FATURA_DADOS_EXTRAIDOS
  useEffect(() => {
    apiClient.get('/api/v1/faturas/fde-ficha-resumo')
      .then(r => {
        const c = {};
        (r.data?.fichas ?? []).forEach(f => { c[f.key] = f.total; });
        setFichaCounts(c);
      })
      .catch(() => {});
  }, []);

  // Carrega rows ao mudar tab/ficha/filtros — fonte: FATURA_DADOS_EXTRAIDOS via /fde-analise
  const reload = useCallback(async () => {
    setLoading(true); setError('');
    const abaApontados = tab === 'apontados';
    try {
      const params = {
        limit: 2000,
        empresa: filtros.empresa || undefined,
        // Aba Apontados: filtra pela ficha selecionada; outras abas: filtra pelo status da decisão
        ficha:  abaApontados ? ficha.toUpperCase() : undefined,
        status: !abaApontados ? STATUS_POR_TAB[tab] : undefined,
      };

      const res = await apiClient.get('/api/v1/faturas/fde-analise', { params });
      let data = Array.isArray(res.data) ? res.data : (res.data?.rows ?? []);

      // Filtros client-side: busca por texto, valor e período
      if (filtros.busca) {
        const q = filtros.busca.toLowerCase();
        data = data.filter(r =>
          String(r.UC ?? '').toLowerCase().includes(q) ||
          String(r.Concessionaria ?? '').toLowerCase().includes(q) ||
          String(r.RAZAO_SOCIAL ?? '').toLowerCase().includes(q)
        );
      }
      if (filtros.valorMin) data = data.filter(r => Number(r.RS_Total_Fatura ?? 0) >= Number(filtros.valorMin));
      if (filtros.valorMax) data = data.filter(r => Number(r.RS_Total_Fatura ?? 0) <= Number(filtros.valorMax));
      if (filtros.periodoIni) data = data.filter(r => String(r.Mes_Ref ?? '') >= filtros.periodoIni);
      if (filtros.periodoFim) data = data.filter(r => String(r.Mes_Ref ?? '') <= filtros.periodoFim);

      setRows(data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Falha ao carregar faturas.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [tab, ficha, filtros]);

  useEffect(() => { reload(); }, [reload]);

  // Ordenação aplicada às linhas
  const sortedRows = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      const va = sortValue(a, sort.col);
      const vb = sortValue(b, sort.col);
      let cmp;
      if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb), 'pt-BR', { numeric: true });
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [rows, sort]);

  // Resumo
  const resumo = useMemo(() => {
    const total = rows.length;
    const valor = rows.reduce((s, r) => s + Number(r.RS_Total_Fatura ?? r.valor ?? 0), 0);
    const ress = rows.reduce((s, r) => {
      const d = getDecisao(r);
      const v = Number(r.RS_Total_Fatura ?? r.valor ?? 0);
      return s + (v * Number(d?.percentual_ressarcimento ?? 0)) / 100;
    }, 0);
    const conf = total
      ? rows.reduce((s, r) => s + Number(getDecisao(r)?.confianca_final ?? 0), 0) / total
      : 0;
    return { total, valor, ress, conf };
  }, [rows]);

  const handleClickRow = useCallback((row, e) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuAnchor(rect);
    setMenuRow(row);
  }, []);

  const handleAction = useCallback((kind) => {
    const row = menuRow;
    setMenuRow(null);
    if (!row) return;
    if (kind === 'ia') setModalIA(row);
    else if (kind === 'requisicao') setModalReq(row);
    else if (kind === 'historico') setDrawerHist(row.UC ?? row.uc);
  }, [menuRow]);

  const tabAtual = TABS.find(t => t.id === tab);
  const isApontados = tab === 'apontados';

  return (
    <div className="p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Análise de Faturas</h1>
          <div className="text-xs opacity-60 mt-0.5">
            Apontamentos identificados pelas regras + decisão da IA (gpt-5.4)
          </div>
        </div>
        <button onClick={reload}
          className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-700 text-white font-semibold">
          Atualizar
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--border)]">
        {TABS.map(t => {
          const ativo = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className="px-5 py-2.5 text-sm font-semibold border-b-2 transition -mb-px"
              style={{
                borderColor: ativo ? t.cor : 'transparent',
                color: ativo ? t.cor : 'var(--text)',
                opacity: ativo ? 1 : 0.55,
              }}>
              {t.label}
              <span className="ml-1 text-[10px] opacity-60">· {t.sub}</span>
            </button>
          );
        })}
      </div>

      {/* Filtros */}
      <FiltrosBar
        filtros={filtros}
        setFiltros={setFiltros}
        ficha={ficha}
        setFicha={setFicha}
        fichaCounts={fichaCounts}
        mostrarFicha={isApontados}
      />


      {/* Cards resumo */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card label={`Faturas (${tabAtual?.label})`} value={resumo.total} cor={tabAtual?.cor}/>
        <Card label="Valor total das faturas" value={fmtCurrency(resumo.valor)} />
        {!isApontados && (
          <>
            <Card label="Ressarcimento estimado" value={fmtCurrency(resumo.ress)} cor="#22c55e"/>
            <Card label="Confiança média" value={`${resumo.conf.toFixed(0)}%`} cor="#3b82f6"/>
          </>
        )}
        {isApontados && (
          <>
            <Card label="Ficha selecionada" value={ficha.toUpperCase()} cor={FICHAS.find(f => f.id === ficha)?.cor}/>
            <Card label="Total apontado pela IA" value={resumo.total} cor="#f59e0b"/>
          </>
        )}
      </div>

      {/* Matriz de risco (somente Apontados) */}
      {isApontados && rows.length > 0 && (
        <div>
          <button onClick={() => setShowMatriz(s => !s)}
            className="text-[11px] opacity-60 hover:opacity-100 mb-1">
            {showMatriz ? '▼' : '▶'} Matriz de Risco
          </button>
          {showMatriz && <RiscoMatrizChart rows={rows} />}
        </div>
      )}

      {/* Tabela */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm opacity-60">Carregando...</div>
        ) : error ? (
          <div className="p-8 text-center text-sm text-red-400">{error}</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm opacity-60">Nenhuma fatura encontrada com esses filtros.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[var(--bg)] border-b border-[var(--border)]">
                <tr>
                  <SortTh col="id"             align="left"   sort={sort} onClick={toggleSort}>ID</SortTh>
                  <SortTh col="uc"             align="left"   sort={sort} onClick={toggleSort}>UC</SortTh>
                  <SortTh col="cliente"        align="left"   sort={sort} onClick={toggleSort}>Cliente</SortTh>
                  <SortTh col="concessionaria" align="left"   sort={sort} onClick={toggleSort}>Concessionária</SortTh>
                  <SortTh col="mes"            align="left"   sort={sort} onClick={toggleSort}>Mês</SortTh>
                  <SortTh col="valor"          align="right"  sort={sort} onClick={toggleSort}>Valor</SortTh>
                  <th className="px-3 py-2 text-left">Fichas</th>
                  {isApontados ? (
                    <>
                      <SortTh col="desvio"    align="right"  sort={sort} onClick={toggleSort}>Desvio</SortTh>
                      <SortTh col="status_ia" align="center" sort={sort} onClick={toggleSort}>Status IA</SortTh>
                    </>
                  ) : (
                    <>
                      <SortTh col="status_ia"     align="center" sort={sort} onClick={toggleSort}>Status</SortTh>
                      <SortTh col="confianca"     align="right"  sort={sort} onClick={toggleSort}>Confiança</SortTh>
                      <SortTh col="ressarcimento" align="right"  sort={sort} onClick={toggleSort}>Ressarc.</SortTh>
                    </>
                  )}
                  <th className="px-3 py-2 text-center w-20">Ações</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map(r => {
                  const d = getDecisao(r);
                  const fichas = isApontados
                    ? extractFichas(r.fichas_aplicadas)
                    : (d?.fichas_confirmadas ?? extractFichas(r.fichas_aplicadas));
                  const valor = Number(r.RS_Total_Fatura ?? r.valor ?? 0);
                  const ress = (valor * Number(d?.percentual_ressarcimento ?? 0)) / 100;
                  const id = r.id;

                  return (
                    <tr key={id} className="border-b border-[var(--border)] hover:bg-[var(--bg)]">
                      <td className="px-3 py-2 font-mono text-blue-400">{id}</td>
                      <td className="px-3 py-2 font-mono">{r.UC ?? r.uc}</td>
                      <td className="px-3 py-2 truncate max-w-[200px]" title={getNomeEmpresa(r)}>
                        {getNomeEmpresa(r)}
                      </td>
                      <td className="px-3 py-2">{r.Concessionaria ?? r.concessionaria ?? '—'}</td>
                      <td className="px-3 py-2 font-mono">{String(r.Mes_Ref ?? r.mes_ref ?? '').slice(0, 7)}</td>
                      <td className="px-3 py-2 text-right">{fmtCurrency(valor)}</td>
                      <td className="px-3 py-2"><FichasBadge fichas={fichas}/></td>
                      {isApontados ? (
                        <>
                          <td className="px-3 py-2 text-right font-mono"
                            style={{ color: SEVERITY_COLORS[r.peso_alerta_max ?? 1] ?? '#94a3b8' }}>
                            {r.desvio_pct_max != null ? fmtPct(r.desvio_pct_max) : '—'}
                          </td>
                          <td className="px-3 py-2 text-center">
                            {d?.decisao_final
                              ? <StatusBadge status={d.decisao_final}/>
                              : <span className="text-[10px] opacity-50 italic">aguardando</span>
                            }
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-3 py-2 text-center"><StatusBadge status={d?.decisao_final}/></td>
                          <td className="px-3 py-2 text-right font-mono">{d?.confianca_final ?? 0}%</td>
                          <td className="px-3 py-2 text-right text-green-400">{fmtCurrency(ress)}</td>
                        </>
                      )}
                      <td className="px-3 py-2 text-center">
                        <button onClick={(e) => handleClickRow(r, e)}
                          className="px-2 py-1 text-xs rounded bg-blue-600 hover:bg-blue-700 text-white">
                          Ações ▾
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Menu de ações */}
      {menuRow && (
        <AcoesMenu row={menuRow} anchor={menuAnchor} onClose={() => setMenuRow(null)} onAction={handleAction}/>
      )}

      {/* Modais */}
      {modalIA && (
        <AnaliseIAModal row={modalIA} onClose={() => setModalIA(null)} onReprocessed={() => reload()}/>
      )}
      {modalReq && (
        <CriarRequisicaoModal row={modalReq} onClose={() => setModalReq(null)} onCreated={() => reload()}/>
      )}
      {drawerHist && (
        <HistoricoDrawer uc={drawerHist} onClose={() => setDrawerHist(null)}/>
      )}
    </div>
  );
}

function SortTh({ col, align = 'left', sort, onClick, children }) {
  const ativo = sort?.col === col;
  const seta  = ativo ? (sort.dir === 'asc' ? '▲' : '▼') : '↕';
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  return (
    <th
      onClick={() => onClick?.(col)}
      className={`px-3 py-2 ${alignCls} cursor-pointer select-none hover:bg-[var(--bg-secondary)] transition`}
      title={`Ordenar por ${typeof children === 'string' ? children : col}`}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        <span className={`text-[10px] ${ativo ? 'opacity-100 text-blue-400' : 'opacity-30'}`}>{seta}</span>
      </span>
    </th>
  );
}

function Card({ label, value, cor }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
      <div className="text-[10px] opacity-60 uppercase tracking-wider mb-1">{label}</div>
      <div className="text-xl font-bold" style={{ color: cor || 'inherit' }}>{value}</div>
    </div>
  );
}
