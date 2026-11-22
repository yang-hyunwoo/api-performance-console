import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile, readFile, open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { generateK6Script } from "./generator.js";
import { saveTestRun } from "./history.js";
import { generateScenarioScript, stepOutcomes, type ScenarioStep } from "./scenario.js";
import type { K6TestConfig } from "./server.js";

type ResourceId = string | number;
type JsonRecord = Record<string, unknown>;
interface MetricValues {
    values?: MetricValues;
    count?: number;
    rate?: number;
    avg?: number;
    "p(95)"?: number;
    value?: number;
    passes?: number;
    fails?: number;
}

interface K6Summary {
    metrics?: Record<string, MetricValues>;
}

export interface K6Metrics {
    totalRequests: number;
    rps: number;
    avgResponseTime: number;
    p95ResponseTime: number;
    failureRate: number;
}
interface FailedId {
    id: string;
    message: string;
    status?: number;
    attempts?: number;
}

interface CleanupResult {
    attempted: boolean;
    success: boolean | null;
    total?: number;
    deleted?: number;
    failed?: number;
    missingIdCount?: number;
    extractionErrorCount?: number;
    failedIds?: FailedId[];
    malformedMarkerCount?: number;
    mismatchedRunIdCount?: number;
    duplicateIdCount?: number;
    recoveryFile?: string;
    message?: string;
}

export interface ThresholdEvaluation {
    status: "PASS" | "FAIL" | "UNAVAILABLE" | "DISABLED";
    checks: Array<{ key: "p95" | "failureRate" | "rps"; label: string; operator: "<=" | "<" | ">="; target: number; actual: number; passed: boolean }>;
}

function evaluateThresholds(config: K6TestConfig, metrics: K6Metrics, available: boolean, cancelled: boolean): ThresholdEvaluation {
    if (!config.thresholds.enabled) return { status: "DISABLED", checks: [] };
    if (!available || cancelled) return { status: "UNAVAILABLE", checks: [] };
    const t = config.thresholds;
    const checks: ThresholdEvaluation["checks"] = [
        { key: "p95", label: "P95 응답 시간", operator: "<=", target: t.p95Ms, actual: metrics.p95ResponseTime, passed: metrics.p95ResponseTime <= t.p95Ms },
        { key: "failureRate", label: "HTTP 실패율", operator: "<", target: t.failureRatePercent, actual: metrics.failureRate, passed: metrics.failureRate < t.failureRatePercent },
        { key: "rps", label: "평균 RPS", operator: ">=", target: t.minRps, actual: metrics.rps, passed: metrics.rps >= t.minRps },
    ];
    return { status: checks.every(c => c.passed) ? "PASS" : "FAIL", checks };
}

export interface K6ExecutionResult {
    historySaved?: boolean;
    success: boolean;
    executionStatus: "completed" | "cancelled" | "error";
    thresholdEvaluation: ThresholdEvaluation;
    exitCode: number | null;
    runId: string;
    metrics: K6Metrics;
    metricsAvailable: boolean;
    metricsSource: "summary" | "json-stream" | "none";
    cleanupResult: CleanupResult;
    stdout: string;
    stderr: string;
    cancelled: boolean;
    scenarioSteps?: Array<Record<typeof stepOutcomes[number], number>>;
}

interface CleanupOptions {
    baseUrl: string;
    cleanupPath: string;
    ids: string[];
    requestHeaders: Record<string, string>;
    generateRequestId?: boolean;
    missingIdCount?: number;
    extractionErrorCount?: number;
    malformedMarkerCount?: number;
    mismatchedRunIdCount?: number;
    duplicateIdCount?: number;
}

