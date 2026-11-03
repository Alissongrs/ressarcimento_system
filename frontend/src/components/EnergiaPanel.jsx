import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import apiClient from '../services/apiClient';
import ModalFaturaMontada from './ModalFaturaMontada';
import { RegrasModal } from './UsinasPanel';

// ⚡ Aba ENERGIA da Auditoria de Faturas no formato da aba Usinas (FATURA_DADOS_EXTRAIDOS).
// Backend: GET /api/v1/energia/apontamentos — motor F01–F05 + regras do botão ⚙ Regras (conjunto "energia":
// tarifa/bandeira homologada da ANEEL e CIP comparada entre UCs) + rejeição POR REGRA. Lê ~160 mil faturas:
// o cálculo roda em segundo plano e a tela consulta até ficar pronto.
// Padrão: F01–F05 só das faturas verificadas pelo analista (como a aba Energia antiga) + tudo que as regras
// novas acharam. "Todos do motor" (só admin) inclui os apontamentos F01–F05 ainda não triados.
// Clique na linha: abre a fatura completa (mesmo modal da lista antiga — rejeitar, encaminhar, requisição).

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = (v, d = 0) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: d });
const mesBR = (m) => (m && m.length >= 7 ? `${m.slice(5, 7)}/${m.slice(0, 4)}` : m || '—');
const pdfLink = (l) => String(l || '').replace(/\.json$/i, '');
const SEM = [];

const CLASSIF = {
  ELEVADO_REAL: { rot: 'acima do histórico', cor: '#dc2626' },
  CRESCENTE: { rot: 'consumo crescente', cor: '#d97706' },
  SAZONAL: { rot: 'sazonal', cor: '#6b7280' },
  DENTRO_DO_HISTORICO: { rot: 'dentro do histórico', cor: '#6b7280' },
};
const VALID = { CONFIRMADO: 'confirmado pelas 3 próximas', SEM_3_PROXIMAS: 'aguardando 3 próximas', ATIVACAO: 'novo patamar (ativação)' };
const FICHA_ROT = {
  F01: 'leitura × constante ≠ consumo', F02: 'consumo acima da média', F03: 'faturamento pela média',
  F04: 'consumo zerado/estimado', F05: 'quebra de leitura', F28: 'tarifa acima da homologada',
  F41: 'bandeira diferente da oficial', F42: 'valor da bandeira acima do homologado', F51: 'CIP fora da faixa do município',
  F58: 'TUSD de geração', F13: 'ativo zero com reativo/demanda', F14: 'leitura atual menor que a anterior',
  F15: 'FP ≥ 0,92 com UFER cobrada', F17: 'Grupo B com reativo', F27: 'Grupo B com demanda', F35: 'total acima da nota fiscal (SEFAZ)',
  F36: 'item acima de quantidade × tarifa', F52: 'CIP cobrada em dobro', F53: 'injeção abaixo do histórico',
  F54: 'saldo de créditos não fecha', F55: 'saldo de créditos não usado',
  F06: 'fatura sem leitura do medidor', F07: 'virada do medidor', F08: 'troca de medidor',
  F33: 'ciclo abaixo de 15 dias', F34: 'ciclo acima do máximo', F57: 'disponibilidade + Fio B',
};

// base: 'energia' (FATURA_DADOS_EXTRAIDOS) ou 'acer' (FATURA_ACER_DADOS_EXTRAIDOS) — mesma tela, endpoint e conjunto de regras próprios
const BASES = {
  energia: { url: '/api/v1/energia/apontamentos', titulo: 'faturas de energia', cor: '#7c6f9c', aba: 'Energia',
    carregando: 'Calculando as regras nas ~160 mil faturas de energia… (leva 1–2 minutos; a tela atualiza sozinha)' },
  acer: { url: '/api/v1/acer/painel', titulo: 'faturas da Acer', cor: '#c2410c', aba: 'Acer',
    carregando: 'Calculando as regras nas ~68 mil faturas da Acer… (leva uns 2 minutos; a tela atualiza sozinha)' },
};

function Card({ titulo, valor, sub, cor }) {
  return (
    <div className="rounded-lg p-3 border border-[var(--cpv2-border)] bg-[var(--cpv2-surface)] min-w-[170px]">
      <div className="text-[11px] opacity-60">{titulo}</div>
      <div className="text-lg font-bold" style={{ color: cor || 'var(--cpv2-text)' }}>{valor}</div>
      {sub && <div className="text-[11px] opacity-60">{sub}</div>}
    </div>
  );
}

