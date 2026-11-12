import { createHash, randomUUID } from 'node:crypto';
import { ApiError, invalidInput } from './auth.js';
import { resourceIdPattern } from './brand-access.js';
import { Prisma, type PrismaClient } from './generated/client.js';

type OperationOutcome = { status: 201 | 409; result: Prisma.InputJsonObject };
type Operation = {
  actorId: string;
  key: string;
  content: Prisma.InputJsonArray;
  execute: (operationId: string) => Promise<OperationOutcome>;
};

export function readOperationKey(key: string | undefined) {
  if (key === undefined || !resourceIdPattern.test(key)) throw invalidInput();
  return key.toLowerCase();
}

function rolledBackByContention(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && (
    error.code === 'P2034'
    || (error.code === 'P2010' && (error.meta?.code === '40001' || error.meta?.code === '40P01'))
  );
}

export async function runIdempotent(
  db: PrismaClient, action: string, prepare: (tx: Prisma.TransactionClient) => Promise<Operation>,
) {
  const temporaryError = () => new ApiError(
    503, 'SERVICE_UNAVAILABLE', action + '結果尚未確認，請使用相同的操作識別碼重試。',
  );
  for (let attempt = 0; ; attempt += 1) {
    try {
      const outcome = await db.$transaction(async (tx) => {
        // 先驗證當下授權和輸入，再讀寫操作者共用的冪等唯一鍵。
        const { actorId, key, content, execute } = await prepare(tx);
        const fingerprint = createHash('sha256').update(JSON.stringify(content)).digest('hex');
        const operationId = randomUUID();
        const inserted = await tx.$executeRaw`
          INSERT INTO "IdempotentOperation" ("id", "actorId", "key", "fingerprint")
          VALUES (${operationId}::uuid, ${actorId}::uuid, ${key}::uuid, ${fingerprint})
          ON CONFLICT ("actorId", "key") DO NOTHING
        `;
        if (!inserted) {
          const prior = await tx.idempotentOperation.findUniqueOrThrow({ where: { actorId_key: { actorId, key } } });
          if (prior.fingerprint !== fingerprint) {
            throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '此操作識別碼已用於不同的內容。');
          }
          return prior;
        }

        return tx.idempotentOperation.update({ where: { id: operationId }, data: await execute(operationId) });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

      // 業務拒絕須提交後再交給 HTTP 錯誤處理，重送回放原錯誤與新追蹤識別。
      const { status, result } = outcome;
      if (status === 201 && result) return result;
      if (status !== null && result && typeof result === 'object' && !Array.isArray(result)
          && typeof result.code === 'string' && typeof result.message === 'string') {
        throw new ApiError(status, result.code, result.message);
      }
      throw temporaryError();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // 只有資料庫已確認整筆回滾的競爭錯誤可由伺服器有限重試。
      if (attempt >= 2 || !rolledBackByContention(error)) throw temporaryError();
    }
  }
}
