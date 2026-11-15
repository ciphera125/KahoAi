// Helpers shared by the admin tests: the admin site's browser and a signed-in admin.
import request from "supertest";
import { app } from "./helpers.js";

export const ADMIN_ORIGIN = "http://localhost:5174";
export const CODE = "test-admin-setup-code-0123456789";
export const PASSWORD = "a long admin passphrase";
export const AADITYA = "adityanair5002@gmail.com";
export const AYUSHI = "aayushimakker10@gmail.com";

/** The admin site's browser: its own origin and host, keeping its own cookie. */
export function adminBrowser() {
  const agent = request.agent(app);
  const wrap = (method) => (path) => agent[method](`/api/admin${path}`).set("Origin", ADMIN_ORIGIN).set("Host", "localhost:5174");
  return { get: wrap("get"), post: wrap("post"), patch: wrap("patch"), put: wrap("put"), delete: wrap("delete"), agent };
}
export async function signedInAdmin(email = AADITYA, name = "Aditya Nair") {
  const b = adminBrowser();
  const r = await b.post("/auth/signup").send({ name, email, password: PASSWORD, code: CODE });
  if (r.status !== 200) throw new Error(`admin signup failed: ${r.status} ${JSON.stringify(r.body)}`);
  b.admin = r.body;
  b.cookie = r.headers["set-cookie"].map((c) => c.split(";")[0]).join("; "); // what a copied or replayed cookie would be
  return b;
}