interface DeleteOptions {
    baseUrl: string;
    cleanupPath: string;
    id: ResourceId;
    requestHeaders: Record<string, string>;
    generateRequestId?: boolean;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is JsonRecord {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function metricValues(value: K6Summary["metrics"], key: string): MetricValues {
    const entry = value?.[key];
    if (!entry) return {};
    if ("values" in entry) return entry.values ?? {};
    return entry;
}


const ROOT = process.cwd();

const CREATED_ID_PREFIX = "K6_CREATED_ID:";
const ID_MISSING_PREFIX = "K6_ID_MISSING:";
const ID_EXTRACTION_FAILED_PREFIX = "K6_ID_EXTRACTION_FAILED:";

// 삭제 요청 동시 실행 개수
const CLEANUP_CONCURRENCY = 5;
const CLEANUP_ATTEMPTS = 3;

// 생성 ID 로그가 많을 경우 무제한 메모리 사용 방지
const MAX_CAPTURED_LOG_LENGTH = 2_000_000;


function extractMetrics(summary: K6Summary): K6Metrics {
    const metrics = summary.metrics;
    const requests = metricValues(metrics, "http_reqs");
    const duration = metricValues(metrics, "http_req_duration");
    const failed = metricValues(metrics, "http_req_failed");

    const failureRate =
        failed.rate ??
        failed.value ??
        (
            failed.passes != null &&
            failed.fails != null
                ? failed.passes /
                (failed.passes + failed.fails || 1)
                : 0
        );

    return {
        totalRequests: requests.count ?? 0,
        rps: Number(
            (requests.rate ?? 0).toFixed(2)
        ),
        avgResponseTime: Number(
            (duration.avg ?? 0).toFixed(2)
        ),
        p95ResponseTime: Number(
            (duration["p(95)"] ?? 0).toFixed(2)
        ),
        failureRate: Number(
            (failureRate * 100).toFixed(2)
        ),
    };
}

// k6 --out json 파일은 JSON 배열이 아닌 줄 단위 JSON(JSONL)입니다.
// 강제 종료로 summary가 생성되지 않았을 때 이미 기록된 샘플을 집계합니다.
// p95 계산에 사용하는 샘플은 메모리 보호를 위해 최대 200,000개로 제한합니다.
const MAX_DURATION_SAMPLES = 200_000;

async function extractMetricsFromJsonStream(
    filePath: string,
    elapsedSeconds: number
): Promise<K6Metrics | null> {
    let totalRequests = 0;
    let durationCount = 0;
    let durationSum = 0;
    let failureCount = 0;
    let failureSamples = 0;
    const durations: number[] = [];

    const input = createReadStream(filePath, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });

    try {
        for await (const line of lines) {
            if (!line.trim()) continue;
            let item: unknown;
            try {
                item = JSON.parse(line);
            } catch {
                // 프로세스가 종료되면서 마지막 JSON 줄이 잘릴 수 있습니다.
                continue;
            }
            if (!isRecord(item) || item.type !== "Point" || !isRecord(item.data)) continue;
            const value = item.data.value;
            if (typeof value !== "number" || !Number.isFinite(value)) continue;

            if (item.metric === "http_reqs") {
                totalRequests++;
            } else if (item.metric === "http_req_duration") {
                durationCount++;
                durationSum += value;
                if (durations.length < MAX_DURATION_SAMPLES) {
                    durations.push(value);
                } else {
                    // Reservoir sampling으로 p95 표본을 메모리 상한 내에서 유지합니다.
                    const index = Math.floor(Math.random() * durationCount);
                    if (index < MAX_DURATION_SAMPLES) durations[index] = value;
                }
            } else if (item.metric === "http_req_failed") {
                failureSamples++;
                if (value > 0) failureCount++;
            }
        }
    } finally {
        lines.close();
        input.destroy();
    }

    if (totalRequests === 0 && durationCount === 0 && failureSamples === 0) {
        return null;
    }

    durations.sort((a, b) => a - b);
    const p95Index = Math.max(0, Math.ceil(durations.length * 0.95) - 1);
    return {
        totalRequests,
        rps: Number((totalRequests / Math.max(elapsedSeconds, 0.001)).toFixed(2)),
        avgResponseTime: Number((durationCount ? durationSum / durationCount : 0).toFixed(2)),
        p95ResponseTime: Number((durations[p95Index] ?? 0).toFixed(2)),
        failureRate: Number((failureSamples ? (failureCount / failureSamples) * 100 : 0).toFixed(2)),
    };
}

// k6의 로그 접두어/접미어와 관계없이 마커 뒤의 첫 JSON 객체를 추출합니다.
// 예: ERRO[0001] K6_CREATED_ID:{"runId":"...","id":"1"} source=console
function parseMarkerJson(line: string, marker: string): JsonRecord | null {
    const pos = line.indexOf(marker);
    if (pos < 0) return null;
    const after = line.slice(pos + marker.length);
    // k6 logfmt: msg="K6_CREATED_ID:{\"runId\":...}" source=console
    // 로그 메시지 내부의 JSON 이스케이프를 우선 복원합니다.
    const raw = after.startsWith("{\\\"")
        ? after.replace(/\\"/g, '"')
        : after;
    const start = raw.indexOf("{");
    if (start < 0) return null;
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < raw.length; i++) {
        const c = raw[i];
        if (escaped) { escaped = false; continue; }
        if (c === "\\" && inString) { escaped = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c === "{") depth++;
        if (c === "}" && --depth === 0) {
            try { const value: unknown = JSON.parse(raw.slice(start, i + 1)); return isRecord(value) ? value : null; }
            catch { return null; }
        }
    }
    return null;
}

// Cleanup URL 생성
function buildCleanupUrl({
                             baseUrl,
                             cleanupPath,
                             id,
                         }: Pick<DeleteOptions, "baseUrl" | "cleanupPath" | "id">): URL {
    const base = new URL(baseUrl);

    const encodedId = encodeURIComponent(String(id));

    if (!cleanupPath.includes("{id}")) {
        throw new Error("Cleanup DELETE 경로에 {id}가 없습니다.");
    }

    const relativePath = cleanupPath.replace(
        "{id}",
        encodedId
    );

    const url = new URL(relativePath, base);

    // 다른 서버로 DELETE 요청이 나가는 것 방지
    if (url.origin !== base.origin) {
        throw new Error(
            "Cleanup URL이 테스트 대상 서버와 다릅니다."
        );
    }

    if (
        !["localhost", "127.0.0.1"].includes(
            url.hostname
        )
    ) {
        throw new Error(
            "로컬 서버만 자동 삭제할 수 있습니다."
        );
    }

    return url;
}

// 일시적 오류만 재시도합니다. 404는 이미 삭제된 것으로 추정하지 않습니다.
class DeleteHttpError extends Error {
    constructor(public readonly status: number) { super(`HTTP ${status}`); }
}
async function deleteResource(options: DeleteOptions): Promise<number> {
    const url = buildCleanupUrl(options);
    const response = await fetch(url, {
        method: "DELETE", redirect: "error",
        headers: {
            ...options.requestHeaders,
            ...(options.generateRequestId && { "x-request-id": randomUUID() }),
        },
        signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new DeleteHttpError(response.status);
    return response.status;
}
function retryable(error: unknown): boolean {
    if (error instanceof DeleteHttpError) return [408, 429, 500, 502, 503, 504].includes(error.status);
    return error instanceof TypeError || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name));
}
async function deleteWithRetry(options: DeleteOptions): Promise<{attempts: number}> {
    for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt++) {
        try { await deleteResource(options); return { attempts: attempt }; }
        catch (error) {
            if (attempt === CLEANUP_ATTEMPTS || !retryable(error)) {
                if (error instanceof Error) Object.assign(error, { attempts: attempt });
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 500 * (2 ** (attempt - 1))));
        }
    }
    throw new Error("DELETE retry exhausted");
}

