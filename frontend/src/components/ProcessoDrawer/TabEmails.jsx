// TabEmails — e-mails vinculados ao processo (FT_EMAILS_PROCESSO).
// Renderiza o corpo salvo no banco (não depende do Graph ao vivo) e oferece
// link para abrir a mensagem original na Caixa de E-mails.
import React, { useState } from 'react';
import DOMPurify from 'dompurify';
import { Mail, ExternalLink, User, Calendar, ChevronDown, ChevronUp } from 'lucide-react';
import { fmtDataHoraBR as fmtDataHora } from '../../utils/dateBR.js';

// sql.NullString chega como { String, Valid }; strings simples passam direto.
const pickStr = (v) =>
  (v && typeof v === 'object' && 'String' in v ? v.String : v) || '';

function abrirNaCaixa(email) {
  const gid = pickStr(email.graph_message_id);
  const assunto = pickStr(email.assunto);
  const url = gid
    ? `/caixa-de-email?messageId=${encodeURIComponent(gid)}`
    : `/caixa-de-email?q=${encodeURIComponent(assunto)}`;
  window.open(url, '_blank', 'noopener');
}

function EmailCard({ email, aberto, onToggle }) {
  const assunto = pickStr(email.assunto) || '(sem assunto)';
  const corpo = pickStr(email.corpo);
  const tipo = (email.tipo || '').toLowerCase();
  const recebido = tipo === 'recebido';

  return (
    <div className="cpv2-hist-email" style={{ marginBottom: 8 }}>
      <button type="button" className="cpv2-hist-email__toggle" onClick={onToggle}>
        <Mail size={12} />
        <span
          className="cpv2-chip"
          style={{
            fontSize: 9.5,
            padding: '1px 6px',
            background: recebido
              ? 'var(--cpv2-info-soft, color-mix(in srgb, var(--accent-2) 14%, var(--card)))'
              : 'var(--cpv2-success-soft, color-mix(in srgb, var(--success) 14%, var(--card)))',
          }}
        >
          {recebido ? 'Recebido' : 'Enviado'}
        </span>
        <span className="cpv2-hist-email__subj">{assunto}</span>
        {email.de_email && (
          <span className="cpv2-hist-email__from">— {email.de_email}</span>
        )}
        {aberto ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>

      {aberto && (
        <div className="cpv2-hist-email__body">
          <div className="cpv2-hist-email__meta">
            <div>
              <User size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
              <strong>De:</strong> {email.de_email || '—'}
            </div>
            {email.para_email && (
              <div>
                <Mail size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
                <strong>Para:</strong> {email.para_email}
              </div>
            )}
            {email.data_envio && (
              <div>
                <Calendar size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
                <strong>Data:</strong> {fmtDataHora(email.data_envio)}
              </div>
            )}
            {Array.isArray(email.read_by) && email.read_by.length > 0 && (
              <div>
                <strong>Lido por:</strong> {email.read_by.join(', ')}
              </div>
            )}
            <div style={{ marginTop: 4 }}>
              <button
                type="button"
                className="cpv2-btn cpv2-btn--ghost cpv2-btn--sm"
                onClick={() => abrirNaCaixa(email)}
                title="Abrir a mensagem original na Caixa de E-mails"
              >
                <ExternalLink size={12} /> Abrir na Caixa de E-mails
              </button>
            </div>
          </div>

          {corpo ? (
            <div
              className="cpv2-hist-email__html"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(corpo) }}
            />
          ) : (
            <div style={{ fontStyle: 'italic', color: 'var(--cpv2-text-muted)' }}>
              (sem corpo disponível)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function TabEmails({ itens, isLoading }) {
  const [abertos, setAbertos] = useState(() => new Set());

  if (isLoading) {
    return (
      <div className="cpv2-empty">
        <h4>Carregando e-mails…</h4>
      </div>
    );
  }
  if (!itens || itens.length === 0) {
    return (
      <div className="cpv2-empty">
        <h4>Nenhum e-mail vinculado</h4>
        <p>E-mails enviados/recebidos e vinculados a este processo aparecem aqui.</p>
      </div>
    );
  }

  const toggle = (id) =>
    setAbertos((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <>
      <div className="cpv2-section-title">E-mails vinculados ({itens.length})</div>
      <div>
        {itens.map((email) => (
          <EmailCard
            key={email.id_email}
            email={email}
            aberto={abertos.has(email.id_email)}
            onToggle={() => toggle(email.id_email)}
          />
        ))}
      </div>
    </>
  );
}
