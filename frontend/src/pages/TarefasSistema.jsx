// src/pages/TarefasSistema.jsx
// Tarefas do sistema (só admin): roda pela tela as tarefas que ficam na VPS — pdf_pipeline (extração das
// faturas de energia) e agua_sync (faturas de água; as regras de água rodam no backend). O botão cria um pedido já aprovado
// (o mesmo caminho do chat) e o worker da VPS (worker/run_jobs.py, a cada minuto) executa e devolve o
// andamento e o resultado aqui. Backend: GET/POST /api/v1/tarefas-vps (handlers/tarefas_handler.go).
import React, { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck, Play, RefreshCw, Server } from 'lucide-react';
import api from '../services/apiClient.js';
import BaixarExtensao from '../components/BaixarExtensao.jsx';

const card = { borderColor: 'var(--border)', background: 'var(--card)' };

const STATUS = {
  aprovado: { rot: 'na fila', cor: '#d97706' },
  pendente: { rot: 'na fila', cor: '#d97706' },
  executando: { rot: 'rodando', cor: '#2563eb' },
  executado: { rot: 'concluída', cor: '#1f9d6b' },
  erro: { rot: 'erro', cor: '#dc2626' },
  revisao: { rot: 'não executada', cor: '#6b7280' },
  revertido: { rot: 'revertida', cor: '#6b7280' },
};

function fmt(d) {
  if (!d) return '—';
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? '—' : t.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function Badge({ status }) {
  const s = STATUS[status] || { rot: status, cor: '#6b7280' };
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
      style={{ background: `color-mix(in srgb, ${s.cor} 15%, transparent)`, color: s.cor }}>
      {(status === 'executando' || status === 'aprovado' || status === 'pendente') && <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: s.cor }} />}
      {s.rot}
    </span>
  );
}

// texto com **negrito**, blocos ``` e tabelas | a | b | — sem HTML cru
function negrito(linha, k) {
  return linha.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith('**') && p.endsWith('**')
    ? <strong key={`${k}-${i}`}>{p.slice(2, -2)}</strong> : <React.Fragment key={`${k}-${i}`}>{p}</React.Fragment>));
}
function Resultado({ texto }) {
  if (!texto) return <div className="text-sm opacity-60">Ainda sem retorno do servidor.</div>;
  const partes = texto.split('```');
  return (
    <div className="text-sm space-y-2">
      {partes.map((p, i) => {
        if (i % 2 === 1) {
          return (
            <details key={i}>
              <summary className="text-xs cursor-pointer opacity-70">Ver log técnico</summary>
              <pre className="text-xs p-2 mt-1 rounded overflow-x-auto max-h-72" style={{ background: 'var(--bg-subtle, rgba(127,127,127,.08))' }}>{p.replace(/^\n/, '')}</pre>
            </details>
          );
        }
        const linhas = p.split('\n');
        const blocos = [];
        let tab = [];
        const fechaTab = (k) => {
          if (!tab.length) return;
          const rows = tab.filter((l) => !/^\|\s*-/.test(l)).map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
          blocos.push(
            <table key={`t${k}`} className="text-xs border-collapse">
              <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => (ri === 0
                ? <th key={ci} className="px-2 py-1 text-left border-b" style={{ borderColor: 'var(--border)' }}>{negrito(c, ci)}</th>
                : <td key={ci} className="px-2 py-1">{negrito(c, ci)}</td>))}</tr>)}</tbody>
            </table>,
          );
          tab = [];
        };
        linhas.forEach((l, k) => {
          if (l.trim().startsWith('|')) { tab.push(l.trim()); return; }
          fechaTab(k);
          if (l.trim()) blocos.push(<div key={k}>{negrito(l, k)}</div>);
        });
        fechaTab('fim');
        return <div key={i} className="space-y-1">{blocos}</div>;
      })}
    </div>
  );
}

