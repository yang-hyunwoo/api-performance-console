import type { RequestBodyField, JsonValue } from "../../types/api";

export function parseBodyFieldValue(field: RequestBodyField, value: JsonValue): JsonValue {
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

export function buildRequestBody(fields: RequestBodyField[], bodyValues: Record<string, string>): Record<string, JsonValue> {
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

