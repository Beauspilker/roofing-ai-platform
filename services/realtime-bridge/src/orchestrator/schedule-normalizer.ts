import type { RealtimeFields } from "./realtime-prompts.js";
import { logError } from "../logger.js";
import { syncLegacyStringFields } from "./structured-intake.js";

export const COMPANY_TIMEZONE = process.env.COMPANY_TIMEZONE?.trim() || "America/Chicago";

export const SCHEDULE_PARSE_FALLBACK_PROMPT =
  "I'm sorry, I had trouble understanding the timing. What specific day and time would work best for you?";

export const SCHEDULE_DAYPART_CLARIFICATION_PROMPT =
  "Would morning, afternoon, or evening work best?";

export const SCHEDULE_FLEXIBLE_ACCEPT_MESSAGE =
  "That's okay. I'll note that your timing is flexible.";

const GENERIC_SCHEDULE_TIME_PROMPT = /^what time works best\?$/i;

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
      status: "flexible_availability";
      spoken: string;
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
  const minutePart = `:${String(minute).padStart(2, "0")}`;
  return `${hour12}${minutePart} ${suffix}`.replace("  ", " ");
}

const SPOKEN_HOUR_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const HOUR_TOKEN =
  "(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";

type ScheduleDaypart = "morning" | "afternoon" | "evening";

export type ScheduleParseOptions = {
  knownDaypart?: ScheduleDaypart;
  knownScheduleRaw?: string;
};

function parseHourToken(token: string): number | null {
  const numeric = Number.parseInt(token, 10);

  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 12) {
    return numeric;
  }

  return SPOKEN_HOUR_WORDS[token.toLowerCase()] ?? null;
}

export function extractDaypartFromSpeech(
  speech: string,
): "morning" | "afternoon" | "evening" | undefined {
  const normalized = speech.toLowerCase();

  if (/\bmorning\b/.test(normalized)) {
    return "morning";
  }

  if (/\bafternoon\b/.test(normalized)) {
    return "afternoon";
  }

  if (/\bevening\b/.test(normalized)) {
    return "evening";
  }

  return undefined;
}

function applyDaypartMeridiem(
  hour: number,
  daypart: "morning" | "afternoon" | "evening",
): number {
  if (daypart === "morning") {
    return hour === 12 ? 0 : hour;
  }

  if (hour >= 1 && hour <= 11) {
    return hour + 12;
  }

  return hour;
}

function applyMeridiemToHour(
  hour: number,
  meridiem: string | undefined,
  daypart: ScheduleDaypart | undefined,
): number {
  let resolved = hour;

  if (meridiem === "pm" && resolved < 12) {
    resolved += 12;
  }
  if (meridiem === "am" && resolved === 12) {
    resolved = 0;
  }
  if (!meridiem && daypart) {
    resolved = applyDaypartMeridiem(resolved, daypart);
  }

  return resolved;
}

