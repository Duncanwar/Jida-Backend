import { Role } from "@prisma/client";

/**
 * Roles that a role confers automatically.
 *
 * A chief editor is "privileged to have all multiple roles of editor, reviewer
 * and author", so holding CHIEF_EDITOR alone is enough to reach every portal.
 * An associate editor gets the editor portal and nothing more — chief and
 * associate editors share one portal, they differ only in this implication set.
 */
const IMPLIED_ROLES: Partial<Record<Role, Role[]>> = {
  [Role.CHIEF_EDITOR]: [Role.EDITOR, Role.REVIEWER, Role.AUTHOR],
  [Role.ASSOCIATE_EDITOR]: [Role.EDITOR],
};

/** The editor tiers, i.e. every role that reaches the editor portal. */
export const EDITOR_ROLES: Role[] = [Role.EDITOR, Role.CHIEF_EDITOR, Role.ASSOCIATE_EDITOR];

/**
 * Expands a stored role list into everything those roles actually grant.
 * Authorization must always run against this, never the raw list, or a chief
 * editor would be locked out of the reviewer and author portals.
 */
export function expandRoles(roles: readonly Role[]): Role[] {
  const out = new Set<Role>();
  for (const role of roles) {
    out.add(role);
    for (const implied of IMPLIED_ROLES[role] ?? []) out.add(implied);
  }
  return [...out];
}

/** True when the holder's expanded roles intersect `required`. */
export function hasAnyRole(held: readonly Role[], required: readonly Role[]): boolean {
  const expanded = expandRoles(held);
  return required.some((r) => expanded.includes(r));
}

/**
 * Every role that, once expanded, grants `target`. Use it to build the Prisma
 * filter for "all accounts that can act as X":
 *
 *     where: { roles: { hasSome: storedRolesGranting(Role.REVIEWER) } }
 *
 * Filtering on the stored column alone would miss a chief editor, whose
 * reviewer rights are implied rather than stored.
 */
export function storedRolesGranting(target: Role): Role[] {
  return Object.values(Role).filter((r) => expandRoles([r]).includes(target));
}

/**
 * Reconciles the primary role with the full set. The primary role decides the
 * landing portal, so it must always be a member of the set; callers that only
 * supply one of the two still get a coherent pair.
 */
export function normalizeRoles(primary: Role, roles?: readonly Role[] | null): Role[] {
  const set = new Set<Role>(roles?.length ? roles : [primary]);
  set.add(primary);
  return [...set];
}

/**
 * Where a multi-role account lands after signing in. Ordered most- to
 * least-privileged so a chief editor who is also an author lands on the editor
 * portal rather than whichever role happens to sort first.
 */
const LANDING_PRECEDENCE: Role[] = [
  Role.ADMIN,
  Role.CHIEF_EDITOR,
  Role.ASSOCIATE_EDITOR,
  Role.EDITOR,
  Role.REVIEWER,
  Role.AUTHOR,
];

export function primaryRoleFor(roles: readonly Role[]): Role {
  return LANDING_PRECEDENCE.find((r) => roles.includes(r)) ?? Role.AUTHOR;
}
