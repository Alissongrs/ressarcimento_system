// Página de Regras — Catálogo de Erros de Faturamento (fichas F01–F61).
// Cada regra traz: INTERPRETAÇÃO (o que ela trata), FATURAS necessárias da unidade,
// CRITÉRIOS (ERRO/ALERTA/OK…) e APLICAÇÃO passo a passo. "Alterar" libera o texto (com
// backup no servidor) e oferece "Melhorar com IA" (a IA interpreta o que foi escrito e
// devolve uma versão revisada p/ conferir antes de salvar). "Testar" abre o modal:
// anexa 1–13 faturas PDF da mesma unidade → Iniciar → fila → agente Claude da VPS → laudo.
// Cabeçalho fixo: busca, seleção de regras (Todas ou algumas) e "Testar fatura" em lote.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pencil, FlaskConical, Check, X, ChevronDown, Search, Paperclip, Play, Save, Loader2, Cpu,
  FileText, Trash2, Sparkles, Undo2, ListChecks, Files, Scale, BookOpen, ChevronsDownUp, ChevronsUpDown, Plus,
} from 'lucide-react';
import {
  listarFichasRegras, criarFichaRegra, atualizarFichaRegra, melhorarFichaRegra, criarTesteRegra,
  statusTesteRegra, cancelarTesteRegra, salvarTesteRegra,
} from '../services/fichasRegrasService.js';

const POLL_MS = 5000;
const CACHE_KEY = 'sure_regras_catalogo_v1';
const MAX_FATURAS = 13;
const NAV_H = 64; // altura do menu fixo do topo (theme.css .top-nav)
const num = (codigo) => String(codigo || '').replace(/^F/i, '');
const errMsg = (e) => e?.response?.data?.error || e?.message || 'erro';

// cor por grupo (estável): paleta que funciona no tema claro e no escuro
const PALETA = ['#2563eb', '#0d9488', '#d97706', '#7c3aed', '#db2777', '#059669', '#ea580c', '#0891b2', '#4f46e5', '#b45309'];
const corDoGrupo = (() => {
  const cache = {};
  let i = 0;
  return (g) => (cache[g] ??= PALETA[i++ % PALETA.length]);
})();

