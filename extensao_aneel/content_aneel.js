// Roda nas páginas da Ouvidoria da ANEEL. Não faz login: espera o usuário entrar e, só na janela
// aberta pelo SURE, lê a situação de cada protocolo (Meus Registros → busca → detalhe).
(() => {
  if (window.top !== window) return; // ignora os iframes que a própria leitura cria
  const texto = () => (document.body ? document.body.innerText : '');
  const logado = /Lista Meus Registros|Detalhes da Solicita/.test(texto()) && !/Efetuar Login/.test(texto());

  chrome.runtime.sendMessage({ tipo: 'pagina_aneel', logado }, async (r) => {
    if (chrome.runtime.lastError || !r || !r.ler) return;
    await lerTodos(r.ler);
  });

  function faixa(baixo) {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:10px 16px;font:14px sans-serif;' +
      'background:#0f506e;color:#fff;text-align:center';
    d.textContent = baixo;
    document.body.appendChild(d);
    return d;
  }

  // Texto inteiro da(s) resposta(s) ao consumidor, mantendo parágrafos e quebras de linha
  // (<br>, <p>, <div> viram quebra; links somem). Mais recente primeiro, como no site.
  function respostaCompleta(d) {
    // a tabela mais interna com "Resposta ao Consumidor" (a de fora é o layout da página inteira)
    const tb = [...d.querySelectorAll('table')].filter((t) => /Resposta ao Consumidor/.test(t.textContent)).pop();
    if (!tb) return '';
    const blocos = [];
    for (const tr of tb.rows) {
      const cel = [...tr.cells];
      if (cel.length < 2 || !/^\s*\d{2}\/\d{2}\/\d{4}/.test(cel[0].textContent)) continue;
      // a mensagem é a célula mais longa depois da data (a linha tem uma célula vazia no fim)
      const c = cel.slice(1).reduce((a, b) => (b.textContent.length > a.textContent.length ? b : a)).cloneNode(true);
      c.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
      c.querySelectorAll('p,div,li').forEach((b) => b.append('\n'));
      const t = c.textContent.replace(/\r/g, '').replace(/https?:\/\/\S+/g, '').replace(/[ \t ]+/g, ' ')
        .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (t) blocos.push(`${cel[0].textContent.trim().slice(0, 16)}\n${t}`);
    }
    return blocos.join('\n\n———\n\n').slice(0, 20000);
  }

  function lerUm(protocolo) {
    return new Promise((fim) => {
      const f = document.createElement('iframe');
      f.style.display = 'none';
      document.body.appendChild(f);
      let enviou = false;
      const acabar = (o) => { clearTimeout(t); f.remove(); fim(o); };
      const t = setTimeout(() => acabar({ erro: 'timeout' }), 30000);
      f.onload = () => {
        try {
          const d = f.contentDocument;
          const caminho = f.contentWindow.location.pathname;
          const tx = d.body ? d.body.innerText : '';
          if (/Efetuar Login/.test(tx)) return acabar({ erro: 'deslogado' });
          if (!enviou) {
            const campo = d.getElementById('txtConsulta');
            if (!campo) return acabar({ erro: 'cloudflare' }); // não abriu a lista: provável verificação
            enviou = true;
            campo.value = protocolo;
            campo.form.submit();
            return;
          }
          if (/solicitacao_detalhes/.test(caminho)) {
            const g = (re) => ((tx.match(re) || [])[1] || '').trim();
            const hist = (tx.split('Histórico')[1] || '').split('Resposta ao Consumidor')[0];
            const datas = [...hist.matchAll(/(\d{2}\/\d{2}\/\d{4})\s+[A-ZÀ-Ú]/g)].map((m) => m[1]);
            return acabar({
              protocolo: g(/Número:\s*([\d.\-]+)/) || protocolo,
              status: g(/Situação:\s*([^\n]+)/),
              ultima_mov: datas[0] || '',
              entrada: g(/Entrada:\s*([\d/]+)/),
              resposta: respostaCompleta(d),
              // "Endereço" costuma trazer empresa, UC e endereço: o SURE usa a UC para achar o processo
              endereco: g(/Endere[cç]o:\s*(.+)/),
            });
          }
          if (/não encontrou resultado/.test(tx)) return acabar({ erro: 'nao_encontrado' });
          return acabar({ erro: 'outra_pagina' });
        } catch (e) {
          acabar({ erro: String(e).slice(0, 120) });
        }
      };
      f.src = 'listaMeusRegistros.asp';
    });
  }

  async function lerTodos(lista) {
    const aviso = faixa(`SURE: lendo ${lista.length} protocolos… não feche esta janela.`);
    const itens = [];
    let erro = null;
    for (let i = 0; i < lista.length; i++) {
      const o = await lerUm(lista[i]);
      if (o.erro === 'deslogado' || o.erro === 'cloudflare') {
        erro = o.erro === 'deslogado'
          ? 'A sessão da ANEEL caiu. Entre de novo e clique em consultar outra vez.'
          : 'A ANEEL pediu a verificação de novo. Resolva na janela e clique em consultar outra vez.';
        break;
      }
      if (!o.erro && o.status) itens.push(o);
      aviso.textContent = `SURE: lendo protocolos… ${i + 1} de ${lista.length}. Não feche esta janela.`;
      if ((i + 1) % 5 === 0) chrome.runtime.sendMessage({ tipo: 'progresso', feito: i + 1 });
      await new Promise((r) => setTimeout(r, 700));
    }
    aviso.textContent = erro ? `SURE: ${erro}` : 'SURE: enviando para o sistema…';
    chrome.runtime.sendMessage({ tipo: 'resultado', itens, erro });
  }
})();
