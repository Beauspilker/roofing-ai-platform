import type { RealtimeFields } from "./realtime-prompts.js";
import { syncLegacyStringFields } from "./structured-intake.js";

export const COMPANY_TIMEZONE = process.env.COMPANY_TIMEZONE?.trim() || "America/Chicago";

export type ScheduleParseResult =
  | {
      status: "needs_time_clarification";
      prompt: string;
      raw: string;
    }
  | {
      status: "needs_date_clarification";
      prompt: string;
      raw: string;
    }
  | {
      status: "needs_confirmation";
      spoken: string;
      isoStart: string;
      isoEnd?: string;
      raw: string;
    }
  | {
      status: "nothing_schedulable";
      raw: string;
    };

type LocalDateParts = {
  year: number;
  month: number;
  day: number;
  weekday: number;
};

function getLocalParts(date: Date, timeZone: string): LocalDateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  });

  const parts = formatter.formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    year: Number.parseInt(lookup.year ?? "1970", 10),
    month: Number.parseInt(lookup.month ?? "1", 10),
    day: Number.parseInt(lookup.day ?? "1", 10),
    weekday: weekdayMap[lookup.weekday ?? "Sun"] ?? 0,
  };
}

function makeUtcDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = getLocalParts(new Date(guess), timeZone);
    const deltaHours = hour - deriveHour(new Date(guess), timeZone);
    const deltaDays = day - parts.day;
    guess += deltaDays * 86_400_000 + deltaHours * 3_600_000;
  }

  return new Date(guess);
}

function deriveHour(date: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(date);

  const lookup = Object.fromEntries(hour.map((part) => [part.type, part.value]));
  return Number.parseInt(lookup.hour ?? "0", 10);
}

function addDays(parts: LocalDateParts, days: number): LocalDateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
}

function resolveWeekday(
  parts: LocalDateParts,
  targetWeekday: number,
  useNextWeek: boolean,
): LocalDateParts {
  let delta = (targetWeekday - parts.weekday + 7) % 7;

  if (delta === 0 && useNextWeek) {
    delta = 7;
  }

  if (delta === 0 && !useNextWeek) {
    return parts;
  }

  return addDays(parts, delta);
}

function formatSpokenDate(parts: LocalDateParts): string {
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  return `${monthNames[parts.month - 1] ?? "January"} ${parts.day}`;
}

function formatSpokenTime(hour: number, minute: number): string {
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const minutePart = minute === 0 ? "" : `:${String(minute).padStart(2, "0")}`;
  return `${hour12}${minutePart} ${suffix}`.replace("  ", " ");
}

function parseTimeFromSpeech(normalized: string): { hour: number; minute: number } | null {
  const atTime = normalized.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (atTime) {
    let hour = Number.parseInt(atTime[1] ?? "0", 10);
    const minute = Number.parseInt(atTime[2] ?? "0", 10);
    const meridiem = atTime[3]?.toLowerCase();

    if (meridiem === "pm" && hour < 12) {
      hour += 12;
    }
    if (meridiem === "am" && hour === 12) {
      hour = 0;
    }
    if (!meridiem && hour <= 7) {
      hour += 12;
    }

    return { hour, minute };
  }

  const aboutTime = normalized.match(/\babout\s+(\d{1,2})(?::(\d{2}))?\b/i);
  if (aboutTime) {
    let hour = Number.parseInt(aboutTime[1] ?? "0", 10);
    const minute = Number.parseInt(aboutTime[2] ?? "0", 10);
    if (hour <= 7) {
      hour += 12;
    }
    return { hour, minute };
  }

  const aroundTime = normalized.match(/\baround\s+(\d{1,2})(?::(\d{2}))?\b/i);
  if (aroundTime) {
    let hour = Number.parseInt(aroundTime[1] ?? "0", 10);
    const minute = Number.parseInt(aroundTime[2] ?? "0", 10);
    if (hour <= 7) {
      hour += 12;
    }
    return { hour, minute };
  }

  return null;
}

function weekdayIndex(name: string): number | null {
  const map: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };

  return map[name.toLowerCase()] ?? null;
}

