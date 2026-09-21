/**
 * 可预期的业务拒绝。携带稳定 code，原样进入接口返回与命令审计回执，
 * 使审核人员日后能复原“当时为什么被允许 / 被拦下”。
 */
export class DomainError extends Error {
  constructor(code, message, details = {}, headers = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
    this.headers = headers;
  }

  toBody() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const ErrorCode = {
  VALIDATION: "VALIDATION_FAILED",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  BLOCKED: "STAGE_BLOCKED",
  UNAUTHORIZED: "UNAUTHORIZED",
};

export function fail(code, message, details) {
  return new DomainError(code, message, details);
}
