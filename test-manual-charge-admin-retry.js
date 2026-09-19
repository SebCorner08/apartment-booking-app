const assert = require("assert");
const fs = require("fs");

const admin = fs.readFileSync("public/admin.html", "utf8");
const flowStart = admin.indexOf("// --- MANUAL BILLING ---");
const flowEnd = admin.indexOf("// Handle charge action buttons", flowStart);

assert(
  flowStart !== -1 && flowEnd > flowStart,
  "admin must define the manual-charge flow",
);

const flow = admin.slice(flowStart, flowEnd);

assert(
  flow.includes("createManualChargeRequestId") &&
    flow.includes("window.crypto.randomUUID") &&
    flow.includes("window.crypto.getRandomValues"),
  "manual charges must use a secure UUID v4 request identity",
);
assert(
  flow.includes("request_id: activeManualChargeRequest.requestId"),
  "manual-charge requests must send the retained request identity",
);
assert(
  flow.includes("requestBody.recovery_charge_id") &&
    flow.includes("result.recovery?.charge_id"),
  "manual-charge retries must retain and resend the recovery charge ID",
);
assert(
  flow.includes("MANUAL_CHARGE_RECOVERY_REQUIRED") &&
    flow.includes("MANUAL_CHARGE_MANUAL_RECONCILIATION_REQUIRED"),
  "manual-charge UI must distinguish retryable and manual reconciliation states",
);
assert(
  flow.includes(
    'input.addEventListener("input", clearPendingManualChargeRequest)',
  ) && flow.includes("clearPendingManualChargeRequest();"),
  "manual-charge request identity must clear after field changes and success",
);
assert(
  flow.includes("result.request_id !== activeManualChargeRequest.requestId") &&
    flow.includes(
      "pendingManualChargeRequest === activeManualChargeRequest",
    ),
  "manual-charge success must match the retained request identity",
);

console.log("admin manual-charge retry identity regression check passed");
