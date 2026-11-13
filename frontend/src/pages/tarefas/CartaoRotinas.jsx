// src/pages/tarefas/CartaoRotinas.jsx
// Cartão "Rotinas" da tela Tarefas do sistema (só admin): cada rotina do cron da VPS e do agendador
// do backend com o estado calculado pelo servidor (ok, atrasada, erro, travada, rodando, nunca),
// o histórico das execuções e quem recebe os avisos (alerta na tela + WhatsApp, se conectado).
// O backend confere a cada 15 min; aqui a lista se atualiza sozinha a cada minuto.
import React, { useCallback, useEffect, useState } from 'react';
import { Activity, ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import { obterSaude, listarExecucoes, definirAviso, testarAviso } from '../../services/rotinasSaudeService.js';

const card = { borderColor: 'var(--border)', background: 'var(--card)' };
const fmt = (d) => (d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

const ESTADOS = {
  ok: { rotulo: 'OK', cor: '#059669' },
  rodando: { rotulo: 'Rodando', cor: '#2563eb' },
  atrasada: { rotulo: 'Atrasada', cor: '#b45309' },
  erro: { rotulo: 'Erro', cor: '#dc2626' },
  travada: { rotulo: 'Travada', cor: '#dc2626' },
  nunca: { rotulo: 'Sem sinal', cor: '#6b7280' },
  desligada: { rotulo: 'Desligada', cor: '#9ca3af' },
};
const PROBLEMA = new Set(['atrasada', 'erro', 'travada']);

function Estado({ estado }) {
  const e = ESTADOS[estado] || ESTADOS.nunca;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap" style={{ color: e.cor }}>
      <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: e.cor }} />
      {e.rotulo}
    </span>
  );
}

