import React, { Fragment, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ReferenceLine, ReferenceArea, ScatterChart, Scatter, ZAxis, Cell,
} from 'recharts';
import apiClient from '../services/apiClient';
import { useAuth } from '../context/AuthContext.jsx';
import ModalFaturaMontada from '../components/ModalFaturaMontada';
import AuditoriaRankings from '../components/AuditoriaRankings';
import AguaPanel from '../components/AguaPanel';
import AcerPanel from '../components/AcerPanel';
import CatalogoFichasModal from '../components/CatalogoFichasModal';
import { fichaTooltip } from '../data/fichasCatalogo';
import './controleProcessosV2.css'; // design system cpv2 (mesmo visual do Controle de Processos)
// Reaproveita a linguagem visual do "Controle de Processos" (classes cpv2-*)
// usadas pelo ModalFaturaMontada. Só importamos o css — não editamos nada nele.
import './controleProcessosV2.css';

/* ────────────────────────────────────────────────────────────────────────────
   Constantes
   ──────────────────────────────────────────────────────────────────────────── */

const FICHAS = [
  { id: 'f01', label: 'F01', nome: 'Divergência de Fórmula',        endpoint: '/api/v1/faturas/ficha/01', cor: 'var(--accent)' },
  { id: 'f02', label: 'F02', nome: 'Desvio de Média',               endpoint: '/api/v1/faturas/ficha/02', cor: 'var(--success)' },
  // F03 (Acúmulo) removida 08/06/2026 — gerava ~94% de falsos positivos.
  { id: 'f04', label: 'F04', nome: 'Troca de Medidor',              endpoint: '/api/v1/faturas/ficha/04', cor: '#7c6f9c' },
  { id: 'f05', label: 'F05', nome: 'Quebra de Leitura',             endpoint: '/api/v1/faturas/ficha/05', cor: 'var(--danger)' },
  { id: 'f06', label: 'F06', nome: 'Ausência de Leituras',          endpoint: '/api/v1/faturas/ficha/06', cor: 'var(--accent-2)' },
  { id: 'f07', label: 'F07', nome: 'Rollover de Medidor',           endpoint: '/api/v1/faturas/ficha/07', cor: '#7c6f9c' },
  { id: 'f08', label: 'F08', nome: 'Troca sem Zeramento',           endpoint: '/api/v1/faturas/ficha/08', cor: 'var(--accent-3)' },
  { id: 'f09', label: 'F09', nome: 'Leitura Estimada',              endpoint: '/api/v1/faturas/ficha/09', cor: '#9c4f6e' },
  { id: 'f10', label: 'F10', nome: 'Tarifa Incorreta',              endpoint: '/api/v1/faturas/ficha/10', cor: 'var(--success)' },
  { id: 'f11', label: 'F11', nome: 'Demanda Contratada',            endpoint: '/api/v1/faturas/ficha/11', cor: 'var(--accent)' },
  { id: 'f12', label: 'F12', nome: 'Ausência de Medição',            endpoint: '/api/v1/faturas/ficha/12', cor: 'var(--accent-3)' },
  { id: 'f13', label: 'F13', nome: 'Consumo Zero com Demanda/Rea.', endpoint: '/api/v1/faturas/ficha/13', cor: 'var(--accent-3)' },
  { id: 'f14', label: 'F14', nome: 'Outros Erros IA',               endpoint: '/api/v1/faturas/ficha/14', cor: 'color-mix(in srgb, var(--fg) 55%, transparent)' },
];

const FICHA_COLORS = {
  F01: 'var(--accent)', F02: 'var(--success)', F03: 'var(--accent-3)', F04: '#7c6f9c', F05: 'var(--danger)',
  F06: 'var(--accent-2)', F07: '#7c6f9c', F08: 'var(--accent-3)', F09: '#9c4f6e', F10: 'var(--success)',
  F11: 'var(--accent)', F12: 'var(--accent-3)', F13: 'var(--accent-3)', F14: 'color-mix(in srgb, var(--fg) 55%, transparent)',
};

const FICHA_DESCRICAO = {
  F01: { nome: 'Divergência de Fórmula',
         desc: 'Cálculo (LeitAtu − LeitAnt) × Constante não fecha com o kWh faturado.' },
  F02: { nome: 'Desvio de Média',
         desc: 'Consumo do mês difere significativamente (≥100%) da média histórica da UC.' },
  F03: { nome: 'Acúmulo de Consumo',
         desc: 'Consumo concentrado em um mês após período com leituras zero ou estimadas.' },
  F04: { nome: 'Troca de Medidor',
         desc: 'Medidor substituído sem zeramento adequado da leitura ou cobrança duplicada.' },
  F05: { nome: 'Quebra de Leitura',
         desc: 'Leitura atual menor que a anterior (rollover ou erro) sem ajuste.' },
  F06: { nome: 'Ausência de Leituras',
         desc: 'Mês sem leitura registrada — fatura emitida com estimativa.' },
  F07: { nome: 'Rollover de Medidor',
         desc: 'Medidor virou de capacidade (ex: 99999 → 00000) sem tratamento.' },
  F08: { nome: 'Troca sem Zeramento',
         desc: 'Substituição do medidor sem reset, gerando consumo fantasma.' },
  F09: { nome: 'Leitura Estimada',
         desc: 'Leitura calculada por estimativa (não real) cobrada como real.' },
  F10: { nome: 'Tarifa Incorreta',
         desc: 'Tarifa aplicada não corresponde à modalidade/grupo/subgrupo da UC.' },
  F11: { nome: 'Demanda Contratada',
         desc: 'Cobrança de demanda divergente do contrato ou ultrapassagem indevida.' },
  F12: { nome: 'Ausência de Medição',
         desc: 'Fatura sem identificação do medidor (campo NroMedidor vazio) com consumo significativo.' },
  F13: { nome: 'Consumo Zero com Demanda/Reativo',
         desc: 'Consumo ativo zero mas com demanda ou reativo — incoerência técnica.' },
  F14: { nome: 'Outros Erros IA',
         desc: 'Anomalia identificada pela IA que não se encaixa nas categorias F01-F13.' },
};

const SEVERITY_COLORS = { 5: 'var(--danger)', 4: 'color-mix(in srgb, var(--warning) 50%, var(--danger) 50%)', 3: 'var(--warning)', 2: 'var(--success)', 1: 'var(--accent)' };
const SEVERITY_LABELS = { 5: 'Urgente', 4: 'Crítico', 3: 'Alto', 2: 'Médio', 1: 'Baixo' };

// Fallback de razão social por Cod_Empresa (quando o backend não retorna cliente).
// Fonte oficial: Tab_Empresas (Rz_Social) — esse mapa é cache local.
const EMPRESA_NOME = {
  4:   'VIA S.A.',
  14:  'REZEK',
  32:  'VULCABRAS',
  33:  'MOINHO DO PIAUI LTDA',
  69:  'KAZOLY ECOLOGICA LTDA',
  70:  'GRANTRIGO (PRÉVIA)',
  80:  'TECNO INDUSTRIA E COMERCIO DE COMPUTADORES LTDA',
  120: 'VITALLIS CENTRO MEDICO',
  135: 'VTAL REDE NEUTRA DE TELECOMUNICACOES S.A.',
  144: 'GGF AGRO LTDA',
  145: 'NAZARIA',
  154: 'COYOTE ALIMENTACAO LTDA',
  176: 'REAL ALIMENTOS LTDA',
  180: 'MACSO IND COM LTDA',
  181: 'ITARAI METALURGICA LTDA',
  183: 'LEGIAO DA BOA VONTADE',
  189: 'HOSPITAL ISRAELITA ALBERT EINSTEIN',
  191: 'AGENCIA VIP AIR ENERGY ADVISOR',
  199: 'BP BUNGE',
  202: 'NUTRISAVOUR COMERCIO DE ALIMENTOS LTDA',
  203: 'AB BRASIL INDL E COM DE ALIMENTOS LTDA',
  204: 'ACOTEMPERA TRATAMENTO TERMICO LTDA',
  205: 'ALUMINIO FUJI LTDA',
  206: 'AUTOMEC COMERCIAL LTDA',
  209: 'PANIFICADORA PIVETTA LTDA (SANTA ROSALIA)',
  210: 'OPERADORA HOTELEIRA VILLA ROSSA LTDA',
  211: 'TROPICAL MOTEL LTDA',
  212: 'NEWKAR DISTRIBUIDORA DE PECAS LTDA',
  213: 'ALPHAVILLE GRACIOSA CLUBE',
  214: 'MRM RELACOES E EVENTOS LTDA',
  216: 'BIOLABOR - LABORATORIO DE ANALISES CLINICAS',
  217: 'NOVA GALREI GALVANOPLASTIA INDUSTRIAL',
  218: 'LINUS PAULING MEDICINA DIAGNOSTICA EIRELI',
  219: 'FARMA PONTE',
  223: 'ABRAO REZE COMERCIO DE VEICULOS LTDA',
  224: 'ANTONIO BOZELLI FILHO',
  226: 'ECOPLAST INDUSTRIA E COMERCIO DE RECICLADOS EIRELI',
  227: 'NOVA MILANO INVESTIMENTOS LTDA',
  359: 'SER EDUCACIONAL S.A.',
  362: 'HAPVIDA ASSISTENCIA MEDICA S.A.',
  366: 'FRANQUEADOS MCDONALDS',
  367: 'VENEZA NEGOCIOS E PARTICIPACOES SA',
  368: 'ZILDO LINO',
  369: 'BEVERDE EMPREENDIMENTOS',
  370: 'BAZZA DISTRIBUIDORA LTDA.',
  374: 'EVEN CONSTRUTORA',
  2025: 'VTAL',
};

const getNomeEmpresa = (row) => {
  const cod = Number(row?.Cod_Empresa ?? row?.cod_empresa ?? row?.empresa);
  // 1) Backend retornou nome direto?
  const direto = row?.RAZAO_SOCIAL || row?.razao_social || row?.cliente
              || row?.Razao_Social || row?.RazaoSocial;
  const nome = (direto && String(direto).trim())
    ? String(direto).trim()
    : (cod && EMPRESA_NOME[cod]) || null;
  if (cod && nome) return `${cod} — ${nome}`;
  if (nome)         return nome;
  if (cod)          return String(cod);
  return '—';
};

const TABS = [
  { id: 'aprovados',     label: 'Apontamentos',   cor: 'var(--success)', sub: 'CONFIRMADO' },
  { id: 'auditados',     label: 'Energia',        cor: '#7c6f9c', sub: 'só ELEVADO REAL' },
  { id: 'inconclusivos', label: 'Inconclusivos',  cor: 'var(--warning)', sub: 'triagem: motor apontou, fora de Auditados' },
  { id: 'rejeitados',    label: 'Rejeitados',     cor: 'var(--danger)', sub: 'REFUTADO' },
  { id: 'agua',          label: '💧 Água',        cor: '#2b8fd6', sub: 'desvio de consumo m³' },
  { id: 'acer',          label: '🅰️ Acer',        cor: '#7c6f9c', sub: 'empresa 2028 — base própria' },
];

const STATUS_POR_TAB = {
  aprovados:     'CONFIRMADO',
  auditados:     'CONFIRMADO', // mesma fonte do Apontamentos; filtra ELEVADO_REAL no client
  inconclusivos: 'INCONCLUSIVO',
  rejeitados:    'REFUTADO',
};

// ⭐ FRC_MODE (DESATIVADO em 08/07/2026): tentei usar o sgeeasy como fonte, mas
// a decisão foi manter o motor sobre FATURA_DADOS_EXTRAIDOS (/fde-analise).
const FRC_MODE = false;

// ⭐ MOTOR_MODE: fonte dos apontamentos = motor novo (regras_desvio.go F01-F05 ao
// vivo sobre a FATURA_DADOS_EXTRAIDOS), em vez da coluna fichas_apontadas do
// pipeline IA antigo (vazia → 0 casos). Quando true o front manda motor=1 e
// confia 100% no que o backend devolve (sem re-filtro client-side de CONFIRMADO).
const MOTOR_MODE = true;

/* ────────────────────────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────────────────────────── */

const fmtCurrency = (v) => {
  const n = Number(v);
  if (v == null || v === '' || Number.isNaN(n)) return '—';
  return `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

// Retorna { flags: Set<'F02'..'F05'>, fonte: 'ia' | 'motor' | 'none' }
// Prioriza a decisão final da IA (fichas_confirmadas em decisao_final='CONFIRMADO')
// porque ela já refuta apontamentos do motor SQL via pós-validador determinístico.
// Cai pro motor SQL só se a IA ainda não decidiu.
//
// F01 é EXCLUÍDO da exibição: na prática esse apontamento é ruidoso (a IA
// tipicamente refuta ou converte em F02/F03), e visualmente confunde o usuário
// na coluna Flags. Mantemos os dados crus para auditoria, só não renderizamos.
function obterFlagsExibicao(d) {
  const ehConfirmado = String(d.decisaoFinal || '').toUpperCase() === 'CONFIRMADO';
  if (ehConfirmado && d.fichasConfirmadasRaw) {
    try {
      const arr = JSON.parse(d.fichasConfirmadasRaw);
      if (Array.isArray(arr) && arr.length > 0) {
        const set = new Set(
          arr
            .map((s) => String(s).toUpperCase().trim())
            .filter((s) => /^F0[2-9]$/.test(s)) // F02..F09 (F01 excluído)
        );
        if (set.size > 0) return { flags: set, fonte: 'ia' };
      }
    } catch {
      // JSON inválido — cai pro motor
    }
  }
  const motor = new Set();
  // F01 propositalmente NÃO é incluído — ver comentário acima
  if (d.flagF02 === 1) motor.add('F02');
  if (d.flagF03 === 1) motor.add('F03');
  if (d.flagF04 === 1) motor.add('F04');
  if (d.flagF05 === 1) motor.add('F05');
  return { flags: motor, fonte: motor.size > 0 ? 'motor' : 'none' };
}

const fmtPct = (v) => {
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
};

const fmtDateTime = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  // dd/mm/aaaa hh:mm
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};

// Normaliza mes_referencia em qualquer formato para 'MM/YYYY' (ex.: '09/2021').
// O banco hoje guarda o canônico 'MM-YYYY' (após sincronizar_links.py), mas
// versões antigas podem ter '2021-09', '2021-09-01', '09/2021' — tudo entra
// nesse formatador. Se não conseguir parsear, devolve a string crua.
const fmtMesRef = (v) => {
  if (v == null) return '—';
  const s = String(v).trim();
  if (!s) return '—';
  // Já está 'MM/YYYY'
  if (/^\d{2}\/\d{4}$/.test(s)) return s;
  // 'MM-YYYY'
  if (/^\d{2}-\d{4}$/.test(s)) return `${s.slice(0, 2)}/${s.slice(3)}`;
  // 'YYYY-MM' ou 'YYYY-MM-DD' (com qualquer prefixo extra)
  const m = s.match(/^(\d{4})-(\d{2})/);
  if (m) return `${m[2]}/${m[1]}`;
  return s;
};

const getRowLink = (r) => String(r?.Link ?? r?.link ?? '').trim();

const parseAnalises = (raw) => {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
};

const getDecisao = (row) => {
  const a = parseAnalises(row?.resultado_analises);
  return a?.ia_opus_5_4_decisao || null;
};

const extractFichas = (raw) => {
  if (!raw) return [];
  const s = String(raw);
  return [...new Set(s.match(/F\d{2}/gi) ?? [])].map(f => f.toUpperCase());
};

/* ────────────────────────────────────────────────────────────────────────────
   FichasBadge
   ──────────────────────────────────────────────────────────────────────────── */

function FichasBadge({ fichas }) {
  if (!fichas?.length) return <span className="text-[color-mix(in_srgb,var(--fg)_55%,transparent)]">—</span>;
  return (
    <div className="flex flex-wrap gap-0.5">
      {fichas.map(f => {
        const cor  = FICHA_COLORS[f] ?? 'color-mix(in srgb, var(--fg) 55%, transparent)';
        const tip  = fichaTooltip(f); // explicação completa (o que é + como conferir + base)
        return (
          <span key={f} title={tip}
            style={{ backgroundColor: `color-mix(in srgb, ${cor} 20%, transparent)`, color: cor, border: `1px solid color-mix(in srgb, ${cor} 33%, transparent)` }}
            className="px-1 py-0 rounded text-[10px] font-bold inline-block cursor-help">
            {f}
          </span>
        );
      })}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Status / Confiança
   ──────────────────────────────────────────────────────────────────────────── */

function StatusBadge({ status }) {
  const cores = {
    CONFIRMADO:   'bg-[color-mix(in_srgb,var(--success)_20%,transparent)] text-[var(--success)] border-[color-mix(in_srgb,var(--success)_40%,transparent)]',
    INCONCLUSIVO: 'bg-[color-mix(in_srgb,var(--warning)_20%,transparent)] text-[var(--warning)] border-[color-mix(in_srgb,var(--warning)_40%,transparent)]',
    REFUTADO:     'bg-[color-mix(in_srgb,var(--danger)_20%,transparent)] text-[var(--danger)] border-[color-mix(in_srgb,var(--danger)_40%,transparent)]',
    PENDENTE:     'bg-[color-mix(in_srgb,var(--fg)_20%,transparent)] text-[color-mix(in_srgb,var(--fg)_55%,transparent)] border-[color-mix(in_srgb,var(--fg)_40%,transparent)]',
    APONTADO:     'bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] text-[var(--accent)] border-[color-mix(in_srgb,var(--accent)_40%,transparent)]',
  };
  const label = { APONTADO: 'Apontado' };
  return (
    <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${cores[status] ?? cores.PENDENTE}`}>
      {label[status] || status || 'PENDENTE'}
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   ⭐ v19 — Status de passibilidade (color-coded por gravidade)
   ──────────────────────────────────────────────────────────────────────────── */

// 2026-05-11 — removida apenas PASSIVEL_DOCUMENTAL_ABUSIVO (classificação por
// Y/REN descontinuada). Adicionada PARCELAMENTO_SOBREPOSTO (Art.323 sobre
// Art.113 não paga — único realmente problemático). TEM_PARCELAMENTO substitui
// PARCELAMENTO_LEGITIMO_REVISAR (agora puramente informativo).
const PASSIBILIDADE_CONFIG = {
  PARCELAMENTO_SOBREPOSTO: {
    label: 'Parc. sobreposto',
    short: 'SOBREPOSTO',
    cor: 'bg-[color-mix(in_srgb,var(--danger)_20%,transparent)] text-[var(--danger)] border-[color-mix(in_srgb,var(--danger)_40%,transparent)]',
    desc: 'Art.323 incidindo sobre Art.113 ainda não pago — único caso realmente problemático',
    prioridade: 1,
  },
  PASSIVEL_CICLO_INFINITO: {
    label: 'Ciclo infinito',
    short: 'CICLO',
    cor: 'bg-[color-mix(in_srgb,var(--accent-3)_20%,transparent)] text-[var(--accent-3)] border-[color-mix(in_srgb,var(--accent-3)_40%,transparent)]',
    desc: 'Ciclo infinito Art.113 detectado',
    prioridade: 2,
  },
  TEM_PARCELAMENTO: {
    label: 'Tem parcelamento',
    short: 'PARCELAMENTO',
    cor: 'bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] text-[var(--accent)] border-[color-mix(in_srgb,var(--accent)_40%,transparent)]',
    desc: 'Parcelamento Art.113/323 detectado (informativo, sem juízo de abusividade)',
    prioridade: 3,
  },
  COMPENSADO_NEUTRALIZADO: {
    label: 'Compensado',
    short: 'COMPENSADO',
    cor: 'bg-[color-mix(in_srgb,var(--fg)_20%,transparent)] text-[color-mix(in_srgb,var(--fg)_55%,transparent)] border-[color-mix(in_srgb,var(--fg)_40%,transparent)]',
    desc: 'Cliente já está sendo restituído (compensação ativa ou devolução em dobro) — descartar',
    prioridade: 4,
  },
};

