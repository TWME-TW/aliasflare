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
        show(form, error && error.name === "NotAllowedError" ? (messages.msgCancelled || "The passkey prompt was cancelled or timed out.") : (error.message || String(error)));
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
  for (const form of document.querySelectorAll("form[data-autosave]")) {
    let latest = 0;
    const save = async () => {
      const id = ++latest;
      try {
        const response = await fetch(form.action, {
          method: "POST",
          body: new URLSearchParams(new FormData(form)),
          headers: { "X-Autosave": "1", Accept: "application/json" },
          credentials: "same-origin",
        });
        const result = await response.json().catch(() => null);
        if (id !== latest) return; // a newer change is already on its way
        if (result && result.reload) { location.reload(); return; }
        show((result && (result.message || result.error)) || form.dataset.msgFailed, !!(response.ok && result && result.ok));
      } catch {
        if (id === latest) show(form.dataset.msgFailed, false);
      }
    };
    form.addEventListener("change", save);
    form.addEventListener("submit", (event) => { event.preventDefault(); save(); });
  }
  for (const input of document.querySelectorAll("input[data-select]")) {
    input.addEventListener("focus", () => input.select());
    input.focus();
  }
})();
`;
