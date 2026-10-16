# Black Anvil Network — Tiered Node Architecture

Oct 15, 2026 · @guy

## 1. Vision and scope

The game is the network: web clients, installed games, and phones carry the infrastructure, hosted servers are just early nodes, and losing any single machine never stops the world.

Today the world runs on one web server and a website (the game view). This document defines how that becomes a tiered network:

- A web or mobile client that follows and verifies the world with no setup.
- An installable game that bundles a node and validates by default.
- Opt-in replicas that hold the live world and can take over from a failed leader. Players call a bonded replica a Mark. A Mark is what unlocks leading a guild. It does not change combat.
- One binary that serves all four tiers, so a hosted server is a node and a node is a hosted server.

It keeps the engine, verification, and Gnosis constraints from the earlier Engine, Multi-Operator World, and Verification document, and replaces its notary model. Notaries that only signed after the fact become live replicas that can lead, so a failure changes who leads rather than whether the game runs. Section 19 lists every change.

Target chain: Gnosis (xDAI). Date context: 15 Oct 2026.

## 2. Requirements and constraints

Every design choice below is held to three liveness requirements and to the constraints inherited from the earlier document.

### Liveness requirements

1. Zero-friction join and leave. Players, validators, and light clients come and go with no registration and no effect on others. Only leading and voting are gated, because a bad writer can fork state.
2. Zero-participant startup. One hosted server or one installed game must boot, create a genesis journal, tick the world, accept players, and persist progress with nobody else on the network. This is a one-replica cluster, not a special mode.
3. No infrastructure freezes. Losing a leader, a replica, or quorum degrades authenticity or changes the leader. It never stops combat, movement, or loot. Player-visible interruptions are limited to a reconnect.

### Constraints carried forward

- One world state and one journal. No zone shards, no player layers, and no player pinned to a zone's server. Pale Hollow and the Ash Pit stay one world. One world is not one machine: per-encounter leaders can sit near the players in that encounter.
- The 20 Hz simulation is centralized per encounter group, run by one leader at a time. Adding machines does not make one melee faster.
- Authenticity lives outside `World::apply`, in the batch envelope. The ruleset, including caps and the rules that consume rolls, stays inside `World::apply`.
- Replay must reproduce an identical root from genesis or from any certified checkpoint. Joining needs the checkpoint plus the tail. Anyone may still check a checkpoint by replaying from genesis. Proofs and data-availability sampling are later. They are not substitutes.
- The listing key stays outside any voting set. Whoever holds it can send `AhEscrow` and `PvpBounty` transactions, and being a replica does not grant it.
- Chain events (`AskFilled`, PvP bounty logs, NFT transfers) are attestations. A mirror waits for confirmation depth and matching replica reports. Production Gnosis depth starts at 30 blocks (`DEFAULT_GNOSIS_CONFIRMATIONS` in `apps/server/src/settlement-confirmations.ts`). A per-type override may only raise that, never lower it.
- No shared mutable data directory. `LOK_ALLOW_SHARED_DATA_DIR` is not this mode. Nodes sync by replaying signed batches, or from a checkpoint plus the tail. Published immutable checkpoints and journal segments (section 15) are allowed.
- No new token and no emissions. The player-facing auction fee stays 1% (`AhEscrow` `FEE_BPS = 100`, native xDAI). A timelocked share of that fee funds guild rewards. Uptime alone does not pay. Validators and light clients are not paid.

### New requirements from the tiered model

- One binary and one protocol across web, installed game, mobile, and hosted server, differing by what the process is willing to hold, not by a fork of the server.
- A phone must be able to verify its own character without replaying the world.
- Admission to leading and voting is by bond on Gnosis rather than by invitation, once the contracts exist.

### How the constraints hold

| Constraint | Tension | Resolution |
| --- | --- | --- |
| One world | One leader reads as one region and one machine ceiling | One world means one state and one journal. Per-encounter leaders spread load and latency |
| 20 Hz per encounter | Players far from the leader see a higher round trip, and one machine bounds one crowd | Physical limit. Client prediction, leader placement near the encounter, sentry proxies (section 15) |
| Authenticity outside `World::apply` | Caps and roll rules have to live in the engine | Rules stay in apply. Proof of who wrote a batch stays in the envelope |
| Replay to an identical root | Replaying from genesis gets slower forever | Certified checkpoints are the join path (Phase 5). Genesis replay stays available as a check |
| Listing key outside the voting set | One key can still move player funds | The key is not granted by a bond, a Mark, or a guild. Invites say so |

## 3. Node tiers

There are four tiers, and a node is promoted from one to the next by capability and bond, never by permission from a central party.

Only replicas vote; validators and light clients verify what the voting set certifies, and Gnosis holds the voting set, the anchored roots, and the proof of cheating.

| Tier | Runs on | Holds | Does | Admission |
| --- | --- | --- | --- | --- |
| Light | Mobile, web | Latest signed head, its own character's state and proof | Follows commit certificates, verifies its own character against the committed root, watches its own chain events, relays inputs | None |
| Validator | Installed game (default), any PC node | Full journal, replayed state | Replays every committed batch to the claimed root, serves sync to others, watches Gnosis, publishes fraud evidence | None |
| Replica (a Mark, to players) | PC or server, opt-in | Full journal plus the hot live world | Receives every batch from the leader, signs commit certificates, votes in elections, can be elected. A bonded Mark may register one guild | Posts a bond to join the voting set. The posted amount is the bond |
| Leader | The best-uptime replica, one per encounter group at a time | The live world | Ticks at 20 Hz, sequences inputs and rolls, produces batches | Elected by replicas, fenced by epoch |

A hosted server is simply a node configured as a replica that is eligible to lead. An installed game is a validator unless its owner enables the replica flag, and the flag is gated by a resource self-check ("can I hold a replica?") and a reachability check. Resource profiles for validator and replica are published after the Phase 0 load test produces baseline numbers.

Each tier verifies from the same signed batches and roots. Anyone can leave any tier at any time; a replica that leaves simply stops voting.

## 4. Engine prerequisites

Replication and verification only work if the engine is O(touched), replays to an identical root, and can prove one character's state, so Phases 0–5 from the earlier document stay in force (issue #304) and two requirements are added. Phase 6 in the issue body, auction-house shards and character shards, does not; capacity is encounter groups, and only after replication.

