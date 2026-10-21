import * as promClient from '@prometheus-io/client';

/**
 * Prometheus registry for this process.
 * The metrics endpoint is internal-only.
 */

const registry = new promClient.Registry();

// Default process/heap/event-loop metrics, collected on scrape.
promClient.collectDefaultMetrics({ register: registry });

export async function renderMetrics(): Promise<string> {
  return registry.metrics();
}
