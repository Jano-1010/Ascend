import { describe, expect, it } from "vitest";
import { addManualExercise, createDraft, doneSetCount, draftToSession } from "./draft";
import { buildIndex } from "./exercise-index";
import { generatePlan } from "./plan";
import { parseNum } from "./format";
import type { Session } from "./types";

const earlier: Session = {
  id: "s0",
  date: "2026-09-28",
  startedAt: "2026-09-28T10:00:00.000Z",
  location: "gym_full",
  focus: "upper",
  durationMin: 50,
  blocks: [
    {
      name: "x",
      type: "heavy",
      exercises: [
        {
          name: "Bankdrücken (Langhantel)",
          prescribedSets: 4,
          prescribedReps: "5",
          restSec: 150,
          note: "",
          sets: [{ weightKg: 80, reps: 5 }],
        },
      ],
    },
  ],
};

describe("draft", () => {
  it("prefills last weight and reps from history, nothing invented without history", () => {
    const withHistory = createDraft(generatePlan("school_gym", "upper", 30), buildIndex([earlier]));
    const bench = withHistory.blocks[0].exercises[0];
    expect(bench.rows).toHaveLength(4);
    expect(bench.rows[0]).toEqual({ weight: "80", reps: "5", done: false });

    const fresh = createDraft(generatePlan("school_gym", "upper", 30), {});
    expect(fresh.blocks[0].exercises[0].rows[0]).toEqual({ weight: "", reps: "5", done: false });
  });

  it("uses the competition load as prefill only without history", () => {
    const draft = createDraft(generatePlan("gym_full", "athx", 60), {});
    const g2o = draft.blocks.flatMap((b) => b.exercises).find((e) => e.name === "DB Ground to Overhead")!;
    expect(g2o.rows[0].weight).toBe("20");
  });

  it("saves only checked sets and drops empty exercises and blocks", () => {
    const draft = createDraft(generatePlan("gym_full", "upper", 30), {});
    expect(draftToSession(draft)).toBeNull();
    const bench = draft.blocks[0].exercises[0];
    bench.rows[0] = { weight: "82,5", reps: "5", done: true };
    bench.rows[1] = { weight: "82,5", reps: "", done: true }; // no reps, ignored
    expect(doneSetCount(draft)).toBe(2);
    const session = draftToSession(draft, new Date(new Date(draft.startedAt).getTime() + 47 * 60000))!;
    expect(session.durationMin).toBe(47);
    expect(session.blocks).toHaveLength(1);
    expect(session.blocks[0].exercises).toHaveLength(1);
    expect(session.blocks[0].exercises[0].sets).toEqual([{ weightKg: 82.5, reps: 5 }]);
  });

  it("stores no weight for unweighted exercises", () => {
    const draft = createDraft(generatePlan("minimal", "upper", 30), {});
    const pushups = draft.blocks.flatMap((b) => b.exercises).find((e) => e.name === "Liegestütze")!;
    pushups.rows[0] = { weight: "99", reps: "20", done: true };
    const session = draftToSession(draft)!;
    expect(session.blocks[0].exercises[0].sets[0]).toEqual({ weightKg: 0, reps: 20 });
  });

  it("adds manual exercises to a single manual block", () => {
    const draft = createDraft(generatePlan("gym_full", "upper", 30), {});
    addManualExercise(draft, "Plank", {});
    addManualExercise(draft, "Sit-ups", {});
    expect(draft.blocks.filter((b) => b.name === "Zusatz (manuell)")).toHaveLength(1);
  });
});

describe("draftToSession duration", () => {
  it("uses the planned length for a session logged on another day", () => {
    const plan = generatePlan("gym_full", "upper", 45);
    const draft = createDraft(plan, {}, new Date("2026-10-05T12:00:00"));
    draft.blocks[0].exercises[0].rows[0].done = true;
    const session = draftToSession(draft, new Date("2026-10-09T18:00:00"))!;
    expect(session.date).toBe("2026-10-05");
    expect(session.durationMin).toBe(plan.estimatedMin);
  });
});

describe("parseNum", () => {
  it("accepts comma and dot, rejects empty", () => {
    expect(parseNum("82,5")).toBe(82.5);
    expect(parseNum("82.5")).toBe(82.5);
    expect(parseNum("")).toBeNaN();
  });
});
