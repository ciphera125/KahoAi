import { Router } from "express";
import * as bulk from "../controllers/bulkController.js";
import { requireAdmin } from "../middleware/auth.js";

const router = Router();
router.get("/", bulk.list);
router.post("/", requireAdmin, bulk.create);
router.get("/:runId", bulk.get);
for (const action of ["pause", "resume", "cancel"]) router.post(`/:runId/${action}`, bulk.act(action));
export default router;
