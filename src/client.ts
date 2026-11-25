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

  // Import forms carry the domains chosen in the shared box above them.
  const domainSource = document.querySelector("[data-domains-source]");
  for (const form of document.querySelectorAll("form[data-import]")) {
    form.addEventListener("submit", () => {
      const hidden = form.querySelector("[data-domains]");
      if (hidden && domainSource) hidden.value = domainSource.value;
      const button = form.querySelector("button");
      if (button) button.disabled = true;
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
        if (result && result.reload) { location.reload(); return; }
        const ok = !!(response.ok && result && result.ok);
        if (!ok) lastSent = null; // a failed save may be tried again unchanged
        show((result && (result.message || result.error)) || form.dataset.msgFailed, ok);
      } catch {
        lastSent = null;
        if (id === latest) show(form.dataset.msgFailed, false);
      }
    };
    // A note being typed is saved before the page is left.
    window.addEventListener("pagehide", () => {
      const body = new URLSearchParams(new FormData(form)).toString();
      if (body !== lastSent && form.querySelector("input[type=text]:focus")) {
        navigator.sendBeacon?.(form.action, new URLSearchParams(body));
      }
    });
    form.addEventListener("change", save);
    form.addEventListener("submit", (event) => { event.preventDefault(); save(); });
  }
  for (const input of document.querySelectorAll("input[data-select]")) {
    input.addEventListener("focus", () => input.select());
    input.focus();
  }
})();
`;