function parseColloquialTimeFromSpeech(
  normalized: string,
  daypart?: ScheduleDaypart,
): { hour: number; minute: number; endHour?: number; endMinute?: number } | null {
  const quarterTo = normalized.match(
    new RegExp(`\\bquarter to ${HOUR_TOKEN}\\b`, "i"),
  );
  if (quarterTo) {
    const targetHour = parseHourToken(quarterTo[1] ?? "");
    if (targetHour === null) {
      return null;
    }

    const hourToken = targetHour === 1 ? 12 : targetHour - 1;
    const hour = applyMeridiemToHour(hourToken, undefined, daypart);
    return { hour, minute: 45 };
  }

  const quarterAfter = normalized.match(
    new RegExp(`\\bquarter (?:after|past) ${HOUR_TOKEN}\\b`, "i"),
  );
  if (quarterAfter) {
    const parsedHour = parseHourToken(quarterAfter[1] ?? "");
    if (parsedHour === null) {
      return null;
    }

    const hour = applyMeridiemToHour(parsedHour, undefined, daypart);
    return { hour, minute: 15 };
  }

  const hourThirty = normalized.match(
    new RegExp(`\\b${HOUR_TOKEN}\\s+thirty\\b`, "i"),
  );
  if (hourThirty) {
    const parsedHour = parseHourToken(hourThirty[1] ?? "");
    if (parsedHour === null) {
      return null;
    }

    const hour = applyMeridiemToHour(parsedHour, undefined, daypart);
    return { hour, minute: 30 };
  }

  const halfPast = normalized.match(new RegExp(`\\bhalf past ${HOUR_TOKEN}\\b`, "i"));
  if (halfPast) {
    const parsedHour = parseHourToken(halfPast[1] ?? "");
    if (parsedHour === null) {
      return null;
    }

    const hour = applyMeridiemToHour(parsedHour, undefined, daypart);
    return { hour, minute: 30 };
  }

  const sharpTime = normalized.match(new RegExp(`\\b${HOUR_TOKEN}\\s+sharp\\b`, "i"));
  if (sharpTime) {
    const parsedHour = parseHourToken(sharpTime[1] ?? "");
    if (parsedHour === null) {
      return null;
    }

    const hour = applyMeridiemToHour(parsedHour, undefined, daypart);
    return { hour, minute: 0 };
  }

  const oClockTime = normalized.match(
    new RegExp(`\\b(?:at\\s+|around\\s+|about\\s+)?${HOUR_TOKEN}(?::(\\d{2}))?\\s+o\\s+clock\\b`, "i"),
  );
  if (oClockTime) {
    const parsedHour = parseHourToken(oClockTime[1] ?? "");
    if (parsedHour === null) {
      return null;
    }

    if (!daypart) {
      return null;
    }

    const minute = Number.parseInt(oClockTime[2] ?? "0", 10);
    const hour = applyMeridiemToHour(parsedHour, undefined, daypart);
    return { hour, minute };
  }

  return null;
}

