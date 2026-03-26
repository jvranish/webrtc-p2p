// @ts-check
import { Queue } from "./utils/queue.js";
import { assert, assertEq, assertDeepEq, barrierMsg, describe, it } from "./test-helpers.js";
import { PeerMesh } from "../src/app/mesh.js";

/**
 * Helper to create a mesh peer with a message queue for easy testing
 * @param {string} id
 * @param {string} name
 * @returns {{
 *   mesh: PeerMesh,
 *   messages: Queue<{fromId: string, message: any}>,
 *   peers: Queue<{id: string, name: string}>,
 *   disconnects: Queue<string>,
 *   remoteStreams: Queue<{peerId: string, stream: MediaStream}>
 * }}
 */
function createTestPeer(id, name) {
  /** @type {Queue<{fromId: string, message: any}>} */
  const messages = new Queue();
  /** @type {Queue<{id: string, name: string}>} */
  const peers = new Queue();
  /** @type {Queue<string>} */
  const disconnects = new Queue();
  /** @type {Queue<{peerId: string, stream: MediaStream}>} */
  const remoteStreams = new Queue();

  const mesh = new PeerMesh({
    onPeerConnected: (peer) => {
      peers.push({ id: peer.id, name: peer.name });
    },
    onPeerDisconnected: (peerId) => {
      disconnects.push(peerId);
    },
    onMessage: (fromId, message) => {
      messages.push({ fromId, message });
    },
    onRemoteStream: (peerId, stream) => {
      remoteStreams.push({ peerId, stream });
    },
  });

  return { mesh, messages, peers, disconnects, remoteStreams };
}

/**
 * Create fake media tracks for testing
 * @returns {MediaStreamTrack[]}
 */
function createFakeTracks() {
  // Create a canvas to generate a fake video track
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = 'blue';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // @ts-ignore - captureStream exists on HTMLCanvasElement
  const stream = /** @type {MediaStream} */ (canvas.captureStream(1)); // 1 fps
  return stream.getTracks();
}

