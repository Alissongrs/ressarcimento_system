import React, { useEffect, useState } from 'react';

const ModuloDeferimento = ({ dados = {}, onUpdate }) => {
  const [aplicarDobro, setAplicarDobro] = useState(!!dados.credito_dobro);

  useEffect(() => {
    // Sincroniza o toggle quando chegar dado salvo do backend
    setAplicarDobro(!!dados.credito_dobro);
  }, [dados]);

  const handleChange = (e) => {
    const { name, value, type } = e.target;
    const valor = type === 'number' ? parseFloat(value) || 0 : value;
    onUpdate({ ...dados, [name]: valor });
  };

  const handleAplicarDobroChange = (e) => {
    const isChecked = e.target.checked;
    setAplicarDobro(isChecked);
    if (!isChecked) {
      onUpdate({ ...dados, credito_dobro: 0 });
    }
  };

  return (
    <div className="border-t border-blue-800/50 pt-4 animate-fade-in">
      <h3 className="font-semibold text-[var(--fg)] mb-3 text-sm">DADOS DE DEFERIMENTO</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <div>
          <label className="block text-xs font-semibold text-gray-400 mb-1">Data da Procedência</label>
          <input
            type="date"
            name="data_procedencia"
            value={dados.data_procedencia || ''}
            onChange={handleChange}
            className="w-full p-2 border border-[var(--border)] bg-[var(--card)] text-[var(--fg)] rounded"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-400 mb-1">Crédito Simples (R$)</label>
          <input
            type="number"
            name="credito_simples"
            value={dados.credito_simples || 0}
            onChange={handleChange}
            className="w-full p-2 border border-[var(--border)] bg-[var(--card)] text-[var(--fg)] rounded"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-400 mb-1">Crédito em Dobro (R$)</label>
          <input
            type="number"
            name="credito_dobro"
            value={dados.credito_dobro || 0}
            onChange={handleChange}
            className="w-full p-2 border border-[var(--border)] bg-[var(--card)] text-[var(--fg)] rounded disabled:opacity-50"
            disabled={!aplicarDobro}
          />
        </div>
        <div className="flex items-end pb-1">
          <label className="flex items-center gap-2 text-gray-300">
            <input
              type="checkbox"
              checked={aplicarDobro}
              onChange={handleAplicarDobroChange}
              className="h-4 w-4 rounded bg-[var(--card)] border-[var(--border)]"
            />
            Aplicar Crédito em Dobro?
          </label>
        </div>
      </div>
    </div>
  );
};

export default ModuloDeferimento;
