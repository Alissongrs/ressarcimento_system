import React, { useEffect, useRef, useState } from 'react';
import {
  criarRequisicao,
  buscarUC,
  buscarFaturasPorUnidadeMeses,
  buscarFaturasPorIdUcMeses,
  getUCOpcoes,
} from '../services/requisicaoService';
import { useAuth } from '../context/AuthContext.jsx';
import { Search, HelpCircle, X, FileText, Loader2, Clock } from 'lucide-react';
import Toast from '../components/Toast.jsx';

const MESES_PT_BR = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

const RequisicaoForm = ({ initialUc = '', manualMode: manualModeProp = false, onClose } = {}) => {
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
    problemaIdentificado: '',
    gostariaAnexarFatura: false,
  });

  const [periodos, setPeriodos] = useState([{ mes: '', ano: '' }]);
  const [periodoAte, setPeriodoAte] = useState(false);
  const [periodoFim, setPeriodoFim] = useState({ mes: '', ano: '' });
  const [anexos, setAnexos] = useState([]);
  const fileInputRef = useRef(null);
  const [isUcEncontrada, setIsUcEncontrada] = useState(false);
  const [isLoadingUc, setIsLoadingUc] = useState(false);
  const [ucError, setUcError] = useState('');
  const [faturasLoading, setFaturasLoading] = useState(false);
  const [faturasError, setFaturasError] = useState('');
  const [periodoError, setPeriodoError] = useState('');
  const [manualMode, setManualMode] = useState(false);
  const [manualPromptVisible, setManualPromptVisible] = useState(false);
  useEffect(() => {
    if (initialUc) setFormData((prev) => ({ ...prev, uc: initialUc }));
  }, [initialUc]);
  useEffect(() => {
    if (manualModeProp) {
      setManualMode(true);
      setManualPromptVisible(false);
    }
  }, [manualModeProp]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isFieldDisabled = isUcEncontrada && !manualMode;
  const [ucLinksDetalhes, setUcLinksDetalhes] = useState([]);
  const [faturasOpen, setFaturasOpen] = useState(false);
  const [toast, setToast] = useState({ open: false, type: 'info', text: '' });
  const [ucOpcoes, setUcOpcoes] = useState([]);
  const [ucOpcaoIdx, setUcOpcaoIdx] = useState(null);
  const [createdReqId, setCreatedReqId] = useState(null);

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

  const buildMesRef = (mes, ano) => {
    const y = String(ano || '').trim();
    const m = String(mes || '').trim();
    if (!y || !m) return '';
    return `${y}-${String(m).padStart(2, '0')}`;
  };

  const expandRange = (startRef, endRef) => {
    if (!startRef || !endRef) return [];
    const [sy, sm] = startRef.split('-').map((v) => Number(v));
    const [ey, em] = endRef.split('-').map((v) => Number(v));
    if (!sy || !sm || !ey || !em) return [];
    const out = [];
    let y = sy;
    let m = sm;
    while (y < ey || (y === ey && m <= em)) {
      out.push(`${y}-${String(m).padStart(2, '0')}`);
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
      if (out.length > 240) break;
    }
    return out;
  };

  const buildPeriodosList = () => {
    if (periodoAte) {
      const start = buildMesRef(periodos[0]?.mes, periodos[0]?.ano);
      const end = buildMesRef(periodoFim.mes, periodoFim.ano);
      const refs = expandRange(start, end);
      return refs.map((ref) => {
        const [y, m] = ref.split('-');
        return { mes: m, ano: y };
      });
    }
    return (periodos || []).map((p) => ({ mes: String(p.mes || ''), ano: String(p.ano || '') }));
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
    if (name === 'gostariaAnexarFatura') {
      setFormData((prev) => ({ ...prev, [name]: e.target.checked }));
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

  const handleUcOpcaoChange = (value) => {
    if (value === '') {
      setUcOpcaoIdx(null);
      setFormData((prev) => ({
        ...prev,
        cliente: '',
        concessionaria: '',
        id_uc: prev.id_uc,
        id_empresa: prev.id_empresa,
        id_concessionaria: prev.id_concessionaria,
      }));
      return;
    }
    const idx = Number(value);
    const opt = (ucOpcoes || [])[idx];
    if (!opt) return;
    setUcOpcaoIdx(idx);
    setFormData((prev) => ({
      ...prev,
      id_uc: String(opt.id_uc ?? prev.id_uc ?? ''),
      id_empresa: String(opt.id_empresa ?? prev.id_empresa ?? ''),
      id_concessionaria: String(opt.id_concessionaria ?? prev.id_concessionaria ?? ''),
      cliente: toStr(opt.cliente) || '',
      concessionaria: toStr(opt.concessionaria) || '',
    }));
  };

  const handleBuscarUc = async () => {
    if (!formData.uc) {
      setUcError('Por favor, digite o número da UC.');
      return;
    }
    setManualPromptVisible(false);
    setIsLoadingUc(true);
    setUcError('');
    try {
      const dados = await buscarUC(formData.uc, []);
      const opcoes = await getUCOpcoes(formData.uc);
      setUcOpcoes(Array.isArray(opcoes) ? opcoes : []);
      setUcOpcaoIdx(null);

      setFormData((prev) => ({
        ...prev,
        id_uc: String(dados?.id_uc || prev.id_uc || ''),
        id_empresa: String(dados?.id_empresa || prev.id_empresa || ''),
        id_concessionaria: String(dados?.id_concessionaria || prev.id_concessionaria || ''),
        cliente: (Array.isArray(opcoes) && opcoes.length ? '' : (toStr(dados.cliente) || toStr(dados.nome_cliente) || '')),
        razaoSocialFatura: toStr(dados.razao_social_fatura) || '',
        concessionaria: (Array.isArray(opcoes) && opcoes.length ? '' : toStr(dados.concessionaria) || ''),
        cnpj: formatCNPJ(toStr(dados.cnpj) || ''),
        enderecoCompleto: toStr(dados.endereco_completo) || '',
        linkFatura: prev.linkFatura,
      }));
      setManualMode(false);
      setManualPromptVisible(false);
      setUcLinksDetalhes([]);
      setIsUcEncontrada(true);
    } catch (error) {
      setIsUcEncontrada(false);
      setUcError('UC não encontrada. Por favor, preencha os campos manualmente.');
      setUcOpcoes([]);
      setUcOpcaoIdx(null);
      setFormData((prev) => ({
        ...prev,
        cliente: '',
        razaoSocialFatura: '',
        concessionaria: '',
        cnpj: '',
        enderecoCompleto: '',
        linkFatura: '',
      }));
      setManualPromptVisible(true);
    } finally {
      setIsLoadingUc(false);
    }
  };

  const handleBuscarFaturas = async (mesesRefs) => {
    if (!formData.uc) {
      setFaturasError('Informe a UC antes de buscar faturas.');
      return;
    }
    if (!mesesRefs || mesesRefs.length === 0) {
      setUcLinksDetalhes([]);
      return;
    }
    setFaturasLoading(true);
    setFaturasError('');
    try {
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
      if (detList.length === 0) {
        setFaturasError('Nenhuma fatura encontrada para os meses informados.');
      }
    } catch (e) {
      setFaturasError('Falha ao buscar faturas. Verifique os meses e a UC.');
    } finally {
      setFaturasLoading(false);
    }
  };

  useEffect(() => {
    setPeriodoError('');
    const refs = periodoAte
      ? expandRange(
          buildMesRef(periodos[0]?.mes, periodos[0]?.ano),
          buildMesRef(periodoFim.mes, periodoFim.ano),
        )
      : (periodos || [])
          .map((p) => buildMesRef(p.mes, p.ano))
          .filter(Boolean);
    if (periodoAte) {
      const startRef = buildMesRef(periodos[0]?.mes, periodos[0]?.ano);
      const endRef = buildMesRef(periodoFim.mes, periodoFim.ano);
      if (startRef && endRef) {
        const [sy, sm] = startRef.split('-').map(Number);
        const [ey, em] = endRef.split('-').map(Number);
        if (ey < sy || (ey === sy && em < sm)) {
          setPeriodoError('Período inválido: o fim deve ser maior ou igual ao início.');
          setUcLinksDetalhes([]);
          return;
        }
      }
    }
    if (!formData.uc || refs.length === 0) return;
    const t = setTimeout(() => handleBuscarFaturas(refs), 250);
    return () => clearTimeout(t);
  }, [formData.uc, formData.id_uc, formData.id_empresa, formData.id_concessionaria, periodos, periodoAte, periodoFim]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!manualMode && (ucOpcoes || []).length > 0 && ucOpcaoIdx == null) {
      showToast('error', 'Selecione o cliente/concessionária.');
      return;
    }
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
    data.append('periodosIrregularidade', JSON.stringify(buildPeriodosList()));
    data.append('RessarcimentoEstimado', formData.ressarcimentoEstimado);
    anexos.forEach((f) => data.append('anexos', f));
    try {
      const resp = await criarRequisicao(data);
      const reqId = resp?.data?.id;
      const msg = reqId ? `Req#${reqId} criada!` : 'Requisição enviada com sucesso!';
      showToast('success', msg);
      if (reqId) setCreatedReqId(reqId);
      setFormData({
        uc: '',
        id_uc: '',
        id_empresa: '',
        id_concessionaria: '',
        cliente: '',
        razaoSocialFatura: '',
        concessionaria: '',
        cnpj: '',
        enderecoCompleto: '',
        ressarcimentoEstimado: '',
        descricaoIrregularidade: '',
        linkFatura: '',
        problemaIdentificado: '',
        gostariaAnexarFatura: false,
      });
      setPeriodos([{ mes: '', ano: '' }]);
      setAnexos([]);
      setIsUcEncontrada(false);
      setManualMode(false);
      setManualPromptVisible(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (error) {
      showToast('error', 'Falha ao enviar. Verifique os dados e tente novamente.');
    } finally {
      setIsSubmitting(false);
    if (onClose) onClose();
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6 text-[var(--fg)]">
      <div className="glass-card border border-[var(--border)] rounded-lg p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Nova Requisição</h1>
        </div>
        <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid grid-cols-1 gap-4">
          <div>
          <label className="flex font-semibold text-[var(--fg)] mb-1 items-center gap-1">UC * <HelpCircle size={14} className="opacity-70"/></label>
            <div className="flex gap-2">
              <input type="text" inputMode="numeric" name="uc" value={formData.uc} onChange={handleChange} className={`flex-1 p-2 border border-[var(--border)] rounded text-[var(--fg)] glass-card bg-[var(--panel)]`} required placeholder="Ex.: 48341497" />
              <button type="button" onClick={handleBuscarUc} disabled={isLoadingUc} className="px-3 py-2 bg-[var(--accent)] text-[var(--fg)] rounded hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-2">
                {isLoadingUc ? (<><Loader2 className="animate-spin" size={16}/> Buscando</>) : (<><Search size={16}/> Buscar</>)}
              </button>
            </div>
            {ucError && (
              <div className="text-xs text-red-400 mt-1">
                <p>{ucError}</p>
                {!manualMode && manualPromptVisible && (
                  <button
                    type="button"
                    className="text-xs underline text-amber-500"
                    onClick={() => {
                      setManualMode(true);
                      setManualPromptVisible(false);
                    }}
                  >
                    Sim, quero inserir manualmente
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="block font-semibold text-[var(--fg)] mb-1">Cliente</label>
            {(!manualMode && (ucOpcoes || []).length > 0) ? (
              <select
                className="w-full p-2 border border-[var(--border)] rounded text-[var(--fg)] glass-card bg-[var(--panel)]"
                value={ucOpcaoIdx == null ? '' : String(ucOpcaoIdx)}
                onChange={(e) => handleUcOpcaoChange(e.target.value)}
                required
              >
                <option value="">Selecione...</option>
                {(ucOpcoes || []).map((opt, idx) => (
                  <option key={`cli-${opt?.id_uc}-${opt?.id_empresa}-${idx}`} value={idx}>
                    {toStr(opt?.cliente) || 'Cliente'}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                name="cliente"
                value={formData.cliente}
                onChange={handleChange}
                className="w-full p-2 border border-[var(--border)] rounded text-[var(--fg)] glass-card bg-[var(--panel)]"
                readOnly={isFieldDisabled}
                required={manualMode}
              />
            )}
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
            {(!manualMode && (ucOpcoes || []).length > 0) ? (
              <select
                className="w-full p-2 border border-[var(--border)] rounded text-[var(--fg)] glass-card bg-[var(--panel)]"
                value={ucOpcaoIdx == null ? '' : String(ucOpcaoIdx)}
                onChange={(e) => handleUcOpcaoChange(e.target.value)}
                required
              >
                <option value="">Selecione...</option>
                {(ucOpcoes || []).map((opt, idx) => {
                  const nome = toStr(opt?.concessionaria) || 'Distribuidora';
                  const sigla = toStr(opt?.sigla);
                  return (
                    <option key={`conc-${opt?.id_uc}-${opt?.id_concessionaria}-${idx}`} value={idx}>
                      {sigla ? `${nome} (${sigla})` : nome}
                    </option>
                  );
                })}
              </select>
            ) : (
              <input
                type="text"
                name="concessionaria"
                value={formData.concessionaria}
                onChange={handleChange}
                className="w-full p-2 border border-[var(--border)] rounded text-[var(--fg)] glass-card bg-[var(--panel)]"
                required
                readOnly={isFieldDisabled}
              />
            )}
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
          <label className="block font-semibold text-[var(--fg)] mb-2">Qual o período da irregularidade? *</label>
          <div className="flex items-center gap-3 mb-2 text-xs">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={periodoAte}
                onChange={(e) => setPeriodoAte(e.target.checked)}
              />
              Até
            </label>
          </div>

          {!periodoAte && (
            <>
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
              <div className="mt-2 flex items-center gap-2">
                <button type="button" onClick={handleAddPeriodo} className="px-4 py-2 bg-green-600 text-[var(--fg)] text-sm font-semibold rounded-lg hover:bg-green-700">
                  + Adicionar Período
                </button>
              </div>
            </>
          )}

          {periodoAte && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <div className="flex items-center gap-2">
                <select
                  value={periodos[0]?.mes}
                  onChange={(e) => setPeriodos([{ ...periodos[0], mes: e.target.value, ano: periodos[0]?.ano }])}
                  className="w-full p-2 border border-[var(--border)] rounded glass-card bg-[var(--panel)] text-[var(--fg)]"
                  required
                >
                  <option value="">Mês inicial</option>
                  {MESES_PT_BR.map((mesLabel, i) => (
                    <option key={i} value={i + 1}>{mesLabel}</option>
                  ))}
                </select>
                <input
                  type="number"
                  value={periodos[0]?.ano}
                  onChange={(e) => setPeriodos([{ ...periodos[0], ano: e.target.value, mes: periodos[0]?.mes }])}
                  placeholder="Ano inicial"
                  className="w-full p-2 border border-[var(--border)] rounded glass-card bg-[var(--panel)] text-[var(--fg)]"
                  required
                />
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={periodoFim.mes}
                  onChange={(e) => setPeriodoFim((prev) => ({ ...prev, mes: e.target.value }))}
                  className="w-full p-2 border border-[var(--border)] rounded glass-card bg-[var(--panel)] text-[var(--fg)]"
                  required
                >
                  <option value="">Mês final</option>
                  {MESES_PT_BR.map((mesLabel, i) => (
                    <option key={i} value={i + 1}>{mesLabel}</option>
                  ))}
                </select>
                <input
                  type="number"
                  value={periodoFim.ano}
                  onChange={(e) => setPeriodoFim((prev) => ({ ...prev, ano: e.target.value }))}
                  placeholder="Ano final"
                  className="w-full p-2 border border-[var(--border)] rounded glass-card bg-[var(--panel)] text-[var(--fg)]"
                  required
                />
              </div>
            </div>
          )}
          {periodoError && (
            <div className="text-xs text-red-400 mt-2">{periodoError}</div>
          )}
        </div>

        <div>
          <label className="block font-semibold text-[var(--fg)] mb-1">Faturas encontradas</label>
          {faturasLoading ? (
            <div className="text-xs opacity-70 inline-flex items-center gap-2">
              <Loader2 className="animate-spin" size={14} /> Buscando faturas...
            </div>
          ) : faturasError ? (
            <div className="text-xs text-red-400">{faturasError}</div>
          ) : ucLinksDetalhes.length === 0 ? (
            <div className="text-xs opacity-70">Nenhuma fatura encontrada.</div>
          ) : (
            <div className="space-y-2 max-h-48 overflow-auto">
              <div className="text-xs opacity-70">
                {ucLinksDetalhes.length} fatura(s) encontrada(s)
              </div>
              {ucLinksDetalhes.map((it, idx) => (
                <div key={`${(it.link || '')}-${idx}`} className="flex items-start gap-2 text-sm border border-[var(--border)] rounded p-2 bg-[var(--panel)]">
                  {toStr(it.mes_ref) && <span className="opacity-70 shrink-0">{toStr(it.mes_ref)}</span>}
                  <a className="text-[var(--accent)] underline break-all" href={toStr(it.link)} target="_blank" rel="noreferrer">{toStr(it.link)}</a>
                  <button
                    type="button"
                    onClick={() => {
                      setFormData((prev) => ({ ...prev, linkFatura: toStr(it.link) }));
                    }}
                    className="ml-auto text-xs underline text-[var(--accent)]"
                  >
                    Usar
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="block font-semibold text-[var(--fg)] mb-1">Descrição da Irregularidade *</label>
          <textarea name="descricaoIrregularidade" value={formData.descricaoIrregularidade} onChange={handleChange} className="w-full p-2 border border-[var(--border)] rounded glass-card bg-[var(--panel)] text-[var(--fg)]" rows="4" required />
        </div>
        {manualMode && (
          <div className="p-4 border border-dashed border-amber-400 bg-[var(--panel)] text-[var(--fg)] rounded text-sm space-y-3">
            <div>
              <strong>Inserção manual:</strong> preencha os campos acima e informe adicionalmente o problema identificado e se deseja anexar uma fatura.
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1">Problema identificado *</label>
              <textarea
                name="problemaIdentificado"
                value={formData.problemaIdentificado}
                onChange={handleChange}
                className="w-full p-2 border border-[var(--border)] rounded glass-card bg-[var(--panel)] text-[var(--fg)]"
                rows="3"
                required={manualMode}
              />
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                name="gostariaAnexarFatura"
                checked={formData.gostariaAnexarFatura}
                onChange={handleChange}
              />
              Gostaria de anexar fatura manualmente
            </label>
          </div>
        )}
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
        </div>

        <button type="submit" className="w-full px-4 py-3 bg-blue-700 text-[var(--fg)] font-bold text-lg rounded-lg hover:bg-blue-800 disabled:opacity-50 transition-colors" disabled={isSubmitting}>
          {isSubmitting ? 'Enviando...' : 'Enviar Requisição'}
        </button>
      </form>
    </div>
    <Toast open={toast.open} type={toast.type} message={toast.text} onClose={() => setToast((t) => ({ ...t, open: false }))} />
    {createdReqId && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/60" onClick={() => setCreatedReqId(null)} />
        <div className="relative w-full max-w-md bg-[var(--panel)] border border-[var(--border)] rounded-lg shadow-xl p-5 text-[var(--fg)]">
          <div className="text-lg font-bold mb-2">Requisição criada</div>
          <div className="text-sm opacity-80">Req#{createdReqId} criada com sucesso.</div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              className="btn-themed"
              onClick={() => setCreatedReqId(null)}
            >
              Ok
            </button>
          </div>
        </div>
      </div>
    )}
    {isSubmitting && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/60" />
        <div className="relative w-full max-w-sm bg-[var(--panel)] border border-[var(--border)] rounded-lg shadow-xl p-5 text-[var(--fg)] text-center">
          <div className="inline-flex items-center gap-2 text-lg font-semibold">
            <Clock className="animate-spin" size={18} />
            Aguarde
          </div>
          <div className="text-xs opacity-70 mt-2">Criando requisição...</div>
        </div>
      </div>
    )}
    </div>
  );
};

export default RequisicaoForm;

