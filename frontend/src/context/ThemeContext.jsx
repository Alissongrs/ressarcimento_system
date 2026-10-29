import React, { createContext, useContext, useEffect, useMemo } from 'react';

const ThemeContext = createContext({ theme: 'sap', setTheme: () => {} });

// Padrão único do sistema: SAP. Seletor de tema removido — não há mais escolha do
// usuário, sempre carrega nesse tema (mesmo que o navegador tenha um 'theme' antigo
// salvo em localStorage de antes dessa decisão).
const THEME = 'sap';

export function ThemeProvider({ children }) {
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', THEME);
    localStorage.setItem('theme', THEME);
  }, []);

  const value = useMemo(() => ({ theme: THEME, setTheme: () => {} }), []);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}