function PassibilidadeBadge({ status }) {
  if (!status) return <span className="opacity-30 text-[10px]">—</span>;
  const cfg = PASSIBILIDADE_CONFIG[status] || {
    label: status,
    short: status,
    cor: 'bg-[color-mix(in_srgb,var(--fg)_20%,transparent)] text-[color-mix(in_srgb,var(--fg)_55%,transparent)] border-[color-mix(in_srgb,var(--fg)_40%,transparent)]',
    desc: status,
  };
  return (
    <span
      title={cfg.desc}
      className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold whitespace-nowrap ${cfg.cor}`}
    >
      {cfg.short}
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   ⭐ v19 — DetalhesV19 — renderiza as 9 seções do JSON novo
   ──────────────────────────────────────────────────────────────────────────── */

function KV({ label, value, mono = false, currency = false, bool = false }) {
  if (value === null || value === undefined || value === '') {
    return (
      <div className="flex justify-between text-[11px] py-0.5 border-b border-[var(--cpv2-border)]/30">
        <span className="opacity-50">{label}</span>
        <span className="opacity-30">—</span>
      </div>
    );
  }
  let txt = String(value);
  if (currency) {
    const n = Number(value);
    txt = Number.isFinite(n) ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : String(value);
  } else if (bool) {
    txt = value === true || value === 1 ? '✓ sim' : '— não';
  }
  return (
    <div className="flex justify-between text-[11px] py-0.5 border-b border-[var(--cpv2-border)]/30 gap-2">
      <span className="opacity-60 flex-shrink-0">{label}</span>
      <span className={mono ? 'font-mono text-right' : 'text-right'} title={txt}>{txt}</span>
    </div>
  );
}

function Secao({ titulo, children, cor }) {
  return (
    <div className="rounded-md border border-[var(--cpv2-border)] bg-[var(--cpv2-surface-2)] p-2.5">
      <div className="text-[10px] uppercase tracking-wider font-semibold mb-1.5"
           style={{ color: cor || 'inherit' }}>
        {titulo}
      </div>
      {children}
    </div>
  );
}

function DetalhesV19({ row }) {
  // Backend pode mandar tudo achatado OU em seções; vou aceitar ambos
  const ident   = row.identificacao || {};
  const med     = row.medicao || {};
  const parcel  = row.parcelamento || {};
  const comp    = row.compensacao || {};
  const histA   = row.historico_art113 || {};
  const reg     = row.regulacao || {};
  const band    = row.bandeira || {};
  const arit    = row.aritmetica || {};
  const extr    = row.extracao || {};
  const status  = row.status_passibilidade;
  const histCons = Array.isArray(row.historico_consumo) ? row.historico_consumo : [];

  // Decisão da IA + texto cru (sempre disponíveis quando a fatura foi analisada)
  const decisao = getDecisao(row) || {};
  const analiseTexto = row?.resultado_analises?.analise_ia_texto || '';

  // Se nada do v19 foi populado, mostra resumo da IA + texto + dica
  const temDadosV19 = parcel.y || comp.ja_aplicada || histA.ciclos_min_max_consecutivos
                       || extr.score_confianca !== null || histCons.length > 0;

  if (!temDadosV19) {
    return (
      <div className="space-y-3">
        {/* Aviso */}
        <div className="rounded-lg border border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning)_5%,transparent)] p-3 text-[11px]">
          <div className="flex items-start gap-2">
            <span className="text-base">⚠️</span>
            <div className="flex-1 space-y-1">
              <div className="font-semibold text-[var(--warning)]">
                Esta fatura ainda não passou pelo <code className="px-1 bg-[var(--cpv2-surface-2)] rounded">pdf_pipeline_v2</code>
              </div>
              <div className="opacity-70">
                A Fase 4 do reprocessamento só rodou nas {row.id ? '989 ' : ''}faturas com
                <code className="px-1 mx-0.5 bg-[var(--cpv2-surface-2)] rounded">decisao_final=CONFIRMADO</code>.
                Esta fatura é <span className="font-semibold">{decisao?.decisao_final || 'sem decisão'}</span>,
                então as colunas v19 estão vazias.
              </div>
              <div className="opacity-50 text-[10px] pt-1">
                Para popular: <code className="px-1 bg-[var(--cpv2-surface-2)] rounded">python reprocessar_v2.py --id {row.id} --force</code>
              </div>
            </div>
          </div>
        </div>

        {/* Decisão IA — o que existe */}
        {(decisao?.decisao_final || decisao?.fichas_confirmadas?.length > 0) && (
          <Secao titulo="🤖 Decisão atual da IA (gpt-5.4)" cor="var(--accent-2)">
            <KV label="Decisão final" value={decisao.decisao_final} />
            <KV label="Ficha principal" value={decisao.ficha_principal} />
            <KV label="Fichas confirmadas" value={Array.isArray(decisao.fichas_confirmadas) ? decisao.fichas_confirmadas.join(', ') : decisao.fichas_confirmadas} />
            <KV label="Confiança final" value={decisao.confianca_final ? `${decisao.confianca_final}%` : null} mono />
            <KV label="Percentual ressarcimento" value={decisao.percentual_ressarcimento ? `${decisao.percentual_ressarcimento}%` : null} mono />
            {decisao.justificativa && (
              <div className="mt-2 pt-2 border-t border-[var(--cpv2-border)]/30">
                <div className="text-[10px] opacity-60 mb-1">JUSTIFICATIVA</div>
                <div className="text-xs whitespace-pre-wrap leading-relaxed opacity-90">{decisao.justificativa}</div>
              </div>
            )}
            {decisao.recomendacao && (
              <div className="mt-2 pt-2 border-t border-[var(--cpv2-border)]/30">
                <div className="text-[10px] opacity-60 mb-1">RECOMENDAÇÃO</div>
                <div className="text-xs whitespace-pre-wrap leading-relaxed opacity-90">{decisao.recomendacao}</div>
              </div>
            )}
          </Secao>
        )}

        {/* Identificação básica que sempre vem */}
        <Secao titulo="Identificação" cor="color-mix(in srgb, var(--fg) 55%, transparent)">
          <KV label="ID" value={row.id} mono />
          <KV label="UC" value={row.UC ?? row.uc} mono />
          <KV label="Mês ref." value={row.Mes_Ref ?? row.mes_ref} mono />
          <KV label="Concessionária" value={row.Concessionaria ?? row.distribuidora} />
          <KV label="Cliente" value={row.RAZAO_SOCIAL || row.nome_cliente} />
          <KV label="Valor fatura" value={row.RS_Total_Fatura} currency />
        </Secao>

        {/* Texto cru da IA */}
        {analiseTexto && (
          <details className="rounded-md border border-[var(--cpv2-border)] bg-[var(--cpv2-surface-2)] p-2" open>
            <summary className="text-[10px] uppercase tracking-wider opacity-60 cursor-pointer">
              🤖 Texto completo da análise IA ({analiseTexto.length.toLocaleString()} chars) — clique para colapsar
            </summary>
            <pre className="mt-2 text-[10px] whitespace-pre-wrap opacity-80 max-h-96 overflow-y-auto leading-relaxed">
              {analiseTexto}
            </pre>
          </details>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] opacity-60 font-semibold uppercase tracking-wider">
          📋 Detalhes v19 (pdf_pipeline + IA revisor)
        </div>
        {status && <PassibilidadeBadge status={status} />}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {/* Identificação */}
        <Secao titulo="Identificação" cor="var(--accent-2)">
          <KV label="Nº fatura" value={ident.numero_fatura} mono />
          <KV label="Cliente" value={ident.nome_cliente} />
          <KV label="Modalidade" value={ident.modalidade_tarifaria} />
          <KV label="Tensão" value={ident.tensao_fornecimento} />
          <KV label="Grupo" value={ident.grupo_tarifario} />
          <KV label="Medidor Nº" value={ident.numero_medidor} mono />
        </Secao>

        {/* Medição */}
        <Secao titulo="Medição (leituras + consumo)" cor="var(--success)">
          <KV label="Consumo Ponta" value={med.consumo_ponta_kwh} mono />
          <KV label="Consumo F.Ponta" value={med.consumo_fponta_kwh} mono />
          <KV label="Leit. Ant. P" value={med.leit_ant_ponta} mono />
          <KV label="Leit. Atu. P" value={med.leit_atu_ponta} mono />
          <KV label="Leit. Ant. FP" value={med.leit_ant_fponta} mono />
          <KV label="Leit. Atu. FP" value={med.leit_atu_fponta} mono />
          <KV label="Constante K" value={med.constante_k} mono />
        </Secao>

        {/* Parcelamento Art.113/323 (cluster mais importante) */}
        <Secao titulo="🚨 Parcelamento Art.113/323" cor="var(--danger)">
          <KV label="Parcela atual" value={parcel.x ? `${parcel.x}/${parcel.y}` : null} mono />
          <KV label="Alerta" value={parcel.alerta} />
          <KV label="Regime" value={parcel.regime_norma} mono />
          <KV label="Mês origem" value={parcel.fatura_origem} mono />
          <KV label="Valor unitário" value={parcel.valor_unitario_rs} currency />
          <KV label="Valor efetivo (com encargos)" value={parcel.valor_unitario_efetivo_rs} currency />
          <KV label="Encargos extras" value={parcel.encargos_extras_rs} currency />
          <KV label="Total dívida" value={parcel.total_estimado_rs} currency />
          <KV label="Juros embutidos %" value={parcel.juros_embutidos_pct} mono />
        </Secao>

        {/* Compensação (anti-dupla-devolução) */}
        <Secao titulo="⚠️ Compensação (anti-dupla)" cor="var(--warning)">
          <KV label="Já aplicada" value={comp.ja_aplicada} bool />
          <KV label="Valor real reconstruído" value={comp.valor_origem_real_rs} currency />
          <KV label="Devolução em dobro CDC" value={comp.devolucao_em_dobro} bool />
        </Secao>

        {/* Histórico Art.113 */}
        <Secao titulo="Histórico Art.113" cor="#7c6f9c">
          <KV label="Ciclos MIN consecutivos" value={histA.ciclos_min_max_consecutivos} mono />
          <KV label="Ciclos MED consecutivos" value={histA.ciclos_med_max_consecutivos} mono />
          <KV label="Ciclo infinito Art.113" value={histA.ciclo_infinito} bool />
          <KV label="MIN_PROLONGADO falso positivo" value={histA.min_prolongado_falso_positivo} bool />
          <KV label="Status leitura" value={histA.status_leitura_mes_atual} />
        </Secao>

        {/* Regulação / Cliente */}
        <Secao titulo="Regulação / Cliente" cor="#7c6f9c">
          <KV label="UC pública (terceiro)" value={reg.uc_publica_operada_por_terceiro} bool />
          <KV label="Mercado livre / ACL" value={reg.mercado_livre_acl} bool />
          <KV label="Det. Judicial Proc." value={reg.determinacao_judicial_processo} mono />
          <KV label="Dívidas anteriores mesma UC" value={reg.dividas_anteriores_mesma_uc} mono />
        </Secao>

        {/* Bandeira / Reativos */}
        <Secao titulo="Bandeira / Reativos" cor="var(--accent-3)">
          <KV label="Tipo bandeira" value={band.tipo} />
          <KV label="Valor bandeira" value={band.valor_rs} currency />
          <KV label="Reativo excedente (UFER/DMCR)" value={band.reativo_excedente_rs} currency />
        </Secao>

        {/* Validação aritmética */}
        <Secao titulo="Aritmética" cor="var(--accent-2)">
          <KV label="Total calculado" value={arit.total_calculado_rs} currency />
          <KV label="Diff %" value={arit.diff_pct} mono />
          <KV label="OK?" value={arit.ok} bool />
        </Secao>

        {/* Score / extração */}
        <Secao titulo="Extração / Auditoria" cor="color-mix(in srgb, var(--fg) 55%, transparent)">
          <KV label="Score (0-100)" value={extr.score_confianca} mono />
          <KV label="Revisada por GPT" value={extr.revisada_por_gpt} bool />
          <KV label="Modelo revisor" value={extr.modelo_revisor} mono />
          <KV label="Hash" value={extr.hash} mono />
          <KV label="Revisado em" value={extr.revisao_em} mono />
        </Secao>
      </div>

      {/* Histórico de consumo (12-13 meses) */}
      {histCons.length > 0 && (
        <Secao titulo={`Histórico de consumo (${histCons.length} meses)`} cor="var(--success)">
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="opacity-60">
                  <th className="text-left px-1 py-0.5">Mês</th>
                  <th className="text-right px-1 py-0.5">kWh</th>
                  <th className="text-center px-1 py-0.5">Tipo</th>
                </tr>
              </thead>
              <tbody>
                {histCons.map((h, i) => (
                  <tr key={i} className="border-t border-[var(--cpv2-border)]/20">
                    <td className="px-1 py-0.5 font-mono">{h.mes}</td>
                    <td className="px-1 py-0.5 text-right font-mono">{Number(h.kwh ?? 0).toLocaleString('pt-BR')}</td>
                    <td className="px-1 py-0.5 text-center">
                      <span className={
                        h.tipo === 'LID' ? 'text-[var(--success)]' :
                        h.tipo === 'MED' ? 'text-[var(--warning)]' :
                        h.tipo === 'MIN' ? 'text-[var(--danger)]' : 'opacity-50'
                      }>{h.tipo || '—'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Secao>
      )}

      {/* Texto cru da IA (collapsible) */}
      {row.resultado_analises?.analise_ia_texto && (
        <details className="rounded-md border border-[var(--cpv2-border)] bg-[var(--cpv2-surface-2)] p-2">
          <summary className="text-[10px] uppercase tracking-wider opacity-60 cursor-pointer">
            🤖 Texto completo da análise IA (clique para expandir)
          </summary>
          <pre className="mt-2 text-[10px] whitespace-pre-wrap opacity-80 max-h-96 overflow-y-auto">
            {row.resultado_analises.analise_ia_texto}
          </pre>
        </details>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Matriz de Risco — scatter Desvio % × Valor R$
   ──────────────────────────────────────────────────────────────────────────── */

function RiscoMatrizChart({ rows }) {
  const pts = useMemo(() => {
    const groups = {};
    rows.forEach(r => {
      const uc = String(r.UC ?? r.uc ?? r.id ?? '').trim();
      if (!uc) return;
      const x = parseFloat(r.desvio_pct_max ?? r.desvio_pct);
      const y = parseFloat(r.RS_Total_Fatura ?? r.valor);
      const peso = parseInt(r.peso_alerta_max ?? 1, 10) || 1;
      if (!groups[uc]) groups[uc] = { uc, xs: [], ys: [], pesos: [], fichas: new Set() };
      if (!Number.isNaN(x)) groups[uc].xs.push(x);
      if (!Number.isNaN(y)) groups[uc].ys.push(y);
      groups[uc].pesos.push(peso);
      extractFichas(r.fichas_aplicadas).forEach(f => groups[uc].fichas.add(f));
    });

    return Object.values(groups).map(g => {
      const x = g.xs.length ? Math.max(...g.xs) : 0;
      const y = g.ys.length ? Math.max(...g.ys) : 0;
      if (!x && !y) return null;
      const peso = Math.max(...g.pesos);
      return {
        x, y, z: Math.max(1, peso) * 18, peso,
        uc: g.uc, fichas: [...g.fichas].join(', '),
      };
    }).filter(Boolean);
  }, [rows]);

  const medX = useMemo(() => {
    if (!pts.length) return 0;
    const s = [...pts].sort((a, b) => a.x - b.x);
    return s[Math.floor(s.length / 2)]?.x ?? 0;
  }, [pts]);
  const medY = useMemo(() => {
    if (!pts.length) return 0;
    const s = [...pts].sort((a, b) => a.y - b.y);
    return s[Math.floor(s.length / 2)]?.y ?? 0;
  }, [pts]);

  if (pts.length === 0) return (
    <div className="flex items-center justify-center h-32 text-xs opacity-30">
      Sem dados de desvio × valor para exibir matriz
    </div>
  );

  const fmtMoeda = (v) => v >= 1000 ? `R$${(v/1000).toFixed(0)}k` : `R$${v.toFixed(0)}`;

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload; if (!d) return null;
    const col = SEVERITY_COLORS[d.peso] ?? 'color-mix(in srgb, var(--fg) 55%, transparent)';
    return (
      <div className="rounded-lg border px-3 py-2 text-xs shadow-xl"
        style={{ background: 'var(--card)', borderColor: `color-mix(in srgb, ${col} 35%, transparent)`, color: 'var(--fg)', minWidth: 180 }}>
        <div className="font-bold font-mono mb-1" style={{ color: col }}>UC {d.uc}</div>
        {d.fichas && <div className="opacity-70 mb-1">{d.fichas}</div>}
        <div>Desvio: <span style={{ color: col }} className="font-semibold">{fmtPct(d.x)}</span></div>
        <div>Valor: <span className="font-semibold">{fmtCurrency(d.y)}</span></div>
        <div>Severidade: <span style={{ color: col }}>{SEVERITY_LABELS[d.peso]}</span></div>
      </div>
    );
  };

  const byPeso = [5,4,3,2,1].map(p => ({
    p, color: SEVERITY_COLORS[p], label: SEVERITY_LABELS[p],
    data: pts.filter(d => d.peso === p),
  })).filter(g => g.data.length > 0);

  return (
    <div className="rounded-lg border border-[var(--cpv2-border)] bg-[var(--cpv2-surface)] p-3">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-[11px] font-bold tracking-wide opacity-80">MATRIZ DE RISCO</div>
          <div className="text-[9px] opacity-40">{pts.length} UCs · pior mês histórico</div>
        </div>
        <div className="flex items-center gap-3 text-[10px] opacity-60">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{background:'var(--danger)'}}/> ACT NOW</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{background:'var(--warning)'}}/> Monitorar</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{background:'var(--success)'}}/> Baixo</span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <ScatterChart margin={{ top: 8, right: 28, bottom: 24, left: 12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="color-mix(in srgb, var(--fg) 8%, transparent)" />
          <XAxis dataKey="x" name="Desvio" type="number" unit="%" domain={['auto','auto']}
            tick={{ fontSize: 9, fill: 'color-mix(in srgb, var(--fg) 55%, transparent)' }}
            label={{ value: 'Desvio %', position: 'insideBottom', offset: -10, fontSize: 10, fill: 'color-mix(in srgb, var(--fg) 55%, transparent)' }} />
          <YAxis dataKey="y" name="Valor" type="number" tickFormatter={fmtMoeda}
            tick={{ fontSize: 9, fill: 'color-mix(in srgb, var(--fg) 55%, transparent)' }}
            label={{ value: 'Valor', angle: -90, position: 'insideLeft', offset: 10, fontSize: 10, fill: 'color-mix(in srgb, var(--fg) 55%, transparent)' }} />
          <ZAxis dataKey="z" range={[40, 220]} />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine x={medX} stroke="color-mix(in srgb, var(--fg) 15%, transparent)" strokeDasharray="5 3"/>
          <ReferenceLine y={medY} stroke="color-mix(in srgb, var(--fg) 15%, transparent)" strokeDasharray="5 3"/>
          <ReferenceArea x1={medX} y1={medY} fill="color-mix(in srgb, var(--danger) 6%, transparent)" />
          <ReferenceArea x2={medX} y1={medY} fill="color-mix(in srgb, var(--warning) 4%, transparent)" />
          <ReferenceArea x1={medX} y2={medY} fill="color-mix(in srgb, var(--warning) 3%, transparent)" />
          {byPeso.map(({ p, color, label, data }) => (
            <Scatter key={p} name={label} data={data} fill={color} fillOpacity={0.8} />
          ))}
          <Legend iconSize={8} iconType="circle" wrapperStyle={{ fontSize: 10, paddingTop: 4, color: 'color-mix(in srgb, var(--fg) 55%, transparent)' }} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Histórico Drawer (gráfico de barras com onClick)
   ──────────────────────────────────────────────────────────────────────────── */

// Teto robusto do eixo Y: capa em ~4× a mediana quando há outlier (misparse de consumo),
// pra as barras normais não sumirem. Retorna [0, cap] ou null (auto).
function robustKwhDomain(vals) {
  const vs = (vals || []).map(Number).filter((v) => v > 0).sort((a, b) => a - b);
  if (vs.length < 3) return null;
  const med = vs[Math.floor(vs.length / 2)];
  const max = vs[vs.length - 1];
  return (med > 0 && max > med * 4) ? [0, Math.ceil(med * 4)] : null;
}

function MiniChart({ titulo, dados, dataKey, cor, onBarClick, formatTip, media,
                    dataKey2, cor2, label1, label2, noScroll = false,
                    baselineKey }) {
  const hasSecond = !!dataKey2;
  const Tip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload;
    const val1 = Number(d[dataKey] ?? 0);
    const val2 = hasSecond ? Number(d[dataKey2] ?? 0) : null;
    const valExibir = val1 > 0 ? val1 : (val2 ?? 0);
    // "Geral" = vs média de todas as faturas (inclui esta) — como sempre foi.
    const devPct = media > 0 ? ((valExibir - media) / media * 100) : null;
    // "Específico" = vs média das outras faturas (exclui esta) — proxy do
    // que o motor SQL faz na janela de 12 meses anteriores. Mostra o pico
    // sem diluição. Ex: pico 500 com 5x100 → +200% (geral) vs +400% (específico).
    const baselineFatura = baselineKey ? Number(d[baselineKey] ?? 0) : 0;
    const devFatura = baselineFatura > 0 ? ((valExibir - baselineFatura) / baselineFatura * 100) : null;
    return (
      <div
        className="rounded border px-3 py-2 text-xs shadow-lg"
        style={{
          background: 'var(--card)',
          borderColor: 'color-mix(in srgb, var(--fg) 40%, transparent)',
          color: 'var(--fg)',
        }}
      >
        <div className="font-mono font-bold" style={{ color: 'var(--warning)' }}>
          {d.mesLabel || d.mes}
          {d.numeroFatura && (
            <span className="ml-2 text-[10px] font-normal opacity-70">
              · NF {d.numeroFatura}
            </span>
          )}
        </div>
        <div className="font-semibold flex items-center gap-2 mt-0.5" style={{ color: 'var(--fg)' }}>
          <span className="inline-block w-2 h-2 rounded-sm" style={{background: cor}}/>
          {label1 || 'fatura'}: {formatTip ? formatTip(val1) : val1}
        </div>
        {hasSecond && (
          <div className="font-semibold flex items-center gap-2 mt-0.5 opacity-80">
            <span className="inline-block w-2 h-2 rounded-sm border border-dashed" style={{borderColor: cor2}}/>
            {label2 || 'histórico'}: {formatTip ? formatTip(val2) : val2}
          </div>
        )}
        {devFatura !== null && (
          <div className={`text-[10px] mt-1 ${Math.abs(devFatura) > 50 ? 'text-[var(--warning)] font-bold' : 'opacity-70'}`}>
            <span className="opacity-70">desvio da fatura:</span>{' '}
            {devFatura >= 0 ? '+' : ''}{devFatura.toFixed(0)}%
            <span className="opacity-50"> (vs média histórica {formatTip ? formatTip(baselineFatura) : baselineFatura.toFixed(0)})</span>
          </div>
        )}
        {devPct !== null && (
          <div className={`text-[10px] mt-0.5 ${Math.abs(devPct) > 50 ? 'text-[color-mix(in_srgb,var(--accent-3)_80%,transparent)] font-semibold' : 'opacity-50'}`}>
            <span className="opacity-70">geral:</span>{' '}
            {devPct >= 0 ? '+' : ''}{devPct.toFixed(0)}%
            <span className="opacity-50"> (vs média UC {formatTip ? formatTip(media) : media.toFixed(0)})</span>
          </div>
        )}
        {/* Decisão IA refutou TODAS as flags candidatas — fatura era falso positivo.
            Mostra etiqueta "REFUTADO" pra rastreabilidade quando passa o mouse. */}
        {(() => {
          const ehConfirmado = String(d.decisaoFinal || '').toUpperCase() === 'CONFIRMADO';
          if (!ehConfirmado) return null;
          let confSet = new Set();
          try {
            const arr = JSON.parse(d.fichasConfirmadasRaw || '[]');
            if (Array.isArray(arr)) confSet = new Set(arr.map((s) => String(s).toUpperCase().trim()));
          } catch { /* json inválido */ }
          const motorTinhaFlags = (d.flagF01 + d.flagF02 + d.flagF03 + d.flagF04 + d.flagF05) > 0;
          const iaRefutouTudo = motorTinhaFlags && confSet.size === 0;
          if (!iaRefutouTudo) return null;
          return (
            <div className="text-[10px] mt-1 px-2 py-0.5 rounded font-bold inline-block"
                 style={{ background: 'color-mix(in srgb, var(--fg) 20%, transparent)', color: 'var(--fg)' }}>
              ✗ REFUTADO pela IA
            </div>
          );
        })()}
        {/* Flags do motor SQL — F02 / F03 / F04 / F05 */}
        {d.flagF02 === 1 && (
          <div className="text-[10px] mt-1 text-[var(--accent-3)]">
            📈 F02 — pico isolado de consumo
            {d.detalheF02 && <div className="opacity-70 mt-0.5">{d.detalheF02}</div>}
            {d.ressarcimentoEst > 0 && (
              <div className="mt-1 text-[var(--success)] font-semibold">
                💰 Ressarcimento estimado: {fmtCurrency(d.ressarcimentoEst)}
                {d.tarifaKwh > 0 && (
                  <span className="opacity-60 font-normal ml-1">
                    (tarifa {fmtCurrency(d.tarifaKwh)}/kWh)
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        {d.flagF03 === 1 && (
          <div className="text-[10px] mt-1 text-[var(--warning)]">
            ⚠️ F03 — acúmulo (consumo represado)
            {d.detalheF03 && <div className="opacity-70 mt-0.5">{d.detalheF03}</div>}
          </div>
        )}
        {d.flagF04 === 1 && (
          <div className="text-[10px] mt-1 text-[#7c6f9c]">
            🔄 F04 — troca de medidor
            {d.detalheF04 && <div className="opacity-70 mt-0.5">{d.detalheF04}</div>}
          </div>
        )}
        {d.flagF05 === 1 && (
          <div className="text-[10px] mt-1 text-[var(--danger)]">
            🔗 F05 — quebra de continuidade
            {d.detalheF05 && <div className="opacity-70 mt-0.5">{d.detalheF05}</div>}
          </div>
        )}
        {d.link && (
          <div className="text-[10px] opacity-60 mt-1">
            clique para abrir fatura
            {d.numeroFatura && (
              <div className="opacity-50">
                confira NF {d.numeroFatura} no PDF — se divergir, link errado
              </div>
            )}
          </div>
        )}
        {!d.link && d.fonte === 'historico' && (
          <div className="text-[10px] opacity-40 mt-1 italic">apenas histórico (sem fatura)</div>
        )}
      </div>
    );
  };

  // Renderiza emoji em cima da barra para flags F02/F03/F04/F05
  const FlagMarkers = (props) => {
    const { x, y, width, payload } = props;
    if (!payload) return null;
    const cx = x + width / 2;
    const items = [];
    if (payload.flagF02 === 1) items.push('📈');
    if (payload.flagF03 === 1) items.push('⚠️');
    if (payload.flagF04 === 1) items.push(payload.f04Aprovado === 'true' ? '✅' : '🔄');
    if (payload.flagF05 === 1) items.push('🔗');
    if (items.length === 0) return null;
    return (
      <text x={cx} y={y - 4} textAnchor="middle" fontSize={11}>
        {items.join(' ')}
      </text>
    );
  };
  return (
    <div className="rounded-lg border border-[var(--cpv2-border)] bg-[var(--cpv2-surface)] p-3">
      <div className="text-[11px] opacity-60 mb-2 flex items-center gap-2">
        {titulo}
        {hasSecond && (
          <span className="ml-2 flex items-center gap-2 text-[10px] opacity-80">
            <span className="inline-block w-2 h-2 rounded-sm" style={{background: cor}}/>
            {label1 || 'fatura'}
            <span className="inline-block w-3 border-t-2 border-dashed" style={{borderColor: cor2}}/>
            {label2 || 'histórico'}
          </span>
        )}
        {media > 0 && (
          <span className="ml-auto text-[10px] text-[var(--warning)] opacity-80">
            — média: {formatTip ? formatTip(media) : media.toFixed(0)}
          </span>
        )}
      </div>
      {/* Largura do gráfico cresce com o número de barras pra cada uma ter ~32px
          de área clicável. Wrapper externo permite scroll horizontal — quando
          noScroll=true, o caller envolve com um único scroll compartilhado. */}
      <div
        style={noScroll ? { width: 'fit-content' } : {
          overflowX: 'auto', overflowY: 'hidden', width: '100%',
          scrollbarWidth: 'thin', scrollbarColor: 'color-mix(in srgb, var(--fg) 40%, transparent) transparent',
        }}
      >
        <ComposedChart
          width={Math.max(720, dados.length * 32)}
          height={200}
          data={dados}
          margin={{ top: 8, right: 24, bottom: 28, left: 8 }}
          onClick={(state) => {
            const p = state?.activePayload?.[0];
            if (p?.payload) onBarClick({ payload: p.payload });
          }}
          style={{ cursor: 'pointer' }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="color-mix(in srgb, var(--fg) 8%, transparent)" />
          <XAxis dataKey="mes" tick={{ fontSize: 10, fill: 'color-mix(in srgb, var(--fg) 55%, transparent)' }} angle={-30} textAnchor="end" height={44} interval={0}/>
          <YAxis tick={{ fontSize: 9, fill: 'color-mix(in srgb, var(--fg) 55%, transparent)' }}
            tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v.toString()}
            domain={robustKwhDomain((dados || []).map((d) => d[dataKey])) || undefined}
            allowDataOverflow={robustKwhDomain((dados || []).map((d) => d[dataKey])) != null}/>
          <Tooltip
            content={<Tip />}
            offset={20}
            allowEscapeViewBox={{ x: false, y: true }}
            cursor={{ fill: 'color-mix(in srgb, var(--fg) 10%, transparent)' }}
            wrapperStyle={{ zIndex: 50, pointerEvents: 'none' }}
          />
          {media > 0 && (
            <ReferenceLine y={media} stroke="var(--warning)" strokeDasharray="4 2" strokeWidth={1.5}
              label={{ value: 'média', fill: 'var(--warning)', fontSize: 9, position: 'insideRight' }} />
          )}
          {/* Barra: dataKey principal — clicável + marcadores 📈 ⚠️ 🔄 🔗
              O onClick do gráfico inteiro permite clicar acima da barra
              quando ela está pequena (consumo mínimo). */}
          <Bar dataKey={dataKey} fill={cor} radius={[3, 3, 0, 0]} cursor="pointer"
               maxBarSize={28} minPointSize={3}
               onClick={(data) => onBarClick({ payload: data })}
               label={<FlagMarkers />}>
            {dados.map((d, i) => {
              const temFatura = d.kwhConfirmado > 0 || d.valor > 0 || d.id;
              let fill = temFatura ? cor : 'color-mix(in srgb, var(--fg) 40%, transparent)';
              if (media > 0 && temFatura) {
                const dev = (Number(d[dataKey]) - media) / media;
                if (dev > 1.0 || dev < -0.9) fill = 'var(--danger)';
                else if (dev > 0.5 || dev < -0.5) fill = 'var(--accent-3)';
              }
              return <Cell key={i} fill={fill} />;
            })}
          </Bar>
          {/* Linha tracejada: dataKey2 (histórico) — sobreposto sem competir por espaço horizontal */}
          {hasSecond && (
            <Line type="monotone" dataKey={dataKey2}
                  stroke={cor2} strokeWidth={1.8} strokeDasharray="4 3"
                  dot={{ r: 2.5, fill: cor2, strokeWidth: 0 }} activeDot={{ r: 4 }}
                  isAnimationActive={false} />
          )}
        </ComposedChart>
      </div>
    </div>
  );
}

function HistoricoDrawer({ uc, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Comparação de medidores entre faturas com F04 e a próxima cronológica
  const [analisando, setAnalisando] = useState(false);
  const [resultadoComp, setResultadoComp] = useState(null); // { uc, comparacoes: [...] }
  const [erroComp, setErroComp] = useState('');
  const [tempoDecorrido, setTempoDecorrido] = useState(0);

  // Verificação F05 — leituras anterior/atual entre faturas consecutivas
  const [verificandoF05, setVerificandoF05] = useState(false);
  const [resultadoF05, setResultadoF05] = useState(null);
  const [erroF05, setErroF05] = useState('');
  const [tempoF05, setTempoF05] = useState(0);

  // Filtro da tabela "TODAS AS FATURAS": por padrão mostra só as faturas com
  // pelo menos uma flag F01-F05 (a "fatura indicada como desvio"). Toggle pra
  // mostrar todas se o usuário quiser auditar o histórico inteiro da UC.
  const [somenteComDesvio, setSomenteComDesvio] = useState(true);

  // Cronômetro: roda enquanto analisando=true, atualiza a cada 100ms
  useEffect(() => {
    if (!analisando) return;
    const inicio = Date.now();
    setTempoDecorrido(0);
    const intervalId = setInterval(() => {
      setTempoDecorrido((Date.now() - inicio) / 1000);
    }, 100);
    return () => clearInterval(intervalId);
  }, [analisando]);

  const handleCompararMedidores = useCallback(async () => {
    if (!uc) return;
    setAnalisando(true); setErroComp(''); setResultadoComp(null);
    try {
      const r = await apiClient.get(`/api/v1/faturas/uc/${encodeURIComponent(uc)}/comparar-medidores`);
      setResultadoComp(r.data);
    } catch (e) {
      setErroComp(e?.response?.data?.error || 'Falha ao comparar medidores.');
    } finally {
      setAnalisando(false);
    }
  }, [uc]);

  // Cronômetro F05
  useEffect(() => {
    if (!verificandoF05) return;
    const inicio = Date.now();
    setTempoF05(0);
    const intervalId = setInterval(() => {
      setTempoF05((Date.now() - inicio) / 1000);
    }, 100);
    return () => clearInterval(intervalId);
  }, [verificandoF05]);

  const handleVerificarF05 = useCallback(async () => {
    if (!uc) return;
    setVerificandoF05(true); setErroF05(''); setResultadoF05(null);
    try {
      const r = await apiClient.get(`/api/v1/faturas/uc/${encodeURIComponent(uc)}/comparar-leituras`);
      setResultadoF05(r.data);
    } catch (e) {
      setErroF05(e?.response?.data?.error || 'Falha ao verificar F05.');
    } finally {
      setVerificandoF05(false);
    }
  }, [uc]);

  // Aprovar/Desaprovar F04 numa fatura específica.
  // Em sucesso, recarrega o histórico para refletir o novo estado.
  const recarregarHistorico = useCallback(() => {
    if (!uc) return;
    apiClient.get('/api/v1/faturas/fde-uc-historico', { params: { uc } })
      .then(r => setRows(r.data?.rows ?? []))
      .catch(() => { /* mantém estado */ });
  }, [uc]);

  const handleAprovarF04 = useCallback(async (idFatura) => {
    if (!idFatura) return;
    try {
      await apiClient.post(`/api/v1/faturas/${idFatura}/f04/aprovar`);
      recarregarHistorico();
    } catch (e) {
      alert(e?.response?.data?.error || 'Falha ao aprovar F04.');
    }
  }, [recarregarHistorico]);

  const handleDesaprovarF04 = useCallback(async (idFatura) => {
    if (!idFatura) return;
    if (!window.confirm('Desaprovar remove o apontamento F04 desta fatura. Confirma?')) return;
    try {
      await apiClient.post(`/api/v1/faturas/${idFatura}/f04/desaprovar`);
      recarregarHistorico();
    } catch (e) {
      alert(e?.response?.data?.error || 'Falha ao desaprovar F04.');
    }
  }, [recarregarHistorico]);

  // Fonte: FATURA_DADOS_EXTRAIDOS (db_ressarcimento)
  useEffect(() => {
    if (!uc) return;
    setLoading(true); setError('');
    apiClient.get('/api/v1/faturas/fde-uc-historico', { params: { uc } })
      .then(r => setRows(r.data?.rows ?? []))
      .catch(() => setError('Erro ao carregar histórico'))
      .finally(() => setLoading(false));
  }, [uc]);

  const data = useMemo(() => {
    return [...rows]
      .map(r => {
        // mes é mantido em 'YYYY-MM' apenas como chave de ordenação cronológica
        // (localeCompare ordena corretamente em ASCII). O que vai pra tela é
        // mesLabel ('MM/YYYY') — display amigável.
        const mesYM = String(r.mes ?? r.Mes_Ref ?? '').slice(0, 7);
        return ({
        mes:           mesYM,
        mesLabel:      fmtMesRef(mesYM),
        valor:         parseFloat(r.RS_Total_Fatura ?? 0) || 0,
        kwhTotal:      parseFloat(r.KWH_Total ?? 0) || 0,         // compat: prioriza confirmado, fallback histórico
        kwhConfirmado: parseFloat(r.kwh_confirmado ?? 0) || 0,    // novo: só fatura própria
        kwhHistorico:  parseFloat(r.kwh_historico ?? 0) || 0,     // novo: média de históricos embutidos
        fonte:         String(r.fonte ?? ''),                      // "fatura" | "historico" | "fatura+historico"
        link:          String(r.Link ?? '').trim(),
        id:            r.id,
        // Identificação da fatura — exibida no tooltip pra o usuário comparar
        // visualmente com o nº fiscal impresso no PDF que abrir. Se não bater,
        // o link_fatura está cruzado para essa fatura.
        numeroFatura:  String(r.numero_fatura ?? '').trim(),
        // Motor SQL — flags F01-F05 + detalhes
        medidor:       String(r.medidor ?? ''),
        flagF01:       Number(r.flag_f01 ?? 0),
        flagF02:       Number(r.flag_f02 ?? 0),
        flagF03:       Number(r.flag_f03 ?? 0),
        flagF04:       Number(r.flag_f04 ?? 0),
        flagF05:       Number(r.flag_f05 ?? 0),
        f04Aprovado:   String(r.f04_aprovado ?? ''), // "true" | "false" | ""
        decisaoFinal:        String(r.decisao_final ?? ''),       // 'CONFIRMADO' | 'REFUTADO' | 'INCONCLUSIVO' | ''
        fichasConfirmadasRaw: String(r.fichas_confirmadas ?? ''), // JSON array como string
        detalheF02:    String(r.detalhe_f02 ?? ''),
        detalheF03:    String(r.detalhe_f03 ?? ''),
        detalheF04:    String(r.detalhe_f04 ?? ''),
        detalheF05:    String(r.detalhe_f05 ?? ''),
        tarifaKwh:        parseFloat(r.tarifa_kwh ?? 0) || 0,
        ressarcimentoEst: parseFloat(r.ressarcimento_estimado ?? 0) || 0,
        fichasMotor:   String(r.fichas_aplicadas ?? ''),
        classificacaoHist: String(r.classificacao_historico ?? ''), // advisory: ELEVADO_REAL|DENTRO_DO_HISTORICO|SAZONAL
        observacaoAuditado: String(r.observacao_auditado ?? ''), // nota de verificação do analista (editável, sobrevive ao rebuild)
        });
      })
      .filter(d => d.mes)
      .sort((a, b) => a.mes.localeCompare(b.mes));
  }, [rows]);

  const mediaValor    = useMemo(() => { const vs = data.filter(d => d.valor > 0).map(d => d.valor);       return vs.length ? vs.reduce((a,b)=>a+b,0)/vs.length : 0; }, [data]);
  const mediaKwhTotal = useMemo(() => {
    // Média prioriza kwh_confirmado; se a coluna estiver vazia, usa kwhTotal (que já tem fallback do histórico)
    const vs = data.filter(d => d.kwhConfirmado > 0).map(d => d.kwhConfirmado);
    if (vs.length) return vs.reduce((a,b)=>a+b,0)/vs.length;
    const vsTotal = data.filter(d => d.kwhTotal > 0).map(d => d.kwhTotal);
    return vsTotal.length ? vsTotal.reduce((a,b)=>a+b,0)/vsTotal.length : 0;
  }, [data]);

  // Para cada fatura, anexa a média da UC EXCLUINDO ela própria — esse é o
  // baseline correto pra calcular "desvio da fatura específica vs histórico".
  // A média geral (mediaValor / mediaKwhTotal) inclui a fatura suspeita, então
  // dilui o pico (ex: pico 500 + 5x100 → média 167, desvio +200% em vez de +400%).
  // Mostramos os dois no tooltip pra o usuário comparar.
  const dataComBaseline = useMemo(() => {
    const valVs = data.filter(d => d.valor > 0);
    const kwhVs = data.filter(d => d.kwhConfirmado > 0);
    const sumVal = valVs.reduce((a, d) => a + d.valor, 0);
    const sumKwh = kwhVs.reduce((a, d) => a + d.kwhConfirmado, 0);
    return data.map(d => {
      const nVal = valVs.length - (d.valor > 0 ? 1 : 0);
      const nKwh = kwhVs.length - (d.kwhConfirmado > 0 ? 1 : 0);
      const baselineValor = nVal > 0 ? (sumVal - (d.valor > 0 ? d.valor : 0)) / nVal : 0;
      const baselineKwh   = nKwh > 0 ? (sumKwh - (d.kwhConfirmado > 0 ? d.kwhConfirmado : 0)) / nKwh : 0;
      return { ...d, baselineValor, baselineKwh };
    });
  }, [data]);

  const handleBarClick = useCallback((p) => {
    const link = p?.payload?.link;
    if (!link) { alert('Esta fatura não tem PDF vinculado.'); return; }
    window.open(link, '_blank', 'noopener,noreferrer');
  }, []);

  const fmtKwh = (v) => `${v.toLocaleString('pt-BR')} kWh`;

  return (
    <div className="fixed inset-0 z-[9999] flex justify-end bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-3xl bg-[var(--cpv2-surface-2)] flex flex-col border-l border-[var(--cpv2-border)] h-full"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--cpv2-border)]"
          style={{ background: 'var(--gradient-primary)' }}>
          <div>
            <div className="text-white font-bold text-sm">Histórico da UC — FATURA_DADOS_EXTRAIDOS</div>
            <div className="text-white/50 text-xs font-mono mt-0.5">{uc}</div>
          </div>
          <button onClick={onClose} className="text-white/60 hover:text-white text-xl leading-none px-2">×</button>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-3">
          {loading && <div className="text-sm opacity-60 py-8 text-center">Carregando histórico...</div>}
          {error   && <div className="text-sm text-[var(--danger)] py-8 text-center">{error}</div>}
          {!loading && !error && data.length === 0 && (
            <div className="text-sm opacity-60 py-8 text-center">Sem histórico disponível para esta UC.</div>
          )}
          {!loading && !error && data.length > 0 && (
            <>
              {/* Scroll horizontal compartilhado: uma única barra embaixo arrasta
                  os dois gráficos juntos, mantendo os meses sempre alinhados. */}
              <div
                style={{
                  overflowX: 'auto', overflowY: 'hidden',
                  scrollbarWidth: 'thin', scrollbarColor: 'color-mix(in srgb, var(--fg) 40%, transparent) transparent',
                }}
                className="space-y-3"
              >
                <MiniChart
                  noScroll
                  titulo="VALOR DA FATURA · clique numa barra para abrir o PDF"
                  dados={dataComBaseline} dataKey="valor" cor="var(--accent)"
                  onBarClick={handleBarClick} formatTip={fmtCurrency} media={mediaValor}
                  baselineKey="baselineValor"
                />
                <MiniChart
                  noScroll
                  titulo="kWh CONSUMIDO — confirmado (fatura) vs histórico (referência de outras faturas)"
                  dados={dataComBaseline}
                  dataKey="kwhConfirmado" cor="var(--warning)"
                  dataKey2="kwhHistorico" cor2="color-mix(in srgb, var(--fg) 55%, transparent)"
                  label1="confirmado" label2="histórico"
                  onBarClick={handleBarClick} formatTip={fmtKwh} media={mediaKwhTotal}
                  baselineKey="baselineKwh"
                />
              </div>

              {/* Bloco — Comparar números de medidor entre faturas com F04 */}
              {(() => {
                const totalF04 = data.filter(d => d.flagF04 === 1 && d.id).length;
                if (totalF04 === 0) return null;
                return (
                  <div className="rounded-lg border-2 border-[color-mix(in_srgb,#7c6f9c_30%,transparent)] bg-[color-mix(in_srgb,#7c6f9c_5%,transparent)] p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-[#7c6f9c] font-bold">🔄 Apontamento de medidor (F04)</span>
                        <span className="opacity-60">
                          {totalF04} fatura{totalF04 > 1 ? 's' : ''} com flag de troca
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={handleCompararMedidores}
                        disabled={analisando}
                        className="text-[11px] font-semibold px-3 py-1.5 rounded border border-[color-mix(in_srgb,#7c6f9c_40%,transparent)] bg-[color-mix(in_srgb,#7c6f9c_10%,transparent)] text-[#7c6f9c] hover:bg-[color-mix(in_srgb,#7c6f9c_20%,transparent)] transition-colors disabled:opacity-70 flex items-center gap-2"
                      >
                        {analisando ? (
                          <>
                            <span className="inline-block animate-spin">⏳</span>
                            <span>Analisando…</span>
                            <span className="font-mono tabular-nums opacity-80">{tempoDecorrido.toFixed(1)}s</span>
                          </>
                        ) : (
                          '🔍 Analisar números de medidor'
                        )}
                      </button>
                    </div>

                    {erroComp && (
                      <div className="mt-2 text-xs text-[var(--danger)]">{erroComp}</div>
                    )}

                    {resultadoComp && Array.isArray(resultadoComp.comparacoes) && resultadoComp.comparacoes.length > 0 && (
                      <div className="mt-3 rounded border border-[var(--cpv2-border)] bg-[var(--cpv2-surface-2)] overflow-hidden">
                        <table className="w-full text-xs">
                          <thead className="bg-[var(--cpv2-surface)]">
                            <tr>
                              <th className="px-3 py-2 text-left">Mês apontada</th>
                              <th className="px-3 py-2 text-left">Medidor</th>
                              <th className="px-2 py-2 text-center opacity-40">→</th>
                              <th className="px-3 py-2 text-left">Mês seguinte</th>
                              <th className="px-3 py-2 text-left">Medidor</th>
                              <th className="px-3 py-2 text-left">Veredicto</th>
                              <th className="px-3 py-2 text-center">Ação</th>
                            </tr>
                          </thead>
                          <tbody>
                            {resultadoComp.comparacoes.map((c, i) => {
                              const pill = {
                                falso_positivo: { bg: 'var(--success)', label: '✗ Falso positivo' },
                                troca_real:     { bg: '#7c6f9c', label: '✓ Troca real' },
                                sem_dados:      { bg: 'color-mix(in srgb, var(--fg) 45%, var(--card))', label: '? Sem dados' },
                                sem_proxima:    { bg: 'var(--warning)', label: '⚠ Sem próxima' },
                              }[c.veredicto] || { bg: 'color-mix(in srgb, var(--fg) 45%, var(--card))', label: c.veredicto };
                              // Estado atual da fatura no histórico (após eventual aprovação)
                              const linhaData = data.find(d => d.id === c.id_apontada);
                              const aprovado    = linhaData?.f04Aprovado === 'true';
                              const desaprovado = linhaData?.flagF04 !== 1; // F04 já removido
                              return (
                                <tr key={i} className="border-t border-[var(--cpv2-border)]">
                                  <td className="px-3 py-2 font-mono">{c.mes_apontada || '—'}</td>
                                  <td className="px-3 py-2 font-mono">
                                    {c.medidor_apontada || <span className="opacity-30">—</span>}
                                  </td>
                                  <td className="px-2 py-2 text-center opacity-40">→</td>
                                  <td className="px-3 py-2 font-mono">{c.mes_proxima || <span className="opacity-30">—</span>}</td>
                                  <td className="px-3 py-2 font-mono">
                                    {c.medidor_proxima || <span className="opacity-30">—</span>}
                                  </td>
                                  <td className="px-3 py-2">
                                    <div className="flex flex-col gap-1">
                                      <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold text-white whitespace-nowrap w-fit"
                                            style={{ background: pill.bg }}>
                                        {pill.label}
                                      </span>
                                      <span className="text-[10px] opacity-60">{c.motivo}</span>
                                    </div>
                                  </td>
                                  <td className="px-3 py-2 text-center">
                                    {aprovado ? (
                                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold bg-[color-mix(in_srgb,var(--success)_15%,transparent)] text-[var(--success)] border border-[color-mix(in_srgb,var(--success)_40%,transparent)]">
                                        ✅ Aprovado
                                      </span>
                                    ) : desaprovado ? (
                                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold bg-[color-mix(in_srgb,var(--fg)_15%,transparent)] text-[color-mix(in_srgb,var(--fg)_55%,transparent)] border border-[color-mix(in_srgb,var(--fg)_40%,transparent)]">
                                        ⊘ Desaprovado
                                      </span>
                                    ) : (
                                      <div className="flex flex-col gap-1 items-center">
                                        <button
                                          type="button"
                                          onClick={() => handleAprovarF04(c.id_apontada)}
                                          className="text-[10px] font-semibold px-2 py-1 rounded border border-[color-mix(in_srgb,var(--success)_40%,transparent)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)] hover:bg-[color-mix(in_srgb,var(--success)_20%,transparent)] transition-colors w-full whitespace-nowrap"
                                        >
                                          ✓ Aprovar apontamento
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => handleDesaprovarF04(c.id_apontada)}
                                          className="text-[10px] font-semibold px-2 py-1 rounded border border-[color-mix(in_srgb,var(--danger)_40%,transparent)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_20%,transparent)] transition-colors w-full whitespace-nowrap"
                                        >
                                          ✗ Desaprovar apontamento
                                        </button>
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Bloco — Verificar F05 (quebra de continuidade) */}
              {(() => {
                const totalF05 = data.filter(d => d.flagF05 === 1 && d.id).length;
                if (totalF05 === 0) return null;
                return (
                  <div className="rounded-lg border-2 border-[color-mix(in_srgb,var(--danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--danger)_5%,transparent)] p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-[var(--danger)] font-bold">🔗 Quebra de continuidade (F05)</span>
                        <span className="opacity-60">
                          {totalF05} fatura{totalF05 > 1 ? 's' : ''} com flag de quebra
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={handleVerificarF05}
                        disabled={verificandoF05}
                        className="text-[11px] font-semibold px-3 py-1.5 rounded border border-[color-mix(in_srgb,var(--danger)_40%,transparent)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_20%,transparent)] transition-colors disabled:opacity-70 flex items-center gap-2"
                      >
                        {verificandoF05 ? (
                          <>
                            <span className="inline-block animate-spin">⏳</span>
                            <span>Verificando…</span>
                            <span className="font-mono tabular-nums opacity-80">{tempoF05.toFixed(1)}s</span>
                          </>
                        ) : (
                          '🔍 Verificar F05'
                        )}
                      </button>
                    </div>

                    {erroF05 && (
                      <div className="mt-2 text-xs text-[var(--danger)]">{erroF05}</div>
                    )}

                    {resultadoF05 && Array.isArray(resultadoF05.comparacoes) && resultadoF05.comparacoes.length > 0 && (
                      <div className="mt-3 rounded border border-[var(--cpv2-border)] bg-[var(--cpv2-surface-2)] overflow-hidden">
                        <table className="w-full text-xs">
                          <thead className="bg-[var(--cpv2-surface)]">
                            <tr>
                              <th className="px-3 py-2 text-left">Mês anterior</th>
                              <th className="px-3 py-2 text-right">Leitura final</th>
                              <th className="px-2 py-2 text-center opacity-40">→</th>
                              <th className="px-3 py-2 text-left">Mês atual (F05)</th>
                              <th className="px-3 py-2 text-right">Leitura inicial</th>
                              <th className="px-3 py-2 text-right">Δ</th>
                              <th className="px-3 py-2 text-left">Veredicto</th>
                            </tr>
                          </thead>
                          <tbody>
                            {resultadoF05.comparacoes.map((c, i) => {
                              const pill = {
                                falso_positivo: { bg: 'var(--success)', label: '✗ Falso positivo' },
                                quebra_real:    { bg: 'var(--danger)', label: '⚠ Quebra real' },
                                sem_dados:      { bg: 'color-mix(in srgb, var(--fg) 45%, var(--card))', label: '? Sem dados' },
                                sem_anterior:   { bg: 'var(--warning)', label: '⚠ Sem anterior' },
                              }[c.veredicto] || { bg: 'color-mix(in srgb, var(--fg) 45%, var(--card))', label: c.veredicto };
                              const fmtNum = (n) => Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
                              return (
                                <tr key={i} className="border-t border-[var(--cpv2-border)]">
                                  <td className="px-3 py-2 font-mono">{c.mes_anterior || <span className="opacity-30">—</span>}</td>
                                  <td className="px-3 py-2 text-right font-mono">
                                    {c.leitura_atual_anterior > 0 ? fmtNum(c.leitura_atual_anterior) : <span className="opacity-30">—</span>}
                                  </td>
                                  <td className="px-2 py-2 text-center opacity-40">→</td>
                                  <td className="px-3 py-2 font-mono">{c.mes_apontada || '—'}</td>
                                  <td className="px-3 py-2 text-right font-mono">
                                    {c.leitura_anterior_atual > 0 ? fmtNum(c.leitura_anterior_atual) : <span className="opacity-30">—</span>}
                                  </td>
                                  <td className="px-3 py-2 text-right font-mono">
                                    {Math.abs(c.diferenca || 0) > 0 ? (
                                      <span className={c.veredicto === 'quebra_real' ? 'text-[var(--danger)] font-semibold' : ''}>
                                        {c.diferenca > 0 ? '+' : ''}{fmtNum(c.diferenca)}
                                      </span>
                                    ) : <span className="opacity-30">—</span>}
                                  </td>
                                  <td className="px-3 py-2">
                                    <div className="flex flex-col gap-1">
                                      <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold text-white whitespace-nowrap w-fit"
                                            style={{ background: pill.bg }}>
                                        {pill.label}
                                      </span>
                                      <span className="text-[10px] opacity-60">{c.motivo}</span>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })()}

              {(() => {
                // Pré-computa quais linhas têm desvio (alguma flag F01-F05).
                // O array original `data` continua íntegro pra alimentar o gráfico
                // e a comparação medAnt; só o tbody usa `dataExibir` filtrada.
                const dataExibir = somenteComDesvio
                  ? data.filter((d) => obterFlagsExibicao(d).flags.size > 0)
                  : data;
                return (
              <div className="rounded-lg border border-[var(--cpv2-border)] bg-[var(--cpv2-surface)]">
                <div className="text-[11px] opacity-60 px-3 py-2 border-b border-[var(--cpv2-border)] flex items-center gap-3 flex-wrap">
                  <span>
                    {somenteComDesvio ? 'FATURAS COM APONTAMENTO' : 'TODAS AS FATURAS'} · {dataExibir.length}
                    {somenteComDesvio && data.length !== dataExibir.length && (
                      <span className="opacity-50 ml-1">de {data.length}</span>
                    )}
                  </span>
                  <label className="inline-flex items-center gap-1.5 text-[10px] cursor-pointer select-none ml-3">
                    <input
                      type="checkbox"
                      checked={somenteComDesvio}
                      onChange={(e) => setSomenteComDesvio(e.target.checked)}
                      className="accent-amber-500"
                    />
                    <span>Só com apontamento (F01–F05)</span>
                  </label>
                  <span className="ml-auto flex items-center gap-3 text-[10px] opacity-80">
                    <span>🔄 F04 troca medidor</span>
                    <span>🔗 F05 quebra continuidade</span>
                  </span>
                </div>
                <div className="max-h-80 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-[var(--cpv2-surface-2)] sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left">Mês</th>
                        <th className="px-3 py-2 text-right">Valor R$</th>
                        <th className="px-3 py-2 text-right">kWh Total</th>
                        <th className="px-3 py-2 text-left">Medidor</th>
                        <th className="px-3 py-2 text-center">Flags</th>
                        <th className="px-3 py-2 text-right" title="Diferença entre o consumo e a média da UC, multiplicada pela tarifa R$/kWh efetiva da fatura. Calculado apenas para meses com F02 confirmado.">
                          💰 Ressarc. estim.
                        </th>
                        <th className="px-3 py-2 text-center">PDF</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dataExibir.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-3 py-8 text-center text-xs opacity-50">
                            Nenhuma fatura com apontamento de desvio nesta UC.
                          </td>
                        </tr>
                      ) : null}
                      {dataExibir.map((d) => {
                        // medAnt usa a posição na lista original (cronológica completa)
                        // pra detectar troca de medidor real, mesmo quando filtramos.
                        const idxOrig = data.indexOf(d);
                        const medAnt = idxOrig > 0 ? data[idxOrig - 1].medidor : '';
                        const trocou = d.medidor && medAnt && d.medidor !== medAnt;
                        // Prioriza decisão IA (fichas_confirmadas) sobre motor SQL.
                        // Quando IA refuta o motor (ex: F01 do motor → F03 da IA), exibimos F03.
                        const { flags: flagSet, fonte: flagsFonte } = obterFlagsExibicao(d);
                        const flags = [];
                        // F01 não é renderizado por decisão de UX — ver obterFlagsExibicao
                        if (flagSet.has('F02')) flags.push('📈 F02');
                        if (flagSet.has('F03')) flags.push('⚠️ F03');
                        if (flagSet.has('F04')) flags.push(d.f04Aprovado === 'true' ? '✅ F04' : '🔄 F04');
                        if (flagSet.has('F05')) flags.push('🔗 F05');
                        // Linha DOURADA = VERDADEIRO (apontamento real). Linha AZUL = dentro da resolução (regra 3 meses).
                        // Laranja aposentado: só faria sentido p/ "parcelamento não cumprido", e não há mais nenhum (reqs removidas).
                        const _obsAud = String(d.observacaoAuditado || '');
                        const isVerdadeiroAud = /VERDADEIRO/i.test(_obsAud);
                        const isLaranjaAud = false;
                        const isAzulAud = !isVerdadeiroAud && !isLaranjaAud && /(DENTRO DA RESOLU|SEM M[ÉE]DIA)/i.test(_obsAud);
                        return (
                          <tr key={`${d.id || 'h'}-${d.mes}`} className={`border-t border-[var(--cpv2-border)] hover:bg-[var(--cpv2-surface-2)] ${isVerdadeiroAud ? 'aud-linha-ouro' : isLaranjaAud ? 'aud-linha-laranja' : isAzulAud ? 'aud-linha-azul' : ''}`}>
                            <td className="px-3 py-2 font-mono whitespace-nowrap">
                              {isVerdadeiroAud && (
                                <span title="VERDADEIRO — apontamento real conferido no PDF" style={{ color: '#b8860b' }}>★ </span>
                              )}
                              {isLaranjaAud && (
                                <span title="Candidato / rejeitado — mérito a confirmar pela analista" style={{ color: '#a2470a' }}>◆ </span>
                              )}
                              {d.mesLabel || d.mes}
                              {d.fonte === 'historico' && (
                                <span className="ml-1 text-[9px] opacity-50 italic">(hist)</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right">{d.valor > 0 ? fmtCurrency(d.valor) : '—'}</td>
                            <td className="px-3 py-2 text-right font-mono">
                              {d.kwhTotal > 0 ? d.kwhTotal.toLocaleString('pt-BR', {maximumFractionDigits: 0}) : '—'}
                            </td>
                            <td className="px-3 py-2 font-mono whitespace-nowrap">
                              {d.medidor || <span className="opacity-30">—</span>}
                              {trocou && (
                                <span className="ml-1 text-[10px] text-[#7c6f9c]" title={`anterior: ${medAnt}`}>
                                  ←{medAnt}
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-center">
                              {flags.length === 0
                                ? <span className="opacity-30">—</span>
                                : (
                                  <span
                                    className="font-mono text-[10px]"
                                    title={flagsFonte === 'ia' ? 'Decisão final da IA (refuta motor SQL quando aplicável)' : 'Motor SQL'}
                                  >
                                    {flags.join(' · ')}
                                    {flagsFonte === 'ia' && <span className="ml-1 opacity-60">·IA</span>}
                                  </span>
                                )
                              }
                              {flagSet.has('F02') && d.classificacaoHist && (() => {
                                const cfg = {
                                  ELEVADO_REAL:        { t: 'elevado real', bg: 'color-mix(in srgb, var(--danger) 18%, transparent)', fg: 'var(--danger)' },
                                  DENTRO_DO_HISTORICO: { t: 'no histórico',  bg: 'color-mix(in srgb, var(--success) 18%, transparent)', fg: 'var(--success)' },
                                  SAZONAL:             { t: 'sazonal',       bg: 'color-mix(in srgb, var(--warning) 18%, transparent)', fg: 'var(--warning)' },
                                }[d.classificacaoHist];
                                return cfg ? (
                                  <span className="ml-1 px-1 rounded text-[9px] font-semibold whitespace-nowrap"
                                    style={{ backgroundColor: cfg.bg, color: cfg.fg }}
                                    title="Classificação por histórico/sazonalidade (advisory — não remove o apontamento)">
                                    {cfg.t}
                                  </span>
                                ) : null;
                              })()}
                              {/* observação do analista movida p/ dentro do modal (render morto) */}
                            </td>
                            <td className="px-3 py-2 text-right font-mono">
                              {d.ressarcimentoEst > 0 ? (
                                <span
                                  className="text-[var(--success)] font-semibold"
                                  title={d.tarifaKwh > 0 ? `tarifa efetiva: ${fmtCurrency(d.tarifaKwh)}/kWh` : ''}
                                >
                                  {fmtCurrency(d.ressarcimentoEst)}
                                </span>
                              ) : (
                                <span className="opacity-30">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-center">
                              {d.link
                                ? <a href={d.link} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">abrir</a>
                                : <span className="opacity-30">—</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
                );
              })()}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Modal Análise IA — mostra resultado salvo + reprocessar
   ──────────────────────────────────────────────────────────────────────────── */

function AnaliseIAModal({ row: rowProp, onClose, onReprocessed }) {
  const [reprocessing, setReprocessing] = useState(false);
  const [progresso, setProgresso] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // ⭐ Estado interno: row atualiza após reanálise (sem precisar fechar modal)
  const [row, setRow] = useState(rowProp);
  useEffect(() => { setRow(rowProp); }, [rowProp]);

  const decisao = getDecisao(row);
  const analise = parseAnalises(row?.resultado_analises);
  const triagem = analise?.triagem_confirmar;
  const apontamentos = analise?.ia_4_1_apontamentos;

  // Recarrega dados frescos da API (após reanálise/processar-v2)
  // Usa ?id= para buscar 1 fatura específica (ignora filtros de empresa/status/etc)
  const recarregarRow = useCallback(async () => {
    if (!row?.id) return;
    try {
      const res = await apiClient.get('/api/v1/faturas/fde-analise', {
        params: { id: row.id, limit: 1 },
      });
      const arr = Array.isArray(res.data) ? res.data : (res.data?.rows ?? []);
      const atual = arr[0]; // ?id= retorna no máximo 1
      if (atual) setRow(atual);
    } catch (_) { /* silent */ }
  }, [row?.id]);

  // A lista vem ENXUTA (sem o detalhe pesado, p/ carregar rápido). Ao abrir o modal,
  // rebusca a fatura por ?id= (payload completo) p/ o DetalhesV19 mostrar tudo.
  useEffect(() => { recarregarRow(); }, [recarregarRow]);

  const handleReprocessar = useCallback(async () => {
    setReprocessing(true); setError(''); setSuccess(''); setProgresso('');
    try {
      // PASSO 1 — Reanálise gpt-5.4 com PDF anexado (atualiza fichas_apontadas)
      setProgresso('1/2 — Rodando gpt-5.4 com PDF...');
      const res = await apiClient.post(`/api/v1/faturas/${row.id}/reanalise-fde`);
      const ok = res?.data?.decisao?.decisao_final;
      const pdfAnex = res?.data?.pdf_anexado ? ' (PDF anexado)' : '';

      // PASSO 2 — pdf_pipeline_v2: popula as 34 colunas v19 (parcela_art323_*, etc)
      setProgresso(`2/2 — ${ok}${pdfAnex}. Populando colunas v19 com gpt-4.1-mini...`);
      try {
        const v2 = await apiClient.post(`/api/v1/faturas/${row.id}/processar-v2`);
        const score = v2?.data?.score_confianca;
        const passib = v2?.data?.status_passibilidade;
        setSuccess(
          `✅ Reanálise concluída: ${ok}${pdfAnex} | ` +
          `Score v19: ${score ?? '—'}/100 | Passibilidade: ${passib ?? '—'}. Atualizando modal...`
        );
      } catch (eV2) {
        // Falha no v2 não quebra a reanálise principal — só avisa
        setSuccess(`✅ Reanálise concluída: ${ok}${pdfAnex}. ⚠️ v19 não populado (${eV2?.response?.data?.error || 'erro Python'}).`);
      }

      // PASSO 3 — Recarrega dados frescos (atualiza tabelas e seções do modal)
      await recarregarRow();
      setProgresso('');
      onReprocessed?.(row.id);
    } catch (e) {
      setError(e?.response?.data?.error || 'Falha ao reanalisar.');
      setProgresso('');
    } finally {
      setReprocessing(false);
    }
  }, [row?.id, onReprocessed, recarregarRow]);

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-3xl bg-[var(--cpv2-surface-2)] rounded-xl shadow-2xl flex flex-col border border-[var(--cpv2-border)]"
        style={{ maxHeight: '92vh' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 rounded-t-xl"
          style={{ background: 'var(--gradient-primary)' }}>
          <div>
            <div className="text-white font-bold text-sm">Análise da IA</div>
            <div className="text-white/50 text-xs font-mono mt-0.5">UC {row.UC} · ID {row.id}</div>
          </div>
          <button onClick={onClose} className="text-white/60 hover:text-white text-xl leading-none px-2">×</button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          {!analise && (
            <div className="rounded-lg border border-[color-mix(in_srgb,var(--warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] p-4 text-sm">
              Nenhuma análise IA disponível. Clique em <strong>Analisar com IA</strong> para iniciar.
            </div>
          )}

          {decisao && (
            <div className="rounded-lg border border-[var(--cpv2-border)] bg-[var(--cpv2-surface)] p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[11px] opacity-60">DECISÃO FINAL · gpt-5.4</div>
                <StatusBadge status={decisao.decisao_final} />
              </div>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <div className="text-[10px] opacity-60">Confiança</div>
                  <div className="font-bold text-[var(--accent)]">{decisao.confianca_final ?? 0}%</div>
                </div>
                <div>
                  <div className="text-[10px] opacity-60">Ressarcimento</div>
                  <div className="font-bold text-[var(--success)]">{decisao.percentual_ressarcimento ?? 0}%</div>
                </div>
                <div>
                  <div className="text-[10px] opacity-60">Ficha principal</div>
                  <div className="font-bold">{decisao.ficha_principal || '—'}</div>
                </div>
              </div>
              {decisao.fichas_confirmadas?.length > 0 && (
                <div>
                  <div className="text-[10px] opacity-60 mb-1">Fichas confirmadas</div>
                  <FichasBadge fichas={decisao.fichas_confirmadas} />
                </div>
              )}
              {decisao.justificativa && (
                <div>
                  <div className="text-[10px] opacity-60 mb-1">Justificativa</div>
                  <div className="text-xs whitespace-pre-wrap leading-relaxed">{decisao.justificativa}</div>
                </div>
              )}
              {decisao.recomendacao && (
                <div>
                  <div className="text-[10px] opacity-60 mb-1">Recomendação</div>
                  <div className="text-xs whitespace-pre-wrap leading-relaxed">{decisao.recomendacao}</div>
                </div>
              )}
            </div>
          )}

          {triagem && (
            <div className="rounded-lg border border-[var(--cpv2-border)] bg-[var(--cpv2-surface)] p-4 space-y-2">
              <div className="text-[11px] opacity-60">TRIAGEM · gpt-4.1-mini</div>
              {triagem.fichas_confirmadas?.length > 0 && (
                <div>
                  <div className="text-[10px] opacity-60 mb-1">Fichas que a triagem confirmou</div>
                  <FichasBadge fichas={triagem.fichas_confirmadas} />
                </div>
              )}
              {apontamentos?.analise && (
                <div>
                  <div className="text-[10px] opacity-60 mb-1">Análise inicial</div>
                  <div className="text-xs whitespace-pre-wrap leading-relaxed opacity-80">{apontamentos.analise}</div>
                </div>
              )}
            </div>
          )}

          {/* ⭐ v19 — Detalhes completos extraídos pelo pdf_pipeline_v2 */}
          <DetalhesV19 row={row} />

          {/* ⭐ v19 — Histórico de reanálises (audit trail) */}
          <HistoricoReanalises faturaId={row.id} chave={row?.resultado_em} />

          {progresso && (
            <div className="text-sm text-[var(--accent)] flex items-center gap-2">
              <span className="inline-block w-3 h-3 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin"/>
              {progresso}
            </div>
          )}
          {error &&<div className="text-sm text-[var(--danger)]">{error}</div>}
          {success && <div className="text-sm text-[var(--success)]">{success}</div>}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-[var(--cpv2-border)]">
          <button onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-[var(--cpv2-border)] hover:bg-[var(--cpv2-surface)]">
            Fechar
          </button>
          <button onClick={handleReprocessar} disabled={reprocessing}
            className="px-4 py-2 text-sm rounded-lg text-white font-semibold disabled:opacity-50"
            style={{ backgroundColor: 'var(--accent)' }}>
            {reprocessing ? 'Reprocessando...' : 'Reanalisar com IA'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Modal Criar Requisição — pré-preenchido com fatura + análise
   ──────────────────────────────────────────────────────────────────────────── */

// Mapeamento padrão ficha F01-F05 → id_tipo_irregularidade + id_subtipo_irregularidade
// das tabelas DM_TIPO_IRREGULARIDADE / DM_SUBTIPO_IRREGULARIDADE.
// Mantém o backend feliz com IDs reais e deixa as fichas (F02/F03) viverem na
// descrição/comentário da requisição, sem virar "tipo de irregularidade".
const FICHA_PARA_IRREGULARIDADE = {
  F01: { id_tipo: 7, nome_tipo: 'LEITURA',     id_subtipo: 11, nome_subtipo: 'Erro de leitura' },
  F02: { id_tipo: 3, nome_tipo: 'CONSUMO',     id_subtipo: 5,  nome_subtipo: 'Elevado' },
  F03: { id_tipo: 5, nome_tipo: 'FATURAMENTO', id_subtipo: 12, nome_subtipo: 'Faturado por média' },
  F04: { id_tipo: 7, nome_tipo: 'LEITURA',     id_subtipo: 20, nome_subtipo: 'Medidor queimado' },
  F05: { id_tipo: 7, nome_tipo: 'LEITURA',     id_subtipo: 29, nome_subtipo: 'Sem leitura' },
};
const IRREGULARIDADE_DEFAULT = { id_tipo: 5, nome_tipo: 'FATURAMENTO', id_subtipo: 14, nome_subtipo: 'Tarifa indevida' };

function CriarRequisicaoModal({ row, onClose, onCreated }) {
  const decisao = getDecisao(row);
  const fichasIA = decisao?.fichas_confirmadas ?? [];
  const valorFatura = Number(row?.valor ?? row?.RS_Total_Fatura ?? 0);
  const pctRess = Number(decisao?.percentual_ressarcimento ?? 0);
  const valorEstimado = (valorFatura * pctRess) / 100;

  // Resolve tipo+subtipo padrão a partir da primeira ficha confirmada
  const fichaPrincipal = String(fichasIA[0] ?? '').toUpperCase().trim();
  const irregularidadePadrao = FICHA_PARA_IRREGULARIDADE[fichaPrincipal] ?? IRREGULARIDADE_DEFAULT;

  // Listas de tipos/subtipos do banco (DM_TIPO_IRREGULARIDADE / DM_SUBTIPO_IRREGULARIDADE)
  // — usuário pode alterar a sugestão padrão via dropdown.
  const [tiposLista, setTiposLista] = useState([]);
  const [subtiposLista, setSubtiposLista] = useState([]);
  useEffect(() => {
    apiClient.get('/api/v1/tipos-irregularidade')
      .then(r => setTiposLista(Array.isArray(r.data) ? r.data : (r.data?.rows ?? r.data?.tipos ?? [])))
      .catch(() => setTiposLista([]));
  }, []);
  useEffect(() => {
    const tipoId = irregularidadePadrao.id_tipo;
    if (!tipoId) { setSubtiposLista([]); return; }
    apiClient.get(`/api/v1/tipos-irregularidade/${tipoId}/subtipos`)
      .then(r => setSubtiposLista(Array.isArray(r.data) ? r.data : (r.data?.rows ?? r.data?.subtipos ?? [])))
      .catch(() => setSubtiposLista([]));
  }, [irregularidadePadrao.id_tipo]);

  // Formato brasileiro (1.234,56) é o único que o backend parseia corretamente:
  // ele faz ReplaceAll(".","") e depois ReplaceAll(",", "."). Se mandarmos
  // "1234.56" ele vira "123456" (100x o valor). Por isso normalizamos aqui.
  const fmtBR = (n) => {
    const num = Number(n);
    if (!Number.isFinite(num)) return '0,00';
    return num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const parseBR = (s) => {
    if (typeof s === 'number') return s;
    const txt = String(s ?? '').trim();
    if (!txt) return 0;
    // Se tem vírgula, é BR: remove pontos (milhar) e troca vírgula por ponto
    if (txt.includes(',')) {
      return Number(txt.replace(/\./g, '').replace(',', '.')) || 0;
    }
    // Sem vírgula: trata o ponto como separador decimal (formato JS)
    return Number(txt) || 0;
  };

  // Formata a justificativa da IA em seções com quebras de linha — antes vinha
  // como um parágrafo único amontoado. Estrutura: diagnóstico em frases curtas,
  // evidências como bullets, recomendação separada.
  const descricaoFormatada = useMemo(() => {
    const partes = [];

    // ─── Diagnóstico ─────────────────────────────────────────────────
    const just = String(decisao?.justificativa ?? '').trim();
    if (just) {
      // Quebra a justificativa em frases (ponto+espaço) e em pipe ' | '
      const frases = just
        .split(/\s\|\s|(?<=[.!?])\s+(?=[A-ZÀ-Ú])/g)
        .map((s) => s.trim())
        .filter(Boolean);
      partes.push('═══ DIAGNÓSTICO ═══');
      frases.forEach((f) => partes.push(f));
      partes.push('');
    }

    // ─── Evidências ──────────────────────────────────────────────────
    partes.push('═══ EVIDÊNCIAS ═══');
    if (fichasIA.length > 0) {
      partes.push(`• Fichas confirmadas pela IA: ${fichasIA.join(', ')}`);
    }
    if (decisao?.confianca_final != null) {
      partes.push(`• Confiança da análise: ${decisao.confianca_final}%`);
    }
    const desv = Number(row?.desvio_pct_max ?? 0);
    if (desv !== 0) {
      partes.push(`• Desvio sobre a média: ${desv > 0 ? '+' : ''}${desv.toFixed(0)}%`);
    }
    if (pctRess > 0) {
      partes.push(`• Percentual de ressarcimento sugerido: ${pctRess}%`);
    }
    if (valorEstimado > 0) {
      partes.push(`• Valor estimado de ressarcimento: R$ ${valorEstimado.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    }
    partes.push('');

    // ─── Recomendação ────────────────────────────────────────────────
    const recom = String(decisao?.recomendacao ?? '').trim();
    if (recom) {
      partes.push('═══ RECOMENDAÇÃO ═══');
      partes.push(recom);
    }

    return partes.join('\n').trim();
  }, [decisao, fichasIA, pctRess, valorEstimado, row]);

  const [form, setForm] = useState({
    // uc = Nº DE INSTALAÇÃO real (recognizable), NÃO o codigo_uc interno (sgeeasy). Antes usava
    // só row.UC (codigo_uc, ex.: 3316) → a requisição não identificava a unidade. Prioriza
    // numero_instalacao (ex.: 990272818), igual ao resto da tela.
    uc: String(row?.numero_instalacao || row?.UC || row?.uc || '').trim(),
    concessionaria: row?.Concessionaria ?? row?.concessionaria ?? '',
    cliente: getNomeEmpresa(row),
    mes_ref: row?.Mes_Ref ?? row?.mes_ref ?? '',
    // tipo_irregularidade/subtipo_irregularidade são os IDs reais das tabelas DM
    // (não a string "F03" — essa vai para o campo `fichas` e para a descrição).
    id_tipo_irregularidade: String(irregularidadePadrao.id_tipo),
    id_subtipo_irregularidade: String(irregularidadePadrao.id_subtipo),
    // Quando IA não sugere percentual, cai no valor total da fatura como fallback
    // — usuário pode editar antes de criar.
    valor_estimado: fmtBR(valorEstimado > 0 ? valorEstimado : valorFatura),
    descricao: descricaoFormatada,
    fichas: fichasIA.join(', '),
  });

  // Quando o usuário troca o tipo no dropdown, recarrega lista de subtipos.
  useEffect(() => {
    const tipoId = form.id_tipo_irregularidade;
    if (!tipoId) { setSubtiposLista([]); return; }
    apiClient.get(`/api/v1/tipos-irregularidade/${tipoId}/subtipos`)
      .then(r => setSubtiposLista(Array.isArray(r.data) ? r.data : (r.data?.rows ?? r.data?.subtipos ?? [])))
      .catch(() => setSubtiposLista([]));
  }, [form.id_tipo_irregularidade]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const upd = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const handleSubmit = useCallback(async () => {
    setSaving(true); setError('');
    try {
      // Normaliza para BR (1.234,56) — o backend só parseia corretamente
      // esse formato (faz ReplaceAll(".","") + ReplaceAll(",", ".")).
      const valorNum = parseBR(form.valor_estimado);
      if (!(valorNum > 0)) {
        setError('Valor estimado precisa ser maior que zero.');
        setSaving(false);
        return;
      }
      const valorBR = fmtBR(valorNum);

      // periodos_irregularidade é coluna JSON no MySQL — backend espera o
      // formato [{"mes":"08","ano":"2022"}]. Aceita variantes de mes_ref:
      //   "2022-08", "2022-08-01", "08/2022", "AGO/2022".
      const mesRefRaw = String(form.mes_ref ?? '').trim();
      let periodosJSON = '';
      const MES_NOME = { JAN:'01', FEV:'02', MAR:'03', ABR:'04', MAI:'05', JUN:'06',
                         JUL:'07', AGO:'08', SET:'09', OUT:'10', NOV:'11', DEZ:'12' };
      let parsedMes = null, parsedAno = null;
      const m1 = mesRefRaw.match(/^(\d{4})-(\d{1,2})/);              // 2022-08 ou 2022-08-01
      const m2 = mesRefRaw.match(/^(\d{1,2})\/(\d{4})$/);            // 08/2022
      const m3 = mesRefRaw.toUpperCase().match(/^([A-Z]{3})\/(\d{4})$/); // AGO/2022
      if (m1) { parsedAno = m1[1]; parsedMes = m1[2].padStart(2, '0'); }
      else if (m2) { parsedAno = m2[2]; parsedMes = m2[1].padStart(2, '0'); }
      else if (m3 && MES_NOME[m3[1]]) { parsedAno = m3[2]; parsedMes = MES_NOME[m3[1]]; }
      if (parsedMes && parsedAno) {
        periodosJSON = JSON.stringify([{ mes: parsedMes, ano: parsedAno }]);
      }
      // Defesa contra mes_ref vazio/inválido — fallback para mês/ano atuais
      // (evita erro 400 "periodosIrregularidade ausente"; usuário pode corrigir
      // no controle de processos depois). Sem fallback, o submit da Análise de
      // Desvio quebrava sempre que o pipeline não preenchesse mes_ref.
      if (!periodosJSON) {
        const hoje = new Date();
        const mm = String(hoje.getMonth() + 1).padStart(2, '0');
        const aa = String(hoje.getFullYear());
        periodosJSON = JSON.stringify([{ mes: mm, ano: aa }]);
      }

      const fd = new FormData();
      fd.append('uc', form.uc);
      fd.append('concessionaria', form.concessionaria);
      fd.append('cliente', form.cliente);
      fd.append('mes_ref', form.mes_ref);
      // IDs de tipo/subtipo das tabelas DM_TIPO_IRREGULARIDADE / DM_SUBTIPO_*.
      // Antes enviávamos "F03" no campo tipo_irregularidade — string que o
      // backend não aceita (espera id numérico das tabelas DM).
      fd.append('id_tipo_irregularidade', form.id_tipo_irregularidade);
      fd.append('idTipoIrregularidade', form.id_tipo_irregularidade);
      fd.append('id_subtipo_irregularidade', form.id_subtipo_irregularidade);
      fd.append('idSubtipoIrregularidade', form.id_subtipo_irregularidade);
      // Campos com os nomes que o backend exige (descricaoIrregularidade,
      // periodosIrregularidade, ressarcimentoEstimado). Antes mandávamos
      // 'descricao' / 'valor_estimado' e o backend rejeitava com 400.
      fd.append('descricao', form.descricao);                         // legado
      fd.append('descricaoIrregularidade', form.descricao);           // backend
      fd.append('periodosIrregularidade', periodosJSON);              // JSON: [{mes,ano}]
      fd.append('periodos', periodosJSON);                            // alias
      fd.append('valor_estimado', valorBR);                           // legado
      fd.append('ressarcimentoEstimado', valorBR);                    // backend
      // fichas (F02, F03, etc) viram comentário/contexto da requisição —
      // não são "tipo de irregularidade" formal. Vão pro campo `fichas` e
      // estão também na descrição (descricaoFormatada).
      fd.append('fichas', form.fichas);
      fd.append('fatura_id', String(row.id ?? ''));
      fd.append('analise_ia', JSON.stringify(decisao ?? {}));

      const res = await apiClient.post('/api/v1/requisicoes', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      onCreated?.(res?.data);
      onClose();
    } catch (e) {
      const apiErr = e?.response?.data;
      const msg = apiErr?.error
        ? (apiErr.missing_fields ? `${apiErr.error}: ${apiErr.missing_fields.join(', ')}` : apiErr.error)
        : 'Falha ao criar requisição.';
      setError(msg);
    } finally {
      setSaving(false);
    }
  }, [form, row, decisao, onCreated, onClose]);

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-2xl bg-[var(--cpv2-surface-2)] rounded-xl shadow-2xl flex flex-col border border-[var(--cpv2-border)]"
        style={{ maxHeight: '92vh' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 rounded-t-xl"
          style={{ background: 'var(--gradient-success)' }}>
          <div>
            <div className="text-white font-bold text-sm">Abrir Requisição</div>
            <div className="text-white/50 text-xs font-mono mt-0.5">UC {row.UC} · ID {row.id}</div>
          </div>
          <button onClick={onClose} className="text-white/60 hover:text-white text-xl leading-none px-2">×</button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="UC" value={form.uc} onChange={upd('uc')} />
            <Field label="Concessionária" value={form.concessionaria} onChange={upd('concessionaria')} />
            <Field label="Cliente / Razão Social" value={form.cliente} onChange={upd('cliente')} className="col-span-2"/>
            <Field label="Mês referência" value={form.mes_ref} onChange={upd('mes_ref')} />
            <Field label="Fichas confirmadas (vão para o comentário)" value={form.fichas} onChange={upd('fichas')} />

            {/* Dropdowns de tipo/subtipo de irregularidade — pré-selecionados
                via mapa FICHA_PARA_IRREGULARIDADE conforme a primeira ficha
                confirmada pela IA (F02→Consumo Elevado, F03→Faturado por média,
                etc). Usuário pode alterar antes de salvar. */}
            <div className="col-span-1">
              <div className="text-[11px] opacity-60 mb-1">TIPO DE IRREGULARIDADE</div>
              <select
                value={form.id_tipo_irregularidade}
                onChange={(e) => setForm({ ...form, id_tipo_irregularidade: e.target.value, id_subtipo_irregularidade: '' })}
                className="w-full px-3 py-2 rounded-md border border-[var(--cpv2-border)] bg-[var(--cpv2-surface-2)] text-sm"
              >
                <option value="">— selecione —</option>
                {tiposLista.map((t) => (
                  <option key={t.id_tipo ?? t.id} value={t.id_tipo ?? t.id}>
                    {t.nome ?? t.label ?? t.descricao}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-1">
              <div className="text-[11px] opacity-60 mb-1">SUBTIPO DE IRREGULARIDADE</div>
              <select
                value={form.id_subtipo_irregularidade}
                onChange={upd('id_subtipo_irregularidade')}
                className="w-full px-3 py-2 rounded-md border border-[var(--cpv2-border)] bg-[var(--cpv2-surface-2)] text-sm"
                disabled={!form.id_tipo_irregularidade}
              >
                <option value="">— selecione —</option>
                {subtiposLista.map((s) => (
                  <option key={s.id_subtipo ?? s.id} value={s.id_subtipo ?? s.id}>
                    {s.nome ?? s.label ?? s.descricao}
                  </option>
                ))}
              </select>
            </div>

            <Field label="Valor estimado (R$)" value={form.valor_estimado} onChange={upd('valor_estimado')} className="col-span-2"/>
          </div>

          <div>
            <div className="text-[11px] opacity-60 mb-1 flex items-center justify-between">
              <span>DESCRIÇÃO / JUSTIFICATIVA</span>
              <span className="text-[10px] opacity-50">Pré-formatada com diagnóstico + evidências da IA — pode editar</span>
            </div>
            <textarea
              value={form.descricao}
              onChange={upd('descricao')}
              rows={14}
              className="w-full px-3 py-2 text-xs rounded border border-[var(--cpv2-border)] bg-[var(--cpv2-surface)] focus:outline-none focus:ring-1 focus:ring-[var(--success)] font-mono leading-relaxed"
              style={{ whiteSpace: 'pre-wrap' }}
            />
          </div>

          {error && <div className="text-sm text-[var(--danger)]">{error}</div>}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-[var(--cpv2-border)]">
          <button onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-[var(--cpv2-border)] hover:bg-[var(--cpv2-surface)]">
            Cancelar
          </button>
          <button onClick={handleSubmit} disabled={saving || !form.uc}
            className="px-4 py-2 text-sm rounded-lg text-white font-semibold disabled:opacity-50"
            style={{ backgroundColor: 'var(--success)' }}>
            {saving ? 'Criando...' : 'Criar Requisição'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, className = '' }) {
  return (
    <div className={className}>
      <label className="block text-[10px] opacity-60 mb-1">{label.toUpperCase()}</label>
      <input value={value ?? ''} onChange={onChange}
        className="w-full px-3 py-2 text-sm rounded border border-[var(--cpv2-border)] bg-[var(--cpv2-surface)] focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Menu de ações por linha
   ──────────────────────────────────────────────────────────────────────────── */

// Popup "Encaminhar": baixar TODAS as faturas da unidade em .zip OU passá-las no
// OCR Inteligente (cria job populado dos links e navega pra tela OcrLote).
function EncaminharPopup({ row, onClose, navigate }) {
  const [busy, setBusy] = useState('');
  const inst = String(row?.numero_instalacao || row?.UC || row?.uc || '').trim();
  const emp = String(row?.cod_empresa || row?.Cod_Empresa || '').trim();
  const baixarZip = async () => {
    if (!inst) { alert('Unidade sem número de instalação.'); return; }
    setBusy('zip');
    try {
      const res = await apiClient.get('/api/v1/faturas/download-zip', { params: { inst, empresa: emp }, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a'); a.href = url; a.download = `faturas_${inst}.zip`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      onClose();
    } catch (e) {
      let msg = e?.response?.data?.error || e.message;
      try { if (e?.response?.data instanceof Blob) { const t = JSON.parse(await e.response.data.text()); msg = t?.error || msg; } } catch { /* keep msg */ }
      alert('Falha no download: ' + msg);
    } finally { setBusy(''); }
  };
  const passarOcr = () => {
    if (!inst) { alert('Unidade sem número de instalação.'); return; }
    // Navega IMEDIATO pra tela do OCR Inteligente com a unidade — o cronômetro já começa
    // e a tela mostra "inserindo faturas…" enquanto o backend baixa os PDFs e roda o job.
    onClose();
    navigate(`/ocr-lote?unidade=${encodeURIComponent(inst)}&empresa=${encodeURIComponent(emp)}`);
  };
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-[min(92vw,460px)] rounded-xl border border-[var(--cpv2-border)] bg-[var(--cpv2-surface-2)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold mb-1">Encaminhar unidade</h3>
        <div className="text-xs opacity-60 mb-4">Instalação <span className="font-mono">{inst || '—'}</span> — aplica a TODAS as faturas desta unidade.</div>
        <div className="flex flex-col gap-2">
          <button className="cpv2-btn cpv2-btn--primary" disabled={!!busy} onClick={baixarZip}>
            {busy === 'zip' ? '⏳ Baixando…' : '⬇️ Baixar todas as faturas (.zip)'}
          </button>
          <button className="cpv2-btn" disabled={!!busy} onClick={passarOcr}
            style={{ background: 'linear-gradient(135deg,#1d4ed8,#3b82f6,#60a5fa)', color: '#fff', border: 'none' }}>
            {busy === 'ocr' ? '⏳ Preparando…' : '⚡ Passar no OCR Inteligente'}
          </button>
          <button className="cpv2-btn" disabled={!!busy} onClick={onClose}>Cancelar</button>
        </div>
      </div>
    </div>
  );
}

function AcoesMenu({ row, onAction, onClose, anchor }) {
  const ref = useRef(null);
  useEffect(() => {
    const click = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', click);
    return () => document.removeEventListener('mousedown', click);
  }, [onClose]);

  const top = anchor?.bottom ?? 0;
  const left = Math.max(8, (anchor?.right ?? 0) - 220);

  return (
    <div ref={ref}
      className="fixed z-[9998] w-56 rounded-lg border border-[var(--cpv2-border)] bg-[var(--cpv2-surface-2)] shadow-xl py-1"
      style={{ top: top + 4, left }}
    >
      <button onClick={() => onAction('ia')}
        className="w-full px-3 py-2 text-left text-sm hover:bg-[var(--cpv2-surface)] flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]"/>
        Analisar com IA
      </button>
      <button onClick={() => onAction('requisicao')}
        className="w-full px-3 py-2 text-left text-sm hover:bg-[var(--cpv2-surface)] flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)]"/>
        Abrir Requisição
      </button>
      <button onClick={() => onAction('historico')}
        className="w-full px-3 py-2 text-left text-sm hover:bg-[var(--cpv2-surface)] flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning)]"/>
        Ver Histórico (gráfico)
      </button>
      <button onClick={() => onAction('encaminhar')}
        className="w-full px-3 py-2 text-left text-sm hover:bg-[var(--cpv2-surface)] flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]"/>
        Encaminhar (todas da unidade)
      </button>
      {getRowLink(row) && (
        <>
          <div className="border-t border-[var(--cpv2-border)] my-1"/>
          <a href={getRowLink(row)} target="_blank" rel="noreferrer"
            className="block px-3 py-2 text-sm hover:bg-[var(--cpv2-surface)] text-[var(--accent)]">
            Abrir PDF da fatura ↗
          </a>
        </>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Filtros
   ──────────────────────────────────────────────────────────────────────────── */

function FiltrosBar({ filtros, setFiltros, ficha, setFicha, fichaCounts, mostrarFicha, frcMode }) {
  const upd = (k) => (e) => setFiltros({ ...filtros, [k]: e.target.value });
  const clear = () => setFiltros({
    empresa: '', busca: '', valorMin: '', valorMax: '', desvioMin: '', periodoIni: '', periodoFim: '', passibilidade: '',
  });

  return (
    <div className="rounded-lg border border-[var(--cpv2-border)] bg-[var(--cpv2-surface)] p-3 space-y-2">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
        {!frcMode && (
        <input value={filtros.empresa} onChange={upd('empresa')} placeholder="Empresa"
          className="px-2 py-1.5 text-xs rounded border border-[var(--cpv2-border)] bg-[var(--cpv2-surface-2)]"/>
        )}
        <input value={filtros.busca} onChange={upd('busca')} placeholder="ID / UC / Cliente / Distribuidora"
          className="px-2 py-1.5 text-xs rounded border border-[var(--cpv2-border)] bg-[var(--cpv2-surface-2)] col-span-2"/>
        <input value={filtros.desvioMin} onChange={upd('desvioMin')} placeholder="Desvio min %" type="number"
          className="px-2 py-1.5 text-xs rounded border border-[var(--cpv2-border)] bg-[var(--cpv2-surface-2)]"/>
        <button onClick={clear}
          className="px-2 py-1.5 text-xs rounded border border-[var(--cpv2-border)] hover:bg-[var(--cpv2-surface-2)]">
          Limpar
        </button>
      </div>

      {mostrarFicha && (
        <div className="flex flex-wrap gap-1 pt-1 border-t border-[var(--cpv2-border)]">
          <span className="text-[10px] opacity-50 self-center mr-1">FICHA:</span>
          {FICHAS.map(f => {
            const ativo = ficha === f.id;
            const c = fichaCounts?.[f.id] ?? 0;
            return (
              <button key={f.id} onClick={() => setFicha(f.id)}
                className="px-2 py-0.5 rounded text-[10px] font-bold transition"
                style={{
                  background: ativo ? f.cor : `color-mix(in srgb, ${f.cor} 13%, transparent)`,
                  color: ativo ? '#fff' : f.cor,
                  border: `1px solid color-mix(in srgb, ${f.cor} 33%, transparent)`,
                }}
                title={f.nome}>
                {f.label} {c > 0 && <span className="opacity-70">·{c}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Página principal
   ──────────────────────────────────────────────────────────────────────────── */

// FATOR_RETENCAO_RESSARCIMENTO — Ago/2026: DEFINIDO EM 1.0 (100%, valor cheio) por decisão
// do usuário. A retenção de 42% foi REMOVIDA de todas as abas (Apontamentos, Auditados,
// Inconclusivos) + Água + Acer. Mantido como const p/ referência (espelha o backend = 1.0).
export const FATOR_RETENCAO_RESSARCIMENTO = 1.0;

// Ressarcimento estimado (F02): (consumo − média) × R$/kWh de energia. Como
// R$/kWh = valor_energia_ativa/kwh e excesso = kwh × d/(1+d), o kwh cancela →
// base × d/(1+d), com base = valor_energia_ativa. SEM fallback pro total da fatura
// (ICMS/TUSD/demanda inflavam). Sem energia → não estimado (0). d = desvio_pct_max/100.
// É o valor BRUTO — a retenção de 42% NÃO se aplica aqui (só no ressarcimento total).
function calcRessEstimado(r) {
  const base = Number(r?.valor_energia_ativa) || 0;
  const d = Number(r?.desvio_pct_max ?? 0) / 100;
  if (!(base > 0) || !(d > 0)) return 0;
  return base * (d / (1 + d));
}

export default function AnaliseDesvio() {
  const navigate = useNavigate();
  const { id: idParam } = useParams(); // /analise-desvio/:id → abre o modal pela URL

  const { user } = useAuth();
  // Aba "Apontamentos" (id 'aprovados') é RESTRITA ao Alisson (alisson.rodrigues@amee.com.br
  // / id_usuario=1). Os demais usuários têm "Auditados" como aba principal e não veem Apontamentos.
  const podeApontamentos = user?.email === 'alisson.rodrigues@amee.com.br' || Number(user?.user_id) === 1;
  const [tab, setTab] = useState('auditados');
  const [catalogoFichas, setCatalogoFichas] = useState(false); // painel de referência das 61 fichas
  const tabInicialSet = useRef(false);
  // Quando o usuário resolve (token do localStorage), o Alisson começa em Apontamentos.
  useEffect(() => {
    if (!user || tabInicialSet.current) return;
    tabInicialSet.current = true;
    if (podeApontamentos) setTab('aprovados');
  }, [user, podeApontamentos]);
  // Guard: só admin (Alisson) permanece/entra nas abas Apontamentos e Inconclusivos.
  useEffect(() => {
    if (!podeApontamentos && (tab === 'aprovados' || tab === 'inconclusivos')) setTab('auditados');
  }, [podeApontamentos, tab]);
  const [showRanking, setShowRanking] = useState(false);
  // Aba Apontamentos (aprovados): mescla FDE + lacunas sgeeasy (Outlier) e pagina no client.
  const clientPag = tab === 'aprovados' || tab === 'auditados' || tab === 'inconclusivos';
  // Sub-aba de empresa dentro de cada tab principal. 'todos' = sem filtro.
  // empresasDisponiveis vem do backend dinamicamente — quando uma nova empresa
  // tiver faturas no status atual, ela aparece como aba automaticamente.
  const [empresaSelecionada, setEmpresaSelecionada] = useState('todos');
  const [empresasDisponiveis, setEmpresasDisponiveis] = useState([]);
  const [ficha, setFicha] = useState('f02');
  const [fichaCounts, setFichaCounts] = useState({});
  const [filtros, setFiltros] = useState({
    empresa: '', busca: '', valorMin: '', valorMax: '', desvioMin: '', periodoIni: '', periodoFim: '',
    passibilidade: '',
  });

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showMatriz, setShowMatriz] = useState(true);
  // Ordenação da tabela: { col, dir } onde dir = 'asc' | 'desc'
  const [sort, setSort] = useState({ col: 'id', dir: 'desc' });
  // Paginação server-side real (08/07/2026): 100 linhas por página, server
  // recebe ?limit=100&offset=(page-1)*100 a cada mudança de página.
  // "Anterior/Próxima" refazem o fetch; total de páginas vem do KPI (agg.total).
  const [limitAtual, setLimitAtual] = useState(100);
  const [rawCount, setRawCount] = useState(0);
  // ⭐ Ao clicar num apontamento, abre o ModalFaturaMontada (dialog centralizado)
  // com a fatura completa + gráfico + tabela de meses. Substitui a antiga
  // expansão inline (LinhaExpandida), que foi removida.
  const [modalFatura, setModalFatura] = useState(null);

  // Abre o modal a partir da URL /analise-desvio/:id. Busca a linha por id (que traz o uid)
  // e deixa o próprio modal carregar todos os campos flat via /faturas-extraidas/:uid.
  useEffect(() => {
    if (!idParam) return;
    let cancel = false;
    apiClient.get('/api/v1/faturas/fde-analise', { params: { id: idParam, limit: 1 } })
      .then((res) => {
        if (cancel) return;
        const arr = Array.isArray(res.data) ? res.data : (res.data?.rows ?? []);
        setModalFatura(arr[0] || { id: Number(idParam) });
      })
      .catch(() => { if (!cancel) setModalFatura({ id: Number(idParam) }); });
    return () => { cancel = true; };
  }, [idParam]); // eslint-disable-line react-hooks/exhaustive-deps

  // ⭐ Paginação server-side: PAGE_SIZE alinhado com limitAtual (100) — cada
  // página buscada é a página exibida (sem paginação client-side em cima).
  // Mudar `page` dispara refetch com offset = (page-1)*PAGE_SIZE.
  const PAGE_SIZE = 100;
  const [page, setPage] = useState(1);

  // Resumo agregado GLOBAL (não paginado) vindo do servidor — total/valor/ressarcimento
  // de TODOS os apontamentos do escopo (todas as empresas ou só a selecionada).
  const [agg, setAgg] = useState(null);
  // Filtro de SEGMENTO (seleciona só um; afeta tabela + KPIs). Default "todos"
  // pra abrir mostrando tudo — o analista filtra depois se quiser.
  const [segmento, setSegmento] = useState('todos');
  // Separar por tipo de apontamento: '' = todas, ou F01/F02/F04/F05.
  // Default F02 (desvio de média) — é o que gera ressarcimento.
  const [fichaSel, setFichaSel] = useState('F02');

  // Mapa UC → requisições persistentes (criadas pelo fluxo completo)
  const [reqMap, setReqMap] = useState({});

  useEffect(() => {
    apiClient.get('/api/v1/requisicoes', { params: { limit: 5000 } })
      .then(r => {
        const data = Array.isArray(r.data) ? r.data : (r.data?.rows ?? []);
        const map = {};
        data.forEach(req => {
          const uc = String(req.uc ?? '').trim();
          if (!uc) return;
          if (!map[uc]) map[uc] = [];
          map[uc].push(req);
        });
        setReqMap(map);
      })
      .catch(() => {});
  }, []);

  const toggleSort = useCallback((col) => {
    setSort(s => s.col === col
      ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { col, dir: 'asc' }
    );
  }, []);

  const sortValue = (row, col) => {
    const d = getDecisao(row);
    switch (col) {
      case 'id':           return Number(row.id) || 0;
      case 'uc':           return String(row.UC ?? row.uc ?? '');
      case 'cliente':      return getNomeEmpresa(row).toLowerCase();
      case 'concessionaria': return String(row.Concessionaria ?? row.concessionaria ?? '').toLowerCase();
      case 'mes':          return String(row.Mes_Ref ?? row.mes_ref ?? '');
      case 'valor':        return Number(row.RS_Total_Fatura ?? row.valor ?? 0);
      case 'desvio':       return Number(row.desvio_pct_max ?? 0);
      case 'status_ia':    return String(d?.decisao_final ?? 'PENDENTE');
      case 'passibilidade': {
        // ordena por prioridade definida em PASSIBILIDADE_CONFIG (1 = mais grave)
        const cfg = PASSIBILIDADE_CONFIG[row.status_passibilidade];
        return cfg?.prioridade ?? 99;
      }
      case 'confianca':    return Number(d?.confianca_final ?? 0);
      case 'ressarcimento': return calcRessEstimado(row);
      case 'resultado_em': {
        if (!row.resultado_em) return 0;
        const t = new Date(row.resultado_em).getTime();
        return Number.isNaN(t) ? 0 : t;
      }
      default: return 0;
    }
  };

  const [menuRow, setMenuRow] = useState(null);
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [modalIA, setModalIA] = useState(null);
  const [modalReq, setModalReq] = useState(null);
  const [drawerHist, setDrawerHist] = useState(null);
  const [confirmReject, setConfirmReject] = useState(null); // row a ser rejeitado
  const [rejecting, setRejecting] = useState(false);
  const [encaminhar, setEncaminhar] = useState(null); // row cuja unidade será encaminhada (zip/OCR)

  const doRejeitar = useCallback(async () => {
    if (!confirmReject) return;
    setRejecting(true);
    try {
      const rejId = confirmReject.id;
      await apiClient.post(`/api/v1/faturas/${rejId}/rejeitar-fde`, {
        motivo: 'rejeitado pela tela AnaliseDesvio',
      });
      setConfirmReject(null);
      // Atualização LOCAL (sem reload da lista toda): marca só esta linha como rejeitada
      // → risco vermelho. Evita re-baixar até 5.000 linhas a cada rejeição.
      setRows(prev => prev.map(x => String(x.id) === String(rejId) ? { ...x, _rejeitado: true } : x));
    } catch (e) {
      alert('Falha ao rejeitar: ' + (e?.response?.data?.error || e.message));
    } finally {
      setRejecting(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmReject?.id]);

  // Carrega contagem de fichas por tipo a partir de FATURA_DADOS_EXTRAIDOS
  useEffect(() => {
    apiClient.get('/api/v1/faturas/fde-ficha-resumo')
      .then(r => {
        const c = {};
        (r.data?.fichas ?? []).forEach(f => { c[f.key] = f.total; });
        setFichaCounts(c);
      })
      .catch(() => {});
  }, []);

  // Carrega lista de empresas disponíveis para o status atual.
  // Sub-abas aparecem/somem conforme o backend retorna empresas com faturas
  // no status selecionado. Reseta a sub-aba quando muda a tab principal.
  useEffect(() => {
    // FRC_MODE também usa a lista dinâmica — as empresas com fatura na FDE
    // são as mesmas que existem no sgeeasy pra este cliente. Se preferir a
    // lista canônica do sgeeasy, criar endpoint /desvio/frc/empresas depois.
    apiClient
      .get('/api/v1/faturas/fde-analise/empresas', {
        params: { status: tab === 'aprovados' ? '' : STATUS_POR_TAB[tab], ...(MOTOR_MODE ? { motor: 1 } : {}) },
      })
      .then((r) => {
        const lista = Array.isArray(r.data) ? r.data : [];
        setEmpresasDisponiveis(lista);
        // Se a empresa selecionada não está mais na lista, volta pra "todos"
        if (
          empresaSelecionada !== 'todos' &&
          !lista.some((e) => String(e.cod_empresa) === String(empresaSelecionada))
        ) {
          setEmpresaSelecionada('todos');
        }
      })
      .catch(() => setEmpresasDisponiveis([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Carrega rows ao mudar tab/ficha/filtros — fonte: FATURA_DADOS_EXTRAIDOS via /fde-analise
  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try {
      // ⭐ FRC_MODE: fonte = Faturas_Registradas_Cache (sgeeasy) via /desvio/frc.
      // "todos" traz todas empresas de uma vez (backend remove filtro Cod_Empresa).
      if (FRC_MODE) {
        const emp = (empresaSelecionada && empresaSelecionada !== 'todos') ? empresaSelecionada : 'todos';
        const res = await apiClient.get('/api/v1/desvio/frc', { params: { empresa: emp } });
        let data = Array.isArray(res.data) ? res.data : (res.data?.rows ?? []);
        const q = String(filtros.busca || '').trim().toLowerCase();
        if (q) {
          data = data.filter(r =>
            String(r.id ?? '').toLowerCase().includes(q) ||
            String(r.UC ?? '').toLowerCase().includes(q) ||
            String(r.RAZAO_SOCIAL ?? r.razao_social ?? r.cliente ?? r.nome_cliente ?? '').toLowerCase().includes(q) ||
            String(r.Concessionaria ?? '').toLowerCase().includes(q));
        }
        if (filtros.valorMin)  data = data.filter(r => Number(r.RS_Total_Fatura ?? 0) >= Number(filtros.valorMin));
        if (filtros.valorMax)  data = data.filter(r => Number(r.RS_Total_Fatura ?? 0) <= Number(filtros.valorMax));
        if (filtros.desvioMin) data = data.filter(r => Number(r.desvio_pct_max ?? 0) >= Number(filtros.desvioMin));
        if (filtros.periodoIni) data = data.filter(r => String(r.Mes_Ref ?? '') >= filtros.periodoIni);
        if (filtros.periodoFim) data = data.filter(r => String(r.Mes_Ref ?? '') <= filtros.periodoFim);
        setRows(data);
        return;
      }

      // ⭐ Aba Inconclusivos: apontamentos do sgeeasy (F01–F05) casados à fatura do
      // FDE por `uid` (fde_id). O sgeeasy só alimenta o flag; a fatura é a do FDE.
      if (tab === 'inconclusivos') {
        const gap = await apiClient.get('/api/v1/faturas/fde-analise/sgeeasy-gap');
        const lac = gap.data?.lacunas?.items || [];
        let data = lac.map((l) => ({
          id: l.fde_id || l.id,          // aponta pro id do FDE quando existe
          fde_id: l.fde_id || null,
          uid: l.uid,
          UC: l.UC,
          cod_empresa: l.cod_empresa,
          Concessionaria: l.concessionaria,
          Mes_Ref: l.mes_ref,
          RS_Total_Fatura: l.rs_total_fatura,
          desvio_pct_max: l.desvio_pct_max,
          fichas_aplicadas: l.fichas_aplicadas,
          categoria_desvio: l.categoria_desvio,
          valor_energia_ativa: 0,
          // fonte 'fde' quando temos a fatura no FDE (abre o modal do FDE); senão sgeeasy
          fonte: l.fde_id ? 'fde' : 'sgeeasy',
          Link: l.link,
        }));
        const q = String(filtros.busca || '').trim().toLowerCase();
        if (q) {
          data = data.filter(r =>
            String(r.id ?? '').toLowerCase().includes(q) ||
            String(r.UC ?? '').toLowerCase().includes(q) ||
            String(r.RAZAO_SOCIAL ?? r.razao_social ?? r.cliente ?? r.nome_cliente ?? '').toLowerCase().includes(q) ||
            String(r.Concessionaria ?? '').toLowerCase().includes(q));
        }
        if (filtros.valorMin)  data = data.filter(r => Number(r.RS_Total_Fatura ?? 0) >= Number(filtros.valorMin));
        if (filtros.valorMax)  data = data.filter(r => Number(r.RS_Total_Fatura ?? 0) <= Number(filtros.valorMax));
        if (filtros.periodoIni) data = data.filter(r => String(r.Mes_Ref ?? '') >= filtros.periodoIni);
        if (filtros.periodoFim) data = data.filter(r => String(r.Mes_Ref ?? '') <= filtros.periodoFim);
        setRawCount(data.length);
        setRows(data);
        return;
      }

      // empresaSelecionada (sub-aba) tem prioridade sobre filtros.empresa.
      const empresaFinal =
        empresaSelecionada !== 'todos' ? empresaSelecionada : (filtros.empresa || undefined);
      const params = {
        // Apontamentos (aprovados) traz tudo e pagina no client (pra mesclar sgeeasy);
        // demais abas mantêm paginação server-side.
        limit: clientPag ? 5000 : limitAtual,
        offset: clientPag ? 0 : (page - 1) * limitAtual,
        empresa: empresaFinal,
        // Apontamentos (clientPag): status vazio traz CONFIRMADO+INCONCLUSIVO (todos os
        // apontados não-rejeitados). Demais abas filtram pelo status da aba.
        status: clientPag ? '' : STATUS_POR_TAB[tab],
        // ⭐ v19 — filtro server-side por passibilidade
        passibilidade: filtros.passibilidade || undefined,
        // ⭐ motor novo (F01-F05 ao vivo sobre a FDE)
        ...(MOTOR_MODE ? { motor: 1 } : {}),
        // ⭐ aba Auditados: filtra o set verificado no servidor (não estoura o teto
        // da paginação do motor, que cortava a linha de maior ressarcimento).
        ...(tab === 'auditados' ? { auditado: 1 } : {}),
        // ⭐ aba Inconclusivos (repurposada): fila de triagem (motor apontou p/
        // Equatorial+Celesc, fora de Auditados) — filtra por flag no servidor.
        ...(tab === 'inconclusivos' ? { triagem: 1 } : {}),
        // ⭐ recorte do parque (mesmos filtros dos KPIs) + separação por ficha
        ...(segmento && segmento !== 'todos' ? { segmento } : {}),
        ...(fichaSel ? { ficha: fichaSel } : {}),
      };

      const res = await apiClient.get('/api/v1/faturas/fde-analise', { params });
      let data = Array.isArray(res.data) ? res.data : (res.data?.rows ?? []);
      setRawCount(data.length); // quantas o servidor devolveu (antes dos filtros client)

      // Filtros client-side: busca por texto, valor e período
      const buscaQ = String(filtros.busca || '').trim();
      if (buscaQ) {
        const q = buscaQ.toLowerCase();
        data = data.filter(r =>
          String(r.id ?? '').toLowerCase().includes(q) ||
          String(r.numero_instalacao ?? '').toLowerCase().includes(q) ||
          String(r.codigo_uc ?? '').toLowerCase().includes(q) ||
          String(r.UC ?? '').toLowerCase().includes(q) ||
          String(r.Concessionaria ?? '').toLowerCase().includes(q) ||
          String(r.RAZAO_SOCIAL ?? r.razao_social ?? r.cliente ?? r.nome_cliente ?? '').toLowerCase().includes(q)
        );
      }
      if (filtros.valorMin) data = data.filter(r => Number(r.RS_Total_Fatura ?? 0) >= Number(filtros.valorMin));
      if (filtros.valorMax) data = data.filter(r => Number(r.RS_Total_Fatura ?? 0) <= Number(filtros.valorMax));
      if (filtros.periodoIni) data = data.filter(r => String(r.Mes_Ref ?? '') >= filtros.periodoIni);
      if (filtros.periodoFim) data = data.filter(r => String(r.Mes_Ref ?? '') <= filtros.periodoFim);

      // ⭐ Aba "Auditados": SOMENTE faturas VERIFICADAS contra a fatura (flag
      // auditado=1 gravada no banco após a reconciliação). NÃO usa a classificação
      // do motor ao vivo (que pega erro de extração — ex.: leitura lida como consumo).
      // Só entra aqui o que foi conferido de verdade.
      if (tab === 'auditados') {
        // Regra (30/07): "Auditados" só lista apontamentos COM valor a ressarcir —
        // ressarcimento_estimado > 0 (obrigatório). Exclui auditado=1 sem apontamento E
        // apontados sem base de cálculo (R$0). Espelha o RebuildAuditados (est > 0).
        data = data.filter(r => Number(r.auditado ?? 0) === 1 && Number(r.ressarcimento_estimado ?? 0) > 0);
      }

      // Filtro de erro real — só aplica em CONFIRMADO. Para REFUTADO e
      // INCONCLUSIVO, a IA já decidiu sobre cada caso e o usuário precisa ver
      // o universo inteiro pra auditar (mesmo registros com motor SQL zerado,
      // que é a maioria pós-pipeline IA).
      //
      // Em CONFIRMADO:
      //   - SEMPRE aparece: pico positivo ≥ +80% (forte indicador F02/F03)
      //   - APARECE: tem flag F02-F09 (IA ou motor) E desvio > -30% (não é descida)
      //   - SEMPRE escondido: descida grande (refaturamento, consumo zero, mês
      //     de obra) — não é erro pra análise de desvio, mesmo se a IA confirmou
      //     algo (caso típico de IA alucinando F03 em meses de consumo mínimo)
      const statusAtual = STATUS_POR_TAB[tab];
      // Em MOTOR_MODE o backend já devolve só os apontamentos reais do motor
      // (F01-F05) — não re-filtra client-side (senão F01-only some, pois F01
      // não casa com o regex F0[2-9] do filtro antigo).
      if (!MOTOR_MODE && statusAtual === 'CONFIRMADO') {
        data = data.filter(r => {
          const desv = Number(r.desvio_pct_max ?? 0);
          if (desv >= 80) return true;
          if (desv < -30) return false; // descida — esconde mesmo com flag
          const d = getDecisao(r);
          const conf = d?.fichas_confirmadas;
          if (Array.isArray(conf) && conf.length > 0) {
            if (conf.some((s) => /^F0[2-9]$/.test(String(s).toUpperCase().trim()))) return true;
          }
          const motor = extractFichas(r.fichas_aplicadas);
          if (Array.isArray(motor) && motor.some((s) => /^F0[2-9]$/.test(String(s).toUpperCase().trim()))) return true;
          return false;
        });
      }

      // Os apontamentos do sgeeasy foram movidos para a aba "Inconclusivos"
      // (casados à fatura do FDE por uid). Apontamentos = só motor FDE.

      setRows(data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Falha ao carregar faturas.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [tab, ficha, filtros, empresaSelecionada, limitAtual, segmento, fichaSel, page]);

  useEffect(() => { reload(); }, [reload]);

  // Busca o resumo agregado GLOBAL do escopo (independe da paginação): "Todas" →
  // soma de todas as empresas; empresa selecionada → só dela. Reaproveita o cache
  // do motor no backend, então é barato.
  useEffect(() => {
    if (FRC_MODE) { setAgg(null); return; }
    const empresaFinal =
      empresaSelecionada !== 'todos' ? empresaSelecionada : (filtros.empresa || undefined);
    let cancel = false;
    apiClient
      .get('/api/v1/faturas/fde-analise/resumo', {
        params: {
          empresa: empresaFinal,
          status: clientPag ? '' : STATUS_POR_TAB[tab],
          ...(MOTOR_MODE ? { motor: 1 } : {}),
          ...(segmento && segmento !== 'todos' ? { segmento } : {}),
          ...(fichaSel ? { ficha: fichaSel } : {}),
        },
      })
      .then((r) => { if (!cancel) setAgg(r.data || null); })
      .catch(() => { if (!cancel) setAgg(null); });
    return () => { cancel = true; };
  }, [tab, empresaSelecionada, filtros.empresa, segmento, fichaSel]);

  // Volta pra página 1 só quando muda filtro/ordenação (NÃO quando o limit sobe
  // pra carregar mais — senão perderíamos a página funda que o usuário navegou).
  useEffect(() => { setPage(1); }, [tab, ficha, filtros, empresaSelecionada, sort, segmento, fichaSel]);

  // Agrupar por UC (1 linha por unidade) — ligado por padrão nas abas de apontamentos.
  const [agrupar, setAgrupar] = useState(true);

  // Ordenação aplicada às linhas
  const sortedRows = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      const va = sortValue(a, sort.col);
      const vb = sortValue(b, sort.col);
      let cmp;
      if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb), 'pt-BR', { numeric: true });
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [rows, sort]);

  // Agrupamento por UC: 1 linha por unidade (colapsa os N meses do mesmo medidor).
  // Só nas abas que carregam tudo (clientPag). Linha representante = maior ressarcimento;
  // guarda _grupoN (qtde de meses apontados) e _grupoRess (soma) para o render.
  const displayRows = useMemo(() => {
    if (!(clientPag && agrupar)) return sortedRows;
    const key = (r) => String(r?.UC ?? r?.uc ?? r?.codigo_uc ?? r?.numero_instalacao ?? '').trim();
    const groups = new Map();
    for (const r of sortedRows) {
      const k = key(r) || ('#' + r.id);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const out = [];
    for (const [, arr] of groups) {
      if (arr.length === 1) { out.push(arr[0]); continue; }
      const rep = arr.reduce((a, b) => (Number(b.ressarcimento_estimado || 0) > Number(a.ressarcimento_estimado || 0) ? b : a), arr[0]);
      const somaRess = arr.reduce((s, x) => s + Number(x.ressarcimento_estimado || 0), 0);
      out.push({ ...rep, _grupoN: arr.length, _grupoRess: somaRess });
    }
    out.sort((a, b) => {
      const va = sortValue(a, sort.col), vb = sortValue(b, sort.col);
      let cmp;
      if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb), 'pt-BR', { numeric: true });
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return out;
  }, [sortedRows, clientPag, agrupar, sort]);

  // Paginação server-side: cada página vem pronta do server via LIMIT+OFFSET.
  // O total de páginas usa agg.total (KPI global do endpoint /resumo). Sem
  // fatiamento client-side — sortedRows já é a página atual ordenada.
  // Apontamentos (clientPag): tudo já veio; fatiamento e total no client.
  // Demais abas: paginação server-side (sortedRows já é a página do server).
  const totalGlobal = clientPag ? displayRows.length : (Number(agg?.total) || rows.length || 0);
  const totalPaginasLocal = Math.max(1, Math.ceil(totalGlobal / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPaginasLocal);
  const servidorTemMais = pageSafe < totalPaginasLocal;
  const pagedRows = clientPag
    ? displayRows.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE)
    : sortedRows; // já é a página do server
  const irProxima = () => {
    if (pageSafe < totalPaginasLocal) setPage(pageSafe + 1);
  };
  const irAnterior = () => {
    if (pageSafe > 1) setPage(pageSafe - 1);
  };

  // Resumo — total/valor/ressarcimento vêm do agregado GLOBAL do servidor (todo o
  // escopo, não só a página carregada); confiança média fica das linhas carregadas.
  const resumo = useMemo(() => {
    const conf = rows.length
      ? rows.reduce((s, r) => s + Number(getDecisao(r)?.confianca_final ?? 0), 0) / rows.length
      : 0;
    // Distribuição por ficha no Apontamentos (clientPag): calculada das próprias linhas
    // carregadas — cada apontamento conta em UMA ficha (a principal) + "Sem ficha" pro
    // resto, de forma que a soma das fichas SEMPRE bate com o total de Faturas (Apontamentos).
    const fichasFromRows = () => {
      const cnt = {};
      for (const r of rows) {
        const fs = extractFichas(r.fichas_aplicadas);
        const key = fs.length ? fs[0].toUpperCase() : 'Sem ficha';
        cnt[key] = (cnt[key] || 0) + 1;
      }
      return cnt;
    };
    // Totais globais do FDE (sempre do backend /resumo).
    const gTotFat = Number(agg?.total_faturas_analisadas) || 0;
    const gTotUCs = Number(agg?.total_ucs) || 0;

    // Abas client (Apontamentos/Inconclusivos): TODO o BI é calculado das linhas
    // carregadas, pra reconciliar com o total exibido e funcionar na Inconclusivos
    // (que não tem agg do motor). Ressarcimento usa energia ativa; se ausente
    // (linhas sgeeasy), cai pro RS_Total_Fatura como base aproximada.
    if (clientPag) {
      const valor = rows.reduce((s, r) => s + Number(r.RS_Total_Fatura ?? r.valor ?? 0), 0);
      // Ressarcimento: para auditados usa o valor canônico gravado (tabela
      // FATURA_APONTAMENTOS_AUDITADOS, via r.ressarcimento_estimado — com fallback
      // rs_kwh_total). Demais linhas: cálculo ao vivo calcRessEstimado (base energia
      // ativa × d/(1+d) × fator). NUNCA usar RS_Total_Fatura como base — infla.
      const ressBruto = rows.reduce((s, r) => s + (Number(r.ressarcimento_estimado) > 0 ? Number(r.ressarcimento_estimado) : calcRessEstimado(r)), 0);
      // Ressarcimento 100% (valor cheio) em TODAS as abas — retenção de 42% removida
      // por decisão do usuário (Apontamentos, Auditados, Inconclusivos, Água e Acer = 100%).
      const ress = ressBruto;
      const ds = rows.map(r => Number(r.desvio_pct_max ?? 0)).filter(v => v > 0).sort((a, b) => a - b);
      const mediana = ds.length
        ? (ds.length % 2 ? ds[(ds.length - 1) / 2] : (ds[ds.length / 2 - 1] + ds[ds.length / 2]) / 2)
        : 0;
      return {
        total: rows.length,
        valor,
        ress,
        ticket: rows.length ? ress / rows.length : 0,
        desvioMedio: mediana,
        fichas: fichasFromRows(),
        totalFaturasAnalisadas: gTotFat,
        totalUCs: gTotUCs,
        conf,
      };
    }
    if (agg) {
      return {
        total: Number(agg.total) || 0,
        valor: Number(agg.valor) || 0,
        ress: Number(agg.ressarcimento) || 0,
        ticket: Number(agg.ticket_medio) || 0,
        desvioMedio: Number(agg.desvio_medio) || 0,
        fichas: agg.fichas || {},
        totalFaturasAnalisadas: gTotFat,
        totalUCs: gTotUCs,
        conf,
      };
    }
    return {
      total: rows.length, valor: 0, ress: 0, ticket: 0, desvioMedio: 0, fichas: {},
      totalFaturasAnalisadas: gTotFat, totalUCs: gTotUCs, conf,
    };
  }, [rows, agg, clientPag, tab]);

  const handleClickRow = useCallback((row, e) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuAnchor(rect);
    setMenuRow(row);
  }, []);

  const handleAction = useCallback((kind) => {
    const row = menuRow;
    setMenuRow(null);
    if (!row) return;
    if (kind === 'ia') setModalIA(row);
    else if (kind === 'requisicao') setModalReq(row);
    else if (kind === 'historico') setDrawerHist(row.UC ?? row.uc);
    else if (kind === 'encaminhar') setEncaminhar(row);
  }, [menuRow]);

  const tabAtual = TABS.find(t => t.id === tab);

  return (
    <div className="cpv2-root">
      <main className="cpv2-page" style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Auditoria de Faturas</h1>
          <div className="text-xs opacity-60 mt-0.5">
            Apontamentos identificados pelas regras F01–F05
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/ocr-lote')}
            title="OCR Inteligente — auditar faturas em lote (até 300 PDFs)"
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 16px', borderRadius: 10, fontWeight: 800, fontSize: 13, color: '#fff',
              border: '1px solid rgba(255,255,255,0.35)', cursor: 'pointer', letterSpacing: '.01em',
              background: 'linear-gradient(135deg, #1d4ed8 0%, #3b82f6 46%, #60a5fa 100%)',
              boxShadow: '0 6px 16px rgba(29,78,216,0.34), inset 0 1px 0 rgba(255,255,255,0.45)',
            }}
          >
            <span style={{ fontSize: 15 }}>⚡</span> OCR Inteligente
          </button>
          <button
            onClick={() => setShowRanking((v) => !v)}
            className="cpv2-btn"
            title="Rankings (top 5 clientes)"
            style={showRanking ? { borderColor: '#7c6f9c', color: '#7c6f9c' } : undefined}
          >
            🏆 Ranking
          </button>
          <button onClick={reload} className="cpv2-btn cpv2-btn--primary">
            Atualizar
          </button>
        </div>
      </div>

      {/* Painel de rankings (pódio) — escondido; abre no botão 🏆 */}
      {showRanking && <AuditoriaRankings />}

      {/* Tabs de status (decisão IA) — ocultas em FRC_MODE (não há IA na FRC) */}
      {!FRC_MODE && (
      <div className="flex gap-1 border-b border-[var(--cpv2-border)]">
        {TABS.filter(t => (t.id !== 'aprovados' || podeApontamentos) && (t.id !== 'inconclusivos' || podeApontamentos)).map(t => {
          const ativo = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className="px-5 py-2.5 text-sm font-semibold border-b-2 transition -mb-px"
              style={{
                borderColor: ativo ? t.cor : 'transparent',
                color: ativo ? t.cor : 'var(--cpv2-text)',
                opacity: ativo ? 1 : 0.55,
              }}>
              {t.label}
              <span className="ml-1 text-[10px] opacity-60">· {t.sub}</span>
            </button>
          );
        })}
        <button onClick={() => setCatalogoFichas(true)}
          className="ml-auto self-center px-3 py-1 my-1 text-xs font-semibold rounded-md"
          style={{ color: 'var(--accent)',
                   border: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)',
                   background: 'color-mix(in srgb, var(--accent) 10%, transparent)' }}
          title="Abrir o catálogo com a explicação das 61 fichas (o que é + como conferir)">
          📖 Catálogo de fichas
        </button>
      </div>
      )}

      <CatalogoFichasModal open={catalogoFichas} onClose={() => setCatalogoFichas(false)} />

      {tab === 'agua' ? <AguaPanel /> : tab === 'acer' ? <AcerPanel /> : (<>
      {/* Filtros do topo: Empresa (select, substitui as pills) + Ordenação (maiores apontamentos).
          As empresas vêm do backend em empresasDisponiveis (com contagem por status). */}
      <div className="flex gap-3 flex-wrap items-center text-xs">
        <label className="inline-flex items-center gap-1.5">
          <span className="opacity-70">Empresa:</span>
          <select
            className="cpv2-select"
            value={empresaSelecionada}
            onChange={(e) => setEmpresaSelecionada(e.target.value)}
          >
            <option value="todos">
              {FRC_MODE
                ? 'Selecione uma empresa…'
                : `Todas (${empresasDisponiveis.reduce((s, e) => s + Number(e.qtd || 0), 0)})`}
            </option>
            {empresasDisponiveis.map((e) => (
              <option key={e.cod_empresa} value={String(e.cod_empresa)}>
                {e.cod_empresa} — {e.nome}{(e.qtd !== '' && e.qtd != null) ? ` (${e.qtd})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-flex items-center gap-1.5">
          <span className="opacity-70">Ordenar:</span>
          <select
            className="cpv2-select"
            value={`${sort.col}:${sort.dir}`}
            onChange={(e) => {
              const [col, dir] = e.target.value.split(':');
              setSort({ col, dir });
            }}
          >
            <option value="id:desc">Mais recentes</option>
            <option value="ressarcimento:desc">Maiores apontamentos (R$)</option>
            <option value="desvio:desc">Maior desvio %</option>
            <option value="valor:desc">Maior valor da fatura</option>
          </select>
        </label>

        {/* Filtro por tipo de erro (F01/F02/F04/F05) */}
        <span className="inline-flex items-center gap-1.5">
          <span className="opacity-70">Erro:</span>
          {[
            { v: '', l: 'Todos', c: 'color-mix(in srgb, var(--fg) 55%, transparent)', nome: 'Todos os apontamentos' },
            { v: 'F01', l: 'F01', c: FICHA_COLORS.F01, nome: FICHA_DESCRICAO.F01.nome },
            { v: 'F02', l: 'F02', c: FICHA_COLORS.F02, nome: FICHA_DESCRICAO.F02.nome },
            { v: 'F04', l: 'F04', c: FICHA_COLORS.F04, nome: FICHA_DESCRICAO.F04.nome },
            { v: 'F05', l: 'F05', c: FICHA_COLORS.F05, nome: FICHA_DESCRICAO.F05.nome },
          ].map((o) => {
            const ativo = fichaSel === o.v;
            return (
              <button
                key={o.v || 'all'}
                onClick={() => setFichaSel(o.v)}
                title={o.nome}
                style={{
                  padding: '3px 10px', borderRadius: 999, fontWeight: 600, fontSize: 11.5,
                  background: ativo ? o.c : `color-mix(in srgb, ${o.c} 13%, transparent)`,
                  color: ativo ? '#fff' : o.c,
                  border: `1px solid color-mix(in srgb, ${o.c} 33%, transparent)`,
                }}
              >
                {o.l}
              </button>
            );
          })}
        </span>

        {/* Segmento — seleciona só um grupo (afeta tabela + KPIs) */}
        <label className="inline-flex items-center gap-1.5 pl-3 ml-1 border-l border-[var(--cpv2-border)]">
          <span className="opacity-70">Segmento:</span>
          <select className="cpv2-select" value={segmento} onChange={(e) => setSegmento(e.target.value)}>
            <option value="todos">Todos</option>
            <option value="demais">Demais (Grupo B convencional)</option>
            <option value="gd">GD</option>
            <option value="grupo_a">Grupo A</option>
            <option value="branca">Tarifa Branca</option>
            <option value="mercado_livre">Mercado Livre</option>
          </select>
        </label>

        {/* Agrupar por UC — colapsa os meses da mesma unidade em 1 linha */}
        {clientPag && (
          <label className="inline-flex items-center gap-1.5 pl-3 ml-1 border-l border-[var(--cpv2-border)]">
            <button type="button" onClick={() => setAgrupar((a) => !a)}
              title="Colapsar os vários meses apontados da mesma UC em uma linha só"
              className="px-2.5 py-1 rounded text-xs font-semibold border"
              style={{ borderColor: agrupar ? 'var(--cpv2-accent)' : 'var(--cpv2-border)', background: agrupar ? 'color-mix(in srgb, var(--cpv2-accent) 12%, transparent)' : 'transparent', color: agrupar ? 'var(--cpv2-accent)' : 'var(--cpv2-text)' }}>
              {agrupar ? '☑' : '☐'} Agrupar por UC
            </button>
          </label>
        )}
      </div>

      {/* Filtros */}
      <FiltrosBar
        filtros={filtros}
        setFiltros={setFiltros}
        ficha={ficha}
        setFicha={setFicha}
        fichaCounts={fichaCounts}
        mostrarFicha={false}
        frcMode={FRC_MODE}
      />

      {/* Cards resumo */}
      <div className="cpv2-kpis">
        <Card label="Faturas analisadas" value={(resumo.totalFaturasAnalisadas || 0).toLocaleString('pt-BR')} cor="var(--accent)"/>
        <Card label="UCs" value={(resumo.totalUCs || 0).toLocaleString('pt-BR')} cor="var(--accent)"/>
        <Card label={`Faturas (${tabAtual?.label})`} value={resumo.total} cor={tabAtual?.cor}/>
        <Card label="Valor total das faturas" value={fmtCurrency(resumo.valor)} />
        <Card label="Ressarcimento estimado" value={fmtCurrency(resumo.ress)} cor="var(--success)"/>
        {/* BI */}
        <Card label="Ticket médio" value={fmtCurrency(resumo.ticket)} cor="var(--success)"/>
        <Card label="Desvio % mediano" value={`${(resumo.desvioMedio || 0).toFixed(1)}%`} cor="var(--warning)"/>
        <Card
          label="Distribuição por ficha"
          value={
            <span style={{ fontSize: 13, fontWeight: 700, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {Object.keys(resumo.fichas || {}).length
                ? Object.entries(resumo.fichas)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => (
                      <span key={k}>
                        {k}: <span style={{ color: 'var(--accent)' }}>{v}</span>
                      </span>
                    ))
                : '—'}
            </span>
          }
        />
      </div>

      {/* Legenda das cores das linhas (dourado = VERDADEIRO / azul = dentro da resolução) */}
      {(tab === 'auditados' || tab === 'inconclusivos') && (
        <div className="aud-legenda" role="note" aria-label="Legenda das cores">
          <span className="aud-legenda-item">
            <span className="aud-legenda-swatch aud-sw-ouro">★</span>
            <b>Dourado</b> — apontamento <b>VERDADEIRO</b> (ressarcimento real conferido no PDF; já virou requisição).
          </span>
          <span className="aud-legenda-item">
            <span className="aud-legenda-swatch aud-sw-azul">▲</span>
            <b>Azul</b> — <b>dentro da resolução</b> (regra dos 3 meses REN 1000: faturamento por média/não-lido ≤3 meses, ou sem média; não é apontamento — analista confere o cálculo).
          </span>
          <span className="aud-legenda-item aud-legenda-neutra">
            <span className="aud-legenda-swatch aud-sw-neutro" />
            Sem cor — demais apontamentos (ainda não classificados).
          </span>
        </div>
      )}

      {/* Tabela */}
      <div className="cpv2-tablewrap">
        {loading ? (
          <div className="p-8 text-center text-sm opacity-60">Carregando...</div>
        ) : error ? (
          <div className="p-8 text-center text-sm text-[var(--danger)]">{error}</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm opacity-60">Nenhuma fatura encontrada com esses filtros.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="cpv2-table">
              <thead>
                <tr>
                  <th className="px-2 py-2 text-right opacity-50" title="Índice de exibição">#</th>
                  <SortTh col="id"             align="left"   sort={sort} onClick={toggleSort}>ID</SortTh>
                  <SortTh col="uc"             align="left"   sort={sort} onClick={toggleSort}>UC</SortTh>
                  <SortTh col="cliente"        align="left"   sort={sort} onClick={toggleSort}>Cliente</SortTh>
                  <SortTh col="concessionaria" align="left"   sort={sort} onClick={toggleSort}>Concessionária</SortTh>
                  <SortTh col="mes"            align="left"   sort={sort} onClick={toggleSort}>Mês</SortTh>
                  <SortTh col="valor"          align="right"  sort={sort} onClick={toggleSort}>Valor</SortTh>
                  <SortTh col="desvio"         align="right"  sort={sort} onClick={toggleSort}>Desvio %</SortTh>
                  <th className="px-3 py-2 text-left">Fichas</th>
                  {tab === 'inconclusivos' && <th className="px-3 py-2 text-left" title="Por que o motor apontou (fila de triagem — verificar)">Motivo (triagem)</th>}
                  <th className="px-3 py-2 text-center">Processo</th>
                  <SortTh col="ressarcimento" align="right"  sort={sort} onClick={toggleSort}>Ressarc.</SortTh>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((r, _idx) => {
                  const d = getDecisao(r);
                  const fichas = d?.fichas_confirmadas ?? extractFichas(r.fichas_aplicadas);
                  const valor = Number(r.RS_Total_Fatura ?? r.valor ?? 0);
                  // Auditados: usa o ressarcimento canônico gravado (tabela
                  // FATURA_APONTAMENTOS_AUDITADOS) — mesmo valor do modal. Demais
                  // linhas: cálculo ao vivo (calcRessEstimado).
                  const ress = Number(r.ressarcimento_estimado) > 0 ? Number(r.ressarcimento_estimado) : calcRessEstimado(r);
                  const id = r.id;
                  const ucStr = String(r.UC ?? r.uc ?? '').trim();
                  const reqsUC = reqMap[ucStr] ?? [];
                  const temProcesso = reqsUC.length > 0;
                  const reqTooltip = reqsUC
                    .map(req => `#${req.id} · ${req.status}${req.etapa ? ` · ${req.etapa}` : ''}${req.ressarcimento_estimado ? ` · R$ ${Number(req.ressarcimento_estimado).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : ''}`)
                    .join('\n');

                  // Sem realce de cor por severidade — linhas brancas (hover padrão).
                  // Rejeitada (local, sem reload): risco vermelho no meio da linha.
                  const rowStyle = r._rejeitado
                    ? { textDecoration: 'line-through', textDecorationColor: 'var(--danger)', textDecorationThickness: '2px', opacity: 0.55 }
                    : undefined;

                  // Linha DOURADA = VERDADEIRO (ressarcimento real conferido).
                  // Linha AZUL = DENTRO DA RESOLUÇÃO (regra dos 3 meses REN 1000) / sem média — não é apontamento.
                  // Laranja aposentado: só faria sentido p/ "parcelamento não cumprido", e não há mais nenhum (reqs removidas).
                  // Sinal vem de observacao_auditado (FATURA_APONTAMENTOS_AUDITADOS.observacao).
                  const _obsAud = String(r.observacao_auditado ?? '');
                  const isVerdadeiroAud = !r._rejeitado && /VERDADEIRO/i.test(_obsAud);
                  const isLaranjaAud = false;
                  const isAzulAud = !r._rejeitado && !isVerdadeiroAud && !isLaranjaAud && /(DENTRO DA RESOLU|SEM M[ÉE]DIA)/i.test(_obsAud);

                  return (
                    <Fragment key={`${r.fonte || 'fde'}-${id}`}>
                    <tr
                      className={`border-b border-[var(--cpv2-border)] hover:bg-[var(--cpv2-surface-2)] cursor-pointer ${isVerdadeiroAud ? 'aud-linha-ouro' : isLaranjaAud ? 'aud-linha-laranja' : isAzulAud ? 'aud-linha-azul' : ''}`}
                      style={rowStyle}
                      onClick={(e) => {
                        // não abre o modal se clicou em botão, link, select ou input
                        if (e.target.closest('button, a, select, input')) return;
                        setModalFatura(r);
                      }}>
                      <td className="px-2 py-2 text-right font-mono opacity-40 text-[11px]">{_idx + 1}</td>
                      <td className="px-3 py-2 font-mono text-[var(--accent)]">
                        <span className="inline-flex items-center gap-1">
                          <span className="text-[10px] opacity-50">🔍</span>
                          {id}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono">
                        <span className="inline-flex items-center gap-1">
                          {ucStr}
                          {temProcesso && (
                            <button
                              title={`${reqsUC.length} processo(s) aberto(s):\n${reqTooltip}\n\nClique para ver em Requisições`}
                              onClick={(e) => { e.stopPropagation(); navigate('/Requisicoes'); }}
                              className="inline-flex items-center justify-center w-[15px] h-[15px] rounded-full text-[9px] font-bold leading-none flex-shrink-0"
                              style={{ color: 'var(--warning)', border: '1px solid color-mix(in srgb, var(--warning) 60%, transparent)', backgroundColor: 'color-mix(in srgb, var(--warning) 12%, transparent)' }}
                            >ⓘ</button>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2 truncate max-w-[200px]" title={getNomeEmpresa(r)}>
                        {getNomeEmpresa(r)}
                      </td>
                      <td className="px-3 py-2">{r.Concessionaria ?? r.concessionaria ?? '—'}</td>
                      <td className="px-3 py-2 font-mono">
                        {r._grupoN > 1
                          ? <span title={`${r._grupoN} meses apontados nesta UC — abra para ver todos`}
                              className="px-2 py-0.5 rounded text-[11px] font-bold"
                              style={{ color: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)' }}>
                              {r._grupoN} meses
                            </span>
                          : fmtMesRef(r.Mes_Ref ?? r.mes_ref)}
                      </td>
                      <td className="px-3 py-2 text-right">{fmtCurrency(valor)}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        {(() => {
                          const dv = Number(r.desvio_pct_max ?? 0);
                          if (dv === 0) return <span className="opacity-30">—</span>;
                          let cls = 'opacity-70';
                          if (dv >= 80) cls = 'text-[var(--danger)] font-semibold';
                          else if (dv >= 30) cls = 'text-[var(--warning)] font-semibold';
                          else if (dv < 0) cls = 'text-[color-mix(in_srgb,var(--fg)_55%,transparent)]';
                          return <span className={cls}>{dv > 0 ? '+' : ''}{dv.toFixed(0)}%</span>;
                        })()}
                      </td>
                      <td className="px-3 py-2">
                        {r.fonte === 'sgeeasy' && (
                          <span title="Apontado no sgeeasy e ausente na FDE (Outlier)"
                            className="mr-1 px-1.5 rounded text-[10px] font-bold"
                            style={{ color: 'var(--danger)', border: '1px solid color-mix(in srgb, var(--danger) 33%, transparent)', background: 'color-mix(in srgb, var(--danger) 10%, transparent)' }}>
                            Outlier
                          </span>
                        )}
                        <FichasBadge fichas={fichas}/>
                        {(r.tem_parcelamento === true || Number(r.tem_parcelamento) === 1) && (
                          <span title="Tem parcelamento (Art.113) — sempre analisar"
                            className="ml-1 px-1 rounded text-[10px] font-bold cursor-help"
                            style={{ color: 'var(--danger)', border: '1px solid color-mix(in srgb, var(--danger) 33%, transparent)', background: 'color-mix(in srgb, var(--danger) 9%, transparent)' }}>
                            ⚠️Art.113
                          </span>
                        )}
                        {/* Badge "Adicionar observação do analista" removido a pedido — o analista age direto (Confirmar erro/Rejeitar), nada fica pendurado. */}
                      </td>
                      {tab === 'inconclusivos' && (
                        <td className="px-3 py-2 text-[11px] opacity-80 max-w-[280px]" title={r.triagem_explicacao || ''}>
                          {r.triagem_explicacao ? r.triagem_explicacao : <span className="opacity-30">—</span>}
                        </td>
                      )}
                      <td className="px-3 py-2 text-center">
                        {reqsUC.length > 0 ? (
                          <button
                            title={reqTooltip}
                            onClick={(e) => { e.stopPropagation(); navigate('/Requisicoes'); }}
                            className="font-mono text-xs text-[var(--accent)] hover:text-[var(--accent-2)] underline"
                          >
                            {reqsUC.map(rq => rq.numero_processo ?? rq.processo ?? `#${rq.id}`).join(', ')}
                          </button>
                        ) : <span className="opacity-30">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right text-[var(--success)]" title={r._grupoN > 1 ? `Soma dos ${r._grupoN} meses da UC` : ''}>
                        {fmtCurrency(r._grupoN > 1 ? r._grupoRess : ress)}
                      </td>
                    </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Paginação (Anterior / Próxima), estilo Controle de Processos */}
      {sortedRows.length > 0 && (
        <div className="cpv2-pager">
          <button
            type="button"
            className="cpv2-btn cpv2-btn--sm"
            disabled={pageSafe <= 1}
            onClick={() => setPage((x) => Math.max(1, x - 1))}
          >
            ← Anterior
          </button>
          <span className="cpv2-pager__info">
            Página {pageSafe} de {totalPaginasLocal} · exibindo {sortedRows.length} de {totalGlobal.toLocaleString('pt-BR')} caso(s)
            {loading ? ' · carregando…' : ''}
          </span>
          <button
            type="button"
            className="cpv2-btn cpv2-btn--sm"
            disabled={loading || pageSafe >= totalPaginasLocal}
            onClick={irProxima}
          >
            Próxima →
          </button>
        </div>
      )}
      </>)}
      </main>

      {/* Menu de ações */}
      {menuRow && (
        <AcoesMenu row={menuRow} anchor={menuAnchor} onClose={() => setMenuRow(null)} onAction={handleAction}/>
      )}

      {/* Modais */}
      {modalIA && (
        <AnaliseIAModal row={modalIA} onClose={() => setModalIA(null)} onReprocessed={() => reload()}/>
      )}
      {modalReq && (
        <CriarRequisicaoModal row={modalReq} onClose={() => setModalReq(null)} onCreated={() => reload()}/>
      )}
      {drawerHist && (
        <HistoricoDrawer uc={drawerHist} onClose={() => setDrawerHist(null)}/>
      )}
      {/* ⭐ Modal "fatura montada" — aberto ao clicar numa linha de apontamento */}
      {modalFatura && (
        <ModalFaturaMontada row={modalFatura} onClose={() => { setModalFatura(null); if (idParam) navigate('/analise-desvio'); }} onRejeitado={(idRej) => setRows(prev => prev.map(x => String(x.id) === String(idRej ?? modalFatura?.id) ? { ...x, _rejeitado: true } : x))} onEncaminhar={(r) => setEncaminhar(r)}
          apontamentosUC={(() => {
            const key = (x) => String(x?.UC ?? x?.uc ?? '').trim();
            const k = key(modalFatura);
            return k ? rows.filter(x => key(x) === k && !x._rejeitado) : [modalFatura];
          })()}
          onSwitchFatura={(r) => setModalFatura(r)}/>
      )}
      {encaminhar && <EncaminharPopup row={encaminhar} onClose={() => setEncaminhar(null)} navigate={navigate} />}

      {/* Confirmação de rejeição (lixeira) */}
      {confirmReject && (() => {
        // ⭐ Verifica se já existe requisição/processo aberto para essa UC
        const ucRej = String(confirmReject.UC ?? confirmReject.uc ?? '').trim();
        const mesRej = String(confirmReject.Mes_Ref ?? confirmReject.mes_ref ?? '').trim();
        const reqsExistentes = reqMap[ucRej] ?? [];
        const temProcessoNoPeriodo = reqsExistentes.some(req => {
          // Confronta por mês_referencia ou período sobreposto
          const reqMes = String(req.mes_referencia ?? req.mes_ref ?? '').trim();
          if (reqMes && mesRej && reqMes === mesRej) return true;
          // Fallback: qualquer processo aberto na UC
          return req.status && req.status.toLowerCase() !== 'concluido' && req.status.toLowerCase() !== 'cancelado';
        });
        const qtdProcessos = reqsExistentes.length;

        return (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60"
          onClick={() => !rejecting && setConfirmReject(null)}
        >
          <div
            className="w-full max-w-md bg-[var(--cpv2-surface-2)] rounded-xl shadow-2xl border border-[color-mix(in_srgb,var(--danger)_50%,transparent)]"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-[var(--cpv2-border)] flex items-center gap-2">
              <span className="text-xl">🗑️</span>
              <div>
                <div className="font-bold text-sm">Rejeitar fatura</div>
                <div className="text-xs opacity-60">decisao_final será alterada para REFUTADO</div>
              </div>
            </div>
            <div className="px-5 py-4 text-sm space-y-2">
              {/* ⭐ Flag de processo existente no período */}
              {temProcessoNoPeriodo && (
                <div className="rounded-md border border-[color-mix(in_srgb,var(--warning)_50%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] p-3">
                  <div className="flex items-start gap-2">
                    <span className="text-base">⚠️</span>
                    <div className="flex-1 space-y-1">
                      <div className="font-bold text-xs text-[var(--warning)]">
                        Já existe processo aberto para esta UC no período!
                      </div>
                      <div className="text-[11px] opacity-80 space-y-0.5">
                        {reqsExistentes.slice(0, 5).map(req => (
                          <div key={req.id} className="font-mono">
                            #{req.id} · {req.status}{req.etapa ? ` · ${req.etapa}` : ''}
                            {req.mes_referencia && ` · ${fmtMesRef(req.mes_referencia)}`}
                            {req.ressarcimento_estimado && ` · R$ ${Number(req.ressarcimento_estimado).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`}
                          </div>
                        ))}
                        {qtdProcessos > 5 && <div className="opacity-60">+ {qtdProcessos - 5} outros…</div>}
                      </div>
                      <div className="text-[10px] opacity-60 pt-1">
                        Verifique se a rejeição é mesmo necessária — pode duplicar trabalho ou bloquear pleito em andamento.
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {!temProcessoNoPeriodo && qtdProcessos > 0 && (
                <div className="rounded-md border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] p-2.5">
                  <div className="text-[11px] text-[var(--accent)]">
                    ℹ️ UC tem {qtdProcessos} processo(s) anteriores (concluídos/outros períodos)
                  </div>
                </div>
              )}

              <div>Tem certeza que quer rejeitar a fatura abaixo?</div>
              <div className="rounded bg-[var(--cpv2-surface)] p-3 text-xs font-mono space-y-1">
                <div>ID: <span className="text-[var(--accent)]">{confirmReject.id}</span></div>
                <div>UC: <span className="text-[var(--accent)]">{confirmReject.UC ?? confirmReject.uc}</span></div>
                <div>Mês: {fmtMesRef(confirmReject.Mes_Ref ?? confirmReject.mes_ref)}</div>
                <div>Valor: {fmtCurrency(Number(confirmReject.RS_Total_Fatura ?? 0))}</div>
              </div>
              <div className="text-[11px] opacity-60 pt-1">
                A fatura sairá da aba <b>Aprovados</b> e aparecerá em <b>Rejeitados</b>.
                A justificativa humana será atualizada automaticamente.
              </div>
            </div>
            <div className="px-5 py-3 border-t border-[var(--cpv2-border)] flex justify-end gap-2">
              <button
                onClick={() => setConfirmReject(null)}
                disabled={rejecting}
                className="px-3 py-1.5 text-xs rounded bg-[var(--cpv2-surface)] hover:bg-[var(--cpv2-surface-2)]"
              >Cancelar</button>
              <button
                onClick={doRejeitar}
                disabled={rejecting}
                className={`px-3 py-1.5 text-xs rounded text-white font-semibold disabled:opacity-50 ${
                  temProcessoNoPeriodo ? 'bg-[var(--warning)] hover:bg-[color-mix(in_srgb,var(--warning)_85%,black)]' : 'bg-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_85%,black)]'
                }`}
              >
                {rejecting ? 'Rejeitando…' : temProcessoNoPeriodo ? '⚠️ Rejeitar mesmo assim' : 'Confirmar rejeição'}
              </button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   ⭐ v19 — HistoricoReanalises: timeline de reanálises da fatura
   ──────────────────────────────────────────────────────────────────────────── */

function HistoricoReanalises({ faturaId, chave }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandido, setExpandido] = useState(null);

  useEffect(() => {
    if (!faturaId) return;
    let cancel = false;
    setLoading(true);
    apiClient.get(`/api/v1/faturas/${faturaId}/reanalises`)
      .then(res => {
        if (cancel) return;
        const arr = Array.isArray(res.data) ? res.data : [];
        setItems(arr);
      })
      .catch(() => { if (!cancel) setItems([]); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [faturaId, chave]);

  if (loading) {
    return (
      <div className="rounded-lg border border-[var(--cpv2-border)] bg-[var(--cpv2-surface-2)] p-3 text-[10px] opacity-60">
        Carregando histórico de reanálises...
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--cpv2-border)] bg-[var(--cpv2-surface-2)] p-3 text-[10px] opacity-50">
        📜 Nenhuma reanálise registrada ainda. Cada vez que você clicar em "Reanalisar com IA",
        a decisão será preservada aqui (audit trail).
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--cpv2-border)] bg-[var(--cpv2-surface-2)] p-3 space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider opacity-70 flex items-center gap-2">
        📜 Histórico de reanálises ({items.length})
        <span className="text-[9px] opacity-50 font-normal">— mais recente primeiro</span>
      </div>

      <div className="space-y-1.5">
        {items.map((r, idx) => {
          const isOpen = expandido === r.id;
          let fichas = [];
          try {
            if (typeof r.fichas_confirmadas === 'string' && r.fichas_confirmadas.startsWith('[')) {
              fichas = JSON.parse(r.fichas_confirmadas);
            } else if (Array.isArray(r.fichas_confirmadas)) {
              fichas = r.fichas_confirmadas;
            }
          } catch { fichas = []; }

          return (
            <div
              key={r.id}
              className={`rounded border ${idx === 0 ? 'border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent)_5%,transparent)]' : 'border-[var(--cpv2-border)] bg-[var(--cpv2-surface)]'}`}
            >
              <button
                onClick={() => setExpandido(isOpen ? null : r.id)}
                className="w-full px-3 py-2 text-left flex items-center justify-between gap-3 hover:bg-[var(--cpv2-surface-2)]"
              >
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="opacity-50 font-mono">{idx === 0 ? '🟢 atual' : `#${items.length - idx}`}</span>
                  <StatusBadge status={r.decisao_final}/>
                  <FichasBadge fichas={fichas}/>
                  {r.v19_status_passibilidade && (
                    <PassibilidadeBadge status={r.v19_status_passibilidade}/>
                  )}
                  <span className="text-[10px] opacity-60">
                    confiança {r.confianca_final ?? '—'}%
                  </span>
                  <span className="text-[10px] opacity-60">
                    {r.percentual_ressarcimento != null ? `ressarc. ${r.percentual_ressarcimento}%` : ''}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[10px] opacity-60">
                  {r.modelo && <span className="font-mono">{r.modelo}</span>}
                  {r.pdf_anexado === 1 && <span title="PDF anexado">📄</span>}
                  <span>{r.criado_em ? fmtDateTime(r.criado_em) : '—'}</span>
                  <span className="opacity-40">{isOpen ? '▲' : '▼'}</span>
                </div>
              </button>

              {isOpen && (
                <div className="px-3 py-2 border-t border-[var(--cpv2-border)] text-[11px] space-y-2">
                  {r.usuario_nome && (
                    <div className="opacity-60">
                      👤 Disparada por: <b>{r.usuario_nome}</b>
                    </div>
                  )}
                  {r.v19_parcela_alerta && (
                    <div className="font-mono text-[10px] opacity-80">
                      v19 → alerta: <b>{r.v19_parcela_alerta}</b>
                      {r.v19_total_estimado && <> · dívida estimada: <b>R$ {Number(r.v19_total_estimado).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</b></>}
                      {r.v19_score_confianca != null && <> · score: <b>{r.v19_score_confianca}/100</b></>}
                    </div>
                  )}
                  {r.justificativa && (
                    <div>
                      <div className="text-[9px] uppercase opacity-60 mb-0.5">Justificativa</div>
                      <div className="whitespace-pre-wrap opacity-90 leading-relaxed">{r.justificativa}</div>
                    </div>
                  )}
                  {r.recomendacao && (
                    <div>
                      <div className="text-[9px] uppercase opacity-60 mb-0.5">Recomendação</div>
                      <div className="whitespace-pre-wrap opacity-90 leading-relaxed">{r.recomendacao}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SortTh({ col, align = 'left', sort, onClick, children }) {
  const ativo = sort?.col === col;
  const seta  = ativo ? (sort.dir === 'asc' ? '▲' : '▼') : '↕';
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  return (
    <th
      onClick={() => onClick?.(col)}
      className={`px-3 py-2 ${alignCls} cursor-pointer select-none hover:bg-[var(--cpv2-surface)] transition`}
      title={`Ordenar por ${typeof children === 'string' ? children : col}`}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        <span className={`text-[10px] ${ativo ? 'opacity-100 text-[var(--accent)]' : 'opacity-30'}`}>{seta}</span>
      </span>
    </th>
  );
}

function Card({ label, value, cor }) {
  return (
    <div className="cpv2-kpi">
      <div className="cpv2-kpi__label">{label}</div>
      <div className="cpv2-kpi__value" style={{ color: cor || 'inherit' }}>{value}</div>
    </div>
  );
}
