// "O que observar nesta fatura" — guiado pelas FICHAS DE ERRO apontadas
// (F01–F05). Para cada ficha aplicada, explica o que ela significa e lista, com
// os números reais da fatura, o que conferir. No fim, um bloco de conferências
// gerais (aritmética, SEFAZ, tributos) que apoiam qualquer ficha.
//
// Textos NEUTROS por decisão de produto: não citam cargo nem qualificam quem usa.
// Cada item só aparece quando há dado para computá-lo.

import React, { useMemo } from 'react';

// Os campos da FDE são guardados em formato US (ponto = decimal). Tenta Number()
// direto e só cai pro parse BR (vírgula decimal) se não for número válido — NUNCA
// remover ponto de "2136.16" (isso virava 213616 e inflava tudo ×100).
const num = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  let n = Number(s);
  if (!Number.isFinite(n)) n = Number(s.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const brl = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const nf = (v, d = 0) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: d });
const difPct = (a, b) => (a && b) ? Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) * 100 : null;

const CORES = {
  ok:      { fg: 'var(--cpv2-success)', dot: '🟢' },
  atencao: { fg: 'var(--cpv2-warning)', dot: '🟡' },
  diverge: { fg: 'var(--cpv2-danger)',  dot: '🔴' },
  info:    { fg: 'var(--cpv2-info)',    dot: '🔵' },
};

// Descrição neutra de cada ficha.
const FICHAS_INFO = {
  F01: { titulo: 'F01 · Divergência de leitura', oQueE: 'O consumo faturado não bate com o que a leitura do medidor indica.' },
  F02: { titulo: 'F02 · Desvio de consumo', oQueE: 'O consumo do mês está acima do padrão histórico da unidade.' },
  F03: { titulo: 'F03 · Acúmulo / recuperação (Art. 113)', oQueE: 'Meses no piso seguidos de uma cobrança que acumula o consumo (catch-up).' },
  F04: { titulo: 'F04 · Sinais de medição', oQueE: 'Indícios de irregularidade na medição/faturamento do consumo.' },
  F05: { titulo: 'F05 · Continuidade de leitura', oQueE: 'A leitura final de um mês não emenda com a inicial do mês seguinte.' },
};

