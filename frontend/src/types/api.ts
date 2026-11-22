export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type MethodFilter = HttpMethod | "ALL";
export type SchemaType = "string" | "integer" | "number" | "boolean" | "array" | "object";
export type InputValue = string | number | boolean;
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ApiSchema {
    type?: SchemaType;
    default?: InputValue | null;
}

export interface ApiParameter {
    name: string;
    in: "path" | "query" | "header" | "cookie";
    required?: boolean;
    description?: string;
    schema?: ApiSchema;
}

export interface RequestBodyField {
    name: string;
    type: SchemaType;
    required?: boolean;
    description?: string;
    default?: JsonValue;
    enum?: InputValue[];
}

export interface ApiOperation {
    method: HttpMethod;
    path: string;
    summary?: string;
    tags?: string[];
    parameters?: ApiParameter[];
    requestBody?: unknown;
    requestBodyFields?: RequestBodyField[];
}

