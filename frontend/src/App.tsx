import { useState } from "react";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type MethodFilter = HttpMethod | "ALL";
type SchemaType = "string" | "integer" | "number" | "boolean" | "array" | "object";
type InputValue = string | number | boolean;
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface ApiSchema {
  type?: SchemaType;
  default?: InputValue | null;
}

interface ApiParameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: ApiSchema;
}

interface RequestBodyField {
  name: string;
  type: SchemaType;
  required?: boolean;
  description?: string;
  default?: JsonValue;
  enum?: InputValue[];
}

interface ApiOperation {
  method: HttpMethod;
  path: string;
  summary?: string;
  tags?: string[];
  parameters?: ApiParameter[];
  requestBody?: unknown;
  requestBodyFields?: RequestBodyField[];
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
  message?: string;
}

interface TestResult {
  success: boolean;
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


import "./App.css";

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

function parseBodyFieldValue(field: RequestBodyField, value: JsonValue): JsonValue {
  if (field.type === "integer" || field.type === "number") {
    const number = Number(value);

    if (
        !Number.isFinite(number) ||
        (field.type === "integer" && !Number.isInteger(number))
    ) {
      throw new Error(
          `${field.name}에는 올바른 숫자를 입력해주세요.`
      );
    }

    return number;
  }

  if (field.type === "boolean") {
    return value === true || value === "true";
  }

  if (field.type === "array" || field.type === "object") {
    let parsed;

    try {
      parsed =
          typeof value === "string"
              ? JSON.parse(value)
              : value;
    } catch {
      throw new Error(
          `${field.name}에는 올바른 ${
  field.type === "array"
      ? "JSON 배열"
      : "JSON 객체"
}를 입력해주세요.`
      );
    }

    const valid =
        field.type === "array"
            ? Array.isArray(parsed)
            : parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed);

    if (!valid) {
      throw new Error(
          `${field.name}에는 올바른 ${
  field.type === "array"
      ? "JSON 배열"
      : "JSON 객체"
}를 입력해주세요.`
      );
    }

    return parsed;
  }

  return String(value);
}

function buildRequestBody(fields: RequestBodyField[], bodyValues: Record<string, string>): Record<string, JsonValue> {
  const body: Record<string, JsonValue> = {};

  for (const field of fields) {
    const raw = bodyValues[field.name];

    const value: JsonValue | undefined =
        raw === undefined || raw === ""
            ? field.default
            : raw;

    const missing =
        value === undefined ||
        value === null ||
        value === "";

    if (missing) {
      if (field.required) {
        throw new Error(
            `필수 Request Body 값을 입력해주세요: ${field.name}`
        );
      }

      continue;
    }

    if (value === undefined || value === null) continue;

    if (
        field.enum &&
        !field.enum.some(
            (option) => String(option) === String(value)
        )
    ) {
      throw new Error(
          `${field.name}의 선택값이 올바르지 않습니다.`
      );
    }

    body[field.name] = parseBodyFieldValue(
        field,
        value
    );
  }

  return body;
}

function parsePathIds(value: string): string[] {
  return value
      .split(/[\n,]+/)
      .map((id) => id.trim())
      .filter(Boolean);
}

