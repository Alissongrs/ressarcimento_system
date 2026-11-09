// Roda nas páginas do portal PDP da Claro. Só age na janela que o SURE abriu (o background confirma).
// Login: preenche usuário/senha guardados nas opções da extensão e envia; na tela do código, pede ao
// SURE o código que chegou por e-mail e envia. Depois o background lê a lista e baixa os zips.
(() => {
  if (window.top !== window) return;
  const texto = () => (document.body ? document.body.innerText : '');
  const visivel = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

  function botaoExterno() {
    return [...document.querySelectorAll('button, a, input[type=button]')]
      .find((b) => visivel(b) && (/ExtLogin/.test(b.getAttribute('onclick') || '') || /^\s*externo\s*$/i.test(b.innerText || b.value || '')));
  }

  function estadoDaPagina() {
    const senha = [...document.querySelectorAll('input[type=password]')].find(visivel);
    if (senha) return 'login';
    // tela de escolha (Accenture / Externo / Primeiro Acesso): os campos só aparecem em /Account/LoginExterno
    if (botaoExterno()) return 'escolha';
    if (/LoginExternoVerificacao/i.test(location.pathname) || /C[oó]digo de verifica/i.test(texto())) return 'verificacao';
    if (/ListarFaturaEnergiaEletrica/i.test(location.pathname)) return 'lista';
    if (/\/Account\//i.test(location.pathname)) return 'conta';
    return 'outra';
  }

  function faixa(msg) {
    let d = document.getElementById('sure-faixa');
    if (!d) {
      d = document.createElement('div');
      d.id = 'sure-faixa';
      d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:10px 16px;font:14px sans-serif;' +
        'background:#0f506e;color:#fff;text-align:center';
      document.body.appendChild(d);
    }
    d.textContent = msg;
  }

  function preencher(el, valor) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus();
    set.call(el, valor);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function enviar(form, campo) {
    const botao = (form || document).querySelector('button[type=submit], input[type=submit], button:not([type])') ||
      [...document.querySelectorAll('button, input[type=button]')].find((b) => visivel(b) && /enviar|entrar|acessar/i.test(b.innerText || b.value));
    if (botao) botao.click();
    else if (form) (form.requestSubmit ? form.requestSubmit() : form.submit());
    else if (campo) campo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }

  const estado = estadoDaPagina();
  chrome.runtime.sendMessage({ tipo: 'claro_pagina', estado, caminho: location.pathname }, (r) => {
    if (chrome.runtime.lastError || !r || !r.acao) return;
    if (r.faixa) faixa(r.faixa);

    if (r.acao === 'login') {
      const senha = [...document.querySelectorAll('input[type=password]')].find(visivel);
      const form = senha.form;
      const usuario = [...(form || document).querySelectorAll('input[type=text], input[type=email], input:not([type])')]
        .filter(visivel).find((i) => i !== senha);
      if (!usuario) { faixa('SURE: não achei o campo de usuário — entre manualmente.'); return; }
      preencher(usuario, r.usuario);
      preencher(senha, r.senha);
      faixa('SURE: entrando no portal…');
      setTimeout(() => enviar(form, senha), 400);
    } else if (r.acao === 'codigo') {
      const campo = [...document.querySelectorAll('input[type=text], input[type=number], input[type=tel], input:not([type])')].find(visivel);
      if (!campo) { faixa('SURE: não achei o campo do código — digite manualmente.'); return; }
      faixa('SURE: esperando o código de segurança chegar por e-mail…');
      chrome.runtime.sendMessage({ tipo: 'claro_pedir_codigo' }, (c) => {
        if (chrome.runtime.lastError || !c || !c.codigo) {
          faixa('SURE: o código não chegou a tempo — ' + ((c && c.erro) || 'digite manualmente') + '.');
          return;
        }
        preencher(campo, c.codigo);
        faixa('SURE: código recebido, entrando…');
        setTimeout(() => enviar(campo.form, campo), 400);
      });
    } else if (r.acao === 'externo') {
      const b = botaoExterno();
      if (b) { faixa('SURE: abrindo o login externo…'); b.click(); } else location.href = '/Account/LoginExterno';
    } else if (r.acao === 'ir_lista') {
      location.href = '/RoboProcessoExecucao/ListarFaturaEnergiaEletrica';
    }
  });
})();
