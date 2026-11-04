// Módulo "Faturas Claro" (portal PDP Claro / Accenture) — roda no service worker da extensão.
//
// Botão "Atualizar faturas Claro" no SURE → abre o portal numa janela → (se a sessão caiu) entra com o login
// guardado nas opções e com o código de segurança que o SURE lê no e-mail → lê a lista de zips → baixa só os
// lotes MAIS NOVOS que o último já processado → entrega cada zip, em partes, ao receptor local
// (ferramentas/claro_pdp/recv_claro.py, 127.0.0.1:8801). Os consumidores locais extraem, sobem os PDFs para o
// Google Drive e gravam os links no banco. A extensão não grava nada no SURE.

const CLARO_RECV = 'http://127.0.0.1:8801/';
const CLARO_BASE_PADRAO = 'https://clarobps-pdp.azurewebsites.net';
const CLARO_LISTA = '/RoboProcessoExecucao/ListarFaturaEnergiaEletrica';
const PARTE = 8 * 1024 * 1024;

let esperaCodigo = null; // { resolver, timer }

async function claroJob() { return (await chrome.storage.session.get('jobClaro')).jobClaro || null; }
async function claroSalvar(j) { await chrome.storage.session.set({ jobClaro: j }); }
async function claroLimpar() { await chrome.storage.session.remove('jobClaro'); }
function claroParaSure(j, dados) {
  if (j && j.sureTabId) chrome.tabs.sendMessage(j.sureTabId, { paraSure: true, dados }).catch(() => {});
}

async function recv(caminho, opcoes) {
  const r = await fetch(CLARO_RECV + caminho, opcoes);
  if (!r.ok) throw new Error('receptor local respondeu ' + r.status);
  return r;
}

async function claroIniciar(sender) {
  const atual = await claroJob();
  if (atual && atual.status !== 'fim') {
    // janela antiga fechada sem aviso? libera
    const viva = await chrome.windows.get(atual.windowId).then(() => true).catch(() => false);
    if (viva) return { erro: 'Já existe uma atualização da Claro em andamento.' };
  }
  let feitos, stat;
  try {
    feitos = await (await recv('?feitos')).json();
    stat = await (await recv('?stat')).json();
  } catch (e) {
    return { erro: 'O processamento local da Claro está desligado neste computador. Rode ferramentas\\claro_pdp\\iniciar.ps1 e tente de novo.' };
  }
  if (stat.freeGB < 8) return { erro: `Pouco espaço em disco no C: (${stat.freeGB} GB livres; precisa de pelo menos 8 GB).` };
  const { claroBase } = await chrome.storage.local.get('claroBase');
  const base = (claroBase || CLARO_BASE_PADRAO).replace(/\/+$/, '');
  const win = await chrome.windows.create({ url: base + CLARO_LISTA, type: 'popup', width: 1100, height: 780, focused: true });
  const j = {
    sureTabId: sender.tab.id, windowId: win.id, tabId: win.tabs && win.tabs[0] ? win.tabs[0].id : null,
    status: 'abrindo', ultimo: feitos.ultimo || '0', fila: feitos.fila || [], loginEm: 0, logins: 0, desvios: 0,
  };
  await claroSalvar(j);
  return { ok: true, ultimo: j.ultimo };
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

// baixa o zip do link (Azure Blob) e entrega ao receptor local em partes
async function transferir(url, nome, aoProgresso) {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`download respondeu ${r.status} (${new URL(url).hostname})`);
  const total = Number(r.headers.get('content-length') || 0);
  const alvo = encodeURIComponent(nome);
  await recv(`?f=${alvo}&mode=start`, { method: 'POST' });
  const leitor = r.body.getReader();
  let buf = [], tam = 0, enviado = 0;
  const despachar = async () => {
    if (!tam) return;
    await recv(`?f=${alvo}`, { method: 'POST', body: new Blob(buf) });
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
  const noDisco = Number(await (await recv(`?f=${alvo}`)).text());
  if (total && noDisco !== total) throw new Error(`arquivo incompleto (${noDisco} de ${total} bytes)`);
  await recv(`?f=${alvo}&mode=done`, { method: 'POST' });
  return noDisco;
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
      await transferir(link.url, l.nome, (env, tot) => claroParaSure(j, {
        tipo: 'claro_progresso', i: i + 1, total: pend.length, nome: l.nome,
        mb: Math.round(env / 1048576), mbTotal: tot ? Math.round(tot / 1048576) : null,
      }));
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
  await claroLimpar();
  if (!res.erro && !(res.erros && res.erros.length)) chrome.windows.remove(j.windowId).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, responder) => {
  if (!msg || !String(msg.tipo || '').startsWith('claro_')) return false;
  (async () => {
    if (msg.tipo === 'claro_iniciar') return responder(await claroIniciar(sender));

    if (msg.tipo === 'claro_codigo') { // a página do SURE devolveu o código (ou desistiu)
      if (esperaCodigo) { clearTimeout(esperaCodigo.timer); esperaCodigo.resolver(msg); esperaCodigo = null; }
      return responder({});
    }

    if (msg.tipo === 'claro_status') {
      let local = null;
      try { local = { ...(await (await recv('?stat')).json()), ...(await (await recv('?feitos')).json()) }; } catch (e) { local = null; }
      if (local) { local.feitos_total = (local.feitos || []).length; delete local.feitos; }
      return responder({ job: await claroJob(), local });
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
