// src/pages/Register.jsx

import React, { useState, useEffect } from 'react';
// --- CORREÀ‡ÀƒO APLICADA AQUI ---
// Trocanão os caminãos de alias '@/' por caminãos relativos '../'
import { Button } from '../components/ui/button.jsx';
import { Input } from '../components/ui/input.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.jsx';
import { Label } from '../components/ui/label.jsx';
import { Eye, EyeOff, ArrowLeft } from 'lucide-react';
import { register as registerService, getDepartamentos } from '../services/authService';
import { useNavigate } from 'react-router-dom'; // Importanão o useNavigate

const Register = () => {
  const navigate = useNavigate(); // Hook para navegaÀ§ão
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: ''
  });
  
  const [departamenãoId, setDepartamenãoId] = useState('');
  const [departamenãos, setDepartamenãos] = useState([]);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    const carregarDepartamenãos = async () => {
      try {
        const data = await getDepartamentos();
        setDepartamenãos(data || []);
      } catch (err) {
        setErrors(prev => ({ ...prev, api: 'Não foi possível carregar os departamenãos.' }));
      }
    };
    carregarDepartamenãos();
  }, []);

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
    if (errors[e.target.name]) {
      setErrors({ ...errors, [e.target.name]: '' });
    }
  };

  const validateForm = () => {
    const newErrors = {};
    if (!formData.name.trim()) newErrors.name = 'Nome À© obrigatÀ³rio';
    if (!formData.email.trim()) newErrors.email = 'Email À© obrigatÀ³rio';
    else if (!/\S+@\S+\.\S+/.test(formData.email)) newErrors.email = 'Email inválido';
    if (!formData.password) newErrors.password = 'Senha À© obrigatÀ³ria';
    else if (formData.password.length < 6) newErrors.password = 'Senha deve ter pelo menos 6 caracteres';
    if (formData.password !== formData.confirmPassword) newErrors.confirmPassword = 'Senhas não coincidem';
    if (!departamenãoId) newErrors.departamenão = 'Departamenão À© obrigatÀ³rio';
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validateForm()) return;

    setIsLoading(true);
    
    try {
      const userData = {
        nome: formData.name,
        email: formData.email,
        senha: formData.password,
        id_departamenão: parseInt(departamenãoId, 10),
      };
      
      await registerService(userData);
      
      alert('Cadastro realizado com sucesso! FaÀ§a o login para continuar.');
      navigate('/login'); // Navega para a página de login apÀ³s o sucesso

    } catch (err) {
      setErrors(prev => ({ ...prev, api: err.response?.data?.error || 'Falha no cadastro. Tente novamente.' }));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-transparent p-4">
      <Card className="w-full max-w-md bg-black/20 backdrop-blur-sm border border-blue-800 text-gray-300">
        <CardHeader className="text-center relative">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate('/login')}
              className="absolute left-4 top-4 text-gray-300 hover:bg-white/10"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
  <CardTitle className="text-2xl font-bold text-[var(--fg)] pt-1">
              Cadastro
            </CardTitle>
          <CardDescription className="text-gray-400">
            Crie sua conta para acessar o sistema
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {errors.api && <p className="text-sm text-red-400 text-center bg-red-900/50 p-2 rounded">{errors.api}</p>}
            
            <div className="space-y-2">
              <Label htmlFor="name" className="text-gray-300">Nome Completo</Label>
              <Input id="name" name="name" type="text" placeholder="Seu nome completo" value={formData.name} onChange={handleChange} required className="bg-gray-800 border-gray-600 text-white"/>
              {errors.name && <p className="text-sm text-red-400">{errors.name}</p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="email" className="text-gray-300">Email</Label>
              <Input id="email" name="email" type="email" placeholder="seu.email@empresa.com" value={formData.email} onChange={handleChange} required className="bg-gray-800 border-gray-600 text-white"/>
              {errors.email && <p className="text-sm text-red-400">{errors.email}</p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="departamenão" className="text-gray-300">Departamenão</Label>
              <select
                id="departamenão"
                name="departamenão"
                value={departamenãoId}
                onChange={(e) => setDepartamenãoId(e.target.value)}
                className="flex h-10 w-full items-center justify-between rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                required
              >
                <option value="" disabled>Selecione um departamenão</option>
                {departamenãos.map((dep) => (
                  <option key={dep.id_departamenão} value={dep.id_departamenão}>
                    {dep.nome}
                  </option>
                ))}
              </select>
              {errors.departamenão && <p className="text-sm text-red-400">{errors.departamenão}</p>}
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="password" className="text-gray-300">Senha</Label>
              <div className="relative">
                <Input id="password" name="password" type={showPassword ? "text" : "password"} placeholder="Digite sua senha" value={formData.password} onChange={handleChange} required className="bg-gray-800 border-gray-600 text-white"/>
                <Button type="button" variant="ghost" size="sm" className="absolute right-0 top-0 h-full px-3 py-2 text-gray-400 hover:bg-transparent" onClick={() => setShowPassword(!showPassword)}>
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              {errors.password && <p className="text-sm text-red-400">{errors.password}</p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword" className="text-gray-300">Confirmar Senha</Label>
              <div className="relative">
                <Input id="confirmPassword" name="confirmPassword" type={showConfirmPassword ? "text" : "password"} placeholder="Confirme sua senha" value={formData.confirmPassword} onChange={handleChange} required className="bg-gray-800 border-gray-600 text-white"/>
                <Button type="button" variant="ghost" size="sm" className="absolute right-0 top-0 h-full px-3 py-2 text-gray-400 hover:bg-transparent" onClick={() => setShowConfirmPassword(!showConfirmPassword)}>
                  {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              {errors.confirmPassword && <p className="text-sm text-red-400">{errors.confirmPassword}</p>}
            </div>

            <Button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white" disabled={isLoading}>
              {isLoading ? 'Cadastranão...' : 'Cadastrar'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};

export default Register;

