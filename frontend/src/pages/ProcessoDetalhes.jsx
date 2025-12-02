import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

  // Menções removidas: mencione usuários via comentário padrão
import { useProcessoSSE } from '../hooks/useProcessoSSE';
import {
  ArrowLeft,
  ArrowRightCircle,
  CheckCircle,
  PlusCircle,
  MinusCircle,
  Star,
  Tag,
  RefreshCw,
  Save,
  DollarSign,
  FileText,
  Paperclip,
  Clock,
  BellPlus,
  Phone,
  Mail,
  MessageSquare,
  Trash2,
  AlertTriangle,
  Globe,
  User,
} from 'lucide-react';
import { criarAlertaProcesso } from '../services/requisicaoService';
import api from '../services/api';

const kanbanSteps = [
  { id: 1, label: 'ATIVOS' },
  { id: 2, label: 'DEFERIDOS' },
  { id: 3, label: 'FLUXO DE RESSARCIMENTO' },
  { id: 4, label: 'FATURAMENTO' },
  { id: 5, label: 'CONCLUÍDOS' },
  { id: 6, label: 'INDEFERIDOS' },
];

const asDateInput = (val) => {
  if (!val) return '';
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(val))) return String(val);
    const d = new Date(val);
    return isNaN(d) ? '' : d.toISOString().slice(0, 10);
  } catch {
    return '';
  }
};

