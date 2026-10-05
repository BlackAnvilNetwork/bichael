import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowPlayerDeposit,
  checkpointReady,
  debitAfterQueue,
  depositCastArgs,
  depositKekOnchain,
  enqueueVaultSync,
  flushVaultPending,
  listVaultPending,
  loadQueues,
  loadVaultPending,
  LOCAL_MOCK_KEK,
  PLAYER_DEPOSIT_CAP,
  playerDepositGate,
  queueKekWithdrawal,
  vaultPendingPath,
  vaultWithdrawalMatches,
  withKeyQueue,
  withdrawalById,
  writeTextAtomic,
  type CastFn,
  type LogCheckpoint,
} from "./lok-vault";

const PLAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SERVER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function checkpointBody(amount: string, patch: Partial<LogCheckpoint> = {}): LogCheckpoint {
  return {
    player: PLAYER,
    prevRoot: "0x" + "33".repeat(32),
    newRoot: "0x" + "44".repeat(32),
    fromIndex: "0",
    toIndex: "1",
    logHash: "0x" + "55".repeat(32),
    summary: "0",
    inboundConsumed: "0",
    kekOut: amount,
    ...patch,
  };
}

const ENV = {
  LOK_CHAIN_RPC: "http://127.0.0.1:8545",
  LOK_CHECKPOINT: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
  LOK_VAULT: "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e",
  LOK_KEK: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  LOK_NFT: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
  LOK_FACTORY: "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
  LOK_RULESETS: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
  LOK_OWNER_KEY: "owner-key",
  LOK_ROTATOR_KEY: "rotator-key",
};

test("a failed vault queue returns the debit", async () => {
  let balance = 1000;
  let queued = false;
  const res = await debitAfterQueue(
    async () => ({ ok: false, error: "reverted" }),
    () => {
      balance -= 1000;
      return { ok: true };
    },
    () => {
      balance += 1000;
      return { ok: true };
    },
  );
  assert.equal(res.ok, false);
  assert.equal(res.debited, false);
  assert.equal(balance, 1000);
  assert.equal(queued, false);
});

test("spendable KEK is reserved before the queue resolves", async () => {
  let balance = 1000;
  let debitedBeforeQueue = false;
  const res = await debitAfterQueue(
    async () => {
      debitedBeforeQueue = balance === 0;
      return { ok: true, id: "4", availableAt: 10 };
    },
    () => {
      balance -= 1000;
      return { ok: true };
    },
    () => {
      balance += 1000;
      return { ok: true };
    },
  );
  assert.equal(res.ok, true);
  assert.equal(debitedBeforeQueue, true);
  assert.equal(balance, 0);
  if (res.ok) assert.equal(res.id, "4");
});

test("deposit submissions approve and deposit and never mint", () => {
  const plan = depositCastArgs(
    {
      rpc: ENV.LOK_CHAIN_RPC,
      checkpoint: ENV.LOK_CHECKPOINT,
      vault: ENV.LOK_VAULT,
      kek: ENV.LOK_KEK,
      nft: "",
      factory: "",
      rulesets: "",
      ownerKey: "owner-key",
      rotatorKey: "",
      proposerKey: "",
      castBin: "cast",
    },
    "6",
    "25",
  );
  assert.match(plan[0]!.join(" "), /approve\(address,uint256\)/);
  assert.match(plan[1]!.join(" "), /depositKek\(uint256,uint256\)/);
  assert.equal(plan.flat().join(" ").includes("mint"), false);
});

