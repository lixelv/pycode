import * as Y from "yjs"

import { docAccess, fileAccess, type Member, type Rules } from "@/lib/project/access"
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

/** All lines passed; a failing test worth nothing is still a failure, and no lines pass nothing. */
export const allPassed = (results: CheckResult[]) => results.length > 0 && results.every((r) => r.ok)

/**
 * The tables to show: by access, not by which documents exist (a student keeps the copy of a table
 * that became private). `opened` says the store has the document: rules can be a moment behind the store.
 */
export function readableTournaments(member: Member, rules: Rules, opened: (docId: string) => boolean): string[] {
  return Object.keys(rules.tournaments)
    .filter((id) => docAccess(member, `t:${id}`, rules) !== "none" && opened(`t:${id}`))
    .sort()
}

export const maxPoints = (results: CheckResult[]) => results.reduce((sum, r) => sum + (r.points ?? 0), 0)

/** What a run earned; null for a file without tests or with an error (its one line has no points), which earn no line in the table. */
export function entryOf(results: CheckResult[], name: string, at: number): TournamentEntry | null {
  if (!results.length || results.some((r) => r.points === undefined)) return null
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
  if (!Object.hasOwn(rules.files, solution) || !Object.hasOwn(rules.files, testFile)) return false
  return fileAccess(member, solution, rules) === "write" && fileAccess(member, testFile, rules) !== "write"
}

const MAX_NAME = 40

/** The name a student's awareness claims, as it goes into a document that stays: any JSON can be there. */
export function tableName(claimed: unknown, fallback: string): string {
  return typeof claimed === "string" && claimed.trim() ? claimed.slice(0, MAX_NAME) : fallback
}

/**
 * Puts a run into the table. `member` is who asked for it; null without a session, where it is
 * our own project. True if the run was refused: the student should know it did not count.
 */
export function recordCheck(
  doc: Y.Doc,
  results: CheckResult[],
  solution: string,
  testFile: string,
  who: { userId: string; name: string },
  member: Member | null,
  rules: Rules,
  at: number,
): boolean {
  const entry = entryOf(results, who.name, at)
  if (!entry) return false
  if (member && !mayRecord(member, solution, testFile, rules)) return true
  recordRun(doc, who.userId, taskOf(testFile), entry)
  return false
}
