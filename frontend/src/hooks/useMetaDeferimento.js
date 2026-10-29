// Hooks react-query para as metas de deferimento (repasse).
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getMetasDeferimento,
  updateMetasDeferimento,
  getMetasDeferimentoDetalhe,
} from '../services/metaDeferimentoService.js';

const KEY = ['v2', 'metas-deferimento'];

export function useMetaDeferimento() {
  return useQuery({
    queryKey: KEY,
    queryFn: getMetasDeferimento,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

// Detalhe por empresa de um período (mes=0/undefined → ano inteiro). Só busca
// quando `enabled` (ex.: o usuário clicou num mês/ano).
export function useMetaDetalhe(ano, mes, enabled) {
  return useQuery({
    queryKey: ['v2', 'metas-detalhe', ano, mes || 0],
    queryFn: () => getMetasDeferimentoDetalhe(ano, mes),
    enabled: !!enabled && !!ano,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useUpdateMetas() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: updateMetasDeferimento,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export default useMetaDeferimento;
