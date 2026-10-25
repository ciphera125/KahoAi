// Every /api route. Signing in is open; everything after needs a session.
import { Router } from "express";
import { requireSession } from "../middleware/auth.js";
import authRoutes from "./auth.js";
import workspaceRoutes from "./workspace.js";
import agentRoutes from "./agents.js";
import promptRoutes from "./prompts.js";
import numberRoutes from "./numbers.js";
import contactRoutes from "./contacts.js";
import callRoutes from "./calls.js";
import bulkRoutes from "./bulk.js";

const router = Router();
router.use("/auth", authRoutes);
router.use(requireSession);
router.use(workspaceRoutes);
router.use("/agents", agentRoutes);
router.use("/prompts", promptRoutes);
router.use(numberRoutes);
router.use(contactRoutes);
router.use(callRoutes);
router.use("/bulk-calls", bulkRoutes);
export default router;
