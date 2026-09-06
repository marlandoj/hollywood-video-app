/** Owner-scoped cast editor. All user text is assigned through DOM properties. */
import {characterSheets} from "./sheets.js";
import {actorSharePanel,actorImportPanel,costumePresetPanel} from "./library.js";
export function initCasting({panel, request, ensureProject, changed, image, prepareGeneration, assetUrl, sharedRequest, sharedImage}) {
  let snapshot = null, history = [], scenes = [], scriptVersion=0, editingId = null, dirty = false, busy = false;
  const node = (tag, text, className) => {const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element;};
  const button = (label, action, className = "secondary") => {const element = node("button", label, className); element.type = "button"; element.onclick = action; return element;};
  const heading = node("h2", "Cast direction"); heading.id = "cast-title";
  panel.setAttribute("aria-labelledby", heading.id);
  const intro = node("p", "Describe original fictional characters and set their wardrobe and performance. These notes guide generation; they do not establish a visual identity lock.", "environment");
  const message = node("p", "", "status"); message.setAttribute("role", "status"); message.setAttribute("aria-live", "polite");
  const revision = node("p", "", "environment"), list = node("div"), library=node("div");
  list.setAttribute("aria-label", "Project cast");
  const toolbar = node("div", undefined, "result-actions");
  const editor = node("form"); editor.hidden = true; editor.id = "cast-editor";
  const fields = new Map(), wardrobeRows = node("div"), permissionScenes = node("input"), permitted = node("input");
  const imageUrls = new Set();let listRevision = 0;const sheetPanels=[];
  window.addEventListener("pagehide",() => {for (const url of imageUrls) URL.revokeObjectURL(url);imageUrls.clear();for(const sheet of sheetPanels)sheet.dispose();});
  function field(parent, key, label, multiline = false, limit = 600) {
    const wrapper = node("div", undefined, "cast-field"), control = node(multiline ? "textarea" : "input");
    control.id = "cast-" + key; control.maxLength = limit; if (multiline) control.rows = 3;
    if (key === "name") control.required = true;
    const caption = node("label", label); caption.htmlFor = control.id;
    wrapper.append(caption, control); parent.append(wrapper); fields.set(key, control); return control;
  }
  const identity = node("fieldset"); identity.append(node("legend", "Character"));
  field(identity, "name", "Name in the screenplay", false, 80);
  field(identity, "aliases", "Other names (separate with commas)", false, 648);
  field(identity, "appearance", "Appearance", true, 1000);
  editor.append(identity);
  const look = node("details"); look.append(node("summary", "Appearance details"));
  const lookFields = node("div", undefined, "cast-grid");
  for (const [key, label, limit] of [["ageRange", "Age range", 80], ["ethnicity", "Ethnicity", 120], ["body", "Build and physical traits", 240], ["hairMakeup", "Hair and makeup", 400]]) field(lookFields, key, label, key === "hairMakeup", limit);
  look.append(lookFields); editor.append(look);
  const performance = node("details"); performance.append(node("summary", "Performance and continuity"));
  for (const [key, label, limit] of [["expressions", "Expressions", 400], ["movement", "Movement", 400], ["relationships", "Relationships", 600], ["arcNotes", "Character arc", 600], ["prohibitedChanges", "Traits to preserve", 600]]) field(performance, key, label, true, limit);
  editor.append(performance);
  function wardrobeRow(value = {sceneNumber: null, description: ""}) {
    const row = node("div", undefined, "cast-wardrobe"), select = node("select"), input = node("textarea"), id = crypto.randomUUID();
    select.id = "wardrobe-scene-" + id; input.id = "wardrobe-description-" + id; input.rows = 2; input.maxLength = 600; input.required = true;
    select.append(new Option("All scenes (default)", ""));
    for (const scene of scenes) select.append(new Option(scene.number + ". " + scene.heading, String(scene.number)));
    if (value.sceneNumber !== null && !scenes.some(scene => scene.number === value.sceneNumber)) select.append(new Option("Missing scene " + value.sceneNumber, String(value.sceneNumber)));
    select.value = value.sceneNumber === null ? "" : String(value.sceneNumber); input.value = value.description;
    const sceneLabel = node("label", "Scene"); sceneLabel.htmlFor = select.id;
    const descriptionLabel = node("label", "Wardrobe"); descriptionLabel.htmlFor = input.id;
    const remove = button("Remove wardrobe", () => {row.remove(); dirty = true;});
    row.append(sceneLabel, select, descriptionLabel, input, remove); wardrobeRows.append(row);
  }
  const wardrobe = node("details"); wardrobe.append(node("summary", "Wardrobe by scene"), wardrobeRows, button("Add wardrobe", () => {
    if (wardrobeRows.children.length >= 24) return tell("A character supports 24 wardrobe entries.", true);
    wardrobeRow(); dirty = true;
  }));
  editor.append(wardrobe);
  const permissions = node("fieldset"); permissions.append(node("legend", "Creator permission"));
  const status = node("select"); status.id = "cast-permission";
  for (const [value, label] of [["pending", "Draft — permission pending"], ["permitted", "Permitted for rendering"], ["revoked", "Permission revoked"]]) status.append(new Option(label, value));
  const statusLabel = node("label", "Permission status"); statusLabel.htmlFor = status.id;
  const scope = node("select"); scope.id = "cast-scope";
  scope.append(new Option("This project", "project"), new Option("Selected scenes", "scenes"));
  const scopeLabel = node("label", "Permitted use"); scopeLabel.htmlFor = scope.id;
  permissionScenes.id = "cast-scenes"; permissionScenes.placeholder = "For example: 1, 3, 5"; permissionScenes.maxLength = 1000;
  const sceneLabel = node("label", "Permitted scene numbers"); sceneLabel.htmlFor = permissionScenes.id;
  const expiry = node("input"); expiry.type = "datetime-local"; expiry.id = "cast-expiry";
  const expiryLabel = node("label", "Permission expires (optional, local time)"); expiryLabel.htmlFor = expiry.id;
  const attestation = node("label", undefined, "attestation");
  permitted.type = "checkbox"; permitted.id = "cast-attested";
  attestation.append(permitted, node("span", "This is my original fictional character, and I permit its use in this project within the selected scope."));
  permissions.append(statusLabel, status, scopeLabel, scope, sceneLabel, permissionScenes, expiryLabel, expiry, attestation);
  const permissionDisplay = () => {permissionScenes.disabled = scope.value !== "scenes"; sceneLabel.hidden = permissionScenes.hidden = scope.value !== "scenes"; permitted.required = status.value === "permitted";};
  scope.addEventListener("change", permissionDisplay); status.addEventListener("change", permissionDisplay);
  editor.append(permissions);
  const actions = node("div", undefined, "result-actions"), save = node("button", "Save character"); save.type = "submit";
  const cancel = button("Cancel edit", () => {editor.hidden = true; dirty = false; tell("Edit cancelled.");});
  actions.append(save, cancel); editor.append(actions);
  const historyDetails = node("details"), historySelect = node("select"); historySelect.id = "cast-history-version";
  const historyLabel = node("label", "Saved cast version"); historyLabel.htmlFor = historySelect.id;
  historyDetails.append(node("summary", "Version history"), node("p", "The 100 most recent cast versions are available here. Renders keep their saved cast. Restore creates a new revision and requires permission again.", "environment"),
    historyLabel, historySelect, button("Restore version", async () => {
      if (dirty) return tell("Save or cancel the open character edit before restoring.", true);
      await mutate(() => request("/restore", {method: "POST", body: {expectedVersion: snapshot.version, version: Number(historySelect.value)}}));
    }));
  const add = button("Add character", () => edit(null));
  const reload = button("Reload cast", async () => {
    if (dirty) return tell("Save or cancel the open character edit before reloading.", true);
    await load();
  });
  toolbar.append(add, reload, button("Close cast editor", () => {
    if (dirty) return tell("Save or cancel the open character edit before closing.", true);
    panel.hidden = true;
  }));
  panel.append(heading, intro, revision, toolbar, library, list, editor, historyDetails, message);
  function tell(text, error = false) {message.textContent = text; message.dataset.state = error ? "error" : "success";}
  function renderList() {
    for(const sheet of sheetPanels)sheet.dispose();sheetPanels.length=0;
    for (const url of imageUrls) URL.revokeObjectURL(url);imageUrls.clear();
    const rendering = ++listRevision;
    const imported=actorImportPanel({snapshot,request,sharedRequest,sharedImage,mutate,dirty:()=>dirty||busy,alive:()=>rendering===listRevision});library.replaceChildren(imported.panel);sheetPanels.push(imported);
    list.replaceChildren();
    revision.textContent = "Cast version " + snapshot.version + " · " + snapshot.characters.length + " of 24 characters";
    if (!snapshot.characters.length) list.append(node("p", "No cast directions yet. Add a character using the name from your screenplay.", "environment"));
    for (const character of snapshot.characters) {
      const row = node("article", undefined, "cast-card"), title = node("h3", character.name), summary = node("p", character.appearance || "No appearance notes.", "environment");
      summary.textContent = summary.textContent.slice(0, 180);
      const state = node("p", "Permission: " + character.permission.status + (character.permission.expiresAt ? " · expires " + new Date(character.permission.expiresAt).toLocaleString() : ""), "environment");
      const buttons = node("div", undefined, "result-actions");
      buttons.append(button("Edit " + character.name, () => edit(character)), button("Remove " + character.name, async () => {
        if (dirty) return tell("Save or cancel the open edit first.", true);
        await mutate(() => request("/" + character.id + "/remove", {method: "POST", body: {expectedVersion: snapshot.version}}));
      }));
      if (character.permission.status === "permitted") buttons.append(button("Revoke permission for " + character.name, async () => {
        if (dirty) return tell("Save or cancel the open edit first.", true);
        await mutate(() => request("/" + character.id + "/revoke", {method: "POST", body: {expectedVersion: snapshot.version}}));
      }));
      row.append(title, summary, state, buttons); list.append(row);
      const references = node("details");references.append(node("summary","Visual references · " + (character.references?.length ?? 0) + " of 4"));
      references.append(node("p","Use PNG or JPEG images of your original fictional character, up to 10 MiB and 4096 × 4096 pixels. Images are normalized and sent to the selected generation provider when rendering. Reference guidance still needs a visual review.","environment"));
      const images = node("div",undefined,"cast-reference-list");
      for (const [index,asset] of (character.references ?? []).entries()) {
        const figure = node("figure"), preview = node("img");preview.alt = character.name + " reference " + (index + 1);
        const caption = node("figcaption","Reference " + (index + 1));
        const remove = button("Remove reference " + (index + 1),async () => {
          if (dirty) return tell("Save or cancel the open edit first.",true);
          await mutate(() => request("/" + character.id + "/references/" + asset.id + "/remove",{method:"POST",body:{expectedVersion:snapshot.version}}));
        });
        figure.append(preview,caption,remove);images.append(figure);
        let loaded = false;
        references.addEventListener("toggle",() => {
          if (!references.open || loaded) return;
          loaded = true;caption.textContent = "Loading reference " + (index + 1) + "…";
          void image(asset.id).then(blob => {
            if (rendering !== listRevision) return;
            const url = URL.createObjectURL(blob);imageUrls.add(url);preview.src = url;
            caption.textContent = "Reference " + (index + 1);
          }).catch(() => {if (rendering === listRevision) caption.textContent = "Reference image unavailable. Reload to retry.";});
        });
      }
      references.append(images);
      if ((character.references?.length ?? 0) < 4) {
        const file = node("input");file.type = "file";file.accept = "image/png,image/jpeg";file.id = "reference-file-" + character.id;
        const label = node("label","Reference image for " + character.name);label.htmlFor = file.id;
        const grant = node("label",undefined,"attestation"), check = node("input");check.type = "checkbox";
        grant.append(check,node("span","I hold the rights to this image of an original fictional character and permit its use for this project's generation."));
        const upload = button("Add reference for " + character.name,async () => {
          if (dirty) return tell("Save or cancel the open edit before adding a reference.",true);
          const selected = file.files?.[0];
          if (!selected || !["image/png","image/jpeg"].includes(selected.type) || selected.size > 10 * 1024 ** 2)
            return tell("Choose a PNG or JPEG image up to 10 MiB.",true);
          if (!check.checked) return tell("Confirm the reference image rights before uploading.",true);
          await mutate(() => request("/" + character.id + "/references",{method:"POST",body:selected,
            headers:{"content-type":selected.type,"x-hv-reference-attested":"true","x-hv-cast-version":String(snapshot.version)}}));
        });
        references.append(label,file,grant,upload);
      }
      if (character.references?.length) references.append(node("p","Removing a reference changes the current cast. Previous casts and renders retain their images until project deletion.","environment"));
      row.append(references);
      const sheet=characterSheets({character,snapshot,scenes,request,prepareGeneration,mutate,dirty:()=>dirty||busy,alive:()=>rendering===listRevision,assetUrl});
      row.append(sheet.panel);sheetPanels.push(sheet);
      const sharing=actorSharePanel({character,snapshot,request,image,dirty:()=>dirty||busy,alive:()=>rendering===listRevision});row.append(sharing.panel);sheetPanels.push(sharing);
      if(character.libraryOrigin)row.append(node("p","Imported actor. Its images are stored privately in this project; source share revocation does not remove this copy.","environment"));
      if(character.costumePresets?.length)row.append(costumePresetPanel({character,snapshot,scenes,scriptVersion,request,mutate,prepare:ensureProject,dirty:()=>dirty||busy}));
    }
    historySelect.replaceChildren(new Option("Version 0 — empty cast", "0"));
    for (const value of history) historySelect.append(new Option("Version " + value.version + " · " + value.characters + " characters · " + new Date(value.createdAt).toLocaleString(), String(value.version)));
    if (snapshot.version) historySelect.value = String(Math.max(0, snapshot.version - 1));
    add.disabled = snapshot.characters.length >= 24;
  }
  function edit(character) {
    if (!snapshot) return tell("Reload the cast before editing.", true);
    if (dirty) return tell("Save or cancel the open character edit first.", true);
    editingId = character?.id ?? crypto.randomUUID();
    for (const [key, control] of fields) control.value = key === "aliases" ? (character?.aliases ?? []).join(", ") : character?.[key] ?? "";
    wardrobeRows.replaceChildren(); for (const value of character?.wardrobe ?? []) wardrobeRow(value);
    const grant = character?.permission;
    status.value = grant?.status ?? "pending"; scope.value = grant?.scope ?? "project"; permissionScenes.value = (grant?.sceneNumbers ?? []).join(", ");
    expiry.value = grant?.expiresAt ? new Date(Date.parse(grant.expiresAt) - new Date(grant.expiresAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
    permitted.checked = grant?.status === "permitted"; permissionDisplay();
    editor.hidden = false; dirty = false; fields.get("name").focus();
    tell(character ? "Editing " + character.name + "." : "New original fictional character.");
  }
  async function load() {
    if (busy) return; busy = true;
    const controls = [...panel.querySelectorAll("button,input,textarea,select")], disabled = controls.map(control => control.disabled); controls.forEach(control => {control.disabled = true;});
    try {
      const result = await request(""); snapshot = result.casting; history = result.history; scenes = result.sceneHeadings;scriptVersion=result.scriptVersion; renderList();
      editor.hidden = true; editingId = null; dirty = false;
      changed(snapshot.version, false);
      tell("Cast loaded. Edits remain private to this project's signed link.");
    } catch (error) {tell(error.message || "Cast could not be loaded.", true);}
    finally {busy = false; controls.forEach((control, index) => {control.disabled = disabled[index];}); add.disabled = !snapshot || snapshot.characters.length >= 24;}
  }
  async function mutate(action) {
    if (!snapshot) return tell("Reload the cast before saving.", true);
    if (busy) return; busy = true;
    tell("Saving cast…");
    const controls = [...panel.querySelectorAll("button,input,textarea,select")], disabled = controls.map(control => control.disabled); controls.forEach(control => {control.disabled = true;});
    try {
      const result = await action(); snapshot = result.casting;
      if (!history.some(value => value.version === snapshot.version)) history.push({version: snapshot.version, createdAt: snapshot.createdAt, characters: snapshot.characters.length});
      history = history.slice(-100);
      editor.hidden = true; dirty = false; changed(snapshot.version, true); renderList();
      tell("Saved cast version " + snapshot.version + ". Create a new preview to review these directions.");
    } catch (error) {tell(error.message || "The cast could not be saved.", true);}
    finally {busy = false; controls.forEach((control, index) => {control.disabled = disabled[index];}); add.disabled = !snapshot || snapshot.characters.length >= 24;}
  }
  editor.addEventListener("input", () => {dirty = true;});
  editor.addEventListener("change", () => {dirty = true;});
  editor.addEventListener("submit", async event => {
    event.preventDefault();
    const values = Object.fromEntries([...fields].map(([key, control]) => [key, control.value]));
    const character = {...values, kind: "original-fictional", aliases: values.aliases.split(",").map(value => value.trim()).filter(Boolean),
      wardrobe: [...wardrobeRows.children].map(row => ({sceneNumber: row.querySelector("select").value ? Number(row.querySelector("select").value) : null, description: row.querySelector("textarea").value})),
      permission: {status: status.value, scope: scope.value, sceneNumbers: scope.value === "scenes" ? permissionScenes.value.split(",").map(value => Number(value.trim())) : [],
        expiresAt: expiry.value ? new Date(expiry.value).toISOString() : null, attested: permitted.checked}};
    await mutate(() => request("/" + editingId, {method: "PUT", body: {expectedVersion: snapshot.version, character}}));
  });
  return {get unsaved() {return dirty || busy;}, async open() {
    if (dirty && !panel.hidden) return;
    try {await ensureProject(); panel.hidden = false; await load(); heading.tabIndex = -1; heading.focus();}
    catch (error) {panel.hidden = false; tell(error.message || "Save the screenplay before editing the cast.", true);}
  }};
}
