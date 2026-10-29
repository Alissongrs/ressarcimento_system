import React, { useCallback, useEffect, useMemo, useState } from 'react';
import apiClient from '../services/apiClient';
import {
  ResponsiveContainer, ComposedChart, Bar, XAxis, YAxis, Tooltip, ReferenceLine, Cell, CartesianGrid,
} from 'recharts';

// 💧 Auditoria de Faturas de Água — aba dentro de /analise-desvio.
// Fase 1: leitura sobre FATURA_APONTAMENTOS_AGUA_AUDITADOS (motor: consumo >= 1,8x média histórica, 80% acima).
// Ressarcimento = excedente_m3 × RS_M3. Ações: gerar requisição, rejeitar, PDF, histórico.

const NOMES_EMPRESA = { 4: 'Empresa 4', 183: 'Empresa 183', 189: 'Empresa 189', 359: 'Empresa 359', 362: 'Empresa 362' };
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = (v) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
const nomeEmpresa = (cod) => NOMES_EMPRESA[cod] || `Empresa ${cod}`;
const fmtBR = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const parseBR = (s) => {
  if (typeof s === 'number') return s;
  const t = String(s ?? '').trim();
  if (!t) return 0;
  return t.includes(',') ? (Number(t.replace(/\./g, '').replace(',', '.')) || 0) : (Number(t) || 0);
};

// Conferência visual da fatura (PDF × banco): verde = pico confirmado, vermelho = falso positivo.
const CONF_COR = { VERDADEIRO: '#1f9d6b', FALSO: '#dc2626', INCONCLUSIVO: '#6b7280' };
// causa do pico nos verdadeiros (argumento da requisição)
const CAUSA_ROTULO = {
  ERRO_CONCESSIONARIA: 'erro da concessionária',
  VAZAMENTO: 'vazamento',
  TROCA_HIDROMETRO: 'troca de hidrômetro',
  CONSUMO_ALTO_MEDIDO: 'consumo alto medido',
  MINIMO_ECONOMIAS: 'mínimo por economias — verificar cadastro',
};
// o que a fatura diz sobre vazamento (só "constatado" prova vazamento)
const EVID_ROTULO = {
  ALERTA_DO_MES: 'concessionária alertou alta de consumo',
  AVISO_GENERICO: 'só dica geral de vazamento',
  SEM_AVISO: 'sem aviso na fatura',
};

const COLS = [
  { label: 'Cliente', key: 'cliente_nome', num: false },
  { label: 'UC', key: 'uc', num: false },
  { label: 'Concessionária', key: 'concessionaria', num: false },
  { label: 'Mês', key: 'mes_referencia', num: false },
  { label: 'Consumo m³', key: 'consumo_m3', num: true },
  { label: 'Média m³', key: 'mediana_m3', num: true },
  { label: 'Excedente m³', key: 'excedente', num: true },
  { label: 'Desvio', key: 'desvio_pct', num: true },
  { label: 'Ressarc. estimado', key: 'ressarcimento_estimado', num: true },
  { label: 'Conferência da fatura', key: 'conferencia', num: false },
  { label: 'Ações', key: null, num: false },
];

