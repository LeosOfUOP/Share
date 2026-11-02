/**
 * Admin/script.js
 */

// ---------------------------------------------------------------------------
// Session helpers — fallback if Auth.js fails to load
// ---------------------------------------------------------------------------

// ── Session bootstrap (moved from Admin.html inline script) ──────────────
(function () {
  var raw = sessionStorage.getItem("auth");
  if (!raw) return;
  var session;
  try { session = JSON.parse(raw); } catch (e) { return; }

  var isOwner = session.role === "owner";

  var badge = document.getElementById("adminUserBadge");
  if (badge) badge.textContent = (session.name || "Admin") + " (" + session.role + ")";

  var logoutBtn = document.getElementById("adminLogoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", function () {
    sessionStorage.removeItem("auth");
    window.location.href = "../User/Submit.html";
  });

  var ownerPanel = document.getElementById("ownerToolsPanel");
  if (ownerPanel && isOwner) {
    ownerPanel.style.display = "block";

    fetch(CONFIG.SCRIPT_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "getWhitelist", token: session.token }) })
      .then(function (r) { return r.json(); }).then(function (d) {
        if (d.success) { var inp = document.getElementById("ownerWhitelistInput"); if (inp) inp.value = (d.whitelist || []).join(","); }
      }).catch(function () {});

    var saveBtn = document.getElementById("ownerSaveWhitelistBtn");
    if (saveBtn) saveBtn.addEventListener("click", function () {
      var inp = document.getElementById("ownerWhitelistInput");
      var phones = (inp ? inp.value : "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      fetch(CONFIG.SCRIPT_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "setWhitelist", token: session.token, whitelist: phones }) })
        .then(function (r) { return r.json(); }).then(function (d) { alert(d.success ? "Whitelist saved!" : ("Error: " + d.error)); });
    });

    fetch(CONFIG.SCRIPT_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "getSheetUrls", token: session.token }) })
      .then(function (r) { return r.json(); }).then(function (d) {
        if (!d.success) return;
        var linksDiv = document.getElementById("ownerSheetLinks");
        if (!linksDiv) return;
        linksDiv.innerHTML = "";
        var icons = { Database: "🗃️", Projects: "📁", Users: "👥", ActivityLog: "📋" };
        Object.entries(d.urls || {}).forEach(function (pair) {
          var a = document.createElement("a");
          a.href = pair[1]; a.target = "_blank";
          a.style.cssText = "color:#b34e1a;font-weight:600;font-size:0.82rem;text-decoration:none;";
          a.textContent = (icons[pair[0]] || "📄") + " " + pair[0];
          linksDiv.appendChild(a);
        });
      }).catch(function () {});

    var pauseBtn   = document.getElementById("ownerPauseSystemBtn");
    var pauseLabel = document.getElementById("pauseBtnLabel");
    fetch(CONFIG.SCRIPT_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "getSystemPaused", token: session.token }) })
      .then(function (r) { return r.json(); }).then(function (d) {
        if (d.paused) { pauseLabel.textContent = "Resume System"; pauseBtn.style.background = "#e8f5e9"; pauseBtn.style.color = "#2e7d32"; pauseBtn.style.borderColor = "#a5d6a7"; }
      }).catch(function () {});

    if (pauseBtn) pauseBtn.addEventListener("click", function () {
      var isPaused = pauseLabel.textContent === "Resume System";
      fetch(CONFIG.SCRIPT_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "setSystemPaused", token: session.token, paused: !isPaused }) })
        .then(function (r) { return r.json(); }).then(function (d) {
          if (d.success) {
            if (!isPaused) { pauseLabel.textContent = "Resume System"; pauseBtn.style.background = "#e8f5e9"; pauseBtn.style.color = "#2e7d32"; pauseBtn.style.borderColor = "#a5d6a7"; alert("System paused. Users will see a maintenance message."); }
            else           { pauseLabel.textContent = "Pause System";  pauseBtn.style.background = "#ffebee"; pauseBtn.style.color = "#c62828"; pauseBtn.style.borderColor = "#ef9a9a"; alert("System resumed."); }
          }
        }).catch(function () { alert("Failed to update system state."); });
    });
  }

  window.__adminSession = session;
  window.__adminIsOwner = isOwner;
})();
// ── End bootstrap ────────────────────────────────────────────────────────────


if (typeof getSession === "undefined") {
  window.getSession   = function() { try { return JSON.parse(sessionStorage.getItem("auth")); } catch(e) { return null; } };
  window.clearSession = function() { sessionStorage.removeItem("auth"); };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const overlay = document.getElementById("loadingOverlay");
let allPosts   = [];
let activePost = null;
let _shareDropdownCloseListener = null;

const WA_ON = false; // WhatsApp features are disabled for now
if (!WA_ON) {
  const st = document.createElement("style");
  st.textContent = `
    #combinedShareModal .wa-label, #csWaList, .csm-manual-label, #csWaManualInput,
    #csWaOnlyBtn, #copyWaBtn, .asn-badge.wa, #whatsappModal,
    a[href="qr.html"], #combinedShareModal hr { display:none !important; }`;
  document.head.appendChild(st);
}

// ---------------------------------------------------------------------------
// Loading overlay
// ---------------------------------------------------------------------------

function showLoading(msg) {
  const t = overlay.querySelector(".loading-text");
  if (t) t.textContent = msg || "Processing…";
  overlay.classList.add("active");
}
function hideLoading() { overlay.classList.remove("active"); }

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function showToast(msg, type = "info") {
  document.querySelectorAll(".admin-toast").forEach(t => t.remove());
  const toast = document.createElement("div");
  toast.className = "admin-toast";
  toast.textContent = msg;
  if      (type === "success") toast.style.background = "#2e7d32";
  else if (type === "error")   toast.style.background = "#c62828";
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), CONFIG.UI.TOAST_DURATION_MS);
}

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------

function formatDateYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toLocalMidnight(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDateDisplay(dateStr) {
  if (!dateStr) return "—";
  return toLocalMidnight(dateStr).toLocaleDateString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric"
  });
}

function isSlotPast(dateStr, slotLabel) {
  if (!dateStr || !slotLabel) return false;
  const match = slotLabel.match(/^(\d+):(\d+)\s*(AM|PM)$/i);
  if (!match) return false;
  let hour = parseInt(match[1]);
  const mins = parseInt(match[2]);
  const period = match[3].toUpperCase();
  if (period === "PM" && hour !== 12) hour += 12;
  if (period === "AM" && hour === 12) hour = 0;
  const slotTime = toLocalMidnight(dateStr);
  slotTime.setHours(hour, mins, 0, 0);
  // 5-minute buffer: slot is considered "past" only 5 min after its start
  return (slotTime.getTime() + 5 * 60 * 1000) < Date.now();
}

// ---------------------------------------------------------------------------
// Text formatting
// req 1: WhatsApp keeps * and _ as-is; social media strips them
// ---------------------------------------------------------------------------

function formatContentPreview(text) {
  if (!text) return "";
  return escapeHTML(text)
    .replace(/\*(.*?)\*/g, "<strong>$1</strong>")
    .replace(/_(.*?)_/g,   "<em>$1</em>");
}

// For WhatsApp: keep original * and _ markup
function getWhatsAppText(text) {
  return text || "";
}

// For social media: strip * and _ so platforms apply their own formatting
function getSocialText(text) {
  if (!text) return "";
  return text.replace(/\*(.*?)\*/g, "$1").replace(/_(.*?)_/g, "$1");
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function renderCurrentDate() {
  const el = document.getElementById("adminCurrentDate");
  if (el) el.textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric"
  });
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tolerant date / slot normalisation (the sheet can return different formats)
// ---------------------------------------------------------------------------
function normalizeDateStr(v) {
  if (!v) return "";
  v = String(v).trim();
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);                 // 2026-11-01 (or with time)
  if (m) return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
  m = v.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);              // 1/11/2026 or 11/1/2026
  if (m) {
    let a = Number(m[1]), b = Number(m[2]);
    const [mo, d] = a > 12 ? [b, a] : [a, b];                          // day-first only if it must be
    return m[3] + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  }
  const t = new Date(v);                                              // e.g. "Sun Nov 01 2026 ..."
  if (!isNaN(t)) return formatDateYMD(t);
  return v;
}

