const { registerRobinhoodCommands } = require('../src/robinhood/telegram');
const hash = '0x' + 'ab'.repeat(32);
function fixture({ id = 1, type = 'private', text = '' } = {}) {
  const handlers = {}, service = { chain: { receiptProof: jest.fn(async () => { throw new Error('RPC unavailable at https://private.invalid/key=secret'); }) } };
  registerRobinhoodCommands({ command: (name, fn) => { handlers[name] = fn; } }, service, { ADMIN_IDS: '1' });
  return { handlers, service, ctx: { chat: { type }, from: { id }, message: { text }, reply: jest.fn(async () => {}) } };
}
test.each(['rhdepositcheck','rhrefund'])('%s refuses non-owner and group requests before reading a receipt', async name => {
  for (const props of [{id:2,type:'private'},{id:1,type:'group'}]) {
    const f=fixture({...props,text:`/${name} ${hash} CONFIRM`});await f.handlers[name](f.ctx);
    expect(f.service.chain.receiptProof).not.toHaveBeenCalled();expect(f.ctx.reply).toHaveBeenCalledWith('Private administrator command.');
  }
});
test('refund command requires an exact confirmation and does not run on a mistaken value',async()=>{
  const f=fixture({text:`/rhrefund ${hash} confirm`});await f.handlers.rhrefund(f.ctx);
  expect(f.service.chain.receiptProof).not.toHaveBeenCalled();expect(f.ctx.reply).toHaveBeenCalledWith(expect.stringContaining('CONFIRM exactly'));
});
test('diagnostic rejects missing hashes and never reflects raw provider credentials in a failure',async()=>{
  const f=fixture({text:'/rhdepositcheck'});await f.handlers.rhdepositcheck(f.ctx);expect(f.service.chain.receiptProof).not.toHaveBeenCalled();
  f.ctx.message.text='/rhdepositcheck '+hash;await f.handlers.rhdepositcheck(f.ctx);expect(f.ctx.reply).toHaveBeenLastCalledWith(expect.stringContaining('No replacement transaction was created.'));
  expect(JSON.stringify(f.ctx.reply.mock.calls)).not.toContain('secret');
});
