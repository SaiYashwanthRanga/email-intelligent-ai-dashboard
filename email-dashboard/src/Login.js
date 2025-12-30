import React, { useState } from 'react';
// We don't need useNavigate here anymore because we are using window.location for a hard refresh
import { Lock, User, ChevronRight, AlertTriangle } from 'lucide-react';
import './App.css'; 

const Login = () => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleLogin = (e) => {
    e.preventDefault();
    
    // 1. CHECK CREDENTIALS (Case Sensitive)
    if (username === "Jim" && password === "admin123") {
      
      // 2. SET TOKEN
      localStorage.setItem("jimAuthSession", "true");
      
      // 3. FORCE REDIRECT
      // Using window.location.href ensures the App component re-mounts and sees the token immediately.
      window.location.href = "/"; 
      
    } else {
      setError("Invalid credentials. Try 'Jim' and 'admin123'");
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-header">
          <div className="login-icon"><Lock size={24} color="white"/></div>
          <h2>Executive Access</h2>
          <p>Please sign in to view the dashboard</p>
        </div>
        <form onSubmit={handleLogin} className="login-form">
          <div className="input-group">
            <label>Username</label>
            <div className="input-wrapper">
              <User size={18} className="input-icon"/>
              <input 
                type="text" 
                placeholder="Enter username" 
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
          </div>
          <div className="input-group">
            <label>Password</label>
            <div className="input-wrapper">
              <Lock size={18} className="input-icon"/>
              <input 
                type="password" 
                placeholder="Enter password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>
          {error && <div className="error-msg"><AlertTriangle size={14}/> {error}</div>}
          <button type="submit" className="btn-login">
            Sign In <ChevronRight size={16}/>
          </button>
        </form>
        <div className="login-footer">Protected System • HFMG Internal Only</div>
      </div>
    </div>
  );
};

export default Login;