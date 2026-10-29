// Converte uma resposta do chat (markdown) em planilha Excel e baixa no navegador.
// Tabelas markdown viram uma aba cada; listas "- Item: valor" agrupadas por seção viram a aba
// "Resumo" (Seção | Item | Valor). Valores "R$ 1.234,56", "47,3%" e "1.179" viram número.
import * as XLSX from 'xlsx';

function limpar(s) {
  return String(s || '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
}

function numeroBR(v) {
  const s = limpar(v);
  const m = s.match(/^(R\$\s*)?(-?[\d.]+(?:,\d+)?)\s*(%?)$/);
  if (!m) return s;
  const n = Number(m[2].replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return s;
  if (m[3]) return { t: 'n', v: n / 100, z: '0.0%' };
  if (m[1]) return { t: 'n', v: n, z: '"R$" #,##0.00' };
  return n;
}

function nomeAba(base, usados) {
  let n = limpar(base).replace(/[\\/?*[\]:]/g, ' ').slice(0, 28).trim() || 'Tabela';
  let k = n;
  let i = 2;
  while (usados.has(k)) k = `${n.slice(0, 25)} ${i++}`;
  usados.add(k);
  return k;
}

export function respostaTemConteudo(texto) {
  return /\|.+\|/.test(texto || '') || /^\s*[-•*]\s+.+/m.test(texto || '');
}

export function respostaParaExcel(texto, nomeArquivo = 'SURE_resposta') {
  const linhas = String(texto || '').split(/\r?\n/);
  const wb = XLSX.utils.book_new();
  const usados = new Set();
  const resumo = [['Seção', 'Item', 'Valor']];
  let secao = '';
  let titulo = '';
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i];
    // tabela markdown
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < linhas.length && /^\s*\|?\s*:?-{2,}/.test(linhas[i + 1])) {
      const cab = l.split('|').slice(1, -1).map(limpar);
      const rows = [cab];
      i += 2;
      while (i < linhas.length && /^\s*\|.*\|\s*$/.test(linhas[i])) {
        rows.push(linhas[i].split('|').slice(1, -1).map(numeroBR));
        i++;
      }
      i--;
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = cab.map((c, j) => ({ wch: Math.min(50, Math.max(10, ...rows.map((r) => String(r[j] ?? '').length))) }));
      XLSX.utils.book_append_sheet(wb, ws, nomeAba(titulo || secao || 'Tabela', usados));
      continue;
    }
    const h = l.match(/^\s*#{1,6}\s+(.+)$/) || l.match(/^\s*\*\*([^*]+?):?\*\*:?\s*$/);
    if (h) {
      secao = limpar(h[1]).replace(/:$/, '');
      titulo = secao;
      continue;
    }
    const b = l.match(/^\s*[-•*]\s+(.+)$/);
    if (b) {
      const t = limpar(b[1]);
      const kv = t.match(/^([^:]{1,80}):\s*(.+)$/);
      if (kv) resumo.push([secao, kv[1].trim(), numeroBR(kv[2])]);
      else resumo.push([secao, t, '']);
      continue;
    }
    if (limpar(l)) titulo = limpar(l).slice(0, 40);
  }
  if (resumo.length > 1) {
    const ws = XLSX.utils.aoa_to_sheet(resumo);
    ws['!cols'] = [{ wch: 28 }, { wch: 45 }, { wch: 22 }];
    XLSX.utils.book_append_sheet(wb, ws, nomeAba('Resumo', usados));
    // move "Resumo" para a 1ª aba
    wb.SheetNames.unshift(wb.SheetNames.pop());
  }
  if (!wb.SheetNames.length) {
    const ws = XLSX.utils.aoa_to_sheet(linhas.filter((x) => limpar(x)).map((x) => [limpar(x)]));
    ws['!cols'] = [{ wch: 120 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Resposta');
  }
  const d = new Date();
  const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  XLSX.writeFile(wb, `${nomeArquivo}_${ts}.xlsx`);
  return wb.SheetNames;
}
