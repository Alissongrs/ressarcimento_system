// src/components/processos/MovePane.jsx
//
// Pane lateral de movimentação de processo (escolha coluna + etapa + sub-etapa,
// canais de comunicação, anexo opcional, comentário). Submete para
// movimentarProcesso() do service.
//
// Extraído de AdminPlanilha.jsx (linha 2560).
//
import React from 'react';
import { confirmAction } from '../../utils/confirm.js';
import { movimentarProcesso } from '../../services/requisicaoService';
import {
  KANBAN_ETAPAS,
  KANBAN_COLUNAS,
  MAPA_COLUNAS_PARA_ETAPAS,
  SUBETAPAS_DEFERIDOS,
  DEFAULT_CANAIS,
  pickFirst,
  buildComentarioFinal,
} from '../../pages/utils/processosHelpers.js';
import Field from './Field.jsx';
import CanaisSelector from './CanaisSelector.jsx';

export default function MovePane({
  pid,
  etapaSubMap,
  moveTarget,
  moveColuna,
  setMoveColuna,
  setMoveColunaAtual,
  setMoveEtapaAtual,
  moveEtapa,
  setMoveEtapa,
  moveSub,
  setMoveSub,
  moveComentario,
  setMoveComentario,
  setMoveAdvanceOpen,
  moveCanais,
  setMoveCanais,
  moveArquivo,
  setMoveArquivo,
  setToast,
  setLoading,
  load,
  scheduleQuickConfirm,
  notifyNetworkChange,
  scheduleSuccessModal,
  onAfterMove,
  onClosePane,
}) {
  const etapasPorColuna = KANBAN_ETAPAS[moveColuna] || [];
  const mappedEtapa = MAPA_COLUNAS_PARA_ETAPAS[moveColuna] || etapasPorColuna[0] || '';
  const etapaSelecionada = etapasPorColuna.includes(moveEtapa) ? moveEtapa : mappedEtapa;
  const isDeferidos = String(moveColuna || '').trim().toLowerCase() === 'deferidos';
  const subetapasDisponiveis = isDeferidos
    ? SUBETAPAS_DEFERIDOS
    : etapaSelecionada
    ? etapaSubMap?.[etapaSelecionada] || []
    : [];

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-4 pb-3 border-b panel-border">
        <div className="min-w-0">
          <div className="font-semibold">Movimentar processo #{pid}</div>
          <div className="text-xs opacity-70 truncate">
            {pickFirst(moveTarget?.header || {}, ['cliente', 'Cliente'], '')}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto pr-1">
        <div className="grid gap-4">
          <Field label="Coluna do Kanban">
            <select
              className="input-themed w-full"
              value={moveColuna}
              onChange={(e) => {
                const nextColuna = e.target.value;
                setMoveColuna(nextColuna);

                const etapas = KANBAN_ETAPAS[nextColuna] || [];
                const etapaDefault = MAPA_COLUNAS_PARA_ETAPAS[nextColuna] || etapas[0] || '';
                setMoveEtapa(etapaDefault);

                if (String(nextColuna || '').toLowerCase().includes('suspens')) {
                  setMoveSub('Suspenso');
                } else if (String(moveSub || '').toLowerCase() === 'suspenso') {
                  setMoveSub('');
                } else {
                  setMoveSub('');
                }
              }}
            >
              <option value="">Selecione...</option>
              {KANBAN_COLUNAS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Etapa">
            <select
              className="input-themed w-full"
              value={etapaSelecionada}
              onChange={(e) => {
                setMoveEtapa(e.target.value);
                setMoveSub('');
              }}
              disabled={!moveColuna || etapasPorColuna.length === 0}
            >
              <option value="">
                {!moveColuna ? 'Selecione uma coluna' : etapasPorColuna.length ? 'Selecione...' : 'Sem etapas'}
              </option>
              {etapasPorColuna.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Sub-etapa *">
            <select
              className="input-themed w-full"
              value={moveSub}
              onChange={(e) => setMoveSub(e.target.value)}
              disabled={!moveColuna || !(moveEtapa || mappedEtapa)}
            >
              <option value="">{moveColuna ? 'Selecione...' : 'Selecione uma coluna'}</option>
              {subetapasDisponiveis.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Comentário">
            <textarea
              rows={3}
              className="input-themed w-full"
              value={moveComentario}
              onChange={(e) => setMoveComentario(e.target.value)}
              placeholder="Comentário para o histórico"
            />
          </Field>

          <Field label="Canais de comunicação">
            <CanaisSelector
              canais={moveCanais}
              onToggle={(key) =>
                setMoveCanais((prev) => ({ ...(prev || {}), [key]: !prev?.[key] }))
              }
            />
          </Field>

          <Field label="Anexo">
            <div className="flex items-center justify-between gap-2">
              <label className="btn-outline cursor-pointer">
                Anexar
                <input
                  type="file"
                  className="hidden"
                  onChange={(e) => setMoveArquivo(e.target.files?.[0] || null)}
                />
              </label>
              {moveArquivo?.name && (
                <div className="text-xs opacity-70 truncate max-w-[240px]">{moveArquivo.name}</div>
              )}
            </div>
          </Field>
        </div>
      </div>

      <div className="flex justify-end gap-3 mt-4 pt-3 border-t panel-border">
        <button
          onClick={onClosePane}
          className="px-4 py-2 panel-bg-60 rounded border panel-border hover:opacity-90"
          type="button"
        >
          Cancelar
        </button>

        <button
          type="button"
          onClick={async () => {
            const id = moveTarget?.pid;
            const colunaDestino = String(moveColuna || '').trim();
            const etapaDestino =
              String(moveEtapa || '').trim() ||
              MAPA_COLUNAS_PARA_ETAPAS[colunaDestino] ||
              colunaDestino;

            if (!id || !colunaDestino || !etapaDestino) {
              alert('Preencha os campos obrigatórios.');
              return;
            }

            const canais = Object.entries(moveCanais || {})
              .filter(([, v]) => !!v)
              .map(([k]) => k);

            let stopQuick;
            let stopSuccess;
            try {
              if (!(await confirmAction(`Deseja mover o processo #${id} para "${colunaDestino}"?`))) return;
              setLoading(true);
              stopQuick = scheduleQuickConfirm();
              stopSuccess = scheduleSuccessModal(`Processo ${id} movido.`);
              const fd = new FormData();
              fd.append('etapa_atual', etapaDestino);

              const subTrim = String(moveSub || '').trim();
              const comentarioFinal =
                buildComentarioFinal({ texto: moveComentario }) ||
                `Movimentado para ${colunaDestino}${subTrim ? ` (${subTrim})` : ''}`;
              const isSuspensosCol = String(colunaDestino || '').toLowerCase().includes('suspens');

              if (!subTrim) {
                setToast({ open: true, type: 'warning', text: 'Sub-etapa é obrigatória.' });
                return;
              }

              if (isSuspensosCol) {
                fd.append('sub_etapa', subTrim || 'Suspenso');
              } else if (subTrim && subTrim.toLowerCase() !== 'suspenso') {
                fd.append('sub_etapa', subTrim);
              }

              if (comentarioFinal) fd.append('comentario', comentarioFinal);
              if (canais.length > 0) fd.append('canais', JSON.stringify(canais));
              if (moveArquivo) fd.append('anexos', moveArquivo);

              await movimentarProcesso(id, fd);
              setToast({ open: true, type: 'success', text: `Processo ${id} movido.` });

              onClosePane();
              setMoveColuna('');
              setMoveColunaAtual('');
              setMoveEtapaAtual('');
              setMoveEtapa('');
              setMoveSub('');
              setMoveComentario('');
              setMoveAdvanceOpen(false);
              setMoveCanais(DEFAULT_CANAIS);
              setMoveArquivo(null);

              await load({ force: true });

              if (onAfterMove) await onAfterMove(id);
            } catch (err) {
              setToast({ open: true, type: 'error', text: err?.message || 'Erro ao mover processo.' });
              notifyNetworkChange(err);
              if (typeof stopSuccess === 'function') stopSuccess();
            } finally {
              if (typeof stopQuick === 'function') stopQuick();
              setLoading(false);
            }
          }}
          className="px-4 py-2 bg-[var(--accent)] text-[var(--fg)] font-bold rounded hover:opacity-90"
        >
          Mover
        </button>
      </div>
    </div>
  );
}
