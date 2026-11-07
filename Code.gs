/**
 * Code.gs  –  Google Apps Script backend for Time Slot Scheduler
 * Social-media only (WhatsApp removed).
 *
 * SCRIPT PROPERTIES:
 *   BUFFER_TOKEN_SOCIAL / BUFFER_TOKEN_VIDEO  — Buffer tokens
 *   BUFFER_ORG_SOCIAL / BUFFER_ORG_VIDEO      — (optional) Buffer organisation IDs
 *   BUFFER_DEFAULT_CHANNELS                   — "channelId:orgType,..." (auto-publish fallback)
 *   TZ_OFFSET_HOURS                           — e.g. 5.5 for Sri Lanka
 *   CLOUDINARY_CLOUD_NAME / _API_KEY / _API_SECRET
 *   TOKEN_SECRET                              — signs login tokens
 *   OWNER_PHONE / OWNER_PASSWORD / OWNER_NAME — owner login (phone + password) and display name
 *   OWNER_EMAIL                               — (optional) owner can also log in by email
 *   (managed from the admin page, do not edit by hand)
 *   ADMIN_ENTRIES, CLUB_ROLES, PROJECT_ROLES, SYSTEM_PAUSED
 *
 * ADMIN RULES: an admin is a person listed in the admin whitelist WITH a club role.
 * Removing the entry removes both. The owner is exempt.
 * Run authorizeMail() once from the editor to allow sending Gmail.
 */

const SHEET_NAME         = "Database";
const PROJECTS_SHEET     = "Projects";
const BUFFER_GRAPHQL_URL = "https://api.buffer.com/graphql";
const BOD_PROJECT        = "BOD Post";          // club-level posts
const SLOT_GRACE_MIN     = 15;                  // a slot closes 15 min after its start
const LOCK_MS            = 10 * 60 * 1000;      // edit lock lasts 10 min
const MAINTENANCE_MSG    = "The system is under maintenance. Please try again later.";

const DEFAULT_PROJECT_ROLES = ["Director", "Co-Director", "Chair", "Co-Chair", "Secretary",
                               "Designer", "Caption Writer", "OC Member"];
const DEFAULT_CLUB_ROLES    = ["President", "Vice President", "Treasurer", "Chief Media Officer",
                               "Chief PR Officer", "PR Panel"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBufferToken(orgType) {
  const key = orgType === "social" ? "BUFFER_TOKEN_SOCIAL" : "BUFFER_TOKEN_VIDEO";
  return PropertiesService.getScriptProperties().getProperty(key);
}

function getBufferOrgId(orgType) {
  const props = PropertiesService.getScriptProperties();
  return orgType === "social"
    ? (props.getProperty("BUFFER_ORG_SOCIAL") || "69cbe2988113fa521a4e6d6c")
    : (props.getProperty("BUFFER_ORG_VIDEO")  || "69d8b6007d05daf89785f93b");
}

function getTzOffsetHours() {
  const v = PropertiesService.getScriptProperties().getProperty("TZ_OFFSET_HOURS");
  return v ? parseFloat(v) : 5.5; // default: Sri Lanka UTC+5:30
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function buildColMap(headers) {
  const map = {};
  headers.forEach((h, i) => { if (h) map[h.toString().toLowerCase()] = i; });
  return map;
}

function toSheetRow(rowIndex) { return Number(rowIndex) + 1; }

const DB_HEADERS = [
  "title","content","author","timeslot","date","media","status",
  "cloudinary_public_id","shared","buffer_post_ids","platforms","scheduled",
  "approved_by","rejected_by","auto_social_targets",
  "youtube_title","youtube_category_id",
  "submitted_by","submitted_at","editing_by","editing_until"
];

// Creates the "Database" (posts) tab with its header row if it is missing
function ensureDatabaseSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, DB_HEADERS.length).setValues([DB_HEADERS]);
    sheet.getRange("D:E").setNumberFormat("@");   // keep time slot / date as plain text
  }
  return sheet;
}

function ensureColumns() {
  const sheet = ensureDatabaseSheet();
  const headers  = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const existing = new Set(headers.map(h => h.toString().toLowerCase()));
  DB_HEADERS.forEach(c => {
    if (!existing.has(c)) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(c);
      existing.add(c);
    }
  });
}

function ensureProjectsSheet() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(PROJECTS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(PROJECTS_SHEET);
    sheet.getRange(1, 1, 1, 3).setValues([["name", "status", "color"]]);
  }
  return sheet;
}

function ensureUsersSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Users");
  if (!sheet) sheet = ss.insertSheet("Users");
  const want = ["phone", "name", "role", "projects", "email", "salt", "hash", "createdAt", "club_role"];
  const have = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), want.length)).getValues()[0];
  let changed = false;
  want.forEach((h, i) => { if (!have[i]) { have[i] = h; changed = true; } });
  if (changed) sheet.getRange(1, 1, 1, want.length).setValues([have.slice(0, want.length)]);
  return sheet;
}

function ensureActivityLogSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("ActivityLog");
  if (!sheet) {
    sheet = ss.insertSheet("ActivityLog");
    sheet.getRange(1, 1, 1, 6).setValues([["timestamp", "phone", "name", "role", "action", "detail"]]);
  }
  return sheet;
}

// Normalise a date / time cell value so comparisons work however Sheets stored it
function normDateServer(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
  return (v || "").toString().trim();
}
function normSlotServer(v) {
  const to12 = (h, m) => {
    const ap = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ":" + String(m).padStart(2, "0") + " " + ap;
  };
  if (v instanceof Date) return to12(v.getUTCHours(), v.getUTCMinutes());
  const s = (v || "").toString().trim();
  let m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
  if (m) return parseInt(m[1], 10) + ":" + m[2] + " " + m[3].toUpperCase();
  m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m) return to12(parseInt(m[1], 10), parseInt(m[2], 10));
  return s;
}

/**
 * Parse "8:00 AM" / "12:00 PM" on dateStr "YYYY-MM-DD"
 * Returns a UTC Date accounting for local timezone offset.
 */
function slotToDate(dateStr, slotStr, tzOffsetHours) {
  const m = slotStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let hour   = parseInt(m[1]);
  const min  = parseInt(m[2]);
  const ampm = m[3].toUpperCase();
  if (ampm === "PM" && hour !== 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour  = 0;
  const [y, mo, d]    = dateStr.split("-").map(Number);
  const tzOffsetMs    = tzOffsetHours * 60 * 60 * 1000;
  const localMidnight = Date.UTC(y, mo - 1, d) - tzOffsetMs;
  return new Date(localMidnight + (hour * 60 + min) * 60 * 1000);
}

function dateToYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// ---------------------------------------------------------------------------
// System pause (owner switch)
// ---------------------------------------------------------------------------
function isSystemPaused() {
  return PropertiesService.getScriptProperties().getProperty("SYSTEM_PAUSED") === "true";
}

function handleSetSystemPaused(data, session) {
  if (!session || session.role !== "owner") return json({ success: false, error: "Unauthorized." });
  PropertiesService.getScriptProperties().setProperty("SYSTEM_PAUSED", data.paused ? "true" : "false");
  logActivity(session, "setSystemPaused", "paused=" + !!data.paused);
  return json({ success: true, paused: !!data.paused });
}

// ---------------------------------------------------------------------------
// Role lists (editable by the owner)
// ---------------------------------------------------------------------------
function readList_(key, fallback) {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(key);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr.map(String);
    }
  } catch (e) {}
  return fallback.slice();
}

function getRoleLists() {
  return { projectRoles: readList_("PROJECT_ROLES", DEFAULT_PROJECT_ROLES),
           clubRoles:    readList_("CLUB_ROLES",    DEFAULT_CLUB_ROLES) };
}

function handleSaveRoles(data, session) {
  if (!session || session.role !== "owner") return json({ success: false, error: "Unauthorized." });
  const clean = (arr) => Array.from(new Set((Array.isArray(arr) ? arr : [])
    .map(s => String(s).trim()).filter(Boolean))).slice(0, 40);
  const props = PropertiesService.getScriptProperties();
  if (data.projectRoles) props.setProperty("PROJECT_ROLES", JSON.stringify(clean(data.projectRoles)));
  if (data.clubRoles)    props.setProperty("CLUB_ROLES",    JSON.stringify(clean(data.clubRoles)));
  logActivity(session, "saveRoles", "");
  return json(Object.assign({ success: true }, getRoleLists()));
}

// ---------------------------------------------------------------------------
// Auth — Phone / role / admin-entry helpers
// ---------------------------------------------------------------------------

/** Strip non-digits; local 07xxxxxxxx / 7xxxxxxxx → 947xxxxxxxx (Sri Lanka) */
function normalizePhone(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.startsWith("0") && digits.length === 10) {
    digits = "94" + digits.slice(1);
  } else if (digits.length === 9 && digits.startsWith("7")) {
    digits = "94" + digits;
  }
  return digits;
}

// A whitelist id is an email (lower-case) or a normalised phone number
function normId_(v) {
  v = String(v || "").trim();
  if (!v) return "";
  return v.indexOf("@") >= 0 ? v.toLowerCase() : normalizePhone(v);
}

function getAdminEntries_() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty("ADMIN_ENTRIES");
  if (raw) {
    try { const a = JSON.parse(raw); if (Array.isArray(a)) return a; } catch (e) {}
  }
  // one-time migration from the old comma-separated ADMIN_WHITELIST
  const old = String(props.getProperty("ADMIN_WHITELIST") || "")
    .split(",").map(s => normId_(s)).filter(Boolean);
  return old.map(id => ({ id: id, role: "Admin" }));
}

function saveAdminEntries_(arr) {
  PropertiesService.getScriptProperties().setProperty("ADMIN_ENTRIES", JSON.stringify(arr));
}

/** Owner = OWNER_EMAIL. (The owner phone login is handled separately in handleLoginPassword.) */
function isOwnerEmail_(email) {
  const owner = String(PropertiesService.getScriptProperties().getProperty("OWNER_EMAIL") || "").trim().toLowerCase();
  return !!owner && String(email || "").trim().toLowerCase() === owner;
}

/**
 * Access of a registered person, from the admin whitelist:
 *   listed → role "admin" + their club role;   not listed → role "user", no club role.
 */
function resolveAccess(email, phone) {
  if (isOwnerEmail_(email)) return { role: "owner", clubRole: "Owner" };
  const e = normId_(email), p = normalizePhone(phone);
  const hit = getAdminEntries_().find(x => (e && x.id === e) || (p && x.id === p));
  return hit ? { role: "admin", clubRole: hit.role || "Admin" } : { role: "user", clubRole: "" };
}

// ---------------------------------------------------------------------------
// Auth — User helpers
// ---------------------------------------------------------------------------

