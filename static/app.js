"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const DEFAULT_GROUP = "default";
const MBPS = { 360: 0.8, 480: 1.2, 720: 2.3, 1080: 4.2 };
const STORE_KEY = "playlist-cutter:autosave";
const STATE_LABEL = { pending: "Waiting", downloading: "Downloading", cutting: "Cutting", done: "Done" };
const JOB_TITLE = { running: "Processing", done: "Finished", error: "Failed", cancelled: "Cancelled" };

let project = loadAutosave() ?? blankProject();
let ytApi = null;
let player = null;
let playerReady = false;
let pendingCue = null;
let previewId = null;
let ticker = null;
let pollTimer = null;
let saveTimer = null;
let sbInFlight = false;

function blankProject() {
  return {
    name: "",
    playlistUrl: "",
    playlistTitle: "",
    videos: [],
    groups: [{ id: DEFAULT_GROUP, name: "Default", type: "fixed", start: "", end: "" }],
    settings: { quality: 720, mode: "fast", dataSaver: false, chapters: true, keepFiles: false, output: "merged" },
  };
}

function normalize(raw) {
  const base = blankProject();
  const p = { ...base, ...raw, settings: { ...base.settings, ...(raw.settings || {}) } };
  p.groups = Array.isArray(p.groups) ? p.groups : [];
  if (!p.groups.some(g => g.id === DEFAULT_GROUP)) p.groups.unshift(base.groups[0]);
  p.videos = (Array.isArray(p.videos) ? p.videos : []).map(v => ({
    include: true,
    group: DEFAULT_GROUP,
    ...v,
    override: { start: "", end: "", ...(v.override || {}) },
    sb: v.sb === false ? undefined : v.sb,
  }));
  return p;
}

function loadAutosave() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? normalize(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(project));
    } catch {
      toast("Couldn’t autosave. Save the project from Projects.");
    }
  }, 300);
}

