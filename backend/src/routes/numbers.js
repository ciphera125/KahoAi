import { Router } from "express";
import * as numbers from "../controllers/numberController.js";
import { requireAdmin } from "../middleware/auth.js";

const router = Router();
router.get("/numbers", numbers.list);
router.post("/numbers", requireAdmin, numbers.add);
router.patch("/numbers/:numberId", requireAdmin, numbers.update);
router.post("/numbers/:numberId/agent", requireAdmin, numbers.route);
router.post("/numbers/:numberId/default", requireAdmin, numbers.makeDefault);
router.delete("/numbers/:numberId", requireAdmin, numbers.remove);
export default router;
