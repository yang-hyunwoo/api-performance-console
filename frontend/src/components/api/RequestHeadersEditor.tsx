import { createContext, useContext, useId, useState, type ReactNode } from "react";

import "./RequestHeadersEditor.css";

type HeaderField = { id: string; name: string; value: string };
type RequestSettings = {
    bearerToken: string;
    headers: HeaderField[];
    generateRequestId: boolean;
};

const emptySettings: RequestSettings = { bearerToken: "", headers: [], generateRequestId: false };
const RequestSettingsContext = createContext<{
    settings: Record<string, RequestSettings>;
    update: (origin: string, settings: RequestSettings) => void;
} | null>(null);

export function RequestSettingsProvider({ children }: { children: ReactNode }) {
    const [settings, setSettings] = useState<Record<string, RequestSettings>>({});
    return (
        <RequestSettingsContext.Provider value={{
            settings,
            update: (origin, value) => setSettings(previous => ({ ...previous, [origin]: value })),
        }}>
            {children}
        </RequestSettingsContext.Provider>
    );
}

export function useRequestSettings(baseUrl: string) {
    const context = useContext(RequestSettingsContext);
    if (!context) throw new Error("RequestSettingsProvider가 필요합니다.");
    let origin = "";
    try {
        origin = new URL(baseUrl).origin;
    } catch {
        // The run form validates an incomplete target URL.
    }
    return {
        settings: context.settings[origin] ?? emptySettings,
        update: (value: RequestSettings) => { if (origin) context.update(origin, value); },
    };
}

export function buildRequestSettings(settings: RequestSettings) {
    const headers = new Map<string, string>();
    const token = settings.bearerToken.trim();
    if (token) headers.set("authorization", /^Bearer\s/i.test(token) ? token : "Bearer " + token);

    for (const field of settings.headers) {
        const name = field.name.trim().toLowerCase();
        if (!name && !field.value) continue;
        if (!name || !field.value.trim()) throw new Error("공통 헤더의 이름과 값을 입력해주세요.");
        if (headers.has(name)) throw new Error("공통 헤더 이름이 중복됩니다: " + name);
        headers.set(name, field.value.trim());
    }
    if (settings.generateRequestId && headers.has("x-request-id")) {
        throw new Error("X-Request-ID를 직접 지정하거나 자동 생성 중 하나를 선택해주세요.");
    }
    return {
        commonHeaders: Object.fromEntries(headers),
        generateRequestId: settings.generateRequestId,
    };
}

export default function RequestHeadersEditor({ baseUrl, disabled }: { baseUrl: string; disabled: boolean }) {
    const { settings, update } = useRequestSettings(baseUrl);
    const fieldPrefix = useId();
    const editHeader = (id: string, change: Partial<Pick<HeaderField, "name" | "value">>) => {
        update({ ...settings, headers: settings.headers.map(field => field.id === id ? { ...field, ...change } : field) });
    };

    return (
        <div className="path-distribution request-headers-editor">
            <h3>인증·공통 헤더</h3>
            <div className="field">
                <label htmlFor={fieldPrefix + "-bearer"}>Bearer 토큰</label>
                <input
                    id={fieldPrefix + "-bearer"}
                    type="password"
                    autoComplete="off"
                    value={settings.bearerToken}
                    onChange={event => update({ ...settings, bearerToken: event.target.value })}
                    disabled={disabled}
                />
                <small className="muted">같은 대상 서버의 단일 API 테스트와 시나리오에서 공유합니다.</small>
            </div>

            {settings.headers.map((field, index) => (
                <div className="request-header-row" key={field.id}>
                    <div className="field">
                        <label htmlFor={field.id + "-name"}>헤더 이름 {index + 1}</label>
                        <input id={field.id + "-name"} value={field.name} placeholder="예: X-API-Key"
                            onChange={event => editHeader(field.id, { name: event.target.value })} disabled={disabled} />
                    </div>
                    <div className="field">
                        <label htmlFor={field.id + "-value"}>헤더 값 {index + 1}</label>
                        <input id={field.id + "-value"} type="password" autoComplete="off" value={field.value}
                            onChange={event => editHeader(field.id, { value: event.target.value })} disabled={disabled} />
                    </div>
                    <button type="button" className="request-header-button request-header-button--remove" disabled={disabled}
                        onClick={() => update({ ...settings, headers: settings.headers.filter(item => item.id !== field.id) })}>
                        헤더 삭제
                    </button>
                </div>
            ))}

            <div className="request-header-actions">
                <button type="button" className="request-header-button" disabled={disabled} onClick={() =>
                    update({ ...settings, headers: [...settings.headers, { id: crypto.randomUUID(), name: "", value: "" }] })
                }>
                    헤더 추가
                </button>
            </div>

            <label className="unique-field-option">
                <input type="checkbox" checked={settings.generateRequestId} disabled={disabled}
                    onChange={event => update({ ...settings, generateRequestId: event.target.checked })} />
                요청마다 X-Request-ID 자동 생성
            </label>
        </div>
    );
}
