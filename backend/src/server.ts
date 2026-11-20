import express from "express";
import cors from "cors";
import type { Request, Response } from "express";
import {parseOperations} from "./openapi.ts";
import {executeK6} from "./runner.ts";

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
}

function isRecord(value: unknown): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
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
    return !/%(?:2f|5c|3f|23|0[0-9a-f]|1[0-9a-f]|7f)/i.test(path);
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

function isTestConfig(value: unknown): value is K6TestConfig {
    if (!isRecord(value)) return false;
    const { baseUrl, method, path, vus, duration, query, requestBody,
        uniqueFields, sleepSeconds, pathIds, pathIdParameter, pathIdMode,
        autoCleanup, cleanupPath, cleanupIdField, accessToken } = value;
    return typeof baseUrl === "string" &&
        typeof method === "string" && ALLOWED_METHODS.some(m => m === method.toUpperCase()) &&
        isValidRelativePath(path) &&
        typeof vus === "number" && Number.isInteger(vus) && vus >= 1 && vus <= 1501 &&
        typeof duration === "string" && ["10s", "30s", "1m", "3m"].includes(duration) &&
        typeof sleepSeconds === "number" && Number.isFinite(sleepSeconds) && sleepSeconds >= 0 && sleepSeconds <= 10 &&
        isRecord(query) && (requestBody === null || isRecord(requestBody)) &&
        Array.isArray(uniqueFields) && uniqueFields.every(f => typeof f === "string" && f.length > 0) &&
        Array.isArray(pathIds) && pathIds.every(id => (typeof id === "string" || typeof id === "number") && String(id).trim() !== "") &&
        (pathIdMode === "same" || pathIdMode === "distributed") &&
        typeof pathIdParameter === "string" && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(pathIdParameter) &&
        typeof autoCleanup === "boolean" && typeof cleanupPath === "string" &&
        typeof cleanupIdField === "string" &&
        (accessToken === undefined || typeof accessToken === "string");
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

app.post("/api/tests", async (req: Request, res: Response) => {
    try {
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
        const shouldCleanup = config.method === "POST" && config.autoCleanup;
        if (shouldCleanup) {
            if (!isValidCleanupPath(config.cleanupPath)) {
                res.status(400).json({ message: "DELETE API 경로가 올바르지 않습니다. 예: /api/animals/{id}" });
                return;
            }
            if (!isValidCleanupIdField(config.cleanupIdField)) {
                res.status(400).json({ message: "POST 응답 ID 경로가 올바르지 않습니다. 예: id 또는 data.id" });
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
            cleanupIdField: shouldCleanup ? config.cleanupIdField : "id",
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
