import React from 'react';
import { motion } from 'framer-motion';

// Shared overlay+content animation for every modal in the app (fade the
// overlay, scale+fade the content). Deliberately does NOT own the
// conditional mount itself — callers keep their existing
// `{x && ( ... )}` guard and wrap that whole expression in <AnimatePresence>,
// with this component on the right-hand side of the `&&`. That preserves
// the guard's short-circuit: JSX referencing `x.title` etc. is still only
// ever evaluated when `x` is truthy, exactly as before this component
// existed — AnimatedModal itself never touches the data that gates it.
//
// Usage:
//   <AnimatePresence>
//     {x && (
//       <AnimatedModal onOverlayClick={...} contentClassName="modal-content file-modal">
//         ...existing modal content, unchanged...
//       </AnimatedModal>
//     )}
//   </AnimatePresence>
export default function AnimatedModal({
  onOverlayClick,
  overlayClassName = 'modal-overlay',
  overlayStyle,
  contentClassName = 'modal-content',
  contentStyle,
  onContentClick,
  children,
}) {
  return (
    <motion.div
      className={overlayClassName}
      style={overlayStyle}
      onClick={onOverlayClick}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      <motion.div
        className={contentClassName}
        style={contentStyle}
        onClick={onContentClick ?? ((e) => e.stopPropagation())}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}
