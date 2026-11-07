import { Router } from "express";
import * as tools from "../controllers/customToolController.js";
import { requireAdmin } from "../middleware/auth.js";

const router = Router();
router.get("/custom-tools", tools.list);
// A tool carries an API key and calls out of our network, so only an admin may touch one.
router.post("/custom-tools", requireAdmin, tools.create);
router.patch("/custom-tools/:toolId", requireAdmin, tools.update);
router.delete("/custom-tools/:toolId", requireAdmin, tools.remove);
router.post("/custom-tools/:toolId/test", requireAdmin, tools.test);
export default router;
