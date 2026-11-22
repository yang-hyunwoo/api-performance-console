import express from "express";
import cors from "cors";
import type { Request, Response } from "express";
import { parseOperations } from "./openapi.js";
import { parseScenario } from "./scenario.js";
import { getTestHistory } from "./history.js";
import { executeK6, getActiveK6Run, cancelActiveK6Run, subscribeK6Metrics } from "./runner.js";

const app = express();
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json({ limit: "1mb" }));

const PORT = 4000;
const HOST = "127.0.0.1";
const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const DISTRIBUTION_METHODS = ["PUT", "PATCH", "DELETE"] as const;
const ALLOWED_HOSTS = ["localhost", "127.0.0.1"];

type HttpMethod = (typeof ALLOWED_METHODS)[number];
type PathIdMode = "same" | "distributed";
type JsonObject = Record<string, unknown>;

export interface K6TestConfig {
    baseUrl: string;
    method: HttpMethod;
    path: string;
    vus: number;
    duration: "10s" | "30s" | "1m" | "3m";
    loadMode: "constant" | "ramping";
    rampUpDuration: "10s" | "30s" | "1m" | "3m";
    holdDuration: "10s" | "30s" | "1m" | "3m";
    rampDownDuration: "10s" | "30s" | "1m" | "3m";
    query: JsonObject;
    requestBody: JsonObject | null;
    uniqueFields: string[];
    sleepSeconds: number;
    pathIds: Array<string | number>;
    pathIdParameter: string;
    pathIdMode: PathIdMode;
    autoCleanup: boolean;
    cleanupPath: string;
    cleanupIdField: string;
    accessToken?: string;
    commonHeaders?: Record<string, string>;
    generateRequestId?: boolean;
    thresholds: { enabled: boolean; p95Ms: number; failureRatePercent: number; minRps: number };
}

function isRecord(value: unknown): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidRequestSettings(value: JsonObject): value is JsonObject & Pick<K6TestConfig, "commonHeaders" | "generateRequestId"> {
    const { commonHeaders, generateRequestId } = value;
    if (generateRequestId !== undefined && typeof generateRequestId !== "boolean") return false;
    if (commonHeaders === undefined) return true;
    if (!isRecord(commonHeaders) || JSON.stringify(commonHeaders).length > 16000) return false;

    const names = new Set<string>();
    const entries = Object.entries(commonHeaders);
    if (entries.length > 32) return false;
    for (const [name, headerValue] of entries) {
        const normalized = name.toLowerCase();
        if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(normalized) || normalized.length > 100 ||
            /^(host|content-length|transfer-encoding|connection|proxy-.*|upgrade|te|trailer|keep-alive)$/.test(normalized) ||
            names.has(normalized) || (generateRequestId && normalized === "x-request-id") ||
            typeof headerValue !== "string" || headerValue.length > 8192 || /[\x00-\x1f\x7f]/.test(headerValue)) {
            return false;
        }
        names.add(normalized);
    }
    return true;
}

function isLocalUrl(url: URL): boolean {
    return ALLOWED_HOSTS.includes(url.hostname) &&
        ["http:", "https:"].includes(url.protocol) &&
        !url.username && !url.password;
}

function isValidRelativePath(path: unknown): path is string {
    if (typeof path !== "string" || !path.startsWith("/") ||
        path.startsWith("//") || path.includes("\\") ||
        path.includes("?") || path.includes("#") || /[\r\n]/.test(path)) {
        return false;
    }
    if (/%(?:2f|5c|3f|23|0[0-9a-f]|1[0-9a-f]|7f)/i.test(path)) return false;
    if (path.split("/").some(segment => segment === "." || segment === "..")) return false;
    return true;
}

function isValidCleanupPath(path: unknown): path is string {
    if (!isValidRelativePath(path)) return false;
    const matches = path.match(/\{id\}/g) ?? [];
    if (matches.length !== 1) return false;
    return !/[{}]/.test(path.replace("{id}", ""));
}

function isValidCleanupIdField(field: unknown): field is string {
    return typeof field === "string" && field.length > 0 && field.length <= 200 &&
        /^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*)*$/.test(field) &&
        !field.split(".").some(part => ["__proto__", "prototype", "constructor"].includes(part));
}
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
}

