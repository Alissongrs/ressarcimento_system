/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Legacy tokens (compat)
        bg: 'var(--bg)',
        fg: 'var(--fg)',
        card: 'var(--card)',
        border: 'var(--border)',
        accent: 'var(--accent)',
        success: 'var(--success)',
        danger: 'var(--danger)',
        warning: 'var(--warning)',
        panel: 'var(--panel)',
        panelBorder: 'var(--panel-border)',

        // Tokens ligados ao sistema de temas (--bg/--fg seguem o data-theme ativo)
        background: 'var(--bg)',
        foreground: 'var(--fg)',
        primary: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--fg)',
          hover: 'var(--accent-2)',
        },
        secondary: {
          DEFAULT: 'var(--panel)',
          foreground: 'var(--fg)',
        },
        destructive: {
          DEFAULT: 'var(--danger)',
          foreground: '#ffffff',
        },
        muted: {
          DEFAULT: 'var(--border)',
          foreground: 'var(--fg)',
        },
        accenthsl: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--fg)',
        },
        successhsl: {
          DEFAULT: 'var(--success)',
          foreground: '#ffffff',
        },
        warninghsl: {
          DEFAULT: 'var(--warning)',
          foreground: '#ffffff',
        },
        popover: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--fg)',
        },
        cardhsl: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--fg)',
        },
        sidebar: {
          DEFAULT: 'var(--menu-bg)',
          foreground: 'var(--menu-fg)',
          primary: 'var(--accent)',
          'primary-foreground': '#ffffff',
          accent: 'var(--menu-hover)',
          'accent-foreground': 'var(--menu-fg)',
          border: 'var(--menu-border)',
          ring: 'var(--accent)',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [],
}