function userFromRow(row, i) {
  let projects = [];
  try { projects = JSON.parse(row[3] || "[]"); } catch(e) {}
  return {
    phone:    normalizePhone(String(row[0])),
    name:     row[1] || "",
    role:     row[2] || "user",
    projects: projects,
    email:    String(row[4] || "").trim().toLowerCase(),
    salt:     String(row[5] || ""),
    hash:     String(row[6] || ""),
    clubRole: String(row[8] || ""),
    isNew:    false,
    row:      i + 1
  };
}

function findUser(phone) {
  const data = ensureUsersSheet().getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (normalizePhone(String(data[i][0])) === phone) return userFromRow(data[i], i);
  }
  return null;
}

function findUserByEmail(email) {
  email = String(email || "").trim().toLowerCase();
  const data = ensureUsersSheet().getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][4] || "").trim().toLowerCase() === email) return userFromRow(data[i], i);
  }
  return null;
}

function logActivity(session, action, detail) {
  try {
    ensureActivityLogSheet().appendRow([
      new Date().toISOString(),
      session ? (session.phone || "") : "",
      session ? (session.name  || "") : "",
      session ? (session.role  || "") : "",
      action  || "",
      detail  || ""
    ]);
  } catch(e) {
    console.error("logActivity error:", e);
  }
}

// ---------------------------------------------------------------------------
// Auth — Token issue / verify
// ---------------------------------------------------------------------------

function issueToken(phone, role, name) {
  const secret  = PropertiesService.getScriptProperties().getProperty("TOKEN_SECRET") || "change-me";
  const expires = Date.now() + 8 * 60 * 60 * 1000; // 8 hours
  const safeName = Utilities.base64Encode(name || "");
  const payload = `${phone}|${role}|${expires}|${safeName}`;
  const sig = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, payload + secret)
    .map(b => ("0" + (b & 0xff).toString(16)).slice(-2)).join("");
  return Utilities.base64Encode(payload + "|" + sig);
}

function verifyToken(token) {
  if (!token) return null;
  try {
    const decoded  = Utilities.newBlob(Utilities.base64Decode(token)).getDataAsString();
    const lastPipe = decoded.lastIndexOf("|");
    const sig      = decoded.substring(lastPipe + 1);
    const payload  = decoded.substring(0, lastPipe);
    const secret   = PropertiesService.getScriptProperties().getProperty("TOKEN_SECRET") || "change-me";
    const expected = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, payload + secret)
      .map(b => ("0" + (b & 0xff).toString(16)).slice(-2)).join("");
    if (sig !== expected) return null;
    const parts   = payload.split("|");
    if (parts.length < 3) return null;
    const phone   = parts[0];
    const role    = parts[1];
    const expires = Number(parts[2]);
    const name    = parts[3] ? Utilities.newBlob(Utilities.base64Decode(parts[3])).getDataAsString() : "";
    if (Date.now() > expires) return null;
    return { phone, role, name };
  } catch(e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------
function doGet(e) {
  const action = e?.parameter?.action;

  if (action === "getProfiles") {
    try {
      const fetchChannels = (orgType) => {
        const t = getBufferToken(orgType);
        if (!t) return [];
        const orgId = getBufferOrgId(orgType);
        const r = UrlFetchApp.fetch(BUFFER_GRAPHQL_URL, {
          method: "post", contentType: "application/json",
          headers: { Authorization: "Bearer " + t },
          payload: JSON.stringify({ query:
            `{ channels(input: { organizationId: "${orgId}" }) { id name service } }` }),
          muteHttpExceptions: true
        });
        const body = JSON.parse(r.getContentText());
        if (body.errors) { console.error("getProfiles " + orgType, JSON.stringify(body.errors)); return []; }
        return (body.data?.channels) || [];
      };

      const social = fetchChannels("social").map(ch => Object.assign({}, ch, { orgType: "social" }));
      const video  = fetchChannels("video").map(ch => Object.assign({}, ch, { orgType: "video" }));
      const seen   = {};
      const all    = social.concat(video).filter(ch => {
        if (seen[ch.id]) return false;
        seen[ch.id] = true;
        return true;
      });

      return json(all.map(ch => ({
        id:          ch.id,
        serviceName: (ch.service || "unknown").toLowerCase(),
        username:    ch.name || ch.id,
        orgType:     ch.orgType,
        connected:   true
      })));
    } catch (err) {
      console.error("getProfiles error:", err);
      return json({ error: err.toString() });
    }
  }

  if (action === "getProjects") {
    try {
      const sheet = ensureProjectsSheet();
      const data  = sheet.getDataRange().getValues();
      if (data.length <= 1) return json([]);
      return json(data.slice(1).map((r, i) => ({
        row: i + 1, name: r[0] || "", status: (r[1] || "ongoing").toString().toLowerCase(), color: r[2] || "#b34e1a"
      })).filter(p => p.name));
    } catch (err) {
      return json({ error: err.toString() });
    }
  }

  if (action === "getRoles")        return json(getRoleLists());
  if (action === "getSystemPaused") return json({ success: true, paused: isSystemPaused() });

  // Default — get all posts
  const sheet = ensureDatabaseSheet();
  ensureColumns();
  const range   = sheet.getDataRange();
  const data    = range.getDisplayValues();
  const raw     = range.getValues();
  const tz      = Session.getScriptTimeZone();
  const headers = data[0];
  const col     = buildColMap(headers);
  const posts   = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (!r[col["title"]] && !r[col["date"]]) continue;
    let dateVal = raw[i][col["date"]];
    dateVal = (dateVal instanceof Date)
      ? Utilities.formatDate(dateVal, tz, "yyyy-MM-dd")
      : (r[col["date"]] || "");
    const slotVal = normSlotServer(r[col["timeslot"]]);

    posts.push({
      row: i, title: r[col["title"]] || "", project: r[col["title"]] || "",
      content: r[col["content"]] || "",
      author: r[col["author"]] || "", timeslot: slotVal,
      date: dateVal, media: r[col["media"]] || "",
      status: r[col["status"]] || "pending", shared: r[col["shared"]] === "TRUE",
      bufferPostIds: r[col["buffer_post_ids"]] || "", platforms: r[col["platforms"]] || "",
      scheduled: (r[col["scheduled"]] || "false").toString().toLowerCase(),
      approvedBy: r[col["approved_by"]] || "",
      rejectedBy: r[col["rejected_by"]] || "",
      submittedAt: r[col["submitted_at"]] || ""
    });
  }
  return json(posts);
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // ── No session required ─────────────────────────────────────────────────
    if (data.action === "emailSendOtp")    return handleEmailSendOtp(data);
    if (data.action === "emailVerifyOtp")  return handleEmailVerifyOtp(data);
    if (data.action === "registerAccount") return handleRegisterAccount(data);
    if (data.action === "loginPassword")   return handleLoginPassword(data);
    if (data.action === "getSystemPaused") return json({ success: true, paused: isSystemPaused() });

    // ── Everything else needs a valid session token ─────────────────────────
    const session = verifyToken(data.token);

    // An admin who was removed from the whitelist becomes a normal user immediately
    if (session && session.role === "admin") {
      const u = findUser(session.phone);
      session.role = u ? resolveAccess(u.email, u.phone).role : "user";
    }

    // While the system is paused only admins and the owner can act
    if (isSystemPaused() && (!session || session.role === "user")) {
      return json({ success: false, paused: true, error: MAINTENANCE_MSG });
    }

    const sheet = ensureDatabaseSheet();
    ensureColumns();
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const col     = buildColMap(headers);

    switch (data.action) {
      case "publishToBuffer": return handlePublishToBuffer(sheet, col, data, session);
      case "update":          return handleUpdateStatus(sheet, col, data, session);
      case "edit":            return handleEditPost(sheet, col, data, session);
      case "changeSlot":      return handleChangeSlot(sheet, col, data, session);
      case "deleteRow":       return handleDeleteRow(sheet, col, data, session);
      case "setScheduled":    return handleSetScheduled(sheet, col, data, session);
      case "addProject":      return handleAddProject(data, session);
      case "removeProject":   return handleRemoveProject(data, session);
      case "updateProject":   return handleUpdateProject(data, session);
      case "getWhitelist":    return handleGetWhitelist(session);
      case "setWhitelist":    return handleSetWhitelist(data, session);
      case "getAdminEntries": return handleGetAdminEntries(session);
      case "setAdminEntry":   return handleSetAdminEntry(data, session);
      case "removeAdminEntry":return handleRemoveAdminEntry(data, session);
      case "saveRoles":       return handleSaveRoles(data, session);
      case "getSheetUrls":    return handleGetSheetUrls(session);
      case "setSystemPaused": return handleSetSystemPaused(data, session);
      case "saveAutoDestinations": return handleSaveAutoDestinations(sheet, col, data, session);
      case "saveAccountProjects":  return handleSaveAccountProjects(data, session);
      case "changePassword":  return handleChangePassword(data, session);
      case "getMyPosts":      return handleGetMyPosts(sheet, col, session);
      case "quickScan":       return handleScan_(session, false);
      case "fullScan":        return handleScan_(session, true);
      case "diagDeleteAsset": return handleDiagDeleteAsset(data, session);
      case "editMyPost":      return handleEditMyPost(sheet, col, data, session);
      case "lockPost":        return handleLockPost(sheet, col, data, session);
      case "unlockPost":      return handleUnlockPost(sheet, col, data, session);
      case "submit":
      case undefined:
      case null:              return handleNewSubmission(sheet, col, data, session);
      default:                return json({ success: false, error: `Unknown action: ${data.action}` });
    }
  } catch (err) {
    console.error("doPost error:", err);
    return json({ success: false, error: err.toString() });
  }
}

// ---------------------------------------------------------------------------
// Post helpers: public id, Cloudinary type, ownership, edit lock
// ---------------------------------------------------------------------------
function extractPublicId_(url) {
  if (!url || String(url).indexOf("cloudinary.com") < 0) return "";
  const parts       = String(url).split("/");
  const uploadIndex = parts.indexOf("upload");
  if (uploadIndex !== -1 && parts.length > uploadIndex + 1) {
    const afterUpload = parts.slice(uploadIndex + 1);
    // skip the version segment (v1234567890) if present; the rest is folder/name
    const startIndex  = /^v\d+$/.test(afterUpload[0]) ? 1 : 0;
    return afterUpload.slice(startIndex).join("/").replace(/\.[^/.]+$/, "");
  }
  return "";
}

function cloudinaryTypeFromUrl_(url) {
  return /\/video\/upload\//.test(String(url || "")) ? "video" : "image";
}

