// src/pages/ControleProcessosV2.jsx
// Nova versão paralela do Controle de Processos — usa /api/v2 (banco refatorado).
// Tabela densa estilo Excel + abas por etapa + filtros + KPIs + drawer.
//
// Rota: /controle-processos-v2 (a versão antiga em /processos continua intacta).

import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Search,
  Download,
  ArrowRight,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Settings,
  SlidersHorizontal,
} from 'lucide-react';
import { listProcessos, getHistoricoGlobal, getAuditoriaProcessos } from '../services/processoV2Service.js';
import { useDimensoesV2 } from '../hooks/useDimensoesV2.js';
import { calcularGanho } from '../services/empresaPercentualService.js';
import { fmtDataBR as fmtData, fmtDataHoraBR as fmtDataHora } from '../utils/dateBR.js';
import MovimentarModal from '../components/ProcessoDrawer/MovimentarModal.jsx';
import { CobrancaEmailModal } from './HomeGestorAdmin.jsx';
import ModalPercentuaisEmpresa from '../components/ModalPercentuaisEmpresa/index.jsx';
import MetaDeferimentoBar from '../components/MetaDeferimentoBar/MetaDeferimentoBar.jsx';
import { tempoMedioConcessionaria } from '../services/assistenteService.js';
import MultiSelectFilter from '../components/MultiSelectFilter/index.jsx';
import ExportModal from '../components/ExportModal/index.jsx';
import '../components/MultiSelectFilter/multi-select-filter.css';
import Toast from '../components/Toast.jsx';
import api from '../services/apiClient.js';
import { chipSituacaoAneel, mudouAneelRecente } from '../utils/protocolosAneel.js';
import * as XLSX from 'xlsx';
import './controleProcessosV2.css';