function isValidThresholds(value: unknown): boolean {
    if (!isRecord(value)) return false;
    return typeof value.enabled === "boolean" &&
        typeof value.p95Ms === "number" && Number.isFinite(value.p95Ms) && value.p95Ms > 0 && value.p95Ms <= 600000 &&
        typeof value.failureRatePercent === "number" && Number.isFinite(value.failureRatePercent) && value.failureRatePercent > 0 && value.failureRatePercent <= 100 &&
        typeof value.minRps === "number" && Number.isFinite(value.minRps) && value.minRps > 0 && value.minRps <= 1000000;
}

function isTestConfig(value: unknown): value is K6TestConfig {
    if (!isRecord(value)) return false;
    const { baseUrl, method, path, vus, duration, query, requestBody,
        uniqueFields, sleepSeconds, pathIds, pathIdParameter, pathIdMode,
        loadMode, rampUpDuration, holdDuration, rampDownDuration,
        autoCleanup, cleanupPath, cleanupIdField, accessToken, thresholds } = value;
    return typeof baseUrl === "string" &&
        typeof method === "string" && ALLOWED_METHODS.some(m => m === method.toUpperCase()) &&
        isValidRelativePath(path) &&
        typeof vus === "number" && Number.isInteger(vus) && vus >= 1 && vus <= 1501 &&
        typeof duration === "string" && ["10s", "30s", "1m", "3m"].includes(duration) &&
        (loadMode === "constant" || loadMode === "ramping") &&
        [rampUpDuration, holdDuration, rampDownDuration].every(d => typeof d === "string" && ["10s", "30s", "1m", "3m"].includes(d)) &&
        typeof sleepSeconds === "number" && Number.isFinite(sleepSeconds) && sleepSeconds >= 0 && sleepSeconds <= 10 &&
        isRecord(query) && (requestBody === null || isRecord(requestBody)) &&
        Array.isArray(uniqueFields) && uniqueFields.every(f => typeof f === "string" && f.length > 0) &&
        Array.isArray(pathIds) && pathIds.every(id => (typeof id === "string" || (typeof id === "number" && Number.isSafeInteger(id))) && String(id).trim() !== "") &&
        (pathIdMode === "same" || pathIdMode === "distributed") &&
        typeof pathIdParameter === "string" && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(pathIdParameter) &&
        typeof autoCleanup === "boolean" && typeof cleanupPath === "string" &&
        typeof cleanupIdField === "string" &&
        (accessToken === undefined || typeof accessToken === "string") && isValidThresholds(thresholds) && isValidRequestSettings(value);
}

app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ status: "OK" });
});

app.get("/api/openapi", async (req: Request, res: Response) => {
    try {
        const source = req.query.url;
        if (typeof source !== "string") {
            res.status(400).json({ message: "OpenAPI URL이 필요합니다." });
            return;
        }
        let url: URL;
        try {
            url = new URL(source);
        } catch {
            res.status(400).json({ message: "OpenAPI URL이 올바르지 않습니다." });
            return;
        }
        if (!isLocalUrl(url)) {
            res.status(400).json({ message: "로컬 OpenAPI 주소만 허용합니다." });
            return;
        }
        const response = await fetch(url, {
            redirect: "error",
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`OpenAPI HTTP ${response.status}`);
        const spec: unknown = await response.json();
        if (!isRecord(spec)) throw new Error("OpenAPI 명세 형식이 올바르지 않습니다.");
        const info = isRecord(spec.info) ? spec.info : {};
        res.json({
            title: typeof info.title === "string" ? info.title : "API",
            operations: parseOperations(spec),
        });
    } catch (error: unknown) {
        console.error("[OPENAPI ERROR]", error);
        res.status(500).json({ message: errorMessage(error) });
    }
});

// Live metrics: SSE; EventSource automatically reconnects.
app.get("/api/tests/events", (req: Request, res: Response) => {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.write(": connected\n\n");
    const unsubscribe = subscribeK6Metrics(snapshot => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    });
    const keepalive = setInterval(() => {
        if (!res.writableEnded) res.write(": keepalive\n\n");
    }, 15000);
    req.on("close", () => { clearInterval(keepalive); unsubscribe(); });
});

