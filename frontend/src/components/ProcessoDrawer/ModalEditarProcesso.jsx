// ModalEditarProcesso — edita os dados da tela de Resumo (identificação, valores,
// irregularidade) + o PERCENTUAL DO PROCESSO. Patch via PUT /processos/:id/full.
//
// Percentual do processo: quando preenchido, é o percentual usado no cálculo de repasse
// SÓ deste processo (override). NÃO altera o percentual geral da empresa (DM_EMPRESA_PERCENTUAL).
//
// Posicionamento (etapa/instância/status/aprovação) NÃO é editado aqui — isso é feito
// pelo botão "Movimentar", que registra histórico.
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Save } from 'lucide-react';
import { useDimensoesV2 } from '../../hooks/useDimensoesV2.js';
import { atualizarProcessoCompleto } from '../../services/processoV2Service.js';

const num = (v) => (v === '' || v == null ? null : Number(v));
// String segura: se vier objeto/array do detalhe (ex.: uc = {codigo_uc}, periodos = [...]),
// não usa como texto — evita mandar tipo errado no PUT e tomar 400.
const asStr = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

// IMPORTANTE: Txt e Sel ficam FORA do componente. Se fossem definidos dentro, a cada tecla o
// pai re-renderiza, eles viram funções novas, o React remonta o <input> e o foco se perde
// (só dava pra digitar 1 letra por clique).
function Txt({ label, value, onChange, type = 'text', ...rest }) {
  return (
    <div className="cpv2-form-group">
      <label className="cpv2-form-group__label">{label}</label>
      <input type={type} value={value} onChange={onChange} {...rest} />
    </div>
  );
}
function Sel({ label, value, onChange, opts }) {
  return (
    <div className="cpv2-form-group">
      <label className="cpv2-form-group__label">{label}</label>
      <select value={value} onChange={onChange}>
        <option value="">—</option>
        {(opts || []).map((o) => (
          <option key={o.id} value={o.id}>{o.nome}</option>
        ))}
      </select>
    </div>
  );
}

