import { Router } from "express";
import * as agents from "../controllers/agentController.js";
import { requireAdmin } from "../middleware/auth.js";

const router = Router();
router.get("/", agents.list);
router.post("/", agents.create);
router.get("/:agentId", agents.get);
router.patch("/:agentId", agents.update);
router.get("/:agentId/check", agents.check);
router.post("/:agentId/test", agents.test);
router.post("/:agentId/publish", agents.publish);
router.get("/:agentId/variables", agents.variables);
router.get("/:agentId/versions", agents.versions);
router.post("/:agentId/versions/:versionId/restore", agents.restore);
router.delete("/:agentId", requireAdmin, agents.remove);
export default router;
