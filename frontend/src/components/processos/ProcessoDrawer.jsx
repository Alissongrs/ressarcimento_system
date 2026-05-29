// src/components/processos/ProcessoDrawer.jsx
//
// Drawer expansível com detalhes do processo: Deferimento, Fluxo, Faturamento,
// Histórico, Score, Anexos, ofício CEMIG, extração de email por IA, etc.
//
// Extraído de AdminPlanilha.jsx (linha 1298 — ~1.121 linhas) na Etapa 2b' do
// desacoplamento. Não há mudança de comportamento.
//
import React, { useCallback, useMemo, useState } from 'react';
import { Activity, FileText, Sparkles } from 'lucide-react';
import {
  pickFirst,
  formatSnapshotValue,
  formatDateTimeBR,
  getDeferimentoDefaults,
  normalizeKanbanName,
  splitHistoryItems,
  groupHistoryByStage,
  getSubEtapaFromStatus,
  toTs,
  norm,
  toNumberValue,
  toDateInput,
  normalizeFormaDevolucao,
  formatListMoney,
  detailValueMoney,
} from '../../pages/utils/processosHelpers.js';
import { withAuthToken } from '../../services/apiClient';
import { sanitizeEmail } from '../../utils/safeHtml.js';
import Field from './Field.jsx';
import ProcessoDadosView from './ProcessoDadosView.jsx';

