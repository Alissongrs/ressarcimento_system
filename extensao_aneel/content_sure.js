// Ponte entre a página do SURE e a extensão.
// A página pede a consulta com window.postMessage; o progresso volta pelo mesmo caminho.
// ANEEL: tipo 'consultar' (protocolos) e 'aneel_registro' (Registrar endereço / Protocolar).
(() => {
  document.documentElement.dataset.sureAneelExt = '1';
  document.documentElement.dataset.sureExtVersao = chrome.runtime.getManifest().version; // p/ conferir se o Chrome recarregou
  const avisar = (msg) => window.postMessage({ origem: 'sure-aneel-ext', ...msg }, location.origin);
  avisar({ tipo: 'pronta' });

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data || {};
    if (d.origem !== 'sure-pagina') return;
    if (d.tipo === 'consultar') {
      chrome.runtime.sendMessage({ tipo: 'iniciar', lista: d.lista }, (r) => {
        if (chrome.runtime.lastError) avisar({ tipo: 'erro', erro: chrome.runtime.lastError.message });
        else if (r && r.erro) avisar({ tipo: 'erro', erro: r.erro });
        else avisar({ tipo: 'aguardando_login', total: r?.total ?? 0 });
      });
    } else if (d.tipo === 'aneel_registro') { // "Registrar na ANEEL" do processo (por enquanto só teste: não envia)
      // porta própria (registro_bg.js), para não disputar resposta com os outros módulos no onMessage
      const porta = chrome.runtime.connect({ name: 'sure-reg' });
      let respondeu = false;
      porta.onMessage.addListener((r) => {
        respondeu = true;
        porta.disconnect();
        if (r && r.erro) avisar({ tipo: 'reg_estado', fim: true, erro: r.erro });
        else avisar({ tipo: 'reg_estado', texto: d.modo === 'conferir' ? 'Conferindo os endereços cadastrados no site da ANEEL…' : 'Janela da ANEEL aberta. Se pedir, entre com o login do site.' });
      });
      porta.onDisconnect.addListener(() => {
        if (!respondeu) avisar({ tipo: 'reg_estado', fim: true, erro: 'A extensão não respondeu — atualize-a para a versão 1.4.0 (↻ em chrome://extensions).' });
      });
      porta.postMessage({ tipo: 'reg_iniciar', modo: ['endereco', 'conferir'].includes(d.modo) ? d.modo : 'solicitacao', dados: d.dados || {}, teste: d.teste !== false });
    } else if (d.tipo === 'ping') {
      avisar({ tipo: 'pronta' });
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.paraSure) avisar(msg.dados);
  });
})();
