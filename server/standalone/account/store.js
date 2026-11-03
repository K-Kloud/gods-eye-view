import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

export const digest = (value) =>
  createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');

export function createTokenVault(encodedKey) {
  const key = Buffer.from(encodedKey || '', 'base64');
  if (key.length !== 32)
    throw new Error('OPEN_I_SESSION_KEY must be a base64 encoded 32 byte key');
  return {
    seal(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([
        cipher.update(JSON.stringify(value), 'utf8'),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString(
        'base64url',
      );
    },
    open(value) {
      const data = Buffer.from(value, 'base64url');
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([
          cipher.update(data.subarray(28)),
          cipher.final(),
        ]).toString('utf8'),
      );
    },
  };
}

/** All replicas use the same TTL table. Tokens are encrypted before persistence. */
export function createAccountStore({
  table,
  region,
  client = DynamoDBDocumentClient.from(new DynamoDBClient({ region })),
}) {
  const send = (Command, input) =>
    client.send(new Command({ TableName: table, ...input }));
  return {
    async get(pk) {
      return (
        (await send(GetCommand, { Key: { pk }, ConsistentRead: true })).Item ??
        null
      );
    },
    async put(pk, value) {
      await send(PutCommand, { Item: { ...value, pk } });
    },
    async remove(pk) {
      await send(DeleteCommand, { Key: { pk } });
    },
    async consume(pk) {
      return (
        (await send(DeleteCommand, { Key: { pk }, ReturnValues: 'ALL_OLD' }))
          .Attributes ?? null
      );
    },
    async revoke(sub, deleted = false) {
      await send(UpdateCommand, {
        Key: { pk: `SECURITY#${sub}` },
        UpdateExpression: 'SET #deleted = :deleted ADD epoch :one',
        ExpressionAttributeNames: { '#deleted': 'deleted' },
        ExpressionAttributeValues: { ':one': 1, ':deleted': deleted },
      });
    },
    async saveProfile(sub, profile, epoch) {
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: table,
                Key: { pk: `SECURITY#${sub}` },
                ConditionExpression:
                  '(attribute_not_exists(epoch) OR epoch = :epoch) AND (attribute_not_exists(#deleted) OR #deleted = :false)',
                ExpressionAttributeNames: { '#deleted': 'deleted' },
                ExpressionAttributeValues: { ':epoch': epoch, ':false': false },
              },
            },
            {
              Put: {
                TableName: table,
                Item: {
                  pk: `USER#${sub}`,
                  profile,
                  updatedAt: new Date().toISOString(),
                },
              },
            },
          ],
        }),
      );
    },
  };
}
