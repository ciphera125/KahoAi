import { Router } from "express";
import * as agents from "../controllers/agentController.js";
import { requireAdmin } from "../middleware/auth.js";

const router = Router();
router.get("/", agents.list);
router.post("/", agents.create);
router.get("/:agentId", agents.get);
router.patch("/:agentId", agents.update);
router.delete("/:agentId", requireAdmin, agents.remove);
export default router;
