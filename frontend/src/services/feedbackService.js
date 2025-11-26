import api from './apiClient';

export async function sendFeedback(message) {
  const { data } = await api.post('/feedback', { mensagem: message });
  return data;
}

export async function listFeedbacks() {
  const { data } = await api.get('/admin/feedbacks');
  return Array.isArray(data) ? data : [];
}
