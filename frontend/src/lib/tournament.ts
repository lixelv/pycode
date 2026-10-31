import * as Y from "yjs"

import { fileAccess, type Member, type Rules } from "@/lib/project/access"
import type { CheckResult, CheckTournament } from "@/workers/protocol"

/*
 * A tournament's table: one document `t:<id>`, written by admins only. Each
 * participant has one entry per task, the best run so far. A run stops at its
 * first failure, so the best run is the one that got furthest.
 */

export interface TournamentEntry {
  /** The participant's name when this was recorded. */
  name: string
  score: number
  /** All the points of the test file in this run. */
  max: number
  passed: string[]
  /** Date.now() of the admin who recorded it. */
  at: number
}

export interface Standing {
  userId: string
  name: string
  /** Task -> score. */
  scores: Record<string, number>
  total: number
  place: number
}

/** A check's tournament, as the check's result shows it. */
export type CheckTournamentInfo = CheckTournament & { max: number }

export const resultsOf = (doc: Y.Doc) => doc.getMap<TournamentEntry>("results")

/** The column of a test file: `a/ivan/tri.test.py` and `tri.test.py` are both `tri`. */
export function taskOf(testPath: string): string {
  return testPath.slice(testPath.lastIndexOf("/") + 1).replace(/\.test\.py$/, "")
}

export const maxPoints = (results: CheckResult[]) => results.reduce((sum, r) => sum + (r.points ?? 0), 0)

/** What a run earned; null for a file without tests, which earns no line in the table. */
export function entryOf(results: CheckResult[], name: string, at: number): TournamentEntry | null {
  if (!results.length) return null
  const passed = results.filter((r) => r.ok)
  return { name, score: maxPoints(passed), max: maxPoints(results), passed: passed.map((r) => r.name), at }
}

/** Keeps the best run: a new entry replaces the old one only with a strictly higher score. */
export function recordRun(doc: Y.Doc, userId: string, task: string, entry: TournamentEntry): boolean {
  const results = resultsOf(doc)
  const key = `${userId}/${task}`
  const old = results.get(key)
  if (old && entry.score <= old.score) return false
  results.set(key, entry)
  return true
}

/** By total score; of equal totals, whoever reached theirs earlier goes first. */
export function standings(results: Record<string, TournamentEntry>): Standing[] {
  const people = new Map<string, Standing & { last: number }>()
  for (const [key, entry] of Object.entries(results)) {
    const slash = key.indexOf("/")
    const userId = key.slice(0, slash)
    const person = people.get(userId) ?? { userId, name: entry.name, scores: {}, total: 0, place: 0, last: 0 }
    person.scores[key.slice(slash + 1)] = entry.score
    person.total += entry.score
    if (entry.at >= person.last) {
      person.last = entry.at
      person.name = entry.name
    }
    people.set(userId, person)
  }
  return [...people.values()]
    .sort((a, b) => b.total - a.total || a.last - b.last)
    .map(({ last: _last, ...person }, index) => ({ ...person, place: index + 1 }))
}

/** A run counts only for a solution its author may change, against tests they may not. */
export function mayRecord(member: Member, solution: string, testFile: string, rules: Rules): boolean {
  return fileAccess(member, solution, rules) === "write" && fileAccess(member, testFile, rules) !== "write"
}
