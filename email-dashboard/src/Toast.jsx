import React, { useEffect } from 'react';
import { X, CheckCircle, AlertCircle, Info, Loader } from 'lucide-react';

const ToastItem = ({ id, message, type, onClose }) => {
  useEffect(() => {
    // Auto-dismiss after 4 seconds
    const timer = setTimeout(() => {
      onClose(id);
    }, 4000);
    return () => clearTimeout(timer);
  }, [id, onClose]);

  const icons = {
    success: <CheckCircle size={20} color="#4ade80" />, // Green
    error: <AlertCircle size={20} color="#f87171" />,   // Red
    loading: <Loader size={20} className="spin-icon" color="#38bdf8" />, // Blue Spinner
    info: <Info size={20} color="#38bdf8" />            // Blue Info
  };

  return (
    <div className={`toast-item toast-${type}`}>
      <div className="toast-icon-box">{icons[type] || icons.info}</div>
      <span className="toast-text">{message}</span>
      <button onClick={() => onClose(id)} className="toast-close-btn">
        <X size={16} />
      </button>
    </div>
  );
};

const ToastContainer = ({ toasts, removeToast }) => {
  return (
    <div className="toast-container-fixed">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} {...toast} onClose={removeToast} />
      ))}
    </div>
  );
};

export default ToastContainer;