export default function EnergiaPanel({ admin = false, base = 'energia' }) {
  const B = BASES[base] || BASES.energia;
  const ehAcer = base === 'acer';
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [calculando, setCalculando] = useState(false);
  const [tentativa, setTentativa] = useState(0);
  const [origem, setOrigem] = useState(base === 'acer' ? 'todos' : 'padrao'); // Acer: sem triagem do analista — mostra o motor
  const [ficha, setFicha] = useState('todas');
  const [empresa, setEmpresa] = useState('todas');
  const [dist, setDist] = useState('todas');
  const [soFortes, setSoFortes] = useState(false);
  const [alertas, setAlertas] = useState(false);
  const [soReabertas, setSoReabertas] = useState(false);
  const [busca, setBusca] = useState('');
  const [aberta, setAberta] = useState(null);
  const [modalFatura, setModalFatura] = useState(null);
  const [regrasAberto, setRegrasAberto] = useState(false);
  const [removidas, setRemovidas] = useState({}); // rejeitadas nesta sessão (o servidor já tirou do resultado)

  const carregar = useCallback((refresh) => {
    setErro('');
    apiClient.get(B.url, { params: refresh ? { refresh: 1 } : {}, timeout: 600000 })
      .then(({ status, data }) => {
        if (status === 202 || data?.calculando) {
          setCalculando(true);
          setTimeout(() => setTentativa((t) => t + 1), 15000);
          return;
        }
        setCalculando(false);
        setDados(data);
      })
      .catch((e) => { setCalculando(false); setErro(e?.response?.data?.error || e.message); });
  }, [B.url]);
  useEffect(() => { carregar(false); }, [carregar, tentativa]);
  const recalcular = () => { setDados(null); setRemovidas({}); carregar(true); };

  const aps = useMemo(() => (dados?.apontamentos || SEM).filter((a) => !removidas[a.id]), [dados, removidas]);
  const visiveis = useMemo(() => aps.filter((a) => {
    if (origem === 'todos') return true;
    if (origem === 'novas') return (a.achados || SEM).length > 0;
    return a.verificado || (a.achados || SEM).length > 0;
  }).map((a) => {
    // no padrão, F01–F05 de fatura não verificada não aparecem (seguem na triagem do admin)
    if (origem === 'todos' || a.verificado) return a;
    const motor = new Set(a.fichas_motor || SEM);
    return { ...a, fichas: (a.fichas || SEM).filter((f) => !motor.has(f)), _soNovas: true };
  }).filter((a) => (a.fichas || SEM).length > 0 || (a.alertas || SEM).length > 0), [aps, origem]);

  const empresas = useMemo(() => [...new Set(visiveis.map((a) => a.empresa || String(a.cod_empresa)))].sort(), [visiveis]);
  const dists = useMemo(() => [...new Set(visiveis.map((a) => a.distribuidora))].sort(), [visiveis]);
  const linhas = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return visiveis.filter((a) => {
      const fs = a.fichas || SEM;
      const al = a.alertas || SEM;
      return (ficha === 'todas' || fs.includes(ficha) || (alertas && al.includes(ficha)))
        && (alertas || fs.length > 0)
        && (empresa === 'todas' || (a.empresa || String(a.cod_empresa)) === empresa)
        && (dist === 'todas' || a.distribuidora === dist)
        && (!soFortes || a.forte)
        && (!soReabertas || a.rejeitada)
        && (!q || `${a.empresa} ${a.uc} ${a.distribuidora} ${a.id}`.toLowerCase().includes(q));
    });
  }, [visiveis, ficha, empresa, dist, soFortes, soReabertas, alertas, busca]);
  const contagem = useMemo(() => {
    const pf = {}; const pa = {};
    let f02 = 0; let outras = 0; let verif = 0; let fortes = 0; let reab = 0;
    visiveis.forEach((a) => {
      (a.fichas || SEM).forEach((f) => { pf[f] = (pf[f] || 0) + 1; });
      (a.alertas || SEM).forEach((f) => { pa[f] = (pa[f] || 0) + 1; });
      if ((a.fichas || SEM).includes('F02')) f02 += a.estimativa_f02 || 0;
      outras += a.valor_outras_regras || 0;
      if (a.verificado) verif += 1;
      if (a.forte) fortes += 1;
      if (a.rejeitada && (a.fichas || SEM).length) reab += 1;
    });
    return { pf, pa, f02, outras, verif, fortes, reab };
  }, [visiveis]);
  const somaLinhas = useMemo(() => linhas.reduce((s, a) => s + ((a.fichas || SEM).includes('F02') ? a.estimativa_f02 || 0 : 0)
    + (a.valor_outras_regras || 0), 0), [linhas]);

  const exportar = () => {
    const ws = XLSX.utils.json_to_sheet(linhas.map((a) => ({
      Regras: (a.fichas || SEM).join(','), Alertas: (a.alertas || SEM).join(','), Empresa: a.empresa, 'Cód. empresa': a.cod_empresa,
      Distribuidora: a.distribuidora, UC: a.uc, 'Mês ref.': mesBR(a.mes_referencia), 'Consumo kWh': a.consumo_kwh,
      'Média kWh': a.media_kwh || null, 'Desvio %': (a.fichas || SEM).includes('F02') ? a.desvio_pct : null,
      Classificação: CLASSIF[a.classificacao_historico]?.rot || a.classificacao_historico || '',
      Validação: VALID[a.f02_validacao] || a.f02_validacao || '', Forte: a.forte ? 'sim' : '', Verificado: a.verificado ? 'sim' : '',
      'Estimativa F02': (a.fichas || SEM).includes('F02') ? a.estimativa_f02 || null : null,
      'F02 conferido': a.estimativa_auditada ? 'sim' : '', 'Outras regras R$': a.valor_outras_regras || null,
      'Rejeitada antes': a.rejeitada ? `${(a.rejeitada.regras || SEM).join(',')} (${a.rejeitada.usuario}, ${a.rejeitada.em})` : '',
      Achados: (a.achados || SEM).map((x) => `${x.codigo} ${x.nivel}: ${x.detalhe}`).join(' | '),
      Detalhe: (a.detalhamento || SEM).join('; '), Fatura: pdfLink(a.link_fatura), id: a.id,
    })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `${B.aba} - regras`);
    XLSX.writeFile(wb, `auditoria_${base}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  if (!dados) {
    return (
      <div className="p-6 text-sm">
        {erro ? <span className="text-[var(--danger)]">Erro: {erro}</span>
          : <span className="opacity-70">{calculando ? B.carregando : 'Carregando…'}</span>}
      </div>
    );
  }
  const sel = dados.regras_selecionadas || SEM;
  const resumo = (m) => sel.filter((f) => m[f]).map((f) => `${f} ${m[f]}`).join(' · ') || 'nenhum';
  const nAl = Object.values(contagem.pa).reduce((s, v) => s + v, 0);

  return (
    <div className="w-full space-y-4">
      <div className="flex flex-wrap gap-3">
        <Card titulo="Faturas analisadas" valor={num(dados.faturas_analisadas)} sub={`${num(dados.ucs_analisadas)} UCs · calculado ${dados.gerado_em}`} />
        <Card titulo="Apontamentos (erro)" valor={num(visiveis.filter((a) => (a.fichas || SEM).length).length)} sub={resumo(contagem.pf)} />
        <Card titulo="Alertas" valor={num(nAl)} sub={resumo(contagem.pa)} cor="#d97706" />
        {!ehAcer && <Card titulo="Verificados pelo analista" valor={num(contagem.verif)} sub="F01–F05 conferidos (aba Energia)" cor="#7c6f9c" />}
        <Card titulo="F02 fortes" valor={num(contagem.fortes)} sub="acima do histórico + confirmado" cor="#dc2626" />
        <Card titulo="Estimativa F02" valor={brl(contagem.f02)} sub={ehAcer ? 'valor cheio (100%) do excedente de energia' : 'conferida quando verificado; senão excesso × R$/kWh'} />
        <Card titulo="Outras regras (erro)" valor={brl(contagem.outras)} sub="tarifa/bandeira da ANEEL, CIP…" />
        {contagem.reab > 0 && <Card titulo="Reabertas" valor={num(contagem.reab)} sub="rejeitadas antes, com regra nova apontando" cor="#2b8fd6" />}
      </div>

      <div className="text-[11px] opacity-60">
        Rejeição por regra: a fatura rejeitada não volta pelas regras já rejeitadas; se uma regra nova apontar, ela reaparece
        marcada <b>↩ rejeitada antes</b> com quem rejeitou e quando — decida só sobre o problema novo.
        {!dados.aneel_importado && ' · Tarifas da ANEEL ainda não importadas (⚙ Regras → Atualizar agora).'}
      </div>

      <div className="flex flex-wrap gap-3 items-center text-xs">
        <label className="inline-flex items-center gap-1.5"><span className="opacity-70">Mostrar:</span>
          <select value={origem} onChange={(e) => setOrigem(e.target.value)} className="px-2 py-1 rounded border border-[var(--cpv2-border)] bg-transparent">
            {!ehAcer && <option value="padrao">verificados + regras novas</option>}
            {ehAcer && <option value="todos">motor F02–F05 + regras</option>}
            <option value="novas">só regras do catálogo</option>
            {!ehAcer && admin && <option value="todos">todos do motor (inclui não triados)</option>}
          </select></label>
        <label className="inline-flex items-center gap-1.5"><span className="opacity-70">Regra:</span>
          <select value={ficha} onChange={(e) => setFicha(e.target.value)} className="px-2 py-1 rounded border border-[var(--cpv2-border)] bg-transparent">
            <option value="todas">todas</option>
            {sel.map((f) => <option key={f} value={f}>{f}{FICHA_ROT[f] ? ` — ${FICHA_ROT[f]}` : ''} ({contagem.pf[f] || 0}{contagem.pa[f] ? ` + ${contagem.pa[f]} alertas` : ''})</option>)}
          </select></label>
        {!ehAcer && <label className="inline-flex items-center gap-1.5"><span className="opacity-70">Empresa:</span>
          <select value={empresa} onChange={(e) => setEmpresa(e.target.value)} className="px-2 py-1 rounded border border-[var(--cpv2-border)] bg-transparent max-w-[220px]">
            <option value="todas">todas</option>
            {empresas.map((d) => <option key={d} value={d}>{d}</option>)}
          </select></label>}
        <label className="inline-flex items-center gap-1.5"><span className="opacity-70">Distribuidora:</span>
          <select value={dist} onChange={(e) => setDist(e.target.value)} className="px-2 py-1 rounded border border-[var(--cpv2-border)] bg-transparent max-w-[220px]">
            <option value="todas">todas</option>
            {dists.map((d) => <option key={d} value={d}>{d}</option>)}
          </select></label>
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={soFortes} onChange={(e) => setSoFortes(e.target.checked)} /> só F02 fortes</label>
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={alertas} onChange={(e) => setAlertas(e.target.checked)} /> mostrar alertas</label>
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={soReabertas} onChange={(e) => setSoReabertas(e.target.checked)} /> só reabertas</label>
        <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="buscar empresa, UC ou id"
          className="px-2 py-1 rounded border border-[var(--cpv2-border)] bg-transparent min-w-[200px]" />
        <span className="opacity-70">{linhas.length} linhas · {brl(somaLinhas)}</span>
        <button onClick={() => setRegrasAberto(true)} className="ml-auto px-3 py-1 rounded-md font-semibold text-white"
          style={{ background: B.cor }} title={`Escolher as regras do catálogo aplicadas às ${B.titulo}`}>
          ⚙ Regras ({sel.length})</button>
        <button onClick={exportar} className="px-3 py-1 rounded-md font-semibold border border-[var(--cpv2-border)]">⬇ Excel</button>
        <button onClick={recalcular} className="px-3 py-1 rounded-md font-semibold border border-[var(--cpv2-border)]">↻ Rodar de novo</button>
      </div>

      <div className="overflow-auto border border-[var(--cpv2-border)] rounded-lg">
        <table className="w-full text-xs">
          <thead className="bg-[var(--cpv2-surface)]">
            <tr className="text-left">
              <th className="p-2 w-6" /><th className="p-2">Regra</th><th className="p-2">Empresa</th><th className="p-2">Distribuidora</th>
              <th className="p-2">UC</th><th className="p-2">Mês</th><th className="p-2 text-right">Consumo kWh</th>
              <th className="p-2 text-right">Média kWh</th><th className="p-2 text-right">Desvio</th><th className="p-2">Classificação</th>
              <th className="p-2">Validação</th><th className="p-2 text-right">Estimativa F02</th><th className="p-2 text-right">Outras regras</th>
              <th className="p-2">Fatura</th>
            </tr>
          </thead>
          <tbody>
            {linhas.slice(0, 1500).map((a) => {
              const cl = CLASSIF[a.classificacao_historico];
              const fs = a.fichas || SEM;
              const temF02 = fs.includes('F02');
              const det = [...(a.detalhamento || SEM), ...(a.achados || SEM).map((x) => `${x.codigo} ${x.nivel}: ${x.detalhe}`)];
              return (
                <React.Fragment key={a.id}>
                  <tr onClick={() => setModalFatura({ id: a.id, UC: a.uc, fichas_aplicadas: [...fs, ...(a.alertas || SEM)].join(','),
                      fonte: ehAcer ? 'acer' : undefined, link_fatura: a.link_fatura, numero_instalacao: a.uc })}
                    className="border-t border-[var(--cpv2-border)] cursor-pointer hover:bg-[var(--cpv2-surface)]">
                    <td className="p-2" onClick={(e) => { e.stopPropagation(); setAberta(aberta === a.id ? null : a.id); }}
                      title="ver o detalhe das regras">{aberta === a.id ? '▾' : '▸'}</td>
                    <td className="p-2 font-semibold" title={det.join('\n')}>
                      {fs.join(', ')}{a.forte && <span className="ml-1" title="acima do histórico e confirmado pelas 3 próximas">🔴</span>}
                      {a.verificado && <span className="ml-1 text-[10px] font-normal" style={{ color: '#7c6f9c' }} title={a.observacao || 'verificado pelo analista'}>✔</span>}
                      {(a.alertas || SEM).length > 0 && <span className="ml-1 text-[10px] font-normal" style={{ color: '#d97706' }}>⚠ {a.alertas.join(', ')}</span>}
                      {a.rejeitada && <div className="text-[10px] font-normal" style={{ color: '#2b8fd6' }}>
                        ↩ rejeitada antes por {(a.rejeitada.regras || SEM).join(', ')} ({a.rejeitada.usuario || '—'}, {a.rejeitada.em}) — novo apontamento</div>}
                    </td>
                    <td className="p-2">{a.empresa || a.cod_empresa}</td>
                    <td className="p-2">{a.distribuidora}</td>
                    <td className="p-2">{a.uc}</td>
                    <td className="p-2">{mesBR(a.mes_referencia)}</td>
                    <td className="p-2 text-right">{num(a.consumo_kwh)}</td>
                    <td className="p-2 text-right">{temF02 && a.media_kwh ? num(a.media_kwh) : '—'}</td>
                    <td className="p-2 text-right">{temF02 ? `+${num(a.desvio_pct)}%` : '—'}</td>
                    <td className="p-2" style={{ color: cl?.cor }}>{fs.some((f) => /^F0[1-5]$/.test(f)) ? cl?.rot || a.classificacao_historico || '—' : '—'}</td>
                    <td className="p-2">{temF02 ? VALID[a.f02_validacao] || a.f02_validacao || '—' : '—'}</td>
                    <td className="p-2 text-right font-semibold" title={a.estimativa_auditada ? 'valor conferido pelo analista' : 'excesso de kWh × R$/kWh da fatura'}>
                      {temF02 && a.estimativa_f02 ? `${brl(a.estimativa_f02)}${a.estimativa_auditada ? ' ✔' : ''}` : '—'}</td>
                    <td className="p-2 text-right">{a.valor_outras_regras ? brl(a.valor_outras_regras) : '—'}</td>
                    <td className="p-2" onClick={(e) => e.stopPropagation()}>
                      {a.link_fatura ? <a href={pdfLink(a.link_fatura)} target="_blank" rel="noreferrer" className="text-[var(--accent)]">PDF</a> : '—'}</td>
                  </tr>
                  {aberta === a.id && (
                    <tr><td colSpan={14} className="p-2 bg-[color-mix(in_srgb,var(--fg)_4%,transparent)]">
                      {(a.detalhamento || SEM).map((d, k) => <div key={`d${k}`} className="mb-1">{d}</div>)}
                      {(a.achados || SEM).map((x, k) => (
                        <div key={k} className="mb-1"><b style={{ color: x.nivel === 'ERRO' ? 'var(--danger)' : '#d97706' }}>{x.codigo} {x.nivel === 'ERRO' ? 'erro' : 'alerta'}</b>
                          {' — '}{x.detalhe}{x.valor ? ` · ${brl(x.valor)}` : ''}</div>
                      ))}
                      {a.observacao && <div className="mt-1 opacity-70">Nota do analista: {a.observacao}</div>}
                    </td></tr>
                  )}
                </React.Fragment>
              );
            })}
            {!linhas.length && <tr><td colSpan={14} className="p-4 text-center opacity-60">nenhum apontamento com esses filtros</td></tr>}
          </tbody>
        </table>
        {linhas.length > 1500 && <div className="text-xs opacity-60 p-2">mostrando 1.500 de {num(linhas.length)} — use os filtros ou o Excel</div>}
      </div>

      {modalFatura && (
        <ModalFaturaMontada row={modalFatura} onClose={() => setModalFatura(null)}
          onRejeitado={(id) => setRemovidas((m) => ({ ...m, [String(id ?? modalFatura.id)]: true }))} />
      )}
      {regrasAberto && (
        <RegrasModal conjunto={base} titulo={`Regras aplicadas às ${B.titulo}`} onClose={() => setRegrasAberto(false)}
          onSalvo={() => { setRegrasAberto(false); recalcular(); }} />
      )}
    </div>
  );
}
