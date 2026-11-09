// Módulo "Faturas Claro" (portal PDP Claro / Accenture) — roda no service worker da extensão.
//
// Botão "Atualizar faturas Claro" no SURE → abre o portal numa janela → (se a sessão caiu) entra com o login
// guardado nas opções e com o código de segurança que o SURE lê no e-mail → lê a lista de zips → baixa só os
// lotes MAIS NOVOS que o último já processado → manda o LINK de cada zip para a fila da Claro no servidor do SURE
// (/api/v1/claro-pdp/fila): a VPS baixa o zip direto do portal, extrai, sobe os PDFs para o Google Drive e grava os
// links no banco (worker/job_claro.sh). Se o portal recusar o download vindo do servidor, a extensão baixa aqui e
// envia ao servidor em partes. Fala com o SURE com o login da página que pediu (token só desta atualização,
// guardado na sessão do navegador e apagado no fim). Até a versão 1.2 o destino era o receptor local do PC.
const CLARO_BASE_PADRAO = 'https://clarobps-pdp.azurewebsites.net';
const CLARO_LISTA = '/RoboProcessoExecucao/ListarFaturaEnergiaEletrica';
const CLARO_LOGIN = '/Account/LoginExterno'; // abre direto no login externo (pula a tela Accenture/Externo)
const PARTE = 8 * 1024 * 1024;

let esperaCodigo = null; // { resolver, timer }

async function claroJob() { return (await chrome.storage.session.get('jobClaro')).jobClaro || null; }
async function claroSalvar(j) { await chrome.storage.session.set({ jobClaro: j }); }
async function claroLimpar() { await chrome.storage.session.remove('jobClaro'); }
function claroParaSure(j, dados) {
  if (j && j.sureTabId) chrome.tabs.sendMessage(j.sureTabId, { paraSure: true, dados }).catch(() => {});
}

// chamada à API do SURE com o login da página (j = { api, token })
async function sure(j, caminho, opcoes = {}) {
  // cookie de login do SURE (vai junto por causa da permissão do site) + o token da página, quando houver
  const headers = { ...(opcoes.headers || {}) };
  if (j.token) headers.Authorization = 'Bearer ' + j.token;
  const r = await fetch(j.api + caminho, { ...opcoes, headers, credentials: 'include' });
  if (r.status === 401) throw new Error('o login do SURE expirou — entre de novo no SURE e clique outra vez');
  if (r.status === 403) throw new Error('só administradores podem atualizar as faturas Claro');
  if (!r.ok) {
    let det = '';
    try { det = (await r.json()).error || ''; } catch (e) { /* sem corpo */ }
    throw new Error(det || `o servidor do SURE respondeu ${r.status}`);
  }
  return r;
}
const esperar = (ms) => new Promise((res) => setTimeout(res, ms));
const apiValida = (api) => /^(https:\/\/sure\.app\.br|http:\/\/sure\.app\.br|http:\/\/179\.127\.26\.37|http:\/\/localhost(:\d+)?)\/api\/v1$/.test(api || '');

async function claroIniciar(msg, sender) {
  const atual = await claroJob();
  if (atual && atual.status !== 'fim') {
    // janela antiga fechada sem aviso? libera
    const viva = await chrome.windows.get(atual.windowId).then(() => true).catch(() => false);
    if (viva) return { erro: 'Já existe uma atualização da Claro em andamento.' };
  }
  if (!apiValida(msg.api)) return { erro: 'Abra o SURE pelo endereço oficial (sure.app.br) para atualizar as faturas Claro.' };
  const cx = { api: msg.api, token: msg.token };
  let fila;
  try {
    fila = await (await sure(cx, '/claro-pdp/fila')).json();
  } catch (e) {
    return { erro: 'Não consegui falar com a fila da Claro no servidor: ' + String(e.message || e) };
  }
  if (fila.freeGB >= 0 && fila.freeGB < 8) return { erro: `Pouco espaço em disco no servidor (${fila.freeGB.toFixed(1)} GB livres; precisa de pelo menos 8 GB).` };
  const aviso = fila.worker && !fila.worker.ativo
    ? 'o processamento da Claro no servidor não está rodando — os lotes ficam na fila até ele voltar'
    : (fila.worker && fila.worker.aviso && fila.worker.aviso !== 'ok' ? fila.worker.aviso : '');
  const { claroBase } = await chrome.storage.local.get('claroBase');
  const base = (claroBase || CLARO_BASE_PADRAO).replace(/\/+$/, '');
  const win = await chrome.windows.create({ url: base + CLARO_LOGIN, type: 'popup', width: 1100, height: 780, focused: true });
  const j = {
    sureTabId: sender.tab.id, windowId: win.id, tabId: win.tabs && win.tabs[0] ? win.tabs[0].id : null,
    status: 'abrindo', ultimo: fila.ultimo || '0', fila: fila.fila || [], loginEm: 0, logins: 0, desvios: 0,
    api: cx.api, token: cx.token,
  };
  await claroSalvar(j);
  return { ok: true, ultimo: j.ultimo, aviso };
}

