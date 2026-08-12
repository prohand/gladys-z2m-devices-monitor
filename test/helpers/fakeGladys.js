// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the integration relies on, so the whole
// decision logic can be tested without a running Gladys server, a WebSocket or
// an MQTT broker.
// -----------------------------------------------------------------------------

export function createFakeGladys({ failPublishStates = false } = {}) {
  const published = [];
  const batches = [];
  const discovered = [];
  const connectionStatuses = [];

  return {
    published,
    batches,
    discovered,
    connectionStatuses,

    externalIds(type, platformId) {
      const device = `ext:z2m-devices-monitor:${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishDiscoveredDevices(devices) {
      discovered.push(devices);
      return { success: true };
    },

    async publishState(featureExternalId, state) {
      published.push({ featureExternalId, state });
      return { success: true };
    },

    async publishStates(states) {
      if (failPublishStates) {
        throw new Error('publishStates failed');
      }
      // The host API validates the whole batch BEFORE saving any of it, so a
      // single malformed state silently costs the network its entire update.
      // Reproducing that check here is what makes every other test a guard.
      states.forEach((state, index) => {
        const hasState = typeof state.state === 'number' && Number.isFinite(state.state);
        const hasText = typeof state.text === 'string';
        if (!hasState && !hasText) {
          throw new Error(`states[${index}]: must have a numeric "state" or a string "text"`);
        }
      });
      batches.push(states);
      for (const state of states) {
        published.push({
          featureExternalId: state.device_feature_external_id,
          state: state.state,
          text: state.text,
        });
      }
      return { success: true };
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
      return { success: true };
    },
  };
}