async function api(path, options = {}) {
  const init = { method: options.method || "GET", headers: { "Content-Type": "application/json" } };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pad = n => String(n).padStart(2, "0");
const ytLink = (id, sec) => `https://www.youtube.com/watch?v=${id}&t=${Math.floor(sec)}s`;

function fmtDur(sec) {
  if (!Number.isFinite(sec)) return "–";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function fmtStamp(sec) {
  const t = Math.round(sec * 10) / 10;
  const whole = Math.floor(t);
  const tenth = Math.round((t - whole) * 10);
  return fmtDur(whole) + (tenth ? `.${tenth}` : "");
}

function parseTime(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { kind: "none" };
  const sign = s[0] === "+" || s[0] === "-" ? s[0] : "";
  const parts = s.slice(sign.length).split(":");
  if (parts.length > 3 || parts.some(p => !/^\d+(\.\d+)?$/.test(p))) return { kind: "invalid" };
  const nums = parts.map(Number);
  if (nums.slice(1).some(n => n >= 60)) return { kind: "invalid" };
  const sec = nums.reduce((acc, n) => acc * 60 + n, 0);
  return { kind: sign === "-" ? "fromEnd" : sign === "+" ? "afterStart" : "abs", sec };
}

function resolvePoint(raw, dur, start, isStart) {
  const t = parseTime(raw);
  if (t.kind === "none") return isStart ? 0 : dur;
  if (t.kind === "invalid") return `Can’t read “${raw}”`;
  if (t.kind === "abs") return t.sec;
  if (t.kind === "fromEnd") return dur - t.sec;
  return isStart ? "“+” only works for the end" : start + t.sec;
}

const groupById = id => project.groups.find(g => g.id === id);
const groupOf = v => groupById(v.group) ?? groupById(DEFAULT_GROUP);
const videoById = id => project.videos.find(v => v.id === id);
const cardFor = id => $(`.video[data-id="${CSS.escape(id)}"]`);

function cutFor(v) {
  const dur = v.duration;
  if (!dur) return { error: "Length unknown. The video may be private or deleted." };
  const g = groupOf(v);
  const ov = v.override;
  const sb = g.type === "sponsorblock" && v.sb ? v.sb : null;

  const start = ov.start ? resolvePoint(ov.start, dur, 0, true) : sb?.intro ? sb.intro[1] : resolvePoint(g.start, dur, 0, true);
  if (typeof start === "string") return { error: start };

  let end = ov.end ? resolvePoint(ov.end, dur, start, false) : sb?.outro ? sb.outro[0] : resolvePoint(g.end, dur, start, false);
  if (typeof end === "string") return { error: end };
  if (end > dur && end - dur < 1) end = dur;

  if (start < 0) return { error: "Start is before 0:00" };
  if (start >= dur) return { error: `Start is past the video length (${fmtDur(dur)})` };
  if (end > dur) return { error: `End is past the video length (${fmtDur(dur)})` };
  if (end - start < 1) return { error: "End must come after start" };
  return { start, end, length: end - start, sbIntro: !ov.start && !!sb?.intro, sbOutro: !ov.end && !!sb?.outro };
}

function parseRange(text) {
  const out = new Set();
  for (const part of text.split(",").map(s => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i);
  }
  return out.size ? out : null;
}

function toast(message) {
  const el = $("#toast");
  const host = $("dialog[open]") ?? document.body;
  if (el.parentElement !== host) host.append(el);
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2600);
}

function renderAll() {
  const hasVideos = project.videos.length > 0;
  $("#editor").hidden = !hasVideos;
  $("#playlistTitle").textContent = project.playlistTitle;
  renderGroups();
  renderVideos();
  renderSettings();
  renderTotals();
}

function renderGroups() {
  $("#groups").innerHTML = project.groups.map(g => {
    const count = project.videos.filter(v => groupOf(v).id === g.id).length;
    const isDefault = g.id === DEFAULT_GROUP;
    return `<article class="group${isDefault ? " is-default" : ""}" data-group="${esc(g.id)}">
      <div class="group-head">
        ${isDefault ? `<h4>Default rule</h4>` : `<input class="group-name" data-field="name" value="${esc(g.name)}" aria-label="Group name">`}
        <span class="count">${count} ${count === 1 ? "video" : "videos"}</span>
        ${isDefault ? "" : `<button class="icon-btn" data-action="delete-group" aria-label="Delete group">✕</button>`}
      </div>
      <div class="pair">
        <label>Start<input data-field="start" value="${esc(g.start)}" placeholder="0:00" autocomplete="off"></label>
        <label>End<input data-field="end" value="${esc(g.end)}" placeholder="end" autocomplete="off"></label>
      </div>
      <label class="field">Find intro and outro with
        <select data-field="type">
          <option value="fixed"${g.type === "fixed" ? " selected" : ""}>These times</option>
          <option value="sponsorblock"${g.type === "sponsorblock" ? " selected" : ""}>SponsorBlock, these times as fallback</option>
        </select>
      </label>
      ${isDefault
        ? `<p class="muted small">Applies to every video that isn’t in a group.</p>`
        : `<div class="assign"><input data-field="range" placeholder="Videos, e.g. 1-10, 15" autocomplete="off"><button class="btn small" data-action="assign">Assign</button></div>`}
      <p class="err small" data-error></p>
    </article>`;
  }).join("");
  project.groups.forEach(g => updateGroupError(g));
}

function updateGroupError(g) {
  const card = $(`.group[data-group="${CSS.escape(g.id)}"]`);
  if (!card) return;
  const problems = [];
  if (parseTime(g.start).kind === "invalid") problems.push(`Can’t read start “${g.start}”`);
  if (parseTime(g.start).kind === "afterStart") problems.push("“+” only works for the end");
  if (parseTime(g.end).kind === "invalid") problems.push(`Can’t read end “${g.end}”`);
  $("[data-error]", card).textContent = problems.join(". ");
}

function renderVideos() {
  const total = project.videos.length;
  $("#videoCount").textContent = `${total} ${total === 1 ? "video" : "videos"}`;
  $("#videos").innerHTML = project.videos.map((v, i) => videoCard(v, i, total)).join("");
  project.videos.forEach(v => updateMeta(v));
}

function videoCard(v, i, total) {
  const g = groupOf(v);
  const options = project.groups
    .map(x => `<option value="${esc(x.id)}"${x.id === g.id ? " selected" : ""}>${esc(x.id === DEFAULT_GROUP ? "Default rule" : x.name)}</option>`)
    .join("");
  return `<article class="video${v.include ? "" : " excluded"}" data-id="${esc(v.id)}">
    <div class="video-top">
      <button class="thumb" data-action="preview" aria-label="Preview ${esc(v.title)}">
        <img src="${esc(v.thumb)}" alt="" loading="lazy"><span class="badge">${fmtDur(v.duration)}</span>
      </button>
      <div class="video-info">
        <p class="video-title"><span class="idx">${v.index}</span>${esc(v.title)}</p>
        <select class="group-select" data-field="group" aria-label="Rule for this video">${options}</select>
      </div>
      <label class="switch"><input type="checkbox" data-field="include"${v.include ? " checked" : ""} aria-label="Include in the merged video"><span></span></label>
    </div>
    <div class="strip" aria-hidden="true"><span class="trim" data-strip="a"></span><span class="keep" data-strip="b"></span><span class="trim" data-strip="c"></span></div>
    <p class="meta" data-meta></p>
    <div class="pair">
      <label>Start<input data-field="ov-start" value="${esc(v.override.start)}" autocomplete="off"></label>
      <label>End<input data-field="ov-end" value="${esc(v.override.end)}" autocomplete="off"></label>
    </div>
    <div class="video-actions">
      <button class="btn small" data-action="preview">Preview</button>
      <a class="btn small ghost" data-link="start" target="_blank" rel="noopener">Check start</a>
      <a class="btn small ghost" data-link="end" target="_blank" rel="noopener">Check end</a>
      <span class="spacer"></span>
      <button class="icon-btn" data-action="up" aria-label="Move up"${i === 0 ? " disabled" : ""}>↑</button>
      <button class="icon-btn" data-action="down" aria-label="Move down"${i === total - 1 ? " disabled" : ""}>↓</button>
    </div>
  </article>`;
}

function inheritedHint(v, field) {
  const g = groupOf(v);
  const sb = g.type === "sponsorblock" && v.sb ? v.sb : null;
  if (field === "start" && sb?.intro) return `SponsorBlock ${fmtStamp(sb.intro[1])}`;
  if (field === "end" && sb?.outro) return `SponsorBlock ${fmtStamp(sb.outro[0])}`;
  const raw = field === "start" ? g.start : g.end;
  return raw ? `Rule ${raw}` : field === "start" ? "Rule 0:00" : "Rule end";
}

function sponsorNote(v, g, cut) {
  if (g.type !== "sponsorblock") return "";
  if (v.sb === undefined) return `<span class="note">Checking SponsorBlock…</span>`;
  if (v.sb === false) return `<span class="note">SponsorBlock unavailable, using your times</span>`;
  if (!cut.sbIntro && !cut.sbOutro) return `<span class="note">Not marked on SponsorBlock, using your times</span>`;
  const found = [cut.sbIntro && "intro", cut.sbOutro && "outro"].filter(Boolean).join(" and ");
  return `<span class="note ok">SponsorBlock found the ${found}</span>`;
}

function updateMeta(v) {
  const card = cardFor(v.id);
  if (!card) return;
  const cut = cutFor(v);
  const g = groupOf(v);
  $('[data-field="ov-start"]', card).placeholder = inheritedHint(v, "start");
  $('[data-field="ov-end"]', card).placeholder = inheritedHint(v, "end");
  card.classList.toggle("invalid", Boolean(cut.error));
  const strip = { a: 0, b: 0, c: 0 };
  if (!cut.error) {
    strip.a = (cut.start / v.duration) * 100;
    strip.b = (cut.length / v.duration) * 100;
    strip.c = Math.max(0, 100 - strip.a - strip.b);
  }
  for (const key of ["a", "b", "c"]) $(`[data-strip="${key}"]`, card).style.width = `${strip[key]}%`;
  for (const link of $$("[data-link]", card)) link.hidden = Boolean(cut.error);
  if (cut.error) {
    $("[data-meta]", card).innerHTML = `<span class="err">${esc(cut.error)}</span>`;
    return;
  }
  $("[data-meta]", card).innerHTML =
    `<span class="cut">${fmtStamp(cut.start)} to ${fmtStamp(cut.end)}</span>` +
    `<span class="kept">Keeps ${fmtDur(cut.length)}</span>` +
    sponsorNote(v, g, cut);
  $('[data-link="start"]', card).href = ytLink(v.id, cut.start);
  $('[data-link="end"]', card).href = ytLink(v.id, Math.max(cut.end - 10, 0));
}

function refreshMeta() {
  project.videos.forEach(v => updateMeta(v));
}

function renderSettings() {
  const s = project.settings;
  $("#outputName").value = s.output;
  $("#quality").value = String(s.quality);
  $$('input[name="mode"]').forEach(r => { r.checked = r.value === s.mode; });
  $("#dataSaver").disabled = s.mode !== "fast";
  $("#dataSaver").checked = s.dataSaver && s.mode === "fast";
  $("#chapters").checked = s.chapters;
  $("#keepFiles").checked = s.keepFiles;
}

function renderTotals() {
  const included = project.videos.filter(v => v.include);
  const cuts = included.map(cutFor);
  const errors = cuts.filter(c => c.error).length;
  const original = included.reduce((sum, v) => sum + (v.duration || 0), 0);
  const kept = cuts.reduce((sum, c) => sum + (c.length || 0), 0);
  const mb = (kept * MBPS[project.settings.quality]) / 8;
  const size = mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`;
  $("#totals").hidden = project.videos.length === 0;
  $("#totTime").textContent = `${fmtDur(kept)} of ${fmtDur(original)}`;
  $("#totMeta").textContent = `${included.length} of ${project.videos.length} videos, about ${size}`;
  $("#totErrors").hidden = errors === 0;
  $("#totErrors").textContent = `${errors} ${errors === 1 ? "video needs" : "videos need"} fixing`;
  $("#processBtn").disabled = included.length === 0 || errors > 0;
}

async function fetchSponsorBlock() {
  const sbGroups = new Set(project.groups.filter(g => g.type === "sponsorblock").map(g => g.id));
  const ids = project.videos.filter(v => sbGroups.has(groupOf(v).id) && v.sb === undefined).map(v => v.id);
  if (!ids.length || sbInFlight) return;
  sbInFlight = true;
  try {
    const result = await api("/api/sponsorblock", { method: "POST", body: { ids } });
    for (const v of project.videos) if (ids.includes(v.id)) v.sb = result[v.id] ?? false;
  } catch (e) {
    for (const v of project.videos) if (ids.includes(v.id)) v.sb = false;
    toast(e.message);
  } finally {
    sbInFlight = false;
    refreshMeta();
    renderTotals();
    persist();
  }
}

async function importPlaylist() {
  const url = $("#urlInput").value.trim();
  if (!url) return toast("Paste a playlist URL first");
  const btn = $("#importBtn");
  btn.disabled = true;
  btn.textContent = "Importing…";
  $("#importMsg").textContent = "Reading the playlist. Long playlists take a few seconds.";
  try {
    const data = await api("/api/playlist", { method: "POST", body: { url } });
    const sameList = project.playlistUrl === url;
    const previous = new Map(sameList ? project.videos.map(v => [v.id, v]) : []);
    project.playlistUrl = url;
    project.playlistTitle = data.title;
    if (!sameList) project.settings.output = data.title.replace(/[^\w\- .()]+/g, "").trim().slice(0, 80) || "merged";
    project.videos = data.videos.map(v => {
      const old = previous.get(v.id);
      return {
        ...v,
        include: old?.include ?? true,
        group: old && groupById(old.group) ? old.group : DEFAULT_GROUP,
        override: old?.override ?? { start: "", end: "" },
        sb: old?.sb === false ? undefined : old?.sb,
      };
    });
    const added = data.videos.filter(v => !previous.has(v.id)).length;
    $("#importMsg").textContent = sameList
      ? `Playlist refreshed. ${added} new ${added === 1 ? "video" : "videos"} added to the default rule.`
      : `${data.videos.length} videos imported.`;
    renderAll();
    persist();
    fetchSponsorBlock();
  } catch (e) {
    $("#importMsg").textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Import";
  }
}

function addGroup() {
  const n = project.groups.length;
  const id = `g${Date.now().toString(36)}`;
  project.groups.push({ id, name: `Group ${n}`, type: "fixed", start: "", end: "" });
  renderGroups();
  renderVideos();
  persist();
  $(`.group[data-group="${id}"] .group-name`)?.focus();
}

function onGroupInput(e) {
  const card = e.target.closest(".group");
  const field = e.target.dataset.field;
  if (!card || !field || field === "range") return;
  const g = groupById(card.dataset.group);
  g[field] = e.target.value;
  if (field === "name") {
    $$(`.group-select option[value="${CSS.escape(g.id)}"]`).forEach(o => { o.textContent = g.name; });
  }
  updateGroupError(g);
  refreshMeta();
  renderTotals();
  persist();
  if (field === "type") fetchSponsorBlock();
}

function onGroupClick(e) {
  const action = e.target.closest("[data-action]")?.dataset.action;
  const card = e.target.closest(".group");
  if (!action || !card) return;
  const g = groupById(card.dataset.group);
  if (action === "delete-group") {
    project.videos.forEach(v => { if (v.group === g.id) v.group = DEFAULT_GROUP; });
    project.groups = project.groups.filter(x => x.id !== g.id);
  }
  if (action === "assign") {
    const input = $('[data-field="range"]', card);
    const range = parseRange(input.value);
    if (!range) return toast("Write videos like 1-10, 15");
    const hits = project.videos.filter(v => range.has(v.index));
    if (!hits.length) return toast("No videos have those numbers");
    hits.forEach(v => { v.group = g.id; });
    toast(`${hits.length} ${hits.length === 1 ? "video" : "videos"} moved to ${g.name}`);
  }
  renderGroups();
  renderVideos();
  renderTotals();
  persist();
  fetchSponsorBlock();
}

function onVideoInput(e) {
  const card = e.target.closest(".video");
  const field = e.target.dataset.field;
  if (!card || !field) return;
  const v = videoById(card.dataset.id);
  if (field === "ov-start" || field === "ov-end") v.override[field.slice(3)] = e.target.value.trim();
  if (field === "include") {
    v.include = e.target.checked;
    card.classList.toggle("excluded", !v.include);
  }
  if (field === "group") {
    v.group = e.target.value;
    renderGroups();
    fetchSponsorBlock();
  }
  updateMeta(v);
  renderTotals();
  persist();
}

function onVideoClick(e) {
  const action = e.target.closest("[data-action]")?.dataset.action;
  const card = e.target.closest(".video");
  if (!action || !card) return;
  const i = project.videos.findIndex(v => v.id === card.dataset.id);
  if (action === "preview") return openPreview(project.videos[i]);
  const j = action === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= project.videos.length) return;
  [project.videos[i], project.videos[j]] = [project.videos[j], project.videos[i]];
  renderVideos();
  persist();
  cardFor(project.videos[j].id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function onSettingsInput(e) {
  const t = e.target;
  const s = project.settings;
  if (t.id === "outputName") s.output = t.value;
  else if (t.id === "quality") s.quality = Number(t.value);
  else if (t.name === "mode") s.mode = t.value;
  else if (t.id === "dataSaver") s.dataSaver = t.checked;
  else if (t.id === "chapters") s.chapters = t.checked;
  else if (t.id === "keepFiles") s.keepFiles = t.checked;
  else return;
  if (t.name === "mode") renderSettings();
  renderTotals();
  persist();
}

function loadYouTubeApi() {
  ytApi ??= new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = resolve;
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => {
      ytApi = null;
      reject(new Error("Couldn’t load the YouTube player. Check your connection."));
    };
    document.head.append(script);
  });
  return ytApi;
}

function updatePreviewCut() {
  const v = videoById(previewId);
  if (!v) return;
  const cut = cutFor(v);
  $("#pvCut").textContent = cut.error ? "invalid" : `${fmtStamp(cut.start)} to ${fmtStamp(cut.end)}`;
}

async function openPreview(v) {
  previewId = v.id;
  const cut = cutFor(v);
  const startAt = cut.error ? 0 : cut.start;
  $("#pvTitle").textContent = v.title;
  $("#pvOpen").href = ytLink(v.id, startAt);
  $("#pvError").hidden = true;
  $("#pvNow").textContent = fmtStamp(startAt);
  updatePreviewCut();
  $("#previewDlg").showModal();
  try {
    await loadYouTubeApi();
  } catch (e) {
    $("#pvError").textContent = e.message;
    $("#pvError").hidden = false;
    return;
  }
  const cue = { videoId: v.id, startSeconds: startAt };
  if (playerReady) player.cueVideoById(cue);
  else if (player) pendingCue = cue;
  else {
    player = new YT.Player("player", {
      videoId: v.id,
      playerVars: { playsinline: 1, rel: 0, start: Math.floor(startAt), origin: location.origin },
      events: {
        onReady: () => {
          playerReady = true;
          if (pendingCue) player.cueVideoById(pendingCue);
          pendingCue = null;
        },
        onError: () => { $("#pvError").hidden = false; },
      },
    });
  }
  clearInterval(ticker);
  ticker = setInterval(() => {
    if (playerReady) $("#pvNow").textContent = fmtStamp(player.getCurrentTime() || 0);
  }, 250);
}

function setOverride(v, field, value) {
  v.override[field] = value;
  const input = $(`[data-field="ov-${field}"]`, cardFor(v.id));
  if (input) input.value = value;
  updateMeta(v);
  updatePreviewCut();
  renderTotals();
  persist();
}

function onPreviewClick(e) {
  const action = e.target.closest("[data-pv]")?.dataset.pv;
  if (!action) return;
  if (!playerReady) return toast("The player is still loading");
  const v = videoById(previewId);
  const t = player.getCurrentTime() || 0;
  const cut = cutFor(v);
  if (action === "set-start") {
    setOverride(v, "start", fmtStamp(t));
    toast(`Start set to ${fmtStamp(t)}`);
  } else if (action === "set-end") {
    setOverride(v, "end", fmtStamp(t));
    toast(`End set to ${fmtStamp(t)}`);
  } else if (action === "go-start" && !cut.error) {
    player.seekTo(cut.start, true);
  } else if (action === "go-end" && !cut.error) {
    player.seekTo(Math.max(cut.end - 10, 0), true);
  } else if (action === "back") {
    player.seekTo(Math.max(t - 5, 0), true);
  } else if (action === "fwd") {
    player.seekTo(t + 5, true);
  }
}

function closePreview() {
  clearInterval(ticker);
  if (playerReady) player.pauseVideo();
  previewId = null;
}

async function openProjects() {
  $("#saveName").value = project.name || project.playlistTitle || "";
  $("#projectsDlg").showModal();
  await refreshProjectList();
}

async function refreshProjectList() {
  const list = $("#projectList");
  try {
    const names = await api("/api/projects");
    list.innerHTML = names.length
      ? names.map(n => `<li><span>${esc(n)}</span><button class="btn small" data-load="${esc(n)}">Open</button><button class="icon-btn" data-del="${esc(n)}" aria-label="Delete ${esc(n)}">✕</button></li>`).join("")
      : `<li class="muted">No saved projects yet. Name this one above and save it.</li>`;
  } catch (e) {
    list.innerHTML = `<li class="err">${esc(e.message)}</li>`;
  }
}

async function saveProject() {
  const name = $("#saveName").value.trim();
  if (!name) return toast("Give the project a name first");
  try {
    project.name = name;
    await api(`/api/projects/${encodeURIComponent(name)}`, { method: "PUT", body: project });
    persist();
    toast("Project saved");
    refreshProjectList();
  } catch (e) {
    toast(e.message);
  }
}

async function onProjectListClick(e) {
  const load = e.target.closest("[data-load]")?.dataset.load;
  const del = e.target.closest("[data-del]")?.dataset.del;
  try {
    if (load) {
      project = normalize(await api(`/api/projects/${encodeURIComponent(load)}`));
      $("#urlInput").value = project.playlistUrl;
      $("#importMsg").textContent = "";
      $("#projectsDlg").close();
      renderAll();
      persist();
      fetchSponsorBlock();
      toast(`Opened ${load}`);
    }
    if (del && confirm(`Delete the project “${del}”?`)) {
      await api(`/api/projects/${encodeURIComponent(del)}`, { method: "DELETE" });
      refreshProjectList();
    }
  } catch (err) {
    toast(err.message);
  }
}

function newProject() {
  if (project.videos.length && !confirm("Start over? Unsaved changes to this project will be lost.")) return;
  project = blankProject();
  $("#urlInput").value = "";
  $("#importMsg").textContent = "";
  $("#projectsDlg").close();
  renderAll();
  persist();
}

async function startProcessing() {
  try {
    const current = await api("/api/job");
    if (current.status === "running") return showJob(current);
  } catch {
    return toast("Can’t reach the app. Is Termux still running?");
  }
  const items = project.videos.filter(v => v.include).map(v => ({ v, cut: cutFor(v) }));
  if (items.some(x => x.cut.error)) return toast("Fix the highlighted videos first");
  const s = project.settings;
  try {
    const job = await api("/api/process", {
      method: "POST",
      body: {
        videos: items.map(({ v, cut }) => ({ id: v.id, title: v.title, start: cut.start, end: cut.end })),
        quality: s.quality,
        mode: s.mode,
        dataSaver: s.dataSaver,
        chapters: s.chapters,
        keepFiles: s.keepFiles,
        output: s.output,
      },
    });
    showJob(job);
  } catch (e) {
    toast(e.message);
  }
}

function showJob(job) {
  const dlg = $("#jobDlg");
  if (!dlg.open) dlg.showModal();
  renderJob(job);
  clearTimeout(pollTimer);
  if (job.status === "running") pollTimer = setTimeout(pollJob, 1000);
}

async function pollJob() {
  if (!$("#jobDlg").open) return;
  try {
    showJob(await api("/api/job"));
  } catch {
    pollTimer = setTimeout(pollJob, 2000);
  }
}

function renderJob(job) {
  const running = job.status === "running";
  $("#jobTitle").textContent = JOB_TITLE[job.status] ?? "Processing";
  $("#jobPhase").textContent = job.phase;
  $("#jobPct").textContent = `${Math.round(job.overall)}%`;
  $("#jobBar").style.width = `${job.overall}%`;
  const warnings = job.warnings || [];
  $("#jobWarning").hidden = warnings.length === 0;
  $("#jobWarning").textContent = warnings.join("\n");
  $("#jobError").hidden = !job.error;
  $("#jobError").textContent = job.error ? `${job.error}. Process again to resume: finished videos are kept.` : "";
  $("#jobDone").hidden = job.status !== "done";
  $("#jobDone").textContent = job.outputPath ? `Saved to ${job.outputPath} in ${fmtDur(job.elapsed)}` : "";
  $("#jobItems").innerHTML = job.items.map(i => `<li class="${esc(i.state)}">
      <div class="job-row"><span class="job-name">${esc(i.title)}</span><span class="state">${STATE_LABEL[i.state] ?? i.state}</span></div>
      <div class="bar"><span style="width:${Number(i.progress) || 0}%"></span></div>
    </li>`).join("");
  $("#jobLog").textContent = job.log.join("\n") || "Nothing logged yet.";
  $("#cancelBtn").hidden = !running;
  $("#openBtn").hidden = job.status !== "done";
  $("#playLink").hidden = job.status !== "done";
  if (job.output) $("#playLink").href = `/output/${encodeURIComponent(job.output)}`;
}

async function cancelJob() {
  if (!confirm("Cancel processing? Videos already finished are kept for next time.")) return;
  try {
    await api("/api/job/cancel", { method: "POST" });
  } catch (e) {
    toast(e.message);
  }
}

async function openOutput() {
  try {
    await api("/api/open", { method: "POST" });
  } catch (e) {
    toast(e.message);
  }
}

function bind() {
  $("#importBtn").addEventListener("click", importPlaylist);
  $("#urlInput").addEventListener("keydown", e => { if (e.key === "Enter") importPlaylist(); });
  $("#addGroupBtn").addEventListener("click", addGroup);
  $("#groups").addEventListener("input", onGroupInput);
  $("#groups").addEventListener("click", onGroupClick);
  $("#videos").addEventListener("input", onVideoInput);
  $("#videos").addEventListener("click", onVideoClick);
  $("#settings").addEventListener("input", onSettingsInput);
  $("#processBtn").addEventListener("click", startProcessing);
  $("#projectsBtn").addEventListener("click", openProjects);
  $("#saveBtn").addEventListener("click", saveProject);
  $("#projectList").addEventListener("click", onProjectListClick);
  $("#newBtn").addEventListener("click", newProject);
  $("#previewDlg").addEventListener("click", onPreviewClick);
  $("#previewDlg").addEventListener("close", closePreview);
  $("#cancelBtn").addEventListener("click", cancelJob);
  $("#openBtn").addEventListener("click", openOutput);
  $$("[data-close]").forEach(btn => btn.addEventListener("click", () => btn.closest("dialog").close()));
}

bind();
$("#urlInput").value = project.playlistUrl;
renderAll();
fetchSponsorBlock();
api("/api/job").then(job => { if (job.status === "running") showJob(job); }).catch(() => {});
