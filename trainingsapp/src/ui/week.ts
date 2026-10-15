import { createDraft } from "../domain/draft";
import { fmtShortDate, localDate } from "../domain/format";
import { BUDGETS, FOCI, LOCATIONS, focusLabel, locationLabel } from "../domain/locations";
import { isoWeek } from "../domain/stats";
import type { LocationId, Plan } from "../domain/types";
import {
  MAX_WEEK_SESSIONS,
  MIN_WEEK_SESSIONS,
  addDays,
  buildDayPlan,
  conflicts,
  dayInfo,
  focusLookup,
  isTraining,
  suggestWeek,
  weekDates,
  weekStart,
  weekSummary,
  type DayEntry,
  type DayFocus,
} from "../domain/week";
import type { AppContext } from "./context";
import { clear, h } from "./dom";

const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const WEEKDAYS_FULL = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const ABBR: Record<DayFocus, string> = { upper: "OK", lower: "UK", full: "GK", athx: "ATHX", endurance: "AUS", rest: "Ruhe" };
const dayLabel = (f: DayFocus) => (f === "rest" ? "Ruhetag" : focusLabel(f));

const ICON = (path: string, size = 20, stroke = 1.5) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const CHEVRON_LEFT = '<path d="m15 18-6-6 6-6"></path>';
const CHEVRON_RIGHT = '<path d="m9 18 6-6-6-6"></path>';
const CHECK = '<path d="M20 6 9 17l-5-5"></path>';

/** Remembered while the app is open. */
const view: { start?: string; selected?: string } = {};

/** Jumps back to the current week with today selected. */
export function resetWeekView(): void {
  view.start = undefined;
  view.selected = undefined;
}

function chipGroup<T extends string | number>(
  label: string,
  options: { id: T; label: string }[],
  selected: T | undefined,
  onSelect: (id: T) => void,
  small = false,
): HTMLElement {
  return h(
    "div",
    { class: "wk-group" },
    h("div", { class: "wk-label" }, label),
    h(
      "div",
      { class: "wk-chips" },
      ...options.map((o) =>
        h(
          "button",
          { type: "button", class: `wk-chip${small ? " small" : ""}`, "aria-pressed": String(o.id === selected), onclick: () => onSelect(o.id) },
          o.label,
        ),
      ),
    ),
  );
}

const repsText = (reps: string) => (reps ? ` × ${reps}` : "");

/** The saved training of a day: blocks and exercises, plus a button to get a different mix. */
function planCard(plan: Plan, onShuffle?: () => void): HTMLElement {
  const card = h(
    "div",
    { class: "wk-plan" },
    h("div", { class: "wk-label" }, `Training · ca. ${plan.estimatedMin} min`),
    ...plan.blocks.map((b) =>
      h(
        "div",
        { class: "wk-block" },
        h("div", { class: "wk-block-name" }, b.name),
        h("ul", {}, ...b.exercises.map((e) => h("li", {}, `${e.name} · ${e.prescribedSets}${repsText(e.prescribedReps)}`))),
      ),
    ),
  );
  if (onShuffle) card.append(h("button", { type: "button", class: "wk-btn", onclick: onShuffle }, "Neu mischen"));
  return card;
}

function parseDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function renderWeek(ctx: AppContext): HTMLElement {
  const { state } = ctx;
  const today = localDate(new Date());
  view.start ??= weekStart(today);
  view.selected ??= today;
  const root = h("section", { class: "view wk" });

  const target = () => state.prefs.sessionsPerWeek;
  const focusOf = () => focusLookup(state.sessions, state.week);
  const savePrefs = () => ctx.storage.setMeta("prefs", state.prefs);
  /** First day suggestions are made for: today inside the current week, else the week start. */
  const suggestFrom = (start: string) => (start <= today && today < addDays(start, 7) ? today : start);

  /** The saved training of a day is rebuilt when its focus, place or length changes. */
  function makePlan(date: string, entry: DayEntry, replacing?: Plan): Plan | undefined {
    if (!isTraining(entry.focus)) return undefined;
    return buildDayPlan(
      date,
      entry.focus,
      entry.location ?? state.prefs.location,
      entry.budgetMin ?? state.prefs.budgetMin,
      state.sessions,
      state.week,
      replacing,
    );
  }

  async function patchEntry(date: string, patch: Partial<DayEntry> | null) {
    if (patch === null) delete state.week[date];
    else {
      const base: DayEntry = state.week[date] ?? { focus: "rest", done: false };
      const entry: DayEntry = { ...base, ...patch };
      const changed = "focus" in patch || "location" in patch || "budgetMin" in patch;
      delete entry.plan;
      state.week[date] = entry;
      if (!changed && base.plan) entry.plan = base.plan;
      else {
        const plan = makePlan(date, entry);
        if (plan) entry.plan = plan;
      }
    }
    await ctx.saveWeek();
    draw();
  }

  async function shuffle(date: string) {
    const entry = state.week[date];
    if (!entry) return;
    const plan = makePlan(date, entry, entry.plan);
    if (plan) entry.plan = plan;
    await ctx.saveWeek();
    draw();
  }

  async function planWeek() {
    const result = suggestWeek(suggestFrom(view.start!), focusOf(), target());
    // Day by day, so each saved training counts for the variety of the next one.
    for (const [date, focus] of Object.entries(result).sort(([a], [b]) => a.localeCompare(b))) {
      const entry: DayEntry = { focus, done: false };
      state.week[date] = entry;
      const plan = makePlan(date, entry);
      if (plan) entry.plan = plan;
    }
    await ctx.saveWeek();
    ctx.toast(Object.keys(result).length === 0 ? "Alle Tage sind schon belegt." : "Woche geplant. Tage antippen zum Ändern.");
    draw();
  }

  function startTraining(date: string, focus: DayFocus) {
    if (!isTraining(focus)) return;
    const entry = state.week[date];
    const plan = entry?.plan ?? (entry ? makePlan(date, entry) : undefined);
    if (!plan || plan.blocks.length === 0) {
      ctx.toast("Für diese Auswahl gibt es keinen passenden Plan. Anderen Ort oder mehr Zeit wählen.");
      return;
    }
    state.draft = createDraft(plan, state.index, new Date(`${date}T12:00:00`));
    ctx.saveDraft();
    ctx.navigate("training");
  }

  function detail(date: string, suggestion: DayFocus | undefined): HTMLElement {
    const info = dayInfo(date, state.sessions, state.week);
    const logged = state.sessions.filter((s) => s.date === date).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const entry = state.week[date];
    const d = parseDate(date);
    const sugg = info.focus === undefined && suggestion !== undefined ? suggestion : undefined;
    const kicker =
      date === today ? "Heute" : sugg ? `Vorschlag: ${dayLabel(sugg)}` : info.done ? "Erledigt" : WEEKDAYS_FULL[(d.getDay() + 6) % 7];
    const el = h(
      "div",
      { class: "wk-detail" },
      h(
        "div",
        {},
        h("div", { class: "wk-kicker" }, kicker),
        h("div", { class: "wk-title" }, `${WEEKDAYS_FULL[(d.getDay() + 6) % 7]}, ${d.getDate()}. ${MONTHS[d.getMonth()]}`),
      ),
    );

    if (logged) {
      el.append(
        h("div", { class: "wk-done-note" }, `Erledigt · ${dayLabel(logged.focus)} · ${logged.durationMin} min im ${locationLabel(logged.location)}`),
        h("div", { class: "wk-actions" }, h("button", { type: "button", class: "wk-btn", onclick: () => ctx.navigate("history", logged.id) }, "Im Verlauf ansehen")),
      );
      return el;
    }

    const past = date < today;
    const options = [...FOCI.map((f) => ({ id: f.id as DayFocus, label: f.label })), { id: "rest" as DayFocus, label: "Ruhetag" }];
    el.append(
      chipGroup(past ? "Was hast du trainiert?" : "Training", options, info.focus, (f) =>
        void patchEntry(date, { focus: f, done: false }),
      ),
    );

    if (isTraining(info.focus) && !info.done) {
      const reasons = conflicts(date, info.focus, focusOf());
      if (reasons.length > 0) {
        el.append(h("div", { class: "wk-warn" }, `Übertrainings-Risiko: ${reasons.join("; ")}.`));
      }
      {
        const loc = entry?.location ?? state.prefs.location;
        const dur = entry?.budgetMin ?? state.prefs.budgetMin;
        el.append(
          h(
            "div",
            { class: "wk-two" },
            chipGroup("Ort", LOCATIONS.map((l) => ({ id: l.id as LocationId, label: l.label })), loc, (id) => {
              state.prefs.location = id;
              void savePrefs();
              void patchEntry(date, { location: id });
            }, true),
            chipGroup("Dauer", BUDGETS.map((b) => ({ id: b as number, label: `${b} min` })), dur, (id) => {
              state.prefs.budgetMin = id;
              void savePrefs();
              void patchEntry(date, { budgetMin: id });
            }, true),
          ),
        );
      }
    }

    if (isTraining(info.focus) && entry) {
      if (!entry.plan) {
        // Entries from before saved trainings existed get theirs on first view.
        const plan = makePlan(date, entry);
        if (plan) {
          entry.plan = plan;
          void ctx.saveWeek();
        }
      }
      if (entry.plan) el.append(planCard(entry.plan, info.done ? undefined : () => void shuffle(date)));
    }

    if (info.done) {
      el.append(h("div", { class: "wk-done-note" }, `Erledigt · ${dayLabel(info.focus!)}`));
    }

    const actions = h("div", { class: "wk-actions" });
    if (sugg && sugg !== "rest") {
      actions.append(h("button", { type: "button", class: "wk-btn primary", onclick: () => void patchEntry(date, { focus: sugg, done: false }) }, "Vorschlag übernehmen"));
    } else if (sugg === "rest") {
      actions.append(h("button", { type: "button", class: "wk-btn primary", onclick: () => void patchEntry(date, { focus: "rest", done: false }) }, "Vorschlag übernehmen"));
    }
    if (isTraining(info.focus) && !info.done) {
      if (date <= today) {
        actions.append(h("button", { type: "button", class: "wk-btn primary", onclick: () => startTraining(date, info.focus!) }, date === today ? `${dayLabel(info.focus!)} starten` : `${dayLabel(info.focus!)} erfassen`));
        actions.append(h("button", { type: "button", class: "wk-btn", onclick: () => void patchEntry(date, { done: true }) }, "Ohne Details als gemacht markieren"));
      }
    }
    if (info.focus !== undefined) {
      actions.append(
        info.done
          ? h("button", { type: "button", class: "wk-btn ghost", onclick: () => void patchEntry(date, { done: false }) }, "Als offen markieren")
          : h("button", { type: "button", class: "wk-btn ghost", onclick: () => void patchEntry(date, null) }, "Tag leeren"),
      );
    }
    if (actions.childElementCount > 0) el.append(actions);
    return el;
  }

  function draw() {
    clear(root);
    const start = view.start!;
    const dates = weekDates(start);
    const lookup = focusOf();
    const suggestions = suggestWeek(suggestFrom(start), lookup, target());
    const summary = weekSummary(start, lookup, (d) => dayInfo(d, state.sessions, state.week).done);
    const goal = target();

    root.append(
      h(
        "div",
        { class: "wk-head" },
        h(
          "div",
          {},
          h("div", { class: "wk-kicker" }, `KW ${isoWeek(start)} · ${fmtShortDate(start)} – ${fmtShortDate(addDays(start, 6))}`),
          h("h1", { class: "wk-h1" }, "Wochenplan"),
        ),
        h(
          "div",
          { class: "wk-arrows" },
          h("button", { type: "button", class: "wk-today", onclick: () => { view.start = weekStart(today); view.selected = today; draw(); } }, "Heute"),
          h("button", { type: "button", class: "wk-icon", "aria-label": "Vorherige Woche", innerHTML: ICON(CHEVRON_LEFT), onclick: () => { view.start = addDays(start, -7); draw(); } }),
          h("button", { type: "button", class: "wk-icon", "aria-label": "Nächste Woche", innerHTML: ICON(CHEVRON_RIGHT), onclick: () => { view.start = addDays(start, 7); draw(); } }),
        ),
      ),
    );

    const grid = h("div", { class: "wk-grid" });
    dates.forEach((date, i) => {
      const info = dayInfo(date, state.sessions, state.week);
      const sugg = info.focus === undefined && date >= today ? suggestions[date] : undefined;
      const shown = info.focus ?? sugg;
      const empty = info.focus === undefined;
      const entry = state.week[date];
      const logged = state.sessions.find((s) => s.date === date);
      const minutes = logged ? logged.durationMin : entry?.budgetMin ?? state.prefs.budgetMin;
      const selected = view.selected === date;
      const warn = isTraining(info.focus) && !info.done && conflicts(date, info.focus, lookup).length > 0;
      grid.append(
        h(
          "button",
          {
            type: "button",
            class: "wk-col",
            "aria-pressed": String(selected),
            "aria-label": `${WEEKDAYS_FULL[i]} ${parseDate(date).getDate()}.${shown ? ` ${dayLabel(shown)}` : ""}${info.done ? ", erledigt" : ""}`,
            onclick: () => {
              view.selected = date;
              draw();
            },
          },
          h("span", { class: "wk-wd" }, WEEKDAYS[i]),
          h("span", { class: `wk-date${date === today ? " today" : ""}` }, String(parseDate(date).getDate())),
          h(
            "span",
            { class: `wk-tile${selected ? " selected" : ""}${info.done ? " done" : ""}${empty ? " dashed" : ""}${shown === "rest" ? " rest" : ""}` },
            h("span", { class: "wk-abbr" }, shown ? ABBR[shown] : "+"),
            h("span", { class: "wk-dur" }, isTraining(shown) ? `${minutes}′` : ""),
            h("span", { class: "wk-mark", innerHTML: info.done ? ICON(CHECK, 16, 1.75) : warn ? "⚠" : "" }),
          ),
        ),
      );
    });
    root.append(grid);

    root.append(
      h(
        "div",
        { class: "wk-progress" },
        h("div", { class: "wk-ticks" }, ...Array.from({ length: goal }, (_, j) => h("span", { class: `wk-tick${j < summary.done ? " on" : ""}` }))),
        h("span", { class: "wk-small" }, `${summary.done} von ${summary.sessions} erledigt · Ziel ${goal}`),
      ),
      h("hr", { class: "wk-hr" }),
      detail(view.selected!, suggestions[view.selected!]),
      h("hr", { class: "wk-hr" }),
      h(
        "div",
        { class: "wk-detail" },
        h("button", { type: "button", class: "wk-btn", onclick: () => void planWeek() }, "Woche automatisch planen"),
        h(
          "div",
          { class: "wk-row" },
          chipGroup(
          "Einheiten pro Woche",
          Array.from({ length: MAX_WEEK_SESSIONS - MIN_WEEK_SESSIONS + 1 }, (_, i) => ({ id: MIN_WEEK_SESSIONS + i, label: String(MIN_WEEK_SESSIONS + i) })),
          goal,
          (n) => {
            state.prefs.sessionsPerWeek = n;
            void savePrefs();
            draw();
          },
          true,
        ),
          h("button", { type: "button", class: "wk-btn danger", onclick: () => void resetWeek() }, "Zurücksetzen"),
        ),
      ),
    );
  }

  async function resetWeek() {
    const start = view.start!;
    const dates = weekDates(start);
    const hasPlan = dates.some((d) => state.week[d]);
    const logged = dates.filter((d) => state.sessions.some((s) => s.date === d)).length;
    if (!hasPlan) {
      ctx.toast(logged > 0 ? "Nichts zurückzusetzen. Gespeicherte Einheiten bleiben im Verlauf." : "Diese Woche ist schon leer.");
      return;
    }
    const note = logged > 0 ? " Gespeicherte Einheiten bleiben im Verlauf." : "";
    if (!confirm(`Wochenplan KW ${isoWeek(start)} zurücksetzen? Alle geplanten und markierten Tage werden geleert.${note}`)) return;
    for (const d of dates) delete state.week[d];
    await ctx.saveWeek();
    view.selected = suggestFrom(start);
    ctx.toast("Woche zurückgesetzt. Freie Tage zeigen wieder Vorschläge.");
    draw();
  }

  draw();
  return root;
}
