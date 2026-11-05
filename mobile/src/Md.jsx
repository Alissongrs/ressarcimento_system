// Markdown simples das respostas do SURE (negrito, itálico, código, listas, títulos, tabelas,
// links). Tudo vira elemento React — nenhum HTML do servidor é injetado na página.
import React from 'react';

function inline(txt, key = 'i') {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|_[^_\s][^_]*_|\[[^\]]+\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)|https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m;
  let n = 0;
  while ((m = re.exec(txt))) {
    if (m.index > last) out.push(txt.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${n++}`;
    if (t.startsWith('**')) out.push(<b key={k}>{t.slice(2, -2)}</b>);
    else if (t.startsWith('`')) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('_')) out.push(<i key={k}>{t.slice(1, -1)}</i>);
    else if (t.startsWith('[')) {
      const lm = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      out.push(<a key={k} href={lm[2]} target="_blank" rel="noreferrer">{lm[1]}</a>);
    } else out.push(<a key={k} href={t} target="_blank" rel="noreferrer">{t.length > 40 ? t.slice(0, 40) + '…' : t}</a>);
    last = m.index + t.length;
  }
  if (last < txt.length) out.push(txt.slice(last));
  return out;
}

const ehTabela = (l) => /^\s*\|.*\|\s*$/.test(l);
const celulas = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export default function Md({ text }) {
  const linhas = String(text || '').replace(/\r/g, '').split('\n');
  const blocos = [];
  let i = 0;
  while (i < linhas.length) {
    const l = linhas[i];
    if (/^```/.test(l)) {
      const ini = ++i;
      while (i < linhas.length && !/^```/.test(linhas[i])) i++;
      blocos.push(<pre key={`p${ini}`}>{linhas.slice(ini, i).join('\n')}</pre>);
      i++;
      continue;
    }
    if (ehTabela(l)) {
      const ini = i;
      const rows = [];
      while (i < linhas.length && ehTabela(linhas[i])) {
        if (!/^\s*\|?\s*:?-{2,}/.test(linhas[i])) rows.push(celulas(linhas[i]));
        i++;
      }
      const [cab, ...corpo] = rows;
      blocos.push(
        <div className="md-tab" key={`t${ini}`}>
          <table>
            <thead><tr>{(cab || []).map((c, j) => <th key={j}>{inline(c, `h${ini}${j}`)}</th>)}</tr></thead>
            <tbody>{corpo.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, `c${ini}${ri}${j}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) {
      const ini = i;
      const itens = [];
      const ord = /^\s*\d/.test(l);
      while (i < linhas.length && /^\s*([-*•]|\d+[.)])\s+/.test(linhas[i])) {
        itens.push(linhas[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
        i++;
      }
      const Tag = ord ? 'ol' : 'ul';
      blocos.push(<Tag key={`l${ini}`}>{itens.map((t, j) => <li key={j}>{inline(t, `li${ini}${j}`)}</li>)}</Tag>);
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) { blocos.push(<div key={`h${i}`} className="md-h">{inline(h[2], `hh${i}`)}</div>); i++; continue; }
    if (/^\s*>\s?/.test(l)) { blocos.push(<blockquote key={`q${i}`}>{inline(l.replace(/^\s*>\s?/, ''), `q${i}`)}</blockquote>); i++; continue; }
    if (!l.trim()) { i++; continue; }
    const ini = i;
    const par = [];
    while (i < linhas.length && linhas[i].trim() && !ehTabela(linhas[i]) && !/^```|^#{1,4}\s|^\s*([-*•]|\d+[.)])\s+|^\s*>/.test(linhas[i])) {
      par.push(linhas[i]);
      i++;
    }
    blocos.push(<p key={`p${ini}`}>{par.map((t, j) => <React.Fragment key={j}>{j > 0 && <br />}{inline(t, `pp${ini}${j}`)}</React.Fragment>)}</p>);
  }
  return <div className="md">{blocos}</div>;
}
