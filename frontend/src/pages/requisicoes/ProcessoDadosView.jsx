// src/pages/requisicoes/ProcessoDadosView.jsx — extraído de Requisicoes.jsx em 12/11/2026 (melhoria 2: arquivos menores).
// Conteúdo idêntico ao original; só mudou de arquivo e ganhou export/import.

import { memo, useMemo } from 'react';
import { Pencil } from 'lucide-react';
import { CANAIS_UI } from './constantes.js';
import { pickFirst } from './util.js';
import { formatCurrencyBR, formatDateTimeBR, formatPeriodosIrregularidade, formatSnapshotValue, toSentenceCase } from './processoHelpers.js';


export const CanaisSelector = memo(function CanaisSelector({ canais, onToggle }) {
  return (
    <div className="flex items-center gap-3">
      <img src="/Icones/contato.png" alt="" className="h-16 w-16 object-contain opacity-90" />
      <div className="grid grid-cols-3 gap-2">
        {CANAIS_UI.map(({ key, label }) => {
          const ativo = !!canais?.[key];
          return (
            <button
              key={key}
              type="button"
              className={`sap-chip transition ${ativo ? 'sap-chip--active' : ''}`}
              onClick={() => onToggle(key)}
              title={`Registrar no histórico como ${label}`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
});

export const Field = memo(function Field({ label, hint, children }) {
  return (
    <div className="sap-field">
      <label className="sap-label">{label}</label>
      {children}
      {hint ? <div className="sap-hint">{hint}</div> : null}
    </div>
  );
});

export const ProcessoDadosView = memo(function ProcessoDadosView({
  header,
  snapshotData,
  requisicaoData,
  anexosData,
  infoHistoryItems,
  estimadoValue,
  onChangeEstimado,
  onSaveEstimado,
  onDeleteAnexo,
  onEditInfo,
}) {
  const anexos = Array.isArray(anexosData) ? anexosData : [];

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

        {null}
      </div>

      {null}
    </div>
  );
});
