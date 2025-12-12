// src/pages/Ocr.jsx
import React, { useEffect, useMemo, useState, useRef } from 'react';
import { UploadCloud, X, Sparkles } from 'lucide-react';
import { ocrAnalyze, ocrChat, ocrQuick, ocrInterpret } from '@services/ocrService.js';
import { interpretRule } from '@services/rulesService.js';

export default function Ocr() {
  // Seleção de arquivos e parâmetros
  const [files, setFiles] = useState([]);
  const [instruction, setInstruction] = useState('');
  const [ruleICMS, setRuleICMS] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  // Semáforo anti-duplo clique para IA (evita 429)
  const [busy, setBusy] = useState(false);

  // Entrada por links (URLs)
  const [linkInput, setLinkInput] = useState('');

  // Tabela e debug
  const [rows, setRows] = useState([]); // histórico cumulativo (novas no topo)
  const [lastRawResults, setLastRawResults] = useState([]);
  const [sourceByName, setSourceByName] = useState({}); // filename -> source URL (quando veio de link)
  const [aiView, setAiView] = useState({}); // id -> { open, loading, text, error }
  const [progress, setProgress] = useState(0);
  const progressRef = useRef(null);

  const canAnalyze = useMemo(() => files.length > 0 && !analyzing, [files, analyzing]);

  // Handlers de arquivos
  const addFiles = (list) => {
    const next = [...files];
    for (const f of list) {
      if (f && f.size > 0) next.push(f);
    }
    setFiles(next);
  };
  const onDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const f = Array.from(e.dataTransfer.files || []).filter(Boolean);
    addFiles(f);
  };
  const onPick = (e) => addFiles(Array.from(e.target.files || []));
  const removeFile = (idx) => setFiles((prev) => prev.filter((_, i) => i !== idx));

  // Adiciona arquivos a partir de URLs (CORS deve permitir)
  const addLinks = async () => {
    const lines = (linkInput || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.length) return;

    const newFiles = [];
    const nameToUrl = {};
    for (const url of lines) {
      try {
        const resp = await fetch(url, { credentials: 'omit' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        const u = new URL(url, window.location.href);
        let name = decodeURIComponent(u.pathname.split('/').pop() || 'fatura');
        if (!/\.(pdf|png|jpe?g)$/i.test(name)) {
          const ct = (resp.headers.get('content-type') || '').toLowerCase();
          if (ct.includes('pdf')) name += '.pdf';
          else if (ct.includes('png')) name += '.png';
          else if (ct.includes('jpeg') || ct.includes('jpg')) name += '.jpg';
        }
        const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
        nameToUrl[name] = url;
        newFiles.push(file);
      } catch (e) {
        console.warn('Falha ao buscar link OCR:', url, e);
      }
    }
    if (newFiles.length) {
      setFiles((prev) => [...prev, ...newFiles]);
      setSourceByName((prev) => ({ ...prev, ...nameToUrl }));
      setLinkInput('');
    }
  };

  // Helpers de formatação
  const fmtNum = (v) =>
    typeof v === 'number'
      ? v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3 })
      : v ?? '-';
  const simNao = (b) => (b === true ? 'Sim' : b === false ? 'Não' : '-');

  // Mapeia 1 resultado em 1 linha de tabela
  const mapResultToRow = (res, requestId = null) => {
    const rr = res?.rule_results || {};
    const meta = rr.META || {};
    const b = rr.BANDEIRA_ENEL_SP_GB || {};
    return {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      arquivo: res?.file_name || res?.FileName || '',
      numeroCliente: meta?.numero_cliente || '',
      uc: meta?.unidade_consumidora || '',
      referencia: meta?.referencia || '09/2024',
      elegivel: b?.elegivel,
      bandeiraLida: b?.bandeira_lida || '',
      diasMes: b?.dias_mes ?? null,
      diasTotal: b?.dias_total ?? null,
      tusdKwh: b?.tusd_quant_kwh ?? null,
      valorBandeira: b?.bandeira_valor_rs ?? null,
      valorCalc4463: b?.valor_calc_4_463 ?? null,
      valorCalc7877: b?.valor_calc_7_877 ?? null,
      bandeiraIncorreta: b?.bandeira_incorreta ?? null,
      diferencaPara4463: b?.diferenca_para_4_463 ?? null,
      issues: b?.issues || [],
      sourceUrl: sourceByName[res?.file_name || res?.FileName || ''] || null,
      createdAt: new Date().toISOString(),
      rawOriginal: res,
      requestId: requestId || res?.request_id || null, // Store request_id for later interpretation
      rawText: res?.raw_text || null, // Store raw OCR text
      interpreted: !!(rr && Object.keys(rr).length > 0), // Flag indicating if rules were applied
    };
  };

  // Stage 1: OCR Rápido (apenas extração de texto)
  const analyzeQuick = async () => {
    if (!canAnalyze) return;
    setAnalyzing(true);
    try {
      const response = await ocrQuick(files);
      const requestId = response?.request_id;
      const results = response?.results || [];

      // Cria linhas básicas (sem interpretação ainda)
      const newRows = results.map((res) => mapResultToRow(res, requestId));
      setLastRawResults(results);
      setRows((prev) => [...newRows, ...prev]);
      setFiles([]); // limpa seleção após envio
    } catch (e) {
      setLastRawResults([{ error: String(e) }]);
      alert(`Erro no OCR: ${e.message || e}`);
    } finally {
      setAnalyzing(false);
    }
  };

  // Stage 2: Interpretação com IA (aplica regras ao texto OCR salvo)
  const interpretWithAI = async (row) => {
    if (!row.requestId || !row.arquivo) {
      alert('Dados insuficientes para interpretação. Execute o OCR primeiro.');
      return;
    }

    const id = row.id;
    if (busy) return; // anti-duplo-clique
    setBusy(true);
    setAiView((prev) => ({ ...prev, [id]: { open: true, loading: true, text: '', error: '' } }));

    try {
      const rules = ['BANDEIRA_ENEL_SP_GB'];
      if (ruleICMS) rules.push('ICMS');

      const result = await ocrInterpret(row.requestId, row.arquivo, rules, false);

      // Atualiza a linha na tabela com os resultados interpretados
      const updatedRow = mapResultToRow({
        file_name: result.filename,
        rule_results: result.rule_results,
        raw_text: row.rawText,
        request_id: row.requestId,
      }, row.requestId);

      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...updatedRow } : r)));
      setAiView((prev) => ({ ...prev, [id]: { open: false, loading: false, text: '', error: '' } }));
    } catch (e) {
      const msg = String(e || '');
      const hint = /429/.test(msg)
        ? 'Muitas requisições. Aguarde alguns segundos.'
        : 'Falha ao interpretar com a IA.';
      setAiView((prev) => ({ ...prev, [id]: { open: true, loading: false, text: '', error: `${hint} ${msg}` } }));
    } finally {
      setBusy(false);
    }
  };

  // Mantém função legacy para compatibilidade (usa full OCR)
  const analyze = async () => {
    if (!canAnalyze) return;
    setAnalyzing(true);
    try {
      const rules = ['BANDEIRA_ENEL_SP_GB'];
      if (ruleICMS) rules.push('ICMS');
      const results = await ocrAnalyze(files, instruction, {
        useLocalRules: true,
        rules,
        lang: 'por+eng',
        max_pages: 3,
      });
      const newRows = (results || []).map(mapResultToRow);
      setLastRawResults(results || []);
      setRows((prev) => [...newRows, ...prev]);
      setFiles([]); // limpa seleção após envio
    } catch (e) {
      setLastRawResults([{ error: String(e) }]);
    } finally {
      setAnalyzing(false);
    }
  };

  // Interpretação por IA com semáforo (usa /ocr/chat com backoff no backend)
  const interpretRow = async (row) => {
    const id = row.id;
    if (busy) return; // guarda-chuva anti-duplo-clique (evita 429)
    setBusy(true);
    setAiView((prev) => ({ ...prev, [id]: { open: true, loading: true, text: '', error: '' } }));
    try {
      const prompt = `Você é um assistente que interpreta JSON de OCR de faturas de energia.
Apresente as informações relevantes em uma tabela (Markdown) com duas colunas: Campo | Valor.
Inclua, quando presentes: Arquivo, Número do cliente, Unidade Consumidora, Referência, Bandeira, Dias mês, Dias total, kWh TUSD, Valor Bandeira (R$), Calc 4,463, Calc 7,877, Bandeira incorreta.
Se houver outros campos úteis no JSON, inclua também.
Use pt-BR e números com vírgula como separador decimal.

JSON:\n\n${JSON.stringify(row.rawOriginal || row, null, 2)}`;

      const msgs = [
        { role: 'system', content: 'Você é um analista de auditoria de faturas de energia elétrica. Responda em Markdown, pt-BR.' },
        { role: 'user', content: prompt },
      ];

      // 1ª tentativa: endpoint com retry/backoff do backend (reduz 429)
      let out = await ocrChat(msgs);

      // Fallback: se vier vazio, tenta rota antiga de regras (semáforo mantém proteção)
      if (!out || !out.message) {
        const text = await interpretRule(prompt);
        out = { message: text || '' };
      }

      setAiView((prev) => ({ ...prev, [id]: { open: true, loading: false, text: out.message || '', error: '' } }));
    } catch (e) {
      // Mensagem amigável para 429
      const msg = String(e || '');
      const hint = /429/.test(msg)
        ? 'Muitas requisições em sequência. Aguarde alguns segundos antes de tentar novamente.'
        : 'Falha ao interpretar com a IA.';
      setAiView((prev) => ({ ...prev, [id]: { open: true, loading: false, text: '', error: `${hint} ${msg}` } }));
    } finally {
      setBusy(false);
    }
  };

  // Persistência local simples (localStorage)
  useEffect(() => {
    try {
      const raw = localStorage.getItem('ocr_rows_v1');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setRows(parsed);
      }
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('ocr_rows_v1', JSON.stringify(rows));
    } catch {}
  }, [rows]);

  // Ações de tabela
  const removeRow = (id) => setRows((prev) => prev.filter((r) => r.id !== id));
  const clearAll = () => {
    if (confirm('Remover todas as linhas da tabela?')) setRows([]);
  };

  // Exportações
  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ocr_auditoria_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const csvEscape = (v) => {
    const s = v == null ? '' : String(v);
    if (/[";\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const exportCSV = () => {
    const headers = [
      'Arquivo','Nº Cliente','UC','Referência','Elegível','Bandeira','Dias mês','Dias total','kWh TUSD','Valor Bandeira (R$)','Calc 4,463','Calc 7,877','Bandeira incorreta?','Fonte','Criado em'
    ];
    const sep = ';';
    const lines = [headers.join(sep)];
    for (const r of rows) {
      lines.push([
        csvEscape(r.arquivo),
        csvEscape(r.numeroCliente || ''),
        csvEscape(r.uc || ''),
        csvEscape(r.referencia || ''),
        csvEscape(simNao(r.elegivel)),
        csvEscape(r.bandeiraLida || ''),
        csvEscape(r.diasMes ?? ''),
        csvEscape(r.diasTotal ?? ''),
        csvEscape(typeof r.tusdKwh === 'number' ? r.tusdKwh.toString().replace('.', ',') : (r.tusdKwh ?? '')),
        csvEscape(typeof r.valorBandeira === 'number' ? r.valorBandeira.toString().replace('.', ',') : (r.valorBandeira ?? '')),
        csvEscape(typeof r.valorCalc4463 === 'number' ? r.valorCalc4463.toString().replace('.', ',') : (r.valorCalc4463 ?? '')),
        csvEscape(typeof r.valorCalc7877 === 'number' ? r.valorCalc7877.toString().replace('.', ',') : (r.valorCalc7877 ?? '')),
        csvEscape(simNao(r.bandeiraIncorreta)),
        csvEscape(r.sourceUrl || ''),
        csvEscape(r.createdAt || ''),
      ].join(sep));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ocr_auditoria_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="glass-card border rounded-xl p-4 flex flex-col gap-4">
      {/* Controles de Upload e Parâmetros */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <UploadCloud size={18} className="opacity-80" />
          <h2 className="font-semibold">Auditoria de Faturas (OCR)</h2>
        </div>

        <div
          className="border-2 border-dashed panel-border rounded-lg p-6 flex flex-col items-center justify-center text-center panel-bg-60"
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onDrop={onDrop}
        >
          <p className="opacity-70 mb-2">Arraste e solte faturas (PDF, PNG, JPG)</p>
          <input
            type="file"
            multiple
            onChange={onPick}
            className="mt-2"
            accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg"
          />
          {files.length > 0 && (
            <div className="mt-4 w-full max-w-md text-left">
              <div className="text-xs opacity-70 mb-1">Arquivos selecionados</div>
              <ul className="space-y-1">
                {files.map((f, idx) => (
                  <li
                    key={idx}
                    className="flex items-center justify-between text-sm panel-bg-50 rounded px-2 py-1"
                  >
                    <span className="truncate">{f.name}</span>
                    <button
                      onClick={() => removeFile(idx)}
                      className="opacity-70 hover:opacity-100"
                      title="Remover"
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="mt-3">
          <label className="text-xs opacity-70">Instruções (opcional)</label>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={3}
            className="w-full p-2 border panel-border rounded-md panel-bg-60"
            placeholder="Ex.: Extraia número da fatura, UC, mês/ano, datas, valor, consumo, concessionária e tensões."
          />
        </div>

        {/* Adicionar por links */}
        <div className="mt-3">
          <label className="text-xs opacity-70">Links de faturas (um por linha)</label>
          <textarea
            value={linkInput}
            onChange={(e) => setLinkInput(e.target.value)}
            rows={3}
            className="w-full p-2 border panel-border rounded-md panel-bg-60"
            placeholder="https://exemplo.com/fatura1.pdf\nhttps://exemplo.com/fatura2.jpg"
          />
          <div className="mt-2 flex gap-2 items-center text-xs opacity-80">
            <button
              onClick={addLinks}
              className="px-3 py-1 rounded-md bg-[var(--accent)] text-[var(--fg)]"
            >
              Adicionar links
            </button>
            <span>(Requer CORS habilitado no servidor dos arquivos.)</span>
          </div>
        </div>

        <div className="mt-3 flex gap-3 items-center flex-wrap">
          <button
            onClick={analyzeQuick}
            disabled={!canAnalyze}
            className="px-4 py-2 rounded-md bg-[var(--accent)] text-[var(--fg)] disabled:opacity-50 flex items-center gap-2"
          >
            <UploadCloud size={16} /> {analyzing ? 'Processando…' : 'OCR Rápido'}
          </button>

          <button
            onClick={analyze}
            disabled={!canAnalyze}
            className="px-4 py-2 rounded-md bg-[var(--accent)]/80 text-[var(--fg)] disabled:opacity-50 flex items-center gap-2"
            title="Modo legado: OCR + Interpretação em uma etapa"
          >
            <UploadCloud size={16} /> {analyzing ? 'Processando…' : 'OCR Completo (Legado)'}
          </button>

          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={ruleICMS}
              onChange={(e) => setRuleICMS(e.target.checked)}
            />
            Aplicar também regra ICMS
          </label>
        </div>
      </div>

      {/* Tabela de Resultados */}
      <div>
        {rows.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs opacity-70">Resultados (mais recentes no topo)</div>
              <div className="flex gap-2">
                <button onClick={exportCSV} className="px-3 py-1 rounded bg-[var(--accent)] text-[var(--fg)] text-xs">Exportar CSV</button>
                <button onClick={exportJSON} className="px-3 py-1 rounded bg-[var(--accent)] text-[var(--fg)] text-xs">Exportar JSON</button>
                <button onClick={clearAll} className="px-3 py-1 rounded panel-bg-60 border panel-border text-xs">Limpar tudo</button>
              </div>
            </div>
            <div className="overflow-auto max-h-[60vh] border border-dashed border-[var(--border)] rounded-md">
              <table className="min-w-full text-[11px] border-collapse">
                <thead className="bg-[var(--panel-processos)]/60 sticky top-0">
                  <tr>
                    <th className="px-2 py-1 border border-[var(--border)] text-left">Arquivo</th>
                    <th className="px-2 py-1 border border-[var(--border)] text-left">Nº Cliente</th>
                    <th className="px-2 py-1 border border-[var(--border)] text-left">UC</th>
                    <th className="px-2 py-1 border border-[var(--border)] text-left">Referência</th>
                    <th className="px-2 py-1 border border-[var(--border)] text-center">Elegível</th>
                    <th className="px-2 py-1 border border-[var(--border)] text-left">Bandeira</th>
                    <th className="px-2 py-1 border border-[var(--border)] text-right">Dias mês</th>
                    <th className="px-2 py-1 border border-[var(--border)] text-right">Dias total</th>
                    <th className="px-2 py-1 border border-[var(--border)] text-right">kWh TUSD</th>
                    <th className="px-2 py-1 border border-[var(--border)] text-right">Valor Bandeira (R$)</th>
                    <th className="px-2 py-1 border border-[var(--border)] text-right">Calc 4,463</th>
                    <th className="px-2 py-1 border border-[var(--border)] text-right">Calc 7,877</th>
                    <th className="px-2 py-1 border border-[var(--border)] text-center">Bandeira incorreta?</th>
                    <th className="px-2 py-1 border border-[var(--border)] text-center">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, idx) => (
                    <tr key={r.id || idx} className="odd:bg-[rgba(255,255,255,0.02)]">
                      <td className="px-2 py-1 border border-[var(--border)] truncate max-w-[260px]">
                        {r.sourceUrl ? (
                          <a className="underline" href={r.sourceUrl} target="_blank" rel="noreferrer">{r.arquivo}</a>
                        ) : (
                          r.arquivo
                        )}
                      </td>
                      <td className="px-2 py-1 border border-[var(--border)]">{r.numeroCliente || '-'}</td>
                      <td className="px-2 py-1 border border-[var(--border)]">{r.uc || '-'}</td>
                      <td className="px-2 py-1 border border-[var(--border)]">{r.referencia || '-'}</td>
                      <td className="px-2 py-1 border border-[var(--border)] text-center">{simNao(r.elegivel)}</td>
                      <td className="px-2 py-1 border border-[var(--border)]">{r.bandeiraLida || '-'}</td>
                      <td className="px-2 py-1 border border-[var(--border)] text-right">{r.diasMes ?? '-'}</td>
                      <td className="px-2 py-1 border border-[var(--border)] text-right">{r.diasTotal ?? '-'}</td>
                      <td className="px-2 py-1 border border-[var(--border)] text-right">{fmtNum(r.tusdKwh)}</td>
                      <td className="px-2 py-1 border border-[var(--border)] text-right">{fmtNum(r.valorBandeira)}</td>
                      <td className="px-2 py-1 border border-[var(--border)] text-right">{fmtNum(r.valorCalc4463)}</td>
                      <td className="px-2 py-1 border border-[var(--border)] text-right">{fmtNum(r.valorCalc7877)}</td>
                      <td className={`px-2 py-1 border border-[var(--border)] text-center ${r.bandeiraIncorreta === true ? 'text-red-400 font-semibold' : r.bandeiraIncorreta === false ? 'text-emerald-400' : 'opacity-70'}`}>
                        {simNao(r.bandeiraIncorreta)}
                      </td>
                      <td className="px-2 py-1 border border-[var(--border)] text-center">
                        <div className="flex items-center justify-center gap-2 flex-wrap">
                          {r.requestId && !r.interpreted && (
                            <button
                              title="Aplicar regras ao OCR salvo"
                              onClick={() => interpretWithAI(r)}
                              disabled={busy || aiView[r.id]?.loading}
                              className={`px-2 py-1 rounded text-[10px] flex items-center gap-1 ${busy || aiView[r.id]?.loading ? 'opacity-50 cursor-not-allowed' : 'bg-emerald-600 text-white hover:bg-emerald-700'}`}
                            >
                              <Sparkles size={12} />
                              {busy || aiView[r.id]?.loading ? 'Interpretando…' : 'Interpretar com IA'}
                            </button>
                          )}
                          {r.interpreted && (
                            <span className="px-2 py-1 rounded text-[10px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                              ✓ Interpretado
                            </span>
                          )}
                          <button
                            title="Chat com IA sobre este resultado"
                            onClick={() => interpretRow(r)}
                            disabled={busy || aiView[r.id]?.loading}
                            className={`px-2 py-1 rounded text-[10px] ${busy || aiView[r.id]?.loading ? 'opacity-50 cursor-not-allowed' : 'bg-[var(--accent)] text-[var(--fg)]'}`}
                          >
                            {busy || aiView[r.id]?.loading ? 'Processando…' : 'Chat IA'}
                          </button>
                          <button title="Excluir" onClick={() => removeRow(r.id)} className="opacity-80 hover:opacity-100">
                            <X size={14} />
                          </button>
                        </div>
                        {aiView[r.id]?.open && (
                          <div className="mt-2 text-left p-2 panel-bg-60 rounded border panel-border max-h-48 overflow-auto">
                            {aiView[r.id]?.loading && (
                              <div className="text-xs opacity-70">Interpretando…</div>
                            )}
                            {aiView[r.id]?.error && (
                              <div className="text-xs text-red-400">{aiView[r.id].error}</div>
                            )}
                            {aiView[r.id]?.text && (
                              <pre className="text-xs whitespace-pre-wrap break-words">{aiView[r.id].text}</pre>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Debug bruto (opcional) */}
      {lastRawResults.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs opacity-70">Resultados brutos (debug)</div>
          {lastRawResults.map((r, i) => (
            <div key={i} className="p-3 panel-bg-60 rounded border panel-border">
              <div className="text-xs opacity-60 mb-1">{r.file_name || r.FileName || `item ${i + 1}`}</div>
              <pre className="text-xs overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(r, null, 2)}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
