// src/pages/TratativaAprovados.jsx
import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '../services/api';
import {
  getAllRequisicoes,
  getRequisicaoById,
  buscarFaturasPorUnidadeMeses,
  getHistoricoById,
  comentarProcesso,
  movimentarProcesso,
} from '../services/requisicaoService';
import { sendMailMessage, linkMailToProcess } from '../services/mailService';
import { deleteHistorico } from '../services/adminPlanilhaService';
import { Paperclip, FileText, Mail } from 'lucide-react';

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

const DEFAULT_CANAIS = {
  whatsapp: false,
  ligacao: false,
  email: false,
  sms: false,
  site: false,
  pessoal: false,
};

const CANAIS_UI = [
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'ligacao', label: 'Ligação' },
  { key: 'email', label: 'E-mail' },
  { key: 'sms', label: 'SMS' },
  { key: 'site', label: 'Site' },
  { key: 'pessoal', label: 'Pessoal' },
];

const CanaisSelector = React.memo(function CanaisSelector({
  canais,
  onToggle,
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {CANAIS_UI.map(({ key, label }) => {
        const ativo = !!canais?.[key];
        return (
          <button
            key={key}
            type="button"
            className={`sap-chip transition ${ativo ? 'sap-chip--active' : ''}`}
            onClick={() => onToggle(key)}
            title={`Registrar no histórico como ${label}`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
});

export default function TratativaAprovados() {
  const [items, setItems] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({});
  const [comentarios, setComentarios] = useState({});
  const [canaisById, setCanaisById] = useState({});
  const [savingById, setSavingById] = useState({});
  const [emailById, setEmailById] = useState({});
  const [historicoById, setHistoricoById] = useState({});
  const [historicoOpenById, setHistoricoOpenById] = useState({});
  const [historicoLoadingById, setHistoricoLoadingById] = useState({});
  const [emailOpenById, setEmailOpenById] = useState({});
  const navigate = useNavigate();
  const location = useLocation();
  const selectedId = useMemo(() => {
    try {
      const p = new URLSearchParams(location.search || '');
      const v = p.get('req');
      return v ? String(v) : '';
    } catch {
      return '';
    }
  }, [location.search]);

  useEffect(() => {
    loadRequisicoes();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const t = setTimeout(() => {
      const el = document.querySelector(`[data-req-id="${selectedId}"]`);
      if (el?.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
    return () => clearTimeout(t);
  }, [selectedId, items]);

  useEffect(() => {
    if (!selectedId) return;
    setHistoricoOpenById({ [selectedId]: true });
    setEmailOpenById({});
    loadHistorico(selectedId);
  }, [selectedId]);

  const loadRequisicoes = async () => {
    try {
      setErr('');
      setLoading(true);
      const rows = await getAllRequisicoes();
      const list = Array.isArray(rows) ? rows : [];
      setItems(list);
      setTotal(list.length);

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
                  periodoLabel = `${sorted[0]} a ${sorted[sorted.length - 1]}`;
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
        Array.from({ length: Math.min(limit, ids.length) }).map(() => worker())
      ).catch(() => {});
    } catch (e) {
      const msg =
        e?.response?.data?.detail ||
        e?.response?.data?.error ||
        e?.message ||
        'Falha ao carregar Requisições.';
      setErr(String(msg));
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

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

  const pickFirst = (obj, keys, fallback = '') => {
    for (const k of keys) {
      const v = obj?.[k];
      if (v != null && v !== '') return v;
      const s = obj?.[k]?.String;
      if (s != null && s !== '') return s;
    }
    return fallback;
  };

  const getEtapaAtual = (r) =>
    pickFirst(r, [
      'etapa_atual',
      'etapa',
      'Etapa Atual',
      'Etapa_Atual',
      'etapaAtual',
    ]);

  const getSubEtapaAtual = (r) =>
    pickFirst(r, [
      'sub_etapa',
      'sub_etapa_atual',
      'subetapa',
      'Sub_etapa',
      'Ultima Sub Etapa',
      'subEtapa',
    ]);

  const isAprovadoDistribuidora = (r) => {
    const status = normalize(r?.status);
    const procFlag = String(
      r?.processo_criado ?? r?.processoCriado ?? ''
    ).trim();
    const created =
      procFlag === '1' || procFlag.toLowerCase() === 'true';
    const etapa = normalize(getEtapaAtual(r));
    const sub = normalize(getSubEtapaAtual(r));
    const okEtapa = etapa ? etapa === 'distribuidora' : true;
    const okSub =
      sub ? sub === 'primeira reclamacao da etapa - em elaboracao' : true;
    return (status.includes('aprov') || status.includes('proced')) && !created && okEtapa && okSub;
  };

  const filtered = useMemo(() => {
    const needle = normalize(q);
    let list = items.filter((r) => isAprovadoDistribuidora(r));
    if (selectedId) {
      list = list.filter((r) => {
        const id = r.id || r.id_requisicao || r.ID || '';
        return String(id) === String(selectedId);
      });
    }
    if (!needle) return list;
    return list.filter((r) => {
      const id = r.id || r.id_requisicao || r.ID || '';
      const uc = r.uc?.String || r.uc || '';
      const cliente = r.cliente?.String || r.cliente || '';
      const status = r.status || '';
      const texto = `${id} ${uc} ${cliente} ${status}`.toLowerCase();
      return texto.includes(needle);
    });
  }, [items, q, selectedId]);

  const normalizeHistId = (h) =>
    h?.id_historico ?? h?.historico_id ?? h?.hist_id ?? h?.id ?? h?.ID ?? null;

  const fmtDate = (raw) => {
    if (!raw) return '';
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return String(raw);
    return d.toLocaleString('pt-BR');
  };

  const loadHistorico = async (id) => {
    if (historicoById[id] || historicoLoadingById[id]) return;
    setHistoricoLoadingById((prev) => ({ ...prev, [id]: true }));
    try {
      const hist = await getHistoricoById(id);
      setHistoricoById((prev) => ({ ...prev, [id]: hist || [] }));
    } catch {
      setHistoricoById((prev) => ({ ...prev, [id]: [] }));
    } finally {
      setHistoricoLoadingById((prev) => ({ ...prev, [id]: false }));
    }
  };

  const toggleHistorico = async (id) => {
    setHistoricoOpenById((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
    await loadHistorico(id);
  };

  const renderCard = (r) => {
    const id = r.id || r.id_requisicao || r.ID || r.Id;
    const uc = r.uc?.String || r.uc || '-';
    const cliente = r.cliente?.String || r.cliente || '';
    const valor = r.ressarcimento_estimado || r.valor_estimado;
    const goDetalhes = () => navigate(`/requisicao/${id}`);
    const isSelected = selectedId && String(id) === String(selectedId);

    return (
      <div
        key={id}
        data-req-id={id}
        onClick={goDetalhes}
        className={`rounded-xl border bg-[var(--card)] card-wide-80 cursor-pointer hover:shadow-md ${
          isSelected ? 'border-[var(--accent)] shadow-elevated' : 'border-[var(--border)]'
        }`}
      >
        <div className="px-4 py-3 card-padding-wide">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-sm font-extrabold">
                REQ-{String(id).padStart(3, '0')}
              </h3>
              <Badge color="blue">UC {uc}</Badge>
              <Badge color="green">Aprovado</Badge>
            </div>
            <div className="text-right font-extrabold w-full md:w-auto md:ml-auto" style={{ color: '#10B981' }}>
              {fmtBRL(valor)}
            </div>
          </div>
          {cliente && (
            <p className="mt-1 opacity-80 text-xs break-words">{cliente}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="px-2 py-1 rounded border border-[var(--panel-border)] bg-[var(--panel)] inline-flex items-center gap-1">
              <Paperclip size={12} /> Anexos {counts[id]?.anexos ?? '-'}
            </span>
            <span className="px-2 py-1 rounded border border-[var(--panel-border)] bg-[var(--panel)] inline-flex items-center gap-1">
              <FileText size={12} /> Faturas {counts[id]?.faturas ?? '-'}{' '}
              {counts[id]?.periodo ? `(${counts[id].periodo})` : ''}
            </span>
          </div>

          <div
            className="mt-4 border-t border-[var(--border)] pt-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-xs font-semibold mb-2">
              Tratativa da primeira reclamação
            </div>

            <textarea
              rows={3}
              value={comentarios[id] || ''}
              onChange={(e) =>
                setComentarios((prev) => ({
                  ...prev,
                  [id]: e.target.value,
                }))
              }
              placeholder="Comentário para o histórico"
              className="w-full p-2 rounded border border-[var(--panel-border)] bg-[var(--panel)] text-[var(--fg)] text-xs mb-2"
            />

            <div className="mb-3">
              <div className="text-[11px] font-semibold mb-1">
                Canais de comunicação
              </div>
              <CanaisSelector
                canais={canaisById[id] || DEFAULT_CANAIS}
                onToggle={(key) =>
                  setCanaisById((prev) => ({
                    ...prev,
                    [id]: {
                      ...(prev[id] || DEFAULT_CANAIS),
                      [key]: !(prev[id] || DEFAULT_CANAIS)[key],
                    },
                  }))
                }
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <button
                type="button"
                className="px-3 py-1.5 rounded border border-[var(--panel-border)] bg-[var(--panel)] hover:opacity-90 inline-flex items-center gap-1"
                onClick={async () => {
                  const payload = emailById[id] || {};
                  const to = String(payload.to || '').trim();
                  const subject = String(payload.subject || '').trim();
                  const body = String(payload.body || '').trim();
                  const files = payload.attachments || [];

                  if (!to) {
                    alert('Informe o destinatário.');
                    return;
                  }
                  if (!subject) {
                    alert('Informe o assunto.');
                    return;
                  }

                  setSavingById((prev) => ({ ...prev, [id]: true }));
                  try {
                    const fd = new FormData();
                    fd.append('to', to);
                    fd.append('subject', subject);
                    fd.append('body', body || ' ');
                    fd.append('body_type', 'HTML');
                    files.forEach((f) => fd.append('attachments', f));

                    const resp = await sendMailMessage(fd);
                    const data = resp?.data || resp || {};
                    const messageId =
                      data?.message_id ||
                      data?.messageId ||
                      data?.id ||
                      '';
                    if (!messageId) {
                      alert(
                        'E-mail enviado, mas não foi possível vincular automaticamente.'
                      );
                      return;
                    }
                    await linkMailToProcess(messageId, {
                      processoId: Number(id),
                      attachBodyPdf: true,
                      attachAttachments: true,
                      moveToLinkedFolderId: '',
                      note: 'E-mail enviado via Triagem de Requisição',
                    });
                    setEmailById((prev) => ({
                      ...prev,
                      [id]: { to: '', subject: '', body: '', attachments: [] },
                    }));
                    alert('E-mail enviado e vinculado ao processo.');
                  } catch (e) {
                    alert(
                      e?.response?.data?.error ||
                        e?.response?.data?.detail ||
                        e?.message ||
                        'Erro ao enviar e-mail.'
                    );
                  } finally {
                    setSavingById((prev) => ({ ...prev, [id]: false }));
                  }
                }}
              >
                <Mail size={14} /> Enviar email
              </button>

              <button
                type="button"
                className="px-3 py-1.5 rounded border border-[var(--panel-border)] bg-[var(--panel)] hover:opacity-90"
                disabled={savingById[id]}
                onClick={async () => {
                  if (
                    !confirm(
                      'Criar processo em Ativos (Distribuidora / Primeira reclamação - Em elaboração)?'
                    )
                  ) {
                    return;
                  }
                  setSavingById((prev) => ({ ...prev, [id]: true }));
                  try {
                    const fd = new FormData();
                    fd.append('etapa_atual', 'Distribuidora');
                    fd.append(
                      'sub_etapa',
                      'Primeira reclamação da etapa - Em elaboração'
                    );
                    fd.append(
                      'comentario',
                      'Processo criado em Ativos a partir de Requisições aprovadas.'
                    );
                    await movimentarProcesso(id, fd);
                    await loadRequisicoes();
                    alert('Processo movido para Ativos.');
                  } catch (e) {
                    alert(
                      e?.response?.data?.error ||
                        e?.response?.data?.detail ||
                        e?.message ||
                        'Erro ao mover processo.'
                    );
                  } finally {
                    setSavingById((prev) => ({ ...prev, [id]: false }));
                  }
                }}
              >
                Enviar para Ativos
              </button>

              <button
                type="button"
                className="px-3 py-1.5 rounded bg-[var(--accent)] text-[var(--fg)] font-semibold hover:opacity-90"
                disabled={savingById[id]}
                onClick={async () => {
                  const comentario = (comentarios[id] || '').trim();
                  const canaisSel = Object.entries(
                    canaisById[id] || DEFAULT_CANAIS
                  )
                    .filter(([, v]) => !!v)
                    .map(([k]) => k);

                  if (!comentario) {
                    alert('Informe um comentário para salvar no histórico.');
                    return;
                  }

                  setSavingById((prev) => ({ ...prev, [id]: true }));
                  try {
                    await comentarProcesso(id, {
                      comentario,
                      canais: canaisSel,
                    });
                    setComentarios((prev) => ({ ...prev, [id]: '' }));
                    setCanaisById((prev) => ({
                      ...prev,
                      [id]: DEFAULT_CANAIS,
                    }));
                    alert('Comentário registrado no histórico.');
                  } catch (e) {
                    alert(
                      e?.response?.data?.error ||
                        e?.response?.data?.detail ||
                        e?.message ||
                        'Erro ao Salvar comentário.'
                    );
                  } finally {
                    setSavingById((prev) => ({ ...prev, [id]: false }));
                  }
                }}
              >
                Salvar comentário
              </button>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2 text-xs">
              <button
                type="button"
                className="text-xs font-semibold underline-offset-4 hover:underline text-left"
                onClick={() =>
                  setEmailOpenById((prev) => ({
                    ...prev,
                    [id]: !prev[id],
                  }))
                }
              >
                {emailOpenById[id] ? 'Ocultar envio de e-mail' : 'Enviar e-mail (abrir)'}
              </button>
              {emailOpenById[id] && (
                <div className="space-y-2">
                  <input
                    type="text"
                    placeholder="Destinatário(s) separados por ;"
                    value={emailById[id]?.to || ''}
                    onChange={(e) =>
                      setEmailById((prev) => ({
                        ...prev,
                        [id]: {
                          ...(prev[id] || {}),
                          to: e.target.value,
                        },
                      }))
                    }
                    className="w-full p-2 rounded border border-[var(--panel-border)] bg-[var(--panel)] text-[var(--fg)]"
                  />
                  <input
                    type="text"
                    placeholder="Assunto"
                    value={emailById[id]?.subject || ''}
                    onChange={(e) =>
                      setEmailById((prev) => ({
                        ...prev,
                        [id]: {
                          ...(prev[id] || {}),
                          subject: e.target.value,
                        },
                      }))
                    }
                    className="w-full p-2 rounded border border-[var(--panel-border)] bg-[var(--panel)] text-[var(--fg)]"
                  />
                  <textarea
                    rows={4}
                    placeholder="Corpo do e-mail"
                    value={emailById[id]?.body || ''}
                    onChange={(e) =>
                      setEmailById((prev) => ({
                        ...prev,
                        [id]: {
                          ...(prev[id] || {}),
                          body: e.target.value,
                        },
                      }))
                    }
                    className="w-full p-2 rounded border border-[var(--panel-border)] bg-[var(--panel)] text-[var(--fg)]"
                  />
                  <div className="flex items-center gap-2">
                    <label className="btn-outline cursor-pointer">
                      Anexar arquivos
                      <input
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(e) =>
                          setEmailById((prev) => ({
                            ...prev,
                            [id]: {
                              ...(prev[id] || {}),
                              attachments: Array.from(
                                e.target.files || []
                              ),
                            },
                          }))
                        }
                      />
                    </label>
                    {emailById[id]?.attachments?.length ? (
                      <span className="text-[11px] opacity-70">
                        {emailById[id].attachments.length} anexo(s)
                      </span>
                    ) : null}
                  </div>
                </div>
              )}
            </div>

            <div className="mt-4 border-t border-[var(--border)] pt-3">
              <button
                type="button"
                className="text-xs font-semibold underline-offset-4 hover:underline"
                onClick={() => toggleHistorico(id)}
              >
                {historicoOpenById[id] ? 'Ocultar histórico' : 'Ver histórico'}
              </button>

              {historicoOpenById[id] && (
                <div className="mt-2 space-y-2">
                  {historicoLoadingById[id] && (
                    <div className="text-xs opacity-70">Carregando histórico...</div>
                  )}
                  {!historicoLoadingById[id] &&
                    (historicoById[id]?.length ? (
                      historicoById[id].map((h, idx) => {
                        const hid = normalizeHistId(h);
                        const etapa = h?.etapa_nova || h?.etapa || h?.etapa_historico || '';
                        const sub = h?.sub_etapa || h?.sub_etapa_historico || '';
                        const texto =
                          h?.comentario ||
                          h?.descricao ||
                          h?.mensagem ||
                          h?.observacao ||
                          h?.acao ||
                          '';
                        return (
                          <div
                            key={`${hid ?? 'hist'}-${idx}`}
                            className="rounded border border-[var(--panel-border)] bg-[var(--panel)] px-3 py-2 text-xs"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="text-[11px] opacity-70">
                                  {fmtDate(
                                    h?.data_movimentacao ||
                                      h?.dataMovimentacao ||
                                      h?.quando ||
                                      h?.data ||
                                      h?.data_criacao ||
                                      h?.dataCriacao ||
                                      ''
                                  )}
                                </div>
                                {(etapa || sub) && (
                                  <div className="font-semibold">
                                    {etapa}
                                    {sub ? ` • ${sub}` : ''}
                                  </div>
                                )}
                                {texto && <div className="mt-1">{texto}</div>}
                              </div>
                              {hid ? (
                                <button
                                  type="button"
                                  className="text-[11px] px-2 py-1 rounded border border-[var(--border)] hover:bg-[var(--border)]/20"
                                  onClick={async () => {
                                    if (!confirm('Excluir este item do histórico?')) return;
                                    try {
                                      await deleteHistorico(hid);
                                      setHistoricoById((prev) => ({
                                        ...prev,
                                        [id]: (prev[id] || []).filter(
                                          (x) => String(normalizeHistId(x)) !== String(hid)
                                        ),
                                      }));
                                    } catch (e) {
                                      alert(
                                        e?.response?.data?.error ||
                                          e?.response?.data?.detail ||
                                          e?.message ||
                                          'Erro ao excluir histórico.'
                                      );
                                    }
                                  }}
                                >
                                  Excluir
                                </button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="text-xs opacity-70">Sem histórico.</div>
                    ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="page-shell overflow-x-hidden">
      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl font-bold">Triagem de Requisição</h1>
          <p className="text-sm opacity-70">
            Primeira reclamação - Distribuidora / Em elaboração
          </p>
        </div>
        <div className="text-xs opacity-70">
          {filtered.length} de {total}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input
          type="text"
          placeholder="Buscar por UC, cliente ou ID"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="px-3 py-2 rounded border border-[var(--border)] bg-[var(--panel)] w-full md:w-[380px]"
        />
      </div>

      {err && (
        <div className="mb-3 text-sm text-red-600">{err}</div>
      )}
      {loading && (
        <div className="py-6 text-sm opacity-70">Carregando...</div>
      )}
      {!loading && filtered.length === 0 && (
        <div className="py-6 text-sm opacity-70">
          Nenhuma requisição aprovada para triagem.
        </div>
      )}

        <div className="space-y-3">
          {filtered.map((r) => renderCard(r))}
        </div>
      </div>
    </div>
  );
}