// 생성된 리소스 전체 삭제
async function cleanupCreatedResources({
                                           baseUrl,
                                           cleanupPath,
                                           ids,
                                           requestHeaders,
                                           generateRequestId,
                                           missingIdCount = 0,
                                           extractionErrorCount = 0,
                                           malformedMarkerCount = 0,
                                           mismatchedRunIdCount = 0,
                                           duplicateIdCount = 0,
                                       }: CleanupOptions): Promise<CleanupResult> {
    const uniqueIds = [...new Set(ids)];

    let deleted = 0;
    let failed = 0;

    const failedIds: FailedId[] = [];

    let nextIndex = 0;

    async function worker() {
        while (true) {
            const index = nextIndex++;

            if (index >= uniqueIds.length) {
                return;
            }

            const id = uniqueIds[index];

            try {
                await deleteWithRetry({
                    baseUrl,
                    cleanupPath,
                    id,
                    requestHeaders,
                    generateRequestId,
                });

                deleted++;
            } catch (error) {
                failed++;

                failedIds.push({
                    id,
                    message: errorMessage(error),
                    status: error instanceof DeleteHttpError ? error.status : undefined,
                    attempts: error instanceof Error && "attempts" in error ? Number(error.attempts) : 1,
                });
            }
        }
    }

    const workerCount = Math.min(
        CLEANUP_CONCURRENCY,
        uniqueIds.length
    );

    await Promise.all(
        Array.from(
            { length: workerCount },
            () => worker()
        )
    );

    const success =
        failed === 0 &&
        missingIdCount === 0 &&
        extractionErrorCount === 0 &&
        malformedMarkerCount === 0 &&
        mismatchedRunIdCount === 0 &&
        duplicateIdCount === 0 &&
        uniqueIds.length > 0;

    let message;

    if (uniqueIds.length === 0) {
        message =
            "수집된 생성 ID가 없어 삭제하지 못했습니다.";
    } else if (
        missingIdCount > 0 ||
        extractionErrorCount > 0
    ) {
        message =
            "일부 POST 응답에서 ID를 추출하지 못했습니다.";
    } else if (failed > 0) {
        message =
            `${failed}건의 DELETE 요청이 실패했습니다.`;
    } else {
        message =
            `${deleted}건의 DELETE 요청이 성공했습니다.`;
    }

    return {
        attempted: true,
        success,
        total: uniqueIds.length,
        deleted,
        failed,
        missingIdCount,
        extractionErrorCount,
        malformedMarkerCount,
        mismatchedRunIdCount,
        duplicateIdCount,
        failedIds,
        message,
    };
}

