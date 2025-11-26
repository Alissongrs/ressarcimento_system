import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { DndContext, PointerSensor, useSensor, useSensors, useDraggable, useDroppable } from '@dnd-kit/core';
import { getAllRequisicoes, atualizarRequisicaoCompleta, getDashboardStatsBI, movimentarProcesso } from '../services/requisicaoService';
import { getEtapas, getEtapaSubMap } from '../services/filtersService';
import { Clock, Check, X, ArrowRight } from 'lucide-react';

// Util: normaliza strings (tira acentos e baixa)
const normalize = (s) => {
  try { return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
  catch { return String(s || '').toLowerCase(); }
};

// Datas em PT-BR -> ISO para backend
const toISODateFromPt = (pt) => {
  if (!pt) return '';
  const s = String(pt).trim();
  const m = s.match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/);
  if (!m) return s;
  const [_, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
};
const toISODateTimeFromPt = (pt) => {
  if (!pt) return '';
  const s = String(pt).trim();
  const m = s.match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*$/);
  if (!m) return s;
  const [_, d, mo, y, h, mi] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi.padStart(2, '0')}`;
};

// Timer simples para cálculo de prazos
const useTimer = (refreshInterval = 60000) => {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), refreshInterval);
    return () => clearInterval(id);
  }, [refreshInterval]);
  return time;
};

const RequisicaoCard = ({ requisicao, onUpdate }) => {
  const now = useTimer();
  const { user } = useAuth();
  const isAdmin = (user?.tipo_conta || '').toLowerCase() === 'admin';
  const calcPrazo = useMemo(() => {
    const dataBaseStr = requisicao.data_mudanca_status;
    const statusNorm = normalize(requisicao.status);
    const isPendente = statusNorm === 'nova requisicao';
    const isAnalise = statusNorm === 'em analise';
    if (!dataBaseStr || new Date(dataBaseStr).getFullYear() < 2000 || (!isPendente && !isAnalise)) {
      return { text: '-', isOverdue: false };
    }
    const prazoDias = isPendente ? 5 : 10;
    const base = new Date(dataBaseStr);
    const dataFinal = new Date(base.getTime()); dataFinal.setDate(base.getDate() + prazoDias);
    const diff = dataFinal.getTime() - now.getTime();
    const isOverdue = diff < 0;
    const dias = Math.floor(Math.abs(diff) / (1000 * 60 * 60 * 24));
    const horas = Math.floor((Math.abs(diff) / (1000 * 60 * 60)) % 24);
    return { text: `${isOverdue ? '-' : ''}${dias}d ${horas}h`, isOverdue };
  }, [requisicao.status, requisicao.data_mudanca_status, now]);

  const handleAction = (newStatus) => {
    const comentario = prompt(`Adicione um comentário para mover a requisição para "${newStatus}":`);
    if (comentario != null) onUpdate(requisicao.id, newStatus, comentario || '');
  };

  return (
    <div className="glass-card gradient-card shadow-medium p-4 rounded-lg border border-[var(--border)] text-[var(--fg)] space-y-3 flex flex-col">
      <Link to={`/requisicao/${requisicao.id}`} className="font-semibold text-sm text-[var(--accent)] hover:underline">
        Req. #{requisicao.id} - {requisicao.cliente?.String || 'Cliente não definido'}
      </Link>
      <p className="text-xs opacity-70">UC: {requisicao.uc?.String || 'N/A'}</p>
      <div className={`flex justify-between items-center text-xs ${calcPrazo.isOverdue ? 'text-red-400' : 'opacity-70'}`}>
        <span className="flex items-center gap-1"><Clock size={14} /> Prazo:</span>
        <span className="font-bold">{calcPrazo.text}</span>
      </div>

      {/* Ações rápidas: somente para administradores */}
      {isAdmin && (
        <div className="flex flex-wrap gap-2 pt-3 border-t border-[var(--border)]">
          <button onClick={() => handleAction('Nova Requisição')} className="btn-action bg-[var(--accent)]/60 hover:opacity-90">Nova Requisição</button>
          <button onClick={() => handleAction('Em Análise')} className="btn-action bg-[var(--accent)] hover:opacity-90">Em Análise</button>
          <button onClick={() => handleAction('Aprovado')} className="btn-action bg-success hover:opacity-90">Aprovado</button>
          <button onClick={() => handleAction('Rejeitado')} className="btn-action bg-danger hover:opacity-90">Rejeitado</button>
        </div>
      )}

      {isAdmin && (normalize(requisicao.status) === 'nova requisicao') && (
        <div className="flex gap-2 pt-3 border-t border-[var(--border)]">
          <button onClick={() => handleAction('Em Análise')} className="btn-action bg-[var(--accent)] hover:opacity-90">
            <ArrowRight size={14} /> Análise
          </button>
          <button onClick={() => handleAction('Aprovado')} className="btn-action bg-success hover:opacity-90">
            <Check size={14} /> Aprovar
          </button>
          <button onClick={() => handleAction('Rejeitado')} className="btn-action bg-danger hover:opacity-90">
            <X size={14} /> Rejeitar
          </button>
        </div>
      )}

      {isAdmin && normalize(requisicao.status) === 'em analise' && (
        <div className="flex gap-2 pt-3 border-t border-[var(--border)]">
          <button onClick={() => handleAction('Aprovado')} className="btn-action bg-success hover:opacity-90">
            <Check size={14} /> Aprovar
          </button>
          <button onClick={() => handleAction('Rejeitado')} className="btn-action bg-danger hover:opacity-90">
            <X size={14} /> Rejeitar
          </button>
        </div>
      )}
    </div>
  );
};

const DraggableCard = ({ id, disabled, children }) => {
  const { attributes, listeners, setNodeRef } = useDraggable({ id, disabled });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={disabled ? '' : 'kanban-card-admin-draggable'}
    >
      {children}
    </div>
  );
};

const DroppableColumn = ({ id, children }) => {
  const { setNodeRef } = useDroppable({ id });
  return (
    <div ref={setNodeRef}>
      {children}
    </div>
  );
};

const GestaoRequisicoes = () => {
  const [columns, setColumns] = useState({ 'Nova Requisição': [], 'Em Análise': [], Aprovado: [], Rejeitado: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [statusCounts, setStatusCounts] = useState({ pendente: 0, em_analise: 0, aprovado: 0, rejeitado: 0 });
  const [totalRequisicoes, setTotalRequisicoes] = useState(0);
  // Deriva contadores diretamente das colunas exibidas (fonte de verdade da tela)
  const countsByCol = useMemo(() => {
    const out = { pendente: 0, em_analise: 0, aprovado: 0, rejeitado: 0 };
    try {
      Object.entries(columns || {}).forEach(([k, arr]) => {
        const nk = normalize(k);
        if (nk.includes('nova requisicao')) out.pendente = (arr || []).length;
        else if (nk.includes('analise')) out.em_analise = (arr || []).length;
        else if (nk.includes('aprov')) out.aprovado = (arr || []).length;
        else if (nk.includes('rejeit')) out.rejeitado = (arr || []).length;
      });
    } catch {}
    return out;
  }, [columns]);
  const totalByCols = countsByCol.pendente + countsByCol.em_analise + countsByCol.aprovado + countsByCol.rejeitado;
  const { user } = useAuth();
  const isAdmin = String(user?.tipo_conta || '').toLowerCase() === 'admin';
  // Ativa drag por distância (desktop) para evitar arrastos acidentais
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 10 } })
  );

  // Modal de confirmação de movimentação
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState({ id: null, destino: '' });
  const [moveComment, setMoveComment] = useState('');

  // Toast simples
  const [toast, setToast] = useState('');
  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  // Destino inicial do processo (quando aprovando)
  const [etapas, setEtapas] = useState([]);
  const [etapaSubMap, setEtapaSubMap] = useState({});
  const [destinoEtapa, setDestinoEtapa] = useState('');
  const [destinoSub, setDestinoSub] = useState('');
  const [destinoStatus, setDestinoStatus] = useState('Aprovado');
  const [destinoColuna, setDestinoColuna] = useState('');
  const colToEtapa = {
    'Ativos': 'Andamento',
    'Deferidos': 'Pendente',
    'Fluxo de Ressarcimento': 'Enviado ao Financeiro',
    'Faturamento': 'Ressarcimento',
    'Concluídos': 'Concluído',
    'Indeferidos': 'Indeferido',
  };
  const [preencherDeferimento, setPreencherDeferimento] = useState(false);
  const [defData, setDefData] = useState('');
  const [defSimples, setDefSimples] = useState('');
  const [defDobro, setDefDobro] = useState('');
  const [defDataDobro, setDefDataDobro] = useState('');
  useEffect(() => { (async () => { try { setEtapas(await getEtapas()); setEtapaSubMap(await getEtapaSubMap()); } catch {} })(); }, []);

  const carregarDados = async () => {
    try {
      setIsLoading(true);
      const data = await getAllRequisicoes();
      const cols = { 'Nova Requisição': [], 'Em Análise': [], Aprovado: [], Rejeitado: [] };
      (data || []).forEach((req) => {
        const k = normalize(req.status);
        if (k === 'nova requisicao') cols['Nova Requisição'].push(req);
        else if (k === 'em analise') cols['Em Análise'].push(req);
        else if (k === 'aprovado') cols.Aprovado.push(req);
        else if (k === 'rejeitado') cols.Rejeitado.push(req);
      });
      setColumns(cols);
      const counts = { pendente: 0, em_analise: 0, aprovado: 0, rejeitado: 0 };
      (data || []).forEach((req) => {
        const k = normalize(req.status);
        if (k === 'nova requisicao') counts.pendente++;
        else if (k === 'em analise') counts.em_analise++;
        else if (k === 'aprovado') counts.aprovado++;
        else if (k === 'rejeitado') counts.rejeitado++;
      });
      setStatusCounts(counts);
      setTotalRequisicoes((data || []).length);
    } catch (e) {
      console.error('Erro ao buscar requisições:', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { carregarDados(); }, []);

  // Carrega os totais consolidados por status do dashboard
  useEffect(() => {
    (async () => {
      try {
        const stats = await getDashboardStatsBI();
        const sc = stats?.status_counts || {};
        setStatusCounts({
          pendente: Number(sc.pendente || 0),
          em_analise: Number(sc.em_analise || 0),
          aprovado: Number(sc.aprovado || 0),
          rejeitado: Number(sc.rejeitado || 0),
        });
        setTotalRequisicoes(Number(stats?.total_requisicoes || 0));
      } catch {}
    })();
  }, []);

  const handleUpdateRequisicao = async (id, newStatus, comentario, extra = {}) => {
    // Se for "Aprovado" e no veio destino, abre modal para escolher etapa/sub-etapa
    if (newStatus === 'Aprovado' && !(extra?.etapa || extra?.sub_etapa)) {
      setMoveTarget({ id, destino: 'Aprovado' });
      setDestinoEtapa('');
      setDestinoSub('');
      setMoveComment(comentario || '');
      setMoveOpen(true);
      return;
    }
    const formData = new FormData();
    formData.append('status', newStatus);
    formData.append('comentario', comentario || '');
    if (newStatus === 'Aprovado') {
      if (extra?.etapa) formData.append('etapa', extra.etapa);
      if (extra?.sub_etapa) formData.append('sub_etapa', extra.sub_etapa);
    }
    try {
      await atualizarRequisicaoCompleta(id, formData);
      if (newStatus === 'Aprovado' && (extra?.etapa || extra?.sub_etapa)) {
        setTimeout(async () => {
          try {
            const fd = new FormData();
            if (extra?.etapa) fd.append('etapa', extra.etapa);
            if (extra?.sub_etapa) fd.append('sub_etapa', extra.sub_etapa);
            fd.append('comentario', 'Destino definido na aprovação');
            await movimentarProcesso(id, fd);
          } catch {}
        }, 300);
      }
      carregarDados();
      showToast(`Requisição #${id} movida para "${newStatus}"`);
    } catch (err) {
      alert('Falha ao atualizar o status da requisição.');
      console.error('Erro ao atualizar requisição:', err);
    }
  };

  const handleDragEnd = useCallback((event) => {
    if (!isAdmin) return;
    const { active, over } = event || {};
    if (!active || !over) return;
    const reqId = active.id;
    const destino = over.id; // Pendente | Em Análise | Aprovado | Rejeitado
    const allowed = Object.keys(columns || {});
    if (!allowed.includes(destino)) return;
    setMoveTarget({ id: reqId, destino });
    setMoveComment('');
    setDestinoStatus(destino);
    if (destino === 'Aprovado') { setDestinoEtapa(''); setDestinoSub(''); }
    setMoveOpen(true);
  }, [isAdmin, columns]);

  if (isLoading) return <div className="p-8 text-center text-[var(--fg)]">Carregando painel de gestão...</div>;

  return (
    <div className="w-full max-w-full mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <h1 className="text-3xl font-bold mb-10 mt-12 text-center">Painel de Gestão de Requisições</h1>
      {/* Totais (Dashboard) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-6 max-w-4xl mx-auto">
        <div className="panel-bg-60 border panel-border rounded-lg p-3 text-center">
          <div className="text-xs opacity-70">Nova Requisição</div>
            <div className="text-lg font-bold text-[var(--fg)]">{countsByCol.pendente}</div>
        </div>
        <div className="panel-bg-60 border panel-border rounded-lg p-3 text-center">
          <div className="text-xs opacity-70">Em Análise</div>
            <div className="text-lg font-bold text-[var(--fg)]">{countsByCol.em_analise}</div>
        </div>
        <div className="panel-bg-60 border panel-border rounded-lg p-3 text-center">
          <div className="text-xs opacity-70">Aprovado</div>
            <div className="text-lg font-bold text-[var(--fg)]">{countsByCol.aprovado}</div>
        </div>
        <div className="panel-bg-60 border panel-border rounded-lg p-3 text-center">
          <div className="text-xs opacity-70">Rejeitado</div>
            <div className="text-lg font-bold text-[var(--fg)]">{countsByCol.rejeitado}</div>
        </div>
          <div className="col-span-2 sm:col-span-4 text-center text-xs opacity-70">Total de requisições: {totalByCols}</div>
      </div>

      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="kanban-board flex justify-center gap-8 overflow-x-auto pb-6">
          {Object.keys(columns).map((columnId) => (
            <div key={columnId} className="glass-card border border-[var(--border)] text-[var(--fg)] rounded-lg p-3 w-80 flex-shrink-0 flex flex-col">
              <h3 className="font-bold mb-4 px-2 text-sm uppercase tracking-wider">{columnId} ({columns[columnId].length})</h3>
              <DroppableColumn id={columnId}>
                <div className="min-h-[70vh] space-y-3 p-1 overflow-y-auto">
                  {columns[columnId].map((req) => (
                    <DraggableCard key={req.id} id={req.id} disabled={!isAdmin}>
                      <RequisicaoCard requisicao={req} onUpdate={handleUpdateRequisicao} />
                    </DraggableCard>
                  ))}
                </div>
              </DroppableColumn>
            </div>
          ))}
        </div>
      </DndContext>
      {moveOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md bg-[var(--panel)] text-[var(--fg)] border border-[var(--panel-border)] rounded-lg shadow-lg p-4">
            <h2 className="text-lg font-semibold mb-2">Mover requisição</h2>
            <p className="text-sm opacity-80 mb-3">Confirme a movimentação abaixo:</p>
            <div className="text-sm mb-3">
              <div><strong>ID:</strong> #{moveTarget.id}</div>
              <div className="mt-2">
                <label className="block text-sm font-medium mb-1">Status destino</label>
                <select
                  value={destinoStatus}
                  onChange={(e) => setDestinoStatus(e.target.value)}
                  className="w-full p-2 rounded-md border border-[var(--panel-border)] bg-transparent"
                >
                  <option>Nova Requisição</option>
                  <option>Em Análise</option>
                  <option>Aprovado</option>
                  <option>Rejeitado</option>
                </select>
                <div className="flex flex-wrap gap-2 mt-2">
                  <button type="button" onClick={() => setDestinoStatus('Nova Requisição')} className={`px-2 py-1 rounded border ${destinoStatus==='Nova Requisição'?'bg-[var(--accent)] text-[var(--fg)]':'border-[var(--panel-border)]'}`}>Nova Requisição</button>
                  <button type="button" onClick={() => setDestinoStatus('Em Análise')} className={`px-2 py-1 rounded border ${destinoStatus==='Em Análise'?'bg-[var(--accent)] text-[var(--fg)]':'border-[var(--panel-border)]'}`}>Em Análise</button>
                  <button type="button" onClick={() => setDestinoStatus('Aprovado')} className={`px-2 py-1 rounded border ${destinoStatus==='Aprovado'?'bg-[var(--accent)] text-[var(--fg)]':'border-[var(--panel-border)]'}`}>Aprovado</button>
                  <button type="button" onClick={() => setDestinoStatus('Rejeitado')} className={`px-2 py-1 rounded border ${destinoStatus==='Rejeitado'?'bg-[var(--accent)] text-[var(--fg)]':'border-[var(--panel-border)]'}`}>Rejeitado</button>
                </div>
                </div>
              <div className="mt-3">
                <label className="block text-sm font-medium mb-1">Coluna do processo</label>
                <div className="flex flex-wrap gap-2">
                  {['Ativos','Deferidos','Fluxo de Ressarcimento','Faturamento','Concluídos','Indeferidos'].map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => { setDestinoColuna(c); const e = colToEtapa[c]; if (e) setDestinoEtapa(e); }}
                      className={`px-2 py-1 rounded border ${destinoColuna===c?'bg-[var(--accent)] text-[var(--fg)]':'border-[var(--panel-border)]'}`}
                    >{c.toUpperCase()}</button>
                  ))}
                </div>
              </div>
            </div>
            {destinoStatus === 'Aprovado' && (
              <div className="mb-3">
                <label className="block text-sm font-medium mb-1">Etapa inicial do processo</label>
                <select
                  value={destinoEtapa}
                  onChange={(e) => { setDestinoEtapa(e.target.value); setDestinoSub(''); }}
                  className="w-full p-2 rounded-md border border-[var(--border)] bg-transparent mb-2"
                >
                  <option value="">(opcional)</option>
                  {etapas.map((n) => (<option key={n} value={n}>{n}</option>))}
                </select>
                <label className="block text-sm font-medium mb-1">Sub-etapa</label>
                <input
                  list="dl-sub-dest"
                  value={destinoSub}
                  onChange={(e) => setDestinoSub(e.target.value)}
                  className="w-full p-2 rounded-md border border-[var(--border)] bg-transparent"
                  placeholder="(opcional)"
                />
                <datalist id="dl-sub-dest">
                  {((etapaSubMap?.[destinoEtapa || ''] || [])).map((s, i) => (<option key={i} value={s} />))}
                </datalist>
                <div className="mt-3">
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={preencherDeferimento} onChange={(e) => setPreencherDeferimento(e.target.checked)} />
                    Informar deferimento agora
                  </label>
                </div>
                {preencherDeferimento && (
                  <div className="grid grid-cols-1 gap-2 mt-2">
                    <div>
                      <label className="block text-sm">Data da Procedência</label>
                      <input type="date" value={defData} onChange={(e) => setDefData(e.target.value)} className="w-full p-2 rounded-md border border-[var(--border)] bg-transparent" />
                    </div>
                    <div>
                      <label className="block text-sm">Crédito Simples (R$)</label>
                      <input type="number" value={defSimples} onChange={(e) => setDefSimples(e.target.value)} className="w-full p-2 rounded-md border border-[var(--border)] bg-transparent" />
                    </div>
                    <div>
                      <label className="block text-sm">Crédito em Dobro (R$)</label>
                      <input type="number" value={defDobro} onChange={(e) => setDefDobro(e.target.value)} className="w-full p-2 rounded-md border border-[var(--border)] bg-transparent" />
                    </div>
                    <div>
                      <label className="block text-sm">Data do Crédito em Dobro</label>
                      <input type="datetime-local" value={defDataDobro} onChange={(e) => setDefDataDobro(e.target.value)} className="w-full p-2 rounded-md border border-[var(--border)] bg-transparent" />
                    </div>
                  </div>
                )}
              </div>
            )}
            <label className="block text-sm font-medium mb-1">Comentário (opcional)</label>
            <textarea
              value={moveComment}
              onChange={(e) => setMoveComment(e.target.value)}
              rows={3}
              className="w-full p-2 rounded-md border border-[var(--border)] bg-transparent focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              placeholder="Escreva um comentário para o histórico..."
            />
            <div className="mt-4 flex gap-2 justify-end">
              <button onClick={() => setMoveOpen(false)} className="px-3 py-2 rounded-md border border-[var(--border)] hover:bg-[var(--border)]/20">Cancelar</button>
              <button
                onClick={() => {
                  setMoveOpen(false);
                  const extra = destinoStatus === 'Aprovado' ? {
                    etapa: destinoEtapa,
                    sub_etapa: destinoSub,
                    deferimento: (preencherDeferimento ? {
                      DataProcedencia: toISODateFromPt(defData) || '',
                      CreditoSimples: defSimples !== '' ? Number(defSimples) : null,
                      CreditoDobro: defDobro !== '' ? Number(defDobro) : null,
                      DataCreditoDobro: toISODateTimeFromPt(defDataDobro) || ''
                    } : null)
                  } : {};
                  handleUpdateRequisicao(moveTarget.id, destinoStatus, moveComment, extra);
                }}
                className="px-3 py-2 rounded-md bg-[var(--accent)] text-[var(--fg)]"
              >Confirmar</button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div className="fixed bottom-4 right-4 z-50 px-4 py-2 rounded-md bg-[var(--accent)] text-[var(--fg)] shadow-lg">
          {toast}
        </div>
      )}
      <style>{`
        .btn-action { padding: 6px 10px; border-radius: 6px; color: white; font-size: 12px; font-weight: bold; display: flex; align-items: center; gap: 6px; justify-content: center; }
      `}</style>
    </div>
  );
};

export default GestaoRequisicoes;













