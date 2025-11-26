import React from 'react';

const Layout = ({ children }) => {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header
        className="border-b-2 shadow-elevated"
        style={{ background: 'var(--header-bg)', borderBottomColor: 'var(--header-border)', color: 'var(--header-fg)' }}
      >
        <div className="max-w-7xl mx-auto px-4 py-4">
          <h1 className="text-xl font-extrabold tracking-tight">Sistema Unificado de Ressarcimento</h1>
        </div>
      </header>
      <main className="max-w-7xl mx-auto p-4">
        {children}
      </main>
    </div>
  );
};

export default Layout;