function parseTimeFromSpeech(
  normalized: string,
  daypart?: ScheduleDaypart,
): { hour: number; minute: number; endHour?: number; endMinute?: number } | null {
  const colloquial = parseColloquialTimeFromSpeech(normalized, daypart);
  if (colloquial) {
    return colloquial;
  }

  const atTime = normalized.match(
    new RegExp(`\\bat\\s+${HOUR_TOKEN}(?::(\\d{2}))?\\s*(am|pm)?\\b`, "i"),
  );
  if (atTime) {
    const parsedHour = parseHourToken(atTime[1] ?? "");
    if (parsedHour === null) {
      return null;
    }

    let hour = parsedHour;
    const minute = Number.parseInt(atTime[2] ?? "0", 10);
    const meridiem = atTime[3]?.toLowerCase();

    if (meridiem === "pm" && hour < 12) {
      hour += 12;
    }
    if (meridiem === "am" && hour === 12) {
      hour = 0;
    }
    if (!meridiem && hour <= 7 && !daypart) {
      hour += 12;
    }
    if (!meridiem && daypart) {
      hour = applyDaypartMeridiem(hour, daypart);
    }

    return { hour, minute };
  }

  const aboutTime = normalized.match(
    /\babout\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\b/i,
  );
  if (aboutTime) {
    const parsedHour = parseHourToken(aboutTime[1] ?? "");
    if (parsedHour === null) {
      return null;
    }

    let hour = parsedHour;
    const minute = Number.parseInt(aboutTime[2] ?? "0", 10);
    if (daypart) {
      hour = applyDaypartMeridiem(hour, daypart);
    } else if (hour <= 7) {
      hour += 12;
    }
    return { hour, minute };
  }

  const aroundTime = normalized.match(
    /\baround\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\b/i,
  );
  if (aroundTime) {
    const parsedHour = parseHourToken(aroundTime[1] ?? "");
    if (parsedHour === null) {
      return null;
    }

    let hour = parsedHour;
    const minute = Number.parseInt(aroundTime[2] ?? "0", 10);
    if (daypart) {
      hour = applyDaypartMeridiem(hour, daypart);
    } else if (hour <= 7) {
      hour += 12;
    }
    return { hour, minute };
  }

  const betweenTimes = normalized.match(
    new RegExp(
      `\\bbetween\\s+${HOUR_TOKEN}(?::(\\d{2}))?\\s*(?:am|pm)?\\s+and\\s+${HOUR_TOKEN}(?::(\\d{2}))?\\s*(am|pm)?`,
      "i",
    ),
  );
  if (betweenTimes) {
    const startHour = parseHourToken(betweenTimes[1] ?? "");
    const endHour = parseHourToken(betweenTimes[3] ?? "");
    if (startHour === null || endHour === null) {
      return null;
    }

    let hour = startHour;
    const minute = Number.parseInt(betweenTimes[2] ?? "0", 10);
    const meridiem = betweenTimes[5]?.toLowerCase();
    let endHour24 = endHour;
    const endMinute = Number.parseInt(betweenTimes[4] ?? "0", 10);

    if (meridiem === "pm" && hour < 12) {
      hour += 12;
    }
    if (meridiem === "am" && hour === 12) {
      hour = 0;
    }
    if (!meridiem && daypart) {
      hour = applyDaypartMeridiem(hour, daypart);
      endHour24 = applyDaypartMeridiem(endHour, daypart);
    } else if (!meridiem && hour <= 7) {
      hour += 12;
      endHour24 += 12;
    }

    return { hour, minute, endHour: endHour24, endMinute };
  }

  const fromToTimes = normalized.match(
    new RegExp(
      `\\bfrom\\s+${HOUR_TOKEN}(?::(\\d{2}))?\\s*(?:am|pm)?\\s+to\\s+${HOUR_TOKEN}(?::(\\d{2}))?\\s*(am|pm)?`,
      "i",
    ),
  );
  if (fromToTimes) {
    const startHour = parseHourToken(fromToTimes[1] ?? "");
    const endHour = parseHourToken(fromToTimes[3] ?? "");
    if (startHour === null || endHour === null) {
      return null;
    }

    let hour = startHour;
    const minute = Number.parseInt(fromToTimes[2] ?? "0", 10);
    const meridiem = fromToTimes[5]?.toLowerCase();
    let endHour24 = endHour;
    const endMinute = Number.parseInt(fromToTimes[4] ?? "0", 10);

    if (meridiem === "pm" && hour < 12) {
      hour += 12;
    }
    if (meridiem === "am" && hour === 12) {
      hour = 0;
    }
    if (!meridiem && daypart) {
      hour = applyDaypartMeridiem(hour, daypart);
      endHour24 = applyDaypartMeridiem(endHour, daypart);
    } else if (!meridiem && hour <= 7) {
      hour += 12;
      endHour24 += 12;
    }

    return { hour, minute, endHour: endHour24, endMinute };
  }

  const afterTime = normalized.match(
    new RegExp(
      `\\b(?:any\\s*time|anytime|after)\\s+${HOUR_TOKEN}(?::(\\d{2}))?\\s*(am|pm)?\\b`,
      "i",
    ),
  );
  if (afterTime) {
    const parsedHour = parseHourToken(afterTime[1] ?? "");
    if (parsedHour === null) {
      return null;
    }

    const minute = Number.parseInt(afterTime[2] ?? "0", 10);
    const meridiem = afterTime[3]?.toLowerCase();
    let hour = parsedHour;

    if (meridiem === "pm" && hour < 12) {
      hour += 12;
    } else if (meridiem === "am" && hour === 12) {
      hour = 0;
    } else if (!meridiem && daypart) {
      hour = applyDaypartMeridiem(hour, daypart);
    } else if (!meridiem && hour <= 7) {
      hour += 12;
    }

    return { hour, minute };
  }

  const bareTime = normalized.match(
    /^(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\s*(am|pm)?$/i,
  );
  if (bareTime) {
    const parsedHour = parseHourToken(bareTime[1] ?? "");
    if (parsedHour === null) {
      return null;
    }

    let hour = parsedHour;
    const minute = Number.parseInt(bareTime[2] ?? "0", 10);
    const meridiem = bareTime[3]?.toLowerCase();

    if (meridiem === "pm" && hour < 12) {
      hour += 12;
    }
    if (meridiem === "am" && hour === 12) {
      hour = 0;
    }
    if (!meridiem && daypart) {
      hour = applyDaypartMeridiem(hour, daypart);
      return { hour, minute };
    }
    if (!meridiem) {
      return null;
    }

    return { hour, minute };
  }

  if (daypart) {
    const trailingTime = normalized.match(
      /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\s*(am|pm)?\s*$/i,
    );
    if (trailingTime) {
      const parsedHour = parseHourToken(trailingTime[1] ?? "");
      if (parsedHour !== null) {
        const minute = Number.parseInt(trailingTime[2] ?? "0", 10);
        const meridiem = trailingTime[3]?.toLowerCase();
        let hour = parsedHour;

        if (meridiem === "pm" && hour < 12) {
          hour += 12;
        } else if (meridiem === "am" && hour === 12) {
          hour = 0;
        } else if (!meridiem) {
          hour = applyDaypartMeridiem(hour, daypart);
        }

        return { hour, minute };
      }
    }
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

function resolveTargetDateFromSpeech(
  normalized: string,
  today: LocalDateParts,
  knownScheduleRaw?: string,
): LocalDateParts {
  let targetDate = { ...today };
  let useNextWeek = false;

  if (/\btomorrow\b/.test(normalized)) {
    return addDays(today, 1);
  }

  if (/\bnext week\b/.test(normalized)) {
    return addDays(today, 7);
  }

  const weekdayMatch = normalized.match(
    /\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  );
  if (weekdayMatch) {
    useNextWeek = Boolean(weekdayMatch[1]);
    const weekday = weekdayIndex(weekdayMatch[2] ?? "");
    if (weekday !== null) {
      return resolveWeekday(today, weekday, useNextWeek);
    }
  }

  const known = (knownScheduleRaw ?? "").toLowerCase().replace(/[^\w\s:]/g, " ").replace(/\s+/g, " ").trim();
  if (!known) {
    return targetDate;
  }

  if (/\btomorrow\b/.test(known)) {
    return addDays(today, 1);
  }

  if (/\bnext week\b/.test(known)) {
    return addDays(today, 7);
  }

  const knownWeekdayMatch = known.match(
    /\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  );
  if (knownWeekdayMatch) {
    useNextWeek = Boolean(knownWeekdayMatch[1]);
    const weekday = weekdayIndex(knownWeekdayMatch[2] ?? "");
    if (weekday !== null) {
      return resolveWeekday(today, weekday, useNextWeek);
    }
  }

  return targetDate;
}

function buildFlexibleAvailabilitySpoken(
  raw: string,
  targetDate: LocalDateParts,
): string {
  const trimmed = raw.trim();
  if (/\btomorrow\b/i.test(trimmed)) {
    return trimmed;
  }

  if (/\b(morning|afternoon|evening|anytime|whenever|flexible|as soon as possible|before work|after work|during lunch)\b/i.test(trimmed)) {
    return trimmed;
  }

  return `${formatSpokenDate(targetDate)} ${trimmed}`.trim();
}

export function parseScheduleSpeech(
  speech: string,
  now: Date = new Date(),
  timeZone: string = COMPANY_TIMEZONE,
  options: ScheduleParseOptions = {},
): ScheduleParseResult {
  try {
    return parseScheduleSpeechInternal(speech, now, timeZone, options);
  } catch (error) {
    logScheduleParseError(error, speech);
    return {
      status: "needs_date_clarification",
      prompt: SCHEDULE_PARSE_FALLBACK_PROMPT,
      raw: speech.trim(),
    };
  }
}

function logScheduleParseError(error: unknown, speech: string): void {
  logError("schedule_parse_failed", { speechLength: speech.trim().length }, error);
}

function parseScheduleSpeechInternal(
  speech: string,
  now: Date = new Date(),
  timeZone: string = COMPANY_TIMEZONE,
  options: ScheduleParseOptions = {},
): ScheduleParseResult {
  const raw = speech.trim();
  const normalized = raw.toLowerCase().replace(/[^\w\s:]/g, " ").replace(/\s+/g, " ").trim();

  if (!normalized) {
    return { status: "nothing_schedulable", raw };
  }

  const today = getLocalParts(now, timeZone);
  const targetDate = resolveTargetDateFromSpeech(
    normalized,
    today,
    options.knownScheduleRaw,
  );

  if (
    /\b(whenever|any time|anytime|as soon as possible|asap|flexible)\b/.test(normalized)
  ) {
    return {
      status: "flexible_availability",
      spoken: buildFlexibleAvailabilitySpoken(raw, targetDate),
      raw,
    };
  }

  if (/\bbefore work\b|\bduring lunch\b|\bsometime tomorrow\b/.test(normalized)) {
    return {
      status: "flexible_availability",
      spoken: buildFlexibleAvailabilitySpoken(raw, targetDate),
      raw,
    };
  }

  if (/\blater in the afternoon\b/.test(normalized)) {
    return {
      status: "flexible_availability",
      spoken: buildFlexibleAvailabilitySpoken(raw, targetDate),
      raw,
    };
  }

  if (/\bafter work\b|\bafter i get off\b|\bwhen i get off\b/.test(normalized)) {
    return {
      status: "flexible_availability",
      spoken: buildFlexibleAvailabilitySpoken(raw, targetDate),
      raw,
    };
  }

  if (/\bbefore\s+(noon|midday)\b/.test(normalized)) {
    const dateLabel = formatSpokenDate(targetDate);
    return {
      status: "needs_confirmation",
      spoken: `${dateLabel} before noon`,
      isoStart: makeUtcDate(targetDate.year, targetDate.month, targetDate.day, 8, 0, timeZone).toISOString(),
      isoEnd: makeUtcDate(targetDate.year, targetDate.month, targetDate.day, 12, 0, timeZone).toISOString(),
      raw,
    };
  }

  if (/\b(noon|midday)\b/.test(normalized)) {
    const dateLabel = formatSpokenDate(targetDate);
    return {
      status: "needs_confirmation",
      spoken: `${dateLabel} at 12:00 PM`,
      isoStart: makeUtcDate(targetDate.year, targetDate.month, targetDate.day, 12, 0, timeZone).toISOString(),
      raw,
    };
  }

  const daypart =
    extractDaypartFromSpeech(normalized) ?? options.knownDaypart;
  const time = parseTimeFromSpeech(normalized, daypart);
  const hasMorning = daypart === "morning" || /\bmorning\b/.test(normalized);
  const hasAfternoon = daypart === "afternoon" || /\bafternoon\b/.test(normalized);
  const hasEvening = daypart === "evening" || /\bevening\b/.test(normalized);

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

    if (hasAfternoon && !/\btomorrow\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(normalized)) {
      return {
        status: "flexible_availability",
        spoken: buildFlexibleAvailabilitySpoken(raw, targetDate),
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

    if (time.endHour !== undefined && time.endMinute !== undefined) {
      const startLabel = formatSpokenTime(time.hour, time.minute);
      const endLabel = formatSpokenTime(time.endHour, time.endMinute);

      return {
        status: "needs_confirmation",
        spoken: `${dateLabel} between ${startLabel.replace(/ AM| PM/, "")} and ${endLabel}`,
        isoStart: makeUtcDate(
          targetDate.year,
          targetDate.month,
          targetDate.day,
          time.hour,
          time.minute,
          timeZone,
        ).toISOString(),
        isoEnd: makeUtcDate(
          targetDate.year,
          targetDate.month,
          targetDate.day,
          time.endHour,
          time.endMinute,
          timeZone,
        ).toISOString(),
        raw,
      };
    }

    const betweenTimes = normalized.match(
      /\bbetween\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\s*(?:am|pm)?\s+and\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\s*(am|pm)?/i,
    );

    if (betweenTimes) {
      const startHour = parseHourToken(betweenTimes[1] ?? "");
      const endHour = parseHourToken(betweenTimes[3] ?? "");
      if (startHour !== null && endHour !== null) {
        let endHour24 = endHour;
        const meridiem = betweenTimes[5]?.toLowerCase();
        if (meridiem === "pm" && endHour24 < 12) {
          endHour24 += 12;
        }
        if (!meridiem && endHour24 <= 7) {
          endHour24 += 12;
        }

        let startHour24 = startHour;
        if (meridiem === "pm" && startHour24 < 12) {
          startHour24 += 12;
        }
        if (!meridiem && startHour24 <= 7) {
          startHour24 += 12;
        }

        const startLabel = formatSpokenTime(startHour24, Number.parseInt(betweenTimes[2] ?? "0", 10));
        const endLabel = formatSpokenTime(endHour24, Number.parseInt(betweenTimes[4] ?? "0", 10));

        return {
          status: "needs_confirmation",
          spoken: `${dateLabel} between ${startLabel.replace(/ AM| PM/, "")} and ${endLabel}`,
          isoStart: makeUtcDate(
            targetDate.year,
            targetDate.month,
            targetDate.day,
            startHour24,
            Number.parseInt(betweenTimes[2] ?? "0", 10),
            timeZone,
          ).toISOString(),
          isoEnd: makeUtcDate(
            targetDate.year,
            targetDate.month,
            targetDate.day,
            endHour24,
            Number.parseInt(betweenTimes[4] ?? "0", 10),
            timeZone,
          ).toISOString(),
          raw,
        };
      }
    }

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

  const bareMeridiemPrompt = normalized.match(
    new RegExp(`^${HOUR_TOKEN}(?::(\\d{2}))?\\s*$`, "i"),
  );
  if (bareMeridiemPrompt) {
    const parsedHour = parseHourToken(bareMeridiemPrompt[1] ?? "");
    if (parsedHour !== null) {
      const minute = Number.parseInt(bareMeridiemPrompt[2] ?? "0", 10);
      const amHour = parsedHour === 12 ? 0 : parsedHour;
      const pmHour = parsedHour < 12 ? parsedHour + 12 : parsedHour;
      return {
        status: "needs_time_clarification",
        prompt: `Do you mean ${formatSpokenTime(amHour, minute)} or ${formatSpokenTime(pmHour, minute)}?`,
        raw,
      };
    }
  }

  const bareOClockPrompt = normalized.match(
    new RegExp(`^${HOUR_TOKEN}(?::(\\d{2}))?\\s+o\\s+clock\\s*$`, "i"),
  );
  if (bareOClockPrompt && !daypart) {
    const parsedHour = parseHourToken(bareOClockPrompt[1] ?? "");
    if (parsedHour !== null) {
      const minute = Number.parseInt(bareOClockPrompt[2] ?? "0", 10);
      const amHour = parsedHour === 12 ? 0 : parsedHour;
      const pmHour = parsedHour < 12 ? parsedHour + 12 : parsedHour;
      return {
        status: "needs_time_clarification",
        prompt: `Do you mean ${formatSpokenTime(amHour, minute)} or ${formatSpokenTime(pmHour, minute)}?`,
        raw,
      };
    }
  }

  return { status: "nothing_schedulable", raw };
}

export function buildScheduleConfirmationQuestion(spoken: string): string {
  if (spoken.startsWith("Would ")) {
    return `${spoken} Is that correct?`;
  }

  return `Just to confirm, you'd prefer a call on ${spoken.replace(/^on /i, "")}. Is that correct?`;
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

  if (result.status === "flexible_availability") {
    return syncLegacyStringFields({
      ...fields,
      appointment_preference_raw: result.raw,
      appointment_preference: result.spoken,
      schedule_confirmed: true,
      schedule_pending_clarification: false,
      schedule_clarification_prompt: undefined,
      schedule_clarification_attempts: undefined,
    });
  }

  return syncLegacyStringFields({
    ...fields,
    appointment_preference_raw: result.raw,
    schedule_confirmed: false,
    schedule_daypart: extractDaypartFromSpeech(result.raw) ?? fields.schedule_daypart,
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

function isScheduleClarificationFailure(result: ScheduleParseResult): boolean {
  return (
    result.status === "needs_time_clarification" ||
    result.status === "needs_date_clarification" ||
    result.status === "nothing_schedulable"
  );
}

function isGenericScheduleTimePrompt(prompt: string | undefined): boolean {
  if (!prompt?.trim()) {
    return true;
  }

  return GENERIC_SCHEDULE_TIME_PROMPT.test(prompt.trim());
}

function acceptFlexibleSchedulePreference(
  fields: RealtimeFields,
  preference: string,
): RealtimeFields {
  const trimmed = preference.trim();

  return syncLegacyStringFields({
    ...fields,
    appointment_preference: trimmed,
    appointment_preference_raw: trimmed,
    schedule_confirmed: true,
    schedule_pending_clarification: false,
    schedule_clarification_prompt: undefined,
    schedule_clarification_attempts: undefined,
  });
}

function resolveScheduleClarificationPrompt(
  parsed: ScheduleParseResult,
  nextAttempts: number,
): string {
  if (nextAttempts >= 1) {
    return SCHEDULE_DAYPART_CLARIFICATION_PROMPT;
  }

  if (
    parsed.status === "needs_time_clarification" ||
    parsed.status === "needs_date_clarification"
  ) {
    if (isGenericScheduleTimePrompt(parsed.prompt)) {
      return SCHEDULE_DAYPART_CLARIFICATION_PROMPT;
    }

    return parsed.prompt;
  }

  if (parsed.status === "nothing_schedulable") {
    return SCHEDULE_PARSE_FALLBACK_PROMPT;
  }

  return SCHEDULE_DAYPART_CLARIFICATION_PROMPT;
}

export function processScheduleCapture(
  fields: RealtimeFields,
  speech: string,
  now: Date = new Date(),
): {
  fields: RealtimeFields;
  clarificationPrompt?: string;
  confirmationPrompt?: string;
  flexibleAcceptMessage?: string;
} {
  try {
    const combined = `${fields.appointment_preference_raw ?? ""} ${speech}`.trim();
    const parsed = parseScheduleSpeech(combined, now, COMPANY_TIMEZONE, {
      knownDaypart: fields.schedule_daypart,
      knownScheduleRaw: fields.appointment_preference_raw,
    });
    let updated = applyScheduleParseResult(
      {
        ...fields,
        appointment_preference_raw: combined,
      },
      parsed,
    );

    if (parsed.status === "flexible_availability") {
      return { fields: updated };
    }

    if (parsed.status === "needs_confirmation") {
      updated = {
        ...updated,
        schedule_pending_clarification: false,
        schedule_clarification_prompt: undefined,
        schedule_clarification_attempts: undefined,
      };
      return {
        fields: updated,
        confirmationPrompt: buildScheduleConfirmationQuestion(parsed.spoken),
      };
    }

    if (isScheduleClarificationFailure(parsed)) {
      const alreadyClarifying = fields.schedule_pending_clarification === true;
      const attempts = alreadyClarifying
        ? (fields.schedule_clarification_attempts ?? 0)
        : 0;

      if (alreadyClarifying && attempts >= 1) {
        return {
          fields: acceptFlexibleSchedulePreference(updated, combined),
          flexibleAcceptMessage: SCHEDULE_FLEXIBLE_ACCEPT_MESSAGE,
        };
      }

      const nextAttempts = alreadyClarifying ? attempts + 1 : 0;
      const prompt = resolveScheduleClarificationPrompt(parsed, nextAttempts);
      updated = {
        ...updated,
        schedule_pending_clarification: true,
        schedule_clarification_prompt: prompt,
        schedule_clarification_attempts: nextAttempts,
        schedule_daypart:
          parsed.status === "needs_time_clarification"
            ? extractDaypartFromSpeech(parsed.raw) ??
              fields.schedule_daypart ??
              extractDaypartFromSpeech(fields.appointment_preference_raw ?? "")
            : fields.schedule_daypart,
      };
      return { fields: updated, clarificationPrompt: prompt };
    }

    updated = {
      ...updated,
      schedule_pending_clarification: true,
      schedule_clarification_prompt: SCHEDULE_PARSE_FALLBACK_PROMPT,
      schedule_clarification_attempts: (fields.schedule_clarification_attempts ?? 0) + 1,
    };

    return {
      fields: updated,
      clarificationPrompt: SCHEDULE_PARSE_FALLBACK_PROMPT,
    };
  } catch (error) {
    logScheduleParseError(error, speech);
    const combined = `${fields.appointment_preference_raw ?? ""} ${speech}`.trim();
    const attempts = fields.schedule_clarification_attempts ?? 0;

    if (attempts >= 1) {
      return {
        fields: acceptFlexibleSchedulePreference(fields, combined),
        flexibleAcceptMessage: SCHEDULE_FLEXIBLE_ACCEPT_MESSAGE,
      };
    }

    const updated: RealtimeFields = {
      ...fields,
      appointment_preference_raw: combined,
      schedule_pending_clarification: true,
      schedule_clarification_prompt: SCHEDULE_DAYPART_CLARIFICATION_PROMPT,
      schedule_confirmed: false,
      schedule_clarification_attempts: attempts + 1,
    };

    return {
      fields: updated,
      clarificationPrompt: SCHEDULE_DAYPART_CLARIFICATION_PROMPT,
    };
  }
}
