import React, { useState, useEffect } from "react";

export default function BootAnimation({ onDone }) {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const t1 = setTimeout(() => setPhase(1), 500);   // logo fades in
    const t2 = setTimeout(() => setPhase(2), 1800);  // hold
    const t3 = setTimeout(() => setPhase(3), 2600);  // zoom rush
    const t4 = setTimeout(() => setPhase(4), 3400);  // done
    const t5 = setTimeout(() => onDone && onDone(), 3600);
    return () => [t1,t2,t3,t4,t5].forEach(clearTimeout);
  }, [onDone]);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "#000",
      display: "flex", alignItems: "center", justifyContent: "center",
      overflow: "hidden",
      opacity: phase >= 4 ? 0 : 1,
      transition: phase >= 4 ? "opacity 0.4s ease" : "none"
    }}>

      {/* Radial glow behind logo */}
      <div style={{
        position: "absolute",
        width: "600px", height: "300px",
        borderRadius: "50%",
        background: "radial-gradient(ellipse, rgba(255,255,255,0.06) 0%, transparent 70%)",
        opacity: phase >= 1 && phase < 3 ? 1 : 0,
        transform: `scale(${phase >= 2 ? 1.3 : 0.8})`,
        transition: "opacity 1.2s ease, transform 1.6s ease",
        pointerEvents: "none", zIndex: 0
      }} />

      {/* Logo */}
      <div style={{
        position: "relative", zIndex: 1,
        opacity: phase >= 1 && phase < 3 ? 1 : 0,
        transform: phase <= 1 ? "scale(0.88) translateY(10px)"
                 : phase === 2 ? "scale(1) translateY(0px)"
                 : "scale(3.8) translateY(0px)",
        filter: phase >= 3 ? "blur(18px) brightness(2.2)" : "blur(0px) brightness(1.08)",
        transition: "opacity 0.95s cubic-bezier(0.16,1,0.3,1), transform 1.1s cubic-bezier(0.16,1,0.3,1), filter 0.7s ease",
        transformOrigin: "center center"
      }}>
        <img
          src="https://cdn.prod.website-files.com/65943a67d00c014c2d920492/65943bb45991d7c7423aada3_logo.webp"
          alt="HFMG"
          style={{ width: "240px", display: "block", objectFit: "contain" }}
        />
      </div>

      {/* Subtle vignette */}
      <div style={{
        position: "absolute", inset: 0, zIndex: 2, pointerEvents: "none",
        background: "radial-gradient(ellipse 80% 80% at 50% 50%, transparent 40%, rgba(0,0,0,0.7) 100%)",
        opacity: phase >= 1 && phase < 3 ? 1 : 0,
        transition: "opacity 1s ease"
      }} />

      {/* White bleed flash */}
      <div style={{
        position: "absolute", inset: 0, zIndex: 3, pointerEvents: "none",
        background: "white",
        opacity: phase >= 3 ? 0.85 : 0,
        transition: phase >= 3
          ? "opacity 0.5s cubic-bezier(0.4,0,0.2,1)"
          : "opacity 0.3s ease"
      }} />

    </div>
  );
}