type ActiveRun = {
    runId: string;
    scenarioRequestId?: string;
    startedAt: string;
    phase: "preparing" | "running" | "cleaning";
    cancelled: boolean;
    child: ChildProcess | null;
};

let activeRun: ActiveRun | null = null;

// SSE subscribers are scoped to the local runner process.
export interface LiveSnapshot {
    runId: string;
    phase: "preparing" | "running" | "cleaning";
    cancelled: boolean;
    elapsedSeconds: number;
    totalRequests: number;
    rps: number; // most recent 5-second window
    avgResponseTime: number; // cumulative mean (ms)
    p95ResponseTime: number; // cumulative p95 (ms), sampled for memory safety
    activeVus: number | null; // latest k6 vus gauge
    targetVus: number | null; // planned VUs, not an observed measurement
    failureRate: number; // cumulative percentage
    metricsAvailable: boolean;
}

const liveListeners = new Set<(snapshot: LiveSnapshot | null) => void>();
let latestLiveSnapshot: LiveSnapshot | null = null;
export function subscribeK6Metrics(listener: (snapshot: LiveSnapshot | null) => void): () => void {
    liveListeners.add(listener);
    listener(latestLiveSnapshot);
    return () => { liveListeners.delete(listener); };
}
function publishK6Metrics(snapshot: LiveSnapshot | null): void {
    latestLiveSnapshot = snapshot;
    for (const listener of liveListeners) {
        try { listener(snapshot); } catch (error) { console.error("[K6 SSE LISTENER]", error); }
    }
}

// Incremental JSONL reader: only new bytes are parsed each second.
function durationToSeconds(duration: string): number {
    const match = /^(\d+)(s|m)$/.exec(duration);
    return match ? Number(match[1]) * (match[2] === "m" ? 60 : 1) : 0;
}

function plannedVus(config: K6TestConfig, elapsed: number): number | null {
    if (config.method === "DELETE") return null; // shared-iterations has no ramp schedule
    if (config.loadMode !== "ramping") return config.vus;
    const up = durationToSeconds(config.rampUpDuration ?? "30s");
    const hold = durationToSeconds(config.holdDuration ?? "30s");
    const down = durationToSeconds(config.rampDownDuration ?? "30s");
    const max = config.vus;
    if (up <= 0 || down <= 0) return null;
    if (elapsed < up) return max * elapsed / up;
    if (elapsed < up + hold) return max;
    if (elapsed < up + hold + down) return max * (1 - (elapsed - up - hold) / down);
    return 0;
}

