// src/pages/ControleProcessos.jsx
import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  useDeferredValue,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { useAuth } from '../context/AuthContext.jsx';

import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
} from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';

import {
  Activity,
  CheckCircle,
  DollarSign,
  ThumbsUp,
  ThumbsDown,
  Filter,
  RefreshCcw,
  ChevronDown,
  KanbanSquare as FolderKanban,
  PauseCircle,
} from 'lucide-react';

import {
  getProcessosKanban,
  movimentarProcesso,
  atualizarRequisicaoCompleta,
  suspenderProcesso,
  retomarProcesso,
  getAllTags,
  updateProcessoTags,
  createTag,
  getProcessosCardsMeta,
  // getHistoricoById, // substituído por busca global no backend
  searchGlobalHistorico,
} from '../services/requisicaoService';
import { getEtapas, getEtapaSubMap } from '../services/filtersService';
import { getPrazos } from '../services/prazosService';
import { getAlarmes } from '../services/alarmesService';

import ProcessoCard from '@components/ProcessoCard.jsx';
import { SkeletonLine } from '../components/Skeleton.jsx';

/* ===================== HELPERS ===================== */
const extrair = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'String' in v) return v.Valid ? (v.String ?? '') : '';
  if (typeof v === 'object' && 'Value' in v) return v.Value || '';
  try {
    return String(v);
  } catch {
    return '';
  }
};

// tenta transformar "R$ 1.234,56", "1234.56", "1.234,56" em número
const toNumberOrNull = (val) => {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number' && !isNaN(val)) return val;
  const s = String(val).trim();
  if (!s) return null;
  const norm = s.replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(norm);
  return isNaN(n) ? null : n;
};

// debounce simples p/ efeitos
const useDebounced = (value, delay = 250) => {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
};

/* ===================== MODAIS ===================== */
const ModalGerenciarTags = ({ processo, allTags, onClose, onSave, onTagCreated }) => {
  const [selectedTags, setSelectedTags] = useState(
    () => (processo.tags && processo.tags.length > 0 ? processo.tags.map((t) => t.id) : [])
  );
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#CCCCCC');

  const handleToggleTag = (tagId) => {
    if (!tagId) return;
    setSelectedTags((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]
    );
  };

  const handleCreateTag = async () => {
    if (!newTagName.trim()) {
      alert('O nome da tag não pode ser vazio.');
      return;
    }
    try {
      const novaTag = await createTag(newTagName, newTagColor);
      onTagCreated(novaTag);
      if (!selectedTags.includes(novaTag.id)) {
        setSelectedTags((prev) => [...prev, novaTag.id]);
      }
      setNewTagName('');
    } catch (error) {
      alert(error?.response?.data?.error || 'Erro ao criar a tag.');
    }
  };

  const handleSave = () => onSave(processo.id, selectedTags);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 backdrop-blur-sm flex justify-center items-center z-50">
      <div className="bg-[var(--panel-processos)] sap-card text-[var(--fg)] p-6 w-full max-w-md">
        <h2 className="text-2xl font-bold mb-4">Gerenciar Tags - Processo #{processo.id}</h2>

        <div className="border-b panel-border pb-4 mb-4">
          <h3 className="font-semibold mb-2">Criar Nova Tag</h3>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              placeholder="Nome da tag"
              className="flex-grow input-themed"
            />
            <input
              type="color"
              value={newTagColor}
              onChange={(e) => setNewTagColor(e.target.value)}
              className="w-10 h-10 p-1 border-0 rounded cursor-pointer bg-[var(--panel-processos)]"
              title="Escolha uma cor"
            />
            <button
              onClick={handleCreateTag}
              className="btn-themed"
            >
              Criar
            </button>
          </div>
        </div>

        <p className="mb-2 opacity-70">Selecione as tags para este processo.</p>
        <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto p-2 panel-bg-80 rounded">
          {(allTags || []).map((tag) => {
            const isSelected = selectedTags.includes(tag.id);
            return (
              <button
                key={tag.id}
                onClick={() => handleToggleTag(tag.id)}
                className={`text-sm font-bold px-3 py-2 rounded-full border-2 transition-all ${
                  isSelected ? 'border-blue-500 scale-105' : 'border-transparent opacity-70'
                }`}
                style={{ backgroundColor: tag.cor, color: '#FFFFFF' }}
              >
                {tag.nome}
              </button>
            );
          })}
        </div>

        <div className="flex justify-end space-x-4 mt-6">
          <button
            onClick={onClose}
            className="btn-outline"
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            className="btn-themed"
          >
            Salvar Tags
          </button>
        </div>
      </div>
    </div>
  );
};

const ModalDeferimento = ({ processo, onClose, onSave }) => {
  const [comentario, setComentario] = useState('');
  const [dadosDeferimento, setDadosDeferimento] = useState({
    data_procedencia: '',
    credito_simples: 0,
    credito_dobro: 0,
  });
  const [aplicarDobro, setAplicarDobro] = useState(false);

  const handleChange = (e) => {
  const { name, value, type } = e.target;
  setDadosDeferimento((prev) => ({
    ...prev,
    [name]: type === 'number' ? parseFloat(value) || 0 : value,
  }));
};


  const handleSave = () => {
    if (!comentario.trim()) {
      alert('O comentário da movimentação é obrigatório.');
      return;
    }
    onSave(comentario, dadosDeferimento);
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex justify-center items-center z-50 p-4">
      <div className="bg-[var(--panel-processos)] sap-card text-[var(--fg)] p-6 w/full max-w-2xl max-h-[90vh] overflow-y-auto">
        <h2 className="text-2xl font-bold mb-4">Mover Processo #{processo.id} para Deferidos</h2>

        <div className="mb-6">
          <label className="sap-label mb-2">Comentário da movimentação (Obrigatório)</label>
          <textarea
            value={comentario}
            onChange={(e) => setComentario(e.target.value)}
            rows="4"
            className="w-full input-themed"
            placeholder="Ex.: Procedência confirmada pela concessionária..."
          />
        </div>

        <div className="border-t-2 panel-border pt-4 mt-4">
          <h3 className="text-xl font-semibold mb-4 text-[var(--accent)]">Detalhes do Deferimento</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="sap-label mb-2">Data da Procedência</label>
              <input
                type="date"
                name="data_procedencia"
                value={dadosDeferimento.data_procedencia}
                onChange={handleChange}
                className="w-full input-themed"
              />
            </div>
            <div>
              <label className="sap-label mb-2">Crédito Simples (R$)</label>
              <input
                type="number"
                name="credito_simples"
                value={dadosDeferimento.credito_simples}
                onChange={handleChange}
                className="w-full input-themed"
              />
            </div>
            <div>
              <label className="sap-label mb-2">Crédito em Dobro (R$)</label>
              <input
                type="number"
                name="credito_dobro"
                value={dadosDeferimento.credito_dobro}
                onChange={handleChange}
                className="w-full input-themed disabled:opacity-50"
                disabled={!aplicarDobro}
              />
            </div>
            <div className="flex items-center mt-2">
              <input
                type="checkbox"
                id="aplicarDobro"
                checked={aplicarDobro}
                onChange={(e) => setAplicarDobro(e.target.checked)}
                className="h-4 w-4 rounded"
              />
              <label htmlFor="aplicarDobro" className="ml-2 font-semibold text-sm">
                Aplicar Crédito em Dobro
              </label>
            </div>
          </div>
        </div>

        <div className="flex justify-end space-x-4 mt-6">
          <button
            onClick={onClose}
            className="btn-outline"
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            className="btn-themed"
          >
            Salvar e Mover
          </button>
        </div>
      </div>
    </div>
  );
};

