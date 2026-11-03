import { expect, test } from '@playwright/test';
import mongoose from '../../server/node_modules/mongoose/index.js';
import { ChatMessage } from '../../server/src/models/ChatMessage.js';
import { DJLounge } from '../../server/src/models/DJLounge.js';
import { QueueEvent } from '../../server/src/models/QueueEvent.js';
import { signInHost, registerListener, createLounge, joinLounge } from './lounge-e2e-helpers.js';

test.beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
});

test.afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test('Lounge chat is shared, ordered, recoverable, deduplicated and retries after delivery failure', async ({ browser }) => {
  test.setTimeout(120_000);
  const contexts = [];
  let failureValidatorInstalled = false;
  const queueEventCollectionName = QueueEvent.collection.collectionName;
  const newContext = async () => {
    const context = await browser.newContext();
    contexts.push(context);
    return context;
  };
  const sendMessage = async (page, body) => {
    await page.getByRole('textbox', { name: 'Chat message' }).fill(body);
    await page.getByRole('button', { name: 'Send' }).click();
  };
  const expectedMessages = [
    'Chat E2E message one',
    'Chat E2E message two',
    'Chat E2E message three',
  ];

  try {
    const hostPage = await (await newContext()).newPage();
    await signInHost(hostPage);
    const firstLounge = await createLounge(hostPage, 'Chat E2E primary');
    const secondLounge = await createLounge(hostPage, 'Chat E2E separate room');

    const senderPage = await (await newContext()).newPage();
    const receiverPage = await (await newContext()).newPage();
    const otherRoomPage = await (await newContext()).newPage();
    await Promise.all([
      registerListener(senderPage, 'Chat E2E Sender'),
      registerListener(receiverPage, 'Chat E2E Receiver'),
      registerListener(otherRoomPage, 'Chat E2E Other Room'),
    ]);
    await Promise.all([
      joinLounge(senderPage, firstLounge.inviteCode),
      joinLounge(receiverPage, firstLounge.inviteCode),
      joinLounge(otherRoomPage, secondLounge.inviteCode),
    ]);

    const senderHistory = senderPage.getByRole('list', { name: 'Lounge chat messages' });
    const receiverHistory = receiverPage.getByRole('list', { name: 'Lounge chat messages' });
    const otherRoomHistory = otherRoomPage.getByRole('list', { name: 'Lounge chat messages' });
    await expect(senderHistory.getByRole('listitem')).toHaveCount(0);
    await expect(receiverHistory.getByRole('listitem')).toHaveCount(0);
    await expect(otherRoomHistory.getByRole('listitem')).toHaveCount(0);

    for (let index = 0; index < expectedMessages.length; index += 1) {
      const body = expectedMessages[index];
      await sendMessage(senderPage, body);
      await expect(senderHistory.getByRole('listitem')).toHaveCount(index + 1);
    }
    await expect(receiverHistory.getByRole('listitem')).toHaveCount(expectedMessages.length);
    for (const body of expectedMessages) await expect(receiverHistory.getByText(body, { exact: true })).toBeVisible();

    const senderRows = await senderHistory.getByRole('listitem').allTextContents();
    const receiverRows = await receiverHistory.getByRole('listitem').allTextContents();
    const messageOrder = (rows) => rows.map((row) => expectedMessages.find((body) => row.includes(body)));
    expect(messageOrder(senderRows)).toEqual(expectedMessages);
    expect(messageOrder(receiverRows)).toEqual(expectedMessages);
    await sendMessage(otherRoomPage, 'Separate Lounge private marker');
    await expect(otherRoomHistory.getByText('Separate Lounge private marker', { exact: true })).toBeVisible();
    await expect(otherRoomHistory.getByRole('listitem')).toHaveCount(1);
    for (const body of expectedMessages) await expect(otherRoomHistory.getByText(body, { exact: true })).toHaveCount(0);

    await joinLounge(otherRoomPage, firstLounge.inviteCode);
    const recoveredHistory = otherRoomPage.getByRole('list', { name: 'Lounge chat messages' });
    await expect(recoveredHistory.getByRole('listitem')).toHaveCount(expectedMessages.length);
    expect(messageOrder(await recoveredHistory.getByRole('listitem').allTextContents())).toEqual(expectedMessages);

    await Promise.all([ChatMessage.init(), QueueEvent.init()]);
    const retriedClientMessageId = 'c0d2f3e7-9d8b-4677-9507-51ac593d2e31';
    await senderPage.evaluate((clientMessageId) => {
      globalThis.__chatClientMessageIdGenerationCount = 0;
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: () => {
          globalThis.__chatClientMessageIdGenerationCount += 1;
          if (globalThis.__chatClientMessageIdGenerationCount > 1) {
            throw new Error('Retry unexpectedly generated a new client message ID');
          }
          return clientMessageId;
        },
      });
    }, retriedClientMessageId);
    await mongoose.connection.db.command({
      collMod: queueEventCollectionName,
      validator: { type: { $ne: 'chat.message' } },
    });
    failureValidatorInstalled = true;
    const rejectedBody = 'Chat E2E delivery intent failure';
    await sendMessage(senderPage, rejectedBody);
    await expect(senderPage.getByRole('alert')).toContainText('The request could not be completed');
    await expect(senderHistory.getByText(rejectedBody, { exact: true })).toHaveCount(0);
    const persistedRejectedMessage = await ChatMessage.findOne({ loungeId: firstLounge.loungeId, body: rejectedBody }).lean();
    expect(persistedRejectedMessage.clientMessageId).toBe(retriedClientMessageId);
    expect(persistedRejectedMessage.deliveryEventSeq).toBeUndefined();
    const pendingOutbox = await DJLounge.findOne({ loungeId: firstLounge.loungeId }).select('coordination.outbox').lean();
    expect(pendingOutbox.coordination.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'chat.message', payload: expect.objectContaining({ messageId: persistedRejectedMessage.messageId }) }),
    ]));
    expect(await QueueEvent.countDocuments({
      loungeId: firstLounge.loungeId, type: 'chat.message', 'payload.messageId': persistedRejectedMessage.messageId,
    })).toBe(0);

    await mongoose.connection.db.command({ collMod: queueEventCollectionName, validator: {} });
    failureValidatorInstalled = false;
    await expect(receiverHistory.getByText(rejectedBody, { exact: true })).toBeVisible();
    await expect(senderHistory.getByRole('listitem')).toHaveCount(expectedMessages.length + 1);
    await sendMessage(senderPage, rejectedBody);
    await expect(senderHistory.getByText(rejectedBody, { exact: true })).toBeVisible();
    await expect(senderHistory.getByRole('listitem')).toHaveCount(expectedMessages.length + 1);
    expect(await ChatMessage.countDocuments({ loungeId: firstLounge.loungeId, clientMessageId: retriedClientMessageId })).toBe(1);
    expect(await senderPage.evaluate(() => globalThis.__chatClientMessageIdGenerationCount)).toBe(1);
    expect(await QueueEvent.countDocuments({
      loungeId: firstLounge.loungeId, type: 'chat.message', 'payload.messageId': persistedRejectedMessage.messageId,
    })).toBe(1);
  } finally {
    if (failureValidatorInstalled) {
      await mongoose.connection.db.command({ collMod: queueEventCollectionName, validator: {} });
    }
    await Promise.all(contexts.map((context) => context.close()));
  }
});
