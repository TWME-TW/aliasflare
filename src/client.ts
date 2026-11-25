/** Browser script for passkey sign-in and registration, served from /assets/passkey.js. */
export const PASSKEY_SCRIPT = `
(() => {
  const b64ToBuf = (value) => {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  };
  const bufToB64 = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  };
  const post = async (url, body) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body || {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Request failed (" + response.status + ")");
    return data;
  };
  const show = (form, message) => {
    const box = form.querySelector("[data-error]");
    if (box) { box.textContent = message; box.hidden = !message; }
  };

  async function register(form, base) {
    const fields = Object.fromEntries(new FormData(form));
    const { options } = await post(base + "/options", fields);
    const publicKey = {
      ...options,
      challenge: b64ToBuf(options.challenge),
      user: { ...options.user, id: b64ToBuf(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: b64ToBuf(c.id) })),
    };
    const credential = await navigator.credentials.create({ publicKey });
    if (!credential) throw Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
    const r = credential.response;
    const response = {
      id: credential.id,
      rawId: bufToB64(credential.rawId),
      type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(),
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
      response: {
        clientDataJSON: bufToB64(r.clientDataJSON),
        attestationObject: bufToB64(r.attestationObject),
        transports: r.getTransports ? r.getTransports() : undefined,
      },
    };
    await post(base + "/verify", { response, name: fields.name || "" });
  }

  async function login() {
    const { options } = await post("/login/options");
    const publicKey = {
      ...options,
      challenge: b64ToBuf(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: b64ToBuf(c.id) })),
    };
    const credential = await navigator.credentials.get({ publicKey });
    if (!credential) throw Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
    const r = credential.response;
    await post("/login/verify", {
      response: {
        id: credential.id,
        rawId: bufToB64(credential.rawId),
        type: credential.type,
        clientExtensionResults: credential.getClientExtensionResults(),
        authenticatorAttachment: credential.authenticatorAttachment || undefined,
        response: {
          clientDataJSON: bufToB64(r.clientDataJSON),
          authenticatorData: bufToB64(r.authenticatorData),
          signature: bufToB64(r.signature),
          userHandle: r.userHandle ? bufToB64(r.userHandle) : undefined,
        },
      },
    });
  }

  for (const form of document.querySelectorAll("form[data-passkey]")) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      show(form, "");
      const messages = form.querySelector("[data-msg-unsupported]")?.dataset || {};
      if (!window.PublicKeyCredential) return show(form, messages.msgUnsupported || "This browser does not support passkeys.");
      const button = form.querySelector("button");
      if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); }
      try {
        const flow = form.dataset.passkey;
        if (flow === "login") await login();
        else await register(form, flow === "setup" ? "/setup" : "/passkeys");
        location.href = form.dataset.next || "/";
      } catch (error) {
        const cancelled = error && (error.name === "NotAllowedError" || error.name === "AbortError");
        show(form, cancelled ? (messages.msgCancelled || "The passkey prompt was cancelled or timed out.") : ((error && error.message) || String(error)));
      } finally {
        if (button) { button.disabled = false; button.removeAttribute("aria-busy"); }
      }
    });
  }
})();
`;

