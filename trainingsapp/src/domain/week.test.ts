import { describe, expect, it } from "vitest";
import {
  addDays,
  buildDayPlan,
  conflicts,
  dayInfo,
  focusLookup,
  recentUsage,
  suggestDay,
  suggestWeek,
  weekStart,
  type DayFocus,
  type WeekPlan,
} from "./week";
import type { Session } from "./types";

const lookup =
  (m: Record<string, DayFocus>) =>
  (d: string): DayFocus | undefined =>
    m[d];

// 2026-10-05 is a Monday.
const MON = "2026-10-05";

describe("dates", () => {
  it("finds Monday of a week", () => {
    expect(weekStart("2026-10-11")).toBe(MON);
    expect(weekStart(MON)).toBe(MON);
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
  });
});

describe("conflicts", () => {
  it("blocks the same region on consecutive days", () => {
    const f = lookup({ [MON]: "lower" });
    expect(conflicts(addDays(MON, 1), "lower", f).length).toBeGreaterThan(0);
    expect(conflicts(addDays(MON, 1), "upper", f)).toEqual([]);
  });

  it("allows the same region after a rest day", () => {
    const f = lookup({ [MON]: "lower" });
    expect(conflicts(addDays(MON, 2), "lower", f)).toEqual([]);
  });

  it("blocks ATHX after endurance and full after upper", () => {
    expect(conflicts(addDays(MON, 1), "athx", lookup({ [MON]: "endurance" })).length).toBeGreaterThan(0);
    expect(conflicts(addDays(MON, 1), "full", lookup({ [MON]: "upper" })).length).toBeGreaterThan(0);
  });

  it("demands a rest day after three in a row", () => {
    const f = lookup({ [MON]: "upper", [addDays(MON, 1)]: "lower", [addDays(MON, 2)]: "upper" });
    const reasons = conflicts(addDays(MON, 3), "endurance", f);
    expect(reasons.some((r) => r.includes("Ruhetag"))).toBe(true);
  });

  it("caps the week at five sessions", () => {
    const f = lookup({
      [MON]: "upper",
      [addDays(MON, 2)]: "lower",
      [addDays(MON, 3)]: "athx",
      [addDays(MON, 4)]: "endurance",
      [addDays(MON, 5)]: "full",
    });
    expect(conflicts(addDays(MON, 6), "upper", f).some((r) => r.includes("mehr als"))).toBe(true);
  });

  it("looks across the week boundary", () => {
    const f = lookup({ "2026-10-04": "lower" });
    expect(conflicts(MON, "lower", f).length).toBeGreaterThan(0);
  });
});

describe("suggestions", () => {
  it("builds a four-session week that never breaks the rules", () => {
    const s = suggestWeek(MON, lookup({}), 4);
    const days = Object.entries(s);
    expect(days).toHaveLength(7);
    const all = lookup(s);
    for (const [d, f] of days) {
      if (f !== "rest") expect(conflicts(d, f, (x) => (x === d ? undefined : all(x)))).toEqual([]);
    }
    const trained = days.filter(([, f]) => f !== "rest").map(([, f]) => f);
    expect(trained.sort()).toEqual(["athx", "endurance", "lower", "upper"]);
  });

  it("builds on what was already trained", () => {
    const f = lookup({ [MON]: "lower" });
    const s = suggestWeek(addDays(MON, 1), f, 4);
    expect(s[addDays(MON, 1)]).toBe("upper");
    expect(Object.values(s)).not.toContain("full");
  });

  it("suggests rest once the target is met", () => {
    const f = lookup({
      [MON]: "upper",
      [addDays(MON, 1)]: "lower",
      [addDays(MON, 3)]: "athx",
    });
    expect(suggestDay(addDays(MON, 5), f, 3)).toBe("rest");
  });

  it("keeps already planned days", () => {
    const f = lookup({ [MON]: "rest" });
    expect(suggestWeek(MON, f, 4)[MON]).toBeUndefined();
  });
});

describe("dayInfo", () => {
  const session = (date: string, focus: Session["focus"]): Session => ({
    id: date,
    date,
    startedAt: `${date}T10:00:00.000Z`,
    location: "gym_full",
    focus,
    durationMin: 40,
    blocks: [],
  });

  it("prefers a logged session over the plan", () => {
    const plan: WeekPlan = { [MON]: { focus: "upper", done: false } };
    expect(dayInfo(MON, [session(MON, "lower")], plan)).toEqual({ focus: "lower", done: true });
    expect(dayInfo(MON, [], plan)).toEqual({ focus: "upper", done: false });
    expect(focusLookup([], plan)(addDays(MON, 1))).toBeUndefined();
  });

  it("never counts a rest day as done", () => {
    expect(dayInfo(MON, [], { [MON]: { focus: "rest", done: true } }).done).toBe(false);
  });
});

describe("saved trainings", () => {
  const names = (p: ReturnType<typeof buildDayPlan>) => p.blocks.flatMap((b) => b.exercises.map((e) => e.name));

  it("counts exercises of nearby saved plans but not the day itself", () => {
    const monday = buildDayPlan(MON, "upper", "gym_full", 60, [], {});
    const plan: WeekPlan = {
      [MON]: { focus: "upper", done: false, plan: monday },
      [addDays(MON, 3)]: { focus: "upper", done: false },
    };
    const usage = recentUsage(addDays(MON, 3), [], plan);
    expect(usage.get(names(monday)[0])).toBe(1);
    expect(recentUsage(MON, [], plan).size).toBe(0);
  });

  it("varies a second upper-body day against the first", () => {
    const first = buildDayPlan(MON, "upper", "gym_full", 60, [], {});
    const plan: WeekPlan = { [MON]: { focus: "upper", done: false, plan: first } };
    const second = buildDayPlan(addDays(MON, 3), "upper", "gym_full", 60, [], plan);
    expect(names(second)).not.toEqual(names(first));
  });

  it("ignores saved plans of days that were logged as a session", () => {
    const first = buildDayPlan(MON, "upper", "gym_full", 60, [], {});
    const logged = {
      id: "x", date: MON, startedAt: `${MON}T10:00:00.000Z`, location: "gym_full", focus: "upper", durationMin: 40,
      blocks: [{ name: "b", type: "heavy", exercises: [{ name: "Klimmzüge", prescribedSets: 3, prescribedReps: "5", restSec: 60, note: "", sets: [{ weightKg: 0, reps: 5 }] }] }],
    } as Session;
    const usage = recentUsage(addDays(MON, 2), [logged], { [MON]: { focus: "upper", done: false, plan: first } });
    expect([...usage.keys()]).toEqual(["Klimmzüge"]);
  });
});