/* ===================== KANBAN: CABEÇALHO/CARD FANTASMA/COLUNA ===================== */
const KanbanColumnHeader = ({ title, count, icon: Icon }) => (
  <div className="flex flex-col items-center justify-center mb-2 px-2 py-1 text-center">
    <div className="flex items-center justify-center gap-2">
      {Icon && <Icon className="opacity-70" size={18} />}
      <h3 className="font-bold text-[var(--fg)] text-sm uppercase tracking-wider">{title}</h3>
    </div>
    <span className="mt-1 text-xs font-mono panel-bg-50 text-[var(--fg)] rounded-full px-2 py-0.5">
      {count}
    </span>
  </div>
);

const ProcessoCardFantasma = ({ processo }) => (
  <div
    className="bg-[#282E33] p-3 rounded-lg border border-gray-500 shadow-2xl"
    style={{ transform: 'rotate(3deg)' }}
  >
    <p className="text-xs opacity-70">ID: {processo.id}</p>
    <p className="font-bold text-sm text-[var(--fg)] truncate">
      {extrair(processo.unidade_consumidora) || 'UC não definida'}
    </p>
  </div>
);

// Lazy render do card (não está sendo usado, mas deixei caso queira usar depois)
const LazyCard = ({ children }) => {
  const [visible, setVisible] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            setVisible(true);
            obs.disconnect();
          }
        });
      },
      { rootMargin: '200px 0px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div ref={ref}>
      {visible ? (
        children
      ) : (
        <div className="h-[140px] panel-bg-50 rounded-lg border panel-border animate-pulse" />
      )}
    </div>
  );
};

// Drag-and-drop helpers: draggable card and droppable column (admin only)
const DraggableProcesso = ({ id, disabled, children }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id, disabled });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={disabled ? '' : 'kanban-card-admin-draggable'}
      style={{ opacity: isDragging ? 0.5 : undefined }}
    >
      {children}
    </div>
  );
};

const DroppableColuna = ({ id, children }) => {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={isOver ? 'ring-2 ring-[var(--accent)] rounded-lg' : ''}>
      {children}
    </div>
  );
};

// Virtualized list
function VirtualList({
  className = '',
  items = [],
  itemHeight = 160,
  buffer = 5,
  renderItem,
  onRangeChange,
}) {
  const ref = React.useRef(null);
  const [state, setState] = React.useState({ start: 0, end: 0, viewport: 600 });

  const calc = React.useCallback(() => {
    const el = ref.current;
    const total = items.length;
    if (!el) return;
    const viewport = el.clientHeight || 600;
    const scrollTop = el.scrollTop || 0;
    let start = Math.floor(scrollTop / itemHeight) - buffer;
    if (start < 0) start = 0;
    let end = Math.ceil((scrollTop + viewport) / itemHeight) + buffer;
    if (end > total - 1) end = total - 1;
    setState({ start, end, viewport });
    if (typeof onRangeChange === 'function') onRangeChange(start, end);
  }, [items.length, itemHeight, buffer, onRangeChange]);

  React.useEffect(() => {
    calc();
  }, [items.length, calc]);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => calc();
    el.addEventListener('scroll', onScroll);
    const onResize = () => calc();
    window.addEventListener('resize', onResize);
    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, [calc]);

  const { start, end } = state;
  const visible = items.slice(start, end + 1);
  const padTop = start * itemHeight;
  const padBottom = Math.max(0, (items.length - (end + 1)) * itemHeight);

  return (
    <div ref={ref} className={`space-y-0 ${className}`}>
      <div style={{ paddingTop: padTop + 'px', paddingBottom: padBottom + 'px' }}>
        {visible.map((item, i) => (
          <div key={item.id} className="mb-2 flex justify-center">
            {renderItem(item, start + i)}
          </div>
        ))}
      </div>
    </div>
  );
}

const KanbanColumn = ({
  id,
  title,
  processos,
  icon,
  onCardClick,
  isDropDisabled,
  isAdmin,
  ensureMeta,
  metaMap,
}) => {
  const INITIAL_LIMIT = 15;
  const LOAD_STEP = 15;
  const [limit, setLimit] = useState(INITIAL_LIMIT);

  useEffect(() => {
    setLimit(INITIAL_LIMIT);
  }, [processos]);

  const lista = Array.isArray(processos) ? processos : [];
  const visiveis = lista.slice(0, limit);
  const hasMore = lista.length > limit;

  return (
    <div
      className={`rounded-xl p-2 flex-shrink-0 flex flex-col transition-opacity panel-bg-50 border panel-border ${
        isDropDisabled ? 'opacity-50' : ''
      }`}
      style={{ width: '570px' }}
    >
      <KanbanColumnHeader title={title} count={lista.length} icon={icon} />
      <SortableContext items={visiveis.map((p) => p.id)}>
        <DroppableColuna id={id}>
          <VirtualList
            className="min-h-[400px] p-1 overflow-y-auto flex-grow mt-2 panel-bg-80 backdrop-blur-sm rounded-lg border panel-border w-[560px] mx-auto"
            items={visiveis}
            itemHeight={240}
            buffer={6}
            onRangeChange={(start, end) => {
              try {
                const ids = visiveis
                  .slice(start, Math.min(end + 1, visiveis.length))
                  .map((p) => p.id)
                  .filter(Boolean);
                ensureMeta && ensureMeta(ids);
              } catch {
                /* silent */
              }
            }}
            renderItem={(proc) => (
              <DraggableProcesso id={proc.id} disabled={!isAdmin}>
                <div className="w-[560px]">
                  <ProcessoCard
                    processo={proc}
                    meta={metaMap && metaMap[String(proc.id)]}
                    onClick={onCardClick}
                  />
                </div>
              </DraggableProcesso>
            )}
          />
          {hasMore && (
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => {
                  const prev = limit;
                  const next = limit + LOAD_STEP;
                  try {
                    const newIds = lista.slice(prev, next).map((p) => p.id).filter(Boolean);
                    ensureMeta && ensureMeta(newIds);
                  } catch {
                    /* silent */
                  }
                  setLimit(next);
                }}
                className="flex-1 py-2 text-sm text-[var(--accent)] panel-bg-60 hover:opacity-90 rounded-lg border panel-border flex items-center justify-center gap-1"
              >
                Carregar mais <ChevronDown size={14} />
              </button>
              <button
                onClick={() => setLimit(lista.length)}
                className="flex-1 py-2 text-sm text-[var(--fg)] panel-bg-60 hover:opacity-90 rounded-lg border panel-border"
                title="Mostrar todos os cards desta coluna"
              >
                Mostrar todos
              </button>
            </div>
          )}
        </DroppableColuna>
      </SortableContext>
    </div>
  );
};

