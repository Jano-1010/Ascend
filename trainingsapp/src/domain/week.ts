import { localDate } from "./format";
import { generatePlan } from "./plan";
import type { FocusId, LocationId, Plan, Session } from "./types";

/** What a day holds in the weekly plan. "rest" is an explicit rest day. */
export type DayFocus = FocusId | "rest";

export interface DayEntry {
  focus: DayFocus;
  /** Trained without logging details (or confirmed afterwards). */
  done: boolean;
  /** Where and how long this day is planned. Falls back to the app defaults. */
  location?: LocationId;
  budgetMin?: number;
  /** The generated training for this day, saved so it stays the same when you come back. */
  plan?: Plan;
}

/** Keyed by YYYY-MM-DD. */
export type WeekPlan = Record<string, DayEntry>;

/** Looks up what is planned or done on a date. Used by all rules below. */
export type FocusOf = (date: string) => DayFocus | undefined;

export const MAX_SESSIONS_PER_WEEK = 5;
export const MAX_IN_A_ROW = 3;
/** A region counts as tired above this level; a session that loads it by `LOAD_MIN` or more is then blocked. */
const FATIGUE_LIMIT = 0.4;
const LOAD_MIN = 0.5;
const DECAY = 0.5;

type Region = "upper" | "lower" | "cardio";
const REGIONS: Region[] = ["upper", "lower", "cardio"];
const REGION_LABEL: Record<Region, string> = { upper: "Oberkörper", lower: "Beine", cardio: "Ausdauer" };

/** How hard each kind of session hits each region (0 to 1). */
const LOAD: Record<FocusId, Record<Region, number>> = {
  upper: { upper: 1, lower: 0, cardio: 0.2 },
  lower: { upper: 0, lower: 1, cardio: 0.2 },
  full: { upper: 0.8, lower: 0.8, cardio: 0.4 },
  athx: { upper: 0.8, lower: 0.8, cardio: 0.9 },
  endurance: { upper: 0.1, lower: 0.5, cardio: 1 },
};

/** Order in which sessions are added when the weekly target grows. Each entry builds on what came before. */
const WEEK_ORDER: FocusId[] = ["upper", "lower", "athx", "endurance", "full", "endurance"];

export const MIN_WEEK_SESSIONS = 3;
export const MAX_WEEK_SESSIONS = 6;

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return localDate(new Date(y, m - 1, d + n));
}

/** Monday of the week containing `date`. */
export function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dow = (new Date(y, m - 1, d).getDay() + 6) % 7;
  return addDays(date, -dow);
}