export default function ChecklistObservar({ fatura = {}, apont, sinais, valorBandeira, gate, score }) {
  const { fichas, gerais } = useMemo(() => {
    const f = fatura || {};

    // fichas aplicadas (ex.: "F02,F04"); se vazio mas há apontamento de desvio, assume F02.
    let codigos = String(f.fichas_aplicadas || f.fichas || '')
      .toUpperCase().split(/[,;\s]+/).map((s) => s.trim()).filter((s) => /^F0[1-9]$/.test(s));
    if (!codigos.length && apont && apont.desvioPct >= 100) codigos = ['F02'];
    codigos = [...new Set(codigos)];

    const observarPorFicha = (cod) => {
      const itens = [];
      const add = (nivel, texto) => itens.push({ nivel, texto });

      if (cod === 'F01') {
        // (leitura atual − anterior) × constante ≈ consumo faturado (ponta)
        const la = num(f.leit_atu_ativa_ponta), lb = num(f.leit_ant_ativa_ponta);
        const k = num(f.constante_k) || 1;
        const cons = num(f.consumo_ativo_ponta_kwh);
        if (la != null && lb != null && cons != null && cons > 0) {
          const calc = (la - lb) * k;
          const d = difPct(calc, cons);
          const nivel = d == null ? 'info' : d <= 1.5 ? 'ok' : d <= 50 ? 'diverge' : 'atencao';
          add(nivel, `Leitura: (${nf(la)} − ${nf(lb)})${k !== 1 ? ` × ${nf(k, 2)}` : ''} = ${nf(calc)} kWh vs ${nf(cons)} kWh faturado${d != null ? ` (${nf(d, 1)}% de diferença)` : ''}. Diferença acima de 50% costuma ser leitura mal extraída — confira no PDF.`);
        } else {
          add('info', 'Confira se as leituras anterior/atual do medidor batem com o consumo faturado.');
        }
        const cs = num(f.consumo_ativo_sefaz_kwh), kt = num(f.kwh_total);
        if (cs != null && kt != null) {
          const d = difPct(cs, kt);
          add(d != null && d <= 5 ? 'ok' : 'diverge', `SEFAZ registra ${nf(cs)} kWh × ${nf(kt)} kWh na fatura. A NF3e serve de 2ª fonte para o consumo.`);
        }
      }

      if (cod === 'F02') {
        if (apont) {
          const nivel = apont.desvioPct >= 200 ? 'diverge' : apont.desvioPct >= 100 ? 'atencao' : 'info';
          add(nivel, `Consumo ${nf(apont.consumoAtual)} kWh vs média ${nf(apont.media)} kWh (${apont.desvioPct >= 0 ? '+' : ''}${nf(apont.desvioPct, 1)}%). Acima de 200% é pico; 100–200% é desvio alto.`);
          add(apont.baseN >= 3 ? 'ok' : 'atencao', `Base de ${apont.baseN} ${apont.baseN === 1 ? 'mês' : 'meses'} para a média. Menos de 3 meses reduz a confiança do desvio.`);
          add('info', 'Observe no gráfico se o salto é um evento isolado (mais provável ser irregularidade) ou se virou o novo padrão nos meses seguintes (mais provável ser mudança de perfil).');
        }
        if (Number(f.flag_faturamento_media) === 1) {
          add('atencao', 'Esta fatura foi por leitura estimada (não medida). Desvio sobre mês estimado pede cautela.');
        }
      }

      if (cod === 'F03') {
        add('diverge', 'Verifique no histórico uma sequência de meses no piso (ex.: 100/50/30 kWh) logo antes deste pico — indica cobrança acumulada.');
        if (Number(f.flag_acumulo_art113) === 1 || num(f.kwh_acumulado_art113) > 0) {
          add('diverge', `A fatura sinaliza recuperação/parcelamento${num(f.kwh_acumulado_art113) > 0 ? ` (${nf(num(f.kwh_acumulado_art113))} kWh acumulados)` : ''}. Esse valor não é o consumo do mês.`);
        }
        add('info', 'O ressarcimento por desvio não deve incluir a parcela de recuperação de consumo.');
      }

      if (cod === 'F04') {
        const cp = num(f.consumo_ativo_ponta_kwh), cf = num(f.consumo_ativo_fponta_kwh);
        if (cp != null || cf != null) {
          add('info', `Consumo por posto: ponta ${nf(cp || 0)} kWh · fora-ponta ${nf(cf || 0)} kWh. Salto só em um posto sugere mudança operacional; nos dois, possível erro de medição.`);
        }
        const dFat = num(f.demanda_faturada_ponta_kw), dCon = num(f.demanda_contratada_ponta_kw);
        if (dFat != null && dCon != null && dCon > 0) {
          add(dFat / dCon > 1.05 ? 'diverge' : 'ok', `Demanda faturada ${nf(dFat, 2)} kW × contratada ${nf(dCon, 2)} kW. Acima de 5% gera ultrapassagem.`);
        }
        add('info', 'Confira a continuidade das leituras e a constante do medidor.');
      }

      if (cod === 'F05') {
        const lb = num(f.leit_ant_ativa_ponta), la = num(f.leit_atu_ativa_ponta);
        if (lb != null && la != null) {
          add(la >= lb ? 'ok' : 'diverge', `Leitura anterior ${nf(lb)} → atual ${nf(la)}. Leitura atual menor que a anterior (sem virada de medidor) indica descontinuidade.`);
        }
        add('info', 'Compare a leitura inicial desta fatura com a leitura final da fatura do mês anterior — devem emendar.');
      }

      if (!itens.length) add('info', 'Sem dados específicos para conferir automaticamente nesta ficha.');
      return itens;
    };

    const fichas = codigos.map((cod) => ({
      cod,
      info: FICHAS_INFO[cod] || { titulo: cod, oQueE: 'Sinal levantado pelo motor de análise.' },
      itens: observarPorFicha(cod),
    }));

    // ── Conferências gerais (apoiam qualquer ficha) ──
    const gerais = [];
    const g = (nivel, titulo, detalhe) => gerais.push({ nivel, titulo, detalhe });

    const glabel = String(gate || '').toLowerCase();
    const sc = num(score);
    if (glabel || sc != null) {
      let nivel = 'info';
      if (glabel === 'aprovado' && (sc == null || sc >= 70)) nivel = 'ok';
      else if (glabel === 'reprovado' || (sc != null && sc < 50)) nivel = 'diverge';
      else nivel = 'atencao';
      g(nivel, 'Confiança da leitura automática', `${glabel ? glabel.toUpperCase() : 'sem status'}${sc != null ? ` · ${nf(sc)}%` : ''}. Abaixo do ideal, confira os campos no PDF.`);
    }

    const rsKwh = apont?.rsKwh || (num(f.valor_energia_ativa) && num(f.kwh_total) ? num(f.valor_energia_ativa) / num(f.kwh_total) : null);
    if (rsKwh != null && rsKwh > 0) {
      const nivel = (rsKwh < 0.30 || rsKwh > 1.80) ? 'diverge' : (rsKwh < 0.40 || rsKwh > 1.50) ? 'atencao' : 'ok';
      g(nivel, 'Tarifa de energia (R$/kWh)', `${brl(rsKwh)}/kWh (energia ÷ consumo). Fora da faixa usual pode indicar erro de tarifa ou de leitura.`);
    }

    if (sinais?.stTotItens && sinais.stTotItens !== 'na') {
      g(sinais.stTotItens, 'Soma dos itens vs total', `${brl(sinais.totFat)} no total × ${brl(sinais.totItens)} somando os itens.`);
    }
    if (sinais?.stTotSefaz && sinais.stTotSefaz !== 'na') {
      g(sinais.stTotSefaz, 'Total vs SEFAZ', `${brl(sinais.totFat)} na fatura × ${brl(sinais.totSefaz)} na NF3e.`);
    }

    const tributo = (label, base, aliq, valor) => {
      const b = num(base), a = num(aliq), v = num(valor);
      if (b == null || a == null || v == null || b <= 0) return;
      const esperado = b * (a / 100);
      const d = difPct(esperado, v);
      g(d == null ? 'info' : d <= 1 ? 'ok' : d <= 3 ? 'atencao' : 'diverge', `${label} (base × alíquota)`, `${brl(b)} × ${nf(a, 2)}% = ${brl(esperado)}; na fatura ${brl(v)}.`);
    };
    // Só confere base × alíquota quando a base PRÓPRIA do tributo existe. Sem
    // base de PIS/COFINS não dá pra usar a do ICMS (bases diferentes) — pularia.
    tributo('ICMS', f.icms_base_calculo, f.icms_aliquota, f.icms_valor);
    tributo('PIS', f.pis_base_calculo ?? f.base_pis_cofins_rs, f.pis_aliquota, f.pis_valor);
    tributo('COFINS', f.cofins_base_calculo ?? f.base_pis_cofins_rs, f.cofins_aliquota, f.cofins_valor);

    return { fichas, gerais };
  }, [fatura, apont, sinais, valorBandeira, gate, score]);

  if (!fichas.length && !gerais.length) return null;

  const Item = ({ nivel, children }) => {
    const c = CORES[nivel] || CORES.info;
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5 }}>
        <span aria-hidden="true" style={{ lineHeight: '18px' }}>{c.dot}</span>
        <div style={{ color: 'var(--cpv2-text)' }}>{children}</div>
      </div>
    );
  };

  return (
    <div style={{
      marginTop: 10, padding: '10px 12px', borderRadius: 8,
      background: 'var(--cpv2-surface-2)', border: '1px solid var(--cpv2-border)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--cpv2-brand)', marginBottom: 8 }}>
        O que observar nesta fatura
      </div>

      {fichas.map((fk) => (
        <div key={fk.cod} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{fk.info.titulo}</div>
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 5 }}>{fk.info.oQueE}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {fk.itens.map((it, i) => <Item key={i} nivel={it.nivel}>{it.texto}</Item>)}
          </div>
        </div>
      ))}

      {gerais.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.75, marginBottom: 5, marginTop: fichas.length ? 4 : 0 }}>Conferências gerais</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {gerais.map((c, i) => (
              <Item key={i} nivel={c.nivel}>
                <span style={{ fontWeight: 600, color: (CORES[c.nivel] || CORES.info).fg }}>{c.titulo}</span>
                <span style={{ opacity: 0.85 }}> — {c.detalhe}</span>
              </Item>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 8, fontSize: 10.5, opacity: 0.55 }}>
        Conferências automáticas a partir dos dados extraídos. Servem de apoio — a decisão é sempre da análise.
      </div>
    </div>
  );
}
