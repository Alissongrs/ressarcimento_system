// Módulo "Registrar na ANEEL" — roda no service worker da extensão (carregado pelo claro_bg.js).
//
// VERSÃO DE TESTE (09/11/2026): o botão do processo no SURE manda os dados do formulário; a extensão abre a
// Ouvidoria da ANEEL numa janela, entra com o login guardado nas opções da extensão (10/11; sem login guardado, a
// pessoa entra; o "não sou robô"/Cloudflare é sempre da pessoa) e, conforme o
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
  // botões no SURE: "Registrar endereço" (cadastro da UC no site), "Protocolar" (solicitação) e a conferência
  // da lista de endereços já cadastrados (lê o site na hora, minimizado; não grava nada em lugar nenhum)
  const fase = msg.modo === 'endereco' ? 'endereco' : msg.modo === 'conferir' ? 'conferir' : 'solicitacao';
  const opcoes = { url: fase === 'endereco' ? REG_ENDERECO : REG_FORM, type: 'popup', width: 1200, height: 900 };
  const win = await chrome.windows.create(fase === 'conferir' ? { ...opcoes, state: 'minimized' } : { ...opcoes, focused: true });
  await regSalvar({
    sureTabId: sender.tab.id, windowId: win.id, dados: msg.dados || {}, teste: true,
    fase, desvios: 0, avisouLogin: false, logins: 0, avisouRecusa: false,
  });
  return { ok: true };
}

async function regTratar(msg, sender) {
  if (msg.tipo === 'reg_iniciar') return regIniciar(msg, sender);

  const j = await regJob();
  if (!j || !sender.tab || sender.tab.windowId !== j.windowId) return {}; // página que não é da janela do SURE

  if (msg.tipo === 'reg_pagina') {
    const p = msg.pagina;
    if (p === 'login') {
      // login automático: usuário/senha guardados nas opções (só neste computador). Para se o site recusar a senha
      // ou depois de 3 tentativas, para não bloquear a conta.
      const { aneelUsuario, aneelSenha } = await chrome.storage.local.get(['aneelUsuario', 'aneelSenha']);
      if (aneelUsuario && aneelSenha && !msg.erroLogin && !j.avisouRecusa && (j.logins || 0) < 3) {
        j.logins = (j.logins || 0) + 1;
        await regSalvar(j);
        if (j.logins === 1) regParaSure(j, { texto: 'Entrando no site da ANEEL com o login guardado na extensão…' });
        return { acao: 'login', usuario: aneelUsuario, senha: aneelSenha };
      }
      if (aneelUsuario && aneelSenha && !j.avisouRecusa) {
        j.avisouRecusa = true;
        await regSalvar(j);
        regParaSure(j, { texto: 'O site da ANEEL não aceitou o login guardado — entre manualmente na janela e confira usuário/senha nas opções da extensão.' });
      }
    }
    if (p === 'login' || p === 'verificacao') {
      chrome.windows.update(j.windowId, { state: 'normal', focused: true }).catch(() => {}); // a pessoa precisa ver
      if (!j.avisouLogin) {
        j.avisouLogin = true;
        await regSalvar(j);
        regParaSure(j, { texto: p === 'login'
          ? 'Entre com o login do site da ANEEL na janela que abriu — depois a extensão continua sozinha.'
          : 'A ANEEL pediu a verificação "não sou robô": resolva na janela que abriu.' });
      }
      return { acao: 'esperar', faixa: p === 'login'
        ? (j.avisouRecusa ? 'SURE: o login guardado não entrou — entre manualmente e confira as opções da extensão.' : j.fase === 'conferir'
          ? 'SURE: entre com o login da Ouvidoria para o SURE conferir os endereços cadastrados.'
          : 'SURE (teste): entre com o login da Ouvidoria. Depois a extensão abre o formulário e preenche — nada será enviado.')
        : 'SURE (teste): resolva a verificação do site para continuar.' };
    }
    if (p === 'solicitacao' && j.fase === 'conferir') return { acao: 'ler_enderecos' };
    if (p === 'solicitacao' && j.fase === 'solicitacao') {
      regParaSure(j, { texto: 'Preenchendo o formulário da ANEEL…' });
      return { acao: 'preencher_solicitacao', dados: j.dados, teste: true };
    }
    if (p === 'endereco' && j.fase === 'endereco') {
      regParaSure(j, { texto: 'Preenchendo o cadastro do endereço da UC (sem salvar)…' });
      return { acao: 'preencher_endereco', dados: j.dados, teste: true };
    }
    // logado em outra página (ex.: início depois do login): volta para onde precisa
    j.desvios++;
    await regSalvar(j);
    if (j.desvios > 5) {
      await regFim(j, { erro: 'O site da ANEEL não abriu o formulário. Abra-o manualmente na janela e clique de novo no SURE.' });
      return {};
    }
    return { acao: 'ir', url: j.fase === 'endereco' ? REG_ENDERECO : REG_FORM }; // 'conferir' lê no formulário
  }

  if (msg.tipo === 'reg_progresso') {
    regParaSure(j, { texto: msg.texto || '' });
    return {};
  }

  if (msg.tipo === 'reg_resultado') {
    await regFim(j, { texto: msg.texto, detalhes: msg.detalhes, erro: msg.erro, enderecos: msg.enderecos });
    if (j.fase === 'conferir' && !msg.erro) chrome.windows.remove(j.windowId).catch(() => {}); // só leitura: fecha
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
    regParaSure(j, { fim: true, erro: j.fase === 'conferir'
      ? 'A janela da ANEEL foi fechada antes de ler os endereços.'
      : 'A janela da ANEEL foi fechada antes de terminar o preenchimento.' });
    await regLimpar();
  }
});
