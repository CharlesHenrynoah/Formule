import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { ErrorBoundary } from '@/components/es/boundary';

// Filet global : une erreur hors panneau affiche un repli (et le bouton « Demander au contremaître de corriger »)
// au lieu d'un écran blanc ; les panneaux ont chacun leur propre error boundary (AppShell / Panel).
createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary name="app"><App /></ErrorBoundary></StrictMode>);
