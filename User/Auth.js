/**
 * Auth.js – email-OTP signup, password login, session management
 *
 * New user : email → OTP by email → set password
 *            → name + phone number + projects (role from a dropdown) → account created
 * Returning: email OR phone number + password → project picker / admin choice
 * While the system is paused, normal users see a maintenance screen after login.
 */

let activeSession = null;
let _autoLogoutTimer = null;
const AUTO_LOGOUT_MINUTES = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALL_SCREENS = ["loginScreen", "signupEmailScreen", "otpScreen", "passwordScreen",
  "registerScreen", "projectPickerScreen", "mainSubmitForm", "adminChoiceScreen",
  "historyScreen", "maintenanceScreen"];

// Signup data kept only in memory (never in sessionStorage)
let signupState = { email: "", ticket: "", password: "" };

// ---------------------------------------------------------------------------
// Backend helper
// ---------------------------------------------------------------------------
async function api(payload) {
  const res = await fetch(CONFIG.SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload)
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// Auto-logout timer
// ---------------------------------------------------------------------------
function resetAutoLogoutTimer() {
  if (_autoLogoutTimer) clearTimeout(_autoLogoutTimer);
  _autoLogoutTimer = setTimeout(() => { clearSession(); location.reload(); },
    AUTO_LOGOUT_MINUTES * 60 * 1000);
}

function startActivityTracking() {
  resetAutoLogoutTimer();
  ["click", "keydown", "touchstart", "mousemove"].forEach(evt =>
    document.addEventListener(evt, resetAutoLogoutTimer, { passive: true }));
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
function showOnly(id) {
  ALL_SCREENS.forEach(s => { const el = document.getElementById(s); if (el) el.classList.add("hidden"); });
  const target = document.getElementById(id);
  if (target) target.classList.remove("hidden");
}

function showLoginScreen()       { showOnly("loginScreen"); }
function showSignupEmailScreen() { showOnly("signupEmailScreen"); }
function showPasswordScreen()    { showOnly("passwordScreen"); }

function showOtpScreen(email) {
  showOnly("otpScreen");
  document.getElementById("otpEmailSpan").innerText = email;
  document.getElementById("otpEmail").value = email;
  document.getElementById("otpCode").value = "";
}

function showRegistrationScreen() {
  showOnly("registerScreen");
  if (projectRows.length === 0) addProjectRow("", "");
}

function showProjectPicker() {
  showOnly("projectPickerScreen");
  renderPickerScreen();          // defined in Script.js
}

function showAdminChoiceScreen() {
  ALL_SCREENS.forEach(s => { const el = document.getElementById(s); if (el) el.classList.add("hidden"); });

  let screen = document.getElementById("adminChoiceScreen");
  if (!screen) {
    screen = document.createElement("div");
    screen.id = "adminChoiceScreen";
    screen.className = "login-screen";
    screen.innerHTML = `
      <h2><i class="fas fa-user-shield"></i> Welcome, ${escapeHtml(activeSession.name || "Admin")}</h2>
      <p style="color:#8a6a5a;margin-bottom:1.5rem;">Where would you like to go?</p>
      <button id="choiceSubmitBtn" class="project-picker-item">
        <i class="fas fa-feather-alt"></i> Submit Post Form
      </button>
      <button id="choiceAdminBtn" class="project-picker-item" style="background:#fff0e3;border-color:#b34e1a;">
        <i class="fas fa-cog"></i> Admin Panel
      </button>
      <button id="choiceLogoutBtn"><i class="fas fa-sign-out-alt"></i> Log out</button>
    `;
    document.body.insertBefore(screen, document.body.firstChild);
  } else {
    screen.classList.remove("hidden");
  }

  document.getElementById("choiceSubmitBtn").onclick = () => {
    screen.classList.add("hidden");
    showProjectPicker();
  };
  document.getElementById("choiceAdminBtn").onclick = () => { window.location.href = "../Admin/Admin.html"; };
  document.getElementById("choiceLogoutBtn").onclick = () => { clearSession(); location.reload(); };
}

function showSubmitForm(selectedProject, selectedRole) {
  pickProject(selectedProject, selectedRole);    // defined in Script.js
}

// Admins and the owner always get in. Normal users see the maintenance screen while paused.
async function routeAfterLogin(pausedHint) {
  const role = activeSession.role;
  const apAdmin = activeSession.activeProject;
  if ((role === "owner" || role === "admin") && apAdmin && sessionStorage.getItem("flashMsg")) {
    pickProject(apAdmin.project, apAdmin.role); return;
  }
  // From the admin page profile menu: go straight to History or the project picker
  const go = sessionStorage.getItem("goto");
  if ((role === "owner" || role === "admin") && go) {
    sessionStorage.removeItem("goto");
    _bindNavOnce();
    const nav = document.getElementById("postLoginNav"); if (nav) nav.style.display = "flex";
    const nm = document.getElementById("navUserName"); if (nm) nm.textContent = activeSession.name || "";
    const pm = document.getElementById("profileMenuName"); if (pm) pm.textContent = activeSession.name || "";
    const ab = document.getElementById("navAdminBtn"); if (ab) ab.style.display = "inline-flex";
    if (go === "history") { openHistory(); return; }
    if (go === "picker")  { showProjectPicker(); return; }
  }
  if (role === "owner" || role === "admin") { showAdminChoiceScreen(); return; }
  let paused = pausedHint;
  if (paused === undefined) {
    try {
      const r = await fetch(`${CONFIG.SCRIPT_URL}?action=getSystemPaused`);
      paused = !!(await r.json()).paused;
    } catch (e) { paused = false; }
  }
  if (paused) { showMaintenance(); return; }
  // After a failed upload the page refreshes: go straight back to the submit form
  const ap = activeSession.activeProject;
  if (ap && sessionStorage.getItem("flashMsg")) { pickProject(ap.project, ap.role); return; }
  showProjectPicker();
}

function startSessionFrom(data) {
  activeSession = {
    token:    data.token,
    email:    data.user.email,
    phone:    data.user.phone,
    name:     data.user.name,
    role:     data.user.role,
    clubRole: data.user.clubRole || "",
    projects: data.user.projects || [],
    isNew:    false
  };
  sessionStorage.setItem("auth", JSON.stringify(activeSession));
  startActivityTracking();
  routeAfterLogin(!!data.paused);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function initAuth() {
  const stored = sessionStorage.getItem("auth");
  if (stored) {
    try {
      activeSession = JSON.parse(stored);
      if (activeSession && activeSession.token && !activeSession.isNew) {
        startActivityTracking();
        routeAfterLogin();
        return;
      }
    } catch (e) { console.error(e); }
    sessionStorage.removeItem("auth");
  }
  showLoginScreen();
}

// ---------------------------------------------------------------------------
// Login (email OR phone number + password)
// ---------------------------------------------------------------------------
document.getElementById("loginBtn")?.addEventListener("click", doLogin);
document.getElementById("loginPassword")?.addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
document.getElementById("loginId")?.addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("loginPassword").focus(); });

async function doLogin() {
  const id = document.getElementById("loginId").value.trim();
  const password = document.getElementById("loginPassword").value;
  if (!id) { alert("Enter your email or phone number"); return; }

  if (!password) { alert("Enter your password"); return; }
  showLoading("Logging in…");
  try {
    const data = await api({ action: "loginPassword", identifier: id, password });
    if (data.success) startSessionFrom(data);
    else alert(data.error || "Login failed");
  } catch (e) { alert("Network error"); }
  hideLoading();
}

document.getElementById("goSignupLink")?.addEventListener("click", e => { e.preventDefault(); showSignupEmailScreen(); });
document.getElementById("backToLoginFromSignup")?.addEventListener("click", () => showLoginScreen());

// ---------------------------------------------------------------------------
// Signup 1: email → send OTP
// ---------------------------------------------------------------------------
document.getElementById("sendEmailOtpBtn")?.addEventListener("click", async () => {
  const email = document.getElementById("signupEmail").value.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    alert("Please enter a valid email address.");
    return;
  }
  showLoading("Sending code…");
  try {
    const data = await api({ action: "emailSendOtp", email });
    if (data.success) { signupState.email = email; showOtpScreen(email); }
    else alert(data.error || "Could not send code");
  } catch (e) { alert("Network error"); }
  hideLoading();
});

