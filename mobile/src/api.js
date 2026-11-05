// Acesso ao backend do SURE. O app roda na MESMA origem do site (sure.app.br/m/), então usa
// o mesmo login: cookie auth_token + o token em localStorage.userToken (igual ao site).

const lerToken = () => {
  try { return String(localStorage.getItem('userToken') || '').trim().replace(/^['"]+|['"]+$/g, ''); } catch { return ''; }
};

// conteúdo do token (nome, e-mail, perfil, validade) — só leitura, sem conferir assinatura
export function usuarioDoToken() {
  const t = lerToken();
  if (!t) return null;
  try {
    const p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const d = JSON.parse(decodeURIComponent(escape(atob(p + '==='.slice((p.length + 3) % 4)))));
    if (!d.exp || d.exp * 1000 <= Date.now()) return null;
    return {
      nome: d.nome || d.user_name || '',
      email: d.email || d.user_name || '',
      perfil: String(d.tipo_conta || d.role || d.tipoConta || '').toLowerCase(),
      id: d.user_id,
      expira: d.exp * 1000,
    };
  } catch { return null; }
}

// sem token guardado no celular, a sessão pode existir só no cookie do site (entrou pelo
// site completo): pergunta ao servidor quem está conectado.
export async function sessaoDoServidor() {
  try {
    const r = await fetch('/api/v2/auth/me', { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || !d.id) return null;
    return { nome: d.nome || '', email: d.email || '', perfil: String(d.perfil || d.role || '').toLowerCase(), id: d.id, expira: 0 };
  } catch { return null; }
}

export async function sair() {
  // encerra também a sessão do cookie (senão o "continuar" entraria de novo)
  try { await fetch('/api/v2/auth/logout', { method: 'POST', credentials: 'include' }); } catch { /* ignore */ }
  try { localStorage.removeItem('userToken'); } catch { /* ignore */ }
  window.dispatchEvent(new Event('sure-sair'));
}

const cabecalhoAuth = () => { const tk = lerToken(); return tk ? { Authorization: `Bearer ${tk}` } : {}; };

// fala → texto (OpenAI, pelo servidor)
export async function transcrever(blob, ext) {
  const fd = new FormData();
  fd.append('audio', blob, `fala.${ext}`);
  const r = await fetch('/api/v1/voz/openai/transcrever', { method: 'POST', body: fd, credentials: 'include', headers: cabecalhoAuth() });
  const d = await r.json().catch(() => null);
  if (r.status === 401) { sair(); throw new Error('Sua sessão expirou. Entre de novo.'); }
  if (!r.ok) throw new Error(d?.error || `Erro ${r.status} na transcrição`);
  return String(d?.texto || '').trim();
}

// texto → voz (OpenAI, pelo servidor) — devolve o MP3
// se a OpenAI recusar, usa a voz neural do chat do site (/voz/falar, edge-tts, sem custo)
export async function falar(texto) {
  const opts = { method: 'POST', credentials: 'include', headers: { ...cabecalhoAuth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ texto }) };
  for (const rota of ['/api/v1/voz/openai/falar', '/api/v1/voz/falar']) {
    try {
      const r = await fetch(rota, opts);
      if (r.ok && /audio/.test(r.headers.get('content-type') || '')) return r.arrayBuffer();
    } catch { /* tenta a próxima */ }
  }
  throw new Error('voz indisponível');
}

const url = (p) => (/^\/api\//.test(p) ? p : '/api/v1' + (p.startsWith('/') ? p : '/' + p));

export async function api(caminho, { method = 'GET', body, params, timeout = 60000 } = {}) {
  let u = url(caminho);
  if (params) {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    if ([...q].length) u += (u.includes('?') ? '&' : '?') + q.toString();
  }
  const headers = { Accept: 'application/json' };
  const tk = lerToken();
  if (tk) headers.Authorization = `Bearer ${tk}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let resp;
  try {
    resp = await fetch(u, { method, headers, credentials: 'include', body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    throw new Error(e?.name === 'AbortError' ? 'O servidor demorou para responder.' : 'Sem conexão com o SURE.');
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await resp.json(); } catch { /* resposta sem JSON */ }
  if (resp.status === 401) { sair(); throw new Error('Sua sessão expirou. Entre de novo.'); }
  if (!resp.ok) throw new Error(data?.error || data?.erro || (resp.status >= 500 ? `O servidor do SURE não respondeu (erro ${resp.status}). Tente de novo em instantes.` : `Erro ${resp.status}`));
  return data;
}
