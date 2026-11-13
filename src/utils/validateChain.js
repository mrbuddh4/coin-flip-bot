const { ethers } = require('ethers');

async function validateChain(provider, evm, expectedChainId) {
  if (!expectedChainId) throw new Error('EVM_CHAIN_ID is required before live startup');
  const expected = BigInt(expectedChainId);
  const actual = await provider.getNetwork();
  if (actual.chainId !== expected) throw new Error('RPC chain does not match EVM_CHAIN_ID');
  const signer = new ethers.Wallet(evm.privateKey).address;
  if (evm.walletAddress && ethers.getAddress(evm.walletAddress) !== signer) {
    throw new Error('Bot deposit wallet does not match its signing key');
  }
  if (!evm.devWallet || !evm.devPrivateKey) {
    throw new Error('Both EVM_DEV_WALLET and EVM_DEV_PRIVATE_KEY are required for fee distributions');
  }
  if (ethers.getAddress(evm.devWallet) !== new ethers.Wallet(evm.devPrivateKey).address) {
    throw new Error('Fee distribution wallet does not match its signing key');
  }
}

module.exports = { validateChain };
