// Protocolos ANEEL — helpers compartilhados (Controle de Processos, histórico do processo, página própria).

export const SITUACOES_ANEEL = [
  'Registrado na ANEEL',
  'Resposta da ANEEL',
  'Prazo da distribuidora encerrado',
  // lidas no site da ANEEL (Meus Registros)
  'Em análise na concessionária',
  'Em análise na ANEEL',
  'Concluída na ANEEL',
];

// cor do chip (classes cpv2-chip do Controle de Processos)
export function chipSituacaoAneel(situacao) {
  if (situacao === 'Resposta da ANEEL') return 'cpv2-chip cpv2-chip--warning';
  if (situacao === 'Prazo da distribuidora encerrado') return 'cpv2-chip cpv2-chip--danger';
  if (situacao === 'Registrado na ANEEL' || situacao?.startsWith('Em análise')) return 'cpv2-chip cpv2-chip--info';
  if (situacao === 'Concluída na ANEEL') return 'cpv2-chip cpv2-chip--success';
  return 'cpv2-chip cpv2-chip--neutral';
}

// a ANEEL concluiu o protocolo (respondeu por e-mail ou consta como concluída no site)
export function aneelConcluida(situacao) {
  return situacao === 'Resposta da ANEEL' || situacao === 'Concluída na ANEEL';
}

// aviso de "mudou na ANEEL": só quando a mudança foi a conclusão
export function mudouAneelRecente(info, dias) {
  if (!info?.ultima_mudanca_em || !aneelConcluida(info.situacao)) return false;
  return Date.now() - new Date(info.ultima_mudanca_em).getTime() <= dias * 86400000;
}

export function formatarProtocolo(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length !== 13) return v;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 11)}-${d.slice(11)}`;
}

export function protocoloValido(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length === 13 && d.startsWith('010');
}
