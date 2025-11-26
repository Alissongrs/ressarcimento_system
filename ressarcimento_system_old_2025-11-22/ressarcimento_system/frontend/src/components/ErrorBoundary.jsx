import React from 'react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] Caught error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 24 }}>
          <h2 style={{ marginBottom: 8 }}>Algo deu errado.</h2>
          <p style={{ opacity: 0.8, marginBottom: 16 }}>
            Tente recarregar a página. Se o problema persistir, contate o suporte.
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', opacity: 0.7 }}>
            {String(this.state.error?.message || this.state.error || 'Erro desconhecido')}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;