// ---------------------------------------------------------------- estilos da página
const CSS = `
.rg-wrap{width:100%;max-width:1680px;margin:0 auto;padding:0 28px 48px;box-sizing:border-box;color:var(--fg)}
.rg-bar{position:sticky;top:${NAV_H}px;z-index:20;margin:0 -28px 18px;padding:14px 28px 12px;
  background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(12px);
  border-bottom:1px solid var(--panel-border)}
.rg-bar-top{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.rg-title{font-size:22px;font-weight:800;margin:0;letter-spacing:-.01em}
.rg-sub{font-size:12.5px;color:color-mix(in srgb,var(--fg) 62%,transparent);margin-top:2px}
.rg-stats{display:flex;gap:8px;flex-wrap:wrap}
.rg-stat{display:flex;flex-direction:column;align-items:flex-start;padding:6px 12px;border-radius:12px;
  background:var(--card);border:1px solid var(--panel-border);min-width:74px}
.rg-stat b{font-size:18px;line-height:1.1}
.rg-stat span{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;opacity:.6}
.rg-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:auto}
.rg-search{position:relative}
.rg-search input{width:260px;padding:8px 10px 8px 32px;border-radius:10px;border:1px solid var(--panel-border);
  background:var(--card);color:var(--fg);font-size:13px;outline:none}
.rg-search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
.rg-search svg{position:absolute;left:10px;top:9px;opacity:.5}
.rg-btn{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:650;padding:8px 13px;border-radius:10px;
  cursor:pointer;border:1px solid var(--panel-border);background:var(--card);color:var(--fg);transition:var(--transition-smooth)}
.rg-btn:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
.rg-btn:disabled{opacity:.45;cursor:not-allowed}
.rg-btn.pri{background:var(--gradient-primary);color:#fff;border-color:transparent}
.rg-btn.pri:hover:not(:disabled){color:#fff;filter:brightness(1.08);box-shadow:var(--shadow-soft)}
.rg-btn.ok{color:var(--success);border-color:color-mix(in srgb,var(--success) 45%,transparent)}
.rg-btn.ia{color:#7c3aed;border-color:color-mix(in srgb,#7c3aed 40%,transparent);background:color-mix(in srgb,#7c3aed 7%,var(--card))}
.rg-btn.sm{padding:6px 10px;font-size:12px}
.rg-body{display:grid;grid-template-columns:250px minmax(0,1fr);gap:26px;align-items:start}
.rg-side{position:sticky;top:${NAV_H + 128}px;max-height:calc(100vh - ${NAV_H + 150}px);overflow:auto;
  background:var(--card);border:1px solid var(--panel-border);border-radius:14px;padding:10px}
.rg-side h4{margin:4px 8px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;opacity:.55}
.rg-side a{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:9px;font-size:13px;color:var(--fg);
  text-decoration:none;cursor:pointer;transition:var(--transition-smooth)}
.rg-side a:hover{background:color-mix(in srgb,var(--accent) 8%,transparent)}
.rg-side a.on{background:color-mix(in srgb,var(--accent) 13%,transparent);font-weight:700}
.rg-side a i{width:9px;height:9px;border-radius:50%;flex:none}
.rg-side a em{margin-left:auto;font-style:normal;font-size:11px;opacity:.6}
.rg-group{scroll-margin-top:${NAV_H + 140}px;margin-bottom:30px}
.rg-ghead{display:flex;align-items:center;gap:12px;margin:6px 0 14px}
.rg-ghead .rg-gt{margin:0;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.1em}
.rg-ghead .line{flex:1;height:2px;border-radius:2px}
.rg-ghead .cnt{font-size:11.5px;font-weight:700;padding:3px 10px;border-radius:20px}
.rg-cards{display:grid;gap:14px}
.rg-card{background:var(--card);border:1px solid var(--panel-border);border-left-width:5px;border-radius:14px;
  box-shadow:var(--shadow-soft);transition:box-shadow .2s ease,transform .2s ease;animation:rgIn .35s ease both;scroll-margin-top:${NAV_H + 140}px}
.rg-card:hover{box-shadow:var(--shadow-medium)}
.rg-chead{display:flex;align-items:center;gap:14px;padding:14px 16px;cursor:pointer;user-select:none}
.rg-num{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;font-weight:800;font-size:16px;color:#fff;flex:none}
.rg-name{font-size:15.5px;font-weight:750;line-height:1.3}
.rg-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:5px}
.rg-tag{font-size:10.5px;font-weight:700;padding:2px 9px;border-radius:20px;white-space:nowrap;display:inline-flex;align-items:center;gap:4px}
.rg-cact{display:flex;gap:6px;margin-left:auto;align-items:center}
.rg-chev{transition:transform .25s ease;opacity:.55}
.rg-chev.open{transform:rotate(180deg)}
.rg-cbody{padding:0 18px 18px 74px;animation:rgIn .25s ease both}
.rg-lead{font-size:13.5px;line-height:1.65;white-space:pre-wrap;margin:0 0 14px}
.rg-clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:13px;line-height:1.55;
  margin:0;padding:0 18px 14px 74px;color:color-mix(in srgb,var(--fg) 75%,transparent)}
.rg-tabs{display:flex;gap:4px;border-bottom:1px solid var(--panel-border);margin-bottom:14px;flex-wrap:wrap}
.rg-tab{display:inline-flex;align-items:center;gap:6px;padding:8px 12px;font-size:12.5px;font-weight:650;cursor:pointer;
  border:none;background:none;color:color-mix(in srgb,var(--fg) 65%,transparent);border-bottom:2px solid transparent;margin-bottom:-1px}
.rg-tab.on{color:var(--accent);border-bottom-color:var(--accent)}
.rg-crit{display:grid;gap:8px}
.rg-crow{display:grid;grid-template-columns:150px 1fr;gap:12px;align-items:start;font-size:13px;line-height:1.55;
  padding:9px 12px;border-radius:10px;background:color-mix(in srgb,var(--fg) 3%,transparent)}
.rg-crow b{font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:3px 8px;border-radius:7px;text-align:center}
.rg-steps{counter-reset:p;display:grid;gap:9px;margin:0;padding:0;list-style:none}
.rg-steps li{position:relative;padding:2px 0 2px 40px;font-size:13px;line-height:1.6}
.rg-steps li::before{counter-increment:p;content:counter(p);position:absolute;left:0;top:0;width:27px;height:27px;border-radius:50%;
  display:grid;place-items:center;font-size:12px;font-weight:800;color:#fff;background:var(--rg-cor)}
.rg-fat{display:grid;gap:8px}
.rg-fat div{font-size:13px;line-height:1.55;padding:9px 12px;border-radius:10px;background:color-mix(in srgb,var(--fg) 3%,transparent)}
.rg-meta{font-size:11.5px;opacity:.55;margin-top:12px}
.rg-edit{display:grid;gap:12px;padding:0 18px 18px 74px}
.rg-edit label{font-size:11.5px;font-weight:700;opacity:.75;display:block;margin-bottom:4px}
.rg-edit textarea,.rg-edit input{width:100%;box-sizing:border-box;border:1px solid var(--panel-border);border-radius:10px;padding:9px 11px;
  font:inherit;font-size:13px;line-height:1.55;background:color-mix(in srgb,var(--fg) 2%,var(--card));color:var(--fg);outline:none;resize:vertical}
.rg-edit textarea:focus,.rg-edit input:focus{border-color:var(--accent)}
.rg-note{font-size:12.5px;line-height:1.5;padding:9px 12px;border-radius:10px}
.rg-err{color:var(--danger);background:color-mix(in srgb,var(--danger) 9%,transparent);border:1px solid color-mix(in srgb,var(--danger) 30%,transparent)}
.rg-dd{position:absolute;top:calc(100% + 6px);right:0;z-index:30;width:400px;max-height:440px;display:flex;flex-direction:column;
  background:var(--card);border:1px solid var(--panel-border);border-radius:12px;box-shadow:var(--shadow-elevated)}
.rg-empty{padding:40px;text-align:center;opacity:.6;font-size:14px}
@keyframes rgIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes rgSpin{to{transform:rotate(360deg)}}
.rg-spin{animation:rgSpin 1s linear infinite}
@media (max-width:1100px){.rg-body{grid-template-columns:1fr}.rg-side{display:none}.rg-cbody,.rg-edit,.rg-clamp{padding-left:18px}}
@media (max-width:700px){.rg-wrap{padding:0 14px 40px}.rg-bar{margin:0 -14px 14px;padding:12px 14px}.rg-search input{width:100%}.rg-crow{grid-template-columns:1fr}}
`;

