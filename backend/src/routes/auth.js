import { Router } from "express";
import * as auth from "../controllers/authController.js";
import { requirePermission, requireSession } from "../middleware/auth.js";
import { authLimiter } from "../middleware/rateLimit.js";

const router = Router();
router.get("/state", auth.state);
router.post("/signup", authLimiter, auth.signUp);
router.post("/login", authLimiter, auth.signIn);
router.post("/logout", auth.signOut);
router.post("/support-signin", authLimiter, auth.supportSignIn);
router.post("/password", authLimiter, requireSession, auth.changePassword);
router.post("/logout-others", requireSession, auth.signOutOthers);
export default router;
