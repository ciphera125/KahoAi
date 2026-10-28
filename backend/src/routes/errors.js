import { Router } from "express";
import * as errors from "../controllers/errorController.js";

const router = Router();
router.get("/errors", errors.list);
export default router;
