import type { MethodFilter, InputValue, JsonValue, ApiOperation } from "../types/api";
import { buildRequestBody } from "../lib/api/request-body";
import RequestBodyEditor from "../components/api/RequestBodyEditor";
import RequestHeadersEditor, { buildRequestSettings, useRequestSettings } from "../components/api/RequestHeadersEditor";
import { useEffect, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import './SingleApiTestPage.css'

interface LiveSnapshot {
    runId: string;
    phase: "preparing" | "running" | "cleaning";
    cancelled: boolean;
    elapsedSeconds: number;
    totalRequests: number;
    rps: number;
    avgResponseTime: number;
    p95ResponseTime?: number;
    activeVus?: number | null;
    targetVus?: number | null;
    failureRate: number;
    metricsAvailable: boolean;
}

interface TestMetrics {
    totalRequests?: number;
    rps?: number;
    avgResponseTime?: number;
    p95ResponseTime?: number;
    failureRate?: number;
}

interface CleanupResult {
    attempted?: boolean;
    success?: boolean;
    total?: number;
    deleted?: number;
    failed?: number;
    missingIdCount?: number;
    extractionErrorCount?: number;
    malformedMarkerCount?: number;
    mismatchedRunIdCount?: number;
    duplicateIdCount?: number;
    failedIds?: Array<{ id: string; message: string; status?: number; attempts?: number }>;
    recoveryFile?: string;
    message?: string;
}

interface ThresholdEvaluation {
    status: "PASS" | "FAIL" | "UNAVAILABLE" | "DISABLED";
    checks: Array<{ key: string; label: string; operator: string; target: number; actual: number; passed: boolean }>;
}

interface TestResult {
    historySaved?: boolean;
    success: boolean;
    executionStatus?: "completed" | "cancelled" | "error";
    thresholdEvaluation?: ThresholdEvaluation;
    cancelled?: boolean;
    metrics?: TestMetrics;
    cleanupResult?: CleanupResult;
}

interface ApiErrorResponse {
    message?: string;
}

interface OpenApiResponse extends ApiErrorResponse {
    operations?: ApiOperation[];
}

interface MetricProps {
    label: string;
    value?: number | null;
    suffix?: string;
    responseTime?: boolean;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const RUNNER_URL = "http://127.0.0.1:4000";

const HTTP_METHODS: MethodFilter[] = [
    "ALL",
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
];

const DISTRIBUTION_METHODS: string[] = [
    "PUT",
    "PATCH",
    "DELETE",
];

function parsePathIds(value: string): string[] {
    return value
        .split(/[\n,]+/)
        .map((id) => id.trim())
        .filter(Boolean);
}

export default function SingleApiTestPage() {
    const [openApiUrl, setOpenApiUrl] = useState(
        "http://localhost:8080/v3/api-docs"
    );

    const [baseUrl, setBaseUrl] = useState(
        "http://localhost:8080"
    );

    const [searchKeyword, setSearchKeyword] = useState("");
    const [selectedMethod, setSelectedMethod] = useState<MethodFilter>("ALL");

    const [operations, setOperations] = useState<ApiOperation[]>([]);
    const [selected, setSelected] = useState<ApiOperation | null>(null);
    const [autoCleanup, setAutoCleanup] = useState(false);
    const [parameters, setParameters] = useState<Record<string, string>>({});
    const [bodyValues, setBodyValues] = useState<Record<string, string>>({});
    const [uniqueFields, setUniqueFields] = useState<Record<string, boolean>>({});

    // PUT / PATCH / DELETE 설정
    const [pathIdMode, setPathIdMode] = useState<"same" | "distributed">("same");
    const [pathIdParameter, setPathIdParameter] = useState("");
    const [pathIdsInput, setPathIdsInput] = useState("");

    const [vus, setVus] = useState<number | string>(5);
    const [duration, setDuration] = useState("10s");
    const [loadMode, setLoadMode] = useState<"constant" | "ramping">("constant");
    const [rampUpDuration, setRampUpDuration] = useState("30s");
    const [holdDuration, setHoldDuration] = useState("30s");
    const [rampDownDuration, setRampDownDuration] = useState("30s");
    const [sleepSeconds, setSleepSeconds] = useState(0);
    const [thresholdEnabled, setThresholdEnabled] = useState(false);
    const [thresholdP95, setThresholdP95] = useState<number | string>(500);
    const [thresholdFailureRate, setThresholdFailureRate] = useState<number | string>(1);
    const [thresholdRps, setThresholdRps] = useState<number | string>(100);
    const { settings: requestSettings } = useRequestSettings(baseUrl);
    const [cleanupPath, setCleanupPath] = useState("");
    const [cleanupIdField, setCleanupIdField] = useState("id");
    const [cleanupPathMode, setCleanupPathMode] = useState<"openapi" | "manual">("openapi");
    const [loading, setLoading] = useState(false);
    const [running, setRunning] = useState(false);
    const [remoteRunning, setRemoteRunning] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [runPhase, setRunPhase] = useState("");
    const [live, setLive] = useState<LiveSnapshot | null>(null);
    const [liveHistory, setLiveHistory] = useState<Array<{time: number; rps: number; avgResponseTime: number | null; p95ResponseTime: number | null; failureRate: number | null; activeVus: number | null; targetVus: number | null}>>([]);
    const liveRunId = useRef<string | null>(null);

    useEffect(() => {
        let alive = true;
        const check = async () => {
            try {
                const response = await fetch(`${RUNNER_URL}/api/tests/active`);
                if (!response.ok) return;
                const status = await response.json() as { running: boolean; phase?: string };
                if (alive) {
                    setRemoteRunning(status.running);
                    setRunPhase(status.phase ?? "");
                }
            } catch { /* 서버 연결이 안 된 경우 기존 오류 처리 유지 */ }
        };
        void check();
        const timer = setInterval(() => void check(), 1000);
        return () => { alive = false; clearInterval(timer); };
    }, []);

    useEffect(() => {
        const events = new EventSource(`${RUNNER_URL}/api/tests/events`);
        events.onmessage = (event: MessageEvent<string>) => {
            try {
                const snapshot = JSON.parse(event.data) as LiveSnapshot | null;
                if (snapshot && liveRunId.current !== snapshot.runId) {
                    liveRunId.current = snapshot.runId;
                    setLiveHistory([]);
                }
                setLive(snapshot);
                if (snapshot?.phase === "running") {
                    setLiveHistory(previous => [...previous, {
                        time: snapshot.elapsedSeconds, rps: snapshot.rps,
                        avgResponseTime: snapshot.metricsAvailable ? snapshot.avgResponseTime : null,
                        p95ResponseTime: snapshot.metricsAvailable && typeof snapshot.p95ResponseTime === "number" ? snapshot.p95ResponseTime : null,
                        failureRate: snapshot.metricsAvailable ? snapshot.failureRate : null,
                        activeVus: typeof snapshot.activeVus === "number" ? snapshot.activeVus : null,
                        targetVus: typeof snapshot.targetVus === "number" ? snapshot.targetVus : null,
                    }].slice(-3600));
                }
            } catch { /* Ignore malformed SSE frames */ }
        };
        return () => events.close();
    }, []);

    async function cancelTest() {
        setCancelling(true);
        try {
            const response = await fetch(`${RUNNER_URL}/api/tests/active/cancel`, { method: "POST" });
            const data = await response.json() as ApiErrorResponse;
            if (!response.ok) throw new Error(data.message ?? "중단 요청 실패");
        } catch (error) {
            setError(errorMessage(error));
        } finally {
            setCancelling(false);
        }
    }
    const [error, setError] = useState("");
    const [result, setResult] = useState<TestResult | null>(null);
    const [copied, setCopied] = useState(false);

    const selectedHttpMethod =
        selected?.method?.toUpperCase() ?? "";

    const supportsDistribution =
        DISTRIBUTION_METHODS.includes(selectedHttpMethod);

    const isDelete = selectedHttpMethod === "DELETE";

    const deleteOperations = operations.filter(
        (operation) => operation.method.toUpperCase() === "DELETE"
    );

    const selectedCleanupOperation = deleteOperations.find(
        (operation) => operation.path === cleanupPath
    );

    const toSeconds = (value: string) => value.endsWith("m")
        ? Number.parseInt(value, 10) * 60 : Number.parseInt(value, 10);
    const durationSeconds = loadMode === "ramping" && !isDelete
        ? toSeconds(rampUpDuration) + toSeconds(holdDuration) + toSeconds(rampDownDuration)
        : toSeconds(duration);

    const pathParameters = (
        selected?.parameters ?? []
    ).filter((parameter) => parameter.in === "path");

    const distributed =
        supportsDistribution &&
        pathIdMode === "distributed";

    const pathIds = parsePathIds(pathIdsInput);

    const requestBodyFields =
        selected?.requestBodyFields ?? [];

    const enabledUniqueFields = requestBodyFields
        .filter(
            (field) =>
                ["string", "integer", "number"].includes(field.type) &&
                !field.enum?.length &&
                uniqueFields[field.name]
        )
        .map((field) => field.name);

    const hasUniqueFields =
        enabledUniqueFields.length > 0;

    const monitorStatus =
        running || remoteRunning
            ? live?.phase === "cleaning"
                ? "정리 중"
                : live?.cancelled
                    ? "중단 중"
                    : "실행 중"
            : result?.cancelled
                ? "중단됨"
                : result?.success
                    ? "완료"
                    : result
                        ? "실패"
                        : "종료됨";

    async function loadOpenApi() {
        setLoading(true);
        setError("");
        setSelected(null);
        setResult(null);
        setParameters({});
        setBodyValues({});
        setUniqueFields({});
        setPathIdsInput("");
        setPathIdParameter("");
        setPathIdMode("same");
        setAutoCleanup(false);
        setCleanupPath("");
        setCleanupIdField("id");
        setCleanupPathMode("openapi");
        setLive(null);
        setLiveHistory([]);
        liveRunId.current = null;
        try {
            const url = new URL(
                `${RUNNER_URL}/api/openapi`
            );

            url.searchParams.set("url", openApiUrl);

            const response = await fetch(url);
            const data = (await response.json()) as OpenApiResponse;

            if (!response.ok) {
                throw new Error(
                    data.message ?? "명세 조회 실패"
                );
            }

            setOperations(data.operations ?? []);

            const parsed = new URL(openApiUrl);
            setBaseUrl(parsed.origin);
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setLoading(false);
        }
    }

    function selectOperation(operation: ApiOperation) {
        const method = operation.method.toUpperCase();

        const operationPathParameters = (
            operation.parameters ?? []
        ).filter(
            (parameter) => parameter.in === "path"
        );

        const defaultPathParameter =
            operationPathParameters.find(
                (parameter) => parameter.name === "id"
            )?.name ??
            operationPathParameters[0]?.name ??
            "";

        setSelected(operation);
        setParameters({});
        setBodyValues({});
        setUniqueFields({});
        setAutoCleanup(false);
        setCleanupPath("");
        setCleanupIdField("id");
        setCleanupPathMode("openapi");
        setPathIdParameter(defaultPathParameter);
        setPathIdsInput("");
        setPathIdMode(
            method === "DELETE"
                ? "distributed"
                : "same"
        );
        setResult(null);
        setLive(null);
        setLiveHistory([]);
        liveRunId.current = null;
        setError("");
        setCopied(false);
    }

    function updateBodyValue(name: string, value: string) {
        setBodyValues((prev) => ({
            ...prev,
            [name]: value,
        }));

        setCopied(false);
    }

    function updateUniqueField(name: string, checked: boolean) {
        setUniqueFields((prev) => ({
            ...prev,
            [name]: checked,
        }));

        setCopied(false);
    }

    const requestBodyPreview = (() => {
        if (!selected?.requestBody) {
            return null;
        }

        try {
            const body = buildRequestBody(
                requestBodyFields.map((field) => ({
                    ...field,
                    required: false,
                })),
                bodyValues
            );

            for (const field of requestBodyFields) {
                if (
                    uniqueFields[field.name] &&
                    ["string", "integer", "number"].includes(field.type) &&
                    !field.enum?.length &&
                    body[field.name] !== undefined
                ) {
                    if (field.type === "string") {
                        body[field.name] = `${body[field.name]}_runId_GLOBAL_ITER`;
                    } else {
                        body[field.name] = `${body[field.name]} + GLOBAL_ITER`;
                    }
                }
            }

            return {
                data: body,
                error: null,
            };
        } catch (e) {
            return {
                data: null,
                error: errorMessage(e),
            };
        }
    })();

    const filteredOperations = operations.filter(
        (operation) => {
            const keyword = searchKeyword
                .trim()
                .toLowerCase();

            const matchesMethod =
                selectedMethod === "ALL" ||
                operation.method.toUpperCase() ===
                selectedMethod;

            const matchesKeyword =
                !keyword ||
                [
                    operation.method,
                    operation.path,
                    operation.summary,
                    ...(operation.tags ?? []),
                ].some((value) =>
                    String(value ?? "")
                        .toLowerCase()
                        .includes(keyword)
                );

            return matchesMethod && matchesKeyword;
        }
    );

    const groupedOperations = filteredOperations.reduce<
        Record<string, ApiOperation[]>
    >((groups, operation) => {
        const tag = operation.tags?.[0] || "기타";

        if (!groups[tag]) {
            groups[tag] = [];
        }

        groups[tag].push(operation);

        return groups;
    }, {});


    async function copyRequestBody() {
        if (
            !requestBodyPreview ||
            requestBodyPreview.error
        ) {
            return;
        }

        try {
            await navigator.clipboard.writeText(
                JSON.stringify(
                    requestBodyPreview.data,
                    null,
                    2
                )
            );

            setCopied(true);
        } catch {
            setError("JSON 복사에 실패했습니다.");
        }
    }

    async function runTest() {
        if (!selected || running || remoteRunning) {
            return;
        }

        const currentMethod =
            selected.method.toUpperCase();

        const isDistributed =
            DISTRIBUTION_METHODS.includes(currentMethod) &&
            pathIdMode === "distributed";

        const ids = parsePathIds(pathIdsInput);

        // DELETE는 반드시 ID 분배 방식으로 실행
        if (
            currentMethod === "DELETE" &&
            !isDistributed
        ) {
            setError(
                "DELETE 테스트는 ID 분배 모드로 실행해야 합니다."
            );
            return;
        }

        if (isDistributed) {
            if (!pathIdParameter) {
                setError(
                    "분배할 Path Parameter를 선택해주세요."
                );
                return;
            }

            if (
                !pathParameters.some(
                    (parameter) =>
                        parameter.name === pathIdParameter
                )
            ) {
                setError(
                    "선택한 Path Parameter가 올바르지 않습니다."
                );
                return;
            }

            if (ids.length === 0) {
                setError(
                    "대상 ID를 하나 이상 입력해주세요."
                );
                return;
            }

            if (
                currentMethod === "DELETE" &&
                new Set(ids).size !== ids.length
            ) {
                setError(
                    "삭제 대상 ID 목록에 중복된 값이 있습니다."
                );
                return;
            }

            if (
                ids.some(
                    (id) =>
                        id === "." ||
                        id === ".." ||
                        id.includes("/") ||
                        id.includes("\\") ||
                        id.includes("?") ||
                        id.includes("#")
                )
            ) {
                setError(
                    "ID에 경로 구분자나 URL 제어 문자를 사용할 수 없습니다."
                );
                return;
            }
        }

        let resolvedPath = selected.path;
        const queryParams: Record<string, InputValue> = {};

        for (const parameter of selected.parameters ?? []) {
            if (
                parameter.in !== "path" &&
                parameter.in !== "query"
            ) {
                continue;
            }

            // 분배 대상 Path Parameter는
            // k6에서 요청마다 치환하도록 유지
            if (
                isDistributed &&
                parameter.in === "path" &&
                parameter.name === pathIdParameter
            ) {
                continue;
            }

            const input =
                parameters[
                    `${parameter.in}:${parameter.name}`
                    ];

            const defaultValue =
                parameter.schema?.default;

            const value: InputValue | null | undefined =
                input === undefined || input === ""
                    ? defaultValue
                    : input;

            const missing =
                value === undefined ||
                value === null ||
                String(value).trim() === "";

            if (
                missing &&
                (
                    parameter.required ||
                    parameter.in === "path"
                )
            ) {
                setError(
                    `필수 파라미터를 입력해주세요: ${parameter.name}`
                );
                return;
            }

            if (missing || value === undefined || value === null) {
                continue;
            }

            if (parameter.in === "path") {
                resolvedPath = resolvedPath.replace(
                    `{${parameter.name}}`,
                    encodeURIComponent(String(value))
                );
            } else {
                queryParams[parameter.name] = value;
            }
        }

        // 분배 대상 파라미터만 예외 처리
        const unresolvedPath = isDistributed
            ? resolvedPath.replace(
                `{${pathIdParameter}}`,
                ""
            )
            : resolvedPath;

        if (
            /\{[^}]*\}/.test(unresolvedPath)
        ) {
            setError(
                "치환되지 않은 Path Parameter가 있습니다."
            );
            return;
        }

        let parsedBody: Record<string, JsonValue> | null = null;

        if (selected.requestBody) {
            if (requestBodyFields.length === 0) {
                setError(
                    "Request Body 필드 정보를 가져오지 못했습니다. OpenAPI 스키마를 확인해주세요."
                );
                return;
            }

            try {
                parsedBody = buildRequestBody(
                    requestBodyFields,
                    bodyValues
                );
            } catch (e) {
                setError(errorMessage(e));
                return;
            }
        }

        if (currentMethod === "POST" && autoCleanup) {
            const trimmedPath = cleanupPath.trim();
            const trimmedIdField = cleanupIdField.trim();

            if (!trimmedPath.startsWith("/") || trimmedPath.startsWith("//") ||
                !trimmedPath.includes("{id}") ||
                trimmedPath.split("{id}").length !== 2 ||
                trimmedPath.includes("?") || trimmedPath.includes("#") ||
                trimmedPath.includes("\\") ||
                trimmedPath.split("/").includes("..")) {
                setError("DELETE API 경로는 /로 시작하고 {id}를 정확히 한 번 포함해야 합니다. 예: /api/animals/{id}");
                return;
            }

            if (!/^[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*)*$/.test(trimmedIdField)) {
                setError("POST 응답 ID 경로를 확인해주세요. 예: id 또는 data.id");
                return;
            }
        }

        const numericSleepSeconds = Number(sleepSeconds);

        if (!Number.isFinite(numericSleepSeconds) || numericSleepSeconds < 0 || numericSleepSeconds > 10) {
            setError("Sleep은 0~10초 사이로 설정해주세요.");
            return;
        }

        const numericVus = Number(vus);

        if (
            !Number.isInteger(numericVus) ||
            numericVus < 1 ||
            numericVus > 1501
        ) {
            setError(
                "가상 사용자 수는 1~1501 사이의 정수여야 합니다."
            );
            return;
        }

        if (thresholdEnabled && (
            !Number.isFinite(Number(thresholdP95)) || Number(thresholdP95) <= 0 || Number(thresholdP95) > 600000 ||
            !Number.isFinite(Number(thresholdFailureRate)) || Number(thresholdFailureRate) <= 0 || Number(thresholdFailureRate) > 100 ||
            !Number.isFinite(Number(thresholdRps)) || Number(thresholdRps) <= 0 || Number(thresholdRps) > 1000000
        )) {
            setError("성공 조건을 확인해주세요. P95: 0~600000ms, 실패율: 0~100%, RPS: 0~1000000 (모두 0 초과)");
            return;
        }

        setRunning(true);
        setError("");
        setResult(null);
        setLive(null);
        setLiveHistory([]);
        liveRunId.current = null;

        try {
            const response = await fetch(
                `${RUNNER_URL}/api/tests`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        baseUrl,
                        method: currentMethod,
                        path: resolvedPath,
                        vus: numericVus,
                        duration,
                        loadMode: currentMethod === "DELETE" ? "constant" : loadMode,
                        rampUpDuration,
                        holdDuration,
                        rampDownDuration,
                        thresholds: { enabled: thresholdEnabled, p95Ms: Number(thresholdP95), failureRatePercent: Number(thresholdFailureRate), minRps: Number(thresholdRps) },
                        sleepSeconds: currentMethod === "DELETE" ? 0 : numericSleepSeconds,
                        query: queryParams,
                        requestBody: parsedBody,
                        uniqueFields: enabledUniqueFields,
                        autoCleanup: currentMethod === "POST" && autoCleanup,
                        cleanupPath: currentMethod === "POST" && autoCleanup
                            ? cleanupPath.trim() : "",
                        cleanupIdField: currentMethod === "POST" && autoCleanup
                            ? cleanupIdField.trim() : "",

                        // PUT / PATCH / DELETE
                        pathIdMode: isDistributed
                            ? "distributed"
                            : "same",
                        pathIdParameter:
                            pathIdParameter || "id",
                        pathIds: isDistributed
                            ? ids
                            : [],

                        ...buildRequestSettings(requestSettings),
                    }),
                }
            );

            const data = (await response.json()) as TestResult & ApiErrorResponse;

            if (!response.ok) {
                throw new Error(
                    data.message ?? "테스트 실패"
                );
            }

            setResult(data);
            if (data.cancelled) setError("사용자 요청으로 테스트가 중단되었습니다. 자동 정리 결과를 확인하세요.");
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setRunning(false);
        }
    }

    const metrics: TestMetrics = result?.metrics ?? {};

    return (
        <div className="app">
            <header className="header">
                <div className="container">
                    <span className="eyebrow">
                        DEVELOPER TOOLS
                    </span>

                    <h1>API Performance Console</h1>

                    <p>
                        OpenAPI 기반 로컬 k6 성능 테스트 도구
                    </p>
                </div>
            </header>

            <main className="container main">
                {/* 프로젝트 연결 */}
                <section className="panel">
                    <h2>프로젝트 연결</h2>

                    <div className="field">
                        <label>OpenAPI URL</label>

                        <input
                            value={openApiUrl}
                            onChange={(e) =>
                                setOpenApiUrl(e.target.value)
                            }
                            placeholder="http://localhost:8080/v3/api-docs"
                        />
                    </div>

                    <button
                        onClick={loadOpenApi}
                        disabled={loading || running || remoteRunning}
                    >
                        {loading
                            ? "불러오는 중..."
                            : "API 목록 불러오기"}
                    </button>
                </section>

                <div className="workspace">
                    {/* API 목록 */}
                    <section className="panel">
                        <h2>
                            API 목록 (
                            {filteredOperations.length}/
                            {operations.length})
                        </h2>

                        <div className="field">
                            <div className="method-filters">
                                {HTTP_METHODS.map((method) => (
                                    <button
                                        key={method}
                                        type="button"
                                        className={
                                            `method-filter ${method.toLowerCase()} ` +
                                            (
                                                selectedMethod === method
                                                    ? "active"
                                                    : ""
                                            )
                                        }
                                        onClick={() =>
                                            setSelectedMethod(method)
                                        }
                                    >
                                        {method === "ALL"
                                            ? "전체"
                                            : method}
                                    </button>
                                ))}
                            </div>

                            <input
                                type="search"
                                value={searchKeyword}
                                onChange={(e) =>
                                    setSearchKeyword(e.target.value)
                                }
                                placeholder="Method, API 경로, 설명 검색..."
                                aria-label="API 검색"
                            />
                        </div>

                        <div className="api-list">
                            {Object.entries(groupedOperations).map(([tag, groupOperations]) => (
                                <details
                                    key={tag}
                                    className="api-group"
                                >
                                    <summary className="api-group-header">
                <span className="api-group-title">
                    <span className="api-group-arrow">▶</span>
                    {tag}
                </span>

                                        <span className="api-group-count">
                    {groupOperations.length}
                </span>
                                    </summary>

                                    <div className="api-group-items">
                                        {groupOperations.map((operation) => (
                                            <button
                                                key={`${operation.method}-${operation.path}`}
                                                type="button"
                                                className={
                                                    "api-item " +
                                                    (selected === operation ? "active" : "")
                                                }
                                                onClick={() => selectOperation(operation)}
                                                disabled={running || remoteRunning}
                                            >
                        <span
                            className={`method ${operation.method.toLowerCase()}`}
                        >
                            {operation.method}
                        </span>

                                                <span className="api-info">
                            <strong>{operation.path}</strong>

                            <small>
                                {operation.summary || "설명 없음"}
                            </small>
                        </span>
                                            </button>
                                        ))}
                                    </div>
                                </details>
                            ))}

                            {filteredOperations.length === 0 && (
                                <p className="muted">
                                    {operations.length === 0
                                        ? "OpenAPI 명세를 불러오면 API 목록이 표시됩니다."
                                        : "검색 결과가 없습니다."}
                                </p>
                            )}
                        </div>
                    </section>

                    {/* 테스트 설정 */}
                    <section className="panel">
                        <h2>테스트 설정</h2>

                        {!selected ? (
                            <p className="muted">
                                왼쪽에서 테스트할 API를 선택하세요.
                            </p>
                        ) : (
                            <>
                                <div className="selected-api">
                                    <span
                                        className={
                                            `method ${selected.method.toLowerCase()}`
                                        }
                                    >
                                        {selected.method}
                                    </span>

                                    <strong>
                                        {selected.path}
                                    </strong>
                                </div>

                                <div className="field">
                                    <label>
                                        Base URL (자동 설정)
                                    </label>

                                    <input
                                        value={baseUrl}
                                        readOnly
                                        className="readonly-input"
                                    />
                                </div>

                                {/* Path / Query Parameter */}
                                {(selected.parameters ?? [])
                                    .filter(
                                        (parameter) =>
                                            parameter.in === "query" ||
                                            parameter.in === "path"
                                    )
                                    .map((parameter) => {
                                        const isDistributedParameter =
                                            distributed &&
                                            parameter.in === "path" &&
                                            parameter.name ===
                                            pathIdParameter;

                                        return (
                                            <div
                                                className="field"
                                                key={
                                                    `${parameter.in}:${parameter.name}`
                                                }
                                            >
                                                <label>
                                                    {parameter.name} (
                                                    {parameter.in === "path"
                                                        ? "Path"
                                                        : "Query"}
                                                    )

                                                    {parameter.description && (
                                                        <small className="parameter-description">
                                                            {" "}
                                                            ({parameter.description})
                                                        </small>
                                                    )}

                                                    {(parameter.required ||
                                                        parameter.in === "path") && (
                                                        <span className="required-mark">
                                                            {" "}*
                                                        </span>
                                                    )}

                                                    <small className="parameter-type">
                                                        {" "}
                                                        {parameter.schema?.type ??
                                                            "string"}
                                                    </small>
                                                </label>

                                                <input
                                                    type={
                                                        [
                                                            "integer",
                                                            "number",
                                                        ].includes(
                                                            parameter.schema?.type ?? "string"
                                                        )
                                                            ? "number"
                                                            : "text"
                                                    }
                                                    step={
                                                        parameter.schema?.type ===
                                                        "integer"
                                                            ? "1"
                                                            : "any"
                                                    }
                                                    required={
                                                        !isDistributedParameter &&
                                                        (
                                                            parameter.required === true ||
                                                            parameter.in === "path"
                                                        )
                                                    }
                                                    disabled={
                                                        running ||
                                                        isDistributedParameter
                                                    }
                                                    value={
                                                        isDistributedParameter
                                                            ? ""
                                                            : (
                                                                parameters[
                                                                    `${parameter.in}:${parameter.name}`
                                                                    ] ?? ""
                                                            )
                                                    }
                                                    placeholder={
                                                        isDistributedParameter
                                                            ? "아래 ID 목록에서 자동 분배"
                                                            : parameter.schema?.default != null
                                                                ? String(
                                                                    parameter.schema.default
                                                                )
                                                                : parameter.required ||
                                                                parameter.in === "path"
                                                                    ? "필수값을 입력하세요"
                                                                    : "선택값"
                                                    }
                                                    onChange={(e) =>
                                                        setParameters((prev) => ({
                                                            ...prev,
                                                            [
                                                                `${parameter.in}:${parameter.name}`
                                                                ]: e.target.value,
                                                        }))
                                                    }
                                                />
                                            </div>
                                        );
                                    })}

                                {/* PUT / PATCH / DELETE ID 분배 */}
                                {supportsDistribution && (
                                    <div className="path-distribution">
                                        <h3>
                                            Path ID 테스트 설정
                                        </h3>

                                        {pathParameters.length === 0 ? (
                                            <p className="muted">
                                                이 API에는 Path Parameter가 없습니다.
                                                ID 분배 기능을 사용할 수 없습니다.
                                            </p>
                                        ) : (
                                            <>
                                                {!isDelete && (
                                                    <div className="field">
                                                        <label>
                                                            테스트 방식
                                                        </label>

                                                        <select
                                                            value={pathIdMode}
                                                            onChange={(e) =>
                                                                setPathIdMode(
                                                                    e.target.value as "same" | "distributed"
                                                                )
                                                            }
                                                            disabled={running}
                                                        >
                                                            <option value="same">
                                                                동일 ID 반복
                                                            </option>

                                                            <option value="distributed">
                                                                여러 ID 순환
                                                            </option>
                                                        </select>
                                                    </div>
                                                )}

                                                {isDelete && (
                                                    <p className="muted">
                                                        DELETE는 각 ID를 한 번씩
                                                        삭제하는 방식으로 실행됩니다.
                                                    </p>
                                                )}

                                                {distributed && (
                                                    <>
                                                        <div className="field">
                                                            <label>
                                                                분배할 Path Parameter
                                                            </label>

                                                            <select
                                                                value={pathIdParameter}
                                                                onChange={(e) =>
                                                                    setPathIdParameter(
                                                                        e.target.value
                                                                    )
                                                                }
                                                                disabled={running}
                                                            >
                                                                {pathParameters.map(
                                                                    (parameter) => (
                                                                        <option
                                                                            key={parameter.name}
                                                                            value={parameter.name}
                                                                        >
                                                                            {parameter.name}
                                                                        </option>
                                                                    )
                                                                )}
                                                            </select>
                                                        </div>

                                                        <div className="field">
                                                            <label>
                                                                {isDelete
                                                                    ? "삭제 대상 ID 목록"
                                                                    : "수정 대상 ID 목록"}
                                                            </label>

                                                            <textarea
                                                                rows={4}
                                                                value={pathIdsInput}
                                                                onChange={(e) =>
                                                                    setPathIdsInput(
                                                                        e.target.value
                                                                    )
                                                                }
                                                                placeholder={
                                                                    "101,102,103,104,105"
                                                                }
                                                                disabled={running}
                                                            />

                                                            <small className="muted">
                                                                쉼표 또는 줄바꿈으로
                                                                구분해서 입력하세요.
                                                            </small>
                                                        </div>

                                                        <div className="path-distribution-summary">
                                                            <strong>
                                                                대상 ID: {pathIds.length}개
                                                            </strong>

                                                            <p>
                                                                {isDelete
                                                                    ? `총 ${pathIds.length}회 삭제 요청을 실행합니다. 각 ID는 한 번만 사용됩니다.`
                                                                    : "요청마다 ID 목록을 순환하여 사용합니다."}
                                                            </p>
                                                        </div>

                                                        {isDelete &&
                                                            pathIds.length > 0 &&
                                                            new Set(pathIds).size !==
                                                            pathIds.length && (
                                                                <p className="request-preview-error">
                                                                    중복된 ID가 있습니다.
                                                                    DELETE는 중복 ID를
                                                                    사용할 수 없습니다.
                                                                </p>
                                                            )}
                                                    </>
                                                )}
                                            </>
                                        )}
                                    </div>
                                )}

                                {/* Request Body */}
                                {selected.requestBody && (
                                    <div className="request-body-fields">
                                        <h3>Request Body</h3>

                                        <RequestBodyEditor
                                            fields={requestBodyFields}
                                            values={bodyValues}
                                            onChange={updateBodyValue}
                                            uniqueFields={uniqueFields}
                                            onUniqueChange={updateUniqueField}
                                            disabled={running}
                                        />

                                        {/* JSON 미리보기 */}
                                        {requestBodyFields.length > 0 && (
                                            <div className="request-preview">
                                                <div className="request-preview-header">
                                                    <h3>
                                                        요청 데이터 미리보기
                                                    </h3>

                                                    <button
                                                        type="button"
                                                        className="preview-copy-button"
                                                        onClick={copyRequestBody}
                                                        disabled={
                                                            requestBodyPreview?.error != null
                                                        }
                                                    >
                                                        {copied
                                                            ? "복사 완료"
                                                            : "JSON 복사"}
                                                    </button>
                                                </div>

                                                {requestBodyPreview?.error ? (
                                                    <p className="request-preview-error">
                                                        {requestBodyPreview.error}
                                                    </p>
                                                ) : (
                                                    <pre className="request-preview-code">
                                                        <code>
                                                            {JSON.stringify(
                                                                requestBodyPreview?.data ?? {},
                                                                null,
                                                                2
                                                            )}
                                                        </code>
                                                    </pre>
                                                )}

                                                {hasUniqueFields && (
                                                    <p className="request-preview-help">
                                                        고유값이 설정된 필드는
                                                        테스트 실행 시 runId,
                                                        VU 번호, 반복 횟수에
                                                        따라 변경됩니다.
                                                        현재 표시된 값은 예시입니다.
                                                    </p>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}

                                <RequestHeadersEditor baseUrl={baseUrl} disabled={running || remoteRunning} />
                                {selectedHttpMethod === "POST" && (
                                    <div className="field">
                                        <label className="unique-field-option">
                                            <input
                                                type="checkbox"
                                                checked={autoCleanup}
                                                onChange={(e) =>
                                                    setAutoCleanup(e.target.checked)
                                                }
                                                disabled={running}
                                            />
                                            테스트 종료 후 생성 데이터 자동 삭제
                                        </label>

                                        {autoCleanup && (
                                            <div className="path-distribution">
                                                <h3>생성 데이터 자동 삭제 설정</h3>

                                                <div className="field">
                                                    <label>DELETE API 선택 방식</label>
                                                    <select
                                                        value={cleanupPathMode}
                                                        onChange={(e) => {
                                                            setCleanupPathMode(e.target.value as "openapi" | "manual");
                                                            setCleanupPath("");
                                                        }}
                                                        disabled={running}
                                                    >
                                                        <option value="openapi">OpenAPI에서 선택</option>
                                                        <option value="manual">경로 직접 입력</option>
                                                    </select>
                                                </div>

                                                {cleanupPathMode === "openapi" ? (
                                                    <div className="field">
                                                        <label>DELETE API</label>
                                                        <select
                                                            value={cleanupPath}
                                                            onChange={(e) => setCleanupPath(e.target.value)}
                                                            disabled={running}
                                                        >
                                                            <option value="">삭제할 API를 선택하세요</option>
                                                            {deleteOperations.map((operation) => (
                                                                <option
                                                                    key={operation.path}
                                                                    value={operation.path}
                                                                >
                                                                    {operation.path} {operation.summary ? `- ${operation.summary}` : ""}
                                                                </option>
                                                            ))}
                                                        </select>
                                                        {deleteOperations.length === 0 && (
                                                            <p className="muted">
                                                                OpenAPI에 DELETE API가 없습니다. 직접 입력을 선택하세요.
                                                            </p>
                                                        )}
                                                        {selectedCleanupOperation &&
                                                            !selectedCleanupOperation.path.includes("{id}") && (
                                                                <p className="request-preview-error">
                                                                    선택한 DELETE API는 {'{id}'} 경로 변수가 없습니다.
                                                                    직접 입력하거나 다른 API를 선택하세요.
                                                                </p>
                                                            )}
                                                    </div>
                                                ) : (
                                                    <div className="field">
                                                        <label>DELETE API 경로</label>
                                                        <input
                                                            value={cleanupPath}
                                                            onChange={(e) => setCleanupPath(e.target.value)}
                                                            placeholder="/api/animals/{id}"
                                                            disabled={running}
                                                        />
                                                    </div>
                                                )}

                                                <div className="field">
                                                    <label>POST 응답 ID 경로</label>
                                                    <input
                                                        value={cleanupIdField}
                                                        onChange={(e) => setCleanupIdField(e.target.value)}
                                                        placeholder="id 또는 data.id"
                                                        disabled={running}
                                                    />
                                                </div>

                                                <p className="muted">
                                                    POST 응답에서 생성된 ID를 수집하고, 테스트가 끝나면
                                                    선택한 DELETE API로 삭제합니다. DELETE 경로에는
                                                    {' {id} '}를 정확히 한 번 포함해야 합니다.
                                                </p>
                                                <p className="muted">
                                                    예: 응답이 {'{ "data": { "id": 101 } }'}이면
                                                    ID 경로는 data.id입니다. 생성 ID를 반환하지 않는
                                                    API는 이 방식으로 자동 삭제할 수 없습니다.
                                                </p>
                                            </div>
                                        )}
                                    </div>
                                )}
                                {!isDelete && (
                                    <div className="field">
                                        <label>부하 테스트 방식</label>
                                        <select value={loadMode} onChange={e => setLoadMode(e.target.value as "constant" | "ramping")}
                                                disabled={running || remoteRunning}>
                                            <option value="constant">고정 VU</option>
                                            <option value="ramping">단계별 부하 (Ramp-up / 유지 / Ramp-down)</option>
                                        </select>
                                    </div>
                                )}
                                {/* VU / Duration */}
                                <div className="settings-grid">
                                    <div className="field">
                                        <label>
                                            가상 사용자 (VU)
                                        </label>

                                        <input
                                            type="number"
                                            min="1"
                                            max="1501"
                                            value={vus}
                                            onChange={(e) =>
                                                setVus(e.target.value)
                                            }
                                            disabled={running}
                                        />
                                    </div>

                                    <div className="field">
                                        <label>
                                            {isDelete
                                                ? "실행 방식"
                                                : loadMode === "ramping" ? "전체 실행 시간" : "실행 시간"}
                                        </label>

                                        {isDelete ? (
                                            <input
                                                value="ID별 1회 요청"
                                                readOnly
                                                className="readonly-input"
                                            />
                                        ) : loadMode === "ramping" ? (
                                            <input readOnly className="readonly-input" value={`${durationSeconds}초`} />
                                        ) : (
                                            <select
                                                value={duration}
                                                onChange={(e) =>
                                                    setDuration(e.target.value)
                                                }
                                                disabled={running}
                                            >
                                                <option value="10s">
                                                    10초
                                                </option>

                                                <option value="30s">
                                                    30초
                                                </option>

                                                <option value="1m">
                                                    1분
                                                </option>

                                                <option value="3m">
                                                    3분
                                                </option>
                                            </select>
                                        )}
                                    </div>
                                </div>

                                {!isDelete && loadMode === "ramping" && (
                                    <div className="ramp-stages">
                                        {([
                                            ["Ramp-up", rampUpDuration, setRampUpDuration],
                                            ["유지", holdDuration, setHoldDuration],
                                            ["Ramp-down", rampDownDuration, setRampDownDuration],
                                        ] as const).map(([label, value, setter]) => (
                                            <div className="field" key={label}>
                                                <label>{label}</label>
                                                <select value={value} onChange={e => setter(e.target.value)} disabled={running || remoteRunning}>
                                                    <option value="10s">10초</option>
                                                    <option value="30s">30초</option>
                                                    <option value="1m">1분</option>
                                                    <option value="3m">3분</option>
                                                </select>
                                            </div>
                                        ))}
                                        <small className="muted">0 → 최대 {vus || 0} VU → 유지 → 0 VU (k6 ramping-vus)</small>
                                    </div>
                                )}
                                {!isDelete && (
                                    <div className="field">
                                        <label>요청 간 대기 시간 (Sleep)</label>
                                        <select
                                            value={sleepSeconds}
                                            onChange={(e) => setSleepSeconds(Number(e.target.value))}
                                            disabled={running}
                                        >
                                            <option value={0}>0초 — 대기 없이 최대 처리량 측정</option>
                                            <option value={0.5}>0.5초</option>
                                            <option value={1}>1초</option>
                                            <option value={2}>2초</option>
                                            <option value={3}>3초</option>
                                            <option value={5}>5초</option>
                                            <option value={10}>10초</option>
                                        </select>
                                        <small className="muted">
                                            각 VU가 요청을 완료한 후 다음 요청 전 대기합니다. 기본값은 0초입니다.
                                        </small>
                                    </div>
                                )}

                                <div className="threshold-config">
                                    <label className="threshold-toggle">
                                        <input type="checkbox" checked={thresholdEnabled} onChange={e => setThresholdEnabled(e.target.checked)} disabled={running || remoteRunning} />
                                        <strong>성공 조건 (Threshold) 자동 판정</strong>
                                    </label>
                                    {thresholdEnabled && (
                                        <div className="threshold-grid">
                                            <div className="field">
                                                <label>P95 상한 (ms)</label>
                                                <input
                                                    type="number"
                                                    min="1"
                                                    max="600000"
                                                    value={thresholdP95}
                                                    onChange={(e) => setThresholdP95(e.target.value)}
                                                    disabled={running || remoteRunning}
                                                />
                                            </div>

                                            <div className="field">
                                                <label>실패율 상한 (%)</label>
                                                <input
                                                    type="number"
                                                    min="0.01"
                                                    max="100"
                                                    step="0.01"
                                                    value={thresholdFailureRate}
                                                    onChange={(e) => setThresholdFailureRate(e.target.value)}
                                                    disabled={running || remoteRunning}
                                                />
                                            </div>

                                            <div className="field">
                                                <label>최소 RPS</label>
                                                <input
                                                    type="number"
                                                    min="0.01"
                                                    step="0.01"
                                                    value={thresholdRps}
                                                    onChange={(e) => setThresholdRps(e.target.value)}
                                                    disabled={running || remoteRunning}
                                                />
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <button
                                    className="run-button"
                                    disabled={running || remoteRunning}
                                    onClick={runTest}
                                >
                                    {running ? "k6 테스트 실행 중..." : "k6 테스트 실행"}
                                </button>
                                {(running || remoteRunning) && (
                                    <>
                                        <div
                                            role="status"
                                            className={`k6-run-status ${
                                                cancelling
                                                    ? "is-cancelling"
                                                    : runPhase === "cleaning"
                                                        ? "is-cleaning"
                                                        : "is-running"
                                            }`}
                                        >
                                            {cancelling
                                                ? "테스트 중단 요청 중..."
                                                : runPhase === "cleaning"
                                                    ? "테스트 데이터 정리 중..."
                                                    : "k6 성능 테스트 실행 중"}
                                        </div>

                                        <button
                                            type="button"
                                            className="run-button cancel-button"
                                            disabled={cancelling || runPhase === "cleaning"}
                                            onClick={cancelTest}
                                        >
                                            {runPhase === "cleaning"
                                                ? "테스트 데이터 정리 중..."
                                                : cancelling
                                                    ? "중단 요청 중..."
                                                    : "테스트 중단"}
                                        </button>
                                    </>
                                )}
                            </>
                        )}
                    </section>
                </div>

                {/* 실행 중 실시간 성능 모니터링 */}
                {(running || remoteRunning || live || liveHistory.length > 0) && (
                    <section className="panel live-monitor" aria-label="실시간 성능 모니터링">
                        <div className="live-monitor-heading">
                            <h2>실시간 성능 모니터링</h2>
                            <span className="live-indicator">{monitorStatus}</span>
                        </div>
                        <div className="live-monitor-grid">
                            <div className="live-stat"><span>현재 RPS (최근 5초)</span><strong>{live?.metricsAvailable ? live.rps.toFixed(2) : "—"}</strong></div>
                            <div className="live-stat"><span>평균 응답 시간</span><strong>{live?.metricsAvailable ? `${live.avgResponseTime.toFixed(2)} ms` : "—"}</strong></div>
                            <div className="live-stat"><span>오류율</span><strong>{live?.metricsAvailable ? `${live.failureRate.toFixed(2)}%` : "—"}</strong></div>
                            <div className="live-stat"><span>활성 VU (관측)</span><strong>{typeof live?.activeVus === "number" ? live.activeVus : "—"}</strong></div>
                            <div className="live-stat"><span>목표 VU (설정)</span><strong>{typeof live?.targetVus === "number" ? live.targetVus.toFixed(1) : "—"}</strong></div>
                            <div className="live-stat"><span>진행 시간</span><strong>{live ? `${live.elapsedSeconds.toFixed(1)}초` : "—"}</strong></div>
                        </div>
                        <div className="live-charts-grid">
                            <div className="live-chart-panel">
                                <div className="live-chart-topline">
                                    <div>
                                        <span className="live-chart-overline">TRAFFIC OVERVIEW</span>
                                        <h3>Requests per second <span>RPS</span></h3>
                                    </div>
                                    <span className="live-chart-period">
                      테스트 시간 {durationSeconds}초 · 1초 간격
                    </span>
                                </div>
                                <div className="live-chart-container" role="img" aria-label="시간에 따른 실시간 RPS 그래프">
                                    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                                        <AreaChart
                                            data={liveHistory.map(point => ({time: point.time, rps: point.rps}))}
                                            margin={{ top: 12, right: 18, bottom: 8, left: -8 }}
                                        >
                                            <defs>
                                                <linearGradient id="k6RpsFill" x1="0" y1="0" x2="0" y2="1">
                                                    <stop offset="0%" stopColor="#2563eb" stopOpacity={0.25} />
                                                    <stop offset="95%" stopColor="#2563eb" stopOpacity={0.015} />
                                                </linearGradient>
                                            </defs>
                                            <CartesianGrid stroke="#e8eef6" strokeDasharray="4 5" vertical={false} />
                                            <XAxis
                                                dataKey="time"
                                                type="number"
                                                domain={[0, Math.max(durationSeconds, Math.ceil(live?.elapsedSeconds ?? 0))]}
                                                ticks={Array.from(
                                                    { length: 6 },
                                                    (_, i) => Math.round(Math.max(durationSeconds, Math.ceil(live?.elapsedSeconds ?? 0)) / 5 * i)
                                                )}
                                                allowDataOverflow
                                                tickFormatter={(value: number) => `${value}초`}
                                                tick={{ fontSize: 11, fill: "#94a3b8" }}
                                                axisLine={false}
                                                tickLine={false}
                                                allowDecimals={false}
                                            />
                                            <YAxis
                                                tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false}
                                                width={48} domain={[0, (max: number) => Math.max(10, Math.ceil(max * 1.2))]}
                                                allowDecimals={false}
                                            />
                                            <Tooltip
                                                contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', boxShadow: '0 10px 30px rgba(15,23,42,.1)', fontSize: 12 }}
                                                labelFormatter={(value) => `경과 ${value}초`}
                                                formatter={(value) => [`${Number(value).toFixed(2)} req/s`, 'RPS']}
                                            />
                                            <Area type="monotone" dataKey="rps" name="RPS" stroke="#2563eb"
                                                  strokeWidth={3} fill="url(#k6RpsFill)" connectNulls={false}
                                                  dot={false} activeDot={{ r: 5, strokeWidth: 3, stroke: '#fff' }}
                                                  isAnimationActive={false} />
                                        </AreaChart>
                                    </ResponsiveContainer>
                                </div>
                                <div className="live-chart-footer">
                                    <span><i className="live-chart-legend-dot" /> 실시간 RPS</span>
                                    <span>테스트 진행 {live ? `${live.elapsedSeconds.toFixed(1)}초` : '대기 중'}</span>
                                </div>
                            </div>
                            <LiveVuChart history={liveHistory} durationSeconds={durationSeconds} elapsedSeconds={live?.elapsedSeconds ?? 0} />
                            <LiveTrendChart
                                title="평균 응답 시간 추이"
                                subtitle="RESPONSE TIME"
                                unit="ms"
                                color="#0d9488"
                                dataKey="avgResponseTime"
                                history={liveHistory}
                                durationSeconds={durationSeconds}
                                elapsedSeconds={live?.elapsedSeconds ?? 0}
                            />
                            <LiveTrendChart
                                title="P95 응답 시간 추이"
                                subtitle="95TH PERCENTILE"
                                unit="ms"
                                color="#7c3aed"
                                dataKey="p95ResponseTime"
                                history={liveHistory}
                                durationSeconds={durationSeconds}
                                elapsedSeconds={live?.elapsedSeconds ?? 0}
                            />
                            <LiveTrendChart
                                title="HTTP 오류율 추이"
                                subtitle="FAILURE RATE"
                                unit="%"
                                color="#e11d48"
                                dataKey="failureRate"
                                history={liveHistory}
                                durationSeconds={durationSeconds}
                                elapsedSeconds={live?.elapsedSeconds ?? 0}
                            />
                        </div>
                        <small className="muted">목표 VU는 설정된 부하 패턴을 기준으로 계산되며, 활성 VU는 실제 측정값입니다. 측정값이 없으면 —로 표시됩니다.</small><br/>
                        <small className="muted">RPS는 최근 5초 기준이며, 평균 응답 시간·P95·오류율은 테스트 시작 이후 누적 통계입니다. 실시간 데이터 반영에는 약간의 지연이 발생할 수 있습니다.</small>
                    </section>
                )}

                {/* 에러 */}
                {error && (
                    <section className="error">
                        {error}
                    </section>
                )}

                {/* 테스트 결과 */}
                {result && (
                    <section className="panel">
                        <h2>테스트 결과</h2>
                        {result.historySaved === false && <p className="request-preview-error" role="alert">이번 실행을 테스트 이력에 저장하지 못했습니다.</p>}

                        <div className="metrics">
                            <Metric
                                label="총 요청 수"
                                value={metrics.totalRequests}
                                suffix="건"
                            />

                            <Metric
                                label="평균 RPS"
                                value={metrics.rps}
                                suffix="req/s"
                            />

                            <Metric
                                label="평균 응답 시간"
                                value={metrics.avgResponseTime}
                                suffix="ms"
                                responseTime
                            />

                            <Metric
                                label="P95 응답 시간"
                                value={metrics.p95ResponseTime}
                                suffix="ms"
                                responseTime
                            />

                            <Metric
                                label="HTTP 실패율"
                                value={metrics.failureRate}
                                suffix="%"
                            />
                        </div>

                        <p className="muted">
                            실행 상태:{" "}
                            {result.executionStatus === "cancelled" ? "중단" : result.success ? "정상 종료" : "실행 오류"}
                        </p>
                        {result.thresholdEvaluation && result.thresholdEvaluation.status !== "DISABLED" && (
                            <div className="threshold-result">
                                <h3>성능 목표 판정 <span className={`threshold-status threshold-${result.thresholdEvaluation.status.toLowerCase()}`}>{result.thresholdEvaluation.status === "UNAVAILABLE" ? "판정 불가" : result.thresholdEvaluation.status}</span></h3>
                                {result.thresholdEvaluation.status === "UNAVAILABLE" && <p className="muted">테스트 중단·실행 오류 또는 결과 데이터 부족으로 판정할 수 없습니다.</p>}
                                {result.thresholdEvaluation.checks.length > 0 && (
                                    <div className="threshold-checks">
                                        {result.thresholdEvaluation.checks.map(check => (
                                            <div className="threshold-check" key={check.key}>
                                                <span>{check.label}</span>
                                                <span>목표 {check.operator} {check.target}{check.key === "rps" ? " req/s" : check.key === "p95" ? " ms" : "%"}</span>
                                                <strong>실제 {check.actual}{check.key === "rps" ? " req/s" : check.key === "p95" ? " ms" : "%"}</strong>
                                                <span className={check.passed ? "threshold-pass" : "threshold-fail"}>{check.passed ? "PASS" : "FAIL"}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                        {/* POST 테스트 데이터 자동 삭제 결과 */}
                        {result.cleanupResult?.attempted && (
                            <div className="field">
                                <strong>테스트 데이터 자동 삭제</strong>

                                <p className="muted">
                                    {result.cleanupResult.success
                                        ? "자동 삭제 완료"
                                        : "자동 삭제가 완료되지 않았습니다."}
                                    {result.cleanupResult.total != null && (
                                        ` 대상 ${result.cleanupResult.total}건 / 성공 ${result.cleanupResult.deleted ?? 0}건 / 실패 ${result.cleanupResult.failed ?? 0}건`
                                    )}
                                    {((result.cleanupResult.missingIdCount ?? 0) + (result.cleanupResult.extractionErrorCount ?? 0) + (result.cleanupResult.malformedMarkerCount ?? 0) + (result.cleanupResult.duplicateIdCount ?? 0)) > 0 && (
                                        <p className="muted">ID 누락 {result.cleanupResult.missingIdCount ?? 0}건 / 추출 오류 {result.cleanupResult.extractionErrorCount ?? 0}건 / 로그 파싱 오류 {result.cleanupResult.malformedMarkerCount ?? 0}건 / 중복 ID {result.cleanupResult.duplicateIdCount ?? 0}건</p>
                                    )}
                                    {!!result.cleanupResult.failedIds?.length && (
                                        <details><summary>삭제 실패 ID ({result.cleanupResult.failedIds.length}건)</summary>
                                            <pre>{JSON.stringify(result.cleanupResult.failedIds, null, 2)}</pre>
                                        </details>
                                    )}
                                    {result.cleanupResult.recoveryFile && (
                                        <p className="muted">복구 파일: {result.cleanupResult.recoveryFile} (서버 reports 폴더)</p>
                                    )}
                                    {result.cleanupResult.message && (
                                        ` (${result.cleanupResult.message})`
                                    )}
                                </p>
                            </div>
                        )}
                    </section>
                )}
            </main>
        </div>
    );
}

function Metric({
                    label,
                    value,
                    suffix = "",
                    responseTime = false,
                }: MetricProps) {
    const status = responseTime
        ? getResponseStatus(value)
        : null;

    return (
        <div className={`metric ${status?.className ?? ""}`}>
            <span>{label}</span>

            <strong>
                {value ?? "-"}{" "}
                {value != null ? suffix : ""}
            </strong>

            {status && (
                <small className="metric-status">
                    {status.label}
                </small>
            )}
        </div>
    );
}

function getResponseStatus(value: number | null | undefined): { label: string; className: string } | null {
    if (value == null) {
        return null;
    }

    if (value <= 100) {
        return {
            label: "빠름",
            className: "fast",
        };
    }

    if (value <= 300) {
        return {
            label: "주의",
            className: "warning",
        };
    }

    return {
        label: "느림",
        className: "slow",
    };
}



type LiveHistoryPoint = {
    time: number;
    rps: number;
    avgResponseTime: number | null;
    p95ResponseTime: number | null;
    failureRate: number | null;
    activeVus: number | null;
    targetVus: number | null;
};

function LiveVuChart({history, durationSeconds, elapsedSeconds}: {history: LiveHistoryPoint[]; durationSeconds: number; elapsedSeconds: number}) {
    const maxSecond = Math.max(1, durationSeconds, Math.ceil(elapsedSeconds));
    const data = history.map(point => ({time: point.time, targetVus: point.targetVus, activeVus: point.activeVus}));
    return <div className="live-chart-panel">
        <div className="live-chart-topline"><div><span className="live-chart-overline">LOAD PROFILE</span><h3>목표 VU / 활성 VU <span>VU</span></h3></div><span className="live-chart-period">설정 목표와 관측값 비교</span></div>
        <div className="live-chart-container" role="img" aria-label="목표 VU 및 관측 활성 VU 그래프">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <AreaChart data={data} margin={{top:12,right:18,bottom:8,left:-8}}>
                    <CartesianGrid stroke="#e8eef6" strokeDasharray="4 5" vertical={false}/>
                    <XAxis dataKey="time" type="number" domain={[0,maxSecond]} tickFormatter={(v:number)=>`${Math.round(v)}초`} tick={{fontSize:11,fill:'#94a3b8'}} axisLine={false} tickLine={false}/>
                    <YAxis domain={[0,'auto']} allowDecimals={false} width={48} tick={{fontSize:11,fill:'#94a3b8'}} axisLine={false} tickLine={false}/>
                    <Tooltip labelFormatter={(v)=>`경과 ${Number(v).toFixed(1)}초`} formatter={(v,name)=>[`${Number(v).toFixed(1)} VU`,name]}/>
                    <Area type="linear" dataKey="targetVus" name="목표 VU" stroke="#2563eb" strokeWidth={2} fill="#2563eb" fillOpacity={0.06} dot={false} isAnimationActive={false}/>
                    <Area type="stepAfter" dataKey="activeVus" name="관측 활성 VU" stroke="#f97316" strokeWidth={2} fill="none" dot={false} connectNulls={false} isAnimationActive={false}/>
                </AreaChart>
            </ResponsiveContainer>
        </div>
        <div className="live-chart-footer">파란색: 설정 목표 · 주황색: k6 관측값 (없으면 미표시)</div>
    </div>;
}

function LiveTrendChart({ title, subtitle, unit, color, dataKey, history, durationSeconds, elapsedSeconds }: {
    title: string;
    subtitle: string;
    unit: string;
    color: string;
    dataKey: "avgResponseTime" | "p95ResponseTime" | "failureRate";
    history: LiveHistoryPoint[];
    durationSeconds: number;
    elapsedSeconds: number;
}) {
    const maxSecond = Math.max(1, durationSeconds, Math.ceil(elapsedSeconds));
    const data = history.map(point => ({
        time: point.time,
        value: point[dataKey],
    }));
    return (
        <div className="live-chart-panel" style={{ marginTop: 16 }}>
            <div className="live-chart-topline">
                <div>
                    <span className="live-chart-overline">{subtitle}</span>
                    <h3>{title} <span>{unit}</span></h3>
                </div>
                <span className="live-chart-period">테스트 시간 {maxSecond}초 · 1초 간격</span>
            </div>
            <div className="live-chart-container" role="img" aria-label={title}>
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <AreaChart data={data} margin={{ top: 12, right: 18, bottom: 8, left: -8 }}>
                        <CartesianGrid stroke="#e8eef6" strokeDasharray="4 5" vertical={false} />
                        <XAxis dataKey="time" type="number" domain={[0, maxSecond]}
                               ticks={Array.from({ length: 6 }, (_, i) => Math.round(maxSecond * i / 5))}
                               tickFormatter={(value: number) => `${value}초`}
                               tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false}
                               allowDecimals={false} />
                        <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false}
                               width={48} domain={[0, dataKey === "failureRate" ? 100 : "auto"]}
                               tickFormatter={(value: number) => `${value}`} />
                        <Tooltip labelFormatter={(value) => `경과 ${value}초`}
                                 formatter={(value) => [`${Number(value).toFixed(2)} ${unit}`, title]}
                                 contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }} />
                        <Area type="monotone" dataKey="value" name={title} stroke={color}
                              strokeWidth={3} fill={color} fillOpacity={0.10} connectNulls={false}
                              dot={false} activeDot={{ r: 5 }} isAnimationActive={false} />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}

