// Compara os dados que a IA extraiu na análise (CAMPOS_JSON do v19) com os
// dados do parser (fatura), campo a campo, normalizados para os mesmos nomes e
// apresentados por grupos como o resto da fatura. Marca divergências.
//
// Exporta também mapearDadosIA(dados) → objeto com chaves canônicas da fatura,
// para permitir rodar as mesmas regras/checagens sobre os dados da análise.

import React, { useMemo } from 'react';

// Campos da FDE em formato US (ponto = decimal): Number() direto; só cai pro
// parse BR se não for número válido. Não remover ponto de "2136.16".
const num = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  let n = Number(s);
  if (!Number.isFinite(n)) n = Number(s.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const brl = (v) => v == null ? '—' : `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const nf = (v, d = 0) => v == null ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: d });

// Mapa: campo da IA (CAMPOS_JSON) → campo canônico da fatura + grupo + tipo.
// tipo: money | kwh | num | pct | text
const MAPA = [
  ['Identificação', 'uc', 'codigo_uc', 'text'],
  ['Identificação', 'concessionaria', 'distribuidora', 'text'],
  ['Identificação', 'numero_fatura', 'numero_fatura', 'text'],
  ['Identificação', 'nome_cliente', 'nome_cliente', 'text'],
  ['Identificação', 'modalidade_tarifaria', 'modalidade_tarifaria', 'text'],
  ['Identificação', 'numero_medidor', 'numero_medidor', 'text'],
  ['Identificação', 'dias_faturados', 'dias_faturados', 'num'],
  ['Consumo e medição', 'kwh_total', 'kwh_total', 'kwh'],
  ['Consumo e medição', 'kwh_ponta', 'consumo_ativo_ponta_kwh', 'kwh'],
  ['Consumo e medição', 'kwh_fponta', 'consumo_ativo_fponta_kwh', 'kwh'],
  ['Consumo e medição', 'leitura_anterior_p', 'leit_ant_ativa_ponta', 'num'],
  ['Consumo e medição', 'leitura_atual_p', 'leit_atu_ativa_ponta', 'num'],
  ['Demanda', 'demanda_faturada_ponta_kw', 'demanda_faturada_ponta_kw', 'num'],
  ['Demanda', 'demanda_faturada_fponta_kw', 'demanda_faturada_fponta_kw', 'num'],
  ['Demanda', 'demanda_contratada_ponta_kw', 'demanda_contratada_ponta_kw', 'num'],
  ['Demanda', 'demanda_contratada_fponta_kw', 'demanda_contratada_fponta_kw', 'num'],
  ['Valores e tributos', 'total_rs', 'valor_total_fatura', 'money'],
  ['Valores e tributos', 'total_itens_rs', 'valor_total_itens', 'money'],
  ['Valores e tributos', 'tipo_bandeira', 'tipo_bandeira_tarifaria', 'text'],
  ['Valores e tributos', 'valor_bandeira', 'valor_bandeira_rs', 'money'],
  ['Valores e tributos', 'base_icms_rs', 'icms_base_calculo', 'money'],
  ['Valores e tributos', 'icms_aliq', 'icms_aliquota', 'pct'],
  ['Valores e tributos', 'icms_rs', 'icms_valor', 'money'],
  ['Valores e tributos', 'pis_aliq', 'pis_aliquota', 'pct'],
  ['Valores e tributos', 'pis_rs', 'pis_valor', 'money'],
  ['Valores e tributos', 'cofins_aliq', 'cofins_aliquota', 'pct'],
  ['Valores e tributos', 'cofins_rs', 'cofins_valor', 'money'],
];

// mapearDadosIA: dados da IA → objeto com nomes canônicos da fatura (valores crus).
export function mapearDadosIA(dados) {
  const out = {};
  if (!dados || typeof dados !== 'object') return out;
  for (const [, iaKey, fatKey, tipo] of MAPA) {
    const v = dados[iaKey];
    if (v == null || v === '') continue;
    out[fatKey] = (tipo === 'text') ? v : (num(v) ?? v);
  }
  return out;
}

const fmt = (tipo, v) => {
  if (v == null || v === '') return '—';
  if (tipo === 'money') return brl(num(v));
  if (tipo === 'kwh') return `${nf(num(v))} kWh`;
  if (tipo === 'pct') return `${nf(num(v), 2)}%`;
  if (tipo === 'num') return nf(num(v), 2);
  return String(v);
};

// compara dois valores conforme o tipo. → 'ok' | 'diverge' | 'so_ia' | 'so_parser' | 'na'
const comparar = (tipo, iaVal, fatVal) => {
  const iEmpty = iaVal == null || iaVal === '';
  const fEmpty = fatVal == null || fatVal === '';
  if (iEmpty && fEmpty) return 'na';
  if (iEmpty) return 'so_parser';
  if (fEmpty) return 'so_ia';
  if (tipo === 'text') {
    const norm = (s) => String(s).trim().toUpperCase().replace(/\s+/g, ' ');
    return norm(iaVal) === norm(fatVal) ? 'ok' : 'diverge';
  }
  const a = num(iaVal), b = num(fatVal);
  if (a == null || b == null) return 'diverge';
  if (tipo === 'pct') return Math.abs(a - b) <= 0.1 ? 'ok' : 'diverge';
  const d = Math.max(Math.abs(a), Math.abs(b));
  if (d === 0) return 'ok';
  return (Math.abs(a - b) / d) <= 0.01 ? 'ok' : 'diverge';
};

const STATUS = {
  ok:        { icon: '✓', fg: 'var(--cpv2-success)', txt: 'confere' },
  diverge:   { icon: '⚠️', fg: 'var(--cpv2-danger)',  txt: 'diverge' },
  so_ia:     { icon: '＋', fg: 'var(--cpv2-info)',    txt: 'só na IA' },
  so_parser: { icon: '·', fg: 'var(--cpv2-text-muted)', txt: 'só no parser' },
};

export default function ComparativoIAFatura({ fatura = {}, dados }) {
  const grupos = useMemo(() => {
    if (!dados) return [];
    const porGrupo = {};
    for (const [grupo, iaKey, fatKey, tipo] of MAPA) {
      const iaVal = dados[iaKey];
      const fatVal = fatura[fatKey];
      const st = comparar(tipo, iaVal, fatVal);
      if (st === 'na') continue; // nenhum lado tem valor
      (porGrupo[grupo] = porGrupo[grupo] || []).push({
        label: fatKey.replace(/_/g, ' '),
        iaKey, tipo, iaVal, fatVal, st,
      });
    }
    return Object.entries(porGrupo).map(([titulo, linhas]) => ({ titulo, linhas }));
  }, [fatura, dados]);

  if (!grupos.length) return null;

  const totalDiverge = grupos.reduce((a, g) => a + g.linhas.filter((l) => l.st === 'diverge').length, 0);

  return (
    <div>
      <div style={{ fontSize: 11.5, opacity: 0.7, marginBottom: 8 }}>
        Comparação entre o que o parser extraiu e o que a IA leu na análise.{' '}
        {totalDiverge > 0
          ? <strong style={{ color: 'var(--cpv2-danger)' }}>{totalDiverge} campo(s) divergem — confira no PDF.</strong>
          : <span style={{ color: 'var(--cpv2-success)' }}>Sem divergências relevantes.</span>}
      </div>
      {grupos.map((g) => (
        <div key={g.titulo} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--cpv2-brand)', marginBottom: 4 }}>{g.titulo}</div>
          <div style={{ overflowX: 'auto' }}>
            <table className="cpv2-table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>Campo</th>
                  <th style={{ textAlign: 'right' }}>Parser</th>
                  <th style={{ textAlign: 'right' }}>IA (análise)</th>
                  <th style={{ textAlign: 'center' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {g.linhas.map((l) => {
                  const s = STATUS[l.st] || STATUS.so_parser;
                  return (
                    <tr key={l.iaKey} className="cpv2-row" style={{ cursor: 'default', background: l.st === 'diverge' ? 'color-mix(in srgb, var(--cpv2-danger) 7%, transparent)' : undefined }}>
                      <td style={{ textTransform: 'capitalize' }}>{l.label}</td>
                      <td className="cpv2-num" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(l.tipo, l.fatVal)}</td>
                      <td className="cpv2-num" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(l.tipo, l.iaVal)}</td>
                      <td style={{ textAlign: 'center', color: s.fg, fontWeight: 700 }} title={s.txt}>{s.icon}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
