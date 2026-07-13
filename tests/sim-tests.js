// @ts-check

/**
 * Deterministic simulation tests for the PeerMesh gossip/relay protocol.
 * These run the real PeerMesh against an in-memory FakeNetwork, so message
 * ordering, faults, and time are fully controlled — races reproduce 100% of
 * the time. On failure, inspect `net.trace` for the exact delivery schedule.
 */

import { assert, assertEq, assertDeepEq, describe, it } from "./test-helpers.js";
import { PeerMesh } from "../src/app/mesh.js";
import { FakeNetwork } from "./fake-network.js";

/** @import {ConnectedPeer, MeshMessage} from "../src/app/mesh.js" */

// Short virtual durations — advanced instantly via net.advanceTime.
const RELAY_TIMEOUT = 1_000;
const ANTI_ENTROPY = 5_000;
const GRACE = 12_000;

/**
 * @param {FakeNetwork} net
 * @param {string} id
 * @param {string} name
 */
function simPeer(net, id, name) {
  /** @type {ConnectedPeer[]} */
  const connects = [];
  /** @type {string[]} */
  const disconnects = [];
  /** @type {{fromId: string, message: MeshMessage}[]} */
  const messages = [];
  const mesh = new PeerMesh(
    {
      onPeerConnected: (p) => { connects.push(p); },
      onPeerDisconnected: (peerId) => { disconnects.push(peerId); },
      onMessage: (fromId, message) => { messages.push({ fromId, message }); },
      onRemoteStream: () => {},
    },
    net.transportFor(id),
    {
      clock: net.clock,
      relayTimeoutMs: RELAY_TIMEOUT,
      antiEntropyMs: ANTI_ENTROPY,
      unreachableGraceMs: GRACE,
    },
  );
  return { mesh, id, name, connects, disconnects, messages };
}

/** @typedef {ReturnType<typeof simPeer>} SimPeer */

/**
 * Run the manual invite handshake between two peers.
 * @param {FakeNetwork} net
 * @param {SimPeer} inviter
 * @param {SimPeer} joiner
 * @param {{settle?: boolean}} [opts] - settle: false leaves queued messages
 *   undelivered so multiple joins can interleave
 */
async function join(net, inviter, joiner, opts) {
  const { offerLink, acceptAnswer } = await inviter.mesh.createInvite(inviter.id, inviter.name);
  const answerToken = await joiner.mesh.acceptInvite(offerLink, joiner.id, joiner.name);
  await acceptAnswer(answerToken);
  if (opts?.settle !== false) await net.runToQuiescence();
}

/**
 * Assert every pair is connected and all topology replicas agree.
 * @param {SimPeer[]} peers
 */
function assertFullMesh(peers) {
  const ids = peers.map((p) => p.id).sort();
  for (const p of peers) {
    assertDeepEq([...p.mesh.connectedPeerIds].sort(), ids.filter((i) => i !== p.id));
  }
  /** @param {SimPeer} p */
  const norm = (p) => p.mesh.topologySnapshot()
    .map((e) => ({ id: e.id, neighbors: [...e.neighbors].sort() }))
    .sort((x, y) => (x.id < y.id ? -1 : 1));
  const ref = norm(peers[0]);
  for (const p of peers.slice(1)) {
    assertDeepEq(norm(p), ref);
  }
}

/**
 * How many times `peer` got a connection to `id`.
 * @param {SimPeer} peer
 * @param {string} id
 */
function connectCount(peer, id) {
  return peer.connects.filter((p) => p.id === id).length;
}

