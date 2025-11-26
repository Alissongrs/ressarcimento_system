import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

// PageContainer: lightweight page transition (fade + slide)
export default function PageContainer({ children }) {
  const { pathname } = useLocation();
  const [show, setShow] = useState(false);
  useEffect(() => { const id = setTimeout(() => setShow(true), 0); return () => { clearTimeout(id); setShow(false); }; }, [pathname]);
  return (
    <div key={pathname} className={`page-anim ${show ? 'page-anim--in' : ''}`}>
      {children}
    </div>
  );
}

