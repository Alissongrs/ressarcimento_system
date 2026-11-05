// Ponte entre a página do SURE e a extensão.
// A página pede a consulta com window.postMessage; o progresso volta pelo mesmo caminho.
// ANEEL: tipo 'consultar'. Faturas Claro: 'claro_atualizar', 'claro_codigo' (resposta ao pedido de código), 'claro_status'.
// Claro: a página manda junto o login dela (token) — a extensão usa só para falar com a fila da Claro no próprio
// SURE (/api/v1/claro-pdp/fila) durante a atualização e não guarda depois.
(() => {
  document.documentElement.dataset.sureAneelExt = '1';
  document.documentElement.dataset.sureClaroExt = '2'; // 2 = processamento da Claro na VPS (extensão 1.3)
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
    } else if (d.tipo === 'ping') {
      avisar({ tipo: 'pronta', claro: 2 });
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.paraSure) avisar(msg.dados);
  });
})();
