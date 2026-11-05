import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import apiClient from '../services/apiClient';
import ModalFaturaMontada from './ModalFaturaMontada';
import { RegrasModal } from './UsinasPanel';
import { abrirDossie } from './dossieApontamento';

// ⚡ Aba ENERGIA da Auditoria de Faturas no formato da aba Usinas (FATURA_DADOS_EXTRAIDOS).
// Backend: GET /api/v1/energia/apontamentos — motor F01–F05 + regras do botão ⚙ Regras (conjunto "energia":
// tarifa/bandeira homologada da ANEEL e CIP comparada entre UCs) + rejeição POR REGRA. Lê ~160 mil faturas:
// o cálculo roda em segundo plano e a tela consulta até ficar pronto.
// A tela mostra exatamente o que as regras MARCADAS no botão Regras acharam (o motor F01–F05 só se marcado) —
// uma linha por fatura: regras com erro, com alerta, o resumo do que foi encontrado e o valor envolvido.
// Clique na linha: abre a fatura completa (mesmo modal da lista antiga — rejeitar, encaminhar, requisição).

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = (v, d = 0) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: d });
const mesBR = (m) => (m && m.length >= 7 ? `${m.slice(5, 7)}/${m.slice(0, 4)}` : m || '—');
const pdfLink = (l) => String(l || '').replace(/\.json$/i, '');
const SEM = [];

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

// valor do apontamento: achados com ERRO + a estimativa do F02 quando ele apontou
const valorAp = (a) => (a.valor_outras_regras || 0) + ((a.fichas || SEM).includes('F02') ? a.estimativa_f02 || 0 : 0);
// resumo legível: o primeiro achado (erro antes de alerta) ou o detalhamento do motor
const resumoAp = (a) => {
  const ach = [...(a.achados || SEM)].sort((x, y) => (x.nivel === 'ERRO' ? 0 : 1) - (y.nivel === 'ERRO' ? 0 : 1));
  if (ach.length) return `${ach[0].codigo}: ${ach[0].detalhe}`;
  return (a.detalhamento || SEM)[0] || '';
};

