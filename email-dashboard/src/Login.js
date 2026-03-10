import React, { useState } from 'react';
import { Lock, User, ChevronRight, AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import './App.css';

const LOGIN_URL = process.env.REACT_APP_API_URL + "/login";

const Login = () => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);

  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch(LOGIN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: username, password })
      });

      if (!response.ok) {
        let msg = "Invalid credentials";
        try {
          const errData = await response.json();
          if (errData.message) msg = errData.message;
        } catch (_) {}
        throw new Error(msg);
      }

      const user = await response.json();

      // Server returns: { account, name, mail, role }
      const resolvedEmail = user.mail;
      const resolvedName  = user.name || resolvedEmail.split("@")[0];

      if (!resolvedEmail) {
        throw new Error("Login failed: no email returned from server.");
      }

      localStorage.setItem("jimAuthSession", "true");
      localStorage.setItem("sessionUser",  JSON.stringify(user));
      localStorage.setItem("loggedInUser", resolvedName);
      localStorage.setItem("userEmail",    resolvedEmail);

      navigate("/");

    } catch (err) {
      setError(err.message || "Login failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">

        <div className="login-card-header">
          <div className="login-card-icon">
            <Lock size={20} color="white" strokeWidth={2.5} />
          </div>
          <h2 className="login-card-title">Executive Access</h2>
          <p className="login-card-sub">HFMG Internal Portal</p>
        </div>

        <form onSubmit={handleLogin} className="login-fields">

          <div className="lf-group">
            <label className="lf-label">Username</label>
            <div className="lf-input-wrap">
              <User size={15} className="lf-icon" />
              <input
                type="text"
                className="lf-input"
                placeholder="Enter your username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="username"
              />
            </div>
          </div>

          <div className="lf-group">
            <label className="lf-label">Password</label>
            <div className="lf-input-wrap">
              <Lock size={15} className="lf-icon" />
              <input
                type="password"
                className="lf-input"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
          </div>

          {error && (
            <div className="lf-error">
              <AlertTriangle size={13} />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            className="lf-submit"
            disabled={loading || !username || !password}
          >
            {loading ? (
              <span className="lf-loading-dots">
                <span /><span /><span />
              </span>
            ) : (
              <>Sign In <ChevronRight size={16} /></>
            )}
          </button>

        </form>

        <p className="lf-footer-note">Protected System · Authorized Personnel Only</p>

      </div>
    </div>
  );
};

export default Login;