"use strict";
(() => {
  window.addEventListener("hashchange", () => {if (location.hash) location.reload();});
  const $ = id => document.getElementById(id);
  let token = location.hash.slice(1), expiresAt = 0, active = false, interval;
  history.replaceState(null, "", location.pathname);
  const text = (id, value) => {$(id).textContent = value;};
  const money = value => typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat(undefined, {style: "currency", currency: "USD", maximumFractionDigits: 6}).format(value) : "Unknown";
  const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "No verified timestamp";
  const state = value => value === "available" ? "Responding" : value === "not_configured" ? "Not monitored" : "Unavailable";
  function lock(message) {
    token = ""; clearInterval(interval); $("refresh").disabled = true; $("readings").hidden = true;
    text("checked", ""); text("message", message); $("message").dataset.state = "error";
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
      const response = await fetch("/api/operator/status", {headers: {authorization: "Bearer " + token}, cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(5000)});
      if (response.status === 401) {lock("Operator access is invalid or expired. Open a newly minted link to continue."); return;}
      if (!response.ok) throw new Error("unavailable");
      const value = await response.json();
      if (!token || Date.now() >= expiresAt) {lock("Operator access expired. Open a newly minted link to continue."); return;}
      if (value.schema !== "hv-operator-status/1") throw new Error("invalid");
      const data = value.database.value, budget = data?.budget, workers = data?.workers, backup = value.backup.value;
      text("message", value.status === "healthy" ? "The monitored runtime checks are healthy." : "Some runtime checks need attention. Review the readings below.");
      $("message").dataset.state = value.status;
      text("checked", "Checked " + time(value.checkedAt) + ". Refreshes every 15 seconds while this page is visible.");
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
      if (token) {text("message", "Status could not be refreshed. Previous readings may be stale; try Refresh status."); $("message").dataset.state = "error";}
    } finally {active = false; $("refresh").disabled = !token; text("refresh", "Refresh status");}
  }
  $("refresh").addEventListener("click", refresh);
  interval = setInterval(() => {if (Date.now() >= expiresAt) lock("Operator access expired. Open a newly minted link to continue."); else if (!document.hidden) refresh();}, 15_000);
  document.addEventListener("visibilitychange", () => {if (!document.hidden) refresh();});
  refresh();
})();