| Phase | Focus | Ruleset bump | Done when |
| --- | --- | --- | --- |
| 0 | Server quick wins: coalesce events, group-commit journal, snapshot compaction, load-test harness, SLOs, CI benchmark | No | Load test runs in CI with baseline numbers |
| 1 | Hot path O(touched): clone/undo only touched characters, return deltas, counters, indexed order book, entries stored once; ledger worker | Yes | p99 ledger op < 5 ms at target load |
| 2 | Safety net: proptest invariants, fuzz, golden vectors shared with Solidity and TS, stable numeric codes, `lok-replay --expect-root`, fix mediums | Yes (with 1) | Full log replay gives identical root |
| 3 | Free read-side views: activity ledger, price history, achievements, telemetry | No | Live from existing log |
| 4 | New events: withdraw-cancel, once-flags, kill counters, partial fills | Yes | Events replay and conserve value |
| 5 | Progression in the log, `commit_span` / checkpoints, archive committed prefixes | Yes | `committed` advances |

Targets: p99 ledger op < 5 ms; game tick < 50 ms. The ruleset timelock is at least 1 day (Solidity), so Phase 1 and 2 proposals must be prepared early. With fresh genesis, all KEK custody paths are removed from the engine, wasm interface, and server shims, and on-chain `CharacterCheckpoint` roots are re-seeded to match. What carries, and how a later proof is not allowed to fork replay, are decided in section 18.

### Where the code is

Engine phases keep these numbers. Network rollout steps below do not reuse them.

- Phase 0 is partly in tree. `.github/workflows/phase0-bench.yml` runs the server bench in CI. Coalesce, group-commit, snapshot compaction, and published SLOs are not closed by that workflow.
- Phase 1 is partly in tree. `World::apply` undoes only the touched characters, and the order book only when the command changes listings. A ledger worker, an indexed order book, and storing each entry once are not done. `Engine::apply` still clones that character's full state on failure.
- Phase 2 is partly in tree. Golden vectors are shared with Solidity. `lok-replay --expect-root` exits non-zero on a mismatch. There is no proptest or cargo-fuzz gate, and engine errors are not stable numeric codes. JSON parse still returns `String`.
- Phases 3 and 4 are not started. Read-side views and the new events (withdraw-cancel, once-flags, kill counters, partial fills) are not in the log.
- Phase 5 is a draft. `checkpoint_span` builds a body and does not submit it. `committed` does not advance on Gnosis from the live server.

### Already correct (do not rebuild)

A failed World::apply restores only the touched characters, and the order book only when the command changes listings. `World::load` rejects a document whose touch set is not `affected_at`. `ItemDrop` never credits, and inbound nonces apply once and in order. Duplicate PvP fills are rejected. State uses deterministic structures (`BTreeMap`, keccak links, fail-closed).

### Known gaps that block replicas and validators