app.get("/api/tests/history", (req: Request, res: Response) => {
    const { before, q, comparable } = req.query;
    const cursor = typeof before === "string" && /^[1-9][0-9]*$/.test(before) ? Number(before) : undefined;
    if (before !== undefined && (cursor === undefined || !Number.isSafeInteger(cursor))) {
        res.status(400).json({ message: "올바른 이력 페이지가 아닙니다." });
        return;
    }

    try {
        if ((q !== undefined && (typeof q !== "string" || q.length > 160)) ||
            (comparable !== undefined && comparable !== "1")) {
            res.status(400).json({ message: "이력 검색 조건을 확인해주세요." });
            return;
        }
        res.json(getTestHistory(cursor, q, comparable === "1"));
    } catch (error) {
        console.error("[TEST HISTORY READ]", error);
        res.status(500).json({ message: "테스트 이력을 읽지 못했습니다." });
    }
});

app.get("/api/tests/active", (_req: Request, res: Response) => {
    res.json(getActiveK6Run());
});

app.post("/api/tests/active/cancel", (_req: Request, res: Response) => {
    const status = cancelActiveK6Run();
    if (status === "not-running") return void res.status(404).json({ message: "실행 중인 테스트가 없습니다." });
    if (status === "cleaning") return void res.status(409).json({ message: "테스트 데이터 정리 중에는 중단할 수 없습니다." });
    res.status(202).json({ message: "중단 요청을 접수했습니다.", status });
});

function isScenarioRequestId(value: unknown): value is string {
    return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
}

app.post("/api/scenarios/run/:requestId/cancel", (req: Request, res: Response) => {
    const requestId = req.params.requestId;
    if (!isScenarioRequestId(requestId)) {
        res.status(400).json({ message: "시나리오 실행 ID가 올바르지 않습니다." });
        return;
    }

    const status = cancelActiveK6Run(requestId);
    if (status === "not-running") {
        res.status(404).json({ message: "중지할 시나리오 실행이 없습니다." });
        return;
    }
    if (status === "cleaning") {
        res.status(409).json({ message: "시나리오 실행이 끝났으며 결과를 집계하고 있습니다." });
        return;
    }
    res.status(202).json({ status });
});

app.post("/api/scenarios/run", async (req: Request, res: Response) => {
    if (getActiveK6Run().running) {
        res.status(409).json({ message: "이미 k6 테스트가 실행 중입니다." });
        return;
    }

    const raw: unknown = req.body;
    if (!isRecord(raw) || !isValidRequestSettings(raw)) {
        res.status(400).json({ message: "인증·공통 헤더 설정을 확인해주세요." });
        return;
    }
    const { requestId, commonHeaders, generateRequestId } = raw;
    if (requestId !== undefined && !isScenarioRequestId(requestId)) {
        res.status(400).json({ message: "시나리오 실행 ID가 올바르지 않습니다." });
        return;
    }

    let scenario: ReturnType<typeof parseScenario>;
    try {
        scenario = parseScenario(raw, isLocalUrl, isValidRelativePath, ALLOWED_METHODS);
    } catch (error) {
        res.status(400).json({ message: errorMessage(error) });
        return;
    }

    const { baseUrl, vus, duration, sleepSeconds, steps } = scenario;
    try {
        const result = await executeK6({
            baseUrl, vus, duration, method: "GET", path: "/scenario",
            loadMode: "constant", rampUpDuration: "30s", holdDuration: "30s", rampDownDuration: "30s",
            query: {}, requestBody: null, uniqueFields: [], sleepSeconds, commonHeaders, generateRequestId,
            pathIds: [], pathIdParameter: "id", pathIdMode: "same",
            autoCleanup: false, cleanupPath: "", cleanupIdField: "id",
            thresholds: { enabled: false, p95Ms: 500, failureRatePercent: 1, minRps: 100 },
        }, steps, requestId);
        res.json(result);
    } catch (error) {
        console.error("[K6 SCENARIO ERROR]", error);
        res.status(500).json({ message: errorMessage(error) });
    }
});

