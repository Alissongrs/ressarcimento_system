// Dossiê do apontamento de energia (PDF): como o apontamento foi feito, o que foi pego, histórico, leituras,
// itens e as páginas da própria fatura com os valores marcados. Backend: GET /api/v1/dossie/:base/:id.
import apiClient from '../services/apiClient';

// base: 'energia' | 'acer' | 'usinas'. Abre a aba antes do download (o navegador não bloqueia) e devolve
// a mensagem de erro, se houver.
export async function abrirDossie(base, id) {
  const aba = window.open('', '_blank');
  if (aba) aba.document.write('<p style="font-family:sans-serif;padding:24px">Montando o dossiê… (baixa a fatura e marca os valores — leva alguns segundos)</p>');
  try {
    const { data } = await apiClient.get(`/api/v1/dossie/${base}/${encodeURIComponent(id)}`, { responseType: 'blob', timeout: 180000 });
    const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
    if (aba) aba.location.href = url; else window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
    return '';
  } catch (e) {
    let msg = 'Falha ao gerar o dossiê.';
    try {
      const t = await e?.response?.data?.text?.();
      if (t) msg = JSON.parse(t).error || msg;
    } catch { /* resposta não-JSON */ }
    if (aba) aba.close();
    return msg;
  }
}