function normalizeSlotStr(v) {
  if (!v) return "";
  const t = String(v).trim();
  let m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
  if (m) return parseInt(m[1], 10) + ":" + m[2] + " " + m[3].toUpperCase();
  m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);                       // 24-hour text e.g. 14:00
  if (m) { const h = parseInt(m[1], 10); return (h % 12 || 12) + ":" + m[2] + " " + (h >= 12 ? "PM" : "AM"); }
  return t;
}

function normalizePosts(data) {
  if (!Array.isArray(data)) {
    console.error("Backend did not return a post list:", data);
    throw new Error((data && data.error) || "Unexpected response from server");
  }
  return data.map(p => Object.assign({}, p, {
    date: normalizeDateStr(p.date),
    timeslot: normalizeSlotStr(p.timeslot)
  }));
}

async function loadSchedule(dateStr) {
  const targetDate = dateStr || formatDateYMD(new Date());
  document.getElementById("scheduleGrid").textContent = "Loading…";
  try {
    const res = await fetch(CONFIG.SCRIPT_URL);
    allPosts  = normalizePosts(await res.json());
    renderScheduleGrid(targetDate, allPosts);
    try { checkManualOverdueReminders(allPosts); } catch (e) { console.error("reminders:", e); }
  } catch (err) {
    document.getElementById("scheduleGrid").innerHTML =
      '<p style="color:red;text-align:center;">Failed to load schedule. Please refresh.</p>';
    console.error("loadSchedule error:", err);
  }
}

async function loadOwnerWhitelist() {
  showLoading();
  try {
    const res = await postToBackend({ action: "getWhitelist" });
    const data = await res.json();
    if (data.success && data.whitelist) {
      document.getElementById("ownerWhitelistInput").value = data.whitelist.join(",");
    }
  } catch(e) { console.error("loadOwnerWhitelist error", e); }
  finally { hideLoading(); }
}

async function saveOwnerWhitelist() {
  const val = document.getElementById("ownerWhitelistInput").value;
  const numbers = val.split(",").map(s => s.trim()).filter(s => s);
  showLoading();
  try {
    const res = await postToBackend({ action: "setWhitelist", whitelist: numbers });
    const data = await res.json();
    if (data.success) showToast("Whitelist saved", "success");
    else showToast(data.error, "error");
  } catch(e) { showToast("Network error", "error"); }
  finally { hideLoading(); }
}

// ---------------------------------------------------------------------------
// Overdue manual post reminders
// ---------------------------------------------------------------------------

function checkManualOverdueReminders(posts) {
  const container = document.getElementById("overdueReminders");
  if (!container) return;
  const now = new Date();
  const overdue = posts.filter(p => {
    if (p.status !== "approved") return false;
    if (String(p.scheduled).toLowerCase() === "true") return false;
    if (!isSlotPast(p.date, p.timeslot)) return false;
    const match = (p.timeslot || "").match(/^(\d+):(\d+)\s*(AM|PM)$/i);
    if (!match) return false;
    let hour = parseInt(match[1]);
    const period = match[3].toUpperCase();
    if (period === "PM" && hour !== 12) hour += 12;
    if (period === "AM" && hour === 12) hour = 0;
    const slotTime = toLocalMidnight(p.date);
    slotTime.setHours(hour, 0, 0, 0);
    return (now - slotTime) < 24 * 60 * 60 * 1000;
  });

  if (!overdue.length) {
    container.innerHTML = "";
    container.style.display = "none";
    return;
  }

  container.style.display = "block";
  container.innerHTML = overdue.map(p => `
    <div class="overdue-reminder">
      <i class="fas fa-exclamation-triangle"></i>
      <span>
        <a class="overdue-post-link" data-row="${p.row}" href="#" style="font-weight:700;color:inherit;text-decoration:underline;">
          ${escapeHTML(p.title || "Untitled")}
        </a>
        — Manual post for ${escapeHTML(p.timeslot)} on ${formatDateDisplay(p.date)} has passed.
        Please share or change the slot.
      </span>
    </div>
  `).join("");

  container.querySelectorAll(".overdue-post-link").forEach(link => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const row  = parseInt(link.dataset.row);
      const post = allPosts.find(p => p.row === row);
      if (post) openPostModal(post);
    });
  });
}

// ---------------------------------------------------------------------------
// Schedule grid
// ---------------------------------------------------------------------------

function statusBadgeHTML(status) {
  const map = {
    approved: { bg: "#e8f5e9", color: "#2e7d32", icon: "fa-check-circle", label: "Approved" },
    rejected: { bg: "#ffebee", color: "#c62828", icon: "fa-times-circle", label: "Rejected" },
    pending:  { bg: "#fff8e1", color: "#f57f17", icon: "fa-clock",        label: "Pending"  }
  };
  const s = map[status] || map.pending;
  return `<span class="status-badge" style="background:${s.bg};color:${s.color};">
            <i class="fas ${s.icon}"></i> ${s.label}
          </span>`;
}

function renderScheduleGrid(dateStr, posts) {
  const grid       = document.getElementById("scheduleGrid");
  const targetTime = toLocalMidnight(dateStr).getTime();
  const todayTime  = toLocalMidnight(formatDateYMD(new Date())).getTime();

  const dayPosts = posts.filter(p => {
    if (!p.date) return false;
    return toLocalMidnight(p.date).getTime() === targetTime;
  });

  grid.innerHTML = "";

  // Hint: posts exist, but none on the selected date -> tell the admin which dates have posts
  let hint = document.getElementById("noPostsHint");
  if (!hint) {
    hint = document.createElement("p");
    hint.id = "noPostsHint";
    hint.style.cssText = "text-align:center;color:#8a6a5a;font-size:0.85rem;margin:0.6rem 0;";
    grid.parentNode.insertBefore(hint, grid);
  }
  const otherDates = [...new Set(posts.filter(p => p.status !== "rejected").map(p => p.date))].filter(Boolean).sort();
  hint.textContent = (!dayPosts.length && otherDates.length)
    ? "No posts on this date. Posts exist on: " + otherDates.slice(0, 8).join(", ") + (otherDates.length > 8 ? " …" : "")
    : "";

  let availableCount = 0, totalSlots = 0;

  for (const [groupName, slots] of Object.entries(CONFIG.SLOT_GROUPS)) {
    const col = document.createElement("div");
    col.className = "time-column";
    const iconMap = { Morning: "fa-sunrise", Afternoon: "fa-sun", Evening: "fa-moon" };
    col.innerHTML = `
      <div class="column-heading">
        <i class="fas ${iconMap[groupName] ?? "fa-clock"}"></i>
        <h2>${groupName}</h2>
      </div>
      <div class="slot-list"></div>
    `;
    const slotList = col.querySelector(".slot-list");

    for (const slotLabel of slots) {
      const slotValue = CONFIG.SLOT_VALUES[slotLabel];
      const post      = dayPosts.find(p => {
        const ts = normalizeSlotStr(p.timeslot);
        return ts === normalizeSlotStr(slotLabel) || ts === normalizeSlotStr(slotValue);
      });
      const slotDiv   = document.createElement("div");
      const isPast    = targetTime === todayTime && isSlotPast(dateStr, slotLabel);

      if (post) {
        const statusClass =
          post.status === "approved" ? "approved-slot" :
          post.status === "rejected" ? "rejected-slot" : "";

        let scheduleDot = "";
        if (post.status === "approved") {
          scheduleDot = (String(post.scheduled).toLowerCase() === "true")
            ? `<span class="schedule-dot scheduled" title="Scheduled"></span>`
            : `<span class="schedule-dot manual" title="Manual"></span>`;
        }

        slotDiv.className = `time-slot ${statusClass}${isPast ? " past-slot" : ""}`;
        slotDiv.innerHTML = `
          <div class="slot-time">
            <i class="fas fa-clock"></i> ${slotLabel}
            ${isPast ? '<span class="past-label">Past</span>' : ""}
          </div>
          <div class="slot-project">
            ${scheduleDot}
            ${post.shared ? '<i class="fas fa-share-alt" title="Published"></i>' : ""}
          </div>
          ${statusBadgeHTML(post.status)}
        `;
        slotDiv.querySelector(".slot-project").appendChild(
          Object.assign(document.createElement("span"), { textContent: post.title || "Untitled" })
        );
        slotDiv.addEventListener("click", () => openPostModal(post));
      } else {
        slotDiv.className = `time-slot empty-slot${isPast ? " past-slot" : ""}`;
        slotDiv.innerHTML = `
          <div class="slot-time">
            <i class="fas fa-clock"></i> ${slotLabel}
            ${isPast ? '<span class="past-label">Past</span>' : ""}
          </div>
          <span style="color:#2e7d32;font-size:0.85rem;font-weight:600;"><i class="fas fa-check-circle"></i> Available</span>
        `;
        availableCount++;
      }
      totalSlots++;

      slotList.appendChild(slotDiv);
    }

    grid.appendChild(col);
  }

  // Summary of free slots for the selected date
  let summary = document.getElementById("slotSummary");
  if (!summary) {
    summary = document.createElement("p");
    summary.id = "slotSummary";
    summary.style.cssText = "text-align:center;color:#2e7d32;font-weight:600;font-size:0.9rem;margin:0.4rem 0;";
    grid.parentNode.insertBefore(summary, grid);
  }
  summary.textContent = availableCount + " of " + totalSlots + " time slots available";
}

