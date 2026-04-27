import React, { useState, useEffect } from 'react';
import apiClient from '../services/apiClient';
import DetalhesFaturaModal from '../components/DetalhesFaturaModal';

export default function AnaliseDesvioSimples() {
  const [faturas, setFaturas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filtro, setFiltro] = useState({ empresa: 14 });
  const [abaAtiva, setAbaAtiva] = useState('CONFIRMADO');
  const [selectedFatura, setSelectedFatura] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    carregarFaturas();
  }, [filtro]);

  const carregarFaturas = async () => {
    setLoading(true);
    try {
      const res = await apiClient.get('/api/v1/faturas/com-analise', {
        params: {
          empresa: filtro.empresa,
          limit: 2000,
        },
      });
      setFaturas(res.data || []);
    } catch (error) {
      console.error('Erro ao carregar faturas:', error);
      setFaturas([]);
    } finally {
      setLoading(false);
    }
  };

  const handleAbrirDetalhes = (fatura) => {
    setSelectedFatura(fatura);
    setModalOpen(true);
  };

  const handleReprocessar = async (faturaId) => {
    try {
      await apiClient.post(`/api/v1/faturas/${faturaId}/reprocessar-ia`);
      // Recarrega a lista
      await carregarFaturas();
    } catch (error) {
      console.error('Erro ao reprocessar:', error);
    }
  };

  const getDecisao = (fatura) =>
    fatura.resultado_analises?.ia_opus_5_4_decisao?.decisao_final || 'PENDENTE';

  const confirmadas   = faturas.filter(f => getDecisao(f) === 'CONFIRMADO');
  const inconclusivos = faturas.filter(f => getDecisao(f) === 'INCONCLUSIVO');
  const faturasVisiveis = abaAtiva === 'CONFIRMADO' ? confirmadas : inconclusivos;

  const ressarcimentoTotal = confirmadas.reduce((sum, f) => {
    const r = f.resultado_analises?.ia_opus_5_4_decisao || {};
    return sum + ((f.valor || 0) * (r.percentual_ressarcimento || 0) / 100);
  }, 0);

  const confiancaMedia = faturasVisiveis.length
    ? faturasVisiveis.reduce((sum, f) => {
        return sum + (f.resultado_analises?.ia_opus_5_4_decisao?.confianca_final || 0);
      }, 0) / faturasVisiveis.length
    : 0;

  const valorEmAnalise = inconclusivos.reduce((sum, f) => sum + (f.valor || 0), 0);

  return (
    <div className="p-6 space-y-6">

      {/* Header */}
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Análise de Faturas</h1>
        <div className="flex items-center gap-3">
          <div>
            <input
              type="number"
              value={filtro.empresa}
              onChange={(e) => setFiltro({ empresa: parseInt(e.target.value) || 14 })}
              placeholder="Empresa"
              className="px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-sm w-28"
            />
          </div>
          <button
            onClick={carregarFaturas}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded font-semibold transition"
          >
            Atualizar
          </button>
        </div>
      </div>

      {/* Abas */}
      <div className="flex gap-1 border-b border-[var(--border)]">
        <button
          onClick={() => setAbaAtiva('CONFIRMADO')}
          className={`px-6 py-3 text-sm font-semibold border-b-2 transition -mb-px ${
            abaAtiva === 'CONFIRMADO'
              ? 'border-green-500 text-green-400'
              : 'border-transparent opacity-60 hover:opacity-80'
          }`}
        >
          Confirmados
          <span className={`ml-2 px-2 py-0.5 rounded-full text-xs ${
            abaAtiva === 'CONFIRMADO' ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'
          }`}>
            {confirmadas.length}
          </span>
        </button>
        <button
          onClick={() => setAbaAtiva('INCONCLUSIVO')}
          className={`px-6 py-3 text-sm font-semibold border-b-2 transition -mb-px ${
            abaAtiva === 'INCONCLUSIVO'
              ? 'border-yellow-500 text-yellow-400'
              : 'border-transparent opacity-60 hover:opacity-80'
          }`}
        >
          Inconclusivos
          <span className={`ml-2 px-2 py-0.5 rounded-full text-xs ${
            abaAtiva === 'INCONCLUSIVO' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-gray-500/20 text-gray-400'
          }`}>
            {inconclusivos.length}
          </span>
        </button>
      </div>

      {/* Cards de resumo */}
      {abaAtiva === 'CONFIRMADO' ? (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] p-4 rounded-lg">
            <div className="text-sm opacity-60 mb-2">Confirmadas</div>
            <div className="text-3xl font-bold text-green-500">{confirmadas.length}</div>
          </div>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] p-4 rounded-lg">
            <div className="text-sm opacity-60 mb-2">Valor Total das Faturas</div>
            <div className="text-2xl font-bold">
              R$ {confirmadas.reduce((s, f) => s + (f.valor || 0), 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
            </div>
          </div>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] p-4 rounded-lg">
            <div className="text-sm opacity-60 mb-2">Ressarcimento Estimado</div>
            <div className="text-2xl font-bold text-green-400">
              R$ {ressarcimentoTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
            </div>
          </div>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] p-4 rounded-lg">
            <div className="text-sm opacity-60 mb-2">Confiança Média</div>
            <div className="text-3xl font-bold text-blue-400">{confiancaMedia.toFixed(0)}%</div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] p-4 rounded-lg">
            <div className="text-sm opacity-60 mb-2">Inconclusivos</div>
            <div className="text-3xl font-bold text-yellow-400">{inconclusivos.length}</div>
          </div>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] p-4 rounded-lg">
            <div className="text-sm opacity-60 mb-2">Valor em Análise</div>
            <div className="text-2xl font-bold">
              R$ {valorEmAnalise.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
            </div>
          </div>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] p-4 rounded-lg">
            <div className="text-sm opacity-60 mb-2">Confiança Média</div>
            <div className="text-3xl font-bold text-blue-400">{confiancaMedia.toFixed(0)}%</div>
          </div>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border)] p-4 rounded-lg">
            <div className="text-sm opacity-60 mb-2">Requerem Revisão Manual</div>
            <div className="text-3xl font-bold text-yellow-300">{inconclusivos.length}</div>
          </div>
        </div>
      )}

      {/* Tabela de Faturas */}
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg overflow-hidden">
        {loading ? (
          <div className="p-8 text-center">Carregando faturas...</div>
        ) : faturasVisiveis.length === 0 ? (
          <div className="p-8 text-center opacity-60">Nenhuma fatura encontrada</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[var(--bg)] border-b border-[var(--border)]">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold">ID</th>
                  <th className="px-4 py-3 text-left font-semibold">UC</th>
                  <th className="px-4 py-3 text-left font-semibold">Concessionária</th>
                  <th className="px-4 py-3 text-left font-semibold">Período</th>
                  <th className="px-4 py-3 text-right font-semibold">Valor</th>
                  <th className="px-4 py-3 text-right font-semibold">Confiança</th>
                  {abaAtiva === 'CONFIRMADO' && (
                    <th className="px-4 py-3 text-right font-semibold">Ressarcimento</th>
                  )}
                  {abaAtiva === 'INCONCLUSIVO' && (
                    <th className="px-4 py-3 text-left font-semibold">Fichas</th>
                  )}
                  <th className="px-4 py-3 text-center font-semibold">Ação</th>
                </tr>
              </thead>
              <tbody>
                {faturasVisiveis.map((fatura) => {
                  const resultado = fatura.resultado_analises?.ia_opus_5_4_decisao || {};
                  const fichas = resultado.fichas_confirmadas || [];
                  const ressarcimento = (fatura.valor || 0) * (resultado.percentual_ressarcimento || 0) / 100;

                  return (
                    <tr
                      key={fatura.id}
                      className="border-b border-[var(--border)] hover:bg-[var(--bg)] cursor-pointer transition"
                      onClick={() => handleAbrirDetalhes(fatura)}
                    >
                      <td className="px-4 py-3 font-semibold text-blue-400">{fatura.id}</td>
                      <td className="px-4 py-3">{fatura.UC}</td>
                      <td className="px-4 py-3">{fatura.concessionaria}</td>
                      <td className="px-4 py-3">{fatura.mes_ref}</td>
                      <td className="px-4 py-3 text-right">R$ {(fatura.valor || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                      <td className="px-4 py-3 text-right">{resultado.confianca_final || 0}%</td>
                      {abaAtiva === 'CONFIRMADO' && (
                        <td className="px-4 py-3 text-right font-semibold text-green-400">
                          R$ {ressarcimento.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                        </td>
                      )}
                      {abaAtiva === 'INCONCLUSIVO' && (
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {fichas.length > 0
                              ? fichas.map(f => (
                                  <span key={f} className="px-2 py-0.5 rounded text-xs bg-yellow-500/20 text-yellow-300 border border-yellow-500/30">
                                    {f}
                                  </span>
                                ))
                              : <span className="opacity-40 text-xs">—</span>
                            }
                          </div>
                        </td>
                      )}
                      <td className="px-4 py-3 text-center">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleAbrirDetalhes(fatura);
                          }}
                          className="px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded text-xs font-semibold transition"
                        >
                          Ver Detalhes
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal de Detalhes */}
      {selectedFatura && (
        <DetalhesFaturaModal
          fatura={selectedFatura}
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          onReprocessar={handleReprocessar}
        />
      )}
    </div>
  );
}
