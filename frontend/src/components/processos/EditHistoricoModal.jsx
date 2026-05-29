// src/components/processos/EditHistoricoModal.jsx
//
// Modal de edição linha-a-linha do histórico do processo.
// Extraído de AdminPlanilha.jsx (linha 2424).
//
import React from 'react';
import { Paperclip } from 'lucide-react';
import {
  toDateTimeLocal,
  fromDateTimeLocal,
} from '../../pages/utils/processosHelpers.js';

export default function EditHistoricoModal({
  open,
  processoId,
  draft,
  setDraft,
  onAddRow,
  onRemoveRow,
  onClose,
  onSave,
  historyAnexoUploading,
  onAttachHistoryAnexo,
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-[var(--panel-processos)] border panel-border text-[var(--fg)] p-5 rounded-lg shadow-xl w-full max-w-5xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Editar histórico do processo #{processoId}</h2>
          <button className="btn-outline" onClick={onClose} type="button">
            Fechar
          </button>
        </div>

        <div className="flex gap-2 mt-3">
          <button className="btn-themed" onClick={onAddRow} type="button">
            + Adicionar linha
          </button>
          <button className="btn-outline" onClick={onSave} type="button">
            Salvar histórico
          </button>
        </div>

        <div className="mt-4 max-h-[60vh] overflow-auto border panel-border rounded">
          <div className="grid grid-cols-12 gap-2 p-2 text-xs font-semibold opacity-70 border-b panel-border">
            <div className="col-span-3">Data</div>
            <div className="col-span-2">Etapa</div>
            <div className="col-span-2">Sub-etapa</div>
            <div className="col-span-4">Comentário</div>
            <div className="col-span-1 text-right"></div>
          </div>

          {(draft || []).map((h, idx) => (
            <div key={`h-${idx}`} className="grid grid-cols-12 gap-2 p-2 border-b panel-border items-start">
              <input
                type="datetime-local"
                className="input-themed text-xs col-span-3"
                value={toDateTimeLocal(h.data)}
                onChange={(e) =>
                  setDraft((prev) => {
                    const arr = [...(prev || [])];
                    arr[idx] = { ...(arr[idx] || {}), data: fromDateTimeLocal(e.target.value) };
                    return arr;
                  })
                }
              />

              <input
                className="input-themed text-xs col-span-2"
                value={h.etapa_nova || ''}
                onChange={(e) =>
                  setDraft((prev) => {
                    const arr = [...(prev || [])];
                    arr[idx] = { ...(arr[idx] || {}), etapa_nova: e.target.value };
                    return arr;
                  })
                }
                placeholder="Etapa"
              />

              <input
                className="input-themed text-xs col-span-2"
                value={h.sub_etapa || ''}
                onChange={(e) =>
                  setDraft((prev) => {
                    const arr = [...(prev || [])];
                    arr[idx] = { ...(arr[idx] || {}), sub_etapa: e.target.value };
                    return arr;
                  })
                }
                placeholder="Sub-etapa"
              />

              <input
                className="input-themed text-xs col-span-4"
                value={h.comentario || ''}
                onChange={(e) =>
                  setDraft((prev) => {
                    const arr = [...(prev || [])];
                    arr[idx] = { ...(arr[idx] || {}), comentario: e.target.value };
                    return arr;
                  })
                }
                placeholder="Comentário"
              />

              <div className="col-span-1 flex justify-end gap-2">
                {h.id_historico && (
                  <label className="btn-outline text-xs cursor-pointer">
                    <Paperclip size={12} />
                    <input
                      type="file"
                      className="hidden"
                      disabled={!!historyAnexoUploading?.[h.id_historico]}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file && onAttachHistoryAnexo) onAttachHistoryAnexo(processoId, h.id_historico, file);
                        e.target.value = '';
                      }}
                    />
                  </label>
                )}

                <button className="btn-outline text-xs" onClick={() => onRemoveRow(idx)} type="button">
                  Remover
                </button>
              </div>
            </div>
          ))}

          {!draft?.length && <div className="p-3 text-sm opacity-70">Sem histórico carregado.</div>}
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button className="btn-outline" onClick={onClose} type="button">
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