function postOwnedBy_(row, col, session) {
  const sb = String(row[col["submitted_by"]] || "").trim();
  if (sb) return normalizePhone(sb) === session.phone;
  // older posts (before submitted_by existed): match on the author name
  const a = String(row[col["author"]] || "");
  return !!session.name && (a === session.name || a.indexOf(session.name + " —") === 0);
}

function readLock_(sheet, col, r) {
  const by    = String(sheet.getRange(r, col["editing_by"] + 1).getValue() || "");
  const until = Number(sheet.getRange(r, col["editing_until"] + 1).getValue()) || 0;
  return { by: by, until: until };
}
function lockedByOther_(lock, session) {
  return !!lock.by && lock.until > Date.now() && lock.by.split("|")[0] !== session.phone;
}
function lockOwnerName_(lock) { return lock.by.split("|")[1] || "someone else"; }
function setLock_(sheet, col, r, session) {
  sheet.getRange(r, col["editing_by"]    + 1).setValue(session.phone + "|" + (session.name || ""));
  sheet.getRange(r, col["editing_until"] + 1).setValue(Date.now() + LOCK_MS);
}
function clearLock_(sheet, col, r) {
  sheet.getRange(r, col["editing_by"]    + 1).setValue("");
  sheet.getRange(r, col["editing_until"] + 1).setValue("");
}
function validRow_(sheet, r) { return r >= 2 && r <= sheet.getLastRow(); }

// Users can edit a post only until 7 days after its scheduled date
function withinEditWindow_(dateStr) {
  const cutoff = Utilities.formatDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
                                      Session.getScriptTimeZone(), "yyyy-MM-dd");
  return !!dateStr && String(dateStr) >= cutoff;
}

function getProjectStatus_(name) {
  const data = ensureProjectsSheet().getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(name).trim()) return String(data[i][1] || "ongoing").toLowerCase();
  }
  return null;   // not a known project
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

function handlePublishToBuffer(sheet, col, data, session) {
  if (!session || session.role === "user") return json({ success: false, error: "Unauthorized." });
  const r    = toSheetRow(data.row);
  const post = {
    content: data.strippedContent !== undefined
               ? data.strippedContent
               : sheet.getRange(r, col["content"] + 1).getValue(),
    media:   sheet.getRange(r, col["media"]   + 1).getValue()
  };
  const selectedProfiles = data.profiles   || [];
  const youtubeMeta      = data.youtubeMeta || null;
  const postIds   = [];
  const succeeded = [];
  const failed    = [];

  for (const prof of selectedProfiles) {
    const token = getBufferToken(prof.orgType || "social");
    if (!token) { failed.push(`${prof.username || prof.id}: no token`); continue; }
    const channelId = prof.id || prof.profileId;
    const isYt      = (prof.serviceName || "").toLowerCase() === "youtube";
    const result = createBufferPost(
      token, channelId, post.content, post.media, prof.serviceName,
      isYt ? youtubeMeta : null
    );
    if (result.success) {
      postIds.push(result.postId);
      succeeded.push(prof.serviceName || prof.id);
    } else {
      failed.push(`${prof.username || prof.id}: ${result.error}`);
    }
  }

  if (succeeded.length > 0) {
    sheet.getRange(r, col["shared"]          + 1).setValue(true);
    sheet.getRange(r, col["buffer_post_ids"] + 1).setValue(postIds.join(","));
    sheet.getRange(r, col["platforms"]       + 1).setValue(succeeded.join(","));
    logActivity(session, "publishToBuffer", `row=${data.row} channels=${succeeded.join(",")}`);
    return json({ success: true, failed });
  }
  return json({ success: false, error: "Failed to publish to any selected channel.", details: failed });
}

function handleUpdateStatus(sheet, col, data, session) {
  if (!session || session.role === "user") return json({ success: false, error: "Unauthorized." });
  const r = toSheetRow(data.row);
  sheet.getRange(r, col["status"] + 1).setValue(data.status);
  if (data.status === "approved") {
    sheet.getRange(r, col["scheduled"]   + 1).setValue("true");
    sheet.getRange(r, col["approved_by"] + 1).setValue(session.name || session.phone);
  }
  if (data.status === "rejected") {
    sheet.getRange(r, col["rejected_by"] + 1).setValue(session.name || session.phone);
  }
  logActivity(session, "updateStatus", `row=${data.row} status=${data.status}`);
  return json({ success: true });
}

// Admin edit (admin page). Respects the edit lock so two people never edit at once.
function handleEditPost(sheet, col, data, session) {
  if (!session || session.role === "user") return json({ success: false, error: "Unauthorized." });
  const r = toSheetRow(data.row);
  if (!validRow_(sheet, r)) return json({ success: false, error: "Post not found." });
  const lock = readLock_(sheet, col, r);
  if (lockedByOther_(lock, session))
    return json({ success: false, locked: true, error: "This post is being edited by " + lockOwnerName_(lock) + "." });
  sheet.getRange(r, col["content"] + 1).setValue(data.content);
  if (data.media) sheet.getRange(r, col["media"] + 1).setValue(data.media);
  sheet.getRange(r, col["shared"]  + 1).setValue(false);
  clearLock_(sheet, col, r);
  logActivity(session, "editPost", `row=${data.row}`);
  return json({ success: true });
}

function handleChangeSlot(sheet, col, data, session) {
  if (!session || session.role === "user") return json({ success: false, error: "Unauthorized." });
  const r          = toSheetRow(data.row);
  const range      = sheet.getDataRange();
  const vals       = range.getValues();
  const disp       = range.getDisplayValues();
  const targetDate = data.newDate || data.date;
  for (let i = 1; i < vals.length; i++) {
    if (i - 1 === data.row) continue;
    const dt = normDateServer(vals[i][col["date"]]);
    if (normSlotServer(disp[i][col["timeslot"]]) === normSlotServer(data.newSlot) &&
        vals[i][col["status"]]   !== "rejected"   &&
        dt                       === normDateServer(targetDate)) {
      return json({ success: false, error: "That slot is already taken on this date." });
    }
  }
  sheet.getRange(r, col["timeslot"] + 1).setNumberFormat("@").setValue(data.newSlot);
  if (data.newDate) sheet.getRange(r, col["date"] + 1).setNumberFormat("@").setValue(data.newDate);
  sheet.getRange(r, col["shared"]    + 1).setValue(false);
  sheet.getRange(r, col["scheduled"] + 1).setValue("true");
  logActivity(session, "changeSlot", `row=${data.row} newSlot=${data.newSlot}`);
  return json({ success: true });
}

function handleDeleteRow(sheet, col, data, session) {
  if (!session || session.role === "user") return json({ success: false, error: "Unauthorized." });
  const r        = toSheetRow(data.row);
  const publicId = sheet.getRange(r, col["cloudinary_public_id"] + 1).getValue();
  const mediaUrl = sheet.getRange(r, col["media"] + 1).getValue();
  sheet.deleteRow(r);
  if (publicId) deleteCloudinaryAsset(publicId, cloudinaryTypeFromUrl_(mediaUrl));
  logActivity(session, "deleteRow", `row=${data.row}`);
  return json({ success: true });
}

function handleSetScheduled(sheet, col, data, session) {
  if (!session || session.role === "user") return json({ success: false, error: "Unauthorized." });
  sheet.getRange(toSheetRow(data.row), col["scheduled"] + 1)
    .setValue(data.scheduled === true || data.scheduled === "true" ? "true" : "false");
  logActivity(session, "setScheduled", `row=${data.row} scheduled=${data.scheduled}`);
  return json({ success: true });
}

// ── New post from the submit page ───────────────────────────────────────────
function handleNewSubmission(sheet, col, data, session) {
  if (!session) return json({ success: false, error: "Please log in again." });

  const project = String(data.project || data.title || "").trim();
  if (!project) return json({ success: false, error: "Select a project." });

  // Access rules (admins and the owner can post to any project)
  if (project === BOD_PROJECT) {
    const u = findUser(session.phone);
    const hasClubRole = session.role === "owner" ||
      (u && resolveAccess(u.email, u.phone).clubRole);
    if (!hasClubRole) return json({ success: false, error: "You do not have access to BOD Post." });
  } else {
    const status = getProjectStatus_(project);
    if (status === null)        return json({ success: false, error: "Unknown project." });
    if (status === "completed") return json({ success: false, error: "This project is completed. You can't post to it." });
    if (session.role === "user") {
      const u = findUser(session.phone);
      if (!u || !u.projects.some(p => p.project === project))
        return json({ success: false, error: "You are not a member of this project." });
    }
  }

  const date = normDateServer(data.date);
  const slot = normSlotServer(data.timeslot);
  if (!date || !slot) return json({ success: false, error: "Select a date and a time slot." });

  // A slot closes 15 minutes after its start time
  const slotStart = slotToDate(date, slot, getTzOffsetHours());
  if (!slotStart) return json({ success: false, error: "Invalid time slot." });
  if (Date.now() - slotStart.getTime() > SLOT_GRACE_MIN * 60 * 1000)
    return json({ success: false, error: "That time slot has already closed. Please choose another." });

  const range = sheet.getDataRange();
  const vals  = range.getValues();
  const disp  = range.getDisplayValues();
  for (let i = 1; i < vals.length; i++) {
    if (normSlotServer(disp[i][col["timeslot"]]) === slot &&
        vals[i][col["status"]] !== "rejected" &&
        normDateServer(vals[i][col["date"]]) === date) {
      return json({ success: false, error: "That time slot is already taken." });
    }
  }

  const width = sheet.getLastColumn();
  const row   = new Array(width).fill("");
  const put   = (name, val) => { if (col[name] !== undefined) row[col[name]] = val; };
  put("title", project);
  put("content", String(data.content || ""));
  put("author", String(data.author || session.name || "").substring(0, 120));
  put("timeslot", slot);   put("date", date);
  put("media", data.media || "");
  put("status", "pending");
  put("cloudinary_public_id", extractPublicId_(data.media));
  put("shared", false);    put("scheduled", "false");
  put("submitted_by", session.phone);
  put("submitted_at", new Date().toISOString());

  const target = sheet.getLastRow() + 1;
  sheet.getRange(target, col["timeslot"] + 1).setNumberFormat("@");
  sheet.getRange(target, col["date"] + 1).setNumberFormat("@");
  sheet.getRange(target, 1, 1, width).setValues([row]);
  logActivity(session, "submit", `project=${project} date=${date} slot=${slot}`);
  return json({ success: true });
}

