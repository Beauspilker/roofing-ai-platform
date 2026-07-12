"use client";

import { useRef } from "react";
import {
  archiveLead,
  restoreLead,
} from "@/app/dashboard/leads/[id]/archive/actions";
import { isArchivedLead, type Lead } from "@/lib/leads";

type LeadArchiveControlsProps = {
  lead: Lead;
};

export function LeadArchiveControls({ lead }: LeadArchiveControlsProps) {
  const archiveFormRef = useRef<HTMLFormElement>(null);
  const restoreFormRef = useRef<HTMLFormElement>(null);
  const archived = isArchivedLead(lead);

  function handleArchiveClick() {
    const confirmed = window.confirm(
      "Archive this lead? It will be hidden from the active dashboard but can be restored later.",
    );

    if (confirmed) {
      archiveFormRef.current?.requestSubmit();
    }
  }

  if (archived) {
    return (
      <form ref={restoreFormRef} action={restoreLead}>
        <input type="hidden" name="lead_id" value={lead.id} />
        <button
          type="submit"
          className="inline-flex rounded-xl border border-green-900/50 bg-green-950/40 px-5 py-3 text-sm font-semibold text-green-200 transition hover:border-green-800 hover:text-green-100"
        >
          Restore Lead
        </button>
      </form>
    );
  }

  return (
    <form ref={archiveFormRef} action={archiveLead}>
      <input type="hidden" name="lead_id" value={lead.id} />
      <button
        type="button"
        onClick={handleArchiveClick}
        className="inline-flex rounded-xl border border-red-900/50 bg-red-950/40 px-5 py-3 text-sm font-semibold text-red-200 transition hover:border-red-800 hover:text-red-100"
      >
        Archive Lead
      </button>
    </form>
  );
}