const n0 = (v) => (v === undefined || v === null ? '—' : Number(v).toLocaleString('pt-BR'));
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// números da execução (o worker grava; execuções antigas são lidas do texto)
function Numeros({ m, job }) {
  if (!m) return null;
  const itens = [{ rot: job === 'pdf_pipeline' ? 'Faturas extraídas' : 'Faturas novas', v: n0(m.faturas_novas) }];
  if (m.faturas_erro !== undefined) itens.push({ rot: 'Com erro', v: n0(m.faturas_erro), cor: m.faturas_erro > 0 ? '#dc2626' : undefined });
  if (job === 'agua_sync') {
    itens.push({ rot: 'Apontamentos novos', v: n0(m.apontamentos_novos) });
    if (m.apontamentos_atualizados !== undefined) itens.push({ rot: 'Atualizados', v: n0(m.apontamentos_atualizados) });
    if (m.ressarcimento_novos) itens.push({ rot: 'Estimado (novos)', v: brl(m.ressarcimento_novos) });
  } else {
    itens.push({ rot: 'Apontamentos', v: 'na aba Energia', pequeno: true });
  }
  return (
    <div className="flex flex-wrap gap-2">
      {itens.map((i) => (
        <div key={i.rot} className="rounded border px-3 py-1.5 min-w-[7.5rem]" style={{ borderColor: 'var(--border)' }}>
          <div className="text-[11px] uppercase tracking-wide opacity-60">{i.rot}</div>
          <div className={i.pequeno ? 'text-sm opacity-70' : 'text-lg font-semibold tabular-nums'} style={i.cor ? { color: i.cor } : undefined}>{i.v}</div>
        </div>
      ))}
    </div>
  );
}

