// src/pages/AdminEditor.jsx

import React, { useEffect, useState, useRef } from 'react';

import { saveProcessoFull, getNextProcessID } from '../services/adminEditorService';

import {
  getRequisicaoById,
  getHistoricoById,
  atualizarRequisicaoCompleta,
  getProcessosKanbanFast,
  getFluxoRessarcimento,
  getFaturamento,
  getDeferimentoByProcesso,
} from '../services/requisicaoService';
import { listPlanilha } from '../services/adminPlanilhaService';

import { useAuth } from '../context/AuthContext.jsx';

import { getEtapas, getSubEtapas, getEtapaSubMap } from '../services/filtersService';
import { normalizeDecimalValue, normalizeCreditoValue, toNumberBR } from '../utils/brl';
import { confirmAction } from '../utils/confirm.js';

import './admin-editor.css';

// Toast substituído por modal centralizado nesta tela
import ControleProcessos from './ControleProcessos.jsx';

export default function AdminEditor() {
  const { user } = useAuth();
  const isAdmin = String(user?.tipo_conta || '').toLowerCase() === 'admin';

  const [processoId, setProcessoId] = useState('');
  const [criarNovo, setcriarNovo] = useState(false);
  const [ucBusca, setUcBusca] = useState('');

  const [req, setReq] = useState({});
  const [proc, setProc] = useState({});
  const [deferimento, setDeferimento] = useState({});
  const [fluxo, setFluxo] = useState([]);
  const [fat, setFat] = useState([]);
  const [hist, setHist] = useState([]);
  const [histDeletes, setHistDeletes] = useState([]);

  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [selectedColuna, setSelectedColuna] = useState('');
  const [toast, setToast] = useState({ open: false, type: 'info', text: '' });

  // Bulk por UC (modal)
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkInput, setBulkInput] = useState('');
  const [bulkResolvido, setBulkResolvido] = useState([]); // [{ uc, ids:[], selectedId:null|number, status:'ok'|'dup'|'miss', msg?:string }]
  const [bulkEtapa, setBulkEtapa] = useState('Ativos');
  const [bulkCSimples, setBulkCSimples] = useState(''); // número ou lista CSV
  const [bulkDSimples, setBulkDSimples] = useState(''); // data dd/mm/aaaa ou CSV
  const [bulkCDobro, setBulkCDobro] = useState(''); // número ou CSV
  const [bulkDDobro, setBulkDDobro] = useState(''); // data dd/mm/aaaa ou CSV
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkApplying, setBulkApplying] = useState(false);
  const [planilhaOpen, setPlanilhaOpen] = useState(false);

  const [etapasOpts, setEtapasOpts] = useState([]);
  const [subEtapasOpts, setSubEtapasOpts] = useState([]);
  const [etapaSubMap, setEtapaSubMap] = useState({});

  const kanbanCols = [
    'Ativos',
    'Deferidos',
    'Fluxo de Ressarcimento',
    'Faturamento',
    'Concluídos',
    'Indeferidos',
    'Suspensos',
  ];

  const colToEtapa = {
    Ativos: 'Distribuidora',
    Deferidos: 'Distribuidora',
    'Fluxo de Ressarcimento': 'Enviado ao Financeiro',
    Faturamento: 'Repasse Amee',
    Concluídos: 'Concluído',
    Indeferidos: 'Indeferido',
    Suspensos: 'Suspenso',
  };
  const etapaToColuna = (etapaNome = '') => {
    const norm = String(etapaNome || '').toLowerCase().trim();
    if (['distribuidora', 'ouvidoria', 'aneel', 'sma', 'andamento'].some((k) => norm.includes(k))) return 'Ativos';
    if (['pendente', 'concili', 'contesta'].some((k) => norm.includes(k))) return 'Deferidos';
    if (norm.includes('fluxo') || norm.includes('financeiro') || norm.includes('validacao')) return 'Fluxo de Ressarcimento';
    if (norm.includes('fatur')) return 'Faturamento';
    if (norm.includes('conclu')) return 'Concluídos';
    if (norm.includes('indefer')) return 'Indeferidos';
    return '';
  };

  // Helpers de data (exibição BR e normalização para envio)
  const toBRDateTime = (s) => {
    if (!s) return '';
    const str = String(s).trim().replace('T', ' ');
    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}:\d{2}:\d{2}|\d{2}:\d{2}))?/);
    if (m) {
      const [, y, mo, d, t] = m;
      return `${d}/${mo}/${y}${t ? ` ${t}` : ''}`;
    }
    return str;
  };
  const toUnix = (s) => {
    if (!s) return 0;
    const str = String(s).trim();
    const m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}:\d{2}:\d{2}|\d{2}:\d{2}))?/);
    if (m) {
      const [, d, mo, y, t] = m;
      return new Date(`${y}-${mo}-${d}${t ? `T${t}` : ''}`).getTime();
    }
    const d = new Date(str);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  };