// ---------------------------------------------------------------- render de textos
function inline(s) {
  return String(s).split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : <React.Fragment key={i}>{p}</React.Fragment>);
}

const CRIT = [
  { re: /^ERRO quando:?/i, rot: 'Erro', cor: 'var(--danger)' },
  { re: /^ALERTA quando:?/i, rot: 'Alerta', cor: 'var(--warning)' },
  { re: /^OK quando:?/i, rot: 'OK', cor: 'var(--success)' },
  { re: /^N[ÃA]O SE APLICA quando:?/i, rot: 'Não se aplica', cor: '#64748b' },
  { re: /^Limites e toler[âa]ncias:?/i, rot: 'Limites', cor: 'var(--accent)' },
  { re: /^Exce[çc][õo]es[^:]*:?/i, rot: 'Exceções', cor: '#7c3aed' },
];

function Criterios({ texto }) {
  const linhas = String(texto || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return (
    <div className="rg-crit">
      {linhas.map((l, i) => {
        const c = CRIT.find((x) => x.re.test(l));
        if (!c) return <div key={i} className="rg-crow" style={{ gridTemplateColumns: '1fr' }}>{inline(l)}</div>;
        return (
          <div key={i} className="rg-crow">
            <b style={{ color: c.cor, background: `color-mix(in srgb, ${c.cor} 13%, transparent)` }}>{c.rot}</b>
            <span>{inline(l.replace(c.re, '').trim())}</span>
          </div>
        );
      })}
    </div>
  );
}

function Faturas({ texto }) {
  const linhas = String(texto || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return (
    <div className="rg-fat">
      {linhas.map((l, i) => {
        const m = l.match(/^([^:]{2,40}):\s*(.*)$/);
        return <div key={i}>{m ? <><b>{m[1]}:</b> {inline(m[2])}</> : inline(l)}</div>;
      })}
    </div>
  );
}

function Aplicacao({ texto }) {
  const linhas = String(texto || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const intro = [];
  const passos = [];
  linhas.forEach((l) => {
    const m = l.match(/^\d+[.)]\s*(.*)$/);
    if (m) passos.push(m[1]);
    else if (passos.length) passos[passos.length - 1] += ' ' + l;
    else intro.push(l);
  });
  return (
    <>
      {intro.length > 0 && <p className="rg-lead" style={{ fontWeight: 600 }}>{intro.join(' ')}</p>}
      <ol className="rg-steps">{passos.map((p, i) => <li key={i}>{inline(p)}</li>)}</ol>
    </>
  );
}

// Laudo do teste (markdown mínimo: títulos, listas, **negrito**, tabelas)
function Laudo({ texto }) {
  const linhas = String(texto || '').split('\n');
  const out = [];
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i];
    if (/^\s*\|/.test(l)) {
      const rows = [];
      while (i < linhas.length && /^\s*\|/.test(linhas[i])) { rows.push(linhas[i]); i++; }
      i--;
      const cells = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r))
        .map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      out.push(
        <div key={i} style={{ overflowX: 'auto', margin: '8px 0' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%' }}>
            <tbody>{cells.map((r, ri) => (
              <tr key={ri} style={ri === 0 ? { background: 'color-mix(in srgb, var(--accent) 8%, transparent)' } : undefined}>
                {r.map((c, ci) => {
                  const C = ri === 0 ? 'th' : 'td';
                  return <C key={ci} style={{ border: '1px solid var(--panel-border)', padding: '6px 9px', textAlign: 'left', fontWeight: ri === 0 ? 700 : 400 }}>{inline(c)}</C>;
                })}
              </tr>))}
            </tbody>
          </table>
        </div>);
    } else if (/^#{1,4}\s/.test(l)) {
      out.push(<div key={i} style={{ fontWeight: 800, fontSize: 14, margin: '14px 0 6px' }}>{inline(l.replace(/^#+\s/, ''))}</div>);
    } else if (/^\s*[-*]\s/.test(l)) {
      out.push(<div key={i} style={{ paddingLeft: 14, textIndent: -10 }}>• {inline(l.replace(/^\s*[-*]\s/, ''))}</div>);
    } else if (l.trim() === '') {
      out.push(<div key={i} style={{ height: 6 }} />);
    } else {
      out.push(<div key={i}>{inline(l)}</div>);
    }
  }
  return <div style={{ fontSize: 13, lineHeight: 1.6 }}>{out}</div>;
}

// ---------------------------------------------------------------- seletor (cabeçalho)
function SeletorRegras({ regras, selecionadas, setSelecionadas }) {
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    const fora = (e) => { if (ref.current && !ref.current.contains(e.target)) setAberto(false); };
    document.addEventListener('mousedown', fora);
    return () => document.removeEventListener('mousedown', fora);
  }, []);
  const total = regras.length;
  const todas = selecionadas.size === total && total > 0;
  const rotulo = todas ? `Todas (${total})` : selecionadas.size === 0 ? 'Nenhuma' : `${selecionadas.size} de ${total}`;
  const q = busca.trim().toLowerCase();
  const filtradas = regras.filter((r) => !q || `${r.codigo} ${r.nome} ${r.grupo}`.toLowerCase().includes(q));
  const toggle = (cod) => setSelecionadas((s) => { const n = new Set(s); if (n.has(cod)) n.delete(cod); else n.add(cod); return n; });
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="rg-btn" onClick={() => setAberto((v) => !v)}>
        <ListChecks size={15} /> Regras a aplicar: <b>{rotulo}</b> <ChevronDown size={14} />
      </button>
      {aberto && (
        <div className="rg-dd">
          <div style={{ padding: 10, borderBottom: '1px solid var(--panel-border)' }}>
            <div className="rg-search"><Search size={14} /><input autoFocus value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar regra…" style={{ width: '100%', boxSizing: 'border-box' }} /></div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, marginTop: 9, cursor: 'pointer' }}>
              <input type="checkbox" checked={todas} onChange={() => setSelecionadas(todas ? new Set() : new Set(regras.map((r) => r.codigo)))} />
              Todas ({total})
            </label>
          </div>
          <div style={{ overflowY: 'auto', padding: '4px 10px 10px' }}>
            {filtradas.map((r) => (
              <label key={r.codigo} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, padding: '6px 2px', cursor: 'pointer' }}>
                <input type="checkbox" checked={selecionadas.has(r.codigo)} onChange={() => toggle(r.codigo)} style={{ marginTop: 2 }} />
                <span><b style={{ color: corDoGrupo(r.grupo) }}>Regra {num(r.codigo)}</b> — {r.nome}</span>
              </label>
            ))}
            {filtradas.length === 0 && <div style={{ fontSize: 12, opacity: 0.6, padding: 8 }}>Nenhuma regra encontrada.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- modal "Testar"
const ROTULO_STATUS = {
  enviando: 'Enviando as faturas…',
  pendente: 'Na fila — aguardando o agente Claude da VPS pegar o teste…',
  processando: 'O agente Claude está analisando as faturas…',
  concluido: 'Concluído',
  erro: 'O agente não conseguiu concluir o teste',
  cancelado: 'Teste cancelado',
};

function TestarModal({ codigos, regrasPorCodigo, onClose }) {
  const [arquivos, setArquivos] = useState([]);
  const [teste, setTeste] = useState(null);
  const [fase, setFase] = useState('');
  const [erro, setErro] = useState('');
  const [salvo, setSalvo] = useState(false);
  const inputRef = useRef(null);
  const timer = useRef(null);
  const rodando = ['enviando', 'pendente', 'processando'].includes(fase);

  const parar = () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } };
  useEffect(() => parar, []);

  const acompanhar = useCallback((id) => {
    parar();
    const tick = async () => {
      try {
        const st = await statusTesteRegra(id);
        setTeste(st); setFase(st.status);
        if (!['pendente', 'processando'].includes(st.status)) parar();
      } catch (e) { setErro(errMsg(e)); }
    };
    tick();
    timer.current = setInterval(tick, POLL_MS);
  }, []);

  const anexar = (lista) => {
    const pdfs = Array.from(lista || []).filter((f) => /\.pdf$/i.test(f.name));
    if (!pdfs.length) return;
    setArquivos((atual) => {
      const vistos = new Set(atual.map((f) => f.name + f.size));
      const juntos = [...atual, ...pdfs.filter((f) => !vistos.has(f.name + f.size))];
      if (juntos.length > MAX_FATURAS) setErro(`Máximo de ${MAX_FATURAS} faturas por teste.`);
      return juntos.slice(0, MAX_FATURAS);
    });
    setTeste(null); setFase(''); setSalvo(false);
  };

  const iniciar = async () => {
    if (!arquivos.length) return;
    setErro(''); setSalvo(false); setTeste(null); setFase('enviando');
    try { const r = await criarTesteRegra(arquivos, codigos); acompanhar(r.id); }
    catch (e) { setFase(''); setErro(errMsg(e)); }
  };

  const cancelar = async () => {
    parar();
    if (teste?.id && ['pendente', 'processando'].includes(fase)) {
      try { await cancelarTesteRegra(teste.id); } catch { /* fecha mesmo assim */ }
    }
    onClose();
  };

  const salvar = async () => {
    if (!teste?.id) return;
    try { await salvarTesteRegra(teste.id); setSalvo(true); } catch (e) { setErro(errMsg(e)); }
  };

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') cancelar(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  });

  const uma = codigos.length === 1 ? regrasPorCodigo[codigos[0]] : null;
  const titulo = uma ? `Testar Regra ${num(uma.codigo)} — ${uma.nome}` : `Testar faturas com ${codigos.length} regras`;

  return (
    <div onMouseDown={(e) => { if (e.target === e.currentTarget && !rodando) cancelar(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ width: 'min(860px, 100%)', maxHeight: '92vh', display: 'flex', flexDirection: 'column', background: 'var(--card)', color: 'var(--fg)', border: '1px solid var(--panel-border)', borderRadius: 18, boxShadow: 'var(--shadow-elevated)', animation: 'rgIn .25s ease both' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '1px solid var(--panel-border)' }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--gradient-primary)', color: '#fff' }}><FlaskConical size={18} /></div>
          <div style={{ fontWeight: 800, fontSize: 16, flex: 1 }}>{titulo}</div>
          <button type="button" onClick={cancelar} title="Fechar" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}><X size={19} /></button>
        </div>

        <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
          {!uma && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 12 }}>
              {codigos.map((c) => { const r = regrasPorCodigo[c]; const cor = corDoGrupo(r?.grupo); return <span key={c} className="rg-tag" style={{ color: cor, background: `color-mix(in srgb, ${cor} 12%, transparent)` }}>Regra {num(c)}</span>; })}
            </div>
          )}
          {uma?.faturas_necessarias && (
            <div className="rg-note" style={{ background: 'color-mix(in srgb, var(--accent) 7%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)', marginBottom: 14 }}>
              <div style={{ fontWeight: 800, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}><Files size={14} /> Faturas necessárias</div>
              <Faturas texto={uma.faturas_necessarias} />
            </div>
          )}
          {!uma && (
            <div style={{ fontSize: 12.5, opacity: 0.7, marginBottom: 14 }}>
              Anexe as faturas dos meses que as regras pedem (ex.: a do mês seguinte para continuidade de leitura). Todas precisam ser da <b>mesma unidade</b>.
            </div>
          )}

          <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => { anexar(e.target.files); e.target.value = ''; }} />
          <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (!rodando) anexar(e.dataTransfer.files); }}
            style={{ border: '2px dashed var(--panel-border)', borderRadius: 14, padding: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: 'color-mix(in srgb, var(--fg) 2%, transparent)' }}>
            <button type="button" className="rg-btn" disabled={rodando || arquivos.length >= MAX_FATURAS} onClick={() => inputRef.current?.click()}>
              <Paperclip size={15} /> Anexar faturas (PDF)
            </button>
            <span style={{ fontSize: 12.5, opacity: 0.65 }}>
              {arquivos.length ? `${arquivos.length} fatura(s) anexada(s)` : `ou arraste os PDFs aqui — até ${MAX_FATURAS}, da mesma unidade`}
            </span>
          </div>
          {arquivos.length > 0 && (
            <div style={{ display: 'grid', gap: 5, marginTop: 10 }}>
              {arquivos.map((f, i) => (
                <div key={f.name + f.size} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.5, border: '1px solid var(--panel-border)', borderRadius: 9, padding: '6px 10px' }}>
                  <FileText size={14} style={{ color: 'var(--accent)' }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <span style={{ opacity: 0.55 }}>{(f.size / 1024).toFixed(0)} KB</span>
                  {!rodando && <button type="button" title="Remover" onClick={() => setArquivos((a) => a.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer' }}><Trash2 size={14} /></button>}
                </div>
              ))}
            </div>
          )}

          {erro && <div className="rg-note rg-err" style={{ marginTop: 12 }}>{erro}</div>}
          {fase && (
            <div style={{ marginTop: 16, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
              {rodando && <Loader2 size={15} className="rg-spin" />}
              <b>{ROTULO_STATUS[fase] || fase}</b>
              {fase === 'pendente' && teste?.na_frente > 0 && <span style={{ opacity: 0.7 }}>({teste.na_frente} teste(s) na frente)</span>}
              {teste?.id && <span style={{ opacity: 0.5, marginLeft: 'auto' }}>teste #{teste.id}</span>}
            </div>
          )}
          {fase === 'pendente' && <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>O agente verifica a fila a cada minuto; a análise costuma levar de 1 a 5 minutos. Pode deixar esta janela aberta.</div>}
          {teste?.resultado && (
            <div style={{ marginTop: 16, border: '1px solid var(--panel-border)', borderRadius: 12, padding: 16 }}>
              <Laudo texto={teste.resultado} />
            </div>
          )}
          {salvo && <div style={{ marginTop: 10, fontSize: 13, color: 'var(--success)', fontWeight: 700 }}>✓ Laudo salvo no histórico de testes.</div>}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '14px 20px', borderTop: '1px solid var(--panel-border)' }}>
          <button type="button" className="rg-btn" onClick={cancelar}><X size={14} /> Cancelar</button>
          <button type="button" className="rg-btn pri" onClick={iniciar} disabled={!arquivos.length || rodando}><Play size={14} /> Iniciar</button>
          <button type="button" className="rg-btn ok" onClick={salvar} disabled={fase !== 'concluido' || salvo}><Save size={14} /> Salvar</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- card de regra
const ABAS = [
  { id: 'criterios', rot: 'Critérios', Icon: Scale },
  { id: 'faturas', rot: 'Faturas necessárias', Icon: Files },
  { id: 'aplicacao', rot: 'Aplicação passo a passo', Icon: ListChecks },
  { id: 'base', rot: 'Base legal', Icon: BookOpen },
];
const CAMPOS_EDIT = [
  ['interpretacao', 'Interpretação', 6], ['faturas_necessarias', 'Faturas necessárias da unidade', 4],
  ['criterios', 'Critérios', 7], ['aplicacao', 'Aplicação (passo a passo)', 14],
];

function CardRegra({ regra, aberto, onToggle, onSalvo, onTestar }) {
  const cor = corDoGrupo(regra.grupo);
  const [aba, setAba] = useState('criterios');
  const [editando, setEditando] = useState(false);
  const [form, setForm] = useState({});
  const [antesIA, setAntesIA] = useState(null);
  const [obsIA, setObsIA] = useState('');
  const [busy, setBusy] = useState('');
  const [erro, setErro] = useState('');

  const alterar = (e) => {
    e?.stopPropagation();
    setForm({
      interpretacao: regra.interpretacao || '', faturas_necessarias: regra.faturas_necessarias || '',
      criterios: regra.criterios || '', aplicacao: regra.aplicacao || '', base_legal: regra.base_legal || '',
    });
    setAntesIA(null); setObsIA(''); setErro(''); setEditando(true);
    if (!aberto) onToggle();
  };
  const salvar = async () => {
    setBusy('salvar'); setErro('');
    try { const item = await atualizarFichaRegra(regra.codigo, form); onSalvo(item); setEditando(false); }
    catch (e) { setErro(errMsg(e)); } finally { setBusy(''); }
  };
  const melhorar = async () => {
    setBusy('ia'); setErro('');
    try {
      const s = await melhorarFichaRegra(regra.codigo, form);
      setAntesIA(form);
      setForm((f) => ({ ...f, ...Object.fromEntries(Object.entries(s || {}).filter(([k, v]) => k in f && typeof v === 'string' && v.trim())) }));
      setObsIA(s?.observacoes || 'Texto revisado pela IA — confira antes de salvar.');
    } catch (e) { setErro('IA: ' + errMsg(e)); } finally { setBusy(''); }
  };
  const F = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const minimo = (regra.faturas_necessarias || '').match(/M[ií]nimo:\s*([^—\n.]+)/i)?.[1]?.trim();

  return (
    <div id={`regra-${regra.codigo}`} className="rg-card" style={{ borderLeftColor: cor, '--rg-cor': cor }}>
      <div className="rg-chead" onClick={() => !editando && onToggle()}>
        <div className="rg-num" style={{ background: `linear-gradient(135deg, ${cor}, color-mix(in srgb, ${cor} 55%, #fff))` }}>{num(regra.codigo)}</div>
        <div style={{ minWidth: 0 }}>
          <div className="rg-name">Regra {num(regra.codigo)}: {regra.nome}</div>
          <div className="rg-tags">
            {regra.grupo && <span className="rg-tag" style={{ color: cor, background: `color-mix(in srgb, ${cor} 12%, transparent)` }}>{regra.grupo}</span>}
            {minimo && <span className="rg-tag" style={{ color: 'var(--fg)', background: 'color-mix(in srgb, var(--fg) 7%, transparent)' }}><Files size={11} /> {minimo}</span>}
            {regra.no_motor && <span className="rg-tag" title="Também roda automaticamente no motor de auditoria" style={{ color: 'var(--success)', background: 'color-mix(in srgb, var(--success) 12%, transparent)' }}><Cpu size={11} /> no motor</span>}
          </div>
        </div>
        <div className="rg-cact" onClick={(e) => e.stopPropagation()}>
          {!editando && <button type="button" className="rg-btn sm" onClick={alterar}><Pencil size={13} /> Alterar</button>}
          {!editando && <button type="button" className="rg-btn sm pri" onClick={() => onTestar([regra.codigo])}><FlaskConical size={13} /> Testar</button>}
          <ChevronDown size={18} className={`rg-chev ${aberto ? 'open' : ''}`} onClick={() => !editando && onToggle()} style={{ cursor: 'pointer' }} />
        </div>
      </div>

      {!aberto && <p className="rg-clamp">{regra.interpretacao}</p>}

      {aberto && !editando && (
        <div className="rg-cbody">
          <p className="rg-lead">{regra.interpretacao}</p>
          <div className="rg-tabs">
            {ABAS.map(({ id, rot, Icon }) => (
              <button key={id} type="button" className={`rg-tab ${aba === id ? 'on' : ''}`} onClick={() => setAba(id)}><Icon size={14} /> {rot}</button>
            ))}
          </div>
          {aba === 'criterios' && <Criterios texto={regra.criterios} />}
          {aba === 'faturas' && <Faturas texto={regra.faturas_necessarias} />}
          {aba === 'aplicacao' && <Aplicacao texto={regra.aplicacao} />}
          {aba === 'base' && <p className="rg-lead">{regra.base_legal || '—'}</p>}
          {regra.atualizado_por && <div className="rg-meta">Alterada por {regra.atualizado_por} em {regra.atualizado_em}</div>}
        </div>
      )}

      {editando && (
        <div className="rg-edit">
          {obsIA && (
            <div className="rg-note" style={{ background: 'color-mix(in srgb, #7c3aed 8%, transparent)', border: '1px solid color-mix(in srgb, #7c3aed 30%, transparent)' }}>
              <b style={{ color: '#7c3aed' }}>✨ Sugestão da IA aplicada nos campos.</b> {obsIA}
            </div>
          )}
          {CAMPOS_EDIT.map(([k, rot, rows]) => (
            <div key={k}><label>{rot}</label><textarea rows={rows} value={form[k] || ''} onChange={F(k)} /></div>
          ))}
          <div><label>Base legal</label><input value={form.base_legal || ''} onChange={F('base_legal')} /></div>
          {erro && <div className="rg-note rg-err">{erro}</div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="rg-btn ia" disabled={!!busy} onClick={melhorar} title="A IA interpreta o que foi escrito e devolve uma versão revisada (você confere antes de salvar)">
              {busy === 'ia' ? <Loader2 size={14} className="rg-spin" /> : <Sparkles size={14} />} Melhorar texto com IA
            </button>
            {antesIA && <button type="button" className="rg-btn" disabled={!!busy} onClick={() => { setForm(antesIA); setAntesIA(null); setObsIA(''); }}><Undo2 size={14} /> Desfazer sugestão</button>}
            <div style={{ flex: 1 }} />
            <button type="button" className="rg-btn" disabled={!!busy} onClick={() => setEditando(false)}><X size={14} /> Cancelar</button>
            <button type="button" className="rg-btn pri" disabled={!!busy} onClick={salvar}>{busy === 'salvar' ? <Loader2 size={14} className="rg-spin" /> : <Check size={14} />} Salvar</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- nova regra
const MODELO_NOVA = {
  nome: '', grupo: '',
  interpretacao: 'A regra NN trata de ',
  faturas_necessarias: 'Mínimo: \nIdeal: \nCom uma fatura só: ',
  criterios: 'ERRO quando: \nALERTA quando: \nOK quando: \nNÃO SE APLICA quando: \nLimites e tolerâncias: \nExceções que afastam o erro: ',
  aplicacao: 'Na prática, passo a passo:\n1. \n2. \n3. ',
  base_legal: '',
};

function NovaRegraModal({ grupos, onClose, onCriada }) {
  const [form, setForm] = useState(MODELO_NOVA);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState('');
  const F = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const criar = async () => {
    setBusy(true); setErro('');
    try { onCriada(await criarFichaRegra(form)); } catch (e) { setErro(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ width: 'min(860px, 100%)', maxHeight: '92vh', display: 'flex', flexDirection: 'column', background: 'var(--card)', color: 'var(--fg)', border: '1px solid var(--panel-border)', borderRadius: 18, boxShadow: 'var(--shadow-elevated)', animation: 'rgIn .25s ease both' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '1px solid var(--panel-border)' }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--gradient-primary)', color: '#fff' }}><Plus size={18} /></div>
          <div style={{ fontWeight: 800, fontSize: 16, flex: 1 }}>Nova regra do catálogo <span style={{ fontWeight: 500, fontSize: 12.5, opacity: 0.6 }}>— recebe o próximo número automaticamente</span></div>
          <button type="button" onClick={onClose} title="Fechar" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}><X size={19} /></button>
        </div>
        <div className="rg-edit" style={{ padding: 20, overflowY: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            <div><label>Nome da regra</label><input value={form.nome} onChange={F('nome')} placeholder="Ex.: Cobrança de CIP acima da lei municipal" /></div>
            <div><label>Grupo</label><input list="rg-grupos" value={form.grupo} onChange={F('grupo')} placeholder="Escolha ou digite" />
              <datalist id="rg-grupos">{grupos.map((g) => <option key={g} value={g} />)}</datalist></div>
          </div>
          {CAMPOS_EDIT.map(([k, rot, rows]) => (
            <div key={k}><label>{rot}</label><textarea rows={rows} value={form[k]} onChange={F(k)} /></div>
          ))}
          <div><label>Base legal</label><input value={form.base_legal} onChange={F('base_legal')} /></div>
          {erro && <div className="rg-note rg-err">{erro}</div>}
          <div style={{ fontSize: 12, opacity: 0.65 }}>Depois de criar, use <b>Alterar → Melhorar texto com IA</b> para revisar a redação.</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '14px 20px', borderTop: '1px solid var(--panel-border)' }}>
          <button type="button" className="rg-btn" onClick={onClose} disabled={busy}><X size={14} /> Cancelar</button>
          <button type="button" className="rg-btn pri" onClick={criar} disabled={busy || !form.nome.trim()}>{busy ? <Loader2 size={14} className="rg-spin" /> : <Check size={14} />} Criar regra</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- página
export default function Regras() {
  const [regras, setRegras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');
  const [selecionadas, setSelecionadas] = useState(new Set());
  const [busca, setBusca] = useState('');
  const [abertas, setAbertas] = useState(new Set());
  const [testar, setTestar] = useState(null);
  const [grupoAtivo, setGrupoAtivo] = useState('');
  const [nova, setNova] = useState(false);

  // abre na hora com a última lista guardada no navegador e atualiza do servidor por trás
  useEffect(() => {
    let cache = null;
    try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { cache = null; }
    if (Array.isArray(cache) && cache.length) {
      setRegras(cache);
      setSelecionadas(new Set(cache.map((r) => r.codigo)));
      setLoading(false);
    }
    (async () => {
      try {
        const items = await listarFichasRegras();
        setRegras(items);
        setSelecionadas((sel) => (sel.size === 0 || (cache && sel.size === cache.length)
          ? new Set(items.map((r) => r.codigo)) : sel));
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(items)); } catch { /* sem cache */ }
      } catch (e) { if (!cache) setErro('Não foi possível carregar as regras: ' + errMsg(e)); }
      finally { setLoading(false); }
    })();
  }, []);
  useEffect(() => {
    if (regras.length) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(regras)); } catch { /* sem cache */ } }
  }, [regras]);

  const porCodigo = useMemo(() => Object.fromEntries(regras.map((r) => [r.codigo, r])), [regras]);
  const q = busca.trim().toLowerCase();
  const visiveis = regras.filter((r) => selecionadas.has(r.codigo) && (!q ||
    `${r.codigo} regra ${num(r.codigo)} ${r.nome} ${r.grupo} ${r.interpretacao} ${r.criterios}`.toLowerCase().includes(q)));
  const grupos = useMemo(() => {
    const m = new Map();
    visiveis.forEach((r) => { const g = r.grupo || 'Outras'; if (!m.has(g)) m.set(g, []); m.get(g).push(r); });
    return [...m.entries()];
  }, [visiveis]);
  const totalPorGrupo = useMemo(() => regras.reduce((acc, r) => { acc[r.grupo || 'Outras'] = (acc[r.grupo || 'Outras'] || 0) + 1; return acc; }, {}), [regras]);
  const codigosSel = regras.map((r) => r.codigo).filter((c) => selecionadas.has(c));
  const noMotor = regras.filter((r) => r.no_motor).length;

  // índice lateral acompanha o grupo visível
  useEffect(() => {
    const els = grupos.map(([g]) => document.getElementById(`grupo-${g}`)).filter(Boolean);
    if (!els.length) return undefined;
    const io = new IntersectionObserver((ents) => {
      const vis = ents.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (vis[0]) setGrupoAtivo(vis[0].target.dataset.grupo);
    }, { rootMargin: `-${NAV_H + 130}px 0px -55% 0px` });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [grupos]);

  const toggle = (cod) => setAbertas((s) => { const n = new Set(s); if (n.has(cod)) n.delete(cod); else n.add(cod); return n; });
  const todasAbertas = visiveis.length > 0 && visiveis.every((r) => abertas.has(r.codigo));
  const onSalvo = (item) => { if (item) setRegras((rs) => rs.map((r) => (r.codigo === item.codigo ? item : r))); };

  return (
    <div className="rg-wrap">
      <style>{CSS}</style>

      <div className="rg-bar">
        <div className="rg-bar-top">
          <div>
            <h1 className="rg-title">Regras do Catálogo</h1>
            <div className="rg-sub">Como cada erro de faturamento é interpretado e aplicado — e o teste direto numa fatura.</div>
          </div>
          <div className="rg-stats">
            <div className="rg-stat"><b>{regras.length}</b><span>regras</span></div>
            <div className="rg-stat"><b>{grupos.length}</b><span>grupos</span></div>
            <div className="rg-stat"><b style={{ color: 'var(--success)' }}>{noMotor}</b><span>no motor</span></div>
          </div>
          <div className="rg-tools">
            <div className="rg-search"><Search size={15} /><input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por nº, nome ou assunto…" /></div>
            <SeletorRegras regras={regras} selecionadas={selecionadas} setSelecionadas={setSelecionadas} />
            <button type="button" className="rg-btn" onClick={() => setAbertas(todasAbertas ? new Set() : new Set(visiveis.map((r) => r.codigo)))}>
              {todasAbertas ? <><ChevronsDownUp size={15} /> Recolher</> : <><ChevronsUpDown size={15} /> Expandir</>}
            </button>
            <button type="button" className="rg-btn" onClick={() => setNova(true)}><Plus size={15} /> Nova regra</button>
            <button type="button" className="rg-btn pri" disabled={codigosSel.length === 0} onClick={() => setTestar(codigosSel)}>
              <FlaskConical size={15} /> Testar fatura ({codigosSel.length})
            </button>
          </div>
        </div>
      </div>

      {erro && <div className="rg-note rg-err" style={{ marginBottom: 14 }}>{erro}</div>}
      {loading && <div className="rg-empty"><Loader2 size={22} className="rg-spin" /><div>Carregando regras…</div></div>}
      {!loading && !erro && visiveis.length === 0 && <div className="rg-empty">Nenhuma regra {q ? `encontrada para “${busca}”` : 'selecionada'}.</div>}

      {!loading && visiveis.length > 0 && (
        <div className="rg-body">
          <aside className="rg-side">
            <h4>Grupos</h4>
            {grupos.map(([g, lista]) => (
              <a key={g} className={grupoAtivo === g ? 'on' : ''} onClick={() => document.getElementById(`grupo-${g}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                <i style={{ background: corDoGrupo(g) }} /> {g} <em>{lista.length}/{totalPorGrupo[g]}</em>
              </a>
            ))}
          </aside>
          <main>
            {grupos.map(([g, lista]) => {
              const cor = corDoGrupo(g);
              return (
                <section key={g} id={`grupo-${g}`} data-grupo={g} className="rg-group">
                  <div className="rg-ghead">
                    <div className="rg-gt" style={{ color: cor }}>{g}</div>
                    <span className="cnt" style={{ color: cor, background: `color-mix(in srgb, ${cor} 12%, transparent)` }}>{lista.length} regra{lista.length > 1 ? 's' : ''}</span>
                    <span className="line" style={{ background: `linear-gradient(90deg, ${cor}, transparent)` }} />
                  </div>
                  <div className="rg-cards">
                    {lista.map((r) => (
                      <CardRegra key={r.codigo} regra={r} aberto={abertas.has(r.codigo)} onToggle={() => toggle(r.codigo)} onSalvo={onSalvo} onTestar={setTestar} />
                    ))}
                  </div>
                </section>
              );
            })}
          </main>
        </div>
      )}

      {testar && <TestarModal codigos={testar} regrasPorCodigo={porCodigo} onClose={() => setTestar(null)} />}
      {nova && (
        <NovaRegraModal
          grupos={Object.keys(totalPorGrupo)}
          onClose={() => setNova(false)}
          onCriada={(item) => {
            setNova(false);
            setRegras((rs) => [...rs, item]);
            setSelecionadas((s) => new Set(s).add(item.codigo));
            setAbertas((s) => new Set(s).add(item.codigo));
            setTimeout(() => document.getElementById(`regra-${item.codigo}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
          }}
        />
      )}
    </div>
  );
}