app.post("/api/tests", async (req: Request, res: Response) => {
    try {
        if (getActiveK6Run().running) {
            res.status(409).json({ message: "이미 k6 테스트가 실행 중입니다." });
            return;
        }
        const raw: unknown = req.body;
        if (!isRecord(raw)) {
            res.status(400).json({ message: "테스트 설정이 올바르지 않습니다." });
            return;
        }
        const candidate: JsonObject = {
            ...raw,
            method: typeof raw.method === "string" ? raw.method.toUpperCase() : raw.method,
            query: raw.query === undefined ? {} : raw.query,
            requestBody: raw.requestBody === undefined ? null : raw.requestBody,
            uniqueFields: raw.uniqueFields === undefined ? [] : raw.uniqueFields,
            sleepSeconds: raw.sleepSeconds === undefined ? 0 : raw.sleepSeconds,
            loadMode: raw.loadMode === undefined ? "constant" : raw.loadMode,
            rampUpDuration: raw.rampUpDuration === undefined ? "30s" : raw.rampUpDuration,
            holdDuration: raw.holdDuration === undefined ? "30s" : raw.holdDuration,
            rampDownDuration: raw.rampDownDuration === undefined ? "30s" : raw.rampDownDuration,
            thresholds: raw.thresholds === undefined ? { enabled: false, p95Ms: 500, failureRatePercent: 1, minRps: 100 } : raw.thresholds,
            pathIds: raw.pathIds === undefined ? [] : raw.pathIds,
            pathIdParameter: raw.pathIdParameter === undefined ? "id" : raw.pathIdParameter,
            pathIdMode: raw.pathIdMode === undefined ? "same" : raw.pathIdMode,
            autoCleanup: raw.autoCleanup === undefined ? false : raw.autoCleanup,
            cleanupPath: raw.cleanupPath === undefined ? "" : raw.cleanupPath,
            cleanupIdField: raw.cleanupIdField === undefined ? "id" : raw.cleanupIdField,
        };

        if (!isTestConfig(candidate)) {
            res.status(400).json({ message: "테스트 설정이 올바르지 않습니다." });
            return;
        }
        const config = candidate;
        // 명시된 cleanupIdField를 generator.ts에 전달합니다.
        let parsed: URL;
        try {
            parsed = new URL(config.baseUrl);
        } catch {
            res.status(400).json({ message: "Base URL이 올바르지 않습니다." });
            return;
        }
        if (!isLocalUrl(parsed)) {
            res.status(400).json({ message: "로컬 서버만 테스트할 수 있습니다." });
            return;
        }
        const distributed = DISTRIBUTION_METHODS.some(m => m === config.method) &&
            config.pathIdMode === "distributed";
        if (config.method === "DELETE" && !distributed) {
            res.status(400).json({ message: "DELETE는 ID 분배 모드로 실행해야 합니다." });
            return;
        }
        if (distributed) {
            if (config.pathIds.length === 0) {
                res.status(400).json({ message: "분배할 ID를 하나 이상 입력해주세요." });
                return;
            }
            if (!config.path.includes(`{${config.pathIdParameter}}`)) {
                res.status(400).json({ message: `Path에 {${config.pathIdParameter}} 파라미터가 없습니다.` });
                return;
            }
            if (config.pathIds.some(id => {
                const value = String(id);
                return value === "." || value === ".." || /[/?#\\]/.test(value);
            })) {
                res.status(400).json({ message: "ID에 경로 구분자나 URL 제어 문자를 사용할 수 없습니다." });
                return;
            }
        }
        if (config.method === "DELETE" && new Set(config.pathIds.map(String)).size !== config.pathIds.length) {
            res.status(400).json({ message: "DELETE 대상 ID 목록에 중복된 값이 있습니다." });
            return;
        }
        if (config.method === "DELETE" && config.loadMode === "ramping") {
            res.status(400).json({ message: "DELETE 테스트는 단계별 부하 모드를 지원하지 않습니다." });
            return;
        }
        const shouldCleanup = config.method === "POST" && config.autoCleanup;
        if (shouldCleanup) {
            if (!isValidCleanupPath(config.cleanupPath)) {
                res.status(400).json({ message: "DELETE API 경로가 올바르지 않습니다. 예: /api/animals/{id}" });
                return;
            }
            if (!isValidCleanupIdField(config.cleanupIdField)) {
                res.status(400).json({ message: "생성 리소스 ID 경로를 확인해주세요. 예: id 또는 data.id" });
                return;
            }
            if (config.cleanupPath === config.path) {
                res.status(400).json({ message: "POST API와 DELETE API 경로를 구분해주세요." });
                return;
            }
        }
        const result = await executeK6({
            ...config,
            autoCleanup: shouldCleanup,
            cleanupPath: shouldCleanup ? config.cleanupPath : "",
        });
        res.json(result);
    } catch (error: unknown) {
        console.error("[K6 ERROR]", error);
        res.status(500).json({ message: errorMessage(error) });
    }
});

app.listen(PORT, HOST, () => {
    console.log(`K6 Runner: http://${HOST}:${PORT}`);
});
