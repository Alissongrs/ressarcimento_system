// Coordena a consulta: recebe da página do SURE a lista de protocolos abertos, abre a janela da
// ANEEL, espera o usuário entrar, recebe o que a janela leu, devolve à página do SURE (que grava com
// o login dela) e fecha a janela. A extensão não guarda nem usa credencial nenhuma do SURE.

const ANEEL = 'https://www2.aneel.gov.br/faleconosco/';

async function job() {
  return (await chrome.storage.session.get('job')).job || null;
}
async function salvar(j) {
  await chrome.storage.session.set({ job: j });
}
function paraSure(j, dados) {
  if (j && j.sureTabId) chrome.tabs.sendMessage(j.sureTabId, { paraSure: true, dados }).catch(() => {});
}

async function iniciar(msg, sender) {
  const atual = await job();
  if (atual && atual.status === 'lendo') return { erro: 'Já existe uma consulta em andamento.' };
  const lista = (msg.lista || []).filter((p) => /^[\d.\-]{13,16}$/.test(p));
  if (!lista.length) return { erro: 'Nenhum protocolo aberto para consultar.' };
  const win = await chrome.windows.create({ url: ANEEL, type: 'popup', width: 980, height: 760, focused: true });
  await salvar({ sureTabId: sender.tab.id, windowId: win.id, lista, status: 'aguardando_login' });
  return { total: lista.length };
}

chrome.runtime.onMessage.addListener((msg, sender, responder) => {
  (async () => {
    if (msg.tipo === 'iniciar') return responder(await iniciar(msg, sender));
    const j = await job();
    // daqui para baixo, só a janela que a extensão abriu
    if (!j || !sender.tab || sender.tab.windowId !== j.windowId) return responder({});
    if (msg.tipo === 'pagina_aneel') {
      if (msg.logado && j.status === 'aguardando_login') {
        j.status = 'lendo';
        await salvar(j);
        paraSure(j, { tipo: 'lendo', total: j.lista.length });
        return responder({ ler: j.lista });
      }
      return responder({});
    }
    if (msg.tipo === 'progresso') {
      paraSure(j, { tipo: 'progresso', feito: msg.feito, total: j.lista.length });
      return responder({});
    }
    if (msg.tipo === 'resultado') {
      paraSure(j, { tipo: 'resultado', itens: msg.itens || [], erro: msg.erro || null, total: j.lista.length });
      await chrome.storage.session.remove('job');
      if (!msg.erro) chrome.windows.remove(j.windowId).catch(() => {});
      return responder({});
    }
    responder({});
  })();
  return true; // resposta assíncrona
});

// usuário fechou a janela antes de terminar
chrome.windows.onRemoved.addListener(async (id) => {
  const j = await job();
  if (j && j.windowId === id) {
    paraSure(j, { tipo: 'resultado', itens: [], erro: 'A janela da ANEEL foi fechada antes de terminar.', total: j.lista.length });
    await chrome.storage.session.remove('job');
  }
});
