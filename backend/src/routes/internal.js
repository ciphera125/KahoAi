// /internal/v1: the voice service only (bearer token, see middleware/internal.js).
import { Router } from "express";
import * as internal from "../controllers/internalController.js";

const router = Router();
router.get("/call-config", internal.callConfig);
router.put("/calls/:callId", internal.recordOutcome);
router.get("/dnc", internal.dnc);
router.post("/calls/:callId/events", internal.ingest);
router.post("/calls/:callId/recording", internal.recordingReport);
router.post("/calls/:callId/answers", internal.saveAnswer);
router.post("/errors", internal.reportError);
router.post("/leads", internal.reportLead);
export default router;
