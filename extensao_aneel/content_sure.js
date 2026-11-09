// Ponte entre a página do SURE e a extensão.
// A página pede a consulta com window.postMessage; o progresso volta pelo mesmo caminho.
// ANEEL: tipo 'consultar'. Faturas Claro: 'claro_atualizar', 'claro_codigo' (resposta ao pedido de código), 'claro_status'.
// Claro: a página manda junto o login dela (token) — a extensão usa só para falar com a fila da Claro no próprio
// SURE (/api/v1/claro-pdp/fila) durante a atualização e não guarda depois.
(() => {
  document.documentElement.dataset.sureAneelExt = '1';
  document.documentElement.dataset.sureClaroExt = '2'; // 2 = processamento da Claro na VPS (extensão 1.3)
  document.documentElement.dataset.sureExtVersao = chrome.runtime.getManifest().version; // p/ conferir se o Chrome recarregou
  const avisar = (msg) => window.postMessage({ origem: 'sure-aneel-ext', ...msg }, location.origin);
  avisar({ tipo: 'pronta', claro: 2 });

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
    } else if (d.tipo === 'claro_atualizar') {
      chrome.runtime.sendMessage({ tipo: 'claro_iniciar', token: d.token || '', api: location.origin + '/api/v1' }, (r) => {
        if (chrome.runtime.lastError) avisar({ tipo: 'claro_resultado', erro: chrome.runtime.lastError.message });
        else if (r && r.erro) avisar({ tipo: 'claro_resultado', erro: r.erro });
        else avisar({ tipo: 'claro_aberto', ultimo: r?.ultimo, aviso: r?.aviso || '' });
      });
    } else if (d.tipo === 'claro_codigo') {
      chrome.runtime.sendMessage({ tipo: 'claro_codigo', codigo: d.codigo || '', erro: d.erro || '' });
    } else if (d.tipo === 'claro_status') {
      chrome.runtime.sendMessage({ tipo: 'claro_status', token: d.token || '', api: location.origin + '/api/v1' }, (r) => {
        if (!chrome.runtime.lastError) avisar({ tipo: 'claro_status', ...(r || {}) });
      });
    } else if (d.tipo === 'aneel_registro') { // "Registrar na ANEEL" do processo (por enquanto só teste: não envia)
      // porta própria (registro_bg.js), para não disputar resposta com os outros módulos no onMessage
      const porta = chrome.runtime.connect({ name: 'sure-reg' });
      let respondeu = false;
      porta.onMessage.addListener((r) => {
        respondeu = true;
        porta.disconnect();
        if (r && r.erro) avisar({ tipo: 'reg_estado', fim: true, erro: r.erro });
        else avisar({ tipo: 'reg_estado', texto: 'Janela da ANEEL aberta. Se pedir, entre com o login do site.' });
      });
      porta.onDisconnect.addListener(() => {
        if (!respondeu) avisar({ tipo: 'reg_estado', fim: true, erro: 'A extensão não respondeu — atualize-a para a versão 1.4.0 (↻ em chrome://extensions).' });
      });
      porta.postMessage({ tipo: 'reg_iniciar', modo: d.modo === 'endereco' ? 'endereco' : 'solicitacao', dados: d.dados || {}, teste: d.teste !== false });
    } else if (d.tipo === 'ping') {
      avisar({ tipo: 'pronta', claro: 2 });
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.paraSure) avisar(msg.dados);
  });
})();