/* ===================== PÁGINA PRINCIPAL ===================== */
const ControleProcessos = () => {
  const navigate = useNavigate();
  const [colunas, setColunas] = useState(null);
  const [allTags, setAllTags] = useState([]);
  const [processoParaEditarTags, setProcessoParaEditarTags] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [metaMap, setMetaMap] = useState({});
  const [historyMatches, setHistoryMatches] = useState(new Set()); // IDs com match no histórico
  const [historySearch, setHistorySearch] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState('');
  const [isModalDeferimentoAberto, setIsModalDeferimentoAberto] = useState(false);
  const [movimentacaoPendente, setMovimentacaoPendente] = useState(null);
  const [activeProcesso, setActiveProcesso] = useState(null);
  // Layout fixo: cards 560x240 (sem grid alternativo)

  const ensureMetaBatch = React.useCallback(
    async (ids) => {
      try {
        const missing = (ids || [])
          .map((x) => String(x))
          .filter((x) => !(x in metaMap));
        if (missing.length === 0) return;
        const metas = await getProcessosCardsMeta(missing);
        if (Array.isArray(metas) && metas.length) {
          setMetaMap((prev) => {
            const next = { ...prev };
            for (const m of metas) {
              if (m && m.id != null) next[String(m.id)] = m;
            }
            return next;
          });
        }
      } catch {
        /* silent */
      }
    },
    [metaMap]
  );

  // Filtros básicos
  const [filtroCliente, setFiltroCliente] = useState('');
  const [filtroRelevancia, setFiltroRelevancia] = useState('todos');
  const [searchTerm, setSearchTerm] = useState('');
  useEffect(() => {
    setHistorySearch(searchTerm);
  }, [searchTerm]);

  // Avançados
  const [showFilters, setShowFilters] = useState(false);
  const [showSearch, setShowSearch] = useState(true);
  const [filtroDataIni, setFiltroDataIni] = useState('');
  const [filtroDataFim, setFiltroDataFim] = useState('');
  const [filtroEtapa, setFiltroEtapa] = useState('');
  const [filtroSubEtapa, setFiltroSubEtapa] = useState('');
  const [filtroUC, setFiltroUC] = useState('');
  const [filtroId, setFiltroId] = useState('');
  const [filtroValorMin, setFiltroValorMin] = useState('');
  const [filtroValorMax, setFiltroValorMax] = useState('');
  const [sortField, setSortField] = useState('data'); // data | id | valor
  const [sortDir, setSortDir] = useState('desc'); // asc | desc
  const [filtroConcessionaria, setFiltroConcessionaria] = useState('');
  const [filtroSuspenso, setFiltroSuspenso] = useState(false);
  const [showSuspensos, setShowSuspensos] = useState(false);

  // Defer input (evita lag digitando)
  const deferredSearch = useDeferredValue(searchTerm);
  const deferredHistorySearch = useDeferredValue(historySearch);
  const debouncedCliente = useDebounced(filtroCliente, 250);
  const debouncedUC = useDebounced(filtroUC, 250);
  const debouncedId = useDebounced(filtroId, 250);
  const debouncedSub = useDebounced(filtroSubEtapa, 250);
  const debouncedValorMin = useDebounced(filtroValorMin, 250);
  const debouncedValorMax = useDebounced(filtroValorMax, 250);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 10 } })
  );

  // Modal de confirmação p/ demais movimentos
  const [moveOpen, setMoveOpen] = useState(false);
  const [pendingMove, setPendingMove] = useState({ id: null, destino: '', etapa: '' });
  const [moveComment, setMoveComment] = useState('');
  const [moveChannels, setMoveChannels] = useState('');
  const [moveStatus, setMoveStatus] = useState('');
  const [moveColuna, setMoveColuna] = useState('');
  const [toast, setToast] = useState('');
  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  // Etapas/Subetapas para escolha do destino
  const [etapas, setEtapas] = useState([]);
  const [etapaSubMap, setEtapaSubMap] = useState({});
  const [destinoEtapa, setDestinoEtapa] = useState('');
  const [destinoSub, setDestinoSub] = useState('');
  useEffect(() => {
    (async () => {
      try {
        setEtapas(await getEtapas());
        setEtapaSubMap(await getEtapaSubMap());
      } catch {
        /* silent */
      }
    })();
  }, []);

  const { user } = useAuth();
  const isAdmin = String(user?.tipo_conta || '').toLowerCase() === 'admin';

  const fmtData = (val) => {
    if (!val) return '';
    const d = val instanceof Date ? val : new Date(val);
    if (Number.isNaN(d.getTime())) return String(val);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;
  };

  // Atenção: a última coluna é "Indeferidos" (plural) para bater com o backend
  const { ordemColunas, mapaColunasParaEtapas, mapaIconesColunas } = useMemo(
    () => ({
      ordemColunas: [
        'Ativos',
        'Deferidos',
        'Fluxo de Ressarcimento',
        'Faturamento',
        'Concluídos',
        'Indeferidos',
        'Suspensos',
      ],
      mapaColunasParaEtapas: {
        Ativos: 'Andamento',
        Deferidos: 'Pendente',
        'Fluxo de Ressarcimento': 'Validação',
        Faturamento: 'Ressarcimento',
        Concluídos: 'Concluídos',
        Indeferidos: 'Indeferido',
        Suspensos: 'Suspenso',
      },
      mapaIconesColunas: {
        Ativos: Activity,
        Deferidos: ThumbsUp,
        'Fluxo de Ressarcimento': DollarSign,
        Faturamento: DollarSign,
        Concluídos: CheckCircle,
        Indeferidos: ThumbsDown,
        Suspensos: PauseCircle,
      },
    }),
    []
  );
  const ordemColunasVisiveis = useMemo(
    () => ordemColunas.filter((col) => col !== 'Suspensos'),
    [ordemColunas],
  );

  // Carregar base
  const carregarDados = useCallback(async () => {
    try {
      setIsLoading(true);
      setError('');

      const [kanbanData, tagsData, prazosCfg, alarmesCfg] = await Promise.all([
        getProcessosKanban(),
        getAllTags(),
        getPrazos().catch(() => ({ kanban: [], etapas: [] })),
        getAlarmes().catch(() => []),
      ]);

      const baseColunas = {};
      const payload = kanbanData.colunas || {};

      // Normaliza chaves do backend para o conjunto esperado no front
      const normalizeKey = (k) => {
        const s = String(k || '').trim();
        if (!s) return s;
        if (s === 'Indeferido') return 'Indeferidos';
        // qualquer variação "Conclu..." vira "Concluídos"
        if (s.toLowerCase().startsWith('conclu')) return 'Concluídos';
        return s;
      };

      const allKeys = Array.from(
        new Set([...ordemColunas, ...Object.keys(payload).map(normalizeKey)])
      );

      allKeys.forEach((col) => {
        const raw =
          payload[col] ||
          payload[Object.keys(payload).find((k) => normalizeKey(k) === col)] ||
          [];
        const lista = raw || [];
        baseColunas[col] = lista.map((p) => {
          const __ultimaDataRaw = p.data_ultima_movimentacao || p.ultima_atualizacao || null;
          const __ultimaData = __ultimaDataRaw ? new Date(__ultimaDataRaw) : null;
        const __valor =
          typeof p.valor_estimado === 'number'
            ? p.valor_estimado
            : toNumberOrNull(
                p.valor_estimado?.Float64 ??
                  p.valor_estimado ??
                  p.ressarcimento_estimado?.Float64 ??
                  p.ressarcimento_estimado ??
                  null
              );
          return {
            ...p,
            __ultimaData,
            __subetapa: extrair(p.sub_etapa) || '',
            __cliente: extrair(p.cliente) || extrair(p.nome_cliente) || '',
            __uc:
              extrair(p.uc) ||
              extrair(p.unidade_consumidora) ||
              extrair(p.unidade) ||
              extrair(p.UC) ||
              '',
            __concessionaria: extrair(p.concessionaria) || extrair(p.concessionaria_sigla) || '',
            __valor,
            __id: p.id,
            __etapa: extrair(p.etapa) || col,
            __relevancia: !!p.relevancia,
            __suspenso: !!p.suspenso,
          };
        });
      });

      setColunas(baseColunas);

      // Buscar meta em lote para os primeiros itens de cada coluna (acelera cards)
      try {
        const ids = [];
        const TAKE = 30;
        for (const nome of ordemColunas) {
          const arr = (baseColunas[nome] || []).slice(0, TAKE);
          for (const p of arr) {
            const id = p?.id ?? p?.__id;
            if (id != null) ids.push(id);
          }
        }
        const metas = await getProcessosCardsMeta(ids);
        const map = {};
        for (const m of metas || []) {
          if (m && m.id != null) map[String(m.id)] = m;
        }
        setMetaMap(map);
      } catch {
        /* silent */
      }

      setAllTags(tagsData || []);
    } catch (err) {
      console.error('Erro ao carregar dados da página', err);
      setError(
        'Não foi possível carregar os dados do quadro. Verifique o console para mais detalhes.'
      );
    } finally {
      setIsLoading(false);
    }
  }, [ordemColunas]);

  useEffect(() => {
    carregarDados();
  }, [carregarDados]);

  // opções de etapa (vazio se não veio no payload; ok)
  const opcoesEtapa = useMemo(() => {
    if (!colunas) return [];
    const set = new Set();
    Object.values(colunas).forEach((arr) => {
      arr.forEach((p) => {
        if (p.__etapa) set.add(p.__etapa);
      });
    });
    return Array.from(set).sort();
  }, [colunas]);

  // Busca completa em histórico: varre todos os processos carregados no quadro e marca IDs com match
  useEffect(() => {
    const q = String(deferredSearch || '').trim();
    if (!q) {
      setHistoryMatches(new Set());
      setHistoryLoading(false);
      return;
    }
    let canceled = false;
    (async () => {
      try {
        setHistoryLoading(true);
        const data = await searchGlobalHistorico(q, 500, 0);
        const hits = new Set();
        const arr = Array.isArray(data?.results) ? data.results : [];
        for (const it of arr) {
          const pid = String(it?.processo_id ?? it?.ProcessoID ?? '');
          if (pid) hits.add(pid);
        }
        if (!canceled) setHistoryMatches(hits);
      } catch {
        if (!canceled) setHistoryMatches(new Set());
      } finally {
        if (!canceled) setHistoryLoading(false);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [deferredSearch]);

  // Normalização simples para busca (case/acentos)
  const norm = (v) => {
    try {
      return String(v || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    } catch {
      return String(v || '').toLowerCase();
    }
  };

  // Filtros + Ordenação
  const colunasFiltradas = useMemo(() => {
    if (!colunas) return null;

    const start = filtroDataIni ? new Date(filtroDataIni + 'T00:00:00') : null;
    const end = filtroDataFim ? new Date(filtroDataFim + 'T23:59:59') : null;

    const valorMin = debouncedValorMin !== '' ? Number(debouncedValorMin) : null;
    const valorMax = debouncedValorMax !== '' ? Number(debouncedValorMax) : null;

    const filtra = (proc) => {
      const nomeCliente = proc.__cliente || '';
      const uc = proc.__uc || '';
      const idStr = String(proc.__id || '');

      let searchOk = true;
      if (deferredSearch && String(deferredSearch).trim() !== '') {
        const q = norm(deferredSearch);
        const hay = [
          proc.__cliente,
          proc.__uc,
          proc.__concessionaria,
          proc.__etapa,
          proc.__subetapa,
          proc.status,
          proc.etapa,
          proc.sub_etapa,
          idStr,
        ]
          .map(norm)
          .join(' ● ');
        searchOk = hay.includes(q);
        if (!searchOk) {
          const mid = String(proc?.id ?? proc?.__id ?? '');
          const meta = mid ? metaMap[mid] : null;
          const ultimoComent = norm(meta?.ultima_mov?.comentario || '');
          if (ultimoComent && ultimoComent.includes(q)) searchOk = true;
          if (historyMatches.has(String(proc.__id || proc.id))) searchOk = true;
        }
      }

      // Se o campo de histórico estiver preenchido, restringe aos hits do histórico (hoje desativado)
      if (false && String(deferredHistorySearch || '').trim() !== '') {
        if (!historyMatches.has(String(proc.__id || proc.id))) return false;
      }

      const clienteOk = !debouncedCliente || norm(nomeCliente).includes(norm(debouncedCliente));
      const ucOk = !debouncedUC || norm(uc).includes(norm(debouncedUC));
      const idOk = !debouncedId || idStr.includes(String(debouncedId));

      const relOk =
        filtroRelevancia === 'todos' ||
        (filtroRelevancia === 'relevante' && proc.__relevancia) ||
        (filtroRelevancia === 'no_relevante' && !proc.__relevancia);

      const etapaOk =
        !filtroEtapa || norm(proc.__etapa || proc.etapa).includes(norm(filtroEtapa));
      const subOk =
        !debouncedSub ||
        norm(proc.__subetapa || proc.sub_etapa).includes(norm(debouncedSub));
      const concOk =
        !filtroConcessionaria ||
        norm(proc.__concessionaria || '').includes(norm(filtroConcessionaria));
      const suspOk = !filtroSuspenso || !!proc.__suspenso;

      const dataOk = (() => {
        if (!start && !end) return true;
        const d = proc.__ultimaData;
        if (!d) return false;
        if (start && d < start) return false;
        if (end && d > end) return false;
        return true;
      })();

      const valorOk = (() => {
        if (valorMin === null && valorMax === null) return true;
        const v = proc.__valor;
        if (v === null) return false;
        if (valorMin !== null && v < valorMin) return false;
        if (valorMax !== null && v > valorMax) return false;
        return true;
      })();

      return (
        searchOk &&
        clienteOk &&
        ucOk &&
        idOk &&
        relOk &&
        etapaOk &&
        subOk &&
        concOk &&
        suspOk &&
        dataOk &&
        valorOk
      );
    };

    const cmp = (a, b) => {
      if (sortField === 'data') {
        const da = a.__ultimaData ? a.__ultimaData.getTime() : -Infinity;
        const db = b.__ultimaData ? b.__ultimaData.getTime() : -Infinity;
        return sortDir === 'asc' ? da - db : db - da;
      }
      if (sortField === 'valor') {
        const va = a.__valor ?? -Infinity;
        const vb = b.__valor ?? -Infinity;
        return sortDir === 'asc' ? va - vb : vb - va;
      }
      const ia = Number(a.__id) || 0;
      const ib = Number(b.__id) || 0;
      return sortDir === 'asc' ? ia - ib : ib - ia;
    };

    const novasColunas = {};
    for (const nomeColuna in colunas) {
      const arr = colunas[nomeColuna];
      const f = arr.filter(filtra);
      f.sort(cmp);
      novasColunas[nomeColuna] = f;
    }
    return novasColunas;
  }, [
    colunas,
    deferredSearch,
    debouncedCliente,
    debouncedUC,
    debouncedId,
    filtroRelevancia,
    filtroEtapa,
    debouncedSub,
    filtroDataIni,
    filtroDataFim,
    debouncedValorMin,
    debouncedValorMax,
    sortField,
    sortDir,
    filtroConcessionaria,
    filtroSuspenso,
    metaMap,
    historyMatches,
  ]);

  const suspensosLista = useMemo(() => {
    if (!colunas) return [];
    const arr = [];
    Object.entries(colunas).forEach(([col, itens]) => {
      (itens || []).forEach((p) => {
        if (p && (p.__suspenso || p.suspenso)) {
          arr.push({ ...p, __coluna: col });
        }
      });
    });
    return arr.sort((a, b) => {
      const da = a.__ultimaData ? a.__ultimaData.getTime() : 0;
      const db = b.__ultimaData ? b.__ultimaData.getTime() : 0;
      return db - da;
    });
  }, [colunas]);

  const findContainer = useCallback(
    (id) => {
      if (!colunas) return null;
      if (id in colunas) return id;
      return Object.keys(colunas).find((key) => colunas[key].some((p) => p.id === id));
    },
    [colunas]
  );

  const handleDragStart = (event) => {
    if (!isAdmin) return;
    const { active } = event;
    const container = findContainer(active.id);
    if (!container || !colunas) return;
    const processo = colunas[container].find((p) => p.id === active.id);
    setActiveProcesso(processo);
  };

  const handleDragEnd = async (event) => {
    const { active, over } = event;
    setActiveProcesso(null);
    if (!over) return;

    const colunaOrigem = findContainer(active.id);
    const colunaDestino = findContainer(over.id) || over.id;

    const indexOrigem = ordemColunas.indexOf(colunaOrigem);
    const indexDestino = ordemColunas.indexOf(colunaDestino);

    if (!isAdmin && indexDestino < indexOrigem) {
      alert("N?o ? permitido mover um card para uma coluna anterior.");
      return;
    }
    const processoMovido = colunas?.[colunaOrigem]?.find((p) => p.id === active.id);
    if (!processoMovido) return;

    const novaEtapa = mapaColunasParaEtapas[colunaDestino];
    if (!novaEtapa && colunaDestino !== 'Suspensos') {
      alert(`Movimenta??o para "${colunaDestino}" n?o ? permitida.`);
      return;
    }

    try {
      if (colunaDestino === 'Suspensos') {
        await suspenderProcesso(processoMovido.id, 'Suspenso via kanban');
      } else {
        if (colunaOrigem === 'Suspensos') {
          await retomarProcesso(processoMovido.id, 'Retomado via kanban');
        }
        const fd = new FormData();
        fd.append('etapa_atual', novaEtapa);
        const subEtapaAtual = extrair(processoMovido.sub_etapa);
        if (subEtapaAtual) fd.append('sub_etapa', subEtapaAtual);
        fd.append('comentario', 'Movimentado via kanban');
        await movimentarProcesso(processoMovido.id, fd);
      }
      carregarDados();
    } catch (err) {
      alert('Erro ao mover o processo.');
    }
  };

  const handleSalvarDeferimento = async (comentario, dadosDeferimento) => {
    if (!movimentacaoPendente) return;
    const { processo, novaEtapa } = movimentacaoPendente;

    const formData = new FormData();
    formData.append('etapa_atual', novaEtapa);
    formData.append('comentario', comentario);

    // Canais de comunicação (opcional)
    const canaisStr = prompt(
      `Informe canais de comunicação (whatsapp, ligacao, email, sms) separados por vírgula:
Deixe em branco para não registrar.`
    );
    if (canaisStr && canaisStr.trim() !== '') {
      const canais = canaisStr
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => ['whatsapp', 'ligacao', 'email', 'sms'].includes(s));
      if (canais.length > 0) formData.append('canais', JSON.stringify(canais));
    }

    // (Se quiser enviar os dados do deferimento ao backend, acrescente aqui:)
    // formData.append('deferimento', JSON.stringify(dadosDeferimento));

    try {
      await movimentarProcesso(processo.id, formData);
      setIsModalDeferimentoAberto(false);
      setMovimentacaoPendente(null);
      carregarDados();
    } catch (error) {
      alert('Erro ao salvar a movimentação e os dados de deferimento.');
    }
  };

  const handleSaveTags = async (processoId, tagIds) => {
    try {
      await updateProcessoTags(processoId, tagIds);
      setProcessoParaEditarTags(null);
      carregarDados();
    } catch (error) {
      alert('Erro ao salvar as tags.');
    }
  };

  const handleTagCreated = (novaTag) => setAllTags((prev) => [...prev, novaTag]);

  const handleCardClick = (processo) => {
    const pid = processo.id || processo.processo_id || processo.requisicao_id;
    if (!pid) return alert('ID do processo não encontrado.');
    navigate(`/processos/${pid}`);
  };

  const limparFiltros = () => {
    setSearchTerm('');
    setFiltroCliente('');
    setFiltroUC('');
    setFiltroId('');
    setFiltroRelevancia('todos');
    setFiltroEtapa('');
    setFiltroSubEtapa('');
    setFiltroDataIni('');
    setFiltroDataFim('');
    setFiltroValorMin('');
    setFiltroValorMax('');
    setSortField('data');
    setSortDir('desc');
    setFiltroConcessionaria('');
    setFiltroSuspenso(false);
  };

  const limparTudo = () => {
    limparFiltros();
    setHistorySearch('');
    setHistoryMatches(new Set());
  };

  if (isLoading) {
    return (
      <div className="p-4 md:p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[
            'Ativos',
            'Deferidos',
            'Fluxo de Ressarcimento',
            'Faturamento',
            'Concluídos',
            'Indeferidos',
          ].map((col, i) => (
            <div key={i} className="rounded-lg border panel-border panel-bg-60 p-3">
              <div className="mb-3 flex items-center gap-2">
                <SkeletonLine width="40%" />
              </div>
              <div className="space-y-2">
                {[0, 1, 2].map((j) => (
                  <div key={j} className="glass-card rounded-lg border p-3">
                    <SkeletonLine width="60%" />
                    <div className="mt-2">
                      <SkeletonLine width="40%" />
                    </div>
                    <div className="mt-2">
                      <SkeletonLine width="80%" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-center text-red-400">
        <p>{error}</p>
        <button
          onClick={carregarDados}
          className="mt-4 px-4 py-2 bg-[var(--accent)] text-[var(--fg)] rounded hover:opacity-90"
        >
          Tentar Novamente
        </button>
      </div>
    );
  }

  const activeColumnIndex = activeProcesso
    ? ordemColunas.indexOf(findContainer(activeProcesso.id))
    : -1;

  return (
    <>
      <div className="processos-azul w-full max-w-full mx-auto px-3 sm:px-4 lg:px-6 xl:px-8 py-6 lg:py-10 min-h-screen">
        <div
          className="mb-4 lg:mb-6 mt-2 rounded-xl shadow-elevated p-4 border-2 sticky top-0 z-40"
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 40,
            background: 'var(--header-bg)',
            borderColor: 'var(--header-border)',
            color: 'var(--header-fg)',
          }}
        >
          <h1 className="text-2xl lg:text-3xl font-extrabold flex items-center justify-center gap-3 text-center">
            <FolderKanban size={26} className="hidden sm:block" />
            Controle de Processos
          </h1>

          <div className="mt-3 flex items-center justify-center gap-2">
            <button
              onClick={() => setShowSearch((s) => !s)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border panel-border panel-bg-60 hover:opacity-90 text-[var(--header-fg)] transition-smooth"
              title="Mostrar/ocultar busca"
            >
              <Activity size={16} />
              Pesquisar
            </button>
            <button
              onClick={() => setShowFilters((s) => !s)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border panel-border panel-bg-60 hover:opacity-90 text-[var(--header-fg)] transition-smooth"
              title="Mostrar/ocultar filtros avançados"
            >
              <Filter size={16} />
              Filtros
            </button>
            <button
              onClick={limparTudo}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border panel-border panel-bg-60 hover:opacity-90 text-[var(--header-fg)] transition-smooth"
              title="Limpar todas as buscas e filtros"
            >
              <RefreshCcw size={16} />
              Limpar Tudo
            </button>
            <button
              onClick={() => setShowSuspensos(true)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border panel-border panel-bg-60 hover:opacity-90 text-[var(--header-fg)] transition-smooth"
              title="Ver processos suspensos"
            >
              <PauseCircle size={16} />
              Suspensos ({suspensosLista.length})
            </button>
          </div>

          {showSearch && (
            <div className="mt-3 flex col items-center justify-center gap-2">
              <input
                type="text"
                placeholder="Pesquisar (Cliente, UC, ID, status, etapa, sub-etapa, concessionária, histórico)"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full sm:w-[480px] px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              />
              {!!String(searchTerm || '').trim() && (
                <div className="w-full sm:w-[480px] text-xs opacity-80 mt-1 flex items-center justify-between">
                  {historyLoading ? (
                    <span>Buscando em históricos...</span>
                  ) : (
                    <span>Históricos encontrados: {historyMatches.size}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setSearchTerm('');
                      setHistoryMatches(new Set());
                    }}
                    className="px-2 py-0.5 rounded border panel-border panel-bg-60 hover:opacity-90"
                    title="Limpar busca"
                  >
                    Limpar
                  </button>
                </div>
              )}

              {false && (
                <div className="w-full sm:w-[480px]">
                  <input
                    type="text"
                    placeholder="Pesquisar em TODOS os históricos (ex.: número de protocolo)"
                    value={historySearch}
                    onChange={(e) => setHistorySearch(e.target.value)}
                    className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                  />
                  {historyLoading ? (
                    <div className="text-xs opacity-70 mt-1">Buscando em históricos...</div>
                  ) : (
                    !!String(historySearch || '').trim() && (
                      <div className="text-xs opacity-80 mt-1 flex items-center justify-between">
                        <span>Encontrados: {historyMatches.size}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setHistorySearch('');
                            setHistoryMatches(new Set());
                          }}
                          className="px-2 py-0.5 rounded border panel-border panel-bg-60 hover:opacity-90"
                          title="Limpar busca de históricos"
                        >
                          Limpar
                        </button>
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal de movimentação geral */}
        {moveOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
            <div className="w-full max-w-md bg-[var(--panel)] text-[var(--fg)] border border-[var(--panel-border)] rounded-lg shadow-lg p-4">
              <h2 className="text-lg font-semibold mb-2">Mover processo</h2>
              <p className="text-sm opacity-80 mb-3">Defina o destino e confirme:</p>
              <div className="text-sm mb-3">
                <div>
                  <strong>ID:</strong> #{pendingMove.id}
                </div>
                <div>
                  <strong>Coluna destino:</strong> {pendingMove.destino}
                </div>
              </div>

              <div className="mb-3">
                <label className="block text-sm font-medium mb-1">Status da Requisição</label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setMoveStatus('Pendente')}
                    className={`px-2 py-1 rounded border ${
                      moveStatus === 'Pendente'
                        ? 'bg-[var(--accent)] text-[var(--fg)]'
                        : 'border-[var(--panel-border)]'
                    }`}
                  >
                    Pendente
                  </button>
                  <button
                    type="button"
                    onClick={() => setMoveStatus('Em Análise')}
                    className={`px-2 py-1 rounded border ${
                      moveStatus === 'Em Análise'
                        ? 'bg-[var(--accent)] text-[var(--fg)]'
                        : 'border-[var(--panel-border)]'
                    }`}
                  >
                    Em Análise
                  </button>
                  <button
                    type="button"
                    onClick={() => setMoveStatus('Aprovado')}
                    className={`px-2 py-1 rounded border ${
                      moveStatus === 'Aprovado'
                        ? 'bg-[var(--accent)] text-[var(--fg)]'
                        : 'border-[var(--panel-border)]'
                    }`}
                  >
                    Aprovado
                  </button>
                  <button
                    type="button"
                    onClick={() => setMoveStatus('Rejeitado')}
                    className={`px-2 py-1 rounded border ${
                      moveStatus === 'Rejeitado'
                        ? 'bg-[var(--accent)] text-[var(--fg)]'
                        : 'border-[var(--panel-border)]'
                    }`}
                  >
                    Rejeitado
                  </button>
                </div>
              </div>

              <div className="mb-3">
                <label className="block text-sm font-medium mb-1">Coluna do processo</label>
                <div className="flex flex-wrap gap-2">
                  {[
                    'Ativos',
                    'Deferidos',
                    'Fluxo de Ressarcimento',
                    'Faturamento',
                    'Concluídos',
                    'Indeferidos',
                  ].map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => {
                        setMoveColuna(c);
                        const e = mapaColunasParaEtapas[c];
                        if (e) setDestinoEtapa(e);
                      }}
                      className={`px-2 py-1 rounded border ${
                        moveColuna === c
                          ? 'bg-[var(--accent)] text-[var(--fg)]'
                          : 'border-[var(--panel-border)]'
                      }`}
                    >
                      {c.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mb-3">
                <label className="block text-sm font-medium mb-1">Etapa</label>
                <select
                  value={destinoEtapa}
                  onChange={(e) => {
                    setDestinoEtapa(e.target.value);
                    setDestinoSub('');
                  }}
                  className="w-full p-2 rounded-md border border-[var(--panel-border)] bg-transparent mb-2"
                >
                  <option value="">(usar padrão da coluna)</option>
                  {etapas.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>

                <label className="block text-sm font-medium mb-1">Sub-etapa</label>
                <select
                  value={destinoSub}
                  onChange={(e) => setDestinoSub(e.target.value)}
                  className="w-full p-2 rounded-md border border-[var(--panel-border)] bg-transparent"
                >
                  <option value="">(opcional)</option>
                  {(etapaSubMap?.[destinoEtapa || pendingMove.etapa || ''] || []).map((s, i) => (
                    <option key={i} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mb-3">
                <label className="block text-sm font-medium mb-1">
                  Canais de comunicação (opcional)
                </label>
                <input
                  type="text"
                  value={moveChannels}
                  onChange={(e) => setMoveChannels(e.target.value)}
                  placeholder="whatsapp, ligacao, email, sms"
                  className="w-full p-2 rounded-md border border-[var(--panel-border)] bg-transparent"
                />
              </div>

              <label className="block text-sm font-medium mb-1">Comentário</label>
              <textarea
                value={moveComment}
                onChange={(e) => setMoveComment(e.target.value)}
                rows={3}
                className="w-full p-2 rounded-md border border-[var(--panel-border)] bg-transparent focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                placeholder="Escreva um comentário para o histórico..."
              />

              <div className="mt-4 flex gap-2 justify-end">
                <button
                  onClick={() => setMoveOpen(false)}
                  className="px-3 py-2 rounded-md border border-[var(--panel-border)] hover:bg-[var(--panel-border)]/20"
                >
                  Cancelar
                </button>
                <button
                  onClick={async () => {
                    const etapaFinal = destinoEtapa || pendingMove.etapa || '';
                    if (!etapaFinal) {
                      alert('Selecione uma etapa ou deixe o padrão da coluna.');
                      return;
                    }
                    const fd = new FormData();
                    fd.append('etapa_atual', etapaFinal);
                    if (destinoSub) fd.append('sub_etapa', destinoSub);
                    fd.append('comentario', moveComment || 'Movimentado via controle de processos');
                    if (moveChannels && moveChannels.trim() !== '') {
                      const canais = moveChannels
                        .split(',')
                        .map((s) => s.trim().toLowerCase())
                        .filter((s) => ['whatsapp', 'ligacao', 'email', 'sms'].includes(s));
                      if (canais.length > 0) fd.append('canais', JSON.stringify(canais));
                    }
                    try {
                      await movimentarProcesso(pendingMove.id, fd);
                      setMoveOpen(false);
                      setPendingMove({ id: null, destino: '', etapa: '' });
                      setMoveComment('');
                      setMoveChannels('');
                      setDestinoSub('');
                      carregarDados();
                    } catch (err) {
                      alert('Erro ao salvar a movimentação.');
                    }
                  }}
                  className="px-3 py-2 rounded-md bg-[var(--accent)] text-[var(--fg)]"
                >
                  Confirmar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Painel de Filtros Avançados */}
        {showFilters && (
          <div className="mb-6 p-3 lg:p-4 bg-[var(--panel-processos)]/40 border panel-border rounded-xl">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs opacity-70 mb-1">
                  Data da última movimentação (início)
                </label>
                <input
                  type="date"
                  value={filtroDataIni}
                  onChange={(e) => setFiltroDataIni(e.target.value)}
                  className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
                />
              </div>

              <div>
                <label className="block text-xs opacity-70 mb-1">
                  Data da última movimentação (fim)
                </label>
                <input
                  type="date"
                  value={filtroDataFim}
                  onChange={(e) => setFiltroDataFim(e.target.value)}
                  className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
                />
              </div>

              <div>
                <label className="block text-xs opacity-70 mb-1">Etapa</label>
                <select
                  value={filtroEtapa}
                  onChange={(e) => setFiltroEtapa(e.target.value)}
                  className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
                >
                  <option value="">Todas</option>
                  {opcoesEtapa.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs opacity-70 mb-1">Sub-etapa</label>
                <select
                  value={filtroSubEtapa}
                  onChange={(e) => setFiltroSubEtapa(e.target.value)}
                  className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
                  disabled={!filtroEtapa}
                >
                  <option value="">{filtroEtapa ? 'Todas' : 'Selecione uma etapa'}</option>
                  {(etapaSubMap?.[filtroEtapa] || []).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs opacity-70 mb-1">Concessionária</label>
                <input
                  type="text"
                  placeholder="ex.: ENEL"
                  value={filtroConcessionaria}
                  onChange={(e) => setFiltroConcessionaria(e.target.value)}
                  className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
                />
              </div>

              <div className="flex items-center gap-2 mt-6">
                <input
                  id="flt-susp"
                  type="checkbox"
                  checked={filtroSuspenso}
                  onChange={(e) => setFiltroSuspenso(e.target.checked)}
                />
                <label htmlFor="flt-susp" className="text-xs opacity-70">
                  Somente suspensos
                </label>
              </div>

              <div>
                <label className="block text-xs opacity-70 mb-1">Cliente</label>
                <input
                  type="text"
                  value={filtroCliente}
                  onChange={(e) => setFiltroCliente(e.target.value)}
                  className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
                />
              </div>

              <div>
                <label className="block text-xs opacity-70 mb-1">UC</label>
                <input
                  type="text"
                  value={filtroUC}
                  onChange={(e) => setFiltroUC(e.target.value)}
                  className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
                />
              </div>

              <div>
                <label className="block text-xs opacity-70 mb-1">ID</label>
                <input
                  type="text"
                  value={filtroId}
                  onChange={(e) => setFiltroId(e.target.value)}
                  className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
                />
              </div>

              <div>
                <label className="block text-xs opacity-70 mb-1">Relevância</label>
                <select
                  value={filtroRelevancia}
                  onChange={(e) => setFiltroRelevancia(e.target.value)}
                  className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
                >
                  <option value="todos">Todos</option>
                  <option value="relevante">Relevante</option>
                  <option value="no_relevante">Não relevante</option>
                </select>
              </div>

              <div>
                <label className="block text-xs opacity-70 mb-1">Valor (mín.)</label>
                <input
                  type="number"
                  step="0.01"
                  value={filtroValorMin}
                  onChange={(e) => setFiltroValorMin(e.target.value)}
                  className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
                  placeholder="0.00"
                />
              </div>

              <div>
                <label className="block text-xs opacity-70 mb-1">Valor (máx.)</label>
                <input
                  type="number"
                  step="0.01"
                  value={filtroValorMax}
                  onChange={(e) => setFiltroValorMax(e.target.value)}
                  className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
                  placeholder="999999.99"
                />
              </div>

              <div>
                <label className="block text-xs opacity-70 mb-1">Ordenar por</label>
                <select
                  value={sortField}
                  onChange={(e) => setSortField(e.target.value)}
                  className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
                >
                  <option value="data">Última movimentação</option>
                  <option value="id">ID</option>
                  <option value="valor">Valor</option>
                </select>
              </div>

              <div>
                <label className="block text-xs opacity-70 mb-1">Direção</label>
                <select
                  value={sortDir}
                  onChange={(e) => setSortDir(e.target.value)}
                  className="w-full px-3 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
                >
                  <option value="desc">Descendente</option>
                  <option value="asc">Crescente</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {/* Quadro Kanban */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="kanban-board flex gap-3 lg:gap-4 overflow-x-auto pb-3 lg:pb-4">
            {colunasFiltradas &&
              ordemColunasVisiveis.map((columnId, index) => (
                <KanbanColumn
                  ensureMeta={ensureMetaBatch}
                  metaMap={metaMap}
                  key={columnId}
                  id={columnId}
                  title={columnId}
                  processos={colunasFiltradas[columnId] || []}
                  icon={mapaIconesColunas[columnId]}
                  onCardClick={handleCardClick}
                  isDropDisabled={
                    isAdmin ? false : activeProcesso ? index < activeColumnIndex : false
                  }
                  isAdmin={isAdmin}
                />
              ))}
          </div>

          <DragOverlay>
            {activeProcesso ? (
              <div className="w-[560px]">
                <ProcessoCardFantasma processo={activeProcesso} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>

        {showSuspensos &&
          createPortal(
            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-center justify-center px-4">
              <div className="bg-[var(--panel)] border border-[var(--panel-border)] rounded-xl shadow-2xl w-full max-w-5xl max-h-[88vh] overflow-hidden animate-fade-in-fast">
                <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--panel-border)]">
                  <div className="flex items-center gap-2">
                    <PauseCircle size={18} />
                    <span className="font-semibold text-sm">Processos suspensos</span>
                    <span className="text-xs opacity-70">({suspensosLista.length})</span>
                  </div>
                  <button
                    className="px-3 py-1 text-sm rounded border border-[var(--panel-border)] hover:bg-[var(--panel-border)]/20"
                    onClick={() => setShowSuspensos(false)}
                  >
                    Fechar
                  </button>
                </div>
                <div className="p-4 overflow-auto max-h-[78vh] space-y-2">
                  {suspensosLista.length === 0 && (
                    <div className="text-sm opacity-70">Nenhum processo suspenso.</div>
                  )}
                  {suspensosLista.map((p) => (
                    <div
                      key={`susp-${p.id}`}
                      className="border border-amber-300 rounded-lg p-3 bg-amber-50 text-amber-900 flex flex-wrap items-center gap-2 justify-between"
                    >
                      <div className="flex flex-col gap-1">
                        <div className="text-sm font-bold">
                          #{p.id} • UC {p.__uc || extrair(p.uc) || '—'}
                        </div>
                        <div className="text-xs opacity-80">
                          Coluna: {p.__coluna || '—'} • Sub-etapa: {p.__subetapa || extrair(p.sub_etapa) || '—'}
                        </div>
                        <div className="text-xs opacity-80">
                          Última mov.:{' '}
                          {fmtData(
                            p.__ultimaData ||
                              p.ultima_atualizacao ||
                              p.data_ultima_movimentacao
                          ) || '—'}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          className="px-3 py-1 text-sm rounded border border-[var(--panel-border)] hover:bg-[var(--panel-border)]/20"
                          onClick={() => {
                            setShowSuspensos(false);
                            handleCardClick(p);
                          }}
                        >
                          Abrir
                        </button>
                        <button
                          className="px-3 py-1 text-sm rounded border border-[var(--panel-border)] hover:bg-[var(--panel-border)]/20 bg-white text-amber-900"
                          onClick={async () => {
                            try {
                              await retomarProcesso(p.id, 'Restaurado via suspensos');
                              setToast({ open: true, type: 'success', text: 'Processo restaurado.' });
                              carregarDados();
                            } catch {
                              setToast({ open: true, type: 'error', text: 'Falha ao restaurar o processo.' });
                            }
                          }}
                        >
                          Restaurar
                        </button>
                        <span className="text-[10px] uppercase bg-amber-600 text-white px-2 py-0.5 rounded">
                          Suspenso
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>,
            document.body
          )}

        {processoParaEditarTags && (
          <ModalGerenciarTags
            processo={processoParaEditarTags}
            allTags={allTags}
            onClose={() => setProcessoParaEditarTags(null)}
            onSave={handleSaveTags}
            onTagCreated={handleTagCreated}
          />
        )}

        {isModalDeferimentoAberto && movimentacaoPendente && (
          <ModalDeferimento
            processo={movimentacaoPendente.processo}
            onClose={() => {
              setIsModalDeferimentoAberto(false);
              setMovimentacaoPendente(null);
            }}
            onSave={handleSalvarDeferimento}
          />
        )}
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-in-fast { animation: fadeIn 0.2s ease-out forwards; }
      `}</style>
    </>
  );
};

export default ControleProcessos;
