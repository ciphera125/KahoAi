import { Router } from "express";
import * as tasks from "../controllers/taskController.js";
import { requirePermission } from "../middleware/auth.js";

const router = Router();
router.get("/tasks", tasks.list);
router.post("/tasks", requirePermission("contacts.edit"), tasks.create);
router.patch("/tasks/:taskId", requirePermission("contacts.edit"), tasks.update);
router.delete("/tasks/:taskId", requirePermission("contacts.edit"), tasks.remove);

// A key can write into the whole organization, so only an admin may make one.
router.get("/api-keys", requirePermission("keys.manage"), tasks.listKeys);
router.post("/api-keys", requirePermission("keys.manage"), tasks.createKey);
router.delete("/api-keys/:keyId", requirePermission("keys.manage"), tasks.revokeKey);
export default router;
