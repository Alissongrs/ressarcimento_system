// src/pages/DetalhesRequisicao.jsx
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Clock, Paperclip, RefreshCw } from 'lucide-react';
import {
  getHistoricoById,
  atualizarRequisicaoCompleta,
  getRequisicaoById,
  buscarFaturasPorUnidadeMeses,
} from '../services/requisicaoService';
import api from '../services/api';
import {
  getTiposIrregularidade,
  getSubtiposIrregularidade,
} from '../services/irregularidadeService';

/* ======================= HELPERS GERAIS ======================= */

const toStr = (v, fallback = '') => {
  if (v == null) return fallback;
  if (typeof v === 'object') {
    if ('String' in v) return v.String ?? fallback;
    if ('Valid' in v && v.Valid === false) return fallback;
  }
  return String(v);
};

const keyOf = (obj, idx) =>
  obj?.id_historico ??
  obj?.id ??
  obj?.ID ??
  `${idx}-${Math.random().toString(36).slice(2, 7)}`;

const formatDateTime = (iso) => {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });
  } catch {
    return '-';
  }
};

const normalize = (s) => {
  try {
    return (s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  } catch {
    return String(s || '').toLowerCase();
  }
};

// CorreÃ§Ãµes simples de mojibake exibidas no histórico/comentÃ¡rios
const fixMojibake = (s) => {
  try {
    let out = String(s || '');
    const map = [
      ['CriaÃ£o da requisiÃ£o', 'CriaÃ§Ã£o da requisição'],
      ['CriaÃ§Ã£o da eequisiÃ§Ã£o', 'CriaÃ§Ã£o da requisição'],
      ['Cria??o da requisi??o', 'CriaÃ§Ã£o da requisição'],
      ['Cria?o da requisi?o', 'CriaÃ§Ã£o da requisição'],
    ];
    for (const [bad, good] of map) {
      if (out.includes(bad)) out = out.split(bad).join(good);
    }
    return out;
  } catch {
    return s;
  }
};

// Formata Números para moeda BRL com robustez a strings
const formatCurrencyBRL = (value) => {
  try {
    const raw = toStr(value, '');
    if (!raw) return '-';
    const normalized = String(raw).replace(/\./g, '').replace(',', '.');
    const n = Number(normalized);
    if (!isFinite(n)) return '-';
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(n);
  } catch {
    return '-';
  }
};

/* ======================= UPLOADS / ANEXOS ======================= */

/**
 * Monta a URL absoluta de um arquivo de upload.
 * Sempre usa o domÃ­nio atual (ex.: https://sure.app.br/uploads/...)
 * mesmo que o backend ou a VITE_API_BASE_URL ainda falem em localhost.
 */
function makeUploadHref(path) {
  if (!path) return '';
  const s = String(path).trim();

  // Se jÃ¡ Ã© URL absoluta, retorna como estÃ¡
  if (/^https?:\/\//i.test(s)) return s;

  const clean = s.replace(/^\/+/, '').replace(/\\/g, '/');
  const rel = clean.startsWith('uploads/') ? clean : `uploads/${clean}`;

  // Origem: prioriza o host atual do browser
  let origin = '';
  if (typeof window !== 'undefined' && window.location?.origin) {
    origin = window.location.origin;
  } else {
    // Fallbacks (SSR/build, etc.)
    try {
      const base = (api?.defaults?.baseURL || '').toString();
      if (/^https?:\/\//.test(base)) {
        origin = new URL(base).origin;
      }
    } catch {}
    if (!origin) {
      try {
        const raw = (import.meta?.env?.VITE_API_BASE_URL ?? '')
          .toString()
          .trim();
        if (/^https?:\/\//.test(raw)) {
          origin = new URL(raw).origin;
        }
      } catch {}
    }
    if (!origin) origin = 'http://localhost:8080';
  }

  return `${origin.replace(/\/$/, '')}/${rel}`;
}

/* ======================= PERÍODOS / FATURAS ======================= */

/**
 * Extrai períodos de irregularidade de um "detalhe" de requisição.
 * Retorna:
 *  - mesesRefs: ['2024-08', '2024-09']  -> usado na chamada da API
 *  - labels:    ['08/2024', '09/2024'] -> exibido na UI
 */
function extractPeriodosFromDetalhe(detalhe) {
  if (!detalhe) return { mesesRefs: [], labels: [] };

  const raw =
    detalhe.periodos_irregularidade ??
    detalhe.periodosIrregularidade ??
    detalhe.PeriodosIrregularidade ??
    null;

  if (!raw) return { mesesRefs: [], labels: [] };

  let arr = [];
  try {
    arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    arr = [];
  }

  if (!Array.isArray(arr)) return { mesesRefs: [], labels: [] };

  const mesesRefs = [];
  const labels = [];

  for (const p of arr) {
    const ano = String(p?.ano ?? p?.Ano ?? '').trim();
    const mes = String(p?.mes ?? p?.Mes ?? p?.MÃªs ?? '').trim();
    if (!ano || !mes) continue;
    const mm = String(mes).padStart(2, '0');
    mesesRefs.push(`${ano}-${mm}`); // para API
    labels.push(`${mm}/${ano}`); // para exibiÃ§Ã£o
  }

  return {
    mesesRefs: Array.from(new Set(mesesRefs)),
    labels: Array.from(new Set(labels)),
  };
}

/* ======================= COMPONENTE PRINCIPAL ======================= */

export default function DetalhesRequisicao() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [historico, setHistorico] = useState([]);
  const [loadingHistorico, setLoadingHistorico] = useState(false);

  const [tipos, setTipos] = useState([]);
  const [subtipos, setSubtipos] = useState([]);
  const [tipoId, setTipoId] = useState('');
  const [subtipoId, setSubtipoId] = useState('');

  const [comentario, setComentario] = useState('');
  const [salvando, setSalvando] = useState(false);

  const inputAnexoRef = useRef(null);
  const [anexos, setAnexos] = useState([]);

  const [statusReq, setStatusReq] = useState('');
  const [detalhe, setDetalhe] = useState(null);

  const [ucLinks, setUcLinks] = useState([]); // faturas retornadas pela API
  const [faturasSelecionadas, setFaturasSelecionadas] = useState([]);

  // Períodos extraÃ­dos da prÃ³pria requisição
  const { mesesRefs, labels: periodLabels } = useMemo(
    () => extractPeriodosFromDetalhe(detalhe),
    [detalhe],
  );

  // Lista que de fato aparece como "Fatura" (link + mes_ref normalizado)
  const invoiceItems = useMemo(() => {
    try {
      if (!Array.isArray(ucLinks) || ucLinks.length === 0) return [];
      return ucLinks
        .map((it) => ({
          href: toStr(it.link || it.Link),
          mes_ref: toStr(it.mes_ref || it.MesRef || ''),
          dt_vencimento:
            it.dt_vencimento ||
            it.Dt_Vencimento ||
            it.data_vencimento ||
            it.Data_Vencimento ||
            '',
          valor_total:
            it.valor_total ||
            it.Valor_Total ||
            it.valor ||
            it.Valor ||
            null,
        }))
        .filter((it) => it.href);
    } catch {
      return [];
    }
  }, [ucLinks]);

  const selectedInvoiceItems = useMemo(() => {
    if (!Array.isArray(faturasSelecionadas) || faturasSelecionadas.length === 0) {
      return [];
    }
    return faturasSelecionadas
      .map((f) => ({
        href: toStr(f.link || f.Link || f.url || f.URL),
        mes_ref: toStr(f.mes_ref || f.MesRef || ''),
        dt_vencimento:
          f.dt_vencimento ||
          f.Dt_Vencimento ||
          f.data_vencimento ||
          f.Data_Vencimento ||
          '',
        valor_total:
          f.valor_total ||
          f.Valor_Total ||
          f.valor ||
          f.Valor ||
          null,
      }))
      .filter((it) => it.href);
  }, [faturasSelecionadas]);

  const allInvoiceItems = useMemo(() => {
    const map = new Map();
    for (const it of [...invoiceItems, ...selectedInvoiceItems]) {
      if (!it?.href) continue;
      if (!map.has(it.href)) map.set(it.href, it);
    }
    return Array.from(map.values());
  }, [invoiceItems, selectedInvoiceItems]);

  const carregarHistorico = useCallback(async () => {
    setLoadingHistorico(true);
    try {
      const data = await getHistoricoById(id);
      setHistorico(Array.isArray(data) ? data : []);
    } catch {
      setHistorico([]);
    } finally {
      setLoadingHistorico(false);
    }
  }, [id]);

  // Carrega detalhes da requisição (cabeÃ§alho) + status atual (1 request sÃ³)
  useEffect(() => {
    (async () => {
      try {
        const data = await getRequisicaoById(id);
        const first = Array.isArray(data) ? data[0] : data;
        setDetalhe(first || null);
        setStatusReq(String(first?.status || ''));
      } catch {
        setDetalhe(null);
        setStatusReq('');
      }
    })();
  }, [id]);

  useEffect(() => {
    carregarHistorico();
  }, [carregarHistorico]);

  // Busca links de faturas vÃ¡lidos com base nos períodos da requisição (se houver) e UC
  useEffect(() => {
    (async () => {
      try {
        // Faturas selecionadas na criaÃ§Ã£o (se houver)
        try {
          const resp = await api.get(`/requisicoes/${id}/faturas`);
          const lista = Array.isArray(resp?.data?.faturas) ? resp.data.faturas : [];
          setFaturasSelecionadas(lista);
        } catch { setFaturasSelecionadas([]); }

        const ucStr = toStr(detalhe?.uc || detalhe?.UC || '').trim();

        if (!ucStr || !mesesRefs.length) {
          setUcLinks([]);
          return;
        }

        const dados = await buscarFaturasPorUnidadeMeses(ucStr, mesesRefs);

        let list = [];

        if (Array.isArray(dados?.faturas) && dados.faturas.length > 0) {
          list = dados.faturas.map((f) => ({
            link: toStr(f.Link || f.link),
            mes_ref: toStr(f.MesRef || f.mes_ref || ''),
            dt_vencimento:
              f.Dt_Vencimento ||
              f.dt_vencimento ||
              f.data_vencimento ||
              f.Data_Vencimento ||
              '',
            valor_total:
              f.Valor_Total ||
              f.valor_total ||
              f.valor ||
              f.Valor ||
              null,
          }));
        } else if (
          Array.isArray(dados?.links_faturas_detalhes) &&
          dados.links_faturas_detalhes.length > 0
        ) {
          list = dados.links_faturas_detalhes;
        } else if (
          Array.isArray(dados?.links_faturas) &&
          dados.links_faturas.length > 0
        ) {
          list = dados.links_faturas.map((l) => ({
            link: toStr(l),
            mes_ref: '',
          }));
        } else if (Array.isArray(dados) && dados.length > 0) {
          // Caso a API retorne um array direto
          list = dados.map((x) =>
            typeof x === 'string' ? { link: toStr(x), mes_ref: '' } : x,
          );
        }

        setUcLinks(list);
      } catch {
        setUcLinks([]);
      }
    })();
  }, [detalhe, mesesRefs]);

  // Tipos irregularidade
  useEffect(() => {
    (async () => {
      try {
        const t = await getTiposIrregularidade();
        setTipos(Array.isArray(t) ? t : []);
      } catch {
        setTipos([]);
      }
    })();
  }, []);

  // Subtipos
  useEffect(() => {
    (async () => {
      if (!tipoId) {
        setSubtipos([]);
        return;
      }
      try {
        const s = await getSubtiposIrregularidade(tipoId);
        setSubtipos(Array.isArray(s) ? s : []);
      } catch {
        setSubtipos([]);
      }
    })();
  }, [tipoId]);

  // Status atual (prefere o status da requisição)
  const statusAtual = useMemo(() => {
    if (statusReq) return String(statusReq);
    if (!historico || historico.length === 0) return '';
    const h = historico[0] || {};
    const to = (v) => (v ? String(v) : '');
    return to(h.status_novo || h.status_composto || h.etapa_nova || '');
  }, [historico, statusReq]);

  const statusNorm = useMemo(() => normalize(statusAtual), [statusAtual]);
  const isLocked =
    statusNorm === 'aprovado' ||
    statusNorm === 'rejeitado' ||
    statusNorm === 'aprovada' ||
    statusNorm === 'rejeitada';

  const tipoLabel = useMemo(() => {
    if (tipoId) {
      const t = tipos.find((x) => String(x.id || x.ID) === String(tipoId));
      if (t) return toStr(t.nome || t.Nome || t.descricao || t.Descricao);
    }
    return toStr(
      detalhe?.tipo_irregularidade ||
        detalhe?.irregularidade_padrao ||
        detalhe?.irregularidade,
      '',
    );
  }, [tipoId, tipos, detalhe]);

  const subtipoLabel = useMemo(() => {
    if (subtipoId) {
      const s = subtipos.find((x) => String(x.id || x.ID) === String(subtipoId));
      if (s) return toStr(s.nome || s.Nome || s.descricao || s.Descricao);
    }
    return toStr(
      detalhe?.subtipo_irregularidade ||
        detalhe?.sub_irregularidade ||
        detalhe?.subtipo,
      '',
    );
  }, [subtipoId, subtipos, detalhe]);

  const salvarClassificacao = async () => {
    setSalvando(true);
    try {
      const fd = new FormData();
      if (comentario?.trim()) fd.append('comentario', comentario.trim());
      if (tipoId) fd.append('id_tipo_irregularidade', String(tipoId));
      if (subtipoId) fd.append('id_subtipo_irregularidade', String(subtipoId));
      anexos.forEach((f) => fd.append('anexos', f));

      await atualizarRequisicaoCompleta(id, fd);

      setComentario('');
      setAnexos([]);
      if (inputAnexoRef.current) inputAnexoRef.current.value = '';

      await carregarHistorico();

      alert('Classificação/observaÃ§Ãµes salvas.');
    } catch {
      alert('NÃ£o foi possÃ­vel salvar.');
    } finally {
      setSalvando(false);
    }
  };

  const showStatusError = (error, fallback) => {
    const message =
      error?.response?.data?.error ||
      error?.response?.data?.message ||
      error?.message ||
      fallback ||
      'NÃ£o foi possÃ­vel atualizar o status.';
    alert(message);
  };

  const handleStatusChange = useCallback(
    async (statusValue, successMessage) => {
      if (isLocked) return;
      const fd = new FormData();
      fd.append('status', statusValue);
      if (tipoId) fd.append('id_tipo_irregularidade', String(tipoId));
      if (subtipoId) fd.append('id_subtipo_irregularidade', String(subtipoId));

      try {
        await atualizarRequisicaoCompleta(id, fd);
        await carregarHistorico();
        try {
          const det = await getRequisicaoById(id);
          const first = Array.isArray(det) ? det[0] : det;
          setStatusReq(String(first?.status || ''));
        } catch {}
        alert(successMessage);
      } catch (error) {
        showStatusError(error, 'NÃ£o foi possÃ­vel atualizar o status.');
      }
    },
    [carregarHistorico, id, isLocked, tipoId, subtipoId],
  );

  return (
    <div className="max-w-6xl mx-auto p-6 text-[var(--fg)]">
      <div className="mb-6 flex items-center justify-between">
        <button
          onClick={() => navigate(-1)}
          className="px-3 py-2 rounded btn-neutral"
        >
          Voltar
        </button>

        <h1 className="text-2xl font-bold">
          Detalhes da Requisição #{id}
        </h1>

        <button
          onClick={carregarHistorico}
          className="px-3 py-2 rounded btn-neutral flex items-center gap-2"
        >
          <RefreshCw size={16} /> Atualizar
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Coluna principal: histórico */}
        <div className="lg:col-span-2 glass-card border border-[var(--border)] rounded-lg p-4">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Clock size={16} /> Histórico
          </h2>

          <div>
            {/* Blocos fixos sempre visÃ­veis */}
            {detalhe && (
              <div className="border-l-2 border-[var(--accent)] pl-4 pb-4 mb-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="px-2 py-1 rounded text-xs font-medium text-[var(--fg)] glass-card border border-[var(--border)]">
                    Informações
                  </span>
                </div>

                <ul className="text-sm space-y-1">
                  <li>
                    <span className="opacity-70">UC: </span>
                    <span className="font-medium">
                      {toStr(detalhe?.uc || detalhe?.UC) || '-'}
                    </span>
                  </li>
                  <li>
                    <span className="opacity-70">Cliente: </span>
                    <span className="font-medium">
                      {toStr(detalhe?.cliente) || '-'}
                    </span>
                  </li>
                  <li>
                    <span className="opacity-70">Concessionária: </span>
                    <span className="font-medium">
                      {toStr(detalhe?.concessionaria) || '-'}
                    </span>
                  </li>
                  <li>
                    <span className="opacity-70">Valor estimado: </span>
                    <span className="font-medium">
                      {formatCurrencyBRL(
                        detalhe?.valor_estimado ??
                          detalhe?.ressarcimento_estimado ??
                          detalhe?.valorEstimado,
                      )}
                    </span>
                  </li>
                  <li>
                    <span className="opacity-70">Criado em: </span>
                    <span className="font-medium">
                      {formatDateTime(
                        detalhe?.data_criacao ||
                          detalhe?.created_at ||
                          detalhe?.CreatedAt,
                      )}
                    </span>
                  </li>
                  <li>
                    <span className="opacity-70">Descrição: </span>
                    <span className="font-medium">
                      {toStr(
                        detalhe?.descricao_irregularidade ||
                          detalhe?.descricaoIrregularidade,
                      ) || '-'}
                    </span>
                  </li>
                </ul>
              </div>
            )}

            {/* Anexos da requisição */}
            <RequisicaoAnexos requisicaoId={id} />

            {/* Faturas (selecionadas por perÃ­odo) */}
            {(allInvoiceItems.length > 0 || periodLabels.length > 0) && (
              <div className="border-l-2 border-[var(--accent)] pl-4 pb-4 mb-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="px-2 py-1 rounded text-xs font-medium text-[var(--fg)] glass-card border border-[var(--border)]">
                    Fatura
                  </span>
                </div>

                {/* Períodos selecionados (vÃªm da prÃ³pria requisição) */}
                {periodLabels.length > 0 && (
                  <div className="text-xs opacity-80 mb-2">
                    Períodos selecionados:{' '}
                    {periodLabels.join(', ')}
                  </div>
                )}

                {/* Lista de faturas retornadas pela API */}
                <div className="text-sm mb-1 space-y-1">
                  {allInvoiceItems.length === 0 ? (
                    <div className="opacity-70">
                      Nenhuma fatura encontrada para os períodos
                      desta requisição.
                    </div>
                  ) : (
                    allInvoiceItems.map((it, i) => (
                      <div
                        key={`${it.href}-${i}`}
                        className="flex flex-col gap-1 mb-1"
                      >
                        <div className="flex gap-2 items-center flex-wrap">
                          {it.mes_ref && (
                            <span className="text-xs opacity-70 shrink-0">
                              {it.mes_ref}
                            </span>
                          )}
                          <a
                            className="text-[var(--accent)] underline break-all"
                            href={it.href}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {it.href}
                          </a>
                        </div>
                        <div className="text-xs opacity-70 flex gap-3 flex-wrap">
                          {it.dt_vencimento && (
                            <span>
                              Vencimento:{' '}
                              {toStr(it.dt_vencimento)}
                            </span>
                          )}
                          {it.valor_total != null &&
                            it.valor_total !== '' && (
                              <span>
                                Valor:{' '}
                                {formatCurrencyBRL(
                                  it.valor_total,
                                )}
                              </span>
                            )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}


            {(tipoLabel || subtipoLabel) && (
              <div className="border-l-2 border-[var(--accent)] pl-4 pb-4 mb-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="px-2 py-1 rounded text-xs font-medium text-[var(--fg)] glass-card border border-[var(--border)]">
                    Classificação
                  </span>
                </div>
                <div className="text-sm">
                  Irregularidade: {tipoLabel || '-'} | Sub irregularidade: {subtipoLabel || '-'}
                </div>
              </div>
            )}
            {/* Histórico */}
            {loadingHistorico ? (
              <div className="flex items-center justify-center py-8">
                <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
              </div>
            ) : Array.isArray(historico) && historico.length > 0 ? (
              <div className="space-y-4">
                {historico.map((h, idx) => {
                  const usuario = toStr(
                    h.nome_usuario || h.usuario_nome || 'Sistema',
                  );
                  const data = formatDateTime(
                    h.data_movimentacao || h.dataMovimentacao,
                  );
                  const label =
                    h.status_composto ||
                    `${toStr(h.etapa_nova || '')}${
                      h.sub_etapa ? ' - ' + toStr(h.sub_etapa) : ''
                    }`;
                  const comentarioTxt = fixMojibake(
                    toStr(h.comentario),
                  ).trim();
                  if (!comentarioTxt && !label) return null;

                  return (
                    <div
                      key={keyOf(h, idx)}
                      className="border-l-2 border-[var(--accent)] pl-4 pb-4"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="px-2 py-1 rounded text-xs font-medium text-[var(--fg)] glass-card border border-[var(--border)]">
                          {label}
                        </span>
                      </div>
                      {comentarioTxt && (
                        <p className="text-sm text-[var(--fg)] mb-1">
                          {comentarioTxt}
                        </p>
                      )}
                      <p className="text-xs opacity-70">
                        {usuario} às {data}
                      </p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="opacity-70">
                Nenhum registro encontrado.
              </p>
            )}
          </div>
        </div>

        {/* Coluna lateral: aÃ§Ãµes rÃ¡pidas e classificaÃ§Ã£o */}
        <div className="lg:col-span-1 glass-card border border-[var(--border)] rounded-lg p-4 sticky top-24 self-start">
          <h2 className="text-lg font-semibold mb-4">
            Classificação de Irregularidade
          </h2>

          <div className="flex gap-2 mb-6">
            <button
              disabled={isLocked}
              onClick={() =>
                handleStatusChange('Em Análise', 'Movido para Em Análise')
              }
              className="px-3 py-2 bg-[var(--accent)] rounded hover:opacity-90 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Em Análise
            </button>

            <button
              disabled={isLocked}
              onClick={() => handleStatusChange('Aprovado', 'Aprovado')}
              className="px-3 py-2 bg-[var(--success)] rounded hover:opacity-90 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Aprovar
            </button>

            <button
              disabled={isLocked}
              onClick={() => handleStatusChange('Rejeitado', 'Rejeitado')}
              className="px-3 py-2 bg-[var(--danger)] rounded hover:opacity-90 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Rejeitar
            </button>
          </div>

          <h2 className="text-lg font-semibold mb-4">
            Classificação da Irregularidade
          </h2>

          <label className="block text-sm mb-1">Tipo</label>
          <select
            value={tipoId}
            onChange={(e) => {
              setTipoId(e.target.value);
              setSubtipoId('');
            }}
            className="w-full p-2 rounded glass-select border mb-3"
          >
            <option value="">Selecione.</option>
            {tipos.map((t, i) => (
              <option key={keyOf(t, i)} value={t.id || t.ID}>
                {toStr(
                  t.nome || t.Nome || t.descricao || t.Descricao,
                )}
              </option>
            ))}
          </select>

          <label className="block text-sm mb-1">Subtipo</label>
          <select
            value={subtipoId}
            onChange={(e) => setSubtipoId(e.target.value)}
            disabled={!tipoId}
            className="w-full p-2 rounded glass-select border mb-4 disabled:opacity-50"
          >
            <option value="">Selecione.</option>
            {subtipos.map((s, i) => (
              <option key={keyOf(s, i)} value={s.id || s.ID}>
                {toStr(
                  s.nome || s.Nome || s.descricao || s.Descricao,
                )}
              </option>
            ))}
          </select>

          <label className="block text-sm mb-1">Observações</label>
          <textarea
            value={comentario}
            onChange={(e) => setComentario(e.target.value)}
            rows={4}
            className="w-full p-2 rounded glass-select border mb-3"
            placeholder="Digite um comentário."
          />

          <div className="mb-3">
            <input
              ref={inputAnexoRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) =>
                setAnexos(Array.from(e.target.files || []))
              }
            />
            <button
              type="button"
              onClick={() => inputAnexoRef.current?.click()}
              className="px-3 py-2 btn-neutral rounded flex items-center gap-2"
            >
              <Paperclip size={16} /> Anexar arquivos
            </button>

            {anexos.length > 0 && (
              <ul className="mt-2 space-y-1 text-sm">
                {anexos.map((f, idx) => (
                  <li
                    key={`${f.name}-${idx}`}
                    className="flex items-center justify-between"
                  >
                    <span className="truncate pr-2">
                      {f.name}
                    </span>
                    <button
                      onClick={() =>
                        setAnexos((arr) =>
                          arr.filter((_, i) => i !== idx),
                        )
                      }
                      className="text-red-300 hover:text-red-200 text-xs"
                    >
                      remover
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <button
            onClick={salvarClassificacao}
            disabled={salvando || !tipoId}
            className="w-full px-4 py-2 btn-accent rounded-lg hover:opacity-90 disabled:opacity-50"
          >
            {salvando
              ? 'salvandoâ€¦'
              : 'Salvar Classificação e Observações'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ======================= SUBCOMPONENTE: ANEXOS ======================= */

function RequisicaoAnexos({ requisicaoId }) {
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    if (!requisicaoId) return;
    (async () => {
      setLoading(true);
      setErr('');
      try {
        const { data } = await api.get(
          `/requisicoes/${encodeURIComponent(
            requisicaoId,
          )}/anexos`,
        );
        setItems(Array.isArray(data) ? data : []);
      } catch {
        setErr('Falha ao carregar anexos');
        setItems([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [requisicaoId]);

  if (loading) return null;

  return (
    <div className="border-l-2 border-[var(--accent)] pl-4 pb-4 mb-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="px-2 py-1 rounded text-xs font-medium text-[var(--fg)] glass-card border border-[var(--border)]">
          Anexos
        </span>
      </div>

      {err ? (
        <div className="text-sm opacity-70">
          Falha ao carregar anexos.
        </div>
      ) : !Array.isArray(items) || items.length === 0 ? (
        <div className="text-sm opacity-70">Não há anexos.</div>
      ) : (
        <ul className="text-sm space-y-1">
          {items.map((a, i) => {
            const href = makeUploadHref(
              a.caminho_arquivo ||
                a.caminho ||
                a.path ||
                a.url,
            );
            const nome =
              a.nome_arquivo ||
              a.nome ||
              'arquivo';

            return (
              <li
                key={`${a.id || a.ID || i}`}
                className="break-all"
              >
                <a
                  className="text-[var(--accent)] underline"
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                >
                  {nome}
                </a>
                {a.data_upload && (
                  <span className="opacity-70 text-xs">
                    {' '}
                    às {formatDateTime(a.data_upload)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}




