export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json({ error: "Reports are not saved on the server. Start a fresh token investigation." }, { status: 410, headers: { "cache-control": "no-store" } });
}
