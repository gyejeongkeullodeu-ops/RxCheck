const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const Busboy = require("busboy");
const { PDFDocument } = require("pdf-lib");

const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

const PORT = Number(process.env.PORT || 3000);
const API_BASE = "https://api.upstage.ai/v2";
const PROJECT_ID = process.env.UPSTAGE_PROJECT_ID || "proj_8uY97TAdGoWr6c3TLfTjRg";
const AGENT_ID = process.env.UPSTAGE_AGENT_ID || "agt_iUvTh2qfYA3gouJddewP8U";
const CONFIG_ID = process.env.UPSTAGE_CONFIG_ID;
const PUBLIC_DIR = path.join(__dirname, "public");
const allowedExtensions = new Set([
  "pdf", "jpg", "jpeg", "png", "bmp", "tiff", "heic", "docx", "pptx", "xlsx",
  "mp4", "mov", "m4v", "avi", "mkv", "webm", "wmv", "flv", "mpg", "mpeg", "3gp"
]);

function headers() {
  const key = process.env.UPSTAGE_API_KEY;
  if (!key) throw new Error("UPSTAGE_API_KEY가 설정되지 않았습니다.");
  return {
    Authorization: `Bearer ${key}`,
    "x-project-id": PROJECT_ID
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendError(res, error) {
  const message = error instanceof Error ? error.message : "요청 처리 중 오류가 발생했습니다.";
  sendJson(res, 500, { error: message });
}

async function uploadFile(req) {
  const form = Busboy({ headers: req.headers, limits: { fileSize: 500 * 1024 * 1024, files: 1 } });
  const chunks = [];
  let filename = "";
  let mimeType = "application/octet-stream";
  let fileSize = 0;
  let limitExceeded = false;

  await new Promise((resolve, reject) => {
    form.on("file", (_field, file, info) => {
      filename = info.filename;
      mimeType = info.mimeType;
      file.on("data", (chunk) => {
        fileSize += chunk.length;
        chunks.push(chunk);
      });
      file.on("limit", () => { limitExceeded = true; });
    });
    form.on("error", reject);
    form.on("finish", resolve);
    req.pipe(form);
  });

  if (!filename) throw new Error("업로드할 파일을 선택해 주세요.");
  if (limitExceeded || fileSize > 500 * 1024 * 1024) throw new Error("파일은 500MB 이하만 업로드할 수 있습니다.");
  const extension = filename.split(".").pop().toLowerCase();
  if (!allowedExtensions.has(extension)) throw new Error("지원하지 않는 파일 형식입니다.");

  const body = new FormData();
  body.append("file", new Blob([Buffer.concat(chunks)], { type: mimeType }), filename);
  body.append("purpose", "user_data");
  const response = await fetch(`${API_BASE}/files`, { method: "POST", headers: headers(), body });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "파일 업로드에 실패했습니다.");
  return data;
}

async function readMultipartFiles(req) {
  const form = Busboy({ headers: req.headers, limits: { fileSize: 500 * 1024 * 1024, files: 2 } });
  const files = [];
  await new Promise((resolve, reject) => {
    form.on("file", (_field, file, info) => {
      const chunks = [];
      file.on("data", (chunk) => chunks.push(chunk));
      file.on("end", () => files.push({
        filename: info.filename,
        mimeType: info.mimeType,
        buffer: Buffer.concat(chunks)
      }));
    });
    form.on("error", reject);
    form.on("finish", resolve);
    req.pipe(form);
  });
  if (files.length < 1 || files.length > 2) {
    throw new Error("청구서·영수증 합본 PDF 1개, 또는 청구서와 영수증 PDF 2개를 선택해 주세요.");
  }
  if (files.some((file) => path.extname(file.filename).toLowerCase() !== ".pdf")) {
    throw new Error("PDF 파일만 올릴 수 있습니다.");
  }
  return files;
}

async function analyzeDocuments(req) {
  const files = await readMultipartFiles(req);
  const mergedPdf = await PDFDocument.create();
  for (const file of files) {
    const sourcePdf = await PDFDocument.load(file.buffer);
    const pages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
    pages.forEach((page) => mergedPdf.addPage(page));
  }
  const mergedBuffer = Buffer.from(await mergedPdf.save());
  const body = new FormData();
  body.append("file", new Blob([mergedBuffer], { type: "application/pdf" }), "mission-2-documents.pdf");
  body.append("purpose", "user_data");
  const response = await fetch(`${API_BASE}/files`, { method: "POST", headers: headers(), body });
  const uploaded = await response.json();
  if (!response.ok) throw new Error(uploaded.error?.message || "문서 업로드에 실패했습니다.");
  return createJob(uploaded.id);
}

async function createJob(fileId) {
  const body = {
    model: AGENT_ID,
    include: ["all"],
    input: [{
      role: "user",
      content: [{ type: "input_file", file_id: fileId }]
    }]
  };
  if (CONFIG_ID) body.config_id = CONFIG_ID;
  const response = await fetch(`${API_BASE}/responses`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "분석 작업을 시작하지 못했습니다.");
  return data;
}

async function getJob(jobId) {
  const response = await fetch(`${API_BASE}/responses/${encodeURIComponent(jobId)}?include[]=all`, {
    headers: headers()
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "분석 상태를 조회하지 못했습니다.");
  return data;
}

function serveStatic(req, res) {
  const requestedPath = req.url.split("?")[0];
  const requested = requestedPath === "/" ? "/index.html" : requestedPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const type = path.extname(filePath) === ".html" ? "text/html; charset=utf-8"
      : path.extname(filePath) === ".css" ? "text/css; charset=utf-8"
      : "application/javascript; charset=utf-8";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store"
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/upload") {
      sendJson(res, 200, await uploadFile(req));
      return;
    }
    if (req.method === "POST" && req.url === "/api/analyze") {
      sendJson(res, 200, await analyzeDocuments(req));
      return;
    }
    if (req.method === "POST" && req.url === "/api/jobs") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const { fileIds } = JSON.parse(raw);
      if (!Array.isArray(fileIds) || fileIds.length !== 2) throw new Error("청구서와 영수증 파일을 모두 선택해 주세요.");
      sendJson(res, 200, { jobs: await Promise.all(fileIds.map(createJob)) });
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/jobs/")) {
      sendJson(res, 200, await getJob(req.url.slice("/api/jobs/".length)));
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    sendError(res, error);
  }
});

server.listen(PORT, () => {
  console.log(`Mission 2 app is running at http://localhost:${PORT}`);
});
