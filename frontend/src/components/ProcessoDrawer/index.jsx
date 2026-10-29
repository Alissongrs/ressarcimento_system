// src/components/ProcessoDrawer/index.jsx
// Drawer lateral com 7 abas: Resumo, Histórico, Anexos, Deferimento, Faturamento, Repasse, Encerramento.
// Gating: só a aba correspondente à etapa_atual é editável; demais ficam read-only.

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X, ArrowRight } from 'lucide-react';
import {
  getProcesso,
  getHistorico,
  getAnexos,
  getDeferimento,
  getFaturamento,
  getRepasse,
  getEncerramento,
} from '../../services/processoV2Service.js';
import { getEmailsByProcessoID } from '../../services/requisicaoService';
import TabResumo from './TabResumo.jsx';
import TabHistorico from './TabHistorico.jsx';
import TabEmails from './TabEmails.jsx';
import TabAnexos from './TabAnexos.jsx';
import TabDeferimento from './TabDeferimento.jsx';
import TabFaturamento from './TabFaturamento.jsx';
import TabRepasse from './TabRepasse.jsx';
import TabEncerramento from './TabEncerramento.jsx';

// ----- gating de edição por etapa atual (id_etapa de 1..6) -----
// Matriz de liberação (confirmada 02/07/2026):
//   - Deferimento: editável quando id_aprovacao_atual = 1 (Deferido)
//   - Faturamento: etapa atingida (etapa_atual >= 4)
//   - Repasse:     etapa atingida (etapa_atual >= 5)
//   - Encerramento: etapa atingida (etapa_atual = 6) OU Indeferido (aprov=2, força ir pra encerramento)
//
// Abas sempre continuam editáveis depois de passar pela etapa (não trava retroativamente
// pra permitir correção). Encerramento em particular NÃO trava depois de encerrar.
function editavelPorAba(abaKey, etapaAtualId, aprovacaoAtualId) {
  if (etapaAtualId == null) return false;
  const aprov = Number(aprovacaoAtualId) || 0;
  const deferido = aprov === 1;
  const indeferido = aprov === 2;
  switch (abaKey) {
    case 'deferimento':
      return deferido;
    case 'faturamento':
      return etapaAtualId >= 4;
    case 'repasse':
      return etapaAtualId >= 5;
    case 'encerramento':
      return etapaAtualId >= 6 || indeferido;
    default:
      return false; // resumo/historico/anexos não são editáveis aqui
  }
}

// ----- gating de acesso à aba (clicar/abrir). True = acessível -----
// Usuário sempre CONSEGUE clicar e VER (readonly) — o gating aqui é só pra manter
// simetria com editavelPorAba. Se quisermos desabilitar cliques, mudar pra false.
function abaAcessivel(abaKey /*, etapaAtualId, aprovacaoAtualId */) {
  return true;
}

const ABAS = [
  { key: 'resumo', label: 'Resumo' },
  { key: 'historico', label: 'Histórico', countKey: 'historico' },
  { key: 'emails', label: 'E-mails', countKey: 'emails' },
  { key: 'anexos', label: 'Anexos', countKey: 'anexos' },
  { key: 'deferimento', label: 'Deferimento' },
  { key: 'faturamento', label: 'Faturamento', countKey: 'faturamento' },
  { key: 'repasse', label: 'Repasse', countKey: 'repasse' },
  { key: 'encerramento', label: 'Encerramento' },
];

function chipClassInst(nome) {
  if (!nome) return 'cpv2-chip cpv2-chip--warning';
  return (
    {
      Distribuidora: 'cpv2-chip cpv2-chip--brand',
      Ouvidoria: 'cpv2-chip cpv2-chip--info',
      ANEEL: 'cpv2-chip cpv2-chip--info',
      SMA: 'cpv2-chip cpv2-chip--purple',
    }[nome] || 'cpv2-chip cpv2-chip--info'
  );
}

