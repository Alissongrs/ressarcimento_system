// src/pages/LoginPage.jsx
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { login as loginService } from '../services/authService';
import { Button } from '../components/ui/button.jsx';
import { Input } from '../components/ui/input.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.jsx';
import { Label } from '../components/ui/label.jsx';
import { Eye, EyeOff } from 'lucide-react';

const Login = () => {
  const [formData, setFormData] = useState({ email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const { login } = useAuth();
  const navigate = useNavigate();

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    try {
      const { token } = await loginService(formData.email, formData.password);
      login(token);
      navigate('/');
    } catch (err) {
      console.error('Erro detalhado no login:', err);
      setError(err?.response?.data?.error || 'Falha no login. Verifique seu e-mail e senha.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-4">
      <Card className="w-full max-w-md gradient-card shadow-medium backdrop-blur-sm border border-[var(--border)] text-[var(--fg)]">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold text-[var(--fg)]">
            Sistema Unificado de Ressarcimento
          </CardTitle>
          <CardDescription className="text-[var(--fg)] opacity-70">
            Faça login para acessar o sistema
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <p className="text-sm text-danger text-center bg-[color:var(--danger)]/15 p-2 rounded mb-4">{error}</p>
          )}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-[var(--fg)]">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="seu.email@empresa.com"
                value={formData.email}
                onChange={handleChange}
                required
                className="glass-card border-[var(--border)] text-[var(--fg)]"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-[var(--fg)]">Senha</Label>
              <div className="relative">
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Digite sua senha"
                  value={formData.password}
                  onChange={handleChange}
                  required
                  className="glass-card border-[var(--border)] text-[var(--fg)]"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3 py-2 text-[var(--fg)] opacity-70 hover:opacity-100 hover:bg-transparent"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <Button type="submit" className="w-full bg-[var(--accent)] hover:opacity-90 text-white" disabled={isLoading}>
              {isLoading ? 'Entrando...' : 'Entrar'}
            </Button>
          </form>

          <div className="mt-6 text-center">
            <p className="text-sm text-[var(--fg)] opacity-70">
              Não tem uma conta?{' '}
              <button
                type="button"
                onClick={() => navigate('/register')}
                className="text-[var(--accent)] hover:underline font-medium"
              >
                Cadastre-se aqui
              </button>
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default Login;
