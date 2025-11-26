// src/pages/Register.jsx
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

// UI (shadcn)
import { Button } from '../components/ui/button.jsx';
import { Input } from '../components/ui/input.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.jsx';
import { Label } from '../components/ui/label.jsx';
import { Eye, EyeOff, ArrowLeft } from 'lucide-react';

// Services (use o service onde já existe getDepartamentos)
import { register as registerUser, getDepartamentos } from '../services/requisicaoService';

const Register = ({ onSwitchToLogin }) => {
  const navigate = useNavigate();

  const [form, setForm] = useState({
    name: '',
    emailLocal: '',
    password: '',
    confirmPassword: '',
  });

  const EMAIL_DOMAINS = [
    'thopenergy.com.br',
    'amee.com.br',
    'acessoenergia.com.br',
  ];
  const [emailDomain, setEmailDomain] = useState(EMAIL_DOMAINS[0]);

  const [departamentoId, setDepartamentoId] = useState('');
  const [departamentos, setDepartamentos] = useState([]);

  const [showPwd, setShowPwd] = useState(false);
  const [showPwd2, setShowPwd2] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const [errors, setErrors] = useState({
    api: '',
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    departamento: '',
  });

  // Normaliza lista do backend para {id, nome}
  const normalizeDeps = (arr) => {
    if (!Array.isArray(arr)) return [];
    return arr.map((d, idx) => {
      const id =
        d.id_departamento ??
        d.id_departamenão ?? // caso tenha vindo com mojibake anterior
        d.id ??
        d.value ??
        idx + 1;
      const nome =
        d.nome ??
        d.name ??
        d.descricao ??
        d.description ??
        `Departamento ${id}`;
      return { id: String(id), nome: String(nome) };
    });
  };

  useEffect(() => {
    (async () => {
      try {
        const data = await getDepartamentos();
        setDepartamentos(normalizeDeps(data));
      } catch (e) {
        setErrors((prev) => ({
          ...prev,
          api: 'Não foi possível carregar os departamentos.',
        }));
      }
    })();
  }, []);

  const onChange = (e) => {
    const { name, value } = e.target;
    setForm((s) => ({ ...s, [name]: value }));
    if (errors[name]) setErrors((s) => ({ ...s, [name]: '' }));
    if ((name === 'emailLocal') && errors.api) setErrors((s) => ({ ...s, api: '' }));
  };

  const validate = () => {
    const next = {};
    if (!form.name.trim()) next.name = 'Nome é obrigatório.';
    if (!form.emailLocal.trim()) next.email = 'Email é obrigatório.';
    if (!form.password) next.password = 'Senha é obrigatória.';
    else if (form.password.length < 6)
      next.password = 'Senha deve ter pelo menos 6 caracteres.';
    if (form.password !== form.confirmPassword)
      next.confirmPassword = 'Senhas não coincidem.';
    if (!departamentoId) next.departamento = 'Departamento é obrigatório.';
    setErrors((s) => ({ ...s, ...next }));
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrors((s) => ({ ...s, api: '' }));
    if (!validate()) return;

    setIsLoading(true);
    try {
      const fullEmail = `${form.emailLocal.trim().toLowerCase()}@${emailDomain}`;
      const payload = {
        nome: form.name.trim(),
        email: fullEmail,
        senha: form.password, // <- chave correta esperada no backend
        id_departamento: Number(departamentoId), // <- chave correta esperada no backend
      };

      await registerUser(payload);

      // Vai para login
      if (onSwitchToLogin) onSwitchToLogin();
      else navigate('/login', { replace: true });
    } catch (err) {
      const apiMsg =
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        'Falha no cadastro. Verifique os dados e tente novamente.';
      setErrors((s) => ({ ...s, api: apiMsg }));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background text-foreground">
      <Card className="w-full max-w-md gradient-card shadow-medium border border-[var(--border)]">
        <CardHeader className="text-center relative">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (onSwitchToLogin) onSwitchToLogin();
              else navigate('/login');
            }}
            className="absolute left-4 top-4"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <CardTitle className="text-2xl font-bold pt-1">Cadastro</CardTitle>
          <CardDescription>Crie sua conta para acessar o sistema</CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {errors.api && (
              <p className="text-sm text-red-600 text-center bg-red-100 p-2 rounded">
                {errors.api}
              </p>
            )}

            {/* Nome */}
            <div className="space-y-2">
              <Label htmlFor="name">Nome Completo</Label>
              <Input
                id="name"
                name="name"
                type="text"
                placeholder="Seu nome completo"
                value={form.name}
                onChange={onChange}
                required
              />
              {errors.name && <p className="text-sm text-red-600">{errors.name}</p>}
            </div>

            {/* Email corporativo: parte local + domínio corporativo */}
            <div className="space-y-2">
              <Label htmlFor="emailLocal">Email corporativo</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Input
                  id="emailLocal"
                  name="emailLocal"
                  type="text"
                  placeholder="nome.sobrenome"
                  value={form.emailLocal}
                  onChange={onChange}
                  required
                />
                <select
                  aria-label="Domínio do email"
                  value={emailDomain}
                  onChange={(e) => setEmailDomain(e.target.value)}
                  className="glass-select flex h-9 w-full items-center justify-between rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {EMAIL_DOMAINS.map((d) => (
                    <option key={`dom-${d}`} value={d}>{`@${d}`}</option>
                  ))}
                </select>
              </div>
              {errors.email && <p className="text-sm text-red-600">{errors.email}</p>}
            </div>

            {/* Departamento */}
            <div className="space-y-2">
              <Label htmlFor="departamento">Departamento</Label>
              <select
                id="departamento"
                name="departamento"
                value={departamentoId}
                onChange={(e) => {
                  setDepartamentoId(e.target.value);
                  if (errors.departamento) {
                    setErrors((s) => ({ ...s, departamento: '' }));
                  }
                }}
                className="glass-select flex h-9 w-full items-center justify-between rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                required
              >
                <option value="" disabled>
                  Selecione um departamento
                </option>
                {departamentos.map((dep) => (
                  <option key={`dep-${dep.id}`} value={dep.id}>
                    {dep.nome}
                  </option>
                ))}
              </select>
              {errors.departamento && (
                <p className="text-sm text-red-600">{errors.departamento}</p>
              )}
            </div>

            {/* Senha */}
            <div className="space-y-2">
              <Label htmlFor="password">Senha</Label>
              <div className="relative">
                <Input
                  id="password"
                  name="password"
                  type={showPwd ? 'text' : 'password'}
                  placeholder="Digite sua senha"
                  value={form.password}
                  onChange={onChange}
                  required
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                  onClick={() => setShowPwd((v) => !v)}
                >
                  {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              {errors.password && (
                <p className="text-sm text-red-600">{errors.password}</p>
              )}
            </div>

            {/* Confirmar Senha */}
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirmar Senha</Label>
              <div className="relative">
                <Input
                  id="confirmPassword"
                  name="confirmPassword"
                  type={showPwd2 ? 'text' : 'password'}
                  placeholder="Confirme sua senha"
                  value={form.confirmPassword}
                  onChange={onChange}
                  required
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                  onClick={() => setShowPwd2((v) => !v)}
                >
                  {showPwd2 ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              {errors.confirmPassword && (
                <p className="text-sm text-red-600">{errors.confirmPassword}</p>
              )}
            </div>

            <Button type="submit" className="w-full bg-slate-800 hover:bg-slate-700" disabled={isLoading}>
              {isLoading ? 'Cadastrando...' : 'Cadastrar'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};

export default Register;
