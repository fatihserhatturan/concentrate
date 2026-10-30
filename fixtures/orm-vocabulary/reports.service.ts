import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function getReport(id: string) {
  const report = await prisma.report.findUniqueOrThrow({ where: { id } });
  const latest = await prisma.report.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
  const totals = await prisma.report.groupBy({ by: ['status'], _count: true });
  return { report, latest, totals };
}
