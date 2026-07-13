// @ts-check

/**
 * Deterministic in-memory transport + virtual clock for PeerMesh protocol
 * tests. Every message, connection-open, and disconnect flows through a
 * central event queue; nothing is delivered until the test (or
 * runToQuiescence) says so. This makes race conditions reproducible:
 * - per-link FIFO is preserved (matching ordered SCTP data channels)
 * - cross-link interleaving is deterministic (global FIFO, or seeded random)
 * - faults are injectable: dropWhere / holdWhere / severLink
 * - timers (relay timeout, anti-entropy, prune grace) run on a virtual clock
 * - every scheduling decision is recorded in `trace` for debugging
 *
 * @import {MeshTransport, MeshConnection, MeshClock} from "../src/app/mesh.js"
 * @import {ConnectionCallbacks} from "../src/app/peer-connection.js"
 */

/**
 * Seeded PRNG (mulberry32) — same seed, same schedule, same bug.
 * @param {number} seed
 * @returns {() => number} function returning floats in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Virtual clock implementing the MeshClock interface. Time only moves when
 * the test advances it (via FakeNetwork.advanceTime).
 */
export class FakeClock {
  /** @type {Map<number, {due: number, fn: () => void, interval: number | null}>} */
  #timers = new Map();
  #now = 0;
  #nextId = 1;

  /** @type {MeshClock['now']} */
  now = () => this.#now;

  /** @type {MeshClock['setTimeout']} */
  setTimeout = (fn, ms) => {
    const id = this.#nextId++;
    this.#timers.set(id, { due: this.#now + ms, fn, interval: null });
    return id;
  };

  /** @type {MeshClock['clearTimeout']} */
  clearTimeout = (id) => {
    this.#timers.delete(id);
  };

  /** @type {MeshClock['setInterval']} */
  setInterval = (fn, ms) => {
    const id = this.#nextId++;
    this.#timers.set(id, { due: this.#now + ms, fn, interval: ms });
    return id;
  };

  /** @type {MeshClock['clearInterval']} */
  clearInterval = (id) => {
    this.#timers.delete(id);
  };

  /**
   * Fire the earliest timer due at or before `limit` (advancing #now to its
   * due time). Returns false if no timer is due.
   * @param {number} limit
   * @returns {boolean}
   */
  fireNextDue(limit) {
    /** @type {number | null} */
    let bestId = null;
    let bestDue = Infinity;
    for (const [id, t] of this.#timers) {
      if (t.due <= limit && t.due < bestDue) {
        bestDue = t.due;
        bestId = id;
      }
    }
    if (bestId === null) return false;
    const t = this.#timers.get(bestId);
    if (!t) return false;
    this.#now = Math.max(this.#now, t.due);
    if (t.interval !== null) {
      t.due = this.#now + t.interval;
    } else {
      this.#timers.delete(bestId);
    }
    t.fn();
    return true;
  }

  /** @param {number} t */
  advanceTo(t) {
    this.#now = Math.max(this.#now, t);
  }
}

/**
 * A queued network event. `type`/`entryId` are pre-extracted from the message
 * JSON so fault-injection predicates stay simple and typed.
 * @typedef {Object} NetEvent
 * @property {string} from
 * @property {string} to
 * @property {'message' | 'open' | 'close'} kind
 * @property {string} [type] - message.type (kind 'message' only)
 * @property {string} [entryId] - entry.id for TOPOLOGY_UPDATE messages
 * @property {() => void} deliver
 */

/** @typedef {(e: NetEvent) => boolean} EventPredicate */

/** @param {NetEvent} e */
function fmtEvent(e) {
  const extra = e.type !== undefined ? ` ${e.type}${e.entryId !== undefined ? `(${e.entryId})` : ''}` : '';
  return `${e.from}→${e.to} ${e.kind}${extra}`;
}

/**
 * One direction of a fake link. Implements the MeshConnection surface.
 */
class FakeConnection {
  closed = false;

  /** @type {FakeConnection | null} */
  peer = null;

  /**
   * @param {FakeNetwork} net
   * @param {string} localId
   * @param {string} remoteId
   * @param {ConnectionCallbacks} callbacks
   */
  constructor(net, localId, remoteId, callbacks) {
    this.net = net;
    this.localId = localId;
    this.remoteId = remoteId;
    this.callbacks = callbacks;
  }

  /** @param {string} data */
  sendData(data) {
    if (this.closed || this.peer === null || this.peer.closed) return false;
    this.net.enqueueMessage(this, data);
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.net.enqueueClose(this);
    // The local 'close' event also fires onDisconnected (as the real data
    // channel does); deliver it async like the browser would.
    queueMicrotask(() => this.callbacks.onDisconnected?.());
  }

