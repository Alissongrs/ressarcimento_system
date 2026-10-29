// src/components/AdminSnapshotIntegration.jsx
// Integração de edição rápida do Snapshot no AdminEditor e AdminPlanilha

import React, { useState } from 'react';
import { Edit3, Loader } from 'lucide-react';
import ProcessoSnapshotModal from './ProcessoSnapshotModal';

/**
 * Hook customizado para gerenciar modal de snapshot
 */
export function useProcessoSnapshotModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState(null);

  const openModal = (idProcesso) => {
    setSelectedId(idProcesso);
    setIsOpen(true);
  };

  const closeModal = () => {
    setIsOpen(false);
    setSelectedId(null);
  };

  return { isOpen, selectedId, openModal, closeModal };
}

/**
 * Botão para abrir o modal de edição do snapshot
 */
export function EditSnapshotButton({ idProcesso, onSuccess, className = '', size = 'md' }) {
  const { openModal } = useProcessoSnapshotModal();

  const sizeClasses = {
    sm: 'px-2 py-1 text-sm',
    md: 'px-3 py-2 text-base',
    lg: 'px-4 py-2 text-lg',
  };

  return (
    <button
      onClick={() => openModal(idProcesso)}
      title="Editar dados do snapshot"
      className={`inline-flex items-center gap-2 bg-[var(--accent)] text-white rounded hover:bg-[color-mix(in_srgb,var(--accent)_85%,black)] transition-colors ${sizeClasses[size]} ${className}`}
    >
      <Edit3 size={16} />
      <span>Editar Snapshot</span>
    </button>
  );
}

/**
 * Componente que renderiza o Modal
 * Deve ser usado no componente pai (AdminEditor)
 */
export function ProcessoSnapshotModalWrapper({ isOpen, idProcesso, onClose, onSuccess }) {
  return (
    <ProcessoSnapshotModal
      isOpen={isOpen}
      onClose={onClose}
      idProcesso={idProcesso}
      onSuccess={onSuccess}
    />
  );
}

/**
 * Seção de informações do snapshot (para exibir em AdminEditor)
 */
export function SnapshotInfoSection({ processoData, onEditClick }) {
  if (!processoData || !processoData.id_processo) {
    return null;
  }

  return (
    <div className="bg-[color-mix(in_srgb,var(--accent)_10%,var(--card))] border border-[color-mix(in_srgb,var(--accent)_30%,var(--card))] rounded-lg p-4 mb-4">
      <div className="flex justify-between items-start mb-3">
        <h3 className="font-bold text-[var(--accent)]">Informações do Snapshot</h3>
        <button
          onClick={() => onEditClick(processoData.id_processo)}
          className="text-[var(--accent)] hover:opacity-80 font-medium text-sm"
        >
          Editar Tudo
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
        <InfoItem label="UC" value={processoData.uc} />
        <InfoItem label="Cliente" value={processoData.cliente} />
        <InfoItem label="Concessionária" value={processoData.concessionaria} />
        <InfoItem label="Status" value={processoData.status_class} />
        <InfoItem label="Etapa" value={processoData.etapa_nome} />
        <InfoItem label="Sub-Etapa" value={processoData.sub_etapa} />

        {processoData.suspenso === 1 && (
          <>
            <div className="md:col-span-3 p-2 bg-[color-mix(in_srgb,var(--danger)_15%,var(--card))] rounded text-[var(--danger)] text-xs font-medium">
              ⚠️ Processo Suspenso: {processoData.suspenso_motivo || 'Sem motivo informado'}
            </div>
          </>
        )}

        {(processoData.credito_simples || processoData.credito_dobro) && (
          <>
            <InfoItem
              label="Crédito Simples"
              value={processoData.credito_simples ? `R$ ${processoData.credito_simples.toFixed(2)}` : '-'}
            />
            <InfoItem
              label="Crédito Dobro"
              value={processoData.credito_dobro ? `R$ ${processoData.credito_dobro.toFixed(2)}` : '-'}
            />
          </>
        )}

        {processoData.valor_ressarcimento && (
          <InfoItem
            label="Valor Ressarcimento"
            value={`R$ ${processoData.valor_ressarcimento.toFixed(2)}`}
          />
        )}

        {processoData.updated_at && (
          <InfoItem label="Atualizado em" value={formatDate(processoData.updated_at)} />
        )}
      </div>
    </div>
  );
}

