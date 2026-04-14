import api from './apiClient.js';

export const askRag = async ({ question, history, attachments, signal }) => {
  const payload = { question, history, top_k: 5, attachments };
  const resp = await api.post('/chat/rag', payload, { signal });
  return resp.data;
};

export const uploadChatFiles = async (files) => {
  const form = new FormData();
  files.forEach((file) => form.append('files', file));
  const resp = await api.post('/chat/upload', form);
  return resp.data;
};

export const learnChatFiles = async ({ message, files }) => {
  const form = new FormData();
  form.append('message', message || '');
  (files || []).forEach((file) => form.append('files', file));
  const resp = await api.post('/chat/learn', form);
  return resp.data;
};

export const sendChatFeedback = async ({ question, answer, rating, comment, sources, model }) => {
  const payload = {
    question,
    answer,
    rating,
    comment,
    sources,
    model,
    prompt_version: 'v1',
  };
  const resp = await api.post('/chat/feedback', payload);
  return resp.data;
};

export const listChatSessions = async () => {
  const resp = await api.get('/chat/sessions');
  return resp.data;
};

export const createChatSession = async ({ title }) => {
  const resp = await api.post('/chat/sessions', { title });
  return resp.data;
};

export const deleteChatSession = async (id) => {
  const resp = await api.delete(`/chat/sessions/${id}`);
  return resp.data;
};

export const listChatMessages = async (id) => {
  const resp = await api.get(`/chat/sessions/${id}/messages`);
  return resp.data;
};

export const addChatMessage = async ({ id, role, content }) => {
  const resp = await api.post(`/chat/sessions/${id}/messages`, { role, content });
  return resp.data;
};

// Chat global de processos (acesso ao banco de dados em tempo real)
export const askProcessosChat = async ({ question, history, signal }) => {
  const resp = await api.post(
    '/chat/processos',
    { question, history: history || [] },
    { signal, timeout: 60000 },
  );
  return resp.data;
};
