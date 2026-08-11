import type { PhoneCallIntelligence } from "@/lib/phone-call-intelligence";

type CallIntelligenceSectionProps = {
  intelligence: PhoneCallIntelligence;
};

const priorityStyles: Record<string, string> = {
  emergency: "border-red-900/50 bg-red-950/40 text-red-300",
  high: "border-red-900/50 bg-red-950/40 text-red-300",
  medium: "border-yellow-900/50 bg-yellow-950/40 text-yellow-200",
  low: "border-gray-700 bg-gray-900 text-gray-300",
};

function getPriorityStyle(label: string | null): string {
  if (!label) {
    return priorityStyles.low;
  }

  const normalized = label.toLowerCase();

  if (normalized.includes("emergency")) {
    return priorityStyles.emergency;
  }

  if (normalized.includes("high")) {
    return priorityStyles.high;
  }

  if (normalized.includes("medium")) {
    return priorityStyles.medium;
  }

  return priorityStyles.low;
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-black/40 px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.15em] text-gray-500">
        {label}
      </p>
      <p className="mt-1 text-sm text-gray-200">{value}</p>
    </div>
  );
}

export function CallIntelligenceSection({
  intelligence,
}: CallIntelligenceSectionProps) {
  const hasTranscript = intelligence.transcript.length > 0;
  const metaItems = [
    intelligence.callDate
      ? { label: "Call date", value: intelligence.callDate }
      : null,
    intelligence.callDuration
      ? { label: "Duration", value: intelligence.callDuration }
      : null,
    intelligence.callerPhone
      ? { label: "Caller number", value: intelligence.callerPhone }
      : null,
  ].filter(Boolean) as Array<{ label: string; value: string }>;

  return (
    <section className="space-y-6 border-b border-gray-800 pb-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-blue-400">
            AI phone call
          </p>
          <h2 className="mt-2 text-lg font-semibold text-white">Call summary</h2>
          <p className="mt-1 text-sm text-gray-400">
            What the AI receptionist captured from this call.
          </p>
        </div>

        {intelligence.priorityLabel ? (
          <span
            className={`inline-flex self-start rounded-full border px-3 py-1 text-xs font-medium ${getPriorityStyle(intelligence.priorityLabel)}`}
          >
            {intelligence.priorityLabel} priority
          </span>
        ) : null}
      </div>

      {intelligence.isFallback ? (
        <p className="rounded-lg border border-yellow-900/40 bg-yellow-950/20 px-4 py-3 text-sm text-yellow-100/90">
          Full call transcript is unavailable for this lead. Showing the saved
          call summary from lead details.
        </p>
      ) : null}

      {metaItems.length > 0 ? (
        <dl className="grid gap-3 sm:grid-cols-3">
          {metaItems.map((item) => (
            <MetaItem key={item.label} label={item.label} value={item.value} />
          ))}
        </dl>
      ) : null}

      {intelligence.highlights.length > 0 ? (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-gray-400">
            Key details
          </h3>
          <dl className="grid gap-3 sm:grid-cols-2">
            {intelligence.highlights.map((highlight) => (
              <div
                key={highlight.label}
                className="rounded-xl border border-gray-800 bg-black/40 p-4"
              >
                <dt className="text-xs uppercase tracking-[0.15em] text-gray-500">
                  {highlight.label}
                </dt>
                <dd className="mt-2 text-sm text-white">{highlight.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      <div className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-gray-400">
          AI summary
        </h3>
        <div className="rounded-xl border border-gray-800 bg-black/40 p-4">
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-gray-200">
            {intelligence.aiSummary}
          </pre>
        </div>
      </div>

      {hasTranscript ? (
        <details className="group rounded-xl border border-gray-800 bg-black/20">
          <summary className="cursor-pointer list-none px-4 py-4 text-sm font-semibold text-white marker:content-none [&::-webkit-details-marker]:hidden">
            <span className="flex items-center justify-between gap-3">
              <span>
                Call transcript ({intelligence.transcript.length} messages)
              </span>
              <span className="text-xs font-normal text-gray-500 group-open:hidden">
                Show
              </span>
              <span className="hidden text-xs font-normal text-gray-500 group-open:inline">
                Hide
              </span>
            </span>
          </summary>
          <ul className="space-y-3 border-t border-gray-800 px-4 py-4">
            {intelligence.transcript.map((turn, index) => (
              <li
                key={`${turn.roleLabel}-${index}`}
                className={`rounded-lg border px-4 py-3 ${
                  turn.roleLabel === "Caller"
                    ? "border-blue-900/40 bg-blue-950/20"
                    : "border-gray-800 bg-gray-950/60"
                }`}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-xs font-semibold uppercase tracking-[0.12em] text-gray-400">
                    {turn.roleLabel}
                  </span>
                  {turn.timeLabel ? (
                    <span className="text-xs text-gray-600">{turn.timeLabel}</span>
                  ) : null}
                </div>
                <p className="mt-2 text-sm leading-relaxed text-gray-200">
                  {turn.content}
                </p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
