// src/components/requisicoes/RequisicaoCard.jsx
//
// Card de requisição no Kanban (status, UC, cliente, valor, anexos, faturas, score).
// Extraído de AdminPlanilha.jsx (linha 245).
//
import React, { useEffect, useMemo } from 'react';
import { Trash2, Clock, Paperclip, FileText } from 'lucide-react';
import {
  norm,
  unwrapDbValue,
  pickFirst,
  normalizeReqStatusValue,
  formatCurrencyBR,
  useTimer,
} from '../../pages/utils/processosHelpers.js';

const RequisicaoCard = ({ requisicao, onOpen, onReject, scoreData, onScoreLoad }) => {
  const now = useTimer();
  const calcAprovado = useMemo(() => {
    const dataBaseStr = requisicao?.data_mudanca_status;
    const statusNorm = norm(unwrapDbValue(requisicao?.status));
    const isAprovado = statusNorm.includes('aprov');
    if (!dataBaseStr || new Date(dataBaseStr).getFullYear() < 2000 || !isAprovado) {
      return { text: '-' };
    }
    const base = new Date(dataBaseStr);
    const diff = now.getTime() - base.getTime();
    const dias = Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
    return { text: `Aprovado a ${dias} dias` };
  }, [requisicao?.status, requisicao?.data_mudanca_status, now]);

  const id = requisicao?.id ?? requisicao?.id_requisicao ?? requisicao?.ID ?? '';
  const cliente = unwrapDbValue(requisicao?.cliente) || 'Cliente não definido';
  const uc = unwrapDbValue(requisicao?.uc) || 'N/A';
  const statusLabel = normalizeReqStatusValue(requisicao?.status || 'Nova Requisição');
  const valor = pickFirst(requisicao, ['valor_estimado', 'ressarcimento_estimado', 'valor'], '');
  const anexos = Number(
    pickFirst(requisicao, ['anexos', 'anexos_count', 'qtd_anexos', 'total_anexos', 'anexosTotal'], 0),
  );
  const faturas = Number(
    pickFirst(requisicao, ['faturas', 'faturas_count', 'qtd_faturas', 'total_faturas', 'faturasTotal'], 0),
  );
  const statusColor =
    norm(statusLabel).includes('aprov') ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30' :
    norm(statusLabel).includes('rejeit') ? 'text-red-500 bg-red-500/10 border-red-500/30' :
    norm(statusLabel).includes('analise') ? 'text-amber-500 bg-amber-500/10 border-amber-500/30' :
    'text-sky-500 bg-sky-500/10 border-sky-500/30';

  useEffect(() => {
    if (id) onScoreLoad?.(id);
  }, [id, onScoreLoad]);

  const score = scoreData?.[id];
  const isRejected = norm(statusLabel).includes('rejeit');

  return (
    <div
      className="glass-card gradient-card shadow-medium p-3 rounded-lg border border-[var(--border)] text-[var(--fg)] space-y-2 flex flex-col cursor-pointer"
      onClick={() => onOpen?.(requisicao)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-bold text-[var(--accent)]">REQ-{String(id).padStart(3, '0')}</div>
          <div className="text-[11px] opacity-70">UC {uc}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] px-2 py-0.5 rounded-full border ${statusColor}`}>
            {statusLabel}
          </span>
          <span
            role="button"
            tabIndex={0}
            className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-red-500/10"
            title="Rejeitar requisição"
            onClick={(e) => {
              e.stopPropagation();
              onReject?.(requisicao);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onReject?.(requisicao);
              }
            }}
          >
            <Trash2 size={12} className="text-red-500 opacity-90" />
          </span>
        </div>
      </div>

      <div className="text-xs font-semibold truncate">{cliente}</div>
      <div className="text-xs font-bold text-emerald-500">{formatCurrencyBR(valor)}</div>
      <div className="flex justify-between items-center text-[11px] opacity-70">
        <span className="flex items-center gap-1"><Clock size={12} /> {calcAprovado.text}</span>
      </div>

      <div className="flex gap-2 pt-2 border-t border-[var(--border)] text-[11px]">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--panel-border)]">
          <Paperclip size={12} /> Anexos {Number.isFinite(anexos) ? anexos : 0}
        </span>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--panel-border)]">
          <FileText size={12} /> Faturas {Number.isFinite(faturas) ? faturas : 0}
        </span>
      </div>

      {score !== undefined && !isRejected && (
        <div className="pt-2 border-t border-[var(--border)] opacity-50">
          <div className="text-[9px] opacity-60">
            Score: {score?.percentual?.toFixed(0)}%
          </div>
        </div>
      )}
    </div>
  );
};

export default RequisicaoCard;
