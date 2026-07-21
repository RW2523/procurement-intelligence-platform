import "server-only";
import { getCurrentUser } from "@/lib/db/users";
import type { User, UserRole } from "@/lib/types";

/**
 * Role-based authorization for procurement. Roles are ranked; a guard for `min`
 * admits that role and anything higher. This is the enforced authorization layer —
 * the app queries the DB with the service-role client, so RLS is not the gate here;
 * these checks are. Every mutating server action / privileged route must call one.
 */
const RANK: Record<UserRole, number> = { viewer: 1, writer: 2, approver: 3, admin: 4 };

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/** Boolean check — for conditionally rendering controls in the UI. */
export function can(user: User | null, min: UserRole): boolean {
  return !!user && RANK[user.role] >= RANK[min];
}

/** Returns the signed-in procurement user, or throws if there is no procurement account. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    throw new AuthError("Not authorized: your login has no Procurement account.");
  }
  return user;
}

/** Returns the user if they hold at least `min`; otherwise throws. */
export async function requireRole(min: UserRole): Promise<User> {
  const user = await requireUser();
  if (RANK[user.role] < RANK[min]) {
    throw new AuthError(`Not authorized: this action requires the "${min}" role or higher.`);
  }
  return user;
}
