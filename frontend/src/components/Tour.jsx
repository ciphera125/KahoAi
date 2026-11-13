// A guided walk through the whole Studio. Each step opens its page behind a small card that
// explains it; Next moves on, Back returns, and Skip leaves at any moment (Escape too).
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { STEPS } from "../tour.js";

export default function Tour({ onClose }) {
  const navigate = useNavigate();
  const [i, setI] = useState(0);
  const step = STEPS[i];
  const last = i === STEPS.length - 1;
  useEffect(() => { if (step.path) navigate(`/${step.path}`); }, [step.path, navigate]);
  useEffect(() => {
    const key = (e) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && !last) setI((n) => n + 1);
      else if (e.key === "ArrowLeft" && i > 0) setI((n) => n - 1);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [i, last, onClose]);
  return (
    <div className="tour" role="dialog" aria-modal="false" aria-label="Guided tour">
      <div className="tour-top">
        <span className="tour-count">Step {i + 1} of {STEPS.length}</span>
        <button type="button" className="link" onClick={onClose}>Skip tour</button>
      </div>
      <h3>{step.title}</h3>
      <p>{step.text}</p>
      <div className="tour-bar" aria-hidden="true"><i style={{ width: `${((i + 1) / STEPS.length) * 100}%` }} /></div>
      <div className="tour-actions">
        <button type="button" className="ghost" onClick={() => setI((n) => n - 1)} disabled={i === 0}>Back</button>
        <button type="button" className="primary" onClick={() => (last ? onClose() : setI((n) => n + 1))} autoFocus>{last ? "Finish" : i === 0 ? "Start the tour" : "Next"}</button>
      </div>
    </div>
  );
}
