import { Router } from "express";
import * as numbers from "../controllers/numberController.js";
import { requirePermission } from "../middleware/auth.js";

const router = Router();
router.get("/numbers", numbers.list);
router.post("/numbers", requirePermission("numbers.manage"), numbers.add);
router.patch("/numbers/:numberId", requirePermission("numbers.manage"), numbers.update);
router.post("/numbers/:numberId/agent", requirePermission("numbers.manage"), numbers.route);
router.post("/numbers/:numberId/default", requirePermission("numbers.manage"), numbers.makeDefault);
router.delete("/numbers/:numberId", requirePermission("numbers.manage"), numbers.remove);
export default router;
