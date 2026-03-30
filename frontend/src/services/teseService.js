import api from './api';

export const getTese = (processoId) =>
  api.get(`/processos/${processoId}/tese`).then((r) => r.data);

export const gerarTese = (processoId) =>
  api.post(`/processos/${processoId}/tese/gerar`).then((r) => r.data);

export const salvarTese = (processoId, conteudo) =>
  api.post(`/processos/${processoId}/tese/salvar`, { conteudo }).then((r) => r.data);

export const downloadTesePDF = async (processoId) => {
  const res = await api.get(`/processos/${processoId}/tese/pdf`, {
    responseType: 'blob',
  });
  const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `tese-processo-${processoId}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
};

export const getTesePDFBlob = async (processoId) => {
  const res = await api.get(`/processos/${processoId}/tese/pdf`, {
    responseType: 'blob',
  });
  return res.data;
};

export const enviarEmailTese = (processoId, payload) =>
  api.post(`/processos/${processoId}/tese/enviar-email`, payload).then((r) => r.data);

export const gerarEmailTese = (processoId) =>
  api.post(`/processos/${processoId}/tese/gerar-email`).then((r) => r.data);