function chipClassStatus(nome) {
  return (
    {
      'Em análise': 'cpv2-chip cpv2-chip--info',
      'Em elaboração': 'cpv2-chip cpv2-chip--info',
      'Aguardando retorno': 'cpv2-chip cpv2-chip--warning',
      Pendente: 'cpv2-chip cpv2-chip--warning',
      Suspenso: 'cpv2-chip cpv2-chip--neutral',
      Cancelado: 'cpv2-chip cpv2-chip--danger',
      Encerrado: 'cpv2-chip cpv2-chip--success',
    }[nome] || 'cpv2-chip cpv2-chip--neutral'
  );
}

export default function ProcessoDrawer({
  idProcesso,
  onClose,
  onMovimentar,
  onToast,
  inline = false, // true = renderiza como página (sem portal/backdrop/posição fixa)
}) {
  const [aba, setAba] = useState('resumo');
  const qc = useQueryClient();

  // Esc fecha (apenas no modo drawer/modal)
  useEffect(() => {
    if (inline) return undefined;
    const handler = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', handler);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handler);
      document.body.style.overflow = '';
    };
  }, [onClose, inline]);

  const detalheQ = useQuery({
    queryKey: ['v2', 'processo', idProcesso],
    queryFn: () => getProcesso(idProcesso),
    enabled: idProcesso != null,
  });
  const detalhe = detalheQ.data;
  const etapaId = detalhe?.etapa_atual?.id;
  const aprovacaoId = detalhe?.aprovacao_atual?.id;

  // Pré-carrega contagens p/ as tabs (histórico, anexos, faturamento, repasse)
  const histQ = useQuery({
    queryKey: ['v2', 'historico', idProcesso],
    queryFn: () => getHistorico(idProcesso),
    enabled: idProcesso != null,
  });
  const emailsQ = useQuery({
    queryKey: ['v2', 'emails', idProcesso],
    queryFn: () => getEmailsByProcessoID(idProcesso),
    enabled: idProcesso != null,
  });
  const anexosQ = useQuery({
    queryKey: ['v2', 'anexos', idProcesso],
    queryFn: () => getAnexos(idProcesso),
    enabled: idProcesso != null,
  });
  const fatQ = useQuery({
    queryKey: ['v2', 'faturamento', idProcesso],
    queryFn: () => getFaturamento(idProcesso),
    enabled: idProcesso != null,
  });
  const repQ = useQuery({
    queryKey: ['v2', 'repasse', idProcesso],
    queryFn: () => getRepasse(idProcesso),
    enabled: idProcesso != null,
  });
  const defQ = useQuery({
    queryKey: ['v2', 'deferimento', idProcesso],
    queryFn: () => getDeferimento(idProcesso),
    enabled: idProcesso != null,
  });
  const encQ = useQuery({
    queryKey: ['v2', 'encerramento', idProcesso],
    queryFn: () => getEncerramento(idProcesso),
    enabled: idProcesso != null,
  });

  const counts = useMemo(() => {
    return {
      historico: histQ.data?.items?.length ?? detalhe?.counts?.historico ?? 0,
      emails: (Array.isArray(emailsQ.data) ? emailsQ.data.length : 0),
      anexos: anexosQ.data?.items?.length ?? detalhe?.counts?.anexos ?? 0,
      faturamento: fatQ.data?.items?.length ?? detalhe?.counts?.faturamento ?? 0,
      repasse: repQ.data?.items?.length ?? detalhe?.counts?.repasse ?? 0,
    };
  }, [
    histQ.data,
    emailsQ.data,
    anexosQ.data,
    fatQ.data,
    repQ.data,
    detalhe?.counts,
  ]);

  const conteudo = (
    // Portal renderiza fora do .cpv2-root da página → envolvemos pra herdar as variáveis CSS.
    // Em modo inline (rota dedicada), não renderiza backdrop nem usa position fixed.
    <div className="cpv2-root">
      {!inline && <div className="cpv2-drawer-backdrop" onClick={onClose} />}
      <aside
        className={`cpv2-drawer${inline ? ' cpv2-drawer--inline' : ''}`}
        role={inline ? 'region' : 'dialog'}
        aria-modal={inline ? undefined : 'true'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cpv2-drawer__head">
          <div className="cpv2-drawer__top">
            <div style={{ minWidth: 0 }}>
              <div className="cpv2-drawer__id">
                {detalhe?.codigo_publico || `Processo #${idProcesso}`}
              </div>
              <div className="cpv2-drawer__cliente">
                {detalhe?.cliente?.razao_social || '—'}
              </div>
              <div className="cpv2-drawer__dist">
                {detalhe
                  ? ([
                      detalhe.distribuidora?.nome,
                      detalhe.uc?.uf,
                      detalhe.uc?.codigo_uc ? `UC ${detalhe.uc.codigo_uc}` : '',
                      detalhe.cliente?.cnpj_cpf_mascarado ? `CNPJ ${detalhe.cliente.cnpj_cpf_mascarado}` : '',
                    ]
                      .map((s) => String(s || '').trim())
                      .filter(Boolean)
                      .join(' · '))
                  : ''}
              </div>
            </div>
            {!inline && (
              <button
                type="button"
                className="cpv2-drawer__close"
                onClick={onClose}
                aria-label="Fechar"
              >
                <X size={20} />
              </button>
            )}
          </div>
          {detalhe && (
            <div className="cpv2-drawer__chips">
              {detalhe.instancia_atual && (
                <span className={`${chipClassInst(detalhe.instancia_atual?.nome)} cpv2-chip--lg`}>
                  <span className="cpv2-chip__dot" />
                  {detalhe.instancia_atual.nome}
                </span>
              )}
              {!detalhe.instancia_atual && (
                <span className="cpv2-chip cpv2-chip--lg cpv2-chip--warning">
                  <span className="cpv2-chip__dot" />
                  Pós-Deferimento
                </span>
              )}
              {detalhe.etapa_atual && (
                <span className="cpv2-chip cpv2-chip--lg cpv2-chip--neutral">
                  <span className="cpv2-chip__dot" />
                  {detalhe.etapa_atual.nome}
                </span>
              )}
              {detalhe.status_atual && (
                <span className={`${chipClassStatus(detalhe.status_atual?.nome)} cpv2-chip--lg`}>
                  <span className="cpv2-chip__dot" />
                  {detalhe.status_atual.nome}
                </span>
              )}
              {detalhe.aprovacao_atual && (
                <span
                  className={`cpv2-chip cpv2-chip--lg ${
                    detalhe.aprovacao_atual.id === 1
                      ? 'cpv2-chip--aprov'
                      : 'cpv2-chip--reprov'
                  }`}
                >
                  <span className="cpv2-chip__dot" />
                  {detalhe.aprovacao_atual.nome}
                </span>
              )}
              {detalhe.prioridade && (
                <span className="cpv2-chip cpv2-chip--lg cpv2-chip--neutral">
                  Prioridade {detalhe.prioridade.nome}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="cpv2-drawer__actions">
          <button
            type="button"
            className="cpv2-btn cpv2-btn--primary"
            onClick={() =>
              detalhe &&
              onMovimentar?.({
                id_processo: detalhe.id_processo,
                codigo_publico: detalhe.codigo_publico,
                cliente: detalhe.cliente?.razao_social,
                etapa: detalhe.etapa_atual,
                instancia: detalhe.instancia_atual,
                status: detalhe.status_atual,
                aprovacao: detalhe.aprovacao_atual,
              })
            }
            disabled={!detalhe}
          >
            <ArrowRight size={13} /> Movimentar
          </button>
        </div>

        <nav className="cpv2-drawer__tabs">
          {ABAS.map((a) => {
            const editavel = editavelPorAba(a.key, etapaId, aprovacaoId);
            const acessivel = abaAcessivel(a.key, etapaId, aprovacaoId);
            return (
              <button
                key={a.key}
                type="button"
                disabled={!acessivel}
                className={`cpv2-drawer__tab ${aba === a.key ? 'is-active' : ''} ${
                  !acessivel ? 'cpv2-drawer__tab--blocked' :
                  ['deferimento', 'faturamento', 'repasse', 'encerramento'].includes(
                    a.key,
                  ) && !editavel
                    ? 'cpv2-drawer__tab--readonly'
                    : ''
                }`}
                onClick={() => acessivel && setAba(a.key)}
                title={
                  !acessivel
                    ? `Disponível apenas quando o processo for movido para ${
                        a.key === 'repasse' ? 'Repasse'
                        : a.key === 'encerramento' ? 'Encerramento'
                        : 'Faturamento'
                      }`
                    : ['deferimento', 'faturamento', 'repasse', 'encerramento'].includes(
                          a.key,
                        )
                      ? editavel
                        ? 'Editável (etapa atual)'
                        : 'Somente leitura (etapa diferente)'
                      : undefined
                }
              >
                {a.label}
                {a.countKey != null && (
                  <span className="cpv2-tab__count">{counts[a.countKey] ?? 0}</span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="cpv2-drawer__body">
          {detalheQ.isLoading && (
            <div className="cpv2-empty">
              <h4>Carregando…</h4>
            </div>
          )}
          {detalheQ.isError && (
            <div className="cpv2-empty cpv2-empty--error">
              <h4>Falha ao carregar processo</h4>
              <p>{detalheQ.error?.message || 'Erro desconhecido.'}</p>
            </div>
          )}

          {detalhe && (
            <>
              {aba === 'resumo' && <TabResumo detalhe={detalhe} />}
              {aba === 'historico' && (
                <TabHistorico
                  itens={histQ.data?.items || []}
                  isLoading={histQ.isLoading}
                  idProcesso={idProcesso}
                  anexos={anexosQ.data?.items || []}
                  onToast={onToast}
                />
              )}
              {aba === 'emails' && (
                <TabEmails
                  itens={emailsQ.data || []}
                  isLoading={emailsQ.isLoading}
                />
              )}
              {aba === 'anexos' && (
                <TabAnexos
                  itens={anexosQ.data?.items || []}
                  isLoading={anexosQ.isLoading}
                  idProcesso={idProcesso}
                  linkFatura={detalhe?.link_fatura}
                  onToast={onToast}
                />
              )}
              {aba === 'deferimento' && (
                <TabDeferimento
                  idProcesso={idProcesso}
                  deferimento={defQ.data}
                  isLoading={defQ.isLoading}
                  editavel={editavelPorAba('deferimento', etapaId, aprovacaoId)}
                  detalhe={detalhe}
                  onToast={onToast}
                />
              )}
              {aba === 'faturamento' && (
                <TabFaturamento
                  idProcesso={idProcesso}
                  itens={fatQ.data?.items || []}
                  isLoading={fatQ.isLoading}
                  editavel={editavelPorAba('faturamento', etapaId, aprovacaoId)}
                  detalhe={detalhe}
                  onToast={onToast}
                />
              )}
              {aba === 'repasse' && (
                <TabRepasse
                  idProcesso={idProcesso}
                  itens={repQ.data?.items || []}
                  isLoading={repQ.isLoading}
                  editavel={editavelPorAba('repasse', etapaId, aprovacaoId)}
                  detalhe={detalhe}
                  onToast={onToast}
                />
              )}
              {aba === 'encerramento' && (
                <TabEncerramento
                  idProcesso={idProcesso}
                  encerramento={encQ.data}
                  isLoading={encQ.isLoading}
                  editavel={editavelPorAba('encerramento', etapaId, aprovacaoId)}
                  detalhe={detalhe}
                  onToast={onToast}
                />
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );

  return inline ? conteudo : createPortal(conteudo, document.body);
}
