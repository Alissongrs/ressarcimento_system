// Modal secundário: analista corrige dados extraídos de uma fatura.
// Chama PATCH /api/v1/faturas/:id — cada campo alterado gera 1 linha em FT_AUDIT_EDICAO.
import React, { useMemo, useState } from 'react';
import { X, Save, Send } from 'lucide-react';
import apiClient from '../../services/apiClient';
import { useAuth } from '../../context/AuthContext';

// Distribuidoras conhecidas — usadas no dropdown pra padronizar valores.
// Não é whitelist rígida: o usuário pode digitar outro valor no campo "Outra".
const DISTRIBUIDORAS = [
  'CPFL Piratininga',
  'CPFL Paulista',
  'CPFL Santa Cruz',
  'RGE',
  'RGE Sul',
  'CEMIG Distribuição S.A.',
  'ENEL DISTRIBUIÇÃO SÃO PAULO S.A.',
  'ENEL DISTRIBUIÇÃO CEARÁ S.A.',
  'Light Serviços de Eletricidade S.A.',
  'Copel Distribuição S.A.',
  'Celesc Distribuição S.A.',
  'Elektro Redes S.A.',
  'EDP São Paulo Distribuição de Energia',
  'EDP ES Distribuição de Energia S.A.',
  'ENERGISA MATO GROSSO',
  'ENERGISA MS',
  'ENERGISA MG',
  'ENERGISA SUL-SUDESTE',
  'ENERGISA SERGIPE',
  'ENERGISA TOCANTINS',
  'ENERGISA RONDÔNIA',
  'ENERGISA PARAÍBA',
  'ENERGISA ACRE',
  'ENERGISA MINAS RIO',
  'Neoenergia Coelba',
  'Neoenergia Pernambuco',
  'Neoenergia Cosern',
  'Neoenergia Brasília',
  'Equatorial Goiás',
  'Equatorial Pará',
  'Equatorial Piauí',
  'Equatorial Maranhão',
  'Ampla Energia e Serviços S.A.',
  'AMAZONAS ENERGIA',
  'DME Distribuição',
];

// Campos editáveis. Precisa espelhar a whitelist no backend.
const CAMPOS = [
  { key: 'distribuidora', label: 'Distribuidora', type: 'dropdown', options: DISTRIBUIDORAS },
  { key: 'cnpj_distribuidora_filial', label: 'CNPJ distribuidora', type: 'string' },
  { key: 'uf_distribuidora', label: 'UF', type: 'string' },
  { key: 'mes_referencia', label: 'Mês referência', type: 'date' },
  { key: 'grupo_tarifario', label: 'Grupo tarifário', type: 'string' },
  { key: 'subgrupo_tarifario', label: 'Subgrupo', type: 'string' },
  { key: 'modalidade_tarifaria', label: 'Modalidade', type: 'string' },
  { key: 'classe_consumidor', label: 'Classe', type: 'string' },
  { key: 'consumo_ativo_ponta_kwh', label: 'Consumo Ponta (kWh)', type: 'number' },
  { key: 'consumo_ativo_fponta_kwh', label: 'Consumo F.Ponta (kWh)', type: 'number' },
  { key: 'consumo_ativo_reservado_kwh', label: 'Consumo Reservado (kWh)', type: 'number' },
  { key: 'kwh_total', label: 'Consumo Total (kWh)', type: 'number' },
  { key: 'valor_total_fatura', label: 'Valor total (R$)', type: 'number' },
  { key: 'numero_fatura', label: 'Nº fatura', type: 'string' },
  { key: 'numero_medidor', label: 'Nº medidor', type: 'string' },
  { key: 'razao_social', label: 'Razão social', type: 'string' },
  { key: 'nome_cliente', label: 'Nome cliente', type: 'string' },
  { key: 'endereco_uc', label: 'Endereço UC', type: 'string' },
  { key: 'cep_uc', label: 'CEP UC', type: 'string' },
  { key: 'data_leitura_anterior', label: 'Leitura anterior', type: 'date' },
  { key: 'data_leitura_atual', label: 'Leitura atual', type: 'date' },
];

function toInputValue(v, type) {
  if (v == null) return '';
  if (type === 'date') {
    const s = String(v);
    // aceita 'YYYY-MM-DD' e 'YYYY-MM-DDTHH:MM:SS'
    return s.slice(0, 10);
  }
  return String(v);
}

