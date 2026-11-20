
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { generateK6Script } from "./generator.js";
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
    message?: string;
}

export interface K6ExecutionResult {
    success: boolean;
    exitCode: number | null;
    runId: string;
    metrics: K6Metrics;
    cleanupResult: CleanupResult;
    stdout: string;
    stderr: string;
}

interface CleanupOptions {
    baseUrl: string;
    cleanupPath: string;
    ids: string[];
    accessToken?: string;
    missingIdCount?: number;
    extractionErrorCount?: number;
}

interface DeleteOptions {
    baseUrl: string;
    cleanupPath: string;
    id: ResourceId;
    accessToken?: string;
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

// k6 로그에서 마커 이후 JSON 추출
function parseMarkerJson(line: string, marker: string): JsonRecord | null {
    const index = line.indexOf(marker);

    if (index === -1) {
        return null;
    }

    const text = line
        .slice(index + marker.length)
        .trim();

    try {
        const value: unknown = JSON.parse(text);
        return isRecord(value) ? value : null;
    } catch {
        return null;
    }
}

// Cleanup URL 생성
function buildCleanupUrl({
                             baseUrl,
                             cleanupPath,
                             id,
                         }: Pick<DeleteOptions, "baseUrl" | "cleanupPath" | "id">): URL {
    const base = new URL(baseUrl);

    const encodedId = encodeURIComponent(String(id));

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

// 개별 리소스 삭제
async function deleteResource({
                                  baseUrl,
                                  cleanupPath,
                                  id,
                                  accessToken,
                              }: DeleteOptions): Promise<number> {
    const url = buildCleanupUrl({
        baseUrl,
        cleanupPath,
        id,
    });

    const response = await fetch(url, {
        method: "DELETE",
        redirect: "error",
        headers: {
            ...(accessToken
                ? {
                    Authorization:
                        `Bearer ${accessToken}`,
                }
                : {}),
        },
        signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status}`
        );
    }

    return response.status;
}

// 생성된 리소스 전체 삭제
async function cleanupCreatedResources({
                                           baseUrl,
                                           cleanupPath,
                                           ids,
                                           accessToken,
                                           missingIdCount = 0,
                                           extractionErrorCount = 0,
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
                await deleteResource({
                    baseUrl,
                    cleanupPath,
                    id,
                    accessToken,
                });

                deleted++;
            } catch (error) {
                failed++;

                failedIds.push({
                    id,
                    message: errorMessage(error),
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
        failedIds: failedIds.slice(0, 100),
        message,
    };
}

export async function executeK6(config: K6TestConfig): Promise<K6ExecutionResult> {
    const reportName = generateReportName(config);

    const runId = randomUUID()
        .replaceAll("-", "")
        .slice(0, 12);

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

    const script = generateK6Script({
        ...config,
        runId,
    });

    await writeFile(
        scriptPath,
        script,
        "utf8"
    );

    return new Promise<K6ExecutionResult>((resolve, reject) => {
        const K6_PATH =
            process.env.K6_PATH || "k6";

        const child = spawn(
            K6_PATH,
            [
                "run",
                "--summary-export",
                reportPath,
                scriptPath,
            ],
            {
                shell: false,
                env: {
                    ...process.env,
                    ACCESS_TOKEN:
                        config.accessToken ?? "",
                },
            }
        );

        let stdout = "";
        let stderr = "";

        // 자동 삭제에 필요한 생성 ID
        const createdIds = new Set<string>();

        let missingIdCount = 0;
        let extractionErrorCount = 0;

        // stderr는 chunk 단위로 전달되므로
        // 줄 단위 파싱을 위한 버퍼 사용
        let stderrBuffer = "";

        function processStderrLine(line: string): void {
            const created = parseMarkerJson(
                line,
                CREATED_ID_PREFIX
            );

            if (
                created &&
                created.runId === runId
            ) {
                const id = created.id;

                if (
                    typeof id === "string" ||
                    typeof id === "number"
                ) {
                    createdIds.add(String(id));
                }

                return;
            }

            const missing = parseMarkerJson(
                line,
                ID_MISSING_PREFIX
            );

            if (
                missing &&
                missing.runId === runId
            ) {
                missingIdCount++;
                return;
            }

            const extractionFailed =
                parseMarkerJson(
                    line,
                    ID_EXTRACTION_FAILED_PREFIX
                );

            if (
                extractionFailed &&
                extractionFailed.runId === runId
            ) {
                extractionErrorCount++;
            }
        }

        child.stdout.on("data", (data) => {
            stdout += data.toString();
        });

        child.stderr.on("data", (data) => {
            const chunk = data.toString();

            // 기존 stderr 반환 기능 유지
            // 단, 메모리 사용량 제한
            if (
                stderr.length <
                MAX_CAPTURED_LOG_LENGTH
            ) {
                stderr += chunk.slice(
                    0,
                    MAX_CAPTURED_LOG_LENGTH -
                    stderr.length
                );
            }

            stderrBuffer += chunk;

            const lines =
                stderrBuffer.split(/\r?\n/);

            stderrBuffer = lines.pop() ?? "";

            for (const line of lines) {
                processStderrLine(line);
            }
        });

        child.on("error", reject);

        child.on("close", async (exitCode) => {
            try {
                // 마지막 줄에 개행이 없는 경우 처리
                if (stderrBuffer.trim()) {
                    processStderrLine(
                        stderrBuffer
                    );
                }

                const raw = await readFile(
                    reportPath,
                    "utf8"
                );

                const summary = JSON.parse(raw);

                const metrics =
                    extractMetrics(summary);

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
                                accessToken:
                                config.accessToken,
                                missingIdCount,
                                extractionErrorCount,
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
                            message: errorMessage(error),
                        };

                        console.error(
                            "[K6 CLEANUP ERROR]",
                            error
                        );
                    }
                }

                resolve({
                    success: exitCode === 0,
                    exitCode,
                    runId,
                    metrics,
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

