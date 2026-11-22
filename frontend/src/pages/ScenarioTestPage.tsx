
import { useMemo, useRef, useState } from "react";
import type { ApiOperation, JsonValue } from "../types/api";
import { buildRequestBody } from "../lib/api/request-body";
import type {
  ScenarioConfig,
  ScenarioStep,
} from "../lib/api/scenario";
import { validateScenario } from "../lib/api/scenario";
import RequestBodyEditor from "../components/api/RequestBodyEditor";
import RequestHeadersEditor, { buildRequestSettings, useRequestSettings } from "../components/api/RequestHeadersEditor";

import "./SingleApiTestPage.css";
import "./ScenarioTestPage.css";

const RUNNER_URL = "http://127.0.0.1:4000";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type MethodFilter = HttpMethod | "ALL";

type ScenarioResult = {
  historySaved?: boolean;
  executionStatus: "completed" | "cancelled" | "error";
  metricsAvailable: boolean;
  metrics: {
    totalRequests: number;
    rps: number;
    avgResponseTime: number;
    p95ResponseTime: number;
    failureRate: number;
  };
  scenarioSteps?: Array<{
    succeeded: number;
    http_failed: number;
    extraction_failed: number;
    request_failed: number;
    skipped: number;
  }>;
};

function evaluateScenarioOutcome(result: ScenarioResult, stepCount: number) {
  const { executionStatus, scenarioSteps } = result;
  if (executionStatus !== "completed") {
    return { status: "unavailable", label: "판정 불가", detail: "실행이 정상적으로 끝나지 않았습니다." };
  }
  if (!scenarioSteps || scenarioSteps.length !== stepCount || stepCount === 0) {
    return { status: "unavailable", label: "판정 불가", detail: "단계별 집계가 부족합니다." };
  }

  const failedSteps = scenarioSteps.flatMap((step, index) =>
      step.succeeded === 0 || step.http_failed > 0 || step.request_failed > 0 ||
      step.extraction_failed > 0 || step.skipped > 0
          ? [index + 1]
          : []
  );
  if (failedSteps.length > 0) {
    return {
      status: "fail",
      label: "실패",
      detail: `${failedSteps.join(", ")}단계에서 성공한 요청이 없거나 실패·건너뜀이 발생했습니다. 아래 단계별 집계를 확인하세요.`,
    };
  }
  return { status: "pass", label: "통과", detail: "모든 단계가 오류나 건너뜀 없이 성공했습니다." };
}

const HTTP_METHODS: MethodFilter[] = [
  "ALL",
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
];

