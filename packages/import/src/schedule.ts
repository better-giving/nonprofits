import { NEVER_BUILT, type ServedPointer } from "@nonprofits/db";

/** The UTC day of the month from which an unpublished month is a miss worth an alert. */
export const ALERT_DAY = 5;

/** `YYYY-MM` of a UTC ISO timestamp (`switched_at`'s format), or null when it isn't one. */
function utcMonth(iso: string): string | null {
  return /^\d{4}-\d{2}(?=-\d{2}T)/.exec(iso)?.[0] ?? null;
}

/** Whether the served build was switched to in the UTC month `now` is in; a never-built pointer was not. */
export function importedThisMonth(pointer: ServedPointer, now: Date): boolean {
  if (pointer.build_id === NEVER_BUILT) return false;
  const switched = utcMonth(pointer.switched_at);
  return switched !== null && switched === now.toISOString().slice(0, 7);
}

/** What a run does at its start. */
export interface ScheduleCheck {
  /** false when the month is published and `force` is off: the import step is skipped */
  proceed: boolean;
  /** A single-line message to flag a miss with, or "" when there is none. */
  alert: string;
  /** One line for the run's summary. */
  summary: string;
}

/**
 * The start of every run: skips the import once this month's build is live
 * (unless `force`), and words an alert when it is the `ALERT_DAY`th or later
 * (UTC) with nothing published.
 */
export function checkSchedule(
  pointer: ServedPointer,
  now: Date,
  force: boolean,
): ScheduleCheck {
  const imported = importedThisMonth(pointer, now);
  const month = now.toISOString().slice(0, 7);
  const overdue = !imported && now.getUTCDate() >= ALERT_DAY;
  const alert = overdue
    ? `No build was switched in ${month} by the ${ALERT_DAY}th (UTC); serving build ${pointer.build_id}, switched ${pointer.switched_at}. The catch-up run is importing now.`
    : "";
  if (imported && !force) {
    return {
      proceed: false,
      alert,
      summary: `already imported ${pointer.build_id}`,
    };
  }
  return {
    proceed: true,
    alert,
    summary: imported
      ? `forced: ${pointer.build_id} is already this month's build`
      : `importing: serving build ${pointer.build_id}, switched ${pointer.switched_at}`,
  };
}

/** The `key=value` lines GitHub Actions reads from `$GITHUB_OUTPUT`; a value is one line. */
export function outputLines(check: ScheduleCheck): string {
  const oneLine = (text: string) => text.replace(/[\r\n]+/g, " ");
  return `proceed=${check.proceed}\nalert=${oneLine(check.alert)}\n`;
}