describe("PeerMesh", function () {
  it("should connect two peers (A invites B)", async function () {
    const { send: sendOffer, recv: recvOffer } = barrierMsg();
    const { send: sendAnswer, recv: recvAnswer } = barrierMsg();

    const a = async () => {
      const { mesh, peers } = createTestPeer("peer-a", "Alice");
      const { offerLink, acceptAnswer } = await mesh.createInvite("peer-a", "Alice");
      await sendOffer(offerLink);
      const answerToken = await recvAnswer();
      await acceptAnswer(answerToken);

      const connectedPeer = await peers.recv();
      assertEq(connectedPeer.id, "peer-b");
      assertEq(connectedPeer.name, "Bob");
    };

    const b = async () => {
      const { mesh, peers } = createTestPeer("peer-b", "Bob");
      const offerLink = await recvOffer();
      const answerToken = await mesh.acceptInvite(offerLink, "peer-b", "Bob");
      await sendAnswer(answerToken);

      const connectedPeer = await peers.recv();
      assertEq(connectedPeer.id, "peer-a");
      assertEq(connectedPeer.name, "Alice");
    };

    await Promise.all([a(), b()]);
  });

  it("should send CHAT messages between two peers", async function () {
    const { send: sendOffer, recv: recvOffer } = barrierMsg();
    const { send: sendAnswer, recv: recvAnswer } = barrierMsg();

    const a = async () => {
      const { mesh, peers, messages } = createTestPeer("peer-a", "Alice");
      const { offerLink, acceptAnswer } = await mesh.createInvite("peer-a", "Alice");
      await sendOffer(offerLink);
      const answerToken = await recvAnswer();
      await acceptAnswer(answerToken);

      await peers.recv(); // wait for connection

      // Send a message to B
      mesh.broadcast({ type: 'CHAT', text: 'Hello from Alice', timestamp: Date.now() });

      // Receive response from B
      const msg = await messages.recv();
      assertEq(msg.fromId, "peer-b");
      assertEq(msg.message.type, "CHAT");
      assertEq(msg.message.text, "Hello from Bob");
    };

    const b = async () => {
      const { mesh, peers, messages } = createTestPeer("peer-b", "Bob");
      const offerLink = await recvOffer();
      const answerToken = await mesh.acceptInvite(offerLink, "peer-b", "Bob");
      await sendAnswer(answerToken);

      await peers.recv(); // wait for connection

      // Receive message from A
      const msg = await messages.recv();
      assertEq(msg.fromId, "peer-a");
      assertEq(msg.message.type, "CHAT");
      assertEq(msg.message.text, "Hello from Alice");

      // Send response
      mesh.broadcast({ type: 'CHAT', text: 'Hello from Bob', timestamp: Date.now() });
    };

    await Promise.all([a(), b()]);
  });

  it("should form a 3-peer mesh (A invites B, B relays to connect C)", async function () {
    const { send: sendOfferAB, recv: recvOfferAB } = barrierMsg();
    const { send: sendAnswerAB, recv: recvAnswerAB } = barrierMsg();
    const { send: sendOfferAC, recv: recvOfferAC } = barrierMsg();
    const { send: sendAnswerAC, recv: recvAnswerAC } = barrierMsg();

    const a = async () => {
      const { mesh, peers } = createTestPeer("peer-a", "Alice");

      // A invites B
      const { offerLink: offerAB, acceptAnswer: acceptAnswerAB } = await mesh.createInvite("peer-a", "Alice");
      await sendOfferAB(offerAB);
      const answerAB = await recvAnswerAB();
      await acceptAnswerAB(answerAB);

      const peerB = await peers.recv();
      assertEq(peerB.id, "peer-b");

      // A invites C
      const { offerLink: offerAC, acceptAnswer: acceptAnswerAC } = await mesh.createInvite("peer-a", "Alice");
      await sendOfferAC(offerAC);
      const answerAC = await recvAnswerAC();
      await acceptAnswerAC(answerAC);

      const peerC = await peers.recv();
      assertEq(peerC.id, "peer-c");
    };

    const b = async () => {
      const { mesh, peers } = createTestPeer("peer-b", "Bob");

      // B accepts invite from A
      const offerAB = await recvOfferAB();
      const answerAB = await mesh.acceptInvite(offerAB, "peer-b", "Bob");
      await sendAnswerAB(answerAB);

      const peerA = await peers.recv();
      assertEq(peerA.id, "peer-a");

      // B should get relay connection to C automatically via PEER_LIST
      const peerC = await peers.recv();
      assertEq(peerC.id, "peer-c");
    };

    const c = async () => {
      const { mesh, peers } = createTestPeer("peer-c", "Charlie");

      // C accepts invite from A
      const offerAC = await recvOfferAC();
      const answerAC = await mesh.acceptInvite(offerAC, "peer-c", "Charlie");
      await sendAnswerAC(answerAC);

      const peerA = await peers.recv();
      assertEq(peerA.id, "peer-a");

      // C should get relay connection to B automatically via PEER_LIST
      const peerB = await peers.recv();
      assertEq(peerB.id, "peer-b");
    };

    await Promise.all([a(), b(), c()]);
  });

  it("should broadcast messages in a 3-peer mesh", async function () {
    const { send: sendOfferAB, recv: recvOfferAB } = barrierMsg();
    const { send: sendAnswerAB, recv: recvAnswerAB } = barrierMsg();
    const { send: sendOfferAC, recv: recvOfferAC } = barrierMsg();
    const { send: sendAnswerAC, recv: recvAnswerAC } = barrierMsg();

    const a = async () => {
      const { mesh, peers, messages } = createTestPeer("peer-a", "Alice");

      // Connect to B and C
      const { offerLink: offerAB, acceptAnswer: acceptAnswerAB } = await mesh.createInvite("peer-a", "Alice");
      await sendOfferAB(offerAB);
      const answerAB = await recvAnswerAB();
      await acceptAnswerAB(answerAB);
      await peers.recv(); // B connected

      const { offerLink: offerAC, acceptAnswer: acceptAnswerAC } = await mesh.createInvite("peer-a", "Alice");
      await sendOfferAC(offerAC);
      const answerAC = await recvAnswerAC();
      await acceptAnswerAC(answerAC);
      await peers.recv(); // C connected

      // Wait a bit for the mesh to fully form
      await new Promise(resolve => setTimeout(resolve, 500));

      // Broadcast message
      mesh.broadcast({ type: 'CHAT', text: 'Hello everyone from Alice', timestamp: Date.now() });

      // Should receive messages from B and C (in any order)
      const msg1 = await messages.recv();
      const msg2 = await messages.recv();

      const fromIds = [msg1.fromId, msg2.fromId].sort();
      assertDeepEq(fromIds, ["peer-b", "peer-c"]);
    };

    const b = async () => {
      const { mesh, peers, messages } = createTestPeer("peer-b", "Bob");

      const offerAB = await recvOfferAB();
      const answerAB = await mesh.acceptInvite(offerAB, "peer-b", "Bob");
      await sendAnswerAB(answerAB);
      await peers.recv(); // A connected
      await peers.recv(); // C connected (via relay)

      // Wait a bit for the mesh to fully form
      await new Promise(resolve => setTimeout(resolve, 500));

      // Wait for Alice's message
      const msgFromA = await messages.recv();
      assertEq(msgFromA.fromId, "peer-a");
      assertEq(msgFromA.message.text, "Hello everyone from Alice");

      // Broadcast response
      mesh.broadcast({ type: 'CHAT', text: 'Hi from Bob', timestamp: Date.now() });
    };

    const c = async () => {
      const { mesh, peers, messages } = createTestPeer("peer-c", "Charlie");

      const offerAC = await recvOfferAC();
      const answerAC = await mesh.acceptInvite(offerAC, "peer-c", "Charlie");
      await sendAnswerAC(answerAC);
      await peers.recv(); // A connected
      await peers.recv(); // B connected (via relay)

      // Wait a bit for the mesh to fully form
      await new Promise(resolve => setTimeout(resolve, 500));

      // Wait for Alice's message
      const msgFromA = await messages.recv();
      assertEq(msgFromA.fromId, "peer-a");
      assertEq(msgFromA.message.text, "Hello everyone from Alice");

      // Broadcast response
      mesh.broadcast({ type: 'CHAT', text: 'Hi from Charlie', timestamp: Date.now() });
    };

    await Promise.all([a(), b(), c()]);
  });

  it("should handle invalid answer token gracefully", async function () {
    const { mesh } = createTestPeer("peer-a", "Alice");

    // Create an invite
    const { acceptAnswer } = await mesh.createInvite("peer-a", "Alice");

    // Try to accept with empty string
    let error = null;
    try {
      await acceptAnswer("");
    } catch (err) {
      error = err;
    }
    assert(error instanceof Error, "Expected error for empty token");
    assert(error.message.includes('Invalid token'), `Expected clear error message, got: ${error.message}`);

    // Try to accept with whitespace only
    error = null;
    try {
      await acceptAnswer("   \n\t  ");
    } catch (err) {
      error = err;
    }
    assert(error instanceof Error, "Expected error for whitespace-only token");
    assert(error.message.includes('Invalid token'), `Expected clear error message, got: ${error.message}`);

    // Try to accept with invalid base64
    error = null;
    try {
      await acceptAnswer("not-valid-base64!!!");
    } catch (err) {
      error = err;
    }
    assert(error instanceof Error, "Expected error for invalid base64");
    assert(error.message.includes('Invalid token'), `Expected clear error message, got: ${error.message}`);
  });

  it("should exchange video tracks between two peers (both start camera before connect)", async function () {
    const { send: sendOffer, recv: recvOffer } = barrierMsg();
    const { send: sendAnswer, recv: recvAnswer } = barrierMsg();

    const a = async () => {
      const { mesh, peers, remoteStreams } = createTestPeer("peer-a", "Alice");

      // Add fake local tracks BEFORE creating invite (like real getUserMedia flow)
      const tracksA = createFakeTracks();
      mesh.addLocalTracks(tracksA);

      const { offerLink, acceptAnswer } = await mesh.createInvite("peer-a", "Alice");

      await sendOffer(offerLink);
      const answerToken = await recvAnswer();
      await acceptAnswer(answerToken);

      await peers.recv(); // wait for B to connect

      // Should receive remote stream from B
      const { peerId, stream } = await remoteStreams.recv();
      assertEq(peerId, "peer-b");
      assert(stream instanceof MediaStream, "Expected MediaStream");
      assert(stream.getTracks().length > 0, "Expected stream to have tracks");
    };

    const b = async () => {
      const { mesh, peers, remoteStreams } = createTestPeer("peer-b", "Bob");

      // Add fake local tracks BEFORE accepting invite (like real getUserMedia flow)
      const tracksB = createFakeTracks();
      mesh.addLocalTracks(tracksB);

      const offerLink = await recvOffer();
      const answerToken = await mesh.acceptInvite(offerLink, "peer-b", "Bob");
      await sendAnswer(answerToken);

      await peers.recv(); // wait for A to connect

      // Should receive remote stream from A
      const { peerId, stream } = await remoteStreams.recv();
      assertEq(peerId, "peer-a");
      assert(stream instanceof MediaStream, "Expected MediaStream");
      assert(stream.getTracks().length > 0, "Expected stream to have tracks");
    };

    await Promise.all([a(), b()]);
  });

  it("should handle A starting camera after connection (renegotiation)", async function () {
    const { send: sendOffer, recv: recvOffer } = barrierMsg();
    const { send: sendAnswer, recv: recvAnswer } = barrierMsg();

    const a = async () => {
      const { mesh, peers, remoteStreams } = createTestPeer("peer-a", "Alice");

      // Connect WITHOUT camera
      const { offerLink, acceptAnswer } = await mesh.createInvite("peer-a", "Alice");
      await sendOffer(offerLink);
      const answerToken = await recvAnswer();
      await acceptAnswer(answerToken);
      await peers.recv(); // wait for B to connect

      // NOW start camera (should trigger renegotiation)
      const tracksA = createFakeTracks();
      mesh.addLocalTracks(tracksA);

      // Wait a bit for renegotiation to complete
      await new Promise(resolve => setTimeout(resolve, 500));
    };

    const b = async () => {
      const { mesh, peers, remoteStreams } = createTestPeer("peer-b", "Bob");

      // Connect WITHOUT camera
      const offerLink = await recvOffer();
      const answerToken = await mesh.acceptInvite(offerLink, "peer-b", "Bob");
      await sendAnswer(answerToken);
      await peers.recv(); // wait for A to connect

      // Should receive remote stream from A after renegotiation
      const { peerId, stream } = await remoteStreams.recv();
      assertEq(peerId, "peer-a");
      assert(stream instanceof MediaStream, "Expected MediaStream");
      assert(stream.getTracks().length > 0, "Expected stream to have tracks");
    };

    await Promise.all([a(), b()]);
  });

  it("should handle B starting camera after connection (renegotiation)", async function () {
    const { send: sendOffer, recv: recvOffer } = barrierMsg();
    const { send: sendAnswer, recv: recvAnswer } = barrierMsg();

    const a = async () => {
      const { mesh, peers, remoteStreams } = createTestPeer("peer-a", "Alice");

      // Connect WITHOUT camera
      const { offerLink, acceptAnswer } = await mesh.createInvite("peer-a", "Alice");
      await sendOffer(offerLink);
      const answerToken = await recvAnswer();
      await acceptAnswer(answerToken);
      await peers.recv(); // wait for B to connect

      // Should receive remote stream from B after renegotiation
      const { peerId, stream } = await remoteStreams.recv();
      assertEq(peerId, "peer-b");
      assert(stream instanceof MediaStream, "Expected MediaStream");
      assert(stream.getTracks().length > 0, "Expected stream to have tracks");
    };

    const b = async () => {
      const { mesh, peers, remoteStreams } = createTestPeer("peer-b", "Bob");

      // Connect WITHOUT camera
      const offerLink = await recvOffer();
      const answerToken = await mesh.acceptInvite(offerLink, "peer-b", "Bob");
      await sendAnswer(answerToken);
      await peers.recv(); // wait for A to connect

      // NOW start camera (should trigger renegotiation)
      const tracksB = createFakeTracks();
      mesh.addLocalTracks(tracksB);

      // Wait a bit for renegotiation to complete
      await new Promise(resolve => setTimeout(resolve, 500));
    };

    await Promise.all([a(), b()]);
  });

  it("should handle both peers starting camera after connection", async function () {
    const { send: sendOffer, recv: recvOffer } = barrierMsg();
    const { send: sendAnswer, recv: recvAnswer } = barrierMsg();

    const a = async () => {
      const { mesh, peers, remoteStreams } = createTestPeer("peer-a", "Alice");

      // Connect WITHOUT camera
      const { offerLink, acceptAnswer } = await mesh.createInvite("peer-a", "Alice");
      await sendOffer(offerLink);
      const answerToken = await recvAnswer();
      await acceptAnswer(answerToken);
      await peers.recv(); // wait for B to connect

      // Start camera
      const tracksA = createFakeTracks();
      mesh.addLocalTracks(tracksA);

      // Should receive remote stream from B
      const { peerId, stream } = await remoteStreams.recv();
      assertEq(peerId, "peer-b");
      assert(stream instanceof MediaStream, "Expected MediaStream");
      assert(stream.getTracks().length > 0, "Expected stream to have tracks");
    };

    const b = async () => {
      const { mesh, peers, remoteStreams } = createTestPeer("peer-b", "Bob");

      // Connect WITHOUT camera
      const offerLink = await recvOffer();
      const answerToken = await mesh.acceptInvite(offerLink, "peer-b", "Bob");
      await sendAnswer(answerToken);
      await peers.recv(); // wait for A to connect

      // Start camera
      const tracksB = createFakeTracks();
      mesh.addLocalTracks(tracksB);

      // Should receive remote stream from A
      const { peerId, stream } = await remoteStreams.recv();
      assertEq(peerId, "peer-a");
      assert(stream instanceof MediaStream, "Expected MediaStream");
      assert(stream.getTracks().length > 0, "Expected stream to have tracks");
    };

    await Promise.all([a(), b()]);
  });
});
