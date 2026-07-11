import Link from "next/link";

type AuthCardProps = {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
};

export function AuthCard({ title, subtitle, children }: AuthCardProps) {
  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-md">
        <Link
          href="/"
          className="text-sm text-gray-400 transition hover:text-white"
        >
          ← Back to home
        </Link>

        <h1 className="mt-8 text-center text-4xl font-bold">{title}</h1>

        {subtitle ? (
          <p className="mt-3 text-center text-gray-400">{subtitle}</p>
        ) : null}

        <div className="mt-8 rounded-xl border border-gray-800 bg-gray-950 p-8">
          {children}
        </div>
      </div>
    </main>
  );
}
