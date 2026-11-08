import { Router } from "express";
import * as ws from "../controllers/workspaceController.js";
import * as auth from "../controllers/authController.js";
import * as orgs from "../controllers/orgController.js";
import { authLimiter } from "../middleware/rateLimit.js";
import { requirePermission } from "../middleware/auth.js";

const router = Router();
router.get("/me", ws.me);
router.get("/config", ws.settings);
router.get("/settings", ws.settings); // the Studio frontend's name for this; /config is kept for agents.js's own check
router.get("/tools", ws.tools);
router.get("/providers", ws.providers);
router.get("/notifications", ws.notifications);
router.post("/notifications/seen", ws.notificationsSeen);
router.get("/orgs", orgs.list);
router.post("/orgs", orgs.create);
router.post("/orgs/join", authLimiter, orgs.join);
router.post("/orgs/:orgId/switch", orgs.switchTo);
router.get("/team", auth.team);
router.get("/roles", ws.roles);
router.get("/avatars", ws.avatars);
router.patch("/me/profile", ws.updateProfile);
router.get("/org/settings", ws.orgSettings);
router.patch("/org/settings", requirePermission("org.settings"), ws.updateOrgSettings);
router.patch("/team/:userId", requirePermission("team.roles"), auth.changeRole);
router.delete("/team/:userId", requirePermission("team.manage"), auth.removeMember);
export default router;
