// InformativoModal — "janelinha" (~1/5 da tela) que explica como o sistema funciona
// (fluxo de aprovação + movimentação, com ilustrações) e divulga avisos editáveis.
//
// Comportamento pedido:
//  - checkbox "Não exibir mais essa mensagem" → não aparece mais (por versão do aviso).
//  - se NÃO marcado → reaparece nas horas redondas (11:00, 12:00, 13:00, …).
//  - admin pode editar o aviso ali mesmo (publica → versão sobe → reexibe a todos).
import React, { useCallback, useEffect, useState } from 'react';
import { X, Check, Megaphone, Pencil, ChevronRight } from 'lucide-react';
import { getInformativo, salvarInformativo } from '../services/informativoService.js';

const DISMISS_KEY = 'sure_info_dismiss_v'; // guarda a versão dispensada permanentemente
const HOUR_KEY = 'sure_info_hour';         // guarda "versao|AAAA-M-D-H" já exibido

function hourKey(versao) {
  const d = new Date();
  return `${versao}|${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
}
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

// ── Ilustração: fluxo de aprovação ──────────────────────────────────────────
function FluxoAprovacao() {
  const passos = [
    { t: 'Você pede', s: 'no chat' },
    { t: 'Prévia', s: 'a SURE mostra' },
    { t: 'Aprovação', s: 'o gestor OK', hi: true },
    { t: 'Executado', s: 'feito no banco' },
    { t: 'Histórico', s: 'aparece pra você' },
  ];
  return (
    <svg viewBox="0 0 640 96" width="100%" role="img" aria-label="Fluxo de aprovação" style={{ display: 'block' }}>
      {passos.map((p, i) => {
        const x = 8 + i * 128;
        const hi = p.hi;
        return (
          <g key={p.t}>
            <rect x={x} y={20} width={112} height={48} rx={10}
              fill={hi ? 'color-mix(in srgb, var(--accent, #5cc8ff) 22%, transparent)' : 'rgba(255,255,255,0.05)'}
              stroke={hi ? 'var(--accent, #5cc8ff)' : 'rgba(255,255,255,0.15)'} strokeWidth={hi ? 2 : 1} />
            <text x={x + 56} y={40} textAnchor="middle" fontSize="12.5" fontWeight="700" fill={hi ? 'var(--accent, #5cc8ff)' : '#e6edf3'}>{p.t}</text>
            <text x={x + 56} y={56} textAnchor="middle" fontSize="9.5" fill="rgba(230,237,243,0.6)">{p.s}</text>
            {i < passos.length - 1 && (
              <path d={`M ${x + 114} 44 L ${x + 126} 44`} stroke="var(--accent, #5cc8ff)" strokeWidth="2" markerEnd="url(#arrowhead)" />
            )}
          </g>
        );
      })}
      <defs>
        <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="var(--accent, #5cc8ff)" />
        </marker>
      </defs>
    </svg>
  );
}

// ── Ilustração: movimentação de etapa (Kanban) ──────────────────────────────
function Movimentacao() {
  const etapas = ['Reclamação', 'Contestação', 'Conciliação', 'Faturamento', 'Repasse', 'Encerramento'];
  return (
    <svg viewBox="0 0 640 70" width="100%" role="img" aria-label="Movimentação de etapas" style={{ display: 'block' }}>
      {etapas.map((e, i) => {
        const x = 6 + i * 106;
        const atual = i === 2; // "card" na Conciliação, prestes a avançar
        return (
          <g key={e}>
            <rect x={x} y={26} width={92} height={30} rx={8}
              fill={atual ? 'color-mix(in srgb, var(--accent, #5cc8ff) 20%, transparent)' : 'rgba(255,255,255,0.05)'}
              stroke={atual ? 'var(--accent, #5cc8ff)' : 'rgba(255,255,255,0.14)'} strokeWidth={atual ? 2 : 1} />
            <text x={x + 46} y={45} textAnchor="middle" fontSize="10.5" fontWeight={atual ? 700 : 600}
              fill={atual ? 'var(--accent, #5cc8ff)' : 'rgba(230,237,243,0.85)'}>{e}</text>
            {i < etapas.length - 1 && <path d={`M ${x + 94} 41 L ${x + 104} 41`} stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" />}
          </g>
        );
      })}
      <text x={320} y={14} textAnchor="middle" fontSize="10" fill="rgba(255,255,255,0.72)">cada mudança grava no histórico do processo</text>
    </svg>
  );
}

// ── Ilustração: botões de voz/áudio do chat ─────────────────────────────────
function BotoesVozAudio() {
  const AC = 'var(--accent, #5cc8ff)';
  return (
    <svg viewBox="0 0 600 104" width="100%" role="img" aria-label="Botões de voz e áudio do chat" style={{ display: 'block' }}>
      {/* Microfone (ditado) — C=130 */}
      <g>
        <rect x={108} y={18} width={44} height={44} rx={11} fill={AC} />
        <rect x={125} y={27} width={10} height={15} rx={5} fill="#fff" />
        <path d="M121 38 a9 9 0 0 0 18 0" stroke="#fff" strokeWidth="2" fill="none" />
        <path d="M130 47 L130 52 M124 52 L136 52" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        <text x={130} y={78} textAnchor="middle" fontSize="12" fontWeight="700" fill="#e6edf3">Microfone</text>
        <text x={130} y={93} textAnchor="middle" fontSize="10" fill="rgba(230,237,243,0.65)">fala → vira texto</text>
      </g>
      {/* Modo conversa — C=300 */}
      <g>
        <rect x={278} y={18} width={44} height={44} rx={11} fill={AC} />
        <path d="M290 36 L290 44 M295 32 L295 48 M300 28 L300 52 M305 33 L305 47 M310 35 L310 45"
          stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
        <text x={300} y={78} textAnchor="middle" fontSize="12" fontWeight="700" fill="#e6edf3">Conversa</text>
        <text x={300} y={93} textAnchor="middle" fontSize="10" fill="rgba(230,237,243,0.65)">“oi sure” / “tchau sure”</text>
      </g>
      {/* Voz da SURE (responde falando) — C=470 */}
      <g>
        <rect x={448} y={18} width={44} height={44} rx={11} fill={AC} />
        <path d="M459 36 H464 L469 31 V49 L464 44 H459 Z" fill="#fff" />
        <path d="M473 35 a6 6 0 0 1 0 10" stroke="#fff" strokeWidth="2" fill="none" />
        <path d="M477 32 a10 10 0 0 1 0 16" stroke="#fff" strokeWidth="2" fill="none" />
        <text x={470} y={78} textAnchor="middle" fontSize="12" fontWeight="700" fill="#e6edf3">Voz</text>
        <text x={470} y={93} textAnchor="middle" fontSize="10" fill="rgba(230,237,243,0.65)">a SURE responde falando</text>
      </g>
    </svg>
  );
}

export default function InformativoModal({ user }) {
  const isAdmin = String(user?.tipo_conta || '').trim().toLowerCase() === 'admin';
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [naoExibir, setNaoExibir] = useState(false);
  // edição (admin)
  const [editando, setEditando] = useState(false);
  const [fTitulo, setFTitulo] = useState('');
  const [fAviso, setFAviso] = useState('');
  const [fAtivo, setFAtivo] = useState(true);
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    try { const d = await getInformativo(); setData(d); } catch { /* silencioso */ }
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  // Lógica de exibição: por hora redonda, salvo dispensa permanente da versão atual.
  useEffect(() => {
    if (!data || data.ativo === false) return;
    const v = data.versao;
    const check = () => {
      if (String(lsGet(DISMISS_KEY)) === String(v)) return; // dispensado nesta versão
      const hk = hourKey(v);
      if (lsGet(HOUR_KEY) !== hk) setOpen(true);
    };
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, [data]);

  // Ao abrir, marca a hora atual p/ não reabrir dentro da mesma hora.
  useEffect(() => {
    if (open && data) lsSet(HOUR_KEY, hourKey(data.versao));
  }, [open, data]);

  const fechar = () => {
    if (naoExibir && data) lsSet(DISMISS_KEY, String(data.versao));
    setOpen(false);
  };

  const abrirEdicao = () => {
    setFTitulo(data?.titulo || ''); setFAviso(data?.aviso || ''); setFAtivo(data?.ativo !== false);
    setEditando(true);
  };
  const publicar = async () => {
    setSalvando(true);
    try {
      await salvarInformativo({ titulo: fTitulo, aviso: fAviso, ativo: fAtivo });
      setEditando(false);
      await carregar();
    } catch { /* ignore */ } finally { setSalvando(false); }
  };

  if (!open || !data) return null;

  const overlay = {
    position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(3,8,16,0.55)', padding: 16,
  };
  const card = {
    width: 'clamp(340px, 62vw, 760px)', maxHeight: '90vh', overflow: 'auto',
    background: '#0c1a28', color: '#f3f8fd',
    border: '1px solid color-mix(in srgb, var(--accent, #5cc8ff) 30%, transparent)', borderRadius: 14,
    boxShadow: '0 24px 70px rgba(0,0,0,0.6)',
  };
  const btn = (bg, fg, bd) => ({ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, padding: '7px 12px', borderRadius: 8, cursor: 'pointer', border: `1px solid ${bd || fg}`, background: bg, color: fg });
  const inp = { width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '7px 9px', fontSize: 12.5, color: '#e6edf3', outline: 'none' };

  return (
    <div style={overlay} onClick={(e) => { if (e.target === e.currentTarget) fechar(); }}>
    <div id="sureInfoCard" className="sure-info" style={card} role="dialog" aria-label="Informativo do sistema" onClick={(e) => e.stopPropagation()}>
      {/* Força fonte branca mesmo com o CSS global do app */}
      <style>{`#sureInfoCard p, #sureInfoCard b, #sureInfoCard strong, #sureInfoCard label, #sureInfoCard span { color:#ffffff !important; }`}</style>
      {/* Cabeçalho */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <Megaphone size={16} style={{ color: 'var(--accent, #5cc8ff)' }} />
        <b style={{ fontSize: 14, color: '#ffffff' }}>{data.titulo || 'Informativo'}</b>
        {isAdmin && !editando && (
          <button type="button" onClick={abrirEdicao} title="Editar aviso (admin)"
            style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', padding: 3 }}>
            <Pencil size={14} />
          </button>
        )}
        <button type="button" onClick={fechar} title="Fechar"
          style={{ marginLeft: isAdmin && !editando ? 4 : 'auto', background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', padding: 3 }}>
          <X size={16} />
        </button>
      </div>

      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Aviso editável (se houver) */}
        {editando ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: 10 }}>
            <input style={inp} value={fTitulo} onChange={(e) => setFTitulo(e.target.value)} placeholder="Título" />
            <textarea style={{ ...inp, minHeight: 64, resize: 'vertical' }} value={fAviso} onChange={(e) => setFAviso(e.target.value)} placeholder="Escreva o aviso a divulgar…" />
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={fAtivo} onChange={(e) => setFAtivo(e.target.checked)} /> Informativo ativo
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={publicar} disabled={salvando} style={btn('var(--gradient-primary, #2563eb)', '#fff', 'transparent')}>
                <Check size={14} /> {salvando ? 'Publicando…' : 'Publicar'}
              </button>
              <button type="button" onClick={() => setEditando(false)} style={btn('transparent', 'rgba(255,255,255,0.7)', 'rgba(255,255,255,0.2)')}>Cancelar</button>
            </div>
          </div>
        ) : data.aviso ? (
          <div style={{ fontSize: 13, lineHeight: 1.55, color: '#ffffff', background: 'color-mix(in srgb, var(--accent, #5cc8ff) 14%, transparent)', border: '1px solid color-mix(in srgb, var(--accent, #5cc8ff) 30%, transparent)', borderRadius: 10, padding: '10px 12px', whiteSpace: 'pre-wrap' }}>
            {data.aviso}
          </div>
        ) : null}

        {/* Como funciona a aprovação */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#ffffff', marginBottom: 6 }}>Como funciona a aprovação</div>
          <p style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 8px', color: '#ffffff' }}>
            Você faz um pedido no chat; a SURE mostra uma <b>prévia</b>. Depois que o <b>gestor aprova</b>, a ação é executada e aparece no seu <b>Histórico</b>.
          </p>
          <FluxoAprovacao />
        </div>

        {/* Movimentação */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#ffffff', marginBottom: 6 }}>Exemplo de movimentação</div>
          <p style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 8px', color: '#ffffff' }}>
            A etapa do processo avança pelo <b>Kanban</b> — uma por vez. Cada passo é registrado no histórico.
          </p>
          <Movimentacao />
        </div>

        {/* Falar e ouvir no chat */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#ffffff', marginBottom: 6 }}>Falar e ouvir no chat</div>
          <p style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 8px', color: '#ffffff' }}>
            No chat da SURE você pode <b>falar</b> em vez de digitar e <b>ouvir</b> as respostas:
          </p>
          <BotoesVozAudio />
          <p style={{ fontSize: 11.5, lineHeight: 1.45, margin: '6px 0 0', color: '#ffffff' }}>
            <b>Microfone</b>: dita e vira texto. <b>Conversa</b>: diga “oi sure” para pedir e “tchau sure” para confirmar. <b>Voz</b>: a SURE responde em áudio. (Chrome ou Edge, com microfone permitido.)
          </p>
        </div>
      </div>

      {/* Rodapé: checkbox + fechar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: '1px solid rgba(255,255,255,0.08)', flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, cursor: 'pointer', color: '#ffffff' }}>
          <input type="checkbox" checked={naoExibir} onChange={(e) => setNaoExibir(e.target.checked)} />
          Não exibir mais essa mensagem
        </label>
        <button type="button" onClick={fechar} style={{ ...btn('var(--gradient-primary, #2563eb)', '#fff', 'transparent'), marginLeft: 'auto' }}>
          Entendi <ChevronRight size={14} />
        </button>
      </div>
    </div>
    </div>
  );
}
