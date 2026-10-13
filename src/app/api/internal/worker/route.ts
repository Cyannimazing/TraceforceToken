export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json({ error: "Saved-job processing has been retired. Scans run only for the current request." }, { status: 410, headers: { "cache-control": "no-store" } });
}
