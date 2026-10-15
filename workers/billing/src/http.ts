export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * A secret as set with `wrangler secret put`, minus any surrounding whitespace or byte-order
 * mark. Windows PowerShell prepends a BOM when it pipes text to a program, and a key carrying
 * one is both rejected upstream and, worse, makes the runtime log the whole header (key
 * included) as a non-ASCII warning. Every secret is read through this.
 */
export function secret(value: string | undefined): string {
  return (value ?? "").trim(); // String.prototype.trim strips U+FEFF too
}
