/**
 * Deterministic envelope seams (design T-009 §2.3): the clock and the
 * event-id source are injected so tests are fully deterministic. Internal
 * helper — not part of the §2 public surface.
 */

import type { IsoTimestamp } from '@core';

export interface EventSeams {
  now: () => IsoTimestamp;
  new_event_id: () => string;
}
