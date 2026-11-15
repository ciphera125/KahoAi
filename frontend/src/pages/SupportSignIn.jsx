// Where "open the Studio as this person" from the admin site lands. The one-use key is in the address after a #,
// so it never reaches a server log; it is taken out of the address bar at once and spent a single time.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { post } from "../api.js";
import { useAuth } from "../auth.jsx";
import { Spinner } from "../ui.jsx";

export default function SupportSignIn() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState(null);
  const started = useRef(false); // React runs effects twice in development; the key can only be spent once
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
    window.history.replaceState(null, "", "/support");
    if (!token) { setError("This support link has no key in it. Open it again from the admin site."); return; }
    post("/api/auth/support-signin", { token })
      .then(async () => { await refresh(); navigate("/dashboard", { replace: true }); })
      .catch((e) => setError(e.message));
  }, [refresh, navigate]);
  if (!error) return <Spinner />;
  return (
    <div className="auth"><div className="card auth-card">
      <h1>Could not open the Studio</h1>
      <p className="sub">{error}</p>
      <p className="hint">Support links work once and expire after a minute. Go back to the admin site and open it again.</p>
    </div></div>
  );
}
