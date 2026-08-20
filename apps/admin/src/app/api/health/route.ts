// Liveness probe for the container healthcheck in compose.yaml. Deliberately checks
// nothing but "this server is answering" — add a DB ping here only if you want an
// unreachable database to take the web container down with it.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
