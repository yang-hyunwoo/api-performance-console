import { useEffect, useState } from "react";
import "./SingleApiTestPage.css";
import "./TestHistoryPage.css";

const HISTORY_URL = "http://127.0.0.1:4000/api/tests/history";
const dateFormat = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const dateOnly = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
const timeOnly = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const kindLabels = { single: "단일 API", scenario: "시나리오" };
const statusLabels = { completed: "완료", cancelled: "중지", error: "오류" };

interface HistoryRun {
    cursor: number;
    runId: string;
    kind: "single" | "scenario";
    target: string;
    requests: Array<{ method: string; path: string }>;
    startedAt: string;
    loadLabel: string;
    comparisonKey: string;
    status: keyof typeof statusLabels;
    metrics: {
        rps: number;
        p95ResponseTime: number;
        failureRate: number;
    } | null;
}

interface HistoryPage {
    runs: HistoryRun[];
    nextBefore: number | null;
}

const compareMetrics = [
    { key: "rps", label: "평균 RPS", unit: "", deltaUnit: "" },
    { key: "p95ResponseTime", label: "P95 응답 시간", unit: " ms", deltaUnit: " ms" },
    { key: "failureRate", label: "HTTP 실패율", unit: "%", deltaUnit: "%p" },
] as const;

async function readHistory(before?: number, signal?: AbortSignal, query = "", comparable = false): Promise<HistoryPage> {
    const url = new URL(HISTORY_URL);
    if (before !== undefined) url.searchParams.set("before", String(before));
    if (query) url.searchParams.set("q", query);
    if (comparable) url.searchParams.set("comparable", "1");
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error("테스트 이력을 불러오지 못했습니다.");
    return response.json() as Promise<HistoryPage>;
}

function requestLabel(run: HistoryRun) {
    return run.requests.map(({ method, path }) => method + " " + path).join(" → ");
}

function runLabel(run: HistoryRun) {
    return dateFormat.format(new Date(run.startedAt)) + " · " + requestLabel(run);
}

