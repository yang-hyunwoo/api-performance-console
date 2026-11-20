import { randomUUID } from "node:crypto";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type PathIdMode = "same" | "distributed";
export type QueryValue = string | number | boolean | null | undefined;

export interface K6GeneratorConfig {
    baseUrl: string;
    method?: HttpMethod | string;
    path: string;
    vus: number;
    duration: string;
    query?: Record<string, unknown>;
    requestBody?: Record<string, unknown> | null;
    uniqueFields?: string[];
    runId?: string;
    sleepSeconds?: number;
    pathIds?: Array<string | number>;
    pathIdParameter?: string;
    pathIdMode?: PathIdMode;
    autoCleanup?: boolean;
    cleanupIdField?: string;
}

export function generateK6Script({
                                     baseUrl,
                                     method = "GET",
                                     path,
                                     vus,
                                     duration,
                                     query = {},
                                     requestBody = null,
                                     uniqueFields = [],
                                     runId = randomUUID(),
                                     sleepSeconds = 0,
                                     pathIds = [],
                                     pathIdParameter = "id",
                                     pathIdMode = "same",
                                     autoCleanup = false,
                                     cleanupIdField = "id",
                                 }: K6GeneratorConfig): string {
    const httpMethod = method.toUpperCase();
    const allowedMethods: readonly string[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
    if (!allowedMethods.includes(httpMethod)) {
        throw new Error(`지원하지 않는 HTTP Method: ${httpMethod}`);
    }

    const supportsIdDistribution = ["PUT", "PATCH", "DELETE"].includes(httpMethod);
    const validPathIds = Array.isArray(pathIds)
        ? pathIds.map((id) => String(id).trim()).filter(Boolean)
        : [];
    const useDistributedIds = supportsIdDistribution && pathIdMode === "distributed" && validPathIds.length > 0;

    if (httpMethod === "DELETE" && !useDistributedIds) {
        throw new Error("DELETE 테스트는 삭제 대상 ID 목록과 분배 모드가 필요합니다.");
    }
    if (useDistributedIds && !path.includes(`{${pathIdParameter}}`)) {
        throw new Error(`Path에 {${pathIdParameter}} 파라미터가 없습니다.`);
    }
    if (httpMethod === "DELETE" && new Set(validPathIds).size !== validPathIds.length) {
        throw new Error("DELETE 대상 ID 목록에 중복된 값이 있습니다.");
    }

    const pathTemplate = useDistributedIds
        ? path.replace(`{${pathIdParameter}}`, "__K6_PATH_ID__")
        : path;
    const url = new URL(pathTemplate, baseUrl);
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
            url.searchParams.set(key, String(value));
        }
    }

    const body = requestBody === null ? null : JSON.stringify(requestBody);
    const validUniqueFields = Array.isArray(uniqueFields)
        ? uniqueFields.filter((field) =>
            typeof field === "string" &&
            requestBody !== null &&
            typeof requestBody === "object" &&
            !Array.isArray(requestBody) &&
            typeof requestBody[field] === "string"
        )
        : [];

    const isDelete = httpMethod === "DELETE";
    const shouldCollectIds = httpMethod === "POST" && autoCleanup === true;
    if (shouldCollectIds) {
        if (
            typeof cleanupIdField !== "string" ||
            !/^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*)*$/.test(cleanupIdField)
        ) {
            throw new Error("POST 응답 ID 경로가 올바르지 않습니다.");
        }
    }

    const options = isDelete
        ? {
            scenarios: {
                delete_once: {
                    executor: "shared-iterations",
                    vus: Math.min(Number(vus), validPathIds.length),
                    iterations: validPathIds.length,
                    maxDuration: "3m",
                },
            },
        }
        : null;

    // 반환값은 TypeScript가 아니라 k6에서 실행할 JavaScript 소스 문자열입니다.
    return `
import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";
import { sleep } from "k6";

export const options = {
    ${isDelete
        ? `scenarios: ${JSON.stringify(options?.scenarios)},`
        : `vus: ${Number(vus)},
    duration: ${JSON.stringify(duration)},`
    }
    thresholds: {
        http_req_failed: ["rate<0.01"],
        http_req_duration: ["p(95)<500"],
        checks: ["rate>0.99"]
    }
};

const RUN_ID = ${JSON.stringify(runId)};
const SLEEP_SECONDS = ${JSON.stringify(Number(sleepSeconds))};
const UNIQUE_FIELDS = ${JSON.stringify(validUniqueFields)};
const BODY_TEMPLATE = ${JSON.stringify(body)};

const PATH_IDS = ${JSON.stringify(validPathIds)};
const DISTRIBUTE_IDS = ${JSON.stringify(useDistributedIds)};
const IS_DELETE = ${JSON.stringify(isDelete)};

const URL_TEMPLATE = ${JSON.stringify(url.toString())};

const AUTO_CLEANUP = ${JSON.stringify(shouldCollectIds)};
const CLEANUP_ID_FIELD = ${JSON.stringify(cleanupIdField)};
const CREATED_ID_PREFIX = "K6_CREATED_ID:";

function extractCreatedId(response) {
    if (!AUTO_CLEANUP) {
        return null;
    }

    try {
        const json = response.json();
        if (json === null || typeof json !== "object") {
            return null;
        }

        const id = CLEANUP_ID_FIELD
            .split(".")
            .reduce((value, key) => value?.[key], json);

        if (typeof id === "string" || typeof id === "number") {
            return String(id);
        }
        return null;
    } catch (error) {
        console.error(
            "K6_ID_EXTRACTION_FAILED:" +
            JSON.stringify({
                runId: RUN_ID,
                field: CLEANUP_ID_FIELD,
                error: String(error)
            })
        );
        return null;
    }
}

export default function () {
    const token = __ENV.ACCESS_TOKEN;
    const headers = {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ${body !== null ? '"Content-Type": "application/json",' : ""}
    };

    let requestUrl = URL_TEMPLATE;
    if (DISTRIBUTE_IDS) {
        const iteration = exec.scenario.iterationInTest;
        const index = IS_DELETE ? iteration : iteration % PATH_IDS.length;
        const id = PATH_IDS[index];
        requestUrl = requestUrl.replace(
            "__K6_PATH_ID__",
            encodeURIComponent(id)
        );
    }

    let requestData = null;
    if (BODY_TEMPLATE !== null) {
        const bodyObject = JSON.parse(BODY_TEMPLATE);
        for (const field of UNIQUE_FIELDS) {
            bodyObject[field] =
                bodyObject[field] +
                "_" + RUN_ID +
                "_" + __VU +
                "_" + __ITER;
        }
        requestData = JSON.stringify(bodyObject);
    }

    const response = http.request(
        ${JSON.stringify(httpMethod)},
        requestUrl,
        requestData,
        { headers }
    );

    const success = check(response, {
        "status is 2xx": (r) => r.status >= 200 && r.status < 300
    });

    if (AUTO_CLEANUP && success) {
        const createdId = extractCreatedId(response);
        if (createdId !== null) {
            console.error(
                CREATED_ID_PREFIX +
                JSON.stringify({ runId: RUN_ID, id: createdId })
            );
        } else {
            console.error(
                "K6_ID_MISSING:" +
                JSON.stringify({
                    runId: RUN_ID,
                    field: CLEANUP_ID_FIELD,
                    status: response.status,
                    vu: __VU,
                    iteration: __ITER
                })
            );
        }
    }

    if (!success) {
        console.error(JSON.stringify({
            type: "HTTP_FAILURE",
            timestamp: new Date().toISOString(),
            method: ${JSON.stringify(httpMethod)},
            path: requestUrl,
            status: response.status,
            error: response.error ?? null,
            errorCode: response.error_code ?? null,
            durationMs: response.timings.duration,
            responseBody: response.body
                ? String(response.body).slice(0, 300)
                : null,
            vu: __VU,
            iteration: __ITER
        }));
    }

    if (!IS_DELETE && SLEEP_SECONDS > 0) {
        sleep(SLEEP_SECONDS);
    }
}
`;
}