const uid = () =>
    `step_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const getErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

function inspectResponseSample(text: string) {
  const values = new Map<string, JsonValue>();
  if (!text.trim()) return { values, error: "" };

  let response: JsonValue;
  try {
    response = JSON.parse(text) as JsonValue;
  } catch {
    return { values, error: "올바른 JSON을 붙여넣어 주세요." };
  }

  const nodes = [{ path: "", value: response }];
  while (nodes.length) {
    const { path, value } = nodes.pop()!;
    if (path && value !== null && value !== "") values.set(path, value);
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [key, child] of Object.entries(value).reverse()) {
      if (/^[a-zA-Z_$][\w$]*$/.test(key)) {
        nodes.push({ path: path ? path + "." + key : key, value: child });
      }
    }
  }

  return { values, error: values.size ? "" : "현재 경로 문법으로 추출할 수 있는 값이 없습니다." };
}

function formatSampleValue(value: JsonValue) {
  if (Array.isArray(value)) return `배열 (${value.length}개)`;
  if (value !== null && typeof value === "object") return `객체 (속성 ${Object.keys(value).length}개)`;
  const json = JSON.stringify(value);
  return json.length > 160 ? json.slice(0, 160) + "…" : json;
}

export default function ScenarioTestPage() {
  const [openApiUrl, setOpenApiUrl] = useState(
      "http://localhost:8080/v3/api-docs"
  );

  const [baseUrl, setBaseUrl] = useState(
      "http://localhost:8080"
  );

  const { settings: requestSettings } = useRequestSettings(baseUrl);
  const [operations, setOperations] = useState<ApiOperation[]>([]);
  const [steps, setSteps] = useState<ScenarioStep[]>([]);
  const [responseSamples, setResponseSamples] = useState<Record<string, string>>({});

  const [selectedStepId, setSelectedStepId] = useState<string | null>(
      null
  );

  const [searchKeyword, setSearchKeyword] = useState("");
  const [selectedMethod, setSelectedMethod] =
      useState<MethodFilter>("ALL");

  const [name, setName] = useState("사용자 API 시나리오");
  const [vus, setVus] = useState(5);
  const [duration, setDuration] = useState("10s");
  const [sleepSeconds, setSleepSeconds] = useState(0);

  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState("");
  const [running, setRunning] = useState(false);
  const activeRequestId = useRef<string | null>(null);
  const [stopRequested, setStopRequested] = useState(false);
  const [runError, setRunError] = useState("");
  const [run, setRun] = useState<{ config: ScenarioConfig; result: ScenarioResult } | null>(null);

  const outcome = run ? evaluateScenarioOutcome(run.result, run.config.steps.length) : null;

  const selectedStep =
      steps.find((step) => step.id === selectedStepId) ?? null;

  const selectedStepIndex = selectedStep
      ? steps.findIndex((step) => step.id === selectedStep.id)
      : -1;

  const responseSample = selectedStep ? responseSamples[selectedStep.id] ?? "" : "";
  const sampleInspection = useMemo(() => inspectResponseSample(responseSample), [responseSample]);
  const samplePaths = [...sampleInspection.values.keys()];

  const selectedParameters = selectedStep?.operation.parameters ?? [];
  const pathParameterNames = new Set(
      selectedParameters.filter((parameter) => parameter.in === "path")
          .map((parameter) => parameter.name)
  );
  const inferredPathParameters = Array.from(
      selectedStep?.operation.path.matchAll(/\{([^}]+)\}/g) ?? [],
      ([, name]) => name
  ).filter((name) => !pathParameterNames.has(name))
      .map((name) => ({ name, in: "path" as const, required: true }));

  const previousVariables = new Map<string, string>();
  steps.slice(0, Math.max(0, selectedStepIndex)).forEach((step, index) => {
    for (const { name } of step.extract) {
      if (/^[a-zA-Z_$][\w$]*$/.test(name)) {
        previousVariables.set(
            name,
            `${index + 1}단계 ${step.operation.method} ${step.operation.path} → ${name}`
        );
      }
    }
  });

  const filteredOperations = operations.filter((operation) => {
    const matchesMethod =
        selectedMethod === "ALL" ||
        operation.method.toUpperCase() === selectedMethod;

    const keyword = searchKeyword.trim().toLowerCase();

    const matchesKeyword =
        !keyword ||
        [
          operation.method,
          operation.path,
          operation.summary,
          ...(operation.tags ?? []),
        ].some((value) =>
            String(value ?? "").toLowerCase().includes(keyword)
        );

    return matchesMethod && matchesKeyword;
  });

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

  async function loadOpenApi() {
    setLoading(true);
    setConnectionError("");

    try {
      const url = new URL(`${RUNNER_URL}/api/openapi`);
      url.searchParams.set("url", openApiUrl);

      const response = await fetch(url);

      const data = (await response.json()) as {
        operations?: ApiOperation[];
        message?: string;
      };

      if (!response.ok) {
        throw new Error(data.message || "OpenAPI 조회 실패");
      }

      setOperations(data.operations ?? []);
      setSteps([]);
      setResponseSamples({});
      setSelectedStepId(null);
      setPreview("");
      setSearchKeyword("");
      setSelectedMethod("ALL");

      setBaseUrl(new URL(openApiUrl).origin);
      setError("");
    } catch (error) {
      setConnectionError(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  function updateStep(
      id: string,
      updater: (step: ScenarioStep) => ScenarioStep
  ) {
    setSteps((previous) =>
        previous.map((step) =>
            step.id === id ? updater(step) : step
        )
    );

    setPreview("");
  }

  function addStep(operation: ApiOperation) {
    const id = uid();

    const step: ScenarioStep = {
      id,
      operation,
      parameters: {},
      bodyValues: {},
      uniqueFields: {},
      extract: [],
    };

    setSteps((previous) => [...previous, step]);
    setSelectedStepId(id);
    setPreview("");
    setError("");
  }

  function moveStep(index: number, delta: number) {
    setSteps((previous) => {
      const next = [...previous];
      const target = index + delta;

      if (target < 0 || target >= next.length) {
        return previous;
      }

      [next[index], next[target]] = [
        next[target],
        next[index],
      ];

      return next;
    });

    setPreview("");
  }

  function removeStep(id: string) {
    const index = steps.findIndex((step) => step.id === id);
    const next = steps.filter((step) => step.id !== id);

    setSteps(next);
    setResponseSamples((previous) => {
      const samples = { ...previous };
      delete samples[id];
      return samples;
    });

    if (selectedStepId === id) {
      const replacement =
          next[Math.min(index, next.length - 1)] ?? null;

      setSelectedStepId(replacement?.id ?? null);
    }

    setPreview("");
  }

  function addExtractVariable(id: string) {
    const variableId = uid();

    updateStep(id, (step) => {
      const names = new Set(step.extract.map((variable) => variable.name));
      let index = 1;
      while (names.has(`var${index}`)) index++;

      return {
        ...step,
        extract: [
          ...step.extract,
          { id: variableId, name: `var${index}`, path: "" },
        ],
      };
    });
  }

  function updateExtractVariable(
      stepId: string,
      variableId: string,
      change: { name: string } | { path: string }
  ) {
    updateStep(stepId, (step) => ({
      ...step,
      extract: step.extract.map((variable) =>
          variable.id === variableId ? { ...variable, ...change } : variable
      ),
    }));
  }

  function buildConfig(): ScenarioConfig {
    return {
      name,
      baseUrl,
      vus,
      duration,
      sleepSeconds,

      steps: steps.map((step) => {
        const extractEntries = step.extract.map(({ name, path }) => [name, path] as const);
        if (new Set(extractEntries.map(([name]) => name)).size !== extractEntries.length) {
          throw new Error(`${step.operation.method} ${step.operation.path}: 응답 변수명이 중복됩니다.`);
        }

        const path = step.operation.path.replace(
            /\{([^}]+)\}/g,
            (_, key: string) => {
              const value = step.parameters[`path:${key}`];

              if (!value) {
                throw new Error(
                    `${step.operation.method} ${step.operation.path}: ` +
                    `Path 변수 ${key}가 비어 있습니다.`
                );
              }

              return value;
            }
        );

        const query: Record<string, string> = {};
        const headers: Record<string, string> = {};

        for (const parameter of step.operation.parameters ?? []) {
          if (
              parameter.in !== "query" &&
              parameter.in !== "header"
          ) {
            continue;
          }

          const value =
              step.parameters[
                  `${parameter.in}:${parameter.name}`
                  ] ||
              (parameter.schema?.default != null
                  ? String(parameter.schema.default)
                  : "");

          if (!value && parameter.required) {
            throw new Error(
                `${parameter.name} 필수값을 입력하세요.`
            );
          }

          if (value) {
            if (parameter.in === "query") {
              query[parameter.name] = value;
            } else {
              headers[parameter.name] = value;
            }
          }
        }

        let body: Record<string, JsonValue> | null = null;

        if (step.operation.requestBody) {
          const fields =
              step.operation.requestBodyFields ?? [];

          if (!fields.length) {
            throw new Error(
                `${step.operation.path}: OpenAPI Body 필드가 없습니다.`
            );
          }

          const variableFields = fields.filter((field) =>
              /^\$\{[\w$.]+\}$/.test(
                  step.bodyValues[field.name] ?? ""
              )
          );

          const ordinaryFields = fields.filter(
              (field) => !variableFields.includes(field)
          );

          body = buildRequestBody(
              ordinaryFields,
              step.bodyValues
          );

          for (const field of variableFields) {
            body[field.name] = step.bodyValues[field.name];
          }
        }

        return {
          id: step.id,
          method: step.operation.method,
          path,
          query,
          headers,
          body,
          uniqueFields: (
              step.operation.requestBodyFields ?? []
          )
              .filter((field) => step.uniqueFields[field.name])
              .map((field) => field.name),
          extract: Object.fromEntries(extractEntries),
        };
      }),
    };
  }

  async function runScenario() {
    setRunError("");
    setRun(null);

    try {
      const config = buildConfig();
      validateScenario(config);
      const id = crypto.randomUUID();
      activeRequestId.current = id;
      setStopRequested(false);
      setRunning(true);
      const response = await fetch(`${RUNNER_URL}/api/scenarios/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...config, ...buildRequestSettings(requestSettings), requestId: id }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { message?: string } | null;
        const fallback = response.status === 404
            ? "시나리오 실행 API에 연결할 수 없습니다. Express 백엔드를 재시작해주세요."
            : `시나리오 실행 요청 실패 (HTTP ${response.status})`;
        throw new Error(data?.message ?? fallback);
      }
      const result = await response.json() as ScenarioResult;
      setRun({ config, result });
    } catch (error) {
      setRunError(getErrorMessage(error));
    } finally {
      setRunning(false);
      activeRequestId.current = null;
      setStopRequested(false);
    }
  }

  async function stopScenario() {
    const requestId = activeRequestId.current;
    if (!requestId || stopRequested) return;
    setRunError("");
    setStopRequested(true);

    try {
      const url = `${RUNNER_URL}/api/scenarios/run/${requestId}/cancel`;
      let response = await fetch(url, { method: "POST" });
      if (response.status === 404) {
        // The stop click can arrive before Express receives the run request.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
        response = await fetch(url, { method: "POST" });
      }
      if (response.ok || response.status === 409) return;
      const data = await response.json().catch(() => null) as { message?: string } | null;
      throw new Error(data?.message ?? `시나리오 중지 요청 실패 (HTTP ${response.status})`);
    } catch (error) {
      if (activeRequestId.current !== requestId) return;
      setRunError(getErrorMessage(error));
      setStopRequested(false);
    }
  }

  function showPreview() {
    try {
      const config = buildConfig();

      validateScenario(config);

      const settings = buildRequestSettings(requestSettings);
      const maskHeaders = (headers: Record<string, string>) =>
          Object.fromEntries(Object.keys(headers).map(name => [name, "<실행 화면에서 입력>"]));
      setPreview(JSON.stringify({
        ...config,
        commonHeaders: maskHeaders(settings.commonHeaders),
        generateRequestId: settings.generateRequestId,
        steps: config.steps.map(step => ({
          ...step,
          headers: maskHeaders(step.headers),
        })),
      }, null, 2));
      setError("");
    } catch (error) {
      setError(getErrorMessage(error));
      setPreview("");
    }
  }

  return (
      <div className="app scenario-page">
        <header className="header">
          <div className="container">
            <h1>시나리오 테스트</h1>
            <p>여러 API를 순서대로 연결하고 이전 응답값을 다음 요청에서 재사용합니다.</p>
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
                  onChange={(event) =>
                      setOpenApiUrl(event.target.value)
                  }
                  placeholder="http://localhost:8080/v3/api-docs"
              />
            </div>

            <button
                type="button"
                onClick={loadOpenApi}
                disabled={loading}
            >
              {loading
                  ? "불러오는 중..."
                  : "API 목록 불러오기"}
            </button>
            {connectionError && (
                <p className="request-preview-error" role="alert">
                  {connectionError}
                </p>
            )}
          </section>

          {/* 단일 API 테스트와 동일한 좌우 레이아웃 */}
          <div className="workspace">

            {/* 왼쪽: API 목록 */}
            <section className="panel">
              <h2>API 목록 ({filteredOperations.length}/{operations.length})</h2>

              <div className="field">
                <div className="method-filters">
                  {HTTP_METHODS.map((method) => (
                      <button
                          key={method}
                          type="button"
                          className={
                              `method-filter ${method.toLowerCase()} ` +
                              (selectedMethod === method
                                  ? "active"
                                  : "")
                          }
                          onClick={() =>
                              setSelectedMethod(method)
                          }
                      >
                        {method === "ALL" ? "전체" : method}
                      </button>
                  ))}
                </div>

                <input
                    type="search"
                    aria-label="API 검색"
                    value={searchKeyword}
                    onChange={(event) =>
                        setSearchKeyword(event.target.value)
                    }
                    placeholder="Method, API 경로, 설명 검색..."
                />
              </div>

              <div className="api-list">
                {Object.entries(groupedOperations).map(
                    ([tag, groupOperations]) => (
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
                                    key={
                                      `${operation.method}-${operation.path}`
                                    }
                                    type="button"
                                    className="api-item"
                                    onClick={() => addStep(operation)}
                                >
                          <span
                              className={
                                `method ${operation.method.toLowerCase()}`
                              }
                          >
                            {operation.method}
                          </span>

                                  <span className="api-info">
                            <strong>{operation.path}</strong>

                            <small>
                              {operation.summary || "설명 없음"}
                            </small>
                          </span>

                                  <span className="scenario-add-icon" aria-hidden="true">
                            +
                          </span>
                                </button>
                            ))}
                          </div>
                        </details>
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

            {/* 오른쪽: 시나리오 설정 */}
            <section className="panel">
              <h2>테스트 설정</h2>

              <div className="path-distribution">
                <h3>부하 설정</h3>
                <div className="field">
                  <label>시나리오 이름</label>

                  <input
                      value={name}
                      onChange={(event) =>
                          setName(event.target.value)
                      }
                  />
                </div>

                <div className="field">
                  <label>Base URL</label>

                  <input
                      value={baseUrl}
                      onChange={(event) =>
                          setBaseUrl(event.target.value)
                      }
                  />
                </div>

                <div className="settings-grid">
                  <div className="field">
                    <label>VU</label>

                    <input
                        type="number"
                        min={1}
                        value={vus}
                        onChange={(event) =>
                            setVus(Number(event.target.value))
                        }
                    />
                  </div>

                  <div className="field">
                    <label>실행 시간</label>

                    <select
                        value={duration}
                        onChange={(event) =>
                            setDuration(event.target.value)
                        }
                    >
                      <option value="10s">10초</option>
                      <option value="30s">30초</option>
                      <option value="1m">1분</option>
                      <option value="3m">3분</option>
                    </select>
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="scenario-sleep-seconds">반복 사이 대기 시간 (초)</label>
                  <select
                      id="scenario-sleep-seconds"
                      value={sleepSeconds}
                      disabled={running}
                      onChange={(event) => {
                        setSleepSeconds(Number(event.target.value));
                        setPreview("");
                      }}
                  >
                    <option value={0}>0초 — 대기 없이 최대 처리량 측정</option>
                    <option value={0.5}>0.5초</option>
                    <option value={1}>1초</option>
                    <option value={2}>2초</option>
                    <option value={3}>3초</option>
                    <option value={5}>5초</option>
                    <option value={10}>10초</option>
                  </select>
                  <small className="muted">전체 단계를 한 번 실행한 뒤 기다리는 시간입니다. 0이면 바로 다음 반복을 시작합니다.</small>
                </div>
              </div>

              <RequestHeadersEditor baseUrl={baseUrl} disabled={running} />

              {steps.length === 0 ? (
                    <p className="muted">
                      왼쪽 API 목록에서 API를 클릭하면
                      시나리오에 추가됩니다.
                    </p>
                ) : (
                    <div className="scenario-step-list">
                      {steps.map((step, index) => (
                          <button
                              key={step.id}
                              type="button"
                              className={
                                  "api-item " +
                                  (selectedStepId === step.id
                                      ? "active"
                                      : "")
                              }
                              aria-pressed={selectedStepId === step.id}
                              onClick={() =>
                                  setSelectedStepId(step.id)
                              }
                          >
                      <span className="scenario-step-number">
                        {index + 1}
                      </span>

                            <span
                                className={
                                  `method ${step.operation.method.toLowerCase()}`
                                }
                            >
                        {step.operation.method}
                      </span>

                            <span className="scenario-step-path">
                        {step.operation.path}
                      </span>
                          </button>
                      ))}
                    </div>
                )}

              {selectedStep && (
                  <div className="path-distribution">
                    <div className="scenario-step-header">
                      <h3>단계 {selectedStepIndex + 1} 설정</h3>
                      <div className="scenario-step-actions">
                        <button
                            type="button"
                            onClick={() =>
                                moveStep(selectedStepIndex, -1)
                            }
                            disabled={selectedStepIndex === 0}
                        >
                          ↑ 위로
                        </button>

                        <button
                            type="button"
                            onClick={() =>
                                moveStep(selectedStepIndex, 1)
                            }
                            disabled={
                                selectedStepIndex === steps.length - 1
                            }
                        >
                          ↓ 아래로
                        </button>

                        <button
                            type="button"
                            className="scenario-delete-button"
                            onClick={() =>
                                removeStep(selectedStep.id)
                            }
                        >
                          삭제
                        </button>
                      </div>
                    </div>

                    <div className="selected-api">
                      <span className={`method ${selectedStep.operation.method.toLowerCase()}`}>
                        {selectedStep.operation.method}
                      </span>
                      <strong>{selectedStep.operation.path}</strong>
                    </div>

                    {/* Path / Query / Header */}
                    {[...selectedParameters, ...inferredPathParameters]
                        .filter((parameter) =>
                            ["path", "query", "header"].includes(
                                parameter.in
                            )
                        )
                        .map((parameter) => {
                          const key = `${parameter.in}:${parameter.name}`;
                          const inputId = `${selectedStep.id}-${key}`;
                          const value = selectedStep.parameters[key] ?? "";
                          const isPath = parameter.in === "path";
                          const variable = value.match(/^\$\{([\w$]+)\}$/)?.[1];
                          const missingReferences = isPath
                              ? [...new Set(
                                  Array.from(value.matchAll(/\$\{([\w$.]+)\}/g), (match) => match[1])
                                      .filter((reference) => !previousVariables.has(reference.split(".")[0]))
                              )]
                              : [];
                          const hasMissingReferences = missingReferences.length > 0;
                          const updateParameter = (nextValue: string) =>
                              updateStep(selectedStep.id, (step) => ({
                                ...step,
                                parameters: { ...step.parameters, [key]: nextValue },
                              }));

                          return (
                              <div className="field" key={key}>
                                <label htmlFor={inputId}>
                                  {parameter.name} ({parameter.in})
                                  {parameter.required && <span className="required-mark"> *</span>}
                                </label>

                                <input
                                    id={inputId}
                                    value={value}
                                    placeholder={isPath ? "예: 101 또는 ${recordId}" : "고정값 또는 ${변수명}"}
                                    aria-invalid={hasMissingReferences || undefined}
                                    aria-describedby={hasMissingReferences ? `${inputId}-error` : undefined}
                                    onChange={(event) => updateParameter(event.target.value)}
                                />

                                {isPath && (
                                  <>
                                    <label htmlFor={`${inputId}-variable`}>이전 단계 변수 선택</label>
                                    <select
                                        id={`${inputId}-variable`}
                                        disabled={previousVariables.size === 0 && !variable}
                                        value={variable ?? ""}
                                        onChange={(event) => {
                                          const name = event.target.value;
                                          updateParameter(name ? "${" + name + "}" : "");
                                        }}
                                    >
                                      <option value="">
                                        {variable ? "직접 입력으로 전환" : previousVariables.size ? "변수를 선택하세요" : "사용할 수 있는 변수가 없습니다"}
                                      </option>
                                      {variable && !previousVariables.has(variable) && (
                                          <option value={variable} disabled>{variable} (연결 끊김)</option>
                                      )}
                                      {[...previousVariables].map(([name, source]) => (
                                          <option key={name} value={name}>{source}</option>
                                      ))}
                                    </select>
                                  </>
                                )}

                                {isPath && previousVariables.size === 0 && (
                                    <small className="muted">
                                      앞 단계의 ‘응답 변수 추출’에서 변수를 추가하면 여기에 표시됩니다.
                                    </small>
                                )}

                                {hasMissingReferences && (
                                    <small id={`${inputId}-error`} className="request-preview-error" role="alert">
                                      이전 단계에서 찾을 수 없는 변수 · {missingReferences.join(", ")}
                                    </small>
                                )}
                              </div>
                          );
                        })}

                    {/* Request Body */}
                    {Boolean(selectedStep.operation.requestBody) && (
                        <div className="request-body-fields">
                          <h3>Request Body</h3>

                          <p className="muted">
                            이전 응답에서 추출한 변수를 사용할 수 있습니다.
                            예: {"${shop.phone}"}
                          </p>

                          <RequestBodyEditor
                              fields={
                                  selectedStep.operation.requestBodyFields ?? []
                              }
                              values={selectedStep.bodyValues}
                              allowVariables
                              onChange={(key, value) =>
                                  updateStep(
                                      selectedStep.id,
                                      (step) => ({
                                        ...step,
                                        bodyValues: {
                                          ...step.bodyValues,
                                          [key]: value,
                                        },
                                      })
                                  )
                              }
                              uniqueFields={selectedStep.uniqueFields}
                              onUniqueChange={(key, value) =>
                                  updateStep(
                                      selectedStep.id,
                                      (step) => ({
                                        ...step,
                                        uniqueFields: {
                                          ...step.uniqueFields,
                                          [key]: value,
                                        },
                                      })
                                  )
                              }
                          />
                        </div>
                    )}

                    {/* 응답 변수 추출 */}
                    <div className="path-distribution">
                      <h3>응답 변수 추출</h3>

                      <div className="field">
                        <label htmlFor="scenario-response-sample">응답 JSON 샘플 (선택)</label>
                        <textarea
                            id="scenario-response-sample"
                            rows={4}
                            maxLength={50000}
                            value={responseSample}
                            placeholder='예: {"id":101} 또는 {"data":{"id":101}}'
                            onChange={(event) => {
                              const value = event.target.value;
                              setResponseSamples((previous) => ({ ...previous, [selectedStep.id]: value }));
                            }}
                        />
                        <small className="muted">
                          실제 응답을 붙여넣으면 아래에서 경로를 고를 수 있습니다. 샘플은 브라우저에서만 사용합니다.
                        </small>
                        {sampleInspection.error && (
                            <small className="request-preview-error" role="status">{sampleInspection.error}</small>
                        )}
                      </div>

                      {selectedStep.extract.map((variable) => {
                        const sampleValue = sampleInspection.values.get(variable.path);
                        return (
                          <div className="scenario-extract-row" key={variable.id}>
                            <div className="field">
                              <label htmlFor={`${variable.id}-name`}>변수명</label>
                              <input
                                  id={`${variable.id}-name`}
                                  value={variable.name}
                                  onChange={(event) =>
                                      updateExtractVariable(selectedStep.id, variable.id, {
                                        name: event.target.value,
                                      })
                                  }
                              />
                            </div>

                            <div className="field">
                              <label htmlFor={`${variable.id}-path`}>응답 JSON 경로</label>
                              <input
                                  id={`${variable.id}-path`}
                                  value={variable.path}
                                  placeholder="예: id 또는 data.id"
                                  onChange={(event) =>
                                      updateExtractVariable(selectedStep.id, variable.id, {
                                        path: event.target.value,
                                      })
                                  }
                              />
                              {samplePaths.length > 0 && (
                                  <select
                                      aria-label={`${variable.name}에 사용할 샘플 응답 경로`}
                                      value={sampleValue === undefined ? "" : variable.path}
                                      onChange={(event) =>
                                          updateExtractVariable(selectedStep.id, variable.id, {
                                            path: event.target.value,
                                          })
                                      }
                                  >
                                    <option value="" disabled>샘플에서 경로 선택</option>
                                    {samplePaths.map((path) => <option key={path} value={path}>{path}</option>)}
                                  </select>
                              )}
                              {samplePaths.length > 0 && variable.path && (
                                  <small
                                      className={sampleValue === undefined ? "request-preview-error" : "muted"}
                                      role="status"
                                  >
                                    {sampleValue === undefined
                                        ? "샘플에서 이 경로의 값을 찾지 못했습니다."
                                        : `샘플 추출값 · ${formatSampleValue(sampleValue)}`}
                                  </small>
                              )}
                            </div>

                            <button
                                type="button"
                                onClick={() =>
                                    updateStep(selectedStep.id, (step) => ({
                                      ...step,
                                      extract: step.extract.filter(({ id }) => id !== variable.id),
                                    }))
                                }
                            >
                              변수 삭제
                            </button>
                          </div>
                        );
                      })}

                      <button
                          type="button"
                          onClick={() =>
                              addExtractVariable(selectedStep.id)
                          }
                      >
                        + 응답 변수 추가
                      </button>
                    </div>
                  </div>
              )}

                <button
                    type="button"
                    onClick={showPreview}
                    disabled={steps.length === 0}
                >
                  시나리오 설정 검증 및 JSON 미리보기
                </button>

                {error && (
                    <p
                        className="request-preview-error"
                        role="alert"
                    >
                      {error}
                    </p>
                )}

                {preview && (
                    <div className="request-preview">
                      <div className="request-preview-header">
                        <h3>시나리오 설정 JSON</h3>
                        <button
                            type="button"
                            className="preview-copy-button"
                            onClick={() =>
                                void navigator.clipboard.writeText(preview)
                            }
                        >
                          복사
                        </button>
                      </div>
                      <pre className="request-preview-code"><code>{preview}</code></pre>
                    </div>
                )}

                <div className="field">
                  <button
                      type="button"
                      className="run-button"
                      onClick={runScenario}
                      disabled={running || loading || steps.length === 0}
                  >
                    {running ? "시나리오 실행 중..." : "시나리오 실행"}
                  </button>
                  {running && (
                      <>
                        <button
                            type="button"
                            className="run-button cancel-button"
                            onClick={stopScenario}
                            disabled={stopRequested}
                        >
                          {stopRequested ? "중지 요청 중..." : "실행 중지"}
                        </button>
                        <small className="muted">중지해도 이미 생성되거나 수정된 데이터는 남습니다.</small>
                      </>
                  )}
                  {runError && <p className="request-preview-error" role="alert">{runError}</p>}
                </div>
            </section>
          </div>

          {run && (
              <section className="panel" aria-label="시나리오 실행 결과">
                <h2>시나리오 실행 결과</h2>
                {run.result.historySaved === false && <p className="request-preview-error" role="alert">이번 실행을 테스트 이력에 저장하지 못했습니다.</p>}
                <p className="muted" role="status">
                  {run.result.executionStatus === "completed" ? "실행 완료" :
                      run.result.executionStatus === "cancelled" ? "실행 중단" : "실행 오류"}
                </p>
                {outcome && (
                    <div className="threshold-result" role="status">
                      <h3>
                        시나리오 동작 판정
                        <span className={`threshold-status threshold-${outcome.status}`}>
                          {outcome.label}
                        </span>
                      </h3>
                      <p className="muted">{outcome.detail}</p>
                    </div>
                )}
                {run.result.metricsAvailable && (
                    <div className="metrics">
                      <div className="metric"><span>총 요청</span><strong>{run.result.metrics.totalRequests}</strong></div>
                      <div className="metric"><span>평균 RPS</span><strong>{run.result.metrics.rps.toFixed(2)}</strong></div>
                      <div className="metric"><span>평균 응답 시간</span><strong>{run.result.metrics.avgResponseTime.toFixed(2)} ms</strong></div>
                      <div className="metric"><span>P95 응답 시간</span><strong>{run.result.metrics.p95ResponseTime.toFixed(2)} ms</strong></div>
                      <div className="metric"><span>HTTP 실패율</span><strong>{run.result.metrics.failureRate.toFixed(2)}%</strong></div>
                    </div>
                )}
                {run.result.scenarioSteps ? (
                    <ol>
                      {run.result.scenarioSteps.map((step, index) => (
                          <li key={run.config.steps[index].id}>
                            <strong>{run.config.steps[index].method} {run.config.steps[index].path}</strong>
                            <p className="muted">
                              성공 {step.succeeded} · HTTP 실패 {step.http_failed} · 요청 처리 오류 {step.request_failed}
                              {" · "}응답 변수 추출 실패 {step.extraction_failed} · 변수 부족으로 건너뜀 {step.skipped}
                            </p>
                          </li>
                      ))}
                    </ol>
                ) : <p className="muted">단계별 집계가 없습니다.</p>}
              </section>
          )}
        </main>
      </div>
  );
}
