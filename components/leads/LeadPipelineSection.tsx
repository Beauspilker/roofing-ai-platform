"use client";

import { useRef } from "react";
import { updateLeadPipelineStatus } from "@/app/dashboard/leads/[id]/status/actions";
import {
  canMarkLeadAsLost,
  getNextPipelineStatus,
  getPipelineStageIndex,
  isActionablePipelineStage,
  isPipelineTerminalStatus,
  PIPELINE_STAGES,
} from "@/lib/lead-pipeline";
import {
  formatLeadStatus,
  isArchivedLead,
  type Lead,
} from "@/lib/leads";

type LeadPipelineSectionProps = {
  lead: Lead;
};

function getStageItemClassName(
  stageIndex: number,
  currentIndex: number,
  isActionable: boolean,
): string {
  if (isActionable) {
    return "border-blue-400 bg-blue-950/60 text-blue-100 hover:bg-blue-900/70 hover:border-blue-300 cursor-pointer";
  }

  if (stageIndex === currentIndex) {
    return "border-blue-500 bg-blue-950/50 text-blue-100";
  }

  if (currentIndex !== -1 && stageIndex < currentIndex) {
    return "border-green-900/50 bg-green-950/30 text-green-200";
  }

  return "border-gray-800 bg-black/40 text-gray-500";
}

export function LeadPipelineSection({ lead }: LeadPipelineSectionProps) {
  const pipelineFormRef = useRef<HTMLFormElement>(null);
  const lostFormRef = useRef<HTMLFormElement>(null);

  if (isArchivedLead(lead)) {
    return null;
  }

  const currentIndex = getPipelineStageIndex(lead.status);
  const nextStatus = getNextPipelineStatus(lead.status);
  const showLostAction = canMarkLeadAsLost(lead.status);
  const isTerminal = isPipelineTerminalStatus(lead.status);

  function submitPipelineStatus(status: string) {
    const form = pipelineFormRef.current;

    if (!form) {
      return;
    }

    const statusInput = form.querySelector<HTMLInputElement>(
      'input[name="status"]',
    );

    if (statusInput) {
      statusInput.value = status;
    }

    form.requestSubmit();
  }

  function handleLostClick() {
    const confirmed = window.confirm(
      "Mark this lead as lost? It will move out of your active pipeline.",
    );

    if (confirmed) {
      lostFormRef.current?.requestSubmit();
    }
  }

  return (
    <section className="mb-8 space-y-5 border-b border-gray-800 pb-8">
      <div>
        <h2 className="text-lg font-semibold text-white">Sales pipeline</h2>
        <p className="mt-1 text-sm text-gray-400">
          Current stage:{" "}
          <span className="font-medium text-white">
            {formatLeadStatus(lead.status)}
          </span>
          {!isTerminal && nextStatus ? (
            <>
              {" "}
              · Click{" "}
              <span className="font-medium text-blue-300">
                {formatLeadStatus(nextStatus)}
              </span>{" "}
              to advance
            </>
          ) : null}
        </p>
      </div>

      <form ref={pipelineFormRef} action={updateLeadPipelineStatus}>
        <input type="hidden" name="lead_id" value={lead.id} />
        <input type="hidden" name="status" value={nextStatus ?? ""} />
        <ol className="grid gap-2 sm:grid-cols-5">
          {PIPELINE_STAGES.map((stage, index) => {
            const isActionable =
              !isTerminal && isActionablePipelineStage(lead.status, stage);
            const className = `w-full rounded-xl border px-3 py-3 text-center text-xs font-medium sm:text-sm transition ${getStageItemClassName(index, currentIndex, isActionable)}`;

            if (isActionable) {
              return (
                <li key={stage}>
                  <button
                    type="button"
                    className={className}
                    aria-label={`Advance lead to ${formatLeadStatus(stage)}`}
                    onClick={() => submitPipelineStatus(stage)}
                  >
                    {formatLeadStatus(stage)}
                  </button>
                </li>
              );
            }

            return (
              <li
                key={stage}
                className={className}
                aria-current={index === currentIndex ? "step" : undefined}
              >
                {formatLeadStatus(stage)}
              </li>
            );
          })}
        </ol>
      </form>

      {lead.status === "lost" ? (
        <p className="rounded-xl border border-gray-800 bg-black/40 px-4 py-3 text-sm text-gray-300">
          This lead is marked as lost. Use Edit Lead to change the status if
          needed.
        </p>
      ) : null}

      {lead.status === "won" ? (
        <p className="rounded-xl border border-green-900/50 bg-green-950/30 px-4 py-3 text-sm text-green-200">
          This lead is marked as won.
        </p>
      ) : null}

      {!isTerminal && showLostAction ? (
        <form ref={lostFormRef} action={updateLeadPipelineStatus}>
          <input type="hidden" name="lead_id" value={lead.id} />
          <input type="hidden" name="status" value="lost" />
          <button
            type="button"
            onClick={handleLostClick}
            className="inline-flex w-full rounded-xl border border-gray-700 px-5 py-3 text-sm font-semibold text-gray-300 transition hover:border-gray-600 hover:text-white sm:w-auto"
          >
            Mark as Lost
          </button>
        </form>
      ) : null}
    </section>
  );
}
