/**
 * 事件时间（occurredAt，调用方报告的业务发生时间）与接收时间
 * （recordedAt，服务落盘时间）始终分离记录。
 */
export function parseTime(value, field = "时间") {
  if (typeof value !== "string") {
    throw new TypeError(`${field}必须为 ISO 8601 字符串`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new TypeError(`${field}不是合法的 ISO 8601 时间：${value}`);
  }
  return { iso: new Date(ms).toISOString(), ms };
}
