
import http from "k6/http";
import { check } from "k6";

export const options = {
    vus: 10,
    duration: "10s",
    thresholds: {
        http_req_failed: ["rate<0.01"],
        http_req_duration: ["p(95)<500"],
        checks: ["rate>0.99"]
    }
};

export default function () {
    const token = __ENV.ACCESS_TOKEN;

    const response = http.get(
        "http://localhost:8080/api/admin/shops",
        {
            headers: token
                ? { Authorization: `Bearer ${token}` }
                : {}
        }
    );

    const success = check(response, {
        "status is 200": (r) => r.status === 200
    });

    // 실패한 요청만 로그 기록
    if (!success) {
        console.error(JSON.stringify({
            type: "HTTP_FAILURE",
            timestamp: new Date().toISOString(),
            method: "GET",
            path: "/api/admin/shops",
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
    
    // sleep(1)
    
}
