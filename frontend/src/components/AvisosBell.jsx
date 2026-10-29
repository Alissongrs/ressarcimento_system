import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import api from '../services/api';

// Sininho do topo. "Meus avisos" = avisos pessoais (ex.: movimentação no protocolo ANEEL que você cuida),
// com bolinha vermelha até a pessoa apertar "Ciente" em cada aviso; "Histórico" = todas as movimentações de protocolo, para a equipe toda.
// O sininho abre no Histórico. Lá, só quem recebeu a tarefa vê o botão "Ciente"; tarefa sem responsável tem "Assumir".
// Clicar num aviso abre o processo direto na aba Histórico, com o protocolo destacado no quadro "Protocolos ANEEL";
// sem processo, abre a página Protocolos ANEEL nesse protocolo. Clicar não dá ciente (isso é só no botão).
// Atualiza a cada minuto e na hora em que o App recebe um aviso pelo SSE (evento 'avisos:changed').

const STATUS = { aberta: 'Aberta', concluida: 'Concluída', em_andamento: 'Em andamento' };

// "0106671242658" ou "010.667.12426-58" → "010.667.12426-58"
function fmtProtocolo(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length === 13 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 11)}-${d.slice(11)}` : '';
}

// destino de um aviso pessoal: o texto traz "processo #N" e/ou o nº do protocolo
function destinoDoTexto(msg) {
  const proc = /processos?\s*#(\d+)/i.exec(msg || '');
  const prot = /0?10\.\d{3}\.\d{5}-\d{2}/.exec(msg || '');
  return { idProcesso: proc ? Number(proc[1]) : null, protocolo: prot ? prot[0] : '' };
}

function quando(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function AvisosBell() {
  const navigate = useNavigate();
  const [aberto, setAberto] = useState(false);
  const [aba, setAba] = useState('historico');
  const [dados, setDados] = useState({ meus: [], nao_lidos: 0, historico: [], eu: 0 });
  const caixa = useRef(null);
  const painel = useRef(null);
  const [pos, setPos] = useState({ top: 0, right: 16 });

  const carregar = useCallback(async () => {
    try {
      const { data } = await api.get('/avisos');
      setDados({ meus: data?.meus || [], nao_lidos: Number(data?.nao_lidos || 0), historico: data?.historico || [], eu: Number(data?.eu || 0) });
    } catch { /* sem sessão ou rede: mantém o que tinha */ }
  }, []);

  useEffect(() => {
    carregar();
    const id = setInterval(carregar, 60_000);
    window.addEventListener('avisos:changed', carregar);
    return () => { clearInterval(id); window.removeEventListener('avisos:changed', carregar); };
  }, [carregar]);

  useEffect(() => {
    if (!aberto) return undefined;
    const fora = (e) => {
      if (caixa.current?.contains(e.target) || painel.current?.contains(e.target)) return;
      setAberto(false);
    };
    const esc = (e) => { if (e.key === 'Escape') setAberto(false); };
    document.addEventListener('mousedown', fora);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', fora); document.removeEventListener('keydown', esc); };
  }, [aberto]);

  // o painel vai direto no <body> (portal) e fica fixo logo abaixo do sininho, por cima de tudo na tela
  useLayoutEffect(() => {
    if (!aberto) return undefined;
    const posicionar = () => {
      const r = caixa.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 8, right: Math.max(16, window.innerWidth - r.right) });
    };
    posicionar();
    window.addEventListener('resize', posicionar);
    window.addEventListener('scroll', posicionar, true);
    return () => { window.removeEventListener('resize', posicionar); window.removeEventListener('scroll', posicionar, true); };
  }, [aberto]);

  // o aviso só para de alertar quando a pessoa confirma que tomou ciência (um por vez, sem "marcar todos")
  const [enviando, setEnviando] = useState(null);
  const ciente = async (id) => {
    setEnviando(id);
    try {
      const { data } = await api.post(`/avisos/${id}/ciente`);
      setDados((d) => ({
        ...d,
        nao_lidos: Number(data?.nao_lidos ?? d.nao_lidos),
        meus: d.meus.map((a) => (a.id === id ? { ...a, lido: true, ciente_em: new Date().toISOString() } : a)),
      }));
    } catch { /* continua pendente; a pessoa pode apertar de novo */ }
    setEnviando(null);
  };

  // Histórico: "Ciente" (só quem recebeu a tarefa) e "Assumir" (tarefa sem responsável)
  const [erroTarefa, setErroTarefa] = useState(null);
  const acaoTarefa = async (id, acao) => {
    setEnviando(`t${id}`);
    setErroTarefa(null);
    try {
      await api.post(`/avisos/tarefas/${id}/${acao}`);
      await carregar();
    } catch (e) {
      setErroTarefa({ id, msg: e?.response?.data?.error || 'Não foi possível. Tente de novo.' });
      carregar();
    }
    setEnviando(null);
  };

  const abrir = ({ idProcesso, protocolo }) => {
    const prot = fmtProtocolo(protocolo);
    setAberto(false);
    if (idProcesso) navigate(`/processos/${idProcesso}?aba=historico${prot ? `&protocolo=${encodeURIComponent(prot)}` : ''}`);
    else navigate(prot ? `/protocolos-aneel?protocolo=${encodeURIComponent(prot)}` : '/protocolos-aneel');
  };

  const n = dados.nao_lidos;
  return (
    <div ref={caixa} className="relative">
      <button
        type="button"
        onClick={() => { setAberto((v) => !v); if (!aberto) carregar(); }}
        className="top-nav-link top-nav-alert relative"
        title={n > 0 ? `${n} aviso(s) não lido(s)` : 'Avisos'}
        aria-label={n > 0 ? `Avisos, ${n} não lido${n > 1 ? 's' : ''}` : 'Avisos'}
      >
        <Bell className="top-nav-icon" />
        {n > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full text-[11px] font-bold leading-[18px] text-center"
            style={{ background: 'var(--danger, #dc2626)', color: '#fff' }}
          >
            {n > 99 ? '99+' : n}
          </span>
        )}
      </button>

      {aberto && createPortal(
        <div
          ref={painel}
          className="rounded-xl overflow-hidden"
          style={{
            position: 'fixed', top: pos.top, right: pos.right, zIndex: 2147483000,
            width: 'min(440px, calc(100vw - 32px))', background: 'var(--card, #fff)', color: 'var(--fg)',
            border: '1px solid var(--border, #ddd)', boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
          }}
        >
          <div className="flex items-center gap-1 px-2 pt-2" style={{ borderBottom: '1px solid var(--border, #ddd)' }}>
            {[['meus', `Meus avisos${n > 0 ? ` (${n})` : ''}`], ['historico', 'Histórico de protocolos']].map(([k, rot]) => (
              <button
                key={k}
                type="button"
                onClick={() => setAba(k)}
                className="px-3 py-2 text-sm font-semibold"
                style={{ borderBottom: aba === k ? '2px solid var(--accent, #2563eb)' : '2px solid transparent', opacity: aba === k ? 1 : 0.65 }}
              >
                {rot}
              </button>
            ))}
          </div>

          <div className="overflow-y-auto" style={{ maxHeight: `min(60vh, calc(100vh - ${pos.top + 16}px))` }}>
            {aba === 'meus' && (dados.meus.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm opacity-60">Nenhum aviso para você.</div>
            ) : dados.meus.map((a) => (
              <div
                key={a.id}
                className="w-full px-4 py-3 flex gap-3 items-start"
                style={{
                  borderBottom: '1px solid var(--border, #eee)',
                  background: a.lido ? 'transparent' : 'color-mix(in srgb, var(--danger, #dc2626) 6%, transparent)',
                }}
              >
                <span
                  className="mt-1.5 shrink-0 w-2 h-2 rounded-full"
                  style={{ background: a.lido ? 'transparent' : 'var(--danger, #dc2626)' }}
                />
                {(() => {
                  const dest = destinoDoTexto(a.mensagem);
                  const temDestino = !!(dest.idProcesso || dest.protocolo);
                  const conteudo = (
                    <>
                      <span className={`block text-sm ${a.lido ? 'opacity-70' : 'font-semibold'}`}>{a.mensagem}</span>
                      <span className="block text-xs opacity-55 mt-0.5">
                        {quando(a.data_criacao)}
                        {a.lido && (a.ciente_em ? ` · Ciente em ${quando(a.ciente_em)}` : ' · Ciente')}
                      </span>
                      {temDestino && (
                        <span className="block text-xs font-semibold mt-1" style={{ color: 'var(--accent, #2563eb)' }}>
                          {dest.idProcesso ? `Abrir processo #${dest.idProcesso} →` : 'Abrir protocolo →'}
                        </span>
                      )}
                    </>
                  );
                  return temDestino ? (
                    <button type="button" onClick={() => abrir(dest)} className="min-w-0 flex-1 text-left" title="Abrir o processo, no histórico">
                      {conteudo}
                    </button>
                  ) : <span className="min-w-0 flex-1">{conteudo}</span>;
                })()}
                {!a.lido && (
                  <button
                    type="button"
                    onClick={() => ciente(a.id)}
                    disabled={enviando === a.id}
                    className="shrink-0 px-3 py-1 rounded-md text-xs font-semibold"
                    style={{ background: 'var(--accent, #2563eb)', color: '#fff', opacity: enviando === a.id ? 0.6 : 1 }}
                    title="Confirmo que fui notificado e tomei ciência desta informação"
                  >
                    Ciente
                  </button>
                )}
              </div>
            )))}

            {aba === 'historico' && (dados.historico.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm opacity-60">Nenhuma movimentação de protocolo ainda.</div>
            ) : dados.historico.map((h) => {
              const minha = h.id_responsavel && Number(h.id_responsavel) === dados.eu;
              const semDono = !h.id_responsavel;
              const pendente = h.status !== 'concluida';
              const ocupado = enviando === `t${h.id_tarefa}`;
              return (
                <div
                  key={h.id_tarefa}
                  className="w-full px-4 py-3 flex gap-3 items-start"
                  style={{
                    borderBottom: '1px solid var(--border, #eee)',
                    background: minha && !h.ciente_em && pendente ? 'color-mix(in srgb, var(--danger, #dc2626) 6%, transparent)' : 'transparent',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => abrir({ idProcesso: h.id_processo, protocolo: h.protocolo_num })}
                    className="min-w-0 flex-1 text-left"
                    title={h.id_processo ? 'Abrir o processo, no histórico' : 'Abrir o protocolo na página Protocolos ANEEL'}
                  >
                    <span className="block text-sm font-medium">{h.titulo}</span>
                    {/* quem recebeu a tarefa, em destaque */}
                    <span className="block text-sm font-bold mt-1" style={{ color: h.responsavel ? 'var(--accent, #2563eb)' : 'var(--danger, #dc2626)' }}>
                      {h.responsavel ? `Para ${minha ? `você (${h.responsavel})` : h.responsavel}` : 'Sem responsável'}
                    </span>
                    <span className="block text-xs opacity-65 mt-0.5">
                      {fmtProtocolo(h.protocolo_num) ? `Protocolo ${fmtProtocolo(h.protocolo_num)} · ` : ''}
                      {h.id_processo ? `Processo #${h.id_processo} · ` : ''}
                      {STATUS[h.status] || h.status}
                      {h.ciente_em ? ` · Ciente em ${quando(h.ciente_em)}` : ''}
                    </span>
                    <span className="block text-xs opacity-50 mt-0.5">{quando(h.criado_em)}</span>
                    <span className="block text-xs font-semibold mt-1" style={{ color: 'var(--accent, #2563eb)' }}>
                      {h.id_processo ? `Abrir processo #${h.id_processo} →` : 'Abrir protocolo →'}
                    </span>
                    {erroTarefa?.id === h.id_tarefa && (
                      <span className="block text-xs mt-1" style={{ color: 'var(--danger, #dc2626)' }}>{erroTarefa.msg}</span>
                    )}
                  </button>
                  {minha && pendente && !h.ciente_em && (
                    <button
                      type="button"
                      onClick={() => acaoTarefa(h.id_tarefa, 'ciente')}
                      disabled={ocupado}
                      className="shrink-0 px-3 py-1 rounded-md text-xs font-semibold"
                      style={{ background: 'var(--accent, #2563eb)', color: '#fff', opacity: ocupado ? 0.6 : 1 }}
                      title="Confirmo que recebi esta tarefa e tomei ciência"
                    >
                      Ciente
                    </button>
                  )}
                  {semDono && pendente && (
                    <button
                      type="button"
                      onClick={() => acaoTarefa(h.id_tarefa, 'assumir')}
                      disabled={ocupado}
                      className="shrink-0 px-3 py-1 rounded-md text-xs font-semibold"
                      style={{ background: 'var(--danger, #dc2626)', color: '#fff', opacity: ocupado ? 0.6 : 1 }}
                      title="Assumir esta tarefa: você passa a ser o responsável"
                    >
                      Assumir
                    </button>
                  )}
                </div>
              );
            }))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
