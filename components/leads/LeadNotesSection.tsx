"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef } from "react";
import {
  addLeadNote,
  type AddLeadNoteState,
} from "@/app/dashboard/leads/[id]/notes/actions";
import {
  formatNoteCreatedDate,
  formatNoteCreatedTime,
  type LeadNote,
} from "@/lib/notes";

const initialState: AddLeadNoteState = { error: null };

type LeadNotesSectionProps = {
  leadId: string;
  notes: LeadNote[];
};

export function LeadNotesSection({ leadId, notes }: LeadNotesSectionProps) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const wasPending = useRef(false);
  const [state, formAction, pending] = useActionState(
    addLeadNote,
    initialState,
  );

  useEffect(() => {
    if (wasPending.current && !pending && !state.error) {
      formRef.current?.reset();
      router.refresh();
    }

    wasPending.current = pending;
  }, [pending, router, state.error]);

  return (
    <section className="mt-10 space-y-6 border-t border-gray-800 pt-8">
      <div>
        <h2 className="text-xl font-semibold text-white">Lead Notes</h2>
        <p className="mt-1 text-sm text-gray-400">
          Add internal notes for this lead. Newest notes appear first.
        </p>
      </div>

      <form ref={formRef} action={formAction} className="space-y-4">
        <input type="hidden" name="lead_id" value={leadId} />

        <div>
          <label
            htmlFor="note"
            className="block text-sm font-medium text-gray-300"
          >
            New note
          </label>
          <textarea
            id="note"
            name="note"
            rows={4}
            required
            placeholder="Add a note about this lead..."
            className="mt-2 w-full rounded-xl border border-gray-800 bg-black px-4 py-3 text-white outline-none transition placeholder:text-gray-500 focus:border-blue-600"
          />
        </div>

        {state.error ? (
          <p className="rounded-xl border border-red-900/50 bg-red-950/50 px-4 py-3 text-sm text-red-300">
            {state.error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Adding note..." : "Add Note"}
        </button>
      </form>

      {notes.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-800 bg-black/40 px-4 py-8 text-center text-sm text-gray-500">
          No notes yet. Add the first note above.
        </p>
      ) : (
        <ul className="space-y-4">
          {notes.map((note) => (
            <li
              key={note.id}
              className="rounded-xl border border-gray-800 bg-black/40 p-4"
            >
              <p className="whitespace-pre-wrap text-sm text-gray-200">
                {note.note}
              </p>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                <span>{formatNoteCreatedDate(note.created_at)}</span>
                <span>{formatNoteCreatedTime(note.created_at)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