// ── User history ────────────────────────────────────────────────────────────
function handleGetMyPosts(sheet, col, session) {
  if (!session) return json({ success: false, error: "Please log in again." });
  const range = sheet.getDataRange();
  const disp  = range.getDisplayValues();
  const raw   = range.getValues();
  const tz    = Session.getScriptTimeZone();
  const now   = Date.now();
  const out   = [];
  for (let i = 1; i < disp.length; i++) {
    const r = disp[i];
    if (!r[col["title"]] && !r[col["date"]]) continue;
    if (!postOwnedBy_(r, col, session)) continue;

    const dv = raw[i][col["date"]];
    const date = (dv instanceof Date) ? Utilities.formatDate(dv, tz, "yyyy-MM-dd") : (r[col["date"]] || "");
    const status = (r[col["status"]] || "pending").toString().toLowerCase();
    const shared = String(r[col["shared"]]).toUpperCase() === "TRUE";
    const lockBy = String(r[col["editing_by"]] || "");
    const lockUntil = Number(r[col["editing_until"]]) || 0;
    const lockedByOther = !!lockBy && lockUntil > now && lockBy.split("|")[0] !== session.phone;

    out.push({
      row: i, project: r[col["title"]] || "", content: r[col["content"]] || "",
      media: r[col["media"]] || "", date: date, timeslot: normSlotServer(r[col["timeslot"]]),
      status: status, shared: shared,
      approvedBy: r[col["approved_by"]] || "", rejectedBy: r[col["rejected_by"]] || "",
      submittedAt: r[col["submitted_at"]] || "",
      lockedBy: lockedByOther ? (lockBy.split("|")[1] || "someone else") : "",
      canEdit: !shared && status !== "rejected" && !lockedByOther && withinEditWindow_(date)
    });
  }
  out.sort((a, b) => (b.date + b.timeslot).localeCompare(a.date + a.timeslot) || b.row - a.row);
  return json({ success: true, posts: out.slice(0, 100) });
}

// ── Edit lock (shared by the user page and the admin page) ──────────────────
function handleLockPost(sheet, col, data, session) {
  if (!session) return json({ success: false, error: "Please log in again." });
  const r = toSheetRow(data.row);
  if (!validRow_(sheet, r)) return json({ success: false, error: "Post not found." });
  if (session.role === "user") {
    const row = sheet.getRange(r, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    if (!postOwnedBy_(row, col, session)) return json({ success: false, error: "You can only edit your own posts." });
    if (!withinEditWindow_(normDateServer(sheet.getRange(r, col["date"] + 1).getValue())))
      return json({ success: false, error: "Posts can only be edited within 7 days." });
  }
  const lock = readLock_(sheet, col, r);
  if (lockedByOther_(lock, session))
    return json({ success: false, locked: true, error: "This post is being edited by " + lockOwnerName_(lock) + "." });
  setLock_(sheet, col, r, session);
  return json({ success: true });
}

function handleUnlockPost(sheet, col, data, session) {
  if (!session) return json({ success: false, error: "Please log in again." });
  const r = toSheetRow(data.row);
  if (!validRow_(sheet, r)) return json({ success: true });
  const lock = readLock_(sheet, col, r);
  if (lock.by && lock.by.split("|")[0] === session.phone) clearLock_(sheet, col, r);
  return json({ success: true });
}

// ── User edits their own post (until it is shared) ──────────────────────────
function handleEditMyPost(sheet, col, data, session) {
  if (!session) return json({ success: false, error: "Please log in again." });
  const r = toSheetRow(data.row);
  if (!validRow_(sheet, r)) return json({ success: false, error: "Post not found." });
  const row = sheet.getRange(r, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];

  if (!postOwnedBy_(row, col, session)) return json({ success: false, error: "You can only edit your own posts." });
  if (String(row[col["shared"]]).toUpperCase() === "TRUE")
    return json({ success: false, error: "This post has already been shared, so it can't be edited." });
  if (String(row[col["status"]]).toLowerCase() === "rejected")
    return json({ success: false, error: "This post was rejected. Please submit a new post." });
  if (!withinEditWindow_(normDateServer(sheet.getRange(r, col["date"] + 1).getValue())))
    return json({ success: false, error: "Posts can only be edited within 7 days." });

  const lock = readLock_(sheet, col, r);
  if (lockedByOther_(lock, session))
    return json({ success: false, locked: true, error: "This post is being edited by " + lockOwnerName_(lock) + "." });

  const content = String(data.content || "").trim();
  if (!content) return json({ success: false, error: "Post content can't be empty." });

  sheet.getRange(r, col["content"] + 1).setValue(content);
  if (data.media) {
    const oldId  = row[col["cloudinary_public_id"]];
    const oldUrl = row[col["media"]];
    sheet.getRange(r, col["media"] + 1).setValue(data.media);
    sheet.getRange(r, col["cloudinary_public_id"] + 1).setValue(extractPublicId_(data.media));
    if (oldId) deleteCloudinaryAsset(oldId, cloudinaryTypeFromUrl_(oldUrl));
  }
  // After any edit the post must be approved again
  sheet.getRange(r, col["status"]      + 1).setValue("pending");
  sheet.getRange(r, col["approved_by"] + 1).setValue("");
  sheet.getRange(r, col["scheduled"]   + 1).setValue("false");
  sheet.getRange(r, col["shared"]      + 1).setValue(false);
  clearLock_(sheet, col, r);
  logActivity(session, "editMyPost", `row=${data.row}`);
  return json({ success: true });
}

// ── Projects ────────────────────────────────────────────────────────────────
const PROJECT_STATUSES = ["ongoing", "tobe", "completed"];

function handleAddProject(data, session) {
  if (!session || session.role === "user") return json({ success: false, error: "Unauthorized." });
  const name = String(data.name || "").trim();
  if (!name) return json({ success: false, error: "Enter a project name." });
  if (name.toLowerCase() === BOD_PROJECT.toLowerCase()) return json({ success: false, error: "That name is reserved." });
  const status = PROJECT_STATUSES.includes(String(data.status)) ? data.status : "ongoing";
  ensureProjectsSheet().appendRow([name, status, data.color || "#b34e1a"]);
  logActivity(session, "addProject", `name=${name}`);
  return json({ success: true });
}

function handleRemoveProject(data, session) {
  if (!session || session.role === "user") return json({ success: false, error: "Unauthorized." });
  const sheet    = ensureProjectsSheet();
  const sheetRow = Number(data.row) + 1;
  const projectName = sheet.getRange(sheetRow, 1).getValue();
  if (sheetRow > 1) sheet.deleteRow(sheetRow);

  // also remove this project from every user's saved project list
  const usersSheet = ensureUsersSheet();
  const usersData  = usersSheet.getDataRange().getValues();
  for (let i = 1; i < usersData.length; i++) {
    let projects = [];
    try { projects = JSON.parse(usersData[i][3] || "[]"); } catch(e) { continue; }
    const filtered = projects.filter(p => p.project !== projectName);
    if (filtered.length !== projects.length) {
      usersSheet.getRange(i + 1, 4).setValue(JSON.stringify(filtered));
    }
  }
  logActivity(session, "removeProject", `row=${data.row} name=${projectName}`);
  return json({ success: true });
}

function handleUpdateProject(data, session) {
  if (!session || session.role === "user") return json({ success: false, error: "Unauthorized." });
  const sheet    = ensureProjectsSheet();
  const sheetRow = Number(data.row) + 1;
  const status   = PROJECT_STATUSES.includes(String(data.status)) ? data.status : "ongoing";
  sheet.getRange(sheetRow, 1).setValue(data.name);
  sheet.getRange(sheetRow, 2).setValue(status);
  sheet.getRange(sheetRow, 3).setValue(data.color || "#b34e1a");
  logActivity(session, "updateProject", `row=${data.row} name=${data.name} status=${status}`);
  return json({ success: true });
}

// ── Admin whitelist (phone or email + club role) — owner only ───────────────
function applyAccessToAccount_(acct, access) {
  const sh = ensureUsersSheet();
  sh.getRange(acct.row, 3).setValue(access.role);
  sh.getRange(acct.row, 9).setValue(access.clubRole);
}

function handleGetAdminEntries(session) {
  if (!session || session.role !== "owner") return json({ success: false, error: "Unauthorized." });
  const entries = getAdminEntries_().map(en => {
    const isEmail = en.id.indexOf("@") >= 0;
    const acct = isEmail ? findUserByEmail(en.id) : findUser(en.id);
    return { id: en.id, type: isEmail ? "email" : "phone", role: en.role,
             account: acct ? { name: acct.name, email: acct.email, phone: acct.phone } : null };
  });
  return json({ success: true, entries: entries, clubRoles: getRoleLists().clubRoles });
}

function handleSetAdminEntry(data, session) {
  if (!session || session.role !== "owner") return json({ success: false, error: "Unauthorized." });
  const id   = normId_(data.id);
  const role = String(data.role || "").trim();
  if (!id) return json({ success: false, error: "Enter a phone number or email." });
  if (id.indexOf("@") >= 0) {
    if (!EMAIL_RE.test(id)) return json({ success: false, error: "That email isn't valid." });
  } else if (id.length < 9 || id.length > 15) {
    return json({ success: false, error: "That phone number isn't valid." });
  }
  if (!getRoleLists().clubRoles.includes(role)) return json({ success: false, error: "Choose a role from the list." });

  const entries = getAdminEntries_();
  const hit = entries.find(x => x.id === id);
  if (hit) hit.role = role; else entries.push({ id: id, role: role });
  saveAdminEntries_(entries);

  const acct = id.indexOf("@") >= 0 ? findUserByEmail(id) : findUser(id);
  if (acct) applyAccessToAccount_(acct, { role: "admin", clubRole: role });
  logActivity(session, "setAdminEntry", `${id} → ${role}`);
  return json({ success: true });
}

function handleRemoveAdminEntry(data, session) {
  if (!session || session.role !== "owner") return json({ success: false, error: "Unauthorized." });
  const id = normId_(data.id);
  saveAdminEntries_(getAdminEntries_().filter(x => x.id !== id));
  const acct = id.indexOf("@") >= 0 ? findUserByEmail(id) : findUser(id);
  if (acct) applyAccessToAccount_(acct, { role: "user", clubRole: "" });   // back to a normal user
  logActivity(session, "removeAdminEntry", id);
  return json({ success: true });
}

// Older admin-page whitelist box (kept so the current page keeps working until it is replaced)
function handleGetWhitelist(session) {
  if (!session || session.role !== "owner") return json({ success: false, error: "Unauthorized." });
  return json({ success: true, whitelist: getAdminEntries_().map(x => x.id) });
}

function handleSetWhitelist(data, session) {
  if (!session || session.role !== "owner") return json({ success: false, error: "Unauthorized." });
  const ids = (data.whitelist || []).map(normId_).filter(Boolean);
  const old = getAdminEntries_();
  const next = ids.map(id => old.find(x => x.id === id) || { id: id, role: "Admin" });
  saveAdminEntries_(next);
  logActivity(session, "setWhitelist", ids.join(","));
  return json({ success: true });
}

function handleGetSheetUrls(session) {
  if (!session || session.role !== "owner") return json({ success: false, error: "Unauthorized." });
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const baseUrl = ss.getUrl();
  const result  = {};
  ["Database", "Projects", "Users", "ActivityLog"].forEach(name => {
    const s = ss.getSheetByName(name);
    if (s) result[name] = `${baseUrl}#gid=${s.getSheetId()}`;
  });
  return json({ success: true, urls: result });
}

// ---------------------------------------------------------------------------
// Auth — Email signup (Gmail OTP) + password login
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hashPassword(pw, salt) {
  let h = salt + pw;
  for (let i = 0; i < 300; i++) {
    h = Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt));
  }
  return h;
}

