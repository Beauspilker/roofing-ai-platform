export function hasScheduledInspection(appointmentAt: string | null): boolean {
  return appointmentAt !== null;
}

export function isInspectionOverdue(
  appointmentAt: string | null,
  now: Date = new Date(),
): boolean {
  if (!appointmentAt) {
    return false;
  }

  return new Date(appointmentAt).getTime() < now.getTime();
}

export function isInspectionUpcoming(
  appointmentAt: string | null,
  now: Date = new Date(),
): boolean {
  if (!appointmentAt) {
    return false;
  }

  return new Date(appointmentAt).getTime() >= now.getTime();
}
