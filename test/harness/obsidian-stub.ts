// Minimal stand-in for the obsidian module: requestUrl is scripted by the test.
export const calls: any[] = [];
export let responses: any[] = [];
export function script(r: any[]) { responses = r; calls.length = 0; }
export async function requestUrl(req: any) {
  calls.push({ ...req, json: req.body ? JSON.parse(req.body) : undefined });
  const body = responses.shift();
  if (body && body.__raw) return body.__raw;
  const text = JSON.stringify(body);
  return { status: 200, headers: { "content-type": "application/json" }, arrayBuffer: new TextEncoder().encode(text).buffer, text, json: body };
}
export class TFile { path = ""; name = ""; extension = ""; basename = ""; stat = { size: 0, mtime: 0 }; }
export class TFolder { path = ""; name = ""; children: any[] = []; }
export function arrayBufferToBase64(b: ArrayBuffer) { return Buffer.from(b).toString("base64"); }
export const normalizePath = (p: string) => p.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
export const parseYaml = (s: string) => JSON.parse(s || "{}");
export const stringifyYaml = (o: unknown) => JSON.stringify(o);
