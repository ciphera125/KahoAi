import { Router } from "express";
import * as ws from "../controllers/workspaceController.js";
import * as auth from "../controllers/authController.js";
import { requireAdmin } from "../middleware/auth.js";

const router = Router();
router.get("/me", ws.me);
router.get("/config", ws.settings);
router.get("/tools", ws.tools);
router.get("/providers", ws.providers);
router.get("/notifications", ws.notifications);
router.post("/notifications/seen", ws.notificationsSeen);
router.get("/team", auth.team);
router.patch("/team/:userId", auth.changeRole);
router.delete("/team/:userId", requireAdmin, auth.removeMember);
export default router;
