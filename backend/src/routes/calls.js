import { Router } from "express";
import * as calls from "../controllers/callController.js";
import { requireAdmin } from "../middleware/auth.js";

const router = Router();
router.get("/dashboard", calls.dashboard);
router.post("/dashboard/sync", requireAdmin, calls.sync);
router.get("/calls", calls.list);
router.get("/calls/tools", calls.toolCallsList);
router.get("/calls/active", calls.activeCalls);
router.post("/calls", calls.place);
router.get("/calls/:callId/transcript", calls.transcript);
router.get("/calls/:callId/transcript.csv", calls.transcriptCsv);
router.get("/calls/:callId/stream", calls.stream);
router.get("/contacts/:contactId/calls", calls.forContact);
export default router;
