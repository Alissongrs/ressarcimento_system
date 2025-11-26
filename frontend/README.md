# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

## Theming (Light, Dark, Thopen)

- Themes are managed via `data-theme` on `<html>` using CSS variables defined in `src/theme.css`.
- `ThemeProvider` in `src/context/ThemeContext.jsx` persists the selected theme to `localStorage` and applies it.
- Initial theme is hydrated in `index.html` before React loads to avoid flashes.
- Tailwind is extended to read CSS vars: use `bg-bg`, `text-fg`, `bg-card`, `border-border`, and `text-[var(--accent)]` as needed.
- A floating `ThemeSwitcher` lives in `src/components/ThemeSwitcher.jsx`.

Add tokens to components by replacing hard-coded colors with tokenized utilities, e.g. `bg-[var(--card)]` or `text-[var(--accent)]`.
