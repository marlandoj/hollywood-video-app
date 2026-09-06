"use strict";
(() => {
  window.addEventListener("hashchange", () => {if (location.hash) location.reload();});
  const $ = id => document.getElementById(id);
  let token = location.hash.slice(1), expiresAt = 0, active = false, interval, exploring = false;
  let selection = "", selectedTrace = null, spanPage = 0, explorerObserved = false;
  history.replaceState(null, "", location.pathname);
  const text = (id, value) => {$(id).textContent = value;};
  const money = value => typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat(undefined, {style: "currency", currency: "USD", maximumFractionDigits: 6}).format(value) : "Unknown";
  const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "No verified timestamp";
  const state = value => value === "available" ? "Responding" : value === "not_configured" ? "Not monitored" : "Unavailable";
  function lock(message) {
    token = ""; clearInterval(interval); $("refresh").disabled = true; $("readings").hidden = true;
    text("checked", ""); text("message", message); $("message").dataset.state = "error";
  }
  async function authorized(path) {
    if (!token || Date.now() >= expiresAt) {lock("Operator access expired. Open a newly minted link to continue."); throw new Error("expired");}
    const response = await fetch(path, {headers: {authorization: "Bearer " + token}, cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(5000)});
    if (response.status === 401) {lock("Operator access is invalid or expired. Open a newly minted link to continue."); throw new Error("expired");}
    if (!response.ok) throw new Error("unavailable");
    const value = await response.json();
    if (!token || Date.now() >= expiresAt) {lock("Operator access expired. Open a newly minted link to continue."); throw new Error("expired");}
    return value;
  }
  function element(tag, value, parent) {
    const node = document.createElement(tag); if (value !== undefined) node.textContent = value; parent?.append(node); return node;
  }
  const rate = value => value === null || value === undefined ? "No usable sample" : new Intl.NumberFormat(undefined, {maximumFractionDigits: 3}).format(value) + " / min";
  const duration = value => value < 1000 ? value.toFixed(1) + " ms" : (value / 1000).toFixed(2) + " s";
  const label = series => (series.service === "rough-cut-api" ? "API requests" : "Worker jobs") + " · " + series.outcome;
  function svg(tag, attrs, content) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (content !== undefined) node.textContent = content; $("metrics-chart").append(node); return node;
  }
  function renderMetrics(value) {
    const data = value.value, series = data.series.slice().sort((a, b) => label(a).localeCompare(label(b)));
    const start = Date.parse(data.windowStart), end = Date.parse(data.windowEnd);
    const values = series.flatMap(item => item.points.map(point => point[1]).filter(point => point !== null));
    $("metrics-chart").replaceChildren(); $("metrics-legend").replaceChildren(); $("metric-samples").replaceChildren();
    $("metrics-readings").hidden = !series.length;
    text("metrics-message", values.length ? "Stored metrics queried " + time(value.observedAt) + "." : "The backend responded with no usable samples in this window. Activity is unknown.");
    $("metrics-message").dataset.state = "available";
    const max = Math.max(1, ...values), x = at => 50 + (at - start) / (end - start) * 730, y = value => 180 - value / max * 160;
    svg("path", {d: "M50,20 V180 H780", class: "axis"});
    svg("text", {x: 46, y: 24, "text-anchor": "end"}, new Intl.NumberFormat(undefined, {maximumFractionDigits: 1, notation: "compact"}).format(max));
    svg("text", {x: 42, y: 184, "text-anchor": "end"}, "0");
    svg("text", {x: 50, y: 210}, new Date(start).toLocaleTimeString());
    svg("text", {x: 780, y: 210, "text-anchor": "end"}, new Date(end).toLocaleTimeString());
    for (const item of series) {
      const index = (item.service === "rough-cut-api" ? 0 : 2) + (item.outcome === "error" ? 1 : 0);
      let path = "", previous = null;
      for (const [at, value] of item.points) {
        if (value === null) {previous = null; continue;}
        path += (previous !== null && at - previous === 60_000 ? "L" : "M") + x(at) + "," + y(value) + " "; previous = at;
        svg("circle", {cx: x(at), cy: y(value), r: 1.6, class: "series series-" + index});
      }
      svg("path", {d: path, class: "series series-" + index});
      const row = element("div", undefined, $("metrics-legend")); row.className = "series-" + index;
      element("dt", label(item), row);
      const last = item.points.at(-1);
      element("dd", rate(last?.[1]) + (last ? " · evaluated " + new Date(last[0]).toLocaleTimeString() : "") + (last && last[0] < end ? " · no sample at the end of the window" : ""), row);
      for (const point of item.points) {
        const sample = element("tr", undefined, $("metric-samples"));
        element("td", new Date(point[0]).toLocaleString(), sample); element("td", label(item), sample); element("td", rate(point[1]), sample);
      }
    }
  }
  function renderSpans() {
    const data = selectedTrace; if (!data) return;
    $("span-rows").replaceChildren();
    for (const span of data.spans.slice(spanPage * 50, (spanPage + 1) * 50)) {
      const row = element("tr", undefined, $("span-rows"));
      const operation = element("td", undefined, row); element("div", span.operation, operation); element("code", span.id, operation);
      element("td", span.service.replace("rough-cut-", ""), row);
      element("td", duration(Math.max(0, span.startMs - Date.parse(data.startedAt))), row); element("td", duration(span.durationMs), row);
      element("td", span.outcome + (span.failureCode ? " · " + span.failureCode : ""), row);
      const parent = element("td", undefined, row); element("code", span.parentId ?? "Root", parent);
    }
    text("spans-page", "Spans " + (spanPage * 50 + 1) + "–" + Math.min((spanPage + 1) * 50, data.spans.length) + " of " + data.spans.length);
    $("spans-previous").disabled = spanPage === 0; $("spans-next").disabled = (spanPage + 1) * 50 >= data.spans.length;
  }
  function renderTraces(value, detail) {
    $("traces-message").dataset.state = "available";
    $("trace-list").hidden = detail; $("trace-detail").hidden = !detail || !value.value;
    if (detail) {
      const previousId = selectedTrace?.id; selectedTrace = value.value;
      spanPage = selectedTrace && previousId === selectedTrace.id ? Math.min(spanPage, Math.max(0, Math.ceil(selectedTrace.spans.length / 50) - 1)) : 0;
      text("traces-message", value.value ? "Stored trace queried " + time(value.observedAt) + "." : "No stored trace was found. Check the ID; sampling, export loss, or retention may leave no result.");
      if (!selectedTrace) return;
      text("trace-detail-title", "Trace " + selectedTrace.id);
      text("trace-detail-summary", time(selectedTrace.startedAt) + " · " + duration(selectedTrace.durationMs) + " elapsed · " + selectedTrace.spanCount + " stored operations · " + selectedTrace.outcome + (selectedTrace.limited ? ". Display limited to the first 500 operations." : "."));
      renderSpans(); return;
    }
    const traces = value.value.traces; $("trace-list").hidden = !traces.length; $("trace-rows").replaceChildren();
    text("traces-message", traces.length ? "Showing " + traces.length + " stored " + (traces.length === 1 ? "trace" : "traces") + " from the last 24 hours. Queried " + time(value.observedAt) + "." : "No stored job traces matched in the last 24 hours. Try a known trace ID; sampling or export loss may leave no result.");
    for (const trace of traces) {
      const row = element("tr", undefined, $("trace-rows")); element("td", time(trace.startedAt), row);
      const job = element("td", undefined, row); element("code", trace.jobId, job); element("div", trace.stage ?? "Stage unknown", job);
      element("td", trace.spanCount + " · " + trace.outcome, row);
      const button = element("button", "Open " + trace.id.slice(0, 8), element("td", undefined, row)); button.type = "button"; button.className = "secondary";
      button.setAttribute("aria-label", "Inspect trace " + trace.id);
      button.addEventListener("click", () => {if (exploring) return; selection = trace.id; $("trace-filter").value = trace.id; $("trace-list").hidden = true; $("trace-detail").hidden = true; refreshExplorer(true);});
    }
  }
  async function refreshExplorer(focus = false) {
    if (!token || !$("explorer").open || exploring) return;
    exploring = true; explorerObserved = true;
    for (const button of $("trace-search").querySelectorAll("button")) button.disabled = true;
    const detail = /^[0-9a-f]{32}$/.test(selection);
    text("traces-message", "Querying stored traces…"); text("metrics-message", "Querying stored metrics…");
    const query = selection ? "?jobId=" + encodeURIComponent(selection) : "";
    const loads = [["metrics", "/api/operator/metrics", "hv-operator-metrics/1", renderMetrics],
      ["traces", detail ? "/api/operator/traces/" + selection : "/api/operator/traces" + query, detail ? "hv-operator-trace/1" : "hv-operator-traces/1", value => renderTraces(value, detail)]];
    try {
      await Promise.all(loads.map(async ([kind, path, schema, render]) => {
        try {
          const value = await authorized(path);
          if (value.schema !== schema) throw new Error("invalid");
          if (value.state !== "available") {
            text(kind + "-message", value.state === "not_configured" ? "Stored telemetry is not configured for this API. Previous readings, if shown, are stale." : "Stored telemetry is unavailable. Previous readings, if shown, are stale. Try Refresh readings.");
            $(kind + "-message").dataset.state = "unavailable"; return;
          }
          render(value);
          if (kind === "traces" && detail && value.value && focus) $("trace-detail-title").focus();
        } catch {if (token) {text(kind + "-message", "Stored telemetry could not be refreshed. Previous readings, if shown, are stale. Try Refresh readings."); $(kind + "-message").dataset.state = "unavailable";}}
      }));
    } finally {exploring = false; for (const button of $("trace-search").querySelectorAll("button")) button.disabled = !token;}
  }
  try {
    if (!/^[A-Za-z0-9_-]{1,900}\.[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("invalid");
    const body = token.split(".")[0].replaceAll("-", "+").replaceAll("_", "/");
    const payload = JSON.parse(atob(body));
    expiresAt = payload.exp;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 900_000) throw new Error("expired");
  } catch {lock("Open a fresh operator link to view studio status. Ask the studio operator to mint a read-only link."); return;}
  async function refresh() {
    if (active || !token) return;
    if (Date.now() >= expiresAt) {lock("Operator access expired. Open a newly minted link to continue."); return;}
    active = true; $("refresh").disabled = true; text("refresh", "Checking…");
    try {
      const value = await authorized("/api/operator/status");
      if (!token || Date.now() >= expiresAt) {lock("Operator access expired. Open a newly minted link to continue."); return;}
      if (value.schema !== "hv-operator-status/1") throw new Error("invalid");
      const data = value.database.value, budget = data?.budget, workers = data?.workers, backup = value.backup.value;
      text("message", value.status === "healthy" ? "The monitored runtime checks are healthy." : "Some runtime checks need attention. Review the readings below.");
      $("message").dataset.state = value.status;
      text("checked", "Checked " + time(value.checkedAt) + ". Runtime checks refresh every 15 seconds while this page is visible.");
      text("database", state(value.database.state) + " · " + value.backend);
      text("objects", value.objects.state === "available" && value.objects.value !== true ? "Unavailable" : state(value.objects.state));
      text("queue", data ? data.queue.queued + " queued · " + data.queue.running + " running" : "Unknown");
      text("workers", workers ? workers.ready + " ready · " + workers.busy + " busy · " + workers.draining + " draining (" + value.workers.expected + " expected)" : "Not monitored");
      text("runtime-note", value.database.state === "available" ? "Worker readings count the latest process for each worker, with a heartbeat in the last 45 seconds." : "Database readings are unavailable. Any values shown were last verified " + time(value.database.observedAt) + ".");
      text("spend", money(budget?.recordedMonthUsd)); text("reserved", money(budget?.reservedUsd)); text("cap", money(budget?.monthlyCapUsd)); text("available", money(value.budget.availableUsd));
      text("budget-note", (value.budget.current ? "" : "Last known figures; current capacity is unknown. ") + "Recorded costs have not been reconciled with provider invoices.");
      text("backup", (value.backup.state === "available" ? backup.state : state(value.backup.state)) + (value.backup.fresh ? " · snapshot within 5 minutes" : " · no current verified snapshot") + (backup?.failureStage ? " · " + backup.failureStage + " failed" : ""));
      text("snapshot", time(backup?.lastSnapshotAt)); text("backup-objects", backup?.objects === null || backup?.objects === undefined ? "Unknown" : String(backup.objects));
      text("telemetry", value.telemetry.enabled ? "Enabled" : "Disabled"); text("trace-time", time(value.telemetry.lastSpanExportAt)); text("trace-errors", String(value.telemetry.spanExportFailures));
      $("readings").hidden = false;
    } catch {
      if (token) {text("message", "Status could not be refreshed. Previous readings may be stale; try Refresh readings."); $("message").dataset.state = "error";}
    } finally {active = false; $("refresh").disabled = !token; text("refresh", "Refresh readings");}
  }
  function refreshAll() {refresh(); refreshExplorer();}
  $("explorer").addEventListener("toggle", () => {if ($("explorer").open && !explorerObserved) refreshExplorer();});
  $("trace-search").addEventListener("submit", event => {
    event.preventDefault(); if (exploring || !token) return;
    const input = $("trace-filter").value.trim().toLowerCase();
    const valid = !input || /^(?!0{32}$)[0-9a-f]{32}$/.test(input) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input);
    $("trace-filter").setAttribute("aria-invalid", String(!valid));
    if (!valid) {text("traces-message", "Enter a job UUID or a 32-character trace ID, or clear the field for recent jobs."); $("trace-filter").focus(); return;}
    selection = input; $("trace-list").hidden = true; $("trace-detail").hidden = true; refreshExplorer(true);
  });
  $("trace-reset").addEventListener("click", () => {selection = ""; $("trace-filter").value = ""; $("trace-filter").removeAttribute("aria-invalid"); $("trace-detail").hidden = true; refreshExplorer();});
  $("spans-previous").addEventListener("click", () => {if (spanPage > 0) {spanPage--; renderSpans();}});
  $("spans-next").addEventListener("click", () => {if (selectedTrace && (spanPage + 1) * 50 < selectedTrace.spans.length) {spanPage++; renderSpans();}});
  $("refresh").addEventListener("click", refreshAll);
  interval = setInterval(() => {if (Date.now() >= expiresAt) lock("Operator access expired. Open a newly minted link to continue."); else if (!document.hidden) refresh();}, 15_000);
  document.addEventListener("visibilitychange", () => {if (!document.hidden) refresh();});
  refresh();
})();
