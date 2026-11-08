import { Router } from "express";
import * as agents from "../controllers/agentController.js";
import { requirePermission } from "../middleware/auth.js";

const router = Router();
router.get("/", agents.list);
router.post("/", requirePermission("agents.edit"), agents.create);
router.get("/:agentId", agents.get);
router.patch("/:agentId", requirePermission("agents.edit"), agents.update);
router.get("/:agentId/check", agents.check);
router.post("/:agentId/test", requirePermission("agents.edit"), agents.test);
router.post("/:agentId/publish", requirePermission("agents.edit"), agents.publish);
router.get("/:agentId/variables", agents.variables);
router.get("/:agentId/versions", agents.versions);
router.post("/:agentId/versions/:versionId/restore", requirePermission("agents.edit"), agents.restore);
router.delete("/:agentId", requirePermission("agents.delete"), agents.remove);
export default router;