test("a reverted checkpoint does not report a queued withdrawal", async () => {
  const cast: CastFn = async (args) => {
    const cmd = args[0] ?? "";
    const sig = args[2] ?? "";
    if (cmd === "wallet" && args[1] === "address") {
      return { stdout: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266\n", stderr: "" };
    }
    if (cmd === "block") return { stdout: "1000\n", stderr: "" };
    if (cmd === "chain-id") return { stdout: "31337\n", stderr: "" };
    if (cmd === "keccak" || cmd === "abi-encode") return { stdout: "0x" + "11".repeat(32) + "\n", stderr: "" };
    if (cmd === "wallet" && args[1] === "sign") return { stdout: "0x" + "ab".repeat(65) + "\n", stderr: "" };
    if (cmd === "call") {
      if (sig.startsWith("ownerOf")) return { stdout: PLAYER + "\n", stderr: "" };
      if (sig.startsWith("isAccepted")) return { stdout: "true\n", stderr: "" };
      if (sig.startsWith("isActiveSigner")) return { stdout: "true\n", stderr: "" };
      if (sig.startsWith("stateRoot")) return { stdout: "0x" + "33".repeat(32) + "\n", stderr: "" };
      if (sig.startsWith("logIndex") || sig.startsWith("version") || sig.startsWith("nextWithdrawalId")) {
        return { stdout: "0\n", stderr: "" };
      }
      if (sig.startsWith("inboundApplied") || sig.startsWith("summary")) return { stdout: "1\n", stderr: "" };
    }
    if (cmd === "send" && sig.startsWith("checkpoint")) {
      order.push("send");
      throw new Error("revert");
    }
    throw new Error("unexpected " + cmd + " " + sig);
  };
  const order: string[] = [];
  const res = await queueKekWithdrawal("6", "1", ENV, cast, {
    body: checkpointBody("1"),
    beforeSend: (id) => {
      order.push("note:" + id);
    },
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.uncertain, true);
    assert.match(res.error, /stays reserved/);
  }
  assert.deepEqual(order, ["note:1", "send"]);
});

test("missing vault config refuses without debiting", async () => {
  let called = false;
  const res = await queueKekWithdrawal("6", "1", {}, async () => {
    called = true;
    return { stdout: "", stderr: "" };
  });
  assert.equal(res.ok, false);
  assert.equal(called, false);
});

test("a deposit is rejected when the chain is not 31337 or the token is not mock KEK", async () => {
  const robin = "0x5a3544a0328afD50A9979e03404F35c555B88c00";
  assert.equal(playerDepositGate({ chainId: 1n, token: LOCAL_MOCK_KEK, amount: 10n }).ok, false);
  assert.equal(playerDepositGate({ chainId: 31337n, token: robin, amount: 10n }).ok, false);
  assert.equal(playerDepositGate({ chainId: 31337n, token: LOCAL_MOCK_KEK, amount: PLAYER_DEPOSIT_CAP + 1n }).ok, false);
  assert.equal(playerDepositGate({ chainId: 31337n, token: LOCAL_MOCK_KEK, amount: 10n }).ok, true);

  let calls = 0;
  const badToken = await depositKekOnchain("1", "10", { ...ENV, LOK_KEK: robin }, async () => {
    calls += 1;
    return { stdout: "", stderr: "" };
  });
  assert.equal(badToken.ok, false);
  if (!badToken.ok) assert.match(badToken.error, /MockKEK/);
  assert.equal(calls, 0);

  const cast: CastFn = async (args) => {
    if (args[0] === "chain-id") return { stdout: "1\n", stderr: "" };
    calls += 1;
    throw new Error("unexpected " + args[0]);
  };
  const badChain = await depositKekOnchain("chain-gate", "10", { ...ENV, LOK_KEK: LOCAL_MOCK_KEK }, cast);
  assert.equal(badChain.ok, false);
  if (!badChain.ok) assert.match(badChain.error, /31337/);
  assert.equal(calls, 0);
});

test("player deposits are rate limited per character", () => {
  assert.equal(allowPlayerDeposit("rate-char", 1_000).ok, true);
  assert.equal(allowPlayerDeposit("rate-char", 2_000).ok, false);
  assert.equal(allowPlayerDeposit("rate-char", 11_000).ok, true);
});

test("a crash mid-write of the queue temp file does not wipe lok-queues.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-queues-"));
  const path = join(dir, "lok-queues.json");
  const row = { id: "9", tokenId: "1", amount: "3", availableAt: 1, status: "pending" as const };
  writeTextAtomic(path, JSON.stringify([row]));
  writeFileSync(path + ".tmp", "{");
  loadQueues(dir);
  assert.equal(withdrawalById("9")?.amount, "3");
  writeFileSync(path, "{");
  assert.throws(() => loadQueues(dir), /empty queue list/);
  assert.equal(withdrawalById("9")?.amount, "3");
});

