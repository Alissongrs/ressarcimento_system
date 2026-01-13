  import api from './apiClient';

  export async function sendResumoFeedback(payload) {
    const { data } = await api.post('/ai/resumo/feedback', payload);
    return data || { ok: true };
  }

