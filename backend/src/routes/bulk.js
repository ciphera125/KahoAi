import { Router } from "express";
import * as bulk from "../controllers/bulkController.js";

const router = Router();
router.get("/", bulk.list);
router.post("/", bulk.create);
router.get("/:runId", bulk.get);
for (const action of ["pause", "resume", "cancel"]) router.post(`/:runId/${action}`, bulk.act(action));
export default router;
