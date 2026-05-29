import React, { Fragment, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ReferenceLine, ReferenceArea, ScatterChart, Scatter, ZAxis, Cell,
} from 'recharts';
import apiClient from '../services/apiClient';

/* ────────────────────────────────────────────────────────────────────────────
   Constantes
   ──────────────────────────────────────────────────────────────────────────── */

const FICHAS = [
  { id: 'f01', label: 'F01', nome: 'Divergência de Fórmula',        endpoint: '/api/v1/faturas/ficha/01', cor: '#1a56db' },
  { id: 'f02', label: 'F02', nome: 'Desvio de Média',               endpoint: '/api/v1/faturas/ficha/02', cor: '#0e9f6e' },
  { id: 'f03', label: 'F03', nome: 'Acúmulo de Consumo',            endpoint: '/api/v1/faturas/ficha/03', cor: '#c27803' },
  { id: 'f04', label: 'F04', nome: 'Troca de Medidor',              endpoint: '/api/v1/faturas/ficha/04', cor: '#9061f9' },
  { id: 'f05', label: 'F05', nome: 'Quebra de Leitura',             endpoint: '/api/v1/faturas/ficha/05', cor: '#e02424' },
  { id: 'f06', label: 'F06', nome: 'Ausência de Leituras',          endpoint: '/api/v1/faturas/ficha/06', cor: '#0891b2' },
  { id: 'f07', label: 'F07', nome: 'Rollover de Medidor',           endpoint: '/api/v1/faturas/ficha/07', cor: '#7c3aed' },
  { id: 'f08', label: 'F08', nome: 'Troca sem Zeramento',           endpoint: '/api/v1/faturas/ficha/08', cor: '#b45309' },
  { id: 'f09', label: 'F09', nome: 'Leitura Estimada',              endpoint: '/api/v1/faturas/ficha/09', cor: '#be185d' },
  { id: 'f10', label: 'F10', nome: 'Tarifa Incorreta',              endpoint: '/api/v1/faturas/ficha/10', cor: '#065f46' },
  { id: 'f11', label: 'F11', nome: 'Demanda Contratada',            endpoint: '/api/v1/faturas/ficha/11', cor: '#1e40af' },
  { id: 'f12', label: 'F12', nome: 'Ausência de Medição',            endpoint: '/api/v1/faturas/ficha/12', cor: '#92400e' },
  { id: 'f13', label: 'F13', nome: 'Consumo Zero com Demanda/Rea.', endpoint: '/api/v1/faturas/ficha/13', cor: '#dc6803' },
  { id: 'f14', label: 'F14', nome: 'Outros Erros IA',               endpoint: '/api/v1/faturas/ficha/14', cor: '#374151' },
];

const FICHA_COLORS = {
  F01: '#1a56db', F02: '#0e9f6e', F03: '#c27803', F04: '#9061f9', F05: '#e02424',
  F06: '#0891b2', F07: '#7c3aed', F08: '#b45309', F09: '#be185d', F10: '#065f46',
  F11: '#1e40af', F12: '#92400e', F13: '#dc6803', F14: '#374151',
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

const SEVERITY_COLORS = { 5: '#ef4444', 4: '#f97316', 3: '#eab308', 2: '#22c55e', 1: '#3b82f6' };
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
  { id: 'aprovados',     label: 'Aprovados',     cor: '#22c55e', sub: 'CONFIRMADO' },
  { id: 'inconclusivos', label: 'Inconclusivos', cor: '#eab308', sub: 'INCONCLUSIVO' },
  { id: 'rejeitados',    label: 'Rejeitados',    cor: '#ef4444', sub: 'REFUTADO' },
];

