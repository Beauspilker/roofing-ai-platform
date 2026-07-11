import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center justify-center px-6">
      <h1 className="text-6xl md:text-7xl font-bold text-center">
        Roofing AI Platform
      </h1>

      <p className="mt-6 text-xl text-gray-400 text-center max-w-2xl">
        Never miss another lead.
        <br />
        AI answers your phones, books appointments, and creates estimates
        24/7.
      </p>

      <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row">
        <Link
          href="/signup"
          className="rounded-xl bg-blue-600 px-8 py-4 text-lg font-semibold transition hover:bg-blue-700"
        >
          Get started
        </Link>
        <Link
          href="/login"
          className="rounded-xl border border-gray-800 px-8 py-4 text-lg font-semibold text-gray-300 transition hover:border-gray-700 hover:text-white"
        >
          Sign in
        </Link>
      </div>
    </main>
  );
}