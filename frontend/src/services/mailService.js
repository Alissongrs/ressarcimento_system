import api from './api';

const enc = (v) => encodeURIComponent(String(v || ''));

export const getMailFolders = async () => {
  const { data } = await api.get('/mail/folders');
  return data?.folders || [];
};

export const getMailMessages = async ({ folderId, q, unread, limit, offset }) => {
  const params = {};
  if (folderId) params.folderId = folderId;
  if (q) params.q = q;
  if (unread !== undefined && unread !== null) params.unread = unread;
  if (limit) params.limit = limit;
  if (offset !== undefined && offset !== null) params.offset = offset;
  const { data } = await api.get('/mail/messages', { params });
  return data?.messages || [];
};

export const getMailMessage = async (id) => (await api.get(`/mail/messages/${enc(id)}`)).data;

export const getMailMessageMime = async (id) =>
  api.get(`/mail/messages/${enc(id)}/mime`, { responseType: 'blob' });

export const getMailAttachments = async (id) => (await api.get(`/mail/messages/${enc(id)}/attachments`)).data;

export const downloadMailAttachment = async (id, attId) =>
  api.get(`/mail/messages/${enc(id)}/attachments/${enc(attId)}/download`, { responseType: 'blob' });

export const moveMailMessage = (id, folderId) =>
  api.post(`/mail/messages/${enc(id)}/move`, { folderId });

export const setMailRead = (id, isRead) =>
  api.post(`/mail/messages/${enc(id)}/read`, { isRead });

export const setMailReadLocal = (id) =>
  api.post(`/mail/messages/${enc(id)}/read-local`, {});

export const setMailUnreadLocal = (id) =>
  api.post(`/mail/messages/${enc(id)}/unread-local`, {});

export const analyzeMailMessage = async (id) =>
  (await api.post(`/mail/messages/${enc(id)}/analisar-ia`, {})).data;

export const replyMailMessage = (id, comment) =>
  api.post(`/mail/messages/${enc(id)}/reply`, { comment });

export const replyAllMailMessage = (id, comment) =>
  api.post(`/mail/messages/${enc(id)}/reply-all`, { comment });

export const forwardMailMessage = (id, to, comment) =>
  api.post(`/mail/messages/${enc(id)}/forward`, { to, comment });

export const sendMailMessage = (formData) =>
  api.post('/mail/send', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });

export const linkMailToProcess = (id, payload) =>
  api.post(`/mail/messages/${enc(id)}/link-process`, payload);

export const searchMailProcesses = async (q) =>
  (await api.get('/mail/processes/search', { params: { q } })).data?.results || [];
