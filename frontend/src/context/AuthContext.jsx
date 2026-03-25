import React, { createContext, useState, useContext, useEffect, useRef } from 'react';
import { jwtDecode } from 'jwt-decode';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(null);
  const expiryTimerRef = useRef(null);
  const remainingTimerRef = useRef(null);
  const expMsRef = useRef(null);

  const clearTimer = () => {
    if (expiryTimerRef.current) {
      clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = null;
    }
  };

  const clearRemainingTimer = () => {
    if (remainingTimerRef.current) {
      clearInterval(remainingTimerRef.current);
      remainingTimerRef.current = null;
    }
  };

  const clearAuth = () => {
    localStorage.removeItem('userToken');
    setUser(null);
    setRemainingSeconds(null);
    expMsRef.current = null;
  };

  const scheduleExpiry = (expMs) => {
    clearTimer();
    clearRemainingTimer();
    if (!expMs || !Number.isFinite(expMs)) return;
    expMsRef.current = expMs;

    const updateRemaining = () => {
      const left = Math.max(0, Math.ceil((expMsRef.current - Date.now()) / 1000));
      setRemainingSeconds(left);
    };

    updateRemaining();
    remainingTimerRef.current = setInterval(updateRemaining, 1000);

    const delay = expMs - Date.now();
    if (delay <= 0) {
      setSessionExpired(true);
      clearAuth();
      return;
    }
    expiryTimerRef.current = setTimeout(() => {
      setSessionExpired(true);
      clearAuth();
    }, delay);
  };

  useEffect(() => {
    const token = localStorage.getItem('userToken');
    if (token) {
      try {
        const decoded = jwtDecode(token);
        // Verifica se o token nao expirou
        if (decoded.exp * 1000 > Date.now()) {
          const tipoConta = decoded.tipo_conta || decoded.role || decoded.tipoConta;
          setUser({
            nome: decoded.nome,
            tipo_conta: tipoConta,
            user_id: decoded.user_id,
          });
          scheduleExpiry(decoded.exp * 1000);
        } else {
          setSessionExpired(true);
          clearAuth();
        }
      } catch (error) {
        console.error('Erro ao decodificar token:', error);
        clearAuth();
      }
    }
    return () => {
      clearTimer();
      clearRemainingTimer();
    };
  }, []);

  useEffect(() => {
    const handler = () => {
      setSessionExpired(true);
      clearAuth();
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('auth:expired', handler);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('auth:expired', handler);
      }
    };
  }, []);

  const login = (token) => {
    try {
      const decoded = jwtDecode(token);
      const tipoConta = decoded.tipo_conta || decoded.role || decoded.tipoConta;
      localStorage.setItem('userToken', token);
      setUser({
        nome: decoded.nome,
        tipo_conta: tipoConta,
        user_id: decoded.user_id,
      });
      setSessionExpired(false);
      scheduleExpiry(decoded.exp * 1000);
    } catch (error) {
      console.error('Token de login invalido:', error);
    }
  };

  const logout = () => {
    clearTimer();
    clearRemainingTimer();
    clearAuth();
    setSessionExpired(false);
  };

  const clearSessionExpired = () => setSessionExpired(false);

  const value = { user, login, logout, sessionExpired, clearSessionExpired, remainingSeconds };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => useContext(AuthContext);
