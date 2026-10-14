export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
