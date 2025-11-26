// services/etapasService.js - Serviço para gerenciar etapas e sub-etapas dinamicamente
// Baseado na estrutura: DM_ETAPAS_PROCESSO, DM_SUBETAPA_PROCESSOS, DM_ETAPA_SUBETAPAS_VALIDAS

import { useState, useEffect, useCallback } from 'react';

const API_BASE_URL = '/api/v1';

// Função auxiliar para fazer requisições seguras
const fetchSeguro = async (url, options = {}) => {
  try {
    const token = localStorage.getItem('userToken');

    if (!token) {
      throw new Error('Token de autenticação não encontrado');
    }

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      // Timeout de 10 segundos (se disponível no ambiente)
      signal:
        options.signal ||
        (typeof AbortSignal !== 'undefined' &&
          AbortSignal.timeout
          ? AbortSignal.timeout(10000)
          : undefined),
    });

    if (!response.ok) {
      throw new Error(
        `Erro HTTP: ${response.status} - ${response.statusText}`
      );
    }

    return await response.json();
  } catch (error) {
    console.error('Erro na requisição:', error);
    throw error;
  }
};

/**
 * Busca todas as etapas disponíveis
 * @returns {Promise<Array>} Lista de etapas
 */
export const buscarEtapas = async () => {
  try {
    // Usa endpoints existentes no backend: /filtros/etapas (lista simples de nomes)
    const nomes = await fetchSeguro(`${API_BASE_URL}/filtros/etapas`);
    const arr = Array.isArray(nomes) ? nomes : [];
    // id sintético = nome (facilita chamadas seguintes que esperam 'id')
    return arr.map((nome) => ({ id: String(nome), nome: String(nome), descricao: '', id_coluna_kanban: null }));
  } catch (error) {
    console.error('Erro ao buscar etapas:', error);

    // Retornar dados mock em caso de erro (para desenvolvimento)
    return getMockEtapas();
  }
};

/**
 * Busca sub-etapas válidas para uma etapa específica
 * @param {number} idEtapa - ID da etapa
 * @returns {Promise<Array>} Lista de sub-etapas válidas
 */
export const buscarSubEtapasPorEtapa = async (idOuNomeEtapa) => {
  if (!idOuNomeEtapa) return [];

  try {
    // Nosso backend expõe combinações válidas em /filtros/etapas-subetapas no formato { map: { Etapa: [Sub...] } }
    const data = await fetchSeguro(`${API_BASE_URL}/filtros/etapas-subetapas`);
    const mapa = (data && data.map) || {};
    // Se o parâmetro for string, tratamos como nome; caso contrário, tentamos achar por nome via buscarEtapas()
    let nomeEtapa = typeof idOuNomeEtapa === 'string' ? idOuNomeEtapa : '';
    if (!nomeEtapa) {
      try {
        const todas = await buscarEtapas();
        const hit = todas.find((e) => String(e.id) === String(idOuNomeEtapa));
        nomeEtapa = hit ? hit.nome : '';
      } catch {}
    }
    const subs = Array.isArray(mapa[nomeEtapa]) ? mapa[nomeEtapa] : [];
    if (subs.length) return subs.map((s, i) => ({ id: i + 1, nome: String(s) }));

    // Fallback para dados mock
    return getMockSubEtapas(nomeEtapa || idOuNomeEtapa);
  } catch (error) {
    console.error('Erro ao buscar sub-etapas:', error);
    return getMockSubEtapas(idOuNomeEtapa);
  }
};

/**
 * Busca etapa por nome
 * @param {string} nomeEtapa - Nome da etapa
 * @returns {Promise<Object|null>} Dados da etapa ou null
 */
export const buscarEtapaPorNome = async (nomeEtapa) => {
  if (!nomeEtapa) return null;

  try {
    const etapas = await buscarEtapas();
    const alvo = String(nomeEtapa).toLowerCase().trim();

    const e = etapas.find((etapa) => String(etapa.nome).toLowerCase().trim() === alvo) || null;
    // Garante id sintético = nome
    return e ? { ...e, id: String(e.nome) } : null;
  } catch (error) {
    console.error('Erro ao buscar etapa por nome:', error);
    return null;
  }
};