function startLiveMetrics(run: ActiveRun, filePath: string, config: K6TestConfig): () => void {
    let offset = 0;
    let pending = "";
    let busy = false;
    let stopped = false;
    let requests = 0;
    let durationCount = 0;
    let durationSum = 0;
    // Keep a bounded reservoir of response durations for live P95.
    const liveDurations: number[] = [];
    const MAX_LIVE_DURATION_SAMPLES = 20_000;
    let failedCount = 0;
    let failedSamples = 0;
    let activeVus: number | null = null;
    const recentRequests: number[] = [];
    const started = Date.parse(run.startedAt);

    const handleLine = (line: string) => {
        let entry: unknown;
        try { entry = JSON.parse(line); } catch { return; }
        if (!isRecord(entry) || entry.type !== "Point" || !isRecord(entry.data)) return;
        const value = entry.data.value;
        if (typeof value !== "number" || !Number.isFinite(value)) return;
        if (entry.metric === "vus") {
            activeVus = Math.max(0, Math.round(value));
        } else if (entry.metric === "http_reqs") {
            requests++;
            const timestamp = typeof entry.data.time === "string" ? Date.parse(entry.data.time) : NaN;
            recentRequests.push(Number.isFinite(timestamp) ? timestamp : Date.now());
        } else if (entry.metric === "http_req_duration") {
            durationCount++;
            durationSum += value;
            if (liveDurations.length < MAX_LIVE_DURATION_SAMPLES) {
                liveDurations.push(value);
            } else {
                // Reservoir sampling keeps a representative bounded sample.
                const index = Math.floor(Math.random() * durationCount);
                if (index < MAX_LIVE_DURATION_SAMPLES) liveDurations[index] = value;
            }
        } else if (entry.metric === "http_req_failed") {
            failedSamples++;
            if (value > 0) failedCount++;
        }
    };

    const tick = async () => {
        if (busy || stopped) return;
        busy = true;
        try {
            let file;
            try { file = await open(filePath, "r"); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[K6 LIVE READ]", error);
                return;
            }
            try {
                const stat = await file.stat();
                if (stat.size < offset) { offset = 0; pending = ""; }
                const available = stat.size - offset;
                if (available > 0) {
                    // Limit each read to 1 MB to avoid large transient allocations.
                    let remaining = available;
                    while (remaining > 0) {
                        const length = Math.min(remaining, 1024 * 1024);
                        const buffer = Buffer.allocUnsafe(length);
                        const { bytesRead } = await file.read(buffer, 0, length, offset);
                        if (!bytesRead) break;
                        offset += bytesRead;
                        remaining -= bytesRead;
                        pending += buffer.subarray(0, bytesRead).toString("utf8");
                        const lines = pending.split("\n");
                        pending = lines.pop() ?? "";
                        for (const line of lines) handleLine(line.trim());
                    }
                }
            } finally { await file.close(); }
        } catch (error) {
            console.warn("[K6 LIVE METRICS]", errorMessage(error));
        } finally {
            const now = Date.now();
            while (recentRequests.length && recentRequests[0] < now - 5000) recentRequests.shift();
            const elapsedSeconds = Math.max(0, (now - started) / 1000);
            // Sort a copy so reservoir replacement does not affect percentile calculation.
            const sortedDurations = [...liveDurations].sort((a, b) => a - b);
            const p95Index = Math.max(0, Math.ceil(sortedDurations.length * 0.95) - 1);
            const p95ResponseTime = sortedDurations[p95Index] ?? 0;
            if (!stopped) publishK6Metrics({
                runId: run.runId, phase: run.phase, cancelled: run.cancelled,
                elapsedSeconds: Number(elapsedSeconds.toFixed(1)),
                totalRequests: requests,
                rps: Number((recentRequests.length / Math.min(5, Math.max(elapsedSeconds, 1))).toFixed(2)),
                avgResponseTime: Number((durationCount ? durationSum / durationCount : 0).toFixed(2)),
                p95ResponseTime: Number(p95ResponseTime.toFixed(2)),
                activeVus,
                targetVus: plannedVus(config, elapsedSeconds),
                failureRate: Number((failedSamples ? failedCount / failedSamples * 100 : 0).toFixed(2)),
                metricsAvailable: requests > 0 || durationCount > 0 || failedSamples > 0,
            });
            busy = false;
        }
    };
    const timer = setInterval(() => { void tick(); }, 1000);
    void tick();
    return () => { stopped = true; clearInterval(timer); };
}


export function getActiveK6Run() {
    if (!activeRun) return { running: false as const };
    const { runId, startedAt, phase, cancelled } = activeRun;
    return { running: true as const, runId, startedAt, phase, cancelled };
}

export function cancelActiveK6Run(scenarioRequestId?: string): "not-running" | "already-cancelled" | "accepted" | "cleaning" {
    if (!activeRun || (scenarioRequestId !== undefined && activeRun.scenarioRequestId !== scenarioRequestId)) return "not-running";
    if (activeRun.phase === "cleaning") return "cleaning";
    if (activeRun.cancelled) return "already-cancelled";
    activeRun.cancelled = true;
    if (activeRun.child && activeRun.child.exitCode === null) {
        activeRun.child.kill("SIGINT");
        const child = activeRun.child;
        const timer = setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
        }, 5000);
        timer.unref();
        child.once("close", () => clearTimeout(timer));
    }
    return "accepted";
}

