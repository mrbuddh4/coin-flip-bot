// Standard SPL Token only. Wire formats match the Token and Associated Token programs.
// https://github.com/solana-program/token/blob/main/program/src/instruction.rs
// https://github.com/solana-program/associated-token-account
const { PublicKey, TransactionInstruction, SystemProgram } = require('@solana/web3.js');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
function getAssociatedTokenAddressSync(mint, owner) {
  if (!PublicKey.isOnCurve(owner.toBytes())) throw new Error('Off-curve owner unsupported');
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}
async function getMint(connection, mint) {
  const account = await connection.getAccountInfo(mint, 'finalized');
  if (!account || !account.owner.equals(TOKEN_PROGRAM_ID) || account.data.length !== 82) throw new Error('Not a standard SPL mint');
  if (account.data[45] !== 1) throw new Error('Mint not initialized');
  return { decimals: account.data[44], isInitialized: true };
}
function createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint) {
  return new TransactionInstruction({ programId: ASSOCIATED_TOKEN_PROGRAM_ID, data: Buffer.from([1]), keys: [
    { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: ata, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ] });
}
function createTransferCheckedInstruction(source, mint, target, owner, amount, decimals) {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(BigInt(amount), 1);
  data[9] = decimals;
  return new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, data, keys: [
    { pubkey: source, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: target, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false },
  ] });
}
module.exports = { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getMint, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction };
