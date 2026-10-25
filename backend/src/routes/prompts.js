import { Router } from "express";
import * as prompts from "../controllers/promptController.js";
import { requireAdmin } from "../middleware/auth.js";

const router = Router();
router.get("/", prompts.list);
router.post("/", prompts.create);
router.get("/:promptId", prompts.get);
router.patch("/:promptId", prompts.update);
router.delete("/:promptId", requireAdmin, prompts.remove);
router.post("/:promptId/assign", prompts.assign);
router.get("/:promptId/versions", prompts.versions);
router.post("/:promptId/versions/:versionId/restore", prompts.restoreVersion);
router.delete("/:promptId/versions/:versionId", prompts.deleteVersion);
export default router;
