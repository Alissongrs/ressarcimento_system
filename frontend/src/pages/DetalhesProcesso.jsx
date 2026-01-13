// src/pages/DetalhesProcesso.jsx - PÁGINA COMPLETA PARA DETALHES DO PROCESSO

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext.jsx';

import { useParams, useNavigate } from 'react-router-dom';
import {
  getHistoricoById,
  movimentarProcesso,
  salvarDataAlerta,
  descartarProcesso,
  excluirProcesso,
  getProcessoById,
  getDeferimentoByProcesso,
  getAllTags,
  updateProcessoTags,
  createTag,
} from '../services/requisicaoService';
import { listPlanilha } from '../services/adminPlanilhaService';
import {
  buscarEtapas,
  buscarSubEtapasPorEtapa,
  buscarEtapaPorNome,
} from '../services/etapasService';
import {
  ArrowLeft,
  Calendar,
  MessageSquare,
  Tag,
  Users,
  AlignLeft,
  Clock,
  Star,
  Trash2,
  ArrowRightCircle,
  AlertTriangle,
  CheckCircle,
  Paperclip,
  PlusCircle,
  MinusCircle,
  Save,
  RefreshCw,
  Edit3,
  X,
} from 'lucide-react';
import ModuloDeferimento from '../components/ModuloDeferimento';

// ===== FUNÇÕES AUXILIARES PARA TRATAMENTO SEGURO DE DADOS =====

const extrairTextoSeguro = (valor) => {
  if (!valor) return '';
  if (typeof valor === 'string') return valor;

  if (typeof valor === 'object') {
    if ('String' in valor) return valor.String || '';
    if ('Value' in valor) return valor.Value || '';
  }

  try {
    return String(valor);
  } catch {
    return '';
  }
};

const processarDataSegura = (dataAlerta) => {
  if (!dataAlerta) return '';

  try {
    const dataStr = extrairTextoSeguro(dataAlerta);

    if (
      !dataStr ||
      dataStr === '0000-00-00 00:00:00' ||
      dataStr === 'Invalid Date'
    ) {
      return '';
    }

    const date = new Date(dataStr);
    if (isNaN(date.getTime())) {
      return '';
    }

    return date.toISOString().split('T')[0];
  } catch (error) {
    console.warn('Erro ao processar data_alerta:', error);
    return '';
  }
};

// ===== COMPONENTE DO MÓDULO DE FLUXO DE RESSARCIMENTO =====

