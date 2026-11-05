import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell, ReferenceLine } from 'recharts';
import apiClient from '../services/apiClient';
import { abrirDossie } from './dossieApontamento';

// ⚡ Auditoria das faturas das USINAS (Thopen) — aba dentro de /analise-desvio.
// Somente leitura: o backend aplica SÓ as regras marcadas no botão Regras (o motor F01–F05 só se marcado)
// sobre FATURA_USINA* (ao vivo, cache 10 min). Uma linha por fatura: regras com erro, com alerta, o resumo do que
// foi encontrado e o valor envolvido (achados com erro + a parte não compensada do F02, quando ele aponta).
// Botão "Regras": escolhe quais regras do catálogo (página Regras) valem para as faturas das usinas — salva no
// servidor (DM_REGRAS_CONJUNTO, conjunto "usinas"); regras que dependem de parâmetro externo aparecem bloqueadas.

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = (v, d = 0) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: d });
const mesBR = (m) => (m && m.length >= 7 ? `${m.slice(5, 7)}/${m.slice(0, 4)}` : m || '—');

const FICHA_ROT = {
  F01: 'leitura × constante ≠ consumo',
  F02: 'consumo acima da média',
  F03: 'faturamento pela média',
  F04: 'consumo zerado/estimado',
  F05: 'quebra de leitura',
  F06: 'fatura sem leitura do medidor',
  F07: 'virada do medidor',
  F08: 'troca de medidor',
  F33: 'ciclo abaixo de 15 dias',
  F34: 'ciclo acima do máximo',
  F57: 'disponibilidade + Fio B',
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
  pares: { rot: 'pronta — comparada com as outras UCs do município', cor: '#1f9d6b', ok: true },
  nao_ligada: { rot: 'ainda não ligada a esta base', cor: '#6b7280', ok: false },
  parametro: { rot: 'precisa de parâmetro (etapa 2)', cor: '#d97706', ok: false },
  pendente: { rot: 'ainda não implementada', cor: '#6b7280', ok: false },
};
const valorOutras = (a) => (a.achados || []).reduce((s, x) => s + (x.nivel === 'ERRO' ? x.valor || 0 : 0), 0);

