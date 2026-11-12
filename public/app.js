const state = { locked: false, mode: "separate", files: { invoice: null, receipt: null, combined: null } };
const allowedExtensions = ["pdf"];
const $ = (selector) => document.querySelector(selector);

const modeHints = {
  separate: "청구서와 영수증 PDF를 각각 올려주세요.",
  combined: "청구서와 영수증이 함께 들어있는 PDF 1개를 올려주세요."
};

document.querySelectorAll(".mode-option").forEach((option) => {
  option.addEventListener("click", () => setMode(option.dataset.mode));
});

function setMode(mode) {
  if (state.locked) return;
  state.mode = mode;
  document.querySelectorAll(".mode-option").forEach((option) => {
    const active = option.dataset.mode === mode;
    option.classList.toggle("active", active);
    option.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(".upload-card").forEach((card) => {
    card.hidden = (card.dataset.type === "combined") !== (mode === "combined");
  });
  $("#upload-hint").textContent = modeHints[mode];
  $("#status-message").textContent = "";
  updateAnalyzeButton();
}

function selectedFiles() {
  return state.mode === "combined"
    ? [["combined", state.files.combined]]
    : [["invoice", state.files.invoice], ["receipt", state.files.receipt]];
}

function updateAnalyzeButton() {
  $("#analyze-button").disabled = state.locked || !selectedFiles().every(([, file]) => file);
}

function setLocked(locked) {
  state.locked = locked;
  $(".workspace").classList.toggle("locked", locked);
  document.querySelectorAll(".upload-card input, .remove-file, .mode-option, #sample-button").forEach((el) => { el.disabled = locked; });
  document.querySelectorAll(".upload-card").forEach((card) => card.classList.remove("dragging"));
}

document.querySelectorAll(".upload-card").forEach((card) => {
  const input = card.querySelector("input");
  const type = card.dataset.type;
  card.addEventListener("click", (event) => {
    if (state.locked) { event.preventDefault(); return; }
    if (event.target !== input) {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener("change", () => setFile(type, input.files[0], card));
  ["dragenter", "dragover"].forEach((event) => card.addEventListener(event, (e) => {
    e.preventDefault(); if (!state.locked) card.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach((event) => card.addEventListener(event, (e) => {
    e.preventDefault(); card.classList.remove("dragging");
  }));
  card.addEventListener("drop", (e) => !state.locked && setFile(type, e.dataTransfer.files[0], card));
  card.querySelector(".remove-file").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearFile(type, card);
  });
});

function clearFile(type, card) {
  if (state.locked) return;
  state.files[type] = null;
  card.querySelector("input").value = "";
  card.querySelector(".selected-file").textContent = "";
  card.querySelector(".remove-file").hidden = true;
  card.classList.remove("uploaded");
  updateAnalyzeButton();
}

function setFile(type, file, card) {
  if (!file || state.locked) return;
  const extension = file.name.split(".").pop().toLowerCase();
  const message = $("#status-message");
  if (!allowedExtensions.includes(extension)) {
    message.textContent = "PDF 파일만 올릴 수 있습니다.";
    message.style.color = "var(--red)";
    return;
  }
  if (file.size > 500 * 1024 * 1024) {
    message.textContent = "파일은 500MB 이하만 업로드할 수 있습니다.";
    message.style.color = "var(--red)";
    return;
  }
  state.files[type] = file;
  card.querySelector(".selected-file").textContent = `✓ ${file.name}`;
  card.querySelector(".remove-file").hidden = false;
  card.classList.add("uploaded");
  message.textContent = "";
  message.style.color = "";
  updateAnalyzeButton();
}

const sampleFiles = {
  invoice: { url: "/examples/sample-invoice.pdf", name: "예시_처방전.pdf" },
  receipt: { url: "/examples/sample-receipt.pdf", name: "예시_영수증.pdf" },
  combined: { url: "/examples/sample-combined.pdf", name: "예시_처방전+영수증.pdf" }
};

async function loadSampleFiles() {
  if (state.locked) return;
  const button = $("#sample-button");
  const message = $("#status-message");
  button.disabled = true;
  button.textContent = "예시 문서 불러오는 중...";
  try {
    const entries = await Promise.all(Object.entries(sampleFiles).map(async ([type, sample]) => {
      const response = await fetch(sample.url);
      if (!response.ok) throw new Error();
      const blob = await response.blob();
      return [type, new File([blob], sample.name, { type: "application/pdf" })];
    }));
    entries.forEach(([type, file]) => setFile(type, file, $(`.upload-card[data-type="${type}"]`)));
    message.textContent = "예시 문서를 불러왔습니다. 검증하기 버튼을 눌러보세요.";
    message.style.color = "";
  } catch {
    message.textContent = "예시 문서를 불러오지 못했습니다.";
    message.style.color = "var(--red)";
  } finally {
    button.disabled = state.locked;
    button.textContent = "예시 문서로 체험하기";
  }
}

$("#sample-button").addEventListener("click", loadSampleFiles);
$("#analyze-button").addEventListener("click", analyze);
$("#reset-button").addEventListener("click", () => window.location.reload());

async function analyze() {
  const button = $("#analyze-button");
  const status = $("#status-message");
  setLocked(true);
  button.disabled = true;
  button.textContent = "업로드 중...";
  try {
    const form = new FormData();
    selectedFiles().forEach(([field, file]) => form.append(field, file));
    button.textContent = "AI가 문서를 검증 중...";
    status.textContent = "문서 구조 파악 → 정보 추출 → 정합성 비교를 진행하고 있습니다.";
    const jobResponse = await fetch("/api/analyze", { method: "POST", body: form });
    const job = await jobResponse.json();
    if (!jobResponse.ok) throw new Error(job.error || "분석을 시작하지 못했습니다.");
    const result = await pollJob(job.id);
    renderResults(result);
  } catch (error) {
    status.textContent = error.message;
    status.style.color = "var(--red)";
    setLocked(false);
    button.disabled = false;
    button.textContent = "두 문서 검증하기 →";
  }
}

async function pollJob(jobId) {
  for (;;) {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || "분석 상태를 조회하지 못했습니다.");
    if (job.status === "completed") return parseOutput(job);
    if (job.status === "failed") throw new Error("AI 문서 분석에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}

function parseOutput(job) {
  const parseJsonText = (text) => {
    let parsed = JSON.parse(text);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    return parsed;
  };
  const parsedOutputs = [];
  for (const output of job.output || []) {
    for (const content of output.content || []) {
      if (content.text) {
        try {
          const parsed = parseJsonText(content.text);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) parsedOutputs.push(parsed);
        } catch {
          // Non-JSON intermediate steps are explanatory output, not structured fields.
        }
      }
    }
  }
  if (job.output_text) parsedOutputs.push(parseJsonText(job.output_text));
  const finalResult = parsedOutputs.at(-1) || {};
  return { ...finalResult, ...extractIntermediateFields(parsedOutputs) };
}

function extractIntermediateFields(outputs) {
  const fields = {};
  const firstValue = (...keys) => {
    for (const output of outputs) {
      for (const key of keys) {
        if (output[key] !== undefined && output[key] !== null && output[key] !== "") return output[key];
      }
    }
    return undefined;
  };
  fields.patient_name = firstValue("patient_name", "처방전_환자_성명", "영수증_환자_성명");
  fields.treatment_period = firstValue("처방전_교부일", "영수증_처방전_교부일", "조제_일자");
  fields.total_amount = firstValue("total_amount", "급여_합계_금액", "총_약제비_급여_합계");
  fields.copayment = firstValue("copayment", "급여_본인부담금", "환자_부담_총액");
  fields.paid_amount = firstValue("paid_amount", "납부할_금액", "카드_수납_금액");
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function renderResults(result) {
  const normalized = normalizeResult(result);
  $("#summary-grid").innerHTML = normalized.summary.map((item) =>
    `<div class="summary-item ${item.tone}"><span class="label">${escapeHtml(item.label)}</span><span class="value">${escapeHtml(item.value)}</span></div>`).join("");
  $("#data-table").innerHTML = normalized.rows.map((row) =>
    row.single
      ? `<div class="data-row single"><span class="key">${escapeHtml(row.key)}</span><span>${escapeHtml(row.value)}</span></div>`
      : `<div class="data-row"><span class="key">${escapeHtml(row.key)}</span><span>${escapeHtml(row.invoice)}</span><span class="${row.match ? "match" : "unavailable"}">${escapeHtml(row.receipt)}</span></div>`).join("");
  $("#exception-list").innerHTML = normalized.exceptions.map((item) =>
    `<li><span class="exception-dot"></span><span>${escapeHtml(item)}</span></li>`).join("");
  $("#results").hidden = false;
  $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
  $("#status-message").textContent = "";
  $("#analyze-button").textContent = "검증 완료";
}

function normalizeResult(data) {
  const values = data.fields || data.result || data;
  const derived = deriveFieldsFromReason(values?.reason);
  const value = (key, fallback = "Agent 미반환") => values?.[key] || derived[key] || fallback;
  const mismatch = value("mismatch_items", []);
  const missing = value("missing_documents", []);
  return {
    summary: [
      { label: "종합 판정", value: value("decision", "확인 필요"), tone: value("decision", "").includes("정상") ? "match" : "warning" },
      { label: "환자명", value: value("patient_name", "확인 필요"), tone: "match" },
      { label: "차이 항목", value: Array.isArray(mismatch) ? `${mismatch.length}건` : String(mismatch), tone: mismatch.length ? "warning" : "match" },
      { label: "누락 문서", value: Array.isArray(missing) ? `${missing.length}건` : String(missing), tone: missing.length ? "warning" : "match" }
    ],
    rows: [
      { key: "환자명", invoice: value("patient_name", "-"), receipt: value("patient_name", "-"), match: true },
      { key: "진료기간", invoice: value("treatment_period"), receipt: value("treatment_period"), match: true },
      { key: "총액", invoice: value("total_amount"), receipt: value("paid_amount"), match: !mismatch.length },
      { key: "본인부담금", invoice: value("copayment"), receipt: value("paid_amount"), match: !mismatch.length },
      { key: "판정 사유", value: value("reason"), single: true }
    ],
    exceptions: [
      ...(Array.isArray(missing) ? missing.map((item) => `누락 문서: ${item}`) : []),
      ...(Array.isArray(mismatch) ? mismatch.map((item) => `금액 또는 항목 불일치: ${item}`) : []),
      ...(!missing.length && !mismatch.length ? ["검증 대상 항목에서 예외 사항이 발견되지 않았습니다."] : [])
    ]
  };
}

function deriveFieldsFromReason(reason) {
  if (!reason) return {};
  const date = reason.match(/교부일\s*(\d{4}-\d{2}-\d{2})/i)?.[1];
  const days = reason.match(/사용기간\s*(\d+\s*일)/i)?.[1];
  const copayment = reason.match(/본인부담금\s*([0-9,]+\s*원)/i)?.[1];
  const total = reason.match(/합계\s*([0-9,]+\s*원)/i)?.[1];
  const paid = reason.match(/수납금액(?:은|:)?\s*([0-9,]+\s*원)/i)?.[1];
  return {
    treatment_period: date && days ? `${date} (${days})` : date || days,
    copayment,
    total_amount: total,
    paid_amount: paid
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
