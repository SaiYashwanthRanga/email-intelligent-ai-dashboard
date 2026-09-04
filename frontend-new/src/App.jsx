import React, { useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Login from './Login';
import Dashboard from './Dashboard';
import Calendarview from './Calendarview';
import TrackingView from './Trackingview';
import ActivityView from './ActivityView';
import BootAnimation from './BootAnimation';
import './animations.css';

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
          </Routes>
        </Router>
      )}
    </>
  );
}

export default App;