  /** @param {MediaStreamTrack[]} _tracks */
  addLocalTracks(_tracks) {}

  /** @param {MediaStreamTrack} _newTrack @returns {Promise<void>} */
  async replaceTrack(_newTrack) {}

  /** @param {'video' | 'audio'} _kind @returns {Promise<void>} */
  async removeTrack(_kind) {}
}

export class FakeNetwork {
  clock = new FakeClock();

  /** Log of every scheduling decision (DELIVER / DROP / HOLD / RELEASE). @type {string[]} */
  trace = [];

  /** All connections ever created (both directions). @type {FakeConnection[]} */
  connections = [];

  /** @type {NetEvent[]} */
  #queue = [];

  /** @type {{match: EventPredicate, once: boolean}[]} */
  #drops = [];

  /** @type {{match: EventPredicate | null, once: boolean, held: NetEvent[]}[]} */
  #holds = [];

  /** @type {(() => number) | null} */
  #rng = null;

  #seq = 0;

  /** "sdp" token → pending offer/answer records */
  /** @type {Map<string, {nodeId: string, callbacks: ConnectionCallbacks, cancelled: boolean}>} */
  #offers = new Map();
  /** @type {Map<string, {nodeId: string, callbacks: ConnectionCallbacks, resolveConnect: (c: MeshConnection) => void}>} */
  #answers = new Map();

  /**
   * @param {{seed?: number}} [opts] - pass a seed for random (but reproducible)
   *   cross-link interleaving; omit for deterministic global-FIFO delivery
   */
  constructor(opts) {
    this.#rng = opts?.seed !== undefined ? mulberry32(opts.seed) : null;
  }

