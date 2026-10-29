import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/apiClient';
import './ocrLote.css';

const CHUNK = 30;         // faz upload em lotes de 30
const LIMITE = 300;
const POLL_MS = 2500;

const fmtTime = (s) => {
  const m = Math.floor(s / 60), ss = s % 60;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};
const fmtSize = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

function DetailBox({ titulo, campos }) {
  const vis = campos.filter(([, v]) => v != null && v !== '');
  if (!vis.length) return null;
  return (
    <div className="ocl-detail-box">
      <div className="ocl-detail-tit">{titulo}</div>
      {vis.map(([k, v]) => (
        <div className="ocl-kv" key={k}><span className="k">{k}</span><span className="v">{String(v)}</span></div>
      ))}
    </div>
  );
}

export default function OcrLote() {
  const navigate = useNavigate();
  const [files, setFiles] = useState([]);          // File[]
  const [phase, setPhase] = useState('idle');       // idle|uploading|processing|done|error
  const [jobId, setJobId] = useState(null);
  const [status, setStatus] = useState(null);       // {total, prontas, erros, estado, etapa}
  const [uploaded, setUploaded] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [report, setReport] = useState(null);       // []
  const [metrics, setMetrics] = useState(null);
  const [erro, setErro] = useState('');
  const [drag, setDrag] = useState(false);
  const [expandido, setExpandido] = useState(null);
  const [cruzarBanco, setCruzarBanco] = useState(false);
  const [dbCruz, setDbCruz] = useState({});   // numero_instalacao -> { encontrada, cliente_confere, n, fichas[], por_mes[] }
  const [cruzando, setCruzando] = useState(false);
  const cruzarRef = useRef(false);

  const timerRef = useRef(null);
  const pollRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => () => { clearInterval(timerRef.current); clearInterval(pollRef.current); }, []);

  const addFiles = useCallback((list) => {
    const novos = Array.from(list).filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.name + f.size));
      return [...prev, ...novos.filter((f) => !seen.has(f.name + f.size))];
    });
  }, []);

  const onDrop = (e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer?.files) addFiles(e.dataTransfer.files); };

  const passarOCR = async () => {
    if (!files.length) return;
    setErro(''); setReport(null); setMetrics(null); setDbCruz({}); setPhase('uploading'); setUploaded(0);
    cruzarRef.current = cruzarBanco;
    try {
      let job = null;
      for (let i = 0; i < files.length; i += CHUNK) {
        const fd = new FormData();
        files.slice(i, i + CHUNK).forEach((f) => fd.append('files', f));
        if (job) fd.append('job_id', job);
        const { data } = await api.post('/ocr-lote/upload', fd);
        job = data.job_id;
        setUploaded(Math.min(files.length, i + CHUNK));
      }
      setJobId(job);
      await api.post(`/ocr-lote/run/${job}`);
      // cronômetro + polling
      setPhase('processing'); setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
      pollRef.current = setInterval(() => pollStatus(job), POLL_MS);
      pollStatus(job);
    } catch (e) {
      setErro(e?.response?.data?.error || e.message || 'falha no upload/execução');
      setPhase('error');
    }
  };

  const pollStatus = async (job) => {
    try {
      const { data } = await api.get(`/ocr-lote/status/${job}`);
      setStatus(data);
      if (data.estado === 'concluido') {
        clearInterval(timerRef.current); clearInterval(pollRef.current);
        const [rel, met] = await Promise.all([
          api.get(`/ocr-lote/relatorio/${job}`).then((r) => r.data).catch(() => []),
          api.get(`/ocr-lote/relatorio/${job}?tipo=metricas`).then((r) => r.data).catch(() => null),
        ]);
        const relArr = Array.isArray(rel) ? rel : [];
        setReport(relArr); setMetrics(met); setPhase('done');
        if (cruzarRef.current) cruzarFDE(relArr);
      } else if (data.estado === 'erro') {
        clearInterval(timerRef.current); clearInterval(pollRef.current);
        setErro(data.erro || 'erro no processamento'); setPhase('error');
      }
    } catch { /* silêncio: próxima iteração tenta de novo */ }
  };

  // "Encaminhar → Passar no OCR Inteligente": chega aqui com ?unidade= (ou ?job=).
  // O cronômetro começa NA HORA e a tela mostra "inserindo faturas…", como se o analista
  // tivesse subido os PDFs — enquanto o backend baixa as faturas da unidade e roda o job.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const j = params.get('job');
    const unidade = params.get('unidade');
    const empresa = params.get('empresa') || '';
    if (j) {
      setJobId(j);
      setPhase('processing'); setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
      pollRef.current = setInterval(() => pollStatus(j), POLL_MS);
      pollStatus(j);
      return;
    }
    if (unidade) {
      setPhase('processing'); setElapsed(0);
      setStatus({ estado: 'processando', etapa: 'inserindo faturas da unidade…', total: 0, prontas: 0, erros: 0 });
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
      (async () => {
        try {
          const r = await api.post('/faturas/ocr-lote-from-unidade', null, { params: { inst: unidade, empresa } });
          const job = r.data?.job_id;
          if (!job) throw new Error('job não criado');
          setJobId(job);
          await api.post(`/ocr-lote/run/${job}`);
          pollRef.current = setInterval(() => pollStatus(job), POLL_MS);
          pollStatus(job);
        } catch (e) {
          clearInterval(timerRef.current); clearInterval(pollRef.current);
          setErro(e?.response?.data?.error || e.message || 'falha ao preparar OCR da unidade');
          setPhase('error');
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cruza cada UC (numero_instalacao) com o FDE: motor F01-F05 ao vivo + match de cliente.
  const cruzarFDE = async (rel) => {
    const norm = (s) => (s || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const insts = [...new Set(rel.map((r) => r.dados?.cadastro?.numero_instalacao).filter(Boolean))];
    const acc = {};
    setCruzando(true);
    await Promise.all(insts.map(async (inst) => {
      try {
        const { data } = await api.get(`/ocr-lote/cruzar-fde?instalacao=${encodeURIComponent(inst)}`);
        if (!data?.encontrada) { acc[inst] = { encontrada: false }; return; }
        const pipeRazao = rel.find((r) => r.dados?.cadastro?.numero_instalacao === inst)?.dados?.cadastro?.razao_social;
        const pr = norm(pipeRazao); const br = norm(data.razao_social);
        const confere = (!pr || !br) ? null : (br.includes(pr.slice(0, 12)) || pr.includes(br.slice(0, 12)));
        acc[inst] = {
          encontrada: true, n: data.n, cliente_confere: confere, razao: data.razao_social,
          fichas: data.fichas || [], por_mes: (data.por_mes || []).filter((p) => (p.fichas || []).length),
        };
      } catch {
        acc[inst] = { encontrada: false, erro: true };
      }
    }));
    setDbCruz(acc); setCruzando(false);
  };

  const resetar = () => {
    clearInterval(timerRef.current); clearInterval(pollRef.current);
    setFiles([]); setPhase('idle'); setJobId(null); setStatus(null);
    setReport(null); setMetrics(null); setErro(''); setElapsed(0); setUploaded(0); setDbCruz({});
  };

  const baixar = (tipo) => {
    if (!report) return;
    let blob, nome;
    if (tipo === 'json') {
      blob = new Blob([JSON.stringify(report, null, 1)], { type: 'application/json' });
      nome = `${jobId}_relatorio.json`;
    } else {
      const head = ['arquivo', 'mes', 'distribuidora', 'razao_social', 'cnpj', 'instalacao', 'num_cliente',
        'medidor', 'classe', 'subgrupo', 'modalidade', 'vencimento', 'emissao', 'nf_numero', 'bandeira',
        'leit_anterior', 'leit_atual', 'constante', 'consumo', 'consumo_medido', 'dias',
        'valor_total', 'icms_base', 'icms_valor', 'pis', 'cofins', 'gd', 'gd_injetada_kwh', 'gd_compensada_kwh',
        'fichas', 'interpretacao', 'itens', 'historico'];
      const clean = (v) => (v == null ? '' : String(v).replace(/[\r\n;]+/g, ' '));
      const linhas = [head.join(';')];
      report.forEach((r) => {
        const n = r.normalizado || {}, d = r.dados || {}, c = d.cadastro || {}, doc = d.documento || {},
          m = d.medicao || {}, t = d.tributos || {}, g = d.gd || {};
        const itensStr = (r.itens || []).map((it) => `${it.descricao}=${it.valor}`).join(' | ');
        const histStr = (d.historico || []).map((h) => `${h.mes}/${String(h.ano || '').slice(-2)}:${h.consumo_kwh}`).join(' | ');
        linhas.push([
          r.arquivo, doc.mes_referencia || r.mes, n.distribuidora, c.razao_social, c.cnpj_cliente,
          c.numero_instalacao, c.numero_cliente, c.medidor, c.classe, c.subgrupo, c.modalidade,
          doc.vencimento, doc.emissao, doc.nf_numero, d.bandeira,
          m.leit_anterior, m.leit_atual, m.constante, n.consumo, m.consumo_medido, m.dias,
          n.valor_total, t.icms?.base, t.icms?.valor, t.pis?.valor, t.cofins?.valor,
          n.gd, g.injetada_kwh, g.compensada_kwh,
          (r.fichas || []).join('|'), r.interpretacao, itensStr, histStr,
        ].map(clean).join(';'));
      });
      blob = new Blob(['﻿' + linhas.join('\n')], { type: 'text/csv;charset=utf-8' });
      nome = `${jobId}_relatorio.csv`;
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = nome; a.click();
  };

  const total = status?.total ?? files.length;
  const prontas = phase === 'uploading' ? uploaded : (status?.prontas ?? 0);
  const pct = total ? Math.round((prontas / total) * 100) : 0;
  const excedeu = files.length > LIMITE;

  return (
    <main className="cpv2-page ocl-wrap">
      <div className="ocl-head">
        <div>
          <button className="ocl-back" onClick={() => navigate('/analise-desvio')}>← Auditoria de Faturas</button>
          <h1 className="ocl-title">OCR Inteligente</h1>
          <div className="ocl-sub">Auditoria de faturas em lote — nosso OCR extrai, a IA normaliza, o motor aponta F01–F05. Até {LIMITE} PDFs por vez.</div>
        </div>
      </div>

      {/* IDLE / UPLOAD */}
      {phase === 'idle' && (
        <>
          <div
            className={`ocl-drop${drag ? ' drag' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
          >
            <div style={{ fontSize: 34 }}>📄⚡</div>
            <h3>Arraste os PDFs aqui</h3>
            <p>ou clique para selecionar — pode subir 30, 30, 30… até {LIMITE}. Nada roda até você clicar em <b>Passar OCR</b>.</p>
            <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple hidden
              onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          </div>

          {files.length > 0 && (
            <div className="ocl-panel">
              <div className="ocl-bar">
                <div className="ocl-count">
                  <b>{files.length}</b> fatura{files.length !== 1 ? 's' : ''} na fila
                  {excedeu && <span className="ocl-warn"> · acima do limite de {LIMITE}</span>}
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <label className="ocl-flag" title="Para cada UC, cruza com o banco (FDE): roda o motor F01–F05 ao vivo sobre o histórico da unidade e confere o cliente.">
                    <input type="checkbox" checked={cruzarBanco} onChange={(e) => setCruzarBanco(e.target.checked)} />
                    🔎 Cruzar com o banco (FDE)
                  </label>
                  <button className="ocl-btn-ghost" onClick={resetar}>Limpar</button>
                  <button className="ocl-btn-primary" onClick={passarOCR} disabled={excedeu}>⚡ Passar OCR</button>
                </div>
              </div>
              <div className="ocl-files">
                {files.map((f, i) => (
                  <div className="ocl-file" key={f.name + i}>
                    <span className="nm">{f.name}</span>
                    <span className="sz">{fmtSize(f.size)}</span>
                    <span className="ocl-chip fila">na fila</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* PROCESSING — assinatura: cronômetro + progresso */}
      {(phase === 'uploading' || phase === 'processing') && (
        <div className="ocl-panel">
          <div className="ocl-console">
            <div className="ocl-timer">
              {fmtTime(elapsed)}
              <span className="lbl">{phase === 'uploading' ? 'enviando' : 'processando'}</span>
            </div>
            <div className="ocl-prog">
              <div className="top">
                <span>{phase === 'uploading' ? 'Upload das faturas' : 'OCR + normalização + motor'}</span>
                <span className="pct">{pct}%</span>
              </div>
              <div className="ocl-track"><div className="ocl-fill" style={{ width: `${Math.max(4, pct)}%` }} /></div>
              <div className="ocl-etapa">
                {prontas}/{total} faturas{status?.erros ? ` · ${status.erros} com erro` : ''}
                {status?.etapa ? ` · ${status.etapa.replace(/_/g, ' ')}` : ''}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ERRO */}
      {phase === 'error' && (
        <div className="ocl-panel">
          <div style={{ color: 'var(--danger)', fontWeight: 700, marginBottom: 6 }}>Não foi possível concluir.</div>
          <div style={{ fontSize: 13, opacity: .8 }}>{erro}</div>
          <div style={{ marginTop: 14 }}><button className="ocl-btn-ghost" onClick={resetar}>Recomeçar</button></div>
        </div>
      )}

      {/* DONE — relatório */}
      {phase === 'done' && report && (
        <>
          {metrics && (
            <div className="ocl-panel">
              <div className="ocl-metrics">
                <div className="ocl-metric"><div className="v">{metrics.total}</div><div className="k">faturas</div></div>
                <div className="ocl-metric"><div className="v">{metrics.faturas_com_ficha ?? 0}</div><div className="k">com apontamento</div></div>
                <div className="ocl-metric"><div className="v">{metrics.pct_coerencia ?? '—'}%</div><div className="k">coerência (soma=total)</div></div>
                <div className="ocl-metric"><div className="v">{metrics.ocr_necessario ?? 0}</div><div className="k">precisaram OCR</div></div>
                <div className="ocl-metric"><div className="v">{fmtTime(Math.round(metrics.tempo_s || elapsed))}</div><div className="k">tempo</div></div>
                {metrics.fichas && Object.entries(metrics.fichas).map(([k, v]) => (
                  <div className="ocl-metric" key={k}><div className="v">{v}</div><div className="k">{k}</div></div>
                ))}
              </div>
            </div>
          )}

          <div className="ocl-bar">
            <div className="ocl-count">Relatório de <b>{report.length}</b> faturas</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="ocl-btn-ghost" onClick={() => baixar('csv')}>Baixar CSV</button>
              <button className="ocl-btn-ghost" onClick={() => baixar('json')}>Baixar JSON</button>
              <button className="ocl-btn-primary" onClick={resetar}>Novo lote</button>
            </div>
          </div>

          <div className="ocl-hint">Clique numa fatura para ver todos os dados extraídos (cadastro, medição, tributos, GD e itens).</div>
          <div className="ocl-scroll">
            <table className="ocl-table">
              <thead>
                <tr><th></th><th>Fatura</th><th>Mês</th><th>Distribuidora</th><th>Instalação</th><th>Consumo</th><th>Total (R$)</th><th>GD</th><th>Apontamentos</th></tr>
              </thead>
              <tbody>
                {report.map((r, i) => {
                  const n = r.normalizado || {}; const d = r.dados || {};
                  const cad = d.cadastro || {}; const aberto = expandido === i;
                  return (
                    <React.Fragment key={r.arquivo + i}>
                      <tr className="ocl-row" onClick={() => setExpandido(aberto ? null : i)}>
                        <td className="ocl-caret">{aberto ? '▾' : '▸'}</td>
                        <td style={{ maxWidth: 210, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {r._erro ? <span style={{ color: 'var(--danger)' }}>⚠ {r.arquivo}</span> : r.arquivo}
                        </td>
                        <td>{d.documento?.mes_referencia || r.mes || '—'}</td>
                        <td>{n.distribuidora || '—'}</td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {cad.numero_instalacao || '—'}
                          {dbCruz[cad.numero_instalacao]?.encontrada && (
                            <span className="ocl-db-badge" title={`No banco (FDE): ${dbCruz[cad.numero_instalacao].n} fatura(s)`}> 🔎</span>
                          )}
                        </td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>{n.consumo != null ? Number(n.consumo).toLocaleString('pt-BR') : '—'}</td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>{n.valor_total != null ? Number(n.valor_total).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '—'}</td>
                        <td>{n.gd ? 'sim' : '—'}</td>
                        <td>
                          {(r.fichas || []).length
                            ? r.fichas.map((f) => <span className="ocl-ficha" key={f}>{f}</span>)
                            : <span style={{ opacity: .4 }}>—</span>}
                        </td>
                      </tr>
                      {aberto && (
                        <tr className="ocl-detail-row">
                          <td colSpan={9}>
                            <div className="ocl-detail">
                              {r.interpretacao && <div className="ocl-interp-box"><b>Análise:</b> {r.interpretacao}</div>}
                              <div className="ocl-detail-grid">
                                <DetailBox titulo="Cadastro" campos={[
                                  ['Razão social', cad.razao_social], ['CNPJ', cad.cnpj_cliente],
                                  ['Instalação', cad.numero_instalacao], ['Nº cliente', cad.numero_cliente],
                                  ['Medidor', cad.medidor], ['Classe', cad.classe],
                                  ['Subgrupo', cad.subgrupo], ['Modalidade', cad.modalidade],
                                  ['Endereço', cad.endereco], ['Bairro', cad.bairro],
                                ]} />
                                <DetailBox titulo="Documento" campos={[
                                  ['Mês ref.', d.documento?.mes_referencia], ['Vencimento', d.documento?.vencimento],
                                  ['Emissão', d.documento?.emissao], ['NF nº', d.documento?.nf_numero],
                                  ['Série', d.documento?.nf_serie], ['Bandeira', d.bandeira],
                                  ['Chave', d.documento?.chave_acesso],
                                ]} />
                                <DetailBox titulo="Medição" campos={[
                                  ['Medidor', d.medicao?.medidor], ['Leit. anterior', d.medicao?.leit_anterior],
                                  ['Leit. atual', d.medicao?.leit_atual], ['Constante', d.medicao?.constante],
                                  ['Consumo medido', d.medicao?.consumo_medido], ['Dias', d.medicao?.dias],
                                  ['Próx. leitura', d.medicao?.proxima_leitura],
                                ]} />
                                <DetailBox titulo="Tributos" campos={[
                                  ['ICMS base', d.tributos?.icms?.base], ['ICMS valor', d.tributos?.icms?.valor],
                                  ['PIS valor', d.tributos?.pis?.valor], ['COFINS valor', d.tributos?.cofins?.valor],
                                ]} />
                                {d.gd?.tem_gd && (
                                  <DetailBox titulo="Geração distribuída" campos={[
                                    ['Injetada (kWh)', d.gd?.injetada_kwh], ['Compensada (kWh)', d.gd?.compensada_kwh],
                                    ['Saldo FP (kWh)', d.gd?.saldo_fora_ponta_kwh], ['Classificação', d.gd?.classificacao],
                                    ['Lei', d.gd?.lei],
                                  ]} />
                                )}
                              </div>
                              {(cruzando || Object.keys(dbCruz).length > 0) && (
                                <div className="ocl-db-box">
                                  {(() => {
                                    const db = dbCruz[cad.numero_instalacao];
                                    if (!db) return <span className="ocl-db-msg">🔎 {cruzando ? 'cruzando com o banco (FDE)…' : '—'}</span>;
                                    if (!db.encontrada) return <span className="ocl-db-msg">🔎 UC <b>{cad.numero_instalacao}</b> não encontrada no banco (FDE).</span>;
                                    return (<>
                                      <div className="ocl-db-msg">🔎 UC <b>{cad.numero_instalacao}</b> encontrada no banco — <b>{db.n}</b> fatura(s) analisada(s) pelo motor{db.cliente_confere === true ? ', cliente confere ✓' : db.cliente_confere === false ? ' — ⚠ cliente diferente' : ''}.</div>
                                      {db.fichas.length > 0
                                        ? <div style={{ marginTop: 4 }}>Fichas do motor (FDE): {db.fichas.map((f) => <span className="ocl-ficha" key={f}>{f}</span>)}</div>
                                        : <div style={{ marginTop: 4, opacity: .6 }}>Sem apontamento do motor no histórico dessa UC.</div>}
                                      {db.por_mes?.some((p) => p.fichas.length) && (
                                        <table className="ocl-itens-tb" style={{ marginTop: 6 }}>
                                          <thead><tr><th>Mês (FDE)</th><th>Fichas do motor</th></tr></thead>
                                          <tbody>{db.por_mes.filter((p) => p.fichas.length).map((p, k) => <tr key={k}><td>{p.mes || '—'}</td><td>{p.fichas.join(', ')}</td></tr>)}</tbody>
                                        </table>
                                      )}
                                    </>);
                                  })()}
                                </div>
                              )}
                              {(r.itens || []).length > 0 && (
                                <div className="ocl-itens">
                                  <div className="ocl-itens-tit">Itens da fatura ({r.itens.length})</div>
                                  <table className="ocl-itens-tb">
                                    <thead><tr><th>Descrição</th><th>Un.</th><th>Qtd</th><th>Tarifa</th><th>Valor (R$)</th></tr></thead>
                                    <tbody>
                                      {r.itens.map((it, j) => (
                                        <tr key={j}>
                                          <td>{it.descricao}{it.credito_gd ? ' 🌱' : ''}</td>
                                          <td>{it.unidade || '—'}</td>
                                          <td style={{ fontVariantNumeric: 'tabular-nums' }}>{it.qtd != null ? Number(it.qtd).toLocaleString('pt-BR') : '—'}</td>
                                          <td style={{ fontVariantNumeric: 'tabular-nums' }}>{it.tarifa != null ? it.tarifa : '—'}</td>
                                          <td style={{ fontVariantNumeric: 'tabular-nums', color: (it.valor < 0 ? 'var(--success)' : 'inherit') }}>{it.valor != null ? Number(it.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '—'}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                              {(d.historico || []).length > 0 && (
                                <div className="ocl-itens">
                                  <div className="ocl-itens-tit">Histórico de consumo ({d.historico.length} meses)</div>
                                  <table className="ocl-itens-tb">
                                    <thead><tr><th>Mês/Ano</th><th>Consumo (kWh)</th><th>Dias</th></tr></thead>
                                    <tbody>
                                      {d.historico.map((h, k) => (
                                        <tr key={k}>
                                          <td>{h.mes}{h.ano ? `/${String(h.ano).slice(-2)}` : ''}</td>
                                          <td style={{ fontVariantNumeric: 'tabular-nums' }}>{h.consumo_kwh != null ? Number(h.consumo_kwh).toLocaleString('pt-BR') : '—'}</td>
                                          <td style={{ fontVariantNumeric: 'tabular-nums' }}>{h.dias ?? '—'}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