export default function ProcessoDrawer({
  open,
  row,
  onClose,
  pane,
  setPane,
  onPrepareMove,
  onEditHistory,
  rightPane,
  snapshotData,
  requisicaoData,
  anexosData,
  historyItems,
  historyDetailLoading,
  historyAnexoUploading,
  onAttachHistoryAnexo, // eslint-disable-line no-unused-vars
  onDeleteAnexo,
  relevanciaChecked,
  suspensoChecked,
  onToggleRelevancia,
  onToggleSuspenso,
  handleSaveProcesso,
  onConcluirProcesso,
  detailsByPid,
  setDetailsByPid,
  detailValue: detailValueLocal,
  scoreData,
  activeTab,
  onEditInfo,
}) {
  const [emailExtract, setEmailExtract] = useState({});
  const [docConfirmOpen, setDocConfirmOpen] = useState(false);
  const currentRow = row || {};
  const { pid, header, category } = currentRow;
  const safeHeader = header || {};
  const anexos = Array.isArray(anexosData) ? anexosData : [];

  // Condição para exibir o banner de ofício CEMIG
  const docUC = pickFirst(safeHeader, ['uc', 'UC', 'Uc'], '');
  const docConc = pickFirst(safeHeader, ['concessionaria', 'Concessionaria'], '');
  const docEtapa = pickFirst(safeHeader, ['etapa_atual', 'etapa', 'sub_etapa'], '');
  const showDocBanner =
    activeTab === 'ATIVOS' &&
    docConc.toLowerCase().includes('cemig') &&
    (docEtapa.toLowerCase().includes('distribuidora') || docEtapa.toLowerCase().includes('ouvidoria'));
  const docFilename = `Ouvidoria ${docUC} - ${docConc}.docx`;

  const historySource =
    Array.isArray(historyItems) && historyItems.length > 0
      ? historyItems
      : Array.isArray(currentRow.history)
      ? currentRow.history
      : [];

  const estimadoBase = pickFirst(
    { ...safeHeader, ...(snapshotData || {}), ...(requisicaoData || {}) },
    ['ressarcimento_estimado', 'valor_estimado', 'valor'],
    '',
  );

  const deferimentoDefaults = useMemo(
    () => getDeferimentoDefaults(safeHeader, snapshotData, requisicaoData),
    [safeHeader, snapshotData, requisicaoData],
  );

  const hasRight = !!pane;

  const historySorted = useMemo(() => {
    const list = Array.isArray(historySource) ? [...historySource] : [];
    const parseDate = (h) => {
      const raw = pickFirst(h, ['hist_data', 'data_movimentacao', 'data', 'created_at'], '');
      if (!raw || String(raw).startsWith('0001-01-01')) return 0;
      const ts = new Date(String(raw).replace(' ', 'T')).getTime();
      return Number.isNaN(ts) ? 0 : ts;
    };

    const filtered = list.filter((h) => {
      const raw = pickFirst(h, ['hist_data', 'data_movimentacao', 'data', 'created_at'], '');
      const hasDate = !!raw && !String(raw).startsWith('0001-01-01');

      const etapaVal = pickFirst(h, ['etapa_nova', 'etapa', 'Etapa'], '');
      const subVal = getSubEtapaFromStatus(h);
      const comentarioVal = pickFirst(h, ['hist_comentario', 'comentario'], '');

      const hasComentario = !!String(comentarioVal || '').trim();
      const hasSub = !!String(subVal || '').trim();
      const hasEtapa = !!String(etapaVal || '').trim();

      if (hasDate) return true;
      return hasComentario || hasSub || hasEtapa;
    });

    return filtered.sort((a, b) => parseDate(b) - parseDate(a));
  }, [historySource]);

  const historyWithAnexos = useMemo(() => {
    const list = historySorted.map((item) => ({
      ...item,
      anexos: Array.isArray(item.anexos) ? [...item.anexos] : [],
    }));

    if (!anexos.length || list.length === 0) return list;

    const used = new Set();
    list.forEach((item) => {
      (item.anexos || []).forEach((a) => {
        const name = a?.nome || a?.nome_arquivo || '';
        const path = a?.url || a?.caminho_arquivo || '';
        used.add(`${name}|${path}`);
      });
    });

    const toTsSafe = (value) => {
      const raw = String(value || '').trim();
      if (!raw || raw.startsWith('0001-01-01')) return 0;
      const ts = new Date(raw.replace(' ', 'T')).getTime();
      return Number.isNaN(ts) ? 0 : ts;
    };

    const histTs = list.map((h) =>
      toTsSafe(pickFirst(h, ['hist_data', 'data_movimentacao', 'data', 'created_at'], '')),
    );

    const candidates = anexos.filter((a) => {
      const name = a?.nome_arquivo || a?.nome || '';
      const path = a?.url || a?.caminho_arquivo || '';
      return !used.has(`${name}|${path}`);
    });

    candidates.forEach((a) => {
      const uploadTs = toTsSafe(a?.data_upload || a?.DataUpload || '');
      let targetIdx = 0;

      if (uploadTs) {
        let minDiff = Number.POSITIVE_INFINITY;
        histTs.forEach((ts, idx) => {
          if (!ts) return;
          const diff = Math.abs(ts - uploadTs);
          if (diff < minDiff) {
            minDiff = diff;
            targetIdx = idx;
          }
        });
      }

      const link = {
        nome: a?.nome_arquivo || a?.nome,
        url: a?.url || a?.caminho_arquivo,
        data_upload: a?.data_upload || a?.DataUpload,
      };

      list[targetIdx].anexos = [...(list[targetIdx].anexos || []), link];
    });

    return list;
  }, [historySorted, anexos]);

  const { info: historyInfoItems, display: historyDisplayItems } = useMemo(
    () => splitHistoryItems(historyWithAnexos),
    [historyWithAnexos],
  );

  const historyGroups = useMemo(
    () => groupHistoryByStage(historyDisplayItems),
    [historyDisplayItems],
  );

  const fieldStampMap = useMemo(() => {
    const map = new Map();
    const setStamp = (key, dtRaw) => {
      const ts = toTs(dtRaw);
      if (!ts) return;
      const prev = map.get(key);
      if (!prev || ts > prev.ts) {
        map.set(key, { ts, label: formatDateTimeBR(dtRaw) });
      }
    };
    (historyInfoItems || []).forEach((item) => {
      const comentario = norm(pickFirst(item, ['hist_comentario', 'comentario'], ''));
      if (!comentario) return;
      const dtRaw = pickFirst(item, ['hist_data', 'data_movimentacao', 'data'], '');
      if (comentario.includes('data simples')) setStamp('data_simples', dtRaw);
      if (comentario.includes('data dobro')) setStamp('data_dobro', dtRaw);
      if (comentario.includes('repasse simples')) setStamp('repasse_simples', dtRaw);
      if (comentario.includes('repasse dobro')) setStamp('repasse_dobro', dtRaw);
      if (comentario.includes('credito simples')) setStamp('credito_simples', dtRaw);
      if (comentario.includes('credito dobro')) setStamp('credito_dobro', dtRaw);
      if (comentario.includes('ressarcimento estimado')) setStamp('ressarcimento_estimado', dtRaw);
      if (comentario.includes('numero nf') || comentario.includes('número nf')) setStamp('numero_nf', dtRaw);
      if (comentario.includes('data emiss')) setStamp('data_emissao', dtRaw);
      if (comentario.includes('data venc')) setStamp('data_vencimento', dtRaw);
      if (comentario.includes('data pag')) setStamp('data_pagamento', dtRaw);
      if (comentario.includes('valor nf')) setStamp('valor_nf', dtRaw);
      if (comentario.includes('forma de devolucao')) setStamp('forma_devolucao', dtRaw);
      if (comentario.includes('valor de devolucao')) setStamp('valor_fluxo', dtRaw);
      if (comentario.includes('data de devolucao')) setStamp('data_fluxo', dtRaw);
      if (comentario.includes('envio ao financeiro')) setStamp('data_envio_financeiro', dtRaw);
    });
    return map;
  }, [historyInfoItems]);

  const labelWithStamp = useCallback(
    (label, key) => {
      const stamp = fieldStampMap.get(key)?.label;
      if (!stamp) return label;
      return (
        <span className="inline-flex items-center gap-1">
          <span>{label}</span>
          <span className="text-[10px] opacity-70">({stamp})</span>
        </span>
      );
    },
    [fieldStampMap],
  );

  const detail = detailsByPid?.[pid] || {};

  const isMoneyFilled = useCallback((val) => {
    const n = toNumberValue(val);
    return n !== '' && Number(n) > 0;
  }, []);

  const isDateFilled = useCallback((val) => {
    return !!toDateInput(val);
  }, []);

  const isTextFilled = useCallback((val) => String(val || '').trim() !== '', []);

  const fluxoItens =
    Array.isArray(detail.fluxo_itens) && detail.fluxo_itens.length
      ? detail.fluxo_itens
      : [
          {
            forma_devolucao: normalizeFormaDevolucao(detail.forma ?? safeHeader.forma_devolucao ?? ''),
            valor: detail.valor_fluxo ?? safeHeader.valor_fluxo ?? '',
            simples: detail.simples ?? safeHeader.fluxo_simples ?? 0,
            dobro: detail.dobro ?? safeHeader.fluxo_dobro ?? 0,
            simples_dobro: detail.simples_dobro ?? safeHeader.fluxo_simples_dobro ?? 0,
            data_devolucao: detail.data_fluxo ?? safeHeader.data_fluxo ?? '',
            data_envio_financeiro: detail.data_envio_financeiro ?? safeHeader.data_envio_financeiro ?? '',
          },
        ];

  const faturamentoItens =
    Array.isArray(detail.faturamento_itens) && detail.faturamento_itens.length
      ? detail.faturamento_itens
      : [
          {
            numero_nf: detail.numero_nf ?? safeHeader.numero_nf ?? '',
            data_emissao: detail.data_emissao ?? safeHeader.data_emissao ?? '',
            data_vencimento: detail.data_vencimento ?? safeHeader.data_vencimento ?? '',
            data_pagamento: detail.data_pagamento ?? safeHeader.data_pagamento ?? '',
            valor: detail.valor_nf ?? safeHeader.valor_nf ?? '',
          },
        ];

  const isInFaturamento = normalizeKanbanName(category) === 'Faturamento';

  // eslint-disable-next-line no-unused-vars
  const deferimentoCompleto = useMemo(() => {
    const cs = detailValueMoney(detailsByPid, pid, 'cs', deferimentoDefaults.cs);
    const ds = detailValueLocal(detailsByPid, pid, 'ds', deferimentoDefaults.ds);
    const cd = detailValueMoney(detailsByPid, pid, 'cd', deferimentoDefaults.cd);
    const dd = detailValueLocal(detailsByPid, pid, 'dd', deferimentoDefaults.dd);
    const rs = detailValueMoney(detailsByPid, pid, 'rs', deferimentoDefaults.rs);
    const rd = detailValueMoney(detailsByPid, pid, 'rd', deferimentoDefaults.rd);
    return (
      isMoneyFilled(cs) &&
      isDateFilled(ds) &&
      isMoneyFilled(cd) &&
      isDateFilled(dd) &&
      isMoneyFilled(rs) &&
      isMoneyFilled(rd)
    );
  }, [
    detailsByPid,
    pid,
    deferimentoDefaults,
    detailValueLocal,
    isMoneyFilled,
    isDateFilled,
  ]);

  // eslint-disable-next-line no-unused-vars
  const fluxoCompleto = useMemo(
    () =>
      fluxoItens.length > 0 &&
      fluxoItens.every((item) => {
        const hasTipo = !!(item.simples || item.dobro || item.simples_dobro);
        return (
          hasTipo &&
          isMoneyFilled(item.valor) &&
          isTextFilled(item.forma_devolucao) &&
          isDateFilled(item.data_devolucao) &&
          isDateFilled(item.data_envio_financeiro)
        );
      }),
    [fluxoItens, isMoneyFilled, isTextFilled, isDateFilled],
  );

  const faturamentoCompleto = useMemo(
    () =>
      faturamentoItens.length > 0 &&
      faturamentoItens.some((item) => isMoneyFilled(item.valor)),
    [faturamentoItens, isMoneyFilled],
  );

  const podeConcluir = isInFaturamento && faturamentoCompleto;

  const updateList = useCallback(
    (field, idx, key, val) => {
      setDetailsByPid((prev) => {
        const cur = prev?.[pid] || {};
        const defaultList = field === 'fluxo_itens' ? [...fluxoItens] : [...faturamentoItens];
        const itens =
          Array.isArray(cur[field]) && cur[field].length ? [...cur[field]] : defaultList;

        itens[idx] = { ...(itens[idx] || {}), [key]: val };
        return { ...(prev || {}), [pid]: { ...cur, [field]: itens } };
      });
    },
    [pid, setDetailsByPid, fluxoItens, faturamentoItens],
  );

  const manageList = useCallback(
    (field, action, idx) => {
      setDetailsByPid((prev) => {
        const cur = prev?.[pid] || {};
        const defaultList = field === 'fluxo_itens' ? [...fluxoItens] : [...faturamentoItens];
        const itens =
          Array.isArray(cur[field]) && cur[field].length ? [...cur[field]] : defaultList;

        if (action === 'add') {
          if (field === 'fluxo_itens') {
            itens.push({
              forma_devolucao: '',
              valor: '',
              simples: 0,
              dobro: 0,
              simples_dobro: 0,
              data_devolucao: '',
              data_envio_financeiro: '',
            });
          } else {
            itens.push({ numero_nf: '', data_emissao: '', data_vencimento: '', data_pagamento: '', valor: '' });
          }
        } else if (action === 'remove') {
          if (itens.length > 1) itens.splice(idx, 1);
          else return prev;
        }

        return { ...(prev || {}), [pid]: { ...cur, [field]: itens } };
      });
    },
    [pid, setDetailsByPid, fluxoItens, faturamentoItens],
  );

  const togglePane = useCallback(
    (key, beforeOpen) => {
      setPane((prev) => {
        const next = prev === key ? '' : key;
        if (next === key) beforeOpen?.();
        return next;
      });
    },
    [setPane],
  );

  const paneBtn = (key) => `sap-tab ${pane === key ? 'sap-tab-active' : ''}`;

  if (!open || !row) return null;

  const renderLeft = () => (
    <div className="space-y-4 pr-1">
      <div className="sap-section">
        <div className="sap-section-header flex items-center justify-between">
          <div className="font-semibold">Deferimento</div>
        </div>

        <div className="p-3 grid grid-cols-2 gap-4">
          <Field label={labelWithStamp('Deferimento simples', 'credito_simples')}>
            <input
              className="input-themed text-sm"
              value={detailValueMoney(detailsByPid, pid, 'cs', deferimentoDefaults.cs)}
              onChange={(e) =>
                setDetailsByPid((prev) => ({
                  ...(prev || {}),
                  [pid]: { ...((prev || {})[pid] || {}), cs: e.target.value },
                }))
              }
            />
          </Field>

          <Field label={labelWithStamp('Data simples', 'data_simples')}>
            <input
              type="date"
              className="input-themed text-sm"
              value={detailValueLocal(
                detailsByPid,
                pid,
                'ds',
                toDateInput(deferimentoDefaults.ds) || deferimentoDefaults.ds,
              )}
              onChange={(e) =>
                setDetailsByPid((prev) => ({
                  ...(prev || {}),
                  [pid]: { ...((prev || {})[pid] || {}), ds: e.target.value },
                }))
              }
            />
          </Field>

          <Field label={labelWithStamp('Deferimento dobro', 'credito_dobro')}>
            <input
              className="input-themed text-sm"
              value={detailValueMoney(detailsByPid, pid, 'cd', deferimentoDefaults.cd)}
              onChange={(e) =>
                setDetailsByPid((prev) => ({
                  ...(prev || {}),
                  [pid]: { ...((prev || {})[pid] || {}), cd: e.target.value },
                }))
              }
            />
          </Field>

          <Field label={labelWithStamp('Data dobro', 'data_dobro')}>
            <input
              type="date"
              className="input-themed text-sm"
              value={detailValueLocal(
                detailsByPid,
                pid,
                'dd',
                toDateInput(deferimentoDefaults.dd) || deferimentoDefaults.dd,
              )}
              onChange={(e) =>
                setDetailsByPid((prev) => ({
                  ...(prev || {}),
                  [pid]: { ...((prev || {})[pid] || {}), dd: e.target.value },
                }))
              }
            />
          </Field>

          <Field label={labelWithStamp('Repasse simples', 'repasse_simples')}>
            <input
              className="input-themed text-sm"
              value={detailValueMoney(detailsByPid, pid, 'rs', deferimentoDefaults.rs)}
              onChange={(e) =>
                setDetailsByPid((prev) => ({
                  ...(prev || {}),
                  [pid]: { ...((prev || {})[pid] || {}), rs: e.target.value },
                }))
              }
            />
          </Field>

          <Field label={labelWithStamp('Repasse dobro', 'repasse_dobro')}>
            <input
              className="input-themed text-sm"
              value={detailValueMoney(detailsByPid, pid, 'rd', deferimentoDefaults.rd)}
              onChange={(e) =>
                setDetailsByPid((prev) => ({
                  ...(prev || {}),
                  [pid]: { ...((prev || {})[pid] || {}), rd: e.target.value },
                }))
              }
            />
          </Field>
        </div>

        <div className="flex justify-end p-3 pt-0">
          <button className="btn-themed" onClick={() => handleSaveProcesso(pid, header, 'deferimento')} type="button">
            Salvar campos
          </button>
        </div>
      </div>

      <div className="sap-section">
        <div className="sap-section-header flex items-center justify-between">
          <div className="font-semibold">Fluxo de Ressarcimento</div>
          <button className="btn-outline text-xs" onClick={() => manageList('fluxo_itens', 'add')} type="button">
            + Adicionar
          </button>
        </div>

        <div className="p-3 space-y-3">
          {fluxoItens.map((item, idx) => (
            <div key={`fluxo-${pid}-${idx}`} className="sap-card p-3">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2 flex items-center gap-4 py-1">
                  <span className="text-[11px] uppercase font-semibold">Tipo:</span>
                  <div className="flex items-center gap-4">
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={!!(item.simples || item.simples_dobro)}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setDetailsByPid((prev) => {
                            const cur = prev?.[pid] || {};
                            const itens =
                              Array.isArray(cur.fluxo_itens) && cur.fluxo_itens.length
                                ? [...cur.fluxo_itens]
                                : [...fluxoItens];
                            const atual = { ...(itens[idx] || {}) };
                            const dobroMarcado = !!(atual.dobro || atual.simples_dobro);
                            atual.simples = checked ? 1 : 0;
                            atual.simples_dobro = checked && dobroMarcado ? 1 : 0;
                            itens[idx] = atual;
                            return { ...(prev || {}), [pid]: { ...cur, fluxo_itens: itens } };
                          });
                        }}
                      />
                      Simples
                    </label>
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={!!(item.dobro || item.simples_dobro)}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setDetailsByPid((prev) => {
                            const cur = prev?.[pid] || {};
                            const itens =
                              Array.isArray(cur.fluxo_itens) && cur.fluxo_itens.length
                                ? [...cur.fluxo_itens]
                                : [...fluxoItens];
                            const atual = { ...(itens[idx] || {}) };
                            const simplesMarcado = !!(atual.simples || atual.simples_dobro);
                            atual.dobro = checked ? 1 : 0;
                            atual.simples_dobro = checked && simplesMarcado ? 1 : 0;
                            itens[idx] = atual;
                            return { ...(prev || {}), [pid]: { ...cur, fluxo_itens: itens } };
                          });
                        }}
                      />
                      Dobro
                    </label>
                  </div>
                </div>

                <Field label={labelWithStamp('Valor', 'valor_fluxo')}>
                  <input
                    className="input-themed text-sm"
                    value={formatListMoney(item.valor ?? '')}
                    onChange={(e) => updateList('fluxo_itens', idx, 'valor', e.target.value)}
                    placeholder="0,00"
                  />
                </Field>

                <Field label={labelWithStamp('Forma de devolução', 'forma_devolucao')}>
                  <select
                    className="input-themed text-sm"
                    value={normalizeFormaDevolucao(item.forma_devolucao ?? '')}
                    onChange={(e) =>
                      updateList('fluxo_itens', idx, 'forma_devolucao', normalizeFormaDevolucao(e.target.value))
                    }
                  >
                    <option value="">Selecione...</option>
                    <option value="Fatura">Fatura</option>
                    <option value="GD">GD</option>
                    <option value="Deposito">Depósito</option>
                  </select>
                </Field>

                <Field label={labelWithStamp('Data devolução', 'data_fluxo')}>
                  <input
                    type="date"
                    className="input-themed text-sm"
                    value={toDateInput(item.data_devolucao)}
                    onChange={(e) => updateList('fluxo_itens', idx, 'data_devolucao', e.target.value)}
                  />
                </Field>

                <Field label={labelWithStamp('Envio ao financeiro', 'data_envio_financeiro')}>
                  <input
                    type="date"
                    className="input-themed text-sm"
                    value={toDateInput(item.data_envio_financeiro)}
                    onChange={(e) => updateList('fluxo_itens', idx, 'data_envio_financeiro', e.target.value)}
                  />
                </Field>
              </div>

              {fluxoItens.length > 1 && (
                <div className="flex justify-end mt-2">
                  <button
                    className="btn-outline text-xs"
                    onClick={() => manageList('fluxo_itens', 'remove', idx)}
                    type="button"
                  >
                    Remover
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end p-3 pt-0">
          <button className="btn-themed" onClick={() => handleSaveProcesso(pid, header, 'fluxo')} type="button">
            Salvar fluxo
          </button>
        </div>
      </div>

      <div className="sap-section">
        <div className="sap-section-header flex items-center justify-between">
          <div className="font-semibold">Faturamento</div>
          <button className="btn-outline text-xs" onClick={() => manageList('faturamento_itens', 'add')} type="button">
            + Adicionar
          </button>
        </div>

        <div className="p-3 space-y-3">
          {faturamentoItens.map((item, idx) => (
            <div key={`fat-${pid}-${idx}`} className="sap-card p-3">
              <div className="grid grid-cols-2 gap-4">
                <Field label={labelWithStamp('Número NF', 'numero_nf')}>
                  <input
                    className="input-themed text-sm"
                    value={item.numero_nf ?? ''}
                    onChange={(e) => updateList('faturamento_itens', idx, 'numero_nf', e.target.value)}
                  />
                </Field>

                <Field label={labelWithStamp('Emissão', 'data_emissao')}>
                  <input
                    type="date"
                    className="input-themed text-sm"
                    value={toDateInput(item.data_emissao)}
                    onChange={(e) => updateList('faturamento_itens', idx, 'data_emissao', e.target.value)}
                  />
                </Field>

                <Field label={labelWithStamp('Vencimento', 'data_vencimento')}>
                  <input
                    type="date"
                    className="input-themed text-sm"
                    value={toDateInput(item.data_vencimento)}
                    onChange={(e) => updateList('faturamento_itens', idx, 'data_vencimento', e.target.value)}
                  />
                </Field>

                <Field label={labelWithStamp('Pagamento', 'data_pagamento')}>
                  <input
                    type="date"
                    className="input-themed text-sm"
                    value={toDateInput(item.data_pagamento)}
                    onChange={(e) => updateList('faturamento_itens', idx, 'data_pagamento', e.target.value)}
                  />
                </Field>

                <Field label={labelWithStamp('Valor NF', 'valor_nf')}>
                  <input
                    className="input-themed text-sm"
                    value={formatListMoney(item.valor ?? '')}
                    onChange={(e) => updateList('faturamento_itens', idx, 'valor', e.target.value)}
                    placeholder="0,00"
                  />
                </Field>
              </div>

              {faturamentoItens.length > 1 && (
                <div className="flex justify-end mt-2">
                  <button
                    className="btn-outline text-xs"
                    onClick={() => manageList('faturamento_itens', 'remove', idx)}
                    type="button"
                  >
                    Remover
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end p-3 pt-0">
          <button className="btn-themed" onClick={() => handleSaveProcesso(pid, header, 'faturamento')} type="button">
            Salvar faturamento
          </button>
        </div>

        {isInFaturamento && (
          <div className="flex justify-end p-3 pt-0">
            <button
              className="btn-press req-btn-aprovar px-3 py-1.5 rounded-md border"
              type="button"
              disabled={!podeConcluir}
              title={!podeConcluir ? 'Preencha todos os campos de Deferidos, Fluxo e Faturamento.' : ''}
              onClick={() => onConcluirProcesso?.(pid)}
            >
              Concluir
            </button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full max-w-7xl bg-[var(--panel-processos)] border-l panel-border shadow-lg p-4 overflow-hidden flex flex-col">
        <div className="flex items-start justify-between gap-3 pb-3 border-b panel-border">
          <div className="w-full">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-2xl font-bold leading-tight">#{pid}</div>
              <div className="sap-chip">{category}</div>

              {formatSnapshotValue(pickFirst(header, ['updated_at', 'updatedAt'])) ? (
                <div className="text-xs opacity-70">
                  Atualizado em: {formatSnapshotValue(pickFirst(header, ['updated_at', 'updatedAt']))}
                </div>
              ) : null}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-4 text-xs">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!!relevanciaChecked}
                  onChange={(e) => onToggleRelevancia?.(e.target.checked)}
                />
                <span>Sinalizar como relevante</span>
              </label>

              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!!suspensoChecked}
                  onChange={(e) => onToggleSuspenso?.(e.target.checked)}
                />
                <span>Suspender processo</span>
              </label>
            </div>

            <ProcessoDadosView
              header={header}
              snapshotData={snapshotData}
              requisicaoData={requisicaoData}
              anexosData={anexosData}
              infoHistoryItems={historyInfoItems}
              estimadoValue={detailValueMoney(detailsByPid, pid, 're', estimadoBase)}
              onDeleteAnexo={onDeleteAnexo ? (anexoId) => onDeleteAnexo(pid, anexoId) : undefined}
              onChangeEstimado={(value) =>
                setDetailsByPid((prev) => ({
                  ...(prev || {}),
                  [pid]: { ...((prev || {})[pid] || {}), re: value },
                }))
              }
              onSaveEstimado={() => handleSaveProcesso(pid, header, 'deferimento')}
              onEditInfo={onEditInfo}
            />

            {showDocBanner && (
              <div className="mt-3 flex items-center gap-2 rounded border border-[var(--accent)] bg-[var(--accent)]/10 px-3 py-2 text-xs">
                <FileText size={14} className="shrink-0 text-[var(--accent)]" />
                <span className="flex-1 font-medium text-[var(--accent)]">Ofício disponível — {docFilename}</span>
                <button
                  type="button"
                  className="btn-outline text-xs"
                  onClick={() => setDocConfirmOpen(true)}
                >
                  Baixar
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="sap-tabs mt-3 flex-wrap">
          <button className={paneBtn('resume')} type="button" onClick={() => togglePane('resume')}>
            Resumir
          </button>

          <button className={paneBtn('move')} type="button" onClick={() => togglePane('move', onPrepareMove)}>
            Movimentar
          </button>

          <button className={paneBtn('history')} type="button" onClick={() => togglePane('history')}>
            Histórico
          </button>

          {activeTab === 'ATIVOS' && (
            <button className={paneBtn('score')} type="button" onClick={() => togglePane('score')}>
              Score
            </button>
          )}

        </div>

        <div className="mt-4 flex-1 overflow-hidden">
          {!hasRight ? (
            <div className="h-full overflow-auto">{renderLeft()}</div>
          ) : (
            <div className="h-full grid grid-cols-1 lg:grid-cols-[1fr_12px_1.4fr] gap-0">
              <div className="h-full overflow-auto pr-4">{renderLeft()}</div>
              <div className="hidden lg:block h-full sap-divider" />
              <div className="h-full overflow-auto pl-4">
                <div className="sap-pane">
                  {pane === 'history' ? (
                    <div className="h-full flex flex-col">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <div className="font-semibold">Histórico</div>
                          {historyDetailLoading && <Activity className="h-4 w-4 animate-spin opacity-70" />}
                        </div>
                        <button className="btn-outline text-xs" onClick={onEditHistory} type="button">
                          Editar histórico
                        </button>
                      </div>

                      {historyGroups.length === 0 ? (
                        <div className="text-sm opacity-70">Nenhum histórico.</div>
                      ) : (
                        <div className="space-y-3">
                          {historyGroups.map((group, gidx) => (
                            <div
                              key={`hist-group-${pid}-${gidx}`}
                              className="rounded-xl border panel-border bg-[var(--panel)]/30 p-3"
                            >
                              <div className="text-[11px] uppercase font-semibold mb-2">
                                <b>Etapa:</b> {group.etapa}
                              </div>
                              <div className="space-y-3">
                                {group.items.map((item, idx) => {
                                  const histId =
                                    item.id_historico ?? item.historico_id ?? item.hist_id ?? item.id ?? null;
                                  const usuarioNome = pickFirst(
                                    item,
                                    ['usuario_nome', 'nome_usuario', 'user_name', 'userName', 'usuario'],
                                    '',
                                  );
                                  const usuarioId = pickFirst(
                                    item,
                                    ['id_usuario_gestor', 'gestor_id', 'usuario_id', 'user_id'],
                                    '',
                                  );
                                  const usuarioLabel = usuarioNome || (usuarioId ? `ID ${usuarioId}` : 'Sistema');
                                  const dt = formatDateTimeBR(
                                    pickFirst(item, ['hist_data', 'data_movimentacao', 'data'], '-'),
                                  );
                                  const sub = getSubEtapaFromStatus(item) || '-';
                                  const comentario = pickFirst(item, ['hist_comentario', 'comentario'], '-');
                                  const tipoMov = String(item.tipo_movimentacao || '').toUpperCase();
                                  const isEmail = tipoMov === 'EMAIL';
                                  const extState = histId ? emailExtract[histId] : null;

                                  return (
                                    <div key={`hist-${pid}-${gidx}-${idx}`} className="text-xs space-y-1">
                                      <div>
                                        {dt} - <b>Sub-etapa</b> {sub}{!isEmail && ` - ${comentario}`}
                                      </div>
                                      {isEmail && comentario && comentario !== '-' && (
                                        <div
                                          className="p-2 rounded border border-[var(--border)] bg-[var(--panel)] overflow-auto text-[var(--fg)]"
                                          style={{ maxHeight: 200, fontSize: 12, lineHeight: 1.5 }}
                                          dangerouslySetInnerHTML={{ __html: sanitizeEmail(comentario) }}
                                        />
                                      )}
                                      {isEmail && histId && (
                                        <div className="space-y-1">
                                          <button
                                            type="button"
                                            disabled={extState?.loading}
                                            onClick={() => {
                                              if (!extState?.data) {
                                                setEmailExtract(prev => ({ ...prev, [histId]: { loading: true, data: null, error: null } }));
                                                import('../../services/apiClient').then(m =>
                                                  m.default.post(`/processos/${pid}/historico/${histId}/extrair-email`)
                                                ).then(({ data }) => {
                                                  setEmailExtract(prev => ({ ...prev, [histId]: { loading: false, data, error: null } }));
                                                }).catch(() => {
                                                  setEmailExtract(prev => ({ ...prev, [histId]: { loading: false, data: null, error: 'Falha ao extrair dados.' } }));
                                                });
                                              }
                                            }}
                                            className="flex items-center gap-1 px-2 py-1 rounded border text-[10px]"
                                            style={{ borderColor: 'var(--accent)', color: extState?.data ? 'var(--success)' : 'var(--accent)', background: 'transparent', cursor: extState?.data ? 'default' : 'pointer', opacity: extState?.loading ? 0.6 : 1 }}
                                          >
                                            {extState?.loading ? (
                                              <><span style={{ width: 10, height: 10, border: '1.5px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} /> Analisando...</>
                                            ) : extState?.data ? (
                                              <><Sparkles size={10} /> Analisado</>
                                            ) : (
                                              <><Sparkles size={10} /> Extrair dados com IA</>
                                            )}
                                          </button>
                                          {extState?.data && (() => {
                                            const d = extState.data;
                                            const tipoColors = { deferido: '#22c55e', indeferido: '#ef4444', em_analise: '#f59e0b', solicita_documentos: '#3b82f6', outros: '#6b7280' };
                                            const tipoLabels = { deferido: 'Deferido', indeferido: 'Indeferido', em_analise: 'Em Análise', solicita_documentos: 'Solicita Documentos', outros: 'Outros' };
                                            const color = tipoColors[d.tipo_resposta] || tipoColors.outros;
                                            const label = tipoLabels[d.tipo_resposta] || d.tipo_resposta;
                                            return (
                                              <div style={{ border: `1px solid ${color}40`, borderRadius: 8, padding: '8px 10px', background: `${color}10`, fontSize: 11 }}>
                                                <div style={{ fontWeight: 700, color, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                                                  <Sparkles size={10} /> {label}
                                                </div>
                                                <div style={{ color: 'var(--fg)', opacity: 0.9 }}>{d.resumo}</div>
                                                {(d.valor != null || d.prazo || d.numero_protocolo) && (
                                                  <div style={{ marginTop: 4, display: 'flex', gap: 10, opacity: 0.75, flexWrap: 'wrap' }}>
                                                    {d.valor != null && <span>Valor: <b>R$ {Number(d.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</b></span>}
                                                    {d.prazo && <span>Prazo: <b>{d.prazo}</b></span>}
                                                    {d.numero_protocolo && <span>Protocolo: <b>{d.numero_protocolo}</b></span>}
                                                  </div>
                                                )}
                                              </div>
                                            );
                                          })()}
                                          {extState?.error && <div style={{ color: 'var(--danger)', fontSize: 10 }}>{extState.error}</div>}
                                        </div>
                                      )}
                                      <div>
                                        <b>Por:</b> {usuarioLabel}
                                      </div>

                                      {Array.isArray(item.anexos) && item.anexos.length > 0 && (
                                        <div className="flex flex-wrap gap-2">
                                          {item.anexos.map((anexo, anexoIdx) => {
                                            const path = String(anexo.url || anexo.caminho_arquivo || '').trim();
                                            const href = path.startsWith('http')
                                              ? path
                                              : path
                                              ? `/${path.replace(/^\/+/, '')}`
                                              : '';
                                            const nome = anexo.nome || anexo.nome_arquivo || `Anexo ${anexoIdx + 1}`;
                                            const anexoId =
                                              anexo.id ?? anexo.ID ?? anexo.id_anexo ?? anexo.idAnexo ?? null;

                                            return href ? (
                                              <div key={`hist-anexo-${gidx}-${idx}-${anexoIdx}`} className="flex items-center gap-2">
                                                <a
                                                  className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:opacity-90"
                                                  href={withAuthToken(href)}
                                                  target="_blank"
                                                  rel="noreferrer"
                                                >
                                                  {nome}
                                                </a>
                                                {anexoId != null && onDeleteAnexo ? (
                                                  <button
                                                    type="button"
                                                    className="btn-outline text-xs"
                                                    onClick={() => onDeleteAnexo(pid, anexoId)}
                                                  >
                                                    Excluir
                                                  </button>
                                                ) : null}
                                              </div>
                                            ) : (
                                              <span key={`hist-anexo-${gidx}-${idx}-${anexoIdx}`} className="text-xs opacity-70">
                                                {nome}
                                              </span>
                                            );
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {anexos.length > 0 && (
                        <div className="mt-4">
                          <div className="text-xs opacity-70 mb-1">Anexos</div>
                          <div className="flex flex-wrap gap-2">
                            {anexos.map((a, idx) => {
                              const path = String(a.url || a.caminho_arquivo || '').trim();
                              const href = path.startsWith('http')
                                ? path
                                : path
                                ? `/${path.replace(/^\/+/, '')}`
                                : '';
                              const nome = a.nome_arquivo || a.nome || `Anexo ${idx + 1}`;
                              const anexoId = a.id ?? a.ID ?? a.id_anexo ?? a.idAnexo ?? null;

                              return href ? (
                                <div key={`${a.id ?? 'anexo'}-${idx}`} className="flex items-center gap-2">
                                  <a
                                    className="px-2 py-1 rounded border panel-border text-xs hover:opacity-90"
                                    href={withAuthToken(href)}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {nome}
                                  </a>
                                  {anexoId != null && onDeleteAnexo ? (
                                    <button
                                      type="button"
                                      className="btn-outline text-xs"
                                      onClick={() => onDeleteAnexo(pid, anexoId)}
                                    >
                                      Excluir
                                    </button>
                                  ) : null}
                                </div>
                              ) : (
                                <span
                                  key={`${a.id ?? 'anexo'}-${idx}`}
                                  className="px-2 py-1 rounded border panel-border text-xs opacity-70"
                                >
                                  {nome}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : pane === 'score' ? (
                    (() => {
                      const rawPct = header?.score_percentual ?? scoreData?.[pid]?.percentual ?? null;
                      const pct = rawPct != null ? Math.round(Number(rawPct)) : null;
                      const labelColor =
                        pct === null ? 'text-gray-400' :
                        pct >= 70 ? 'text-green-500' :
                        pct >= 40 ? 'text-yellow-500' : 'text-red-400';
                      const barColor =
                        pct === null ? 'bg-gray-300' :
                        pct >= 70 ? 'bg-green-500' :
                        pct >= 40 ? 'bg-yellow-500' : 'bg-red-400';

                      return (
                        <div className="flex flex-col gap-4 pt-1">
                          <div className="font-semibold">Score de Progressão</div>
                          <p className="text-xs opacity-60">
                            Probabilidade de avançar para Fluxo, Faturamento ou Concluídos.
                          </p>

                          {pct === null ? (
                            <div className="text-sm opacity-50">Score não calculado para este processo.</div>
                          ) : (
                            <>
                              <div className={`text-5xl font-bold ${labelColor}`}>
                                {pct}%
                              </div>

                              <div className={`text-sm font-semibold ${labelColor}`}>
                                {pct >= 70 ? 'Alta' : pct >= 40 ? 'Média' : 'Baixa'}
                              </div>

                              <div className="w-full bg-[var(--border)] rounded-full h-3">
                                <div
                                  className={`${barColor} h-3 rounded-full transition-all duration-500`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })()
                  ) : (
                    rightPane || <div className="text-sm opacity-70">Selecione uma opção.</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Modal de confirmação de download do ofício */}
      {docConfirmOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDocConfirmOpen(false)} />
          <div className="relative w-full max-w-sm bg-[var(--panel)] border border-[var(--panel-border)] rounded-lg shadow-xl p-5">
            <div className="text-base font-bold mb-1">Baixar ofício</div>
            <div className="text-sm opacity-80 mb-4">
              Deseja baixar o documento <span className="font-medium">{docFilename}</span>?
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn-outline text-sm"
                onClick={() => setDocConfirmOpen(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn-themed text-sm"
                onClick={async () => {
                  setDocConfirmOpen(false);
                  try {
                    const token = (localStorage.getItem('userToken') || '')
                      .replace(/^['"]+|['"]+$/g, '')
                      .trim();
                    const base = (import.meta?.env?.VITE_API_BASE || '/api/v1').trim();
                    const resp = await fetch(`${base}/processos/${pid}/documento`, {
                      headers: token ? { Authorization: `Bearer ${token}` } : {},
                    });
                    if (!resp.ok) throw new Error('Erro ao baixar documento');
                    const blob = await resp.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = docFilename;
                    a.click();
                    URL.revokeObjectURL(url);
                  } catch (err) {
                    console.error('[documento]', err);
                  }
                }}
              >
                Baixar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
