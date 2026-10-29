// src/pages/AdminRotinas.jsx
// Rotinas criadas no chat (#rotina). O administrador vê TODAS, aprova/rejeita, pausa,
// reativa e desativa; na aba "Por usuário" fica o histórico de cada pessoa e o botão para
// desativar tudo de quem saiu da empresa (nada é apagado).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Repeat, RefreshCw, Check, X, Pause, Play, Ban, History, Undo2, Users, Lock } from 'lucide-react';
import api from '../services/apiClient.js';
import { useAuth } from '../context/AuthContext.jsx';

const STATUS = {
  aguardando_aprovacao: { label: 'Aguardando aprovação', cor: 'var(--warning)' },
  ativa: { label: 'Ativa', cor: 'var(--success)' },
  pausada: { label: 'Pausada', cor: 'var(--accent-2)' },
  concluida: { label: 'Concluída', cor: 'var(--accent)' },
  rejeitada: { label: 'Rejeitada', cor: 'var(--danger)' },
  desativada: { label: 'Desativada', cor: 'var(--fg)' },
};
const EVENTO = {
  criada: 'criou a rotina', aprovada: 'aprovou', rejeitada: 'rejeitou', pausada: 'pausou', reativada: 'reativou',
  desativada: 'desativou', executada: 'execução', execucao_desfeita: 'desfez uma execução', lembrete_criado: 'criou lembrete',
};

function fmt(d) {
  if (!d) return '—';
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? '—' : t.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function Badge({ status }) {
  const s = STATUS[status] || { label: status, cor: 'var(--fg)' };
  return (
    <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: `color-mix(in srgb, ${s.cor} 16%, transparent)`, color: s.cor }}>
      {s.label}
    </span>
  );
}

