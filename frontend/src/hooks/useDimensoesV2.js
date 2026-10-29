// src/hooks/useDimensoesV2.js
// Cache infinito dos catálogos da API v2.
import { useQuery } from '@tanstack/react-query';
import { getDimensoes } from '../services/processoV2Service';

export function useDimensoesV2() {
  return useQuery({
    queryKey: ['v2', 'dimensoes'],
    queryFn: getDimensoes,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
}

export default useDimensoesV2;