// ── funções que rodam DENTRO da página do portal (mundo da página, para usar o jQuery/DataTables dela) ──
async function mainLerLista() {
  const $ = window.jQuery;
  if (!$ || !$.fn.dataTable) return { erro: 'a lista do portal não carregou' };
  const tb = $('table').first();
  const dt = tb.DataTable();
  const esperarDesenho = (fazer) => new Promise((res) => {
    const t = setTimeout(res, 25000);
    tb.one('draw.dt', () => { clearTimeout(t); setTimeout(res, 300); });
    fazer();
  });
  if (dt.page.len() !== 100 || dt.page() !== 0) await esperarDesenho(() => dt.page.len(100).page(0).draw('page'));
  const linhas = [...document.querySelectorAll('table tbody tr')].map((tr) => {
    const c = [...tr.cells];
    const a = tr.querySelector('a[onclick]');
    const m = a && a.getAttribute('onclick').match(/DownloadArquivo\(\s*(\d+)\s*,\s*['"]([^'"]*)['"]\s*\)/);
    const nome = (c[4] ? c[4].innerText : '').trim();
    return {
      id: m ? Number(m[1]) : null, tipo: m ? m[2] : null, nome,
      seq: (nome.match(/_(\d{6,})\.zip$/) || [])[1] || '',
      n: Number(((c[3] ? c[3].innerText : '').match(/cont[eé]m (\d+)/) || [])[1] || 0),
    };
  });
  return { linhas, total: (document.querySelector('.dataTables_info') || {}).innerText || '' };
}

async function mainObterLink(id, tipo) {
  return await new Promise((res) => {
    const orig = window.open;
    let feito = false;
    const fim = (v) => {
      if (feito) return;
      feito = true;
      window.open = orig;
      clearInterval(iv);
      clearTimeout(to);
      res(v);
    };
    window.open = function (u) { fim({ url: new URL(String(u), location.href).href }); return null; };
    // a confirmação "Confirme download do arquivo em nova aba?" → Sim
    const iv = setInterval(() => {
      const sim = [...document.querySelectorAll('button')].find((b) => b.offsetParent && /^\s*sim\s*$/i.test(b.innerText));
      if (sim) sim.click();
    }, 300);
    const to = setTimeout(() => fim({ erro: 'o portal não devolveu o link do arquivo em 60 s' }), 60000);
    try { window.DownloadArquivo(id, tipo); } catch (e) { fim({ erro: String(e).slice(0, 200) }); }
  });
}

async function noPortal(j, func, args) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId: j.tabId }, world: 'MAIN', func, args: args || [] });
  return r ? r.result : null;
}

// 1º caminho: o servidor baixa o zip direto do link (Azure Blob) — nada passa por este computador.
// Espera o download terminar (ou falhar) antes do próximo lote, para nunca pular um lote.
async function servidorBaixa(j, url, nome, aoProgresso) {
  await sure(j, '/claro-pdp/fila/link', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome, url }),
  });
  const alvo = encodeURIComponent(nome);
  let parado = 0, ultimoBytes = -1;
  for (;;) {
    await esperar(2500);
    const d = await (await sure(j, `/claro-pdp/fila/arquivo?f=${alvo}`)).json();
    if (d.status === 'pronto') return { ok: true };
    if (d.status === 'erro') return { ok: false, erro: d.erro || 'falhou' };
    if (d.status !== 'baixando') return { ok: false, erro: 'o servidor perdeu o download (reiniciou?)' };
    aoProgresso(d.bytes || 0, d.total > 0 ? d.total : 0);
    parado = d.bytes === ultimoBytes ? parado + 1 : 0;
    ultimoBytes = d.bytes;
    if (parado > 240) return { ok: false, erro: 'o download no servidor parou por 10 minutos' };
  }
}

