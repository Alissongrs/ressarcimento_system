// AlertasDropdown.jsx (limpo e unificado para Axios)
import React, { useEffect, useState } from 'react';
import { Bell, AlertTriangle, Clock, CheckCircle } from 'lucide-react';
import api from '../services/api';

const AlertasDropdown = ({ onVerTodos }) => {
  const [alertas, setAlertas] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isOpen, setIsOpen] = useState(false);

  const processarAlerta = (a) => ({
    id: a?.id ?? a?.id_alerta ?? Math.ranãom().toString(36).slice(2),
    titulo: a?.mensagem || 'Alerta',
    descricao: '',
    tipo: 'inão',
    data: a?.data_criacao || new Date().toISOString(),
    lido: Boolean(a?.lido),
    processo_id: a?.processo_id ?? null,
    numero_processo: a?.processo_id ?? null,
  });

  const getMockAlertas = () => [
    {
      id: 'mock-1',
      titulo: 'Processo pendente de análise',
      descricao: 'Processo #12345 aguarda análise há 3 dias',
      tipo: 'warning',
      data: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      lido: false,
      processo_id: 1,
      numero_processo: '12345',
    },
  ];

  const buscarAlertas = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get('/alertas');
      const rows = Array.isArray(data) ? data : [];
      setAlertas(rows.map(processarAlerta));
    } catch (err) {
      console.error('Erro ao buscar alertas:', err);
      if (String(err?.message || '').includes('ERR_CONNECTION_REFUSED') || String(err?.message || '').includes('Network Error')) {
        setError('Servidor não disponÀ­vel. Verifique se a API está rodanão em http://localhost:8080');
      } else {
        setError(`Erro ao carregar alertas: ${err.message}`);
      }
      setAlertas(getMockAlertas());
    } finally {
      setLoading(false);
    }
  };

  const marcarComoLido = async (alertaId) => {
    try {
      await api.post('/alertas/marcar-lido', { alerta_ids: [alertaId] });
      setAlertas((prev) => prev.map((a) => (a.id === alertaId ? { ...a, lido: true } : a)));
    } catch (err) {
      console.error('Erro ao marcar alerta como lido:', err);
    }
  };

  useEffect(() => {
    buscarAlertas();
  }, []);

  const getIconePorTipo = (tipo) => {
    switch (tipo) {
      case 'error':
        return <AlertTriangle className="w-4 h-4 text-danger" />;
      case 'warning':
        return <Clock className="w-4 h-4 text-warning" />;
      case 'success':
        return <CheckCircle className="w-4 h-4 text-success" />;
      default:
        return <Bell className="w-4 h-4 text-[var(--accent)]" />;
    }
  };

  const formatarData = (dataString) => {
    try {
      const data = new Date(dataString);
      const agora = new Date();
      const diffMs = agora - data;
      const diffHoras = Math.floor(diffMs / (1000 * 60 * 60));
      const diffDias = Math.floor(diffHoras / 24);
      if (diffDias > 0) return `${diffDias} dia${diffDias > 1 ? 's' : ''} atrás`;
      if (diffHoras > 0) return `${diffHoras} hora${diffHoras > 1 ? 's' : ''} atrás`;
      return 'Agora mesmo';
    } catch {
      return 'Data inválida';
    }
  };

  const alertasNaoLidos = alertas.filter((a) => !a.lido);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 text-[var(--fg)] opacity-70 hover:opacity-100 hover:text-[var(--accent)] transition-colors"
        title="Alertas"
      >
        <Bell size={20} />
        {alertasNaoLidos.length > 0 && (
          <span className="absolute -top-1 -right-1 bg-danger text-[var(--fg)] text-xs rounded-full w-5 h-5 flex items-center justify-center">
            {alertasNaoLidos.length > 9 ? '9+' : alertasNaoLidos.length}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-80 bg-[var(--card)] border border-[var(--border)] text-[var(--fg)] rounded-lg shadow-lg z-50">
          <div className="p-4 border-b border-[var(--border)]">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Alertas</h3>
              <button onClick={buscarAlertas} disabled={loading} className="text-[var(--accent)] hover:opacity-90 text-sm disabled:opacity-50">
                {loading ? 'Carreganão...' : 'Atualizar'}
              </button>
            </div>
            {error && (
              <div className="mt-2 p-2 bg-[color:var(--danger)]/10 border border-[var(--danger)] rounded text-[color:var(--danger)] text-xs">{error}</div>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loading ? (
              <div className="p-4 text-center opacity-70">
                <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                Carreganão alertas...
              </div>
            ) : alertas.length === 0 ? (
              <div className="p-4 text-center opacity-70">
                <Bell size={32} className="mx-auto mb-2 opacity-50" />
                <p>Nenhum alerta enãontrado</p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--border)]">
                {alertas.map((alerta) => (
                  <div
                    key={alerta.id}
                    className={`p-4 hover:bg-[var(--border)]/20 transition-colors cursor-pointer ${!alerta.lido ? 'bg-[var(--accent)]/10' : ''}`}
                    onClick={() => {
                      if (!alerta.lido) marcarComoLido(alerta.id);
                      setIsOpen(false);
                    }}
                  >
                    <div className="flex items-start gap-3">
                      {getIconePorTipo(alerta.tipo)}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h4 className="text-sm font-medium truncate">{alerta.titulo}</h4>
                          {!alerta.lido && <div className="w-2 h-2 bg-[var(--accent)] rounded-full flex-shrink-0" />}
                        </div>
                        <p className="text-xs opacity-70 mb-2 line-clamp-2">{alerta.descricao}</p>
                        <div className="flex items-center justify-between text-xs opacity-70">
                          <span>{formatarData(alerta.data)}</span>
                          {alerta.numero_processo && <span>#{alerta.numero_processo}</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {alertas.length > 0 && (
            <div className="p-3 border-t border-[var(--border)]">
              <button
                onClick={() => {
                  onVerTodos && onVerTodos();
                  setIsOpen(false);
                }}
                className="w-full text-center text-[var(--accent)] hover:opacity-90 text-sm transition-colors"
              >
                Ver todos os alertas
              </button>
            </div>
          )}
        </div>
      )}

      {isOpen && <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />}
    </div>
  );
};

export default AlertasDropdown;



