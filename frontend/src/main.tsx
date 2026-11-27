import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { Studio } from './studio/Studio';
import { Journal } from './journal/Journal';

function Router() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => { const f = () => setPath(location.pathname); addEventListener('popstate', f); return () => removeEventListener('popstate', f); }, []);
  const go = (p: string) => { history.pushState(null, '', p); setPath(p); };
  return path.startsWith('/journal') ? <Journal go={go} /> : <Studio go={go} />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Router /></StrictMode>);