// Validates a project list. New (not previously saved) projects must exist and not be completed.
function cleanProjects_(arr, existing) {
  const out = [], seen = {};
  for (const p of (Array.isArray(arr) ? arr : []).slice(0, 30)) {
    const name = String((p && p.project) || "").trim();
    const role = String((p && p.role) || "").trim().substring(0, 40);
    if (!name || !role || seen[name]) continue;
    const st = getProjectStatus_(name);
    if (st === null) return { error: "Unknown project: " + name };
    if (st === "completed" && !(existing || []).some(e => e.project === name))
      return { error: name + " is completed and can't be added." };
    seen[name] = true;
    out.push({ project: name, role: role });
  }
  return { projects: out };
}

// 1) Send OTP to the user's email — new users only
function handleEmailSendOtp(data) {
  const email = String(data.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email))
    return json({ success: false, error: "Please enter a valid email address." });
  if (findUserByEmail(email))
    return json({ success: false, error: "This email is already registered. Please log in." });

  const cache = CacheService.getScriptCache();
  if (cache.get("eotp_cd_" + email))
    return json({ success: false, error: "Please wait 60 seconds before requesting another code." });

  const code = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
  cache.put("eotp_" + email, JSON.stringify({ code: code, tries: 0 }), 600);
  cache.put("eotp_cd_" + email, "1", 60);

  try {
    MailApp.sendEmail({
      to: email,
      subject: "Your verification code: " + code,
      htmlBody: "<div style='font-family:Arial,sans-serif'><h2>Time Slot Scheduler</h2>" +
        "<p>Your verification code is</p>" +
        "<p style='font-size:32px;font-weight:bold;letter-spacing:6px;color:#b34e1a'>" + code + "</p>" +
        "<p>It expires in 10 minutes. If you didn't request this, ignore this email.</p></div>"
    });
  } catch (e) {
    return json({ success: false, error: "Could not send email: " + e.message });
  }
  logActivity(null, "emailSendOtp", "email=" + email);
  return json({ success: true });
}

// 2) Verify OTP → one-time signup ticket
function handleEmailVerifyOtp(data) {
  const email = String(data.email || "").trim().toLowerCase();
  const cache = CacheService.getScriptCache();
  const raw   = cache.get("eotp_" + email);
  if (!raw) return json({ success: false, error: "Code expired. Request a new one." });
  const o = JSON.parse(raw);
  if (o.tries >= 5) {
    cache.remove("eotp_" + email);
    return json({ success: false, error: "Too many attempts. Request a new code." });
  }
  if (String(data.code || "").trim() !== o.code) {
    o.tries++;
    cache.put("eotp_" + email, JSON.stringify(o), 600);
    return json({ success: false, error: "Wrong code." });
  }
  cache.remove("eotp_" + email);
  const ticket = Utilities.getUuid();
  cache.put("eticket_" + ticket, email, 1800); // 30 min to finish signup
  return json({ success: true, ticket: ticket });
}

// 3) Create account: password + name + phone number + projects
function handleRegisterAccount(data) {
  const cache = CacheService.getScriptCache();
  const email = cache.get("eticket_" + data.ticket);
  if (!email) return json({ success: false, error: "Verification expired. Start again." });

  const pw = String(data.password || "");
  if (pw.length < 8) return json({ success: false, error: "Password must be at least 8 characters." });
  const name = String(data.name || "").trim().substring(0, 60);
  if (!name) return json({ success: false, error: "Enter your name." });
  const phone = normalizePhone(data.phone || "");
  if (phone.length < 9 || phone.length > 15) return json({ success: false, error: "Enter a valid phone number." });
  const cp = cleanProjects_(data.projects, []);
  if (cp.error) return json({ success: false, error: cp.error });
  if (!cp.projects.length) return json({ success: false, error: "Select at least one project and role." });
  const reserved = normalizePhone(PropertiesService.getScriptProperties().getProperty("OWNER_PHONE") || "94767633875");
  if (phone === reserved) return json({ success: false, error: "This number is reserved." });

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (findUserByEmail(email)) return json({ success: false, error: "Email already registered." });
    if (findUser(phone))
      return json({ success: false, error: "This phone number already has an account. Ask the owner to delete the old row in the Users sheet, then sign up again." });

    const access = resolveAccess(email, phone);
    const salt = Utilities.getUuid();
    ensureUsersSheet().appendRow([phone, name, access.role, JSON.stringify(cp.projects),
      email, salt, hashPassword(pw, salt), new Date(), access.clubRole]);

    cache.remove("eticket_" + data.ticket);
    const token = issueToken(phone, access.role, name);
    logActivity({ phone, role: access.role, name }, "register", "email=" + email);
    return json({
      success: true, token, paused: isSystemPaused(),
      user: { email, phone, name, role: access.role, clubRole: access.clubRole, projects: cp.projects, isNew: false }
    });
  } finally {
    lock.releaseLock();
  }
}

// 4) Login with email OR phone number + password
function handleLoginPassword(data) {
  const id = String(data.identifier || "").trim();
  const pw = String(data.password || "");
  if (!id || !pw) return json({ success: false, error: "Enter username and password." });

  const isEmail = id.indexOf("@") >= 0;
  const key     = "elf_" + (isEmail ? id.toLowerCase() : normalizePhone(id));
  const cache   = CacheService.getScriptCache();
  const fails   = parseInt(cache.get(key) || "0", 10);
  if (fails >= 5) return json({ success: false, error: "Too many failed attempts. Try again in 10 minutes." });

  // ── Owner login: owner phone + OWNER_PASSWORD from Script Properties ──────
  const props      = PropertiesService.getScriptProperties();
  const ownerPhone = normalizePhone(props.getProperty("OWNER_PHONE") || "94767633875");
  const ownerPw    = props.getProperty("OWNER_PASSWORD") || "";
  const ownerName  = props.getProperty("OWNER_NAME") || "Owner";
  if (!isEmail && normalizePhone(id) === ownerPhone) {
    if (!ownerPw || pw !== ownerPw) {
      cache.put(key, String(fails + 1), 600);
      return json({ success: false, error: "Wrong username or password." });
    }
    cache.remove(key);
    const ou = findUser(ownerPhone);
    const otoken = issueToken(ownerPhone, "owner", ownerName);
    logActivity({ phone: ownerPhone, role: "owner", name: ownerName }, "login", "owner password");
    return json({
      success: true, token: otoken, paused: isSystemPaused(),
      user: { email: "", phone: ownerPhone, name: ownerName, role: "owner", clubRole: "Owner",
              projects: ou ? ou.projects : [], isNew: false }
    });
  }

  const user = isEmail ? findUserByEmail(id) : findUser(normalizePhone(id));
  const ok   = user && user.hash && user.salt && hashPassword(pw, user.salt) === user.hash;
  if (!ok) {
    cache.put(key, String(fails + 1), 600);
    return json({ success: false, error: "Wrong username or password." });
  }
  cache.remove(key);

  // Access is re-checked on every login (whitelist changes apply immediately)
  const access = resolveAccess(user.email, user.phone);
  if (access.role !== user.role || access.clubRole !== user.clubRole) applyAccessToAccount_(user, access);

  const token = issueToken(user.phone, access.role, user.name);
  logActivity({ phone: user.phone, role: access.role, name: user.name }, "login", "password");
  return json({
    success: true, token, paused: isSystemPaused(),
    user: { email: user.email, phone: user.phone, name: user.name, role: access.role,
            clubRole: access.clubRole, projects: user.projects, isNew: false }
  });
}

// 5) Logged-in user saves their project list
function handleSaveAccountProjects(data, session) {
  if (!session) return json({ success: false, error: "Unauthorized." });
  const user = findUser(session.phone);
  const cp = cleanProjects_(data.projects, user ? user.projects : []);
  if (cp.error) return json({ success: false, error: cp.error });
  if (!user) {
    if (session.role !== "owner") return json({ success: false, error: "Account not found." });
    ensureUsersSheet().appendRow([session.phone, session.name || "Owner", "owner", JSON.stringify(cp.projects), "", "", "", new Date(), "Owner"]);
  } else {
    ensureUsersSheet().getRange(user.row, 4).setValue(JSON.stringify(cp.projects));
  }
  logActivity(session, "saveAccountProjects", JSON.stringify(cp.projects));
  return json({ success: true, projects: cp.projects });
}

// 6) Change password (logged-in users)
function handleChangePassword(data, session) {
  if (!session) return json({ success: false, error: "Please log in again." });
  const user = findUser(session.phone);
  if (!user || !user.hash)
    return json({ success: false, error: "The owner password is set in the Script Properties (OWNER_PASSWORD)." });

  const cache = CacheService.getScriptCache();
  const key   = "cpf_" + session.phone;
  const fails = parseInt(cache.get(key) || "0", 10);
  if (fails >= 5) return json({ success: false, error: "Too many attempts. Try again in 10 minutes." });

  const oldPw = String(data.oldPassword || ""), newPw = String(data.newPassword || "");
  if (hashPassword(oldPw, user.salt) !== user.hash) {
    cache.put(key, String(fails + 1), 600);
    return json({ success: false, error: "Your current password is wrong." });
  }
  if (newPw.length < 8)  return json({ success: false, error: "New password must be at least 8 characters." });
  if (newPw === oldPw)   return json({ success: false, error: "New password must be different." });

  const salt = Utilities.getUuid();
  const sh = ensureUsersSheet();
  sh.getRange(user.row, 6).setValue(salt);
  sh.getRange(user.row, 7).setValue(hashPassword(newPw, salt));
  cache.remove(key);
  logActivity(session, "changePassword", "");
  return json({ success: true });
}

// Run ONCE from the editor to grant Gmail-sending permission, then redeploy.
function authorizeMail() {
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(), "Mail permission OK", "Authorized.");
}

