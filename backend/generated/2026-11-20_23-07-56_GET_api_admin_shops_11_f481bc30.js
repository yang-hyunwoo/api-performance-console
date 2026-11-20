
import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";
import { sleep } from "k6";

export const options = {
    vus: 5,
    duration: "10s",
    thresholds: {
        http_req_failed: ["rate<0.01"],
        http_req_duration: ["p(95)<500"],
        checks: ["rate>0.99"]
    }
};

const RUN_ID = "6ea8579f6f99";
const SLEEP_SECONDS = 0;
const UNIQUE_FIELDS = [];
const BODY_TEMPLATE = null;

const PATH_IDS = [];
const DISTRIBUTE_IDS = false;
const IS_DELETE = false;

const URL_TEMPLATE = "http://localhost:8080/api/admin/shops/11";

const AUTO_CLEANUP = false;
const CLEANUP_ID_FIELD = "id";
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
        "GET",
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
            method: "GET",
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
