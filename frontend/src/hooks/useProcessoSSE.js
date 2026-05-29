import { useEffect } from 'react';
import { subscribeProcesso } from '../services/sseClient';

export function useProcessoSSE(processoId, _token, onUpdate) {
  useEffect(() => {
    if (!processoId) return;
    const unsubscribe = subscribeProcesso(processoId, null, onUpdate);
    return unsubscribe;
  }, [processoId, onUpdate]);
}