// ---------------------------------------------------------------------------
// Clean-up: 7 days after the post date the MEDIA is deleted (saves storage),
// the post text stays in the sheet so history can still show it.
// ---------------------------------------------------------------------------
function autoDeleteOldPosts() {
  const sheet = ensureDatabaseSheet();
  ensureColumns();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col     = buildColMap(headers);
  const data    = sheet.getDataRange().getValues();
  const tz      = Session.getScriptTimeZone();
  const cutoff  = Utilities.formatDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), tz, "yyyy-MM-dd");
  let done = 0;
  for (let i = 1; i < data.length && done < 30; i++) {
    const dateStr = normDateServer(data[i][col["date"]]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || dateStr >= cutoff) continue;
    const publicId = data[i][col["cloudinary_public_id"]];
    const mediaUrl = data[i][col["media"]];
    if (!publicId && !mediaUrl) continue;                 // media already removed
    if (publicId) {
      const res = deleteCloudinaryAsset(publicId, cloudinaryTypeFromUrl_(mediaUrl));
      if (!res.success && !/not found/i.test(res.error || "")) continue;   // retry next run
    }
    sheet.getRange(i + 1, col["media"] + 1).setValue("");
    sheet.getRange(i + 1, col["cloudinary_public_id"] + 1).setValue("");
    done++;
  }
  if (done) console.log("autoDeleteOldPosts: removed media from " + done + " old post(s).");
}

function setupAutoDeleteTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === "autoDeleteOldPosts") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("autoDeleteOldPosts").timeBased().everyDays(1).atHour(2).create();
  console.log("✅ Clean-up trigger created: runs daily at 2 AM.");
}

// ---------------------------------------------------------------------------
// AUTO-PUBLISHER (kept, but switched off: admins share manually)
// ---------------------------------------------------------------------------
const AUTO_SHARE_ENABLED = false;

function autoSchedulePosts() {
  if (!AUTO_SHARE_ENABLED || isSystemPaused()) return;
  const sheet = ensureDatabaseSheet();
  ensureColumns();

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col     = buildColMap(headers);
  const data    = sheet.getDataRange().getValues();
  const now     = new Date();
  const tzOff   = getTzOffsetHours();

  const EARLY_MS  =  5 * 60 * 1000;
  const LATE_MS   = 10 * 60 * 1000;

  const defaultChannelsRaw = PropertiesService.getScriptProperties()
    .getProperty("BUFFER_DEFAULT_CHANNELS") || "";
  const defaultChannels = defaultChannelsRaw.split(",").map(s => s.trim()).filter(Boolean);

  for (let i = 1; i < data.length; i++) {
    const r = data[i];

    const status    = (r[col["status"]]    || "").toString().toLowerCase();
    const scheduled = (r[col["scheduled"]] || "").toString().toLowerCase();
    const shared    = (r[col["shared"]]    || "").toString().toUpperCase();

    if (status    !== "approved") continue;
    if (scheduled !== "true")     continue;
    if (shared    === "TRUE")     continue;

    const dateStr = normDateServer(r[col["date"]]);
    const slotStr = normSlotServer(r[col["timeslot"]]);
    if (!dateStr || !slotStr) continue;

    const slotDate = slotToDate(dateStr, slotStr, tzOff);
    if (!slotDate) continue;
    const msFromSlot = now.getTime() - slotDate.getTime();

    if (msFromSlot < -EARLY_MS) continue;
    if (msFromSlot > LATE_MS) {
      sheet.getRange(i + 1, col["scheduled"] + 1).setValue("false");
      console.log(`autoSchedulePosts: row ${i} slot passed → set to manual`);
      continue;
    }

    const content  = String(r[col["content"]] || "");
    const mediaUrl = String(r[col["media"]]   || "");
    const title    = String(r[col["title"]]   || "");
    console.log(`autoSchedulePosts: publishing row ${i} "${title}" (slot: ${slotStr} ${dateStr})`);

    let autoSocialTargets = [];
    let youtubeTitle = null;
    let youtubeCategoryId = null;
    try {
      const rawSocial = r[col["auto_social_targets"]];
      if (rawSocial && rawSocial !== "") autoSocialTargets = JSON.parse(rawSocial);
    } catch(e) { console.warn(`Failed to parse auto_social_targets row ${i}:`, e); }
    if (r[col["youtube_title"]]) youtubeTitle = r[col["youtube_title"]];
    if (r[col["youtube_category_id"]]) youtubeCategoryId = r[col["youtube_category_id"]];

    const postIds   = [];
    const succeeded = [];
    const failed    = [];

    if (autoSocialTargets.length > 0) {
      for (const profile of autoSocialTargets) {
        const token = getBufferToken(profile.orgType || "social");
        if (!token) { failed.push(`${profile.id}: no token`); continue; }
        const isYt = (profile.serviceName || "").toLowerCase() === "youtube";
        const youtubeMeta = isYt ? { title: youtubeTitle || content.substring(0,100), categoryId: youtubeCategoryId || "22" } : null;
        const result = createBufferPost(token, profile.id, content, mediaUrl, profile.serviceName, youtubeMeta);
        if (result.success) { postIds.push(result.postId); succeeded.push(profile.serviceName || profile.id); }
        else failed.push(`${profile.id}: ${result.error}`);
      }
    } else if (defaultChannels.length > 0) {
      for (const entry of defaultChannels) {
        const parts   = entry.split(":");
        const chId    = parts[0];
        const orgType = parts[1] || "social";
        const token   = getBufferToken(orgType);
        if (!token) { failed.push(`${chId}: no token`); continue; }
        const result = createBufferPost(token, chId, content, mediaUrl, null, null);
        if (result.success) { postIds.push(result.postId); succeeded.push(chId); }
        else failed.push(`${chId}: ${result.error}`);
      }
    } else {
      console.warn(`autoSchedulePosts: no social destinations for row ${i}`);
    }

    if (succeeded.length > 0) {
      const sheetRow = i + 1;
      sheet.getRange(sheetRow, col["shared"]          + 1).setValue(true);
      sheet.getRange(sheetRow, col["buffer_post_ids"] + 1).setValue(postIds.join(","));
      sheet.getRange(sheetRow, col["platforms"]       + 1).setValue(succeeded.join(","));
      console.log(`autoSchedulePosts: row ${i} published to: ${succeeded.join(", ")}`);
    }
    if (failed.length) console.warn(`autoSchedulePosts: failures for row ${i}:`, failed.join("; "));
  }
}

function setupAutoScheduleTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === "autoSchedulePosts") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("autoSchedulePosts").timeBased().everyMinutes(10).create();
  console.log("✅ Auto-publish trigger created: runs every 10 minutes.");
}

function handleSaveAutoDestinations(sheet, col, data, session) {
  if (!session || session.role === "user") return json({ success: false, error: "Unauthorized." });
  const r = toSheetRow(data.row);
  if (data.socialProfiles !== undefined) {
    sheet.getRange(r, col["auto_social_targets"] + 1).setValue(JSON.stringify(data.socialProfiles));
  }
  if (data.youtubeTitle !== undefined) {
    sheet.getRange(r, col["youtube_title"] + 1).setValue(data.youtubeTitle);
  }
  if (data.youtubeCategoryId !== undefined) {
    sheet.getRange(r, col["youtube_category_id"] + 1).setValue(data.youtubeCategoryId);
  }
  logActivity(session, "saveAutoDestinations", `row=${data.row}`);
  return json({ success: true });
}

// ---------------------------------------------------------------------------
// Buffer asset shape: ask Buffer's own schema how media must be sent (cached 6 h)
// ---------------------------------------------------------------------------
function getBufferAssetShape(token) {
  const cache = CacheService.getScriptCache();
  const hit   = cache.get("BUFFER_ASSET_SHAPE");
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  try {
    const typeFrag = "kind name ofType { kind name ofType { kind name ofType { kind name } } }";
    const query = `{
      ci: __type(name: "CreatePostInput") { inputFields { name type { ${typeFrag} } } }
      ai: __type(name: "AssetInput")      { inputFields { name type { ${typeFrag} } } }
    }`;
    const r = UrlFetchApp.fetch(BUFFER_GRAPHQL_URL, {
      method: "post", contentType: "application/json",
      headers: { Authorization: "Bearer " + token },
      payload: JSON.stringify({ query }), muteHttpExceptions: true
    });
    const body = JSON.parse(r.getContentText());
    const ci = body.data && body.data.ci, ai = body.data && body.data.ai;
    if (!ci || !ai) return null;
    const isList = (t) => { for (let x = t; x; x = x.ofType) if (x.kind === "LIST") return true; return false; };
    const assetsField = ci.inputFields.find(f => f.name === "assets");
    const names = ai.inputFields.map(f => f.name);
    const pick = (re) => {
      const f = ai.inputFields.find(x => re.test(x.name));
      return f ? { key: f.name, isList: isList(f.type) } : null;
    };
    const shape = {
      assetsIsList: assetsField ? isList(assetsField.type) : false,
      image: pick(/^images?$/i),
      video: pick(/^videos?$/i),
      fields: names
    };
    cache.put("BUFFER_ASSET_SHAPE", JSON.stringify(shape), 21600);
    return shape;
  } catch (e) {
    console.error("getBufferAssetShape error:", e);
    return null;
  }
}

// YouTube metadata: read Buffer's schema and fill every REQUIRED field (cached 6 h)
function getYoutubeMetaShape(token) {
  const cache = CacheService.getScriptCache();
  const hit   = cache.get("BUFFER_YT_SHAPE");
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  try {
    const gql = (query) => JSON.parse(UrlFetchApp.fetch(BUFFER_GRAPHQL_URL, {
      method: "post", contentType: "application/json",
      headers: { Authorization: "Bearer " + token },
      payload: JSON.stringify({ query }), muteHttpExceptions: true
    }).getContentText());

    const typeFrag = "kind name ofType { kind name ofType { kind name ofType { kind name } } }";
    const first = gql(`{ yt: __type(name: "YoutubePostMetadataInput") { inputFields { name type { ${typeFrag} } } } }`);
    const yt = first.data && first.data.yt;
    if (!yt) return null;

    const unwrap = (t) => { let x = t; while (x && (x.kind === "NON_NULL" || x.kind === "LIST")) x = x.ofType; return x || {}; };
    const shape = {};
    const enumTypes = {};
    yt.inputFields.forEach(f => {
      const base = unwrap(f.type);
      shape[f.name] = { required: f.type.kind === "NON_NULL", type: base.name, kind: base.kind, values: null };
      if (base.kind === "ENUM") enumTypes[base.name] = true;
    });
    const enumNames = Object.keys(enumTypes);
    if (enumNames.length) {
      const q = "{ " + enumNames.map((n, i) => `e${i}: __type(name: "${n}") { enumValues { name } }`).join(" ") + " }";
      const ev = gql(q).data || {};
      enumNames.forEach((n, i) => {
        const vals = ev["e" + i] ? ev["e" + i].enumValues.map(v => v.name) : [];
        Object.keys(shape).forEach(k => { if (shape[k].type === n) shape[k].values = vals; });
      });
    }
    cache.put("BUFFER_YT_SHAPE", JSON.stringify(shape), 21600);
    return shape;
  } catch (e) {
    console.error("getYoutubeMetaShape error:", e);
    return null;
  }
}

