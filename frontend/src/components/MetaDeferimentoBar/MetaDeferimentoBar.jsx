// Barra de progressão (modesta) do deferimento/repasse do mês vs meta.
// Clique abre um popover com: seletor de ano, mês atual, acumulado do ano,
// quantidade de processos, cada mês (clicável → empresas) e a calibração das metas.
import React, { useEffect, useRef, useState } from 'react';
import { Target, Pencil, Check, X, ChevronRight, Loader2 } from 'lucide-react';
import { useMetaDeferimento, useUpdateMetas, useMetaDetalhe } from '../../hooks/useMetaDeferimento.js';
import './meta-deferimento-bar.css';

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function brl(v) {
  const n = Number(v || 0);
  return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); // com centavos (pedido 21/10/2026)
}
function fmtInt(v) {
  return Number(v || 0).toLocaleString('pt-BR');
}
function procLabel(q) {
  const n = Number(q || 0);
  return `${fmtInt(n)} ${n === 1 ? 'processo' : 'processos'}`;
}
function pct(valor, meta) {
  const m = Number(meta || 0);
  if (m <= 0) return 0;
  return Math.round((Number(valor || 0) / m) * 100);
}
function tone(p) {
  if (p >= 100) return 'ok';
  if (p >= 70) return 'warn';
  return 'low';
}

function MiniBar({ valor, meta, small }) {
  const p = pct(valor, meta);
  return (
    <div className={`mdb-track ${small ? 'mdb-track--sm' : ''}`}>
      <div className={`mdb-fill mdb-fill--${tone(p)}`} style={{ width: `${Math.min(p, 100)}%` }} />
    </div>
  );
}

// Painel expansível: empresas com processos no período clicado.
function EmpresaPanel({ loading, det }) {
  if (loading) {
    return (
      <div className="mdb-emp mdb-emp--msg">
        <Loader2 size={13} className="mdb-spin" /> Carregando empresas…
      </div>
    );
  }
  const emps = det?.empresas || [];
  if (!emps.length) {
    return <div className="mdb-emp mdb-emp--msg">Nenhuma empresa no período.</div>;
  }
  return (
    <div className="mdb-emp">
      {emps.map((e, i) => (
        <div className="mdb-emprow" key={`${e.empresa}-${i}`}>
          <span className="mdb-empnome" title={e.empresa}>{e.empresa}</span>
          <span className="mdb-empqtd">{procLabel(e.qtd)}</span>
          <span className="mdb-empval">{brl(e.repasse)}</span>
        </div>
      ))}
      <div className="mdb-emprow mdb-emprow--tot">
        <span className="mdb-empnome">Total · {emps.length} {emps.length === 1 ? 'empresa' : 'empresas'}</span>
        <span className="mdb-empqtd">{procLabel(det?.total_qtd)}</span>
        <span className="mdb-empval">{brl(det?.total_repasse)}</span>
      </div>
    </div>
  );
}