// Célula "Distribuidora" com botão "?" → tempo médio de deferimento da concessionária.
function TmRow({ k, v }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, opacity: 0.8, paddingTop: 6, marginTop: 6, borderTop: '1px solid var(--border)' }}>
      <span>{k}</span><span>{v}</span>
    </div>
  );
}
function DistribuidoraCell({ nome }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const toggle = async (e) => {
    e.stopPropagation();
    const next = !open;
    setOpen(next);
    if (next && !data && nome) {
      setLoading(true);
      try { setData(await tempoMedioConcessionaria(nome)); }
      catch { setData({ erro: true }); }
      finally { setLoading(false); }
    }
  };
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, position: 'relative' }}>
      <span>{nome || '—'}</span>
      {nome && (
        <button
          type="button"
          onClick={toggle}
          title="Tempo médio de deferimento"
          style={{ width: 16, height: 16, borderRadius: '50%', border: '1px solid var(--accent)', color: 'var(--accent)', background: 'transparent', fontSize: 10, fontWeight: 700, cursor: 'pointer', lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 16px' }}
        >
          ?
        </button>
      )}
      {open && (
        <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', left: 0, top: 24, zIndex: 20, width: 248, background: 'var(--card)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', boxShadow: '0 14px 40px rgba(0,0,0,0.38)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.06em', opacity: 0.7 }}>Tempo médio de deferimento</span>
            <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(false); }} style={{ background: 'none', border: 'none', cursor: 'pointer', opacity: 0.6, fontSize: 15, lineHeight: 1 }}>×</button>
          </div>
          {loading ? (
            <div style={{ fontSize: 12, opacity: 0.7 }}>Calculando…</div>
          ) : data?.erro ? (
            <div style={{ fontSize: 12, opacity: 0.7 }}>Não foi possível calcular.</div>
          ) : (
            <>
              <div style={{ fontFamily: "'Space Grotesk', 'Inter', sans-serif", fontWeight: 700, fontSize: 22 }}>
                {data?.tempo_medio_deferimento_dias != null ? `${data.tempo_medio_deferimento_dias} dias` : 'sem dados'}
              </div>
              <div style={{ fontSize: 11, opacity: 0.6 }}>{nome}{data?.amostra != null ? ` · ${data.amostra} processo(s)` : ''}</div>
              {data?.min_dias != null && <TmRow k="Mais rápido" v={`${data.min_dias} dias`} />}
              {data?.max_dias != null && <TmRow k="Mais lento" v={`${data.max_dias} dias`} />}
              {data?.tempo_medio_comprovante_dias != null && <TmRow k="Envio do comprovante" v={`${data.tempo_medio_comprovante_dias} dias`} />}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ----------- helpers -----------
function brl(v) {
  if (v == null) return '—';
  return Number(v).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}


function diasDesde(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const diff = Date.now() - d.getTime();
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
}

const STATUS_CHIP = {
  'Em análise': 'cpv2-chip cpv2-chip--info',
  'Em elaboração': 'cpv2-chip cpv2-chip--info',
  'Aguardando retorno': 'cpv2-chip cpv2-chip--warning',
  Pendente: 'cpv2-chip cpv2-chip--warning',
  Suspenso: 'cpv2-chip cpv2-chip--neutral',
  Cancelado: 'cpv2-chip cpv2-chip--danger',
  Encerrado: 'cpv2-chip cpv2-chip--success',
};

const INST_CHIP = {
  Distribuidora: 'cpv2-chip cpv2-chip--brand',
  Ouvidoria: 'cpv2-chip cpv2-chip--info',
  ANEEL: 'cpv2-chip cpv2-chip--info',
  SMA: 'cpv2-chip cpv2-chip--purple',
};

const PRIORIDADE_CHIP = {
  Alta: 'cpv2-chip cpv2-chip--danger',
  Média: 'cpv2-chip cpv2-chip--warning',
  Normal: 'cpv2-chip cpv2-chip--neutral',
  Baixa: 'cpv2-chip cpv2-chip--success',
};

const ETAPAS_ORDEM = [
  { id: 1, key: 'reclamacao', label: 'Reclamação', posdef: false },
  { id: 2, key: 'contestacao', label: 'Contestação', posdef: false },
  { id: 3, key: 'conciliacao', label: 'Conciliação', posdef: false },
  { id: 4, key: 'faturamento', label: 'Faturamento', posdef: true },
  { id: 5, key: 'repasse', label: 'Repasse', posdef: true },
  { id: 6, key: 'encerramento', label: 'Encerramento', posdef: true },
];

const PAGE_SIZE = 50;

// ----------- KPIs Card -----------
function Kpi({ label, value, delta, deltaType }) {
  return (
    <div className="cpv2-kpi">
      <div className="cpv2-kpi__label">{label}</div>
      <div className="cpv2-kpi__value">{value}</div>
      {delta && (
        <div
          className={`cpv2-kpi__delta ${deltaType === 'neg' ? 'is-neg' : ''}`}
        >
          {delta}
        </div>
      )}
    </div>
  );
}

// ----------- Cabeçalho ordenável -----------
function ThSort({ label, sortKey, sort, setSort, align }) {
  const active = sort.key === sortKey;
  const dir = active ? sort.dir : null;
  const onClick = () => {
    setSort((prev) =>
      prev.key === sortKey
        ? { key: sortKey, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key: sortKey, dir: 'asc' },
    );
  };
  const Icon = dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ArrowUpDown;
  return (
    <th
      onClick={onClick}
      style={{ cursor: 'pointer', userSelect: 'none', textAlign: align || 'left' }}
      title="Ordenar"
      aria-sort={
        active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'
      }
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {label}
        <Icon size={11} style={{ opacity: active ? 1 : 0.4 }} />
      </span>
    </th>
  );
}

// ----------- Linha da tabela -----------
function LinhaProcesso({ p, ganho, onAbrir, onMover, onCobrar }) {
  const dias = diasDesde(p.data_ultima_movimentacao);
  const priClass = PRIORIDADE_CHIP[p.prioridade?.nome] || PRIORIDADE_CHIP.Normal;
  const instLabel = p.instancia?.nome || 'Pós-Def';
  const instClass = p.instancia
    ? INST_CHIP[p.instancia.nome] || INST_CHIP.Distribuidora
    : 'cpv2-chip cpv2-chip--warning';
  const statusClass =
    STATUS_CHIP[p.status?.nome] || 'cpv2-chip cpv2-chip--neutral';

  const handleRowClick = (e) => {
    // Ctrl/Meta-click + middle-click são tratados pelo <Link> da 1ª célula —
    // se o usuário clicar em qualquer outra célula sem modificador, navega.
    if (e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
    onAbrir(p.id_processo);
  };

  return (
    <tr
      className={`cpv2-row cpv2-row--pri-${(p.prioridade?.nome || '').toLowerCase()}`}
      onClick={handleRowClick}
      data-id={p.id_processo}
    >
      <td>
        <Link
          to={`/processos/${p.id_processo}`}
          className="cpv2-id"
          onClick={(e) => e.stopPropagation()}
        >
          {p.codigo_publico}
        </Link>
      </td>
      <td>
        <div className="cpv2-cliente">{p.cliente}</div>
        <div className="cpv2-cliente__sub">{p.cliente_doc}</div>
      </td>
      <td><DistribuidoraCell nome={p.distribuidora} /></td>
      <td>
        <span className="cpv2-mono">{p.codigo_uc}</span>
      </td>
      <td>
        <span className={instClass}>
          <span className="cpv2-chip__dot" />
          {instLabel}
        </span>
      </td>
      <td>
        <span className="cpv2-chip cpv2-chip--neutral">
          <span className="cpv2-chip__dot" />
          {p.etapa?.nome || '—'}
        </span>
      </td>
      <td>
        <span className={statusClass}>
          <span className="cpv2-chip__dot" />
          {p.status?.nome || '—'}
        </span>
      </td>
      <td>
        {p._aneel ? (
          <Link
            to={`/protocolos-aneel?protocolo=${encodeURIComponent(p._aneel.protocolo)}`}
            className="cpv2-mono"
            onClick={(e) => e.stopPropagation()}
            title="Consultar este protocolo"
          >
            {p._aneel.protocolo}
          </Link>
        ) : <span className="cpv2-muted-sm">—</span>}
        {p._aneel?.qtd > 1 && <div className="cpv2-muted-sm">+{p._aneel.qtd - 1} protocolo(s)</div>}
      </td>
      <td>
        {p._aneel?.situacao ? (
          <>
            <span className={chipSituacaoAneel(p._aneel.situacao)}>
              <span className="cpv2-chip__dot" />
              {p._aneel.situacao}
            </span>
            <div className="cpv2-muted-sm">
              {mudouAneelRecente(p._aneel, 1) ? 'mudou ' : 'desde '}{fmtDataHora(p._aneel.ultima_mudanca_em)}
            </div>
          </>
        ) : <span className="cpv2-muted-sm">{p._aneel ? 'nenhum e-mail da ANEEL ainda' : ''}</span>}
      </td>
      <td className="cpv2-num">
        {p.prazo_atrasado == null ? (
          <span className="cpv2-muted-sm">—</span>
        ) : p.prazo_atrasado ? (
          <span
            className="cpv2-chip cpv2-chip--danger"
            style={{ cursor: 'pointer' }}
            title={`Prazo: ${p.prazo_dias} dia(s) ${p.prazo_dias_uteis ? 'úteis' : 'corridos'} — vencido. Clique para sugerir reforço (SR).`}
            onClick={(e) => {
              e.stopPropagation();
              onCobrar(p);
            }}
          >
            <span className="cpv2-chip__dot" />
            {p.prazo_dias_decorridos}d / {p.prazo_dias}d
          </span>
        ) : (
          <span
            className="cpv2-muted-sm"
            title={`Prazo: ${p.prazo_dias} dia(s) ${p.prazo_dias_uteis ? 'úteis' : 'corridos'}`}
          >
            {p.prazo_dias_decorridos}d / {p.prazo_dias}d
          </span>
        )}
      </td>
      <td>
        {p.aprovacao ? (
          <span
            className={`cpv2-chip ${
              p.aprovacao.id === 1 ? 'cpv2-chip--aprov' : 'cpv2-chip--reprov'
            }`}
          >
            <span className="cpv2-chip__dot" />
            {p.aprovacao.nome}
          </span>
        ) : (
          <span className="cpv2-muted-sm">—</span>
        )}
      </td>
      <td className="cpv2-money">{brl(p.ressarcimento_estimado)}</td>
      <td className="cpv2-money">
        {p.valor_repasse_executado > 0 ? (
          <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
            {brl(p.valor_repasse_executado)}
          </span>
        ) : (
          <span className="cpv2-muted-sm">—</span>
        )}
      </td>
      <td className="cpv2-money">
        {ganho ? (
          <span
            className={`cpv2-chip ${
              ganho.cor === 'verde' ? 'cpv2-chip--aprov' : 'cpv2-chip--neutral'
            }`}
            title={ganho.detalhe + ' · ' + ganho.vigencia_aplicada}
            style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}
          >
            <span className="cpv2-chip__dot" />
            {brl(ganho.valor)}
          </span>
        ) : (
          <span className="cpv2-muted-sm">—</span>
        )}
      </td>
      <td className="cpv2-num">
        {dias == null ? (
          '—'
        ) : dias > 30 ? (
          <span className="cpv2-chip cpv2-chip--danger">
            <span className="cpv2-chip__dot" />
            {dias}d
          </span>
        ) : (
          <span className="cpv2-muted-sm">{dias}d</span>
        )}
      </td>
      <td className="cpv2-date">{fmtData(p.data_ultima_movimentacao)}</td>
      <td>
        <span className={priClass}>{p.prioridade?.nome || '—'}</span>
      </td>
    </tr>
  );
}

// ----------- Componente principal -----------
export default function ControleProcessosV2() {
  const queryClient = useQueryClient();
  const { data: dimensoes } = useDimensoesV2();

  // filtros — todos suportam multi-seleção (arrays). [] = sem filtro = "Todos".
  // Persistência: lidos do localStorage no mount; salvos a cada mudança.
  const FILTERS_KEY = 'cpv2_filters_v1';
  const restoredFilters = useMemo(() => {
    try {
      const raw = localStorage.getItem(FILTERS_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }, []);
  const [busca, setBusca] = useState(restoredFilters?.busca ?? '');
  const [filtroDist, setFiltroDist] = useState(restoredFilters?.dist ?? []);
  const [filtroCliente, setFiltroCliente] = useState(restoredFilters?.cliente ?? []);
  const [filtroInst, setFiltroInst] = useState(restoredFilters?.inst ?? []);
  const [filtroStatus, setFiltroStatus] = useState(restoredFilters?.status ?? []);
  const [filtroAprov, setFiltroAprov] = useState(restoredFilters?.aprov ?? []);
  const [filtroRelev, setFiltroRelev] = useState(restoredFilters?.relev ?? []);
  const [filtroEtapaSelect, setFiltroEtapaSelect] = useState(restoredFilters?.etapa ?? []);

  // Persiste filtros no localStorage a cada mudança
  useEffect(() => {
    try {
      const payload = {
        busca,
        dist: filtroDist,
        cliente: filtroCliente,
        inst: filtroInst,
        status: filtroStatus,
        aprov: filtroAprov,
        relev: filtroRelev,
        etapa: filtroEtapaSelect,
      };
      localStorage.setItem(FILTERS_KEY, JSON.stringify(payload));
    } catch {
      // ignore
    }
  }, [busca, filtroDist, filtroCliente, filtroInst, filtroStatus, filtroAprov, filtroRelev, filtroEtapaSelect]);

  const limparFiltros = () => {
    setBusca('');
    setFiltroDist([]);
    setFiltroCliente([]);
    setFiltroInst([]);
    setFiltroStatus([]);
    setFiltroAprov([]);
    setFiltroRelev([]);
    setFiltroEtapaSelect([]);
    try {
      localStorage.removeItem(FILTERS_KEY);
    } catch {
      // ignore
    }
  };
  const [etapaAtiva, setEtapaAtiva] = useState(1); // id_etapa
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: 'data_ultima_movimentacao', dir: 'desc' });

  // navegação + modal de movimentação
  const navigate = useNavigate();
  const [movProc, setMovProc] = useState(null);
  const [cobrancaModal, setCobrancaModal] = useState(null);
  const [modalPctOpen, setModalPctOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [toast, setToast] = useState({ open: false, type: 'info', text: '' });
  const [showFiltros, setShowFiltros] = useState(false); // toolbar de filtros começa oculta
  const filtrosAtivosCount =
    (filtroInst.length ? 1 : 0) +
    (filtroEtapaSelect.length ? 1 : 0) +
    (filtroDist.length ? 1 : 0) +
    (filtroCliente.length ? 1 : 0) +
    (filtroStatus.length ? 1 : 0) +
    (filtroAprov.length ? 1 : 0) +
    (filtroRelev.length ? 1 : 0);

  // query principal: lista de processos (sem filtro de etapa pra termos os counts; aba filtra client-side)
  const filtros = useMemo(
    () => ({
      // não passa etapa pra busca: a aba filtra client-side (precisamos do count global)
      // Filtros multi-valor: enviamos CSV (ex.: "1,2,3"). Backend faz IN(...).
      instancia: filtroInst.length ? filtroInst.join(',') : undefined,
      status: filtroStatus.length ? filtroStatus.join(',') : undefined,
      aprovacao: filtroAprov.length ? filtroAprov.join(',') : undefined,
      relevante:
        filtroRelev.length === 1
          ? filtroRelev[0] === 'sim'
          : undefined, // ambos marcados = sem filtro
      distribuidora: filtroDist.length ? filtroDist.join(',') : undefined,
      cliente: filtroCliente.length ? filtroCliente.join(',') : undefined,
      q: busca.trim() || undefined,
      page: 1,
      page_size: 5000, // abas filtram client-side e precisam ver TODOS pra contar
    }),
    [filtroDist, filtroCliente, filtroInst, filtroStatus, filtroAprov, filtroRelev, busca],
  );

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['v2', 'processos', filtros],
    queryFn: () => listProcessos(filtros),
    keepPreviousData: true,
  });

  const todos = data?.items || [];

  // Protocolos ANEEL por processo (colunas "Protocolo ANEEL" / "Situação na ANEEL")
  const { data: aneelPorProcesso } = useQuery({
    queryKey: ['protocolos-aneel', 'resumo-processos'],
    queryFn: () => api.get('/protocolos-aneel/resumo-processos').then((r) => r.data || {}),
    staleTime: 5 * 60 * 1000,
  });
  const [soMudancaAneel, setSoMudancaAneel] = useState(false);

  // Mapa cod_empresa → array de vigências (pra cálculo do Repasse)
  const vigPorEmpresa = useMemo(() => {
    const m = new Map();
    for (const e of dimensoes?.percentuais_empresa || []) {
      m.set(e.cod_empresa, e.vigencias || []);
    }
    return m;
  }, [dimensoes]);

  // bucket por etapa
  const buckets = useMemo(() => {
    const out = {};
    for (const e of ETAPAS_ORDEM) out[e.id] = [];
    for (const p of todos) {
      const eid = p.etapa?.id;
      if (out[eid]) out[eid].push(p);
    }
    return out;
  }, [todos]);

  // Quando há busca ativa OU filtro de etapa via select, atravessa as abas.
  // Qualquer filtro server-side ativo (busca textual, etapa, status, instância, aprovação, distribuidora)
  // faz a tabela atravessar as abas — caso contrário, a aba ativa esconde resultados de outras etapas.
  const buscaAtiva =
    busca.trim().length > 0 ||
    filtroEtapaSelect.length > 0 ||
    filtroStatus.length > 0 ||
    filtroInst.length > 0 ||
    filtroAprov.length > 0 ||
    filtroRelev.length > 0 ||
    filtroDist.length > 0 ||
    filtroCliente.length > 0;

  // Linhas-base: aba ativa OU todos (busca atravessando abas).
  const linhasBase = useMemo(() => {
    if (buscaAtiva) {
      if (filtroEtapaSelect.length > 0) {
        // Junta os buckets de todas as etapas selecionadas
        return filtroEtapaSelect.flatMap((id) => buckets[Number(id)] || []);
      }
      return todos;
    }
    return buckets[etapaAtiva] || [];
  }, [buscaAtiva, filtroEtapaSelect, buckets, etapaAtiva, todos]);

  // Filtro de aprovação (server-side via ?aprovacao=). Nada extra a fazer aqui.
  // "Concluído na ANEEL" atravessa as abas (conclusão nos últimos 7 dias)
  const linhasFiltradas = useMemo(
    () => (soMudancaAneel
      ? (buscaAtiva ? linhasBase : todos).filter((p) => mudouAneelRecente(aneelPorProcesso?.[p.id_processo], 7))
      : linhasBase),
    [soMudancaAneel, buscaAtiva, linhasBase, todos, aneelPorProcesso],
  );

  // Ordenação client por cabeçalho
  const linhas = useMemo(() => {
    // decora cada processo com _ganho (Repasse calculado por vigência)
    const arr = linhasFiltradas.map((p) => {
      const vig = p.cod_empresa ? vigPorEmpresa.get(p.cod_empresa) : null;
      return { ...p, _ganho: calcularGanho(p, vig || []), _aneel: aneelPorProcesso?.[p.id_processo] };
    });
    const { key, dir } = sort;
    const mul = dir === 'asc' ? 1 : -1;
    const get = (p) => {
      switch (key) {
        case 'codigo_publico':   return p.codigo_publico || '';
        case 'cliente':          return (p.cliente || '').toLowerCase();
        case 'distribuidora':    return (p.distribuidora || '').toLowerCase();
        case 'codigo_uc':        return p.codigo_uc || '';
        case 'instancia':        return p.instancia?.nome || '';
        case 'etapa':            return p.etapa?.nome || '';
        case 'status':           return p.status?.nome || '';
        case 'aprovacao':        return p.aprovacao?.nome || '';
        case 'ressarcimento':    return Number(p.ressarcimento_estimado || 0);
        case 'repasse_exec':     return Number(p.valor_repasse_executado || 0);
        case 'repasse':          return Number(p._ganho?.valor || 0);
        case 'dias':             return diasDesde(p.data_ultima_movimentacao) ?? -1;
        case 'data_ultima_movimentacao':
          return p.data_ultima_movimentacao || '';
        case 'prioridade':       return p.prioridade?.nome || '';
        case 'prot_aneel':       return p._aneel?.protocolo || '';
        case 'sit_aneel':        return p._aneel?.ultima_mudanca_em || '';
        default:                 return '';
      }
    };
    arr.sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va < vb) return -1 * mul;
      if (va > vb) return  1 * mul;
      return 0;
    });
    return arr;
  }, [linhasFiltradas, sort, vigPorEmpresa, aneelPorProcesso]);

  const totalPagina = Math.max(1, Math.ceil(linhas.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPagina);
  const linhasPagina = linhas.slice(
    (pageSafe - 1) * PAGE_SIZE,
    pageSafe * PAGE_SIZE,
  );

  // KPIs — contam apenas processos ATIVOS:
  //   excluem Suspensos (status=5), Encerrados/Concluídos (status=7) e Indeferidos (aprovacao=2).
  const isAtivo = (p) => {
    const stId = p.status?.id;
    const apId = p.aprovacao?.id;
    if (stId === 5 || stId === 7) return false;
    if (apId === 2) return false;
    return true;
  };
  const ativos = useMemo(() => todos.filter(isAtivo), [todos]);
  const totalAtivos = ativos.length;
  const counts = useMemo(() => {
    const c = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    for (const p of ativos) {
      const eid = p.etapa?.id;
      if (c[eid] != null) c[eid] += 1;
    }
    return c;
  }, [ativos]);
  // Contagem por etapa sobre TODOS (inclui Encerrados/Indeferidos/Suspensos) — usada no badge das
  // abas, pra bater com o conteúdo (ex.: Encerramento mostra os encerrados deferidos + indeferidos).
  const countsTab = useMemo(() => {
    const c = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    for (const p of todos) {
      const eid = p.etapa?.id;
      if (c[eid] != null) c[eid] += 1;
    }
    return c;
  }, [todos]);
  const posdefTotal = counts[4] + counts[5] + counts[6];
  const alertaTotal = useMemo(
    () => ativos.filter((p) => (diasDesde(p.data_ultima_movimentacao) ?? 0) > 30).length,
    [ativos],
  );
  const valorTotal = useMemo(
    () => ativos.reduce((acc, p) => acc + Number(p.ressarcimento_estimado || 0), 0),
    [ativos],
  );

  const abrirDrawer = (id) => navigate(`/processos/${id}`);
  const abrirMover = (proc) => setMovProc(proc);
  const fecharMover = () => setMovProc(null);

  const onMoverSucesso = (idProcesso, etapaIdNovo) => {
    setMovProc(null);
    setToast({
      open: true,
      type: 'success',
      text: 'Movimentação salva com sucesso.',
    });
    queryClient.invalidateQueries({ queryKey: ['v2', 'processos'] });
    queryClient.invalidateQueries({ queryKey: ['v2', 'processo', idProcesso] });
    // Atualiza automaticamente as abas do drawer (histórico/anexos/etc.) sem recarregar a página.
    queryClient.invalidateQueries({ queryKey: ['v2', 'historico', idProcesso] });
    queryClient.invalidateQueries({ queryKey: ['v2', 'anexos', idProcesso] });
    queryClient.invalidateQueries({ queryKey: ['v2', 'deferimento', idProcesso] });
    queryClient.invalidateQueries({ queryKey: ['v2', 'faturamento', idProcesso] });
    queryClient.invalidateQueries({ queryKey: ['v2', 'repasse', idProcesso] });
    queryClient.invalidateQueries({ queryKey: ['v2', 'encerramento', idProcesso] });
    if (etapaIdNovo) setEtapaAtiva(etapaIdNovo);
  };

  const onMoverErro = (err) => {
    setToast({
      open: true,
      type: 'error',
      text: err?.message || 'Falha ao movimentar processo.',
    });
  };

  // Monta as linhas do "sheet" de processos (formato tabular) a partir das linhas visíveis.
  // Decora com _ganho (Repasse por vigência) — mesmo cálculo do useMemo de `linhas`.
  const decorarGanho = (arr) =>
    arr.map((p) => {
      const vig = p.cod_empresa ? vigPorEmpresa.get(p.cod_empresa) : null;
      return { ...p, _ganho: calcularGanho(p, vig || []) };
    });

  // Recebe o conjunto a exportar (não usa mais `linhas` da página — export busca TODOS do filtro).
  const montarLinhasProcessos = (arr) => {
    return decorarGanho(arr).map((p) => ({
      Código: p.codigo_publico || '',
      Cliente: p.cliente || '',
      CNPJ: p.cliente_doc || '',
      Distribuidora: p.distribuidora || '',
      UC: p.codigo_uc || '',
      Instância: p.instancia?.nome || 'Pós-Def',
      Etapa: p.etapa?.nome || '',
      Status: p.status?.nome || '',
      Aprovação: p.aprovacao?.nome || '',
      'Valor estimado': Number(p.ressarcimento_estimado || 0),
      'Repasse executado': Number(p.valor_repasse_executado || 0),
      'Repasse AMEE': p._ganho ? Number(p._ganho.valor || 0) : '',
      'Repasse · tipo': p._ganho ? p._ganho.tipo : '',
      Abertura: dataBR(p.data_abertura),
      'Última mov': dataBR(p.data_ultima_movimentacao),
      Prioridade: p.prioridade?.nome || '',
    }));
  };

  // Busca histórico dos processos exportados (chunks de 500 pra evitar URL gigante).
  const buscarHistoricosDosProcessos = async (idsProcessos, onProgresso) => {
    const CHUNK = 500;
    const chunks = [];
    for (let i = 0; i < idsProcessos.length; i += CHUNK) {
      chunks.push(idsProcessos.slice(i, i + CHUNK));
    }
    const tudo = [];
    for (let i = 0; i < chunks.length; i++) {
      onProgresso?.(`Buscando histórico (${i + 1}/${chunks.length})…`);
      const { items = [] } = await getHistoricoGlobal({
        processos: chunks[i].join(','),
        limit: 50000,
      });
      tudo.push(...items);
    }
    // Mapa código_publico pra referência cruzada no XLSX
    return tudo.map((h) => ({
      Código: h.codigo_publico || '',
      'ID processo': h.id_processo,
      Data: fmtDataHora(h.data_movimentacao) || '',
      Instância: h.instancia?.nome || '',
      Etapa: h.etapa?.nome || '',
      Status: h.status?.nome || '',
      Aprovação: h.aprovacao?.nome || '',
      Tipo: h.tipo_movimentacao || '',
      Comentário: h.comentario || '',
      Usuário: h.usuario?.nome || '',
    }));
  };

  // dd/mm/aaaa (ou vazio) — normaliza as datas que vêm raw do backend (ISO/UTC/YYYY-MM-DD…).
  const dataBR = (v) => {
    if (!v) return '';
    const s = fmtData(v);
    return s === '—' ? '' : s;
  };

  // --- Normalização de meses/períodos (formatos despadronizados no banco) → MM/AAAA ---
  const mm2 = (n) => String(n).padStart(2, '0');
  // Parseia um token de data em {a:ano, m:mês} ou null (aceita AAAA-MM-DD, DD/MM/AAAA, MM/AAAA).
  const parseMesAno = (t) => {
    const s = String(t).trim();
    let m;
    if ((m = s.match(/(\d{4})-(\d{1,2})(?:-\d{1,2})?/))) return { a: +m[1], m: +m[2] };
    if ((m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/))) return { a: +m[3], m: +m[2] };
    if ((m = s.match(/(\d{1,2})\/(\d{4})/))) return { a: +m[2], m: +m[1] };
    return null;
  };
  const fmtMA = (o) => `${mm2(o.m)}/${o.a}`;
  const chaveMA = (s) => { const m = String(s).match(/(\d{2})\/(\d{4})/); return m ? m[2] + m[1] : '999999'; };
  // Expande um intervalo [ini, fim] em todos os meses MM/AAAA (guard de 360 meses).
  const mesesEntre = (ini, fim) => {
    if (fim.a < ini.a || (fim.a === ini.a && fim.m < ini.m)) return [fmtMA(ini)];
    const out = []; let a = ini.a, m = ini.m, g = 0;
    while ((a < fim.a || (a === fim.a && m <= fim.m)) && g++ < 360) { out.push({ a, m }); m++; if (m > 12) { m = 1; a++; } }
    return out.map(fmtMA);
  };
  // Extrai o texto de periodos_irregularidade (JSON [{"raw":...}] ou texto cru).
  const extrairRaw = (periodos) => {
    if (!periodos) return '';
    try {
      const arr = JSON.parse(periodos);
      if (Array.isArray(arr)) return arr.map((o) => (o && typeof o === 'object') ? (o.raw != null ? String(o.raw) : (o.ano && o.mes ? `${o.mes}/${o.ano}` : '')) : String(o)).join(' ; ');
      return String(periodos);
    } catch { return String(periodos); }
  };
  // Normaliza periodos_irregularidade → "MM/AAAA, MM/AAAA". Expande intervalos ("até"/"a"),
  // trata aberto ("a atual fatura" → "MM/AAAA em diante") e ignora lixo (<NA>, -).
  const normalizarPeriodos = (periodos) => {
    let txt = extrairRaw(periodos).trim();
    if (!txt || txt === '-' || /^<na>$/i.test(txt)) return '';
    const out = new Set();
    txt.split(';').forEach((seg0) => {
      const seg = seg0.trim();
      if (!seg) return;
      const rng = seg.match(/(.+?)\s+(?:até|a)\s+(.+)/i);
      if (rng) {
        const ini = parseMesAno(rng[1]);
        const fim = parseMesAno(rng[2]);
        if (ini && fim) { mesesEntre(ini, fim).forEach((x) => out.add(x)); return; }
        if (ini && /atual/i.test(rng[2])) { out.add(`${fmtMA(ini)} em diante`); return; }
      }
      seg.split(/\s+e\s+|,/i).forEach((tok) => { const d = parseMesAno(tok); if (d) out.add(fmtMA(d)); });
    });
    return [...out].sort((a, b) => chaveMA(a).localeCompare(chaveMA(b))).join(', ');
  };
  // Meses de referência: usa mes_ref (GROUP_CONCAT) quando houver, senão os períodos normalizados.
  const normalizarMeses = (mesRef, periodos) => {
    const out = new Set();
    String(mesRef || '').split(/[,;]/).forEach((s) => { const d = parseMesAno(s); if (d) out.add(fmtMA(d)); });
    if (out.size === 0) return normalizarPeriodos(periodos);
    return [...out].sort((a, b) => chaveMA(a).localeCompare(chaveMA(b))).join(', ');
  };

  // --- Deriva UF a partir do nome da concessionária (campo heterogêneo no banco) ---
  const UFS = new Set(['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO']);
  const UF_MAP = [
    [/MATO GROSSO DO SUL|ENERGISA MS\b/, 'MS'],
    [/MATO GROSSO|ENERGISA MT\b/, 'MT'],
    [/CELESC|\bCASAN\b|COOPERALIAN|CERBRANORTE/, 'SC'],
    [/CEMIG|\bDMED\b|COPASA|MURIA|ITABIRA|DEMSUR|ENERGISA (MR|MG|NF)|MINAS GERAIS/, 'MG'],
    [/COPEL|SANEPAR|\bCOCEL\b|COPREL/, 'PR'],
    [/LIGHT|ENEL RIO|ENEL RJ|AMPLA|AGUAS DO RIO|PROLAGOS|AGUAS DO PARAIBA|VOLTA REDONDA/, 'RJ'],
    [/EDP ES|ENERGIAS DO BRASIL|ESPIRITO SANTO/, 'ES'],
    [/ENEL SP|ELETROPAULO|ELEKTRO|EDP SP|CPFL|PIRATININGA|JAGUARI|SABESP|SANASA|SEMAE|DAAE|SAERP|BANDEIRANTE|SAO PAULO/, 'SP'],
    [/COELBA|NEOENERGIA BA|EMBASA|BAHIA/, 'BA'],
    [/ENEL CE|COELCE|ENERGETICA DO CEARA|CEARA/, 'CE'],
    [/EQUATORIAL PI|PIAUI/, 'PI'],
    [/AMAZONAS|AMBAR/, 'AM'],
    [/EQUATORIAL GO|ENEL GOIAS|SANEAGO|CHESP|GOIAS/, 'GO'],
    [/EQUATORIAL (PA|PARA)|COSANPA|\bPARA\b/, 'PA'],
    [/EQUATORIAL (MAR|MARANHAO)|CAEMA|MARANHAO/, 'MA'],
    [/ENERGISA PB|PARAIBA|CAGEPA/, 'PB'],
    [/EQUATORIAL RS|CEEE|\bRGE\b|CORSAN|DMAE|PORTO ALEGRE|CERTAJA|CERTEL|CRELUZ|CRERAL|CERGRAND|CERIM|CERRP|CERPALO|COOPERALIANCA/, 'RS'],
    [/NEOENERGIA BRASILIA|\bCEB\b|CAESB|BRASILIA/, 'DF'],
    [/NEOENERGIA PE|CELPE|COMPESA|PERNAMBUCO/, 'PE'],
    [/NEOENERGIA RN|COSERN|CAERN/, 'RN'],
    [/ENERGISA SE|\bDESO\b|SERGIPE/, 'SE'],
    [/ENERGISA (TO|TOCANTINS)|TOCANTINS/, 'TO'],
    [/ENERGISA RO|RONDONIA/, 'RO'],
    [/ENERGISA ACRE|\bACRE\b/, 'AC'],
    [/EQUATORIAL AL|ALAGOAS|\bCASAL\b/, 'AL'],
    [/EQUATORIAL AP|\bCEA\b|AMAPA/, 'AP'],
    [/RORAIMA/, 'RR'],
  ];
  const ufFromConcessionaria = (raw) => {
    if (!raw) return '';
    const s = String(raw).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
    const toks = s.replace(/[()/]/g, ' ').trim().split(/\s+/);
    const last = toks[toks.length - 1];
    if (UFS.has(last)) return last; // sufixo explícito (ENEL SP, EQUATORIAL AL…)
    for (const [re, uf] of UF_MAP) if (re.test(s)) return uf;
    return '';
  };

  // Aba "Resumo" — exatamente os campos pedidos na emissão de relatórios.
  const montarLinhasResumo = (items) =>
    items.map((r) => ({
      'UC / Instalação': r.uc || '',
      Cliente: r.cliente || '',
      Distribuidora: r.concessionaria || '',
      UF: ufFromConcessionaria(r.concessionaria),
      'Crédito Simples': r.credito_simples ?? '',
      'Crédito Dobro': r.credito_dobro ?? '',
      'Repasse Simples': r.repasse_simples ?? '',
      'Repasse Dobro': r.repasse_dobro ?? '',
      'Tipo Irregularidade': r.tipo_irregularidade || '',
      'Subtipo Irregularidade': r.subtipo_irregularidade || '',
      'Meses de Referência': normalizarMeses(r.mes_referencia, r.periodos_irregularidade),
      'Resumo / Objeto': r.descricao_irregularidade || '',
    }));

  // Aba "Financeiro" — uma linha por devolução (FT_FLUXO_RESSARCIMENTO).
  const montarLinhasFinanceiro = (devs) =>
    (devs || []).map((d) => ({
      Código: d.codigo_publico || '',
      'UC / Instalação': d.uc || '',
      Cliente: d.cliente || '',
      Distribuidora: d.concessionaria || '',
      UF: ufFromConcessionaria(d.concessionaria),
      'Data de Envio ao Financeiro': dataBR(d.data_envio_financeiro),
      'Forma de Devolução': d.forma_devolucao || '',
      'Data da Devolução': dataBR(d.data_devolucao),
      'Valor da Devolução': d.valor ?? '',
      Referência: normalizarMeses(d.mes_referencia, d.periodos_irregularidade),
    }));

  // Colunas do relatório de auditoria (todos os processos, todos os campos do banco).
  const montarLinhasAuditoria = (items, devByProc = {}) => {
    const fmtVal = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // Cada devolução auto-descrita (forma: valor (data)), preservando todas do processo.
    const detalheDevs = (id) =>
      (devByProc[id] || [])
        .map((d) => `${d.forma_devolucao || '?'}: R$ ${fmtVal(d.valor)} (${dataBR(d.data_devolucao)})`)
        .join(' | ');
    return items.map((r) => ({
      ID: r.id_processo,
      Código: r.codigo_publico || '',
      UC: r.uc || '',
      Cliente: r.cliente || '',
      Concessionária: r.concessionaria || '',
      'Cod. Empresa': r.cod_empresa ?? '',
      Instância: r.instancia || '',
      Etapa: r.etapa || '',
      Status: r.status || '',
      Aprovação: r.aprovacao || '',
      'Data Criação Requisição': dataBR(r.data_criacao_requisicao),
      'Data Registro Reclamação': dataBR(r.data_registro_reclamacao),
      'Data Última Movimentação': dataBR(r.data_ultima_movimentacao),
      'Dias na Etapa': r.dias_na_etapa ?? '',
      'Períodos de Irregularidade': normalizarPeriodos(r.periodos_irregularidade),
      'Descrição Irregularidade': r.descricao_irregularidade || '',
      'Tipo Irregularidade': r.tipo_irregularidade || '',
      'Subtipo Irregularidade': r.subtipo_irregularidade || '',
      'Mês da Irregularidade': r.mes_referencia || '',
      'Ressarcimento Estimado': r.ressarcimento_estimado ?? '',
      'Crédito Simples': r.credito_simples ?? '',
      'Crédito Dobro': r.credito_dobro ?? '',
      'Repasse Simples': r.repasse_simples ?? '',
      'Repasse Dobro': r.repasse_dobro ?? '',
      'Instância do Deferimento': r.instancia_deferimento || '',
      'Data Deferido Simples': dataBR(r.data_deferido_simples),
      'Data Deferido Dobro': dataBR(r.data_deferido_dobro),
      NF: r.nf || '',
      'Envio ao Financeiro': dataBR(r.data_envio_financeiro),
      'Vencimento NF': dataBR(r.data_vencimento_nf),
      'Valor NF': r.valor_nf ?? '',
      'Data de Pagamento da NF': dataBR(r.data_pagamento_nf),
      'Data de Encerramento': dataBR(r.data_encerramento),
      'Motivo Encerramento': r.motivo_encerramento || '',
      'Parecer Final': r.parecer_final || '',
      'Último Comentário': r.ultimo_comentario || '',
      Relevante: r.relevante ? 'Sim' : 'Não',
      Suspenso: r.suspenso ? 'Sim' : 'Não',
      Responsável: r.responsavel || '',
      'Data de Alerta': dataBR(r.data_alerta),
      'Última Atualização': dataBR(r.ultima_atualizacao),
      'Data de Movimentação': dataBR(r.data_movimentacao),
      'Data Próxima Ação': dataBR(r.data_proxima_acao),
      'Score %': r.score_percentual ?? '',
      'Triagem Concluída': r.triagem_concluida ? 'Sim' : 'Não',
      '% Repasse': r.percentual_repasse ?? '',
      'UC Atual': r.uc_atual || '',
      'Status Análise (Deferimento)': r.status_analise_def || '',
      'Observação Deferimento': r.observacao_def || '',
      'Data Emissão NF': dataBR(r.data_emissao_nf),
      'Série NF': r.serie_nf || '',
      'Status NF': r.status_nf || '',
      'Total Devolvido': r.total_devolvido ?? '',
      'Devoluções (forma · valor · data)': detalheDevs(r.id_processo),
      'Datas de Envio ao Financeiro (Devoluções)': r.datas_envio_financeiro || '',
    }));
  };

  // Handler chamado pelo ExportModal com { formato, conjunto, comHistorico, onProgresso }.
  const executarExport = async ({ formato, conjunto = 'filtrados', comHistorico, onProgresso }) => {
    let linhasProc;
    let linhasResumo = null;
    let linhasFin = null;
    let idsHist;

    if (conjunto === 'auditoria') {
      onProgresso?.('Carregando auditoria (todos os processos)…');
      const resp = await getAuditoriaProcessos();
      const items = resp?.items || [];
      const devolucoes = resp?.devolucoes || [];
      if (items.length === 0) throw new Error('Nenhum processo pra exportar.');
      linhasResumo = montarLinhasResumo(items);
      linhasFin = montarLinhasFinanceiro(devolucoes);
      const devByProc = {};
      devolucoes.forEach((d) => {
        (devByProc[d.id_processo] = devByProc[d.id_processo] || []).push(d);
      });
      linhasProc = montarLinhasAuditoria(items, devByProc); // aba "Detalhado" (dump completo)
      idsHist = items.map((r) => r.id_processo).filter(Boolean);
    } else {
      // Busca TODOS os processos do filtro atual, paginando até esgotar o total
      // (o backend capa page_size em 5000). Não depende da página carregada na tela.
      onProgresso?.('Carregando todos os processos…');
      const PAGE = 5000;
      const primeira = await listProcessos({ ...filtros, page: 1, page_size: PAGE });
      const total = Number(primeira.total || 0);
      let todosExport = primeira.items || [];
      const nPaginas = Math.max(1, Math.ceil(total / PAGE));
      for (let p = 2; p <= nPaginas; p++) {
        onProgresso?.(`Carregando processos (${todosExport.length}/${total})…`);
        const r = await listProcessos({ ...filtros, page: p, page_size: PAGE });
        todosExport = todosExport.concat(r.items || []);
      }

      // Mesma seleção que a tabela exibe (aba ativa, ou filtros atravessando abas).
      let selecao;
      if (buscaAtiva) {
        if (filtroEtapaSelect.length > 0) {
          const set = new Set(filtroEtapaSelect.map(Number));
          selecao = todosExport.filter((p) => set.has(Number(p.etapa?.id)));
        } else {
          selecao = todosExport;
        }
      } else {
        selecao = todosExport.filter((p) => Number(p.etapa?.id) === Number(etapaAtiva));
      }

      if (selecao.length === 0) {
        throw new Error('Nenhum processo pra exportar.');
      }
      onProgresso?.('Montando processos…');
      linhasProc = montarLinhasProcessos(selecao);
      idsHist = selecao.map((p) => p.id_processo).filter(Boolean);
    }

    let linhasHist = null;
    if (comHistorico) {
      linhasHist = await buscarHistoricosDosProcessos(idsHist, onProgresso);
      onProgresso?.(`${linhasHist.length} movimentações coletadas. Gerando arquivo…`);
    } else {
      onProgresso?.('Gerando arquivo…');
    }

    const ts = new Date().toISOString().slice(0, 10);
    const base = `processos_v2_${ts}`;

    const ehAuditoria = conjunto === 'auditoria';

    if (formato === 'xlsx') {
      const wb = XLSX.utils.book_new();
      if (ehAuditoria) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linhasResumo), 'Resumo');
        const finRows = linhasFin && linhasFin.length ? linhasFin : [{ Aviso: 'Nenhuma devolução registrada.' }];
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(finRows), 'Financeiro');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linhasProc), 'Detalhado');
      } else {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linhasProc), 'Processos');
      }
      if (linhasHist) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linhasHist), 'Histórico');
      }
      XLSX.writeFile(wb, `${base}.xlsx`);
    } else {
      // CSV — uma planilha por arquivo (baixa em sequência)
      const escapaCSV = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const linhasToCsv = (rows) => {
        if (rows.length === 0) return '';
        const cab = Object.keys(rows[0]);
        const body = rows.map((r) => cab.map((k) => escapaCSV(r[k])).join(','));
        return '﻿' + cab.join(',') + '\n' + body.join('\n');
      };
      const baixar = (nome, texto) => {
        const blob = new Blob([texto], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = nome;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      };
      if (ehAuditoria) {
        baixar(`${base}_resumo.csv`, linhasToCsv(linhasResumo));
        if (linhasFin && linhasFin.length) baixar(`${base}_financeiro.csv`, linhasToCsv(linhasFin));
        baixar(`${base}_detalhado.csv`, linhasToCsv(linhasProc));
      } else {
        baixar(`${base}.csv`, linhasToCsv(linhasProc));
      }
      if (linhasHist) {
        baixar(`${base}_historico.csv`, linhasToCsv(linhasHist));
      }
    }

    const nProc = ehAuditoria ? linhasResumo.length : linhasProc.length;
    const nDev = ehAuditoria && linhasFin ? linhasFin.length : 0;
    setToast({
      open: true,
      type: 'success',
      text: `${nProc} processo(s) exportado(s)${nDev ? ` · ${nDev} devoluç${nDev === 1 ? 'ão' : 'ões'}` : ''}${linhasHist ? ` + ${linhasHist.length} movimentaç${linhasHist.length === 1 ? 'ão' : 'ões'}` : ''}.`,
    });
  };

  return (
    <div className="cpv2-root">
      <main className="cpv2-page">
        <header className="cpv2-page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <h1 className="cpv2-title">Controle de Processos · v2</h1>
            <p className="cpv2-sub">
              Visão de planilha — clique em qualquer linha para abrir o detalhe
              completo do processo.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <MetaDeferimentoBar />
            <button
              type="button"
              className="cpv2-btn"
              onClick={() => setModalPctOpen(true)}
              title="Configurar percentuais de ganho por empresa"
            >
              <Settings size={14} />
              Percentuais por empresa
            </button>
          </div>
        </header>

        {/* KPIs */}
        <section className="cpv2-kpis">
          <Kpi label="Total ativos" value={totalAtivos} delta="em todas as etapas" />
          <Kpi label="Reclamação" value={counts[1] || 0} />
          <Kpi label="Contestação" value={counts[2] || 0} />
          <Kpi label="Conciliação" value={counts[3] || 0} />
          <Kpi label="Pós-deferimento" value={posdefTotal} />
          <Kpi
            label="Pendentes > 30d"
            value={alertaTotal}
            delta="atenção"
            deltaType={alertaTotal > 0 ? 'neg' : undefined}
          />
          <Kpi label="Valor envolvido" value={brl(valorTotal)} />
        </section>

        {/* Toolbar — busca + botão Filtros + CSV sempre visíveis; selects ficam ocultos por padrão */}
        <section className="cpv2-toolbar">
          <div className="cpv2-search">
            <Search size={15} className="cpv2-search__icon" />
            <input
              type="text"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar código, cliente, CNPJ, distribuidora, UC…"
            />
          </div>
          <button
            type="button"
            className={`cpv2-btn ${soMudancaAneel ? 'cpv2-btn--primary' : ''}`}
            onClick={() => setSoMudancaAneel((v) => !v)}
            title="Mostra só os processos cujo protocolo a ANEEL concluiu nos últimos 7 dias (todas as etapas)"
          >
            🏛️ Concluído na ANEEL{soMudancaAneel ? ' ✓' : ''}
          </button>
          <button
            type="button"
            className={`cpv2-btn ${showFiltros ? 'cpv2-btn--primary' : ''}`}
            onClick={() => setShowFiltros((v) => !v)}
            title={showFiltros ? 'Ocultar filtros' : 'Mostrar filtros'}
          >
            <SlidersHorizontal size={13} />
            Filtros{filtrosAtivosCount > 0 ? ` (${filtrosAtivosCount})` : ''}
          </button>
          {filtrosAtivosCount > 0 && (
            <button
              type="button"
              className="cpv2-btn cpv2-btn--ghost"
              onClick={limparFiltros}
              title="Limpar todos os filtros aplicados"
            >
              Limpar filtros
            </button>
          )}
          <button
            type="button"
            className="cpv2-btn"
            onClick={() => setExportOpen(true)}
            title="Exportar processos filtrados"
            disabled={linhas.length === 0}
          >
            <Download size={13} />
            Exportar
          </button>
        </section>

        {showFiltros && (
          <section className="cpv2-toolbar" style={{ marginTop: 6, flexWrap: 'wrap' }}>
            <MultiSelectFilter
              label="Instância"
              options={(dimensoes?.instancias || []).map((i) => ({ value: i.id, label: i.nome }))}
              selected={filtroInst}
              onChange={setFiltroInst}
            />
            <MultiSelectFilter
              label="Etapa"
              title="Filtrar por etapa (sobrescreve a aba ativa)"
              options={ETAPAS_ORDEM.map((e) => ({ value: e.id, label: e.label }))}
              selected={filtroEtapaSelect}
              onChange={(arr) => {
                setFiltroEtapaSelect(arr);
                setPage(1);
              }}
            />
            <MultiSelectFilter
              label="Distribuidora"
              options={(dimensoes?.distribuidoras || []).map((d) => ({ value: d.nome, label: d.nome }))}
              selected={filtroDist}
              onChange={setFiltroDist}
            />
            <MultiSelectFilter
              label="Cliente"
              options={(dimensoes?.clientes || []).map((c) => ({ value: c.nome, label: c.nome }))}
              selected={filtroCliente}
              onChange={setFiltroCliente}
            />
            <MultiSelectFilter
              label="Status"
              options={(dimensoes?.status || []).map((s) => ({ value: s.id, label: s.nome }))}
              selected={filtroStatus}
              onChange={setFiltroStatus}
            />
            <MultiSelectFilter
              label="Aprovação"
              title="Filtrar pela aprovação do processo"
              options={(dimensoes?.aprovacoes || []).map((a) => ({ value: a.id, label: a.nome }))}
              selected={filtroAprov}
              onChange={setFiltroAprov}
            />
            <MultiSelectFilter
              label="Relevância"
              title="Filtrar por marcação de relevância"
              options={[
                { value: 'sim', label: 'Apenas relevantes' },
                { value: 'nao', label: 'Apenas não-relevantes' },
              ]}
              selected={filtroRelev}
              onChange={setFiltroRelev}
            />
          </section>
        )}

        {/* Tabs etapas — quando há busca atravessando abas, ficam desabilitadas */}
        <nav className="cpv2-tabs" role="tablist">
          {ETAPAS_ORDEM.map((e, idx) => (
            <button
              key={e.id}
              type="button"
              role="tab"
              aria-selected={!buscaAtiva && etapaAtiva === e.id}
              disabled={buscaAtiva}
              className={`cpv2-tab ${!buscaAtiva && etapaAtiva === e.id ? 'is-active' : ''} ${
                e.posdef ? 'cpv2-tab--posdef' : ''
              } ${idx === 3 ? 'cpv2-tab--firstpos' : ''} ${
                buscaAtiva ? 'is-disabled' : ''
              }`}
              onClick={() => {
                if (buscaAtiva) return;
                setEtapaAtiva(e.id);
                setPage(1);
              }}
            >
              {e.label}
              <span className="cpv2-tab__count">{countsTab[e.id] || 0}</span>
            </button>
          ))}
        </nav>

        {buscaAtiva && (
          <div
            className="cpv2-banner"
            style={{ background: '#fff8e1', borderColor: '#ffe0a8' }}
          >
            <AlertTriangle size={14} />
            <span>
              {filtroEtapaSelect
                ? <>Filtro de etapa ativo — abas suspensas.</>
                : <>Busca ativa — mostrando processos de <strong>todas as etapas</strong>. Limpe a busca pra voltar às abas.</>}
            </span>
          </div>
        )}

        {/* Tabela */}
        <section className="cpv2-tablewrap">
          {isError && (
            <div className="cpv2-empty cpv2-empty--error">
              <AlertTriangle size={22} />
              <h4>Falha ao carregar processos</h4>
              <p>
                {error?.message || 'Erro desconhecido.'}{' '}
                <button
                  type="button"
                  className="cpv2-btn cpv2-btn--sm"
                  onClick={() => refetch()}
                >
                  Tentar novamente
                </button>
              </p>
            </div>
          )}

          {!isError && (
            <table className="cpv2-table">
              <thead>
                <tr>
                  <ThSort label="Código"        sortKey="codigo_publico"            sort={sort} setSort={setSort} />
                  <ThSort label="Cliente"       sortKey="cliente"                   sort={sort} setSort={setSort} />
                  <ThSort label="Distribuidora" sortKey="distribuidora"             sort={sort} setSort={setSort} />
                  <ThSort label="UC"            sortKey="codigo_uc"                 sort={sort} setSort={setSort} />
                  <ThSort label="Instância"     sortKey="instancia"                 sort={sort} setSort={setSort} />
                  <ThSort label="Etapa"         sortKey="etapa"                     sort={sort} setSort={setSort} />
                  <ThSort label="Status"        sortKey="status"                    sort={sort} setSort={setSort} />
                  <ThSort label="Protocolo ANEEL" sortKey="prot_aneel"              sort={sort} setSort={setSort} />
                  <ThSort label="Situação na ANEEL" sortKey="sit_aneel"             sort={sort} setSort={setSort} />
                  <ThSort label="Prazos"        sortKey="prazo"                     sort={sort} setSort={setSort} />
                  <ThSort label="Aprovação"     sortKey="aprovacao"                 sort={sort} setSort={setSort} />
                  <ThSort label="Valor estimado" sortKey="ressarcimento"            sort={sort} setSort={setSort} align="right" />
                  <ThSort label="Repasse exec."  sortKey="repasse_exec"              sort={sort} setSort={setSort} align="right" />
                  <ThSort label="Repasse AMEE"   sortKey="repasse"                   sort={sort} setSort={setSort} align="right" />
                  <ThSort label="Dias"          sortKey="dias"                      sort={sort} setSort={setSort} align="right" />
                  <ThSort label="Última mov."   sortKey="data_ultima_movimentacao"  sort={sort} setSort={setSort} />
                  <ThSort label="Prior."        sortKey="prioridade"                sort={sort} setSort={setSort} />
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr>
                    <td colSpan={17} className="cpv2-loading">
                      Carregando…
                    </td>
                  </tr>
                )}
                {!isLoading && linhasPagina.length === 0 && (
                  <tr>
                    <td colSpan={17}>
                      <div className="cpv2-empty">
                        <h4>Sem processos nesta etapa</h4>
                        <p>Ajuste os filtros ou movimente um processo.</p>
                      </div>
                    </td>
                  </tr>
                )}
                {!isLoading &&
                  linhasPagina.map((p) => (
                    <LinhaProcesso
                      key={p.id_processo}
                      p={p}
                      ganho={p._ganho}
                      onAbrir={abrirDrawer}
                      onMover={abrirMover}
                      onCobrar={(row) => setCobrancaModal({
                        id_processo: row.id_processo,
                        uc: row.codigo_uc,
                        cliente: row.cliente,
                        concessionaria: row.distribuidora,
                        sub_etapa: row.status?.nome,
                      })}
                    />
                  ))}
              </tbody>
            </table>
          )}
        </section>

        {/* Paginação */}
        {linhas.length > PAGE_SIZE && (
          <div className="cpv2-pager">
            <button
              type="button"
              className="cpv2-btn cpv2-btn--sm"
              disabled={pageSafe <= 1}
              onClick={() => setPage((x) => Math.max(1, x - 1))}
            >
              ← Anterior
            </button>
            <span className="cpv2-pager__info">
              Página {pageSafe} de {totalPagina} · {linhas.length} processo(s)
            </span>
            <button
              type="button"
              className="cpv2-btn cpv2-btn--sm"
              disabled={pageSafe >= totalPagina}
              onClick={() => setPage((x) => Math.min(totalPagina, x + 1))}
            >
              Próxima →
            </button>
          </div>
        )}
      </main>

      {modalPctOpen && (
        <ModalPercentuaisEmpresa
          onClose={() => setModalPctOpen(false)}
          onToast={(t) => setToast(t)}
        />
      )}

      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        totalProcessos={linhas.length}
        onExportar={executarExport}
      />


      {movProc && (
        <MovimentarModal
          processo={movProc}
          onClose={fecharMover}
          onSuccess={onMoverSucesso}
          onError={onMoverErro}
        />
      )}

      {cobrancaModal && (
        <CobrancaEmailModal
          processo={cobrancaModal}
          onClose={() => setCobrancaModal(null)}
          onSent={() => setToast({ open: true, type: 'success', text: 'E-mail de cobrança (SR) enviado com sucesso!' })}
        />
      )}

      <Toast
        open={toast.open}
        type={toast.type}
        message={toast.text}
        onClose={() => setToast((t) => ({ ...t, open: false }))}
      />
    </div>
  );
}
