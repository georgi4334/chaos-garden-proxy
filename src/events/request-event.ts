/**
 * One proxied request, as published to the Redis Stream for the ingest
 * service. This is a contract between services: add optional fields freely,
 * but changing or removing a field needs a new version number.
 */
export interface RequestEventV1 {
  v: 1;
  /** Unique per request; the ingest service uses it to ignore duplicates. */
  id: string;
  /** When the request arrived, ISO 8601. */
  at: string;
  gardenId: string;
  targetId: string;
  targetName: string;
  method: string;
  /** Path on the target, without the query string (which can carry secrets). */
  path: string;
  /** Status sent to the client, or null when no response was sent. */
  status: number | null;
  /** False when the connection closed before the response finished. */
  completed: boolean;
  durationMs: number;
  /** Faults applied, in order: latency, error, drop, corrupt. */
  faults: string[];
  /** Ids of the rules that fired. */
  ruleIds: string[];
}

export const MAX_EVENT_PATH_LENGTH = 512;
