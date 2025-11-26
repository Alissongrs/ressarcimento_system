import React, { createContext, useState, useContext, useEffect } from 'react';
import { jwtDecode } from 'jwt-decode';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);

  useEffect(() => {
    const token = localStorage.getItem('userToken');
    if (token) {
      try {
        const decoded = jwtDecode(token);
        // Verifica se o token não expirou
        if (decoded.exp * 1000 > Date.now()) {
          setUser({
            nome: decoded.nome,
            tipo_conta: decoded.tipo_conta,
            user_id: decoded.user_id,
          });
        } else {
          // Token expirado, remove
          localStorage.removeItem('userToken');
    try { localStorage.removeItem('token'); } catch {}
        }
      } catch (error) {
        console.error("Erro ao decodificar token:", error);
        localStorage.removeItem('userToken');
    try { localStorage.removeItem('token'); } catch {}
      }
    }
  }, []);

  const login = (token) => {
    try {
      const decoded = jwtDecode(token);
      localStorage.setItem('userToken', token);
      try { localStorage.setItem('token', token); } catch {}
      setUser({
        nome: decoded.nome,
        tipo_conta: decoded.tipo_conta,
        user_id: decoded.user_id,
      });
    } catch (error) {
      console.error("Token de login inválido:", error);
    }
  };

  const logout = () => {
    localStorage.removeItem('userToken');
    try { localStorage.removeItem('token'); } catch {}
    setUser(null);
  };

  const value = {
    user,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  return useContext(AuthContext);
};

