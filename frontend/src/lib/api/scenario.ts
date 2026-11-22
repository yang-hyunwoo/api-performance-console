import type { ApiOperation, JsonValue } from "../../types/api";

export interface ScenarioStep {
  id: string;
  operation: ApiOperation;
  parameters: Record<string, string>;
  bodyValues: Record<string, string>;
  uniqueFields: Record<string, boolean>;
  extract: Array<{ id: string; name: string; path: string }>;
}
export interface ScenarioConfig {
  name: string;
  baseUrl: string;
  vus: number;
  duration: string;
  sleepSeconds: number;
  steps: Array<{
    id: string;
    method: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    body: Record<string, JsonValue> | null;
    uniqueFields: string[];
    extract: Record<string, string>;
  }>;
}

const TOKEN = /^\$\{([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)\}$/;
export function getByPath(data: unknown, path: string): unknown {
  if (!/^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*$/.test(path)) throw new Error(`잘못된 변수 경로: ${path}`);
  return path.split(".").reduce<unknown>((v, key) => v !== null && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined, data);
}
export function resolveVariables(value: unknown, variables: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const full = value.match(TOKEN);
    if (full) {
      const result = getByPath(variables, full[1]);
      if (result === undefined || result === null) throw new Error(`변수가 없습니다: ${full[1]}`);
      return result;
    }
    return value.replace(/\$\{([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)\}/g, (_, key: string) => {
      const result = getByPath(variables, key);
      if (result === undefined || result === null) throw new Error(`변수가 없습니다: ${key}`);
      if (typeof result === "object") throw new Error(`문자열 안에 객체 변수를 삽입할 수 없습니다: ${key}`);
      return String(result);
    });
  }
  if (Array.isArray(value)) return value.map(v => resolveVariables(v, variables));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, resolveVariables(v, variables)]));
  return value;
}
export function validateScenario(config: ScenarioConfig): void {
  if (!/^https?:\/\//.test(config.baseUrl)) throw new Error("Base URL은 http(s) URL이어야 합니다.");
  if (!Number.isInteger(config.vus) || config.vus < 1) throw new Error("VU는 1 이상이어야 합니다.");
  if (!/^\d+(s|m|h)$/.test(config.duration)) throw new Error("실행 시간 형식이 올바르지 않습니다.");
  if (!Number.isFinite(config.sleepSeconds) || config.sleepSeconds < 0 || config.sleepSeconds > 10) {
    throw new Error("반복 사이 대기 시간은 0~10초로 입력해주세요.");
  }
  if (!config.steps.length) throw new Error("최소 한 개의 API가 필요합니다.");
  const available = new Set<string>();
  for (const step of config.steps) {
    if (!step.path.startsWith("/") || step.path.startsWith("//")) throw new Error(`잘못된 API 경로: ${step.path}`);
    const references = JSON.stringify({path:step.path,query:step.query,headers:step.headers,body:step.body}).matchAll(/\$\{([\w$.]+)\}/g);
    for (const ref of references) if (!available.has(ref[1].split(".")[0])) throw new Error(`${step.id}: 이전 단계에 없는 변수 ${ref[1]}`);
    for (const [name,path] of Object.entries(step.extract)) {
      if (!/^[a-zA-Z_$][\w$]*$/.test(name)) throw new Error(`잘못된 변수명: ${name}`);
      if (!/^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*$/.test(path)) throw new Error(`잘못된 응답 경로: ${path}`);
      available.add(name);
    }
  }
}