const normalizeDateInput = (s) => {
    const raw = String(s || '').trim();
    if (!raw) return null;
    const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(.+))?$/);
    if (m) {
      const [, d, mo, y, t] = m;
      return `${y}-${mo}-${d}${t ? ` ${t.trim()}` : ''}`;
    }
    return raw;
  };

  const normalizeStatusValue = (value) => {
    const raw = String(value || '').toLowerCase();
    if (raw.includes('nova') || raw.includes('pendente')) return 'Nova Requisição';
    if (raw.includes('analise')) return 'Em Análise';
    if (raw.includes('aprov')) return 'Aprovado';
    if (raw.includes('rejeit')) return 'Rejeitado';
    return value || '';
  };

  // Ao aprovar, direciona a coluna para "Ativos"
  useEffect(() => {
    const statusValue = normalizeStatusValue(selectedStatus);
    if (statusValue === 'Aprovado') {
      setSelectedColuna('Ativos');
      const etapa = colToEtapa.Ativos;
      if (etapa) {
        setProc((s) => ({ ...s, etapa, sub_etapa: '' }));
      }
    }
  }, [selectedStatus]);


  // Refs para foco automático em Sub-etapa
  const subProcRef = useRef(null);
  const subHistRefs = useRef({});

  useEffect(() => {
    setMsg('');
  }, [processoId, criarNovo]);

  // Quando marcar "Criar novo", sugere automaticamente o próximo ID
  useEffect(() => {
    (async () => {
      try {
        if (criarNovo) {
          const next = await getNextProcessID();
          if (next) setProcessoId(String(next));
        }
      } catch {
        /* silencioso */
      }
    })();
  }, [criarNovo]);

  // Carregar opções de etapas/subetapas
  useEffect(() => {
    (async () => {
      try {
        const [e, s, m] = await Promise.all([getEtapas(), getSubEtapas(), getEtapaSubMap()]);
        setEtapasOpts(e || []);
        setSubEtapasOpts(s || []);
        setEtapaSubMap(m || {});
      } catch {
        /* silencioso */
      }
    })();
  }, []);

  const filteredSubFor = (etapaNome) => {
    const key = String(etapaNome || '').trim();
    const arr = etapaSubMap[key];
    if (Array.isArray(arr) && arr.length) return arr;
    return subEtapasOpts;
  };

  const clearAll = () => {
    setProcessoId('');
    setUcBusca('');
    setReq({});
    setProc({});
    setDeferimento({});
    setFluxo([]);
    setFat([]);
    setHist([]);
    setHistDeletes([]);
    setSelectedStatus('');
    setSelectedColuna('');
    setMsg('');
    setToast((t) => ({ ...t, open: false, text: '' }));
  };

  const [disparandoAlertas, setDisparandoAlertas] = useState(false);
  const [alertasMsg, setAlertasMsg] = useState('');

  const dispararAlertas = async () => {
    setDisparandoAlertas(true);
    setAlertasMsg('');
    try {
      const token = localStorage.getItem('userToken');
      const r = await fetch('/api/v1/admin/alertas/disparar-agora', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json();
      if (r.ok) {
        setAlertasMsg('✓ Alertas disparados! Verifique os e-mails em instantes.');
      } else {
        setAlertasMsg(`Erro: ${data?.error || r.status}`);
      }
    } catch (e) {
      setAlertasMsg(`Erro: ${e.message}`);
    } finally {
      setDisparandoAlertas(false);
      setTimeout(() => setAlertasMsg(''), 6000);
    }
  };

  const Toolbar = () => (
    <div className="mb-4 flex items-center gap-2 flex-wrap">
      <button className="btn-outline" onClick={() => setPlanilhaOpen((v) => !v)}>
        {planilhaOpen ? 'Voltar ao editor' : 'Em Massa'}
      </button>
      <button
        className="btn-outline"
        onClick={dispararAlertas}
        disabled={disparandoAlertas}
        title="Envia e-mails de todos os alertas pendentes de hoje (equipe e pessoais)"
      >
        {disparandoAlertas ? '⟳ Disparando...' : '🔔 Disparar Alertas'}
      </button>
      {alertasMsg && (
        <span style={{ fontSize: 12, color: alertasMsg.startsWith('✓') ? '#10b981' : '#ef4444' }}>
          {alertasMsg}
        </span>
      )}
    </div>
  );

  const loadById = async () => {
    try {
      let idStr = String(processoId || '').trim();

      if (!idStr) {
        // Buscar por UC quando não houver ID
        const q = String((ucBusca || req?.uc || '')).trim();
        if (!q) return;

        const dataFast = await getProcessosKanbanFast();
        const colunas = dataFast?.colunas || {};
        const matches = [];
        for (const [, itens] of Object.entries(colunas)) {
          (itens || []).forEach((it) => {
            const ucStr = String(it?.uc ?? '').trim();
            if (ucStr && ucStr.toLowerCase() === q.toLowerCase()) matches.push(Number(it.id));
          });
        }
        if (matches.length === 0) {
          setToast({ open: true, type: 'info', text: `Nenhum processo encontrado para a UC ${q}.` });
          return;
        }
        if (matches.length > 1) {
          setToast({
            open: true,
            type: 'warning',
            text: `UC duplicada: ${q} em ${matches.length} processos (IDs: ${matches.join(', ')}).`,
          });
          return;
        }
        idStr = String(matches[0]);
        setProcessoId(idStr);
        setcriarNovo(false);
      }

        const data = await getRequisicaoById(idStr);
        setReq({
          id: data?.id ?? data?.requisicao_id ?? data?.req_id ?? null,
          uc: data?.uc ?? '',
          cliente: data?.cliente?.String ?? data?.cliente ?? '',
          concessionaria: data?.concessionaria ?? '',
          cnpj: data?.cnpj ?? '',
          endereco_completo: data?.endereco_completo ?? '',
          razao_social_fatura: data?.razao_social_fatura ?? '',
          ressarcimento_estimado: normalizeDecimalValue(
            data?.valor_estimado ?? data?.ressarcimento_estimado ?? '',
          ),
          link_fatura: data?.link_fatura ?? '',
          data_criacao_requisicao: data?.data_criacao ? toBRDateTime(data.data_criacao) : '',
        });
      setProc({
        etapa: data?.etapa ?? '',
        sub_etapa: data?.sub_etapa ?? '',
        relevancia: !!data?.relevancia,
        data_alerta: data?.data_alerta ? toBRDateTime(data.data_alerta).slice(0, 10) : '',
        ultima_atualizacao: data?.ultima_atualizacao ? toBRDateTime(data.ultima_atualizacao) : '',
      });
      // Deriva coluna atual para exibir na UI
      const colNome =
        data?.coluna_kanban_nome ||
        data?.coluna_kanban ||
        etapaToColuna(data?.etapa) ||
        etapaToColuna(data?.coluna_kanban_nome);
      if (colNome) setSelectedColuna(String(colNome));

      // Deferimento direto do processo, se vier no payload principal
      const unwrapDate = (v) => {
        if (!v) return '';
        if (typeof v === 'string') return v;
        if (typeof v === 'object') {
          if (v.Valid === false) return '';
          return v.Time || v.time || v.value || '';
        }
        return String(v);
      };

      const normalizeDef = (src = {}) => ({
        data_procedencia: toBRDateTime(
          unwrapDate(src.data_procedencia || src.DataProcedencia || src.dataProcedencia || ''),
        ).slice(0, 10),
        credito_simples: normalizeCreditoValue(
          src.credito_simples ?? src.CreditoSimples ?? src.creditoSimples ?? '',
        ),
        credito_dobro: normalizeCreditoValue(
          src.credito_dobro ?? src.CreditoDobro ?? src.creditoDobro ?? '',
        ),
        data_credito_dobro: toBRDateTime(
          unwrapDate(src.data_credito_dobro || src.DataCreditoDobro || src.dataCreditoDobro || ''),
        ).slice(0, 10),
      });

      const defFromProc = data?.deferimento ? normalizeDef(data.deferimento) : null;

      const [h, fluxoSaved, fatSaved, defSaved, planRows] = await Promise.all([
        getHistoricoById(idStr),
        getFluxoRessarcimento(idStr).catch(() => null),
        getFaturamento(idStr).catch(() => null),
        getDeferimentoByProcesso(idStr).catch(() => null),
        listPlanilha({ q: idStr, limit: 1 }).catch(() => []),
      ]);

      setHist(
        (h || [])
          .map((x) => ({
          id_historico: x.id_historico || x.idhistorico || x.id,
          data: toBRDateTime(x.data_movimentacao || x.data || x.created_at),
          comentario: x.comentario || '',
          etapa_anterior: x.etapa_anterior || '',
          etapa_nova: x.etapa_nova || '',
          sub_etapa: x.sub_etapa || '',
          status_anterior: x.status_anterior || '',
          status_novo: x.status_novo || '',
          relevancia_anterior: parseBoolLoose(x.relevancia_anterior),
          relevancia_nova: parseBoolLoose(x.relevancia_nova),
        }))
          .sort((a, b) => toUnix(b.data) - toUnix(a.data)),
      );

      const fluxArr = Array.isArray(fluxoSaved?.itens)
        ? fluxoSaved.itens
        : Array.isArray(fluxoSaved)
        ? fluxoSaved
        : [];

        setFluxo(
          (fluxArr || []).map((it) => ({
            forma_devolucao: it.forma_devolucao || it.formaDevolucao || 'Fatura',
            valor: normalizeDecimalValue(it.valor ?? it.valor_fluxo ?? it.valorFluxo ?? ''),
            data_devolucao: toBRDateTime(it.data_devolucao || it.dataDevolucao || '').slice(0, 10),
            data_envio_financeiro: toBRDateTime(
              it.data_envio_financeiro || it.dataEnvioFinanceiro || '',
            ).slice(0, 10),
          })),
        );

      const fatArr = Array.isArray(fatSaved?.itens)
        ? fatSaved.itens
        : Array.isArray(fatSaved)
        ? fatSaved
        : [];

        setFat(
          (fatArr || []).map((it) => ({
            numero_nf: it.numero_nf || it.numero || it.nf || '',
            data_emissao: toBRDateTime(it.data_emissao || '').slice(0, 10),
            data_vencimento: toBRDateTime(it.data_vencimento || '').slice(0, 10),
            data_pagamento: toBRDateTime(it.data_pagamento || '').slice(0, 10),
            valor: normalizeDecimalValue(it.valor ?? it.valor_nf ?? it.valorNf ?? ''),
            anexo_nome: it.anexo_nome || it.anexo || it.nome_anexo || it.nome || '',
          })),
        );

      const row = Array.isArray(planRows) && planRows.length ? planRows[0] : null;
      const defFromPlan = row
        ? normalizeDef({
            data_procedencia: row.data_simples,
            credito_simples: row.credito_simples,
            credito_dobro: row.credito_dobro,
            data_credito_dobro: row.data_dobro,
          })
        : null;

      // Endpoint específico para deferimento por processo foi desativado.
      // Caso seja reintroduzido no futuro, basta adicionar aqui algo como:
      const defFromApi = defSaved ? normalizeDef(defSaved) : null;

      const mergeDef = (...defs) => {
        const fields = ['data_procedencia', 'credito_simples', 'credito_dobro', 'data_credito_dobro'];
        const out = {};
        defs
          .filter(Boolean)
          .forEach((d) =>
            fields.forEach((f) => {
              if (d[f] !== undefined && d[f] !== null && d[f] !== '' && out[f] === undefined) {
                out[f] = d[f];
              }
            }),
          );
        return out;
      };

      const finalDef = mergeDef(defFromProc, defFromApi, defFromPlan);
      setDeferimento(finalDef);
    } catch (e) {
      setMsg(e?.response?.data?.error || e?.message || 'Falha ao carregar processo');
    }
  };

  const addFluxo = () =>
    setFluxo((prev) => [
      ...prev,
      { forma_devolucao: 'Fatura', valor: 0, data_devolucao: '', data_envio_financeiro: '' },
    ]);

  const addFat = () =>
    setFat((prev) => [
      ...prev,
      { numero_nf: '', data_emissao: '', data_vencimento: '', data_pagamento: '', valor: 0, anexo_nome: '' },
    ]);

  const addHist = () =>
    setHist((prev) => [
      ...prev,
      {
        data: new Date().toISOString().slice(0, 19).replace('T', ' '),
        comentario: '',
        etapa_anterior: '',
        etapa_nova: '',
        sub_etapa: '',
        status_anterior: '',
        status_novo: '',
        relevancia_anterior: null,
        relevancia_nova: null,
      },
    ]);

  const save = async () => {
    try {
      setSaving(true);
      setMsg('');
      if (!(await confirmAction('Deseja salvar as alteracoes deste processo?'))) {
        setSaving(false);
        return;
      }

      // Aviso de UC duplicada antes de salvar (não bloqueia)
      try {
        const uc = String(req?.uc || '').trim();
        if (uc) {
          const data = await getProcessosKanbanFast();
          const colunas = data?.colunas || {};
          const ids = [];
          for (const [, itens] of Object.entries(colunas)) {
            (itens || []).forEach((it) => {
              const u = String(it?.uc ?? '').trim();
              if (u && u.toLowerCase() === uc.toLowerCase()) ids.push(Number(it.id));
            });
          }
          const uniq = Array.from(new Set(ids.filter(Number.isFinite)));
          const currIdNum = Number(processoId);
          const isCreate = !!criarNovo;
          let duplicated = false;
          if (isCreate) duplicated = uniq.length >= 1;
          else if (currIdNum > 0) duplicated = uniq.filter((id) => id !== currIdNum).length >= 1;
          else duplicated = uniq.length > 1;

          if (duplicated) {
            setToast({
              open: true,
              type: 'warning',
              text: `UC duplicada: ${uc} em processos (IDs: ${uniq.join(', ')}).`,
            });
          }
        }
      } catch {
        /* silencioso */
      }

      const payload = {
        criar_novo: !!criarNovo,
        processo_id: criarNovo ? undefined : Number(processoId),
        coluna: selectedColuna || null,

        uc: emptyToNull(req.uc),
        cliente: emptyToNull(req.cliente),
        concessionaria: emptyToNull(req.concessionaria),
        cnpj: emptyToNull(req.cnpj),
        endereco_completo: emptyToNull(req.endereco_completo),
        razao_social_fatura: emptyToNull(req.razao_social_fatura),
        ressarcimento_estimado: (() => {
          const normalized = normalizeDecimalValue(req.ressarcimento_estimado);
          return normalized === '' ? null : toNumberBR(normalized);
        })(),
        link_fatura: emptyToNull(req.link_fatura),
        data_criacao_requisicao: normalizeDateInput(req.data_criacao_requisicao),

        etapa: emptyToNull(proc.etapa),
        sub_etapa: emptyToNull(proc.sub_etapa),
        relevancia: !!proc.relevancia,
        data_alerta: normalizeDateInput(proc.data_alerta),
        ultima_atualizacao: normalizeDateInput(proc.ultima_atualizacao),

        deferimento: (() => {
          const ds = normalizeDateInput(deferimento?.data_procedencia);
          const dd = normalizeDateInput(deferimento?.data_credito_dobro);
          const csNormalized = normalizeCreditoValue(deferimento?.credito_simples);
          const cdNormalized = normalizeCreditoValue(deferimento?.credito_dobro);
          const has =
            (ds && ds !== '') ||
            (dd && dd !== '') ||
            csNormalized !== '' ||
            cdNormalized !== '';
          if (!has) return undefined;
          return JSON.stringify({
            data_procedencia: ds || '',
            credito_simples: csNormalized === '' ? 0 : toNumberBR(csNormalized),
            credito_dobro: cdNormalized === '' ? 0 : toNumberBR(cdNormalized),
            data_credito_dobro: dd || '',
          });
        })(),

        fluxo_ressarcimento: JSON.stringify({
          itens: (fluxo || []).map((it) => {
            const valorNormalizado = normalizeDecimalValue(it.valor);
            return {
              ...it,
              valor: toNumberBR(valorNormalizado),
              data_devolucao: normalizeDateInput(it.data_devolucao) || '',
              data_envio_financeiro: normalizeDateInput(it.data_envio_financeiro) || '',
            };
          }),
        }),
        faturamento: JSON.stringify({
          itens: (fat || []).map((it) => {
            const valorNormalizado = normalizeDecimalValue(it.valor);
            return {
              ...it,
              valor: toNumberBR(valorNormalizado),
              data_emissao: normalizeDateInput(it.data_emissao) || '',
              data_vencimento: normalizeDateInput(it.data_vencimento) || '',
              data_pagamento: normalizeDateInput(it.data_pagamento) || '',
              anexo_nome: it.anexo_nome || '',
            };
          }),
        }),
        historico: (hist || [])
          .filter((x) => x.data) // mantém registros com ou sem comentário
          .map((x) => ({
            id_historico: x.id_historico,
            data: normalizeDateInput(x.data),
            comentario: x.comentario,
            etapa_anterior: emptyToNull(x.etapa_anterior),
            etapa_nova: emptyToNull(x.etapa_nova),
            sub_etapa: emptyToNull(x.sub_etapa),
            status_anterior: emptyToNull(x.status_anterior),
            status_novo: emptyToNull(x.status_novo),
            relevancia_anterior: normalizeBoolOrNull(x.relevancia_anterior),
            relevancia_nova: normalizeBoolOrNull(x.relevancia_nova),
            tipo_movimentacao: emptyToNull(x.tipo_movimentacao),
            justificativa_atraso: emptyToNull(x.justificativa_atraso),
          })),
        historico_delete_ids: histDeletes,
      };

      const res = await saveProcessoFull(payload);
      if (res?.ok) {
        const pid = Number(criarNovo ? res.processo_id : processoId);

        // Atualiza status da requisição se houver seleção nos botões
        const requisicaoId = req?.id ?? req?.requisicao_id ?? req?.req_id ?? null;
        const statusValue = normalizeStatusValue(selectedStatus);
        if (statusValue && requisicaoId) {
          try {
            const fd = new FormData();
            fd.append('status', statusValue);
            fd.append('comentario', 'Atualizado via Admin Editor');
            await atualizarRequisicaoCompleta(requisicaoId, fd);
          } catch {
            /* mantém o save mesmo se status falhar */
          }
        }

        if (statusValue === 'Aprovado' && pid) {
          try {
            const fd = new FormData();
            const etapaDestino = colToEtapa.Ativos || proc.etapa || colToEtapa[selectedColuna];
            if (etapaDestino) fd.append('etapa_atual', etapaDestino);
            fd.append('comentario', 'Aprovado via Admin Editor');
            // eslint-disable-next-line no-undef
            await movimentarProcesso(pid, fd);
          } catch {
            /* não bloqueia o save */
          }
        }

        const sucesso = 'Salvo com sucesso (processo ' + res.processo_id + ')';
        setMsg(sucesso);
        setToast({ open: true, type: 'success', text: sucesso });
        if (criarNovo) setProcessoId(String(res.processo_id));
        // Recarrega dados do processo para refletir valores persistidos no backend
        if (pid) {
          setcriarNovo(false);
          await loadById();
        }
      } else {
        setMsg('Falha ao salvar');
        setToast({ open: true, type: 'error', text: 'Falha ao salvar' });
      }
    } catch (e) {
      const err = e?.response?.data?.error || e?.message || 'Erro ao salvar';
      setMsg(err);
      setToast({ open: true, type: 'error', text: err });
    } finally {
      setSaving(false);
    }
  };

  // Mantém a coluna escolhida pelo usuário ao aprovar (não força "Deferidos")

  if (!isAdmin) return <div className="p-8 text-center">Acesso restrito ao administrador.</div>;

  return (
    <div className="p-4 w-full bg-background text-foreground min-h-screen">
      <Toolbar />

      {planilhaOpen ? (
        <ControleProcessos />
      ) : (
        <>
          <div
            className="rounded-xl shadow-elevated p-4 mb-4 flex items-center justify-between gap-3 border-2"
            style={{
              background: 'var(--header-bg)',
              borderColor: 'var(--header-border)',
              color: 'var(--header-fg)',
            }}
          >
            <h1 className="text-xl font-extrabold tracking-tight">Editor de Processo (Admin)</h1>
            <div className="flex items-center gap-2">
              <button className="px-4 py-2 bg-green-600 text-white rounded" onClick={save} disabled={saving}>
                {saving ? 'Salvando...' : 'Salvar'}
              </button>
              <button
                type="button"
                className="btn-outline"
                onClick={() => setBulkOpen(true)}
                disabled={saving}
              >
                Bulk por UC
              </button>
              <button type="button" className="btn-outline" onClick={clearAll} disabled={saving}>
                Limpar
              </button>
            </div>
          </div>

          {/* Destino: Status da requisição */}
          <section
            className="mb-4 p-3 border rounded glass-card gradient-card shadow-medium"
            style={{ background: 'var(--panel-processos)', borderColor: 'var(--border)' }}
          >
            <h2 className="font-semibold mb-2">Destino (Status)</h2>
            <div className="flex flex-wrap gap-2">
              {['Pendente', 'Em Análise', 'Aprovado', 'Rejeitado'].map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setSelectedStatus(st)}
                  className={`px-3 py-1 rounded border ${
                    selectedStatus === st ? 'bg-[var(--accent)] text-[var(--fg)]' : 'border-[var(--panel-border)]'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
          </section>

          {/* Destino: Coluna do processo (Kanban) */}
          <section
            className="mb-6 p-3 border rounded glass-card gradient-card shadow-medium"
            style={{ background: 'var(--panel-processos)', borderColor: 'var(--border)' }}
          >
            <h2 className="font-semibold mb-2">Coluna do Processo</h2>
            <div className="flex flex-wrap gap-2 mb-3">
              {kanbanCols.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    setSelectedColuna(c);
                    const etapa = colToEtapa[c];
                    if (etapa) setProc((s) => ({ ...s, etapa, sub_etapa: '' }));
                  }}
                  className={`px-3 py-1 rounded border ${
                    selectedColuna === c ? 'bg-[var(--accent)] text-[var(--fg)]' : 'border-[var(--panel-border)]'
                  }`}
                >
                  {c.toUpperCase()}
                </button>
              ))}
            </div>
            <p className="text-xs opacity-70">
              Ao escolher a coluna, a Etapa do processo será preenchida automaticamente (você pode ajustar abaixo).
            </p>
          </section>

          {msg && (
            <div
              className="mb-4 p-3 border rounded text-sm gradient-card shadow-soft"
              style={{ background: 'var(--panel-processos)', color: 'var(--fg)', borderColor: 'var(--border)' }}
            >
              {msg}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end mb-6">
            <div>
              <label className="block text-sm mb-1">ID do Processo</label>
              <input
                className="w-full input-themed"
                value={processoId}
                onChange={(e) => setProcessoId(e.target.value)}
                placeholder="ex.: 123"
                disabled={criarNovo}
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                id="novo"
                type="checkbox"
                checked={criarNovo}
                onChange={(e) => setcriarNovo(e.target.checked)}
              />
              <label htmlFor="novo">Criar novo processo</label>
            </div>
            <button
              className="px-3 py-2 bg-blue-600 text-white rounded"
              onClick={loadById}
              disabled={
                criarNovo || (!String(processoId || '').trim() && !String((ucBusca || req?.uc || '')).trim())
              }
            >
              Carregar
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end mb-6">
            <div>
              <label className="block text-sm mb-1">UC</label>
              <input
                className="w-full input-themed"
                value={ucBusca}
                onChange={(e) => setUcBusca(e.target.value)}
                placeholder="ex.: 1234567"
              />
            </div>
          </div>

          <section className="mb-6 p-4 border rounded">
            <h2 className="font-semibold mb-3">Requisição</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {renderInput('UC', req.uc, (v) => setReq((s) => ({ ...s, uc: v })))}
              {renderInput('Cliente', req.cliente, (v) => setReq((s) => ({ ...s, cliente: v })))}
              {renderInput('Concessionária', req.concessionaria, (v) =>
                setReq((s) => ({ ...s, concessionaria: v })),
              )}
              {renderInput('CNPJ', req.cnpj, (v) => setReq((s) => ({ ...s, cnpj: v })))}
              {renderInput('Razão Social Fatura', req.razao_social_fatura, (v) =>
                setReq((s) => ({ ...s, razao_social_fatura: v })),
              )}
              {renderInput('Endereço Completo', req.endereco_completo, (v) =>
                setReq((s) => ({ ...s, endereco_completo: v })),
              )}
              {renderInput('Ressarcimento Estimado', req.ressarcimento_estimado, (v) =>
                setReq((s) => ({ ...s, ressarcimento_estimado: v })),
              )}
              {renderInput('Link Fatura', req.link_fatura, (v) =>
                setReq((s) => ({ ...s, link_fatura: v })),
              )}
              {renderInput(
                'Data Criação (dd/mm/aaaa HH:mm:ss)',
                req.data_criacao_requisicao,
                (v) => setReq((s) => ({ ...s, data_criacao_requisicao: v })),
              )}
            </div>
          </section>

          <section className="mb-6 p-4 border rounded">
            <h2 className="font-semibold mb-3">Processo</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm mb-1">Coluna Kanban (atual)</label>
                <input
                  className="w-full input-themed bg-[var(--panel)]"
                  value={selectedColuna || ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSelectedColuna(v);
                    const etapa = colToEtapa[v] || etapaToColuna(v);
                    if (etapa) setProc((s) => ({ ...s, etapa, sub_etapa: '' }));
                  }}
                  list="dl-colunas"
                  placeholder="Ex.: Ativos, Deferidos..."
                />
              </div>
              <div>
                <label className="block text-sm mb-1">Etapa</label>
                <input
                  list="dl-etapas"
                  className="w-full input-themed"
                  value={proc.etapa || ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    setProc((s) => ({ ...s, etapa: v, sub_etapa: '' }));
                    setTimeout(() => {
                      try {
                        subProcRef.current?.focus();
                      } catch {
                        /* ignore */
                      }
                    }, 0);
                  }}
                />
              </div>
              <div>
                <label className="block text-sm mb-1">Sub-etapa</label>
                <input
                  ref={subProcRef}
                  list="dl-sub-proc"
                  className="w-full input-themed"
                  value={proc.sub_etapa || ''}
                  onChange={(e) => setProc((s) => ({ ...s, sub_etapa: e.target.value }))}
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="rel"
                  type="checkbox"
                  checked={!!proc.relevancia}
                  onChange={(e) => setProc((s) => ({ ...s, relevancia: e.target.checked }))}
                />
                <label htmlFor="rel">Relevância</label>
              </div>
              {renderInput('Data Alerta (dd/mm/aaaa)', proc.data_alerta, (v) =>
                setProc((s) => ({ ...s, data_alerta: v })),
              )}
              {renderInput('Última Atualização (dd/mm/aaaa HH:mm:ss)', proc.ultima_atualizacao, (v) =>
                setProc((s) => ({ ...s, ultima_atualizacao: v })),
              )}
            </div>
          </section>

          <section className="mb-6 p-4 border rounded">
            <h2 className="font-semibold mb-3">Deferidos</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {renderInput(
                'Data Procedência (dd/mm/aaaa)',
                deferimento.data_procedencia,
                (v) => setDeferimento((s) => ({ ...s, data_procedencia: v })),
              )}
              {renderInput(
                'Crédito Simples',
                deferimento.credito_simples,
                (v) => setDeferimento((s) => ({ ...s, credito_simples: v })),
              )}
              {renderInput(
                'Crédito Dobro',
                deferimento.credito_dobro,
                (v) => setDeferimento((s) => ({ ...s, credito_dobro: v })),
              )}
              {renderInput(
                'Data Deferimento Dobro (dd/mm/aaaa)',
                deferimento.data_credito_dobro,
                (v) => setDeferimento((s) => ({ ...s, data_credito_dobro: v })),
              )}
            </div>
          </section>

          <section className="mb-6 p-4 border rounded">
            <h2 className="font-semibold mb-3">Fluxo de Ressarcimento</h2>
            <button className="mb-2 px-2 py-1 bg-slate-600 text-white rounded" onClick={addFluxo}>
              Adicionar item
            </button>
            {fluxo.map((it, idx) => (
              <div key={idx} className="grid grid-cols-1 md:grid-cols-5 gap-2 mb-2">
                <div>
                  <label className="block text-xs mb-1">Forma</label>
                  <select
                    value={it.forma_devolucao}
                    onChange={(e) => updateAt(setFluxo, idx, { ...it, forma_devolucao: e.target.value })}
                    className="input-themed text-xs"
                  >
                    <option>Fatura</option>
                    <option>GD</option>
                    <option>Deposito</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs mb-1">Valor</label>
                  <input
                    className="input-themed text-xs"
                    value={it.valor}
                    onChange={(e) => updateAt(setFluxo, idx, { ...it, valor: e.target.value })}
                    placeholder="Valor"
                  />
                </div>

                <div>
                  <label className="block text-xs mb-1">Data Devolução</label>
                  <input
                    className="input-themed text-xs"
                    value={it.data_devolucao || ''}
                    onChange={(e) => updateAt(setFluxo, idx, { ...it, data_devolucao: e.target.value })}
                    placeholder="dd/mm/aaaa"
                  />
                </div>

                <div>
                  <label className="block text-xs mb-1">Data Envio Financeiro</label>
                  <input
                    className="input-themed text-xs"
                    value={it.data_envio_financeiro || ''}
                    onChange={(e) =>
                      updateAt(setFluxo, idx, { ...it, data_envio_financeiro: e.target.value })
                    }
                    placeholder="dd/mm/aaaa"
                  />
                </div>

                <div className="flex items-end">
                  <button className="btn-outline text-xs" onClick={() => removeAt(setFluxo, idx)}>
                    Remover
                  </button>
                </div>
              </div>
            ))}
          </section>

          <section className="mb-6 p-4 border rounded">
            <h2 className="font-semibold mb-3">Faturamento</h2>
            <button className="mb-2 px-2 py-1 bg-slate-600 text-white rounded" onClick={addFat}>
              Adicionar item
            </button>
            {fat.map((it, idx) => (
              <div key={idx} className="grid grid-cols-1 md:grid-cols-8 gap-2 mb-2">
                <div>
                  <label className="block text-xs mb-1">Nº da NF</label>
                  <input
                    className="input-themed text-xs"
                    value={it.numero_nf}
                    onChange={(e) => updateAt(setFat, idx, { ...it, numero_nf: e.target.value })}
                    placeholder="Nº da NF"
                  />
                </div>

                <div>
                  <label className="block text-xs mb-1">Data de Emissão</label>
                  <input
                    className="input-themed text-xs"
                    value={it.data_emissao || ''}
                    onChange={(e) => updateAt(setFat, idx, { ...it, data_emissao: e.target.value })}
                    placeholder="dd/mm/aaaa"
                  />
                </div>

                <div>
                  <label className="block text-xs mb-1">Data de Vencimento</label>
                  <input
                    className="input-themed text-xs"
                    value={it.data_vencimento || ''}
                    onChange={(e) => updateAt(setFat, idx, { ...it, data_vencimento: e.target.value })}
                    placeholder="dd/mm/aaaa"
                  />
                </div>

                <div>
                  <label className="block text-xs mb-1">Data de Pagamento</label>
                  <input
                    className="input-themed text-xs"
                    value={it.data_pagamento || ''}
                    onChange={(e) => updateAt(setFat, idx, { ...it, data_pagamento: e.target.value })}
                    placeholder="dd/mm/aaaa"
                  />
                </div>

                <div>
                  <label className="block text-xs mb-1">Valor</label>
                  <input
                    className="input-themed text-xs"
                    value={it.valor}
                    onChange={(e) => updateAt(setFat, idx, { ...it, valor: e.target.value })}
                    placeholder="Valor"
                  />
                </div>

                <div>
                  <label className="block text-xs mb-1">Documento</label>
                  <input
                    type="file"
                    className="w-full text-sm"
                    onChange={(e) => {
                      const file = e.target.files && e.target.files[0];
                      updateAt(setFat, idx, { ...it, anexo_nome: file ? file.name : '' });
                    }}
                  />
                  <input
                    className="mt-1 input-themed text-xs"
                    value={it.anexo_nome || ''}
                    onChange={(e) => updateAt(setFat, idx, { ...it, anexo_nome: e.target.value })}
                    placeholder="Nome do documento"
                  />
                </div>

                <div className="flex items-end">
                  <button className="btn-outline text-xs" onClick={() => removeAt(setFat, idx)}>
                    Remover
                  </button>
                </div>
              </div>
            ))}
          </section>

          <section className="mb-6 p-4 border rounded">
            <h2 className="font-semibold mb-3">Histórico (manual)</h2>
            <button className="mb-2 px-2 py-1 bg-slate-600 text-white rounded" onClick={addHist}>
              Adicionar linha
            </button>
            {hist.map((it, idx) => (
              <div key={idx} className="grid grid-cols-1 md:grid-cols-6 gap-2 mb-2">
                <input
                  className="input-themed text-xs"
                  value={it.data || ''}
                  onChange={(e) => updateAt(setHist, idx, { ...it, data: e.target.value })}
                  placeholder="dd/mm/aaaa HH:mm:ss"
                />

                <input
                  className="input-themed text-xs"
                  value={it.comentario || ''}
                  onChange={(e) => updateAt(setHist, idx, { ...it, comentario: e.target.value })}
                  placeholder="comentário"
                />

                <input
                  list="dl-etapas"
                  className="input-themed text-xs"
                  value={it.etapa_anterior || ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    updateAt(setHist, idx, { ...it, etapa_anterior: v, sub_etapa: '' });
                    setTimeout(() => {
                      try {
                        subHistRefs.current[idx]?.focus();
                      } catch {
                        /* ignore */
                      }
                    }, 0);
                  }}
                  placeholder="Etapa anterior"
                />

                <input
                  list="dl-etapas"
                  className="input-themed text-xs"
                  value={it.etapa_nova || ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    updateAt(setHist, idx, { ...it, etapa_nova: v, sub_etapa: '' });
                    setTimeout(() => {
                      try {
                        subHistRefs.current[idx]?.focus();
                      } catch {
                        /* ignore */
                      }
                    }, 0);
                  }}
                  placeholder="Etapa nova"
                />

                <input
                  ref={(el) => (subHistRefs.current[idx] = el)}
                  list={`dl-sub-h-${idx}`}
                  className="input-themed text-xs"
                  value={it.sub_etapa || ''}
                  onChange={(e) => updateAt(setHist, idx, { ...it, sub_etapa: e.target.value })}
                  placeholder="Sub-etapa"
                />

                <div className="flex items-center gap-2">
                  <label className="text-xs">Rel. ant.</label>
                  <input
                    type="checkbox"
                    checked={!!it.relevancia_anterior}
                    onChange={(e) =>
                      updateAt(setHist, idx, { ...it, relevancia_anterior: e.target.checked })
                    }
                  />
                  <label className="text-xs">Rel. nova</label>
                  <input
                    type="checkbox"
                    checked={!!it.relevancia_nova}
                    onChange={(e) =>
                      updateAt(setHist, idx, { ...it, relevancia_nova: e.target.checked })
                    }
                  />
                  <button
                    className="ml-2 btn-outline text-xs"
                    onClick={() => removeHist(setHist, idx, it, setHistDeletes)}
                  >
                    Remover
                  </button>
                </div>
              </div>
            ))}
          </section>

          {/* Datalists */}
          <datalist id="dl-etapas">
            {etapasOpts.map((n, i) => (
              <option key={i} value={n} />
            ))}
          </datalist>
          <datalist id="dl-colunas">
            {kanbanCols.map((n, i) => (
              <option key={i} value={n} />
            ))}
          </datalist>
          <datalist id="dl-sub-proc">
            {filteredSubFor(proc.etapa).map((n, i) => (
              <option key={i} value={n} />
            ))}
          </datalist>
          {hist.map((it, idx) => (
            <datalist key={idx} id={`dl-sub-h-${idx}`}>
              {filteredSubFor(it.etapa_nova || it.etapa_anterior).map((n, i) => (
                <option key={i} value={n} />
              ))}
            </datalist>
          ))}

          {toast.open && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
              <div className="w-full max-w-md sap-card text-[var(--fg)] p-5">
                <h3 className="text-lg font-semibold mb-2">
                  {toast.type === 'error' ? 'Aviso' : toast.type === 'success' ? 'Sucesso' : 'Mensagem'}
                </h3>
                <p className="mb-4 text-sm">{toast.text}</p>
                <div className="text-right">
                  <button
                    className="btn-outline"
                    onClick={() => setToast((t) => ({ ...t, open: false }))}
                  >
                    Ok
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Modal Bulk por UC */}
      {bulkOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-4xl sap-card text-[var(--fg)] p-5">
            <div className="flex items-center justify-between mb-3 pb-3 border-b panel-border">
              <h2 className="text-lg font-semibold">Bulk por UC</h2>
              <button onClick={() => setBulkOpen(false)} className="btn-outline">
                Fechar
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="sap-label mb-2">UCs (uma por linha ou separadas por vírgula)</label>
                <textarea
                  className="w-full h-32 input-themed"
                  value={bulkInput}
                  onChange={(e) => setBulkInput(e.target.value)}
                  placeholder="Ex.: 14105119, 13105155, 14643001"
                />
                <div className="mt-2 flex gap-2">
                  <button
                    className="btn-themed"
                    onClick={async () => {
                      try {
                        setBulkLoading(true);
                        const raw = String(bulkInput || '');
                        const parts = raw
                          .split(/[\s,;\n\r]+/)
                          .map((s) => s.trim())
                          .filter(Boolean);
                        const uniq = Array.from(new Set(parts));
                        if (uniq.length === 0) {
                          setBulkResolvido([]);
                          setBulkLoading(false);
                          return;
                        }
                        const data = await getProcessosKanbanFast();
                        const colunas = data?.colunas || {};
                        const resolver = (uc) => {
                          const ids = [];
                          for (const arr of Object.values(colunas)) {
                            (arr || []).forEach((it) => {
                              const u = String(it?.uc || '').trim();
                              if (u && u.toLowerCase() === String(uc).toLowerCase()) ids.push(Number(it.id));
                            });
                          }
                          if (ids.length === 0)
                            return { uc, ids: [], selectedId: null, status: 'miss', msg: 'UC não encontrada' };
                          if (ids.length === 1) return { uc, ids, selectedId: ids[0], status: 'ok' };
                          return { uc, ids, selectedId: null, status: 'dup', msg: 'UC duplicada: selecione o ID' };
                        };
                        const resolved = uniq.map(resolver);
                        setBulkResolvido(resolved);
                        const allOk = resolved.every((r) => r.status === 'ok');
                        if (allOk)
                          setToast({
                            open: true,
                            type: 'success',
                            text: 'Todas as UCs foram encontradas e estão prontas.',
                          });
                      } catch (e) {
                        setToast({
                          open: true,
                          type: 'error',
                          text: e?.message || 'Falha ao resolver UCs',
                        });
                      } finally {
                        setBulkLoading(false);
                      }
                    }}
                    disabled={bulkLoading}
                  >
                    {bulkLoading ? 'Buscando...' : 'Buscar'}
                  </button>
                  <button
                    className="btn-outline"
                    onClick={() => {
                      setBulkResolvido([]);
                      setBulkCSimples('');
                      setBulkDSimples('');
                      setBulkCDobro('');
                      setBulkDDobro('');
                    }}
                  >
                    Limpar
                  </button>
                </div>
              </div>

              <div>
                <label className="sap-label mb-2">Etapa destino</label>
                <select
                  className="w-full input-themed"
                  value={bulkEtapa}
                  onChange={(e) => setBulkEtapa(e.target.value)}
                >
                  <option value="">Selecione...</option>
                  {kanbanCols.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-3">
                  <div>
                    <label className="sap-label mb-2">Crédito Simples (número ou CSV)</label>
                    <input
                      className="w-full input-themed"
                      value={bulkCSimples}
                      onChange={(e) => setBulkCSimples(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="sap-label mb-2">Data Simples (dd/mm/aaaa ou CSV)</label>
                    <input
                      className="w-full input-themed"
                      value={bulkDSimples}
                      onChange={(e) => setBulkDSimples(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="sap-label mb-2">Crédito Dobro (número ou CSV)</label>
                    <input
                      className="w-full input-themed"
                      value={bulkCDobro}
                      onChange={(e) => setBulkCDobro(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="sap-label mb-2">Data Dobro (dd/mm/aaaa ou CSV)</label>
                    <input
                      className="w-full input-themed"
                      value={bulkDDobro}
                      onChange={(e) => setBulkDDobro(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Resultado de resolução */}
            <div className="mt-4">
              {bulkResolvido.length > 0 && (
                <div className="max-h-64 overflow-auto border rounded p-2">
                  {bulkResolvido.map((r, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-2 py-1 border-b border-[var(--panel-border)]/40 last:border-0"
                    >
                      <div className="w-36 text-sm">{r.uc}</div>
                      <div className="flex-1 text-sm">
                        {r.status === 'ok' && <span className="text-green-600">ID: {r.selectedId}</span>}
                        {r.status === 'miss' && <span className="text-red-600">{r.msg}</span>}
                        {r.status === 'dup' && (
                          <div className="flex items-center gap-2">
                            <span className="text-amber-600">{r.msg}</span>
                            <select
                              className="input-themed text-xs p-1"
                                value={r.selectedId || ''}
                                onChange={(e) => {
                                  const v = e.target.value ? Number(e.target.value) : null;
                                  setBulkResolvido((prev) =>
                                    prev.map((x, i) =>
                                      i === idx ? { ...x, selectedId: v, status: v ? 'ok' : 'dup' } : x,
                                    ),
                                  );
                                }}
                            >
                              <option value="">Selecione...</option>
                              {r.ids.map((id) => (
                                <option key={id} value={id}>
                                  {id}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Aplicar */}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button className="btn-outline" onClick={() => setBulkOpen(false)} disabled={bulkApplying}>
                Cancelar
              </button>
              <button
                className="px-3 py-2 bg-green-600 text-white rounded"
                disabled={bulkApplying || bulkResolvido.length === 0}
                onClick={async () => {
                  try {
                    const nums = (s) =>
                      s.includes(',')
                        ? s
                            .split(',')
                            .map((v) => v.trim())
                            .filter(Boolean)
                        : s.trim()
                        ? [s.trim()]
                        : [];

                    const arrCS = nums(bulkCSimples);
                    const arrDS = nums(bulkDSimples);
                    const arrCD = nums(bulkCDobro);
                    const arrDD = nums(bulkDDobro);

                    const validos = bulkResolvido.filter((r) => r.status === 'ok' && r.selectedId);
                    if (validos.length === 0) {
                      setToast({ open: true, type: 'error', text: 'Nenhuma UC resolvida para aplicar.' });
                      return;
                    }
                    if (!(await confirmAction('Deseja aplicar essas alterações para todos os processos selecionados?'))) {
                      return;
                    }

                    setBulkApplying(true);
                    let ok = 0;
                    let fail = 0;
                    const errors = [];

                    for (let i = 0; i < validos.length; i++) {
                      const r = validos[i];
                      const etapaDestino = colToEtapa[bulkEtapa] || String(bulkEtapa || '').trim() || 'Ativos';
                      const payload = {
                        processo_id: r.selectedId,
                        coluna: bulkEtapa || null,
                        etapa: etapaDestino,
                        sub_etapa: '',
                        relevancia: false,
                      };

                      // Deferimento opcional por Índice/Único
                      const cs = arrCS[i] ?? arrCS[0];
                      const ds = arrDS[i] ?? arrDS[0];
                      const cd = arrCD[i] ?? arrCD[0];
                      const dd = arrDD[i] ?? arrDD[0];
                      const hasDef = (cs && cs !== '') || (ds && ds !== '') || (cd && cd !== '') || (dd && dd !== '');

                      if (hasDef) {
                        const defObj = {};
                        if (ds) defObj.data_procedencia = ds;
                        if (cs) {
                          const normalized = normalizeCreditoValue(cs);
                          if (normalized) defObj.credito_simples = toNumberBR(normalized);
                        }
                        if (cd) {
                          const normalized = normalizeCreditoValue(cd);
                          if (normalized) defObj.credito_dobro = toNumberBR(normalized);
                        }
                        if (dd) defObj.data_credito_dobro = dd;
                        payload.deferimento = defObj;
                      }

                      try {
                        const res = await saveProcessoFull(payload);
                        if (res?.ok) ok++;
                        else {
                          fail++;
                          errors.push(`${r.uc} (ID ${r.selectedId})`);
                        }
                      } catch {
                        fail++;
                        errors.push(`${r.uc} (ID ${r.selectedId})`);
                      }
                    }

                    const msg =
                      fail === 0
                        ? `Aplicado com sucesso em ${ok} UCs.`
                        : `Sucesso: ${ok}. Falhas: ${fail} ??' ${errors.join(', ')}`;
                    setToast({ open: true, type: fail ? 'error' : 'success', text: msg });
                  } finally {
                    setBulkApplying(false);
                  }
                }}
              >
                {bulkApplying ? 'Aplicando...' : 'Aplicar a todos'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function renderInput(label, value, onChange) {
  return (
    <div>
      <label className="block text-sm mb-1">{label}</label>
      <input
        className="w-full input-themed"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function emptyToNull(v) {
  return v === '' ? null : v;
}

function normalizeBoolOrNull(v) {
  if (v === undefined || v === null) return null;
  return !!v;
}

function updateAt(setter, idx, obj) {
  setter((prev) => prev.map((x, i) => (i === idx ? obj : x)));
}

function removeAt(setter, idx) {
  setter((prev) => prev.filter((_, i) => i !== idx));
}

function removeHist(setter, idx, it, setDeletes) {
  setter((prev) => prev.filter((_, i) => i !== idx));
  if (it && it.id_historico) {
    setDeletes((prev) =>
      prev.includes(it.id_historico) ? prev : [...prev, it.id_historico],
    );
  }
}

function parseBoolLoose(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).toLowerCase();
  if (['1', 'true', 't', 'sim', 'yes', 'y'].includes(s)) return true;
  if (['0', 'false', 'f', 'nao', 'não', 'no', 'n'].includes(s)) return false;
  return null;
}




