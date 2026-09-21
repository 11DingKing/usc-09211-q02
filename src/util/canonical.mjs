import crypto from "node:crypto";

/**
 * 以确定顺序序列化对象：对象键按字典序排序，数组保持顺序。
 * 业务身份、版本内容与审计信封都通过它得到可复算的指纹。
 */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
  return `{${parts.join(",")}}`;
}

export function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** 对任意可 JSON 化的值计算内容指纹。 */
export function contentHash(value) {
  return sha256Hex(canonicalize(value));
}
