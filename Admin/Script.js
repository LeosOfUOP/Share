/**
 * Admin/script.js
 */

// ---------------------------------------------------------------------------
// Session helpers — fallback if Auth.js fails to load
// ---------------------------------------------------------------------------

// ── Session (who is logged in) ───────────────────────────────────────────
const SESSION  = (function () { try { return JSON.parse(sessionStorage.getItem("auth")) || {}; } catch (e) { return {}; } })();
const IS_OWNER = SESSION.role === "owner";
const $ = (id) => document.getElementById(id);   // short helper used throughout

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
let editLockedRow = null;   // post row locked while an edit window is open
let _shareDropdownCloseListener = null;

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

const PAST_EMPTY_HIDE_MIN = 30;   // an empty slot hides this long after its start time
function slotStart(dateStr, slotLabel) {
  const m = String(slotLabel || "").match(/^(\d+):(\d+)\s*(AM|PM)$/i);
  if (!dateStr || !m) return null;
  let h = parseInt(m[1], 10);
  const p = m[3].toUpperCase();
  if (p === "PM" && h !== 12) h += 12;
  if (p === "AM" && h === 12) h = 0;
  const d = toLocalMidnight(dateStr);
  d.setHours(h, parseInt(m[2], 10), 0, 0);
  return d;
}
function emptySlotExpired(dateStr, slotLabel) {    // empty slots disappear 30 min after the start
  const s = slotStart(dateStr, slotLabel);
  return !!s && s.getTime() + PAST_EMPTY_HIDE_MIN * 60000 < Date.now();
}


// ---------------------------------------------------------------------------
// Text formatting
// The copy-text button keeps * and _ as-is; social media strips them
// ---------------------------------------------------------------------------

function formatContentPreview(text) {
  if (!text) return "";
  return escapeHTML(text)
    .replace(/\*(.*?)\*/g, "<strong>$1</strong>")
    .replace(/_(.*?)_/g,   "<em>$1</em>");
}

// Copy-text button keeps the original * and _ markup
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

async function fetchPosts() {
  const r = await api({ action: "getPosts" });
  return normalizePosts(r.posts || r);
}

