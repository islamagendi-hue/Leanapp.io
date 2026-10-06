import { handleIngest, preflight } from "@/modules/ingestion/http";

export const runtime = "nodejs";

export function OPTIONS() {
  return preflight();
}

export function POST(req: Request) {
  return handleIngest(req, "single");
}
