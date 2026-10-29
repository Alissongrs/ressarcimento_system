// MovimentarModal — modal "Movimentar processo".
// Ordem dos campos: 1.Etapa · 2.Instância · 3.Status · 4.Aprovação · 5.Comentário · 6.Anexo (opcional)
//
// Regras client:
// - Etapas pós-deferimento (4..6) não exigem instância (vira null).
// - Etapa só pode ser igual ou adjacente à atual (gate do server espelhado aqui).
// - Encerramento (6) exige Aprovação.
// - Indeferido pode ser marcado a qualquer momento.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Info, Save, AlertCircle, Paperclip } from 'lucide-react';
import { useDimensoesV2 } from '../../hooks/useDimensoesV2.js';
import { movimentar, uploadAnexo } from '../../services/processoV2Service.js';

const POSDEF_IDS = new Set([4, 5, 6]); // Faturamento, Repasse, Encerramento

// Regras de combinação (aprovação, instância) → etapas válidas + status por etapa.
// IDs:
//   Aprovação:  null = pré-def · 1 = Deferido · 2 = Indeferido (livre — só Encerramento)
//   Instâncias: 1=Distribuidora, 2=Ouvidoria, 3=ANEEL, 4=SMA
//   Etapas:     1=Reclamação, 2=Contestação, 3=Conciliação (4-6 pós-def, sem instância)
//   Status:     1=Em análise, 2=Em elaboração, 3=Aguardando retorno, 4=Pendente
const REGRAS_FLUXO = {
  // PRÉ-DEFERIMENTO
  'null:1': { etapas: [1],    statusPorEtapa: { 1: [3, 1, 4] } },                       // Distribuidora → Reclamação (sem Em elaboração)
  'null:2': { etapas: [2],    statusPorEtapa: { 2: [2, 3, 1, 4] } },                    // Ouvidoria → Contestação (4)
  'null:3': { etapas: [2],    statusPorEtapa: { 2: [2, 3, 1, 4] } },                    // ANEEL → Contestação (4)
  'null:4': { etapas: [2],    statusPorEtapa: { 2: [2, 3, 1, 4] } },                    // SMA → Contestação (4)
  // PÓS-DEFERIMENTO (Deferido) — instância mantida + abre Contestação/Conciliação
  '1:1':    { etapas: [2, 3], statusPorEtapa: { 2: [2, 3, 1, 4], 3: [2, 3, 1, 4] } },   // Distribuidora deferida
  '1:2':    { etapas: [2, 3], statusPorEtapa: { 2: [2, 3, 1, 4], 3: [2, 3, 1, 4] } },   // Ouvidoria deferida
  '1:3':    { etapas: [2, 3], statusPorEtapa: { 2: [2, 3, 1, 4], 3: [2, 3, 1, 4] } },   // ANEEL deferida
  '1:4':    { etapas: [2],    statusPorEtapa: { 2: [2, 3, 1, 4] } },                    // SMA deferida (sem Conciliação)
};

// Encerramento (etapa 6) está sempre disponível — é onde se aplica Deferido/Indeferido final.
const ETAPA_ENCERRAMENTO = 6;

// Tradução do `nome` da DM_CANAIS_COMUNICACAO pra label legível.
const CANAL_LABELS = {
  whatsapp: 'WhatsApp',
  ligacao: 'Telefone',
  email: 'E-mail',
  sms: 'SMS / Mensagem',
  site: 'Portal',
  pessoal: 'Pessoalmente',
};
function canalLabel(nome) {
  return CANAL_LABELS[(nome || '').toLowerCase()] || nome || '—';
}

