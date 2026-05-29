// src/components/processos/ProcessoCard.jsx
//
// Card de processo no Kanban (UC, cliente, concessionária, dias sem mover, valor).
// Extraído de AdminPlanilha.jsx (linha 1078).
//
import React, { memo, useMemo } from 'react';
import { Trash2 } from 'lucide-react';
import {
  pickFirst,
  getSubEtapaFromStatus,
  toTs,
  formatCurrencyBR,
  formatDecimalInput,
} from '../../pages/utils/processosHelpers.js';

const ProcessoCard = memo(function ProcessoCard({ row, onOpen, onIndeferir }) {
  const { pid, header, category } = row;
  const uc = pickFirst(header, ['uc', 'Uc', 'UC']);
  const cliente = pickFirst(header, ['cliente', 'Cliente']);
  const concess = pickFirst(header, ['concessionaria', 'Concessionaria']);
  const lastMoveTs = useMemo(() => {
    const hist = Array.isArray(row?.history) ? row.history : [];
    let max = 0;
    hist.forEach((h) => {
      const etapaVal = pickFirst(h, ['etapa', 'etapa_nova', 'Etapa'], '');
      const subVal = getSubEtapaFromStatus(h);
      if (!String(etapaVal || '').trim() && !String(subVal || '').trim()) return;
      const dtRaw = pickFirst(h, ['hist_data', 'data_movimentacao', 'data', 'created_at'], '');
      const ts = toTs(dtRaw);
      if (ts > max) max = ts;
    });
    return max || 0;
  }, [row?.history]);
  const lastDays = lastMoveTs ? Math.max(0, Math.floor((Date.now() - lastMoveTs) / (1000 * 60 * 60 * 24))) : null;

  const repasseSimples = header?.repasse_simples ?? '';
  const repasseDobro = header?.repasse_dobro ?? '';
  const showRepasse = String(repasseSimples || '').trim() || String(repasseDobro || '').trim();

  const estimadoRaw = pickFirst(header, ['ressarcimento_estimado', 'valor_estimado', 'valor'], '');
  const showEstimado = String(estimadoRaw || '').trim();

  const hasSeqError = (() => {
    const h = header || {};
    const hasDefer = String(h.data_simples || h.data_procedencia || h.data_dobro || h.data_credito_dobro || '').trim();
    const hasFluxo = String(h.valor_fluxo || h.data_envio_financeiro || '').trim();
    const hasFat = String(h.numero_nf || h.data_emissao || h.data_vencimento || h.data_pagamento || h.valor_nf || '').trim();
    return (hasFluxo || hasFat) && !hasDefer;
  })();

  return (
    <button
      onClick={() => onOpen(row)}
      className="text-left p-2 rounded-xl border panel-border processo-card hover:opacity-95 transition min-h-[84px] text-[var(--fg)]"
      title={hasSeqError ? 'Sequência incompleta: Fluxo/Faturamento sem Deferidos' : 'Abrir detalhes'}
      type="button"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] uppercase tracking-wide opacity-80">Processo</div>
        <div className="flex items-center gap-2">
          {hasSeqError && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded border border-red-500 text-red-500"
              title="Sequência incompleta: Fluxo/Faturamento sem Deferidos"
            >
              Sequência
            </span>
          )}
          <span
            role="button"
            tabIndex={0}
            className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-red-500/10"
            title="Indeferir processo"
            onClick={(e) => {
              e.stopPropagation();
              onIndeferir?.(row);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onIndeferir?.(row);
              }
            }}
          >
            <Trash2 size={12} className="text-red-500 opacity-90" />
          </span>
          <div className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--muted)]/70 opacity-90">
            {category}
          </div>
        </div>
      </div>

      <div className="mt-1 flex items-baseline justify-between gap-2">
        <div className="text-lg font-extrabold leading-tight">#{pid}</div>
        <div className="text-xs opacity-80 truncate max-w-[140px]">UC {uc}</div>
      </div>

      <div className="text-xs mt-1 truncate opacity-95">{cliente}</div>
      <div className="text-[11px] mt-0.5 truncate opacity-80">{concess}</div>
      {lastDays != null && (
        <div className="text-[11px] mt-1 opacity-75">Última mov.: {lastDays} dias</div>
      )}

      {showEstimado ? (
        <div className="text-[11px] mt-1 truncate opacity-85">
          Estimado: {formatCurrencyBR(estimadoRaw)}
        </div>
      ) : null}

      {showRepasse ? (
        <div className="text-[11px] mt-0.5 truncate opacity-85">
          Repasse: {formatDecimalInput(repasseSimples) || '-'}
          {repasseDobro ? ` / ${formatDecimalInput(repasseDobro)}` : ''}
        </div>
      ) : null}
    </button>
  );
});

export default ProcessoCard;