describe("PeerMesh simulation", function () {
  it("forms a full 3-peer mesh via gossip + relay", async function () {
    const net = new FakeNetwork();
    const a = simPeer(net, "peer-a", "Alice");
    const b = simPeer(net, "peer-b", "Bob");
    const c = simPeer(net, "peer-c", "Charlie");

    await join(net, a, b);
    await join(net, a, c);

    assertFullMesh([a, b, c]);
    assertEq(connectCount(b, "peer-c"), 1);
    assertEq(connectCount(c, "peer-b"), 1);
  });

  it("join race: joiner's entry arriving before inviter's update is not pruned", async function () {
    const net = new FakeNetwork();
    const a = simPeer(net, "peer-a", "Alice");
    const b = simPeer(net, "peer-b", "Bob");
    const c = simPeer(net, "peer-c", "Charlie");
    await join(net, a, b);

    // Hold A's own-entry updates to B: B will learn C's entry (fanned out by
    // A) before it learns that A is connected to C — C looks unreachable.
    const hold = net.holdWhere(
      (e) => e.kind === "message" && e.from === "peer-a" && e.to === "peer-b"
        && e.type === "TOPOLOGY_UPDATE" && e.entryId === "peer-a",
      { once: false },
    );

    await join(net, a, c);

    assert(!b.mesh.connectedPeerIds.includes("peer-c"),
      "B must not initiate while C looks unreachable");
    assert(b.mesh.topologySnapshot().some((e) => e.id === "peer-c"),
      "C's entry must survive within the grace period");

    hold.release();
    await net.runToQuiescence();

    assertFullMesh([a, b, c]);
    assertDeepEq(b.disconnects, []);
  });

  it("lost RELAY_ANSWER: attempt times out and a retry succeeds", async function () {
    const net = new FakeNetwork();
    const a = simPeer(net, "peer-a", "Alice");
    const b = simPeer(net, "peer-b", "Bob");
    const c = simPeer(net, "peer-c", "Charlie");
    await join(net, a, b);

    net.dropWhere((e) => e.type === "RELAY_ANSWER"); // first answer vanishes

    await join(net, a, c);
    assert(!b.mesh.connectedPeerIds.includes("peer-c"),
      "B–C must be blocked while the answer is lost");

    await net.advanceTime(RELAY_TIMEOUT + 1); // timeout → retry

    assertFullMesh([a, b, c]);
    assertEq(connectCount(b, "peer-c"), 1);
    assertEq(connectCount(c, "peer-b"), 1);
  });

  it("stale RELAY_ANSWER arriving after the timeout is ignored", async function () {
    const net = new FakeNetwork();
    const a = simPeer(net, "peer-a", "Alice");
    const b = simPeer(net, "peer-b", "Bob");
    const c = simPeer(net, "peer-c", "Charlie");
    await join(net, a, b);

    const hold = net.holdWhere((e) => e.type === "RELAY_ANSWER"); // delay, don't drop

    await join(net, a, c);
    await net.advanceTime(RELAY_TIMEOUT + 1); // attempt 1 abandoned, attempt 2 completes
    assertFullMesh([a, b, c]);

    hold.release(); // the answer to the abandoned offer finally arrives
    await net.runToQuiescence();

    assertFullMesh([a, b, c]);
    assertEq(connectCount(b, "peer-c"), 1);
    assertDeepEq(b.disconnects, []);
    assertDeepEq(c.disconnects, []);
  });

  it("severed connection heals through relay", async function () {
    const net = new FakeNetwork();
    const a = simPeer(net, "peer-a", "Alice");
    const b = simPeer(net, "peer-b", "Bob");
    const c = simPeer(net, "peer-c", "Charlie");
    await join(net, a, b);
    await join(net, a, c);
    assertFullMesh([a, b, c]);

    net.severLink("peer-b", "peer-c");
    await net.runToQuiescence();

    assertFullMesh([a, b, c]);
    assertDeepEq(b.disconnects, ["peer-c"]);
    assertDeepEq(c.disconnects, ["peer-b"]);
    assertEq(connectCount(b, "peer-c"), 2); // original + reconnect
  });

  it("anti-entropy heals a lost topology entry", async function () {
    const net = new FakeNetwork();
    const a = simPeer(net, "peer-a", "Alice");
    const b = simPeer(net, "peer-b", "Bob");
    const c = simPeer(net, "peer-c", "Charlie");
    await join(net, a, b);

    // B never learns C's entry from the initial gossip.
    net.dropWhere((e) => e.to === "peer-b" && e.type === "TOPOLOGY_UPDATE" && e.entryId === "peer-c");

    await join(net, a, c);
    assert(!b.mesh.connectedPeerIds.includes("peer-c"), "B should not know C yet");
    assert(!b.mesh.topologySnapshot().some((e) => e.id === "peer-c"),
      "C's entry was dropped on the way to B");

    await net.advanceTime(ANTI_ENTROPY + 1); // full TOPOLOGY re-sync

    assertFullMesh([a, b, c]);
  });

  it("departed peer is pruned from topology after the grace period", async function () {
    const net = new FakeNetwork();
    const a = simPeer(net, "peer-a", "Alice");
    const b = simPeer(net, "peer-b", "Bob");
    const c = simPeer(net, "peer-c", "Charlie");
    await join(net, a, b);
    await join(net, a, c);
    assertFullMesh([a, b, c]);

    // C drops off the network entirely.
    net.severLink("peer-a", "peer-c");
    net.severLink("peer-b", "peer-c");
    await net.runToQuiescence();

    assert(a.mesh.topologySnapshot().some((e) => e.id === "peer-c"),
      "C's entry lingers before the grace period elapses");

    await net.advanceTime(GRACE + ANTI_ENTROPY + 1);

    assert(!a.mesh.topologySnapshot().some((e) => e.id === "peer-c"), "A pruned C");
    assert(!b.mesh.topologySnapshot().some((e) => e.id === "peer-c"), "B pruned C");
    assertFullMesh([a, b]);
  });

  it("random interleavings form a full 4-peer mesh (seeded)", async function () {
    for (const seed of [1, 2, 3, 42, 1337]) {
      const net = new FakeNetwork({ seed });
      const a = simPeer(net, "peer-a", "Alice");
      const b = simPeer(net, "peer-b", "Bob");
      const c = simPeer(net, "peer-c", "Charlie");
      const d = simPeer(net, "peer-d", "Dana");

      // Overlapping joins: all gossip/relay traffic interleaves randomly.
      await join(net, a, b, { settle: false });
      await join(net, a, c, { settle: false });
      await join(net, a, d, { settle: false });
      await net.runToQuiescence();
      // Let timeouts/anti-entropy heal anything the interleaving broke.
      await net.advanceTime(RELAY_TIMEOUT * 3 + ANTI_ENTROPY + 1);

      try {
        assertFullMesh([a, b, c, d]);
        assert(net.trace.length < 1500, `possible message storm: ${net.trace.length} events`);
      } catch (err) {
        console.error(`seed ${seed} failed; trace:\n${net.trace.join("\n")}`);
        throw err;
      }
    }
  });
});
