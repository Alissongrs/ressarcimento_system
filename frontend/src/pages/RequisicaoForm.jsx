import React, { useEffect, useMemo, useRef, useState } from 'react';
import { criarRequisicao } from '../services/requisicaoService';
import apiClient from '../services/apiClient';
import { useAuth } from '../context/AuthContext.jsx';
import {
  Search, X, FileText, Loader2, Clock, Mail, MessageCircle, Users,
  Building2, User, Zap, MapPin, CalendarRange, AlertTriangle, CheckCircle2, ExternalLink,
} from 'lucide-react';
import Toast from '../components/Toast.jsx';
import '../pages/controleProcessosV2.css';

const MESES_PT_BR = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

const RequisicaoForm = ({ initialUc = '', onClose } = {}) => {
  const toStr = (v) => {
    if (v == null) return '';
    if (typeof v === 'object') {
      if ('Valid' in v && v.Valid === false) return '';
      if ('String' in v) return v.String ?? '';
    }
    return String(v);
  };
  useAuth();

  const [formData, setFormData] = useState({
    uc: '',
    cod_empresa: '',
    cliente: '',
    razaoSocialFatura: '',
    concessionaria: '',
    cnpj: '',
    enderecoCompleto: '',
    ressarcimentoEstimado: '',
    descricaoIrregularidade: '',
    linkFatura: '',
  });

  const [periodos, setPeriodos] = useState([{ mes: '', ano: '' }]);
  const [periodoAte, setPeriodoAte] = useState(false);
  const [periodoFim, setPeriodoFim] = useState({ mes: '', ano: '' });
  const [anexos, setAnexos] = useState([]);
  const fileInputRef = useRef(null);

  // ── Lookup por UC (sgeeasy Faturas_Registradas_Cache) ──
  const [buscandoUc, setBuscandoUc] = useState(false);
  const [ucBuscado, setUcBuscado] = useState(''); // último dígito buscado
  const [candidatas, setCandidatas] = useState([]);
  const [candidataIdx, setCandidataIdx] = useState(null);
  const [processos, setProcessos] = useState([]);
  const [alertas, setAlertas] = useState([]);
  const [confirmaDuplicada, setConfirmaDuplicada] = useState(false);
  const [ucStatus, setUcStatus] = useState(''); // '', 'ok', 'vazio', 'erro'

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toast, setToast] = useState({ open: false, type: 'info', text: '' });
  const [createdReqId, setCreatedReqId] = useState(null);

  useEffect(() => { if (initialUc) setFormData((p) => ({ ...p, uc: initialUc })); }, [initialUc]);

  const showToast = (type, text, timeout = 3200) => {
    setToast({ open: true, type, text });
    window.setTimeout(() => setToast((t) => ({ ...t, open: false })), timeout);
  };

  const formatCNPJ = (value) => {
    const v = String(value || '').replace(/\D/g, '').slice(0, 14);
    const p = [v.slice(0, 2), v.slice(2, 5), v.slice(5, 8), v.slice(8, 12), v.slice(12, 14)];
    let out = p[0];
    if (p[1]) out = `${p[0]}.${p[1]}`;
    if (p[2]) out = `${p[0]}.${p[1]}.${p[2]}`;
    if (p[3]) out = `${p[0]}.${p[1]}.${p[2]}/${p[3]}`;
    if (p[4]) out = `${p[0]}.${p[1]}.${p[2]}/${p[3]}-${p[4]}`;
    return out || '';
  };
  const unformatNumber = (s) => String(s || '').replace(/\./g, '').replace(',', '.').replace(/[^0-9.]/g, '');
  const formatMoneyBR = (v) => {
    const n = Number(unformatNumber(v));
    return Number.isFinite(n) ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '';
  };
  const fmtMesRef = (ref) => {
    const p = String(ref || '').split('-');
    return p[1] && p[0] ? `${p[1]}/${p[0]}` : (ref || '—');
  };

  const buildMesRef = (mes, ano) => {
    const y = String(ano || '').trim(); const m = String(mes || '').trim();
    return (y && m) ? `${y}-${String(m).padStart(2, '0')}` : '';
  };
  const expandRange = (startRef, endRef) => {
    if (!startRef || !endRef) return [];
    const [sy, sm] = startRef.split('-').map(Number);
    const [ey, em] = endRef.split('-').map(Number);
    if (!sy || !sm || !ey || !em) return [];
    const out = []; let y = sy, m = sm;
    while (y < ey || (y === ey && m <= em)) {
      out.push(`${y}-${String(m).padStart(2, '0')}`);
      m += 1; if (m > 12) { m = 1; y += 1; }
      if (out.length > 240) break;
    }
    return out;
  };
  const buildPeriodosList = () => {
    if (periodoAte) {
      const refs = expandRange(buildMesRef(periodos[0]?.mes, periodos[0]?.ano), buildMesRef(periodoFim.mes, periodoFim.ano));
      return refs.map((ref) => { const [y, m] = ref.split('-'); return { mes: m, ano: y }; });
    }
    return (periodos || []).map((p) => ({ mes: String(p.mes || ''), ano: String(p.ano || '') }));
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    if (name === 'cnpj') return setFormData((p) => ({ ...p, cnpj: formatCNPJ(value) }));
    if (name === 'ressarcimentoEstimado') return setFormData((p) => ({ ...p, ressarcimentoEstimado: unformatNumber(value) }));
    setFormData((p) => ({ ...p, [name]: value }));
  };

  // ── Autobusca da UC (debounce) ──
  const aplicarCandidata = (cand) => {
    if (!cand) return;
    setFormData((p) => ({
      ...p,
      cod_empresa: String(cand.cod_empresa ?? ''),
      cliente: toStr(cand.cliente),
      razaoSocialFatura: toStr(cand.cliente),
      concessionaria: toStr(cand.concessionaria),
      cnpj: formatCNPJ(toStr(cand.cnpj)),
      enderecoCompleto: toStr(cand.endereco_completo),
      linkFatura: toStr(cand.ultimo_link),
    }));
  };

  const fazerLookup = async (ucRaw) => {
    const dig = String(ucRaw || '').replace(/\D/g, '');
    if (dig.length < 4) { setUcStatus(''); return; }
    setBuscandoUc(true); setUcStatus('');
    try {
      const { data } = await apiClient.get('/api/v1/requisicoes/uc-lookup', { params: { uc: dig } });
      const cands = Array.isArray(data?.ucs_candidatas) ? data.ucs_candidatas : [];
      setCandidatas(cands);
      setProcessos(Array.isArray(data?.processos_existentes) ? data.processos_existentes : []);
      setAlertas(Array.isArray(data?.alertas) ? data.alertas : []);
      setConfirmaDuplicada(false);
      setUcBuscado(dig);
      if (cands.length === 0) {
        setCandidataIdx(null); setUcStatus('vazio');
      } else if (cands.length === 1) {
        setCandidataIdx(0); aplicarCandidata(cands[0]); setUcStatus('ok');
      } else {
        setCandidataIdx(null); setUcStatus('ok'); // multi: exige escolha
      }
    } catch {
      setUcStatus('erro'); setCandidatas([]); setProcessos([]); setAlertas([]);
    } finally {
      setBuscandoUc(false);
    }
  };

  useEffect(() => {
    const dig = String(formData.uc || '').replace(/\D/g, '');
    if (dig.length < 4 || dig === ucBuscado) return;
    const t = setTimeout(() => fazerLookup(dig), 550);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.uc]);

  const escolherCandidata = (idx) => {
    setCandidataIdx(idx);
    aplicarCandidata(candidatas[idx]);
  };

  // período disponível (da candidata escolhida)
  const candidata = candidataIdx != null ? candidatas[candidataIdx] : null;
  const temMultiUC = candidatas.length > 1;
  const temProcesso = processos.length > 0;

  const handleFileChange = (e) => setAnexos((prev) => [...prev, ...Array.from(e.target.files || [])]);
  const removeAnexo = (idx) => {
    setAnexos((prev) => prev.filter((_, i) => i !== idx));
    if (fileInputRef.current) fileInputRef.current.value = '';
  };
  const handlePeriodoChange = (index, event) => {
    const values = [...periodos];
    values[index][event.target.name] = event.target.value;
    setPeriodos(values);
  };
  const handleAddPeriodo = () => setPeriodos([...periodos, { mes: '', ano: '' }]);
  const handleRemovePeriodo = (index) => {
    if (periodos.length > 1) { const v = [...periodos]; v.splice(index, 1); setPeriodos(v); }
  };

  const periodosPreenchidos = useMemo(() => {
    if (periodoAte) return !!(buildMesRef(periodos[0]?.mes, periodos[0]?.ano) && buildMesRef(periodoFim.mes, periodoFim.ano));
    return (periodos || []).some((p) => p.mes && p.ano);
  }, [periodos, periodoAte, periodoFim]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (temMultiUC && candidataIdx == null) return showToast('error', 'Selecione a unidade correta para continuar.');
    if (!formData.uc) return showToast('error', 'Informe a UC.');
    if (!periodosPreenchidos) return showToast('error', 'Informe o período da irregularidade.');
    if (!formData.ressarcimentoEstimado || Number(unformatNumber(formData.ressarcimentoEstimado)) <= 0)
      return showToast('error', 'Informe um valor de ressarcimento válido.');
    if (temProcesso && !confirmaDuplicada)
      return showToast('error', 'Já existem processos para esta UC — confirme que não é duplicada.');

    setIsSubmitting(true);
    const data = new FormData();
    Object.keys(formData).forEach((k) => data.append(k, formData[k]));
    data.append('periodosIrregularidade', JSON.stringify(buildPeriodosList()));
    data.append('RessarcimentoEstimado', formData.ressarcimentoEstimado);
    if (formData.linkFatura) {
      data.append('linksFaturasDetalhes', JSON.stringify([{ link: formData.linkFatura, mes_ref: '' }]));
    }
    anexos.forEach((f) => data.append('anexos', f));
    try {
      const resp = await criarRequisicao(data);
      const reqId = resp?.data?.id;
      showToast('success', reqId ? `Req#${reqId} criada!` : 'Requisição enviada!');
      if (reqId) setCreatedReqId(reqId);
      // reset
      setFormData({ uc: '', cod_empresa: '', cliente: '', razaoSocialFatura: '', concessionaria: '', cnpj: '', enderecoCompleto: '', ressarcimentoEstimado: '', descricaoIrregularidade: '', linkFatura: '' });
      setPeriodos([{ mes: '', ano: '' }]); setPeriodoAte(false); setPeriodoFim({ mes: '', ano: '' });
      setAnexos([]); setCandidatas([]); setCandidataIdx(null); setProcessos([]); setAlertas([]);
      setConfirmaDuplicada(false); setUcStatus(''); setUcBuscado('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch {
      showToast('error', 'Falha ao enviar. Verifique os dados e tente novamente.');
    } finally {
      setIsSubmitting(false);
      if (onClose) onClose();
    }
  };

  // Cores fixas intencionais: identidade visual de cada canal (verde WhatsApp, roxo Teams),
  // não status do tema — convertê-las pra var() faria Email e Teams colidirem na mesma cor.
  const contatosSuporte = [
    { icon: <MessageCircle size={18} />, label: 'WhatsApp', sub: '(15) 99747-7277', href: 'https://wa.me/5515997477277', color: '#16a34a' },
    { icon: <Mail size={18} />, label: 'E-mail', sub: 'complaint@amee.com.br', href: 'mailto:complaint@amee.com.br', color: '#2563eb' },
    { icon: <Users size={16} />, label: 'Luana', sub: 'Teams', href: 'https://teams.microsoft.com/l/chat/0/0?users=luana.nascimento@amee.com.br', color: '#4f46e5' },
    { icon: <Users size={16} />, label: 'Paulo', sub: 'Teams', href: 'https://teams.microsoft.com/l/chat/0/0?users=paulo.passos@amee.com.br', color: '#4f46e5' },
  ];

  const inputCls = 'w-full p-2 border border-[var(--border)] rounded text-[var(--fg)] bg-[var(--panel)]';

  return (
    <div className="cpv2-root" style={{ minHeight: '100vh', padding: '18px 16px' }}>
      {/* Suporte flutuante */}
      <div className="fixed right-4 top-1/2 -translate-y-1/2 z-40 flex flex-col gap-2">
        {contatosSuporte.map((c, i) => (
          <a key={i} href={c.href} target="_blank" rel="noreferrer" title={`${c.label} — ${c.sub}`}
            className="group flex items-center gap-2 text-white rounded-full shadow-lg transition-all duration-200 overflow-hidden w-10 hover:w-44 h-10"
            style={{ background: c.color }}>
            <span className="shrink-0 w-10 h-10 flex items-center justify-center">{c.icon}</span>
            <span className="whitespace-nowrap text-xs font-medium pr-3 opacity-0 group-hover:opacity-100 transition-opacity">
              <span className="block font-semibold leading-tight">{c.label}</span>
              <span className="block opacity-80 leading-tight">{c.sub}</span>
            </span>
          </a>
        ))}
      </div>

      <div style={{ width: '100%' }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 14 }}>Nova Requisição</h1>

        <form onSubmit={handleSubmit}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 340px', gap: 16, alignItems: 'start' }} className="reqform-grid">
            {/* ─────────── COLUNA ESQUERDA: passos ─────────── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

              {/* ① UC */}
              <section className="cpv2-card" style={cardStyle}>
                <div style={stepTitle}>① Unidade consumidora</div>
                <label className="cpv2-detail__label" style={{ marginBottom: 4 }}>UC *</label>
                <div style={{ position: 'relative' }}>
                  <input type="text" inputMode="numeric" name="uc" value={formData.uc} onChange={handleChange}
                    className={inputCls} required placeholder="Digite a UC — os dados são buscados automaticamente" autoFocus />
                  <span style={{ position: 'absolute', right: 10, top: 9 }}>
                    {buscandoUc ? <Loader2 className="animate-spin" size={16} /> : <Search size={16} style={{ opacity: 0.5 }} />}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, marginTop: 5, minHeight: 16 }}>
                  {buscandoUc && <span style={{ opacity: 0.7 }}>Consultando unidade…</span>}
                  {!buscandoUc && ucStatus === 'ok' && <span style={{ color: 'var(--cpv2-success)' }}>Unidade encontrada.</span>}
                  {!buscandoUc && ucStatus === 'vazio' && <span style={{ color: 'var(--cpv2-warning)' }}>Unidade não localizada — preencha os dados manualmente abaixo.</span>}
                  {!buscandoUc && ucStatus === 'erro' && <span style={{ color: 'var(--cpv2-danger)' }}>Falha ao consultar. Tente novamente ou preencha manualmente.</span>}
                </div>

                {/* Alerta A — múltiplas UCs */}
                {temMultiUC && (
                  <div style={{ ...banner, borderColor: 'var(--cpv2-warning)', background: 'var(--cpv2-warning-soft)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, color: 'var(--cpv2-warning)' }}>
                      <AlertTriangle size={15} /> Este número corresponde a mais de uma unidade. Selecione a correta:
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                      {candidatas.map((c, idx) => (
                        <label key={idx} style={{
                          display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 8, cursor: 'pointer',
                          border: `1.5px solid ${candidataIdx === idx ? 'var(--cpv2-brand)' : 'var(--cpv2-border)'}`,
                          background: candidataIdx === idx ? 'var(--cpv2-brand-soft)' : 'var(--cpv2-surface)',
                        }}>
                          <input type="radio" name="candidataUC" checked={candidataIdx === idx} onChange={() => escolherCandidata(idx)} />
                          <span style={{ fontSize: 12.5 }}>
                            <strong>{toStr(c.cliente) || '(sem cliente)'}</strong> · {toStr(c.concessionaria) || '—'} · UC {toStr(c.uc)}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {/* Alerta B — processos existentes */}
                {temProcesso && (
                  <div style={{ ...banner, borderColor: 'var(--cpv2-danger)', background: 'color-mix(in srgb, var(--cpv2-danger) 8%, transparent)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, color: 'var(--cpv2-danger)' }}>
                      <AlertTriangle size={15} /> Já existem processos abertos para esta UC:
                    </div>
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
                      {processos.slice(0, 6).map((p) => (
                        <li key={p.id_requisicao} style={{ marginBottom: 2 }}>
                          <a href={`/processos?req=${p.id_requisicao}`} target="_blank" rel="noreferrer" style={{ color: 'var(--cpv2-brand)' }}>
                            #{p.id_requisicao}
                          </a>{' '}— {toStr(p.status)}{p.tipo === 'processo' ? ' · processo' : ''} <ExternalLink size={10} style={{ display: 'inline', opacity: 0.5 }} />
                        </li>
                      ))}
                    </ul>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 12.5 }}>
                      <input type="checkbox" checked={confirmaDuplicada} onChange={(e) => setConfirmaDuplicada(e.target.checked)} />
                      Confirmo que esta requisição <strong>não</strong> é duplicada.
                    </label>
                  </div>
                )}
              </section>

              {/* ② Dados (editáveis) */}
              <section className="cpv2-card" style={cardStyle}>
                <div style={stepTitle}>② Dados da unidade</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px,1fr))', gap: 10 }}>
                  <Field label="Cliente *"><input name="cliente" value={formData.cliente} onChange={handleChange} className={inputCls} required /></Field>
                  <Field label="Razão social (fatura)"><input name="razaoSocialFatura" value={formData.razaoSocialFatura} onChange={handleChange} className={inputCls} /></Field>
                  <Field label="Distribuidora *"><input name="concessionaria" value={formData.concessionaria} onChange={handleChange} className={inputCls} required /></Field>
                  <Field label="CNPJ"><input name="cnpj" inputMode="numeric" value={formData.cnpj} onChange={handleChange} className={inputCls} placeholder="00.000.000/0000-00" /></Field>
                </div>
                <Field label="Endereço" style={{ marginTop: 10 }}><input name="enderecoCompleto" value={formData.enderecoCompleto} onChange={handleChange} className={inputCls} /></Field>
              </section>

              {/* ③ Período */}
              <section className="cpv2-card" style={cardStyle}>
                <div style={stepTitle}>③ Período da irregularidade *</div>
                {candidata && (candidata.periodo_ini || candidata.periodo_fim) && (
                  <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <CalendarRange size={14} /> Período disponível para esta UC: <strong>{fmtMesRef(candidata.periodo_ini)}</strong> a <strong>{fmtMesRef(candidata.periodo_fim)}</strong>
                  </div>
                )}
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 8 }}>
                  <input type="checkbox" checked={periodoAte} onChange={(e) => setPeriodoAte(e.target.checked)} /> Intervalo (de/até)
                </label>
                {!periodoAte ? (
                  <>
                    {periodos.map((p, index) => (
                      <div key={index} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                        <select name="mes" value={p.mes} onChange={(e) => handlePeriodoChange(index, e)} className={inputCls} required>
                          <option value="">Mês</option>
                          {MESES_PT_BR.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                        </select>
                        <input type="number" name="ano" value={p.ano} onChange={(e) => handlePeriodoChange(index, e)} placeholder="Ano" className={inputCls} required />
                        {periodos.length > 1 && (
                          <button type="button" onClick={() => handleRemovePeriodo(index)} className="cpv2-btn cpv2-btn--sm" style={{ borderColor: 'var(--cpv2-danger)', color: 'var(--cpv2-danger)' }}><X size={14} /></button>
                        )}
                      </div>
                    ))}
                    <button type="button" onClick={handleAddPeriodo} className="cpv2-btn cpv2-btn--sm">+ Adicionar mês</button>
                  </>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <select value={periodos[0]?.mes} onChange={(e) => setPeriodos([{ ...periodos[0], mes: e.target.value }])} className={inputCls} required>
                        <option value="">Mês inicial</option>{MESES_PT_BR.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                      </select>
                      <input type="number" value={periodos[0]?.ano} onChange={(e) => setPeriodos([{ ...periodos[0], ano: e.target.value }])} placeholder="Ano" className={inputCls} required />
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <select value={periodoFim.mes} onChange={(e) => setPeriodoFim((p) => ({ ...p, mes: e.target.value }))} className={inputCls} required>
                        <option value="">Mês final</option>{MESES_PT_BR.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                      </select>
                      <input type="number" value={periodoFim.ano} onChange={(e) => setPeriodoFim((p) => ({ ...p, ano: e.target.value }))} placeholder="Ano" className={inputCls} required />
                    </div>
                  </div>
                )}
                <div style={{ marginTop: 8, fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--cpv2-success)' }}>
                  <CheckCircle2 size={14} /> A fatura de cada mês do período é anexada automaticamente (quando disponível no sistema).
                </div>
              </section>

              {/* ④ Irregularidade */}
              <section className="cpv2-card" style={cardStyle}>
                <div style={stepTitle}>④ Irregularidade</div>
                <Field label="Descrição *"><textarea name="descricaoIrregularidade" value={formData.descricaoIrregularidade} onChange={handleChange} className={inputCls} rows={4} required /></Field>
                <Field label="Ressarcimento estimado (R$) *" style={{ marginTop: 10 }}>
                  <input type="text" inputMode="decimal" name="ressarcimentoEstimado" value={formData.ressarcimentoEstimado} onChange={handleChange} className={inputCls} required placeholder="0,00" />
                  <div style={{ fontSize: 11.5, opacity: 0.7, marginTop: 3 }}>{formatMoneyBR(formData.ressarcimentoEstimado) || 'R$ 0,00'}</div>
                </Field>
                <Field label="Anexos adicionais (opcional)" style={{ marginTop: 10 }}>
                  <input ref={fileInputRef} type="file" onChange={handleFileChange} multiple
                    className="w-full text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:font-semibold" />
                  {anexos.length > 0 && (
                    <ul style={{ marginTop: 8, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {anexos.map((f, idx) => (
                        <li key={`${f.name}-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <FileText size={14} style={{ opacity: 0.7 }} />
                          <span style={{ maxWidth: '55%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.name}>{f.name}</span>
                          <span style={{ opacity: 0.6 }}>({(f.size / 1024).toFixed(0)} KB)</span>
                          <button type="button" onClick={() => removeAnexo(idx)} style={{ marginLeft: 'auto', fontSize: 12, textDecoration: 'underline', color: 'var(--cpv2-danger)' }}>remover</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </Field>
              </section>
            </div>

            {/* ─────────── COLUNA DIREITA: resumo da UC (sticky) ─────────── */}
            <aside className="cpv2-card reqform-aside" style={{ ...cardStyle, position: 'sticky', top: 16 }}>
              <div style={stepTitle}>Resumo da unidade</div>
              {!formData.uc && <div style={{ fontSize: 12.5, opacity: 0.6 }}>Digite a UC para carregar os dados.</div>}
              {formData.uc && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <ResumoLinha icon={<Building2 size={14} />} label="Empresa" value={formData.cod_empresa ? `#${formData.cod_empresa}` : (candidata ? '—' : '')} />
                  <ResumoLinha icon={<User size={14} />} label="Cliente" value={formData.cliente} />
                  <ResumoLinha icon={<Zap size={14} />} label="Distribuidora" value={formData.concessionaria} />
                  <ResumoLinha icon={<FileText size={14} />} label="CNPJ" value={formData.cnpj} />
                  <ResumoLinha icon={<MapPin size={14} />} label="Endereço" value={formData.enderecoCompleto} />
                  {candidata && <ResumoLinha icon={<CalendarRange size={14} />} label="Período disponível" value={(candidata.periodo_ini || candidata.periodo_fim) ? `${fmtMesRef(candidata.periodo_ini)} – ${fmtMesRef(candidata.periodo_fim)}` : ''} />}
                  {formData.linkFatura && (
                    <a href={formData.linkFatura} target="_blank" rel="noreferrer" className="cpv2-btn cpv2-btn--sm" style={{ justifyContent: 'center' }}>
                      <ExternalLink size={13} /> Ver última fatura
                    </a>
                  )}
                </div>
              )}
            </aside>
          </div>

          {/* Rodapé fixo */}
          <div style={{
            position: 'sticky', bottom: 0, marginTop: 16, padding: '12px 14px', borderRadius: 10,
            background: 'var(--cpv2-surface)', border: '1px solid var(--cpv2-border)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            boxShadow: '0 -6px 20px -12px rgba(0,0,0,0.25)',
          }}>
            <div style={{ fontSize: 12.5, opacity: 0.8 }}>
              {formData.cliente ? <>Cliente: <strong>{formData.cliente}</strong></> : 'Preencha a UC e o período'}
              {formData.ressarcimentoEstimado ? <> · {formatMoneyBR(formData.ressarcimentoEstimado)}</> : null}
            </div>
            <button type="submit" disabled={isSubmitting} className="cpv2-btn cpv2-btn--primary" style={{ minWidth: 200, justifyContent: 'center' }}>
              {isSubmitting ? 'Enviando…' : 'Enviar requisição'}
            </button>
          </div>
        </form>
      </div>

      <Toast open={toast.open} type={toast.type} message={toast.text} onClose={() => setToast((t) => ({ ...t, open: false }))} />

      {createdReqId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setCreatedReqId(null)} />
          <div className="relative w-full max-w-md bg-[var(--panel)] border border-[var(--border)] rounded-lg shadow-xl p-5 text-[var(--fg)]">
            <div className="text-lg font-bold mb-2">Requisição criada</div>
            <div className="text-sm opacity-80">Req#{createdReqId} criada com sucesso. A fatura do período é anexada automaticamente.</div>
            <div className="mt-4 flex justify-end">
              <button type="button" className="cpv2-btn cpv2-btn--primary" onClick={() => setCreatedReqId(null)}>Ok</button>
            </div>
          </div>
        </div>
      )}

      {isSubmitting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" />
          <div className="relative w-full max-w-sm bg-[var(--panel)] border border-[var(--border)] rounded-lg shadow-xl p-5 text-center text-[var(--fg)]">
            <div className="inline-flex items-center gap-2 text-lg font-semibold"><Clock className="animate-spin" size={18} /> Aguarde</div>
            <div className="text-xs opacity-70 mt-2">Criando requisição…</div>
          </div>
        </div>
      )}

      <style>{`
        @media (max-width: 900px){ .reqform-grid{ grid-template-columns: 1fr !important; } .reqform-aside{ position: static !important; order: -1; } }
      `}</style>
    </div>
  );
};

const cardStyle = { background: 'var(--cpv2-surface)', border: '1px solid var(--cpv2-border)', borderRadius: 12, padding: '14px 16px' };
const stepTitle = { fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--cpv2-brand)', marginBottom: 10 };
const banner = { marginTop: 10, padding: '10px 12px', borderRadius: 8, border: '1.5px solid' };

function Field({ label, children, style }) {
  return (
    <div style={style}>
      <label className="cpv2-detail__label" style={{ display: 'block', marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}
function ResumoLinha({ icon, label, value }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.3, color: 'var(--cpv2-text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>{icon} {label}</div>
      <div style={{ fontSize: 13.5, fontWeight: 600, wordBreak: 'break-word', minHeight: 18 }}>{value || <span style={{ opacity: 0.4, fontWeight: 400 }}>—</span>}</div>
    </div>
  );
}

export default RequisicaoForm;
