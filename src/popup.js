import { deleteTabset, readTabsets } from "./tabsetStore.js";
import { readSettings, writeSettings } from "./settingsStore.js";
import { listView, nameExists, validateName } from "./popupModel.js";
import { CAPTURE, OPEN, RESTORE } from "./popupMessages.js";

const nameInput = document.getElementById("name");
const saveForm = document.getElementById("save-form");
const saveButton = document.getElementById("save");
const statusLine = document.getElementById("status");
const listEl = document.getElementById("list");
const snapshotsToggle = document.getElementById("snapshots");
const restoreButton = document.getElementById("restore");

function showStatus(text) {
  statusLine.textContent = text;
  statusLine.hidden = text === "";
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

async function refreshList() {
  const sets = await readTabsets(chrome);
  listEl.replaceChildren();
  for (const row of listView(sets)) {
    const li = document.createElement("li");

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = row.name;

    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `${row.tabCount}`;

    const open = document.createElement("button");
    open.textContent = "Open";
    open.addEventListener("click", async () => {
      await send({ type: OPEN, name: row.name });
      window.close();
    });

    const del = document.createElement("button");
    del.textContent = "✕";
    del.addEventListener("click", async () => {
      // Two-step confirm inline: the first click arms, the second deletes.
      if (del.dataset.armed !== "yes") {
        del.dataset.armed = "yes";
        del.textContent = "Sure?";
        return;
      }
      await deleteTabset(chrome, row.name);
      await refreshList();
    });

    li.append(name, count, open, del);
    listEl.append(li);
  }
}

saveForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const check = validateName(nameInput.value);
  if (!check.valid) {
    showStatus(check.reason === "empty" ? "Type a name first." : "Name is too long.");
    return;
  }
  const sets = await readTabsets(chrome);
  // Overwrite is a two-step confirm on the Save button itself.
  if (nameExists(sets, check.name) && saveButton.dataset.armed !== check.name) {
    saveButton.dataset.armed = check.name;
    saveButton.textContent = "Replace?";
    return;
  }
  saveButton.dataset.armed = "";
  saveButton.textContent = "Save";
  const reply = await send({ type: CAPTURE, name: check.name });
  if (!reply || !reply.ok) {
    showStatus("Can't save this window.");
    return;
  }
  nameInput.value = "";
  showStatus(reply.overwritten ? `Replaced "${check.name}".` : `Saved "${check.name}".`);
  await refreshList();
});

// Re-arming a stale "Replace?" if the name changes: reset the button on input.
nameInput.addEventListener("input", () => {
  if (saveButton.dataset.armed) {
    saveButton.dataset.armed = "";
    saveButton.textContent = "Save";
  }
});

snapshotsToggle.addEventListener("change", async () => {
  await writeSettings(chrome, { snapshotsEnabled: snapshotsToggle.checked });
  restoreButton.hidden = !snapshotsToggle.checked;
});

restoreButton.addEventListener("click", async () => {
  await send({ type: RESTORE });
  window.close();
});

async function init() {
  const settings = await readSettings(chrome);
  snapshotsToggle.checked = settings.snapshotsEnabled;
  restoreButton.hidden = !settings.snapshotsEnabled;
  await refreshList();
}

void init();
