import { Router } from "express";
import * as tasks from "../controllers/taskController.js";
import { requireAdmin } from "../middleware/auth.js";

const router = Router();
router.get("/tasks", tasks.list);
router.post("/tasks", tasks.create);
router.patch("/tasks/:taskId", tasks.update);
router.delete("/tasks/:taskId", tasks.remove);

// A key can write into the whole organization, so only an admin may make one.
router.get("/api-keys", requireAdmin, tasks.listKeys);
router.post("/api-keys", requireAdmin, tasks.createKey);
router.delete("/api-keys/:keyId", requireAdmin, tasks.revokeKey);
export default router;
