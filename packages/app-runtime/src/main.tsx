import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import spec from './app.spec.json';
import data from './app.data.json';
import { App } from './runtime/App';
import type { AppSpec, AppDataBundle } from '@formule/contracts/browser';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App spec={spec as unknown as AppSpec} data={data as unknown as AppDataBundle} />
  </StrictMode>,
);
