import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

const ThemeContext = createContext({ theme: 'light-4', setTheme: () => {} });

// Temas disponíveis: Padrão (Claro D), Rosa e Azul
const THEMES = ['light-4', 'pink', 'azul'];

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState('light-4');

  useEffect(() => {
    const saved = localStorage.getItem('theme') || 'light-4';
    setThemeState(THEMES.includes(saved) ? saved : 'light-4');
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const setTheme = (t) => setThemeState(THEMES.includes(t) ? t : 'light-4');
  const value = useMemo(() => ({ theme, setTheme }), [theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}


