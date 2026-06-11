import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col justify-center px-6 py-16 text-center">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-6">
        <p className="text-sm font-medium text-fd-muted-foreground">
          Durable Telegram bot flows for Bun and TypeScript
        </p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Fluxgram</h1>
        <p className="max-w-2xl text-balance text-lg text-fd-muted-foreground">
          Build conversational Telegram bots as resumable flow trees with prompts, buttons,
          subflows, timers, media sends, queueing, and recovery semantics.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link
            href="/docs"
            className="rounded-md bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground"
          >
            Read the docs
          </Link>
          <Link
            href="/docs/getting-started"
            className="rounded-md border px-4 py-2 text-sm font-medium"
          >
            Build your first flow
          </Link>
        </div>
      </div>
    </main>
  );
}