async function loadSchedule(dateStr) {
  const targetDate = dateStr || formatDateYMD(new Date());
  document.getElementById("scheduleGrid").textContent = "Loading…";
  try {
    allPosts = await fetchPosts();
    renderDay(targetDate, allPosts);
    try { checkManualOverdueReminders(allPosts); } catch (e) { console.error("reminders:", e); }
  } catch (err) {
    document.getElementById("scheduleGrid").innerHTML =
      '<p style="color:red;text-align:center;">Failed to load schedule. Please refresh.</p>';
    console.error("loadSchedule error:", err);
  }
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
    if (p.shared) return false;
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
        — the slot ${escapeHTML(p.timeslot)} on ${formatDateDisplay(p.date)} has passed and the post was not shared.
        Please share it or change the slot.
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

// Four colours: pending (yellow) · approved (blue) · approved & shared (green) · rejected (red)
function postState(p) {
  if (p.status === "rejected") return "rejected";
  if (p.status === "approved" && p.shared) return "shared";
  if (p.status === "approved") return "approved";
  return "pending";
}
const STATE_LABEL = {
  pending:  { icon: "fa-clock",        text: "Pending" },
  approved: { icon: "fa-check-circle", text: "Approved" },
  shared:   { icon: "fa-share-alt",    text: "Approved & shared" },
  rejected: { icon: "fa-times-circle", text: "Rejected" }
};
function statusBadgeHTML(post) {
  const st = postState(post), s = STATE_LABEL[st];
  return `<span class="status-badge st-${st}"><i class="fas ${s.icon}"></i> ${s.text}</span>`;
}


function renderDay(dateStr, posts) {
  const today = formatDateYMD(new Date());
  const past  = dateStr < today;
  $("scheduleGrid").classList.toggle("hidden", past);
  $("pastDayList").classList.toggle("hidden", !past);
  if (past) renderPastDay(dateStr, posts); else renderScheduleGrid(dateStr, posts);
}

function renderPastDay(dateStr, posts) {
  const list = $("pastDayList");
  const dayPosts = posts.filter(p => p.date === dateStr)
    .sort((a, b) => (slotStart(dateStr, a.timeslot) || 0) - (slotStart(dateStr, b.timeslot) || 0));
  list.innerHTML = `<div class="past-day-note">${escapeHTML(formatDateDisplay(dateStr))}</div>`;
  if (!dayPosts.length) { list.innerHTML += '<div class="past-day-note">Nothing was posted on this day.</div>'; return; }
  dayPosts.forEach(p => {
    const st = postState(p);
    const card = document.createElement("div");
    card.className = "past-card st-" + st;
    card.innerHTML = `
      <div class="past-card-top">
        <span class="past-card-project"></span>${statusBadgeHTML(p)}
      </div>
      <div class="past-card-line"><i class="fas fa-clock"></i> ${escapeHTML(p.timeslot || "—")}</div>
      <div class="past-card-line"><i class="fas fa-user-check"></i> Approved by: ${escapeHTML(p.approvedBy || "—")}</div>
      <div class="past-card-line"><i class="fas fa-share-alt"></i> ${p.shared ? "Published" + (p.platforms ? " to " + escapeHTML(p.platforms) : "") : "Not published"}</div>
      <div class="past-card-text"></div>`;
    card.querySelector(".past-card-project").textContent = p.title || "Untitled";
    card.querySelector(".past-card-text").textContent = p.content || "";
    card.addEventListener("click", () => openPostModal(p));
    list.appendChild(card);
  });
}

function renderScheduleGrid(dateStr, posts) {
  const grid = $("scheduleGrid");
  const dayPosts = posts.filter(p => p.date === dateStr);
  const isToday  = dateStr === formatDateYMD(new Date());
  grid.innerHTML = "";

  const iconMap = { Morning: "fa-sunrise", Afternoon: "fa-sun", Evening: "fa-moon" };
  for (const [groupName, slots] of Object.entries(CONFIG.SLOT_GROUPS)) {
    const col = document.createElement("div");
    col.className = "time-column";
    col.innerHTML = `<div class="column-heading"><i class="fas ${iconMap[groupName] || "fa-clock"}"></i><h2>${groupName}</h2></div><div class="slot-list"></div>`;
    const slotList = col.querySelector(".slot-list");

    for (const slotLabel of slots) {
      const slotValue = CONFIG.SLOT_VALUES[slotLabel];
      const post = dayPosts.find(p => {
        const ts = normalizeSlotStr(p.timeslot);
        return ts === normalizeSlotStr(slotLabel) || ts === normalizeSlotStr(slotValue);
      });
      const isPast = isToday && isSlotPast(dateStr, slotLabel);
      const div = document.createElement("div");

      if (post) {
        div.className = `time-slot st-${postState(post)}${isPast ? " past-slot" : ""}`;
        div.innerHTML = `
          <div class="slot-time"><i class="fas fa-clock"></i> ${slotLabel}${isPast ? '<span class="past-label">Past</span>' : ""}</div>
          <div class="slot-project"><span></span></div>
          ${statusBadgeHTML(post)}`;
        div.querySelector(".slot-project span").textContent = post.title || post.project || "No project";
        div.addEventListener("click", () => openPostModal(post));
      } else {
        if (isToday && emptySlotExpired(dateStr, slotLabel)) continue;      // empty and 30 min late: hide
        div.className = `time-slot empty-slot${isPast ? " past-slot" : ""}`;
        div.innerHTML = `
          <div class="slot-time"><i class="fas fa-clock"></i> ${slotLabel}${isPast ? '<span class="past-label">Past</span>' : ""}</div>
          <span style="color:#2e7d32;font-size:0.85rem;font-weight:600;"><i class="fas fa-check-circle"></i> Available</span>`;
      }
      slotList.appendChild(div);
    }
    grid.appendChild(col);
  }
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

  if (post.album && post.album.length > 1) {
    mediaHTML = `<div class="album-grid">${post.album.map(u => `<div class="album-tile"><img loading="lazy" src="${escapeAttr(u)}" alt=""></div>`).join("")}</div>` +
                `<div class="album-count"><i class="fas fa-images"></i> Album of ${post.album.length} photos (the first one is the cover)</div>`;
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
          ${statusBadgeHTML(post)}
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
          Its time slot has passed and it was not shared.
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
      </div>
      <div class="preview-content">
        <label><i class="fas fa-align-left"></i> Content</label>
        <div class="preview-content-display">${formattedContent}</div>
        <div class="content-copy-row">
          <span class="copy-hint"><i class="fas fa-info-circle"></i> Copy content here</span>
          <button class="copy-soc-btn" id="copySocialBtn"><i class="fas fa-share-alt"></i> Social Media</button>
          <button class="copy-wa-btn" id="copyWaTextBtn"><i class="fas fa-copy"></i> WhatsApp text</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("modalPostTitle").textContent = post.title    || post.project || "No project";
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

  document.getElementById("copyWaTextBtn").addEventListener("click", () => {
    navigator.clipboard.writeText(getWhatsAppText(post.content))
      .then(() => showToast("WhatsApp text copied!", "success"))
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

  // 1) Big Share button on top (approved posts only)
  if (isApproved && CONFIG.FEATURES.ENABLE_BUFFER_PUBLISH) {
    const heroRow = document.createElement("div");
    heroRow.className = "share-hero-row";
    heroRow.appendChild(makeButton("share-hero-btn", "fa-share-alt", "Share", () => openShareModal(post)));
    btnGroup.appendChild(heroRow);
  }

  // 2) Approve / Reject
  const row1 = document.createElement("div");
  row1.className = "button-row";
  if (isPending) {
    row1.appendChild(makeButton("approve", "fa-check", "Approve", () => updateStatus(post, "approved")));
    row1.appendChild(makeButton("reject", "fa-times", "Reject", () => updateStatus(post, "rejected")));
  }
  if (isApproved) row1.appendChild(makeButton("reject", "fa-times", "Reject", () => updateStatus(post, "rejected")));
  if (isRejected) row1.appendChild(makeButton("approve", "fa-check", "Approve", () => updateStatus(post, "approved")));
  btnGroup.appendChild(row1);

  // 3) Edit (content, media and time slot), photos, download
  const row2 = document.createElement("div");
  row2.className = "button-row";
  row2.appendChild(makeButton("edit", "fa-pen", "Edit", () => openEditModal(post)));
  if (post.media && !postHasVideo(post)) row2.appendChild(makeButton("edit", "fa-images", "Add photos", () => addAlbumPhotos(post)));
  if (CONFIG.FEATURES.ENABLE_MEDIA_DOWNLOAD && post.media) {
    row2.appendChild(makeButton("download", "fa-download", "Download", () => downloadAll(post)));
  }
  btnGroup.appendChild(row2);

  // 4) Delete and Close
  const row3 = document.createElement("div");
  row3.className = "button-row";
  if (isApproved || isRejected) row3.appendChild(makeButton("delete", "fa-trash", "Delete", () => confirmDelete(post)));
  row3.appendChild(makeButton("close", "fa-times", "Close", closePostModal));
  btnGroup.appendChild(row3);

  modal.classList.remove("hidden");
}
// ---------------------------------------------------------------------------
// Share window (social media only)
// ---------------------------------------------------------------------------

function appendShareButton(container, post) {
  container.appendChild(makeButton("share-main-btn", "fa-share-alt", "Share", () => openShareModal(post)));
}

function postHasVideo(post) {
  const m = (post && post.media) || "";
  return !!m && (/\.(mp4|mov|webm|avi|m4v|3gp|mpeg|ogg)(\?|$)/i.test(m) || m.includes("/video/upload/"));
}


const YT_MAX_SECONDS = 180;
let activeVideoSecs = null;
const _videoDurationCache = {};

function getVideoDuration(url) {
  if (_videoDurationCache[url] !== undefined) return Promise.resolve(_videoDurationCache[url]);
  return new Promise(resolve => {
    const v = document.createElement("video");
    let done = false;
    const finish = d => {
      if (done) return;
      done = true; _videoDurationCache[url] = d;
      v.removeAttribute("src"); try { v.load(); } catch (e) {}
      resolve(d);
    };
    v.preload = "metadata";
    v.onloadedmetadata = () => finish(isFinite(v.duration) ? v.duration : null);
    v.onerror = () => finish(null);
    setTimeout(() => finish(null), 8000);
    v.src = url;
  });
}
function formatDuration(secs) { return Math.floor(secs / 60) + ":" + String(Math.round(secs % 60)).padStart(2, "0"); }

let shareSettings = { storyMention: "" };

async function openShareModal(post) {
  activePost = post;
  $("postModal").classList.add("hidden");
  $("combinedShareModal").classList.remove("hidden");
  $("csSmList").innerHTML = '<p style="color:#888;text-align:center;">Loading…</p>';
  try {
    const data = await api({ action: "getProfiles" });
    activeVideoSecs = postHasVideo(post) ? await getVideoDuration(post.media) : null;
    try { const ss = await api({ action: "getShareSettings" }); if (ss.success) shareSettings = ss; } catch (e) {}
    renderShareProfiles(Array.isArray(data) ? data : [], activeVideoSecs);
  } catch {
    $("csSmList").innerHTML = '<p style="color:#c62828;font-size:0.8rem;text-align:center;">Could not load profiles.</p>';
  }
}

function ttLimit() { return postHasVideo(activePost) ? CONFIG.LIMITS.TIKTOK_VIDEO_TEXT : CONFIG.LIMITS.TIKTOK_PHOTO_TEXT; }

function renderShareProfiles(profiles, videoSecs) {
  const el = $("csSmList");
  el.innerHTML = "";
  if (!profiles.length) { el.innerHTML = '<p style="color:#aaa;font-size:0.82rem;text-align:center;padding:0.4rem;">No social profiles found.</p>'; updateCsCount(); return; }

  const hasVideo  = postHasVideo(activePost);
  const ytTooLong = hasVideo && videoSecs !== null && videoSecs > YT_MAX_SECONDS;
  const albumN    = (activePost.album && activePost.album.length > 1) ? activePost.album.length : 0;
  const baseText  = getSocialText(activePost.content);
  const overTT    = baseText.length > ttLimit();
  // Instagram, Facebook and LinkedIn by default; TikTok too (photos and videos); YouTube only with a video
  const autoSelect = hasVideo ? ["instagram", "facebook", "linkedin", "youtube", "tiktok"] : ["instagram", "facebook", "linkedin", "tiktok"];

  if (albumN) {
    const n = document.createElement("div");
    n.className = "album-note";
    n.innerHTML = `<i class="fas fa-images"></i> This post is an album of <strong>${albumN}</strong> photos. Every platform gets the whole album, except Instagram, which gets the first 10${albumN > 10 ? " (of " + albumN + ")" : ""}. Stories: one story per photo.`;
    el.appendChild(n);
  }

  profiles.forEach(p => {
    const svc = (p.serviceName || "").toLowerCase();
    const pc  = getPlatformConfig(p.serviceName);
    const isYt = svc === "youtube";
    const preCheck = autoSelect.includes(svc) && !(isYt && (!hasVideo || ytTooLong));

    const item = document.createElement("label");
    item.className = "csm-item" + (preCheck ? " csm-selected" : "");
    item.innerHTML = `
      <input type="checkbox" class="cs-sm-checkbox" value="${escapeAttr(p.id)}" ${preCheck ? "checked" : ""}>
      <div class="csm-icon" style="background:${pc.color}20;color:${pc.color};"><i class="${pc.icon}"></i></div>
      <div class="csm-info"><div class="csm-name">${escapeHTML(pc.label)}</div><div class="csm-type">${escapeHTML(p.username || "")}</div></div>
      <div class="csm-check" style="${preCheck ? "background:#b34e1a;border-color:#b34e1a;" : ""}">${preCheck ? '<i class="fas fa-check"></i>' : ""}</div>`;
    item.querySelector("input").dataset.profile = JSON.stringify(p);
    el.appendChild(item);

    if (isYt && (!hasVideo || ytTooLong)) {
      const cb = item.querySelector("input");
      cb.checked = false; cb.disabled = true;
      item.style.opacity = "0.5"; item.style.cursor = "not-allowed";
      item.querySelector(".csm-type").textContent = !hasVideo ? "Needs a video (Buffer does not allow image posts on YouTube)" : "Video is over 3 minutes";
      if (ytTooLong) {
        const note = document.createElement("div");
        note.className = "yt-long-note";
        note.innerHTML = '<i class="fas fa-exclamation-triangle"></i> This video is ' + formatDuration(videoSecs) +
          ' long. Videos longer than 3 minutes <strong>must be uploaded to YouTube manually</strong> (Buffer only publishes YouTube Shorts).';
        el.appendChild(note);
      }
    }

    // Instagram / Facebook: post, post + story, or story only
    if (svc === "instagram" || svc === "facebook") {
      const box = document.createElement("div");
      box.className = "dest-box";
      box.id = "destBox_" + p.id;
      box.style.display = preCheck ? "block" : "none";
      const igNote = (svc === "instagram" && albumN > 10) ? `<div class="dest-note"><i class="fas fa-info-circle"></i> Instagram will get the first 10 of ${albumN}.</div>` : "";
      const mention = svc === "instagram"
        ? (shareSettings.storyMention
            ? `<div class="dest-note"><i class="fas fa-at"></i> Stories print <strong>@${escapeHTML(shareSettings.storyMention)}</strong> on the image. A clickable mention can't be added automatically.</div>`
            : `<div class="dest-note"><i class="fas fa-at"></i>mention thing can change only by admin.</div>`)
        : "";
      box.innerHTML = `<div class="dest-row"><label for="dest_${escapeAttr(p.id)}"><i class="fas fa-bookmark"></i> Share as</label>
        <select id="dest_${escapeAttr(p.id)}" class="yt-input"><option value="post">Post only</option><option value="both" selected>Post + Story</option><option value="story">Story only</option></select></div>${igNote}${mention}`;
      el.appendChild(box);
    }

    // TikTok: text-editing screen only when the text is over TikTok's limit
    if (svc === "tiktok" && overTT && !postHasVideoOnlyBlocked(hasVideo)) {
      const panel = document.createElement("div");
      panel.className = "tt-extras";
      panel.id = "ttExtras_" + p.id;
      panel.style.display = preCheck ? "block" : "none";
      panel.innerHTML = `<div class="yt-field"><div class="yt-field-label"><i class="fab fa-tiktok"></i> The text is longer than TikTok allows (${ttLimit()} characters). Shorten it here; the original post is not changed.</div>
        <textarea class="yt-input" id="ttText_${escapeAttr(p.id)}" rows="6"></textarea>
        <div class="tt-count" id="ttCount_${escapeAttr(p.id)}"></div></div>`;
      el.appendChild(panel);
      const ta = panel.querySelector("textarea"), cnt = panel.querySelector(".tt-count");
      ta.value = baseText;
      const upd = () => { const n = ta.value.length, ok = n <= ttLimit(); cnt.textContent = n + " / " + ttLimit(); cnt.className = "tt-count " + (ok ? "ok" : "bad"); };
      ta.addEventListener("input", upd); upd();
    }

    if (isYt) {
      const panel = document.createElement("div");
      panel.className = "yt-extras";
      panel.id = "ytExtras_" + p.id;
      panel.style.display = preCheck ? "block" : "none";
      const pid = escapeAttr(p.id);
      panel.innerHTML = `
        <div class="yt-field"><div class="yt-field-label"><i class="fab fa-youtube"></i> YouTube Title</div>
          <textarea class="yt-input" id="ytTitle_${pid}" rows="2" placeholder="Enter video title for YouTube…"></textarea></div>
        <div class="yt-field"><div class="yt-field-label"><i class="fas fa-list"></i> Category</div>
          <select class="yt-input" id="ytCat_${pid}">${YOUTUBE_CATEGORIES.map(c => `<option value="${c.id}">${escapeHTML(c.name)}</option>`).join("")}</select></div>
        <div class="yt-grid">
          <div class="yt-field"><div class="yt-field-label"><i class="fas fa-eye"></i> Privacy</div>
            <select class="yt-input" id="ytPriv_${pid}"><option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Private</option></select></div>
          <div class="yt-field"><div class="yt-field-label"><i class="fas fa-child"></i> Made for kids</div>
            <select class="yt-input" id="ytKids_${pid}"><option value="no">No</option><option value="yes">Yes</option></select></div>
          <div class="yt-field"><div class="yt-field-label"><i class="fas fa-certificate"></i> License</div>
            <select class="yt-input" id="ytLic_${pid}"><option value="youtube">Standard YouTube</option><option value="creativeCommon">Creative Commons</option></select></div>
        </div>
        <div class="yt-checks">
          <label><input type="checkbox" id="ytNotify_${pid}" checked> Notify subscribers</label>
          <label><input type="checkbox" id="ytEmbed_${pid}" checked> Allow embedding</label>
          <label><input type="checkbox" id="ytAi_${pid}"> Contains AI-generated or altered content</label>
        </div>`;
      el.appendChild(panel);
    }

    const cb = item.querySelector("input"), chk = item.querySelector(".csm-check");
    cb.addEventListener("change", () => {
      item.classList.toggle("csm-selected", cb.checked);
      chk.style.cssText = cb.checked ? "background:#b34e1a;border-color:#b34e1a;" : "";
      chk.innerHTML = cb.checked ? '<i class="fas fa-check"></i>' : "";
      ["ytExtras_", "ttExtras_", "destBox_"].forEach(pre => { const x = $(pre + p.id); if (x) x.style.display = cb.checked ? "block" : "none"; });
      updateCsCount();
    });
  });
  updateCsCount();
}
function postHasVideoOnlyBlocked() { return false; }

function updateCsCount() {
  const n = document.querySelectorAll(".cs-sm-checkbox:checked").length;
  $("csCount").textContent = n === 0 ? "Nothing selected" : `${n} destination${n !== 1 ? "s" : ""} selected`;
}

$("csCancelBtn").addEventListener("click", () => {
  $("combinedShareModal").classList.add("hidden");
  if (activePost) openPostModal(activePost);
});
$("csPublishAllBtn").addEventListener("click", publishSelected);

async function publishSelected() {
  if (!activePost) return;
  const picked = Array.from(document.querySelectorAll(".cs-sm-checkbox:checked")).map(cb => JSON.parse(cb.dataset.profile));
  const ytBad = !postHasVideo(activePost) || (activeVideoSecs !== null && activeVideoSecs > YT_MAX_SECONDS);   // YouTube: video up to 3 minutes only
  const profiles = [];
  let youtubeMeta = null;

  for (const p of picked) {
    const svc = (p.serviceName || "").toLowerCase();
    const base = { id: p.id, orgType: p.orgType, serviceName: p.serviceName, username: p.username };
    if (svc === "youtube") {
      if (ytBad) continue;
      const g = (id) => $(id + p.id);
      youtubeMeta = {
        title: g("ytTitle_") ? g("ytTitle_").value.trim() : (activePost.title || ""),
        categoryId: g("ytCat_") ? g("ytCat_").value : "22",
        privacy: g("ytPriv_") ? g("ytPriv_").value : "public",
        madeForKids: g("ytKids_") ? g("ytKids_").value === "yes" : false,
        license: g("ytLic_") ? g("ytLic_").value : "youtube",
        notifySubscribers: g("ytNotify_") ? g("ytNotify_").checked : true,
        embeddable: g("ytEmbed_") ? g("ytEmbed_").checked : true,
        aiGenerated: g("ytAi_") ? g("ytAi_").checked : false
      };
      if (!youtubeMeta.title) { showToast("Please enter a YouTube title before publishing.", "error"); return; }
      profiles.push(base);
    } else if (svc === "tiktok") {
      const ta = $("ttText_" + p.id);
      if (ta) {
        const t = ta.value.trim();
        if (!t) { showToast("TikTok text can't be empty.", "error"); return; }
        if (t.length > ttLimit()) { showToast(`TikTok text is ${t.length} characters. The limit is ${ttLimit()}.`, "error"); return; }
        base.text = t;
      }
      profiles.push(Object.assign(base, { destination: "post" }));
    } else if (svc === "instagram" || svc === "facebook") {
      const d = $("dest_" + p.id) ? $("dest_" + p.id).value : "post";
      if (d === "post" || d === "both") profiles.push(Object.assign({}, base, { destination: "post" }));
      if (d === "story" || d === "both") profiles.push(Object.assign({}, base, { destination: "story" }));
    } else {
      profiles.push(Object.assign(base, { destination: "post" }));
    }
  }
  if (!profiles.length) { showToast("Select at least one destination.", "error"); return; }

  showLoading("Sharing to social media… Please wait until the upload finishes. Don't close this page.");
  $("combinedShareModal").classList.add("hidden");
  try {
    const payload = { action: "publishToBuffer", row: activePost.row, profiles: profiles, strippedContent: getSocialText(activePost.content) };
    if (youtubeMeta) payload.youtubeMeta = youtubeMeta;
    const result = await api(payload);
    if (result.success) {
      const f = Array.isArray(result.failed) ? result.failed : [];
      showToast(f.length ? "Shared, but some failed: " + f.join("; ") : "Shared on social media!", f.length ? "error" : "success");
    } else {
      const why = Array.isArray(result.details) && result.details.length ? " (" + result.details.join("; ") + ")" : "";
      showToast("Sharing failed: " + (result.error || "") + why, "error");
    }
  } catch { showToast("Network error.", "error"); }
  hideLoading();
  await loadSchedule(getAdminDate());
  const fresh = allPosts.find(p => p.row === activePost.row);
  if (fresh) openPostModal(fresh);
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
      allPosts = await fetchPosts();
      checkManualOverdueReminders(allPosts);
      renderDay(getAdminDate(), allPosts);
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

async function openEditModal(post) {
  showLoading();
  try {
    const r = await api({ action: "lockPost", row: post.row });
    if (!r.success) { showToast(r.error || "This post can't be edited now.", "error"); return; }
  } catch (e) { showToast("Network error.", "error"); return; }
  finally { hideLoading(); }

  activePost = post; editLockedRow = post.row;
  $("postModal").classList.add("hidden");
  $("editContent").value = post.content || "";
  $("editMediaFile").value = "";
  $("mediaPreview").innerHTML = post.media && !postHasVideo(post)
    ? `<img src="${escapeAttr(post.media)}" style="max-width:100%;max-height:150px;border-radius:0.5rem;">` : "";
  $("editLockNote").classList.add("hidden");
  $("editCurrentDate").textContent = formatDateDisplay(post.date);
  $("editCurrentSlot").textContent = post.timeslot || "";
  $("editSlotDate").value = post.date || formatDateYMD(new Date());
  $("editSlotDate").min   = formatDateYMD(new Date());
  $("editModal").classList.remove("hidden");
  refreshEditSlotOptions(post);
}

async function refreshEditSlotOptions(post) {
  const sel = $("editSlotSelect"), note = $("editSlotNote");
  const targetDate = $("editSlotDate").value || post.date;
  const sameDay = targetDate === post.date;
  let taken = [];
  note.textContent = "Loading slots…";
  try {
    const posts = await fetchPosts();
    const t = toLocalMidnight(targetDate).getTime();
    taken = posts.filter(p => p.row !== post.row && p.date && p.status !== "rejected" &&
                              toLocalMidnight(p.date).getTime() === t).map(p => p.timeslot);
  } catch (err) { console.error("refreshEditSlotOptions:", err); }
  note.textContent = "";

  sel.innerHTML = `<option value="">${sameDay ? "Keep current slot (" + escapeHTML(post.timeslot || "") + ")" : "-- Select a slot --"}</option>`;
  for (const slots of Object.values(CONFIG.SLOT_GROUPS)) {
    for (const slot of slots) {
      const val       = normalizeSlotStr(slot);                 // "8:00 AM", same format the sheet uses
      const isTaken   = taken.includes(val);
      const isCurrent = sameDay && val === normalizeSlotStr(post.timeslot);
      const isPast    = isSlotPast(targetDate, slot);
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = slot + (isTaken ? " (taken)" : "") + (isCurrent ? " (current)" : "") + (isPast ? " (past)" : "");
      opt.disabled = isTaken || isCurrent;
      sel.appendChild(opt);
    }
  }
}
$("editSlotDate").addEventListener("change", () => { if (activePost) refreshEditSlotOptions(activePost); });

async function closeEditModal(unlock = true) {
  $("editModal").classList.add("hidden");
  if (unlock && editLockedRow != null) { try { await api({ action: "unlockPost", row: editLockedRow }); } catch (e) {} }
  editLockedRow = null;
}
$("cancelEditBtn").addEventListener("click", async () => {
  const post = activePost;
  await closeEditModal(true);
  if (post) openPostModal(post);
});

document.getElementById("editForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activePost) return;
  const content = $("editContent").value.trim();
  const file    = $("editMediaFile").files[0];
  const newDate = $("editSlotDate").value || activePost.date;
  const newSlot = $("editSlotSelect").value;
  const dateChanged = newDate !== activePost.date;
  if (dateChanged && !newSlot) { showToast("Choose a time slot for the new date.", "error"); return; }
  const slotChanged = dateChanged || !!newSlot;

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
      const cloudData = await (await fetch(CONFIG.CLOUDINARY.UPLOAD_URL, { method: "POST", body: fd })).json();
      if (!cloudData.secure_url) throw new Error("Media upload failed.");
      mediaUrl = cloudData.secure_url;
    }

    // Time slot first: if the slot is taken, nothing else is saved
    if (slotChanged) {
      const sr = await (await postToBackend({ action: "changeSlot", row: activePost.row,
        date: activePost.date, newSlot, newDate })).json();
      if (!sr.success) {
        $("editSlotNote").textContent = sr.error || "Could not change the time slot.";
        showToast(sr.error || "Could not change the time slot.", "error");
        return;
      }
    }

    const payload = { action: "edit", row: activePost.row, content };
    if (mediaUrl) payload.media = mediaUrl;
    const result = await (await postToBackend(payload)).json();
    if (result.success) {
      showToast(slotChanged ? "Post and time slot updated." : "Post updated.", "success");
      $("editModal").classList.add("hidden");
      $("editForm").reset();
      $("mediaPreview").innerHTML = "";
      editLockedRow = null;                       // the server cleared the lock on save
      await loadSchedule(getAdminDate());
      const fresh = allPosts.find(p => p.row === activePost.row);
      if (fresh) openPostModal(fresh);
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
  document.getElementById("currentSlotDate").textContent  = formatDateDisplay(post.date);
  document.getElementById("currentSlotValue").textContent = post.timeslot || "";
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
    const posts      = await fetchPosts();
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
  if (activePost) openPostModal(activePost);
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
      const fresh = allPosts.find(p => p.row === activePost.row);
      if (fresh) openPostModal(fresh);          // stay on the post's window
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
// ---------------------------------------------------------------------------
// Projects modal
// ---------------------------------------------------------------------------

async function openProjectsModal() {
  $("projectsModal").classList.remove("hidden");
  $("projectAddWrap").classList.add("hidden");
  $("newProjectToggle").classList.remove("hidden");
  await loadProjects();
}
async function loadProjects() {
  const list = $("projectsList");
  list.innerHTML = '<p style="color:#888;text-align:center;">Loading…</p>';
  try { renderProjectsList(await (await fetch(`${CONFIG.SCRIPT_URL}?action=getProjects`)).json()); }
  catch (err) { list.innerHTML = '<p style="color:#c62828;">Failed to load projects.</p>'; }
}
function renderProjectsList(projects) {
  const list = $("projectsList");
  list.innerHTML = "";
  if (!Array.isArray(projects) || !projects.length) { list.innerHTML = '<p style="color:#aaa;text-align:center;padding:1rem;">No projects yet.</p>'; return; }
  projects.forEach(p => {
    const status = ["ongoing", "tobe", "completed"].includes(p.status) ? p.status : "ongoing";
    const item = document.createElement("div");
    item.className = "project-list-item";
    item.innerHTML = `
      <span class="project-dot" style="background:${escapeAttr(p.color)};"></span>
      <button type="button" class="project-name project-name-btn" title="Tap to rename"></button>
      <select class="project-status-select ${status}" aria-label="Project status">
        <option value="ongoing">Ongoing</option><option value="tobe">To Be</option><option value="completed">Completed</option>
      </select>
      <div class="project-actions"><button class="proj-delete-btn" title="Remove"><i class="fas fa-trash"></i></button></div>`;
    const nameBtn = item.querySelector(".project-name");
    nameBtn.innerHTML = '<span></span> <i class="fas fa-pen"></i>';
    nameBtn.querySelector("span").textContent = p.name;
    nameBtn.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "text"; input.className = "edit-input project-rename-input"; input.value = p.name; input.maxLength = 80;
      nameBtn.replaceWith(input); input.focus(); input.select();
      let done = false;
      const finish = async (save) => {
        if (done) return; done = true;
        const v = input.value.trim();
        if (!save || !v || v === p.name) { loadProjects(); return; }
        const r = await api({ action: "updateProject", row: p.row, name: v, status: sel.value, color: p.color });
        if (r.success) showToast("Renamed. Users and posts were updated too.", "success"); else showToast(r.error || "Could not rename.", "error");
        loadProjects();
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
      input.addEventListener("blur", () => finish(true));
    });
    const sel = item.querySelector("select");
    sel.value = status;
    sel.addEventListener("change", async () => {
      sel.className = "project-status-select " + sel.value;
      const r = await api({ action: "updateProject", row: p.row, name: p.name, status: sel.value, color: p.color });
      if (r.success) showToast(sel.value === "completed" ? "Project marked Completed." : "Status saved.", "success");
      else { showToast(r.error || "Could not save.", "error"); loadProjects(); }
    });
    item.querySelector(".proj-delete-btn").addEventListener("click", async () => {
      if (!confirm(`Remove project "${p.name}"?`)) return;
      await api({ action: "removeProject", row: p.row });
      await loadProjects();
    });
    list.appendChild(item);
  });
}
document.getElementById("cancelProjectsBtn").addEventListener("click", () => {
  document.getElementById("projectsModal").classList.add("hidden");
});
document.getElementById("newProjectToggle").addEventListener("click", () => { document.getElementById("projectAddWrap").classList.remove("hidden"); document.getElementById("newProjectToggle").classList.add("hidden"); document.getElementById("newProjectName").focus(); });
document.getElementById("cancelNewProjectBtn").addEventListener("click", () => { document.getElementById("projectAddWrap").classList.add("hidden"); document.getElementById("newProjectToggle").classList.remove("hidden"); });

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
      document.getElementById("projectAddWrap").classList.add("hidden");
      document.getElementById("newProjectToggle").classList.remove("hidden");
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

// ---------------------------------------------------------------------------
// Admin header, profile menu, Owner Tools, quick scan
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Small helpers used by the header, Owner Tools and password window
// ---------------------------------------------------------------------------
async function api(payload) {
  const res  = await postToBackend(payload);
  const data = await res.json();
  if (data && data.success === false && /log in again|invalid session|expired/i.test(data.error || "")) {
    clearSession(); location.replace("../User/Submit.html");
  }
  return data;
}

// ---------------------------------------------------------------------------
// Header: welcome, profile menu, paused banner
// ---------------------------------------------------------------------------
function renderHeader() {
  $("welcomeText").textContent = "Welcome, " + (SESSION.name || (IS_OWNER ? "Owner" : "Admin"));
  $("profileMenuName").textContent = SESSION.name || "Admin";
  $("profileMenuRole").textContent = [IS_OWNER ? "Owner" : "Admin", SESSION.clubRole && SESSION.clubRole !== "Owner" ? SESSION.clubRole : ""].filter(Boolean).join(" · ");
  if (IS_OWNER) { $("ownerToolsBtn").classList.remove("hidden"); $("pmOwnerBtn").classList.remove("hidden"); $("diagFullLink").classList.remove("hidden"); }
  api({ action: "getContact" }).then(r => {
    const link = $("adminMailLink");
    if (r && r.whatsapp) { link.href = "https://wa.me/" + r.whatsapp; link.target = "_blank"; link.rel = "noopener"; }
  }).catch(() => {});
}

function setPausedUI(paused) {
  $("pausedBanner").classList.toggle("hidden", !paused);
  const btn = $("ownerPauseBtn"), lbl = $("pauseBtnLabel");
  if (btn && lbl) { lbl.textContent = paused ? "Resume System" : "Pause System"; btn.classList.toggle("is-paused", !!paused); }
}
async function loadPausedState() {
  try {
    const r = await fetch(`${CONFIG.SCRIPT_URL}?action=getSystemPaused`);
    setPausedUI(!!(await r.json()).paused);
  } catch (e) { /* the quick scan will report a connection problem */ }
}

const profileMenu = $("profileMenu");
$("profileBtn").addEventListener("click", (e) => { e.stopPropagation(); profileMenu.classList.toggle("hidden"); $("diagPopup").classList.add("hidden"); });
document.addEventListener("click", (e) => {
  if (!profileMenu.classList.contains("hidden") && !profileMenu.contains(e.target)) profileMenu.classList.add("hidden");
  const pop = $("diagPopup");
  if (!pop.classList.contains("hidden") && !pop.contains(e.target) && !$("diagDot").contains(e.target)) pop.classList.add("hidden");
});
function goToSubmit(where) { sessionStorage.setItem("goto", where); sessionStorage.setItem("fromAdmin", "1"); location.href = "../User/Submit.html"; }
$("pmSwitchBtn").addEventListener("click",  () => goToSubmit("picker"));
$("pmHistoryBtn").addEventListener("click", () => goToSubmit("history"));
$("pmPasswordBtn").addEventListener("click", () => { profileMenu.classList.add("hidden"); openPasswordModal(); });
$("pmOwnerBtn").addEventListener("click",   () => { profileMenu.classList.add("hidden"); openOwnerTools(); });
$("pmLogoutBtn").addEventListener("click",  () => { clearSession(); location.replace("../User/Submit.html"); });
$("ownerToolsBtn").addEventListener("click", openOwnerTools);

// ---------------------------------------------------------------------------
// Quick scan (runs by itself when the page opens). Dot: green / yellow / red.
// ---------------------------------------------------------------------------
let quickScanResults = null;
async function runQuickScan() {
  const dot = $("diagDot");
  dot.className = "diag-dot diag-pending";
  try {
    const d = await api({ action: "quickScan" });
    if (!d.success) throw new Error(d.error || "Scan failed");
    quickScanResults = d.results || [];
  } catch (e) {
    quickScanResults = [{ group: "Connection", name: "Backend", level: "error", detail: "Could not reach the server: " + (e.message || e) }];
  }
  const worst = quickScanResults.some(r => r.level === "error") ? "error" : quickScanResults.some(r => r.level === "warn") ? "warn" : "ok";
  dot.className = "diag-dot diag-" + worst;
  dot.title = worst === "ok" ? "All fine" : worst === "warn" ? "Small issue" : "Critical issue";
  renderDiagPopup(worst);
}
function renderDiagPopup(worst) {
  const issues = (quickScanResults || []).filter(r => r.level !== "ok");
  $("diagTitle").textContent = worst === "ok" ? "All fine" : worst === "warn" ? "Small issue" : "Critical issue";
  const icon = { ok: "fa-check-circle", warn: "fa-exclamation-triangle", error: "fa-times-circle" };
  $("diagList").innerHTML = issues.length
    ? issues.map(r => `<div class="diag-item ${r.level}"><i class="fas ${icon[r.level]}"></i><div><div class="diag-name">${escapeHTML(r.name)}</div><div class="diag-detail">${escapeHTML(r.detail)}</div></div></div>`).join("")
    : `<div class="diag-item ok"><i class="fas ${icon.ok}"></i><div><div class="diag-detail">Everything checked is working.</div></div></div>`;
}
$("diagDot").addEventListener("click", (e) => { e.stopPropagation(); profileMenu.classList.add("hidden"); $("diagPopup").classList.toggle("hidden"); });
$("diagClose").addEventListener("click", () => $("diagPopup").classList.add("hidden"));


// ---------------------------------------------------------------------------
// Owner Tools: admins + club roles, role lists, sheets, pause switch
// ---------------------------------------------------------------------------
const setMsg = (id, text, ok) => { const el = $(id); el.textContent = text || ""; el.className = "cp-msg" + (text ? (ok ? " ok" : " err") : ""); };

function showOwnerView(name) {
  $("ownerMenuView").classList.toggle("hidden", name !== "menu");
  document.querySelectorAll(".owner-view").forEach(v => v.classList.toggle("hidden", v.id !== "ownerView_" + name));
  $("ownerModal").querySelector(".modal-content").scrollTop = 0;
}
async function openOwnerTools() {
  if (!IS_OWNER) return;
  $("ownerModal").classList.remove("hidden");
  showOwnerView("menu");
  setMsg("wlMsg", ""); setMsg("rolesMsg", ""); setMsg("ntMsg", "");
  loadAdminEntries();
  loadRoleLists();
  loadSheetLinks();
  loadPausedState();
}
document.querySelectorAll("#ownerModal .owner-line[data-view]").forEach(b => b.addEventListener("click", () => {
  showOwnerView(b.dataset.view);
  if (b.dataset.view === "notify") loadNotify();
}));
document.querySelectorAll("#ownerModal [data-ownerback]").forEach(b => b.addEventListener("click", () => showOwnerView("menu")));
document.querySelectorAll("#ownerModal .owner-line[data-list]").forEach(b => b.addEventListener("click", () => openDirectory(b.dataset.list)));
$("ownerClose").addEventListener("click", () => $("ownerModal").classList.add("hidden"));

async function loadAdminEntries() {
  const list = $("wlList");
  list.innerHTML = '<p class="owner-hint">Loading…</p>';
  try {
    const d = await api({ action: "getAdminEntries" });
    if (!d.success) { list.innerHTML = `<p class="owner-hint">${escapeHTML(d.error || "Could not load.")}</p>`; return; }
    const sel = $("wlRole"), keep = sel.value;
    sel.innerHTML = '<option value="">Club role…</option>' + (d.clubRoles || []).map(r => `<option>${escapeHTML(r)}</option>`).join("");
    if (keep) sel.value = keep;
    if (!d.entries.length) { list.innerHTML = '<p class="owner-hint">No admins added yet.</p>'; return; }
    list.innerHTML = "";
    d.entries.forEach(en => {
      const sub = en.account
        ? `${en.account.name || "Account"} · ${en.account.email || en.account.phone || ""}`
        : "No account yet — takes effect when this person registers";
      const row = document.createElement("div");
      row.className = "wl-item";
      row.innerHTML = `<div class="wl-main"><div class="wl-id"></div><div class="wl-sub"></div></div>
        <span class="wl-role"></span><button class="wl-remove" title="Remove" type="button"><i class="fas fa-times"></i></button>`;
      row.querySelector(".wl-id").textContent = en.id;
      row.querySelector(".wl-sub").textContent = sub;
      row.querySelector(".wl-role").textContent = en.role;
      row.querySelector(".wl-remove").addEventListener("click", async () => {
        if (!confirm(`Remove ${en.id}? They lose admin rights and their club role.`)) return;
        const r = await api({ action: "removeAdminEntry", id: en.id });
        if (r.success) loadAdminEntries(); else setMsg("wlMsg", r.error || "Could not remove.", false);
      });
      list.appendChild(row);
    });
  } catch (e) { list.innerHTML = '<p class="owner-hint">Network error.</p>'; }
}
$("wlAddBtn").addEventListener("click", async () => {
  const id = $("wlId").value.trim(), role = $("wlRole").value;
  if (!id) return setMsg("wlMsg", "Enter a phone number or email.", false);
  if (!role) return setMsg("wlMsg", "Choose a club role.", false);
  const r = await api({ action: "setAdminEntry", id, role });
  if (r.success) { $("wlId").value = ""; setMsg("wlMsg", "Added.", true); loadAdminEntries(); }
  else setMsg("wlMsg", r.error || "Could not add.", false);
});

async function loadRoleLists() {
  try {
    const d = await (await fetch(`${CONFIG.SCRIPT_URL}?action=getRoles`)).json();
    $("rolesProject").value = (d.projectRoles || []).join("\n");
    $("rolesClub").value    = (d.clubRoles || []).join("\n");
  } catch (e) { setMsg("rolesMsg", "Could not load the role lists.", false); }
}
$("rolesSaveBtn").addEventListener("click", async () => {
  const lines = (id) => $(id).value.split("\n").map(s => s.trim()).filter(Boolean);
  const r = await api({ action: "saveRoles", projectRoles: lines("rolesProject"), clubRoles: lines("rolesClub") });
  if (r.success) { setMsg("rolesMsg", "Roles saved.", true); loadAdminEntries(); }
  else setMsg("rolesMsg", r.error || "Could not save.", false);
});

async function loadSheetLinks() {
  try {
    const d = await api({ action: "getSheetUrls" });
    if (!d.success) return;
    const labels = { Database: "Posts", Projects: "Projects", Users: "Users", ActivityLog: "Activity Log" };
    $("ownerSheetLinks").innerHTML = Object.entries(d.urls || {}).map(([n, u]) =>
      `<a href="${escapeAttr(u)}" target="_blank" rel="noopener"><i class="fas fa-table"></i> ${escapeHTML(labels[n] || n)}</a>`).join("");
  } catch (e) {}
}

$("ownerPauseBtn").addEventListener("click", async () => {
  const paused = !$("pausedBanner").classList.contains("hidden");
  if (!paused && !confirm("Pause the system? Normal users will see the maintenance message.")) return;
  const r = await api({ action: "setSystemPaused", paused: !paused });
  if (r.success) { setPausedUI(!!r.paused); showToast(r.paused ? "System paused." : "System resumed.", "success"); runQuickScan(); }
  else showToast(r.error || "Could not change the pause switch.", "error");
});

// ---------------------------------------------------------------------------
// Change password
// ---------------------------------------------------------------------------
function openPasswordModal() {
  ["cpOld", "cpNew", "cpConfirm"].forEach(id => $(id).value = "");
  setMsg("cpMsg", "");
  $("passwordModal").classList.remove("hidden");
}
$("cpCancelBtn").addEventListener("click", () => $("passwordModal").classList.add("hidden"));
$("cpSaveBtn").addEventListener("click", async () => {
  const o = $("cpOld").value, n = $("cpNew").value, c = $("cpConfirm").value;
  if (!o || !n) return setMsg("cpMsg", "Fill in all fields.", false);
  if (n.length < 8) return setMsg("cpMsg", "New password must be at least 8 characters.", false);
  if (n !== c) return setMsg("cpMsg", "The new passwords don't match.", false);
  try {
    const r = await api({ action: "changePassword", oldPassword: o, newPassword: n });
    if (r.success) { setMsg("cpMsg", "Password changed.", true); setTimeout(() => $("passwordModal").classList.add("hidden"), 1000); }
    else setMsg("cpMsg", r.error || "Could not change the password.", false);
  } catch (e) { setMsg("cpMsg", "Network error.", false); }
});


window.addEventListener("pagehide", () => {                       // free the edit lock if the page is closed mid-edit
  if (editLockedRow != null) {
    const sess = getSession();
    try { fetch(CONFIG.SCRIPT_URL, { method: "POST", keepalive: true, headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "unlockPost", row: editLockedRow, token: sess && sess.token }) }); } catch (e) {}
  }
});

renderHeader();
loadPausedState();
runQuickScan();

// ---------------------------------------------------------------------------
// Back buttons that press the window's own Cancel / Close button
// ---------------------------------------------------------------------------
document.querySelectorAll("[data-click]").forEach(b => b.addEventListener("click", () => { const t = $(b.dataset.click); if (t) t.click(); }));

// ---------------------------------------------------------------------------
// Albums: add photos (admin, up to TikTok's 35), download every photo
// ---------------------------------------------------------------------------
async function uploadImageToCloudinary(file) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("upload_preset", CONFIG.CLOUDINARY.UPLOAD_PRESET);
  const d = await (await fetch(CONFIG.CLOUDINARY.UPLOAD_URL, { method: "POST", body: fd })).json();
  if (!d.secure_url) throw new Error((d.error && d.error.message) || "Upload failed.");
  return d.secure_url;
}

function addAlbumPhotos(post) {
  const have = (post.album && post.album.length > 1) ? post.album.length : (post.media ? 1 : 0);
  const max = CONFIG.APP.ALBUM_ADMIN_MAX_IMAGES || 35;
  const inp = document.createElement("input");
  inp.type = "file"; inp.multiple = true; inp.accept = "image/*";
  inp.addEventListener("change", async () => {
    const files = Array.from(inp.files || []);
    if (!files.length) return;
    if (have + files.length > max) { showToast(`An album can hold at most ${max} photos. This one has ${have}.`, "error"); return; }
    const big = files.find(f => f.size > CONFIG.APP.MAX_IMAGE_SIZE_MB * 1024 * 1024);
    if (big) { showToast(`"${big.name}" is over ${CONFIG.APP.MAX_IMAGE_SIZE_MB} MB.`, "error"); return; }
    showLoading("Uploading photos… 0 of " + files.length);
    try {
      const urls = [];
      for (let i = 0; i < files.length; i++) {
        showLoading(`Uploading photos… ${i + 1} of ${files.length}`);
        urls.push(await uploadImageToCloudinary(files[i]));
      }
      const r = await api({ action: "addAlbumPhotos", row: post.row, urls: urls });
      hideLoading();
      if (r.success) {
        showToast(`Added. The album now has ${r.count} photos.`, "success");
        await loadSchedule(getAdminDate());
        const fresh = allPosts.find(p => p.row === post.row);
        if (fresh) openPostModal(fresh);
      } else showToast(r.error || "Could not add the photos.", "error");
    } catch (e) { hideLoading(); showToast("Upload failed: " + e.message, "error"); }
  });
  inp.click();
}

async function downloadAll(post) {
  const urls = (post.album && post.album.length > 1) ? post.album : [post.media];
  for (const u of urls) { await downloadMedia(u); await new Promise(r => setTimeout(r, 400)); }
}

// ---------------------------------------------------------------------------
// In-app lists (owner): projects, users, posts, activity log — each with a search box
// ---------------------------------------------------------------------------
const LIST_META = {
  projects: { title: "Projects", icon: "fa-folder-open", ph: "Search projects or people…" },
  users:    { title: "Users",    icon: "fa-users",       ph: "Search by name, phone or email…" },
  posts:    { title: "Posts",    icon: "fa-file-alt",    ph: "Search posts, projects, people…" },
  activity: { title: "Activity log", icon: "fa-stream",  ph: "Search the log…" }
};
let _listKind = "projects", _listTimer = null, _listData = [], _listDetail = false;

function openDirectory(kind) {
  _listKind = kind; _listDetail = false;
  const m = LIST_META[kind];
  $("listTitle").innerHTML = `<i class="fas ${m.icon}"></i> ${m.title}`;
  $("listSearch").placeholder = m.ph;
  $("listSearch").value = "";
  $("listSearch").classList.remove("hidden");
  showOwnerView("list");
  loadDirectory();
}
async function loadDirectory() {
  const body = $("listBody");
  body.innerHTML = '<p class="owner-hint">Loading…</p>';
  try {
    const r = await api({ action: "getDirectory", kind: _listKind, query: $("listSearch").value.trim() });
    if (!r.success) { body.innerHTML = `<p class="owner-hint">${escapeHTML(r.error || "Could not load.")}</p>`; return; }
    _listData = r.items || [];
    renderDirectory();
  } catch (e) { body.innerHTML = '<p class="owner-hint">Network error.</p>'; }
}
$("listSearch").addEventListener("input", () => { clearTimeout(_listTimer); _listTimer = setTimeout(loadDirectory, 350); });
$("listBackBtn").addEventListener("click", () => { if (_listDetail) { _listDetail = false; $("listSearch").classList.remove("hidden"); renderDirectory(); } else showOwnerView("menu"); });

const dirBadge = (t, cls) => `<span class="dir-badge ${cls || ""}">${escapeHTML(t)}</span>`;
function renderDirectory() {
  const body = $("listBody");
  if (!_listData.length) { body.innerHTML = '<p class="owner-hint">Nothing found.</p>'; return; }
  body.innerHTML = "";
  _listData.forEach(it => {
    const card = document.createElement("div");
    card.className = "dir-card";
    if (_listKind === "users") {
      card.innerHTML = `<div class="dir-title">${escapeHTML(it.name || "(no name)")} ${it.clubRole ? dirBadge(it.clubRole, "gold") : ""} ${it.role !== "user" ? dirBadge(it.role) : ""}</div>
        <div class="dir-line"><i class="fas fa-phone"></i> ${escapeHTML(it.phone)}</div>
        <div class="dir-line"><i class="fas fa-envelope"></i> ${escapeHTML(it.email || "—")}</div>
        <div class="dir-line"><i class="fas fa-folder"></i> ${(it.projects || []).map(p => escapeHTML(p.project) + " (" + escapeHTML(p.role) + ")").join(", ") || "No projects"}</div>`;
    } else if (_listKind === "projects") {
      card.classList.add("clickable");
      card.innerHTML = `<div class="dir-title"><span class="project-dot" style="background:${escapeAttr(it.color)}"></span> ${escapeHTML(it.name)} ${dirBadge(it.status)}</div>
        <div class="dir-line"><i class="fas fa-users"></i> ${it.members.length} member${it.members.length === 1 ? "" : "s"} · tap for details</div>`;
      card.addEventListener("click", () => openProjectDetail(it));
    } else if (_listKind === "posts") {
      card.innerHTML = `<div class="dir-title">${escapeHTML(it.project)} ${dirBadge(it.status, "st-" + it.status)} ${it.shared ? dirBadge("Shared", "green") : ""}</div>
        <div class="dir-line"><i class="fas fa-calendar-day"></i> ${escapeHTML(it.date)} · ${escapeHTML(it.timeslot)}</div>
        <div class="dir-line"><i class="fas fa-user"></i> ${escapeHTML(it.author)}${it.platforms ? " · " + escapeHTML(it.platforms) : ""}</div>
        <div class="dir-text">${escapeHTML(it.content)}</div>`;
    } else {
      card.innerHTML = `<div class="dir-title">${escapeHTML(it.action)} ${dirBadge(it.role || "—")}</div>
        <div class="dir-line"><i class="fas fa-user"></i> ${escapeHTML(it.name || it.phone || "—")}</div>
        <div class="dir-line"><i class="fas fa-clock"></i> ${escapeHTML(new Date(it.time).toLocaleString())}</div>
        ${it.detail ? `<div class="dir-text">${escapeHTML(it.detail)}</div>` : ""}`;
    }
    body.appendChild(card);
  });
}

async function openProjectDetail(p) {
  _listDetail = true;
  $("listSearch").classList.add("hidden");
  const body = $("listBody");
  const lead = p.members.filter(m => /chair|director/i.test(m.role));
  const rest = p.members.filter(m => !lead.includes(m));
  const row = (m) => `<div class="dir-line"><i class="fas fa-user"></i> <strong>${escapeHTML(m.name || m.phone)}</strong> · ${escapeHTML(m.role)} <span class="dir-sub">${escapeHTML(m.phone)}</span></div>`;
  body.innerHTML = `<div class="dir-card"><div class="dir-title"><span class="project-dot" style="background:${escapeAttr(p.color)}"></span> ${escapeHTML(p.name)} ${dirBadge(p.status)}</div></div>
    <h5 class="dir-h">Chair / Director</h5>${lead.length ? lead.map(row).join("") : '<p class="owner-hint">No chair or director listed.</p>'}
    <h5 class="dir-h">Other members</h5>${rest.length ? rest.map(row).join("") : '<p class="owner-hint">No other members.</p>'}
    <h5 class="dir-h">Posts</h5><div id="projPosts"><p class="owner-hint">Loading…</p></div>`;
  try {
    const r = await api({ action: "getDirectory", kind: "projectPosts", project: p.name });
    const box = $("projPosts");
    if (!r.success || !r.items.length) { box.innerHTML = '<p class="owner-hint">No posts yet.</p>'; return; }
    box.innerHTML = r.items.map(x => `<div class="dir-card"><div class="dir-title">${escapeHTML(x.date)} · ${escapeHTML(x.timeslot)} ${dirBadge(x.status, "st-" + x.status)} ${x.shared ? dirBadge("Shared", "green") : ""}</div>
      <div class="dir-line"><i class="fas fa-user"></i> ${escapeHTML(x.author)}</div><div class="dir-text">${escapeHTML(x.content)}</div></div>`).join("");
  } catch (e) { $("projPosts").innerHTML = '<p class="owner-hint">Network error.</p>'; }
}

// ---------------------------------------------------------------------------
// Email notifications (owner)
// ---------------------------------------------------------------------------
async function loadNotify() {
  try {
    const r = await api({ action: "getNotify" });
    if (!r.success) { setMsg("ntMsg", r.error || "Could not load.", false); return; }
    $("ntRoles").innerHTML = r.roles.map((x, i) => `<label class="nt-role"><input type="checkbox" data-role="${escapeAttr(x.role)}" ${x.on ? "checked" : ""}> ${escapeHTML(x.role)}</label>`).join("");
    $("ntExtra").value = (r.extra || []).join("\n");
    $("ntStory").value = r.storyMention || "";
    $("ntQuota").textContent = "Emails left today: " + r.quota + " (a Gmail account can send about 100 recipients per day).";
  } catch (e) { setMsg("ntMsg", "Network error.", false); }
}
$("ntSaveBtn").addEventListener("click", async () => {
  const roles = Array.from(document.querySelectorAll("#ntRoles input:checked")).map(i => i.dataset.role);
  const extra = $("ntExtra").value.split("\n").map(s => s.trim()).filter(Boolean);
  const r = await api({ action: "saveNotify", roles: roles, extra: extra, storyMention: $("ntStory").value.trim() });
  if (r.success) { setMsg("ntMsg", "Saved.", true); loadNotify(); } else setMsg("ntMsg", r.error || "Could not save.", false);
});

// ---------------------------------------------------------------------------
// Profile-change requests (admins and the owner)
// ---------------------------------------------------------------------------
async function refreshProfileReqCount() {
  try {
    const r = await api({ action: "getProfileRequests" });
    const n = r.success ? r.requests.length : 0;
    $("profileReqCount").textContent = n; $("profileReqCount").classList.toggle("hidden", !n);
    return r;
  } catch (e) { return null; }
}
async function openProfileRequests() {
  $("profileReqModal").classList.remove("hidden");
  const box = $("profileReqList");
  box.innerHTML = '<p class="owner-hint">Loading…</p>';
  const r = await refreshProfileReqs_();
  if (!r || !r.success) { box.innerHTML = '<p class="owner-hint">Could not load.</p>'; return; }
  if (!r.requests.length) { box.innerHTML = '<p class="owner-hint">No requests waiting.</p>'; return; }
  box.innerHTML = "";
  r.requests.forEach(q => {
    const lines = [];
    if (q.request.name)  lines.push(`<div class="dir-line"><i class="fas fa-user"></i> Name: ${escapeHTML(q.name)} → <strong>${escapeHTML(q.request.name)}</strong></div>`);
    if (q.request.email) lines.push(`<div class="dir-line"><i class="fas fa-envelope"></i> Email: ${escapeHTML(q.email || "—")} → <strong>${escapeHTML(q.request.email)}</strong> <span class="dir-sub">(code verified)</span></div>`);
    if (q.request.phone) lines.push(`<div class="dir-line"><i class="fas fa-phone"></i> Phone: ${escapeHTML(q.phone)} → <strong>${escapeHTML(q.request.phone)}</strong></div>`);
    const card = document.createElement("div");
    card.className = "dir-card";
    card.innerHTML = `<div class="dir-title">${escapeHTML(q.name || q.phone)}</div>${lines.join("")}
      <div class="button-group" style="justify-content:center;margin-top:0.5rem;"><button type="button" class="approve"><i class="fas fa-check"></i> Approve</button><button type="button" class="reject"><i class="fas fa-times"></i> Reject</button></div>`;
    const [ok, no] = card.querySelectorAll("button");
    const decide = async (approve) => {
      const d = await api({ action: "decideProfileRequest", phone: q.phone, approve: approve });
      if (d.success) { showToast(approve ? "Approved." : "Rejected.", "success"); openProfileRequests(); }
      else showToast(d.error || "Could not save.", "error");
    };
    ok.addEventListener("click", () => decide(true)); no.addEventListener("click", () => decide(false));
    box.appendChild(card);
  });
}
async function refreshProfileReqs_() { const r = await refreshProfileReqCount(); return r; }
$("profileReqBtn").addEventListener("click", openProfileRequests);
$("profileReqBack").addEventListener("click", () => $("profileReqModal").classList.add("hidden"));
refreshProfileReqCount();