import { useEffect } from 'react';
import { subscribeProcesso } from '../services/sseClient';

export function useProcessoSSE(processoId, token, onUpdate) {
  useEffect(() => {
    if (!processoId || !token) return;
    const unsubscribe = subscribeProcesso(processoId, token, onUpdate);
    return unsubscribe;
  }, [processoId, token, onUpdate]);
}

