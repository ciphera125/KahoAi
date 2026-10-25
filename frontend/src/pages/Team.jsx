// The organization's people and their roles. The owner promotes members to
// admin and back; admins and the owner remove people below them. Everything
// here is also enforced on the server, so hiding a button is only a convenience.
import { useCallback, useEffect, useState } from "react";
import { del, get, patch, post } from "../api.js";
import { isAdmin, isOwner, useAuth } from "../auth.jsx";
import { ago, initials, Menu, Spinner, useConfirm, useToast } from "../ui.jsx";

export default function Team() {
  const { me } = useAuth();
  const toast = useToast();
  const [confirm, confirmNode] = useConfirm();
  const [team, setTeam] = useState(null);
  const [invite, setInvite] = useState(null);
  const load = useCallback(() => get("/api/team").then(setTeam).catch((e) => toast(e.message, true)), [toast]);
  useEffect(() => { load(); if (isAdmin(me)) get("/api/me").then((m) => m.invite_code && setInvite({ code: m.invite_code, expires: m.invite_expires })).catch(() => {}); }, [load]);
  if (!team) return <Spinner />;

  const setRole = async (u, role) => { try { await patch(`/api/team/${u.id}`, { role }); toast(`${u.name} is now ${role === "admin" ? "an admin" : "a member"}.`); load(); } catch (e) { toast(e.message, true); } };
  const remove = async (u) => { if (!(await confirm({ title: `Remove ${u.name}?`, text: "They lose access immediately and every browser they are signed in on is signed out.", ok: "Remove" }))) return; try { await del(`/api/team/${u.id}`); toast(`${u.name} removed.`); load(); } catch (e) { toast(e.message, true); } };
  const newInvite = async () => { try { const r = await post("/api/auth/invite"); setInvite({ code: r.invite_code, expires: r.invite_expires }); toast("New invite code."); } catch (e) { toast(e.message, true); } };

  const canManage = (u) => u.id !== me.id && u.role !== "owner" && (isOwner(me) || u.role === "member");
  return (
    <section>
      <header className="page"><div><h1>Team</h1><div className="sub">Everyone in {me.org_name}. Roles decide who can change numbers, delete things and manage people.</div></div></header>
      {isAdmin(me) && invite && (
        <div className="card" style={{ marginBottom: "var(--s4)" }}>
          <div className="card-head"><span className="card-title">Invite a teammate</span></div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span className="code" style={{ padding: "3px 8px", borderRadius: 4, background: "var(--surface-2)", border: "1px solid var(--border)" }}>{invite.code}</span>
            <button type="button" className="ghost small-btn" onClick={() => navigator.clipboard.writeText(invite.code).then(() => toast("Invite code copied. They enter it when they create their account."), () => toast("Could not copy; select the code instead.", true))}>Copy</button>
            <button className="ghost small-btn" onClick={newInvite}>New code</button>
            <span className="hint">They enter this when creating their account. Works once, for a week.</span>
          </div>
        </div>
      )}
      <div className="card list">
        <div className="row head" style={{ gridTemplateColumns: "minmax(0,1.5fr) 110px minmax(0,1fr) 56px" }}><span>Name</span><span>Role</span><span>Last active</span><span /></div>
        {team.map((u) => (
          <div key={u.id} className="row" style={{ gridTemplateColumns: "minmax(0,1.5fr) 110px minmax(0,1fr) 56px" }}>
            <div className="who"><div className="avatar">{initials(u.name)}</div><div style={{ minWidth: 0 }}><b className="ellip">{u.name}{u.id === me.id && <span className="muted"> · you</span>}</b><div className="muted ellip">{u.email}</div></div></div>
            <span className={`pill role ${u.role === "owner" ? "active" : ""}`}>{u.role}</span>
            <span className="muted">{ago(u.last_active)}</span>
            <div className="row-actions">
              {canManage(u) && <Menu items={[
                isOwner(me) && [u.role === "admin" ? "Make a member" : "Make an admin", () => setRole(u, u.role === "admin" ? "member" : "admin")],
                ["Remove from team", () => remove(u), true],
              ]} />}
            </div>
          </div>
        ))}
      </div>
      {confirmNode}
    </section>
  );
}
