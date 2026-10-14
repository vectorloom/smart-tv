import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Remote } from './Remote';
import { Settings } from './Settings';
import './styles.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode>{location.pathname.startsWith('/settings') ? <Settings /> : location.pathname === '/remote' ? <Remote /> : <App />}</React.StrictMode>);
