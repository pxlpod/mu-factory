import { PUBLISH_TIMEZONE } from "@/config/factory";

/**
 * The UTC instant of `date` at `slot` in the publishing timezone, DST-correct.
 *
 * Two passes with Intl: guess the offset at the naive instant, then re-check at
 * the corrected instant — the second pass only differs across a DST switch,
 * where the first guess was taken on the wrong side of it.
 */
export function slotInstant(
  date: string,
  slot: { hour: number; minute: number },
  timeZone: string = PUBLISH_TIMEZONE,
): Date {
  const [y, m, d] = date.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d, slot.hour, slot.minute, 0);
  const first = naive - offsetMs(new Date(naive), timeZone);
  const second = naive - offsetMs(new Date(first), timeZone);
  return new Date(second);
}

/** Minutes east of UTC for `timeZone` at `at`, as milliseconds. */
function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - at.getTime();
}

/**
 * `YYYY-MM-DDTHH:mm:ss` wall clock in the publishing timezone for an instant —
 * the shape `mu_post.py` has sent Zernio since launch (paired with
 * `timezone: America/New_York`). No `Z`, no offset.
 */
export function wallClock(instant: Date, timeZone: string = PUBLISH_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

/** `date` + `slot` + `offsetMinutes`, as an instant. */
export function legInstant(
  date: string,
  slot: { hour: number; minute: number },
  offsetMinutes: number,
): Date {
  return new Date(slotInstant(date, slot).getTime() + offsetMinutes * 60_000);
}
