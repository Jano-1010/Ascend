import { addManualExercise, draftToSession, makeRow, type Draft, type DraftExercise, type Row } from "../domain/draft";
import { EXERCISES, UNIT_LABEL, exerciseDef } from "../domain/exercises";
import { fmtDate, fmtNum, fmtRest, fmtShortDate, parseNum } from "../domain/format";
import { focusLabel, locationById, locationLabel } from "../domain/locations";
import type { BlockType, ExerciseIndexEntry } from "../domain/types";
import { exercisePicker } from "./autocomplete";
import type { AppContext } from "./context";
import { append, clear, h } from "./dom";

const TYPE_LABEL: Record<BlockType, string> = { heavy: "Schwer", accessory: "Zusatz", metcon: "MetCon" };
const WEIGHT_STEP = 2.5;

function lastText(ex: DraftExercise, entry?: ExerciseIndexEntry): string {
  if (!entry) return "Noch keine Daten";
  const def = exerciseDef(ex.name);
  const unit = def ? UNIT_LABEL[def.unit] : "Wdh.";
  const amount = def && def.unit !== "reps" ? `${fmtNum(entry.lastReps)} ${unit}` : `× ${fmtNum(entry.lastReps)}`;
  const weight = !def || def.weighted ? `${fmtNum(entry.lastWeight)} kg ` : "";
  return `Zuletzt: ${weight}${amount} (${fmtShortDate(entry.lastDate)})`;
}

function prescription(ex: DraftExercise): string {
  const def = exerciseDef(ex.name);
  const unit = def && def.unit !== "reps" ? ` ${UNIT_LABEL[def.unit]}` : "";
  const reps = ex.prescribedReps ? ` × ${ex.prescribedReps}${unit}` : "";
  const rest = ex.restSec > 0 ? ` · Pause ${fmtRest(ex.restSec)}` : "";
  return `${ex.prescribedSets}${reps}${rest}`;
}

function rowEl(ctx: AppContext, ex: DraftExercise, row: Row, i: number, onWeight: (i: number, old: string) => void): HTMLElement {
  const weighted = exerciseDef(ex.name)?.weighted ?? true;
  const unit = UNIT_LABEL[exerciseDef(ex.name)?.unit ?? "reps"];
  const el = h("div", { class: `set-row${row.done ? " done" : ""}` });

  const select = (e: Event) => (e.target as HTMLInputElement).select();
  const weightInput = h("input", {
    class: "num",
    type: "text",
    inputmode: "decimal",
    enterkeyhint: "next",
    autocomplete: "off",
    value: row.weight,
    "aria-label": `Satz ${i + 1}, Gewicht in kg`,
    onfocus: select,
    oninput: (e: Event) => {
      const old = row.weight;
      row.weight = (e.target as HTMLInputElement).value;
      weightInput.classList.remove("invalid");
      onWeight(i, old);
      ctx.saveDraft();
    },
  });
  const repsInput = h("input", {
    class: "num",
    type: "text",
    inputmode: "numeric",
    enterkeyhint: "done",
    autocomplete: "off",
    value: row.reps,
    "aria-label": `Satz ${i + 1}, ${unit}`,
    onfocus: select,
    oninput: (e: Event) => {
      row.reps = (e.target as HTMLInputElement).value;
      repsInput.classList.remove("invalid");
      ctx.saveDraft();
    },
  });

  const step = (delta: number) => {
    const old = row.weight;
    row.weight = fmtNum(Math.max(0, (parseNum(row.weight) || 0) + delta));
    weightInput.value = row.weight;
    weightInput.classList.remove("invalid");
    onWeight(i, old);
    ctx.saveDraft();
  };

  const check = h("button", {
    type: "button",
    class: "check",
    "aria-label": `Satz ${i + 1} abhaken`,
    "aria-pressed": String(row.done),
    onclick: () => {
      if (!row.done && weighted && Number.isNaN(parseNum(row.weight))) {
        weightInput.classList.add("invalid");
        weightInput.focus();
        return;
      }
      if (!row.done && !(parseNum(row.reps) > 0)) {
        repsInput.classList.add("invalid");
        repsInput.focus();
        return;
      }
      row.done = !row.done;
      el.classList.toggle("done", row.done);
      check.setAttribute("aria-pressed", String(row.done));
      ctx.saveDraft();
    },
  }, "✓");

  el.append(
    h("span", { class: "set-no" }, String(i + 1)),
    weighted
      ? h(
          "div",
          { class: "weight" },
          h("button", { type: "button", class: "step", "aria-label": "Gewicht verringern", onclick: () => step(-WEIGHT_STEP) }, "−"),
          weightInput,
          h("button", { type: "button", class: "step", "aria-label": "Gewicht erhöhen", onclick: () => step(WEIGHT_STEP) }, "+"),
        )
      : h("span", {}),
    h("div", { class: "reps" }, repsInput),
    check,
  );
  return el;
}

