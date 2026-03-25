// Bypass axios para evitar qualquer prefixo incorreto: usa fetch com URL absoluta
function authHeader() {
  try {
    const t = localStorage.getItem('userToken');
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

export async function saveProcessoFull(payload) {
  const resp = await fetch('/api/v1/admin/editor/processo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json();
}

export async function getNextProcessID() {
  const resp = await fetch('/api/v1/admin/editor/next-id', { headers: authHeader() });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return data?.next_id;
}