export function executeK6(config: K6TestConfig, scenario?: ScenarioStep[], scenarioRequestId?: string): Promise<K6ExecutionResult> {
    if (activeRun) return Promise.reject(new Error("이미 실행 중인 k6 테스트가 있습니다."));
    const runId = randomUUID().replaceAll("-", "").slice(0, 12);
    const run: ActiveRun = { runId, scenarioRequestId, startedAt: new Date().toISOString(), phase: "preparing", cancelled: false, child: null };
    activeRun = run;
    return executeK6Internal(config, run, scenario).then(result => {
        try {
            saveTestRun(config, result, run.startedAt, scenario);
            return { ...result, historySaved: true };
        } catch (error) {
            console.error("[TEST HISTORY SAVE]", error);
            return { ...result, historySaved: false };
        }
    }).finally(() => {
        if (activeRun === run) { activeRun = null; publishK6Metrics(null); }
    });
}

async function executeK6Internal(config: K6TestConfig, run: ActiveRun, scenario?: ScenarioStep[]): Promise<K6ExecutionResult> {
    const { runId } = run;
    const reportName = generateReportName(config);

    const generatedDir = path.join(
        ROOT,
        "generated"
    );

    const reportsDir = path.join(
        ROOT,
        "reports"
    );

    await mkdir(generatedDir, {
        recursive: true,
    });

    await mkdir(reportsDir, {
        recursive: true,
    });

    const scriptPath = path.join(
        generatedDir,
        `${reportName}.js`
    );

    const reportPath = path.join(
        reportsDir,
        `${reportName}.json`
    );

    const metricsPath = path.join(reportsDir, `${reportName}_metrics.jsonl`);

    const requestHeaders = {
        ...(config.accessToken && { authorization: `Bearer ${config.accessToken}` }),
        ...Object.fromEntries(Object.entries(config.commonHeaders ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
    };
    const script = scenario
        ? generateScenarioScript(config.baseUrl, config.vus, config.duration, scenario, runId, config.sleepSeconds)
        : generateK6Script({ ...config, runId });

    await writeFile(
        scriptPath,
        script,
        "utf8"
    );

    if (run.cancelled) return {
        success: false, executionStatus: "cancelled", thresholdEvaluation: { status: "UNAVAILABLE", checks: [] }, exitCode: null, runId, cancelled: true,
        metrics: { totalRequests: 0, rps: 0, avgResponseTime: 0, p95ResponseTime: 0, failureRate: 0 },
        metricsAvailable: false, metricsSource: "none",
        cleanupResult: { attempted: false, success: null }, stdout: "", stderr: "테스트 시작 전 취소됨",
    };
    return new Promise<K6ExecutionResult>((resolve, reject) => {
        const K6_PATH =
            process.env.K6_PATH || "k6";

        const child = spawn(
            K6_PATH,
            [
                "run",
                "--summary-export",
                reportPath,
                "--out",
                `json=${metricsPath}`,
                scriptPath,
            ],
            {
                shell: false,
                env: {
                    ...process.env,
                    ...(scenario && { SCENARIO_HEADERS: JSON.stringify(scenario.map(step => step.headers)) }),
                    ACCESS_TOKEN: "",
                    COMMON_REQUEST_HEADERS: JSON.stringify(requestHeaders),
                    GENERATE_REQUEST_ID: config.generateRequestId ? "1" : "0",
                    // HTTP debug output can include credentials.
                    K6_HTTP_DEBUG: undefined,
                },
            }
        );

        run.child = child;
        run.phase = "running";
        const stopLiveMetrics = startLiveMetrics(run, metricsPath, config);
        if (run.cancelled) child.kill("SIGINT");
        let stdout = "";
        let stderr = "";

        // 자동 삭제에 필요한 생성 ID
        const createdIds = new Set<string>();

        let missingIdCount = 0;
        let extractionErrorCount = 0;
        let createdMarkerCount = 0;
        let malformedMarkerCount = 0;
        let mismatchedRunIdCount = 0;
        let duplicateIdCount = 0;

        // stdout과 stderr 양쪽에서 로그를 수집합니다.
        // 스트림별로 버퍼를 유지해 chunk 경계에서 JSON이 잘리는 문제를 방지합니다.
        let stdoutBuffer = "";
        let stderrBuffer = "";

        function processLogLine(line: string): void {
            if (line.includes(CREATED_ID_PREFIX)) {
                createdMarkerCount++;
                const created = parseMarkerJson(line, CREATED_ID_PREFIX);
                if (!created) {
                    malformedMarkerCount++;

                    if (malformedMarkerCount <= 3) {
                        console.error("[K6 MALFORMED ID LOG]", {
                            raw: JSON.stringify(line),
                            markerIndex: line.indexOf(CREATED_ID_PREFIX),
                            afterMarker: JSON.stringify(
                                line.slice(
                                    line.indexOf(CREATED_ID_PREFIX) +
                                    CREATED_ID_PREFIX.length
                                )
                            ),
                        });
                    }

                    return;
                }
                if (created.runId !== runId) {
                    mismatchedRunIdCount++;
                    return;
                }
                const id = created.id;
                if (
                    (typeof id === "string" && id.trim() !== "") ||
                    (typeof id === "number" && Number.isFinite(id))
                ) {
                    if (createdIds.has(String(id))) duplicateIdCount++;
                    createdIds.add(String(id));
                } else {
                    malformedMarkerCount++;
                }
                return;
            }

            const missing = parseMarkerJson(line, ID_MISSING_PREFIX);
            if (missing && missing.runId === runId) {
                missingIdCount++;
                return;
            }

            const extractionFailed = parseMarkerJson(
                line,
                ID_EXTRACTION_FAILED_PREFIX
            );
            if (extractionFailed && extractionFailed.runId === runId) {
                extractionErrorCount++;
            }
        }

        function consumeChunk(
            chunk: string,
            stream: "stdout" | "stderr"
        ): void {
            const combined =
                (stream === "stdout" ? stdoutBuffer : stderrBuffer) + chunk;
            const lines = combined.split(/\r?\n/);
            const remainder = lines.pop() ?? "";

            if (stream === "stdout") stdoutBuffer = remainder;
            else stderrBuffer = remainder;

            for (const line of lines) processLogLine(line);
        }

        child.stdout.on("data", (data: Buffer) => {
            const chunk = data.toString();
            if (stdout.length < MAX_CAPTURED_LOG_LENGTH) {
                stdout += chunk.slice(0, MAX_CAPTURED_LOG_LENGTH - stdout.length);
            }
            consumeChunk(chunk, "stdout");
        });

        child.stderr.on("data", (data: Buffer) => {
            const chunk = data.toString();
            if (stderr.length < MAX_CAPTURED_LOG_LENGTH) {
                stderr += chunk.slice(0, MAX_CAPTURED_LOG_LENGTH - stderr.length);
            }
            consumeChunk(chunk, "stderr");
        });

        child.on("error", (error) => { stopLiveMetrics(); reject(error); });

        child.on("close", async (exitCode) => {
            stopLiveMetrics();
            run.phase = "cleaning";
            try {
                // 마지막 줄에 개행이 없는 경우 처리
                if (stderrBuffer.trim()) processLogLine(stderrBuffer);
                if (stdoutBuffer.trim()) processLogLine(stdoutBuffer);

                console.log("[K6 ID COLLECTION]", {
                    runId,
                    createdMarkerCount,
                    collectedIds: createdIds.size,
                    malformedMarkerCount,
                    mismatchedRunIdCount,
                    missingIdCount,
                    extractionErrorCount,
                    duplicateIdCount,
                });

                let metrics: K6Metrics = { totalRequests: 0, rps: 0, avgResponseTime: 0, p95ResponseTime: 0, failureRate: 0 };
                let scenarioSteps: K6ExecutionResult["scenarioSteps"];
                let metricsAvailable = false;
                let metricsSource: K6ExecutionResult["metricsSource"] = "none";
                try {
                    const raw = await readFile(reportPath, "utf8");
                    const summary = JSON.parse(raw) as K6Summary;
                    if (scenario && summary.metrics) {
                        scenarioSteps = scenario.map((_, index) => {
                            const counts = { succeeded: 0, http_failed: 0, extraction_failed: 0, skipped: 0, request_failed: 0 };
                            for (const outcome of stepOutcomes) {
                                counts[outcome] = metricValues(summary.metrics, `scenario_step_${index + 1}_${outcome}`).count ?? 0;
                            }
                            return counts;
                        });
                    }
                    if (!summary.metrics?.http_reqs) {
                        throw new Error("summary에 http_reqs 메트릭이 없습니다.");
                    }
                    metrics = extractMetrics(summary);
                    metricsAvailable = true;
                    metricsSource = "summary";
                } catch (error) {
                    console.warn("[K6 SUMMARY UNAVAILABLE] JSON 스트림으로 복구 시도:", errorMessage(error));
                    try {
                        const elapsedSeconds = (Date.now() - Date.parse(run.startedAt)) / 1000;
                        const partial = await extractMetricsFromJsonStream(metricsPath, elapsedSeconds);
                        if (partial) {
                            metrics = partial;
                            metricsAvailable = true;
                            metricsSource = "json-stream";
                            console.log("[K6 PARTIAL METRICS]", { runId, ...metrics });
                        } else {
                            console.warn("[K6 METRICS UNAVAILABLE] 기록된 메트릭 샘플이 없습니다.");
                        }
                    } catch (fallbackError) {
                        console.error("[K6 METRICS RECOVERY ERROR]", fallbackError);
                    }
                }

                let cleanupResult: CleanupResult = {
                    attempted: false,
                    success: null,
                };

                const shouldCleanup =
                    config.method.toUpperCase() ===
                    "POST" &&
                    config.autoCleanup === true;

                if (shouldCleanup) {
                    try {
                        cleanupResult =
                            await cleanupCreatedResources({
                                baseUrl: config.baseUrl,
                                cleanupPath:
                                config.cleanupPath,
                                ids: [...createdIds],
                                requestHeaders,
                                generateRequestId: config.generateRequestId,
                                missingIdCount,
                                extractionErrorCount,
                                malformedMarkerCount,
                                mismatchedRunIdCount,
                                duplicateIdCount,
                            });

                        console.log(
                            "[K6 CLEANUP]",
                            {
                                runId,
                                ...cleanupResult,
                            }
                        );
                    } catch (error) {
                        cleanupResult = {
                            attempted: true,
                            success: false,
                            total: createdIds.size,
                            deleted: 0,
                            failed: 0,
                            missingIdCount,
                            extractionErrorCount,
                            malformedMarkerCount,
                            mismatchedRunIdCount,
                            duplicateIdCount,
                            message: errorMessage(error),
                        };

                        console.error(
                            "[K6 CLEANUP ERROR]",
                            error
                        );
                    }
                }

                if (shouldCleanup && cleanupResult.failedIds?.length) {
                    try {
                        const recoveryDir = path.join(ROOT, "reports", "cleanup-recovery");
                        await mkdir(recoveryDir, { recursive: true });
                        const recoveryFile = path.join(recoveryDir, `${runId}.json`);
                        await writeFile(recoveryFile, JSON.stringify({
                            runId, baseUrl: config.baseUrl, cleanupPath: config.cleanupPath,
                            startedAt: run.startedAt, failedIds: cleanupResult.failedIds,
                            createdAt: new Date().toISOString()
                        }, null, 2), "utf8");
                        cleanupResult.recoveryFile = `cleanup-recovery/${runId}.json`;
                    } catch (error) {
                        console.error("[K6 RECOVERY SAVE ERROR]", error);
                        cleanupResult.message = `${cleanupResult.message ?? "자동 삭제 결과"} / 복구 파일 저장 실패: ${errorMessage(error)}`;
                    }
                }
                const thresholdEvaluation = evaluateThresholds(config, metrics, metricsAvailable, run.cancelled);
                // k6 exit 99: threshold failure. Distinguish performance FAIL from execution error.
                const executionStatus = run.cancelled ? "cancelled" :
                    (exitCode === 0 || (exitCode === 99 && metricsSource === "summary" && config.thresholds.enabled))
                        ? "completed" : "error";
                if (executionStatus !== "completed" && thresholdEvaluation.status !== "DISABLED") {
                    thresholdEvaluation.status = "UNAVAILABLE";
                    thresholdEvaluation.checks = [];
                }
                resolve({
                    success: executionStatus === "completed",
                    executionStatus,
                    thresholdEvaluation,
                    scenarioSteps,
                    cancelled: run.cancelled,
                    exitCode,
                    runId,
                    metrics,
                    metricsAvailable,
                    metricsSource,
                    cleanupResult,
                    stdout,
                    stderr,
                });
            } catch (error) {
                reject(error);
            }
        });
    });
}

function generateReportName(config: K6TestConfig): string {
    const now = new Date();

    const formatter = new Intl.DateTimeFormat(
        "sv-SE",
        {
            timeZone: "Asia/Seoul",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
        }
    );

    const dateTime = formatter
        .format(now)
        .replace(" ", "_")
        .replaceAll(":", "-");

    const method = (
        config.method ?? "GET"
    )
        .toUpperCase()
        .replace(/[^A-Z]/g, "");

    const apiPath = (
        config.path ?? "unknown"
    )
        .replace(/\{([^}]+)\}/g, "$1")
        .replace(
            /[^a-zA-Z0-9가-힣_-]/g,
            "_"
        )
        .replace(/^_+|_+$/g, "")
        .slice(0, 100);

    const uniqueId = randomUUID()
        .slice(0, 8);

    return (
        `${dateTime}_${method}_` +
        `${apiPath}_${uniqueId}`
    );
}
