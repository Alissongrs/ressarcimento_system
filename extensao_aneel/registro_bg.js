// Módulo "Registrar na ANEEL" — roda no service worker da extensão (carregado pelo claro_bg.js).
//
// VERSÃO DE TESTE (09/11/2026): o botão do processo no SURE manda os dados do formulário; a extensão abre a
// Ouvidoria da ANEEL numa janela, espera a pessoa entrar (login e verificação anti-robô são dela) e, conforme o
// botão ("Registrar endereço" ou "Protocolar"), preenche o cadastro do endereço da UC SEM salvar ou o
// formulário de solicitação SEM enviar (o botão "Registrar Solicitação" fica bloqueado). Nada é gravado.
//
// Conversa com os content scripts por chrome.runtime.connect (porta 'sure-reg') e não por onMessage, para não
// disputar resposta com os outros módulos da extensão.
const REG_FORM = 'https://www2.aneel.gov.br/faleconosco/formSolicitacao.asp';
const REG_ENDERECO = 'https://www2.aneel.gov.br/faleconosco/form_endereco.asp';

async function regJob() { return (await chrome.storage.session.get('jobReg')).jobReg || null; }
async function regSalvar(j) { await chrome.storage.session.set({ jobReg: j }); }
async function regLimpar() { await chrome.storage.session.remove('jobReg'); }
function regParaSure(j, dados) {
  if (j && j.sureTabId) chrome.tabs.sendMessage(j.sureTabId, { paraSure: true, dados: { tipo: 'reg_estado', ...dados } }).catch(() => {});
}

async function regIniciar(msg, sender) {
  if (!sender.tab) return { erro: 'pedido sem aba de origem' };
  if (msg.teste === false) return { erro: 'O envio de verdade ainda não está liberado — só o teste (preencher sem enviar).' };
  const atual = await regJob();
  if (atual) {
    const viva = await chrome.windows.get(atual.windowId).then(() => true).catch(() => false);
    if (viva) {
      chrome.windows.update(atual.windowId, { focused: true }).catch(() => {});
      return { erro: 'Já existe um preenchimento da ANEEL aberto — feche aquela janela para começar outro.' };
    }
  }
  // dois botões no SURE: "Registrar endereço" (cadastro da UC no site) e "Protocolar" (solicitação)
  const fase = msg.modo === 'endereco' ? 'endereco' : 'solicitacao';
  const win = await chrome.windows.create({ url: fase === 'endereco' ? REG_ENDERECO : REG_FORM, type: 'popup', width: 1200, height: 900, focused: true });
  await regSalvar({
    sureTabId: sender.tab.id, windowId: win.id, dados: msg.dados || {}, teste: true,
    fase, desvios: 0, avisouLogin: false,
  });
  return { ok: true };
}

async function regTratar(msg, sender) {
  if (msg.tipo === 'reg_iniciar') return regIniciar(msg, sender);

  const j = await regJob();
  if (!j || !sender.tab || sender.tab.windowId !== j.windowId) return {}; // página que não é da janela do SURE

  if (msg.tipo === 'reg_pagina') {
    const p = msg.pagina;
    if (p === 'login' || p === 'verificacao') {
      if (!j.avisouLogin) {
        j.avisouLogin = true;
        await regSalvar(j);
        regParaSure(j, { texto: p === 'login'
          ? 'Entre com o login do site da ANEEL na janela que abriu — depois a extensão continua sozinha.'
          : 'A ANEEL pediu a verificação "não sou robô": resolva na janela que abriu.' });
      }
      return { acao: 'esperar', faixa: p === 'login'
        ? 'SURE (teste): entre com o login da Ouvidoria. Depois a extensão abre o formulário e preenche — nada será enviado.'
        : 'SURE (teste): resolva a verificação do site para continuar.' };
    }
    if (p === 'solicitacao' && j.fase === 'solicitacao') {
      regParaSure(j, { texto: 'Preenchendo o formulário da ANEEL…' });
      return { acao: 'preencher_solicitacao', dados: j.dados, teste: true };
    }
    if (p === 'endereco' && j.fase === 'endereco') {
      regParaSure(j, { texto: 'A UC não está cadastrada no site: preenchendo o cadastro do endereço (sem salvar)…' });
      return { acao: 'preencher_endereco', dados: j.dados, teste: true };
    }
    // logado em outra página (ex.: início depois do login): volta para onde precisa
    j.desvios++;
    await regSalvar(j);
    if (j.desvios > 5) {
      await regFim(j, { erro: 'O site da ANEEL não abriu o formulário. Abra-o manualmente na janela e clique de novo no SURE.' });
      return {};
    }
    return { acao: 'ir', url: j.fase === 'endereco' ? REG_ENDERECO : REG_FORM };
  }

  if (msg.tipo === 'reg_progresso') {
    regParaSure(j, { texto: msg.texto || '' });
    return {};
  }

  if (msg.tipo === 'reg_resultado') {
    await regFim(j, { texto: msg.texto, detalhes: msg.detalhes, erro: msg.erro });
    return {};
  }
  return {};
}

// fim do preenchimento: avisa o SURE; a janela fica aberta para a pessoa conferir (é teste)
async function regFim(j, res) {
  regParaSure(j, { fim: true, ...res });
  await regLimpar();
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sure-reg') return;
  port.onMessage.addListener(async (msg) => {
    let r;
    try { r = await regTratar(msg || {}, port.sender || {}); } catch (e) { r = { erro: String(e.message || e) }; }
    try { port.postMessage(r || {}); } catch (e) { /* a página fechou */ }
  });
});

chrome.windows.onRemoved.addListener(async (id) => {
  const j = await regJob();
  if (j && j.windowId === id) {
    regParaSure(j, { fim: true, erro: 'A janela da ANEEL foi fechada antes de terminar o preenchimento.' });
    await regLimpar();
  }
});
