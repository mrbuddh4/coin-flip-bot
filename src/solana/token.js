// Token and Token-2022 wire formats, checked against independent SDK vectors.
// https://github.com/solana-program/token/blob/main/program/src/instruction.rs
// https://github.com/solana-program/associated-token-account
const { PublicKey, TransactionInstruction, SystemProgram } = require('@solana/web3.js');
const { UnsupportedTokenError } = require('./errors');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
// The RPC parser uses multisigAuthority when a wallet transfer includes a
// redundant self-signer account. Accept that exact single-wallet shape only.
// The caller must still prove the authority signed and owns the source tokens.
function directTransferAuthority(info) {
  if (typeof info.authority === 'string' && info.multisigAuthority == null && (!info.signers || info.signers.length === 0)) return info.authority;
  if (info.authority == null && typeof info.multisigAuthority === 'string' && Array.isArray(info.signers) && info.signers.length === 1 && info.signers[0] === info.multisigAuthority) return info.multisigAuthority;
  return null;
}
function getAssociatedTokenAddressSync(mint, owner, program = TOKEN_PROGRAM_ID) {
  if (!PublicKey.isOnCurve(owner.toBytes())) throw new UnsupportedTokenError('Off-curve owner unsupported');
  return PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}
async function getMint(connection, mint, commitment = 'finalized', program = TOKEN_PROGRAM_ID) {
  const account = await connection.getAccountInfo(mint, commitment);
  return parseMint(account, program);
}
function parseMint(account, program = TOKEN_PROGRAM_ID) {
  if (!account || !account.owner.equals(program) || ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(program.toBase58())) throw new UnsupportedTokenError('Not a supported standard SPL or Token-2022 mint');
  if (account.data.length < 82 || (program.equals(TOKEN_PROGRAM_ID) && account.data.length !== 82)) throw new UnsupportedTokenError('Invalid token mint layout');
  if (account.data[45] !== 1) throw new UnsupportedTokenError('Mint not initialized');
  const extensions = [];
  if (account.data.length > 82) {
    if (!program.equals(TOKEN_2022_PROGRAM_ID) || account.data.length < 166 || account.data[165] !== 1) throw new UnsupportedTokenError('Invalid extended mint layout');
    for (let offset = 166; offset < account.data.length;) {
      if (account.data.subarray(offset).every(byte => byte === 0)) break;
      if (offset + 4 > account.data.length) throw new UnsupportedTokenError('Truncated token extension');
      const type = account.data.readUInt16LE(offset), length = account.data.readUInt16LE(offset + 2);
      offset += 4;
      if (offset + length > account.data.length || extensions.includes(type)) throw new UnsupportedTokenError('Invalid token extension');
      // Only descriptive extensions. Reject fees, hooks, delegates, pausing,
      // interest/scaled amounts and unknown transfer semantics before any wager.
      if (![18, 19, 20, 21, 22, 23].includes(type)) throw new UnsupportedTokenError('Unsupported Token-2022 transfer extension');
      extensions.push(type);
      offset += length;
    }
  }
  return { decimals: account.data[44], isInitialized: true, program: program.toBase58(), extensions };
}
function createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint, program = TOKEN_PROGRAM_ID) {
  return new TransactionInstruction({ programId: ASSOCIATED_TOKEN_PROGRAM_ID, data: Buffer.from([1]), keys: [
    { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: ata, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: program, isSigner: false, isWritable: false },
  ] });
}
function createTransferCheckedInstruction(source, mint, target, owner, amount, decimals, program = TOKEN_PROGRAM_ID) {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(BigInt(amount), 1);
  data[9] = decimals;
  return new TransactionInstruction({ programId: program, data, keys: [
    { pubkey: source, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: target, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false },
  ] });
}
function createBurnCheckedInstruction(account, mint, owner, amount, decimals, program = TOKEN_PROGRAM_ID) {
  const data = Buffer.alloc(10);
  data[0] = 15;
  data.writeBigUInt64LE(BigInt(amount), 1);
  data[9] = decimals;
  return new TransactionInstruction({ programId: program, data, keys: [
    { pubkey: account, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: false },
  ] });
}
module.exports = { directTransferAuthority, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getMint, parseMint, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, createBurnCheckedInstruction };
