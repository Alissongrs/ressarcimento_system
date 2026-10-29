// TabRepasse — uma linha por NF do processo (data de pagamento + valor do repasse); editável quando etapa == 5.
import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import {
  createRepasse,
  updateRepasse,
  deleteRepasse,
} from '../../services/processoV2Service.js';
import { useDimensoesV2 } from '../../hooks/useDimensoesV2.js';
import { fmtDataBR as fmtData } from '../../utils/dateBR.js';

function brl(v) {
  if (v == null || v === '') return '—';
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function parseBR(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const limpo = String(v).trim().replace(/\./g, '').replace(',', '.');
  const n = Number(limpo);
  return Number.isFinite(n) ? n : null;
}
// Valor único do repasse na tela = simples + dobro (o backend reparte ao gravar).
function totalRepasse(item) {
  if (item?.repasse_simples == null && item?.repasse_dobro == null) return null;
  return Number(item.repasse_simples || 0) + Number(item.repasse_dobro || 0);
}

function FormItem({ initial, editavel, onCancelar, onSalvar, salvando }) {
  const [f, setF] = useState({
    data_repasse: initial?.data_repasse || '',
    observacoes: initial?.observacoes || '',
    repasse: totalRepasse(initial) ?? '',
  });
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  return (
    <div className="cpv2-item-card">
      <div className="cpv2-step-form">
        <div className="cpv2-step-form__field">
          <label>Data do Repasse</label>
          <input
            type="date"
            value={f.data_repasse}
            onChange={set('data_repasse')}
            disabled={!editavel}
          />
        </div>
        <div className="cpv2-step-form__field">
          <label>Repasse (R$)</label>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0,00"
            value={f.repasse}
            onChange={set('repasse')}
            disabled={!editavel}
          />
        </div>
        <div className="cpv2-step-form__field cpv2-step-form__field--full">
          <label>Observações</label>
          <textarea
            rows={2}
            value={f.observacoes}
            onChange={set('observacoes')}
            disabled={!editavel}
          />
        </div>
      </div>
      {editavel && (
        <div className="cpv2-step-block__actions">
          <button
            type="button"
            className="cpv2-btn cpv2-btn--ghost cpv2-btn--sm"
            onClick={onCancelar}
            disabled={salvando}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="cpv2-btn cpv2-btn--primary cpv2-btn--sm"
            disabled={salvando}
            onClick={() =>
              onSalvar({
                data_devolucao: f.data_repasse || null,
                observacoes: f.observacoes || '',
                repasse_total: parseBR(f.repasse),
              })
            }
          >
            {salvando ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      )}
    </div>
  );
}

function Resumo({ item, editavel, onEditar, onRemover }) {
  return (
    <div className="cpv2-item-card">
      <div className="cpv2-item-card__head">
        <div className="cpv2-item-card__title">
          Repasse {item.forma_devolucao?.nome ? `· ${item.forma_devolucao.nome}` : ''}
        </div>
        {editavel && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="cpv2-btn cpv2-btn--ghost cpv2-btn--sm"
              onClick={onEditar}
            >
              <Pencil size={12} /> Editar
            </button>
            <button
              type="button"
              className="cpv2-btn cpv2-btn--ghost cpv2-btn--sm"
              onClick={onRemover}
              style={{ color: 'var(--cpv2-danger)' }}
            >
              <Trash2 size={12} /> Remover
            </button>
          </div>
        )}
      </div>
      <div className="cpv2-item-card__grid">
        {item.numero_nf && (
          <div>
            <label>NF</label>
            <span>{item.numero_nf}</span>
          </div>
        )}
        <div>
          <label>Data do Repasse</label>
          <span>{fmtData(item.data_repasse)}</span>
        </div>
        <div>
          <label>Repasse</label>
          <span>{brl(totalRepasse(item))}</span>
        </div>
      </div>
      {item.observacoes && (
        <div style={{ fontSize: 11.5, color: 'var(--cpv2-text-muted)' }}>
          {item.observacoes}
        </div>
      )}
    </div>
  );
}

export default function TabRepasse({
  idProcesso,
  itens,
  isLoading,
  editavel,
  detalhe,
  onToast,
}) {
  const qc = useQueryClient();
  const { data: dimensoes } = useDimensoesV2();
  const [editId, setEditId] = useState(null);
  const [novo, setNovo] = useState(false);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    setEditId(null);
    setNovo(false);
  }, [idProcesso]);

  const invalidar = () => {
    qc.invalidateQueries({ queryKey: ['v2', 'repasse', idProcesso] });
    qc.invalidateQueries({ queryKey: ['v2', 'processo', idProcesso] });
    qc.invalidateQueries({ queryKey: ['v2', 'processos'] });
  };

  const handleCreate = async (payload) => {
    try {
      setSalvando(true);
      await createRepasse(idProcesso, payload);
      onToast?.({ open: true, type: 'success', text: 'Repasse criado.' });
      setNovo(false);
      invalidar();
    } catch (err) {
      onToast?.({
        open: true,
        type: 'error',
        text: err?.message || 'Falha ao criar.',
      });
    } finally {
      setSalvando(false);
    }
  };
  const handleUpdate = async (idRep, payload) => {
    try {
      setSalvando(true);
      await updateRepasse(idRep, payload);
      onToast?.({ open: true, type: 'success', text: 'Repasse atualizado.' });
      setEditId(null);
      invalidar();
    } catch (err) {
      onToast?.({
        open: true,
        type: 'error',
        text: err?.message || 'Falha ao atualizar.',
      });
    } finally {
      setSalvando(false);
    }
  };
  const handleDelete = async (idRep) => {
    if (!window.confirm('Remover este repasse?')) return;
    try {
      await deleteRepasse(idRep);
      onToast?.({ open: true, type: 'success', text: 'Repasse removido.' });
      invalidar();
    } catch (err) {
      onToast?.({
        open: true,
        type: 'error',
        text: err?.message || 'Falha ao remover.',
      });
    }
  };

  if (isLoading) {
    return (
      <div className="cpv2-empty">
        <h4>Carregando…</h4>
      </div>
    );
  }

  // Item 6: com a aba editável e sem repasses, já mostra o formulário (sem clicar "Adicionar").
  const mostrarForm = novo || (editavel && itens.length === 0);

  return (
    <div
      className={`cpv2-step-block ${editavel ? 'cpv2-step-block--ativo' : 'cpv2-step-block--readonly'}`}
    >
      <div className="cpv2-step-block__head">
        <div className="cpv2-step-block__num">3</div>
        <div className="cpv2-step-block__title">
          Repasse
        </div>
        <span className="cpv2-step-block__badge">
          {editavel ? 'Em andamento' : itens.length > 0 ? 'Concluído' : 'Aguardando'}
        </span>
      </div>

      {itens.length === 0 && !mostrarForm && (
        <div className="cpv2-empty" style={{ padding: '24px 0' }}>
          <h4>Nenhum repasse cadastrado</h4>
          <p>
            {editavel
              ? 'Adicione o primeiro repasse abaixo.'
              : `Disponível quando a etapa atual for Repasse (atual: ${detalhe?.etapa_atual?.nome || '—'}).`}
          </p>
        </div>
      )}

      {itens.map((it) =>
        editId === it.id_repasse ? (
          <FormItem
            key={it.id_repasse}
            initial={it}
            formas={dimensoes?.formas_devolucao || []}
            editavel={true}
            salvando={salvando}
            onCancelar={() => setEditId(null)}
            onSalvar={(payload) => handleUpdate(it.id_repasse, payload)}
          />
        ) : (
          <Resumo
            key={it.id_repasse}
            item={it}
            editavel={editavel}
            onEditar={() => setEditId(it.id_repasse)}
            onRemover={() => handleDelete(it.id_repasse)}
          />
        ),
      )}

      {mostrarForm && (
        <FormItem
          editavel={true}
          salvando={salvando}
          onCancelar={() => setNovo(false)}
          onSalvar={handleCreate}
        />
      )}

      {editavel && !mostrarForm && (
        <div className="cpv2-step-block__actions">
          <button
            type="button"
            className="cpv2-btn cpv2-btn--primary cpv2-btn--sm"
            onClick={() => setNovo(true)}
          >
            <Plus size={12} /> Adicionar repasse
          </button>
        </div>
      )}

      {!editavel && (
        <div className="cpv2-step-block__hint">
          Esta aba libera quando o processo é movido para{' '}
          <strong>Repasse</strong> ou etapa posterior.
          {detalhe?.etapa_atual?.nome
            ? ` Etapa atual: ${detalhe.etapa_atual.nome}.`
            : ''}
        </div>
      )}
    </div>
  );
}