// ---------------------------------------------------------------------------
// Post detail modal
// ---------------------------------------------------------------------------

function openPostModal(post) {
  activePost = post;

  const modal    = document.getElementById("postModal");
  const body     = document.getElementById("modalBody");
  const btnGroup = document.getElementById("modalButtonGroup");

  const isPast      = isSlotPast(post.date, post.timeslot);
  const isApproved  = post.status === "approved";
  const isRejected  = post.status === "rejected";
  const isPending   = post.status === "pending";
  const isScheduled = String(post.scheduled).toLowerCase() === "true";

  // req 2: show media preview + auto-share notice when approving
  let mediaHTML;
  if (post.media) {
    const isVideo = /\.(mp4|mov|webm|avi)(\?|$)/i.test(post.media) || post.media.includes("/video/upload/");
    mediaHTML = isVideo
      ? `<video class="media-preview-inner" controls><source src="${escapeAttr(post.media)}"></video>`
      : `<img class="media-preview-inner" src="${escapeAttr(post.media)}" alt="Post media">`;
  } else {
    mediaHTML = `<div class="no-media-placeholder"><i class="fas fa-image fa-2x"></i><span>No media attached</span></div>`;
  }

  const formattedContent = formatContentPreview(post.content || "");

  // req 2: auto-share notice shown for pending posts (before approval)
  const autoShareNotice = false ? `
    <div class="auto-share-notice">
      <i class="fas fa-info-circle"></i>
      <div>
        When you <strong>approve</strong> this post, it will be automatically shared at the scheduled time slot:
        <div class="asn-row">
          <span class="asn-badge sm"><i class="fas fa-globe"></i> Social Media</span>
        </div>
      </div>
    </div>
  ` : "";

  body.innerHTML = `
    <div class="preview-card">
      <div class="preview-header">
        <div class="preview-title" id="modalPostTitle"></div>
        <div style="display:flex;align-items:center;gap:0.7rem;flex-wrap:wrap;">
          ${statusBadgeHTML(post.status)}
          ${isPast && isApproved ? '<span class="past-badge"><i class="fas fa-clock"></i> Time Passed</span>' : ""}
          ${false ? `
            <div class="schedule-toggle-wrap">
              <span class="schedule-toggle-label">Manual</span>
              <label class="schedule-switch">
                <input type="checkbox" id="scheduleToggle" ${isScheduled ? "checked" : ""}>
                <span class="schedule-slider"></span>
              </label>
              <span class="schedule-toggle-label">Scheduled</span>
            </div>
            <div class="schedule-toggle-hint">
              <i class="fas fa-info-circle"></i> 
              <strong>Scheduled</strong> = auto‑published at time slot. 
              <strong>Manual</strong> = you must click "Share" after the slot.
            </div>
          ` : ""}
        </div>
      </div>
      ${autoShareNotice}
      ${isPast && isApproved && !isScheduled ? `
        <div class="overdue-inline-warning">
          <i class="fas fa-exclamation-triangle"></i>
          This post was set to <strong>Manual</strong> and its time slot has passed.
          Please share it now, change the slot, or reject it.
        </div>
      ` : ""}
      <div class="preview-media">${mediaHTML}</div>
      <div class="preview-details-grid">
        <div class="detail-item"><i class="fas fa-user"></i><span id="modalAuthor"></span></div>
        <div class="detail-item"><i class="fas fa-clock"></i><span id="modalTimeslot"></span></div>
        <div class="detail-item"><i class="fas fa-calendar"></i><span id="modalDate"></span></div>
        <div class="detail-item"><i class="fas fa-share-alt"></i><span id="modalShared"></span></div>
        <div class="detail-item"><i class="fas fa-user-check"></i><span>Approved by: ${escapeHTML(post.approvedBy || "\u2014")}</span></div>
        ${post.status === "rejected" && post.rejectedBy ? `<div class="detail-item"><i class="fas fa-user-slash"></i><span>Rejected by: ${escapeHTML(post.rejectedBy)}</span></div>` : ""}
        ${(getSession()?.role === "owner" && post.author) ? `<div class="detail-item"><i class="fab fa-whatsapp"></i><span style="font-size:0.8rem;color:#888;">${escapeHTML(post.author)}</span></div>` : ""}
      </div>
      <div class="preview-content">
        <label><i class="fas fa-align-left"></i> Content</label>
        <div class="preview-content-display">${formattedContent}</div>
        <div class="content-copy-row">
          <span class="copy-hint"><i class="fas fa-info-circle"></i> Copy content here</span>
          <button class="copy-soc-btn" id="copySocialBtn"><i class="fas fa-share-alt"></i> Social Media</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("modalPostTitle").textContent = post.title    || "Untitled";
  document.getElementById("modalAuthor").textContent    = post.author   || "—";
  document.getElementById("modalTimeslot").textContent  = post.timeslot || "—";
  document.getElementById("modalDate").textContent      = formatDateDisplay(post.date);
  document.getElementById("modalShared").textContent    = post.shared
    ? `Published to: ${post.platforms || "unknown"}` : "Not yet published";

  // Social copy strips markup
  document.getElementById("copySocialBtn").addEventListener("click", () => {
    navigator.clipboard.writeText(getSocialText(post.content))
      .then(() => showToast("Copied for social media!", "success"))
      .catch(() => showToast("Copy failed.", "error"));
  });

  // Schedule toggle
  if (isApproved && document.getElementById("scheduleToggle")) {
    document.getElementById("scheduleToggle").addEventListener("change", async (e) => {
      const scheduled = e.target.checked;
      showLoading();
      try {
        const res    = await postToBackend({ action: "setScheduled", row: post.row, scheduled });
        const result = await res.json();
        if (result.success) {
          post.scheduled = scheduled ? "true" : "false";
          showToast(scheduled ? "Set to Scheduled." : "Set to Manual.", "success");
          await loadSchedule(getAdminDate());
          openPostModal(post);
        } else {
          showToast("Error: " + (result.error || "Unknown"), "error");
          e.target.checked = !scheduled;
        }
      } catch (err) {
        showToast("Network error.", "error");
        e.target.checked = !scheduled;
      } finally {
        hideLoading();
      }
    });
  }

  // Build action buttons
  btnGroup.innerHTML = "";

  // PAST + APPROVED + MANUAL mode
  if (isPast && isApproved && !isScheduled) {
    const row1 = document.createElement("div");
    row1.className = "button-row";
    row1.appendChild(makeButton("reject", "fa-times", "Reject", () => updateStatus(post, "rejected")));
    btnGroup.appendChild(row1);

    const row2 = document.createElement("div");
    row2.className = "button-row";
    row2.appendChild(makeButton("edit", "fa-pen", "Edit", () => openEditModal(post)));
    if (CONFIG.FEATURES.ENABLE_MEDIA_DOWNLOAD && post.media) {
      row2.appendChild(makeButton("download", "fa-download", "Download", () => downloadMedia(post.media)));
    }
    row2.appendChild(makeButton("change-slot", "fa-exchange-alt", "Change Slot", () => openChangeSlotModal(post)));
    row2.appendChild(makeButton("delete", "fa-trash", "Delete", () => confirmDelete(post)));
    btnGroup.appendChild(row2);

    const row3 = document.createElement("div");
    row3.className = "button-row";
    if (CONFIG.FEATURES.ENABLE_BUFFER_PUBLISH || CONFIG.FEATURES.ENABLE_WHATSAPP_PUBLISH) {
      appendShareButton(row3, post);
    }
    row3.appendChild(makeButton("close", "fa-times", "Close", closePostModal));
    btnGroup.appendChild(row3);

    modal.classList.remove("hidden");
    return;
  }

  // Normal mode
  const row1 = document.createElement("div");
  row1.className = "button-row";
  if (isPending) {
    row1.appendChild(makeButton("approve", "fa-check", "Approve", () => updateStatus(post, "approved")));
    row1.appendChild(makeButton("reject", "fa-times", "Reject", () => updateStatus(post, "rejected")));
  }
  if (isApproved) row1.appendChild(makeButton("reject", "fa-times", "Reject", () => updateStatus(post, "rejected")));
  if (isRejected) row1.appendChild(makeButton("approve", "fa-check", "Approve", () => updateStatus(post, "approved")));
  btnGroup.appendChild(row1);

  const row2 = document.createElement("div");
  row2.className = "button-row";
  row2.appendChild(makeButton("edit", "fa-pen", "Edit", () => openEditModal(post)));
  if (CONFIG.FEATURES.ENABLE_MEDIA_DOWNLOAD && post.media) {
    row2.appendChild(makeButton("download", "fa-download", "Download", () => downloadMedia(post.media)));
  }
  row2.appendChild(makeButton("change-slot", "fa-exchange-alt", "Change Slot", () => openChangeSlotModal(post)));
  btnGroup.appendChild(row2);

  const row3 = document.createElement("div");
  row3.className = "button-row";

  if (isApproved) {
    // Auto-share is disabled: approved posts get a "Share" button
    appendShareButton(row3, post);
    row3.appendChild(makeButton("delete", "fa-trash", "Delete", () => confirmDelete(post)));
  }

  if (isRejected) row3.appendChild(makeButton("delete", "fa-trash", "Delete", () => confirmDelete(post)));
  row3.appendChild(makeButton("close", "fa-times", "Close", closePostModal));
  btnGroup.appendChild(row3);

  modal.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// req 5 & 6: Combined share modal (WhatsApp + Social Media in one window)
// ---------------------------------------------------------------------------

function appendShareButton(container, post) {
  const btn = makeButton("share-main-btn", "fa-share-alt", "Share", () => openAutoDestinationsModal(post));
  container.appendChild(btn);
}

function openCombinedShareModal(post, isScheduledMode = false) {
  activePost = post;
  document.getElementById("postModal").classList.add("hidden");
  const modal = document.getElementById("combinedShareModal");
  modal.dataset.mode = "normal";
  // Restore original button texts if changed
  const publishBtn = document.getElementById("csPublishAllBtn");
  if (publishBtn) {
    publishBtn.textContent = "Publish";
    publishBtn.id = "csPublishAllBtn";
    publishBtn.classList.remove("csm-save-auto");
    publishBtn.classList.add("csm-publish-all");
  }
  const waOnlyBtn = document.getElementById("csWaOnlyBtn");
  const smOnlyBtn = document.getElementById("csSmOnlyBtn");
  if (waOnlyBtn) waOnlyBtn.style.display = "";
  if (smOnlyBtn) smOnlyBtn.style.display = "";

  // Restore cancel event
  const cancelBtn = document.getElementById("csCancelBtn");
  if (cancelBtn) {
    const newCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    newCancel.addEventListener("click", () => { /* original cancel logic */ });
  }

  modal.classList.remove("hidden");
  loadCombinedShareModal(post);
}

// Buffer can publish only YouTube Shorts (max 3 minutes). Longer videos go up manually.
const YT_MAX_SECONDS = 180;
let activeVideoSecs = null;
const _videoDurationCache = {};

// Reads a video's length (seconds) in the browser. Returns null if it can't be read.
function getVideoDuration(url) {
  if (_videoDurationCache[url] !== undefined) return Promise.resolve(_videoDurationCache[url]);
  return new Promise(resolve => {
    const v = document.createElement("video");
    let done = false;
    const finish = d => {
      if (done) return;
      done = true;
      _videoDurationCache[url] = d;
      v.removeAttribute("src");
      try { v.load(); } catch (e) {}
      resolve(d);
    };
    v.preload = "metadata";
    v.onloadedmetadata = () => finish(isFinite(v.duration) ? v.duration : null);
    v.onerror = () => finish(null);
    setTimeout(() => finish(null), 8000);
    v.src = url;
  });
}

function formatDuration(secs) {
  const m = Math.floor(secs / 60), r = Math.round(secs % 60);
  return m + ":" + String(r).padStart(2, "0");
}

async function loadCombinedShareModal(post) {
  const smList = document.getElementById("csSmList");
  smList.innerHTML = '<p style="color:#888;text-align:center;">Loading…</p>';

  if (WA_ON) {
    const waList = document.getElementById("csWaList");
    waList.innerHTML = '<p style="color:#888;text-align:center;">Loading…</p>';
    try {
      const res = await postToBackend({ action: "whatsappProxy", endpoint: "/targets", method: "GET" });
      const result = await res.json();
      if (result.success && result.data && result.data.targets) renderCsWaTargets(result.data.targets);
      else throw new Error("No targets data");
    } catch {
      waList.innerHTML = '<p style="color:#c62828;font-size:0.8rem;text-align:center;">WhatsApp server not reachable.</p>';
    }
  }

  try {
    const res  = await fetch(`${CONFIG.SCRIPT_URL}?action=getProfiles`);
    const data = await res.json();
    activeVideoSecs = postHasVideo(post) ? await getVideoDuration(post.media) : null;
    renderCsSmProfiles(Array.isArray(data) ? data : [], activeVideoSecs);
  } catch {
    smList.innerHTML = '<p style="color:#c62828;font-size:0.8rem;text-align:center;">Could not load profiles.</p>';
  }
}

function renderCsWaTargets(targets) {
  const el = document.getElementById("csWaList");
  el.innerHTML = "";
  if (!targets.length) {
    el.innerHTML = '<p style="color:#aaa;font-size:0.82rem;text-align:center;padding:0.4rem;">No WhatsApp targets found.</p>';
    updateCsCount(); return;
  }
  const iconMap = { group: "fa-users", channel: "fa-bullhorn", contact: "fa-user", newsletter: "fa-bullhorn" };
  targets.forEach(t => {
    const item = document.createElement("label");
    item.className = "csm-item csm-selected";          // pre-checked
    item.innerHTML = `
      <input type="checkbox" class="cs-wa-checkbox" value="${escapeAttr(t.id)}"
             data-target='${JSON.stringify(t)}' checked>
      <div class="csm-icon wa-icon"><i class="fas ${iconMap[t.type] || "fa-comment"}"></i></div>
      <div class="csm-info">
        <div class="csm-name">${escapeHTML(t.label)}</div>
        <div class="csm-type">${t.type}</div>
      </div>
      <div class="csm-check"><i class="fas fa-check"></i></div>
    `;
    const cb  = item.querySelector("input");
    const chk = item.querySelector(".csm-check");
    cb.addEventListener("change", () => {
      if (cb.checked) { item.classList.add("csm-selected");    chk.innerHTML = '<i class="fas fa-check"></i>'; }
      else            { item.classList.remove("csm-selected"); chk.innerHTML = ""; }
      updateCsCount();
    });
    el.appendChild(item);
  });
  updateCsCount();
}

function postHasVideo(post) {
  const m = (post && post.media) || "";
  return !!m && (/\.(mp4|mov|webm|avi|m4v|3gp|mpeg|ogg)(\?|$)/i.test(m) || m.includes("/video/upload/"));
}

function renderCsSmProfiles(profiles, videoSecs = null) {
  const el = document.getElementById("csSmList");
  el.innerHTML = "";
  if (!profiles.length) {
    el.innerHTML = '<p style="color:#aaa;font-size:0.82rem;text-align:center;padding:0.4rem;">No social profiles found.</p>';
    updateCsCount(); return;
  }
  // 3 channels always; with a video the other 2 (YouTube + TikTok) are selected too
  const hasVideo   = postHasVideo(activePost);
  const ytTooLong  = hasVideo && videoSecs !== null && videoSecs > YT_MAX_SECONDS;
  const autoSelect = hasVideo
    ? ["instagram", "facebook", "linkedin", "youtube", "tiktok"]
    : ["instagram", "facebook", "linkedin"];
  profiles.forEach(p => {
    const pc        = getPlatformConfig(p.serviceName);
    const isYt      = (p.serviceName || "").toLowerCase() === "youtube";
    const preCheck  = autoSelect.includes((p.serviceName || "").toLowerCase()) && !(isYt && ytTooLong);

    // Profile row
    const item = document.createElement("label");
    item.className = "csm-item" + (preCheck ? " csm-selected" : "");
    item.innerHTML = `
      <input type="checkbox" class="cs-sm-checkbox" value="${escapeAttr(p.id)}"
             data-profile='${JSON.stringify(p)}' ${preCheck ? "checked" : ""}>
      <div class="csm-icon" style="background:${pc.color}20;color:${pc.color};">
        <i class="${pc.icon}"></i>
      </div>
      <div class="csm-info">
        <div class="csm-name">${escapeHTML(pc.label)}</div>
        <div class="csm-type">${escapeHTML(p.username || "")}</div>
      </div>
      <div class="csm-check" style="${preCheck ? "background:#b34e1a;border-color:#b34e1a;" : ""}">
        ${preCheck ? '<i class="fas fa-check"></i>' : ""}
      </div>
    `;
    el.appendChild(item);

    // YouTube only accepts video posts: disable it for image / text-only posts
    if (isYt && !postHasVideo(activePost)) {
      const ytCb = item.querySelector("input");
      ytCb.checked = false;
      ytCb.disabled = true;
      item.style.opacity = "0.5";
      item.style.cursor = "not-allowed";
      item.querySelector(".csm-type").textContent = "Needs a video (this post has none)";
    }

    // Video longer than 3 minutes: YouTube is switched off and a message explains why
    if (isYt && ytTooLong) {
      const ytCb = item.querySelector("input");
      ytCb.checked = false;
      ytCb.disabled = true;
      item.style.opacity = "0.5";
      item.style.cursor = "not-allowed";
      item.querySelector(".csm-type").textContent = "Video is over 3 minutes";
      const note = document.createElement("div");
      note.className = "yt-long-note";
      note.style.cssText = "background:#fff4e5;border:1.5px solid #ffcc80;color:#8a4b00;" +
        "border-radius:0.8rem;padding:0.6rem 0.8rem;font-size:0.8rem;line-height:1.45;margin:0.2rem 0 0.5rem;";
      note.innerHTML = '<i class="fas fa-exclamation-triangle"></i> ' +
        'This video is ' + formatDuration(videoSecs) + ' long. Videos longer than 3 minutes ' +
        '<strong>must be uploaded to YouTube manually</strong> (This only for YouTube Shorts).';
      el.appendChild(note);
    }

    // REQ 3: YouTube title + category panel (inline, shown when YouTube is checked)
    if (isYt) {
      const ytPanel = document.createElement("div");
      ytPanel.className = "yt-extras";
      ytPanel.id = `ytExtras_${escapeAttr(p.id)}`;
      ytPanel.style.display = preCheck ? "block" : "none";
      const catOptions = YOUTUBE_CATEGORIES.map(c =>
        `<option value="${c.id}">${escapeHTML(c.name)}</option>`
      ).join("");
      ytPanel.innerHTML = `
        <div class="yt-field">
          <div class="yt-field-label"><i class="fab fa-youtube"></i> YouTube Title</div>
          <textarea class="yt-input" id="ytTitle_${escapeAttr(p.id)}" rows="2"
            placeholder="Enter video title for YouTube…"></textarea>
        </div>
        <div class="yt-field">
          <div class="yt-field-label"><i class="fas fa-list"></i> Category</div>
          <select class="yt-input" id="ytCat_${escapeAttr(p.id)}">${catOptions}</select>
        </div>
      `;
      el.appendChild(ytPanel);
    }

    // Checkbox toggle handler
    const cb  = item.querySelector("input");
    const chk = item.querySelector(".csm-check");
    cb.addEventListener("change", () => {
      if (cb.checked) {
        item.classList.add("csm-selected");
        chk.style.cssText = "background:#b34e1a;border-color:#b34e1a;";
        chk.innerHTML = '<i class="fas fa-check"></i>';
        if (isYt) document.getElementById(`ytExtras_${p.id}`).style.display = "block";
      } else {
        item.classList.remove("csm-selected");
        chk.style.cssText = "";
        chk.innerHTML = "";
        if (isYt) document.getElementById(`ytExtras_${p.id}`).style.display = "none";
      }
      updateCsCount();
    });
  });
  updateCsCount();
}

function updateCsCount() {
  const waCount    = document.querySelectorAll(".cs-wa-checkbox:checked").length;
  const smCount    = document.querySelectorAll(".cs-sm-checkbox:checked").length;
  const manualVal  = (document.getElementById("csWaManualInput")?.value || "").trim();
  const total      = waCount + smCount + (manualVal ? 1 : 0);
  const el = document.getElementById("csCount");
  if (el) el.textContent = total === 0
    ? "Nothing selected"
    : `${total} destination${total !== 1 ? "s" : ""} selected`;
}

// Share only WhatsApp
document.getElementById("csWaOnlyBtn")?.addEventListener("click", async () => {
  await publishCombined(true, false);
});

// Share only Social Media
document.getElementById("csSmOnlyBtn")?.addEventListener("click", async () => {
  await publishCombined(false, true);
});

// Share all
document.getElementById("csPublishAllBtn")?.addEventListener("click", async () => {
  await publishCombined(true, true);
});

document.getElementById("csCancelBtn")?.addEventListener("click", async () => {
  document.getElementById("combinedShareModal").classList.add("hidden");
  if (activePost) {
    try {
      const res  = await fetch(CONFIG.SCRIPT_URL);
      const posts = await res.json();
      const fresh = posts.find(p => p.row === activePost.row);
      openPostModal(fresh || activePost);
    } catch {
      openPostModal(activePost);
    }
  }
});

async function publishCombined(doWa, doSm) {
  if (!WA_ON) { doWa = false; doSm = true; }
  if (!activePost) return;

  const waTargets = doWa
    ? Array.from(document.querySelectorAll(".cs-wa-checkbox:checked"))
        .map(cb => JSON.parse(cb.dataset.target))
    : [];

  // Include manually entered WA number
  if (doWa) {
    const manualNum = (document.getElementById("csWaManualInput")?.value || "").replace(/[^\d]/g, "");
    if (manualNum.length >= 7) {
      waTargets.push({ type: "contact", number: manualNum, id: manualNum, label: manualNum });
    }
  }

  const smProfiles = doSm
    ? Array.from(document.querySelectorAll(".cs-sm-checkbox:checked"))
        .map(cb => JSON.parse(cb.dataset.profile))
    : [];

  // Never send YouTube a post without a video, or a video longer than 3 minutes
  for (let i = smProfiles.length - 1; i >= 0; i--) {
    if ((smProfiles[i].serviceName || "").toLowerCase() === "youtube" &&
        (!postHasVideo(activePost) || (activeVideoSecs !== null && activeVideoSecs > YT_MAX_SECONDS))) {
      smProfiles.splice(i, 1);
    }
  }

  if (!waTargets.length && !smProfiles.length) {
    showToast("Select at least one destination.", "error");
    return;
  }

  showLoading("Sharing to social media… Please wait until the upload finishes. Don't close this page.");
  document.getElementById("combinedShareModal").classList.add("hidden");

  let waOk = true, smOk = true;

  // Send WhatsApp via proxy
  if (waTargets.length) {
    try {
      const res = await postToBackend({
        action: "whatsappProxy",
        endpoint: "/send",
        method: "POST",
        body: {
          targets: waTargets,
          message: getWhatsAppText(activePost.content),
          mediaUrl: activePost.media || null
        }
      });
      const result = await res.json();
      if (result.success && result.data && result.data.success) {
        showToast("WhatsApp: sent!", "success");
      } else {
        waOk = false;
        showToast("WhatsApp: " + (result.data?.error || "failed"), "error");
      }
    } catch {
      waOk = false;
      showToast("WhatsApp server not reachable.", "error");
    }
  }

  // Send Social Media via Buffer
  if (smProfiles.length) {
    try {
      // req 1: social media gets stripped text (no * or _)
      const profiles = smProfiles.map(p => ({
        id: p.id, orgType: p.orgType, serviceName: p.serviceName, username: p.username
      }));

      // req 3: collect YouTube title + category if YouTube is among selected profiles
      let youtubeMeta = null;
      const ytProfile = smProfiles.find(p => (p.serviceName || "").toLowerCase() === "youtube");
      if (ytProfile) {
        const titleEl = document.getElementById(`ytTitle_${ytProfile.id}`);
        const catEl   = document.getElementById(`ytCat_${ytProfile.id}`);
        youtubeMeta = {
          title:      titleEl ? titleEl.value.trim() : (activePost.title || ""),
          categoryId: catEl   ? catEl.value          : "22"
        };
        if (!youtubeMeta.title) {
          hideLoading();
          showToast("Please enter a YouTube title before publishing.", "error");
          document.getElementById("combinedShareModal").classList.remove("hidden");
          return;
        }
      }

      const payload = {
        action: "publishToBuffer", row: activePost.row, profiles,
        strippedContent: getSocialText(activePost.content)
      };
      if (youtubeMeta) payload.youtubeMeta = youtubeMeta;

      const res    = await postToBackend(payload);
      const result = await res.json();
      if (result.success) {
        showToast("Social media: published!", "success");
      } else {
        smOk = false;
        const why = Array.isArray(result.details) && result.details.length
          ? " (" + result.details.join("; ") + ")" : "";
        console.error("Publish failed:", result);
        showToast("Social media failed: " + (result.error || "") + why, "error");
      }
    } catch {
      smOk = false;
      showToast("Network error.", "error");
    }
  }

  hideLoading();
  await loadSchedule(getAdminDate());
}

function closePostModal() {
  document.getElementById("postModal").classList.add("hidden");
  if (_shareDropdownCloseListener) {
    document.removeEventListener("click", _shareDropdownCloseListener);
    _shareDropdownCloseListener = null;
  }
  activePost = null;
}

// ---------------------------------------------------------------------------
// Approve / Reject
// ---------------------------------------------------------------------------

async function updateStatus(post, status) {
  showLoading();
  try {
    const res    = await postToBackend({ action: "update", row: post.row, status });
    const result = await res.json();
    if (result.success) {
      showToast(`Post ${status}.`, "success");
      const fetchRes = await fetch(CONFIG.SCRIPT_URL);
      allPosts = normalizePosts(await fetchRes.json());
      checkManualOverdueReminders(allPosts);
      renderScheduleGrid(getAdminDate(), allPosts);
      const updatedPost = allPosts.find(p => p.row === post.row);
      if (updatedPost) openPostModal(updatedPost);
      else closePostModal();
    } else {
      showToast("Error: " + (result.error || "Unknown"), "error");
    }
  } catch (err) {
    showToast("Network error. Please try again.", "error");
  } finally {
    hideLoading();
  }
}

// ---------------------------------------------------------------------------
// Edit modal
// ---------------------------------------------------------------------------

function openEditModal(post) {
  activePost = post;
  document.getElementById("postModal").classList.add("hidden");
  document.getElementById("editContent").value = post.content || "";
  document.getElementById("mediaPreview").innerHTML = post.media
    ? `<img src="${escapeAttr(post.media)}" style="max-width:100%;max-height:150px;border-radius:0.5rem;">`
    : "";
  document.getElementById("editModal").classList.remove("hidden");
}

document.getElementById("cancelEditBtn").addEventListener("click", () => {
  document.getElementById("editModal").classList.add("hidden");
});

document.getElementById("editForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activePost) return;
  const content = document.getElementById("editContent").value.trim();
  const file    = document.getElementById("editMediaFile").files[0];
  showLoading();
  try {
    let mediaUrl = null;
    if (file) {
      const maxBytes = CONFIG.APP.EDIT_IMAGE_MAX_SIZE_MB * 1024 * 1024;
      if (file.size > maxBytes) {
        hideLoading();
        showToast(`Image must be under ${CONFIG.APP.EDIT_IMAGE_MAX_SIZE_MB} MB.`, "error");
        return;
      }
      const fd = new FormData();
      fd.append("file", file);
      fd.append("upload_preset", CONFIG.CLOUDINARY.UPLOAD_PRESET);
      const cloudRes  = await fetch(CONFIG.CLOUDINARY.UPLOAD_URL, { method: "POST", body: fd });
      const cloudData = await cloudRes.json();
      if (!cloudData.secure_url) throw new Error("Media upload failed.");
      mediaUrl = cloudData.secure_url;
    }
    const payload = { action: "edit", row: activePost.row, content };
    if (mediaUrl) payload.media = mediaUrl;
    const res    = await postToBackend(payload);
    const result = await res.json();
    if (result.success) {
      showToast("Post updated.", "success");
      document.getElementById("editModal").classList.add("hidden");
      document.getElementById("editForm").reset();
      document.getElementById("mediaPreview").innerHTML = "";
      await loadSchedule(getAdminDate());
    } else {
      showToast("Error: " + (result.error || "Unknown"), "error");
    }
  } catch (err) {
    showToast("Error: " + err.message, "error");
  } finally {
    hideLoading();
  }
});

// ---------------------------------------------------------------------------
// Change slot modal
// ---------------------------------------------------------------------------

async function openChangeSlotModal(post) {
  activePost = post;
  document.getElementById("postModal").classList.add("hidden");
  document.getElementById("currentSlotDate").value  = formatDateDisplay(post.date);
  document.getElementById("currentSlotValue").value = post.timeslot || "";
  document.getElementById("slotAvailabilityNote").textContent = "";
  const newDatePicker = document.getElementById("newSlotDate");
  if (newDatePicker) {
    newDatePicker.value = post.date || formatDateYMD(new Date());
    newDatePicker.min   = formatDateYMD(new Date());
  }
  await refreshSlotOptions(post);
  document.getElementById("changeSlotModal").classList.remove("hidden");
}

async function refreshSlotOptions(post) {
  const newDatePicker = document.getElementById("newSlotDate");
  const targetDate    = newDatePicker ? newDatePicker.value : post.date;
  let takenSlots = [];
  showLoading();
  try {
    const res        = await fetch(CONFIG.SCRIPT_URL);
    const posts      = normalizePosts(await res.json());
    const targetTime = toLocalMidnight(targetDate).getTime();
    takenSlots = posts
      .filter(p => p.row !== post.row && p.date && p.status !== "rejected" &&
                   toLocalMidnight(p.date).getTime() === targetTime)
      .map(p => p.timeslot);
  } catch (err) {
    console.error("refreshSlotOptions fetch error:", err);
  } finally {
    hideLoading();
  }

  const select = document.getElementById("newSlotSelect");
  select.innerHTML = '<option value="">-- Select a slot --</option>';

  for (const [, slots] of Object.entries(CONFIG.SLOT_GROUPS)) {
    for (const slot of slots) {
      const isTaken   = takenSlots.includes(slot) || takenSlots.includes(CONFIG.SLOT_VALUES[slot]);
      const isCurrent = slot === post.timeslot && targetDate === post.date;
      const isPast    = isSlotPast(targetDate, slot);
      const opt       = document.createElement("option");
      opt.value       = slot;
      opt.textContent = slot
        + (isTaken   ? " (taken)"   : "")
        + (isCurrent ? " (current)" : "")
        + (isPast    ? " (past)"    : "");
      opt.disabled = isTaken || isCurrent;   // past slots are allowed for admins
      select.appendChild(opt);
    }
  }
}

document.getElementById("cancelChangeSlotBtn").addEventListener("click", () => {
  document.getElementById("changeSlotModal").classList.add("hidden");
});

document.getElementById("newSlotDate")?.addEventListener("change", () => {
  if (activePost) refreshSlotOptions(activePost);
});

document.getElementById("confirmChangeSlotBtn").addEventListener("click", async () => {
  if (!activePost) return;
  const newSlot = document.getElementById("newSlotSelect").value;
  const newDate = document.getElementById("newSlotDate")?.value || activePost.date;
  if (!newSlot) {
    document.getElementById("slotAvailabilityNote").textContent = "Please select a slot.";
    return;
  }
  showLoading();
  try {
    const res    = await postToBackend({ action: "changeSlot", row: activePost.row, date: activePost.date, newSlot, newDate });
    const result = await res.json();
    if (result.success) {
      showToast("Time slot updated.", "success");
      document.getElementById("changeSlotModal").classList.add("hidden");
      await loadSchedule(getAdminDate());
    } else {
      document.getElementById("slotAvailabilityNote").textContent = result.error || "Could not change slot.";
    }
  } catch (err) {
    showToast("Network error. Please try again.", "error");
  } finally {
    hideLoading();
  }
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

function confirmDelete(post) {
  if (!confirm(`Delete "${post.title || "this post"}"? This cannot be undone.`)) return;
  deletePost(post);
}

async function deletePost(post) {
  showLoading();
  try {
    const res    = await postToBackend({ action: "deleteRow", row: post.row });
    const result = await res.json();
    if (result.success) {
      showToast("Post deleted.", "success");
      closePostModal();
      await loadSchedule(getAdminDate());
    } else {
      showToast("Delete failed: " + (result.error || "Unknown"), "error");
    }
  } catch (err) {
    showToast("Network error. Please try again.", "error");
  } finally {
    hideLoading();
  }
}

// ---------------------------------------------------------------------------
// Media download
// ---------------------------------------------------------------------------

async function downloadMedia(url) {
  try {
    showLoading();
    const response = await fetch(url);
    const blob     = await response.blob();
    const blobUrl  = URL.createObjectURL(blob);
    const a        = document.createElement("a");
    a.href         = blobUrl;
    a.download     = url.split("/").pop().split("?")[0] || "media";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
  } catch (err) {
    showToast("Download failed. Trying direct link…", "error");
    window.open(url, "_blank");
  } finally {
    hideLoading();
  }
}

// ---------------------------------------------------------------------------
// Platform config
// ---------------------------------------------------------------------------

const PLATFORM_CONFIG = {
  facebook:  { label: "Facebook",  icon: "fab fa-facebook",  color: "#1877f2" },
  instagram: { label: "Instagram", icon: "fab fa-instagram", color: "#e1306c" },
  linkedin:  { label: "LinkedIn",  icon: "fab fa-linkedin",  color: "#0a66c2" },
  twitter:   { label: "Twitter",   icon: "fab fa-twitter",   color: "#1da1f2" },
  youtube:   { label: "YouTube",   icon: "fab fa-youtube",   color: "#ff0000" },
  tiktok:    { label: "TikTok",    icon: "fab fa-tiktok",    color: "#010101" },
  pinterest: { label: "Pinterest", icon: "fab fa-pinterest", color: "#e60023" }
};

function getPlatformConfig(serviceName) {
  const key = (serviceName || "").toLowerCase();
  return PLATFORM_CONFIG[key] || {
    label: serviceName ? serviceName.charAt(0).toUpperCase() + serviceName.slice(1) : "Platform",
    icon: "fas fa-globe", color: "#b34e1a"
  };
}

// ---------------------------------------------------------------------------
// req 3: YouTube title + category modal (shown when YouTube is in profiles)
// ---------------------------------------------------------------------------

const YOUTUBE_CATEGORIES = [
  { id: "1",  name: "Film & Animation" },
  { id: "2",  name: "Autos & Vehicles" },
  { id: "10", name: "Music" },
  { id: "15", name: "Pets & Animals" },
  { id: "17", name: "Sports" },
  { id: "19", name: "Travel & Events" },
  { id: "20", name: "Gaming" },
  { id: "22", name: "People & Blogs" },
  { id: "23", name: "Comedy" },
  { id: "24", name: "Entertainment" },
  { id: "25", name: "News & Politics" },
  { id: "26", name: "Howto & Style" },
  { id: "27", name: "Education" },
  { id: "28", name: "Science & Technology" },
  { id: "29", name: "Nonprofits & Activism" }
];

// Old Buffer modal kept for backward-compat but replaced by combined modal
async function openBufferModal(post) {
  openCombinedShareModal(post);
}

function updateSocialCheckStyle(item, cb, chk) {
  if (cb.checked) {
    item.classList.add("social-profile-selected");
    chk.innerHTML = `<i class="fas fa-check"></i>`;
  } else {
    item.classList.remove("social-profile-selected");
    chk.innerHTML = "";
  }
}

function showSocialPreview(post, platformLabel, platformIcon, platformColor) {
  document.querySelectorAll(".social-preview-popup").forEach(p => p.remove());
  // req 1: preview shows stripped text (what social media will actually show)
  const plainText = getSocialText(post.content || "");
  const popup     = document.createElement("div");
  popup.className = "social-preview-popup";
  popup.innerHTML = `
    <div class="spp-header" style="background:${platformColor};">
      <i class="${platformIcon}"></i> ${platformLabel} Preview
      <button class="spp-close"><i class="fas fa-times"></i></button>
    </div>
    <div class="spp-body">
      ${post.media ? `<div class="spp-media"><img src="${escapeAttr(post.media)}" alt="media" onerror="this.style.display='none'"></div>` : ""}
      <div class="spp-text" id="sppText"></div>
    </div>
  `;
  popup.querySelector("#sppText").textContent = plainText;
  popup.querySelector(".spp-close").addEventListener("click", () => popup.remove());
  document.body.appendChild(popup);
}

document.getElementById("cancelBufferBtn")?.addEventListener("click", () => {
  document.querySelectorAll(".social-preview-popup").forEach(p => p.remove());
  document.getElementById("bufferModal").classList.add("hidden");
});

document.getElementById("confirmBufferBtn")?.addEventListener("click", async () => {
  if (!activePost) return;
  const checkboxes = document.querySelectorAll("#bufferProfilesList .social-checkbox:checked");
  if (!checkboxes.length) { showToast("Select at least one profile.", "error"); return; }
  const profiles = Array.from(checkboxes).map(cb => ({
    id: cb.value, orgType: cb.dataset.orgType,
    username: cb.dataset.name, serviceName: cb.dataset.serviceName
  }));
  showLoading();
  try {
    const res    = await postToBackend({ action: "publishToBuffer", row: activePost.row, profiles });
    const result = await res.json();
    if (result.success) {
      if (result.failed?.length) showToast(`Published! Failed for: ${result.failed.join(", ")}`, "info");
      else showToast("Published successfully!", "success");
      document.getElementById("bufferModal").classList.add("hidden");
      await loadSchedule(getAdminDate());
    } else {
      showToast("Publish failed: " + (result.error || "Unknown"), "error");
    }
  } catch (err) {
    showToast("Network error. Please try again.", "error");
  } finally {
    hideLoading();
  }
});

// ---------------------------------------------------------------------------
// Projects modal
// ---------------------------------------------------------------------------

async function openProjectsModal() {
  document.getElementById("projectsModal").classList.remove("hidden");
  await loadProjects();
}

async function loadProjects() {
  const list = document.getElementById("projectsList");
  list.innerHTML = '<p style="color:#888;text-align:center;">Loading…</p>';
  try {
    const res      = await fetch(`${CONFIG.SCRIPT_URL}?action=getProjects`);
    const projects = await res.json();
    renderProjectsList(projects);
  } catch (err) {
    list.innerHTML = '<p style="color:#c62828;">Failed to load projects.</p>';
  }
}

// Project statuses: label shown + next status when the toggle button is clicked
const PROJECT_STATUS = {
  ongoing:   { label: "Ongoing",   next: "tobe" },
  tobe:      { label: "To Be",     next: "completed" },
  completed: { label: "Completed", next: "ongoing" }
};

function renderProjectsList(projects) {
  const list = document.getElementById("projectsList");
  list.innerHTML = "";
  if (!projects.length) {
    list.innerHTML = '<p style="color:#aaa;text-align:center;padding:1rem;">No projects yet.</p>';
    return;
  }
  projects.forEach(p => {
    const item = document.createElement("div");
    item.className = "project-list-item";
    item.innerHTML = `
      <span class="project-dot" style="background:${escapeAttr(p.color)};"></span>
      <span class="project-name" id="pname_${p.row}"></span>
      <span class="project-status-badge ${PROJECT_STATUS[p.status] ? p.status : "tobe"}" id="pstatus_${p.row}">
        ${(PROJECT_STATUS[p.status] || PROJECT_STATUS.tobe).label}
      </span>
      <div class="project-actions">
        <button class="proj-toggle-btn" data-row="${p.row}" data-status="${p.status}" title="Change status (Ongoing → To Be → Completed)">
          <i class="fas fa-exchange-alt"></i>
        </button>
        <button class="proj-delete-btn" data-row="${p.row}" title="Remove">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    `;
    item.querySelector(`#pname_${p.row}`).textContent = p.name;
    item.querySelector(".proj-toggle-btn").addEventListener("click", async (e) => {
      const row = e.currentTarget.dataset.row;
      const cur = e.currentTarget.dataset.status;
      const newStatus = (PROJECT_STATUS[cur] || PROJECT_STATUS.tobe).next;
      await postToBackend({ action: "updateProject", row, name: p.name, status: newStatus, color: p.color });
      await loadProjects();
    });
    item.querySelector(".proj-delete-btn").addEventListener("click", async (e) => {
      if (!confirm(`Remove project "${p.name}"?`)) return;
      await postToBackend({ action: "removeProject", row: p.row });
      await loadProjects();
    });
    list.appendChild(item);
  });
}

