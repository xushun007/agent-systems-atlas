const crashPoints = [
  "before-effect",
  "after-effect-before-finish",
  "after-finish",
];

function createRuntime() {
  return {
    events: [],
    effects: new Map(),
    state: new Map(),
  };
}

function append(runtime, kind, payload = {}) {
  runtime.events.push({
    event_id: `event-${runtime.events.length + 1}`,
    kind,
    ...payload,
  });
}

function execute(runtime, callId, crashPoint) {
  append(runtime, "ToolCallAccepted", { call_id: callId });
  runtime.state.set(callId, "accepted");

  if (crashPoint === "before-effect") {
    return;
  }

  append(runtime, "ExecutionStarted", { call_id: callId });
  runtime.state.set(callId, "running");
  runtime.effects.set(callId, { path: "workspace/result.txt", content: "done" });

  if (crashPoint === "after-effect-before-finish") {
    return;
  }

  append(runtime, "ExecutionFinished", { call_id: callId, outcome: "completed" });
  runtime.state.set(callId, "completed");
}

function recover(runtime, callId) {
  const state = runtime.state.get(callId);
  const effect = runtime.effects.get(callId);

  if (state === "completed") {
    append(runtime, "RecoveryDecision", { call_id: callId, decision: "reuse-completed" });
    return "completed";
  }

  if (effect) {
    append(runtime, "RecoveryDecision", { call_id: callId, decision: "reconcile-effect" });
    append(runtime, "ExecutionReconciled", { call_id: callId, outcome: "completed" });
    runtime.state.set(callId, "reconciled");
    return "reconciled";
  }

  append(runtime, "RecoveryDecision", { call_id: callId, decision: "retryable" });
  runtime.state.set(callId, "retryable");
  return "retryable";
}

for (const crashPoint of crashPoints) {
  const runtime = createRuntime();
  const callId = `call-${crashPoint}`;
  execute(runtime, callId, crashPoint);
  const stateBeforeRecovery = runtime.state.get(callId) ?? "none";
  const effectCountBeforeRecovery = runtime.effects.size;
  const recoveredState = recover(runtime, callId);
  const effectCountAfterRecovery = runtime.effects.size;
  const recoveryEvents = runtime.events.filter((event) => event.kind === "RecoveryDecision").length;

  if (crashPoint === "before-effect" && recoveredState !== "retryable") {
    throw new Error(`${crashPoint}: expected retryable, got ${recoveredState}`);
  }
  if (crashPoint === "after-effect-before-finish" && recoveredState !== "reconciled") {
    throw new Error(`${crashPoint}: expected reconciled, got ${recoveredState}`);
  }
  if (crashPoint === "after-effect-before-finish" && effectCountAfterRecovery !== effectCountBeforeRecovery) {
    throw new Error(`${crashPoint}: recovery duplicated the effect`);
  }
  if (recoveryEvents !== 1) {
    throw new Error(`${crashPoint}: expected one recovery decision`);
  }

  console.log(JSON.stringify({
    crash_point: crashPoint,
    state_before_recovery: stateBeforeRecovery,
    recovered_state: recoveredState,
    effects_before_recovery: effectCountBeforeRecovery,
    effects_after_recovery: effectCountAfterRecovery,
    recovery_decisions: recoveryEvents,
  }));
}
