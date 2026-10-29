// TabFaturamento — NF em 2 blocos: (1) Devolução (envio ao financeiro + formas de devolução)
// e (2) Nota Fiscal (número/série/emissão/vencimento/valor/observações).
import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, X } from 'lucide-react';
import {
  getFaturamento,
  createFaturamento,
  updateFaturamento,
  deleteFaturamento,
} from '../../services/processoV2Service.js';
import { fmtDataBR as fmtData } from '../../utils/dateBR.js';

function brl(v) {
  if (v == null || v === '') return '—';
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function formatBR(v) {
  if (v == null || v === '') return '';
  const n = typeof v === 'number' ? v : parseBR(v);
  if (n == null) return String(v);
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Aceita "4.289,67", "R$ 4.289,67", "4289,67" e "4289.67". Antes, "R$ …" virava null e o
// Salvar gravava o valor VAZIO sem avisar (caso processo 18304, 22/10/2026); "4289.67"
// virava 428967.
function parseBR(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  let s = String(v).replace(/[^\d,.-]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (!/^-?\d+\.\d{1,2}$/.test(s)) s = s.replace(/\./g, ''); // "4.289" = milhar
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const secaoTitulo = {
  fontSize: 11.5,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '.04em',
  color: 'var(--cpv2-text)',
  marginBottom: 8,
  paddingBottom: 4,
  borderBottom: '1px solid var(--cpv2-border)',
};

// Cada setor (Devolução / Nota Fiscal) vira um card próprio com fundo azul, separado do outro.
const blocoCard = {
  border: '1px solid var(--cpv2-brand)',
  borderRadius: 10,
  padding: '12px 14px',
  marginBottom: 14,
  background: 'linear-gradient(135deg, var(--cpv2-brand-soft) 0%, var(--card) 60%)',
};

function FormItem({ initial, editavel, formas, onCancelar, onSalvar, onRemover, salvando }) {
  const [f, setF] = useState({
    numero_nf: initial?.numero_nf || '',
    serie_nf: initial?.serie_nf || '',
    data_emissao: initial?.data_emissao || '',
    data_envio_financeiro:
      initial?.data_envio_financeiro || initial?.data_envio_distribuidora || '',
    data_vencimento: initial?.data_vencimento || '',
    data_pagamento: initial?.data_pagamento || '',
    valor_faturado:
      initial?.valor_faturado != null ? formatBR(initial.valor_faturado) : '',
    // status_nf mantido internamente (default) — não é mais exibido/editável na tela.
    status_nf: initial?.status_nf || 'em_emissao',
    observacoes: initial?.observacoes || '',
    // Item: já mostra uma linha de Formas de Devolução por padrão (sem clicar "Adicionar").
    // A linha vazia é descartada no salvar (filtro em handleSalvar), então não gera item fantasma.
    itens:
      Array.isArray(initial?.itens) && initial.itens.length > 0
        ? initial.itens.map((it) => ({
            id_forma_devolucao: it.id_forma_devolucao ?? '',
            data_devolucao: it.data_devolucao || '',
            data_envio_financeiro: it.data_envio_financeiro || '',
            valor: it.valor != null ? formatBR(it.valor) : '',
            referencia: it.referencia || '',
          }))
        : [{ id_forma_devolucao: '', data_devolucao: '', data_envio_financeiro: '', valor: '', referencia: '' }],
  });
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const setItem = (i, k, v) =>
    setF((p) => ({
      ...p,
      itens: p.itens.map((it, idx) => (idx === i ? { ...it, [k]: v } : it)),
    }));
  const addItem = () =>
    setF((p) => ({
      ...p,
      itens: [...p.itens, { id_forma_devolucao: '', data_devolucao: '', data_envio_financeiro: '', valor: '', referencia: '' }],
    }));
  const removeItem = (i) =>
    setF((p) => ({ ...p, itens: p.itens.filter((_, idx) => idx !== i) }));

  const handleSalvar = () => {
    // valor digitado mas ilegível → avisa em vez de gravar vazio
    const ilegiveis = [f.valor_faturado, ...f.itens.map((it) => it.valor)]
      .filter((v) => String(v || '').trim() !== '' && parseBR(v) == null);
    if (ilegiveis.length) {
      window.alert(`Não entendi o valor "${ilegiveis[0]}". Digite só o número, ex.: 4.289,67`);
      return;
    }
    onSalvar({
      numero_nf: f.numero_nf,
      serie_nf: f.serie_nf,
      data_emissao: f.data_emissao || null,
      data_envio_financeiro: f.data_envio_financeiro || null,
      data_vencimento: f.data_vencimento || null,
      data_pagamento: f.data_pagamento || null,
      valor: parseBR(f.valor_faturado),
      status_nf: f.status_nf || 'em_emissao',
      observacoes: f.observacoes || '',
      itens: f.itens
        .filter(
          (it) =>
            it.id_forma_devolucao || it.data_devolucao || it.data_envio_financeiro || it.valor || it.referencia,
        )
        .map((it) => ({
          id_forma_devolucao: it.id_forma_devolucao
            ? Number(it.id_forma_devolucao)
            : null,
          data_devolucao: it.data_devolucao || null,
          data_envio_financeiro: it.data_envio_financeiro || null,
          valor: parseBR(it.valor),
          referencia: it.referencia || null,
        })),
    });
  };

  return (
    <div>
      {/* ===== BLOCO 1 — Devolução ===== */}
      <div style={blocoCard}>
      <div style={secaoTitulo}>Devolução</div>
      <div className="cpv2-step-form">
        <div className="cpv2-step-form__field">
          <label>Data de Envio ao Financeiro</label>
          <input
            type="date"
            value={f.data_envio_financeiro}
            onChange={set('data_envio_financeiro')}
            disabled={!editavel}
          />
        </div>
      </div>

      <div style={{ marginTop: 8 }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          fontSize: 11.5, fontWeight: 600, color: 'var(--cpv2-text)', marginBottom: 6,
        }}>
          <span>Formas de devolução</span>
          {editavel && (
            <button
              type="button"
              className="cpv2-btn cpv2-btn--ghost cpv2-btn--sm"
              onClick={addItem}
              title="Adicionar item"
            >
              <Plus size={12} /> Adicionar
            </button>
          )}
        </div>
        {f.itens.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--cpv2-text-muted)' }}>
            Nenhuma forma de devolução — clique em Adicionar para preencher.
          </div>
        )}
        {f.itens.map((it, i) => (
          <div key={i} style={{
            display: 'grid',
            gridTemplateColumns: '1.3fr 1fr 1fr 1fr auto',
            gap: 6,
            alignItems: 'end',
            marginBottom: 6,
          }}>
            <div className="cpv2-step-form__field" style={{ margin: 0 }}>
              <label style={{ fontSize: 10 }}>Forma</label>
              <select
                value={it.id_forma_devolucao}
                onChange={(e) => setItem(i, 'id_forma_devolucao', e.target.value)}
                disabled={!editavel}
              >
                <option value="">— selecionar —</option>
                {formas.map((fd) => (
                  <option key={fd.id_forma} value={fd.id_forma}>{fd.nome}</option>
                ))}
              </select>
            </div>
            <div className="cpv2-step-form__field" style={{ margin: 0 }}>
              <label style={{ fontSize: 10 }}>Data da Devolução</label>
              <input
                type="date"
                value={it.data_devolucao}
                onChange={(e) => setItem(i, 'data_devolucao', e.target.value)}
                disabled={!editavel}
              />
            </div>
            <div className="cpv2-step-form__field" style={{ margin: 0 }}>
              <label style={{ fontSize: 10 }}>Valor da Devolução (R$)</label>
              <input
                type="text"
                value={it.valor}
                onChange={(e) => setItem(i, 'valor', e.target.value)}
                onBlur={(e) => {
                  const n = parseBR(e.target.value);
                  if (n != null) setItem(i, 'valor', formatBR(n));
                }}
                disabled={!editavel}
                placeholder="0,00"
              />
            </div>
            <div className="cpv2-step-form__field" style={{ margin: 0 }}>
              <label style={{ fontSize: 10 }}>Referência</label>
              <select
                value={it.referencia}
                onChange={(e) => setItem(i, 'referencia', e.target.value)}
                disabled={!editavel}
              >
                <option value="">—</option>
                <option value="Simples">Simples</option>
                <option value="Dobro">Dobro</option>
                <option value="Simples e Dobro">Simples e Dobro</option>
              </select>
            </div>
            {editavel && (
              <button
                type="button"
                className="cpv2-btn cpv2-btn--ghost cpv2-btn--sm"
                onClick={() => removeItem(i)}
                title="Remover"
                style={{ color: 'var(--cpv2-danger)', padding: 4 }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
      {editavel && (
        <div className="cpv2-step-block__actions" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="cpv2-btn cpv2-btn--primary cpv2-btn--sm"
            disabled={salvando}
            onClick={handleSalvar}
            title="Salva NF + devoluções (mesmo registro)"
          >
            {salvando ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      )}
      </div>{/* fim bloco Devolução */}

      {/* ===== BLOCO 2 — Nota Fiscal ===== */}
      <div style={blocoCard}>
      <div style={secaoTitulo}>Nota Fiscal</div>
      <div className="cpv2-step-form">
        <div className="cpv2-step-form__field">
          <label>Número da NF</label>
          <input
            type="text"
            value={f.numero_nf}
            onChange={set('numero_nf')}
            disabled={!editavel}
            placeholder="ex.: 28491"
          />
        </div>
        <div className="cpv2-step-form__field">
          <label>Série</label>
          <input
            type="text"
            value={f.serie_nf}
            onChange={set('serie_nf')}
            disabled={!editavel}
            placeholder="ex.: U / 1"
          />
        </div>
        <div className="cpv2-step-form__field">
          <label>Data de emissão</label>
          <input
            type="date"
            value={f.data_emissao}
            onChange={set('data_emissao')}
            disabled={!editavel}
          />
        </div>
        <div className="cpv2-step-form__field">
          <label>Vencimento</label>
          <input
            type="date"
            value={f.data_vencimento}
            onChange={set('data_vencimento')}
            disabled={!editavel}
          />
        </div>
        <div className="cpv2-step-form__field">
          <label>Valor faturado (R$)</label>
          <input
            type="text"
            value={f.valor_faturado}
            onChange={set('valor_faturado')}
            onBlur={(e) => {
              const n = parseBR(e.target.value);
              if (n != null) setF((p) => ({ ...p, valor_faturado: formatBR(n) }));
            }}
            disabled={!editavel}
            placeholder="0,00"
          />
        </div>
        <div className="cpv2-step-form__field cpv2-step-form__field--full">
          <label>Observações</label>
          <textarea
            rows={2}
            value={f.observacoes}
            onChange={set('observacoes')}
            disabled={!editavel}
            placeholder="Notas sobre emissão e envio da NF…"
          />
        </div>
      </div>
      {editavel && (
        <div className="cpv2-step-block__actions" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="cpv2-btn cpv2-btn--primary cpv2-btn--sm"
            disabled={salvando}
            onClick={handleSalvar}
            title="Salva NF + devoluções (mesmo registro)"
          >
            {salvando ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      )}
      </div>{/* fim bloco Nota Fiscal */}

      {editavel && (
        <div className="cpv2-step-block__actions" style={{ marginTop: 4 }}>
          {onRemover ? (
            <button
              type="button"
              className="cpv2-btn cpv2-btn--ghost cpv2-btn--sm"
              onClick={onRemover}
              disabled={salvando}
              style={{ color: 'var(--cpv2-danger)' }}
              title="Remover esta NF"
            >
              <Trash2 size={12} /> Remover
            </button>
          ) : (
            <button
              type="button"
              className="cpv2-btn cpv2-btn--ghost cpv2-btn--sm"
              onClick={onCancelar}
              disabled={salvando}
            >
              Cancelar
            </button>
          )}
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
          NF {item.numero_nf || '—'}
          {item.serie_nf ? ` · Sér. ${item.serie_nf}` : ''}
        </div>
        {editavel && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="cpv2-btn cpv2-btn--ghost cpv2-btn--sm"
              onClick={onEditar}
              title="Editar"
            >
              <Pencil size={12} /> Editar
            </button>
            <button
              type="button"
              className="cpv2-btn cpv2-btn--ghost cpv2-btn--sm"
              onClick={onRemover}
              title="Remover"
              style={{ color: 'var(--cpv2-danger)' }}
            >
              <Trash2 size={12} /> Remover
            </button>
          </div>
        )}
      </div>
      <div className="cpv2-item-card__grid">
        <div>
          <label>Emissão</label>
          <span>{fmtData(item.data_emissao)}</span>
        </div>
        <div>
          <label>Envio ao Financeiro</label>
          <span>
            {fmtData(item.data_envio_financeiro || item.data_envio_distribuidora)}
          </span>
        </div>
        <div>
          <label>Vencimento</label>
          <span>{fmtData(item.data_vencimento)}</span>
        </div>
        <div>
          <label>Valor</label>
          <span>{brl(item.valor_faturado)}</span>
        </div>
      </div>
      {Array.isArray(item.itens) && item.itens.length > 0 && (
        <div style={{ marginTop: 8, borderTop: '1px dashed var(--cpv2-border)', paddingTop: 6 }}>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--cpv2-text-muted)', marginBottom: 4 }}>
            Formas de devolução
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1.3fr 1fr 1fr 1fr',
            gap: 6,
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--cpv2-text-muted)',
            paddingBottom: 2,
          }}>
            <span>Forma</span>
            <span>Data da Devolução</span>
            <span>Valor da Devolução</span>
            <span>Referência</span>
          </div>
          {item.itens.map((it, i) => (
            <div key={i} style={{
              display: 'grid',
              gridTemplateColumns: '1.3fr 1fr 1fr 1fr',
              gap: 6,
              fontSize: 11.5,
              padding: '3px 0',
              borderBottom: i < item.itens.length - 1 ? '1px dotted var(--cpv2-border)' : 'none',
            }}>
              <span>{it.forma_devolucao_nome || '—'}</span>
              <span>{fmtData(it.data_devolucao)}</span>
              <span>{brl(it.valor)}</span>
              <span>{it.referencia || '—'}</span>
            </div>
          ))}
        </div>
      )}
      {item.observacoes && (
        <div style={{ fontSize: 11.5, color: 'var(--cpv2-text-muted)', marginTop: 6 }}>
          {item.observacoes}
        </div>
      )}
    </div>
  );
}

export default function TabFaturamento({
  idProcesso,
  itens,
  isLoading,
  editavel,
  detalhe,
  onToast,
}) {
  const qc = useQueryClient();
  const [editId, setEditId] = useState(null);
  const [novo, setNovo] = useState(false);
  const [salvando, setSalvando] = useState(false);

  // Busca formas_devolucao (vem no payload de faturamentos)
  const { data: raw } = useQuery({
    queryKey: ['v2', 'faturamento', idProcesso],
    queryFn: () => getFaturamento(idProcesso),
    enabled: !!idProcesso,
    staleTime: 30000,
  });
  const formas = raw?.formas_devolucao || [
    { id_forma: 1, nome: 'Depósito' },
    { id_forma: 2, nome: 'Crédito em fatura' },
    { id_forma: 3, nome: 'Saldo GD' },
  ];

  useEffect(() => {
    setEditId(null);
    setNovo(false);
  }, [idProcesso]);

  const invalidar = () => {
    qc.invalidateQueries({ queryKey: ['v2', 'faturamento', idProcesso] });
    qc.invalidateQueries({ queryKey: ['v2', 'processo', idProcesso] });
    qc.invalidateQueries({ queryKey: ['v2', 'processos'] });
  };

  const handleCreate = async (payload) => {
    try {
      setSalvando(true);
      await createFaturamento(idProcesso, payload);
      onToast?.({ open: true, type: 'success', text: 'Nota fiscal criada.' });
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
  const handleUpdate = async (idFat, payload) => {
    try {
      setSalvando(true);
      await updateFaturamento(idFat, payload);
      onToast?.({ open: true, type: 'success', text: 'NF atualizada.' });
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
  const handleDelete = async (idFat) => {
    if (!window.confirm('Remover esta NF?')) return;
    try {
      await deleteFaturamento(idFat);
      onToast?.({ open: true, type: 'success', text: 'NF removida.' });
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

  // Mostra o formulário de NF (layout personalizado) por padrão quando a lista está
  // vazia — INDEPENDENTE da etapa. Se a aba ainda não é editável (ex.: processo em
  // Conciliação, antes de Faturamento), o formulário aparece em READ-ONLY (campos
  // desabilitados via editavel=false), pra a disposição dos campos ser sempre a mesma.
  // O botão "Adicionar NF" continua existindo para NFs extras quando editável.
  const mostrarForm = novo || itens.length === 0;

  return (
    <div
      className={`cpv2-step-block ${editavel ? 'cpv2-step-block--ativo' : 'cpv2-step-block--readonly'}`}
    >
      <div className="cpv2-step-block__head">
        <div className="cpv2-step-block__num">2</div>
        <div className="cpv2-step-block__title">
          Faturamento <small>— emissão da nota de ressarcimento</small>
        </div>
        <span className="cpv2-step-block__badge">
          {editavel ? 'Em andamento' : itens.length > 0 ? 'Concluído' : 'Aguardando'}
        </span>
      </div>

      {itens.length === 0 && !mostrarForm && (
        <div className="cpv2-empty" style={{ padding: '24px 0' }}>
          <h4>Nenhuma nota fiscal cadastrada</h4>
          <p>
            {editavel
              ? 'Adicione a primeira NF abaixo.'
              : `Disponível quando a etapa atual for Faturamento (atual: ${detalhe?.etapa_atual?.nome || '—'}).`}
          </p>
        </div>
      )}

      {/* NF existente aparece no MESMO layout de formulário (blocos Devolução + Nota Fiscal),
          pré-preenchida. Editável quando a etapa permite; read-only (campos desabilitados)
          nas etapas anteriores. Substitui o antigo card-resumo. */}
      {itens.map((it) => (
        <FormItem
          key={it.id_faturamento}
          initial={it}
          editavel={editavel}
          formas={formas}
          salvando={salvando}
          onSalvar={(payload) => handleUpdate(it.id_faturamento, payload)}
          onRemover={editavel ? () => handleDelete(it.id_faturamento) : undefined}
        />
      ))}

      {mostrarForm && (
        <FormItem
          editavel={editavel}
          formas={formas}
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
            <Plus size={12} /> Adicionar NF
          </button>
        </div>
      )}

      {!editavel && (
        <div className="cpv2-step-block__hint">
          Esta aba libera quando o processo é movido para{' '}
          <strong>Faturamento</strong> ou etapa posterior.
          {detalhe?.etapa_atual?.nome
            ? ` Etapa atual: ${detalhe.etapa_atual.nome}.`
            : ''}
        </div>
      )}
    </div>
  );
}
