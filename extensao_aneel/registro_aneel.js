// "Registrar na ANEEL" — roda nas páginas da Ouvidoria (www2.aneel.gov.br/faleconosco). Só age na janela que o
// SURE abriu (o registro_bg.js confere). VERSÃO DE TESTE: preenche e NÃO envia — o botão "Registrar Solicitação"
// e o "Registrar endereço" ficam bloqueados nesta janela. Não digita senha, não mexe no "Não sou um robô".
(() => {
  if (window.top !== window) return;

  const porta = chrome.runtime.connect({ name: 'sure-reg' });
  const fila = [];
  porta.onMessage.addListener((r) => { const f = fila.shift(); if (f) f(r || {}); });
  porta.onDisconnect.addListener(() => { while (fila.length) fila.shift()({}); });
  const pedir = (msg) => new Promise((res) => { fila.push(res); try { porta.postMessage(msg); } catch (e) { fila.pop(); res({}); } });

  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const texto = () => (document.body ? document.body.innerText : '');
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
  const visivel = (e) => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));

  let barra = null;
  function faixa(msg, cor = '#0f506e') {
    if (!document.body) return;
    if (!barra) {
      barra = document.createElement('div');
      barra.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;padding:10px 16px;font:bold 14px sans-serif;color:#fff;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.3)';
      document.body.appendChild(barra);
    }
    barra.style.background = cor;
    barra.textContent = msg;
  }

  function qualPagina() {
    const t = texto();
    const caminho = location.pathname.toLowerCase();
    if (/Efetuar Login/i.test(t) || document.querySelector('input[type=password]')) return 'login';
    if (/verify you are human|verifique se voc[eê] [eé] humano|confirme que voc[eê] [eé] humano|checking your browser/i.test(t)) return 'verificacao';
    if (caminho.endsWith('/formsolicitacao.asp') && document.querySelector('[name=resumo_manifestacao]')) return 'solicitacao';
    if (caminho.endsWith('/form_endereco.asp') && document.querySelector('[name=cep]')) return 'endereco';
    return 'outra';
  }

  // valor como se a pessoa tivesse digitado (máscaras e contadores do site escutam esses eventos)
  function digitar(el, valor) {
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    el.focus();
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, valor);
    for (const ev of ['input', 'keyup', 'change']) el.dispatchEvent(new Event(ev, { bubbles: true }));
    el.blur();
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }
  function escolher(sel, valor) {
    if (!sel || ![...sel.options].some((o) => o.value === valor)) return false;
    sel.value = valor;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  async function aguardar(cond, ms = 10000) {
    const fim = Date.now() + ms;
    while (Date.now() < fim) { if (cond()) return true; await esperar(250); }
    return !!cond();
  }
  // radio pelo valor (rdTitular: S/N no site) ou, se mudar, pelo texto do <label for> ao lado
  function radioPor(nome, valor, re) {
    const rs = [...document.getElementsByName(nome)];
    return rs.find((r) => r.value === valor) || rs.find((r) => {
      const l = r.id && document.querySelector(`label[for="${r.id}"]`);
      const t = (l && l.innerText) || (r.closest('label') && r.closest('label').innerText) ||
        (r.nextElementSibling && r.nextElementSibling.innerText) || '';
      return re.test(t);
    });
  }

  // bloqueia o envio nesta janela (teste): botão desligado + qualquer submit do formulário cancelado
  function travarEnvio(botao, rotulo) {
    if (botao) {
      botao.disabled = true;
      botao.style.pointerEvents = 'none';
      botao.style.opacity = '0.4';
      botao.title = 'Bloqueado pelo SURE: é só um teste';
      const aviso = document.createElement('div');
      aviso.style.cssText = 'margin:8px 0;padding:8px 12px;background:#fde68a;color:#7c2d12;font:bold 13px sans-serif;border-radius:4px';
      aviso.textContent = `TESTE DO SURE — "${rotulo}" bloqueado nesta janela. Nada será enviado.`;
      botao.parentElement && botao.parentElement.insertBefore(aviso, botao);
    }
    for (const f of document.forms) {
      f.addEventListener('submit', (e) => { e.preventDefault(); e.stopImmediatePropagation(); faixa('SURE (teste): envio bloqueado.', '#b45309'); }, true);
    }
  }

  // ───────────────────────── formulário de solicitação ─────────────────────────
  async function preencherSolicitacao(d) {
    const f = document.forms.form1 || document.querySelector('[name=resumo_manifestacao]').form;
    const ok = [];
    const falhou = [];
    const campo = (n) => f.elements[n];
    const por = (nome, rotulo, valor) => {
      if (valor === undefined || valor === null || String(valor).trim() === '') return;
      if (digitar(campo(nome), String(valor))) ok.push(rotulo); else falhou.push(`${rotulo}: campo não encontrado`);
    };
    travarEnvio(campo('registrar') || [...f.querySelectorAll('input[type=button],button')].find((b) => /registrar/i.test(b.value || b.innerText)), 'Registrar Solicitação');
    faixa('SURE (teste): preenchendo o formulário… não mexa na janela por alguns segundos.');

    // 1) quem registra
    const r = d.titular === 'sim' ? radioPor('rdTitular', 'S', /^\s*Sim/i) : radioPor('rdTitular', 'N', /procurador/i);
    if (r) { r.click(); ok.push(d.titular === 'sim' ? 'Titular: Sim' : 'Titular: procurador'); } else falhou.push('Titular/procurador: opção não encontrada');
    await esperar(400);

    // 2) identificação, UC, registros anteriores, resumo
    por('nome_consumidor', 'Nome do consumidor', d.nome_consumidor);
    por('email_consumidor', 'E-mail do consumidor', d.email_consumidor);
    por('tel_consumidor', 'Telefone do consumidor', d.tel_consumidor);
    por('cpf_consumidor', 'CPF/CNPJ do consumidor', d.cpf_consumidor);
    if (d.titular !== 'sim') {
      por('nome_procurador', 'Nome do procurador', d.nome_procurador);
      por('email_procurador', 'E-mail do procurador', d.email_procurador);
      por('tel_procurador', 'Telefone do procurador', d.tel_procurador);
      por('cpf_procurador', 'CPF/CNPJ do procurador', d.cpf_procurador);
    }
    por('classe_consumo', 'Classe de consumo', d.classe_consumo);
    por('grupo_tarifario', 'Grupo tarifário', d.grupo_tarifario);
    por('numero_protocolo_cta', 'Protocolo CTA', d.numero_protocolo_cta);
    por('data_protocolo', 'Data CTA', d.data_protocolo);
    por('ouvidoria_distribuidora', 'Protocolo Ouvidoria', d.ouvidoria_distribuidora);
    por('data_ouvidoria', 'Data Ouvidoria', d.data_ouvidoria);
    por('resumo_manifestacao', 'Resumo da manifestação', d.resumo_manifestacao);

    // 3) endereço da UC (lista dos já cadastrados no site)
    const uc = String(d.end_uc || '').replace(/\D/g, '').replace(/^0+/, '');
    const selEnd = campo('endereco');
    const opcao = uc && selEnd && [...selEnd.options].find((o) =>
      (o.text.match(/\d[\d.\-]*/g) || []).some((x) => x.replace(/\D/g, '').replace(/^0+/, '') === uc));
    if (!opcao) {
      faixa(`SURE (teste): a UC ${d.end_uc || '(em branco)'} não está na lista de endereços do site — use "Registrar endereço" no SURE primeiro.`, '#b91c1c');
      await pedir({
        tipo: 'reg_resultado',
        erro: `A UC ${d.end_uc || '(em branco)'} não está cadastrada no site da ANEEL. Clique primeiro em "Registrar endereço" e depois em "Protocolar".`,
        detalhes: ok.length ? [`Já preenchidos antes de parar: ${ok.join(', ')}`] : undefined,
      });
      return;
    }
    escolher(selEnd, opcao.value);
    ok.push(`Endereço: ${opcao.text.trim().slice(0, 70)}`);
    await aguardar(() => visivel(document.getElementsByName('optFormaContato')[0]), 6000);

    // 4) forma de resposta, protocolo junto ao concessionário
    const forma = [...document.getElementsByName('optFormaContato')].find((x) => x.value === String(d.forma_contato || '4'));
    if (forma) { forma.click(); ok.push(`Resposta por ${forma.value === '4' ? 'e-mail' : 'carta'}`); } else falhou.push('Forma de resposta: opção não encontrada');
    por('numero_protocolo', 'Protocolo junto ao concessionário', d.numero_protocolo);

    // 5) natureza → assunto (a lista de assuntos carrega depois da natureza)
    if (escolher(campo('TituloClassificacao'), String(d.natureza || '2'))) {
      ok.push('Natureza do contato');
      const carregou = await aguardar(() => campo('natureza_solicitacao') && campo('natureza_solicitacao').options.length > 1, 12000);
      if (!carregou) falhou.push('Assunto: a lista não carregou');
      else if (escolher(campo('natureza_solicitacao'), String(d.assunto || ''))) ok.push('Classificação (assunto)');
      else falhou.push(`Assunto: código ${d.assunto} não existe na lista do site`);
    } else falhou.push('Natureza do contato: opção não encontrada');

    // 6) motivo (o campo aparece depois do assunto)
    await aguardar(() => visivel(campo('mensagem')), 8000);
    por('mensagem', 'Motivo do contato', d.mensagem);

    // conferência: lê de volta o que ficou em cada campo de texto
    const conferir = ['nome_consumidor', 'email_consumidor', 'cpf_consumidor', 'resumo_manifestacao', 'mensagem'];
    for (const n of conferir) {
      const el = campo(n);
      if (el && d[n] && el.value.trim() !== String(d[n]).trim()) falhou.push(`${n}: o site guardou "${el.value.slice(0, 40)}" (máscara/limite?)`);
    }

    const captcha = document.querySelector('.g-recaptcha');
    if (captcha) captcha.scrollIntoView({ block: 'center', behavior: 'smooth' });
    faixa('SURE (TESTE): formulário preenchido — confira os campos. NADA foi enviado e o botão Registrar está bloqueado.', falhou.length ? '#b45309' : '#15803d');
    await pedir({
      tipo: 'reg_resultado',
      texto: `Teste concluído: ${ok.length} campos preenchidos${falhou.length ? `, ${falhou.length} com problema` : ''}. Nada foi enviado — confira na janela da ANEEL.`,
      detalhes: falhou.length ? falhou : undefined,
    });
  }

  // ───────────────────────── cadastro de endereço (não salva no teste) ─────────────────────────
  async function preencherEndereco(d) {
    const f = document.querySelector('[name=cep]').form;
    const campo = (n) => f.elements[n];
    const ok = [];
    const falhou = [];
    travarEnvio(campo('B1') || [...f.querySelectorAll('input[type=button],input[type=submit],button')].find((b) => /registrar|salvar|gravar/i.test(b.value || b.innerText)), 'Registrar endereço');
    faixa('SURE (teste): preenchendo o cadastro do endereço da UC… não mexa na janela por alguns segundos.');
    const por = (nome, rotulo, valor) => {
      if (!valor) return;
      if (digitar(campo(nome), String(valor))) ok.push(rotulo); else falhou.push(`${rotulo}: campo não encontrado`);
    };
    por('identificao', 'Identificação do local', d.end_identificacao);
    por('cep', 'CEP', String(d.end_cep || '').replace(/\D/g, ''));

    // UF → município → distribuidora (cada lista carrega depois da anterior)
    const uf = String(d.end_uf || '').toUpperCase();
    const ufOpt = uf && [...campo('uf').options].find((o) => norm(o.text).startsWith(uf + ' '));
    if (ufOpt && escolher(campo('uf'), ufOpt.value)) {
      ok.push('UF');
      if (await aguardar(() => campo('cidade').options.length > 1, 12000)) {
        const alvo = norm(d.end_cidade);
        const cid = [...campo('cidade').options].find((o) => norm(o.text) === alvo);
        if (cid && escolher(campo('cidade'), cid.value)) {
          ok.push('Município');
          if (await aguardar(() => campo('concessionario').options.length > 1, 12000)) {
            const generic = /^(DISTRIBUIDORA|ENERGIA|ELETRICA|COMPANHIA|CIA|S\/?A|SA|DE|DO|DA|DOS|DAS|E|LTDA)$/;
            const tokens = norm(d.end_distribuidora).split(/[\s\-_/]+/).filter((t) => t.length >= 3 && !generic.test(t));
            const cands = [...campo('concessionario').options].filter((o) => o.value && tokens.some((t) => norm(o.text).includes(t)));
            if (cands.length === 1 && escolher(campo('concessionario'), cands[0].value)) ok.push(`Distribuidora: ${cands[0].text.trim()}`);
            else falhou.push(`Distribuidora: escolha na lista (${cands.length ? 'mais de uma parecida com' : 'nenhuma parecida com'} "${d.end_distribuidora}")`);
          } else falhou.push('Distribuidora: a lista não carregou');
        } else falhou.push(`Município "${d.end_cidade}" não encontrado na lista de ${uf}`);
      } else falhou.push('Município: a lista não carregou');
    } else falhou.push(`UF "${uf}" não encontrada`);

    por('bairro', 'Bairro', d.end_bairro);
    por('rua', 'Endereço', d.end_rua);
    por('complemento', 'Complemento', d.end_complemento);
    por('UC', 'Unidade consumidora', d.end_uc);
    if (d.titular === 'sim' && campo('souTitular') && !campo('souTitular').checked) { campo('souTitular').click(); ok.push('Sou o titular'); }
    if (!d.end_bairro) falhou.push('Bairro: em branco (o site exige)');

    faixa('SURE (TESTE): cadastro do endereço preenchido — confira. NADA foi salvo (botão de registrar bloqueado).', falhou.length ? '#b45309' : '#15803d');
    await pedir({
      tipo: 'reg_resultado',
      texto: `Teste do endereço concluído: ${ok.length} campos preenchidos${falhou.length ? `, ${falhou.length} com problema` : ''}. Nada foi salvo — confira na janela da ANEEL.`,
      detalhes: falhou.length ? falhou : undefined,
    });
  }

  (async () => {
    // espera a página assentar (o site carrega listas por script depois do load)
    await esperar(800);
    const pagina = qualPagina();
    const r = await pedir({ tipo: 'reg_pagina', pagina });
    if (!r || !r.acao) return; // não é a janela do SURE
    if (r.faixa) faixa(r.faixa, '#b45309');
    try {
      if (r.acao === 'ir') location.href = r.url;
      else if (r.acao === 'preencher_solicitacao') await preencherSolicitacao(r.dados || {});
      else if (r.acao === 'preencher_endereco') await preencherEndereco(r.dados || {});
      else if (r.acao === 'ler_enderecos') {
        // lista "Selecione o endereço" = endereços já cadastrados na conta (só leitura)
        const sel = document.querySelector('[name=endereco]');
        const enderecos = sel ? [...sel.options].filter((o) => o.value && o.value !== '0').map((o) => ({ id: o.value, texto: o.text.trim() })) : [];
        await pedir({ tipo: 'reg_resultado', enderecos, texto: `${enderecos.length} endereços cadastrados no site.`, erro: sel ? undefined : 'a lista de endereços não apareceu no formulário' });
      }
    } catch (e) {
      faixa('SURE (teste): erro ao preencher — ' + String(e.message || e).slice(0, 120), '#b91c1c');
      await pedir({ tipo: 'reg_resultado', erro: 'Erro ao preencher no site da ANEEL: ' + String(e.message || e).slice(0, 200) });
    }
  })();
})();
