import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, CheckCircle, AlertCircle, Info, Loader } from 'lucide-react';

const ToastItem = ({ id, message, type, count = 1, onClose }) => {
  useEffect(() => {
    // id changes every time the toast is bumped (dedup), resetting this timer
    const timer = setTimeout(() => {
      onClose(id);
    }, 4000);
    return () => clearTimeout(timer);
  }, [id, onClose]);

  const icons = {
    success: <CheckCircle size={18} color="#4ade80" />,
    error:   <AlertCircle size={18} color="#f87171" />,
    loading: <Loader size={18} className="spin-icon" color="#38bdf8" />,
    info:    <Info size={18} color="#38bdf8" />
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 50 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 50 }}
      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      className={`toast-item toast-${type}`}
    >
      <div className="toast-icon-box">{icons[type] || icons.info}</div>
      <span className="toast-text">{message}</span>

      {count > 1 && (
        <span style={{
          background: 'rgba(255,255,255,0.18)',
          color: '#fff',
          fontSize: '0.65rem',
          fontWeight: '800',
          borderRadius: '999px',
          padding: '1px 7px',
          marginLeft: '4px',
          flexShrink: 0,
          letterSpacing: '0.3px'
        }}>
          x{count}
        </span>
      )}

      <button onClick={() => onClose(id)} className="toast-close-btn">
        <X size={14} />
      </button>
    </motion.div>
  );
};

const ToastContainer = ({ toasts, removeToast }) => {
  return (
    <div className="toast-container-fixed">
      <AnimatePresence>
        {toasts.map((toast) => (
          <ToastItem key={toast.id} {...toast} onClose={removeToast} />
        ))}
      </AnimatePresence>
    </div>
  );
};

export default ToastContainer;
