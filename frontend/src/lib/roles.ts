import { translate, type MessageKey } from "@/lib/i18n"

export const BUILT_IN: Record<string, MessageKey> = {
  owner: "share.role.owner",
  admin: "share.role.admin",
  write: "share.role.write",
  read: "share.role.read",
}

/** A role's name for people: built-in roles translated, custom ones as named. */
export function roleLabel(role: string) {
  return BUILT_IN[role] ? translate(BUILT_IN[role]) : role
}

/** How a member is shown: Owner, or their level and custom roles ("Write · ivan, olga"). */
export function memberLabel(m: { level: string; roles: readonly string[]; owner?: boolean }, acting = false) {
  if (m.owner) return translate("share.role.owner")
  const level = acting ? translate("share.role.acting") : roleLabel(m.level)
  return m.roles.length ? `${level} · ${m.roles.join(", ")}` : level
}
