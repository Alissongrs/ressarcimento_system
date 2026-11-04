// Ponte entre a página do SURE e a extensão.
// A página pede a consulta com window.postMessage; o progresso volta pelo mesmo caminho.
// ANEEL: tipo 'consultar'. Faturas Claro: 'claro_atualizar', 'claro_codigo' (resposta ao pedido de código), 'claro_status'.
(() => {
  document.documentElement.dataset.sureAneelExt = '1';
  document.documentElement.dataset.sureClaroExt = '1';
  const avisar = (msg) => window.postMessage({ origem: 'sure-aneel-ext', ...msg }, location.origin);
  avisar({ tipo: 'pronta', claro: true });

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
      chrome.runtime.sendMessage({ tipo: 'claro_iniciar' }, (r) => {
        if (chrome.runtime.lastError) avisar({ tipo: 'claro_resultado', erro: chrome.runtime.lastError.message });
        else if (r && r.erro) avisar({ tipo: 'claro_resultado', erro: r.erro });
        else avisar({ tipo: 'claro_aberto', ultimo: r?.ultimo });
      });
    } else if (d.tipo === 'claro_codigo') {
      chrome.runtime.sendMessage({ tipo: 'claro_codigo', codigo: d.codigo || '', erro: d.erro || '' });
    } else if (d.tipo === 'claro_status') {
      chrome.runtime.sendMessage({ tipo: 'claro_status' }, (r) => {
        if (!chrome.runtime.lastError) avisar({ tipo: 'claro_status', ...(r || {}) });
      });
    } else if (d.tipo === 'ping') {
      avisar({ tipo: 'pronta', claro: true });
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.paraSure) avisar(msg.dados);
  });
})();