function buildYoutubeMetadata(token, base) {
  const shape = getYoutubeMetaShape(token);
  if (!shape) return base;
  const out = {};
  const pickEnum = (f, want) => {
    const vals = f.values || [];
    if (!vals.length) return want;
    const hit = vals.find(v => String(v).toLowerCase() === String(want).toLowerCase());
    return hit || vals.find(v => /^public$/i.test(v)) || vals[0];
  };
  Object.keys(base).forEach(k => {
    const name = [k, k.replace(/Id$/, ""), k + "Id"].find(n => shape[n]);
    if (!name) return;
    const f = shape[name];
    let v = base[k];
    if (f.kind === "ENUM")                  v = pickEnum(f, v);
    else if (f.type === "Int")              v = Number(v) || 0;
    else if (f.type === "Boolean")          v = !!v;
    else if (f.kind === "SCALAR")           v = String(v);
    out[name] = v;
  });
  Object.keys(shape).forEach(name => {
    const f = shape[name];
    if (!f.required || out[name] !== undefined) return;
    if (f.kind === "ENUM")                  out[name] = pickEnum(f, "public");
    else if (f.type === "Boolean")          out[name] = /embed/i.test(name);
    else if (f.type === "Int" || f.type === "Float") out[name] = 0;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Buffer API — publish immediately
// ---------------------------------------------------------------------------
function createBufferPost(token, channelId, text, mediaUrl, service, youtubeMeta) {
  const input = {
    text:           text,
    channelId:      channelId,
    schedulingType: "automatic",
    mode:           "shareNow"
  };

  let assetVariants = [null];
  const isVideo = !!mediaUrl && (/\.(mp4|mov|webm|avi)(\?|$)/i.test(mediaUrl) || mediaUrl.includes("/video/upload/"));
  if (mediaUrl) {
    assetVariants = isVideo
      ? [{ video: { url: mediaUrl } }, { video: [{ url: mediaUrl }] }, { videos: [{ url: mediaUrl }] }]
      : [{ image: { url: mediaUrl } }, { image: [{ url: mediaUrl }] }, { images: [{ url: mediaUrl }] }];

    const shape = getBufferAssetShape(token);
    const f     = shape && (isVideo ? shape.video : shape.image);
    if (f) {
      const inner = { url: mediaUrl };
      const obj   = {}; obj[f.key] = f.isList ? [inner] : inner;
      assetVariants.unshift(shape.assetsIsList ? [obj] : obj);
    }
  }

  if (service === "facebook")  input.metadata = { facebook:  { type: "post" } };
  // Instagram feed "post" videos are limited to 1 minute, so videos are sent as Reels first
  let metaVariants = [null];
  if (service === "instagram") {
    metaVariants = isVideo
      ? [{ instagram: { type: "reel", shouldShareToFeed: true } },
         { instagram: { type: "post", shouldShareToFeed: true } }]
      : [{ instagram: { type: "post", shouldShareToFeed: true } }];
  }
  if (service === "tiktok")    input.metadata = { tiktok:    { title: text.substring(0, 100) } };
  if (service === "youtube") {
    const ytTitle      = String((youtubeMeta && youtubeMeta.title) ? youtubeMeta.title : text).replace(/\s+/g, " ").trim().substring(0, 100);
    const ytCategoryId = (youtubeMeta && youtubeMeta.categoryId) ? youtubeMeta.categoryId : "22";
    input.metadata = {
      youtube: buildYoutubeMetadata(token, {
        title:      ytTitle,
        categoryId: ytCategoryId,
        privacy:    "public"
      })
    };
  }

  const mutation = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess { post { id } }
        ... on MutationError    { message }
      }
    }
  `;

  try {
    let lastError = "No post ID returned.";
    for (let mi = 0; mi < metaVariants.length; mi++) {
      if (metaVariants[mi]) input.metadata = metaVariants[mi];
      for (const assets of assetVariants) {
        if (assets) input.assets = assets; else delete input.assets;
        const response = UrlFetchApp.fetch(BUFFER_GRAPHQL_URL, {
          method: "post", contentType: "application/json",
          headers: { Authorization: `Bearer ${token}` },
          payload: JSON.stringify({ query: mutation, variables: { input } }),
          muteHttpExceptions: true
        });
        const result = JSON.parse(response.getContentText());
        console.log("Buffer response for", channelId, ":", JSON.stringify(result));
        if (result.data?.createPost?.post?.id) return { success: true, postId: result.data.createPost.post.id };
        lastError = result.errors ? result.errors[0].message
                  : (result.data?.createPost?.message || "No post ID returned.");
        if (!/AssetInput|input\.assets/i.test(lastError)) break;
      }
      const typeProblem = /InstagramPostType|invalid value|enum|does not exist|unknown/i.test(lastError)
                       && !/minute|second|longer|duration|size|aspect|resolution/i.test(lastError);
      if (!typeProblem) break;
    }
    return { success: false, error: lastError };
  } catch (err) {
    console.error("createBufferPost error:", err);
    return { success: false, error: err.toString() };
  }
}

// ---------------------------------------------------------------------------
// Cloudinary — delete asset (images AND videos)
// ---------------------------------------------------------------------------
function deleteCloudinaryAsset(publicId, resourceType) {
  if (!publicId) return { success: false, error: "No public ID." };
  const props     = PropertiesService.getScriptProperties();
  const cloudName = props.getProperty("CLOUDINARY_CLOUD_NAME");
  const apiKey    = props.getProperty("CLOUDINARY_API_KEY");
  const apiSecret = props.getProperty("CLOUDINARY_API_SECRET");
  if (!cloudName || !apiKey || !apiSecret) return { success: false, error: "Cloudinary credentials not set." };
  const type         = resourceType === "video" ? "video" : "image";
  const timestamp    = Math.floor(Date.now() / 1000);
  const stringToSign = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const signature    = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, stringToSign)
    .map(b => ("0" + (b & 0xff).toString(16)).slice(-2)).join("");
  try {
    const response = UrlFetchApp.fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${type}/destroy`, {
      method: "post", payload: { public_id: publicId, timestamp, api_key: apiKey, signature },
      muteHttpExceptions: true
    });
    const result = JSON.parse(response.getContentText());
    if (result.result === "ok")        return { success: true };
    if (result.result === "not found") return { success: false, error: "not found" };
    return { success: false, error: result.error?.message || "Unknown." };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// ---------------------------------------------------------------------------
// Debug helpers (run from the editor)
// ---------------------------------------------------------------------------
function debugGraphql_(tokenKey, query, label) {
  const token = PropertiesService.getScriptProperties().getProperty(tokenKey);
  const r = UrlFetchApp.fetch(BUFFER_GRAPHQL_URL, {
    method: "post", contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({ query }), muteHttpExceptions: true
  });
  console.log(label + ":", r.getContentText());
}

function debugAutoSchedule() { autoSchedulePosts(); }

function debugPublish() {
  const token  = PropertiesService.getScriptProperties().getProperty("BUFFER_TOKEN_SOCIAL");
  const result = createBufferPost(token, "69cbe333af47dacb6973a7a2", "Test post from API",
    "https://res.cloudinary.com/dfxbg9cr1/image/upload/v1776351187/ipcgkayjhkwhqvjkz2b4.jpg", "instagram");
  console.log("Result:", JSON.stringify(result));
}

function debugBuffer() {
  debugGraphql_("BUFFER_TOKEN_SOCIAL", `{ account { channels { id name service } } }`, "Response");
}

function debugGetProfiles() {
  ["social", "video"].forEach(orgType => {
    const key = orgType === "social" ? "BUFFER_TOKEN_SOCIAL" : "BUFFER_TOKEN_VIDEO";
    if (!PropertiesService.getScriptProperties().getProperty(key)) { console.log(orgType + " token: NOT SET"); return; }
    debugGraphql_(key, `{ channels(input: { organizationId: "${getBufferOrgId(orgType)}" }) { id name service } }`, orgType + " response");
  });
}

function debugBufferSchema() {
  debugGraphql_("BUFFER_TOKEN_SOCIAL", `{ __type(name: "CreatePostInput") { fields { name type { name kind ofType { name kind } } } } }`, "CreatePostInput fields");
}
function debugBufferEnums() {
  debugGraphql_("BUFFER_TOKEN_SOCIAL", `{ st: __type(name: "SchedulingType") { enumValues { name } } sm: __type(name: "ShareMode") { enumValues { name } } }`, "Enums");
}
function debugAllMetadataTypes() {
  debugGraphql_("BUFFER_TOKEN_VIDEO", `{ __schema { types { name kind } } }`, "All types");
}
function debugYouTubeFields() {
  debugGraphql_("BUFFER_TOKEN_VIDEO", `{ yt: __type(name: "YoutubePostMetadataInput") { inputFields { name type { name kind ofType { name kind } } } } privacy: __type(name: "YoutubePrivacy") { enumValues { name } } }`, "YouTube fields");
}
function debugAssetInput() {
  debugGraphql_("BUFFER_TOKEN_SOCIAL", `{ a: __type(name: "AssetInput") { inputFields { name type { name kind ofType { name kind } } } } }`, "AssetInput");
}

function debugSheetData() {
  const sheet   = ensureDatabaseSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col     = buildColMap(headers);
  const data    = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    console.log(`Row ${i}:`, JSON.stringify({
      status: r[col["status"]], scheduled: r[col["scheduled"]], shared: r[col["shared"]],
      date: r[col["date"]], timeslot: r[col["timeslot"]]
    }));
  }
}


// ---------------------------------------------------------------------------
// Diagnostics: quick scan (admins, read-only) and full scan (owner only)
// ---------------------------------------------------------------------------
function fetchBufferChannels_(orgType) {
  const t = getBufferToken(orgType);
  if (!t) return { ok: false, missing: true, error: "No token set." };
  try {
    const r = UrlFetchApp.fetch(BUFFER_GRAPHQL_URL, {
      method: "post", contentType: "application/json",
      headers: { Authorization: "Bearer " + t },
      payload: JSON.stringify({ query: `{ channels(input: { organizationId: "${getBufferOrgId(orgType)}" }) { id name service } }` }),
      muteHttpExceptions: true
    });
    const body = JSON.parse(r.getContentText());
    if (body.errors) return { ok: false, error: String(body.errors[0].message || "Buffer error").substring(0, 160) };
    const ch = (body.data && body.data.channels) || [];
    return { ok: true, count: ch.length, services: Array.from(new Set(ch.map(c => String(c.service || "?").toLowerCase()))) };
  } catch (e) { return { ok: false, error: String(e).substring(0, 160) }; }
}

