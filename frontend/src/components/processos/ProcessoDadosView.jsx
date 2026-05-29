// src/components/processos/ProcessoDadosView.jsx
//
// Painel "Informações" do drawer (UC, Cliente, Concessionária, Irregularidade, etc.).
// Extraído de AdminPlanilha.jsx (linha 1216).
//
import React, { memo, useMemo } from 'react';
import { Pencil } from 'lucide-react';
import {
  pickFirst,
  formatPeriodosIrregularidade,
  formatSnapshotValue,
  formatCurrencyBR,
  formatDateTimeBR,
  toSentenceCase,
} from '../../pages/utils/processosHelpers.js';

const ProcessoDadosView = memo(function ProcessoDadosView({
  header,
  snapshotData,
  requisicaoData,
  anexosData, // eslint-disable-line no-unused-vars
  infoHistoryItems, // eslint-disable-line no-unused-vars
  estimadoValue, // eslint-disable-line no-unused-vars
  onChangeEstimado, // eslint-disable-line no-unused-vars
  onSaveEstimado, // eslint-disable-line no-unused-vars
  onDeleteAnexo, // eslint-disable-line no-unused-vars
  onEditInfo,
}) {
  const merged = useMemo(
    () => ({ ...(header || {}), ...(snapshotData || {}), ...(requisicaoData || {}) }),
    [header, snapshotData, requisicaoData],
  );
  const infoPeriodo = formatPeriodosIrregularidade(
    pickFirst(merged, ['periodos_irregularidade', 'periodosIrregularidade']),
  );
  const infoIrregularidade = pickFirst(merged, ['tipo_irregularidade', 'irregularidade', 'tipoIrregularidade'], '');
  const infoSubIrregularidade = pickFirst(
    merged,
    ['subtipo_irregularidade', 'sub_irregularidade', 'subtipoIrregularidade'],
    '',
  );
  const infoValor = pickFirst(merged, ['ressarcimento_estimado', 'valor_estimado'], '');
  const infoCriado = pickFirst(merged, ['data_criacao', 'dataCriacao', 'created_at'], '');
  const infoLink = pickFirst(merged, ['link_fatura', 'linkFatura', 'link'], '');
  const infoDescricao = pickFirst(merged, ['descricao_irregularidade', 'descricaoIrregularidade'], '');
  const infoLinksDetalhes = pickFirst(merged, ['links_faturas_detalhes', 'LinksFaturasDetalhes'], null);
  const infoLinksSimples = pickFirst(merged, ['links_faturas', 'LinksFaturas'], null);
  const infoFaturas =
    Array.isArray(infoLinksDetalhes) ? infoLinksDetalhes : Array.isArray(infoLinksSimples) ? infoLinksSimples : [];

  return (
    <div className="mt-3 pt-3 border-t panel-border space-y-4">
      <div>
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="text-base font-semibold uppercase tracking-wide">Informações</div>
          {onEditInfo && (
            <button
              type="button"
              onClick={onEditInfo}
              className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-[var(--panel-border)] bg-[var(--panel)] hover:bg-[var(--hover)] transition-colors"
            >
              <Pencil size={10} />
              Editar
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 gap-1 text-xs mb-4">
          <div><b>UC:</b> {formatSnapshotValue(pickFirst(merged, ['uc', 'Uc', 'UC'])) || '-'}</div>
          <div><b>Cliente:</b> {formatSnapshotValue(pickFirst(merged, ['cliente', 'Cliente'])) || '-'}</div>
          <div><b>Concessionária:</b> {formatSnapshotValue(pickFirst(merged, ['concessionaria', 'Concessionaria'])) || '-'}</div>
          <div><b>Irregularidade / Subirregularidade:</b> {toSentenceCase(infoIrregularidade) || '-'} {infoSubIrregularidade ? `/ ${infoSubIrregularidade}` : ''}</div>
          <div><b>Valor estimado:</b> {formatCurrencyBR(infoValor)}</div>
          <div><b>Criado em:</b> {formatDateTimeBR(infoCriado)}</div>
          <div><b>Período:</b> {infoPeriodo || '-'}</div>
          <div><b>Fatura:</b> {infoLink || '-'}</div>
          <div><b>Faturas:</b> {infoFaturas.length} {infoPeriodo ? `(${infoPeriodo})` : ''}</div>
          <div>
            <b>Descrição:</b>
            <div style={{ whiteSpace: 'pre-wrap', maxHeight: '8.4em', lineHeight: '1.4em', overflowY: 'auto' }}
              className="mt-0.5 text-[11px] opacity-75 border border-[var(--border)] rounded px-1.5 py-0.5 bg-[var(--bg)]">
              {infoDescricao || '-'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

export default ProcessoDadosView;