// reserva: baixa aqui no navegador e envia ao servidor em partes (mesmo protocolo do antigo receptor local)
async function navegadorEnvia(j, url, nome, aoProgresso) {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`download respondeu ${r.status} (${new URL(url).hostname})`);
  const total = Number(r.headers.get('content-length') || 0);
  const alvo = encodeURIComponent(nome);
  await sure(j, `/claro-pdp/fila/parte?f=${alvo}&mode=start`, { method: 'POST' });
  const leitor = r.body.getReader();
  let buf = [], tam = 0, enviado = 0;
  const despachar = async () => {
    if (!tam) return;
    await sure(j, `/claro-pdp/fila/parte?f=${alvo}`, { method: 'POST', body: new Blob(buf) });
    enviado += tam; buf = []; tam = 0;
    aoProgresso(enviado, total);
  };
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    buf.push(value); tam += value.length;
    if (tam >= PARTE) await despachar();
  }
  await despachar();
  await sure(j, `/claro-pdp/fila/parte?f=${alvo}&mode=done${total ? `&total=${total}` : ''}`, { method: 'POST' });
  return enviado;
}

async function claroBaixar(j) {
  j.status = 'baixando';
  await claroSalvar(j);
  claroParaSure(j, { tipo: 'claro_lendo' });
  const lista = await noPortal(j, mainLerLista);
  if (!lista || lista.erro) return claroFim(j, { erro: (lista && lista.erro) || 'não consegui ler a lista do portal' });
  const ultimo = BigInt(j.ultimo || '0');
  const pend = lista.linhas
    .filter((l) => l.seq && l.id !== null && BigInt(l.seq) > ultimo && !j.fila.includes(l.seq))
    .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
  const talvezMais = pend.length >= lista.linhas.length && lista.linhas.length >= 100;
  claroParaSure(j, { tipo: 'claro_lista', total: pend.length, arquivos: pend.reduce((s, l) => s + l.n, 0), talvezMais });
  let baixados = 0;
  const erros = [];
  for (let i = 0; i < pend.length; i++) {
    const l = pend[i];
    const viva = await chrome.windows.get(j.windowId).then(() => true).catch(() => false);
    if (!viva) { erros.push('a janela do portal foi fechada'); break; }
    try {
      const link = await noPortal(j, mainObterLink, [l.id, l.tipo]);
      if (!link || link.erro) throw new Error((link && link.erro) || 'sem link');
      const prog = (onde) => (env, tot) => claroParaSure(j, {
        tipo: 'claro_progresso', i: i + 1, total: pend.length, nome: l.nome, onde,
        mb: Math.round(env / 1048576), mbTotal: tot ? Math.round(tot / 1048576) : null,
      });
      const srv = await servidorBaixa(j, link.url, l.nome, prog('servidor'));
      if (!srv.ok) {
        claroParaSure(j, { tipo: 'claro_reserva', nome: l.nome, motivo: srv.erro });
        // o link do portal pode valer uma vez só: pede outro antes de baixar por aqui
        const link2 = await noPortal(j, mainObterLink, [l.id, l.tipo]);
        if (!link2 || link2.erro) throw new Error((link2 && link2.erro) || 'sem link');
        await navegadorEnvia(j, link2.url, l.nome, prog('navegador'));
      }
      baixados++;
      claroParaSure(j, { tipo: 'claro_progresso', i: i + 1, total: pend.length, nome: l.nome, concluido: true });
    } catch (e) {
      erros.push(`${l.nome}: ${String(e.message || e).slice(0, 160)}`);
      // um zip que falha no meio não pode virar "último processado": para aqui para não pular lotes
      break;
    }
  }
  return claroFim(j, { baixados, pendentes: pend.length, arquivos: pend.reduce((s, l) => s + l.n, 0), erros, talvezMais });
}

