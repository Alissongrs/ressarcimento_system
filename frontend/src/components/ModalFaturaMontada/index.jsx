// src/components/ModalFaturaMontada/index.jsx
//
// Modal "Fatura montada" — aberto ao clicar num apontamento da Auditoria de
// Faturas (AnaliseDesvio.jsx). Substitui a antiga expansão inline (LinhaExpandida).
//
// Conteúdo (topo → base):
//   1. Gráfico de barras do consumo mensal (reaproveita `dadosGrafico`/recharts)
//   2. Dropdown "📄 Abrir fatura de um mês" + botão "Abrir fatura (PDF)"
//   3. Tabela de meses da UC (sem coluna "Resultado IA")
//   4. Seções da "fatura montada" (todos os campos capturados), agrupadas em
//      blocos chave-valor — replica gerar_html_completo.py::card(): Identificação,
//      Período & Medição, Tributos & Totais, GD/Compensação, Fiscal NF3e+SEFAZ,
//      Qualidade/Extração, Itens da fatura, Histórico de consumo.
//
// Estética: linguagem visual do "Controle de Processos" (classes cpv2-* globais,
// carregadas via controleProcessosV2.css importado por aquela página). O modal é
// envolto num .cpv2-root pra herdar as variáveis de tema (--cpv2-*).
//
// Fontes de dado (via apiClient, mesmo padrão do AnaliseDesvio):
//   GET /api/v1/faturas/fde-analise?id={id}&limit=1  → arr[0] (todos os campos)
//   GET /api/v1/faturas/fde-uc-historico?uc={uc}     → série mensal
//
// Campos podem vir CamelCase/compat (Mes_Ref, RS_Total_Fatura, Concessionaria)
// OU snake — sempre com fallback, mostrando "—" quando vazio.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, Cell, ReferenceArea, ReferenceLine,
} from 'recharts';
import { X, Pencil } from 'lucide-react';
import apiClient from '../../services/apiClient';
import ModalCorrigirDadosFatura from '../ModalCorrigirDadosFatura';
import ModalAuditoriaComparativa from '../ModalAuditoriaComparativa';
import ChecklistObservar from './ChecklistObservar';
import ComparativoIAFatura, { mapearDadosIA } from './ComparativoIAFatura';

/* ── helpers de formatação (BR) ───────────────────────────────────────────── */

const isEmpty = (v) =>
  v === null || v === undefined || v === '' ||
  (typeof v === 'string' && v.trim() === '');

const first = (...vals) => {
  for (const v of vals) if (!isEmpty(v)) return v;
  return null;
};

const brNum = (v, dec = 2) => {
  const n = Number(v);
  if (v == null || v === '' || Number.isNaN(n)) return null;
  return n.toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
};

// número tolerante: devolve Number finito ou null
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const money = (v) => {
  const s = brNum(v, 2);
  return s == null ? null : `R$ ${s}`;
};

const kwh = (v) => {
  const s = brNum(v, 2);
  return s == null ? null : `${s} kWh`;
};

const kw = (v) => {
  const s = brNum(v, 2);
  return s == null ? null : `${s} kW`;
};

const pct = (v) => {
  const s = brNum(v, 2);
  return s == null ? null : `${s} %`;
};

const fmtMesRef = (v) => {
  if (v == null) return '—';
  const s = String(v).trim();
  if (!s) return '—';
  // AAAA-MM (ISO, tolera dia/hora/sufixo) — checa antes pra não confundir com MM/AAAA
  let m = s.match(/^(\d{4})-(\d{1,2})/);
  if (m) return `${m[2].padStart(2, '0')}/${m[1]}`;
  // MM/AAAA — tolera lixo depois do ano (ex.: "04/20250" → "04/2025")
  m = s.match(/^(\d{1,2})\/(\d{4})/);
  if (m) return `${m[1].padStart(2, '0')}/${m[2]}`;
  return s;
};

// Formata data BR (dd/mm/aaaa). Extrai Y-M-D por regex pra NÃO sofrer com fuso
// (ex.: "2024-10-11T00:00:00-03:00" → "11/10/2024"). Aceita ISO, "AAAA-MM-DD",
// "AAAA-MM-DD HH:MM:SS" e já-BR. Devolve null quando vazio.
const fmtData = (v) => {
  if (isEmpty(v)) return null;
  const s = String(v).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[1]}/${br[2]}/${br[3]}`;
  return s;
};

const fmtCurrency = (v) => {
  const n = Number(v);
  if (v == null || v === '' || Number.isNaN(n)) return '—';
  return `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

