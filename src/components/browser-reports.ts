import { validateExplainedReport } from "@/domain/investigations/report-validation";
import type { ExplainedInvestigationReport } from "@/domain/investigations/types";

export const MAX_BROWSER_REPORTS = 5;
export const MAX_BROWSER_REPORT_BYTES = 20 * 1024 * 1024;
const databaseName = "traceforce-browser-reports", storeName = "reports";
export type BrowserReportSummary = { id: string; token: string; name: string | null; savedAt: string; lastOpenedAt: string; bytes: number; fromBlock: string; toBlock: string };
type BrowserSnapshot = { schemaVersion: 1; id: string; savedAt: string; lastOpenedAt: string; bytes: number; report: ExplainedInvestigationReport };
export type OpenedBrowserReport = { report: ExplainedInvestigationReport; savedAt: string };

export class BrowserReportStorageError extends Error {
  constructor(message = "Browser storage is unavailable. You can still use or download the current report.") { super(message); this.name = "BrowserReportStorageError"; }
}
const storageError = (error: unknown) => new BrowserReportStorageError(error instanceof DOMException && error.name === "QuotaExceededError" ? "Browser storage is full. Remove a saved snapshot or download the current report instead." : undefined);
const reportBytes = (report: ExplainedInvestigationReport) => new TextEncoder().encode(JSON.stringify(report)).byteLength;

/** Only the validated report is retained. Request capsules and conversations are never accepted. */
export function validateBrowserSnapshot(value: unknown): BrowserSnapshot {
  if (!value || typeof value !== "object") throw new BrowserReportStorageError("This browser snapshot is invalid. Run a fresh investigation.");
  const source = value as Record<string, unknown>;
  const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
  if (source.schemaVersion !== 1 || typeof source.savedAt !== "string" || typeof source.lastOpenedAt !== "string" || !iso.test(source.savedAt) || !iso.test(source.lastOpenedAt) || !Number.isFinite(Date.parse(source.savedAt)) || !Number.isFinite(Date.parse(source.lastOpenedAt))) throw new BrowserReportStorageError("This browser snapshot is invalid. Run a fresh investigation.");
  const report = validateExplainedReport(source.report), bytes = reportBytes(report);
  if (source.id !== report.id || source.bytes !== bytes) throw new BrowserReportStorageError("This browser snapshot is invalid. Run a fresh investigation.");
  return { schemaVersion: 1, id: report.id, savedAt: source.savedAt, lastOpenedAt: source.lastOpenedAt, bytes, report };
}

export function selectBrowserReportEvictions(rows: readonly Pick<BrowserSnapshot, "id" | "bytes" | "savedAt" | "lastOpenedAt">[], protectedId: string): string[] {
  let count = rows.length, bytes = rows.reduce((sum, entry) => sum + entry.bytes, 0);
  const evictions: string[] = [];
  for (const row of [...rows].filter((entry) => entry.id !== protectedId).sort((a, b) => a.lastOpenedAt.localeCompare(b.lastOpenedAt) || a.savedAt.localeCompare(b.savedAt) || a.id.localeCompare(b.id))) {
    if (count <= MAX_BROWSER_REPORTS && bytes <= MAX_BROWSER_REPORT_BYTES) break;
    evictions.push(row.id); count--; bytes -= row.bytes;
  }
  if (count > MAX_BROWSER_REPORTS || bytes > MAX_BROWSER_REPORT_BYTES) throw new BrowserReportStorageError("This report exceeds the browser snapshot limit. Download it instead.");
  return evictions;
}

function summary(row: BrowserSnapshot): BrowserReportSummary { return { id: row.id, token: row.report.token.address, name: row.report.token.name, savedAt: row.savedAt, lastOpenedAt: row.lastOpenedAt, bytes: row.bytes, fromBlock: row.report.range.from.number, toBlock: row.report.range.to.number }; }

