/**
 * Runtime-agnostic Redis command client: Bun uses the built-in RedisClient,
 * Node uses the optional `redis` (node-redis) package. Both are adapted to a
 * single raw-command surface, so the adapters speak plain Redis.
 */

export interface RedisCommandClient {
  /** run a raw command, e.g. sendCommand(["GETDEL", "key"]) */
  sendCommand(args: string[]): Promise<unknown>;
  close(): void;
}

export type RedisDriver = "bun" | "node-redis";

export async function connectRedisCommandClient(
  url: string,
  opts?: { driver?: RedisDriver },
): Promise<RedisCommandClient> {
  const driver = opts?.driver ?? (process.versions.bun ? "bun" : "node-redis");

  if (driver === "bun") {
    const { RedisClient } = await import("bun");
    const client = new RedisClient(url);
    await client.connect();
    return {
      sendCommand: ([cmd, ...args]: string[]) => client.send(cmd!, args),
      close: () => client.close(),
    };
  }

  let createClient: (opts: { url: string }) => {
    connect(): Promise<unknown>;
    sendCommand(args: string[]): Promise<unknown>;
    destroy?(): void;
    disconnect?(): Promise<void>;
  };
  try {
    ({ createClient } = (await import("redis")) as unknown as {
      createClient: typeof createClient;
    });
  } catch {
    throw new Error(
      "fluxgram's Redis adapter needs the 'redis' package on Node: npm install redis",
    );
  }
  const client = createClient({ url });
  await client.connect();
  return {
    sendCommand: (args) => client.sendCommand(args),
    close: () => {
      if (client.destroy) client.destroy();
      else void client.disconnect?.();
    },
  };
}
