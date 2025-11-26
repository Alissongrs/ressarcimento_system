import React, { useRef, useState } from 'react';
import { criarRequisicao, buscarUC, buscarFaturasPorUnidadeMeses } from '../services/requisicaoService';
import { useAuth } from '../context/AuthContext.jsx';
import { Search, HelpCircle, X, FileText, Loader2 } from 'lucide-react';
import Toast from '../components/Toast.jsx';

const MESES_PT_BR = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

const RequisicaoForm = () => {
  const toStr = (v) => {
    if (v == null) return '';
    if (typeof v === 'object') {
      if ('Valid' in v && v.Valid === false) return '';
      if ('String' in v) return v.String ?? '';
    }
    return String(v);
  };
  const { user } = useAuth();
  const [formData, setFormData] = useState({
    prioridade: 'Baixa',
    uc: '',
    id_uc: '',
    id_empresa: '',
    cliente: '',
    razaoSocialFatura: '',
    concessionaria: '',
    cnpj: '',
    enderecoCompleto: '',
    ressarcimentoEstimado: '',
    descricaoIrregularidade: '',
    linkFatura: '',
  });

  const [periodos, setPeriodos] = useState([{ mes: '', ano: '' }]);
  const [anexos, setAnexos] = useState([]);
  const fileInputRef = useRef(null);
  const [isUcEncontrada, setIsUcEncontrada] = useState(false);
  const [isLoadingUc, setIsLoadingUc] = useState(false);
  const [ucError, setUcError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isFieldDisabled = isUcEncontrada;
  const [ucLinksDetalhes, setUcLinksDetalhes] = useState([]);
  const [toast, setToast] = useState({ open: false, type: 'info', text: '' });

  const showToast = (type, text, timeout = 3000) => {
    setToast({ open: true, type, text });
    window.setTimeout(() => setToast((t) => ({ ...t, open: false })), timeout);
  };

  const formatCNPJ = (value) => {
    const v = String(value || '').replace(/\D/g, '').slice(0, 14);
    const p1 = v.slice(0, 2);
    const p2 = v.slice(2, 5);
    const p3 = v.slice(5, 8);
    const p4 = v.slice(8, 12);
    const p5 = v.slice(12, 14);
    let out = '';
    if (p1) out = p1;
    if (p2) out = `${p1}.${p2}`;
    if (p3) out = `${p1}.${p2}.${p3}`;
    if (p4) out = `${p1}.${p2}.${p3}/${p4}`;
    if (p5) out = `${p1}.${p2}.${p3}/${p4}-${p5}`;
    return out;
  };
  const unformatNumber = (s) => String(s || '').replace(/\./g, '').replace(',', '.').replace(/[^0-9.]/g, '');
  const formatMoneyBR = (v) => {
    const n = Number(unformatNumber(v));
    if (!Number.isFinite(n)) return '';
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    if (name === 'cnpj') {
      setFormData((prev) => ({ ...prev, cnpj: formatCNPJ(value) }));
      return;
    }
    if (name === 'ressarcimentoEstimado') {
      const raw = unformatNumber(value);
      setFormData((prev) => ({ ...prev, ressarcimentoEstimado: raw }));
      return;
    }
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files || []);
    setAnexos((prev) => [...prev, ...files]);
  };

  const removeAnexo = (idx) => {
    setAnexos((prev) => prev.filter((_, i) => i !== idx));
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handlePeriodoChange = (index, event) => {
    const values = [...periodos];
    values[index][event.target.name] = event.target.value;
    setPeriodos(values);
  };

  const handleAddPeriodo = () => {
    setPeriodos([...periodos, { mes: '', ano: '' }]);
  };

  const handleRemovePeriodo = (index) => {
    if (periodos.length > 1) {
      const values = [...periodos];
      values.splice(index, 1);
      setPeriodos(values);
    }
  };

  const handleBuscarUc = async () => {
    if (!formData.uc) {
      setUcError('Por favor, digite o número da UC.');
      return;
    }
    setIsLoadingUc(true);
    setUcError('');
    try {
      const dados = await buscarUC(formData.uc, []);
      setFormData((prev) => ({
        ...prev,
        id_uc: String(dados?.id_uc || prev.id_uc || ''),
        id_empresa: String(dados?.id_empresa || prev.id_empresa || ''),
        id_concessionaria: String(dados?.id_concessionaria || prev.id_concessionaria || ''),
        cliente: toStr(dados.cliente) || toStr(dados.nome_cliente) || '',
        razaoSocialFatura: toStr(dados.razao_social_fatura) || '',
        concessionaria: toStr(dados.concessionaria) || '',
        cnpj: formatCNPJ(toStr(dados.cnpj) || ''),
        enderecoCompleto: toStr(dados.endereco_completo) || '',
        linkFatura: prev.linkFatura,
      }));
      setUcLinksDetalhes([]);
      setIsUcEncontrada(true);
    } catch (error) {
      setIsUcEncontrada(false);
      setUcError('UC não encontrada. Por favor, preencha os campos manualmente.');
      setFormData((prev) => ({
        ...prev,
        cliente: '',
        razaoSocialFatura: '',
        concessionaria: '',
        cnpj: '',
        enderecoCompleto: '',
        linkFatura: '',
      }));
    } finally {
      setIsLoadingUc(false);
    }
  };

  const handleBuscarFaturas = async () => {
    if (!formData.uc) {
      setUcError('Informe a UC antes de buscar faturas.');
      return;
    }
    setIsLoadingUc(true);
    setUcError('');
    try {
      const mesesRefs = (periodos || [])
        .map((p) => {
          const y = String(p.ano || '').trim();
          const m = String(p.mes || '').trim();
          if (!y || !m) return null;
          const mm = String(m).padStart(2, '0');
          return `${y}-${mm}`;
        })
        .filter(Boolean);
      // Preferir busca por id_uc + id_empresa + id_concessionaria para evitar faturas de outras combinações
      let dados;
      if (formData.id_uc) {
        try {
          dados = await buscarFaturasPorIdUcMeses(
            formData.id_uc,
            mesesRefs,
            formData.id_empresa,
            formData.id_concessionaria
          );
        } catch {
          dados = await buscarFaturasPorUnidadeMeses(formData.uc, mesesRefs);
        }
      } else {
        dados = await buscarFaturasPorUnidadeMeses(formData.uc, mesesRefs);
      }
      const detList = Array.isArray(dados.links_faturas_detalhes)
        ? dados.links_faturas_detalhes.map((it) => ({ link: toStr(it.link), mes_ref: toStr(it.mes_ref) }))
        : (Array.isArray(dados.links_faturas)
            ? dados.links_faturas.map((l) => ({ link: toStr(l), mes_ref: '' }))
            : (toStr(dados.link_fatura) ? [{ link: toStr(dados.link_fatura), mes_ref: '' }] : [])
          );
      setUcLinksDetalhes(detList);
      if (detList.length === 0) setUcError('Nenhuma fatura encontrada para os meses informados.');
    } catch (e) {
      setUcError('Falha ao buscar faturas. Verifique os meses e a UC.');
    } finally {
      setIsLoadingUc(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!anexos || anexos.length === 0) {
      showToast('error', 'Anexe ao menos um arquivo.');
      return;
    }
    if (!formData.ressarcimentoEstimado || Number(unformatNumber(formData.ressarcimentoEstimado)) <= 0) {
      showToast('error', 'Informe um valor de ressarcimento válido.');
      return;
    }
    setIsSubmitting(true);
    const data = new FormData();
    for (const key in formData) {
      data.append(key, formData[key]);
    }
    data.append('periodosIrregularidade', JSON.stringify(periodos));
    data.append('RessarcimentoEstimado', formData.ressarcimentoEstimado);
    anexos.forEach((f) => data.append('anexos', f));
    try {
      await criarRequisicao(data);
      showToast('success', 'Requisição enviada com sucesso!');
      setFormData({
        prioridade: 'Baixa', uc: '', cliente: '', razaoSocialFatura: '',
        concessionaria: '', cnpj: '', enderecoCompleto: '',
        ressarcimentoEstimado: '', descricaoIrregularidade: '', linkFatura: '',
      });
      setPeriodos([{ mes: '', ano: '' }]);
      setAnexos([]);
      setIsUcEncontrada(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (error) {
      showToast('error', 'Falha ao enviar. Verifique os dados e tente novamente.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6 text-[var(--fg)]">
      <div className="glass-card border border-[var(--border)] rounded-lg p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Nova Requisição</h1>
        </div>
        <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="md:col-span-2">
            <label className="block font-semibold text-[var(--fg)] mb-1 flex items-center gap-1">UC * <HelpCircle size={14} className="opacity-70"/></label>
            <div className="flex gap-2">
              <input type="text" inputMode="numeric" name="uc" value={formData.uc} onChange={handleChange} className={`flex-1 p-2 border border-[var(--border)] rounded text-[var(--fg)] glass-card bg-[var(--panel)]`} required placeholder="Ex.: 48341497" />
              <button type="button" onClick={handleBuscarUc} disabled={isLoadingUc} className="px-3 py-2 bg-[var(--accent)] text-[var(--fg)] rounded hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-2">
                {isLoadingUc ? (<><Loader2 className="animate-spin" size={16}/> Buscando</>) : (<><Search size={16}/> Buscar</>)}
              </button>
            </div>
            {ucError && <p className="text-xs text-red-400 mt-1">{ucError}</p>}
          </div>
          <div>
            <label className="block font-semibold text-[var(--fg)] mb-1">Prioridade *</label>
            <select name="prioridade" value={formData.prioridade} onChange={handleChange} className="w-full p-2 border border-[var(--border)] rounded glass-card bg-[var(--panel)] text-[var(--fg)]">
              <option>Baixa</option>
              <option>Média</option>
              <option>Alta</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="block font-semibold text-[var(--fg)] mb-1">Cliente</label>
            <input type="text" name="cliente" value={formData.cliente} onChange={handleChange} className={`w-full p-2 border border-[var(--border)] rounded text-[var(--fg)] glass-card bg-[var(--panel)]`} readOnly={isFieldDisabled} />
          </div>
          <div>
            <label className="block font-semibold text-[var(--fg)] mb-1">Razão Social (Fatura)</label>
            <input type="text" name="razaoSocialFatura" value={formData.razaoSocialFatura} onChange={handleChange} className={`w-full p-2 border border-[var(--border)] rounded text-[var(--fg)] glass-card bg-[var(--panel)]`} readOnly={isFieldDisabled} />
          </div>
          <div>
            <label className="block font-semibold text-[var(--fg)] mb-1">CNPJ *</label>
            <input type="text" inputMode="numeric" name="cnpj" value={formData.cnpj} onChange={handleChange} className={`w-full p-2 border border-[var(--border)] rounded text-[var(--fg)] glass-card bg-[var(--panel)]`} required readOnly={isFieldDisabled} placeholder="00.000.000/0000-00" />
          </div>
          <div>
            <label className="block font-semibold text-[var(--fg)] mb-1">Distribuidora *</label>
            <input type="text" name="concessionaria" value={formData.concessionaria} onChange={handleChange} className={`w-full p-2 border border-[var(--border)] rounded text-[var(--fg)] glass-card bg-[var(--panel)]`} required readOnly={isFieldDisabled} />
          </div>
        </div>

        <div>
          <label className="block font-semibold text-[var(--fg)] mb-1">Endereço</label>
          <input type="text" name="enderecoCompleto" value={formData.enderecoCompleto} onChange={handleChange} className={`w-full p-2 border border-[var(--border)] rounded text-[var(--fg)] glass-card bg-[var(--panel)]`} readOnly={isFieldDisabled} />
        </div>

        <div>
          <label className="block font-semibold text-[var(--fg)] mb-1">Ressarcimento Estimado (R$) *</label>
          <input type="text" inputMode="decimal" name="ressarcimentoEstimado" value={formData.ressarcimentoEstimado} onChange={handleChange} className="w-full p-2 border border-[var(--border)] rounded glass-card bg-[var(--panel)] text-[var(--fg)]" required placeholder="0,00" />
          <div className="text-xs opacity-70 mt-1">{formatMoneyBR(formData.ressarcimentoEstimado) || 'R$ 0,00'}</div>
        </div>

        <div>
          <label className="block font-semibold text-[var(--fg)] mb-2">Período(s) da Irregularidade *</label>
          {periodos.map((p, index) => (
            <div key={index} className="flex items-center space-x-2 mb-2">
              <select name="mes" value={p.mes} onChange={(e) => handlePeriodoChange(index, e)} className="w-full p-2 border border-[var(--border)] rounded glass-card bg-[var(--panel)] text-[var(--fg)]" required>
                <option value="">Mês</option>
                {MESES_PT_BR.map((mesLabel, i) => (
                  <option key={i} value={i + 1}>{mesLabel}</option>
                ))}
              </select>
              <input type="number" name="ano" value={p.ano} onChange={(e) => handlePeriodoChange(index, e)} placeholder="Ano" className="w-full p-2 border border-[var(--border)] rounded glass-card bg-[var(--panel)] text-[var(--fg)]" required />
              {periodos.length > 1 && (
                <button type="button" onClick={() => handleRemovePeriodo(index)} className="px-3 py-2 bg-red-500 text-[var(--fg)] rounded-lg hover:bg-red-600 inline-flex items-center gap-1">
                  <X size={14}/> Remover
                </button>
              )}
            </div>
          ))}
          <div className="mt-2 flex items-center gap-2"><button type="button" onClick={handleAddPeriodo} className="px-4 py-2 bg-green-600 text-[var(--fg)] text-sm font-semibold rounded-lg hover:bg-green-700">+ Adicionar Período</button><button type="button" onClick={handleBuscarFaturas} disabled={isLoadingUc} className="px-4 py-2 bg-[var(--accent)] text-[var(--fg)] text-sm font-semibold rounded-lg hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-2">{isLoadingUc ? (<><Loader2 className="animate-spin" size={16}/> Buscando...</>) : 'Buscar faturas'}</button></div>
        </div>

        <div>
          <label className="block font-semibold text-[var(--fg)] mb-1">Descrição da Irregularidade *</label>
          <textarea name="descricaoIrregularidade" value={formData.descricaoIrregularidade} onChange={handleChange} className="w-full p-2 border border-[var(--border)] rounded glass-card bg-[var(--panel)] text-[var(--fg)]" rows="4" required />
        </div>
        <div>
          <label className="block font-semibold text-[var(--fg)] mb-1">Anexos *</label>
          <input ref={fileInputRef} type="file" name="anexos" onChange={handleFileChange} className="w-full text-sm text-gray-200 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-blue-100 file:text-blue-700 hover:file:bg-blue-200" multiple required />
          {anexos.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm">
              {anexos.map((f, idx) => (
                <li key={`${f.name}-${idx}`} className="flex items-center gap-2">
                  <FileText size={14} className="opacity-70"/>
                  <span className="truncate max-w-[60%]" title={f.name}>{f.name}</span>
                  <span className="opacity-60">({(f.size/1024).toFixed(0)} KB)</span>
                  <button type="button" onClick={() => removeAnexo(idx)} className="ml-auto text-xs underline text-red-400">remover</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <label className="block font-semibold text-[var(--fg)] mb-1">Link da Fatura (Opcional)</label>
          <input type="url" name="linkFatura" value={formData.linkFatura} onChange={handleChange} className={`w-full p-2 border border-[var(--border)] rounded text-[var(--fg)] glass-card bg-[var(--panel)]`} readOnly={isFieldDisabled} placeholder="https://..." />
          {ucLinksDetalhes.length > 0 && (
            <div className="mt-2">
              <div className="text-xs opacity-70 mb-1">Faturas encontradas</div>
              <ul className="space-y-1 text-sm">
                {ucLinksDetalhes.map((it, idx) => (
                  <li key={`${(it.link || '')}-${idx}`} className="flex items-start gap-2">
                    {toStr(it.mes_ref) && <span className="opacity-70 shrink-0">{toStr(it.mes_ref)}</span>}
                    <a className="text-[var(--accent)] underline break-all" href={toStr(it.link)} target="_blank" rel="noreferrer">{toStr(it.link)}</a>
                    <button type="button" onClick={() => setFormData((prev) => ({ ...prev, linkFatura: toStr(it.link) }))} className="ml-auto text-xs underline text-[var(--accent)]">
                      Usar
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <button type="submit" className="w-full px-4 py-3 bg-blue-700 text-[var(--fg)] font-bold text-lg rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors" disabled={isSubmitting}>
          {isSubmitting ? 'Enviando...' : 'Enviar Requisição'}
        </button>
      </form>
    </div>
    <Toast open={toast.open} type={toast.type} message={toast.text} onClose={() => setToast((t) => ({ ...t, open: false }))} />
    </div>
  );
};

export default RequisicaoForm;