async function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") throw new BrowserReportStorageError();
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error?: unknown) => { if (!settled) { settled = true; clearTimeout(timer); reject(storageError(error)); } };
    const timer = setTimeout(() => fail(), 5000);
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(databaseName, 1); } catch (error) { fail(error); return; }
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: "id" }); };
    request.onerror = () => fail(request.error);
    request.onblocked = () => fail();
    request.onsuccess = () => { if (settled) { request.result.close(); return; } settled = true; clearTimeout(timer); request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  });
}

async function transaction<T>(work: (store: IDBObjectStore, finish: (value: T) => void) => void): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(storeName, "readwrite"); let result: T, ready = false, failure: unknown;
      const timer = setTimeout(() => { failure = new BrowserReportStorageError(); try { tx.abort(); } catch { reject(failure); } }, 8000);
      tx.oncomplete = () => { clearTimeout(timer); if (ready) resolve(result!); else reject(new BrowserReportStorageError()); };
      tx.onabort = () => { clearTimeout(timer); reject(failure instanceof BrowserReportStorageError ? failure : storageError(tx.error)); };
      tx.onerror = (event) => { failure = (event.target as IDBRequest | null)?.error ?? tx.error; };
      try { work(tx.objectStore(storeName), (value) => { result = value; ready = true; }); } catch (error) { failure = error; tx.abort(); }
    });
  } catch (error) { throw error instanceof BrowserReportStorageError ? error : storageError(error); }
  finally { database.close(); }
}

function readValidSnapshots(store: IDBObjectStore, complete: (rows: BrowserSnapshot[]) => void) {
  const rows: BrowserSnapshot[] = []; let count = 0;
  const cursor = store.openCursor();
  cursor.onsuccess = () => {
    const entry = cursor.result;
    if (!entry) { try { complete(rows); } catch { store.transaction.abort(); } return; }
    if (++count > 100) { store.transaction.abort(); return; }
    try { rows.push(validateBrowserSnapshot(entry.value)); } catch { entry.delete(); }
    entry.continue();
  };
}

export async function listBrowserReports(): Promise<BrowserReportSummary[]> {
  return transaction((store, finish) => readValidSnapshots(store, (rows) => {
    const evictions = selectBrowserReportEvictions(rows, ""); evictions.forEach((id) => store.delete(id));
    finish(rows.filter((row) => !evictions.includes(row.id)).sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)).map(summary));
  }));
}

export async function saveBrowserReport(value: ExplainedInvestigationReport): Promise<{ snapshot: BrowserReportSummary; evicted: number }> {
  const report = validateExplainedReport(value), now = new Date().toISOString();
  const snapshot: BrowserSnapshot = { schemaVersion: 1, id: report.id, savedAt: now, lastOpenedAt: now, bytes: reportBytes(report), report };
  return transaction((store, finish) => readValidSnapshots(store, (rows) => {
    const evictions = selectBrowserReportEvictions([...rows.filter((row) => row.id !== report.id), snapshot], report.id);
    evictions.forEach((id) => store.delete(id)); store.put(snapshot);
    finish({ snapshot: summary(snapshot), evicted: evictions.length });
  }));
}

export async function openBrowserReport(id: string): Promise<OpenedBrowserReport> {
  return transaction<OpenedBrowserReport | null>((store, finish) => {
    const request = store.get(id);
    request.onsuccess = () => {
      let snapshot: BrowserSnapshot;
      try { snapshot = validateBrowserSnapshot(request.result); } catch { store.delete(id); finish(null); return; }
      snapshot.lastOpenedAt = new Date().toISOString(); store.put(snapshot); finish({ report: snapshot.report, savedAt: snapshot.savedAt });
    };
  }).then((value) => { if (!value) throw new BrowserReportStorageError("This browser snapshot is missing or invalid. Run a fresh investigation."); return value; });
}

export async function removeBrowserReport(id: string): Promise<void> { return transaction((store, finish) => { store.delete(id); finish(); }); }
export async function clearBrowserReports(): Promise<void> { return transaction((store, finish) => { store.clear(); finish(); }); }
