const EVERY_MS = 250
const TRIES = 40

/**
 * A signal can overtake its sender's awareness on the same link, and until that
 * arrives the sender's client id cannot be told from a false one. So wait a little
 * before refusing: a request dropped at once would leave a student waiting for ever.
 */
export function whenClientKnown(clients: ReadonlySet<number>, client: number, then: () => void, tries = TRIES) {
  if (clients.has(client)) then()
  else if (tries > 1) setTimeout(() => whenClientKnown(clients, client, then, tries - 1), EVERY_MS)
}
