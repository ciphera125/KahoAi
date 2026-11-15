// Who is signed in to the admin site, loaded once. The cookie is the session; this only mirrors /api/admin/me
// so the page knows what to show. The server is what actually decides.
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { get, post, setUnauthorizedHandler } from "./api.js";

const Ctx = createContext(null);
export const useAdmin = () => useContext(Ctx);

export function AdminProvider({ children }) {
  const [admin, setAdmin] = useState(undefined); // undefined = loading, null = signed out
  const refresh = useCallback(async () => {
    try { setAdmin(await get("/me")); } catch { setAdmin(null); }
  }, []);
  useEffect(() => { setUnauthorizedHandler(() => setAdmin(null)); refresh(); }, [refresh]);
  const signOut = useCallback(async () => { await post("/auth/logout").catch(() => {}); setAdmin(null); }, []);
  return <Ctx.Provider value={{ admin, setAdmin, refresh, signOut }}>{children}</Ctx.Provider>;
}