const ProcessoDetalhes = () => {
  const { id } = useParams();
  const navigate = useNavigate();

  // Estado base
  const [processo, setProcesso] = useState({
    id,
    numero_processo: `PROC-${id}`,
    etapa: 'Distribuidora',
    sub_etapa: 'Em elaboração',
    data_alerta: '',
    relevancia: false,
    descricao: 'Processo de ressarcimento em análise',
    status: 'Ativo',
    // 1=Ativos, 2=Deferidos, 3=Fluxo, 4=Faturamento, 5=Concluídos, 6=Indeferidos
    coluna_kanban: 1,

    // suspensão
    suspenso: false,
    suspenso_motivo: '',
    suspenso_ate: '',
  });

  const [etapa, setEtapa] = useState('Distribuidora');
  const [subEtapa, setSubEtapa] = useState('Em elaboração');
  const [dataAlerta, setDataAlerta] = useState('');
  const [relevancia, setRelevancia] = useState(false);
  const [comentario, setComentario] = useState('');
  const [showFaturas, setShowFaturas] = useState(false);
  const [faturas, setFaturas] = useState([]);
  const [anexos, setAnexos] = useState([]);
  // Estados de menções removidos
  const [novaMensagemAlerta, setNovaMensagemAlerta] = useState('');

  // Deferimento
  const [dataDeferimento, setDataDeferimento] = useState('');
  const [creditoSimples, setCreditoSimples] = useState('');
  const [habilitarCreditoDobro, setHabilitarCreditoDobro] = useState(false);
  const [creditoDobro, setCreditoDobro] = useState('');
  const [dataCreditoDobro, setDataCreditoDobro] = useState('');

  // Fluxo/Faturamento
  const [fluxoRessarcimento, setFluxoRessarcimento] = useState([
    { id: 1, formasDevolucao: [], valor: '', data: '' },
  ]);
  const [faturamento, setFaturamento] = useState([
    {
      id: 1,
      numeroNF: '',
      dataEmissao: '',
      dataVencimento: '',
      dataPagamento: '',
      valor: '',
      anexoNF: null,
    },
  ]);

  // Concluído
  const [modulosAprovados, setModulosAprovados] = useState({
    ativos: false,
    deferidos: false,
    fluxoRessarcimento: false,
    faturamento: false,
  });

  const [loading, setLoading] = useState(false);
  const [valorEstimado, setValorEstimado] = useState('');
  const [canaisSelecionados, setCanaisSelecionados] = useState({
    whatsapp: false,
    ligacao: false,
    email: false,
    sms: false,
    site: false,
    pessoal: false,
  });
  const [titleVisible, setTitleVisible] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [historico, setHistorico] = useState([]);
  const [loadingHistorico, setLoadingHistorico] = useState(false);
  const comentarioRef = useRef(null);

  // Suspensão (toggle)
  const [suspenso, setSuspenso] = useState(false);
  const [suspensoMotivo, setSuspensoMotivo] = useState('');
  const [suspensoAte, setSuspensoAte] = useState('');
  const [savingSuspenso, setSavingSuspenso] = useState(false);

  // auto-save com debounce p/ Valor Estimado
  const debounceRef = useRef(null);
  const lastSavedRef = useRef(null);

  const salvarValorEstimadoReal = useCallback(
    async (valor) => {
      if (processo.coluna_kanban !== 1) return; // só salva em "Ativos"
      const v = String(valor ?? '');
      if (v === lastSavedRef.current) return; // evita POST duplicado
      try {
        const { movimentarProcesso } = await import('../services/requisicaoService');
        const fd = new FormData();
        fd.append('valor_estimado', v);
        await movimentarProcesso(id, fd);
        lastSavedRef.current = v; // marcado como salvo
      } catch {
        // silencioso
      }
    },
    [id, processo.coluna_kanban],
  );

  const salvarValorEstimadoDebounced = useCallback(
    (valor) => {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => salvarValorEstimadoReal(valor), 450);
    },
    [salvarValorEstimadoReal],
  );

  // cleanup do timer
  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current);
    };
  }, []);

  /* ===================== Utils ===================== */
  const extrairTextoSeguro = (valor) => {
    if (!valor) return '';
    if (typeof valor === 'string') return valor;
    if (typeof valor === 'object' && valor.String !== undefined) return valor.String || '';
    if (typeof valor === 'object' && valor.Value !== undefined) return valor.Value || '';
    try {
      return String(valor);
    } catch {
      return '';
    }
  };

  // Deriva etapa e subetapa de diferentes formatos do backend
  const deriveEtapaSubEtapa = (h) => {
    let etapaName = extrairTextoSeguro(
      h?.etapa_destino || h?.etapa_nova || h?.etapa || h?.coluna,
    );
    let subName = extrairTextoSeguro(
      h?.sub_etapa || h?.subEtapa || h?.subetapa || h?.sub,
    );
    // Se vier status_composto ("Etapa - Subetapa"), tenta decompor quando faltarem campos
    if ((!etapaName || !subName) && h?.status_composto) {
      const parts = String(h.status_composto)
        .split('-')
        .map((p) => p.trim());
      if (!etapaName && parts.length) etapaName = parts[0];
      if (!subName && parts.length > 1) subName = parts.slice(1).join(' - ');
    }
    return { etapaName, subName };
  };

  const getEtapasDisponiveis = () => [
    // Coluna 1: Ativos
    { id: 1, nome: 'Distribuidora', descricao: 'Processo em tratativa com a Distribuidora.', coluna: 1 },
    { id: 2, nome: 'Ouvidoria', descricao: 'Processo escalado para a Ouvidoria.', coluna: 1 },
    { id: 3, nome: 'ANEEL', descricao: 'Processo escalado para a ANEEL.', coluna: 1 },
    { id: 4, nome: 'SMA', descricao: 'Processo em análise no SMA.', coluna: 1 },

    // Coluna 2: Deferidos
    { id: 5, nome: 'Pendente', descricao: 'Deferido, aguardando início da conciliação.', coluna: 2 },
    { id: 6, nome: 'Em conciliação', descricao: 'Valores do deferimento sendo conciliados.', coluna: 2 },
    { id: 7, nome: 'Em Contestação', descricao: 'Valores do deferimento em contestação.', coluna: 2 },

    // Coluna 3: Fluxo de Ressarcimento
    { id: 8, nome: 'Enviado ao Financeiro', descricao: 'Processo a caminho do setor financeiro.', coluna: 3 },

    // Coluna 4: Faturamento
    { id: 9, nome: 'Faturamento', descricao: 'Aguardando faturamento e pagamento.', coluna: 4 },

    // Coluna 5: Concluídos
    { id: 10, nome: 'Concluído', descricao: 'Processo finalizado e pago.', coluna: 5 },

    // Coluna 6: Indeferidos
    { id: 11, nome: 'Indeferido', descricao: 'Processo descartado ou rejeitado.', coluna: 6 },
  ];

  const getSubEtapasDisponiveis = () => [
    { id: 1, nome: 'Em elaboração' },
    { id: 2, nome: 'Aguardando retorno' },
    { id: 3, nome: 'Em Contestação' },
    // { id: 4, nome: 'Suspenso' },
  ];

  const isModuloAtivo = (modulo) => {
    switch (modulo) {
      case 'ativos':
        return processo.coluna_kanban >= 1;
      case 'deferidos':
        return processo.coluna_kanban >= 2;
      case 'fluxoRessarcimento':
        return processo.coluna_kanban >= 3;
      case 'faturamento':
        return processo.coluna_kanban >= 4;
      case 'Concluído':
        return processo.coluna_kanban >= 5;
      default:
        return false;
    }
  };

  // Resolver seguro de cores: normaliza acentos e compara com chaves ASCII
  const getEtapaColorSafe = (name) => {
    if (!name) return 'bg-success';
    try {
      let s = String(name)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
      s = s.replace(/\s+/g, ' ');
      const map = {
        'distribuidora': 'bg-[var(--accent)]',
        'ouvidoria': 'bg-purple-600',
        'aneel': 'bg-danger',
        'sma': 'bg-success',
        'pendente': 'bg-warning',
        'em conciliacao': 'bg-orange-600',
        'em contestacao': 'bg-danger',
    'Enviado ao Financeiro': 'bg-indigo-600',
        'faturamento': 'bg-teal-600',
        'concluido': 'bg-success',
        'indeferido': 'bg-danger',
      };
      if (s.includes('conciliacao')) s = 'em conciliacao';
      if (s.includes('contestacao')) s = 'em contestacao';
      if (s.includes('validacao')) s = 'enviado ao financeiro';
      if (s.startsWith('conclu')) s = 'concluido';
      return map[s] || 'bg-success';
    } catch {
      return 'bg-success';
    }
  };
  // Alias para compatibilidade com chamadas antigas
  const getEtapaColor = getEtapaColorSafe;

  /* ===================== Histórico ===================== */
  const getItemDate = (h) => {
    const raw = h?.data_movimentacao || h?.data || h?.created_at || h?.dt || '';
    const d = new Date(raw);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  };

  const carregarHistorico = useCallback(async () => {
    if (!id) return;
    setLoadingHistorico(true);
    try {
      let response = [];

      try {
        // 1ª opção: service dedicado
        const { getHistoricoById } = await import('../services/requisicaoService');
        response = await getHistoricoById(id);
      } catch (error) {
        console.warn('Serviço de histórico indisponível:', error);

        try {
          // 2ª opção: endpoint direto (fallback)
          const token = localStorage.getItem('userToken');
          const res = await fetch(`/api/v1/fluxo-ressarcimento/${id}`, {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          });
          if (res.ok) {
            const data = await res.json();
            response = data?.historico || data?.movimentacoes || [];
          }
        } catch (error2) {
          console.warn('Endpoint direto (fallback) falhou:', error2);
          // 3ª opção: mock mínimo
          response = [
            {
              etapa_destino: 'Distribuidora',
              sub_etapa: 'Em elaboração',
              comentario: 'Processo iniciado na distribuidora',
              usuario_nome: 'Sistema',
              data_movimentacao: new Date().toISOString(),
            },
          ];
        }
      }

      const lista = Array.isArray(response) ? response.slice() : [];
      lista.sort((a, b) => getItemDate(b) - getItemDate(a));
      setHistorico(lista);
    } catch (error) {
      console.error('Erro ao carregar histórico:', error);
      setHistorico([]);
    } finally {
      setLoadingHistorico(false);
    }
  }, [id]);

  /* ===================== Carregamento inicial ===================== */
  useEffect(() => {
    carregarHistorico();
  }, [id, carregarHistorico]);

  // Carrega detalhes do processo
  useEffect(() => {
    (async () => {
      if (!id) return;
      try {
        const { getProcessoById } = await import('../services/requisicaoService');
        const data = await getProcessoById(id);
        if (data && typeof data === 'object') {
          setProcesso((prev) => ({ ...prev, ...data }));

          const ve = extrairTextoSeguro(data.valor_estimado || data.valorEstimado || '');
          if (ve) setValorEstimado(ve);

          setSuspenso(!!(data.suspenso || data.Suspenso || data.__suspenso));
          if (data.relevancia !== undefined || data.__relevancia !== undefined) {
            setRelevancia(!!(data.relevancia || data.__relevancia));
          }
          setSuspensoMotivo(extrairTextoSeguro(data.suspenso_motivo || ''));
          setSuspensoAte(asDateInput(data.suspenso_ate || ''));
        }
      } catch {
        // silencioso
      }
    })();
  }, [id]);

  // Carrega deferimento / fluxo / faturamento do processo
  useEffect(() => {
    if (!id) return;
    (async () => {
      const token = localStorage.getItem('userToken') || localStorage.getItem('token');
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      try {
        const resDef = await fetch(`/api/v1/processos/${id}/deferimento`, { headers });
        if (resDef.ok) {
          const def = await resDef.json();
          if (def) {
            const unwrapDate = (v) => {
              if (!v) return '';
              if (typeof v === 'string') return v.slice(0, 10);
              if (typeof v === 'object') {
                if (v.Valid === false) return '';
                return (v.Time || v.time || v.value || '').slice(0, 10);
              }
              return String(v).slice(0, 10);
            };
            const unwrapNumber = (v) => {
              if (v === undefined || v === null) return '';
              if (typeof v === 'number') return v;
              if (typeof v === 'string') return v;
              if (typeof v === 'object') {
                if (v.Valid === false) return '';
                if (typeof v.Float64 === 'number') return v.Float64;
                if (typeof v.Float64 === 'string') return Number(v.Float64);
              }
              return '';
            };
            setDataDeferimento(unwrapDate(def.data_procedencia || def.DataProcedencia));
            setCreditoSimples(unwrapNumber(def.credito_simples ?? def.CreditoSimples));
            const cd = unwrapNumber(def.credito_dobro ?? def.CreditoDobro);
            setCreditoDobro(cd);
            setHabilitarCreditoDobro(cd !== '' && cd !== null);
            setDataCreditoDobro(unwrapDate(def.data_credito_dobro || def.DataCreditoDobro));
          }
        }
      } catch {}

      try {
        const resFluxo = await fetch(`/api/v1/fluxo-ressarcimento/${id}`, { headers });
        if (resFluxo.ok) {
          const data = await resFluxo.json();
          const arr = Array.isArray(data?.itens) ? data.itens : Array.isArray(data) ? data : [];
          setFluxoRessarcimento(
            arr.map((it, idx) => ({
              id: it.id || idx + 1,
              formasDevolucao: it.forma_devolucao ? [it.forma_devolucao] : [],
              valor: it.valor ?? '',
              data: asDateInput(it.data_devolucao || it.data_envio_financeiro || it.data),
            })),
          );
        }
      } catch {}

      try {
        const resFat = await fetch(`/api/v1/faturamento/${id}`, { headers });
        if (resFat.ok) {
          const data = await resFat.json();
          const arr = Array.isArray(data?.itens) ? data.itens : Array.isArray(data) ? data : [];
          setFaturamento(
            arr.map((it, idx) => ({
              id: it.id || idx + 1,
              numeroNF: it.numero_nf || it.numero || it.nf || '',
              dataEmissao: asDateInput(it.data_emissao || ''),
              dataVencimento: asDateInput(it.data_vencimento || ''),
              dataPagamento: asDateInput(it.data_pagamento || ''),
              valor: it.valor ?? '',
              anexoNF: null,
            })),
          );
        }
      } catch {}
    })();
  }, [id]);

  // Fonte primária: Requisição
  useEffect(() => {
    (async () => {
      if (!id) return;
      try {
        const { getRequisicaoById } = await import('../services/requisicaoService');
        const req = await getRequisicaoById(id);
        if (req && typeof req === 'object') {
          const uc = extrairTextoSeguro(req.uc || req.unidade_consumidora);
          const cliente = extrairTextoSeguro(req.cliente || req.nome_cliente);
          const conc = extrairTextoSeguro(
            req.concessionaria || req.concessionaria_sigla || req.concessionariaSigla,
          );
          const linkFat = extrairTextoSeguro(
            req.linkFatura || req.link_fatura || req.fatura_url,
          );
          const ve = extrairTextoSeguro(
            req.valor_estimado || req.valorEstimado || req.ressarcimentoEstimado,
          );
          setProcesso((prev) => ({
            ...prev,
            uc: uc || prev.uc,
            unidade_consumidora: uc || prev.unidade_consumidora,
            cliente: cliente || prev.cliente,
            nome_cliente: cliente || prev.nome_cliente,
            concessionaria: conc || prev.concessionaria,
            concessionaria_sigla: conc || prev.concessionaria_sigla,
            link_fatura: linkFat || prev.link_fatura,
          }));
          if (ve) setValorEstimado(ve);
          if (req.relevancia !== undefined || req.__relevancia !== undefined) {
            setRelevancia(!!(req.relevancia || req.__relevancia));
          }
        }
      } catch {
        // silencioso
      }
    })();
  }, [id]);

  // Fallback: buscar dados do Kanban Fast
  useEffect(() => {
    (async () => {
      if (!id) return;
      try {
        const { getProcessosKanbanFast } = await import('../services/requisicaoService');
        const data = await getProcessosKanbanFast();
        let itens = [];
        if (data?.colunas && typeof data.colunas === 'object') {
          for (const k of Object.keys(data.colunas)) {
            const arr = Array.isArray(data.colunas[k]) ? data.colunas[k] : [];
            itens = itens.concat(arr);
          }
        } else if (Array.isArray(data)) {
          itens = data;
        }
        const alvo = itens.find((x) => String(x?.id) === String(id));
        if (alvo) {
          setProcesso((prev) => ({
            ...prev,
            uc: alvo.uc ?? prev.uc,
            unidade_consumidora: alvo.uc ?? prev.unidade_consumidora,
            cliente: alvo.cliente ?? prev.cliente,
            nome_cliente: alvo.cliente ?? prev.nome_cliente,
            concessionaria_sigla: alvo.concessionaria_sigla ?? prev.concessionaria_sigla,
            concessionaria: alvo.concessionaria ?? prev.concessionaria,
          }));
          const ve = extrairTextoSeguro(
            alvo.valor_estimado || alvo.valorEstimado || valorEstimado || '',
          );
          if (ve) setValorEstimado(ve);
          if (alvo.suspenso !== undefined) setSuspenso(!!alvo.suspenso);
          if (alvo.relevancia !== undefined || alvo.__relevancia !== undefined) {
            setRelevancia(!!(alvo.relevancia || alvo.__relevancia));
          }
        }
      } catch {
        // silencioso
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Salva valor estimado quando sair do campo
  const salvarValorEstimado = async () => {
    await salvarValorEstimadoReal(valorEstimado);
  };

  // Abrir faturas recentes (Últimos 6 meses)
  const abrirFaturas = async () => {
    try {
      const numero = extrairTextoSeguro(processo.uc || processo.unidade_consumidora);
      if (!numero) {
        alert('UC não disponível para buscar faturas');
        return;
      }
      const toYM = (d) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const now = new Date();
      const meses = [];
      for (let i = 0; i < 6; i++) {
        const dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
        meses.push(toYM(dt));
      }
      const qs = meses.map((m) => `mes_ref=${encodeURIComponent(m)}`).join('&');
      const { default: apiModule } = await import('../services/api');
      const { data } = await apiModule.get(`/uc/${numero}/faturas?${qs}`);
      setFaturas(Array.isArray(data?.faturas) ? data.faturas : []);
      setShowFaturas(true);
    } catch (e) {
      console.error('Falha ao carregar faturas:', e);
      alert('Não foi possível carregar faturas agora.');
    }
  };

  // Revela o título após montar
  useEffect(() => {
    const t = setTimeout(() => setTitleVisible(true), 0);
    return () => clearTimeout(t);
  }, []);

  // SSE — atualiza subetapa/status ao vivo e recarrega Histórico
  const sseToken = (localStorage.getItem('userToken') || '').replace(
    /^Bearer\s+/i,
    '',
  );
  useProcessoSSE(id, sseToken, (payload) => {
    if (Object.prototype.hasOwnProperty.call(payload, 'sub_etapa')) {
      setSubEtapa(payload.sub_etapa || '');
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'suspenso')) {
      setSuspenso(!!payload.suspenso);
    }
    carregarHistorico();
  });

  // Colar imagem no comentário
  const handlePasteComentario = (e) => {
    const items = e.clipboardData?.items || [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const blob = items[i].getAsFile();
        const reader = new FileReader();
        reader.onload = (ev) => {
          const dataUrl = ev.target?.result || '';
          setComentario((prev) => `${prev}\n![imagem colada](${dataUrl})\n`);
        };
        reader.readAsDataURL(blob);
      }
    }
  };

  /* ===================== Toggle Suspenso ===================== */
  const toggleSuspenso = async () => {
    if (!id) return;
    setSavingSuspenso(true);
    try {
      const { suspenderProcesso, retomarProcesso } = await import(
        '../services/requisicaoService'
      );
      if (!suspenso) {
        await suspenderProcesso(id, suspensoMotivo || 'Suspenso via detalhes');
        setSuspenso(true);
      } else {
        await retomarProcesso(id, 'Retomado via detalhes');
        setSuspenso(false);
        setSuspensoMotivo('');
        setSuspensoAte('');
      }
    } catch (e) {
      alert(`Falha ao ${!suspenso ? 'suspender' : 'retomar'} o processo.`);
    } finally {
      setSavingSuspenso(false);
    }
  };

  /* ===================== Submit principal ===================== */
  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const { movimentarProcesso, salvarDataAlerta } = await import(
        '../services/requisicaoService'
      );
      const fd = new FormData();

      // Campos principais
      fd.append('etapa_atual', etapa);
      fd.append('sub_etapa', subEtapa);
      fd.append('relevancia', String(relevancia));

      // Suspensão
      fd.append('suspenso', String(suspenso));
      if (suspensoMotivo) fd.append('suspenso_motivo', suspensoMotivo);
      if (suspensoAte) fd.append('suspenso_ate', suspensoAte);

      const comentarioTrim = (comentario || '').trim();
      fd.append('comentario', comentarioTrim);

      // Anexos
      if (Array.isArray(anexos) && anexos.length > 0) {
        anexos.forEach((f) => fd.append('anexos', f));
      }

      // Menções específicas removidas; comentários concentram @mentions

      // Canais
      let canais = Object.entries(canaisSelecionados)
        .filter(([, v]) => v)
        .map(([k]) => k);
      if (comentarioTrim && canais.length === 0) {
        canais = ['email'];
      }
      if (canais.length > 0) {
        fd.append('canais', JSON.stringify(canais));
      }

      // Deferimento
      const toNumberBR = (v) => {
        const s = String(v ?? '')
          .trim()
          .replace(/\./g, '')
          .replace(',', '.');
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : 0;
      };

      const deferimento = {
        data_procedencia: dataDeferimento || '',
        credito_simples: toNumberBR(creditoSimples),
        credito_dobro: habilitarCreditoDobro ? toNumberBR(creditoDobro) : 0,
        data_credito_dobro:
          habilitarCreditoDobro && dataCreditoDobro ? dataCreditoDobro : '',
      };
      fd.append('deferimento', JSON.stringify(deferimento));

      // Valor estimado (só em Ativos)
      if (valorEstimado && processo.coluna_kanban === 1) {
        fd.append('valor_estimado', String(valorEstimado));
      }

      await movimentarProcesso(id, fd);
      if (dataAlerta) {
        await salvarDataAlerta(id, { data_alerta: dataAlerta });
      }

      alert('Alterações salvas com sucesso!');
      setComentario('');
      await carregarHistorico();
    } catch (error) {
      console.error('Erro ao salvar alterações:', error);
      alert('Falha ao salvar as alterações.');
    } finally {
      setIsSubmitting(false);
    }
  };

  /* ===================== Ações: indeferir / avançar ===================== */
  const indeferirProcesso = async () => {
    if (!(comentario || '').trim()) {
      alert(
        'Por favor, adicione um comentário no campo "Comentário da Movimentação" para justificar o indeferimento.',
      );
      comentarioRef.current?.focus?.();
      return;
    }
    if (
      !window.confirm(
        'Tem certeza que deseja indeferir este processo? Esta ação não pode ser desfeita.',
      )
    )
      return;
    setLoading(true);
    try {
      await api.post(`/processos/${id}/descartar`, {
        comentario: (comentario || '').trim(),
      });
      setProcesso((prev) => ({
        ...prev,
        etapa: 'Indeferido',
        sub_etapa: '',
        coluna_kanban: 6,
      }));
      setHistorico((prev) => [
        {
          etapa_destino: 'Indeferido',
          sub_etapa: '',
          comentario: (comentario || '').trim(),
          usuario_nome: 'Você',
          data_movimentacao: new Date().toISOString(),
        },
        ...prev,
      ]);
      setComentario('');
      await carregarHistorico();
    } catch (error) {
      console.error('Erro ao indeferir processo:', error);
      alert('Erro ao indeferir o processo.');
    } finally {
      setLoading(false);
    }
  };

  const validarModuloAtual = () => {
    const col = Number(processo?.coluna_kanban || 1);
    if (col === 1) return !!etapa;
    if (col === 2) {
      const cs = parseFloat(creditoSimples || '0') || 0;
      const cd = habilitarCreditoDobro
        ? parseFloat(creditoDobro || '0') || 0
        : 0;
      if (cs + cd <= 0) return false;
      if (cd > 0 && !dataCreditoDobro) return false;
      return true;
    }
    if (col === 3) {
      return (
        Array.isArray(fluxoRessarcimento) &&
        fluxoRessarcimento.length > 0
      );
    }
    if (col === 4) {
      return (
        Array.isArray(faturamento) &&
        faturamento.some(
          (it) =>
            (it.numeroNF && String(it.numeroNF).trim() !== '') ||
            (parseFloat(it.valor || '0') || 0) > 0,
        )
      );
    }
    return true;
  };

  const avancarEtapa = async () => {
    const col = Number(processo?.coluna_kanban || 1);
    const nextMap = { 1: 2, 2: 3, 3: 4, 4: 5 };
    const colNome = {
      1: 'Ativos',
      2: 'Deferidos',
      3: 'Fluxo de Ressarcimento',
      4: 'Faturamento',
      5: 'Concluídos',
    };
    const proxima = nextMap[col];
    if (!proxima) {
      alert(
        'O processo já está na etapa final ou não pode ser avançado.',
      );
      return;
    }
    if (!validarModuloAtual()) {
      alert(
        'Preencha os dados obrigatórios do módulo atual antes de avançar.',
      );
      return;
    }

    try {
      setLoading(true);
      const { movimentarProcesso } = await import(
        '../services/requisicaoService'
      );
      const fd = new FormData();

      const etapaDestino =
        getEtapasDisponiveis().find((e) => e.coluna === proxima)?.nome ||
        colNome[proxima];
      fd.append('etapa_atual', etapaDestino);

      const comentarioTrim = (comentario || '').trim();
      fd.append('comentario', comentarioTrim);

      let canais = Object.entries(canaisSelecionados)
        .filter(([, v]) => v)
        .map(([k]) => k);
      if (comentarioTrim && canais.length === 0) {
        canais = ['email'];
      }
      if (canais.length > 0) {
        fd.append('canais', JSON.stringify(canais));
      }

      const resp = await movimentarProcesso(id, fd);
      const colServidor =
        Number(resp?.data?.coluna_kanban_id) || proxima;

      setComentario('');
      alert(
        `Processo avançado com sucesso para ${colNome[proxima]}!`,
      );
      setProcesso((prev) => ({
        ...prev,
        coluna_kanban: colServidor,
      }));

      await carregarHistorico();
    } catch (e) {
      console.error('Erro ao avançar etapa:', e);
      alert(
        e?.response?.data?.error ||
          'Erro ao avançar a etapa do processo',
      );
    } finally {
      setLoading(false);
    }
  };

  const finalizarProcesso = async () => {
    const todosAprovados = Object.values(modulosAprovados).every(
      Boolean,
    );
    if (!todosAprovados) {
      alert(
        'Todos os módulos devem ser aprovados antes de finalizar o processo.',
      );
      return;
    }
    setLoading(true);
    try {
      // aqui você pode chamar o endpoint real de finalização, se existir
      await new Promise((r) => setTimeout(r, 800));
      alert('Processo finalizado com sucesso!');
      navigate('/processos');
    } catch {
      alert('Erro ao finalizar processo');
    } finally {
      setLoading(false);
    }
  };

  /* ===================== UI ===================== */
  return (
    <div className="min-h-screen bg-background text-foreground pt-6">
      {/* Header */}
      <div className="px-6 py-4 sticky top-0 z-10 shadow-elevated border-b-2" style={{ background:'var(--header-bg)', borderColor:'var(--header-border)', color:'var(--header-fg)' }}>
        <div className="relative flex items-center justify-center">
          {/* Voltar */}
          <div className="absolute left-0">
            <button
              onClick={() => navigate('/processos')}
              className="flex items-center gap-2 px-4 py-2 rounded-lg border panel-border panel-bg-60 hover:opacity-90 text-[var(--header-fg)] transition-smooth"
            >
              <ArrowLeft size={16} /> Voltar aos Processos
            </button>
          </div>

          {/* Título */}
          <h1
            className={
              'text-xl sm:text-2xl md:text-3xl font-bold text-[var(--fg)] text-center leading-tight transition-opacity duration-500 ' +
              (titleVisible ? 'opacity-100' : 'opacity-0')
            }
            style={{ textShadow: '0 1px 2px rgba(0,0,0,0.45)' }}
          >
            <span className="block sm:inline">Processo</span>
            <span className="block sm:inline">
              {' '}
              #{processo.numero_processo}
            </span>
          </h1>

          {/* Ações — direita */}
          <div className="absolute right-0 flex items-center gap-3 max-w-[48vw] flex-wrap justify-end">
            {/* Toggle Suspenso */}
            <div className="flex items-center gap-2">
              <span className="text-xs opacity-80">Suspenso</span>
              <button
                type="button"
                onClick={toggleSuspenso}
                disabled={savingSuspenso}
                className={[
                  'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                  suspenso
                    ? 'bg-amber-500'
                    : 'glass-card border border-[var(--border)]',
                ].join(' ')}
                title={
                  suspenso
                    ? 'Retomar processo'
                    : 'Suspender processo'
                }
              >
                <span
                  className={[
                    'inline-block h-5 w-5 transform rounded-full bg-white transition',
                    suspenso ? 'translate-x-5' : 'translate-x-1',
                  ].join(' ')}
                />
              </button>
            </div>

            {/* relevância */}
            <button
              onClick={async () => {
                const nova = !relevancia;
                setRelevancia(nova);
                try {
                  const { movimentarProcesso } = await import(
                    '../services/requisicaoService'
                  );
                  const fd = new FormData();
                  fd.append('relevancia', String(nova));
                  await movimentarProcesso(id, fd);
                } catch (e) {
                  setRelevancia(!nova);
                  alert(
                    'Não foi possível atualizar a relevância',
                  );
                }
              }}
              className={
                'p-2 rounded-lg transition-colors ' +
                (relevancia
                  ? 'bg-warning text-[var(--fg)] shadow-lg'
                  : 'glass-card opacity-70 hover:opacity-90 hover:text-warning')
              }
              title={
                relevancia
                  ? 'Remover relevância'
                  : 'Marcar como relevante'
              }
            >
              <Star
                size={16}
                fill={relevancia ? 'currentColor' : 'none'}
              />
            </button>

            {/* Alerta rápido */}
            <input
              type="text"
              value={novaMensagemAlerta}
              onChange={(e) =>
                setNovaMensagemAlerta(e.target.value)
              }
              placeholder="Mensagem rápida de alerta"
              className="px-2 py-2 rounded border border-[var(--border)] bg-[var(--card)] text-[var(--fg)] w-60"
            />
            <input
              type="date"
              value={asDateInput(dataAlerta)}
              onChange={(e) => setDataAlerta(e.target.value)}
              title="Data do alerta"
              className="px-2 py-2 rounded border border-[var(--border)] bg-[var(--card)] text-[var(--fg)]"
              style={{ minWidth: '10rem' }}
            />
            <button
              onClick={async () => {
                const msg = (novaMensagemAlerta || '').trim();
                if (!msg) {
                  alert('Digite a mensagem do alerta.');
                  return;
                }
                try {
                  await criarAlertaProcesso(id, msg);
                  const dt = (asDateInput(dataAlerta) || '').trim();
                  if (dt) {
                    await salvarDataAlerta(id, { data_alerta: dt });
                  }
                  setNovaMensagemAlerta('');
                  alert('Alerta criado.');
                } catch (e) {
                  alert('Erro ao criar alerta.');
                }
              }}
              className="px-3 py-2 rounded bg-[var(--accent)] hover:opacity-90 flex items-center gap-2"
              title="Criar alerta agora"
            >
              <BellPlus size={16} /> Criar Alerta
            </button>
          </div>
        </div>
      </div>

      {/* Timeline */}
      <div className="px-6 mb-3">
        <div className="glass-card rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
          <div className="grid grid-cols-6 gap-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-[var(--fg)]">
            {kanbanSteps.map((step) => (
              <span key={step.id} className="text-center">
                {step.label}
              </span>
            ))}
          </div>
          <div className="relative mt-3 h-6">
            <div className="absolute inset-y-0 left-0 right-0 flex items-center">
              <span className="h-px w-full bg-[var(--border)]" />
            </div>
            <div className="relative flex justify-between">
              {kanbanSteps.map((step) => {
                const current = Number(processo.coluna_kanban || 1);
                const isActive = step.id === current;
                const isDone = step.id < current;
                const circleClass = [
                  'relative inline-flex h-4 w-4 items-center justify-center rounded-full border-2 transition',
                  isActive
                    ? 'bg-[var(--accent)] border-[var(--accent)] shadow-[0_0_0_5px_rgba(59,130,246,0.25)]'
                    : isDone
                    ? 'bg-[var(--accent)] border-[var(--accent)]/80'
                    : 'bg-[var(--panel)] border-[var(--border)]',
                ].join(' ');
                return (
                  <span key={step.id} className="flex-1 flex justify-center">
                    <span className={circleClass} />
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Conteúdo */}
      <div className="flex gap-6 p-6">
        {/* Esquerda: Formulário + Módulos */}
        <div className="flex-1 space-y-6 relative">
          {/* Aviso de Suspensão */}
          {suspenso && (
            <div className="glass-card border border-amber-500/60 text-amber-200 rounded-lg p-3 flex items-center gap-2">
              <AlertTriangle
                size={16}
                className="shrink-0"
              />
              <div className="text-sm">
                Este processo está <strong>Suspenso</strong>.
                {suspensoAte && (
                  <>
                    {' '}
                    Retomar está marcado para{' '}
                    <strong>
                      {new Date(
                        suspensoAte,
                      ).toLocaleDateString('pt-BR')}
                    </strong>
                    .
                  </>
                )}
              </div>
            </div>
          )}

          {/* Bloco de informações rápidas */}
          <div className="glass-card rounded-lg p-4 border border-[var(--border)]">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-[11px] sm:text-xs text-[var(--fg)]">
              <div className="rounded px-2 py-1 border border-[var(--border)] bg-[var(--panel)]">
                <span className="opacity-70">UC: </span>
                <span>
                  {extrairTextoSeguro(
                    processo.uc?.String ||
                      processo.unidade_consumidora?.String ||
                      processo.uc ||
                      processo.unidade_consumidora,
                  ) || 'N/A'}
                </span>
              </div>
              <div className="rounded px-2 py-1 border border-[var(--border)] bg-[var(--panel)]">
                <span className="opacity-70">Cliente: </span>
                <span>
                  {extrairTextoSeguro(
                    processo.nome_cliente?.String ||
                      processo.cliente?.String ||
                      processo.nome_cliente ||
                      processo.cliente,
                  ) || 'N/A'}
                </span>
              </div>
              <div className="rounded px-2 py-1 border border-[var(--border)] bg-[var(--panel)]">
                <span className="opacity-70">
                  Concessionária:{' '}
                </span>
                <span>
                  {extrairTextoSeguro(
                    processo.concessionaria?.String ||
                      processo.concessionaria_sigla?.String ||
                      processo.concessionariaSigla?.String ||
                      processo.concessionaria ||
                      processo.concessionaria_sigla,
                  ) || 'N/A'}
                </span>
              </div>
              <div className="rounded px-2 py-1 border border-[var(--border)] bg-[var(--panel)] flex items-center gap-2">
                <span className="opacity-70">Faturas: </span>
                <button
                  type="button"
                  onClick={abrirFaturas}
                  className="px-2 py-0.5 rounded border border-[var(--border)] hover:text-[var(--accent)]"
                >
                  Abrir
                </button>
              </div>
              <div className="rounded px-2 py-1 border border-[var(--border)] bg-[var(--panel)]">
                <span className="opacity-70">Estado: </span>
                <span>
                  {suspenso
                    ? 'Suspenso'
                    : extrairTextoSeguro(
                        processo.status ||
                          processo.etapa,
                      ) || 'N/A'}
                </span>
              </div>
              <div className="rounded px-2 py-1 border border-[var(--border)] bg-[var(--panel)]">
                <span className="opacity-70">Última mov.: </span>
                <span>
                  {historico.length
                    ? new Date(
                        historico[0].data_movimentacao ||
                          historico[0].data ||
                          historico[0].created_at,
                      ).toLocaleString('pt-BR')
                    : 'N/A'}
                </span>
              </div>
              <div className="rounded px-2 py-1 border border-[var(--border)] bg-[var(--panel)] col-span-1 sm:col-span-2 lg:col-span-1">
                <span className="opacity-70">Valor estimado: </span>
                {processo.coluna_kanban === 1 ? (
                  <input
                    type="number"
                    step="0.01"
                    className="ml-1 px-2 py-0.5 rounded border border-[var(--border)] bg-[var(--card)] text-[var(--fg)] w-28"
                    value={valorEstimado}
                    onChange={(e) => {
                      setValorEstimado(e.target.value);
                      salvarValorEstimadoDebounced(
                        e.target.value,
                      );
                    }}
                    onBlur={salvarValorEstimado}
                  />
                ) : (
                  <span>
                    {valorEstimado || 'N/A'}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Módulo: Movimentação */}
          <div className="glass-card rounded-lg p-6">
            <h3 className="text-lg font-semibold text-[var(--fg)] mb-4 flex items-center gap-2">
              <Tag size={20} />
              Movimentação do Processo
            </h3>

            <form
              onSubmit={handleSubmit}
              className="space-y-4"
            >
              {/* Metadados de Suspensão */}
              {suspenso && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-3 border border-amber-600/40 rounded glass-card">
                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-[var(--fg)] mb-2">
                      Motivo da Suspensão
                    </label>
                    <input
                      type="text"
                      value={suspensoMotivo}
                      onChange={(e) =>
                        setSuspensoMotivo(e.target.value)
                      }
                      placeholder="Ex.: Aguardando retorno do cliente"
                      className="w-full p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-amber-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-[var(--fg)] mb-2">
                      Suspenso até
                    </label>
                    <input
                      type="date"
                      value={suspensoAte}
                      onChange={(e) =>
                        setSuspensoAte(e.target.value)
                      }
                      className="w-full p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-amber-500 focus:outline-none"
                    />
                  </div>
                  <p className="text-xs opacity-70 md:col-span-3">
                    Dica: o botão no topo liga/desliga a
                    suspensão; estes campos são salvos junto ao
                    "Salvar alterações".
                  </p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--fg)] mb-2">
                    Etapa Atual
                  </label>
                  <select
                    value={etapa}
                    onChange={(e) =>
                      setEtapa(e.target.value)
                    }
                    className="w-full p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)] focus:outline-none"
                    required
                  >
                    <option value="">
                      Selecione uma etapa
                    </option>
                    {getEtapasDisponiveis()
                      .filter(
                        (x) =>
                          x.coluna ===
                          processo.coluna_kanban,
                      )
                      .map((opt) => (
                        <option
                          key={opt.id}
                          value={opt.nome}
                        >
                          {opt.nome}
                        </option>
                      ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-[var(--fg)] mb-2">
                    Sub-etapa
                  </label>
                  <select
                    value={subEtapa}
                    onChange={(e) =>
                      setSubEtapa(e.target.value)
                    }
                    className="w-full p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)] focus:outline-none"
                    disabled={!etapa}
                  >
                    <option value="">
                      Selecione uma sub-etapa
                    </option>
                    {getSubEtapasDisponiveis().map(
                      (opt) => (
                        <option
                          key={opt.id}
                          value={opt.nome}
                        >
                          {opt.nome}
                        </option>
                      ),
                    )}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--fg)] mb-2">
                  Comentário (Opcional para salvar, obrigatório para criar histórico)
                </label>
                <textarea
                  ref={comentarioRef}
                  value={comentario}
                  onChange={(e) =>
                    setComentario(e.target.value)
                  }
                  onPaste={handlePasteComentario}
                  rows={4}
                  className="w-full p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)] focus:outline-none resize-none"
                  placeholder="Adicione um comentário para registrar uma movimentação no histórico..."
                />
                <p className="text-xs opacity-70 mt-1">
                  Dica: você pode colar prints diretamente no campo (Ctrl+V)
                </p>
                <div className="mt-2 flex items-center gap-3">
                  <label className="inline-flex items-center gap-2 cursor-pointer text-[var(--fg)]">
                    <Paperclip size={16} />
                    <span className="text-sm">
                      Anexar arquivos
                    </span>
                    <input
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) =>
                        setAnexos(
                          Array.from(
                            e.target.files || [],
                          ),
                        )
                      }
                    />
                  </label>
                  {Array.isArray(anexos) &&
                    anexos.length > 0 && (
                      <span className="text-xs opacity-70">
                        {anexos.length} arquivo(s)
                        selecionado(s)
                      </span>
                    )}
                </div>

                <div className="mt-3 flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                  {/* Menções */}
                  <div className="text-xs w-full md:max-w-[420px]" style={{ display: 'none' }}>
                    <label className="block text-sm font-medium text-[var(--fg)] mb-2">
                      Menções (@)
                    </label>
                    <div className="glass-card border border-[var(--border)] rounded p-2">
                      {/* menções removidas */}
                    </div>
                  </div>

                  {/* Canais */}
                  <div className="w-full md:w-auto md:min-w-[260px] shrink-0">
                    <label className="block text-sm font-medium text-[var(--fg)] mb-2">
                      Canais de Comunicação
                    </label>
                    <div className="flex flex-wrap gap-2 items-center justify-center w-full text-[12px]">
                      <button
                        type="button"
                        title="WhatsApp"
                        onClick={() =>
                          setCanaisSelecionados(
                            (v) => ({
                              ...v,
                              whatsapp:
                                !v.whatsapp,
                            }),
                          )
                        }
                        className={
                          'px-3 py-2 h-10 text-[12px] font-medium rounded border panel-border flex items-center justify-center gap-1 basis-[160px] grow-0 shrink-0 ' +
                          (canaisSelecionados.whatsapp
                            ? 'btn-accent'
                            : 'glass-card')
                        }
                      >
                        <MessageSquare
                          size={12}
                        />{' '}
                        <span>WhatsApp</span>
                      </button>

                      <button
                        type="button"
                        title="Ligação"
                        onClick={() =>
                          setCanaisSelecionados(
                            (v) => ({
                              ...v,
                              ligacao:
                                !v.ligacao,
                            }),
                          )
                        }
                        className={
                          'px-3 py-2 h-10 text-[12px] font-medium rounded border panel-border flex items-center justify-center gap-1 basis-[160px] grow-0 shrink-0 ' +
                          (canaisSelecionados.ligacao
                            ? 'btn-accent'
                            : 'glass-card')
                        }
                      >
                        <Phone size={12} />{' '}
                        <span>Ligação</span>
                      </button>

                      <button
                        type="button"
                        title="E-mail"
                        onClick={() =>
                          setCanaisSelecionados(
                            (v) => ({
                              ...v,
                              email:
                                !v.email,
                            }),
                          )
                        }
                        className={
                          'px-3 py-2 h-10 text-[12px] font-medium rounded border panel-border flex items-center justify-center gap-1 basis-[160px] grow-0 shrink-0 ' +
                          (canaisSelecionados.email
                            ? 'btn-accent'
                            : 'glass-card')
                        }
                      >
                        <Mail size={12} />{' '}
                        <span>E-mail</span>
                      </button>

                      <button
                        type="button"
                        title="SMS"
                        onClick={() =>
                          setCanaisSelecionados(
                            (v) => ({
                              ...v,
                              sms: !v.sms,
                            }),
                          )
                        }
                        className={
                          'px-3 py-2 h-10 text-[12px] font-medium rounded border panel-border flex items-center justify-center gap-1 basis-[160px] grow-0 shrink-0 group ' +
                          (canaisSelecionados.sms
                            ? 'btn-accent'
                            : 'glass-card')
                        }
                      >
                        <MessageSquare
                          size={12}
                          className={
                            (canaisSelecionados.sms
                              ? 'animate-pulse '
                              : '') +
                            'transition-transform group-hover:scale-110'
                          }
                        />
                        <span className="text-[12px] font-medium">
                          SMS
                        </span>
                      </button>

                      <button
                        type="button"
                        title="Site"
                        onClick={() =>
                          setCanaisSelecionados(
                            (v) => ({
                              ...v,
                              site:
                                !v.site,
                            }),
                          )
                        }
                        className={
                          'px-3 py-2 h-10 text-[12px] font-medium rounded border panel-border flex items-center justify-center gap-1 basis-[160px] grow-0 shrink-0 group ' +
                          (canaisSelecionados.site
                            ? 'btn-accent'
                            : 'glass-card')
                        }
                      >
                        <Globe
                          size={12}
                          className={
                            (canaisSelecionados.site
                              ? 'animate-pulse '
                              : '') +
                            'transition-transform group-hover:scale-110'
                          }
                        />
                        <span className="text-[12px] font-medium">
                          Site
                        </span>
                      </button>

                      <button
                        type="button"
                        title="Pessoal"
                        onClick={() =>
                          setCanaisSelecionados(
                            (v) => ({
                              ...v,
                              pessoal:
                                !v.pessoal,
                            }),
                          )
                        }
                        className={
                          'px-3 py-2 h-10 text-[12px] font-medium rounded border panel-border flex items-center justify-center gap-1 basis-[160px] grow-0 shrink-0 group ' +
                          (canaisSelecionados.pessoal
                            ? 'btn-accent'
                            : 'glass-card')
                        }
                      >
                        <User
                          size={12}
                          className={
                            (canaisSelecionados.pessoal
                              ? 'animate-pulse '
                              : '') +
                            'transition-transform group-hover:scale-110'
                          }
                        />
                        <span className="text-[12px] font-medium">
                          Pessoal
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex gap-3 pt-4 border-t border-[var(--border)]">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex items-center justify-center gap-2 px-6 py-3 btn-accent hover:opacity-90 disabled:opacity-60 rounded-lg transition-opacity w-full"
                  title='Salva todas as alterações. Se houver um comentário, cria um novo registro no histórico.'
                >
                  {isSubmitting ? (
                    <>
                      <RefreshCw
                        className="animate-spin"
                        size={16}
                      />
                      Salvando...
                    </>
                  ) : (
                    <>
                      <Save size={16} />
                      Salvar alterações
                    </>
                  )}
                </button>
              </div>

              <div className="mt-3">
                <button
                  type="button"
                  onClick={avancarEtapa}
                  className="px-4 py-2 btn-neutral rounded-lg"
                  title="Avançar para a próxima etapa (requer módulo atual preenchido)"
                >
                  Avançar Etapa
                </button>
              </div>
            </form>
          </div>

          {/* Módulo: Deferimento */}
          <div
            className={
              'glass-card rounded-lg p-6 ' +
              (!isModuloAtivo('deferidos')
                ? 'opacity-50 pointer-events-none'
                : '')
            }
          >
            <h3 className="text-lg font-semibold text-[var(--fg)] mb-4 flex items-center gap-2">
              <CheckCircle size={20} />
              Deferimento
              {!isModuloAtivo('deferidos') && (
                <span className="text-xs bg-gray-600 px-2 py-1 rounded">
                  Bloqueado
                </span>
              )}
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[var(--fg)] mb-2">
                  Data do Deferimento
                </label>
                <input
                  type="date"
                  value={dataDeferimento}
                  onChange={(e) =>
                    setDataDeferimento(e.target.value)
                  }
                  className="w-full p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)] focus:outline-none"
                  disabled={!isModuloAtivo('deferidos')}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--fg)] mb-2">
                    Crédito Simples
                  </label>
                  <div className="relative">
                    <DollarSign
                      className="absolute left-3 top-3 opacity-70"
                      size={16}
                    />
                    <input
                      type="number"
                      step="0.01"
                      value={creditoSimples}
                      onChange={(e) =>
                        setCreditoSimples(e.target.value)
                      }
                      className="w-full pl-10 p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)] focus:outline-none"
                      placeholder="0,00"
                      disabled={!isModuloAtivo('deferidos')}
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center gap-3 mb-2">
                    <input
                      type="checkbox"
                      checked={habilitarCreditoDobro}
                      onChange={(e) =>
                        setHabilitarCreditoDobro(
                          e.target.checked,
                        )
                      }
                      className="w-4 h-4 text-blue-600 glass-card border-[var(--border)] rounded focus:ring-[var(--accent)]"
                      disabled={!isModuloAtivo('deferidos')}
                    />
                    <label className="text-sm font-medium text-[var(--fg)]">
                      Habilitar Crédito em Dobro
                    </label>
                  </div>
                  <div className="relative">
                    <DollarSign
                      className="absolute left-3 top-3 opacity-70"
                      size={16}
                    />
                    <input
                      type="number"
                      step="0.01"
                      value={creditoDobro}
                      onChange={(e) =>
                        setCreditoDobro(e.target.value)
                      }
                      className="w-full pl-10 p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)] focus:outline-none"
                      placeholder="0,00"
                      disabled={
                        !isModuloAtivo('deferidos') ||
                        !habilitarCreditoDobro
                      }
                    />
                  </div>

                  <div className="mt-2">
                    <label className="block text-xs opacity-80 mb-1">
                      Data do Crédito em Dobro
                    </label>
                    <input
                      type="date"
                      value={dataCreditoDobro}
                      onChange={(e) =>
                        setDataCreditoDobro(
                          e.target.value,
                        )
                      }
                      className="w-full p-2 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)] focus:outline-none"
                      disabled={
                        !isModuloAtivo('deferidos') ||
                        !habilitarCreditoDobro
                      }
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Módulo: Fluxo de Ressarcimento */}
          <div
            className={
              'glass-card rounded-lg p-6 ' +
              (!isModuloAtivo('fluxoRessarcimento')
                ? 'opacity-50 pointer-events-none'
                : '')
            }
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-[var(--fg)] flex items-center gap-2">
                <ArrowRightCircle size={20} />
                Fluxo de Ressarcimento
                {!isModuloAtivo('fluxoRessarcimento') && (
                  <span className="text-xs bg-gray-600 px-2 py-1 rounded">
                    Bloqueado
                  </span>
                )}
              </h3>
              <button
                type="button"
                onClick={() => {
                  const ids =
                    fluxoRessarcimento.map(
                      (f) => f.id,
                    );
                  const novoId = ids.length
                    ? Math.max(...ids) + 1
                    : 1;
                  setFluxoRessarcimento((prev) => [
                    ...prev,
                    {
                      id: novoId,
                      formasDevolucao: [],
                      valor: '',
                      data: '',
                    },
                  ]);
                }}
                className="flex items-center gap-2 px-3 py-2 bg-success hover:opacity-90 text-[var(--fg)] rounded-lg transition-colors"
                disabled={!isModuloAtivo('fluxoRessarcimento')}
              >
                <PlusCircle size={16} />
                Adicionar
              </button>
            </div>

            <div className="space-y-4">
              {fluxoRessarcimento.map(
                (item, index) => (
                  <div
                    key={item.id}
                    className="p-4 glass-card rounded-lg"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="font-medium text-[var(--fg)]">
                        Devolução #{index + 1}
                      </h4>
                      {fluxoRessarcimento.length >
                        1 && (
                        <button
                          type="button"
                          onClick={() =>
                            setFluxoRessarcimento(
                              (prev) =>
                                prev.filter(
                                  (f) =>
                                    f.id !==
                                    item.id,
                                ),
                            )
                          }
                          className="text-red-400 hover:text-red-300"
                        >
                          <MinusCircle
                            size={16}
                          />
                        </button>
                      )}
                    </div>

                    <div className="space-y-3">
                      <div>
                        <label className="block text-sm font-medium text-[var(--fg)] mb-2">
                          Forma de Devolução
                        </label>
                        <div className="flex gap-4">
                          {[
                            'Fatura',
                            'GD',
                            'Depósito',
                          ].map((forma) => (
                            <label
                              key={forma}
                              className="flex items-center gap-2"
                            >
                              <input
                                type="checkbox"
                                checked={item.formasDevolucao.includes(
                                  forma,
                                )}
                                onChange={() =>
                                  setFluxoRessarcimento(
                                    (
                                      prev,
                                    ) =>
                                      prev.map(
                                        (
                                          f,
                                        ) => {
                                          if (
                                            f.id !==
                                            item.id
                                          )
                                            return f;
                                          const existe =
                                            f.formasDevolucao.includes(
                                              forma,
                                            );
                                          return {
                                            ...f,
                                            formasDevolucao:
                                              existe
                                                ? f.formasDevolucao.filter(
                                                    (
                                                      x,
                                                    ) =>
                                                      x !==
                                                      forma,
                                                  )
                                                : [
                                                    ...f.formasDevolucao,
                                                    forma,
                                                  ],
                                          };
                                        },
                                      ),
                                  )
                                }
                                className="w-4 h-4 text-blue-600 glass-card border-[var(--border)] rounded focus:ring-[var(--accent)]"
                              />
                              <span className="text-sm text-[var(--fg)]">
                                {forma}
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-sm font-medium text-[var(--fg)] mb-2">
                            Valor
                          </label>
                          <div className="relative">
                            <DollarSign
                              className="absolute left-3 top-3 opacity-70"
                              size={16}
                            />
                            <input
                              type="number"
                              step="0.01"
                              value={item.valor}
                              onChange={(e) =>
                                setFluxoRessarcimento(
                                  (prev) =>
                                    prev.map(
                                      (
                                        f,
                                      ) =>
                                        f.id ===
                                        item.id
                                          ? {
                                              ...f,
                                              valor:
                                                e
                                                  .target
                                                  .value,
                                            }
                                          : f,
                                    ),
                                )
                              }
                              className="w-full pl-10 p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)] focus:outline-none"
                              placeholder="0,00"
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-[var(--fg)] mb-2">
                            Data
                          </label>
                          <input
                            type="date"
                            value={item.data}
                            onChange={(e) =>
                              setFluxoRessarcimento(
                                (prev) =>
                                  prev.map(
                                    (
                                      f,
                                    ) =>
                                      f.id ===
                                      item.id
                                        ? {
                                            ...f,
                                            data:
                                              e
                                                .target
                                                .value,
                                          }
                                        : f,
                                  ),
                              )
                            }
                            className="w-full p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)] focus:outline-none"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                ),
              )}
            </div>
          </div>

          {/* Módulo: Faturamento */}
          <div
            className={
              'glass-card rounded-lg p-6 ' +
              (!isModuloAtivo('faturamento')
                ? 'opacity-50 pointer-events-none'
                : '')
            }
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-[var(--fg)] flex items-center gap-2">
                <FileText size={20} />
                Faturamento
                {!isModuloAtivo('faturamento') && (
                  <span className="text-xs bg-gray-600 px-2 py-1 rounded">
                    Bloqueado
                  </span>
                )}
              </h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const ids =
                      faturamento.map(
                        (f) => f.id,
                      );
                    const novoId = ids.length
                      ? Math.max(...ids) + 1
                      : 1;
                    setFaturamento((prev) => [
                      ...prev,
                      {
                        id: novoId,
                        numeroNF: '',
                        dataEmissao: '',
                        dataVencimento: '',
                        dataPagamento: '',
                        valor: '',
                        anexoNF: null,
                      },
                    ]);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-success hover:opacity-90 text-[var(--fg)] rounded-lg transition-colors"
                  disabled={!isModuloAtivo('faturamento')}
                >
                  <PlusCircle size={16} />
                  Adicionar NF
                </button>
                {/* Botão removido conforme solicitado: Abrir Últimas faturas */}
              </div>
            </div>

            <div className="space-y-4">
              {faturamento.map((item, index) => (
                <div
                  key={item.id}
                  className="p-4 glass-card rounded-lg"
                >
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-medium text-[var(--fg)]">
                      Nota Fiscal #{index + 1}
                    </h4>
                    {faturamento.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setFaturamento(
                            (prev) =>
                              prev.filter(
                                (f) =>
                                  f.id !==
                                  item.id,
                              ),
                          )
                        }
                        className="text-red-400 hover:text-red-300"
                      >
                        <MinusCircle size={16} />
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-[var(--fg)] mb-2">
                        Nº da NF
                      </label>
                      <input
                        type="text"
                        value={item.numeroNF}
                        onChange={(e) =>
                          setFaturamento(
                            (prev) =>
                              prev.map(
                                (f) =>
                                  f.id ===
                                  item.id
                                    ? {
                                        ...f,
                                        numeroNF:
                                          e
                                            .target
                                            .value,
                                      }
                                    : f,
                              ),
                          )
                        }
                        className="w-full p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)] focus:outline-none"
                        placeholder="000000"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-[var(--fg)] mb-2">
                        Data de Emissão
                      </label>
                      <input
                        type="date"
                        value={item.dataEmissao}
                        onChange={(e) =>
                          setFaturamento(
                            (prev) =>
                              prev.map(
                                (f) =>
                                  f.id ===
                                  item.id
                                    ? {
                                        ...f,
                                        dataEmissao:
                                          e
                                            .target
                                            .value,
                                      }
                                    : f,
                              ),
                          )
                        }
                        className="w-full p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)]"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-[var(--fg)] mb-2">
                        Data de Vencimento
                      </label>
                      <input
                        type="date"
                        value={item.dataVencimento}
                        onChange={(e) =>
                          setFaturamento(
                            (prev) =>
                              prev.map(
                                (f) =>
                                  f.id ===
                                  item.id
                                    ? {
                                        ...f,
                                        dataVencimento:
                                          e
                                            .target
                                            .value,
                                      }
                                    : f,
                              ),
                          )
                        }
                        className="w-full p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)]"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-[var(--fg)] mb-2">
                        Data de Pagamento
                      </label>
                      <input
                        type="date"
                        value={item.dataPagamento}
                        onChange={(e) =>
                          setFaturamento(
                            (prev) =>
                              prev.map(
                                (f) =>
                                  f.id ===
                                  item.id
                                    ? {
                                        ...f,
                                        dataPagamento:
                                          e
                                            .target
                                            .value,
                                      }
                                    : f,
                              ),
                          )
                        }
                        className="w-full p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)]"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-[var(--fg)] mb-2">
                        Valor
                      </label>
                      <div className="relative">
                        <DollarSign
                          className="absolute left-3 top-3 opacity-70"
                          size={16}
                        />
                        <input
                          type="number"
                          step="0.01"
                          value={item.valor}
                          onChange={(e) =>
                            setFaturamento(
                              (prev) =>
                                prev.map(
                                  (f) =>
                                    f.id ===
                                    item.id
                                      ? {
                                          ...f,
                                          valor:
                                            e
                                              .target
                                              .value,
                                        }
                                      : f,
                                ),
                            )
                          }
                          className="w-full pl-10 p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)] focus:outline-none"
                          placeholder="0,00"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-[var(--fg)] mb-2">
                        Anexar NF
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="file"
                          accept=".pdf,.jpg,.jpeg,.png"
                          onChange={(e) =>
                            setFaturamento(
                              (prev) =>
                                prev.map(
                                  (f) =>
                                    f.id ===
                                    item.id
                                      ? {
                                          ...f,
                                          anexoNF:
                                            e
                                              .target
                                              .files?.[0] ||
                                            null,
                                        }
                                      : f,
                                ),
                            )
                          }
                          className="hidden"
                          id={`anexo-${item.id}`}
                        />
                        <label
                          htmlFor={`anexo-${item.id}`}
                          className="flex items-center gap-2 px-3 py-2 bg-[var(--accent)] hover:opacity-90 text-[var(--fg)] rounded-lg cursor-pointer transition-colors"
                        >
                          <Paperclip size={16} />
                          Anexar arquivo
                        </label>
                        {item.anexoNF && (
                          <span className="text-xs opacity-70">
                            {item.anexoNF.name}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Módulo: Conclusão */}
          <div
            className={
              'glass-card rounded-lg p-6 ' +
              (!isModuloAtivo('Concluído')
                ? 'opacity-50 pointer-events-none'
                : '')
            }
          >
            <h3 className="text-lg font-semibold text-[var(--fg)] mb-4 flex items-center gap-2">
              <CheckCircle size={20} />
              Finalização do Processo
              {!isModuloAtivo('Concluído') && (
                <span className="text-xs bg-gray-600 px-2 py-1 rounded">
                  Bloqueado
                </span>
              )}
            </h3>

            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={modulosAprovados.ativos}
                    onChange={(e) =>
                      setModulosAprovados(
                        (prev) => ({
                          ...prev,
                          ativos:
                            e.target
                              .checked,
                        }),
                      )
                    }
                    className="w-4 h-4 text-green-600 glass-card border-[var(--border)] rounded focus:ring-green-500"
                    disabled={!isModuloAtivo('Concluído')}
                  />
                  <span className="text-[var(--fg)]">
                    Módulo Ativos Aprovado
                  </span>
                </label>

                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={
                      modulosAprovados.deferidos
                    }
                    onChange={(e) =>
                      setModulosAprovados(
                        (prev) => ({
                          ...prev,
                          deferidos:
                            e.target
                              .checked,
                        }),
                      )
                    }
                    className="w-4 h-4 text-green-600 glass-card border-[var(--border)] rounded focus:ring-green-500"
                    disabled={!isModuloAtivo('Concluído')}
                  />
                  <span className="text-[var(--fg)]">
                    Módulo Deferidos Aprovado
                  </span>
                </label>

                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={
                      modulosAprovados.fluxoRessarcimento
                    }
                    onChange={(e) =>
                      setModulosAprovados(
                        (prev) => ({
                          ...prev,
                          fluxoRessarcimento:
                            e.target
                              .checked,
                        }),
                      )
                    }
                    className="w-4 h-4 text-green-600 glass-card border-[var(--border)] rounded focus:ring-green-500"
                    disabled={!isModuloAtivo('Concluído')}
                  />
                  <span className="text-[var(--fg)]">
                    Fluxo de Ressarcimento
                    Aprovado
                  </span>
                </label>

                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={
                      modulosAprovados.faturamento
                    }
                    onChange={(e) =>
                      setModulosAprovados(
                        (prev) => ({
                          ...prev,
                          faturamento:
                            e.target
                              .checked,
                        }),
                      )
                    }
                    className="w-4 h-4 text-green-600 glass-card border-[var(--border)] rounded focus:ring-green-500"
                    disabled={!isModuloAtivo('Concluído')}
                  />
                  <span className="text-[var(--fg)]">
                    Módulo Faturamento Aprovado
                  </span>
                </label>
              </div>

              <button
                type="button"
                onClick={finalizarProcesso}
                disabled={
                  loading ||
                  !Object.values(
                    modulosAprovados,
                  ).every(Boolean)
                }
                className="w-full flex items-center justify-center gap-2 px-6 py-4 bg-success hover:opacity-90 disabled:bg-gray-600 text-[var(--fg)] rounded-lg transition-colors font-semibold"
              >
                {loading ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Finalizando...
                  </>
                ) : (
                  <>
                    <CheckCircle size={20} />
                    Processo Finalizado
                  </>
                )}
              </button>
            </div>
          </div>

          {/* FAB Indeferir */}
          <div className="hidden md:block absolute bottom-6 -right-3 z-20">
            <button
              type="button"
              onClick={indeferirProcesso}
              aria-label="Indeferir processo"
              title="Indeferir processo"
              className="w-12 h-12 rounded-full bg-red-600 hover:bg-red-500 text-white shadow-xl focus:outline-none focus:ring-2 focus:ring-red-400 flex items-center justify-center"
            >
              <Trash2 size={20} />
            </button>
          </div>
        </div>

        {/* Direita: Histórico */}
        <div className="w-96 glass-card rounded-lg flex flex-col">
          <div className="p-4 border-b border-[var(--border)]">
            <h3 className="font-semibold text-[var(--fg)] flex items-center gap-2">
              <Clock size={16} />
              Histórico de Movimentações
            </h3>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {loadingHistorico ? (
              <div className="flex items-center justify-center py-8">
                <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
              </div>
            ) : historico.length > 0 ? (
              <div className="space-y-4">
                {historico.map((item, index) => {
                  const { etapaName, subName } =
                    deriveEtapaSubEtapa(item);
                  const etapaTag =
                    etapaName || 'N/A';
                  const subTag = subName;
                  const dt = item.data_movimentacao
                    ? new Date(
                        item.data_movimentacao,
                      )
                    : item.data
                    ? new Date(item.data)
                    : item.created_at
                    ? new Date(
                        item.created_at,
                      )
                    : null;
                  const canais = Array.isArray(
                    item.canais,
                  )
                    ? item.canais
                    : [];
                  const label = item?.status_composto
                    ? String(
                        item
                          .status_composto,
                      )
                    : `${etapaTag}${
                        subTag
                          ? ' - ' +
                            subTag
                          : ''
                      }${
                        canais.length
                          ? ' via ' +
                            canais.join(
                              ', ',
                            )
                          : ''
                      }`;

                  return (
                    <div
                      key={index}
                      className="border-l-2 border-[var(--accent)] pl-4 pb-4"
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <span
                          className={`px-2 py-1 rounded text-xs font-medium text-[var(--fg)] ${getEtapaColorSafe(
                            etapaTag,
                          )}`}
                        >
                          {label}
                        </span>
                      </div>

                      <p className="text-sm text-[var(--fg)] mb-2">
                        {extrairTextoSeguro(
                          item.comentario,
                        ) || 'Sem comentário'}
                      </p>

                      <div className="text-xs opacity-70">
                        <p>
                          Por:{' '}
                          {extrairTextoSeguro(
                            item.usuario_nome ||
                              item.nome_usuario,
                          ) || 'Sistema'}
                        </p>
                        <p>
                          {dt
                            ? dt.toLocaleString(
                                'pt-BR',
                              )
                            : ''}
                        </p>
                        {canais.length > 0 && (
                          <div className="mt-1 flex items-center gap-1 flex-wrap">
                            {canais.map(
                              (
                                c,
                                i,
                              ) => {
                                const v =
                                  String(
                                    c ||
                                      '',
                                  ).toLowerCase();
                                const Icon =
                                  v ===
                                  'email'
                                    ? Mail
                                    : v ===
                                      'ligacao'
                                    ? Phone
                                    : MessageSquare;
                                const color =
                                  v ===
                                  'email'
                                    ? 'border-blue-500 text-blue-300'
                                    : v ===
                                      'whatsapp'
                                    ? 'border-green-500 text-green-300'
                                    : v ===
                                      'ligacao'
                                    ? 'border-amber-500 text-amber-300'
                                    : 'border-purple-500 text-purple-300';
                                return (
                                  <span
                                    key={
                                      i
                                    }
                                    className={`px-2 py-0.5 rounded glass-card border flex items-center gap-1 ${color}`}
                                  >
                                    <Icon
                                      size={
                                        12
                                      }
                                    />{' '}
                                    {
                                      v
                                    }
                                  </span>
                                );
                              },
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-8 opacity-70">
                <Clock
                  size={32}
                  className="mx-auto mb-2 opacity-50"
                />
                <p>
                  Nenhuma Movimentação
                  encontrada
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modal de Faturas */}
      {showFaturas && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setShowFaturas(false)}
          />
          <div className="relative z-10 w-full max-w-2xl bg-[var(--card)] text-[var(--fg)] border border-[var(--border)] rounded-xl p-4 shadow-2xl">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-lg font-semibold">
                Faturas recentes
              </h4>
              <button
                type="button"
                onClick={() => setShowFaturas(false)}
                className="px-2 py-1 rounded border border-[var(--border)] hover:text-[var(--accent)]"
              >
                Fechar
              </button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {Array.isArray(faturas) &&
              faturas.length > 0 ? (
                <ul className="space-y-2">
                  {faturas.map(
                    (f, i) => {
                      const mes =
                        f?.mes_ref ||
                        f?.MesRef ||
                        '';
                      const link =
                        f?.link ||
                        f?.Link ||
                        '';
                      const venc =
                        f?.dt_vencimento ||
                        f
                          ?.DtVencimento ||
                        '';
                      const val =
                        f
                          ?.valor_total ??
                        f
                          ?.ValorTotal ??
                        null;
                      return (
                        <li
                          key={i}
                          className="p-2 rounded glass-card border border-[var(--border)] flex items-center justify-between gap-3"
                        >
                          <div className="flex flex-col">
                            <span className="text-sm">
                              {mes ||
                                'Mês não informado'}
                            </span>
                            <span className="text-xs opacity-70">
                              {venc
                                ? `Venc.: ${new Date(
                                    venc,
                                  ).toLocaleDateString(
                                    'pt-BR',
                                  )}`
                                : ''}
                            </span>
                          </div>
                          <div className="flex items-center gap-3">
                            {val !=
                              null && (
                              <span className="text-sm">
                                R{'$ '}
                                {Number(
                                  val,
                                ).toLocaleString(
                                  'pt-BR',
                                  {
                                    minimumFractionDigits: 2,
                                  },
                                )}
                              </span>
                            )}
                            {link ? (
                              <a
                                href={
                                  link
                                }
                                target="_blank"
                                rel="noreferrer"
                                className="px-3 py-1 rounded btn-accent"
                              >
                                Abrir
                                link
                              </a>
                            ) : (
                              <span className="text-xs opacity-70">
                                Sem link
                              </span>
                            )}
                          </div>
                        </li>
                      );
                    },
                  )}
                </ul>
              ) : (
                <div className="text-center py-8 opacity-70">
                  Nenhuma fatura encontrada
                  para os últimos meses.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProcessoDetalhes;