/**
 * Busca todas as combinações válidas de etapa-subetapa
 * @returns {Promise<Array>} Lista de combinações válidas
 */
export const buscarCombinacoesValidas = async () => {
  try {
    const combinacoes = await fetchSeguro(
      `${API_BASE_URL}/etapas/combinacoes-validas`
    );

    return (combinacoes || []).map((comb) => ({
      id_etapa: comb.id_etapa_processo,
      id_subetapa: comb.id_subetapa,
      nome_etapa: comb.nome_etapa || '',
      nome_subetapa: comb.nome_subetapa || '',
    }));
  } catch (error) {
    console.error(
      'Erro ao buscar combinações válidas:',
      error
    );
    return getMockCombinacoes();
  }
};

// ===== DADOS MOCK PARA DESENVOLVIMENTO =====

const getMockEtapas = () => [
  // Coluna "Ativos" (ID: 1)
  {
    id: 2,
    nome: 'Distribuidora',
    descricao:
      'Processo em tratativa com a Distribuidora.',
    id_coluna_kanban: 1,
  },
  {
    id: 3,
    nome: 'Ouvidoria',
    descricao:
      'Processo escalado para a Ouvidoria.',
    id_coluna_kanban: 1,
  },
  {
    id: 4,
    nome: 'ANEEL',
    descricao:
      'Processo escalado para a ANEEL.',
    id_coluna_kanban: 1,
  },
  {
    id: 5,
    nome: 'SMA',
    descricao:
      'Processo em análise no SMA.',
    id_coluna_kanban: 1,
  },

  // Coluna "Deferidos" (exemplo)
  {
    id: 6,
    nome: 'Pendente',
    descricao:
      'Deferido, aguardando início da conciliação.',
    id_coluna_kanban: 2,
  },
  {
    id: 7,
    nome: 'Em Conciliação',
    descricao:
      'Valores do deferimento sendo conciliados.',
    id_coluna_kanban: 2,
  },
  {
    id: 8,
    nome: 'Em Contestação',
    descricao:
      'Valores do deferimento em contestação.',
    id_coluna_kanban: 2,
  },
];

const getMockSubEtapas = (idEtapa) => {
  const subEtapasPorEtapa = {
    // Etapas da coluna "Ativos" (2, 3, 4, 5)
    2: [
      { id: 1, nome: 'Em elaboração' },
      { id: 2, nome: 'Aguardando retorno' },
      { id: 3, nome: 'Em contestação' },
    ],
    3: [
      { id: 1, nome: 'Em elaboração' },
      { id: 2, nome: 'Aguardando retorno' },
      { id: 3, nome: 'Em contestação' },
    ],
    4: [
      { id: 1, nome: 'Em elaboração' },
      { id: 2, nome: 'Aguardando retorno' },
      { id: 3, nome: 'Em contestação' },
    ],
    5: [
      { id: 1, nome: 'Em elaboração' },
      { id: 2, nome: 'Aguardando retorno' },
      { id: 3, nome: 'Em contestação' },
    ],

    // Etapas da coluna "Deferidos" (6, 7, 8)
    6: [
      { id: 2, nome: 'Aguardando retorno' },
      { id: 4, nome: 'Em análise' },
    ], // Pendente
    7: [
      { id: 2, nome: 'Aguardando retorno' },
      { id: 4, nome: 'Em análise' },
    ], // Em Conciliação
    8: [
      { id: 2, nome: 'Aguardando retorno' },
      { id: 4, nome: 'Em análise' },
    ], // Em Contestação
  };

  return subEtapasPorEtapa[idEtapa] || [];
};

