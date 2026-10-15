import { exerciseDef } from "./exercises";
import { locationById } from "./locations";
import { DEFAULT_WORK_SEC, TEMPLATES, type Option, type Slot } from "./templates";
import type { Block, Exercise, FocusId, LocationId, Plan } from "./types";

/** Hints for picking varied exercises. Without them the first available option always wins. */
export interface Variety {
  /** How often an exercise was used lately (logged or planned). Less used is preferred. */
  recent?: ReadonlyMap<string, number>;
  /** Exercises of a plan that is being replaced; these are avoided so "shuffle" really changes something. */
  avoid?: ReadonlySet<string>;
}

/** Only the best few equipment-valid options compete, so variety never drops to a poor substitute. */
const VARIETY_POOL = 2;

function available(name: string, equipment: ReadonlySet<string>): boolean {
  const def = exerciseDef(name);
  if (!def) throw new Error(`Template references unknown exercise "${name}"`);
  return def.requires.every((r) => equipment.has(r));
}

function toExercise(slot: Slot, option: Option, substituteFor: string | null): Exercise {
  const isSubstitute = substituteFor !== null && slot.markSubstitute === true;
  const note = [
    isSubstitute ? undefined : slot.note,
    isSubstitute ? `Ersatz für ${substituteFor}` : undefined,
    option.note,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    name: option.name,
    prescribedSets: option.sets ?? slot.sets,
    prescribedReps: option.reps ?? slot.reps,
    restSec: slot.restSec,
    note,
    ...(option.targetKg !== undefined ? { targetKg: option.targetKg } : {}),
    sets: [],
  };
}

function slotMinutes(slot: Slot, option: Option): number {
  const sets = option.sets ?? slot.sets;
  const work = option.workSec ?? slot.workSec ?? DEFAULT_WORK_SEC;
  return (sets * (work + slot.restSec)) / 60;
}

function pickOption(slot: Slot, equipment: ReadonlySet<string>, used: ReadonlySet<string>, variety: Variety): Option | undefined {
  const pool = slot.options
    .filter((opt) => available(opt.name, equipment) && (slot.repeat || !used.has(opt.name)))
    .slice(0, VARIETY_POOL);
  // Variety must not swap a loaded lift for a bodyweight fallback; that only happens when nothing else is available.
  if (pool.length > 1 && exerciseDef(pool[0].name)?.weighted && !exerciseDef(pool[1].name)?.weighted) pool.length = 1;
  const score = (opt: Option) => (variety.recent?.get(opt.name) ?? 0) + (variety.avoid?.has(opt.name) ? 100 : 0);
  // Stable: the earlier (better) option wins a tie.
  return pool.reduce<Option | undefined>((best, opt) => (best === undefined || score(opt) < score(best) ? opt : best), undefined);
}

interface Candidate {
  block: Block;
  priority: number;
  order: number;
  minutes: number;
}

/**
 * Builds a plan from the templates. Hard rule: only exercises whose equipment is fully available at the
 * location are ever picked. Blocks are then chosen by priority until the time budget is used up.
 */
export function generatePlan(location: LocationId, focus: FocusId, budgetMin: number, variety: Variety = {}): Plan {
  const equipment = new Set<string>(locationById(location).equipment);
  const used = new Set<string>();
  const omitted: string[] = [];
  const candidates: Candidate[] = [];

  TEMPLATES[focus].forEach((tpl, order) => {
    const exercises: Exercise[] = [];
    let minutes = 0;
    for (const slot of tpl.slots) {
      const pick = pickOption(slot, equipment, used, variety);
      if (!pick) {
        omitted.push(`${slot.options[0].name}: nicht verfügbar (Equipment)`);
        continue;
      }
      if (!slot.repeat) used.add(pick.name);
      exercises.push(toExercise(slot, pick, pick === slot.options[0] ? null : slot.options[0].name));
      minutes += slotMinutes(slot, pick);
    }
    if (exercises.length === 0) {
      omitted.push(`${tpl.name}: kein passendes Equipment`);
      return;
    }
    candidates.push({
      block: { name: tpl.name, type: tpl.type, exercises },
      priority: tpl.priority,
      order,
      minutes: tpl.fixedMin ?? Math.ceil(minutes),
    });
  });

  const chosen = new Set<Candidate>();
  let total = 0;
  for (const c of [...candidates].sort((a, b) => a.priority - b.priority || a.order - b.order)) {
    if (total + c.minutes <= budgetMin) {
      chosen.add(c);
      total += c.minutes;
    } else {
      omitted.push(`${c.block.name}: passt nicht ins Zeitbudget (${c.minutes} min)`);
    }
  }

  return {
    location,
    focus,
    budgetMin,
    blocks: candidates.filter((c) => chosen.has(c)).map((c) => c.block),
    estimatedMin: total,
    omitted,
  };
}
