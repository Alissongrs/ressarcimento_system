import React from 'react';

// Função para formatar datas (pode ser movida para um arquivo de utils)
const formatarData = (dataISO) => {
  if (!dataISO) return 'N/A';
  try {
    const data = new Date(dataISO);
    return data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo' });
  } catch (e) {
    return 'Data inválida';
  }
};

// Função para formatar valores monetários
const formatarValor = (valor) => {
  if (valor == null || isNaN(valor)) return 'N/A';
  return parseFloat(valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

const CardDeferimento = ({ deferimento, onEdit }) => {
  if (!deferimento) return null;

  return (
    <div className="glass-card p-6 rounded-lg border">
      <h2 className="text-2xl font-semibold mb-4 border-b pb-2">Dados do Deferimento</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-base">
        <p><strong>Status da Análise:</strong> <span className="font-normal">{deferimento.status_analise || 'N/A'}</span></p>
        <p><strong>Data da Procedência:</strong> <span className="font-normal">{formatarData(deferimento.data_procedencia)}</span></p>
        <p><strong>Crédito Simples:</strong> <span className="font-normal text-green-700">{formatarValor(deferimento.credito_simples)}</span></p>
        <p><strong>Crédito em Dobro:</strong> <span className="font-normal text-green-700">{formatarValor(deferimento.credito_dobro)}</span></p>
      </div>
      <button onClick={onEdit} className="mt-6 px-4 py-2 bg-gray-600 text-[var(--fg)] font-bold rounded-lg hover:bg-gray-700 transition-colors">
        Editar Deferimento
      </button>
    </div>
  );
};

export default CardDeferimento;
