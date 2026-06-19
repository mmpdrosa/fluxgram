export type FlowStatus = "running" | "waiting" | "timer" | "done";

export interface Frame {
  returnPath: number[];
  store: Record<string, unknown>;
  storeResult?: string;
}

export interface Waiting {
  kind: "reply" | "button" | "either";
  promptMessageId?: number;
  cbToken?: string;
  /** only this user's replies/clicks answer the prompt (onlyFrom) */
  fromUserId?: number;
  multiSelect?: { selected: unknown[] };
  /** per-instance button relabels from FlowHandle.editButtonText, keyed by childIndex */
  buttonLabels?: Record<string, string>;
}

/** The only durable conversation artifact. Must stay plain JSON. */
export interface FlowStateDoc {
  id: string;
  botId: number;
  rev: number;
  flowName: string;
  version: number;
  treeHash: string;
  chatId: number;
  status: FlowStatus;
  path: number[];
  frames: Frame[];
  store: Record<string, unknown>;
  waiting: Waiting | null;
  wakeAt?: number;
  /** absolute deadline for an in-flight waitFor (survives re-arming) */
  timerDeadline?: number;
  savedCC: Record<string, { path: number[]; frames: Frame[] }>;
  /**
   * Structural hash of dynamic-step subtrees, keyed by path prefix joined
   * with "." (dynamic-step contract).
   */
  dynamicHashes?: Record<string, string>;
  meta: {
    startedAt: number;
    updatedAt: number;
    startMessageId?: number;
    /** user who sent the start message (for onlyFrom: "initiator") */
    fromUserId?: number;
    lastMessage?: object;
    lastBotMessage?: object;
  };
}
