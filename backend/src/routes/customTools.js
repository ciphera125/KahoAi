import { Router } from "express";
import * as tools from "../controllers/customToolController.js";
import { requirePermission } from "../middleware/auth.js";

const router = Router();
router.get("/custom-tools", tools.list);
// A tool carries an API key and calls out of our network, so only an admin may touch one.
router.post("/custom-tools", requirePermission("tools.custom"), tools.create);
router.patch("/custom-tools/:toolId", requirePermission("tools.custom"), tools.update);
router.delete("/custom-tools/:toolId", requirePermission("tools.custom"), tools.remove);
router.post("/custom-tools/:toolId/test", requirePermission("tools.custom"), tools.test);
export default router;
