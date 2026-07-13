// @ts-check
import { test, expect } from '@playwright/test';

/**
 * Tests the chain-join topology: A invites B, then B invites C.
 * The gossip/topology protocol should relay-connect A↔C through B automatically.
 *
 * Each browser context is a fully isolated peer (separate localStorage, JS heap,
 * RTCPeerConnection state) — equivalent to three real separate browser tabs.
 */
test('3-peer chain: A invites B, B invites C, A↔C relay-connects via B', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxC = await browser.newContext();

  try {
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    const pageC = await ctxC.newPage();

    // ── Step 1: A opens the app and creates an invite ─────────────────────

    await pageA.goto('/');
    await pageA.getByRole('button', { name: 'Invite' }).click();

    // Wait for ICE gathering to complete and the offer link to appear
    const offerInputA = pageA.locator('[aria-label="Invite someone"] input[readonly]');
    await offerInputA.waitFor({ state: 'visible', timeout: 10_000 });
    const offerLinkAB = await offerInputA.inputValue();
    expect(offerLinkAB).toContain('#offer=');

    // ── Step 2: B opens the offer link — auto-join triggers ───────────────
    //
    // main.js checks location.hash on load and calls handleOffer() automatically,
    // so B skips the manual paste step entirely.

    await pageB.goto(offerLinkAB);

    // B now shows the answer token for A to paste
    const answerInputB = pageB.locator('[aria-label="Joining session"] input[readonly]');
    await answerInputB.waitFor({ state: 'visible', timeout: 15_000 });
    const answerTokenAB = await answerInputB.inputValue();

    // ── Step 3: A pastes B's answer token → A↔B connect ──────────────────

    await pageA.locator('textarea[placeholder="Paste the answer token or URL here…"]').fill(answerTokenAB);
    await pageA.locator('[aria-label="Invite someone"]').getByRole('button', { name: 'Connect' }).click();

    // Both pages must show exactly one connected peer tile
    await expect(pageA.locator('.peer-tile:not(.peer-tile--self)')).toHaveCount(1, { timeout: 15_000 });
    await expect(pageB.locator('.peer-tile:not(.peer-tile--self)')).toHaveCount(1, { timeout: 15_000 });

    // ── Step 4: B creates an invite for C ─────────────────────────────────
    //
    // B's JoinModal closed automatically when A connected
    // (state.js peerConnected() calls closeJoinModal() when joinPhase is 'showing-answer').

    await pageB.getByRole('button', { name: 'Invite' }).click();

    const offerInputB = pageB.locator('[aria-label="Invite someone"] input[readonly]');
    await offerInputB.waitFor({ state: 'visible', timeout: 10_000 });
    const offerLinkBC = await offerInputB.inputValue();
    expect(offerLinkBC).toContain('#offer=');

    // ── Step 5: C opens B's offer link — auto-join triggers ───────────────

    await pageC.goto(offerLinkBC);

    const answerInputC = pageC.locator('[aria-label="Joining session"] input[readonly]');
    await answerInputC.waitFor({ state: 'visible', timeout: 15_000 });
    const answerTokenBC = await answerInputC.inputValue();

    // ── Step 6: B pastes C's answer token → B↔C connect ──────────────────

    await pageB.locator('textarea[placeholder="Paste the answer token or URL here…"]').fill(answerTokenBC);
    await pageB.locator('[aria-label="Invite someone"]').getByRole('button', { name: 'Connect' }).click();

    // ── Step 7: Verify full mesh — all three peers see each other ─────────
    //
    // When B registers C, it sends C the full topology (including A's entry).
    // It also broadcasts a TOPOLOGY_UPDATE to A about C.
    // Whichever of A or C has the lexicographically lower peer ID initiates
    // the relay offer to the other via #checkForNewPeers().

    await expect(pageA.locator('.peer-tile:not(.peer-tile--self)')).toHaveCount(2, { timeout: 20_000 });
    await expect(pageB.locator('.peer-tile:not(.peer-tile--self)')).toHaveCount(2, { timeout: 20_000 });
    await expect(pageC.locator('.peer-tile:not(.peer-tile--self)')).toHaveCount(2, { timeout: 20_000 });

  } finally {
    await ctxA.close();
    await ctxB.close();
    await ctxC.close();
  }
});