async function claroFim(j, res) {
  claroParaSure(j, { tipo: 'claro_resultado', ...res });
  await claroLimpar(); // apaga também o token da página
  if (!res.erro && !(res.erros && res.erros.length)) chrome.windows.remove(j.windowId).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, responder) => {
  if (!msg || !String(msg.tipo || '').startsWith('claro_')) return false;
  (async () => {
    if (msg.tipo === 'claro_iniciar') return responder(await claroIniciar(msg, sender));

    if (msg.tipo === 'claro_codigo') { // a página do SURE devolveu o código (ou desistiu)
      if (esperaCodigo) { clearTimeout(esperaCodigo.timer); esperaCodigo.resolver(msg); esperaCodigo = null; }
      return responder({});
    }

    if (msg.tipo === 'claro_status') { // situação da fila no servidor
      let fila = null;
      if (apiValida(msg.api)) {
        try { fila = await (await sure({ api: msg.api, token: msg.token }, '/claro-pdp/fila')).json(); } catch (e) { fila = null; }
      }
      const jb = await claroJob();
      if (jb) delete jb.token;
      return responder({ job: jb, fila });
    }

    const j = await claroJob();
    if (!j || !sender.tab || sender.tab.windowId !== j.windowId) return responder({});
    if (!j.tabId) { j.tabId = sender.tab.id; await claroSalvar(j); }

    if (msg.tipo === 'claro_pagina') {
      if (msg.estado === 'login') {
        j.logins++;
        await claroSalvar(j);
        if (j.logins > 2) {
          await claroFim(j, { erro: 'O portal recusou o login duas vezes. Confira usuário e senha nas opções da extensão.' });
          return responder({ faixa: 'SURE: login recusado — confira as opções da extensão.' });
        }
        const { claroUsuario, claroSenha } = await chrome.storage.local.get(['claroUsuario', 'claroSenha']);
        if (!claroUsuario || !claroSenha) {
          j.loginEm = Date.now();
          await claroSalvar(j);
          claroParaSure(j, { tipo: 'claro_aguardando_login' });
          return responder({ acao: 'nada', faixa: 'SURE: entre com o login do portal (para ser automático, guarde o login nas opções da extensão).' });
        }
        j.loginEm = Date.now();
        await claroSalvar(j);
        claroParaSure(j, { tipo: 'claro_entrando' });
        return responder({ acao: 'login', usuario: claroUsuario, senha: claroSenha });
      }
      if (msg.estado === 'escolha') { // tela Accenture / Externo / Primeiro Acesso → login externo
        j.escolhas = (j.escolhas || 0) + 1;
        await claroSalvar(j);
        if (j.escolhas > 3) {
          await claroFim(j, { erro: 'O portal voltou várias vezes para a tela de escolha do login (Accenture/Externo). Entre manualmente e clique de novo.' });
          return responder({});
        }
        return responder({ acao: 'externo' });
      }
      if (msg.estado === 'verificacao') return responder({ acao: 'codigo' });
      if (msg.estado === 'lista') {
        if (j.status !== 'baixando') claroBaixar(j);
        return responder({ faixa: 'SURE: baixando as faturas novas da Claro… não feche esta janela.' });
      }
      j.desvios++;
      await claroSalvar(j);
      if (j.desvios > 4) { await claroFim(j, { erro: 'O portal não abriu a lista de faturas.' }); return responder({}); }
      return responder({ acao: 'ir_lista' });
    }

    if (msg.tipo === 'claro_pedir_codigo') {
      claroParaSure(j, { tipo: 'claro_precisa_codigo', desde: j.loginEm || Date.now() - 600000 });
      const r = await new Promise((resolver) => {
        if (esperaCodigo) { clearTimeout(esperaCodigo.timer); esperaCodigo.resolver({ erro: 'substituído' }); }
        esperaCodigo = { resolver, timer: setTimeout(() => { esperaCodigo = null; resolver({ erro: 'o e-mail com o código não chegou em 3 minutos' }); }, 180000) };
      });
      return responder(r);
    }
    responder({});
  })();
  return true;
});

chrome.windows.onRemoved.addListener(async (id) => {
  const j = await claroJob();
  if (j && j.windowId === id && j.status !== 'baixando') {
    claroParaSure(j, { tipo: 'claro_resultado', erro: 'A janela do portal da Claro foi fechada antes de terminar.' });
    await claroLimpar();
  }
});
