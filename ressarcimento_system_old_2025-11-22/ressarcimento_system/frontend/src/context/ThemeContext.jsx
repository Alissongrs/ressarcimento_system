import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

const ThemeContext = createContext({ theme: 'flowtory-dark', setTheme: () => {} });

// Supported themes: dark, light standard, and light palettes A/B/C/D
const THEMES = [
  'flowtory-dark',
  'dark-a',
  'dark',
  'light',
  'light-2',
  'light-3',
  'light-4',
  'pink',
];

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState('flowtory-dark');

  useEffect(() => {
    const saved = localStorage.getItem('theme') || 'flowtory-dark';
    setThemeState(THEMES.includes(saved) ? saved : 'flowtory-dark');
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const setTheme = (t) => setThemeState(THEMES.includes(t) ? t : 'flowtory-dark');
  const value = useMemo(() => ({ theme, setTheme }), [theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}



