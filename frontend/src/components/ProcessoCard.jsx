// src/components/ProcessoCard.jsx
import React, { useEffect, useMemo, useState } from 'react';
import { Star, Clock, User, PauseCircle, PlayCircle, Bell, AlertTriangle, CalendarDays, Paperclip, FileText, X, Link as LinkIcon, BadgeDollarSign } from 'lucide-react';
import {
  movimentarProcesso,
  getHistoricoById,
  suspenderProcesso,
  retomarProcesso,
  getRequisicaoById,
  buscarFaturasPorUnidadeMeses,
} from '../services/requisicaoService';
import api from '../services/api';
import { withAuthToken } from '../services/apiClient';
import { confirmAction } from '../utils/confirm.js';

/* ===================== HELPERS ===================== */

const extrair = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'String' in v) return v.Valid ? (v.String ?? '') : '';
  if (typeof v === 'object' && 'Value' in v) return v.Value || '';
  try { return String(v); } catch { return ''; }
};

const pick = (obj, keys = []) => keys.map((k) => obj?.[k]).find((v) => v !== undefined && v !== null);

/** Parser numérico tolerante: aceita 1.234,56 e 1234.56 */
const toNum = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;

  if (typeof v === 'object') {
    if ('Valid' in v && v.Valid === false) return null;
    if ('Float64' in v) return Number.isFinite(Number(v.Float64)) ? Number(v.Float64) : null;
    if ('Int64' in v)  return Number.isFinite(Number(v.Int64))  ? Number(v.Int64)  : null;
    if ('String' in v && v.String != null) v = String(v.String);
    else if ('Value' in v) v = String(v.Value);
  }

  if (typeof v !== 'string') v = String(v ?? '');
  const s = v.trim();
  if (!s) return null;

  const cleaned = s.replace(/[^\d.,-]/g, '');
  const normalized = /,\d{1,2}$/.test(cleaned)
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned;

  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
};

const brl = (n) =>
  n == null ? null : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const tempoRelativo = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'agora';
  if (diff < 3600) return `há ${Math.floor(diff / 60)}min`;
  if (diff < 86400) return `há ${Math.floor(diff / 3600)}h`;
  if (diff < 7 * 86400) return `há ${Math.floor(diff / 86400)}d`;
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

const toDate = (v) => {
  if (!v && v !== 0) return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'object' && 'Time' in v) {
    // NullTime no back: {Time: "...", Valid: true}
    try { const d = new Date(v.Time ?? v); return isNaN(d) ? null : d; } catch { return null; }
  }
  if (typeof v === 'object' && 'String' in v) {
    try { const d = new Date(v.String); return isNaN(d) ? null : d; } catch { return null; }
  }
  try { const d = new Date(v); return isNaN(d) ? null : d; } catch { return null; }
};

const fmtDataCurta = (d) => {
  if (!d) return '';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo' });
};

/* ===================== COMPONENTE ===================== */

const DISABLE_ALERTS = true;

