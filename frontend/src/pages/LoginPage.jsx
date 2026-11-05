// src/pages/LoginPage.jsx
import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { login as loginService, magicEnabled, magicRequest } from '../services/authService';
import { Eye, EyeOff, Loader2, CheckCircle2, ArrowRight } from 'lucide-react';

const DISPLAY = "'Space Grotesk', 'Inter', sans-serif";

// Logo oficial (4 quadrados) da Microsoft — usado como pista visual de que o
// acesso é com o e-mail corporativo Microsoft (não é botão de login OAuth).
function MicrosoftLogo({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

// Mensagens de erro do link mágico (#magic=...).
const MAGIC_ERROS = {
  desativado: 'Login por e-mail indisponível no momento.',
  invalido: 'Link inválido. Peça um novo link de acesso.',
  expirado: 'Este link expirou. Peça um novo link de acesso.',
  usado: 'Este link já foi usado. Peça um novo link de acesso.',
  inativo: 'Seu usuário está inativo. Fale com o administrador.',
  db: 'Erro interno ao entrar. Tente novamente em instantes.',
  erro: 'Não foi possível entrar agora. Tente novamente.',
};

// Marca SVE (vetorial): raio de energia apontando p/ cima = energia que volta (ressarcimento).
function Mark({ size = 46 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true"
      style={{ filter: 'drop-shadow(0 0 14px rgba(93,200,255,0.45))' }}>
      <defs>
        <linearGradient id="sureMk" x1="12" y1="8" x2="52" y2="56" gradientUnits="userSpaceOnUse">
          <stop stopColor="#5CC8FF" />
          <stop offset="1" stopColor="#2DD4BF" />
        </linearGradient>
      </defs>
      <rect x="7" y="7" width="50" height="50" rx="15" stroke="url(#sureMk)" strokeWidth="3.5" />
      <path d="M34 11 L20 34 L28 34 L25 53 L44 28 L35 28 Z" fill="url(#sureMk)" />
    </svg>
  );
}

// Arte de corrente/forma de onda: linha de energia com um "pico" = irregularidade detectada.
function Waveform() {
  return (
    <svg viewBox="0 0 440 320" preserveAspectRatio="none" aria-hidden="true"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.5 }}>
      <path d="M-10 210 C50 210 70 190 110 196 S180 232 212 196 L232 96 L250 196 C300 230 360 206 460 210"
        fill="none" stroke="#5CC8FF" strokeWidth="2" strokeOpacity="0.5" />
      <path d="M-10 250 C60 250 90 238 140 244 S210 266 250 246 S360 238 460 250"
        fill="none" stroke="#2DD4BF" strokeWidth="1.5" strokeOpacity="0.28" />
      <circle cx="232" cy="96" r="4" fill="#5CC8FF" />
      <circle cx="232" cy="96" r="9" fill="none" stroke="#5CC8FF" strokeOpacity="0.4" />
    </svg>
  );
}

