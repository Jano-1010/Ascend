import { exerciseDef } from "./exercises";
import { fmtNum, localDate, newId, parseNum } from "./format";
import type {
  BlockType,
  Exercise,
  ExerciseIndex,
  ExerciseIndexEntry,
  FocusId,
  LocationId,
  Plan,
  Session,
} from "./types";

/** One input row while training. Only rows with `done` become sets. */
export interface Row {
  weight: string;
  reps: string;
  done: boolean;
}

export interface DraftExercise extends Omit<Exercise, "sets"> {
  rows: Row[];
}

export interface DraftBlock {
  name: string;
  type: BlockType;
  exercises: DraftExercise[];
}

export interface Draft {
  id: string;
  date: string;
  startedAt: string;
  location: LocationId;
  focus: FocusId;
  budgetMin: number;
  estimatedMin: number;
  omitted: string[];
  blocks: DraftBlock[];
}

export const MANUAL_BLOCK = "Zusatz (manuell)";

function firstNumber(reps: string): string {
  const m = /^\d+/.exec(reps.trim());
  return m ? m[0] : "";
}

/** Prefill: last used values if there is history, else the competition target or the prescription. */
export function makeRow(ex: Pick<Exercise, "name" | "prescribedReps" | "targetKg">, entry?: ExerciseIndexEntry): Row {
  const weighted = exerciseDef(ex.name)?.weighted ?? true;
  const weight = !weighted
    ? ""
    : entry
      ? fmtNum(entry.lastWeight)
      : ex.targetKg !== undefined
        ? fmtNum(ex.targetKg)
        : "";
  const reps = entry ? String(entry.lastReps) : firstNumber(ex.prescribedReps);
  return { weight, reps, done: false };
}

export function toDraftExercise(ex: Exercise, index: ExerciseIndex): DraftExercise {
  const { sets: _sets, ...rest } = ex;
  const rows = Array.from({ length: ex.prescribedSets }, () => makeRow(ex, index[ex.name]));
  return { ...rest, rows };
}

export function createDraft(plan: Plan, index: ExerciseIndex, now = new Date()): Draft {
  return {
    id: newId(),
    date: localDate(now),
    startedAt: now.toISOString(),
    location: plan.location,
    focus: plan.focus,
    budgetMin: plan.budgetMin,
    estimatedMin: plan.estimatedMin,
    omitted: plan.omitted,
    blocks: plan.blocks.map((b) => ({
      name: b.name,
      type: b.type,
      exercises: b.exercises.map((e) => toDraftExercise(e, index)),
    })),
  };
}

export function addManualExercise(draft: Draft, name: string, index: ExerciseIndex): DraftExercise {
  let block = draft.blocks.find((b) => b.name === MANUAL_BLOCK);
  if (!block) {
    block = { name: MANUAL_BLOCK, type: "accessory", exercises: [] };
    draft.blocks.push(block);
  }
  const ex = toDraftExercise(
    { name, prescribedSets: 3, prescribedReps: "", restSec: 0, note: "", sets: [] },
    index,
  );
  block.exercises.push(ex);
  return ex;
}

export function doneSetCount(draft: Draft): number {
  return draft.blocks.reduce(
    (n, b) => n + b.exercises.reduce((m, e) => m + e.rows.filter((r) => r.done).length, 0),
    0,
  );
}

/** Converts the draft to a saved session. Only checked sets are kept; returns null if there are none. */
export function draftToSession(draft: Draft, now = new Date()): Session | null {
  const blocks = draft.blocks
    .map((b) => ({
      name: b.name,
      type: b.type,
      exercises: b.exercises
        .map(({ rows, ...ex }): Exercise => {
          const weighted = exerciseDef(ex.name)?.weighted ?? true;
          return {
            ...ex,
            sets: rows
              .filter((r) => r.done && parseNum(r.reps) > 0)
              .map((r) => ({
                weightKg: weighted ? Math.max(0, parseNum(r.weight) || 0) : 0,
                reps: parseNum(r.reps),
              })),
          };
        })
        .filter((e) => e.sets.length > 0),
    }))
    .filter((b) => b.exercises.length > 0);
  if (blocks.length === 0) return null;
  // A session logged for another day has no meaningful stopwatch, so use the planned length.
  const sameDay = localDate(now) === draft.date;
  const minutes = sameDay ? Math.round((now.getTime() - new Date(draft.startedAt).getTime()) / 60000) : draft.estimatedMin;
  return {
    id: draft.id,
    date: draft.date,
    startedAt: draft.startedAt,
    location: draft.location,
    focus: draft.focus,
    durationMin: Math.max(1, minutes),
    blocks,
  };
}
