// TabHistorico — timeline de movimentações; emails vinculados expandem inline.
import React, { useState } from 'react';
import { Mail, ChevronDown, ChevronUp, ExternalLink, ArrowRight, Paperclip } from 'lucide-react';
import { fmtDataHoraBR as fmtDataHora } from '../../utils/dateBR.js';
import { getMailMessage } from '../../services/mailService.js';
import ProtocolosAneelProcesso, { useProtocolosAneelProcesso } from './ProtocolosAneelProcesso.jsx';

const CANAL_LABEL = {
  whatsapp: 'WhatsApp',
  ligacao: 'Telefone',
  email: 'E-mail',
  sms: 'SMS / Mensagem',
  site: 'Portal',
  pessoal: 'Pessoalmente',
};
function canalLabel(n) {
  return CANAL_LABEL[(n || '').toLowerCase()] || n || '—';
}

function transicao(de, para) {
  const fmt = (lado, incluiInstancia) => {
    if (!lado) return '—';
    const parts = [
      incluiInstancia ? lado.instancia?.nome : null,
      lado.etapa?.nome,
      lado.status?.nome,
    ].filter(Boolean);
    if (lado.aprovacao?.nome) parts.push(lado.aprovacao.nome);
    return parts.join(' · ') || '—';
  };

  const instDe = de?.instancia?.nome;
  const instPara = para?.instancia?.nome;
  const instDeId = de?.instancia?.id ?? 0;
  const instParaId = para?.instancia?.id ?? 0;
  let instContexto = null;
  if (!instDe && instPara) instContexto = instPara;
  else if (instDe && !instPara) instContexto = instDe;
  else if (instDe && instPara) {
    if (instDe === instPara) {
      instContexto = instDe;
    } else {
      // Menor id = instância principal (Distribuidora=1); demais são escalações.
      instContexto = instDeId <= instParaId ? instDe : instPara;
    }
  }

  const deStr = fmt(de, !instContexto);
  const paraStr = fmt(para, !instContexto);
  const temOrigem = de && deStr !== '—';

  return (
    <div className="cpv2-tl-item__transition">
      {instContexto && (
        <span className="cpv2-tl-item__instancia">{instContexto}</span>
      )}
      {temOrigem && (
        <>
          <strong>{deStr}</strong>
          <ArrowRight size={15} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--cpv2-text)', strokeWidth: 2.5 }} />
        </>
      )}
      <strong>{paraStr}</strong>
    </div>
  );
}

// Sanitiza HTML de e-mail — remove <script>/<style>/<iframe> e handlers on*=".
function sanitizarBodyHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