export default function ModalEditarProcesso({ processo, onClose, onSaved, onToast }) {
  const { data: dim } = useDimensoesV2();
  const p = processo || {};
  const clienteNome = p.cliente?.razao_social ?? (typeof p.cliente === 'string' ? p.cliente : '');
  const [f, setF] = useState({
    cliente: clienteNome,
    uc: asStr(p.uc?.codigo_uc ?? p.uc),
    concessionaria: asStr(
      (typeof p.distribuidora === 'string' ? p.distribuidora : p.distribuidora?.nome) ?? p.concessionaria,
    ),
    cnpj: asStr(p.cliente?.cnpj ?? p.cnpj),
    endereco_completo: asStr(p.uc?.endereco ?? p.endereco_completo),
    numero_protocolo: asStr(p.numero_protocolo),
    link_fatura: asStr(p.link_fatura),
    ressarcimento_estimado: p.ressarcimento_estimado ?? '',
    percentual_repasse: p.percentual_repasse ?? '',
    id_tipo_irregularidade: p.tipo_irregularidade?.id ?? p.id_tipo_irregularidade ?? '',
    id_subtipo_irregularidade: p.subtipo_irregularidade?.id ?? p.id_subtipo_irregularidade ?? '',
    // periodos_irregularidade pode vir como ARRAY do detalhe — só editamos texto aqui.
    periodos_irregularidade: asStr(p.periodos_irregularidade),
    descricao_irregularidade: asStr(p.descricao_irregularidade),
    credito_simples: p.credito_simples ?? '',
    credito_dobro: p.credito_dobro ?? '',
    relevancia: !!(p.relevancia === true || p.relevancia === 1 || p.relevante === true),
  });
  const set = (k) => (e) =>
    setF((s) => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const [salvando, setSalvando] = useState(false);

  const salvar = async () => {
    // Patch: só envia o que está preenchido (evita zerar campos não carregados pelo GET).
    const payload = {};
    const S = (k, v) => { if (typeof v === 'string' && v.trim() !== '') payload[k] = v; };
    const N = (k, v) => { const n = num(v); if (n != null && !Number.isNaN(n)) payload[k] = n; };
    S('cliente', f.cliente);
    S('uc', f.uc);
    S('concessionaria', f.concessionaria);
    S('cnpj', f.cnpj);
    S('endereco_completo', f.endereco_completo);
    S('numero_protocolo', f.numero_protocolo);
    S('link_fatura', f.link_fatura);
    S('periodos_irregularidade', f.periodos_irregularidade);
    S('descricao_irregularidade', f.descricao_irregularidade);
    N('ressarcimento_estimado', f.ressarcimento_estimado);
    N('percentual_repasse', f.percentual_repasse);
    N('id_tipo_irregularidade', f.id_tipo_irregularidade);
    N('id_subtipo_irregularidade', f.id_subtipo_irregularidade);
    N('credito_simples', f.credito_simples);
    N('credito_dobro', f.credito_dobro);
    payload.relevancia = !!f.relevancia; // checkbox reflete o estado atual
    try {
      setSalvando(true);
      await atualizarProcessoCompleto(p.id_processo, payload);
      onToast?.({ open: true, type: 'success', text: 'Dados do processo atualizados.' });
      onSaved?.(p.id_processo);
      onClose?.();
    } catch (err) {
      onToast?.({ open: true, type: 'error', text: err?.message || 'Falha ao salvar.' });
    } finally {
      setSalvando(false);
    }
  };

  const content = (
    <div className="cpv2-root cpv2-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="cpv2-modal" style={{ maxWidth: 720 }}>
        <div className="cpv2-modal__head">
          <div>
            <h3>Editar dados (Resumo)</h3>
            <p>{p.codigo_publico || `#${p.id_processo}`}{clienteNome ? ` · ${clienteNome}` : ''}</p>
          </div>
          <button type="button" className="cpv2-modal__close" onClick={onClose} aria-label="Fechar"><X size={18} /></button>
        </div>
        <div className="cpv2-modal__body">
          <div className="cpv2-section-title">Identificação</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Txt label="Cliente" value={f.cliente} onChange={set('cliente')} />
            <Txt label="UC" value={f.uc} onChange={set('uc')} />
            <Txt label="Distribuidora" value={f.concessionaria} onChange={set('concessionaria')} />
            <Txt label="CNPJ" value={f.cnpj} onChange={set('cnpj')} />
            <Txt label="Endereço" value={f.endereco_completo} onChange={set('endereco_completo')} />
            <Txt label="Nº protocolo" value={f.numero_protocolo} onChange={set('numero_protocolo')} />
            <Txt label="Link da fatura" value={f.link_fatura} onChange={set('link_fatura')} />
          </div>

          <div className="cpv2-section-title" style={{ marginTop: 14 }}>Irregularidade</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Sel label="Tipo (opcional)" value={f.id_tipo_irregularidade} onChange={set('id_tipo_irregularidade')} opts={dim?.tipos_irregularidade || dim?.tipos} />
            <Sel label="Subtipo (opcional)" value={f.id_subtipo_irregularidade} onChange={set('id_subtipo_irregularidade')} opts={dim?.subtipos_irregularidade || dim?.subtipos} />
            <Txt label="Períodos" value={f.periodos_irregularidade} onChange={set('periodos_irregularidade')} />
            <Txt label="Descrição" value={f.descricao_irregularidade} onChange={set('descricao_irregularidade')} />
          </div>

          <div className="cpv2-section-title" style={{ marginTop: 14 }}>Valores · Repasse</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Txt label="Ressarcimento estimado (R$)" value={f.ressarcimento_estimado} onChange={set('ressarcimento_estimado')} type="number" />
            <Txt label="Crédito simples (R$)" value={f.credito_simples} onChange={set('credito_simples')} type="number" />
            <Txt label="Crédito dobro (R$)" value={f.credito_dobro} onChange={set('credito_dobro')} type="number" />
            <Txt label="Percentual do processo (%)" value={f.percentual_repasse} onChange={set('percentual_repasse')} type="number" step="0.01" min="0" max="100" />
          </div>
          <p style={{ fontSize: 11, color: 'var(--cpv2-text-muted)', margin: '6px 2px 0' }}>
            O percentual do processo sobrescreve o percentual da empresa apenas neste processo.
            Deixe em branco para voltar a usar o percentual geral da empresa.
          </p>

          <div style={{ marginTop: 14 }}>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
              <input type="checkbox" checked={f.relevancia} onChange={set('relevancia')} /> Relevante
            </label>
          </div>
        </div>
        <div className="cpv2-modal__footer">
          <button type="button" className="cpv2-btn" onClick={onClose} disabled={salvando}>Cancelar</button>
          <button type="button" className="cpv2-btn cpv2-btn--primary" onClick={salvar} disabled={salvando}>
            <Save size={13} /> {salvando ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  );
  return createPortal(content, document.body);
}
