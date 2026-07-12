import Link from "next/link";

export default function LeadNotFound() {
  return (
    <main className="min-h-screen bg-black px-4 py-8 text-white sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center justify-center py-24 text-center">
        <p className="text-sm uppercase tracking-[0.2em] text-blue-400">
          Lead not found
        </p>
        <h1 className="mt-4 text-3xl font-bold sm:text-4xl">
          This lead is unavailable
        </h1>
        <p className="mt-4 max-w-md text-gray-400">
          The lead may not exist, or you may not have access to it for your
          company.
        </p>
        <Link
          href="/dashboard"
          className="mt-8 rounded-xl bg-blue-600 px-8 py-4 text-lg font-semibold transition hover:bg-blue-700"
        >
          Back to Dashboard
        </Link>
      </div>
    </main>
  );
}
