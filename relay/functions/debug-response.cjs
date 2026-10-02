const fs = require("fs");
const buf = fs.readFileSync("test-lease.docx");
const body = JSON.stringify({
  action: "analyze",
  documentType: "commercial_lease",
  documentName: "test-lease.docx",
  fileContent: buf.toString("base64"),
  fileName: "test-lease.docx",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
});
const API_KEY = "3a02d6eecc89f1c700c097f9034479c24a56787acfbc996c5d17086ecd364602";
(async () => {
  const r = await fetch("http://localhost:8080/api/v1/functions/lease-analyzer", {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": API_KEY }, body, signal: AbortSignal.timeout(60000)
  });
  const d = await r.json();
  console.log("=== TOP-LEVEL KEYS ===");
  console.log(Object.keys(d));
  console.log("\n=== documentInfo keys ===");
  console.log(Object.keys(d.documentInfo || {}));
  console.log("\n=== extraction ===");
  console.log(JSON.stringify(d.documentInfo?.extraction, (k,v) => k==='html'?'[html]':v, 2).slice(0, 1500));
  console.log("\n=== meta ===");
  console.log(JSON.stringify(d.meta));
})().catch(e => console.error("ERR", e.message));