// ---------------------------------------------------------------------------
// Signup 2: verify OTP (+ resend)
// ---------------------------------------------------------------------------
document.getElementById("verifyOtpBtn")?.addEventListener("click", async () => {
  const email = document.getElementById("otpEmail").value;
  const code = document.getElementById("otpCode").value.trim();
  if (!code) return;
  showLoading("Verifying…");
  try {
    const data = await api({ action: "emailVerifyOtp", email, code });
    if (data.success) { signupState.ticket = data.ticket; showPasswordScreen(); }
    else alert(data.error || "Wrong code");
  } catch (e) { alert("Network error"); }
  hideLoading();
});

document.getElementById("resendOtpLink")?.addEventListener("click", async e => {
  e.preventDefault();
  const email = document.getElementById("otpEmail").value;
  if (!email) return;
  showLoading("Sending code…");
  try {
    const data = await api({ action: "emailSendOtp", email });
    alert(data.success ? "Code resent!" : (data.error || "Could not resend."));
  } catch (err) { alert("Network error"); }
  hideLoading();
});

// ---------------------------------------------------------------------------
// Signup 3: set password
// ---------------------------------------------------------------------------
document.getElementById("setPasswordBtn")?.addEventListener("click", () => {
  const p1 = document.getElementById("newPassword").value;
  const p2 = document.getElementById("confirmPassword").value;
  if (p1.length < 8) { alert("Password must be at least 8 characters"); return; }
  if (p1 !== p2) { alert("Passwords do not match"); return; }
  signupState.password = p1;
  showRegistrationScreen();
});

// ---------------------------------------------------------------------------
// Signup 4: name + phone number + projects → create account
// ---------------------------------------------------------------------------
let projectRows = [];