document.getElementById("cancelProjectsBtn").addEventListener("click", () => {
  document.getElementById("projectsModal").classList.add("hidden");
});

document.getElementById("addProjectForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name   = document.getElementById("newProjectName").value.trim();
  const status = document.getElementById("newProjectStatus").value;
  const color  = document.getElementById("newProjectColor").value;
  if (!name) return;
  showLoading();
  try {
    const res    = await postToBackend({ action: "addProject", name, status, color });
    const result = await res.json();
    if (result.success) {
      showToast("Project added.", "success");
      document.getElementById("newProjectName").value = "";
      await loadProjects();
    } else {
      showToast("Error: " + (result.error || "Unknown"), "error");
    }
  } catch (err) {
    showToast("Network error.", "error");
  } finally {
    hideLoading();
  }
});

// ---------------------------------------------------------------------------
// Admin date picker & refresh
// ---------------------------------------------------------------------------

function getAdminDate() {
  const picker = document.getElementById("adminDatePicker");
  return picker?.value || formatDateYMD(new Date());
}

document.getElementById("adminDatePicker").addEventListener("change", async (e) => {
  await loadSchedule(e.target.value);
});

document.getElementById("refreshBtn").addEventListener("click", async () => {
  await loadSchedule(getAdminDate());
  showToast("Schedule refreshed.", "info");
});

