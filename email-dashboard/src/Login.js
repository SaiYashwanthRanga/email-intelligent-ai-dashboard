import React, { useState } from 'react';
import axios from 'axios';
import { Lock, User, ChevronRight, AlertTriangle } from 'lucide-react';
import './App.css'; 


const API_BASE = "http://172.22.6.145/";

const Login = () => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

try {
   const res = await axios.post(`${API_BASE}/login`, {
      email: username,     
      password: password
    });

    // If API returns user object
    if (res.status === 200) {
      localStorage.setItem("jimAuthSession", "true");
      localStorage.setItem("loggedInUser", res.data.account || username);
      window.location.href = "/";
    }
  } catch (err) {
    if (err.response?.status === 401) {
      setError("Invalid credentials");
    } else {
      setError("Server error. Please try again later.");
    }
  } finally {
    setLoading(false);
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
          <button type="submit" className="btn-login" disabled={loading}>
            {loading ? "Verifying..." : "Sign In"} <ChevronRight size={16}/>
          </button>
        </form>
        <div className="login-footer">Protected System • HFMG Internal Only</div>
      </div>
    </div>
  );
};

export default Login;
