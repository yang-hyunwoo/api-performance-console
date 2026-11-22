import type { K6TestConfig } from "./server.js";

export interface ScenarioStep {
    method: K6TestConfig["method"];
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    body: Record<string, unknown> | null;
    uniqueFields: string[];
    extract: Record<string, string>;
}

const variableName = "[a-zA-Z_$][\\w$]*";
const variablePath = variableName + "(?:\\." + variableName + ")*";
const identifier = new RegExp("^" + variableName + "$");
const jsonPath = new RegExp("^" + variablePath + "$");
const references = new RegExp("\\$\\{(" + variablePath + ")\\}", "g");

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
    return isRecord(value) && Object.values(value).every(item => typeof item === "string");
}

function validateReferences(value: unknown, available: Set<string>): void {
    if (typeof value === "string") {
        const remaining = value.replace(references, (_, reference: string) => {
            if (!available.has(reference.split(".")[0])) {
                throw new Error("이전 단계에 없는 변수: " + reference);
            }
            return "";
        });
        if (remaining.includes("${")) throw new Error("변수 참조 형식을 확인해주세요.");
    } else if (Array.isArray(value)) {
        for (const item of value) validateReferences(item, available);
    } else if (isRecord(value)) {
        for (const item of Object.values(value)) validateReferences(item, available);
    }
}

export function parseScenario(
    raw: unknown,
    isLocalUrl: (url: URL) => boolean,
    isValidPath: (path: unknown) => path is string,
    methods: readonly K6TestConfig["method"][],
): { baseUrl: string; vus: number; duration: K6TestConfig["duration"]; sleepSeconds: number; steps: ScenarioStep[] } {
    if (!isRecord(raw) || typeof raw.baseUrl !== "string") throw new Error("Base URL을 입력해주세요.");
    const url = new URL(raw.baseUrl);
    if (!isLocalUrl(url)) throw new Error("로컬 서버만 테스트할 수 있습니다.");

    const { vus, duration, sleepSeconds = 0, steps } = raw;
    if (typeof vus !== "number" || !Number.isInteger(vus) || vus < 1 || vus > 1501) {
        throw new Error("VU는 1~1501 사이의 정수여야 합니다.");
    }
    if (duration !== "10s" && duration !== "30s" && duration !== "1m" && duration !== "3m") {
        throw new Error("실행 시간을 확인해주세요.");
    }
    if (typeof sleepSeconds !== "number" || !Number.isFinite(sleepSeconds) || sleepSeconds < 0 || sleepSeconds > 10) {
        throw new Error("반복 사이 대기 시간은 0~10초로 입력해주세요.");
    }
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 50) {
        throw new Error("시나리오에 1~50개 API를 추가해주세요.");
    }

    const available = new Set<string>();
    const parsedSteps = steps.map((step: unknown, index): ScenarioStep => {
        try {
            if (!isRecord(step)) throw new Error("단계 설정을 확인해주세요.");
            const method = methods.find(candidate => candidate === step.method);
            const { path, query, headers, body, uniqueFields, extract } = step;
            if (!method || !isValidPath(path) || !isStringRecord(query) || !isStringRecord(headers) ||
                (body !== null && !isRecord(body)) || !isStringRecord(extract) ||
                !Array.isArray(uniqueFields) || !uniqueFields.every(field => typeof field === "string")) {
                throw new Error("메서드, 요청 경로, 헤더 및 본문을 확인해주세요.");
            }
            if (Object.keys(headers).some(name => /^(host|content-length|transfer-encoding|connection)$/i.test(name))) {
                throw new Error("Host 및 연결 제어 헤더는 설정할 수 없습니다.");
            }
            validateReferences([path, query, headers, body], available);
            if (/[{}]/.test(path.replace(references, ""))) {
                throw new Error("모든 Path 파라미터를 입력해주세요.");
            }
            for (const [name, path] of Object.entries(extract)) {
                if (!identifier.test(name) || !jsonPath.test(path)) {
                    throw new Error("응답 변수명과 JSON 경로를 확인해주세요.");
                }
                available.add(name);
            }
            return { method, path, query, headers, body, uniqueFields, extract };
        } catch (error) {
            throw new Error(`단계 ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
    return { baseUrl: url.origin, vus, duration, sleepSeconds, steps: parsedSteps };
}

export const stepOutcomes = ["succeeded", "http_failed", "extraction_failed", "skipped", "request_failed"] as const;

export function generateScenarioScript(
    baseUrl: string,
    vus: number,
    duration: string,
    steps: ScenarioStep[],
    runId: string,
    sleepSeconds: number,
): string {
    return String.raw`
import { sleep } from "k6";
import http from "k6/http";
import exec from "k6/execution";
import { Counter } from "k6/metrics";

const BASE_URL = ${JSON.stringify(baseUrl)};
const RUN_ID = ${JSON.stringify(runId)};
const SLEEP_SECONDS = ${sleepSeconds};
const STEPS = JSON.parse(${JSON.stringify(JSON.stringify(steps.map(({ headers, ...step }) => step)))});
const HEADERS = JSON.parse(__ENV.SCENARIO_HEADERS);
const COMMON_HEADERS = JSON.parse(__ENV.COMMON_REQUEST_HEADERS || "{}");
const REFERENCE = ${references};
const OUTCOMES = ${JSON.stringify(stepOutcomes)};
const counters = STEPS.map((_, index) => Object.fromEntries(
    OUTCOMES.map(outcome => [outcome, new Counter("scenario_step_" + (index + 1) + "_" + outcome)])
));

export const options = { vus: ${vus}, duration: ${JSON.stringify(duration)}, maxRedirects: 0 };

function getPath(root, path) {
    for (const name of path.split(".")) {
        if (root === null || typeof root !== "object" || !Object.prototype.hasOwnProperty.call(root, name)) return undefined;
        root = root[name];
    }
    return root;
}

class MissingVariable extends Error {}

function resolveText(text, variables, mode) {
    return text.replace(REFERENCE, (_, name) => {
        const value = getPath(variables, name);
        if (value === undefined || value === null) throw new MissingVariable(name);
        if (typeof value === "object") throw new Error("A scalar value is required");
        if (mode === "path") {
            const segment = String(value);
            if (!segment || segment === "." || segment === ".." || /[\/\\%]/.test(segment)) {
                throw new Error("Invalid path segment");
            }
            return encodeURIComponent(segment);
        }
        return String(value);
    });
}

function resolveBody(value, variables) {
    if (typeof value === "string") {
        const match = value.match(/^\$\{([^}]+)\}$/);
        if (match) {
            const resolved = getPath(variables, match[1]);
            if (resolved === undefined || resolved === null) throw new MissingVariable(match[1]);
            return resolved;
        }
        return resolveText(value, variables);
    }
    if (Array.isArray(value)) return value.map(item => resolveBody(item, variables));
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveBody(item, variables)]));
    }
    return value;
}

