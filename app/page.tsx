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

      <button className="mt-10 rounded-xl bg-blue-600 px-8 py-4 text-lg font-semibold hover:bg-blue-700 transition">
        Book a Demo
      </button>
    </main>
  );
}