import type { RequestBodyField } from "../../types/api";

interface RequestBodyEditorProps {
  fields: RequestBodyField[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  uniqueFields?: Record<string, boolean>;
  onUniqueChange?: (name: string, checked: boolean) => void;
  disabled?: boolean;
  allowVariables?: boolean;
}

export default function RequestBodyEditor({fields,values,onChange,uniqueFields = {},onUniqueChange,disabled=false,allowVariables=false}:RequestBodyEditorProps){
  return <div>
                                        {fields.length === 0 ? (
                                            <p className="muted">
                                                입력 필드를 찾을 수 없습니다.
                                                OpenAPI 스키마를 확인해주세요.
                                            </p>
                                        ) : (
                                            fields.map(
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
                                                                    values[field.name] ?? ""
                                                                }
                                                                onChange={(e) =>
                                                                    onChange(
                                                                        field.name,
                                                                        e.target.value
                                                                    )
                                                                }
                                                                disabled={disabled}
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
                                                                    values[field.name] ?? ""
                                                                }
                                                                onChange={(e) =>
                                                                    onChange(
                                                                        field.name,
                                                                        e.target.value
                                                                    )
                                                                }
                                                                disabled={disabled}
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
                                                                    values[field.name] ?? ""
                                                                }
                                                                placeholder={
                                                                    field.type === "array"
                                                                        ? "[]"
                                                                        : "{}"
                                                                }
                                                                onChange={(e) =>
                                                                    onChange(
                                                                        field.name,
                                                                        e.target.value
                                                                    )
                                                                }
                                                                disabled={disabled}
                                                            />
                                                        ) : (
                                                            <input
                                                                type={
                                                                    allowVariables ? "text" : (["integer", "number"].includes(field.type) ? "number" : "text")
                                                                }
                                                                step={
                                                                    field.type === "integer"
                                                                        ? "1"
                                                                        : "any"
                                                                }
                                                                value={
                                                                    values[field.name] ?? ""
                                                                }
                                                                placeholder={
                                                                    field.default != null
                                                                        ? String(field.default)
                                                                        : field.required
                                                                            ? "필수값을 입력하세요"
                                                                            : "선택값"
                                                                }
                                                                onChange={(e) =>
                                                                    onChange(
                                                                        field.name,
                                                                        e.target.value
                                                                    )
                                                                }
                                                                disabled={disabled}
                                                            />
                                                        )}

                                                        {onUniqueChange && ["string", "integer", "number"].includes(field.type) &&
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
                                                                            onUniqueChange?.(
                                                                                field.name,
                                                                                e.target.checked
                                                                            )
                                                                        }
                                                                        disabled={disabled}
                                                                    />

                                                                    요청마다 고유값 자동 생성
                                                                </label>
                                                            )}
                                                    </div>
                                                )
                                            )
                                        )}

  </div>;
}