/** Small progressive enhancements for every page: the language menu applies on change. */
export const APP_SCRIPT = `(() => {
  "use strict";
  for (const select of document.querySelectorAll("select[data-autosubmit]")) {
    select.addEventListener("change", () => select.form && select.form.requestSubmit());
  }

  // The sending provider's own fields and plan/provider notices stay in sync as options change.
  const provider = document.getElementById("outboundProvider");
  const workersPlan = document.getElementById("workersPlan");
  if (provider) {
    const providerKey = document.querySelector("[data-provider-key]");
    const freeNotice = document.querySelector("[data-free-notice]");
    const brevoNotice = document.querySelector("[data-brevo-notice]");
    const syncConnection = () => {
      const value = provider.value;
      for (const group of document.querySelectorAll(".provider-fields")) {
        const active = group.dataset.provider === value;
        group.hidden = !active;
        const fixed = group.dataset.fixed === "1";
        for (const el of group.querySelectorAll("input, select, textarea")) {
          el.disabled = fixed || !active;
        }
      }
      if (providerKey) providerKey.hidden = value === "cloudflare";
      if (freeNotice && workersPlan) freeNotice.hidden = !(workersPlan.value === "free" && value === "cloudflare");
      if (brevoNotice) brevoNotice.hidden = value !== "brevo";
    };
    provider.addEventListener("change", syncConnection);
    if (workersPlan) workersPlan.addEventListener("change", syncConnection);
    syncConnection();
  }

  // Forward method direct-mode notice updates immediately on Settings.
  const forwardMethod = document.getElementById("forwardMethod");
  const directNote = document.querySelector("[data-direct-note]");
  if (forwardMethod && directNote) {
    forwardMethod.addEventListener("change", () => { directNote.hidden = forwardMethod.value !== "direct"; });
  }

  // Rule editor: only show the action value input for actions that take one, and only attach
  // forwarding-address suggestions for "forwardTo".
  const NO_VALUE_ACTIONS = new Set(["", "block", "removeAttachments", "banner"]);
  for (const select of document.querySelectorAll("select[data-act-type]")) {
    const row = select.closest(".rule-row");
    const input = row && row.querySelector("[data-act-value]");
    if (!input) continue;
    const syncAction = () => {
      const type = select.value;
      const none = NO_VALUE_ACTIONS.has(type);
      input.hidden = none;
      input.disabled = none;
      if (type === "forwardTo") input.setAttribute("list", "rule-destinations");
      else input.removeAttribute("list");
    };
    select.addEventListener("change", syncAction);
    syncAction();
  }

  // Import and long-running setup forms carry shared domains (when present) and prevent double clicks.
  const domainSource = document.querySelector("[data-domains-source]");
  const busyForms = [...document.querySelectorAll("form[data-import], form[data-busy]")];
  for (const form of busyForms) {
    form.addEventListener("submit", () => {
      const hidden = form.querySelector("[data-domains]");
      if (hidden && domainSource) hidden.value = domainSource.value;
      const button = form.querySelector("button.primary, button[type=submit], button");
      if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); }
    });
  }
  if (busyForms.length) {
    window.addEventListener("pageshow", () => {
      for (const form of busyForms) {
        const button = form.querySelector("button.primary, button[type=submit], button");
        if (button && !button.hasAttribute("data-stay-disabled")) {
          button.disabled = false;
          button.removeAttribute("aria-busy");
        }
      }
    });
  }

  // Theme switcher: applies immediately in the DOM and persists to the af_theme cookie.
  const THEME_ORDER = ["system", "light", "dark"];
  const THEME_ICONS = {
    system: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>',
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2m-7.07-15.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    dark: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  };
  const applyTheme = (mode) => {
    const theme = THEME_ORDER.includes(mode) ? mode : "system";
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = theme;
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.remove();
    if (theme === "system") {
      for (const [color, media] of [["#f6f8fc", "(prefers-color-scheme: light)"], ["#202124", "(prefers-color-scheme: dark)"]]) {
        const meta = document.createElement("meta");
        meta.name = "theme-color";
        meta.content = color;
        meta.media = media;
        document.head.appendChild(meta);
      }
    } else {
      const meta = document.createElement("meta");
      meta.name = "theme-color";
      meta.content = theme === "dark" ? "#202124" : "#f6f8fc";
      document.head.appendChild(meta);
    }
    const select = document.getElementById("uiTheme");
    if (select && select.value !== theme) {
      select.value = theme;
      const settingsForm = select.closest("form[data-autosave]");
      if (settingsForm && settingsForm._syncLastSent) settingsForm._syncLastSent("uiTheme", theme);
    }
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    for (const form of document.querySelectorAll("form[data-theme-toggle]")) {
      const input = form.querySelector('input[name="theme"]');
      if (input) input.value = next;
      const button = form.querySelector("button");
      if (!button) continue;
      const label = button.dataset["label" + theme[0].toUpperCase() + theme.slice(1)] || theme;
      const prefix = button.dataset.labelPrefix || "";
      const full = prefix ? prefix + ": " + label : label;
      button.title = full;
      button.setAttribute("aria-label", full);
      const svg = button.querySelector("svg");
      if (svg && THEME_ICONS[theme]) svg.innerHTML = THEME_ICONS[theme];
      const text = button.querySelector(".theme-text");
      if (text) text.textContent = label;
    }
  };
  for (const form of document.querySelectorAll("form[data-theme-toggle]")) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = new URLSearchParams(new FormData(form));
      const next = body.get("theme") || "system";
      applyTheme(next);
      try {
        await fetch(form.action, {
          method: "POST",
          body,
          headers: { "X-Theme": "1", Accept: "application/json" },
          credentials: "same-origin",
        });
      } catch {
        // The visual change stays applied; the next interaction will persist it.
      }
    });
  }

  // Alias list: select all, the selected count, and batch actions.
  const bulk = document.querySelector("form[data-bulk]");
  if (bulk) {
    const picks = () => [...document.querySelectorAll("input[data-pick]")];
    const all = document.querySelector("[data-select-all]");
    const counter = bulk.querySelector("[data-selected-count]");
    const action = bulk.querySelector("select[name=action]");
    const value = bulk.querySelector("[data-bulk-value]");
    const refresh = () => {
      const list = picks();
      const checked = list.filter((box) => box.checked).length;
      if (counter) counter.textContent = counter.dataset.template.replace("{count}", String(checked));
      bulk.toggleAttribute("data-empty", checked === 0);
      if (all) {
        all.checked = checked > 0 && checked === list.length;
        all.indeterminate = checked > 0 && checked < list.length;
      }
    };
    const labelMenu = bulk.querySelector("[data-bulk-labels]");
    const labelFilter = labelMenu && labelMenu.querySelector("[data-label-filter]");
    const showValue = (fromUser) => {
      const option = action && action.selectedOptions[0];
      if (value) {
        const needs = !!(option && option.hasAttribute("data-needs-value"));
        value.hidden = !needs;
        if (needs) {
          value.type = action.value === "destination" ? "email" : "text";
          if (fromUser) value.focus();
        }
      }
      if (labelMenu) {
        const needs = !!(option && option.hasAttribute("data-needs-labels"));
        labelMenu.hidden = !needs;
        if (!needs) labelMenu.open = false;
        else if (fromUser) {
          labelMenu.open = true;
          if (labelFilter) labelFilter.focus();
        }
      }
    };
    if (labelMenu) {
      const summary = labelMenu.querySelector("summary");
      const boxes = [...labelMenu.querySelectorAll("input[name=labels]")];
      const count = () => {
        const n = boxes.filter((box) => box.checked).length;
        summary.textContent = n ? summary.dataset.template.replace("{count}", String(n)) : summary.dataset.empty;
      };
      for (const box of boxes) box.addEventListener("change", count);
      if (labelFilter) {
        labelFilter.addEventListener("input", () => {
          const q = labelFilter.value.trim().toLowerCase();
          for (const box of boxes) box.closest("label").hidden = !!q && !box.closest("label").dataset.name.includes(q);
        });
        labelMenu.addEventListener("toggle", () => { if (labelMenu.open) labelFilter.focus(); });
      }
      // A click elsewhere or Escape closes the list, keeping what was ticked.
      document.addEventListener("click", (event) => { if (labelMenu.open && !labelMenu.contains(event.target)) labelMenu.open = false; });
      labelMenu.addEventListener("keydown", (event) => { if (event.key === "Escape" && labelMenu.open) { labelMenu.open = false; summary.focus(); } });
      count();
    }
    if (all) all.addEventListener("change", () => { for (const box of picks()) box.checked = all.checked; refresh(); });
    let lastPicked = null;
    for (const box of picks()) {
      box.addEventListener("click", (event) => {
        if (event.shiftKey && lastPicked && lastPicked !== box) {
          const list = picks();
          const a = list.indexOf(lastPicked);
          const b = list.indexOf(box);
          if (a !== -1 && b !== -1) {
            const [start, end] = a < b ? [a, b] : [b, a];
            for (let i = start; i <= end; i++) list[i].checked = box.checked;
          }
        }
        lastPicked = box;
        refresh();
      });
      box.addEventListener("change", refresh);
    }
    if (action) action.addEventListener("change", () => showValue(true));
    showValue(false);
    refresh();
    bulk.addEventListener("submit", (event) => {
      if (!picks().some((box) => box.checked)) {
        event.preventDefault();
        show(bulk.dataset.noneSelected, false);
        return;
      }
      const chosen = action ? action.value : "";
      if (labelMenu && (chosen === "label" || chosen === "unlabel") && !labelMenu.querySelector("input[name=labels]:checked")) {
        event.preventDefault();
        labelMenu.open = true;
        const summary = labelMenu.querySelector("summary");
        if (summary) summary.focus();
        show(labelMenu.dataset.none || bulk.dataset.noLabels, false);
        return;
      }
      const question = chosen === "delete" ? bulk.dataset.confirmDelete : chosen === "forget" ? bulk.dataset.confirmForget : "";
      if (question && !confirm(question)) event.preventDefault();
    });
  }

  // Settings save as soon as something changes; a short message confirms it.
  const toast = document.querySelector("[data-toast]");
  let toastTimer = 0;
  const show = (message, ok) => {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.toggle("bad", !ok);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, ok ? 2500 : 6000);
  };
  // Forms that undo something ask first.
  for (const form of document.querySelectorAll("form[data-confirm]")) {
    form.addEventListener("submit", (event) => {
      if (!confirm(form.dataset.confirm)) event.preventDefault();
    });
  }
  const copyTimers = new WeakMap();
  for (const button of document.querySelectorAll("button[data-copy]")) {
    if (!navigator.clipboard) continue;
    button.hidden = false;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        clearTimeout(copyTimers.get(button));
        button.dataset.copied = "1";
        copyTimers.set(button, setTimeout(() => { delete button.dataset.copied; }, 1600));
        show(button.dataset.msgCopied, true);
      } catch {
        show(button.dataset.copy, false);
      }
    });
  }
  const autosaveForms = [];
  for (const form of document.querySelectorAll("form[data-autosave]")) {
    let latest = 0;
    let pendingReload = false;
    // Saves run one after another, so an older change can never land after a newer one.
    let queue = Promise.resolve();
    let lastSent = new URLSearchParams(new FormData(form)).toString();
    form._syncLastSent = (name, val) => {
      if (lastSent === null) return;
      if (name === undefined) {
        lastSent = new URLSearchParams(new FormData(form)).toString();
        return;
      }
      const params = new URLSearchParams(lastSent);
      params.set(name, val);
      lastSent = params.toString();
    };
    const save = (event) => {
      // Switching unsubscribe behavior to "redirect_contact" before filling the redirect address
      // would fail immediately; move focus to the address field so the user can enter it first.
      const target = event && event.target;
      if (target && (target.id === "unsubscribeBehavior" || target.id === "unsubscribeFallback") && target.value === "redirect_contact") {
        const redirect = form.querySelector("#unsubscribeRedirect");
        if (redirect && !redirect.value.trim()) {
          redirect.focus();
          return;
        }
      }
      const body = new URLSearchParams(new FormData(form)).toString();
      // Enter in a field fires both submit and change: the same values are sent once.
      if (body === lastSent) return;
      lastSent = body;
      const id = ++latest;
      form.dataset.saving = "1";
      queue = queue.then(() => send(id, body));
    };
    const send = async (id, body) => {
      try {
        const response = await fetch(form.action, {
          method: "POST",
          body: new URLSearchParams(body),
          headers: { "X-Autosave": "1", Accept: "application/json" },
          credentials: "same-origin",
        });
        const result = await response.json().catch(() => null);
        if (result && result.theme) applyTheme(result.theme);
        if (result && result.reload) pendingReload = true;
        if (id !== latest) return; // a newer change is already on its way
        delete form.dataset.saving;
        const ok = !!(response.ok && result && result.ok);
        if (ok && pendingReload) { location.reload(); return; }
        if (!ok) {
          pendingReload = false;
          lastSent = null; // a failed save may be tried again unchanged
        }
        show((result && (result.message || result.error)) || form.dataset.msgFailed, ok);
      } catch {
        if (id === latest) {
          delete form.dataset.saving;
          lastSent = null;
          show(form.dataset.msgFailed, false);
        }
      }
    };
    autosaveForms.push({ form, getLastSent: () => lastSent });
    form.addEventListener("change", save);
    form.addEventListener("submit", (event) => { event.preventDefault(); save(); });
    form.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && event.target && event.target.matches("input[type=text], input[type=email]")) event.target.blur();
    });
  }
  if (autosaveForms.length) {
    // One pagehide listener flushes any note currently being typed before the page is left.
    window.addEventListener("pagehide", () => {
      for (const { form, getLastSent } of autosaveForms) {
        if (!form.querySelector("input[type=text]:focus, input[type=email]:focus")) continue;
        const body = new URLSearchParams(new FormData(form)).toString();
        if (body !== getLastSent()) navigator.sendBeacon?.(form.action, new URLSearchParams(body));
      }
    });
  }
  for (const input of document.querySelectorAll("input[data-select]")) {
    input.addEventListener("focus", () => input.select());
    input.focus();
  }
  // Search ergonomics: clearing with the native x button refreshes results; "/" focuses search.
  const searchInput = document.querySelector('form[role="search"] input[type="search"]');
  if (searchInput) {
    searchInput.addEventListener("search", () => {
      if (searchInput.value === "" && searchInput.defaultValue !== "" && searchInput.form) searchInput.form.requestSubmit();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      const active = document.activeElement;
      if (active && (active.matches("input, textarea, select") || active.isContentEditable)) return;
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
    });
  }
  // Show timestamps in the browser's own timezone instead of UTC.
  const times = document.querySelectorAll("time[datetime]");
  if (times.length) {
    try {
      const fmt = new Intl.DateTimeFormat(document.documentElement.lang || undefined, { dateStyle: "medium", timeStyle: "short" });
      for (const el of times) {
        const date = new Date(el.getAttribute("datetime") || "");
        if (Number.isNaN(date.getTime())) continue;
        const text = fmt.format(date);
        const relative = el.hasAttribute("title");
        el.title = text;
        if (!relative) el.textContent = text;
      }
    } catch {}
  }
  // On a phone the menu is one row that scrolls sideways: keep it where it was from page to page,
  // and bring the current page's link into view when it would be hidden.
  const nav = document.querySelector("nav.sidebar");
  if (nav && nav.scrollWidth > nav.clientWidth) {
    const KEY = "af_nav_x";
    let saved = null;
    try { saved = sessionStorage.getItem(KEY); } catch {}
    if (saved !== null) nav.scrollLeft = Number(saved) || 0;
    const current = nav.querySelector("a[aria-current]");
    if (current) {
      const navRect = nav.getBoundingClientRect();
      const itemRect = current.getBoundingClientRect();
      if (saved === null || itemRect.left < navRect.left || itemRect.right > navRect.right) {
        current.scrollIntoView({ block: "nearest", inline: "center" });
      }
    }
    const remember = () => { try { sessionStorage.setItem(KEY, String(Math.round(nav.scrollLeft))); } catch {} };
    nav.addEventListener("scroll", remember, { passive: true });
    addEventListener("pagehide", remember);
  }

  // Turning a page keeps the pager that was clicked where it was on the screen, so the next click
  // lands on the same button instead of the page jumping back to the top.
  const PAGER_KEY = "af_pager";
  const pagers = document.querySelectorAll("nav.pager");
  let pagerSaved = null;
  try { pagerSaved = JSON.parse(sessionStorage.getItem(PAGER_KEY) || "null"); sessionStorage.removeItem(PAGER_KEY); } catch {}
  if (pagerSaved && pagerSaved.path === location.pathname && pagers.length && typeof pagerSaved.top === "number") {
    const pager = pagers[Math.max(0, Math.min(Number(pagerSaved.index) || 0, pagers.length - 1))];
    window.scrollTo(0, Math.max(0, window.scrollY + pager.getBoundingClientRect().top - pagerSaved.top));
  }
  pagers.forEach((pager, index) => {
    pager.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a.pg") : null;
      if (!link) return;
      const top = Math.round(pager.getBoundingClientRect().top);
      try { sessionStorage.setItem(PAGER_KEY, JSON.stringify({ path: location.pathname, index, top })); } catch {}
    });
  });

  // A label's colour: picking one shows it on the closed button and folds the palette away.
  for (const pick of document.querySelectorAll("details.colour-pick")) {
    const dot = pick.querySelector("summary .dot");
    pick.addEventListener("change", (event) => {
      const swatch = event.target instanceof HTMLInputElement ? event.target.nextElementSibling : null;
      if (dot && swatch && swatch.dataset.colour) dot.dataset.colour = swatch.dataset.colour;
      pick.open = false;
      pick.querySelector("summary").focus();
    });
  }
  document.addEventListener("click", (event) => {
    for (const pick of document.querySelectorAll("details.colour-pick[open]")) if (!pick.contains(event.target)) pick.open = false;
  });

  // The settings page's jump bar marks the section in view.
  const jumps = [...document.querySelectorAll(".jump a[href^='#']")];
  if (jumps.length && "IntersectionObserver" in window) {
    const mark = (id) => { for (const a of jumps) a.toggleAttribute("aria-current", a.getAttribute("href") === "#" + id); };
    const seen = new Map();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) seen.set(entry.target.id, entry.isIntersecting);
      const first = jumps.map((a) => a.getAttribute("href").slice(1)).find((id) => seen.get(id));
      if (first) mark(first);
    }, { rootMargin: "-64px 0px -55% 0px" });
    for (const a of jumps) { const section = document.getElementById(a.getAttribute("href").slice(1)); if (section) observer.observe(section); }
  }

  // A click on a link to another page answers at once: the menu shows where you are going, a bar
  // runs along the top and the old content fades, while the next page loads (often already fetched).
  const root = document.documentElement;
  const leaving = (link) => {
    root.setAttribute("data-navigating", "");
    const item = link && link.closest(".sidebar a");
    if (item) {
      for (const other of document.querySelectorAll(".sidebar a[aria-current]")) other.removeAttribute("aria-current");
      item.setAttribute("aria-current", "page");
    }
  };
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link || link.target || link.hasAttribute("download")) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || url.pathname.startsWith("/assets/")) return;
    // A link to a place on this same page only scrolls.
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
    leaving(link);
  });
  for (const form of document.querySelectorAll('form[method="get"], form:not([method])')) {
    form.addEventListener("submit", (event) => { if (!event.defaultPrevented && !form.hasAttribute("data-autosave")) leaving(null); });
  }
  // Coming back with the Back button shows the page as it was left: undo the fading.
  addEventListener("pageshow", (event) => { if (event.persisted) root.removeAttribute("data-navigating"); });
})();
`;
