// TabDeferimento — bloco "1. Deferimento" do step pós-conciliação.
// Editável: etapas 1..4 (Reclamação → Faturamento). Read-only nas etapas 5/6.
// Regra: pode marcar Indeferido em qualquer etapa em que esteja editável.

import React, { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { saveDeferimento } from '../../services/processoV2Service.js';
import { useDimensoesV2 } from '../../hooks/useDimensoesV2.js';

function toDateInput(s) {
  if (!s) return '';
  // aceita "YYYY-MM-DD" direto, ou ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

function parseBR(num) {
  if (num == null || num === '') return null;
  if (typeof num === 'number') return num;
  // aceita "1.234,56" ou "1234.56"
  const s = String(num).trim();
  if (/^\d+([.,]\d+)?$/.test(s) && !s.includes(',')) return Number(s);
  const limpo = s.replace(/\./g, '').replace(',', '.');
  const v = Number(limpo);
  return Number.isFinite(v) ? v : null;
}

// Formata um número (ou string parseável) para "1.234,56" — sem o "R$".
function formatBR(num) {
  const v = parseBR(num);
  if (v == null) return '';
  return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function TabDeferimento({
  idProcesso,
  deferimento,
  isLoading,
  editavel,
  detalhe,
  onToast,
}) {
  const qc = useQueryClient();
  const { data: dimensoes } = useDimensoesV2();

  // Status de aprovação não é mais obrigatório no Deferimento — Deferido/Indeferido é tratado via Encerramento.
  // estado controlado
  const [instId, setInstId] = useState(deferimento?.instancia?.id || '');
  const [dataProc, setDataProc] = useState(toDateInput(deferimento?.data_procedencia));
  const [creditoSimples, setCreditoSimples] = useState(
    formatBR(deferimento?.credito_simples),
  );
  const [creditoDobro, setCreditoDobro] = useState(formatBR(deferimento?.credito_dobro));
  const [dataDobro, setDataDobro] = useState(toDateInput(deferimento?.data_credito_dobro));
  const [obs, setObs] = useState(deferimento?.observacoes || '');
  const [salvando, setSalvando] = useState(false);

  // resincroniza ao mudar de processo
  useEffect(() => {
    setInstId(deferimento?.instancia?.id || '');
    setDataProc(toDateInput(deferimento?.data_procedencia));
    setCreditoSimples(formatBR(deferimento?.credito_simples));
    setCreditoDobro(formatBR(deferimento?.credito_dobro));
    setDataDobro(toDateInput(deferimento?.data_credito_dobro));
    setObs(deferimento?.observacoes || '');
  }, [deferimento, idProcesso]);

  const aprovacaoAtual = detalhe?.aprovacao_atual?.nome;

  // status visual do bloco
  const blocoCls = useMemo(() => {
    if (aprovacaoAtual === 'Deferido') return 'cpv2-step-block--deferido';
    if (aprovacaoAtual === 'Indeferido') return 'cpv2-step-block--reprov';
    if (editavel) return 'cpv2-step-block--ativo';
    return 'cpv2-step-block--readonly';
  }, [aprovacaoAtual, editavel]);

  const badge = useMemo(() => {
    if (aprovacaoAtual === 'Deferido') return 'Deferido';
    if (aprovacaoAtual === 'Indeferido') return 'Indeferido';
    if (editavel) return 'Em andamento';
    return 'Aguardando';
  }, [aprovacaoAtual, editavel]);

  const salvar = async () => {
    try {
      setSalvando(true);
      const payload = {
        aprovacao_id: null, // não setado no Deferimento; aprovação fica pro Encerramento
        instancia_id: instId ? Number(instId) : null,
        data_procedencia: dataProc || null,
        credito_simples: parseBR(creditoSimples) ?? 0,
        credito_dobro: parseBR(creditoDobro) ?? 0,
        data_credito_dobro: dataDobro || null,
        observacoes: obs || null,
      };
      await saveDeferimento(idProcesso, payload);
      onToast?.({
        open: true,
        type: 'success',
        text: 'Deferimento salvo com sucesso.',
      });
      qc.invalidateQueries({ queryKey: ['v2', 'deferimento', idProcesso] });
      qc.invalidateQueries({ queryKey: ['v2', 'processo', idProcesso] });
      qc.invalidateQueries({ queryKey: ['v2', 'processos'] });
    } catch (err) {
      onToast?.({
        open: true,
        type: 'error',
        text: err?.message || 'Falha ao salvar deferimento.',
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

  return (
    <div className={`cpv2-step-block ${blocoCls}`}>
      <div className="cpv2-step-block__head">
        <div className="cpv2-step-block__num">1</div>
        <div className="cpv2-step-block__title">
          Deferimento
          <small>— decisão de procedência</small>
        </div>
        <span className="cpv2-step-block__badge">{badge}</span>
      </div>

      <div className="cpv2-step-form">
        {/* Instância da decisão — linha inteira */}
        <div className="cpv2-step-form__field cpv2-step-form__field--full">
          <label>Instância da decisão</label>
          <select
            value={instId}
            disabled={disabled}
            onChange={(e) => setInstId(e.target.value)}
          >
            <option value="">— selecione —</option>
            {dimensoes?.instancias?.map((i) => (
              <option key={i.id} value={i.id}>
                {i.nome}
              </option>
            ))}
          </select>
        </div>
        {/* Linha 2: Crédito simples · Data crédito simples */}
        <div className="cpv2-step-form__field">
          <label>Deferido Simples (R$)</label>
          <input
            type="text"
            disabled={disabled}
            value={creditoSimples}
            onChange={(e) => setCreditoSimples(e.target.value)}
            onBlur={() => setCreditoSimples(formatBR(creditoSimples))}
            placeholder="0,00"
          />
        </div>
        <div className="cpv2-step-form__field">
          <label>Data Deferido Simples</label>
          <input
            type="date"
            disabled={disabled}
            value={dataProc}
            onChange={(e) => setDataProc(e.target.value)}
          />
        </div>
        {/* Linha 3: Crédito em dobro · Data crédito em dobro */}
        <div className="cpv2-step-form__field">
          <label>Deferido Dobro (R$)</label>
          <input
            type="text"
            disabled={disabled}
            value={creditoDobro}
            onChange={(e) => setCreditoDobro(e.target.value)}
            onBlur={() => setCreditoDobro(formatBR(creditoDobro))}
            placeholder="0,00"
          />
        </div>
        <div className="cpv2-step-form__field">
          <label>Data Deferido Dobro</label>
          <input
            type="date"
            disabled={disabled}
            value={dataDobro}
            onChange={(e) => setDataDobro(e.target.value)}
          />
        </div>
        {/* Total deferido (simples + dobro) — soma ao vivo enquanto o analista digita */}
        <div className="cpv2-step-form__field cpv2-step-form__field--full">
          <div
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
              padding: '10px 14px', borderRadius: 8,
              background: 'color-mix(in srgb, #22c55e 12%, transparent)',
              border: '1px solid color-mix(in srgb, #22c55e 45%, transparent)',
            }}
          >
            <span style={{ fontWeight: 600 }}>Total deferido:</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: '#22c55e' }}>
              R$ {formatBR((parseBR(creditoSimples) ?? 0) + (parseBR(creditoDobro) ?? 0)) || '0,00'}
            </span>
          </div>
        </div>
        <div className="cpv2-step-form__field cpv2-step-form__field--full">
          <label>Observações do deferimento</label>
          <textarea
            rows={2}
            disabled={disabled}
            value={obs}
            onChange={(e) => setObs(e.target.value)}
            placeholder="Notas sobre o acordo / decisão…"
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
            {salvando ? 'Salvando…' : 'Salvar deferimento'}
          </button>
        </div>
      ) : (
        <div className="cpv2-step-block__hint">
          Esta aba fica em <strong>somente leitura</strong> até a{' '}
          <strong>Status de aprovação</strong> ser marcado como{' '}
          <strong>Deferido</strong> (via <em>Movimentar</em>).
          {detalhe?.etapa_atual?.nome && (
            <> Etapa atual: <strong>{detalhe.etapa_atual.nome}</strong>.</>
          )}
        </div>
      )}
    </div>
  );
}