- Replay proves consistency, not authenticity (#232). Closed by the batch envelope and commit certificates (section 5).
- `lok-replay --expect-root` is on main. A mismatch exits non-zero.
- `World::set_ruleset_hash` is not written into the entry hash, so the ruleset hash is a side stamp (#177).
- PvP blind, hit, and crit are on the roll tape. That tape starts from one world epoch seed. Roam, facing, and gather-node placement stay on `Math.random`.

### New engine requirements for this design

1. Provable per-character state. A phone needs an inclusion proof for one character. `State::root` in `contracts/lok-log/engine/src/state.rs` is already a binary Merkle root of that character's leaves, but nothing exports a sibling path. There is no single root over every character: `lok-replay` prints one `state_root` per character, and `CharacterCheckpoint` stores that per-character root. A light client can verify a leaf against it once a proof API exists. A batch next root that covers the whole world still needs a commitment over the character roots, and that second tree is not in the crate.
2. Leader-blind rolls. Roll seeds are rolled every epoch by a seed roller who is not the leader (section 10), and the leader never sees the seed.

## 5. Batch envelope and commit certificates

The envelope is what turns a journal into something other nodes can trust: the leader signs every batch it produces, and replicas turn a batch into committed history by signing it too.

### Contents

Each envelope carries:

- The `LokWorld` inputs for the batch.
- The inputs commitment, and the roller's signed rolls with the epoch seed commitment they derive from.
- Parent root, next root, ruleset hash, epoch, and batch height.
- The leader's signature.
- Once committed, a commit certificate: replica signatures meeting the commit threshold.

### Acceptance rules

A replica or validator accepts a batch only when all hold:

1. The parent root, epoch, and height match the chain it expects.
2. The ruleset hash matches the hash it replays under.
3. The rolls are signed by the epoch's roller, bound to the inputs commitment, and match the seed commitment (checked by recomputation once the seed is revealed, or by a batch proof where present).
4. Replay yields the claimed next root.
5. The leader signature is valid and belongs to the epoch's elected leader.

A batch is committed when it carries a valid certificate. Only committed batches advance `committed`, feed chain-bound actions, and are served to light clients as authoritative.

### Batch states

- Provisional: produced by the leader, held by replicas, not yet certified. This is the live state players see.
- Committed: certified, immutable.
- Anchored: its root has been posted on Gnosis, giving cold-start recovery and a public record.

### Commit threshold

The threshold is a parameter pinned in the genesis batch. While the replica set is a small allowlist of known hosts, it is a simple majority, which tolerates crashed replicas. While fewer than four replicas have posted a bond and joined the voting set, open bonded admission keeps that majority: `1 + floor(n / 2)`. Once four or more replicas are bonded, the threshold is more than two thirds of that bonded set: `floor(2n / 3) + 1`, which tolerates a minority of dishonest replicas. Three bonded replicas commit at 2 of 3. Four commit at 3 of 4. Five commit at 4 of 5. Validators, light clients, phones, and the listing key are not in `n`. A one-replica genesis uses a threshold of one, so a single server commits its own batches and the "no notaries" case needs no special code.

### Equivocation

Two validly signed batches from the same signer for the same epoch and height with different next roots are proof of equivocation. Anyone can submit that pair to Gnosis (section 8).

The envelope is not required for single-server play, but it is required before any other node treats a batch as authoritative.

## 6. Replication, election, and failover

Every replica applies the same batches in the same order, so any replica can become leader within a heartbeat timeout and the game continues on whoever holds the highest certified prefix.

### Normal operation

- The leader ticks at 20 Hz, sequences the inputs and rolls for each batch, and streams batches to all replicas.
- Each replica replays the batch, checks the acceptance rules from section 5, and returns a signature.
- Certification runs off the tick path. Movement and combat act on provisional state immediately, and committed progress (loot, XP, crafts, log balances) lags by the commit interval. The interval is a tunable parameter set from the Phase 0 load test, and it is at least one seed epoch unless per-batch roll proofs are used (section 10).

### Election

- Replicas detect a missed heartbeat, increment the epoch, and elect a new leader.
- A candidate must hold the highest prefix that a threshold of replicas has received. The new leader adopts that prefix; provisional batches beyond it are discarded.
- Replicas reject any batch carrying an older epoch, which fences a returning stale leader.
- One Rust BFT engine orders batches from the first replica, including a genesis of one. Raft is not a phase. A crashed host and a lying host are both in scope once a second machine can sign, and a crash-only protocol cannot tell them apart. The engine is Tendermint-family (Malachite, the maintained Rust implementation). It runs at one validator and at three. The TypeScript server keeps the 20 Hz loop and, after a successful seal, submits that batch to the engine. The tick returns without waiting for a commit. A stopped validator or a round that does not decide leaves the batch provisional, and play continues. The server does not implement consensus. The lok wasm stays the state machine. An OP Stack, Orbit, or Cosmos SDK chain is not the orderer: those chains do not tick combat at 20 Hz, and they would replace the rules engine.

### Hand-off protocol

The election bullets are the outcome. This is the check a replica applies when a batch or a heartbeat arrives. These messages are not votes, rounds, or any other consensus-internal message. The TypeScript server still does not implement consensus, and this protocol does not choose the leader. The later engine does. What the new leader is allowed to keep is fixed here. This is election and failover hand-off for the whole world, not a per-encounter lease.

| Kind | From | Carries |
| --- | --- | --- |
| `heartbeat` | Leader | Epoch, height of the last streamed batch (absent before the first), tip root, logical time |
| `batch` | Leader | Epoch, height, parent root, next root, ordered input ids |
| `received` | Replica that stored the batch | Epoch, height, next root, replica id |
| `reject` | Replica that refused the batch | Epoch, height, replica id, and `parent-mismatch`, `stale-epoch`, or `dropped-input` |
| `input` | Client | One input id, offered to the leader that client is following |

A `received` message means the replica stored the batch. It is not a commit certificate. Certificates stay in section 5. A certificate is over a batch replicas have already stored, so certified history is a prefix of what a threshold has received, and certified batches are not discarded. The new leader adopts the highest prefix that at least the commit threshold of replicas has stored: the same batches, in order, each parent root equal to the previous next root, starting from 32 zero bytes. Provisional batches past that prefix are discarded. The rule does not create a second committed history.

**Parent-root match.** Each replica stores one parent: the next root of the last batch it stored, or 32 zero bytes before any batch. It stores a `batch` only when that parent matches and the height is the next height. Any other parent or height is `parent-mismatch`. The replica does not move its parent and does not skip ahead. Replicas still apply the same batches in the same order.

**Heartbeat timeout.** Time here is a logical counter, not a wall clock. A `heartbeat` for the open epoch records that counter. The timeout is a genesis count on the same counter. The timer starts at the first heartbeat of the epoch. When the replica's counter reaches the last heartbeat plus that count, and no newer heartbeat for the open epoch has arrived, the replica stops accepting that epoch. A later `batch` for the closed epoch, or for any older epoch, is `stale-epoch` and is not stored. A heartbeat does not reopen a closed epoch. Adopting the threshold prefix opens the next epoch, one greater. That is the increment the election already names. The timeout is not a consensus round timeout. The harness pins the count at 3.

**In-flight inputs.** An input is in flight once the leader has accepted it and no batch in the adopted prefix lists its id. The new leader keeps the threshold prefix and drops every other input id, whether it was still in flight or sat only in a discarded provisional batch. Those ids are not sequenced on the new epoch. An `input` or a `batch` that would place one on the winning chain is `dropped-input`. Losing inputs are not re-applied. A side below the commit threshold keeps ticking provisionally. When the partition heals, that side discards those provisional batches and their inputs and leaves them off the winning chain.

The deterministic harness is two operating-system processes, `apps/server/src/handoff-harness.test.ts`. It advances the logical counter itself. The live tick's chain link is unchanged.

### Failover experience

Clients hold a wallet session and a directory entry. When the leader changes they reconnect through the directory to the new leader and resume the session. The player sees a brief reconnect and no paused world.

### Partitions and quorum loss

- Only a side that can reach the commit threshold can certify batches, and two such sides cannot both exist because any two threshold sets overlap. Two divergent committed histories are therefore impossible.
- A side below threshold keeps ticking so play never freezes. Its batches stay provisional and are marked as such to clients.
- When the partition heals, the below-threshold side adopts the certified chain and discards its provisional batches. Provisional progress made during the partition is lost. Chain-bound actions are never issued from provisional state, so nothing irreversible depends on it.
- Re-applying the losing side's inputs onto the winning chain is deliberately not done, because rolls and ordering differ and the result would not match what players saw.

### Solo and degraded operation

A genesis with one replica commits its own batches (threshold of one). A cluster that loses quorum falls back to provisional ticking by whichever replica remains reachable to players. The same engine and envelope run in both cases.

### Joining and catch-up

A new replica or validator syncs from the latest checkpoint plus the log tail (Phase 5 checkpoint format), replays to the current root, and starts voting only after it has caught up and its bond, if required, is in place.

## 7. Capacity: encounter groups and leases

Fault tolerance comes from replication; extra capacity comes from parallel encounter groups on the single map, and that capacity work is sequenced after replication.

- An encounter group is the set of players and mobs that can affect each other this tick. Groups that cannot interact tick independently.
- Stage 1: one leader holds the whole world and ticks non-interacting groups in parallel on its own cores. No distributed hand-off exists yet.
- Stage 2: single-lease failover, meaning the whole-world leader is replaced on failure as described in section 6.
- Stage 3: per-encounter leases. A lease names an encounter, an epoch, and a deadline with a clock-skew margin, and renewal needs a fresh commit certificate. Different replicas then lead different groups in parallel.
- Walking into interaction range merges the groups onto one leader before a hit, trade, or party effect happens. Walking apart allows a split.
- One crowded fight still runs on one machine. More replicas keep other groups ticking; they do not speed up that fight.

Stage 3 is not started until the hand-off protocol is specified (messages, parent-root match, timeout, in-flight inputs) and a deterministic two-process test harness exists. Stage 1 may already meet the load target, in which case stage 3 is never built; the Phase 0 load test decides.

Adding or removing a replica or leader is itself a certified batch. Genesis keys are pinned in the first batch.

## 8. Admission, bonds, and the Gnosis contracts

Gnosis is not on the failover path; it holds who may vote, what was committed, and the proof that a signer cheated, so admission needs no central party.

| Contract | Holds | Used for |
| --- | --- | --- |
| Replica registry | The replica set, each replica's bond, entry and exit with an unbonding delay, and the seed-roller rotation | A local registry admits a replica by the bond it posts. The Gnosis Safe stays registry owner, slashing admin, and ruleset proposer. Fewer than four bonded replicas commit at a majority. Four or more commit at more than two thirds of the bonded set |
| Root anchor | Periodic committed roots with their commit certificates | Cold-start recovery, a public record, and the reference for chain-bound actions |
| Equivocation court | Pairs of conflicting signed envelopes | Slashes the signer's bond when two batches share an epoch and height but differ in next root |
| Existing game contracts | `CharacterCheckpoint` roots, `AhEscrow`, `PvpBounty` | Chain-bound state; escrow and bounty transactions still go through the listing key |

The bond is denominated in xDAI, so no new token is introduced.

### Admission

1. Phase one: the replica set is an allowlist of hosted nodes that you operate, and the threshold is a majority.
2. Open bonded admission. A replica joins the voting set by posting a bond. The posted amount is the bond. There is no minimum, default, or ceiling. The registry is local and does not broadcast to Gnosis mainnet or Chiado. Joining does not stop the 20 Hz tick. Registry owner, slashing admin, and ruleset proposer stay the Gnosis Safe until a vote of bonded replicas exists. This step does not create that vote and does not transfer admin. The commit threshold stays a majority while fewer than four replicas are bonded.
3. Once four replicas are bonded, the threshold is more than two thirds of the bonded voting set, `floor(2n / 3) + 1`. The count is replicas that posted a bond and joined. Validators, light clients, phones, and the listing key are not counted. This step does not create a vote that replaces the Safe, does not transfer admin, and does not broadcast to Gnosis mainnet or Chiado. The 20 Hz tick does not wait.
4. Validators and light clients do not post a bond and do not join the replica set. The listing key stays outside the set. A phone stays a light client.

### Fraud evidence

- Equivocation is provable on chain, because it only needs two signatures to be checked.
- An invalid certified batch is not provable on chain, because checking it needs a replay. Validators detect it by replay and `lok-replay --expect-root`, then publish the batch, its parent root, and the mismatch. Until an on-chain dispute game exists (section 18), response is operational: honest replicas refuse to build on it, and the registry owner removes and slashes the offending replicas.

### Chain-bound actions

Withdrawals, NFT mints, and `AhEscrow` or `PvpBounty` transactions wait for a committed batch, its anchor on Gnosis, and a short challenge delay. In-game play never waits. The listing key stays outside the replica set and outside the registry.

### Chain events in

`AskFilled`, PvP bounty logs, and NFT transfers enter as attestations. A mirror is proposed only after confirmation depth and matching reports from several replicas, each watching with its own RPC. Disagreement pauses only that mirror, never play.

### Marks and guilds

Replica is the protocol role. Mark is the player name for a bonded replica. The binary does not fork.

A player on the installed game may opt in to a Mark. The flag still requires the resource self-check and a reachability check. Bonding that Mark grants the operator the right to register one guild and to lead it. Joining a guild needs no hardware and no bond. A second Mark from the same operator does not open a second guild and does not add a second score. A Mark grants no damage, loot, or other combat advantage.

The player-facing auction fee stays 1% of the sale (`FEE_BPS = 100` in `contracts/lok-log/src/AhEscrow.sol`). `buyAsk` already pays `ownerOf(seller)` the remainder and sends the fee to `feeRecipient` in native xDAI. The guild pool is a split of that fee, not a second fee and not a new token. Starting parameter: 50 bps of the sale to the guild vault, 50 bps to the treasury. Both move only behind the ruleset timelock of at least one day. Until the auction house has volume, the vault is empty.

Once an epoch is anchored and the challenge delay has passed, the vault pays qualifying guilds in proportion to that epoch's score. If every score is zero, the xDAI stays in the vault for the next epoch.

A guild's score for an epoch is a pure function of the certified journal and that epoch's guild membership, so every replica gets the same number. It is the count of distinct characters in that guild who have at least one certified qualifying event in the epoch. Qualifying events are a combat resolution, a gather, a craft, or a trade that the journal committed. Each character contributes at most one. Provisional batches do not score. The Mark must have signed commit certificates in that epoch or the guild is ineligible. That signature is a bit, not a multiplier. Idle uptime does not pay. Running more Marks does not multiply the score.

The payout is a chain-bound action. It waits for the anchored root and the same challenge delay as withdrawals, mints, and escrow. That delay starts at one day.

## 9. Light clients and mobile

A phone or browser verifies only its own character against a certified root, which keeps it cheap while leaving it unable to be lied to about what it owns.

### What a light client does

1. Learns the replica set and threshold from genesis and the Gnosis registry.
2. Follows commit certificates and checks that each carries enough valid replica signatures.
3. Requests an inclusion proof for its own character's state and ledger entries and verifies it against the certified root.
4. Watches its own chain events and escrow state directly through a Gnosis RPC.
5. Sends inputs to any reachable node and follows directory redirects to the current leader.

The live view the player sees is provisional state from the leader, flagged as such. Committed state is what the proof covers.

### What it does not do

It does not replay the world, store the journal, vote, or lead.

### Mobile power and background

A phone is not a default replica. Boot stays the light tier. It does not tick the world, lead, or become a replica.

A limited validator mode is eligible only when the device is both plugged in and on an unmetered connection. Unplugged, or metered, stays on the light tier. Eligibility does not start the world tick. The phone's entry stays light: it does not tick, lead, or become a replica.

Background limits on the mobile operating system apply. The eligible mode is best-effort and may be stopped by the OS. This policy sets no CPU, RAM, or disk floor.

That mode grants no combat bonus, no second guild, and not the listing key.

### Trust boundary

A light client trusts that fewer than the threshold of replicas collude. Against a colluding majority it is protected only by validators noticing and responding (section 8), which is why the validator tier is open to every installed game.

### Dependency

This tier requires the provable per-character state described in section 4, which needs a proof API and a commitment over the character roots that the crate does not have yet. Without it a phone has nothing to verify against and must trust its connected node.

## 10. Randomness and anti-rigging

Replicas verify that a batch replays correctly, not that the leader fed the world honest inputs, so rolls must be unchoosable and what a bad leader can mint must be capped.

### Epoch seed, rolled in zero knowledge every 10 seconds

The seed changes every epoch of 10 seconds (a parameter) and is held by a seed roller that moves from replica to replica and is never the leader unless the leader is the only node, so rolls cost one request and response and the leader cannot predict them.

1. Roller: the role bounces to a different replica every epoch, in rotation, and never lands on the current leader. If no other replica is reachable, the main server (the leader) rolls the seed itself. A roller that is elected leader ends its epoch early and reveals its seed, and the next replica starts a new epoch.
2. Seed commitment: before the epoch the roller commits to a secret contribution. Once a later Gnosis block's randomness is known, it computes the seed as a hash of its secret and that randomness, then posts a commitment to the seed with a ZK proof that the commitment is exactly that hash of the earlier-committed secret and the public randomness. The proof stops the roller from grinding for a favorable seed, and nobody learns the seed.
3. Rolls during the epoch: for each batch the leader sends the roller its signed inputs commitment and the event ids. The roller returns the rolls for those events, derived from the seed and each event id through `rollUnit`, signed and bound to that inputs commitment. The leader cannot change the inputs after seeing the rolls.
4. Reveal: when the epoch ends the roller reveals the seed. Replicas and validators recompute every roll of the epoch and check it against the commitment. A mismatch is evidence against the roller and its bond is slashed.
5. Certification: batches whose rolls came from the roller are certified once the seed is revealed and recomputed, so committed progress lags by up to an epoch, and so does the provisional tail lost if the leader fails. If proving is fast enough for the tick budget, a per-batch proof of correct roll derivation lets certification run immediately instead.

PvP blind, hit, and crit move off `Math.random` onto this path.

### Several rollers per epoch

A set of rollers can serve each epoch instead of one, so no single roller has to be honest.

- Each roller in the set runs steps 2 to 4 with its own secret, commitment, and reveal. The set is fixed before the epoch starts and excludes the leader.
- For each batch the leader sends the inputs commitment and the event ids to every roller in the set in parallel. Each returns its share of the roll for each event, derived from its own seed and the event id, and signed.
- The roll the engine uses is a hash of all the shares. Rollers never see each other's shares, and the leader sees them only after its inputs are committed, so predicting a roll takes every roller in the set colluding with the leader.
- Latency stays one parallel request and response, bounded by the slowest roller in the set.
- A roller that does not answer ends the epoch early. The set is rebuilt without it, down to the main server alone if no other replica remains.
- Picking one share at random is rejected. If the leader picks, it can choose a favorable roll; if a fixed rule picks, one roller alone decides. Hashing all shares together has neither problem.
- The set size is a parameter. With the three hosted replicas of the first phase, the set is the two non-leader replicas.

### Where zero-knowledge proofs fit

- Seed commitment proof (step 2): everyone can trust the seed was not chosen by the roller, without learning it.
- Per-batch proof (optional): shows every roll in the batch is derived from the committed seed, so certification does not wait for the reveal. Whether proving fits the latency budget is open (section 18).
- Epoch proof: one proof per epoch that all its rolls derive from the committed seed, so light clients and Gnosis can check roll integrity without replay. Replicas and validators do not need it, because they recompute after the reveal.
- Proving the full `World::apply` transition in zero knowledge is the later proof-verification optimization and stays out of scope here.

Unpredictability comes from separating the roller from the leader, not from the proof. If the leader derived rolls from a seed it holds, latency would be zero but it could predict every roll in the epoch and choose inputs accordingly, so that variant is rejected.

### Degraded and single-replica operation

- With no other replica reachable, which includes a genesis of one, the main server rolls the seed itself using the same commitment, proof, and reveal procedure. The leader then knows the seed, so there is no unpredictability guarantee against its operator, the same trust as a single server today.
- If the roller is unreachable, the next replica in rotation takes over after a short timeout, and if none is reachable the main server rolls. Batches the main server rolls in a multi-replica cluster stay provisional and are not certified, so the timeout must be short.
- With a single roller, collusion with the leader defeats leader-blindness; with several rollers it takes all of them. Rotation, the bond, and the reveal check bound the damage.

### Caps inside `World::apply`

- The ceilings in force are the daily gold caps in `contracts/lok-log/engine/src/gold.rs`, on the server-day window. An epoch is not a day. `GOLD_DAILY_TOTAL_CAP` is 50_000 gold per character per server day, all sources. Per source per server day: quest 20_000, drop 15_000, harvest 15_000, npc_sell 10_000, and any other earn source 5_000. `craft_refund` is not an earn and does not count against those caps. The day is server-stamped. A replayer cannot verify the day. Loot, XP, and mint have no per-epoch numbers in this spec. Chain xDAI stays on its separate epoch cap (10% of the slashable bonds then posted).
- Every new drop names a kill in the same batch. A kill from an earlier batch does not count. An already-logged `LootDrop` keeps its encoding and still replays. `ItemDrop` never credits.
- Conservation checks stay as they are today: value moves, it is not created, and `ItemDrop` never credits.

These rules are part of the ruleset and are therefore covered by the ruleset hash and the timelock.

### Residual risk

A leader can still censor inputs or choose their order, and a leader who plays can use that to its advantage. Mitigations are rotating leaders on a missed heartbeat, preferring hosted or high-uptime replicas as leaders, and the caps above. Fair input ordering is an open question (section 18).

## 11. Failure modes and liveness

In every row except a total outage the game keeps ticking; what changes is who leads and how strongly progress is certified.

| Condition | What happens | Player experience | Progress |
| --- | --- | --- | --- |
| One replica, no others (genesis of one) | Commits its own batches | Unchanged | Self-certified, same trust as a single server today |
| Leader crashes, threshold alive | Election, epoch bump, new leader adopts the highest certified prefix | Brief reconnect | Certified history intact; provisional tail beyond the adopted prefix is lost |
| Non-leader replica leaves or crashes | Nothing changes while the threshold holds | None | Unchanged |
| Threshold lost (too few replicas reachable) | A reachable replica keeps ticking provisionally | Unchanged, marked provisional | Not certified; chain-bound actions wait |
| Partition heals | Below-threshold side adopts the certified chain | Brief reconnect | Its provisional batches are discarded |
| Two leaders claim one epoch | Replicas accept only the batch signed by the elected leader; conflicting signatures are equivocation | None to brief reconnect | Offender's bond slashed |
| Validator or light client leaves | Nothing | None | Unchanged |
| Client loses its node | Reconnects through the directory | Reconnect | Unchanged |
| All replicas offline | World is not running; players cannot connect | World unavailable | Last anchored root and any validator's journal allow restart |
| Gnosis RPC unavailable | Play continues; chain-bound actions and mirrors wait | Unchanged in game | Delayed, not lost |

Player-visible interruptions are limited to reconnects and to the same failure class as the single-server design when every replica is down. Directory caching, fallback, and a clear reconnect screen are required client work, and there is no "world paused" state.

## 12. Threat model

The design guarantees that certified history cannot fork and that cheating by replay is visible, and it does not guarantee that a dishonest majority of replicas is stopped before it does damage.

| Actor | Can | Cannot | Defense |
| --- | --- | --- | --- |
| Malicious leader | Censor or reorder inputs; stall until replaced | Forge rolls, mint beyond caps, certify alone | Leader-blind rolls, caps in `World::apply`, election on missed heartbeat, replicas verify every batch |
| Minority of dishonest replicas | Withhold votes, delay certification | Certify an invalid batch | Threshold overlap, replay by honest replicas |
| Dishonest replica majority (above the threshold) | Certify an invalid batch | Hide it from validators | Validators replay and publish evidence; honest replicas refuse to build on it; bond slashing; chain-bound actions held by the anchor and challenge delay |
| Equivocating signer | Send conflicting batches to different peers | Avoid proof | Equivocation court slashes the bond |
| Network partition | Isolate a minority | Create a second certified history | Threshold overlap; provisional discarded on heal |
| Malicious seed roller | Predict rolls, leak them to a colluder, withhold rolls | Pick its own seed or change a roll after committing | ZK-proven seed commitments, reveal and recomputation each epoch, several rollers whose shares are hashed together, rotation that excludes the leader, bond slashing; defeating it takes every roller in the set colluding with the leader |
| Holder of the listing key | Send `AhEscrow` and `PvpBounty` transactions | Alter certified state | Key stays outside the replica set; not granted by operating a node |
| Malicious light client or validator | Spam requests | Affect state or liveness | Rate limits at serving nodes; no vote |

### Not guaranteed

- Censorship resistance against a leader until it is rotated out.
- Prevention, rather than detection and response, of an invalid batch certified by a dishonest majority. Prevention needs on-chain verification of replays, which is a later optimization (section 18).
- Zero loss of provisional progress during a partition or leader failure.

## 13. Rollout sequence

The order puts a correct, fast engine first, then fault tolerance with three hosted replicas, then open validators, then open replicas, and each step is shippable on its own.

1. Phase 0 quick wins and the load-test baseline (no ruleset change). Gate: load test runs in CI with baseline numbers.
2. Phase 1+2 bundle: O(touched), safety net, `lok-replay --expect-root`, KEK removal, and ruleset proposals early enough for the timelock. Gate: full log replay gives an identical root.
3. Envelope with leader signature, ruleset binding, fallback-seeded rolls (Gnosis randomness plus leader commitment) with PvP on `rollUnit`, and caps in `World::apply`. Gate: golden vectors green and replay cost under budget.
4. Replication and election across three hosted replicas, majority threshold, with the replica registry on an allowlist; seed rolling rotates across the replicas and rolls switch to it. Gate: leader failover practiced and a killed leader costs only a reconnect.
5. Root anchor on Gnosis and gating of chain-bound actions on anchored roots. Roll proofs for light clients and contracts follow once the roll circuit exists.
6. Installed game with a bundled node in validator mode, and a web client with light verification. Gate: the per-character proof API and the commitment over character roots are in place.
7. Mobile light client.
8. Equivocation court, then open bonded admission. The Gnosis Safe stays admin until a vote of bonded replicas exists. While fewer than four replicas are bonded the commit threshold stays a majority (`1 + floor(n / 2)`). Once four or more are bonded it is more than two thirds of that set (`floor(2n / 3) + 1`). Commit certificates are BLS12-381 from the first replica. Gnosis verifies them with the EIP-2537 precompiles (Pectra, 30 Apr 2025). Player session keys stay ECDSA.
9. Guild registry. One guild per bonded operator. Joining stays free. No payouts yet.
10. Guild vault. The 1% auction fee splits 50/50 between the vault and the treasury. Scores are a pure function of certified events. Payouts wait for an anchored root and the challenge delay, which starts at one day.
11. Per-encounter leases, only if the load test shows the single-leader ceiling is reached. Gate: hand-off specification and two-process harness.
12. On-chain dispute game, roll proofs, and proof verification, only after replicated certification is live and stable. Zero-knowledge seed proofs are this step, not step 3.

Engine phases 3–5 (read-side views, new events, progression and checkpoints) run alongside steps 3 to 6. The Phase 5 checkpoint, the sibling-proof API, and the tree of character roots land before step 6. Step 3 of this rollout is the envelope. It is not engine phase 3.

## 14. Explicit non-goals

This design does not attempt any of the following:

- Decentralizing the 20 Hz simulation itself; one leader runs each encounter group.
- Making one melee faster by adding machines.
- Pinning players to zones, shards, or layers.
- Pausing or freezing play because replicas, leaders, or quorum are absent.
- Requiring a bond, registration, or approval to play, validate, or run a light client.
- Threshold-signing the listing key.
- Introducing a new token, or paying anyone with emissions.
- Raising the auction fee above 1% to fund guilds.
- Granting a Mark extra damage, loot, or any other combat advantage.
- Requiring a replica, a bond, or a Mark to join a guild.
- Paying a replica for idle uptime, or paying validators and light clients.
- Porting CosmWasm entry points, Item/Map patterns, or IBC. Cross-domain traffic is a Gnosis log after depth plus matching reports.
- Shared disk or automatic full-history replication.

## 15. Gaps and limits

Seven gaps can hurt players or the economy, and each has a fix that belongs in the spec now rather than in a later patch.

| Gap | Why it matters | Fix |
| --- | --- | --- |
| The leader controls order-book sequencing | Leader-blind rolls fix randomness, not ordering. A leader that sequences auction fills and trades can front-run them, which is the largest economic attack surface | Match the order book in batch auctions with one clearing price per batch, and break ties with a seed the leader does not hold. Early leaders are hosted nodes |
| Settlement lag looks like finality | Trades and fills appear done but stay provisional for up to an epoch, and a leader crash can reverse them | Label value-bearing actions as settling until committed; chain-bound actions already wait |
| The bond is not tied to the value at stake | A dishonest majority could extract more than the slash costs it | Cap the value certifiable per epoch below a fraction of the slashable bond, and raise the cap as bonds grow |
| Hidden central keys | The registry owner, who slashes, and the ruleset timelock admin are the real root of trust | Name the holders, publish them, and plan how each decentralizes (for example multisig, then a bonded vote). Until then, say so plainly |
| Data availability | Anchors hold roots, not data. If every replica and validator loses the journal, the world cannot be rebuilt | Recent checkpoints go out as Gnosis blobs (EIP-4844, pruned after about 18 days). Validators keep the bytes. The anchor records the blob commitment and the keccak. 20 Hz batches are not blob traffic |
| The web client is trusted code | A light client verifies nothing if the site serves a malicious bundle | Pin the bundle hash, use reproducible builds, and serve it from a name the community can check |
| The leader is an exposed target | One public machine ticks the world | Sentry proxies in front of the leader, a hidden leader address, and fast rotation under attack |

### How it could limit players

- Latency: one leader sits in one region, so players far from it see a higher round trip at 20 Hz. Client prediction helps, and per-encounter leases near the player mass make leader placement a latency feature, not only a capacity one.
- Crowd size: one machine bounds one fight, so a very large event hits the ceiling, and stage 3 leases cannot split a single fight.
- Lost progress: a leader failure drops up to one epoch of provisional progress, which feels bad if it takes a rare drop with it.
- Device limits: phones cannot validate, and light verification depends on a proof API that does not exist yet (section 4).
- Cost of leading: bonds keep small operators out of the replica tier. Keep validating free and size the first bonds low.
- Single-server trust: until at least three replicas run, the guarantees are the same as today's server.

## 16. Public good and upgrade-proofing

The network is a public good only if anyone can verify, fork, and leave without the studio's permission; the design supplies verify and leave, and the conditions below supply the rest.

### Conditions for credible neutrality

- The engine is open source with reproducible builds, and the pinned wasm for each ruleset version is the ruleset.
- The journal and checkpoints are public, so anyone can replay from genesis.
- Validating and forking are permissionless. A fork can start from any anchored root, and character state stays verifiable against on-chain `CharacterCheckpoint` roots.
- Ruleset changes pass a timelock long enough for players to withdraw chain-bound assets first. The current floor is 1 day, and economic rules may need longer.
- Governance is declared: who can change the replica set, the registry, and slashing, and how that decentralizes.

Without these it is a game with a good audit log. With them it is a world that can outlive its studio.

### Decisions that are expensive to change later

| Decision | Why it is expensive later | Choose now |
| --- | --- | --- |
| Ruleset versioning in the journal | Old history must stay replayable under the rules that produced it, or validators replaying from genesis break at the first upgrade | Each batch carries the ruleset hash it was replayed under. Every past wasm pin is kept. Unknown hashes are rejected |
| State commitment and hash | Changing the tree or the hash means a new genesis | Keccak, the same binary Merkle as `State::root` (`commit_map` in `state.rs`: pair leaves, duplicate the last when a level is odd). `nextRoot` is that tree over `(tokenId, characterRoot)`. A sibling-proof API is Phase 5. A ZK-friendly hash is a new genesis, not a silent swap |
| Certificate signature scheme | Individual signatures grow with the replica set, and phones and Gnosis pay for each | BLS12-381 aggregate signatures from the first commit certificate. Gnosis EIP-2537 checks them. Player session keys stay ECDSA. There is no later curve migration |
| World id and protocol version | Without them, clients and replicas on different versions can split silently | Both sit in the genesis batch and in every envelope. An unknown `worldId` or `protocolVersion` is rejected |
| Anchor and registry interfaces | Hard-wiring Gnosis couples the world to one chain | The anchor, registry, court, and guild vault are small interfaces. Gnosis (chain id 100) is the first deployment. Calls take chain id, contract, and the payload. They do not assume a second chain exists |
| Epoch and threshold parameters | They are pinned in genesis, so a wrong guess needs a fork | Seed epoch starts at 10 seconds. Commit threshold starts at 1 (one replica), stays a majority (`1 + floor(n / 2)`) while fewer than four replicas are bonded, then more than two thirds (`floor(2n / 3) + 1`) once four are bonded. Changes go out as a certified batch and wait out the ruleset timelock of at least one day |

## 17. What makes it valuable

The network's value is a guarantee players cannot get elsewhere plus a kit others can build on, so the design should point at those two things.

- Sell the guarantee, not the infrastructure: provably fair drops, provable scarcity, and a world that outlives its studio. The ZK-verified rolls in section 10 are the concrete proof of the first.
- Make the engine a kit: another developer launches a persistent, fault-tolerant world from one binary and a ruleset, and every new world adds replicas, validators, and players. That needs the ruleset as the plug-in boundary and the world id from section 16.
- Keep chain friction out of onboarding: play instantly, use session keys, and bring in the wallet only when value moves on chain.
- Open the data: the public journal and the Phase 3 read-side views feed explorers, guild tools, marketplaces, and economy research.
- Fund guilds, not idle machines: half of the existing 1% auction fee, in xDAI, paid on certified play. A Mark is the right to lead a guild. It is not a stipend for being online.
- Give players real power: validators in every installed game, community-run replicas, and a fork path make the world theirs as well as yours.
- Publish the proof: a public status page with replica count, independent validator count, last anchored height, and time since the last unplanned outage lets anyone check the claims.

## 18. Decisions, what is still open, and operational items

The stack already in the repo decides the questions that were blocking the spec. The orderer is the one piece that stays a library choice.

### Decided

1. Ordering. The Rust wasm stays the state machine. Consensus is one Rust BFT engine, Malachite (Tendermint), from the first replica, including a single-node genesis. The TypeScript server keeps the 20 Hz loop and submits batches. It does not run Raft, and it does not grow a second consensus later. A general-purpose rollup stack is not the orderer.
2. Character proofs. `nextRoot` is a keccak Merkle tree over `(tokenId, characterRoot)`, using the same `commit_map` as `State::root`. The sibling-proof API lands in Phase 5, before the light client. A phone checks the certificate, then the character root, then the leaf.
3. Randomness. The seed epoch is 10 seconds. The roller set is every replica that is not the leader. Certification waits for the reveal until rollout step 12. Step 3 uses Gnosis block randomness plus a leader commitment, and PvP rolls move onto `rollUnit`. No Gnosis ZK precompile is required.
4. Input order. The order book clears once per batch, one price per item, ties broken by the roller seed. Combat and other inputs stay in the leader's order. Caps in `World::apply` and rotation on a missed heartbeat are the bound on that. There is no separate fair-ordering protocol.
5. Provisional play. Ticking does not stop when the threshold is lost. A time cap would freeze the world. The client labels state provisional from the first uncertified batch. Chain-bound actions and guild scores ignore provisional batches.
6. Challenge delay. One day for withdrawals, mints, escrow, and guild payouts, the same floor as the ruleset timelock. One clock. At launch the only watchers are the studio replicas, and one hour is shorter than the time it takes a person to notice a bad certificate. The delay can move down, behind that same timelock, once validators outside the replica set are online. It is not the PvpBounty `claimDelay` (60 seconds to 7 days on that contract).
7. Slashing before a dispute game. The Gnosis Safe that holds contract admin may remove a replica and slash its bond only when the evidence reproduces: two signatures at the same epoch and height with different roots, or a batch that `lok-replay --expect-root` rejects. After the equivocation court exists, anyone may submit the signature pair. There is no social vote.
8. Incentives. Guilds are paid from the auction fee, in xDAI, as specified under Marks and guilds. Replicas are not paid for uptime. Validators and light clients are not paid.
9. Value at risk. Chain-bound xDAI settled in one epoch (escrow, bounty payouts, withdrawals, guild payouts) is at most 10% of the slashable bonds then posted. In-game gold is outside the cap. The percentage moves only behind the timelock. During the allowlist the posted bonds have to cover real auction volume, or the cap stalls chain-bound actions.
10. Governance at launch. Registry owner, slashing admin, and ruleset proposer are the Gnosis Safe (`ADMIN` in `docs/gnosis-launch.md`). That address is still to be supplied. It is not a server EOA. `FEE_RECIPIENT` stays a distinct treasury. The path off the Safe is a vote of bonded replicas after open admission, not before.
11. Data availability. A checkpoint is posted as a Gnosis blob. Blobs prune after about 18 days, so they are the publish path, not the archive. Every validator keeps the checkpoint bytes. The anchor stores the blob commitment and the keccak. 20 Hz batches stay off blobs. Celestia, EigenDA, and IPFS are not in the first cut. If every replica and every validator deletes the bytes, the anchor cannot rebuild the world.
12. Versioning. `worldId` and `protocolVersion` are in the genesis batch and in every envelope. Unknown values are rejected. The state-tree hash is keccak, the same function as `State::root` and the Solidity golden vectors. Commit certificates are BLS12-381. Player session keys stay ECDSA.

### Rejected

- Raft, then a later swap to BFT. One lying allowlisted host can fork a crash-only protocol, and the swap is a second consensus.
- ECDSA certificates until the set is large. Gnosis already verifies BLS12-381. A curve change later is the expensive decision section 16 exists to avoid.
- An OP Stack, Arbitrum Orbit, or Cosmos SDK chain as the world. They order blocks on the order of seconds and would replace the lok rules engine. Gnosis remains the settlement chain for fees, bonds, anchors, and NFTs.
- Poseidon or another ZK-friendly state hash. It would not match `CharacterCheckpoint` or the golden vectors. A proving system at step 12 has to prove keccak, or it waits for a new genesis.
- Proving `World::apply` in zero knowledge on the tick path. Commit-reveal of the seed is enough until step 12. A 20 Hz proof of the whole transition is not a current option.
- Celestia or EigenDA for the journal. The settlement chain already has blobs. A second data-availability network adds a trust set the game does not need.

Engine phase status is in section 4.

### Carry-over and proofs

**What carries.** The player keeps the character they already have. The same NFT, the same owner, and the same sheet: level, xp, job, subjob, learned abilities, skill tree, free stats, equipment, bag, craft skills, and log gold. Those are imported once into the new journal and the server file. `stateRoot` on `CharacterCheckpoint` is re-seeded to the new genesis root for that token and job.

The old log is not replayed. It was committed under rules that still had KEK paths, and the Gnosis dry-run pointed the checkpoint at MockItems. Replaying it would drag both into the new world. KEK balances, old entry hashes, old inbound nonces, log-migration flags, positions, and facing do not come across. Gold's daily earn caps start empty, so a half-used day on the dead journal cannot block earning. The integer `dust` field on the save is not a currency. Materials such as pale-dust are bag stacks and come across with the bag.

A level-1 reset or a new mint would throw away the character the player can already see. That is the worse experience, and it is not required to drop KEK.

**Proofs, without a second chain.** Replay of the pinned wasm is the definition of a valid batch. A proof never overrides it. If a proof's public inputs or its result disagree with replay, the proof is ignored and the batch is invalid. Nodes that only replay and nodes that also check proofs therefore cannot land on two roots.

Step 12, if it is built, uses one zkVM: SP1, because it executes this Rust crate and accelerates keccak, so the state hash does not change. A second prover (including RISC Zero) is not accepted on the same genesis. The verifying key is pinned beside `LOCAL_RULESET_WASM_SHA256` in the same ruleset record and moves only through the ruleset timelock. A proof under any other key is not a batch of this world. Light clients that cannot replay may trust a proof only after a validator has checked it against replay, or after the dispute game accepts that same pinned key. Until that key exists, light clients use certificates and inclusion proofs, not a prover.

### Operational items

- [ ] Replica key ceremony, encrypted backup expectations, rotation through a certified batch, and an emergency replace path that keeps play running while keys change. The initial set stays at three until the emergency path has been practiced.
- [ ] Health endpoint on every node: last certified height, last anchored height, clock skew, peer connectivity.
- [x] Hand-off and election protocol specification (messages, parent-root match, timeouts, in-flight inputs) and a deterministic multi-process test harness. Section 6 states the message kinds, the parent-root match, the heartbeat timeout, and in-flight inputs. `apps/server/src/handoff-harness.test.ts` runs that protocol in two OS processes.
- [ ] Two published resource profiles (validator, replica) and a "can I hold a replica?" self-check; the installed game defaults to validator.
- [ ] Client directory with caching, fallback, and reconnect UX.
- [ ] Checkpoint format and verification so new nodes start from a recent root rather than genesis.
- [x] Mobile policy for when the limited validator mode may run (power, network, background limits). Section 9: a phone boots on the light tier and is not a default replica. Limited validator mode is eligible only when the device is plugged in and on an unmetered connection. Eligibility does not start the world tick. Background limits make that mode best-effort, and the OS may stop it. No CPU, RAM, or disk floor. No combat bonus, no second guild, and not the listing key.
- [ ] Installer and docs: a Mark earns the right to lead one guild. Guild xDAI comes only from the auction-fee split, and only for certified play. Uptime pays nothing. Validators and light clients are not paid.

## 19. Appendix: changes from the earlier design

Seven things change from the Engine, Multi-Operator World, and Verification document, and everything else in it carries forward.

| Earlier design | This design | Why |
| --- | --- | --- |
| Notaries sign committed batches after replay and never run the live loop | Replicas receive every batch live, sign certificates, and can be elected leader | A failed server is replaced within a heartbeat instead of by manual takeover |
| Small authorized notary set of three | Allowlisted replicas first, then bonded open admission | Player-run nodes cannot depend on invitation |
| Quorum loss pauses all writes | Below-threshold replicas keep ticking provisionally and discard on heal | No infrastructure freezes |
| Authenticity depends on notary signatures | Leader signature on every batch plus replica commit certificate, plus Gnosis anchor and equivocation court | Works for one server, three servers, or open replicas |
| Surfaces: web client, hosted server, PC node | Four tiers (light, validator, replica, leader) across web, installed game, mobile, and hosted server | Mobile and installed games become part of the network |
| Encounter split as the capacity step after failover | Single-leader parallel groups first; per-encounter leases only if the load test demands | Replication already gives continuity |
| Roll tape produced by the sim operator | Roll tape derived from a seed a non-leader roller commits and later reveals, keyed by event. Zero-knowledge proofs of that seed wait until rollout step 12 | A leader cannot choose outcomes |
| No protocol rewards | Guilds are paid a timelocked half of the existing 1% auction fee, in xDAI, on certified play | Funds operators without a new token or a payment for uptime |

Carried forward unchanged: engine phases 0–5 and their numbers, the known engine gaps, the single shared map, the 20 Hz per-encounter-group simulation, listing key outside the voting set, no shared mutable disk, replay to an identical root, and the Phase 0 load test as the source of resource profiles.
