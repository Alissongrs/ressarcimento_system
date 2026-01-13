// src/pages/MinhasRequisicoes.jsx
import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useNavigate } from 'react-router-dom';
import { getMinhasRequisicoes, getHistoricoById } from '../services/requisicaoService';
import { CalendarDays, ClipboardList, CheckCircle, XCircle, Clock } from 'lucide-react';

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

// helper simples para quebrar array em pedaços
const chunkArray = (arr, size) => {
  const result = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
};

export default function MinhasRequisicoes() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [histMap, setHistMap] = useState({});
  const [showHelp, setShowHelp] = useState(false);
  const SUPPORT = (import.meta?.env?.VITE_SUPPORT_TEXT ?? 'Dúvidas complaint@amee.com.br | WhatsApp +55 15 99747-7277.');

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      try {
        const arr = await getMinhasRequisicoes(true);
        // Fallback: se o backend não filtrar, tentamos no cliente por campos comuns
        const uid = String(user?.id || user?.userID || user?.usuario_id || '').trim();
        const mail = String(user?.email || '').trim().toLowerCase();
        const filtrada = Array.isArray(arr)
          ? arr.filter((r) => {
              const rid = String(
                r?.id_usuario ||
                  r?.usuario_id ||
                  r?.criador_id ||
                  r?.created_by ||
                  ''
              ).trim();
              const remail = String(
                r?.email || r?.usuario_email || ''
              )
                .trim()
                .toLowerCase();
              // se não houver campo, mostra todos (como estava no seu código original)
              return (
                (uid && rid && uid === rid) ||
                (mail && remail && mail === remail) ||
                true
              );
            })
          : [];
        setList(filtrada);

        // Busca último histórico (leve): limita a 10 chamadas concorrentes, 5 IDs por batch
        const ids = filtrada
          .map((r) =>
            String(
              r?.id || r?.id_requisicao || r?.requisicao_id || ''
            )
          )
          .filter(Boolean)
          .slice(0, 50);

        const mapa = {};
        const chunks = chunkArray(ids, 5);

        for (const part of chunks) {
          await Promise.all(
            part.map(async (id) => {
              try {
                const hist = await getHistoricoById(id);
                if (Array.isArray(hist) && hist.length) {
                  const key =
                    ['data_movimentacao', 'data', 'created_at', 'updated_at'].find(
                      (k) => k in (hist[0] || {})
                    ) || 'data';
                  const ultimo = [...hist].sort(
                    (a, b) => new Date(b[key]) - new Date(a[key])
                  )[0];
                  mapa[id] = ultimo;
                }
              } catch {
                // silencioso, segue o baile
              }
            })
          );
        }

        setHistMap(mapa);
      } catch (e) {
        setError('Não foi possível carregar suas requisições.');
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  const itens = useMemo(() => (Array.isArray(list) ? list : []), [list]);

  if (loading) return <div className="p-6"><span className="sap-loading">Carregando...</span></div>;
  if (error) return <div className="p-6 text-red-400">{error}</div>;

  return (
    <>
      <div className="p-4 md:p-6">
        <h1 className="text-2xl font-extrabold mb-4">Minhas Requisições</h1>
        {/* Intro explicativa para solicitante */}
        <div className="glass-card rounded-lg border px-4 py-3 mb-4 text-sm">
          <p className="opacity-90">
            Acompanhe aqui o andamento das suas solicitações. Etapas principais:{' '}
            <strong>Nova requisição</strong>,<strong> Em análise</strong>,{' '}
            <strong>Aprovado</strong> ou <strong>Rejeitado</strong>. Quando aprovado, o processo
            segue para o Kanban e passa por fases como <strong>Ativos</strong>,{' '}
            <strong>Deferidos</strong>,<strong> Fluxo de Ressarcimento</strong>,{' '}
            <strong>Faturamento</strong> e <strong>Concluídos</strong>.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="px-2 py-1 rounded-full border border-[var(--border)]">
              Nova requisição
            </span>
            <span className="px-2 py-1 rounded-full border border-[var(--border)]">
              Em análise
            </span>
            <span className="px-2 py-1 rounded-full border border-[var(--border)]">
              Aprovado
            </span>
            <span className="px-2 py-1 rounded-full border border-[var(--border)]">
              Rejeitado
            </span>
            <span className="px-2 py-1 rounded-full border border-[var(--border)]">
              Ativos
            </span>
            <span className="px-2 py-1 rounded-full border border-[var(--border)]">
              Deferidos
            </span>
            <span className="px-2 py-1 rounded-full border border-[var(--border)]">
              Fluxo de Ressarcimento
            </span>
            <span className="px-2 py-1 rounded-full border border-[var(--border)]">
              Faturamento
            </span>
            <span className="px-2 py-1 rounded-full border border-[var(--border)]">
              Concluídos
            </span>
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

        {!itens.length && (
          <div className="opacity-70">Você ainda não possui requisições.</div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {itens.map((r) => {
            const id = r?.id || r?.id_requisicao || r?.requisicao_id;
            const etapa = etapaLabel(r);
            const exp =
              etapa === 'Aprovado'
                ? explicacaoKanban(r) || 'Seu processo está avançando no Kanban.'
                : null;
            const hist =
              histMap[String(id)] || null;
            const dt = hist
              ? hist.data_movimentacao ||
                hist.data ||
                hist.created_at ||
                hist.updated_at
              : r?.ultima_atualizacao || r?.data;

            const steps =
              etapa === 'Rejeitado'
                ? ['Nova requisição', 'Em análise', 'Rejeitado']
                : ['Nova requisição', 'Em análise', 'Aprovado'];

            const currentIdx = steps.findIndex(
              (s) => s.toLowerCase() === etapa.toLowerCase()
            );

            return (
              <div
                key={String(id)}
                className="glass-card rounded-lg border px-5 py-4"
              >
                <div className="flex items-center justify-between">
                  <div className="text-lg font-bold">
                    REQ-{String(id).padStart(3, '0')}
                  </div>
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
                        <div
                          className={[
                            'min-w-[80px] truncate',
                            i === currentIdx ? 'font-semibold' : 'opacity-80',
                          ].join(' ')}
                        >
                          {s}
                        </div>
                        {i < steps.length - 1 && (
                          <div
                            className={[
                              'w-8 h-[2px]',
                              i < currentIdx
                                ? 'bg-green-500'
                                : 'bg-[var(--border)]',
                            ].join(' ')}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                  <div className="opacity-70">Cliente</div>
                  <div className="font-medium truncate">
                    {extrair(r?.cliente) || '-'}
                  </div>
                  <div className="opacity-70">UC</div>
                  <div className="font-medium truncate">
                    {extrair(r?.uc) || '-'}
                  </div>
                  <div className="opacity-70">Concessionária</div>
                  <div className="font-medium truncate">
                    {extrair(r?.concessionaria) || '-'}
                  </div>
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

                <div className="mt-3 text-xs opacity-80">
                  Última movimentação: {hist ? hist.comentario || '-' : '-'}
                </div>

                <div className="mt-3 flex items-center justify-end gap-2">
                  <button
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--border)]"
                    onClick={() => navigate(`/requisicao/${id}`)}
                  >
                    <ClipboardList size={16} /> Ver detalhes
                  </button>
                  {etapa === 'Aprovado' && (
                    <button
                      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--border)]"
                      onClick={() => navigate(`/processos/${id}`)}
                      title="Acompanhar o processo no Kanban"
                    >
                      Acompanhar processo
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {showHelp && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-3xl rounded-xl border border-[var(--border)] bg-[var(--panel)] text-[var(--fg)] shadow-elevated">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
              <h2 className="text-lg font-bold">Entenda as fases</h2>
              <button
                onClick={() => setShowHelp(false)}
                className="px-2 py-1 rounded hover:bg-[var(--border)]/20"
              >
                Fechar
              </button>
            </div>
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <h3 className="font-semibold mb-1">Nova requisição</h3>
                <p className="opacity-80">
                  Solicitação recém-criada, aguardando início das análises.
                </p>
              </div>
              <div>
                <h3 className="font-semibold mb-1">Em análise</h3>
                <p className="opacity-80">
                  Nossa equipe está conferindo os dados e documentos para
                  prosseguir.
                </p>
              </div>
              <div>
                <h3 className="font-semibold mb-1">Aprovado</h3>
                <p className="opacity-80">
                  A solicitação foi aprovada e o processo segue para o Kanban.
                </p>
              </div>
              <div>
                <h3 className="font-semibold mb-1">Rejeitado</h3>
                <p className="opacity-80">
                  A solicitação não atendeu aos critérios. O histórico permanece
                  disponível.
                </p>
              </div>
              <div>
                <h3 className="font-semibold mb-1">Ativos</h3>
                <p className="opacity-80">
                  Acompanhamento ativo junto à concessionária ou órgão
                  responsável.
                </p>
              </div>
              <div>
                <h3 className="font-semibold mb-1">Deferidos</h3>
                <p className="opacity-80">
                  Decisão favorável; seguimos com os trâmites de ressarcimento.
                </p>
              </div>
              <div>
                <h3 className="font-semibold mb-1">Fluxo de Ressarcimento</h3>
                <p className="opacity-80">
                  Etapas para crédito simples/dobro, conciliações e validações
                  necessárias.
                </p>
              </div>
              <div>
                <h3 className="font-semibold mb-1">Faturamento</h3>
                <p className="opacity-80">
                  Emissão e conferência de documentos financeiros para o
                  crédito.
                </p>
              </div>
              <div>
                <h3 className="font-semibold mb-1">Concluídos</h3>
                <p className="opacity-80">
                  Processo finalizado; você pode consultar todo o histórico.
                </p>
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
              <button
                onClick={() => setShowHelp(false)}
                className="px-3 py-2 rounded border border-[var(--border)]"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

