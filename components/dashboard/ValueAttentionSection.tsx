import Link from "next/link";
import {
  buildDashboardAttentionFilterHref,
  buildDashboardStatusFilterHref,
  type LeadValueAttentionVisibility,
} from "@/lib/lead-dashboard-visibility";
import { formatLeadEstimateAmount } from "@/lib/leads";

type ValueAttentionSectionProps = {
  rollups: LeadValueAttentionVisibility;
};

const cardClassName =
  "rounded-xl border border-gray-800 bg-gray-950 p-5 transition hover:border-blue-600 hover:bg-gray-900/80";

const primaryValueClassName = "mt-2 text-3xl font-bold text-white";

function ValueAttentionCard({
  href,
  label,
  primaryValue,
  description,
  primaryClassName = primaryValueClassName,
  isLink = false,
}: {
  href?: string;
  label: string;
  primaryValue: string;
  description: string;
  primaryClassName?: string;
  isLink?: boolean;
}) {
  const content = (
    <>
      <p className="text-sm text-gray-400">{label}</p>
      <p className={primaryClassName}>{primaryValue}</p>
      <p className="mt-2 text-xs text-gray-500">{description}</p>
    </>
  );

  if (!href || !isLink) {
    return <div className={cardClassName}>{content}</div>;
  }

  return (
    <Link href={href} className={`${cardClassName} block`}>
      {content}
    </Link>
  );
}

function formatNeedsAttentionDescription(
  rollups: LeadValueAttentionVisibility,
): string {
  const parts = [
    `${rollups.awaitingContactCount} awaiting contact`,
    `${rollups.overdueFollowUpCount} overdue follow-ups`,
    `${rollups.overdueInspectionCount} overdue inspections`,
  ];

  return parts.join(" · ");
}

export function ValueAttentionSection({ rollups }: ValueAttentionSectionProps) {
  const openPipelineDescription =
    rollups.openPipelineLeadCount === 1
      ? "1 active estimate in pipeline"
      : `${rollups.openPipelineLeadCount} active estimates in pipeline`;

  const wonDescription =
    rollups.wonLeadCount === 1
      ? "1 won job (not archived)"
      : `${rollups.wonLeadCount} won jobs (not archived)`;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-white">Value & attention</h2>
        <p className="mt-1 text-sm text-gray-400">
          Pipeline dollars and leads that need action now. Click a card to filter
          the lead list below.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <ValueAttentionCard
          href={buildDashboardStatusFilterHref("estimate_sent")}
          label="Open pipeline value"
          primaryValue={formatLeadEstimateAmount(rollups.openPipelineValue)}
          description={openPipelineDescription}
          primaryClassName={`${primaryValueClassName} text-cyan-200`}
          isLink={rollups.openPipelineLeadCount > 0}
        />
        <ValueAttentionCard
          href={buildDashboardStatusFilterHref("won")}
          label="Won revenue"
          primaryValue={formatLeadEstimateAmount(rollups.wonRevenue)}
          description={wonDescription}
          primaryClassName={`${primaryValueClassName} text-green-300`}
          isLink={rollups.wonLeadCount > 0}
        />
        <ValueAttentionCard
          href={buildDashboardAttentionFilterHref("needs")}
          label="Needs attention"
          primaryValue={String(rollups.needsAttentionCount)}
          description={formatNeedsAttentionDescription(rollups)}
          primaryClassName={`${primaryValueClassName} text-amber-200`}
          isLink={rollups.needsAttentionCount > 0}
        />
      </div>
    </section>
  );
}