export default function EnergiaPanel({ base = 'energia' }) {
  const B = BASES[base] || BASES.energia;
  const ehAcer = base === 'acer';
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [calculando, setCalculando] = useState(false);
  const [tentativa, setTentativa] = useState(0);
  const [ficha, setFicha] = useState('todas');
  const [nivel, setNivel] = useState('todos'); // todos | erro | alerta
  const [empresa, setEmpresa] = useState('todas');
  const [dist, setDist] = useState('todas');
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

  // tudo o que as regras SELECIONADAS acharam (o backend já aplica só as marcadas no botão Regras)
  const aps = useMemo(() => (dados?.apontamentos || SEM).filter((a) => !removidas[a.id]
    && ((a.fichas || SEM).length > 0 || (a.alertas || SEM).length > 0)), [dados, removidas]);
  const empresas = useMemo(() => [...new Set(aps.map((a) => a.empresa || String(a.cod_empresa)))].sort(), [aps]);
  const dists = useMemo(() => [...new Set(aps.map((a) => a.distribuidora))].sort(), [aps]);
  const linhas = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return aps.filter((a) => {
      const fs = a.fichas || SEM;
      const al = a.alertas || SEM;
      if (nivel === 'erro' && !fs.length) return false;
      if (nivel === 'alerta' && !al.length) return false;
      if (ficha !== 'todas' && !fs.includes(ficha) && !al.includes(ficha)) return false;
      return (empresa === 'todas' || (a.empresa || String(a.cod_empresa)) === empresa)
        && (dist === 'todas' || a.distribuidora === dist)
        && (!soReabertas || a.rejeitada)
        && (!q || `${a.empresa} ${a.uc} ${a.distribuidora} ${a.id}`.toLowerCase().includes(q));
    }).sort((x, y) => valorAp(y) - valorAp(x) || ((y.fichas || SEM).length - (x.fichas || SEM).length));
  }, [aps, ficha, nivel, empresa, dist, soReabertas, busca]);
  const contagem = useMemo(() => {
    const pf = {}; const pa = {};
    let nErro = 0; let nAlerta = 0; let valor = 0; let reab = 0;
    aps.forEach((a) => {
      const fs = a.fichas || SEM;
      fs.forEach((f) => { pf[f] = (pf[f] || 0) + 1; });
      (a.alertas || SEM).forEach((f) => { pa[f] = (pa[f] || 0) + 1; });
      if (fs.length) nErro += 1; else nAlerta += 1;
      valor += valorAp(a);
      if (a.rejeitada && fs.length) reab += 1;
    });
    return { pf, pa, nErro, nAlerta, valor, reab };
  }, [aps]);
  const somaLinhas = useMemo(() => linhas.reduce((s, a) => s + valorAp(a), 0), [linhas]);

  const exportar = () => {
    const ws = XLSX.utils.json_to_sheet(linhas.map((a) => ({
      'Regras (erro)': (a.fichas || SEM).join(','), 'Regras (alerta)': (a.alertas || SEM).join(','), Empresa: a.empresa,
      'Cód. empresa': a.cod_empresa, Distribuidora: a.distribuidora, UC: a.uc, 'Mês ref.': mesBR(a.mes_referencia),
      'Valor envolvido (erros)': valorAp(a) || null,
      'Rejeitada antes': a.rejeitada ? `${(a.rejeitada.regras || SEM).join(',')} (${a.rejeitada.usuario}, ${a.rejeitada.em})` : '',
      'O que foi encontrado': [...(a.achados || SEM).map((x) => `${x.codigo} ${x.nivel}: ${x.detalhe}`), ...(a.detalhamento || SEM)].join(' | '),
      Fatura: pdfLink(a.link_fatura), id: a.id,
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
  const comAlgo = sel.filter((f) => contagem.pf[f] || contagem.pa[f]);

  return (
    <div className="w-full space-y-4">
      <div className="flex flex-wrap gap-3">
        <Card titulo="Faturas analisadas" valor={num(dados.faturas_analisadas)} sub={`${num(dados.ucs_analisadas)} UCs · calculado ${dados.gerado_em}`} />
        <Card titulo="Regras aplicadas" valor={num(sel.length)} sub="as marcadas no botão Regras" />
        <Card titulo="Faturas com erro" valor={num(contagem.nErro)} sub="a regra se confirmou com os números da fatura" cor="#dc2626" />
        <Card titulo="Faturas só com alerta" valor={num(contagem.nAlerta)} sub="indício — conferir na fatura" cor="#d97706" />
        <Card titulo="Valor envolvido (erros)" valor={brl(contagem.valor)} sub="soma do que as regras com erro calcularam" />
        {contagem.reab > 0 && <Card titulo="Reabertas" valor={num(contagem.reab)} sub="rejeitadas antes, com regra nova apontando" cor="#2b8fd6" />}
      </div>

      <div className="text-[11px] opacity-60">
        Aparecem só as regras marcadas no botão ⚙ Regras. Rejeição por regra: a fatura rejeitada não volta pelas regras já rejeitadas;
        se outra regra apontar, ela reaparece marcada <b>↩ rejeitada antes</b> — decida só sobre o problema novo.
        {!dados.aneel_importado && ' · Tarifas da ANEEL ainda não importadas (⚙ Regras → Atualizar agora).'}
      </div>
      {erro && <div className="text-xs text-[var(--danger)]">{erro}</div>}

      <div className="flex flex-wrap gap-2 text-[11px]">
        {comAlgo.length === 0 && <span className="opacity-60">Nenhuma das regras selecionadas apontou nada.</span>}
        {comAlgo.map((f) => (
          <button key={f} type="button" onClick={() => setFicha(ficha === f ? 'todas' : f)}
            className={`px-2 py-0.5 rounded-full border ${ficha === f ? 'border-[var(--accent)] font-semibold' : 'border-[var(--cpv2-border)]'}`}>
            {f}{FICHA_ROT[f] ? ` · ${FICHA_ROT[f]}` : ''}
            {contagem.pf[f] ? <span style={{ color: '#dc2626' }}> · {contagem.pf[f]} erro</span> : null}
            {contagem.pa[f] ? <span style={{ color: '#d97706' }}> · {contagem.pa[f]} alerta</span> : null}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 items-center text-xs">
        <label className="inline-flex items-center gap-1.5"><span className="opacity-70">Regra:</span>
          <select value={ficha} onChange={(e) => setFicha(e.target.value)} className="px-2 py-1 rounded border border-[var(--cpv2-border)] bg-transparent">
            <option value="todas">todas</option>
            {sel.map((f) => <option key={f} value={f}>{f}{FICHA_ROT[f] ? ` — ${FICHA_ROT[f]}` : ''} ({contagem.pf[f] || 0} erro{contagem.pa[f] ? ` + ${contagem.pa[f]} alerta` : ''})</option>)}
          </select></label>
        <label className="inline-flex items-center gap-1.5"><span className="opacity-70">Nível:</span>
          <select value={nivel} onChange={(e) => setNivel(e.target.value)} className="px-2 py-1 rounded border border-[var(--cpv2-border)] bg-transparent">
            <option value="todos">erro e alerta</option>
            <option value="erro">só erro</option>
            <option value="alerta">só alerta</option>
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
          <input type="checkbox" checked={soReabertas} onChange={(e) => setSoReabertas(e.target.checked)} /> só reabertas</label>
        <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="buscar empresa, UC ou id"
          className="px-2 py-1 rounded border border-[var(--cpv2-border)] bg-transparent min-w-[200px]" />
        <span className="opacity-70">{num(linhas.length)} faturas · {brl(somaLinhas)}</span>
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
              <th className="p-2 w-6" /><th className="p-2">Erro</th><th className="p-2">Alerta</th><th className="p-2">Empresa</th>
              <th className="p-2">Distribuidora</th><th className="p-2">UC</th><th className="p-2">Mês</th>
              <th className="p-2">O que foi encontrado</th><th className="p-2 text-right">Valor envolvido</th><th className="p-2">Fatura</th>
            </tr>
          </thead>
          <tbody>
            {linhas.slice(0, 1500).map((a) => {
              const fs = a.fichas || SEM;
              const v = valorAp(a);
              const det = [...(a.achados || SEM).map((x) => `${x.codigo} (${x.nivel}): ${x.detalhe}`), ...(a.detalhamento || SEM)];
              return (
                <React.Fragment key={a.id}>
                  <tr onClick={() => setModalFatura({ id: a.id, UC: a.uc, fichas_aplicadas: [...fs, ...(a.alertas || SEM)].join(','),
                      fonte: ehAcer ? 'acer' : undefined, link_fatura: a.link_fatura, numero_instalacao: a.uc, dossie_base: base })}
                    className="border-t border-[var(--cpv2-border)] cursor-pointer hover:bg-[var(--cpv2-surface)] align-top">
                    <td className="p-2" onClick={(e) => { e.stopPropagation(); setAberta(aberta === a.id ? null : a.id); }}
                      title="ver o detalhe das regras">{aberta === a.id ? '▾' : '▸'}</td>
                    <td className="p-2 font-semibold" style={{ color: '#dc2626' }}>{fs.join(', ') || '—'}
                      {a.rejeitada && <div className="text-[10px] font-normal" style={{ color: '#2b8fd6' }}>
                        ↩ rejeitada antes por {(a.rejeitada.regras || SEM).join(', ')} ({a.rejeitada.usuario || '—'}, {a.rejeitada.em})</div>}
                    </td>
                    <td className="p-2" style={{ color: '#d97706' }}>{(a.alertas || SEM).join(', ') || '—'}</td>
                    <td className="p-2">{a.empresa || a.cod_empresa}</td>
                    <td className="p-2">{a.distribuidora}</td>
                    <td className="p-2">{a.uc}</td>
                    <td className="p-2">{mesBR(a.mes_referencia)}</td>
                    <td className="p-2 max-w-[520px]" title={det.join('\n')}><div className="line-clamp-2">{resumoAp(a)}</div></td>
                    <td className="p-2 text-right font-semibold">{v ? brl(v) : '—'}</td>
                    <td className="p-2 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      {a.link_fatura ? <a href={pdfLink(a.link_fatura)} target="_blank" rel="noreferrer" className="text-[var(--accent)]">PDF</a> : '—'}
                      <button type="button" className="ml-2 text-[var(--accent)]" title="Dossiê do apontamento (PDF): explica cada regra, a tese, como foi aplicada, a conta e a fatura com os valores marcados"
                        onClick={async () => { const m = await abrirDossie(base, a.id); if (m) setErro(m); }}>📑 Dossiê</button></td>
                  </tr>
                  {aberta === a.id && (
                    <tr><td colSpan={10} className="p-2 bg-[color-mix(in_srgb,var(--fg)_4%,transparent)]">
                      {(a.achados || SEM).map((x, k) => (
                        <div key={k} className="mb-1"><b style={{ color: x.nivel === 'ERRO' ? 'var(--danger)' : '#d97706' }}>{x.codigo} {x.nivel === 'ERRO' ? 'erro' : 'alerta'}</b>
                          {' — '}{x.detalhe}{x.valor ? ` · ${brl(x.valor)}` : ''}</div>
                      ))}
                      {(a.detalhamento || SEM).map((d, k) => <div key={`d${k}`} className="mb-1">{d}</div>)}
                      {(a.fichas || SEM).includes('F02') && a.estimativa_f02 > 0 && (
                        <div className="mb-1">F02: consumo {num(a.consumo_kwh)} kWh × média {num(a.media_kwh)} kWh → excesso {num(a.excesso_kwh)} kWh
                          {a.preco_kwh ? ` × ${brl(a.preco_kwh)}/kWh` : ''} = <b>{brl(a.estimativa_f02)}</b>{a.estimativa_auditada ? ' (conferido pelo analista)' : ''}</div>
                      )}
                      {a.observacao && <div className="mt-1 opacity-70">Nota do analista: {a.observacao}</div>}
                    </td></tr>
                  )}
                </React.Fragment>
              );
            })}
            {!linhas.length && <tr><td colSpan={10} className="p-4 text-center opacity-60">nenhum apontamento com esses filtros</td></tr>}
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
