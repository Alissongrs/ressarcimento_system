// src/components/WelcomeBriefingModal.jsx
//
// Modal de "briefing operacional" que aparece UMA VEZ por sessão para usuários
// com perfil 'gestor'. Mostra saudação personalizada + cards de "atenção hoje"
// + atalhos. Persiste flag em sessionStorage (some ao fechar o navegador) e
// suporta "não mostrar hoje" via localStorage (24h).
//
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  X, AlertTriangle, Clock, Inbox, Mail, CalendarClock,
  Sparkles, ArrowRight, FilePlus, LayoutDashboard, Target,
} from 'lucide-react';
import { getRelatoriosMetricas, getRelatoriosMetricasBatch } from '../services/relatoriosService.js';
import { getAllRequisicoes, getProcessosComPrazo } from '../services/requisicaoService.js';

const META_MENSAL = 417000;
const fmtMM = (n) => {
  const v = Number(n || 0);
  return v >= 1e6
    ? `R$ ${(v / 1e6).toFixed(2)} MM`
    : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0, maximumFractionDigits: 0 });
};

const SESSION_FLAG = 'sure_welcome_shown_session';
const SNOOZE_FLAG = 'sure_welcome_snooze_until';
const CACHE_KEY = 'sure_welcome_briefing_cache';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

function readCachedData() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.data || !parsed?.ts) return null;
    if (Date.now() - parsed.ts > CACHE_TTL_MS) return null;
    return parsed.data;
  } catch { return null; }
}

function writeCachedData(data) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() }));
  } catch {}
}

function saudacao() {
  const h = new Date().getHours();
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}

function diaDaSemana() {
  const dias = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  const meses = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const d = new Date();
  return `${dias[d.getDay()]}, ${d.getDate()} de ${meses[d.getMonth()]}`;
}

function AtentionCard({ icon: Icon, label, value, hint, severity = 'neutral', onClick }) {
  const colors = {
    crit: { bg: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.40)', fg: '#ef4444' },
    warn: { bg: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.40)', fg: '#f59e0b' },
    ok:   { bg: 'rgba(16,185,129,0.10)', border: 'rgba(16,185,129,0.40)', fg: '#10b981' },
    info: { bg: 'rgba(59,130,246,0.10)', border: 'rgba(59,130,246,0.40)', fg: '#3b82f6' },
    neutral: { bg: 'var(--panel)', border: 'var(--border)', fg: 'var(--fg)' },
  };
  const c = colors[severity] || colors.neutral;
  return (
    <button
      type="button"
      onClick={onClick}
      className="group text-left rounded-xl border-2 px-4 py-3 transition-all hover:scale-[1.02] hover:shadow-md"
      style={{ background: c.bg, borderColor: c.border }}
    >
      <div className="flex items-start gap-3">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: `color-mix(in srgb, ${c.fg} 18%, transparent)` }}
        >
          <Icon size={18} style={{ color: c.fg }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-wide opacity-60 mb-0.5">{label}</div>
          <div className="text-2xl font-extrabold tabular-nums leading-none" style={{ color: c.fg }}>
            {value}
          </div>
          {hint && <div className="text-[11px] opacity-60 mt-1">{hint}</div>}
        </div>
        <ArrowRight size={14} className="opacity-30 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-1" />
      </div>
    </button>
  );
}

function ShortcutButton({ icon: Icon, label, onClick, accent = 'var(--accent)' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 px-4 py-2.5 rounded-lg border panel-border bg-[var(--panel)] hover:bg-[var(--hover)] transition-colors text-sm font-medium"
    >
      <Icon size={16} style={{ color: accent }} />
      <span>{label}</span>
    </button>
  );
}

