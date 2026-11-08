import { Router } from "express";
import * as contacts from "../controllers/contactController.js";
import { requirePermission } from "../middleware/auth.js";

const router = Router();
router.get("/contacts", contacts.list);
router.get("/contacts/lookup", contacts.lookup);
router.post("/contacts", requirePermission("contacts.edit"), contacts.create);
router.post("/contacts/delete", requirePermission("contacts.delete"), contacts.removeMany);
router.patch("/contacts/:contactId", requirePermission("contacts.edit"), contacts.update);
router.delete("/contacts/:contactId", requirePermission("contacts.delete"), contacts.remove);
router.post("/contacts/:contactId/numbers", requirePermission("contacts.edit"), contacts.addNumber);
router.patch("/contacts/:contactId/numbers/:numberId", requirePermission("contacts.edit"), contacts.updateNumber);
router.delete("/contacts/:contactId/numbers/:numberId", requirePermission("contacts.edit"), contacts.removeNumber);
router.get("/tags", contacts.listTags);
router.post("/tags", requirePermission("contacts.edit"), contacts.createTag);
router.patch("/tags/:tagId", requirePermission("contacts.edit"), contacts.updateTag);
router.delete("/tags/:tagId", requirePermission("contacts.delete"), contacts.removeTag);
export default router;
