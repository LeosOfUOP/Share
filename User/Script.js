/**
 * User/Script.js
 * Submit form logic: date picker, slot picker, media upload, form submit.
 * Also contains _showMainApp() which must be defined before Auth.js runs.
 *
 * Load order in Submit.html:
 *   1. Config.js
 *   2. Script.js   ← defines _showMainApp before Auth runs
 *   3. Auth.js     ← calls initAuth() immediately
 */

// ---------------------------------------------------------------------------
// Session helpers (fallback if Auth.js not yet loaded)
// ---------------------------------------------------------------------------
if (typeof getSession === "undefined") {
  window.getSession   = function() { try { return JSON.parse(sessionStorage.getItem("auth")); } catch(e) { return null; } };
  window.clearSession = function() { sessionStorage.removeItem("auth"); };
}

// ---------------------------------------------------------------------------
// Loading overlay
// ---------------------------------------------------------------------------
const _overlay = document.getElementById("loadingOverlay");
function showLoading(msg) {
  const t = _overlay?.querySelector(".loading-text");
  if (t) t.textContent = msg || "Processing… Please wait";
  _overlay?.classList.add("active");
}
function hideLoading() { _overlay?.classList.remove("active"); }

// ---------------------------------------------------------------------------
// _showMainApp — called by Auth.js after successful login/project selection
// ---------------------------------------------------------------------------
function _showMainApp(session) {

  ["phoneScreen","otpScreen","registerScreen","projectPickerScreen","adminChoiceScreen"]
    .forEach(id => { const el = document.getElementById(id); if (el) el.classList.add("hidden"); });

  // Hide all auth screens, show main form
  document.getElementById("mainSubmitForm").classList.remove("hidden");

  // Show nav bar
  const nav = document.getElementById("postLoginNav");
  if (nav) nav.style.display = "flex";

  // Populate nav info
  const nameEl = document.getElementById("navUserName");
  if (nameEl) nameEl.textContent = session.name || "User";

  const proj = session.activeProject;
  const badgeEl = document.getElementById("navProjectBadge");
  if (badgeEl && proj) {
    badgeEl.textContent = proj.project + (proj.role ? " — " + proj.role : "");
  }

  // Show Admin Panel link only for admin/owner (nav only — no floating button)
  if (session.role === "admin" || session.role === "owner") {
    const adminBtn = document.getElementById("navAdminBtn");
    if (adminBtn) adminBtn.style.display = "inline-flex";
  }

  // Pre-fill hidden author field
  const authorEl = document.getElementById("author");
  if (authorEl) {
    authorEl.value = (session.name || "") +
      (proj && proj.role ? " — " + proj.role : "");
  }

  // Lock project dropdown to the user's active project
  if (proj && proj.project) {
    const sel = document.getElementById("projectSelect");
    if (sel) {
      const lockProject = () => {
        sel.value = proj.project;
        if (!sel.value) {
          const opt = document.createElement("option");
          opt.value       = proj.project;
          opt.textContent = proj.project;
          sel.appendChild(opt);
          sel.value = proj.project;
        }
        sel.disabled = true;
      };
      lockProject();
      setTimeout(lockProject, 1500);
    }
  }

  // Logout button
  document.getElementById("navLogoutBtn")?.addEventListener("click", () => {
    clearSession();
    location.reload();
  });

  // Switch Project button — show picker again
  document.getElementById("navSwitchProjectBtn")?.addEventListener("click", () => {
    document.getElementById("mainSubmitForm").classList.add("hidden");
    nav.style.display = "none";
    // Re-open project picker (bypasses auto-select since user explicitly clicked switch)
    const screen = document.getElementById("projectPickerScreen");
    if (screen) {
      screen.classList.remove("hidden");
      _loadPickerForcefully();
    }
  });

  // Init the form UI
  initDatePicker();
  loadProjects();
}

