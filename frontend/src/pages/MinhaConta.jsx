// src/pages/MinhaConta.jsx
// Opções da conta do usuário: dados, autenticador (código de 6 dígitos) e vínculo com Microsoft.
import React, { useEffect, useState, useCallback } from 'react';
import {
  me as fetchMe, microsoftEnabled, microsoftStartUrl,
  totpStatus, totpIniciar, totpConfirmar, totpDesativar, definirSenha,
} from '../services/authService';
import { CheckCircle2, Copy, KeyRound, Link2, Loader2, ShieldCheck, ShieldOff, Smartphone } from 'lucide-react';

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

const card = {
  background: 'var(--panel-bg, var(--card-bg, #fff))',
  border: '1px solid var(--border, rgba(0,0,0,0.1))',
  borderRadius: 16,
  padding: 22,
};
const btn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  padding: '10px 16px', borderRadius: 10, border: '1px solid var(--border, rgba(0,0,0,0.15))',
  background: 'var(--panel-bg, #fff)', color: 'var(--fg)', fontWeight: 600, fontSize: 14, cursor: 'pointer',
};
const btnPrimario = { ...btn, background: 'var(--accent, #0c6f7a)', color: '#fff', border: '1px solid transparent' };
const campoCodigo = {
  width: 160, padding: '9px 12px', borderRadius: 10, border: '1px solid var(--border, rgba(0,0,0,0.2))',
  fontSize: 18, letterSpacing: '0.2em', fontVariantNumeric: 'tabular-nums', background: 'var(--input-bg, #fff)', color: 'var(--fg)',
};
const caixaOk = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderRadius: 10,
  background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.35)',
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

  return (
    <div style={{ width: '100%', maxWidth: 860, padding: '24px 16px', color: 'var(--fg)' }}>
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

      {/* Senha */}
      <div id="senha" style={{ ...card, marginBottom: 16 }}>
        <Senha temSenha={!!info?.tem_senha} aoSalvar={carregar} destaque={window.location.hash === '#senha'} />
      </div>

      {/* Autenticador */}
      <div id="autenticador" style={{ ...card, marginBottom: 16 }}>
        <Autenticador />
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
            <div style={caixaOk}>
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

// Senha: entrada padrão do SURE (com o código do autenticador, se ativo). Quem entrou pelo link por
// e-mail define a senha aqui; "esqueci minha senha" na tela de login manda a pessoa para cá.
function Senha({ temSenha, aoSalvar, destaque }) {
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');
  const [confirma, setConfirma] = useState('');
  const [erro, setErro] = useState('');
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mostrar, setMostrar] = useState(false);

  useEffect(() => {
    if (destaque) setTimeout(() => document.getElementById('senha')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  }, [destaque]);

  const salvar = async (e) => {
    e.preventDefault();
    setErro(''); setOk(false);
    if (nova.length < 8) { setErro('A senha nova precisa ter pelo menos 8 caracteres.'); return; }
    if (nova !== confirma) { setErro('A confirmação não confere com a senha nova.'); return; }
    setBusy(true);
    try {
      await definirSenha(atual, nova);
      setOk(true); setAtual(''); setNova(''); setConfirma('');
      aoSalvar?.();
    } catch (err) {
      const m = err?.response?.data?.error?.message || err?.response?.data?.error;
      setErro((typeof m === 'string' && m) || 'Não foi possível salvar a senha.');
    } finally { setBusy(false); }
  };

  const campo = { ...campoCodigo, width: 260, letterSpacing: 'normal', fontSize: 14 };
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <KeyRound size={20} />
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Senha</h2>
        <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 999, background: temSenha ? 'rgba(16,185,129,0.15)' : 'rgba(234,179,8,0.18)', color: temSenha ? '#059669' : '#b45309' }}>
          {temSenha ? 'CADASTRADA' : 'SEM SENHA'}
        </span>
      </div>
      <p style={{ fontSize: 13.5, color: 'var(--fg-muted, rgba(0,0,0,0.6))', margin: '0 0 14px', lineHeight: 1.55 }}>
        {destaque && !temSenha
          ? 'Você entrou pelo link por e-mail. Defina uma senha para entrar direto da próxima vez.'
          : destaque
            ? 'Você entrou pelo link por e-mail. Defina a senha nova abaixo.'
            : 'A entrada padrão do SURE é e-mail + senha (e o código do autenticador, se você ativar abaixo).'}
      </p>
      {erro && <div style={{ marginBottom: 12, padding: '9px 12px', borderRadius: 9, fontSize: 13, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', color: '#b91c1c' }}>{erro}</div>}
      {ok && <div style={{ ...caixaOk, marginBottom: 12 }}><CheckCircle2 size={18} color="#059669" /><span style={{ fontSize: 13.5 }}>Senha salva. Da próxima vez, entre com e-mail e senha.</span></div>}
      <form onSubmit={salvar} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {temSenha && !destaque && (
          <label style={{ fontSize: 13 }}>Senha atual<br />
            <input type={mostrar ? 'text' : 'password'} value={atual} onChange={(e) => setAtual(e.target.value)} autoComplete="current-password" style={campo} required />
          </label>
        )}
        {temSenha && destaque && (
          <label style={{ fontSize: 13 }}>Senha atual (se lembrar; se não, deixe em branco)<br />
            <input type={mostrar ? 'text' : 'password'} value={atual} onChange={(e) => setAtual(e.target.value)} autoComplete="current-password" style={campo} />
          </label>
        )}
        <label style={{ fontSize: 13 }}>Senha nova (mínimo 8 caracteres)<br />
          <input type={mostrar ? 'text' : 'password'} value={nova} onChange={(e) => setNova(e.target.value)} autoComplete="new-password" style={campo} required minLength={8} />
        </label>
        <label style={{ fontSize: 13 }}>Confirmar senha nova<br />
          <input type={mostrar ? 'text' : 'password'} value={confirma} onChange={(e) => setConfirma(e.target.value)} autoComplete="new-password" style={campo} required />
        </label>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="submit" style={btnPrimario} disabled={busy}>{busy ? <Loader2 size={16} className="sure-spin" /> : <KeyRound size={16} />} {temSenha ? 'Alterar senha' : 'Definir senha'}</button>
          <label style={{ fontSize: 12.5, display: 'inline-flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={mostrar} onChange={(e) => setMostrar(e.target.checked)} /> mostrar</label>
        </div>
      </form>
    </>
  );
}

// Autenticador (código de 6 dígitos, TOTP): alternativa ao link por e-mail para quando o
// e-mail está fora do ar. Funciona com Microsoft Authenticator, Google Authenticator etc.
function Autenticador() {
  const [estado, setEstado] = useState(null); // { ativo, recuperacao_restantes, pendente }
  const [fase, setFase] = useState('idle');   // idle | iniciando | qr | confirmando | recuperacao | desativar
  const [qr, setQr] = useState(null);          // { qr, segredo, conta }
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState('');
  const [recuperacao, setRecuperacao] = useState([]);
  const [copiado, setCopiado] = useState(false);
  const [busy, setBusy] = useState(false);

  const carregar = useCallback(async () => {
    try { setEstado(await totpStatus()); } catch { setEstado({ ativo: false, erro: true }); }
  }, []);
  useEffect(() => { carregar(); }, [carregar]);

  const msgErro = (err, padrao) => {
    const m = err?.response?.data?.error?.message || err?.response?.data?.error;
    return (typeof m === 'string' && m) || padrao;
  };

  const iniciar = async () => {
    setErro(''); setBusy(true); setFase('iniciando');
    try {
      setQr(await totpIniciar());
      setCodigo('');
      setFase('qr');
    } catch (err) {
      setErro(msgErro(err, 'Não foi possível gerar o QR code agora.'));
      setFase('idle');
    } finally { setBusy(false); }
  };

  const confirmar = async (e) => {
    e.preventDefault();
    setErro(''); setBusy(true);
    try {
      const r = await totpConfirmar(codigo.replace(/\s+/g, ''));
      setRecuperacao(r?.recuperacao || []);
      setFase('recuperacao');
      setQr(null); setCodigo('');
      carregar();
    } catch (err) {
      setErro(msgErro(err, 'Código não confere. Espere o próximo código e tente de novo.'));
    } finally { setBusy(false); }
  };

  const desativar = async (e) => {
    e.preventDefault();
    setErro(''); setBusy(true);
    try {
      await totpDesativar(codigo.replace(/\s+/g, ''));
      setFase('idle'); setCodigo('');
      carregar();
    } catch (err) {
      setErro(msgErro(err, 'Código não confere.'));
    } finally { setBusy(false); }
  };

  const copiarRecuperacao = async () => {
    const texto = `Códigos de recuperação do SURE (cada um vale uma vez):\n${recuperacao.join('\n')}`;
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      window.getSelection()?.selectAllChildren(document.getElementById('recuperacao-lista'));
    }
  };

  const ativo = !!estado?.ativo;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <Smartphone size={20} />
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Código do autenticador</h2>
        {estado && (
          <span style={{
            marginLeft: 'auto', fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
            background: ativo ? 'rgba(16,185,129,0.15)' : 'rgba(120,120,120,0.15)', color: ativo ? '#059669' : 'var(--fg-muted)',
          }}>
            {ativo ? 'ATIVO' : 'NÃO ATIVADO'}
          </span>
        )}
      </div>
      <p style={{ fontSize: 13.5, color: 'var(--fg-muted, rgba(0,0,0,0.6))', margin: '0 0 16px', lineHeight: 1.55 }}>
        Uma segunda forma de entrar, para quando o e-mail estiver fora do ar: o app no seu celular
        (Microsoft Authenticator, Google Authenticator ou outro) mostra um código de 6 dígitos que muda a cada 30 segundos.
        Na tela de login, use “Entrar com código do autenticador”.
      </p>

      {erro && (
        <div style={{ marginBottom: 12, padding: '9px 12px', borderRadius: 9, fontSize: 13, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', color: '#b91c1c' }}>
          {erro}
        </div>
      )}

      {!estado && <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-muted)' }}><Loader2 size={16} className="sure-spin" /> Carregando…</div>}

      {estado && !ativo && fase === 'idle' && (
        <button type="button" style={btnPrimario} onClick={iniciar} disabled={busy}>
          <KeyRound size={16} /> Ativar o autenticador
        </button>
      )}
      {fase === 'iniciando' && <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-muted)' }}><Loader2 size={16} className="sure-spin" /> Gerando o QR code…</div>}

      {fase === 'qr' && qr && (
        <form onSubmit={confirmar} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 20, alignItems: 'start' }}>
          <img src={qr.qr} alt="QR code para o app autenticador" width={200} height={200} style={{ borderRadius: 12, background: '#fff', padding: 6, border: '1px solid var(--border, rgba(0,0,0,0.1))' }} />
          <div style={{ fontSize: 13.5, lineHeight: 1.6, minWidth: 0 }}>
            <ol style={{ margin: '0 0 10px', paddingLeft: 18 }}>
              <li>No celular, abra o <b>Microsoft Authenticator</b> (ou outro app de códigos).</li>
              <li>Toque em <b>Adicionar conta → Outra conta</b> e aponte a câmera para o QR code.</li>
              <li>Digite abaixo o código de 6 dígitos que apareceu, para confirmar.</li>
            </ol>
            <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', marginBottom: 10, wordBreak: 'break-all' }}>
              Sem câmera? No app, escolha “inserir código manualmente”: conta <b>{qr.conta}</b>, chave <code style={{ fontSize: 12.5 }}>{qr.segredo}</code>.
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <input value={codigo} onChange={(e) => setCodigo(e.target.value)} inputMode="numeric" autoComplete="one-time-code"
                placeholder="000000" maxLength={7} required style={campoCodigo} autoFocus />
              <button type="submit" style={btnPrimario} disabled={busy}>
                {busy ? <Loader2 size={16} className="sure-spin" /> : <CheckCircle2 size={16} />} Confirmar
              </button>
              <button type="button" style={btn} onClick={() => { setFase('idle'); setQr(null); setErro(''); }}>Cancelar</button>
            </div>
          </div>
        </form>
      )}

      {fase === 'recuperacao' && (
        <div>
          <div style={{ ...caixaOk, marginBottom: 12 }}>
            <ShieldCheck size={18} color="#059669" />
            <div style={{ fontSize: 13.5 }}><strong>Autenticador ativado.</strong> Guarde os códigos de recuperação abaixo: cada um entra uma vez, se você perder o celular. Eles não aparecem de novo.</div>
          </div>
          <div id="recuperacao-lista" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 6, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 15, padding: 12, borderRadius: 10, background: 'rgba(120,120,120,0.08)', marginBottom: 10 }}>
            {recuperacao.map((c) => <span key={c}>{c}</span>)}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" style={btn} onClick={copiarRecuperacao}><Copy size={15} /> {copiado ? 'Copiado' : 'Copiar os códigos'}</button>
            <button type="button" style={btnPrimario} onClick={() => { setFase('idle'); setRecuperacao([]); }}>Já guardei</button>
          </div>
        </div>
      )}

      {estado && ativo && fase === 'idle' && (
        <div>
          <div style={{ ...caixaOk, marginBottom: 12 }}>
            <ShieldCheck size={18} color="#059669" />
            <div style={{ fontSize: 13.5 }}>
              <strong>Ativo.</strong> Na tela de login, use “Entrar com código do autenticador”.
              <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                Códigos de recuperação restantes: {estado.recuperacao_restantes ?? 0}.
                {(estado.recuperacao_restantes ?? 0) <= 2 && ' Poucos: desative e ative de novo para gerar outros 8.'}
              </div>
            </div>
          </div>
          <button type="button" style={btn} onClick={() => { setFase('desativar'); setCodigo(''); setErro(''); }}>
            <ShieldOff size={15} /> Desativar
          </button>
        </div>
      )}

      {fase === 'desativar' && (
        <form onSubmit={desativar} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13.5 }}>Para desativar, digite o código atual do app (ou um de recuperação):</span>
          <input value={codigo} onChange={(e) => setCodigo(e.target.value)} inputMode="text" autoComplete="one-time-code"
            placeholder="000000" maxLength={12} required style={campoCodigo} autoFocus />
          <button type="submit" style={{ ...btnPrimario, background: '#b23b2b' }} disabled={busy}>
            {busy ? <Loader2 size={16} className="sure-spin" /> : <ShieldOff size={16} />} Desativar
          </button>
          <button type="button" style={btn} onClick={() => { setFase('idle'); setErro(''); }}>Cancelar</button>
        </form>
      )}
    </>
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