test("two characters cannot queue withdrawals on the same counter", async () => {
  let next = 0n;
  let inflight = 0;
  let maxInflight = 0;
  const cast: CastFn = async (args) => {
    const cmd = args[0] ?? "";
    const sig = args[2] ?? "";
    if (cmd === "wallet" && args[1] === "address") {
      return { stdout: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266\n", stderr: "" };
    }
    if (cmd === "block") return { stdout: "1000\n", stderr: "" };
    if (cmd === "chain-id") return { stdout: "31337\n", stderr: "" };
    if (cmd === "keccak" || cmd === "abi-encode") return { stdout: "0x" + "11".repeat(32) + "\n", stderr: "" };
    if (cmd === "wallet" && args[1] === "sign") return { stdout: "0x" + "ab".repeat(65) + "\n", stderr: "" };
    if (cmd === "call") {
      if (sig.startsWith("ownerOf")) return { stdout: PLAYER + "\n", stderr: "" };
      if (sig.startsWith("isAccepted")) return { stdout: "true\n", stderr: "" };
      if (sig.startsWith("isActiveSigner")) return { stdout: "true\n", stderr: "" };
      if (sig.startsWith("stateRoot")) return { stdout: "0x" + "33".repeat(32) + "\n", stderr: "" };
      if (sig.startsWith("logIndex") || sig.startsWith("version")) return { stdout: "0\n", stderr: "" };
      if (sig.startsWith("nextWithdrawalId")) return { stdout: next.toString() + "\n", stderr: "" };
      if (sig.startsWith("inboundApplied") || sig.startsWith("summary")) return { stdout: "1\n", stderr: "" };
      if (sig.startsWith("withdrawals")) return { stdout: "0xabc 10 1 1000\n", stderr: "" };
    }
    if (cmd === "send" && sig.startsWith("checkpoint")) {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      next += 1n;
      inflight -= 1;
      return { stdout: "0xhash\n", stderr: "" };
    }
    throw new Error("unexpected " + cmd + " " + sig);
  };
  const [alice, bob] = await Promise.all([
    queueKekWithdrawal("6", "1000", ENV, cast, { body: checkpointBody("1000") }),
    queueKekWithdrawal("7", "1000", ENV, cast, { body: checkpointBody("1000") }),
  ]);
  assert.equal(alice.ok, true);
  assert.equal(bob.ok, true);
  if (alice.ok && bob.ok) {
    assert.deepEqual([alice.id, bob.id].sort(), ["1", "2"]);
  }
  assert.equal(maxInflight, 1);
  assert.equal(next, 2n);
});

test("a withdrawal match requires the character and the amount", async () => {
  const cast: CastFn = async (args) => {
    const sig = args[2] ?? "";
    if (sig.startsWith("withdrawalToken")) return { stdout: "6\n", stderr: "" };
    if (sig.startsWith("withdrawals")) return { stdout: "0xabc 10 1 1000\n", stderr: "" };
    throw new Error("unexpected");
  };
  assert.equal(await vaultWithdrawalMatches("4", "6", "1000", ENV, cast), true);
  assert.equal(await vaultWithdrawalMatches("4", "7", "1000", ENV, cast), false);
  assert.equal(await vaultWithdrawalMatches("4", "6", "999", ENV, cast), false);
});

test("a queued checkpoint is the supplied log body and pays the player wallet", async () => {
  let signed = "";
  let tuple = "";
  let next = 4n;
  const cast: CastFn = async (args) => {
    const cmd = args[0] ?? "";
    const sig = args[2] ?? "";
    if (cmd === "wallet" && args[1] === "address") return { stdout: SERVER + "\n", stderr: "" };
    if (cmd === "block") return { stdout: "1000\n", stderr: "" };
    if (cmd === "chain-id") return { stdout: "31337\n", stderr: "" };
    if (cmd === "keccak" || cmd === "abi-encode") return { stdout: "0x" + "11".repeat(32) + "\n", stderr: "" };
    if (cmd === "wallet" && args[1] === "sign") {
      signed = args[3] ?? "";
      return { stdout: "0x" + "ab".repeat(65) + "\n", stderr: "" };
    }
    if (cmd === "call") {
      if (sig.startsWith("ownerOf")) return { stdout: PLAYER + "\n", stderr: "" };
      if (sig.startsWith("isAccepted")) return { stdout: "true\n", stderr: "" };
      if (sig.startsWith("isActiveSigner")) return { stdout: "true\n", stderr: "" };
      if (sig.startsWith("stateRoot")) return { stdout: "0x" + "33".repeat(32) + "\n", stderr: "" };
      if (sig.startsWith("logIndex") || sig.startsWith("version")) return { stdout: "0\n", stderr: "" };
      if (sig.startsWith("nextWithdrawalId")) return { stdout: next.toString() + "\n", stderr: "" };
      if (sig.startsWith("withdrawals")) return { stdout: PLAYER + " 10 1 1000\n", stderr: "" };
    }
    if (cmd === "send" && sig.startsWith("checkpoint")) {
      tuple = args[4] ?? "";
      next += 1n;
      return { stdout: "0xhash\n", stderr: "" };
    }
    throw new Error("unexpected " + cmd + " " + sig);
  };
  const body = checkpointBody("1000");
  const res = await queueKekWithdrawal("6", "1000", ENV, cast, { body });
  assert.equal(res.ok, true);
  assert.match(tuple, new RegExp(body.logHash));
  assert.match(tuple, /,1,/);
  assert.equal(tuple.includes("lok-queue"), false);
  assert.match(signed, new RegExp(PLAYER.slice(2), "i"));
  assert.equal(signed.toLowerCase().includes(SERVER.slice(2).toLowerCase()), false);
});

test("a withdrawal without a real checkpoint is refused", async () => {
  const res = await queueKekWithdrawal("6", "1", ENV, async (args) => {
    const cmd = args[0] ?? "";
    const sig = args[2] ?? "";
    if (cmd === "chain-id") return { stdout: "31337\n", stderr: "" };
    if (cmd === "wallet" && args[1] === "address") return { stdout: SERVER + "\n", stderr: "" };
    if (cmd === "call" && sig.startsWith("stateRoot")) return { stdout: "0x" + "33".repeat(32) + "\n", stderr: "" };
    if (cmd === "call" && sig.startsWith("logIndex")) return { stdout: "0\n", stderr: "" };
    if (cmd === "call" && sig.startsWith("version")) return { stdout: "0\n", stderr: "" };
    throw new Error("unexpected " + cmd + " " + sig);
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /checkpoint/i);
  const serverPlayer = checkpointReady(checkpointBody("1", { player: SERVER }), "1", SERVER);
  assert.equal(serverPlayer.ok, false);
  const invented = checkpointReady(checkpointBody("1", { prevRoot: "0x" + "44".repeat(32), newRoot: "0x" + "44".repeat(32) }), "1", SERVER);
  assert.equal(invented.ok, false);
});

test("vault pending sink survives restart and is retried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lok-pending-"));
  const path = vaultPendingPath(dir);
  loadVaultPending(path);
  const row = enqueueVaultSync({ kind: "sink", tokenId: "6", amount: "25" }, dir);
  assert.equal(row.status, "pending");
  assert.equal(listVaultPending().length, 1);
  const again = loadVaultPending(path);
  assert.equal(again.length, 1);
  assert.equal(again[0]?.kind, "sink");
  assert.equal(again[0]?.amount, "25");
});

test("withKeyQueue serializes concurrent work for one key", async () => {
  const order: number[] = [];
  const tasks = [1, 2, 3].map((n) =>
    withKeyQueue("k", async () => {
      order.push(n);
      await new Promise((r) => setTimeout(r, 5));
      order.push(n + 10);
    }),
  );
  await Promise.all(tasks);
  assert.deepEqual(order, [1, 11, 2, 12, 3, 13]);
});
