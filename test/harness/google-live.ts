// Live check against a real shared doc: prints sizes only.
import { cleanExport, googleExportUrl, looksLikeLoginPage } from "../../src/google";
for (const link of process.argv.slice(2)) {
  const ex = googleExportUrl(link)!;
  const res = await fetch(ex.url, { redirect: "follow" });
  const ct = res.headers.get("content-type") ?? "";
  const text = cleanExport(await res.text());
  console.log(`${ex.kind} ${ex.part ?? "(all tabs)"}: HTTP ${res.status}, ${ct.split(";")[0]}, login page: ${looksLikeLoginPage(ct, text)}, ${text.length} chars, ${text.split("\n").filter((l) => l.startsWith("|")).length} table rows`);
}
// a doc that isn't shared publicly
const priv = googleExportUrl("https://docs.google.com/document/d/1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/edit")!;
const r = await fetch(priv.url, { redirect: "follow" });
console.log(`unshared/missing doc: HTTP ${r.status}, ${(r.headers.get("content-type") ?? "").split(";")[0]}`);
