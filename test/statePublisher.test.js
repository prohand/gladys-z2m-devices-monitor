import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatePublisher } from '../src/statePublisher.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { createClock } from './helpers/z2mFixtures.js';

/**
 * Build a publisher wired to a fake Gladys and a hand-driven clock.
 * @param {object} [options] - Options.
 * @param {number} [options.refreshMs] - Republish delay for unchanged values.
 * @param {boolean} [options.failPublishStates] - Make the host API reject.
 * @returns {{publisher: StatePublisher, gladys: object, clock: object}} The publisher and its dependencies.
 */
function createPublisher({ refreshMs = 30 * 60 * 1000, failPublishStates = false } = {}) {
  const clock = createClock();
  const gladys = createFakeGladys({ failPublishStates });
  const publisher = new StatePublisher({ gladys, refreshMs, now: clock.now });
  return { publisher, gladys, clock };
}

const state = (id, value, minIntervalMs) => ({
  device_feature_external_id: id,
  state: value,
  minIntervalMs,
});

const textState = (id, text, minIntervalMs) => ({
  device_feature_external_id: id,
  text,
  minIntervalMs,
});

test('the first publish sends everything', async () => {
  const { publisher, gladys } = createPublisher();
  assert.equal(await publisher.publish([state('a', 1), state('b', 0)]), 2);
  assert.equal(gladys.published.length, 2);
});

test('an unchanged value is not published again', async () => {
  const { publisher, gladys } = createPublisher();
  await publisher.publish([state('a', 1)]);
  assert.equal(await publisher.publish([state('a', 1)]), 0);
  assert.equal(gladys.published.length, 1);
});

test('a changed value is published immediately when it carries no minimum interval', async () => {
  const { publisher } = createPublisher();
  await publisher.publish([state('a', 1)]);
  assert.equal(await publisher.publish([state('a', 0)]), 1);
});

// The gauges (silence, link quality) move on their own every minute: without
// this, a large network would spend its whole 300 states/minute budget on them.
test('a throttled gauge is held back until its minimum interval elapsed', async () => {
  const { publisher, clock } = createPublisher();
  const throttle = 5 * 60 * 1000;
  await publisher.publish([state('silence', 0, throttle)]);

  clock.advanceMinutes(1);
  assert.equal(await publisher.publish([state('silence', 1, throttle)]), 0);

  clock.advanceMinutes(5);
  assert.equal(await publisher.publish([state('silence', 6, throttle)]), 1);
});

test('an unchanged value is refreshed once in a while so a screen is never blank', async () => {
  const { publisher, clock } = createPublisher({ refreshMs: 30 * 60 * 1000 });
  await publisher.publish([state('a', 1)]);

  clock.advanceMinutes(29);
  assert.equal(await publisher.publish([state('a', 1)]), 0);

  clock.advanceMinutes(2);
  assert.equal(await publisher.publish([state('a', 1)]), 1);
});

test('text states are compared on their text', async () => {
  const { publisher } = createPublisher();
  await publisher.publish([textState('names', 'office plug')]);
  assert.equal(await publisher.publish([textState('names', 'office plug')]), 0);
  assert.equal(await publisher.publish([textState('names', 'office plug, hall')]), 1);
});

// The host API takes a numeric `state` or a string `text`, never a wrapper
// object — and it rejects the WHOLE batch on the first offender, so a mangled
// text state would take the states of the entire network down with it.
test('a text state reaches the host API in its own text field', async () => {
  const { publisher, gladys } = createPublisher();
  await publisher.publish([state('a', 1), textState('names', 'office plug')]);
  assert.deepEqual(gladys.batches[0], [
    { device_feature_external_id: 'a', state: 1 },
    { device_feature_external_id: 'names', text: 'office plug' },
  ]);
});

test('batches are chunked to the 100 states the host API accepts', async () => {
  const { publisher, gladys } = createPublisher();
  const states = Array.from({ length: 250 }, (_, index) => state(`feature-${index}`, index));
  assert.equal(await publisher.publish(states), 250);
  assert.deepEqual(
    gladys.batches.map((batch) => batch.length),
    [100, 100, 50],
  );
});

test('the publishing hints never reach the host API', async () => {
  const { publisher, gladys } = createPublisher();
  await publisher.publish([state('a', 1, 60_000)]);
  assert.deepEqual(gladys.batches[0], [{ device_feature_external_id: 'a', state: 1 }]);
});

// A failed batch must be retried, not silently considered published.
test('a rejected batch is not remembered as published', async () => {
  const { publisher } = createPublisher({ failPublishStates: true });
  await assert.rejects(() => publisher.publish([state('a', 1)]));
  assert.equal(publisher.selectChanged([state('a', 1)]).length, 1);
});

test('reset forgets everything so a reconnection pushes the full picture', async () => {
  const { publisher } = createPublisher();
  await publisher.publish([state('a', 1)]);
  publisher.reset();
  assert.equal(await publisher.publish([state('a', 1)]), 1);
});

// Everything published before the user pressed "Add" in the Discovery screen was
// dropped by Gladys: the feature did not exist yet. Without forgetting it, the
// new device stays blank until the periodic refresh, half an hour later.
test('forgetDevice republishes a device the user just created, and nothing else', async () => {
  const { publisher, gladys } = createPublisher();
  const plug = 'ext:z2m:device:0xplug';
  const other = 'ext:z2m:device:0xother';
  await publisher.publish([
    state(`${plug}:alive`, 1),
    state(`${plug}:silence`, 0),
    state(`${other}:alive`, 1),
  ]);

  publisher.forgetDevice(plug);
  const republished = await publisher.publish([
    state(`${plug}:alive`, 1),
    state(`${plug}:silence`, 0),
    state(`${other}:alive`, 1),
  ]);

  assert.equal(republished, 2);
  assert.deepEqual(
    gladys.batches[1].map((published) => published.device_feature_external_id),
    [`${plug}:alive`, `${plug}:silence`],
  );
});

// A device external id is a prefix of its feature ids, but it is also a prefix
// of the ids of any device whose id merely starts the same way.
test('forgetDevice leaves a device with a similar external id alone', async () => {
  const { publisher } = createPublisher();
  await publisher.publish([
    state('ext:z2m:device:0x01:alive', 1),
    state('ext:z2m:device:0x011:alive', 1),
  ]);

  publisher.forgetDevice('ext:z2m:device:0x01');
  assert.equal(
    await publisher.publish([
      state('ext:z2m:device:0x01:alive', 1),
      state('ext:z2m:device:0x011:alive', 1),
    ]),
    1,
  );
});

test('forgetDevice ignores a device published without an external id', async () => {
  const { publisher } = createPublisher();
  await publisher.publish([state('a', 1)]);
  publisher.forgetDevice(undefined);
  assert.equal(await publisher.publish([state('a', 1)]), 0);
});
