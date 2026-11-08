import { Router } from "express";
import * as prompts from "../controllers/promptController.js";
import { requirePermission } from "../middleware/auth.js";

const router = Router();
router.get("/", prompts.list);
router.post("/", requirePermission("agents.edit"), prompts.create);
router.get("/:promptId", prompts.get);
router.patch("/:promptId", requirePermission("agents.edit"), prompts.update);
router.delete("/:promptId", requirePermission("agents.delete"), prompts.remove);
router.post("/:promptId/assign", requirePermission("agents.edit"), prompts.assign);
router.get("/:promptId/versions", prompts.versions);
router.post("/:promptId/versions/:versionId/restore", requirePermission("agents.edit"), prompts.restoreVersion);
router.delete("/:promptId/versions/:versionId", requirePermission("agents.edit"), prompts.deleteVersion);
export default router;
