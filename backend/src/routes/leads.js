import { Router } from "express";
import * as leads from "../controllers/leadController.js";

const router = Router();
router.get("/leads", leads.list);
export default router;
