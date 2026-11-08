import { Router } from "express";
import * as bulk from "../controllers/bulkController.js";
import { requirePermission } from "../middleware/auth.js";

const router = Router();
router.get("/", bulk.list);
router.post("/", requirePermission("calls.bulk"), bulk.create);
router.get("/:runId", bulk.get);
for (const action of ["pause", "resume", "cancel"]) router.post(`/:runId/${action}`, bulk.act(action));
export default router;
