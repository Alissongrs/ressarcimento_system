import React, { useCallback, useEffect, useMemo, useState } from 'react';
import apiClient from '../services/apiClient';
import {
  ResponsiveContainer, ComposedChart, Bar, XAxis, YAxis, Tooltip, ReferenceLine, Cell, CartesianGrid,
} from 'recharts';
import ModalFaturaMontada from './ModalFaturaMontada';

// 🅰️ Aba ACER (empresa 2028) — dentro de /analise-desvio.
// Fonte: FATURA_ACER_DADOS_EXTRAIDOS (normalizador JSON). Mesmo motor F01–F05 do resto,
// apontado para a tabela da Acer (endpoints /api/v1/acer/*). Métricas e tabela 100% Acer.

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = (v) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
const pct = (v) => `${Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%`;
// O link da Acer termina em '.pdf.json' (JSON de extração); o PDF real é a URL sem o '.json'.
const pdfLink = (l) => String(l || '').replace(/\.json$/i, '');
const fmtBR = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const parseBR = (s) => {
  if (typeof s === 'number') return s;
  const t = String(s ?? '').trim();
  if (!t) return 0;
  return t.includes(',') ? (Number(t.replace(/\./g, '').replace(',', '.')) || 0) : (Number(t) || 0);
};
const ACER_COD_EMPRESA = 2028;

const FICHAS = ['', 'F01', 'F02', 'F04', 'F05'];

const COLS = [
  { label: 'UC', key: 'uc', num: false },
  { label: 'Distribuidora', key: 'distribuidora', num: false },
  { label: 'Mês', key: 'mes_ref', num: false },
  { label: 'Grupo', key: 'grupo_tarifario', num: false },
  { label: 'kWh', key: 'kwh_total', num: true },
  { label: 'Energia ativa (R$)', key: 'valor_energia_ativa', num: true },
  { label: 'Desvio', key: 'desvio_pct_max', num: true },
  { label: 'Ficha', key: 'fichas_aplicadas', num: false },
  { label: 'Ressarc. estimado', key: 'ressarcimento_estimado', num: true },
  { label: 'Ações', key: null, num: false },
];

