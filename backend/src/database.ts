import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

export function createDatabase(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('缺少 DATABASE_URL');
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: 6, connectionTimeoutMillis: 3000 }),
    transactionOptions: { maxWait: 5000, timeout: 10000 },
  });
}
