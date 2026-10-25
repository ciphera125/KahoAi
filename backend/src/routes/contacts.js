import { Router } from "express";
import * as contacts from "../controllers/contactController.js";
import { requireAdmin } from "../middleware/auth.js";

const router = Router();
router.get("/contacts", contacts.list);
router.get("/contacts/lookup", contacts.lookup);
router.post("/contacts", contacts.create);
router.post("/contacts/delete", requireAdmin, contacts.removeMany);
router.patch("/contacts/:contactId", contacts.update);
router.delete("/contacts/:contactId", contacts.remove);
router.post("/contacts/:contactId/numbers", contacts.addNumber);
router.patch("/contacts/:contactId/numbers/:numberId", contacts.updateNumber);
router.delete("/contacts/:contactId/numbers/:numberId", contacts.removeNumber);
router.get("/tags", contacts.listTags);
router.post("/tags", contacts.createTag);
router.patch("/tags/:tagId", contacts.updateTag);
router.delete("/tags/:tagId", contacts.removeTag);
export default router;
