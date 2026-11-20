export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type SchemaType = "string" | "integer" | "number" | "boolean" | "array" | "object" | (string & {});

export interface OpenApiSchema {
    $ref?: string;
    type?: SchemaType;
    format?: string;
    description?: string;
    example?: unknown;
    default?: unknown;
    enum?: unknown[];
    nullable?: boolean;
    required?: string[];
    properties?: Record<string, OpenApiSchema>;
    items?: OpenApiSchema;
    [key: string]: unknown;
}

export interface OpenApiParameter {
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: OpenApiSchema;
    [key: string]: unknown;
}

export interface OpenApiRequestBody {
    description?: string;
    required?: boolean;
    content?: Record<string, { schema?: OpenApiSchema; [key: string]: unknown }>;
    [key: string]: unknown;
}

export interface OpenApiOperationDefinition {
    summary?: string;
    tags?: string[];
    parameters?: OpenApiParameter[];
    security?: Array<Record<string, string[]>>;
    requestBody?: OpenApiRequestBody;
    [key: string]: unknown;
}

export interface OpenApiPathItem {
    parameters?: OpenApiParameter[];
    [method: string]: OpenApiOperationDefinition | OpenApiParameter[] | undefined;
}

export interface OpenApiSpec {
    paths?: Record<string, OpenApiPathItem>;
    components?: { schemas?: Record<string, OpenApiSchema> };
    info?: { title?: string; [key: string]: unknown };
    [key: string]: unknown;
}

export interface RequestBodyField {
    name: string;
    type: SchemaType;
    format: string | null;
    description: string;
    example: unknown;
    required: boolean;
    default: unknown;
    enum: unknown[] | null;
    nullable: boolean;
}

export interface ParsedOperation {
    method: HttpMethod;
    path: string;
    summary?: string;
    tags: string[];
    parameters: OpenApiParameter[];
    security: Array<Record<string, string[]>>;
    requestBody: OpenApiRequestBody | null;
    requestBodyFields: RequestBodyField[];
}

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);

// OpenAPI $ref 참조 해결
function resolveSchema(
    spec: OpenApiSpec,
    schema: OpenApiSchema | undefined,
    visited: Set<string> = new Set<string>()
): OpenApiSchema {
    if (!schema) return {};

    if (schema.$ref) {
        if (visited.has(schema.$ref)) return {};

        const nextVisited = new Set(visited);
        nextVisited.add(schema.$ref);

        const reference = schema.$ref;
        if (!reference.startsWith("#/components/schemas/")) return {};

        const schemaName = reference
            .replace("#/components/schemas/", "")
            .replace(/~1/g, "/")
            .replace(/~0/g, "~");

        return resolveSchema(spec, spec.components?.schemas?.[schemaName], nextVisited);
    }

    return schema;
}

// Request Body DTO 필드 추출
function extractRequestBodyFields(
    spec: OpenApiSpec,
    requestBody: OpenApiRequestBody | null
): RequestBodyField[] {
    if (!requestBody) return [];

    const content = requestBody.content ?? {};
    const mediaType = Object.keys(content).find(
        (type) => type === "application/json" || type.endsWith("+json")
    );
    if (!mediaType) return [];

    const schema = resolveSchema(spec, content[mediaType]?.schema);
    const requiredFields = new Set(schema.required ?? []);

    return Object.entries(schema.properties ?? {}).map(([name, property]): RequestBodyField => {
        const resolved = resolveSchema(spec, property);
        return {
            name,
            type: resolved.type ?? "string",
            format: resolved.format ?? null,
            description: resolved.description ?? "",
            example: resolved.example ?? null,
            required: requiredFields.has(name),
            default: resolved.default ?? null,
            enum: resolved.enum ?? null,
            nullable: resolved.nullable ?? false,
        };
    });
}

export function parseOperations(spec: OpenApiSpec): ParsedOperation[] {
    const operations: ParsedOperation[] = [];

    for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
        for (const [method, value] of Object.entries(pathItem)) {
            if (!METHODS.has(method)) continue;
            if (!value || Array.isArray(value)) continue;

            const operation = value as OpenApiOperationDefinition;
            const requestBody = operation.requestBody ?? null;

            operations.push({
                method: method.toUpperCase() as HttpMethod,
                path,
                summary: operation.summary,
                tags: operation.tags ?? [],
                parameters: [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])],
                security: operation.security ?? [],
                requestBody,
                requestBodyFields: extractRequestBodyFields(spec, requestBody),
            });
        }
    }

    return operations;
}