/**
 * Componente de item de informação
 */
function InfoItem({ label, value }) {
  return (
    <div>
      <p className="text-[color-mix(in_srgb,var(--fg)_55%,transparent)] text-xs font-medium">{label}</p>
      <p className="text-[var(--fg)] font-semibold">{value || '-'}</p>
    </div>
  );
}

/**
 * Formata data para exibição
 */
function formatDate(dateStr) {
  if (!dateStr) return '-';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('pt-BR', { year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    return dateStr;
  }
}

/**
 * Comparador de snapshot - exibe quais campos foram alterados
 */
export function SnapshotChangesViewer({ original, updated }) {
  const getChangedFields = () => {
    if (!original || !updated) return [];

    const changes = [];
    for (const key of Object.keys(updated)) {
      if (original[key] !== updated[key]) {
        changes.push({
          field: key,
          oldValue: original[key],
          newValue: updated[key],
        });
      }
    }
    return changes;
  };

  const changes = getChangedFields();

  if (changes.length === 0) {
    return null;
  }

  return (
    <div className="p-4 bg-[color-mix(in_srgb,var(--warning)_10%,var(--card))] border border-[color-mix(in_srgb,var(--warning)_30%,var(--card))] rounded-lg mb-4">
      <h4 className="font-bold text-[var(--warning)] mb-3">Mudanças Detectadas ({changes.length})</h4>
      <ul className="space-y-2">
        {changes.map((change, idx) => (
          <li key={idx} className="text-sm text-[var(--warning)] flex justify-between">
            <span className="font-medium">{change.field}:</span>
            <span>
              <span className="text-[var(--danger)] line-through mr-2">{String(change.oldValue)}</span>
              <span className="text-[var(--success)]">→ {String(change.newValue)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Quick edit inline para campos simples (sem abrir modal)
 */
export function QuickEditField({ value, onChange, onSave, isLoading, fieldName }) {
  const [isEditing, setIsEditing] = useState(false);
  const [tempValue, setTempValue] = useState(value);

  const handleSave = async () => {
    await onSave(tempValue);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setTempValue(value);
    setIsEditing(false);
  };

  if (!isEditing) {
    return (
      <div className="flex items-center gap-2">
        <span className="flex-1">{value || '-'}</span>
        <button
          onClick={() => setIsEditing(true)}
          className="px-2 py-1 text-xs bg-[color-mix(in_srgb,var(--fg)_15%,var(--card))] hover:bg-[color-mix(in_srgb,var(--fg)_25%,var(--card))] rounded transition-colors"
        >
          Editar
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={tempValue}
        onChange={(e) => setTempValue(e.target.value)}
        className="flex-1 px-2 py-1 border border-[var(--accent)]/50 rounded"
        autoFocus
      />
      <button
        onClick={handleSave}
        disabled={isLoading}
        className="px-2 py-1 text-xs bg-[var(--success)] text-white hover:bg-[color-mix(in_srgb,var(--success)_85%,black)] rounded disabled:opacity-50"
      >
        {isLoading ? <Loader size={12} className="animate-spin" /> : 'OK'}
      </button>
      <button
        onClick={handleCancel}
        disabled={isLoading}
        className="px-2 py-1 text-xs bg-[color-mix(in_srgb,var(--fg)_25%,var(--card))] hover:bg-[color-mix(in_srgb,var(--fg)_35%,var(--card))] rounded disabled:opacity-50"
      >
        X
      </button>
    </div>
  );
}
