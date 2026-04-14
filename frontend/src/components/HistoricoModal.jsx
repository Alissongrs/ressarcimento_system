import React, { useEffect, useMemo, useState } from 'react';
import {
  X,
  Clock,
  User,
  MessageSquare,
  Mail,
  ArrowRight,
  Circle,
  CheckCircle,
  Flag,
  BadgeCheck,
  Building2,
  Headset,
  Scale,
  ShieldCheck,
  Clock4,
  CheckCircle2,
  DollarSign,
  Send,
} from 'lucide-react';
import { getHistoricoById, getRequisicaoById } from '../services/requisicaoService';

export default function HistoricoModal({ isOpen, onClose, processoId, anchorTop }) {
  const [itens, setItens] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [descricaoProblema, setDescricaoProblema] = useState('');
  const openMailShortcut = (mailGraphMessageId) => {
    const id = String(mailGraphMessageId || '').trim();
    if (!id) return;
    window.location.href = `/caixa-de-email?messageId=${encodeURIComponent(id)}`;
  };

  const normalizeText = (s) => {
    try {
      return String(s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    } catch {
      return String(s || '').toLowerCase();
    }
  };
  const fixMojibake = (s) => {
    const str = String(s || '');
    if (!/[ÃÂ]/.test(str)) return str;
    try {
      const bytes = Uint8Array.from(str, (c) => c.charCodeAt(0));
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      return str;
    }
  };
  const formatDateBR = (d) => {
    if (!d) return '';
    try {
      return d.toLocaleDateString('pt-BR');
    } catch {
      return '';
    }
  };
  const roadmap = useMemo(() => {
    if (!Array.isArray(itens) || itens.length === 0) {
      return { stages: [], currentStageKey: '', currentSub: '', distribSubs: [] };
    }

    const normalize = (s) => {
      try {
        return String(s || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase();
      } catch {
        return String(s || '').toLowerCase();
      }
    };

    const getStep = (item) => {
      const etapaRaw =
        item?.etapa_nova ||
        item?.etapa ||
        item?.etapa_atual ||
        item?.etapaAtual ||
        '';
      const subRaw = item?.sub_etapa || '';
      let etapa = String(etapaRaw || '').trim();
      let sub = String(subRaw || '').trim();

      if ((!etapa || !sub) && item?.status_composto) {
        const parts = String(item.status_composto).split('-').map((p) => p.trim());
        if (!etapa && parts.length) etapa = parts[0];
        if (!sub && parts.length > 1) sub = parts.slice(1).join(' - ');
      }

      return { etapa: etapa || 'N/A', sub: sub || '' };
    };

    const toDate = (value) => {
      if (!value) return null;
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    };

    const stageOrder = [
      'Criação',
      'Aprovação',
      'Distribuidora',
      'Ouvidoria',
      'ANEEL',
      'SMA',
      'Pendente',
      'Em Conciliação',
      'Em Contestação',
      'Repasse Amee',
      'Enviado ao Financeiro',
      'Concluído',
    ];

    let latest = null;
    itens.forEach((item, idx) => {
      const date = toDate(item?.data_movimentacao || item?.quando || item?.data);
      const rank = date ? date.getTime() : idx;
      if (!latest || rank > latest.rank) {
        latest = { item, rank };
      }
    });

    const currentStep = latest ? getStep(latest.item) : { etapa: 'N/A', sub: '' };
    const lastDate = latest ? toDate(latest.item?.data_movimentacao || latest.item?.quando || latest.item?.data) : null;
    const currentStageKey = normalize(currentStep.etapa);
    const normalizedStages = stageOrder.map(normalize);
    let currentStageIdx = normalizedStages.indexOf(currentStageKey);
    if (currentStageIdx < 0 && currentStageKey) {
      const hit = normalizedStages.findIndex((s) => currentStageKey.includes(s));
      if (hit >= 0) currentStageIdx = hit;
    }

    const distribSubs = [];
    const seenSubs = new Set();
    itens.forEach((item) => {
      const step = getStep(item);
      if (normalize(step.etapa) === 'distribuidora' && step.sub) {
        const key = normalize(step.sub);
        if (!seenSubs.has(key)) {
          seenSubs.add(key);
          distribSubs.push(step.sub);
        }
      }
    });

    const stages = stageOrder.map((label, idx) => {
      let state = 'future';
      if (currentStageIdx >= 0) {
        if (idx < currentStageIdx) state = 'done';
        if (idx === currentStageIdx) state = 'current';
      }
      return { label, key: normalize(label), state };
    });

    const stageLabelMap = Object.fromEntries(stageOrder.map((label) => [normalize(label), label]));
    const stageRanges = {};
    const events = itens
      .map((item, idx) => ({
        item,
        idx,
        date: toDate(item?.data_movimentacao || item?.quando || item?.data),
      }))
      .filter((e) => e.date)
      .sort((a, b) => a.date - b.date || a.idx - b.idx);

    let currentKey = null;
    let currentStart = null;
    events.forEach((ev) => {
      const step = getStep(ev.item);
      const key = normalize(step.etapa);
      if (!key) return;
      if (currentKey === null) {
        currentKey = key;
        currentStart = ev.date;
        return;
      }
      if (key !== currentKey) {
        if (!stageRanges[currentKey]) stageRanges[currentKey] = [];
        stageRanges[currentKey].push({ start: currentStart, end: ev.date });
        currentKey = key;
        currentStart = ev.date;
      }
    });
    if (currentKey) {
      if (!stageRanges[currentKey]) stageRanges[currentKey] = [];
      stageRanges[currentKey].push({ start: currentStart, end: null });
    }

    const descricao = (() => {
      const first = itens.find((item) => item?.descricao || item?.comentario || item?.problema_identificado);
      return first?.descricao || first?.comentario || first?.problema_identificado || '';
    })();

    return {
      stages,
      currentStageKey,
      currentSub: currentStep.sub,
      distribSubs,
      stageMap: Object.fromEntries(stages.map((s) => [s.key, s])),
      stageLabelMap,
      stageRanges,
      lastDate,
      descricao,
    };
  }, [itens]);
  useEffect(() => {
    if (!isOpen || !processoId) return;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const [rows, req] = await Promise.all([
          getHistoricoById(processoId),
          getRequisicaoById(processoId),
        ]);
        setItens(Array.isArray(rows) ? rows : []);
        const desc =
          req?.descricao_irregularidade ||
          req?.descricaoIrregularidade ||
          req?.descricao ||
          '';
        setDescricaoProblema(desc || '');
      } catch (e) {
        setError('Falha ao carregar histórico.');
      } finally {
        setLoading(false);
      }
    })();
  }, [isOpen, processoId]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60" role="dialog" aria-modal="true">
      <div
        className="fixed w-[calc(100%-3rem)] max-w-5xl rounded-xl border border-[var(--border)] bg-[var(--panel)] text-[var(--fg)] shadow-elevated flex flex-col"
        style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)', maxHeight: '86vh' }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <h2 className="text-lg font-bold">Histórico do processo REQ-{String(processoId).padStart(3,'0')}</h2>
          <button onClick={onClose} className="p-2 rounded hover:bg-[var(--border)]/20" aria-label="Fechar">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {roadmap.stages.length > 0 && (
  <div className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--card)]/40 p-4">
    <div className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold">Roadmap do processo</div>
    <div className="mt-3 grid gap-4">
      <div>
        <div className="text-sm font-semibold text-[var(--fg)]">Em andamento</div>
        <div className="mt-2 space-y-2">
            {[
              { key: 'distribuidora', label: 'Distribuidora', Icon: Building2 },
              { key: 'ouvidoria', label: 'Ouvidoria', Icon: Headset },
              { key: 'aneel', label: 'ANEEL', Icon: Scale },
              { key: 'sma', label: 'SMA', Icon: ShieldCheck },
            ].map((item) => {
              const stage = roadmap.stageMap[normalizeText(item.key)];
              const isCurrent = stage?.state === 'current';
              const isCurrentStage = isCurrent || normalizeText(item.label) === normalizeText(roadmap.currentStageKey);
              const isDone = stage?.state === 'done';
              const isDistribuidora = normalizeText(item.key) === 'distribuidora';
              const ranges = roadmap.stageRanges[normalizeText(item.key)] || [];
              return (
                <div key={item.key} className="flex flex-col gap-1 text-sm">
                  <div className="flex items-center gap-3">
                  {isDistribuidora ? (
                    <CheckCircle2 size={16} className="text-emerald-500" />
                  ) : (
                    <span className={`h-3.5 w-3.5 rounded-full ${isCurrent ? 'bg-[var(--accent)] animate-pulse' : isDone ? 'bg-gray-400' : 'bg-gray-500'}`} />
                  )}
                  <item.Icon
                    size={18}
                    className={
                      isDistribuidora
                        ? 'text-[var(--accent)]'
                        : isCurrent
                          ? 'text-[var(--accent)]'
                          : isDone
                            ? 'text-gray-400'
                            : 'text-gray-500'
                    }
                  />
                  <span
                    className={
                      isDistribuidora
                        ? 'text-[var(--fg)] font-semibold'
                        : isCurrent
                          ? 'text-[var(--accent)] font-semibold'
                          : isDone
                            ? 'text-gray-200'
                            : 'text-gray-300'
                    }
                  >
                    {item.label}
                  </span>
                  </div>
                  {ranges.length > 0 && (
                    <div className="ml-7 text-[11px] text-gray-400 space-y-1">
                      {ranges.map((seg, rIdx) => (
                        <div key={`${item.key}-${rIdx}`}>
                          {item.label} - Processo de {formatDateBR(seg.start)}{' '}
                          {seg.end == null || (isCurrentStage && rIdx === ranges.length - 1)
                            ? 'até o momento'
                            : `até ${formatDateBR(seg.end)}`}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      </div>
      <div>
        <div className="text-sm font-semibold text-[var(--fg)]">Deferidos</div>
        <div className="mt-2 space-y-2">
          {[
            { key: 'repasse amee', label: 'Repasse Amee', Icon: DollarSign },
            { key: 'enviado ao financeiro', label: 'Enviado ao Financeiro', Icon: Send },
            { key: 'concluído', label: 'Concluído', Icon: Circle },
          ].map((item) => {
            const stage = roadmap.stageMap[normalizeText(item.key)];
            const isCurrent = stage?.state === 'current';
            const isDone = stage?.state === 'done';
            const isConcluido = normalizeText(item.key) === 'concluido';
            const ranges = roadmap.stageRanges[normalizeText(item.key)] || [];
            return (
              <div key={item.key} className="flex flex-col gap-1 text-sm">
                <div className="flex items-center gap-3">
                <span
                  className={`h-3.5 w-3.5 rounded-full ${
                    isConcluido
                      ? 'bg-white'
                      : isCurrent
                        ? 'bg-[var(--accent)] animate-pulse'
                        : isDone
                          ? 'bg-gray-400'
                          : 'bg-gray-500'
                  }`}
                />
                {!isConcluido && (
                  <item.Icon size={18} className={isCurrent ? 'text-[var(--accent)]' : isDone ? 'text-gray-400' : 'text-gray-500'} />
                )}
                <span className={isCurrent ? 'text-[var(--accent)] font-semibold' : isDone ? 'text-gray-200' : 'text-gray-300'}>{item.label}</span>
                </div>
                {ranges.length > 0 && (
                  <div className="ml-7 text-[11px] text-gray-400 space-y-1">
                    {ranges.map((seg, rIdx) => (
                      <div key={`${item.key}-${rIdx}`}>
                        {item.label} - Processo de {formatDateBR(seg.start)}{' '}
                        {seg.end ? `até ${formatDateBR(seg.end)}` : 'até o momento'}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {roadmap.distribSubs.length > 0 && (
        <div className="mt-2 pl-4 border-l border-[var(--border)]">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide font-semibold text-[var(--fg)]">
            Distribuidora
            <span className="normal-case text-[11px] text-gray-400">
              Em análise
              {roadmap.lastDate ? (
                <> · há {Math.max(0, Math.ceil((Date.now() - roadmap.lastDate.getTime()) / 86400000))} dias</>
              ) : null}
            </span>
          </div>
          <div className="mt-2 space-y-2">
            {roadmap.distribSubs.map((sub) => {
              const isCurrentSub = normalizeText(sub) === normalizeText(roadmap.currentSub);
              return (
                <div key={sub} className="flex items-center gap-2 text-xs">
                  <span className={`h-3 w-3 rounded-full ${isCurrentSub ? 'bg-[var(--accent)] animate-pulse' : 'bg-gray-500'}`} />
                  <span className={isCurrentSub ? 'text-[var(--accent)] font-semibold' : 'text-gray-300'}>{sub}</span>
                </div>
              );
            })}
          </div>
          {descricaoProblema && (
            <div className="mt-2 text-[11px] text-[var(--fg)]/80">
              Descrição: {fixMojibake(descricaoProblema)}
            </div>
          )}
        </div>
      )}
    </div>
  </div>
)}
          {loading ? (
            <div className="py-10 text-center opacity-80 sap-loading">Carregando...</div>
          ) : error ? (
            <div className="py-10 text-center text-red-400">{error}</div>
          ) : itens.length === 0 ? (
            <div className="py-10 text-center opacity-80">Nenhuma movimentação encontrada.</div>
          ) : (
            <div className="space-y-4">
              {itens.map((h, idx) => {
                const quando = h?.data_movimentacao || h?.quando || '';
                const usuario = fixMojibake(h?.nome_usuario || h?.usuario_nome || '');
                const status = fixMojibake(h?.status_composto || h?.status_novo || '');
                const tipo = h?.tipo_movimentacao || '';
                const isEmail = String(tipo || '').toLowerCase() === 'email';
                const mailGraphMessageId = String(h?.mail_graph_message_id || '').trim();
                const comentario = fixMojibake(h?.comentario || '');
                return (
                  <div key={idx} className="rounded-lg border border-[var(--border)] p-3 bg-[var(--card)]/40">
                    <div className="flex items-center justify-between text-xs opacity-80">
                      <div className="inline-flex items-center gap-1"><Clock size={12} /> {quando || '-'}</div>
                      <div className="inline-flex items-center gap-1"><User size={12} /> {usuario || 'Sistema'}</div>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <div className="text-sm font-semibold">{status || 'Sem status'}</div>
                      {isEmail && (
                        <>
                          <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--fg)]/70 bg-[var(--card)]/40">
                            <Mail size={12} /> E-mail
                          </span>
                          {mailGraphMessageId && (
                            <button
                              type="button"
                              onClick={() => openMailShortcut(mailGraphMessageId)}
                              className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-[var(--border)] hover:bg-[var(--border)]/20"
                            >
                              <ArrowRight size={12} /> Abrir e-mail
                            </button>
                          )}
                        </>
                      )}
                      {!isEmail && tipo && (
                        <span className="text-[11px] opacity-70">Tipo: {tipo}</span>
                      )}
                    </div>
                    {comentario && (
                      <div className="mt-2 text-sm flex items-start gap-2">
                        <MessageSquare size={14} className="opacity-70 mt-0.5" />
                        <div>{comentario}</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-[var(--border)] text-right">
          <button onClick={onClose} className="px-3 py-2 rounded border border-[var(--border)] hover:bg-[var(--border)]/20">Fechar</button>
        </div>
      </div>
    </div>
  );
}