export default function ModalCorrigirDadosFatura({ open, fatura, onClose, onSaved }) {
  const idFatura = fatura?.id;
  const { user } = useAuth() || {};
  const isAdmin = String(user?.tipo_conta || '').toLowerCase() === 'admin';

  const inicial = useMemo(() => {
    const out = {};
    for (const c of CAMPOS) out[c.key] = toInputValue(fatura?.[c.key], c.type);
    return out;
  }, [fatura]);

  const [valores, setValores] = useState(inicial);
  const [motivo, setMotivo] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [ok, setOk] = useState(null);

  // reset quando abre outra fatura
  React.useEffect(() => {
    setValores(inicial);
    setMotivo('');
    setErro('');
    setOk(null);
  }, [inicial]);

  // TODOS os hooks ANTES de qualquer return condicional (regras de hooks).
  const alteracoes = useMemo(() => {
    const diff = {};
    for (const c of CAMPOS) {
      const orig = inicial[c.key];
      const novo = valores[c.key];
      if ((orig || '') !== (novo || '')) diff[c.key] = novo;
    }
    return diff;
  }, [inicial, valores]);

  const qtdAlteracoes = Object.keys(alteracoes).length;

  if (!open) return null;

  const handleSalvar = async () => {
    if (qtdAlteracoes === 0) {
      setErro('Nenhum campo foi alterado.');
      return;
    }
    if (motivo.trim().length < 5) {
      setErro('Informe um motivo (mínimo 5 caracteres) — vai pra auditoria.');
      return;
    }
    setSalvando(true);
    setErro('');
    setOk(null);
    try {
      // Converte pra tipo certo pro backend
      const payload = {};
      for (const [k, v] of Object.entries(alteracoes)) {
        const def = CAMPOS.find((c) => c.key === k);
        if (def?.type === 'number') {
          const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
          payload[k] = Number.isFinite(n) ? n : null;
        } else {
          payload[k] = v || null;
        }
      }
      if (isAdmin) {
        // Admin aplica direto no FDE.
        const res = await apiClient.patch(`/api/v1/faturas/${idFatura}`, {
          campos: payload,
          motivo: motivo.trim(),
        });
        setOk({ ...res.data, _modo: 'aplicado' });
        if (onSaved) onSaved(res.data);
      } else {
        // Fila de correções pendentes descontinuada — apenas administradores aplicam correções.
        setErro('Apenas administradores podem aplicar correções na fatura.');
        return;
      }
    } catch (e) {
      setErro(e?.response?.data?.error || e?.message || 'Falha ao salvar.');
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div
      className="cpv2-modal-backdrop"
      style={{ zIndex: 200 }}
      onClick={(e) => e.target === e.currentTarget && onClose?.()}
    >
      <div className="cpv2-modal" style={{ width: 'min(880px, 96vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div className="cpv2-modal__head">
          <div>
            <h3>{isAdmin ? 'Corrigir dados da fatura' : 'Solicitar correção da fatura'}</h3>
            <p>
              ID {idFatura} — {qtdAlteracoes} campo(s) alterado(s)
              {!isAdmin && ' · vai para aprovação do administrador'}
            </p>
          </div>
          <button className="cpv2-modal__close" onClick={onClose} title="Fechar">
            <X size={18} />
          </button>
        </div>

        <div className="cpv2-modal__body" style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 10,
          }}>
            {CAMPOS.map((c) => {
              const mudou = (inicial[c.key] || '') !== (valores[c.key] || '');
              return (
                <div key={c.key} className="cpv2-step-form__field" style={{ margin: 0 }}>
                  <label style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between' }}>
                    <span>{c.label}</span>
                    {mudou && <span style={{ color: 'var(--cpv2-brand)' }}>● alterado</span>}
                  </label>
                  {c.type === 'dropdown' ? (
                    <>
                      <select
                        value={c.options?.includes(valores[c.key]) ? valores[c.key] : ''}
                        onChange={(e) => setValores({ ...valores, [c.key]: e.target.value })}
                      >
                        <option value="">— (personalizado abaixo) —</option>
                        {c.options.map((o) => (
                          <option key={o} value={o}>{o}</option>
                        ))}
                      </select>
                      {!c.options?.includes(valores[c.key]) && (
                        <input
                          type="text"
                          value={valores[c.key] || ''}
                          onChange={(e) => setValores({ ...valores, [c.key]: e.target.value })}
                          placeholder="ou digite outra distribuidora"
                          style={{ marginTop: 4 }}
                        />
                      )}
                    </>
                  ) : c.type === 'date' ? (
                    <input
                      type="date"
                      value={valores[c.key] || ''}
                      onChange={(e) => setValores({ ...valores, [c.key]: e.target.value })}
                    />
                  ) : (
                    <input
                      type={c.type === 'number' ? 'text' : 'text'}
                      inputMode={c.type === 'number' ? 'decimal' : undefined}
                      value={valores[c.key] || ''}
                      onChange={(e) => setValores({ ...valores, [c.key]: e.target.value })}
                    />
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: 16 }}>
            <label style={{ fontSize: 11, fontWeight: 600 }}>Motivo da correção (obrigatório — vai pra auditoria)</label>
            <textarea
              rows={2}
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Ex.: CNPJ da fatura é 04.172.213/0001-51, pipeline classificou como Santa Cruz mas é CPFL Piratininga."
              style={{ width: '100%' }}
            />
          </div>

          {erro && (
            <div style={{ marginTop: 10, color: 'var(--cpv2-danger)', fontSize: 12 }}>{erro}</div>
          )}
          {ok && (
            <div style={{ marginTop: 10, color: 'var(--cpv2-success)', fontSize: 12 }}>
              {ok._modo === 'pendente'
                ? `✓ ${ok.alteracoes} correção(ões) enviada(s) para aprovação do administrador. A fatura só muda após ele aprovar.`
                : `✓ ${ok.alteracoes} alteração(ões) salva(s). Auditadas em FT_AUDIT_EDICAO.`}
            </div>
          )}
        </div>

        <div className="cpv2-modal__footer">
          <button className="cpv2-btn cpv2-btn--ghost" onClick={onClose} disabled={salvando}>Cancelar</button>
          <button
            className="cpv2-btn cpv2-btn--primary"
            onClick={handleSalvar}
            disabled={salvando || qtdAlteracoes === 0}
          >
            {isAdmin ? <Save size={14} /> : <Send size={14} />}
            {salvando
              ? (isAdmin ? 'Salvando…' : 'Enviando…')
              : isAdmin
                ? `Salvar ${qtdAlteracoes} alteração(ões)`
                : `Enviar ${qtdAlteracoes} p/ aprovação`}
          </button>
        </div>
      </div>
    </div>
  );
}