function Execucoes({ rotina }) {
  const [itens, setItens] = useState(null);
  useEffect(() => {
    let vivo = true;
    listarExecucoes(rotina, 15).then((l) => { if (vivo) setItens(l); }).catch(() => { if (vivo) setItens([]); });
    return () => { vivo = false; };
  }, [rotina]);
  if (itens === null) return <div className="text-xs opacity-60 px-2 py-1">Carregando…</div>;
  if (!itens.length) return <div className="text-xs opacity-60 px-2 py-1">Nenhuma execução registrada ainda.</div>;
  return (
    <table className="text-xs w-full">
      <tbody>
        {itens.map((e) => (
          <tr key={e.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
            <td className="px-2 py-1 whitespace-nowrap">{fmt(e.inicio)}{e.fim ? ` → ${fmt(e.fim)}` : ''}</td>
            <td className="px-2 py-1"><Estado estado={e.status} /></td>
            <td className="px-2 py-1 opacity-80">{e.resumo || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Avisos({ aviso, usuarios, whatsappConectado, onSalvo, onErro }) {
  const [idUsuario, setIdUsuario] = useState(String(aviso?.id_usuario || ''));
  const [celular, setCelular] = useState(aviso?.celular || '');
  const [ocupado, setOcupado] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { setIdUsuario(String(aviso?.id_usuario || '')); setCelular(aviso?.celular || ''); }, [aviso?.id_usuario, aviso?.celular]);

  const salvar = async () => {
    setOcupado('salvar'); setMsg('');
    try { const r = await definirAviso(idUsuario, celular); setMsg('salvo'); onSalvo(r?.aviso); }
    catch (e) { onErro(e?.response?.data?.error?.message || 'Não foi possível salvar.'); }
    finally { setOcupado(''); setTimeout(() => setMsg(''), 3000); }
  };
  const testar = async () => {
    setOcupado('testar'); setMsg('');
    try { const r = await testarAviso(); setMsg(`teste enviado: ${(r?.canais || []).join(' + ')}`); }
    catch (e) { onErro(e?.response?.data?.error?.message || 'Não foi possível enviar o teste.'); }
    finally { setOcupado(''); setTimeout(() => setMsg(''), 5000); }
  };

  return (
    <div className="rounded border px-3 py-2 flex flex-wrap items-center gap-2 text-sm" style={{ borderColor: 'var(--border)' }}>
      <span className="opacity-70">Quem recebe os avisos:</span>
      <select value={idUsuario} onChange={(e) => setIdUsuario(e.target.value)} className="rounded border px-2 py-1 text-sm" style={card}>
        <option value="">— ninguém (só o painel) —</option>
        {(usuarios || []).map((u) => <option key={u.id_usuario} value={u.id_usuario}>{u.nome}</option>)}
      </select>
      <input value={celular} onChange={(e) => setCelular(e.target.value)} placeholder="celular com DDD (WhatsApp)" className="rounded border px-2 py-1 text-sm w-[200px]" style={card} />
      <button type="button" onClick={salvar} disabled={!!ocupado} className="px-3 py-1 rounded text-sm text-white" style={{ background: '#0c6f7a' }}>
        {ocupado === 'salvar' ? '…' : 'Salvar'}
      </button>
      <button type="button" onClick={testar} disabled={!!ocupado || !aviso?.id_usuario} className="px-3 py-1 rounded border text-sm" style={{ borderColor: 'var(--border)' }}
        title="Manda um aviso de teste para a pessoa configurada (salve antes)">
        {ocupado === 'testar' ? '…' : 'Mandar teste'}
      </button>
      <span className="text-xs opacity-60">
        WhatsApp do departamento: {whatsappConectado ? 'conectado' : 'desconectado (só o alerta na tela)'}
      </span>
      {msg && <span className="text-xs" style={{ color: '#059669' }}>{msg}</span>}
    </div>
  );
}

export default function CartaoRotinas() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [aberta, setAberta] = useState(''); // rotina com o histórico aberto

  const carregar = useCallback(async () => {
    setCarregando(true); setErro('');
    try { setDados(await obterSaude()); } catch (e) {
      setErro(e?.response?.data?.error?.message || 'Não foi possível ler a saúde das rotinas.');
    } finally { setCarregando(false); }
  }, []);
  useEffect(() => { carregar(); const t = setInterval(carregar, 60000); return () => clearInterval(t); }, [carregar]);

  const itens = dados?.itens || [];
  const nProb = itens.filter((i) => PROBLEMA.has(i.estado)).length;
  const nOk = itens.filter((i) => i.estado === 'ok' || i.estado === 'rodando').length;
  const nSem = itens.length - nProb - nOk;

  return (
    <div className="rounded-lg border p-4 flex flex-col gap-3 lg:col-span-2" style={card}>
      <div className="flex items-start gap-3">
        <Activity className="w-5 h-5 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">Rotinas</div>
          <div className="text-sm opacity-70">
            Cada rotina do cron da VPS e do agendador do backend, com o último sinal de vida e a última execução. O servidor confere a cada
            15 minutos e avisa a pessoa configurada quando algo atrasa, falha ou trava (de novo só depois de 24 h, e quando volta ao normal).
          </div>
        </div>
        <button type="button" onClick={carregar} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-sm" style={{ borderColor: 'var(--border)' }} disabled={carregando}>
          {carregando ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        </button>
      </div>

      {erro && <div className="rounded border px-3 py-2 text-sm" style={{ borderColor: '#dc2626', color: '#dc2626' }}>{erro}</div>}

      {dados && (
        <div className="flex items-center gap-4 flex-wrap text-sm">
          <span><b className="text-2xl font-semibold" style={{ color: nProb ? '#dc2626' : '#059669', fontVariantNumeric: 'tabular-nums' }}>{nProb}</b> <span className="opacity-70">com problema</span></span>
          <span><b style={{ color: '#059669' }}>{nOk}</b> <span className="opacity-70">em dia</span></span>
          <span><b className="opacity-70">{nSem}</b> <span className="opacity-70">sem sinal ainda</span></span>
          <span className="opacity-50 text-xs ml-auto">conferido {fmt(dados.agora)}</span>
        </div>
      )}

      {dados && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left opacity-70">
              <th className="px-2 py-1">Estado</th><th className="px-2 py-1">Rotina</th><th className="px-2 py-1">Quando roda</th>
              <th className="px-2 py-1">Último sinal</th><th className="px-2 py-1">Última execução</th><th className="px-2 py-1"></th>
            </tr></thead>
            <tbody>
              {itens.map((it) => {
                const ul = it.ultima_execucao;
                const abertaAqui = aberta === it.rotina;
                return (
                  <React.Fragment key={it.rotina}>
                    <tr className="border-t align-top" style={{ borderColor: 'var(--border)', background: PROBLEMA.has(it.estado) ? 'rgba(220,38,38,0.05)' : undefined }}>
                      <td className="px-2 py-1.5"><Estado estado={it.estado} /></td>
                      <td className="px-2 py-1.5"><div>{it.titulo}</div><div className="text-xs opacity-60">{it.onde} · {it.rotina}</div></td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{it.cadencia}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{fmt(it.ultimo_ping)}</td>
                      <td className="px-2 py-1.5">
                        {ul ? (
                          <>
                            <span className="whitespace-nowrap">{fmt(ul.inicio)}</span> · <Estado estado={ul.status} />
                            {ul.resumo && <div className="text-xs opacity-70 max-w-[420px] truncate" title={ul.resumo}>{ul.resumo}</div>}
                          </>
                        ) : <span className="opacity-50">—</span>}
                        <div className="text-xs opacity-60">{it.motivo}</div>
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <button type="button" onClick={() => setAberta(abertaAqui ? '' : it.rotina)} className="inline-flex items-center gap-1 px-2 py-1 rounded border text-xs" style={{ borderColor: 'var(--border)' }}>
                          {abertaAqui ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} histórico
                        </button>
                      </td>
                    </tr>
                    {abertaAqui && (
                      <tr><td colSpan={6} className="px-4 pb-2"><Execucoes rotina={it.rotina} /></td></tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {dados && (
        <Avisos aviso={dados.aviso} usuarios={dados.usuarios} whatsappConectado={dados.whatsapp_conectado}
          onSalvo={(a) => setDados((d) => (d ? { ...d, aviso: a || d.aviso } : d))} onErro={setErro} />
      )}
    </div>
  );
}
