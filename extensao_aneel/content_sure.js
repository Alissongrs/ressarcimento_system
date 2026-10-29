// Ponte entre a página do SURE e a extensão.
// A página pede a consulta com window.postMessage; o progresso volta pelo mesmo caminho.
(() => {
  document.documentElement.dataset.sureAneelExt = '1';
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
    } else if (d.tipo === 'ping') {
      avisar({ tipo: 'pronta' });
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.paraSure) avisar(msg.dados);
  });
})();
