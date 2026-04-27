import React, { useState, useEffect } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import apiClient from '../services/apiClient';

export default function DetalhesFaturaModal({ fatura, isOpen, onClose, onReprocessar }) {
  const [loading, setLoading] = useState(false);
  const [analiseData, setAnaliseData] = useState(null);
  const [consumoData, setConsumoData] = useState([]);
  const [reprocessing, setReprocessing] = useState(false);

  useEffect(() => {
    if (!isOpen || !fatura) return;
    carregarDados();
  }, [isOpen, fatura]);

  const carregarDados = async () => {
    setLoading(true);
    try {
      // Busca resultado_analises do banco
      const res = await apiClient.get(`/api/v1/faturas/${fatura.id}/detalhes`);
      const dados = res.data;

      setAnaliseData(dados);

      // Simula dados de consumo (seria buscado do banco em produção)
      gerarDadosConsumo();
    } catch (error) {
      console.error('Erro ao carregar detalhes:', error);
    } finally {
      setLoading(false);
    }
  };

  const gerarDadosConsumo = () => {
    // Gera dados simulados de consumo dos últimos 12 meses
    const meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    const dados = meses.map((mes, idx) => ({
      mes,
      consumo: Math.floor(Math.random() * 500 + 200),
      media: 350,
    }));
    setConsumoData(dados);
  };

  const handleReprocessar = async () => {
    setReprocessing(true);
    try {
      await onReprocessar(fatura.id);
      // Recarrega dados após reprocessamento
      await carregarDados();
    } finally {
      setReprocessing(false);
    }
  };

  if (!isOpen) return null;

  const resultado = analiseData?.resultado_analises?.ia_opus_5_4_decisao || {};
  const fichas4_1 = analiseData?.resultado_analises?.ia_4_1_apontamentos?.fichas || [];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-[var(--bg)] border border-[var(--border)] rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="sticky top-0 bg-[var(--bg)] border-b border-[var(--border)] p-4 flex justify-between items-center">
          <h2 className="text-xl font-bold">Detalhes da Fatura</h2>
          <button
            onClick={onClose}
            className="text-2xl cursor-pointer hover:opacity-70"
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div className="p-8 text-center">Carregando...</div>
        ) : (
          <div className="p-6 space-y-6">

            {/* Dados Básicos */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 bg-[var(--bg-secondary)] p-4 rounded-lg border border-[var(--border)]">
              <div>
                <div className="text-xs opacity-60">ID</div>
                <div className="font-semibold">{fatura.id}</div>
              </div>
              <div>
                <div className="text-xs opacity-60">UC</div>
                <div className="font-semibold">{fatura.UC}</div>
              </div>
              <div>
                <div className="text-xs opacity-60">Valor</div>
                <div className="font-semibold text-green-600">R$ {parseFloat(fatura.valor || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</div>
              </div>
              <div>
                <div className="text-xs opacity-60">Concessionária</div>
                <div className="font-semibold">{fatura.concessionaria}</div>
              </div>
              <div>
                <div className="text-xs opacity-60">Período</div>
                <div className="font-semibold">{fatura.mes_ref}</div>
              </div>
            </div>

            {/* Gráfico de Consumo */}
            <div className="bg-[var(--bg-secondary)] p-4 rounded-lg border border-[var(--border)] overflow-visible">
              <h3 className="font-semibold mb-4">Série Histórica de Consumo (12 meses)</h3>
              {consumoData.length > 0 && (
                <div style={{ overflow: 'visible' }}>
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={consumoData} margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="mes" />
                      <YAxis />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'rgba(0, 0, 0, 0.8)',
                          border: '1px solid rgba(255, 255, 255, 0.2)',
                          borderRadius: '4px',
                          padding: '8px',
                          zIndex: 1000
                        }}
                        wrapperStyle={{ zIndex: 1000 }}
                        cursor={{ stroke: '#888', strokeWidth: 2 }}
                      />
                      <Legend />
                      <Line type="monotone" dataKey="consumo" stroke="#3b82f6" name="Consumo (kWh)" strokeWidth={2} />
                      <Line type="monotone" dataKey="media" stroke="#ef4444" strokeDasharray="5 5" name="Média" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* Fichas Detectadas */}
            <div className="bg-[var(--bg-secondary)] p-4 rounded-lg border border-[var(--border)]">
              <h3 className="font-semibold mb-3">Fichas Detectadas (4.1-mini)</h3>
              <div className="space-y-2">
                {fichas4_1.length > 0 ? (
                  fichas4_1.map(ficha => (
                    <div key={ficha} className="flex items-center gap-2 p-2 bg-[var(--bg)] rounded">
                      <span className="text-green-500">✓</span>
                      <span className="font-semibold">{ficha}</span>
                      <span className="text-xs opacity-60 ml-auto">Confirmado pelo modelo inicial</span>
                    </div>
                  ))
                ) : (
                  <div className="text-opacity-60">Nenhuma ficha detectada</div>
                )}
              </div>
            </div>

            {/* Análise IA (gpt-5.4) */}
            <div className="bg-[var(--bg-secondary)] p-4 rounded-lg border border-[var(--border)]">
              <h3 className="font-semibold mb-4">Análise Final (gpt-5.4)</h3>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                <div className="bg-[var(--bg)] p-3 rounded border border-[var(--border)]">
                  <div className="text-xs opacity-60 mb-1">Decisão Final</div>
                  <div className={`font-bold text-lg ${
                    resultado.decisao_final === 'CONFIRMADO' ? 'text-green-500' :
                    resultado.decisao_final === 'REFUTADO' ? 'text-red-500' :
                    'text-yellow-500'
                  }`}>
                    {resultado.decisao_final || 'N/A'}
                  </div>
                </div>

                <div className="bg-[var(--bg)] p-3 rounded border border-[var(--border)]">
                  <div className="text-xs opacity-60 mb-1">Confiança</div>
                  <div className="font-bold text-lg">{resultado.confianca_final || 0}%</div>
                </div>

                <div className="bg-[var(--bg)] p-3 rounded border border-[var(--border)]">
                  <div className="text-xs opacity-60 mb-1">Ressarcimento</div>
                  <div className="font-bold text-lg text-green-600">{resultado.percentual_ressarcimento || 0}%</div>
                </div>

                <div className="bg-[var(--bg)] p-3 rounded border border-[var(--border)]">
                  <div className="text-xs opacity-60 mb-1">Valor Estimado</div>
                  <div className="font-bold text-lg text-green-600">
                    R$ {((fatura.valor || 0) * (resultado.percentual_ressarcimento || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <div className="text-sm font-semibold mb-2">Ficha Principal</div>
                  <div className="text-sm bg-[var(--bg)] p-2 rounded">{resultado.ficha_principal || 'N/A'}</div>
                </div>

                <div>
                  <div className="text-sm font-semibold mb-2">Justificativa</div>
                  <div className="text-sm bg-[var(--bg)] p-3 rounded whitespace-pre-wrap border border-[var(--border)]">
                    {resultado.justificativa || 'Sem análise disponível'}
                  </div>
                </div>

                <div>
                  <div className="text-sm font-semibold mb-2">Recomendação</div>
                  <div className="text-sm bg-[var(--bg)] p-3 rounded border border-[var(--border)] italic text-blue-400">
                    {resultado.recomendacao || 'Nenhuma recomendação'}
                  </div>
                </div>
              </div>
            </div>

            {/* Botões de Ação */}
            <div className="flex gap-3 justify-end pt-4 border-t border-[var(--border)]">
              <button
                onClick={onClose}
                className="px-4 py-2 border border-[var(--border)] rounded hover:bg-[var(--bg-secondary)] transition"
              >
                Fechar
              </button>
              <button
                onClick={handleReprocessar}
                disabled={reprocessing}
                className={`px-4 py-2 rounded font-semibold transition ${
                  reprocessing
                    ? 'bg-gray-500 opacity-50 cursor-not-allowed'
                    : 'bg-blue-600 hover:bg-blue-700 text-white'
                }`}
              >
                {reprocessing ? 'Reprocessando...' : 'Reprocessar com IA'}
              </button>
              <button
                onClick={() => {}}
                className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded font-semibold transition"
              >
                Aprovar
              </button>
              <button
                onClick={() => {}}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded font-semibold transition"
              >
                Rejeitar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
