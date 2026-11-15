// No plan, no Studio. Everything behind a session is refused with 402 while the organization has no
// active plan, except what a person needs in order to choose one: who they are, the rate card, their
// billing page, their organizations (to switch to one that has a plan), their notifications.
import { BillingError, lockMessage } from "../models/Billing.js";

const OPEN = ["/me", "/billing", "/plans", "/orgs", "/notifications", "/avatars"];

export function requireSubscription(req, _res, next) {
  const plan = req.user?.billing;
  if (!plan?.locked) return next();
  if (OPEN.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();
  next(new BillingError(402, plan.reason, lockMessage(plan.reason)));
}
