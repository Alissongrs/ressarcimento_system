// TabEncerramento — 1 registro por processo; editável quando etapa == 6.
import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { saveEncerramento } from '../../services/processoV2Service.js';

function toDateInput(s) {
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

export default function TabEncerramento({
  idProcesso,
  encerramento,
  isLoading,
  editavel,
  detalhe,
  onToast,
}) {
  const qc = useQueryClient();

  // O resultado final do encerramento HERDA a aprovação ATUAL do processo:
  //   Indeferido (id 2) -> motivo "indeferido_sem_recurso"
  //   Deferido   (id 1) -> motivo "repasse_concluido"
  // (Bug anterior: forçava sempre Deferido/repasse_concluido, gravando processos
  //  Indeferidos como Deferido quando o analista só clicava "Confirmar".)
  const aprovAtualId =
    encerramento?.aprovacao_final?.id ?? detalhe?.aprovacao_atual?.id ?? null;
  const isIndeferido = Number(aprovAtualId) === 2;
  const motivoPadrao = isIndeferido ? 'indeferido_sem_recurso' : 'repasse_concluido';

  const [dataEnc, setDataEnc] = useState(toDateInput(encerramento?.data_encerramento));
  const [motivo, setMotivo] = useState(encerramento?.motivo || motivoPadrao);
  const [aprovId, setAprovId] = useState(encerramento?.aprovacao_final?.id || aprovAtualId || '');
  const [parecer, setParecer] = useState(encerramento?.parecer_final || '');
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    setDataEnc(toDateInput(encerramento?.data_encerramento));
    setMotivo(encerramento?.motivo || motivoPadrao);
    setAprovId(encerramento?.aprovacao_final?.id || aprovAtualId || '');
    setParecer(encerramento?.parecer_final || '');
  }, [encerramento, idProcesso, aprovAtualId, motivoPadrao]);

  const salvar = async () => {
    const aprovFinal = aprovId || aprovAtualId || (isIndeferido ? 2 : 1);
    if (!aprovFinal) {
      onToast?.({
        open: true,
        type: 'error',
        text: 'Não foi possível definir o resultado final. Tente novamente.',
      });
      return;
    }
    if (!dataEnc) {
      onToast?.({
        open: true,
        type: 'error',
        text: 'Informe a data de encerramento.',
      });
      return;
    }
    try {
      setSalvando(true);
      await saveEncerramento(idProcesso, {
        data_encerramento: dataEnc,
        motivo,
        aprovacao_final_id: Number(aprovFinal) || (isIndeferido ? 2 : 1), // herda a aprovação atual do processo
        parecer_final: parecer || null,
      });
      onToast?.({
        open: true,
        type: 'success',
        text: 'Encerramento confirmado.',
      });
      qc.invalidateQueries({ queryKey: ['v2', 'encerramento', idProcesso] });
      qc.invalidateQueries({ queryKey: ['v2', 'processo', idProcesso] });
      qc.invalidateQueries({ queryKey: ['v2', 'processos'] });
    } catch (err) {
      onToast?.({
        open: true,
        type: 'error',
        text: err?.message || 'Falha ao encerrar.',
      });
    } finally {
      setSalvando(false);
    }
  };

  if (isLoading) {
    return (
      <div className="cpv2-empty">
        <h4>Carregando…</h4>
      </div>
    );
  }

  const disabled = !editavel;
  const blocoCls = editavel
    ? 'cpv2-step-block--ativo'
    : encerramento
      ? Number(aprovId) === 2 || encerramento?.aprovacao_final?.id === 2
        ? 'cpv2-step-block--reprov'
        : 'cpv2-step-block--deferido'
      : 'cpv2-step-block--readonly';

  return (
    <div className={`cpv2-step-block ${blocoCls}`}>
      <div className="cpv2-step-block__head">
        <div className="cpv2-step-block__num">4</div>
        <div className="cpv2-step-block__title">
          Encerramento <small>— fechamento do processo</small>
        </div>
        <span className="cpv2-step-block__badge">
          {encerramento ? 'Concluído' : editavel ? 'Em andamento' : 'Aguardando'}
        </span>
      </div>

      <div className="cpv2-step-form">
        <div className="cpv2-step-form__field">
          <label>Data de encerramento</label>
          <input
            type="date"
            value={dataEnc}
            onChange={(e) => setDataEnc(e.target.value)}
            disabled={disabled}
          />
        </div>
        {/* Resultado final e motivo REFLETEM a aprovação atual do processo
            (Deferido -> repasse concluído; Indeferido -> indeferido sem recurso). */}
        <div className="cpv2-step-form__field">
          <label>Resultado final</label>
          <input
            type="text"
            value={isIndeferido ? 'Indeferido' : 'Deferido'}
            readOnly
            disabled
          />
        </div>
        <div className="cpv2-step-form__field">
          <label>Motivo</label>
          <input
            type="text"
            value={isIndeferido ? 'Indeferido sem recurso' : 'Repasse concluído'}
            readOnly
            disabled
          />
        </div>
        <div className="cpv2-step-form__field cpv2-step-form__field--full">
          <label>Parecer final</label>
          <textarea
            rows={3}
            value={parecer}
            onChange={(e) => setParecer(e.target.value)}
            disabled={disabled}
            placeholder="Resumo final do processo…"
          />
        </div>
      </div>

      {editavel ? (
        <div className="cpv2-step-block__actions">
          <button
            type="button"
            className="cpv2-btn cpv2-btn--primary cpv2-btn--sm"
            onClick={salvar}
            disabled={salvando}
          >
            {salvando ? 'Salvando…' : 'Confirmar encerramento'}
          </button>
        </div>
      ) : (
        <div className="cpv2-step-block__hint">
          Esta aba libera quando o processo chega em{' '}
          <strong>Encerramento</strong> ou é marcado como{' '}
          <strong>Indeferido</strong>.
          {detalhe?.etapa_atual?.nome
            ? ` Etapa atual: ${detalhe.etapa_atual.nome}.`
            : ''}
        </div>
      )}
    </div>
  );
}
