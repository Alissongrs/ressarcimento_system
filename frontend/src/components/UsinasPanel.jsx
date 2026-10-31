import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell, ReferenceLine } from 'recharts';
import apiClient from '../services/apiClient';

// ⚡ Auditoria das faturas das USINAS (Thopen) — aba dentro de /analise-desvio.
// Somente leitura: o backend roda o mesmo motor F01–F05 da Auditoria sobre FATURA_USINA* (ao vivo, cache 10 min).
// Estimativa do F02 = excesso de kWh × preço do kWh com tributos (itens de energia da própria fatura);
// "não compensado" = parte que a compensação de GD da fatura não abateu (o que de fato pesou no pagamento).
// Botão "Regras": escolhe quais regras do catálogo (página Regras) valem para as faturas das usinas — salva no
// servidor (DM_REGRAS_CONJUNTO, conjunto "usinas"); regras que dependem de parâmetro externo aparecem bloqueadas.

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = (v, d = 0) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: d });
const mesBR = (m) => (m && m.length >= 7 ? `${m.slice(5, 7)}/${m.slice(0, 4)}` : m || '—');

const CLASSIF = {
  ELEVADO_REAL: { rot: 'acima do histórico', cor: '#dc2626' },
  CRESCENTE: { rot: 'consumo crescente', cor: '#d97706' },
  SAZONAL: { rot: 'sazonal', cor: '#6b7280' },
  DENTRO_DO_HISTORICO: { rot: 'dentro do histórico', cor: '#6b7280' },
};
const VALID = {
  CONFIRMADO: 'confirmado pelas 3 próximas',
  SEM_3_PROXIMAS: 'aguardando 3 próximas',
  ATIVACAO: 'novo patamar (ativação)',
};
const FICHA_ROT = {
  F01: 'leitura × constante ≠ consumo',
  F02: 'consumo acima da média',
  F03: 'faturamento pela média',
  F04: 'consumo zerado/estimado',
  F05: 'quebra de leitura',
};
const SEM_DADOS = [];

// link_drive das usinas é caminho do rclone ("gdrive:Faturas Usinas Thopen/...") — só vira link se for URL
function LinkFatura({ link, rotulo }) {
  if (!link) return '—';
  if (/^https?:\/\//.test(link)) return <a href={link} target="_blank" rel="noreferrer" className="text-[var(--accent)]">{rotulo}</a>;
  const caminho = link.replace(/^gdrive:/, '');
  return (
    <button type="button" title={`Google Drive: ${caminho} (clique para copiar o caminho)`} className="text-[var(--accent)]"
      onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(caminho); }}>📋 caminho</button>
  );
}

const SITUACAO = {
  motor: { rot: 'pronta (motor da Auditoria)', cor: '#1f9d6b', ok: true },
  fatura: { rot: 'pronta — só com a fatura', cor: '#1f9d6b', ok: true },
  historico: { rot: 'pronta — com o histórico da UC', cor: '#1f9d6b', ok: true },
  aneel: { rot: 'pronta — tarifa/bandeira homologada da ANEEL', cor: '#1f9d6b', ok: true },
  parametro: { rot: 'precisa de parâmetro (etapa 2)', cor: '#d97706', ok: false },
  pendente: { rot: 'ainda não implementada', cor: '#6b7280', ok: false },
};
const valorOutras = (a) => (a.achados || []).reduce((s, x) => s + (x.nivel === 'ERRO' ? x.valor || 0 : 0), 0);