function useRunSearch(query: string, before?: number, enabled = true) {
    const key = `${before ?? ""}:${query}`;
    const [result, setResult] = useState<{ key: string; page: HistoryPage | null }>();
    const [recent, setRecent] = useState<{ before?: number; runs: HistoryRun[] }>();

    useEffect(() => {
        if (!enabled) return;
        const controller = new AbortController();
        const timer = window.setTimeout(() => {
            void readHistory(before, controller.signal, query, true).then(page => {
                if (controller.signal.aborted) return;
                setResult({ key, page });
                if (!query) setRecent({ before, runs: page.runs });
            }).catch(() => {
                if (!controller.signal.aborted) setResult({ key, page: null });
            });
        }, query ? 200 : 0);
        return () => {
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [before, enabled, key, query]);

    const current = result?.key === key ? result : undefined;
    return {
        runs: enabled ? current?.page?.runs ?? [] : [],
        recent: recent && recent.before === before ? recent.runs : [],
        pending: enabled && !current,
        failed: enabled && current?.page === null,
        hasMore: current?.page?.nextBefore != null,
    };
}

function searchHint(search: ReturnType<typeof useRunSearch>): string {
    if (search.pending) return "검색 중…";
    if (search.failed) return "검색하지 못했습니다. 검색어를 바꿔 다시 시도해주세요.";
    if (!search.runs.length) return "검색 결과가 없습니다.";
    if (search.hasMore) return "최신 30건을 표시합니다. 검색어를 더 구체적으로 입력해주세요.";
    return "";
}

function keepSelected(options: HistoryRun[], selected?: HistoryRun) {
    return selected && !options.some(run => run.runId === selected.runId) ? [selected, ...options] : options;
}

export default function TestHistoryPage() {
    const [runs, setRuns] = useState<HistoryRun[]>([]);
    const [nextBefore, setNextBefore] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [selectedRun, setSelectedRun] = useState<HistoryRun>();
    const [baselineRun, setBaselineRun] = useState<HistoryRun>();
    const [selectedQuery, setSelectedQuery] = useState("");
    const [baselineQuery, setBaselineQuery] = useState("");

    useEffect(() => {
        const controller = new AbortController();
        void readHistory(undefined, controller.signal)
            .then(page => {
                setRuns(page.runs);
                setNextBefore(page.nextBefore);
            })
            .catch(() => {
                if (!controller.signal.aborted) setError("테스트 이력을 불러오지 못했습니다. Express 백엔드를 확인해주세요.");
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, []);

    const completed = runs.filter(run => run.status === "completed" && run.metrics !== null);
    const selectedSearch = useRunSearch(selectedQuery.trim());
    const selected = selectedRun ?? selectedSearch.recent[0] ?? completed[0];
    const baselineSearch = useRunSearch(baselineQuery.trim(), selected?.cursor, Boolean(selected));
    const fallbackRuns = completed.filter(run => selected && run.cursor < selected.cursor);
    const defaultBaselines = baselineSearch.recent.length ? baselineSearch.recent : fallbackRuns;
    const baseline = baselineRun ??
        defaultBaselines.find(run => run.comparisonKey === selected?.comparisonKey) ?? defaultBaselines[0];

    const comparisonOptions = keepSelected(selectedSearch.runs, selected);
    const baselineOptions = keepSelected(baselineSearch.runs, baseline);
    const matchingRuns = baselineOptions.filter(run => run.comparisonKey === selected?.comparisonKey);
    const otherRuns = baselineOptions.filter(run => run.comparisonKey !== selected?.comparisonKey);
    const sameConditions = baseline !== undefined && baseline.comparisonKey === selected?.comparisonKey;
    const baselineMetrics = baseline?.metrics;
    const selectedMetrics = selected?.metrics;

    async function loadMore() {
        if (nextBefore === null || loading) return;
        setLoading(true);
        setError("");
        try {
            const page = await readHistory(nextBefore);
            setRuns(previous => [...previous, ...page.runs]);
            setNextBefore(page.nextBefore);
        } catch {
            setError("이전 기록을 불러오지 못했습니다.");
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="app history-page">
            <header className="header">
                <div className="container">
                    <h1>테스트 이력</h1>
                    <p>이전 실행과 RPS, P95 응답 시간, HTTP 실패율을 비교합니다.</p>
                </div>
            </header>
            <main className="container main">
                {error && <p className="request-preview-error" role="alert">{error}</p>}
                {loading && runs.length === 0 && <p className="muted" role="status">이력을 불러오는 중입니다.</p>}
                {!loading && !error && runs.length === 0 && (
                    <section className="panel"><p className="muted">저장된 실행이 없습니다. 단일 API 또는 시나리오 테스트를 실행하면 여기에 표시됩니다.</p></section>
                )}

                {selected && (
                    <section className="panel history-comparison" aria-labelledby="history-comparison">
                        <h2 id="history-comparison">이전 실행과 비교</h2>
                        <div className="settings-grid history-search-grid">
                            <div className="field">
                                <label htmlFor="history-selected-search">비교할 실행 검색</label>
                                <input id="history-selected-search" type="search" maxLength={160} value={selectedQuery}
                                    placeholder="예: GET /api/records, 시나리오, 2026-11-22"
                                    onChange={event => setSelectedQuery(event.target.value)} />
                                <label htmlFor="history-selected">비교할 실행</label>
                                <select id="history-selected" value={selected.runId} onChange={event => {
                                    setSelectedRun(comparisonOptions.find(run => run.runId === event.target.value));
                                    setBaselineRun(undefined);
                                    setBaselineQuery("");
                                }}>
                                    {comparisonOptions.map(run => <option key={run.runId} value={run.runId}>{runLabel(run)}</option>)}
                                </select>
                                {selectedQuery.trim() && <small className="muted" role="status">{searchHint(selectedSearch)}</small>}
                            </div>
                            <div className="field">
                                <label htmlFor="history-baseline-search">기준 실행 검색</label>
                                <input id="history-baseline-search" type="search" maxLength={160} value={baselineQuery}
                                    placeholder="비교할 실행보다 오래된 기록 검색"
                                    onChange={event => setBaselineQuery(event.target.value)} />
                                <label htmlFor="history-baseline">기준 실행</label>
                                <select id="history-baseline" value={baseline?.runId ?? ""} disabled={!baselineOptions.length}
                                    onChange={event => setBaselineRun(baselineOptions.find(run => run.runId === event.target.value))}>
                                    {!baseline && <option value="" disabled>{baselineOptions.length ? "기준 실행을 선택하세요" : "비교할 이전 완료 기록이 없습니다"}</option>}
                                    {matchingRuns.length > 0 && (
                                        <optgroup label="같은 조건">
                                            {matchingRuns.map(run => <option key={run.runId} value={run.runId}>{runLabel(run)}</option>)}
                                        </optgroup>
                                    )}
                                    {otherRuns.length > 0 && (
                                        <optgroup label="다른 조건">
                                            {otherRuns.map(run => <option key={run.runId} value={run.runId}>{runLabel(run)}</option>)}
                                        </optgroup>
                                    )}
                                </select>
                                {baselineQuery.trim() && <small className="muted" role="status">{searchHint(baselineSearch)}</small>}
                            </div>
                        </div>
                        <p className="muted">비교 실행 · {selected.target} · {selected.loadLabel}</p>
                        {baseline && !sameConditions && (
                            <div className="history-comparison-note">
                                <strong>실행 조건이 다릅니다. 변화량은 수치 차이로만 참고하세요.</strong>
                                <div>기준 실행 · {kindLabels[baseline.kind]} · {baseline.target} · {baseline.loadLabel}</div>
                            </div>
                        )}
                        {baselineMetrics && selectedMetrics && (
                            <div className="history-table-scroll">
                                <table className="history-table">
                                    <thead><tr><th scope="col">지표</th><th scope="col" className="history-metric">기준</th><th scope="col" className="history-metric">비교</th><th scope="col" className="history-metric">변화</th></tr></thead>
                                    <tbody>
                                        {compareMetrics.map(metric => {
                                            const before = baselineMetrics[metric.key];
                                            const after = selectedMetrics[metric.key];
                                            const change = Number((after - before).toFixed(2));
                                            const improved = metric.key === "rps" ? change > 0 : change < 0;
                                            const changeStyle = !sameConditions || change === 0 ? "" : improved ? " history-badge--improved" : " history-badge--worse";
                                            return (
                                                <tr key={metric.key}>
                                                    <th scope="row">{metric.label}</th>
                                                    <td className="history-metric">{before.toFixed(2)}{metric.unit}</td>
                                                    <td className="history-metric">{after.toFixed(2)}{metric.unit}</td>
                                                    <td className="history-metric">
                                                        <span className={"history-badge" + changeStyle}>
                                                            {change > 0 ? "+" : ""}{change.toFixed(2)}{metric.deltaUnit}
                                                        </span>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>
                )}

                {runs.length > 0 && (
                    <section className="panel" aria-labelledby="history-runs">
                        <h2 id="history-runs">실행 기록</h2>
                        <div className="history-table-scroll">
                            <table className="history-table">
                                <thead><tr>
                                    <th scope="col">실행 시각</th>
                                    <th scope="col">테스트 유형</th>
                                    <th scope="col">대상과 요청</th>
                                    <th scope="col">상태</th>
                                    {compareMetrics.map(metric => <th key={metric.key} scope="col" className="history-metric">{metric.label}</th>)}
                                </tr></thead>
                                <tbody>
                                    {runs.map(run => (
                                        <tr key={run.runId}>
                                            <td>
                                                <time dateTime={run.startedAt}>
                                                    {dateOnly.format(new Date(run.startedAt))}
                                                    <small>{timeOnly.format(new Date(run.startedAt))}</small>
                                                </time>
                                            </td>
                                            <td>
                                                <span className={`history-badge history-badge--${run.kind}`}>{kindLabels[run.kind]}</span>
                                            </td>
                                            <th scope="row" className="history-request">
                                                {requestLabel(run)}
                                                <small>{run.target} · {run.loadLabel}</small>
                                            </th>
                                            <td><span className={`history-badge history-badge--${run.status}`}>{statusLabels[run.status]}</span></td>
                                            {compareMetrics.map(metric => (
                                                <td key={metric.key} className="history-metric">{run.metrics ? run.metrics[metric.key].toFixed(2) + metric.unit : "—"}</td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {nextBefore !== null && (
                            <button className="history-more" type="button" disabled={loading} onClick={loadMore}>
                                {loading ? "불러오는 중…" : "이전 기록 더 보기"}
                            </button>
                        )}
                    </section>
                )}
            </main>
        </div>
    );
}
