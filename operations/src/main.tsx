import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Auth } from './Auth';
import './styles.css';

const demo = new URLSearchParams(window.location.search).get('demo') === '1';
createRoot(document.getElementById('root')!).render(<React.StrictMode>{demo
  ? <App demo identity={{ id: 'preview', email: 'preview@example.test', role: 'admin' }} />
  : <Auth>{identity => <App demo={false} identity={identity} />}</Auth>}</React.StrictMode>);
