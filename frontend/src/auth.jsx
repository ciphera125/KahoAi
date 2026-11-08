// Who is signed in, loaded once and shared. The session itself is an HttpOnly
// cookie the browser holds; this only mirrors what /api/me returns so the UI
// can show the right things. The server is what actually enforces access.
import { createContext, useCallback as useCb, useContext, useEffect, useState } from "react";
import { get, post, setUnauthorizedHandler } from "./api.js";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);
export const useMe = () => useContext(AuthCtx).me;
export const isAdmin = (me) => me && (me.role === "owner" || me.role === "admin");
export const isOwner = (me) => me && me.role === "owner";
/** Whether this person's role allows something (the list comes from the server). Hiding a button with it is a
 * courtesy; the server is what refuses. */
export const can = (me, permission) => Boolean(me?.permissions?.includes(permission));

export function AuthProvider({ children }) {
  const [me, setMe] = useState(undefined); // undefined = still loading, null = signed out

  const refresh = useCb(async () => {
    try { setMe(await get("/api/me")); return true; } catch { setMe(null); return false; }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    refresh();
  }, [refresh]);

  const signOut = useCb(async () => {
    await post("/api/auth/logout").catch(() => {});
    setMe(null);
  }, []);

  return <AuthCtx.Provider value={{ me, setMe, refresh, signOut }}>{children}</AuthCtx.Provider>;
}
