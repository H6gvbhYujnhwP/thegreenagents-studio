import React from 'react';
import Dashboard from './components/Dashboard.jsx';

// AUTH TEMPORARILY DISABLED FOR TESTING
// To re-enable: restore App-with-auth.jsx (see git history)
export default function App() {
  return <Dashboard onLogout={() => {}} />;
}
