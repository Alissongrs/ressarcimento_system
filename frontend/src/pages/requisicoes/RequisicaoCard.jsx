// src/pages/requisicoes/RequisicaoCard.jsx — extraído de Requisicoes.jsx em 12/11/2026 (melhoria 2: arquivos menores).
// Conteúdo idêntico ao original; só mudou de arquivo e ganhou export/import.

import { useEffect, useMemo } from 'react';
import { Clock, FileText, Paperclip, Trash2 } from 'lucide-react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { norm, normalizeReqStatusValue, pickFirst, unwrapDbValue, useTimer } from './util.js';
import { formatCurrencyBR } from './processoHelpers.js';


export const RequisicaoCard = ({ requisicao, onOpen, onReject, scoreData, onScoreLoad }) => {
  const now = useTimer();
  const criador =
    requisicao?.usuario_nome ||
    requisicao?.nome_usuario ||
    requisicao?.criado_por ||
    requisicao?.created_by ||
    requisicao?.autor ||
    requisicao?.solicitante_nome ||
    requisicao?.solicitante?.nome ||
    requisicao?.usuario?.nome ||
    '';
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
    norm(statusLabel).includes('aprov') ? 'text-[var(--success)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] border-[color-mix(in_srgb,var(--success)_30%,transparent)]' :
    norm(statusLabel).includes('rejeit') ? 'text-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] border-[color-mix(in_srgb,var(--danger)_30%,transparent)]' :
    norm(statusLabel).includes('analise') ? 'text-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] border-[color-mix(in_srgb,var(--warning)_30%,transparent)]' :
    'text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] border-[color-mix(in_srgb,var(--accent)_30%,transparent)]';

  // Trigger score load quando o card for renderizado
  // onScoreLoad (fetchScoreForRow) já faz dedup internamente — scoreData não precisa ser dep
  useEffect(() => {
    if (id) onScoreLoad?.(id);
  }, [id, onScoreLoad]);

  const score = scoreData?.[id];
  const isRejected = norm(statusLabel).includes('rejeit');
  // DESTAQUE (do backend): 'ouro' = VERDADEIRO conferido (ressarcimento real);
  // 'laranja' = CANDIDATO de recuperação em aberto (mérito legal a confirmar pela analista).
  const destaque = String(pickFirst(requisicao, ['destaque'], '') || '').toLowerCase();
  const criadorId = Number(pickFirst(requisicao, ['id_usuario', 'usuario_id', 'id_usuario_gestor', 'criado_por_id'], 0));
  const isLaranja = destaque === 'laranja' && !isRejected;
  const isOuro = !isLaranja && (destaque === 'ouro' || criadorId === 1) && !isRejected;

  return (
    <div
      className={`glass-card gradient-card shadow-medium p-3 rounded-lg border text-[var(--fg)] space-y-2 flex flex-col cursor-pointer ${isLaranja ? 'req-card-laranja' : isOuro ? 'req-card-ouro' : 'border-[var(--border)]'}`}
      onClick={() => onOpen?.(requisicao)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-bold text-[var(--accent)] flex items-center gap-1">
            {isOuro && (
              <span title="VERDADEIRO — ressarcimento conferido no PDF" style={{ color: '#7a5c00' }}>★</span>
            )}
            {isLaranja && (
              <span title="Candidato — recuperação em aberto, mérito legal a confirmar" style={{ color: '#a2470a' }}>◆</span>
            )}
            REQ-{String(id).padStart(3, '0')}
          </div>
          <div className="text-[11px] opacity-70">UC {uc}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] px-2 py-0.5 rounded-full border ${statusColor}`}>
            {statusLabel}
          </span>
          <span
            role="button"
            tabIndex={0}
            className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]"
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
            <Trash2 size={12} className="text-[var(--danger)] opacity-90" />
          </span>
        </div>
      </div>

      <div className="text-xs font-semibold truncate">{cliente}</div>
      <div className="text-xs font-bold text-[var(--success)]">{formatCurrencyBR(valor)}</div>
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

export const ReqDraggableCard = ({ id, disabled, children }) => {
  const { attributes, listeners, setNodeRef } = useDraggable({ id, disabled });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className={disabled ? '' : 'kanban-card-admin-draggable'}>
      {children}
    </div>
  );
};

export const ReqDroppableColumn = ({ id, children }) => {
  const { setNodeRef } = useDroppable({ id });
  return <div ref={setNodeRef}>{children}</div>;
};