  /**
   * A MeshTransport whose "SDP" tokens are just registry keys and whose
   * connections deliver through this network's scheduler.
   * @param {string} nodeId
   * @returns {MeshTransport}
   */
  transportFor(nodeId) {
    return {
      startOffer: async (callbacks = {}, _rtcConfig = undefined, _tracks = []) => {
        const token = `fake-offer:${nodeId}:${this.#seq++}`;
        const offer = { nodeId, callbacks, cancelled: false };
        this.#offers.set(token, offer);
        return {
          offerSdp: token,
          acceptAnswer: async (/** @type {string} */ answerSdp) => {
            if (offer.cancelled) throw new Error('FakeNetwork: offer was cancelled');
            const answer = this.#answers.get(answerSdp);
            if (!answer) throw new Error(`FakeNetwork: unknown answer token: ${answerSdp}`);
            const local = new FakeConnection(this, nodeId, answer.nodeId, callbacks);
            const remote = new FakeConnection(this, answer.nodeId, nodeId, answer.callbacks);
            local.peer = remote;
            remote.peer = local;
            this.connections.push(local, remote);
            // The answerer's channel-open arrives over the network — queue it
            // so the scheduler decides when the far side registers the peer.
            this.#enqueue({
              from: nodeId,
              to: answer.nodeId,
              kind: 'open',
              deliver: () => answer.resolveConnect(remote),
            });
            return local;
          },
          cancel: () => {
            offer.cancelled = true;
          },
        };
      },
      answerOffer: async (offerSdp, callbacks = {}, _rtcConfig = undefined, _tracks = []) => {
        const offer = this.#offers.get(offerSdp);
        if (!offer) throw new Error(`FakeNetwork: unknown offer token: ${offerSdp}`);
        const token = `fake-answer:${nodeId}:${this.#seq++}`;
        /** @type {(c: MeshConnection) => void} */
        let resolveConnect = () => {};
        /** @type {Promise<MeshConnection>} */
        const connected = new Promise((resolve) => {
          resolveConnect = resolve;
        });
        this.#answers.set(token, { nodeId, callbacks, resolveConnect });
        return { answerSdp: token, waitForConnect: () => connected };
      },
    };
  }

  // ── Fault injection ─────────────────────────────────────────────────────

  /**
   * Drop events matching the predicate (by default only the first match).
   * @param {EventPredicate} match
   * @param {{once?: boolean}} [opts]
   */
  dropWhere(match, opts) {
    this.#drops.push({ match, once: opts?.once ?? true });
  }

  /**
   * Hold matching events instead of delivering them (by default only the
   * first match). The returned handle's release() re-enqueues everything held
   * and stops holding.
   * @param {EventPredicate} match
   * @param {{once?: boolean}} [opts]
   */
  holdWhere(match, opts) {
    /** @type {{match: EventPredicate | null, once: boolean, held: NetEvent[]}} */
    const h = { match, once: opts?.once ?? true, held: [] };
    this.#holds.push(h);
    return {
      release: () => {
        h.match = null;
        const held = h.held;
        h.held = [];
        for (const ev of held) {
          this.trace.push(`RELEASE ${fmtEvent(ev)}`);
          this.#queue.push(ev);
        }
      },
    };
  }

  /**
   * Simulate abrupt link loss between two nodes: both sides get a disconnect,
   * neither side "hung up" gracefully.
   * @param {string} idA
   * @param {string} idB
   */
  severLink(idA, idB) {
    for (const c of this.connections) {
      if (c.closed || c.localId !== idA || c.remoteId !== idB) continue;
      const p = c.peer;
      c.closed = true;
      if (p) p.closed = true;
      this.#enqueue({ from: idA, to: idB, kind: 'close', deliver: () => p?.callbacks.onDisconnected?.() });
      this.#enqueue({ from: idB, to: idA, kind: 'close', deliver: () => c.callbacks.onDisconnected?.() });
    }
  }

  // ── Scheduler ───────────────────────────────────────────────────────────

  /**
   * Deliver one queued event. With a seed, picks randomly among the heads of
   * each (from→to) link — preserving per-link FIFO like real ordered data
   * channels while exploring cross-link interleavings.
   * @returns {boolean} false if the queue was empty
   */
  step() {
    if (this.#queue.length === 0) return false;
    let idx = 0;
    if (this.#rng && this.#queue.length > 1) {
      /** @type {Map<string, number>} */
      const heads = new Map();
      this.#queue.forEach((e, i) => {
        const k = `${e.from}→${e.to}`;
        if (!heads.has(k)) heads.set(k, i);
      });
      const choices = [...heads.values()];
      idx = choices[Math.floor(this.#rng() * choices.length)];
    }
    const [ev] = this.#queue.splice(idx, 1);
    this.trace.push(`DELIVER ${fmtEvent(ev)}`);
    ev.deliver();
    return true;
  }

  /**
   * Deliver events (flushing async continuations between steps) until the
   * network is silent.
   */
  async runToQuiescence() {
    for (let steps = 0; steps < 10_000; steps++) {
      await new Promise((r) => setTimeout(r, 0)); // flush pending async handlers
      if (this.#queue.length === 0) return;
      this.step();
    }
    throw new Error('FakeNetwork.runToQuiescence: step budget exceeded (message storm?)');
  }

  /**
   * Advance the virtual clock by `ms`, firing due timers in order and letting
   * the network settle after each one.
   * @param {number} ms
   */
  async advanceTime(ms) {
    await this.runToQuiescence();
    const target = this.clock.now() + ms;
    while (this.clock.fireNextDue(target)) {
      await this.runToQuiescence();
    }
    this.clock.advanceTo(target);
  }

  // ── Internal (called by FakeConnection) ─────────────────────────────────

  /**
   * @param {FakeConnection} conn
   * @param {string} data
   */
  enqueueMessage(conn, data) {
    /** @type {{type?: unknown, entry?: {id?: unknown}}} */
    const parsed = JSON.parse(data);
    this.#enqueue({
      from: conn.localId,
      to: conn.remoteId,
      kind: 'message',
      type: typeof parsed.type === 'string' ? parsed.type : undefined,
      entryId: typeof parsed.entry?.id === 'string' ? parsed.entry.id : undefined,
      deliver: () => {
        const dest = conn.peer;
        if (!dest || dest.closed) return;
        dest.callbacks.onMessage?.(data);
      },
    });
  }

  /** @param {FakeConnection} conn */
  enqueueClose(conn) {
    this.#enqueue({
      from: conn.localId,
      to: conn.remoteId,
      kind: 'close',
      deliver: () => {
        const dest = conn.peer;
        if (!dest || dest.closed) return;
        dest.closed = true;
        dest.callbacks.onDisconnected?.();
      },
    });
  }

  /** @param {NetEvent} ev */
  #enqueue(ev) {
    for (let i = 0; i < this.#drops.length; i++) {
      if (this.#drops[i].match(ev)) {
        this.trace.push(`DROP ${fmtEvent(ev)}`);
        if (this.#drops[i].once) this.#drops.splice(i, 1);
        return;
      }
    }
    for (const h of this.#holds) {
      if (h.match !== null && h.match(ev)) {
        this.trace.push(`HOLD ${fmtEvent(ev)}`);
        h.held.push(ev);
        if (h.once) h.match = null;
        return;
      }
    }
    this.#queue.push(ev);
  }
}
