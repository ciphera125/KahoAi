import { Router } from "express";
import * as errors from "../controllers/errorController.js";
import { requirePermission } from "../middleware/auth.js";

const router = Router();
router.get("/errors", errors.list);
router.post("/errors/acknowledge", requirePermission("agents.edit"), errors.acknowledge);
export default router;