// parse tolerante de JSON (string ou já-objeto)
const loadJ = (v) => {
  if (v == null) return null;
  if (Array.isArray(v) || typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
};

// Detecta linha de bandeira nos itens: "Adic. B. Amarela", "AD.B.VERM2",
// "Adic. Bandeira Vermelha", "Bandeira Amarela", etc.
const ehItemBandeira = (desc) => {
  const s = String(desc || '').toLowerCase();
  return /bandeira/.test(s)
    || /ad(ic)?\.?\s*b\.?\s*(amarel|verm|verd)/.test(s)
    || /\bad\.?\s*b\.?/.test(s);
};

// Mapa ficha → tipo/subtipo de irregularidade (DM_TIPO/DM_SUBTIPO) — espelha
// AnaliseDesvio.jsx, usado pra pré-selecionar os dropdowns da requisição.
const FICHA_PARA_IRREGULARIDADE = {
  F01: { id_tipo: 7, id_subtipo: 11 },
  F02: { id_tipo: 3, id_subtipo: 5 },
  F03: { id_tipo: 5, id_subtipo: 12 },
  F04: { id_tipo: 7, id_subtipo: 20 },
  F05: { id_tipo: 7, id_subtipo: 29 },
};
const IRREGULARIDADE_DEFAULT = { id_tipo: 5, id_subtipo: 14 };

/* ── blocos visuais (cpv2-*) ──────────────────────────────────────────────── */

// Uma célula chave-valor no grid de detalhes.
function Detail({ label, value, big = false }) {
  const show = isEmpty(value) ? '—' : value;
  const cls = `cpv2-detail__value${big ? ' big' : ''}${isEmpty(value) ? ' muted' : ''}`;
  return (
    <div className="cpv2-detail">
      <div className="cpv2-detail__label">{label}</div>
      <div className={cls} title={typeof show === 'string' ? show : undefined}>{show}</div>
    </div>
  );
}

// Campo editável do painel de requisição.
function ReqCampo({ label, value, onChange, full }) {
  return (
    <div style={full ? { gridColumn: '1 / -1' } : undefined}>
      <div className="cpv2-detail__label">{label}</div>
      <input value={value ?? ''} onChange={onChange}
        style={{ width: '100%', padding: '6px 9px', fontSize: 12.5, border: '1px solid var(--cpv2-border)',
          borderRadius: 6, background: 'var(--cpv2-surface)', color: 'var(--cpv2-text)' }} />
    </div>
  );
}

// Uma seção = título + grid de N colunas. Só renderiza se tiver ao menos 1 par
// com valor (evita blocos inteiros vazios, como o card() do gerar_html faz).
function Secao({ titulo, pares, cols = 2, sempre = false }) {
  const preenchidos = pares.filter((p) => !isEmpty(p.value));
  if (!sempre && preenchidos.length === 0) return null;
  return (
    <>
      <div className="cpv2-section-title">{titulo}</div>
      <div className={`cpv2-detail-grid${cols === 3 ? ' cpv2-detail-grid--3' : ''}`}>
        {pares.map((p) => (
          <Detail key={p.label} label={p.label} value={p.value} big={p.big} />
        ))}
      </div>
    </>
  );
}

/* ── tabelas (itens / histórico) ──────────────────────────────────────────── */

function TabelaItens({ itens }) {
  const arr = loadJ(itens);
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const linhas = arr.slice(0, 30);
  return (
    <>
      <div className="cpv2-section-title">Itens da fatura ({arr.length})</div>
      <div style={{ overflowX: 'auto', marginBottom: 18 }}>
        <table className="cpv2-table" style={{ fontSize: '11.5px' }}>
          <thead>
            <tr>
              <th>Descrição</th>
              <th style={{ textAlign: 'right' }}>Qtd</th>
              <th style={{ textAlign: 'right' }}>Valor</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((it, i) => {
              if (!it || typeof it !== 'object') return null;
              const desc = first(it.descricao, it.posto) || '—';
              let q = first(it.quantidade_numerica, it.quantidade_string);
              q = (typeof q === 'number') ? brNum(q, 2) : (q || '—');
              const vNum = it.valor_brl_numerico;
              const vStr = it.valor_brl_string;
              let vDisp;
              if (vNum != null && Math.abs(Number(vNum)) > 1_000_000 && vStr) vDisp = vStr;
              else vDisp = vNum != null ? brNum(vNum, 2) : (vStr || '—');
              return (
                <tr key={i} className="cpv2-row" style={{ cursor: 'default' }}>
                  <td>{desc}{it.eh_credito_gd ? ' 🟢GD' : ''}</td>
                  <td className="cpv2-num" style={{ fontVariantNumeric: 'tabular-nums' }}>{q}</td>
                  <td className="cpv2-num" style={{ fontVariantNumeric: 'tabular-nums' }}>{vDisp}</td>
                </tr>
              );
            })}
            {arr.length > 30 && (
              <tr><td colSpan={3} className="cpv2-muted-sm" style={{ textAlign: 'center' }}>(+{arr.length - 30} itens)</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// Fonte do histórico: 12_meses limpo → raw regex_v3.v2.historico_13m → json detalhe.
function fonteHistorico(r) {
  const m12 = r.historico_consumo_12_meses;
  if (Array.isArray(m12) && m12.length) return m12;
  const j12 = loadJ(m12);
  if (Array.isArray(j12) && j12.length) return j12;
  const raw = loadJ(r.extracao_raw_json);
  if (raw) {
    const h = raw?.regex_v3?.v2?.historico_13m_consumo;
    if (Array.isArray(h) && h.length) return h;
  }
  return loadJ(r.historico_consumo_json);
}

const MESES_ABREV = { 1: 'JAN', 2: 'FEV', 3: 'MAR', 4: 'ABR', 5: 'MAI', 6: 'JUN',
  7: 'JUL', 8: 'AGO', 9: 'SET', 10: 'OUT', 11: 'NOV', 12: 'DEZ' };

// Normaliza um item do histórico para {rotulo, ponta, fponta, reservado, total, dias}.
// Aceita as duas convenções do pipeline:
//   - Grupo B convencional:  { kwh } ou { consumo_kwh }
//   - Grupo A / Branca:      { consumo_ponta_kwh, consumo_fponta_kwh, consumo_reservado_kwh }
//   - Equatorial (variante): consumo_fora_ponta_kwh no lugar de consumo_fponta_kwh; consumo_kwh já vem somado.
function normalizarItemHistorico(it) {
  if (!it || typeof it !== 'object') return null;
  let mes = it.mes;
  // ano SEMPRE com 4 dígitos — alguns itens do histórico vêm com dígito extra
  // (ex.: "20210"), gerando rótulos "12/20210". Mantém só os 4 primeiros dígitos.
  const ano = String(it.ano ?? '').replace(/\D/g, '').slice(0, 4);
  if (typeof mes === 'number') mes = MESES_ABREV[mes] || mes;
  const rotulo = (mes && ano) ? `${mes}/${ano}` : (mes || ano || '—');

  const num = (v) => (v == null || v === '' ? null : Number(v));
  const ponta      = num(it.consumo_ponta_kwh);
  const fponta     = num(it.consumo_fponta_kwh ?? it.consumo_fora_ponta_kwh);
  const reservado  = num(it.consumo_reservado_kwh);
  const totalCru   = num(it.consumo_kwh ?? it.kwh);

  // Se ponta==fponta e ambos batem com o total, é o bug Grupo B dobrado
  // (extrator gravou o mesmo consumo em ambos). Descarta o fponta pra evitar dobra.
  let pontaLimpo = ponta;
  let fpontaLimpo = fponta;
  if (
    pontaLimpo != null && fpontaLimpo != null &&
    pontaLimpo > 0 && pontaLimpo === fpontaLimpo &&
    totalCru != null && Math.abs(pontaLimpo - totalCru) < 1
  ) {
    fpontaLimpo = null;
  }

  const somaPostos =
    (pontaLimpo || 0) + (fpontaLimpo || 0) + (reservado || 0);
  const total = totalCru != null && totalCru > 0 ? totalCru : (somaPostos > 0 ? somaPostos : null);

  const dias = it.dias ?? it.num_dias ?? null;
  return { rotulo, ponta: pontaLimpo, fponta: fpontaLimpo, reservado, total, dias };
}

function TabelaHistoricoConsumo({ fatura }) {
  const j = fonteHistorico(fatura);
  if (!Array.isArray(j) || j.length === 0) return null;
  const rows = [];
  for (const it of j.slice(0, 14)) {
    const nr = normalizarItemHistorico(it);
    if (nr) rows.push(nr);
  }
  if (rows.length === 0) return null;

  // Colunas visíveis: só mostra Ponta / Fora-Ponta / Reservado se houver ao menos
  // um mês com valor > 0 naquele posto. Evita coluna vazia em faturas Grupo B.
  const temPonta     = rows.some((r) => (r.ponta ?? 0) > 0);
  const temFponta    = rows.some((r) => (r.fponta ?? 0) > 0);
  const temReservado = rows.some((r) => (r.reservado ?? 0) > 0);
  const temTotal     = rows.some((r) => (r.total ?? 0) > 0);
  const temDias      = rows.some((r) => r.dias != null);
  const postosSepara = (Number(temPonta) + Number(temFponta) + Number(temReservado)) >= 2;

  const num = (v) => (v == null ? '—' : brNum(v, 2));

  return (
    <>
      <div className="cpv2-section-title">Histórico de consumo</div>
      <div style={{ overflowX: 'auto', marginBottom: 18 }}>
        <table className="cpv2-table" style={{ fontSize: '11.5px' }}>
          <thead>
            <tr>
              <th>Mês</th>
              {temPonta &&     <th style={{ textAlign: 'right' }}>Ponta (kWh)</th>}
              {temFponta &&    <th style={{ textAlign: 'right' }}>Fora-Ponta (kWh)</th>}
              {temReservado && <th style={{ textAlign: 'right' }}>Reservado (kWh)</th>}
              {(temTotal || postosSepara) && <th style={{ textAlign: 'right' }}>Total (kWh)</th>}
              {temDias &&      <th style={{ textAlign: 'right' }}>Dias</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="cpv2-row" style={{ cursor: 'default' }}>
                <td className="cpv2-mono">{r.rotulo}</td>
                {temPonta &&     <td className="cpv2-num" style={{ fontVariantNumeric: 'tabular-nums' }}>{num(r.ponta)}</td>}
                {temFponta &&    <td className="cpv2-num" style={{ fontVariantNumeric: 'tabular-nums' }}>{num(r.fponta)}</td>}
                {temReservado && <td className="cpv2-num" style={{ fontVariantNumeric: 'tabular-nums' }}>{num(r.reservado)}</td>}
                {(temTotal || postosSepara) && <td className="cpv2-num" style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{num(r.total)}</td>}
                {temDias &&      <td className="cpv2-num">{r.dias ?? '—'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ── chip de gate (aprovado / revisão / reprovado) ────────────────────────── */

function GateChip({ gate }) {
  const g = String(gate || '').toLowerCase();
  const cls = g === 'aprovado' ? 'cpv2-chip--aprov'
    : g === 'reprovado' ? 'cpv2-chip--reprov'
    : g === 'revisao' ? 'cpv2-chip cpv2-chip--warning'
    : 'cpv2-chip cpv2-chip--neutral';
  return (
    <span className={`cpv2-chip cpv2-chip--lg ${cls}`}>
      {(gate || '—').toString().toUpperCase()}
    </span>
  );
}

/* ── apresentação estruturada do JSON do v19 ──────────────────────────────── */

// Grupos temáticos (ordem de exibição). Campos fora desses grupos caem em "Outros".
const V19_GRUPOS = [
  { titulo: 'Identificação', keys: ['concessionaria', 'uc', 'mes_ref', 'numero_fatura', 'nome_cliente', 'dias_faturados', 'modalidade_tarifaria', 'tensao_fornecimento', 'numero_medidor', 'mercado_livre_acl'] },
  { titulo: 'Consumo e medição', keys: ['kwh_total', 'kwh_ponta', 'kwh_fponta', 'consumo_medidor_ponta', 'consumo_medidor_fponta', 'leitura_anterior_p', 'leitura_atual_p', 'constante_p', 'leitura_anterior_fp', 'leitura_atual_fp', 'constante_fp', 'perda_transformacao_pct'] },
  { titulo: 'Demanda', keys: ['demanda_faturada_ponta_kw', 'demanda_faturada_fponta_kw', 'demanda_contratada_ponta_kw', 'demanda_contratada_fponta_kw', 'tarifa_demanda', 'valor_demanda', 'ultrapassagem_demanda_pct'] },
  { titulo: 'Valores e tributos', keys: ['total_rs', 'total_itens_rs', 'tipo_bandeira', 'valor_bandeira', 'base_icms_rs', 'icms_aliq', 'icms_rs', 'base_pis_cofins_rs', 'pis_aliq', 'pis_rs', 'cofins_aliq', 'cofins_rs', 'cip_rs', 'reativo_excedente_rs'] },
  { titulo: 'Aritmética / conferência', keys: ['aritmetica_ok', 'aritmetica_fonte_preferida', 'aritmetica_total_calculado_rs', 'aritmetica_diff_pct', 'creditos_recebidos_rs', 'encargos_contestaveis_rs'] },
];

const humanizeKeyV19 = (k) =>
  String(k)
    .replace(/_/g, ' ')
    .replace(/\brs\b/gi, 'R$')
    .replace(/\bpct\b/gi, '%')
    .replace(/\bkwh\b/gi, 'kWh')
    .replace(/\bkw\b/gi, 'kW')
    .replace(/\buc\b/gi, 'UC')
    .replace(/^./, (c) => c.toUpperCase());

const v19Vazio = (v) =>
  v == null || v === '' || (Array.isArray(v) && v.length === 0) || v === false;

const fmtValorV19 = (k, v) => {
  const kl = String(k).toLowerCase();
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  if (typeof v === 'number') {
    if (/(_rs$|valor|total|_estimado)/.test(kl)) return fmtCurrency(v);
    if (/pct|aliq|percentual/.test(kl)) return `${v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
    return v.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
  }
  return String(v);
};

function V19Grid({ entries }) {
  if (!entries.length) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8 }}>
      {entries.map(([k, v]) => (
        <div key={k} style={{ background: 'var(--cpv2-surface)', border: '1px solid var(--cpv2-border)', borderRadius: 6, padding: '6px 9px' }}>
          <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.3, color: 'var(--cpv2-text-muted)' }}>{humanizeKeyV19(k)}</div>
          <div style={{ fontSize: 13, fontWeight: 600, wordBreak: 'break-word' }}>{fmtValorV19(k, v)}</div>
        </div>
      ))}
    </div>
  );
}

function V19DadosEstruturados({ data }) {
  if (!data || typeof data !== 'object') return null;
  const usados = new Set();
  // comentários internos do schema não devem aparecer
  Object.keys(data).forEach((k) => { if (k.startsWith('_')) usados.add(k); });

  const grupos = V19_GRUPOS.map((g) => {
    const entries = g.keys
      .filter((k) => k in data && !v19Vazio(data[k]) && !Array.isArray(data[k]) && typeof data[k] !== 'object')
      .map((k) => { usados.add(k); return [k, data[k]]; });
    return { titulo: g.titulo, entries };
  }).filter((g) => g.entries.length > 0);

  // Listas/alertas (arrays não vazios)
  const listas = Object.entries(data).filter(([k, v]) => !usados.has(k) && Array.isArray(v) && v.length > 0);
  listas.forEach(([k]) => usados.add(k));

  // Sobras (primitivos não agrupados e não vazios)
  const outros = Object.entries(data).filter(
    ([k, v]) => !usados.has(k) && !v19Vazio(v) && !Array.isArray(v) && typeof v !== 'object'
  );

  const Section = ({ titulo, children }) => (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--cpv2-brand)', marginBottom: 5 }}>{titulo}</div>
      {children}
    </div>
  );

  return (
    <div>
      {grupos.map((g) => (
        <Section key={g.titulo} titulo={g.titulo}><V19Grid entries={g.entries} /></Section>
      ))}
      {listas.length > 0 && (
        <Section titulo="Alertas e listas">
          {listas.map(([k, arr]) => (
            <div key={k} style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 11.5, fontWeight: 600 }}>{humanizeKeyV19(k)} <span style={{ opacity: 0.5 }}>({arr.length})</span></div>
              <ul style={{ margin: '3px 0 0 16px', padding: 0, fontSize: 12.5 }}>
                {arr.map((it, i) => (
                  <li key={i} style={{ wordBreak: 'break-word' }}>
                    {typeof it === 'object' && it !== null
                      ? Object.entries(it).filter(([, vv]) => !v19Vazio(vv)).map(([kk, vv]) => `${humanizeKeyV19(kk)}: ${fmtValorV19(kk, vv)}`).join(' · ')
                      : String(it)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Section>
      )}
      {outros.length > 0 && (
        <Section titulo="Outros dados"><V19Grid entries={outros} /></Section>
      )}
    </div>
  );
}

/* ── componente principal ─────────────────────────────────────────────────── */

// Referência ESTÁVEL para o default de apontamentosUC. Um `= []` no parâmetro cria um
// array NOVO a cada render; como esse array alimenta apontsView → apontMonthSet →
// dadosGrafico (data do recharts), a identidade nova a cada render fazia o recharts
// re-renderizar em loop (ResizeObserver → width/height -1 → travava o modal). Isso só
// disparava quando o pai NÃO passa apontamentosUC (ex.: aba Acer). Um const de módulo
// mantém a mesma referência entre renders e quebra o loop.
const EMPTY_APONTS = [];

export default function ModalFaturaMontada({ row, onClose, onRejeitado, onEncaminhar, apontamentosUC = EMPTY_APONTS, onSwitchFatura }) {
  // fonte da linha (row.fonte). 'acer' → todos os endpoints do modal apontam p/ a tabela
  // FATURA_ACER_DADOS_EXTRAIDOS (default = FDE, inalterado). fp = params extras p/ cada chamada.
  const _fonte = row?.fonte || undefined;
  const fp = _fonte === 'acer' ? { fonte: 'acer' } : {};
  // fatura completa (todos os campos capturados) — carregada por id
  const [fatura, setFatura] = useState(row || {});
  const [carregandoFatura, setCarregandoFatura] = useState(true);
  const [editarOpen, setEditarOpen] = useState(false);

  // histórico mensal da UC (gráfico + tabela de meses)
  const [meses, setMeses] = useState([]);
  const [apontsUC, setApontsUC] = useState([]); // apontamentos da UC vindos do backend (fonte completa)
  const [carregandoHist, setCarregandoHist] = useState(true);
  const [erroHist, setErroHist] = useState('');

  const uc = String(first(row?.UC, row?.uc, row?.codigo_uc, row?.numero_instalacao) || '').trim();
  const idFatura = row?.id;
  // fonte do apontamento: 'sgeeasy' usa dados/histórico da Faturas_Registradas_Cache;
  // 'fde'/'ambos'/undefined usam a FATURA_DADOS_EXTRAIDOS (comportamento padrão).
  const fonte = row?.fonte;
  const ehSgeeasy = fonte === 'sgeeasy';

  // ESC fecha
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Cancelamento das chamadas de IA (30s-5min) ao fechar/desmontar o modal:
  // evita setState em componente desmontado e corta custo de OpenAI órfão.
  const iaCtrlsRef = useRef(new Set());
  const novoSinalIA = () => {
    const ctrl = new AbortController();
    iaCtrlsRef.current.add(ctrl);
    return { signal: ctrl.signal, done: () => iaCtrlsRef.current.delete(ctrl) };
  };
  const ehCancelamento = (e) =>
    e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError' || e?.message === 'canceled';
  useEffect(() => () => {
    for (const c of iaCtrlsRef.current) { try { c.abort(); } catch {} }
    iaCtrlsRef.current.clear();
  }, []);

  // fatura completa — busca TODAS as colunas flat da FATURA_DADOS_EXTRAIDOS por uid
  // (/faturas-extraidas/:uid devolve o objeto flat direto). Fallback: /fde-analise?id= (aninhado).
  const uidFatura = row?.uid;
  useEffect(() => {
    let cancel = false;
    setCarregandoFatura(true);

    const usarRow = () => { if (!cancel) { setFatura(row || {}); setCarregandoFatura(false); } };

    if (ehSgeeasy) {
      // apontamento do sgeeasy: os dados da FDE não valem (kwh_total=0 / não extraída) —
      // usa o próprio row (UC/mês/consumo/desvio vindos da Faturas_Registradas_Cache).
      usarRow();
    } else if (uidFatura) {
      apiClient.get('/api/v1/faturas-extraidas/' + encodeURIComponent(uidFatura), { params: fp })
        .then((res) => {
          if (cancel) return;
          const obj = (res.data && !Array.isArray(res.data)) ? res.data : null;
          setFatura(obj || row || {});
        })
        .catch(() => { if (!cancel) setFatura(row || {}); })
        .finally(() => { if (!cancel) setCarregandoFatura(false); });
    } else if (idFatura) {
      apiClient.get('/api/v1/faturas/fde-analise', { params: { id: idFatura, limit: 1, ...fp } })
        .then((res) => {
          if (cancel) return;
          const arr = Array.isArray(res.data) ? res.data : (res.data?.rows ?? []);
          setFatura(arr[0] || row || {});
        })
        .catch(() => { if (!cancel) setFatura(row || {}); })
        .finally(() => { if (!cancel) setCarregandoFatura(false); });
    } else {
      usarRow();
    }
    return () => { cancel = true; };
  }, [uidFatura, idFatura]); // eslint-disable-line react-hooks/exhaustive-deps

  // histórico mensal da UC
  useEffect(() => {
    if (!uc) { setMeses([]); setCarregandoHist(false); return; }
    let cancel = false;
    setCarregandoHist(true); setErroHist('');
    // Histórico do gráfico: SEMPRE tenta o FDE primeiro (série rica da unidade por
    // numero_instalacao/codigo_uc — funciona mesmo p/ linha marcada 'sgeeasy' que tem
    // fatura na FDE, ex.: ID 61895 Energisa). Só cai no espelho sgeeasy LOCAL
    // (Faturas_Registradas_Cache) se o FDE vier vazio (UC que só existe no sgeeasy).
    const inst = String(row?.numero_instalacao || row?.instalacao || '').trim();
    const parseHist = (raw) => {
      const arr = Array.isArray(raw) ? raw
        : (Array.isArray(raw?.rows) ? raw.rows
          : (Array.isArray(raw?.meses) ? raw.meses
            : (Array.isArray(raw?.data) ? raw.data : [])));
      return arr.map((m) => ({
        id: m.id,
        mes: m.mes ?? m.Mes_Ref ?? m.mes_ref ?? '',
        kwh: Number(m.KWH_Total ?? m.kwh_confirmado ?? m.kwh_historico ?? m.kwh_total ?? m.kwh ?? 0),
        valor: Number(m.RS_Total_Fatura ?? m.valor ?? m.valor_total ?? 0),
        link: m.Link ?? m.link ?? '',
        fonte: m.fonte ?? '',
        numero_fatura: m.numero_fatura ?? '',
      }));
    };
    (async () => {
      try {
        let norm = parseHist((await apiClient.get('/api/v1/faturas/fde-uc-historico', { params: { uc, inst, ...fp } })).data);
        if (norm.length === 0) {
          try { norm = parseHist((await apiClient.get('/api/v1/faturas/uc-historico-local', { params: { uc, ...fp } })).data); } catch { /* mantém [] */ }
        }
        if (cancel) return;
        norm.sort((a, b) => String(b.mes).localeCompare(String(a.mes)));
        setMeses(norm);
      } catch (err) {
        if (!cancel) setErroHist(err?.message || 'Erro ao buscar histórico');
      } finally {
        if (!cancel) setCarregandoHist(false);
      }
    })();
    return () => { cancel = true; };
  }, [uc, row]);

  // apontamentos (meses flagados) DESTA UC — fonte completa do backend
  useEffect(() => {
    const ucKey = String(uc || row?.UC || row?.uc || '').trim();
    if (!ucKey) { setApontsUC([]); return; }
    let cancelA = false;
    apiClient.get('/api/v1/faturas/uc-apontamentos', { params: { uc: ucKey, ...fp } })
      .then(({ data }) => { if (!cancelA) setApontsUC(Array.isArray(data?.apontamentos) ? data.apontamentos : []); })
      .catch(() => { if (!cancelA) setApontsUC([]); });
    return () => { cancelA = true; };
  }, [uc]);

  // apontamentos da UC: prioriza a fonte COMPLETA do backend; cai no que o pai passou.
  // MEMOIZADO: mantém referência estável entre renders (senão o array novo a cada render
  // propaga para dadosGrafico → recharts entra em loop de re-render). Ver EMPTY_APONTS.
  const apontsView = useMemo(
    () => ((apontsUC && apontsUC.length) ? apontsUC : (apontamentosUC || EMPTY_APONTS)),
    [apontsUC, apontamentosUC],
  );
  const apontSet = useMemo(() => {
    const src = (apontsUC && apontsUC.length) ? apontsUC : (apontamentosUC || []);
    const s = new Set();
    src.forEach((a) => { const id = a?.id ?? a?.Id; if (id != null) s.add(Number(id)); });
    return s;
  }, [apontsUC, apontamentosUC]);

  // Meses apontados da UC (YYYY-MM) — fonte AUTORITATIVA = os chips (snapshot/uc-apontamentos).
  // A barra vermelha do gráfico DEVE bater com os chips; por isso marcamos por MÊS, não por id
  // (a UC pode ter faturas duplicadas por mês em 2 séries de extração — marcar por id caía na
  //  duplicata errada e a barra vermelha ia parar em outro mês/ano).
  const apontMonthSet = useMemo(() => {
    const s = new Set();
    (apontsView || []).forEach((a) => {
      const mk = String(a.mes_referencia ?? a.Mes_Ref ?? a.mes_ref ?? '').slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(mk)) s.add(mk);
    });
    return s;
  }, [apontsView]);

  // dados do gráfico (mais antigo → mais recente); DEDUPE por mês (prefere a fatura apontada,
  // senão a de maior kWh) e marca vermelho pelo MÊS apontado (igual aos chips).
  const dadosGrafico = useMemo(() => {
    const monthKey = (m) => String(m.mes).slice(0, 7);
    const byMonth = new Map();
    meses.filter((m) => m.kwh > 0 || m.valor > 0).forEach((m) => {
      const mk = monthKey(m);
      const cur = byMonth.get(mk);
      const isApont = apontSet.has(Number(m.id));
      if (!cur) { byMonth.set(mk, m); return; }
      const curApont = apontSet.has(Number(cur.id));
      if (isApont && !curApont) byMonth.set(mk, m);
      else if (isApont === curApont && Number(m.kwh) > Number(cur.kwh)) byMonth.set(mk, m);
    });
    return Array.from(byMonth.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([mk, m]) => ({
        mes: fmtMesRef(m.mes),
        kwh: m.kwh,
        valor: m.valor,
        id: m.id,
        atual: !!(m.id && idFatura && Number(m.id) === Number(idFatura)),
        apontado: apontMonthSet.size
          ? apontMonthSet.has(mk)
          : (apontSet.size ? apontSet.has(Number(m.id)) : !!(m.id && idFatura && Number(m.id) === Number(idFatura))),
      }));
  }, [meses, idFatura, apontSet, apontMonthSet]);

  // Mês do "salto/acúmulo": o de MAIOR multiplicação vs o mês anterior (>=2x).
  // É onde o consumo deu o pulo súbito (possível acúmulo compensado / troca de padrão).
  const saltoIdx = useMemo(() => {
    let best = -1, bestRatio = 2;
    for (let i = 1; i < dadosGrafico.length; i++) {
      const prev = dadosGrafico[i - 1].kwh, cur = dadosGrafico[i].kwh;
      if (prev > 0 && cur / prev > bestRatio) { bestRatio = cur / prev; best = i; }
    }
    return best;
  }, [dadosGrafico]);

  // Teto robusto do eixo kWh: se um mês tem valor MUITO acima da mediana (ex.: misparse
  // do consumo — 301.796 num histórico de ~400), o recharts escalava o eixo nele e as
  // barras normais viravam ~0 (o gráfico "só mostrava 1 barra"). Aqui capamos o eixo em
  // ~4× a mediana quando há esse outlier → todas as barras ficam visíveis (a outlier é
  // clipada no topo via allowDataOverflow; o valor real segue no tooltip).
  const kwhDomain = useMemo(() => {
    const vs = dadosGrafico.map((d) => Number(d.kwh) || 0).filter((v) => v > 0).sort((a, b) => a - b);
    if (vs.length < 3) return null;
    const med = vs[Math.floor(vs.length / 2)];
    const max = vs[vs.length - 1];
    if (med > 0 && max > med * 4) return [0, Math.ceil(med * 4)];
    return null;
  }, [dadosGrafico]);

  const linkPrincipal = String(first(row?.Link, row?.link, fatura?.link_fatura) || '').trim();
  // Nome canônico da empresa (por cod) PRIMEIRO — empresa_nome/razao_social são consistentes por
  // cod_empresa; nome_cliente vem da fatura e tem muitas variações (ex.: VTAL). Evita as variações.
  const cliente = first(
    fatura.empresa_nome, fatura.razao_social,
    row?.RAZAO_SOCIAL, row?.razao_social, row?.cliente,
    fatura.nome_cliente,
  ) || '—';
  const dist = first(fatura.distribuidora, row?.Concessionaria, row?.concessionaria) || '—';
  const mesRefTopo = first(fatura.mes_referencia, row?.Mes_Ref, row?.mes_ref);
  const gate = first(fatura.validador_gate, row?.validador_gate);

  // score de confiança (0-100) — tolera fração 0-1
  let score = first(fatura.extracao_score_confianca, row?.extracao_score_confianca);
  if (score == null) {
    const sc = first(fatura.extracao_confidence_score, row?.extracao_confidence_score);
    if (sc != null) score = `${(Number(sc) * 100).toFixed(0)}`;
  }

  const gd = fatura;
  const temGD = gd.indicador_geracao_distribuida || gd.energia_injetada_kwh
    || gd.energia_compensada_kwh || gd.saldo_credito_energia;

  // Cálculo do apontamento F02 + ressarcimento estimado, a partir do histórico já carregado.
  // consumo do mês vs média dos demais meses (kWh>0); ressarcimento = (consumo − média) × R$/kWh.
  const apont = useMemo(() => {
    if (!meses || meses.length === 0) return null;
    let atual = meses.find((m) => m.id && idFatura && Number(m.id) === Number(idFatura));
    if (!atual) atual = meses[0]; // meses vem ordenado desc por mês
    const consumoAtual = Number(atual?.kwh || 0);
    const base = meses.filter((m) => m !== atual && Number(m.kwh) > 0);
    if (!consumoAtual || base.length === 0) return null;
    const media = base.reduce((s, m) => s + Number(m.kwh || 0), 0) / base.length;
    if (!media) return null;
    const variancia = base.reduce((s, m) => s + Math.pow(Number(m.kwh || 0) - media, 2), 0) / base.length;
    const sigma = Math.sqrt(variancia);
    const excesso = consumoAtual - media;
    const desvioPct = (excesso / media) * 100;
    // R$/kWh correto = energia ativa (R$) ÷ consumo (kWh). ATENÇÃO: rs_kwh_total NÃO
    // é preço unitário — é o valor TOTAL da energia (igual a valor_energia_ativa),
    // então usá-lo como tarifa inflava a estimativa. Ex.: 6223,16 / 6027 = 1,032540.
    const kwhFat = Number(fatura?.kwh_total) > 0 ? Number(fatura.kwh_total) : consumoAtual;
    const energiaAtiva = Number(fatura?.valor_energia_ativa);
    // R$/kWh = SÓ o valor de energia da fatura ÷ consumo. Sem valor_energia_ativa NÃO
    // estimamos (o fallback antigo valor_total/consumo inflava — incluía ICMS/TUSD/demanda).
    const rsKwh = (energiaAtiva > 0 && kwhFat > 0) ? energiaAtiva / kwhFat : 0;
    const ressarcimento = (excesso > 0 && rsKwh > 0) ? excesso * rsKwh : 0;
    return { consumoAtual, media, sigma, baseN: base.length, excesso, desvioPct, rsKwh, ressarcimento };
  }, [meses, fatura, idFatura]);

  // Ressarcimento exibido: prefere o valor canônico GRAVADO (tabela
  // FATURA_APONTAMENTOS_AUDITADOS, chega via row.ressarcimento_estimado) — garante
  // que o modal mostre EXATAMENTE o mesmo número da coluna "Ressarc." em Auditados
  // (inclui fallback rs_kwh_total e fator de retenção). Sem valor gravado, cai no
  // cálculo ao vivo do apont.
  const ressStored = Number(row?.ressarcimento_estimado) || 0;
  const ressExibido = ressStored > 0 ? ressStored : (apont?.ressarcimento || 0);
  // Parecer da conferência: snapshot (observacao_auditado) OU, se vazio, o parecer gravado
  // na FDE (observacoes_fatura) — cobre casos VERDADEIRO que o motor não recolocou no snapshot.
  const _obsSnap = String(row?.observacao_auditado || '').trim();
  const _obsFde = String(row?.observacoes_fatura || '').trim();
  const obsAuditado = _obsSnap || (/\[AN[ÁA]LISE RESSARCIMENTO/i.test(_obsFde) ? _obsFde : '');

  // ── Re-skin (mockup): veredito + total da UC + tags do cabeçalho ──
  // Veredito = VERDADEIRO/FALSO em qualquer posição do parecer (o texto da FDE tem prefixo).
  const verdictWord = (obsAuditado.match(/(VERDADEIRO|FALSO)/i)?.[1] || '').toUpperCase();
  // Ressarcimento TOTAL da UC = soma dos apontamentos da unidade (fallback: o do mês).
  const ressUCTotal = (Array.isArray(apontsView) && apontsView.length
    ? apontsView.reduce((s, a) => s + (Number(a.ressarcimento_estimado) || 0), 0)
    : 0) || ressExibido;
  const nMesesHist = Array.isArray(meses) ? meses.filter((m) => Number(m.kwh) > 0).length : 0;
  const nApontUC = Array.isArray(apontsView) ? apontsView.length : 0;
  // Classificação do histórico (advisory): SAZONAL / CRESCENTE / VOLATIL / ELEVADO_REAL / DENTRO_DO_HISTORICO
  const classifHist = String(first(row?.classificacao_historico, fatura.classificacao_historico) || '').toUpperCase().trim();
  const CLASSIF_CHIP = {
    SAZONAL:            { t: '🔁 Sazonal',            c: 'var(--cpv2-warning)' },
    VOLATIL:            { t: '📈 Volátil/Sazonal',    c: 'var(--cpv2-warning)' },
    CRESCENTE:          { t: '↗ Consumo crescente',   c: 'var(--cpv2-accent)' },
    ELEVADO_REAL:       { t: '⚡ Elevado real',        c: 'var(--cpv2-danger)' },
    DENTRO_DO_HISTORICO:{ t: '≈ Dentro do histórico', c: 'var(--cpv2-text-muted)' },
  };
  const classifChip = CLASSIF_CHIP[classifHist];

  // Base de energia (R$) e tarifa efetiva — mesmo fallback da tabela: valor_energia_ativa
  // OU rs_kwh_total (são a MESMA grandeza = valor total da energia em R$). Corrige a
  // "Tarifa aplicada: R$ 0,00" que aparecia quando valor_energia_ativa vinha nulo.
  // Base canônica: prefere a gravada na tabela (row.ressarcimento_base, via backend),
  // senão cai no valor_energia_ativa / rs_kwh_total da própria fatura.
  const baseEnergiaRS = Number(row?.ressarcimento_base) > 0
    ? Number(row.ressarcimento_base)
    : (Number(fatura?.valor_energia_ativa) > 0
        ? Number(fatura.valor_energia_ativa)
        : (Number(fatura?.rs_kwh_total) || 0));
  const baseEnergiaOrigem = Number(row?.ressarcimento_base) > 0
    ? 'auditado'
    : (Number(fatura?.valor_energia_ativa) > 0 ? 'valor_energia_ativa' : (Number(fatura?.rs_kwh_total) > 0 ? 'rs_kwh_total' : '—'));
  const kwhFaturaBase = Number(fatura?.kwh_total) > 0 ? Number(fatura.kwh_total) : (apont?.consumoAtual || 0);
  const tarifaEfetiva = (baseEnergiaRS > 0 && kwhFaturaBase > 0) ? baseEnergiaRS / kwhFaturaBase : (apont?.rsKwh || 0);

  const nf0 = (v) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 });

  // Valor da bandeira: soma das LINHAS de item de bandeira (fonte real cobrada),
  // pois a coluna valor_bandeira/_rs vem errada em vários casos (ex.: id 476593
  // guardava 35,67 mas o item "Adic. B. Amarela" é 11,89). Fallback: coluna.
  const valorBandeira = useMemo(() => {
    const arr = loadJ(fatura.itens_cobrados);
    if (Array.isArray(arr)) {
      let soma = 0, achou = false;
      for (const it of arr) {
        if (it && ehItemBandeira(it.descricao)) {
          const v = Number(it.valor_brl_numerico);
          if (Number.isFinite(v)) { soma += v; achou = true; }
        }
      }
      if (achou) return soma;
    }
    return num(fatura.valor_bandeira_rs) ?? num(fatura.valor_bandeira);
  }, [fatura]);

  // ── Sinais derivados (cruzamento das 3 fontes: parser × SEFAZ × itens) ──
  // Reconciliação de totais + coerência de consumo + semáforo de solidez do apontamento.
  const sinais = useMemo(() => {
    const f = fatura || {};
    const totFat = num(f.valor_total_fatura) ?? num(row?.RS_Total_Fatura);
    const totItens = num(f.valor_total_itens);
    const totSefaz = num(f.valor_total_sefaz);
    const consFat = num(f.kwh_total)
      ?? (((num(f.consumo_ativo_ponta_kwh) || 0) + (num(f.consumo_ativo_fponta_kwh) || 0)) || null);
    const consSefaz = num(f.consumo_ativo_sefaz_kwh);
    const difPct = (a, b) => (a && b) ? Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) * 100 : null;
    const difItens = difPct(totFat, totItens);
    const difSefaz = difPct(totFat, totSefaz);
    const difCons = difPct(consFat, consSefaz);

    // status por par: ok (≤1%) / atencao (≤5%) / diverge (>5%) / na (sem dado)
    const st = (d) => d == null ? 'na' : d <= 1 ? 'ok' : d <= 5 ? 'atencao' : 'diverge';
    const stTotSefaz = st(difSefaz);
    const stTotItens = st(difItens);
    const stCons = st(difCons);

    // veredito tri-fonte (total): concordância parser × sefaz × itens
    const votos = [stTotSefaz, stTotItens].filter((s) => s !== 'na');
    const okTot = votos.filter((s) => s === 'ok').length;
    let triNivel = 'na', triLabel = 'sem 2ª fonte';
    if (votos.length > 0) {
      if (votos.every((s) => s === 'ok')) { triNivel = 'ok'; triLabel = `concordam (${okTot + 1}/${votos.length + 1})`; }
      else if (votos.some((s) => s === 'diverge')) { triNivel = 'diverge'; triLabel = 'divergência'; }
      else { triNivel = 'atencao', triLabel = 'atenção'; }
    }

    // semáforo de solidez do apontamento
    const scoreN = num(score);
    const arit = f.aritmetica_ok;
    let pontos = 0, maxPontos = 0;
    const add = (cond) => { maxPontos += 1; if (cond) pontos += 1; };
    if (arit === 1 || arit === 0) add(arit === 1);
    if (stTotSefaz !== 'na') add(stTotSefaz === 'ok');
    if (apont) add(apont.baseN >= 3);
    if (scoreN != null) add(scoreN >= 70);
    if (!f.flag_faturamento_media) add(true); else add(false);
    const solidezPct = maxPontos > 0 ? Math.round(pontos / maxPontos * 100) : null;
    const solidezNivel = solidezPct == null ? 'na'
      : solidezPct >= 75 ? 'ok' : solidezPct >= 50 ? 'atencao' : 'diverge';

    return {
      totFat, totItens, totSefaz, consFat, consSefaz,
      difItens, difSefaz, difCons, stTotSefaz, stTotItens, stCons,
      triNivel, triLabel, solidezPct, solidezNivel, scoreN,
      aritOk: arit === 1 ? true : (arit === 0 ? false : null),
      faturamentoMedia: !!f.flag_faturamento_media,
    };
  }, [fatura, row, score, apont]);

  // cores por status de sinal
  const corSinal = (nivel) => nivel === 'ok' ? 'var(--cpv2-success)'
    : nivel === 'atencao' ? 'var(--cpv2-warning)'
    : nivel === 'diverge' ? 'var(--cpv2-danger)'
    : 'var(--cpv2-text-muted)';

  // ── IA: novo modal comparativo (FDE + sgeeasy + IA) ──
  const [comparativoAberto, setComparativoAberto] = useState(false);

  // ── IA: auditar valores (gpt-5.4-mini) — modo texto legado ──
  const [auditando, setAuditando] = useState(false);
  const [auditResult, setAuditResult] = useState(null);
  const [auditErro, setAuditErro] = useState('');
  const auditarValores = () => {
    if (!idFatura || auditando) return;
    setAuditando(true); setAuditErro(''); setAuditResult(null);
    // manda o apontamento detectado (consumo × média, desvio, ressarcimento, cruzamento)
    // pra IA CONFERIR se o erro procede — não é auditoria genérica.
    const ctx = [];
    if (apont) {
      ctx.push(`Consumo do mês: ${nf0(apont.consumoAtual)} kWh`);
      ctx.push(`Média histórica (${apont.baseN} meses): ${nf0(apont.media)} kWh`);
      ctx.push(`Desvio sobre a média: ${apont.desvioPct >= 0 ? '+' : ''}${apont.desvioPct.toFixed(1)}%`);
      ctx.push(`Tarifa aplicada: ${fmtCurrency(apont.rsKwh)}/kWh`);
      ctx.push(`Ressarcimento estimado: ${fmtCurrency(apont.ressarcimento)}`);
    }
    if (sinais) {
      if (sinais.triLabel) ctx.push(`Cruzamento total (parser × SEFAZ × itens): ${sinais.triLabel}`);
      if (sinais.totSefaz != null) ctx.push(`Total fatura ${fmtCurrency(sinais.totFat)} × SEFAZ ${fmtCurrency(sinais.totSefaz)}`);
    }
    apiClient.post(`/api/v1/faturas/${idFatura}/auditar`, { apontamento: ctx.join('\n') }, { params: fp })
      .then((res) => setAuditResult(res.data?.resposta || '(sem resposta)'))
      .catch((err) => setAuditErro(err?.response?.data?.error || err?.message || 'Erro ao auditar'))
      .finally(() => setAuditando(false));
  };

  // ── IA: análise completa v19 (prompt canônico F01-F05 + JSON estruturado) ──
  const [analisandoV19, setAnalisandoV19] = useState(false);
  const [analiseV19, setAnaliseV19] = useState(null);
  const [analiseV19Veredito, setAnaliseV19Veredito] = useState(null);
  const [analiseV19Dados, setAnaliseV19Dados] = useState(null); // JSON estruturado
  const [analiseV19Mapa, setAnaliseV19Mapa] = useState(null);   // mapa de layout usado
  const [analiseV19VerTexto, setAnaliseV19VerTexto] = useState(false);
  const [analiseV19Interpretado, setAnaliseV19Interpretado] = useState(true);
  const [analiseV19Erro, setAnaliseV19Erro] = useState('');

  // ── Analisar todas as faturas da UC (histórico) — nano + desvios ≥ +100% ──
  // Os desvios (≥ +100% da média) são calculados no backend de forma determinística;
  // o texto "Análise do gráfico de consumo" é gerado pelo modelo nano.
  const [analiseTodas, setAnaliseTodas] = useState(null);
  const [analisandoTodas, setAnalisandoTodas] = useState(false);
  const analisarTodasFaturas = () => {
    if (!idFatura || analisandoTodas) return;
    setAnalisandoTodas(true); setAnaliseTodas(null);
    const s = novoSinalIA();
    // Usa a MESMA base do modal (apont.media / meses) pra o texto bater com o
    // KPI e o "O que observar" — o backend só narra, não recalcula.
    const mediaModal = Number(apont?.media) || 0;
    const serie = (meses || [])
      .map((m) => ({ mes: m.mes, kwh: Number(m.kwh) || 0 }))
      .filter((x) => x.mes);
    const apontamentos = mediaModal > 0
      ? serie.filter((x) => x.kwh >= 2 * mediaModal)
             .map((x) => ({ mes: x.mes, kwh: x.kwh, desvio_pct: (x.kwh - mediaModal) / mediaModal * 100 }))
      : [];
    const payload = { media: mediaModal, total_meses: apont?.baseN || serie.length, serie, apontamentos };
    apiClient.post(`/api/v1/faturas/${idFatura}/analisar-historico`, payload, { timeout: 90000, signal: s.signal, params: fp })
      .then((res) => {
        const d = res.data || {};
        setAnaliseTodas({
          texto: d.analise_grafico || '',
          media: Number(d.media) || 0,
          totalMeses: d.total_meses || 0,
          apont: (d.apontamentos || []).map((a) => ({
            mes: a.mes,
            kwh: Number(a.kwh) || 0,
            desvioPct: Number(a.desvio_pct) || 0,
          })),
        });
      })
      .catch((e) => { if (!ehCancelamento(e)) setAnaliseTodas({ erro: e?.response?.data?.error || e?.message || 'Falha na análise.' }); })
      .finally(() => { s.done(); setAnalisandoTodas(false); });
  };
  const analisarComV19 = () => {
    if (!idFatura || analisandoV19) return;
    setAnalisandoV19(true); setAnaliseV19Erro(''); setAnaliseV19(null); setAnaliseV19Veredito(null);
    setAnaliseV19Dados(null); setAnaliseV19Mapa(null); setAnaliseV19VerTexto(false); setAnaliseV19Interpretado(true);
    // A análise do gráfico de consumo roda JUNTO (não precisa de botão separado).
    analisarTodasFaturas();
    const ctx = [];
    if (apont) {
      ctx.push(`Consumo do mês: ${nf0(apont.consumoAtual)} kWh`);
      ctx.push(`Média histórica (${apont.baseN} meses): ${nf0(apont.media)} kWh`);
      ctx.push(`Desvio sobre a média: ${apont.desvioPct >= 0 ? '+' : ''}${apont.desvioPct.toFixed(1)}%`);
      ctx.push(`Ressarcimento estimado: ${fmtCurrency(apont.ressarcimento)}`);
    }
    const s = novoSinalIA();
    apiClient
      .post(`/api/v1/faturas/${idFatura}/analisar-v19`, { apontamento: ctx.join('\n') }, { timeout: 300000, signal: s.signal, params: fp })
      .then((res) => {
        setAnaliseV19(res.data?.resposta || '(sem resposta)');
        setAnaliseV19Veredito(res.data?.veredito || null);
        setAnaliseV19Dados(res.data?.dados || null);
        setAnaliseV19Mapa(res.data?.mapa_layout || null);
        setAnaliseV19Interpretado(res.data?.interpretado !== false);
      })
      .catch((err) => { if (!ehCancelamento(err)) setAnaliseV19Erro(err?.response?.data?.error || err?.message || 'Erro na análise'); })
      .finally(() => { s.done(); setAnalisandoV19(false); });
  };

  // ── IA: chat (gpt-5.4-nano) ──
  const [chatAberto, setChatAberto] = useState(false);
  const [chatMsgs, setChatMsgs] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatEnviando, setChatEnviando] = useState(false);
  const [chatCarregado, setChatCarregado] = useState(false);
  // Mês em foco (clicado no gráfico) — contexto pra questionar aquele mês no chat.
  const [mesFoco, setMesFoco] = useState(null);
  const chatFimRef = useRef(null);

  useEffect(() => {
    if (!chatAberto || chatCarregado || !idFatura) return;
    apiClient.get(`/api/v1/faturas/${idFatura}/chat`, { params: fp })
      .then((res) => setChatMsgs(Array.isArray(res.data?.messages) ? res.data.messages : []))
      .catch(() => {})
      .finally(() => setChatCarregado(true));
  }, [chatAberto, chatCarregado, idFatura]);

  useEffect(() => {
    if (chatAberto) chatFimRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMsgs, chatAberto]);

  const enviarChat = () => {
    const msg = chatInput.trim();
    if (!msg || chatEnviando || !idFatura) return;
    setChatMsgs((prev) => [...prev, { role: 'user', content: msg }]);
    setChatInput(''); setChatEnviando(true);
    // Se há um mês em foco (clicado no gráfico), injeta o contexto pra IA saber
    // de qual mês estamos falando (não é exibido na bolha do usuário).
    const ctxMes = mesFoco
      ? `[Contexto do gráfico: mês ${mesFoco.mes}, consumo ${nf0(mesFoco.kwh)} kWh, média histórica ${nf0(mesFoco.media)} kWh${mesFoco.desvioPct != null ? `, desvio ${mesFoco.desvioPct >= 0 ? '+' : ''}${mesFoco.desvioPct.toFixed(1)}%` : ''}] `
      : '';
    const s = novoSinalIA();
    apiClient.post(`/api/v1/faturas/${idFatura}/chat`, { mensagem: ctxMes + msg }, { signal: s.signal, params: fp })
      .then((res) => setChatMsgs((prev) => [...prev, { role: 'assistant', content: res.data?.resposta || '(sem resposta)' }]))
      .catch((err) => { if (!ehCancelamento(err)) setChatMsgs((prev) => [...prev, { role: 'assistant', content: '⚠️ ' + (err?.response?.data?.error || err?.message || 'erro') }]); })
      .finally(() => { s.done(); setChatEnviando(false); });
  };

  // ── B: "OCR com IA" — extrai TODAS as faturas da UC + tenta apontamento, num sub-modal aqui ──
  // Reaproveita o job OCR da unidade (from-unidade → run → status → relatorio), sem sair da tela.
  const [ocrOpen, setOcrOpen] = useState(false);
  const [ocrPhase, setOcrPhase] = useState('idle');   // idle|running|done|error
  const [ocrStatus, setOcrStatus] = useState(null);   // {estado, etapa, total, prontas, erros}
  const [ocrReport, setOcrReport] = useState(null);   // []
  const [ocrErro, setOcrErro] = useState('');
  const ocrPollRef = useRef(null);
  useEffect(() => () => { clearInterval(ocrPollRef.current); }, []);

  const ocrPoll = (job) => {
    apiClient.get(`/api/v1/ocr-lote/status/${job}`).then(({ data }) => {
      setOcrStatus(data);
      if (data.estado === 'concluido') {
        clearInterval(ocrPollRef.current);
        apiClient.get(`/api/v1/ocr-lote/relatorio/${job}`)
          .then((r) => { setOcrReport(Array.isArray(r.data) ? r.data : []); setOcrPhase('done'); })
          .catch(() => { setOcrReport([]); setOcrPhase('done'); });
      } else if (data.estado === 'erro') {
        clearInterval(ocrPollRef.current);
        setOcrErro(data.erro || 'erro no processamento'); setOcrPhase('error');
      }
    }).catch(() => { /* próxima iteração tenta de novo */ });
  };

  const rodarOcrComIA = async () => {
    const inst = String(first(fatura.numero_instalacao, row?.numero_instalacao, uc) || '').trim();
    const empresa = String(first(fatura.cod_empresa, row?.cod_empresa) || '').trim();
    if (!inst) { window.alert('Sem número de instalação para rodar o OCR da unidade.'); return; }
    setOcrOpen(true); setOcrPhase('running'); setOcrErro(''); setOcrReport(null);
    setOcrStatus({ estado: 'processando', etapa: 'baixando faturas da unidade…', total: 0, prontas: 0, erros: 0 });
    try {
      const r = await apiClient.post('/api/v1/faturas/ocr-lote-from-unidade', null, { params: { inst, empresa } });
      const job = r.data?.job_id;
      if (!job) throw new Error('job não criado');
      await apiClient.post(`/api/v1/ocr-lote/run/${job}`);
      clearInterval(ocrPollRef.current);
      ocrPollRef.current = setInterval(() => ocrPoll(job), 2500);
      ocrPoll(job);
    } catch (e) {
      setOcrErro(e?.response?.data?.error || e.message || 'falha ao iniciar o OCR da unidade');
      setOcrPhase('error');
    }
  };

  // ── Observação do analista (editável) — DENTRO do modal (movida da coluna fichas) ──
  const [obsEdit, setObsEdit] = useState(null); // null = usa row.observacao_auditado
  const obsAtual = obsEdit != null ? obsEdit : obsAuditado;
  const editarObsAnalista = () => {
    if (!idFatura) return;
    const novo = window.prompt('Observação do analista (verificação — anterior/atual/próxima, medidor, veredito). Vazio limpa:', obsAtual || '');
    if (novo === null) return;
    apiClient.post(`/api/v1/faturas/${idFatura}/observacao-auditado`, { observacao: novo })
      .then(() => setObsEdit(novo))
      .catch(() => window.alert('Falha ao salvar observação.'));
  };

  // ── Rejeitar apontamento (falso positivo) → sai da lista da Auditoria ──
  const MOTIVOS_REJEICAO = [
    'Falso positivo',
    'Consumo apontado divergente ao da fatura',
    'Requisição já existente',
    'Fatura já revisada',
  ];
  const [rejeitando, setRejeitando] = useState(false);
  const [rejeitarAberto, setRejeitarAberto] = useState(false); // painel de escolha do motivo
  const [rejeitandoSg, setRejeitandoSg] = useState(false);
  // Rejeição de apontamento SGEEASY (Inconclusivos/Outlier, sem linha na FDE): persiste
  // por uid em FATURA_REANALISES. Sai dos Inconclusivos no próximo load; risco vermelho já.
  const rejeitarSgeeasy = () => {
    const uidSg = String(row?.uid || fatura?.uid || '').trim();
    if (!uidSg) { alert('uid do sgeeasy ausente — não é possível rejeitar.'); return; }
    const motivo = window.prompt('Motivo da rejeição (apontamento sgeeasy):', 'Falso positivo');
    if (motivo === null) return;
    setRejeitandoSg(true);
    apiClient
      .post('/api/v1/sgeeasy/rejeitar-apontamento', { uid: uidSg, motivo })
      .then(() => { onRejeitado?.(row?.id ?? uidSg); onClose?.(); })
      .catch((e) => alert('Falha ao rejeitar: ' + (e?.response?.data?.error || e.message)))
      .finally(() => setRejeitandoSg(false));
  };
  const confirmarRejeicao = (motivo) => {
    if (!idFatura || !motivo) return;
    setRejeitando(true); setRejeitarAberto(false);
    apiClient
      .post(`/api/v1/faturas/${idFatura}/rejeitar-apontamento`, { motivo })
      .then(() => { onRejeitado?.(idFatura); onClose?.(); })
      .catch((e) => window.alert('Falha ao rejeitar: ' + (e?.response?.data?.error || e.message)))
      .finally(() => setRejeitando(false));
  };

  // ── Confirmar erro → painel de criação de requisição (oculto até clicar) ──
  const [confirmarErro, setConfirmarErro] = useState(false);
  const [tiposLista, setTiposLista] = useState([]);
  const [subtiposLista, setSubtiposLista] = useState([]);
  const [reqForm, setReqForm] = useState(null);
  const [reqSalvando, setReqSalvando] = useState(false);
  const [reqErro, setReqErro] = useState('');
  const [gerandoDescIA, setGerandoDescIA] = useState(false); // descrição via gpt-4o-mini
  const [reqOk, setReqOk] = useState(null);

  useEffect(() => {
    if (!confirmarErro) return;
    apiClient.get('/api/v1/tipos-irregularidade')
      .then((r) => setTiposLista(Array.isArray(r.data) ? r.data : (r.data?.rows ?? r.data?.tipos ?? [])))
      .catch(() => setTiposLista([]));
  }, [confirmarErro]);

  useEffect(() => {
    const tid = reqForm?.id_tipo_irregularidade;
    if (!tid) { setSubtiposLista([]); return; }
    apiClient.get(`/api/v1/tipos-irregularidade/${tid}/subtipos`)
      .then((r) => setSubtiposLista(Array.isArray(r.data) ? r.data : (r.data?.rows ?? r.data?.subtipos ?? [])))
      .catch(() => setSubtiposLista([]));
  }, [reqForm?.id_tipo_irregularidade]);

  const fmtBR2 = (n) => {
    const x = Number(n);
    return Number.isFinite(x) ? x.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0,00';
  };
  const parseBR = (s) => {
    if (typeof s === 'number') return s;
    const t = String(s ?? '').trim();
    if (!t) return 0;
    return t.includes(',') ? (Number(t.replace(/\./g, '').replace(',', '.')) || 0) : (Number(t) || 0);
  };
  const updReq = (k) => (e) => setReqForm((f) => ({ ...f, [k]: e.target.value }));

  const abrirConfirmarErro = (ressOverride) => {
    // ressOverride: ressarcimento vindo do veredito v19 (quando aberto por aquele botão).
    // Guarda contra o event object do onClick padrão (usa só se for número > 0).
    const ov = (typeof ressOverride === 'number' && ressOverride > 0) ? ressOverride : null;
    const fichaP = (String(first(fatura.fichas_aplicadas, '') || '').split(',')[0] || 'F02').toUpperCase().trim() || 'F02';
    const irr = FICHA_PARA_IRREGULARIDADE[fichaP] || IRREGULARIDADE_DEFAULT;
    const valorRess = ov != null
      ? ov
      : (ressExibido > 0)
        ? ressExibido
        : Number(fatura.valor_total_fatura || row?.RS_Total_Fatura || 0);
    const inst = first(fatura.numero_instalacao, '') || '';
    const grupo = first(fatura.grupo_tarifario, '') || '';
    const subgrupo = first(fatura.subgrupo_tarifario, '') || '';
    const modalidade = first(fatura.modalidade_tarifaria, '') || '';
    const classif = String(row?.classificacao_historico || fatura.classificacao_historico || '').replace(/_/g, ' ');
    const fichasTodas = String(first(fatura.fichas_aplicadas, '') || row?.fichas_aplicadas || fichaP);
    const obsAudit = String(row?.observacao_auditado || '').trim();
    const excedenteKwh = apont ? Math.max(0, apont.consumoAtual - apont.media) : 0;
    const grupoLinha = [grupo || subgrupo ? `${grupo}${subgrupo ? ` ${subgrupo}` : ''}`.trim() : '', modalidade].filter(Boolean).join(' · ');
    const desc = [
      `═══ APONTAMENTO ${fichaP} ═══`,
      cliente && cliente !== '—' ? `Cliente: ${cliente}` : '',
      uc ? `UC: ${uc}${inst && inst !== uc ? `  ·  Instalação: ${inst}` : ''}` : '',
      grupoLinha ? `Grupo/Modalidade: ${grupoLinha}` : '',
      classif ? `Classificação (histórico): ${classif}` : '',
      `Fichas aplicadas: ${fichasTodas}`,
      obsAudit ? `⚠️ Observação (revisar): ${obsAudit}` : '',
      '',
      `─── Desvio de consumo ───`,
      apont ? `Consumo do mês: ${nf0(apont.consumoAtual)} kWh` : '',
      apont ? `Média histórica (${apont.baseN} meses): ${nf0(apont.media)} kWh` : '',
      apont ? `Excedente sobre a média: ${nf0(excedenteKwh)} kWh` : '',
      apont ? `Desvio sobre a média: ${apont.desvioPct >= 0 ? '+' : ''}${apont.desvioPct.toFixed(1)}%` : '',
      '',
      `─── Ressarcimento ───`,
      `Tarifa de energia aplicada: ${fmtCurrency(tarifaEfetiva)}/kWh`,
      baseEnergiaRS > 0 ? `Base de energia (R$): ${fmtCurrency(baseEnergiaRS)} (${baseEnergiaOrigem})` : '',
      `Ressarcimento estimado: ${fmtCurrency(ressExibido)}`,
      `  (excedente × tarifa de energia)`,
      '',
      `═══ FONTES ═══`,
      `Distribuidora: ${dist}`,
      `Mês de referência: ${fmtMesRef(mesRefTopo)}`,
      sinais && sinais.triLabel ? `Cruzamento (parser × SEFAZ × itens): ${sinais.triLabel}` : '',
    ].filter(Boolean).join('\n');
    setReqForm({
      uc: uc || '',
      concessionaria: dist !== '—' ? dist : '',
      cliente: cliente !== '—' ? cliente : '',
      mes_ref: first(fatura.mes_referencia, mesRefTopo) || '',
      id_tipo_irregularidade: String(irr.id_tipo),
      id_subtipo_irregularidade: String(irr.id_subtipo),
      valor_estimado: fmtBR2(valorRess),
      descricao: desc,
      fichas: fichaP,
    });
    setReqErro(''); setReqOk(null);
    setConfirmarErro(true);

    // Descrição automática via gpt-4o-mini — abre com o template (acima) e, quando
    // a IA responde, substitui pelo texto gerado. Se falhar (rede/chave), mantém o
    // template. Não bloqueia o modal.
    setGerandoDescIA(true);
    apiClient.post('/api/v1/faturas/aisure/descricao-apontamento', {
      ficha: fichaP,
      cliente: cliente !== '—' ? cliente : '',
      uc: uc || '',
      instalacao: inst,
      grupo: [grupo, subgrupo].filter(Boolean).join(' '),
      modalidade,
      classificacao: classif,
      fichas: fichasTodas,
      distribuidora: dist !== '—' ? dist : '',
      mes_ref: fmtMesRef(mesRefTopo),
      cruzamento: (sinais && sinais.triLabel) || '',
      consumo_kwh: apont ? apont.consumoAtual : 0,
      media_kwh: apont ? apont.media : 0,
      base_meses: apont ? apont.baseN : 0,
      excedente_kwh: excedenteKwh,
      desvio_pct: apont ? apont.desvioPct : 0,
      tarifa_kwh: tarifaEfetiva,
      base_energia: baseEnergiaRS,
      ressarcimento: ressExibido,
      observacao: obsAudit,
    }, { timeout: 60000 })
      .then((r) => {
        const t = r?.data?.descricao;
        if (t && String(t).trim()) setReqForm((f) => (f ? { ...f, descricao: String(t).trim() } : f));
      })
      .catch(() => { /* mantém o template */ })
      .finally(() => setGerandoDescIA(false));
  };

  const criarRequisicao = () => {
    if (!reqForm || reqSalvando) return;
    const valorNum = parseBR(reqForm.valor_estimado);
    if (!(valorNum > 0)) { setReqErro('Valor estimado precisa ser maior que zero.'); return; }
    setReqSalvando(true); setReqErro('');

    // periodos_irregularidade [{mes,ano}] a partir do mes_ref (aceita 2022-08, 08/2022, AGO/2022)
    const mesRefRaw = String(reqForm.mes_ref ?? '').trim();
    const MES_NOME = { JAN: '01', FEV: '02', MAR: '03', ABR: '04', MAI: '05', JUN: '06', JUL: '07', AGO: '08', SET: '09', OUT: '10', NOV: '11', DEZ: '12' };
    let pMes = null, pAno = null;
    const m1 = mesRefRaw.match(/^(\d{4})-(\d{1,2})/);
    const m2 = mesRefRaw.match(/^(\d{1,2})\/(\d{4})$/);
    const m3 = mesRefRaw.toUpperCase().match(/^([A-Z]{3})\/(\d{4})$/);
    if (m1) { pAno = m1[1]; pMes = m1[2].padStart(2, '0'); }
    else if (m2) { pAno = m2[2]; pMes = m2[1].padStart(2, '0'); }
    else if (m3 && MES_NOME[m3[1]]) { pAno = m3[2]; pMes = MES_NOME[m3[1]]; }
    let periodosJSON = (pMes && pAno) ? JSON.stringify([{ mes: pMes, ano: pAno }]) : '';
    if (!periodosJSON) {
      const h = new Date();
      periodosJSON = JSON.stringify([{ mes: String(h.getMonth() + 1).padStart(2, '0'), ano: String(h.getFullYear()) }]);
    }
    const valorBR = fmtBR2(valorNum);

    const fd = new FormData();
    fd.append('uc', reqForm.uc);
    fd.append('concessionaria', reqForm.concessionaria);
    fd.append('cliente', reqForm.cliente);
    fd.append('mes_ref', reqForm.mes_ref);
    fd.append('id_tipo_irregularidade', reqForm.id_tipo_irregularidade);
    fd.append('idTipoIrregularidade', reqForm.id_tipo_irregularidade);
    fd.append('id_subtipo_irregularidade', reqForm.id_subtipo_irregularidade);
    fd.append('idSubtipoIrregularidade', reqForm.id_subtipo_irregularidade);
    // O parecer da conferência (observacao_auditado) viaja VERBATIM p/ a descrição da
    // requisição — que vira descricao_irregularidade no processo (visível no drawer).
    const parecerAudit = String(row?.observacao_auditado || '').trim();
    const descFinal = parecerAudit
      ? `${reqForm.descricao}\n\n── Parecer da conferência (auditoria) ──\n${parecerAudit}`
      : reqForm.descricao;
    fd.append('descricao', descFinal);
    fd.append('descricaoIrregularidade', descFinal);
    fd.append('periodosIrregularidade', periodosJSON);
    fd.append('periodos', periodosJSON);
    fd.append('valor_estimado', valorBR);
    fd.append('ressarcimentoEstimado', valorBR);
    fd.append('fichas', reqForm.fichas);
    if (_fonte === 'acer') {
      // Acer: NÃO enviar fatura_id (id é da tabela Acer, colidiria com a FDE → PDF errado).
      // Manda o link da fatura e o cod_cliente 2028 (backend resolve nome pela Tab_Empresa).
      fd.append('cod_cliente', '2028');
      fd.append('link_fatura_agua', String(fatura?.link_fatura || row?.link_fatura || '').replace(/\.json$/i, ''));
    } else {
      fd.append('fatura_id', String(idFatura ?? ''));
    }

    apiClient.post('/api/v1/requisicoes', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      .then((res) => { setReqOk(res?.data?.id ? `Requisição #${res.data.id} criada.` : 'Requisição criada.'); })
      .catch((e) => {
        const a = e?.response?.data;
        setReqErro(a?.error ? (a.missing_fields ? `${a.error}: ${a.missing_fields.join(', ')}` : a.error) : 'Falha ao criar requisição.');
      })
      .finally(() => setReqSalvando(false));
  };

  const conteudoModal = (
    <div className="cpv2-root">
      <div
        className="cpv2-modal-backdrop"
        onClick={onClose}
        style={{ padding: '20px', alignItems: 'center', justifyContent: 'center', overflowY: 'auto' }}
      >
        <div
          className="cpv2-modal"
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.stopPropagation()}
          style={{
            width: '100%',
            maxWidth: 1180,
            height: 'auto',
            maxHeight: '92vh',
            borderRadius: 14,
            margin: 'auto',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div className="cpv2-modal__head">
            <div>
              <h3>{cliente}</h3>
              <p>
                {dist} · UC <b>{uc || '—'}</b> · ID {idFatura ?? '—'}
                {mesRefTopo ? ` · ${fmtMesRef(mesRefTopo)}` : ''}
                {first(fatura.modalidade_tarifaria) ? ` · ${first(fatura.modalidade_tarifaria)}` : ''}
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 7 }}>
                {classifChip && (
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
                    color: classifChip.c, border: `1px solid ${classifChip.c}`,
                    background: `color-mix(in srgb, ${classifChip.c} 14%, transparent)`,
                  }}>{classifChip.t}</span>
                )}
                {[
                  first(fatura.numero_medidor, row?.numero_medidor) && `Medidor ${first(fatura.numero_medidor, row?.numero_medidor)}`,
                  nMesesHist > 0 && `${nMesesHist} meses de histórico`,
                  nApontUC > 0 && `${nApontUC} apontamento${nApontUC > 1 ? 's' : ''}`,
                ].filter(Boolean).map((t) => (
                  <span key={t} style={{
                    fontSize: 11, padding: '3px 9px', borderRadius: 999,
                    background: 'var(--cpv2-surface-2)', border: '1px solid var(--cpv2-border)',
                    color: 'var(--cpv2-text-muted)', fontWeight: 500,
                  }}>{t}</span>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {/* Veredito do analista (VERDADEIRO/FALSO) — 1ª palavra da observação */}
              {verdictWord && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 999,
                  fontWeight: 800, fontSize: 12.5, whiteSpace: 'nowrap',
                  color: verdictWord === 'VERDADEIRO' ? 'var(--cpv2-success)' : 'var(--cpv2-danger)',
                  background: `color-mix(in srgb, ${verdictWord === 'VERDADEIRO' ? 'var(--cpv2-success)' : 'var(--cpv2-danger)'} 15%, transparent)`,
                  border: `1px solid ${verdictWord === 'VERDADEIRO' ? 'var(--cpv2-success)' : 'var(--cpv2-danger)'}`,
                }}>
                  {verdictWord === 'VERDADEIRO' ? '✓' : '✕'} {verdictWord}
                </span>
              )}
              {/* Ressarcimento TOTAL da UC (soma dos apontamentos da unidade) */}
              {ressUCTotal > 0 && (
                <div style={{ textAlign: 'right', lineHeight: 1.15 }}>
                  <div style={{ fontSize: 9.5, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--cpv2-text-muted)', fontWeight: 600 }}>Ressarcimento da UC</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--cpv2-success)', fontVariantNumeric: 'tabular-nums' }}>{fmtCurrency(ressUCTotal)}</div>
                </div>
              )}
              {/* Resultado da análise no cabeçalho (aparece após rodar a IA) */}
              {analiseV19Veredito && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '4px 12px', borderRadius: 999,
                  background: analiseV19Veredito.apontado
                    ? 'color-mix(in srgb, var(--cpv2-success) 15%, transparent)'
                    : 'var(--cpv2-surface-2)',
                  border: `2px solid ${analiseV19Veredito.apontado ? 'var(--cpv2-success)' : 'var(--cpv2-border)'}`,
                }}>
                  <span style={{ fontWeight: 800, fontSize: 13, color: analiseV19Veredito.apontado ? 'var(--cpv2-success)' : 'var(--cpv2-text-muted)' }}>
                    {analiseV19Veredito.apontado ? '✅ APONTADO' : '⛔ NÃO APONTADO'}
                  </span>
                  {(analiseV19Veredito.ressarcimento_estimado || 0) > 0 && (
                    <span style={{ fontWeight: 800, fontSize: 15, color: 'var(--cpv2-success)' }}>
                      {fmtCurrency(analiseV19Veredito.ressarcimento_estimado)}
                    </span>
                  )}
                  {analiseV19Veredito.confianca ? (
                    <span style={{ fontSize: 12, opacity: 0.7 }}>· {analiseV19Veredito.confianca}%</span>
                  ) : null}
                </div>
              )}
              <GateChip gate={gate} />
              <button
                className="cpv2-btn cpv2-btn--ghost cpv2-btn--sm"
                onClick={() => setEditarOpen(true)}
                title="Corrigir dados extraídos (auditado)"
              >
                <Pencil size={13} /> Corrigir dados
              </button>
              <button className="cpv2-modal__close" onClick={onClose} title="Fechar (Esc)">
                <X size={18} />
              </button>
            </div>
          </div>

          <ModalCorrigirDadosFatura
            open={editarOpen}
            fatura={fatura}
            onClose={() => setEditarOpen(false)}
            onSaved={() => {
              setEditarOpen(false);
              // força reload da fatura
              setCarregandoFatura(true);
              apiClient
                .get('/api/v1/faturas-extraidas/' + encodeURIComponent(uidFatura || ''))
                .then((res) => setFatura(res.data || {}))
                .finally(() => setCarregandoFatura(false));
            }}
          />

          {/* Modal comparativo: FDE × sgeeasy × IA (gpt-5.4-mini) */}
          <ModalAuditoriaComparativa
            isOpen={comparativoAberto}
            onClose={() => setComparativoAberto(false)}
            faturaId={idFatura}
            // Passa o mesmo ressarcimento exibido na LINHA da tabela (calcRessEstimado)
            // pra o modal usar o valor idêntico ao da UI.
            ressarcimentoEstimado={apont?.ressarcimento}
            desvioPctMax={apont?.desvioPct}
            valorEnergiaAtiva={
              (row && (Number(row.valor_energia_ativa) || Number(row.valor_energia) || 0)) || undefined
            }
            linkFatura={linkPrincipal}
            onGerarRequisicao={(auditoria) => {
              setComparativoAberto(false);
              try { console.info('[gerar-req] payload IA:', auditoria); } catch {}
            }}
          />

          {/* ── Sub-modal "OCR com IA": extrai as faturas da unidade e mostra o resultado aqui ── */}
          {ocrOpen && (
            <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(15,20,35,0.55)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
              onClick={() => { if (ocrPhase !== 'running') setOcrOpen(false); }}>
              <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--cpv2-surface)', border: '1px solid var(--cpv2-border)', borderRadius: 12, width: 'min(760px, 96%)', maxHeight: '86vh', overflowY: 'auto', boxShadow: '0 20px 60px -20px rgba(20,30,60,.45)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', borderBottom: '1px solid var(--cpv2-border)' }}>
                  <div style={{ fontWeight: 700 }}>🤖 OCR com IA — unidade {uc || '—'}</div>
                  <button className="cpv2-btn cpv2-btn--ghost cpv2-btn--sm" onClick={() => { if (ocrPhase !== 'running') setOcrOpen(false); }} disabled={ocrPhase === 'running'}>Fechar</button>
                </div>
                <div style={{ padding: '14px 16px' }}>
                  {ocrPhase === 'error' ? (
                    <div className="cpv2-empty cpv2-empty--error">{ocrErro || 'Falha no OCR.'}</div>
                  ) : ocrPhase !== 'done' ? (
                    <div>
                      <div style={{ fontSize: 13, marginBottom: 8 }}>{ocrStatus?.etapa || 'Processando…'}</div>
                      <div style={{ height: 8, background: 'var(--cpv2-surface-2)', borderRadius: 6, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${ocrStatus?.total ? Math.round(((ocrStatus.prontas || 0) / ocrStatus.total) * 100) : 12}%`, background: 'var(--cpv2-brand)', transition: 'width .3s' }} />
                      </div>
                      <div className="cpv2-muted-sm" style={{ marginTop: 6 }}>
                        {ocrStatus ? `${ocrStatus.prontas || 0}/${ocrStatus.total || 0} faturas${ocrStatus.erros ? ` · ${ocrStatus.erros} erro(s)` : ''}` : ''} — extraindo e testando o apontamento…
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div style={{ fontSize: 13, marginBottom: 10 }}>
                        <b>{Array.isArray(ocrReport) ? ocrReport.length : 0}</b> fatura(s) da unidade extraídas. Consumo re-extraído vs o apontamento:
                      </div>
                      <div style={{ overflowX: 'auto' }}>
                        <table className="cpv2-table" style={{ fontSize: '12px' }}>
                          <thead><tr><th>Mês</th><th style={{ textAlign: 'right' }}>Consumo (kWh)</th><th style={{ textAlign: 'right' }}>Total (R$)</th><th>Arquivo</th></tr></thead>
                          <tbody>
                            {(ocrReport || []).map((it, i) => {
                              const mesv = first(it.mes_referencia, it.mes_ref, it.mes, it.MES);
                              const kv = num(first(it.kwh_total, it.consumo_kwh, it.consumo, it.KWH_Total));
                              const vv = num(first(it.valor_total_fatura, it.total_rs, it.valor_total, it.RS_Total_Fatura));
                              return (
                                <tr key={i} className="cpv2-row" style={{ cursor: 'default' }}>
                                  <td className="cpv2-mono">{mesv ? fmtMesRef(mesv) : '—'}</td>
                                  <td className="cpv2-num" style={{ fontVariantNumeric: 'tabular-nums' }}>{kv != null ? nf0(kv) : '—'}</td>
                                  <td className="cpv2-num" style={{ fontVariantNumeric: 'tabular-nums' }}>{vv != null ? fmtCurrency(vv) : '—'}</td>
                                  <td className="cpv2-muted-sm">{first(it.arquivo, it.file, it.nome, it.pdf) || ''}</td>
                                </tr>
                              );
                            })}
                            {(!ocrReport || ocrReport.length === 0) && (
                              <tr><td colSpan={4} className="cpv2-muted-sm" style={{ textAlign: 'center' }}>Sem itens no relatório.</td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="cpv2-modal__body" style={{ flex: 1, overflowY: 'auto', padding: '14px 12px', display: 'flex', flexDirection: 'column' }}>
            {/* ── Aviso de parcelamento Art.113 — SEMPRE analisar ── */}
            {(Number(fatura.flag_acumulo_art113) === 1 || Number(row?.tem_parcelamento) === 1 || row?.tem_parcelamento === true) && (
              <div style={{
                border: '1px solid var(--cpv2-danger)', borderRadius: 8,
                background: 'color-mix(in srgb, var(--cpv2-danger) 10%, transparent)',
                padding: '10px 12px', marginBottom: 10, fontSize: 13, fontWeight: 600,
                color: 'var(--cpv2-danger)',
              }}>
                ⚠️ TEM PARCELAMENTO (Art.113) — SEMPRE analisar.
                {Number(fatura.kwh_acumulado_art113) > 0 && (
                  <span style={{ fontWeight: 400 }}>
                    {' '}Consumo acumulado recuperado: <b>{nf0(fatura.kwh_acumulado_art113)} kWh</b>.
                  </span>
                )}
              </div>
            )}

            {/* ── Painel de auditoria assistida (semáforos + chat) — empurrado p/ o fim ── */}
            <div style={{
              order: 6,
              border: '1px solid var(--cpv2-border)', borderRadius: 8,
              background: 'var(--cpv2-surface)', padding: '10px 12px', marginBottom: 10, marginTop: 14,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {/* Tri-fonte (parser × SEFAZ × itens) */}
                <span title={`Total fatura vs SEFAZ vs itens — ${sinais.triLabel}`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600,
                    padding: '3px 9px', borderRadius: 999,
                    color: corSinal(sinais.triNivel),
                    background: 'color-mix(in srgb, ' + corSinal(sinais.triNivel) + ' 12%, transparent)',
                    border: '1px solid ' + corSinal(sinais.triNivel),
                  }}>
                  {sinais.triNivel === 'ok' ? '🟢' : sinais.triNivel === 'atencao' ? '🟡' : sinais.triNivel === 'diverge' ? '🔴' : '⚪'}
                  Tri-fonte: {sinais.triLabel}
                </span>
                {/* Solidez do apontamento */}
                {sinais.solidezPct != null && (
                  <span title="Solidez do apontamento (aritmética + SEFAZ + base ≥ 3m + score + sem faturamento por média)"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600,
                      padding: '3px 9px', borderRadius: 999,
                      color: corSinal(sinais.solidezNivel),
                      background: 'color-mix(in srgb, ' + corSinal(sinais.solidezNivel) + ' 12%, transparent)',
                      border: '1px solid ' + corSinal(sinais.solidezNivel),
                    }}>
                    Solidez {sinais.solidezPct}%
                  </span>
                )}
                {/* Confiança da extração */}
                {sinais.scoreN != null && (
                  <span title="Score de confiança da extração"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600,
                      padding: '3px 9px', borderRadius: 999,
                      color: corSinal(sinais.scoreN >= 85 ? 'ok' : sinais.scoreN >= 60 ? 'atencao' : 'diverge'),
                      background: 'var(--cpv2-surface-2)', border: '1px solid var(--cpv2-border)',
                    }}>
                    Extração {sinais.scoreN}%
                  </span>
                )}
                {sinais.faturamentoMedia && (
                  <span style={{
                    fontSize: 11.5, fontWeight: 600, padding: '3px 9px', borderRadius: 999,
                    color: 'var(--cpv2-warning)', border: '1px solid var(--cpv2-warning)',
                    background: 'color-mix(in srgb, var(--cpv2-warning) 12%, transparent)',
                  }}>⚠️ Faturamento por média</span>
                )}

                <div style={{ flex: 1 }} />

                {ehSgeeasy ? (<>
                  <span style={{ fontSize: 12, color: 'var(--cpv2-text-muted)', fontStyle: 'italic', marginRight: 8, alignSelf: 'center' }}>
                    Apontamento do sgeeasy (sem registro na FDE) — auditoria/IA indisponível.
                  </span>
                  <button className="cpv2-btn cpv2-btn--primary" onClick={abrirConfirmarErro}
                    style={{ background: 'var(--cpv2-success)', borderColor: 'var(--cpv2-success)' }}
                    title="Criar requisição a partir deste apontamento sgeeasy (mesmo fluxo do FDE)">
                    ✓ Criar requisição
                  </button>
                  <button className="cpv2-btn" onClick={rejeitarSgeeasy} disabled={rejeitandoSg}
                    style={{ background: 'var(--cpv2-danger)', borderColor: 'var(--cpv2-danger)', color: '#fff' }}
                    title="Rejeitar o apontamento sgeeasy — sai dos Inconclusivos">
                    {rejeitandoSg ? '⏳ Rejeitando…' : '✕ Rejeitar apontamento'}
                  </button>
                </>) : (<>
                {/* "Auditar valores" e "Analisar fatura (IA)" removidos a pedido (re-skin 07/08). */}
                <button className="cpv2-btn" onClick={() => setChatAberto((v) => !v)} disabled={!idFatura}>
                  💬 {chatAberto ? 'Fechar chat' : 'Chat'}
                </button>
                {/* Confirmar erro / Rejeitar movidos p/ o card do grid (ações) — removidos daqui */}
                </>)}
              </div>

              {/* Painel de escolha do MOTIVO da rejeição (analista escolhe) */}
              {rejeitarAberto && (
                <div style={{
                  marginTop: 8, padding: '10px 12px', borderRadius: 8,
                  background: 'var(--cpv2-surface-2)', border: '2px solid var(--cpv2-danger)',
                }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 8 }}>
                    Por que rejeitar este apontamento?
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {MOTIVOS_REJEICAO.map((mot) => (
                      <button
                        key={mot}
                        type="button"
                        className="cpv2-btn cpv2-btn--sm"
                        onClick={() => confirmarRejeicao(mot)}
                        disabled={rejeitando}
                        style={{ borderColor: 'var(--cpv2-danger)' }}
                      >
                        {mot}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="cpv2-btn cpv2-btn--sm cpv2-btn--ghost"
                      onClick={() => setRejeitarAberto(false)}
                      disabled={rejeitando}
                    >
                      Cancelar
                    </button>
                  </div>
                  <div className="cpv2-muted-sm" style={{ marginTop: 6 }}>
                    O motivo escolhido fica registrado na rejeição.
                  </div>
                </div>
              )}

              {/* Resultado da auditoria (gpt-5.4-mini) */}
              {auditErro && (
                <div className="cpv2-empty cpv2-empty--error" style={{ marginTop: 10 }}>{auditErro}</div>
              )}
              {auditResult && (() => {
                const up = auditResult.toUpperCase();
                let vNivel = null, vLabel = '';
                if (up.includes('ERRO CONFIRMADO')) { vNivel = 'diverge'; vLabel = 'ERRO CONFIRMADO'; }
                else if (up.includes('SEM ERRO')) { vNivel = 'ok'; vLabel = 'SEM ERRO'; }
                else if (up.includes('INCONCLUSIVO')) { vNivel = 'atencao'; vLabel = 'INCONCLUSIVO'; }
                const cor = corSinal(vNivel || 'na');
                return (
                  <div style={{
                    marginTop: 10, padding: '10px 12px', borderRadius: 6,
                    background: 'var(--cpv2-surface-2)',
                    border: `1px solid ${vNivel ? cor : 'var(--cpv2-border)'}`,
                    fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                  }}>
                    <div className="cpv2-detail__label" style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                      Conferência do erro · gpt-5.4-mini
                      {vLabel && (
                        <span style={{ padding: '2px 9px', borderRadius: 999, fontWeight: 700, fontSize: 11, color: '#fff', background: cor }}>
                          {vLabel}
                        </span>
                      )}
                    </div>
                    {auditResult}
                  </div>
                );
              })()}

              {/* Resultado — Analisar todas faturas (histórico da UC) */}
              {analiseTodas && (
                <div style={{
                  marginTop: 10, padding: '10px 12px', borderRadius: 6,
                  background: 'var(--cpv2-surface-2)', border: '1px solid var(--cpv2-info)',
                  fontSize: 12.5, lineHeight: 1.6,
                }}>
                  <div className="cpv2-detail__label" style={{ marginBottom: 6 }}>
                    📊 Análise de todas as faturas da UC
                  </div>
                  {analiseTodas.erro ? (
                    <div style={{ color: 'var(--cpv2-text-muted)' }}>{analiseTodas.erro}</div>
                  ) : (
                    <>
                      <div style={{ marginBottom: 6 }}>{analiseTodas.texto}</div>
                      <div style={{ marginBottom: 6 }}>
                        Média histórica: <strong>{nf0(analiseTodas.media)} kWh</strong> ·
                        {' '}Meses analisados: {analiseTodas.totalMeses} ·
                        {' '}Apontamentos (≥ +100%): <strong>{analiseTodas.apont.length}</strong>
                      </div>
                      {analiseTodas.apont.length > 0 && (
                        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                          <thead>
                            <tr style={{ textAlign: 'left', opacity: 0.7 }}>
                              <th style={{ padding: '2px 6px' }}>Mês</th>
                              <th style={{ padding: '2px 6px' }}>Consumo</th>
                              <th style={{ padding: '2px 6px' }}>Desvio</th>
                            </tr>
                          </thead>
                          <tbody>
                            {analiseTodas.apont.map((a) => (
                              <tr key={a.id || a.mes} style={{ borderTop: '1px solid var(--cpv2-border)' }}>
                                <td style={{ padding: '2px 6px' }}>{a.mes}</td>
                                <td style={{ padding: '2px 6px' }}>{nf0(a.kwh)} kWh</td>
                                <td style={{ padding: '2px 6px', color: 'var(--cpv2-info)', fontWeight: 700 }}>
                                  +{a.desvioPct.toFixed(0)}%
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Estado de "analisando" da IA (a chamada leva 30-60s). Antes o
                  único feedback era o texto do botão — parecia travado. */}
              {(analisandoV19 || analisandoTodas) && (
                <div style={{
                  marginTop: 10, padding: '12px 14px', borderRadius: 8,
                  background: 'var(--cpv2-surface-2)', border: '1px solid var(--cpv2-purple)',
                  display: 'flex', alignItems: 'center', gap: 12,
                }}>
                  <span className="cpv2-ia-spinner" aria-hidden="true" />
                  <div>
                    <div style={{ fontWeight: 700 }}>
                      {analisandoV19 ? 'Analisando a fatura com IA…' : 'Analisando todas as faturas da UC…'}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Pode levar até 1 minuto — pode continuar navegando no modal.</div>
                  </div>
                </div>
              )}

              {/* Resultado da análise v19 (prompt canônico F01-F05) */}
              {analiseV19Erro && (
                <div className="cpv2-empty cpv2-empty--error" style={{ marginTop: 10 }}>{analiseV19Erro}</div>
              )}

              {/* Veredito estruturado do v19: apontado? + ressarcimento estimado + abrir requisição */}
              {analiseV19Veredito && (
                <div style={{
                  marginTop: 10, padding: '12px 14px', borderRadius: 8,
                  background: 'var(--cpv2-surface-2)',
                  border: `2px solid ${analiseV19Veredito.apontado ? 'var(--cpv2-success)' : 'var(--cpv2-border)'}`,
                }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span style={{ fontWeight: 800, fontSize: 15, color: analiseV19Veredito.apontado ? 'var(--cpv2-success)' : 'var(--cpv2-text-muted)' }}>
                        {analiseV19Veredito.apontado ? '✅ Caso apontado' : '⛔ Não apontado'}
                      </span>
                      <span style={{ fontSize: 12, opacity: 0.8 }}>
                        Decisão: <strong>{analiseV19Veredito.decisao || '—'}</strong>
                        {analiseV19Veredito.confianca ? ` · confiança ${analiseV19Veredito.confianca}%` : ''}
                      </span>
                    </div>
                    {/* Destaque do ressarcimento estimado */}
                    <div style={{
                      textAlign: 'right', padding: '6px 14px', borderRadius: 8,
                      background: analiseV19Veredito.apontado ? 'color-mix(in srgb, var(--cpv2-success) 12%, transparent)' : 'transparent',
                    }}>
                      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--cpv2-text-muted)' }}>Ressarcimento estimado</div>
                      <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1.1, color: analiseV19Veredito.apontado ? 'var(--cpv2-success)' : 'var(--cpv2-text-muted)' }}>
                        {fmtCurrency(analiseV19Veredito.ressarcimento_estimado || 0)}
                      </div>
                      {analiseV19Veredito.percentual_ressarcimento ? (
                        <div style={{ fontSize: 11, opacity: 0.7 }}>{analiseV19Veredito.percentual_ressarcimento}% da fatura</div>
                      ) : null}
                    </div>
                  </div>
                  {/* Chip do mapa de layout usado */}
                  {analiseV19Mapa && (
                    <div style={{ marginTop: 8, fontSize: 11, color: 'var(--cpv2-text-muted)' }}>
                      {analiseV19Mapa.encontrado
                        ? <>🗺️ Interpretado com o mapa da distribuidora: <strong>{analiseV19Mapa.mapa}</strong>{analiseV19Mapa.filial ? ` · ${analiseV19Mapa.filial}` : ''}</>
                        : <>🗺️ Sem mapa específico para <strong>{analiseV19Mapa.distribuidora || 'esta distribuidora'}</strong> — análise genérica.</>}
                    </div>
                  )}
                  {analiseV19Veredito.apontado && (analiseV19Veredito.ressarcimento_estimado || 0) > 0 && (
                    <button
                      type="button"
                      className="cpv2-btn cpv2-btn--primary cpv2-btn--sm"
                      style={{ marginTop: 10 }}
                      onClick={() => abrirConfirmarErro(analiseV19Veredito.ressarcimento_estimado)}
                    >
                      📝 Abrir requisição com esses dados
                    </button>
                  )}
                </div>
              )}

              {/* Aviso: análise rodou mas NÃO foi possível interpretar a decisão.
                  Evita mostrar um falso "⛔ não apontado / R$ 0,00". */}
              {analiseV19 && !analiseV19Interpretado && (
                <div style={{
                  marginTop: 10, padding: '10px 12px', borderRadius: 8,
                  background: 'var(--cpv2-warning-soft)', border: '2px solid var(--cpv2-warning)',
                  fontSize: 13, color: 'var(--cpv2-text)',
                }}>
                  ⚠️ <strong>Não foi possível interpretar o veredito</strong> desta análise
                  (a IA não retornou uma decisão clara). Isso <u>não</u> significa "sem erro" —
                  abra a análise completa abaixo e avalie manualmente.
                </div>
              )}

              {/* Dados da análise: comparação IA × parser (normalizados/campo a campo) */}
              {analiseV19Dados && (
                <div style={{
                  marginTop: 10, padding: '10px 12px', borderRadius: 8,
                  background: 'var(--cpv2-surface-2)', border: '1px solid var(--cpv2-purple)',
                }}>
                  <div className="cpv2-detail__label" style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                    🧠 Dados da análise · IA × parser
                  </div>
                  <ComparativoIAFatura fatura={fatura} dados={analiseV19Dados} />
                </div>
              )}

              {/* (o painel "O que observar" é único, no topo — já reflete os
                  dados da análise após rodá-la, sem duplicar) */}

              {/* Texto completo da análise (recolhido por padrão) */}
              {analiseV19 && (
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="cpv2-btn cpv2-btn--ghost cpv2-btn--sm"
                    onClick={() => setAnaliseV19VerTexto((v) => !v)}
                  >
                    {analiseV19VerTexto ? '▲ Ocultar análise completa (texto)' : '▼ Ver análise completa (texto)'}
                  </button>
                  {analiseV19VerTexto && (
                    <div style={{
                      marginTop: 6, padding: '10px 12px', borderRadius: 6,
                      background: 'var(--cpv2-surface-2)', border: '1px solid var(--cpv2-border)',
                      fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                      maxHeight: 500, overflowY: 'auto',
                    }}>
                      {analiseV19}
                    </div>
                  )}
                </div>
              )}

              {/* Chat (gpt-5.4-nano) */}
              {chatAberto && (
                <div style={{ marginTop: 10, border: '1px solid var(--cpv2-border)', borderRadius: 6, background: 'var(--cpv2-surface-2)' }}>
                  {mesFoco && (
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                      padding: '6px 12px', borderBottom: '1px solid var(--cpv2-border)',
                      fontSize: 12, background: 'var(--cpv2-warning-soft)',
                    }}>
                      <span>
                        📊 Analisando o mês <strong>{mesFoco.mes}</strong> — {nf0(mesFoco.kwh)} kWh
                        {mesFoco.desvioPct != null && ` (${mesFoco.desvioPct >= 0 ? '+' : ''}${mesFoco.desvioPct.toFixed(1)}% vs média)`}
                      </span>
                      <button
                        type="button"
                        className="cpv2-btn cpv2-btn--ghost cpv2-btn--sm"
                        onClick={() => setMesFoco(null)}
                        title="Remover foco do mês"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                  <div style={{ maxHeight: 260, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {chatMsgs.length === 0 && (
                      <div className="cpv2-muted-sm" style={{ textAlign: 'center', padding: '8px 0' }}>
                        Pergunte sobre esta fatura — ex.: "por que o consumo saiu da média?", "o total confere com o SEFAZ?"
                      </div>
                    )}
                    {chatMsgs.map((m, i) => (
                      <div key={i} style={{
                        alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                        maxWidth: '85%', padding: '7px 10px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.5,
                        whiteSpace: 'pre-wrap',
                        background: m.role === 'user' ? 'var(--cpv2-brand-soft)' : 'var(--cpv2-surface)',
                        border: '1px solid var(--cpv2-border)',
                      }}>{m.content}</div>
                    ))}
                    {chatEnviando && <div className="cpv2-muted-sm" style={{ alignSelf: 'flex-start' }}>⏳ pensando…</div>}
                    <div ref={chatFimRef} />
                  </div>
                  <div style={{ display: 'flex', gap: 6, padding: '8px 10px', borderTop: '1px solid var(--cpv2-border)' }}>
                    <input
                      style={{
                        flex: 1, padding: '7px 10px', fontSize: 12.5,
                        border: '1px solid var(--cpv2-border)', borderRadius: 6,
                        background: 'var(--cpv2-surface)', color: 'var(--cpv2-text)',
                      }}
                      placeholder="Pergunte sobre o apontamento…"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviarChat(); } }}
                      disabled={chatEnviando}
                    />
                    <button className="cpv2-btn cpv2-btn--primary" onClick={enviarChat} disabled={chatEnviando || !chatInput.trim()}>
                      Enviar
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* "O que observar" (ChecklistObservar) removido a pedido — substituído
                pelas observações data-driven no card do parecer (grid acima). */}

            {/* KPI-strip movido p/ o card esquerdo do grid */}

            {/* parecer do sistema movido p/ o card direito do grid */}

            {/* ── Gráfico de consumo mensal (hero — puxado p/ topo via order) ── */}
            <div style={{ order: -2 }}>
            {carregandoHist ? (
              <div className="cpv2-loading">Carregando histórico da UC…</div>
            ) : erroHist ? (
              <div className="cpv2-empty cpv2-empty--error">{erroHist}</div>
            ) : dadosGrafico.length > 0 ? (
              <div style={{
                border: '1px solid var(--cpv2-border)', borderRadius: 8,
                background: 'var(--cpv2-surface-2)', padding: '10px 12px 4px', marginBottom: 8,
              }}>
                <div className="cpv2-detail__label" style={{ marginBottom: 6 }}>
                  Evolução mensal · consumo (kWh) e valor (R$)
                </div>
                <ResponsiveContainer width="100%" height={340}>
                  <ComposedChart
                    data={dadosGrafico}
                    onClick={(e) => {
                      const p = e && e.activePayload && e.activePayload[0] && e.activePayload[0].payload;
                      if (!p) return;
                      const media = apont?.media || 0;
                      const desvioPct = media > 0 ? ((Number(p.kwh) - media) / media) * 100 : null;
                      setMesFoco({ mes: p.mes, kwh: Number(p.kwh) || 0, media, desvioPct });
                      setChatAberto(true);
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <CartesianGrid stroke="var(--cpv2-border)" strokeDasharray="3 3" />
                    {apont && apont.sigma > 0 && (
                      <ReferenceArea yAxisId="kwh" y1={Math.max(0, apont.media - apont.sigma)} y2={apont.media + apont.sigma}
                        fill="var(--cpv2-text-muted)" fillOpacity={0.13} strokeOpacity={0} />
                    )}
                    {apont && (
                      <ReferenceLine yAxisId="kwh" y={apont.media} stroke="var(--cpv2-warning)" strokeDasharray="4 3"
                        label={{ value: 'média 12m', position: 'insideTopRight', fontSize: 9, fill: 'var(--cpv2-text-muted)' }} />
                    )}
                    <XAxis dataKey="mes" tick={{ fontSize: 10, fill: 'var(--cpv2-text-muted)' }} />
                    <YAxis yAxisId="kwh" orientation="left" tick={{ fontSize: 10, fill: 'var(--cpv2-text-muted)' }}
                      domain={kwhDomain || undefined} allowDataOverflow={!!kwhDomain} />
                    <YAxis yAxisId="rs" orientation="right" tick={{ fontSize: 10, fill: 'var(--cpv2-text-muted)' }} />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--cpv2-surface)', border: '1px solid var(--cpv2-border)',
                        borderRadius: 6, fontSize: 11.5, color: 'var(--cpv2-text)',
                      }}
                      formatter={(value, name) => name === 'valor'
                        ? [fmtCurrency(value), 'Valor']
                        : [Number(value).toLocaleString('pt-BR'), 'kWh']}
                    />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <Bar yAxisId="kwh" dataKey="kwh" name="kWh" radius={[3, 3, 0, 0]}>
                      {dadosGrafico.map((d, i) => {
                        // Vermelho em TODOS os meses apontados da UC + o mês do salto/acúmulo.
                        // Contorno só no mês da fatura em análise (pra localizá-lo).
                        const destaque = d.apontado || (i === saltoIdx);
                        return (
                          <Cell key={i}
                            fill={destaque ? 'var(--cpv2-danger)' : 'var(--cpv2-brand)'}
                            stroke={d.atual ? 'var(--cpv2-text)' : undefined}
                            strokeWidth={d.atual ? 2 : 0} />
                        );
                      })}
                    </Bar>
                    <Line yAxisId="rs" dataKey="valor" stroke="var(--cpv2-success)" strokeWidth={2} name="valor" dot={{ r: 2 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="cpv2-empty" style={{ padding: '24px' }}>Sem histórico de consumo para esta UC.</div>
            )}
            </div>

            {/* ── Apontamentos desta UC (mesma unidade, vários meses) — clique troca o mês ── */}
            <div style={{ order: -1 }}>
            {Array.isArray(apontsView) && apontsView.length > 1 && (
              <div style={{ margin: '12px 0 2px' }}>
                <div style={{ fontSize: 10.5, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--cpv2-text-muted)', fontWeight: 700, marginBottom: 7 }}>
                  Apontamentos desta UC ({apontsView.length}) — clique para carregar o mês
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {[...apontsView]
                    .sort((a, b) => String(a.mes_referencia ?? a.Mes_Ref ?? a.mes_ref ?? '').localeCompare(String(b.mes_referencia ?? b.Mes_Ref ?? b.mes_ref ?? '')))
                    .map((a) => {
                      const aid = a?.id ?? a?.Id;
                      const cur = Number(aid) === Number(idFatura);
                      const dv = Number(a.desvio_pct_max ?? a.desvio_pct ?? 0);
                      const rs = Number(a.ressarcimento_estimado ?? 0);
                      return (
                        <button key={aid} type="button"
                          onClick={() => { if (!cur && onSwitchFatura) onSwitchFatura(a); }}
                          title={cur ? 'Mês em análise' : 'Carregar este mês nesta tela'}
                          style={{
                            cursor: cur ? 'default' : 'pointer', textAlign: 'left', font: 'inherit',
                            border: `1px solid ${cur ? 'var(--cpv2-accent)' : 'var(--cpv2-border)'}`,
                            borderLeft: '4px solid var(--cpv2-danger)', borderRadius: 9, padding: '7px 12px',
                            background: cur ? 'color-mix(in srgb, var(--cpv2-accent) 12%, transparent)' : 'var(--cpv2-surface)',
                            minWidth: 126,
                          }}>
                          <div style={{ fontSize: 14, fontWeight: 700 }}>
                            {fmtMesRef(a.mes_referencia ?? a.Mes_Ref ?? a.mes_ref ?? '')}{cur ? ' •' : ''}
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--cpv2-text-muted)' }}>
                            {dv ? `+${dv.toFixed(0)}%` : ''}{rs > 0 ? ` · ${fmtCurrency(rs)}` : ''}
                          </div>
                        </button>
                      );
                    })}
                </div>
              </div>
            )}
            </div>

            {/* ── DETALHE master-detail (mockup): esquerda KPIs+cálculo | direita parecer+ações ── */}
            <div style={{ order: -1, display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 12, marginBottom: 12 }} className="cpv2-detail-grid-md">
              {/* Esquerda: KPIs + cálculo do ressarcimento */}
              <div style={{ border: '1px solid var(--cpv2-border)', borderRadius: 10, background: 'var(--cpv2-surface)', padding: '14px 16px' }}>
                {apont ? (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px,1fr))', gap: 10, marginBottom: 12 }}>
                      {[
                        { l: 'Consumo do mês', v: nf0(apont.consumoAtual), u: 'kWh', c: 'var(--cpv2-text)' },
                        { l: `Média (${apont.baseN}m)`, v: nf0(apont.media), u: 'kWh', c: 'var(--cpv2-text)' },
                        { l: 'Desvio', v: `${apont.desvioPct >= 0 ? '+' : ''}${apont.desvioPct.toFixed(0)}%`, u: '', c: apont.desvioPct >= 200 ? 'var(--cpv2-danger)' : apont.desvioPct >= 100 ? 'var(--cpv2-warning)' : 'var(--cpv2-success)' },
                        { l: 'Ressarcimento', v: ressExibido > 0 ? fmtCurrency(ressExibido) : '—', u: '', c: ressExibido > 0 ? 'var(--cpv2-success)' : 'var(--cpv2-text-muted)' },
                      ].map((k) => (
                        <div key={k.l} style={{ background: 'var(--cpv2-surface-2)', borderRadius: 9, padding: '10px 12px' }}>
                          <div className="cpv2-detail__label">{k.l}</div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: k.c, fontVariantNumeric: 'tabular-nums' }}>
                            {k.v}{k.u ? <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--cpv2-text-muted)' }}> {k.u}</span> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                    {/* Observações data-driven (substituem o antigo "O que observar") */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 12 }}>
                      {[
                        { c: 'var(--cpv2-danger)', t: <>Consumo <b>{nf0(apont.consumoAtual)} kWh</b> vs média <b>{nf0(apont.media)} kWh</b> (<b>{apont.desvioPct >= 0 ? '+' : ''}{apont.desvioPct.toFixed(0)}%</b>). {apont.desvioPct >= 200 ? 'Acima de 200% = pico.' : apont.desvioPct >= 100 ? 'Entre 100–200% = desvio alto.' : 'Abaixo de 100%.'}</> },
                        { c: 'var(--cpv2-success)', t: sinais?.faturamentoMedia
                            ? <>⚠️ Houve <b>faturamento por média/estimativa</b> no histórico — o mínimo puxa a média pra baixo e pode inflar o desvio. Conferir o parecer ao lado.</>
                            : <>Base de <b>{apont.baseN} meses</b> de leitura real. {apont.baseN < 3 ? 'Base curta — confirmar com as faturas seguintes.' : ''}</> },
                        { c: 'var(--cpv2-accent)', t: <>Ressarcimento = <b>excedente × tarifa de energia</b> (R$/kWh) — nunca o total da conta (que inclui ICMS/TUSD/demanda).</> },
                      ].map((o, i) => (
                        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.45 }}>
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: o.c, marginTop: 6, flex: 'none' }} />
                          <span>{o.t}</span>
                        </div>
                      ))}
                    </div>
                    {apont.rsKwh > 0 ? (
                      <div style={{ background: 'var(--cpv2-surface-2)', borderRadius: 9, padding: '11px 13px' }}>
                        <div className="cpv2-detail__label">Ressarcimento estimado</div>
                        <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--cpv2-text-muted)', marginTop: 3 }}>
                          ({nf0(apont.consumoAtual)} − {nf0(apont.media)}) kWh × {fmtCurrency(apont.rsKwh)}/kWh
                        </div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--cpv2-success)', marginTop: 5 }}>{fmtCurrency(apont.ressarcimento)}</div>
                      </div>
                    ) : (
                      <div style={{ fontSize: 12.5, color: 'var(--cpv2-text-muted)' }}>
                        Ressarcimento não estimável — sem valor de energia (R$/kWh) confiável nesta fatura.
                      </div>
                    )}
                  </>
                ) : (
                  <div className="cpv2-muted-sm">Sem base de histórico suficiente para o cálculo do apontamento.</div>
                )}
              </div>
              {/* Direita: ações do analista. Parecer + Abrir fatura + OCR com IA removidos daqui
                  a pedido (veredito fica na pílula do cabeçalho; Abrir fatura/OCR com IA no rodapé). */}
              <div style={{ border: '1px solid var(--cpv2-border)', borderRadius: 10, background: 'var(--cpv2-surface)', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="cpv2-section-title" style={{ margin: 0 }}>Ações</div>
                {obsAtual && (
                  <div style={{ fontSize: 12, lineHeight: 1.45, background: 'var(--cpv2-surface-2)', borderRadius: 8, padding: '8px 10px' }}>
                    <b>Observação:</b> {obsAtual}
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 'auto' }}>
                  <button className="cpv2-btn cpv2-btn--primary" onClick={() => abrirConfirmarErro()} disabled={!idFatura}
                    style={{ background: 'var(--cpv2-success)', borderColor: 'var(--cpv2-success)' }}>✓ Confirmar erro</button>
                  <button className="cpv2-btn" onClick={() => { const mot = window.prompt('Motivo da rejeição:', 'Falso positivo'); if (mot) confirmarRejeicao(mot); }} disabled={rejeitando || !idFatura}
                    style={{ background: 'var(--cpv2-danger)', borderColor: 'var(--cpv2-danger)', color: '#fff' }}>
                    {rejeitando ? '⏳ Rejeitando…' : '✕ Rejeitar'}
                  </button>
                  <button className="cpv2-btn" onClick={editarObsAnalista} disabled={!idFatura}
                    style={obsAtual ? { borderColor: 'var(--cpv2-accent)', color: 'var(--cpv2-accent)' } : {}}>
                    {obsAtual ? '📝 Editar observação' : '📝 Adicionar observação'}
                  </button>
                </div>
              </div>
            </div>

            {/* cálculo do apontamento movido p/ o card esquerdo do grid */}

            {/* ── Painel de criação de requisição (abaixo do gráfico; só após "Confirmar erro") ── */}
            {confirmarErro && reqForm && (
              <div style={{
                border: '1px solid var(--cpv2-brand)', borderRadius: 8,
                background: 'linear-gradient(135deg, var(--cpv2-brand-soft) 0%, var(--cpv2-surface) 60%)',
                padding: '12px 14px', marginBottom: 12,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <div className="cpv2-section-title" style={{ margin: 0 }}>📝 Criar requisição</div>
                  <button className="cpv2-btn" onClick={() => setConfirmarErro(false)}>Fechar</button>
                </div>

                {reqOk ? (
                  <div style={{ padding: '10px 2px', color: 'var(--cpv2-success)', fontWeight: 600, fontSize: 14 }}>
                    ✓ {reqOk}
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <ReqCampo label="UC" value={reqForm.uc} onChange={updReq('uc')} />
                      <ReqCampo label="Concessionária" value={reqForm.concessionaria} onChange={updReq('concessionaria')} />
                      <ReqCampo label="Cliente / Razão social" value={reqForm.cliente} onChange={updReq('cliente')} full />
                      <ReqCampo label="Mês referência" value={reqForm.mes_ref} onChange={updReq('mes_ref')} />
                      <ReqCampo label="Fichas" value={reqForm.fichas} onChange={updReq('fichas')} />
                      <div>
                        <div className="cpv2-detail__label">Tipo de irregularidade</div>
                        <select className="cpv2-select" style={{ width: '100%' }}
                          value={reqForm.id_tipo_irregularidade}
                          onChange={(e) => setReqForm((f) => ({ ...f, id_tipo_irregularidade: e.target.value, id_subtipo_irregularidade: '' }))}>
                          <option value="">— selecione —</option>
                          {tiposLista.map((t) => (
                            <option key={t.id_tipo ?? t.id} value={t.id_tipo ?? t.id}>{t.nome ?? t.label ?? t.descricao}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <div className="cpv2-detail__label">Subtipo</div>
                        <select className="cpv2-select" style={{ width: '100%' }}
                          value={reqForm.id_subtipo_irregularidade}
                          onChange={updReq('id_subtipo_irregularidade')}
                          disabled={!reqForm.id_tipo_irregularidade}>
                          <option value="">— selecione —</option>
                          {subtiposLista.map((s) => (
                            <option key={s.id_subtipo ?? s.id} value={s.id_subtipo ?? s.id}>{s.nome ?? s.label ?? s.descricao}</option>
                          ))}
                        </select>
                      </div>
                      <ReqCampo label="Valor estimado (R$)" value={reqForm.valor_estimado} onChange={updReq('valor_estimado')} full />
                    </div>

                    <div style={{ marginTop: 10 }}>
                      <div className="cpv2-detail__label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span>Descrição / justificativa</span>
                        {gerandoDescIA && (
                          <span style={{ fontSize: 10.5, color: 'var(--accent-3)', fontWeight: 600 }}>
                            ✨ gerando com IA (gpt-4o-mini)…
                          </span>
                        )}
                      </div>
                      <textarea value={reqForm.descricao} onChange={updReq('descricao')} rows={12}
                        disabled={gerandoDescIA}
                        style={{ width: '100%', padding: '8px 10px', fontSize: 12, fontFamily: 'monospace',
                          whiteSpace: 'pre-wrap', border: '1px solid var(--cpv2-border)', borderRadius: 6,
                          background: 'var(--cpv2-surface)', color: 'var(--cpv2-text)', opacity: gerandoDescIA ? 0.7 : 1 }} />
                    </div>

                    {reqErro && <div className="cpv2-empty cpv2-empty--error" style={{ marginTop: 8 }}>{reqErro}</div>}

                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                      <button className="cpv2-btn cpv2-btn--primary" onClick={criarRequisicao} disabled={reqSalvando || !reqForm.uc}>
                        {reqSalvando ? 'Criando…' : 'Criar requisição'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ── Dados completos (recolhível): reconciliação + meses + campos da fatura ── */}
            <details style={{ order: 5, marginTop: 6, borderTop: '1px solid var(--cpv2-border)', paddingTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--cpv2-text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', padding: '6px 0' }}>
                🧾 Ver dados completos (reconciliação, meses e campos da fatura)
              </summary>

            {/* ── Reconciliação de valores (parser × SEFAZ × itens) ── */}
            {(sinais.totSefaz != null || sinais.totItens != null || sinais.consSefaz != null) && (
              <div style={{
                border: '1px solid var(--cpv2-border)', borderRadius: 8,
                background: 'var(--cpv2-surface)', padding: '12px 14px', marginBottom: 12,
              }}>
                <div className="cpv2-section-title">🔎 Reconciliação de valores (3 fontes)</div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="cpv2-table" style={{ fontSize: '12px' }}>
                    <thead>
                      <tr>
                        <th>Grandeza</th>
                        <th style={{ textAlign: 'right' }}>Parser (fatura)</th>
                        <th style={{ textAlign: 'right' }}>2ª fonte</th>
                        <th style={{ textAlign: 'right' }}>Δ</th>
                        <th style={{ textAlign: 'center' }}>Veredito</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { g: 'Total × SEFAZ', a: sinais.totFat, b: sinais.totSefaz, d: sinais.difSefaz, st: sinais.stTotSefaz, money: true },
                        { g: 'Total × Σ itens', a: sinais.totFat, b: sinais.totItens, d: sinais.difItens, st: sinais.stTotItens, money: true },
                        { g: 'Consumo × SEFAZ', a: sinais.consFat, b: sinais.consSefaz, d: sinais.difCons, st: sinais.stCons, money: false },
                      ].filter((r) => r.b != null).map((r) => (
                        <tr key={r.g} className="cpv2-row" style={{ cursor: 'default' }}>
                          <td>{r.g}</td>
                          <td className="cpv2-num" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {r.money ? fmtCurrency(r.a) : (r.a != null ? kwh(r.a) : '—')}
                          </td>
                          <td className="cpv2-num" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {r.money ? fmtCurrency(r.b) : (r.b != null ? kwh(r.b) : '—')}
                          </td>
                          <td className="cpv2-num" style={{ fontVariantNumeric: 'tabular-nums', color: corSinal(r.st), fontWeight: 600 }}>
                            {r.d != null ? `${r.d.toFixed(1)}%` : '—'}
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <span style={{ color: corSinal(r.st), fontWeight: 700 }}>
                              {r.st === 'ok' ? '✓ confere' : r.st === 'atencao' ? '≈ atenção' : r.st === 'diverge' ? '✗ diverge' : '—'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* Valores brutos das colunas do SEFAZ (NF3e), quando houver */}
                {(() => {
                  const camposSefaz = [
                    { l: 'Total SEFAZ', v: fatura.valor_total_sefaz != null ? fmtCurrency(num(fatura.valor_total_sefaz)) : null },
                    { l: 'Consumo SEFAZ', v: fatura.consumo_ativo_sefaz_kwh != null ? kwh(fatura.consumo_ativo_sefaz_kwh) : null },
                    { l: 'Compensada SEFAZ', v: fatura.energia_compensada_sefaz_kwh != null ? kwh(fatura.energia_compensada_sefaz_kwh) : null },
                    { l: 'Qtd itens SEFAZ', v: fatura.qtd_itens_sefaz ?? null },
                    { l: 'CNPJ emissor', v: fatura.cnpj_emissor_sefaz || null },
                    { l: 'Chave NF3e', v: fatura.chave_nfe || null },
                    { l: 'Div. valor', v: Number(fatura.flag_divergencia_valor_sefaz) === 1 ? '⚠️ sim' : null },
                    { l: 'Div. qtd itens', v: Number(fatura.flag_divergencia_qtd_itens_sefaz) === 1 ? '⚠️ sim' : null },
                  ].filter((c) => c.v != null && c.v !== '');
                  if (!camposSefaz.length) return null;
                  return (
                    <div style={{ marginTop: 10 }}>
                      <div className="cpv2-detail__label" style={{ marginBottom: 4 }}>Colunas do SEFAZ (NF3e)</div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 6 }}>
                        {camposSefaz.map((c) => (
                          <div key={c.l} style={{ background: 'var(--cpv2-surface-2)', border: '1px solid var(--cpv2-border)', borderRadius: 6, padding: '5px 8px' }}>
                            <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.3, color: 'var(--cpv2-text-muted)' }}>{c.l}</div>
                            <div style={{ fontSize: 12.5, fontWeight: 600, wordBreak: 'break-word' }}>{c.v}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
                <div className="cpv2-muted-sm" style={{ marginTop: 6 }}>
                  SEFAZ = fonte fiscal (NF3e). Divergência Total×SEFAZ sugere cobrança acima do documento fiscal; Total×Σitens divergente indica item perdido na extração.
                </div>
              </div>
            )}

            {/* ── Ações: abrir PDF / dropdown de meses ── */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
              {linkPrincipal ? (
                <a className="cpv2-btn cpv2-btn--primary" href={linkPrincipal} target="_blank" rel="noopener noreferrer">
                  📄 Abrir fatura (PDF)
                </a>
              ) : (
                <span className="cpv2-muted-sm">Sem PDF vinculado a esta fatura.</span>
              )}
              {meses.some((m) => m.link) && (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} className="cpv2-muted-sm">
                  📄 Abrir fatura de um mês:
                  <select
                    className="cpv2-select"
                    defaultValue=""
                    onChange={(e) => {
                      const url = e.target.value;
                      if (url) window.open(url, '_blank', 'noopener,noreferrer');
                      e.currentTarget.value = '';
                    }}
                  >
                    <option value="">— escolher mês —</option>
                    {meses.filter((m) => m.link).map((m) => (
                      <option key={m.id || m.mes} value={m.link}>
                        {fmtMesRef(m.mes)}{m.numero_fatura ? ` · NF ${m.numero_fatura}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            {/* ── Tabela de meses da UC ── */}
            {meses.length > 0 && (
              <>
                <div className="cpv2-section-title">Meses da UC ({meses.length})</div>
                <div style={{ overflowX: 'auto', maxHeight: 260, overflowY: 'auto', marginBottom: 18 }}>
                  <table className="cpv2-table" style={{ fontSize: '11.5px' }}>
                    <thead>
                      <tr>
                        <th>Mês</th>
                        <th style={{ textAlign: 'right' }}>Consumo (kWh)</th>
                        <th style={{ textAlign: 'right' }}>Valor (R$)</th>
                        <th style={{ textAlign: 'center' }}>PDF</th>
                      </tr>
                    </thead>
                    <tbody>
                      {meses.map((m) => {
                        const atual = m.id && idFatura && Number(m.id) === Number(idFatura);
                        return (
                          <tr key={m.id || m.mes} className="cpv2-row"
                            style={{ cursor: 'default', background: atual ? 'var(--cpv2-brand-soft)' : undefined }}>
                            <td className="cpv2-mono">
                              {fmtMesRef(m.mes)}
                              {atual && <span style={{ marginLeft: 6, color: 'var(--cpv2-brand)', fontSize: 10 }}>● atual</span>}
                              {m.fonte === 'historico' && <span className="cpv2-muted-sm" style={{ marginLeft: 6, fontStyle: 'italic' }}>(hist)</span>}
                            </td>
                            <td className="cpv2-num" style={{ fontVariantNumeric: 'tabular-nums' }}>
                              {m.kwh > 0 ? m.kwh.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : '—'}
                            </td>
                            <td className="cpv2-num" style={{ fontVariantNumeric: 'tabular-nums' }}>
                              {m.valor > 0 ? fmtCurrency(m.valor) : '—'}
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              {m.link
                                ? <a href={m.link} target="_blank" rel="noreferrer" style={{ color: 'var(--cpv2-brand)' }}>abrir</a>
                                : <span className="cpv2-muted-sm">—</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* ── Campos completos da fatura (dentro do "dados completos") ── */}
            {carregandoFatura ? (
              <div className="cpv2-loading">Carregando dados da fatura…</div>
            ) : (
              <>
                <Secao titulo="Identificação" sempre pares={[
                  { label: 'UID', value: fatura.uid },
                  { label: 'Cliente', value: cliente },
                  { label: 'CNPJ / CPF', value: fatura.cpf_cnpj },
                  { label: 'IE cliente', value: fatura.ie_cliente },
                  { label: 'Cód. UC', value: fatura.codigo_uc },
                  { label: 'Nº instalação', value: fatura.numero_instalacao },
                  { label: 'Classe', value: fatura.classe_consumidor },
                  { label: 'Grupo', value: fatura.grupo_tarifario },
                  { label: 'Subgrupo', value: fatura.subgrupo_tarifario },
                  { label: 'Modalidade', value: fatura.modalidade_tarifaria },
                  { label: 'Mercado', value: fatura.mercado },
                  { label: 'Distribuidora', value: dist },
                  { label: 'Endereço', value: fatura.endereco_uc },
                  { label: 'CEP', value: fatura.cep_uc },
                  { label: 'Conjunto', value: fatura.conjunto_uc },
                  { label: 'cod_empresa', value: fatura.cod_empresa },
                  { label: 'id FDE', value: fatura.id ?? idFatura },
                ]} />

                <Secao titulo="Período & Medição" cols={3} pares={[
                  { label: 'Mês ref.', value: fmtMesRef(first(fatura.mes_referencia, mesRefTopo)) },
                  { label: 'Vencimento', value: fmtData(fatura.data_vencimento) },
                  { label: 'Leitura anterior', value: fmtData(fatura.data_leitura_anterior) },
                  { label: 'Leitura atual', value: fmtData(fatura.data_leitura_atual) },
                  { label: 'Próx. leitura', value: fmtData(fatura.data_proxima_leitura) },
                  { label: 'Dias faturados', value: fatura.dias_faturados },
                  { label: 'Medidor', value: fatura.numero_medidor },
                  { label: 'Tipo medição', value: fatura.tipo_medicao },
                  { label: 'Constante k', value: fatura.constante_k },
                  { label: 'Consumo ponta', value: kwh(fatura.consumo_ativo_ponta_kwh) },
                  { label: 'Consumo f.ponta', value: kwh(fatura.consumo_ativo_fponta_kwh) },
                  { label: 'Consumo reservado', value: kwh(fatura.consumo_ativo_reservado_kwh) },
                  { label: 'Reativo', value: kwh(fatura.consumo_reativo_kvarh) },
                  { label: 'Reativo excedente', value: kwh(fatura.consumo_reativo_excedente_kvarh) },
                  { label: 'Leit. ant. ponta', value: fatura.leit_ant_ativa_ponta },
                  { label: 'Leit. atu. ponta', value: fatura.leit_atu_ativa_ponta },
                  { label: 'Leit. ant. f.ponta', value: fatura.leit_ant_ativa_fponta },
                  { label: 'Leit. atu. f.ponta', value: fatura.leit_atu_ativa_fponta },
                  { label: 'Demanda contr. ponta', value: kw(fatura.demanda_contratada_ponta_kw) },
                  { label: 'Demanda contr. f.ponta', value: kw(fatura.demanda_contratada_fponta_kw) },
                  { label: 'Demanda fat. ponta', value: kw(fatura.demanda_faturada_ponta_kw) },
                  { label: 'Demanda fat. f.ponta', value: kw(fatura.demanda_faturada_fponta_kw) },
                  { label: 'Fator carga', value: fatura.fator_carga },
                  { label: 'Fator potência', value: fatura.fator_potencia },
                ]} />

                <Secao titulo="Tributos & Totais" cols={3} pares={[
                  { label: 'Base ICMS', value: money(fatura.icms_base_calculo) },
                  { label: 'Alíq. ICMS', value: pct(fatura.icms_aliquota) },
                  { label: 'Valor ICMS', value: money(fatura.icms_valor) },
                  { label: 'Base ICMS TE', value: money(fatura.icms_base_te) },
                  { label: 'Base ICMS TUSD', value: money(fatura.icms_base_tusd) },
                  { label: 'Alíq. PIS', value: pct(fatura.pis_aliquota) },
                  { label: 'Valor PIS', value: money(fatura.pis_valor) },
                  { label: 'Alíq. COFINS', value: pct(fatura.cofins_aliquota) },
                  { label: 'Valor COFINS', value: money(fatura.cofins_valor) },
                  { label: 'CIP / Ilum. púb.', value: money(first(fatura.cip_iluminacao_publica_rs, fatura.valor_cip_cosip)) },
                  { label: 'Bandeira', value: money(valorBandeira) },
                  { label: 'Tipo bandeira', value: first(fatura.tipo_bandeira, fatura.tipo_bandeira_tarifaria) },
                  { label: 'Energia ativa', value: money(fatura.valor_energia_ativa) },
                  { label: 'Demanda', value: money(fatura.valor_demanda) },
                  { label: 'Encargos', value: money(fatura.valor_encargos) },
                  { label: 'TOTAL fatura', value: money(first(fatura.valor_total_fatura, row?.RS_Total_Fatura)), big: true },
                  { label: 'Total itens', value: money(fatura.valor_total_itens) },
                ]} />

                {temGD && (
                  <Secao titulo="⚡ GD / Compensação" cols={3} sempre pares={[
                    { label: 'Indicador GD', value: gd.indicador_geracao_distribuida ? 'Sim' : null },
                    { label: 'Energia injetada', value: kwh(gd.energia_injetada_kwh) },
                    { label: 'Energia compensada', value: kwh(gd.energia_compensada_kwh) },
                    { label: 'Compensada mUC', value: kwh(gd.energia_compensada_muc_kwh) },
                    { label: 'Compensada oUC', value: kwh(gd.energia_compensada_ouc_kwh) },
                    { label: 'Saldo crédito', value: kwh(gd.saldo_credito_energia) },
                    { label: 'Saldo GD a expirar', value: brNum(gd.saldo_gd_a_expirar) },
                    { label: 'Saldo GD ponta', value: kwh(gd.saldo_gd_ponta_kwh) },
                    { label: 'Saldo GD f.ponta', value: kwh(gd.saldo_gd_fponta_kwh) },
                    { label: 'Mercado livre', value: (gd.indicador_mercado_livre || gd.mercado_livre_acl) ? 'Sim' : null },
                  ]} />
                )}

                <Secao titulo="Fiscal NF3e + SEFAZ" cols={3} pares={[
                  { label: 'Chave NF-e', value: fatura.chave_nfe },
                  { label: 'Nº NF', value: first(fatura.numero_nf, fatura.numero_fatura) },
                  { label: 'Série', value: fatura.serie_nf },
                  { label: 'CFOP', value: (fatura.cfop && fatura.cfop_descricao) ? `${fatura.cfop} - ${fatura.cfop_descricao}` : fatura.cfop },
                  { label: 'UF dist.', value: fatura.uf_distribuidora },
                  { label: 'CNPJ dist.', value: fatura.cnpj_distribuidora_filial },
                  { label: 'Status NF', value: fatura.status_nfe },
                  { label: 'Emissão NF', value: fmtData(fatura.data_emissao_nf) },
                  { label: 'Protocolo', value: fatura.protocolo_autorizacao },
                  { label: 'Total SEFAZ', value: money(fatura.valor_total_sefaz) },
                  { label: 'Qtd itens SEFAZ', value: fatura.qtd_itens_sefaz },
                  { label: 'Consumo SEFAZ', value: kwh(fatura.consumo_ativo_sefaz_kwh) },
                  { label: 'Compensada SEFAZ', value: kwh(fatura.energia_compensada_sefaz_kwh) },
                  { label: 'CNPJ emissor SEFAZ', value: fatura.cnpj_emissor_sefaz },
                  { label: 'Div. valor SEFAZ', value: fatura.flag_divergencia_valor_sefaz ? 'Sim' : null },
                  { label: 'Div. qtd SEFAZ', value: fatura.flag_divergencia_qtd_itens_sefaz ? 'Sim' : null },
                ]} />

                <Secao titulo="Qualidade / Extração" cols={3} pares={[
                  { label: 'Gate', value: gate ? String(gate).toUpperCase() : null },
                  { label: 'Score confiança', value: score != null ? `${score}%` : null },
                  { label: 'Fonte extração', value: fatura.fonte_extracao },
                  { label: 'Versão', value: fatura.extracao_versao },
                  { label: 'Layout template', value: fatura.layout_template_id },
                  { label: 'Aritmética OK', value: fatura.aritmetica_ok === 1 ? 'Sim' : (fatura.aritmetica_ok === 0 ? 'Não' : null) },
                  { label: 'Audit confiança', value: fatura.audit_confianca },
                ]} />

                <TabelaItens itens={fatura.itens_cobrados} />
                <TabelaHistoricoConsumo fatura={fatura} />
              </>
              )}
            </details>
          </div>

          {/* Footer */}
          <div className="cpv2-modal__footer">
            {linkPrincipal && (
              <a className="cpv2-btn" href={linkPrincipal} target="_blank" rel="noopener noreferrer">
                📄 Abrir fatura (PDF)
              </a>
            )}
            <button className="cpv2-btn"
              onClick={rodarOcrComIA} disabled={ocrPhase === 'running'}
              title="OCR com IA: extrai todas as faturas desta unidade e mostra o resultado aqui mesmo"
              style={{ background: 'linear-gradient(135deg,#1d4ed8,#3b82f6,#60a5fa)', color: '#fff', border: 'none' }}>
              {ocrPhase === 'running' ? '⏳ Rodando OCR…' : '🤖 OCR com IA'}
            </button>
            <button className="cpv2-btn cpv2-btn--primary" onClick={onClose}>Fechar</button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(conteudoModal, document.body);
}