const getMockCombinacoes = () => [
  // Combinações para coluna "Ativos"
  {
    id_etapa: 2,
    id_subetapa: 1,
    nome_etapa: 'Distribuidora',
    nome_subetapa: 'Em elaboração',
  },
  {
    id_etapa: 2,
    id_subetapa: 2,
    nome_etapa: 'Distribuidora',
    nome_subetapa: 'Aguardando retorno',
  },
  {
    id_etapa: 2,
    id_subetapa: 3,
    nome_etapa: 'Distribuidora',
    nome_subetapa: 'Em contestação',
  },

  {
    id_etapa: 3,
    id_subetapa: 1,
    nome_etapa: 'Ouvidoria',
    nome_subetapa: 'Em elaboração',
  },
  {
    id_etapa: 3,
    id_subetapa: 2,
    nome_etapa: 'Ouvidoria',
    nome_subetapa: 'Aguardando retorno',
  },
  {
    id_etapa: 3,
    id_subetapa: 3,
    nome_etapa: 'Ouvidoria',
    nome_subetapa: 'Em contestação',
  },

  {
    id_etapa: 4,
    id_subetapa: 1,
    nome_etapa: 'ANEEL',
    nome_subetapa: 'Em elaboração',
  },
  {
    id_etapa: 4,
    id_subetapa: 2,
    nome_etapa: 'ANEEL',
    nome_subetapa: 'Aguardando retorno',
  },
  {
    id_etapa: 4,
    id_subetapa: 3,
    nome_etapa: 'ANEEL',
    nome_subetapa: 'Em contestação',
  },

  {
    id_etapa: 5,
    id_subetapa: 1,
    nome_etapa: 'SMA',
    nome_subetapa: 'Em elaboração',
  },
  {
    id_etapa: 5,
    id_subetapa: 2,
    nome_etapa: 'SMA',
    nome_subetapa: 'Aguardando retorno',
  },
  {
    id_etapa: 5,
    id_subetapa: 3,
    nome_etapa: 'SMA',
    nome_subetapa: 'Em contestação',
  },

  // Combinações para coluna "Deferidos"
  {
    id_etapa: 6,
    id_subetapa: 2,
    nome_etapa: 'Pendente',
    nome_subetapa: 'Aguardando retorno',
  },
  {
    id_etapa: 6,
    id_subetapa: 4,
    nome_etapa: 'Pendente',
    nome_subetapa: 'Em análise',
  },

  {
    id_etapa: 7,
    id_subetapa: 2,
    nome_etapa: 'Em Conciliação',
    nome_subetapa: 'Aguardando retorno',
  },
  {
    id_etapa: 7,
    id_subetapa: 4,
    nome_etapa: 'Em Conciliação',
    nome_subetapa: 'Em análise',
  },

  {
    id_etapa: 8,
    id_subetapa: 2,
    nome_etapa: 'Em Contestação',
    nome_subetapa: 'Aguardando retorno',
  },
  {
    id_etapa: 8,
    id_subetapa: 4,
    nome_etapa: 'Em Contestação',
    nome_subetapa: 'Em análise',
  },
];

// ===== HOOK PERSONALIZADO =====

/**
 * Hook para gerenciar etapas e sub-etapas
 * @returns {Object} Estado e funções para gerenciar etapas
 */
export const useEtapas = () => {
  const [etapas, setEtapas] = useState([]);
  const [subEtapas, setSubEtapas] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const carregarEtapas = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const etapasData = await buscarEtapas();
      setEtapas(etapasData);
    } catch (err) {
      setError(err.message || 'Erro ao carregar etapas');
      console.error('Erro ao carregar etapas:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const carregarSubEtapas = useCallback(
    async (nomeEtapa) => {
      if (!nomeEtapa) {
        setSubEtapas([]);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const etapa = await buscarEtapaPorNome(
          nomeEtapa
        );

        if (etapa) {
          const subEtapasData =
            await buscarSubEtapasPorEtapa(
              etapa.id
            );
          setSubEtapas(subEtapasData);
        } else {
          setSubEtapas([]);
        }
      } catch (err) {
        setError(
          err.message ||
            'Erro ao carregar sub-etapas'
        );
        console.error(
          'Erro ao carregar sub-etapas:',
          err
        );
        setSubEtapas([]);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    carregarEtapas();
  }, [carregarEtapas]);

  return {
    etapas,
    subEtapas,
    loading,
    error,
    carregarEtapas,
    carregarSubEtapas,
  };
};

// Export default agrupando utilitários
export default {
  buscarEtapas,
  buscarSubEtapasPorEtapa,
  buscarEtapaPorNome,
  buscarCombinacoesValidas,
  useEtapas,
};
