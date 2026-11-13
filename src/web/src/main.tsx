import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { Remote } from './Remote';
import { Settings } from './Settings';
import './styles.css';
import './theme.css';
import './home.css';
import './screens.css';

// The phone remote and the administrator pages are separate apps; everything else is the TV shell.
// Navigation renders synchronously (no transitions): the next D-pad press must land on the new screen.
const page = location.pathname.startsWith('/settings') ? <Settings />
  : location.pathname === '/remote' ? <Remote />
  : <BrowserRouter unstable_useTransitions={false}><App /></BrowserRouter>;
createRoot(document.getElementById('root')!).render(<React.StrictMode>{page}</React.StrictMode>);