export default function App() {
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
  const [sleepSeconds, setSleepSeconds] = useState(0);
  const [accessToken, setAccessToken] = useState("");
  const [cleanupPath, setCleanupPath] = useState("");
  const [cleanupIdField, setCleanupIdField] = useState("id");
  const [cleanupPathMode, setCleanupPathMode] = useState<"openapi" | "manual">("openapi");
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
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
              field.type === "string" &&
              !field.enum?.length &&
              uniqueFields[field.name]
      )
      .map((field) => field.name);

  const hasUniqueFields =
      enabledUniqueFields.length > 0;

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
            field.type === "string" &&
            !field.enum?.length &&
            body[field.name] !== undefined
        ) {
          body[field.name] =
              `${body[field.name]}_runId_VU_ITER`;
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
    if (!selected || running) {
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

    setRunning(true);
    setError("");
    setResult(null);

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

              accessToken,
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
                disabled={loading || running}
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
                {filteredOperations.map(
                    (operation, index) => (
                        <button
                            key={
                              `${operation.method}-${operation.path}-${index}`
                            }
                            className={
                                "api-item " +
                                (
                                    selected === operation
                                        ? "active"
                                        : ""
                                )
                            }
                            onClick={() =>
                                selectOperation(operation)
                            }
                            disabled={running}
                        >
                                        <span
                                            className={
                                              `method ${operation.method.toLowerCase()}`
                                            }
                                        >
                                            {operation.method}
                                        </span>

                          <span className="api-info">
                                            <strong>
                                                {operation.path}
                                            </strong>

                                            <small>
                                                {operation.summary ||
                                                    "설명 없음"}
                                            </small>
                                        </span>
                        </button>
                    )
                )}

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

                          {requestBodyFields.length === 0 ? (
                              <p className="muted">
                                입력 필드를 찾을 수 없습니다.
                                OpenAPI 스키마를 확인해주세요.
                              </p>
                          ) : (
                              requestBodyFields.map(
                                  (field) => (
                                      <div
                                          className="field"
                                          key={field.name}
                                      >
                                        <label>
                                          {field.name} (Body)

                                          {field.description && (
                                              <small className="parameter-description">
                                                {" "}
                                                ({field.description})
                                              </small>
                                          )}

                                          {field.required && (
                                              <span className="required-mark">
                                                                    {" "}*
                                                                </span>
                                          )}

                                          <small className="parameter-type">
                                            {" "}
                                            {field.type}
                                          </small>
                                        </label>

                                        {field.enum ? (
                                            <select
                                                value={
                                                    bodyValues[field.name] ?? ""
                                                }
                                                onChange={(e) =>
                                                    updateBodyValue(
                                                        field.name,
                                                        e.target.value
                                                    )
                                                }
                                                disabled={running}
                                            >
                                              <option value="">
                                                선택하세요
                                              </option>

                                              {field.enum.map(
                                                  (option) => (
                                                      <option
                                                          key={String(option)}
                                                          value={String(option)}
                                                      >
                                                        {String(option)}
                                                      </option>
                                                  )
                                              )}
                                            </select>
                                        ) : field.type === "boolean" ? (
                                            <select
                                                value={
                                                    bodyValues[field.name] ?? ""
                                                }
                                                onChange={(e) =>
                                                    updateBodyValue(
                                                        field.name,
                                                        e.target.value
                                                    )
                                                }
                                                disabled={running}
                                            >
                                              <option value="">
                                                선택하세요
                                              </option>

                                              <option value="true">
                                                true
                                              </option>

                                              <option value="false">
                                                false
                                              </option>
                                            </select>
                                        ) : field.type === "object" ||
                                        field.type === "array" ? (
                                            <textarea
                                                rows={4}
                                                value={
                                                    bodyValues[field.name] ?? ""
                                                }
                                                placeholder={
                                                  field.type === "array"
                                                      ? "[]"
                                                      : "{}"
                                                }
                                                onChange={(e) =>
                                                    updateBodyValue(
                                                        field.name,
                                                        e.target.value
                                                    )
                                                }
                                                disabled={running}
                                            />
                                        ) : (
                                            <input
                                                type={
                                                  [
                                                    "integer",
                                                    "number",
                                                  ].includes(field.type)
                                                      ? "number"
                                                      : "text"
                                                }
                                                step={
                                                  field.type === "integer"
                                                      ? "1"
                                                      : "any"
                                                }
                                                value={
                                                    bodyValues[field.name] ?? ""
                                                }
                                                placeholder={
                                                  field.default != null
                                                      ? String(field.default)
                                                      : field.required
                                                          ? "필수값을 입력하세요"
                                                          : "선택값"
                                                }
                                                onChange={(e) =>
                                                    updateBodyValue(
                                                        field.name,
                                                        e.target.value
                                                    )
                                                }
                                                disabled={running}
                                            />
                                        )}

                                        {field.type === "string" &&
                                            !field.enum?.length && (
                                                <label className="unique-field-option">
                                                  <input
                                                      type="checkbox"
                                                      checked={
                                                        Boolean(
                                                            uniqueFields[field.name]
                                                        )
                                                      }
                                                      onChange={(e) =>
                                                          updateUniqueField(
                                                              field.name,
                                                              e.target.checked
                                                          )
                                                      }
                                                      disabled={running}
                                                  />

                                                  요청마다 고유값 자동 생성
                                                </label>
                                            )}
                                      </div>
                                  )
                              )
                          )}

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

                    {/*
                                <div className="field">
                                    <label>관리자 Access Token</label>

                                    <input
                                        type="password"
                                        value={accessToken}
                                        onChange={(e) =>
                                            setAccessToken(e.target.value)
                                        }
                                        placeholder="Bearer 접두사 제외"
                                    />
                                </div>
                                */}
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
                              : "실행 시간"}
                        </label>

                        {isDelete ? (
                            <input
                                value="ID별 1회 요청"
                                readOnly
                                className="readonly-input"
                            />
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

                    <button
                        className="run-button"
                        disabled={running}
                        onClick={runTest}
                    >
                      {running
                          ? "k6 테스트 실행 중..."
                          : "k6 테스트 실행"}
                    </button>
                  </>
              )}
            </section>
          </div>

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
                  {result.success ? "성공" : "실패"}
                </p>
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
