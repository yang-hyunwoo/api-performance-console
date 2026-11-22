import { randomUUID } from "node:crypto";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type PathIdMode = "same" | "distributed";
export type LoadMode = "constant" | "ramping";
export type QueryValue = string | number | boolean | null | undefined;

export interface K6GeneratorConfig {
    baseUrl: string;
    method?: HttpMethod | string;
    path: string;
    vus: number;
    duration: string;
    loadMode?: LoadMode;
    rampUpDuration?: string;
    holdDuration?: string;
    rampDownDuration?: string;
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
    thresholds?: { enabled: boolean; p95Ms: number; failureRatePercent: number; minRps: number };
}

export function generateK6Script({
                                     baseUrl,
                                     method = "GET",
                                     path,
                                     vus,
                                     duration,
                                     loadMode = "constant",
                                     rampUpDuration = "30s",
                                     holdDuration = "30s",
                                     rampDownDuration = "30s",
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
                                     thresholds = { enabled: false, p95Ms: 500, failureRatePercent: 1, minRps: 100 },
                                 }: K6GeneratorConfig): string {
    const httpMethod = method.toUpperCase();

    const allowedMethods: readonly string[] = [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
    ];

    if (!allowedMethods.includes(httpMethod)) {
        throw new Error(`지원하지 않는 HTTP Method: ${httpMethod}`);
    }

    const supportsIdDistribution = [
        "PUT",
        "PATCH",
        "DELETE",
    ].includes(httpMethod);

    const validPathIds = Array.isArray(pathIds)
        ? pathIds
            .map((id) => String(id).trim())
            .filter(Boolean)
        : [];

    const useDistributedIds =
        supportsIdDistribution &&
        pathIdMode === "distributed" &&
        validPathIds.length > 0;

    if (httpMethod === "DELETE" && !useDistributedIds) {
        throw new Error(
            "DELETE 테스트는 삭제 대상 ID 목록과 분배 모드가 필요합니다."
        );
    }

    if (
        useDistributedIds &&
        !path.includes(`{${pathIdParameter}}`)
    ) {
        throw new Error(
            `Path에 {${pathIdParameter}} 파라미터가 없습니다.`
        );
    }

    if (
        httpMethod === "DELETE" &&
        new Set(validPathIds).size !== validPathIds.length
    ) {
        throw new Error(
            "DELETE 대상 ID 목록에 중복된 값이 있습니다."
        );
    }

    const pathTemplate = useDistributedIds
        ? path.replace(
            `{${pathIdParameter}}`,
            "__K6_PATH_ID__"
        )
        : path;

    const url = new URL(pathTemplate, baseUrl);

    for (const [key, value] of Object.entries(query)) {
        if (
            value !== undefined &&
            value !== null &&
            value !== ""
        ) {
            url.searchParams.set(key, String(value));
        }
    }

    const body =
        requestBody === null
            ? null
            : JSON.stringify(requestBody);

    const validUniqueFields = Array.isArray(uniqueFields)
        ? uniqueFields.filter((field) => {
            if (
                typeof field !== "string" ||
                requestBody === null ||
                typeof requestBody !== "object" ||
                Array.isArray(requestBody)
            ) {
                return false;
            }

            const value = requestBody[field];
            return typeof value === "string" ||
                (typeof value === "number" && Number.isFinite(value));
        })
        : [];

    const isDelete = httpMethod === "DELETE";

    const shouldCollectIds =
        httpMethod === "POST" &&
        autoCleanup === true;

    const allowedStageDurations = ["10s", "30s", "1m", "3m"];
    if (!isDelete && loadMode === "ramping" &&
        ![rampUpDuration, holdDuration, rampDownDuration].every(d => allowedStageDurations.includes(d))) {
        throw new Error("단계별 부하 시간 설정이 올바르지 않습니다.");
    }
    const rampingScenario = {
        executor: "ramping-vus",
        startVUs: 0,
        stages: [
            { duration: rampUpDuration, target: Number(vus) },
            { duration: holdDuration, target: Number(vus) },
            { duration: rampDownDuration, target: 0 },
        ],
        gracefulRampDown: "5s",
        gracefulStop: "5s",
    };

    const k6Thresholds = thresholds.enabled ? {
        http_req_duration: [`p(95)<=${thresholds.p95Ms}`],
        http_req_failed: [`rate<${thresholds.failureRatePercent / 100}`],
        http_reqs: [`rate>=${thresholds.minRps}`],
    } : {};

    const options = isDelete
        ? {
            scenarios: {
                delete_once: {
                    executor: "shared-iterations",
                    vus: Math.min(
                        Number(vus),
                        validPathIds.length
                    ),
                    iterations: validPathIds.length,
                    maxDuration: "3m",
                },
            },
        }
        : null;

    // 반환값은 k6에서 실행할 JavaScript 소스 문자열입니다.
    return `
import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";
import { sleep } from "k6";

export const options = {
    ${
        isDelete
            ? `scenarios: ${JSON.stringify(options?.scenarios)},`
            : loadMode === "ramping"
                ? `scenarios: ${JSON.stringify({ load_test: rampingScenario })},`
                : `vus: ${Number(vus)},
    duration: ${JSON.stringify(duration)},`
    }
    thresholds: ${JSON.stringify(k6Thresholds)}
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
const CREATED_ID_PREFIX = "K6_CREATED_ID:";
const CLEANUP_ID_FIELD = ${JSON.stringify(cleanupIdField)};

// 명시된 경로만 사용합니다. 다른 객체의 ID를 추측해 삭제하지 않습니다.
function findCreatedId(value) {
    const parts = CLEANUP_ID_FIELD.split(".");
    let current = value;
    for (const part of parts) {
        if (current === null || typeof current !== "object" ||
            Array.isArray(current) ||
            !Object.prototype.hasOwnProperty.call(current, part)) return null;
        current = current[part];
    }
    if (typeof current === "string" && current.trim() !== "") return current;
    if (typeof current === "number" && Number.isSafeInteger(current)) return String(current);
    return null;
}

function extractCreatedId(response) {
    if (!AUTO_CLEANUP) return null;

    try {
        const json = response.json();
        const id = findCreatedId(json);
        if (id === null) {
            console.error(
                "K6_ID_MISSING:" + JSON.stringify({
                    runId: RUN_ID,
                    status: response.status,
                    field: CLEANUP_ID_FIELD
                })
            );
        }
        return id;
    } catch (error) {
        console.error(
            "K6_ID_EXTRACTION_FAILED:" + JSON.stringify({
                runId: RUN_ID,
                error: String(error),
                status: response.status
            })
        );
        return null;
    }
}

const COMMON_HEADERS = JSON.parse(__ENV.COMMON_REQUEST_HEADERS || "{}");

export default function () {
    const token = __ENV.ACCESS_TOKEN;
    const headers = {
        ...(token ? { authorization: "Bearer " + token } : {}),
        ...COMMON_HEADERS,
    };
    if (BODY_TEMPLATE !== null && !Object.hasOwn(headers, "content-type")) {
        headers["content-type"] = "application/json";
    }
    if (__ENV.GENERATE_REQUEST_ID === "1") headers["x-request-id"] = crypto.randomUUID();

    let requestUrl = URL_TEMPLATE;

    if (DISTRIBUTE_IDS) {
        const iteration = exec.scenario.iterationInTest;

        const index = IS_DELETE
            ? iteration
            : iteration % PATH_IDS.length;

        const id = PATH_IDS[index];

        requestUrl = requestUrl.replace(
            "__K6_PATH_ID__",
            encodeURIComponent(id)
        );
    }

    let requestData = null;

    if (BODY_TEMPLATE !== null) {
        const bodyObject = JSON.parse(BODY_TEMPLATE);

        // 모든 VU에 걸쳐 중복되지 않는 전역 반복 번호
        const globalIteration = exec.scenario.iterationInTest;

        for (const field of UNIQUE_FIELDS) {
            const value = bodyObject[field];

            if (typeof value === "string") {
                bodyObject[field] =
                    value + "_" + RUN_ID + "_" + globalIteration;
            } else if (typeof value === "number") {
                const nextValue = value + globalIteration;
                if (!Number.isFinite(nextValue) ||
                    (Number.isInteger(value) && !Number.isSafeInteger(nextValue))) {
                    throw new Error("고유 숫자 생성 범위를 초과했습니다: " + field);
                }
                bodyObject[field] = nextValue;
            }
        }

        requestData = JSON.stringify(bodyObject);
    }

    const response = http.request(
        ${JSON.stringify(httpMethod)},
        requestUrl,
        requestData,
        { headers, ...(Object.keys(COMMON_HEADERS).length || token ? { redirects: 0 } : {}) }
    );

    const success = check(response, {
        "status is 2xx": (r) =>
            r.status >= 200 && r.status < 300
    });

    // POST 성공 시 생성된 ID 수집
    if (AUTO_CLEANUP && success) {
        const createdId = extractCreatedId(response);

        if (createdId !== null) {
            console.error(
                CREATED_ID_PREFIX +
                JSON.stringify({
                    runId: RUN_ID,
                    id: createdId
                })
            );

        }
    }

    if (!success) {
        console.error(
            JSON.stringify({
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
            })
        );
    }

    if (!IS_DELETE && SLEEP_SECONDS > 0) {
        sleep(SLEEP_SECONDS);
    }
}
`;
}