export function parseScheduleSpeech(
  speech: string,
  now: Date = new Date(),
  timeZone: string = COMPANY_TIMEZONE,
): ScheduleParseResult {
  const raw = speech.trim();
  const normalized = raw.toLowerCase().replace(/[^\w\s:]/g, " ").replace(/\s+/g, " ").trim();

  if (!normalized) {
    return { status: "nothing_schedulable", raw };
  }

  if (/\bafter work\b|\bafter i get off\b|\bwhen i get off\b/.test(normalized)) {
    return {
      status: "needs_time_clarification",
      prompt: "What time should I put down?",
      raw,
    };
  }

  const today = getLocalParts(now, timeZone);
  let targetDate = { ...today };
  let useNextWeek = false;

  if (/\btomorrow\b/.test(normalized)) {
    targetDate = addDays(today, 1);
  } else if (/\bnext week\b/.test(normalized)) {
    targetDate = addDays(today, 7);
  } else {
    const weekdayMatch = normalized.match(/\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    if (weekdayMatch) {
      useNextWeek = Boolean(weekdayMatch[1]);
      const weekday = weekdayIndex(weekdayMatch[2] ?? "");
      if (weekday !== null) {
        targetDate = resolveWeekday(today, weekday, useNextWeek);
      }
    }
  }

  const time = parseTimeFromSpeech(normalized);
  const hasMorning = /\bmorning\b/.test(normalized);
  const hasAfternoon = /\bafternoon\b/.test(normalized);
  const hasEvening = /\bevening\b/.test(normalized);

  if ((hasMorning || hasAfternoon || hasEvening) && !time) {
    const dateLabel = formatSpokenDate(targetDate);
    if (hasMorning) {
      return {
        status: "needs_confirmation",
        spoken: `Would ${dateLabel} between 8:00 and 11:00 AM work?`,
        isoStart: makeUtcDate(targetDate.year, targetDate.month, targetDate.day, 8, 0, timeZone).toISOString(),
        isoEnd: makeUtcDate(targetDate.year, targetDate.month, targetDate.day, 11, 0, timeZone).toISOString(),
        raw,
      };
    }

    if (hasAfternoon) {
      const afternoonLabel = /\btomorrow\b/.test(normalized)
        ? "tomorrow afternoon"
        : `${formatSpokenDate(targetDate)} afternoon`;
      return {
        status: "needs_time_clarification",
        prompt: `What time ${afternoonLabel} works best?`,
        raw,
      };
    }

    if (hasEvening) {
      return {
        status: "needs_time_clarification",
        prompt: "What time in the evening works best?",
        raw,
      };
    }
  }

  if (!time && /\btomorrow\b|\bnext\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(normalized)) {
    return {
      status: "needs_time_clarification",
      prompt: "What time works best?",
      raw,
    };
  }

  if (time) {
    const dateLabel = formatSpokenDate(targetDate);
    const spokenTime = formatSpokenTime(time.hour, time.minute);
    const isoStart = makeUtcDate(
      targetDate.year,
      targetDate.month,
      targetDate.day,
      time.hour,
      time.minute,
      timeZone,
    ).toISOString();

    return {
      status: "needs_confirmation",
      spoken: `${dateLabel} at ${spokenTime}`,
      isoStart,
      raw,
    };
  }

  return { status: "nothing_schedulable", raw };
}

export function buildScheduleConfirmationQuestion(spoken: string): string {
  return `Just to confirm, you mean ${spoken}. Is that right?`;
}

export function isScheduleConfirmedSpeech(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return /^(yes|yeah|yep|yup|correct|right|that's right|thats right|that works|sounds good)\b/.test(
    normalized,
  );
}

export function isScheduleRejectedSpeech(speech: string): boolean {
  const normalized = speech.toLowerCase().replace(/[^\w\s']/g, " ").trim();

  return /^(no|nope|nah|not quite|incorrect|wrong|change|fix|update)\b/.test(normalized);
}

export function applyScheduleParseResult(
  fields: RealtimeFields,
  result: ScheduleParseResult,
): RealtimeFields {
  if (result.status === "nothing_schedulable") {
    return fields;
  }

  return syncLegacyStringFields({
    ...fields,
    appointment_preference_raw: result.raw,
    schedule_confirmed: false,
    appointment_schedule_iso: result.status === "needs_confirmation" ? result.isoStart : undefined,
    appointment_schedule_iso_end:
      result.status === "needs_confirmation" ? result.isoEnd : undefined,
    appointment_preference:
      result.status === "needs_confirmation" ? result.spoken : fields.appointment_preference,
  });
}

export function confirmSchedule(fields: RealtimeFields): RealtimeFields {
  const spoken =
    fields.appointment_preference?.trim() ||
    fields.appointment_preference_raw?.trim() ||
    "the requested time";

  return syncLegacyStringFields({
    ...fields,
    appointment_preference: spoken,
    schedule_confirmed: true,
  });
}

export function needsScheduleClarification(fields: RealtimeFields): boolean {
  return Boolean(fields.schedule_pending_clarification);
}

export function needsScheduleConfirmation(fields: RealtimeFields): boolean {
  return (
    Boolean(fields.appointment_schedule_iso || fields.appointment_preference) &&
    fields.schedule_confirmed !== true &&
    !fields.schedule_pending_clarification
  );
}

export function isScheduleComplete(fields: RealtimeFields): boolean {
  return (
    typeof fields.appointment_preference === "string" &&
    fields.appointment_preference.trim().length > 0 &&
    fields.schedule_confirmed === true
  );
}

export function processScheduleCapture(
  fields: RealtimeFields,
  speech: string,
  now: Date = new Date(),
): {
  fields: RealtimeFields;
  clarificationPrompt?: string;
  confirmationPrompt?: string;
} {
  const combined = `${fields.appointment_preference_raw ?? ""} ${speech}`.trim();
  const parsed = parseScheduleSpeech(combined, now);
  let updated = applyScheduleParseResult(
    {
      ...fields,
      appointment_preference_raw: combined,
    },
    parsed,
  );

  if (parsed.status === "needs_time_clarification") {
    updated = {
      ...updated,
      schedule_pending_clarification: true,
      schedule_clarification_prompt: parsed.prompt,
    };
    return { fields: updated, clarificationPrompt: parsed.prompt };
  }

  if (parsed.status === "needs_date_clarification") {
    updated = {
      ...updated,
      schedule_pending_clarification: true,
      schedule_clarification_prompt: parsed.prompt,
    };
    return { fields: updated, clarificationPrompt: parsed.prompt };
  }

  if (parsed.status === "needs_confirmation") {
    updated = {
      ...updated,
      schedule_pending_clarification: false,
      schedule_clarification_prompt: undefined,
    };
    return {
      fields: updated,
      confirmationPrompt: buildScheduleConfirmationQuestion(parsed.spoken),
    };
  }

  return { fields: updated };
}
