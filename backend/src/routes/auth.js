import { Router } from "express";
import * as auth from "../controllers/authController.js";
import { requireAdmin, requireSession } from "../middleware/auth.js";
import { authLimiter } from "../middleware/rateLimit.js";

const router = Router();
router.get("/state", auth.state);
router.post("/signup", authLimiter, auth.signUp);
router.post("/login", authLimiter, auth.signIn);
router.post("/logout", auth.signOut);
router.post("/password", authLimiter, requireSession, auth.changePassword);
router.post("/invite", requireSession, requireAdmin, auth.newInvite);
router.post("/logout-others", requireSession, auth.signOutOthers);
export default router;
