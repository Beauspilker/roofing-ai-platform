export function LeadListEmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-gray-800 bg-gray-950 px-6 py-16 text-center">
      <p className="text-sm uppercase tracking-[0.2em] text-blue-400">Leads</p>
      <h2 className="mt-4 text-2xl font-semibold text-white">No leads yet</h2>
      <p className="mx-auto mt-3 max-w-md text-gray-400">
        When new customer inquiries come in, they will appear here with status,
        priority, and property details.
      </p>
    </div>
  );
}