// Load picker without auto-selecting single project (for manual switching)
async function _loadPickerForcefully() {
  const container = document.getElementById("projectPickerList");
  if (!container) return;
  container.innerHTML = "";
  const session  = getSession();
  const projects = session?.projects || [];
  projects.forEach(p => {
    const btn = document.createElement("button");
    btn.className = "project-picker-item";
    btn.innerHTML = `<i class="fas fa-folder"></i> ${_escHtml(p.project)} — ${_escHtml(p.role)}`;
    btn.addEventListener("click", () => {
      document.getElementById("projectPickerScreen").classList.add("hidden");
      // Update active project
      if (session) {
        session.activeProject = { project: p.project, role: p.role };
        sessionStorage.setItem("auth", JSON.stringify(session));
      }
      _showMainApp(session);
    });
    container.appendChild(btn);
  });
  // Populate add-project dropdown
  const sel = document.getElementById("pickerAddProjectSelect");
  if (sel) await _populateProjectSelect(sel, "");
}

async function _populateProjectSelect(sel, selectedVal) {
  try {
    const res      = await fetch(`${CONFIG.SCRIPT_URL}?action=getProjects`);
    const projects = await res.json();
    sel.innerHTML  = '<option value="">-- Project --</option>' +
      projects.map(p => `<option value="${_escHtml(p.name)}">${_escHtml(p.name)}</option>`).join("");
    if (selectedVal) sel.value = selectedVal;
  } catch(e) { console.error("_populateProjectSelect error", e); }
}

function _escHtml(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ---------------------------------------------------------------------------
// Date picker
// ---------------------------------------------------------------------------

function initDatePicker() {
  const container = document.getElementById("datePicker");
  if (!container) return;
  container.innerHTML = "";

  const today = new Date();
  const btns  = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const btn = document.createElement("button");
    btn.type         = "button";
    btn.className    = "date-btn" + (i === 0 ? " today" : "");
    btn.dataset.date = formatDateYMD(d);
    btn.innerHTML = `
      <span class="day-name">${d.toLocaleDateString(undefined,{weekday:"short"})}</span>
      <span class="day-num">${d.getDate()}</span>
      <span class="month-name">${d.toLocaleDateString(undefined,{month:"short"})}</span>
    `;
    btn.addEventListener("click", () => selectDate(btn, btn.dataset.date));
    container.appendChild(btn);
    btns.push(btn);
  }

  // Auto-select: find first day that has at least one available (future, not taken) slot
  autoSelectBestDate(btns);
}

async function autoSelectBestDate(btns) {
  let takenMap = {};
  try {
    const res   = await fetch(CONFIG.SCRIPT_URL);
    const posts = await res.json();
    posts.filter(p => p.date && p.status !== "rejected").forEach(p => {
      const key = formatDateYMD(toLocalMidnight(p.date));
      if (!takenMap[key]) takenMap[key] = [];
      takenMap[key].push(p.timeslot);
    });
  } catch(e) { /* fall back to first date */ }

  const allSlots = Object.values(CONFIG.SLOT_GROUPS).flat();

  for (const btn of btns) {
    const dateStr = btn.dataset.date;
    const taken   = takenMap[dateStr] || [];
    const hasAvailable = allSlots.some(slotKey => {
      const label = CONFIG.SLOT_VALUES[slotKey] || slotKey;
      return !taken.includes(label) && !isSlotPastWithBuffer(dateStr, label);
    });
    if (hasAvailable) {
      selectDate(btn, dateStr, taken);
      // Auto-select the nearest available slot
      autoSelectNearestSlot(dateStr, taken);
      return;
    }
  }
  if (btns.length) selectDate(btns[0], btns[0].dataset.date, []);
}

function autoSelectNearestSlot(dateStr, takenSlots) {
  // Wait for slots to render then click the first available one
  setTimeout(() => {
    const slotBtns = document.querySelectorAll(".slot-btn:not(:disabled)");
    if (slotBtns.length > 0) {
      slotBtns[0].click();
    }
  }, 400);
}

function selectDate(btn, dateStr, preloadedTaken) {
  document.querySelectorAll(".date-btn").forEach(b => b.classList.remove("selected"));
  btn.classList.add("selected");
  document.getElementById("selectedDate").value = dateStr;
  loadSlots(dateStr, preloadedTaken);
}

// ---------------------------------------------------------------------------
// Slot picker
// ---------------------------------------------------------------------------

