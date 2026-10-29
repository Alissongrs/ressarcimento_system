import React, { useState, useEffect } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import apiClient from '../services/apiClient';

// Teto robusto do eixo Y: quando um mês é outlier (> 4× a mediana, ex.: misparse de consumo),
// capa o eixo em ~4× a mediana pra as barras normais não sumirem. Retorna [0, cap] ou null (auto).
function robustKwhDomain(vals) {
  const vs = (vals || []).map(Number).filter((v) => v > 0).sort((a, b) => a - b);
  if (vs.length < 3) return null;
  const med = vs[Math.floor(vs.length / 2)];
  const max = vs[vs.length - 1];
  return (med > 0 && max > med * 4) ? [0, Math.ceil(med * 4)] : null;
}

export default function DetalhesFaturaModal({ fatura, isOpen, onClose, onReprocessar }) {
  const [loading, setLoading] = useState(false);
  const [analiseData, setAnaliseData] = useState(null);
  const [consumoData, setConsumoData] = useState([]);
  const [mediaConsumo, setMediaConsumo] = useState(0);
  const [reprocessing, setReprocessing] = useState(false);

  useEffect(() => {
    if (!isOpen || !fatura) return;
    carregarDados();
  }, [isOpen, fatura]);

  const carregarDados = async () => {
    setLoading(true);
    try {
      const [detRes, chartRes] = await Promise.allSettled([
        apiClient.get(`/api/v1/faturas/${fatura.id}/detalhes`),
        fatura.UC
          ? apiClient.get('/api/v1/faturas/uc-consumo-chart', {
              params: { uc: fatura.UC, mes_ref: fatura.mes_ref ?? '' },
            })
          : Promise.resolve(null),
      ]);

      if (detRes.status === 'fulfilled') setAnaliseData(detRes.value.data);

      if (chartRes.status === 'fulfilled' && chartRes.value?.data?.pontos) {
        const { pontos, media } = chartRes.value.data;
        setMediaConsumo(media ?? 0);
        setConsumoData(
          pontos.map(p => ({
            mes: p.mes,
            consumo: p.kwh_total ?? 0,
            tipo: p.tipo,
            anomalia: p.anomalia,
            link: p.link,
          }))
        );
      }
    } catch (error) {
      console.error('Erro ao carregar detalhes:', error);
    } finally {
      setLoading(false);
    }
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
                <div className="font-semibold text-[var(--success)]">R$ {parseFloat(fatura.valor || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</div>
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
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold">Série Histórica de Consumo</h3>
                {mediaConsumo > 0 && (
                  <span className="text-xs text-[var(--warning)]">
                    média: {mediaConsumo.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} kWh
                  </span>
                )}
              </div>
              {consumoData.length > 0 ? (
                <ResponsiveContainer width="100%" height={280}>
                  <ComposedChart data={consumoData} margin={{ top: 5, right: 40, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="color-mix(in srgb, var(--fg) 8%, transparent)" />
                    <XAxis dataKey="mes" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }}
                      tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v}
                      domain={robustKwhDomain(consumoData.map((d) => d.consumo)) || undefined}
                      allowDataOverflow={robustKwhDomain(consumoData.map((d) => d.consumo)) != null} />
                    <Tooltip
                      formatter={(v, name) => [
                        `${Number(v).toLocaleString('pt-BR')} kWh`,
                        name,
                      ]}
                      contentStyle={{ backgroundColor: 'var(--card)', border: '1px solid var(--border)', borderRadius: 4 }}
                    />
                    {mediaConsumo > 0 && (
                      <ReferenceLine y={mediaConsumo} stroke="var(--warning)" strokeDasharray="4 2" strokeWidth={1.5}
                        label={{ value: 'média', fill: 'var(--warning)', fontSize: 10, position: 'insideRight' }} />
                    )}
                    <Bar dataKey="consumo" name="Consumo (kWh)" radius={[3,3,0,0]}>
                      {consumoData.map((d, i) => {
                        let fill = d.tipo === 'auditado' ? 'var(--accent-2)' : 'var(--accent)';
                        if (d.anomalia) fill = 'var(--danger)';
                        else if (mediaConsumo > 0) {
                          const dev = (d.consumo - mediaConsumo) / mediaConsumo;
                          if (dev > 1.0 || dev < -0.9) fill = 'var(--danger)';
                          else if (dev > 0.5 || dev < -0.5) fill = 'var(--warning)';
                          else if (d.tipo === 'auditado') fill = 'var(--accent-2)';
                        }
                        return <Cell key={i} fill={fill} />;
                      })}
                    </Bar>
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <div className="text-sm opacity-50 text-center py-8">
                  Sem dados de consumo disponíveis para esta UC.
                </div>
              )}
              <div className="flex gap-4 mt-2 text-[10px] opacity-60">
                <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-[var(--accent)] mr-1"/>histórico</span>
                <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-[var(--accent-2)] mr-1"/>mês auditado</span>
                <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-[var(--warning)] mr-1"/>desvio &gt;50%</span>
                <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-[var(--danger)] mr-1"/>anomalia/desvio &gt;100%</span>
              </div>
            </div>

            {/* Fichas Detectadas */}
            <div className="bg-[var(--bg-secondary)] p-4 rounded-lg border border-[var(--border)]">
              <h3 className="font-semibold mb-3">Fichas Detectadas (4.1-mini)</h3>
              <div className="space-y-2">
                {fichas4_1.length > 0 ? (
                  fichas4_1.map(ficha => (
                    <div key={ficha} className="flex items-center gap-2 p-2 bg-[var(--bg)] rounded">
                      <span className="text-[var(--success)]">✓</span>
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
                    resultado.decisao_final === 'CONFIRMADO' ? 'text-[var(--success)]' :
                    resultado.decisao_final === 'REFUTADO' ? 'text-[var(--danger)]' :
                    'text-[var(--warning)]'
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
                  <div className="font-bold text-lg text-[var(--success)]">{resultado.percentual_ressarcimento || 0}%</div>
                </div>

                <div className="bg-[var(--bg)] p-3 rounded border border-[var(--border)]">
                  <div className="text-xs opacity-60 mb-1">Valor Estimado</div>
                  <div className="font-bold text-lg text-[var(--success)]">
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
                  <div className="text-sm bg-[var(--bg)] p-3 rounded border border-[var(--border)] italic text-[var(--accent)]">
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
                    ? 'bg-[var(--border)] opacity-50 cursor-not-allowed'
                    : 'bg-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_85%,black)] text-white'
                }`}
              >
                {reprocessing ? 'Reprocessando...' : 'Reprocessar com IA'}
              </button>
              <button
                onClick={() => {}}
                className="px-4 py-2 bg-[var(--success)] hover:bg-[color-mix(in_srgb,var(--success)_85%,black)] text-white rounded font-semibold transition"
              >
                Aprovar
              </button>
              <button
                onClick={() => {}}
                className="px-4 py-2 bg-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_85%,black)] text-white rounded font-semibold transition"
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