export default function ProcessoCard({ processo, meta, onClick }) {
  const pid = processo?.id ?? processo?.processo_id ?? processo?.requisicao_id;

  // Favorito (relevância)
  const [fav, setFav] = useState(!!processo?.relevancia || !!processo?.__relevancia || !!processo?.favorito || !!processo?.__favorito);
  // Sincroniza quando o processo/meta mudar (evita borda acesa e estrela apagada)
  useEffect(() => {
    const novo = !!(processo?.relevancia || processo?.__relevancia || processo?.favorito || processo?.__favorito);
    setFav(novo);
  }, [pid, processo?.relevancia, processo?.__relevancia, processo?.favorito, processo?.__favorito]);

  // Suspensão (independente de sub-etapa)
  const suspensoInicial = !!(processo?.suspenso || processo?.__suspenso || processo?.Suspenso);
  const [suspLocal, setSuspLocal] = useState(suspensoInicial);
  useEffect(() => { setSuspLocal(suspensoInicial); }, [suspensoInicial]);

  //   // Re-render do tempo relativo
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  // Dados base
  const uc = extrair(pick(processo, ['uc', 'unidade_consumidora'])) || extrair(processo?.unidade_consumidora?.String);
  const cliente = extrair(pick(processo, ['cliente', 'nome_cliente'])) || extrair(processo?.nome_cliente?.String);
  const concessionaria =
    extrair(pick(processo, ['concessionaria', 'concessionaria_sigla', '__concessionaria'])) ||
    extrair(processo?.concessionaria?.String) || '';
  const subEtapa = extrair(pick(processo, ['sub_etapa', 'subEtapa', '__sub_etapa'])) || '';

  // Financeiros
  const valorEstimado = useMemo(() => {
    const v = pick(processo, [
      'ressarcimento_estimado',
      'valor_estimado',
      'ressarcimento_estimado_total',
      '__valor_estimado',
    ]);
    return toNum(v);
  }, [processo]);

  const creditoSimples = useMemo(() => {
    const v = pick(processo, [
      'credito_simples',
      'ressarcimento_recebido_simples',
      'ressarcimento_recebido_cliente_simples',
      'valor_credito_simples',
      '__credito_simples',
    ]);
    return toNum(v);
  }, [processo]);

  const creditoDobro = useMemo(() => {
    const v = pick(processo, [
      'credito_dobro',
      'ressarcimento_recebido_dobro',
      'ressarcimento_recebido_cliente_dobro',
      'valor_credito_dobro',
      '__credito_dobro',
    ]);
    return toNum(v);
  }, [processo]);

  const valorTotalCredito = useMemo(() => {
    if (creditoSimples == null || creditoDobro == null) return null;
    const total = creditoSimples + creditoDobro;
    return Number.isFinite(total) ? total : null;
  }, [creditoSimples, creditoDobro]);

  // Estado: Indeferido?
  const isIndeferido = useMemo(() => {
    const etapa = String(pick(processo, ['__etapa', 'etapa']) || '').toLowerCase();
    const status = String(pick(processo, ['status', 'Status']) || '').toLowerCase();
    return etapa.includes('indefer') || status.includes('indefer');
  }, [processo]);

  // Valor exibido: evita mostrar R$ 0,00
  const valorDisplay = useMemo(() => {
    const ve = valorEstimado;
    const vt = valorTotalCredito;
    if (ve != null && ve > 0) return ve;
    if (vt != null && vt > 0) return vt;
    return null;
  }, [valorEstimado, valorTotalCredito]);
  // Severidade de alarme (se vier de alarme personalizado)
  const sev = String(processo?.__alarmeSeverity || "").toLowerCase();

  // Alerta e contorno de prazo vencido
  const dataAlerta =
    toDate(pick(processo, ['data_alerta', 'dataAlerta', 'DataAlerta'])) || null;

  const alertasCount = (() => {
    const v = pick(processo, ['alertas_count', 'AlertasCount', '__alertas']);
    const n = toNum(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  })();

  const alertaVencido = useMemo(() => { if (typeof DISABLE_ALERTS !== 'undefined' && DISABLE_ALERTS) return false; if (!dataAlerta) return false; const hoje = new Date(); const d = new Date(dataAlerta.getFullYear(), dataAlerta.getMonth(), dataAlerta.getDate(), 23, 59, 59); return d.getTime() < hoje.getTime(); }, [dataAlerta, nowTick]);

  // Última movimentação (histórico)
  const [ultimaMovLocal, setUltimaMovLocal] = useState(null);
  const [carregandoHist, setCarregandoHist] = useState(false);
  const [erroHist, setErroHist] = useState('');

  
  useEffect(() => {
    if (meta?.ultima_mov) {
      setUltimaMovLocal({ data: meta.ultima_mov.data, comentario: meta.ultima_mov.comentario, usuario: meta.ultima_mov.usuario, canais: [] });
    }
  }, [meta]);
const ultimaDataISO = useMemo(() => {
    if (processo?.__ultimaData instanceof Date && !isNaN(processo.__ultimaData)) return processo.__ultimaData.toISOString();
    if (processo?.data_ultima_movimentacao) return String(processo.data_ultima_movimentacao);
    if (processo?.ultima_atualizacao) return String(processo.ultima_atualizacao);
    return '';
  }, [processo]);

  const ultimaMovRel = useMemo(
    () => tempoRelativo(ultimaMovLocal?.data || ultimaDataISO),
    [ultimaMovLocal, ultimaDataISO, nowTick]
  );

  // Modal (Anexos / Faturas)
  const [modal, setModal] = useState({ open: false, type: null, title: '', rows: [], loading: false });
  const closeModal = () => setModal({ open: false, type: null, title: '', rows: [], loading: false });

  const openAnexos = async () => {
    if (!pid) return;
    setModal({ open: true, type: 'anexos', title: `Anexos · PROC-${String(pid).padStart(3,'0')}`, rows: [], loading: true });
    try {
      const { data } = await api.get(`/requisicoes/${pid}/anexos`);
      const rows = Array.isArray(data) ? data : [];
      setModal((m) => ({ ...m, rows, loading: false }));
    } catch {
      setModal((m) => ({ ...m, rows: [], loading: false }));
    }
  };

  const openFaturas = async () => {
    if (!pid) return;
    setModal({ open: true, type: 'faturas', title: `Faturas · PROC-${String(pid).padStart(3,'0')}`, rows: [], loading: true });
    try {
      const det = await getRequisicaoById(pid);
      const ucLocal = extrair(det?.uc || det?.UC || uc);
      let arr = [];
      const raw = det?.periodos_irregularidade || det?.PeriodosIrregularidade || '';
      if (raw) arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const refs = Array.isArray(arr)
        ? arr.map((p) => {
            const y = String(p?.ano ?? p?.Ano ?? '').trim();
            const m = String(p?.mes ?? p?.Mes ?? p?.['M\u00EAs'] ?? '').trim();
            if (!y || !m) return null;
            const mm = String(m).padStart(2, '0');
            return `${y}-${mm}`;
          }).filter(Boolean)
        : [];
      let rows = [];
      if (ucLocal && refs.length > 0) {
        const dados = await buscarFaturasPorUnidadeMeses(ucLocal, refs);
        if (Array.isArray(dados?.faturas)) {
          rows = dados.faturas.map((f) => ({
            mes_ref: f.MesRef || f.mes_ref || '',
            link: f.Link || f.link || '',
            dt_vencimento: f.Dt_Vencimento || f.dt_vencimento || '',
            valor_total: f.Valor_Total || f.valor_total || null,
          }));
        } else if (Array.isArray(dados?.links_faturas_detalhes)) {
          rows = dados.links_faturas_detalhes;
        } else if (Array.isArray(dados?.links_faturas)) {
          rows = dados.links_faturas.map((l) => ({ link: l }));
        }
      }
      setModal((m) => ({ ...m, rows, loading: false }));
    } catch {
      setModal((m) => ({ ...m, rows: [], loading: false }));
    }
  };

  // Contadores de Anexos/Faturas (lazy via IntersectionObserver)
  const cardRef = React.useRef(null);
  const [counts, setCounts] = useState({ loaded: meta ? true : false, loading: false, anexos: meta?.anexos ?? null, faturas: meta?.faturas ?? null });
  const loadCounts = React.useCallback(async () => {
    if (!pid || counts.loading || counts.loaded) return;
    try {
      setCounts((c) => ({ ...c, loading: true }));
      // Anexos
      let anexosCount = 0;
      try {
        const anex = await api.get(`/requisicoes/${pid}/anexos`);
        anexosCount = Array.isArray(anex?.data) ? anex.data.length : 0;
      } catch {}

      // Faturas
      let faturasCount = 0;
      try {
        const det = await getRequisicaoById(pid);
        const ucLocal = extrair(det?.uc || det?.UC || uc);
        let arr = [];
        const raw = det?.periodos_irregularidade || det?.PeriodosIrregularidade || '';
        if (raw) arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const refs = Array.isArray(arr)
          ? arr.map((p) => {
              const y = String(p?.ano ?? p?.Ano ?? '').trim();
              const m = String(p?.mes ?? p?.Mes ?? p?.['M\u00EAs'] ?? '').trim();
              if (!y || !m) return null;
              const mm = String(m).padStart(2, '0');
              return `${y}-${mm}`;
            }).filter(Boolean)
          : [];
        if (ucLocal && refs.length > 0) {
          const dados = await buscarFaturasPorUnidadeMeses(ucLocal, refs);
          if (Array.isArray(dados?.faturas)) faturasCount = dados.faturas.length;
          else if (Array.isArray(dados?.links_faturas_detalhes)) faturasCount = dados.links_faturas_detalhes.length;
          else if (Array.isArray(dados?.links_faturas)) faturasCount = dados.links_faturas.length;
        }
      } catch {}

      setCounts({ loaded: true, loading: false, anexos: anexosCount, faturas: faturasCount });
    } catch {
      setCounts({ loaded: true, loading: false, anexos: 0, faturas: 0 });
    }
  }, [pid, counts.loading, counts.loaded, uc]);

  // Usa metadados em lote para preencher última movimentação sem nova requisição
  useEffect(() => {
    if (meta && meta.ultima_mov && !ultimaMovLocal) {
      setUltimaMovLocal(meta.ultima_mov);
    }
  }, [meta, ultimaMovLocal]);

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    let obs;
    if (typeof window !== 'undefined' && 'IntersectionObserver' in window) {
      obs = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            loadCounts();
            obs && obs.disconnect();
            break;
          }
        }
      }, { rootMargin: '200px' });
      obs.observe(el);
      return () => { try { obs.disconnect(); } catch {} };
    }
    const t = setTimeout(loadCounts, 500);
    return () => clearTimeout(t);
  }, [loadCounts]);

  // Pré-carregar os contadores assim que montar (sem esperar viewport)
  useEffect(() => { if (!meta) loadCounts(); }, [loadCounts, meta]);

  useEffect(() => {
    if (!pid || ultimaMovLocal || meta?.ultima_mov) return;
    let cancel = false;
    (async () => {
      try {
        setCarregandoHist(true); setErroHist('');
        // Desativado no card para evitar muitas requisições; histórico carrega na tela de detalhes
        const hist = [];
        if (cancel) return;
        if (Array.isArray(hist) && hist.length > 0) {
          const key = ['data_movimentacao', 'data', 'created_at', 'updated_at']
            .find((k) => k in (hist[0] || {})) || 'data_movimentacao';
          const ultimo = [...hist].sort((a, b) => new Date(b[key]) - new Date(a[key]))[0];
          const canais = (() => {
            try {
              if (Array.isArray(ultimo?.canais) && ultimo.canais.length) return ultimo.canais.map((x)=>String(x).toLowerCase());
              const csv = extrair(ultimo?.canal_comunicacao);
              if (csv) return String(csv).split(',').map((s)=>s.trim().toLowerCase()).filter(Boolean);
              const sc = extrair(ultimo?.status_composto || ultimo?.status_novo || '');
              if (sc && sc.includes(' via ')) {
                const via = sc.split(' via ').pop();
                return String(via).split(',').map((s)=>s.trim().toLowerCase()).filter(Boolean);
              }
            } catch {}
            return [];
          })();
          setUltimaMovLocal({
            data: ultimo[key],
            comentario: extrair(ultimo?.comentario),
            usuario: extrair(ultimo?.usuario_nome) || extrair(ultimo?.nome_usuario),
            canais,
          });
        }
      } catch (e) {
        setErroHist('Erro ao carregar histórico');
      } finally { setCarregandoHist(false); }
    })();
    return () => { cancel = true; };
  }, [pid, ultimaMovLocal]);

  // Ações
  const toggleFavorito = async (e) => {
    e.stopPropagation();
    if (!pid) return;
    const novo = !fav; setFav(novo);
    try {
      const fd = new FormData(); fd.append('relevancia', String(novo));
      if (!(await confirmAction(`Deseja mover o processo #${pid}?`))) return;
      await movimentarProcesso(pid, fd);
    } catch {
      setFav(!novo);
      alert('Não foi possível atualizar o favorito.');
    }
  };

  const handleOpen = () => { if (typeof onClick === 'function') onClick(processo); };

  const handleSuspender = async (e) => {
    e.stopPropagation();
    if (!pid) return;
    if (!confirm('Confirmar suspensão do processo?')) return;
    try {
      if (!(await confirmAction('Deseja suspender este processo?'))) return;
      await suspenderProcesso(pid, 'Suspenso via card');
      setSuspLocal(true);
    } catch {
      alert('Falha ao suspender');
    }
  };

  const handleRetomar = async (e) => {
    e.stopPropagation();
    if (!pid) return;
    if (!confirm('Confirmar retomada do processo?')) return;
    try {
      if (!(await confirmAction('Deseja retomar este processo?'))) return;
      await retomarProcesso(pid, 'Retomado via card');
      setSuspLocal(false);
    } catch {
      alert('Falha ao retomar');
    }
  };


  const tooltip = [
    erroHist || '',
    dataAlerta ? ('Alerta: ' + fmtDataCurta(dataAlerta)) : '',
    (processo?.__prazoVencido && processo?.__prazoDias) ? ('Prazo (' + processo.__prazoDias + 'd) vencido') : '',
    ultimaMovLocal?.comentario || ''
  ].filter(Boolean).join(' • ');

  // Classes de borda: prioridade (favorito > suspenso > default) – alertas desativados
  const borderClasses = (() => {
    // Alertas desativados: ignora contornos de vencido
    if (fav) return 'border-2 border-yellow-400 ring-1 ring-yellow-400/30';
    if (suspLocal) return 'border-2 border-amber-500 ring-1 ring-amber-300/30';
    return 'border panel-border hover:border-[var(--accent)]/60';
  })();

  return (
    <div
      ref={cardRef}
      role="button"
      tabIndex={0}
      onClick={handleOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleOpen()}
      className={[
        'relative cursor-pointer rounded-xl px-8 py-4 select-none transition-colors duration-200 hover:shadow-md z-0 min-w-0 h-[240px] flex flex-col justify-between overflow-hidden',
        'bg-[var(--card)] shadow-soft border border-[var(--border)]',
        borderClasses,
      ].join(' ')}
      title={tooltip}
    >
      {/* FITA: Suspenso */}
      {suspLocal && (
        <div className="absolute top-0 right-0 w-20 h-20 overflow-hidden pointer-events-none">
          <span className="absolute right-[-36px] top-2 rotate-45 bg-amber-600 text-white text-[10px] px-6 py-0.5 shadow">
            Suspenso
          </span>
        </div>
      )}

      {/* FITA: Vencido – desativada */}
      {/* eslint-disable-next-line no-constant-binary-expression */}
      {false && alertaVencido && (
        <div className="absolute -left-2 -top-2 flex items-center gap-1 rounded-md bg-red-600 text-white text-[10px] px-2 py-0.5 shadow">
          <AlertTriangle size={12} /> Vencido
        </div>
      )}

      {/* Cabeçalho alinhado ao visual de Requisições */}
      <div className="flex items-start justify-between gap-3 min-w-0">
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <h4 className="text-lg font-extrabold text-[var(--fg)]">PROC-{String(pid || '').padStart(3,'0')}</h4>
            {uc && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold max-w-[180px] truncate" style={{ background:'#DBEAFE', color:'#1D4ED8' }}>UC {uc}</span>
            )}
            {subEtapa && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold max-w-[220px] truncate" style={{ background:'#D1FAE5', color:'#065F46' }}>{subEtapa}</span>
            )}
          </div>
          <div className="mt-0.5 text-sm opacity-80 whitespace-nowrap overflow-hidden text-ellipsis">
            {carregandoHist
              ? '...'
              : (
                (ultimaMovLocal?.comentario
                  ? `${ultimaMovLocal.comentario}${ultimaMovRel ? ' • ' + ultimaMovRel : ''}`
                  : (ultimaMovRel ? `Última mov. ${ultimaMovRel}` : ''))
                )}
          </div>
        </div>
        {/* valor estimado movido para lista abaixo */}
        {/* eslint-disable-next-line no-constant-binary-expression */}
      {false && processo?.__alarmeFromCustom && sev && (
            <span
              className={[ 'px-1.5 py-0.5 rounded border text-[10px]',
                sev==='crit' ? 'bg-red-600/20 text-red-300 border-red-600/40' : (sev==='warn' ? 'bg-amber-500/20 text-amber-300 border-amber-600/40' : (sev==='info' ? 'bg-blue-600/20 text-blue-300 border-blue-600/40' : 'hidden'))
              ].join(' ')}
              title={`Alarme: ${sev}`}
            >{sev}</span>
          )}
                      <div className="flex items-center gap-2 shrink-0 w-[72px] justify-end">
          {/* eslint-disable-next-line no-constant-binary-expression */}
          {false && (
          <div
            className={[
              'relative rounded-md px-1.5 py-1 text-sm transition-colors',
              alertaVencido ? 'text-red-500' : (alertasCount > 0 ? 'text-amber-500' : 'text-[var(--fg)]/70'),
                          ].join(' ')}
            title={(processo?.__prazoVencido && processo?.__prazoDias) ? ('Prazo (' + processo.__prazoDias + 'd) vencido') : ''}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="button"
            tabIndex={-1}
          >
            <Bell size={18} />
            {(alertasCount > 0 || alertaVencido) && (
              <span className={[
                'absolute -top-1 -right-1 min-w-[18px] h-[18px] rounded-full text-[10px] leading-[18px] text-center px-[4px]',
                alertaVencido ? 'bg-red-600 text-white' : 'bg-amber-500 text-black'
              ].join(' ')}>
                {alertaVencido ? '!' : alertasCount}
              </span>
            )}
          </div>
          )}
          {/* Suspender/Retomar */}
          {!suspLocal ? (
            <button
              type="button"
              title="Suspender processo"
              aria-label="Suspender processo"
              onClick={handleSuspender}
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              className="p-1 rounded-md text-red-500 hover:bg-red-500/10 transition-colors"
            >
              <PauseCircle size={18} />
            </button>
          ) : (
            <button
              type="button"
              title="Retomar processo"
              aria-label="Retomar processo"
              onClick={handleRetomar}
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              className="p-1 rounded-md text-green-500 hover:bg-green-500/10 transition-colors"
            >
              <PlayCircle size={18} />
            </button>
          )}

          {/* Favorito */}
          <button
            type="button"
            onClick={toggleFavorito}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            title={fav ? 'Remover dos favoritos' : 'Marcar como favorito'}
            aria-label="Favorito"
            className={[
              'p-1 rounded-md transition-colors',
              fav ? 'text-yellow-400 bg-yellow-400/10' : 'text-[var(--fg)]/70 hover:text-yellow-300 hover:panel-bg-80'
            ].join(' ')}
          >
            <Star size={18} className={fav ? 'fill-current' : ''} />
          </button>
        </div>
      </div>

      {/* Linha divisória */}
      <hr className="my-3 border-[var(--border)]" />

      {/* Grid de meta (estilo aqui.png) */}
      <div className="flex flex-col gap-2 text-sm mb-2">
        <div className="flex items-start gap-2">
          <BadgeDollarSign size={16} className="mt-0.5 opacity-70" />
          <div className="flex items-center gap-3">
            <div className="text-xs opacity-70 w-[120px]">Valor estimado:</div>
            <div className="font-semibold tabular-nums" style={{ color: (isIndeferido && valorDisplay != null) ? '#DC2626' : (valorDisplay != null ? '#10B981' : 'var(--fg)') }}>{valorDisplay != null ? brl(valorDisplay) : '-'}</div>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <CalendarDays size={16} className="mt-0.5 opacity-70" />
          <div className="flex items-center gap-3">
            <div className="text-xs opacity-70 w-[120px]">Criação:</div>
            <div className="font-semibold tabular-nums">{fmtDataCurta(toDate(processo?.ultima_atualizacao)) || '-'}</div>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Clock size={16} className="mt-0.5 opacity-70" />
          <div className="flex items-center gap-3">
            <div className="text-xs opacity-70 w-[120px]">Última mov:</div>
            <div className="font-semibold tabular-nums">{carregandoHist ? '...' : (ultimaMovRel || '-')}</div>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Paperclip size={16} className="mt-0.5 opacity-70" />
          <div className="flex items-center gap-3">
            <div className="text-xs opacity-70 w-[120px]">Anexos:</div>
            <div className="font-semibold tabular-nums">{counts.loading && !counts.loaded ? '...' : (counts.anexos == null ? '-' : `${counts.anexos} arquivo${counts.anexos === 1 ? '' : 's'}`)}</div>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <FileText size={16} className="mt-0.5 opacity-70" />
          <div className="flex items-center gap-3">
            <div className="text-xs opacity-70 w-[120px]">Faturas:</div>
            <div className="font-semibold tabular-nums">{counts.loading && !counts.loaded ? '...' : (counts.faturas == null ? '-' : `${counts.faturas} fatura${counts.faturas === 1 ? '' : 's'}`)}</div>
          </div>
        </div>
      </div>

      {/* Ações */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className="btn-themed text-sm inline-flex items-center gap-2" onClick={(e)=>{e.stopPropagation(); handleOpen();}}>
          Ver Detalhes
        </button>
        <button onClick={(e)=>{e.stopPropagation(); openAnexos();}} className="btn-outline text-sm inline-flex items-center gap-2">
          <Paperclip size={16} /> Anexos
        </button>
        <button onClick={(e)=>{e.stopPropagation(); openFaturas();}} className="btn-outline text-sm inline-flex items-center gap-2">
          <BadgeDollarSign size={16} /> Faturas
        </button>
      </div>

      {/* Modal */}
      {modal.open && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={(e)=>e.stopPropagation()}>
          <div className="w-full max-w-2xl sap-card text-[var(--fg)]">
            <div className="flex items-center justify-between px-4 py-3 border-b panel-border">
              <h3 className="text-lg font-bold">{modal.title}</h3>
              <button onClick={closeModal} className="btn-outline p-2"><X size={18} /></button>
            </div>
            <div className="p-4 max-h-[65vh] overflow-auto">
              {modal.loading && <div className="opacity-70 sap-loading">Carregando...</div>}
              {!modal.loading && modal.type === 'anexos' && (
                <div className="space-y-2">
                  {modal.rows.length === 0 && <div className="opacity-70">Sem anexos.</div>}
                  {modal.rows.map((a) => (
                    <div key={a.id || a.ID || a.nome_arquivo} className="flex items-center justify-between gap-3 sap-card px-3 py-2">
                      <div className="flex items-center gap-2 shrink-0 w-[72px] justify-end">
                        <Paperclip size={16} />
                        <div>
                          <div className="text-sm font-medium">{a.nome_arquivo || a.NomeArquivo}</div>
                          <div className="text-xs opacity-70">{a.enviado_por || a.EnviadoPor} {a.data_upload ? `· ${a.data_upload}` : ''}</div>
                        </div>
                      </div>
                      {(a.url || a.caminho_arquivo || a.CaminhoArquivo) && (
                        <a className="inline-flex items-center gap-1 text-sm underline" href={withAuthToken(a.url || a.caminho_arquivo || a.CaminhoArquivo)} target="_blank" rel="noreferrer">
                          <LinkIcon size={14} /> Abrir
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {!modal.loading && modal.type === 'faturas' && (
                <div className="space-y-2">
                  {modal.rows.length === 0 && <div className="opacity-70">Sem faturas.</div>}
                  {modal.rows.map((f, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 sap-card px-3 py-2">
                      <div className="flex items-center gap-3">
                        <FileText size={16} />
                        <div>
                          <div className="text-sm font-medium">{f.mes_ref || f.MesRef || 'Mês'}</div>
                          <div className="text-xs opacity-70 inline-flex items-center gap-1"><CalendarDays size={12} />{f.dt_vencimento || f.DtVencimento || f.Dt_Vencimento || '-'}</div>
                        </div>
                      </div>
                      {(f.link || f.Link) && (
                        <a className="inline-flex items-center gap-1 text-sm underline" href={f.link || f.Link} target="_blank" rel="noreferrer">
                          <LinkIcon size={14} /> Abrir
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="px-4 py-3 border-t panel-border text-right">
              <button onClick={closeModal} className="btn-outline">Fechar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