document.getElementById("manageProjectsBtn")?.addEventListener("click", openProjectsModal);

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

// CHANGE this function in Script.js:
function postToBackend(payload) {
  const session = getSession();
  if (session && session.token && !payload.token) {
    payload = Object.assign({}, payload, { token: session.token });
  }
  return fetch(CONFIG.SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload)
  });
}

function makeButton(className, icon, label, onClick) {
  const btn     = document.createElement("button");
  btn.className = className;
  btn.innerHTML = `<i class="fas ${icon}"></i> ${label}`;
  btn.addEventListener("click", onClick);
  return btn;
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeAttr(str) {
  return String(str).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------

renderCurrentDate();
const adminPicker = document.getElementById("adminDatePicker");
if (adminPicker) adminPicker.value = formatDateYMD(new Date());
loadSchedule(formatDateYMD(new Date()));

// ADD at the bottom of Script.js (after the existing init lines)

// ─── Admin auth init ──────────────────────────────────────────────────────────
(function initAdminAuth() {
  const session = getSession();   // from Auth.js
  if (!session) return;

  // Show user badge
  const badge = document.getElementById("adminUserBadge");
  if (badge) badge.textContent = session.name || session.phone || "";

  // Logout
  const logoutBtn = document.getElementById("adminLogoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", () => {
    clearSession();
    location.replace("/User/Submit.html");
  });

  // Owner-only tools
  if (session.role === "owner") {
    const panel = document.getElementById("ownerToolsPanel");
    if (panel) panel.style.display = "block";
    loadOwnerWhitelist();
    loadOwnerSheetLinks();
  }
})();

async function loadOwnerSheetLinks() {
  showLoading();
  try {
    const res  = await postToBackend({ action: "getSheetUrls", token: getSession()?.token });
    const data = await res.json();
    if (!data.success) return;
    const container = document.getElementById("ownerSheetLinks");
    if (!container) return;
    const labels = { Database: "Posts", Projects: "Projects", Users: "Users", ActivityLog: "Activity Log" };
    container.innerHTML = Object.entries(data.urls).map(([name, url]) =>
      `<a href="${url}" target="_blank" rel="noopener"
          style="padding:0.3rem 0.9rem; border-radius:2rem; background:#fff;
                 border:1.5px solid #e0d0c8; color:#7a5a4a; font-size:0.8rem;
                 font-weight:600; text-decoration:none; display:inline-flex; align-items:center; gap:0.4rem;">
         <i class="fas fa-table"></i> ${labels[name] || name}
       </a>`
    ).join("");
  } catch(e) { console.error("loadOwnerSheetLinks error:", e); }
  finally { hideLoading(); }
}

document.getElementById("ownerSaveWhitelistBtn")?.addEventListener("click", saveOwnerWhitelist);

function openAutoDestinationsModal(post) {
  activePost = post;
  document.getElementById("postModal").classList.add("hidden");
  const modal = document.getElementById("combinedShareModal");
  modal.classList.remove("hidden");
  modal.dataset.mode = "auto";

  // Footer: hide Save/Publish + hint; only Cancel remains
  const publishBtn = document.getElementById("csPublishAllBtn") || document.getElementById("csSaveAutoBtn");
  if (publishBtn) publishBtn.style.display = "none";
  const csmHint = document.querySelector(".csm-hint");
  if (csmHint) csmHint.style.display = "none";

  // Show a single "Share" button that publishes to the selected social media
  const waOnlyBtn = document.getElementById("csWaOnlyBtn");
  const smOnlyBtn = document.getElementById("csSmOnlyBtn");
  if (waOnlyBtn) waOnlyBtn.style.display = "none";
  if (smOnlyBtn) {
    smOnlyBtn.style.display = "";
    smOnlyBtn.innerHTML = '<i class="fas fa-share-alt"></i> Share';
  }

  // Cancel just closes and returns to the post
  const cancelBtn = document.getElementById("csCancelBtn");
  if (cancelBtn) {
    const newCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    newCancel.addEventListener("click", () => {
      modal.classList.add("hidden");
      openPostModal(activePost);
    });
  }

  loadCombinedShareModal(post);
}

async function saveAutoDestinations(post) {
  // Collect selected WhatsApp targets
  const waTargets = WA_ON
    ? Array.from(document.querySelectorAll(".cs-wa-checkbox:checked")).map(cb => JSON.parse(cb.dataset.target))
    : [];

  // Collect selected social profiles
  const smProfiles = Array.from(document.querySelectorAll(".cs-sm-checkbox:checked"))
    .map(cb => JSON.parse(cb.dataset.profile));

  // For YouTube, collect title/category if present
  let youtubeMeta = null;
  const ytProfile = smProfiles.find(p => (p.serviceName || "").toLowerCase() === "youtube");
  if (ytProfile) {
    const titleEl = document.getElementById(`ytTitle_${ytProfile.id}`);
    const catEl = document.getElementById(`ytCat_${ytProfile.id}`);
    youtubeMeta = {
      title: titleEl ? titleEl.value.trim() : (post.title || ""),
      categoryId: catEl ? catEl.value : "22"
    };
    if (!youtubeMeta.title) {
      showToast("Please enter a YouTube title.", "error");
      return;
    }
  }

  showLoading();
  try {
    const payload = {
      action: "saveAutoDestinations",
      row: post.row,
      waTargets: waTargets,
      socialProfiles: smProfiles,
    };
    if (youtubeMeta) {
      payload.youtubeTitle = youtubeMeta.title;
      payload.youtubeCategoryId = youtubeMeta.categoryId;
    }
    const res = await postToBackend(payload);
    const result = await res.json();
    if (result.success) {
      showToast("Auto-share destinations saved.", "success");
      document.getElementById("combinedShareModal").classList.add("hidden");
      openPostModal(post);
    } else {
      showToast("Error: " + (result.error || "Unknown"), "error");
    }
  } catch (err) {
    showToast("Network error.", "error");
  } finally {
    hideLoading();
  }
}