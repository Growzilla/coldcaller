/** Tiny in-process pub/sub feeding the SSE stream. Singleton across Next dev reloads. */

export type DialerEvent = {
  type: "session" | "call" | "queue" | "ping" | "intel" | "booked" | "inbound" | "sms" | "verify";
  payload: any;
};

type Listener = (e: DialerEvent) => void;

declare global {
  // eslint-disable-next-line no-var
  var __dialerBus: Set<Listener> | undefined;
}

function listeners(): Set<Listener> {
  if (!globalThis.__dialerBus) globalThis.__dialerBus = new Set();
  return globalThis.__dialerBus;
}

export function subscribe(fn: Listener): () => void {
  listeners().add(fn);
  return () => listeners().delete(fn);
}

export function publish(e: DialerEvent): void {
  listeners().forEach((fn) => {
    try {
      fn(e);
    } catch {
      /* dead subscriber — removed on unsubscribe */
    }
  });
}