export function weekDates(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export const isTraining = (f: DayFocus | undefined): f is FocusId => f !== undefined && f !== "rest";

export interface DayInfo {
  focus: DayFocus | undefined;
  done: boolean;
}

/** Combines logged sessions and the manual plan. A logged session always wins. */
export function dayInfo(date: string, sessions: Session[], plan: WeekPlan): DayInfo {
  const logged = sessions.filter((s) => s.date === date).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (logged) return { focus: logged.focus, done: true };
  const entry = plan[date];
  return entry ? { focus: entry.focus, done: entry.done && entry.focus !== "rest" } : { focus: undefined, done: false };
}

export function focusLookup(sessions: Session[], plan: WeekPlan): FocusOf {
  return (date) => dayInfo(date, sessions, plan).focus;
}

/** Remaining tiredness per region at the start of `date`, from the three days before. */
export function fatigue(date: string, focusOf: FocusOf): Record<Region, number> {
  const f: Record<Region, number> = { upper: 0, lower: 0, cardio: 0 };
  for (let back = 1; back <= 3; back++) {
    const past = focusOf(addDays(date, -back));
    if (!isTraining(past)) continue;
    for (const r of REGIONS) f[r] += LOAD[past][r] * DECAY ** back;
  }
  return f;
}

/** Reasons why training `focus` on `date` risks overtraining. Empty means fine. */
export function conflicts(date: string, focus: FocusId, focusOf: FocusOf): string[] {
  const out: string[] = [];
  const tired = fatigue(date, focusOf);
  for (const r of REGIONS) {
    if (LOAD[focus][r] >= LOAD_MIN && tired[r] > FATIGUE_LIMIT) {
      out.push(`${REGION_LABEL[r]} ist noch nicht erholt`);
    }
  }
  let streak = 0;
  for (let back = 1; back <= MAX_IN_A_ROW; back++) {
    if (isTraining(focusOf(addDays(date, -back)))) streak++;
    else break;
  }
  if (streak >= MAX_IN_A_ROW) out.push(`bereits ${MAX_IN_A_ROW} Trainingstage in Folge, Ruhetag nötig`);
  const others = weekDates(weekStart(date)).filter((d) => d !== date && isTraining(focusOf(d))).length;
  if (others >= MAX_SESSIONS_PER_WEEK) out.push(`mehr als ${MAX_SESSIONS_PER_WEEK} Einheiten in dieser Woche`);
  return out;
}

/** Target mix for a week with `n` sessions, e.g. 4 gives upper, lower, ATHX, endurance. */
export function weekTarget(n: number): FocusId[] {
  return WEEK_ORDER.slice(0, Math.max(MIN_WEEK_SESSIONS, Math.min(MAX_WEEK_SESSIONS, n)));
}

/**
 * Picks the best session for `date`: the one still missing from the week's target mix that the body can take,
 * or "rest" if nothing fits.
 */
export function suggestDay(date: string, focusOf: FocusOf, sessionsPerWeek: number): DayFocus {
  const dates = weekDates(weekStart(date));
  const missing = [...weekTarget(sessionsPerWeek)];
  for (const d of dates) {
    if (d === date) continue;
    const f = focusOf(d);
    if (!isTraining(f)) continue;
    const i = missing.indexOf(f);
    if (i >= 0) missing.splice(i, 1);
    // A session outside the mix still uses up a slot.
    else missing.pop();
  }
  for (const f of missing) {
    if (conflicts(date, f, focusOf).length === 0) return f;
  }
  return "rest";
}

/**
 * Suggestions for all empty days from `from` to the end of that week. Each suggestion counts for the next ones,
 * so the days build on each other.
 */
export function suggestWeek(from: string, focusOf: FocusOf, sessionsPerWeek: number): Record<string, DayFocus> {
  const result: Record<string, DayFocus> = {};
  const withResult: FocusOf = (d) => focusOf(d) ?? result[d];
  for (const d of weekDates(weekStart(from))) {
    if (d < from || focusOf(d) !== undefined) continue;
    result[d] = suggestDay(d, withResult, sessionsPerWeek);
  }
  return result;
}

export interface WeekSummary {
  sessions: number;
  done: number;
  byFocus: Partial<Record<FocusId, number>>;
}

export function weekSummary(start: string, focusOf: FocusOf, isDone: (date: string) => boolean): WeekSummary {
  const s: WeekSummary = { sessions: 0, done: 0, byFocus: {} };
  for (const d of weekDates(start)) {
    const f = focusOf(d);
    if (!isTraining(f)) continue;
    s.sessions++;
    if (isDone(d)) s.done++;
    s.byFocus[f] = (s.byFocus[f] ?? 0) + 1;
  }
  return s;
}

/** Days around a date whose exercises count as "recent" when picking variety. */
const VARIETY_DAYS = 10;

/** How often each exercise appears in logged sessions and saved plans near `date` (the day itself excluded). */
export function recentUsage(date: string, sessions: Session[], plan: WeekPlan): Map<string, number> {
  const usage = new Map<string, number>();
  const bump = (names: Iterable<string>) => {
    for (const n of names) usage.set(n, (usage.get(n) ?? 0) + 1);
  };
  for (let off = -VARIETY_DAYS; off <= VARIETY_DAYS; off++) {
    if (off === 0) continue;
    const d = addDays(date, off);
    for (const s of sessions) {
      if (s.date === d) bump(s.blocks.flatMap((b) => b.exercises.filter((e) => e.sets.length > 0).map((e) => e.name)));
    }
    const saved = plan[d]?.plan;
    if (saved && !sessions.some((s) => s.date === d)) bump(saved.blocks.flatMap((b) => b.exercises.map((e) => e.name)));
  }
  return usage;
}

/** Generates the training for a day with variety against the days around it. Pass `replacing` to shuffle. */
export function buildDayPlan(
  date: string,
  focus: FocusId,
  location: LocationId,
  budgetMin: number,
  sessions: Session[],
  plan: WeekPlan,
  replacing?: Plan,
): Plan {
  const avoid = replacing ? new Set(replacing.blocks.flatMap((b) => b.exercises.map((e) => e.name))) : undefined;
  return generatePlan(location, focus, budgetMin, { recent: recentUsage(date, sessions, plan), ...(avoid ? { avoid } : {}) });
}
