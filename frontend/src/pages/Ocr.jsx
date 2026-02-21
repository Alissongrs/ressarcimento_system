// src/pages/Ocr.jsx
import React, { useEffect, useMemo, useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import { UploadCloud, X, Sparkles } from 'lucide-react';
import { LineChart, Line, ResponsiveContainer, Tooltip } from 'recharts';
import {
  ocrAnalyze,
  ocrChat,
  ocrQuick,
  ocrInterpret,
  desvioMediaAnalyze,
} from '@services/ocrService.js';
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

  // Excel / Robô
  const [excelAnalyzeFile, setExcelAnalyzeFile] = useState(null);
  const [excelAnalyzeInstruction, setExcelAnalyzeInstruction] = useState(
    'Verifique o desvio medio de consumo KWH_FPonta e traga a media e outliers por UC.',
  );

  // ✅ Agora o método realmente é enviado ao backend/robô
  // mean_mad = comportamento atual (o do print)
  // robust_mad = mediana + MAD robusto (recomendado para “normal é o típico”)
  // zscore = média + desvio padrão
  const [excelAnalyzeMethod, setExcelAnalyzeMethod] = useState('mean_mad');

  // Baseline temporal (usa Mes_Ref quando disponível)
  const [excelAnalyzeBaselineMode, setExcelAnalyzeBaselineMode] = useState('global'); // global|expanding|rolling
  const [excelAnalyzeLookback, setExcelAnalyzeLookback] = useState(12);

  // Impacto financeiro (opcional) — R$/kWh (quando não existir coluna de tarifa no Excel)
  const [excelAnalyzeTarifaEstimada, setExcelAnalyzeTarifaEstimada] = useState('');

  // Leitura estimada: valor idêntico por N meses seguidos
  const [excelAnalyzeLeituraEstimadaN, setExcelAnalyzeLeituraEstimadaN] = useState(3);

  // Retornar série para mini-gráficos
  const [excelAnalyzeIncludeSeries, setExcelAnalyzeIncludeSeries] = useState(true);
  const [excelAnalyzeSeriesLimit, setExcelAnalyzeSeriesLimit] = useState(24);

  const [excelAnalyzeThreshold, setExcelAnalyzeThreshold] = useState(3);
  const [excelAnalyzeLoading, setExcelAnalyzeLoading] = useState(false);
  const [excelAnalyzeError, setExcelAnalyzeError] = useState('');
  const [excelAnalyzeResult, setExcelAnalyzeResult] = useState(null);
  const [excelAnalyzeUnitCol, setExcelAnalyzeUnitCol] = useState('UC');
  const [excelAnalyzeConcCol, setExcelAnalyzeConcCol] = useState('Concessionaria');
  const [excelAnalyzeValueCol, setExcelAnalyzeValueCol] = useState('KWH_FPonta');
  const [excelAnalyzeTopN, setExcelAnalyzeTopN] = useState(50);
  const [excelAnalyzePlaceholder, setExcelAnalyzePlaceholder] = useState('0,1,50');
  const [excelAnalyzeMinBase, setExcelAnalyzeMinBase] = useState(8);
  const [excelAnalyzePctHigh, setExcelAnalyzePctHigh] = useState(1.0);
  const [excelAnalyzePctLow, setExcelAnalyzePctLow] = useState(-0.9);

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

  const fmtPct = (p) => (p == null || Number.isNaN(Number(p)) ? '-' : `${(Number(p) * 100).toFixed(2)}%`);

  const fmtMesRef = (v) => {
    if (!v) return '';
    const s = String(v);
    // tenta reduzir timestamp ISO para YYYY-MM
    try {
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 7);
    } catch {}
    // fallback: tenta cortar
    return s.length >= 7 ? s.slice(0, 7) : s;
  };

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
      requestId: requestId || res?.request_id || null,
      rawText: res?.raw_text || null,
      interpreted: !!(rr && Object.keys(rr).length > 0),
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

      const newRows = results.map((res) => mapResultToRow(res, requestId));
      setLastRawResults(results);
      setRows((prev) => [...newRows, ...prev]);
      setFiles([]);
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
    if (busy) return;
    setBusy(true);
    setAiView((prev) => ({ ...prev, [id]: { open: true, loading: true, text: '', error: '' } }));

    try {
      const rules = ['BANDEIRA_ENEL_SP_GB'];
      if (ruleICMS) rules.push('ICMS');

      const result = await ocrInterpret(row.requestId, row.arquivo, rules, false);

      const updatedRow = mapResultToRow(
        {
          file_name: result.filename,
          rule_results: result.rule_results,
          raw_text: row.rawText,
          request_id: row.requestId,
        },
        row.requestId,
      );

      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...updatedRow } : r)));
      setAiView((prev) => ({ ...prev, [id]: { open: false, loading: false, text: '', error: '' } }));
    } catch (e) {
      const msg = String(e || '');
      const hint = /429/.test(msg) ? 'Muitas requisições. Aguarde alguns segundos.' : 'Falha ao interpretar com a IA.';
      setAiView((prev) => ({ ...prev, [id]: { open: true, loading: false, text: '', error: `${hint} ${msg}` } }));
    } finally {
      setBusy(false);
    }
  };

  // Modo legado
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
      setFiles([]);
    } catch (e) {
      setLastRawResults([{ error: String(e) }]);
    } finally {
      setAnalyzing(false);
    }
  };

  // Chat IA por linha
  const interpretRow = async (row) => {
    const id = row.id;
    if (busy) return;
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

      let out = await ocrChat(msgs);

      if (!out || !out.message) {
        const text = await interpretRule(prompt);
        out = { message: text || '' };
      }

      setAiView((prev) => ({ ...prev, [id]: { open: true, loading: false, text: out.message || '', error: '' } }));
    } catch (e) {
      const msg = String(e || '');
      const hint = /429/.test(msg)
        ? 'Muitas requisições em sequência. Aguarde alguns segundos antes de tentar novamente.'
        : 'Falha ao interpretar com a IA.';
      setAiView((prev) => ({ ...prev, [id]: { open: true, loading: false, text: '', error: `${hint} ${msg}` } }));
    } finally {
      setBusy(false);
    }
  };

  const handleExcelAnalyze = async () => {
    if (!excelAnalyzeFile) {
      setExcelAnalyzeError('Selecione um arquivo Excel.');
      return;
    }
    setExcelAnalyzeError('');
    setExcelAnalyzeLoading(true);
    setExcelAnalyzeResult(null);
    try {
      const data = await desvioMediaAnalyze(excelAnalyzeFile, {
        instruction: excelAnalyzeInstruction,
        unit_col: excelAnalyzeUnitCol,
        concessionaria_col: excelAnalyzeConcCol,
        value_col: excelAnalyzeValueCol,
        placeholder: excelAnalyzePlaceholder,
        min_base: excelAnalyzeMinBase,
        score_threshold: excelAnalyzeThreshold,
        pct_high: excelAnalyzePctHigh,
        pct_low: excelAnalyzePctLow,
        max_anom: excelAnalyzeTopN,

        // ✅ novo
        method: excelAnalyzeMethod,
        baseline_mode: excelAnalyzeBaselineMode,
        lookback: excelAnalyzeLookback,

        leitura_estimada_n: excelAnalyzeLeituraEstimadaN,
        include_series: excelAnalyzeIncludeSeries,
        series_limit: excelAnalyzeSeriesLimit,

        tarifa_estimada: excelAnalyzeTarifaEstimada ? Number(excelAnalyzeTarifaEstimada) : undefined,

      });
      setExcelAnalyzeResult(data);
    } catch (e) {
      setExcelAnalyzeError(e?.message || 'Falha ao analisar o Excel.');
    } finally {
      setExcelAnalyzeLoading(false);
    }
  };

  // Persistência local simples
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
    a.download = `ocr_auditoria_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
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
      'Arquivo',
      'Nº Cliente',
      'UC',
      'Referência',
      'Elegível',
      'Bandeira',
      'Dias mês',
      'Dias total',
      'kWh TUSD',
      'Valor Bandeira (R$)',
      'Calc 4,463',
      'Calc 7,877',
      'Bandeira incorreta?',
      'Fonte',
      'Criado em',
    ];
    const sep = ';';
    const lines = [headers.join(sep)];
    for (const r of rows) {
      lines.push(
        [
          csvEscape(r.arquivo),
          csvEscape(r.numeroCliente || ''),
          csvEscape(r.uc || ''),
          csvEscape(r.referencia || ''),
          csvEscape(simNao(r.elegivel)),
          csvEscape(r.bandeiraLida || ''),
          csvEscape(r.diasMes ?? ''),
          csvEscape(r.diasTotal ?? ''),
          csvEscape(typeof r.tusdKwh === 'number' ? r.tusdKwh.toString().replace('.', ',') : r.tusdKwh ?? ''),
          csvEscape(typeof r.valorBandeira === 'number' ? r.valorBandeira.toString().replace('.', ',') : r.valorBandeira ?? ''),
          csvEscape(typeof r.valorCalc4463 === 'number' ? r.valorCalc4463.toString().replace('.', ',') : r.valorCalc4463 ?? ''),
          csvEscape(typeof r.valorCalc7877 === 'number' ? r.valorCalc7877.toString().replace('.', ',') : r.valorCalc7877 ?? ''),
          csvEscape(simNao(r.bandeiraIncorreta)),
          csvEscape(r.sourceUrl || ''),
          csvEscape(r.createdAt || ''),
        ].join(sep),
      );
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ocr_auditoria_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const exportDesvioCSV = (rowsToExport, filename) => {
    if (!Array.isArray(rowsToExport) || rowsToExport.length === 0) return;
    const headers = Object.keys(rowsToExport[0] || {});
    const sep = ';';
    const lines = [headers.join(sep)];
    rowsToExport.forEach((r) => {
      lines.push(headers.map((h) => csvEscape(r?.[h])).join(sep));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const exportDesvioXLSX = (groups, filename, topN) => {
    if (!Array.isArray(groups) || groups.length === 0) return;
    const rowsToExport = [];
    groups.forEach((g) => {
      const meses = Array.isArray(g.meses_ref) ? g.meses_ref.join(', ') : '';
      (g.anomalias || []).slice(0, topN).forEach((r) => {
        rowsToExport.push({
          UC: g.uc,
          Concessionaria: g.concessionaria,
          Meses_Ref: meses,
          Linha: r.row_index ?? '',
          Valor: r.valor ?? '',
          Normal: r.normal_value ?? g.normal_value ?? g.media_base ?? '',
          Dif_Abs: r.dif_abs ?? '',
          Dif_Pct: r.dif_pct != null ? Number(r.dif_pct) * 100 : '',
          Classificacao: r.status + (r.status_extra ? ` (${r.status_extra})` : ''),
        });
      });
    });
    const ws = XLSX.utils.json_to_sheet(rowsToExport);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Desvios');
    XLSX.writeFile(wb, filename);
  };
  const fmtMoney = (v) => {
    const n = Number(v);
    if (!isFinite(n)) return '';
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(String(text || ''));
    } catch {
      // fallback
      try {
        const el = document.createElement('textarea');
        el.value = String(text || '');
        el.setAttribute('readonly', '');
        el.style.position = 'absolute';
        el.style.left = '-9999px';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
      } catch {}
    }
  };


  // Identificação de outliers/alertas
  const isHardOutlier = (row) =>
    ['PICO_OUTLIER', 'MUITO_BAIXO', 'OUTLIER_SCORE'].includes(String(row?.status || '').toUpperCase());

  const isPctFlag = (row) => {
    const s = String(row?.status || '').toUpperCase();
    const ex = String(row?.status_extra || '').toUpperCase();
    return ['ACIMA_100PCT', 'ABAIXO_90PCT'].includes(s) || ['ACIMA_100PCT', 'ABAIXO_90PCT'].includes(ex);
  };

  // ✅ UI com texto sempre legível (evita “letra da mesma cor da caixa”)
  const desvioUi = (row) => {
    if (isHardOutlier(row)) {
      return {
        bar: 'bg-red-500',
        dot: 'bg-red-500',
        badge: 'bg-red-500/10 text-[var(--fg)] border-red-500/30',
        card: 'border-red-500/30 bg-red-500/5 ring-1 ring-red-500/15',
        label: 'OUTLIER',
      };
    }
    if (isPctFlag(row)) {
      return {
        bar: 'bg-amber-500',
        dot: 'bg-amber-500',
        badge: 'bg-amber-500/10 text-[var(--fg)] border-amber-500/30',
        card: 'border-amber-500/30 bg-amber-500/5 ring-1 ring-amber-500/15',
        label: 'ALERTA %',
      };
    }
    return {
      bar: 'bg-slate-400',
      dot: 'bg-slate-400',
      badge: 'bg-white/10 text-[var(--fg)] border-white/20',
      card: 'border-white/10 bg-white/5',
      label: 'INFO',
    };
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
                  <li key={idx} className="flex items-center justify-between text-sm panel-bg-50 rounded px-2 py-1">
                    <span className="truncate">{f.name}</span>
                    <button onClick={() => removeFile(idx)} className="opacity-70 hover:opacity-100" title="Remover">
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
            <button onClick={addLinks} className="px-3 py-1 rounded-md bg-[var(--accent)] text-[var(--fg)]">
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
            <input type="checkbox" checked={ruleICMS} onChange={(e) => setRuleICMS(e.target.checked)} />
            Aplicar também regra ICMS
          </label>
        </div>
      </div>

      {/* Analise orientada (Excel) */}
      <div className="glass-card border rounded-xl p-4 space-y-3">
        <div className="font-semibold text-sm">Analise orientada (Excel)</div>
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={(e) => setExcelAnalyzeFile(e.target.files?.[0] || null)}
          className="w-full px-2 py-1 border panel-border rounded-md text-xs panel-bg-60"
        />
        <textarea
          rows={3}
          value={excelAnalyzeInstruction}
          onChange={(e) => setExcelAnalyzeInstruction(e.target.value)}
          className="w-full p-2 border panel-border rounded-md panel-bg-60 text-xs"
          placeholder="Descreva o que deseja analisar"
        />

        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px]">
          <div>
            <div className="opacity-70 mb-1">Coluna UC</div>
            <input
              value={excelAnalyzeUnitCol}
              onChange={(e) => setExcelAnalyzeUnitCol(e.target.value)}
              className="w-full px-2 py-1 border panel-border rounded-md text-xs panel-bg-60"
            />
          </div>
          <div>
            <div className="opacity-70 mb-1">Coluna Concessionaria</div>
            <input
              value={excelAnalyzeConcCol}
              onChange={(e) => setExcelAnalyzeConcCol(e.target.value)}
              className="w-full px-2 py-1 border panel-border rounded-md text-xs panel-bg-60"
            />
          </div>
          <div>
            <div className="opacity-70 mb-1">Coluna Valor</div>
            <input
              value={excelAnalyzeValueCol}
              onChange={(e) => setExcelAnalyzeValueCol(e.target.value)}
              className="w-full px-2 py-1 border panel-border rounded-md text-xs panel-bg-60"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-[11px]">
          <div>
            <div className="opacity-70 mb-1">Placeholders</div>
            <input
              value={excelAnalyzePlaceholder}
              onChange={(e) => setExcelAnalyzePlaceholder(e.target.value)}
              className="w-full px-2 py-1 border panel-border rounded-md text-xs panel-bg-60"
              placeholder="0,1,50"
            />
          </div>
          <div>
            <div className="opacity-70 mb-1">Amostra minima</div>
            <input
              type="number"
              value={excelAnalyzeMinBase}
              onChange={(e) => setExcelAnalyzeMinBase(Number(e.target.value))}
              className="w-full px-2 py-1 border panel-border rounded-md text-xs panel-bg-60"
            />
          </div>
          <div>
            <div className="opacity-70 mb-1">Pct alto</div>
            <input
              type="number"
              step="0.1"
              value={excelAnalyzePctHigh}
              onChange={(e) => setExcelAnalyzePctHigh(Number(e.target.value))}
              className="w-full px-2 py-1 border panel-border rounded-md text-xs panel-bg-60"
            />
          </div>
          <div>
            <div className="opacity-70 mb-1">Pct baixo</div>
            <input
              type="number"
              step="0.1"
              value={excelAnalyzePctLow}
              onChange={(e) => setExcelAnalyzePctLow(Number(e.target.value))}
              className="w-full px-2 py-1 border panel-border rounded-md text-xs panel-bg-60"
            />
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap text-[11px]">
          <div className="flex items-center gap-2">
            <span className="opacity-70">Metodo</span>
            <select
              value={excelAnalyzeMethod}
              onChange={(e) => setExcelAnalyzeMethod(e.target.value)}
              className="glass-select text-xs p-1 rounded"
              title="Escolha como calcular o normal (baseline) e o score"
            >
              <option value="mean_mad">Média + Desvio médio abs (atual)</option>
              <option value="robust_mad">Robusto (Mediana + MAD) - recomendado</option>
              <option value="zscore">Z-Score (Média + Desvio padrão)</option>
            </select>
          </div>


          <div className="flex items-center gap-2">
            <span className="opacity-70">Baseline</span>
            <select
              value={excelAnalyzeBaselineMode}
              onChange={(e) => setExcelAnalyzeBaselineMode(e.target.value)}
              className="glass-select text-xs p-1 rounded"
              title="Como o baseline é calculado ao longo do tempo"
            >
              <option value="global">Global (todos os meses)</option>
              <option value="expanding">Expanding (somente meses anteriores)</option>
              <option value="rolling">Rolling (últimos N meses)</option>
            </select>
            <input
              type="number"
              min="1"
              value={excelAnalyzeLookback}
              onChange={(e) => setExcelAnalyzeLookback(Number(e.target.value))}
              className="w-20 px-2 py-1 border panel-border rounded-md text-xs panel-bg-60"
              title="N (janela) do rolling"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="opacity-70">Leitura est.</span>
            <input
              type="number"
              min="2"
              value={excelAnalyzeLeituraEstimadaN}
              onChange={(e) => setExcelAnalyzeLeituraEstimadaN(Number(e.target.value))}
              className="w-16 px-2 py-1 border panel-border rounded-md text-xs panel-bg-60"
              title="N meses seguidos com o mesmo kWh (suspeita de leitura estimada)"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="opacity-70">Tarifa (R$/kWh)</span>
            <input
              type="number"
              step="0.0001"
              value={excelAnalyzeTarifaEstimada}
              onChange={(e) => setExcelAnalyzeTarifaEstimada(e.target.value)}
              className="w-28 px-2 py-1 border panel-border rounded-md text-xs panel-bg-60"
              placeholder="(opcional)"
              title="Usado para estimar impacto financeiro do desvio"
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={excelAnalyzeIncludeSeries}
              onChange={(e) => setExcelAnalyzeIncludeSeries(e.target.checked)}
            />
            <span className="opacity-70">Mini-gráfico</span>
            <input
              type="number"
              min="6"
              value={excelAnalyzeSeriesLimit}
              onChange={(e) => setExcelAnalyzeSeriesLimit(Number(e.target.value))}
              className="w-16 px-2 py-1 border panel-border rounded-md text-xs panel-bg-60"
              title="Quantos meses na série"
            />
          </label>


          <div className="flex items-center gap-2">
            <span className="opacity-70">Limite</span>
            <input
              type="number"
              step="0.1"
              value={excelAnalyzeThreshold}
              onChange={(e) => setExcelAnalyzeThreshold(Number(e.target.value))}
              className="w-20 px-2 py-1 border panel-border rounded-md text-xs panel-bg-60"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="opacity-70">Top N</span>
            <input
              type="number"
              value={excelAnalyzeTopN}
              onChange={(e) => setExcelAnalyzeTopN(Number(e.target.value))}
              className="w-20 px-2 py-1 border panel-border rounded-md text-xs panel-bg-60"
            />
          </div>

          <button
            type="button"
            onClick={handleExcelAnalyze}
            className="px-3 py-1 rounded-md bg-[var(--accent)] text-[var(--fg)] text-xs"
            disabled={excelAnalyzeLoading}
          >
            {excelAnalyzeLoading ? 'Analisando...' : 'Analisar'}
          </button>

          <button
            type="button"
            onClick={() =>
              exportDesvioCSV(
                (excelAnalyzeResult?.anomalias || []).slice(0, excelAnalyzeTopN),
                `desvio_anomalias_${new Date().toISOString().slice(0, 10)}.csv`,
              )
            }
            className="px-3 py-1 rounded panel-bg-60 border panel-border text-xs"
            disabled={!excelAnalyzeResult?.anomalias?.length}
          >
            Exportar anomalias CSV
          </button>

          <button
            type="button"
            onClick={() =>
              exportDesvioXLSX(
                excelAnalyzeResult?.groups || [],
                `desvio_grupos_${new Date().toISOString().slice(0, 10)}.xlsx`,
                excelAnalyzeTopN,
              )
            }
            className="px-3 py-1 rounded panel-bg-60 border panel-border text-xs"
            disabled={!excelAnalyzeResult?.groups?.length}
          >
            Exportar XLSX (grupos)
          </button>

          <button
            type="button"
            onClick={() =>
              exportDesvioCSV(
                (excelAnalyzeResult?.duplicidades || []).slice(0, excelAnalyzeTopN),
                `desvio_duplicidades_${new Date().toISOString().slice(0, 10)}.csv`,
              )
            }
            className="px-3 py-1 rounded panel-bg-60 border panel-border text-xs"
            disabled={!excelAnalyzeResult?.duplicidades?.length}
          >
            Exportar duplicidades CSV
          </button>
        </div>

        {excelAnalyzeError && <div className="text-xs text-red-500">{excelAnalyzeError}</div>}

        {excelAnalyzeResult?.summary && (
          <div className="text-[11px] space-y-1">
            <div>Total de registros: {excelAnalyzeResult.summary.total_registros}</div>
            <div>Total de grupos: {excelAnalyzeResult.summary.total_grupos}</div>
            <div>Total de anomalias: {excelAnalyzeResult.summary.total_anomalias}</div>
            {excelAnalyzeResult.summary?.placeholder_values?.length ? (
              <div className="opacity-80">
                Placeholders ignorados: {excelAnalyzeResult.summary.placeholder_values.join(', ')}
              </div>
            ) : null}
          </div>
        )}

        {Array.isArray(excelAnalyzeResult?.groups) && excelAnalyzeResult.groups.length > 0 && (
          <div className="space-y-3">
            <div className="text-[11px] font-semibold opacity-80">Grupos com anomalias (cards)</div>

            <div className="grid grid-cols-1 gap-3">
              {excelAnalyzeResult.groups.slice(0, excelAnalyzeTopN).map((g, gi) => {
                const groupIsRed = (g?.anomalias || []).some(isHardOutlier);
                const normalValue = g?.normal_value ?? g?.media_base ?? 0;

                return (
                  <div
                    key={`${g.uc}-${g.concessionaria}-${gi}`}
                    className={[
                      'rounded-xl border panel-border p-3',
                      'bg-white/5',
                      groupIsRed ? 'border-red-500/30 ring-1 ring-red-500/15' : 'border-white/10',
                    ].join(' ')}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[12px] font-semibold truncate">UC: {g.uc}</div>
                        <div className="text-[11px] opacity-80 truncate">Concessionaria: {g.concessionaria}</div>

                        <div className="mt-1 text-[11px] opacity-90">
                          Normal (Média normal esperada):{' '}
                          <span className="font-semibold">{fmtNum(Number(normalValue || 0))}</span>
                          {'  '}Base: <span className="font-medium">{g.base_len}</span>
                          {'  '}Registros: <span className="font-medium">{g.total_registros}</span>
                        </div>

                        {Array.isArray(g.meses_ref) && g.meses_ref.length > 0 && (
                          <div className="mt-1 text-[10px] opacity-70 truncate">
                            Meses: {g.meses_ref.slice(0, 8).map(fmtMesRef).join(', ')}
                            {g.meses_ref.length > 8 ? '…' : ''}
                          </div>
                        )}

                        {excelAnalyzeIncludeSeries && Array.isArray(g.series) && g.series.length > 1 && (
                          <div className="mt-2 h-16 text-[var(--fg)]/90">
                            <ResponsiveContainer width="100%" height="100%">
                              <LineChart data={g.series.map((p) => ({
                                mes_ref: fmtMesRef(p.mes_ref),
                                valor: Number(p.valor || 0),
                                baseline: Number(p.baseline || 0),
                                limite_inf: Number(p.limite_inf || 0),
                                limite_sup: Number(p.limite_sup || 0),
                              }))}>
                                <Tooltip
                                  formatter={(val, name) => [fmtNum(Number(val || 0)), name]}
                                  labelFormatter={(label) => `Mês: ${label}`}
                                />
                                <Line type="monotone" dataKey="valor" stroke="currentColor" strokeWidth={2} dot={false} />
                                <Line type="monotone" dataKey="baseline" stroke="currentColor" strokeWidth={1} dot={false} strokeDasharray="2 2" opacity={0.6} />
                                <Line type="monotone" dataKey="limite_sup" stroke="currentColor" strokeWidth={1} dot={false} strokeDasharray="3 3" opacity={0.45} />
                                <Line type="monotone" dataKey="limite_inf" stroke="currentColor" strokeWidth={1} dot={false} strokeDasharray="3 3" opacity={0.45} />
                              </LineChart>
                            </ResponsiveContainer>
                          </div>
                        )}
                      </div>

                      <div className="shrink-0 flex flex-col items-end gap-1">
                        <span
                          className={[
                            'text-[10px] px-2 py-0.5 rounded border',
                            groupIsRed ? 'bg-red-500/10 text-[var(--fg)] border-red-500/30' : 'bg-white/10 text-[var(--fg)] border-white/20',
                          ].join(' ')}
                        >
                          {g.anomalias?.length || 0} alertas
                        </span>
                      </div>
                    </div>

                    {/* ✅ Cards lado a lado + destaque forte */}
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                      {(g.anomalias || []).slice(0, Math.min(excelAnalyzeTopN, 12)).map((row, idx) => {
                        const ui = desvioUi(row);
                        const statusLine = row.status_extra ? `${row.status} (${row.status_extra})` : row.status;
                        const rowNormal = row?.normal_value ?? normalValue;

                        return (
                          <div
                            key={`${g.uc}-${idx}`}
                            className={['relative rounded-lg border p-2 overflow-hidden', 'transition', ui.card, Number(row?.score || 0) >= 4 ? 'animate-pulse' : ''].join(' ')}
                            title={statusLine}
                          >
                            {/* barra lateral indicando severidade */}
                            <span className={`absolute left-0 top-0 bottom-0 w-1 ${ui.bar}`} />

                            <div className="flex items-center justify-between gap-2 pl-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className={`w-2.5 h-2.5 rounded-sm ${ui.dot}`} />
                                <span className="text-[10px] font-semibold truncate text-[var(--fg)]">{ui.label}</span>
                              </div>

                              <span className={`text-[10px] px-2 py-0.5 rounded border ${ui.badge}`}>
                                {statusLine}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  const t = [
                                    `UC: ${g.uc}`,
                                    `Concessionaria: ${g.concessionaria}`,
                                    row.mes_ref ? `Mes: ${fmtMesRef(row.mes_ref)}` : '',
                                    `Valor: ${fmtNum(Number(row.valor || 0))}`,
                                    `Normal: ${fmtNum(Number((row?.baseline_center ?? rowNormal) || 0))}`,
                                    `Status: ${statusLine}`,
                                    row.score != null ? `Score: ${Number(row.score || 0).toFixed(2)}` : '',
                                    row.impacto_rs != null ? `Impacto: ${fmtMoney(row.impacto_rs)}` : '',
                                  ].filter(Boolean).join('\n');
                                  copyToClipboard(t);
                                }}
                                className="ml-2 text-[10px] px-2 py-0.5 rounded border bg-white/10 text-[var(--fg)] border-white/20 hover:bg-white/15"
                                title="Copiar resumo"
                              >
                                Copiar
                              </button>
                            </div>

                            <div className="mt-2 text-[11px] space-y-0.5 pl-2">
                              <div>
                                Valor: <span className="font-semibold">{fmtNum(Number(row.valor || 0))}</span>
                              </div>
                              <div className="opacity-90">
                                Normal: <span className="font-medium">{fmtNum(Number(rowNormal || 0))}</span>
                              </div>
                              <div>
                                Δ: <span className="font-medium">{fmtNum(Number(row.dif_abs || 0))}</span>
                                {' '}| %: <span className="font-medium">{fmtPct(row.dif_pct)}</span>
                              </div>
                              {row.score != null && (
                                <div>
                                  Score: <span className="font-medium">{Number(row.score || 0).toFixed(2)}</span>
                                </div>
                              )}
                              {row.impacto_rs != null && (
                                <div>
                                  Impacto: <span className="font-medium">{fmtMoney(row.impacto_rs)}</span>
                                </div>
                              )}
                              {row.mes_ref ? (
                                <div className="text-[10px] opacity-70 truncate">Mes: {fmtMesRef(row.mes_ref)}</div>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Tabela de Resultados */}
      <div>
        {rows.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs opacity-70">Resultados (mais recentes no topo)</div>
              <div className="flex gap-2">
                <button onClick={exportCSV} className="px-3 py-1 rounded bg-[var(--accent)] text-[var(--fg)] text-xs">
                  Exportar CSV
                </button>
                <button onClick={exportJSON} className="px-3 py-1 rounded bg-[var(--accent)] text-[var(--fg)] text-xs">
                  Exportar JSON
                </button>
                <button onClick={clearAll} className="px-3 py-1 rounded panel-bg-60 border panel-border text-xs">
                  Limpar tudo
                </button>
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
                          <a className="underline" href={r.sourceUrl} target="_blank" rel="noreferrer">
                            {r.arquivo}
                          </a>
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
                      <td
                        className={`px-2 py-1 border border-[var(--border)] text-center ${
                          r.bandeiraIncorreta === true
                            ? 'text-red-400 font-semibold'
                            : r.bandeiraIncorreta === false
                              ? 'text-emerald-400'
                              : 'opacity-70'
                        }`}
                      >
                        {simNao(r.bandeiraIncorreta)}
                      </td>
                      <td className="px-2 py-1 border border-[var(--border)] text-center">
                        <div className="flex items-center justify-center gap-2 flex-wrap">
                          {r.requestId && !r.interpreted && (
                            <button
                              title="Aplicar regras ao OCR salvo"
                              onClick={() => interpretWithAI(r)}
                              disabled={busy || aiView[r.id]?.loading}
                              className={`px-2 py-1 rounded text-[10px] flex items-center gap-1 ${
                                busy || aiView[r.id]?.loading
                                  ? 'opacity-50 cursor-not-allowed'
                                  : 'bg-emerald-600 text-white hover:bg-emerald-700'
                              }`}
                            >
                              <Sparkles size={12} />
                              {busy || aiView[r.id]?.loading ? 'Interpretando…' : 'Interpretar com IA'}
                            </button>
                          )}

                          {r.interpreted && (
                            <span className="px-2 py-1 rounded text-[10px] bg-emerald-500/20 text-emerald-600 border border-emerald-500/30">
                              ✓ Interpretado
                            </span>
                          )}

                          <button
                            title="Chat com IA sobre este resultado"
                            onClick={() => interpretRow(r)}
                            disabled={busy || aiView[r.id]?.loading}
                            className={`px-2 py-1 rounded text-[10px] ${
                              busy || aiView[r.id]?.loading ? 'opacity-50 cursor-not-allowed' : 'bg-[var(--accent)] text-[var(--fg)]'
                            }`}
                          >
                            {busy || aiView[r.id]?.loading ? 'Processando…' : 'Chat IA'}
                          </button>

                          <button title="Excluir" onClick={() => removeRow(r.id)} className="opacity-80 hover:opacity-100">
                            <X size={14} />
                          </button>
                        </div>

                        {aiView[r.id]?.open && (
                          <div className="mt-2 text-left p-2 panel-bg-60 rounded border panel-border max-h-48 overflow-auto">
                            {aiView[r.id]?.loading && <div className="text-xs opacity-70">Interpretando…</div>}
                            {aiView[r.id]?.error && <div className="text-xs text-red-500">{aiView[r.id].error}</div>}
                            {aiView[r.id]?.text && <pre className="text-xs whitespace-pre-wrap break-words">{aiView[r.id].text}</pre>}
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
