// src/pages/MinhaConta.jsx
// Opções da conta do usuário. Hoje: vínculo com Microsoft (Entra ID).
import React, { useEffect, useState, useCallback } from 'react';
import { me as fetchMe, microsoftEnabled, microsoftStartUrl } from '../services/authService';
import { CheckCircle2, Link2, Loader2, ShieldCheck } from 'lucide-react';

function MicrosoftLogo({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

const MS_LINK_MSG = {
  ok: { tipo: 'ok', texto: 'Conta Microsoft vinculada com sucesso! Da próxima vez você pode entrar direto pelo botão “Entrar com Microsoft”.' },
  ja_vinculado: { tipo: 'erro', texto: 'Essa conta Microsoft já está vinculada a outro usuário do sistema.' },
  erro: { tipo: 'erro', texto: 'Não foi possível vincular agora. Tente novamente em instantes.' },
  sessao: { tipo: 'erro', texto: 'Sua sessão expirou. Entre novamente e tente vincular.' },
};

export default function MinhaConta() {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [msOn, setMsOn] = useState(false);
  const [aviso, setAviso] = useState(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchMe();
      setInfo(data);
    } catch {
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // trata retorno do vínculo (#mslink=...)
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    if (hash) {
      const params = new URLSearchParams(hash);
      const r = params.get('mslink');
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      if (r && MS_LINK_MSG[r]) setAviso(MS_LINK_MSG[r]);
    }
    let alive = true;
    microsoftEnabled().then((on) => { if (alive) setMsOn(on); });
    carregar();
    return () => { alive = false; };
  }, [carregar]);

  const vinculado = !!info?.microsoft_vinculado;

  const card = {
    background: 'var(--panel-bg, var(--card-bg, #fff))',
    border: '1px solid var(--border, rgba(0,0,0,0.1))',
    borderRadius: 16,
    padding: 22,
  };

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '24px 16px', color: 'var(--fg)' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 4px' }}>Minha conta</h1>
      <p style={{ fontSize: 14, color: 'var(--fg-muted, rgba(0,0,0,0.6))', margin: '0 0 20px' }}>
        Gerencie como você acessa o SURE.
      </p>

      {aviso && (
        <div style={{
          marginBottom: 16, padding: '11px 14px', borderRadius: 10, fontSize: 13.5,
          background: aviso.tipo === 'ok' ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)',
          border: `1px solid ${aviso.tipo === 'ok' ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.3)'}`,
          color: aviso.tipo === 'ok' ? 'var(--fg)' : '#b91c1c',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          {aviso.tipo === 'ok' && <CheckCircle2 size={18} />}
          {aviso.texto}
        </div>
      )}

      {/* Dados da conta */}
      <div style={{ ...card, marginBottom: 16 }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-muted)' }}>
            <Loader2 size={16} className="sure-spin" /> Carregando…
          </div>
        ) : info ? (
          <div style={{ display: 'grid', gap: 10 }}>
            <Linha rotulo="Nome" valor={info.nome} />
            <Linha rotulo="E-mail" valor={info.email} />
            <Linha rotulo="Perfil" valor={info.perfil || info.role} />
          </div>
        ) : (
          <div style={{ color: 'var(--fg-muted)' }}>Não foi possível carregar seus dados.</div>
        )}
      </div>

      {/* Vínculo com Microsoft */}
      {msOn && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <MicrosoftLogo size={20} />
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Entrar com Microsoft</h2>
          </div>
          <p style={{ fontSize: 13.5, color: 'var(--fg-muted, rgba(0,0,0,0.6))', margin: '0 0 16px', lineHeight: 1.55 }}>
            Vincule sua conta corporativa Microsoft para entrar no SURE com um clique, sem digitar senha.
          </p>

          {vinculado ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderRadius: 10,
              background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.35)',
            }}>
              <ShieldCheck size={18} color="#059669" />
              <div style={{ fontSize: 13.5 }}>
                <strong>Vinculada</strong>
                {info?.microsoft_email ? <> — {info.microsoft_email}</> : null}
                <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                  Você já pode entrar pelo botão “Entrar com Microsoft” na tela de login.
                </div>
              </div>
            </div>
          ) : (
            <a href={microsoftStartUrl('link', '/conta')}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                padding: '11px 18px', borderRadius: 10, textDecoration: 'none',
                background: '#2F2F2F', color: '#fff', fontWeight: 600, fontSize: 14,
              }}>
              <Link2 size={16} /> Vincular com Microsoft
            </a>
          )}
        </div>
      )}

      <style>{`.sure-spin{animation:sureSpin .9s linear infinite}@keyframes sureSpin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function Linha({ rotulo, valor }) {
  return (
    <div style={{ display: 'flex', gap: 12, fontSize: 14 }}>
      <span style={{ width: 90, color: 'var(--fg-muted, rgba(0,0,0,0.55))', flexShrink: 0 }}>{rotulo}</span>
      <span style={{ fontWeight: 600, wordBreak: 'break-all' }}>{valor || '—'}</span>
    </div>
  );
}