export default function MetaDeferimentoBar() {
  const { data, isLoading } = useMetaDeferimento();
  const updateMetas = useUpdateMetas();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [mMensal, setMMensal] = useState('');
  const [mAnual, setMAnual] = useState('');
  const [anoSel, setAnoSel] = useState(null); // ano selecionado (null = ano atual)
  const [expandKey, setExpandKey] = useState(null); // 'AAAA-M' (mês) | 'AAAA-0' (ano)
  const wrapRef = useRef(null);

  // detalhe por empresa do período expandido (só busca quando aberto + algo clicado)
  const [expAno, expMes] = expandKey ? expandKey.split('-').map(Number) : [null, null];
  const { data: det, isLoading: detLoading } = useMetaDetalhe(expAno, expMes, open && !!expandKey);

  useEffect(() => {
    function onDoc(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
        setEditing(false);
      }
    }
    function onEsc(e) {
      if (e.key === 'Escape') { setOpen(false); setEditing(false); }
    }
    if (open) {
      document.addEventListener('mousedown', onDoc);
      document.addEventListener('keydown', onEsc);
    }
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  if (isLoading || !data) {
    return <div className="mdb mdb--loading" aria-hidden />;
  }

  const metaMensal = Number(data.meta_mensal || 0);
  const metaAnual = Number(data.meta_anual || 0);
  const repMes = Number(data?.mes_atual?.repasse || 0);
  const qtdMesAtual = Number(data?.mes_atual?.qtd || 0);
  const anoAtual = data?.ano_atual?.ano;
  const mesAtual = data?.mes_atual?.mes;
  const pMes = pct(repMes, metaMensal);

  // anos disponíveis (dos dados) + ano atual, do mais novo p/ o mais antigo
  const anosDisp = Array.from(
    new Set([...(data.historico || []).map((h) => h.ano), anoAtual].filter(Boolean)),
  ).sort((a, b) => b - a);
  const ano = anoSel || anoAtual;
  const ehAnoAtual = ano === anoAtual;

  // meses do ano selecionado (mais recentes primeiro) + totais do ano
  const mesesAno = (data.historico || [])
    .filter((h) => h.ano === ano)
    .sort((a, b) => b.mes - a.mes);
  const repAno = mesesAno.reduce((s, h) => s + Number(h.repasse || 0), 0);
  const qtdAno = mesesAno.reduce((s, h) => s + Number(h.qtd || 0), 0);
  // lista de meses: no ano atual o mês corrente é mostrado em destaque acima
  const hist = (ehAnoAtual ? mesesAno.filter((h) => h.mes !== mesAtual) : mesesAno).slice(0, 12);

  const toggleDet = (a, m) => {
    const k = `${a}-${m || 0}`;
    setExpandKey((x) => (x === k ? null : k));
  };
  const keyAno = `${ano}-0`;

  function abrirEdicao() {
    setMMensal(String(metaMensal || ''));
    setMAnual(String(metaAnual || ''));
    setEditing(true);
  }
  async function salvar() {
    const payload = {};
    const mm = parseFloat(String(mMensal).replace(/\./g, '').replace(',', '.'));
    const ma = parseFloat(String(mAnual).replace(/\./g, '').replace(',', '.'));
    if (!Number.isNaN(mm)) payload.meta_mensal = mm;
    if (!Number.isNaN(ma)) payload.meta_anual = ma;
    if (Object.keys(payload).length) {
      await updateMetas.mutateAsync(payload);
    }
    setEditing(false);
  }

  return (
    <div className="mdb" ref={wrapRef}>
      <button
        type="button"
        className="mdb-trigger"
        onClick={() => setOpen((v) => !v)}
        title="Enviado ao financeiro no mês vs meta — clique para ver detalhes"
      >
        <Target size={13} className="mdb-trigger__ico" />
        <span className="mdb-trigger__label">Meta do mês</span>
        <MiniBar valor={repMes} meta={metaMensal} />
        <span className={`mdb-trigger__pct mdb-pct--${tone(pMes)}`}>{pMes}%</span>
      </button>

      {open && (
        <div className="mdb-pop" role="dialog">
          {/* Cabeçalho + seletor de ano */}
          <div className="mdb-pop__head">
            <div className="mdb-pop__title">Enviado ao financeiro</div>
            <div className="mdb-head__actions">
              <select
                className="mdb-year"
                value={ano}
                onChange={(e) => { setAnoSel(Number(e.target.value)); setExpandKey(null); }}
                title="Ano"
              >
                {anosDisp.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
              <button type="button" className="mdb-icon" onClick={abrirEdicao} title="Calibrar metas">
                <Pencil size={13} />
              </button>
            </div>
          </div>

          {/* Mês atual (só no ano corrente) */}
          {ehAnoAtual && (
            <>
              <div className="mdb-sec">Mês atual · {MESES[(mesAtual || 1) - 1]}/{anoAtual}</div>
              <div className="mdb-row mdb-row--big">
                <MiniBar valor={repMes} meta={metaMensal} />
                <div className="mdb-row__meta">
                  <b>{brl(repMes)}</b> <span className="mdb-muted">realizado · meta {brl(metaMensal)}</span>
                  <span className={`mdb-badge mdb-pct--${tone(pMes)}`}>{pMes}%</span>
                </div>
                <div className="mdb-row__sub">{procLabel(qtdMesAtual)} enviados</div>
              </div>
            </>
          )}

          {/* Acumulado no ano (clicável → empresas do ano) */}
          <div className="mdb-sec">Acumulado no ano · {ano}</div>
          <button
            type="button"
            className={`mdb-row mdb-row--big mdb-clk ${expandKey === keyAno ? 'is-open' : ''}`}
            onClick={() => toggleDet(ano, 0)}
            title="Ver empresas com processos no ano"
          >
            <MiniBar valor={repAno} meta={metaAnual} />
            <div className="mdb-row__meta">
              <b>{brl(repAno)}</b> <span className="mdb-muted">realizado · meta {brl(metaAnual)}</span>
              <span className={`mdb-badge mdb-pct--${tone(pct(repAno, metaAnual))}`}>{pct(repAno, metaAnual)}%</span>
            </div>
            <div className="mdb-row__sub">
              <ChevronRight size={12} className="mdb-chev" /> {procLabel(qtdAno)} no ano — ver empresas
            </div>
          </button>
          {expandKey === keyAno && (
            <EmpresaPanel loading={detLoading} det={det} />
          )}
          {ehAnoAtual && (
            <div className="mdb-hint">Acumulado = repasse enviado ao financeiro de jan até o mês atual (inclui o mês corrente).</div>
          )}

          {/* Calibração */}
          {editing && (
            <div className="mdb-edit">
              <label className="mdb-field">
                <span>Meta mensal (R$)</span>
                <input type="number" min="0" step="1000" value={mMensal}
                  onChange={(e) => setMMensal(e.target.value)} />
              </label>
              <label className="mdb-field">
                <span>Meta anual (R$)</span>
                <input type="number" min="0" step="1000" value={mAnual}
                  onChange={(e) => setMAnual(e.target.value)} />
              </label>
              <div className="mdb-edit__actions">
                <button type="button" className="mdb-btn mdb-btn--ok" onClick={salvar}
                  disabled={updateMetas.isPending}>
                  <Check size={13} /> Salvar
                </button>
                <button type="button" className="mdb-btn" onClick={() => setEditing(false)}>
                  <X size={13} /> Cancelar
                </button>
              </div>
            </div>
          )}

          {/* Meses do ano (clicáveis → empresas do mês) */}
          {!editing && hist.length > 0 && (
            <>
              <div className="mdb-sec">{ehAnoAtual ? 'Meses anteriores' : `Meses · ${ano}`}</div>
              <div className="mdb-hist">
                {hist.map((h) => {
                  const p = pct(h.repasse, metaMensal);
                  const k = `${h.ano}-${h.mes}`;
                  return (
                    <React.Fragment key={k}>
                      <button
                        type="button"
                        className={`mdb-hrow mdb-clk ${expandKey === k ? 'is-open' : ''}`}
                        onClick={() => toggleDet(h.ano, h.mes)}
                        title="Ver empresas com processos neste mês"
                      >
                        <span className="mdb-hmes">
                          <ChevronRight size={11} className="mdb-chev" />
                          {MESES[h.mes - 1]}/{String(h.ano).slice(2)}
                        </span>
                        <MiniBar valor={h.repasse} meta={metaMensal} small />
                        <span className="mdb-hqtd">{fmtInt(h.qtd)}</span>
                        <span className="mdb-hval">{brl(h.repasse)}</span>
                        <span className={`mdb-hpct mdb-pct--${tone(p)}`}>{p}%</span>
                      </button>
                      {expandKey === k && <EmpresaPanel loading={detLoading} det={det} />}
                    </React.Fragment>
                  );
                })}
              </div>
            </>
          )}

          <div className="mdb-foot">Repasse (parcela AME) por envio ao financeiro · nº = processos · clique num mês/ano p/ ver empresas · calibrável no lápis</div>
        </div>
      )}
    </div>
  );
}
