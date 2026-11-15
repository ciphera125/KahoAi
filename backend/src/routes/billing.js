import { Router } from "express";
import * as billing from "../controllers/billingController.js";
import { requirePermission } from "../middleware/auth.js";
import { billingWritesPerHour } from "../middleware/rateLimit.js";

const router = Router();
router.get("/plans", billing.plans);
router.get("/billing", billing.overview);
router.get("/billing/summary", billing.summary);
router.get("/billing/ledger", billing.ledger);
router.get("/billing/topups", billing.topups);
const manage = [requirePermission("billing.manage"), billingWritesPerHour];
router.post("/billing/subscribe", ...manage, billing.subscribe);
router.post("/billing/change-request", ...manage, billing.changeRequest);
router.get("/requests", requirePermission("billing.manage"), billing.requests);
router.post("/requests", ...manage, billing.writeToKaho);
router.post("/billing/topups", ...manage, billing.createTopup);
router.post("/billing/topups/:id/cancel", ...manage, billing.cancelTopup);
export default router;
