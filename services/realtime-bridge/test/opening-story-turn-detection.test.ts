import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENING_STORY_TURN_DEBOUNCE_MS,
  OpeningStoryTurnController,
} from "../src/bridge/opening-story-turn.js";
import { buildRealtimeSessionUpdate } from "../src/openai/realtime-session.js";

test("brief pause during opening story does not trigger assistant response", async () => {
  const controller = new OpeningStoryTurnController();
  const ready: string[] = [];

  controller.beginAwaitingStory();
  controller.noteTranscript("We had hail damage", (transcript) => {
    ready.push(transcript);
  });

  await new Promise((resolve) => setTimeout(resolve, OPENING_STORY_TURN_DEBOUNCE_MS - 200));
  assert.equal(ready.length, 0);
});

test("longer completed pause does trigger opening story processing", async () => {
  const controller = new OpeningStoryTurnController();
  const ready: string[] = [];

  controller.beginAwaitingStory();
  controller.noteTranscript("We had hail damage on the roof", (transcript) => {
    ready.push(transcript);
  });

  await new Promise((resolve) => setTimeout(resolve, OPENING_STORY_TURN_DEBOUNCE_MS + 50));
  assert.deepEqual(ready, ["We had hail damage on the roof"]);
  assert.equal(controller.isAwaitingStory(), false);
});

test("caller speech continuing after a pause prevents interruption", async () => {
  const controller = new OpeningStoryTurnController();
  const ready: string[] = [];

  controller.beginAwaitingStory();
  controller.noteTranscript("We had hail damage", (transcript) => {
    ready.push(transcript);
  });

  await new Promise((resolve) => setTimeout(resolve, OPENING_STORY_TURN_DEBOUNCE_MS - 100));
  controller.onCallerSpeechStarted();
  await new Promise((resolve) => setTimeout(resolve, OPENING_STORY_TURN_DEBOUNCE_MS + 50));

  assert.equal(ready.length, 0);
  assert.equal(controller.isCallerSpeechActive(), true);
});

test("adaptive follow-up turns use normal responsive silence threshold", () => {
  const config = {
    turnDetectionSilenceDurationMs: 600,
    openingStorySilenceDurationMs: 1800,
  } as import("../src/config.js").BridgeConfig;

  const normal = buildRealtimeSessionUpdate("cedar", config);
  const openingStory = buildRealtimeSessionUpdate("cedar", config, {
    openingStoryMode: true,
  });

  const normalSilence = (
    normal.session as { audio?: { input?: { turn_detection?: { silence_duration_ms?: number } } } }
  ).audio?.input?.turn_detection?.silence_duration_ms;
  const storySilence = (
    openingStory.session as {
      audio?: { input?: { turn_detection?: { silence_duration_ms?: number } } };
    }
  ).audio?.input?.turn_detection?.silence_duration_ms;

  assert.equal(normalSilence, 600);
  assert.equal(storySilence, 1800);
});

test("opening story turn is inactive outside awaiting_story mode", () => {
  const controller = new OpeningStoryTurnController();
  const ready: string[] = [];

  controller.noteTranscript("Immediate intake answer", (transcript) => {
    ready.push(transcript);
  });

  assert.deepEqual(ready, ["Immediate intake answer"]);
});
