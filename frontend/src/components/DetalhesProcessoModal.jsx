// src/components/DetalhesProcessoModal.jsx - VERSÀO COM CARREGAMENTO DINÂMICO
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
    getHistoricoById,
    movimentarProcesso,
    salvarDataAlerta,
    descartarProcesso,
    excluirProcesso
} from '../services/requisicaoService';
import { buscarEtapas, buscarSubEtapasPorEtapa, buscarEtapaPorNome } from '../services/etapasService';
import { X, Calendar, MessageSquare, Tag, User, AlignLeft, Clock, Star, Trash2, ArrowRightCircle, AlertTriangle, CheckCircle, Paperclip, PlusCircle, MinusCircle, Save, RefreshCw } from 'lucide-react';
import ModuloDeferimento from './ModuloDeferimento';
import api from '../services/api';
import { confirmAction } from '../utils/confirm.js';

// ===== FUNCOES AUXILIARES PARA TRATAMENTO SEGURO DE DADOS =====

const extrairTextoSeguro = (valor) => {
    if (!valor) return '';
    if (typeof valor === 'string') return valor;
    if (typeof valor === 'object' && valor.String !== undefined) {
        return valor.String || '';
    }
    if (typeof valor === 'object' && valor.Value !== undefined) {
        return valor.Value || '';
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
        
        if (!dataStr || dataStr === '0000-00-00 00:00:00' || dataStr === 'Invalid Date') {
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

const getHistoricoStep = (item) => {
    const etapaRaw = extrairTextoSeguro(item?.etapa_nova || item?.etapa_destino || item?.etapa || '');
    const subRaw = extrairTextoSeguro(item?.sub_etapa || '');
    let etapa = etapaRaw;
    let sub = subRaw;

    if ((!etapa || !sub) && item?.status_composto) {
        const parts = String(item.status_composto).split('-').map((p) => p.trim());
        if (!etapa && parts.length) etapa = parts[0];
        if (!sub && parts.length > 1) sub = parts.slice(1).join(' - ');
    }

    const label = `${etapa || 'N/A'}${sub ? ' - ' + sub : ''}`;
    return { etapa: etapa || 'N/A', sub: sub || '', label };
};

// ===== COMPONENTES DOS MÓDULOS =====

const ModuloFluxoRessarcimento = ({ processoId, onUpdate }) => {
    const [itens, setItens] = useState([{
        forma_devolucao: '',
        valor: '',
        data_devolucao: '',
        data_envio_financeiro: ''
    }]);
    const [loading, setLoading] = useState(false);

    const carregarDados = async () => {
        try {
            const response = await fetch(`/api/v1/fluxo-ressarcimento/${processoId}`, {
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('userToken')}`
                }
            });
            
            if (response.ok) {
                const data = await response.json();
                if (data.itens && data.itens.length > 0) {
                    setItens(data.itens);
                }
            }
        } catch (error) {
            console.error('Erro ao carregar dados do fluxo de ressarcimento:', error);
        }
    };

    const adicionarItem = () => {
        setItens([...itens, {
            forma_devolucao: '',
            valor: '',
            data_devolucao: '',
            data_envio_financeiro: ''
        }]);
    };

    const removerItem = (index) => {
        if (itens.length > 1) {
            const novosItens = itens.filter((_, i) => i !== index);
            setItens(novosItens);
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
            const response = await fetch(`/api/v1/fluxo-ressarcimento/${processoId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('userToken')}`
                },
                body: JSON.stringify({ itens })
            });

            if (response.ok) {
                alert('Dados do fluxo de ressarcimento salvos com sucesso!');
            } else {
                const error = await response.json();
                alert(`Erro ao salvar: ${error.error}`);
            }
        } catch (error) {
            console.error('Erro ao salvar dados:', error);
            alert('Erro ao salvar dados do fluxo de ressarcimento');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="border-t border-blue-800/50 pt-4 animate-fade-in">
            <div className="flex justify-between items-center mb-4">
                <h3 className="font-semibold text-[var(--fg)] text-sm">FLUXO DE RESSARCIMENTO (CONCILIAÇÃO)</h3>
                <div className="flex gap-2">
                    <button
                        onClick={adicionarItem}
                        className="btn-outline text-xs inline-flex items-center gap-1"
                        title="Adicionar nova devolução"
                    >
                        <PlusCircle size={14} />
                        Adicionar
                    </button>
                    <button
                        onClick={salvarDados}
                        disabled={loading}
                        className="btn-themed text-xs"
                    >
                        {loading ? 'Salvando...' : 'Salvar'}
                    </button>
                </div>
            </div>

            <div className="space-y-4">
                {itens.map((item, index) => (
                    <div key={index} className="sap-card p-4">
                        <div className="flex justify-between items-center mb-3">
                            <span className="text-xs font-semibold text-gray-400">
                                Devolução #{index + 1}
                            </span>
                            {itens.length > 1 && (
                                <button
                                    onClick={() => removerItem(index)}
                                    className="text-red-400 hover:text-red-300 transition-colors"
                                    title="Remover esta devolução"
                                >
                                    <MinusCircle size={14} />
                                </button>
                            )}
                        </div>

                        <div className="mb-4">
                            <label className="sap-label mb-2">
                                Forma de Devolução
                            </label>
                            <div className="flex gap-4">
                                {['Fatura', 'GD', 'Deposito'].map((forma) => (
                                    <label key={forma} className="flex items-center gap-2 text-sm text-[var(--fg)] cursor-pointer">
                                        <input
                                            type="radio"
                                            name={`forma_devolucao_${index}`}
                                            value={forma}
                                            checked={item.forma_devolucao === forma}
                                            onChange={(e) => handleItemChange(index, 'forma_devolucao', e.target.value)}
                                            className="text-blue-600 focus:ring-blue-500"
                                        />
                                        {forma}
                                    </label>
                                ))}
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                            <div>
                                <label className="sap-label mb-2">
                                    Valor (R$)
                                </label>
                                <input
                                    type="number"
                                    step="0.01"
                                    value={item.valor}
                                    onChange={(e) => handleItemChange(index, 'valor', e.target.value)}
                                    className="w-full input-themed"
                                    placeholder="0,00"
                                />
                            </div>
                            <div>
                                <label className="sap-label mb-2">
                                    Data da Devolução
                                </label>
                                <input
                                    type="date"
                                    value={item.data_devolucao}
                                    onChange={(e) => handleItemChange(index, 'data_devolucao', e.target.value)}
                                    className="w-full input-themed"
                                />
                            </div>
                            <div>
                                <label className="sap-label mb-2">
                                    Data de Envio ao Financeiro/Gestão
                                </label>
                                <input
                                    type="date"
                                    value={item.data_envio_financeiro}
                                    onChange={(e) => handleItemChange(index, 'data_envio_financeiro', e.target.value)}
                                    className="w-full input-themed"
                                />
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {itens.length > 1 && (
                <div className="mt-4 p-3 panel-bg-50 rounded-lg">
                    <div className="text-xs text-gray-400">
                        <strong>Resumo:</strong> {itens.length} devolução(ões) • Valor total: R$ {itens.reduce((total, item) => total + (parseFloat(item.valor) || 0), 0).toFixed(2)}
                    </div>
                </div>
            )}
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

// ===== COMPONENTE PRINCIPAL =====

const DetalhesProcessoModal = ({ isOpen, onClose, processo, onUpdate, onEditTags }) => {
    // Estados básicos
    const [etapa, setEtapa] = useState('');
    const [subEtapa, setSubEtapa] = useState('');
    const [dataAlerta, setDataAlerta] = useState('');
    const [relevancia, setRelevancia] = useState(false);
    const [dadosDeferimento, setDadosDeferimento] = useState({});
    const [dadosFluxoRessarcimento, setDadosFluxoRessarcimento] = useState({ itens: [] });
    const [fluxoSalvo, setFluxoSalvo] = useState(null);
    const [faturamentoSalvo, setFaturamentoSalvo] = useState(null);
    const [comentario, setComentario] = useState('');
    const [anexos, setAnexos] = useState([]);
    const [historico, setHistorico] = useState([]);
    const [canaisSel, setCanaisSel] = useState([]);
    
    // Estados para carregamento dinamico
    const [etapasDisponiveis, setEtapasDisponiveis] = useState([]);
    const [subEtapasDisponiveis, setSubEtapasDisponiveis] = useState([]);
    const [loadingEtapas, setLoadingEtapas] = useState(false);
    const [loadingSubEtapas, setLoadingSubEtapas] = useState(false);
    
    // Estados de controle
    const [loading, setLoading] = useState(false);
    const [loadingHistorico, setLoadingHistorico] = useState(false);
    const [showConfirmDelete, setShowConfirmDelete] = useState(false);
    const [showConfirmDiscard, setShowConfirmDiscard] = useState(false);
    const [comentarioDescarte, setComentarioDescarte] = useState('');
    const [error, setError] = useState(null);
    
    const fileInputRef = useRef(null);
    const debouncedDataAlerta = useDebounce(dataAlerta, 1000);

    const roadmap = useMemo(() => {
        if (!Array.isArray(historico) || historico.length === 0) {
            return { items: [], currentKey: '' };
        }

        const toDate = (value) => {
            const raw = extrairTextoSeguro(value);
            if (!raw) return null;
            const d = new Date(raw);
            return Number.isNaN(d.getTime()) ? null : d;
        };

        const order = [];
        const byKey = new Map();
        let lastEvent = null;

        historico.forEach((item, idx) => {
            const step = getHistoricoStep(item);
            const key = `${step.etapa}||${step.sub}`.toLowerCase();
            const date = toDate(item?.data_movimentacao || item?.data_movimentação || item?.data);

            if (!byKey.has(key)) {
                byKey.set(key, {
                    key,
                    etapa: step.etapa,
                    sub: step.sub,
                    label: step.label,
                    lastDate: date,
                    lastIdx: idx,
                });
                order.push(key);
            } else {
                const entry = byKey.get(key);
                if (date) entry.lastDate = date;
                entry.lastIdx = idx;
            }

            const rank = date ? date.getTime() : idx;
            if (!lastEvent || rank > lastEvent.rank) {
                lastEvent = { key, rank };
            }
        });

        return {
            items: order.map((k) => byKey.get(k)),
            currentKey: lastEvent ? lastEvent.key : '',
        };
    }, [historico]);

    const toggleCanal = (id) => {
        setCanaisSel((prev) => {
            if (!Array.isArray(prev)) return [id];
            return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
        });
    };

    // ===== FUNÇÕES DE CARREGAMENTO DINÂMICO =====

    const carregarEtapas = useCallback(async () => {
        setLoadingEtapas(true);
        setError(null);
        
        try {
            const etapas = await buscarEtapas();
            setEtapasDisponiveis(etapas);
        } catch (error) {
            console.error('Erro ao carregar etapas:', error);
            setError('Erro ao carregar etapas. Usando dados padrão.');
            
            // Fallback para dados estáticos em caso de erro
            setEtapasDisponiveis([
                { id: 2, nome: 'Distribuidora', descricao: 'Processo em tratativa com a Distribuidora.' },
                { id: 3, nome: 'Ouvidoria', descricao: 'Processo escalado para a Ouvidoria.' },
                { id: 4, nome: 'ANEEL', descricao: 'Processo escalado para a ANEEL.' },
                { id: 5, nome: 'SMA', descricao: 'Processo em análise no SMA.' },
                { id: 6, nome: 'Pendente', descricao: 'Deferido, aguardando início da conciliação.' },
                { id: 7, nome: 'Em Conciliação', descricao: 'Valores do deferimento sendo conciliados.' },
                { id: 8, nome: 'Em Contestação', descricao: 'Valores do deferimento em contestação.' }
            ]);
        } finally {
            setLoadingEtapas(false);
        }
    }, []);

    const carregarSubEtapas = useCallback(async (nomeEtapa) => {
        if (!nomeEtapa) {
            setSubEtapasDisponiveis([]);
            return;
        }

        setLoadingSubEtapas(true);
        setError(null);

        try {
            // Buscar ID da etapa pelo nome
            const etapaEncontrada = await buscarEtapaPorNome(nomeEtapa);
            
            if (etapaEncontrada) {
                const subEtapas = await buscarSubEtapasPorEtapa(etapaEncontrada.id);
                setSubEtapasDisponiveis(subEtapas);
            } else {
                setSubEtapasDisponiveis([]);
            }
        } catch (error) {
            console.error('Erro ao carregar sub-etapas:', error);
            setError('Erro ao carregar sub-etapas. Usando dados padrão.');
            
            // Fallback para dados estáticos baseados na etapa
            const subEtapasPadrao = getSubEtapasPadrao(nomeEtapa);
            setSubEtapasDisponiveis(subEtapasPadrao);
        } finally {
            setLoadingSubEtapas(false);
        }
    }, []);

    // Função auxiliar para sub-etapas padrão (fallback)
    const getSubEtapasPadrao = (nomeEtapa) => {
        const subEtapasPorEtapa = {
            'Distribuidora': [
                { id: 1, nome: 'Em elaboração' },
                { id: 2, nome: 'Aguardando retorno' },
                { id: 3, nome: 'Em contestação' }
            ],
            'Ouvidoria': [
                { id: 1, nome: 'Em elaboração' },
                { id: 2, nome: 'Aguardando retorno' },
                { id: 3, nome: 'Em contestação' }
            ],
            'ANEEL': [
                { id: 1, nome: 'Em elaboração' },
                { id: 2, nome: 'Aguardando retorno' },
                { id: 3, nome: 'Em contestação' }
            ],
            'SMA': [
                { id: 1, nome: 'Em elaboração' },
                { id: 2, nome: 'Aguardando retorno' },
                { id: 3, nome: 'Em contestação' }
            ],
            'Pendente': [
                { id: 2, nome: 'Aguardando retorno' },
                { id: 4, nome: 'Em análise' }
            ],
            'Em Conciliação': [
                { id: 2, nome: 'Aguardando retorno' },
                { id: 4, nome: 'Em análise' }
            ],
            'Em Contestação': [
                { id: 2, nome: 'AguardaNão retorno' },
                { id: 4, nome: 'Em análise' }
            ]
        };

        return subEtapasPorEtapa[nomeEtapa] || [];
    };

    // ===== useEffect HOOKS =====

    // Carregar etapas ao abrir o modal
    useEffect(() => {
        if (isOpen) {
            carregarEtapas();
        }
    }, [isOpen, carregarEtapas]);

    // Carregar sub-etapas quando a etapa mudar
    useEffect(() => {
        if (etapa) {
            carregarSubEtapas(etapa);
        } else {
            setSubEtapasDisponiveis([]);
        }
    }, [etapa, carregarSubEtapas]);

    // Inicializar dados quando o modal abrir
    useEffect(() => {
        if (isOpen && processo) {
            try {
                // Processar todos os campos de forma segura
                const dadosProcessados = {
                    etapa: extrairTextoSeguro(processo.etapa),
                    subEtapa: extrairTextoSeguro(processo.sub_etapa),
                    dataAlerta: processarDataSegura(processo.data_alerta),
                    relevancia: Boolean(processo.relevancia),
                    deferimento: processo.deferimento && typeof processo.deferimento === 'object' 
                        ? processo.deferimento 
                        : {}
                };
                
                // Aplicar os dados processados
                setEtapa(dadosProcessados.etapa);
                setSubEtapa(dadosProcessados.subEtapa);
                setDataAlerta(dadosProcessados.dataAlerta);
                setRelevancia(dadosProcessados.relevancia);
                setDadosDeferimento(dadosProcessados.deferimento);
                
                // Resetar campos do formulário
                setComentario('');
                setAnexos([]);
                
                // Carregar Histórico
                carregarHistorico();

                // Carregar Módulos salvos (sempre exibir, independente da etapa)
                (async () => {
                    try {
                        const { data: fluxo } = await api.get(`/fluxo-ressarcimento/${processo.id}`);
                        setFluxoSalvo(fluxo || null);
                    } catch { setFluxoSalvo(null); }
                    try {
                        const { data: fat } = await api.get(`/faturamento/${processo.id}`);
                        setFaturamentoSalvo(fat || null);
                    } catch { setFaturamentoSalvo(null); }
                })();
                
            } catch (error) {
                console.error('Erro ao processar dados do processo:', error);
                
                // Fallback com valores padrão
                setEtapa('');
                setSubEtapa('');
                setDataAlerta('');
                setRelevancia(false);
                setDadosDeferimento({});
                setComentario('');
                setAnexos([]);
            }
        }
    }, [isOpen, processo]);

    // Auto-salvar data de alerta
    useEffect(() => {
        if (debouncedDataAlerta && processo?.id) {
            salvarDataAlertaAutomatico();
        }
    }, [debouncedDataAlerta, processo?.id]);

    // ===== FUNÇÕES DE MANIPULAÇÀO =====

    const carregarHistorico = async () => {
        if (!processo?.id) return;
        setLoadingHistorico(true);
        try {
            const response = await getHistoricoById(processo.id);
            setHistorico(response || []);
        } catch (error) {
            console.error('Erro ao carregar Histórico:', error);
        } finally {
            setLoadingHistorico(false);
        }
    };

    const salvarDataAlertaAutomatico = async () => {
        try {
            await salvarDataAlerta(processo.id, debouncedDataAlerta);
        } catch (error) {
            console.error('Erro ao salvar data de alerta:', error);
        }
    };

    const handleEtapaChange = (novaEtapa) => {
        setEtapa(novaEtapa);
        setSubEtapa(''); // Resetar sub-etapa quaNão a etapa mudar
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!processo?.id) return;

        setLoading(true);
        try {
            const formData = new FormData();
            formData.append('etapa_atual', etapa);
            formData.append('sub_etapa', subEtapa);
            formData.append('comentario', comentario);
            formData.append('relevancia', relevancia.toString());

            if (Object.keys(dadosDeferimento).length > 0) {
                formData.append('deferimento', JSON.stringify(dadosDeferimento));
            }

            if (dadosFluxoRessarcimento.itens && dadosFluxoRessarcimento.itens.length > 0) {
                formData.append('fluxo_ressarcimento', JSON.stringify(dadosFluxoRessarcimento));
            }

            anexos.forEach(anexo => {
                formData.append('anexos', anexo);
            });

            // Canais selecionados
            if (canaisSel && canaisSel.length > 0) {
                try { formData.append('canais', JSON.stringify(canaisSel)); } catch {}
            }

            if (!(await confirmAction('Deseja salvar as alteracoes deste processo?'))) {
                return;
            }
            await movimentarProcesso(processo.id, formData);
            
            if (onUpdate) {
                onUpdate();
            }
            onClose();
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
            if (onUpdate) {
                onUpdate();
            }
            onClose();
            setShowConfirmDiscard(false);
            setComentarioDescarte('');
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
            if (onUpdate) {
                onUpdate();
            }
            onClose();
            setShowConfirmDelete(false);
        } catch (error) {
            console.error('Erro ao excluir processo:', error);
            alert('Erro ao excluir processo. Tente novamente.');
        } finally {
            setLoading(false);
        }
    };

    const handleFileChange = (e) => {
        const files = Array.from(e.target.files);
        setAnexos(prev => [...prev, ...files]);
    };

    const removeAnexo = (index) => {
        setAnexos(prev => prev.filter((_, i) => i !== index));
    };

    const formatFileSize = (bytes) => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const formatDateTime = (dateString) => {
        if (!dateString) return 'Data não informada';
        try {
            return new Date(dateString).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        } catch {
            return 'Data inválida';
        }
    };

    const getEtapaColor = (etapaName) => {
        const colors = {
            'Distribuidora': 'bg-[var(--accent)]',
            'Ouvidoria': 'bg-purple-600',
            'ANEEL': 'bg-red-600',
            'SMA': 'bg-success',
            'Pendente': 'bg-yellow-600',
            'Em Conciliação': 'bg-orange-600',
            'Em Contestação': 'bg-red-700',
            'Enviado ao Financeiro': 'bg-indigo-600',
            'RessarcimeNão': 'bg-teal-600',
            'Concluído': 'bg-gray-600',
            'Indeferido': 'bg-[var(--card)]'
        };
        return colors[etapaName] || '0';
    };

    // Versão segura que normaliza acentos e aplica mapeamento ASCII
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
                'distribuidora': 'bg-[var(--accent)]',
                'ouvidoria': 'bg-purple-600',
                'aneel': 'bg-red-600',
                'sma': 'bg-success',
                'pendente': 'bg-yellow-600',
                'em conciliacao': 'bg-orange-600',
                'em contestacao': 'bg-red-700',
                'Enviado ao Financeiro': 'bg-indigo-600',
                'faturamento': 'bg-teal-600',
                'concluido': 'bg-gray-600',
                'indeferido': 'bg-[var(--card)]',
            };
            return map[s] || '0';
        } catch { return '0'; }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-[2px] flex items-center justify-center z-50 p-4">
            <div className="sap-card w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b panel-border">
                    <div className="flex items-center gap-4">
                        <h2 className="text-xl font-bold text-[var(--fg)]">
                            Detalhes do Processo #{extrairTextoSeguro(processo?.numero_processo)}
                        </h2>
                        <span className={`px-3 py-1 rounded-full text-xs font-medium text-[var(--fg)] ${getEtapaColorSafe(extrairTextoSeguro(processo?.etapa))}`}>
                            {extrairTextoSeguro(processo?.etapa)}
                        </span>
                        {extrairTextoSeguro(processo?.sub_etapa) && (
                            <span className="px-2 py-1 bg-gray-700 rounded text-xs text-gray-300">
                                {extrairTextoSeguro(processo.sub_etapa)}
                            </span>
                        )}
                    </div>
                    <button
                        onClick={onClose}
                        className="btn-outline p-2"
                    >
                        <X size={24} />
                    </button>
                </div>

                {/* Error Banner */}
                {error && (
                    <div className="bg-yellow-900/50 border-l-4 border-yellow-500 p-4 mx-6 mt-4 rounded">
                        <div className="flex items-center">
                            <AlertTriangle className="text-yellow-500 mr-2" size={16} />
                            <p className="text-yellow-200 text-sm">{error}</p>
                            <button
                                onClick={() => setError(null)}
                                className="ml-auto text-yellow-400 hover:text-yellow-300"
                            >
                                <X size={14} />
                            </button>
                        </div>
                    </div>
                )}

                {/* Content */}
                <div className="flex-1 overflow-hidden flex">
                    {/* Left Panel - Form */}
                    <div className="w-2/3 p-6 overflow-y-auto">
                        <form onSubmit={handleSubmit} className="space-y-6">
                            {/* INãormações Básicas */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="sap-label mb-2">
                                        <Tag className="inline w-4 h-4 mr-2" />
                                        Etapa Atual
                                        {loadingEtapas && (
                                            <RefreshCw className="inline w-4 h-4 ml-2 animate-spin" />
                                        )}
                                    </label>
                                    <select
                                        value={etapa}
                                        onChange={(e) => handleEtapaChange(e.target.value)}
                                        className="w-full input-themed"

                                        disabled={loadingEtapas}
                                    >
                                        <option value="">
                                            {loadingEtapas ? 'Carregando etapas...' : 'Selecione uma etapa'}
                                        </option>
                                        {etapasDisponiveis
                                            .filter(etapaOption => {
                                                // Filtrar baseado na etapa atual do processo
                                                const etapaAtual = extrairTextoSeguro(processo?.etapa);
                                                
                                                // Se processo está em "Ativos" (coluna 1)
                                                if (['Distribuidora', 'Ouvidoria', 'ANEEL', 'SMA'].includes(etapaAtual)) {
                                                    return etapaOption.id_coluna_kanban === 1;
                                                }
                                                
                                                // Se processo está em "Deferidos" (coluna 2)  
                                                if (['Pendente', 'Em Conciliação', 'Em Contestação'].includes(etapaAtual)) {
                                                    return etapaOption.id_coluna_kanban === 2;
                                                }
                                                
                                                // Mostrar todas se no conseguir identificar
                                                return true;
                                            })
                                            .map(etapaOption => (
                                                <option key={etapaOption.id} value={etapaOption.nome}>
                                                    {etapaOption.nome}
                                                </option>
                                            ))
                                        }
                                    </select>
                                    {etapa && etapasDisponiveis.find(e => e.nome === etapa)?.descricao && (
                                        <p className="text-xs text-gray-400 mt-1">
                                            {etapasDisponiveis.find(e => e.nome === etapa).descricao}
                                        </p>
                                    )}
                                </div>

                                <div>
                                    <label className="sap-label mb-2">
                                        <User className="inline w-4 h-4 mr-2" />
                                        Sub-etapa
                                        {loadingSubEtapas && (
                                            <RefreshCw className="inline w-4 h-4 ml-2 animate-spin" />
                                        )}
                                    </label>
                                    <select
                                        value={subEtapa}
                                        onChange={(e) => setSubEtapa(e.target.value)}
                                        className="w-full input-themed"
                                        disabled={!etapa || loadingSubEtapas}
                                    >
                                        <option value="">
                                            {!etapa 
                                                ? 'Selecione uma etapa primeiro' 
                                                : loadingSubEtapas 
                                                    ? 'Carregando sub-etapas...' 
                                                    : subEtapasDisponiveis.length === 0
                                                        ? 'Nenhuma sub-etapa disponível'
                                                        : 'Selecione uma sub-etapa'
                                            }
                                        </option>
                                        {subEtapasDisponiveis.map(subEtapaOption => (
                                            <option key={subEtapaOption.id} value={subEtapaOption.nome}>
                                                {subEtapaOption.nome}
                                            </option>
                                        ))}
                                    </select>
                                    {!etapa && (
                                        <p className="text-xs opacity-70 mt-1">
                                            As sub-etapas seráo carregadas após selecionar uma etapa
                                        </p>
                                    )}
                                </div>
                            </div>

                            {/* Data de Alerta e Relevncia */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="sap-label mb-2">
                                        <Calendar className="inline w-4 h-4 mr-2" />
                                        Data de Alerta
                                    </label>
                                    <input
                                        type="date"
                                        value={dataAlerta}
                                        onChange={(e) => setDataAlerta(e.target.value)}
                                        className="w-full input-themed"
                                    />
                                </div>

                                <div className="flex items-center">
                                    <label className="flex items-center gap-3 text-sm font-semibold text-gray-300 cursor-pointer">
                                        <Star className="w-4 h-4" />
                                        <input
                                            type="checkbox"
                                            checked={relevancia}
                                            onChange={(e) => setRelevancia(e.target.checked)}
                                            className="w-4 h-4 text-yellow-600 bg-[var(--card)] border-[var(--border)] rounded focus:ring-yellow-500"
                                        />
                                        Processo Relevante
                                    </label>
                                </div>
                            </div>

                            {/* Resumos sempre visíveis (dados salvos) */}
                            {dadosDeferimento && Object.keys(dadosDeferimento || {}).length > 0 && (
                                <div className="mt-6 p-3 rounded-lg border border-[var(--border)] bg-[var(--panel)]/60">
                                    <div className="text-xs font-semibold opacity-70 mb-2">Deferimento (salvo)</div>
                                    <div className="text-sm grid grid-cols-1 md:grid-cols-2 gap-2">
                                        {dadosDeferimento.status_analise && <div>Status: {String(dadosDeferimento.status_analise)}</div>}
                                        {dadosDeferimento.data_procedencia && <div>Data Procedência: {String(dadosDeferimento.data_procedencia)}</div>}
                                        {dadosDeferimento.credito_simples != null && <div>Crédito Simples: {String(dadosDeferimento.credito_simples)}</div>}
                                        {dadosDeferimento.credito_dobro != null && <div>Crédito em Dobro: {String(dadosDeferimento.credito_dobro)}</div>}
                                    </div>
                                </div>
                            )}

                            {fluxoSalvo && Array.isArray(fluxoSalvo.itens) && fluxoSalvo.itens.length > 0 && (
                                <div className="mt-4 p-3 rounded-lg border border-[var(--border)] bg-[var(--panel)]/60">
                                    <div className="text-xs font-semibold opacity-70 mb-2">Fluxo de Ressarcimento (salvo)</div>
                                    <div className="space-y-2 text-sm">
                                        {fluxoSalvo.itens.map((it, idx) => (
                                            <div key={idx} className="border border-[var(--border)] rounded p-2">
                                                <div><span className="opacity-70">Forma:</span> {String(it.forma_devolucao || it.forma || '')}</div>
                                                {it.valor != null && <div><span className="opacity-70">Valor:</span> {String(it.valor)}</div>}
                                                {it.data_devolucao && <div><span className="opacity-70">Data Devolução:</span> {String(it.data_devolucao)}</div>}
                                                {it.data_envio_financeiro && <div><span className="opacity-70">Data Envio Financeiro:</span> {String(it.data_envio_financeiro)}</div>}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {faturamentoSalvo && Array.isArray(faturamentoSalvo.itens) && faturamentoSalvo.itens.length > 0 && (
                                <div className="mt-4 p-3 rounded-lg border border-[var(--border)] bg-[var(--panel)]/60">
                                    <div className="text-xs font-semibold opacity-70 mb-2">Faturamento (salvo)</div>
                                    <div className="space-y-2 text-sm">
                                        {faturamentoSalvo.itens.map((it, idx) => (
                                            <div key={idx} className="border border-[var(--border)] rounded p-2">
                                                {it.numero_nf && <div><span className="opacity-70">NF:</span> {String(it.numero_nf)}</div>}
                                                {it.data_emissao && <div><span className="opacity-70">Emissão:</span> {String(it.data_emissao)}</div>}
                                                {it.data_pagamento && <div><span className="opacity-70">Pagamento:</span> {String(it.data_pagamento)}</div>}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Módulos Condicionais (edição) */}
                            {etapa === 'Pendente' && (
                                <ModuloDeferimento
                                    processoId={processo?.id}
                                    dadosIniciais={dadosDeferimento}
                                    onUpdate={setDadosDeferimento}
                                />
                            )}

                            {(etapa === 'Em Conciliação' || etapa === 'Fluxo de Ressarcimento') && (
                                <ModuloFluxoRessarcimento
                                    processoId={processo?.id}
                                    onUpdate={setDadosFluxoRessarcimento}
                                />
                            )}

                            {/* comentário */}
                            <div>
                                <label className="sap-label mb-2">
                                    <MessageSquare className="inline w-4 h-4 mr-2" />
                                    Comentário da movimentação
                                </label>
                                <textarea
                                    value={comentario}
                                    onChange={(e) => setComentario(e.target.value)}
                                    rows={4}
                                    className="w-full input-themed resize-none"
                                    placeholder="Descreva as ações realizadas ou observações importantes..."

                                />
                <div className="mt-2 text-[12px] font-medium text-gray-300">Canais de Comunicação</div>
                <div className="mt-1 flex flex-wrap gap-2 text-[12px]">
                                    {[
                                        { id: 'whatsapp', label: 'WhatsApp' },
                                        { id: 'email', label: 'E-mail' },
                                        { id: 'sms', label: 'SMS' },
                                        { id: 'ligacao', label: 'Ligação' },
                                        { id: 'site', label: 'Site' },
                                        { id: 'pessoal', label: 'Pessoal' },
                                    ].map((c) => (
                                        <button
                                            key={c.id}
                                            type="button"
                                            onClick={() => toggleCanal(c.id)}
                                            className={[
                                                'px-3 py-1.5 rounded border text-[12px] font-medium font-sans',
                                                canaisSel && canaisSel.includes(c.id)
                                                    ? 'bg-[var(--accent)] border-[var(--accent)] text-[var(--fg)]'
                                                    : 'bg-[var(--panel)] border-[var(--panel-border)] hover:bg-[var(--panel-border)]/20'
                                            ].join(' ')}
                                        >{c.label}</button>
                                    ))}
                                </div>
                            </div>

                            {/* Anexos */}
                            <div>
                                <label className="sap-label mb-2">
                                    <Paperclip className="inline w-4 h-4 mr-2" />
                                    Anexos
                                </label>
                                <div className="space-y-3">
                                    <button
                                        type="button"
                                        onClick={() => fileInputRef.current?.click()}
                                        className="flex items-center gap-2 px-4 py-2 bg-[var(--accent)] hover:opacity-90 text-[var(--fg)] rounded-lg transition-colors"
                                    >
                                        <Paperclip size={16} />
                                        Adicionar Arquivos
                                    </button>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        multiple
                                        onChange={handleFileChange}
                                        className="hidden"
                                        accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.txt"
                                    />
                                    
                                    {anexos.length > 0 && (
                                        <div className="space-y-2">
                                            {anexos.map((arquivo, index) => (
                                                <div key={index} className="flex items-center justify-between p-3 bg-[var(--card)] rounded-lg">
                                                    <div className="flex items-center gap-3">
                                                        <Paperclip size={16} className="text-gray-400" />
                                                        <div>
                                                            <p className="text-sm text-[var(--fg)]">{arquivo.name}</p>
                                                            <p className="text-xs text-gray-400">{formatFileSize(arquivo.size)}</p>
                                                        </div>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={() => removeAnexo(index)}
                                                        className="text-red-400 hover:text-red-300 transition-colors"
                                                    >
                                                        <X size={16} />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Botões de Ação */}
                            <div className="flex gap-3 pt-4 border-t border-gray-700">
                                <button
                                    type="submit"
                                    disabled={loading || !etapa}
                                    className="flex items-center gap-2 px-6 py-3 bg-[var(--accent)] hover:opacity-90 disabled:bg-gray-600 text-[var(--fg)] rounded-lg transition-colors"
                                >
                                    {loading ? (
                                        <>
                                            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                            Processando...
                                        </>
                                    ) : (
                                        <>
                                            <ArrowRightCircle size={16} />
                                            Movimentar Processo
                                        </>
                                    )}
                                </button>

                                <button
                                    type="button"
                                    onClick={() => setShowConfirmDiscard(true)}
                                    className="flex items-center gap-2 px-6 py-3 bg-yellow-600 hover:bg-yellow-700 text-[var(--fg)] rounded-lg transition-colors"
                                >
                                    <AlertTriangle size={16} />
                                    Descartar
                                </button>

                                <button
                                    type="button"
                                    onClick={() => setShowConfirmDelete(true)}
                                    className="flex items-center gap-2 px-6 py-3 bg-red-600 hover:bg-red-700 text-[var(--fg)] rounded-lg transition-colors"
                                >
                                    <Trash2 size={16} />
                                    Excluir
                                </button>

                                <button
                                    type="button"
                                    onClick={() => {
                                        carregarEtapas();
                                        if (etapa) {
                                            carregarSubEtapas(etapa);
                                        }
                                    }}
                                    className="flex items-center gap-2 px-4 py-3 bg-gray-600 hover:bg-gray-700 text-[var(--fg)] rounded-lg transition-colors"
                                    title="Recarregar etapas e sub-etapas"
                                >
                                    <RefreshCw size={16} />
                                    Atualizar
                                </button>
                            </div>
                        </form>
                    </div>

                    {/* Right Panel - Histórico */}
                    <div className="w-1/3 bg-[var(--card)] border-l border-gray-700 flex flex-col">
                        <div className="p-4 border-b panel-border">
                            <h3 className="font-semibold text-[var(--fg)] flex items-center gap-2">
                                <Clock size={16} />
                                Histórico de movimentações
                            </h3>
                        </div>

                        {roadmap.items.length > 0 && (
                            <div className="px-4 pt-4">
                                <div className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold">
                                    Roadmap do processo
                                </div>
                                <div className="mt-3 space-y-3">
                                    {roadmap.items.map((step, idx) => {
                                        const isCurrent = step.key === roadmap.currentKey;
                                        return (
                                            <div key={step.key} className="flex items-start gap-3">
                                                <div className="flex flex-col items-center">
                                                    <div
                                                        className={`h-3 w-3 rounded-full ${isCurrent ? 'bg-[var(--accent)]' : 'bg-gray-500'}`}
                                                    />
                                                    {idx < roadmap.items.length - 1 && (
                                                        <div className="w-px flex-1 bg-gray-700 mt-1" />
                                                    )}
                                                </div>
                                                <div className="min-w-0">
                                                    <div className={`text-sm ${isCurrent ? 'font-semibold text-[var(--fg)]' : 'text-gray-300'}`}>
                                                        {step.etapa}
                                                    </div>
                                                    {step.sub && (
                                                        <div className="text-xs opacity-70 truncate">
                                                            {step.sub}
                                                        </div>
                                                    )}
                                                    {isCurrent && (
                                                        <div className="text-[10px] mt-1 text-[var(--accent)] font-semibold">
                                                            Atual
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                        
                        <div className="flex-1 overflow-y-auto p-4">
                            {loadingHistorico ? (
                                <div className="flex items-center justify-center py-8">
                                    <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                                </div>
                            ) : historico.length > 0 ? (
                                <div className="space-y-4">
                                    {historico.map((item, index) => (
                                        <div key={index} className="border-l-2 border-blue-500 pl-4 pb-4">
                                            <div className="flex items-center gap-2 mb-2">
                                                <span className={`px-2 py-1 rounded text-xs font-medium text-[var(--fg)] ${(() => {
                                                    const etapaRaw = extrairTextoSeguro(item.etapa_nova || item.etapa_destino || item.etapa || '');
                                                    const subRaw = extrairTextoSeguro(item.sub_etapa || '');
                                                    let etapa = etapaRaw; let sub = subRaw;
                                                    if ((!etapa || !sub) && item.status_composto) {
                                                        const parts = String(item.status_composto).split('-').map((p) => p.trim());
                                                        if (!etapa && parts.length) etapa = parts[0];
                                                        if (!sub && parts.length > 1) sub = parts.slice(1).join(' - ');
                                                    }
                                                    return getEtapaColorSafe(etapa || 'N/A');
                                                })()}`}>
                                                    {(() => {
                                                        const etapaRaw = extrairTextoSeguro(item.etapa_nova || item.etapa_destino || item.etapa || '');
                                                        const subRaw = extrairTextoSeguro(item.sub_etapa || '');
                                                        let etapa = etapaRaw; let sub = subRaw;
                                                        if ((!etapa || !sub) && item.status_composto) {
                                                            const parts = String(item.status_composto).split('-').map((p) => p.trim());
                                                            if (!etapa && parts.length) etapa = parts[0];
                                                            if (!sub && parts.length > 1) sub = parts.slice(1).join(' - ');
                                                        }
                                                        const canais = Array.isArray(item.canais) ? item.canais : [];
                                                        const lbl = `${etapa || 'N/A'}${sub ? ' - ' + sub : ''}${canais.length ? ' via ' + canais.join(', ') : ''}`;
                                                        return lbl;
                                                    })()}
                                                </span>
                                            </div>
                                            <p className="text-sm text-gray-300 mb-2">
                                                {extrairTextoSeguro(item.comentario) || 'Sem comentário'}
                                            </p>
                                            <div className="text-xs opacity-70">
                                                <p>Por: {extrairTextoSeguro(item.usuario_nome) || 'Sistema'}</p>
                                                <p>{formatDateTime(item.data_movimentação)}</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="text-center py-8 opacity-70">
                                    <Clock size={32} className="mx-auto mb-2 opacity-50" />
                                    <p>Nenhuma movimentação eNãontrada</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Modal de Confirmação de Descarte */}
            {showConfirmDiscard && (
                <div className="fixed inset-0 glass-card flex items-center justify-center z-60">
                    <div className="glass-card rounded-lg p-6 w-full max-w-md">
                        <h3 className="text-lg font-bold text-[var(--fg)] mb-4 flex items-center gap-2">
                            <AlertTriangle className="text-yellow-500" size={20} />
                            Confirmar Descarte
                        </h3>
                        <p className="text-gray-300 mb-4">
                            Tem certeza que deseja descartar este processo? Esta ação no pode serádesfeita.
                        </p>
                        <div className="mb-4">
                            <label className="sap-label mb-2">
                                Motivo do descarte (obrigatório):
                            </label>
                            <textarea
                                value={comentarioDescarte}
                                onChange={(e) => setComentarioDescarte(e.target.value)}
                                rows={3}
                                className="w-full input-themed resize-none"
                                placeholder="Descreva o motivo do descarte..."

                            />
                        </div>
                        <div className="flex gap-3">
                            <button
                                onClick={handleDescarte}
                                disabled={loading || !comentarioDescarte.trim()}
                                className="flex-1 px-4 py-2 bg-yellow-600 hover:bg-yellow-700 disabled:bg-gray-600 text-[var(--fg)] rounded-lg transition-colors"
                            >
                                {loading ? 'Descartando...' : 'Confirmar Descarte'}
                            </button>
                            <button
                                onClick={() => {
                                    setShowConfirmDiscard(false);
                                    setComentarioDescarte('');
                                }}
                                className="flex-1 px-4 py-2 bg-gray-600 hover:bg-gray-700 text-[var(--fg)] rounded-lg transition-colors"
                            >
                                Cancelar
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Modal de Confirmação de Exclusão */}
            {showConfirmDelete && (
                <div className="fixed inset-0 glass-card flex items-center justify-center z-60">
                    <div className="glass-card rounded-lg p-6 w-full max-w-md">
                        <h3 className="text-lg font-bold text-[var(--fg)] mb-4 flex items-center gap-2">
                            <Trash2 className="text-red-500" size={20} />
                            Confirmar Exclusão
                        </h3>
                        <p className="text-gray-300 mb-6">
                            Tem certeza que deseja excluir permanentemente este processo? 
                            <strong className="text-red-400"> Esta ação no pode serádesfeita.</strong>
                        </p>
                        <div className="flex gap-3">
                            <button
                                onClick={handleExclusao}
                                disabled={loading}
                                className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 text-[var(--fg)] rounded-lg transition-colors"
                            >
                                {loading ? 'Excluindo...' : 'Confirmar Exclusão'}
                            </button>
                            <button
                                onClick={() => setShowConfirmDelete(false)}
                                className="flex-1 px-4 py-2 bg-gray-600 hover:bg-gray-700 text-[var(--fg)] rounded-lg transition-colors"
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

export default DetalhesProcessoModal;