export default function MovimentarModal({
  processo,
  onClose,
  onSuccess,
  onError,
}) {
  const { data: dimensoes } = useDimensoesV2();

  const idEtapaAtual = processo?.etapa?.id || 1;
  const idInstAtual = processo?.instancia?.id || null;
  const idStatusAtual = processo?.status?.id || 1;
  const idAprovAtual = processo?.aprovacao?.id || '';

  // estado dos 7 campos
  const [etapaId, setEtapaId] = useState(idEtapaAtual);
  const [instId, setInstId] = useState(idInstAtual || '');
  const [statusId, setStatusId] = useState(idStatusAtual);
  const [aprovId, setAprovId] = useState(idAprovAtual || '');
  const [canaisSel, setCanaisSel] = useState([]); // ids de DM_CANAIS_COMUNICACAO
  const [coment, setComent] = useState('');
  const [file, setFile] = useState(null);
  const fileRef = useRef(null);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');

  // Esc fecha
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Quando etapa muda pra pós-deferimento, zera instância.
  useEffect(() => {
    if (POSDEF_IDS.has(Number(etapaId))) setInstId('');
  }, [etapaId]);

  // Auto-status ao ENTRAR em Faturamento (etapa 4):
  // "Aguardando envio financeiro" = status 'Em elaboração' (id=2).
  // Só aplica quando a etapa MUDA pra Faturamento (não quando já está nela);
  // o usuário tem que mover manualmente pra Aguardando retorno depois.
  useEffect(() => {
    if (Number(etapaId) === 4 && idEtapaAtual !== 4) {
      setStatusId(2);
    }
  }, [etapaId, idEtapaAtual]);

  // Aprovação CONGELADA em "Deferido" (id=1) ao entrar em Conciliação (3), Faturamento (4) e
  // Repasse (5). Em Conciliação o deferimento é o resultado esperado da etapa.
  useEffect(() => {
    const e = Number(etapaId);
    if (e === 3 || e === 4 || e === 5) setAprovId('1');
  }, [etapaId]);

  // Reclamação (1) e Contestação (2) NÃO permitem "Deferido" — se estiver marcado, limpa.
  useEffect(() => {
    const e = Number(etapaId);
    if ((e === 1 || e === 2) && Number(aprovId) === 1) setAprovId('');
  }, [etapaId, aprovId]);

  // Auto ao ENTRAR em Encerramento (etapa 6): Status = 'Encerrado' (id=7).
  // Aprovação fica em branco — usuário escolhe Deferido/Indeferido (campo obrigatório por `exigeAprov`).
  useEffect(() => {
    if (Number(etapaId) === ETAPA_ENCERRAMENTO) {
      setStatusId(7);
    }
  }, [etapaId]);

  const isPosdef = POSDEF_IDS.has(Number(etapaId));
  const exigeAprov = Number(etapaId) === ETAPA_ENCERRAMENTO;
  // Aprovação: congelada em Deferido em Conciliação(3)/Faturamento(4)/Repasse(5);
  // "Deferido" oculto em Reclamação(1)/Contestação(2).
  const aprovCongelada = [3, 4, 5].includes(Number(etapaId));
  const ocultaDeferido = [1, 2].includes(Number(etapaId));

  // gate: etapa atual + qualquer ANTERIOR + a PRÓXIMA imediata.
  // Encerramento (6) é exceção — sempre disponível, a qualquer momento.
  const etapaHabilitada = (id) =>
    id === ETAPA_ENCERRAMENTO ||
    id === 3 ||                     // Conciliação sempre acessível (congela Deferido ao entrar)
    id <= idEtapaAtual ||           // atual ou anterior (volta livre)
    id === idEtapaAtual + 1;        // próxima imediata

  // Cascata por (aprovação, instância): REGRAS_FLUXO[`${aprov ?? 'null'}:${inst}`]
  const regraAtual = useMemo(() => {
    const aprovKey = aprovId ? String(Number(aprovId)) : 'null';
    const instKey = instId ? Number(instId) : null;
    if (!instKey) return null;
    return REGRAS_FLUXO[`${aprovKey}:${instKey}`] || null;
  }, [aprovId, instId]);

  const etapasPermitidas = useMemo(() => {
    if (isPosdef) return new Set([4, 5, 6]);
    if (!regraAtual) return null; // sem (aprov+inst) definidos → só restrição de adjacência
    return new Set([...regraAtual.etapas, ETAPA_ENCERRAMENTO]); // Encerramento sempre acessível
  }, [regraAtual, isPosdef]);

  const statusPermitidos = useMemo(() => {
    // Encerramento: status SÓ "Encerrado" (id=7). Aprovação distingue Deferido vs Indeferido.
    if (Number(etapaId) === ETAPA_ENCERRAMENTO) return new Set([7]);
    // Faturamento (etapa 4): só "Em elaboração" (2) e "Aguardando retorno" (3).
    if (Number(etapaId) === 4) return new Set([2, 3]);
    // Repasse (etapa 5): só "Aguardando retorno" (3).
    if (Number(etapaId) === 5) return new Set([3]);
    if (isPosdef) return null;
    if (!regraAtual) return null;
    const lista = regraAtual.statusPorEtapa[Number(etapaId)];
    return lista ? new Set(lista) : null;
  }, [regraAtual, etapaId, isPosdef]);

  // Se (aprov,inst) mudar e a etapa atual não for mais válida, pula pra primeira da regra.
  useEffect(() => {
    if (!regraAtual || isPosdef) return;
    if (Number(etapaId) === ETAPA_ENCERRAMENTO) return; // Encerramento sempre vale
    if (!regraAtual.etapas.includes(Number(etapaId))) {
      setEtapaId(regraAtual.etapas[0]);
    }
  }, [regraAtual, isPosdef]); // eslint-disable-line react-hooks/exhaustive-deps

  // Se status atual sair de validade, pula pro primeiro válido.
  useEffect(() => {
    if (!statusPermitidos) return;
    if (!statusPermitidos.has(Number(statusId))) {
      const primeiro = Array.from(statusPermitidos)[0];
      if (primeiro) setStatusId(primeiro);
    }
  }, [statusPermitidos]); // eslint-disable-line react-hooks/exhaustive-deps

  const semMudanca =
    Number(etapaId) === idEtapaAtual &&
    (Number(instId) || null) === (idInstAtual || null) &&
    Number(statusId) === idStatusAtual &&
    (Number(aprovId) || null) === (Number(idAprovAtual) || null) &&
    !coment.trim() &&
    !file;

  const onSalvar = async () => {
    setErro('');
    // Validações client
    if (!etapaHabilitada(Number(etapaId))) {
      setErro(
        `Etapa "${dimensoes?.etapas?.find((e) => e.id === Number(etapaId))?.nome}" não é adjacente à atual.`,
      );
      return;
    }
    if (!isPosdef && !instId) {
      setErro('Selecione uma instância.');
      return;
    }
    if (!statusId) {
      setErro('Selecione um status.');
      return;
    }
    if (exigeAprov && !aprovId) {
      setErro('Encerramento exige status de aprovação.');
      return;
    }
    if (semMudanca) {
      setErro('Nada para salvar — selecione uma mudança ou escreva um comentário.');
      return;
    }

    const payload = {
      etapa_id: Number(etapaId),
      instancia_id: isPosdef ? null : Number(instId),
      status_id: Number(statusId),
      aprovacao_id: aprovId ? Number(aprovId) : null,
      comentario: coment.trim() || null,
      canal_ids: canaisSel,
    };

    try {
      setSalvando(true);
      await movimentar(processo.id_processo, payload);
      if (file) {
        try {
          await uploadAnexo(processo.id_processo, file, 'Anexo da movimentação');
        } catch (e) {
          // anexo é opcional; reporta soft
          console.warn('Falha ao subir anexo da movimentação:', e);
        }
      }
      onSuccess?.(processo.id_processo, Number(etapaId));
    } catch (err) {
      const msg = err?.message || 'Falha ao movimentar.';
      setErro(msg);
      onError?.(err);
    } finally {
      setSalvando(false);
    }
  };

  const content = (
    // Portal renderiza fora do .cpv2-root da página → adicionamos pra herdar as variáveis CSS
    <div
      className="cpv2-root cpv2-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="cpv2-modal">
        <div className="cpv2-modal__head">
          <div>
            <h3>Movimentar processo</h3>
            <p>
              Processo {processo?.codigo_publico || `#${processo?.id_processo}`}
              {processo?.cliente ? ` · ${processo.cliente}` : ''}
            </p>
          </div>
          <button
            type="button"
            className="cpv2-modal__close"
            onClick={onClose}
            aria-label="Fechar"
          >
            <X size={18} />
          </button>
        </div>

        <div className="cpv2-modal__body">
          {/* 1. Etapa */}
          <div className="cpv2-form-group">
            <label className="cpv2-form-group__label">
              <span className="cpv2-form-group__order">1</span> Etapa
            </label>
            <div className="cpv2-etapa-grid">
              {dimensoes?.etapas?.map((e) => {
                const habilitada = etapaHabilitada(e.id);
                const posdef = POSDEF_IDS.has(e.id);
                // Aviso visual quando a combinação (aprov,inst) não cobre essa etapa
                // — mas NÃO trava o clique, o gate é só adjacência + Encerramento.
                const combinaComInst = !etapasPermitidas || etapasPermitidas.has(e.id);
                const ativo = Number(etapaId) === e.id;
                return (
                  <div
                    key={e.id}
                    className={`cpv2-etapa-pill ${ativo ? 'is-active' : ''} ${
                      posdef ? 'is-posdef' : ''
                    } ${!habilitada ? 'is-disabled' : ''}`}
                    onClick={() => habilitada && setEtapaId(e.id)}
                    title={
                      !habilitada
                        ? 'Pode ir só pra etapa anterior, atual, próxima ou Encerramento'
                        : !combinaComInst
                          ? `Atenção: troque a instância pra encaixar na regra (${e.nome})`
                          : `Mover para ${e.nome}`
                    }
                    style={!combinaComInst && habilitada ? { opacity: 0.75 } : undefined}
                  >
                    {e.nome}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 2. Instância */}
          <div className="cpv2-form-group">
            <label className="cpv2-form-group__label">
              <span className="cpv2-form-group__order">2</span> Instância
            </label>
            <div className="cpv2-instancia-grid">
              {dimensoes?.instancias?.map((i) => {
                const ativo = Number(instId) === i.id;
                return (
                  <div
                    key={i.id}
                    className={`cpv2-instancia-pill ${ativo ? 'is-active' : ''} ${
                      isPosdef ? 'is-disabled' : ''
                    }`}
                    onClick={() => !isPosdef && setInstId(i.id)}
                  >
                    {i.nome}
                  </div>
                );
              })}
            </div>
            {Number(instId) === 4 && (
              <div
                style={{
                  marginTop: 8,
                  padding: '8px 10px',
                  background: 'var(--cpv2-danger-soft)',
                  border: '1px solid color-mix(in srgb, var(--cpv2-danger) 35%, transparent)',
                  borderRadius: 8,
                  color: 'var(--cpv2-danger)',
                  fontSize: 12,
                  fontWeight: 600,
                  lineHeight: 1.35,
                }}
              >
                Atenção: Em caso de deferimento em SMA, altere primeiro a
                Instância para habilitar a etapa de Conciliação.
              </div>
            )}
            <div className="cpv2-combo-hint">
              <Info size={13} />
              <div>
                Etapas <strong>Faturamento · Repasse · Encerramento</strong> não
                exigem instância (são pós-deferimento).
              </div>
            </div>
          </div>

          {/* 3. Status */}
          <div className="cpv2-form-group">
            <label className="cpv2-form-group__label">
              <span className="cpv2-form-group__order">3</span> Status do processo
            </label>
            <select
              value={statusId}
              onChange={(e) => setStatusId(Number(e.target.value))}
            >
              {dimensoes?.status
                // "Encerrado" (7) só aparece na etapa Encerramento (onde vem automático).
                // Fora dela — Reclamação/Contestação/Conciliação etc. — nunca é ofertado,
                // mesmo sem regra definida (evita encerrar por engano).
                ?.filter((s) => (!statusPermitidos || statusPermitidos.has(s.id))
                  && !(s.id === 7 && Number(etapaId) !== ETAPA_ENCERRAMENTO))
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.nome}
                  </option>
                ))}
            </select>
          </div>

          {/* 4. Aprovação */}
          <div className="cpv2-form-group">
            <label className="cpv2-form-group__label">
              <span className="cpv2-form-group__order">4</span> Status de
              aprovação {exigeAprov && <small style={{ color: 'var(--cpv2-danger)' }}>*</small>}
            </label>
            <select
              value={aprovId}
              onChange={(e) => setAprovId(e.target.value)}
              disabled={aprovCongelada}
              title={aprovCongelada ? 'Congelada em Deferido nesta etapa (Conciliação/Faturamento/Repasse)' : undefined}
            >
              <option value="">— (não se aplica)</option>
              {dimensoes?.aprovacoes
                ?.filter((a) => !(ocultaDeferido && a.id === 1))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nome}
                  </option>
                ))}
            </select>
          </div>

          {/* 5. Canal de comunicação (N:N) */}
          <div className="cpv2-form-group">
            <label className="cpv2-form-group__label">
              <span className="cpv2-form-group__order">5</span> Canal de comunicação
            </label>
            <div className="cpv2-instancia-grid">
              {dimensoes?.canais_comunicacao?.map((ch) => {
                const ativo = canaisSel.includes(ch.id);
                return (
                  <div
                    key={ch.id}
                    className={`cpv2-instancia-pill ${ativo ? 'is-active' : ''}`}
                    onClick={() =>
                      setCanaisSel((prev) =>
                        prev.includes(ch.id)
                          ? prev.filter((x) => x !== ch.id)
                          : [...prev, ch.id],
                      )
                    }
                    title="Pode marcar mais de um"
                  >
                    {canalLabel(ch.nome)}
                  </div>
                );
              })}
            </div>
            <div className="cpv2-combo-hint">
              <Info size={13} />
              <div>Por onde a informação chegou/foi enviada (marque um ou mais).</div>
            </div>
          </div>

          {/* 6. Comentário */}
          <div className="cpv2-form-group">
            <label className="cpv2-form-group__label">
              <span className="cpv2-form-group__order">6</span> Comentário /
              observação
            </label>
            <textarea
              rows={3}
              value={coment}
              onChange={(e) => setComent(e.target.value)}
              placeholder="Descreva a movimentação…"
            />
          </div>

          {/* 7. Anexo opcional */}
          <div className="cpv2-form-group">
            <label className="cpv2-form-group__label">
              <span className="cpv2-form-group__order">7</span> Anexo (opcional)
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                ref={fileRef}
                type="file"
                style={{ display: 'none' }}
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
              <button
                type="button"
                className="cpv2-btn cpv2-btn--sm"
                onClick={() => fileRef.current?.click()}
              >
                <Paperclip size={12} /> {file ? 'Trocar arquivo' : 'Escolher arquivo'}
              </button>
              {file && (
                <>
                  <span style={{ fontSize: 12, color: 'var(--cpv2-text-muted)' }}>
                    {file.name}
                  </span>
                  <button
                    type="button"
                    className="cpv2-btn cpv2-btn--ghost cpv2-btn--sm"
                    onClick={() => setFile(null)}
                  >
                    Remover
                  </button>
                </>
              )}
            </div>
          </div>

          {erro && (
            <div
              style={{
                background: 'var(--cpv2-danger-soft)',
                color: 'var(--cpv2-danger)',
                padding: '8px 11px',
                borderRadius: 6,
                fontSize: 12,
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
              }}
            >
              <AlertCircle size={14} />
              <div>{erro}</div>
            </div>
          )}
        </div>

        <div className="cpv2-modal__footer">
          <button type="button" className="cpv2-btn" onClick={onClose} disabled={salvando}>
            Cancelar
          </button>
          <button
            type="button"
            className="cpv2-btn cpv2-btn--primary"
            onClick={onSalvar}
            disabled={salvando}
          >
            <Save size={13} />
            {salvando ? 'Salvando…' : 'Salvar movimentação'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
