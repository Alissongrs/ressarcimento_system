// src/components/ModuloFluxoRessarcimento.jsx
import React, { useState, useEffect } from 'react';
import { Plus, Trash2 } from 'lucide-react';

const ModuloFluxoRessarcimento = ({ processoId, onUpdate }) => {
    const [itens, setItens] = useState([{
        forma_devolucao: '',
        valor: '',
        data_devolucao: '',
        data_envio_financeiro: ''
    }]);
    const [loading, setLoading] = useState(false);

    // Carregar dados existentes quando o componente for montado
    useEffect(() => {
        if (processoId) {
            carregarDados();
        }
    }, [processoId]);

    const carregarDados = async () => {
        try {
            // eslint-disable-next-line no-undef
            const response = await api.get(`/fluxo-ressarcimento/${processoId}`);
            const data = response.data;
            
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
        
        // Notificar o componente pai sobre as mudanças
        if (onUpdate) {
            onUpdate({ itens: novosItens });
        }
    };

    const salvarDados = async () => {
        setLoading(true);
        try {
            const response = await fetch(`/api/fluxo-ressarcimento/${processoId}`, {
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
        <div className="border-t border-[var(--border)] pt-4 animate-fade-in">
            <div className="flex justify-between items-center mb-4">
                <h3 className="font-semibold text-sm">FLUXO DE RESSARCIMENTO (CONCILIAÇÃO)</h3>
                <div className="flex gap-2">
                    <button
                        onClick={adicionarItem}
                        className="flex items-center gap-1 px-3 py-1 bg-green-600 hover:bg-green-700 text-white rounded text-xs transition-colors"
                        title="Adicionar nova devolução"
                    >
                        <Plus size={14} />
                        Adicionar
                    </button>
                    <button
                        onClick={salvarDados}
                        disabled={loading}
                        className="px-3 py-1 bg-[var(--accent)] hover:opacity-90 disabled:opacity-50 text-white rounded text-xs transition-colors"
                    >
                        {loading ? 'Salvando...' : 'Salvar'}
                    </button>
                </div>
            </div>

            <div className="space-y-4">
                {itens.map((item, index) => (
                    <div key={index} className="border border-[var(--border)] rounded-lg p-4 bg-[var(--card)]/70">
                        <div className="flex justify-between items-center mb-3">
                            <span className="text-xs font-semibold opacity-70">
                                Devolução #{index + 1}
                            </span>
                            {itens.length > 1 && (
                                <button
                                    onClick={() => removerItem(index)}
                                    className="text-red-400 hover:text-red-300 transition-colors"
                                    title="Remover esta devolução"
                                >
                                    <Trash2 size={14} />
                                </button>
                            )}
                        </div>

                        {/* Forma de Devolução - Checkboxes lado a lado */}
                        <div className="mb-4">
                            <label className="block text-xs font-semibold opacity-70 mb-2">
                                Forma de Devolução
                            </label>
                            <div className="flex gap-4">
                                {['Fatura', 'GD', 'Depósito'].map((forma) => (
                                    <label key={forma} className="flex items-center gap-2 text-sm cursor-pointer">
                                        <input
                                            type="radio"
                                            name={`forma_devolucao_${index}`}
                                            value={forma}
                                            checked={item.forma_devolucao === forma}
                                            onChange={(e) => handleItemChange(index, 'forma_devolucao', e.target.value)}
                                            className="text-[var(--accent)] focus:ring-[var(--accent)]"
                                        />
                                        {forma}
                                    </label>
                                ))}
                            </div>
                        </div>

                        {/* Campos de valor e datas */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                            <div>
                                <label className="block text-xs font-semibold opacity-70 mb-1">
                                    Valor (R$)
                                </label>
                                <input
                                    type="number"
                                    step="0.01"
                                    value={item.valor}
                                    onChange={(e) => handleItemChange(index, 'valor', e.target.value)}
                                    className="w-full p-2 border border-[var(--border)] bg-[var(--card)] text-[var(--fg)] rounded focus:border-[var(--accent)] focus:outline-none"
                                    placeholder="0,00"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-semibold opacity-70 mb-1">
                                    Data da Devolução
                                </label>
                                <input
                                    type="date"
                                    value={item.data_devolucao}
                                    onChange={(e) => handleItemChange(index, 'data_devolucao', e.target.value)}
                                    className="w-full p-2 border border-[var(--border)] bg-[var(--card)] text-[var(--fg)] rounded focus:border-[var(--accent)] focus:outline-none"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-semibold opacity-70 mb-1">
                                    Data de Envio ao Financeiro/Gestão
                                </label>
                                <input
                                    type="date"
                                    value={item.data_envio_financeiro}
                                    onChange={(e) => handleItemChange(index, 'data_envio_financeiro', e.target.value)}
                                    className="w-full p-2 border border-[var(--border)] bg-[var(--card)] text-[var(--fg)] rounded focus:border-[var(--accent)] focus:outline-none"
                                />
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            {/* Resumo */}
            {itens.length > 1 && (
                <div className="mt-4 p-3 bg-[var(--card)] rounded-lg">
                    <div className="text-xs opacity-70">
                        <strong>Resumo:</strong> {itens.length} devolução(ões) • 
                        Valor total: R$ {itens.reduce((total, item) => total + (parseFloat(item.valor) || 0), 0).toFixed(2)}
                    </div>
                </div>
            )}
        </div>
    );
};

export default ModuloFluxoRessarcimento;


