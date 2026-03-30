import React, { createContext, useCallback, useContext, useState } from 'react';

const EmailComposeContext = createContext(null);

export function EmailComposeProvider({ children }) {
  // null = fechado | { minimized, subject, body, to, cc } = aberto
  const [state, setState] = useState(null);

  const openCompose = useCallback((data = {}) => {
    setState({ minimized: false, to: '', cc: '', subject: '', body: '', ...data });
  }, []);

  const closeCompose  = useCallback(() => setState(null), []);
  const minimize      = useCallback(() => setState(prev => prev ? { ...prev, minimized: true  } : prev), []);
  const restore       = useCallback(() => setState(prev => prev ? { ...prev, minimized: false } : prev), []);
  const updateBody    = useCallback((body) => setState(prev => prev ? { ...prev, body } : prev), []);
  const updateField   = useCallback((k, v) => setState(prev => prev ? { ...prev, [k]: v } : prev), []);

  return (
    <EmailComposeContext.Provider value={{ state, openCompose, closeCompose, minimize, restore, updateBody, updateField }}>
      {children}
    </EmailComposeContext.Provider>
  );
}

export const useEmailCompose = () => useContext(EmailComposeContext);