// conjunto: 'usinas' | 'acer' — a seleção de cada aba fica separada (DM_REGRAS_CONJUNTO)
export function RegrasModal({ onClose, onSalvo, conjunto = 'usinas', titulo = 'Regras aplicadas às faturas das usinas' }) {
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
    apiClient.get(`/api/v1/regras-conjunto/${conjunto}`)
      .then(({ data }) => {
        setRegras(data.regras || SEM_DADOS);
        setMarcadas(Object.fromEntries((data.regras || SEM_DADOS).filter((r) => r.selecionada).map((r) => [r.codigo, true])));
      })
      .catch((e) => setErro(e?.response?.data?.error || e.message));
  }, [conjunto]);
  const salvar = async () => {
    setSalvando(true);
    setErro('');
    try {
      await apiClient.put(`/api/v1/regras-conjunto/${conjunto}`, { codigos: Object.keys(marcadas).filter((c) => marcadas[c]) });
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
            <div className="text-lg font-bold">{titulo}</div>
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
          <b>{[...(ap.fichas || []), ...(ap.alertas || [])].join(', ')}</b> em {mesBR(ap.mes_referencia)}{(ap.detalhamento || []).length ? ` — ${ap.detalhamento.join(' · ')}` : ''}
        </div>
        {(ap.fichas || []).includes('F02') && (
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

// valor do apontamento: soma dos achados com ERRO + a estimativa do F02 (parte não compensada), quando o F02 apontou
const valorAp = (a) => valorOutras(a) + ((a.fichas || []).includes('F02') ? a.estimativa_nao_compensada || 0 : 0);
// resumo legível: o primeiro achado (erro antes de alerta) ou o detalhamento do motor
const resumoAp = (a) => {
  const ach = [...(a.achados || [])].sort((x, y) => (x.nivel === 'ERRO' ? 0 : 1) - (y.nivel === 'ERRO' ? 0 : 1));
  if (ach.length) return `${ach[0].codigo}: ${ach[0].detalhe}`;
  return (a.detalhamento || [])[0] || '';
};

export default function UsinasPanel() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [loading, setLoading] = useState(true);
  const [ficha, setFicha] = useState('todas');
  const [dist, setDist] = useState('todas');
  const [nivel, setNivel] = useState('todos'); // todos | erro | alerta
  const [busca, setBusca] = useState('');
  const [detalhe, setDetalhe] = useState(null);
  const [regrasAberto, setRegrasAberto] = useState(false);

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
    return aps.filter((a) => {
      const er = a.fichas || SEM_DADOS;
      const al = a.alertas || SEM_DADOS;
      if (nivel === 'erro' && !er.length) return false;
      if (nivel === 'alerta' && !al.length) return false;
      if (ficha !== 'todas' && !er.includes(ficha) && !al.includes(ficha)) return false;
      if (dist !== 'todas' && a.distribuidora !== dist) return false;
      return !q || `${a.usina} ${a.titular} ${a.uc}`.toLowerCase().includes(q);
    }).sort((x, y) => valorAp(y) - valorAp(x) || ((y.fichas || []).length - (x.fichas || []).length));
  }, [aps, ficha, dist, nivel, busca]);
  const soma = useMemo(() => linhas.reduce((s, a) => s + valorAp(a), 0), [linhas]);

  const exportar = () => {
    const ws = XLSX.utils.json_to_sheet(linhas.map((a) => ({
      'Regras (erro)': (a.fichas || []).join(','), 'Regras (alerta)': (a.alertas || []).join(','),
      Distribuidora: a.distribuidora, Usina: a.usina, Titular: a.titular, UC: a.uc, 'Mês ref.': mesBR(a.mes_referencia),
      'Valor envolvido (erros)': valorAp(a) || null, 'Total a pagar': a.total_a_pagar || null,
      'O que foi encontrado': [...(a.achados || []).map((x) => `${x.codigo} ${x.nivel}: ${x.detalhe}`), ...(a.detalhamento || [])].join(' | '),
      Fatura: a.link_drive, id_fatura: a.id_fatura,
    })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Usinas - regras');
    XLSX.writeFile(wb, `auditoria_usinas_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  if (loading && !dados) return <div className="p-6 text-sm opacity-70">Aplicando as regras selecionadas nas faturas das usinas…</div>;
  if (erro && !dados) return <div className="p-6 text-sm text-[var(--danger)]">Erro: {erro}</div>;
  const pf = dados?.por_ficha || {};
  const pa = dados?.por_alerta || {};
  const sel = dados?.regras_selecionadas || SEM_DADOS;
  const comAlgo = sel.filter((f) => pf[f] || pa[f]);
  const nErro = aps.filter((a) => (a.fichas || []).length).length;
  const nAlerta = aps.filter((a) => !(a.fichas || []).length && (a.alertas || []).length).length;
  const totalErros = aps.reduce((s, a) => s + valorAp(a), 0);

  return (
    <div className="w-full space-y-4">
      <div className="flex flex-wrap gap-3">
        <Card titulo="Faturas analisadas" valor={num(dados.faturas_analisadas)} sub={`${num(dados.ucs_analisadas)} UCs de usinas`} />
        <Card titulo="Regras aplicadas" valor={num(sel.length)} sub="as marcadas no botão Regras" />
        <Card titulo="Faturas com erro" valor={num(nErro)} sub="a regra se confirmou com os números da fatura" cor="#dc2626" />
        <Card titulo="Faturas só com alerta" valor={num(nAlerta)} sub="indício — conferir na fatura" cor="#d97706" />
        <Card titulo="Valor envolvido (erros)" valor={brl(totalErros)} sub="soma do que as regras com erro calcularam" />
      </div>

      {erro && <div className="text-xs text-[var(--danger)]">Erro ao recalcular: {erro}</div>}

      <div className="flex flex-wrap gap-2 text-[11px]">
        {comAlgo.length === 0 && <span className="opacity-60">Nenhuma das regras selecionadas apontou nada.</span>}
        {comAlgo.map((f) => (
          <button key={f} type="button" onClick={() => setFicha(ficha === f ? 'todas' : f)}
            className={`px-2 py-0.5 rounded-full border ${ficha === f ? 'border-[var(--accent)] font-semibold' : 'border-[var(--cpv2-border)]'}`}>
            {f}{FICHA_ROT[f] ? ` · ${FICHA_ROT[f]}` : ''}
            {pf[f] ? <span style={{ color: '#dc2626' }}> · {pf[f]} erro</span> : null}
            {pa[f] ? <span style={{ color: '#d97706' }}> · {pa[f]} alerta</span> : null}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 items-center text-xs">
        <label className="inline-flex items-center gap-1.5"><span className="opacity-70">Regra:</span>
          <select value={ficha} onChange={(e) => setFicha(e.target.value)} className="px-2 py-1 rounded border border-[var(--cpv2-border)] bg-transparent">
            <option value="todas">todas</option>
            {sel.map((f) => <option key={f} value={f}>{f}{FICHA_ROT[f] ? ` — ${FICHA_ROT[f]}` : ''} ({pf[f] || 0} erro{pa[f] ? ` + ${pa[f]} alerta` : ''})</option>)}
          </select></label>
        <label className="inline-flex items-center gap-1.5"><span className="opacity-70">Nível:</span>
          <select value={nivel} onChange={(e) => setNivel(e.target.value)} className="px-2 py-1 rounded border border-[var(--cpv2-border)] bg-transparent">
            <option value="todos">erro e alerta</option>
            <option value="erro">só erro</option>
            <option value="alerta">só alerta</option>
          </select></label>
        <label className="inline-flex items-center gap-1.5"><span className="opacity-70">Distribuidora:</span>
          <select value={dist} onChange={(e) => setDist(e.target.value)} className="px-2 py-1 rounded border border-[var(--cpv2-border)] bg-transparent">
            <option value="todas">todas</option>
            {dists.map((d) => <option key={d} value={d}>{d}</option>)}
          </select></label>
        <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="buscar usina, titular ou UC"
          className="px-2 py-1 rounded border border-[var(--cpv2-border)] bg-transparent min-w-[220px]" />
        <span className="opacity-70">{linhas.length} faturas · {brl(soma)}</span>
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
              <th className="p-2">Erro</th><th className="p-2">Alerta</th><th className="p-2">Distribuidora</th><th className="p-2">Usina</th>
              <th className="p-2">UC</th><th className="p-2">Mês</th><th className="p-2">O que foi encontrado</th>
              <th className="p-2 text-right">Valor envolvido</th><th className="p-2">Fatura</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((a) => {
              const v = valorAp(a);
              return (
                <tr key={a.id_fatura} onClick={() => setDetalhe(a)}
                  className="border-t border-[var(--cpv2-border)] cursor-pointer hover:bg-[var(--cpv2-surface)] align-top">
                  <td className="p-2 font-semibold" style={{ color: '#dc2626' }}>{(a.fichas || []).join(', ') || '—'}</td>
                  <td className="p-2" style={{ color: '#d97706' }}>{(a.alertas || []).join(', ') || '—'}</td>
                  <td className="p-2">{a.distribuidora}</td>
                  <td className="p-2">{a.usina || a.titular}</td>
                  <td className="p-2">{a.uc}</td>
                  <td className="p-2">{mesBR(a.mes_referencia)}</td>
                  <td className="p-2 max-w-[520px]" title={[...(a.achados || []).map((x) => `${x.codigo} (${x.nivel}): ${x.detalhe}`), ...(a.detalhamento || [])].join('\n')}>
                    <div className="line-clamp-2">{resumoAp(a)}</div></td>
                  <td className="p-2 text-right font-semibold">{v ? brl(v) : '—'}</td>
                  <td className="p-2 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    <LinkFatura link={a.link_drive} rotulo="PDF" />
                    <button type="button" className="ml-2 text-[var(--accent)]" title="Dossiê do apontamento (PDF): explica cada regra, a tese, como foi aplicada, a conta e a fatura com os valores marcados"
                      onClick={async () => { const m = await abrirDossie('usinas', a.id_fatura); if (m) setErro(m); }}>📑 Dossiê</button></td>
                </tr>
              );
            })}
            {!linhas.length && <tr><td colSpan={9} className="p-4 text-center opacity-60">nenhum apontamento com esses filtros</td></tr>}
          </tbody>
        </table>
      </div>
      {detalhe && <DetalheUC ap={detalhe} onClose={() => setDetalhe(null)} />}
      {regrasAberto && <RegrasModal onClose={() => setRegrasAberto(false)}
        onSalvo={() => { setRegrasAberto(false); carregar(true); }} />}
    </div>
  );
}
