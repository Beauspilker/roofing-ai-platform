import Link from "next/link";
import { HomeownerLeadForm } from "@/components/homeowner/HomeownerLeadForm";

export default function HomePage() {
  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto flex w-full max-w-3xl flex-col px-4 py-10 sm:px-6 lg:px-8">
        <header className="text-center">
          <p className="text-sm font-medium uppercase tracking-wide text-blue-400">
            Free roofing help
          </p>
          <h1 className="mt-3 text-4xl font-bold sm:text-5xl">
            Tell us about your roof
          </h1>
          <p className="mt-4 text-lg text-gray-400">
            Submit your project details and a local roofing professional will
            follow up with you.
          </p>
        </header>

        <div className="mt-10">
          <HomeownerLeadForm />
        </div>

        <footer className="mt-10 border-t border-gray-900 pt-6 text-center text-sm text-gray-500">
          <p>
            Roofing company?{" "}
            <Link href="/for-roofers" className="text-gray-300 hover:text-white">
              Learn about the platform
            </Link>
            {" · "}
            <Link href="/login" className="text-gray-300 hover:text-white">
              Sign in
            </Link>
          </p>
        </footer>
      </div>
    </main>
  );
}
