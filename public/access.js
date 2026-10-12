const JankBotAccess = (() => {
  const dialog = document.querySelector("#demoAccess");
  const error = document.querySelector("#demoAccessError");
  const signOut = document.querySelector("#demoSignOut");
  const signOutDialog = document.querySelector("#signOutDialog");
  const confirmSignOut = document.querySelector("#confirmSignOut");
  const cancelSignOut = document.querySelector("#cancelSignOut");
  const signOutError = document.querySelector("#signOutError");
  let waiting;
  let unlock;
  let expires;
  document.querySelector(".shell").inert = true;

  let linkToken = null;
  function captureLink() {
    if (!location.hash.startsWith("#demo=")) return false;
    linkToken = location.hash.slice(6);
    // Strip the bearer credential before any API calls or third-party images load.
    history.replaceState(null, "", location.pathname + location.search);
    return true;
  }
  captureLink();

  function lock(message = "") {
    if (signOutDialog.open) signOutDialog.close();
    error.textContent = message;
    if (!waiting) waiting = new Promise(resolve => { unlock = resolve; });
    document.querySelector(".shell").inert = true;
    if (!dialog.open) dialog.showModal();
    signOut.hidden = true;
    return waiting;
  }

  function accept(session) {
    clearTimeout(expires);
    signOut.hidden = !session.enabled;
    document.querySelector(".shell").inert = false;
    if (dialog.open) dialog.close();
    if (session.expiresAt) expires = setTimeout(() => lock("Your session ended. Reopen the JankBot invitation link to continue."), Math.max(0, session.expiresAt - Date.now()));
    unlock?.();
    waiting = null;
    unlock = null;
  }

  async function ensure() {
    if (linkToken !== null) {
      const token = linkToken;
      linkToken = null;
      try {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("This demo link is incomplete or invalid.");
        const response = await fetch("/api/demo/claim", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
        const session = await response.json();
        if (!response.ok) throw new Error(session.error || "Could not open this demo link.");
        sessionStorage.removeItem("jankbot_job");
        accept(session);
        return;
      } catch (failure) { return lock(failure.message); }
    }
    const response = await fetch("/api/session", { cache: "no-store" });
    if (!response.ok) throw new Error("Demo access service is unavailable.");
    const session = await response.json();
    if (session.authenticated) accept(session);
    else await lock();
  }

  dialog.addEventListener("cancel", event => event.preventDefault());
  window.addEventListener("hashchange", () => {
    if (captureLink()) void ensure().catch(failure => lock(failure.message));
  });

  signOut.addEventListener("click", () => {
    signOutError.textContent = "";
    if (!signOutDialog.open) signOutDialog.showModal();
  });
  cancelSignOut.addEventListener("click", () => signOutDialog.close());
  signOutDialog.addEventListener("cancel", event => {
    if (confirmSignOut.disabled) event.preventDefault();
  });
  confirmSignOut.addEventListener("click", async () => {
    if (confirmSignOut.disabled) return;
    signOut.disabled = true;
    confirmSignOut.disabled = true;
    cancelSignOut.disabled = true;
    try {
      const response = await fetch("/api/demo/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error("Sign out failed.");
      sessionStorage.removeItem("jankbot_job");
      clearTimeout(expires);
      void lock();
    } catch (failure) { signOutError.textContent = failure.message; }
    finally { signOut.disabled = false; confirmSignOut.disabled = false; cancelSignOut.disabled = false; }
  });
  return { ensure, lock };
})();