async function loadSlots(dateStr, preloadedTaken) {
  const container = document.getElementById("slotPicker");
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;color:#888;grid-column:1/-1;">Loading slots…</div>';

  let takenSlots = preloadedTaken || [];
  if (!preloadedTaken) {
    try {
      const res   = await fetch(CONFIG.SCRIPT_URL);
      const posts = await res.json();
      const targetTime = toLocalMidnight(dateStr).getTime();
      takenSlots = posts
        .filter(p => p.date && p.status !== "rejected" &&
                     toLocalMidnight(p.date).getTime() === targetTime)
        .map(p => p.timeslot);
    } catch(e) {
      console.error("loadSlots fetch error:", e);
    }
  }

  container.innerHTML = "";

  for (const [groupName, slots] of Object.entries(CONFIG.SLOT_GROUPS)) {
    const groupLabel = document.createElement("div");
    groupLabel.className = "slot-group-label";
    groupLabel.textContent = groupName;
    container.appendChild(groupLabel);

    for (const slotLabel of slots) {
      const slotValue = CONFIG.SLOT_VALUES[slotLabel];
      const isTaken   = takenSlots.includes(slotLabel) || takenSlots.includes(slotValue);
      const isPast    = isSlotPastWithBuffer(dateStr, slotLabel);

      const btn = document.createElement("button");
      btn.type      = "button";
      btn.className = "slot-btn";
      btn.textContent = CONFIG.UI.SLOT_NO_LEADING_ZERO
        ? slotLabel.replace(/^0/, "")
        : slotLabel;
      btn.disabled = isTaken || isPast;
      if (isTaken) btn.title = "Already booked";
      if (isPast)  btn.title = "Time has passed";

      btn.addEventListener("click", () => {
        document.querySelectorAll(".slot-btn").forEach(b => b.classList.remove("selected"));
        btn.classList.add("selected");
        document.getElementById("selectedTimeslot").value = slotLabel;
      });
      container.appendChild(btn);
    }
  }
}

// ---------------------------------------------------------------------------
// Time helpers
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

/** Returns true if slot time + 5-min buffer is in the past */
function isSlotPastWithBuffer(dateStr, slotLabel) {
  if (!dateStr || !slotLabel) return false;
  const match = slotLabel.match(/^(\d+):(\d+)\s*(AM|PM)$/i);
  if (!match) return false;
  let hour   = parseInt(match[1]);
  const mins  = parseInt(match[2]);
  const period = match[3].toUpperCase();
  if (period === "PM" && hour !== 12) hour += 12;
  if (period === "AM" && hour === 12) hour = 0;
  const slotTime = toLocalMidnight(dateStr);
  slotTime.setHours(hour, mins, 0, 0);
  // 5-minute buffer: slot closes 5 min after its start
  return (slotTime.getTime() + 5 * 60 * 1000) < Date.now();
}

// ---------------------------------------------------------------------------
// Load projects into dropdown
// ---------------------------------------------------------------------------

async function loadProjects() {
  const sel = document.getElementById("projectSelect");
  if (!sel) return;
  try {
    const res      = await fetch(`${CONFIG.SCRIPT_URL}?action=getProjects`);
    const projects = await res.json();
    sel.innerHTML  = '<option value="">— Select a project —</option>' +
      projects.map(p => `<option value="${_escHtml(p.name)}">${_escHtml(p.name)}</option>`).join("");
    // Re-lock to active project if session says so
    const session = getSession();
    const proj    = session?.activeProject;
    if (proj && proj.project) {
      sel.value    = proj.project;
      sel.disabled = true;
    }
  } catch(e) { console.error("loadProjects error:", e); }
}

// ---------------------------------------------------------------------------
// Media upload
// ---------------------------------------------------------------------------

const mediaFile    = document.getElementById("mediaFile");
const mediaBox     = document.getElementById("mediaUploadBox");
const mediaUI      = document.getElementById("mediaUploadUI");
const mediaPreview = document.getElementById("mediaUploadPreview");
const mediaPreviewInner = document.getElementById("mediaPreviewInner");
const mediaFileName     = document.getElementById("mediaFileName");
const mediaClearBtn     = document.getElementById("mediaClearBtn");

mediaFile?.addEventListener("change", () => handleMediaSelect(mediaFile.files[0]));

mediaBox?.addEventListener("dragover", (e) => {
  e.preventDefault();
  mediaBox.classList.add("drag-over");
});
mediaBox?.addEventListener("dragleave", () => mediaBox.classList.remove("drag-over"));
mediaBox?.addEventListener("drop", (e) => {
  e.preventDefault();
  mediaBox.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) handleMediaSelect(file);
});

mediaClearBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  clearMedia();
});

function handleMediaSelect(file) {
  if (!file) return;
  const isVideo = file.type.startsWith("video/");
  const maxMB   = isVideo ? CONFIG.APP.MAX_VIDEO_SIZE_MB : CONFIG.APP.MAX_IMAGE_SIZE_MB;
  if (file.size > maxMB * 1024 * 1024) {
    alert(`File too large. Max ${maxMB} MB for ${isVideo ? "video" : "image"}.`);
    clearMedia();
    return;
  }
  const reader = new FileReader();
  reader.onload = (ev) => {
    mediaPreviewInner.innerHTML = isVideo
      ? `<video controls style="max-width:100%;max-height:200px;border-radius:0.8rem;"><source src="${ev.target.result}"></video>`
      : `<img src="${ev.target.result}" style="max-width:100%;max-height:200px;border-radius:0.8rem;object-fit:contain;">`;
    mediaFileName.textContent = file.name;
    mediaUI.classList.add("hidden");
    mediaPreview.classList.remove("hidden");
  };
  reader.readAsDataURL(file);
}

function clearMedia() {
  if (mediaFile) mediaFile.value = "";
  if (mediaPreviewInner) mediaPreviewInner.innerHTML = "";
  if (mediaFileName) mediaFileName.textContent = "";
  mediaUI?.classList.remove("hidden");
  mediaPreview?.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Form submit
// ---------------------------------------------------------------------------

document.getElementById("submitForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();

  const date     = document.getElementById("selectedDate").value;
  const slot     = document.getElementById("selectedTimeslot").value;
  const content  = document.getElementById("content").value.trim();
  const project  = document.getElementById("projectSelect").value;
  const author   = document.getElementById("author").value;
  const file     = mediaFile?.files[0];

  if (!date)    { showStatus("Please select a date.", "error");      return; }
  if (!slot)    { showStatus("Please select a time slot.", "error"); return; }
  if (!content) { showStatus("Please enter post content.", "error"); return; }
  if (!project) { showStatus("Please select a project.", "error");   return; }
  if (!file)    { showStatus("Please attach media.", "error");       return; }

  showLoading("Uploading your post… Please wait until the upload finishes. Don't close this page.");

  try {
    // Upload media to Cloudinary
    const fd = new FormData();
    fd.append("file",           file);
    fd.append("upload_preset",  CONFIG.CLOUDINARY.UPLOAD_PRESET);
    fd.append("resource_type",  file.type.startsWith("video/") ? "video" : "image");

    const cloudRes  = await fetch(CONFIG.CLOUDINARY.UPLOAD_URL, { method: "POST", body: fd });
    const cloudData = await cloudRes.json();
    if (!cloudData.secure_url) throw new Error("Media upload failed.");

    // Submit to Google Apps Script
    const session = getSession();
    const payload = {
      action:  "submit",
      date,
      timeslot: slot,
      content,
      project,
      author,
      media:   cloudData.secure_url,
      token:   session?.token || ""
    };

    const res    = await fetch(CONFIG.SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });
    
    const result = await res.json();

    if (result.success) {
      showStatus("Post submitted successfully!", "success");
      document.getElementById("submitForm").reset();
      clearMedia();
      document.querySelectorAll(".date-btn").forEach(b => b.classList.remove("selected"));
      document.querySelectorAll(".slot-btn").forEach(b => b.classList.remove("selected"));
      document.getElementById("selectedDate").value    = "";
      document.getElementById("selectedTimeslot").value = "";
      document.getElementById("slotPicker").innerHTML  = '<div style="text-align:center;color:#888;">Select a date first</div>';
      // Re-lock project
      const proj = session?.activeProject;
      if (proj) {
        const sel = document.getElementById("projectSelect");
        if (sel) { sel.value = proj.project; sel.disabled = true; }
      }
    } else {
      showStatus("Error: " + (result.error || "Unknown error"), "error");
    }
  } catch(err) {
    showStatus("Error: " + err.message, "error");
  } finally {
    hideLoading();
  }
});

function showStatus(msg, type) {
  const el = document.getElementById("statusMsg");
  if (!el) return;
  el.textContent = msg;
  el.className   = "message " + type;
  el.style.display = "block";
  setTimeout(() => { el.style.display = "none"; }, 5000);
}