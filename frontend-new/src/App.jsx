import React, { useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Login from './Login';
import Dashboard from './Dashboard';
import Calendarview from './Calendarview';
import TrackingView from './Trackingview';
import ActivityView from './ActivityView';
import AdminView, { AdminSectionView } from './AdminView';
import BootAnimation from './BootAnimation';
import './animations.css';
import { initTheme } from './useTheme';

// Applied here, not in Dashboard: a direct load of /tracking or /calendar never
// mounts Dashboard, and used to come up dark for a light-mode user.
initTheme();

const PrivateRoute = ({ children }) => {
  const isAuthenticated = localStorage.getItem("jimAuthSession") === "true";
  return isAuthenticated ? children : <Navigate to="/login" />;
};

function App() {
  const [booting, setBooting] = useState(true);

  return (
    <>
      {booting && <BootAnimation onDone={() => setBooting(false)} />}
      {!booting && (
        <Router>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<PrivateRoute><Dashboard /></PrivateRoute>} />
            <Route path="/calendar" element={<PrivateRoute><Calendarview /></PrivateRoute>} />
            <Route path="/tracking" element={<PrivateRoute><TrackingView /></PrivateRoute>} />
            <Route path="/activity" element={<PrivateRoute><ActivityView /></PrivateRoute>} />
            <Route path="/admin" element={<PrivateRoute><AdminView /></PrivateRoute>} />
            <Route path="/admin/:section" element={<PrivateRoute><AdminSectionView /></PrivateRoute>} />
          </Routes>
        </Router>
      )}
    </>
  );
}

export default App;