const STATUS_POR_TAB = {
  aprovados:     'CONFIRMADO',
  inconclusivos: 'INCONCLUSIVO',
  rejeitados:    'REFUTADO',
};

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
  if (!fichas?.length) return <span className="text-gray-400">—</span>;
  return (
    <div className="flex flex-wrap gap-0.5">
      {fichas.map(f => {
        const cor  = FICHA_COLORS[f] ?? '#6b7280';
        const info = FICHA_DESCRICAO[f];
        const tip  = info ? `${f} — ${info.nome}\n${info.desc}` : f;
        return (
          <span key={f} title={tip}
            style={{ backgroundColor: cor + '33', color: cor, border: `1px solid ${cor}55` }}
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
    CONFIRMADO:   'bg-green-500/20 text-green-400 border-green-500/40',
    INCONCLUSIVO: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40',
    REFUTADO:     'bg-red-500/20 text-red-400 border-red-500/40',
    PENDENTE:     'bg-gray-500/20 text-gray-400 border-gray-500/40',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${cores[status] ?? cores.PENDENTE}`}>
      {status || 'PENDENTE'}
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
    cor: 'bg-red-500/20 text-red-300 border-red-500/40',
    desc: 'Art.323 incidindo sobre Art.113 ainda não pago — único caso realmente problemático',
    prioridade: 1,
  },
  PASSIVEL_CICLO_INFINITO: {
    label: 'Ciclo infinito',
    short: 'CICLO',
    cor: 'bg-orange-500/20 text-orange-300 border-orange-500/40',
    desc: 'Ciclo infinito Art.113 detectado',
    prioridade: 2,
  },
  TEM_PARCELAMENTO: {
    label: 'Tem parcelamento',
    short: 'PARCELAMENTO',
    cor: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
    desc: 'Parcelamento Art.113/323 detectado (informativo, sem juízo de abusividade)',
    prioridade: 3,
  },
  COMPENSADO_NEUTRALIZADO: {
    label: 'Compensado',
    short: 'COMPENSADO',
    cor: 'bg-gray-500/20 text-gray-300 border-gray-500/40',
    desc: 'Cliente já está sendo restituído (compensação ativa ou devolução em dobro) — descartar',
    prioridade: 4,
  },
};

function PassibilidadeBadge({ status }) {
  if (!status) return <span className="opacity-30 text-[10px]">—</span>;
  const cfg = PASSIBILIDADE_CONFIG[status] || {
    label: status,
    short: status,
    cor: 'bg-gray-500/20 text-gray-300 border-gray-500/40',
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
      <div className="flex justify-between text-[11px] py-0.5 border-b border-[var(--border)]/30">
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
    <div className="flex justify-between text-[11px] py-0.5 border-b border-[var(--border)]/30 gap-2">
      <span className="opacity-60 flex-shrink-0">{label}</span>
      <span className={mono ? 'font-mono text-right' : 'text-right'} title={txt}>{txt}</span>
    </div>
  );
}

function Secao({ titulo, children, cor }) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg)] p-2.5">
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
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[11px]">
          <div className="flex items-start gap-2">
            <span className="text-base">⚠️</span>
            <div className="flex-1 space-y-1">
              <div className="font-semibold text-amber-300">
                Esta fatura ainda não passou pelo <code className="px-1 bg-[var(--bg)] rounded">pdf_pipeline_v2</code>
              </div>
              <div className="opacity-70">
                A Fase 4 do reprocessamento só rodou nas {row.id ? '989 ' : ''}faturas com
                <code className="px-1 mx-0.5 bg-[var(--bg)] rounded">decisao_final=CONFIRMADO</code>.
                Esta fatura é <span className="font-semibold">{decisao?.decisao_final || 'sem decisão'}</span>,
                então as colunas v19 estão vazias.
              </div>
              <div className="opacity-50 text-[10px] pt-1">
                Para popular: <code className="px-1 bg-[var(--bg)] rounded">python reprocessar_v2.py --id {row.id} --force</code>
              </div>
            </div>
          </div>
        </div>

        {/* Decisão IA — o que existe */}
        {(decisao?.decisao_final || decisao?.fichas_confirmadas?.length > 0) && (
          <Secao titulo="🤖 Decisão atual da IA (gpt-5.4)" cor="#60a5fa">
            <KV label="Decisão final" value={decisao.decisao_final} />
            <KV label="Ficha principal" value={decisao.ficha_principal} />
            <KV label="Fichas confirmadas" value={Array.isArray(decisao.fichas_confirmadas) ? decisao.fichas_confirmadas.join(', ') : decisao.fichas_confirmadas} />
            <KV label="Confiança final" value={decisao.confianca_final ? `${decisao.confianca_final}%` : null} mono />
            <KV label="Percentual ressarcimento" value={decisao.percentual_ressarcimento ? `${decisao.percentual_ressarcimento}%` : null} mono />
            {decisao.justificativa && (
              <div className="mt-2 pt-2 border-t border-[var(--border)]/30">
                <div className="text-[10px] opacity-60 mb-1">JUSTIFICATIVA</div>
                <div className="text-xs whitespace-pre-wrap leading-relaxed opacity-90">{decisao.justificativa}</div>
              </div>
            )}
            {decisao.recomendacao && (
              <div className="mt-2 pt-2 border-t border-[var(--border)]/30">
                <div className="text-[10px] opacity-60 mb-1">RECOMENDAÇÃO</div>
                <div className="text-xs whitespace-pre-wrap leading-relaxed opacity-90">{decisao.recomendacao}</div>
              </div>
            )}
          </Secao>
        )}

        {/* Identificação básica que sempre vem */}
        <Secao titulo="Identificação" cor="#94a3b8">
          <KV label="ID" value={row.id} mono />
          <KV label="UC" value={row.UC ?? row.uc} mono />
          <KV label="Mês ref." value={row.Mes_Ref ?? row.mes_ref} mono />
          <KV label="Concessionária" value={row.Concessionaria ?? row.distribuidora} />
          <KV label="Cliente" value={row.RAZAO_SOCIAL || row.nome_cliente} />
          <KV label="Valor fatura" value={row.RS_Total_Fatura} currency />
        </Secao>

        {/* Texto cru da IA */}
        {analiseTexto && (
          <details className="rounded-md border border-[var(--border)] bg-[var(--bg)] p-2" open>
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
        <Secao titulo="Identificação" cor="#60a5fa">
          <KV label="Nº fatura" value={ident.numero_fatura} mono />
          <KV label="Cliente" value={ident.nome_cliente} />
          <KV label="Modalidade" value={ident.modalidade_tarifaria} />
          <KV label="Tensão" value={ident.tensao_fornecimento} />
          <KV label="Grupo" value={ident.grupo_tarifario} />
          <KV label="Medidor Nº" value={ident.numero_medidor} mono />
        </Secao>

        {/* Medição */}
        <Secao titulo="Medição (leituras + consumo)" cor="#34d399">
          <KV label="Consumo Ponta" value={med.consumo_ponta_kwh} mono />
          <KV label="Consumo F.Ponta" value={med.consumo_fponta_kwh} mono />
          <KV label="Leit. Ant. P" value={med.leit_ant_ponta} mono />
          <KV label="Leit. Atu. P" value={med.leit_atu_ponta} mono />
          <KV label="Leit. Ant. FP" value={med.leit_ant_fponta} mono />
          <KV label="Leit. Atu. FP" value={med.leit_atu_fponta} mono />
          <KV label="Constante K" value={med.constante_k} mono />
        </Secao>

        {/* Parcelamento Art.113/323 (cluster mais importante) */}
        <Secao titulo="🚨 Parcelamento Art.113/323" cor="#f87171">
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
        <Secao titulo="⚠️ Compensação (anti-dupla)" cor="#fbbf24">
          <KV label="Já aplicada" value={comp.ja_aplicada} bool />
          <KV label="Valor real reconstruído" value={comp.valor_origem_real_rs} currency />
          <KV label="Devolução em dobro CDC" value={comp.devolucao_em_dobro} bool />
        </Secao>

        {/* Histórico Art.113 */}
        <Secao titulo="Histórico Art.113" cor="#c084fc">
          <KV label="Ciclos MIN consecutivos" value={histA.ciclos_min_max_consecutivos} mono />
          <KV label="Ciclos MED consecutivos" value={histA.ciclos_med_max_consecutivos} mono />
          <KV label="Ciclo infinito Art.113" value={histA.ciclo_infinito} bool />
          <KV label="MIN_PROLONGADO falso positivo" value={histA.min_prolongado_falso_positivo} bool />
          <KV label="Status leitura" value={histA.status_leitura_mes_atual} />
        </Secao>

        {/* Regulação / Cliente */}
        <Secao titulo="Regulação / Cliente" cor="#a78bfa">
          <KV label="UC pública (terceiro)" value={reg.uc_publica_operada_por_terceiro} bool />
          <KV label="Mercado livre / ACL" value={reg.mercado_livre_acl} bool />
          <KV label="Det. Judicial Proc." value={reg.determinacao_judicial_processo} mono />
          <KV label="Dívidas anteriores mesma UC" value={reg.dividas_anteriores_mesma_uc} mono />
        </Secao>

        {/* Bandeira / Reativos */}
        <Secao titulo="Bandeira / Reativos" cor="#fb923c">
          <KV label="Tipo bandeira" value={band.tipo} />
          <KV label="Valor bandeira" value={band.valor_rs} currency />
          <KV label="Reativo excedente (UFER/DMCR)" value={band.reativo_excedente_rs} currency />
        </Secao>

        {/* Validação aritmética */}
        <Secao titulo="Aritmética" cor="#22d3ee">
          <KV label="Total calculado" value={arit.total_calculado_rs} currency />
          <KV label="Diff %" value={arit.diff_pct} mono />
          <KV label="OK?" value={arit.ok} bool />
        </Secao>

        {/* Score / extração */}
        <Secao titulo="Extração / Auditoria" cor="#94a3b8">
          <KV label="Score (0-100)" value={extr.score_confianca} mono />
          <KV label="Revisada por GPT" value={extr.revisada_por_gpt} bool />
          <KV label="Modelo revisor" value={extr.modelo_revisor} mono />
          <KV label="Hash" value={extr.hash} mono />
          <KV label="Revisado em" value={extr.revisao_em} mono />
        </Secao>
      </div>

      {/* Histórico de consumo (12-13 meses) */}
      {histCons.length > 0 && (
        <Secao titulo={`Histórico de consumo (${histCons.length} meses)`} cor="#84cc16">
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
                  <tr key={i} className="border-t border-[var(--border)]/20">
                    <td className="px-1 py-0.5 font-mono">{h.mes}</td>
                    <td className="px-1 py-0.5 text-right font-mono">{Number(h.kwh ?? 0).toLocaleString('pt-BR')}</td>
                    <td className="px-1 py-0.5 text-center">
                      <span className={
                        h.tipo === 'LID' ? 'text-green-400' :
                        h.tipo === 'MED' ? 'text-amber-400' :
                        h.tipo === 'MIN' ? 'text-red-400' : 'opacity-50'
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
        <details className="rounded-md border border-[var(--border)] bg-[var(--bg)] p-2">
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
    const col = SEVERITY_COLORS[d.peso] ?? '#6b7280';
    return (
      <div className="rounded-lg border px-3 py-2 text-xs shadow-xl"
        style={{ background: '#0d1a2e', borderColor: `${col}55`, color: '#e2e8f0', minWidth: 180 }}>
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
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-[11px] font-bold tracking-wide opacity-80">MATRIZ DE RISCO</div>
          <div className="text-[9px] opacity-40">{pts.length} UCs · pior mês histórico</div>
        </div>
        <div className="flex items-center gap-3 text-[10px] opacity-60">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{background:'#ef4444'}}/> ACT NOW</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{background:'#eab308'}}/> Monitorar</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{background:'#22c55e'}}/> Baixo</span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <ScatterChart margin={{ top: 8, right: 28, bottom: 24, left: 12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis dataKey="x" name="Desvio" type="number" unit="%" domain={['auto','auto']}
            tick={{ fontSize: 9, fill: '#475569' }}
            label={{ value: 'Desvio %', position: 'insideBottom', offset: -10, fontSize: 10, fill: '#475569' }} />
          <YAxis dataKey="y" name="Valor" type="number" tickFormatter={fmtMoeda}
            tick={{ fontSize: 9, fill: '#475569' }}
            label={{ value: 'Valor', angle: -90, position: 'insideLeft', offset: 10, fontSize: 10, fill: '#475569' }} />
          <ZAxis dataKey="z" range={[40, 220]} />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine x={medX} stroke="rgba(255,255,255,0.08)" strokeDasharray="5 3"/>
          <ReferenceLine y={medY} stroke="rgba(255,255,255,0.08)" strokeDasharray="5 3"/>
          <ReferenceArea x1={medX} y1={medY} fill="rgba(239,68,68,0.06)" />
          <ReferenceArea x2={medX} y1={medY} fill="rgba(245,158,11,0.04)" />
          <ReferenceArea x1={medX} y2={medY} fill="rgba(245,158,11,0.03)" />
          {byPeso.map(({ p, color, label, data }) => (
            <Scatter key={p} name={label} data={data} fill={color} fillOpacity={0.8} />
          ))}
          <Legend iconSize={8} iconType="circle" wrapperStyle={{ fontSize: 10, paddingTop: 4, color: '#64748b' }} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Histórico Drawer (gráfico de barras com onClick)
   ──────────────────────────────────────────────────────────────────────────── */

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
          background: '#0f172a',
          borderColor: 'rgba(148, 163, 184, 0.4)',
          color: '#f1f5f9',
        }}
      >
        <div className="font-mono font-bold" style={{ color: '#fbbf24' }}>
          {d.mesLabel || d.mes}
          {d.numeroFatura && (
            <span className="ml-2 text-[10px] font-normal opacity-70">
              · NF {d.numeroFatura}
            </span>
          )}
        </div>
        <div className="font-semibold flex items-center gap-2 mt-0.5" style={{ color: '#f1f5f9' }}>
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
          <div className={`text-[10px] mt-1 ${Math.abs(devFatura) > 50 ? 'text-amber-300 font-bold' : 'opacity-70'}`}>
            <span className="opacity-70">desvio da fatura:</span>{' '}
            {devFatura >= 0 ? '+' : ''}{devFatura.toFixed(0)}%
            <span className="opacity-50"> (vs média histórica {formatTip ? formatTip(baselineFatura) : baselineFatura.toFixed(0)})</span>
          </div>
        )}
        {devPct !== null && (
          <div className={`text-[10px] mt-0.5 ${Math.abs(devPct) > 50 ? 'text-orange-400/80 font-semibold' : 'opacity-50'}`}>
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
                 style={{ background: 'rgba(148,163,184,0.2)', color: '#cbd5e1' }}>
              ✗ REFUTADO pela IA
            </div>
          );
        })()}
        {/* Flags do motor SQL — F02 / F03 / F04 / F05 */}
        {d.flagF02 === 1 && (
          <div className="text-[10px] mt-1 text-orange-300">
            📈 F02 — pico isolado de consumo
            {d.detalheF02 && <div className="opacity-70 mt-0.5">{d.detalheF02}</div>}
            {d.ressarcimentoEst > 0 && (
              <div className="mt-1 text-emerald-300 font-semibold">
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
          <div className="text-[10px] mt-1 text-yellow-300">
            ⚠️ F03 — acúmulo (consumo represado)
            {d.detalheF03 && <div className="opacity-70 mt-0.5">{d.detalheF03}</div>}
          </div>
        )}
        {d.flagF04 === 1 && (
          <div className="text-[10px] mt-1 text-purple-300">
            🔄 F04 — troca de medidor
            {d.detalheF04 && <div className="opacity-70 mt-0.5">{d.detalheF04}</div>}
          </div>
        )}
        {d.flagF05 === 1 && (
          <div className="text-[10px] mt-1 text-rose-300">
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
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
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
          <span className="ml-auto text-[10px] text-amber-400 opacity-80">
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
          scrollbarWidth: 'thin', scrollbarColor: '#475569 transparent',
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
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis dataKey="mes" tick={{ fontSize: 10, fill: '#94a3b8' }} angle={-30} textAnchor="end" height={44} interval={0}/>
          <YAxis tick={{ fontSize: 9, fill: '#94a3b8' }}
            tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v.toString()}/>
          <Tooltip
            content={<Tip />}
            offset={20}
            allowEscapeViewBox={{ x: false, y: true }}
            cursor={{ fill: 'rgba(255,255,255,0.08)' }}
            wrapperStyle={{ zIndex: 50, pointerEvents: 'none' }}
          />
          {media > 0 && (
            <ReferenceLine y={media} stroke="#f59e0b" strokeDasharray="4 2" strokeWidth={1.5}
              label={{ value: 'média', fill: '#f59e0b', fontSize: 9, position: 'insideRight' }} />
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
              let fill = temFatura ? cor : '#475569';
              if (media > 0 && temFatura) {
                const dev = (Number(d[dataKey]) - media) / media;
                if (dev > 1.0 || dev < -0.9) fill = '#ef4444';
                else if (dev > 0.5 || dev < -0.5) fill = '#f97316';
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
        className="w-full max-w-3xl bg-[var(--bg)] flex flex-col border-l border-[var(--border)] h-full"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)]"
          style={{ background: 'linear-gradient(135deg, #1e3a5f, #0f2340)' }}>
          <div>
            <div className="text-white font-bold text-sm">Histórico da UC — FATURA_DADOS_EXTRAIDOS</div>
            <div className="text-white/50 text-xs font-mono mt-0.5">{uc}</div>
          </div>
          <button onClick={onClose} className="text-white/60 hover:text-white text-xl leading-none px-2">×</button>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-3">
          {loading && <div className="text-sm opacity-60 py-8 text-center">Carregando histórico...</div>}
          {error   && <div className="text-sm text-red-400 py-8 text-center">{error}</div>}
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
                  scrollbarWidth: 'thin', scrollbarColor: '#475569 transparent',
                }}
                className="space-y-3"
              >
                <MiniChart
                  noScroll
                  titulo="VALOR DA FATURA · clique numa barra para abrir o PDF"
                  dados={dataComBaseline} dataKey="valor" cor="#3b82f6"
                  onBarClick={handleBarClick} formatTip={fmtCurrency} media={mediaValor}
                  baselineKey="baselineValor"
                />
                <MiniChart
                  noScroll
                  titulo="kWh CONSUMIDO — confirmado (fatura) vs histórico (referência de outras faturas)"
                  dados={dataComBaseline}
                  dataKey="kwhConfirmado" cor="#f59e0b"
                  dataKey2="kwhHistorico" cor2="#94a3b8"
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
                  <div className="rounded-lg border-2 border-purple-500/30 bg-purple-500/5 p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-purple-300 font-bold">🔄 Apontamento de medidor (F04)</span>
                        <span className="opacity-60">
                          {totalF04} fatura{totalF04 > 1 ? 's' : ''} com flag de troca
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={handleCompararMedidores}
                        disabled={analisando}
                        className="text-[11px] font-semibold px-3 py-1.5 rounded border border-purple-500/40 bg-purple-500/10 text-purple-200 hover:bg-purple-500/20 transition-colors disabled:opacity-70 flex items-center gap-2"
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
                      <div className="mt-2 text-xs text-red-400">{erroComp}</div>
                    )}

                    {resultadoComp && Array.isArray(resultadoComp.comparacoes) && resultadoComp.comparacoes.length > 0 && (
                      <div className="mt-3 rounded border border-[var(--border)] bg-[var(--bg)] overflow-hidden">
                        <table className="w-full text-xs">
                          <thead className="bg-[var(--bg-secondary)]">
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
                                falso_positivo: { bg: '#10b981', label: '✗ Falso positivo' },
                                troca_real:     { bg: '#a855f7', label: '✓ Troca real' },
                                sem_dados:      { bg: '#94a3b8', label: '? Sem dados' },
                                sem_proxima:    { bg: '#f59e0b', label: '⚠ Sem próxima' },
                              }[c.veredicto] || { bg: '#64748b', label: c.veredicto };
                              // Estado atual da fatura no histórico (após eventual aprovação)
                              const linhaData = data.find(d => d.id === c.id_apontada);
                              const aprovado    = linhaData?.f04Aprovado === 'true';
                              const desaprovado = linhaData?.flagF04 !== 1; // F04 já removido
                              return (
                                <tr key={i} className="border-t border-[var(--border)]">
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
                                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/40">
                                        ✅ Aprovado
                                      </span>
                                    ) : desaprovado ? (
                                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold bg-slate-500/15 text-slate-400 border border-slate-500/40">
                                        ⊘ Desaprovado
                                      </span>
                                    ) : (
                                      <div className="flex flex-col gap-1 items-center">
                                        <button
                                          type="button"
                                          onClick={() => handleAprovarF04(c.id_apontada)}
                                          className="text-[10px] font-semibold px-2 py-1 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 transition-colors w-full whitespace-nowrap"
                                        >
                                          ✓ Aprovar apontamento
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => handleDesaprovarF04(c.id_apontada)}
                                          className="text-[10px] font-semibold px-2 py-1 rounded border border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20 transition-colors w-full whitespace-nowrap"
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
                  <div className="rounded-lg border-2 border-rose-500/30 bg-rose-500/5 p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-rose-300 font-bold">🔗 Quebra de continuidade (F05)</span>
                        <span className="opacity-60">
                          {totalF05} fatura{totalF05 > 1 ? 's' : ''} com flag de quebra
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={handleVerificarF05}
                        disabled={verificandoF05}
                        className="text-[11px] font-semibold px-3 py-1.5 rounded border border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20 transition-colors disabled:opacity-70 flex items-center gap-2"
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
                      <div className="mt-2 text-xs text-red-400">{erroF05}</div>
                    )}

                    {resultadoF05 && Array.isArray(resultadoF05.comparacoes) && resultadoF05.comparacoes.length > 0 && (
                      <div className="mt-3 rounded border border-[var(--border)] bg-[var(--bg)] overflow-hidden">
                        <table className="w-full text-xs">
                          <thead className="bg-[var(--bg-secondary)]">
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
                                falso_positivo: { bg: '#10b981', label: '✗ Falso positivo' },
                                quebra_real:    { bg: '#ef4444', label: '⚠ Quebra real' },
                                sem_dados:      { bg: '#94a3b8', label: '? Sem dados' },
                                sem_anterior:   { bg: '#f59e0b', label: '⚠ Sem anterior' },
                              }[c.veredicto] || { bg: '#64748b', label: c.veredicto };
                              const fmtNum = (n) => Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
                              return (
                                <tr key={i} className="border-t border-[var(--border)]">
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
                                      <span className={c.veredicto === 'quebra_real' ? 'text-rose-300 font-semibold' : ''}>
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
              <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]">
                <div className="text-[11px] opacity-60 px-3 py-2 border-b border-[var(--border)] flex items-center gap-3 flex-wrap">
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
                    <thead className="bg-[var(--bg)] sticky top-0">
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
                        return (
                          <tr key={`${d.id || 'h'}-${d.mes}`} className="border-t border-[var(--border)] hover:bg-[var(--bg)]">
                            <td className="px-3 py-2 font-mono whitespace-nowrap">
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
                                <span className="ml-1 text-[10px] text-purple-300" title={`anterior: ${medAnt}`}>
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
                            </td>
                            <td className="px-3 py-2 text-right font-mono">
                              {d.ressarcimentoEst > 0 ? (
                                <span
                                  className="text-emerald-300 font-semibold"
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
                                ? <a href={d.link} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">abrir</a>
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
        className="w-full max-w-3xl bg-[var(--bg)] rounded-xl shadow-2xl flex flex-col border border-[var(--border)]"
        style={{ maxHeight: '92vh' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 rounded-t-xl"
          style={{ background: 'linear-gradient(135deg, #1e3a5f, #0f2340)' }}>
          <div>
            <div className="text-white font-bold text-sm">Análise da IA</div>
            <div className="text-white/50 text-xs font-mono mt-0.5">UC {row.UC} · ID {row.id}</div>
          </div>
          <button onClick={onClose} className="text-white/60 hover:text-white text-xl leading-none px-2">×</button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          {!analise && (
            <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-4 text-sm">
              Nenhuma análise IA disponível. Clique em <strong>Analisar com IA</strong> para iniciar.
            </div>
          )}

          {decisao && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[11px] opacity-60">DECISÃO FINAL · gpt-5.4</div>
                <StatusBadge status={decisao.decisao_final} />
              </div>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <div className="text-[10px] opacity-60">Confiança</div>
                  <div className="font-bold text-blue-400">{decisao.confianca_final ?? 0}%</div>
                </div>
                <div>
                  <div className="text-[10px] opacity-60">Ressarcimento</div>
                  <div className="font-bold text-green-400">{decisao.percentual_ressarcimento ?? 0}%</div>
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
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-2">
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
            <div className="text-sm text-blue-300 flex items-center gap-2">
              <span className="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"/>
              {progresso}
            </div>
          )}
          {error &&<div className="text-sm text-red-400">{error}</div>}
          {success && <div className="text-sm text-green-400">{success}</div>}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-[var(--border)]">
          <button onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-[var(--border)] hover:bg-[var(--bg-secondary)]">
            Fechar
          </button>
          <button onClick={handleReprocessar} disabled={reprocessing}
            className="px-4 py-2 text-sm rounded-lg text-white font-semibold disabled:opacity-50"
            style={{ backgroundColor: '#1e3a5f' }}>
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
    uc: row?.UC ?? '',
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
        className="w-full max-w-2xl bg-[var(--bg)] rounded-xl shadow-2xl flex flex-col border border-[var(--border)]"
        style={{ maxHeight: '92vh' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 rounded-t-xl"
          style={{ background: 'linear-gradient(135deg, #15803d, #052e16)' }}>
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
                className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--bg)] text-sm"
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
                className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--bg)] text-sm"
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
              className="w-full px-3 py-2 text-xs rounded border border-[var(--border)] bg-[var(--bg-secondary)] focus:outline-none focus:ring-1 focus:ring-green-500 font-mono leading-relaxed"
              style={{ whiteSpace: 'pre-wrap' }}
            />
          </div>

          {error && <div className="text-sm text-red-400">{error}</div>}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-[var(--border)]">
          <button onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-[var(--border)] hover:bg-[var(--bg-secondary)]">
            Cancelar
          </button>
          <button onClick={handleSubmit} disabled={saving || !form.uc}
            className="px-4 py-2 text-sm rounded-lg text-white font-semibold disabled:opacity-50"
            style={{ backgroundColor: '#16a34a' }}>
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
        className="w-full px-3 py-2 text-sm rounded border border-[var(--border)] bg-[var(--bg-secondary)] focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Menu de ações por linha
   ──────────────────────────────────────────────────────────────────────────── */

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
      className="fixed z-[9998] w-56 rounded-lg border border-[var(--border)] bg-[var(--bg)] shadow-xl py-1"
      style={{ top: top + 4, left }}
    >
      <button onClick={() => onAction('ia')}
        className="w-full px-3 py-2 text-left text-sm hover:bg-[var(--bg-secondary)] flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400"/>
        Analisar com IA
      </button>
      <button onClick={() => onAction('requisicao')}
        className="w-full px-3 py-2 text-left text-sm hover:bg-[var(--bg-secondary)] flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400"/>
        Abrir Requisição
      </button>
      <button onClick={() => onAction('historico')}
        className="w-full px-3 py-2 text-left text-sm hover:bg-[var(--bg-secondary)] flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-yellow-400"/>
        Ver Histórico (gráfico)
      </button>
      {getRowLink(row) && (
        <>
          <div className="border-t border-[var(--border)] my-1"/>
          <a href={getRowLink(row)} target="_blank" rel="noreferrer"
            className="block px-3 py-2 text-sm hover:bg-[var(--bg-secondary)] text-blue-400">
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

function FiltrosBar({ filtros, setFiltros, ficha, setFicha, fichaCounts, mostrarFicha }) {
  const upd = (k) => (e) => setFiltros({ ...filtros, [k]: e.target.value });
  const clear = () => setFiltros({
    empresa: '', busca: '', valorMin: '', valorMax: '', desvioMin: '', periodoIni: '', periodoFim: '', passibilidade: '',
  });

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3 space-y-2">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
        <input value={filtros.empresa} onChange={upd('empresa')} placeholder="Empresa"
          className="px-2 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--bg)]"/>
        <input value={filtros.busca} onChange={upd('busca')} placeholder="UC / Cliente / Distribuidora"
          className="px-2 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--bg)] col-span-2"/>
        <input value={filtros.valorMin} onChange={upd('valorMin')} placeholder="Valor min" type="number"
          className="px-2 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--bg)]"/>
        <input value={filtros.valorMax} onChange={upd('valorMax')} placeholder="Valor max" type="number"
          className="px-2 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--bg)]"/>
        <input value={filtros.desvioMin} onChange={upd('desvioMin')} placeholder="Desvio min %" type="number"
          className="px-2 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--bg)]"/>
        <button onClick={clear}
          className="px-2 py-1.5 text-xs rounded border border-[var(--border)] hover:bg-[var(--bg)]">
          Limpar
        </button>
      </div>

      {/* ⭐ v19 — Filtro por passibilidade (status computado das colunas v19) */}
      <div className="flex items-center gap-2 pt-1">
        <span className="text-[10px] opacity-50 mr-1">PASSIBILIDADE:</span>
        <select
          value={filtros.passibilidade || ''}
          onChange={upd('passibilidade')}
          className="px-2 py-1 text-[11px] rounded border border-[var(--border)] bg-[var(--bg)] flex-1 max-w-xs"
        >
          <option value="">Todas</option>
          <option value="PARCELAMENTO_SOBREPOSTO">🔴 Parc. sobreposto (único problemático)</option>
          <option value="PASSIVEL_CICLO_INFINITO">🟠 Ciclo infinito Art.113</option>
          <option value="PASSIVEL_ESTATISTICO">🟡 Passível estatístico</option>
          <option value="TEM_PARCELAMENTO">🔵 Tem parcelamento (informativo)</option>
          <option value="COMPENSADO_NEUTRALIZADO">⚪ Compensado (descartar)</option>
          <option value="F02_REVISAR">F02 revisar</option>
          <option value="F01_REVISAR">F01 revisar</option>
          <option value="F04_TROCA_MEDIDOR">F04 troca medidor</option>
        </select>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <input type="month" value={filtros.periodoIni} onChange={upd('periodoIni')} placeholder="Período início"
          className="px-2 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--bg)]"/>
        <input type="month" value={filtros.periodoFim} onChange={upd('periodoFim')} placeholder="Período fim"
          className="px-2 py-1.5 text-xs rounded border border-[var(--border)] bg-[var(--bg)]"/>
      </div>

      {mostrarFicha && (
        <div className="flex flex-wrap gap-1 pt-1 border-t border-[var(--border)]">
          <span className="text-[10px] opacity-50 self-center mr-1">FICHA:</span>
          {FICHAS.map(f => {
            const ativo = ficha === f.id;
            const c = fichaCounts?.[f.id] ?? 0;
            return (
              <button key={f.id} onClick={() => setFicha(f.id)}
                className="px-2 py-0.5 rounded text-[10px] font-bold transition"
                style={{
                  background: ativo ? f.cor : f.cor + '22',
                  color: ativo ? '#fff' : f.cor,
                  border: `1px solid ${f.cor}55`,
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

export default function AnaliseDesvio() {
  const navigate = useNavigate();

  const [tab, setTab] = useState('aprovados');
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
  // ⭐ v19 — linha expandida (uma por vez, com gráfico + tabela UC)
  const [expandedRowId, setExpandedRowId] = useState(null);

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
      case 'ressarcimento': {
        const v = Number(row.RS_Total_Fatura ?? row.valor ?? 0);
        const p = Number(d?.percentual_ressarcimento ?? 0);
        return (v * p) / 100;
      }
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

  const doRejeitar = useCallback(async () => {
    if (!confirmReject) return;
    setRejecting(true);
    try {
      await apiClient.post(`/api/v1/faturas/${confirmReject.id}/rejeitar-fde`, {
        motivo: 'rejeitado pela tela AnaliseDesvio',
      });
      setConfirmReject(null);
      reload();
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
    apiClient
      .get('/api/v1/faturas/fde-analise/empresas', {
        params: { status: STATUS_POR_TAB[tab] },
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
      // empresaSelecionada (sub-aba) tem prioridade sobre filtros.empresa.
      const empresaFinal =
        empresaSelecionada !== 'todos' ? empresaSelecionada : (filtros.empresa || undefined);
      const params = {
        limit: 2000,
        empresa: empresaFinal,
        // Filtra pelo status da decisão (Aprovados/Inconclusivos/Rejeitados)
        status: STATUS_POR_TAB[tab],
        // ⭐ v19 — filtro server-side por passibilidade
        passibilidade: filtros.passibilidade || undefined,
      };

      const res = await apiClient.get('/api/v1/faturas/fde-analise', { params });
      let data = Array.isArray(res.data) ? res.data : (res.data?.rows ?? []);

      // Filtros client-side: busca por texto, valor e período
      const buscaQ = String(filtros.busca || '').trim();
      if (buscaQ) {
        const q = buscaQ.toLowerCase();
        data = data.filter(r =>
          String(r.UC ?? '').toLowerCase().includes(q) ||
          String(r.Concessionaria ?? '').toLowerCase().includes(q) ||
          String(r.RAZAO_SOCIAL ?? '').toLowerCase().includes(q)
        );
      }
      if (filtros.valorMin) data = data.filter(r => Number(r.RS_Total_Fatura ?? 0) >= Number(filtros.valorMin));
      if (filtros.valorMax) data = data.filter(r => Number(r.RS_Total_Fatura ?? 0) <= Number(filtros.valorMax));
      if (filtros.periodoIni) data = data.filter(r => String(r.Mes_Ref ?? '') >= filtros.periodoIni);
      if (filtros.periodoFim) data = data.filter(r => String(r.Mes_Ref ?? '') <= filtros.periodoFim);

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
      if (statusAtual === 'CONFIRMADO') {
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

      setRows(data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Falha ao carregar faturas.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [tab, ficha, filtros, empresaSelecionada]);

  useEffect(() => { reload(); }, [reload]);

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

  // Resumo
  const resumo = useMemo(() => {
    const total = rows.length;
    const valor = rows.reduce((s, r) => s + Number(r.RS_Total_Fatura ?? r.valor ?? 0), 0);
    const ress = rows.reduce((s, r) => {
      const d = getDecisao(r);
      const v = Number(r.RS_Total_Fatura ?? r.valor ?? 0);
      return s + (v * Number(d?.percentual_ressarcimento ?? 0)) / 100;
    }, 0);
    const conf = total
      ? rows.reduce((s, r) => s + Number(getDecisao(r)?.confianca_final ?? 0), 0) / total
      : 0;
    return { total, valor, ress, conf };
  }, [rows]);

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
  }, [menuRow]);

  const tabAtual = TABS.find(t => t.id === tab);

  return (
    <div className="p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Análise de Faturas</h1>
          <div className="text-xs opacity-60 mt-0.5">
            Apontamentos identificados pelas regras + decisão da IA (gpt-5.4)
          </div>
        </div>
        <button onClick={reload}
          className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-700 text-white font-semibold">
          Atualizar
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--border)]">
        {TABS.map(t => {
          const ativo = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className="px-5 py-2.5 text-sm font-semibold border-b-2 transition -mb-px"
              style={{
                borderColor: ativo ? t.cor : 'transparent',
                color: ativo ? t.cor : 'var(--text)',
                opacity: ativo ? 1 : 0.55,
              }}>
              {t.label}
              <span className="ml-1 text-[10px] opacity-60">· {t.sub}</span>
            </button>
          );
        })}
      </div>

      {/* Sub-abas dinâmicas por empresa — populadas pelo backend via
          /api/v1/faturas/fde-analise/empresas?status=... Conforme novas
          empresas tiverem faturas no status atual, aparecem aqui sozinhas. */}
      {empresasDisponiveis.length > 0 && (
        <div className="flex gap-1 flex-wrap text-xs">
          <button
            type="button"
            onClick={() => setEmpresaSelecionada('todos')}
            className="px-3 py-1.5 rounded-full font-semibold transition"
            style={{
              background: empresaSelecionada === 'todos' ? (tabAtual?.cor || '#3b82f6') : 'transparent',
              color: empresaSelecionada === 'todos' ? '#fff' : 'var(--text)',
              border: `1px solid ${empresaSelecionada === 'todos' ? (tabAtual?.cor || '#3b82f6') : 'var(--border)'}`,
              opacity: empresaSelecionada === 'todos' ? 1 : 0.7,
            }}
          >
            Todos
            <span className="ml-1.5 opacity-70">
              ({empresasDisponiveis.reduce((s, e) => s + Number(e.qtd || 0), 0)})
            </span>
          </button>
          {empresasDisponiveis.map((e) => {
            const ativo = String(empresaSelecionada) === String(e.cod_empresa);
            const nomeCurto = e.nome.length > 35 ? e.nome.slice(0, 32) + '…' : e.nome;
            return (
              <button
                key={e.cod_empresa}
                type="button"
                onClick={() => setEmpresaSelecionada(String(e.cod_empresa))}
                title={e.nome}
                className="px-3 py-1.5 rounded-full font-semibold transition whitespace-nowrap"
                style={{
                  background: ativo ? (tabAtual?.cor || '#3b82f6') : 'transparent',
                  color: ativo ? '#fff' : 'var(--text)',
                  border: `1px solid ${ativo ? (tabAtual?.cor || '#3b82f6') : 'var(--border)'}`,
                  opacity: ativo ? 1 : 0.7,
                }}
              >
                <span className="font-mono opacity-80 mr-1">{e.cod_empresa}</span>
                {nomeCurto}
                <span className="ml-1.5 opacity-70">({e.qtd})</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Filtros */}
      <FiltrosBar
        filtros={filtros}
        setFiltros={setFiltros}
        ficha={ficha}
        setFicha={setFicha}
        fichaCounts={fichaCounts}
        mostrarFicha={false}
      />

      {/* Cards resumo */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card label={`Faturas (${tabAtual?.label})`} value={resumo.total} cor={tabAtual?.cor}/>
        <Card label="Valor total das faturas" value={fmtCurrency(resumo.valor)} />
        <Card label="Ressarcimento estimado" value={fmtCurrency(resumo.ress)} cor="#22c55e"/>
        <Card label="Confiança média" value={`${resumo.conf.toFixed(0)}%`} cor="#3b82f6"/>
      </div>

      {/* Tabela */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm opacity-60">Carregando...</div>
        ) : error ? (
          <div className="p-8 text-center text-sm text-red-400">{error}</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm opacity-60">Nenhuma fatura encontrada com esses filtros.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[var(--bg)] border-b border-[var(--border)]">
                <tr>
                  <SortTh col="id"             align="left"   sort={sort} onClick={toggleSort}>ID</SortTh>
                  <SortTh col="uc"             align="left"   sort={sort} onClick={toggleSort}>UC</SortTh>
                  <SortTh col="cliente"        align="left"   sort={sort} onClick={toggleSort}>Cliente</SortTh>
                  <SortTh col="concessionaria" align="left"   sort={sort} onClick={toggleSort}>Concessionária</SortTh>
                  <SortTh col="mes"            align="left"   sort={sort} onClick={toggleSort}>Mês</SortTh>
                  <SortTh col="valor"          align="right"  sort={sort} onClick={toggleSort}>Valor</SortTh>
                  <SortTh col="desvio"         align="right"  sort={sort} onClick={toggleSort}>Desvio %</SortTh>
                  <th className="px-3 py-2 text-left">Fichas</th>
                  <SortTh col="status_ia"     align="center" sort={sort} onClick={toggleSort}>Status</SortTh>
                  <SortTh col="passibilidade" align="center" sort={sort} onClick={toggleSort}>Passibilidade</SortTh>
                  <SortTh col="confianca"     align="right"  sort={sort} onClick={toggleSort}>Confiança</SortTh>
                  <SortTh col="ressarcimento" align="right"  sort={sort} onClick={toggleSort}>Ressarc.</SortTh>
                  <th className="px-3 py-2 text-center w-20">Ações</th>
                  <SortTh col="resultado_em" align="center" sort={sort} onClick={toggleSort}>Analisado em</SortTh>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map(r => {
                  const d = getDecisao(r);
                  const fichas = d?.fichas_confirmadas ?? extractFichas(r.fichas_aplicadas);
                  const valor = Number(r.RS_Total_Fatura ?? r.valor ?? 0);
                  const ress = (valor * Number(d?.percentual_ressarcimento ?? 0)) / 100;
                  const id = r.id;
                  const ucStr = String(r.UC ?? r.uc ?? '').trim();
                  const reqsUC = reqMap[ucStr] ?? [];
                  const temProcesso = reqsUC.length > 0;
                  const reqTooltip = reqsUC
                    .map(req => `#${req.id} · ${req.status}${req.etapa ? ` · ${req.etapa}` : ''}${req.ressarcimento_estimado ? ` · R$ ${Number(req.ressarcimento_estimado).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : ''}`)
                    .join('\n');

                  // Destaque por intensidade do erro:
                  //  vermelho → pico positivo ≥ +80% (forte indicador F02/F03)
                  //  amarelo  → tem flag F02-F05 mas sem pico extremo
                  //  âmbar    → fallback: tem processo aberto (sem flag/pico claro)
                  // Não há linha sem cor aqui porque o filtro já garante que toda
                  // linha tem flag ou pico positivo ≥ +80%.
                  const desvioPositivo = Number(r.desvio_pct_max ?? 0); // pico positivo
                  let rowStyle;
                  if (desvioPositivo >= 80) {
                    rowStyle = { borderLeft: '3px solid #ef4444', backgroundColor: 'rgba(239,68,68,0.10)' };
                  } else if (Array.isArray(fichas) ? fichas.length > 0 : false) {
                    rowStyle = { borderLeft: '3px solid #facc15', backgroundColor: 'rgba(250,204,21,0.07)' };
                  } else if (temProcesso) {
                    rowStyle = { borderLeft: '3px solid #f59e0b', backgroundColor: 'rgba(245,158,11,0.035)' };
                  } else {
                    rowStyle = { borderLeft: '3px solid transparent' };
                  }

                  const isExpanded = expandedRowId === id;
                  return (
                    <Fragment key={id}>
                    <tr
                      className="border-b border-[var(--border)] hover:bg-[var(--bg)] cursor-pointer"
                      style={rowStyle}
                      onClick={(e) => {
                        // não expande se clicou em botão ou link
                        if (e.target.closest('button, a, select, input')) return;
                        setExpandedRowId(isExpanded ? null : id);
                      }}>
                      <td className="px-3 py-2 font-mono text-blue-400">
                        <span className="inline-flex items-center gap-1">
                          <span className="text-[10px] opacity-50">{isExpanded ? '▼' : '▶'}</span>
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
                              style={{ color: '#f59e0b', border: '1px solid rgba(245,158,11,0.6)', backgroundColor: 'rgba(245,158,11,0.12)' }}
                            >ⓘ</button>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2 truncate max-w-[200px]" title={getNomeEmpresa(r)}>
                        {getNomeEmpresa(r)}
                      </td>
                      <td className="px-3 py-2">{r.Concessionaria ?? r.concessionaria ?? '—'}</td>
                      <td className="px-3 py-2 font-mono">{fmtMesRef(r.Mes_Ref ?? r.mes_ref)}</td>
                      <td className="px-3 py-2 text-right">{fmtCurrency(valor)}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        {(() => {
                          const dv = Number(r.desvio_pct_max ?? 0);
                          if (dv === 0) return <span className="opacity-30">—</span>;
                          let cls = 'opacity-70';
                          if (dv >= 80) cls = 'text-red-400 font-semibold';
                          else if (dv >= 30) cls = 'text-amber-400 font-semibold';
                          else if (dv < 0) cls = 'text-slate-400';
                          return <span className={cls}>{dv > 0 ? '+' : ''}{dv.toFixed(0)}%</span>;
                        })()}
                      </td>
                      <td className="px-3 py-2"><FichasBadge fichas={fichas}/></td>
                      <td className="px-3 py-2 text-center"><StatusBadge status={d?.decisao_final}/></td>
                      <td className="px-3 py-2 text-center">
                        <PassibilidadeBadge status={r.status_passibilidade} />
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{d?.confianca_final ?? 0}%</td>
                      <td className="px-3 py-2 text-right text-green-400">{fmtCurrency(ress)}</td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button onClick={(e) => handleClickRow(r, e)}
                            className="px-2 py-1 text-xs rounded bg-blue-600 hover:bg-blue-700 text-white">
                            Ações ▾
                          </button>
                          {d?.decisao_final !== 'REFUTADO' && (
                            <button
                              onClick={(e) => { e.stopPropagation(); setConfirmReject(r); }}
                              title="Rejeitar (mover para REFUTADO)"
                              className="p-1 text-xs rounded text-red-400 hover:text-red-300 hover:bg-red-900/30"
                            >🗑️</button>
                          )}
                        </div>
                      </td>
                      <td
                        className="px-3 py-2 text-center font-mono text-xs whitespace-nowrap"
                        title={r.resultado_em ?? ''}
                      >
                        {r.resultado_em
                          ? fmtDateTime(r.resultado_em)
                          : <span className="opacity-40 italic">aguardando IA</span>}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-b-2 border-blue-500/30 bg-[var(--bg-secondary)]">
                        <td colSpan={13} className="p-0">
                          <LinhaExpandida
                            row={r}
                            onAbrirAnaliseIA={(linhaRow) => setModalIA(linhaRow)}
                            onCriarRequisicao={() => setModalReq(r)}
                            onDescartar={() => setConfirmReject(r)}
                            onFechar={() => setExpandedRowId(null)}
                          />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

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
            className="w-full max-w-md bg-[var(--bg)] rounded-xl shadow-2xl border border-red-900/50"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-[var(--border)] flex items-center gap-2">
              <span className="text-xl">🗑️</span>
              <div>
                <div className="font-bold text-sm">Rejeitar fatura</div>
                <div className="text-xs opacity-60">decisao_final será alterada para REFUTADO</div>
              </div>
            </div>
            <div className="px-5 py-4 text-sm space-y-2">
              {/* ⭐ Flag de processo existente no período */}
              {temProcessoNoPeriodo && (
                <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
                  <div className="flex items-start gap-2">
                    <span className="text-base">⚠️</span>
                    <div className="flex-1 space-y-1">
                      <div className="font-bold text-xs text-amber-300">
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
                <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-2.5">
                  <div className="text-[11px] text-blue-300">
                    ℹ️ UC tem {qtdProcessos} processo(s) anteriores (concluídos/outros períodos)
                  </div>
                </div>
              )}

              <div>Tem certeza que quer rejeitar a fatura abaixo?</div>
              <div className="rounded bg-[var(--bg-secondary)] p-3 text-xs font-mono space-y-1">
                <div>ID: <span className="text-blue-400">{confirmReject.id}</span></div>
                <div>UC: <span className="text-blue-400">{confirmReject.UC ?? confirmReject.uc}</span></div>
                <div>Mês: {fmtMesRef(confirmReject.Mes_Ref ?? confirmReject.mes_ref)}</div>
                <div>Valor: {fmtCurrency(Number(confirmReject.RS_Total_Fatura ?? 0))}</div>
              </div>
              <div className="text-[11px] opacity-60 pt-1">
                A fatura sairá da aba <b>Aprovados</b> e aparecerá em <b>Rejeitados</b>.
                A justificativa humana será atualizada automaticamente.
              </div>
            </div>
            <div className="px-5 py-3 border-t border-[var(--border)] flex justify-end gap-2">
              <button
                onClick={() => setConfirmReject(null)}
                disabled={rejecting}
                className="px-3 py-1.5 text-xs rounded bg-[var(--bg-secondary)] hover:bg-[var(--bg)]"
              >Cancelar</button>
              <button
                onClick={doRejeitar}
                disabled={rejecting}
                className={`px-3 py-1.5 text-xs rounded text-white font-semibold disabled:opacity-50 ${
                  temProcessoNoPeriodo ? 'bg-amber-600 hover:bg-amber-700' : 'bg-red-600 hover:bg-red-700'
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
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 text-[10px] opacity-60">
        Carregando histórico de reanálises...
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 text-[10px] opacity-50">
        📜 Nenhuma reanálise registrada ainda. Cada vez que você clicar em "Reanalisar com IA",
        a decisão será preservada aqui (audit trail).
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 space-y-2">
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
              className={`rounded border ${idx === 0 ? 'border-blue-500/40 bg-blue-500/5' : 'border-[var(--border)] bg-[var(--bg-secondary)]'}`}
            >
              <button
                onClick={() => setExpandido(isOpen ? null : r.id)}
                className="w-full px-3 py-2 text-left flex items-center justify-between gap-3 hover:bg-[var(--bg)]"
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
                <div className="px-3 py-2 border-t border-[var(--border)] text-[11px] space-y-2">
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

/* ────────────────────────────────────────────────────────────────────────────
   ⭐ v19 — LinhaExpandida: gráfico + tabela todos meses UC + ações
   ──────────────────────────────────────────────────────────────────────────── */

function LinhaExpandida({ row, onAbrirAnaliseIA, onCriarRequisicao, onDescartar, onFechar }) {
  const [meses, setMeses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const uc = String(row.UC ?? row.uc ?? '').trim();

  useEffect(() => {
    let cancel = false;
    setLoading(true); setError('');
    apiClient.get('/api/v1/faturas/fde-uc-historico', { params: { uc } })
      .then(res => {
        if (cancel) return;
        // Endpoint retorna array direto OU { rows: [...] } / { meses: [...] }
        const raw = res.data;
        const arr = Array.isArray(raw)
          ? raw
          : (Array.isArray(raw?.rows) ? raw.rows
            : (Array.isArray(raw?.meses) ? raw.meses
              : (Array.isArray(raw?.data) ? raw.data : [])));
        // Normaliza campos: backend usa CamelCase compat (Mes_Ref, KWH_Total, RS_Total_Fatura)
        const norm = arr.map(m => ({
          id:                 m.id,
          mes:                m.mes ?? m.Mes_Ref ?? m.mes_ref ?? '',
          kwh:                Number(m.KWH_Total ?? m.kwh_confirmado ?? m.kwh_historico ?? m.kwh_total ?? m.kwh ?? 0),
          valor:              Number(m.RS_Total_Fatura ?? m.valor ?? m.valor_total ?? 0),
          fichas_aplicadas:   m.fichas_aplicadas ?? '',
          fichas_confirmadas: m.fichas_confirmadas ?? '[]',
          decisao_final:      m.decisao_final ?? '',
          link:               m.Link ?? m.link ?? '',
          flag_f01:           Number(m.flag_f01 ?? 0),
          flag_f02:           Number(m.flag_f02 ?? 0),
          flag_f03:           Number(m.flag_f03 ?? 0),
          flag_f04:           Number(m.flag_f04 ?? 0),
          flag_f05:           Number(m.flag_f05 ?? 0),
          fonte:              m.fonte ?? '',
          tarifa_kwh:         m.tarifa_kwh ?? 0,
          ressarcimento_estimado: m.ressarcimento_estimado ?? 0,
          numero_fatura:      m.numero_fatura ?? '',
          medidor:            m.medidor ?? '',
          _raw:               m,
        }));
        // Ordena por mês decrescente (mais recente primeiro)
        norm.sort((a, b) => String(b.mes).localeCompare(String(a.mes)));
        setMeses(norm);
      })
      .catch(err => { if (!cancel) setError(err?.message || 'Erro ao buscar histórico'); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [uc]);

  // Dados do gráfico — Recharts ComposedChart
  const dadosGrafico = useMemo(() => {
    return meses
      .filter(m => m.kwh > 0 || m.valor > 0)
      .map(m => ({
        mes: fmtMesRef(m.mes),
        kwh: m.kwh,
        valor: m.valor,
      }))
      .reverse(); // gráfico cresce da esquerda (mais antigo) para a direita (mais recente)
  }, [meses]);

  // ⭐ Mediana de consumo (robusta a outliers) — para detectar FP de F02
  const medianaKwh = useMemo(() => {
    const vals = meses
      .map(m => Number(m.kwh))
      .filter(v => v > 200) // exclui MIN (≤200 kWh = leitura forçada)
      .sort((a, b) => a - b);
    if (vals.length === 0) return 0;
    const mid = Math.floor(vals.length / 2);
    return vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid];
  }, [meses]);

  // Função auxiliar: este mês tem F02 mas está dentro de ±30% da mediana? = FP provável
  const isFalsoPositivoF02 = useCallback((m, fichasArr) => {
    if (medianaKwh === 0) return false;
    const temF02 = fichasArr.some(f => String(f).toUpperCase() === 'F02');
    if (!temF02) return false;
    const desvio = Math.abs(m.kwh - medianaKwh) / medianaKwh;
    return desvio < 0.30; // dentro de ±30% da mediana = consumo normal
  }, [medianaKwh]);

  return (
    <div className="p-4 space-y-3 border-l-4 border-blue-500/60">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold flex items-center gap-2">
          <span className="text-blue-400">📊 UC {uc}</span>
          <span className="opacity-50 text-xs">— histórico completo · {meses.length} meses</span>
        </div>
        <button onClick={onFechar} className="text-xs opacity-60 hover:opacity-100">✕ fechar</button>
      </div>

      {loading && <div className="text-center text-xs opacity-60 py-4">Carregando histórico...</div>}
      {error && <div className="text-center text-xs text-red-400 py-4">{error}</div>}

      {!loading && !error && (
        <>
          {/* Gráfico de consumo + valor */}
          {dadosGrafico.length > 0 && (
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg)] p-2">
              <div className="text-[10px] uppercase tracking-wider opacity-60 mb-2">
                Evolução mensal · consumo (kWh) e valor (R$)
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <ComposedChart data={dadosGrafico}>
                  <CartesianGrid stroke="#3f3f46" strokeDasharray="3 3" />
                  <XAxis dataKey="mes" tick={{ fontSize: 10 }} />
                  <YAxis yAxisId="kwh" orientation="left" tick={{ fontSize: 10 }} />
                  <YAxis yAxisId="rs" orientation="right" tick={{ fontSize: 10 }} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', fontSize: 11 }}
                    formatter={(value, name) => name === 'valor'
                      ? [fmtCurrency(value), 'Valor']
                      : [Number(value).toLocaleString('pt-BR'), 'kWh']}
                  />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar yAxisId="kwh" dataKey="kwh" fill="#3b82f6" name="kWh" />
                  <Line yAxisId="rs" dataKey="valor" stroke="#22c55e" strokeWidth={2} name="valor" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Tabela de todos os meses */}
          <div className="rounded-md border border-[var(--border)] bg-[var(--bg)] overflow-hidden">
            <div className="text-[10px] uppercase tracking-wider opacity-60 px-2 pt-2 pb-1 flex items-center justify-between">
              <span>Todos os meses da UC ({meses.length})</span>
              {medianaKwh > 0 && (
                <span className="text-[9px] opacity-80">
                  📐 mediana saudável: <b>{medianaKwh.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kWh</b>
                  <span className="text-amber-300 ml-2">⚠ FP? = F02 dentro de ±30% da mediana</span>
                </span>
              )}
            </div>
            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="w-full text-xs" style={{ tableLayout: 'auto' }}>
                <thead className="bg-[var(--bg-secondary)] sticky top-0 z-10">
                  <tr>
                    <th className="px-2 py-1 text-left font-semibold whitespace-nowrap" style={{ width: '14%' }}>Mês</th>
                    <th className="px-2 py-1 text-right font-semibold whitespace-nowrap" style={{ width: '20%' }}>Consumo (kWh)</th>
                    <th className="px-2 py-1 text-right font-semibold whitespace-nowrap" style={{ width: '20%' }}>Valor (R$)</th>
                    <th className="px-2 py-1 text-center font-semibold whitespace-nowrap" style={{ width: '20%' }}>Apontamento</th>
                    <th className="px-2 py-1 text-center font-semibold whitespace-nowrap" style={{ width: '26%' }}>Resultado IA</th>
                  </tr>
                </thead>
                <tbody>
                  {meses.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-xs opacity-60">
                        Nenhuma fatura encontrada para esta UC.
                      </td>
                    </tr>
                  )}
                  {meses.map(m => {
                    // Parse fichas confirmadas (string JSON OU array)
                    let fichas = [];
                    try {
                      const fc = m.fichas_confirmadas;
                      if (Array.isArray(fc)) fichas = fc;
                      else if (typeof fc === 'string' && fc.trim().startsWith('[')) fichas = JSON.parse(fc);
                    } catch { fichas = []; }
                    // Fallback: extrai do fichas_aplicadas (string "F02 | F03")
                    if (fichas.length === 0 && typeof m.fichas_aplicadas === 'string') {
                      fichas = (m.fichas_aplicadas.match(/F0[1-5]/g)) ?? [];
                    }
                    // Outro fallback: pelas flags (motor SQL)
                    if (fichas.length === 0) {
                      if (m.flag_f01) fichas.push('F01');
                      if (m.flag_f02) fichas.push('F02');
                      if (m.flag_f03) fichas.push('F03');
                      if (m.flag_f04) fichas.push('F04');
                      if (m.flag_f05) fichas.push('F05');
                    }

                    const temAnalise = !!m.decisao_final;
                    const isAtual = m.id && Number(m.id) === Number(row.id);

                    return (
                      <tr key={m.id ?? m.mes}
                          className={`border-t border-[var(--border)]/40 ${isAtual ? 'bg-blue-500/10' : 'hover:bg-[var(--bg-secondary)]/50'}`}>
                        <td className="px-2 py-1 font-mono whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            {m.link ? (
                              <a
                                href={m.link}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-blue-300 hover:text-blue-200 hover:underline"
                                title="Abrir PDF da fatura"
                              >
                                {fmtMesRef(m.mes)}
                              </a>
                            ) : (
                              <span>{fmtMesRef(m.mes)}</span>
                            )}
                            {m.link && (
                              <a
                                href={m.link}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-[10px] opacity-60 hover:opacity-100"
                                title="Abrir PDF em nova aba"
                              >📄</a>
                            )}
                            {isAtual && <span className="text-[9px] text-blue-400">●atual</span>}
                            {m.fonte === 'historico' && <span className="text-[9px] opacity-50 italic">(hist)</span>}
                          </span>
                        </td>
                        <td className="px-2 py-1 text-right font-mono">
                          {m.kwh > 0 ? m.kwh.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : <span className="opacity-30">—</span>}
                        </td>
                        <td className="px-2 py-1 text-right font-mono">
                          {m.valor > 0 ? fmtCurrency(m.valor) : <span className="opacity-30">—</span>}
                        </td>
                        <td className="px-2 py-1 text-center">
                          {fichas.length > 0 ? (
                            <div className="inline-flex items-center gap-1">
                              <FichasBadge fichas={fichas} />
                              {isFalsoPositivoF02(m, fichas) && (
                                <span
                                  title={`Provável falso positivo: consumo ${m.kwh.toLocaleString('pt-BR')} kWh está dentro de ±30% da mediana ${medianaKwh.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kWh`}
                                  className="text-[9px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-1"
                                >⚠ FP?</span>
                              )}
                            </div>
                          ) : <span className="opacity-30">—</span>}
                        </td>
                        <td className="px-2 py-1 text-center">
                          {temAnalise ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onAbrirAnaliseIA({
                                  id: m.id,
                                  UC: uc,
                                  Mes_Ref: m.mes,
                                  RS_Total_Fatura: m.valor,
                                  fichas_aplicadas: m.fichas_aplicadas,
                                  Link: m.link,
                                  resultado_analises: { ia_opus_5_4_decisao: null },
                                  ...m._raw,
                                });
                              }}
                              className="px-1 py-0.5 rounded hover:opacity-80"
                              title="Ver análise completa da IA"
                            >
                              <StatusBadge status={m.decisao_final}/>
                            </button>
                          ) : (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!m.id) {
                                  alert('Esta fatura ainda não tem ID na FDE — não dá para analisar isolada.');
                                  return;
                                }
                                onAbrirAnaliseIA({
                                  id: m.id, UC: uc, Mes_Ref: m.mes, RS_Total_Fatura: m.valor, Link: m.link, ...m._raw,
                                });
                              }}
                              disabled={!m.id}
                              className="px-2 py-0.5 rounded text-[10px] border bg-amber-500/10 text-amber-300 border-amber-500/30 hover:bg-amber-500/20 disabled:opacity-30 disabled:cursor-not-allowed"
                              title={m.id ? 'Esta fatura ainda não foi analisada — clique para rodar IA' : 'Sem fatura própria neste mês (só histórico)'}
                            >
                              🤖 Analisar com IA
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Botões de ação */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border)]">
            <button
              onClick={onDescartar}
              className="px-3 py-1.5 text-xs rounded border border-red-500/40 text-red-400 hover:bg-red-500/10"
            >
              🗑️ Descartar processo
            </button>
            <button
              onClick={onCriarRequisicao}
              className="px-3 py-1.5 text-xs rounded bg-green-600 hover:bg-green-700 text-white font-semibold"
            >
              📋 Criar requisição
            </button>
          </div>
        </>
      )}
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
      className={`px-3 py-2 ${alignCls} cursor-pointer select-none hover:bg-[var(--bg-secondary)] transition`}
      title={`Ordenar por ${typeof children === 'string' ? children : col}`}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        <span className={`text-[10px] ${ativo ? 'opacity-100 text-blue-400' : 'opacity-30'}`}>{seta}</span>
      </span>
    </th>
  );
}

function Card({ label, value, cor }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
      <div className="text-[10px] opacity-60 uppercase tracking-wider mb-1">{label}</div>
      <div className="text-xl font-bold" style={{ color: cor || 'inherit' }}>{value}</div>
    </div>
  );
}
