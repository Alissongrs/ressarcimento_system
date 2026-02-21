// src/components/ProcessoSnapshotModal.jsx
// Modal para editar FT_PROCESSO_SNAPSHOT com sincronização automática

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, AlertCircle, CheckCircle, Loader } from 'lucide-react';
import {
  getProcessoSnapshot,
  updateProcessoSnapshot,
  validateSnapshotUpdate,
  normalizeSnapshotUpdate,
  mapSnapshotToForm,
  prepareSnapshotData,
  getChangedFields,
} from '../services/processoSnapshotService';
import api, { withAuthToken } from '../services/apiClient';
import { saveProcessoFull } from '../services/adminEditorService';
import { confirmAction } from '../utils/confirm.js';
import './processo-snapshot-modal.css';

export default function ProcessoSnapshotModal({ isOpen, onClose, idProcesso, onSuccess }) {
  const [formData, setFormData] = useState({});
  const [originalData, setOriginalData] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });
  const [errors, setErrors] = useState([]);
  const [changedFields, setChangedFields] = useState({});
  const [requisicaoData, setRequisicaoData] = useState(null);
  const [anexos, setAnexos] = useState([]);
  const [faturas, setFaturas] = useState([]);
  const [historico, setHistorico] = useState([]);
  const [historicoOriginal, setHistoricoOriginal] = useState({});
  const [histSaving, setHistSaving] = useState(false);
  const [histMessage, setHistMessage] = useState({ type: '', text: '' });
  const [histDeletedIds, setHistDeletedIds] = useState(new Set());
  const modalScrollRef = useRef(null);

  // Carregar dados do snapshot ao abrir
  useEffect(() => {
    if (!isOpen || !idProcesso) return;

    const loadSnapshot = async () => {
      setLoading(true);
      setMessage({ type: '', text: '' });
      setErrors([]);
      setHistMessage({ type: '', text: '' });

      try {
        const [
          snapshotResp,
          reqResp,
          anexosResp,
          faturasResp,
          histResp,
        ] = await Promise.allSettled([
          getProcessoSnapshot(idProcesso),
          api.get(`/requisicoes/${idProcesso}`),
          api.get(`/requisicoes/${idProcesso}/anexos`),
          api.get(`/requisicoes/${idProcesso}/faturas`),
          api.get(`/processos/${idProcesso}/historico`),
        ]);

        if (snapshotResp.status === 'fulfilled') {
          const formattedData = mapSnapshotToForm(snapshotResp.value);
          setOriginalData(formattedData);
          setFormData(formattedData);
          setChangedFields({});
          setHistDeletedIds(new Set());
        } else {
          setMessage({
            type: 'error',
            text: 'Snapshot indisponível para este processo.',
          });
          setOriginalData({});
          setFormData({});
          setChangedFields({});
          setHistDeletedIds(new Set());
        }

        if (reqResp.status === 'fulfilled') {
          setRequisicaoData(reqResp.value?.data || null);
        } else {
          setRequisicaoData(null);
        }

        if (anexosResp.status === 'fulfilled') {
          const list = Array.isArray(anexosResp.value?.data) ? anexosResp.value.data : [];
          setAnexos(list);
        } else {
          setAnexos([]);
        }

        if (faturasResp.status === 'fulfilled') {
          const raw = faturasResp.value?.data;
          const list = Array.isArray(raw?.faturas) ? raw.faturas : Array.isArray(raw) ? raw : [];
          setFaturas(list);
        } else {
          setFaturas([]);
        }

        if (histResp.status === 'fulfilled') {
          const list = Array.isArray(histResp.value?.data) ? histResp.value.data : [];
          setHistorico(list);
          const base = {};
          list.forEach((h) => {
            if (h && h.id != null) {
              base[String(h.id)] = {
                data_movimentacao: h.data_movimentacao || '',
                comentario: h.comentario || '',
                etapa_nova: h.etapa_nova || h.etapa || '',
                sub_etapa: h.sub_etapa_nova || h.sub_etapa || '',
                tipo_movimentacao: h.tipo_movimentacao || '',
              };
            }
          });
          setHistoricoOriginal(base);
        } else {
          setHistorico([]);
          setHistoricoOriginal({});
        }
      } catch (error) {
        setMessage({
          type: 'error',
          text: `Erro ao carregar dados: ${error.message}`,
        });
      } finally {
        setLoading(false);
      }
    };

    loadSnapshot();
  }, [isOpen, idProcesso]);

  // Detectar mudanças
  const handleFieldChange = (field, value) => {
    const updated = { ...formData, [field]: value };
    setFormData(updated);

    const changed = getChangedFields(originalData, updated);
    setChangedFields(changed);
    setErrors([]);
  };

  // Salvar alterações
  const handleSave = async () => {
    if (Object.keys(changedFields).length === 0) {
      setMessage({ type: 'info', text: 'Nenhuma alteração detectada' });
      return;
    }

    setSaving(true);
    setMessage({ type: '', text: '' });
    setErrors([]);

    try {
      // Preparar dados
      const updateData = prepareSnapshotData(changedFields);

      // Validar
      const validation = validateSnapshotUpdate(updateData);
      if (!validation.valid) {
        setErrors(validation.errors);
        setMessage({
          type: 'error',
          text: `${validation.errors.length} erro(s) encontrado(s)`,
        });
        setSaving(false);
        return;
      }

      // Atualizar no servidor
      const response = await updateProcessoSnapshot(idProcesso, updateData);

      if (response.success) {
        setMessage({
          type: 'success',
          text: 'Processo atualizado e sincronizado com sucesso!',
        });

        // Atualizar estado
        const updated = { ...formData };
        setOriginalData(updated);
        setChangedFields({});

        // Callback de sucesso
        if (onSuccess) {
          setTimeout(() => onSuccess(response.data), 500);
        }

        // Fechar modal após sucesso
        setTimeout(() => {
          onClose();
        }, 1500);
      } else {
        setMessage({
          type: 'error',
          text: response.message || 'Erro ao atualizar processo',
        });
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Erro: ${error.message}`,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setFormData(originalData);
    setChangedFields({});
    setErrors([]);
    setMessage({ type: '', text: '' });
  };

  useEffect(() => {
    if (isOpen && modalScrollRef.current) {
      modalScrollRef.current.scrollTop = 0;
    }
  }, [isOpen, idProcesso]);

  const historicoAtivosDate = useMemo(() => {
    const list = Array.isArray(historico) ? [...historico] : [];
    if (list.length === 0) return '';
    const parse = (s) => {
      if (!s) return null;
      const d = new Date(s.replace(' ', 'T'));
      return Number.isNaN(d.getTime()) ? null : d;
    };
    list.sort((a, b) => {
      const da = parse(a.data_movimentacao);
      const db = parse(b.data_movimentacao);
      if (!da || !db) return 0;
      return da - db;
    });
    const hit = list.find((h) => {
      const status = String(h.status_composto || h.status_novo || h.etapa_nova || '').toLowerCase();
      return status.includes('ativo');
    });
    return hit?.data_movimentacao || '';
  }, [historico]);

  if (!isOpen) return null;

  const hasChanges = Object.keys(changedFields).length > 0;

  const handleHistoricoChange = (id, field, value) => {
    setHistorico((prev) =>
      prev.map((h) => (h.id === id ? { ...h, [field]: value } : h))
    );
  };

  const toggleHistoricoDelete = (id) => {
    setHistDeletedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const buildHistoricoUpdates = () => {
    const updates = [];
    historico.forEach((h) => {
      if (!h || h.id == null || h.id === 0) return;
      if (histDeletedIds.has(h.id)) return;
      const base = historicoOriginal[String(h.id)] || {};
      const dataMov = h.data_movimentacao || '';
      const comentario = h.comentario || '';
      const etapaNova = h.etapa_nova || h.etapa || '';
      const subEtapa = h.sub_etapa_nova || h.sub_etapa || '';
      const tipoMov = h.tipo_movimentacao || '';
      if (
        dataMov !== base.data_movimentacao ||
        comentario !== base.comentario ||
        etapaNova !== base.etapa_nova ||
        subEtapa !== base.sub_etapa ||
        tipoMov !== base.tipo_movimentacao
      ) {
        updates.push({
          id_historico: h.id,
          data: dataMov,
          comentario,
          etapa_nova: etapaNova,
          sub_etapa: subEtapa,
          tipo_movimentacao: tipoMov || undefined,
        });
      }
    });
    return updates;
  };

  const handleSaveHistorico = async () => {
    const updates = buildHistoricoUpdates();
    const deletes = Array.from(histDeletedIds || []);
    if (updates.length === 0 && deletes.length === 0) {
      setHistMessage({ type: 'info', text: 'Nenhuma alteração no histórico' });
      return;
    }
    setHistSaving(true);
    setHistMessage({ type: '', text: '' });
    try {
      if (!(await confirmAction('Deseja salvar as alteracoes deste processo?'))) return;
      await saveProcessoFull({
        processo_id: idProcesso,
        historico: updates,
        historico_delete_ids: deletes,
      });
      setHistMessage({ type: 'success', text: 'Histórico atualizado com sucesso' });
      setHistDeletedIds(new Set());
      const fresh = await api.get(`/processos/${idProcesso}/historico`);
      const list = Array.isArray(fresh?.data) ? fresh.data : [];
      setHistorico(list);
      const base = {};
      list.forEach((h) => {
        if (h && h.id != null) {
          base[String(h.id)] = {
            data_movimentacao: h.data_movimentacao || '',
            comentario: h.comentario || '',
            etapa_nova: h.etapa_nova || h.etapa || '',
            sub_etapa: h.sub_etapa_nova || h.sub_etapa || '',
            tipo_movimentacao: h.tipo_movimentacao || '',
          };
        }
      });
      setHistoricoOriginal(base);
    } catch (error) {
      setHistMessage({
        type: 'error',
        text: error?.message || 'Erro ao salvar histórico',
      });
    } finally {
      setHistSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-start justify-center z-50 p-4 pt-6 md:pt-10">
      <div
        className="sap-card text-[var(--fg)] max-w-3xl w-full max-h-[90vh] overflow-y-auto"
        ref={modalScrollRef}
      >
        {/* Header */}
        <div className="sticky top-0 bg-[var(--panel)] border-b panel-border p-6 flex justify-between items-center">
          <h2 className="text-xl font-bold">Editar Processo #{idProcesso}</h2>
          <button
            onClick={onClose}
            className="btn-outline p-2"
            disabled={saving}
          >
            <X size={24} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Messages */}
          {message.text && (
            <div
              className={`p-4 rounded-lg flex items-start gap-3 ${
                message.type === 'error'
                  ? 'bg-red-50 border border-red-200'
                  : message.type === 'success'
                  ? 'bg-green-50 border border-green-200'
                  : 'bg-blue-50 border border-blue-200'
              }`}
            >
              {message.type === 'success' && (
                <CheckCircle className="text-green-600 flex-shrink-0 mt-0.5" size={20} />
              )}
              {message.type === 'error' && (
                <AlertCircle className="text-red-600 flex-shrink-0 mt-0.5" size={20} />
              )}
              <div>
                <p
                  className={`font-medium ${
                    message.type === 'error'
                      ? 'text-red-900'
                      : message.type === 'success'
                      ? 'text-green-900'
                      : 'text-blue-900'
                  }`}
                >
                  {message.text}
                </p>
              </div>
            </div>
          )}

          {/* Errors */}
          {errors.length > 0 && (
            <div className="p-4 rounded-lg bg-red-50 border border-red-200">
              <p className="font-medium text-red-900 mb-2">Erros de validação:</p>
              <ul className="list-disc list-inside space-y-1">
                {errors.map((error, idx) => (
                  <li key={`error-${idx}`} className="text-red-700 text-sm">
                    {error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Loading */}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader className="animate-spin mr-2" />
              <p><span className="sap-loading">Carregando dados...</span></p>
            </div>
          ) : (
            <>
              {/* Form */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Seção: Dados Básicos */}
                <div className="md:col-span-2">
                  <h3 className="font-bold text-lg mb-4 pb-2 border-b">Dados Básicos</h3>
                </div>

                <InputField
                  label="UC"
                  value={formData.uc || ''}
                  onChange={(v) => handleFieldChange('uc', v)}
                  disabled={saving}
                  changed={changedFields.uc}
                />

                <InputField
                  label="Cliente"
                  value={formData.cliente || ''}
                  onChange={(v) => handleFieldChange('cliente', v)}
                  disabled={saving}
                  changed={changedFields.cliente}
                />

                <InputField
                  label="Concessionária"
                  value={formData.concessionaria || ''}
                  onChange={(v) => handleFieldChange('concessionaria', v)}
                  disabled={saving}
                  changed={changedFields.concessionaria}
                />

                <InputField
                  label="CNPJ"
                  value={formData.cnpj || requisicaoData?.cnpj || ''}
                  onChange={(v) => handleFieldChange('cnpj', v)}
                  disabled={true}
                />

                <InputField
                  label="Razão Social (Fatura)"
                  value={formData.razao_social_fatura || requisicaoData?.razao_social_fatura || ''}
                  onChange={(v) => handleFieldChange('razao_social_fatura', v)}
                  disabled={true}
                />

                <InputField
                  label="Status"
                  value={formData.status_class || ''}
                  onChange={(v) => handleFieldChange('status_class', v)}
                  disabled={saving}
                  changed={changedFields.status_class}
                />

                {/* Seção: Processo */}
                <div className="md:col-span-2">
                  <h3 className="font-bold text-lg mb-4 pb-2 border-b">Processo</h3>
                </div>

                <InputField
                  label="Etapa"
                  value={formData.etapa_nome || ''}
                  onChange={(v) => handleFieldChange('etapa_nome', v)}
                  disabled={saving}
                  changed={changedFields.etapa_nome}
                  placeholder="Ex: Deferido, Fluxo de Ressarcimento"
                />

                <InputField
                  label="Sub-Etapa"
                  value={formData.sub_etapa || ''}
                  onChange={(v) => handleFieldChange('sub_etapa', v)}
                  disabled={saving}
                  changed={changedFields.sub_etapa}
                  placeholder="Ex: Análise, Aprovado"
                />

                <InputField
                  label="Data da Requisição"
                  value={requisicaoData?.data_criacao || formData.data_criacao || ''}
                  onChange={() => {}}
                  disabled={true}
                />

                <InputField
                  label="Data de Aprovação"
                  value={requisicaoData?.data_mudanca_status || ''}
                  onChange={() => {}}
                  disabled={true}
                />

                <InputField
                  label="Data de Criação (Ativos)"
                  value={historicoAtivosDate || ''}
                  onChange={() => {}}
                  disabled={true}
                />

                <InputField
                  label="Última Movimentação"
                  value={formData.data_ultimo_avanco || ''}
                  onChange={() => {}}
                  disabled={true}
                />

                <InputField
                  label="Atualizado em"
                  value={formData.updated_at || ''}
                  onChange={() => {}}
                  disabled={true}
                />

                <InputField
                  label="Número do Protocolo"
                  value={formData.numero_protocolo || ''}
                  onChange={() => {}}
                  disabled={true}
                />

                <TextAreaField
                  label="Descrição"
                  value={requisicaoData?.descricao_irregularidade || formData.descricao_irregularidade || ''}
                  onChange={() => {}}
                  disabled={true}
                  rows={3}
                />

                <TextAreaField
                  label="Períodos de Irregularidade"
                  value={requisicaoData?.periodos_irregularidade || formData.periodos_irregularidade || ''}
                  onChange={() => {}}
                  disabled={true}
                  rows={2}
                />

                <InputField
                  label="Irregularidade"
                  value={requisicaoData?.tipo_irregularidade || formData.irregularidade_padrao || ''}
                  onChange={() => {}}
                  disabled={true}
                />

                <InputField
                  label="Sub Irregularidade"
                  value={requisicaoData?.subtipo_irregularidade || ''}
                  onChange={() => {}}
                  disabled={true}
                />

                <InputField
                  label="Link de Fatura"
                  value={requisicaoData?.link_fatura || formData.link_fatura || ''}
                  onChange={() => {}}
                  disabled={true}
                />

                <TextAreaField
                  label="Endereço Completo"
                  value={formData.endereco_completo || requisicaoData?.endereco_completo || ''}
                  onChange={() => {}}
                  disabled={true}
                  rows={2}
                />

                <CheckboxField
                  label="Suspenso"
                  checked={formData.suspenso || false}
                  onChange={(v) => handleFieldChange('suspenso', v)}
                  disabled={saving}
                  changed={changedFields.suspenso}
                />

                {formData.suspenso && (
                  <TextAreaField
                    label="Motivo da Suspensão"
                    value={formData.suspenso_motivo || ''}
                    onChange={(v) => handleFieldChange('suspenso_motivo', v)}
                    disabled={saving}
                    changed={changedFields.suspenso_motivo}
                    rows={2}
                  />
                )}

                {/* Seção: Deferimento */}
                <div className="md:col-span-2">
                  <h3 className="font-bold text-lg mb-4 pb-2 border-b">Deferimento</h3>
                </div>

                <InputField
                  label="Crédito Simples (R$)"
                  type="number"
                  value={formData.credito_simples || ''}
                  onChange={(v) => handleFieldChange('credito_simples', v ? parseFloat(v) : '')}
                  disabled={saving}
                  changed={changedFields.credito_simples}
                  step="0.01"
                />

                <InputField
                  label="Data Deferimento"
                  type="date"
                  value={convertToDateInput(formData.data_procedencia)}
                  onChange={(v) => handleFieldChange('data_procedencia', v)}
                  disabled={saving}
                  changed={changedFields.data_procedencia}
                />

                <InputField
                  label="Crédito Dobro (R$)"
                  type="number"
                  value={formData.credito_dobro || ''}
                  onChange={(v) => handleFieldChange('credito_dobro', v ? parseFloat(v) : '')}
                  disabled={saving}
                  changed={changedFields.credito_dobro}
                  step="0.01"
                />

                <InputField
                  label="Data Dobro"
                  type="date"
                  value={convertToDateInput(formData.data_dobro)}
                  onChange={(v) => handleFieldChange('data_dobro', v)}
                  disabled={saving}
                  changed={changedFields.data_dobro}
                />

                {/* Seção: Fluxo de Ressarcimento */}
                <div className="md:col-span-2">
                  <h3 className="font-bold text-lg mb-4 pb-2 border-b">Fluxo de Ressarcimento</h3>
                </div>

                <SelectField
                  label="Forma de Devolução"
                  value={formData.forma_devolucao || ''}
                  onChange={(v) => handleFieldChange('forma_devolucao', v)}
                  disabled={saving}
                  changed={changedFields.forma_devolucao}
                  options={[
                    { value: '', label: '-- Selecione --' },
                    { value: 'Fatura', label: 'Fatura' },
                    { value: 'GD', label: 'GD (Guia de Devolução)' },
                    { value: 'Deposito', label: 'Depósito' },
                  ]}
                />

                <InputField
                  label="Valor Ressarcimento (R$)"
                  type="number"
                  value={formData.valor_ressarcimento || ''}
                  onChange={(v) =>
                    handleFieldChange('valor_ressarcimento', v ? parseFloat(v) : '')
                  }
                  disabled={saving}
                  changed={changedFields.valor_ressarcimento}
                  step="0.01"
                />

                <InputField
                  label="Data Devolução"
                  type="date"
                  value={convertToDateInput(formData.data_devolucao)}
                  onChange={(v) => handleFieldChange('data_devolucao', v)}
                  disabled={saving}
                  changed={changedFields.data_devolucao}
                />

                <InputField
                  label="Data Envio Financeiro"
                  type="date"
                  value={convertToDateInput(formData.data_envio_financeiro)}
                  onChange={(v) => handleFieldChange('data_envio_financeiro', v)}
                  disabled={saving}
                  changed={changedFields.data_envio_financeiro}
                />

                {/* Seção: Histórico */}
                <div className="md:col-span-2">
                  <h3 className="font-bold text-lg mb-4 pb-2 border-b">Histórico</h3>
                </div>

                <TextAreaField
                  label="Novo Comentário (adiciona ao histórico)"
                  value={formData.novo_comentario || ''}
                  onChange={(v) => handleFieldChange('novo_comentario', v)}
                  disabled={saving}
                  changed={changedFields.novo_comentario}
                  rows={3}
                  placeholder="Adicione um comentário que será registrado no histórico..."
                />

                {/* Seção: Anexos */}
                <div className="md:col-span-2">
                  <h3 className="font-bold text-lg mb-4 pb-2 border-b">Anexos</h3>
                </div>
                <div className="md:col-span-2">
                  {anexos.length === 0 ? (
                    <div className="text-sm opacity-70">Nenhum anexo.</div>
                  ) : (
                    <div className="space-y-2">
                      {anexos.map((a, idx) => {
                        const path = String(a.url || a.caminho_arquivo || '').trim();
                        const href = path.startsWith('http') ? path : path ? `/${path.replace(/^\/+/, '')}` : '';
                        return (
                          <div key={`${a.id ?? 'anexo'}-${idx}`} className="flex items-center justify-between text-sm border border-gray-200 rounded p-2">
                            <div>
                              <div className="font-medium">{a.nome_arquivo}</div>
                              <div className="text-xs opacity-70">{a.data_upload || ''}</div>
                            </div>
                            {href ? (
                              <a className="text-blue-600 underline" href={withAuthToken(href)} target="_blank" rel="noreferrer">
                                Abrir
                              </a>
                            ) : (
                              <span className="text-xs opacity-60">Sem link</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Seção: Faturas */}
                <div className="md:col-span-2">
                  <h3 className="font-bold text-lg mb-4 pb-2 border-b">Faturas</h3>
                </div>
                <div className="md:col-span-2">
                  {faturas.length === 0 ? (
                    <div className="text-sm opacity-70">Nenhuma fatura vinculada.</div>
                  ) : (
                    <div className="space-y-2">
                      {faturas.map((f) => (
                        <div key={`fatura-${f.id || f.mes_ref || Math.random()}`} className="flex items-center justify-between text-sm border border-gray-200 rounded p-2">
                          <div>
                            <div className="font-medium">{f.mes_ref || f.mesRef || 'Sem mês'}</div>
                            <div className="text-xs opacity-70">
                              {f.dt_vencimento || f.dtVencimento || ''} {f.valor_total != null ? `• R$ ${f.valor_total}` : ''}
                            </div>
                          </div>
                          {f.link ? (
                            <a className="text-blue-600 underline" href={f.link} target="_blank" rel="noreferrer">
                              Abrir
                            </a>
                          ) : (
                            <span className="text-xs opacity-60">Sem link</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Seção: Histórico completo */}
                <div className="md:col-span-2">
                  <h3 className="font-bold text-lg mb-4 pb-2 border-b">Histórico completo (editável)</h3>
                </div>
                <div className="md:col-span-2 space-y-3">
                  {histMessage.text && (
                    <div
                      className={`p-3 rounded border ${
                        histMessage.type === 'error'
                          ? 'bg-red-50 border-red-200 text-red-800'
                          : histMessage.type === 'success'
                          ? 'bg-green-50 border-green-200 text-green-800'
                          : 'bg-blue-50 border-blue-200 text-blue-800'
                      }`}
                    >
                      {histMessage.text}
                    </div>
                  )}
                  {historico.length === 0 ? (
                    <div className="text-sm opacity-70">Nenhum histórico encontrado.</div>
                  ) : (
                    <div className="space-y-2">
                      {historico.map((h, idx) => {
                        const isDeleted = histDeletedIds.has(h.id);
                        return (
                          <div key={`${h.id ?? 'hist'}-${idx}`} className={`border rounded p-3 ${isDeleted ? 'opacity-60 line-through' : ''}`}>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                              <div>
                                <label className="text-xs font-medium">Data (YYYY-MM-DD HH:mm:ss)</label>
                                <input
                                  className="input-themed w-full text-sm"
                                  value={h.data_movimentacao || ''}
                                  onChange={(e) => handleHistoricoChange(h.id, 'data_movimentacao', e.target.value)}
                                  disabled={isDeleted}
                                />
                              </div>
                              <div>
                                <label className="text-xs font-medium">Etapa</label>
                                <input
                                  className="input-themed w-full text-sm"
                                  value={h.etapa_nova || h.etapa || ''}
                                  onChange={(e) => handleHistoricoChange(h.id, 'etapa_nova', e.target.value)}
                                  disabled={isDeleted}
                                />
                              </div>
                              <div>
                                <label className="text-xs font-medium">Sub-etapa</label>
                                <input
                                  className="input-themed w-full text-sm"
                                  value={h.sub_etapa_nova || h.sub_etapa || ''}
                                  onChange={(e) => handleHistoricoChange(h.id, 'sub_etapa_nova', e.target.value)}
                                  disabled={isDeleted}
                                />
                              </div>
                              <div className="md:col-span-3">
                                <label className="text-xs font-medium">Comentário</label>
                                <textarea
                                  className="input-themed w-full text-sm"
                                  rows={2}
                                  value={h.comentario || ''}
                                  onChange={(e) => handleHistoricoChange(h.id, 'comentario', e.target.value)}
                                  disabled={isDeleted}
                                />
                              </div>
                              <div className="md:col-span-3 flex justify-end">
                                <button
                                  type="button"
                                  className="btn-outline text-xs"
                                  onClick={() => toggleHistoricoDelete(h.id)}
                                >
                                  {isDeleted ? 'Desfazer exclusão' : 'Excluir'}
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={handleSaveHistorico}
                      disabled={histSaving}
                      className="px-4 py-2 bg-[var(--accent)] text-[var(--fg)] font-bold rounded hover:opacity-90 disabled:opacity-60"
                    >
                      {histSaving ? 'Salvando...' : 'Salvar histórico'}
                    </button>
                  </div>
                </div>
              </div>

              {/* Info sobre mudanças */}
              {hasChanges && (
                <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-sm text-blue-900">
                    <strong>{Object.keys(changedFields).length}</strong> campo(s) alterado(s)
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-white border-t p-6 flex justify-end gap-3">
          <button
            onClick={handleReset}
            disabled={!hasChanges || saving || loading}
            className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Descartar Mudanças
          </button>
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Fechar
          </button>
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving || loading}
            className="btn-themed disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {saving && <Loader size={16} className="animate-spin" />}
            {saving ? 'Salvando...' : 'Salvar e Sincronizar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Componentes de Form
// ============================================================================

function InputField({
  label,
  value,
  onChange,
  disabled,
  changed,
  type = 'text',
  placeholder = '',
  step,
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="font-medium text-sm">
        {label}
        {changed && <span className="ml-2 text-blue-600 font-bold">●</span>}
      </label>
      <input
        type={type}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        step={step}
        className={`px-3 py-2 border rounded ${
          disabled
            ? 'bg-gray-100 cursor-not-allowed'
            : 'bg-white hover:border-gray-400'
        } ${
          changed ? 'border-blue-500 bg-blue-50' : 'border-gray-300'
        }`}
      />
    </div>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  disabled,
  changed,
  placeholder = '',
  rows = 3,
}) {
  return (
    <div className="flex flex-col gap-2 md:col-span-2">
      <label className="font-medium text-sm">
        {label}
        {changed && <span className="ml-2 text-blue-600 font-bold">●</span>}
      </label>
      <textarea
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        rows={rows}
        className={`px-3 py-2 border rounded ${
          disabled
            ? 'bg-gray-100 cursor-not-allowed'
            : 'bg-white hover:border-gray-400'
        } ${
          changed ? 'border-blue-500 bg-blue-50' : 'border-gray-300'
        }`}
      />
    </div>
  );
}

function CheckboxField({ label, checked, onChange, disabled, changed }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={checked || false}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="w-5 h-5 cursor-pointer"
      />
      <label className="font-medium text-sm cursor-pointer">
        {label}
        {changed && <span className="ml-2 text-blue-600 font-bold">●</span>}
      </label>
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  disabled,
  changed,
  options = [],
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="font-medium text-sm">
        {label}
        {changed && <span className="ml-2 text-blue-600 font-bold">●</span>}
      </label>
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={`px-3 py-2 border rounded ${
          disabled
            ? 'bg-gray-100 cursor-not-allowed'
            : 'bg-white hover:border-gray-400'
        } ${
          changed ? 'border-blue-500 bg-blue-50' : 'border-gray-300'
        }`}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ============================================================================
// Utilitários
// ============================================================================

function convertToDateInput(dateStr) {
  if (!dateStr) return '';
  // Converter dd/mm/yyyy ou yyyy-mm-dd para yyyy-mm-dd (formato input date)
  const match = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (match) {
    const [, day, month, year] = match;
    return `${year}-${month}-${day}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    return dateStr.substring(0, 10);
  }
  return '';
}

