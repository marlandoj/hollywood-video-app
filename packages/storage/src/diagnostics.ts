import { objectClient } from "./artifacts";
import { StudioDatabase } from "./database";
import { costReadings, providerHealthReadings, type DatabaseStatus } from "../../observability/src/diagnostics";

/** Isolated, bounded read-only pool: monitoring never occupies an admission connection. */
export function storageDiagnostics(url: string, monthlyCapUsd: number, sharedObjects: boolean) {
  if (!Number.isFinite(monthlyCapUsd) || monthlyCapUsd <= 0) throw new Error("invalid monthly budget");
  const database = new StudioDatabase(url, 1, {connectionTimeout: 2});
  const client = sharedObjects ? objectClient() : undefined;
  return {
    async database(): Promise<DatabaseStatus> {
      return await database.sql.begin(async tx => {
        await tx`set transaction read only`;
        await tx`set local statement_timeout = '1000ms'`;
        const [row] = await tx`with latest_workers as (
          select distinct on (body->>'name') heartbeat_at, body->>'state' as state, body->>'name' as name, body->'providers' as providers
          from hv_workers where body->>'name' is not null
          order by body->>'name', heartbeat_at desc, id desc
        ), fresh_providers as (
          -- One row over the cap is fetched so a trimmed reading can say so; the shape is judged by the validator, not here.
          select name, providers from latest_workers
          where state in ('idle','busy','draining') and heartbeat_at between now()-interval '45 seconds' and now()
            and providers is not null
          order by heartbeat_at desc, name limit 65
        ), provider_costs as (
          select provider,
            coalesce(sum(total_usd) filter (where created_at >= now()-interval '1 day'),0) as "dayUsd",
            coalesce(sum(total_usd) filter (where created_at >= now()-interval '7 days'),0) as "weekUsd",
            coalesce(sum(total_usd),0) as "monthUsd", count(*)::int as events
          from hv_cost_events where created_at >= now()-interval '30 days'
          group by provider order by 4 desc, provider limit 65
        ) select q.queued, q.running,
          (select coalesce(jsonb_agg(jsonb_build_object('name',name,'providers',providers)),'[]'::jsonb) from fresh_providers) as worker_providers,
          (select coalesce(jsonb_agg(to_jsonb(provider_costs)),'[]'::jsonb) from provider_costs) as provider_costs,
          (select coalesce(sum(total_usd),0) from hv_cost_events where created_at >= now() - interval '30 days') as spent,
          (select coalesce(sum(remaining_usd),0) from hv_reservations) as reserved,
          (select monthly_cap_usd from hv_budget_accounts where id = 'operator') as stored_cap,
          (select count(*) from latest_workers) as latest,
          (select count(*) from latest_workers where state = 'idle' and heartbeat_at between now()-interval '45 seconds' and now()) as ready,
          (select count(*) from latest_workers where state = 'busy' and heartbeat_at between now()-interval '45 seconds' and now()) as busy,
          (select count(*) from latest_workers where state = 'draining' and heartbeat_at between now()-interval '45 seconds' and now()) as draining
          from public.hv_queue_counts() q`;
        const number = (value: unknown) => {const result = Number(value); if (value === null || !Number.isFinite(result) || result < 0) throw new Error("invalid diagnostics aggregate"); return result;};
        return {queue: {queued: number(row.queued), running: number(row.running)},
          workers: {ready: number(row.ready), busy: number(row.busy), draining: number(row.draining), latestProcesses: number(row.latest)},
          budget: {recordedMonthUsd: number(row.spent), reservedUsd: number(row.reserved), monthlyCapUsd: Math.min(monthlyCapUsd, row.stored_cap === null ? monthlyCapUsd : number(row.stored_cap))},
          providers: providerHealthReadings(row.worker_providers), costs: costReadings(row.provider_costs)};
      }) as DatabaseStatus;
    },
    objects: client ? async () => {await client.list({maxKeys: 1}); return true;} : undefined,
    close: () => database.close(),
  };
}
