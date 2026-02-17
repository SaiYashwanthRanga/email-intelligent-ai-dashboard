import React, { useState } from 'react';
import { Lock, User, ChevronRight, AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import './App.css';

// Always call YOUR FastAPI backend — never the org server directly from the browser (CORS)
const LOGIN_URL = (process.env.REACT_APP_API_URL || "http://localhost:8000/api") + "/login";

const Login = () => {
  const [email, setEmail]       = useState("");
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
        body: JSON.stringify({ email, password })
      });

      if (!response.ok) {
        // Try to extract a message from the error body, fall back to generic text
        let msg = "Invalid email or password";
        try {
          const errData = await response.json();
          if (errData.message) msg = errData.message;
        } catch (_) {}
        throw new Error(msg);
      }

      // Expected shape: { account, name, mail, role }
      const user = await response.json();

      // ─── Persist session ────────────────────────────────────────────────
      // 🔧 HARDCODED FOR TESTING: Always use ramon.romero@hfmg.net
      const TESTING_EMAIL = "ramon.romero@hfmg.net";
      
      // "jimAuthSession" is what PrivateRoute in App.js checks
      localStorage.setItem("jimAuthSession", "true");

      // Full user object – used anywhere we need account/role info
      localStorage.setItem("sessionUser", JSON.stringify(user));

      // Display name for the greeting in Dashboard
      // Falls back to the part of the email before '@'
      const displayName = user.name || user.mail?.split("@")[0] || "User";
      localStorage.setItem("loggedInUser", displayName);

      // 🔧 TESTING: Hardcode Ramon's email for all API calls
      localStorage.setItem("userEmail", TESTING_EMAIL);
      console.log(`🔧 TESTING MODE: Using hardcoded email: ${TESTING_EMAIL}`);
      // ─────────────────────────────────────────────────────────────────────

      // "/" is the only protected route defined in App.js → Dashboard
      navigate("/");

    } catch (err) {
      setError(err.message || "Login failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container p-10 bg-white">
      <div className="login-card">

        <div className="login-header">
          <div className="login-icon"><Lock size={24} color="white" /></div>
          <h2>Executive Access</h2>
          <p>Please sign in</p>
        </div>

        <form onSubmit={handleLogin} className="login-form">

          <div className="input-group">
            <label>Email</label>
            <div className="input-wrapper">
              <User size={18} className="input-icon" />
              <input
                type="text"
                placeholder="Enter email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>
          </div>

          <div className="input-group">
            <label>Password</label>
            <div className="input-wrapper">
              <Lock size={18} className="input-icon"   color='black' />
              <input
                type="password"
                placeholder="Enter password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
          </div>

          {error && (
            <div className="error-msg">
              <AlertTriangle size={14} /> {error}
            </div>
          )}

          <button
            type="submit"
            className="btn-login"
            disabled={loading || !email || !password}
          >
            {loading ? "Verifying..." : "Sign In"} <ChevronRight size={16} />
          </button>

        </form>

        <div className="login-footer">
          Protected System • HFMG Internal Only
        </div>

      </div>
    </div>
  );
};

export default Login;