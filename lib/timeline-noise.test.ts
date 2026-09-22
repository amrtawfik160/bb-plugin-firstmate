import assert from "node:assert/strict";
import test from "node:test";
import {
  FIRSTMATE_ATTENTION_MARKER,
  FIRSTMATE_ROUTINE_MARKER,
  captainTimelineNoiseDecision,
  firstmateTimelineNoiseDecision,
  isRoutineReasoningRow,
} from "./timeline-noise.ts";

test("captain timeline hides pending and successful Firstmate tools", () => {
  assert.equal(firstmateTimelineNoiseDecision("firstmate_bearings {}"), "hide");
  assert.equal(firstmateTimelineNoiseDecision(`fleet digest${FIRSTMATE_ROUTINE_MARKER}`), "hide");
});

test("captain timeline keeps failures and unrelated rows", () => {
  assert.equal(
    firstmateTimelineNoiseDecision(`No crew found${FIRSTMATE_ATTENTION_MARKER}`),
    "show",
  );
  assert.equal(firstmateTimelineNoiseDecision("firstmate_merge failed"), "show");
  assert.equal(firstmateTimelineNoiseDecision("Asked the captain for approval"), "unrelated");
});

test("captain panes hide generic expandable work but keep material states", () => {
  assert.equal(captainTimelineNoiseDecision("Ran shell command", true), "hide");
  assert.equal(captainTimelineNoiseDecision("Thought for 4s", true), "hide");
  assert.equal(captainTimelineNoiseDecision("Command failed", true), "show");
  assert.equal(captainTimelineNoiseDecision("Need approval", true), "show");
  assert.equal(captainTimelineNoiseDecision("Assistant outcome", false), "unrelated");
});

test("captain timeline hides internal crew wakes, including old visible rows", () => {
  assert.equal(
    captainTimelineNoiseDecision(
      "🔔 🚧 crew 89ac9c48 blocked — BLOCKED: build exhausted memory",
      false,
    ),
    "hide",
  );
  assert.equal(captainTimelineNoiseDecision("🛰️ fm-watch:\nstale: crew wedged", false), "hide");
  assert.equal(captainTimelineNoiseDecision("FIRSTMATE INTERNAL WAKE — hidden", false), "hide");
});

test("recognizes BB reasoning labels without matching normal messages", () => {
  assert.equal(isRoutineReasoningRow("Thinking"), true);
  assert.equal(isRoutineReasoningRow("Thought for 4s"), true);
  assert.equal(isRoutineReasoningRow("I thought about the risk."), false);
  assert.equal(isRoutineReasoningRow("Thoughtful outcome"), false);
});