function handleScan_(session, full) {
  if (!session || session.role === "user") return json({ success: false, error: "Unauthorized." });
  if (full && session.role !== "owner")    return json({ success: false, error: "Only the owner can run the full scan." });

  const started = Date.now();
  const res = [];
  const add = (group, name, level, detail) => res.push({ group: group, name: name, level: level, detail: detail || "" });
  const P   = PropertiesService.getScriptProperties();
  const has = (k) => !!String(P.getProperty(k) || "").trim();
  const ss  = SpreadsheetApp.getActiveSpreadsheet();

  // ── Settings ──────────────────────────────────────────────────────────────
  add("Settings", "Login token secret", has("TOKEN_SECRET") ? "ok" : "error",
      has("TOKEN_SECRET") ? "Set." : "TOKEN_SECRET is missing, so logins use an insecure default. Add it in Script Properties.");
  add("Settings", "Owner login", (has("OWNER_PASSWORD") && has("OWNER_PHONE")) ? "ok" : (has("OWNER_PASSWORD") ? "warn" : "error"),
      has("OWNER_PASSWORD") ? (has("OWNER_PHONE") ? "Owner phone and password are set." : "OWNER_PHONE not set (default number is used).")
                            : "OWNER_PASSWORD is missing: the owner can't log in with the phone number.");
  add("Settings", "Owner name", has("OWNER_NAME") ? "ok" : "warn", has("OWNER_NAME") ? "Set." : "OWNER_NAME is not set, so the welcome text says \"Owner\".");
  add("Settings", "Time zone", has("TZ_OFFSET_HOURS") ? "ok" : "warn",
      "Script time zone " + Session.getScriptTimeZone() + ", slot offset UTC" + (getTzOffsetHours() >= 0 ? "+" : "") + getTzOffsetHours() +
      (has("TZ_OFFSET_HOURS") ? "." : " (default; add TZ_OFFSET_HOURS to change)."));
  add("Settings", "Buffer token (Facebook / Instagram / LinkedIn)", has("BUFFER_TOKEN_SOCIAL") ? "ok" : "warn",
      has("BUFFER_TOKEN_SOCIAL") ? "Set." : "BUFFER_TOKEN_SOCIAL is missing: those channels can't be shared to.");
  add("Settings", "Buffer token (YouTube / TikTok)", has("BUFFER_TOKEN_VIDEO") ? "ok" : "warn",
      has("BUFFER_TOKEN_VIDEO") ? "Set." : "BUFFER_TOKEN_VIDEO is missing: YouTube and TikTok can't be shared to.");
  const cloudOk = has("CLOUDINARY_CLOUD_NAME") && has("CLOUDINARY_API_KEY") && has("CLOUDINARY_API_SECRET");
  add("Settings", "Cloudinary keys", cloudOk ? "ok" : "warn", cloudOk ? "Set." : "Cloudinary keys are missing: old media can't be deleted.");

  // ── System state ──────────────────────────────────────────────────────────
  add("System", "Pause switch", isSystemPaused() ? "warn" : "ok",
      isSystemPaused() ? "The system is PAUSED. Normal users see the maintenance message." : "System is running.");
  const triggers = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
  add("System", "Media clean-up trigger", triggers.includes("autoDeleteOldPosts") ? "ok" : "warn",
      triggers.includes("autoDeleteOldPosts") ? "Runs daily." : "Not set up. Run setupAutoDeleteTrigger once, or old media will pile up.");
  let quota = null;
  try { quota = MailApp.getRemainingDailyQuota(); } catch (e) {}
  if (quota !== null) add("System", "Email (signup codes)", quota > 10 ? "ok" : "warn", quota + " emails left today.");

  // ── Sheets: tabs and columns ──────────────────────────────────────────────
  const wanted = {
    "Database":    DB_HEADERS,
    "Projects":    ["name", "status", "color"],
    "Users":       ["phone", "name", "role", "projects", "email", "salt", "hash", "createdat", "club_role"],
    "ActivityLog": ["timestamp", "phone", "name", "role", "action", "detail"]
  };
  Object.keys(wanted).forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh) { add("Sheets", name + " tab", "error", "The tab is missing."); return; }
    const head = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).toLowerCase()) : [];
    const missing = wanted[name].filter(h => !head.includes(h.toLowerCase()));
    add("Sheets", name + " tab", missing.length ? "error" : "ok",
        missing.length ? "Missing columns: " + missing.join(", ") : (sh.getLastRow() - 1) + " rows, all columns present.");
  });

  if (full) {
    // ── Sheets: write + read back test (hidden _diagnostics tab) ─────────────
    try {
      let ds = ss.getSheetByName("_diagnostics");
      if (!ds) { ds = ss.insertSheet("_diagnostics"); ds.appendRow(["time", "token"]); ds.hideSheet(); }
      const tok = Utilities.getUuid();
      ds.appendRow([new Date().toISOString(), tok]);
      const last = ds.getLastRow();
      const back = String(ds.getRange(last, 2).getValue());
      ds.deleteRow(last);
      add("Sheets", "Write and read-back test", back === tok ? "ok" : "error",
          back === tok ? "Wrote a test row, read it back and removed it." : "The text read back did not match what was written.");
    } catch (e) { add("Sheets", "Write and read-back test", "error", String(e).substring(0, 160)); }

    // ── Data health ──────────────────────────────────────────────────────────
    try {
      ensureColumns();
      const db = ensureDatabaseSheet();
      const head = db.getRange(1, 1, 1, db.getLastColumn()).getValues()[0];
      const col  = buildColMap(head);
      const rng  = db.getDataRange(), vals = rng.getValues(), disp = rng.getDisplayValues();
      let bad = 0, dup = 0, oldMedia = 0, noProject = 0;
      const seen = {};
      const cutoff = Utilities.formatDate(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), Session.getScriptTimeZone(), "yyyy-MM-dd");
      for (let i = 1; i < vals.length; i++) {
        const d = normDateServer(vals[i][col["date"]]), sl = normSlotServer(disp[i][col["timeslot"]]);
        if (!disp[i][col["title"]] && !d) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{1,2}:\d{2} (AM|PM)$/.test(sl)) bad++;
        if (!String(disp[i][col["title"]] || "").trim()) noProject++;
        if (String(vals[i][col["status"]]).toLowerCase() !== "rejected") {
          const k = d + "|" + sl; if (seen[k]) dup++; seen[k] = true;
        }
        if (d && d < cutoff && String(vals[i][col["media"]] || "")) oldMedia++;
      }
      add("Data", "Posts: date and time slot format", bad ? "warn" : "ok", bad ? bad + " post(s) have an unreadable date or slot." : "All posts readable.");
      add("Data", "Posts: double-booked slots", dup ? "warn" : "ok", dup ? dup + " slot(s) hold more than one post." : "No double bookings.");
      add("Data", "Posts: project name", noProject ? "warn" : "ok", noProject ? noProject + " older post(s) have no project name (shown as Untitled)." : "All posts have a project name.");
      add("Data", "Old media clean-up", oldMedia ? "warn" : "ok", oldMedia ? oldMedia + " post(s) older than 7 days still have media. The daily clean-up should remove it." : "No old media left behind.");

      const users = ensureUsersSheet().getDataRange().getValues();
      let noEmail = 0, noPw = 0;
      for (let i = 1; i < users.length; i++) { if (!users[i][0]) continue; if (!users[i][4]) noEmail++; if (!users[i][6]) noPw++; }
      add("Users", "Accounts", noPw ? "warn" : "ok", (users.length - 1) + " accounts" + (noPw ? "; " + noPw + " old account(s) have no password and can't log in (ask them to sign up again)." : "."));
      const clubRoles = getRoleLists().clubRoles;
      const entries = getAdminEntries_();
      const badRole = entries.filter(e => !clubRoles.includes(e.role) && e.role !== "Admin");
      add("Users", "Admin whitelist", badRole.length ? "warn" : "ok",
          entries.length + " admin entr" + (entries.length === 1 ? "y" : "ies") + (badRole.length ? "; " + badRole.length + " have a role that is no longer in the role list." : "."));
      const projects = ensureProjectsSheet().getDataRange().getValues().slice(1).filter(r => r[0]);
      add("Data", "Projects", projects.length ? "ok" : "warn", projects.length ? projects.length + " projects." : "No projects yet.");
    } catch (e) { add("Data", "Data checks", "error", String(e).substring(0, 160)); }

    // ── Buffer channels ──────────────────────────────────────────────────────
    ["social", "video"].forEach(orgType => {
      const label = orgType === "social" ? "Buffer: Facebook / Instagram / LinkedIn" : "Buffer: YouTube / TikTok";
      const r = fetchBufferChannels_(orgType);
      if (r.missing) add("Social media", label, "warn", "No token set.");
      else if (!r.ok) add("Social media", label, "error", r.error);
      else add("Social media", label, r.count ? "ok" : "warn", r.count ? r.count + " channel(s): " + r.services.join(", ") : "Connected, but no channels were found.");
    });

    // ── Cloudinary ───────────────────────────────────────────────────────────
    if (cloudOk) {
      try {
        const r = UrlFetchApp.fetch("https://api.cloudinary.com/v1_1/" + P.getProperty("CLOUDINARY_CLOUD_NAME") + "/ping", {
          headers: { Authorization: "Basic " + Utilities.base64Encode(P.getProperty("CLOUDINARY_API_KEY") + ":" + P.getProperty("CLOUDINARY_API_SECRET")) },
          muteHttpExceptions: true
        });
        add("Storage", "Cloudinary keys work", r.getResponseCode() === 200 ? "ok" : "error",
            r.getResponseCode() === 200 ? "Cloudinary accepted the keys." : "Cloudinary replied " + r.getResponseCode() + ". Check the three CLOUDINARY_ properties.");
      } catch (e) { add("Storage", "Cloudinary keys work", "error", String(e).substring(0, 160)); }
    }
  }

  return json({ success: true, full: !!full, results: res, serverOffset: getTzOffsetHours(), scriptTz: Session.getScriptTimeZone(), ms: Date.now() - started });
}

// Removes the tiny test file the diagnostics page uploads
function handleDiagDeleteAsset(data, session) {
  if (!session || session.role !== "owner") return json({ success: false, error: "Unauthorized." });
  const id = String(data.publicId || "");
  if (!/^[\w\-\/]+$/.test(id)) return json({ success: false, error: "Bad id." });
  return json(deleteCloudinaryAsset(id, "image"));
}