const Login = () => {
  const [formData, setFormData] = useState({ email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // magicOn: se o envio de e-mail está configurado (Graph/SMTP). Enquanto não
  // sabemos (null), não mostramos nada pra não "piscar" a tela de senha.
  const [magicOn, setMagicOn] = useState(null);
  const [magicBusy, setMagicBusy] = useState(false);
  const [magicSent, setMagicSent] = useState(false);

  const { login } = useAuth();

  // Trata o retorno do link mágico (o token de sessão volta no fragmento
  // #mstoken=..., erros em #magic=...) e descobre se o login por e-mail está no ar.
  useEffect(() => {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    if (hash) {
      const params = new URLSearchParams(hash);
      const token = params.get('mstoken');
      // limpa o fragmento da barra de endereço
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      if (token) {
        login(token);
        window.location.href = `/?v=${Date.now()}`;
        return;
      }
      const magicErr = params.get('magic');
      if (magicErr) {
        setError(MAGIC_ERROS[magicErr] || 'Não foi possível entrar pelo link.');
      }
    }
    let alive = true;
    magicEnabled().then((on) => { if (alive) setMagicOn(on); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = (e) => setFormData({ ...formData, [e.target.name]: e.target.value });

  const handleMagic = async (e) => {
    if (e) e.preventDefault();
    const email = formData.email.trim();
    setError('');
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      setError('Digite seu e-mail corporativo para receber o link de acesso.');
      return;
    }
    setMagicBusy(true);
    try {
      await magicRequest(email);
      setMagicSent(true);
    } catch {
      // mesmo em erro, mostra confirmação genérica (não revela se o e-mail existe)
      setMagicSent(true);
    } finally {
      setMagicBusy(false);
    }
  };

  // Fallback de EMERGÊNCIA: só aparece se o envio de e-mail estiver fora do ar
  // (magicOn === false). Garante que ninguém fique trancado pra fora se o
  // Graph/SMTP cair. Em produção o e-mail está configurado → esta tela não aparece.
  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    try {
      const { token } = await loginService(formData.email, formData.password);
      login(token);
      window.location.href = `/?v=${Date.now()}`;
    } catch (err) {
      console.error('Erro detalhado no login:', err);
      setError(err?.response?.data?.error || 'E-mail ou senha incorretos. Tente novamente.');
    } finally {
      setIsLoading(false);
    }
  };

  const field = {
    width: '100%', boxSizing: 'border-box',
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 10, padding: '11px 13px', fontSize: 14,
    color: '#eaf2fb', outline: 'none', transition: 'border-color .15s, box-shadow .15s',
  };
  const onFocus = (e) => { e.target.style.borderColor = '#2DD4BF'; e.target.style.boxShadow = '0 0 0 3px rgba(45,212,191,0.15)'; };
  const onBlur = (e) => { e.target.style.borderColor = 'rgba(255,255,255,0.12)'; e.target.style.boxShadow = 'none'; };

  const primaryBtn = {
    marginTop: 4, width: '100%', boxSizing: 'border-box', padding: '12px', borderRadius: 10, border: 'none',
    fontFamily: DISPLAY, fontWeight: 600, fontSize: 14.5, letterSpacing: '0.02em',
    color: '#06212a',
    background: 'linear-gradient(135deg, #5CC8FF 0%, #2DD4BF 100%)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    boxShadow: '0 8px 24px rgba(45,212,191,0.28)', transition: 'opacity .15s, transform .1s',
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, overflow: 'auto',
      background: 'radial-gradient(1200px 620px at 18% -12%, #143a52 0%, transparent 60%), radial-gradient(900px 500px at 100% 115%, #0f3a44 0%, transparent 55%), #070f1c',
    }}>
      <div className="sure-login" style={{
        width: '100%', maxWidth: 960, display: 'grid', gridTemplateColumns: '1.05fr 1fr',
        borderRadius: 24, overflow: 'hidden',
        boxShadow: '0 30px 90px rgba(0,0,0,0.6), 0 0 0 1px rgba(93,200,255,0.12)',
      }}>
        {/* Painel marca */}
        <div className="sure-brand" style={{
          position: 'relative', padding: '46px 44px', minHeight: 540,
          background: 'linear-gradient(158deg, #103049 0%, #0a1b2e 72%)',
          color: '#eaf6ff', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <Waveform />
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 13 }}>
            <Mark size={48} />
            <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 32, letterSpacing: '0.16em', color: '#fff' }}>
              SURE
            </span>
          </div>
          <div className="sure-brand-copy" style={{ position: 'relative', marginTop: 'auto' }}>
            <h1 className="lg-h1" style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 27, lineHeight: 1.22, margin: 0, color: '#f4fbff' }}>
              A conta certa<br />da energia.
            </h1>
            <p className="lg-desc" style={{ marginTop: 16, fontSize: 14, lineHeight: 1.65, color: 'rgba(240,249,255,0.92)', maxWidth: '36ch' }}>
              Plataforma de ressarcimento de energia: detecta irregularidades nas faturas e acompanha
              a recuperação do crédito — do apontamento ao caixa.
            </p>
          </div>
        </div>

        {/* Painel formulário */}
        <div style={{
          padding: '46px 44px', background: '#0c1a28', color: '#e6edf3',
          display: 'flex', flexDirection: 'column', justifyContent: 'center',
        }}>
          <h2 className="lg-h2" style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 23, margin: '0 0 4px', color: '#ffffff' }}>Entrar</h2>
          <p className="lg-sub" style={{ fontSize: 13.5, color: 'rgba(255,255,255,0.9)', margin: '0 0 24px' }}>
            Acesse o painel de ressarcimento.
          </p>

          {error && (
            <div style={{
              fontSize: 13, color: '#fecaca', background: 'rgba(239,68,68,0.12)',
              border: '1px solid rgba(239,68,68,0.25)', borderRadius: 9, padding: '9px 12px', marginBottom: 16,
            }}>
              {error}
            </div>
          )}

          {/* ── Enquanto descobrimos se o e-mail está no ar ────────────────── */}
          {magicOn === null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'rgba(255,255,255,0.7)', fontSize: 14, padding: '8px 0' }}>
              <Loader2 size={18} className="sure-spin" /> Carregando…
            </div>
          )}

          {/* ── CAMINHO PADRÃO: login só por link de e-mail ───────────────── */}
          {magicOn === true && (magicSent ? (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '14px 16px', borderRadius: 12,
              background: 'rgba(45,212,191,0.12)', border: '1px solid rgba(45,212,191,0.3)',
              fontSize: 13.5, color: '#d6fff6', lineHeight: 1.55,
            }}>
              <CheckCircle2 size={20} style={{ flexShrink: 0, marginTop: 1 }} />
              <div>
                Enviamos um link de acesso para <b>{formData.email.trim()}</b>. Abra seu e-mail e
                clique no botão <b>Entrar no SURE</b> — o link vale por <b>30 minutos</b>.
                <div style={{ marginTop: 10 }}>
                  <button type="button" onClick={() => { setMagicSent(false); setError(''); }}
                    style={{ background: 'none', border: 'none', color: '#5CC8FF', cursor: 'pointer', fontWeight: 600, fontSize: 13, padding: 0 }}>
                    Usar outro e-mail
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <form onSubmit={handleMagic} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label htmlFor="email" style={{ display: 'block', fontSize: 12.5, fontWeight: 600, marginBottom: 7, color: 'rgba(255,255,255,0.95)' }}>
                  E-mail corporativo
                </label>
                <input id="email" name="email" type="email" autoComplete="email" required autoFocus
                  placeholder="seu.email@amee.com.br" value={formData.email} onChange={handleChange}
                  style={field} onFocus={onFocus} onBlur={onBlur} />
              </div>

              <button type="submit" disabled={magicBusy}
                style={{ ...primaryBtn, cursor: magicBusy ? 'default' : 'pointer', opacity: magicBusy ? 0.7 : 1 }}
                onMouseDown={(e) => (e.currentTarget.style.transform = 'translateY(1px)')}
                onMouseUp={(e) => (e.currentTarget.style.transform = 'none')}>
                {magicBusy
                  ? <><Loader2 size={16} className="sure-spin" /> Enviando…</>
                  : <><MicrosoftLogo size={18} /> Entrar com e-mail corporativo</>}
              </button>

              <p className="lg-hint" style={{ fontSize: 12.5, lineHeight: 1.55, margin: '2px 0 0', textAlign: 'center' }}>
                Enviaremos um link de acesso. No primeiro acesso, sua conta é criada automaticamente.
              </p>
            </form>
          ))}

          {/* ── EMERGÊNCIA: e-mail fora do ar → cai pro login por senha ────── */}
          {magicOn === false && (
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{
                fontSize: 12.5, color: '#fde68a', background: 'rgba(234,179,8,0.1)',
                border: '1px solid rgba(234,179,8,0.25)', borderRadius: 9, padding: '9px 12px',
              }}>
                O login por e-mail está indisponível no momento. Entre com e-mail e senha.
              </div>
              <div>
                <label htmlFor="email" style={{ display: 'block', fontSize: 12.5, fontWeight: 600, marginBottom: 7, color: 'rgba(255,255,255,0.95)' }}>
                  E-mail
                </label>
                <input id="email" name="email" type="email" autoComplete="email" required
                  placeholder="seu.email@amee.com.br" value={formData.email} onChange={handleChange}
                  style={field} onFocus={onFocus} onBlur={onBlur} />
              </div>
              <div>
                <label htmlFor="password" style={{ display: 'block', fontSize: 12.5, fontWeight: 600, marginBottom: 7, color: 'rgba(255,255,255,0.95)' }}>
                  Senha
                </label>
                <div style={{ position: 'relative' }}>
                  <input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password"
                    required placeholder="Digite sua senha" value={formData.password} onChange={handleChange}
                    style={{ ...field, paddingRight: 42 }} onFocus={onFocus} onBlur={onBlur} />
                  <button type="button" onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                    style={{
                      position: 'absolute', right: 6, top: 0, height: '100%', width: 34,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: 'transparent', border: 'none', cursor: 'pointer', color: 'rgba(230,237,243,0.55)',
                    }}>
                    {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
              </div>
              <button type="submit" disabled={isLoading}
                style={{ ...primaryBtn, cursor: isLoading ? 'default' : 'pointer', opacity: isLoading ? 0.7 : 1 }}
                onMouseDown={(e) => (e.currentTarget.style.transform = 'translateY(1px)')}
                onMouseUp={(e) => (e.currentTarget.style.transform = 'none')}>
                {isLoading ? <><Loader2 size={16} className="sure-spin" /> Entrando…</> : <>Entrar <ArrowRight size={16} /></>}
              </button>
            </form>
          )}
        </div>
      </div>

      <style>{`
        .sure-spin { animation: sureSpin 0.9s linear infinite; }
        /* O login é sempre escuro: vence as regras globais do tema ([data-theme] h1/h2/p com
           !important em theme.css), que pintavam estes textos de escuro no tema claro. */
        [data-theme] .sure-login .lg-h1, .sure-login .lg-h1 { color: #f4fbff !important; }
        [data-theme] .sure-login .lg-desc, .sure-login .lg-desc { color: rgba(240,249,255,0.85) !important; }
        [data-theme] .sure-login .lg-h2, .sure-login .lg-h2 { color: #ffffff !important; }
        [data-theme] .sure-login .lg-sub, .sure-login .lg-sub { color: rgba(255,255,255,0.78) !important; }
        [data-theme] .sure-login .lg-foot, .sure-login .lg-foot { color: rgba(255,255,255,0.78) !important; }
        [data-theme] .sure-login .lg-hint, .sure-login .lg-hint { color: rgba(255,255,255,0.92) !important; }
        [data-theme] .sure-login label { color: rgba(255,255,255,0.95) !important; }
        @keyframes sureSpin { to { transform: rotate(360deg); } }
        input::placeholder { color: rgba(230,237,243,0.35); }
        @media (max-width: 780px) {
          .sure-login { grid-template-columns: 1fr !important; max-width: 420px !important; }
          .sure-brand { min-height: auto !important; padding: 30px 32px !important; }
          .sure-brand-copy { display: none !important; }
        }
      `}</style>
    </div>
  );
};

export default Login;
