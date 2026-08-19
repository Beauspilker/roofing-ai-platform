import Link from "next/link";
import {
  ACTIVE_PIPELINE_STAGES,
  buildDashboardFollowUpFilterHref,
  buildDashboardStatusFilterHref,
  type LeadPipelineVisibility,
} from "@/lib/lead-dashboard-visibility";
import { formatLeadStatus } from "@/lib/leads";

type PipelineVisibilitySectionProps = {
  visibility: LeadPipelineVisibility;
};

const stageCardClassName =
  "rounded-xl border border-gray-800 bg-gray-950 p-5 transition hover:border-blue-600 hover:bg-gray-900/80";

const stageCountClassName = "mt-2 text-3xl font-bold text-white";

function VisibilityCard({
  href,
  label,
  count,
  description,
  countClassName = stageCountClassName,
}: {
  href?: string;
  label: string;
  count: number;
  description: string;
  countClassName?: string;
}) {
  const content = (
    <>
      <p className="text-sm text-gray-400">{label}</p>
      <p className={countClassName}>{count}</p>
      <p className="mt-2 text-xs text-gray-500">{description}</p>
    </>
  );

  if (!href || count === 0) {
    return (
      <div className={stageCardClassName}>
        {content}
      </div>
    );
  }

  return (
    <Link href={href} className={`${stageCardClassName} block`}>
      {content}
    </Link>
  );
}

export function PipelineVisibilitySection({
  visibility,
}: PipelineVisibilitySectionProps) {
  const { pipelineStageCounts, wonCount, lostCount, followUpsDue, followUpsOverdue } =
    visibility;
  const followUpsUpcoming = Math.max(followUpsDue - followUpsOverdue, 0);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-white">Pipeline visibility</h2>
        <p className="mt-1 text-sm text-gray-400">
          Open pipeline counts for active leads. Click a count to filter the lead
          list below.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {ACTIVE_PIPELINE_STAGES.map((stage) => (
          <VisibilityCard
            key={stage}
            href={buildDashboardStatusFilterHref(stage)}
            label={formatLeadStatus(stage)}
            count={pipelineStageCounts[stage]}
            description="Active leads in this pipeline stage"
          />
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <VisibilityCard
          href={buildDashboardStatusFilterHref("won")}
          label="Won"
          count={wonCount}
          description="Closed-won leads (not archived)"
          countClassName={`${stageCountClassName} text-green-300`}
        />
        <VisibilityCard
          href={buildDashboardStatusFilterHref("lost")}
          label="Lost"
          count={lostCount}
          description="Closed-lost leads (not archived)"
        />
        <VisibilityCard
          href={buildDashboardFollowUpFilterHref("due")}
          label="Follow-ups due"
          count={followUpsDue}
          description={
            followUpsUpcoming > 0
              ? `${followUpsUpcoming} upcoming on active leads`
              : "Open follow-ups on active leads"
          }
          countClassName={`${stageCountClassName} text-amber-200`}
        />
        <VisibilityCard
          href={buildDashboardFollowUpFilterHref("overdue")}
          label="Overdue follow-ups"
          count={followUpsOverdue}
          description="Past-due follow-ups on active leads"
          countClassName={`${stageCountClassName} text-red-300`}
        />
      </div>
    </section>
  );
}
