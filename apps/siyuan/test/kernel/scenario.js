// End-to-end run of kernel.js in goja: lifecycle, RPC handlers, storage
// layout, reminder scheduling and multi-window claiming.
(async function () {
  var failures = 0;
  function check(name, ok, detail) {
    if (ok) console.log("ok   " + name);
    else {
      failures++;
      console.log("FAIL " + name + (detail === undefined ? "" : " :: " + JSON.stringify(detail)));
    }
  }
  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }
  function localDate(offsetDays) {
    var d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }
  function call(method) {
    var fn = __mock.rpc.get(method);
    if (!fn) throw new Error("method not bound: " + method);
    return fn.apply(null, Array.prototype.slice.call(arguments, 1));
  }

  var life = siyuan.plugin.lifecycle;
  await siyuan.storage.put("delivered/legacy.json", '{"schemaVersion":1,"keys":{}}');
  await life.onload();
  await life.onrunning();

  check("binds all RPC methods", __mock.rpc.size === 19, Array.from(__mock.rpc.keys()));

  check("copies legacy data into the local workspace file", __mock.records.has("delivered/legacy.json") && __mock.storage.has("delivered/legacy.json"));
  var empty = await call("snapshot");
  check("empty snapshot", empty.subscriptions.length === 0 && empty.settings.notifyAt === "09:00", empty);

  var settings = await call("updateSettings", { notifyAt: "00:00" });
  check("settings saved", settings.notifyAt === "00:00" && __mock.storage.has("settings-v2.json") && !__mock.records.has("settings.json"));

  var input = {
    name: "Netflix",
    status: "active",
    price: { amount: 1599, currency: "USD" },
    cycle: { unit: "month", every: 1 },
    anchorDate: localDate(3),
  };
  __mock.broadcasts.length = 0;
  var created = await call("createSubscription", input);
  check("create returns record", typeof created.id === "string" && created.name === "Netflix", created);
  check("one file per subscription", __mock.records.has("subscriptions/" + created.id + ".json"));
  check("broadcasts changed", __mock.broadcasts.some((b) => b.method === "changed"));
  check("hlc uses device id", /-8d2fABC123device$/.test(created.updatedAt), created.updatedAt);

  var settled = await call("snapshot");
  check("new subscription already in its window is treated as kept", settled.decisions.length === 1 && settled.decisions[0].choice === "keep", settled.decisions);
  await call("undoDecision", created.id, localDate(3)); // bring the reminder back for the rest of the scenario
  var pending = await call("pendingReminders");
  check("reminder due 3 days ahead", pending.length === 1 && pending[0].threshold === 3 && pending[0].daysLeft === 3, pending);

  await sleep(50); // let the tick scheduled after the edit run
  var due = __mock.broadcasts.filter((b) => b.method === "reminders-due");
  check("tick broadcasts reminders-due once", due.length === 1 && due[0].params.reminders.length === 1, due);

  var trialSub = await call("createSubscription", Object.assign({}, input, { name: "Trial", anchorDate: localDate(1), trialEndsOn: localDate(1) }));
  var afterTrial = await call("snapshot");
  var trialDelivered = JSON.parse(__mock.records.get("delivered/8d2fABC123device.json")).keys;
  check("new trial isn't auto-kept but won't pop up", !afterTrial.decisions.some((d) => d.subscriptionId === trialSub.id) && trialDelivered[trialSub.id + ":" + localDate(1) + ":t1"], afterTrial.decisions);
  await call("deleteSubscription", trialSub.id);

  var key = pending[0].key;
  var results = await Promise.all([call("claimReminders", [key]), call("claimReminders", [key])]);
  check("exactly one window wins the claim", results[0].length + results[1].length === 1, results);
  check("delivery recorded per device", __mock.records.has("delivered/8d2fABC123device.json"));
  check("claimed reminder no longer pending", (await call("pendingReminders")).length === 0);

  var error = null;
  try {
    await call("createSubscription", Object.assign({}, input, { anchorDate: "2026-02-30" }));
  } catch (e) {
    error = String(e && e.message ? e.message : e);
  }
  check("validation errors are JSON", error !== null && error.indexOf('"kind":"validation"') >= 0, error);

  // --- decisions ---
  var charge = pending[0].chargeDate;
  var snoozed = await call("decide", created.id, charge, "snooze", localDate(1));
  check("snooze recorded", snoozed.decision.choice === "snooze" && __mock.records.has("decisions/" + created.id + "_" + charge + ".json"), snoozed);
  check("snapshot carries decisions", (await call("snapshot")).decisions.length === 1);

  var cancelled = await call("decide", created.id, charge, "cancel");
  check("cancel ends the subscription the day before the charge", cancelled.subscription.status === "cancelled" && cancelled.subscription.endDate === localDate(2), cancelled.subscription);
  check("one decision file per charge", (await call("snapshot")).decisions.length === 1);

  var restored = await call("undoDecision", created.id, charge, Object.assign({}, input));
  var afterUndo = await call("snapshot");
  check("undo restores subscription and clears decision", restored.status === "active" && afterUndo.decisions.length === 0, afterUndo);

  var bad = null;
  try {
    await call("decide", created.id, charge, "maybe");
  } catch (e) {
    bad = String(e.message);
  }
  check("invalid choice rejected", bad !== null && bad.indexOf("choice must be") >= 0, bad);

  // --- changes from RxDB go through the kernel, independently of old JSON ---
  var mirror = await call("syncRecords");
  var localRecord = mirror.records.find((r) => r.payload.id === created.id);
  check("sync reads live records and decision tombstones", localRecord.payload.name === "Netflix" && mirror.records.some((r) => r.id.indexOf("decision:") === 0 && r.payload.deletedAt), mirror);
  var foreign = Object.assign({}, localRecord.payload, { name: "Edited on phone", updatedAt: localRecord.version.replace(/-[^-]+$/, "-zzz") });
  await siyuan.storage.put("subscriptions/" + created.id + ".json", JSON.stringify(Object.assign({}, foreign, { name: "From old SiYuan sync" })));
  check("old SiYuan files cannot replace local records", (await call("snapshot")).subscriptions[0].name === "Netflix");
  __mock.broadcasts.length = 0;
  await call("applySyncRecords", [{ id: localRecord.id, version: foreign.updatedAt, payload: foreign }]);
  check("remote record updates the kernel and broadcasts", (await call("snapshot")).subscriptions[0].name === "Edited on phone" && __mock.broadcasts.some((b) => b.method === "changed"));
  var stale = await call("applySyncRecords", [localRecord]);
  check("stale remote updates do not overwrite newer kernel data", stale.skipped === 1 && (await call("snapshot")).subscriptions[0].name === "Edited on phone");

  // --- exchange rates through the forward proxy ---
  var rates = await call("refreshRates");
  check("rates fetched via forwardProxy", rates && rates.rates.CNY === 7.2 && __mock.proxied[0].url.indexOf("open.er-api.com") >= 0, rates);
  check("snapshot carries rates", (await call("snapshot")).rates.base === "USD");

  // --- push channels ---
  var device = await call("deviceInfo");
  check("device info", device.deviceId === "8d2fABC123device", device);
  var test = await call("testChannel", { id: "t1", kind: "ntfy", name: "Phone", config: { topic: "still-test" } });
  check("test push goes through forwardProxy", test.ok && __mock.proxied.some((p) => p.url === "https://ntfy.sh" && p.payload.topic === "still-test"), test);
  var failing = await call("testChannel", { id: "t2", kind: "webhook", config: { url: "https://fail.example/hook" } });
  check("failed test push reports status", failing.ok === false && failing.status === 500, failing);
  var privateChannel = { id: "private-test", kind: "telegram", config: { botToken: "123456789:dummy-private-bot-token", chatId: "12345" } };
  __mock.proxyFailure = function (req, reply) {
    return reply({ code: -1, msg: "failed to POST " + req.url });
  };
  var proxyFailure = await call("testChannel", privateChannel);
  check("proxy errors omit credential-bearing URLs", !proxyFailure.ok && proxyFailure.status === 0 && proxyFailure.error === "Push request failed", proxyFailure);
  __mock.proxyFailure = function (req, reply) {
    return reply({ code: 0, data: { status: 401, body: "rejected " + req.url + " token=" + privateChannel.config.botToken } });
  };
  var providerFailure = await call("testChannel", privateChannel);
  check("provider errors omit echoed credentials", !providerFailure.ok && providerFailure.status === 401 && providerFailure.error === "Push request failed (HTTP 401)", providerFailure);
  __mock.proxyFailure = function (req) {
    throw new Error("transport failed: " + req.url);
  };
  var transportFailure = await call("testChannel", privateChannel);
  check("transport errors omit credentials", !transportFailure.ok && transportFailure.status === 0 && transportFailure.error === "Push request failed", transportFailure);
  delete __mock.proxyFailure;
  var badChannel = null;
  try {
    await call("testChannel", { id: "t3", kind: "telegram", config: {} });
  } catch (e) {
    badChannel = String(e.message);
  }
  check("invalid channel config rejected", badChannel !== null && badChannel.indexOf("botToken is required") >= 0, badChannel);

  var reminderSub = await call("createSubscription", Object.assign({}, input, { name: "Pushy", anchorDate: localDate(1) }));
  // Created inside its window it's auto-kept; withdraw that so it reminds, and a window shows it first — push must still go out.
  await call("undoDecision", reminderSub.id, localDate(1));
  await call("claimReminders", [reminderSub.id + ":" + localDate(1) + ":t1"]);
  __mock.proxied.length = 0;
  await call("saveNotifications", {
    channels: [{ id: "n1", kind: "ntfy", name: "Phone", enabled: true, config: { topic: "still" } }],
    sender: device.deviceId,
    journal: { enabled: true, notebookId: "20260101000000-nb00001" },
  });
  await sleep(300);
  var pushyPushes = () => __mock.proxied.filter((p) => p.url === "https://ntfy.sh" && p.payload.title.indexOf("Pushy") >= 0);
  check("due reminder pushed even though a window already showed it", pushyPushes().length === 1, __mock.proxied);
  check("push recorded in delivery log", JSON.parse(__mock.records.get("delivered/8d2fABC123device.json")).keys["push|" + reminderSub.id + ":" + localDate(1) + ":t1"]);
  await call("updateSettings", { notifyAt: "00:00" }); // triggers another tick
  await sleep(300);
  check("no duplicate push on later ticks", pushyPushes().length === 1, __mock.proxied);
  await call("saveNotifications", { channels: [{ id: "n1", kind: "ntfy", name: "Phone", enabled: true, config: { topic: "still" } }], sender: "someOtherDevice", journal: { enabled: false, notebookId: null } });
  check("notebooks list skips closed ones", (await call("listNotebooks")).length === 1);
  await call("decide", reminderSub.id, localDate(1), "cancel");
  await sleep(100);
  check("journal entry written for cancellation only when enabled", !(__mock.journal || []).some((j) => j.data.indexOf("Pushy") >= 0));
  await call("deleteSubscription", reminderSub.id);

  // --- AI agent tool ---
  var cap = __mock.capabilities && __mock.capabilities.subscriptions;
  check("agent capability registered", !!cap && cap.config.effects.localRead === true, cap && cap.config);
  var answer = cap && (await cap.handler({ withinDays: 400 }));
  check("agent capability answers from live data", answer && answer.upcoming.some((u) => u.name === "Edited on phone") && answer.monthlyTotals.USD === "$15.99", answer);

  // --- backup round trip ---
  var backup = await call("exportData");
  check("export includes subscriptions and settings", backup.app === "still" && backup.subscriptions.length === 1 && backup.settings.notifyAt === "00:00", backup);
  var older = JSON.parse(JSON.stringify(backup));
  older.subscriptions[0].name = "Old name";
  older.subscriptions[0].updatedAt = "000000001-0000-old";
  var newcomer = Object.assign({}, backup.subscriptions[0], { id: "11111111-2222-4333-8444-555555555555", name: "Imported", updatedAt: "zzzzzzzzz-0000-other" });
  older.subscriptions.push(newcomer);
  var imported = await call("importData", older);
  var afterImport = await call("snapshot");
  check("import keeps newer local edits and adds new records", imported.subscriptions === 1 && afterImport.subscriptions.length === 2 && afterImport.subscriptions.some((s) => s.name === "Edited on phone"), { imported: imported, names: afterImport.subscriptions.map((s) => s.name) });
  var badImport = null;
  try {
    await call("importData", { hello: 1 });
  } catch (e) {
    badImport = String(e.message);
  }
  check("import rejects non-backups", badImport !== null && badImport.indexOf("not a Still backup") >= 0, badImport);
  await call("deleteSubscription", newcomer.id);

  var updated = await call("updateSubscription", created.id, Object.assign({}, input, { name: "Netflix Premium" }));
  check("update bumps hlc", updated.updatedAt > created.updatedAt && updated.name === "Netflix Premium");

  await call("deleteSubscription", created.id);
  var after = await call("snapshot");
  var tomb = JSON.parse(__mock.records.get("subscriptions/" + created.id + ".json"));
  check("delete leaves a tombstone", after.subscriptions.length === 0 && !!tomb.deletedAt, tomb);

  var notFound = null;
  try {
    await call("deleteSubscription", created.id);
  } catch (e) {
    notFound = String(e.message);
  }
  check("deleting twice reports not-found", notFound !== null && notFound.indexOf("not-found") >= 0, notFound);

  await life.onunload();
  await life.onload();
  var reopened = await call("syncRecords");
  check("restart preserves workspace ID and tombstones", reopened.workspaceId === mirror.workspaceId && reopened.records.some((r) => r.id === localRecord.id && r.payload.deletedAt));
  await life.onunload();
  check("no warnings or errors logged", __mock.logs.filter((l) => l[0] === "warn" || l[0] === "error").length === 0, __mock.logs);

  console.log(failures === 0 ? "kernel scenario passed" : failures + " check(s) failed");
  __finish(failures === 0 ? 0 : 1);
})().catch(function (e) {
  console.log("FAIL uncaught: " + (e && e.stack ? e.stack : e));
  __finish(1);
});
