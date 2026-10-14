import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { CancelTxRecordStore, resetCancelTxRecordForTests } from "./cancel-tx-record";
import { dryRunDeployAllowed } from "./dry-run-denylist";
import { reasonFromEngineError } from "./lok-ask-filled-quarantine";
import { OpenAskPendingStore, resetOpenAskPendingForTests } from "./open-ask-pending";

describe("Phase 2 hygiene", () => {
  const dirs: string[] = [];
  afterEach(() => {
    resetOpenAskPendingForTests();
    resetCancelTxRecordForTests();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("AskFilled unknown engine errors quarantine (#245)", () => {
    assert.equal(reasonFromEngineError("unknown listing"), "unknown-listing");
    assert.equal(reasonFromEngineError("timeout waiting for receipt"), null);
    assert.equal(reasonFromEngineError("nonce too low"), null);
    assert.equal(reasonFromEngineError("weird brand new refusal xyz"), "unprocessable");
  });

  it("dry-run denylist ignores NETWORK=anvil on chain 100 (#266)", () => {
    assert.equal(
      dryRunDeployAllowed({
        LOK_ALLOW_DRY_RUN_DEPLOY: "1",
        NETWORK: "anvil",
        LOK_CHAIN_ID: "100",
      }),
      false,
    );
    assert.equal(
      dryRunDeployAllowed({
        LOK_ALLOW_DRY_RUN_DEPLOY: "1",
        LOK_DRY_RUN_INSPECT: "1",
        NETWORK: "anvil",
        LOK_CHAIN_ID: "100",
      }),
      true,
    );
    assert.equal(
      dryRunDeployAllowed({
        LOK_ALLOW_DRY_RUN_DEPLOY: "1",
        NETWORK: "anvil",
        LOK_CHAIN_ID: "31337",
      }),
      true,
    );
  });

  it("corrupt open-ask-pending fails closed (#281)", () => {
    const dir = mkdtempSync(join(tmpdir(), "open-ask-"));
    dirs.push(dir);
    const path = join(dir, "open-ask-pending.json");
    writeFileSync(path, "{not-json");
    assert.throws(() => new OpenAskPendingStore(path), /could not be read|corrupt/i);
  });

  it("corrupt cancel-ask-txs fails closed (#282)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cancel-tx-"));
    dirs.push(dir);
    const path = join(dir, "cancel-ask-txs.json");
    writeFileSync(path, "{not-json");
    assert.throws(() => new CancelTxRecordStore(path), /could not be read|corrupt/i);
  });

  it("corrupt pending-cancel fails closed (#258)", async () => {
    const { readPendingCancels } = await import("./nft-transfer-ask-cancel");
    const dir = mkdtempSync(join(tmpdir(), "pending-cancel-"));
    dirs.push(dir);
    const path = join(dir, "pending-cancels.json");
    writeFileSync(path, "{not-json");
    assert.throws(() => readPendingCancels(path), /could not be read|corrupt/i);
  });
});
