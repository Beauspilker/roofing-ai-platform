import Link from "next/link";

export default function IntakeNotFoundPage() {
  return (
    <main className="min-h-screen bg-black px-4 py-8 text-white sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-lg rounded-xl border border-gray-800 bg-gray-950 p-8 text-center">
        <h1 className="text-2xl font-bold">Intake link not found</h1>
        <p className="mt-4 text-gray-400">
          This roofing intake link is invalid or the company no longer exists.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold transition hover:bg-blue-700"
        >
          Go to homepage
        </Link>
      </div>
    </main>
  );
}
