const { ethers } = require('ethers');
const { validateChain } = require('../src/utils/validateChain');
const key = '0x' + '11'.repeat(32);
const other = '0x' + '22'.repeat(32);
const settings = {
  privateKey: key, walletAddress: new ethers.Wallet(key).address,
  devPrivateKey: other, devWallet: new ethers.Wallet(other).address,
};
const provider = { getNetwork: async () => ({ chainId: 123n }) };

test('accepts a matching chain and wallet pair', async () => {
  await expect(validateChain(provider, settings, '123')).resolves.toBeUndefined();
});
test('requires an explicit expected chain', async () => {
  await expect(validateChain(provider, settings)).rejects.toThrow('EVM_CHAIN_ID');
});
test('rejects an RPC on another chain', async () => {
  await expect(validateChain(provider, settings, '456')).rejects.toThrow('RPC chain');
});
test('rejects a deposit address unrelated to the signing key', async () => {
  await expect(validateChain(provider, { ...settings, walletAddress: settings.devWallet }, '123')).rejects.toThrow('Bot deposit');
});
test('rejects a missing dev key instead of allowing fallback to the deposit wallet', async () => {
  await expect(validateChain(provider, { ...settings, devPrivateKey: undefined }, '123')).rejects.toThrow('Both EVM_DEV');
});
test('rejects mismatched dev signing key', async () => {
  await expect(validateChain(provider, { ...settings, devPrivateKey: key }, '123')).rejects.toThrow('Fee distribution');
});
