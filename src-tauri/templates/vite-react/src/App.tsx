import { useState } from "react";

export function App() {
  const [count, setCount] = useState(0);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-950 p-8 text-slate-100">
      <h1 className="text-3xl font-semibold tracking-tight">{"{{name}}"}</h1>
      <p className="max-w-md text-center text-slate-400">
        Edit <code className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-sm text-slate-200">src/App.tsx</code> and save to see it change.
      </p>
      <button
        type="button"
        onClick={() => setCount((value) => value + 1)}
        className="rounded-lg bg-indigo-500 px-4 py-2 font-medium text-white shadow transition hover:bg-indigo-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
      >
        Clicked {count} {count === 1 ? "time" : "times"}
      </button>
    </main>
  );
}
