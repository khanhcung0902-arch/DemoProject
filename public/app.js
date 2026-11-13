(() => {
  const WORKFLOW_STEPS = [
    "start", "ingest", "validate", "valid_gate", "clean", "clean_gate",
    "process", "verify", "verify_gate", "dashboard", "confirm_gate", "export", "done"
  ];

  const state = {
    currentStep: "start",
    rawSheets: {},
    cleanedData: null,
    cleaningLogs: [],
    analysisResult: null,
    search: "",
    selectedProjectId: null,
    confirmed: false,
    feedbackHistory: []
  };

  const $ = (id) => document.getElementById(id);

  function switchView(viewName) {
    ["dashboard", "ingest", "workflow"].forEach((v) => {
      const el = $("view" + v.charAt(0).toUpperCase() + v.slice(1));
      if (el) el.classList.toggle("hidden", v !== viewName);
    });
    document.querySelectorAll(".nav-icon[data-view]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === viewName);
    });
  }

  function setWorkflowStep(step, note = "", isError = false) {
    state.currentStep = step;
    const idx = WORKFLOW_STEPS.indexOf(step);
    document.querySelectorAll(".wf-chip").forEach((el) => {
      const s = el.dataset.step;
      const sIdx = WORKFLOW_STEPS.indexOf(s);
      el.classList.remove("active", "done", "error");
      if (s === step) el.classList.add(isError ? "error" : "active");
      else if (sIdx >= 0 && sIdx < idx) el.classList.add("done");
    });

    const badge = $("workflowStatusBadge");
    const activeChip = document.querySelector(`.wf-chip[data-step="${step}"]`);
    badge.textContent = `Trạng thái: ${activeChip ? activeChip.textContent : step}`;
    badge.className = `status-pill ${isError ? "error" : ""}`;

    const noteEl = $("workflowBranchNote");
    if (note) {
      noteEl.textContent = note;
      noteEl.classList.remove("hidden");
    } else {
      noteEl.classList.add("hidden");
    }
  }

  function formatVnd(num) {
    return new Intl.NumberFormat("vi-VN").format(Math.round(num || 0)) + " đ";
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // RFC-4180 CSV parser
  function parseCsv(text) {
    const cleanText = text.replace(/^\uFEFF/, "");
    const rows = [];
    let row = [];
    let cell = "";
    let inQuotes = false;

    for (let i = 0; i < cleanText.length; i++) {
      const ch = cleanText[i];
      const next = cleanText[i + 1];
      if (inQuotes) {
        if (ch === '"' && next === '"') { cell += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { cell += ch; }
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ",") { row.push(cell); cell = ""; }
        else if (ch === "\r" && next === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
        else if (ch === "\n" || ch === "\r") { row.push(cell); rows.push(row); row = []; cell = ""; }
        else cell += ch;
      }
    }
    if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
  }

  function normalizeKey(str) {
    return String(str || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  function identifyDatasetRole(name, headers) {
    const n = normalizeKey(name);
    const h = headers.map(normalizeKey).join("|");
    if (n.includes("yeucau") || n.includes("rfq") || h.includes("mahoso")) return "rfq";
    if (n.includes("danhmuc") || n.includes("catalog") || h.includes("dactinhkythuat")) return "catalog";
    if (n.includes("dongia") || n.includes("pricing") || h.includes("dongiavnd")) return "pricing";
    if (n.includes("nangluc") || n.includes("capacity") || h.includes("manhom")) return "capacity";
    if (n.includes("chinhsach") || n.includes("policy") || h.includes("machinhsach")) return "policy";
    return null;
  }

  function rowsToObjects(rows) {
    if (!rows || rows.length < 2) return [];
    const headers = rows[0].map((h) => String(h || "").trim());
    const list = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.every((v) => String(v || "").trim() === "")) continue;
      const obj = { _rowNum: i + 1 };
      headers.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? String(r[idx]).trim() : ""; });
      list.push(obj);
    }
    return list;
  }

  const SCHEMA = {
    rfq: {
      label: "Yêu cầu khách hàng",
      requiredCols: ["MaHoSo", "KhachHang", "DieuKienBatBuoc", "HanTrienKhai", "NganSachVND", "ChietKhauYeuCauPct"],
      numericCols: ["NganSachVND", "ChietKhauYeuCauPct"],
      dateCols: ["HanTrienKhai"]
    },
    catalog: {
      label: "Danh mục giải pháp",
      requiredCols: ["MaGiaiPhap", "TenGiaiPhap", "Nhom", "DacTinhKyThuat", "SLAThoaiThuan", "ThoiGianCungUngNgay", "TrongDanhMuc"],
      numericCols: ["ThoiGianCungUngNgay"]
    },
    pricing: {
      label: "Đơn giá",
      requiredCols: ["MaGiaiPhap", "DonGiaVND", "PhiTrienKhaiVND", "PhiBaoTriNamVND"],
      numericCols: ["DonGiaVND", "PhiTrienKhaiVND", "PhiBaoTriNamVND"]
    },
    capacity: {
      label: "Năng lực triển khai",
      requiredCols: ["MaNhom", "TenNhomTrienKhai", "NhomGiaiPhapPhuTrach", "NgayBatDauKhaDung", "SoDuAnDongThoiToiDa", "SoDuAnDangChay"],
      numericCols: ["SoDuAnDongThoiToiDa", "SoDuAnDangChay"],
      dateCols: ["NgayBatDauKhaDung"]
    },
    policy: {
      label: "Chính sách chiết khấu",
      requiredCols: ["MaChinhSach", "LoaiDieuKien", "NguongGiaTri", "CapDuyet"],
      numericCols: ["NguongGiaTri"]
    }
  };

  function parseNumberSafe(val) {
    if (typeof val === "number") return val;
    const s = String(val || "").trim().replace(/[,\s]/g, "").replace(/đ|vnd/gi, "");
    if (s === "" || isNaN(Number(s))) return NaN;
    return Number(s);
  }

  function parseDateSafe(val) {
    const s = String(val || "").trim();
    if (!s) return null;
    if (/^\d{5}$/.test(s)) {
      const epoch = new Date(Date.UTC(1899, 11, 30));
      const d = new Date(epoch.getTime() + Number(s) * 86400000);
      return isNaN(d.getTime()) ? null : d;
    }
    const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dmy) {
      const d = new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
      return isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function formatDateIso(d) {
    if (!d) return "";
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function runValidationAndCleaning(sheetsMap) {
    state.confirmed = false;
    $("btnExportHtml").disabled = true;
    $("btnExportDocx").disabled = true;
    setWorkflowStep("validate");

    const errors = [];
    const mapped = {};

    Object.entries(sheetsMap).forEach(([sheetName, rows]) => {
      if (!rows || rows.length < 2) {
        errors.push(`Sheet/File "${sheetName}" không có dữ liệu.`);
        return;
      }
      const headers = rows[0].map((h) => String(h || "").trim());
      const role = identifyDatasetRole(sheetName, headers);
      if (!role) {
        errors.push(`Không nhận diện được loại dữ liệu của "${sheetName}".`);
        return;
      }
      mapped[role] = { sheetName, headers, rows };
    });

    Object.keys(SCHEMA).forEach((role) => {
      if (!mapped[role]) {
        errors.push(`Thiếu bảng dữ liệu bắt buộc: "${SCHEMA[role].label}" (${role}).`);
      } else {
        const { sheetName, headers, rows } = mapped[role];
        const normHeaders = headers.map(normalizeKey);
        SCHEMA[role].requiredCols.forEach((col) => {
          if (!normHeaders.includes(normalizeKey(col))) {
            errors.push(`[${sheetName}] Thiếu cột bắt buộc "${col}".`);
          }
        });
        const objs = rowsToObjects(rows);
        objs.forEach((obj) => {
          (SCHEMA[role].numericCols || []).forEach((col) => {
            const actualKey = Object.keys(obj).find((k) => normalizeKey(k) === normalizeKey(col));
            if (actualKey && obj[actualKey] !== "" && isNaN(parseNumberSafe(obj[actualKey]))) {
              errors.push(`[${sheetName}] Dòng ${obj._rowNum}, cột "${actualKey}": "${obj[actualKey]}" không phải số hợp lệ.`);
            }
          });
          (SCHEMA[role].dateCols || []).forEach((col) => {
            const actualKey = Object.keys(obj).find((k) => normalizeKey(k) === normalizeKey(col));
            if (actualKey && !parseDateSafe(obj[actualKey])) {
              errors.push(`[${sheetName}] Dòng ${obj._rowNum}, cột "${actualKey}": ngày "${obj[actualKey]}" không hợp lệ.`);
            }
          });
        });
      }
    });

    const valBox = $("validationResultBox");
    if (errors.length > 0) {
      setWorkflowStep("valid_gate", "Đầu vào hợp lệ? → KHÔNG → Báo lỗi cụ thể và yêu cầu gửi lại file.", true);
      switchView("ingest");
      valBox.innerHTML = `<div class="alert alert-danger"><strong>Phát hiện ${errors.length} lỗi:</strong><ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul></div>`;
      return;
    }

    setWorkflowStep("clean", "Đầu vào hợp lệ? → CÓ → Làm sạch dữ liệu.");
    valBox.innerHTML = `<div class="alert alert-success">Cấu trúc 5 bảng dữ liệu, cột bắt buộc và kiểu dữ liệu hợp lệ.</div>`;

    const logs = [];
    const cleaned = {};
    Object.keys(SCHEMA).forEach((role) => {
      const rawObjs = rowsToObjects(mapped[role].rows);
      const seenIds = new Set();
      const idCol = SCHEMA[role].requiredCols[0];
      const out = [];
      rawObjs.forEach((obj) => {
        const item = {};
        Object.keys(obj).forEach((k) => {
          if (k === "_rowNum") return;
          item[k] = typeof obj[k] === "string" ? obj[k].replace(/\s+/g, " ").trim() : obj[k];
        });
        (SCHEMA[role].numericCols || []).forEach((col) => {
          const k = Object.keys(item).find((x) => normalizeKey(x) === normalizeKey(col));
          if (k) { const n = parseNumberSafe(item[k]); item[col] = isNaN(n) ? 0 : n; }
        });
        (SCHEMA[role].dateCols || []).forEach((col) => {
          const k = Object.keys(item).find((x) => normalizeKey(x) === normalizeKey(col));
          if (k) { const d = parseDateSafe(item[k]); item[col] = d ? formatDateIso(d) : ""; }
        });
        const idVal = item[idCol];
        if (!idVal || seenIds.has(idVal)) return;
        seenIds.add(idVal);
        out.push(item);
      });
      cleaned[role] = out;
      logs.push(`${SCHEMA[role].label}: ${out.length} bản ghi sạch.`);
    });

    state.cleanedData = cleaned;
    state.cleaningLogs = logs;
    $("cleaningResultBox").innerHTML = `<div class="alert alert-info"><strong>Làm sạch dữ liệu (Dữ liệu sạch & ổn: RỒI):</strong><ul>${logs.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul></div>`;

    setWorkflowStep("clean_gate");
    runProcessAndVerify();
    switchView("dashboard");
  }

  function runProcessAndVerify() {
    if (!state.cleanedData) return;
    setWorkflowStep("process");

    const { rfq, catalog, pricing, capacity, policy } = state.cleanedData;
    const bufferDays = Number($("paramBufferDays").value || 0);
    const catalogMap = new Map(catalog.map((c) => [c.MaGiaiPhap, c]));
    const pricingMap = new Map(pricing.map((p) => [p.MaGiaiPhap, p]));

    const stdMaxDisc = policy.find((p) => normalizeKey(p.LoaiDieuKien).includes("chuan"))?.NguongGiaTri ?? 10;
    const mgrMaxDisc = policy.find((p) => normalizeKey(p.LoaiDieuKien).includes("truongphong"))?.NguongGiaTri ?? 18;
    const budgetTolPct = policy.find((p) => normalizeKey(p.LoaiDieuKien).includes("ngansach"))?.NguongGiaTri ?? 5;
    const today = new Date();

    const projects = rfq.map((r) => {
      const flags = [];
      const matchedItems = [];
      let subtotal = 0;
      let maxLeadDays = 0;
      const requiredGroups = new Set();

      const itemTokens = String(r.HangMucYeuCau || "").split(";").map((s) => s.trim()).filter(Boolean);
      itemTokens.forEach((tok) => {
        const [codeRaw, qtyRaw] = tok.split(":");
        const code = (codeRaw || "").trim();
        const qty = Math.max(1, parseInt(qtyRaw || "1", 10) || 1);
        const sol = catalogMap.get(code);
        const price = pricingMap.get(code);

        if (!sol) {
          flags.push({ severity: "HIGH", type: "OUT_OF_CATALOG", title: "Ngoài danh mục", detail: `Mã "${code}" chưa có trong danh mục.` });
          return;
        }
        if (normalizeKey(sol.TrongDanhMuc) !== "co") {
          flags.push({ severity: "HIGH", type: "OUT_OF_CATALOG", title: "Ngoài danh mục chuẩn", detail: `"${sol.TenGiaiPhap}" cần duyệt riêng.` });
        }
        requiredGroups.add(sol.Nhom);
        const lead = Number(sol.ThoiGianCungUngNgay || 0);
        if (lead > maxLeadDays) maxLeadDays = lead;

        let maintYears = 1;
        const mMatch = String(r.YeuCauBaoTri || "").match(/(\d+)\s*th[aá]ng/i);
        if (mMatch) maintYears = Math.max(1, Math.round(Number(mMatch[1]) / 12));

        const lineTotal = ((price ? Number(price.DonGiaVND || 0) : 0) + (price ? Number(price.PhiTrienKhaiVND || 0) : 0) + (price ? Number(price.PhiBaoTriNamVND || 0) * maintYears : 0)) * qty;
        subtotal += lineTotal;
        matchedItems.push({
          solutionId: code, name: sol.TenGiaiPhap, group: sol.Nhom, qty,
          specs: sol.DacTinhKyThuat, sla: sol.SLAThoaiThuan, leadDays: lead,
          lineTotal, lineTotalFormatted: formatVnd(lineTotal),
          fitNote: `SLA ${sol.SLAThoaiThuan} | ${lead} ngày`
        });
      });

      const mandatoryList = String(r.DieuKienBatBuoc || "").split(";").map((s) => s.trim()).filter(Boolean);
      const combinedSpecs = normalizeKey(matchedItems.map((i) => `${i.specs} ${i.sla} ${i.name}`).join(" "));
      const mandatoryResults = mandatoryList.map((cond) => {
        const keywords = cond.split(/[\s,\/]+/).map(normalizeKey).filter((w) => w.length >= 3 && !["toi", "thieu", "trong", "hoac", "bao", "tri"].includes(w));
        const matchedCount = keywords.filter((kw) => combinedSpecs.includes(kw)).length;
        const passed = keywords.length === 0 ? true : matchedCount >= Math.ceil(keywords.length * 0.5);
        if (!passed) flags.push({ severity: "HIGH", type: "MANDATORY_GAP", title: "Thiếu điều kiện bắt buộc", detail: `Chưa xác nhận "${cond}".` });
        return { condition: cond, passed };
      });

      if (normalizeKey(r.YeuCauBaoTri + " " + r.DieuKienBatBuoc).includes("247") && matchedItems.some((i) => i.sla === "8x5")) {
        flags.push({ severity: "MEDIUM", type: "SLA_MISMATCH", title: "Cảnh báo gói giá thấp thiếu SLA 24/7", detail: "Có hạng mục chỉ hỗ trợ 8x5." });
      }

      const deadlineDate = parseDateSafe(r.HanTrienKhai);
      const daysUntilDeadline = deadlineDate ? Math.ceil((deadlineDate - today) / 86400000) : 0;
      let teamBuffer = 0;
      let capacityIssue = null;
      requiredGroups.forEach((grp) => {
        const team = capacity.find((t) => normalizeKey(t.NhomGiaiPhapPhuTrach).includes(normalizeKey(grp)));
        if (team) {
          const buf = Number(team.ThoiGianDemNgay || 0);
          if (buf > teamBuffer) teamBuffer = buf;
          if (Number(team.SoDuAnDangChay) >= Number(team.SoDuAnDongThoiToiDa)) capacityIssue = `${team.TenNhomTrienKhai} đầy tải.`;
          const availStart = parseDateSafe(team.NgayBatDauKhaDung);
          if (availStart && deadlineDate && availStart > deadlineDate) capacityIssue = `${team.TenNhomTrienKhaDung} khả dụng từ ${team.NgayBatDauKhaDung}.`;
        }
      });

      const totalNeededDays = maxLeadDays + teamBuffer + bufferDays;
      const scheduleFeasible = daysUntilDeadline >= totalNeededDays && !capacityIssue;
      if (!scheduleFeasible) {
        flags.push({ severity: "HIGH", type: "SCHEDULE_CONFLICT", title: "Lịch triển khai không khả thi", detail: `${capacityIssue || ""} Cần ${totalNeededDays}d, còn ${daysUntilDeadline}d.` });
      }

      const discPct = Number(r.ChietKhauYeuCauPct || 0);
      const quoteTotal = subtotal * (1 - discPct / 100);
      const budget = Number(r.NganSachVND || 0);
      const overBudgetPct = budget > 0 ? ((quoteTotal - budget) / budget) * 100 : 0;
      if (overBudgetPct > budgetTolPct) {
        flags.push({ severity: "MEDIUM", type: "OVER_BUDGET", title: "Vượt ngân sách", detail: `Vượt ${overBudgetPct.toFixed(1)}% so với ngân sách.` });
      }

      let approvalLevel = "Nhân viên Kinh doanh";
      if (discPct > mgrMaxDisc) {
        approvalLevel = "Ban Giám đốc";
        flags.push({ severity: "HIGH", type: "DISCOUNT_ESCALATION", title: `Chiết khấu ${discPct}% (> ${mgrMaxDisc}%)`, detail: "Cần Ban Giám đốc duyệt." });
      } else if (discPct > stdMaxDisc) {
        approvalLevel = "Trưởng phòng Kinh doanh";
        flags.push({ severity: "MEDIUM", type: "DISCOUNT_ESCALATION", title: `Chiết khấu ${discPct}% (> ${stdMaxDisc}%)`, detail: "Cần Trưởng phòng KD duyệt." });
      }

      const hasApprovalFlag = flags.some((f) => f.type === "OUT_OF_CATALOG" || f.type === "DISCOUNT_ESCALATION");
      const hasVerifyFlag = flags.some((f) => f.type === "MANDATORY_GAP" || f.type === "SCHEDULE_CONFLICT" || f.type === "SLA_MISMATCH" || f.type === "OVER_BUDGET");

      let status = "READY";
      let statusLabel = "Đủ điều kiện chào giá";
      let primaryAction = "Có thể chuẩn bị bản chào giá ngay.";
      if (hasApprovalFlag) {
        status = "APPROVAL";
        statusLabel = hasVerifyFlag ? "Xác minh & Chuyển duyệt" : "Cần chuyển duyệt";
        primaryAction = `Chuyển duyệt (${approvalLevel}).`;
      } else if (hasVerifyFlag) {
        status = "VERIFY";
        statusLabel = "Cần xác minh trước";
        primaryAction = "Xác minh Kỹ thuật / Vận hành trước.";
      }

      const recommendation = status === "READY"
        ? `Đủ điều kiện lập báo giá chính thức (${formatVnd(quoteTotal)}, CK ${discPct}%).`
        : `Tạm dừng chào giá: ${flags.map((f) => f.title).join("; ")}. ${primaryAction}`;

      return {
        id: r.MaHoSo, customer: r.KhachHang, description: r.MoTaYeuCau,
        deadline: r.HanTrienKhai, daysUntilDeadline, totalNeededDays, scheduleFeasible,
        slaRequirement: r.YeuCauBaoTri, budget, budgetFormatted: formatVnd(budget),
        subtotal, quoteTotal, quoteFormatted: formatVnd(quoteTotal),
        requestedDiscount: discPct, approvalLevel, status, statusLabel,
        primaryAction, recommendation, mandatoryResults, matchedItems, flags
      };
    });

    setWorkflowStep("verify");
    const verifyChecks = [
      `Đã kiểm tra ${projects.length} hồ sơ với ${catalog.length} giải pháp và ${policy.length} chính sách.`,
      `Hồ sơ đủ điều kiện chào giá: ${projects.filter((p) => p.status === "READY").length}.`,
      `Hồ sơ cần xác minh / chuyển duyệt: ${projects.filter((p) => p.status !== "READY").length}.`
    ];
    $("verifySummaryBox").innerHTML = `<div class="alert alert-success"><strong>Kết quả Verify:</strong><ul>${verifyChecks.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul></div>`;

    const summary = {
      totalProjects: projects.length,
      readyCount: projects.filter((p) => p.status === "READY").length,
      verifyCount: projects.filter((p) => p.status === "VERIFY").length,
      approvalCount: projects.filter((p) => p.status === "APPROVAL").length,
      totalEstimatedValue: projects.reduce((a, p) => a + p.quoteTotal, 0),
      totalEstimatedValueFormatted: formatVnd(projects.reduce((a, p) => a + p.quoteTotal, 0))
    };

    state.analysisResult = { summary, projects, verifyChecks };
    if (!state.selectedProjectId || !projects.some((p) => p.id === state.selectedProjectId)) {
      state.selectedProjectId = projects[0]?.id || null;
    }

    $("bellDot").classList.toggle("hidden", projects.every((p) => p.status === "READY"));
    $("btnConfirmResult").disabled = false;

    setWorkflowStep("dashboard", "Kết quả Verify đạt yêu cầu → Đã lập báo cáo & tạo dashboard.");
    renderThreeColumnDashboard();
  }

  function renderThreeColumnDashboard() {
    if (!state.analysisResult) return;
    const { projects } = state.analysisResult;
    const q = state.search.toLowerCase();
    const filtered = projects.filter((p) => !q || `${p.id} ${p.customer} ${p.statusLabel}`.toLowerCase().includes(q));

    // Left column: RFQ cards
    $("rfqListContainer").innerHTML = filtered.map((p) => {
      const isActive = p.id === state.selectedProjectId;
      const dotColor = p.status === "READY" ? "#10b981" : p.status === "VERIFY" ? "#f59e0b" : "#ef4444";
      return `
        <div class="rfq-item ${isActive ? "active" : ""}" data-id="${escapeHtml(p.id)}">
          <div class="rfq-icon">${escapeHtml(p.id.replace("HS-", ""))}</div>
          <div class="rfq-meta">
            <div class="rfq-name">${escapeHtml(p.customer)}</div>
            <div class="rfq-sub">${escapeHtml(p.id)} · ${p.quoteFormatted}</div>
          </div>
          <span class="rfq-status-dot" style="background:${isActive ? "#fff" : dotColor}"></span>
        </div>
      `;
    }).join("") || `<div class="empty-state">Không tìm thấy hồ sơ phù hợp.</div>`;

    document.querySelectorAll(".rfq-item").forEach((el) => {
      el.addEventListener("click", () => {
        state.selectedProjectId = el.dataset.id;
        renderThreeColumnDashboard();
      });
    });

    const selected = projects.find((p) => p.id === state.selectedProjectId) || projects[0];
    if (selected) {
      $("overviewBadge").textContent = selected.id.replace("HS-", "");
      $("overviewQuoteValue").textContent = selected.quoteFormatted;
      $("overviewBudgetSub").textContent = `Ngân sách: ${selected.budgetFormatted}`;
      $("overviewStatusText").textContent = `${selected.customer} · ${selected.statusLabel} · CK ${selected.requestedDiscount}%`;
      renderRightDetail(selected);
    }

    renderAreaChart(projects);
    renderCenterLists(projects);
  }

  function renderAreaChart(projects) {
    const container = $("areaChartContainer");
    if (!projects.length) { container.innerHTML = ""; return; }
    const w = 340, h = 115, pad = 8;
    const vals = projects.map((p) => p.quoteTotal / 1e6);
    const maxV = Math.max(1, ...vals);
    const stepX = projects.length > 1 ? (w - pad * 2) / (projects.length - 1) : 0;

    const pts = vals.map((v, i) => {
      const x = projects.length === 1 ? w / 2 : pad + i * stepX;
      const y = h - pad - ((v / maxV) * (h - pad * 2));
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    const areaPts = `${pad},${h - pad} ${pts.join(" ")} ${projects.length === 1 ? w / 2 : w - pad},${h - pad}`;
    container.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" width="100%" height="100%" preserveAspectRatio="none">
        <defs>
          <linearGradient id="emeraldArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#10b981" stop-opacity="0.45"/>
            <stop offset="100%" stop-color="#10b981" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        <polygon points="${areaPts}" fill="url(#emeraldArea)" />
        <polyline points="${pts.join(" ")}" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  }

  function renderCenterLists(projects) {
    const pending = projects.filter((p) => p.status !== "READY");
    const ready = projects.filter((p) => p.status === "READY");
    $("pendingCount").textContent = pending.length;
    $("completedCount").textContent = ready.length;

    const renderRow = (p, isPending) => {
      const isActive = p.id === state.selectedProjectId;
      const subClass = p.status === "APPROVAL" ? "danger" : isPending ? "warn" : "";
      return `
        <div class="tx-row ${isActive ? "active" : ""}" data-id="${escapeHtml(p.id)}">
          <div class="tx-left">
            <div class="tx-arrow">${isPending ? "!" : "✓"}</div>
            <div>
              <div class="tx-title">${escapeHtml(p.id)} · ${escapeHtml(p.customer)}</div>
              <div class="tx-sub ${subClass}">${escapeHtml(p.statusLabel)} — ${escapeHtml(p.primaryAction)}</div>
            </div>
          </div>
          <div class="tx-right">
            <div class="tx-amount">${p.quoteFormatted}</div>
            <div class="tx-delta">NS: ${p.budgetFormatted}</div>
          </div>
        </div>
      `;
    };

    $("pendingList").innerHTML = pending.map((p) => renderRow(p, true)).join("") || `<p class="muted-text">Không có hồ sơ cần xác minh/chuyển duyệt.</p>`;
    $("completedList").innerHTML = ready.map((p) => renderRow(p, false)).join("") || `<p class="muted-text">Chưa có hồ sơ đạt chuẩn ngay.</p>`;

    document.querySelectorAll(".tx-row").forEach((row) => {
      row.addEventListener("click", () => {
        state.selectedProjectId = row.dataset.id;
        renderThreeColumnDashboard();
      });
    });
  }

  function renderRightDetail(p) {
    const mandOk = p.mandatoryResults.filter((m) => m.passed).length;
    const mandTotal = p.mandatoryResults.length;
    $("rightDetailContent").innerHTML = `
      <div class="detail-kv"><div class="lbl">Mã hồ sơ &amp; Khách hàng</div><div class="val mono">${escapeHtml(p.id)} · ${escapeHtml(p.customer)}</div></div>
      <div class="detail-kv"><div class="lbl">Trạng thái quyết định</div><div class="val">${escapeHtml(p.statusLabel)}</div></div>
      <div class="detail-kv"><div class="lbl">Hạn triển khai / Năng lực</div><div class="val">${escapeHtml(p.deadline)} (${p.scheduleFeasible ? "Khả thi" : "Xung đột"}: còn ${p.daysUntilDeadline}d / cần ${p.totalNeededDays}d)</div></div>
      <div class="detail-kv"><div class="lbl">Chiết khấu &amp; Cấp duyệt</div><div class="val">${p.requestedDiscount}% → ${escapeHtml(p.approvalLevel)}</div></div>
      <div class="detail-kv"><div class="lbl">Đề xuất kinh doanh</div><div class="val">${escapeHtml(p.recommendation)}</div></div>
      <div class="detail-kv"><div class="lbl">Hạng mục giải pháp (${p.matchedItems.length})</div><div class="val">${p.matchedItems.map((i) => `${escapeHtml(i.solutionId)} (x${i.qty})`).join(", ") || "Chưa có"}</div></div>

      <div class="timeline">
        <div class="tl-item"><div class="tl-dot done"></div><div class="tl-text"><strong>Kiểm tra &amp; Làm sạch dữ liệu</strong>Đã chuẩn hóa 5 bảng đầu vào</div></div>
        <div class="tl-item"><div class="tl-dot ${mandOk === mandTotal ? "done" : "warn"}"></div><div class="tl-text"><strong>Điều kiện bắt buộc (${mandOk}/${mandTotal})</strong>${p.mandatoryResults.map((m) => `${m.passed ? "✓" : "✗"} ${escapeHtml(m.condition)}`).join("<br>")}</div></div>
        <div class="tl-item"><div class="tl-dot ${p.flags.length === 0 ? "done" : "warn"}"></div><div class="tl-text"><strong>Verify Chính sách &amp; Lịch</strong>${p.flags.length ? p.flags.map((f) => escapeHtml(f.title)).join("; ") : "Không có rủi ro"}</div></div>
        <div class="tl-item"><div class="tl-dot ${state.confirmed ? "done" : ""}"></div><div class="tl-text"><strong>Chốt kết quả &amp; Xuất báo cáo</strong>${state.confirmed ? "Đã chốt · Sẵn sàng HTML / DOCX" : "Chờ bấm Chốt kết quả"}</div></div>
      </div>
    `;
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setWorkflowStep("ingest");
    $("selectedFilesList").innerHTML = files.map((f) => `<span class="file-chip">${escapeHtml(f.name)}</span>`).join("");

    const sheetsMap = {};
    for (const file of files) {
      const ext = file.name.split(".").pop().toLowerCase();
      if (ext === "csv") {
        sheetsMap[file.name] = parseCsv(await file.text());
      } else if (ext === "xlsx") {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const resp = await fetch("/api/parse-xlsx", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base64: btoa(binary) }) });
        const data = await resp.json();
        if (!data.ok) { alert("Lỗi đọc Excel: " + data.error); return; }
        data.sheets.forEach((s) => { sheetsMap[s.name] = s.rows; });
      } else {
        setWorkflowStep("valid_gate", `File "${file.name}" không phải .xlsx hoặc .csv.`, true);
        return;
      }
    }
    state.rawSheets = sheetsMap;
    runValidationAndCleaning(sheetsMap);
  }

  async function handleGoogleSheet() {
    const url = $("gsheetUrl").value.trim();
    if (!url) return alert("Vui lòng nhập link Google Sheets.");
    setWorkflowStep("ingest");
    const resp = await fetch("/api/fetch-gsheet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
    const data = await resp.json();
    if (!data.ok) {
      setWorkflowStep("valid_gate", data.error || "Không thể tải Google Sheets.", true);
      return;
    }
    const sheetsMap = {};
    data.sheets.forEach((s) => { sheetsMap[s.name] = s.rows; });
    state.rawSheets = sheetsMap;
    runValidationAndCleaning(sheetsMap);
  }

  async function loadSampleData() {
    setWorkflowStep("ingest");
    const sampleFiles = ["1_YeuCauKhachHang.csv", "2_DanhMucGiaiPhap.csv", "3_DonGia.csv", "4_NangLucTrienKhai.csv", "5_ChinhSachChietKhau.csv"];
    $("selectedFilesList").innerHTML = sampleFiles.map((f) => `<span class="file-chip">${f}</span>`).join("");
    const sheetsMap = {};
    for (const f of sampleFiles) {
      const resp = await fetch("/" + f);
      sheetsMap[f] = parseCsv(await resp.text());
    }
    state.rawSheets = sheetsMap;
    runValidationAndCleaning(sheetsMap);
  }

  function exportHtmlReport() {
    if (!state.analysisResult) return;
    setWorkflowStep("export");
    const { summary, projects } = state.analysisResult;
    const html = `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Báo cáo Chào giá Thiên Minh</title>
    <style>body{font-family:Segoe UI,sans-serif;max-width:1100px;margin:30px auto;padding:0 20px;color:#1e293b}
    table{width:100%;border-collapse:collapse;margin:16px 0}th,td{border:1px solid #cbd5e1;padding:8px 10px;text-align:left;font-size:13px}
    th{background:#0c8c5e;color:#fff}</style></head>
    <body><h1>BÁO CÁO PHÂN TÍCH HỒ SƠ CHÀO GIÁ - THIÊN MINH</h1>
    <p>Tổng hồ sơ: <b>${summary.totalProjects}</b> | Đủ ĐK: <b>${summary.readyCount}</b> | Cần xác minh: <b>${summary.verifyCount}</b> | Cần chuyển duyệt: <b>${summary.approvalCount}</b></p>
    <table><thead><tr><th>Mã HS</th><th>Khách hàng</th><th>Trạng thái</th><th>Ngân sách</th><th>Giá đề xuất</th><th>Đề xuất</th></tr></thead>
    <tbody>${projects.map((p) => `<tr><td>${escapeHtml(p.id)}</td><td>${escapeHtml(p.customer)}</td><td>${escapeHtml(p.statusLabel)}</td><td>${p.budgetFormatted}</td><td>${p.quoteFormatted}</td><td>${escapeHtml(p.recommendation)}</td></tr>`).join("")}</tbody></table></body></html>`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    a.download = "BaoCao_ChaoGia_ThienMinh.html";
    a.click();
    setWorkflowStep("done", "Đã xuất file HTML thành công. Quy trình Hoàn tất!");
  }

  async function exportDocxReport() {
    if (!state.analysisResult) return;
    setWorkflowStep("export");
    const resp = await fetch("/api/export-docx", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.analysisResult) });
    if (!resp.ok) return alert("Lỗi tạo file DOCX.");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await resp.blob());
    a.download = "BaoCao_ChaoGia_ThienMinh.docx";
    a.click();
    setWorkflowStep("done", "Đã tải về báo cáo DOCX thành công. Quy trình Hoàn tất!");
  }

  function confirmResults() {
    if (!state.analysisResult) return;
    state.confirmed = true;
    $("btnExportHtml").disabled = false;
    $("btnExportDocx").disabled = false;
    setWorkflowStep("confirm_gate", "Chốt kết quả? → RỒI → Đã mở khóa Xuất HTML & Tải DOCX.");
    renderThreeColumnDashboard();
  }

  // Bindings
  document.querySelectorAll(".nav-icon[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
  $("btnOpenIngestModal").addEventListener("click", () => switchView("ingest"));
  $("btnOpenUploadTop").addEventListener("click", () => switchView("ingest"));
  $("btnBackToDashFromIngest").addEventListener("click", () => switchView("dashboard"));
  $("btnBackToDashFromWf").addEventListener("click", () => switchView("dashboard"));

  $("btnLoadSampleTop").addEventListener("click", loadSampleData);
  $("btnEmptySample").addEventListener("click", loadSampleData);
  $("btnSidebarSample").addEventListener("click", loadSampleData);

  $("btnPickFiles").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", (e) => handleFiles(e.target.files));
  $("btnFetchGsheet").addEventListener("click", handleGoogleSheet);

  const dz = $("dropzone");
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("dragover"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
  dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("dragover"); handleFiles(e.dataTransfer.files); });

  $("btnToggleFeedback").addEventListener("click", () => $("feedbackPanel").classList.toggle("hidden"));
  $("btnFeedbackRerun").addEventListener("click", () => {
    const fb = $("feedbackText").value.trim();
    if (fb) state.feedbackHistory.push(fb);
    setWorkflowStep("process", `Feedback cho Process${fb ? `: "${fb}"` : ""} → Chạy lại.`);
    runProcessAndVerify();
  });

  $("btnConfirmResult").addEventListener("click", confirmResults);
  $("btnSidebarConfirm").addEventListener("click", confirmResults);
  $("btnExportHtml").addEventListener("click", exportHtmlReport);
  $("btnSidebarHtml").addEventListener("click", () => { if (state.confirmed) exportHtmlReport(); else alert("Vui lòng bấm 'Chốt kết quả' trước khi xuất."); });
  $("btnExportDocx").addEventListener("click", exportDocxReport);
  $("btnSidebarDocx").addEventListener("click", () => { if (state.confirmed) exportDocxReport(); else alert("Vui lòng bấm 'Chốt kết quả' trước khi tải DOCX."); });

  const onSearch = (e) => { state.search = e.target.value; renderThreeColumnDashboard(); };
  $("globalSearchInput").addEventListener("input", onSearch);
  $("leftSearchInput").addEventListener("input", onSearch);

  const landingPage = $("landingPage");
  const appShell = $("appShell");
  if ($("btnStartEvaluation") && landingPage && appShell) {
    $("btnStartEvaluation").addEventListener("click", () => {
      landingPage.classList.add("landing-exit");
      setTimeout(() => {
        landingPage.classList.add("hidden");
        appShell.classList.remove("hidden");
      }, 360);
    });
  }

  setWorkflowStep("start");
  // Auto-load sample data on initial open so the 3-column dashboard is immediately populated
  loadSampleData();
})();