function RegrasModal({ onClose, onSalvo }) {
  const [regras, setRegras] = useState(null);
  const [marcadas, setMarcadas] = useState({});
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [aneel, setAneel] = useState(null);
  const [importando, setImportando] = useState(false);
  const lerAneel = useCallback(() => {
    apiClient.get('/api/v1/parametros/aneel/status').then(({ data }) => setAneel(data)).catch(() => setAneel(null));
  }, []);
  useEffect(() => { lerAneel(); }, [lerAneel]);
  const importarAneel = async () => {
    setImportando(true);
    setErro('');
    try {
      await apiClient.post('/api/v1/parametros/aneel/importar', {}, { timeout: 600000 });
      lerAneel();
    } catch (e) {
      setErro(e?.response?.data?.error || e.message);
    } finally {
      setImportando(false);
    }
  };
  useEffect(() => {
    apiClient.get('/api/v1/regras-conjunto/usinas')
      .then(({ data }) => {
        setRegras(data.regras || SEM_DADOS);
        setMarcadas(Object.fromEntries((data.regras || SEM_DADOS).filter((r) => r.selecionada).map((r) => [r.codigo, true])));
      })
      .catch((e) => setErro(e?.response?.data?.error || e.message));
  }, []);
  const salvar = async () => {
    setSalvando(true);
    setErro('');
    try {
      await apiClient.put('/api/v1/regras-conjunto/usinas', { codigos: Object.keys(marcadas).filter((c) => marcadas[c]) });
      onSalvo();
    } catch (e) {
      setErro(e?.response?.data?.error || e.message);
    } finally {
      setSalvando(false);
    }
  };
  const grupos = useMemo(() => {
    const g = {};
    (regras || SEM_DADOS).forEach((r) => { (g[r.grupo || 'Outras'] = g[r.grupo || 'Outras'] || []).push(r); });
    return Object.entries(g);
  }, [regras]);
  const n = Object.values(marcadas).filter(Boolean).length;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-[min(900px,95vw)] max-h-[90vh] flex flex-col rounded-xl bg-[var(--cpv2-surface)] border border-[var(--cpv2-border)]"
        onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-[var(--cpv2-border)] flex items-start justify-between gap-4">
          <div>
            <div className="text-lg font-bold">Regras aplicadas às faturas das usinas</div>
            <div className="text-xs opacity-70">Marque as regras do catálogo que devem rodar nesta aba. As que precisam de parâmetro
              (tarifa, alíquota, CIP do município) ficam bloqueadas até a etapa 2.</div>
          </div>
          <button onClick={onClose} className="text-sm opacity-70 hover:opacity-100">✕</button>
        </div>
        <div className="px-4 py-2 border-b border-[var(--cpv2-border)] flex flex-wrap items-center gap-3 text-xs">
          <span className="font-semibold">Parâmetros da ANEEL</span>
          {aneel?.importado ? (
            <span className="opacity-80">{Number(aneel.tarifas).toLocaleString('pt-BR')} tarifas homologadas · bandeiras até {aneel.bandeira_ate}
              {aneel.ultima ? ` · última atualização ${aneel.ultima.em} (${aneel.ultima.status})` : ''}</span>
          ) : <span style={{ color: '#d97706' }}>ainda não importados — as regras F28, F41, F42 e F58 só rodam depois da 1ª importação</span>}
          <span className="opacity-60">atualiza sozinho todo dia (dados abertos da ANEEL)</span>
          <button onClick={importarAneel} disabled={importando} className="ml-auto px-2 py-1 rounded-md border border-[var(--cpv2-border)]"
            title="Buscar agora as tarifas e bandeiras na ANEEL (só gestor)">{importando ? 'importando… (até 1 min)' : '↻ Atualizar agora'}</button>
        </div>
        <div className="p-4 overflow-auto flex-1 text-sm">
          {erro && <div className="mb-2 text-[var(--danger)]">{erro}</div>}
          {!regras ? <div className="opacity-60">carregando…</div> : grupos.map(([g, lst]) => (
            <div key={g} className="mb-3">
              <div className="text-xs font-semibold opacity-70 mb-1">{g}</div>
              {lst.map((r) => {
                const st = SITUACAO[r.situacao] || SITUACAO.pendente;
                return (
                  <label key={r.codigo} className={`flex items-start gap-2 py-1 ${st.ok ? 'cursor-pointer' : 'opacity-60'}`}
                    title={r.precisa ? `precisa: ${r.precisa}` : st.rot}>
                    <input type="checkbox" className="mt-1" disabled={!st.ok} checked={!!marcadas[r.codigo]}
                      onChange={(e) => setMarcadas((m) => ({ ...m, [r.codigo]: e.target.checked }))} />
                    <span className="flex-1"><b>{r.codigo}</b> {r.nome}
                      <span className="ml-2 text-[11px]" style={{ color: st.cor }}>· {st.rot}{r.precisa ? ` — ${r.precisa}` : ''}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          ))}
        </div>
        <div className="p-4 border-t border-[var(--cpv2-border)] flex items-center gap-3 text-sm">
          <span className="opacity-70">{n} regra(s) marcada(s)</span>
          <button onClick={onClose} className="ml-auto px-3 py-1 rounded-md border border-[var(--cpv2-border)]">Cancelar</button>
          <button onClick={salvar} disabled={salvando || !regras}
            className="px-3 py-1 rounded-md font-semibold text-white" style={{ background: '#d97706' }}>
            {salvando ? 'salvando…' : 'Salvar e aplicar'}</button>
        </div>
      </div>
    </div>
  );
}

function Card({ titulo, valor, sub, cor }) {
  return (
    <div className="rounded-lg p-3 border border-[var(--cpv2-border)] bg-[var(--cpv2-surface)] min-w-[170px]">
      <div className="text-[11px] opacity-60">{titulo}</div>
      <div className="text-lg font-bold" style={{ color: cor || 'var(--cpv2-text)' }}>{valor}</div>
      {sub && <div className="text-[11px] opacity-60">{sub}</div>}
    </div>
  );
}

function DetalheUC({ ap, onClose }) {
  const [hist, setHist] = useState(null);
  const [erro, setErro] = useState('');
  useEffect(() => {
    let vivo = true;
    apiClient.get('/api/v1/usinas/uc-historico', { params: { uc: ap.uc_chave } })
      .then(({ data }) => { if (vivo) setHist(data.meses || SEM_DADOS); })
      .catch((e) => { if (vivo) setErro(e?.response?.data?.error || e.message); });
    return () => { vivo = false; };
  }, [ap.uc_chave]);
  const serie = useMemo(() => (hist || SEM_DADOS).map((m) => ({
    mes: mesBR(m.mes_referencia),
    kwh: Math.round((m.ponta_kwh || 0) + (m.fora_ponta_kwh || 0)),
    apontado: m.id_fatura === ap.id_fatura,
  })), [hist, ap.id_fatura]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-[min(1100px,95vw)] max-h-[90vh] overflow-auto rounded-xl p-5 bg-[var(--cpv2-surface)] border border-[var(--cpv2-border)]"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-lg font-bold">{ap.usina || ap.titular}</div>
            <div className="text-xs opacity-70">{ap.distribuidora} · UC {ap.uc} · {ap.titular}</div>
          </div>
          <button onClick={onClose} className="text-sm opacity-70 hover:opacity-100">✕ fechar</button>
        </div>
        <div className="mt-3 text-sm">
          <b>{ap.fichas.join(', ')}</b> em {mesBR(ap.mes_referencia)} — {(ap.detalhamento || []).join(' · ')}
        </div>
        {ap.fichas.includes('F02') && (
          <div className="mt-2 text-xs opacity-80">
            Consumo {num(ap.consumo_kwh)} kWh × média {num(ap.media_kwh)} kWh → excesso {num(ap.excesso_kwh)} kWh
            × {brl(ap.preco_kwh)}/kWh = <b>{brl(ap.estimativa_bruta)}</b> bruto ·
            <b> {brl(ap.estimativa_nao_compensada)}</b> não compensado pela GD
          </div>
        )}
        {(ap.achados || []).length > 0 && (
          <div className="mt-3 text-xs space-y-1">
            {ap.achados.map((x, i) => (
              <div key={i}>
                <b style={{ color: x.nivel === 'ERRO' ? '#dc2626' : '#d97706' }}>{x.codigo} {x.nivel === 'ERRO' ? 'erro' : 'alerta'}</b>
                {' — '}{x.detalhe}{x.valor ? ` · ${brl(x.valor)}` : ''}{x.kwh ? ` · ${num(x.kwh)} kWh` : ''}
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 h-[260px]">
          {erro ? <div className="text-sm text-[var(--danger)]">{erro}</div> : !hist ? <div className="text-sm opacity-60">carregando…</div> : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={serie}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="mes" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip formatter={(v) => `${num(v)} kWh`} />
                {ap.media_kwh > 0 && <ReferenceLine y={ap.media_kwh} stroke="#d97706" strokeDasharray="4 4" />}
                <Bar dataKey="kwh">
                  {serie.map((s) => <Cell key={s.mes} fill={s.apontado ? '#dc2626' : '#7c6f9c'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
        {hist && (
          <table className="mt-4 w-full text-xs">
            <thead><tr className="text-left opacity-60"><th>Mês</th><th className="text-right">Ponta kWh</th><th className="text-right">Fora ponta kWh</th><th className="text-right">Total a pagar</th><th>Leitura</th><th>Fatura</th></tr></thead>
            <tbody>
              {hist.map((m) => (
                <tr key={m.id_fatura} className={m.id_fatura === ap.id_fatura ? 'font-bold' : ''}>
                  <td>{mesBR(m.mes_referencia)}</td>
                  <td className="text-right">{num(m.ponta_kwh)}</td>
                  <td className="text-right">{num(m.fora_ponta_kwh)}</td>
                  <td className="text-right">{brl(m.total_a_pagar)}</td>
                  <td>{m.metodo}</td>
                  <td><LinkFatura link={m.link_drive} rotulo="abrir PDF" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function UsinasPanel() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [loading, setLoading] = useState(true);
  const [ficha, setFicha] = useState('todas');
  const [dist, setDist] = useState('todas');
  const [soFortes, setSoFortes] = useState(false);
  const [busca, setBusca] = useState('');
  const [detalhe, setDetalhe] = useState(null);
  const [regrasAberto, setRegrasAberto] = useState(false);
  const [alertas, setAlertas] = useState(false);

  const carregar = useCallback(async (refresh) => {
    setLoading(true);
    setErro('');
    try {
      const { data } = await apiClient.get('/api/v1/usinas/apontamentos', { params: refresh ? { refresh: 1 } : {} });
      setDados(data);
    } catch (e) {
      setErro(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { carregar(false); }, [carregar]);

  const aps = dados?.apontamentos || SEM_DADOS;
  const dists = useMemo(() => [...new Set(aps.map((a) => a.distribuidora))].sort(), [aps]);
  const linhas = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return aps.filter((a) => (ficha === 'todas' || a.fichas.includes(ficha) || (alertas && (a.alertas || []).includes(ficha)))
      && (alertas || a.fichas.length > 0)
      && (dist === 'todas' || a.distribuidora === dist)
      && (!soFortes || a.forte)
      && (!q || `${a.usina} ${a.titular} ${a.uc}`.toLowerCase().includes(q)));
  }, [aps, ficha, dist, soFortes, busca, alertas]);
  const somaLiq = useMemo(() => linhas.reduce((s, a) => s + (a.estimativa_nao_compensada || 0) + valorOutras(a), 0), [linhas]);

  const exportar = () => {
    const ws = XLSX.utils.json_to_sheet(linhas.map((a) => ({
      Fichas: a.fichas.join(','), Distribuidora: a.distribuidora, Usina: a.usina, Titular: a.titular, UC: a.uc,
      'Mês ref.': mesBR(a.mes_referencia), 'Consumo kWh': a.consumo_kwh, 'Média kWh': a.media_kwh || null,
      'Excesso kWh': a.excesso_kwh || null, 'Desvio %': a.fichas.includes('F02') ? a.desvio_pct : null,
      Classificação: CLASSIF[a.classificacao_historico]?.rot || a.classificacao_historico || '',
      Validação: VALID[a.f02_validacao] || a.f02_validacao || '', Forte: a.forte ? 'sim' : '',
      'Preço kWh': a.preco_kwh || null, 'Estimativa bruta': a.estimativa_bruta || null,
      'Não compensado': a.estimativa_nao_compensada || null, 'Outras regras R$': valorOutras(a) || null,
      Alertas: (a.alertas || []).join(','), Detalhe: (a.detalhamento || []).join('; '),
      'Achados': (a.achados || []).map((x) => `${x.codigo} ${x.nivel}: ${x.detalhe}`).join(' | '),
      Leitura: a.metodo, Fatura: a.link_drive, id_fatura: a.id_fatura,
    })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Usinas - regras');
    XLSX.writeFile(wb, `auditoria_usinas_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  if (loading && !dados) return <div className="p-6 text-sm opacity-70">Aplicando as regras nas faturas das usinas…</div>;
  if (erro && !dados) return <div className="p-6 text-sm text-[var(--danger)]">Erro: {erro}</div>;
  const pf = dados?.por_ficha || {};
  const pa = dados?.por_alerta || {};
  const sel = dados?.regras_selecionadas || SEM_DADOS;
  const nAlertas = Object.values(pa).reduce((s, v) => s + v, 0);

  return (
    <div className="w-full space-y-4">
      <div className="flex flex-wrap gap-3">
        <Card titulo="Faturas analisadas" valor={num(dados.faturas_analisadas)} sub={`${num(dados.ucs_analisadas)} UCs de usinas`} />
        <Card titulo="Apontamentos (erro)" valor={num(aps.filter((a) => a.fichas.length).length)}
          sub={sel.filter((f) => pf[f]).map((f) => `${f} ${pf[f]}`).join(' · ') || 'nenhum'} />
        <Card titulo="Alertas" valor={num(nAlertas)} sub={sel.filter((f) => pa[f]).map((f) => `${f} ${pa[f]}`).join(' · ') || 'nenhum'}
          cor="#d97706" />
        <Card titulo="F02 fortes" valor={num(dados.f02_fortes)} sub="acima do histórico + confirmado" cor="#dc2626" />
        <Card titulo="Estimativa F02 (não compensado)" valor={brl(dados.estimativa_nao_compensada)}
          sub={`bruto ${brl(dados.estimativa_bruta)}`} />
        <Card titulo="Só os fortes (não compensado)" valor={brl(dados.estimativa_fortes_nao_compensada)}
          sub={`bruto ${brl(dados.estimativa_fortes_bruta)}`} cor="#dc2626" />
        <Card titulo="Outras regras (erro)" valor={brl(dados.estimativa_outras_regras)} sub="F13, F35, F36, F55… valor envolvido" />
      </div>

      <div className="text-[11px] opacity-60">
        Usinas: o consumo é quase todo abatido pelos créditos da própria geração — "não compensado" é o que pesou na conta;
        "bruto" é o excesso a tarifa cheia (crédito que deixou de sobrar). Estimativa pelo excesso de kWh × tarifa da fatura,
        não pelo total a pagar.
      </div>

      <div className="flex flex-wrap gap-3 items-center text-xs">
        <label className="inline-flex items-center gap-1.5"><span className="opacity-70">Regra:</span>
          <select value={ficha} onChange={(e) => setFicha(e.target.value)} className="px-2 py-1 rounded border border-[var(--cpv2-border)] bg-transparent">
            <option value="todas">todas</option>
            {sel.map((f) => <option key={f} value={f}>{f}{FICHA_ROT[f] ? ` — ${FICHA_ROT[f]}` : ''} ({pf[f] || 0}{pa[f] ? ` + ${pa[f]} alertas` : ''})</option>)}
          </select></label>
        <label className="inline-flex items-center gap-1.5"><span className="opacity-70">Distribuidora:</span>
          <select value={dist} onChange={(e) => setDist(e.target.value)} className="px-2 py-1 rounded border border-[var(--cpv2-border)] bg-transparent">
            <option value="todas">todas</option>
            {dists.map((d) => <option key={d} value={d}>{d}</option>)}
          </select></label>
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={soFortes} onChange={(e) => setSoFortes(e.target.checked)} /> só F02 fortes</label>
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={alertas} onChange={(e) => setAlertas(e.target.checked)} /> mostrar alertas</label>
        <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="buscar usina, titular ou UC"
          className="px-2 py-1 rounded border border-[var(--cpv2-border)] bg-transparent min-w-[220px]" />
        <span className="opacity-70">{linhas.length} linhas · {brl(somaLiq)}</span>
        <button onClick={() => setRegrasAberto(true)} className="ml-auto px-3 py-1 rounded-md font-semibold text-white"
          style={{ background: '#d97706' }} title="Escolher as regras do catálogo aplicadas às faturas das usinas">
          ⚙ Regras ({sel.length})</button>
        <button onClick={exportar} className=" px-3 py-1 rounded-md font-semibold border border-[var(--cpv2-border)]">⬇ Excel</button>
        <button onClick={() => carregar(true)} disabled={loading} className="px-3 py-1 rounded-md font-semibold border border-[var(--cpv2-border)]">
          {loading ? 'rodando…' : '↻ Rodar de novo'}</button>
      </div>

      <div className="overflow-auto border border-[var(--cpv2-border)] rounded-lg">
        <table className="w-full text-xs">
          <thead className="bg-[var(--cpv2-surface)]">
            <tr className="text-left">
              <th className="p-2">Regra</th><th className="p-2">Distribuidora</th><th className="p-2">Usina</th><th className="p-2">UC</th>
              <th className="p-2">Mês</th><th className="p-2 text-right">Consumo kWh</th><th className="p-2 text-right">Média kWh</th>
              <th className="p-2 text-right">Desvio</th><th className="p-2">Classificação</th><th className="p-2">Validação</th>
              <th className="p-2 text-right">Bruto</th><th className="p-2 text-right">Não compensado</th>
              <th className="p-2 text-right">Outras regras</th><th className="p-2">Fatura</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((a) => {
              const cl = CLASSIF[a.classificacao_historico];
              return (
                <tr key={a.id_fatura} onClick={() => setDetalhe(a)}
                  className="border-t border-[var(--cpv2-border)] cursor-pointer hover:bg-[var(--cpv2-surface)]">
                  <td className="p-2 font-semibold" title={(a.detalhamento || []).join('\n')}>
                    {a.fichas.join(', ')}{a.forte && <span className="ml-1" title="acima do histórico e confirmado pelas 3 próximas">🔴</span>}
                    {(a.alertas || []).length > 0 && <span className="ml-1 text-[10px] font-normal" style={{ color: '#d97706' }}>⚠ {a.alertas.join(', ')}</span>}</td>
                  <td className="p-2">{a.distribuidora}</td>
                  <td className="p-2">{a.usina || a.titular}</td>
                  <td className="p-2">{a.uc}</td>
                  <td className="p-2">{mesBR(a.mes_referencia)}</td>
                  <td className="p-2 text-right">{num(a.consumo_kwh)}</td>
                  <td className="p-2 text-right">{a.media_kwh ? num(a.media_kwh) : '—'}</td>
                  <td className="p-2 text-right">{a.fichas.includes('F02') ? `+${num(a.desvio_pct)}%` : '—'}</td>
                  <td className="p-2" style={{ color: cl?.cor }}>{cl?.rot || a.classificacao_historico || '—'}</td>
                  <td className="p-2">{VALID[a.f02_validacao] || a.f02_validacao || '—'}</td>
                  <td className="p-2 text-right">{a.estimativa_bruta ? brl(a.estimativa_bruta) : '—'}</td>
                  <td className="p-2 text-right font-semibold">{a.estimativa_nao_compensada ? brl(a.estimativa_nao_compensada) : '—'}</td>
                  <td className="p-2 text-right">{valorOutras(a) ? brl(valorOutras(a)) : '—'}</td>
                  <td className="p-2" onClick={(e) => e.stopPropagation()}>
                    <LinkFatura link={a.link_drive} rotulo="PDF" /></td>
                </tr>
              );
            })}
            {!linhas.length && <tr><td colSpan={14} className="p-4 text-center opacity-60">nenhum apontamento com esses filtros</td></tr>}
          </tbody>
        </table>
      </div>
      {detalhe && <DetalheUC ap={detalhe} onClose={() => setDetalhe(null)} />}
      {regrasAberto && <RegrasModal onClose={() => setRegrasAberto(false)}
        onSalvo={() => { setRegrasAberto(false); carregar(true); }} />}
    </div>
  );
}