export default function WelcomeBriefingModal({ user, onClose }) {
  const navigate = useNavigate();
  // Hidrata estado inicial do cache (se disponível) — render imediato
  const cachedInitial = readCachedData();
  const [loading, setLoading] = useState(!cachedInitial);
  const [refreshing, setRefreshing] = useState(!!cachedInitial); // se veio do cache, está refrescando em background
  const [data, setData] = useState(cachedInitial || {
    travados30: null,
    prazosVencidos: null,
    requisicoesPendentes: null,
    prazosProx48h: null,
    metaMensalAtingido: null,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Busca filtro de mês corrente para meta mensal
        const now = new Date();
        const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);
        const fimMes = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        const fmtDate = (d) =>
          `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

        const [metricas, requisicoes, prazos, batchMes] = await Promise.allSettled([
          getRelatoriosMetricas({}),
          getAllRequisicoes(),
          getProcessosComPrazo(),
          getRelatoriosMetricasBatch([
            { key: 'month', data_ini: fmtDate(inicioMes), data_fim: fmtDate(fimMes) },
          ]),
        ]);

        if (cancelled) return;

        const m = metricas.status === 'fulfilled' ? metricas.value : null;
        const reqs = requisicoes.status === 'fulfilled' ? (Array.isArray(requisicoes.value) ? requisicoes.value : []) : [];
        const prz = prazos.status === 'fulfilled' ? prazos.value : null;
        const monthData = batchMes.status === 'fulfilled' ? batchMes.value?.month : null;

        const travados30 = Number(m?.aging_buckets?.['31_mais'] || 0);
        const prazosVencidos = Number(m?.sla_30d?.late || 0);
        const metaMensalAtingido = Number(monthData?.ressarcimento_envio_financeiro_total || 0);

        const reqsPendentes = reqs.filter((r) => {
          const s = String(r?.status || '').toLowerCase();
          return s.includes('nova') || s.includes('pendente') || s.includes('triagem');
        }).length;

        const prazosRows = Array.isArray(prz?.rows) ? prz.rows : [];
        const agora = Date.now();
        const dois_dias = 2 * 24 * 60 * 60 * 1000;
        const prazosProx48h = prazosRows.filter((p) => {
          if (p?.atrasado) return false;
          const dt = p?.proximo_prazo || p?.data_prazo || p?.prazo;
          if (!dt) return false;
          const t = new Date(dt).getTime();
          return Number.isFinite(t) && t > agora && (t - agora) <= dois_dias;
        }).length;

        const fresh = { travados30, prazosVencidos, requisicoesPendentes: reqsPendentes, prazosProx48h, metaMensalAtingido };
        setData(fresh);
        writeCachedData(fresh);
      } catch {
        if (!cancelled && !cachedInitial) {
          setData({ travados30: 0, prazosVencidos: 0, requisicoesPendentes: 0, prazosProx48h: 0, metaMensalAtingido: 0 });
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalAtencao = useMemo(() => {
    return Number(data.travados30 || 0) + Number(data.prazosVencidos || 0) +
           Number(data.requisicoesPendentes || 0) + Number(data.prazosProx48h || 0);
  }, [data]);

  const handleClose = () => {
    try { sessionStorage.setItem(SESSION_FLAG, '1'); } catch {}
    onClose?.();
  };

  const handleSnoozeToday = () => {
    try {
      sessionStorage.setItem(SESSION_FLAG, '1');
      localStorage.setItem(SNOOZE_FLAG, String(Date.now() + 24 * 60 * 60 * 1000));
    } catch {}
    onClose?.();
  };

  const navAndClose = (to) => {
    handleClose();
    navigate(to);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={handleClose}
    >
      <div
        className="relative w-full max-w-3xl bg-[var(--bg)] border-2 panel-border rounded-2xl shadow-2xl overflow-hidden animate-pop-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header com gradient */}
        <div
          className="px-6 py-5 relative overflow-hidden"
          style={{
            background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent) 12%, var(--bg)), var(--bg))',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <button
            type="button"
            onClick={handleClose}
            className="absolute top-4 right-4 w-8 h-8 rounded-lg flex items-center justify-center hover:bg-[var(--panel)] transition-colors opacity-60 hover:opacity-100"
            title="Fechar"
          >
            <X size={16} />
          </button>
          <div className="flex items-center gap-3">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center"
              style={{ background: 'color-mix(in srgb, var(--accent) 22%, transparent)' }}
            >
              <Sparkles size={24} style={{ color: 'var(--accent)' }} />
            </div>
            <div>
              <div className="text-2xl font-extrabold tracking-tight">
                {saudacao()}{(user?.nome_usuario || user?.nome) ? `, ${user?.nome_usuario || user?.nome}` : ''}
              </div>
              <div className="text-xs opacity-60 capitalize mt-0.5">{diaDaSemana()}</div>
            </div>
          </div>

          <div className="mt-4 text-sm opacity-85 flex items-center gap-2">
            {loading ? (
              <span className="inline-flex items-center gap-2 opacity-60">
                <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                Carregando seu briefing operacional...
              </span>
            ) : totalAtencao > 0 ? (
              <>
                Você tem <b>{totalAtencao}</b> {totalAtencao === 1 ? 'item precisando' : 'itens precisando'} de atenção hoje.
              </>
            ) : (
              <>Tudo em dia por aqui — bom trabalho!</>
            )}
            {refreshing && !loading && (
              <span
                className="inline-block w-2 h-2 rounded-full opacity-60"
                style={{ background: 'var(--accent)', animation: 'pulse 1.4s ease-in-out infinite' }}
                title="Atualizando dados..."
              />
            )}
          </div>
        </div>

        {/* Body — cards de atenção */}
        <div className="px-6 py-5">
          <div className="text-[11px] uppercase tracking-wide opacity-60 font-semibold mb-3">
            Atenção hoje
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <AtentionCard
              icon={CalendarClock}
              label="Prazos nas próximas 48h"
              value={loading ? '—' : (data.prazosProx48h ?? 0)}
              hint="Vencimento iminente"
              severity={data.prazosProx48h > 0 ? 'warn' : 'ok'}
              onClick={() => navAndClose('/')}
            />
            <AtentionCard
              icon={AlertTriangle}
              label="Prazos vencidos"
              value={loading ? '—' : (data.prazosVencidos ?? 0)}
              hint="Já passaram do prazo"
              severity={data.prazosVencidos > 5 ? 'crit' : data.prazosVencidos > 0 ? 'warn' : 'ok'}
              onClick={() => navAndClose('/')}
            />
            <AtentionCard
              icon={Clock}
              label="Travados +30 dias"
              value={loading ? '—' : (data.travados30 ?? 0)}
              hint="Sem movimentação"
              severity={data.travados30 > 50 ? 'crit' : data.travados30 > 10 ? 'warn' : 'ok'}
              onClick={() => navAndClose('/processos')}
            />
            <AtentionCard
              icon={Inbox}
              label="Requisições pendentes"
              value={loading ? '—' : (data.requisicoesPendentes ?? 0)}
              hint="Aguardando triagem"
              severity={data.requisicoesPendentes > 10 ? 'warn' : 'info'}
              onClick={() => navAndClose('/Requisicoes')}
            />
          </div>

          {/* Meta mensal */}
          <div className="mt-6 text-[11px] uppercase tracking-wide opacity-60 font-semibold mb-3">
            Meta mensal de ressarcimento
          </div>
          {(() => {
            const atingido = Number(data.metaMensalAtingido || 0);
            const meta = META_MENSAL;
            const pct = meta > 0 ? Math.min(200, (atingido / meta) * 100) : 0;
            const color = pct >= 100 ? '#10b981' : pct >= 66 ? '#3b82f6' : pct >= 33 ? '#f59e0b' : '#ef4444';
            const restante = Math.max(0, meta - atingido);
            const mes = new Date().toLocaleDateString('pt-BR', { month: 'long' });
            return (
              <div
                className="rounded-xl border-2 px-5 py-4"
                style={{
                  background: `color-mix(in srgb, ${color} 8%, var(--panel))`,
                  borderColor: `color-mix(in srgb, ${color} 35%, transparent)`,
                }}
              >
                <div className="flex items-start gap-3 mb-3">
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: `color-mix(in srgb, ${color} 18%, transparent)` }}
                  >
                    <Target size={18} style={{ color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] uppercase tracking-wide opacity-60 capitalize">
                      {mes}
                    </div>
                    <div className="flex items-baseline gap-2 mt-0.5">
                      <span className="text-2xl font-extrabold tabular-nums" style={{ color }}>
                        {loading ? '—' : fmtMM(atingido)}
                      </span>
                      <span className="text-xs opacity-60">de {fmtMM(meta)}</span>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-3xl font-extrabold tabular-nums leading-none" style={{ color }}>
                      {loading ? '—' : `${Math.round(pct)}%`}
                    </div>
                    <div className="text-[10px] opacity-60 mt-1">atingido</div>
                  </div>
                </div>
                <div className="h-2.5 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
                  <div
                    className="h-full transition-all"
                    style={{
                      width: `${Math.min(100, pct)}%`,
                      background: color,
                    }}
                  />
                </div>
                <div className="mt-2 flex justify-between text-[11px] opacity-60">
                  <span>
                    {pct >= 100 ? '🎉 Meta superada' : `Faltam ${fmtMM(restante)} para a meta`}
                  </span>
                  {pct >= 100 && atingido > meta && (
                    <span style={{ color }}>
                      +{fmtMM(atingido - meta)} acima
                    </span>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Atalhos */}
          <div className="mt-6 text-[11px] uppercase tracking-wide opacity-60 font-semibold mb-3">
            Atalhos
          </div>
          <div className="flex flex-wrap gap-2">
            <ShortcutButton icon={FilePlus} label="Nova requisição" onClick={() => navAndClose('/novo')} accent="#3b82f6" />
            <ShortcutButton icon={LayoutDashboard} label="Controle de Processos" onClick={() => navAndClose('/processos')} accent="#10b981" />
            <ShortcutButton icon={Mail} label="Caixa de Email" onClick={() => navAndClose('/caixa-de-email')} accent="#f59e0b" />
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t panel-border bg-[var(--panel)]/40 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={handleSnoozeToday}
            className="text-xs opacity-60 hover:opacity-100 underline transition-opacity"
          >
            Não mostrar hoje
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="px-5 py-2 rounded-lg bg-[var(--accent)] text-white font-semibold text-sm hover:opacity-90 transition-opacity"
          >
            Continuar
          </button>
        </div>
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
        .animate-fade-in { animation: fadeIn .2s ease-out both }
        @keyframes popIn { from { opacity: 0; transform: scale(.96) translateY(8px) } to { opacity: 1; transform: scale(1) translateY(0) } }
        .animate-pop-in { animation: popIn .28s cubic-bezier(0.4, 0, 0.2, 1) both }
        @keyframes pulse { 0%, 100% { opacity: .6 } 50% { opacity: 1 } }
      `}</style>
    </div>,
    document.body,
  );
}

// Helper: decide se deve mostrar o modal nesta visita
export function shouldShowWelcomeModal(user) {
  const role = String(user?.tipo_conta || '').toLowerCase();
  if (role !== 'gestor' && role !== 'admin') return false;
  try {
    if (sessionStorage.getItem(SESSION_FLAG) === '1') return false;
    const snooze = Number(localStorage.getItem(SNOOZE_FLAG) || 0);
    if (snooze && Date.now() < snooze) return false;
  } catch {}
  return true;
}
