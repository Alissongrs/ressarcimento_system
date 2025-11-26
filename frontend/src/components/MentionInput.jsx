import { useEffect, useState } from 'react';
import api from '../services/api';

export default function MentionInput({ value, onChange, onSave, onMencoesChange, rows = 2, textareaStyle = {}, textareaClassName = '', onPaste, inputRef }) {
  const [query, setQuery] = useState('');
  const [sugestoes, setSugestoes] = useState([]);
  const [Mencoes, setMencoes] = useState([]); // [{id, nome}]

  useEffect(() => {
    if (!query) { setSugestoes([]); return; }
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get('/usuarios/mencoes', { params: { q: query } });
        setSugestoes(Array.isArray(data) ? data : []);
      } catch {
        setSugestoes([]);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  const onKeyUp = (e) => {
    const val = e.target.value;
    onChange?.(val);
    const m = val.match(/@([a-zA-Z\u00C0-\u024F0-9_.-]{1,})$/);
    setQuery(m ? m[1] : '');
  };

  const adicionar = (u) => {
    if (!Mencoes.find(x => x.id === u.id)) {
      const next = [...Mencoes, u];
      setMencoes(next);
      onMencoesChange?.(next.map(m => m.id));
    }
    setSugestoes([]);
    setQuery('');
  };

  const salvar = () => {
    const ids = Mencoes.map(m => m.id);
    onSave?.({ comentario: value, Mencoes: ids });
    setMencoes([]);
    onMencoesChange?.([]);
  };

  return (
    <div style={{ position: 'relative' }}>
      <textarea
        rows={rows}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        onKeyUp={onKeyUp}
        onPaste={onPaste}
        placeholder="Digite seu comentário. Use @ para mencionar usuários"
        className={textareaClassName}
        style={{ width: '100%', background: '#1f2937', color: '#fff', border: '1px solid #374151', borderRadius: 6, padding: 8, ...textareaStyle }}
        ref={inputRef}
      />
      {sugestoes.length > 0 && (
        <div style={{ position: 'absolute', left: 0, right: 0, top: '100%', background: '#1f2937', color: '#e5e7eb', border: '1px solid #374151', borderRadius: 6, zIndex: 1000 }}>
          {sugestoes.map(u => (
            <div key={u.id} style={{ padding: 8, cursor: 'pointer' }} onClick={() => adicionar(u)}>
              @{u.nome} <small style={{ color: '#9ca3af' }}>({u.email})</small>
            </div>
          ))}
        </div>
      )}
      {Mencoes.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {Mencoes.map(m => <span key={m.id} style={{ background: '#eee', padding: '2px 6px', borderRadius: 4 }}>@{m.nome}</span>)}
          </div>
          <button onClick={salvar} style={{ fontSize: 12 }}>OK</button>
        </div>
      )}
    </div>
  );
}



