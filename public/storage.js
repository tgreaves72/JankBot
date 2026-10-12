const JankBotStorage = (() => {
  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("jankbot", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("history");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Browser storage unavailable. Your builds cannot be persisted on this device."));
    });
  }

  async function saveHistory(history) {
    const db = await open();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("history", "readwrite");
        transaction.objectStore("history").put(history, "builds");
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(new Error("Could not save builds to this browser."));
        transaction.onerror = () => reject(new Error("Could not save builds to this browser."));
      });
    } finally { db.close(); }
  }

  async function loadHistory() {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction("history").objectStore("history").get("builds");
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(new Error("Could not load builds from this browser."));
      });
    } finally { db.close(); }
  }

  return { saveHistory, loadHistory };
})();
