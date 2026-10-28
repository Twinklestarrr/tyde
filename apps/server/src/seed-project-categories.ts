import { PrismaClient } from '@prisma/client';
import { loadEnvFile } from 'node:process';
import { projectCategories } from './project-categories.data.js';

// 相对脚本定位配置，不依赖命令的当前工作目录；已有环境变量优先。
try {
  loadEnvFile(new URL('../.env', import.meta.url));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
if (!process.env.DATABASE_URL?.trim()) {
  throw new Error('缺少 DATABASE_URL，请配置 apps/server/.env 或环境变量。');
}

const db = new PrismaClient();
const actor = 'seed-project-categories';

try {
  await db.$transaction(
    async (tx) => {
      // 显式 ID 导入期间阻止其他分类写入，避免冲突检查与序列校准发生竞争。
      await tx.$executeRaw`LOCK TABLE "ProjectCategory" IN SHARE ROW EXCLUSIVE MODE`;
      const existing = await tx.projectCategory.findMany();
      for (const category of projectCategories) {
        const conflict = existing.find(
          (row) =>
            (row.id === category.id &&
              (row.categoryCode !== category.categoryCode ||
                row.categoryLevel !== category.categoryLevel)) ||
            (row.id !== category.id &&
              (row.categoryCode === category.categoryCode ||
                (row.categoryLevel === category.categoryLevel &&
                  row.categoryName === category.categoryName))),
        );
        if (conflict) {
          throw new Error(
            `分类冲突：待导入 ${category.id}/${category.categoryCode}，` +
              `已有 ${conflict.id}/${conflict.categoryCode}（${conflict.categoryName}）。` +
              '请先核对已有数据及项目关联，脚本不会自动替换分类身份。',
          );
        }
      }

      for (const category of projectCategories) {
        await tx.projectCategory.upsert({
          where: { id: category.id },
          create: { ...category, status: 'ENABLED', createdBy: actor, updatedBy: actor },
          update: {
            categoryName: category.categoryName,
            sortNo: category.sortNo,
            status: 'ENABLED',
            updatedBy: actor,
          },
        });
      }

      // 显式插入 ID 不推进 SERIAL；保持序列不倒退，避免后续新增分类主键冲突。
      await tx.$queryRaw`
        SELECT setval(
          pg_get_serial_sequence('"ProjectCategory"', 'id'),
          GREATEST(
            (SELECT MAX("id") FROM "ProjectCategory"),
            pg_sequence_last_value(pg_get_serial_sequence('"ProjectCategory"', 'id')::regclass)
          ),
          true
        )::text
      `;
    },
    { timeout: 60_000 },
  );
  console.info('项目分类导入完成：一级 9 条，二级 36 条，三级 112 条，共 157 条。');
  console.info('清单内分类已启用；已有其他分类及项目关联保留。');
} catch (error) {
  console.error('项目分类导入失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
