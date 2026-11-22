import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { K6ExecutionResult } from "./runner.js";
import type { ScenarioStep } from "./scenario.js";
import type { K6TestConfig } from "./server.js";

const directory = path.resolve(".local");
let database: DatabaseSync | undefined;

function getDatabase(): DatabaseSync {
    if (database) return database;

    mkdirSync(directory, { recursive: true });
    const db = new DatabaseSync(path.join(directory, "test-history.sqlite"));
    try {
        db.exec(`
            PRAGMA busy_timeout = 5000;
            CREATE TABLE IF NOT EXISTS test_runs (
                id INTEGER PRIMARY KEY,
                run_id TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL,
                target TEXT NOT NULL,
                requests TEXT NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT NOT NULL,
                load_label TEXT NOT NULL,
                comparison_key TEXT NOT NULL,
                status TEXT NOT NULL,
                metrics TEXT
            );
        `);
        database = db;
        return db;
    } catch (error) {
        db.close();
        throw error;
    }
}

export function saveTestRun(
    config: K6TestConfig,
    result: K6ExecutionResult,
    startedAt: string,
    scenario?: ScenarioStep[],
): void {
    const kind = scenario ? "scenario" : "single";
    const target = new URL(config.baseUrl).origin;
    const requests = (scenario ?? [config]).map(({ method, path }) => ({ method, path }));
    const distributed = !scenario && config.pathIdMode === "distributed";
    const load = !scenario && config.method === "DELETE"
        ? { mode: "iterations" as const, iterations: config.pathIds.length, maxDuration: "3m" }
        : config.loadMode === "ramping"
            ? { mode: "ramping" as const, up: config.rampUpDuration, hold: config.holdDuration, down: config.rampDownDuration }
            : { mode: "constant" as const, duration: config.duration };
    const vus = load.mode === "iterations" ? Math.min(config.vus, load.iterations) : config.vus;
    const loadLabel = load.mode === "ramping"
        ? `${vus} VU · 증가 ${load.up} / 유지 ${load.hold} / 감소 ${load.down} · 반복 대기 ${config.sleepSeconds}초`
        : load.mode === "iterations"
            ? `${vus} VU · ${load.iterations}회 · 최대 ${load.maxDuration}`
            : `${vus} VU · ${load.duration} · 반복 대기 ${config.sleepSeconds}초`;
    const comparisonKey = createHash("sha256").update(JSON.stringify({
        kind, target, requests, vus, load, distributed, sleepSeconds: config.sleepSeconds,
    })).digest("hex");

    getDatabase().prepare(`
        INSERT INTO test_runs (
            run_id, kind, target, requests, started_at, finished_at, load_label, comparison_key, status, metrics
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO NOTHING
    `).run(
        result.runId, kind, target, JSON.stringify(requests), startedAt, new Date().toISOString(),
        loadLabel, comparisonKey, result.executionStatus, result.metricsAvailable ? JSON.stringify(result.metrics) : null,
    );
}

interface HistoryRow {
    id: number;
    run_id: string;
    kind: "single" | "scenario";
    target: string;
    requests: string;
    started_at: string;
    finished_at: string;
    load_label: string;
    comparison_key: string;
    status: K6ExecutionResult["executionStatus"];
    metrics: string | null;
}

export function getTestHistory(before?: number, query = "", comparable = false) {
    const limit = 30;
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const searchable = `lower(concat_ws(' ', run_id, target, requests, load_label, started_at,
        datetime(started_at, 'localtime'), kind,
        CASE kind WHEN 'single' THEN '단일 API' ELSE '시나리오' END))`;
    const matches = terms.map(() => ` AND instr(${searchable}, ?) > 0`).join("");
    const completed = comparable ? " AND status = 'completed' AND metrics IS NOT NULL" : "";
    const rows = getDatabase().prepare(`
        SELECT * FROM test_runs WHERE id < ?${completed}${matches} ORDER BY id DESC LIMIT ?
    `).all(before ?? Number.MAX_SAFE_INTEGER, ...terms, limit + 1) as unknown as HistoryRow[];
    const runs = rows.slice(0, limit).map(row => ({
        cursor: row.id,
        runId: row.run_id,
        kind: row.kind,
        target: row.target,
        requests: JSON.parse(row.requests) as Array<{ method: string; path: string }>,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        loadLabel: row.load_label,
        comparisonKey: row.comparison_key,
        status: row.status,
        metrics: row.metrics === null ? null : JSON.parse(row.metrics) as K6ExecutionResult["metrics"],
    }));
    return { runs, nextBefore: rows.length > limit ? rows[limit - 1].id : null };
}