function EmailInline({ email, onAbrirCaixaEmail }) {
  const [aberto, setAberto] = useState(false);
  const [body, setBody] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState(null);

  const toggle = async () => {
    const proxAberto = !aberto;
    setAberto(proxAberto);
    if (proxAberto && !body && !carregando) {
      setCarregando(true);
      setErro(null);
      try {
        const data = await getMailMessage(email.message_id);
        // O endpoint normalmente devolve { body_html | body_content | body: {content, contentType} }.
        const html =
          data?.body_html ||
          data?.bodyHtml ||
          data?.body_content ||
          data?.bodyContent ||
          (typeof data?.body === 'string' ? data.body : data?.body?.content) ||
          '';
        setBody({
          html: sanitizarBodyHtml(html),
          subject: data?.subject || email.subject || '',
          from: data?.from_name || data?.fromName || email.from_name || email.from_email || '',
        });
      } catch (e) {
        setErro(e?.message || 'Falha ao carregar o e-mail.');
      } finally {
        setCarregando(false);
      }
    }
  };

  return (
    <div className="cpv2-hist-email">
      <button
        type="button"
        className="cpv2-hist-email__toggle"
        onClick={toggle}
      >
        <Mail size={12} />
        <span className="cpv2-hist-email__subj">
          {email.subject || '(sem assunto)'}
        </span>
        {(email.from_name || email.from_email) && (
          <span className="cpv2-hist-email__from">
            — {email.from_name || email.from_email}
          </span>
        )}
        {aberto ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>

      {aberto && (
        <div className="cpv2-hist-email__body">
          <div className="cpv2-hist-email__meta">
            <div>
              <strong>De:</strong>{' '}
              {email.from_name
                ? `${email.from_name} <${email.from_email || ''}>`
                : email.from_email || '—'}
            </div>
            {email.received_at && (
              <div>
                <strong>Recebido:</strong> {fmtDataHora(email.received_at)}
              </div>
            )}
            <div style={{ marginTop: 4 }}>
              <button
                type="button"
                className="cpv2-btn cpv2-btn--ghost cpv2-btn--sm"
                onClick={() => onAbrirCaixaEmail?.(email.message_id)}
                title="Abrir na Caixa de E-mails"
              >
                <ExternalLink size={12} /> Abrir na Caixa de E-mails
              </button>
            </div>
          </div>

          {carregando && (
            <div className="cpv2-hist-email__loading">Carregando corpo do e-mail…</div>
          )}
          {erro && !carregando && (
            <div className="cpv2-hist-email__error">
              {erro} — mostrando prévia:
              <div style={{ marginTop: 4, fontStyle: 'italic', color: 'var(--cpv2-text-muted)' }}>
                {email.snippet || '(sem prévia disponível)'}
              </div>
            </div>
          )}
          {!carregando && !erro && body?.html && (
            <div
              className="cpv2-hist-email__html"
              dangerouslySetInnerHTML={{ __html: body.html }}
            />
          )}
          {!carregando && !erro && !body?.html && email.snippet && (
            <div style={{ marginTop: 4, fontStyle: 'italic', color: 'var(--cpv2-text-muted)' }}>
              {email.snippet}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Mudança de protocolo ANEEL vira uma entrada da linha do tempo (laranja), junto das movimentações.
function itemAneel(e) {
  return {
    id_historico: `aneel-${e.id}`,
    tipo_movimentacao: 'aneel',
    data_movimentacao: e.ocorrido_em,
    _aneel: e,
  };
}

// Texto da ANEEL (resposta completa) começa recolhido; clica para ler.
function TextoAneel({ texto }) {
  const [aberto, setAberto] = useState(false);
  return (
    <div>
      <button type="button" className="cpv2-btn cpv2-btn--sm" onClick={() => setAberto((v) => !v)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {aberto ? <ChevronUp size={13} /> : <ChevronDown size={13} />} {aberto ? 'Recolher texto' : 'Ver texto da ANEEL'}
      </button>
      {aberto && <div style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{texto}</div>}
    </div>
  );
}

export default function TabHistorico({ itens, isLoading, anexos = [], idProcesso, onToast }) {
  const aneelQ = useProtocolosAneelProcesso(idProcesso);
  const eventosAneel = aneelQ.data?.eventos || [];
  const quadro = idProcesso ? <ProtocolosAneelProcesso idProcesso={idProcesso} onToast={onToast} /> : null;
  if (eventosAneel.length) {
    itens = [...(itens || []), ...eventosAneel.map(itemAneel)].sort(
      (a, b) => new Date(b.data_movimentacao || 0) - new Date(a.data_movimentacao || 0),
    );
  }
  if (isLoading) {
    return (
      <div className="cpv2-empty">
        <h4>Carregando…</h4>
      </div>
    );
  }
  if (!itens || itens.length === 0) {
    return (
      <>
        {quadro}
        <div className="cpv2-empty">
          <h4>Sem movimentações registradas</h4>
          <p>O histórico aparece aqui após a primeira movimentação.</p>
        </div>
      </>
    );
  }
  const abrirCaixaEmail = (messageId) => {
    if (!messageId) return;
    window.open(
      `/caixa-de-email?messageId=${encodeURIComponent(messageId)}`,
      '_blank',
      'noopener',
    );
  };

  // Anexos exibidos na própria entrada, por proximidade de data (o upload da movimentação
  // acontece junto do registro; janela de 2 min). Continuam também na aba de Anexos.
  const anexosDoItem = (h) => {
    if (!h.data_movimentacao || !anexos.length) return [];
    const t = new Date(h.data_movimentacao).getTime();
    return anexos.filter((a) => {
      const ta = new Date(a.uploaded_at || 0).getTime();
      return Number.isFinite(ta) && Math.abs(ta - t) <= 120000;
    });
  };

  return (
    <>
      {quadro}
      <div className="cpv2-section-title">Linha do tempo</div>
      <div className="cpv2-timeline">
        {itens.map((h) => {
          if (h._aneel) {
            const e = h._aneel;
            return (
              <div className="cpv2-tl-item cpv2-tl-item--aneel" key={h.id_historico}>
                <div className="cpv2-tl-item__dot" />
                <div className="cpv2-tl-item__head">
                  <div className="cpv2-tl-item__title">🏛️ ANEEL: {e.situacao_nova || 'novidade'}</div>
                  <div className="cpv2-tl-item__date">{fmtDataHora(e.ocorrido_em)}</div>
                </div>
                <div className="cpv2-tl-item__user">
                  automático · protocolo {e.protocolo_num.replace(/^(\d{3})(\d{3})(\d{5})(\d{2})$/, '$1.$2.$3-$4')}
                  {e.fonte === 'email' ? ' · e-mail da ANEEL' : e.fonte === 'site' ? ' · site da ANEEL' : ''}
                </div>
                {(e.andamento || e.situacao_anterior) && (
                  <div className="cpv2-tl-item__body">
                    {e.situacao_anterior && e.situacao_anterior !== e.situacao_nova && (
                      <div className="cpv2-muted-sm">antes: {e.situacao_anterior}</div>
                    )}
                    {e.andamento && <TextoAneel texto={e.andamento} />}
                  </div>
                )}
              </div>
            );
          }
          const tipo = (h.tipo_movimentacao || 'manual').toLowerCase();
          const cls = `cpv2-tl-item cpv2-tl-item--${tipo}`;
          const titulo =
            tipo === 'sistema'
              ? 'Evento de sistema'
              : tipo === 'email'
                ? 'E-mail vinculado'
                : h.de == null
                  ? 'Processo criado'
                  : 'Movimentação';
          const temEmail = !!(h.email && h.email.message_id);
          const anx = anexosDoItem(h);
          return (
            <div className={cls} key={h.id_historico || h.id_movimentacao}>
              <div className="cpv2-tl-item__dot" />
              <div className="cpv2-tl-item__head">
                <div className="cpv2-tl-item__title">{titulo}</div>
                <div className="cpv2-tl-item__date">
                  {fmtDataHora(h.data_movimentacao)}
                </div>
              </div>
              <div className="cpv2-tl-item__user">
                por {h.usuario?.nome || 'Sistema'}
              </div>

              {(h.comentario ||
                  h.de ||
                  h.para ||
                  temEmail ||
                  anx.length > 0 ||
                  (h.canais && h.canais.length > 0)) && (
                  <div className="cpv2-tl-item__body">
                    {h.comentario && <div>{h.comentario}</div>}
                    {(h.de || h.para) && transicao(h.de, h.para)}
                    {temEmail && (
                      <EmailInline email={h.email} onAbrirCaixaEmail={abrirCaixaEmail} />
                    )}
                    {anx.length > 0 && (
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                        {anx.map((a) => (
                          <a
                            key={a.id_anexo}
                            className="cpv2-chip"
                            style={{ fontSize: 10.5, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                            href={a.url_download && a.url_download !== '#' ? a.url_download : undefined}
                            target="_blank"
                            rel="noreferrer"
                            title={a.nome_arquivo}
                          >
                            <Paperclip size={11} /> {a.nome_arquivo}
                          </a>
                        ))}
                      </div>
                    )}
                    {h.canais && h.canais.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                        {h.canais.map((c) => (
                          <span key={c.id} className="cpv2-chip cpv2-chip--info" style={{ fontSize: 10.5 }}>
                            {canalLabel(c.nome)}
                          </span>
                        ))}
                      </div>
                    )}
                    {h.justificativa_atraso && (
                      <div style={{ fontSize: 11, color: 'var(--cpv2-warning)', marginTop: 4 }}>
                        Justificativa de atraso: {h.justificativa_atraso}
                      </div>
                    )}
                  </div>
                )}
            </div>
          );
        })}
      </div>
    </>
  );
}