// qualidade dos dados por amostragem (só leitura)
function Qualidade({ base }) {
  const [dias, setDias] = useState(7);
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState('');
  const sortear = useCallback(async (d) => {
    setCarregando(true);
    setErro('');
    try {
      const { data } = await api.get('/tarefas-vps/qualidade', { params: { base, dias: d, n: 30 } });
      setDados(data);
    } catch (e) {
      setErro(e?.response?.data?.error || 'Não consegui calcular a amostra.');
    } finally { setCarregando(false); }
  }, [base]);
  useEffect(() => { sortear(dias); }, [sortear, dias]);
  const cor = (pct) => (pct >= 95 ? '#1f9d6b' : pct >= 80 ? '#d97706' : '#dc2626');
  return (
    <div className="rounded border p-3 space-y-3" style={{ borderColor: 'var(--border)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <ClipboardCheck className="w-4 h-4 opacity-70" />
        <span className="font-medium text-sm">Qualidade dos dados (amostra)</span>
        <select value={dias} onChange={(e) => setDias(Number(e.target.value))} className="ml-auto px-2 py-1 rounded border bg-transparent text-sm" style={{ borderColor: 'var(--border)' }}>
          {[1, 7, 30, 90].map((d) => <option key={d} value={d}>faturas dos últimos {d} dia{d > 1 ? 's' : ''}</option>)}
        </select>
        <button type="button" onClick={() => sortear(dias)} disabled={carregando} className="px-2 py-1 rounded border text-sm disabled:opacity-50" style={{ borderColor: 'var(--border)' }}>
          {carregando ? 'Sorteando…' : 'Sortear outra amostra'}
        </button>
      </div>
      {erro && <div className="text-sm" style={{ color: '#dc2626' }}>{erro}</div>}
      {dados && dados.amostra === 0 && <div className="text-sm opacity-70">Nenhuma fatura entrou nesse período.</div>}
      {dados && dados.amostra > 0 && (
        <>
          <div className="text-sm">
            <span className="text-lg font-semibold tabular-nums" style={{ color: cor(dados.pct_sem_erro) }}>{dados.pct_sem_erro.toLocaleString('pt-BR')}%</span>
            {' '}da amostra sem dado obrigatório faltando · {dados.amostra} sorteadas de {n0(dados.total_no_periodo)} que entraram desde {String(dados.desde).split('-').reverse().join('/')}
          </div>
          <table className="w-full text-xs">
            <thead><tr className="text-left opacity-60"><th className="py-1">Checagem</th><th className="py-1 w-40">OK na amostra</th><th className="py-1">Por que importa</th></tr></thead>
            <tbody>
              {dados.checagens.map((c) => (
                <tr key={c.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="py-1 pr-2">{c.rotulo}{c.nivel === 'alerta' && <span className="opacity-60"> (alerta)</span>}</td>
                  <td className="py-1 pr-2">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-20 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
                        <div className="h-full" style={{ width: `${c.pct_ok}%`, background: c.nivel === 'erro' ? cor(c.pct_ok) : '#6b7280' }} />
                      </div>
                      <span className="tabular-nums">{c.pct_ok.toLocaleString('pt-BR')}%</span>
                      {c.falhas > 0 && <span className="opacity-60">({c.falhas})</span>}
                    </div>
                  </td>
                  <td className="py-1 opacity-70">{c.porque}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {dados.faturas_com_problema.length > 0 && (
            <details>
              <summary className="text-sm cursor-pointer">Ver as {dados.faturas_com_problema.length} fatura(s) da amostra com problema</summary>
              <div className="overflow-x-auto mt-2">
                <table className="w-full text-xs">
                  <thead><tr className="text-left opacity-60"><th className="py-1">Fatura</th><th>Empresa</th><th>UC</th><th>Origem</th><th>Mês</th><th>Dados</th><th>Problemas</th><th /></tr></thead>
                  <tbody>
                    {dados.faturas_com_problema.map((l) => (
                      <tr key={l.id} className="border-t align-top" style={{ borderColor: 'var(--border)' }}>
                        <td className="py-1 pr-2 tabular-nums">{l.id}</td>
                        <td className="pr-2">{l.cod_empresa}</td>
                        <td className="pr-2">{l.uc || '—'}</td>
                        <td className="pr-2">{l.origem || '—'}</td>
                        <td className="pr-2">{l.mes || '—'}</td>
                        <td className="pr-2 whitespace-nowrap">{l.resumo}</td>
                        <td className="pr-2">{l.problemas.join(' · ')}</td>
                        <td>{l.link && /^https?:\/\//.test(l.link) && <a href={l.link} target="_blank" rel="noopener noreferrer" className="underline">fatura</a>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

// situação da base: quando entrou a última fatura e quantas entraram (só leitura)
function Situacao({ job, recarregar }) {
  const [s, setS] = useState(null);
  const [verEmp, setVerEmp] = useState(false);
  useEffect(() => {
    api.get('/tarefas-vps/situacao', { params: { job } }).then(({ data }) => setS(data)).catch(() => setS(null));
  }, [job, recarregar]);
  if (!s) return null;
  const parado = s.dias_sem_entrar >= 7;
  const quando = s.dias_sem_entrar < 0 ? '—' : s.dias_sem_entrar === 0 ? 'hoje' : s.dias_sem_entrar === 1 ? 'ontem' : `há ${s.dias_sem_entrar} dias`;
  const energia = job === 'pdf_pipeline';
  const itens = [
    { rot: energia ? 'Última fatura extraída' : 'Última fatura recebida', v: `${fmt(s.ultima).split(' ')[0]} (${quando})`, cor: parado ? '#d97706' : undefined },
    { rot: 'Últimas 24h', v: n0(s.d1) },
    { rot: 'Últimos 7 dias', v: n0(s.d7) },
    { rot: 'Últimos 30 dias', v: n0(s.d30) },
  ];
  return (
    <div className="rounded border p-3 space-y-2" style={{ borderColor: 'var(--border)' }}>
      <div className="text-xs uppercase tracking-wide opacity-60">Situação da base {energia ? 'de energia' : job === 'claro_pdp' ? 'Claro' : 'de água'}</div>
      <div className="flex flex-wrap gap-2">
        {itens.map((i) => (
          <div key={i.rot} className="rounded border px-3 py-1.5 min-w-[7.5rem]" style={{ borderColor: 'var(--border)' }}>
            <div className="text-[11px] uppercase tracking-wide opacity-60">{i.rot}</div>
            <div className="text-sm font-semibold tabular-nums" style={i.cor ? { color: i.cor } : undefined}>{i.v}</div>
          </div>
        ))}
      </div>
      {parado && <div className="text-xs" style={{ color: '#d97706' }}>Nenhuma fatura {energia ? 'extraída' : 'nova'} {quando}.</div>}
      {s.por_empresa_30d?.length > 0 && (
        <div>
          <button type="button" onClick={() => setVerEmp((v) => !v)} className="text-xs underline opacity-70">
            {verEmp ? 'Esconder por empresa' : 'Ver por empresa (30 dias)'}
          </button>
          {verEmp && (
            <table className="text-xs mt-1">
              <thead><tr className="text-left opacity-60"><th className="pr-4 py-1">Empresa</th><th className="pr-4 text-right">Faturas</th><th>Última</th></tr></thead>
              <tbody>
                {s.por_empresa_30d.map((e) => (
                  <tr key={e.cod_empresa} className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="pr-4 py-0.5">{e.cod_empresa || 'sem código'}{e.nome ? ` · ${e.nome}` : ''}</td>
                    <td className="pr-4 text-right tabular-nums">{n0(e.n30)}</td>
                    <td>{fmt(e.ultima)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// Faturas Claro: a extensão do SURE (mesma da ANEEL) abre o portal PDP da Claro, entra (login guardado na extensão +
// código lido do e-mail pelo backend) e manda o link de cada zip novo para a fila da Claro NO SERVIDOR
// (/claro-pdp/fila). A VPS baixa, extrai, sobe para o Drive e grava os links (worker/job_claro.sh).
// Aqui só pedimos, acompanhamos e respondemos o pedido de código.
const tokenDaPagina = () => {
  try { return String(localStorage.getItem('userToken') || '').trim().replace(/^['"]+|['"]+$/g, ''); } catch { return ''; }
};

function CartaoClaro() {
  // '2' = extensão 1.3+, que manda para o servidor (a 1.2 ainda procurava o processamento local do PC)
  const [temExt, setTemExt] = useState(() => document.documentElement.dataset.sureClaroExt === '2');
  const [extAntiga, setExtAntiga] = useState(() => document.documentElement.dataset.sureClaroExt === '1');
  const [rodando, setRodando] = useState(false);
  const [linhas, setLinhas] = useState([]);
  const [fim, setFim] = useState(null);
  const [fila, setFila] = useState(null);
  const [rec, setRec] = useState(0);
  const add = (t) => setLinhas((l) => [...l.filter((x) => !(t.chave && x.chave === t.chave)), t].slice(-12));

  useEffect(() => {
    let cancelado = false;
    const buscarCodigo = async (desde) => {
      add({ chave: 'cod', txt: 'Login enviado; esperando o código de segurança chegar por e-mail…' });
      for (let i = 0; i < 36 && !cancelado; i++) {
        try {
          const { data } = await api.get('/claro-pdp/codigo', { params: { desde } });
          if (data?.codigo) {
            add({ chave: 'cod', txt: 'Código de segurança recebido do e-mail — entrando no portal.' });
            window.postMessage({ origem: 'sure-pagina', tipo: 'claro_codigo', codigo: data.codigo }, window.location.origin);
            return;
          }
        } catch (e) {
          add({ chave: 'cod', txt: `Não consegui ler o e-mail do código: ${e?.response?.data?.error || e.message}` });
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      window.postMessage({ origem: 'sure-pagina', tipo: 'claro_codigo', erro: 'não chegou' }, window.location.origin);
    };
    const ouvir = (ev) => {
      if (ev.source !== window) return;
      const d = ev.data || {};
      if (d.origem !== 'sure-aneel-ext') return;
      if (d.tipo === 'pronta' && d.claro === 2) { setTemExt(true); setExtAntiga(false); }
      else if (d.tipo === 'pronta' && d.claro) setExtAntiga(true);
      else if (d.tipo === 'claro_aberto') {
        add({ txt: `Portal da Claro aberto (último lote já processado: ${d.ultimo || '—'}).` });
        if (d.aviso) add({ txt: `Atenção: ${d.aviso}.` });
      }
      else if (d.tipo === 'claro_aguardando_login') add({ txt: 'Entre com o login na janela do portal (para ser automático, guarde o login nas opções da extensão).' });
      else if (d.tipo === 'claro_entrando') add({ chave: 'cod', txt: 'Entrando no portal com o login guardado…' });
      else if (d.tipo === 'claro_precisa_codigo') buscarCodigo(d.desde);
      else if (d.tipo === 'claro_lendo') add({ txt: 'Lendo a lista de lotes do portal…' });
      else if (d.tipo === 'claro_lista') {
        add({ txt: d.total ? `${d.total} lote(s) novo(s) para baixar (${n0(d.arquivos)} arquivos).` : 'Nenhum lote novo no portal — está tudo carregado.' });
        if (d.talvezMais) add({ txt: 'Atenção: pode haver mais lotes além dos 100 mais recentes — rode de novo depois.' });
      } else if (d.tipo === 'claro_progresso') {
        add({ chave: 'prog', txt: d.concluido ? `Lote ${d.i} de ${d.total} na fila do servidor (${d.nome}).`
          : `${d.onde === 'navegador' ? 'Enviando ao servidor por este navegador' : 'O servidor está baixando'} o lote ${d.i} de ${d.total}: ${d.mb} MB${d.mbTotal ? ` de ${d.mbTotal} MB` : ''}…` });
      } else if (d.tipo === 'claro_reserva') {
        add({ txt: `O servidor não conseguiu baixar ${d.nome} direto do portal (${d.motivo}) — baixando por este navegador e enviando ao servidor.` });
      } else if (d.tipo === 'claro_resultado') {
        setRodando(false);
        setFim(d);
        setRec((x) => x + 1);
      }
    };
    window.addEventListener('message', ouvir);
    window.postMessage({ origem: 'sure-pagina', tipo: 'ping' }, window.location.origin);
    return () => { cancelado = true; window.removeEventListener('message', ouvir); };
  }, []);

  // situação da fila da Claro no servidor (direto da API; não depende da extensão)
  useEffect(() => {
    let vivo = true;
    const ler = () => api.get('/claro-pdp/fila').then(({ data }) => { if (vivo) setFila(data); }).catch(() => {});
    ler();
    const t = setInterval(ler, rodando ? 10000 : 30000);
    return () => { vivo = false; clearInterval(t); };
  }, [rodando, rec]);

  const atualizar = () => {
    setLinhas([]);
    setFim(null);
    setRodando(true);
    window.postMessage({ origem: 'sure-pagina', tipo: 'claro_atualizar', token: tokenDaPagina() }, window.location.origin);
  };

  return (
    <div className="rounded-lg border p-4 flex flex-col gap-3" style={card}>
      <div className="flex items-start gap-3">
        <Server className="w-5 h-5 mt-0.5 opacity-70" strokeWidth={1.5} />
        <div className="flex-1 min-w-0">
          <div className="font-semibold">Faturas Claro (portal PDP)</div>
          <div className="text-sm opacity-75 mt-0.5">
            Pega no portal da Claro os lotes (zips) novos; o servidor baixa, extrai as faturas, sobe os PDFs para o Google Drive e grava no banco.
            O login no portal roda pela extensão do SURE neste navegador; o resto é no servidor, sem precisar deixar nada ligado no computador.
          </div>
          <div className="text-xs opacity-60 mt-1">
            manual (pelo botão) · o portal libera 1 lote por dia, por volta das 4h
            {fila && ` · servidor: ${fila.pending} lote(s) na fila, ${fila.feitos_total} processado(s)${fila.freeGB >= 0 ? `, ${Number(fila.freeGB).toFixed(1)} GB livres` : ''}`}
          </div>
          {fila && fila.worker && (!fila.worker.ativo || (fila.worker.aviso && fila.worker.aviso !== 'ok' && !/^subindo/.test(fila.worker.aviso))) && (
            <div className="text-xs mt-1" style={{ color: '#d97706' }}>
              {!fila.worker.ativo
                ? 'O processamento da Claro no servidor não está rodando (o cron do worker na VPS não deu sinal nos últimos minutos) — os lotes ficam na fila até ele voltar.'
                : `Processamento da Claro no servidor: ${fila.worker.aviso}.`}
            </div>
          )}
        </div>
        {rodando && <Badge status="executando" />}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={atualizar} disabled={!temExt || rodando}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium text-white disabled:opacity-50"
          style={{ background: 'var(--accent, #2563eb)' }}>
          <Play className="w-4 h-4" /> {rodando ? 'Atualizando…' : 'Atualizar faturas Claro'}
        </button>
        {!temExt && <span className="text-xs" style={{ color: '#d97706' }}>{extAntiga
          ? 'A extensão do SURE deste navegador é antiga (ela mandava para o processamento do computador). Atualize para a versão 1.3 — "Baixar a extensão do SURE", no topo da página — e clique no ↻ dela em chrome://extensions.'
          : 'Instale ou atualize a extensão do SURE (versão 1.3) neste navegador para usar o botão — "Baixar a extensão do SURE", no topo da página.'}</span>}
      </div>
      {(linhas.length > 0 || fim) && (
        <div className="rounded border p-3 text-sm space-y-1" style={{ borderColor: 'var(--border)' }}>
          {linhas.map((l, i) => <div key={i}>{l.txt}</div>)}
          {fim && (fim.erro ? <div style={{ color: '#dc2626' }}><strong>Não concluiu:</strong> {fim.erro}</div> : (
            <div>
              <strong>{fim.baixados ? `${fim.baixados} lote(s) entregue(s) ao processamento` : 'Nada novo para baixar'}</strong>
              {fim.baixados ? ' — a extração, o upload para o Drive e os links rodam em segundo plano no servidor; o número abaixo sobe conforme entram.' : '.'}
              {fim.erros?.length > 0 && <div style={{ color: '#dc2626' }}>Parou em: {fim.erros.join(' · ')}</div>}
            </div>
          ))}
        </div>
      )}
      {fila && fila.log && fila.log.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer opacity-70">Últimos registros do processamento no servidor</summary>
          <pre className="mt-1 p-2 rounded border whitespace-pre-wrap" style={{ borderColor: 'var(--border)' }}>{fila.log.join('\n')}</pre>
        </details>
      )}
      <Situacao job="claro_pdp" recarregar={rec} />
    </div>
  );
}

function CartaoTarefa({ t, atual, onRodar }) {
  const [empresas, setEmpresas] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [verQualidade, setVerQualidade] = useState(false);
  const ocupada = atual && atual.em_andamento;
  const rodar = async () => {
    const msg = t.job === 'pdf_pipeline'
      ? `Rodar a extração das faturas de energia agora${empresas ? ` (empresas ${empresas})` : ' (todas as empresas do agendamento)'}? Ela faz backup do banco antes e pode levar horas.`
      : `Rodar a sincronização das faturas de água agora${empresas ? ` (empresas ${empresas})` : ' (todas as empresas)'}?`;
    if (!window.confirm(msg)) return;
    setEnviando(true);
    try { await onRodar(t.job, empresas.trim()); setEmpresas(''); } finally { setEnviando(false); }
  };
  return (
    <div className="rounded-lg border p-4 flex flex-col gap-3" style={card}>
      <div className="flex items-start gap-3">
        <Server className="w-5 h-5 mt-0.5 opacity-70" strokeWidth={1.5} />
        <div className="flex-1 min-w-0">
          <div className="font-semibold">{t.nome}</div>
          <div className="text-sm opacity-75 mt-0.5">{t.descricao}</div>
          <div className="text-xs opacity-60 mt-1">{t.agenda} · {t.duracao}</div>
        </div>
        {atual && <Badge status={atual.status} />}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {t.com_empresas && (
          <input value={empresas} onChange={(e) => setEmpresas(e.target.value)} disabled={ocupada || enviando}
            placeholder="empresas (opcional): 4, 189…" className="px-2 py-1.5 rounded border bg-transparent text-sm w-64 max-w-full"
            style={{ borderColor: 'var(--border)' }} />
        )}
        <button type="button" onClick={rodar} disabled={ocupada || enviando}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium text-white disabled:opacity-50"
          style={{ background: 'var(--accent, #2563eb)' }}>
          <Play className="w-4 h-4" /> {ocupada ? 'Em andamento' : enviando ? 'Enviando…' : 'Rodar agora'}
        </button>
        <button type="button" onClick={() => setVerQualidade((v) => !v)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border text-sm" style={{ borderColor: 'var(--border)' }}>
          <ClipboardCheck className="w-4 h-4" /> {verQualidade ? 'Fechar qualidade' : 'Qualidade dos dados'}
        </button>
        {atual && <span className="text-xs opacity-60">última: pedido #{atual.id} por {atual.usuario || '—'} em {fmt(atual.criado_em)}</span>}
      </div>
      {atual && !atual.em_andamento && atual.motivo_falha && (
        <div className="rounded border px-3 py-2 text-sm" style={{ borderColor: '#dc2626' }}>
          <strong style={{ color: '#dc2626' }}>A última execução falhou:</strong> {atual.motivo_falha}.
        </div>
      )}
      {atual && !atual.em_andamento && !atual.motivo_falha && <Numeros m={atual.metricas} job={t.job} />}
      <Situacao job={t.job} recarregar={atual ? `${atual.id}-${atual.status}` : ''} />
      {verQualidade && <Qualidade base={t.job === 'pdf_pipeline' ? 'energia' : 'agua'} />}
      {atual && (
        <div className="rounded border p-3" style={{ borderColor: 'var(--border)' }}>
          {atual.em_andamento && atual.status !== 'executando' && !atual.resultado
            ? <div className="text-sm opacity-70">Na fila — o servidor pega o pedido em até 1 minuto.</div>
            : <Resultado texto={atual.resultado} />}
        </div>
      )}
    </div>
  );
}

export default function TarefasSistema() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [aberto, setAberto] = useState(null);

  const carregar = useCallback(async () => {
    try {
      const { data } = await api.get('/tarefas-vps');
      setDados(data);
      setErro('');
    } catch (e) {
      setErro(e?.response?.data?.error || 'Não consegui ler as tarefas.');
    }
  }, []);

  const execucoes = dados?.execucoes || [];
  const algumaAndando = execucoes.some((e) => e.em_andamento);
  useEffect(() => { carregar(); }, [carregar]);
  useEffect(() => {
    const t = setInterval(carregar, algumaAndando ? 15000 : 60000);
    return () => clearInterval(t);
  }, [carregar, algumaAndando]);

  const rodar = async (job, empresas) => {
    try {
      await api.post(`/tarefas-vps/${job}`, empresas ? { empresas } : {});
      await carregar();
    } catch (e) {
      setErro(e?.response?.data?.error || 'Não consegui enviar o pedido.');
    }
  };

  return (
    <div className="w-full p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h1 className="text-xl font-semibold">Tarefas do sistema</h1>
          <div className="text-sm opacity-70">Roda no servidor (VPS) as rotinas de carga de faturas, sem esperar o agendamento automático. O andamento e o resultado aparecem aqui.</div>
        </div>
        <div className="ml-auto"><BaixarExtensao /></div>
        <button type="button" onClick={carregar} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border text-sm" style={{ borderColor: 'var(--border)' }}>
          <RefreshCw className="w-4 h-4" /> Atualizar
        </button>
      </div>
      {erro && <div className="rounded border px-3 py-2 text-sm" style={{ borderColor: '#dc2626', color: '#dc2626' }}>{erro}</div>}
      {!dados ? <div className="text-sm opacity-70">Carregando…</div> : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            {dados.tarefas.map((t) => (
              <CartaoTarefa key={t.job} t={t} atual={execucoes.find((e) => e.job === t.job)} onRodar={rodar} />
            ))}
            <CartaoClaro />
          </div>
          <div className="rounded-lg border" style={card}>
            <div className="px-4 py-2 font-semibold border-b" style={{ borderColor: 'var(--border)' }}>Execuções (pela tela e pelo chat)</div>
            {execucoes.length === 0 ? <div className="px-4 py-3 text-sm opacity-70">Nenhuma execução ainda.</div> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left opacity-70">
                    <th className="px-4 py-2">#</th><th className="px-2 py-2">Tarefa</th><th className="px-2 py-2">Empresas</th>
                    <th className="px-2 py-2">Quem pediu</th><th className="px-2 py-2">Pedido em</th><th className="px-2 py-2">Terminou em</th>
                    <th className="px-2 py-2 text-right">Faturas</th><th className="px-2 py-2 text-right">Apontamentos</th><th className="px-2 py-2">Situação</th>
                  </tr></thead>
                  <tbody>
                    {execucoes.map((e) => (
                      <React.Fragment key={e.id}>
                        <tr className="border-t cursor-pointer hover:bg-[var(--menu-hover)]" style={{ borderColor: 'var(--border)' }} onClick={() => setAberto(aberto === e.id ? null : e.id)}>
                          <td className="px-4 py-2">{aberto === e.id ? '▾' : '▸'} {e.id}</td>
                          <td className="px-2 py-2">{e.job || '—'}</td>
                          <td className="px-2 py-2">{e.empresas || 'todas'}</td>
                          <td className="px-2 py-2">{e.usuario || '—'}</td>
                          <td className="px-2 py-2">{fmt(e.criado_em)}</td>
                          <td className="px-2 py-2">{fmt(e.executado_em)}</td>
                          <td className="px-2 py-2 text-right tabular-nums">{n0(e.metricas?.faturas_novas)}</td>
                          <td className="px-2 py-2 text-right tabular-nums">{e.job === 'agua_sync' ? n0(e.metricas?.apontamentos_novos) : '—'}</td>
                          <td className="px-2 py-2"><Badge status={e.status} /></td>
                        </tr>
                        {aberto === e.id && <tr><td colSpan={9} className="px-4 pb-3"><Resultado texto={e.resultado} /></td></tr>}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