function addProjectRow(projectName, projectRole) {
  const container = document.getElementById("projectsRowsContainer");
  const index = projectRows.length;
  const rowDiv = document.createElement("div");
  rowDiv.className = "project-row";
  rowDiv.innerHTML = `
    <select class="projSelect" data-index="${index}">
      <option value="">-- Project --</option>
    </select>
    <button type="button" class="removeProjBtn" data-index="${index}"><i class="fas fa-trash"></i></button>
    <select class="roleSelect"><option value="">-- Role --</option></select>
    <input type="text" class="roleOther role-other hidden" placeholder="Type your role" maxlength="40">
  `;
  container.appendChild(rowDiv);
  populateSelect(rowDiv.querySelector(".projSelect"), projectName);
  fillRoleSelect(rowDiv.querySelector(".roleSelect"), rowDiv.querySelector(".roleOther"), projectRole || "");
  const rowObj = { div: rowDiv, project: projectName, role: projectRole };
  projectRows.push(rowObj);
  rowDiv.querySelector(".removeProjBtn").addEventListener("click", () => {
    const i = projectRows.indexOf(rowObj);
    if (i >= 0) { projectRows[i].div.remove(); projectRows.splice(i, 1); }
  });
}

async function populateSelect(selectEl, selectedVal) {
  try {
    const res = await fetch(`${CONFIG.SCRIPT_URL}?action=getProjects`);
    const projects = await res.json();
    selectEl.innerHTML = '<option value="">-- Project --</option>' +
      projects.filter(p => p.status !== "completed")
              .map(p => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join("");
    if (selectedVal) selectEl.value = selectedVal;
  } catch (e) { console.error("populateSelect error", e); }
}

document.getElementById("addProjectRowBtn")?.addEventListener("click", () => addProjectRow("", ""));

document.getElementById("registerConfirmBtn")?.addEventListener("click", async () => {
  const name = document.getElementById("regName").value.trim();
  const phoneRaw = document.getElementById("regPhone").value.replace(/\D/g, "");
  if (!name) { alert("Enter your name"); return; }
  if (phoneRaw.length < 9) { alert("Enter a valid phone number"); return; }

  const projects = [];
  for (const row of projectRows) {
    const project = row.div.querySelector(".projSelect").value;
    const role = readRole(row.div.querySelector(".roleSelect"), row.div.querySelector(".roleOther"));
    if (!project || !role) { alert("Fill all project rows"); return; }
    projects.push({ project, role });
  }
  if (!projects.length) { alert("Add at least one project"); return; }
  if (!signupState.ticket || !signupState.password) { alert("Session expired. Start again."); showSignupEmailScreen(); return; }

  showLoading("Creating your account…");
  try {
    const data = await api({
      action: "registerAccount",
      ticket: signupState.ticket,
      password: signupState.password,
      name, phone: phoneRaw, projects
    });
    if (data.success) {
      signupState = { email: "", ticket: "", password: "" };
      startSessionFrom(data);
    } else {
      alert(data.error || "Could not create account");
    }
  } catch (e) { alert("Network error"); }
  hideLoading();
});

// ---------------------------------------------------------------------------
// Project picker
// ---------------------------------------------------------------------------
document.getElementById("pickerAddProjectBtn")?.addEventListener("click", async () => {
  const projSelect = document.getElementById("pickerAddProjectSelect");
  const roleSelect = document.getElementById("pickerAddRoleSelect");
  const roleInput = document.getElementById("pickerAddRoleInput");
  const project = projSelect?.value;
  const role = readRole(roleSelect, roleInput);
  if (!project || !role) { alert("Please choose a project and a role."); return; }
  showLoading("Adding project…");
  try {
    const updated = [...(activeSession.projects || []), { project, role }];
    const data = await api({ action: "saveAccountProjects", token: activeSession.token, projects: updated });
    if (data.success) {
      activeSession.projects = updated;
      sessionStorage.setItem("auth", JSON.stringify(activeSession));
      if (roleInput) roleInput.value = "";
      if (projSelect) projSelect.value = "";
      if (roleSelect) { roleSelect.value = ""; roleInput?.classList.add("hidden"); }
      renderPickerScreen();
    } else {
      alert(data.error);
    }
  } catch (e) { alert("Network error"); }
  hideLoading();
});

document.getElementById("pickerGoSubmitBtn")?.addEventListener("click", () => {
  const projects = activeSession.projects || [];
  const p = activeSession.activeProject || projects[0] ||
            (activeSession.clubRole ? { project: CONFIG.BOD_PROJECT, role: activeSession.clubRole } : null);
  if (!p) { alert("Please add a project first."); return; }
  showSubmitForm(p.project, p.role);
});

document.getElementById("backToLoginFromPicker")?.addEventListener("click", () => {
  clearSession();
  showLoginScreen();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getSession() {
  try { return JSON.parse(sessionStorage.getItem("auth")); } catch (e) { return null; }
}

function clearSession() {
  sessionStorage.removeItem("auth");
  activeSession = null;
  if (_autoLogoutTimer) clearTimeout(_autoLogoutTimer);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
initAuth();