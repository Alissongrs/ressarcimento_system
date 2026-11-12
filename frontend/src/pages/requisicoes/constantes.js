// src/pages/requisicoes/constantes.js — extraído de Requisicoes.jsx em 12/11/2026 (melhoria 2: arquivos menores).
// Conteúdo idêntico ao original; só mudou de arquivo e ganhou export/import.



// =======================
// CONSTANTES & CONFIG
// =======================
export const ETAPA_TABS = [
  { id: 'ATIVOS', label: 'Ativos', etapa: 'ATIVOS' },
  { id: 'DEFERIDOS', label: 'Deferidos', etapa: 'DEFERIDOS' },
  { id: 'FLUXO', label: 'Fluxo de Ressarcimento', etapa: 'FLUXO DE RESSARCIMENTO' },
  { id: 'FATURAMENTO', label: 'Faturamento', etapa: 'FATURAMENTO' },
  { id: 'CONCLUIDOS', label: 'Concluídos', etapa: 'CONCLUIDOS' },
  { id: 'INDEFERIDOS', label: 'Indeferidos', etapa: 'INDEFERIDOS' },
  { id: 'SUSPENSOS', label: 'Suspensos', etapa: 'SUSPENSOS' },
];

export const KANBAN_COLUNAS = ETAPA_TABS.map((t) => t.label);

export const MAPA_COLUNAS_PARA_ETAPAS = {
  Ativos: 'Distribuidora',
  Deferidos: 'Distribuidora',
  'Fluxo de Ressarcimento': 'Enviado ao Financeiro',
  Faturamento: 'Repasse Amee',
  'Concluídos': 'Concluído',
  Indeferidos: 'Indeferido',
  Suspensos: '',
};

export const KANBAN_ETAPAS = {
  Ativos: ['Distribuidora', 'Ouvidoria', 'ANEEL', 'SMA'],
  Deferidos: ['Distribuidora', 'Ouvidoria', 'ANEEL', 'SMA'],
  'Fluxo de Ressarcimento': ['Enviado ao Financeiro'],
  Faturamento: ['Repasse Amee'],
  'Concluídos': ['Concluído'],
  Indeferidos: ['Indeferido'],
  Suspensos: [],
};

export const DEFAULT_CANAIS = {
  whatsapp: false,
  ligacao: false,
  email: false,
  sms: false,
  site: false,
  pessoal: false,
};

export const EMAIL_EDITOR_MODULES = {
  toolbar: [
    ['bold', 'italic', 'underline', 'strike'],
    [{ list: 'ordered' }, { list: 'bullet' }],
    [{ align: [] }],
    ['link'],
    ['clean'],
  ],
};

export const CANAIS_UI = [
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'ligacao', label: 'Ligação' },
  { key: 'email', label: 'E-mail' },
  { key: 'sms', label: 'SMS' },
  { key: 'site', label: 'Site' },
  { key: 'pessoal', label: 'Pessoal' },
];

export const RESUMO_PROMPT_VERSION = 'ressarcimento_v1';

// TROCA AQUI: antes estava 0 (load more nunca funcionava)
export const INITIAL_COLUMN_LIMIT = 200;