export default function AcerPanel() {
  const [resumo, setResumo] = useState(null);
  const [rows, setRows] = useState([]);
  const [ficha, setFicha] = useState('');
  const [dist, setDist] = useState('');
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');
  const [sort, setSort] = useState({ key: 'ressarcimento_estimado', dir: 'desc' });
  const [reqRow, setReqRow] = useState(null);   // linha gerando requisição
  const [modalFatura, setModalFatura] = useState(null); // fatura no modal completo (igual Auditados)
  const [detalhe, setDetalhe] = useState(null); // UC em análise (modal gráfico + faturas)
  const [feitas, setFeitas] = useState(() => new Set()); // ids que já viraram requisição (some da lista)
  const [okMsg, setOkMsg] = useState('');

  useEffect(() => {
    let vivo = true;
    setLoading(true); setErro('');
    const params = { limit: 800 };
    if (ficha) params.ficha = ficha;
    if (dist.trim()) params.dist = dist.trim();
    Promise.all([
      apiClient.get('/api/v1/acer/resumo'),
      apiClient.get('/api/v1/acer/apontamentos', { params }),
    ]).then(([r1, r2]) => {
      if (!vivo) return;
      setResumo(r1.data);
      setRows(r2.data?.rows || []);
    }).catch((e) => {
      if (!vivo) return;
      setErro(e?.response?.data?.error || 'Falha ao carregar dados da Acer.');
    }).finally(() => { if (vivo) setLoading(false); });
    return () => { vivo = false; };
  }, [ficha, dist]);

  const sorted = useMemo(() => {
    const arr = rows.filter((r) => !feitas.has(r.id));
    const { key, dir } = sort;
    if (!key) return arr;
    const isNum = COLS.find((c) => c.key === key)?.num;
    arr.sort((a, b) => {
      let va = a[key], vb = b[key];
      if (isNum) { va = Number(va) || 0; vb = Number(vb) || 0; return dir === 'asc' ? va - vb : vb - va; }
      va = String(va ?? ''); vb = String(vb ?? '');
      return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    });
    return arr;
  }, [rows, sort, feitas]);
  const toggleSort = (key) => { if (!key) return; setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' })); };

  const pf = resumo?.por_ficha || {};
  const dists = resumo?.por_distribuidora || [];

  return (
    <div className="space-y-4">
      {okMsg && <div className="text-sm text-[var(--success)] font-semibold">{okMsg}</div>}
      {/* Cards — 100% Acer */}
      <div className="flex gap-3 flex-wrap">
        <Kpi label="Unidades (UCs)" valor={num(resumo?.total_ucs)} cor="#7c6f9c" />
        <Kpi label="Faturas" valor={num(resumo?.total_faturas)} cor="#7c6f9c" />
        <Kpi label="Faturas apontadas" valor={num(resumo?.faturas_apontadas)} cor="#b8860b" />
        <Kpi label="UCs apontadas" valor={num(resumo?.ucs_apontadas)} cor="#b8860b" />
        <Kpi label="Ressarcimento estimado" valor={brl(resumo?.ressarcimento_estimado)} cor="#1f9d6b" />
      </div>

      {/* Quebra por ficha + top distribuidoras */}
      <div className="flex gap-4 flex-wrap text-xs">
        <div className="rounded-lg border border-[var(--cpv2-border)] px-4 py-2">
          <div className="text-[10px] uppercase tracking-wide opacity-60 mb-1">Por ficha</div>
          <div className="flex gap-3">
            {['F01', 'F02', 'F04', 'F05'].map((f) => (
              <span key={f}><b>{f}</b> {num(pf[f] || 0)}</span>
            ))}
          </div>
        </div>
        {dists.length > 0 && (
          <div className="rounded-lg border border-[var(--cpv2-border)] px-4 py-2 flex-1 min-w-[280px]">
            <div className="text-[10px] uppercase tracking-wide opacity-60 mb-1">Top distribuidoras (R$)</div>
            <div className="flex gap-3 flex-wrap">
              {dists.slice(0, 6).map((d) => (
                <span key={d.distribuidora} title={`${d.apontamentos} apontamentos`}>{d.distribuidora}: <b>{brl(d.ressarcimento)}</b></span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Filtros */}
      <div className="flex gap-3 items-center text-xs flex-wrap">
        <label className="inline-flex items-center gap-1.5">
          <span className="opacity-70">Ficha:</span>
          <select className="cpv2-select" value={ficha} onChange={(e) => setFicha(e.target.value)}>
            {FICHAS.map((f) => <option key={f || 'todas'} value={f}>{f || 'Todas'}</option>)}
          </select>
        </label>
        <label className="inline-flex items-center gap-1.5">
          <span className="opacity-70">Distribuidora:</span>
          <input className="cpv2-input" placeholder="ex.: EQUATORIAL" value={dist} onChange={(e) => setDist(e.target.value)} />
        </label>
        <span className="opacity-50">Motor F02 (desvio de consumo) sobre a base Acer (FATURA_ACER_DADOS_EXTRAIDOS) · ressarcimento estimado 100% (valor cheio).</span>
      </div>

      {erro && <div className="text-sm text-[var(--danger)]">{erro}</div>}
      {loading ? (
        <div className="text-sm opacity-60 py-8 text-center">Carregando apontamentos da Acer…</div>
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
                <tr><td colSpan={COLS.length} className="px-3 py-8 text-center opacity-50">Nenhum apontamento da Acer com esse filtro.</td></tr>
              )}
              {sorted.map((r) => {
                const link = pdfLink(r.link_fatura);
                return (
                  <tr key={r.id} className="border-t border-[var(--cpv2-border)] hover:bg-[var(--cpv2-surface-2)] cursor-pointer"
                    onClick={(e) => { if (e.target.closest('button, a, select, input')) return; setModalFatura({ ...r, fonte: 'acer' }); }}
                    title="Clique p/ abrir a análise completa da fatura">
                    <td className="px-3 py-2 text-center font-mono whitespace-nowrap">{r.uc}</td>
                    <td className="px-3 py-2 text-center">{r.distribuidora}</td>
                    <td className="px-3 py-2 text-center whitespace-nowrap">{r.mes_ref}</td>
                    <td className="px-3 py-2 text-center">{r.grupo_tarifario}</td>
                    <td className="px-3 py-2 text-center tabular-nums">{num(r.kwh_total)}</td>
                    <td className="px-3 py-2 text-center tabular-nums">{brl(r.valor_energia_ativa)}</td>
                    <td className="px-3 py-2 text-center tabular-nums font-semibold" style={{ color: r.desvio_pct_max >= 100 ? 'var(--danger)' : 'var(--warning)' }}>+{pct(r.desvio_pct_max)}</td>
                    <td className="px-3 py-2 text-center whitespace-nowrap">{r.fichas_aplicadas}</td>
                    <td className="px-3 py-2 text-center tabular-nums font-semibold" style={{ color: '#1f9d6b' }}>{brl(r.ressarcimento_estimado)}</td>
                    <td className="px-3 py-2 text-center whitespace-nowrap">
                      <button onClick={() => setReqRow(r)} className="cpv2-btn cpv2-btn--primary mr-1" title="Gerar requisição a partir deste apontamento">📝</button>
                      <button onClick={() => setDetalhe(r)} className="cpv2-btn cpv2-btn--ghost mr-1" title="Analisar UC: gráfico do histórico + todas as faturas">📊 Analisar UC</button>
                      {link ? <a href={link} target="_blank" rel="noreferrer" className="cpv2-btn cpv2-btn--ghost" title="Abrir PDF da fatura">📄</a> : <span className="opacity-40">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!loading && rows.length > 0 && (
        <div className="text-[11px] opacity-50">{num(sorted.length)} apontamentos exibidos (ordenados por ressarcimento). 📝 gera requisição · 📄 abre o PDF da fatura.</div>
      )}

      {reqRow && (
        <CriarRequisicaoAcerModal
          row={reqRow}
          onClose={() => setReqRow(null)}
          onCreated={(res) => {
            const id = reqRow.id;
            setReqRow(null);
            setFeitas((s) => new Set(s).add(id));
            setOkMsg(`Requisição criada${res?.id_requisicao ? ` (#${res.id_requisicao})` : ''} para a UC ${reqRow.uc}.`);
            setTimeout(() => setOkMsg(''), 6000);
          }}
        />
      )}

      {detalhe && <DetalheUCAcerModal row={detalhe} onClose={() => setDetalhe(null)} />}

      {modalFatura && (
        <ModalFaturaMontada row={modalFatura} onClose={() => setModalFatura(null)} />
      )}
    </div>
  );
}

// Modal "Analisar UC" — gráfico do histórico de consumo (recharts) + tabela de TODAS as
// faturas da UC na base Acer, com o mês apontado destacado e a média marcada. Igual ao de Água.
function DetalheUCAcerModal({ row, onClose }) {
  const [serie, setSerie] = useState(null);
  const [erro, setErro] = useState('');
  useEffect(() => {
    apiClient.get('/api/v1/acer/uc-historico', { params: { uc: row.uc } })
      .then(({ data }) => setSerie(data?.historico || []))
      .catch(() => { setErro('Falha ao carregar histórico.'); setSerie([]); });
  }, [row.uc]);

  const media = useMemo(() => {
    const vs = (serie || []).map((h) => Number(h.kwh_total || 0)).filter((v) => v > 0);
    if (!vs.length) return 0;
    return vs.reduce((a, b) => a + b, 0) / vs.length;
  }, [serie]);

  const dados = (serie || []).map((h) => ({
    mes: h.mes, kwh: Number(h.kwh_total || 0), ea: Number(h.valor_energia_ativa || 0),
    total: Number(h.valor_total_fatura || 0), link: pdfLink(h.link_fatura),
    apontado: h.mes === row.mes_ref,
  }));
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
          <h3 className="text-lg font-bold">📊 Análise da UC {row.uc} — {row.distribuidora}</h3>
          <button onClick={onClose} className="cpv2-btn cpv2-btn--ghost">✕</button>
        </div>
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="text-xs opacity-60">
            Todas as faturas da UC na base Acer · média {num(media)} kWh · {dados.length} meses · mês apontado: {row.mes_ref} · {links.length} c/ link
          </div>
          {links.length > 0 && (
            <button onClick={copiarLinks} className="cpv2-btn cpv2-btn--ghost whitespace-nowrap" title="Copiar mês + link de todas as faturas">📋 Copiar links ({links.length})</button>
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
                  <Tooltip formatter={(v) => [`${num(v)} kWh`, 'consumo']} />
                  <ReferenceLine y={media} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: `média ${num(media)}`, fontSize: 10, fill: '#f59e0b', position: 'insideTopLeft' }} />
                  <Bar dataKey="kwh">
                    {dados.map((d, i) => <Cell key={i} fill={d.apontado ? '#dc2626' : 'var(--cpv2-border)'} />)}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <details className="mt-3 rounded border border-[var(--cpv2-border)]" open>
              <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold flex items-center gap-2">
                📄 Faturas da UC ({dados.length}) · {links.length} com link
              </summary>
              <div className="border-t border-[var(--cpv2-border)] overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-[var(--cpv2-surface-2)]"><tr>
                    {['Mês ref', 'Consumo kWh', 'vs média', 'Energia (R$)', 'Total (R$)', 'Status', 'Fatura'].map((h) => <th key={h} className="px-3 py-1.5 text-left">{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {dados.map((d, i) => (
                      <tr key={i} className="border-t border-[var(--cpv2-border)]" style={d.apontado ? { background: 'color-mix(in srgb, #dc2626 10%, transparent)' } : undefined}>
                        <td className="px-3 py-1.5 font-mono">{d.mes}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{num(d.kwh)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{media > 0 ? `${d.kwh >= media ? '+' : ''}${num((d.kwh - media) / media * 100)}%` : '—'}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{brl(d.ea)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums opacity-70">{brl(d.total)}</td>
                        <td className="px-3 py-1.5">{d.apontado ? <span style={{ color: '#dc2626' }} className="font-semibold">apontado</span> : <span className="opacity-50">—</span>}</td>
                        <td className="px-3 py-1.5">{d.link ? <a href={d.link} target="_blank" rel="noreferrer" className="text-[#7c6f9c] underline">📄 abrir</a> : <span className="opacity-40">—</span>}</td>
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

// Modal de criação de requisição — MESMO endpoint/campos do fluxo de energia
// (POST /api/v1/requisicoes, FormData), populado a partir do apontamento Acer.
// NÃO envia fatura_id (o id é da FATURA_ACER_DADOS_EXTRAIDOS e colidiria com a FDE);
// o link do PDF vai na descrição. cod_cliente = 2028 → backend resolve o nome pela Tab_Empresa.
function CriarRequisicaoAcerModal({ row, onClose, onCreated }) {
  const [tipos, setTipos] = useState([]);
  const [subtipos, setSubtipos] = useState([]);
  // média/excedente derivados do consumo e do desvio do motor:
  //   desvio% = (consumo - média)/média  →  média = consumo/(1+dv)  ·  excedente = consumo - média
  const _kwh = Number(row.kwh_total || 0);
  const _dv = Number(row.desvio_pct_max || 0) / 100;
  const _media = _dv > -1 ? _kwh / (1 + _dv) : 0;
  const _exc = Math.max(0, _kwh - _media);
  const _tarifa = _kwh > 0 ? Number(row.valor_energia_ativa || 0) / _kwh : 0;
  const descricaoPadrao = [
    `═══ APONTAMENTO ${row.fichas_aplicadas || 'F02'} — ENERGIA (Acer) ═══`,
    `Cliente: ASSOCIACAO DE C. E. R. ACER`,
    `UC: ${row.uc}`,
    `Grupo/Modalidade: ${row.grupo_tarifario || '—'}`,
    `Fichas aplicadas: ${row.fichas_aplicadas || 'F02'}`,
    ``,
    `─── Desvio de consumo ───`,
    `Consumo do mês: ${num(_kwh)} kWh`,
    `Média histórica (estimada): ${num(_media)} kWh`,
    `Excedente sobre a média: ${num(_exc)} kWh`,
    `Desvio sobre a média: +${pct(row.desvio_pct_max)}`,
    ``,
    `─── Ressarcimento ───`,
    `Tarifa de energia aplicada: ${brl(_tarifa)}/kWh`,
    `Base de energia (R$): ${brl(row.valor_energia_ativa)}`,
    `Ressarcimento estimado: ${brl(row.ressarcimento_estimado)} (100%, valor cheio)`,
    `  (excedente × tarifa de energia)`,
    ``,
    `═══ FONTES ═══`,
    `Distribuidora: ${row.distribuidora || '—'}`,
    `Mês de referência: ${row.mes_ref}`,
    `Fatura (PDF): ${pdfLink(row.link_fatura)}`,
  ].join('\n');

  const [form, setForm] = useState({
    uc: String(row.uc || '').trim(),
    concessionaria: row.distribuidora || '',
    cliente: 'ASSOCIACAO DE C. E. R. ACER',
    mes_ref: row.mes_ref || '',
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
      fd.append('cod_cliente', String(ACER_COD_EMPRESA)); // backend resolve nome pela Tab_Empresa
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
      fd.append('fichas', row.fichas_aplicadas || 'F02');
      // NÃO enviar fatura_id (id é da tabela Acer, colidiria com a FDE); link vai na descrição.
      fd.append('analise_ia', JSON.stringify({ origem: 'acer', fatura_acer_id: row.id, desvio_pct: row.desvio_pct_max, kwh_total: row.kwh_total, link: pdfLink(row.link_fatura) }));

      const res = await apiClient.post('/api/v1/requisicoes', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      onCreated?.(res?.data);
    } catch (e) {
      const err = e?.response?.data;
      setError(err?.error ? (err.missing_fields ? `${err.error}: ${err.missing_fields.join(', ')}` : err.error) : 'Falha ao criar requisição.');
    } finally { setSaving(false); }
  }, [form, row, onCreated]);

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
          <h3 className="text-lg font-bold">🅰️ Gerar requisição — UC {row.uc}</h3>
          <button onClick={onClose} className="cpv2-btn cpv2-btn--ghost">✕</button>
        </div>
        {error && <div className="text-sm text-[var(--danger)] mb-2">{error}</div>}
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
            <textarea className="cpv2-input font-mono text-[11px]" rows={8} value={form.descricao} onChange={upd('descricao')} />
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
