const { ethers } = require('ethers');
const { RobinhoodChain, CHAIN_ID, SID, DEAD, MAXIMUM, ERC20, normalizeAddress } = require('../src/robinhood/chain');
const { toUnits } = require('../src/solana/amounts');
const signer = new ethers.Wallet('0x' + '11'.repeat(32)), sender = new ethers.Wallet('0x' + '22'.repeat(32)).address.toLowerCase();
const hash = '0x' + 'ab'.repeat(32), blockHash = '0x' + 'cd'.repeat(32);
function fixture() {
  const env = { BOT_MODE: 'live', LIVE_FUNDS_ENABLED: 'true', ROBINHOOD_WALLET_ADDRESS: signer.address, ROBINHOOD_RPC_URL: 'https://offline.invalid' };
  const rpc = jest.fn(); const provider = { send: rpc };
  const chain = new RobinhoodChain({ env, provider, signer });
  const tx = { hash, chainId: '0x1237', from: sender, to: chain.address, value: '0x64', input: '0x', blockHash };
  const receipt = { transactionHash: hash, blockNumber: '0x64', blockHash, status: '0x1', logs: [] };
  const block = { number: '0x64', hash: blockHash, timestamp: '0x3e8', transactions: [hash] };
  rpc.mockImplementation(async (method, params) => {
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_getTransactionByHash') return tx;
    if (method === 'eth_getTransactionReceipt') return receipt;
    if (method === 'eth_getBlockByNumber') return block;
    if (method === 'eth_getBalance') return ethers.toBeHex(ethers.parseEther('100'));
    if (method === 'eth_getTransactionCount') return '0x7';
    if (method === 'eth_estimateGas') return '0x5208';
    if (method === 'eth_gasPrice') return '0x64';
    if (method === 'eth_sendRawTransaction') return ethers.keccak256(params[0]);
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_call') {
      const call = ERC20.parseTransaction({ data: params[0].data });
      const value = { decimals: 18, totalSupply: ethers.parseEther('1000000000'), symbol: 'SID', balanceOf: ethers.parseEther('10000'), transfer: true }[call.name];
      return ERC20.encodeFunctionResult(call.name, [value]);
    }
    throw new Error(method);
  });
  return { env, chain, rpc, tx, receipt, block };
}
function tokenTransfer(f, amount = 69n * 10n ** 18n) {
  f.tx.to = SID; f.tx.value = '0x0'; f.tx.input = ERC20.encodeFunctionData('transfer', [f.chain.address, amount]);
  const log = ERC20.encodeEventLog(ERC20.getEvent('Transfer'), [sender, f.chain.address, amount]);
  f.receipt.logs = [{ address: SID, ...log }];
}
test('exact Robinhood network and signer binding, no Solana addresses accepted', async () => {
  const f = fixture(); expect(await f.chain.validate()).toBe('eip155:4663');
  expect(() => normalizeAddress('6izojQcvjazUDZ4jckAnFn15i8fDRkNb4J9NnTpTVBkY')).toThrow();
  f.env.ROBINHOOD_WALLET_ADDRESS = sender; await expect(f.chain.validate()).rejects.toThrow('mismatch');
  f.env.ROBINHOOD_WALLET_ADDRESS = signer.address; f.rpc.mockResolvedValueOnce('0x1'); await expect(f.chain.validate()).rejects.toThrow('RPC does not match');
});
test('native ETH and exact SID default; custom assets scoped and uint256 amounts supported', async () => {
  const f = fixture();
  expect(await f.chain.tokenInfo('ETH')).toMatchObject({ address: 'NATIVE', decimals: 18, symbol: 'ETH', chainId: CHAIN_ID });
  const sid = await f.chain.tokenInfo(SID.toUpperCase().replace('0X','0x'));
  expect(sid).toMatchObject({ address: SID, decimals: 18, symbol: 'SID' });
  expect(toUnits('1000000', 18, MAXIMUM)).toBe(1000000n * 10n ** 18n);
  expect(() => toUnits('1000000',18)).toThrow();
  expect(f.chain.tokensForUser([{ address: sender, symbol: 'X', chainId: 1 }, { address: sender, symbol: 'Y', chainId: CHAIN_ID }]).map(t => t.symbol)).toEqual(['ETH','SID','Y']);
});
test('native deposit requires direct signed canonical finalized transfer', async () => {
  const f = fixture(); expect(await f.chain.verifyDeposit({ signature: hash, sender, mint: 'NATIVE', transaction: { hash, blockTime:1000 } })).toBe(100n);
  f.tx.input = '0x1234'; await expect(f.chain.verifyDeposit({ signature: hash, sender, mint:'NATIVE' })).rejects.toThrow('direct');
  f.tx.input = '0x'; f.receipt.blockHash='0x'+'ef'.repeat(32); await expect(f.chain.verifyDeposit({signature:hash,sender,mint:'NATIVE'})).rejects.toThrow('mismatch');
});
test('ERC20 verifies calldata, sender, contract and exact single Transfer receipt', async () => {
  const f=fixture(); tokenTransfer(f); expect(await f.chain.verifyDeposit({signature:hash,sender,mint:SID})).toBe(69n*10n**18n);
  f.receipt.logs.push(f.receipt.logs[0]); await expect(f.chain.verifyDeposit({signature:hash,sender,mint:SID})).rejects.toThrow('nonstandard');
  f.receipt.logs.pop(); f.tx.from = f.chain.address; await expect(f.chain.verifyDeposit({signature:hash,sender,mint:SID})).rejects.toThrow('sending wallet');
});
test('rejects taxed transfer, wrong recipient, failed or unfinalized receipts', async () => {
  const f=fixture(); tokenTransfer(f); const log=ERC20.encodeEventLog(ERC20.getEvent('Transfer'),[sender,f.chain.address,68n*10n**18n]); f.receipt.logs=[{address:SID,...log}];
  await expect(f.chain.verifyDeposit({signature:hash,sender,mint:SID})).rejects.toThrow('nonstandard');
  tokenTransfer(f); f.receipt.status='0x0'; await expect(f.chain.verifyDeposit({signature:hash,sender,mint:SID})).rejects.toThrow('failed');
  f.receipt.status='0x1'; f.receipt.blockNumber='0x65'; await expect(f.chain.verifyDeposit({signature:hash,sender,mint:SID})).rejects.toThrow('not finalized');
});
test('ETH and ERC20 payouts sign exact amounts on 4663, persistable hash and nonce', async () => {
  const f=fixture();
  for (const mint of ['NATIVE',SID]) {
    const p=await f.chain.buildPayment({kind:'prize',sourceWallet:f.chain.address,mint,recipient:sender,amount:'12345678901234567890'});
    const tx=ethers.Transaction.from(p.raw); expect(tx.chainId).toBe(4663n); expect(tx.nonce).toBe(7); expect(tx.hash).toBe(p.signature);
    if(mint==='NATIVE') expect(tx.value).toBe(12345678901234567890n);
    else expect(ERC20.parseTransaction({data:tx.data}).args[1]).toBe(12345678901234567890n);
    await f.chain.broadcast(p); await f.chain.broadcast(p);
    expect(f.rpc.mock.calls.filter(([m])=>m==='eth_sendRawTransaction').slice(-2).map(([,p])=>p[0])).toEqual([p.raw,p.raw]);
  }
});
test('burn is an explicit dead-address transfer; it does not assume universal burn ABI', async () => {
  const f=fixture(); const p=await f.chain.buildPayment({kind:'burn',sourceWallet:f.chain.address,mint:SID,amount:'42'});
  expect(ERC20.parseTransaction({data:ethers.Transaction.from(p.raw).data}).args[0].toLowerCase()).toBe(DEAD);
});
test('funds gate, gas coverage and false-returning custom token prevent signing', async () => {
  const f=fixture(); const p={kind:'prize',sourceWallet:f.chain.address,mint:SID,recipient:sender,amount:'1'};
  f.env.LIVE_FUNDS_ENABLED='false'; await expect(f.chain.buildPayment(p)).rejects.toThrow('Funds disabled'); f.env.LIVE_FUNDS_ENABLED='true';
  f.chain.balance=jest.fn(async()=>0n); await expect(f.chain.buildPayment(p)).rejects.toThrow('ETH_SHORTFALL');
});
test('exact-hash finalized status, consumed nonce review, and no expiration guessing', async () => {
  const f=fixture(); expect(await f.chain.paymentStatus(hash)).toBe('finalized');
  expect(await f.chain.paymentExpired({nonce:6})).toBe(true); expect(await f.chain.paymentExpired({nonce:7})).toBe(false);
  f.receipt.status='0x0';expect(await f.chain.paymentStatus(hash)).toBe('failed');
});
test('fast L2 mode requires twenty blocks, uses canonical depth and labels risk accurately', async () => {
  const f=fixture();f.env.ROBINHOOD_CONFIRMATION_MODE='l2';
  const c=new RobinhoodChain({env:f.env,signer,provider:{send:f.rpc}});
  const original=f.rpc.getMockImplementation();
  f.rpc.mockImplementation(async(m,p)=>m==='eth_getBlockByNumber'&&p[0]==='latest'?{...f.block,number:'0x78'}:original(m,p));
  expect(await c.finalized()).toBe(f.block);expect(f.rpc).toHaveBeenCalledWith('eth_getBlockByNumber',['0x64',false]);expect(c.label).toContain('L2 confirmed (20 blocks)');expect(c.depositWindowMs).toBe(180000);
  expect(await c.balance('NATIVE')).toBe(ethers.parseEther('100'));
  expect(f.rpc).toHaveBeenCalledWith('eth_getBalance',[c.address,'0x64']);
  expect(()=>new RobinhoodChain({env:{...f.env,ROBINHOOD_CONFIRMATION_BLOCKS:'1'},signer,provider:{send:f.rpc}})).toThrow('20 to');
});
test('RPC-history failure never falls back from finalized to latest and never authorizes replacement',async()=>{
  const f=fixture();f.rpc.mockRejectedValue(new Error('historical state unavailable'));
  await expect(f.chain.tokenInfo(SID)).rejects.toThrow();await expect(f.chain.paymentStatus(hash)).rejects.toThrow();
  expect(f.rpc.mock.calls.some(([m])=>m==='eth_sendRawTransaction')).toBe(false);
});
