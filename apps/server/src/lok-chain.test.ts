import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyKekDeposit, decodeKekDeposit, depositCursorPath, loadLokEnv, readDepositCursor, scanKekDeposits, writeDepositCursor } from "./lok-chain";
import { chainModeFromEnv, LokWorld } from "./lok-world";

const SAMPLE = {
  topics: [
    "0x44f9238c77e838571825580331e7e82218690fd4282906f9c351f6b85533ef47",
    "0x0000000000000000000000000000000000000000000000000000000000000006",
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  ],
  data: "0x0000000000000000000000000000000000000000000000000000000000004e20000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
};

test("chain mode stays engine-only until an rpc is set, and watching needs a checkpoint", () => {
  assert.equal(chainModeFromEnv({}).chain, "engine-only");
  assert.equal(chainModeFromEnv({ LOK_CHAIN_RPC: "http://127.0.0.1:8545" }).chain, "rpc-unwatched");
  const watching = chainModeFromEnv({
    LOK_CHAIN_RPC: "http://127.0.0.1:8545",
    LOK_CHECKPOINT: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
  });
  assert.equal(watching.chain, "watching");
  assert.match(watching.note, /queues on the vault/i);
});

test("a vault deposit log credits the character once and a replay does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-chain-"));
  const lok = LokWorld.open(dir, undefined, {});
  for (let i = 1; i <= 6; i++) {
    assert.equal(lok.spawn("char-" + i, "N" + i, 0).ok, true);
  }
  const deposit = decodeKekDeposit(SAMPLE);
  assert.deepEqual(deposit, { tokenId: "6", nonce: "1", amount: "20000" });
  assert.equal(decodeKekDeposit({ topics: ["0x11"], data: "0x" }), null);
  assert.equal(applyKekDeposit(lok, deposit!).ok, true);
  assert.equal(lok.kekOf("6"), "20000");
  assert.equal(lok.kekOf("1"), "0");
  const again = applyKekDeposit(lok, deposit!);
  assert.equal(again.ok, false);
  assert.equal(lok.kekOf("6"), "20000");
});

test("loadLokEnv fills blanks and does not override", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-env-"));
  const file = join(dir, ".env.local");
  writeFileSync(file, "LOK_CHAIN_RPC=http://127.0.0.1:8545\nLOK_KEK=0xabc\n# comment\n");
  const env: NodeJS.ProcessEnv = { LOK_KEK: "0xkeep" };
  loadLokEnv(env, [file]);
  assert.equal(env.LOK_CHAIN_RPC, "http://127.0.0.1:8545");
  assert.equal(env.LOK_KEK, "0xkeep");
});

test("a consumed nonce does not freeze the deposit cursor", async () => {
  const next = await scanKekDeposits({
    cursor: 0n,
    checkpoint: "0xabc",
    rpcCall: async (method) => {
      if (method === "eth_blockNumber") return "0x14";
      if (method === "eth_getLogs") return [{ ...SAMPLE, blockNumber: "0x10", logIndex: "0x0" }];
      throw new Error(method);
    },
    apply: () => ({ ok: false, error: "inbound nonce was already consumed or is out of order" }),
  });
  assert.equal(next.cursor, 19n);
});

test("a restart resumes from the persisted deposit cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-cursor-"));
  const path = depositCursorPath(dir);
  writeDepositCursor(path, 40n);
  assert.equal(readDepositCursor(path), 40n);
  let fromBlock = "";
  const next = await scanKekDeposits({
    cursor: readDepositCursor(path),
    checkpoint: "0xabc",
    rpcCall: async (method, params) => {
      if (method === "eth_blockNumber") return "0x30";
      if (method === "eth_getLogs") {
        fromBlock = (params[0] as { fromBlock: string }).fromBlock;
        return [];
      }
      throw new Error(method);
    },
    apply: () => ({ ok: true }),
  });
  assert.equal(fromBlock, "0x28");
  assert.equal(next.cursor, 47n);
  writeDepositCursor(path, next.cursor);
  assert.equal(readDepositCursor(path), 47n);
});
