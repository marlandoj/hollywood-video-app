CREATE FUNCTION public.hv_queue_counts()
RETURNS TABLE (queued integer, running integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT count(*) FILTER (WHERE status = 'queued')::integer,
         count(*) FILTER (WHERE status = 'running')::integer
  FROM public.hv_jobs;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.hv_queue_counts() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.hv_queue_counts() TO hv_api, hv_worker;
