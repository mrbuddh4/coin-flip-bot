const { PrivateScreen, ScreenTransportError } = require('../src/solana/screen');
describe('private Telegram navigation screen', () => {
  let profiles, store, telegram, screens, ctx;
  beforeEach(() => {
    profiles = new Map();
    store = { profile: jest.fn(async id => profiles.get(String(id)) || {}), updateProfile: jest.fn(async (id, patch) => profiles.set(String(id), { ...profiles.get(String(id)), ...patch })) };
    telegram = { editMessageText: jest.fn().mockResolvedValue({}), editMessageReplyMarkup: jest.fn().mockResolvedValue({}), deleteMessage: jest.fn().mockResolvedValue({}) };
    screens = new PrivateScreen(store, telegram);
    ctx = { from: { id: 1 }, chat: { id: 1, type: 'private' }, reply: jest.fn().mockResolvedValue({ message_id: 42 }), answerCbQuery: jest.fn().mockResolvedValue() };
  });
  test('Home to Wallets edits one saved card and survives a controller restart', async () => {
    await screens.show(ctx, 'Home', [[{ text: 'Wallets', callback_data: 's:wallets' }]]);
    const home = profiles.get('1').privateScreen;
    ctx.callbackQuery = { data: home.rows[0][0].callback_data, message: { message_id: 42 } };
    expect(await screens.valid(ctx)).toBe(true);
    expect(ctx.callbackQuery.data).toBe('s:wallets');
    await screens.show(ctx, 'Wallets', []);
    await new PrivateScreen(store, telegram).show(ctx, 'Home again', []);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(telegram.editMessageText).toHaveBeenCalledTimes(2);
    expect(telegram.editMessageText.mock.calls[0].slice(0, 4)).toEqual([1, 42, undefined, 'Wallets']);
    expect(profiles.get('1').privateScreen.revision).not.toBe(home.revision);
  });
  test('stale, forwarded, and repeated buttons cannot act on a later screen', async () => {
    await screens.show(ctx, 'Home', [[{ text: 'Wallets', callback_data: 's:wallets' }]]);
    const old = profiles.get('1').privateScreen.rows[0][0].callback_data;
    await screens.show(ctx, 'Wallets', []);
    ctx.callbackQuery = { data: old, message: { message_id: 42 } };
    expect(await screens.valid(ctx)).toBe(false);
    ctx.callbackQuery.message.message_id = 7;
    expect(await screens.valid(ctx)).toBe(false);
    expect(telegram.editMessageReplyMarkup).toHaveBeenCalledWith(1, 7, undefined, { inline_keyboard: [] });
    expect(profiles.get('1').privateScreen.text).toBe('Wallets');
  });
  test('only explicit missing/uneditable errors create a replacement; ambiguous edits never duplicate', async () => {
    await screens.show(ctx, 'Home', []);
    telegram.editMessageText.mockRejectedValueOnce(new Error('timeout'));
    await expect(screens.show(ctx, 'Wallets', [])).rejects.toBeInstanceOf(ScreenTransportError);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(profiles.get('1').privateScreen.text).toBe('Home');
    telegram.editMessageText.mockRejectedValueOnce({ response: { description: 'Bad Request: message to edit not found' } });
    ctx.reply.mockResolvedValueOnce({ message_id: 43 });
    await screens.show(ctx, 'Wallets', []);
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    expect(profiles.get('1').privateScreen.messageId).toBe(43);
  });
  test('double taps are serialized and a rejected operation does not poison the queue', async () => {
    const order = []; let release;
    const first = screens.serial(1, async () => { order.push('first'); await new Promise(r => { release = r; }); throw new Error('failed'); });
    const result = first.catch(() => {});
    const second = screens.serial(1, async () => { order.push('second'); });
    await new Promise(r => setImmediate(r)); expect(order).toEqual(['first']);
    release(); await result; await second;
    expect(order).toEqual(['first', 'second']); expect(screens.queues.size).toBe(0);
  });
  test('copy buttons stay exact and longest financial callbacks fit Telegram limits', async () => {
    const data = 's:cancelok:12345678-1234-1234-1234-123456789012';
    await screens.show(ctx, 'Deposit', [[{ text: 'Copy', copy_text: { text: 'public-wallet' } }, { text: 'Cancel', callback_data: data }]]);
    const rows = profiles.get('1').privateScreen.rows;
    expect(rows[0][0].copy_text.text).toBe('public-wallet');
    expect(Buffer.byteLength(rows[0][1].callback_data)).toBeLessThanOrEqual(64);
  });
  test('explicit chat re-entry puts the screen at the bottom before retiring the older card', async () => {
    await screens.show(ctx, 'Old Home', [[{ text: 'Wallets', callback_data: 's:wallets' }]]);
    const old = profiles.get('1').privateScreen;
    ctx.reply.mockResolvedValueOnce({ message_id: 99 }); ctx.solNewScreen = true;
    await screens.show(ctx, 'Choose a token', []);
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    expect(telegram.editMessageText).not.toHaveBeenCalled();
    expect(profiles.get('1').privateScreen.messageId).toBe(99);
    expect(telegram.deleteMessage).toHaveBeenCalledWith(1, 42);
    expect(store.updateProfile.mock.invocationCallOrder.at(-1)).toBeLessThan(telegram.deleteMessage.mock.invocationCallOrder.at(-1));
    ctx.callbackQuery = { data: old.rows[0][0].callback_data, message: { message_id: 42 } };
    expect(await screens.valid(ctx)).toBe(false);
    await screens.show(ctx, 'Wager amount', []);
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    expect(telegram.editMessageText).toHaveBeenCalledWith(1, 99, undefined, 'Wager amount', expect.anything());
  });
  test('failed re-entry send preserves the previous card without deleting it or retrying the send', async () => {
    await screens.show(ctx, 'Old Home', []);
    const old = profiles.get('1').privateScreen;
    ctx.solNewScreen = true; ctx.reply.mockRejectedValueOnce(new Error('ambiguous timeout'));
    await expect(screens.show(ctx, 'Choose a token', [])).rejects.toBeInstanceOf(ScreenTransportError);
    expect(profiles.get('1').privateScreen).toEqual(old);
    expect(telegram.deleteMessage).not.toHaveBeenCalled();
    expect(telegram.editMessageText).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledTimes(2);
  });

});