export default function () {
    const variables = Object.create(null);
    for (let index = 0; index < STEPS.length; index++) {
        const step = STEPS[index];
        const outcomes = counters[index];
        const extracted = Object.entries(step.extract);
        let outcome = "request_failed";
        try {
            const path = resolveText(step.path, variables, "path");
            if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid request path");
            const query = Object.entries(step.query).map(([key, value]) =>
                encodeURIComponent(key) + "=" + encodeURIComponent(resolveText(value, variables))
            ).join("&");
            const stepHeaders = Object.fromEntries(Object.entries(HEADERS[index]).map(([key, value]) =>
                [key.toLowerCase(), resolveText(value, variables)]
            ));
            const headers = { ...COMMON_HEADERS, ...stepHeaders };
            if (__ENV.GENERATE_REQUEST_ID === "1" && !Object.hasOwn(stepHeaders, "x-request-id")) {
                headers["x-request-id"] = crypto.randomUUID();
            }
            const body = resolveBody(step.body, variables);
            if (body !== null) {
                if (!Object.keys(headers).some(key => key.toLowerCase() === "content-type")) {
                    headers["Content-Type"] = "application/json";
                }
                for (const field of step.uniqueFields) {
                    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
                    const value = body[field];
                    if (typeof value === "string") body[field] = value + "_" + RUN_ID + "_" + exec.scenario.iterationInTest;
                    else if (typeof value === "number" && Number.isSafeInteger(value + exec.scenario.iterationInTest)) {
                        body[field] = value + exec.scenario.iterationInTest;
                    }
                }
            }
            const response = http.request(step.method, BASE_URL + path + (query ? "?" + query : ""),
                body === null ? null : JSON.stringify(body), {
                    headers, redirects: 0, responseType: extracted.length ? "text" : "none",
                    tags: { name: "scenario_step_" + (index + 1) },
                });
            if (response.status < 200 || response.status >= 300) {
                outcome = "http_failed";
            } else {
                outcome = "succeeded";
                if (extracted.length) {
                    outcome = "extraction_failed";
                    const json = response.json();
                    const values = extracted.map(([name, path]) => [name, getPath(json, path)]);
                    if (values.every(([, value]) => value !== null && value !== undefined && value !== "")) {
                        outcome = "succeeded";
                        for (const [name, value] of values) variables[name] = value;
                    }
                }
            }
        } catch (error) {
            if (error instanceof MissingVariable) outcome = "skipped";
        } finally {
            if (outcome !== "succeeded") {
                for (const [name] of extracted) delete variables[name];
            }
            outcomes[outcome].add(1);
        }
    }
    if (SLEEP_SECONDS > 0) sleep(SLEEP_SECONDS);
}
`;
}