export default function AguaPanel() {
  const [resumo, setResumo] = useState(null);
  const [rows, setRows] = useState([]);
  const [empresa, setEmpresa] = useState('todos');
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');
  const [detalhe, setDetalhe] = useState(null); // UC em análise (modal com gráfico + todas as faturas)
  const [reqRow, setReqRow] = useState(null);   // linha criando requisição
  const [okMsg, setOkMsg] = useState('');
  const [sort, setSort] = useState({ key: 'mes_referencia', dir: 'desc' }); // padrão: mês mais recente no topo
  const [abertoConf, setAbertoConf] = useState(null); // id com a explicação da conferência aberta

  async function carregar() {
    setLoading(true); setErro('');
    try {
      const params = empresa !== 'todos' ? { empresa } : {};
      const [r1, r2] = await Promise.all([
        apiClient.get('/api/v1/faturas/agua-analise/resumo', { params }),
        apiClient.get('/api/v1/faturas/agua-analise', { params: { ...params, limit: 500 } }),
      ]);
      setResumo(r1.data);
      setRows(r2.data?.faturas || []);
    } catch (e) {
      setErro(e?.response?.data?.error || 'Falha ao carregar faturas de água.');
    } finally { setLoading(false); }
  }
  useEffect(() => { carregar();   }, [empresa]);

  async function rejeitar(id) {
    const motivo = window.prompt('Motivo da rejeição deste apontamento de água:');
    if (motivo == null) return;
    try {
      await apiClient.post(`/api/v1/faturas/agua/${id}/rejeitar`, { motivo });
      setRows((rs) => rs.filter((r) => r.id !== id));
    } catch (e) { alert(e?.response?.data?.error || 'Falha ao rejeitar.'); }
  }

  // Dossiê do apontamento (PDF: conta + gráfico + conferência + instruções) — só VERDADEIRO.
  // A aba abre antes do await para o navegador não bloquear o pop-up.
  async function abrirDossie(id) {
    const w = window.open('', '_blank');
    try {
      const { data } = await apiClient.get(`/api/v1/faturas/agua/${id}/dossie`, { responseType: 'blob' });
      const url = URL.createObjectURL(data);
      if (w) w.location.href = url; else window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      if (w) w.close();
      let msg = 'Falha ao gerar o dossiê.';
      try { msg = JSON.parse(await e?.response?.data?.text())?.error || msg; } catch { /* resposta não-JSON */ }
      setErro(msg);
    }
  }

  const empresasResumo = resumo?.por_empresa || [];

  const getVal = (r, key) => (key === 'excedente' ? Number(r.consumo_m3 || 0) - Number(r.mediana_m3 || 0) : r[key]);
  const sorted = useMemo(() => {
    const arr = [...rows];
    const { key, dir } = sort;
    if (!key) return arr;
    const isNum = COLS.find((c) => c.key === key)?.num;
    arr.sort((a, b) => {
      let va = getVal(a, key), vb = getVal(b, key);
      if (isNum) { va = Number(va) || 0; vb = Number(vb) || 0; return dir === 'asc' ? va - vb : vb - va; }
      va = String(va ?? ''); vb = String(vb ?? '');
      return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    });
    return arr;
  }, [rows, sort]);
  const toggleSort = (key) => { if (!key) return; setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })); };

  return (
    <div className="space-y-4">
      {okMsg && <div className="text-sm text-[var(--success)] font-semibold">{okMsg}</div>}
      <div className="flex gap-3 flex-wrap">
        <Kpi label="Apontamentos (água)" valor={num(resumo?.apontamentos)} cor="#2b8fd6" />
        <Kpi label="UCs" valor={num(resumo?.ucs)} cor="#2b8fd6" />
        <Kpi label="Ressarcimento estimado" valor={brl(resumo?.ressarcimento_estimado)} cor="#1f9d6b" />
      </div>

      <div className="flex gap-3 items-center text-xs flex-wrap">
        <label className="inline-flex items-center gap-1.5">
          <span className="opacity-70">Empresa:</span>
          <select className="cpv2-select" value={empresa} onChange={(e) => setEmpresa(e.target.value)}>
            <option value="todos">Todas ({num(resumo?.apontamentos)})</option>
            {empresasResumo.map((e) => (
              <option key={e.cod_empresa} value={String(e.cod_empresa)}>{e.nome || nomeEmpresa(e.cod_empresa)} ({e.n})</option>
            ))}
          </select>
        </label>
        <span className="opacity-50">Regras: pico — consumo por dia ≥ 1,8× o normal (80% acima) da UC (12 meses, mín. 4); cobrança sem medição — o mesmo m³ cobrado ≥ 3 meses seguidos, ≥ 1,5× o normal · ressarcimento = valor cobrado acima do normal.</span>
      </div>

      {erro && <div className="text-sm text-[var(--danger)]">{erro}</div>}
      {loading ? (
        <div className="text-sm opacity-60 py-8 text-center">Carregando faturas de água…</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--cpv2-border)]">
          <table className="w-full text-xs">
            <thead className="bg-[var(--cpv2-surface-2)]">
              <tr>
                {COLS.map((c) => (
                  <th key={c.label} onClick={() => toggleSort(c.key)}
                    className="px-3 py-2 text-center whitespace-nowrap select-none"
                    style={{ cursor: c.key ? 'pointer' : 'default' }}>
                    {c.label}{c.key ? (sort.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ' ⇅') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={COLS.length} className="px-3 py-8 text-center opacity-50">Nenhum apontamento de água.</td></tr>
              )}
              {sorted.map((r) => (
                <React.Fragment key={r.id}>
                  <tr className="border-t border-[var(--cpv2-border)] hover:bg-[var(--cpv2-surface-2)]">
                    <td className="px-3 py-2 text-center whitespace-nowrap">
                      <div className="font-medium">{r.cliente_nome || nomeEmpresa(r.cod_empresa)}</div>
                      {(r.cidade || r.uf) && <div className="text-[11px] opacity-60">{r.cidade}{r.uf ? `/${r.uf}` : ''}</div>}
                    </td>
                    <td className="px-3 py-2 text-center font-mono">{r.uc}</td>
                    <td className="px-3 py-2 text-center">{r.concessionaria}</td>
                    <td className="px-3 py-2 text-center whitespace-nowrap">{r.mes_referencia}</td>
                    <td className="px-3 py-2 text-center tabular-nums font-semibold">{num(r.consumo_m3)}</td>
                    <td className="px-3 py-2 text-center tabular-nums opacity-70">{num(r.mediana_m3)}</td>
                    <td className="px-3 py-2 text-center tabular-nums" style={{ color: '#2b8fd6' }}>{num(r.consumo_m3 - r.mediana_m3)}</td>
                    <td className="px-3 py-2 text-center tabular-nums font-semibold" style={{ color: r.desvio_pct >= 100 ? 'var(--danger)' : 'var(--warning)' }}>
                      +{num(r.desvio_pct)}%
                      {r.ficha === 'FA05' && (
                        <div className="text-[10px] font-normal" style={{ color: 'var(--warning)' }}
                          title="Mesmo m³ cobrado por vários meses seguidos, acima do normal: típico de cobrança pela média/estimativa/mínimo sem o hidrômetro medir. Confira na fatura.">
                          cobrança sem medição · {r.n_meses} meses
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center tabular-nums font-semibold" style={{ color: '#1f9d6b' }}>{brl(r.ressarcimento_estimado)}</td>
                    <td className="px-3 py-2 text-center whitespace-nowrap">
                      {r.conferencia ? (
                        <button type="button" onClick={() => setAbertoConf(abertoConf === r.id ? null : r.id)}
                          className="px-2 py-0.5 rounded-full text-[11px] font-semibold"
                          style={{ background: CONF_COR[r.conferencia] || '#6b7280', color: '#fff' }}
                          title="Ver a explicação da conferência">
                          {r.conferencia === 'VERDADEIRO' ? 'Verdadeiro' : r.conferencia === 'FALSO' ? 'Falso' : 'Inconclusivo'} {abertoConf === r.id ? '▴' : '▾'}
                        </button>
                      ) : <span className="opacity-40">não conferida</span>}
                      {r.conferencia === 'VERDADEIRO' && (r.conferencia_causa || r.conferencia_recalcular) && (
                        <div className="text-[11px] opacity-70 mt-0.5">
                          {CAUSA_ROTULO[r.conferencia_causa] || ''}
                          {r.conferencia_causa === 'CONSUMO_ALTO_MEDIDO' && EVID_ROTULO[r.conferencia_evidencia] &&
                            <span title={r.conferencia_aviso || ''}> ({EVID_ROTULO[r.conferencia_evidencia]})</span>}
                          {r.conferencia_recalcular && <span style={{ color: 'var(--warning)' }}>{r.conferencia_causa ? ' · ' : ''}refazer valor</span>}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center whitespace-nowrap">
                      <button onClick={() => setReqRow({ ...r, empresa_nome: (empresasResumo.find((e) => e.cod_empresa === r.cod_empresa) || {}).nome })} className="cpv2-btn cpv2-btn--primary mr-1" title="Gerar requisição">📝</button>
                      <button onClick={() => setDetalhe(r)} className="cpv2-btn cpv2-btn--ghost mr-1" title="Analisar UC: gráfico + todas as faturas do banco">📊 Analisar UC</button>
                      <button onClick={() => abrirDossie(r.id)} disabled={r.conferencia !== 'VERDADEIRO'} className="cpv2-btn cpv2-btn--ghost mr-1"
                        title={r.conferencia === 'VERDADEIRO' ? 'Dossiê do apontamento (PDF): conta, gráfico, conferência e o que pedir à concessionária' : 'Dossiê só para apontamento conferido como VERDADEIRO'}>📑 Dossiê</button>
                      {r.link_fatura && <a href={r.link_fatura} target="_blank" rel="noreferrer" className="cpv2-btn cpv2-btn--ghost mr-1" title="Abrir PDF">📄</a>}
                      <button onClick={() => rejeitar(r.id)} className="cpv2-btn"
                        style={{ background: 'var(--danger, #dc2626)', color: '#fff', borderColor: 'var(--danger, #dc2626)' }}
                        title="Rejeitar apontamento (falso positivo) — some da lista">✕ Rejeitar</button>
                    </td>
                  </tr>
                  {abertoConf === r.id && r.conferencia_obs && (
                    <tr className="bg-[var(--cpv2-surface-2)]">
                      <td colSpan={COLS.length} className="px-4 py-2 text-xs whitespace-pre-wrap">{r.conferencia_obs}</td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reqRow && (
        <CriarRequisicaoAguaModal
          row={reqRow}
          onClose={() => setReqRow(null)}
          onCreated={(res) => {
            setReqRow(null);
            setOkMsg(`Requisição criada${res?.id_requisicao ? ` (#${res.id_requisicao})` : ''} para a UC ${reqRow.uc}.`);
            setRows((rs) => rs.filter((x) => x.id !== reqRow.id));
            setTimeout(() => setOkMsg(''), 6000);
          }}
        />
      )}

      {detalhe && <DetalheUCAguaModal row={detalhe} onClose={() => setDetalhe(null)} />}
    </div>
  );
}

// Modal "Analisar UC" — gráfico do histórico completo (recharts) + tabela de TODAS as
// faturas de água da UC no banco, com o desvio vs mediana e o limiar de 1,8× marcados, e a fatura
// apontada em PDF (o histórico de consumo impresso nela é a prova do pico). Meses com valor mas sem m³
// no banco aparecem marcados — a origem não trouxe o volume e o pico pode estar ali.
function DetalheUCAguaModal({ row, onClose }) {
  const [serie, setSerie] = useState(null);
  const [erro, setErro] = useState('');
  const [pdf, setPdf] = useState({ url: '', carregando: false, erro: '', n: 1, total: 1 });
  // o link do sgeeasy às vezes traz a página "1º Fatura / 2º Fatura" (fatura do mês + refaturamento ou
  // fatura de outro mês) — o servidor devolve uma por vez (?n=) e diz quantas há (X-Faturas)
  const verFatura = async (n = 1) => {
    setPdf((p) => ({ ...p, carregando: true, erro: '' }));
    try {
      const { data, headers } = await apiClient.get(`/api/v1/faturas/agua/${row.id}/pdf`, { params: { n }, responseType: 'blob' });
      setPdf({ url: URL.createObjectURL(data), carregando: false, erro: '', n, total: Number(headers?.['x-faturas'] || 1) });
    } catch {
      setPdf((p) => ({ ...p, url: '', carregando: false, erro: 'Não foi possível trazer a fatura do portal.' }));
    }
  };
  useEffect(() => () => { if (pdf.url) URL.revokeObjectURL(pdf.url); }, [pdf.url]);
  useEffect(() => {
    apiClient.get(`/api/v1/faturas/agua/${row.id}/historico`)
      .then(({ data }) => setSerie(data?.historico || []))
      .catch(() => { setErro('Falha ao carregar histórico.'); setSerie([]); });
  }, [row.id]);

  const media = useMemo(() => {
    const vs = (serie || []).map((h) => Number(h.consumo_m3 || 0)).filter((v) => v > 0);
    if (!vs.length) return 0;
    return vs.reduce((a, b) => a + b, 0) / vs.length;
  }, [serie]);

  const dados = (serie || []).map((h) => ({
    mes: h.mes, consumo: Number(h.consumo_m3 || 0), rs: Number(h.rs_total || 0),
    link: h.link_fatura || '',
    semConsumo: !!h.sem_consumo,
    pico: Number(h.consumo_m3 || 0) >= media * 1.8 && media > 0,
  }));
  const semConsumo = dados.filter((d) => d.semConsumo);
  const apontados = dados.filter((d) => d.pico);
  const links = dados.filter((d) => d.link);
  const copiarLinks = () => {
    const txt = dados.filter((d) => d.link).map((d) => `${d.mes}\t${d.link}`).join('\n');
    navigator.clipboard?.writeText(txt);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-4xl max-h-[92vh] overflow-y-auto p-5 rounded-xl"
        style={{ background: 'var(--cpv2-surface, var(--card, #fff))', border: '1px solid var(--cpv2-border, #ddd)', boxShadow: '0 12px 48px rgba(0,0,0,0.35)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-lg font-bold">📊 Análise da UC {row.uc} — {row.concessionaria}</h3>
          <button onClick={onClose} className="cpv2-btn cpv2-btn--ghost">✕</button>
        </div>
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="text-xs opacity-60">
            Todas as faturas de água da UC no banco · média {num(media)} m³ · {dados.length} meses · {apontados.length} acima de 1,8× (apontados) · {links.length} c/ link
            {semConsumo.length > 0 && <span style={{ color: 'var(--warning)' }}> · {semConsumo.length} sem m³ no banco ({semConsumo.map((d) => d.mes).join(', ')})</span>}
          </div>
          {links.length > 0 && (
            <button onClick={copiarLinks} className="cpv2-btn cpv2-btn--ghost whitespace-nowrap" title="Copiar mês + link de todas as faturas (para o analista conferir anteriores/próximas)">📋 Copiar links ({links.length})</button>
          )}
        </div>
        {erro && <div className="text-sm text-[var(--danger)]">{erro}</div>}
        {serie === null ? (
          <div className="opacity-60 py-8 text-center text-sm">Carregando…</div>
        ) : (
          <>
            <div style={{ width: '100%', height: 260 }}>
              <ResponsiveContainer>
                <ComposedChart data={dados} margin={{ top: 10, right: 10, left: 0, bottom: 30 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                  <XAxis dataKey="mes" tick={{ fontSize: 9 }} angle={-60} textAnchor="end" interval={Math.max(0, Math.floor(dados.length / 24))} height={50} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v) => [`${num(v)} m³`, 'consumo']} />
                  <ReferenceLine y={media} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: `média ${num(media)}`, fontSize: 10, fill: '#f59e0b', position: 'insideTopLeft' }} />
                  <ReferenceLine y={media * 1.8} stroke="#ef4444" strokeDasharray="2 4" label={{ value: '1,8× (limiar)', fontSize: 10, fill: '#ef4444', position: 'insideTopLeft' }} />
                  <Bar dataKey="consumo">
                    {dados.map((d, i) => <Cell key={i} fill={d.pico ? '#2b8fd6' : 'var(--cpv2-border)'} />)}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 rounded border border-[var(--cpv2-border)]">
              <div className="flex items-center justify-between px-3 py-2 text-xs">
                <span className="font-semibold">🧾 Fatura apontada ({row.mes_referencia}) — o histórico de consumo impresso nela é a prova do pico</span>
                {!pdf.url && (
                  <button onClick={() => verFatura(1)} disabled={pdf.carregando} className="cpv2-btn cpv2-btn--ghost whitespace-nowrap">
                    {pdf.carregando ? 'Carregando…' : 'Ver fatura aqui'}
                  </button>
                )}
                {pdf.url && pdf.total > 1 && (
                  <span className="flex items-center gap-1 whitespace-nowrap">
                    {Array.from({ length: pdf.total }, (_, i) => i + 1).map((k) => (
                      <button key={k} onClick={() => verFatura(k)} disabled={pdf.carregando || k === pdf.n}
                        className={`cpv2-btn ${k === pdf.n ? 'cpv2-btn--primary' : 'cpv2-btn--ghost'}`}>{k}ª fatura</button>
                    ))}
                  </span>
                )}
              </div>
              {pdf.url && pdf.total > 1 && (
                <div className="px-3 pb-2 text-xs" style={{ color: 'var(--warning)' }}>
                  O portal traz {pdf.total} faturas neste link. Confira qual é a de {row.mes_referencia}: às vezes a outra é um refaturamento que substitui esta, às vezes é de outro mês.
                </div>
              )}
              {pdf.erro && <div className="px-3 pb-2 text-xs text-[var(--danger)]">{pdf.erro}</div>}
              {pdf.url && <iframe title="Fatura apontada" src={pdf.url} className="w-full border-t border-[var(--cpv2-border)]" style={{ height: 720 }} />}
            </div>
            {/* Lista de faturas RECOLHÍVEL (igual ao modal de energia): escondida por
                padrão; clica no ▶ pra expandir e ver mês ref + link de cada fatura. */}
            <details className="mt-3 rounded border border-[var(--cpv2-border)]">
              <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold flex items-center gap-2">
                📄 Faturas da UC ({dados.length}) · {links.length} com link
              </summary>
              <div className="border-t border-[var(--cpv2-border)] overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-[var(--cpv2-surface-2)]"><tr>
                    {['Mês ref', 'Consumo m³', 'vs média', 'R$ total', 'Status', 'Fatura'].map((h) => <th key={h} className="px-3 py-1.5 text-left">{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {dados.map((d, i) => (
                      <tr key={i} className="border-t border-[var(--cpv2-border)]">
                        <td className="px-3 py-1.5 font-mono">{d.mes}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{d.semConsumo ? <span style={{ color: 'var(--warning)' }} title="A origem não trouxe o m³ desta fatura — confira no PDF">sem m³</span> : num(d.consumo)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{media > 0 ? `+${num((d.consumo - media) / media * 100)}%` : '—'}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{brl(d.rs)}</td>
                        <td className="px-3 py-1.5">{d.pico ? <span style={{ color: '#2b8fd6' }} className="font-semibold">apontado (≥1,8×)</span> : <span className="opacity-50">ok</span>}</td>
                        <td className="px-3 py-1.5">{d.link ? <a href={d.link} target="_blank" rel="noreferrer" className="text-[#2b8fd6] underline">📄 abrir</a> : <span className="opacity-40">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </div>
    </div>
  );
}

// Modal de criação de requisição — MESMOS campos/endpoint do fluxo de energia
// (POST /api/v1/requisicoes, FormData), populado a partir do apontamento de água.
function CriarRequisicaoAguaModal({ row, onClose, onCreated }) {
  const [tipos, setTipos] = useState([]);
  const [subtipos, setSubtipos] = useState([]);
  const excedente = Math.max(0, Number(row.consumo_m3 || 0) - Number(row.mediana_m3 || 0));
  const descricaoPadrao =
    `═══ DESVIO DE CONSUMO — ÁGUA ═══\n` +
    `• UC: ${row.uc} · ${row.concessionaria || ''}\n` +
    `• Mês de referência: ${row.mes_referencia}\n` +
    `• Consumo do mês: ${num(row.consumo_m3)} m³ | Média histórica: ${num(row.mediana_m3)} m³ (${row.n_meses} meses)\n` +
    `• Desvio: +${num(row.desvio_pct)}% acima da média | Excedente: ${num(excedente)} m³\n` +
    `• Ressarcimento estimado (excedente × R$/m³): ${brl(row.ressarcimento_estimado)}\n` +
    `• Ficha: ${row.ficha} (consumo ≥ 1,8× a média, 80% acima)`;

  const [form, setForm] = useState({
    uc: String(row.uc || '').trim(),
    concessionaria: row.concessionaria || '',
    cliente: row.cliente_nome || row.empresa_nome || nomeEmpresa(row.cod_empresa),
    mes_ref: row.mes_referencia || '',
    id_tipo_irregularidade: '',
    id_subtipo_irregularidade: '',
    valor_estimado: fmtBR(row.ressarcimento_estimado),
    descricao: descricaoPadrao,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const upd = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    apiClient.get('/api/v1/tipos-irregularidade')
      .then((r) => {
        const list = Array.isArray(r.data) ? r.data : (r.data?.rows ?? r.data?.tipos ?? []);
        setTipos(list);
        if (list[0]) setForm((f) => ({ ...f, id_tipo_irregularidade: String(list[0].id ?? list[0].id_tipo_irregularidade ?? '') }));
      })
      .catch(() => setTipos([]));
  }, []);
  useEffect(() => {
    const t = form.id_tipo_irregularidade;
    if (!t) { setSubtipos([]); return; }
    apiClient.get(`/api/v1/tipos-irregularidade/${t}/subtipos`)
      .then((r) => {
        const list = Array.isArray(r.data) ? r.data : (r.data?.rows ?? r.data?.subtipos ?? []);
        setSubtipos(list);
        if (list[0]) setForm((f) => ({ ...f, id_subtipo_irregularidade: String(list[0].id ?? list[0].id_subtipo_irregularidade ?? '') }));
      })
      .catch(() => setSubtipos([]));
  }, [form.id_tipo_irregularidade]);

  const submit = useCallback(async () => {
    setSaving(true); setError('');
    try {
      const valorNum = parseBR(form.valor_estimado);
      if (!(valorNum > 0)) { setError('Valor estimado precisa ser maior que zero.'); setSaving(false); return; }
      const valorBR = fmtBR(valorNum);
      // periodos_irregularidade JSON [{mes,ano}] a partir de mes_ref (YYYY-MM-DD)
      const raw = String(form.mes_ref || '').trim();
      let mes = null, ano = null;
      const m1 = raw.match(/^(\d{4})-(\d{1,2})/); const m2 = raw.match(/^(\d{1,2})\/(\d{4})$/);
      if (m1) { ano = m1[1]; mes = m1[2].padStart(2, '0'); } else if (m2) { ano = m2[2]; mes = m2[1].padStart(2, '0'); }
      if (!mes || !ano) { const h = new Date(); mes = String(h.getMonth() + 1).padStart(2, '0'); ano = String(h.getFullYear()); }
      const periodosJSON = JSON.stringify([{ mes, ano }]);

      const fd = new FormData();
      fd.append('uc', form.uc);
      fd.append('concessionaria', form.concessionaria);
      fd.append('cliente', form.cliente);
      // ESTRUTURAL: manda o CÓDIGO do cliente; o backend resolve o nome pela Tab_Empresa
      // (fonte de verdade) e ignora o placeholder "Empresa <cod>" da Cache de água.
      if (row.cod_empresa != null) fd.append('cod_cliente', String(row.cod_empresa));
      fd.append('mes_ref', form.mes_ref);
      fd.append('id_tipo_irregularidade', form.id_tipo_irregularidade);
      fd.append('idTipoIrregularidade', form.id_tipo_irregularidade);
      fd.append('id_subtipo_irregularidade', form.id_subtipo_irregularidade);
      fd.append('idSubtipoIrregularidade', form.id_subtipo_irregularidade);
      fd.append('descricao', form.descricao);
      fd.append('descricaoIrregularidade', form.descricao);
      fd.append('periodosIrregularidade', periodosJSON);
      fd.append('periodos', periodosJSON);
      fd.append('valor_estimado', valorBR);
      fd.append('ressarcimentoEstimado', valorBR);
      fd.append('fichas', row.ficha || 'FA02');
      // NÃO enviar fatura_id: o backend o resolve contra FATURA_DADOS_EXTRAIDOS (energia)
      // e o id da água pode colidir → anexaria PDF errado. Link da água vai na descrição.
      fd.append('link_fatura_agua', row.link_fatura || '');
      fd.append('analise_ia', JSON.stringify({ origem: 'agua', fatura_agua_id: row.id, desvio_pct: row.desvio_pct, excedente_m3: excedente, mediana_m3: row.mediana_m3 }));

      const res = await apiClient.post('/api/v1/requisicoes', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      onCreated?.(res?.data);
    } catch (e) {
      const err = e?.response?.data;
      setError(err?.error ? (err.missing_fields ? `${err.error}: ${err.missing_fields.join(', ')}` : err.error) : 'Falha ao criar requisição.');
    } finally { setSaving(false); }
  }, [form, row, excedente, onCreated]);

  const tid = (t) => String(t.id ?? t.id_tipo_irregularidade ?? '');
  const sid = (s) => String(s.id ?? s.id_subtipo_irregularidade ?? '');
  const tlabel = (t) => t.nome ?? t.descricao ?? t.tipo ?? tid(t);
  const slabel = (s) => s.nome ?? s.descricao ?? s.subtipo ?? sid(s);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto p-5 rounded-xl"
        style={{ background: 'var(--cpv2-surface, var(--card, #fff))', border: '1px solid var(--cpv2-border, #ddd)', boxShadow: '0 12px 48px rgba(0,0,0,0.35)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-bold">💧 Gerar requisição — UC {row.uc}</h3>
          <button onClick={onClose} className="cpv2-btn cpv2-btn--ghost">✕</button>
        </div>
        {error && <div className="text-sm text-[var(--danger)] mb-2">{error}</div>}
        <div className="text-[11px] mb-2" style={{ color: row.conferencia === 'VERDADEIRO' ? 'var(--cpv2-text-muted, #6b7280)' : 'var(--warning)' }}>
          {row.conferencia === 'VERDADEIRO'
            ? '📑 O dossiê do apontamento e a fatura serão anexados automaticamente à requisição.'
            : 'Atenção: este apontamento não está conferido como VERDADEIRO — a requisição sai sem o dossiê.'}
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <Field label="UC" value={form.uc} onChange={upd('uc')} />
          <Field label="Concessionária" value={form.concessionaria} onChange={upd('concessionaria')} />
          <Field label="Cliente" value={form.cliente} onChange={upd('cliente')} />
          <Field label="Mês de referência" value={form.mes_ref} onChange={upd('mes_ref')} />
          <label className="flex flex-col gap-1">
            <span className="opacity-70">Tipo de irregularidade</span>
            <select className="cpv2-select" value={form.id_tipo_irregularidade} onChange={upd('id_tipo_irregularidade')}>
              {tipos.map((t) => <option key={tid(t)} value={tid(t)}>{tlabel(t)}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="opacity-70">Subtipo</span>
            <select className="cpv2-select" value={form.id_subtipo_irregularidade} onChange={upd('id_subtipo_irregularidade')}>
              {subtipos.map((s) => <option key={sid(s)} value={sid(s)}>{slabel(s)}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 col-span-2">
            <span className="opacity-70">Valor estimado (R$)</span>
            <input className="cpv2-input" value={form.valor_estimado} onChange={upd('valor_estimado')} />
          </label>
          <label className="flex flex-col gap-1 col-span-2">
            <span className="opacity-70">Descrição da irregularidade</span>
            <textarea className="cpv2-input font-mono text-[11px]" rows={7} value={form.descricao} onChange={upd('descricao')} />
          </label>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="cpv2-btn cpv2-btn--ghost">Cancelar</button>
          <button onClick={submit} disabled={saving} className="cpv2-btn cpv2-btn--primary">
            {saving ? 'Criando…' : 'Criar requisição'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="opacity-70">{label}</span>
      <input className="cpv2-input" value={value} onChange={onChange} />
    </label>
  );
}

function Kpi({ label, valor, cor }) {
  return (
    <div className="rounded-lg border border-[var(--cpv2-border)] px-4 py-3 min-w-[160px]">
      <div className="text-[10px] uppercase tracking-wide opacity-60">{label}</div>
      <div className="text-lg font-bold" style={{ color: cor }}>{valor}</div>
    </div>
  );
}
