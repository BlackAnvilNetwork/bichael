// Recomputes the Solidity golden vectors from first principles with viem. Usage: node verify.mjs
// The Rust engine must reproduce the same genesis root, item ids and checkpoint body hash.
import { encodeAbiParameters, keccak256, hashTypedData, encodePacked, toHex, stringToHex } from 'viem'

const CHECKPOINT_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'prevRoot', type: 'bytes32' }, { name: 'newRoot', type: 'bytes32' },
    { name: 'fromIndex', type: 'uint64' }, { name: 'toIndex', type: 'uint64' },
    { name: 'logHash', type: 'bytes32' }, { name: 'rulesetHash', type: 'bytes32' },
    { name: 'summary', type: 'uint256' },     { name: 'inboundConsumed', type: 'uint64' },
    { name: 'exports', type: 'tuple[]', components: [
      { name: 'itemId', type: 'uint256' }, { name: 'amount', type: 'uint32' },
    ] },
  ],
}

const checkpoint = {
  prevRoot: '0x' + '11'.repeat(32), newRoot: '0x' + '22'.repeat(32),
  fromIndex: 100n, toIndex: 137n,
  logHash: '0x' + '33'.repeat(32), rulesetHash: '0x' + '44'.repeat(32),
  // level 42 | job 3 <<16 | subjob 1 <<24 | jobXp 123456 <<32 | location 17 <<96
  summary: 42n | (3n << 16n) | (1n << 24n) | (123456n << 32n) | (17n << 96n),
  inboundConsumed: 9n,
  exports: [{ itemId: 0xabcn, amount: 1 }, { itemId: 0xdefn, amount: 40 }],
}

const domain = {
  name: 'CharacterCheckpoint', version: '1', chainId: 31337,
  verifyingContract: process.env.VERIFYING_CONTRACT ?? '0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9',
}
const player = '0x000000000000000000000000000000000000dEaD'

const bodyHash = keccak256(encodeAbiParameters([CHECKPOINT_TUPLE], [checkpoint]))

const digest = hashTypedData({
  domain, primaryType: 'Checkpoint',
  types: { Checkpoint: [
    { name: 'tokenId', type: 'uint256' }, { name: 'player', type: 'address' }, { name: 'version', type: 'uint32' },
    { name: 'deadline', type: 'uint256' }, { name: 'bodyHash', type: 'bytes32' },
  ] },
  message: { tokenId: 1n, player, version: 3, deadline: 1_900_000_000n, bodyHash },
})

// genesis state root = keccak256(abi.encode(GENESIS_TAG, tokenId, startingJob)); first log event is Spawn
const genesisTag = keccak256(stringToHex('LOK_GENESIS_V1'))
const genesisRoot = keccak256(encodeAbiParameters(
  [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint8' }], [genesisTag, 1n, 3]))

// item ids: tag byte for domain separation; instance_id is a big-endian u64
const uniqueId = BigInt(keccak256(encodePacked(['bytes1', 'string', 'uint64'], ['0x01', 'iron_sword', 42n])))
const fungibleId = BigInt(keccak256(encodePacked(['bytes1', 'string'], ['0x00', 'iron_ore'])))

const expected = {
  genesisTag: '0x8a8d1f348a2311fc4d6271c76e697ff6d99152a86984976269678b04ab4eb413',
  bodyHash: '0x0da4d29fd8c0892590468c9b2f8fa5e402388553fa6912e3f72a8cc671ee6d19',
  digest: '0x468f094a906981db2314b95d81ecf4461999c90bd877993fc3ff24828d6bdfed',
  genesisRoot: '0x0c0d7ba0dd69dcda2fe24de603679f65ae5dbdaec43f4ba9f3dfa8c6b444761c',
  uniqueId: 16326979768789847505458237212507241523594462770995321419559994427250918491098n,
  fungibleId: 89658009947691115780873220689577698189678099276092329480841579491160997392175n,
}
const got = { genesisTag, bodyHash, digest, genesisRoot, uniqueId, fungibleId }
let ok = true
for (const k of Object.keys(expected)) {
  const match = String(got[k]).toLowerCase() === String(expected[k]).toLowerCase()
  ok &&= match
  console.log(match ? 'OK  ' : 'FAIL', k, String(got[k]))
}
process.exit(ok ? 0 : 1)
