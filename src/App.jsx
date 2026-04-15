import React from 'react';
import Dashboard from './components/Dashboard.jsx';

// Auth temporarily disabled for testing — restore Login flow before going live
export default function App() {
  return <Dashboard onLogout={() => {}} />;
}