const ModuloFluxoRessarcimento = ({ processoId, onUpdate }) => {
  const [itens, setItens] = useState([
    {
      forma_devolucao: '',
      valor: '',
      data_devolucao: '',
      data_envio_financeiro: '',
    },
  ]);
  const [loading, setLoading] = useState(false);

  const carregarDados = async () => {
    try {
      const response = await fetch(
        `/api/v1/fluxo-ressarcimento/${processoId}`,
        {
          headers: {
            Authorization: `Bearer ${localStorage.getItem('userToken')}`,
          },
        }
      );

      if (response.ok) {
        const data = await response.json();
        if (data.itens && data.itens.length > 0) {
          setItens(data.itens);
          if (onUpdate) onUpdate({ itens: data.itens });
        }
      }
    } catch (error) {
      console.error('Erro ao carregar dados do Fluxo de Ressarcimento:', error);
    }
  };

  useEffect(() => {
    if (processoId) {
      carregarDados();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processoId]);

  const adicionarItem = () => {
    const novosItens = [
      ...itens,
      {
        forma_devolucao: '',
        valor: '',
        data_devolucao: '',
        data_envio_financeiro: '',
      },
    ];
    setItens(novosItens);
    if (onUpdate) onUpdate({ itens: novosItens });
  };

  const removerItem = (index) => {
    if (itens.length > 1) {
      const novosItens = itens.filter((_, i) => i !== index);
      setItens(novosItens);
      if (onUpdate) onUpdate({ itens: novosItens });
    }
  };

  const handleItemChange = (index, field, value) => {
    const novosItens = [...itens];
    novosItens[index][field] = value;
    setItens(novosItens);

    if (onUpdate) {
      onUpdate({ itens: novosItens });
    }
  };

  const salvarDados = async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/v1/fluxo-ressarcimento/${processoId}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('userToken')}`,
          },
          body: JSON.stringify({ itens }),
        }
      );

      if (response.ok) {
        alert('Dados do Fluxo de Ressarcimento salvos com sucesso!');
      } else {
        const error = await response.json();
        alert(`Erro ao salvar: ${error.error}`);
      }
    } catch (error) {
      console.error('Erro ao salvar dados do Fluxo de Ressarcimento:', error);
      alert('Erro ao salvar dados do Fluxo de Ressarcimento');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="border-t border-[var(--border)]/50 pt-6 animate-fade-in">
      <div className="flex justify-between items-center mb-6">
        <h3 className="font-semibold text-[var(--fg)] text-lg">
          Fluxo de Ressarcimento (CONCILIAÇÃO)
        </h3>
        <div className="flex gap-3">
          <button
            onClick={adicionarItem}
            className="flex items-center gap-2 px-4 py-2 bg-success hover:opacity-90 text-[var(--fg)] rounded-lg text-sm transition-colors"
            title="Adicionar nova devolução"
          >
            <PlusCircle size={16} />
            Adicionar
          </button>
          <button
            onClick={salvarDados}
            disabled={loading}
            className="px-4 py-2 bg-[var(--accent)] hover:opacity-90 disabled:opacity-50 text-[var(--fg)] rounded-lg text-sm transition-colors"
          >
            {loading ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      </div>

      <div className="space-y-6">
        {itens.map((item, index) => (
          <div
            key={index}
            className="border border-[var(--border)] glass-card rounded-lg p-6"
          >
            <div className="flex justify-between items-center mb-4">
              <span className="text-sm font-semibold opacity-70">
                Devolução #{index + 1}
              </span>
              {itens.length > 1 && (
                <button
                  onClick={() => removerItem(index)}
                  className="text-danger hover:opacity-90 transition-colors"
                  title="Remover esta devolução"
                >
                  <MinusCircle size={16} />
                </button>
              )}
            </div>

            <div className="mb-6">
              <label className="block text-sm font-semibold opacity-70 mb-3">
                Forma de devolução
              </label>
              <div className="flex gap-6">
                {['Fatura', 'GD', 'Deposito'].map((forma) => (
                  <label
                    key={forma}
                    className="flex items-center gap-2 text-sm text-[var(--fg)] cursor-pointer"
                  >
                    <input
                      type="radio"
                      name={`forma_devolucao_${index}`}
                      value={forma}
                      checked={item.forma_devolucao === forma}
                      onChange={(e) =>
                        handleItemChange(
                          index,
                          'forma_devolucao',
                          e.target.value
                        )
                      }
                      className="text-[var(--accent)] focus:ring-[var(--accent)]"
                    />
                    {forma}
                  </label>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <label className="block text-sm font-semibold opacity-70 mb-2">
                  Valor (R$)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={item.valor}
                  onChange={(e) =>
                    handleItemChange(index, 'valor', e.target.value)
                  }
                  className="w-full p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)] focus:outline-none"
                  placeholder="0,00"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold opacity-70 mb-2">
                  Data da devolução
                </label>
                <input
                  type="date"
                  value={item.data_devolucao}
                  onChange={(e) =>
                    handleItemChange(
                      index,
                      'data_devolucao',
                      e.target.value
                    )
                  }
                  className="w-full p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold opacity-70 mb-2">
                  Data de envio ao Financeiro/Gestão
                </label>
                <input
                  type="date"
                  value={item.data_envio_financeiro}
                  onChange={(e) =>
                    handleItemChange(
                      index,
                      'data_envio_financeiro',
                      e.target.value
                    )
                  }
                  className="w-full p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)] focus:outline-none"
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      {itens.length > 1 && (
        <div className="mt-6 p-4 glass-card rounded-lg">
          <div className="text-sm opacity-70">
            <strong>Resumo:</strong> {itens.length} devolução(ões) — Valor total:{' '}
            R${' '}
            {itens
              .reduce(
                (total, item) => total + (parseFloat(item.valor) || 0),
                0
              )
              .toFixed(2)}
          </div>
        </div>
      )}
    </div>
  );
};

// ===== MODAL DE GERENCIAMENTO DE TAGS =====

const ModalGerenciarTags = ({
  processo,
  allTags,
  onClose,
  onSave,
  onTagCreated,
}) => {
  const [selectedTags, setSelectedTags] = useState(() =>
    processo.tags && processo.tags.length > 0
      ? processo.tags.map((t) => t.id)
      : []
  );
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#CCCCCC');

  const handleToggleTag = (tagId) => {
    if (!tagId) return;
    setSelectedTags((prev) =>
      prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId]
    );
  };

  const handleCreateTag = async () => {
    if (!newTagName.trim()) {
      alert('O nome da tag não pode ser vazio.');
      return;
    }
    try {
      const novaTag = await createTag(newTagName, newTagColor);
      onTagCreated(novaTag);
      if (!selectedTags.includes(novaTag.id)) {
        setSelectedTags((prev) => [...prev, novaTag.id]);
      }
      setNewTagName('');
    } catch (error) {
      alert(error.response?.data?.error || 'Erro ao criar a tag.');
    }
  };

  const handleSave = () => {
    onSave(processo.id, selectedTags);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 backdrop-blur-sm flex justify-center items-center z-50">
      <div className="bg-[#1E293B] border border-[var(--border)] text-[var(--fg)] p-6 rounded-lg shadow-xl w-full max-w-md">
        <h2 className="text-xl font-bold mb-4">
          Gerenciar Tags - Processo #{processo.id}
        </h2>

        <div className="border-b border-[var(--border)] pb-4 mb-4">
          <h3 className="font-semibold mb-2">Criar nova tag</h3>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              placeholder="Nome da tag"
              className="flex-grow p-2 border border-[var(--border)] glass-card rounded"
            />
            <input
              type="color"
              value={newTagColor}
              onChange={(e) => setNewTagColor(e.target.value)}
              className="w-10 h-10 p-1 border-0 rounded cursor-pointer glass-card"
              title="Escolha uma cor"
            />
            <button
              onClick={handleCreateTag}
              className="px-4 py-2 bg-success text-[var(--fg)] font-bold rounded hover:opacity-90"
            >
              Criar
            </button>
          </div>
        </div>

        <p className="mb-2 opacity-70">
          Selecione as tags para este processo.
        </p>
        <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto p-2 bg-panel/80 rounded">
          {(allTags || []).map((tag) => {
            const isSelected = selectedTags.includes(tag.id);
            return (
              <button
                key={tag.id}
                onClick={() => handleToggleTag(tag.id)}
                className={`text-sm font-bold px-3 py-2 rounded-full border-2 transition-all ${
                  isSelected
                    ? 'border-[var(--accent)] scale-105'
                    : 'border-transparent opacity-70'
                }`}
                style={{ backgroundColor: tag.cor, color: '#FFFFFF' }}
              >
                {tag.nome}
              </button>
            );
          })}
        </div>

        <div className="flex justify-end space-x-4 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-[var(--border)] rounded hover:bg-[var(--border)]"
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-[var(--accent)] text-[var(--fg)] font-bold rounded hover:opacity-90"
          >
            Salvar Tags
          </button>
        </div>
      </div>
    </div>
  );
};

// Hook personalizado para debounce
function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

// ===== COMPONENTE PRINCIPAL DA PÁGINA =====

const DetalhesProcesso = () => {
  const { user } = useAuth();
  const isAdmin =
    String(user?.tipo_conta || '').toLowerCase() === 'admin';

  const { id } = useParams();
  const navigate = useNavigate();

  // Estados básicos
  const [processo, setProcesso] = useState(null);
  const [etapa, setEtapa] = useState('');
  const [subEtapa, setSubEtapa] = useState('');
  const [dataAlerta, setDataAlerta] = useState('');
  const [relevancia, setRelevancia] = useState(false);
  const [dadosDeferimento, setDadosDeferimento] = useState({});
  const [dadosFluxoRessarcimento, setDadosFluxoRessarcimento] =
    useState({ itens: [] });
  const [comentario, setComentario] = useState('');
  const [anexos, setAnexos] = useState([]);
  const [historico, setHistorico] = useState([]);

  // Estados para carregamento dinâmico
  const [etapasDisponiveis, setEtapasDisponiveis] = useState([]);
  const [subEtapasDisponiveis, setSubEtapasDisponiveis] = useState([]);
  const [loadingEtapas, setLoadingEtapas] = useState(false);
  const [loadingSubEtapas, setLoadingSubEtapas] = useState(false);

  // Estados de controle
  const [loading, setLoading] = useState(false);
  const [loadingHistorico, setLoadingHistorico] = useState(false);
  const [loadingProcesso, setLoadingProcesso] = useState(true);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [showConfirmDiscard, setShowConfirmDiscard] = useState(false);
  const [comentarioDescarte, setComentarioDescarte] = useState('');
  const [error, setError] = useState(null);

  // Estados para tags
  const [allTags, setAllTags] = useState([]);
  const [showTagsModal, setShowTagsModal] = useState(false);

  const fileInputRef = useRef(null);
  const debouncedDataAlerta = useDebounce(dataAlerta, 1000);

  // ===== FUNÇÕES DE CARREGAMENTO =====

  const carregarProcesso = useCallback(async () => {
    if (!id) return;

    setLoadingProcesso(true);
    try {
      const processoData = await getProcessoById(id);
      setProcesso(processoData);

      // Inicializar estados com dados do processo
      setEtapa(extrairTextoSeguro(processoData.etapa));
      setSubEtapa(extrairTextoSeguro(processoData.sub_etapa));
      setDataAlerta(processarDataSegura(processoData.data_alerta));
      setRelevancia(!!processoData.relevancia);

      // Deferimento: tentar vindo do processo; fallback na API específica e planilha
      const normalizeDef = (def = {}) => ({
        data_procedencia:
          (def.data_procedencia && String(def.data_procedencia).slice(0, 10)) ||
          (def.DataProcedencia?.Time ? def.DataProcedencia.Time.slice(0, 10) : '') ||
          '',
        credito_simples:
          typeof def.credito_simples === 'number'
            ? def.credito_simples
            : typeof def.CreditoSimples === 'number'
            ? def.CreditoSimples
            : typeof def.credito_simples?.Float64 === 'number'
            ? def.credito_simples.Float64
            : typeof def.credito_simples?.Float64 === 'string'
            ? Number(def.credito_simples.Float64)
            : 0,
        credito_dobro:
          typeof def.credito_dobro === 'number'
            ? def.credito_dobro
            : typeof def.CreditoDobro === 'number'
            ? def.CreditoDobro
            : typeof def.credito_dobro?.Float64 === 'number'
            ? def.credito_dobro.Float64
            : typeof def.credito_dobro?.Float64 === 'string'
            ? Number(def.credito_dobro.Float64)
            : 0,
        data_credito_dobro:
          (def.data_credito_dobro && String(def.data_credito_dobro).slice(0, 10)) ||
          (def.DataCreditoDobro?.Time ? def.DataCreditoDobro.Time.slice(0, 10) : '') ||
          '',
      });

      if (processoData.deferimento) {
        setDadosDeferimento(normalizeDef(processoData.deferimento));
      } else {
        try {
          const defApi = await getDeferimentoByProcesso(id);
          if (defApi) {
            setDadosDeferimento(normalizeDef(defApi));
          } else {
            const plan = await listPlanilha({ q: id, limit: 1 });
            const row = Array.isArray(plan) && plan.length ? plan[0] : null;
            if (row) {
              setDadosDeferimento({
                data_procedencia: row.data_simples || '',
                credito_simples: row.credito_simples ?? 0,
                credito_dobro: row.credito_dobro ?? 0,
                data_credito_dobro: row.data_dobro || '',
              });
            }
          }
        } catch {}
      }
    } catch (error) {
      console.error('Erro ao carregar processo:', error);
      setError('Erro ao carregar dados do processo.');
    } finally {
      setLoadingProcesso(false);
    }
  }, [id]);

  const carregarEtapas = useCallback(async () => {
    setLoadingEtapas(true);
    setError(null);

    try {
      const etapas = await buscarEtapas();
      setEtapasDisponiveis(etapas);
    } catch (error) {
      console.error('Erro ao carregar etapas:', error);
      setError('Erro ao carregar etapas. Usando dados padrão.');

      // Fallback estático
      setEtapasDisponiveis([
        {
          id: 2,
          nome: 'Distribuidora',
          descricao: 'Processo em tratativa com a Distribuidora.',
        },
        {
          id: 3,
          nome: 'Ouvidoria',
          descricao: 'Processo escalado para a Ouvidoria.',
        },
        {
          id: 4,
          nome: 'ANEEL',
          descricao: 'Processo escalado para a ANEEL.',
        },
        {
          id: 5,
          nome: 'SMA',
          descricao: 'Processo em análise no SMA.',
        },
        {
          id: 6,
          nome: 'Pendente',
          descricao: 'Deferido, aguardando início da conciliação.',
        },
        {
          id: 7,
          nome: 'Em conciliação',
          descricao: 'Valores do deferimento sendo conciliados.',
        },
        {
          id: 8,
          nome: 'Em contestação',
          descricao: 'Valores do deferimento em contestação.',
        },
      ]);
    } finally {
      setLoadingEtapas(false);
    }
  }, []);

  const getSubEtapasPadrao = (nomeEtapa) => {
    const subEtapasPorEtapa = {
      Distribuidora: [
        { id: 1, nome: 'Em elaboração' },
        { id: 2, nome: 'Aguardando retorno' },
        { id: 3, nome: 'Em contestação' },
      ],
      Ouvidoria: [
        { id: 1, nome: 'Em elaboração' },
        { id: 2, nome: 'Aguardando retorno' },
        { id: 3, nome: 'Em contestação' },
      ],
      ANEEL: [
        { id: 1, nome: 'Em elaboração' },
        { id: 2, nome: 'Aguardando retorno' },
        { id: 3, nome: 'Em contestação' },
      ],
      SMA: [
        { id: 1, nome: 'Em elaboração' },
        { id: 2, nome: 'Aguardando retorno' },
        { id: 3, nome: 'Em contestação' },
      ],
      Pendente: [
        { id: 2, nome: 'Aguardando retorno' },
        { id: 4, nome: 'Em análise' },
      ],
      'Em conciliação': [
        { id: 2, nome: 'Aguardando retorno' },
        { id: 4, nome: 'Em análise' },
      ],
      'Em contestação': [
        { id: 2, nome: 'Aguardando retorno' },
        { id: 4, nome: 'Em análise' },
      ],
    };

    return subEtapasPorEtapa[nomeEtapa] || [];
  };

  const carregarSubEtapas = useCallback(
    async (nomeEtapa) => {
      if (!nomeEtapa) {
        setSubEtapasDisponiveis([]);
        return;
      }

      setLoadingSubEtapas(true);
      setError(null);

      try {
        const etapaEncontrada = await buscarEtapaPorNome(nomeEtapa);

        if (etapaEncontrada) {
          const subEtapas = await buscarSubEtapasPorEtapa(
            etapaEncontrada.id
          );
          setSubEtapasDisponiveis(subEtapas);
        } else {
          setSubEtapasDisponiveis([]);
        }
      } catch (error) {
        console.error('Erro ao carregar sub-etapas:', error);
        setError('Erro ao carregar sub-etapas. Usando dados padrão.');

        const subPadrao = getSubEtapasPadrao(nomeEtapa);
        setSubEtapasDisponiveis(subPadrao);
      } finally {
        setLoadingSubEtapas(false);
      }
    },
    [] // getSubEtapasPadrao é estável no escopo
  );

  const carregarHistorico = useCallback(async () => {
    if (!id) return;

    setLoadingHistorico(true);
    try {
      const historicoData = await getHistoricoById(id);
      setHistorico(historicoData || []);
    } catch (error) {
      console.error('Erro ao carregar histórico:', error);
      setHistorico([]);
    } finally {
      setLoadingHistorico(false);
    }
  }, [id]);

  const carregarTags = useCallback(async () => {
    try {
      const tagsData = await getAllTags();
      setAllTags(tagsData || []);
    } catch (error) {
      console.error('Erro ao carregar tags:', error);
      setAllTags([]);
    }
  }, []);

  // ===== useEffect HOOKS =====

  useEffect(() => {
    carregarProcesso();
    carregarEtapas();
    carregarHistorico();
    carregarTags();
  }, [
    carregarProcesso,
    carregarEtapas,
    carregarHistorico,
    carregarTags,
  ]);

  useEffect(() => {
    if (etapa) {
      carregarSubEtapas(etapa);
    }
  }, [etapa, carregarSubEtapas]);

  useEffect(() => {
    if (debouncedDataAlerta && processo?.id) {
      salvarDataAlerta(processo.id, debouncedDataAlerta).catch(
        console.error
      );
    }
  }, [debouncedDataAlerta, processo?.id]);

  // ===== HANDLERS =====

  const handleEtapaChange = (novaEtapa) => {
    setEtapa(novaEtapa);
    setSubEtapa('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!processo?.id || !etapa || !comentario.trim()) {
      alert('Por favor, preencha todos os campos obrigatórios.');
      return;
    }

    setLoading(true);
    try {
      const formData = new FormData();
      formData.append('etapa_atual', etapa);
      formData.append('sub_etapa', subEtapa);
      formData.append('comentario', comentario);
      formData.append('relevancia', relevancia.toString());

      if (Object.keys(dadosDeferimento).length > 0) {
        formData.append(
          'deferimento',
          JSON.stringify(dadosDeferimento)
        );
      }

      if (
        dadosFluxoRessarcimento.itens &&
        dadosFluxoRessarcimento.itens.length > 0
      ) {
        formData.append(
          'fluxo_ressarcimento',
          JSON.stringify(dadosFluxoRessarcimento)
        );
      }

      anexos.forEach((anexo) => {
        formData.append('anexos', anexo);
      });

      await movimentarProcesso(processo.id, formData);

      await carregarProcesso();
      await carregarHistorico();

      setComentario('');
      setAnexos([]);

      alert('Processo movimentado com sucesso!');
    } catch (error) {
      console.error('Erro ao movimentar processo:', error);
      alert('Erro ao movimentar processo. Tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  const handleDescarte = async () => {
    if (!processo?.id || !comentarioDescarte.trim()) {
      alert('Por favor, adicione um comentário para o descarte.');
      return;
    }

    setLoading(true);
    try {
      await descartarProcesso(processo.id, comentarioDescarte);
      navigate('/processos');
    } catch (error) {
      console.error('Erro ao descartar processo:', error);
      alert('Erro ao descartar processo. Tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  const handleExclusao = async () => {
    if (!processo?.id) return;

    setLoading(true);
    try {
      await excluirProcesso(processo.id);
      navigate('/processos');
    } catch (error) {
      console.error('Erro ao excluir processo:', error);
      alert('Erro ao excluir processo. Tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files);
    setAnexos((prev) => [...prev, ...files]);
  };

  const removeAnexo = (index) => {
    setAnexos((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSaveTags = async (processoId, tagIds) => {
    try {
      await updateProcessoTags(processoId, tagIds);
      setShowTagsModal(false);
      await carregarProcesso();
    } catch (error) {
      alert('Erro ao salvar as tags.');
    }
  };

  const handleTagCreated = (novaTag) => {
    setAllTags((prev) => [...prev, novaTag]);
  };

  // ===== FUNÇÕES AUXILIARES VISUAIS =====

  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (
      parseFloat((bytes / Math.pow(k, i)).toFixed(2)) +
      ' ' +
      sizes[i]
    );
  };

  const formatDateTime = (dateString) => {
    if (!dateString) return 'Data não informada';
    try {
      return new Date(dateString).toLocaleString('pt-BR');
    } catch {
      return 'Data inválida';
    }
  };

  const getEtapaColorSafe = (name) => {
    try {
      let s = String(name || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');

      if (s.includes('conciliacao')) s = 'em conciliacao';
      if (s.includes('contestacao')) s = 'em contestacao';
      if (s.includes('validacao')) s = 'enviado ao financeiro';
      if (s.includes('fatur')) s = 'faturamento';
      if (s.startsWith('conclu')) s = 'concluido';

      const map = {
        distribuidora: 'bg-[var(--accent)]',
        ouvidoria: 'bg-purple-600',
        aneel: 'bg-danger',
        sma: 'bg-success',
        pendente: 'bg-warning',
        'em conciliacao': 'bg-orange-600',
        'em contestacao': 'bg-danger',
        'enviado ao financeiro': 'bg-indigo-600',
        faturamento: 'bg-teal-600',
        concluido: 'bg-[var(--border)]',
        indeferido: 'glass-card',
      };

      return map[s] || 'bg-[var(--border)]';
    } catch {
      return 'bg-[var(--border)]';
    }
  };

  // ===== RENDERIZAÇÃO =====

  if (loadingProcesso) {
    return (
      <div className="flex items-center justify-center h-screen flex-col">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[var(--accent)]" />
        <p className="mt-4 text-[var(--fg)]">
          <span className="sap-loading">Carregando processo...</span>
        </p>
      </div>
    );
  }

  if (!processo) {
    return (
      <div className="p-8 text-center text-danger">
        <p>Processo não encontrado.</p>
        <button
          onClick={() => navigate('/processos')}
          className="mt-4 px-4 py-2 bg-[var(--accent)] text-[var(--fg)] rounded hover:opacity-90"
        >
          Voltar aos Processos
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen themed-surface">
      {/* Header */}
      <div className="glass-card border-b border-[var(--border)] p-6">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button
                onClick={() => navigate('/processos')}
                className="opacity-70 hover:text-[var(--fg)] transition-colors"
                title="Voltar aos processos"
              >
                <ArrowLeft size={24} />
              </button>
              <h1 className="text-2xl font-bold text-[var(--fg)]">
                Processo #
                {extrairTextoSeguro(processo?.numero_processo)}
              </h1>
              <span
                className={`px-3 py-1 rounded-full text-sm font-medium text-[var(--fg)] ${getEtapaColorSafe(
                  extrairTextoSeguro(processo?.etapa)
                )}`}
              >
                {extrairTextoSeguro(processo?.etapa)}
              </span>
              {extrairTextoSeguro(processo?.sub_etapa) && (
                <span className="px-2 py-1 glass-card rounded text-sm text-[var(--fg)]">
                  {extrairTextoSeguro(processo.sub_etapa)}
                </span>
              )}
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowTagsModal(true)}
                className="flex items-center gap-2 px-4 py-2 bg-[var(--accent)] hover:opacity-90 text-[var(--fg)] rounded-lg transition-colors"
              >
                <Edit3 size={16} />
                Gerenciar Tags
              </button>
              <button
                onClick={() => setShowConfirmDiscard(true)}
                className="flex items-center gap-2 px-4 py-2 bg-warning hover:opacity-90 text-[var(--fg)] rounded-lg transition-colors"
              >
                <ArrowRightCircle size={16} />
                Descartar
              </button>
              <button
                onClick={() => setShowConfirmDelete(true)}
                className="flex items-center gap-2 px-4 py-2 bg-danger hover:opacity-90 text-[var(--fg)] rounded-lg transition-colors"
              >
                <Trash2 size={16} />
                Excluir
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="bg-yellow-900/50 border-l-4 border-[var(--warning)] p-4 mx-6 mt-4 rounded">
          <div className="flex items-center">
            <AlertTriangle
              className="text-warning mr-2"
              size={16}
            />
            <p className="text-[var(--fg)] opacity-90 text-sm">
              {error}
            </p>
            <button
              onClick={() => setError(null)}
              className="ml-auto text-warning hover:text-yellow-300"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="max-w-7xl mx-auto p-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Panel - Form */}
          <div className="lg:col-span-2">
            <div className="glass-card rounded-lg p-6">
              <h2 className="text-xl font-bold mb-6">
                Movimentar Processo
              </h2>

              <form
                onSubmit={handleSubmit}
                className="space-y-6"
              >
                {/* Informações Básicas */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-semibold text-[var(--fg)] mb-2">
                      <Tag className="inline w-4 h-4 mr-2" />
                      Etapa Atual
                      {loadingEtapas && (
                        <RefreshCw className="inline w-4 h-4 ml-2 animate-spin" />
                      )}
                    </label>
                    <select
                      value={etapa}
                      onChange={(e) =>
                        handleEtapaChange(e.target.value)
                      }
                      className="w-full p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)] focus:outline-none"
                      required
                      disabled={loadingEtapas}
                    >
                      <option value="">
                        {loadingEtapas
                          ? 'Carregando etapas...'
                          : 'Selecione uma etapa'}
                      </option>
                      {etapasDisponiveis
                        .filter((etapaOption) => {
                          const etapaAtual =
                            extrairTextoSeguro(
                              processo?.etapa
                            );

                          if (
                            [
                              'Distribuidora',
                              'Ouvidoria',
                              'ANEEL',
                              'SMA',
                            ].includes(etapaAtual)
                          ) {
                            return (
                              etapaOption.id_coluna_kanban ===
                              1
                            );
                          }

                          if (
                            [
                              'Pendente',
                              'Em conciliação',
                              'Em contestação',
                            ].includes(etapaAtual)
                          ) {
                            return (
                              etapaOption.id_coluna_kanban ===
                              2
                            );
                          }

                          return true;
                        })
                        .map((etapaOption) => (
                          <option
                            key={etapaOption.id}
                            value={etapaOption.nome}
                          >
                            {etapaOption.nome}
                          </option>
                        ))}
                    </select>
                    {etapa &&
                      etapasDisponiveis.find(
                        (e) => e.nome === etapa
                      )?.descricao && (
                        <p className="text-xs opacity-70 mt-1">
                          {
                            etapasDisponiveis.find(
                              (e) => e.nome === etapa
                            ).descricao
                          }
                        </p>
                      )}
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-[var(--fg)] mb-2">
                      <Users className="inline w-4 h-4 mr-2" />
                      Sub-etapa
                      {loadingSubEtapas && (
                        <RefreshCw className="inline w-4 h-4 ml-2 animate-spin" />
                      )}
                    </label>
                    <select
                      value={subEtapa}
                      onChange={(e) =>
                        setSubEtapa(e.target.value)
                      }
                      className="w-full p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)] focus:outline-none"
                      disabled={!etapa || loadingSubEtapas}
                    >
                      <option value="">
                        {!etapa
                          ? 'Selecione uma etapa primeiro'
                          : loadingSubEtapas
                          ? 'Carregando sub-etapas...'
                          : subEtapasDisponiveis.length ===
                            0
                          ? 'Nenhuma sub-etapa disponível'
                          : 'Selecione uma sub-etapa'}
                      </option>
                      {subEtapasDisponiveis.map(
                        (subEtapaOption) => (
                          <option
                            key={subEtapaOption.id}
                            value={subEtapaOption.nome}
                          >
                            {subEtapaOption.nome}
                          </option>
                        )
                      )}
                    </select>
                    {!etapa && (
                      <p className="text-xs opacity-70 mt-1">
                        As sub-etapas serão carregadas
                        após selecionar uma etapa.
                      </p>
                    )}
                  </div>
                </div>

                {/* Data de Alerta e Relevância */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-semibold text-[var(--fg)] mb-2">
                      <Calendar className="inline w-4 h-4 mr-2" />
                      Data de Alerta
                    </label>
                    <input
                      type="date"
                      value={dataAlerta}
                      onChange={(e) =>
                        setDataAlerta(e.target.value)
                      }
                      className="w-full p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)] focus:outline-none"
                    />
                  </div>

                  <div className="flex items-center">
                    <label className="flex items-center gap-3 text-sm font-semibold text-[var(--fg)] cursor-pointer">
                      <Star className="w-4 h-4" />
                      <input
                        type="checkbox"
                        checked={relevancia}
                        onChange={(e) =>
                          setRelevancia(e.target.checked)
                        }
                        className="w-4 h-4 text-warning glass-card border-[var(--border)] rounded focus:ring-yellow-500"
                      />
                      Processo relevante
                    </label>
                  </div>
                </div>

                {/* Módulos Condicionais */}
                {true && (
                  <ModuloDeferimento
                    processoId={processo?.id}
                    dados={dadosDeferimento}
                    onUpdate={setDadosDeferimento}
                  />
                )}

                {etapa === 'Em conciliação' && (
                  <ModuloFluxoRessarcimento
                    processoId={processo?.id}
                    onUpdate={setDadosFluxoRessarcimento}
                  />
                )}

                {/* Comentário */}
                <div>
                  <label className="block text-sm font-semibold text-[var(--fg)] mb-2">
                    <MessageSquare className="inline w-4 h-4 mr-2" />
                    Comentário da movimentação
                  </label>
                  <textarea
                    value={comentario}
                    onChange={(e) =>
                      setComentario(e.target.value)
                    }
                    rows={4}
                    className="w-full p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)] focus:outline-none resize-none"
                    placeholder="Descreva as ações realizadas ou observações importantes..."
                    required
                  />
                </div>

                {/* Anexos */}
                <div>
                  <label className="block text-sm font-semibold text-[var(--fg)] mb-2">
                    <Paperclip className="inline w-4 h-4 mr-2" />
                    Anexos
                  </label>
                  <div className="space-y-3">
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      onChange={handleFileChange}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        fileInputRef.current?.click()
                      }
                      className="w-full p-3 border-2 border-dashed border-[var(--border)] glass-card text-[var(--fg)] rounded-lg hover:border-[var(--accent)] hover:opacity-90 transition-colors"
                    >
                      Clique para adicionar arquivos ou
                      arraste aqui
                    </button>

                    {anexos.length > 0 && (
                      <div className="space-y-2">
                        {anexos.map(
                          (arquivo, index) => (
                            <div
                              key={index}
                              className="flex items-center justify-between p-2 glass-card rounded"
                            >
                              <div className="flex items-center gap-2">
                                <Paperclip
                                  size={16}
                                  className="opacity-70"
                                />
                                <span className="text-sm text-[var(--fg)]">
                                  {arquivo.name}
                                </span>
                                <span className="text-xs opacity-70">
                                  (
                                  {formatFileSize(
                                    arquivo.size
                                  )}
                                  )
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={() =>
                                  removeAnexo(index)
                                }
                                className="text-danger hover:opacity-90"
                              >
                                <X size={16} />
                              </button>
                            </div>
                          )
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Botões de Ação */}
                <div className="flex gap-4 pt-6">
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-[var(--accent)] hover:opacity-90 disabled:opacity-50 text-[var(--fg)] rounded-lg transition-colors"
                  >
                    {loading ? (
                      <>
                        <RefreshCw
                          className="animate-spin"
                          size={16}
                        />
                        Processando...
                      </>
                    ) : (
                      <>
                        <Save size={16} />
                        Movimentar Processo
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>

          {/* Right Panel - Info & History */}
          <div className="space-y-6">
            {/* Informações do Processo */}
            <div className="glass-card rounded-lg p-6">
              <h3 className="text-lg font-bold mb-4">
                Informações do Processo
              </h3>
              <div className="space-y-3 text-sm">
                <div>
                  <span className="opacity-70">
                    Cliente:
                  </span>
                  <span className="ml-2 text-[var(--fg)]">
                    {extrairTextoSeguro(
                      processo.nome_cliente
                    )}
                  </span>
                </div>
                <div>
                  <span className="opacity-70">UC:</span>
                  <span className="ml-2 text-[var(--fg)]">
                    {extrairTextoSeguro(
                      processo.unidade_consumidora
                    )}
                  </span>
                </div>
                <div>
                  <span className="opacity-70">Valor Estimado:</span>
                  <span className="ml-2 text-[var(--fg)]">
                    {(() => {
                      try {
                        const raw = (processo?.valor_estimado ?? processo?.ressarcimento_estimado ?? processo?.valorEstimado ?? processo?.ressarcimentoEstimado);
                        let num = null;
                        if (typeof raw === 'number') {
                          num = raw;
                        } else if (raw && typeof raw === 'object' && 'Float64' in raw) {
                          num = Number(raw.Float64);
                        } else if (typeof raw === 'string') {
                          const normalized = raw.replace(/\./g, '').replace(',', '.');
                          const n = Number(normalized);
                          if (isFinite(n)) num = n;
                        }
                        return (num != null)
                          ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(num)
                          : 'R$ 0,00';
                      } catch {
                        return 'R$ 0,00';
                      }
                    })()}
                  </span>
                </div>
                <div>
                  <span className="opacity-70">
                    Última atualização:
                  </span>
                  <span className="ml-2 text-[var(--fg)]">
                    {processo.ultima_atualizacao
                    && processo
                      .ultima_atualizacao.Valid
                      ? new Date(
                          processo
                            .ultima_atualizacao
                            .String
                        ).toLocaleDateString(
                          'pt-BR'
                        )
                      : 'N/A'}
                  </span>
                </div>

                {/* Tags */}
                {processo.tags &&
                  processo.tags.length > 0 && (
                    <div>
                      <span className="opacity-70">
                        Tags:
                      </span>
                      <div className="flex flex-wrap gap-2 mt-2">
                        {processo.tags.map((tag) => (
                          <span
                            key={tag.id}
                            className="px-2 py-1 rounded-full text-xs font-medium text-[var(--fg)]"
                            style={{
                              backgroundColor:
                                tag.cor,
                            }}
                          >
                            {tag.nome}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
              </div>
            </div>

            {/* Histórico */}
            <div className="glass-card rounded-lg p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold">
                  Histórico de movimentações
                </h3>
                {loadingHistorico && (
                  <RefreshCw
                    className="animate-spin"
                    size={16}
                  />
                )}
              </div>

              <div className="space-y-4 max-h-96 overflow-y-auto">
                {historico.length === 0 ? (
                  <p className="opacity-70 text-sm">
                    Nenhuma movimentação
                    registrada.
                  </p>
                ) : (
                  historico.map(
                    (item, index) => (
                      <div
                        key={index}
                        className="border-l-2 border-[var(--accent)] pl-4 pb-4"
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span
                            className={`px-2 py-1 rounded text-xs font-medium text-[var(--fg)] ${getEtapaColorSafe(
                              item.etapa
                            )}`}
                          >
                            {item.etapa}
                          </span>
                          {item.sub_etapa && (
                            <span className="px-2 py-1 glass-card rounded text-xs text-[var(--fg)]">
                              {item.sub_etapa}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-[var(--fg)] mb-1">
                          {item.comentario ||
                            item.comentário}
                        </p>
                        <div className="flex items-center gap-4 text-xs opacity-70">
                          <span className="flex items-center gap-1">
                            <Clock size={12} />
                            {formatDateTime(
                              item.data_movimentacao ||
                                item.data_movimentação
                            )}
                          </span>
                          <span>
                            {item.usuario_nome ||
                              item.Usuario_nome ||
                              item.Usurio_nome}
                          </span>
                        </div>

                        {item.anexos &&
                          item.anexos.length >
                            0 && (
                            <div className="mt-2">
                              <p className="text-xs opacity-70 mb-1">
                                Anexos:
                              </p>
                              <div className="space-y-1">
                                {item.anexos.map(
                                  (
                                    anexo,
                                    anexoIndex
                                  ) => (
                                    <a
                                      key={
                                        anexoIndex
                                      }
                                      href={
                                        anexo.url
                                      }
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="flex items-center gap-1 text-xs text-[var(--accent)] hover:opacity-90"
                                    >
                                      <Paperclip size={10} />
                                      {anexo.nome}
                                    </a>
                                  )
                                )}
                              </div>
                            </div>
                          )}
                      </div>
                    )
                  )
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Modal de Gerenciamento de Tags */}
      {showTagsModal && (
        <ModalGerenciarTags
          processo={processo}
          allTags={allTags}
          onClose={() => setShowTagsModal(false)}
          onSave={handleSaveTags}
          onTagCreated={handleTagCreated}
        />
      )}

      {/* Modal de Confirmação de Descarte */}
      {showConfirmDiscard && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="glass-card rounded-lg p-6 w-full max-w-md">
            <h3 className="text-lg font-bold text-[var(--fg)] mb-4 flex items-center gap-2">
              <ArrowRightCircle
                className="text-warning"
                size={20}
              />
              Confirmar descarte
            </h3>
            <p className="text-[var(--fg)] mb-4">
              Tem certeza que deseja descartar este
              processo? Adicione um comentário explicando
              o motivo:
            </p>
            <textarea
              value={comentarioDescarte}
              onChange={(e) =>
                setComentarioDescarte(
                  e.target.value
                )
              }
              rows={3}
              className="w-full p-3 border border-[var(--border)] glass-card text-[var(--fg)] rounded-lg focus:border-[var(--accent)] focus:outline-none resize-none mb-4"
              placeholder="Motivo do descarte..."
              required
            />
            <div className="flex gap-3">
              <button
                onClick={handleDescarte}
                disabled={
                  loading ||
                  !comentarioDescarte.trim()
                }
                className="flex-1 px-4 py-2 bg-warning hover:opacity-90 disabled:opacity-50 text-[var(--fg)] rounded-lg transition-colors"
              >
                {loading
                  ? 'Descartando...'
                  : 'Confirmar descarte'}
              </button>
              <button
                onClick={() => {
                  setShowConfirmDiscard(false);
                  setComentarioDescarte('');
                }}
                className="flex-1 px-4 py-2 bg-[var(--border)] hover:glass-card text-[var(--fg)] rounded-lg transition-colors"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Confirmação de Exclusão */}
      {showConfirmDelete && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="glass-card rounded-lg p-6 w-full max-w-md">
            <h3 className="text-lg font-bold text-[var(--fg)] mb-4 flex items-center gap-2">
              <Trash2
                className="text-danger"
                size={20}
              />
              Confirmar exclusão
            </h3>
            <p className="text-[var(--fg)] mb-6">
              Tem certeza que deseja excluir
              permanentemente este processo?
              <strong className="text-danger">
                {' '}
                Esta ação não pode ser desfeita.
              </strong>
            </p>
            <div className="flex gap-3">
              <button
                onClick={handleExclusao}
                disabled={loading}
                className="flex-1 px-4 py-2 bg-danger hover:opacity-90 disabled:opacity-50 text-[var(--fg)] rounded-lg transition-colors"
              >
                {loading
                  ? 'Excluindo...'
                  : 'Confirmar exclusão'}
              </button>
              <button
                onClick={() =>
                  setShowConfirmDelete(false)
                }
                className="flex-1 px-4 py-2 bg-[var(--border)] hover:glass-card text-[var(--fg)] rounded-lg transition-colors"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DetalhesProcesso;

