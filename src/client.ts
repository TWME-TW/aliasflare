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
      if (button) button.disabled = true;
      try {
        const flow = form.dataset.passkey;
        if (flow === "login") await login();
        else await register(form, flow === "setup" ? "/setup" : "/passkeys");
        location.href = form.dataset.next || "/";
      } catch (error) {
        const cancelled = error && (error.name === "NotAllowedError" || error.name === "AbortError");
        show(form, cancelled ? (messages.msgCancelled || "The passkey prompt was cancelled or timed out.") : ((error && error.message) || String(error)));
      } finally {
        if (button) button.disabled = false;
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

  // The sending provider's own fields show as soon as it is chosen.
  const provider = document.getElementById("outboundProvider");
  if (provider) {
    const show = () => {
      for (const group of document.querySelectorAll(".provider-fields")) group.hidden = group.dataset.provider !== provider.value;
    };
    provider.addEventListener("change", show);
  }

  // Import forms carry the domains chosen in the shared box above them.
  const domainSource = document.querySelector("[data-domains-source]");
  const importForms = [...document.querySelectorAll("form[data-import]")];
  for (const form of importForms) {
    form.addEventListener("submit", () => {
      const hidden = form.querySelector("[data-domains]");
      if (hidden && domainSource) hidden.value = domainSource.value;
      const button = form.querySelector("button");
      if (button) button.disabled = true;
    });
  }
  if (importForms.length) {
    window.addEventListener("pageshow", () => {
      for (const form of importForms) {
        const button = form.querySelector("button");
        if (button) button.disabled = false;
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
    if (select && select.value !== theme) select.value = theme;
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
      const checked = picks().filter((box) => box.checked).length;
      if (counter) counter.textContent = counter.dataset.template.replace("{count}", String(checked));
      if (all) {
        all.checked = checked > 0 && checked === picks().length;
        all.indeterminate = checked > 0 && checked < picks().length;
      }
    };
    const showValue = () => {
      const option = action && action.selectedOptions[0];
      if (value) value.hidden = !(option && option.hasAttribute("data-needs-value"));
    };
    if (all) all.addEventListener("change", () => { for (const box of picks()) box.checked = all.checked; refresh(); });
    for (const box of picks()) box.addEventListener("change", refresh);
    if (action) action.addEventListener("change", showValue);
    showValue();
    refresh();
    bulk.addEventListener("submit", (event) => {
      if (!picks().some((box) => box.checked)) {
        event.preventDefault();
        show(bulk.dataset.noneSelected, false);
        return;
      }
      const chosen = action ? action.value : "";
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
  for (const button of document.querySelectorAll("button[data-copy]")) {
    if (!navigator.clipboard) continue;
    button.hidden = false;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        show(button.dataset.msgCopied, true);
      } catch {
        show(button.dataset.copy, false);
      }
    });
  }
  const autosaveForms = [];
  for (const form of document.querySelectorAll("form[data-autosave]")) {
    let latest = 0;
    // Saves run one after another, so an older change can never land after a newer one.
    let queue = Promise.resolve();
    let lastSent = null;
    const save = () => {
      const body = new URLSearchParams(new FormData(form)).toString();
      // Enter in a field fires both submit and change: the same values are sent once.
      if (body === lastSent) return;
      lastSent = body;
      const id = ++latest;
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
        if (id !== latest) return; // a newer change is already on its way
        if (result && result.theme) applyTheme(result.theme);
        if (result && result.reload) { location.reload(); return; }
        const ok = !!(response.ok && result && result.ok);
        if (!ok) lastSent = null; // a failed save may be tried again unchanged
        show((result && (result.message || result.error)) || form.dataset.msgFailed, ok);
      } catch {
        lastSent = null;
        if (id === latest) show(form.dataset.msgFailed, false);
      }
    };
    autosaveForms.push({ form, getLastSent: () => lastSent });
    form.addEventListener("change", save);
    form.addEventListener("submit", (event) => { event.preventDefault(); save(); });
  }
  if (autosaveForms.length) {
    // One pagehide listener flushes any note currently being typed before the page is left.
    window.addEventListener("pagehide", () => {
      for (const { form, getLastSent } of autosaveForms) {
        if (!form.querySelector("input[type=text]:focus")) continue;
        const body = new URLSearchParams(new FormData(form)).toString();
        if (body !== getLastSent()) navigator.sendBeacon?.(form.action, new URLSearchParams(body));
      }
    });
  }
  for (const input of document.querySelectorAll("input[data-select]")) {
    input.addEventListener("focus", () => input.select());
    input.focus();
  }
})();
`;
