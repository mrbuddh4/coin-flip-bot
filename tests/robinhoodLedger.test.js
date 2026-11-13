const { Pool } = require('pg');
const { ethers } = require('ethers');
const fs = require('node:fs');
const { Keypair } = require('@solana/web3.js');
const { RobinhoodStore } = require('../src/robinhood/store');
const { SolanaStore } = require('../src/solana/store');
const { SolanaService } = require('../src/solana/service');
const { MAXIMUM, SID, normalizeAddress } = require('../src/robinhood/chain');
const { RobinhoodScanner } = require('../src/robinhood/scanner');
const { createRouter } = require('../src/robinhood/router');
const url = process.env.SOLANA_TEST_DATABASE_URL;
(url ? describe : describe.skip)('Robinhood with existing Solana ledger on disposable PostgreSQL', () => {
  let admin, roots, pools, sol, rh, chain, service, now;
  const a = new ethers.Wallet('0x'+'22'.repeat(32)).address.toLowerCase(), b = new ethers.Wallet('0x'+'33'.repeat(32)).address.toLowerCase(), treasury = new ethers.Wallet('0x'+'11'.repeat(32)).address.toLowerCase();
  const solWallet = Keypair.fromSeed(Buffer.alloc(32,6)).publicKey.toBase58();
  const input = {userId:'1',chatId:'-100',wallet:a,mint:SID,amount:'1000',interfaceVersion:2};
  beforeAll(async()=>{
    if (!['127.0.0.1','localhost'].includes(new URL(url).hostname)) throw new Error('Disposable local database only');
    admin=new Pool({connectionString:url}); roots=[`rh_root_${Date.now()}`,`rh_peer_${Date.now()}`]; pools=[];
    for (const schema of roots) {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const p=new Pool({connectionString:url,options:`-c search_path=${schema}`});p.coinflipMaximum=MAXIMUM;p.on('connect',c=>{c.coinflipMaximum=MAXIMUM});
      await p.query(fs.readFileSync(require.resolve('../src/solana/schema.sql'),'utf8').replace('numeric(20,0)','numeric(78,0)'));pools.push(p);
    }
    sol=new SolanaStore(pools[0]);rh=new RobinhoodStore(pools[1]);
    await sol.prepareInterface();await rh.prepareInterface();sol.peerSchema=roots[1];rh.peerSchema=roots[0];
  });
  afterAll(async()=>{if(pools)for(const p of pools)await p.end();if(admin){for(const schema of roots||[])await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end()}});
  beforeEach(async()=>{
    for(const p of pools)await p.query('TRUNCATE "SolGames","SolOutbox","SolDeposits","SolFeePools","SolFeeAccruals","SolTokens","SolProfiles","SolSessions","SolDrafts","SolHolderReserves","SolHolderCustody" CASCADE');
    await pools[1].query('TRUNCATE "RhProofs","RhSafety","RhScanState"');
    now=1000000;
    chain={closeFundedDepositWindows:true,address:treasury,key:'robinhood',cluster:'robinhood-mainnet',chainId:4663,label:'Robinhood Chain mainnet (4663)',realFunds:true,maximumAmount:MAXIMUM,depositWindowMs:1800000,normalizeAddress,env:{},
      tokenInfo:jest.fn(async mint=>({address:mint==='ETH'?'NATIVE':mint,symbol:mint===SID?'SID':'ETH',decimals:18,chainId:4663,maximumAmount:MAXIMUM.toString()})),
      verifyDeposit:jest.fn(async()=>ethers.parseEther('1000')),validate:jest.fn(async()=> 'eip155:4663'),
      assertSolvent:jest.fn(async()=>{}),paymentStatus:jest.fn(async()=> 'unknown'),paymentExpired:jest.fn(async()=>false),
      buildPayment:jest.fn(async p=>({signature:'0x'+'12'.repeat(32),raw:'same-raw',nonce:7,gasCost:'123',chainId:4663})),broadcast:jest.fn(async()=>{}),
      tokensForUser:saved=>[{address:'NATIVE',symbol:'ETH',decimals:18,featured:true},{address:SID,symbol:'SID',decimals:18,featured:true},...saved], explorer:s=>'https://robinhoodchain.blockscout.com/tx/'+s};
    service=new SolanaService({store:rh,chain,now:()=>now,coin:()=>0});
  });
  async function fundedCreator(){const g=await service.create(input);await service.deposit({id:g.id,userId:'1',signature:'creator'});await rh.mutate(g.id,g=>{g.ui.publishRequested=true});return rh.get(g.id)}
  test('native ETH and million-token ERC20 games retain full 18 decimal precision, no u64 cap',async()=>{
    const g=await service.create({...input,amount:'1000000.123456789012345678'});expect(g.wager).toBe('1000000123456789012345678');expect(g.chainId).toBe(4663);expect(g.creator.depositExpiresAt-now).toBe(1800000);
    await service.cancel({id:g.id,userId:'1',chatId:'-100'});
    const eth=await service.create({...input,mint:'ETH',amount:'0.000000000000000001'});expect(eth.token.address).toBe('NATIVE');expect(eth.wager).toBe('1');
  });
  test('same SID label, separate favorites, wallet profiles, liabilities and receipts',async()=>{
    await sol.saveToken('1',{address:'sol-mint',symbol:'SID'});await rh.saveToken('1',{address:SID,symbol:'SID',chainId:4663});
    await sol.updateProfile('1',{wallet:solWallet});await rh.updateProfile('1',{wallet:a});
    expect((await sol.tokens('1'))[0].address).toBe('sol-mint');expect((await rh.tokens('1'))[0].address).toBe(SID);expect((await sol.profile('1')).wallet).toBe(solWallet);
    const g=await fundedCreator();expect(await sol.liabilities()).toEqual([]);expect(await rh.liabilities()).toEqual([{mint:SID,amount:ethers.parseEther('1000').toString()}]);expect(await sol.hasDeposit('creator')).toBe(false);expect(await rh.hasDeposit('creator')).toBe(true);
    expect((await new RobinhoodStore(pools[1]).get(g.id)).wager).toBe(g.wager);
  });
  test('cross-chain concurrent creates reserve only one group slot',async()=>{
    const solService=new SolanaService({store:sol,chain:{address:Keypair.generate().publicKey.toBase58(),tokenInfo:async()=>({address:'NATIVE',symbol:'SOL',decimals:9})},now:()=>now});
    const results=await Promise.allSettled([service.create(input),solService.create({userId:'3',chatId:'-100',wallet:solWallet,mint:'SOL',amount:'1',interfaceVersion:2})]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.find(r=>r.status==='rejected').reason.message).toContain('active challenge');
  });
  test('one challenger wins concurrent acceptance, button state and preserved chain deadline',async()=>{
    const g=await fundedCreator();const results=await Promise.allSettled([service.join({id:g.id,userId:'2',wallet:b,chatId:'-100'}),service.join({id:g.id,userId:'3',wallet:new ethers.Wallet('0x'+'44'.repeat(32)).address,chatId:'-100'})]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await rh.get(g.id)).expiresAt-now).toBe(1800000);
  });
  test('partial topup, excess refund and cancellation never duplicate value',async()=>{
    const g=await service.create(input);chain.verifyDeposit.mockResolvedValueOnce(ethers.parseEther('999.5')).mockResolvedValueOnce(ethers.parseEther('2'));
    const tx={blockTime:1001};await service.deposit({id:g.id,userId:'1',signature:'part',transaction:tx,noMemo:true});
    expect((await rh.get(g.id)).creator.deposit).toBeUndefined();await service.deposit({id:g.id,userId:'1',signature:'topup',transaction:tx,noMemo:true});
    await service.cancel({id:g.id,userId:'1',chatId:'-100'});await service.cancel({id:g.id,userId:'1',chatId:'-100'});
    const sum=(await rh.payments(g.id)).reduce((v,p)=>v+BigInt(p.payment.amount),0n);expect(sum).toBe(ethers.parseEther('1001.5'));
  });
  test('late finalized in-window deposit refunds once after expiry, even after restart',async()=>{
    const g=await service.create(input);now=g.expiresAt+1000;await service.expire();
    await service.deposit({id:g.id,userId:'1',signature:'late',transaction:{blockTime:1001},noMemo:true});await service.deposit({id:g.id,userId:'1',signature:'late',transaction:{blockTime:1001},noMemo:true});
    expect((await rh.payments(g.id)).filter(p=>p.payment.kind==='refund')).toHaveLength(1);expect((await rh.get(g.id)).status).toBe('CANCELLED');
  });
  test('settlement exact 90/5/5, separate holder custody, signed outbox survives restarts',async()=>{
    const holder=new ethers.Wallet('0x'+'55'.repeat(32)).address.toLowerCase();await rh.bindHolderWallet(holder);
    const g=await fundedCreator();await service.join({id:g.id,userId:'2',wallet:b,chatId:'-100'});await service.deposit({id:g.id,userId:'2',signature:'challenger'});
    const game=await rh.get(g.id);expect(game.prize).toBe(ethers.parseEther('1800').toString());
    const payments=await rh.payments(g.id);expect(payments).toHaveLength(3);expect(payments.reduce((v,p)=>v+BigInt(p.payment.amount),0n)).toBe(ethers.parseEther('2000'));
    await service.work();expect(chain.buildPayment).toHaveBeenCalledTimes(3);await new SolanaService({store:new RobinhoodStore(pools[1]),chain,now:()=>now}).work();expect(chain.buildPayment).toHaveBeenCalledTimes(3);
    chain.paymentStatus.mockResolvedValue('finalized');await service.work();expect((await rh.payments(g.id)).every(p=>p.status==='CONFIRMED')).toBe(true);expect((await rh.holderCustody()).reserves[0].amount).toBe(ethers.parseEther('100').toString());
  });
  function fakeBot(){const handlers={};let mid=100;return {handlers,botInfo:{username:'TestBot',id:1},start:f=>handlers.start=f,command:(n,f)=>handlers[n]=f,action:(p,f)=>{handlers[p.source]=f},on:(n,f)=>handlers[n]=f,telegram:{sendMessage:jest.fn(async()=>({message_id:++mid})),editMessageText:jest.fn(async()=>({})),editMessageReplyMarkup:jest.fn(async()=>({})),deleteMessage:jest.fn(async()=>({}))}}}
  function ctx(id=1,type='private',text=''){return{from:{id,first_name:'Player'},chat:{id:type==='private'?id:-100,type},message:{text},reply:jest.fn(async()=>({message_id:101})),answerCbQuery:jest.fn(async()=>{})}}
  test('network picker, RH group deep link, new-user wallet onboarding and editable shared screen',async()=>{
    const bot=fakeBot(),solChain={env:{SOLANA_CLUSTER:'mainnet-beta'}};const solService={store:sol,chain:solChain};const router=createRouter(bot,{solana:{service:solService,scanner:{}},robinhood:{service,scanner:{}}});
    const group=ctx(1,'supergroup','/flip');await bot.handlers.flip(group);const rows=group.reply.mock.calls[0][1].reply_markup.inline_keyboard;
    expect(rows).toHaveLength(2);const payload=rows[1][0].url.split('?start=')[1];const start=ctx(1,'private','/start '+payload);await bot.handlers.start(start);
    expect((await rh.session('1')).resume.kind).toBe('create');expect(start.reply).toHaveBeenCalledWith(expect.stringContaining('Robinhood Chain'),expect.anything());
    await bot.handlers.text(ctx(1,'private',a));let profile=await rh.profile('1');expect(profile.wallet).toBe(a);expect(profile.privateScreen.chainKey).toBe('robinhood');
    const choose=ctx();choose.callbackQuery={data:'r:wallet:same'};await router.dispatch(choose,'action','robinhood');
    expect((await rh.session('1')).step).toBe('token');expect(bot.telegram.editMessageText).toHaveBeenCalledWith(1,101,undefined,expect.stringContaining('Select a Token'),expect.anything());
    expect((await sol.profile('1')).wallet).toBeUndefined();expect((await sol.profile('1')).privateScreen.chainKey).toBe('robinhood');
  });
  test('scanner retains failed block cursor, replays a finalized ERC20 and consumes once',async()=>{
    const g=await service.create(input);const scanner=new RobinhoodScanner(service);const block={number:'0xb',hash:'block11',timestamp:'0x3e9'};
    await scanner.process(a,'0x'+'ab'.repeat(32),SID,ethers.parseEther('1000'),block);await scanner.process(a,'0x'+'ab'.repeat(32),SID,ethers.parseEther('1000'),block);
    expect(chain.verifyDeposit).toHaveBeenCalledTimes(1);expect((await rh.get(g.id)).creator.deposit).toBeDefined();
    await rh.saveScanState(10,'block10');chain.rpc=jest.fn(async()=>{throw new Error('429')});scanner.nextTry=0;await scanner.tick();expect(await rh.scanState()).toEqual({block:'10',hash:'block10'});
  });
  async function priorSettledGame({legacy=false}={}) {
    chain.verifyDeposit.mockResolvedValue(ethers.parseEther('6900'));
    const old=await service.create({...input,userId:'2',wallet:b,amount:'6900'});
    await service.deposit({id:old.id,userId:'2',signature:'old-creator',...(legacy?{}:{transaction:{blockTime:1001},noMemo:true})});
    await rh.mutate(old.id,g=>{g.ui.publishRequested=true});now=1005000;
    await service.join({id:old.id,userId:'1',wallet:a,chatId:'-100'});
    await service.deposit({id:old.id,userId:'1',signature:'old-challenger',...(legacy?{}:{transaction:{blockTime:1006},noMemo:true})});
    await rh.mutate(old.id,g=>{g.ui.resultAnnounced=true;g.ui.terminal=true});now=1010000;
    return rh.get(old.id);
  }
  test('a completed 6900-SID request cannot capture a subsequent 3100-SID deposit',async()=>{
    const old=await priorSettledGame();expect(old.challenger.depositWindowClosedAt).toBe(1007000);
    const next=await service.create({...input,amount:'3100'}),signature='0x'+'ae'.repeat(32);chain.verifyDeposit.mockResolvedValue(ethers.parseEther('3100'));
    const matches=await rh.noMemoCandidates({sender:a,mint:SID,amount:ethers.parseEther('3100').toString(),at:1011000});
    expect(matches).toEqual([{gameId:next.id,userId:'1'}]);
    const scanner=new RobinhoodScanner(service);await scanner.process(a,signature,SID,ethers.parseEther('3100'),{number:'0xb',hash:'block11',timestamp:'0x3f3'});
    expect((await rh.get(next.id)).creator.deposit.amount).toBe(ethers.parseEther('3100').toString());
    expect((await rh.get(old.id)).prize).toBe(old.prize);
  });
  test('legacy overlapping windows recover a reviewed deposit after cancellation, beyond the forward cursor and after restart',async()=>{
    const old=await priorSettledGame({legacy:true}),next=await service.create({...input,amount:'3100'}),signature='0x'+'af'.repeat(32);
    chain.verifyDeposit.mockResolvedValue(ethers.parseEther('3100'));
    const scanner=new RobinhoodScanner(service),block={number:'0xb',hash:'block11',timestamp:'0x3f3'};
    await scanner.process(a,signature,SID,ethers.parseEther('3100'),block);
    expect(await rh.hasDeposit(signature)).toBe(false);expect((await rh.ambiguousReceipts()).map(r=>r.signature)).toContain(signature);
    await rh.saveScanState(1000,'block1000');chain.receiptProof=jest.fn(async()=>({tx:{from:a,to:SID},blockTime:1011,block}));
    await scanner.recoverReviews();expect(await rh.hasDeposit(signature)).toBe(false);
    now=next.expiresAt+1000;await service.expire();
    const restarted=new SolanaService({store:new RobinhoodStore(pools[1]),chain,now:()=>now});
    const {recoverRobinhoodDeposit}=require('../src/robinhood/depositTrace');
    await Promise.all([new RobinhoodScanner(restarted).recoverReviews(),recoverRobinhoodDeposit(restarted,signature)]);
    const payments=await rh.payments(next.id);expect(payments).toHaveLength(1);expect(payments[0].payment).toMatchObject({kind:'refund',recipient:a,amount:ethers.parseEther('3100').toString()});
    expect((await rh.get(next.id)).creator.deposit).toBeUndefined();expect((await rh.get(old.id)).prize).toBe(old.prize);
    expect(await rh.scanState()).toEqual({block:'1000',hash:'block1000'});
    await new RobinhoodScanner(restarted).recoverReviews();expect(await rh.payments(next.id)).toHaveLength(1);
  });
  test('hash-only owner diagnostic is read-only and closed-request refund queues actual 3100 SID once',async()=>{
    const {traceRobinhoodDeposit,recoverRobinhoodDeposit}=require('../src/robinhood/depositTrace');
    const g=await service.create({...input,amount:'3100'}),signature='0x'+'ab'.repeat(32);
    now=g.expiresAt+1000;await service.expire();
    const amount=ethers.parseEther('3100');chain.verifyDeposit.mockResolvedValue(amount);
    chain.receiptProof=jest.fn(async()=>({tx:{from:a,to:SID},blockTime:1001,block:{number:'0xb'}}));
    chain.normalizeAddress=normalizeAddress;await rh.saveScanState(10,'block10');
    const text=await traceRobinhoodDeposit(service,signature);
    expect(text).toContain('Receipt: NOT RECORDED');expect(text).toContain('sender MATCHES');expect(text).toContain(g.id);
    expect(chain.verifyDeposit).toHaveBeenCalledWith(expect.objectContaining({recordProof:false}));
    expect(await rh.hasDeposit(signature)).toBe(false);expect(await rh.payments(g.id)).toEqual([]);expect(chain.buildPayment).not.toHaveBeenCalled();
    expect(await recoverRobinhoodDeposit(service,signature)).toContain('recorded for full refund');
    expect(await recoverRobinhoodDeposit(service,signature)).toContain('already recorded');
    const payments=await rh.payments(g.id);expect(payments).toHaveLength(1);expect(payments[0].payment).toMatchObject({recipient:a,amount:amount.toString(),kind:'refund'});
    expect(chain.buildPayment).not.toHaveBeenCalled();
  });
  test('hash-only recovery refuses open games, wrong registered wallets and unavailable receipt proof',async()=>{
    const {recoverRobinhoodDeposit}=require('../src/robinhood/depositTrace');
    const g=await service.create({...input,amount:'3100'}),signature='0x'+'ab'.repeat(32);chain.verifyDeposit.mockResolvedValue(ethers.parseEther('3100'));
    chain.receiptProof=jest.fn(async()=>({tx:{from:a,to:SID},blockTime:1001,block:{number:'0xb'}}));
    expect(await recoverRobinhoodDeposit(service,signature)).toContain('remains open');
    now=g.expiresAt+1000;await service.expire();chain.receiptProof.mockResolvedValue({tx:{from:b,to:SID},blockTime:1001,block:{number:'0xb'}});
    expect(await recoverRobinhoodDeposit(service,signature)).toContain('No nearby saved request');
    chain.receiptProof.mockRejectedValue(new Error('history unavailable'));await expect(recoverRobinhoodDeposit(service,signature)).rejects.toThrow('history unavailable');
    expect(await rh.hasDeposit(signature)).toBe(false);expect(await rh.payments(g.id)).toEqual([]);
  });
  test('accepted receipt evidence persists; block changes freeze financial actions until reconciliation',async()=>{
    const sig='0x'+'77'.repeat(32), block={number:'0x64',hash:'0x'+'88'.repeat(32)};
    await rh.recordProof(sig,block);await rh.recordProof(sig,block);expect((await pools[1].query('SELECT * FROM "RhProofs" WHERE signature=$1',[sig])).rowCount).toBe(1);
    await expect(rh.recordProof(sig,{...block,hash:'0x'+'99'.repeat(32)})).rejects.toThrow('HISTORY_REVIEW');
    await expect(new RobinhoodStore(pools[1]).assertHealthy()).rejects.toThrow('HISTORY_REVIEW');
  });

});
