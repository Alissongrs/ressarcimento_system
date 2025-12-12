// src/pages/Requisicoes.jsx
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import {
  getAllRequisicoes,
  getRequisicaoById,
  buscarFaturasPorUnidadeMeses,
} from '../services/requisicaoService';
import {
  Plus,
  Search,
  Paperclip,
  FileText,
  CalendarDays,
  Link as LinkIcon,
} from 'lucide-react';

function Badge({ children, color = 'gray' }) {
  const map = {
    gray: { bg: '#E5E7EB', fg: '#374151' },
    blue: { bg: '#DBEAFE', fg: '#1D4ED8' },
    green: { bg: '#D1FAE5', fg: '#065F46' },
    amber: { bg: '#FEF3C7', fg: '#92400E' },
    red: { bg: '#FEE2E2', fg: '#991B1B' },
  };
  const c = map[color] || map.gray;
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold"
      style={{ background: c.bg, color: c.fg }}
    >
      {children}
    </span>
  );
}

const fmtBRL = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 'R$ 0,00';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

export default function Requisicoes() {
  const [items, setItems] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({}); // { [id]: { anexos:number, faturas:number, periodo:string } }
  const [modal, setModal] = useState({
    open: false,
    type: null,
    title: '',
    rows: [],
    loading: false,
    previewUrl: '',
    periodo: '',
    anchorX: null,
    anchorY: null,
  });
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      try {
        setErr('');
        setLoading(true);
        let list = [];
        try {
          const rows = await getAllRequisicoes();
          list = Array.isArray(rows) ? rows : [];
        } catch (e) {
          // Se nao for gestor/admin (403), mostra apenas as requisicoes do proprio usuario
          const status = e?.response?.status;
          if (status === 403 || status === 401) {
            const mine = await (await import('../services/requisicaoService')).getMinhasRequisicoes(true);
            list = Array.isArray(mine) ? mine : [];
          } else {
            throw e;
          }
        }
        setItems(list);
        setTotal(list.length);
        try {
          console.info('[Requisicoes] carregadas:', list.length);
        } catch {}

        // Enriquecer contagens de anexos/faturas com concorrência limitada
        const ids = list
          .map((r) => r.id || r.id_requisicao || r.ID)
          .filter(Boolean);
        let index = 0;
        const limit = 4;

        const worker = async () => {
          while (index < ids.length) {
            const i = index++;
            const id = ids[i];
            try {
              const anex = await api.get(`/requisicoes/${id}/anexos`);
              const anexosCount = Array.isArray(anex?.data)
                ? anex.data.length
                : 0;

              const det = await getRequisicaoById(id);
              const uc = det?.uc || det?.UC || '';
              let periodoLabel = '';
              let faturasCount = 0;
              try {
                let arr = [];
                const raw =
                  det?.periodos_irregularidade ||
                  det?.PeriodosIrregularidade ||
                  '';
                if (raw) arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
                const refs = Array.isArray(arr)
                  ? arr
                      .map((p) => {
                        const y = String(p?.ano ?? p?.Ano ?? '').trim();
                        const m = String(p?.mes ?? p?.Mes ?? '').trim();
                        if (!y || !m) return null;
                        return `${y}-${String(m).padStart(2, '0')}`;
                      })
                      .filter(Boolean)
                  : [];
                if (uc && refs.length) {
                  const dados = await buscarFaturasPorUnidadeMeses(uc, refs);
                  if (Array.isArray(dados?.faturas))
                    faturasCount = dados.faturas.length;
                  else if (Array.isArray(dados?.links_faturas_detalhes))
                    faturasCount = dados.links_faturas_detalhes.length;
                  else if (Array.isArray(dados?.links_faturas))
                    faturasCount = dados.links_faturas.length;
                  const sorted = [...refs].sort();
                  if (sorted.length)
                    periodoLabel = `${sorted[0]} a ${
                      sorted[sorted.length - 1]
                    }`;
                }
              } catch {}
              setCounts((prev) => ({
                ...prev,
                [id]: {
                  anexos: anexosCount,
                  faturas: faturasCount,
                  periodo: periodoLabel,
                },
              }));
            } catch {
              setCounts((prev) => ({
                ...prev,
                [ids[i]]: { anexos: 0, faturas: 0, periodo: '' },
              }));
            }
          }
        };
        Promise.all(
          Array.from({ length: Math.min(limit, ids.length) }).map(() =>
            worker()
          )
        ).catch(() => {});
      } catch (e) {
        const msg =
          e?.response?.data?.detail ||
          e?.response?.data?.error ||
          e?.message ||
          'Falha ao carregar requisições.';
        setErr(String(msg));
        try {
          console.error('[Requisicoes] erro:', msg);
        } catch {}
        setItems([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    if (!q) return items;
    const t = q.toLowerCase();
    return items.filter((r) => {
      const s = [
        r.id,
        r.id_requisicao,
        r.ID,
        r.uc?.String || r.uc,
        r.cliente?.String || r.cliente,
        r.descricao || r.descricao_irregularidade,
      ]
        .map((x) => (x == null ? '' : String(x)))
        .join(' ');
      return s.toLowerCase().includes(t);
    });
  }, [items, q]);

  const normalize = (s) => {
    try {
      return String(s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    } catch {
      return String(s || '').toLowerCase();
    }
  };

  const statusToColumn = (s) => {
    const n = normalize(s);
    if (n.includes('nova')) return 'Nova Requisição';
    if (n.includes('anal')) return 'Em Análise';
    if (n.includes('aprov') || n.includes('proced')) return 'Aprovado';
    if (n.includes('rejeit') || n.includes('indefer') || n.includes('improced'))
      return 'Rejeitado';
    return 'Nova Requisição';
  };

  const grouped = useMemo(() => {
    const cols = {
      'Nova Requisição': [],
      'Em Análise': [],
      Aprovado: [],
      Rejeitado: [],
    };
    for (const r of filtered) {
      cols[statusToColumn(r.status)].push(r);
    }
    return cols;
  }, [filtered]);

  // Normaliza data de vencimento exibida nas faturas (aceita várias chaves)
  const getFaturaVenc = (f) => {
    const raw =
      f?.dt_vencimento ??
      f?.DtVencimento ??
      f?.Dt_Vencimento ??
      f?.data_vencimento ??
      f?.Data_Vencimento ??
      f?.DataVencimento ??
      f?.vencimento ??
      f?.Vencimento ??
      '';
    return raw || '-';
  };

  const renderCard = (r) => {
    const id = r.id || r.id_requisicao || r.ID || r.Id;
    const uc = r.uc?.String || r.uc || '-';
    const cliente = r.cliente?.String || r.cliente || '';
    const status = String(r.status || '').toLowerCase();
    const valor = r.ressarcimento_estimado || r.valor_estimado;
    const color = status.includes('aprov') || status.includes('proced')
      ? 'green'
      : status.includes('anal')
      ? 'amber'
      : status.includes('rejeit')
      ? 'red'
      : 'gray';
    const goDetalhes = () => navigate(`/requisicao/${id}`);

    return (
      <div
        key={id}
        onClick={goDetalhes}
        className="rounded-xl border border-[var(--border)] bg-[var(--card)] card-wide-80 cursor-pointer hover:shadow-md"
      >
        <div className="px-4 py-3 card-padding-wide">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-sm font-extrabold">
                REQ-{String(id).padStart(3, '0')}
              </h3>
              <Badge color="blue">UC {uc}</Badge>
              {status && (
                <Badge color={color}>{String(r.status || '')}</Badge>
              )}
            </div>
            <div
              className="text-right font-extrabold w-full md:w-auto md:ml-auto"
              style={{
                color:
                  color === 'green'
                    ? '#10B981'
                    : color === 'amber'
                    ? '#F59E0B'
                    : color === 'red'
                    ? '#EF4444'
                    : '#64748B',
              }}
            >
              {fmtBRL(valor)}
            </div>
          </div>
          {cliente && (
            <p className="mt-1 opacity-80 text-xs break-words">{cliente}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <button
              onClick={(e) => openAnexos(id, e)}
              className="px-2 py-1 rounded border border-[var(--panel-border)] bg-[var(--panel)] hover:opacity-90 inline-flex items-center gap-1"
            >
              <Paperclip size={12} /> Anexos {counts[id]?.anexos ?? '-'}
            </button>
            <button
              onClick={(e) => openFaturas(id, e)}
              className="px-2 py-1 rounded border border-[var(--panel-border)] bg-[var(--panel)] hover:opacity-90 inline-flex items-center gap-1"
            >
              <FileText size={12} /> Faturas {counts[id]?.faturas ?? '-'}{' '}
              {counts[id]?.periodo ? `(${counts[id].periodo})` : ''}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const closeModal = () =>
    setModal({
      open: false,
      type: null,
      title: '',
      rows: [],
      loading: false,
      previewUrl: '',
      periodo: '',
      anchorX: null,
      anchorY: null,
    });

  const openAnexos = async (id, ev) => {
    try {
      ev?.stopPropagation?.();
    } catch {}
    const rect = ev?.currentTarget?.getBoundingClientRect?.();
    const cx =
      ev && typeof ev.clientX === 'number'
        ? ev.clientX
        : rect
        ? rect.left + rect.width / 2
        : null;
    const cy =
      ev && typeof ev.clientY === 'number'
        ? ev.clientY
        : rect
        ? rect.top + rect.height / 2
        : null;
    const sx =
      typeof window !== 'undefined'
        ? window.scrollX || document.documentElement.scrollLeft || 0
        : 0;
    const sy =
      typeof window !== 'undefined'
        ? window.scrollY || document.documentElement.scrollTop || 0
        : 0;
    let anchorX = cx != null ? cx + sx : null;
    let anchorY = cy != null ? cy + sy : null;
    if (anchorX != null && typeof window !== 'undefined') {
      const minL = 40;
      const maxL = sx + window.innerWidth - 40;
      anchorX = Math.max(minL, Math.min(anchorX, maxL));
    }
    if (anchorY != null && typeof window !== 'undefined') {
      const minT = 40;
      const maxT = sy + window.innerHeight - 40;
      anchorY = Math.max(minT, Math.min(anchorY, maxT));
    }

    setModal({
      open: true,
      type: 'anexos',
      title: `Anexos REQ-${String(id).padStart(3, '0')}`,
      rows: [],
      loading: true,
      previewUrl: '',
      periodo: '',
      anchorX,
      anchorY,
    });

    try {
      const { data } = await api.get(`/requisicoes/${id}/anexos`);
      setModal((m) => ({
        ...m,
        rows: Array.isArray(data) ? data : [],
        loading: false,
      }));
    } catch {
      setModal((m) => ({ ...m, rows: [], loading: false }));
    }
  };

  // Helpers para URLs absolutas de anexos
  const resolveOrigin = () => {
    try {
      const base = (api?.defaults?.baseURL || '').toString().trim();
      if (/^https?:\/\//.test(base)) return new URL(base).origin;
    } catch {}
    try {
      const raw = (import.meta?.env?.VITE_API_BASE_URL ?? '')
        .toString()
        .trim();
      if (/^https?:\/\//.test(raw)) return new URL(raw).origin;
    } catch {}
    if (typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin;
    }
    return 'http://localhost';
  };

  const origin = resolveOrigin();

  const toHref = (path) => {
    if (!path) return '';
    let s = String(path).trim();

    // Se já é http(s) e NÃO é localhost/127.0.0.1, devolve direto
    const isHttp = /^https?:\/\//i.test(s);
    const isLocal =
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(s);

    if (isHttp && !isLocal) {
      return s;
    }

    // Se vier com http://localhost:8080/uploads/xxx, tira a origem e deixa só o caminho
    if (isHttp && isLocal) {
      try {
        const u = new URL(s);
        s = u.pathname || '';
      } catch {
        // se der erro, segue abaixo limpando manualmente
      }
    }

    s = s.replace(/^\/+/, '').replace(/\\/g, '/');
    const rel = s.startsWith('uploads/') ? s : `uploads/${s}`;
    return `${origin.replace(/\/$/, '')}/${rel}`;
  };

  const openFaturas = async (id, ev) => {
    try {
      ev?.stopPropagation?.();
    } catch {}
    const rect = ev?.currentTarget?.getBoundingClientRect?.();
    const cx =
      ev && typeof ev.clientX === 'number'
        ? ev.clientX
        : rect
        ? rect.left + rect.width / 2
        : null;
    const cy =
      ev && typeof ev.clientY === 'number'
        ? ev.clientY
        : rect
        ? rect.top + rect.height / 2
        : null;
    const sx =
      typeof window !== 'undefined'
        ? window.scrollX || document.documentElement.scrollLeft || 0
        : 0;
    const sy =
      typeof window !== 'undefined'
        ? window.scrollY || document.documentElement.scrollTop || 0
        : 0;
    let anchorX = cx != null ? cx + sx : null;
    let anchorY = cy != null ? cy + sy : null;
    if (anchorX != null && typeof window !== 'undefined') {
      const minL = 40;
      const maxL = sx + window.innerWidth - 40;
      anchorX = Math.max(minL, Math.min(anchorX, maxL));
    }
    if (anchorY != null && typeof window !== 'undefined') {
      const minT = 40;
      const maxT = sy + window.innerHeight - 40;
      anchorY = Math.max(minT, Math.min(anchorY, maxT));
    }

    setModal({
      open: true,
      type: 'faturas',
      title: `Faturas REQ-${String(id).padStart(3, '0')}`,
      rows: [],
      loading: true,
      previewUrl: '',
      periodo: '',
      anchorX,
      anchorY,
    });

    try {
      const det = await getRequisicaoById(id);
      const uc = det?.uc || det?.UC || '';
      let arr = [];
      const raw =
        det?.periodos_irregularidade || det?.PeriodosIrregularidade || '';
      if (raw) arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const refs = Array.isArray(arr)
        ? arr
            .map((p) => {
              const y = String(p?.ano ?? p?.Ano ?? '').trim();
              const m = String(p?.mes ?? p?.Mes ?? '').trim();
              if (!y || !m) return null;
              return `${y}-${String(m).padStart(2, '0')}`;
            })
            .filter(Boolean)
        : [];
      let rows = [];
      let periodoLabel = '';
      if (uc && refs.length) {
        const dados = await buscarFaturasPorUnidadeMeses(uc, refs);
        if (Array.isArray(dados?.faturas))
          rows = dados.faturas.map((f) => ({
            mes_ref: f.MesRef || f.mes_ref || '',
            link: f.Link || f.link || '',
            dt_vencimento:
              f.Dt_Vencimento || f.dt_vencimento || '',
            valor_total:
              f.Valor_Total || f.valor_total || null,
          }));
        else if (Array.isArray(dados?.links_faturas_detalhes))
          rows = dados.links_faturas_detalhes;
        else if (Array.isArray(dados?.links_faturas))
          rows = dados.links_faturas.map((l) => ({ link: l }));
        const sorted = [...refs].sort();
        if (sorted.length)
          periodoLabel = `${sorted[0]} a ${sorted[sorted.length - 1]}`;
      }
      setModal((m) => ({
        ...m,
        rows,
        loading: false,
        periodo: periodoLabel,
      }));
    } catch {
      setModal((m) => ({ ...m, rows: [], loading: false }));
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-screen-2xl mx-auto px-6 py-6">
        <div
          className="rounded-xl shadow-elevated p-4 mb-6 border-2"
          style={{
            background: 'var(--header-bg)',
            borderColor: 'var(--header-border)',
            color: 'var(--header-fg)',
          }}
        >
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-extrabold tracking-tight">
                Requisições
              </h1>
              <p className="opacity-90 text-sm">
                Gerenciamento de solicitações de ressarcimento
              </p>
            </div>
            <div className="text-sm opacity-90 mr-3">Total: {total}</div>
            <button
              onClick={() => navigate('/novo')}
              className="inline-flex items-center gap-2 px-3 py-2 rounded bg-[var(--card)] text-[var(--fg)] border border-[var(--border)] hover:opacity-90"
            >
              <Plus size={16} /> Nova Requisição
            </button>
          </div>
        </div>

        <div className="bg-[var(--card)] rounded-xl border border-[var(--border)] shadow-soft p-3 mb-6">
          <div className="flex items-center gap-3 px-2">
            <Search className="w-5 h-5 opacity-70" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar por UC, cliente, ID ou descrição..."
              className="flex-1 bg-transparent outline-none text-sm"
            />
          </div>
        </div>

        <div className="space-y-4">
          {loading && (
            <div className="text-sm opacity-70">Carregando...</div>
          )}

          {!loading && err && (
            <div className="text-sm text-red-600 border border-red-400 rounded p-2 bg-red-50/40">
              {err}
            </div>
          )}

          {!loading && !err && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
              {[
                'Nova Requisição',
                'Em Análise',
                'Aprovado',
                'Rejeitado',
              ].map((col) => (
                <div
                  key={col}
                  className="rounded-xl border border-[var(--border)] bg-[var(--panel)]"
                >
                  <div className="px-16 py-6 border-b border-[var(--border)] font-bold">
                    {col} ({grouped[col].length})
                  </div>
                  <div className="px-14 py-6 space-y-6">
                    {(col === 'Aprovado'
                      ? grouped[col].slice(0, 10)
                      : grouped[col]
                    ).map((r) => renderCard(r))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && !err && filtered.length === 0 && (
            <div className="opacity-70 border border-[var(--border)] rounded p-3">
              Nenhuma requisição encontrada.
              <div className="mt-1 text-xs">
                Dicas: confirme se há dados em FT_REQUISICOES, se você tem
                permissão (gestor/admin) e se os filtros/busca não estão
                restringindo o resultado.
              </div>
            </div>
          )}
        </div>
      </div>

      {modal.open && (
        <div className="fixed inset-0 bg-gray-100/90 z-50">
          <div
            className="bg-[var(--card)] text-[var(--fg)] border border-[var(--border)] rounded-xl w-full max-w-7xl shadow-elevated fixed"
            style={{
              top: modal.anchorY != null ? modal.anchorY : '50%',
              left:
                modal.anchorX != null
                  ? modal.anchorX + 400
                  : 'calc(50% + 400px)',
              transform: 'translate(-50%, -50%)',
            }}
          >
            <div className="px-4 py-3 border-b border-[var(--border)]">
              <h3 className="text-lg font-bold">{modal.title}</h3>
              {modal.type === 'faturas' && modal.periodo && (
                <div className="text-xs opacity-80 mt-1">
                  Período: {modal.periodo}
                </div>
              )}
            </div>

            <div className="p-4 max-h-[90vh] overflow-auto space-y-2">
              {modal.loading && (
                <div className="opacity-70">Carregando...</div>
              )}

              {!modal.loading && modal.type === 'anexos' && (
                <div className="space-y-2">
                  {modal.rows.length === 0 && (
                    <div className="opacity-70">Sem anexos.</div>
                  )}
                  {modal.rows.map((a) => (
                    <div
                      key={a.id || a.ID || a.nome_arquivo}
                      className="flex items-center justify-between gap-3 rounded border border-[var(--panel-border)] px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <Paperclip size={16} />
                        <div>
                          <div className="text-sm font-medium">
                            {a.nome_arquivo || a.NomeArquivo}
                          </div>
                          <div className="text-xs opacity-70">
                            {a.enviado_por || a.EnviadoPor}{' '}
                            {a.data_upload ? `• ${a.data_upload}` : ''}
                          </div>
                        </div>
                      </div>
                      {(a.caminho_arquivo || a.CaminhoArquivo) && (
                        <a
                          className="inline-flex items-center gap-1 text-sm underline"
                          href={toHref(
                            a.caminho_arquivo || a.CaminhoArquivo
                          )}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <LinkIcon size={14} /> Abrir
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {!modal.loading && modal.type === 'faturas' && (
                <div className="space-y-3">
                  {modal.rows.length === 0 && (
                    <div className="opacity-70">Sem faturas.</div>
                  )}

                  {modal.rows.map((f, i) => {
                    const href = f.link || f.Link || '';
                    return (
                      <div
                        key={i}
                        className="flex items-center justify-between gap-3 rounded border border-[var(--panel-border)] px-3 py-2"
                      >
                        <div className="flex items-center gap-3">
                          <FileText size={16} />
                          <div>
                            <div className="text-sm font-medium">
                              {f.mes_ref || f.MesRef || 'Mês'}
                            </div>
                            <div className="text-xs opacity-70 inline-flex items-center gap-1">
                              <CalendarDays size={12} />{' '}
                              {getFaturaVenc(f)}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          {href && (
                            <button
                              onClick={() =>
                                setModal((m) => ({
                                  ...m,
                                  previewUrl: href,
                                }))
                              }
                              className="text-sm underline"
                            >
                              Visualizar
                            </button>
                          )}
                          {href && (
                            <a
                              className="inline-flex items-center gap-1 text-sm underline"
                              href={href}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <LinkIcon size={14} /> Abrir
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {modal.previewUrl && (
                    <div className="mt-2 rounded border border-[var(--panel-border)] overflow-hidden">
                      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--panel-border)]">
                        <a
                          href={modal.previewUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm underline inline-flex items-center gap-1"
                        >
                          <LinkIcon size={14} /> Abrir em nova aba
                        </a>
                        <button
                          onClick={() =>
                            setModal((m) => ({
                              ...m,
                              previewUrl: '',
                            }))
                          }
                          className="text-xs px-2 py-1 rounded border border-[var(--border)]"
                        >
                          Fechar visualização
                        </button>
                      </div>
                      <div className="h-[80vh] bg-[var(--panel)]">
                        <iframe
                          src={modal.previewUrl}
                          title="Fatura"
                          className="w-full h-full"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="px-4 py-3 border-t border-[var(--border)] text-right">
              <button
                onClick={closeModal}
                className="px-3 py-2 rounded border border-[var(--border)]"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
