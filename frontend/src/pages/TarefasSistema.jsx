// src/pages/TarefasSistema.jsx
// Tarefas do sistema (só admin): roda pela tela as tarefas que ficam na VPS — pdf_pipeline (extração das
// faturas de energia) e agua_sync (faturas de água + regras de água). O botão cria um pedido já aprovado
// (o mesmo caminho do chat) e o worker da VPS (worker/run_jobs.py, a cada minuto) executa e devolve o
// andamento e o resultado aqui. Backend: GET/POST /api/v1/tarefas-vps (handlers/tarefas_handler.go).
import React, { useCallback, useEffect, useState } from 'react';
import { Play, RefreshCw, Server } from 'lucide-react';
import api from '../services/apiClient.js';

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
          return <pre key={i} className="text-xs p-2 rounded overflow-x-auto max-h-72" style={{ background: 'var(--bg-subtle, rgba(127,127,127,.08))' }}>{p.replace(/^\n/, '')}</pre>;
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

function CartaoTarefa({ t, atual, onRodar }) {
  const [empresas, setEmpresas] = useState('');
  const [enviando, setEnviando] = useState(false);
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
        {atual && <span className="text-xs opacity-60">última: pedido #{atual.id} por {atual.usuario || '—'} em {fmt(atual.criado_em)}</span>}
      </div>
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
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold">Tarefas do sistema</h1>
          <div className="text-sm opacity-70">Roda no servidor (VPS) as rotinas de carga de faturas, sem esperar o agendamento automático. O andamento e o resultado aparecem aqui.</div>
        </div>
        <button type="button" onClick={carregar} className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded border text-sm" style={{ borderColor: 'var(--border)' }}>
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
          </div>
          <div className="rounded-lg border" style={card}>
            <div className="px-4 py-2 font-semibold border-b" style={{ borderColor: 'var(--border)' }}>Execuções (pela tela e pelo chat)</div>
            {execucoes.length === 0 ? <div className="px-4 py-3 text-sm opacity-70">Nenhuma execução ainda.</div> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left opacity-70">
                    <th className="px-4 py-2">#</th><th className="px-2 py-2">Tarefa</th><th className="px-2 py-2">Empresas</th>
                    <th className="px-2 py-2">Quem pediu</th><th className="px-2 py-2">Pedido em</th><th className="px-2 py-2">Terminou em</th><th className="px-2 py-2">Situação</th>
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
                          <td className="px-2 py-2"><Badge status={e.status} /></td>
                        </tr>
                        {aberto === e.id && <tr><td colSpan={7} className="px-4 pb-3"><Resultado texto={e.resultado} /></td></tr>}
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