function exerciseCard(ctx: AppContext, ex: DraftExercise, onRemove: () => void): HTMLElement {
  const def = exerciseDef(ex.name);
  const rowsEl = h("div", { class: "rows" });
  const headEl = h(
    "div",
    { class: "set-row head" },
    h("span", {}),
    h("span", { class: "unit" }, !def || def.weighted ? "kg" : ""),
    h("span", { class: "unit" }, UNIT_LABEL[def?.unit ?? "reps"]),
    h("span", {}),
  );
  // A changed weight carries over to the following open rows that still held the old value.
  const onWeight = (i: number, old: string) => {
    const value = ex.rows[i].weight;
    for (let j = i + 1; j < ex.rows.length; j++) {
      const r = ex.rows[j];
      if (r.done || r.weight !== old) continue;
      r.weight = value;
      const input = rowsEl.children[j]?.querySelector<HTMLInputElement>(".weight input");
      if (input) input.value = value;
    }
  };
  const renderRows = () => {
    clear(rowsEl);
    ex.rows.forEach((r, i) => rowsEl.append(rowEl(ctx, ex, r, i, onWeight)));
  };
  renderRows();

  const entry = ctx.state.index[ex.name];
  return h(
    "article",
    { class: "card exercise" },
    h(
      "header",
      {},
      h("div", {},
        h("h3", {}, ex.name),
        h("p", { class: "presc" }, prescription(ex)),
        ex.note ? h("p", { class: "note" }, ex.note) : null,
        h("p", { class: `last${entry ? "" : " none"}` }, lastText(ex, entry)),
      ),
      h("button", {
        type: "button",
        class: "icon-btn",
        "aria-label": `${ex.name} entfernen`,
        onclick: () => {
          if (ex.rows.some((r) => r.done) && !confirm("Übung samt abgehakten Sätzen entfernen?")) return;
          onRemove();
          ctx.saveDraft();
        },
      }, "✕"),
    ),
    headEl,
    rowsEl,
    h(
      "div",
      { class: "row-actions" },
      h("button", {
        type: "button",
        class: "secondary",
        onclick: () => {
          const prev = ex.rows[ex.rows.length - 1];
          ex.rows.push(prev ? { ...prev, done: false } : makeRow(ex, entry));
          renderRows();
          ctx.saveDraft();
        },
      }, "+ Satz"),
      h("button", {
        type: "button",
        class: "secondary",
        onclick: () => {
          if (ex.rows.length <= 1) return;
          ex.rows.pop();
          renderRows();
          ctx.saveDraft();
        },
      }, "− Satz"),
    ),
  );
}

export function renderSession(ctx: AppContext, draft: Draft): HTMLElement {
  const root = h("section", { class: "view" });

  const save = async () => {
    const session = draftToSession(draft);
    if (!session) {
      ctx.toast("Noch keine Sätze mit Wiederholungen eingetragen.");
      return;
    }
    await ctx.storage.putSession(session);
    await ctx.reloadSessions();
    ctx.state.draft = null;
    await ctx.storage.setMeta("draft", null);
    const entry = ctx.state.week[session.date];
    if (entry && entry.focus !== "rest") {
      delete ctx.state.week[session.date];
      await ctx.saveWeek();
    }
    ctx.toast("Einheit gespeichert.");
    ctx.navigate("history", session.id);
  };

  const discard = async () => {
    if (!confirm("Einheit verwerfen? Alle Eingaben gehen verloren.")) return;
    ctx.state.draft = null;
    await ctx.storage.setMeta("draft", null);
    ctx.navigate("training");
  };

  const blocksEl = h("div", {});
  const renderBlocks = () => {
    clear(blocksEl);
    for (const block of draft.blocks) {
      if (block.exercises.length === 0) continue;
      blocksEl.append(
        h("h2", { class: "block-title" }, block.name, h("span", { class: `badge ${block.type}` }, TYPE_LABEL[block.type])),
      );
      for (const ex of block.exercises) {
        blocksEl.append(
          exerciseCard(ctx, ex, () => {
            block.exercises.splice(block.exercises.indexOf(ex), 1);
            renderBlocks();
          }),
        );
      }
    }
  };
  renderBlocks();

  const pickerHost = h("div", {});
  const addBtn = h("button", {
    type: "button",
    class: "secondary wide",
    onclick: () => {
      if (pickerHost.firstChild) {
        clear(pickerHost);
        return;
      }
      const equipment = new Set<string>(locationById(draft.location).equipment);
      const items = EXERCISES.filter((d) => d.requires.every((r) => equipment.has(r)));
      pickerHost.append(
        exercisePicker(items, (def) => {
          addManualExercise(draft, def.name, ctx.state.index);
          clear(pickerHost);
          renderBlocks();
          ctx.saveDraft();
        }),
      );
      pickerHost.querySelector("input")?.focus();
    },
  }, "+ Übung hinzufügen");

  append(root, [
    h("h1", {}, focusLabel(draft.focus)),
    h("p", { class: "muted" }, `${fmtDate(draft.date)} · ${locationLabel(draft.location)} · ca. ${draft.estimatedMin} von ${draft.budgetMin} min`),
    draft.omitted.length > 0
      ? h("details", { class: "card omitted" }, h("summary", {}, `Weggelassen (${draft.omitted.length})`), h("ul", {}, ...draft.omitted.map((o) => h("li", {}, o))))
      : null,
    blocksEl,
    addBtn,
    pickerHost,
    h(
      "div",
      { class: "bottom-actions" },
      h("button", { type: "button", class: "primary big", onclick: save }, "Einheit speichern"),
      h("button", { type: "button", class: "link", onclick: discard }, "Verwerfen"),
    ),
  ]);
  return root;
}