function quando(r) {
  if (r.tipo === 'unica') return 'Uma vez';
  const dias = !r.dias || r.dias === '*' ? 'Todo dia' : r.dias === '1,2,3,4,5' ? 'Seg a sex'
    : r.dias.split(',').map((d) => ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'][+d]).join(', ');
  return `${dias} · ${String(r.horarios || '').split(',').join(', ')}`;
}

export default function AdminRotinas() {
  const { user } = useAuth();
  const role = String(user?.tipo_conta || user?.role || user?.perfil || '').trim().toLowerCase();
  const isAdmin = role === 'admin';
  const [aba, setAba] = useState('rotinas');
  const [rotinas, setRotinas] = useState([]);
  const [filtro, setFiltro] = useState('');
  const [usuarios, setUsuarios] = useState([]);
  const [sel, setSel] = useState(null); // rotina com execuções abertas
  const [execs, setExecs] = useState([]);
  const [userSel, setUserSel] = useState(null);
  const [hist, setHist] = useState(null);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState('');

  const carregar = useCallback(async () => {
    setErro('');
    try {
      const { data } = await api.get('/rotinas', { params: filtro ? { status: filtro } : {} });
      setRotinas(Array.isArray(data) ? data : []);
      if (isAdmin) {
        const u = await api.get('/rotinas/usuarios');
        setUsuarios(Array.isArray(u.data) ? u.data : []);
      }
    } catch (e) {
      setErro(e?.response?.data?.error || 'Falha ao carregar rotinas.');
    }
  }, [filtro, isAdmin]);

  useEffect(() => { carregar(); const t = setInterval(carregar, 30000); return () => clearInterval(t); }, [carregar]);

  const acao = async (r, a) => {
    let motivo = '';
    if (a === 'rejeitar' || a === 'desativar') {
      motivo = window.prompt(`Motivo para ${a} a rotina #${r.id_rotina} (opcional):`, '') ?? null;
      if (motivo === null) return;
    }
    setBusy(true);
    try { await api.post(`/rotinas/${r.id_rotina}/acao`, { acao: a, motivo }); await carregar(); }
    catch (e) { setErro(e?.response?.data?.error || `Falha ao ${a}.`); }
    finally { setBusy(false); }
  };

  const abrirExecs = async (r) => {
    if (sel?.id_rotina === r.id_rotina) { setSel(null); return; }
    setSel(r); setExecs([]);
    try { const { data } = await api.get(`/rotinas/${r.id_rotina}/execucoes`); setExecs(Array.isArray(data) ? data : []); }
    catch (e) { setErro(e?.response?.data?.error || 'Falha ao carregar execuções.'); }
  };

  const desfazer = async (ex) => {
    const n = ex?.detalhe?.vinculados?.length || 0;
    if (!window.confirm(`Desfazer a execução #${ex.id_execucao}? ${n} e-mail(s) voltam a ficar sem vínculo (só os que continuam no processo que a rotina pôs).`)) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/rotinas/execucoes/${ex.id_execucao}/desfazer`);
      window.alert(`${data?.desfeitos ?? 0} vínculo(s) desfeito(s).`);
      if (sel) {
        const r = await api.get(`/rotinas/${sel.id_rotina}/execucoes`);
        setExecs(Array.isArray(r.data) ? r.data : []);
      }
    } catch (e) { setErro(e?.response?.data?.error || 'Falha ao desfazer.'); }
    finally { setBusy(false); }
  };

  const abrirUsuario = async (u) => {
    setUserSel(u); setHist(null);
    try { const { data } = await api.get(`/rotinas/historico/${u.id_usuario}`); setHist(data); }
    catch (e) { setErro(e?.response?.data?.error || 'Falha ao carregar histórico.'); }
  };

  const desativarTodas = async (u) => {
    const motivo = window.prompt(`Desativar TODAS as rotinas de ${u.nome}? (nada é apagado — o histórico fica)\nMotivo:`, 'usuário desligado da empresa');
    if (motivo === null) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/rotinas/usuario/${u.id_usuario}/desativar-todas`, { motivo });
      window.alert(`${data?.desativadas ?? 0} rotina(s) desativada(s).`);
      await carregar(); await abrirUsuario(u);
    } catch (e) { setErro(e?.response?.data?.error || 'Falha ao desativar.'); }
    finally { setBusy(false); }
  };

  const pendentes = useMemo(() => rotinas.filter((r) => r.status === 'aguardando_aprovacao').length, [rotinas]);

  if (!role || role === 'solicitante') {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <Lock size={28} style={{ color: 'var(--warning)', margin: '0 auto 12px' }} />
        <h1 className="text-lg font-bold mb-2">Acesso restrito</h1>
      </div>
    );
  }

  const linhaRotina = (r) => (
    <React.Fragment key={r.id_rotina}>
      <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
        <td className="px-3 py-2 align-top font-mono text-xs">#{r.id_rotina}</td>
        <td className="px-3 py-2 align-top">
          <div className="text-sm">{r.resumo}</div>
          <div className="text-[11px] opacity-60 mt-1">“{r.texto_original}”</div>
          {r.motivo_status ? <div className="text-[11px] opacity-70 mt-1">Motivo: {r.motivo_status}</div> : null}
        </td>
        <td className="px-3 py-2 align-top text-xs whitespace-nowrap">
          {r.nome_usuario}{!r.usuario_ativo && <span className="ml-1 opacity-60">(inativo)</span>}
        </td>
        <td className="px-3 py-2 align-top text-xs whitespace-nowrap">{quando(r)}</td>
        <td className="px-3 py-2 align-top"><Badge status={r.status} /></td>
        <td className="px-3 py-2 align-top text-xs whitespace-nowrap">{fmt(r.ultima_execucao)}</td>
        <td className="px-3 py-2 align-top">
          <div className="flex flex-wrap gap-1 justify-end">
            {isAdmin && r.status === 'aguardando_aprovacao' && (<>
              <button disabled={busy} onClick={() => acao(r, 'aprovar')} className="btn-xs" title="Aprovar"><Check size={14} /> Aprovar</button>
              <button disabled={busy} onClick={() => acao(r, 'rejeitar')} className="btn-xs" title="Rejeitar"><X size={14} /> Rejeitar</button>
            </>)}
            {r.status === 'ativa' && <button disabled={busy} onClick={() => acao(r, 'pausar')} className="btn-xs" title="Pausar"><Pause size={14} /></button>}
            {isAdmin && (r.status === 'pausada' || r.status === 'desativada') && r.usuario_ativo &&
              <button disabled={busy} onClick={() => acao(r, 'reativar')} className="btn-xs" title="Reativar"><Play size={14} /></button>}
            {!['desativada', 'rejeitada', 'concluida'].includes(r.status) &&
              <button disabled={busy} onClick={() => acao(r, 'desativar')} className="btn-xs" title="Excluir rotina (o histórico fica guardado)"><Ban size={14} /></button>}
            <button onClick={() => abrirExecs(r)} className="btn-xs" title="Execuções"><History size={14} /></button>
          </div>
        </td>
      </tr>
      {sel?.id_rotina === r.id_rotina && (
        <tr><td colSpan={7} className="px-3 pb-3">
          <div className="rounded-lg border p-3 text-xs" style={{ borderColor: 'var(--border)', background: 'var(--card)' }}>
            <div className="font-semibold mb-2">Execuções da rotina #{r.id_rotina}</div>
            {!execs.length ? <div className="opacity-60">Ainda não rodou.</div> : execs.map((ex) => (
              <div key={ex.id_execucao} className="py-2 border-t first:border-t-0" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-center justify-between gap-2">
                  <div><b>{fmt(ex.slot)}</b> · {ex.status} — {ex.resumo}</div>
                  {isAdmin && ex.status === 'ok' && ex?.detalhe?.vinculados?.length > 0 &&
                    <button disabled={busy} onClick={() => desfazer(ex)} className="btn-xs"><Undo2 size={13} /> Desfazer</button>}
                </div>
                {ex?.detalhe?.vinculados?.length > 0 && (
                  <details className="mt-1"><summary className="cursor-pointer opacity-70">{ex.detalhe.vinculados.length} vinculado(s)</summary>
                    {ex.detalhe.vinculados.map((v) => <div key={v.id_email} className="opacity-80">e{v.id_email} → processo {v.id_processo} ({v.motivo}) · {v.assunto}</div>)}
                  </details>)}
                {ex?.detalhe?.para_revisar?.length > 0 && (
                  <details className="mt-1"><summary className="cursor-pointer opacity-70">{ex.detalhe.para_revisar_total} para revisão (sem prova única)</summary>
                    {ex.detalhe.para_revisar.map((v) => <div key={v.id_email} className="opacity-80">e{v.id_email} · {v.de} · {v.assunto}</div>)}
                  </details>)}
              </div>
            ))}
          </div>
        </td></tr>
      )}
    </React.Fragment>
  );

  return (
    <div className="w-full px-4 md:px-6 py-6">
      <style>{`.btn-xs{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 8px;border-radius:8px;border:1px solid var(--border)}.btn-xs:hover{background:var(--menu-hover)}.btn-xs:disabled{opacity:.5}`}</style>
      <div className="flex items-center gap-2 mb-1">
        <Repeat size={20} style={{ color: 'var(--accent)' }} />
        <h1 className="text-xl font-extrabold tracking-tight">Rotinas</h1>
        <button onClick={carregar} className="btn-xs ml-auto"><RefreshCw size={13} /> Atualizar</button>
      </div>
      <p className="text-sm opacity-70 mb-4">
        Criadas no chat com <b>#rotina</b>. {isAdmin ? <>Só rodam depois da <b>sua aprovação</b>. Desativar não apaga — o histórico fica guardado.</> : 'Rodam depois da aprovação do administrador.'}
        {pendentes > 0 && <b style={{ color: 'var(--warning)' }}> {pendentes} aguardando aprovação.</b>}
      </p>
      <div className="mb-4 rounded-xl border p-3 text-sm" style={{ borderColor: 'color-mix(in srgb, var(--accent) 35%, transparent)', background: 'color-mix(in srgb, var(--accent) 7%, transparent)' }}>
        <div className="font-semibold mb-1" style={{ color: 'var(--accent)' }}>💡 Como criar e excluir rotinas</div>
        <ul className="list-disc pl-5 space-y-0.5 opacity-85">
          <li><b>Criar:</b> no chat da SURE, digite <code>#rotina</code> e descreva a tarefa e o horário — ex.: <i>“vincular os e-mails do dia anterior aos processos às 14h e às 18h”</i> ou <i>“lembrete para a Luana toda segunda às 9h sobre os prazos”</i>. Confirme com <b>sim</b>.</li>
          <li><b>Aprovação:</b> a rotina fica <i>aguardando aprovação</i> até o administrador aprovar; depois roda sozinha nos horários.</li>
          <li><b>Pausar ou excluir:</b> aqui na lista, use <Pause size={12} className="inline" /> para pausar ou <Ban size={12} className="inline" /> para excluir a sua rotina. O histórico do que ela já fez continua guardado.</li>
          <li><b>Ver as suas pelo chat:</b> digite <code>#rotinas</code>.</li>
        </ul>
      </div>
      {erro && <div className="mb-3 text-sm" style={{ color: 'var(--danger)' }}>{erro}</div>}

      {isAdmin && (
        <div className="flex gap-2 mb-4">
          <button onClick={() => setAba('rotinas')} className={`btn-xs ${aba === 'rotinas' ? 'font-bold' : ''}`}><Repeat size={13} /> Todas as rotinas</button>
          <button onClick={() => setAba('usuarios')} className={`btn-xs ${aba === 'usuarios' ? 'font-bold' : ''}`}><Users size={13} /> Por usuário</button>
        </div>
      )}

      {aba === 'rotinas' && (<>
        <div className="flex gap-2 mb-2 text-xs items-center">
          Status:
          <select value={filtro} onChange={(e) => setFiltro(e.target.value)} className="rounded border px-2 py-1 bg-transparent" style={{ borderColor: 'var(--border)' }}>
            <option value="">todos</option>
            {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
        <div className="overflow-x-auto rounded-xl border" style={{ borderColor: 'var(--border)' }}>
          <table className="w-full text-left">
            <thead className="text-[11px] uppercase opacity-60">
              <tr><th className="px-3 py-2">#</th><th className="px-3 py-2">O que faz</th><th className="px-3 py-2">Criada por</th>
                <th className="px-3 py-2">Quando</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Última execução</th><th /></tr>
            </thead>
            <tbody>
              {rotinas.length ? rotinas.map(linhaRotina)
                : <tr><td colSpan={7} className="px-3 py-6 text-center text-sm opacity-60">Nenhuma rotina. Crie pelo chat com #rotina.</td></tr>}
            </tbody>
          </table>
        </div>
      </>)}

      {aba === 'usuarios' && isAdmin && (
        <div className="grid md:grid-cols-[280px_1fr] gap-4">
          <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
            {usuarios.map((u) => (
              <button key={u.id_usuario} onClick={() => abrirUsuario(u)}
                className={`w-full text-left px-3 py-2 border-b text-sm hover:bg-[var(--menu-hover)] ${userSel?.id_usuario === u.id_usuario ? 'bg-[var(--menu-hover)]' : ''}`}
                style={{ borderColor: 'var(--border)' }}>
                <div className="font-medium">{u.nome} {!u.ativo && <span className="text-[10px] opacity-60">(inativo)</span>}</div>
                <div className="text-[11px] opacity-60">{u.rotinas} rotina(s) · {u.ativas} ativa(s){u.aguardando ? ` · ${u.aguardando} aguardando` : ''} · {u.eventos} registro(s)</div>
              </button>
            ))}
          </div>
          <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
            {!userSel ? <div className="text-sm opacity-60">Escolha um usuário para ver o histórico.</div> : (<>
              <div className="flex items-center gap-2 mb-3">
                <div>
                  <div className="font-bold">{userSel.nome}</div>
                  <div className="text-xs opacity-60">{userSel.email} · {userSel.perfil} · {userSel.ativo ? 'ativo' : 'inativo'}</div>
                </div>
                <button disabled={busy} onClick={() => desativarTodas(userSel)} className="btn-xs ml-auto" style={{ color: 'var(--danger)' }}>
                  <Ban size={13} /> Desativar todas as rotinas
                </button>
              </div>
              {!hist ? <div className="text-sm opacity-60">Carregando…</div> : (<>
                <div className="text-xs font-semibold uppercase opacity-60 mb-1">Rotinas</div>
                {!hist.rotinas?.length ? <div className="text-sm opacity-60 mb-3">Nenhuma.</div> : (
                  <ul className="mb-4 text-sm space-y-1">
                    {hist.rotinas.map((r) => <li key={r.id_rotina}><span className="font-mono text-xs">#{r.id_rotina}</span> <Badge status={r.status} /> {r.resumo}</li>)}
                  </ul>)}
                <div className="text-xs font-semibold uppercase opacity-60 mb-1">Histórico</div>
                {!hist.eventos?.length ? <div className="text-sm opacity-60">Sem registros.</div> : (
                  <ul className="text-xs space-y-1 max-h-[480px] overflow-auto">
                    {hist.eventos.map((e) => (
                      <li key={e.id}><span className="opacity-60">{fmt(e.criado_em)}</span> · <b>{e.nome_ator || 'sistema'}</b> {EVENTO[e.evento] || e.evento}
                        {e.id_rotina ? ` #${e.id_rotina}` : ''}{e.detalhe ? ` — ${e.detalhe}` : ''}</li>))}
                  </ul>)}
              </>)}
            </>)}
          </div>
        </div>
      )}
    </div>
  );
}
