import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useNavigate } from 'react-router-dom';
import { getRequisicoesDepartamento } from '../services/requisicaoService';
import { searchGlobal } from '../services/searchService';
import { CalendarDays, ClipboardList, CheckCircle, XCircle, Clock } from 'lucide-react';
import HistoricoModal from '../components/HistoricoModal.jsx';

const extrair = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'String' in v) return v.Valid ? (v.String ?? '') : '';
  try { return String(v); } catch { return ''; }
};

const etapaLabel = (r) => {
  const e = (extrair(r?.etapa) || extrair(r?.status) || '').toLowerCase();
  if (!e) return 'Nova requisição';
  if (e.includes('aprov')) return 'Aprovado';
  if (e.includes('rejeit') || e.includes('indefer')) return 'Rejeitado';
  if (e.includes('anali') || e.includes('andament')) return 'Em análise';
  return 'Em análise';
};

const explicacaoKanban = (r) => {
  const col = (extrair(r?.coluna_kanban_nome) || extrair(r?.coluna_kanban) || '').toString().toLowerCase();
  if (!col) return null;
  const map = {
    'ativos': 'Seu processo está em Ativos: estamos acompanhando junto à concessionária ou órgão competente.',
    'deferidos': 'Seu processo está em Deferidos: houve decisão favorável (deferimento).',
    'fluxo de ressarcimento': 'Fluxo de Ressarcimento: etapas para crédito simples/dobro e conciliações.',
    'faturamento': 'Faturamento: emissão e conferência de documentos financeiros para o crédito.',
    'conclu': 'Concluídos: processo finalizado.',
    'indefer': 'Indeferidos: não procedente; mantemos seu histórico para referência.',
  };
  const key = Object.keys(map).find((k) => col.includes(k));
  return key ? map[key] : null;
};

