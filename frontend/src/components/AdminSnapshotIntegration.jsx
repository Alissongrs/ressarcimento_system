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
      className={`inline-flex items-center gap-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors ${sizeClasses[size]} ${className}`}
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
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
      <div className="flex justify-between items-start mb-3">
        <h3 className="font-bold text-blue-900">Informações do Snapshot</h3>
        <button
          onClick={() => onEditClick(processoData.id_processo)}
          className="text-blue-600 hover:text-blue-800 font-medium text-sm"
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
            <div className="md:col-span-3 p-2 bg-red-100 rounded text-red-800 text-xs font-medium">
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
      <p className="text-gray-600 text-xs font-medium">{label}</p>
      <p className="text-gray-900 font-semibold">{value || '-'}</p>
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
    <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg mb-4">
      <h4 className="font-bold text-yellow-900 mb-3">Mudanças Detectadas ({changes.length})</h4>
      <ul className="space-y-2">
        {changes.map((change, idx) => (
          <li key={idx} className="text-sm text-yellow-800 flex justify-between">
            <span className="font-medium">{change.field}:</span>
            <span>
              <span className="text-red-600 line-through mr-2">{String(change.oldValue)}</span>
              <span className="text-green-600">→ {String(change.newValue)}</span>
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
          className="px-2 py-1 text-xs bg-gray-200 hover:bg-gray-300 rounded transition-colors"
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
        className="flex-1 px-2 py-1 border border-blue-300 rounded"
        autoFocus
      />
      <button
        onClick={handleSave}
        disabled={isLoading}
        className="px-2 py-1 text-xs bg-green-500 text-white hover:bg-green-600 rounded disabled:opacity-50"
      >
        {isLoading ? <Loader size={12} className="animate-spin" /> : 'OK'}
      </button>
      <button
        onClick={handleCancel}
        disabled={isLoading}
        className="px-2 py-1 text-xs bg-gray-300 hover:bg-gray-400 rounded disabled:opacity-50"
      >
        X
      </button>
    </div>
  );
}
