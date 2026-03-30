import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

const ThemeContext = createContext({ theme: 'light-4', setTheme: () => {} });

// Temas disponíveis: Padrão (Claro D), Rosa e Azul
const THEMES = [
  'dark-navy',
  'light-4',
  'pink',
  'azul',
  'sap',
  'navy',
  'orange-gray',
  'green-orange',
  'orange-purple-green',
];

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState('dark-navy');

  useEffect(() => {
    const saved = localStorage.getItem('theme') || 'dark-navy';
    setThemeState(THEMES.includes(saved) ? saved : 'dark-navy');
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const setTheme = (t) => setThemeState(THEMES.includes(t) ? t : 'dark-navy');
  const value = useMemo(() => ({ theme, setTheme }), [theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}