export default function MinhasRequisicoes() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const PAGE_LIMIT = 15;
  const [hasMore, setHasMore] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [searching, setSearching] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalProc, setModalProc] = useState(null);
  const [modalAnchorTop, setModalAnchorTop] = useState(80);

  // Debounce para evitar excesso de chamadas enquanto digita
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 180);
    return () => clearTimeout(t);
  }, [query]);

  const normalizeQuery = (q) => (q || '').replace(/[\n,;]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Live search: busca enquanto digita (sem precisar pausar)
  useEffect(() => {
    const q = normalizeQuery(debounced);
    // Sem texto: recarrega a primeira página padrão
    if (!q) {
      (async () => {
        setLoading(true);
        setError('');
        try {
          const page = await getRequisicoesDepartamento({ limit: PAGE_LIMIT, offset: 0 });
          const rows = Array.isArray(page) ? page : [];
          setList(rows);
          setHasMore(rows.length === PAGE_LIMIT);
        } catch (e) {
          setError('Não foi possível carregar suas requisições.');
        } finally {
          setLoading(false);
        }
      })();
      return;
    }
    // Com texto: busca global (tenta com espacos e fallback com virgulas)
    (async () => {
      setSearching(true);
      setError('');
      try {
        let results = await searchGlobal(q);
        if (!Array.isArray(results) || results.length === 0) {
          const tokens = q.split(' ').filter(Boolean);
          if (tokens.length > 1) {
            results = await searchGlobal(tokens.join(','));
          }
        }
        // Fallback final: carrega um lote grande e filtra no cliente por UC/ID
        if (!Array.isArray(results) || results.length === 0) {
          try {
            const big = await getRequisicoesDepartamento({ limit: 1000, offset: 0 });
            const arr = Array.isArray(big) ? big : [];
            const tokens = q.split(' ').filter(Boolean).map((t) => t.toLowerCase());
            const filtered = arr.filter((r) => {
              const id = String(r?.id || r?.id_requisicao || r?.requisicao_id || '').toLowerCase();
              const uc = String(r?.uc || '').toLowerCase();
              const cliente = String(r?.cliente || '').toLowerCase();
              const conc = String(r?.concessionaria || '').toLowerCase();
              // Match se qualquer token aparecer em id ou uc
              return tokens.some((t) => id.includes(t) || uc.includes(t) || cliente.includes(t) || conc.includes(t));
            });
            results = filtered;
          } catch {}
        }
        // Debug leve no console para verificar retorno
        try { console.info('[auditoria] search results:', Array.isArray(results) ? results.length : 0); } catch {}
        setList(Array.isArray(results) ? results : []);
        setHasMore(false);
      } catch (e) {
        setError('Falha na busca.');
      } finally {
        setSearching(false);
      }
    })();
  }, [debounced]);

  const SUPPORT = (import.meta?.env?.VITE_SUPPORT_TEXT ?? 'Dúvidas? complaint@amee.com.br | WhatsApp +55 15 99747-7277.');

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      try {
        const page = await getRequisicoesDepartamento({ limit: PAGE_LIMIT, offset: 0 });
        const rows = Array.isArray(page) ? page : [];
        setList(rows);
        setHasMore(rows.length === PAGE_LIMIT);
      } catch (e) {
        setError('Não foi possível carregar suas requisições.');
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const next = await getRequisicoesDepartamento({ limit: PAGE_LIMIT, offset: list.length });
      const rows = Array.isArray(next) ? next : [];
      setList((prev) => [...prev, ...rows]);
      setHasMore(rows.length === PAGE_LIMIT);
    } finally {
      setLoadingMore(false);
    }
  };

  const itens = useMemo(() => (Array.isArray(list) ? list : []), [list]);

  // Exporta os itens visíveis para CSV (1 processo por linha)
  const exportCsv = () => {
    const header = [
      'ID','Cliente','UC','Concessionaria','Endereco','Status','RessarcimentoEstimado','DataCriacao','UltimaMovimentacao'
    ];
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = [header];
    (itens || []).forEach((r) => {
      const id = r?.id || r?.id_requisicao || r?.requisicao_id || '';
      const cliente = r?.cliente ?? '';
      const uc = r?.uc ?? '';
      const conc = r?.concessionaria ?? '';
      const end = r?.endereco_completo ?? '';
      const status = etapaLabel(r);
      const valor = r?.ressarcimento_estimado ?? '';
      const criado = r?.data_criacao ?? '';
      const dt = r?.data_mudanca_status || r?.data_criacao || r?.ultima_atualizacao || r?.data || '';
      rows.push([id, cliente, uc, conc, end, status, valor, criado, dt].map(esc));
    });
    const csv = rows.map((arr) => arr.join(';')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'auditoria_export.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  if (loading) return <div className="p-6"><span className="sap-loading">Carregando...</span></div>;
  if (error) return <div className="p-6 text-red-400">{error}</div>;

  return (
    <>
      <div className="p-4 md:p-6">
        <h1 className="text-2xl font-extrabold mb-4">Minhas Requisições</h1>

        {/* Busca por múltiplos UC/IDs (separe por espaço, vírgula ou quebra de linha) */}
        <div className="mb-4 flex items-center gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const raw = (query || '').trim();
                if (!raw) return;
                setSearching(true);
                setError('');
                try {
                  const norm = raw.replace(/[\n,;]+/g, ' ').replace(/\s+/g, ' ').trim();
                  const results = await searchGlobal(norm);
                  setList(Array.isArray(results) ? results : []);
                  setHasMore(false);
                } catch (err) {
                  setError('Falha na busca.');
                } finally {
                  setSearching(false);
                }
              }
            }}
            placeholder="Busque por UC(s) e/ou ID(s) — separe por espaço, vírgula ou quebra de linha"
            className="flex-1 input-themed"
          />
          <button
            type="button"
            onClick={async () => {
              const raw = (query || '').trim();
              if (!raw) return;
              setSearching(true);
              setError('');
              try {
                const norm = raw.replace(/[\n,;]+/g, ' ').replace(/\s+/g, ' ').trim();
                const results = await searchGlobal(norm);
                setList(Array.isArray(results) ? results : []);
                setHasMore(false);
              } catch (err) {
                setError('Falha na busca.');
              } finally {
                setSearching(false);
              }
            }}
            disabled={searching}
            className="btn-themed"
          >
            {searching ? 'Buscando…' : 'Buscar'}
          </button>
          {!!query && (
            <button
              type="button"
              onClick={async () => {
                setQuery('');
                // recarrega a primeira página padrão
                setLoading(true);
                setError('');
                try {
                  const page = await getRequisicoesDepartamento({ limit: PAGE_LIMIT, offset: 0 });
                  const rows = Array.isArray(page) ? page : [];
                  setList(rows);
                  setHasMore(rows.length === PAGE_LIMIT);
                } catch (e) {
                  setError('Falha ao recarregar lista.');
                } finally {
                  setLoading(false);
                }
              }}
              className="btn-outline"
            >
              Limpar
            </button>
          )}
        </div>

        {/* Intro explicativa para solicitante */}
        <div className="glass-card rounded-lg border px-4 py-3 mb-4 text-sm">
          <p className="opacity-90">
            Acompanhe aqui o andamento das suas solicitações. Etapas principais: <strong>Nova requisição</strong>,
            <strong> Em análise</strong>, <strong>Aprovado</strong> ou <strong>Rejeitado</strong>. Quando aprovado, o
            processo segue para o Kanban e passa por fases como <strong>Ativos</strong>, <strong>Deferidos</strong>,
            <strong> Fluxo de Ressarcimento</strong>, <strong>Faturamento</strong> e <strong>Concluídos</strong>.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="px-2 py-1 rounded-full border border-[var(--border)]">Nova requisição</span>
            <span className="px-2 py-1 rounded-full border border-[var(--border)]">Em análise</span>
            <span className="px-2 py-1 rounded-full border border-[var(--border)]">Aprovado</span>
            <span className="px-2 py-1 rounded-full border border-[var(--border)]">Rejeitado</span>
            <span className="px-2 py-1 rounded-full border border-[var(--border)]">Ativos</span>
            <span className="px-2 py-1 rounded-full border border-[var(--border)]">Deferidos</span>
            <span className="px-2 py-1 rounded-full border border-[var(--border)]">Fluxo de Ressarcimento</span>
            <span className="px-2 py-1 rounded-full border border-[var(--border)]">Faturamento</span>
            <span className="px-2 py-1 rounded-full border border-[var(--border)]">Concluídos</span>
          </div>
          <div className="mt-2 text-right">
            <button
              type="button"
              onClick={() => setShowHelp(true)}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--border)] hover:opacity-90"
              title="O que significa cada fase?"
            >
              O que significa cada fase?
            </button>
          </div>
        </div>

        {!itens.length && <div className="opacity-70">Você ainda não possui requisições.</div>}

        {itens.length > 0 && (
          <div className="mb-2 text-right">
            <button type="button" className="btn-outline" onClick={exportCsv}>Exportar CSV</button>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {itens.map((r) => {
            const id = r?.id || r?.id_requisicao || r?.requisicao_id;
            const etapa = etapaLabel(r);
            const exp = etapa === 'Aprovado' ? (explicacaoKanban(r) || 'Seu processo está avançando no Kanban.') : null;

            // Usa campos retornados pelo backend na listagem
            const dt = r?.data_mudanca_status || r?.data_criacao || r?.ultima_atualizacao || r?.data;

            const steps =
              etapa === 'Rejeitado'
                ? ['Nova requisição', 'Em análise', 'Rejeitado']
                : ['Nova requisição', 'Em análise', 'Aprovado'];

            const currentIdx = steps.findIndex((s) => s.toLowerCase() === etapa.toLowerCase());

            return (
              <div key={String(id)} className="glass-card rounded-lg border px-5 py-4">
                <div className="flex items-center justify-between">
                  <div className="text-lg font-bold">REQ-{String(id).padStart(3, '0')}</div>
                  <div className="text-xs opacity-70 inline-flex items-center gap-1">
                    <CalendarDays size={12} />
                    {dt || '-'}
                  </div>
                </div>

                {/* Timeline simples de andamento */}
                <div className="mt-3">
                  <div className="flex items-center gap-2 text-xs">
                    {steps.map((s, i) => (
                      <div key={s} className="flex items-center gap-2">
                        <div
                          className={[
                            'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold',
                            i < currentIdx
                              ? 'bg-green-500 text-white'
                              : i === currentIdx
                              ? 'bg-blue-600 text-white'
                              : 'bg-[var(--border)] text-[var(--fg)]/70',
                          ].join(' ')}
                        >
                          {i + 1}
                        </div>
                        <div className={['min-w-[80px] truncate', i === currentIdx ? 'font-semibold' : 'opacity-80'].join(' ')}>
                          {s}
                        </div>
                        {i < steps.length - 1 && (
                          <div className={['w-8 h-[2px]', i < currentIdx ? 'bg-green-500' : 'bg-[var(--border)]'].join(' ')} />
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                  <div className="opacity-70">Cliente</div>
                  <div className="font-medium truncate">{extrair(r?.cliente) || '-'}</div>

                  <div className="opacity-70">UC</div>
                  <div className="font-medium truncate">{extrair(r?.uc) || '-'}</div>

                  <div className="opacity-70">Concessionária</div>
                  <div className="font-medium truncate">{extrair(r?.concessionaria) || '-'}</div>
                </div>

                <div className="mt-3 flex items-center gap-2 text-sm">
                  {etapa === 'Aprovado' ? (
                    <CheckCircle size={16} className="text-green-500" />
                  ) : etapa === 'Rejeitado' ? (
                    <XCircle size={16} className="text-red-500" />
                  ) : (
                    <Clock size={16} className="opacity-70" />
                  )}
                  <div>
                    <span className="font-semibold">{etapa}</span>
                    {exp ? ` — ${exp}` : ''}
                  </div>
                </div>

                <div className="mt-3 text-xs opacity-80">Última movimentação: {dt || '-'}</div>

                <div className="mt-3 flex items-center gap-2 justify-end">
                  <button
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--border)]"
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      setModalAnchorTop(rect.top + 4);
                      setModalProc({ id });
                      setModalOpen(true);
                    }}
                  >
                    <ClipboardList size={16} /> Ver detalhes
                  </button>
                  {/* Botão 'Acompanhar processo' removido a pedido do cliente */}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Paginação: Carregar mais */}
      <div className="px-4 md:px-6 py-4 text-center">
        {hasMore ? (
          <button
            type="button"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--border)] hover:opacity-90"
            onClick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? 'Carregando…' : 'Carregar mais'}
          </button>
        ) : (
          <div className="text-sm opacity-70">Todos os itens carregados.</div>
        )}
      </div>

      {modalOpen && (
        <HistoricoModal isOpen={modalOpen} onClose={() => setModalOpen(false)} processoId={modalProc?.id} anchorTop={modalAnchorTop} />
      )}

      {showHelp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-3xl rounded-xl border border-[var(--border)] bg-[var(--panel)] text-[var(--fg)] shadow-elevated">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
              <h2 className="text-lg font-bold">Entenda as fases</h2>
              <button onClick={() => setShowHelp(false)} className="px-2 py-1 rounded hover:bg-[var(--border)]/20">
                Fechar
              </button>
            </div>

            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <h3 className="font-semibold mb-1">Nova requisição</h3>
                <p className="opacity-80">Solicitação recém-criada, aguardando início das análises.</p>
              </div>
              <div>
                <h3 className="font-semibold mb-1">Em análise</h3>
                <p className="opacity-80">Nossa equipe está conferindo os dados e documentos para prosseguir.</p>
              </div>
              <div>
                <h3 className="font-semibold mb-1">Aprovado</h3>
                <p className="opacity-80">A solicitação foi aprovada e o processo segue para o Kanban.</p>
              </div>
              <div>
                <h3 className="font-semibold mb-1">Rejeitado</h3>
                <p className="opacity-80">A solicitação não atendeu aos critérios. O histórico permanece disponível.</p>
              </div>
              <div>
                <h3 className="font-semibold mb-1">Ativos</h3>
                <p className="opacity-80">Acompanhamento ativo junto à concessionária ou órgão responsável.</p>
              </div>
              <div>
                <h3 className="font-semibold mb-1">Deferidos</h3>
                <p className="opacity-80">Decisão favorável; seguimos com os trâmites de ressarcimento.</p>
              </div>
              <div>
                <h3 className="font-semibold mb-1">Fluxo de Ressarcimento</h3>
                <p className="opacity-80">Etapas para crédito simples/dobro, conciliações e validações necessárias.</p>
              </div>
              <div>
                <h3 className="font-semibold mb-1">Faturamento</h3>
                <p className="opacity-80">Emissão e conferência de documentos financeiros para o crédito.</p>
              </div>
              <div>
                <h3 className="font-semibold mb-1">Concluídos</h3>
                <p className="opacity-80">Processo finalizado; você pode consultar todo o histórico.</p>
              </div>
            </div>

            <div className="px-4 pb-2 text-sm">
              <div className="glass-card rounded-lg border px-3 py-2">
                <div className="font-semibold">Precisa de ajuda?</div>
                <div className="opacity-80 mt-1">{SUPPORT}</div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--border)] hover:opacity-90"
                    onClick={() => navigate('/novo')}
                  >
                    Abrir Assistente (Chat)
                  </button>
                </div>
              </div>
            </div>

            <div className="px-4 py-3 border-t border-[var(--border)] text-right">
              <button onClick={() => setShowHelp(false)} className="px-3 py-2 rounded border border-[var(--border)]">
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

