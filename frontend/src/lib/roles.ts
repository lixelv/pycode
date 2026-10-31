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
